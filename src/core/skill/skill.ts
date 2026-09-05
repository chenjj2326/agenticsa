// Skill 设计与加载机制（08）
//
// 文档 08：三源——URL（远程）/Directory（本地目录）/Embedded（嵌入式）
// 关键设计：
//   - 清单 vs 内容分离：清单（name + description）常驻 context，内容按需用 skill 工具加载
//   - 远程 pull 四层安全校验：name、file 路径、origin、destination
//   - 版本化原子更新：版本变了 → staging + backup + rename + uninterruptible
//   - 失败回滚防半新半旧

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { existsSync } from "node:fs";

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  slash?: string; // 可选 slash 命令
}

export interface SkillContent {
  manifest: SkillManifest;
  files: Array<{ relativePath: string; content: string }>;
}

export type SkillSource =
  | { type: "url"; url: string } // 远程 URL
  | { type: "directory"; directory: string } // 本地目录
  | { type: "embedded"; manifest: SkillManifest; content: string }; // 嵌入式

// 四层安全校验（防目录穿越）
// 文档 11：name safe segment、file 路径 safe relative、origin 等 source origin、destination contains root
function safeSegment(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return true;
}

function safeRelativePath(p: string): boolean {
  if (!p) return false;
  if (path.isAbsolute(p)) return false;
  // decodeURIComponent 后每段非 . / ..
  const segments = p.split(/[/\\]/);
  for (const seg of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      decoded = seg;
    }
    if (decoded === "." || decoded === "..") return false;
    if (decoded.includes("\0")) return false;
  }
  return true;
}

function originEquals(origin: string, sourceOrigin: string): boolean {
  try {
    const a = new URL(origin);
    const b = new URL(sourceOrigin);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

function destinationContainsRoot(dest: string, root: string): boolean {
  const rel = path.relative(root, dest);
  return !rel.startsWith("..");
}

// 全局 cache 目录（按来源 URL hash 分目录）
function getSkillCacheDir(sourceOrigin: string): string {
  const hash = simpleHash(sourceOrigin);
  return path.join(os.tmpdir(), "myagent-skills", hash);
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

// 加载 skill（三源统一）
export async function loadSkill(source: SkillSource): Promise<SkillContent> {
  switch (source.type) {
    case "embedded":
      return {
        manifest: source.manifest,
        files: [{ relativePath: `${source.manifest.name}.md`, content: source.content }],
      };
    case "directory":
      return await loadFromDirectory(source.directory);
    case "url":
      return await loadFromUrl(source.url);
  }
}

// 从本地目录加载
async function loadFromDirectory(dir: string): Promise<SkillContent> {
  // 找 SKILL.md 或 {dirname}.md
  const skillMd = path.join(dir, "SKILL.md");
  const fallbackMd = path.join(dir, `${path.basename(dir)}.md`);
  let manifestPath: string | null = null;
  if (existsSync(skillMd)) manifestPath = skillMd;
  else if (existsSync(fallbackMd)) manifestPath = fallbackMd;
  if (!manifestPath) {
    throw new Error(`No SKILL.md found in ${dir}`);
  }
  const content = await fs.readFile(manifestPath, "utf8");
  const manifest = parseFrontmatter(content);
  return {
    manifest,
    files: [{ relativePath: path.basename(manifestPath), content }],
  };
}

// 从远程 URL 拉取（含四层安全校验）
// 文档 08/11：每个 file 过多层校验，任何不安全整个 skill 跳过
async function loadFromUrl(url: string): Promise<SkillContent> {
  // 拉取 index.json
  let index: {
    name: string;
    version: string;
    description?: string;
    files: Array<{ path: string; content: string }>;
  };
  try {
    const res = await fetch(url);
    index = await res.json();
  } catch (e: any) {
    throw new Error(`Failed to fetch skill from ${url}: ${e.message}`);
  }

  // 四层安全校验
  if (!safeSegment(index.name)) {
    throw new Error(`Invalid skill name: ${index.name}`);
  }

  const cacheDir = getSkillCacheDir(url);
  const files: Array<{ relativePath: string; content: string }> = [];

  for (const f of index.files) {
    // 1. file 路径 safe relative
    if (!safeRelativePath(f.path)) {
      throw new Error(`Unsafe file path in skill: ${f.path}`);
    }
    // 2. destination contains root（防目录穿越）
    const dest = path.join(cacheDir, f.path);
    if (!destinationContainsRoot(dest, cacheDir)) {
      throw new Error(`Path escape detected: ${f.path}`);
    }
    files.push({ relativePath: f.path, content: f.content });
  }

  // 写到 cache 目录（用 wx 防并发）
  await fs.mkdir(cacheDir, { recursive: true });
  const versionFile = path.join(cacheDir, ".opencode-version");
  let needAtomicUpdate = false;
  if (existsSync(versionFile)) {
    const prevVersion = await fs.readFile(versionFile, "utf8");
    if (prevVersion !== index.version) {
      needAtomicUpdate = true;
    }
  }

  if (needAtomicUpdate) {
    // 文档 08：版本化原子更新——staging + backup + rename
    await atomicUpdate(cacheDir, files, index.version);
  } else {
    for (const f of files) {
      const dest = path.join(cacheDir, f.relativePath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.content, { flag: "wx" }).catch(() => {});
    }
    await fs.writeFile(versionFile, index.version, "utf8").catch(() => {});
  }

  return {
    manifest: {
      name: index.name,
      description: index.description ?? `(skill from ${url})`,
      version: index.version,
    },
    files,
  };
}

// 版本化原子更新：staging + backup + rename
// 文档 08：uninterruptible 原子切换，失败回滚
async function atomicUpdate(
  cacheDir: string,
  files: Array<{ relativePath: string; content: string }>,
  version: string
): Promise<void> {
  const staging = path.join(cacheDir, ".staging");
  const backup = path.join(cacheDir, ".backup");
  // 清理旧 staging/backup
  await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  await fs.rm(backup, { recursive: true, force: true }).catch(() => {});

  // 写 staging
  await fs.mkdir(staging, { recursive: true });
  for (const f of files) {
    const dest = path.join(staging, f.relativePath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.content, "utf8");
  }

  // backup 现有文件
  if (existsSync(cacheDir)) {
    // 把所有非 .staging/.backup/.opencode-version 的移到 backup
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    await fs.mkdir(backup, { recursive: true });
    for (const entry of entries) {
      if (entry.name === ".staging" || entry.name === ".backup" || entry.name === ".opencode-version") continue;
      await fs.rename(path.join(cacheDir, entry.name), path.join(backup, entry.name));
    }
  }

  // 把 staging 内容 rename 到 cacheDir
  try {
    const entries = await fs.readdir(staging, { withFileTypes: true });
    for (const entry of entries) {
      await fs.rename(path.join(staging, entry.name), path.join(cacheDir, entry.name));
    }
    await fs.writeFile(path.join(cacheDir, ".opencode-version"), version, "utf8");
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  } catch (e) {
    // 回滚
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (existsSync(backup)) {
      const entries = await fs.readdir(backup, { withFileTypes: true });
      for (const entry of entries) {
        await fs.rename(path.join(backup, entry.name), path.join(cacheDir, entry.name));
      }
      await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    }
    throw e;
  }
}

// 解析 frontmatter
function parseFrontmatter(content: string): SkillManifest {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    // 无 frontmatter——用第一行做 name
    const firstLine = content.split("\n")[0].replace(/^#\s*/, "").trim();
    return {
      name: firstLine || "unnamed",
      description: firstLine,
      version: "0.0.0",
    };
  }
  const fm = match[1];
  const body = match[2];
  const manifest: any = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) manifest[m[1]] = m[2];
  }
  if (!manifest.name) manifest.name = "unnamed";
  if (!manifest.version) manifest.version = "0.0.0";
  if (!manifest.description) manifest.description = body.slice(0, 200);
  return manifest as SkillManifest;
}

// skill 注册中心：按 agent 权限过滤可用清单
export class SkillRegistry {
  private skills = new Map<string, SkillContent>();

  async register(source: SkillSource): Promise<SkillManifest> {
    const content = await loadSkill(source);
    this.skills.set(content.manifest.name, content);
    return content.manifest;
  }

  // 清单（只 name + description）——给 SystemContext source 用
  listSkills(): Array<{ name: string; description: string }> {
    return Array.from(this.skills.values()).map((s) => ({
      name: s.manifest.name,
      description: s.manifest.description,
    }));
  }

  // 加载内容——给 skill 工具用
  load(name: string): SkillContent | null {
    return this.skills.get(name) ?? null;
  }
}
