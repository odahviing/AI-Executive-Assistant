# Agent-loop report

**Empty — v4.5.7 wrapped. 0 rows await you.** Standing backlog: **25 open rows** across 25 bugs · 1 still-real · 12 need a re-read · 12 cite no file · **25 rulable · 3 queued for the next build, drain themselves** (`node scripts/ledger-stats.cjs --open`).

out: 2 built · 0 already-fixed · 0 built-with-gap · 1 bounced · 0/0 joint-traced (hand-dispatched run, no manifest) · 0 converted · 0 queued

**Built and uncommitted — this is what a wrap ships (2):** `oof-multiday-flagged-per-day-not-once` colleague-facing away-span wording, fixed at the actual incident path after two overturns · `schedule-override-missing-from-claimchecker-tables` tool-summary + mutation-domain fix for set_work_schedule_override

This wrap is entirely one GitHub issue, gh#200, run via the `github` skill's propose-first triage rather than a full nightly loop (owner scoped it explicitly: "run only on github items"). Two atomic bugs found and fixed. `oof-multiday-flagged-per-day-not-once` took three passes: the first fixed an owner-only code path the real (colleague-facing) incident never runs through; the second built half the real fix and left the search path unwired; the third closed both halves, traced end to end against the actual reported symptom. `schedule-override-missing-from-claimchecker-tables` was found and confirmed clean in one pass, from a live reproduction the owner triggered himself while testing whether the schedule-override tool would solve 200a (it didn't — the two mechanisms are independent — but the test surfaced this second, real bug in the tool's own safety-net plumbing). 5 discoveries logged, all low-priority follow-ups, none blocking.
