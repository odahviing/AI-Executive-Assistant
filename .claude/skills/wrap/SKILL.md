---
name: wrap
description: |
  Finish the current working session by bundling the day's work into a version. Triggered when the owner says "wrap", "wrap up", "close the patch", "cut a version", "day close", "ship it", "let's ship", "let's finish for today", "bundle this", "let's commit", or similar phrases. This skill walks the full release checklist and ENDS WITH A RUNNING MAELLE: bundle every chat's work, bump package.json, write the CHANGELOG, ledger-then-report bookkeeping, typecheck, commit, push, close or comment the GitHub issues, and confirm the VM's boot stamp. Default bump is PATCH. The detailed step-by-step lives at .claude/WRAP_UP.md — open it and follow it without improvising.
---

# Wrap — finish the session, ship a version, leave Maelle running

The owner has signaled they want to wrap. The full procedure lives at `.claude/WRAP_UP.md` — open it and follow it.

## HIS STANDING WRAP ORDER — assume all six unless he says otherwise

He has now spelled these out on 2026-07-30 and again on 2026-07-31 (*"wrap up / patch version / take code from other chat / close github issues that full resolved (or update what left) / and restart maelle"*), and asked for them to be encoded so he never repeats them. **Treat every one as already given. Do not ask.**

1. **PATCH.** Never minor unless he says the word. Never major, ever.
2. **Bundle EVERY chat's work, not just this one's.** Read the FULL working tree — `git status --porcelain` with no path filter — and commit all of it, framework files included. He has said *"take from other chats as well"* / *"take other chat code"* on three separate wraps. A commit containing only your own files is the defect.
3. **Nothing uncommitted when you are done.** Re-run `git status --porcelain` at the end; empty output is the acceptance test. That includes `.claude/agent-loop/**` bookkeeping.
4. **Close the GitHub issues that are fully resolved — and COMMENT the ones that are not.** The second half is the part that used to get skipped: a partial ticket gets a comment naming what landed and what is still open, so it is not silently left to rot. The three closing conditions and the partial rule are WRAP_UP.md's GitHub-issues step.
5. **Maelle running on the new sha.** The push *is* the restart — the VM auto-deploys. **Never build or restart locally: there is no local Maelle and starting one opens a second Slack socket.** The wrap is not finished until the VM's boot stamp confirms the new sha (WRAP_UP.md's boot-stamp step).
6. **Then one summary**, stating verified-against-shipped.

## Two gates that still belong to him — do not assume these

- **The ship word itself.** Do not wrap because work has accumulated. Wait for "wrap" / "ship" / "commit" / "cut a version" / "bundle".
- **A verify overturn blocks the wrap.** WRAP_UP.md's pre-wrap verify step is the ONE place this is spelled out — the golden battery first, then one adversarial pass forced to Fable over the full accumulated diff, and it runs BEFORE the version bump or CHANGELOG exist. Overturning a fix means do NOT wrap it in: report it and stop. Discoveries do NOT block — his ruling: *"if i do want to fix discoveries, its not blocker, its bonus."*

## Other standing rules

- **Never skip hooks (`--no-verify`) or signing (`--no-gpg-sign`)** unless he explicitly asks.
- **`git add -A` only when the file list is clean.** If anything looks like a secret or a large binary, stage by filename instead.
- **Never `--amend`** unless he asks.
- **Commit body via HEREDOC**, never a pile of `-m` flags (`CLAUDE.md` rule 6).

## Now — open WRAP_UP.md and run the checklist

`.claude/WRAP_UP.md` is the procedure and **the only numbered copy of it**. Read it end-to-end and run it in order. This file used to number the fourteen steps as well, one step short and one number out of step against the file it delegates to — which is how the wrap ran for seven releases with no bookkeeping at all. **This file names steps; that file numbers them.** When a step changes, it changes there.

Four of them exist because they were once missed. Confirm each actually happened before you call the wrap done:

- **Inventory the whole tree, every chat** — `git status --porcelain` with no path filter.
- **The `SESSION_STARTER.md` version line.** The rest of the memory update is conditional; that line is not — a stale "Current version" misleads every agent that boots.
- **Bookkeeping: the ledger BEFORE the report, then the wrap stamp after the push.** Two markers, `"runId":"wrap-<version>"` on every appended row and `state.lastWrapIso`, and one acceptance test for both — `node scripts/ledger-stats.cjs --report` must be **green**. Do not finish a wrap on a red one.
- **Verified against shipped** in the summary — *"7 shipped, 4 verified"*, plus the reason each gap carried.

Issue closing, the boot stamp and the summary are that file's last three steps, and the CHANGELOG's one-question test closes it. All four stood in full in both files until 2026-08-01; **one copy, and it is that one.**

**A fifth, newer than the rest and never duplicated in the first place: pre-wrap adversarial verify — the golden battery, then one pass forced to Fable over the full accumulated diff (WRAP_UP.md's pre-wrap verify step, run early, before the bump is decided).** An overturn or a battery `fail` blocks the wrap; confirm it ran before you call the wrap done.
