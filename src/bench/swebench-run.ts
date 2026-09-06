#!/usr/bin/env node
// SWE-bench 批量 runner —— 把 MyAgent 接入 SWE-bench 评测
//
// 流程（每个 instance）：
//   1. clone repo（本地缓存）→ git worktree checkout base_commit
//   2. Application(cwd=worktree) + headless 自动放行
//   3. admitInput(problem_statement) → 等 drain
//   4. git add -A + git diff --cached → model_patch
//   5. 追加写 predictions.jsonl（已写过的 instance_id 自动跳过，支持断点续跑）
//
// 评分（官方 harness，在 WSL/Linux + Docker 里跑）：
//   python -m swebench.harness.run_evaluation \
//     --dataset_name princeton-nlp/SWE-bench_Verified \
//     --predictions_path predictions.jsonl \
//     --run_id myagent-v1 --max_workers 4
//
// 用法示例（注意：Windows 上 npm run 会吞掉 --flag 前缀，直接用 npx tsx 调用）：
//   npx tsx src/bench/swebench-run.ts --dataset swebench_verified.jsonl --limit 10
//   npx tsx src/bench/swebench-run.ts --subset lite --instances django__django-11039
//   MYAGENT_API_KEY=xxx npx tsx src/bench/swebench-run.ts --provider zhipu --model glm-4-flash --limit 20
//
// dataset JSONL 导出（有 python 的环境执行一次；也可不加 --dataset 自动从 HF 拉）：
//   python -c "
//     from datasets import load_dataset
//     import json
//     ds = load_dataset('princeton-nlp/SWE-bench_Verified', split='test')
//     with open('swebench_verified.jsonl', 'w', encoding='utf-8') as f:
//         for r in ds:
//             f.write(json.dumps(dict(r)) + '\n')
//   "
//
// 注意：bench 工作目录默认在 ~/.myagent-bench（MyAgent 项目外）。
//   SystemContext 会从 cwd 一路向上搜索 AGENTS.md，放在项目内会把
//   MyAgent 自己的 AGENTS.md 泄漏进评测上下文。

import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Application } from "../core/application.js";
import type { TurnEvent } from "../core/agent/turn.js";

const execFileAsync = promisify(execFile);

// --- 类型 ---

interface SWEInstance {
  instance_id: string;
  base_commit: string;
  repo: string; // "django/django"
  problem_statement: string;
}

interface RunOptions {
  workdir: string;
  provider: "mock" | "zhipu" | "openai";
  apiKey?: string;
  baseURL?: string;
  selfCheck: boolean;
  model: string;
  maxSteps: number;
  timeoutMs: number;
  timeoutMin: number;
  keepWorktree: boolean;
  temperature: number;
}

interface InstanceResult {
  instanceId: string;
  patch: string;
  ok: boolean; // true = drain 正常结束；false = 超时被中断
  usage?: any;
}

// --- shell helper（git 全部用 execFile，避免 shell 转义问题）---

async function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

// --- 数据集加载 ---

async function loadJsonl(p: string): Promise<SWEInstance[]> {
  const text = await fs.readFile(p, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// 从 HuggingFace datasets-server 分页拉取（无需 python）
async function fetchFromHF(subset: string): Promise<SWEInstance[]> {
  const dataset =
    subset === "lite"
      ? "princeton-nlp/SWE-bench_Lite"
      : "princeton-nlp/SWE-bench_Verified";
  const out: SWEInstance[] = [];
  const pageSize = 100;
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const url =
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}` +
      `&config=default&split=test&offset=${offset}&length=${pageSize}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e: any) {
      throw new Error(
        `无法连接 HuggingFace datasets-server（${e?.cause?.code ?? e?.message ?? e}）。国内网络通常无法直连 HF：
  1) 推荐：先导出本地 JSONL 再 --dataset 指定（见文件头注释，可用 HF_ENDPOINT=https://hf-mirror.com 加速）
  2) 有代理时设置 HTTPS_PROXY/HTTP_PROXY 后重试`
      );
    }
    if (!res.ok) {
      throw new Error(
        `HuggingFace datasets-server 请求失败 (${res.status})。国内网络可能无法直连 HF：
  1) 推荐：先导出本地 JSONL 再 --dataset 指定（见文件头注释，可用 HF_ENDPOINT=https://hf-mirror.com 加速）
  2) 有代理时设置 HTTPS_PROXY/HTTP_PROXY 后重试`
      );
    }
    const data: any = await res.json();
    total = data.num_rows_total ?? offset + data.rows.length;
    for (const r of data.rows) out.push(r.row);
    offset += data.rows.length;
    if (data.rows.length === 0) break;
  }
  return out;
}

// --- git：repo 缓存 + worktree ---

// 准备阶段（clone/worktree）失败：不写 prediction，下次重试
class PrepError extends Error {}

async function ensureRepo(repoFull: string, reposDir: string): Promise<string> {
  const dir = path.join(reposDir, repoFull.replace("/", "__"));
  if (existsSync(path.join(dir, ".git"))) return dir;
  if (existsSync(dir)) await fs.rm(dir, { recursive: true, force: true }); // 半残 clone 清掉重来
  await fs.mkdir(reposDir, { recursive: true });
  // 国内对 github 的 HTTPS 时好时坏，clone 失败重试 3 次
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`    cloning https://github.com/${repoFull}.git (attempt ${attempt}/3) ...`);
    try {
      await sh("git", ["clone", "--quiet", `https://github.com/${repoFull}.git`, dir], {
        timeoutMs: 15 * 60_000,
      });
      return dir;
    } catch (e: any) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (attempt === 3) {
        throw new PrepError(`clone ${repoFull} failed after 3 attempts: ${String(e.message).slice(0, 200)}`);
      }
      await new Promise((r) => setTimeout(r, attempt * 5_000));
    }
  }
  throw new PrepError("unreachable");
}

async function makeWorktree(
  repoDir: string,
  baseCommit: string,
  wtDir: string
): Promise<void> {
  try {
    // 先强制卸载（上次崩溃会留下 prunable 半残 worktree）
    await sh("git", ["worktree", "remove", "--force", wtDir], {
      cwd: repoDir,
      timeoutMs: 2 * 60_000,
    }).catch(() => {});
    await sh("git", ["worktree", "prune"], { cwd: repoDir }).catch(() => {});
    await fs.rm(wtDir, { recursive: true, force: true }).catch(() => {});
    await sh("git", ["worktree", "add", "--quiet", "--detach", wtDir, baseCommit], {
      cwd: repoDir,
      timeoutMs: 5 * 60_000,
    });
  } catch (e: any) {
    throw new PrepError(`worktree ${baseCommit} failed: ${String(e.message).slice(0, 400)}`);
  }
}

async function dropWorktree(repoDir: string, wtDir: string): Promise<void> {
  try {
    await sh("git", ["worktree", "remove", "--force", wtDir], { cwd: repoDir });
  } catch {
    // ignore——worktree 留着不影响下次（makeWorktree 会先 rm + prune）
  }
}

// patch 提取：add -A 把新建文件也算进来，再取 staged diff。
// 加重试 + 降级：并发 git 操作可能短暂持有 index 锁；add 失败时
// 用 `git diff HEAD`（不依赖 index，仍能捕获已跟踪文件的修改）兜底。
// 把 worktree 里的 *.patch / *.diff 文件内容真正应用到源码上，然后删掉这些文件。
// 典型场景：qwen/glm 偶尔把 edit 计划序列化成 patch 文本写入 temp.patch，
// 直接提取 diff 会得到“只新增一个 patch 文件”的无效补丁。
async function normalizePatchFiles(wtDir: string): Promise<void> {
  let out: string;
  try {
    out = await sh(
      "git",
      ["ls-files", "--others", "--cached", "--exclude-standard", "--", "*.patch", "*.diff"],
      { cwd: wtDir }
    );
  } catch {
    return;
  }
  const files = out.trim() ? out.trim().split("\n").map((s) => s.trim()).filter(Boolean) : [];
  for (const f of files) {
    const abs = path.join(wtDir, f);
    try {
      // git apply 对无尾换行的嵌套 diff 会失败，补一个换行再 apply
      let text = await fs.readFile(abs, "utf8");
      if (!text.endsWith("\n")) {
        text += "\n";
        await fs.writeFile(abs, text, "utf8");
      }
      await sh("git", ["apply", "--whitespace=nowarn", f], { cwd: wtDir });
    } catch {
      // apply 失败就放弃该文件，只保证它不进最终 diff
    }
  }
  if (files.length > 0) {
    await sh("git", ["add", "-A"], { cwd: wtDir }).catch(() => {});
    await sh("git", ["rm", "-f", "--quiet", ...files], { cwd: wtDir }).catch(async () => {
      for (const f of files) await fs.rm(path.join(wtDir, f), { force: true }).catch(() => {});
    });
  }
}

async function extractPatch(wtDir: string): Promise<string> {
  // 归一化：模型有时不直接编辑源码，而是把“补丁的补丁”写成 *.patch / *.diff 文件。
  // 若最终 diff 只涉及这类文件，先把它们 git apply 到源码上、删除文件、重新提取。
  await normalizePatchFiles(wtDir);
  let addOk = false;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sh("git", ["add", "-A"], { cwd: wtDir });
      addOk = true;
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  if (addOk) {
    // 排除 agent 自建的临时验证脚本（reproduce_*.py / test_*.py / simple_test.py 等）：
    // 它们是新增文件、不属于修复本身，混进 patch 会污染 diff（django-10097 实测混入 6 个）。
    // 黄金 patch 从不新增测试文件，所以排除"新增且名字像测试/验证脚本"的文件是安全的。
    try {
      const added = await sh(
        "git",
        ["diff", "--cached", "--name-only", "--diff-filter=A"],
        { cwd: wtDir }
      );
      const junk = added
        .split("\n")
        .map((s) => s.trim())
        .filter(
          (f) =>
            f &&
            // 结构性规则：仓库根目录新增的 .py 一定是 agent 临时脚本
            // （django/flask/requests 的真修复都在包目录 django/ src/ requests/ 下），
            // 名字黑名单追不完——analyze_regex.py / better_test.py 都漏过
            (!f.includes("/") && /\.py$/i.test(f)) ||
            /(^|\/)(test|reproduce|check|verify|debug|simple)[\w.-]*\.py$/i.test(f) ||
            /_test\.py$/i.test(f) ||
            // tests/ 目录下的新增 .py 也是 agent 临时脚本（gold 的 F2P 测试由评分器
            // 单独打 test_patch，模型 patch 里不应出现；glm-5.3-flash 混入过 tests/rtd.py）
            /(^|\/)tests\/[\w./-]*\.py$/i.test(f)
        );
      for (const f of junk) {
        await sh("git", ["reset", "-q", "HEAD", "--", f], { cwd: wtDir });
      }
      if (junk.length) {
        console.log(`    [extractPatch] excluded ${junk.length} agent-created test script(s)`);
      }
    } catch {
      // 排除失败不影响主流程
    }
    const diff = await sh("git", ["diff", "--cached"], { cwd: wtDir });
    const trimmed = diff.trim();
    if (trimmed) return trimmed;
  }
  // 降级路径：直接 diff HEAD（含未暂存改动；新文件未跟踪会漏掉，
  // 但绝大多数 SWE-bench 修复都是改已有文件）
  try {
    const diff = await sh("git", ["diff", "HEAD"], { cwd: wtDir });
    return diff.trim();
  } catch {
    throw lastErr ?? new Error("git diff failed");
  }
}

// --- Agent 阶段 ---

function buildUserMessage(inst: SWEInstance): string {
  return `You are solving a real GitHub issue in the repository at your current working directory.

<issue>
${inst.problem_statement}
</issue>

CRITICAL RULES — read carefully before responding.

1. First response MUST be a tool call — no preamble, no explanation. Call bash / glob / grep / read immediately.
2. Use one of these 6 tools. Every tool has a JSON schema; field names in the first column (underlined style) are preferred but camelCase and file_path aliases also work:

- bash(command)                       — run a shell command (pwd, git, ls, pip show, python -c, etc.)
- read(file_path) or read(path)       — return full file contents as text
- write(file_path, content)           — overwrite file with new content
- edit(file_path, old_string, new_string)  — exact-text-replace old_string with new_string in the file. old_string must appear literally in the file (copy from what read() returns, including spaces). Works on multiple occurrences.
- glob(pattern)                       — find files by glob e.g. "**/*.py", "tests/**/test_*.py"
- grep(pattern)                       — regex search across tracked files

3. Recommended workflow for every issue:
   a. Read relevant tests first (grep the bug keyphrase, then read the test file). Tests define exactly what behavior the fix must produce.
   b. Read the suspected source file(s) completely before editing.
   c. Apply an edit() with an exact old_string snippet taken from the file.
   d. Re-read the file after editing to verify the change.

4. Do NOT modify existing test files. Fix only production code.
4b. Keep the change MINIMAL. Fix exactly the reported behavior — do NOT refactor, rename, reformat, add features, or "improve" anything else. Unrelated behavior changes BREAK existing tests and fail the evaluation. Touch as few lines and files as possible.
4c. Before finishing, verify you did not break existing behavior: re-read your diff (bash: git diff) and check every change is strictly necessary for the fix. If a relevant existing test file is cheap to run (bash: python -m pytest <that test file> -x -q, or for django: python tests/runtests.py <module> ), run it and fix regressions you caused.
4d. Prove the fix with a closed-loop reproduction — intuition is not verification:
   - After locating the bug but BEFORE editing, write a minimal repro script named reproduce.py that triggers the exact error/behavior described in the issue. Run it (e.g. bash: <interpreter> reproduce.py) and confirm it reproduces the reported failure.
   - After each fix, re-run the SAME script. Your fix is valid ONLY if the repro outcome changes from failing to correct.
   - If the repro still fails after your edit, your change did NOT address the root cause. Do NOT keep tweaking nearby code or add workarounds. Instead: take the full traceback from the repro, find where the exception is actually raised inside the framework internals (read that file/function), and trace backwards to why the bad state reaches that raise site. The raise site and the component that must be fixed are often in DIFFERENT layers.
   - Keep reproduce.py in the repo root; it is excluded from the final patch automatically.
5. If a tool returns an ERROR message, read the message carefully and retry — don't pretend the change was applied.
   When edit() fails with "old_string not found", the error includes the actual file region with line numbers — copy old_string EXACTLY from that region (preserve every backslash, quote and indent), then retry.
6. When finished, ensure edits are written to disk. Final patch is collected via git diff.
7. The issue ALWAYS requires a production code change. Never conclude "it's a documentation issue" or "no code change needed" — if your first grep finds nothing, search at least 3 different keyword variants (error message text, function/class names from the issue, related test names) and inspect the test files.
8. Use as many steps as you need; do not stop until the code change implementing the fix has been successfully written to disk via edit().
9. NEVER create *.patch / *.diff / temp files containing diff text. Apply the fix by editing the production source files directly with edit(). Final patch is collected via git diff.

Begin now with a tool call (bash/glob/grep/read). First response must be a tool call only.`;
}

// 自查环节：agent 完成修复后，让它自己跑"改动所覆盖"的现有测试并修回归。
// 测试范围由 agent 根据改动自行确定（不使用评测集的 F2P/P2P 真值，避免泄题）。
const SELF_CHECK_PROMPT = `Your fix is applied. Before finishing, verify you did not break existing behavior:

1. Run bash: git diff — review every hunk you changed. Revert anything that is NOT strictly needed for the issue fix.
2. If you created a reproduction script (reproduce.py) earlier, re-run it now and confirm it now produces the CORRECT outcome. If it still fails, your fix does not address the root cause: take the full traceback, find where the exception is raised in framework internals, and fix at the correct layer instead of patching symptoms.
3. Run the existing tests that cover the code you changed. Pick the smallest relevant scope:
   - django repo: python tests/runtests.py <test labels matching the modules you touched>
   - pytest repos: python -m pytest <test files matching the modules you touched> -x -q
4. If a test fails because of your change, fix that regression while KEEPING the issue fix. Never modify test files to make them pass.
5. End with one short sentence: "self-check: <state>".`;

async function waitForDrain(
  coordinator: any,
  sessionId: string,
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  let lastBeat = 0;
  while (coordinator.active(sessionId).length > 0) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) return false;
    if (Date.now() - lastBeat > 30_000) {
      console.log(`    ...running (${Math.round(elapsed / 1000)}s)`);
      lastBeat = Date.now();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return true;
}

async function runInstance(
  inst: SWEInstance,
  opts: RunOptions
): Promise<InstanceResult> {
  const logsDir = path.join(opts.workdir, "logs");
  await fs.mkdir(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${inst.instance_id}.log`);
  const log = (s: string) =>
    void fs.appendFile(logFile, s + "\n", "utf8").catch(() => {});

  const repoDir = await ensureRepo(inst.repo, path.join(opts.workdir, "repos"));
  const wtDir = path.join(opts.workdir, "worktrees", inst.instance_id);
  await makeWorktree(repoDir, inst.base_commit, wtDir);

  try {
    // 内置工具（bash/read/write/glob/grep）都相对 process.cwd() 解析路径——
    // 切进 worktree，保证工具操作落在评测 repo 里（runner 严格串行，chdir 安全）
    process.chdir(wtDir);

    // globalConfigDir 指向 bench 专属干净目录：
    //   不复用 ~/.myagent（里面的 AGENTS.md 是用户个人约定，不该进评测上下文）
    const app = new Application({
      cwd: wtDir,
      globalConfigDir: path.join(opts.workdir, "config"),
      provider: opts.provider,
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      model: opts.model,
      maxSteps: opts.maxSteps,
      temperature: opts.temperature,
    });
    // headless 兜底：build agent 权限本就是 * 全 allow；
    // 这里保证万一走到 ask 分支不会挂死等 stdin
    app.setAskHandler(async () => ({ type: "allow" }));

    let textBuf = "";
    const session = await app.createSession({
      agentId: "build",
      onEvent: (e: TurnEvent) => {
        switch (e.type) {
          case "text-delta":
            textBuf += e.text;
            break;
          case "assistant-message":
            log(`[assistant] ${textBuf.trim()}`);
            textBuf = "";
            break;
          case "tool-call":
            log(`[tool-call] ${e.name} ${JSON.stringify(e.args).slice(0, 800)}`);
            console.log(`    [tool] ${e.name}`);
            break;
          case "tool-result":
            log(
              `[tool-result] ${e.error ? "ERROR " : ""}${String(e.output).slice(0, 500)}`
            );
            break;
          case "compaction":
            log(`[compaction] ${e.summary.slice(0, 200)}`);
            break;
          case "epoch-rebuilt":
            log(`[epoch] rebuilt @${e.baselineSeq}`);
            break;
        }
      },
    });

    log(`# instance=${inst.instance_id} repo=${inst.repo} base=${inst.base_commit} model=${opts.model}`);
    await session.admitInput(buildUserMessage(inst), "queue");
    const drained = await waitForDrain(
      app.coordinator,
      session.sessionId,
      opts.timeoutMs
    );
    if (!drained) {
      console.log(`    timeout after ${opts.timeoutMin} min, interrupting...`);
      log(`[timeout] first round exceeded ${opts.timeoutMin} min, interrupted`);
      session.interrupt();
      // 等 drain 收尾（最多 2 分钟）
      await waitForDrain(app.coordinator, session.sessionId, 120_000);
    }

    // drain 可能抛了错（如 LLM 持续失败）——wake() 会存起来，这里查（读一次即清）
    const drainError = session.getDrainError();
    if (drainError) {
      throw new Error(
        `agent episode failed: ${drainError instanceof Error ? drainError.message : String(drainError)}`
      );
    }

    // 评分前自查：有 patch 且 drain 正常结束时，让 agent 自查改动是否破坏现有测试
    if (opts.selfCheck && drained) {
      const preDiff = await extractPatch(wtDir);
      if (preDiff.trim()) {
        log(`# self-check round`);
        await session.admitInput(SELF_CHECK_PROMPT, "queue");
        const drained2 = await waitForDrain(
          app.coordinator,
          session.sessionId,
          opts.timeoutMs
        );
        if (!drained2) {
          console.log(`    self-check timeout, interrupting...`);
          session.interrupt();
          await waitForDrain(app.coordinator, session.sessionId, 120_000);
        }
        const err2 = session.getDrainError();
        if (err2) {
          // 自查阶段失败不否决整个 episode：保留首轮 patch
          log(`[self-check] drain error (kept first-round patch): ${String(err2).slice(0, 200)}`);
        }
      }
    }

    const usage = session.getUsage();
    const patch = await extractPatch(wtDir);
    return { instanceId: inst.instance_id, patch, ok: drained, usage };
  } finally {
    if (opts.keepWorktree) {
      console.log(`    worktree kept: ${wtDir}`);
    } else {
      // 先离开 worktree：Windows 上进程 cwd 占用目录会导致 git worktree remove 失败
      try {
        process.chdir(opts.workdir);
      } catch {
        // ignore
      }
      await dropWorktree(repoDir, wtDir);
    }
  }
}

// --- CLI ---

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out[key] = argv[++i];
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // key 按 provider 分开取：MYAGENT_API_KEY 是智谱的，别发给 DashScope（401 教训）
  const apiKey = process.env.DASHSCOPE_API_KEY ?? process.env.OPENAI_API_KEY;
  const provider = ((args["provider"] as "mock" | "zhipu" | "openai") ??
    (apiKey ? "openai" : "mock")) as "mock" | "zhipu" | "openai";
  const model =
    args["model"] ??
    (provider === "zhipu" ? "glm-4-flash" : provider === "openai" ? "qwen3-coder-plus" : "mock-large");

  const workdir =
    args["workdir"] ?? path.join(os.tmpdir(), "swe_bench_work");
  const outPath = args["out"] ?? path.join(workdir, "out", "predictions.jsonl");
  const maxSteps = Number(args["max-steps"] ?? 60);
  const timeoutMin = Number(args["timeout-min"] ?? 45);
  const keepWorktree = args["keep-worktree"] === "true";
  // benchmark 场景建议用低温（0.1），减少模型漂移到纯文本回答
  const temperature = Number(args["temp"] ?? 0.1);

  const opts: RunOptions = {
    workdir,
    provider,
    apiKey: provider === "zhipu" ? process.env.MYAGENT_API_KEY : apiKey,
    baseURL: args["base-url"],
    model,
    maxSteps,
    timeoutMin,
    timeoutMs: timeoutMin * 60_000,
    keepWorktree,
    selfCheck: args["self-check"] !== "false",
    temperature,
  };

  // 数据
  let instances = args["dataset"]
    ? await loadJsonl(args["dataset"])
    : await fetchFromHF(args["subset"] ?? "verified");
  if (args["instances"]) {
    const ids = new Set(args["instances"].split(",").map((s) => s.trim()));
    instances = instances.filter((i) => ids.has(i.instance_id));
  }
  if (args["limit"]) instances = instances.slice(0, Number(args["limit"]));
  if (instances.length === 0) {
    console.error("No instances to run. Check --dataset / --subset / --instances / --limit.");
    process.exit(1);
  }

  // 断点续跑：读已有 predictions 里出现过的 instance_id
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const done = new Set<string>();
  if (existsSync(outPath)) {
    const text = await fs.readFile(outPath, "utf8");
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      try {
        done.add(JSON.parse(l).instance_id);
      } catch {
        // 忽略坏行
      }
    }
  }

  console.log("=".repeat(60));
  console.log(`SWE-bench runner | provider=${provider} model=${model} temp=${temperature}`);
  console.log(`maxSteps=${maxSteps} timeout=${timeoutMin}min workdir=${workdir}`);
  console.log(`instances: ${instances.length}, already done: ${done.size}`);
  console.log(`out: ${outPath}`);
  console.log("=".repeat(60));

  let okCount = 0;
  let emptyCount = 0;
  let timeoutCount = 0;
  let failCount = 0;

  for (const [idx, inst] of instances.entries()) {
    const tag = `[${idx + 1}/${instances.length}]`;
    if (done.has(inst.instance_id)) {
      console.log(`${tag} ${inst.instance_id} — already done, skip`);
      continue;
    }
    console.log(`${tag} ${inst.instance_id} (repo=${inst.repo})`);
    try {
      const r = await runInstance(inst, opts);
      await fs.appendFile(
        outPath,
        JSON.stringify({
          instance_id: inst.instance_id,
          model_name_or_path: model,
          model_patch: r.patch,
        }) + "\n",
        "utf8"
      );
      if (!r.ok) {
        timeoutCount++;
      } else if (!r.patch) {
        emptyCount++;
      } else {
        okCount++;
      }
      const u = r.usage ?? {};
      console.log(
        `    done: ok=${r.ok} patch=${r.patch ? `${r.patch.length}B` : "(empty)"} ` +
          `cost=$${(u.cost ?? 0).toFixed?.(4) ?? 0} in=${u.tokens_input ?? "?"} out=${u.tokens_output ?? "?"}`
      );
    } catch (e: any) {
      console.log(`    FAILED: ${e.message}`);
      failCount++;
      if (e instanceof PrepError) {
        // 准备阶段失败（网络等）——不写 prediction，下次重跑会重试
        continue;
      }
      // agent 阶段失败也写一条空 patch，保证 harness 报告覆盖该 instance
      await fs.appendFile(
        outPath,
        JSON.stringify({
          instance_id: inst.instance_id,
          model_name_or_path: model,
          model_patch: "",
        }) + "\n",
        "utf8"
      );
    }
  }

  console.log("=".repeat(60));
  console.log(
    `All done. ok=${okCount} emptyPatch=${emptyCount} timeout=${timeoutCount} failed=${failCount}`
  );
  console.log(`Predictions: ${outPath}`);
  console.log(
    `Next: Score via official harness (WSL/Linux + Docker):
  python -m swebench.harness.run_evaluation \\
    --dataset_name princeton-nlp/SWE-bench_Verified \\
    --predictions_path ${outPath} \\
    --run_id myagent-v1 --max_workers 4`
  );
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

// 安全网：drain 链路的 rejection 可能不经过 await（coordinator 内部 reject），
// 进程级兜住，避免一个 instance 的 LLM 错误炸掉整批跑分。
// 失败信息仍由 session.getDrainError() 路径正常报告。
process.on("unhandledRejection", (reason) => {
  console.log(
    `    [unhandledRejection swallowed] ${reason instanceof Error ? reason.message : String(reason)}`
  );
});
