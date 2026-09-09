# Weekly unattended Cleaner sweep, triggered by Windows Task Scheduler.
# Cleaner is a plain single-agent dispatch (no Workflow engine involved -- see
# SKILL.md's cleaner entry: "no engine calls it"), so this stays simple: no
# run-history stamps (those are scoped to bugger/feature Workflow runs only),
# just a log file and an exit-code check.
#
# FINDINGS REACH THE LEDGER NOW (was log-file-only until this fix): the
# interactive path has a Manager chat watching the cleaner's return to write
# ledger rows and report.md's `pending owner` rows per SKILL.md's cleaner
# entry -- an unattended cron dispatch has no such chat, so before this fix a
# needs-lane finding could never reach a future build (nothing fed `--queued`)
# and a needs-owner/needs-judgment finding could never reach the owner at all
# outside someone opening this exact log file by hand. The $prompt below now
# has the SAME top-level session stand in for that missing chat, in one turn:
# dispatch the cleaner subagent, then apply the cleaner-verdict table itself.
#
# TIMEZONE: always Friday 4am wherever the owner (and this laptop) physically
# is -- the Task Scheduler trigger itself does this, since a local weekly
# trigger automatically follows the machine's own OS timezone if it changes
# (e.g. he travels). No gating logic needed here.
#
# INDEPENDENT DEAD-EXPORT FLOOR (below, after the agent returns): this sweep
# is always unscoped, so of SKILL.md's three watermark answers only two can
# ever apply here -- plus a fourth this wrapper adds, because a cron has no
# human "dispatching chat" to catch the check silently not running. Never
# trust the cleaner's own narration of having run check-dead-exports.cjs
# clean (manager/SKILL.md's cleaner entry, cleaner.md C4) -- re-run it here,
# fresh, independent of the just-returned agent turn. This script does NOT
# write state.json itself (lastCleanSha is 28KB+ of hand-verified claims one
# JSON round-trip could mangle) -- it only prints the ruling so the owner (or
# a live Manager session) can act on it. A ruling that never got printed is
# indistinguishable from one that said "advance" -- same doctrine as
# everywhere else in this framework for a step that must not silently skip.

$repoPath = "E:\Code\Maelle"
$logDir = Join-Path $repoPath ".claude\agent-loop\cron-logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logFile = Join-Path $logDir "cleaner-run_$timestamp.log"

# Self-explanatory title so a visible window (if one ever shows) isn't mistaken
# for something stray and closed by accident -- it closes on its own when done.
$host.UI.RawUI.WindowTitle = "Cleaner sweep -- $(Get-Date -Format 'h:mmtt, MMM d')"

# AUTH: same fixed-price company-seat token as run-manager-cron.ps1 -- see
# that file's comment for why (never interactive login, never a paid API key).
if (-not $env:CLAUDE_CODE_OAUTH_TOKEN) {
    "=== Cleaner cron run ABORTED: CLAUDE_CODE_OAUTH_TOKEN is not set (regenerate with 'claude setup-token', ~1yr lifetime) ===" | Out-File -FilePath $logFile -Encoding utf8
    exit 1
}

# Same fix as run-manager-cron.ps1 -- see that file's comment. Cleaner is a
# single-agent dispatch (no Workflow), so this is cheap insurance, not the
# primary fix, but there's no reason to leave it exposed to the same ceiling.
$env:CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = "10800000"

Set-Location $repoPath

$prompt = "Run the cleaner hygiene sweep now (unscoped -- everything new since its own last watermark, state.lastCleanSha), per manager/SKILL.md's own 'cleaner' entry AND cleaner.md end to end -- this is an unattended weekly run with no separate Manager chat to do the parts SKILL.md assigns to the dispatcher, so YOU do both: (1) first check its REFUSE-while-live precondition yourself (state.lastRun.status is 'running', or state.inFlight is non-empty) -- if it applies, stop immediately and say so, do nothing else; (2) otherwise dispatch Agent({subagent_type:'cleaner'}) for the unscoped sweep; (3) when it returns, in this SAME turn, write a ledger.jsonl row (node scripts/ledger-file.cjs) for every finding per SKILL.md's cleaner-verdict table (this is what makes a needs-lane finding reachable by a future build, and a needs-owner/needs-judgment finding reach his desk -- a finding that stays only in this log is one he will never see), and rule on the watermark per cleaner.md C4, printing which of the three watermark answers applies. Leave everything uncommitted for the owner to review and wrap by hand later. Do not commit, do not push, do not wrap."

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

# ── Independent dead-export floor -- runs regardless of the agent's own exit
# code, since this check is about the state of the repo, not about whether
# the cleaner's own turn succeeded. See header comment for why this lives
# here rather than in $prompt: the whole point is that it is NOT the same
# actor narrating its own pass.
"=== Independent check-dead-exports.cjs re-run started ===" | Out-File -FilePath $logFile -Encoding utf8 -Append
$deadExportsOutput = & node scripts/check-dead-exports.cjs 2>&1
$deadExportsExit = $LASTEXITCODE
$deadExportsOutput | Out-File -FilePath $logFile -Encoding utf8 -Append
$deadExportsText = $deadExportsOutput -join "`n"

# The exit code alone cannot tell "found dead exports" (a controlled exit 1)
# apart from "crashed before it got that far" (an uncaught exception also
# exits 1 in Node) -- so completion is judged on the script's own two
# terminal print statements, not on the code by itself.
$completed = ($deadExportsText -match 'No unexplained dead export among what this run checked\.') -or
             ($deadExportsText -match '\d+ dead export\(s\)\. Confirm against HEAD')

if (-not $completed) {
    # THE CHECK ITSELF FAILED TO RUN. Reading a non-zero exit here as "dead
    # exports found" would be exactly the silent-pass-that-looks-like-success
    # this whole mechanism exists to prevent -- treat it as the same
    # non-advance case, with an honest reason instead of a false count.
    "RULING: check-dead-exports.cjs did NOT complete (exit $deadExportsExit, no completion banner in its own output) -- treated as a non-advance case -- lastCleanSha must NOT be advanced from this run" | Out-File -FilePath $logFile -Encoding utf8 -Append
} elseif ($deadExportsExit -ne 0) {
    "RULING: unscoped sweep completed, but check-dead-exports.cjs independently found unresolved dead export(s) (exit $deadExportsExit) -- lastCleanSha NOT advanced. See the DEAD lines above for file:line." | Out-File -FilePath $logFile -Encoding utf8 -Append
} else {
    $headSha = (git rev-parse HEAD 2>&1).Trim()
    "RULING: unscoped sweep -- check-dead-exports.cjs independently confirmed clean at HEAD $headSha -- lastCleanSha may be advanced to $headSha. This script does not write state.json itself; the owner (or a live Manager session) applies the advance by hand after reviewing this log." | Out-File -FilePath $logFile -Encoding utf8 -Append
}
