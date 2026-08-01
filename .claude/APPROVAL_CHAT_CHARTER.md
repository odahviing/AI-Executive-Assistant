# Approval-spine chat — charter + current state

**Starter for the dedicated approval chat. Read this whole file first.**
Supersedes `.claude/APPROVAL_SPINE_HANDOFF.md` (that described the PRE-collapse
patch-on-patch state; the collapse shipped in 3.4.6 — keep it only as history).

## What this chat owns

The **approval → booking → close-loop spine**: how an owner decision is raised
(`create_approval`), resolved (`resolveRequest`), replayed
(`deferredActionReplay`), and looped back to the requester
(`notifyRequesterOfDecision`) — plus the **owner daily decision thread** and the
resolution surfaces (emoji reaction, Module D content-attribution).

NOT this chat:
- **Meeting planner** — `create_meeting` / `find_available_slots` / move gates /
  the WE timezone spine → **meeting chat**.
- **Orchestrator system prompt + tool-selection guidance** (which tool Sonnet
  reaches for) → **prompt chat**.
- **Output guards** (claim-checker, date-verifier, coordGuard, humanGate) →
  **guard chat**.

At wrap, several chats share the tree — reconcile via `git` working-tree diff.

## The rules

**Goal:** own the approval → booking → close-loop spine so every owner decision is
raised for the right reason, decided by Idan, replayed faithfully, and looped back
to the requester — exactly once.

### Group A — What an approval IS (owner rules; never violate)

- **A1. An approval is a DEVIATION from normal work.** Raise one ONLY for
  something that breaks a rule or needs owner-only judgment. If the action is
  already allowed, just DO it — never ask Idan to approve the permitted. An
  approval for allowed work is a bug.
- **A2. Every approval carries its REASON.** State, in the ask, which rule broke /
  what the issue is. Idan decides on DATA, not gut — if you came to him you had a
  reason, so make it explicit. A reason-less approval is a bug.
- **A3. Idan is the boss; his resolution may differ WILDLY from the request.** In
  the approval phase he can do anything — book 3am, override everyone, "fire the
  whole team." Maelle records the DECISION and adapts the booking + close-loop to
  it; she NEVER forces the outcome back toward the original request.
- **A4. Approval is BI-DIRECTIONAL — a discussion, not a one-way ask.** If we
  raise something to Idan, the requester expects to hear how it lands. Every
  approval loops back to the requester with the real outcome — approved /
  rejected / delayed / countered — never left hanging, never the wrong outcome.

### Group B — One spine (structural; never violate)

- **B1. ONE approval spine — the `requests` table.** Every approval, from every
  path, rides the same spine: one lifecycle (`state` + `next_check` +
  `closeRequest`), one resolver, one close-loop. NO separate or parallel approval
  flows; NO side-table lifecycle (`outreach_jobs` and friends are payload/detail,
  not state — the lifecycle + timers live on the request).
- **B2. Replay from the structured request — don't re-derive.** On owner
  resolution the booking REPLAYS the request's stored action (subject + attendees
  + time preserved), never leaving Sonnet to re-book fresh from thread context
  (that's how subject/attendees/time drift). A meeting approval is always
  structured (`policy_exception` + `create_meeting`), never `freeform`.

### Group C — How we work (process; the code rules)

- **C1. Propose-first, NEVER auto-fix.** An explicit per-item build word ("go" /
  "fix it" / "build it" on THAT item) = build it. A bare "yes/ok" with no item
  reference is ambiguous → ask. "explain" / "are you sure?" = revision, not a
  build signal.
- **C2. Code-first.** Fix at the core: a chokepoint guard, a return-value the
  model reacts to, a tool that owns the decision. The prompt is a LAST resort —
  judgment / tone / format / language only, never to enforce what code can.
- **C3. No NL regex — Maelle is multilingual.** Meaning → a Haiku classifier;
  language/script → Unicode-block detection; state → a structured field / enum.
  Regex only on structured strings (ids `req_…`, ISO datetimes, emails, slack_ids).
- **C4. Reuse before add.** No new spine, no parallel state, no duplicate flow, no
  dead code. Reduce LOC — replace a path, delete the old one. A fix that lets us
  DELETE a mechanism beats one that adds a 13th.
- **C5. Prove the root — don't assume.** Read the code + logs
  (`powershell -File scripts/vm-logs.ps1 [term] [lines]` — the local `logs/`
  dir is STALE since the 2026-07-31 VM cutover; an empty result or a reader
  error means UNREACHABLE, not absent), cite `file:line`. Reads (log grep,
  `node scripts/db-query.cjs`, code) are free — verify, never ask permission to.
- **C6. Wrap/version is the OWNER's call.** Never bump `package.json` / commit
  without an explicit ship word. Typecheck must pass before "done." Paper-trace
  every build (100% bar; a failing row means not done).
- **C7. Shell:** never `cd`-prefix, never chain `;`/`&&`; one logical command per
  Bash call (see `CLAUDE.md`).

## Architecture NOW (as of ~3.6.0 — verify against code, this drifts)

- **Approvals ARE requests.** The `requests` spine (`src/db/requests.ts`,
  `src/core/requests/`) is the ONE lifecycle: `state`
  (awaiting_owner / awaiting_colleague / in_flight / resolved / cancelled /
  expired), `next_check_at` + `next_check_handler` timers, `closeRequest` closure
  + cascade. The legacy `approvals` table was **DROPPED** (3.4.6) — `db/approvals.ts`
  is gone.
- **coord subsystem REMOVED (3.5.0).** No `coordinate_meeting`, no
  `slot_pick`/`calendar_conflict` subkinds, no coord booking handler,
  no `resolveSlotPickApproval`. Multi-attendee meetings = `create_meeting` with
  attendees. Current approval subkinds: `policy_exception`, `freeform`
  (+ `duration_override`, `unknown_person`).
- **Structured booking-approval = `policy_exception`.** `create_approval(policy_exception)`
  with full `{subject,start,end,attendees}` auto-stamps
  `deferred_action = {tool:'create_meeting', args}`. On approve,
  `runApproveCallback` REPLAYS the exact args (subject/attendees/time preserved) —
  the hard approve→book link is `_fulfilling_request_id` stamped into the replay
  + a **tier-0 skip** in `closeMeetingArtifacts` (the resolver owns close+relay;
  the cascade skips that request). `freeform` = non-booking yes/no only; a meeting
  booking must NEVER be freeform (see open items).
- **One requester relay** (`notifyRequesterOfDecision`), always threaded into
  `origin_thread_ts` (MPIM channel or 1:1 DM), carries the **booked time+subject**
  from `deferred_action.args`, gated on `requester_notified_at`
  (single-notification). `closeMeetingArtifacts` is the non-resolver fallback
  (external-id / meeting-id / thread-ts match; the fragile exact-subject tier was
  deleted).
- **Owner daily decision thread** (`src/utils/ownerDailyThread.ts` +
  `owner_daily_threads` table): ONE lazily-created thread per day holds all owner
  approval asks + outcomes; day-key via `getEffectiveToday` (honors
  `day_boundary_hour`). Emoji ✅/❌ resolves per-message (widened emoji sets in
  `app.ts`); typed replies are content-attributed
  (`threadBoundApprovalAutoResolve`). **Module D** silent-resolve is narrowed to
  **owner-internal approvals only** — colleague-requested approvals run the full
  orchestrator turn so Maelle narrates (and the emoji path leaves a history
  memory record). Approvals-only — brief/health/shadows stay separate.
- **Double-notify guards** (turn-scoped, no clock, drop-safe): forward
  (resolve→then message_colleague to the same requester suppressed) + reverse
  (message_colleague→then resolver relay skipped). Keyed on confirmed sends.
- **WE preview**: `buildConsequenceText` renders the owner approval preview via
  `renderWeDualClock` when the owner is traveling (matches the post-approve
  booked-confirmation); `resolveConsequenceTravel` supplies the async trip
  context. Off-trip / non-time tools unchanged.
- **Reschedule "checking"**: a colleague "let me check / come back to you" →
  status `checking` → keep the request open + re-ask ONCE at +24h
  (`reschedule_reask` handler) → then re-arm to `outreach_expiry`. Never a decline.
- **Ping-pong** amend cap = 3 rounds.

## Shipped this session (approval-spine slice, 3.4.6 → 3.6.0)
- 3.4.6 spine collapse: `_fulfilling_request_id` + tier-0; deleted
  holdForFulfillingAction + 4h timer + exact-subject match + `db/approvals.ts` +
  the table; owner daily decision thread; unified threaded relay.
- Double-notify guards (forward + reverse) + emoji-path memory record.
- Module D narrowed to owner-internal (colleague approvals narrate).
- Colleague-move gate rewrite (attendee-membership + other-attendee free/busy +
  external-attendee escalation + specific reasons) — in `ops.ts` (meeting-owned
  file, built here by owner direction).
- WE dual-clock approval preview.
- Reschedule `checking` status + `reschedule_reask` timer.

## Open / routed elsewhere (track, do NOT rebuild here)
- **WE tz-binding at create** (`start_drift`: naive datetime bound to travel tz →
  7h off) → meeting/WE chat.
- **Double-create hardening** (`findDuplicateEvent` drift-robust +
  `created_but_drift` reconcile-not-recreate) → meeting chat.
- **Freeform-routing** (a colleague meeting request must go via `create_meeting`
  → `policy_exception`, never a `freeform` approval) → prompt chat.
- **Ayala language-pref mismatch** (relay language vs the message language) —
  DEFERRED, separate big change. Do NOT touch.

## Key files
`src/core/requests/{resolver,runner,closeRequest,deferredActionReplay,types}.ts` ·
`src/db/requests.ts` · `src/db/jobs.ts` (outreach detail + `getOutreachJobByRequestId`) ·
`src/core/approvals/approvalCallbacks.ts` (`buildConsequenceText`,
`resolveConsequenceTravel`, `mergeAmendIntoApprove`, `extractCallbacks`) ·
`src/tasks/skill.ts` (`create_approval` / `resolve_approval`) ·
`src/utils/{ownerDailyThread,threadBoundApprovalAutoResolve,closeMeetingArtifacts}.ts` ·
`src/connectors/slack/app.ts` (emoji-reaction resolve + Module D call site) ·
`src/skills/meetingReschedule.ts`.
