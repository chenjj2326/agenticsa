# AGENTS.md

## 项目约定

- 这是 MyAgent 项目：自研 coding agent（TypeScript）+ Windows 原生 SWE-bench 评测链路。
- 用 TypeScript，Node.js 运行时（不用 Bun/Effect-TS 原生依赖）。
- 所有核心机制自研实现：Source 代数、Epoch、三层 loop、三态权限、双层截断、双视角 Usage 等，改动前先读对应模块源码。
