// 验证 edit 工具模糊缩进匹配：用 flask 真实案例（模型 line2 少 2 格缩进）
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Application } from "../src/core/application.js";
import type { LLMProvider, LLMRequest } from "../src/provider/llm.js";
import type { LLMEvent } from "../src/core/session/message.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-repro-"));
// 真实文件片段（flask blueprints.py @7ee9ceb）
fs.writeFileSync(
  path.join(dir, "bp.py"),
  `        self.root_path = root_path
        )

        if "." in name:
            raise ValueError("'name' may not contain a dot '.' character.")

        self.name = name
        self.url_prefix = url_prefix
`,
  "utf8"
);

// 模型提交的 old_string：line2 只有 10 格缩进（应为 12）
const BAD_OLD =
  '        if "." in name:\n          raise ValueError("\'name\' may not contain a dot \'.\' character.")\n\n        self.name = name';
const NEW =
  '        if "." in name:\n            raise ValueError("\'name\' may not contain a dot \'.\' character.")\n\n        if not name:\n            raise ValueError("\'name\' may not be empty.")\n\n        self.name = name';

class ScriptedProvider implements LLMProvider {
  name = "scripted";
  step = 0;
  listModels() { return ["s"]; }
  contextLimit() { return 100000; }
  async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
    this.step++;
    if (this.step === 1) {
      yield { type: "tool-call", id: "c1", name: "edit", args: { file_path: "bp.py", old_string: BAD_OLD, new_string: NEW } } as any;
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, nonCachedInputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 } } as any;
    } else {
      const last = req.messages[req.messages.length - 1] as any;
      console.log("=== TOOL RESULT TO MODEL ===");
      console.log(JSON.stringify(last, null, 2).slice(0, 800));
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, nonCachedInputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 } } as any;
    }
  }
}

process.chdir(dir);
const app = new Application({ cwd: dir, provider: "mock" });
(app as any).provider = new ScriptedProvider();
app.setAskHandler(async () => ({ type: "allow" }));
const session = await app.createSession({ agentId: "build", onEvent: () => {} });
await session.admitInput("go", "queue");
for (let i = 0; i < 100 && app.coordinator.active(session.sessionId).length; i++) {
  await new Promise((r) => setTimeout(r, 100));
}
console.log("=== FILE AFTER EDIT ===");
console.log(fs.readFileSync(path.join(dir, "bp.py"), "utf8"));
process.exit(0);
