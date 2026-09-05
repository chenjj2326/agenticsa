// Hooks 插件钩子系统（12）—— 最小化
//
// 文档 12：
//   - 插件 = (input, options) => Promise<Hooks>
//   - 约 20 种钩子（生命周期/认证/工具/聊天/权限命令/会话）
//   - trigger 的 pipeline 模式：(input, output) => Promise<void>，output 可变
//   - 内部插件（CodexAuth/CopilotAuth 等）+ 外部插件（npm/文件）
//   - EffectBridge：跨范式桥接（captureSync + attachWith）

export type HookName =
  | "dispose"
  | "config"
  | "event"
  | "auth"
  | "provider"
  | "tool"
  | "tool.execute.before"
  | "tool.execute.after"
  | "tool.definition"
  | "chat.message"
  | "chat.params"
  | "chat.headers"
  | "messages.transform"
  | "system.transform"
  | "text.complete"
  | "permission.ask"
  | "command.execute.before"
  | "shell.env"
  | "session.compacting"
  | "compaction.autocontinue"
  | "small_model"
  | "session.small_model";

export type HookHandler<I, O> = (input: I, output: O) => Promise<void>;

export interface Hooks {
  [name: string]: HookHandler<any, any>;
}

export type Plugin = (input: unknown, options: unknown) => Promise<Hooks>;

export class HookRegistry {
  private plugins: Array<{ name: string; hooks: Hooks }> = [];

  async loadPlugin(name: string, plugin: Plugin, input?: unknown, options?: unknown): Promise<void> {
    const hooks = await plugin(input, options);
    this.plugins.push({ name, hooks });
  }

  // trigger：pipeline 模式
  // 文档 12：钩子顺序执行，每个可修改 output，形成 pipeline 返回最终值
  async trigger<I, O>(hookName: HookName, input: I, initialOutput: O): Promise<O> {
    let output = initialOutput;
    for (const plugin of this.plugins) {
      const handler = plugin.hooks[hookName];
      if (handler) {
        await handler(input, output);
        // output 是同一引用，handler 已就地修改
      }
    }
    return output;
  }
}

// EffectBridge（12）—— 跨范式桥接
// 文档 12：插件 callback 是 Promise 风格 JS 代码但要在 Effect runtime 里执行。
//   captureSync + attachWith 解决——捕获 fiber 的 instance + workspace context。
//
// 最小实现：这里没有真 Effect runtime，桥接退化为"无操作"——
//   Promise 直接被 await，ALS 用 NodeAsyncLocalStorage 替代。
import { AsyncLocalStorage } from "node:async_hooks";

export const workspaceALS = new AsyncLocalStorage<{
  workspaceID?: string;
  directory?: string;
}>();

export class EffectBridge {
  // promise：跑 Effect 拿 Promise（这里直接返回 Promise）
  static promise<T>(p: Promise<T>): Promise<T> {
    return p;
  }

  // bind：包同步 JS 函数（让它能 await Promise）
  static bind<A extends any[], R>(
    fn: (...args: A) => R | Promise<R>
  ): (...args: A) => Promise<R> {
    return async (...args: A) => {
      return await fn(...args);
    };
  }
}
