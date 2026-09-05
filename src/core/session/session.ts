// Session：整合所有模块（02/03/05/06/15）
//
// 一个 Session 持有：history / SystemContext / Epoch / ToolRegistry / PermissionService / agent config
// 提供：admitInput（admit 写一行 + wake）/ run（drain）/ sendUsageUpdate 等

import { SessionHistory } from "./history.js";
import type { AgentConfig } from "../remote/location.js";
import type { SystemContext } from "../context/system-context.js";
import type { Epoch } from "../context/epoch.js";
import type { PermissionService, PermissionRule } from "../tool/permission.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { LLMProvider } from "../../provider/llm.js";
import type { SessionRunCoordinator } from "../agent/coordinator.js";
import { runSession } from "../agent/runner.js";
import type { TurnEvent } from "../agent/turn.js";
import type { DeliveryMode } from "./input.js";
import { genId } from "./message.js";
import { aggregateSessionUsage, totalSessionCost } from "../cost/usage.js";

export interface SessionDeps {
  sessionId: string;
  history: SessionHistory;
  ctx: SystemContext;
  agent: AgentConfig;
  registry: ToolRegistry;
  permission: PermissionService;
  provider: LLMProvider;
  model: string;
  cwd: string;
  coordinator: SessionRunCoordinator;
  onEvent: (e: TurnEvent) => void;
}

export class Session {
  readonly sessionId: string;
  readonly history: SessionHistory;
  readonly ctx: SystemContext;
  readonly agent: AgentConfig;
  readonly registry: ToolRegistry;
  readonly permission: PermissionService;
  readonly provider: LLMProvider;
  readonly model: string;
  readonly cwd: string;
  private coordinator: SessionRunCoordinator;
  private onEvent: (e: TurnEvent) => void;
  private epoch: Epoch | null = null;

  // abort controller（用户中断）
  private currentAbort: AbortController | null = null;

  // 最近一次 drain 的错误（wake/resume 里 void run() 吞掉的——防 unhandled rejection 崩进程）
  private lastDrainError: unknown = null;

  constructor(deps: SessionDeps) {
    this.sessionId = deps.sessionId;
    this.history = deps.history;
    this.ctx = deps.ctx;
    this.agent = deps.agent;
    this.registry = deps.registry;
    this.permission = deps.permission;
    this.provider = deps.provider;
    this.model = deps.model;
    this.cwd = deps.cwd;
    this.coordinator = deps.coordinator;
    this.onEvent = deps.onEvent;
  }

  // admit：用户发消息 → 只持久化成一行（只记录不执行）→ 唤醒执行器
  // 文档 03：steer/queue 二分；wake 退化为 bool
  async admitInput(text: string, delivery: DeliveryMode = "queue"): Promise<void> {
    const { makeUserMessage } = await import("./input.js");
    const msg = makeUserMessage(text);
    if (delivery === "steer") {
      this.history.admitSteer(msg);
    } else {
      this.history.admitQueue(msg);
    }
    // 唤醒执行器
    await this.wake();
  }

  // wake：唤醒执行器
  // 文档 03：当前在跑就标记 pendingWake，不在跑就启动 drain
  async wake(): Promise<void> {
    const result = this.coordinator.wake(this.sessionId, () => this.drain());
    if (result === "started") {
      // 不在跑——启动新 drain
      // 错误存 lastDrainError（不吞、也不让 unhandled rejection 崩进程）
      void this.coordinator.run(this.sessionId, () => this.drain()).catch((e) => {
        this.lastDrainError = e;
      });
    }
    // pending：标记了，等当前 drain 结束会再跑一轮
  }

  // drain 错误通道：drain 异步结束后调用方可查询（读一次即清）
  getDrainError(): unknown {
    const e = this.lastDrainError;
    this.lastDrainError = null;
    return e;
  }

  // drain：实际跑 Runner.run
  private async drain(): Promise<void> {
    this.currentAbort = new AbortController();
    try {
      const result = await runSession({
        sessionId: this.sessionId,
        history: this.history,
        ctx: this.ctx,
        provider: this.provider,
        model: this.model,
        agentSystem: this.agent.system,
        agentPermissions: this.agent.permissions,
        registry: this.registry,
        permission: this.permission,
        cwd: this.cwd,
        maxSteps: this.agent.steps,
        onEvent: this.onEvent,
        signal: this.currentAbort.signal,
        force: false,
      });
      this.epoch = result.epoch;
    } finally {
      this.currentAbort = null;
    }
  }

  // interrupt：用户中断
  // 文档 03：用户 explicit 取消
  interrupt(): void {
    this.coordinator.interrupt(this.sessionId);
    if (this.currentAbort) {
      this.currentAbort.abort();
    }
  }

  // 主动 resume（force 模式）
  // 文档 03：force 模式即使没 pending 也跑一个 turn
  async resume(): Promise<void> {
    void this.coordinator.run(this.sessionId, async () => {
      this.currentAbort = new AbortController();
      try {
        const result = await runSession({
          sessionId: this.sessionId,
          history: this.history,
          ctx: this.ctx,
          provider: this.provider,
          model: this.model,
          agentSystem: this.agent.system,
          agentPermissions: this.agent.permissions,
          registry: this.registry,
          permission: this.permission,
          cwd: this.cwd,
          maxSteps: this.agent.steps,
          onEvent: this.onEvent,
          signal: this.currentAbort.signal,
          force: true,
        });
        this.epoch = result.epoch;
      } finally {
        this.currentAbort = null;
      }
    }).catch((e) => {
      this.lastDrainError = e;
    });
  }

  // 成本聚合（15）
  getCost(): number {
    return totalSessionCost(this.history);
  }

  getUsage() {
    return aggregateSessionUsage(this.history);
  }

  getEpoch(): Epoch | null {
    return this.epoch;
  }
}

// 创建一个 session（生成 id）
export function createSessionId(): string {
  return `session_${genId("s")}`;
}
