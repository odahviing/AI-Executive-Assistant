# Weekly unattended Cleaner sweep, triggered by Windows Task Scheduler.
# Cleaner is a plain single-agent dispatch (no Workflow engine involved -- see
# SKILL.md's cleaner entry: "no engine calls it"), so this stays simple: no
# run-history stamps (those are scoped to bugger/feature Workflow runs only),
# just a log file and an exit-code check.
#
# TIMEZONE: always Friday 4am wherever the owner (and this laptop) physically
# is -- the Task Scheduler trigger itself does this, since a local weekly
# trigger automatically follows the machine's own OS timezone if it changes
# (e.g. he travels). No gating logic needed here.

$repoPath = "E:\Code\Maelle"
$logDir = Join-Path $repoPath ".claude\agent-loop\cron-logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logFile = Join-Path $logDir "cleaner-run_$timestamp.log"

Set-Location $repoPath

$prompt = "Run the cleaner hygiene sweep now (unscoped -- everything new since its own last watermark, state.lastCleanSha). This is an unattended weekly run: follow cleaner.md exactly, act on what's provable, report needs-lane/needs-owner/needs-judgment findings as usual, and leave everything uncommitted for the owner to review and wrap by hand later. Do not commit, do not push, do not wrap."

"=== Cleaner cron run started: $timestamp ===" | Out-File -FilePath $logFile -Encoding utf8

& claude -p $prompt `
    --dangerously-skip-permissions `
    --max-budget-usd 30 `
    --output-format text `
    2>&1 | Out-File -FilePath $logFile -Encoding utf8 -Append

$exitCode = $LASTEXITCODE
"=== Cleaner cron run finished: $(Get-Date -Format 'yyyy-MM-dd_HH-mm-ss') (exit $exitCode) ===" | Out-File -FilePath $logFile -Encoding utf8 -Append

if ($exitCode -ne 0) {
    "=== Cleaner cron run FAILED (exit $exitCode) -- see this log for details ===" | Out-File -FilePath $logFile -Encoding utf8 -Append
}
