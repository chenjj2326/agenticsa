// Quick test: verify ZhiPu API connectivity
import { ZhiPuProvider } from "./provider/zhipu-provider.js";
import type { LLMRequest } from "./core/session/message.js";

const API_KEY = process.env.MYAGENT_API_KEY;
if (!API_KEY) {
  console.error("MYAGENT_API_KEY not set");
  process.exit(1);
}

async function main() {
  const provider = new ZhiPuProvider(API_KEY!);

  // Test 1: Simple text response
  console.log("=== Test 1: Simple text response ===");
  const req: LLMRequest = {
    system: [],
    messages: [
      { role: "user", content: "你好，请用一句话介绍你自己" },
    ],
    model: "glm-4-flash",
    tools: undefined,
    toolChoice: undefined,
  };

  try {
    for await (const event of provider.stream(req)) {
      if (event.type === "text-delta") {
        process.stdout.write(event.text);
      } else if (event.type === "finish") {
        console.log("\n\n[Finish]", JSON.stringify(event.usage));
      } else if (event.type === "error") {
        console.error("\n[Error]", event.error);
      }
    }
  } catch (e) {
    console.error("Stream error:", e);
  }

  // Test 2: Tool call test
  console.log("\n\n=== Test 2: Tool call ===");
  const toolReq: LLMRequest = {
    system: [],
    messages: [
      { role: "user", content: "列出当前目录有哪些文件" },
    ],
    model: "glm-4-flash",
    tools: [
      {
        type: "function",
        function: {
          name: "list_files",
          description: "列出指定目录下的文件和子目录",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "目录路径，默认为当前目录" },
            },
          },
        },
      },
    ],
    toolChoice: "auto",
  };

  try {
    for await (const event of provider.stream(toolReq)) {
      if (event.type === "text-delta") {
        process.stdout.write(event.text);
      } else if (event.type === "tool-call") {
        console.log(`\n[Tool Call] ${event.name}(${JSON.stringify(event.args)})`);
      } else if (event.type === "finish") {
        console.log("\n[Finish]", JSON.stringify(event.usage));
      } else if (event.type === "error") {
        console.error("\n[Error]", event.error);
      }
    }
  } catch (e) {
    console.error("Stream error:", e);
  }

  console.log("\n=== All tests done ===");
}

main().catch(console.error);