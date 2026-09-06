// 智谱 LLM Provider
//
// 接入真实模型（文档 06/15）：
//   - endpoint: https://open.bigmodel.cn/api/paas/v4/chat/completions
//   - auth: Authorization: Bearer <API_KEY>
//   - 免费模型: glm-4-flash / glm-4-air
//   - 流式: SSE（data: {json}\n\n）
//   - 工具调用: tool_calls 数组（含 id / function.name / function.arguments）
//
// 把 LLMRequest 映射到智谱格式，再把 SSE 事件还原成 LLMEvent。

import type { LLMEvent, LLMRequest, Usage } from "../core/session/message.js";
import type { LLMProvider } from "./llm.js";
import {
  classifyProviderError,
  LLMError,
  ProviderAuthError,
  ContextOverflowError,
  RateLimitError,
} from "../core/error/errors.js";

const ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
// 可用模型（已实测 key 可访问）：flash/air 便宜快，plus/4.5/4 更强
const AVAILABLE_MODELS = ["glm-4-flash", "glm-4-air", "glm-4-plus", "glm-4.5", "glm-4"];

interface ZhiPuTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface ZhiPuMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export class ZhiPuProvider implements LLMProvider {
  readonly name: string = "zhipu";
  // 可覆盖点：OpenAI 兼容端点（如 DashScope）通过子类改这两个字段复用全部 SSE 解析
  protected readonly endpoint: string = ENDPOINT;
  protected readonly defaultModel: string = "glm-4-flash";
  // OpenAI 官方风格流式需要显式要求返回 usage（智谱默认每帧都带）
  protected readonly includeUsageOption: boolean = false;
  private readonly apiKey: string;
  // 采样温度：benchmark/确定性任务建议调低（减少工具调用行为漂移）
  private readonly temperature: number;

  constructor(apiKey: string, opts: { temperature?: number } = {}) {
    this.apiKey = apiKey;
    this.temperature = opts.temperature ?? 0.7;
  }

  listModels(): string[] {
    return AVAILABLE_MODELS;
  }

  contextLimit(model: string): number | undefined {
    if (model.startsWith("glm-5")) {
      return 1_000_000;
    }
    if (model === "glm-4.7" || model === "glm-4.7-flash" || model === "glm-4.7-flashx") {
      return 200_000;
    }
    if (
      model === "glm-4-flash" ||
      model === "glm-4-air" ||
      model === "glm-4" ||
      model === "glm-4-plus" ||
      model === "glm-4.5"
    ) {
      return 128_000;
    }
    return undefined;
  }

  async *stream(
    req: LLMRequest,
    signal?: AbortSignal
  ): AsyncIterable<LLMEvent> {
    const model = req.model || this.defaultModel;
    const messages = this._buildMessages(req);
    const tools: ZhiPuTool[] | undefined = req.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      temperature: this.temperature,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = req.toolChoice === "none" ? "none" : "auto";
    }
    if (this.includeUsageOption) {
      body.stream_options = { include_usage: true };
    }

    // 思考模型（glm-4.5/4.7/5 系）的 reasoning_content 也计入 max_tokens：
    // 不设或设太小会导致 content 为空、finish_reason=length。给个保底大值。
    // glm-4.7 官方 SWE-bench Verified 设置：max new tokens 16384。
    body.max_tokens =
      req.maxTokens ??
      (model.startsWith("glm-4.7") || model.startsWith("glm-5") ? 16384 : 8192);

    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e: any) {
      if (signal) signal.removeEventListener("abort", abortHandler);
      const err = classifyProviderError(e, "zhipu");
      yield { type: "error", error: err };
      return;
    }

    if (!response.ok) {
      if (signal) signal.removeEventListener("abort", abortHandler);
      const text = await response.text().catch(() => "(no body)");
      const err = this._classifyHttpError(response.status, text);
      yield { type: "error", error: err };
      return;
    }

    if (!response.body) {
      if (signal) signal.removeEventListener("abort", abortHandler);
      yield { type: "error", error: new Error("No response body from ZhiPu") };
      return;
    }

    yield* this._parseSSE(response.body, signal, abortHandler);
  }

  private async *_parseSSE(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    abortHandler: () => void
  ): AsyncIterable<LLMEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    // 工具调用累积（跨 SSE 事件拼接 arguments）
    let currentToolCallId: string | null = null;
    let currentToolCallName: string | null = null;
    let currentToolCallArgsBuffer = "";
    let totalUsage: Usage | undefined;
    let finalStopReason: string | undefined;
    let gotFinishReason = false;
    // 收集本轮全部纯文本——用于模型把工具调用格式化成纯文本时的 fallback 解析
    let textAccum = "";
    let emittedToolCalls = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;

          const lines = trimmed.split("\n");
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("data:")) {
              dataLine = line.slice(5).trim();
            }
          }

          if (!dataLine || dataLine === "[DONE]") {
            // flush 最后一个工具调用
            if (currentToolCallId && currentToolCallName) {
              yield* this._flushToolCall(
                currentToolCallId,
                currentToolCallName,
                currentToolCallArgsBuffer
              );
              emittedToolCalls++;
              currentToolCallId = null;
              currentToolCallName = null;
              currentToolCallArgsBuffer = "";
            }
            // Text-fallback：glm-4-flash 常把工具调用以纯文本吐出（如"bash\ngit log -3"），
            //   如果本轮没有真实 tool_calls 事件，就尝试从文本里解析。
            if (emittedToolCalls === 0) {
              const fallbacks = this._parseTextToolCalls(textAccum);
              for (const f of fallbacks) {
                yield* this._flushToolCall(f.id, f.name, f.args as string);
                emittedToolCalls++;
              }
            }
            if (!totalUsage) {
              totalUsage = {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                nonCachedInputTokens: 0,
                cacheReadInputTokens: 0,
                cacheWriteInputTokens: 0,
                reasoningTokens: 0,
              };
            }
            yield {
              type: "finish",
              usage: totalUsage,
              stopReason: finalStopReason ?? "stop",
              providerMetadata: {},
            };
            return;
          }

          try {
            const event = JSON.parse(dataLine);

            if (event.usage && !totalUsage) {
              totalUsage = this._mapUsage(event.usage);
            }

            const choice = event.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            const finishReason = choice.finish_reason;

            if (delta?.content) {
              textAccum += delta.content;
              yield { type: "text-delta", text: delta.content };
            }

            if (delta?.tool_calls && delta.tool_calls.length > 0) {
              for (const tc of delta.tool_calls) {
                if (tc.id && tc.id !== currentToolCallId) {
                  if (currentToolCallId && currentToolCallName) {
                    yield* this._flushToolCall(
                      currentToolCallId,
                      currentToolCallName,
                      currentToolCallArgsBuffer
                    );
                  }
                  currentToolCallId = tc.id;
                  currentToolCallName = tc.function?.name ?? null;
                  currentToolCallArgsBuffer = "";
                }
                if (tc.function?.name) {
                  currentToolCallName = tc.function.name;
                }
                if (tc.function?.arguments) {
                  currentToolCallArgsBuffer += tc.function.arguments;
                }
              }
            }

            if (finishReason) {
              // flush 工具调用，但不立即结束 —— 等 usage 事件
              if (currentToolCallId && currentToolCallName) {
                yield* this._flushToolCall(
                  currentToolCallId,
                  currentToolCallName,
                  currentToolCallArgsBuffer
                );
                emittedToolCalls++;
                currentToolCallId = null;
                currentToolCallName = null;
                currentToolCallArgsBuffer = "";
              }
              finalStopReason = finishReason;
              gotFinishReason = true;
              // 有些模型 usage 和 finish_reason 在同一事件
              if (event.usage) {
                totalUsage = this._mapUsage(event.usage);
              }
            }
          } catch {
          }
        }
      }

      // stream 意外结束（没有 [DONE]）
      if (currentToolCallId && currentToolCallName) {
                yield* this._flushToolCall(
                  currentToolCallId,
                  currentToolCallName,
                  currentToolCallArgsBuffer
                );
                emittedToolCalls++;
              }
              // Text-fallback：模型没有发 tool_calls 但纯文本看起来像
              //   `toolName\ntoolArgument`（glm-4-flash 常见的退化输出），
              //   就合成一个 tool-call 事件，让 agent 至少能执行。
              if (emittedToolCalls === 0) {
                const fallbacks = this._parseTextToolCalls(textAccum);
                for (const f of fallbacks) {
                  yield* this._flushToolCall(f.id, f.name, f.args as string);
                  emittedToolCalls++;
                }
              }
              if (!totalUsage) {
        totalUsage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          nonCachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          reasoningTokens: 0,
        };
      }
      yield {
        type: "finish",
        usage: totalUsage,
        stopReason: finalStopReason ?? "stop",
        providerMetadata: {},
      };
    } catch (e: any) {
      if (e?.name === "AbortError") {
        yield { type: "finish", usage: totalUsage, stopReason: "aborted" };
      } else {
        yield { type: "error", error: e };
      }
    } finally {
      if (signal) signal.removeEventListener("abort", abortHandler);
    }
  }

  // 内置工具名（必须与 registerBuiltinTools 保持一致）
  private static readonly KNOWN_TOOLS: Record<string, "string" | "json"> = {
    bash: "string",        // args 是 command 字符串
    read: "string",        // args 是 file_path 字符串
    write: "json",         // args 是 { file_path, content } JSON
    edit: "json",          // args 是 { file_path, old_string, new_string } JSON
    glob: "string",        // args 是 pattern 字符串
    grep: "string",        // args 是 pattern 字符串
    confirm: "string",     // args 是 message 字符串
    ask: "string",         // args 是 question 字符串
  };

  private _newToolId = () =>
    "call_" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 7);

  /**
   * Text-fallback 工具解析：
   *   glm-4-flash 偶尔会把工具调用格式化成纯文本，常见格式：
   *     1) "toolName\nmultilineArgumentText"（bash/read/glob/grep/confirm/ask）
   *     2) "toolName\n{ json object }"（write/edit）
   *     3) Markdown fenced code blocks 里的命令
   *     4) 三引号包裹的命令行
   *   对每个识别出的工具，返回一条伪 tool-call（需要走 _flushToolCall 统一 JSON 解析）。
   */
  private _parseTextToolCalls(text: string): Array<{ id: string; name: string; args: unknown }> {
    const out: Array<{ id: string; name: string; args: unknown }> = [];
    if (!text) return out;

    // 先去掉 Markdown 代码块围栏，取内部内容拼接回去，方便后续逐行识别
    let working = text;
    // ```bash / ```sh / ``` / ```command 代码块 —— 视为 bash 参数
    const codeBlocks: Array<{ lang: string; body: string }> = [];
    working = working.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, body) => {
      codeBlocks.push({ lang: (lang || "").toLowerCase(), body: body.replace(/\s*$/, "") });
      return `\n__CODEBLOCK${codeBlocks.length - 1}__\n`;
    });
    // ```json 代码块
    working = working.replace(/"""([\s\S]*?)"""/g, (_m, body) => {
      codeBlocks.push({ lang: "text", body: body.replace(/\s*$/, "") });
      return `\n__CODEBLOCK${codeBlocks.length - 1}__\n`;
    });

    const lines = working.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();

      // 代码块占位符：按语言推断工具
      const cbMatch = /^__CODEBLOCK(\d+)__$/.exec(line);
      if (cbMatch) {
        const cb = codeBlocks[Number(cbMatch[1])];
        if (cb) {
          const lang = cb.lang;
          if (lang === "bash" || lang === "sh" || lang === "shell" || lang === "command" || lang === "cmd" || lang === "ps" || lang === "powershell") {
            const cmd = cb.body.trim();
            if (cmd) out.push({ id: this._newToolId(), name: "bash", args: { command: cmd } });
          } else if (lang === "json") {
            // 可能是 write/edit 参数，尝试解析
            const parsed = this._safeJson(cb.body);
            if (parsed && typeof parsed === "object") {
              if ((parsed as any).file_path && (parsed as any).content !== undefined) {
                out.push({ id: this._newToolId(), name: "write", args: parsed });
              } else if (
                (parsed as any).file_path &&
                (parsed as any).old_string !== undefined &&
                (parsed as any).new_string !== undefined
              ) {
                out.push({ id: this._newToolId(), name: "edit", args: parsed });
              }
            }
          } else if (!lang) {
            // 无标记代码块——如果单行看起来是 shell 命令就走 bash
            const body = cb.body.trim();
            if (body && /\n/.test(body) === false && /^[\w-]+(\s|$)/.test(body)) {
              out.push({ id: this._newToolId(), name: "bash", args: { command: body } });
            } else if (body) {
              // 多行无标记：每一行非空行都可能是独立命令，用 bash && 拼接
              const cmds = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
              if (cmds.length > 0) {
                out.push({ id: this._newToolId(), name: "bash", args: { command: cmds.join(" && ") } });
              }
            }
          }
        }
        i++;
        continue;
      }

      // 格式：首行是工具名，后续行是它的参数（直到下一个工具名或文本末尾）
      if (ZhiPuProvider.KNOWN_TOOLS.hasOwnProperty(line)) {
        const toolName = line;
        const argStyle = ZhiPuProvider.KNOWN_TOOLS[toolName];
        i++;
        // 收集直到下一个工具名或 EOF
        const argLines: string[] = [];
        while (i < lines.length) {
          const nxt = lines[i].trim();
          if (ZhiPuProvider.KNOWN_TOOLS.hasOwnProperty(nxt)) break;
          argLines.push(lines[i]); // 保留原缩进
          i++;
        }
        const argText = argLines.join("\n").replace(/^\s+|\s+$/g, "");
        if (argText) {
          if (argStyle === "string") {
            const args: Record<string, unknown> = {};
            if (toolName === "bash") args.command = argText;
            else if (toolName === "read") args.file_path = argText;
            else if (toolName === "glob") args.pattern = argText;
            else if (toolName === "grep") args.pattern = argText;
            else if (toolName === "confirm") args.message = argText;
            else if (toolName === "ask") args.question = argText;
            if (Object.keys(args).length > 0) {
              out.push({ id: this._newToolId(), name: toolName, args });
            }
          } else {
            // json 风格：尝试整段 JSON；失败则按工具名兜底
            const parsed = this._safeJson(argText);
            if (parsed && typeof parsed === "object") {
              out.push({ id: this._newToolId(), name: toolName, args: parsed });
            } else {
              // 兜底：write 把非 JSON 文本当 content，路径用空串（工具层会报错，但比完全丢掉好）
              if (toolName === "write") {
                out.push({
                  id: this._newToolId(),
                  name: "write",
                  args: { file_path: "", content: argText },
                });
              }
            }
          }
        }
        continue;
      }

      i++;
    }

    return out;
  }

  private _safeJson(s: string): unknown {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  private *_flushToolCall(
    id: string,
    name: string,
    argsBuffer: unknown
  ) {
    let parsedArgs: unknown;
    // argsBuffer 可能是：字符串（原生 tool_calls 累积的 arguments 片段）
    // 或已解析对象（text-fallback 路径 _parseTextToolCalls 直接给对象）
    if (typeof argsBuffer === "object" && argsBuffer !== null) {
      parsedArgs = argsBuffer;
    } else {
      const buf = (typeof argsBuffer === "string" ? argsBuffer : "").trim();
      if (buf.length === 0) {
        // 流式 delta 中 arguments 为空时不应该把 undefined/空串当 args。
        parsedArgs = {};
      } else {
        try {
          parsedArgs = JSON.parse(buf);
        } catch {
        // 仍然解析失败：根据工具名合成一个能让模型清楚看到错误的参数形状，
        // 避免 execute 收到 string → 字段 undefined → 静默失败 ERROR null
        if (name === "bash") parsedArgs = { command: buf };
        else if (name === "read") parsedArgs = { file_path: buf };
        else if (name === "glob") parsedArgs = { pattern: buf };
        else if (name === "grep") parsedArgs = { pattern: buf };
        else if (name === "edit") {
          // 常见兜底：整行 "file_path\nold_string\nnew_string" 或 JSON-like 格式
          const safe: Record<string, unknown> = {};
          const p = this._safeJson(buf);
          if (p && typeof p === "object") {
            Object.assign(safe, p);
          } else {
            safe.raw_text = buf.slice(0, 2000);
          }
          // 双 alias：file_path/path，old_string/oldString，new_string/newString
          if (safe.path !== undefined && safe.file_path === undefined) safe.file_path = safe.path;
          if (safe.file_path !== undefined && safe.path === undefined) safe.path = safe.file_path;
          if (safe.old_string !== undefined && safe.oldString === undefined) safe.oldString = safe.old_string;
          if (safe.oldString !== undefined && safe.old_string === undefined) safe.old_string = safe.oldString;
          if (safe.new_string !== undefined && safe.newString === undefined) safe.newString = safe.new_string;
          if (safe.newString !== undefined && safe.new_string === undefined) safe.new_string = safe.newString;
          parsedArgs = safe;
        } else if (name === "write") {
          const safe: Record<string, unknown> = {};
          const p = this._safeJson(buf);
          if (p && typeof p === "object") Object.assign(safe, p);
          else safe.content = buf.slice(0, 20000);
          if (safe.path !== undefined && safe.file_path === undefined) safe.file_path = safe.path;
          if (safe.file_path !== undefined && safe.path === undefined) safe.path = safe.file_path;
          parsedArgs = safe;
        } else {
          parsedArgs = { raw_text: buf.slice(0, 2000) };
        }
        }
      }
    }
    // 对已知工具，无论 JSON.parse 是否成功，统一做一轮 alias 补全，
    // 确保 execute 端无论是读 path 还是 file_path 都能取到同一个值。
    if (typeof parsedArgs === "object" && parsedArgs !== null) {
      const o = parsedArgs as Record<string, unknown>;
      if (name === "edit" || name === "write" || name === "read") {
        if (o.path !== undefined && o.file_path === undefined) o.file_path = o.path;
        if (o.file_path !== undefined && o.path === undefined) o.path = o.file_path;
      }
      if (name === "edit") {
        if (o.old_string !== undefined && o.oldString === undefined) o.oldString = o.old_string;
        if (o.oldString !== undefined && o.old_string === undefined) o.old_string = o.oldString;
        if (o.new_string !== undefined && o.newString === undefined) o.newString = o.new_string;
        if (o.newString !== undefined && o.new_string === undefined) o.new_string = o.newString;
      }
    }
    yield {
      type: "tool-call" as const,
      id,
      name,
      args: parsedArgs,
    };
  }

  private _mapUsage(raw: Record<string, unknown>): Usage {
    return {
      inputTokens: (raw.prompt_tokens as number) ?? 0,
      outputTokens: (raw.completion_tokens as number) ?? 0,
      totalTokens: raw.total_tokens as number | undefined,
      reasoningTokens: (raw.reasoning_tokens as number) ?? 0,
      nonCachedInputTokens: (raw.prompt_tokens as number) ?? 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      providerMetadata: { zhipu: raw },
    };
  }

  private _buildMessages(req: LLMRequest): ZhiPuMessage[] {
    const out: ZhiPuMessage[] = [];

    // System 消息（由 assemblePrompt 注入 req.system）
    if (req.system && req.system.length > 0) {
      out.push({
        role: "system" as const,
        content: req.system.join("\n\n"),
      });
    }

    for (const m of req.messages) {
      if (m.role === "user") {
        out.push({ role: "user" as const, content: this._extractContent(m.content) });
      } else if (m.role === "assistant") {
        const msg: ZhiPuMessage = {
          role: "assistant" as const,
          content: this._extractContent(m.content),
        };
        if (Array.isArray(m.content)) {
          const toolCalls: NonNullable<ZhiPuMessage["tool_calls"]> = [];
          for (const part of m.content) {
            if (part.type === "tool_use") {
              toolCalls.push({
                id: part.id,
                type: "function" as const,
                function: {
                  name: part.name,
                  arguments: JSON.stringify(part.input),
                },
              });
            }
          }
          if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        }
        out.push(msg);
      } else if (m.role === "tool") {
        if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part.type === "tool_result") {
              out.push({
                role: "tool" as const,
                content:
                  typeof part.content === "string"
                    ? part.content
                    : JSON.stringify(part.content),
                tool_call_id: part.tool_use_id,
              });
            }
          }
        } else {
          out.push({
            role: "tool" as const,
            content: this._extractContent(m.content),
            tool_call_id: "unknown",
          });
        }
      } else if (m.role === "system") {
        out.push({ role: "system" as const, content: this._extractContent(m.content) });
      }
    }

    return out;
  }

  private _extractContent(
    content: string | import("../core/session/message.js").LLMContentPart[]
  ): string {
    if (typeof content === "string") return content;
    const parts: string[] = [];
    for (const part of content) {
      if (part.type === "text") parts.push(part.text);
      else if (part.type === "tool_result") {
        const c = part.content;
        parts.push(typeof c === "string" ? c : JSON.stringify(c));
      }
    }
    return parts.join("\n");
  }

  private _classifyHttpError(status: number, body: string): LLMError {
    if (status === 401 || status === 403) {
      return new ProviderAuthError("zhipu");
    }
    if (status === 429) {
      return new RateLimitError("zhipu");
    }
    if (/context.*(length|overflow)|prompt.*too.*long/i.test(body)) {
      return new ContextOverflowError("zhipu");
    }
    return classifyProviderError(
      new Error(`HTTP ${status}: ${body.slice(0, 200)}`),
      "zhipu"
    );
  }
}
