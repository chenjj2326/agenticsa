// Context Epoch（02）
//
// 文档：把动态上下文锚定到 Session。每个 Session 至多一条 epoch 行，记着：
//   当前 baseline 文本、snapshot、baseline_seq（锚定的历史序号）。
//
// 每个 turn 前必跑一次 prepare：
//   - 没变 / ReplacementBlocked → 用旧 baseline
//   - 整体就绪 → 写新 baseline + 新 baseline_seq
//   - 有 Updated → 发一条"环境更新"事件进 history，但 baseline 和 baseline_seq 都不动
//
// baseline_seq 是"system 消息的截止线"——之前的 system 更新已被 baseline 吸收。
// Updated 时 baseline 不变是反直觉但很对的设计：更新文本作为独立 system message 进 history，
// baseline 稳定正好命中 prompt 缓存。

import type { SystemContext } from "./system-context.js";
import type { Snapshot, SystemReconcileResult } from "./source.js";

export interface Epoch {
  baseline: string;
  snapshot: Snapshot;
  baselineSeq: number; // 锚定的 history 序号（"baseline 吸收到这里为止"）
}

export interface PrepareResult {
  baseline: string; // 当前应该用的 baseline
  baselineSeq: number;
  updates: string[]; // Updated 时产出的更新文本（要发独立 system message 进 history）
  rebuilt: boolean; // 是否整体重建了（写新 baseline）
  snapshot: Snapshot; // 最新的 snapshot（外层用于更新 epoch）
  // snapshot 是否更新了（用于 Updated 时外层知道要不要更新 epoch.snapshot）
  snapshotAdvanced: boolean;
}

// prepare：每个 turn 前对齐动态上下文
export async function prepare(
  ctx: SystemContext,
  prevEpoch: Epoch | null,
  compactionSeq: number // 最新 compaction 的 seq（如果有）
): Promise<PrepareResult> {
  // 没存过 epoch → initialize
  if (!prevEpoch) {
    const init = await ctx.initialize();
    const seq = compactionSeq;
    return {
      baseline: init.baseline,
      baselineSeq: seq,
      updates: [],
      rebuilt: true,
      snapshot: init.snapshot,
      snapshotAdvanced: true,
    };
  }

  // compaction 是硬边界，其 seq 大于 epoch.baselineSeq → 整体 replace
  if (compactionSeq > prevEpoch.baselineSeq) {
    const r = await ctx.replace(prevEpoch.snapshot);
    if (r._tag === "replacement_ready") {
      return {
        baseline: r.baseline,
        baselineSeq: compactionSeq,
        updates: [],
        rebuilt: true,
        snapshot: r.snapshot,
        snapshotAdvanced: true,
      };
    }
    if (r._tag === "replacement_blocked") {
      // 阻塞：用旧 baseline 等待（宁可不更新也不构造残缺）
      return {
        baseline: prevEpoch.baseline,
        baselineSeq: prevEpoch.baselineSeq,
        updates: [],
        rebuilt: false,
        snapshot: prevEpoch.snapshot,
        snapshotAdvanced: false,
      };
    }
  }

  // reconcile
  const r: SystemReconcileResult = await ctx.reconcile(prevEpoch.snapshot);

  switch (r._tag) {
    case "unchanged":
      return {
        baseline: prevEpoch.baseline,
        baselineSeq: prevEpoch.baselineSeq,
        updates: [],
        rebuilt: false,
        snapshot: prevEpoch.snapshot,
        snapshotAdvanced: false,
      };
    case "updated":
      // 文档 02：更新文本作为独立 system message 进 history，baseline 不变
      // 这是反直觉但很对的设计：baseline 稳定命中缓存
      // 但 snapshot 推进（用于下次 reconcile 的对比基础）
      return {
        baseline: prevEpoch.baseline,
        baselineSeq: prevEpoch.baselineSeq,
        updates: r.updates,
        rebuilt: false,
        snapshot: r.snapshot,
        snapshotAdvanced: true,
      };
    case "replacement_ready":
      return {
        baseline: r.baseline,
        baselineSeq: prevEpoch.baselineSeq, // 整体重写不前进 seq（因为 seq 是"截止线"语义）
        updates: [],
        rebuilt: true,
        snapshot: r.snapshot,
        snapshotAdvanced: true,
      };
    case "replacement_blocked":
      return {
        baseline: prevEpoch.baseline,
        baselineSeq: prevEpoch.baselineSeq,
        updates: [],
        rebuilt: false,
        snapshot: prevEpoch.snapshot,
        snapshotAdvanced: false,
      };
  }
}
