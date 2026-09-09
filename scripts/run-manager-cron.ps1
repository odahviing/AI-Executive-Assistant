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
# 3 hours, not 0 (unlimited) -- a real bound so a genuine hang still gets
# killed eventually instead of running forever.
$env:CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = "10800000"
# The wall-clock window is the join key against run-history.jsonl below — cron
# runs never overlap, so no run id needs pre-minting to find "this run's" rows.
# ParseExact yields Kind=Unspecified, which .ToUniversalTime() treats as local —
# correct here since $timestamp was captured from local Get-Date.
$runStartUtc = ([datetime]::ParseExact($timestamp, "yyyy-MM-dd_HH-mm-ss", $null)).ToUniversalTime()
$historyFile = Join-Path $repoPath ".claude\agent-loop\run-history.jsonl"

Set-Location $repoPath

# The "when you stamp triggered, pass --trigger cron" sentence below is load-bearing,
# not decoration: measured against run-history.jsonl 2026-08-22..09-09, cron-dispatched
# runs (cross-referenced 1:1 against cron-logs/*.log by runId, e.g. wf_a97a95b0-655,
# wf_4851e2ec-a37, wf_a19a0671-5c3) landed --trigger user more often than cron -- the model
# was inferring "am I the cron run?" from this prompt's OLDER, merely descriptive wording
# ("this is an unattended overnight run"), cross-referenced against a SEPARATE paraphrase
# of that same sentence in SKILL.md, tens of minutes and dozens of tool calls after reading
# it. Two-hop wording-matching, done from memory, mid-run: that is what was failing, not the
# model's memory of the prompt itself. This makes the instruction a direct, unambiguous
# command right next to the phrase that used to require inference.
$prompt = "Run the manager bug loop now -- full pass (github + logs + backlog). This is an unattended overnight run: build everything you can per each lane's charter, run the combined bouncer verify pass same as always, and leave everything uncommitted in the working tree for the owner to review and wrap by hand later. Do not commit, do not push, do not wrap. When you stamp this run's start (run-history-file.cjs --stamp triggered), pass --trigger cron -- this exact invocation is the unattended cron wrapper, not you."

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

    # ── Before declaring this run dead: `claude -p` can get killed AFTER the
    # engine finished and persisted its result to disk, but BEFORE the
    # Manager's own report-written stamp (or even results-in) made it into
    # run-history.jsonl -- run-history's own trail is then a false negative.
    # This actually happened twice (wf_a19a0671-5c3, wf_55ef2447-54f, both
    # reconciled by hand weeks later) before this check existed. The engine's
    # own persisted Workflow JSON, keyed by this run's runId under the Claude
    # Code projects dir, is ground truth for whether the run really
    # completed -- check it before trusting run-history's incomplete trail.
    $reconciled = $false
    $triggeredRunId = ($reachedTriggered | Select-Object -Last 1).runId
    if ($triggeredRunId) {
        $claudeProjectsDir = Join-Path $env:USERPROFILE ".claude\projects\E--Code-Maelle"
        $wfFile = Get-ChildItem -Path (Join-Path $claudeProjectsDir "*\workflows\$triggeredRunId.json") -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($wfFile) {
            try { $wf = Get-Content $wfFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json } catch { $wf = $null }
            if ($wf -and $wf.status -eq "completed" -and $wf.result -and $wf.result.manifest) {
                $m = $wf.result.manifest
                $pendingOwner = $m.decisions.onHisDesk
                if ($null -eq $pendingOwner) { $pendingOwner = 0 }
                $finding = "run manifest -- $($m.outcome.candidates) built, $($m.bounce.bounced) bounced, $($m.verify.discoveries) discoveries queued, $($m.joint.traced)/$($m.joint.candidates) joint-traced, $($m.outcome.traced)/$($m.outcome.candidates) outcome-traced, golden $($m.golden.passed)/$($m.golden.itemsInFile)"
                $note = "Auto-reconciled by run-manager-cron.ps1 -- run-history.jsonl's own trail stopped at '$diedAfter' (exit $exitCode) but the engine's persisted Workflow result at $($wfFile.FullName) shows status:completed with a full manifest. Written automatically at cron-detection time, not backfilled by hand."
                # PowerShell silently STRIPS unescaped `"` when marshaling an argument to a
                # native exe (proven: node echoed `{a:1,b:two}` back for an unescaped
                # `{"a":1,"b":"two"}` argument, valid JSON only once every `"` was
                # backslash-escaped first) -- the manifest is the one argument here
                # guaranteed to be full of them, so it is the one that needs this.
                $manifestJson = ($m | ConvertTo-Json -Depth 30 -Compress) -replace '"', '\"'

                $ledgerArgs = @("$repoPath\scripts\ledger-file.cjs", '--run-manifest', '--runId', $triggeredRunId, '--finding', $finding, '--manifest', $manifestJson, '--note', $note)
                & node @ledgerArgs 2>&1 | Out-File -FilePath $logFile -Encoding utf8 -Append
                $ledgerExit = $LASTEXITCODE

                $headline = "Run $triggeredRunId -- auto-reconciled by run-manager-cron.ps1 (native report-written stamp never landed): $finding"
                & node "$repoPath\scripts\run-history-file.cjs" --runId $triggeredRunId --stamp report-written --headline $headline --pendingOwner $pendingOwner --note "auto-reconciled (ledger write exit $ledgerExit), engine status:completed" 2>&1 | Out-File -FilePath $logFile -Encoding utf8 -Append
                $historyExit = $LASTEXITCODE

                if ($historyExit -eq 0) {
                    "=== Manager cron run RECONCILED -- engine completed (runId $triggeredRunId), report-written stamped automatically (ledger write exit $ledgerExit) ===" | Out-File -FilePath $logFile -Encoding utf8 -Append
                    $reconciled = $true
                } else {
                    "=== Manager cron run reconciliation FAILED (report-written stamp exit $historyExit) -- falling through to DIED path ===" | Out-File -FilePath $logFile -Encoding utf8 -Append
                }
            }
        }
    }

    if (-not $reconciled) {
        "=== Manager cron run DIED -- last stamp reached: $diedAfter (exit $exitCode) ===" | Out-File -FilePath $logFile -Encoding utf8 -Append
        node "$repoPath\scripts\run-history-file.cjs" --failed --trigger cron --exitcode $exitCode --note "died after: $diedAfter"
    }
}
