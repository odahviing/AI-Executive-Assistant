---
name: report
description: |
  A thin, cheap front door for reading the standing report and recording an
  immediate owner verdict on a row — never a full Manager session. Triggered
  by "/report", "show me the report", "what's waiting on me", "what needs me"
  or similar. Prints `.claude/agent-loop/report.md` as-is (no recomputation),
  then stays loaded to record a decline / defer the moment the owner gives
  one, using the SESSION_STARTER.md recipes. A "build" verdict either queues
  the row for the next scheduled run (a ledger + state write, still this
  door) or, when he wants it now, is named plainly and handed to the full
  Manager skill — same as a "convert" verdict always is. This door never
  dispatches a lane, touches `src/`, or wraps.
---

# Report — read the desk, record a quick verdict, stop

**This is not the Manager's `report` command re-derived.** Manager's `report`
cross-checks the file against `ledger-stats --open` and rebuilds it if it's
wrong — a full session. This skill is the fast path for the common case: the
file is already current (a run just finished, or nothing changed since he
last looked), he wants to see it and rule on a row or two, and neither of
those needs the Manager loaded.

## 1. Print it

`Read` `.claude/agent-loop/report.md` and show it verbatim. Do not recompute
counts, do not cross-check it against `ledger-stats.cjs`, do not open the
ledger. The file is already kept current in the 4-column shape he asked for
(Manager `SKILL.md`'s report spec) — that is the whole point of this door
being cheap.

## 2. Record whatever he says next

His five verbs, and what this skill does with each:

- **`decline` / `defer`** — record it. Open `.claude/SESSION_STARTER.md`'s
  **"He rules decline/defer on an open report row"** block (X209) and run
  the matching recipe verbatim, his words in `--note`. Reply with one line
  and stop.
- **`build`** — check first, don't just write. Run
  `node scripts/ledger-stats.cjs --open` and find that row's own ref:
  - If it prints with the **`RE-READ`** prefix: **nothing to write.** That
    row has never been through a backlog re-read, so the very next backlog
    run sweeps it in and dispatches it purely because its `recommend` text
    says `build` — the engine's gate (`bugger.js`'s `BUILD_VERB` check) never
    reads the row's `verdict`, only `recommend` (verified 2026-08-21). Tell
    him plainly it's already going to fire and stop.
  - Otherwise (the normal case for anything actually reaching `report.md` —
    the report only carries `still-real` backlog rows, and `still-real` means
    already re-read once), his own words pick one of two paths — **both are a
    genuine "build" ruling; neither is a decline:**
    - **He wants it built now.** Its `recommend` text will **never** be
      re-examined on its own — nothing in the code re-opens a `still-real`
      row. This needs an actual dispatch to the lane, which is real work, not
      a record. Say so and hand it to the full Manager skill — do not invent
      a field to flip here.
    - **He wants it built, just not tonight** — "queue it," "next run,"
      "later," or anything naming a future run rather than asking for one
      now (the path above is still there for "build it now"). This stays a
      record, exactly like decline/defer, never a dispatch: write **both** of
      these, every time — a `queued-next-run` ledger row with no matching
      `pendingOverflow` entry drains nothing on the next run (its own
      documented failure mode, X43):
      1. `node scripts/ledger-file.cjs --ref "<the row's own ref>" --lane
         <the row's own lane> --source owner --finding "Owner ruling
         recorded from the report table, no fresh investigation." --verdict
         queued-next-run --invariant none --recommend "build — <his reason
         for queuing it>"`
      2. `Edit` `.claude/agent-loop/state.json` and append to
         `pendingOverflow`, shaped for `args.issues`: `{id: "<the row's own
         ref>", lane: "<the row's own lane>", severity: "<the row's own
         severity, or "medium" if none was stated>", clarity: "clear",
         source: "owner", symptom: "<the row's own finding, one sentence>",
         evidence: "<the row's own rootCause / file citation>"}`.
- **`resend`** — same boundary as `build`: real dispatch work (the lane
  needs to be sent back with what it got wrong), not a record. Full Manager
  skill.
- **`convert`** — a design question, not a bug. The 6-step GitHub-issue
  process is the Manager skill's; don't attempt any part of it here.

## 3. The row you just ruled on leaves `report.md`'s `pending owner` group — reflect that, don't invent the headline shape

A decline / defer / queue-for-later ruling means that row no longer belongs
in the `pending owner` group (Manager `SKILL.md`'s vocabulary table says
where each verdict's row lands). Remove it there, then rewrite the
headline's leading clause and total from `node scripts/ledger-stats.cjs
--open`'s **RULABLE** figure — never a number you compute by hand. Reuse
the rule already written for exactly this case, don't restate it your own
way: **`WRAP_UP.md`'s bookkeeping step, the report-reset item** — the
leading bolded clause is always
RULABLE, never a delta, and an all-clear phrasing (`0 rows await you`,
`nothing awaiting you`) is correct **only** when RULABLE is genuinely 0.
This is one row and one headline, not the full cross-check against
`ledger-stats.cjs --open` that Manager's own `report` command does — that
stays a full session. Run `node scripts/ledger-stats.cjs --report` before
you reply: it enforces the same all-clear rule and the 5-line narration
budget outside the table, so a wrong shape is caught here, not by him.

## Out of scope, always

This skill never dispatches a lane, never edits anything under `src/`, and
never wraps. Read `report.md`, read `ledger-stats.cjs --open` when a `build`
verdict needs the RE-READ check above, write a `declined`/`deferred`/
`queued-next-run` ledger row (the last paired with a `state.pendingOverflow`
append, never one without the other), and update the one row and headline on
`report.md` that ruling changed (step 3) — nothing else. Anything bigger is
the Manager skill's session.
