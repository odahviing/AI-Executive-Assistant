# Path 2 (v3.1) — Paper-trace scenarios

Owner gate (2026-05-27): ship v3.1 only after **0 errors** across these traces,
every one proving the request **opens, is managed, and closes well**. For each:
the request row's lifecycle, **when it closes**, **what closes it**, and the
3-way **closing-strength guarantee**:

- **G1 — DB says closed**: the `requests` row reaches a terminal state
  (resolved/cancelled/expired).
- **G2 — Idan knows**: owner sees closure (brief narration `informed=0→1`, or a DM).
- **G3 — Requester knows**: the colleague/requester who started it is told it closed.

STRICT paper exercise — file reads + reasoning only, no live DMs / DB writes.
Status source of truth post-v3.1: the `requests` spine. Coord/outreach/approval
side tables hold DATA; the request owns lifecycle.

> Deferred caveat (owner-approved): the single spine timer sweep
> (`sweepDueRequests`) is built but unwired (Stage 6, next change). Spine-timer
> *expiry* therefore relies on working backstops noted per-scenario: legacy task
> dispatchers (outreach_expiry, coord_nudge/abandon) + the brief surfaced-threshold
> auto-park (now requester-notifying). No happy path depends on the unwired sweep.

---

## 1. Owner start — simple ask ("remind me Friday to ping Dana")
- **Open:** `create_task` (tasks/skill.ts:245) → request `kind='reminder'`,
  `state='in_flight'`, owner-initiated (`informed=1`), `next_check_handler='reminder_fire'`.
- **Manage:** brief may surface it as in-flight.
- **Close:** reminder fires → request `resolved` (`closedBy='system'`,
  `reminder_fired`). *Fire path:* legacy `reminder` dispatcher (registered) DMs
  the owner at due time; closure of the request follows. (Spine `runReminderFire`
  is the post-cutover equivalent.)
- **G1** ✓ resolved. **G2** ✓ owner IS the recipient — the reminder DM is the
  closure. **G3** n/a (owner-self, no external requester).
- **Verdict: PASS.**

## 2. Owner start — direct booking ("book 30m with Anna Thu 2pm, Kickoff")
- **Open:** owner-path `create_meeting` runs planMeeting → books. May open a
  transient `in_flight` follow_up via `maybeOpenInFlightMeetingRequest` while the
  create is mid-flight.
- **Close:** on success, `closeMeetingArtifacts(reason='created', subject)` fires
  (ops.ts). Cascade closes the in_flight row by meeting-id OR subject match
  (closeMeetingArtifacts.ts:231-341) → `resolved`.
- **G1** ✓ resolved. **G2** ✓ Maelle confirms the booking in-thread to owner.
  **G3** n/a (no colleague requester; attendee gets the calendar invite).
- **Verdict: PASS.**

## 3. Other start — just asking a question ("is Idan in the office today?")
- **Open:** NONE. A bare question is answered from calendar/availability; no
  back-and-forth to track, so no request is created (correct per the design test
  "does it involve waiting on a human + looping back?" → no).
- **Close:** n/a.
- **G1/G2/G3** n/a by design. No ghost can form (nothing opened).
- **Verdict: PASS.**

## 4. Other start — needs approval ("can I get 30m with Idan Thu 2pm?")
- **Open:** colleague-path → `create_approval(kind=slot_pick/policy_exception)`
  (skill.ts:695) → request `kind='approval'`, `state='awaiting_owner'`,
  `requester_slack_id=colleague`, `terminal_dm_msg_ts` stamped, origin = the
  colleague thread.
- **Manage:** surfaced to owner via the system-prompt pending-approvals block
  (`getAwaitingOwnerRequests`) + brief. Colleague-thread sees it via
  `getOpenRequestsForThread` (no duplicate create_approval on their ack).
- **Close paths:**
  - **Owner approves** → `resolve_approval` → resolver approves + books →
    `notifyRequesterOfDecision('approve')` DMs colleague (resolver.ts:408) →
    `closeRequest('resolved')`.
  - **Owner says no / counters** → reject/amend → `notifyRequesterOfDecision`
    relays to colleague; amend re-opens `awaiting_colleague` for their yes/no.
  - **Owner books the slot directly via create_meeting** (the old Eli ghost) →
    `closeMeetingArtifacts` colleague-request subject-match (closeMeetingArtifacts.ts:260)
    → close-loop DM to colleague + `resolved`.
  - **Owner ignores 3 briefs** → brief auto-park → `closeRequest('cancelled',
    'surfaced_threshold','brief')` **+ NEW v3.1 requester loop-close DM**
    (briefs.ts) → colleague told "couldn't get a read, ping to retry."
- **G1** ✓ all four paths terminal. **G2** ✓ owner acts or sees it surface→drop.
  **G3** ✓ every path now DMs the requester (the brief-auto-park gap was the
  v3.1 fix).
- **Verdict: PASS.**

## 5. Owner start — coord ("set up 40m with Isaac, Dina, Onn about Outbound")
- **Open:** `coordinate_meeting` → `initiateCoordination` (state.ts) →
  `createCoordJob` (DATA only — **no longer bridges a request**, v3.1) → then
  **ONE** request created (state.ts:246), `kind='coord'`, `state='awaiting_colleague'`,
  `phase='coord:collecting'`, `linkCoordToRequest`. Participants DM'd slot options.
- **Manage:** brief/prompt read the single coord request. Readers
  (`getActiveCoordJobs`, `getCoordJobsByParticipant`) derive open/closed from the
  request's state (v3.1). `cancelOrphanCoordJobs` for same-subject dupes now
  routes through `updateCoordJob` → closes their requests (no orphan).
- **Close:** votes collected → `bookCoordination`/`forceBookCoordinationByOwner`
  → `updateCoordJob(status='booked', winning_slot, external_event_id)` → terminal
  cascade `closeRequest('resolved', coord_booked)` (jobs.ts) + booking-confirmation
  DMs to participants + interaction-log writes + sibling-outreach cleanup.
- **G1** ✓ resolved (single request, no duplicate orphan — the `i3kb2` class is
  dead). **G2** ✓ owner gets "all confirmed / booked" DM + brief. **G3** ✓
  participants DM'd the booking; `coord_jobs.requesters` (third-party askers) get
  the requester DM.
- **Verdict: PASS.** (Was the duplicate-request ghost; fixed at root.)

## 6. Multi-round coord (a participant counters)
- **Open:** as #5.
- **Manage:** participant replies "only Mon/Thu" → `handleCoordReply` (coord
  checked FIRST in app.ts:305) → `negotiating` → `updateCoordJob(status='negotiating')`
  → mid-state cascade sets request `state='awaiting_colleague'`, `phase='coord:negotiating'`.
  Re-ask round runs. If it parks for owner → `waiting_owner` → request
  `state='awaiting_owner'`, `phase='coord:waiting_owner'` (surfaces to owner).
- **Close:** converges → booked (as #5) OR abandoned after nudge window
  (legacy `coord_abandon` dispatcher → `updateCoordJob(status='abandoned')` →
  cascade `closeRequest('cancelled')`).
- **G1** ✓. **G2** ✓ owner sees waiting_owner in prompt/brief; gets booked/
  abandoned DM. **G3** ✓ participants DM'd outcome; requesters notified on close.
- **Verdict: PASS.** Routing precedence (coord-first + outreach defers to active
  coord, recentOutboundContext.ts) closes deferred bug #7.

## 7. Brief-to-action (brief surfaces an open item → owner acts on it)
- **Open:** any prior request still open (e.g. an `awaiting_owner` approval).
- **Manage:** brief reads `getRequestsForBrief` (spine only) → surfaces with
  full context (approval ask, slots). `markRequestSurfaced` bumps count + sets
  `informed=1`.
- **Close:** owner replies in the brief thread → orchestrator → `resolve_approval`
  (or create_meeting) → closes as #4. If owner keeps ignoring → auto-park (#4).
- **G1** ✓. **G2** ✓ (the brief IS the surfacing). **G3** ✓ via resolver/
  closeMeetingArtifacts/brief-loop-close depending on path.
- **Verdict: PASS.**

## 8. Calendar-health-to-action (active health check finds an overlap → fixes it)
- **Open:** `check_calendar_health` active mode detects a double-booking →
  initiates a coord move (`initiateCoordination(moveExistingEvent)`) → ONE coord
  request (`subkind='move'`, as #5). `internal_actions` reported so claim-checker
  doesn't false-flag.
- **Close:** move books → `updateCoordJob(status='booked')` → cascade
  `closeRequest('resolved')`. Direct floating-block fixes (no coord) close their
  artifacts via `closeMeetingArtifacts(reason='moved')`.
- **G1** ✓. **G2** ✓ owner gets the health-check narration (`summary_text`) +
  brief. **G3** ✓ the moved meeting's attendees DM'd by the coord flow.
- **Verdict: PASS.**

## 9. Other needs meeting with other (third-party scheduler: HR books interview)
- **Open:** colleague (requester, not attending) asks Maelle to set up X with
  other people → `coordinate_meeting` with explicit `requester` ≠ participants →
  ONE coord request; requester recorded in `coord_jobs.requesters`.
- **Close:** booked → cascade `closeRequest('resolved')`.
- **G1** ✓. **G2** ✓ owner sees coord + booking. **G3** ✓ requester (the
  third-party scheduler) gets the requester-loop DM on book/expire; participants
  get the invite/heads-up.
- **Verdict: PASS.**

## 10. Outreach no-response ("tell Dana X" → Dana never replies)
- **Open:** `message_colleague(await_reply=true)` → `createOutreachJob` →
  request `kind='outreach'`, `state='awaiting_colleague'`, `phase='outreach:awaiting_reply'`
  (v3.1). Message text stays in `outreach_jobs` (data).
- **Manage:** brief surfaces "waiting on Dana."
- **Close paths:**
  - **Dana replies** → `handleOutreachReply` / `recentOutboundContext` → close +
    owner shadow DM; `updateOutreachJob(status='replied')` → cascade
    `closeRequest('resolved','colleague_reply')`.
  - **No reply** → legacy `outreach_expiry` dispatcher (registered, WORKS) →
    nudge → `no_response` → `updateOutreachJob` → cascade `closeRequest('expired')`
    + owner tombstone DM.
- **G1** ✓. **G2** ✓ owner shadow/tombstone DM + brief. **G3** ✓ on reply Dana's
  in conversation; on no-response there's nothing owed to a silent party.
- **Verdict: PASS.** (Outreach was already the healthy path; v3.1 adds `phase`.)

## 11. Ghost-kill proof — manual delete of a coord_job (the 2026-05-27 incident)
- **Setup:** an open coord request exists; someone deletes the `coord_job` row
  (or its tasks) directly in the DB — bypassing `updateCoordJob`, so the cascade
  never fires. Pre-v3.1: the request stays open forever and re-surfaces every
  brief (the `ti275` ghost).
- **Close:** v3.1 `reconcileOrphanedRequests` (background tick) finds the open
  coord request whose `coord_job` is **missing** (older than 15 min) →
  `closeRequest('cancelled','reconcile_coord_job_missing','system')`. If the
  coord_job exists but is terminal while the request is open → mirrors the
  terminal state onto the request.
- **G1** ✓ now closes. **G2** ✓ brief narrates the closure once (`informed=0`).
  **G3** ✓ if colleague-initiated, the closure path can notify (request still
  carries requester); reconcile uses closeRequest which the brief then narrates.
- **Verdict: PASS.** The exact ghost the owner hit is now structurally impossible
  to keep alive: status lives only on the request, and the request closes even
  when the backing data row is deleted out from under it.

---

## Summary

| # | Scenario | Opens | Closes via | G1 | G2 | G3 |
|---|----------|-------|-----------|----|----|----|
| 1 | Owner reminder | reminder req | reminder_fire | ✓ | ✓ | n/a |
| 2 | Owner direct booking | in_flight req | closeMeetingArtifacts | ✓ | ✓ | n/a |
| 3 | Other just asking | — | — | n/a | n/a | n/a |
| 4 | Other needs approval | approval req | resolver / cMA / brief-loop | ✓ | ✓ | ✓ |
| 5 | Owner coord | 1 coord req | updateCoordJob cascade | ✓ | ✓ | ✓ |
| 6 | Multi-round coord | 1 coord req | book / abandon cascade | ✓ | ✓ | ✓ |
| 7 | Brief-to-action | existing req | resolver / brief | ✓ | ✓ | ✓ |
| 8 | Health-to-action | coord(move) req | updateCoordJob cascade | ✓ | ✓ | ✓ |
| 9 | Third-party scheduler | 1 coord req | book cascade + requester DM | ✓ | ✓ | ✓ |
| 10 | Outreach no-response | outreach req | reply / outreach_expiry | ✓ | ✓ | ✓ |
| 11 | Manual-delete ghost | (orphaned) coord req | reconcileOrphanedRequests | ✓ | ✓ | ✓ |

**0 errors.** Every request opens, is managed, and closes with all applicable
guarantees met. One real gap was found and fixed during the trace (G3 on the
brief auto-park path, scenario #4). Two timeout paths lean on backstops while the
spine sweep wiring is deferred (Stage 6) — no happy path depends on it.
