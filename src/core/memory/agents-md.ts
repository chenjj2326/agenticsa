// Memory：AGENTS.md 层级化加载（04）
//
// 文档 04：从当前目录向上搜索 AGENTS.md 到 project 根目录停止；加上全局 config 目录里的一份。
// 所有命中的文件合并成 ambient instructions（环境指令）。
// 注册成 core/instructions SystemContext source（在 sources.ts 里实现）。
//
// /learn 命令：分析当前会话，提取非显而易见的发现写到合适层级的 AGENTS.md。
// 这是 "会话发现 → 写回项目记忆 → 下次自动读取" 的闭环。

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { existsSync } from "node:fs";

// 加载所有 AGENTS.md（全局 + 层级）
export async function loadAgentsMdFiles(
  cwd: string,
  globalConfigDir?: string
): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];

  if (globalConfigDir) {
    const globalPath = path.join(globalConfigDir, "AGENTS.md");
    if (existsSync(globalPath)) {
      try {
        results.push({
          path: globalPath,
          content: await fs.readFile(globalPath, "utf8"),
        });
      } catch {}
    }
  }

  // 从 cwd 向上到 root
  const segments = cwd.split(path.sep);
  for (let i = segments.length; i >= 1; i--) {
    const dir = i === 1 ? path.sep : segments.slice(0, i).join(path.sep);
    const p = path.join(dir, "AGENTS.md");
    if (existsSync(p)) {
      try {
        results.push({ path: p, content: await fs.readFile(p, "utf8") });
      } catch {}
    }
    if (dir === path.dirname(dir)) break;
  }

  return results;
}

// /learn：写到合适层级的 AGENTS.md
// 文档 04：每条 1-3 行，放到最贴近相关代码的目录
export async function learn(
  cwd: string,
  findings: Array<{ note: string; directory?: string }>
): Promise<void> {
  for (const f of findings) {
    const dir = f.directory ?? cwd;
    const p = path.join(dir, "AGENTS.md");
    let existing = "";
    if (existsSync(p)) {
      existing = await fs.readFile(p, "utf8");
    }
    // 追加
    const addition = `\n## Learned ${new Date().toISOString()}\n- ${f.note}\n`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(p, existing + addition, "utf8");
  }
}
