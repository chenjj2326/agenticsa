// Task 子代理任务（12/16）—— 最小化
//
// 文档 12/16：
//   - 主代理通过 Task 工具启动子代理
//   - 参数：subagent_type + description + prompt + task_id（resume）/ background
//   - 深度限制 subagent_depth 默认 1 防无限嵌套
//   - 权限派生 deriveSubagentSessionPermission
//   - 前台模式（默认）阻塞等子代理完成返回 <task_result>
//   - 后台模式（experimental）异步启动立即返回 <task state="running"> + onPromote
//   - resume 用 task_id 续之前的子代理 session

import type { ToolImpl } from "../tool/tool.js";
import { makeTool } from "../tool/tool.js";
import type { SessionHistory } from "../session/history.js";
import type { PermissionRule } from "../tool/permission.js";
import { runSession } from "../agent/runner.js";
import type { AgentConfig } from "../remote/location.js";

export interface TaskOptions {
  // 父 session 的 history（用来拿 task_id）
  parentHistory: SessionHistory;
  // 子代理的 agent registry（按 subagent_type 取配置）
  agents: Map<string, AgentConfig>;
  // 当前 depth（防递归）
  depth: number;
  maxDepth: number;
  // 父 session 的权限（用于派生）
  parentPermissions: PermissionRule[];
  // session 工厂（创建子代理 session）
  createSession: (cfg: AgentConfig) => Promise<{
    sessionId: string;
    history: SessionHistory;
    run: () => Promise<void>;
  }>;
  // 父 session id（用于权限隔离）
  parentSessionId: string;
  // 当前 cwd
  cwd: string;
}

// deriveSubagentSessionPermission（16）
// 文档 16：从父 session 权限派生子代理权限。
//   继承父 session 的 deny 规则 + external_directory 规则；默认 deny todowrite + task（防递归）。
export function deriveSubagentSessionPermission(
  parent: PermissionRule[],
  child: PermissionRule[]
): PermissionRule[] {
  const inherited = parent.filter(
    (r) =>
      // 继承父的 deny 和 external_directory 规则
      r.effect === "deny" ||
      r.action === "external_directory"
  );
  // 默认 deny todowrite + task（防递归嵌套）
  const denyTask: PermissionRule[] = [
    { action: "todowrite", resource: "*", effect: "deny" },
    { action: "task", resource: "*", effect: "deny" },
  ];
  // 子代理自己 ruleset 显式允许的可以覆盖
  const childAllows = child.filter((r) => r.effect === "allow");
  return [...inherited, ...denyTask, ...childAllows];
}

export function makeTaskTool(opts: TaskOptions): ReturnType<typeof makeTool> {
  const impl: ToolImpl = {
    description:
      "Delegate a subtask to a specialized subagent (general, explore, etc.). " +
      "Returns <task_result> when complete (foreground) or <task state='running'> (background).",
    inputSchema: {
      type: "object",
      properties: {
        subagent_type: { type: "string", description: "Agent type: general / explore / custom" },
        description: { type: "string", description: "3-5 word label for UI tab" },
        prompt: { type: "string", description: "Task description" },
        task_id: { type: "string", description: "Resume a previous subagent session" },
        background: { type: "boolean", description: "Run in background (experimental)" },
      },
      required: ["description", "prompt"],
    },
    async execute(args: any, ctx) {
      await ctx.assert("task", [args?.subagent_type ?? "*"], {
        type: "tool",
        messageID: ctx.messageID,
      });

      // 深度检查（双重防递归：权限层 + 深度层）
      // 文档 16：subagent_depth 默认 1
      if (opts.depth + 1 > opts.maxDepth) {
        return `Subagent depth limit exceeded (current: ${opts.depth}, max: ${opts.maxDepth}). Cannot delegate further.`;
      }

      const agentType = args?.subagent_type ?? "general";
      const agent = opts.agents.get(agentType);
      if (!agent) {
        return `Unknown subagent type: ${agentType}. Available: ${Array.from(opts.agents.keys()).join(", ")}`;
      }

      const description = args?.description ?? "subagent task";
      const prompt = args?.prompt;
      const background = args?.background ?? false;

      // 创建子代理 session
      const childSession = await opts.createSession(agent);
      // 注入 user 消息
      const { makeUserMessage } = await import("../session/input.js");
      const userMsg = makeUserMessage(prompt);
      childSession.history.admitQueue(userMsg);

      // 权限派生
      const derived = deriveSubagentSessionPermission(
        opts.parentPermissions,
        agent.permissions ?? []
      );

      if (background) {
        // 后台模式：异步启动，立即返回
        // 文档 12：onPromote 完成时通知父代理注入 <task_result>
        void childSession.run().catch(() => {});
        return `<task state="running" task_id="${childSession.sessionId}">\nBackground task started. Do not poll for status — you'll be notified on completion.\n</task>`;
      }

      // 前台模式：阻塞等子代理完成
      // 文档 12：前台用 acquireUseRelease + raceFirst（等完成 vs 等提升）
      await childSession.run();

      // 取子代理的最后一条 assistant 消息作为结果
      const lastAssistant = childSession.history.latestAssistant();
      const resultText = lastAssistant
        ? lastAssistant.parts
            .map((p) => (p.type === "text" ? p.text : ""))
            .join("")
        : "(subagent produced no output)";

      return `<task_result task_id="${childSession.sessionId}" description="${description}">\n${resultText}\n</task_result>`;
    },
    permissionAction: "task",
  };
  return makeTool(impl);
}
