// ToolOutputStore（02/14）
// 文档：工具输出大对象不进 message，单独存，message 只带引用 + 截断摘要（默认 2000 字符）。
// 运行时 bound：超过 MAX_LINES(2000) 或 MAX_BYTES(50KB) → 写文件 + boundedPreview。
//
// 最小实现：内存 + 临时文件。boundedPreview 头尾采样。

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  TOOL_OUTPUT_MAX_BYTES,
  TOOL_OUTPUT_MAX_CHARS,
  TOOL_OUTPUT_MAX_LINES,
} from "../token/estimate.js";

export interface BoundedPreview {
  readonly type: "bounded";
  readonly content: string;
  readonly path: string | null;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly originalLines: number;
}

export interface PlainOutput {
  readonly type: "plain";
  readonly content: string;
}

export type ToolOutputView = BoundedPreview | PlainOutput;

// 字节长度（防多字节字符截断）
function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// 头尾采样
function headTailSample(content: string, maxBytes: number): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maxBytes) return content;
  const half = Math.floor(maxBytes / 2);
  const head = bytes.subarray(0, half).toString("utf8");
  const tail = bytes.subarray(bytes.length - half).toString("utf8");
  return (
    head +
    `\n... output truncated; full content saved to external store ...\n` +
    tail
  );
}

// 按行截断 + 按字节截断
function bound(
  content: string,
  maxLines: number,
  maxBytes: number
): { result: string; truncated: boolean } {
  let lines = content.split("\n");
  let truncated = false;
  if (lines.length > maxLines) {
    // 头尾各取一半
    const half = Math.floor(maxLines / 2);
    const head = lines.slice(0, half);
    const tail = lines.slice(lines.length - half);
    lines = [
      ...head,
      `... output truncated; full content saved to external store ...`,
      ...tail,
    ];
    truncated = true;
  }
  let result = lines.join("\n");
  if (byteLength(result) > maxBytes) {
    result = headTailSample(result, maxBytes);
    truncated = true;
  }
  return { result, truncated };
}

let storeDir: string | null = null;
async function getStoreDir(): Promise<string> {
  if (storeDir) return storeDir;
  storeDir = path.join(os.tmpdir(), "myagent-tool-output");
  await fs.mkdir(storeDir, { recursive: true });
  return storeDir;
}

export class ToolOutputStore {
  private static entries = new Map<string, { content: string; at: number }>();
  private static cleanerStarted = false;

  static async store(content: string): Promise<string> {
    const dir = await getStoreDir();
    const id = `out_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const p = path.join(dir, id);
    // flag: "wx" exclusive create，防并发写冲突
    await fs.writeFile(p, content, { flag: "wx" });
    this.entries.set(id, { content, at: Date.now() });
    void this.maybeStartCleaner();
    return p;
  }

  static async load(p: string): Promise<string | null> {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      return null;
    }
  }

  // bound：把工具输出转成 message 里的 view
  // 运行时（给模型看的当前消息）
  static bound(content: string): ToolOutputView {
    const originalLines = content.split("\n").length;
    const originalBytes = byteLength(content);
    if (
      originalLines <= TOOL_OUTPUT_MAX_LINES &&
      originalBytes <= TOOL_OUTPUT_MAX_BYTES
    ) {
      return { type: "plain", content };
    }
    const { result, truncated } = bound(
      content,
      TOOL_OUTPUT_MAX_LINES,
      TOOL_OUTPUT_MAX_BYTES
    );
    // 异步写文件（最小实现：返回 path 占位，实际写文件异步进行）
    const p = `tool-output://${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    void this.store(content);
    return {
      type: "bounded",
      content: result,
      path: p,
      truncated,
      originalBytes,
      originalLines,
    };
  }

  // 压缩时 serialize truncate（给摘要模型）
  static serializeTruncate(content: string, max = TOOL_OUTPUT_MAX_CHARS): string {
    if (content.length <= max) return content;
    return content.slice(0, max) + "\n... [truncated for summary] ...";
  }

  private static async maybeStartCleaner() {
    if (this.cleanerStarted) return;
    this.cleanerStarted = true;
    // 每小时全局清理一次过期文件（不是 per-Location）
    setInterval(() => {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const [id, entry] of this.entries) {
        if (entry.at < cutoff) {
          this.entries.delete(id);
        }
      }
    }, 60 * 60 * 1000).unref?.();
  }
}

// 把 ToolOutputView 渲染成 message 里的字符串
export function renderToolOutput(view: ToolOutputView): string {
  if (view.type === "plain") return view.content;
  let s = view.content;
  if (view.path) {
    s += `\n[full content at: ${view.path}]`;
  }
  return s;
}
