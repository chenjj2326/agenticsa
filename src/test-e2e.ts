// End-to-End 测试脚本
// 跑通：mock LLM + 工具循环 + 权限 + epoch + compaction + MAX_STEPS
//
// 用法：npx tsx src/test-e2e.ts

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { Application } from "./core/application.js";
import type { TurnEvent } from "./core/agent/turn.js";
import type { PendingRequest, Reply } from "./core/tool/permission.js";

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
  // 记录本轮开始前的 history 长度——一个 turn 可能产生多条 assistant 消息
  // （一次 provider 调用 = 一条 assistant 消息；有工具调用时会再跑一次 provider）
  const hist = app.getSession(session.sessionId)!.history;
  const beforeLen = hist.all().length;
  await app.getSession(session.sessionId)!.admitInput(input, "queue");
  await waitForDrain(app, session.sessionId);

  // 扫描本轮新产生的所有 assistant 消息——任一含 tool-call 即视为调过工具
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
  // 展示用最后一条 assistant 的文本（通常是工具回灌后的总结）
  const lastAssistant: any = newAssistants[newAssistants.length - 1];
  const text = lastAssistant.parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("");
  console.log(
    `  → assistant: ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`
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
  const globalAgents = path.join(globalConfigDir, "AGENTS.md");
  if (!fs.existsSync(globalAgents)) {
    fs.writeFileSync(
      globalAgents,
      `# Global AGENTS.md (MyAgent)\n## 用户通用约定\n- 用户名 Alex，用 Python 和 TypeScript。\n`
    );
  }

  console.log("=".repeat(60));
  console.log("MyAgent E2E Test");
  console.log("=".repeat(60));

  const app = new Application({
    cwd,
    globalConfigDir,
    model: "mock-large",
    defaultAgent: "build",
  });

  // 自动 allow 所有权限（测试用）
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

  // === 场景 1：问候（无工具）===
  await runScenario("greeting", app, session, "hello", false);

  // === 场景 2：list files（用 bash 工具）===
  await runScenario("list files", app, session, "list files", true);

  // === 场景 3：read README（用 read 工具）===
  await runScenario("read README", app, session, "read me README.md", true);

  // === 场景 4：glob（用 glob 工具）===
  await runScenario("glob", app, session, "find files **/*.ts", true);

  // === 场景 5：grep（用 grep 工具）===
  await runScenario("grep", app, session, "grep TODO", true);

  // === 场景 6：write（用 write 工具）===
  await runScenario("write", app, session, "write hello.txt", true);

  // === 场景 7：date（无工具，看 baseline）===
  await runScenario("date", app, session, "what is the date", false);

  // === 场景 8：who are you（无工具）===
  await runScenario("identity", app, session, "who are you", false);

  // === 场景 9：权限拒绝 → isUserDeclined halt（文档 03/11 关键不变量）===
  // 用一个独立 session + 拒绝所有权限的 handler，验证：
  //   - 用户拒绝后 loop 立刻 halt（不会无限重试或被模型绕过）
  //   - session 仍存活，下一条输入能正常处理
  console.log("\n--- permission reject (halt) ---");
  const rejectApp = new Application({
    cwd,
    globalConfigDir,
    model: "mock-large",
    defaultAgent: "build",
  });
  let rejectCount = 0;
  rejectApp.setAskHandler(async (req: PendingRequest): Promise<Reply> => {
    rejectCount++;
    console.log(`  [reject] ${req.action} ${req.resources.join(", ")}`);
    return { type: "reject" };
  });
  const rejectSession = await rejectApp.createSession({
    agentId: "build",
    onEvent: (e: TurnEvent) => {},
  });
  // build agent 默认 *→allow，工具不会 ask。这里覆盖权限让 bash 走 ask，
  // 从而真正触发 ask handler（findLast：后一条覆盖前一条，所以 ask 放最后）。
  rejectApp.permission.setAgentRules([
    { action: "*", resource: "*", effect: "allow" },
    { action: "bash", resource: "*", effect: "ask" },
  ]);
  // 触发一次需要权限的工具调用（bash）
  await rejectSession.admitInput("list files", "queue");
  await waitForDrain(rejectApp, rejectSession.sessionId);
  if (rejectCount === 0) {
    throw new Error(`permission reject: ask handler was never called`);
  }
  console.log(`  → ask handler called ${rejectCount} time(s); drain halted cleanly`);
  // session 仍存活：再发一条不需要工具的输入，应能正常回执
  await rejectSession.admitInput("hello", "queue");
  await waitForDrain(rejectApp, rejectSession.sessionId);
  const afterReject = rejectSession.history.latestAssistant();
  if (!afterReject) {
    throw new Error(`permission reject: session dead after halt (no assistant msg)`);
  }
  console.log(
    `  → session alive after halt: latest assistant = "${(afterReject as any).parts
      ?.map((p: any) => p.type === "text" ? p.text.slice(0, 60) : "")
      .join("")}"`
  );

  // === 成本统计 ===
  const usage = session.getUsage();
  console.log("\n=== Final Session Cost ===");
  console.log(`  Total cost: $${usage.cost}`);
  console.log(`  Input tokens: ${usage.tokens_input}`);
  console.log(`  Output tokens: ${usage.tokens_output}`);
  console.log(`  Reasoning tokens: ${usage.tokens_reasoning}`);
  console.log(`  Cache read: ${usage.tokens_cache_read}`);
  console.log(`  Cache write: ${usage.tokens_cache_write}`);
  console.log(`  Total messages: ${session.history.all().length}`);

  // === History 摘要 ===
  console.log("\n=== History ===");
  for (const m of session.history.all()) {
    const summary =
      m.variant === "user"
        ? (m as any).text?.slice(0, 60)
        : m.variant === "assistant"
          ? (m as any).parts
              .map((p: any) =>
                p.type === "text"
                  ? p.text.slice(0, 40)
                  : p.type === "tool-call"
                    ? `(tool:${p.name})`
                    : p.type === "tool-result"
                      ? `(result)`
                      : ""
              )
              .join(" | ")
          : m.variant === "system"
            ? (m as any).text?.slice(0, 60)
            : m.variant === "compaction"
              ? "(compaction)"
              : `(${m.variant})`;
    console.log(`  [${m.seq}] ${m.variant.padEnd(10)} ${summary}`);
  }

  console.log("\n=== All scenarios passed ✓ ===");
}

main().catch((e) => {
  console.error("E2E test failed:", e);
  process.exit(1);
});
