// 工具两层注册（05）
//
// 文档 05：注册分两层
//   - ApplicationTools：进程级，所有 Location 共享
//   - ToolRegistry：Location 级，每个工作目录一个
//   - 同位置最新注册生效（栈式覆盖）
//   - Location 注册优先于 application 注册
//   - 调用开始时 capture 当时生效的工具
//
// materialize：可见性（不是授权）
//   1. 复制 application 注册
//   2. overlay 本 Location 的注册（同名覆盖）
//   3. whollyDisabled 过滤：permission 被 * → deny 的从菜单删掉
//   4. 返回 { definitions, settle }
// 可见性 ≠ 授权：菜单上没有的肯定点不了，菜单上有的还得过 assert

import type { PermissionRule } from "./permission.js";
import type {
  Tool,
  ToolDefinition,
  ToolExecuteResult,
  ToolContext,
} from "./tool.js";

interface Registration {
  name: string;
  tool: Tool;
  // 这个注册的来源 scope id（用于栈式回退）
  scopeId: number;
}

// 进程级共享工具池
export class ApplicationTools {
  private registrations: Registration[] = [];
  private nextScopeId = 0;

  register(name: string, tool: Tool, scopeId?: number): number {
    const sid = scopeId ?? this.nextScopeId++;
    this.registrations.push({ name, tool, scopeId: sid });
    return sid;
  }

  // 关闭某个 scope 只移除它自己（栈式回退）
  removeScope(scopeId: number) {
    this.registrations = this.registrations.filter(
      (r) => r.scopeId !== scopeId
    );
  }

  // 取所有 application 注册（栈式，后者覆盖同名前者）
  // 文档 05：同位置最新注册生效
  effective(): Map<string, Tool> {
    const map = new Map<string, Tool>();
    for (const r of this.registrations) {
      map.set(r.name, r.tool);
    }
    return map;
  }
}

// Location 级注册
export class ToolRegistry {
  private locationRegistrations: Registration[] = [];
  private nextScopeId = 0;

  constructor(private app: ApplicationTools) {}

  register(name: string, tool: Tool, scopeId?: number): number {
    const sid = scopeId ?? this.nextScopeId++;
    this.locationRegistrations.push({ name, tool, scopeId: sid });
    return sid;
  }

  removeScope(scopeId: number) {
    this.locationRegistrations = this.locationRegistrations.filter(
      (r) => r.scopeId !== scopeId
    );
  }

  // materialize：给模型看的菜单（不是授权）
  // permissions 是 agent ruleset，用来判断 whollyDisabled
  materialize(
    permissions: PermissionRule[]
  ): { definitions: ToolDefinition[]; settle: ToolSettleMap } {
    // 1. application 注册
    const appMap = this.app.effective();
    // 2. overlay Location 注册（同名覆盖）
    const locMap = new Map<string, Tool>();
    for (const r of this.locationRegistrations) {
      locMap.set(r.name, r.tool);
    }
    const merged = new Map<string, Tool>([...appMap, ...locMap]);

    // 3. whollyDisabled 过滤：某工具的 permission 被 resource="*" + effect="deny" 删掉
    const whollyDisabled = new Set<string>();
    for (const [name, tool] of merged) {
      const action = tool.permission(name);
      for (const rule of permissions) {
        if (
          rule.action === action &&
          rule.resource === "*" &&
          rule.effect === "deny"
        ) {
          whollyDisabled.add(name);
          break;
        }
        // 也支持 action="*"
        if (
          rule.action === "*" &&
          rule.resource === "*" &&
          rule.effect === "deny"
        ) {
          whollyDisabled.add(name);
          break;
        }
      }
    }

    const definitions: ToolDefinition[] = [];
    const settle: ToolSettleMap = new Map();
    for (const [name, tool] of merged) {
      if (whollyDisabled.has(name)) continue; // 菜单层过滤
      definitions.push(tool.definition(name));
      settle.set(name, tool);
    }
    return { definitions, settle };
  }
}

export type ToolSettleMap = Map<string, Tool>;
