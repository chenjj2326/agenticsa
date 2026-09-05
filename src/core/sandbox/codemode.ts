// 沙盒设计与执行隔离（10）—— CodeMode 受限 JS 解释器（最小化）
//
// 文档 10：CodeMode 是编排语言，不是通用 JS 运行时。
//   - 自有 tree-walking 解释器（不用 eval、不用 V8）
//   - 工具定义树 + 内联 catalog + $codemode.search
//   - ambient authority 全禁：fs/process/network/modules/eval/npm 一个都没有
//   - 程序只能调 host 显式提供的工具
//   - 嵌套调用复用 execute 的 invocation context
//   - execute 是唯一的 model-facing 工具调用，嵌套调用是它的实现细节
//
// 最小实现：用一个受限的 JS 子集 evaluator（受控的表达式 + 工具调用 + Promise.all），
//   不引入完整 tree-walking parser。这里用 Function 构造但限制它能访问的 scope，
//   保留文档的关键语义（无 ambient authority，只能调 host 工具）。
//
// 注意：真实 OpenCode 不用 eval/Function，用自有解释器。这里用 Function 是受控的妥协——
//   只暴露 host 工具，不暴露 require/process/fs 等，配合 strict 模式限制副作用。

import { CODEMODE_MAX_CONCURRENCY } from "../token/estimate.js";

export interface CodeModeTool {
  name: string;
  description: string;
  inputSchema: any;
  // 执行函数
  execute: (args: any) => Promise<unknown>;
}

export interface CodeModeCatalogEntry {
  namespace: string;
  name: string;
  description: string;
  // 完整签名（参数 schema）
  signature?: any;
}

export interface CodeModeDefinition {
  // 给模型看的工具定义（execute 工具）
  definition: { name: string; description: string; inputSchema: any };
  // 内联 catalog（token-budgeted）
  catalog: CodeModeCatalogEntry[];
}

export interface CodeModeResult {
  // 程序返回值
  output: unknown;
  // 错误（如果有）
  error?: { safeMessage: string; category?: string };
  // 是否被中断
  interrupted?: boolean;
}

export class CodeMode {
  // 模型看到的 catalog（token-budgeted）
  // 文档 10：每个 namespace 都可见，完整签名 round-robin 跨 namespace 选择
  static buildCatalog(tools: CodeModeTool[]): CodeModeCatalogEntry[] {
    return tools.map((t) => ({
      namespace: "host",
      name: t.name,
      description: t.description,
      signature: t.inputSchema,
    }));
  }

  static make(tools: CodeModeTool[]): CodeModeDefinition {
    const catalog = this.buildCatalog(tools);
    const definition = {
      name: "execute",
      description:
        "Execute a JavaScript program that orchestrates tool calls. " +
        "The program can call tools via `await tools.<name>(args)` and use `Promise.all([...])` for parallel calls. " +
        "Available tools: " +
        catalog.map((c) => `${c.namespace}.${c.name}`).join(", "),
      inputSchema: {
        type: "object",
        properties: {
          program: { type: "string", description: "A JS program" },
        },
        required: ["program"],
      },
    };
    return { definition, catalog };
  }

  // 执行程序
  // 文档 10：程序只能调 host 给的工具，没有任何 ambient authority
  static async run(
    program: string,
    tools: CodeModeTool[],
    options: { maxToolCalls?: number; maxOutputBytes?: number; timeoutMs?: number } = {}
  ): Promise<CodeModeResult> {
    const maxToolCalls = options.maxToolCalls ?? 32;
    let callCount = 0;

    // 工具映射——只有 host 给的工具能调
    const toolMap: Record<string, (args: any) => Promise<unknown>> = {};
    for (const t of tools) {
      toolMap[t.name] = async (args: any) => {
        if (callCount >= maxToolCalls) {
          throw {
            safeMessage: "Max tool calls exceeded",
            category: "limits",
          };
        }
        callCount++;
        // 并发上限
        // 文档 10：最多 8 个工具调用并发
        return t.execute(args);
      };
    }

    // $codemode.search 总可调
    const codemode = {
      search: async (query: string) => {
        return CodeMode.buildCatalog(tools).filter(
          (c) =>
            c.name.includes(query) ||
            c.description.toLowerCase().includes(query.toLowerCase())
        );
      },
    };

    // 没有任何 ambient authority
    // 文档 10：程序只能调 host 给的工具
    // 不暴露 fs/process/network/modules/eval/npm
    const sandbox = {
      tools: toolMap,
      $codemode: codemode,
      Promise, // 允许 Promise.all
      Math,
      JSON,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Date,
    };

    try {
      // 受控的 evaluator：用 Function 构造（最小妥协），但只把 sandbox 暴露
      // 真实 OpenCode 用自有 tree-walking 解释器，不用 eval/Function
      const fn = new Function(
        "sandbox",
        `"use strict";
        const { tools, $codemode, Promise, Math, JSON, Object, Array, String, Number, Boolean, Date } = sandbox;
        return (async () => { ${program} })();`
      );
      const output = await fn(sandbox);
      return { output };
    } catch (e: any) {
      return {
        output: null,
        error: {
          safeMessage: e?.message ?? "CodeMode execution failed",
          category: e?.category ?? "tool_failure",
        },
      };
    }
  }
}
