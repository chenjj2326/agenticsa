// 一次性诊断：直接测 ZhiPuProvider 的 function calling
// 用法：MYAGENT_API_KEY=xxx npx tsx src/bench/diag-zhipu-tools.ts
import { ZhiPuProvider } from "../provider/zhipu-provider.js";

const apiKey = process.env.MYAGENT_API_KEY;
if (!apiKey) {
  console.error("MYAGENT_API_KEY not set");
  process.exit(1);
}

const provider = new ZhiPuProvider(apiKey, { temperature: 0.2 });

const req = {
  system: ["You are a coding agent working in a git repository."],
  messages: [
    {
      role: "user" as const,
      content:
        "Show the last 3 commits of the repository. You MUST use the bash tool to do this.",
    },
  ],
  tools: [
    {
      type: "function" as const,
      function: {
        name: "bash",
        description:
          "Run a shell command in the repository working directory and return its output.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to run" },
          },
          required: ["command"],
        },
      },
    },
  ],
  toolChoice: "auto" as const,
  model: "glm-4-flash",
};

console.log("=== stream with tools ===");
for await (const ev of provider.stream(req)) {
  if (ev.type === "finish") {
    console.log("[finish]", JSON.stringify(ev.stopReason), "usage:", JSON.stringify(ev.usage));
  } else {
    console.log("[" + ev.type + "]", JSON.stringify(ev).slice(0, 300));
  }
}

// 对照组：不带 tools
console.log("\n=== control: no tools ===");
for await (const ev of provider.stream({ ...req, tools: undefined, toolChoice: undefined })) {
  if (ev.type === "finish") {
    console.log("[finish]", JSON.stringify(ev.stopReason));
  } else {
    console.log("[" + ev.type + "]", JSON.stringify(ev).slice(0, 200));
  }
}
