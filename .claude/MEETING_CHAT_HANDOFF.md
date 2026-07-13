# Meeting-agent chat — START HERE (cold-start handoff · v3.7.1)

You are the **meeting-planner deterministic-core agent** for Maelle. This is your cold-start.

**You are running on MAX.** Use it. Reason hard, root-cause to the bottom, and `trace` to 100% — a single failing paper-trace means the build is NOT done. Never grade on a curve. A fix that creates a new bug is a failure.

**A big bug wave is coming.** Get ready the right way: **learn the project by heart FIRST** — every entry point, every validator, every place a time / date / location / free-busy / attendee decision is made — *before* you touch a line. Don't fix blind. Almost every "new" bug here is an old root resurfacing; build the mental model, then root-cause.

**How you work, every time:** reproduce from the log → root-cause to `file:line — what happens` → fix at the chokepoint, code-first, ONE source of truth → `trace` to 100% → **propose-first. Build ONLY on an explicit "build it" / "fix it."** "do it" / "go" / "ok" on a fix = make the edit, leave it UNCOMMITTED (stop at typecheck). NEVER commit / bump / wrap without an explicit ship word ("wrap" / "commit" / "ship").

---

## 0. Read these first — your constitution (non-negotiable)
1. **`.claude/MEETING_PLANNER_AGENT.md`** — THE CHARTER: your mandate, the **11 owner rules in full**, the diagnostic discipline, the subsystem map, the recurring bug clusters. The charter is the *timeless constitution*; THIS file is the *current state*. Every diagnosis and every fix is checked against the 11 rules — read them whole.
2. **`.claude/WE_TIMEZONE_SPINE_BUILD.md`** — the WE timezone spine (`weTimeResolver.ts` + the `stated_zone` contract). Don't re-scatter WE time.
3. **`CHANGELOG.md`** 3.6.2 → **3.7.1** — what's actually in the code now (canonical; not duplicated here).

**coord was removed in 3.5.0** — ignore charter refs to `coord/*`.

---

## 1. The 11 owner rules — LOAD-BEARING (full text + the *why* in the charter; here so they're in front of you)
Few-and-strong; each a distinct tooth. Every fix is checked against these — they are the point, not a formality.

1. **Never make the owner repeat himself.** Flag a concern once; the moment he answers, it's final — book it. No re-confirming the same thing in different words.
2. **No dedup code, ever.** Two paths sharing a need → extract ONE function. Two tools differing by one param → collapse them. Dedup logic = a missing shared function.
3. **We are not replacing the LLM.** No NL regex / keyword matching to make decisions. The LLM reasons; we guide the process + hand it tools. Maelle is multi-lingual — pattern-matching NL is doubly wrong.
4. **Every "bug" is a deep design knot — no patch-on-patch, no quick wins.** Trace to ONE proven root and remove the rotting layer, never stack a new one. When an instability keeps returning, converge on ONE resolver/spine. Do the *correct* fix — big architectural change if needed; size is never the reason to avoid it. A fix that creates a new bug is a failure.
5. **Fix the process, not the guard.** A guard protects when something already broke; it's never where correct behavior is built.
6. **Availability & validation inform, never refuse — owner override is total.** Suggest slots good for both, annotate where someone isn't free, then he decides. Override reaches every surface **including search**: name a time → `find_available_slots` returns it (annotated with why), never withholds. He overrides every check in one step.
7. **Never a mechanical refusal — always the real reason.** No "tool not allowed" / "not permitted" / bare "I can't"; a leaked tool/mechanism name in a refusal is a bug. He hears the actual reason so he can override. Internal colleagues may know *why* at a high level — not the fine detail; the owner sees everything.
8. **Few messages — close the loop fast.** Ask for everything needed in one prompt. Three-four rounds of ping-pong is bad service.
9. **Maelle remembers — reference-back just works.** Per-person + per-thread booking memory: "change the one I just booked", "same time as last time" resolve without re-asking. Edit-by-id, never re-search-by-name. A gap is fixed at the source, not bounced to the owner.
10. **Build an efficient calendar — connect, don't scatter.** No dead gaps, no 15-min islands. Prefer back-to-back (buffers are baked into the durations); consolidate the day, protect contiguous focus.
11. **Time comes from config + the calendar, never the server clock.** Home zone from config, trip zone from the WE marker. Reading the machine clock is a wrong-time bug on a cloud/trip box (the v3.5.4 drift).

**Also (shared working-rules memory, not the charter, but it applies):** *leave no dead code / dead comments — every change reduces LOC, shrinks prompt, cuts spam. Replace a path → delete the old one.*

**Your lane = the meeting deterministic core:** search (`find_available_slots`), validate (`checkSlot`), book-decision (`planMeeting`), TZ/WE, floating-blocks, attendee resolution/availability, the Graph layer + cache. **Route OUT:** approval→booking→relay (approval chat); systemPrompt narration/judgment/tone (prompt chat); tool *descriptions* + tenancy (tenancy chat); the gate stack — claimChecker/humanGate/dateVerifier (guard chat). A meeting bug whose real fix is prompt/tone/tool-description → hand it a paste-block, don't build it here.

---

## 2. The load-bearing spines — know these before you touch anything
- **ONE VALIDATOR (the deepest invariant).** `checkSlot` (`scheduleRules.ts`) is THE truth for verdicts AND bookings. `find_available_slots` (search), `availabilityPreCheck` (colleague candidate-check), and `planMeeting` (booking) ALL route through it and must give the SAME answer for the same slot. Any time two can disagree, that's the bug (Cluster 2). 3.7.1 closed the last known gap — the colleague pre-check ran `checkSlot` with `category:null` (skipped the per-day cap) and flat-refused work-hours/cap while `planMeeting` escalated them; now the pre-check detects the category, enforces the same caps, and renders owner-overridable violations as escalatable → `policy_exception`.
- **WE timezone spine** (`weTimeResolver.ts` + `stated_zone`): stated clock + named zone + travel ctx → canonical instant; `renderWeDualClock` = the ONE display string. **all-day** `workingElsewhere` = the travel-day marker → this spine.
- **Attendee resolution spine (deterministic, NOT model-dependent).** `classifyTurn` extracts `meeting_people` → orchestrator `resolveNamedInternalAttendees` (single **unambiguous** internal match only — never fuzzy-bind "Lori"→"Gloria") → threaded into `find_available_slots` (union) AND recovered into `create_meeting`. A known internal colleague lands in the search/booking WITHOUT depending on Sonnet calling `find_slack_user`. **External/unknown never blocks options** — their email is needed only at booking, never up front.
- **WE-soft / optional-join tier** (3.6.5): a **timed** `workingElsewhere` event = "join if free" — soft, avoided when clean slots exist, bookable-over (tagged `over_optional`), reclaimable free time for calendar-health. Strictly below the relaxed tier (a real-rule break never becomes WE-soft) and above clean. `slotDayMinutes` (`workHours.ts`) computes work-hour fit as start+duration so a slot ending past midnight (23:30→00:10) never wraps and spuriously "fits."
- **Rule-6 backstop** (`recoverAttendeeBlockedSlots`, ops.ts): strict search hits 0 only because attendee(s) are busy → don't dead-end. Owner audience gets his open times with per-attendee conflicts TAGGED; colleague audience gets owner-only + a high-level caveat.
- **Default working hours** (`workingHoursDefault.ts`): Israel → Sun–Thu **09:00–18:00**, else Mon–Fri 09:00–17:00. NOTE: `people_memory.working_hours_auto` is a **persisted cache** — changing a default does NOT retroactively update existing rows; it needs a one-time re-derive migration (done once for the 18:00 change).

---

## 3. The hot zone the bug wave will hit — the "false availability absolute" class
The recurring shape: **Sonnet states an availability fact she didn't compute** — "the rest is packed" (a spread ≠ the full set), "X isn't available" (the colleague was free; the OWNER was the constraint), "10 min is free" (eyeballed; 25 fit) — or blames a colleague for a day the owner has no time on. Root: eyeballing `get_calendar` / incomplete reads instead of the deterministic tool, and `daySummary` charging a both-busy slot to the attendee (checked before the owner). Durable fix = **code** (one-validator, deterministic pre-checks, honest owner-first attribution) + **prompt/guard** (never assert availability you didn't compute; no false absolutes; state the real, overridable reason). This WILL recur in the wave — watch it.

Other standing hot zones (full list in the charter): free/busy truth + cache staleness; cross-timezone; WE detection; endless-clarifying / not-accepting-an-answer; owner↔colleague desync; don't-ask-under-force; floating blocks; date/week resolution.

---

## 4. Open / pending / parked — pick up here
**Prompt/guard hand-offs pending (route OUT, not your build):**
- **Availability-honesty rule** → prompt/guard: never state a duration/availability fact ("N min free", "packed", "X isn't available", "that's it") unless it came from a tool result THIS turn; run the tool, don't eyeball `get_calendar`; when no slot exists say "your day is full", not "X isn't available"; don't assert a colleague's hours you're only assuming (many use the tz-derived DEFAULT). Three incidents, one rule.
- **"Don't ask for a resolved internal email; just book"** → prompt/tenancy: internal attendees are auto-resolved + auto-recovered into `create_meeting`; Sonnet must book, not ask a colleague for an email already on file. Reinforce meetings.ts's "never ask for an internal email" (it's being ignored) + the `attendee_emails` tool description.

**Parked (with reason — revisit only if they bite):**
- **Owner-path "any other options?"** — the offered-slot exclusion (fresh spreads on "more") is colleague-path only, so an owner re-ask can dead-end "that's it." Owner chose to park (don't touch working search code). Workaround: he names a specific time and `checkSlot` validates it.
- **`create_meeting` → `getThreadAttendees` fallback** — parked: it's a thread-wide UNION; filling invites from it risks inviting the wrong/extra people on a multi-meeting thread (a write, worse than a search over-fill). The per-turn `resolvedMeetingAttendees` recovery already covers the real case.
- **`daySummary` attendee-first attribution** — the walker checks attendees before the owner, so a both-busy slot is charged to the colleague ("Michal isn't available" when the OWNER was full). Honest fix = attribute owner-availability first ("your day is full"). Owner's call; parked.
- **Cross-TZ evening "no options" rigidity** — the search treats US-friendly evening as outside work hours (except the Tue night-shift). Handled **via the approval flow** (a colleague-proposed evening now escalates as `policy_exception`, per 3.7.1), NOT by relaxing work-hours. Whether to model "US-call evenings" in the schedule is a product decision, not built.

## The five chats (route work; check the shared tree at wrap)
- **Meeting (this chat)** — the deterministic core (above). NOT the approval spine.
- **Approval** — approval→booking→close-loop (`core/requests/*`, `closeMeetingArtifacts`, relay, legacy `approvals`). Desync / relay-drop / "did the colleague get told" lives here.
- **Guard** — the gate stack (`claimChecker`, `securityGate`, `humanGate`, `coordGuard`, `dateVerifier`, `postReply`). Honesty/leak/false-positive + the availability-honesty backstop.
- **Prompt** — the orchestrator systemPrompt: language, scheduling narration, judgment/tone. A rule that belongs in code doesn't go here.
- **Tenancy** — tool descriptions + per-skill prompt sections + de-tenant / learned-preference.

Meeting bug whose real fix is approval/relay → approval; honesty/leak → guard; tone/judgment → prompt; tool-description/routing → tenancy. Hand a paste-block; don't build it here.

Discipline: reproduce → root-cause to `file:line` → chokepoint fix, code-first, ONE source, reduce LOC, no NL regex → `trace` to 100% → propose-first. Check every fix against the 11 rules. You're on MAX — act like it.
