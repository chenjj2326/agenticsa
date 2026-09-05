// probe3：稳定性测试——相同输入（case A）跑 5 次，统计 tool_calls 比率
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

Begin now: make a tool call to explore the repository.
`;

const app = new Application({ cwd: process.cwd(), provider: "mock", model: "mock-large" });
const registry = new ToolRegistry(app.appTools);
registerBuiltinTools(registry);
const agent = app.getAgent("build")!;
const { definitions } = registry.materialize(agent.permissions);
const tools = definitions.map((d) => ({
  type: "function" as const,
  function: { name: d.name, description: d.description, parameters: d.inputSchema },
}));

async function main() {
  const provider = new ZhiPuProvider(process.env.MYAGENT_API_KEY ?? "");
  for (let i = 1; i <= 5; i++) {
    const req = {
      model: "glm-4-flash",
      system: [agent.system],
      messages: [{ role: "user" as const, content: realUserMsg }],
      tools,
      toolChoice: "auto" as const,
    };
    let toolCalls = 0;
    let text = "";
    let stop = "";
    for await (const ev of provider.stream(req as any)) {
      if (ev.type === "tool-call") toolCalls++;
      else if (ev.type === "text-delta") text += ev.text;
      else if (ev.type === "finish") stop = ev.stopReason;
    }
    console.log(
      `run ${i}: stop=${stop} toolCalls=${toolCalls} text=${toolCalls === 0 ? JSON.stringify(text.slice(0, 80)) : "(none)"}`
    );
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
