# Path 2 — The Requests Spine (kill all parallel status)

> Owner direction (2026-05-27): "I want to kill all and move to requester. One spine
> to all. We can have tables or tools storing **data** or doing **actions** (dismiss
> events, book a meeting, venue data). But the **backbone** — getting a task, doing
> ping-pong between me and others, summary status, brief, the loop-back — all based
> on `requests`. A request has an ID, connects to the **parent** that asked for it,
> and a **thread id** so it knows where to return. Those other tables shouldn't have
> a resolve status; they have a request. If you want the status, read the request.
> Don't store everything forever — truncate if needed."
>
> Refinement (2026-05-27, after first draft): **Do NOT fold the data into `requests`.**
> The actual ask ("Moshe wants a meeting at 2pm") stays in `approvals` so Maelle can
> show it to the owner and take a counter. The outreach message text ("say hello to
> Moshe") stays in `outreach_jobs` — putting it in `requests` would bloat it into a
> "moonlit" monolith table. The **status, the follow-up timing, and the brief** live on
> the request; the **data and tool activity** stay on their own table. The side tables
> keep their rows — they just lose their *status column*. And: don't delete tables for
> the sake of it. Delete only where keeping back-compat/migration support costs more
> than it's worth. "Kill all" = kill parallel *status*, not kill tables.
> All 8 stages ship together as one release.

## The one idea

`requests` is the **only** place a lifecycle/status lives — and it holds **only**
status (state, timing, brief surfacing, routing, parent link). Everything that is a
back-and-forth — a coordination, an outreach, an approval — has a `request` as its
status row. The **data** (the ask payload, the DM text, slot options, participant
lists, venue rows, calendar event ids) and the **action record** stay in their own
tables/tools (`approvals`, `outreach_jobs`, `coord_jobs`, venues, calendar). Those
tables **keep their rows** but **drop their status column**. To answer "is this open /
who are we waiting on / what happened" you read the linked `request`; to answer "what
exactly did Moshe ask / what did we send" you read the data row it points to. Keeping
the bulk out of `requests` is the whole point — a lean status spine, not a monolith.

A request carries:
- **id** — the unit of work.
- **parent_request_id** — the request (or task) that spawned it. A coordination is a
  parent; each participant DM is a child. The tree *is* the work breakdown.
- **origin_channel + origin_thread_ts** — the **return address**. Where a reply lands,
  where a resolution posts back. Reply routing keys off this, not off table lookups.
- **state** — the universal lifecycle (below).
- **phase** — the kind-specific sub-state (below), still *on the request*.
- **details_json** — the kind-specific data + payload (folds in what coord_jobs /
  outreach_jobs / approvals used to hold separately).

When status lives in exactly one row, "delete the orphan tasks from the DB" can no
longer create a ghost: there is nothing else holding an "I'm still open" signal. The
brief reads that one row. Whack-a-mole ends.

---

## Current state (what the map found — start here, don't re-derive)

- **Readers: already migrated.** `briefs.ts:getRequestsForBrief`, `systemPrompt.ts`
  (`getAwaitingOwnerRequests` / `getOpenRequestsForThread`), and
  `core/requests/resolver.ts` all read `requests` only. No brief/prompt/resolver path
  reads coord_jobs / outreach_jobs for open work.
- **Writers: NOT migrated.** `coord_jobs.status`, `outreach_jobs.status`, and
  `approvals.status` are still authoritative. The state machines write the legacy
  table first; a **cascade** (`updateCoordJob` / `updateOutreachJob` /
  `setApprovalDecision` → `closeRequest`) mirrors it into `requests`. That cascade is
  the bug surface — any terminal path that doesn't run it leaves the request open.
- **Bridge: dual-write, 1:1.** Every coord_job / outreach_job already has a
  `request_id` FK, created atomically in `createCoordJob` / `createOutreachJob`.
  `approvals` has a `request_id` too. So the links exist; we're inverting which side
  is the source of truth.
- **Spine schema is already rich** (`core/requests/types.ts`, `db/requests.ts`):
  6 states — open: `awaiting_owner` / `awaiting_colleague` / `in_flight`; terminal:
  `resolved` / `cancelled` / `expired`. `parent_request_id`, `origin_channel`,
  `origin_thread_ts`, `owner_dm_channel`, `owner_dm_thread_ts`, `next_check_at`,
  `next_check_handler`, `surfaced_count`, `informed`, `details_json`, `outcome_json`
  all exist. Missing: a `phase` column.
- **Timers are tasks today.** `coord_nudge`, `coord_abandon`, `outreach_send`,
  `outreach_expiry`, `outreach_decision`, `approval_expiry`, `approval_reminder` are
  `tasks` rows with dispatchers. The spine already has `next_check_at` +
  `next_check_handler` — designed to absorb these but not yet wired as the driver.

So the work is: **invert ownership, fold data into the request, collapse the timer
tasks into one spine sweep, then drop the legacy tables.**

---

## Target data model

```
request
  id                  TEXT PK          -- req_*
  parent_request_id   TEXT NULL        -- tree link (coord parent → outreach children)
  owner_user_id       TEXT
  kind                TEXT             -- coord | outreach | approval | reminder | follow_up | research | ...
  subkind             TEXT NULL        -- schedule | move | policy_exception | meeting_reschedule | ...
  phase               TEXT NULL        -- kind-namespaced sub-state (NEW). e.g.
                                       --   coord:collecting | coord:resolving | coord:negotiating | coord:waiting_owner
                                       --   outreach:scheduled | outreach:awaiting_reply | outreach:nudged | outreach:no_response
                                       --   approval:awaiting_owner | approval:awaiting_colleague (counter relayed)
  state               TEXT             -- awaiting_owner | awaiting_colleague | in_flight | resolved | cancelled | expired
  subject             TEXT
  requester_slack_id  TEXT NULL        -- who asked (colleague-initiated)
  requester_name      TEXT NULL
  target_slack_id     TEXT NULL        -- who we're talking to (outreach/coord child)
  target_name         TEXT NULL
  origin_channel      TEXT NULL        -- RETURN ADDRESS (where replies land / resolution posts)
  origin_thread_ts    TEXT NULL
  owner_dm_channel    TEXT NULL        -- where to reach the owner about this
  owner_dm_thread_ts  TEXT NULL
  next_check_at       TEXT NULL        -- the single timer (replaces the N task dispatchers)
  next_check_handler  TEXT NULL        -- coord_nudge | coord_abandon | outreach_send | outreach_expiry | expiry | reminder
  expires_at          TEXT NULL
  surfaced_count      INTEGER          -- brief nag throttle
  informed            INTEGER          -- post-closure narration flag
  details_json        TEXT             -- kind-specific DATA + payload (see below)
  outcome_json        TEXT NULL        -- terminal result (event id, booked slot, etc.)
  closure_reason      TEXT NULL
  created_at, updated_at, closed_at
```

`state` answers **"open? who are we blocked on?"** (drives brief + prompt + routing).
`phase` answers **"where in this kind's dance are we?"** (drives the state machine and
dispatcher). Both live on the request — that is the owner's "status under the request."

**`details_json` stays small.** It holds only status-adjacent bookkeeping — the
`phase` parameters, the slot label currently being voted on, nudge/attempt counters,
the `next_check` arming hints. It does **NOT** hold message bodies, ask payloads,
participant rosters, or tool activity. Those stay in the data tables, fetched by join
on `request_id` when (and only when) the owner needs to *see* the content:
- **coord data → `coord_jobs`** (minus its `status`/`winning_slot`-as-status columns):
  `participants[]`, `proposed_slots[]`, `intent`, `existing_event_id`,
  `request_signature`, `duration_min`, `last_calendar_check`, `external_event_id`.
- **outreach data → `outreach_jobs`** (minus `status`): `message`, `dm_message_ts`,
  `dm_channel_id`, `proposed_slots`, `subject_keyword`, `conversation_json`.
- **approval data → `approvals`** (minus `status`): the ask payload ("Moshe wants 2pm",
  slots, `deferred_action`, on_approve callback args) — so Maelle renders the ask and
  the owner can approve / counter.

### The tree makes ping-pong native
A coordination is a **parent** request (`kind=coord`, holds the aggregate status:
collecting→resolving→waiting_owner). Each participant leg that awaits a reply is a
**child** request (`kind=outreach`, `parent_request_id=<coord>`, own `target_slack_id`,
own `origin_thread_ts`) — its `state` is that participant's leg (awaiting_colleague →
resolved when they vote), and its `origin_thread_ts` is the return address for that
person's reply. **The child request carries only the leg's STATUS;** the DM text / slot
offer / their vote content stays in the linked `outreach_jobs`/`coord_jobs` data row.
The parent aggregates child states to advance its own phase. (`parent_request_id`
already exists and is used for this nesting today; we lean on it harder.) Judgment
call to settle at build time: whether every participant leg gets a child request, or
only legs that need independent owner-facing status/routing while simple vote tallies
stay as data in `coord_jobs.participants[]`. Default to child-per-leg only where
routing/timing needs it; don't manufacture rows for nothing.

---

## Stages (build order within ONE release — all 8 ship together)

Owner direction: all 8 land in a single release, not phased ships. The stage numbers
are **build order** (dependency sequence), not separate deliverables. Order by
ascending blast radius: schema → outreach (1:1, partly done) → coord (tree) →
routing → approvals (status-only, light) → timer sweep → strip side-table status →
retention. Dual-write internally during the build so each stage is independently
testable against the verifier, but it all commits + version-bumps once at the end.

### Stage 1 — Schema + spine plumbing
- Add `phase TEXT` to `requests` (idempotent ALTER).
- Indexes: `(owner_user_id, state)`, `(owner_user_id, target_slack_id, state)`,
  `(parent_request_id)`, `(next_check_at)` (for the sweep), `(origin_thread_ts)`.
- Extend `db/requests.ts`: `setPhase`, `getOpenRequestsByHandlerDue(now)`,
  `getOpenRequestsForColleague` (exists), `getChildRequests(parentId)`,
  `getOpenCoordRequests(owner)`, `getCoordRequestsByParticipant(slackId, owner)`.
- No behavior change yet — pure capability.

### Stage 2 — Outreach onto the spine
- `message_colleague` (`skills/outreach.ts`) makes the **request** the source of truth
  for STATUS only (state + phase + timing). The message text, dm ts, proposed_slots,
  conversation history **stay in `outreach_jobs`** (the data row, linked by
  `request_id`). `outreach_jobs.status` is no longer read or written — it's the
  request's job. (Optionally drop the `status` column outright if nothing reads it.)
- Status mapping:
  - `send_at` future → `in_flight`, `phase=outreach:scheduled`,
    `next_check_at=send_at`, `next_check_handler=outreach_send`.
  - sent + await_reply → `awaiting_colleague`, `phase=outreach:awaiting_reply`,
    `next_check_at=deadline`, `next_check_handler=outreach_expiry`.
  - fire-and-forget → `resolved` immediately (`closure_reason=fire_and_forget`).
- Thread continuity (v3.0.8 work already added — `origin_*` anchoring,
  `getOpenRequestsForColleague`) becomes *native*: the request's `origin_thread_ts`
  IS the anchor; delete the bridge cleverness once reads are off `outreach_jobs`.
- Flip `recentOutboundContext` reply matcher to read open `outreach`-kind requests.

### Stage 3 — Coord onto the spine
- `coord/state.ts` / `reply.ts` / `booking.ts` / `approval.ts` write request
  state+phase instead of `coord_jobs.status`. Mapping:
  - collecting/resolving/negotiating → `in_flight` + `phase=coord:<x>`.
  - waiting_owner → `awaiting_owner` + `phase=coord:waiting_owner`.
  - booked → `resolved` (`closure_reason=coord_booked`, `outcome_json.event_id`).
  - cancelled/abandoned → `cancelled`.
- Participant legs become **child requests** (`parent_request_id`) where independent
  routing/status is needed (see tree note). `getActiveCoordJobs`,
  `getCoordJobsByParticipant`, `getPendingRequestCountForColleague`, `getStaleCoordJobs`
  reimplement as `requests` queries (they're status queries — they belong on the spine).
- `get_active_coordinations` tool reads requests for status, joins `coord_jobs` for data.
- coord **data** (slots, winning_slot value, intent, existing_event_id, signature,
  participants) **stays in `coord_jobs`**; only its `status` column stops being
  authoritative (request owns status).

### Stage 4 — Reply routing off the spine (closes deferred bug #7)
- Replace the two parallel matchers (`coordinator.ts` coord-reply +
  `recentOutboundContext` outreach classifier) with **one**: given an inbound from
  `colleagueSlackId`, find open requests via `getOpenRequestsForColleague`, match by
  exact `origin_thread_ts` first, else most-recent open. **Prefer `coord`-kind over
  `outreach`-kind** when both are open for the same colleague (the Isaac bug).
- Single source, thread-keyed, no LLM tiebreak needed for the common case.

### Stage 5 — Approvals: status to the spine, payload stays put
- **Keep `approvals` as the ask-data table** — it holds "Moshe wants a meeting at 2pm",
  the slots, `deferred_action`, the on_approve callback args. This is what Maelle
  renders so the owner can approve or counter. **Do not move this into `requests`.**
  This is NEW code (3.0.x) that was already mostly right — don't break it without need.
- Move only the **status**: the request carries `awaiting_owner` (and
  `awaiting_colleague` when a counter is relayed). `approvals.status` stops being the
  source of truth — `setApprovalDecision` becomes "resolve the linked request + stamp
  the approval's outcome data", not "own the status." `mergeApprovalPayload` (counter
  amendments) stays — it edits the *data*. `getPendingApprovalsBySkillRef` stays as a
  data lookup.
- resolver already reads requests for status and the approval row for payload — this is
  largely confirming the split is clean, not a rewrite. Light touch.

### Stage 6 — One timer sweep replaces the dispatcher zoo
- New `runRequestChecks(now)` in `core/background.ts` tick: select open requests where
  `next_check_at <= now`, switch on `next_check_handler`
  (outreach_send / outreach_expiry / coord_nudge / coord_abandon / expiry /
  approval_reminder), run the handler against the request row, re-arm or close.
- Delete the dispatchers folded in: `coordNudge`, `coordAbandon`, `outreachSend`,
  `outreachExpiry`, `outreachDecision`, `approvalExpiry`, `approvalReminder`.
- `tasks` table **survives** only for work that is *not* a back-and-forth:
  `reminder`, `research`, `routine`, `calendar_fix`, `summary_action_followup`.
  (Judgment boundary — `reminder`/`follow_up` could also become `in_flight` requests;
  defer that call. Anything that pings the owner once and closes can stay a task.)

### Stage 7 — Strip status from the side tables (keep the tables)
- **Do NOT drop `coord_jobs` / `outreach_jobs` / `approvals`.** They stay as data
  tables. Remove (or stop reading/writing) only their **status-bearing columns**:
  `coord_jobs.status` + `winning_slot`-as-status semantics, `outreach_jobs.status` +
  `followup_closed_at`/`reply_deadline` (these become request `state`/`next_check_at`),
  `approvals.status`. Keep `request_id` as the link.
- Delete only **dead code**: status-mutation helpers that nothing calls after stages
  2–5 (`updateCoordJob`'s status-cascade block, the outreach status transitions, the
  `setApprovalDecision` status path). Keep the data getters/setters.
- Owner rule: delete a table/column only if keeping it costs back-compat effort for no
  benefit. If a column is harmless to leave, leave it — don't burn time on removals.
- Backfill: open legacy rows already carry `request_id`; copy their status → the
  request's state/phase once, then the request is authoritative. One-shot, idempotent.

### Stage 8 — Retention / truncation (owner: "don't store everything")
- Sweep in the same tick: terminal requests (`resolved`/`cancelled`/`expired`) older
  than N days (start at 30) → either hard-delete, or strip `details_json`/`outcome_json`
  to a one-line summary and keep the skeleton for history. Keeps the spine small and
  the brief query fast. Child requests of a deleted parent go with it.

---

## What explicitly does NOT move (data / action layer stays)
- **`approvals` / `outreach_jobs` / `coord_jobs` themselves** — they stay as DATA
  tables (ask payload, message text, participants/slots). They only lose *status
  ownership*. This is the core of the owner's refinement: requests holds status, these
  hold the content.
- **Calendar** (`connectors/graph/calendar.ts`) — events, free/busy, booking. An event
  id is *data*; the booking *action* lives here. The request records the outcome.
- **Venues** (`db/venues.ts`) — catalog data.
- **People memory**, **preferences**, **knowledge**, **summaries** — data stores.
- **calendar_issues / dismissals** — issue data + dismiss action. (A dismissal is a
  fact, not a back-and-forth; it doesn't need a request unless it asks the owner.)
- **Tasks that fire-and-close** — reminders, research, routines, calendar_fix.

The test for "is it a request?": *does it involve waiting on a human (owner or
colleague) and looping back?* Yes → request. No → it's data or a one-shot action.

---

## Payoff against today's ghosts
- **Eli** (`req_..._b3w7l`, stuck `awaiting_colleague` after booking): once booking
  resolves the *request* directly (not via a coord_job cascade that didn't run), the
  row closes and the close-loop DM to Eli fires from the resolution. No second table to
  forget.
- **Isaac/Dina/Onn coord** (`i3kb2` + `ti275` still open after tasks were deleted):
  there are no separate tasks holding status to delete — closing the coord *is*
  resolving the parent request, which cascades to its child legs. Nothing orphans.

## Risks / guardrails
- **Dual-write window per stage** — keep legacy writes alive until reads are verified
  on the request, then remove. One kind at a time.
- **Backfill correctness** — open rows at migration must map status→state exactly;
  write a one-shot verifier script (read-only) comparing legacy status vs request state
  before flipping authority.
- **The `phase` enum is kind-namespaced** — never let a coord phase leak onto an
  outreach request; validate in `setPhase`.
- **Reply-routing regression** — Stage 4 is the highest-risk; gate behind a verifier
  that replays recent inbound matches against both old and new matchers before cutover.
- **Typecheck** — project-mode `npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json` after
  every stage (worktree typecheck lies — see SESSION_STARTER).

## Sequencing summary
Build order, one release: 1 schema → 2 outreach → 3 coord → 4 routing →
5 approvals (status-only) → 6 timer sweep → 7 strip side-table status (tables stay) →
8 retention. 2–5 move status ownership onto the spine; 6–8 are the cleanup that's only
safe once 2–5 own their state. Single commit + version bump at the end (via `wrap`).
