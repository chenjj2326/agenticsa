// 错误处理与恢复策略（07）
//
// 文档 07 核心分类：
//   - typed error：业务可恢复错误（如 PermissionDenied）
//   - defect：非预期错误 / 控制流信号（如 compaction 转场）
//   - interruption：被中断（用户取消 / 归属不匹配）
//
// 关键不变量：
//   - LLMError 带 retryable 属性
//   - ToolFailure 是显式通道（工具想让模型看到的安全消息）
//   - isUserDeclined → halt 整个 loop
//   - 30+ 正则识别 context overflow，但要排除限流（限流是 retryable）

// --- LLM 错误 ---
export abstract class LLMError extends Error {
  abstract readonly retryable: boolean;
  readonly _tag = "LLMError";
  constructor(
    message: string,
    readonly provider?: string
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ProviderAuthError extends LLMError {
  readonly retryable = false;
  constructor(provider?: string) {
    super("Provider authentication failed", provider);
  }
}

export class RateLimitError extends LLMError {
  readonly retryable = true;
  constructor(provider?: string) {
    super("Rate limited", provider);
  }
}

export class ContextOverflowError extends LLMError {
  // 07/14：被动压缩只重试一次
  readonly retryable = true;
  constructor(provider?: string) {
    super("Context window overflow", provider);
  }
}

export class MessageAbortedError extends LLMError {
  readonly retryable = false;
  constructor(provider?: string) {
    super("Message aborted", provider);
  }
}

export class ContentFilterError extends LLMError {
  readonly retryable = false;
  constructor(provider?: string) {
    super("Content filtered", provider);
  }
}

export class MessageOutputLengthError extends LLMError {
  readonly retryable = false;
  constructor(provider?: string) {
    super("Message output length exceeded", provider);
  }
}

// 工具失败：显式通道（工具想让模型看到的安全消息）
// 文档 11：ToolFailure 是显式通道，sanitize 不暴露私有原因
export class ToolFailure extends Error {
  readonly _tag = "ToolFailure";
  readonly safeMessage: string;
  readonly category:
    | "parse"
    | "unsupported_syntax"
    | "unknown_tool"
    | "invalid_data"
    | "tool_failure"
    | "limits"
    | "timeout";

  constructor(
    safeMessage: string,
    category: ToolFailure["category"] = "tool_failure"
  ) {
    super(safeMessage);
    this.name = "ToolFailure";
    this.safeMessage = safeMessage;
    this.category = category;
  }
}

// 权限/问题拒绝（用户说"不"）
// 文档 03/11：isUserDeclined 检测后 halt 整个 loop，不变成 model-facing tool output
export abstract class UserDeclinedError extends Error {
  readonly _tag = "UserDeclined";
  abstract readonly kind: "declined" | "corrected";
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class DeclinedError extends UserDeclinedError {
  readonly kind = "declined" as const;
  constructor(message = "User declined") {
    super(message);
  }
}

export class CorrectedError extends UserDeclinedError {
  readonly kind = "corrected" as const;
  constructor(readonly feedback: string) {
    super(`User corrected: ${feedback}`);
  }
}

export class BlockedError extends Error {
  readonly _tag = "Blocked";
  constructor(
    message: string,
    readonly rules: Array<{ action: string; resource: string; effect: string }>
  ) {
    super(message);
    this.name = "BlockedError";
  }
}

// 检测错误是否"用户拒绝"
export function isUserDeclined(e: unknown): e is UserDeclinedError {
  return e instanceof UserDeclinedError;
}

// 检测错误是否"权限被挡"
export function isBlocked(e: unknown): e is BlockedError {
  return e instanceof BlockedError;
}

// 检测错误是否 LLM 错误
export function isLLMError(e: unknown): e is LLMError {
  return e instanceof LLMError;
}

// 检测是否 context overflow（30+ 正则识别，排除限流）
// 文档 11/14：限流是 retryable 要重试，overflow 要压缩
const OVERFLOW_PATTERNS = [
  /context.*(length|overflow|exceeded|window)/i,
  /maximum.*context/i,
  /prompt.*too.*long/i,
  /tokens.*exceed/i,
  /context_length_exceeded/i,
  /input.*too.*long/i,
  /context.*limit/i,
  /exceeds.*context/i,
];

const RATE_LIMIT_PATTERNS = [
  /rate.*limit/i,
  /too.*many.*requests/i,
  /429/,
  /quota/i,
  /throttl/i,
];

export function classifyProviderError(
  err: unknown,
  provider?: string
): LLMError {
  const msg = err instanceof Error ? err.message : String(err);

  // 先排除限流
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(msg))) {
    return new RateLimitError(provider);
  }

  if (OVERFLOW_PATTERNS.some((re) => re.test(msg))) {
    return new ContextOverflowError(provider);
  }

  if (/auth|unauthor|api.*key|401/i.test(msg)) {
    return new ProviderAuthError(provider);
  }

  if (/abort|cancel/i.test(msg)) {
    return new MessageAbortedError(provider);
  }

  if (/filter|safety|refus/i.test(msg)) {
    return new ContentFilterError(provider);
  }

  if (/output.*length|max.?tokens|finish.*reason/i.test(msg)) {
    return new MessageOutputLengthError(provider);
  }

  // 默认当 retryable
  const e = new (class extends LLMError {
    readonly retryable = true;
  })(msg, provider);
  return e;
}
