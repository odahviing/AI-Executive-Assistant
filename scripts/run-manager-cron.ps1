# Nightly unattended Manager run, triggered by Windows Task Scheduler.
# Runs Claude Code headlessly against this repo, skipping permission prompts
# (bugger never commits -- it only builds in the working tree and the bouncer
# gates every fix -- so an unattended run here is bounded, not free-for-all).
# A dollar cap is the backstop if something goes wrong mid-run.
#
# TIMEZONE: always 1am wherever the owner (and this laptop) physically is --
# the Task Scheduler trigger itself is what does this, since a local daily
# trigger automatically follows the machine's own OS timezone if it changes
# (e.g. he travels). No gating logic needed here.

$repoPath = "E:\Code\Maelle"
$logDir = Join-Path $repoPath ".claude\agent-loop\cron-logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logFile = Join-Path $logDir "manager-run_$timestamp.log"

# Self-explanatory title so a visible window (if one ever shows) isn't mistaken
# for something stray and closed by accident -- it closes on its own when done.
$host.UI.RawUI.WindowTitle = "Bugger run -- $(Get-Date -Format 'h:mmtt, MMM d')"

# AUTH: uses the fixed-price company seat via a one-year long-lived token
# (`claude setup-token`), never an interactive login (expires unpredictably,
# no auto-refresh headless) and never a pay-per-token API key (extra cost).
# Fail loudly and immediately if it's ever missing/cleared, rather than
# burning a $LASTEXITCODE=1/401 that looks identical to any other failure.
if (-not $env:CLAUDE_CODE_OAUTH_TOKEN) {
    "=== Manager cron run ABORTED: CLAUDE_CODE_OAUTH_TOKEN is not set (regenerate with 'claude setup-token', ~1yr lifetime) ===" | Out-File -FilePath $logFile -Encoding utf8
    exit 1
}

# `claude -p` force-kills a background Workflow task after 600s by default --
# a real bugger run takes 45-54 min, so without this every headless run was
# always going to get auto-killed mid-dispatch, no matter what else was fixed.
$env:CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = "0"
# The wall-clock window is the join key against run-history.jsonl below — cron
# runs never overlap, so no run id needs pre-minting to find "this run's" rows.
# ParseExact yields Kind=Unspecified, which .ToUniversalTime() treats as local —
# correct here since $timestamp was captured from local Get-Date.
$runStartUtc = ([datetime]::ParseExact($timestamp, "yyyy-MM-dd_HH-mm-ss", $null)).ToUniversalTime()
$historyFile = Join-Path $repoPath ".claude\agent-loop\run-history.jsonl"

Set-Location $repoPath

$prompt = "Run the manager bug loop now -- full pass (github + logs + backlog). This is an unattended overnight run: build everything you can per each lane's charter, run the combined bouncer verify pass same as always, and leave everything uncommitted in the working tree for the owner to review and wrap by hand later. Do not commit, do not push, do not wrap."

"=== Manager cron run started: $timestamp ===" | Out-File -FilePath $logFile -Encoding utf8

& claude -p $prompt `
    --dangerously-skip-permissions `
    --max-budget-usd 100 `
    --output-format text `
    2>&1 | Out-File -FilePath $logFile -Encoding utf8 -Append

$exitCode = $LASTEXITCODE
"=== Manager cron run finished: $(Get-Date -Format 'yyyy-MM-dd_HH-mm-ss') (exit $exitCode) ===" | Out-File -FilePath $logFile -Encoding utf8 -Append

# ── Did the run actually reach report-written, or die silently mid-trail? ───
# A `claude -p` process can exit 0 while the Manager itself never got past
# "triggered" (killed, budget-capped, threw before the report step) — an exit
# code alone cannot tell the two apart. run-history.jsonl can: it is stamped
# from INSIDE the Manager's own run protocol, so its last row in this run's
# window is the honest high-water mark, independent of what the wrapper's
# process exit code says.
$stampsThisRun = @()
if (Test-Path $historyFile) {
    $stampsThisRun = Get-Content $historyFile -Encoding utf8 |
        Where-Object { $_.Trim() -ne "" } |
        ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } |
        Where-Object { $_ -and $_.ts -and (-not $_.failed) -and ([datetime]$_.ts).ToUniversalTime() -gt $runStartUtc }
}

$reachedReportWritten = $stampsThisRun | Where-Object { $_.stamp -eq "report-written" }
if ($reachedReportWritten) {
    "=== Manager cron run reached report-written -- clean completion ===" | Out-File -FilePath $logFile -Encoding utf8 -Append
} else {
    $reachedResultsIn = $stampsThisRun | Where-Object { $_.stamp -eq "results-in" }
    $reachedTriggered = $stampsThisRun | Where-Object { $_.stamp -eq "triggered" }
    if ($reachedResultsIn) { $diedAfter = "results-in" }
    elseif ($reachedTriggered) { $diedAfter = "triggered" }
    else { $diedAfter = "never triggered" }

    "=== Manager cron run DIED -- last stamp reached: $diedAfter (exit $exitCode) ===" | Out-File -FilePath $logFile -Encoding utf8 -Append
    node "$repoPath\scripts\run-history-file.cjs" --failed --trigger cron --exitcode $exitCode --note "died after: $diedAfter"
}
