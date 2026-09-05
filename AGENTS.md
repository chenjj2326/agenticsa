# AGENTS.md

## 项目约定

- 这是 MyAgent 项目，严格按 e:/opencode-dev/文档 02-17 实现 OpenCode 风格 agent。
- 用 TypeScript，Node.js 运行时（不用 Bun/Effect-TS 原生依赖）。
- 模型调用先 mock，明天换真 API key。
- 所有核心机制都要按文档：Source 代数、Epoch、三层 loop、三态权限、双层截断、双视角 Usage 等。
