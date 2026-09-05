// 内置工具（05/04）
//
// 文档 05：Location 级内置，通过注册。bash/read/write/edit/glob/grep/skill/question/todowrite/webfetch/websearch
// edit/write/apply_patch 共享 "edit" action
//
// 文档 11：question 也要权限——模型能不能问用户本身是权限决策

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { makeTool, type Tool, type ToolImpl, type ToolSchema } from "./tool.js";
import { ToolOutputStore, renderToolOutput } from "../output-store/tool-output-store.js";

const execAsync = promisify(exec);

// --- bash 工具 ---
function makeBashTool(): Tool {
  const impl: ToolImpl = {
    description:
      "Execute a bash command and return stdout/stderr. Use for running tests, builds, git, etc.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        timeout: { type: "number", description: "Timeout in ms" },
      },
      required: ["command"],
    },
    async execute(args: any, ctx) {
      const cmd = args?.command as string;
      if (!cmd) throw { safeMessage: "command required", category: "invalid_data" };
      // 权限 assert（在 execute 内部）
      await ctx.assert("bash", [cmd], { type: "tool", messageID: ctx.messageID });
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          timeout: args?.timeout ?? 60_000,
          maxBuffer: 5 * 1024 * 1024,
        });
        const out = (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).trim();
        return out || "(no output)";
      } catch (e: any) {
        // 命令失败也是合法结果（非零退出码）
        if (e.stdout !== undefined) {
          const out = (e.stdout + (e.stderr ? "\n[stderr]\n" + e.stderr : "")).trim();
          return out || `(exit code ${e.code ?? "?"})`;
        }
        throw { safeMessage: `bash failed: ${e.message}`, category: "tool_failure" };
      }
    },
    permissionAction: "bash",
    toModelOutput(raw) {
      // bound 大输出
      const view = ToolOutputStore.bound(String(raw));
      return renderToolOutput(view);
    },
  };
  return makeTool(impl);
}

// --- read 工具 ---
function makeReadTool(): Tool {
  const impl: ToolImpl = {
    description: "Read the contents of a file at the given path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path (alias: file_path)" },
        file_path: { type: "string", description: "Alias of path" },
      },
      required: [],
    },
    async execute(args: any, ctx) {
      const p = (args?.path ?? args?.file_path) as string;
      if (!p) throw { safeMessage: "path (or file_path) required", category: "invalid_data" };
      await ctx.assert("read", [p], { type: "tool", messageID: ctx.messageID });
      try {
        const content = await fs.readFile(p, "utf8");
        return content;
      } catch (e: any) {
        if (e.code === "ENOENT" || e.code === "ENOTDIR") {
          throw { safeMessage: `File not found: ${p}`, category: "tool_failure" };
        }
        throw { safeMessage: `read failed: ${e.message}`, category: "tool_failure" };
      }
    },
    permissionAction: "read",
    toModelOutput(raw) {
      const view = ToolOutputStore.bound(String(raw));
      return renderToolOutput(view);
    },
  };
  return makeTool(impl);
}

// --- write 工具（共享 edit action）---
function makeWriteTool(): Tool {
  const impl: ToolImpl = {
    description: "Write content to a file (overwrite if exists).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        file_path: { type: "string", description: "Alias of path" },
        content: { type: "string" },
      },
      required: [],
    },
    async execute(args: any, ctx) {
      const p = (args?.path ?? args?.file_path) as string;
      const content = args?.content as string;
      if (!p) throw { safeMessage: "path (or file_path) required", category: "invalid_data" };
      if (typeof content !== "string") throw { safeMessage: "content required (string)", category: "invalid_data" };
      await ctx.assert("edit", [p], { type: "tool", messageID: ctx.messageID });
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content, "utf8");
      return `Wrote ${content.length} bytes to ${p}`;
    },
    // 共享 edit action
    permissionAction: "edit",
  };
  return makeTool(impl);
}

// --- edit 工具（共享 edit action）---
function makeEditTool(): Tool {
  const impl: ToolImpl = {
    description:
      "Apply a text edit to a file. Replaces all occurrences of oldString with newString.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        file_path: { type: "string", description: "Alias of path" },
        oldString: { type: "string" },
        old_string: { type: "string", description: "Alias of oldString" },
        newString: { type: "string" },
        new_string: { type: "string", description: "Alias of newString" },
      },
      required: [],
    },
    async execute(args: any, ctx) {
      const p = (args?.path ?? args?.file_path) as string;
      const oldStr = (args?.oldString ?? args?.old_string) as string;
      const newStr = (args?.newString ?? args?.new_string) as string;
      if (!p) throw { safeMessage: "path (or file_path) required", category: "invalid_data" };
      if (typeof oldStr !== "string") throw { safeMessage: "old_string (or oldString) required", category: "invalid_data" };
      if (typeof newStr !== "string") throw { safeMessage: "new_string (or newString) required", category: "invalid_data" };
      await ctx.assert("edit", [p], { type: "tool", messageID: ctx.messageID });
      let content: string;
      try {
        content = await fs.readFile(p, "utf8");
      } catch {
        throw { safeMessage: `read failed: ${p}`, category: "tool_failure" };
      }
      let updated: string;
      let count: number;
      let viaFuzzy = false;
      if (content.includes(oldStr)) {
        count = content.split(oldStr).length - 1;
        updated = content.split(oldStr).join(newStr);
      } else {
        // 模糊回退：弱模型经常凭记忆打缩进（差 2 个空格）、行尾留 \r 或多余空格。
        // 先按「忽略行首/行尾空白」滑窗找目标块，再用文件的真实缩进重排 new_string。
        const fuzzy = fuzzyEdit(content, oldStr, newStr);
        if (!fuzzy) {
          throw {
            safeMessage: buildOldStringNotFound(p, oldStr, content),
            category: "invalid_data",
          };
        }
        updated = fuzzy.updated;
        count = fuzzy.count;
        viaFuzzy = true;
      }
      await fs.writeFile(p, updated, "utf8");
      return `Edited ${p} (replaced ${count} occurrence(s)${viaFuzzy ? ", fuzzy-indent matched" : ""})`;
    },
    permissionAction: "edit",
  };
  return makeTool(impl);
}

// 缩进自适应模糊编辑：
//   匹配条件：逐行 strip() 后与 old_string 逐行 strip() 完全相等（行数一致）。
//   替换规则：以文件里目标块首行的真实缩进为基准，把 new_string 每行按
//   「文件首行缩进 - old_string 首行缩进」的差值重排缩进后写入。
//   找不到唯一可替换块返回 null（调用方走 not-found 诊断）。
function fuzzyEdit(
  content: string,
  oldStr: string,
  newStr: string
): { updated: string; count: number } | null {
  const norm = (s: string) => s.replace(/\r/g, "").trim();
  const oldLines = oldStr.replace(/\r/g, "").split("\n");
  if (oldLines.some((l) => norm(l) === "" && l.trim() !== "")) return null;
  const contentLines = content.split("\n");
  const matches: number[] = [];
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (norm(contentLines[i + j]) !== norm(oldLines[j])) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }
  if (matches.length === 0) return null;

  const indentOf = (s: string) => {
    const m = /^[ \t]*/.exec(s);
    return m ? m[0] : "";
  };
  const delta = indentOf(contentLines[matches[0]]).length - indentOf(oldLines[0]).length;
  const adjust = (line: string): string => {
    const ind = indentOf(line);
    const body = line.slice(ind.length);
    if (delta >= 0) return ind + " ".repeat(delta) + body;
    // 收缩缩进：不能砍到 body 里
    return ind.length >= -delta ? ind.slice(0, ind.length + delta) + body : body;
  };
  const newLines = newStr.replace(/\r/g, "").split("\n").map(adjust);

  // 从后往前替换，避免下标漂移
  const out = contentLines.slice();
  for (let k = matches.length - 1; k >= 0; k--) {
    out.splice(matches[k], oldLines.length, ...newLines);
  }
  return { updated: out.join("\n"), count: matches.length };
}

// old_string 匹配失败时，定位最接近的真实代码区域回显给模型（带行号），
// 弱模型（glm-4-flash 等）常凭记忆改写正则/标点导致永远匹配不上，
// 直接给它真实字节照抄。
function buildOldStringNotFound(p: string, oldStr: string, content: string): string {
  const lines = content.split("\n");
  const oldLines = oldStr.split("\n");
  const firstMeaningful =
    oldLines.map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  // 从 old_string 提取有辨识度的 token（较长的字母数字串）
  const STOP = new Set([
    "return", "import", "class", "def", "self", "None", "True", "False",
    "print", "const", "function", "string", "async", "await", "from", "None",
  ]);
  const tokens = (oldStr.match(/[A-Za-z_][A-Za-z0-9_]{4,}/g) ?? [])
    .filter((t) => !STOP.has(t))
    .sort((a, b) => b.length - a.length)
    .slice(0, 6);
  let best = -1;
  let bestScore = 0;
  lines.forEach((ln, idx) => {
    let score = 0;
    for (const t of tokens) if (ln.includes(t)) score += t.length;
    // 首行去空白后直接命中，给高分
    if (firstMeaningful && ln.trim() === firstMeaningful) score += 50;
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
  });
  const diag: string[] = [];
  if (oldStr.includes("\r")) diag.push("old_string contains CR (\\r) — file uses LF newlines");
  let hint: string;
  if (best >= 0 && bestScore > 0) {
    const lo = Math.max(0, best - 4);
    const hi = Math.min(lines.length, best + 6);
    const region = lines
      .slice(lo, hi)
      .map((ln, i) => `${String(lo + i + 1).padStart(5)}| ${ln}`)
      .join("\n");
    hint =
      `old_string not found in ${p} (length=${oldStr.length}, ${oldLines.length} line(s)).\n` +
      `Most likely target region (copy old_string EXACTLY from these bytes — ` +
      `preserve every backslash, quote, punctuation and indentation):\n${region}`;
  } else {
    hint =
      `old_string not found in ${p} (length=${oldStr.length}). ` +
      `Re-read the file with the read tool and copy old_string character-by-character ` +
      `from the output — do NOT retype regex/punctuation from memory.`;
  }
  if (diag.length) hint += "\nDiagnostics: " + diag.join("; ");
  return hint;
}

// --- glob 工具 ---
function makeGlobTool(): Tool {
  const impl: ToolImpl = {
    description: "Find files matching a glob pattern (e.g. **/*.ts).",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["pattern"],
    },
    async execute(args: any, ctx) {
      const pattern = args?.pattern as string;
      const cwd = args?.cwd ?? process.cwd();
      await ctx.assert("glob", [pattern], { type: "tool", messageID: ctx.messageID });
      const matches = await globFiles(pattern, cwd);
      return matches.join("\n") || "(no matches)";
    },
    permissionAction: "glob",
  };
  return makeTool(impl);
}

// 简易 glob：把 * 转成正则，** 递归
async function globFiles(pattern: string, cwd: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 10) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // 跳过 node_modules 和 .git
        if (entry === "node_modules" || entry === ".git") continue;
        await walk(full, depth + 1);
      } else {
        const rel = path.relative(cwd, full).replace(/\\/g, "/");
        if (matchGlob(pattern, rel)) {
          results.push(rel);
        }
      }
    }
  }
  await walk(cwd, 0);
  return results;
}

function matchGlob(pattern: string, name: string): boolean {
  // 支持 ** 和 *
  const re =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "::DOUBLESTAR::")
      .replace(/\*/g, "[^/]*")
      .replace(/::DOUBLESTAR::/g, ".*") +
    "$";
  return new RegExp(re).test(name);
}

// --- grep 工具 ---
function makeGrepTool(): Tool {
  const impl: ToolImpl = {
    description: "Search file contents with a regex pattern.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["pattern"],
    },
    async execute(args: any, ctx) {
      const pattern = args?.pattern as string;
      const cwd = args?.cwd ?? process.cwd();
      await ctx.assert("grep", [pattern], { type: "tool", messageID: ctx.messageID });
      const re = new RegExp(pattern);
      const files = await globFiles("**/*", cwd);
      const results: string[] = [];
      for (const f of files) {
        try {
          const full = path.join(cwd, f);
          const content = await fs.readFile(full, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              results.push(`${f}:${i + 1}: ${lines[i]}`);
            }
          }
        } catch {
          // 跳过二进制文件
        }
      }
      return results.join("\n") || "(no matches)";
    },
    permissionAction: "grep",
  };
  return makeTool(impl);
}

// --- question 工具（也要权限）---
function makeQuestionTool(): Tool {
  const impl: ToolImpl = {
    description: "Ask the user a question. Use when you need clarification.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
    },
    async execute(args: any, ctx) {
      const question = args?.question as string;
      // 文档 11：question 也要权限——模型能不能问用户本身是权限决策
      await ctx.assert("question", [question], {
        type: "tool",
        messageID: ctx.messageID,
      });
      // 通过 ctx 的 assert 之外的 hook 提问（这里复用 ask 机制）
      // 最小实现：返回 question 让外层 mock provider 知道
      return `Question asked: ${question}`;
    },
    permissionAction: "question",
  };
  return makeTool(impl);
}

// --- todowrite 工具 ---
function makeTodoWriteTool(): Tool {
  let todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> = [];
  const impl: ToolImpl = {
    description: "Write or update the todo list.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string" },
            },
          },
        },
      },
      required: ["todos"],
    },
    async execute(args: any, ctx) {
      await ctx.assert("todowrite", ["*"], { type: "tool", messageID: ctx.messageID });
      todos = args?.todos ?? [];
      return `Todos updated (${todos.length} items):\n` +
        todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");
    },
    permissionAction: "todowrite",
  };
  return makeTool(impl);
}

// --- webfetch 工具（最小实现：用 fetch）---
function makeWebFetchTool(): Tool {
  const impl: ToolImpl = {
    description: "Fetch the content of a URL (HTTP GET).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
    async execute(args: any, ctx) {
      const url = args?.url as string;
      await ctx.assert("webfetch", [url], { type: "tool", messageID: ctx.messageID });
      try {
        const res = await fetch(url);
        const text = await res.text();
        return text;
      } catch (e: any) {
        throw { safeMessage: `fetch failed: ${e.message}`, category: "tool_failure" };
      }
    },
    permissionAction: "webfetch",
  };
  return makeTool(impl);
}

// --- websearch 工具（最小实现：返回 mock 提示）---
function makeWebSearchTool(): Tool {
  const impl: ToolImpl = {
    description: "Search the web. (Mock: returns a hint, real impl pending.)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    async execute(args: any, ctx) {
      await ctx.assert("websearch", [args?.query ?? "*"], {
        type: "tool",
        messageID: ctx.messageID,
      });
      return `Web search is mock-only in this build. Query was: ${args?.query}`;
    },
    permissionAction: "websearch",
  };
  return makeTool(impl);
}

// --- apply_patch 工具（共享 edit action）---
function makeApplyPatchTool(): Tool {
  const impl: ToolImpl = {
    description: "Apply a unified diff patch to files.",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string" },
      },
      required: ["patch"],
    },
    async execute(args: any, ctx) {
      await ctx.assert("edit", ["*"], { type: "tool", messageID: ctx.messageID });
      // 最小实现：只记录不真应用
      return `Patch received (${args?.patch?.length ?? 0} bytes). (Mock apply.)`;
    },
    permissionAction: "edit",
  };
  return makeTool(impl);
}

// 注册所有内置工具到 Location registry
export function registerBuiltinTools(registry: import("./registry.js").ToolRegistry) {
  registry.register("bash", makeBashTool());
  registry.register("read", makeReadTool());
  registry.register("write", makeWriteTool());
  registry.register("edit", makeEditTool());
  registry.register("apply_patch", makeApplyPatchTool());
  registry.register("glob", makeGlobTool());
  registry.register("grep", makeGrepTool());
  registry.register("question", makeQuestionTool());
  registry.register("todowrite", makeTodoWriteTool());
  registry.register("webfetch", makeWebFetchTool());
  registry.register("websearch", makeWebSearchTool());
}

// 工具 schema helper
export function schema(props: Record<string, unknown>, required?: string[]): ToolSchema {
  return { type: "object", properties: props, required };
}
