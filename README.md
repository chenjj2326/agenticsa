# MyAgent

从零自研的 coding agent（TypeScript），实现完整的 agent loop、工具系统、上下文管理与
自动压缩，附带一套**Windows 原生 SWE-bench 评测链路**（无 Docker / 无 WSL）。
纯 TypeScript + Node 22 实现，未依赖任何 agent 框架（无 Effect-TS / LangChain）。

**当前成绩**：SWE-bench Verified 5 实例子集 **4/5 RESOLVED（80%，可评判集 4/4 = 100%）**
——glm-4.5-air 解出 3 题（django-10097 经 f2p_overrides 修正基线后确认 RESOLVED），
**GLM-5.3-Flash 解出 django-10554**（此前 4 次 GLM-4.7 系采样均失败的 compiler 层难题，
R6 一次通过，patch 与 gold 逐字等价）。requests-1724 为 py2 幽灵题无法评判。
全过程与 25+ 踩坑记录见 [`SWE-BENCH-JOURNEY.md`](SWE-BENCH-JOURNEY.md)。

## 跑

```bash
npm install
npx tsx src/test-e2e.ts        # 端到端冒烟测试（8 场景，mock provider，不耗 API）
npm run typecheck              # 类型检查
```

## SWE-bench 快速上手

```bash
# 1. 预测（任意 OpenAI 兼容端点，--base-url 即插即用）
MYAGENT_API_KEY=sk-xxx npx tsx src/bench/swebench-run.ts \
  --dataset swebench_verified.jsonl \
  --instances "pallets__flask-5014,psf__requests-1142" \
  --provider zhipu --model glm-4.5-air \
  --max-steps 40 --timeout-min 20 --temp 0.1 \
  --out out/predictions.jsonl

# 2. 评分（Windows 原生；SWE39_PYTHON 可覆盖解释器）
SWE39_PYTHON="E:\swe-envs\py39raw\python.exe" python score_win.py out/predictions.jsonl
```

评分解释器环境搭建（**不要用 conda create**，见 journey 文档坑 17-19）：

```bash
python -c "import shutil; shutil.copytree(r'<conda pkgs>/python-3.9.18-*/', r'E:\swe-envs\py39raw')"
E:\swe-envs\py39raw\python.exe -m ensurepip --upgrade
cp <base-conda>/Library/bin/libssl-3-x64.dll <base-conda>/Library/bin/libcrypto-3-x64.dll E:\swe-envs\py39raw\
E:\swe-envs\py39raw\python.exe -m pip install pytest==7.4.4 sqlparse asgiref tzdata trustme pytest-mock pytest-httpbin -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## Provider

| provider | 接法 | 说明 |
| --- | --- | --- |
| `mock` | 默认 | 完整工具循环 / 权限 / 上下文 / 压缩，不耗 API |
| `zhipu` | `--provider zhipu` + `MYAGENT_API_KEY` | 智谱原生机（glm-4.5/4.7 系思考模型已适配 max_tokens 8192/16384） |
| `openai` | `--provider openai --base-url <endpoint>` + key | 任意 OpenAI 兼容端点（DashScope / DeepSeek / SiliconFlow / 内网网关…） |

## agent 内建评测向加固

- **edit 模糊缩进匹配回退**：模型凭记忆打缩进错位时自动纠偏（Aider/Claude Code 同款）
- **重复失败熔断**：同参同工具连续失败 ≥2 次，注入强制换策略警告（防 40 步烧光在幻觉代码上）
- **评分前自查环节**（`--self-check`，默认开）：修复完成后 agent 自审 diff、清理临时脚本、
  定向跑现有测试、修回归。测试范围 agent 自选，不接触评测集真值
- **patch 提纯**：extractPatch 自动排除 agent 自建的 `test_*.py` / `reproduce_*.py` 等临时脚本
- 思考模型适配：max_tokens 保底 8192（reasoning_content 也计入预算）

## 模块结构

| 模块 | 实现位置 |
| --- | --- |
| 上下文管理（多源组装/Epoch） | `src/core/context/` |
| Agent Loop（turn 循环/协调器） | `src/core/agent/` |
| Memory（AGENTS.md/命令记忆） | `src/core/memory/` |
| 工具系统（bash/edit/read…） | `src/core/tool/` |
| 提示词 | `src/core/prompt/` |
| 错误处理与重试 | `src/core/error/` |
| Skill | `src/core/skill/` |
| MCP | `src/core/mcp/` |
| 沙盒 | `src/core/sandbox/` |
| 安全（权限/校验） | 散在各模块 |
| Hooks/Task（含多代理派生） | `src/core/hooks/`, `src/core/task/` |
| Bridge（后台任务桥） | `src/core/bridge/` |
| Compact/Token（自动压缩） | `src/core/compaction/`, `src/core/token/` |
| 成本统计 | `src/core/cost/` |
| Remote | `src/core/remote/` |
