// 错误处理策略（07）
//
// 文档 07：
//   - LLMError 带 retryable 属性
//   - 限流 retryTransient（2 次，exponential 200ms jittered）
//   - 崩溃不自动重试 provider work
//   - ToolFailure 是显式通道（不暴露私有原因）
//   - isUserDeclined → halt
//
// 文档 11：未知 host 失败和无效输出做 sanitize

import { isLLMError, RateLimitError, LLMError } from "./errors.js";
import { sleep } from "../effect/runtime.js";

// retryTransient：限流重试（2 次，exponential 200ms jittered）
// 文档 11：HTTP 请求 retryTransient
export async function retryTransient<T>(
  fn: () => Promise<T>,
  options: { retries?: number; baseMs?: number } = {}
): Promise<T> {
  const retries = options.retries ?? 2;
  const baseMs = options.baseMs ?? 200;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      // 只重试 retryable 的错误（限流等）
      if (isLLMError(e)) {
        if (!e.retryable) throw e;
      } else {
        // 非 LLM 错误——直接抛
        throw e;
      }
      if (attempt === retries) break;
      // exponential + jittered
      const delay = baseMs * Math.pow(2, attempt) + Math.random() * 100;
      await sleep(delay);
    }
  }
  throw lastError;
}

// Usage mapper（15）
// 文档 15：provider 差异 mapper 各算一侧——OpenAI/Gemini/Bedrock 原生报 inclusive，
//   Anthropic 原生报 breakdown（input_tokens 是 non-cached），对上层透明。
import type { Usage } from "../session/message.js";

export function mapOpenAIUsage(raw: any): Usage {
  // OpenAI 原生报 inclusive
  const inputTokens = raw?.prompt_tokens ?? 0;
  const outputTokens = raw?.completion_tokens ?? 0;
  const cached = raw?.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = raw?.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: raw?.total_tokens ?? inputTokens + outputTokens,
    nonCachedInputTokens: inputTokens - cached,
    cacheReadInputTokens: cached,
    cacheWriteInputTokens: 0,
    reasoningTokens: reasoning,
    providerMetadata: { openai: raw },
  };
}

export function mapAnthropicUsage(raw: any): Usage {
  // Anthropic 原生报 breakdown
  const nonCachedInput = raw?.input_tokens ?? 0;
  const cacheRead = raw?.cache_read_input_tokens ?? 0;
  const cacheWrite = raw?.cache_creation_input_tokens ?? 0;
  const outputTokens = raw?.output_tokens ?? 0;
  const inputTokens = nonCachedInput + cacheRead + cacheWrite; // 加出 inclusive
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    nonCachedInputTokens: nonCachedInput,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    reasoningTokens: undefined,
    providerMetadata: { anthropic: raw },
  };
}
