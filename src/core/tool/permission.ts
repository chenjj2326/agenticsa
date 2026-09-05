// 权限链（05）
//
// 文档 05：三态权限 allow / deny / ask（默认 ask）
//   - allow → 直接执行
//   - deny → 直接拒绝（BlockedError）
//   - ask → publish Asked 事件，await deferred，等用户回复
//
// 三个规则来源：
//   1. agent.permissions（agent 配置，build 全开 plan 受限）
//   2. 用户"总是允许"保存的 approved 规则
//   3. 默认全拒
//
// 两个级联：
//   - 拒绝级联：拒绝一个就拒绝同 session 所有 pending（偏安全）
//   - always 级联 resolve：用户说"总是允许 X"后，所有匹配 X 的 pending 自动通过（偏体验）
//
// isUserDeclined → halt 整个 loop（不让模型绕过用户意志）

import { Deferred } from "../effect/runtime.js";
import { BlockedError, DeclinedError, CorrectedError } from "../error/errors.js";

// 权限规则
export interface PermissionRule {
  action: string; // "bash" / "edit" / "read" / "*" 等
  resource: string; // "*" 或具体资源（命令、路径）
  effect: "allow" | "deny" | "ask";
}

// 一组规则的集合
export interface RuleSet {
  rules: PermissionRule[];
}

export type PermissionEffect = "allow" | "deny" | "ask";

// pending request：等用户回复
export interface PendingRequest {
  id: string;
  action: string;
  resources: string[];
  deferred: Deferred<void>;
  createdAt: number;
}

// 用户回复
export type Reply =
  | { type: "allow" }
  | { type: "reject"; feedback?: string }
  | { type: "always"; save: PermissionRule };

// evaluate：合并 agent permissions + saved rules，算出 effect
// 文档 05：findLast 找最后一条匹配（action + resource 都支持通配符），没匹配到默认 ask
// 多个 resource 时：有 deny 就是 deny，有 ask 就是 ask，否则 allow
function matchRule(rule: PermissionRule, action: string, resource: string): boolean {
  const matchGlob = (pattern: string, s: string) => {
    if (pattern === "*") return true;
    // 简单通配符：* 匹配任意
    const re = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
    );
    return re.test(s);
  };
  return matchGlob(rule.action, action) && matchGlob(rule.resource, resource);
}

function evaluateOne(rs: RuleSet, action: string, resource: string): PermissionEffect {
  // findLast：最后一条匹配的生效
  let matched: PermissionRule | undefined;
  for (const rule of rs.rules) {
    if (matchRule(rule, action, resource)) {
      matched = rule;
    }
  }
  return matched?.effect ?? "ask";
}

// 多个 resource：有 deny 就是 deny，有 ask 就是 ask，否则 allow
export function evaluate(
  rs: RuleSet,
  action: string,
  resources: string[]
): PermissionEffect {
  if (resources.length === 0) resources = ["*"];
  let hasAsk = false;
  for (const r of resources) {
    const e = evaluateOne(rs, action, r);
    if (e === "deny") return "deny";
    if (e === "ask") hasAsk = true;
  }
  return hasAsk ? "ask" : "allow";
}

// Permission Service：管理 pending request、saved rules、级联
export class PermissionService {
  // agent permissions
  private agentRules: RuleSet = { rules: [] };
  // saved rules（用户"总是允许"持久化，按 project 隔离——这里简化为单一 set）
  private savedRules: RuleSet = { rules: [] };
  // pending requests（按 session 隔离）
  private pendingBySession = new Map<string, PendingRequest[]>();
  // 用户回复的 hook（CLI 用）
  private askHandler:
    | ((req: PendingRequest) => Promise<Reply>)
    | null = null;

  setAgentRules(rules: PermissionRule[]) {
    this.agentRules = { rules };
  }

  setSavedRules(rules: PermissionRule[]) {
    this.savedRules = { rules };
  }

  setAskHandler(handler: (req: PendingRequest) => Promise<Reply>) {
    this.askHandler = handler;
  }

  // 合并 agent + saved（saved 优先级更高，因为它在 agent 之后追加）
  private mergedRules(): RuleSet {
    // 文档 05：合并三个来源，findLast 匹配——后者覆盖前者
    return {
      rules: [...this.agentRules.rules, ...this.savedRules.rules],
    };
  }

  // assert：执行前调用
  async assert(
    sessionId: string,
    action: string,
    resources: string[],
    source?: unknown
  ): Promise<void> {
    const rs = this.mergedRules();
    const effect = evaluate(rs, action, resources);

    if (effect === "allow") return;

    if (effect === "deny") {
      // BlockedError（带相关 rules 告诉你被谁挡）
      const rules = rs.rules.filter(
        (r) => resources.some((res) => matchRule(r, action, res)) && r.effect === "deny"
      );
      throw new BlockedError(
        `Permission denied for ${action}`,
        rules
      );
    }

    // ask：发个 Asked 事件，await 用户回复
    if (!this.askHandler) {
      // 没有 handler，默认 deny（偏安全）
      throw new BlockedError(
        `No permission handler for ${action}`,
        []
      );
    }

    const deferred = new Deferred<void>();
    // cascadeReject 可能 reject 这个 deferred——但简化实现里 assert 等的是 askHandler
    // 而非 deferred，所以它可能没人 await。挂个 noop catch 防 unhandled rejection 崩进程。
    void deferred.promise.catch(() => {});
    const req: PendingRequest = {
      id: `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      action,
      resources,
      deferred,
      createdAt: Date.now(),
    };

    let pending = this.pendingBySession.get(sessionId);
    if (!pending) {
      pending = [];
      this.pendingBySession.set(sessionId, pending);
    }
    pending.push(req);

    // 调 handler 等回复
    const reply = await this.askHandler(req);
    // 从 pending 移除——必须同步回 map，否则 cascadeReject 还会看到当前 req，
    // 去 reject 它那个「没人 await」的 deferred，制造 unhandled rejection。
    pending = pending.filter((p) => p.id !== req.id);
    this.pendingBySession.set(sessionId, pending);

    switch (reply.type) {
      case "reject": {
        // 文档 05：拒绝级联——拒一个就拒同 session 所有 pending
        this.cascadeReject(sessionId, reply.feedback);
        if (reply.feedback) {
          throw new CorrectedError(reply.feedback);
        }
        throw new DeclinedError();
      }
      case "allow":
        // 只这次通过
        return;
      case "always": {
        // 保存 allow 规则到 saved rules（持久化）
        this.savedRules.rules.push(reply.save);
        // 文档 05：always 级联 resolve——遍历所有 pending 重新评估，能 allow 的全部自动通过
        this.cascadeResolve(sessionId);
        return;
      }
    }
  }

  // 拒绝级联：拒绝所有 pending
  private cascadeReject(sessionId: string, _feedback?: string) {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending) return;
    for (const p of pending) {
      // 它们后续 await 会拿到 DeclinedError（通过 deferred.reject）
      // 但因为级联是从这个 req 开始，所以其它 pending 直接 reject
      p.deferred.reject(new DeclinedError());
    }
    this.pendingBySession.set(sessionId, []);
  }

  // always 级联 resolve：能 allow 的全部自动通过
  private cascadeResolve(sessionId: string) {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending) return;
    const rs = this.mergedRules();
    const remaining: PendingRequest[] = [];
    for (const p of pending) {
      const effect = evaluate(rs, p.action, p.resources);
      if (effect === "allow") {
        p.deferred.resolve(undefined);
      } else {
        remaining.push(p);
      }
    }
    this.pendingBySession.set(sessionId, remaining);
  }

  // scope finalizer 兜底：把所有 pending reject（防 pending 泄漏）
  rejectAllPending(sessionId: string) {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending) return;
    for (const p of pending) {
      p.deferred.reject(new DeclinedError());
    }
    this.pendingBySession.delete(sessionId);
  }
}
