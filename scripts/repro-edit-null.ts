// 复现 edit 工具 ERROR null：强制走一个 old_string 不存在的 edit 调用
import { Application } from "../src/core/application.js";
import type { LLMProvider, LLMRequest } from "../src/provider/llm.js";
import type { LLMEvent } from "../src/core/session/message.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-repro-"));
fs.writeFileSync(path.join(dir, "a.txt"), "hello world\nsecond line\n");

// 脚本化 provider：第一步发 edit（bad old_string），第二步结束
class ScriptedProvider implements LLMProvider {
  name = "scripted";
  step = 0;
  listModels() { return ["scripted"]; }
  contextLimit() { return 100000; }
  async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
    this.step++;
    if (this.step === 1) {
      yield {
        type: "tool-call",
        id: "call_1",
        name: "edit",
        args: { file_path: "a.txt", old_string: "NOT EXIST OLD", new_string: "x" },
      } as any;
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, nonCachedInputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 } } as any;
    } else {
      // 把 history 里最后的 tool result 打出来
      const last = req.messages[req.messages.length - 1];
      console.log("=== LAST MESSAGE SEEN BY PROVIDER ===");
      console.log(JSON.stringify(last, null, 2).slice(0, 1500));
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, nonCachedInputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 } } as any;
    }
  }
}

const app = new Application({ cwd: dir, provider: "mock" });
(app as any).provider = new ScriptedProvider();
app.setAskHandler(async () => ({ type: "allow" }));

const session = await app.createSession({
  agentId: "build",
  onEvent: (e: any) => {
    if (e.type === "tool-result") {
      console.log(`[event] tool-result error=${e.error} output=${JSON.stringify(e.output)?.slice(0, 300)}`);
    }
  },
});
await session.admitInput("trigger edit failure", "queue");
// 等 drain
for (let i = 0; i < 100 && app.coordinator.active(session.sessionId).length; i++) {
  await new Promise((r) => setTimeout(r, 100));
}
const err = (session as any).getDrainError?.();
if (err) console.log("drainError:", err);
process.exit(0);
