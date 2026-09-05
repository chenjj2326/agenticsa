# MyAgent

按 `e:/opencode-dev/文档` 02-17 严格实现的 OpenCode 风格 Agent。

## 跑

```bash
npm install
npm start          # 交互式 CLI（mock provider）
npx tsx src/test-e2e.ts   # 端到端冒烟测试（8 个场景）
npm run typecheck         # 类型检查
```

## 换真实模型（明天接 API key）

模型调用现在是 mock（`src/provider/mock-provider.ts`），能完整跑通工具循环 / 权限 / 上下文 / 压缩。
接真实模型时：

1. 新建 `src/provider/xxx-provider.ts`，实现 [`LLMProvider`](src/provider/llm.ts) 接口
   （`stream(req, signal)` 产出 `LLMEvent`：`text-delta` / `reasoning-delta` / `tool-call` / `finish` / `error`）。
2. 在 [`src/core/application.ts`](src/core/application.ts) 把 `readonly provider = new MockProvider();`
   换成你的 provider，`AppOptions` 加上 `apiKey` 等字段即可。

## 架构映射

| 文档 | 实现位置 |
| --- | --- |
| 02 上下文管理 | `src/core/context/` |
| 03 Agent Loop | `src/core/agent/` |
| 04 Memory | `src/core/memory/` |
| 05 工具系统 | `src/core/tool/` |
| 06 提示词 | `src/core/prompt/` |
| 07 错误处理 | `src/core/error/` |
| 08 Skill | `src/core/skill/` |
| 09 MCP | `src/core/mcp/` |
| 10 沙盒 | `src/core/sandbox/` |
| 11 安全 | 散在各模块（权限/校验） |
| 12 Hooks/Task | `src/core/hooks/`, `src/core/task/` |
| 13 Bridge | `src/core/bridge/` |
| 14 Compact/Token | `src/core/compaction/`, `src/core/token/` |
| 15 成本 | `src/core/cost/` |
| 16 多代理 | `src/core/task/`（Task 子代理 + 权限派生） |
| 17 Remote | `src/core/remote/` |
