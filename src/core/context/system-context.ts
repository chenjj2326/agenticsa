// SystemContext：组合多个 Source（02/06）
//
// 文档：多个 source 组合成一个不透明的上下文对象，对调用方隐藏具体类型。
// 三个核心操作：initialize / reconcile / replace。

import {
  initializeSource,
  reconcileSource,
  type Observed,
  type Snapshot,
  type Source,
  type SourceReconcileResult,
  type SystemReconcileResult,
} from "./source.js";

export class SystemContext {
  private sources: Array<Source<any>> = [];

  register<T>(source: Source<T>) {
    this.sources.push(source as Source<any>);
  }

  // initialize：首次观察所有 source，产出 baseline + snapshot
  async initialize(): Promise<{ baseline: string; snapshot: Snapshot }> {
    const snapshot: Snapshot = new Map();
    const parts: string[] = [];
    for (const source of this.sources) {
      const observed = await source.observe();
      const r = initializeSource(source, observed);
      snapshot.set(source.key, r.snapshot as any);
      if (r.baseline) parts.push(r.baseline);
    }
    return { baseline: parts.join("\n\n"), snapshot };
  }

  // reconcile：拿当前观察值与上次 snapshot 对比
  async reconcile(prev: Snapshot): Promise<SystemReconcileResult> {
    const updates: string[] = [];
    const newSnapshot: Snapshot = new Map();
    let hasIncompatible = false;
    let hasUnavailable = false;
    const perSource: Array<{ source: Source<any>; observed: Observed<any>; result: SourceReconcileResult; snapshot?: any }> = [];

    for (const source of this.sources) {
      const observed = await source.observe();
      const prevEntry = prev.get(source.key) as any;
      const result = reconcileSource(source, observed, prevEntry);
      perSource.push({ source, observed, result, snapshot: (result as any).snapshot });

      switch (result._tag) {
        case "unchanged":
          newSnapshot.set(source.key, prevEntry ?? { value: null });
          break;
        case "updated":
        case "removed":
          updates.push((result as any).baselineDelta);
          newSnapshot.set(source.key, (result as any).snapshot ?? prevEntry);
          break;
        case "incompatible":
          hasIncompatible = true;
          break;
        case "unavailable":
          hasUnavailable = true;
          // 保留 prev snapshot（unavailable 不更新）
          newSnapshot.set(source.key, prevEntry ?? { value: null });
          break;
      }
    }

    if (hasIncompatible) {
      // 整体 replace
      return this.replace();
    }

    if (hasUnavailable) {
      // 文档 02：有 unavailable 且之前有 snapshot → 阻塞等待，不静默构造残缺 baseline
      return { _tag: "replacement_blocked" };
    }

    if (updates.length === 0) {
      return { _tag: "unchanged" };
    }

    // Updated：发更新文本进 history，baseline 和 baseline_seq 都不动
    return { _tag: "updated", updates, snapshot: newSnapshot };
  }

  // replace：整体重建。但任何 source 临时 unavailable 且之前有 snapshot → 阻塞等待
  // 这里 prev 可能为空（首次），不可用就给出空 baseline
  async replace(prev?: Snapshot): Promise<SystemReconcileResult> {
    // 如果之前有 snapshot 且现在有 unavailable，应该阻塞
    if (prev && prev.size > 0) {
      for (const source of this.sources) {
        const observed = await source.observe();
        if (observed._tag === "unavailable") {
          return { _tag: "replacement_blocked" };
        }
      }
    }
    const init = await this.initialize();
    return {
      _tag: "replacement_ready",
      baseline: init.baseline,
      snapshot: init.snapshot,
    };
  }
}
