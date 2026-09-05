// 通用 OpenAI 兼容 Provider
//
// 复用 ZhiPuProvider 的 OpenAI 风格 SSE 解析，只换端点 / 默认模型 / context 上限。
// 适用：DashScope compatible-mode、SiliconFlow、DeepSeek、OpenAI 官方等。
//
// 用法（bench runner）：
//   DASHSCOPE_API_KEY=xxx npx tsx src/bench/swebench-run.ts \
//     --provider openai --model qwen3-coder-plus

import { ZhiPuProvider } from "./zhipu-provider.js";

export interface OpenAICompatOptions {
  baseURL: string;
  defaultModel: string;
  // 主动压缩阈值（用于 compactIfNeeded）；不设则视为未知（禁用主动压缩）
  contextLimit?: number;
  temperature?: number;
}

export class OpenAICompatProvider extends ZhiPuProvider {
  readonly name = "openai-compat";
  protected override readonly endpoint: string;
  protected override readonly defaultModel: string;
  protected override readonly includeUsageOption = true;

  private readonly limit: number | undefined;

  constructor(apiKey: string, opts: OpenAICompatOptions) {
    super(apiKey, { temperature: opts.temperature });
    this.endpoint = opts.baseURL;
    this.defaultModel = opts.defaultModel;
    this.limit = opts.contextLimit;
  }

  listModels(): string[] {
    return [this.defaultModel];
  }

  contextLimit(_model: string): number | undefined {
    return this.limit;
  }
}
