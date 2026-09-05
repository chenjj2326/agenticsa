// Token 经济（14）
// 文档 14：length/4 估算，不用 tokenizer，O(n) 字符数

export const CHARS_PER_TOKEN = 4;

export function estimate(input: string): number {
  if (!input) return 0;
  return Math.max(0, Math.round(input.length / CHARS_PER_TOKEN));
}

// 序列化整个 value 后估算（注意 tools 定义也占 token）
export function estimateValue(value: unknown): number {
  return estimate(JSON.stringify(value));
}

// --- 四个关键阈值 ---
export const DEFAULT_BUFFER = 20_000; // 预留缓冲（防输出撑爆）
export const DEFAULT_KEEP_TOKENS = 8_000; // 压缩时保留的最近对话
export const SUMMARY_OUTPUT_TOKENS = 4_096; // 摘要生成的 maxTokens
export const TOOL_OUTPUT_MAX_CHARS = 2_000; // 压缩序列化时工具输出截断

// ToolOutputStore 的边界
export const TOOL_OUTPUT_MAX_LINES = 2_000;
export const TOOL_OUTPUT_MAX_BYTES = 50 * 1024; // 50KB
export const TOOL_OUTPUT_RETENTION_DAYS = 7;

// CodeMode 固定内部边界
export const CODEMODE_MAX_CONCURRENCY = 8;
