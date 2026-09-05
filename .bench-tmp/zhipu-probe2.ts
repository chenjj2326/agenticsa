// probe2：复刻真实场景二分定位——glm-4-flash 为何不发 tool_calls
//   A: 11 工具 + build system + 真实 issue user message（完整复刻）
//   B: 11 工具 + build system + 简短 user（对照）
//   C: 1 工具(bash) + build system + 真实 issue user message
//   D: 11 工具 + 强 system + 真实 issue user message
import * as fs from "node:fs";
import { Application } from "../src/core/application.js";
import { registerBuiltinTools } from "../src/core/tool/builtin.js";
import { ToolRegistry } from "../src/core/tool/registry.js";
import { ZhiPuProvider } from "../src/provider/zhipu-provider.js";

const inst = fs
  .readFileSync("swebench_verified.jsonl", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .find((i: any) => i.instance_id === "pallets__flask-5014")!;

const realUserMsg = `You are solving a real GitHub issue in the repository at your current working directory.

<issue>
${inst.problem_statement}
</issue>

Instructions:
- Use your tools (bash/grep/glob/read/edit) to investigate the code, locate the root cause, and implement a minimal fix.
- You MUST make the change by calling tools. A plain-text answer without tool calls will score zero.
- Do NOT modify existing test files.
- Dependencies may not be installed in this environment; running the project's full test suite may fail. Prioritize making the correct code change.
- All saved file edits will be collected via \`git diff\` when you finish, so make sure every change is written to disk.

Begin now: make a tool call to explore the repository.
`;

const app = new Application({ cwd: process.cwd(), provider: "mock", model: "mock-large" });
const registry = new ToolRegistry(app.appTools);
registerBuiltinTools(registry);
const agent = app.getAgent("build")!;
const { definitions } = registry.materialize(agent.permissions);

const allTools = definitions.map((d) => ({
  type: "function" as const,
  function: { name: d.name, description: d.description, parameters: d.inputSchema },
}));
const bashOnly = allTools.filter((t) => t.function.name === "bash");

const strongSystem =
  "You are a coding agent working in a git repository. You MUST interact with the environment exclusively through function calls (tools). When you want to run a command, call the bash tool. When you want to see a file, call the read tool. Never write out a command as plain text: plain text is only for talking to the user, it cannot execute anything.";

async function runCase(name: string, tools: any[], system: string[], user: string) {
  const provider = new ZhiPuProvider(process.env.MYAGENT_API_KEY ?? "");
  const req = {
    model: "glm-4-flash",
    system,
    messages: [{ role: "user" as const, content: user }],
    tools,
    toolChoice: "auto" as const,
  };
  let text = "";
  let toolCalls: string[] = [];
  let stop = "";
  try {
    for await (const ev of provider.stream(req as any)) {
      if (ev.type === "text-delta") text += ev.text;
      else if (ev.type === "tool-call") toolCalls.push(`${ev.name}(${JSON.stringify(ev.args).slice(0, 60)})`);
      else if (ev.type === "finish") stop = ev.stopReason;
      else if (ev.type === "error") stop = `ERROR:${ev.error}`;
    }
  } catch (e: any) {
    stop = `THROW:${e.message}`;
  }
  console.log(`--- case ${name}: stop=${stop} tools=[${toolCalls.join(", ")}]`);
  if (toolCalls.length === 0) console.log(`    text: ${JSON.stringify(text.slice(0, 120))}`);
}

async function main() {
  await runCase("A 11tools+buildsys+realmsg", allTools, [agent.system], realUserMsg);
  await runCase("B 11tools+buildsys+shortmsg", allTools, [agent.system], "List the files in the current directory.");
  await runCase("C bashonly+buildsys+realmsg", bashOnly, [agent.system], realUserMsg);
  await runCase("D 11tools+strongsys+realmsg", allTools, [strongSystem], realUserMsg);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
