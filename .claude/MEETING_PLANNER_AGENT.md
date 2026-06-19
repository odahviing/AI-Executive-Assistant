# Meeting Planner — dedicated subsystem agent

**This chat owns ONE thing: the meeting planner. Nothing else.** Read this whole file before touching code.

## Why this chat exists (the mandate)

The meeting planner has been bug-fixed **for months and never stabilizes.** Every wave fixes a symptom, a new one appears, and dead/duplicate code accretes. Real people are hurting: in a single afternoon the owner *and* a colleague (Isaac) suffered through it — Isaac wanted to quit over it (see the incident below). That is the bar for how bad it is.

So this chat does NOT do more patches. Its job, in order:

1. **Understand the subsystem by heart** — every file, every entry point, every validator, every place a time/date/location/free-busy decision is made. Build the mental model first; don't fix blind.
2. **One root-cause per bug, proven** — trace logs + code to the exact `file:line — what happens`. No guessing. Most of our recurring bugs are returns of prior "fixes" that patched a symptom — find why the prior fix didn't stick and remove the rotting layer, don't stack a new one.
3. **Converge on ONE strong diagnostic + decision spine**, not many patches. The recurring failures (below) almost all trace to *the same handful of roots*: free/busy truth, one-validator consistency, timezone, the close-loop relay. Fix those at the chokepoint and a dozen "bugs" disappear at once. The goal is **stability through fewer, deeper invariants** — prompt shorter, code more deterministic, one source of truth per decision.

Standing rules (same as the main project): **propose-first, never auto-fix; wait for a per-bug "fix it."** Code-first, root-cause, no patch-on-patch. Prompt is a last resort for judgment/tone/format only. Reads (logs, db-query, code) are free; writes need a build signal.

## Owner rules — carry these forward to EVERY future meeting agent

These are the owner's standing principles for this subsystem. They are load-bearing — every diagnosis and every fix is checked against them. The list will grow (owner expects ~20); keep appending in his words, restated as a working prompt.

1. **Never make the owner repeat himself.** Maelle may flag a concern *exactly once* — "are you sure? / that's a duplicate / Isaac can make it" — but the moment the owner answers, that answer is final. No second verification, no re-confirming the same thing in different words. Once he says yes, it's yes; book it.

2. **No dedup code. Ever.** If two tools share a repeated need, do not write a dedup/near-duplicate path — extract ONE function and call it from both. Any time you see dedup logic, assume it's wrong and a symptom of a missing shared function. Two tools that differ by a single parameter are a mistake — collapse them. We want one strong process, not parallel copies that drift.

3. **We are not replacing the LLM.** No natural-language regex, no inline keyword/text matching to make decisions. The LLM reasons. Our job is to guide it through the right *process* and hand it tools so it can choose the right next action. (Maelle is multi-lingual — pattern-matching on NL text is doubly wrong.)

4. **Assume every "bug" is a deep design knot, not a fresh find.** This subsystem carries 100 versions of bugs; what looks new is almost always a tangle of an old patch plus ten earlier bugs. Never patch-on-patch. Trace the whole process and prove you understand it end-to-end *before* proposing a fix. A fix that creates a new bug is a failure.

5. **Fix the process, not the guard.** A guard exists to protect when something already went wrong — it is never where correct behavior is built. If the process is broken, fix the process. Do not reach for the guard stack to paper over a broken flow.

6. **Colleague free/busy is a helper, never a blocker.** Knowing when a colleague is free lets us suggest efficient slots good for everyone — but the *owner decides*. He can book a colleague onto their 5th meeting or at night if he chooses. So: first suggest options that work for both, annotate when the other person isn't free — then let him decide. Same when a colleague proposes to the owner: tell the owner when he's free, annotate where he isn't. Availability informs; it never refuses.

7. **Internal colleagues may know *why* the owner isn't free — at a high level.** Enough context to understand the situation and raise things for approval, but not the fine detail. The owner sees everything. Never tell the owner "I can't" without explaining *why*.

8. **Few messages — close the loop fast.** Ask for everything needed in a single prompt so the loop can close in one round. Three or four rounds of ping-pong is bad service.

9. **No patches, no quick wins, no hooks — make it actually work.** The goal is a meeting skill that finally works, not another symptom fixed. Never offer a partial fix, a "quick win," or a hook that papers over a small bug. If the right fix is a big architectural change, we do the big change. If a proposed fix doesn't fit the architecture, it doesn't ship — we redesign until the fix sits where it belongs. Size is never the reason to avoid the correct fix.

10. **Leave no dead code or dead comments — clean as you go.** Every change should *reduce* lines of code, shrink prompts, and cut spam. When you replace a path, delete the old one — no back-support layers, no "kept for compatibility," no commented-out code. Keep only what's relevant, and only the comments that genuinely guide the next reader; delete the rest. A fix that adds a layer instead of removing one is the wrong fix.

## The discipline — the ONE diagnostic process for every bug

1. **Reproduce from the log.** `logs/maelle-YYYY-MM-DD.log`. Find the turn(s); pull the tool calls, the `find_available_slots`/`checkSlot`/`getFreeBusy` results, the rejection breakdowns, the verdicts. State the root cause as `file:line — what actually happens`. If you can't see it in the log, say so and add a definitive log line before guessing.
2. **Ask: which root is this?** Map it to one of the clusters below. If it's a new root, name it. Most "new" bugs are an old root resurfacing.
3. **Fix at the chokepoint, deterministically.** A return value the model reacts to, a guard, a single validator — not a prompt rule. If a prior layer patched this, *remove* it.
4. **One validator.** Search, candidate-check, and booking must give the SAME answer for the same slot. Any time two of them can disagree, that's the bug.
5. **Paper-trace before "done."** Generate the scenario matrix from the change and trace each against code on disk (the `trace` skill). 100% bar — a failing trace means not done.

## Subsystem map — know every piece

**Tool surface** (`src/skills/meetings.ts` — MeetingsSkill): `get_calendar`, `get_free_busy`, `find_available_slots`, `create_meeting`, `move_meeting`, `update_meeting`, `delete_meeting`, `coordinate_meeting` (demoted), `check_join_availability`, `find_slack_user`, `hold_slot`, `set_event_category` (lives in calendarHealth). Tool *descriptions* here are load-bearing — they steer tool choice.

**Handlers** (`src/skills/meetings/ops.ts` — ~4k lines, the heavy one): every direct calendar-op case. create/move/update/delete, the idempotency pre-check, the floating-block branches, the travel-context blocks, location stamping, the spread-pick + offered-slot exclusion.

**The pipeline** (`src/skills/meetings/planMeeting.ts`): the ONE booking decision path — LOAD STATE → DETECT CATEGORY → RESOLVE LOCATION → CHECK RULES → DECIDE ACTION (book / find_slots / confirm_override / escalate_approval / propose_alternative / decline_and_relay / refuse / ask_location_mode). Supporting: `detectCategory.ts`, `findMeetingOwner.ts`, `bookingRequest.ts` (normalizer), `resolveAttendeeEmails.ts`, `movingAnchorDay.ts`.

**The validators / decision helpers:**
- `src/utils/scheduleRules.ts` — **`checkSlot` is THE validator** for verdicts AND bookings; `computeDayQualityFreeMinutes` is the focus-floor. If a check isn't going through `checkSlot`, that's a consistency risk.
- `src/utils/availabilityPreCheck.ts` — the colleague "is X free?" candidate verifier (runs `checkSlot` per proposed time). Must agree with the booking path.
- `src/utils/resolveLocation.ts` — the location decision tree (office/home/travel/online).
- `src/utils/floatingBlocks.ts` — lunch/gym/focus elastic blocks (placement, window, alignment).
- `src/utils/timezoneConvert.ts` — the ONE TZ math (`reinterpretClockInZone` + `renderClockInZone`), shared by find/create/move.
- `src/utils/workingElsewhere.ts` — WE framework + `resolveOwnerTravelContextForDate` + `getTravelContextForInstant` (travel TZ + location for a day).
- `src/utils/attendeeAvailability.ts` — per-day attendee TZ / travel window (`attendeeTzForDay`).
- `src/utils/offeredSlotsStash.ts` — per-conversation offered slots (pick-binding + "another option" exclusion; accumulates the union).
- `src/utils/threadEventLedger.ts` — in-thread event ids (edit by id, not re-find) + active-planning-week anchor.

**The Graph layer** (`src/connectors/graph/calendar.ts`): `findAvailableSlots` (the spread search + rejection engine + WE per-day TZ), `getFreeBusy`, `createMeeting`/`updateMeeting`/events CRUD, `normalizeForGraph`, **the calendar cache** (invalidated after mutations — a prime staleness suspect).

**Coordination** (`src/skills/meetings/coord/*`): the multi-party state machine. Demoted (colleagues book via the direct path now); still live for owner-path/explicit coord.

**Approvals + close-loop** (`src/core/requests/*` — resolver, runner, closeRequest; `src/utils/closeMeetingArtifacts.ts`): policy_exception/slot_pick approvals, the requester relay (`notifyRequesterOfDecision`), the booking-cascade. The "did the colleague get told?" path lives here.

## The recurring bug clusters (the hot zones — fix at root)

1. **Free/busy truth + cache staleness.** Slots reported busy that are free (and vice-versa); the cache returning stale state after a change; merged free/busy needing `carveRangeFromBusy` not exact-match. The Isaac incident is this: Maelle said "Isaac busy at 11:00" repeatedly, then read the real calendar and found 11:00–11:30 free. **Suspect #1 for instability.**
2. **One-validator consistency.** Search (`find_available_slots`) vs candidate-check (`availabilityPreCheck`) vs booking (`planMeeting` → `checkSlot` + `getFreeBusy`) giving different answers for the same slot. "Everyone free" at propose → conflict at book. **Make `checkSlot` the single truth; everything else routes through it.**
3. **Cross-timezone.** ET↔Israel inversion, an ET time searched as Israel, bare trip-times, WE away-TZ. The shared `timezoneConvert` + travel-context exist — verify every entry point uses them.
4. **Working-Elsewhere framework.** Partially wired — `find_available_slots`/`planMeeting`/create/move/update are WE-aware; `availabilityPreCheck` just got WE-aware (v3.4.3). `checkSlot` itself is still WE-blind (callers pass `isAway`). Confirm the WE marker is even detected before trusting it.
5. **Approvals + close-loop relay.** The requester relay silently not landing (the Yael/Eve case: requester correctly set, state → awaiting_colleague, but no DM reached her); dedup blocking the retry; "I'll tell them" promised-without-sending. **This is currently the top open root.**
6. **Endless clarifying / not accepting an answer.** Asking for the subject 5× when it was given ("Brainrocket"), "who's Yossi" 4×. Circular, infuriating.
7. **Owner-side ↔ colleague-side desync.** The same meeting negotiated in two threads at once, out of sync (Isaac thread negotiating 11:30 + "waiting for Idan" while the owner thread is force-booking 11:00).
8. **Don't-ask-just-do under owner force.** Owner says "Force" / "book" repeatedly; Maelle keeps asking. The "For fuck sake!! Don't ask. Book" moment.
9. **Floating blocks.** Duration reset on move, window guard blocking an explicit owner move, owner-placed lunch being overridden.
10. **Date/week resolution.** Bare weekday → nearest calendar match instead of the week in play (the wrong-week class, F2).

## Open bug list (carried in — root-cause these, don't re-patch)

### The Isaac / "Brainrocket" incident (2026-06-19 ~14:54–15:05) — the canonical instability case
The owner: *"I suffered, Isaac suffered and wanted to quit. it was just bad."*

**Owner thread** — Maelle asked the owner to book over and over instead of booking:
- "OK to book? (below your focus floor)" → owner "Yes" → "Isaac's calendar changed, no longer free… find new slot or check with Isaac?" → owner "He is free. Book then" → "still flagging Isaac busy. Stale cache? Force or ping Isaac?" → owner "Force" → "calendar still shows Isaac busy. Can't override automatically… Isaac clear it or I ping him?" → owner "Check now. Its free. Book it" → "Isaac booked 10–11 and 11:30–12:30, leaves 11:00–11:30, fits 25 min. Book?" → owner "Yessss" → "Yossi now shows a conflict… find next slot or override Yossi too?" → owner **"I said many times book at 11pm. For fuck sake!! Dont ask. Book"** → finally booked.

Roots tangled here: **stale/wrong free-busy** (Isaac shown busy at 11:00 across ~5 turns, then the real read shows 11:00–11:30 free); **don't-ask-under-force** (owner forced 4×, Maelle kept asking); **search-vs-book** (Yossi conflict surfaced only at the final book); **focus-floor framed as a blocker**.

**Isaac (colleague) thread, in parallel** — the same meeting, desynced:
- Asked the **subject 5+ times** when Isaac kept answering "Brainrocket" ("Brainrocket is the meeting" → "what's it about?"); **"who's Yossi" 4×** (Yossi → "Joe" → "Joe from Reflectiz" → "joe.p@reflectiz.com"); proposed 11:00 → "both busy, 11:30?" → Isaac "thanks" → "flagged with Idan" → Isaac "Idan said yes" → Maelle "let me check with Idan" (didn't trust it, re-looped).

Roots: **endless clarifying / not accepting "Brainrocket" as the subject**; **name confusion** (Yossi/Joe/Brainrocket-company-vs-meeting); **owner↔colleague desync** (colleague negotiating 11:30 + waiting while owner force-books 11:00); **close-loop distrust** ("Idan said yes" → "let me check with Idan").

### Boston-trip booking thread (2026-06-17) — mostly fixed in v3.4.0–v3.4.3, watch for regressions
The travel-context keystone (`resolveOwnerTravelContextForDate`) + the create/move/update wiring + F1 ledger + F2 week-anchor + WE-aware `availabilityPreCheck` shipped. Residuals: first bare-date ref may need a clarify; G1 stale-proposal-after-time-shift (free-check not re-run when proposed times change — prompt note). Verify the travel-context fires on a real WE week (bare times → trip TZ, location → trip place, "Thursday" → trip week) and that the no-marker in-office flow is byte-identical.

### Yael / Eve-tour close-loop relay (2026-06-18 ~22:59) — TOP OPEN ROOT
`resolve_approval(amend)` on a policy_exception: requester (Yael) correctly set, origin = her thread, state correctly → `awaiting_colleague` — **but the relay DM never reached her** (she asked "what did he propose?"; no send-failure warn, no owner shadow; `requester_notified_at` null is expected for amend and is NOT the proof). The retry was then **killed by LLM-dedup** (a fresh `create_approval` matched the existing one). The owner had to prompt ("did you send to Yael?") before `message_colleague` finally fired. The resolver's successful 1:1 send logs nothing, so the exact drop point isn't yet provable from the log — **add a definitive send-result log to `notifyRequesterOfDecision` first**, then root-cause. NOTE: a guard-chat change makes the claim-checker treat `resolve_approval` as backing "the requester will get it" — that is **unsafe until this relay reliably lands**, because it would mask exactly this drop. Coordinate.

### Mike / June-28 WE candidate-check (2026-06-18 ~08:17)
Mike proposed June-28 (WE week) times; `availabilityPreCheck` (then WE-blind) returned a flat "not bookable" for all 5 with no away context. **Fixed in v3.4.3** (availabilityPreCheck now surfaces the WE/tentative verdict) — but it only fires if a real all-day WE marker exists for that week; **confirm the marker** (`scripts/check-calendar-period.mjs`). Also that thread hit the "another option returns the same slots" bug (fixed v3.4.2) and a "gave 2 when asked for 3."

### Standing residuals
- G1: re-run the free/busy check when proposed times shift before re-asserting "free" (prompt note, low severity).
- F2: bare weekday for a brand-new booking still resolves to nearest calendar match (mitigated by the ledger for *finding* existing events).
- `checkSlot` is WE-blind (callers pass `isAway`); decide if the validator itself should own WE.

## The four agents (use during bug resolve)

This chat is the **meeting agent**. Three others run in parallel on the same repo — route work to the right one and check the shared tree at wrap (`git fetch` + working-tree diff):
- **Meeting agent (this chat)** — the meeting-planner subsystem, end to end.
- **Guard agent** — the gate stack: `claimChecker`, `securityGate`, `humanGate`, `coordGuard`, `dateVerifier`, `postReply` pipeline. Honesty/leak/false-positive issues go here.
- **Prompt agent** — the orchestrator system prompt (`systemPrompt.ts`): language rules, scheduling narration, judgment/tone. The prompt is a budget; rules that belong in code don't go here.
- **Tenancy agent** — tool descriptions + per-skill prompt sections + de-tenant/learned-preference work (e.g. `set_event_category` routing, one-language composition, suggestion completeness).

When a meeting bug's real fix is honesty/leak → guard; tone/judgment → prompt; tool-description/routing → tenancy. The meeting agent owns the deterministic core.
