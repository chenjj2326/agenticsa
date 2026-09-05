// zhipu function calling 探针：模型发的是标准 tool_calls 还是纯文本？
import { ZhiPuProvider } from "../src/provider/zhipu-provider.js";

const apiKey = process.env.MYAGENT_API_KEY ?? "";
const provider = new ZhiPuProvider(apiKey);
const model = process.argv[2] ?? "glm-4-flash";

const req = {
  model,
  system: [
    "You are a coding agent. When the user asks about files, you MUST call the provided tools to perform actions. Never describe commands in plain text; always use the tool call mechanism.",
  ],
  messages: [
    {
      role: "user" as const,
      content: "List the files in the current directory.",
    },
  ],
  tools: [
    {
      function: {
        name: "bash",
        description: "Execute a bash command and return stdout/stderr.",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
  ],
};

async function main() {
  for await (const ev of provider.stream(req as any)) {
    switch (ev.type) {
      case "text-delta":
        process.stdout.write(`[TEXT] ${ev.text}`);
        break;
      case "tool-call":
        console.log(`[TOOL-CALL] ${ev.name} args=${JSON.stringify(ev.args)}`);
        break;
      case "finish":
        console.log(`[FINISH] stopReason=${ev.stopReason} usage=${JSON.stringify(ev.usage?.inputTokens)}/${JSON.stringify(ev.usage?.outputTokens)}`);
        break;
      case "error":
        console.log(`[ERROR] ${ev.error}`);
        break;
      default:
        console.log(`[${ev.type}]`);
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
