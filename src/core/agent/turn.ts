// runTurn（03）—— 第三层：单次 provider turn
//
// 文档 03 精简流程：
//   校验归属 → 选 agent → 对齐上下文锚点（prepare epoch）→ 提升 pending 输入
//   → 选模型 → 选历史 → 组装请求 → 估算溢出就先压缩 → 流式调用
//   → 文本 publish、工具调用执行后回灌、overflow 被动压缩
//   → 等齐工具 → 捕获文件 diff → 收尾
//
// 工具执行包在 uninterruptibleMask 里（保证 side effect 完整），
//   但外层 stream 可被用户打断，打断后把未结算工具标记失败、让下轮 drain 决定要不要重试。

import { Defect, FiberSet, die, sleep, type Scope, uninterruptibleMask } from "../effect/runtime.js";
import {
  BlockedError,
  ContextOverflowError,
  isUserDeclined,
  LLMError,
  RateLimitError,
  ToolFailure,
  UserDeclinedError,
} from "../error/errors.js";
import type { LLMProvider } from "../../provider/llm.js";
import type { LLMEvent, AssistantMessage, AssistantPart, SessionMessage, ToolCallPart, ToolResultPart } from "../session/message.js";
import { genId, type Usage } from "../session/message.js";
import type { SessionHistory } from "../session/history.js";
import type { SystemContext } from "../context/system-context.js";
import { prepare, type Epoch } from "../context/epoch.js";
import { assemblePrompt } from "../prompt/assemble.js";
import { compactIfNeeded, runCompaction, summaryPromptFits } from "../compaction/compact.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { PermissionRule, PermissionService } from "../tool/permission.js";
import { renderToolOutput, ToolOutputStore } from "../output-store/tool-output-store.js";
import { estimateValue, DEFAULT_BUFFER } from "../token/estimate.js";

// 转场信号（compaction 完成）
// 文档 03：用 defect 抛"转场信号"（不是失败是控制流），外层捕获后重建请求重跑
export class TurnTransitionDefect extends Defect {
  constructor(readonly kind: "active" | "overflow" | "overflow_after_compact") {
    super("turn_transition", kind);
  }
}

export interface RunTurnOptions {
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
  // 当前的 epoch（外层维护，turn 内更新）
  epoch: Epoch | null;
  compactionSeq: number;
  // 当前 step
  currentStep: number;
  maxSteps?: number;
  // 是否有 steer 等待（外层判断）
  hasSteer: boolean;
  // event 回调（CLI / UI）
  onEvent: (e: TurnEvent) => void;
  // abort signal（用户中断）
  signal?: AbortSignal;
  // 已经被动压缩过一次（防递归）
  alreadyCompactedAfterOverflow?: boolean;
}

// turn 事件（给前端 / CLI）
export type TurnEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; name: string; args: unknown; callId: string }
  | { type: "tool-result"; callId: string; output: unknown; error?: boolean }
  | { type: "permission-asked"; action: string; resources: string[] }
  | { type: "assistant-message"; id: string }
  | { type: "step-ended"; seq: number; step: number }
  | { type: "compaction"; summary: string }
  | { type: "epoch-rebuilt"; baselineSeq: number }
  | { type: "context-updated"; updates: string[] };

export interface RunTurnResult {
  // 是否需要继续（有 tool-call OR 有 steer 等待）
  needsContinuation: boolean;
  // 新的 step 计数
  step: number;
  // 更新后的 epoch
  epoch: Epoch | null;
  // 是否触发了 compaction（外层要重建）
  compactionTriggered: boolean;
  // 是否触发了被动 overflow 压缩（外层要重试）
  overflowCompactionTriggered: boolean;
}

export async function runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  const { sessionId, history, ctx, provider, model } = opts;

  // 1. 对齐 epoch（prepare）
  const compactionSeq = opts.compactionSeq;
  const prep = await prepare(ctx, opts.epoch, compactionSeq);
  // 新 epoch
  let newEpoch: Epoch | null = opts.epoch;
  if (prep.rebuilt) {
    newEpoch = {
      baseline: prep.baseline,
      snapshot: prep.snapshot,
      baselineSeq: prep.baselineSeq,
    };
    opts.onEvent({ type: "epoch-rebuilt", baselineSeq: prep.baselineSeq });
  } else if (prep.snapshotAdvanced) {
    // Updated：snapshot 推进，baseline 不变
    newEpoch = newEpoch
      ? { ...newEpoch, snapshot: prep.snapshot }
      : {
          baseline: prep.baseline,
          snapshot: prep.snapshot,
          baselineSeq: prep.baselineSeq,
        };
  }
  // Updated：发一条"环境更新"事件进 history（baseline 不变）
  if (prep.updates.length > 0) {
    for (const updateText of prep.updates) {
      const sysMsg: SessionMessage = {
        id: genId("sys"),
        seq: history.nextSeq(),
        variant: "system",
        text: updateText,
        createdAt: Date.now(),
      };
      history.append(sysMsg);
    }
    opts.onEvent({ type: "context-updated", updates: prep.updates });
  }
  // 同步 baseline_seq 到 history（用于 selectForLLM 的截止线）
  history.setBaselineSeq(prep.baselineSeq);

  // 2. 提升 pending 输入
  // 文档 03：steer 在下个 turn 开头全部提升并入 history，重置步数
  // queue 在内层循环结束、即将 idle 时取最早一条
  // 这里 promotion 由外层 Runner 决定，turn 内只接收 hasSteer 标志
  // （实际 promoteSteers 在 Runner.run 里做）

  // 3. isLastStep 判断
  const isLastStep = opts.maxSteps !== undefined && opts.currentStep >= opts.maxSteps;

  // 4. materialize tools（按 agent permissions 过滤）
  let toolDefs: Parameters<typeof assemblePrompt>[0]["toolDefs"] = [];
  let settleMap: Awaited<ReturnType<typeof opts.registry.materialize>>["settle"] = new Map();
  if (!isLastStep) {
    const m = opts.registry.materialize(opts.agentPermissions);
    toolDefs = m.definitions;
    settleMap = m.settle;
  }

  // 5. 选历史（compaction_seq + baseline_seq 双截断）
  const selectedMessages = history.selectForLLM();

  // 6. 组装请求
  const req = assemblePrompt({
    agentSystem: opts.agentSystem,
    baseline: prep.baseline,
    selectedMessages,
    toolDefs,
    sessionId: opts.sessionId,
    provider: provider.name,
    model,
    isLastStep,
  });

  // 7. 主动压缩检查（compactIfNeeded）
  // 文档 14：估算整个 LLMRequest（system + messages + tools）
  const contextLimit = provider.contextLimit(model);
  const outputBudget = 4096;
  if (
    compactIfNeeded(req, contextLimit, outputBudget, {
      auto: true,
      buffer: DEFAULT_BUFFER,
    })
  ) {
    // 文档 03：用 defect 抛转场信号，外层捕获后重建请求重跑
    opts.onEvent({ type: "compaction", summary: "(active compaction triggered)" });
    throw new TurnTransitionDefect("active");
  }

  // 8. 流式调用
  const fiberSet = new FiberSet();
  const assistantParts: AssistantPart[] = [];
  const assistantId = genId("a");
  let finishUsage: Usage | undefined;
  let finishProviderMetadata: unknown;
  let hasToolCall = false;
  let hasTextStarted = false;

  // 工具调用的结果集（按 call id）
  const toolResults: Map<string, ToolResultPart> = new Map();
  // 工具调用关系（callId → name）
  const toolCallNames: Map<string, string> = new Map();
  // 重复失败熔断：同参同工具连续失败的次数（requests-1724 教训：
  // 模型幻觉了不存在的代码，同一失败 edit 重试 40 次烧光全部预算）
  const failStreak: Map<string, number> = new Map();
  const failSig = (name: string, args: unknown) => name + ":" + JSON.stringify(args);

  // 监听 abort
  let aborted = false;
  if (opts.signal) {
    opts.signal.addEventListener(
      "abort",
      () => {
        aborted = true;
        fiberSet.clear();
      },
      { once: true }
    );
  }

  let streamError: unknown = null;

  // 文档 07：retryable 的 LLM 故障（连接失败/空流/限流）在「未产出任何模型内容」时重试。
  //   一旦有内容产出（text/reasoning/tool-call），不再重试——防重复事件。
  const MAX_STREAM_ATTEMPTS = 3;
  let producedAny = false;
  for (let streamAttempt = 1; ; streamAttempt++) {
    streamError = null;
    try {
      for await (const ev of provider.stream(req, opts.signal)) {
        if (aborted) break;
        if (ev.type === "text-delta" || ev.type === "reasoning-delta" || ev.type === "tool-call") {
          producedAny = true;
        }

        switch (ev.type) {
        case "text-delta": {
          hasTextStarted = true;
          assistantParts.push({ type: "text", text: ev.text });
          opts.onEvent({ type: "text-delta", text: ev.text });
          break;
        }
        case "reasoning-delta": {
          assistantParts.push({ type: "reasoning", text: ev.text });
          opts.onEvent({ type: "reasoning-delta", text: ev.text });
          break;
        }
        case "tool-call": {
          hasToolCall = true;
          const callId = ev.id;
          toolCallNames.set(callId, ev.name);
          const part: ToolCallPart = {
            type: "tool-call",
            id: callId,
            name: ev.name,
            args: ev.args,
            providerExecuted: ev.providerExecuted,
          };
          assistantParts.push(part);
          opts.onEvent({ type: "tool-call", name: ev.name, args: ev.args, callId });

          // 工具执行（uninterruptibleMask 保证 side effect 完整）
          // 文档 03：tool-call 事件到来时工具执行被 fork 进 FiberSet
          const tool = settleMap.get(ev.name);
          if (tool && !ev.providerExecuted) {
            fiberSet.fork(
              (async () => {
                try {
                  await uninterruptibleMask(async () => {
                    const result = await tool.settle(
                      { id: callId, name: ev.name, args: ev.args },
                      {
                        messageID: assistantId,
                        assert: (action, resources, source) =>
                          opts.permission.assert(sessionId, action, resources, source),
                      }
                    );
                    // 输出进 ToolOutputStore bound（截断 + 大对象存储）
                    let outputView: unknown = result.modelOutput;
                    let isError = !!result.failure;
                    if (result.failure) {
                      // settle() 把 safeMessage 放到 failure 里（不抛异常），
                      // 所以要手动取出来作为 tool-result 内容，否则模型只能看到 null。
                      outputView = result.failure.safeMessage || "Tool execution failed";
                    } else if (typeof result.modelOutput === "string") {
                      outputView = renderToolOutput(ToolOutputStore.bound(result.modelOutput));
                    } else if (result.modelOutput !== null) {
                      outputView = result.modelOutput;
                    }
                    const sig = failSig(ev.name, ev.args);
                    if (isError) {
                      const n = (failStreak.get(sig) ?? 0) + 1;
                      failStreak.set(sig, n);
                      if (n >= 2) {
                        outputView =
                          String(outputView) +
                          `\n\nWARNING: this exact tool call has now failed ${n} times in a row with the same error. Retrying it unchanged will fail again. STOP and change strategy: use read() to look at the actual current content, then construct a different edit or a different approach entirely.`;
                      }
                    } else {
                      failStreak.delete(sig);
                    }
                    const toolResultPart: ToolResultPart = {
                      type: "tool-result",
                      id: callId,
                      name: ev.name,
                      output: outputView,
                      error: isError,
                    };
                    toolResults.set(callId, toolResultPart);
                    opts.onEvent({
                      type: "tool-result",
                      callId,
                      output: outputView,
                      error: isError,
                    });
                  });
                } catch (e) {
                  // 工具执行失败（权限拒绝、schema 不匹配、文件不存在等）
                  let safeMessage: string;
                  if (e !== null && typeof e === "object" && typeof (e as any).safeMessage === "string") {
                    safeMessage = (e as any).safeMessage;
                  } else if (e instanceof ToolFailure) {
                    safeMessage = e.message || "Tool execution failed";
                  } else if (e instanceof Error) {
                    safeMessage = e.message;
                  } else {
                    safeMessage = "Tool execution failed: " + String(e);
                  }
                  const toolResultPart: ToolResultPart = {
                    type: "tool-result",
                    id: callId,
                    name: ev.name,
                    output: safeMessage,
                    error: true,
                  };
                  toolResults.set(callId, toolResultPart);
                  opts.onEvent({
                    type: "tool-result",
                    callId,
                    output: safeMessage,
                    error: true,
                  });
                  const sig = failSig(ev.name, ev.args);
                  const n = (failStreak.get(sig) ?? 0) + 1;
                  failStreak.set(sig, n);
                  if (n >= 2) {
                    const warned =
                      safeMessage +
                      `\n\nWARNING: this exact tool call has now failed ${n} times in a row with the same error. Retrying it unchanged will fail again. STOP and change strategy: use read() to look at the actual current content, then construct a different edit or a different approach entirely.`;
                    const part2: ToolResultPart = {
                      type: "tool-result",
                      id: callId,
                      name: ev.name,
                      output: warned,
                      error: true,
                    };
                    toolResults.set(callId, part2);
                    opts.onEvent({
                      type: "tool-result",
                      callId,
                      output: warned,
                      error: true,
                    });
                  }
                  // 用户拒绝 → isUserDeclined → halt
                  // 文档 03/11：用户拒绝升级成 defect → halt 整个 loop
                  if (isUserDeclined(e)) {
                    throw e;
                  }
                }
              })()
            );
          } else if (ev.providerExecuted) {
            // providerExecuted tool：provider 自己执行了，本地不调
            // 文档 06：只发 ToolResultPart，不发 call
            // 这里 result 由 provider 通过 finish 提供（mock）
          }
          break;
        }
        case "finish": {
          finishUsage = ev.usage;
          finishProviderMetadata = ev.providerMetadata;
          break;
        }
        case "error": {
          streamError = ev.error;
          break;
        }
      }
      }
    } catch (e: any) {
      streamError = e;
    }
    // 重试判定：未产出任何内容且（正常空流 或 retryable 错误）→ 退避后重试
    if (aborted || producedAny || streamAttempt >= MAX_STREAM_ATTEMPTS) break;
    if (
      streamError !== null &&
      (!(streamError instanceof LLMError) || !streamError.retryable)
    ) {
      break;
    }
    // 限流退避要够长（429 立刻重试只会继续 429）；其它错误短退避
    await sleep(streamError instanceof RateLimitError ? 15_000 * streamAttempt : 400 * streamAttempt);
  }

  // 等齐工具
  // 文档 03：等所有工具 fiber 结束
  await fiberSet.drain();

  // 处理 stream error（overflow 被动压缩）
  if (streamError) {
    // 文档 14：30+ 正则识别 context overflow，但排除限流
    // 文档 03：被动 overflow 压缩——只重试一次（防递归）
    const isOverflow =
      streamError instanceof ContextOverflowError ||
      (streamError instanceof Error &&
        /context.*(length|overflow|exceeded|window)|prompt.*too.*long/i.test(
          streamError.message
        ));

    if (isOverflow && !hasTextStarted) {
      // 文档 03：被动压缩——压一次重试
      if (opts.alreadyCompactedAfterOverflow) {
        // 文档 03：防递归——post-compaction 不能再 recover 另一个 overflow
        throw new Error("Context overflow after compaction (not recoverable)");
      }
      opts.onEvent({ type: "compaction", summary: "(passive overflow compaction triggered)" });
      throw new TurnTransitionDefect("overflow");
    }
    // 非 overflow 错误，直接抛
    throw streamError;
  }

  // 把 tool results 追加到 assistant parts
  for (const [, tr] of toolResults) {
    assistantParts.push(tr);
  }

  // 写 assistant 消息
  // 文档 15：assistant 消息级 cost + tokens
  const assistantMessage: AssistantMessage = {
    id: assistantId,
    seq: history.nextSeq(),
    variant: "assistant",
    parts: assistantParts,
    model,
    provider: provider.name,
    providerMetadata: finishProviderMetadata,
    cost: finishUsage ? computeCost(finishUsage) : 0,
    tokens: finishUsage
      ? {
          input: finishUsage.inputTokens,
          output: finishUsage.outputTokens,
          reasoning: finishUsage.reasoningTokens ?? 0,
          cache: {
            read: finishUsage.cacheReadInputTokens ?? 0,
            write: finishUsage.cacheWriteInputTokens ?? 0,
          },
        }
      : undefined,
    createdAt: Date.now(),
  };
  history.append(assistantMessage);
  opts.onEvent({ type: "assistant-message", id: assistantId });

  // step 结束事件
  opts.onEvent({ type: "step-ended", seq: assistantMessage.seq, step: opts.currentStep });

  // 续跑条件：上个 turn 有工具调用 OR 有 steer 等待
  // 文档 03：两者之一循环就继续
  const needsContinuation = hasToolCall || opts.hasSteer;

  return {
    needsContinuation,
    step: opts.currentStep + 1,
    epoch: newEpoch,
    compactionTriggered: false,
    overflowCompactionTriggered: false,
  };
}

// cost 计算（15）
// 简单 mock：input $0.001/1k, output $0.003/1k
function computeCost(usage: Usage): number {
  const inputCost = (usage.inputTokens / 1000) * 0.001;
  const outputCost = (usage.outputTokens / 1000) * 0.003;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}
