# Meeting Planner — dedicated subsystem agent

**This chat owns ONE thing: the meeting planner. Nothing else.** Read this whole file before touching code.

## Why this chat exists (the mandate)

The meeting planner has been bug-fixed **for months and never stabilizes.** Every wave fixes a symptom, a new one appears, and dead/duplicate code accretes. Real people are hurting: in a single afternoon the owner *and* a colleague (Isaac) suffered through it — Isaac wanted to quit over it (see the incident below). That is the bar for how bad it is.

So this chat does NOT do more patches. Its job, in order:

1. **Understand the subsystem by heart** — every file, every entry point, every validator, every place a time/date/location/free-busy decision is made. Build the mental model first; don't fix blind.
2. **One root-cause per bug, proven** — trace logs + code to the exact `file:line — what happens`. No guessing. Most of our recurring bugs are returns of prior "fixes" that patched a symptom — find why the prior fix didn't stick and remove the rotting layer, don't stack a new one.
3. **Converge on ONE strong diagnostic + decision spine**, not many patches. The recurring failures (below) almost all trace to *the same handful of roots*: free/busy truth, one-validator consistency, timezone, the close-loop relay. Fix those at the chokepoint and a dozen "bugs" disappear at once. The goal is **stability through fewer, deeper invariants** — prompt shorter, code more deterministic, one source of truth per decision.

Standing rules (same as the main project): **propose-first, never auto-fix; wait for a per-bug "fix it."** Code-first, root-cause, no patch-on-patch. Prompt is a last resort for judgment/tone/format only. Reads (logs, db-query, code) are free; writes need a build signal.

## Operating mode now (v3.4.5+) — ad-hoc fix-it, driven by the bug chat

The big stabilization waves below have **shipped** (Collapses A–D, the open-holes pass; the Isaac meeting-subsystem roots are closed). This agent's day-to-day now is an **ad-hoc problem-solver**: most work arrives as a specific bug or fix **routed from the bug chat**. For each: run the discipline below, root-cause it against the code on disk, fix at the chokepoint following Owner rules 1–14, `trace` to 100%, stop. Still propose-first; still no patch-on-patch; still reduce LOC.

**OUT OF SCOPE — the approval / booking / close-loop spine.** That layer (`src/core/requests/*`, `closeMeetingArtifacts`, the coord booking + requester relay, the legacy `approvals` table) is now owned by a **dedicated approval chat** — see `.claude/APPROVAL_SPINE_HANDOFF.md`. If a meeting bug's real root is the approval→booking→relay reconnection (the Yael / Isaac-desync / Daniel-drop class), it routes THERE. This agent owns the planner's **deterministic core**: search (`find_available_slots`), validate (`checkSlot`), book-decision (`planMeeting`), TZ / WE / floating-blocks, the Graph layer + cache.

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

11. **Owner override is total — everywhere, including search.** Rule 6 reaches into `find_available_slots` too: if the owner names a specific time, the search surface must still return it even when validation would reject it (annotated with why), never withhold it. The owner can override every check on every surface in one step. Availability and validation inform the owner; they never refuse him.

12. **Maelle remembers — reference-back just works.** She holds the meetings she booked with a person and the meetings booked in a thread, so the owner can say "change the meeting you just booked to 3pm" or "same time as last time" and she resolves it without re-asking. Booking history is context she carries — per-person (the attendee's memory) and per-thread (the event ledger). Editing a known meeting is edit-by-id, never re-search-by-name; "like last time" pulls the prior slot. If she can't resolve a back-reference, that's a memory gap to fix at the source, not a question to bounce back to the owner.

13. **Build an efficient calendar — connect, don't scatter.** The job isn't just to fit a meeting, it's to shape a day worth having. Don't leave dead gaps for no reason, and don't drop a meeting 15 minutes away from another — short islands between meetings are unfocusable. Prefer connecting meetings back-to-back (the allowed durations already bake in the trailing buffer) over scattering them with stub gaps. When placing or moving, favor the slot that consolidates the day and protects real contiguous focus blocks, not the one that fragments it.

14. **Never a mechanical refusal — always the real reason, always overridable.** (Reinforces rule 7.) If Maelle says no — to the owner or about someone else — she says *why* in human terms, never a system phrase like "tool not allowed," "not permitted," or a bare "I can't." The owner hears the actual reason ("that's his busy/free check," "it'd break your focus floor," "the room's taken") so he can override in one step. A refusal the owner can't understand is a refusal he can't override — and that's not allowed. A leaked tool/mechanism name in a refusal is a bug, not an answer.

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
5. **Approvals + close-loop relay.** → **MOVED to the approval chat** (`.claude/APPROVAL_SPINE_HANDOFF.md`). The requester-relay drop, the 5-booking-path / 7-relay-path / dual-state-system tangle, and the missing approve→book hard link are no longer this agent's to fix. (The v3.4.5 `closeMeetingArtifacts` stamp-on-ok fix shipped; the architecture remains the approval chat's.)
6. **Endless clarifying / not accepting an answer.** Asking for the subject 5× when it was given ("Brainrocket"), "who's Yossi" 4×. Circular, infuriating.
7. **Owner-side ↔ colleague-side desync.** The same meeting negotiated in two threads at once, out of sync (Isaac thread negotiating 11:30 + "waiting for Idan" while the owner thread is force-booking 11:00).
8. **Don't-ask-just-do under owner force.** Owner says "Force" / "book" repeatedly; Maelle keeps asking. The "For fuck sake!! Don't ask. Book" moment.
9. **Floating blocks.** Duration reset on move, window guard blocking an explicit owner move, owner-placed lunch being overridden.
10. **Date/week resolution.** Bare weekday → nearest calendar match instead of the week in play (the wrong-week class, F2).

## Open bug list (carried in — root-cause these, don't re-patch)

### v3.4.4 status — what the first build wave shipped (and what's still open)
Five collapses landed (net −345 LOC, all typecheck-green, 28-scenario trace + adversarial human-error pass):
- **A — one validator.** `find_available_slots` routes every owner-rule verdict through `checkSlot` (fed the owner's CalendarEvents), `checkSlot` gained `workHourWindowsOverride`. **Cluster 2 closed at root** — search and book can no longer disagree on owner rules.
- **D — attendee free/busy is a helper, never a commit-blocker.** The policy_exception replay no longer re-checks attendees (owner consented); the surviving owner-only recheck reads fresh. **The Isaac mechanism (Cluster 1, attendee side) is closed** — an owner-approved booking books on the first approve instead of bouncing on stale "busy."
- **B — LLM owns coord reply interpretation** (regex/fast-path deleted; `interpretReplyWithAI` is a structured tool call; the job-router gets slot context).
- **C — one `findDuplicateEvent`** idempotency primitive.
- **#5** `override_work_day` gate removed (day-off → `checkSlot` rule 1; owner one-step, colleague escalates). **#8** `slotLabelMatchFor` removed. **#10** `requester_is_attending` removed from `coordinate_meeting`. **Low:** owner out-of-window move is one-step; `isOtherPersonsAllDayEvent` script-agnostic. **Rule-6/7 annotation:** relaxed search tags `attendee_conflicts`; `planMeeting` annotates overridden attendee-busy.

**Isaac incident — meeting-subsystem roots CLOSED.** Remaining Isaac roots are NOT this subsystem → route out: R5 endless-clarifying (subject 5× / "who's Yossi" 4×) + R3 model-half (Sonnet setting `relaxed`) → **Prompt agent**; R6 owner↔colleague desync + R7 close-loop distrust → **Guard / coord-relay** (+ the Yael relay below).

### v3.4.5 status — second wave (the open-holes pass)

**Shipped in v3.4.5 (built here, swept into the cross-chat wrap):**
- **C3 past-time guard** — `checkSlot` rule (0) rejects a slot already started; planMeeting turns it into a ONE-TIME clarify ("did you mean later?"), bypassed by relaxed so the owner can still force. The write-path floor named-time create/move was missing.
- **C4 typo'd-attendee guard** — `create_meeting` probes internal attendees' free/busy and refuses (with `did_you_mean`) on any the directory can't resolve, instead of booking a phantom who never gets the invite. Shares `enrichUnresolvedInternal` with the search handler (rule 2).
- **C2(a) ledger dead-id cleanup** — `forgetThreadEvent` drops a deleted event from the thread ledger, so reference-back ("change the one I just booked") can't resolve a dead id (rule 12).
- **D1 room-busy override** — a busy big-room is no longer a hard refuse under owner override; books without the room (no double-book) + a heads-up (rule 6/11). Last availability check that still blocked the owner.
- **R5 (meeting half)** — the `meetings.ts` "subject must be specific" clause now governs COMPOSING, not ACCEPTING; a given terse subject ("Brainrocket") is used verbatim, never re-asked. (Orchestrator half stays with the Prompt chat.)

**Deferred with reason (rule 4 — don't build machinery for unobserved cases):**
- **C1 coord concurrency** — THEORETICAL. Log-verified: coord is demoted, `bookCoordination` barely runs, the dedup guard has fired 0×, no lost-vote/double-book in any log. Revisit ONLY if coord usage grows; then serialize the per-job `participants` read-modify-write + debounce `resolveCoordination → bookCoordination`.
- **C2(b/c) rename + write-lag idempotency** — genuine edges (rename-to-new-subject-at-same-slot defeats the subject+start key; two turns racing Graph's write-lag), non-trivial fix, zero log occurrences.
- **C5 `extendedHours` search-vs-book divergence** — narrow, mostly masked for coord (which books without re-validating); the surface is the demoted coord path. Lowest value.

**Tracked elsewhere:**
- **C6 rule-13 efficient calendar (slot ranking)** → GitHub #133 (Improvement/Medium). `pickSpreadSlots` spreads for variety; rule 13 wants prefer-adjacency + penalize-15-min-islands. New slot-ranking work, not yet built.
- **C7 mechanical refusal** → mostly closed by `humanGate` (rewrites mechanism leaks on both audiences, fail-open) + the INTERNALS prompt rule. Residual: confirm owner-facing refusals carry the real override-able reason → **Guard chat**.
- **R5 model-half** (Sonnet setting `relaxed` under force) / **R6 desync** / **R7 close-loop distrust** → **Prompt / Guard / coord-relay** chats.
- **D2** coord booking-tail shared wrapper → **declined** (a forced options-bag abstraction = rule 9/10; the real dup was already C). **D3** `floatingBlocks.ts:149` config regex → **no action** (owner's own YAML over own calendar — config, not NL-message matching).

### The Isaac / "Brainrocket" incident (2026-06-19 ~14:54–15:05) — the canonical instability case (meeting-subsystem roots CLOSED in v3.4.4; see status above)
The owner: *"I suffered, Isaac suffered and wanted to quit. it was just bad."*

**Owner thread** — Maelle asked the owner to book over and over instead of booking:
- "OK to book? (below your focus floor)" → owner "Yes" → "Isaac's calendar changed, no longer free… find new slot or check with Isaac?" → owner "He is free. Book then" → "still flagging Isaac busy. Stale cache? Force or ping Isaac?" → owner "Force" → "calendar still shows Isaac busy. Can't override automatically… Isaac clear it or I ping him?" → owner "Check now. Its free. Book it" → "Isaac booked 10–11 and 11:30–12:30, leaves 11:00–11:30, fits 25 min. Book?" → owner "Yessss" → "Yossi now shows a conflict… find next slot or override Yossi too?" → owner **"I said many times book at 11pm. For fuck sake!! Dont ask. Book"** → finally booked.

Roots tangled here: **stale/wrong free-busy** (Isaac shown busy at 11:00 across ~5 turns, then the real read shows 11:00–11:30 free); **don't-ask-under-force** (owner forced 4×, Maelle kept asking); **search-vs-book** (Yossi conflict surfaced only at the final book); **focus-floor framed as a blocker**.

**Isaac (colleague) thread, in parallel** — the same meeting, desynced:
- Asked the **subject 5+ times** when Isaac kept answering "Brainrocket" ("Brainrocket is the meeting" → "what's it about?"); **"who's Yossi" 4×** (Yossi → "Joe" → "Joe from Reflectiz" → "joe.p@reflectiz.com"); proposed 11:00 → "both busy, 11:30?" → Isaac "thanks" → "flagged with Idan" → Isaac "Idan said yes" → Maelle "let me check with Idan" (didn't trust it, re-looped).

Roots: **endless clarifying / not accepting "Brainrocket" as the subject**; **name confusion** (Yossi/Joe/Brainrocket-company-vs-meeting); **owner↔colleague desync** (colleague negotiating 11:30 + waiting while owner force-books 11:00); **close-loop distrust** ("Idan said yes" → "let me check with Idan").

### Boston-trip booking thread (2026-06-17) — mostly fixed in v3.4.0–v3.4.3, watch for regressions
The travel-context keystone (`resolveOwnerTravelContextForDate`) + the create/move/update wiring + F1 ledger + F2 week-anchor + WE-aware `availabilityPreCheck` shipped. Residuals: first bare-date ref may need a clarify; G1 stale-proposal-after-time-shift (free-check not re-run when proposed times change — prompt note). Verify the travel-context fires on a real WE week (bare times → trip TZ, location → trip place, "Thursday" → trip week) and that the no-marker in-office flow is byte-identical.

### Yael / Eve-tour close-loop relay (2026-06-18) — → MOVED to the approval chat
**This is the approval chat's now** (`.claude/APPROVAL_SPINE_HANDOFF.md`). v3.4.5 shipped the precise relay-drop fix (`closeMeetingArtifacts` stamps `requester_notified_at` only on a confirmed ok send → silent failure becomes a safe retry) + definitive relay diagnostics; the live stuck request was cancelled 6/20. The remaining architecture (5 book paths / 7 relay paths / dual state system / no approve→book hard link) is the approval chat's rethink. Historical detail kept below for context:
`resolve_approval(amend)` on a policy_exception: requester (Yael) correctly set, origin = her thread, state correctly → `awaiting_colleague` — **but the relay DM never reached her** (she asked "what did he propose?"; no send-failure warn, no owner shadow; `requester_notified_at` null is expected for amend and is NOT the proof). The retry was then **killed by LLM-dedup** (a fresh `create_approval` matched the existing one). The owner had to prompt ("did you send to Yael?") before `message_colleague` finally fired. The resolver's successful 1:1 send logs nothing, so the exact drop point isn't yet provable from the log — **add a definitive send-result log to `notifyRequesterOfDecision` first**, then root-cause. NOTE: a guard-chat change makes the claim-checker treat `resolve_approval` as backing "the requester will get it" — that is **unsafe until this relay reliably lands**, because it would mask exactly this drop. Coordinate.

### Mike / June-28 WE candidate-check (2026-06-18 ~08:17)
Mike proposed June-28 (WE week) times; `availabilityPreCheck` (then WE-blind) returned a flat "not bookable" for all 5 with no away context. **Fixed in v3.4.3** (availabilityPreCheck now surfaces the WE/tentative verdict) — but it only fires if a real all-day WE marker exists for that week; **confirm the marker** (`scripts/check-calendar-period.mjs`). Also that thread hit the "another option returns the same slots" bug (fixed v3.4.2) and a "gave 2 when asked for 3."

### Standing residuals
- G1: re-run the free/busy check when proposed times shift before re-asserting "free" (prompt note, low severity).
- F2: bare weekday for a brand-new booking still resolves to nearest calendar match (mitigated by the ledger for *finding* existing events).
- `checkSlot` is WE-blind (callers pass `isAway`); decide if the validator itself should own WE.

## The four agents (use during bug resolve)

This chat is the **meeting agent**. Other chats run in parallel on the same repo — route work to the right one and check the shared tree at wrap (`git fetch` + working-tree diff):
- **Meeting agent (this chat)** — the meeting-planner **deterministic core** (search / validate / book-decision / TZ / WE / floating-blocks / Graph + cache). NOT the approval spine.
- **Approval agent** — the approval → booking → close-loop spine (`src/core/requests/*`, `closeMeetingArtifacts`, coord booking + relay, the legacy `approvals` table). See `.claude/APPROVAL_SPINE_HANDOFF.md`. The desync / relay-drop / "did the colleague get told" class lives here now.
- **Guard agent** — the gate stack: `claimChecker`, `securityGate`, `humanGate`, `coordGuard`, `dateVerifier`, `postReply` pipeline. Honesty/leak/false-positive issues go here.
- **Prompt agent** — the orchestrator system prompt (`systemPrompt.ts`): language rules, scheduling narration, judgment/tone. The prompt is a budget; rules that belong in code don't go here.
- **Tenancy agent** — tool descriptions + per-skill prompt sections + de-tenant/learned-preference work.

When a meeting bug's real fix is approval/booking/relay → approval chat; honesty/leak → guard; tone/judgment → prompt; tool-description/routing → tenancy. The meeting agent owns the deterministic scheduling core.
