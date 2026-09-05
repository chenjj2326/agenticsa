// Snapshot 短期工作记忆（04）
//
// 文档 04：每个 step 开始和结束 capture 一次文件系统快照，基于 git tree（content-addressed）。
//   存在独立仓库（不是项目 .git）。
//   能力：capture / files / diff / preview / restore / checkout
//   content-addressed 去重；按 project + worktree 隔离；未跟踪文件 >2MB 不纳入。
//
// 最小实现：内存 + 文件 hash 表，不做真 git tree（避免外部 git 依赖）。

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024; // 2MB

interface FileEntry {
  relativePath: string;
  hash: string;
  size: number;
  isTracked: boolean;
}

interface Snapshot {
  id: string;
  capturedAt: number;
  files: Map<string, FileEntry>; // relativePath -> entry
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function hashContent(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export class SnapshotStore {
  private snapshots = new Map<string, Snapshot>();
  private contentStore = new Map<string, Buffer>(); // hash -> content
  // step snapshots by session
  private bySession = new Map<string, Snapshot[]>();

  async capture(cwd: string, sessionId: string): Promise<Snapshot> {
    const snap: Snapshot = {
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      capturedAt: Date.now(),
      files: new Map(),
    };
    await this.walk(cwd, cwd, snap);
    this.snapshots.set(snap.id, snap);
    let arr = this.bySession.get(sessionId);
    if (!arr) {
      arr = [];
      this.bySession.set(sessionId, arr);
    }
    arr.push(snap);
    return snap;
  }

  private async walk(root: string, dir: string, snap: Snapshot) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // 跳过 node_modules 和 .git
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(root, full, snap);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_FILE_BYTES) continue;
          const content = await fs.readFile(full);
          const hash = hashContent(content);
          this.contentStore.set(hash, content);
          const rel = path.relative(root, full).replace(/\\/g, "/");
          snap.files.set(rel, {
            relativePath: rel,
            hash,
            size: stat.size,
            isTracked: true,
          });
        } catch {}
      }
    }
  }

  // 两个快照间改了哪些文件
  files(a: Snapshot, b: Snapshot): string[] {
    const changed: string[] = [];
    const allPaths = new Set([...a.files.keys(), ...b.files.keys()]);
    for (const p of allPaths) {
      const ea = a.files.get(p);
      const eb = b.files.get(p);
      if (!ea || !eb || ea.hash !== eb.hash) {
        changed.push(p);
      }
    }
    return changed;
  }

  // 整体 checkout（恢复到某棵树）
  async checkout(snap: Snapshot, root: string): Promise<void> {
    // 先删除当前不在 snap 里的文件
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = path.join(root, entry.name);
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (!snap.files.has(rel) && !Array.from(snap.files.keys()).some((k) => k.startsWith(rel + "/"))) {
          await fs.rm(full, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {}

    // 把 snap 的文件写回去
    for (const [, entry] of snap.files) {
      const full = path.join(root, entry.relativePath);
      const content = this.contentStore.get(entry.hash);
      if (content) {
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content);
      }
    }
  }

  // 选择性 restore 指定路径
  async restore(
    snap: Snapshot,
    root: string,
    paths: string[]
  ): Promise<void> {
    for (const p of paths) {
      const entry = snap.files.get(p);
      if (!entry) {
        // 路径不在树里——删除
        await fs.rm(path.join(root, p), { recursive: true, force: true }).catch(() => {});
        continue;
      }
      const content = this.contentStore.get(entry.hash);
      if (content) {
        const full = path.join(root, p);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content);
      }
    }
  }

  // 获取某 session 的 step snapshots
  getSessionSnapshots(sessionId: string): Snapshot[] {
    return this.bySession.get(sessionId) ?? [];
  }
}
