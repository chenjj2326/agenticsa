# 评测环境架构说明（env.md）

本文说明本仓库 SWE-bench 评测链路的环境架构：与官方 Docker harness 的对应关系、各层职责、以及差异带来的注意事项。

## 1. 背景：官方 harness 的运行方式

SWE-bench 官方评测依赖 Docker：

- 每个实例对应一个预构建镜像（`swebench/sweb.eval.x86_64.<instance>`），镜像内固化了操作系统版本、Python 版本与依赖组合；
- 执行流程为：容器内 checkout 至 `base_commit` → apply 模型 patch 与 `test_patch` → 执行实例指定的测试命令 → 按 F2P/P2P 清单与测试结果判定是否 RESOLVED；
- 优点是与论文及公开榜单完全同源；代价是每题一个镜像（数 GB），Windows 平台需经 WSL2 运行，且镜像拉取对网络环境要求高。

## 2. 本仓库的做法：Windows 原生评分链路

本仓库未使用官方 Docker harness，而是将其各层职责复刻到宿主机文件系统上，判定口径与官方保持一致（F2P 必须由失败转通过，P2P 不得被破坏）。

| 层 | 官方实现 | 本仓库实现 |
|---|---|---|
| 系统与运行时 | Docker 镜像内固化 | 宿主机专用 Python 环境（`E:\swe-envs\<repo>-env`），按实例依赖钉版本 |
| 代码检出 | 容器内 checkout `base_commit` | `E:\swe-repos\` 克隆仓库，worktree 检出至 `base_commit` |
| patch 应用 | 容器内 `git apply` | 宿主机 `git apply`，`f2p_overrides.json` 处理数据集基线标注问题 |
| 测试执行 | 镜像内预设命令 | 按 repo 分发：django 走 `runtests.py` 标签；sympy 走 `bin/test` 按文件；其余走 pytest node id |
| 结果判定 | 官方 harness 日志解析 | `score_win.py`：base 失败校验 → gold 翻绿校验 → P2P 回归校验 |

环境构建脚本见 [`env_prep.py`](env_prep.py)，评分逻辑见 [`score_win.py`](score_win.py)，全程踩坑与决策记录见 [`SWE-BENCH-JOURNEY.md`](SWE-BENCH-JOURNEY.md)。

## 3. 各 repo 测试入口约定

| Repo | 测试入口 | 说明 |
|---|---|---|
| django | `runtests.py <标签>` | 官方测试标签格式 |
| sympy | `bin/doctest <文件路径>` | `bin/test` 不接受裸测试名，按 `test_patch` 触及的文件执行 |
| matplotlib | pytest（`lib/` 布局） | 需将 `PYTHONPATH` 指向 `lib/` |
| pytest | pytest（`src/` 布局） | `PYTHONPATH` 须指向 `src/`，并手写 `_version.py` |
| sphinx / xarray / seaborn / pylint | pytest | 依赖版本需按实例时代钉定（如 sphinx 3.3 需 jinja2==3.0.3 等） |

## 4. 与官方口径的差异与注意事项

- **判定标准一致，执行载体不同**：F2P/P2P 判定逻辑与官方相同，但环境由本机构建，与官方镜像并非逐位一致；
- **结论表述建议**：报成绩时应表述为「自建 Windows 原生评测链路，与官方 harness 同口径（F2P/P2P），未使用官方 Docker harness」；
- **交叉验证**：如需官方背书，可抽取部分实例在 Docker 中用官方 harness 复跑，比对两侧判定是否一致；
- **已知环境敏感点**：老项目依赖组合（jinja2 / docutils / alabaster / pytest 5.x 等）在宿主机上需手动钉版本，官方镜像内已预先调好；`f2p_overrides.json` 用于修正数据集中个别实例的 F2P 标注与实际行为的偏差（如 django-10097）。

## 5. 为什么不用 Docker

- Windows 下需 WSL2 + 数十 GB 虚拟磁盘，且每题独立镜像的拉取与存储成本高；
- 老版本项目的依赖钉版本工作在宿主机上可直接完成，容器内同样绕不开；
- 本仓库的评测目标是验证 agent 的解题能力与建立可复现的判定口径，而非复现官方榜单的完整运行时。
