// 成本追踪与计费模型（15）—— Usage 双视角 schema
//
// 文档 15：provider 报告的 token 用量用一个 Usage 类同时存两种视角
//   - Inclusive totals：inputTokens 含 cached reads/writes；outputTokens 含 reasoning
//   - Non-overlapping breakdown：每字段独立有意义，存 nonCached/cacheRead/cacheWrite/reasoning
// 不变量：nonCachedInput + cacheRead + cacheWrite = inputTokens；reasoningTokens ≤ outputTokens
// 每字段独立存——消费者读任何需要的都不用减，消除"减法下溢"类 bug
//
// 持久化：assistant 消息级 cost + session 聚合（migration 回填）
// ACP 上报：buildUsage + contextTokens + totalSessionCost

import type { SessionHistory } from "../session/history.js";
import type { Usage } from "../session/message.js";

// visibleOutputTokens：整个 schema 里唯一做减法的地方，且 clamp 到 0
// 文档 15：防 provider 报 reasoning > output 崩溃
export function visibleOutputTokens(u: Usage): number {
  const out = u.outputTokens;
  const reason = u.reasoningTokens ?? 0;
  return Math.max(0, out - reason);
}

// buildUsage（15）：把 OpenCode 的 token 分解转成 ACP 的 Usage 格式
export interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

export function buildUsage(u: Usage | undefined): AcpUsage | null {
  if (!u) return null;
  const result: AcpUsage = {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens ?? u.inputTokens + u.outputTokens,
  };
  if ((u.reasoningTokens ?? 0) > 0) {
    result.thoughtTokens = u.reasoningTokens;
  }
  if ((u.cacheReadInputTokens ?? 0) > 0) {
    result.cachedReadTokens = u.cacheReadInputTokens;
  }
  if ((u.cacheWriteInputTokens ?? 0) > 0) {
    result.cachedWriteTokens = u.cacheWriteInputTokens;
  }
  return result;
}

// contextTokens：input + cache.read + cache.write（当前 context pressure）
export function contextTokens(u: Usage | undefined): number {
  if (!u) return 0;
  return (
    u.inputTokens +
    (u.cacheReadInputTokens ?? 0) +
    (u.cacheWriteInputTokens ?? 0)
  );
}

// totalSessionCost：SUM 所有 assistant 消息的 cost
export function totalSessionCost(history: SessionHistory): number {
  let total = 0;
  for (const m of history.all()) {
    if (m.variant === "assistant" && (m as any).cost) {
      total += (m as any).cost;
    }
  }
  return Math.round(total * 1_000_000) / 1_000_000;
}

// session 聚合（migration 20260510033149_session_usage）
export interface SessionUsageAggregate {
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

export function aggregateSessionUsage(history: SessionHistory): SessionUsageAggregate {
  let cost = 0;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const m of history.all()) {
    if (m.variant === "assistant") {
      const a = m as any;
      if (a.cost) cost += a.cost;
      if (a.tokens) {
        input += a.tokens.input ?? 0;
        output += a.tokens.output ?? 0;
        reasoning += a.tokens.reasoning ?? 0;
        cacheRead += a.tokens.cache?.read ?? 0;
        cacheWrite += a.tokens.cache?.write ?? 0;
      }
    }
  }
  return {
    cost: Math.round(cost * 1_000_000) / 1_000_000,
    tokens_input: input,
    tokens_output: output,
    tokens_reasoning: reasoning,
    tokens_cache_read: cacheRead,
    tokens_cache_write: cacheWrite,
  };
}
