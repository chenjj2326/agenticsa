// LLM 抽象（06/15）
//
// 文档 06/15：provider 流式调用，事件类型——text-delta / reasoning-delta / tool-call / finish / error
//
// 文档 14：compactIfNeeded 估算整个 LLMRequest（system + messages + tools）
//   超过 context - max(output, buffer) 就压
// 文档 14：被动压缩——provider 返回 overflow 错误且 assistant 还没开始输出时，压一次重试，只重试一次

import type { LLMEvent, LLMRequest, Usage } from "../core/session/message.js";

export interface LLMProvider {
  name: string;
  // 流式调用
  stream(req: LLMRequest, signal?: AbortSignal): AsyncIterable<LLMEvent>;
  // 模型的 context window 大小（用于 compactIfNeeded）
  contextLimit(model: string): number | undefined;
  // 当前 provider 可用的模型列表
  listModels(): string[];
}
