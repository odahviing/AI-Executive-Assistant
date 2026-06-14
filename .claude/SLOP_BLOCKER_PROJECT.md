# Slop Blocker — project plan

**Status:** proposed (analysis done, code-traced + log-proven, NOT built).
**Born from:** the Boston-trip rescheduling chat (2026-06-14, `logs/maelle-2026-06-14.log` lines 586–941). One painful thread that *looked* like five separate failures and one lie — but on trace it is **one root cause** (a tool-selection failure) plus **one unrelated date bug**. She did NOT lie; see "What this is NOT" below.

---

## The single root — create-vs-move tool selection

The owner said "move my Israeli weekly" 1:1s (Michal weekly, Simon/Dina bi-weekly) around a Boston trip. Maelle called `create_meeting` three times → three one-time "X & Idan - Weekly" duplicates next to the still-live recurring originals. She should have called `move_meeting` on each occurrence (which, by design, creates a single-occurrence exception and preserves attendees/duration/history).

**Why she picked create — proven, not guessed:**
- Turn 1 she ran `get_calendar` ×2 and `find_available_slots` with `category:Weekly, duration:40` (log 595/606/607/614) — she **knew** they were 40-min recurring weeklies and narrated their normal dates. She had the occurrences in view.
- But the **tool descriptions route her to create**:
  - `create_meeting` (meetings.ts:418): *"THE booking tool. The agreed time comes from find_available_slots."* → it is the described endpoint of the slot-search pipeline she was on.
  - `move_meeting` (meetings.ts:487): *"ALWAYS prefer this over **delete + recreate**."* → positioned against delete+recreate, NOT against create; nothing says "use this to reschedule an existing series." Plus it costs a `meeting_id` lookup.
- The one prose rule meant to catch this (meetings.ts:2283, "REPAIR WITH MOVE, NOT CREATE") is scoped to a *"misplaced"* meeting; a deliberate trip-reschedule didn't read as "misplaced," so it didn't bind. **A prompt rule was present and ignored** — the standing lesson.

There is **no code chokepoint** that turns "about to create a one-time event matching an existing recurring series" into a forced move. `planMeeting` even *noticed* it (log 649: *"Subject matches Weekly 1:1 pattern but the event is NOT recurring"*) and proceeded.

### Downstream symptoms (all dissolve when the root is fixed)
- **Wrong duration (Simon 25 min).** A fresh `create` lost the 40 (owner's `default_meeting_duration: 25` won). A `move` inherits the series' real 40 — the recovery in this very thread proved it (move landed 10:00–10:40).
- **Asked "how long is your 1:1 with Simon?"** instead of reading the calendar. She'd have nothing to ask if she were holding/moving the real occurrence.

---

## The fix — DECIDED: fix the tool-description contracts, not a code guard

Owner call (2026-06-15): *"can we just use the text and fix the tool description — it's move_meeting as I'm asking to move."* The signal was explicit ("move my Israeli weekly"); the descriptions were actively pointing the wrong way (create = "THE booking tool"; move = only "prefer over delete + recreate"). Fixing the contracts is lighter and lower-risk than a horizon-widened code guard, which would risk **blocking legitimate new bookings** in the hot path. Both tool descriptions live in `meetings.ts` (in-repo), so these are code edits, not prompt-chat work.

### Fix A — tool-description reframe (DONE, uncommitted)
- **create_meeting** (meetings.ts:~420) — "RESCHEDULING ≠ CREATING" cue: if the person's recurring series already exists, you're rescheduling → move_meeting, not create. *(Landed by the parallel prompt chat.)*
- **move_meeting** (meetings.ts:~489) — reframed as THE tool whenever the owner says move/reschedule/shift; explicitly preferred over create_meeting (not just delete+recreate); explicitly covers relocating a recurring 1:1 to another day/week (single-occurrence exception); + a **DURATION** cue (new_end = new_start + existing length) — this also closes the 25-min symptom.

### Fix B — code guard (DEFERRED fallback)
The owner-path create→move chokepoint (lift + re-key the colleague guard at `ops.ts:2196–2251`, gated at `ops.ts:2127`) is the durable backstop **if the description reframe doesn't hold under load** (a description is still model-judgment, same failure mode as the old meetings.ts:2283 rule). Not built. If we ever build it: trigger on shared attendee + near-identical subject within a ~6-week horizon (NOT recurring-category-only, which false-fires on legit second 1:1s), plus a `force_new` escape hatch.

### Fix C (prompt chat) — trip-relative date confirmation
Separate wrong-week bug (below). Resolve a trip/event-relative date to a concrete date and confirm before booking ("Sunday July 5, week after Boston?"). The code-side trip-window anchor is harder and deferred. Block drafted; handed to prompt chat.

---

## The separate bug — wrong week (June 21 vs July 5)

Unrelated to create-vs-move. "The Sunday after the trip" resolved to **June 21** because relative dates anchor to TODAY (`systemPrompt.ts:660`); today (Jun 14) was itself a Sunday → "Next Sunday" = Jun 21. No trip-window awareness (`getCurrentTravel` is null for future trips, `people.ts:189`); `dateVerifier` only checks weekday↔date-number (Jun 21 *is* a Sunday → passes). Flagged "irreducible" in memory. **Realistic fix = the prompt confirmation rule (Fix C.2).** A code anchor to the WE/travel window is possible but harder; deferred.

---

## What this is NOT (correction to the first draft of this doc)

The first draft framed a "Pillar 2 — she lied / the honesty layer was silenced." **That was wrong.** On trace, every "done/moved" claim was a *truthful report*:
- "All done… Enjoy Boston" — she really had created 3 meetings (wrong action, honestly reported).
- "All three moved / invites updated" (log 868) — 3 `move_meeting OK` really ran; the claim-checker flag was a **false positive**, correctly suppressed by the shield.
- "Both moved to July 5" (log 940) — 2 `move_meeting OK` to July 5 really ran; another **false-positive** flag, correctly suppressed.

**The claim-checker + shield performed correctly.** No honesty work is needed. The owner's "you lied / nothing moved" was his reaction to seeing duplicates beside untouched originals — i.e. the **wrong action**, not dishonesty.

*(Aside, no action: Haiku threw 3 false positives here with wrong mental models — "move can't change date," "move doesn't update invites." The shield caught them all, so nothing shipped. Note only.)*

---

## Build order
1. **Fix A** — owner-path create→move chokepoint (the root). Biggest surface; lift + re-key the colleague guard.
2. **Fix B** — move_meeting inherits duration when `new_end` omitted.
3. **Fix C** — to the prompt chat (description cue + trip-relative date confirmation).

Propose-first, per standing mode. No new prompt rules to *enforce* create-vs-move (that's Fix A, code). No regex on user words. Reuse `planMeeting`'s category verdict + the existing colleague guard.
