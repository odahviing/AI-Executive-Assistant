# Reserve-slot-on-pick ("slot blockers") — build plan (GitHub #30)

Status: **PLAN, propose-only. Not built.** Owner reviewed once (2026-06-15) and locked the open decisions; this revision bakes them in + a deep-analysis pass that surfaced new edge cases. Still NOT cleared to build — owner wants the plan fully baked first.

## The problem

Proposed slots are not reservations — correct. But there's one state where a slot SHOULD be held: someone who was offered options **picks one and defers confirmation** — "slot 1 works, let me verify with my team first." During that verification window the slot is neither free nor booked. Today Maelle treats it as free, so a second person asking about that time gets "yes, free" — and two people can make promises on a slot seconds from being taken. Worse (owner's case): **the owner himself** can book over a slot a colleague is verifying, with no idea it was spoken for.

Target: while Yael verifies 12:00, Michal asking that time hears *"that's tentatively held, want me to wait or look at other options?"*; and the **owner** asking to book 12:00 hears *"Yael asked to reserve that — book anyway?"* — not silent in either direction.

## Decisions locked by the owner (2026-06-15)

| # | Decision | Effect on plan |
|---|---|---|
| 1 | Holds live in **memory, not Outlook** | Confirmed — no calendar placeholder. |
| 2 | **Owner path must see holds too** — owner asks to book 12:00 that Yael holds → "Yael asked to reserve it" | NEW: owner booking over a hold is a **confirm-gate**, not silent auto-release. |
| 3 | Holder can cancel own; **owner can cancel anyone's**; **auto-cancel after 2 working days OR when the slot time passes** | TTL decided = **min(2 owner-workdays, slot-start)**. (Kills the 1-vs-2 open question — it's 2.) |
| 4 | **Morning brief shows active holds** (to police overuse) | NEW brief section. (Reverses my earlier "no".) |
| 5 | **Up to 3 holds per person** now; future **VIP→3, non-VIP→1** (VIP flag already exists) | Per-holder cap = 3 (flat), designed to read `is_vip` later. |
| 6 | All in the spine — but unsure it fits the slot picker; "new table or memory… slot picker → graph + slotblock… simple is best" | Storage **recommendation below**: a dedicated `slot_holds` table (matches his "new table + read graph+slotblock" instinct). Owner to confirm. |
| 7 | Owner sees holds **annotated in the brief** ("blocked by Yael") | Brief annotates holder by name. |
| 8 | **Only hold when the person explicitly picks-and-defers** ("ok 12pm looks good, let me check with X") — never "just in case", never at offer time | Confirms trigger; tightened in the tool description. |

## Storage — RECOMMENDATION: a dedicated `slot_holds` table (not the requests spine)

Owner was torn ("I like requests, but does it fit the slot picker… prob simple is best"). On analysis, **a dedicated table is the honest, simpler fit** — and it matches his own instinct ("new table → slot picker reads graph + slotblock").

Why NOT the requests spine: the spine models *work awaiting someone's action* (coord/outreach/approval — something is blocked, needs nudging, notifying, closing, reconciling, parent/child trees, a `requester_notified_at` stamp). **A hold blocks nobody** — it's a passive reservation. Putting it in `requests` makes a degenerate row that the spine's reconcile / retention / notification machinery has to learn to ignore. That's the kind of overload that breeds drift bugs later.

The dedicated table:
```
slot_holds(
  id TEXT PK, owner_id TEXT, holder_slack_id TEXT, holder_name TEXT,
  subject TEXT, start_iso TEXT, end_iso TEXT,
  origin_channel TEXT, origin_thread_ts TEXT, reason TEXT,
  created_at TEXT, expires_at TEXT,
  state TEXT,           -- 'active' | 'released' | 'expired'
  closure_reason TEXT, closed_at TEXT
)
```
- **Durable** (survives restart — windows run up to 2 days). ✓
- **Expiry rides the existing 5-min tick**: a ~10-line `sweepExpiredSlotHolds()` called next to `sweepDueRequests` in `tasks/runner.ts:39` — no new scheduler.
- **Read path is exactly the owner's mental model**: slot picker → Graph free/busy **+** `getActiveSlotHolds(ownerId)` → annotate. No JOINs through the spine.
- Memory (md / people_memory) is the wrong home — a hold is transient structured state with an expiry, not a durable fact.

(If the owner still prefers the spine: `kind='follow_up', subkind='slot_hold'`, `next_check_handler='slot_hold_expiry'`. Workable, just heavier. Recommendation stands on the table.)

## Trigger — exactly three moments, nothing else

1. **Pick-pending-verification (the core case).** Someone offered slots picks ONE specific instant AND defers — "slot 1 works, let me check with my team", "20:30 טוב, רק אבדוק עם דנה". Sonnet, already in that live turn, calls the new `hold_slot` tool. NOT on a clean "yes" (that books — no hold). NOT at offer time (offers stay open). **Requires a specific picked instant** — a vague "these all look ok, let me check" holds nothing (offers stay open; if it matters, Maelle asks which one).
2. **Owner explicit.** "Hold Tuesday 14:00 for Yael until Thursday."
3. **Never automatically by code.** Always a deliberate tool call in a live turn — no classifier to mistrain, no inferred holds.

## Who can create / release

| Actor | Create | Constraint | Release |
|---|---|---|---|
| Colleague (own turn) | their own pending pick | the held instant **must match an entry in that conversation's `offeredSlotsStash`** — never arbitrary calendar time, only a slot Maelle actually offered them; **per-holder cap = 3** (future: VIP→3, non-VIP→1) | confirm → books + releases; decline / re-pick → releases that one |
| Owner | any slot, any holder, any time | none | **any** hold (his own, or cancel anyone's by name/slot); booking over someone's hold = **confirm-gate** (below), then release + DM holder |
| Expiry sweep | — | — | auto-release at min(2 workdays, slot-start) + one DM to holder ("freed up 12:00 — say the word if you still want it") |

**Owner override stays total but now visible.** Booking over a held slot no longer silently auto-releases — Maelle surfaces it ("Yael asked to reserve 12:00 for X — book anyway?"); on the owner's go-ahead it books, releases, and DMs Yael. The holder is never silently lost.

## Time to keep
- **TTL = min(2 owner-workdays from creation, the slot's own start time).** Whichever comes first. Uses `workHours.addWorkdays`.
- Owner may state a shorter deadline ("hold it till tomorrow"); **2 workdays is the hard ceiling** — no parking a slot longer.
- At expiry: release + one DM to the holder, threaded into the origin conversation.

## Per-holder cap & VIP
- **3 active holds per holder now** (flat). 4th pick → refuse: "you've already got 3 times on hold with Idan — want me to drop one?"
- **Re-pick replaces, different-meeting adds.** Key a hold by `(holder, origin_thread_ts)` — a re-pick in the SAME negotiation replaces that thread's hold; a pick in a different conversation/meeting is a new hold (up to 3).
- **Future VIP gate:** read `people_memory.is_vip` → cap 3 for VIP, 1 for others. The field exists; ship flat-3 now, wire the gate when the owner says go.

## Reads — consult holds + annotate (one lookup each, never a hard filter)

1. **`find_available_slots`** (`skills/meetings/ops.ts`) — a returned slot overlapping another person's active hold is **tagged** `on_hold_for: <name> (verifying)` AND **ranked below clean-free slots** (surfaced only if useful, never the first offer). The **holder's own** hold reads differently — "yes, still holding 12:00 for you."
2. **`check_join_availability`** (`skills/meetings.ts`) — same tag on the join verdict.
3. **`availabilityPreCheck`** (`utils/availabilityPreCheck.ts`) — verdict gains an `on_hold` state with the "insist → approval" narration hint (mirrors the v3.3.7 soft-block hint).
4. **Owner-path booking** — when the owner's `create_meeting` (or the search feeding it) targets a slot held by someone else, return a **soft `needs_confirm: 'slot_on_hold'`** (`{ holder_name, reason, hold_id }`) so Sonnet asks before booking; the owner re-calls with `override_hold: true` to proceed (→ book + release + DM holder). This is the owner's #2.
5. **Privacy:** the **owner** sees full attribution (who holds it, why). A **third colleague** hears only "that's tentatively held — wait or alternatives?" — **not** the other colleague's name or reason. Don't leak one colleague's negotiation to another.

## Brief integration (owner #4 / #7)
- `collectBriefingData` (`tasks/briefs.ts:371`) fetches `getActiveSlotHolds(ownerId)`.
- Brief renders a **"Slot holds"** section: holder, slot, reason, age, expiry — annotated "blocked by Yael". Purpose is overuse oversight, so it lists ALL active holds (no truncation-to-N that hides hoarding).
- This is the owner's overuse police — see "Global cap" below.

## Code touchpoints
1. **New tool `hold_slot`** (colleague-allowed, tightly scoped, add to `COLLEAGUE_ALLOWED_TOOLS`): actions `hold` / `release`; args `start_iso`, `duration_min`, `reason`, `holder` (defaults to the turn's sender on colleague path). Colleague-path `hold` validates against `offeredSlotsStash` + enforces the 3-cap; owner-path `hold`/`release` unconstrained (any holder). Owner `release` can target by holder/slot.
2. **New `db/slotHolds.ts`** (dedicated table): `createSlotHold`, `getActiveSlotHolds(ownerId)`, `getHoldForSlot(ownerId, startIso)`, `releaseSlotHold(id, reason)`, `countActiveHoldsForHolder`. Migration adds the table in `db/client.ts` (idempotent `CREATE TABLE IF NOT EXISTS`, the established pattern).
3. **Expiry**: `sweepExpiredSlotHolds()` called next to `sweepDueRequests` in `tasks/runner.ts` — release any past `min(2wd, slot-start)` + DM holder (threaded).
4. **Release hooks:** `create_meeting` success → release the holder's matching hold (same clear site as the `offeredSlotsStash` clear); owner books over a hold → release + DM; expiry → release + DM.
5. **Reads** annotated as above (4 sites: 3 availability reads + the owner-book confirm-gate).
6. **Brief**: collector + one prompt section.

Estimated size: ~200–230 lines (one tool, one tiny table + helpers, one sweep call, 4 read annotations, brief section). Up from the earlier ~150 because of the owner-confirm-gate, the brief, and the 3-cap/keying.

---

## Deep analysis — edge cases surfaced this pass (these are the "what's missing")

1. **Owner booking over a hold: confirm, not silent.** (Owner #2.) The earlier plan auto-released silently. Now a confirm-gate with an `override_hold` flag. *Open sub-question:* should the gate also fire when the owner books a slot held BY HIMSELF? No — own holds just release silently on his own book.
2. **A colleague picks a slot ALREADY held by another colleague** (the race). Don't create a second hold on it. Treat exactly like "Michal insists" → "that time's tentatively held, wait or alternatives?" → on insist, `create_approval(policy_exception)` to the owner. The owner arbitrates; code never silently picks a winner.
3. **The holder re-queries their own hold.** "Is 12:00 still open?" → "yes, I'm holding it for you until Thursday." Distinct narration from the third-party "tentatively held" line. (Needs the read to compare `holder_slack_id` to the asker.)
4. **Privacy leak between colleagues.** A third colleague must NOT learn who holds a slot or why (only the owner gets attribution). Added to the reads.
5. **Replace-vs-add keying with the 3-cap.** A re-pick in the same thread replaces; a different meeting adds; keyed by `(holder, origin_thread_ts)`. Without this, a colleague changing their mind would burn 2 of their 3 slots.
6. **Held slots must rank BELOW free ones** when offered to a third party — annotate, deprioritize, never hard-remove. Otherwise Maelle leads with a contested time.
7. **Vague defer ≠ hold.** "These all look fine, let me check" picks no instant → no hold (offers stay open). Only a specific picked instant holds.
8. **`offeredSlotsStash` (2h, in-memory) vs the hold (2-workday, durable).** The stash is used ONLY to validate the pick at creation; once the hold row exists it's independent of the stash (survives the 2h TTL and restart). No coupling after creation.
9. **Coord path.** Coord is owner-path/explicit now (demoted v3.3.8), but if a coord runs it should also respect/release holds for completeness. Low priority — note, don't block on it.
10. **Externals.** Direct-path holders are internal (have slack_id). Owner-created holds for an external (email-only) person are possible but rare; `holder_slack_id` nullable, fall back to `holder_name`. Not a v1 focus.
11. **Expiry DM tone.** Owner #3 says "always cancel" at 2 workdays — so expiry RELEASES (not just nudges) and notifies. (Earlier plan's "still checking?" nudge would contradict "always cancel" — dropped, unless the owner wants a pre-expiry nudge as well.)

## Open questions remaining (need the owner's call)

1. **Storage: confirm the dedicated `slot_holds` table** over the requests spine? (My recommendation; matches your "new table + read graph+slotblock" instinct.)
2. **Global cap / overuse.** You want the brief to police overuse — so do we ALSO want a hard global ceiling (e.g. N total active holds across everyone), or **rely on the brief for oversight + the per-holder 3-cap, with no global hard limit**? I lean: per-holder 3 hard, **no global hard cap, brief is the police**. Confirm.
3. **Owner override mechanic.** OK to add a small `override_hold: true` flag on `create_meeting` for the confirm-gate retry, or would you rather it route through `create_approval`? (Flag is lighter; approval is heavier but uniform.)
4. **Pre-expiry nudge?** Just release+notify at 2 workdays (simplest, matches "always cancel"), or also a heads-up DM to the holder a few hours before? I lean release-only.

## Explicitly NOT in scope
- No calendar placeholder event (internal state only).
- No auto-bumping a lower-priority hold for a higher-priority request (owner arbitrates races).
- No reservation at initial offer — slots stay open until an explicit pick-and-defer.
- No hold without a live tool call (no inferred/automatic holds).
- VIP-differentiated caps are DESIGNED-FOR but not switched on in v1 (flat 3); flip when the owner says.

## Trace plan (run `/trace` after build)
Yael picks-and-defers → hold created (validated vs her offered stash) · Michal asks the held time → "tentatively held, wait or alternatives?" (no name leak) · Michal insists → `create_approval` to owner · a second colleague PICKS the same held slot → race handled (no double hold) · Yael re-queries → "still holding it for you" · Yael confirms → books + releases · Yael re-picks same thread → old hold replaced (still 1 of 3) · Yael picks a 4th distinct slot → refused (3-cap) · silence → expiry at min(2wd, slot-time) releases + DMs Yael · **owner asks to book the held 12:00 → "Yael asked to reserve it — book anyway?" → override → book + release + DM Yael** · owner searches own calendar → sees the hold tag · **morning brief lists active holds annotated by holder** · hold survives a restart (table durable) · colleague tries to hold a slot never offered → refused (stash mismatch).

## Related
- Builds on `offeredSlotsStash` (v3.3.8) + the existing 5-min tick for expiry.
- `is_vip` (v3.2.6) is the future VIP-cap field — already live in the thread-action roster.
- #31 (auto travel-buffer blocks) is adjacent ("things the calendar should reserve") but a separate concern.
