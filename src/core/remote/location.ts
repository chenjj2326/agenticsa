// Coordinator/Swarm 多代理协作（16）+ Remote（17）—— 最小化
//
// 文档 16：层级委托式（不是无中心 swarm）。主代理通过 Task 工具委托子代理。
//   - 7 种内置 agent：build/plan/general/explore/compaction/title/summary
//   - mode：primary（可直接选为主 agent）/ subagent（不可直接选，强制委托语义）/ all
//   - 权限是 agent 级能力边界
//   - Coordinator 跨 session 并发
//
// 文档 17：LocationServiceMap + WorkspaceRouting + ACP（最小化：单 location）

// --- Agent 配置 ---
export interface AgentConfig {
  id: string; // 默认 "build"
  mode: "primary" | "subagent" | "all";
  system: string; // agent.system 人设
  permissions: PermissionRule[];
  // agent 步数上限
  steps?: number;
  // 是否 hidden
  hidden?: boolean;
}

import type { PermissionRule } from "../tool/permission.js";

// 7 种内置 agent（16）
export function builtinAgents(): AgentConfig[] {
  return [
    {
      id: "build",
      mode: "primary",
      system: `You are a primary coding agent. You can read, write, edit, and run commands.
You have full permissions. Use tools to investigate and modify the codebase.
Always summarize what you did at the end.`,
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      steps: 50,
    },
    {
      id: "plan",
      mode: "primary",
      system: `You are a planning agent. You can read files but cannot edit them.
You produce a plan in .opencode/plans/*.md. Do not execute code changes.`,
      permissions: [
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "bash", resource: "*", effect: "deny" },
        { action: "task.general", resource: "*", effect: "deny" },
      ],
      steps: 30,
    },
    {
      id: "general",
      mode: "subagent",
      system: `You are a general-purpose subagent. You can do multi-step research and execute tasks.`,
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "todowrite", resource: "*", effect: "deny" },
      ],
      steps: 20,
    },
    {
      id: "explore",
      mode: "subagent",
      system: `You are an exploration subagent. You can only read and search, never write.
Return concise findings.`,
      permissions: [
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "bash", resource: "*", effect: "allow" }, // 只读命令
        { action: "webfetch", resource: "*", effect: "allow" },
        { action: "websearch", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "write", resource: "*", effect: "deny" },
        { action: "external_directory", resource: "*", effect: "deny" },
      ],
      steps: 15,
    },
    {
      id: "compaction",
      mode: "primary",
      hidden: true,
      system: `You are a compaction agent. You generate structured summaries.`,
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
      steps: 5,
    },
    {
      id: "title",
      mode: "primary",
      hidden: true,
      system: `You are a title agent. You generate short titles.`,
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
      steps: 1,
    },
    {
      id: "summary",
      mode: "primary",
      hidden: true,
      system: `You are a summary agent. You generate session summaries.`,
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
      steps: 5,
    },
  ];
}

// selectable：primary/all（subagent 不可直接选）
export function selectableAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.filter((a) => a.mode !== "subagent" && !a.hidden);
}

// --- LocationServiceMap（17）---
// 文档 17：每个 Location（directory + workspaceID）有自己的一套独立服务层
//   idle 60 分钟自动回收
// 最小实现：单 location 进程内
export interface LocationRef {
  directory: string;
  workspaceID: string;
}

export class LocationServiceMap {
  private locations = new Map<string, any>();
  private idleSince = new Map<string, number>();
  private idleTTL = 60 * 60 * 1000; // 60 分钟

  get(ref: LocationRef): any | null {
    const key = this.key(ref);
    const svc = this.locations.get(key);
    this.idleSince.set(key, Date.now());
    return svc ?? null;
  }

  set(ref: LocationRef, services: any) {
    const key = this.key(ref);
    this.locations.set(key, services);
    this.idleSince.set(key, Date.now());
  }

  private key(ref: LocationRef): string {
    return `${ref.directory}\0${ref.workspaceID}`;
  }

  // idle 回收
  startIdleSweeper() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, since] of this.idleSince) {
        if (now - since > this.idleTTL) {
          this.locations.delete(key);
          this.idleSince.delete(key);
        }
      }
    }, 10 * 60 * 1000).unref?.();
  }
}

// --- WorkspaceRouting（17）---
// 文档 17：HTTP 中间件四态——InvalidWorkspace / MissingWorkspace / Local / Remote
export type RequestPlan =
  | { _tag: "invalid_workspace" }
  | { _tag: "missing_workspace" }
  | { _tag: "local"; directory: string; workspaceID: string }
  | { _tag: "remote"; url: string };

// --- Fence 同步（17）---
// 文档 17：远程代理不直接透传，等 Fence 同步完成才返回，防读到不一致状态
export class Fence {
  private pending = new Map<string, Promise<void>>();

  wait(workspaceID: string): Promise<void> | null {
    return this.pending.get(workspaceID) ?? null;
  }

  signal(workspaceID: string) {
    // 立即 resolve（最小实现）
  }
}
