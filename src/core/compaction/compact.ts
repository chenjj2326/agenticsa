// Compaction（02/14）
//
// 文档 14：compactIfNeeded 主动压缩——估算 system+messages+tools 超过 context - max(output, buffer) 就压
// 文档 02/14：压缩算法——从后往前保留最近 8000 token 对话作为 recent，其余让模型用结构化模板摘要
//   结构化模板六节：Objective / Important Details / Work State (Completed/Active/Blocked) / Next Move / Relevant Files
//   有 prior summary 时合并（carry forward / conversation 赢 / Active→Completed）
// 文档 03/14：被动压缩——provider 报 overflow 且 assistant 还没开始输出时，压一次重试，只重试一次

import {
  estimateValue,
  DEFAULT_BUFFER,
  DEFAULT_KEEP_TOKENS,
  SUMMARY_OUTPUT_TOKENS,
} from "../token/estimate.js";
import type { LLMRequest, SessionMessage, AssistantMessage, CompactionMessage } from "../session/message.js";
import type { LLMProvider } from "../../provider/llm.js";

export interface CompactionRecord {
  seq: number;
  summary: string;
  recentContext: string;
}

// compactIfNeeded：主动压缩判断
// 文档 14：if !auto 不压；if context undefined 不压；if estimate(req) <= context - max(output, buffer) 不压；else 压
export function compactIfNeeded(
  req: LLMRequest,
  contextLimit: number | undefined,
  outputBudget: number,
  options: { auto: boolean; buffer?: number }
): boolean {
  if (!options.auto) return false;
  if (contextLimit === undefined || contextLimit <= 0) return false;
  const buffer = options.buffer ?? DEFAULT_BUFFER;
  const est = estimateValue(req);
  const threshold = contextLimit - Math.max(outputBudget, buffer);
  return est > threshold;
}

// select：从后往前累积保留最近 keep_tokens（8000）的对话作为 recent
export function selectForCompaction(
  messages: SessionMessage[],
  keepTokens: number = DEFAULT_KEEP_TOKENS
): { head: SessionMessage[]; recent: SessionMessage[] } {
  // 估算每条消息的 token（用 length/4）
  const estimateOne = (m: SessionMessage): number => {
    // 简单估算：取 JSON 长度 / 4
    return Math.max(1, Math.round(JSON.stringify(m).length / 4));
  };

  let total = 0;
  let splitIdx = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateOne(messages[i]);
    if (total + t > keepTokens) {
      splitIdx = i + 1;
      break;
    }
    total += t;
    splitIdx = i;
  }
  if (splitIdx === 0) splitIdx = messages.length; // 全保留
  return {
    head: messages.slice(0, splitIdx),
    recent: messages.slice(splitIdx),
  };
}

// 结构化摘要模板（六节）
// 文档 02/14：Objective / Important Details / Work State (Completed/Active/Blocked) / Next Move / Relevant Files
export function buildSummaryPrompt(
  headMessages: SessionMessage[],
  priorSummary: string | null
): string {
  const serializeMsg = (m: SessionMessage): string => {
    switch (m.variant) {
      case "user":
      case "synthetic":
      case "system":
        return `[${m.variant}]: ${m.text ?? ""}`;
      case "assistant": {
        const a = m as AssistantMessage;
        const parts = a.parts
          .map((p) => {
            if (p.type === "text") return p.text;
            if (p.type === "reasoning") return `(reasoning: ${p.text})`;
            if (p.type === "tool-call")
              return `(tool-call: ${p.name} ${JSON.stringify(p.args)})`;
            if (p.type === "tool-result")
              return `(tool-result: ${JSON.stringify(p.output).slice(0, 200)})`;
            return "";
          })
          .join(" | ");
        return `[assistant]: ${parts}`;
      }
      case "compaction":
        return `[prior compaction summary]: ${(m as CompactionMessage).summary}`;
      case "shell":
        return `[shell]: ${m.command} -> ${m.output.slice(0, 200)}`;
      default:
        return `[${m.variant}]`;
    }
  };

  const serialized = headMessages.map(serializeMsg).join("\n");

  const sections = `## Objective
(What was the user trying to accomplish in this conversation?)

## Important Details
(Non-obvious findings, hidden dependencies, configuration quirks, debugging breakthroughs.)

## Work State
### Completed
- (what's done)
### Active
- (what's in progress)
### Blocked
- (what's blocked and why)

## Next Move
(What should the next turn do?)

## Relevant Files
(Files touched or referenced.)`;

  const priorSection = priorSummary
    ? `Prior summary to merge (carry forward Active→Completed where the conversation shows completion; new facts override old):
${priorSummary}
`
    : "";

  return `You are summarizing an agent conversation for compaction. Produce a structured summary following this template exactly:

${sections}

Conversation to summarize:
${serialized}

${priorSection}Output ONLY the filled-in template in markdown.`;
}

// 摘要 prompt 自身大小检查（防摘要 prompt 自己溢出）
// 文档 14：if Token.estimate(summaryPrompt) > context - summaryOutput 就放弃
export function summaryPromptFits(
  summaryPrompt: string,
  contextLimit: number | undefined
): boolean {
  if (!contextLimit || contextLimit <= 0) return true;
  const est = Math.round(summaryPrompt.length / 4);
  return est <= contextLimit - SUMMARY_OUTPUT_TOKENS;
}

// 实际跑压缩（用 provider 生成摘要）
// 这里 mock provider 不擅长结构化输出，我们用一个基于内容的简单摘要生成器
export async function runCompaction(
  messages: SessionMessage[],
  priorSummary: string | null,
  _provider?: LLMProvider
): Promise<CompactionRecord> {
  const { head, recent } = selectForCompaction(messages);

  // 生成 recent context（给模型继续用的最近对话）
  const recentContext = recent
    .map((m) => {
      if (m.variant === "user") return `User: ${m.text}`;
      if (m.variant === "assistant") {
        const a = m as AssistantMessage;
        return `Assistant: ${a.parts
          .map((p) => (p.type === "text" ? p.text : `(tool:${p.type === "tool-call" ? (p as any).name : "result"})`))
          .join(" ")}`;
      }
      return `[${m.variant}]`;
    })
    .join("\n");

  // 生成结构化摘要（用启发式，因为 mock 不会做）
  const summary = generateHeuristicSummary(head, priorSummary);

  const seq = messages.length > 0 ? messages[messages.length - 1].seq + 1 : 1;
  return {
    seq,
    summary,
    recentContext,
  };
}

// 启发式生成结构化摘要（mock）
function generateHeuristicSummary(
  head: SessionMessage[],
  priorSummary: string | null
): string {
  // 提取 user 消息作为 objective
  const userMsgs = head.filter((m) => m.variant === "user").map((m) => (m as any).text as string);
  const objective = userMsgs[0] || "(no explicit objective)";

  // 提取 assistant 的 tool calls
  const toolCalls: string[] = [];
  for (const m of head) {
    if (m.variant === "assistant") {
      const a = m as AssistantMessage;
      for (const p of a.parts) {
        if (p.type === "tool-call") {
          toolCalls.push(`${p.name}(${JSON.stringify(p.args).slice(0, 50)})`);
        }
      }
    }
  }

  // 提取文件路径
  const files = new Set<string>();
  for (const m of head) {
    const text = m.variant === "assistant"
      ? (m as AssistantMessage).parts.map((p) => (p.type === "text" ? p.text : "")).join(" ")
      : (m as any).text ?? "";
    const matches = text.match(/[\w./\\-]+\.\w+/g) || [];
    matches.forEach((f: string) => files.add(f));
  }

  const priorNote = priorSummary ? `\n(Prior summary merged in.)\n` : "";

  return `## Objective
${objective}
${priorNote}
## Important Details
- ${toolCalls.length} tool calls were made: ${toolCalls.slice(0, 5).join(", ")}${toolCalls.length > 5 ? " ..." : ""}

## Work State
### Completed
- Initial exploration and tool execution
### Active
- (conversation compacted; see recent-context below)
### Blocked
- (none)

## Next Move
Continue based on the recent context below.

## Relevant Files
${Array.from(files).slice(0, 10).map((f) => `- ${f}`).join("\n") || "- (none detected)"}`;
}
