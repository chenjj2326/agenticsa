// Mock LLM Provider
//
// 真实 API key 明天接入。现在用一个能"决策"的 mock：根据 LLMRequest 的 messages 推断该做什么。
// 设计目标：
//   1. 能解析用户的最后一条 user 消息
//   2. 根据关键词决定调哪个工具
//   3. 工具结果回灌后能总结输出
//   4. MAX_STEPS（isLastStep，toolChoice=none）时直接文本收尾
//   5. 支持"不调工具直接答"模式（如问候、日期等）
//
// 同时模拟 Usage（15）——双视角 schema。

import type { LLMEvent, LLMRequest, Usage } from "../core/session/message.js";
import type { LLMProvider } from "./llm.js";
import { estimateValue } from "../core/token/estimate.js";

export class MockProvider implements LLMProvider {
  name = "mock";

  listModels(): string[] {
    return ["mock-small", "mock-large"];
  }

  contextLimit(model: string): number | undefined {
    // 模拟 context window（用于 compactIfNeeded）
    if (model === "mock-large") return 128_000;
    if (model === "mock-small") return 32_000;
    return undefined;
  }

  async *stream(
    req: LLMRequest,
    _signal?: AbortSignal
  ): AsyncIterable<LLMEvent> {
    // DEBUG
    if (process.env.MYAGENT_DEBUG === "1") {
      console.error(
        `[mock] messages=${req.messages.length} tools=${
          req.tools?.length ?? 0
        } toolChoice=${req.toolChoice}`
      );
      for (const m of req.messages) {
        const contentStr =
          typeof m.content === "string"
            ? m.content.slice(0, 80)
            : Array.isArray(m.content)
              ? `[${m.content.map((c: any) => c.type).join(",")}]`
              : "?";
        console.error(`  [mock] ${m.role}: ${contentStr}`);
      }
    }
    // 取最后一条 user 消息作为推断依据
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const userText =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? (lastUser!.content as Array<any>)
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n")
          : "";

    // 取最后一条「真实」user 文本消息（排除工具结果回灌成 user 的）：
    //   - lastIsUser 时：它就是本轮用户输入
    //   - lastIsToolResult 时：它就是触发本轮工具调用的原始问题
    // 注意不能用 realUserMessages[0]——多轮在同一 session 累积时，[0] 永远是第一条。
    const realUserMessages = req.messages.filter(
      (m: any) => m.role === "user" && typeof m.content === "string"
    );
    const originalQuery =
      realUserMessages.length > 0
        ? (realUserMessages[realUserMessages.length - 1].content as string)
        : userText;

    // 取最后一条消息——判断是新 user 输入还是工具结果回灌后
    const lastMsg = req.messages[req.messages.length - 1];
    const lastIsUser = lastMsg?.role === "user";
    const lastIsToolResult =
      lastMsg?.role === "tool" ||
      (Array.isArray(lastMsg?.content) &&
        (lastMsg!.content as Array<any>).some((c) => c.type === "tool_result"));

    // 检查是不是最后一个 step（toolChoice=none）
    const isLastStep = req.toolChoice === "none";

    // ====== 决策 ======
    let decision: LLMEvent[] = [];

    if (isLastStep) {
      // MAX_STEPS：直接文本收尾
      decision = [
        {
          type: "text-delta",
          text: this.summarizeAfterMaxSteps(originalQuery, !!lastIsToolResult),
        },
        {
          type: "finish",
          usage: this.makeUsage(req),
          stopReason: "stop",
        },
      ];
    } else if (lastIsToolResult) {
      // 工具结果回灌后，做总结
      decision = [
        { type: "text-delta", text: this.summarizeAfterTool(originalQuery) },
        { type: "finish", usage: this.makeUsage(req), stopReason: "stop" },
      ];
    } else if (lastIsUser && /^(hello|hi|hey|你好|嗨)\b/i.test(originalQuery.trim())) {
      // 问候：必须是开头就是问候词（避免 "write hello.txt" 里含 hello 被误判）
      decision = [
        { type: "text-delta", text: "Hi! I'm MyAgent. How can I help you?" },
        { type: "finish", usage: this.makeUsage(req), stopReason: "stop" },
      ];
    } else if (lastIsUser && /list files|列出文件|ls\b/i.test(originalQuery)) {
      decision = [
        { type: "text-delta", text: "Let me list the files in the current directory." },
        {
          type: "tool-call",
          id: `call_${Date.now()}`,
          name: "bash",
          args: { command: "ls -la" },
        },
        { type: "finish", usage: this.makeUsage(req), stopReason: "tool_use" },
      ];
    } else if (lastIsUser && /glob\b|find files?/i.test(originalQuery)) {
      const match = originalQuery.match(/(?:glob|find files?)\s+(.*)/i);
      const pattern = match?.[1]?.trim() || "**/*.ts";
      decision = [
        { type: "text-delta", text: `I'll search for files matching \`${pattern}\`.` },
        {
          type: "tool-call",
          id: `call_${Date.now()}`,
          name: "glob",
          args: { pattern },
        },
        { type: "finish", usage: this.makeUsage(req), stopReason: "tool_use" },
      ];
    } else if (lastIsUser && /grep\b|search for/i.test(originalQuery)) {
      const match = originalQuery.match(/(?:grep|search for)\s+(\S+)/i);
      const pattern = match?.[1] || "TODO";
      decision = [
        { type: "text-delta", text: `Searching for \`${pattern}\` in files...` },
        {
          type: "tool-call",
          id: `call_${Date.now()}`,
          name: "grep",
          args: { pattern },
        },
        { type: "finish", usage: this.makeUsage(req), stopReason: "tool_use" },
      ];
    } else if (lastIsUser && /read (file|me)|读/i.test(originalQuery)) {
      const match = originalQuery.match(/(?:read (?:file|me)?|读)\s*(.*)/i);
      const file = match?.[1]?.trim() || "README.md";
      decision = [
        { type: "text-delta", text: `Reading \`${file}\`...` },
        {
          type: "tool-call",
          id: `call_${Date.now()}`,
          name: "read",
          args: { path: file },
        },
        { type: "finish", usage: this.makeUsage(req), stopReason: "tool_use" },
      ];
    } else if (lastIsUser && /what.*date|today|今天|日期/i.test(originalQuery)) {
      decision = [
        {
          type: "text-delta",
          text: `Today is ${new Date().toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}. (The system context already includes this in the baseline.)`,
        },
        { type: "finish", usage: this.makeUsage(req), stopReason: "stop" },
      ];
    } else if (lastIsUser && /write|创建|写入|新建/i.test(originalQuery)) {
      const match = originalQuery.match(/(?:write|创建|写入|新建)\s+(\S+)/i);
      const file = match?.[1] || "hello.txt";
      decision = [
        { type: "text-delta", text: `I'll create \`${file}\`.` },
        {
          type: "tool-call",
          id: `call_${Date.now()}`,
          name: "write",
          args: { path: file, content: `Hello from MyAgent at ${new Date().toISOString()}\n` },
        },
        { type: "finish", usage: this.makeUsage(req), stopReason: "tool_use" },
      ];
    } else if (lastIsUser && /who are you|你是谁|你叫什么/i.test(originalQuery)) {
      decision = [
        {
          type: "text-delta",
          text:
            "I'm MyAgent, an OpenCode-style coding agent implemented strictly per the architecture documents in e:/opencode-dev/文档/. " +
            "My loop is three-tier nested (Coordinator → Runner → runTurn), my context management uses a Source algebra with Epochs, my tool system separates visibility from authorization with three-state permissions, and my prompt is assembled as [agent.system, dynamic baseline] to keep the baseline stable for prompt-cache hits. Model calls are currently mocked — real provider keys land tomorrow.",
        },
        { type: "finish", usage: this.makeUsage(req), stopReason: "stop" },
      ];
    } else if (lastIsUser && /help|帮助/i.test(originalQuery)) {
      decision = [
        {
          type: "text-delta",
          text:
            "Try one of: 'list files', 'read README.md', 'grep TODO', 'write hello.txt', 'what is the date', 'who are you'. " +
            "When a tool needs permission, you'll be prompted to allow / always / reject.",
        },
        { type: "finish", usage: this.makeUsage(req), stopReason: "stop" },
      ];
    } else if (lastIsUser) {
      // 默认 user 输入：尝试调一次 bash ls 看看（展示工具循环）
      decision = [
        {
          type: "text-delta",
          text: `I'll start by running \`ls\` to see the working directory.`,
        },
        {
          type: "tool-call",
          id: `call_${Date.now()}`,
          name: "bash",
          args: { command: "ls -la" },
        },
        { type: "finish", usage: this.makeUsage(req), stopReason: "tool_use" },
      ];
    } else {
      // 默认 fallback
      decision = [
        { type: "text-delta", text: "(no actionable input)" },
        { type: "finish", usage: this.makeUsage(req), stopReason: "stop" },
      ];
    }

    // 模拟流式（小延迟）
    for (const ev of decision) {
      await new Promise((r) => setTimeout(r, 5));
      yield ev;
    }
  }

  private summarizeAfterTool(originalQuery: string): string {
    return `Done. Based on the tool result, here's my summary.\n\n(Original request was: "${originalQuery.slice(0, 80)}")`;
  }

  private summarizeAfterMaxSteps(originalQuery: string, hasToolResult: boolean): string {
    return (
      `I've reached the step limit for this turn. ` +
      (hasToolResult
        ? "I executed some tools and have the results above. "
        : "I did not call any tools this turn. ") +
      `Summary: ${originalQuery.slice(0, 60)}...\nNext: pick up from here in a new turn.`
    );
  }

  // 文档 15：Usage 双视角 schema
  // inclusive：inputTokens 含 cache、outputTokens 含 reasoning
  // non-overlapping：nonCached/cacheRead/cacheWrite/reasoning
  private makeUsage(req: LLMRequest): Usage {
    const inputTokens = estimateValue(req) + 50;
    const outputTokens = 80;
    const reasoningTokens = 0;
    const cacheRead = 0;
    const cacheWrite = 0;
    return {
      // inclusive
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      // non-overlapping breakdown
      nonCachedInputTokens: inputTokens - cacheRead - cacheWrite,
      cacheReadInputTokens: cacheRead,
      cacheWriteInputTokens: cacheWrite,
      reasoningTokens,
      // provider 原始 payload
      providerMetadata: { mock: { simulated: true } },
    };
  }
}
