// Effect runtime 模拟：用原生 Promise + AbortController 模拟 Effect-TS 的 fiber/interruption/scope。
// 不引入 Effect-TS 依赖，但保留文档里的关键语义：
//   - Fiber（可取消的并发执行单元）
//   - uninterruptibleMask（保证 side effect 完整）
//   - Deferred（可被外部 resolve/reject 的 promise）
//   - Scope（生命周期管理 + finalizer）
//   - catchDefect / die（控制流信号 vs 失败）
//   - addFinalizer（scope 关闭自动清理）

export type Cancel = () => void;

// --- Deferred：可被外部 resolve/reject 的 promise ---
export class Deferred<T> {
  private _resolve!: (v: T) => void;
  private _reject!: (e: unknown) => void;
  readonly promise: Promise<T>;
  private _settled = false;
  private _state: "pending" | "resolved" | "rejected" = "pending";

  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this._resolve = res;
      this._reject = rej;
    });
  }

  get settled() {
    return this._settled;
  }

  get state() {
    return this._state;
  }

  resolve(v: T) {
    if (this._settled) return;
    this._settled = true;
    this._state = "resolved";
    this._resolve(v);
  }

  reject(e: unknown) {
    if (this._settled) return;
    this._settled = true;
    this._state = "rejected";
    this._reject(e);
  }

  static await<T>(p: Promise<T>): Promise<T> {
    return p;
  }
}

// --- Scope：注册 finalizer，关闭时逆序执行 ---
export class Scope {
  private finalizers: Array<() => Promise<void> | void> = [];
  private _closed = false;

  get closed() {
    return this._closed;
  }

  addFinalizer(f: () => Promise<void> | void) {
    if (this._closed) {
      // 已关闭，立刻执行
      void f();
      return;
    }
    this.finalizers.push(f);
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    // 逆序执行
    const fns = this.finalizers.slice().reverse();
    this.finalizers = [];
    for (const f of fns) {
      try {
        await f();
      } catch {
        // finalizer 错误忽略
      }
    }
  }
}

// --- uninterruptibleMask：保证内部 Effect 不被中断 ---
// 文档 11/03：工具执行包在 uninterruptibleMask 里，保证 side effect 完整。
export function uninterruptibleMask<T>(
  fn: (mark: { allow: () => void }) => Promise<T>
): Promise<T> {
  // 在最小实现里，uninterruptible 段不响应中断信号；外部取消需要等内部完成。
  // mark.allow 留作外层重新允许中断的钩子（这里 no-op）。
  return fn({ allow: () => {} });
}

// --- FiberSet：管理一组并发 fiber，可 clear、可 failUnsettled ---
// 文档 03/11：tool-call 事件到来时工具执行被 fork 进 FiberSet，多个 tool-call 并行。
export class FiberSet {
  private fibers: Set<Promise<unknown>> = new Set();
  private _cleared = false;

  get size() {
    return this.fibers.size;
  }

  fork<T>(p: Promise<T>): Promise<T> {
    if (this._cleared) {
      // 已 clear，新 fiber 标记失败
      return Promise.reject(new InterruptedError("fiber set cleared"));
    }
    this.fibers.add(p);
    void p.finally(() => this.fibers.delete(p));
    return p;
  }

  // 清理所有 fiber：标记 cleared，未结算的会被 failUnsettledTools 处理
  clear() {
    this._cleared = true;
    this.fibers.clear();
  }

  // 等所有 fiber 结束（drain）
  // 文档 03/11：任意 fork reject 都要上抛——尤其 isUserDeclined（用户拒绝）必须
  //   传到 runner 的 catch 触发 halt，不能被 allSettled 吞掉。
  //   这里仍用 allSettled 等齐所有 fork（保证 side effect 完整），再抛首个 reject。
  async drain(): Promise<void> {
    while (this.fibers.size > 0) {
      const results = await Promise.allSettled(Array.from(this.fibers));
      for (const r of results) {
        if (r.status === "rejected") {
          throw r.reason;
        }
      }
    }
  }

  // 把所有未结算的工具 fiber 标记失败（外层中断时调用）
  failUnsettled() {
    this._cleared = true;
    // 最小实现：清空集合，外层会重建状态
    this.fibers.clear();
  }
}

// --- Effect interruption ---
export class InterruptedError extends Error {
  readonly _tag = "InterruptedError";
  constructor(message = "interrupted") {
    super(message);
    this.name = "InterruptedError";
  }
}

// --- defect：控制流信号（不是失败）---
// 文档 03/07：compaction 转场用 die 抛 TurnTransitionError，外层 catchDefect 捕获。
export class Defect {
  constructor(
    readonly tag: string,
    readonly payload?: unknown
  ) {}
}

export function die(defect: Defect): never {
  throw defect;
}

// catchDefect：精准捕获特定 tag 的 defect，其它继续抛
export async function catchDefect<T>(
  p: Promise<T>,
  tag: string,
  handler: (d: Defect) => T | Promise<T>
): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof Defect && e.tag === tag) {
      return await handler(e);
    }
    throw e;
  }
}

// hasInterruptsOnly：判断错误是否"纯中断"（不是真失败）
// 文档 13：Cause.hasInterruptsOnly 区分 cancelled / error
export function hasInterruptsOnly(e: unknown): boolean {
  return e instanceof InterruptedError;
}

// SynchronizedRef：进程内单一写入方的可变引用
// 文档 13：core 引擎用 SynchronizedRef<Map>
export class SynchronizedRef<T> {
  private value: T;
  constructor(initial: T) {
    this.value = initial;
  }
  get(): T {
    return this.value;
  }
  set(v: T) {
    this.value = v;
  }
  update(f: (v: T) => T): T {
    this.value = f(this.value);
    return this.value;
  }
}

// raceFirst：等任意一个 promise 先 settle
export async function raceFirst<T>(
  promises: Array<Promise<T>>
): Promise<T> {
  // 任一 resolve 或 reject 都立即返回
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    for (const p of promises) {
      p.then(
        (v) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        },
        (e) => {
          if (!settled) {
            settled = true;
            reject(e);
          }
        }
      );
    }
  });
}

// Semaphore(1)：单许可互斥锁（KeyedMutex 的基础）
export class Semaphore {
  private current = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly permits: number) {}

  async acquire(): Promise<() => void> {
    if (this.current < this.permits) {
      this.current++;
      return () => this.release();
    }
    await new Promise<void>((res) => this.waiters.push(res));
    this.current++;
    return () => this.release();
  }

  private release() {
    this.current--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// KeyedMutex：per-key 互斥锁
export class KeyedMutex {
  private entries = new Map<string, { sem: Semaphore; users: number }>();

  async acquire(key: string): Promise<() => void> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { sem: new Semaphore(1), users: 0 };
      this.entries.set(key, entry);
    }
    entry.users++;
    const release = await entry.sem.acquire();
    return () => {
      release();
      entry!.users--;
      if (entry!.users === 0) {
        this.entries.delete(key);
      }
    };
  }
}

// AsyncQueue：push/next 异步队列
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: T) => void> = [];

  push(item: T) {
    const w = this.waiters.shift();
    if (w) w(item);
    else this.items.push(item);
  }

  next(): Promise<T> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift()!);
    }
    return new Promise<T>((res) => this.waiters.push(res));
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      yield await this.next();
    }
  }
}

// sleep
export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
