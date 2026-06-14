# Reserve-slot-on-pick — build plan (GitHub #30)

Status: **PLAN, propose-only. Not built.** For owner review.

## The problem

Proposed slots are not reservations — correct. But there's one state where a slot SHOULD be held: a colleague who was offered options **picks one and defers confirmation** — "slot 1 works, let me verify with my team first." During that verification window the slot is neither free nor booked. Today Maelle treats it as free, so a second colleague asking about the same time gets "yes, free" — and two people can make promises on a slot seconds from being taken.

Target behaviour (from the ticket, verbatim intent): while Yael is verifying slot 1, Michal asking about that time hears *"that time's tentatively held — Yael's checking it for another meeting. Want me to wait for her, or look at other options?"* — not "yes, free."

## What changed since the ticket was filed (matters for this build)

The ticket is written in **coord** terms (`coord_jobs.tentative_slot`, a reply-classifier intent). Two things moved:
1. **Coord is demoted** (v3.3.8) — colleagues book via the **direct path** (search → offer in-chat → `create_meeting`), not the coord state machine. So the hold lives on the direct path, not on `coord_jobs`.
2. **Offered slots are now state** (v3.3.8 `utils/offeredSlotsStash.ts`) — when `find_available_slots` returns slots to a colleague, the offered instants are stashed per conversation (in-memory, 2h TTL). This is the primitive that lets a "pick" bind to a real offered instant. The hold builds directly on it.

## Storage decision: MEMORY (the requests spine), never the calendar

A hold is a **requests-spine row**, not an Outlook event.
- `kind = 'follow_up'`, `subkind = 'slot_hold'`.
- `details_json`: `{ start_iso, end_iso, holder_slack_id, holder_name, subject, origin_channel, origin_thread_ts }`.
- `state = 'in_flight'`; `expires_at` + `next_check_handler = 'expiry'` (the existing sweep closes it — no new timer).
- `closeRequest` is the single terminal path (release).

Why not a calendar placeholder: it would show phantom busy to the whole org, leak the negotiation ("who's HOLD-Yael?"), and need Graph cleanup on every release. The hold is internal state, visible only through Maelle's own answers. (Matches the ticket's "Not doing: no calendar-event-like placeholder.")

Durability note: the hold must survive a restart (windows run up to days), so it is spine (durable). The **validation** that a pick matches an offered slot uses the in-memory `offeredSlotsStash` (fine — that only needs to live for the pick turn).

## Trigger — exactly three moments, nothing else

1. **Pick-pending-verification (the core case).** A colleague who was offered slots picks one AND defers — "slot 1 works but let me check with my team", "20:30 טוב, רק אבדוק עם דנה". Sonnet is already in that live turn; it calls the new `hold_slot` tool. NOT on a clean "yes" (that books — no hold state). NOT at offer time (offers stay open — ticket rule).
2. **Owner explicit.** "Hold Tuesday 14:00 for Yael until Thursday."
3. **Never automatically by code.** The trigger is always a deliberate tool call in a live turn — no classifier to mistrain, no inferred holds.

## Who can create / release

| Actor | Create | Hard constraint | Release |
|---|---|---|---|
| Colleague (their turn) | their own pending pick only | the held instant **must match an entry in that conversation's `offeredSlotsStash`** — a colleague (or an injection) can never freeze arbitrary calendar time, only a slot Maelle actually offered them | their own hold: confirm → books + releases; decline / re-pick → releases |
| Owner | any slot, any time | none | any hold, always; **booking over a held slot auto-releases it + DMs the holder** ("Idan took that time — want alternatives?") |
| Expiry sweep | — | — | auto-release + one DM to the holder ("still checking, or shall I free it up?") |

Owner override stays total — he can book straight through a hold; the holder is notified, never silently lost.

## Time to keep

- **Default: 1 owner-workday** (recommendation; ticket said 2). Verification is usually same-day; a shorter default frees slots faster. **Owner decision needed** (1 vs 2).
- **Stated deadline wins**, capped at **3 owner-workdays** (the hard ceiling — nobody parks a slot a week). Uses the existing `workHours.addWorkdays` helper.
- **Natural expiry:** the hold dies when the held instant passes, whichever comes first.

## Limitations

- **One active hold per holder** — a new pick replaces their previous hold (the scenario is "picked ONE slot pending verification").
- **Held block = the offered slot's duration only** — no holding whole afternoons.
- **Cap ~5 active holds per owner** — sanity bound; oldest-expires-first if hit.
- **Honest-tentative, not a hard lock.** The reads (below) annotate the hold and let Sonnet narrate it; they do NOT hard-remove the slot. A second colleague who *insists* on the held time → `create_approval(policy_exception)` to the owner. **The owner arbitrates races; code never silently picks a winner.**

## Code touchpoints

1. **New tool `hold_slot`** (colleague-allowed, tightly scoped): actions `hold` / `release`; args `start_iso`, `duration_min`, `reason`, `holder` (defaults to the turn's sender on colleague path). Colleague-path `hold` validates against `offeredSlotsStash`; owner-path `hold` is unconstrained. Writes/closes the spine row. (No existing action-enum fits; "a tool that owns the decision" is the right shape — no reply-classifier change.)
2. **New `db` helpers** (thin, over the spine): `createSlotHold`, `getActiveSlotHolds(ownerId)`, `releaseSlotHold(id, reason)`. `getActiveSlotHolds` is the read consulted below.
3. **Reads consult holds + annotate** (one lookup each, no hard filter):
   - `find_available_slots` (`skills/meetings/ops.ts`) — tag any returned slot overlapping an active hold with `on_hold_for: <name> (verifying)`.
   - `check_join_availability` (`skills/meetings.ts`) — same tag on the join verdict.
   - `availabilityPreCheck` (`utils/availabilityPreCheck.ts`) — verdict gains an `on_hold` state alongside bookable / not-clean / not-bookable, with the "insist → approval" narration hint (mirrors the v3.3.7 soft-block hint).
4. **Release hooks:**
   - On `create_meeting` success in a conversation → release any hold for that holder/slot (same clear-hook site as the `offeredSlotsStash` clear, `ops.ts`).
   - Owner books over a held slot → release + DM holder.
   - Expiry → `sweepDueRequests` `expiry` handler already fires; add the holder-DM on slot_hold closure.

Estimated size: ~150–180 lines. One new tool, spine rows (no schema change), 3 read-site annotations, the release hooks.

## Open decisions for the owner

1. **Default TTL:** 1 owner-workday (my lean) or the ticket's 2?
2. **Brief visibility:** should active holds show in the morning brief? I lean **no** (`informed=1`, visible on demand) — they're transient negotiation state, not action items.
3. **Owner-side visibility:** when the OWNER searches his own calendar, should a held slot be annotated for him too? I lean **yes** (same `on_hold_for` tag) so he sees what's tentatively spoken for.

## Explicitly NOT in scope

- No calendar placeholder event for the held slot (internal state only).
- No auto-bumping a lower-priority hold for a higher-priority request.
- No reservation at initial offer — slots stay open until a participant explicitly picks-and-defers.
- No hold without a live tool call (no inferred/automatic holds).

## Trace plan (run `/trace` after build)

Yael picks-and-defers → hold created (validated against her offered stash) · Michal asks the held time → "tentatively held, wait or alternatives?" · Michal insists → `create_approval` to owner · Yael confirms → books + hold released · Yael re-picks → old hold replaced · silence → expiry releases + DMs Yael · owner books over the hold → released + Yael DM'd · owner searches own calendar → sees the hold tag · hold survives a restart (spine durable) · a colleague tries to hold a slot never offered to them → refused (stash mismatch) · cap of 5 holds hit.

## Related

- Builds on `offeredSlotsStash` (v3.3.8) and the requests spine + `sweepDueRequests` expiry.
- #31 (auto travel-buffer blocks) is the same mental space ("things the calendar should reserve") but a separate concern.
