// Command 用户动作记忆（04）
//
// 文档 04：斜杠命令（/commit、/learn、/changelog 等）。本质是用户自定义的可复用动作模板，
//   存在 .opencode/command/*.md，带 frontmatter description。State-based 服务，可 reload/transform。

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { existsSync } from "node:fs";

export interface Command {
  name: string;
  description: string;
  // 模板内容（展开成 prompt）
  template: string;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();

  async loadFromDirectory(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(".md")) continue;
      const full = path.join(dir, entry.name);
      const content = await fs.readFile(full, "utf8");
      const cmd = parseCommandFile(content, entry.name.replace(/\.md$/, ""));
      this.commands.set(cmd.name, cmd);
    }
  }

  register(cmd: Command) {
    this.commands.set(cmd.name, cmd);
  }

  list(): Command[] {
    return Array.from(this.commands.values());
  }

  // 把命令展开成 prompt（替换 $ARGUMENTS 等）
  expand(name: string, args: string): string | null {
    const cmd = this.commands.get(name);
    if (!cmd) return null;
    return cmd.template.replace(/\$ARGUMENTS/g, args);
  }
}

function parseCommandFile(content: string, fallbackName: string): Command {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return {
      name: fallbackName,
      description: `(command ${fallbackName})`,
      template: content,
    };
  }
  const fm = match[1];
  const body = match[2];
  const meta: Record<string, string> = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2];
  }
  return {
    name: meta.name ?? fallbackName,
    description: meta.description ?? "",
    template: body,
  };
}
