// Session 消息变体（02/06）
//
// 文档 06：session 内部存的消息变体 → LLM 标准消息（toLLMMessages）。
//   user / synthetic / system / shell / assistant / compaction / agent-switched / model-switched
//
// 文档 02：消息有 seq（序号），用于 baseline_seq / compaction_seq 截断。

// --- 消息变体 ---
export type MessageVariant =
  | "user"
  | "synthetic" // 系统注入的假用户消息（如 MAX_STEPS）
  | "system" // epoch Updated 的更新文本
  | "shell"
  | "assistant"
  | "compaction"
  | "agent-switched"
  | "model-switched";

// --- part 类型（assistant 消息的组成部分）---
export interface TextPart {
  type: "text";
  text: string;
}
export interface ReasoningPart {
  type: "reasoning";
  text: string;
}
export interface ToolCallPart {
  type: "tool-call";
  id: string;
  name: string;
  args: unknown;
  // 这个 call 是不是 provider 自己执行的（如 web_search）——providerExecuted
  // 文档 06：providerExecuted tool 只发 ToolResultPart，不发 call
  providerExecuted?: boolean;
}
export interface ToolResultPart {
  type: "tool-result";
  id: string; // 对应 tool-call 的 id
  name: string;
  // 结果可能是错误（BlockedError / DeclinedError 等）
  error?: boolean;
  output?: unknown; // 已被 ToolOutputStore bound 过的 view
}
export type AssistantPart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart;

// --- session 内部的消息变体 ---
export interface BaseMessage {
  id: string;
  seq: number; // 历史序号
  variant: MessageVariant;
  createdAt: number;
}

export interface UserMessage extends BaseMessage {
  variant: "user";
  text: string;
  attachments?: Array<{ type: "file"; path: string; content: string }>;
  metadata?: { agent?: string };
}

export interface SyntheticMessage extends BaseMessage {
  variant: "synthetic";
  text: string; // 内容是系统指令（如 MAX_STEPS）
}

export interface SystemMessage extends BaseMessage {
  variant: "system";
  text: string; // epoch Updated 的更新文本
}

export interface ShellMessage extends BaseMessage {
  variant: "shell";
  command: string;
  output: string;
}

export interface AssistantMessage extends BaseMessage {
  variant: "assistant";
  parts: AssistantPart[];
  model?: string;
  provider?: string;
  providerMetadata?: unknown; // reasoning/tool 的 provider 元数据（sameModel 时复用）
  // 成本（15）
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

export interface CompactionMessage extends BaseMessage {
  variant: "compaction";
  summary: string; // 结构化摘要
  recentContext: string;
}

export interface MetaMessage extends BaseMessage {
  variant: "agent-switched" | "model-switched";
  // 不进 LLM 上下文
  data?: { from?: string; to?: string };
}

export type SessionMessage =
  | UserMessage
  | SyntheticMessage
  | SystemMessage
  | ShellMessage
  | AssistantMessage
  | CompactionMessage
  | MetaMessage;

// --- LLM 标准消息（发给 provider 的）---
export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown; // JSON schema
  };
}

export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: unknown;
      is_error?: boolean;
    };

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | LLMContentPart[];
  // assistant 的 provider 元数据（reasoning、tool 的 provider metadata）
  providerMetadata?: unknown;
}

export interface LLMRequest {
  system: string[]; // [agent.system, baseline]
  messages: LLMMessage[];
  tools: LLMTool[] | undefined;
  toolChoice: "auto" | "none" | undefined;
  providerOptions?: {
    promptCacheKey?: string;
  };
  maxTokens?: number;
  // provider 元信息（组装时注入，供实际 provider 使用）
  provider?: string;
  model?: string;
}

// --- LLM stream 事件 ---
export type LLMEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | {
      type: "tool-call";
      id: string;
      name: string;
      args: unknown;
      providerExecuted?: boolean;
    }
  | {
      type: "finish";
      usage?: Usage;
      stopReason?: string;
      providerMetadata?: unknown;
    }
  | { type: "error"; error: unknown };

// Usage（15）双视角 schema
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  nonCachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  providerMetadata?: Record<string, unknown>;
}

// 唯一 id
let _idCounter = 0;
export function genId(prefix = "m"): string {
  _idCounter++;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
}
