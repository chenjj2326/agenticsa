#!/usr/bin/env node
// MyAgent CLI 入口
//
// 用法：
//   npm start                              # mock provider
//   npm start zhipu                        # 用智谱 API key（从环境变量 MYAGENT_API_KEY 取）
//   npm start zhipu glm-4-air              # 指定模型
//   MYAGENT_API_KEY=xxx npm start zhipu    # 环境变量传 key
//
// 也支持命令行参数：
//   npx tsx src/index.ts zhipu glm-4-flash

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as readline from "node:readline";
import { Application } from "./core/application.js";
import type { TurnEvent } from "./core/agent/turn.js";
import type { PendingRequest, Reply } from "./core/tool/permission.js";

async function main() {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  const globalConfigDir = path.join(os.homedir(), ".myagent");

  // 解析参数
  const providerArg = (argv[0] ?? "mock") as "mock" | "zhipu";
  const modelArg = argv[1];
  const apiKey = process.env.MYAGENT_API_KEY;

  // 初始化全局 config 目录
  if (!fs.existsSync(globalConfigDir)) {
    fs.mkdirSync(globalConfigDir, { recursive: true });
  }
  const globalAgents = path.join(globalConfigDir, "AGENTS.md");
  if (!fs.existsSync(globalAgents)) {
    fs.writeFileSync(
      globalAgents,
      `# Global AGENTS.md (MyAgent)
## 用户通用约定
- 用户名 Alex，用 Python 和 TypeScript。
- 沟通风格友好直接。
`
    );
  }

  // 根据 provider 确定默认 model
  let defaultModel: string | undefined = modelArg;
  if (!defaultModel) {
    defaultModel = providerArg === "zhipu" ? "glm-4-flash" : "mock-large";
  }

  console.log("=".repeat(60));
  console.log(`MyAgent — OpenCode-style agent (${providerArg} provider)`);
  console.log("=".repeat(60));
  console.log(`Working dir: ${cwd}`);
  console.log(`Global config: ${globalConfigDir}`);
  console.log(`Model: ${defaultModel}`);
  if (providerArg === "zhipu") {
    if (apiKey) {
      console.log(`API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
    } else {
      console.log("⚠️  未设置 MYAGENT_API_KEY 环境变量，将退回 mock provider");
    }
  }
  console.log("Commands: <text> to send | :quit | :history | :cost | :sessions | :interrupt | :resume");
  console.log("=".repeat(60));

  const effectiveProvider: "mock" | "zhipu" =
    providerArg === "zhipu" && apiKey ? "zhipu" : "mock";

  const app = new Application({
    cwd,
    globalConfigDir,
    model: defaultModel,
    defaultAgent: "build",
    provider: effectiveProvider,
    apiKey: effectiveProvider === "zhipu" ? apiKey : undefined,
  });

  // 设置权限 ask handler
  const isTTY = process.stdin.isTTY ?? false;
  const rlRef: { rl: readline.Interface | null } = { rl: null };

  app.setAskHandler(async (req: PendingRequest): Promise<Reply> => {
    return new Promise<Reply>((resolve) => {
      const question = `\n[permission] ${req.action} ${req.resources.join(", ")}\nAllow? [y]es / [a]lways / [n]o (reject): `;
      const rl = rlRef.rl;
      if (!rl) {
        resolve({ type: "allow" });
        return;
      }
      rl.question(question, (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === "a" || a === "always") {
          resolve({
            type: "always",
            save: { action: req.action, resource: req.resources[0] ?? "*", effect: "allow" },
          });
        } else if (a === "n" || a === "no" || a === "reject") {
          resolve({ type: "reject" });
        } else {
          resolve({ type: "allow" });
        }
      });
    });
  });

  // 创建 session
  const session = await app.createSession({
    agentId: "build",
    onEvent: (e: TurnEvent) => {
      switch (e.type) {
        case "text-delta":
          process.stdout.write(e.text);
          break;
        case "reasoning-delta":
          break;
        case "tool-call":
          console.log(`\n  [tool-call] ${e.name}(${JSON.stringify(e.args).slice(0, 100)})`);
          break;
        case "tool-result":
          if (e.error) {
            console.log(`  [tool-result] error: ${typeof e.output === "string" ? e.output.slice(0, 200) : "(error)"}`);
          }
          break;
        case "permission-asked":
          break;
        case "assistant-message":
          console.log();
          break;
        case "step-ended":
          break;
        case "compaction":
          console.log(`\n  [compaction] ${e.summary}`);
          break;
        case "epoch-rebuilt":
          console.log(`\n  [epoch] rebuilt at seq ${e.baselineSeq}`);
          break;
        case "context-updated":
          console.log(`\n  [context] updated: ${e.updates.length} update(s)`);
          break;
      }
    },
  });

  console.log(`\nSession ${session.sessionId} created.`);
  console.log();

  const agentsMd = await loadAgentsMdForDisplay(cwd, globalConfigDir);
  if (agentsMd.length > 0) {
    console.log("Loaded AGENTS.md:");
    for (const f of agentsMd) {
      console.log(`  - ${f}`);
    }
    console.log();
  }

  // 所有异步 setup 完成——此刻才创建 readline 并立即进入消费循环
  rlRef.rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
  });
  const rl = rlRef.rl;

  const prompt = () => process.stdout.write("> ");
  prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      prompt();
      continue;
    }

    if (input.startsWith(":")) {
      const cmd = input.slice(1).toLowerCase();
      switch (cmd) {
        case "quit":
        case "exit":
          console.log("Goodbye!");
          process.exit(0);
          break;
        case "history":
          console.log(`\n=== History (${session.history.all().length} messages) ===`);
          for (const m of session.history.all()) {
            const summary = summarizeMessage(m);
            console.log(`  [${m.seq}] ${m.variant.padEnd(10)} ${summary}`);
          }
          console.log();
          break;
        case "cost":
          const usage = session.getUsage();
          console.log(`\n=== Session Cost ===`);
          console.log(`  Total: $${usage.cost}`);
          console.log(`  Input tokens: ${usage.tokens_input}`);
          console.log(`  Output tokens: ${usage.tokens_output}`);
          console.log(`  Reasoning tokens: ${usage.tokens_reasoning}`);
          console.log(`  Cache read: ${usage.tokens_cache_read}`);
          console.log(`  Cache write: ${usage.tokens_cache_write}`);
          console.log();
          break;
        case "sessions":
          console.log(`\n=== Sessions ===`);
          for (const id of app.listSessions()) {
            console.log(`  - ${id}`);
          }
          console.log();
          break;
        case "interrupt":
          session.interrupt();
          console.log("[interrupted]");
          break;
        case "resume":
          await session.resume();
          console.log("[resumed]");
          break;
        case "help":
          console.log("\nCommands: <text> | :quit | :history | :cost | :sessions | :interrupt | :resume | :help");
          break;
        default:
          console.log(`Unknown command: :${cmd} (try :help)`);
      }
      prompt();
      continue;
    }

    try {
      await session.admitInput(input, "queue");
      await waitForDrain(app.coordinator, session.sessionId);
    } catch (e: any) {
      console.log(`\n[error] ${e.message}`);
    }
    prompt();
  }
}

function summarizeMessage(m: any): string {
  switch (m.variant) {
    case "user":
    case "synthetic":
    case "system":
      return (m.text ?? "").slice(0, 80);
    case "assistant": {
      const parts = m.parts
        .map((p: any) => {
          if (p.type === "text") return p.text.slice(0, 50);
          if (p.type === "tool-call") return `(tool:${p.name})`;
          if (p.type === "tool-result") return `(result)`;
          return "";
        })
        .join(" | ");
      return parts.slice(0, 80);
    }
    case "compaction":
      return `(summary: ${(m.summary ?? "").slice(0, 60)})`;
    case "shell":
      return `${m.command}`;
    default:
      return `(${m.variant})`;
  }
}

async function loadAgentsMdForDisplay(cwd: string, globalConfigDir: string): Promise<string[]> {
  try {
    const { loadAgentsMdFiles } = await import("./core/memory/agents-md.js");
    const files = await loadAgentsMdFiles(cwd, globalConfigDir);
    return files.map((f) => f.path);
  } catch {
    return [];
  }
}

async function waitForDrain(coordinator: any, sessionId: string): Promise<void> {
  let waited = 0;
  while (coordinator.active(sessionId).length > 0 && waited < 60_000) {
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
