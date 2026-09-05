#!/usr/bin/env python3
"""Diagnose why model patches fail to apply: dump full patch with visible chars."""
import codecs, json, os, subprocess

WIN_PRED = "/mnt/c/Users/33378/AppData/Local/Temp/swe_bench_work/out/predictions.jsonl"
CLONES = "/mnt/c/Users/33378/AppData/Local/Temp/swe_bench_work/repos"

with open(WIN_PRED, "rb") as f:
    raw = f.read()
if raw.startswith(codecs.BOM_UTF8):
    raw = raw[len(codecs.BOM_UTF8):]

for line in raw.decode("utf-8").split("\n"):
    line = line.lstrip("\ufeff").strip()
    if not line:
        continue
    o = json.loads(line)
    patch = o.get("model_patch") or ""
    if not patch.strip():
        continue
    iid = o["instance_id"]
    print("=" * 72)
    print(f"[{iid}] patch {len(patch)} bytes, {patch.count(chr(10))+1} lines")
    # dump every line with explicit markers
    for n, pl in enumerate(patch.split("\n"), 1):
        # show trailing whitespace / CR explicitly
        vis = pl.replace("\r", "<CR>").replace("\t", "<TAB>")
        if pl != pl.rstrip(" \t"):
            vis += "<TRAIL_WS>"
        print(f"{n:3d}|{vis}")
    # try apply on fresh worktree (repo/base from dataset)
    ds_path = "/mnt/e/opencode-dev/MyAgent/swebench_verified.jsonl"
    with open(ds_path, "rb") as df:
        draw = df.read()
    if draw.startswith(codecs.BOM_UTF8):
        draw = draw[len(codecs.BOM_UTF8):]
    base = None
    repo = None
    for dl in draw.decode("utf-8").split("\n"):
        dl = dl.lstrip("\ufeff").strip()
        if not dl:
            continue
        di = json.loads(dl)
        if di["instance_id"] == iid:
            base = di["base_commit"]
            repo = di["repo"]
            break
    clone = os.path.join(CLONES, repo.replace("/", "__"))
    wt = f"/tmp/diag-{iid.replace('__','_')}"
    subprocess.run(["rm", "-rf", wt], capture_output=True)
    subprocess.run(["git", "worktree", "remove", "--force", wt], cwd=clone, capture_output=True)
    subprocess.run(["git", "worktree", "prune"], cwd=clone, capture_output=True)
    r = subprocess.run(["git", "worktree", "add", "--quiet", "--detach", wt, base],
                       cwd=clone, capture_output=True, text=True)
    if r.returncode != 0:
        print("WORKTREE FAIL:", r.stderr[:300])
        continue
    patchfile = "/tmp/diag.patch"
    with open(patchfile, "w", newline="\n") as pf:
        pf.write(patch if patch.endswith("\n") else patch + "\n")
    for attempt, args in [
        ("git apply --check", ["git", "apply", "--check", "-v", patchfile]),
        ("git apply --check --recount", ["git", "apply", "--check", "--recount", "-v", patchfile]),
        ("git apply --check --whitespace=nowarn", ["git", "apply", "--check", "--whitespace=nowarn", "-v", patchfile]),
    ]:
        r = subprocess.run(args, cwd=wt, capture_output=True, text=True)
        print(f"--- {attempt}: exit={r.returncode}")
        if r.stdout.strip():
            print("  stdout:", r.stdout[-400:])
        if r.stderr.strip():
            print("  stderr:", r.stderr[-400:])
    subprocess.run(["git", "worktree", "remove", "--force", wt], cwd=clone, capture_output=True)
