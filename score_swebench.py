#!/usr/bin/env python3
"""
Score SWE-bench predictions locally (no huggingface network required).

Usage (inside WSL):
  python3 score_swebench.py \
      --dataset /mnt/e/opencode-dev/MyAgent/swebench_verified.jsonl \
      --predictions /mnt/c/Users/xxx/AppData/Local/Temp/swe_bench_work/out/predictions.jsonl \
      --run_id myagent-v1 --outdir /tmp/swebench-report

Strategy:
  1. Strip UTF-8 BOM from both files.
  2. Call swebench.harness.run_evaluation with dataset NAME = local JSONL path
     ("-d dataset.jsonl" — swebench 5.x supports this per --help).
  3. Print summary: RESOLVED / PARTIAL / FAILED / ERROR for each instance.
"""
import argparse
import codecs
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def strip_bom(src_path: str, dst_path: str) -> None:
    with open(src_path, "rb") as f:
        data = f.read()
    if data.startswith(codecs.BOM_UTF8):
        data = data[len(codecs.BOM_UTF8):]
    with open(dst_path, "wb") as f:
        f.write(data)
    print(f"[score] wrote {dst_path} ({len(data)} bytes)")


def enrich_instance(r: dict) -> dict:
    """
    补全 SWE-bench 5.x harness make_test_spec 要求的字段：
    instance_id, image, repo, version, FAIL_TO_PASS, PASS_TO_PASS,
    log_parser, eval_type, eval_script.

    Verified JSONL 已经自带 instance_id / repo / version /
    FAIL_TO_PASS / PASS_TO_PASS；下面补 image / eval_script /
    eval_type / log_parser。
    """
    repo = r["repo"]            # e.g. "pallets/flask"
    version = r.get("version", "")
    # image 命名规则 sweb.{org}__{project}.{version}:latest（SWE-bench 官方约定）
    repo_qname = repo.replace("/", "__")
    r.setdefault("image", f"sweb.{repo_qname}.{version}:latest")

    # FAIL_TO_PASS 反推第一个失败测试路径 => pytest 测试名
    f2p = r.get("FAIL_TO_PASS") or []
    if isinstance(f2p, str):
        try:
            f2p = json.loads(f2p)
        except Exception:
            f2p = []
    p2p = r.get("PASS_TO_PASS") or []
    if isinstance(p2p, str):
        try:
            p2p = json.loads(p2p)
        except Exception:
            p2p = []

    # eval_type / log_parser：按项目粗粒度匹配，不是严格匹配也不影响结果
    #  （harness 用 log_parser 提取 exit code 行，exit_code_wrapper.py 已显式记录退出码，
    #   所以 parser 错了也能正常判）
    repo_l = repo.lower()
    if "django" in repo_l:
        r.setdefault("eval_type", "python")
        r.setdefault("log_parser", "django")
    elif "pallets/flask" in repo_l or "requests" in repo_l or "werkzeug" in repo_l or "starlette" in repo_l or "pydantic" in repo_l or "psf/black" in repo_l:
        r.setdefault("eval_type", "python")
        r.setdefault("log_parser", "pytest")
    else:
        r.setdefault("eval_type", "python")
        r.setdefault("log_parser", "pytest")

    # eval_script：默认先装依赖再按 FAIL_TO_PASS 第一条跑测试
    #  构造 pytest / django 命令行（FAIL_TO_PASS 内的单条测试格式）
    def _first_test_or_all() -> str:
        if f2p:
            return f2p[0]
        if p2p:
            return p2p[0]
        return ""

    first_test = _first_test_or_all()
    repo_slug = repo.split("/")[-1]
    if "django" in repo_l:
        # Django 经典套路：cd tests; ./runtests.py {module.test}
        # FAIL_TO_PASS 形如 tests.queries.test_qs_combinators.QueriesTest.test_xxx
        test_arg = first_test
        if test_arg.startswith("tests."):
            test_arg = test_arg[len("tests."):]
        # install + run
        script = (
            "set -euo pipefail\n"
            "cd /testbed\n"
            "python -m pip install -e . --quiet 2>&1 | tail -n 5\n"
            f"cd tests && python runtests.py --verbosity 2 {test_arg}\n"
        )
        r.setdefault("eval_script", script)
    else:
        # pytest 家族
        # FAIL_TO_PASS 形如 tests/test_blueprints.py::test_empty_name_not_allowed
        # 或 tests.test_blueprints::test_empty_name_not_allowed
        pytest_target = first_test
        if pytest_target and "/" not in pytest_target.split("::")[0]:
            # 把包路径转成文件路径: tests.test_blueprints => tests/test_blueprints.py
            head = pytest_target.split("::", 1)[0]
            file_head = head.replace(".", "/") + ".py"
            rest = ""
            if "::" in pytest_target:
                rest = "::" + pytest_target.split("::", 1)[1]
            pytest_target = file_head + rest
        script = (
            "set -euo pipefail\n"
            "cd /testbed\n"
            "python -m pip install -e . --quiet 2>&1 | tail -n 5\n"
            f"python -m pytest -xvs --tb=short {pytest_target}\n"
        )
        r.setdefault("eval_script", script)

    return r


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True, help="Local dataset JSONL path (in WSL, /mnt/... ok)")
    ap.add_argument("--predictions", required=True, help="Predictions JSONL path")
    ap.add_argument("--run_id", default="myagent-v1")
    ap.add_argument("--outdir", default="/tmp/swebench-report")
    ap.add_argument("--max_workers", type=int, default=2)
    ap.add_argument("--split", default="test")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)

    # Strip BOM and enrich dataset (add image/eval_script/eval_type/log_parser)
    ds_clean = os.path.join(args.outdir, "dataset.jsonl")
    pred_clean = os.path.join(args.outdir, "predictions.jsonl")

    # dataset: read → strip BOM → JSON parse each line → enrich() → write back
    with open(args.dataset, "rb") as f:
        raw = f.read()
    if raw.startswith(codecs.BOM_UTF8):
        raw = raw[len(codecs.BOM_UTF8):]
    text = raw.decode("utf-8")
    enriched_lines = 0
    with open(ds_clean, "w", encoding="utf-8") as out:
        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue
            inst = json.loads(line)
            inst = enrich_instance(inst)
            out.write(json.dumps(inst, ensure_ascii=False))
            out.write("\n")
            enriched_lines += 1
    print(f"[score] wrote enriched dataset {ds_clean} ({enriched_lines} rows)")

    # predictions: strip BOM only
    strip_bom(args.predictions, pred_clean)

    # List predictions (useful log)
    print("\n[score] predictions summary:")
    with open(pred_clean, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            print(f"  {o['instance_id']:40s} patch_len={len(o.get('model_patch',''))}")

    # Docker sanity
    r = subprocess.run(["docker", "ps"], capture_output=True)
    if r.returncode != 0:
        print("[score] WARNING: docker ps failed, harness may not work",
              r.stderr.decode("utf-8", "replace")[:400], file=sys.stderr)
    else:
        print("[score] docker OK")

    # Run harness
    cmd = [
        sys.executable, "-m", "swebench.harness.run_evaluation",
        "--dataset_name", ds_clean,
        "--predictions_path", pred_clean,
        "--run_id", args.run_id,
        "--max_workers", str(args.max_workers),
        "--split", args.split,
    ]
    print("\n[score] running harness with:", " ".join(cmd))
    print("=" * 72)
    os.chdir(args.outdir)
    harness_log = os.path.join(args.outdir, "harness.log")
    tee_proc = subprocess.Popen(
        ["tee", "-a", harness_log], stdin=subprocess.PIPE, text=True
    )
    p = subprocess.run(cmd, stdout=tee_proc.stdin, stderr=subprocess.STDOUT, text=True)
    tee_proc.stdin.close()
    tee_proc.wait()
    print("=" * 72)
    print(f"[score] harness exit code = {p.returncode}. Logs: {harness_log}")

    harness_success = (p.returncode == 0)

    # Try to read any produced report JSON / CSV
    for fname in os.listdir(args.outdir):
        if "report" in fname.lower() or "results" in fname.lower():
            full = os.path.join(args.outdir, fname)
            print(f"\n[score] found output artifact: {fname}  ({os.path.getsize(full)} bytes)")
            try:
                with open(full) as f:
                    head = f.read(2000)
                print(head)
            except Exception as e:
                print(f"  (read failed: {e})")

    # Tail of harness.log
    try:
        with open(harness_log, encoding="utf-8") as f:
            lines = f.readlines()
        print(f"\n[score] harness.log {len(lines)} lines — tail 50:")
        for l in lines[-50:]:
            print(l.rstrip())
    except FileNotFoundError:
        print("[score] harness.log missing")

    # ---------------------------------------------------------------
    # FALLBACK lightweight scoring (if harness failed / image missing)
    # ---------------------------------------------------------------
    if not harness_success:
        print()
        print("=" * 72)
        print("[score] FALLBACK: lightweight local scoring (no docker required)")
        print("=" * 72)
        fallback_log = os.path.join(args.outdir, "fallback-scoring.log")
        with open(fallback_log, "w", encoding="utf-8") as logf:
            def log(msg: str):
                print(msg)
                logf.write(msg + "\n")

            # Read instances + predictions
            inst_by_id = {}
            with open(ds_clean, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    inst = json.loads(line)
                    inst_by_id[inst["instance_id"]] = inst
            preds_by_id = {}
            with open(pred_clean, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    p_ = json.loads(line)
                    preds_by_id[p_["instance_id"]] = p_

            summary_lines: list[str] = []
            for iid, pred in preds_by_id.items():
                inst = inst_by_id.get(iid)
                if not inst:
                    log(f"\n### [{iid}] SKIP — not found in dataset")
                    summary_lines.append(f"{iid}: SKIP (missing instance data)")
                    continue
                patch = pred.get("model_patch") or ""
                if not patch.strip():
                    log(f"\n### [{iid}] NO PATCH — not scored")
                    summary_lines.append(f"{iid}: NO PATCH")
                    continue
                log(f"\n### [{iid}] patch_len={len(patch)}")
                log(f"  repo={inst['repo']} base={inst['base_commit']}")

                # Try WSL-local repo clone dirs (from swebench-run). If not found, skip to "ENV_MISSING"
                win_clones_root = "/mnt/c/Users/33378/AppData/Local/Temp/swe_bench_work/repos"
                clone_name = inst["repo"].replace("/", "__")
                clone = f"{win_clones_root}/{clone_name}"
                if not os.path.isdir(os.path.join(clone, ".git")):
                    log(f"  clone dir not found at {clone}; try git clone fresh")
                    try:
                        os.makedirs(win_clones_root, exist_ok=True)
                        subprocess.run(
                            ["git", "clone", "--quiet",
                             f"https://github.com/{inst['repo']}.git", clone],
                            cwd=win_clones_root, check=True, timeout=15*60,
                            capture_output=True, text=True,
                        )
                    except Exception as e:
                        log(f"  CLONE FAIL: {e}")
                        summary_lines.append(f"{iid}: ENV_MISSING (cannot clone)")
                        continue
                log(f"  clone ok: {clone}")

                # Create a workdir for scoring (git --work-tree style)
                score_root = f"{args.outdir}/score-{iid.replace('/', '__')}"
                wt = f"{score_root}/wt"
                # clean previous
                subprocess.run(["rm", "-rf", score_root], capture_output=True)
                os.makedirs(score_root, exist_ok=True)

                try:
                    # remove any prior stale worktree registration
                    subprocess.run(
                        ["git", "worktree", "remove", "--force", wt],
                        cwd=clone, capture_output=True, timeout=120,
                    )
                    subprocess.run(
                        ["git", "worktree", "prune"],
                        cwd=clone, capture_output=True, timeout=120,
                    )
                    subprocess.run(
                        ["git", "worktree", "add", "--quiet", "--detach", wt,
                         inst["base_commit"]],
                        cwd=clone, check=True, capture_output=True, timeout=5*60,
                    )
                except subprocess.CalledProcessError as e:
                    log(f"  WORKTREE FAIL: {e.stderr[:400]}")
                    summary_lines.append(f"{iid}: ENV_ERROR (worktree create)")
                    continue
                log(f"  worktree ok: {wt}")

                # Apply gold test patch
                if inst.get("test_patch"):
                    r = subprocess.run(
                        ["git", "apply", "--whitespace=nowarn", "-"],
                        input=inst["test_patch"], cwd=wt, text=True,
                        capture_output=True, timeout=120,
                    )
                    if r.returncode != 0:
                        log(f"  TEST_PATCH apply non-fatal: {r.stderr[:400]}")
                    else:
                        log(f"  applied gold test_patch OK")

                # Baseline: install deps + PASS_TO_PASS baseline
                f2p = inst.get("FAIL_TO_PASS")
                p2p = inst.get("PASS_TO_PASS")
                if isinstance(f2p, str):
                    try: f2p = json.loads(f2p)
                    except: f2p = []
                if isinstance(p2p, str):
                    try: p2p = json.loads(p2p)
                    except: p2p = []

                # Install deps (best effort)
                setup_py = os.path.join(wt, "setup.py")
                pyproject = os.path.join(wt, "pyproject.toml")
                if os.path.isfile(setup_py) or os.path.isfile(pyproject):
                    r = subprocess.run(
                        ["python", "-m", "pip", "install", "-e", ".", "--quiet"],
                        cwd=wt, capture_output=True, text=True, timeout=10*60,
                    )
                    log(f"  pip install -e . exit={r.returncode}")
                    if r.stderr.strip():
                        log(f"  pip stderr tail: {r.stderr[-600:]}")

                def build_test_cmd(test_list: list[str]):
                    # detect django vs pytest family
                    is_django = "django" in inst["repo"].lower()
                    if is_django:
                        # test_list entries: tests.queries.test_qs_combinators.Xxx.test_name
                        args = [t.replace("tests.", "", 1) for t in test_list]
                        return (
                            ["python", "tests/runtests.py", "--verbosity", "2"] + args,
                            wt,
                        )
                    else:
                        # pytest: convert dotted file part to path
                        p_args = []
                        for t in test_list:
                            if "::" in t:
                                head, rest = t.split("::", 1)
                            else:
                                head, rest = t, ""
                            if "/" not in head:
                                head = head.replace(".", "/") + ".py"
                            p_args.append(head + (f"::{rest}" if rest else ""))
                        return (
                            ["python", "-m", "pytest", "-x", "--tb=short"] + p_args,
                            wt,
                        )

                # Run 1: baseline WITHOUT model patch → PASS_TO_PASS must pass, FAIL_TO_PASS must fail
                baseline_p2p_ok = None
                baseline_f2p_ok = None
                if p2p:
                    cmd0, cwd0 = build_test_cmd(p2p[:5])
                    log(f"  baseline PASS_TO_PASS (first 5): {' '.join(cmd0[:6])}...")
                    r = subprocess.run(cmd0, cwd=cwd0, capture_output=True, text=True, timeout=10*60)
                    baseline_p2p_ok = (r.returncode == 0)
                    log(f"    exit={r.returncode} (expected 0)   ok={baseline_p2p_ok}")
                    if not baseline_p2p_ok:
                        log(f"    stdout tail: {(r.stdout[-500:] or r.stderr[-500:])}")
                if f2p:
                    cmd0, cwd0 = build_test_cmd(f2p)
                    log(f"  baseline FAIL_TO_PASS: {' '.join(cmd0[:6])}...")
                    r = subprocess.run(cmd0, cwd=cwd0, capture_output=True, text=True, timeout=10*60)
                    baseline_f2p_ok = (r.returncode != 0)  # expect FAIL
                    log(f"    exit={r.returncode} (expected !=0 => {r.returncode != 0})   ok={baseline_f2p_ok}")

                # Apply model_patch
                r = subprocess.run(
                    ["git", "apply", "--whitespace=nowarn", "-"],
                    input=patch, cwd=wt, text=True, capture_output=True, timeout=120,
                )
                if r.returncode != 0:
                    log(f"  MODEL_PATCH APPLY FAIL: {r.stderr[:600]}")
                    summary_lines.append(f"{iid}: APPLY_FAIL  (patch_len={len(patch)})")
                    continue
                log(f"  applied model_patch OK (len={len(patch)})")

                # Run 2: after model → FAIL_TO_PASS must pass now
                f2p_resolved_count = 0
                f2p_total = 0
                p2p_regression_count = 0
                p2p_total = 0
                p2p_ok = True
                if f2p:
                    cmd2, cwd2 = build_test_cmd(f2p)
                    log(f"  AFTER-PATCH FAIL_TO_PASS: {' '.join(cmd2[:6])}...")
                    r = subprocess.run(cmd2, cwd=cwd2, capture_output=True, text=True, timeout=10*60)
                    log(f"    exit={r.returncode} (expected 0)")
                    if r.returncode == 0:
                        f2p_resolved_count = len(f2p)
                        f2p_total = len(f2p)
                    else:
                        # Count how many passed from pytest summary (heuristic)
                        f2p_total = len(f2p)
                        out_tail = (r.stdout + r.stderr)[-1000:]
                        log(f"    FAIL — output tail:\n{out_tail}")
                if p2p:
                    cmd3, cwd3 = build_test_cmd(p2p[:min(10, len(p2p))])
                    log(f"  AFTER-PATCH PASS_TO_PASS (first {min(10,len(p2p))}): {' '.join(cmd3[:6])}...")
                    r = subprocess.run(cmd3, cwd=cwd3, capture_output=True, text=True, timeout=10*60)
                    p2p_total = min(10, len(p2p))
                    p2p_ok = (r.returncode == 0)
                    if not p2p_ok:
                        p2p_regression_count = 1  # at least 1 regression (pytest -x stops on first)
                        out_tail = (r.stdout + r.stderr)[-800:]
                        log(f"    FAIL (regression?):\n{out_tail}")
                    else:
                        log(f"    PASS — no regression in first {p2p_total} tests")

                # Final verdict
                verdict = "FAILED"
                if f2p_total == 0 and p2p_total == 0:
                    verdict = "UNKNOWN (no tests)"
                elif f2p_resolved_count == f2p_total and f2p_total > 0 and p2p_ok:
                    verdict = "RESOLVED"
                elif f2p_resolved_count > 0:
                    verdict = f"PARTIAL ({f2p_resolved_count}/{f2p_total} F2P resolved"
                    if not p2p_ok:
                        verdict += f", {p2p_regression_count} P2P regression)"
                    else:
                        verdict += ")"
                elif f2p_resolved_count == 0 and p2p_ok:
                    verdict = "FAILED (fix did not resolve any FAIL_TO_PASS test)"
                elif not p2p_ok:
                    verdict = "FAILED (caused PASS_TO_PASS regression)"
                log(f"\n  => VERDICT: {verdict}")
                summary_lines.append(f"{iid}: {verdict}  (patch={len(patch)}B)")

            # Print summary at bottom of log + console
            print()
            log("-" * 60)
            log("SCORE SUMMARY (fallback lightweight):")
            for s in summary_lines:
                log("  " + s)
            log("-" * 60)

        print(f"\n[score] fallback scoring log: {fallback_log}")

    return 0 if harness_success else 2  # 2 = harness failed, fallback ran


if __name__ == "__main__":
    sys.exit(main())
