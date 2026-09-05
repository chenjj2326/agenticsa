// SessionRunCoordinator（03）—— 第一层：进程级、按 Session ID 的并发控制
//
// 文档 03：
//   - 同 Session 串行（不能两个 turn 同时改 history）
//   - 不同 Session 并发（不互相阻塞）
//   - 多个 wake 合并成至多一个 pending drain（不排长队）
//   - 显式 resume 要 join 当前执行
//
// 最反直觉的设计：wake 不是"排进队列等执行"，而是"标记一个 bool 标志"，
//   等当前 drain 结束时如果有 pending 就再跑一轮。所以同一 Session 最多只有一个 pending drain 排队，不会堆积。
//   把"队列"退化成"一个 bool"，避免状态膨胀。

import { Deferred, type Scope } from "../effect/runtime.js";

interface Entry {
  done: Deferred<void>;
  // owner fiber（当前 drain 的 promise）
  owner: Promise<void> | null;
  // wake bool：当前 drain 结束时如果有 pending 就再跑一轮
  pendingWake: boolean;
  // stopping：用户 interrupt 标记
  stopping: boolean;
  // drain runner：调用方传入的 drain 函数
  drainRunner: null | (() => Promise<void>);
}

export class SessionRunCoordinator {
  private entries = new Map<string, Entry>();

  // active：看活跃的
  active(sessionId?: string): string[] {
    if (sessionId) {
      return this.entries.has(sessionId) ? [sessionId] : [];
    }
    return Array.from(this.entries.keys());
  }

  // run：join 或启动
  // 文档 03：显式 resume 要 join 当前执行；不在就启动新 drain
  async run(
    sessionId: string,
    drain: () => Promise<void>
  ): Promise<void> {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = {
        done: new Deferred(),
        owner: null,
        pendingWake: false,
        stopping: false,
        drainRunner: drain,
      };
      this.entries.set(sessionId, entry);
    } else {
      // 已在跑——join
      // 文档 03：resume join 当前执行，不起第二个
      return entry.done.promise;
    }

    // 启动 drain 循环
    try {
      await this.runDrainLoop(sessionId, entry, drain);
      entry.done.resolve(undefined);
    } catch (e) {
      entry.done.reject(e);
    } finally {
      this.entries.delete(sessionId);
    }
  }

  // drain 循环：drain 一次 → settle → 看 pendingWake 决定要不要再跑一轮
  private async runDrainLoop(
    sessionId: string,
    entry: Entry,
    drain: () => Promise<void>
  ): Promise<void> {
    while (true) {
      entry.stopping = false;
      entry.owner = drain();
      try {
        await entry.owner;
      } catch (e) {
        // drain 失败，退出
        throw e;
      }
      // 文档 03：settle 时如果成功且没 stopping 且有 pendingWake 就原地启动下一个 drain
      if (entry.stopping) break;
      if (entry.pendingWake) {
        entry.pendingWake = false;
        continue; // 再跑一轮
      }
      break;
    }
  }

  // wake：标记一个 bool 标志，不排长队
  // 文档 03：当前在跑就标记 pendingWake，不在跑就启动（外层启动）
  wake(sessionId: string, drain: () => Promise<void>): "started" | "pending" {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      // 不在跑——外层应该启动（这里返回 started 提示外层启动）
      // 这里不直接启动，因为 wake 不接受 drain 函数（避免耦合）
      return "started";
    }
    // 在跑——标记 pendingWake（合并）
    entry.pendingWake = true;
    return "pending";
  }

  // interrupt：标记 stopping + 清 pendingWake + interrupt owner
  // 文档 03：用户 explicit 取消
  interrupt(sessionId: string) {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.stopping = true;
    entry.pendingWake = false;
    // owner 的中断通过外层 stream abort 实现（这里只标记）
  }
}
