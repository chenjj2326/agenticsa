// 工具系统（05）—— Tool 抽象 + opaque 值
//
// 文档 05：一个工具是一个 opaque（不透明）值——对外是个 frozen 空壳，
// 真正的实现细节（input/output codec、executor、给模型看的 definition、权限 action）
// 都藏在 WeakMap 里私有保管。
//
// 三个核心操作：
//   - definition(name)：派生给模型看的工具定义（缓存）
//   - settle(call, context)：执行一次调用——decode 输入 → execute → encode 输出 → 组装模型可见内容
//   - permission(tool, name)：返回这个工具的权限 action

// 工具输入输出 schema（最小实现：JSON object）
export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

// 工具的执行上下文：包含权限决策、工具集等
export interface ToolContext {
  // 权限决策函数：工具内部调 assert
  assert: (action: string, resources: string[], source?: unknown) => Promise<void>;
  // 当前 message id / call id（用于权限 source）
  messageID?: string;
  // 工具调用日志（外层用）
  log?: (msg: string) => void;
}

// 工具执行结果
export interface ToolExecuteResult {
  // 模型可见的内容（text 或 file）——已经过 ToolOutputStore bound
  modelOutput: unknown;
  // 错误（如果有，是显式 ToolFailure，模型能看到）
  failure?: { safeMessage: string; category?: string };
}

// 工具定义（给模型看的）
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

// 工具实现接口
export interface ToolImpl {
  description: string;
  inputSchema: ToolSchema;
  // execute 返回 raw 输出（外层负责 bound）
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
  // 权限 action（默认用注册名，edit/write/apply_patch 共享 "edit"）
  permissionAction?: string;
  // 从 raw 输出组装模型可见内容（默认走 ToolOutputStore bound）
  toModelOutput?: (raw: unknown) => unknown;
}

// 工具 opaque 值的对外形状
export interface Tool {
  readonly _opaque: unique symbol;
  // 唯一暴露的三个操作
  definition(name: string): ToolDefinition;
  settle(
    call: { id: string; name: string; args: unknown },
    ctx: ToolContext
  ): Promise<ToolExecuteResult>;
  permission(name: string): string;
}

// WeakMap 私有保管 runtime（文档 05）
const _runtime = new WeakMap<object, ToolImpl>();

// 工具名校验：字母开头、64 字符内、只含字母数字下划线短横
export function isValidToolName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);
}

// 工具创建工厂
export function makeTool(impl: ToolImpl): Tool {
  // frozen 空壳
  const shell: any = {};
  _runtime.set(shell, impl);

  const definition = (name: string): ToolDefinition => {
    if (!isValidToolName(name)) {
      throw new Error(`Invalid tool name: ${name}`);
    }
    return {
      name,
      description: impl.description,
      inputSchema: impl.inputSchema,
    };
  };

  const settle = async (
    call: { id: string; name: string; args: unknown },
    ctx: ToolContext
  ): Promise<ToolExecuteResult> => {
    try {
      const raw = await impl.execute(call.args, ctx);
      const modelOutput = impl.toModelOutput
        ? impl.toModelOutput(raw)
        : raw;
      return { modelOutput };
    } catch (e: any) {
      // ToolFailure：显式通道，模型能看到的安全消息
      if (e?.safeMessage) {
        return {
          modelOutput: null,
          failure: {
            safeMessage: e.safeMessage,
            category: e.category,
          },
        };
      }
      // 未知失败 sanitize：不暴露私有原因
      return {
        modelOutput: null,
        failure: {
          safeMessage: "Tool execution failed",
          category: "tool_failure",
        },
      };
    }
  };

  const permission = (name: string): string => {
    return impl.permissionAction ?? name;
  };

  // frozen + 不可枚举 runtime（先赋值再 freeze）
  shell.definition = definition;
  shell.settle = settle;
  shell.permission = permission;
  shell._opaque = Symbol("opaque");
  Object.freeze(shell);
  return shell as Tool;
}

// 装饰器：只改权限 action 不改执行
export function withPermission(tool: Tool, action: string): Tool {
  const impl = _runtime.get(tool as any);
  if (!impl) throw new Error("invalid tool");
  return makeTool({ ...impl, permissionAction: action });
}
