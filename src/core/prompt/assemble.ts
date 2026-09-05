// Prompt 组装（06）
//
// 文档 06：prompt 四部分 = System + Messages + Tools + ProviderOptions
//   System = [agent.system, baseline]（两层：人设稳定 + 环境可变走 reconcile）
//   Messages = toLLMMessages(history.selectForLLM())
//   Tools = materialize 产出的工具定义数组（按 agent 权限过滤）
//   ProviderOptions = { promptCacheKey: session id 派生 }
//
// 文档 06：缓存命根子是稳定性——agent.system 稳定、baseline 在 Updated 时不变、
//   sameModel 时复用 providerMetadata

import type { LLMMessage, LLMRequest, LLMTool, SessionMessage } from "../session/message.js";
import type { ToolDefinition } from "../tool/tool.js";
import { toLLMMessages } from "./to-llm.js";

export interface AssembleOptions {
  agentSystem: string;
  baseline: string;
  selectedMessages: SessionMessage[];
  toolDefs: ToolDefinition[];
  // ProviderOptions
  sessionId: string;
  // 模型信息（用于 sameModel 判断）
  provider?: string;
  model?: string;
  // 是否最后一个 step（注入 MAX_STEPS）
  isLastStep?: boolean;
  // toolChoice：isLastStep 时设 "none"
  maxTokens?: number;
}

export function assemblePrompt(opts: AssembleOptions): LLMRequest {
  // System：[agent.system, baseline]
  const system = [opts.agentSystem, opts.baseline].filter(Boolean);

  // Messages：toLLMMessages
  const messages: LLMMessage[] = toLLMMessages(opts.selectedMessages, {
    provider: opts.provider,
    model: opts.model,
    isLastStep: opts.isLastStep,
  });

  // Tools
  let tools: LLMTool[] | undefined;
  let toolChoice: "auto" | "none" | undefined = "auto";
  if (opts.isLastStep) {
    // 文档 03/06：达 step 上限不 materialize tools，toolChoice=none
    tools = undefined;
    toolChoice = "none";
  } else if (opts.toolDefs.length > 0) {
    tools = opts.toolDefs.map((d) => ({
      type: "function",
      function: {
        name: d.name,
        description: d.description,
        parameters: d.inputSchema,
      },
    }));
  }

  // ProviderOptions
  const providerOptions = {
    promptCacheKey: opts.sessionId,
  };

  return {
    system,
    messages,
    tools,
    toolChoice,
    providerOptions,
    maxTokens: opts.maxTokens,
    provider: opts.provider,
    model: opts.model,
  };
}
