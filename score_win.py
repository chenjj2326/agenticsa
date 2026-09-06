#!/usr/bin/env python3
"""
SWE-bench LIGHTWEIGHT scorer — Windows native (no Docker, no WSL).

Adapted from lite_score.py (WSL). Changes for Windows:
  - interpreter is configurable per-repo (PY_MAP), default py39 conda env
  - shutil.rmtree instead of `rm -rf`, no pgrep/kill_orphans
  - pip without --break-system-packages (venv/conda)

Usage:
  python score_win.py <predictions.jsonl> [instance_id ...]

Scoring flow per prediction:
  1. git worktree at base_commit
  2. apply gold test_patch (FAIL_TO_PASS tests appear)
  3. pip install -e . + era-specific deps
  4. BASELINE: F2P must fail, P2P(first 5) must pass
  5. apply model_patch
  6. AFTER: F2P should pass, P2P should still pass
  7. verdict: RESOLVED / PARTIAL / FAILED / ENV_BROKEN / NO_PATCH
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

PROJ = r"E:\opencode-dev\MyAgent"
DS = os.path.join(PROJ, "swebench_verified.jsonl")
CLONES_ROOT = r"C:\Users\33378\AppData\Local\Temp\swe_bench_work\repos"
OUTDIR = os.environ.get("OUTDIR", os.path.join(tempfile.gettempdir(), "swebench-win-score"))

# per-repo interpreter (老项目配老 Python)
# swe39 环境自动探测，按稳定性排序：
#   E:\swe-envs\swe39     —— 2026-09-05 建于 E 盘（宿主 FS 虚拟化监控范围外，稳定）
#   C:\...\.conda\envs\*  —— C 盘用户目录下的 conda 环境会被宿主虚拟化层吃掉文件（见坑 19）
def _find_swe39():
    candidates = (
        # py39raw（copytree 复制）最稳——conda create 部署的 swe39 环境会再次被掏空（坑 19 复发）
        r"E:\swe-envs\py39raw\python.exe",
        r"E:\swe-envs\swe39\python.exe",
        r"C:\Users\33378\.conda\envs\swe39b\python.exe",
        r"C:\Users\33378\.conda\envs\swe39\python.exe",
    )
    for p in candidates:
        if os.path.isfile(p):
            return p
    return candidates[0]


PY39 = os.environ.get("SWE39_PYTHON") or _find_swe39()
PY_MAP = {
    "django": PY39,
    "requests": PY39,
    "flask": PY39,
    "default": PY39,
}

os.makedirs(OUTDIR, exist_ok=True)

# 坑：宿主环境（WorkBuddy/IDE）会注入 PYTHONPATH 指向自己的 vendor shim，
# conda 子进程 Python 继承后连 encodings 都找不到，直接 Fatal Python error。
# 所有子进程统一用清洗过的环境。
CLEAN_ENV = {k: v for k, v in os.environ.items()
             if k not in ("PYTHONPATH", "PYTHONHOME")}


def pick_python(repo: str) -> str:
    for k, v in PY_MAP.items():
        if k in repo.lower():
            return v
    return PY_MAP["default"]


# pip 走清华镜像（直连 pypi.org 会卡到超时）
PIP_MIRROR = ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple"]


def sh(cmd, cwd=None, timeout=300, input_text=None, env_override=None):
    try:
        return subprocess.run(
            cmd, cwd=cwd, input=input_text, text=True,
            capture_output=True, timeout=timeout,
            env=env_override if env_override is not None else CLEAN_ENV,
        )
    except subprocess.TimeoutExpired:
        # 超时不能炸掉整个评分进程：返回合成的失败结果，让上层按 env 问题处理
        print(f"    [sh] TIMEOUT after {timeout}s: {' '.join(map(str, cmd[:4]))}...")
        return subprocess.CompletedProcess(cmd, -1, "", f"timeout after {timeout}s")


def git_apply(patch_text: str, cwd: str, extra=None, timeout=180):
    patch_text = (patch_text or "").lstrip("﻿﻿\n\r\t \v\f")
    if not patch_text:
        r = subprocess.CompletedProcess([], 1, "", "empty patch")
        return r
    if not patch_text.endswith("\n"):
        patch_text += "\n"
    pf = os.path.join(cwd, "_score_apply.patch")
    with open(pf, "w", newline="\n", encoding="utf-8") as f:
        f.write(patch_text)
    args = ["git", "apply", "--whitespace=nowarn", "--recount"]
    if extra:
        args.extend(extra)
    args.append("_score_apply.patch")
    r = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout, env=CLEAN_ENV)
    try:
        os.remove(pf)
    except OSError:
        pass
    return r


def decode_list(x):
    if isinstance(x, list):
        return x
    if isinstance(x, str):
        try:
            return json.loads(x)
        except Exception:
            return []
    return []


def load_jsonl(path):
    out = {}
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            out[obj["instance_id"]] = obj
    return out


def _django_label(t: str) -> str:
    import re
    m = re.match(r"^([\w.]+)\s+\(([\w.]+)\)\s*$", t.strip())
    if m:
        method, label = m.group(1), m.group(2)
        t = f"{label}.{method}"
    if t.startswith("tests."):
        t = t[len("tests."):]
    return t


# 坑 20：SWE-bench 的 django P2P 里混有纯 docstring 描述串（如 "Trailing zeros in the
# fractional part aren't truncated."，django-10097 有 136/1432 条）。runtests.py 无法执行
# 它们，只会产生 unittest.loader._FailedTest 假错误 → 评分器误判"P2P 回归"。
# 评分前过滤掉非标准 label（标准格式："method (module.Class)"）。
_DJANGO_TEST_PAT = None  # lazy init（re 在 _django_label 里局部 import 的历史习惯）


def filter_django_labels(tests):
    import re
    pat = re.compile(r"^([\w.]+)\s+\(([\w.]+)\)\s*$")
    out = [t for t in tests if pat.match(t.strip())]
    dropped = len(tests) - len(out)
    if dropped:
        print(f"    [django labels] dropped {dropped} non-runnable docstring entries")
    return out


# 坑 24：部分数据集行的 F2P/P2P 列表被污染（django-10097 的 F2P 混入 420+ 条无关且
# base 上本就通过的测试，真正的 F2P 是 test_patch 新增 URL 条目参数化的 6 个动态测试）。
# 这类实例按数据集评分会得到无效 baseline（F2P 在 base 上全过 → ENV_BROKEN）。
# 处置：人工在干净 worktree 上做 base/gold 双向验证，把环境实证的 F2P 写进
# f2p_overrides.json（instance_id → 可执行 label 列表），评分器优先采用。
F2P_OVERRIDES = {}
_ov = os.path.join(PROJ, "f2p_overrides.json")
if os.path.isfile(_ov):
    with open(_ov, encoding="utf-8") as f:
        F2P_OVERRIDES = json.load(f)


def build_test_cmds(py: str, repo: str, tests):
    is_django = "django" in repo.lower()
    if is_django:
        args = [_django_label(t) for t in tests]
        return [py, "tests/runtests.py", "--verbosity", "2"] + args
    out_args = []
    for t in tests:
        if "::" in t:
            head, rest = t.split("::", 1)
        else:
            head, rest = t, ""
        if "/" not in head and not head.endswith(".py"):
            head = head.replace(".", "/") + ".py"
        out_args.append(head + (f"::{rest}" if rest else ""))
    return [py, "-m", "pytest", "--tb=short", "-rN",
            "-o", "filterwarnings=ignore",
            "-W", "ignore"] + out_args


def smart_excerpt(r, repo: str, max_lines: int = 45) -> str:
    text = (r.stdout or "") + ("\n" + r.stderr if r.stderr else "")
    lines = text.split("\n")
    if "django" in repo.lower():
        noise = ("Creating table", "Applying ", "Running deferred",
                 "Running migrations", "  Applying", "Operations to perform",
                 "Synchronize apps", "Creating test database", "Destroying test",
                 "Type 'yes'")
        kept = [l for l in lines if not any(n in l for n in noise)]
    else:
        kept = lines
    interesting = [l for l in kept if any(k in l for k in (
        "FAIL", "ERROR", "Error", "assert", "Traceback", "Ran ",
        "passed", "failed", "OK", "====", "::"))]
    tail = kept[-max_lines:]
    merged = interesting[-30:] + ["   ... (tail) ..."] + tail
    seen = set()
    out = []
    for l in merged:
        if l not in seen:
            seen.add(l)
            out.append(l)
    return "\n".join(out)[:4000]


def rmrf(p):
    shutil.rmtree(p, ignore_errors=True)


def main():
    pred_path = sys.argv[1]
    only_ids = set(sys.argv[2:])
    ds = load_jsonl(DS)
    preds = load_jsonl(pred_path)
    print(f"[load] dataset={len(ds)}  predictions={len(preds)}  file={pred_path}")

    summary = []
    for iid, p in preds.items():
        if only_ids and iid not in only_ids:
            continue
        print()
        print("=" * 70)
        patch = p.get("model_patch") or ""
        if not patch.strip():
            print(f"[{iid}] NO PATCH -> skip")
            summary.append(f"{iid}: NO PATCH")
            continue
        inst = ds.get(iid)
        if not inst:
            summary.append(f"{iid}: SKIP (missing instance)")
            continue
        f2p = decode_list(inst.get("FAIL_TO_PASS"))
        p2p = decode_list(inst.get("PASS_TO_PASS"))
        repo = inst["repo"]
        base = inst["base_commit"]
        py = pick_python(repo)
        if "django" in repo.lower():
            f2p = filter_django_labels(f2p)
            p2p = filter_django_labels(p2p)
        # override 放在过滤之后：override 存的是最终可执行 label，不再过格式过滤
        if iid in F2P_OVERRIDES:
            f2p = list(F2P_OVERRIDES[iid])
            print(f"  [f2p override] using {len(f2p)} env-verified labels from f2p_overrides.json")
        print(f"[{iid}]  version={inst.get('version')}  patch={len(patch)}B  repo={repo}  base={base[:12]}")
        print(f"  python={py}")
        print(f"  FAIL_TO_PASS={len(f2p)}  PASS_TO_PASS={len(p2p)}")

        clone_name = repo.replace("/", "__")
        clone = os.path.join(CLONES_ROOT, clone_name)
        if not os.path.isdir(os.path.join(clone, ".git")):
            summary.append(f"{iid}: CLONE_MISSING")
            continue

        score_root = os.path.join(OUTDIR, f"score-{iid.replace('/', '__')}")
        rmrf(score_root)
        os.makedirs(score_root, exist_ok=True)
        wt = os.path.join(score_root, "wt")

        sh(["git", "worktree", "remove", "--force", wt], cwd=clone)
        sh(["git", "worktree", "prune"], cwd=clone)
        r = sh(["git", "worktree", "add", "--quiet", "--detach", wt, base], cwd=clone)
        if r.returncode != 0:
            print(f"  WORKTREE FAIL: {(r.stderr or r.stdout)[:400]}")
            summary.append(f"{iid}: WORKTREE_FAIL")
            continue
        print(f"  worktree: {wt}")

        if inst.get("test_patch"):
            r = git_apply(inst["test_patch"], wt)
            print(f"  test_patch applied (exit={r.returncode})")
            if r.returncode != 0:
                print(f"    {(r.stderr or r.stdout)[:300]}")

        # deps
        # 坑：`pip install -e .` 在本机环境下会挂死（900s 超时），且评分期间对解释器环境
        # 的大批量写入疑似触发宿主文件回收（环境被掏空，见坑 19）。改为不装项目本身，
        # 直接把 worktree 注入 PYTHONPATH（flask 是 src 布局，requests 是平铺布局）。
        is_django = "django" in repo.lower()
        import_path = wt
        if os.path.isdir(os.path.join(wt, "src")):
            import_path = os.path.join(wt, "src")

        if is_django:
            req = os.path.join(wt, "tests", "requirements", "py3.txt")
            skip = ("pylibmc", "bmemcached", "mysqlclient", "psycopg",
                    "aiomysql", "mysql-connector")
            if os.path.isfile(req):
                filtered = os.path.join(score_root, "req-filtered.txt")
                with open(req, encoding="utf-8") as f:
                    req_lines = f.readlines()
                kept = [l for l in req_lines if not any(k in l.lower() for k in skip)]
                with open(filtered, "w") as f:
                    f.writelines(kept)
                r = sh([py, "-m", "pip", "install", *PIP_MIRROR, "-r", filtered, "--quiet"],
                       cwd=wt, timeout=900)
                print(f"  django filtered requirements exit={r.returncode}")
            else:
                r = sh([py, "-m", "pip", "install", *PIP_MIRROR, "--quiet",
                        "sqlparse", "asgiref", "tzdata"], timeout=300)
                print(f"  django fallback deps exit={r.returncode}")
        else:
            r = sh([py, "-m", "pip", "install", *PIP_MIRROR, "--quiet", "pytest==7.4.4"], timeout=300)
            print(f"  pytest==7.4.4 exit={r.returncode}")
            if "flask" in repo.lower():
                r = sh([py, "-m", "pip", "install", *PIP_MIRROR, "--quiet", "--upgrade",
                        "Werkzeug>=2.1,<3"], cwd=wt, timeout=300)
                print(f"  Werkzeug pin exit={r.returncode}")
            if "requests" in repo.lower():
                r = sh([py, "-m", "pip", "install", *PIP_MIRROR, "--quiet", "trustme", "pytest-mock",
                        "pytest-httpbin", "charset-normalizer<4", "urllib3<1.27"],
                       cwd=wt, timeout=300)
                print(f"  requests test deps exit={r.returncode}")

        def run_tests(tests, timeout=600):
            env = dict(CLEAN_ENV)
            env["PYTHONPATH"] = import_path
            return sh(build_test_cmds(py, repo, tests), cwd=wt, timeout=timeout, env_override=env)

        # baseline
        baseline_valid = True
        if f2p:
            r = run_tests(f2p)
            ok = (r.returncode != 0)
            print(f"  baseline F2P exit={r.returncode}  (expected nonzero = {ok})")
            if not ok:
                baseline_valid = False
                print(f"    ENV_BROKEN: F2P passes BEFORE fix\n{smart_excerpt(r, repo)}")
        if p2p:
            sample = p2p[:5]
            r = run_tests(sample)
            ok = (r.returncode == 0)
            print(f"  baseline P2P(first 5) exit={r.returncode}  (expected zero = {ok})")
            if not ok:
                baseline_valid = False
                print(f"    ENV_BROKEN: P2P fails BEFORE fix\n{smart_excerpt(r, repo)}")

        # apply model patch
        r = git_apply(patch, wt)
        if r.returncode != 0:
            msg = (r.stderr or r.stdout)[:600]
            print(f"  MODEL_PATCH APPLY_FAIL:\n{msg}")
            summary.append(f"{iid}: APPLY_FAIL  (patch={len(patch)}B)")
            sh(["git", "worktree", "remove", "--force", wt], cwd=clone, timeout=120)
            sh(["git", "worktree", "prune"], cwd=clone, timeout=120)
            rmrf(score_root)
            continue
        print(f"  model_patch applied ({len(patch)}B)")

        # after
        f2p_total = len(f2p)
        resolved = 0
        if f2p:
            r = run_tests(f2p)
            if r.returncode == 0:
                resolved = f2p_total
                print(f"  AFTER: FAIL_TO_PASS => ALL PASS ({resolved}/{f2p_total})")
            else:
                print(f"  AFTER: FAIL_TO_PASS => FAILED exit={r.returncode}")
                print(f"    excerpt:\n{smart_excerpt(r, repo)}")
        p2p_regression = False
        if p2p:
            sample = p2p[:min(10, len(p2p))]
            r = run_tests(sample)
            if r.returncode == 0:
                print(f"  AFTER: PASS_TO_PASS (first {len(sample)}) => still pass")
            else:
                p2p_regression = True
                print(f"  AFTER: PASS_TO_PASS (first {len(sample)}) => REGRESSION exit={r.returncode}")
                print(f"    excerpt:\n{smart_excerpt(r, repo)}")

        if f2p_total == 0:
            verdict = "UNKNOWN (no FAIL_TO_PASS)"
        elif not baseline_valid:
            verdict = "ENV_BROKEN (baseline invalid)"
            if resolved == f2p_total:
                verdict = "ENV_BROKEN but F2P ALL PASS after (likely RESOLVED)"
        elif resolved == f2p_total and not p2p_regression:
            verdict = "RESOLVED"
        elif resolved > 0:
            verdict = f"PARTIAL ({resolved}/{f2p_total})" + (" + P2P regression" if p2p_regression else "")
        elif p2p_regression:
            verdict = "FAILED (P2P regression)"
        else:
            verdict = "FAILED (no F2P resolved)"
        print(f"\n  VERDICT: {verdict}")
        summary.append(f"{iid}: {verdict}  (patch={len(patch)}B)")

        sh(["git", "worktree", "remove", "--force", wt], cwd=clone, timeout=120)
        sh(["git", "worktree", "prune"], cwd=clone, timeout=120)
        rmrf(score_root)

    print()
    print("=" * 70)
    print("WIN SCORE SUMMARY")
    for s in summary:
        print("  " + s)
    print("=" * 70)


if __name__ == "__main__":
    main()
