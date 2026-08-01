---
name: trace
description: |
  Post-build paper-trace verification. After building a change (a fix, a guard, a new mechanism), generate a scenario matrix that covers every use case and regression surface, and trace each scenario against the CODE ON DISK with file:line citations — before declaring the build done. Triggered when the owner says "paper trace it", "run traces", "trace the change", "make sure it works / no regression", "run 10 scenarios", "all the cases you can think", or when a build instruction itself includes tracing ("do the change and then paper trace with different scenarios"). Distinct from the `scenario` skill (which replays the FIXED catalog in .claude/test-scenarios.md) — `trace` GENERATES scenarios from the change that was just built. STRICT paper exercise — no live DMs, no calendar writes, no DB writes; file reads, db-query.cjs reads, and log greps are allowed and free. The bar is 100%: a failing scenario means the build is NOT done — stop, report the gap, fix or escalate. Never grade on a curve.
---

# Trace — post-build scenario verification

The owner's bar, verbatim: *"run 10 scenarios, with all the cases you can think... and get 100 score."* This skill is how a build earns its "done." It was distilled from two real runs that worked: the 13-scenario colleague-availability trace (v3.3.7, 125a) and the 10-scenario per-day-travel trace (v3.3.8) — including the part where the trace **found holes mid-run and the holes became part of the build** (the narrow-window focus-floor gap forced the checkSlot rewire; the duration-snap gap added asked-duration extraction). That is the skill working as intended, not a failure of it.

## When it runs

Right after a build, before the "built and typecheck clean" close. Two entry shapes:
- The owner asks for it explicitly (any trigger phrasing above).
- The build instruction bundled it ("do the change and then paper trace..."). Then it's part of the build signal — no separate approval needed for the TRACE; new code changes the trace uncovers still follow the normal propose/approve flow unless they're in-scope gap-fixes of the just-approved change.

## Step 1 — Define the contract under test

One or two sentences: what must now be true, and what must have stayed byte-identical. Write it down before generating scenarios — the matrix is derived from it, not from the diff. Example (v3.3.8 travel): *"An attendee's work-hours clip uses the timezone they'll be in ON THE SEARCHED DAY; everything about non-travelers and the now-semantics consumers is unchanged."*

## Step 2 — Generate the scenario matrix

Walk these dimensions and take every cell that exists for this change. The owner's instinct ("traveling now, traveling next week, me booking, someone else booking") is the model: vary the WORLD STATE and the ACTOR, not just the input.

1. **The original incident, replayed.** Always scenario #1: the exact conversation/flow that triggered the build, traced through the new code. If this doesn't pass, nothing else matters.
2. **Both directions of any symmetry.** Travel now vs travel later; free vs busy; before vs after a boundary. A fix that handles one direction usually has a latent twin (the traveling-now-searching-next-week reverse case was found exactly this way).
3. **Every actor/path that reaches the changed code.** Owner-path vs colleague-path; direct booking vs coord; DM vs MPIM-with-owner; live turn vs background task. Check each caller actually threads the new data through.
4. **Boundaries.** A window that spans the change point (trip ends Wednesday, search Mon–Fri); same-day from/until; TTL expiry; first-ever use (empty state).
5. **No-regression cells.** Cases the change must NOT touch, stated as scenarios and traced to the line that proves they're untouched (e.g. "no slack_id → travel lookup skipped → byte-identical").
6. **Fail-open / fallback paths.** Unresolvable input, missing data, a throw inside the new code — trace that the failure mode is the OLD behavior, never silence or a crash.
7. **Escape hatches and overrides.** relaxed mode, ignore_* flags, owner force — still reachable, still meaning what they meant.
8. **Adjacent consumers of the same data.** Who else reads what you changed (narration, display, social, prompt formatters)? One scenario each proving their semantics survived (e.g. `getCurrentTravel` keeping now-semantics for the travelers list).

Target: **10+ scenarios**; the number falls out of the matrix, never pad and never trim to a round number. Name each scenario with a concrete persona and ask ("Yael, in Boston until Friday, asks for next Tuesday") — concrete inputs expose holes that abstract ones hide.

## Step 3 — Trace each scenario against code ON DISK

- Follow the actual call path: entry point → guards → the changed lines → output. Cite `file:line` for the load-bearing branch in every row. Do NOT trace from memory of what you just wrote — read the file; off-by-one in an edit is exactly what this catches.
- Use real data freely (reads are free): `node scripts/db-query.cjs` for actual rows, the logs for the original incident's parameters — `powershell -File scripts/vm-logs.ps1 [term] [lines]` for anything she did since the 2026-07-31 cutover (she runs on the VM now), the local `logs/` dir for pre-cutover history only, which is all it still holds — yaml for config values. The v3.3.8 trace used Daniel's real travel record.
- STRICT paper: no live DMs, no calendar writes, no DB writes, nothing against the running process.
- Account for LLM-judgment links honestly: when a step depends on Sonnet choosing the right tool, the row can still pass if the wrong option was *physically removed* — say which it is ("the only grounded path left" vs "relies on the model"). Those caveats go in footnotes, not buried.

## Step 4 — Grade like it matters

- **Every row passes → done.** Report the table, then close the build normally.
- **A row fails → the build is not done. Full stop.** Do not present a 9/10 as success. Three legal moves:
  1. The gap is an in-scope flaw of the just-approved change → fix it, re-run the affected rows, note it in the report ("found during trace, fixed: ...").
  2. The gap is real but OUT of the approved scope → stop, report it as a finding, propose, wait for the owner.
  3. The gap is a pre-existing bug the trace happened to expose → report it separately (candidate for the bug list), mark the row "pre-existing, not introduced," and say so plainly.
- An "accepted edge" (documented, owner-acknowledged limitation) may pass WITH a footnote — but only if it's genuinely documented or explicitly accepted in-session, never as a euphemism for "failed."

## Step 5 — Output format

One table, then footnotes:

| # | Scenario (persona + ask + world state) | What the code does (file:line) | ✓/✗ |

- One row per scenario, the load-bearing mechanism named in the middle column.
- Footnotes: honest caveats (LLM-dependency rows, accepted edges, pre-existing issues found).
- Close with the score stated plainly ("13/13") and what, if anything, was changed mid-trace because of it.

## Anti-patterns

- ❌ Tracing the design instead of the code — the file on disk is the only truth.
- ❌ Round-number padding (inventing weak scenarios to reach 10) or trimming (dropping a hard cell to stay at 10).
- ❌ Grading a failed row as "minor" to preserve the score. The score serves the owner, not the report.
- ❌ Silent scope-creep: fixing an out-of-scope gap the trace found without proposing it first.
- ❌ Skipping the no-regression cells because "the change obviously doesn't touch that" — prove it with a line citation.
- ❌ Running anything live. Paper means paper.
