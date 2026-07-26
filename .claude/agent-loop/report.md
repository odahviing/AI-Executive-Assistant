# Agent-loop report

**Nothing is waiting for you.** Every item raised today is shipped, declined, or dispatched. The durable record is `ledger.jsonl` — query it with `node scripts/ledger-stats.cjs --open`, which is now the authoritative list.

**Shipped: `4.2.1`** — commits `846f11a` (the 4.2.0 parked backlog + GitHub #147/#148, seven lanes, 53 files) and `fca4b11` (the proposal-path fix, version deliberately held). Both pushed. GitHub #147 and #148 closed. `CHANGELOG.md` carries the narrative.

---

## In flight — three lanes, dispatched on tonight's decisions

| Lane | Items |
|---|---|
| **meeting** | **The autofix-revert suppression** — *"if I change the autofix, don't change it again"* · plumb the executed new start/end into `closeMeetingArtifacts` (data only) · **F2b** re-check against P22 · **V3** equal date-only free/busy windows · **V5** walker-side noise flag |
| **requests** | **Delete the third work-item lifecycle**, keeping the ✅-on-last-message reaction by rehoming the hook |
| **people** | **CF2** — gate the migration backup on at least one mergeable pair |

**Sequenced deliberately:** the revert-relay (option C) is requests' but waits for meeting's plumbing. Building both halves in parallel is what nearly went wrong on the `#41` chain tonight, when two "independent" steps turned out to be order-dependent and only landed safely by luck.

---

## ⚠️ Two things that outlive this session

1. **The `4.2.1` migration is ONE-WAY.** `outreach_jobs.status` drops on boot — already applied, confirmed 27 columns and no `status`. There is deliberately no `ADD COLUMN` path back, so reverting to status-writing code would throw.
2. **Two changes are load-bearing on each other and must never be reverted independently:** the occupancy-above-work-hours promotion (P25) and the all-day-Working-Elsewhere demotion (P32). Without P32, P25 turns every WE day into a hard *not bookable* on the colleague pre-check. Only the combined verify could see it.

## Deployment state
The running build is `846f11a` (boot stamp verified `4.2.1`). **`fca4b11`'s proposal fix is committed but NOT deployed** — until the next `npm run deploy`, a packed day with an unavailable attendee can still offer a time the owner is booked on.

Four events settle what code alone cannot prove, once deployed:
- an **attendee-side cancel** → `grep 'declineMeeting — /decline rejected'` (the `/decline` verb has never run against a live tenant)
- a **health pass writing a category question** → `grep 'set_event_category — category question closed'`
- a **reply in a routine thread** → expect `historyLength:1`, not `0`
- a **colleague-reply turn** with a gate rewrite → the stored assistant row should equal the logged `rewritePreview`

---

## A process lesson from today, worth keeping
Twenty-four owner decisions were recorded **as prose in this file** — *"not to be re-raised: P2 · P4 · P5…"* — while nothing closed them in the ledger. This file is a to-do that gets emptied at wrap; the ledger is what the tooling reads. So `--open` was right to list all 24, and tomorrow's run would have re-raised **every one of them**. A sentence asking to be obeyed cannot be obeyed by something that can't read it.

**The rule:** a decision lands in `ledger.jsonl` as a row, immediately, with `verdict: "declined"` (which closes a row as firmly as `built`). Never as prose here.
