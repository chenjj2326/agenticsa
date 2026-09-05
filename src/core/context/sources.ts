// 内置 Source：environment / date / instructions / skill-guidance（06）
//
// 文档 06：所有动态 source 都用 baseline + update 两段式。
//   environment: <env> 工作目录、workspace 根、是否 git repo、平台
//   date: Today's date: ...
//   instructions: AGENTS.md 层级化读取（core/instructions）
//   skill-guidance: 可用 skill 清单 XML 风格（core/skill-guidance）

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Observed, Source } from "./source.js";

const execAsync = promisify(exec);

// --- environment source ---
export interface EnvValue {
  workingDirectory: string;
  workspaceRoot: string;
  isGitRepo: boolean;
  platform: string;
}

function renderEnv(v: EnvValue): string {
  return `<env>
  Working directory: ${v.workingDirectory}
  Workspace root folder: ${v.workspaceRoot}
  Is directory a git repo: ${v.isGitRepo ? "yes" : "no"}
  Platform: ${v.platform}
</env>`;
}

export function makeEnvironmentSource(opts: {
  cwd: string;
  workspaceRoot?: string;
}): Source<EnvValue> {
  return {
    key: "core/environment",
    async observe(): Promise<Observed<EnvValue>> {
      try {
        const value: EnvValue = {
          workingDirectory: opts.cwd,
          workspaceRoot: opts.workspaceRoot ?? opts.cwd,
          isGitRepo: await isGitRepo(opts.cwd),
          platform: process.platform,
        };
        return { _tag: "available", value };
      } catch {
        return { _tag: "unavailable", reason: "git probe failed" };
      }
    },
    equal(a, b) {
      return (
        a.workingDirectory === b.workingDirectory &&
        a.workspaceRoot === b.workspaceRoot &&
        a.isGitRepo === b.isGitRepo &&
        a.platform === b.platform
      );
    },
    renderBaseline(v) {
      return `Here is some useful information about the environment you are running in:\n${renderEnv(
        v
      )}`;
    },
    renderUpdate(v) {
      return `The environment you are running in is now:\n${renderEnv(v)}`;
    },
    renderRemoved() {
      return "Environment information no longer applies.";
    },
    encode(v) {
      return v;
    },
    decode(raw) {
      if (
        raw &&
        typeof raw === "object" &&
        "workingDirectory" in (raw as any) &&
        "workspaceRoot" in (raw as any)
      ) {
        return raw as EnvValue;
      }
      return null;
    },
  };
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execAsync("git rev-parse --git-dir", { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

// --- date source ---
export interface DateValue {
  iso: string;
  display: string;
}

function today(): DateValue {
  const d = new Date();
  return {
    iso: d.toISOString(),
    display: d.toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
  };
}

export function makeDateSource(): Source<DateValue> {
  return {
    key: "core/date",
    async observe() {
      return { _tag: "available", value: today() };
    },
    equal(a, b) {
      return a.display === b.display;
    },
    renderBaseline(v) {
      return `Today's date: ${v.display}`;
    },
    renderUpdate(v) {
      return `Today's date is now: ${v.display}`;
    },
    renderRemoved() {
      return "Date information no longer applies.";
    },
    encode(v) {
      return v;
    },
    decode(raw) {
      if (raw && typeof raw === "object" && "display" in (raw as any)) {
        return raw as DateValue;
      }
      return null;
    },
  };
}

// --- instructions source (AGENTS.md) ---
// 文档 04：从当前目录向上搜索 AGENTS.md 到 project 根目录，加上全局 config 目录。
export interface InstructionsValue {
  files: Array<{ path: string; content: string }>;
}

function renderInstructions(v: InstructionsValue): string {
  return v.files
    .map((f) => `Instructions from: ${f.path}\n${f.content}`)
    .join("\n\n");
}

export function makeInstructionsSource(opts: {
  cwd: string;
  globalConfigDir?: string;
}): Source<InstructionsValue> {
  return {
    key: "core/instructions",
    async observe() {
      try {
        const files = await loadAgentsMd(opts.cwd, opts.globalConfigDir);
        return { _tag: "available", value: { files } };
      } catch {
        return { _tag: "unavailable", reason: "AGENTS.md load failed" };
      }
    },
    equal(a, b) {
      if (a.files.length !== b.files.length) return false;
      return a.files.every(
        (f, i) =>
          f.path === b.files[i].path && f.content === b.files[i].content
      );
    },
    renderBaseline(v) {
      if (v.files.length === 0) return "";
      return renderInstructions(v);
    },
    renderUpdate(v) {
      if (v.files.length === 0) return "";
      // 文档 06：明确告诉模型这是替换不是追加
      return `These instructions replace all previously loaded ambient instructions.\n${renderInstructions(
        v
      )}`;
    },
    renderRemoved() {
      return "Previously loaded instructions no longer apply.";
    },
    encode(v) {
      return v;
    },
    decode(raw) {
      if (raw && typeof raw === "object" && Array.isArray((raw as any).files)) {
        return raw as InstructionsValue;
      }
      return null;
    },
  };
}

// 从当前目录向上搜索 AGENTS.md，到 workspace root 停止；加上全局 config 目录
async function loadAgentsMd(
  cwd: string,
  globalConfigDir?: string
): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];

  // 全局那份
  if (globalConfigDir) {
    const globalPath = path.join(globalConfigDir, "AGENTS.md");
    if (existsSync(globalPath)) {
      results.push({
        path: globalPath,
        content: await fs.readFile(globalPath, "utf8"),
      });
    }
  }

  // 项目层级化：从 cwd 向上到 root，每一层的 AGENTS.md
  const segments = cwd.split(path.sep);
  for (let i = segments.length; i >= 1; i--) {
    const dir = i === 1 ? path.sep : segments.slice(0, i).join(path.sep);
    const p = path.join(dir, "AGENTS.md");
    if (existsSync(p)) {
      try {
        results.push({ path: p, content: await fs.readFile(p, "utf8") });
      } catch {
        // 忽略读失败
      }
    }
    if (dir === path.dirname(dir)) break; // 到 root
  }

  return results;
}

// --- skill-guidance source ---
// 文档 04/08：只列 skill 清单（name + description），不加载内容。
export interface SkillGuidanceValue {
  skills: Array<{ name: string; description: string }>;
}

function renderSkillGuidance(v: SkillGuidanceValue): string {
  if (v.skills.length === 0) return "";
  const items = v.skills
    .map(
      (s) =>
        `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`
    )
    .join("\n");
  return `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
${items}
</available_skills>`;
}

export function makeSkillGuidanceSource(getSkills: () => Promise<Array<{ name: string; description: string }>>): Source<SkillGuidanceValue> {
  return {
    key: "core/skill-guidance",
    async observe() {
      try {
        const skills = await getSkills();
        return { _tag: "available", value: { skills } };
      } catch {
        return { _tag: "unavailable", reason: "skill load failed" };
      }
    },
    equal(a, b) {
      if (a.skills.length !== b.skills.length) return false;
      return a.skills.every(
        (s, i) =>
          s.name === b.skills[i].name && s.description === b.skills[i].description
      );
    },
    renderBaseline(v) {
      const r = renderSkillGuidance(v);
      return r ? `Here are the skills available to you:\n${r}` : "";
    },
    renderUpdate(v) {
      const r = renderSkillGuidance(v);
      if (!r) return "No skills are available.";
      return `The following list of available skills supersedes the previous available skills list:\n${r}`;
    },
    renderRemoved() {
      return "Skill guidance no longer applies.";
    },
    encode(v) {
      return v;
    },
    decode(raw) {
      if (raw && typeof raw === "object" && Array.isArray((raw as any).skills)) {
        return raw as SkillGuidanceValue;
      }
      return null;
    },
  };
}
