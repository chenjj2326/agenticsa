﻿﻿﻿# ============================================================
#  SWE-bench one-click runner (English / UTF-8 BOM / PS5 safe)
#
#  Usage:
#    Open a FRESH PowerShell window, then:
#      cd E:\opencode-dev\MyAgent
#      .\run-swebench.ps1
#
#  If MYAGENT_API_KEY env var is missing you will be prompted to paste
#  it inline, and the script persists it to your User env scope.
# ============================================================

$ErrorActionPreference = "Continue"
$projRoot = "E:\opencode-dev\MyAgent"
$workDir  = "$env:TEMP\swe_bench_work"
$dataset  = "$projRoot\swebench_verified.jsonl"
$outFile  = "$workDir\out\predictions.jsonl"
$reportDir = "$projRoot\reports"
# 模型：默认用 glm-4.5（强模型，SWE-bench 正确率远高于 glm-4-flash）
#  可用：glm-4-flash / glm-4-air / glm-4-plus / glm-4.5 / glm-4
$model = if ($env:MYAGENT_MODEL) { $env:MYAGENT_MODEL } else { "glm-4.5" }
# 5 instance ids CONFIRMED present in the Verified dataset JSONL
$instanceIds = "pallets__flask-5014,psf__requests-1142,psf__requests-1724,django__django-10097,django__django-10554"

Set-Location $projRoot
New-Item -ItemType Directory -Force -Path "$workDir\logs" | Out-Null
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

function Write-Head($msg) { Write-Host ""; Write-Host "== $msg ==" -ForegroundColor Cyan }

# ---------- 1) Resolve API key ----------
Write-Head "Step 1/4  API key check"
$key = $env:MYAGENT_API_KEY
if (-not $key) {
  $key = [Environment]::GetEnvironmentVariable("MYAGENT_API_KEY","User")
  if ($key) { [Environment]::SetEnvironmentVariable("MYAGENT_API_KEY",$key,"Process") }
}
if (-not $key) {
  Write-Host "MYAGENT_API_KEY not set." -ForegroundColor Yellow
  Write-Host "Paste your ZhiPu (open.bigmodel.cn) API key below and press Enter:"
  Write-Host "  (format looks like: xxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxx)" -ForegroundColor DarkGray
  $pasted = Read-Host "ZhiPu API key"
  if (-not $pasted) { Write-Host "ABORT: no key provided." -ForegroundColor Red; exit 1 }
  $key = $pasted.Trim()
  [Environment]::SetEnvironmentVariable("MYAGENT_API_KEY",$key,"User")
  [Environment]::SetEnvironmentVariable("MYAGENT_API_KEY",$key,"Process")
  Write-Host "Saved to your User environment (persisted)." -ForegroundColor Green
}
Write-Host "OK key loaded, length=$($key.Length)" -ForegroundColor Green

# ---------- 2) Diagnose glm-4-flash tool calling ----------
Write-Head "Step 2/4  Diagnose glm-4-flash function calling"
npx tsx src/bench/diag-zhipu-tools.ts 2>&1 | Tee-Object -FilePath "$workDir\logs\diag-zhipu-tools.log"

# ---------- 3) Batch-predict 5 instances ----------
Write-Head "Step 3/4  Predict 5 SWE-bench Verified instances"
Write-Host "Instances : $instanceIds"
Write-Host "Work dir  : $workDir"
Write-Host "Output    : $outFile"
Write-Host "Max steps : 80, Timeout : 45 min, Temperature : 0.1"
Write-Host "Model     : $model"

# start with fresh predictions so re-runs always score the current model
if (Test-Path $outFile) { Remove-Item -Force $outFile; Write-Host "(cleared prior predictions)" }

npx tsx src/bench/swebench-run.ts `
  --dataset $dataset `
  --workdir $workDir `
  --out $outFile `
  --provider zhipu `
  --model $model `
  --instances $instanceIds `
  --max-steps 80 `
  --timeout-min 45 `
  --temp 0.1 2>&1 | Tee-Object -FilePath "$workDir\logs\run-batch.log"

# ---------- 4) WSL harness scoring ----------
Write-Head "Step 4/4  Score via official harness (WSL + Docker)"

if (-not (Test-Path $outFile)) {
  Write-Host "FATAL: $outFile missing — step 3 likely failed. See $workDir\logs\run-batch.log" -ForegroundColor Red
  exit 1
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$wslPred = "/tmp/predictions-$stamp.jsonl"

# 4a. Copy predictions.jsonl bytes into WSL /tmp via stdin (no quoting issues)
Write-Host "Copying predictions into WSL -> $wslPred"
Get-Content -Raw -Encoding UTF8 $outFile | wsl -- bash -lc "cat > $wslPred && wc -l $wslPred && wc -c $wslPred"
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: failed to copy predictions to WSL" -ForegroundColor Red
  exit 1
}

# 4b. Quick docker + swebench sanity inside WSL
Write-Host "Sanity: docker status + swebench import"
wsl -- bash -lc "docker info >/dev/null 2>&1 && echo docker_OK || echo docker_DOWN; python3 -c 'import swebench; print(\"swebench v\" + getattr(swebench, \"__version__\", \"?\"))'"

# 4c. Run evaluation
Write-Host "Starting harness  run_id=myagent-v1-$stamp  (this takes a while)"
$reportLog = "$reportDir\harness-$stamp.log"
wsl -- bash -lc "mkdir -p /tmp/swebench-report-$stamp && cd /tmp/swebench-report-$stamp && python3 -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Verified --predictions_path '$wslPred' --run_id 'myagent-v1-$stamp' --max_workers 2 --split test 2>&1 | tee harness.log; echo '--- ls report dir ---'; ls -la" 2>&1 | Tee-Object -FilePath $reportLog

Write-Host ""
Write-Host "================ DONE ================" -ForegroundColor Green
Write-Host "Predictions      : $outFile"
Write-Host "Harness log      : $reportLog"
Write-Host "Diagnostic logs  : $workDir\logs\"
Write-Host "======================================"