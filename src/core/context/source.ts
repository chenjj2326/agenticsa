// 上下文管理架构（02）—— Source 代数
//
// 文档 02 核心：
//   每条动态上下文抽象成一个 Source，它知道怎么 observe/compare/render 自己。
//   - 首次出现 → baseline 文本
//   - 值变了 → "现在变成 ..." 更新文本（baseline 不变）
//   - 源没了 → "已移除"
//
//   三个核心操作：
//   1. initialize：首次观察所有 source，产出 baseline + snapshot
//   2. reconcile：拿当前观察值与上次 snapshot 对比，三态：Unchanged / Updated / Incompatible
//   3. replace：整体重建。但任何 source 临时 unavailable 且之前有 snapshot → 阻塞等待（ReplacementBlocked）
//
//   Unavailable ≠ Removed：临时失败保留旧值等待；真没了才告诉模型"已移除"。

// --- Source 观察结果 ---
// observe() 的返回值，描述这次观察到的状态
export type Observed<T> =
  | { _tag: "available"; value: T } // 正常拿到值
  | { _tag: "unavailable"; reason: string } // 临时失败（git 卡了）
  | { _tag: "removed" }; // 源真的没了

// Source snapshot 里的项：上次承认的状态
export interface SnapshotEntry<T> {
  readonly value: T; // 上次承认的值（Unavailable 时保留这个）
  readonly removed?: boolean; // 上次是否已 removed
}

// Source 接口：每个动态上下文实现这个
export interface Source<T> {
  readonly key: string;
  observe(): Promise<Observed<T>>;
  // 比较两个值，返回是否变化
  equal(a: T, b: T): boolean;
  // 首次渲染成 baseline 文本
  renderBaseline(value: T): string;
  // 变化时渲染成"现在变成 ..."更新文本
  renderUpdate(value: T): string;
  // 移除时渲染"已移除"
  renderRemoved(): string;
  // snapshot 序列化（用于持久化 / diff）
  // 默认实现：直接存 value（要求 value 是 JSON-safe）
  encode(value: T): unknown;
  decode(raw: unknown): T | null; // 解码失败返回 null → Incompatible → replace
}

// --- 单个 source 的 reconcile 结果 ---
export type SourceReconcileResult =
  | { _tag: "unchanged" }
  | { _tag: "updated"; baselineDelta: string } // 更新文本（baseline 不变）
  | { _tag: "removed"; baselineDelta: string } // "已移除"文本
  | { _tag: "incompatible" } // snapshot 解码失败 → 整体 replace
  | { _tag: "unavailable" }; // 临时失败 → 阻塞等

// --- 整个 SystemContext 的 reconcile 结果 ---
export type SystemReconcileResult =
  | { _tag: "unchanged" }
  | { _tag: "updated"; updates: string[]; snapshot: Snapshot } // 一组更新文本（baseline 不变）；snapshot 推进
  | { _tag: "replacement_ready"; baseline: string; snapshot: Snapshot }
  | { _tag: "replacement_blocked" }; // 有 unavailable，用旧 baseline 等待

export type Snapshot = Map<string, SnapshotEntry<unknown>>;

// 单个 source 的 reconcile
export function reconcileSource<T>(
  source: Source<T>,
  observed: Observed<T>,
  prev: SnapshotEntry<T> | undefined
): SourceReconcileResult & { snapshot?: SnapshotEntry<T> } {
  // 之前没记录过 → 不能 reconcile，外层会走 initialize
  if (!prev) {
    return { _tag: "incompatible" };
  }

  switch (observed._tag) {
    case "available": {
      if (prev.removed) {
        // 之前 removed，现在又 available → 当成 updated（baseline 不变）
        return {
          _tag: "updated",
          baselineDelta: source.renderUpdate(observed.value),
          snapshot: { value: observed.value },
        };
      }
      if (source.equal(prev.value, observed.value)) {
        return { _tag: "unchanged" };
      }
      return {
        _tag: "updated",
        baselineDelta: source.renderUpdate(observed.value),
        snapshot: { value: observed.value },
      };
    }
    case "unavailable": {
      // Unavailable ≠ Removed：保留旧值，等待
      return { _tag: "unavailable" };
    }
    case "removed": {
      if (prev.removed) {
        return { _tag: "unchanged" };
      }
      return {
        _tag: "removed",
        baselineDelta: source.renderRemoved(),
        snapshot: { value: prev.value, removed: true },
      };
    }
  }
}

// 单个 source 的 initialize（首次观察）
export function initializeSource<T>(
  source: Source<T>,
  observed: Observed<T>
): { baseline?: string; snapshot: SnapshotEntry<T> } {
  switch (observed._tag) {
    case "available":
      return {
        baseline: source.renderBaseline(observed.value),
        snapshot: { value: observed.value },
      };
    case "unavailable":
      // 首次就 unavailable：snapshot 空，baseline 空（后续恢复时走 updated）
      return { snapshot: { value: null as unknown as T } };
    case "removed":
      return {
        snapshot: { value: null as unknown as T, removed: true },
      };
  }
}
