---
name: wrap
description: |
  Finish the current working session by bundling the day's work into a version. Triggered when the owner says "wrap", "wrap up", "close the patch", "cut a version", "day close", "ship it", "let's ship", "let's finish for today", "bundle this", "let's commit", or similar phrases. This skill walks the full release checklist and ENDS WITH A RUNNING MAELLE: bundle every chat's work, bump package.json, write the CHANGELOG, ledger-then-report bookkeeping, typecheck, commit, push, close or comment the GitHub issues, restart, and confirm the boot stamp. Default bump is PATCH. The detailed step-by-step lives at .claude/WRAP_UP.md — open it and follow it without improvising.
---

# Wrap — finish the session, ship a version, leave Maelle running

The owner has signaled they want to wrap. The full procedure lives at `.claude/WRAP_UP.md` — open it and follow it.

## HIS STANDING WRAP ORDER — assume all six unless he says otherwise

He has now spelled these out on 2026-07-30 and again on 2026-07-31 (*"wrap up / patch version / take code from other chat / close github issues that full resolved (or update what left) / and restart maelle"*), and asked for them to be encoded so he never repeats them. **Treat every one as already given. Do not ask.**

1. **PATCH.** Never minor unless he says the word. Never major, ever.
2. **Bundle EVERY chat's work, not just this one's.** Read the FULL working tree — `git status --porcelain` with no path filter — and commit all of it, framework files included. He has said *"take from other chats as well"* / *"take other chat code"* on three separate wraps. A commit containing only your own files is the defect.
3. **Nothing uncommitted when you are done.** Re-run `git status --porcelain` at the end; empty output is the acceptance test. That includes `.claude/agent-loop/**` bookkeeping.
4. **Close the GitHub issues that are fully resolved — and COMMENT the ones that are not.** The second half is the part that used to get skipped: a partial ticket gets a comment naming what landed and what is still open, so it is not silently left to rot. See the rules below.
5. **Restart Maelle.** The wrap is not finished at the push. Build, restart, and confirm the boot stamp.
6. **Then one summary**, stating verified-against-shipped.

## Two gates that still belong to him — do not assume these

- **The ship word itself.** Do not wrap because work has accumulated. Wait for "wrap" / "ship" / "commit" / "cut a version" / "bundle".
- **A verify overturn blocks the wrap.** If the pre-wrap verifier pass overturned a fix, do NOT wrap it in. Report it and stop. Discoveries do NOT block — his ruling: *"if i do want to fix discoveries, its not blocker, its bonus."*

## Other standing rules

- **Never skip hooks (`--no-verify`) or signing (`--no-gpg-sign`)** unless he explicitly asks.
- **`git add -A` only when the file list is clean.** If anything looks like a secret or a large binary, stage by filename instead.
- **Never `--amend`** unless he asks.
- **Commit body via HEREDOC**, never a pile of `-m` flags (`CLAUDE.md` rule 6).

## Now — open WRAP_UP.md and run the checklist

Read `.claude/WRAP_UP.md` end-to-end and run it in order. The steps that exist because they were once missed:

1. Check there is something to ship
2. Inventory the changes — **the whole tree, every chat**
3. Classify high-impact vs small
4. Version bump — **PATCH by default**
5. `package.json`
6. CHANGELOG entry, above the previous one
7. Memory / `SESSION_STARTER.md` version line — conditional, but **the version line is not conditional**: a stale "Current version" misleads every agent that boots
8. `README.md` — conditional
9. **Ledger BEFORE report.** Append every row on `report.md` to `ledger.jsonl` — whatever its verdict, not only the built ones — then reset the report. This is the only moment history can be lost, and it has been lost this way (X23). **Two fields on every row you append, and both exist because this step dropped them:**
   - **`"runId":"wrap-<version>"`** (X54) — `node scripts/ledger-stats.cjs --wrap <version>` can name a release's own rows on exactly the two versions that carried it, out of twenty released.
   - **`"recommend":"<verb> — <one clause>"`** on every row that is not `built` (X77) — it is sitting in the Status cell you are about to delete (*"pending owner — recommend build"*), and the ledger row is where it has to live to survive this step. **54 of 56** standing open rows carry none because this was never said. Verify after the append: `node scripts/ledger-stats.cjs --open` must not name the rows you just wrote.
10. `npm run typecheck` — must pass
11. Commit + push under the owner's author
12. **GitHub issues** — close or comment (below)
13. **Restart and confirm the boot stamp** (below)
14. Summary — **verified against shipped**

## Closing the GitHub issues — three conditions, and the partial half

Close only when **all three** hold: the verdict is `built`, the commit exists (close *after* the push so the sha is real), and he said wrap.

```bash
gh issue close <n> --comment "Fixed in <sha> (v<version>). <one line on what changed>"
```

**A ticket whose complaints are not all resolved does NOT close — it gets a comment instead:**

```bash
gh issue comment <n> --body-file <tmp>.md
```

naming what landed, what is still open, and why. Two things make a ticket partial: the verify's `ticketCoverage` says `partial`, or its numbered complaints outnumber the issues emitted for it. **Never close a row the verify overturned**, and never close one he has not decided. If a ticket has several findings and only some shipped, leave it open and say which parts landed — a half-fixed issue that reads as closed is worse than one still open.

## Restarting — and why not `npm run deploy`

`npm run deploy` is `build && pm2 restart && pm2 logs`, and **the log tail never exits**, so it hangs the turn. Run the two halves and read the stamp from the file instead:

```bash
npm run build
```

```bash
pm2 restart maelle
```

Then confirm from the log, not from the PM2 table:

```bash
grep -n "starting up" logs/maelle-$(date +%Y-%m-%d).log | tail -2
```

- **The `gitSha` must equal HEAD — which is the LAST commit, including the bookkeeping commit.** If the wrap made two commits, the stamp shows the second. Quoting the first is wrong (done once, 2026-07-30).
- Check the boot completed: database ready, connection registered, **Slack connected**, email registered if enabled.
- **Exactly ONE Slack socket.** Two Maelle processes on the same app give `too_many_connections`.
- Confirm zero errors: `grep -c '"level":"error"' logs/error-$(date +%Y-%m-%d).log`

## The summary — verified against shipped

State what shipped and **what of it was verified**, naming every gap. A lane may reasonably skip its own verify pass, and it is often right — but the decision must be visible at the last gate before real people see the change (X37). *"7 shipped, 4 verified"* plus the reason each unverified one carried. **One field, never a justification** — making the skip expensive to declare pushes lanes into asking for passes they do not need.

## The one-question test

> *"If someone reads the CHANGELOG in 6 months, do they know what shipped in this version and why?"*

If no → the entry needs more. If yes → you are done.
