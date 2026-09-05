// Application：整合所有顶层服务
//
// 一个 Application 实例持有：
//   - ApplicationTools（进程级共享工具池）
//   - LocationServiceMap（Location 级服务层）
//   - HookRegistry
//   - SkillRegistry
//   - CommandRegistry
//   - SnapshotStore
//   - McpRegistry
//   - PermissionService（全局，saved rules 在这里）
//   - LLMProvider（MockProvider 或 ZhiPuProvider）
//   - SessionRunCoordinator
//   - 所有 sessions

import { ApplicationTools, ToolRegistry } from "./tool/registry.js";
import { registerBuiltinTools } from "./tool/builtin.js";
import { PermissionService } from "./tool/permission.js";
import { HookRegistry } from "./hooks/hooks.js";
import { SkillRegistry } from "./skill/skill.js";
import { CommandRegistry } from "./memory/command.js";
import { SnapshotStore } from "./memory/snapshot.js";
import { McpRegistry } from "./mcp/mcp.js";
import { MockProvider } from "../provider/mock-provider.js";
import { ZhiPuProvider } from "../provider/zhipu-provider.js";
import { OpenAICompatProvider } from "../provider/openai-provider.js";
import type { LLMProvider } from "../provider/llm.js";
import { SessionRunCoordinator } from "./agent/coordinator.js";
import { Session, createSessionId } from "./session/session.js";
import { SessionHistory } from "./session/history.js";
import { SystemContext } from "./context/system-context.js";
import {
  makeDateSource,
  makeEnvironmentSource,
  makeInstructionsSource,
  makeSkillGuidanceSource,
} from "./context/sources.js";
import { builtinAgents, type AgentConfig, type LocationRef, LocationServiceMap } from "./remote/location.js";
import type { TurnEvent } from "./agent/turn.js";
import { loadAgentsMdFiles } from "./memory/agents-md.js";

export interface AppOptions {
  cwd: string;
  workspaceRoot?: string;
  globalConfigDir?: string;
  model?: string;
  defaultAgent?: string;
  // 真实模型配置
  provider?: "mock" | "zhipu" | "openai";
  apiKey?: string;
  // provider === "openai" 时的 OpenAI 兼容端点与默认模型
  baseURL?: string;
  // 采样温度（zhipu）：不设用 provider 默认
  temperature?: number;
  // 覆盖 agent 步数上限（benchmark 场景需要比内置 50 步更多）
  maxSteps?: number;
}

export class Application {
  readonly appTools = new ApplicationTools();
  readonly permission = new PermissionService();
  readonly hooks = new HookRegistry();
  readonly skills = new SkillRegistry();
  readonly commands = new CommandRegistry();
  readonly snapshots = new SnapshotStore();
  readonly mcp = new McpRegistry();
  readonly provider: LLMProvider;
  readonly coordinator = new SessionRunCoordinator();
  readonly locationMap = new LocationServiceMap();

  private sessions = new Map<string, Session>();
  private agents: AgentConfig[];
  private opts: AppOptions;

  constructor(opts: AppOptions) {
    this.opts = opts;
    this.agents = builtinAgents();
    this.locationMap.startIdleSweeper();

    // 选择 provider
    const providerType = opts.provider ?? "mock";
    if (providerType === "zhipu" && opts.apiKey) {
      this.provider = new ZhiPuProvider(opts.apiKey, { temperature: opts.temperature });
    } else if (providerType === "openai" && opts.apiKey) {
      this.provider = new OpenAICompatProvider(opts.apiKey, {
        baseURL: opts.baseURL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        defaultModel: opts.model ?? "qwen3-coder-plus",
        contextLimit: 262144,
        temperature: opts.temperature,
      });
    } else {
      this.provider = new MockProvider();
    }

    // 设置默认 agent 的权限
    const defaultAgentId = opts.defaultAgent ?? "build";
    const agent = this.agents.find((a) => a.id === defaultAgentId) ?? this.agents[0];
    this.permission.setAgentRules(agent.permissions);
  }

  getAgents(): AgentConfig[] {
    return this.agents;
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.agents.find((a) => a.id === id);
  }

  async createSession(options: {
    agentId?: string;
    onEvent?: (e: TurnEvent) => void;
  } = {}): Promise<Session> {
    const agentId = options.agentId ?? this.opts.defaultAgent ?? "build";
    const agent = this.getAgent(agentId) ?? this.agents[0];

    this.permission.setAgentRules(agent.permissions);

    const registry = new ToolRegistry(this.appTools);
    registerBuiltinTools(registry);

    const ctx = new SystemContext();
    ctx.register(makeEnvironmentSource({ cwd: this.opts.cwd, workspaceRoot: this.opts.workspaceRoot }));
    ctx.register(makeDateSource());
    ctx.register(
      makeInstructionsSource({
        cwd: this.opts.cwd,
        globalConfigDir: this.opts.globalConfigDir,
      })
    );
    ctx.register(
      makeSkillGuidanceSource(async () => {
        const all = this.skills.listSkills();
        if (agentId === "plan") return [];
        return all;
      })
    );

    const sessionId = createSessionId();
    const history = new SessionHistory();

    // 根据 provider 确定默认 model
    const defaultModel =
      this.opts.model ??
      (this.provider instanceof ZhiPuProvider ? "glm-4-flash" : "mock-large");

    const session = new Session({
      sessionId,
      history,
      ctx,
      agent: this.opts.maxSteps ? { ...agent, steps: this.opts.maxSteps } : agent,
      registry,
      permission: this.permission,
      provider: this.provider,
      model: defaultModel,
      cwd: this.opts.cwd,
      coordinator: this.coordinator,
      onEvent: options.onEvent ?? (() => {}),
    });

    this.sessions.set(sessionId, session);

    const ref: LocationRef = {
      directory: this.opts.cwd,
      workspaceID: sessionId,
    };
    this.locationMap.set(ref, { session, registry, ctx });

    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  getCwd(): string {
    return this.opts.cwd;
  }

  setAskHandler(handler: (req: import("./tool/permission.js").PendingRequest) => Promise<import("./tool/permission.js").Reply>) {
    this.permission.setAskHandler(handler);
  }
}
