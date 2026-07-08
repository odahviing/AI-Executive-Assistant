# Meeting Planner — dedicated subsystem agent

**This chat owns ONE thing: the meeting planner. Nothing else.** Read this whole file before touching code. Current shipped state + the live open items are in **`.claude/MEETING_CHAT_HANDOFF.md`** — read that too on a cold-start; this file is the timeless constitution, that one is the current state.

## Why this chat exists (the mandate)

The meeting planner was bug-fixed for months and never stabilized: every wave fixed a symptom, a new one appeared, and dead/duplicate code accreted. The bar for how bad it got — in one afternoon the owner *and* a colleague (Isaac) both suffered through it; Isaac wanted to quit.

So this chat does NOT do more patches. Its job, in order:

1. **Understand the subsystem by heart** — every entry point, every validator, every place a time/date/location/free-busy decision is made. Build the mental model first; don't fix blind.
2. **One root-cause per bug, proven** — trace log + code to the exact `file:line — what happens`. No guessing. Most recurring bugs are a prior symptom-fix that didn't stick; find why it didn't stick and remove the rotting layer, don't stack a new one.
3. **Converge on ONE decision spine, not many patches.** The recurring failures trace to a handful of roots — free/busy truth, one-validator consistency, timezone/Working-Elsewhere. Fix them at the chokepoint and a dozen "bugs" disappear at once. Stability through fewer, deeper invariants: **one source of truth per decision.**

**Operating mode:** an ad-hoc problem-solver. Most work arrives as a specific bug routed from the bug chat. For each — run the discipline below, root-cause against the code on disk, fix at the chokepoint per the owner rules, `trace` to 100%, stop.

**Standing:** propose-first, NEVER auto-fix — build only on a per-bug "build it" / "fix it" ("do it"/"go"/"ok" = make the edit, leave it UNCOMMITTED). Never commit / bump / wrap without an explicit ship word. Code-first; prompt is a last resort for judgment/tone/format only. Reads (logs, `node scripts/db-query.cjs`, grep, code) are free; writes need a build signal.

## Owner rules — load-bearing; every diagnosis and every fix is checked against them

These are the owner's standing principles for this subsystem. Keep them **few-and-strong** — each rule a distinct tooth; when two overlap, merge them (Rule 2 applies to the rules themselves). Append new ones in the owner's words. General dev-discipline rules (e.g. *leave no dead code / reduce LOC*) live in the shared working-rules memory, not here — this list is meeting-domain principles only.

1. **Never make the owner repeat himself.** Maelle may flag a concern *exactly once* — "are you sure? / that's a duplicate / Isaac can make it" — but the moment the owner answers, that answer is final. No second verification, no re-confirming the same thing in different words. Once he says yes, it's yes; book it.

2. **No dedup code. Ever.** If two tools share a repeated need, do not write a dedup/near-duplicate path — extract ONE function and call it from both. Any time you see dedup logic, assume it's wrong and a symptom of a missing shared function. Two tools that differ by a single parameter are a mistake — collapse them. We want one strong process, not parallel copies that drift.

3. **We are not replacing the LLM.** No natural-language regex, no inline keyword/text matching to make decisions. The LLM reasons. Our job is to guide it through the right *process* and hand it tools so it can choose the right next action. (Maelle is multi-lingual — pattern-matching on NL text is doubly wrong.)

4. **Every "bug" is a deep design knot — no patch-on-patch, no quick wins.** This subsystem carries 100 versions of bugs; what looks new is almost always an old patch tangled with ten earlier ones. Trace the whole process to ONE proven root-cause *before* touching it, and remove the rotting layer — never stack a new one. When an instability keeps *returning*, converge on ONE resolver/spine; each symptom-patch you add is another voice in a disagreement with no judge (the label→loop→bare-time patches each made the WE day worse until one `weTimeResolver` replaced them). And do the *correct* fix, not a quick win: no partial fix, no hook that papers over a symptom; if the right fix is a big architectural change, do the big change; if it doesn't fit the architecture, redesign until it sits where it belongs — size is never the reason to avoid the correct fix. A fix that creates a new bug is a failure.

5. **Fix the process, not the guard.** A guard exists to protect when something already went wrong — it is never where correct behavior is built. If the process is broken, fix the process. Do not reach for the guard stack to paper over a broken flow.

6. **Availability & validation inform, never refuse — owner override is total.** Knowing when a colleague is free lets us suggest slots good for everyone, but the *owner decides*: suggest options that work for both, annotate when the other person isn't free, then let him choose (same when a colleague proposes to the owner — tell him when he's free, annotate where he isn't). He can book a colleague onto their 5th meeting or at night if he chooses. Override reaches every surface, **including search**: if the owner names a specific time, `find_available_slots` must still return it (annotated with why) even when validation would reject it — never withhold it. He overrides every check in one step. Availability and validation inform; they never refuse him.

7. **Never a mechanical refusal — always the real reason.** If Maelle says no — to the owner or about someone else — she says *why* in human terms, never a system phrase ("tool not allowed," "not permitted") or a bare "I can't"; a leaked tool/mechanism name in a refusal is a bug, not an answer. The owner hears the actual reason ("that's his busy/free check," "it'd break your focus floor," "the room's taken") — never "I can't" without the why, so he can override in one step. Internal colleagues may know *why* the owner isn't free at a high level — enough to understand the situation and raise things for approval, but not the fine detail; the owner sees everything.

8. **Few messages — close the loop fast.** Ask for everything needed in a single prompt so the loop can close in one round. Three or four rounds of ping-pong is bad service.

9. **Maelle remembers — reference-back just works.** She holds the meetings she booked with a person and the meetings booked in a thread, so the owner can say "change the meeting you just booked to 3pm" or "same time as last time" and she resolves it without re-asking. Booking history is context she carries — per-person (the attendee's memory) and per-thread (the event ledger). Editing a known meeting is edit-by-id, never re-search-by-name; "like last time" pulls the prior slot. If she can't resolve a back-reference, that's a memory gap to fix at the source, not a question to bounce back to the owner.

10. **Build an efficient calendar — connect, don't scatter.** The job isn't just to fit a meeting, it's to shape a day worth having. Don't leave dead gaps for no reason, and don't drop a meeting 15 minutes away from another — short islands between meetings are unfocusable. Prefer connecting meetings back-to-back (the allowed durations already bake in the trailing buffer) over scattering them with stub gaps. When placing or moving, favor the slot that consolidates the day and protects real contiguous focus blocks, not the one that fragments it.

11. **Time comes from config + the calendar, never the server clock.** Every scheduling decision resolves its timezone from the owner's home config and the calendar's Working-Elsewhere signal — never the machine's own timezone. Maelle may run on a trip-zone laptop or a UTC cloud box; reading the server clock is a wrong-time bug that only surfaces when the server ≠ the owner's zone (the v3.5.4 7-hour drift).

## The discipline — the ONE diagnostic process for every bug

1. **Reproduce from the log.** `logs/maelle-YYYY-MM-DD.log`. Find the turn(s); pull the tool calls, the `find_available_slots`/`checkSlot`/`getFreeBusy` results, the rejection breakdowns, the verdicts. State the root as `file:line — what actually happens`. If you can't see it in the log, say so and add a definitive log line before guessing.
2. **Ask: which root is this?** Map it to a cluster below. If it's a new root, name it. Most "new" bugs are an old root resurfacing.
3. **Fix at the chokepoint, deterministically.** A return value the model reacts to, a single validator, a code-owned resolution — not a prompt rule. If a prior layer patched this, *remove* it.
4. **One validator / one source.** Search, candidate-check, and booking must give the SAME answer for the same slot; a decision made in two places that can disagree IS the bug.
5. **Paper-trace before "done."** Generate the scenario matrix from the change and trace each against code on disk (the `trace` skill). 100% bar — a failing trace means not done.

## Subsystem map — know every piece

**Tool surface** (`src/skills/meetings.ts` — MeetingsSkill): `get_calendar`, `get_free_busy`, `find_available_slots`, `create_meeting`, `move_meeting`, `update_meeting`, `delete_meeting`, `check_join_availability`, `find_slack_user`, `hold_slot`, `set_event_category`. Tool *descriptions* steer tool choice — but their **wording is the tenancy chat's lane**, not this one's.

**Handlers** (`src/skills/meetings/ops.ts` — the heavy file): every direct calendar-op case — create/move/update/delete, the idempotency pre-check + create-vs-move guard, the requester-scrub, the WE time-resolve + travel-context blocks, floating-block branches, location stamping, the spread-pick + offered-slot exclusion.

**The pipeline** (`src/skills/meetings/planMeeting.ts`): the ONE booking decision path — LOAD STATE → DETECT CATEGORY → RESOLVE LOCATION → CHECK RULES → DECIDE ACTION (book / find_slots / confirm_override / escalate_approval / propose_alternative / decline_and_relay / refuse / ask_location_mode). Supporting: `detectCategory.ts`, `findMeetingOwner.ts`, `bookingRequest.ts` (normalizer), `resolveAttendeeEmails.ts`, `movingAnchorDay.ts`.

**The validators / decision helpers:**
- `src/utils/scheduleRules.ts` — **`checkSlot` is THE validator** for verdicts AND bookings; `requiredFreeMinutesForWorkDay` is the ONE free-time-floor source (called by review, `checkSlot` rule 9, and the health sweep). If a check isn't going through `checkSlot`, that's a consistency risk.
- `src/utils/availabilityPreCheck.ts` — the colleague "is X free?" verifier (runs `checkSlot` per proposed time). Must agree with the booking path.
- `src/utils/weTimeResolver.ts` — **THE Working-Elsewhere time spine.** `resolveStatedInstant` (stated clock + `stated_zone` + travel ctx → the canonical instant) + `renderWeDualClock` (the ONE dual-clock display string, quoted verbatim everywhere). The single source for "what instant does the stated time mean, and how is it shown" on a trip day. **Don't re-scatter this.**
- `src/utils/workingElsewhere.ts` — WE detection: `resolveOwnerTravelContextForDate` + `getTravelContextForInstant` (the ONE "where am I / in what zone" on a day).
- `src/utils/timezoneConvert.ts` — the low-level TZ math (`reinterpretClockInZone` / `renderClockInZone` / `isoHasExplicitZone`), used by the spine. Zones passed explicitly — never the server clock (rule 15).
- `src/utils/weConfirmStash.ts` — the WE trip-time confirm, consume-on-use (shows once; a re-issue books; can't re-lock a time the owner is correcting).
- `src/utils/resolveLocation.ts` — the location decision tree (office/home/travel/online). A native Teams meeting is defined by `isOnlineMeeting` + provider at create — never stamp the join URL into location.
- `src/utils/floatingBlocks.ts` — lunch/gym/focus elastic blocks (placement, window, alignment).
- `src/utils/attendeeAvailability.ts` — per-day attendee TZ / travel window (`attendeeTzForDay`).
- `src/utils/offeredSlotsStash.ts` — per-conversation offered slots (pick-binding + "another option" exclusion; accumulates the union).
- `src/utils/threadEventLedger.ts` — in-thread event ids (edit by id, not re-find) + active-planning-week anchor.

**The Graph layer** (`src/connectors/graph/calendar.ts`): `findAvailableSlots` (the spread search + rejection engine + auto-expand + WE per-day TZ), `pickSpreadSlots` (round-robin by day, target 5 — spreads across whatever days are in the window), `getFreeBusy`, `createMeeting`/`updateMeeting`/events CRUD, `findDuplicateEvent` (idempotency) + `findReschedulableSibling` (create-vs-move guard), `normalizeForGraph`, **the calendar cache** (invalidated after mutations — a prime staleness suspect).

**Removed:** the `coord/*` multi-party state machine was deleted in 3.5.0 — colleagues book via the direct path. **Not this agent's:** the approval → booking → close-loop spine (`src/core/requests/*`, `closeMeetingArtifacts`) belongs to the approval chat.

## The recurring bug clusters (the hot zones — fix at root)

1. **Free/busy truth + cache staleness.** Slots reported busy that are free (and vice-versa); the cache returning stale state after a mutation; merged free/busy needing `carveRangeFromBusy` not exact-match. **Suspect #1 for instability.**
2. **One-validator consistency.** Search vs candidate-check vs booking giving different answers for the same slot ("everyone free" at propose → conflict at book). Make `checkSlot` the single truth; everything routes through it.
3. **Timezone / Working-Elsewhere.** ET↔Israel inversion, a bare trip-time, the away-TZ. This now has a spine (`weTimeResolver`) — the fix for any WE/tz symptom is *route it through the spine, don't re-scatter*. Rule 11: on any WE/tz symptom, check the naive-parse-in-server-tz class FIRST, not the WE markers. Residual by design: when the owner *names* a zone, first-pass correctness rides the model setting `stated_zone`, backstopped by the visible dual-clock confirm.
4. **Date / week resolution.** A bare weekday or "next week" resolving to the wrong week. The date interpretation is the model's job (varied NL); the tool already returns the window it searched — surface it so a wrong week is visible + one-round correctable (this is prompt-side; route the narration to the prompt chat).
5. **Endless clarifying / don't-ask-under-force.** Re-asking a given subject; ignoring "Force / book." Prompt-adjacent — route the orchestrator half to the prompt chat.
6. **Floating blocks.** Duration reset on move, a window guard blocking an explicit owner move, an owner-placed block overridden.
7. **Owner↔colleague desync + close-loop relay.** The same meeting negotiated in two threads; "did the colleague get told?" → the **approval chat** owns this now.

## The chats — route work to the right lane

Other chats run in parallel on the same repo. At a coordinated wrap, `git status` first and stage deliberately (`git add -A` only on an explicit "take them all").
- **Meeting agent (this chat)** — the meeting-planner **deterministic core**: search / validate / book-decision / TZ+WE / floating-blocks / Graph + cache. NOT the approval spine.
- **Approval agent** — the approval → booking → close-loop spine (`src/core/requests/*`, `closeMeetingArtifacts`, requester relay). The desync / relay-drop / "did the colleague get told" class.
- **Guard agent** — the gate stack: `claimChecker`, `securityGate`, `humanGate`, `dateVerifier`, the `postReply` pipeline. Honesty / leak / false-positive issues.
- **Prompt agent** — the orchestrator system prompt (`systemPrompt.ts`): language, scheduling narration, judgment/tone. A budget — rules that belong in code don't go here.
- **Tenancy agent** — tool descriptions + per-skill prompt sections + de-tenant / learned-preference work.

When a "meeting bug" is really approval/booking/relay → approval chat; honesty/leak → guard; tone/judgment/narration → prompt; tool-description/routing → tenancy. Hand the right chat a self-contained paste-block; don't build outside your lane. The meeting agent owns the deterministic scheduling core.
