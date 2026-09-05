// SessionRunner.run（03）—— 第二层：drain 调度
//
// 文档 03：双层 while：
//   - 内层：跑光 steer 和工具续跑（模型调了工具就要回灌继续）
//   - 外层：跑光 queue（排队的下个任务）
//
// 入口判断：没有 pending 的 steer/queue 且非 force → 直接 return（idle 是 no-op）
// force 模式即使没 pending 也跑一个 turn
//
// promotion 只在 turn 之间发生，不在 provider 流式输出时插入
//   保证 turn 原子性、history 一致、缓存稳定

import type { SessionHistory } from "../session/history.js";
import type { SessionMessage } from "../session/message.js";
import { runTurn, TurnTransitionDefect, type RunTurnResult, type TurnEvent } from "./turn.js";
import { catchDefect } from "../effect/runtime.js";
import { runCompaction } from "../compaction/compact.js";
import type { SystemContext } from "../context/system-context.js";
import type { LLMProvider } from "../../provider/llm.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { PermissionService, PermissionRule } from "../tool/permission.js";
import type { Epoch } from "../context/epoch.js";
import { isUserDeclined } from "../error/errors.js";

export interface RunnerOptions {
  sessionId: string;
  history: SessionHistory;
  ctx: SystemContext;
  provider: LLMProvider;
  model: string;
  agentSystem: string;
  agentPermissions: PermissionRule[];
  registry: ToolRegistry;
  permission: PermissionService;
  cwd: string;
  maxSteps?: number;
  onEvent: (e: TurnEvent) => void;
  signal?: AbortSignal;
  // force 模式（resume 入口）
  force?: boolean;
}

export interface RunnerResult {
  // drain 是否处理了任何 turn
  ranTurns: number;
  // 最终 epoch
  epoch: Epoch | null;
  // 是否被中断
  interrupted: boolean;
  // 是否因为用户拒绝而 halt
  halted: boolean;
}

export async function runSession(opts: RunnerOptions): Promise<RunnerResult> {
  const { sessionId, history, ctx, provider } = opts;
  let epoch: Epoch | null = null;
  let currentStep = 0;
  let ranTurns = 0;
  let interrupted = false;
  let halted = false;

  // force 模式即使没 pending 也跑一个 turn
  const hasPendingSteer = history.hasPendingSteer();
  const hasPendingQueue = history.hasPendingQueue();
  if (!hasPendingSteer && !hasPendingQueue && !opts.force) {
    // idle 是 no-op
    return { ranTurns: 0, epoch, interrupted: false, halted: false };
  }

  // 外层 while：跑光 queue
  let shouldRunOuter = opts.force || hasPendingSteer || hasPendingQueue;

  while (shouldRunOuter) {
    // 内层 while：跑光 steer 和 tool continuation
    let continuation = true;
    let passivCompactRetried = false;
    // 文档 03：每个新用户输入驱动的 turn 的首轮要先把输入提升进 history，
    //   否则会跑一个「没有用户输入」的空 turn。
    //   后续 tool continuation 轮不再提升 queue（steer 例外，steer 总在 turn 之间提升）。
    let isNewUserTurn = true;

    while (continuation) {
      // 文档 03：promotion 在 turn 之间发生
      // steer：下个 turn 开头全部提升并入 history，重置步数
      const steers = history.promoteSteers();
      if (steers.length > 0) {
        // 文档 03：steer 提升后重置步数（新输入 = 新一轮预算）
        currentStep = 0;
        for (const s of steers) {
          history.append(s);
        }
        // steer 也是新用户输入——这一轮也是 fresh turn
        isNewUserTurn = true;
      }

      // queue 提升：新用户 turn 的首轮提一条（避免跑空 turn）
      // 文档 03：queue 在内层循环结束、即将 idle 时取最早一条——
      //   这里在首轮开头取，等价于「上一个 turn 结束、即将处理下个 queue」
      if (isNewUserTurn && steers.length === 0 && !history.hasPendingSteer()) {
        const q = history.promoteNextQueued();
        if (q) {
          history.append(q);
          currentStep = 0; // 新用户输入 = 新步数预算
        }
      }
      isNewUserTurn = false;

      // 取最新 compaction seq
      const latestCompaction = history.getLatestCompaction();
      const compactionSeq = latestCompaction?.seq ?? 0;

      // 跑一个 turn
      // 文档 03：转场用 defect 抛，外层 catchDefect 捕获后重建请求重跑
      let result: RunTurnResult;
      try {
        result = await runTurn({
          sessionId,
          history,
          ctx,
          provider,
          model: opts.model,
          agentSystem: opts.agentSystem,
          agentPermissions: opts.agentPermissions,
          registry: opts.registry,
          permission: opts.permission,
          cwd: opts.cwd,
          epoch,
          compactionSeq,
          currentStep,
          maxSteps: opts.maxSteps,
          hasSteer: history.hasPendingSteer(),
          onEvent: opts.onEvent,
          signal: opts.signal,
          alreadyCompactedAfterOverflow: passivCompactRetried,
        });
      } catch (e) {
        // 文档 03：转场信号（compaction 完成）
        if (e instanceof TurnTransitionDefect) {
          if (e.payload === "active") {
            // 主动压缩完成——跑压缩，epoch 整体重建
            const messages = history.all();
            const priorSummary = latestCompaction?.summary ?? null;
            const rec = await runCompaction(messages, priorSummary, provider);
            history.setCompaction(rec);
            // epoch 下次 prepare 会走 replace 整体重建
            epoch = null; // 强制 replace
            continue; // 重建请求重跑
          }
          if (e.payload === "overflow") {
            // 被动 overflow 压缩——压一次重试
            const messages = history.all();
            const priorSummary = latestCompaction?.summary ?? null;
            const rec = await runCompaction(messages, priorSummary, provider);
            history.setCompaction(rec);
            epoch = null;
            passivCompactRetried = true;
            continue;
          }
        }

        // 用户拒绝 → halt 整个 loop
        // 文档 03/11：isUserDeclined → halt，不变成 model-facing tool output
        if (isUserDeclined(e)) {
          halted = true;
          // scope finalizer 兜底：把所有 pending reject
          opts.permission.rejectAllPending(sessionId);
          break;
        }

        // 中断
        if (e instanceof Error && e.name === "InterruptedError") {
          interrupted = true;
          break;
        }
        // 其他错误
        throw e;
      }

      ranTurns++;
      currentStep = result.step;
      epoch = result.epoch;

      // 续跑条件：上个 turn 有工具调用 OR 有 steer 等待
      // 文档 03：两者之一循环就继续
      const stillHasSteer = history.hasPendingSteer();
      continuation = result.needsContinuation || stillHasSteer;
    }

    // 内层结束——queue 已在首轮提升过；这里只看还有没有剩余 pending
    // 文档 03：queue/steer 排队的下个任务在外层 while 处理
    shouldRunOuter = history.hasPendingQueue() || history.hasPendingSteer();
  }

  return { ranTurns, epoch, interrupted, halted };
}
