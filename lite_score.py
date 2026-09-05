#!/usr/bin/env python3
"""
SWE-bench LIGHTWEIGHT scorer (no Docker, no huggingface network).

Usage (in WSL):
  python3 /mnt/e/opencode-dev/MyAgent/lite_score.py

Scoring flow per prediction:
  1. git worktree to base_commit
  2. Apply gold test_patch (so FAIL_TO_PASS new tests exist)
  3. pip install -e . (best effort)
  4. BASELINE check: FAIL_TO_PASS must fail, PASS_TO_PASS must pass
  5. Apply model_patch via git apply
  6. AFTER check: FAIL_TO_PASS should now pass, PASS_TO_PASS should still pass
  7. Verdict: RESOLVED / PARTIAL / FAILED / ENV_BROKEN / NO_PATCH
"""

import codecs
import json
import os
import subprocess
import sys

WIN_PRED = os.environ.get(
    "PREDICTIONS_FILE",
    "/mnt/c/Users/33378/AppData/Local/Temp/swe_bench_work/out/predictions.jsonl",
)
WIN_DS   = "/mnt/e/opencode-dev/MyAgent/swebench_verified.jsonl"
OUTDIR   = os.environ.get("OUTDIR", "/tmp/swebench-lite-score")
CLONES_ROOT = "/mnt/c/Users/33378/AppData/Local/Temp/swe_bench_work/repos"

os.makedirs(OUTDIR, exist_ok=True)


def read_no_bom(path):
    with open(path, "rb") as f:
        d = f.read()
    if d.startswith(codecs.BOM_UTF8):
        d = d[len(codecs.BOM_UTF8):]
    return d.decode("utf-8")


def strip_bom_and_ws(s: str) -> str:
    """git apply / json parse 都可能因为字符串前有 \ufeff（UTF-16 风格残留 BOM 字符）
    或空行而失败，这里强剥前导不可见字符。"""
    if s is None:
        return ""
    return s.lstrip("\ufeff\ufffe\n\r\t \v\f")


def sh(cmd, cwd=None, timeout=300, input_text=None):
    if input_text is not None:
        input_text = strip_bom_and_ws(input_text)
    return subprocess.run(
        cmd, cwd=cwd, input=input_text, text=True,
        capture_output=True, timeout=timeout,
    )


def git_apply(patch_text: str, cwd: str, extra=None, timeout=180):
    """Apply a patch via a temp file (stdin piping proved unreliable across
    locales/encodings in WSL). Returns subprocess.CompletedProcess."""
    patch_text = strip_bom_and_ws(patch_text)
    if not patch_text.endswith("\n"):
        patch_text += "\n"
    pf = os.path.join(cwd, "_score_apply.patch")
    with open(pf, "w", newline="\n", encoding="utf-8") as f:
        f.write(patch_text)
    args = ["git", "apply", "--whitespace=nowarn", "--recount"]
    if extra:
        args.extend(extra)
    args.append("_score_apply.patch")
    r = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout)
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


def load_dataset():
    out = {}
    for line in read_no_bom(WIN_DS).split("\n"):
        line = strip_bom_and_ws(line)
        if not line:
            continue
        inst = json.loads(line)
        out[inst["instance_id"]] = inst
    return out


def load_predictions():
    out = {}
    for line in read_no_bom(WIN_PRED).split("\n"):
        line = strip_bom_and_ws(line)
        if not line:
            continue
        p = json.loads(line)
        out[p["instance_id"]] = p
    return out


def _django_label(t: str) -> str:
    """Convert FAIL_TO_PASS entries to Django runtests labels.
    Dataset entries may be either:
      - 'queries.test_qs_combinators.Cls.test_method'
      - 'test_method (queries.test_qs_combinators.Cls)'   (Django log format)
    The latter must be REORDERED to 'queries.test_qs_combinators.Cls.test_method'.
    """
    import re
    m = re.match(r"^([\w.]+)\s+\(([\w.]+)\)\s*$", t.strip())
    if m:
        method, label = m.group(1), m.group(2)
        t = f"{label}.{method}"
    if t.startswith("tests."):
        t = t[len("tests."):]
    return t


def build_test_cmds(repo: str, tests):
    is_django = "django" in repo.lower()
    if is_django:
        args = [_django_label(t) for t in tests]
        return ["python3", "tests/runtests.py", "--verbosity", "2"] + args
    else:
        out_args = []
        for t in tests:
            if "::" in t:
                head, rest = t.split("::", 1)
            else:
                head, rest = t, ""
            if "/" not in head and not head.endswith(".py"):
                # dotted module path -> file path: tests.test_blueprints -> tests/test_blueprints.py
                head = head.replace(".", "/") + ".py"
            out_args.append(head + (f"::{rest}" if rest else ""))
        # -o filterwarnings=ignore: old projects (flask 2022 on py3.12) treat
        # DeprecationWarnings as errors via ini; override so warnings don't mask
        # real test pass/fail.
        return ["python3", "-m", "pytest", "--tb=short", "-rN",
                "-o", "filterwarnings=ignore",
                "-W", "ignore"] + out_args


def kill_orphans():
    """Kill leftover lite_score.py processes from previously killed shells
    (they race on git worktree admin dirs under /mnt/c clones).
    Exclude ourselves and our parent shell."""
    me = os.getpid()
    parent = os.getppid()
    r = subprocess.run(["pgrep", "-f", "lite_score.py"], capture_output=True, text=True)
    if r.returncode != 0:
        return
    for token in r.stdout.split():
        try:
            pid = int(token)
        except ValueError:
            continue
        if pid in (me, parent):
            continue
        try:
            os.kill(pid, 9)
            print(f"[init] killed orphaned scoring process pid={pid}")
        except (ProcessLookupError, PermissionError):
            pass


def smart_excerpt(r, repo: str, max_lines: int = 45) -> str:
    """Extract meaningful lines from test output. Django runtests floods with
    'Creating table' / 'Applying' noise; filter those out."""
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
    # pull summary lines (short tests have everything; keep tail anyway)
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


def main():
    kill_orphans()
    ds = load_dataset()
    preds = load_predictions()
    print(f"[load] dataset instances={len(ds)}  predictions={len(preds)}  file={WIN_PRED}")

    summary = []

    for iid, p in preds.items():
        print()
        print("=" * 70)
        patch = p.get("model_patch") or ""
        if not patch.strip():
            print(f"[{iid}] NO PATCH -> skip")
            summary.append(f"{iid}: NO PATCH")
            continue
        inst = ds.get(iid)
        if not inst:
            print(f"[{iid}] instance data MISSING")
            summary.append(f"{iid}: SKIP (missing instance in dataset)")
            continue
        f2p = decode_list(inst.get("FAIL_TO_PASS"))
        p2p = decode_list(inst.get("PASS_TO_PASS"))
        repo = inst["repo"]
        base = inst["base_commit"]

        print(f"[{iid}]  patch={len(patch)}B  repo={repo}  base={base[:12]}...")
        print(f"  FAIL_TO_PASS={len(f2p)}  sample={f2p[:1]}")
        print(f"  PASS_TO_PASS={len(p2p)}  first-5={p2p[:5]}")

        # Find clone
        clone_name = repo.replace("/", "__")
        clone = os.path.join(CLONES_ROOT, clone_name)
        if not os.path.isdir(os.path.join(clone, ".git")):
            print(f"  clone dir not found at {clone} -> cannot score locally")
            summary.append(f"{iid}: CLONE_MISSING (need git clone {repo} to {clone})")
            continue

        # Make worktree (unique basename to avoid admin-dir collisions across runs)
        score_root = f"{OUTDIR}/score-{iid.replace('/', '__')}"
        wt = f"{score_root}/wt-{os.getpid()}"
        subprocess.run(["rm", "-rf", score_root], capture_output=True)
        os.makedirs(score_root, exist_ok=True)

        sh(["git", "worktree", "remove", "--force", wt], cwd=clone)
        sh(["git", "worktree", "prune"], cwd=clone)
        r = sh(
            ["git", "worktree", "add", "--quiet", "--detach", wt, base],
            cwd=clone,
        )
        if r.returncode != 0:
            msg = (r.stderr or r.stdout)[:400]
            print(f"  WORKTREE FAIL: {msg}")
            summary.append(f"{iid}: WORKTREE_FAIL")
            continue
        print(f"  worktree: {wt}")

        def git_healthy() -> bool:
            r = sh(["git", "rev-parse", "HEAD"], cwd=wt, timeout=60)
            return r.returncode == 0

        def ensure_git_healthy() -> bool:
            """Worktree admin dirs can be clobbered by concurrent/pruned runs;
            'git worktree repair' restores them."""
            if git_healthy():
                return True
            sh(["git", "worktree", "repair", wt], cwd=clone, timeout=120)
            sh(["git", "worktree", "repair"], cwd=wt, timeout=120)
            return git_healthy()

        # Apply GOLD test_patch
        if inst.get("test_patch"):
            r = git_apply(inst["test_patch"], wt)
            if r.returncode == 0:
                print("  test_patch applied (gold)")
            else:
                msg = (r.stderr or r.stdout)[:300]
                print(f"  test_patch non-fatal: {msg}")

        # Install deps
        has_setup = (
            os.path.isfile(os.path.join(wt, "setup.py"))
            or os.path.isfile(os.path.join(wt, "pyproject.toml"))
        )
        is_django = "django" in repo.lower()
        if has_setup:
            r = sh(
                [
                    "python3", "-m", "pip", "install", "-e", ".", "--quiet",
                    "--break-system-packages",
                ],
                cwd=wt, timeout=900,
            )
            print(f"  pip install -e . exit={r.returncode}")
            if r.stderr.strip():
                tail = r.stderr[-400:] if len(r.stderr) > 400 else r.stderr
                print(f"  pip stderr tail:\n{tail}")

        # Project-specific test dependencies
        if is_django:
            # Django runtests.py needs these; tests/requirements/py3.txt contains
            # C-extension deps (pylibmc/mysqlclient/psycopg/bmemcached) that fail to
            # build without system libs — filter them out; the combinator/validators
            # tests only need sqlite + pure-python deps.
            req = os.path.join(wt, "tests", "requirements", "py3.txt")
            if os.path.isfile(req):
                filtered = os.path.join(score_root, "req-filtered.txt")
                with open(req, encoding="utf-8") as f:
                    req_lines = f.readlines()
                skip = ("pylibmc", "bmemcached", "mysqlclient", "psycopg",
                        "aiomysql", "mysql-connector")
                kept = [l for l in req_lines
                        if not any(k in l.lower() for k in skip)]
                with open(filtered, "w") as f:
                    f.writelines(kept)
                print(f"  filtered requirements: kept {len(kept)}/{len(req_lines)} lines "
                      f"(excluded {[l.strip() for l in req_lines if any(k in l.lower() for k in skip)]})")
                r = sh(
                    ["python3", "-m", "pip", "install", "-r", filtered, "--quiet",
                     "--break-system-packages"],
                    cwd=wt, timeout=900,
                )
                print(f"  django filtered requirements exit={r.returncode}")
                if r.returncode != 0 and r.stderr.strip():
                    print(f"    stderr: {r.stderr[-300:]}")
            else:
                r = sh(
                    ["python3", "-m", "pip", "install", "--quiet",
                     "--break-system-packages", "sqlparse", "asgiref", "tzdata"],
                    timeout=300,
                )
                print(f"  django fallback deps exit={r.returncode}")
        else:
            # pytest-family projects (flask ~2022 needs pytest<8 due to monkeypatch.notset)
            r = sh(
                ["python3", "-m", "pip", "install", "--quiet",
                 "--break-system-packages", "pytest==7.4.4"],
                timeout=300,
            )
            print(f"  pytest==7.4.4 exit={r.returncode}")
            # try project test extras
            for extras in [".[test]", ".[tests]"]:
                r = sh(
                    ["python3", "-m", "pip", "install", "-e", extras, "--quiet",
                     "--break-system-packages"],
                    cwd=wt, timeout=600,
                )
                if r.returncode == 0:
                    print(f"  pip install -e '{extras}' OK")
                    break
            # era-specific pins:
            #  flask 2022 uses LocalProxy(unbound_message=...) (needs werkzeug>=2.1)
            #  but also werkzeug.__version__ (removed in 3.0) -> window is 2.x
            if "flask" in repo.lower():
                r = sh(
                    ["python3", "-m", "pip", "install", "--quiet", "--upgrade",
                     "--break-system-packages", "Werkzeug>=2.1,<3"],
                    cwd=wt, timeout=300,
                )
                print(f"  Werkzeug>=2.1,<3 pin exit={r.returncode}")
            if "requests" in repo.lower():
                r = sh(
                    ["python3", "-m", "pip", "install", "--quiet",
                     "--break-system-packages", "trustme", "pytest-mock",
                     "charset-normalizer<4"],
                    cwd=wt, timeout=300,
                )
                print(f"  requests test deps exit={r.returncode}")

        # Baseline
        baseline_valid = True
        if f2p:
            r = sh(build_test_cmds(repo, f2p), cwd=wt, timeout=600)
            ok = (r.returncode != 0)
            print(f"  baseline F2P exit={r.returncode}  (expected nonzero = {ok})")
            if not ok:
                baseline_valid = False
                print(f"    (warning: FAIL_TO_PASS passes BEFORE fix; env_broken)\n{smart_excerpt(r, repo)}")
        if p2p:
            sample = p2p[:5]
            r = sh(build_test_cmds(repo, sample), cwd=wt, timeout=600)
            ok = (r.returncode == 0)
            print(f"  baseline P2P(first 5) exit={r.returncode}  (expected zero = {ok})")
            if not ok:
                baseline_valid = False
                print(f"    (warning: PASS_TO_PASS fails BEFORE fix; env_broken)\n{smart_excerpt(r, repo)}")

        # Apply MODEL patch
        #  (worktree metadata may have been clobbered by concurrent pruning;
        #   repair + re-apply if needed)
        if not ensure_git_healthy():
            print("  git worktree broken and could NOT be repaired -> skip")
            summary.append(f"{iid}: WORKTREE_BROKEN  (patch={len(patch)}B)")
            sh(["git", "worktree", "remove", "--force", wt], cwd=clone, timeout=120)
            sh(["git", "worktree", "prune"], cwd=clone, timeout=120)
            subprocess.run(["rm", "-rf", score_root], capture_output=True)
            continue
        r = git_apply(patch, wt)
        if r.returncode != 0:
            # one retry after repair (in case admin dir was stale but rev-parse still worked)
            sh(["git", "worktree", "repair", wt], cwd=clone, timeout=120)
            r = git_apply(patch, wt)
        if r.returncode != 0:
            msg = (r.stderr or r.stdout)[:600]
            print(f"  MODEL_PATCH APPLY_FAIL:\n{msg}")
            summary.append(f"{iid}: APPLY_FAIL  (patch={len(patch)}B)")
            sh(["git", "worktree", "remove", "--force", wt], cwd=clone, timeout=120)
            sh(["git", "worktree", "prune"], cwd=clone, timeout=120)
            subprocess.run(["rm", "-rf", score_root], capture_output=True)
            continue
        print(f"  model_patch applied ({len(patch)}B)")

        # Score
        f2p_total = len(f2p)
        resolved = 0
        if f2p:
            r = sh(build_test_cmds(repo, f2p), cwd=wt, timeout=600)
            if r.returncode == 0:
                resolved = f2p_total
                print(f"  AFTER: FAIL_TO_PASS => ALL PASS ✅ ({resolved}/{f2p_total})")
            else:
                resolved = 0
                print(f"  AFTER: FAIL_TO_PASS => FAILED exit={r.returncode}")
                print(f"    excerpt:\n{smart_excerpt(r, repo)}")
        p2p_pass = True
        p2p_regression_detected = False
        if p2p:
            sample = p2p[:min(10, len(p2p))]
            r = sh(build_test_cmds(repo, sample), cwd=wt, timeout=600)
            p2p_pass = (r.returncode == 0)
            if p2p_pass:
                print(f"  AFTER: PASS_TO_PASS (first {len(sample)}) => still pass ✅")
            else:
                p2p_regression_detected = True
                print(f"  AFTER: PASS_TO_PASS (first {len(sample)}) => REGRESSION ❌ exit={r.returncode}")
                print(f"    excerpt:\n{smart_excerpt(r, repo)}")

        # Verdict
        if f2p_total == 0:
            verdict = "UNKNOWN (no FAIL_TO_PASS in instance data)"
        elif not baseline_valid:
            verdict = (
                "ENV_BROKEN (baseline checks failed; cannot judge resolution purely from test exit codes). "
                + ("F2P passes before? " + ("YES " if (resolved and baseline_valid) else "NO"))
                + ("P2P regressions? " + ("YES" if p2p_regression_detected else "NO"))
            )
            if resolved == f2p_total:
                verdict = "ENV_BROKEN but AFTER: FAIL_TO_PASS = ALL PASS (likely RESOLVED) — but baseline env was invalid so cannot guarantee"
        elif resolved == f2p_total and not p2p_regression_detected:
            verdict = "RESOLVED"
        elif resolved > 0:
            verdict = (
                f"PARTIAL ({resolved}/{f2p_total} F2P resolved)"
                + (" + P2P regression" if p2p_regression_detected else "")
            )
        elif p2p_regression_detected:
            verdict = "FAILED (PASS_TO_PASS regression caused by patch)"
        else:
            verdict = "FAILED (fix did not resolve any FAIL_TO_PASS test)"

        print(f"\n  🏁  VERDICT: {verdict}")
        summary.append(f"{iid}: {verdict}  (patch={len(patch)}B)")

        # Cleanup worktree registration for this iteration
        sh(["git", "worktree", "remove", "--force", wt], cwd=clone, timeout=120)
        sh(["git", "worktree", "prune"], cwd=clone, timeout=120)
        subprocess.run(["rm", "-rf", score_root], capture_output=True)

    print()
    print("=" * 70)
    print("LITE SCORE SUMMARY")
    print("=" * 70)
    for s in summary:
        print("  " + s)
    print("=" * 70)
    print(f"WSL outputs under: {OUTDIR}")


if __name__ == "__main__":
    main()
