# Agent-loop report

**Wrapped: 4.2.1** — the 4.2.0 parked backlog cleared plus GitHub #147/#148, seven lanes, 53 files. Combined adversarial verify returned **safe to ship**. Full history in `ledger.jsonl`; the narrative is in `CHANGELOG.md`.

## Needs you: NOTHING.
## Waiting for your commit: NOTHING — the tree is clean.

---

## ⏸ Parked by the owner 2026-07-26 — he may fix these later today

Five findings from the final combined verify. **None is reachable without a second fault**, which is why they were parked rather than built. Ordered by what I would do first.

| # | Lane | What happens | Severity |
|---|---|---|---|
| **V3** | meeting | **P15 does not cover equal date-only windows.** `handleGetFreeBusy` passes model args straight through, so `start_date === end_date` hits the instant branch, gets midnight-covering blocks, and reads as *"they're free"* with **no `notChecked` flag.** Not a regression — an empty map read as free before tonight too — but it is the most likely malformed input on that tool and the P15 fix leaves it uncovered | **low-med** |
| V1 | people | **`mergePersonRows` `false` now means two things.** `setPersonEmail` reads a *file-side deferral* as an identity refusal, logs *"address held by another identity"* — a false reason — and drops the email. Filesystem fault only; fails in the recoverable direction | low |
| V4 | meeting | Non-outage Graph faults now escape `handleCheckHealth` to the registry as raw text in her context, where they used to be a clean `{error}`. A deliberate consequence of removing P24's causeless local catch. Both callers are crash-guarded — context hygiene, not breakage | low |
| V2 | meeting/requests | An **unlinked** reschedule row no longer suppresses the overlap autofix: if the bridge throws, `request_id` is NULL and the JOIN drops it, so the autofix can re-move and re-DM. Backstopped by the 12h `recentlyAutoMovedIds`, so it needs **two** faults to reach a person | low |
| V5 | meeting | Walker-side `trackReject` calls omit the noise flag, so a walker-rejected out-of-window cursor lands under `owner_busy_collision`. Narration cosmetics | low |

---

## ⚠️ Two things to remember about 4.2.1

1. **The migration is ONE-WAY.** `outreach_jobs.status` drops on the next boot. `ADD COLUMN status` is deliberately absent from the column migrations, so reverting to status-writing code would throw.
2. **Two changes are load-bearing on each other** and must never be reverted independently: promoting the occupancy rule above the work-hours rule (P25), and demoting all-day Working-Elsewhere (P32). Without P32, P25 turns every WE day into a hard *not bookable* on the colleague pre-check. Correct together; neither correct alone.

## Nothing in 4.2.1 is runtime-proven — nothing is deployed
Four events settle most of it after `npm run deploy`:
- an **attendee-side cancel** → `grep 'declineMeeting — /decline rejected'` (the `/decline` verb has never run against a live tenant)
- a **health pass writing a category question** → `grep 'set_event_category — category question closed'`
- a **reply in a routine thread** → expect `historyLength:1`, not `0`
- a **colleague-reply turn** → the stored assistant row should equal the logged `rewritePreview`, not `originalPreview`
- plus one schema check: `node scripts/db-query.cjs --schema outreach_jobs` → no `status` column, and no `initSchema` error in the boot log

## Still open, not in 4.2.1 — see `ledger.jsonl --open`
Owner-declined tonight and not to be re-raised: P2 · P4 · P5 · P6 · P7 · P8 · P9 · P10 · P12 · P14 · P16 · P21 · P23 · P31 · A1 · A7 · CF2 · CF3 · CF5 · #48 · #56 · D7 · D8 · #14 · the private-channel name exposure.
Open owner decisions carried forward: whether Maelle should DM a colleague when a later calendar write **voids** a notice he already received (recommended: yes, but only when the time differs) · whether an autofix may re-propose a move the owner reverted the same day · the seven owner-facing relays posting to a pseudo thread ts.
