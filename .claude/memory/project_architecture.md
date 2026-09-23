---
name: Maelle Architecture
description: Deep architecture reference — directory layout, orchestrator loop, requests spine, output gates, transports, DB schema
type: project
---

**Canonical architecture memory:** maintain architecture facts here; other memory locations link here. Historical copies belong in archives, never a second current authority. Verify relevant code before using dated facts.

Deep architecture reference for Maelle, originally rewritten 2026-08-03 and reconciled against current source during V5 readiness. The `version` field in `package.json` identifies the checkout version, not proof of deployment; `CHANGELOG.md` is the canonical version-by-version history. Dated counts and line numbers are observations, not current inventory guarantees.

**Reference layers:** `.claude/SESSION_STARTER.md` carries operational orientation and `.claude/ARCHITECTURE_MAP.md` the diagram; this file maps implementation. Lane charters own rules. Paths below identify current implementations, not a guarantee that every caller uses them: verify producers and consumers in the tree before changing a shared behavior.

## Directory layout — verify before assuming "four layers"

The repo is NOT literally four top-level directories. `src/` has twelve: `config/ connections/ connectors/ core/ db/ llm/ memory/ skills/ tasks/ utils/ vision/ voice/`, plus `index.ts`. The "four-layer model" earlier docs described is a MENTAL GROUPING that still holds if you sort those twelve into it:

- **Core (always-on engine):** `core/` (orchestrator, requests spine, background tick, social state machine, thread actions), `tasks/` (the task ledger + dispatchers + routines), `db/` (schema + per-table helpers), `memory/` (person-memory capture + booking record), `llm/` (model/client selection).
- **Skills (togglable capability modules):** `skills/` — one class per capability, loaded via YAML toggle.
- **Connections + connectors (transport):** `connections/` (outbound `Connection` interface + registry + per-transport senders), `connectors/` (inbound handlers + non-messaging adapters: Slack Bolt app, email poll, Microsoft Graph).
- **Utils (cross-cutting):** `utils/` (output gates, scheduling rules, formatters, rate limiting), plus the two I/O adapters `voice/` and `vision/` which don't fit any of the other three.

Treat this as a lens, not a literal directory contract — `config/` (profile loader) doesn't fit any of the four cleanly either, and that's fine.

---

**Delivery boundaries:** `src/connections/{types,registry}.ts` defines outbound `Connection` and `SendResult`; `ok: true` can still carry `attachments_failed`. Caller-specific evidence matters: `src/core/requests/requesterRelay.ts` persists failed versus unconfirmed relay outcomes on the request and retries only confirmed-not-sent failures; it never replays the action. `src/connectors/slack/postReply.ts`, `src/tasks/dispatchers/routine.ts` and `src/core/requests/runner.ts` advance news history through `src/skills/news.ts` only after confirmed cited text delivery. These are existing per-path contracts, not one durable delivery authority. Slack audience eligibility and history remain `src/connections/slack/eligibility.ts` and `src/connectors/slack/threadHistory.ts`.
## The orchestrator turn loop

`src/core/orchestrator/index.ts` — `runOrchestrator()` (line 213) wraps everything in a per-turn `AsyncLocalStorage` cache (`withTurnCache`, `utils/turnCache.ts`) and delegates to `runOrchestratorImpl` (line 225), which:

1. Calls `buildTurnContext(input)` (`core/orchestrator/buildTurnContext.ts:17`) to assemble the system prompt (`systemPrompt.ts`), the scope-filtered tool list, the model, and the social directive.
2. Runs a `while (iteration < MAX_ITERATIONS)` loop (`MAX_ITERATIONS = 10`, line 326) calling Claude (`callClaude`, `turnHelpers.ts`) with `thinking: { type: 'adaptive' }, output_config: { effort: 'high' }` (line 364-365) — the Sonnet-5 "adaptive thinking" retry that restored tool-reaching after the thinking-disabled regression (see `llm/models.ts` below).
3. For each `tool_use` block, dispatches through `executeSkillTool` (`skills/registry.ts`), with several deterministic, code-level guards sitting IN the loop, not in a gate afterward:
   - **Same-turn idempotency**: `message_colleague` twice to the same colleague (line 500-520) and `delete_meeting` twice on the same event id (line 553-574) are both short-circuited with an explicit `_note` so the model narrates honestly instead of claiming a second action.
   - **Reverse-order double-notify guard** (v3.4.7): if `resolve_approval` already relayed an outcome to a requester this turn, a later `message_colleague` to that same person is suppressed (`relayedRequestersThisTurn`, line 527-545).
   - **Colleague rate limiting** (line 577+): `utils/rateLimit.ts` checks `colleague_any_tool` per `userId:threadTs`; over budget → the tool call is deflected with a synthetic "let me check with the owner" result, never a throw.
   - **Tool-call cache**: `utils/toolCallCache.ts` — a write within 60s or a read within 5s of an identical call can return the cached result instead of re-firing. The key includes owner/thread/tool/args plus authenticated caller, role, authority, surface, channel and group context. Preference editing bypasses it. This process-local cache does not provide durable write idempotency across restart.
   - **`deferred_action_hint` capture-and-attach**: a meeting tool's `rule_violation` result stashes the hint (line 956-972); a later `create_approval(kind=policy_exception)` this same turn auto-attaches it to the payload (line 624-648) — the "redirect-token" pattern that lets the resolver replay the exact original booking call on owner approve.
   - **Mutation tape** (`mutationActions`) and **unresolved work collection** (`pendingTurnWork`) feed outcome checking and end-of-turn coda eligibility. Matching successful retries discharge only their own work; unrelated pending work remains.
   - **`maybeOpenInFlightMeetingRequest`** (line 1047-1060, `core/requests/maybeOpenInFlightMeetingRequest.ts`) — opens a request-spine row when owner-initiated meeting work spills past the current turn (a rule violation, an unresolved pick), purely an orchestrator-level tracking hook, no new tool.
4. No LLM "recovery pass" exists any more (deleted v2.8.1) — an empty `finalReply` after real tool activity falls through to a deterministic verb-mapped confirmation (`toolCallSummaries`), never a second speculative Sonnet call.

`OrchestratorInput` (line 13-130) and `OrchestratorOutput` (line 132-206) are the two shapes every caller (Slack, email, the requests-spine research runner, the background brief) constructs and consumes — this is the one entry point into "have Maelle think about something," system-generated calls included (`interactive: false` suppresses the social coda for a one-way report).

---

## Multi-tenancy

One deployment can host several executives. Each tenant is a YAML file at `config/users/<name>.yaml`, validated against `UserProfileSchema` in `src/config/userProfile.ts:79` (zod). Required fields: `user.name` (a real first+last name, regex-enforced), `user.email`, `user.timezone`, `user.slack_user_id` (`^U[A-Z0-9]+$`), and `assistant.slack.{bot_token,app_token,signing_secret}` — one Slack **app** per assistant identity, not one app serving several bots. Everything else (`schedule`, `meetings`, `categories`, `behavior`, `skills`, `channels`, `advanced`) has a default, so a ~15-line profile boots.

- `user.whatsapp_phone` (line 94) is optional and its presence is the on/off switch for the WhatsApp transport for that profile (see Transport layer below).
- `channels.email` (line 483+) carries the mailbox config plus `owner_aliases` (line 512) — additional addresses that count as "the owner" for the email sender gate.
- The **connection registry** (`connections/registry.ts`) is itself a `Map<profileId, Map<ConnectionId, Connection>>` (line 16) — every transport is registered per-profile at startup, so profile A having Slack+email and profile B being Slack-only can never collide.
- `skills/registry.ts`'s `getActiveSkills(profile)` reads `profile.skills` per call — no shared/global skill state between tenants.
- **Preferences have competing stores, not one merged authority:** `src/core/assistant.ts` exposes `update_my_preferences` through `src/utils/skillPreferences.ts`, storing free-text `config/users/<first-name>_prefs/<skill>.md`. `PREF_INJECTION_SITE` names primary readers; summary, news and brief composers also read their skill text. The LLM interprets that text; code does not parse it into rules. `manage_preference` still uses SQLite `user_preferences` via `src/db/preferences.ts`, with a prompt catalog and recall tool; `src/skills/summary.ts` also reads those rows. YAML in `src/config/userProfile.ts` remains configuration. A change must identify its writer and actual readers, not assume these stores agree or authorize a migration.

---

## The requests spine — the async work-item state machine

`src/core/requests/types.ts` defines request states; `src/db/requests.ts` persists them; `src/core/requests/{resolver,closeRequest,runner,deferredActionReplay}.ts` execute decisions, closure and timers. The `requests` table owns approval/outreach/reminder/follow-up/research/social-outreach lifecycles and logged activity, not all scheduled work: `src/tasks/{index,runner,routineMaterializer}.ts` and the `routines` store still own task visibility and recurring materialization/dispatch (Task pipeline below).

**`RequestKind`** (types.ts:20-26): `approval | outreach | reminder | follow_up | research | social_outreach`.

**`RequestState`** (types.ts:34-46) — the actual state machine: `awaiting_owner → awaiting_colleague ⇄ (via amend) → resolved | cancelled | expired`. `in_flight` covers scheduled-but-not-yet-fired work (a future outreach send, a research run in progress). **`logged`** (added v4.5.4) is a FIFTH terminal state, orthogonal to the decision lifecycle above: born terminal, never awaiting anyone, written by `logActivity.ts` for an outward-effect action that needed no owner decision (a booking, a move, a colleague DM, a finished research run) purely so it's recallable later. `getRequestsForBrief` and `closeRequest`'s terminal guard both special-case it; two thread-status readers (`getLatestRequestForThread`, `getOpenRequestsForThread`) exclude it explicitly so an activity row can never be mistaken for a colleague's own pending request. `activityRevertibility.ts` is a small declarative table, keyed by tool name, saying which `logged` kinds can actually be undone (a move, create, or floating-block booking) versus which can't (a cancel — Graph already emailed everyone). Eligibility (v4.5.6) is no longer a time-since-action TTL — it keys on whether the event's own current date is still upcoming, so an old mistake on a still-future meeting stays fixable and a recent one on an already-passed meeting doesn't. `revert_last_auto_move` (still that name; the capability is wider) can now target a specific past action by id (`getRevertibleActivityById`), not only the single most recent row — a bare "undo that" with nothing named stays bounded to the last 30 days, naming something specific has no limit.

**`NextCheckHandler`** in `src/core/requests/types.ts`: each request owns its timer. `runner.ts` serializes due dispatch with fresh-state checks; `requester_relay_retry` also admits terminal rows retaining an exact failed outcome message. Confirmed-not-sent delivery retries never replay the action; unknown receipts remain unconfirmed.

Automatic move FYIs finish on confirmed delivery; explicit reply-required checks remain timed. Counteroffers needing an owner decision use `createApprovalRequest` with an atomic replacement of the source outreach, preserving the two-pending-request limit; unanswered owner approvals close after two delivered briefings.

**`closeRequest()`** (`closeRequest.ts:49-133`) is the ONLY terminal-state writer — idempotent (no-op on an already-terminal row, line 54-59), cascades to children unless `skipChildren` (depth-1 only, avoids infinite loops on nested structures), clears the row's own timer, and writes one `audit_log` row per closure. Every other closer in the codebase (the resolver, the runner's expiry handlers, a meeting-mutation cascade, an outreach reply handler) calls through this function rather than writing `state` directly — convention, not a schema constraint.

**`resolveRequest()`** in `src/core/requests/resolver.ts` persists the exact owner decision before replay. Its shared `withRequestLock` also serializes timers, scanners and brief closure, rejecting actual nested cycles while permitting unrelated requests. Registered action replay uses concrete completed/tracked/failed outcomes; uncertain calendar writes get safe exact-ID readback and otherwise close as attempted/unconfirmed. Repeated internal refusals require requester confirmation and preserve refusal history on every owner delivery.

**Nothing on this table is pruned by age.** `reconcile.ts`'s `pruneOldTerminalRequests()` (deleted terminal rows older than 30 days, called from the background tick) was DELETED OUTRIGHT in v4.5.4, owner's explicit ruling — the requests table now keeps every row forever; a query orders newest-to-oldest instead of a retention window doing the forgetting.

**What no longer exists on this spine, confirmed by grep:** `multi_coord_jobs`, `coordination_jobs` (dropped tables, `db/client.ts:201-202`), `src/core/approvals/{resolver,orphanBackfill,coordBookingHandler}.ts`, `src/skills/meetings/coord/*`, `src/utils/coordGuard.ts`, `src/skills/research.ts`, `src/connections/router.ts` — zero hits in `src/` for any of them except historical comments explaining that they were removed (e.g. `resolver.ts:2`).

---

## Output-time security posture — the gate stack

`src/utils/guards/runOutputGates.ts` is where postReply's gate POLICY lives (extracted from `connectors/slack/postReply.ts`, which still owns pure delivery — history save, threading, the ack reaction). Three entry points:

1. **`runOutputGates(draft, ctx)`** (line 180) — the main stack.
2. **`runCodaGates(coda, ctx)`** (line 861) — a separate, much smaller gate for the social coda (see Social engine below): detect-only, fails CLOSED (drop the coda) rather than open, and never rewrites.
3. **`runEmailLegGates`** (line 746) — a third leg for the email transport, not a third value of the Slack two-axis test below.

**The gate policy is two axes, not one role check** (line 200-250, this is the load-bearing design decision documented in the file itself): `ownerIsActing` (`senderId === profile.user.slack_user_id`, line 249) decides whether the phantom-action honesty check runs; `colleagueReadable` (`role !== 'owner' || isOwnerInGroup === true`, line 250) decides whether the leak-scrub and the colleague voice frame run. They coincide in a 1:1 DM but diverge in a group DM or a channel — which is exactly the seam a single combined test used to miss (a channel had neither `role==='owner'` nor `isOwnerInGroup`, so the honesty check silently never ran there until this was fixed).

**Owner-private leg** (a 1:1 DM only the owner reads): claim-check + `humanGate('owner')` + date-verify, probed concurrently first and falling back to the exact serial chain only if any flags (a latency optimization documented at line 318-376).

**Colleague-readable leg** (a colleague DM, a channel, or a group DM): claim-check (only if the owner is acting) → security gate (leak filter + identity-spoof) → `humanGate('internal')` → date-verify LAST (line 377-666) — date-verify runs last on purpose because it's the only gate whose subject a REWRITER can introduce (a rewritten sentence could contain a new weekday word).

**Email leg** (`runEmailLegGates`, line 746): claim-check (unconditional — the sender gate upstream already restricts this whole leg to the owner) → `humanGate('external')` → date-verify (mandatory: a forwarded scheduling reply is almost entirely date claims). Deliberately skips the availability floor and the security gate — both assume Slack-specific state that doesn't exist on this leg (documented at line 701-729).

**The gate primitives themselves**, dynamically imported as needed:
- `claimChecker.ts` — narrow JSON classifier for false action claims ("I sent it" when no tool fired), owner-path only; remedy is a tool-less "own the miss" rewrite, never a re-run of the orchestrator.
- `dateVerifier.ts` — language-agnostic weekday/date mismatch detection (Haiku extracts pairs, code judges against a 14-day lookup, code performs the literal swap).
- `humanGate.ts` — voice/persona consistency (no "I have a backend issue" self-as-infrastructure framing, no mechanical refusal phrasing), runs on both owner and colleague drafts.
- `securityGate.ts` — colleague-facing leak filter (regex triggers + Haiku rewriter) plus the identity-spoof check (is the sender claiming to be someone else).
- `addresseeGate.ts` — MPIM "is this message even for Maelle" classifier (Haiku), fast-pathed by an explicit @-mention.
- `imageGuard.ts` — image-text injection scanner used by Slack image ingestion; colleague images with rejected or unavailable safety verdicts are dropped. This is an inbound check, not an output gate.
- `availabilityPreCheck.ts` / `availabilityGate.ts` — the "don't eyeball free/busy" fix: a colleague-path availability question runs the SAME `checkSlot` rule engine the booking path runs, so a narrated verdict can never disagree with what booking would actually do.

**Failure behavior is path-specific.** Ordinary replies preserve the existing owner/colleague fallback distinction in `humanGate`; a fallback that may keep a reply is not a clear check for an optional coda. `runCodaGates` requests an actual clear human verdict and drops flagged, malformed or unavailable results without rewriting. `runOutputGates` logs `Output gate policy` (`ownerIsActing`, `colleagueReadable`, `audience`) for Slack and the fixed email leg before their checks; this is source-level observability, not proof of live logging.

**Tool-level defense in depth**, in `skills/registry.ts`:
- `COLLEAGUE_ALLOWED_TOOLS` (line 368-450) — the positive allowlist a colleague-path Sonnet ever sees.
- `CHANNEL_TOOL_CLAMP` (line 276-280) — a transport-keyed ceiling; today only `email: [find_available_slots, create_meeting, get_person_memory, log_interaction]`, because the email sender gate is a spoofable From-header compare and this is the write-side backstop.
- `executeSkillTool`'s chokepoint (line 682-793) re-applies BOTH allowlists at dispatch time, independent of what got shipped to the model — a defense-in-depth pairing against a scope-map gap ever shipping a tool by accident (documented via the `web_research` incident it was written to prevent).
- `WRITE_TOOLS` (line 477-498) is the single source of "is this tool a mutation," consumed by the abort-if-safe inbound queue, the date-verifier retry's `proseOnly` strip, and the ack-guard.

---

## Approvals / requests flow, end to end

1. A tool call (owner or colleague path) hits a rule and returns `rule_violation` with a `_deferred_action_hint`, OR the model calls `create_approval` directly (`tasks/skill.ts`).
2. The orchestrator loop auto-attaches the captured hint to the approval payload (`core/orchestrator/index.ts:lastDeferredActionHint`).
3. `createApprovalRequest()` in `src/tasks/skill.ts` persists the approval via `src/db/requests.ts`; `src/core/approvals/approvalCallbacks.ts::extractCallbacks` reads callbacks and bridges legacy deferred-action details. The old `approvals` table is not the authority.
4. The owner sees it in his **owner daily decision thread** (`utils/ownerDailyThread.ts`, `owner_daily_threads` table, `db/client.ts:945-952`) — one lazily-created thread per owner per effective day, holding every approval ask that day.
5. Owner reacts (✅/❌) or replies in chat → `resolve_approval` → `resolveRequest()` (`resolver.ts:228`).
6. `src/core/requests/resolver.ts::runApproveCallback` calls `deferredActionReplay.ts::runDeferredAction`, which dispatches through `src/skills/registry.ts::executeApprovedSkillTool`. Existing completed/tracked/failed results distinguish execution from scheduled work. Replay preserves origin scope and fulfillment identity. Failed replay can remain pending; uncertain effects close through `closeUnconfirmedExecution` as attempted/unconfirmed, with truthful relay. A resolved decision does not imply a confirmed side effect.
7. `closeRequest()` fires, the requester (if any) is notified via `notifyRequesterOfDecision()` — composed as free text by an LLM for language-correctness, with machine-decided values (times, durations) PINNED verbatim so translation can't drift a number (resolver.ts:1246-1294).
8. If nobody ever answers, `runner.ts`'s `runApprovalReminder` nags once at the midpoint (respecting the owner's work hours via `workHours.ts:workTimeBaseFromNow`), then `runExpiry` closes the row as `expired` and tells BOTH sides the truthful story of who actually went quiet (read off `state` at fire time, not off `kind` — an amended request sits on the colleague, not the owner, and the copy has to say so).

---

## Scheduling / booking engine

- **`skills/meetings.ts`** — `MeetingsSkill`, the single skill owning every calendar-touching tool (`get_calendar`, `find_available_slots`, `create_meeting`, `move_meeting`, `update_meeting`, `delete_meeting`, `check_join_availability`, `check_calendar_health`, `book_floating_block`, `set_event_category`, `manage_calendar_issue`, `set_work_schedule_override`, `get_work_schedule_overrides`, `hold_slot`, `revert_last_auto_move`, `find_venue` — tool list read directly from `getTools()`, `meetings.ts:36-120+`). Delegates direct-op handlers to a private `ops` instance (the former `SchedulingSkill`, `skills/meetings/ops.ts`).
- **`skills/meetings/planMeeting.ts`** — the one pipeline every scheduling intent (`book | move | cancel | find_slots`) flows through: load state → detect/reuse category → resolve location → check rules → decide action. Returns one of a fixed set of plan actions (`book`, `find_slots`, `confirm_override`, `escalate_approval`, `decline_as_attendee`, `refuse_not_owners`) — no free-text branching inside the pipeline (header comment, planMeeting.ts:1-35).
- **`utils/scheduleRules.ts`** — `checkSlot()` (line 745) is the ONE "is this slot OK?" validator; both the slot finder and the direct booking path call it, so they can never disagree.
- **Timezones have separate authorities:** owner base is `src/config/userProfile.ts` YAML; `src/db/scheduleOverrides.ts` stores dated overrides; `src/utils/workHours.ts::{getEffectiveWorkDay,getEffectiveWorkDayForInstant}` resolves owner work days/instants. Person base and provenance live in `src/db/people.ts`; `getEffectiveTimezoneById` returns the permanent zone plus a temporary divergence signal, and `getTravelRecordById` supplies travel separately. `src/utils/attendeeAvailability.ts` and `src/skills/meetings/planMeeting.ts` consume these for attendee calculations; temporary evidence is not a replacement base zone. Choose owner/person and date/instant context before using a raw timezone field.
- **`utils/weTimeResolver.ts`** — the away-day dual-clock renderer (kept from the WE spine even though the booking mechanism itself moved to per-date overrides).
- Supporting: `utils/floatingBlocks.ts` separates daily-object identity from automatic movability: another human attendee makes the object fixed. Movers consume durable event-specific decisions from `db/calendarIssues.ts`; approved/dismissed decisions do not expire. Other helpers: `utils/rebalanceFloatingBlocks.ts`, `utils/calendarDensity.ts`, `utils/categoryRules.ts`, `utils/meetingProtection.ts`, `utils/attendeeAvailability.ts`.
- **`connectors/graph/calendar.ts`** is a 4-line barrel (`export * from './calendarTypes' / './calendarReads' / './findAvailableSlots' / './calendarMutations'`) — the Outlook/Graph backend, not a messaging `Connection`. `calendarCache.ts` sits alongside it.

---

## Transport layer — `connections/` (outbound) + `connectors/` (inbound)

**`connections/types.ts`** defines the `Connection` interface every transport implements: `sendDirect`, `sendBroadcast`, `sendGroupConversation`, `postToChannel`, `findUserByName`, `findChannelByName`, plus optional transport capabilities. `SendResult` is the shared delivery-result shape. Skills send messages through this interface and `connections/registry.ts`, never directly through `connectors/slack/*`; calendar and other service adapters remain separate imports.

**`connections/registry.ts`** — a per-profile `Map<ConnectionId, Connection>` (line 16); `registerConnection` / `getConnection` / `listConnections`. There is **no `connections/router.ts`** in the current tree (zero hits — confirmed removed) — routing "which transport does a reply go out on" is handled by callers passing the turn's `inboundConnectionId` through and calling `getConnection(profileId, channel)` directly, not by a separate policy-routing file.

**Slack** (the primary, fully-live transport):
- Inbound: `connectors/slack/app.ts` (Bolt Socket Mode app) + `connectors/slack/app/{context,handlers,processMessage,helpers,fileIngestion}.ts`. `processMessage.ts` derives `senderRole` from the authenticated Slack sender (`getSenderRole`) and CLAMPS it to `'colleague'` in any MPIM, any channel, or colleague-test mode (line 128-139) — this clamp is the security boundary the output gates' `ownerIsActing`/`colleagueReadable` axes are built on top of.
- Outbound: `connections/slack/index.ts` (`SlackConnection`) + `connections/slack/messaging.ts` (raw primitives).
- Delivery pipeline: `connectors/slack/postReply.ts` (normalize → gate stack → send → persist history once).
- Supporting: `inboundQueue.ts` (debounce + abort-if-safe), `processedDedup.ts`, `socketWatermark.ts` (recovery watermark), `coordinator.ts` (outreach reply classification — despite the filename, this is the outreach-reply handler, not the deleted meeting-coordination subsystem).
- Voice transcription (`src/voice/index.ts`) has one owner-approved 180-second total invocation budget across download headers/body, conversion and Whisper headers/body. Expiry aborts I/O and kills ffmpeg; completion waits for child close before scratch cleanup, so 180 seconds is the cancellation deadline rather than a guarantee that all cleanup is finished then. No paid retry or original-format fallback follows cancellation. Existing handler failure notices and ten-minute handled-message dedup remain. Fresh audio messages can retry; invisible accepted outbound audio may still replay after restart or dedup expiry because no durable receipt was added.

**Email** (v4.3.0+, live but narrow):
- Inbound: `connectors/graph/mailPoll.ts` (the poller — delta/isRead dedup, loop-guard against Maelle's own outgoing mail) hands surviving messages to `connectors/email/inbound.ts` (`registerMailInbound`), which owns the sender-authorization gate (owner + configured aliases only), forwarded-header participant extraction (`extractParticipants.ts`), HTML→text (`htmlToText.ts`), and the orchestrator call.
- Outbound: `connections/email/index.ts` (`createEmailConnection`) — a **one-address transport by construction**: `sendDirect` hard-caps every reachable field (`recipientRef`, `cc`, `bcc`) against `ownerEmailAddresses(profile)` (line 88-96) and REPLIES ONLY (`opts.replyToMessageId` required, no fresh-compose path — line 97-107), using Graph's native reply action (`connectors/graph/mail.ts:replyToMail`) with the validated address PATCHed onto `to` explicitly rather than trusted from Graph's own Reply-To inference (a real gap closed 2026-07-29, documented in the file's own header).
- Gated by `CHANNEL_TOOL_CLAMP.email` in `skills/registry.ts` (see Security posture above) and by the dedicated `runEmailLegGates` output leg.
- **Limits retained by owner decision:** From/alias admission is not provider-backed authentication; the existing provider contract did not establish a reliable simple sender-auth repair. Unknown send plus failed read marking and delta reset after restart can replay. Additional durable per-message email receipts were declined. Current bounded history and delta handling do not imply exactly-once delivery or external-reader context minimization.

**WhatsApp** (`connectors/whatsapp.ts`) — **dormant, not removed.** Its own header (line 1-27) states Steps 1-2 are built and wired: `src/index.ts` calls `startWhatsApp(profile)` at boot for every profile, but it is a no-op — byte-identical to Slack-only — unless that profile's YAML sets `user.whatsapp_phone`. No profile in this deployment sets it today. Inbound is owner-phone-only; anyone else is silently dropped before any content work. There is no `WhatsAppConnection` implementing the outbound `Connection` interface yet (Steps 3-6 of `.claude/WHATSAPP_PROJECT.md` are unbuilt) — this matches `ARCHITECTURE_MAP.md`'s "Dormant" classification.

---

## Skills registry

`skills/registry.ts` — `CORE_MODULES` (line 19, always active regardless of YAML): `AssistantSkill` (`core/assistant.ts`, memory), `OutreachCoreSkill` (`skills/outreach.ts`), `TasksSkill` (`tasks/skill.ts`), `CronsSkill` (`tasks/crons.ts`, routines). Togglable skills (`SKILL_MAP`, built once at startup): `meetings`, `search`, `calendar` (calendar-health), `summary`, `knowledge`, `social`, `venue`, `news` — each lazy-`require`'d so a broken skill file can never crash boot (`tryLoadSkill`, line 30-37).

**Module G — owner-path scope filtering** (`ALWAYS_ON_TOOLS` line 142, `SCOPE_TO_TOOLS` line 157): the orchestrator's `classifyTurn` picks scopes (`meetings`, `tasks`, `knowledge`, `people`, `venue`, `news`, or the widening `general`); `filterToolsByScope()` (line 288) ships always-on tools plus every tool in a requested scope — trims the tool list to keep the cached prompt prefix small. A tool that's neither always-on nor scope-mapped ships anyway (fail open) with a once-per-process warning, so a forgotten mapping never silently vanishes a tool.

`getSkillTools()` (line 605) also merges in the CURRENT turn's own-transport `Connection`'s tools only (`ownConnection = getConnection(profileId, channel)`, line 638) — a fix for email/WhatsApp tools leaking onto Slack turns once those connections got registered.

---

## Task pipeline

`src/tasks/runner.ts::runDueTasks` sweeps request timers first, then due `tasks` rows through `src/tasks/dispatchers/index.ts` (`routine`, `calendar_fix`). `src/tasks/routineMaterializer.ts` materializes recurring work; dispatchers own task terminal states. Reminders/follow-ups/research execute through the requests spine. The stores coexist; neither is a universal lifecycle authority.

**Meeting summaries:** `src/skills/summary.ts` and `src/db/summarySessions.ts` retain transcript ingestion, classification, drafting, editing and sharing, with action items as content. Automatic action-item followup scheduling and its dispatcher are removed by the owner's 2026-09-23 ruling. Startup cancels only exact `summary_action_followup` rows in `new`, `scheduled`, `in_progress`, `pending_owner` or `pending_colleague` state for that owner. It preserves terminal history and generic outreach, whose existing rows do not reliably identify summary origin; uncertain sends are not replayed. No live database cleanup is established by these source changes.

`src/core/background.ts::startBackgroundTimer` drives `materializeRoutineTasks → runDueTasks → processSlotHoldsIfDue` on the guarded five-minute pipeline, plus capture and slot-hold retention. Requests are not pruned by age. Startup recovers interrupted routine tasks; the separate ten-minute catch-up loop handles missed messages. Verify these background/restart consumers alongside interactive entry points.

## Prompt and operational boundaries

`systemPrompt.ts` returns static and dynamic blocks. The current `LANGUAGE — CURRENT TURN WINS` and `HEBREW GENDERED FORMS` guidance remains in `staticContent`, contrary to I8/I9's intended dynamic placement; that deviation is not a policy relaxation. The later NON-LATIN block no longer overrides the common title-translation and brand rules. Coda composition receives authoritative recipient gender through the existing call; structural captures prove inputs, not model obedience.

`scripts/deploy-watcher.mjs::appliedRevision` reads the online PM2 process's existing `GIT_SHA`; checkout HEAD alone no longer establishes deployment completion. Missing identity triggers rebuild, and install/build/restart failures retry on subsequent ticks; restart supplies `GIT_SHA` and `APP_VERSION`. Build and dependencies remain in-place, so partial output after interruption has no atomic rollback guarantee. `src/db/client.ts::getDb` clears and closes a connection after initialization failure so a later caller can retry. These describe current source; the observed running baseline for this readiness run remains 4.9.14 / ea5e69c until a separate authorized release.

---

## Person store / social engine

- **`db/people.ts`** — one `people_memory` table for everyone (internal/external/self), keyed by `slack_id` (schema `db/client.ts:353-363`, extended with ~25 `ALTER TABLE` migrations through the file for gender, travel, VIP, core-field provenance, language). `resolvePerson()` binds stable IDs and email; `lookupPersonByName()` separates a unique whole-name match, genuine ambiguity and suggestions. Accepted fields and notes retain writer provenance; operational markdown projections are serialized from current store state.
- **`memory/capturePass.ts`** — the end-of-chat capture pass (5-min tick): for DM threads gone quiet, existing Haiku profile extraction and social reconciliation update stored state (profile fields + `.md` file mirrors); failed/unusable capture records unknown outcomes without extra calls or retries — the deterministic backstop for a colleague-volunteered fact the live turn's prompt didn't prompt Sonnet to save.
- **`core/social/{classifyTurn,stateMachine,generateCoda,logEngagement}.ts`** — the social engine, gated behind `skills.social` (off by default). `stateMachine.ts`'s `chooseSocialDirective` uses deterministic selection and lazily resolves stored topic/category outcomes, picking ONE mode (`celebrate | engage | continue | raise_new | none`) per turn from the active-subjects picker; `generateCoda.ts` composes the actual line; the coda ships as its own message a beat after the real reply, gated by `runCodaGates` (see Security posture), never inline with the answer.

---

## LLM layer

`llm/models.ts` — `MODEL_SONNET = 'claude-sonnet-5'` (line 57), bundled with `thinking: { type: 'disabled' }` as `SONNET` (line 59+, used by every guard/classifier). The orchestrator's own agentic loop overrides this locally to `thinking: { type: 'adaptive' }, effort: 'high'` — documented in the file as a staged retry after a v4.0.0→v4.0.1 regression traced to Sonnet 5 being markedly less tool-eager with reasoning off. `MODEL_HAIKU = 'claude-haiku-4-5'` (line 83) is the cheap/fast tier for every guard and classifier.

`llm/client.ts`'s `getAnthropicClient()` (line 35) returns either the direct Anthropic SDK client or (`config.LLM_PROVIDER === 'vertex'`) a lazily-`require`'d `AnthropicVertex` client — same `messages.create()` contract either way, so no call site needs to know which provider is live.

---

## DB schema — tables that exist today

Confirmed via `CREATE TABLE` statements in `src/db/client.ts` (line numbers as of this writing; re-grep if the file has moved):

`conversation_threads` (107), `outreach_jobs` (117, `status` column DROPPED — the linked `requests` row is the only lifecycle now), `user_preferences` (135), `owner_schedule_overrides` (152, the #143 per-date mechanism), `events` (166, the away-log, not calendar events), `audit_log` (181), `tasks` (327), `people_memory` (353), `engagement_rank_log` (468), `social_categories` (523), `social_subjects` (561), `social_topics` (586), `slot_holds` (651, the #30 tentative-hold mechanism), `routines` (681), `calendar_issues` (802), `summary_sessions` (851), `requests` (882, the spine — see above), `owner_daily_threads` (945), `venues` (958).

**Dropped on every boot** (`DROP TABLE IF EXISTS`, idempotent no-op once gone): `multi_coord_jobs`, `coordination_jobs` (201-202, the removed multi-party coordination subsystem), `approvals` (209, superseded by `requests` rows of `kind='approval'`), `cron_schedules` (214, dead CRUD that was never wired — `routines` is the live path), `assistant_threads` (215, dead registry — replaced by history-based thread discovery), `known_contacts` (224, scaffolded in the person-store migration but never wired — zero readers/writers), `social_topics_v2` / `social_engagements` (516-517), `calendar_dismissed_issues` (837).

---

## What surprised or needs a human call (flagged, not guessed)

- `connectors/slack/coordinator.ts` is NOT the old meeting-coordination subsystem despite the name overlap with `skills/meetings/coord/` (removed) — it is the **outreach-reply classifier** (`handleOutreachReply`, `calcResponseDeadline`). Worth a rename someday, but out of scope for this rewrite.
- `connectors/whatsapp.ts` is further along than "placeholder" — it is live-wired for the owner front door (Step 1-2 of the build spec), just inert because no profile sets `whatsapp_phone`. The WHATSAPP_PROJECT.md doc's own "paused, steps 1-2 built" framing is accurate; only its planned reuse of `coordGuard`/`coordinate_meeting` for later steps is stale (both were removed in v3.5.0 — flagged with a header note in that file).
- **`db/client.ts` defines the `events` table TWICE** — byte-identical `CREATE TABLE IF NOT EXISTS events` + `CREATE INDEX IF NOT EXISTS idx_events_unseen` blocks at line 138 (correctly listed above) and again at line 310, sandwiched inside the `tasks` table's setup block. Harmless at runtime (`IF NOT EXISTS` makes the second a no-op) but it's dead duplication nobody's caught — a cleaner-shaped finding, not something this rewrite should silently fix by deleting code.
