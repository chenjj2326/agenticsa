// Real API End-to-End 测试
// 用 ZhiPuProvider 跑通完整应用流程
//
// 用法：MYAGENT_API_KEY=xxx npx tsx src/test-e2e-real.ts

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { Application } from "./core/application.js";
import type { TurnEvent } from "./core/agent/turn.js";
import type { PendingRequest, Reply } from "./core/tool/permission.js";

const API_KEY = process.env.MYAGENT_API_KEY;
if (!API_KEY) {
  console.error("MYAGENT_API_KEY not set");
  process.exit(1);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForDrain(app: Application, sessionId: string, maxMs = 60_000) {
  const start = Date.now();
  while (app.coordinator.active(sessionId).length > 0) {
    await sleep(50);
    if (Date.now() - start > maxMs) {
      throw new Error(`drain timeout after ${maxMs}ms`);
    }
  }
}

async function runScenario(
  name: string,
  app: Application,
  session: { sessionId: string },
  input: string,
  expectToolCall?: boolean
) {
  console.log(`\n--- ${name} ---`);
  console.log(`> ${input}`);
  const hist = app.getSession(session.sessionId)!.history;
  const beforeLen = hist.all().length;
  await app.getSession(session.sessionId)!.admitInput(input, "queue");
  await waitForDrain(app, session.sessionId);

  const newMessages = hist.all().slice(beforeLen);
  const newAssistants = newMessages.filter(
    (m: any) => m.variant === "assistant"
  );
  if (newAssistants.length === 0) {
    throw new Error(`${name}: no assistant message produced`);
  }
  const hasToolCall = newAssistants.some((a: any) =>
    a.parts.some((p: any) => p.type === "tool-call")
  );
  const lastAssistant: any = newAssistants[newAssistants.length - 1];
  const text = lastAssistant.parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("");
  console.log(
    `  → assistant: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`
  );
  console.log(`  → tool-call: ${hasToolCall} (${newAssistants.length} assistant msg(s))`);
  if (expectToolCall !== undefined && expectToolCall !== hasToolCall) {
    throw new Error(
      `${name}: expected tool-call=${expectToolCall} but got ${hasToolCall}`
    );
  }
  return { text, hasToolCall };
}

async function main() {
  const cwd = process.cwd();
  const globalConfigDir = path.join(os.homedir(), ".myagent");
  if (!fs.existsSync(globalConfigDir)) {
    fs.mkdirSync(globalConfigDir, { recursive: true });
  }

  console.log("=".repeat(60));
  console.log("MyAgent Real API E2E Test (ZhiPu)");
  console.log("=".repeat(60));

  const app = new Application({
    cwd,
    globalConfigDir,
    model: "glm-4-flash",
    defaultAgent: "build",
    provider: "zhipu",
    apiKey: API_KEY,
  });

  app.setAskHandler(async (req: PendingRequest): Promise<Reply> => {
    console.log(`  [auto-allow] ${req.action} ${req.resources.join(", ")}`);
    return { type: "allow" };
  });

  const events: TurnEvent[] = [];
  const session = await app.createSession({
    agentId: "build",
    onEvent: (e: TurnEvent) => {
      events.push(e);
    },
  });

  console.log(`Session: ${session.sessionId}`);

  // === Test 1: Simple text (greeting) ===
  await runScenario("greeting", app, session, "hello", false);

  // === Test 2: Tool call - list files ===
  await runScenario("list files", app, session, "list files", true);

  // === Test 3: Read a file ===
  await runScenario("read file", app, session, "read me README.md", true);

  // === Cost ===
  const usage = session.getUsage();
  console.log("\n=== Final Session Cost ===");
  console.log(`  Total cost: $${usage.cost}`);
  console.log(`  Input tokens: ${usage.tokens_input}`);
  console.log(`  Output tokens: ${usage.tokens_output}`);
  console.log(`  Total messages: ${session.history.all().length}`);

  console.log("\n=== Real API E2E tests passed ✓ ===");
}

main().catch((e) => {
  console.error("Real API E2E test failed:", e);
  process.exit(1);
});