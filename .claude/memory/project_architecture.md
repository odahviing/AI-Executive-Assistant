---
name: Maelle Architecture
description: Deep architecture reference — directory layout, orchestrator loop, requests spine, output gates, transports, DB schema
type: project
---

Deep architecture reference for Maelle, rewritten 2026-08-03 against the code on disk (current shipped version: the `version` field in `package.json`; `CHANGELOG.md` is the canonical version-by-version history, not duplicated here). `src/` is 199 files, ~73.5k lines (measured directly, not carried over).

**Where this sits relative to the other two references:** `.claude/SESSION_STARTER.md` is the day-to-day orientation — the agent framework, the lane roster, open bugs, operational rules. `.claude/ARCHITECTURE_MAP.md` is a one-page diagram-level map with a mermaid flowchart. This file is the deep layer underneath both: real file paths, real function/table names, all grep/Read-verified against the current tree rather than assumed from an earlier version. It does not repeat any lane charter's rules (`.claude/agents/*.md` are authoritative for those) — it describes what the code does, not which agent owns fixing it.

## Directory layout — verify before assuming "four layers"

The repo is NOT literally four top-level directories. `src/` has twelve: `config/ connections/ connectors/ core/ db/ llm/ memory/ skills/ tasks/ utils/ vision/ voice/`, plus `index.ts`. The "four-layer model" earlier docs described is a MENTAL GROUPING that still holds if you sort those twelve into it:

- **Core (always-on engine):** `core/` (orchestrator, requests spine, background tick, social state machine, thread actions), `tasks/` (the task ledger + dispatchers + routines), `db/` (schema + per-table helpers), `memory/` (person-memory capture + booking record), `llm/` (model/client selection).
- **Skills (togglable capability modules):** `skills/` — one class per capability, loaded via YAML toggle.
- **Connections + connectors (transport):** `connections/` (outbound `Connection` interface + registry + per-transport senders), `connectors/` (inbound handlers + non-messaging adapters: Slack Bolt app, email poll, Microsoft Graph).
- **Utils (cross-cutting):** `utils/` (output gates, scheduling rules, formatters, rate limiting), plus the two I/O adapters `voice/` and `vision/` which don't fit any of the other three.

Treat this as a lens, not a literal directory contract — `config/` (profile loader) doesn't fit any of the four cleanly either, and that's fine.

---

## The orchestrator turn loop

`src/core/orchestrator/index.ts` — `runOrchestrator()` (line 190) wraps everything in a per-turn `AsyncLocalStorage` cache (`withTurnCache`, `utils/turnCache.ts`) and delegates to `runOrchestratorImpl` (line 202), which:

1. Calls `buildTurnContext(input)` (`core/orchestrator/buildTurnContext.ts:17`) to assemble the system prompt (`systemPrompt.ts`), the scope-filtered tool list, the model, and the social directive.
2. Runs a `while (iteration < MAX_ITERATIONS)` loop (`MAX_ITERATIONS = 10`, line 287) calling Claude (`callClaude`, `turnHelpers.ts`) with `thinking: { type: 'adaptive' }, output_config: { effort: 'high' }` (line 325-326) — the Sonnet-5 "adaptive thinking" retry that restored tool-reaching after the thinking-disabled regression (see `llm/models.ts` below).
3. For each `tool_use` block, dispatches through `executeSkillTool` (`skills/registry.ts`), with several deterministic, code-level guards sitting IN the loop, not in a gate afterward:
   - **Same-turn idempotency**: `message_colleague` twice to the same colleague (line 458-478) and `delete_meeting` twice on the same event id (line 511-532) are both short-circuited with an explicit `_note` so the model narrates honestly instead of claiming a second action.
   - **Reverse-order double-notify guard** (v3.4.7): if `resolve_approval` already relayed an outcome to a requester this turn, a later `message_colleague` to that same person is suppressed (`relayedRequestersThisTurn`, line 479-503).
   - **Colleague rate limiting** (line 535+): `utils/rateLimit.ts` checks `colleague_any_tool` per `userId:threadTs`; over budget → the tool call is deflected with a synthetic "let me check with the owner" result, never a throw.
   - **Universal tool-call cache** (line 649-688): `utils/toolCallCache.ts` — a write within 60s or a read within 5s of an identical call (same owner+thread+tool+args) returns the cached result instead of re-firing.
   - **`deferred_action_hint` capture** (line 915-931): when a meeting tool returns a `rule_violation`, the hint is stashed and auto-attached to the next `create_approval(kind=policy_exception)` payload this turn — the "redirect-token" pattern that lets the resolver replay the exact original booking call on owner approve.
   - **Mutation tape** (`mutationActions`, line 900-913) and **coda-pending flag** (`turnLeftWorkPending`, line 955-986) both feed downstream consumers: the claim-checker's retry hint and the end-of-turn social coda's "is this turn still mid-exchange" check, respectively.
   - **`maybeOpenInFlightMeetingRequest`** (line 995-1011, `core/requests/maybeOpenInFlightMeetingRequest.ts`) — opens a request-spine row when owner-initiated meeting work spills past the current turn (a rule violation, an unresolved pick), purely an orchestrator-level tracking hook, no new tool.
4. No LLM "recovery pass" exists any more (deleted v2.8.1) — an empty `finalReply` after real tool activity falls through to a deterministic verb-mapped confirmation (`toolCallSummaries`), never a second speculative Sonnet call.

`OrchestratorInput` (line 13-121) and `OrchestratorOutput` (line 128-183) are the two shapes every caller (Slack, email, the requests-spine research runner, the background brief) constructs and consumes — this is the one entry point into "have Maelle think about something," system-generated calls included (`interactive: false` suppresses the social coda for a one-way report).

---

## Multi-tenancy

One deployment can host several executives. Each tenant is a YAML file at `config/users/<name>.yaml`, validated against `UserProfileSchema` in `src/config/userProfile.ts:79` (zod). Required fields: `user.name` (a real first+last name, regex-enforced), `user.email`, `user.timezone`, `user.slack_user_id` (`^U[A-Z0-9]+$`), and `assistant.slack.{bot_token,app_token,signing_secret}` — one Slack **app** per assistant identity, not one app serving several bots. Everything else (`schedule`, `meetings`, `categories`, `behavior`, `skills`, `channels`, `advanced`) has a default, so a ~15-line profile boots.

- `user.whatsapp_phone` (line 94) is optional and its presence is the on/off switch for the WhatsApp transport for that profile (see Transport layer below).
- `channels.email` (line 486+) carries the mailbox config plus `owner_aliases` (line 511) — additional addresses that count as "the owner" for the email sender gate.
- The **connection registry** (`connections/registry.ts`) is itself a `Map<profileId, Map<ConnectionId, Connection>>` (line 16) — every transport is registered per-profile at startup, so profile A having Slack+email and profile B being Slack-only can never collide.
- `skills/registry.ts`'s `getActiveSkills(profile)` reads `profile.skills` per call — no shared/global skill state between tenants.
- Per-tenant learned preferences live as `.md` files under `config/users/<name>_prefs/`, `<name>_kb/`, `<name>_news_seen.md` — free text the owner teaches, not code.

---

## The requests spine — the async work-item state machine

`src/core/requests/types.ts` defines the state machine; `src/db/requests.ts` is the CRUD layer; `src/core/requests/{closeRequest,resolver,runner,deferredActionReplay,maybeOpenInFlightMeetingRequest,logActivity,activityRevertibility}.ts` are the engine (`reconcile.ts` — the terminal-row prune — was DELETED in v4.5.4, see below). One `requests` table (schema at `db/client.ts:738-788`) owns the lifecycle of every multi-step unit of work: approvals, outreach, reminders, follow-ups, research, proactive social outreach — AND, since v4.5.4, a plain history/activity track (see below).

**`RequestKind`** (types.ts:20-26): `approval | outreach | reminder | follow_up | research | social_outreach`.

**`RequestState`** (types.ts:34-40) — the actual state machine: `awaiting_owner → awaiting_colleague ⇄ (via amend) → resolved | cancelled | expired`. `in_flight` covers scheduled-but-not-yet-fired work (a future outreach send, a research run in progress). **`logged`** (added v4.5.4) is a FIFTH terminal state, orthogonal to the decision lifecycle above: born terminal, never awaiting anyone, written by `logActivity.ts` for an outward-effect action that needed no owner decision (a booking, a move, a colleague DM, a finished research run) purely so it's recallable later. `getRequestsForBrief` and `closeRequest`'s terminal guard both special-case it; two thread-status readers (`getLatestRequestForThread`, `getOpenRequestsForThread`) exclude it explicitly so an activity row can never be mistaken for a colleague's own pending request. `activityRevertibility.ts` is a small declarative table, keyed by tool name, saying which `logged` kinds can actually be undone (a move, create, or floating-block booking) versus which can't (a cancel — Graph already emailed everyone). Eligibility (v4.5.6) is no longer a time-since-action TTL — it keys on whether the event's own current date is still upcoming, so an old mistake on a still-future meeting stays fixable and a recent one on an already-passed meeting doesn't. `revert_last_auto_move` (still that name; the capability is wider) can now target a specific past action by id (`getRevertibleActivityById`), not only the single most recent row — a bare "undo that" with nothing named stays bounded to the last 30 days, naming something specific has no limit.

**`NextCheckHandler`** (types.ts:67-74) — the row carries its OWN timer (`next_check_at` + `next_check_handler`); there is no separate dispatch table for one-shot expiries. `runner.ts`'s `sweepDueRequests()` (line 67-100) sweeps due rows on the same 5-min tick as the legacy task runner and dispatches by handler name (`dispatchHandler`, line 102-137): `expiry`, `approval_reminder`, `reminder_fire`, `research_run`, `reschedule_reask`, `outreach_expiry`, `send_scheduled_outreach`.

**`closeRequest()`** (`closeRequest.ts:44-122`) is the ONLY terminal-state writer — idempotent (no-op on an already-terminal row, line 49-54), cascades to children unless `skipChildren` (depth-1 only, avoids infinite loops on nested structures), clears the row's own timer, and writes one `audit_log` row per closure. Every other closer in the codebase (the resolver, the runner's expiry handlers, a meeting-mutation cascade, an outreach reply handler) calls through this function rather than writing `state` directly — convention, not a schema constraint.

**`resolveRequest()`** (`resolver.ts:190`, replacing the deleted `core/approvals/resolver.ts` — the file's own header says so at line 2) is the single entry point for an owner (or, on the amend bounce-back path, a colleague) decision. It is queued per-request-id (`resolveQueue`, line 188-203) specifically to close a check-then-act race a double-tap (an emoji ✅ landing alongside a typed reply) could otherwise hit. Verdict shapes: `approve | reject | amend | cancel`. An `amend` either relays the owner's counter to the requester (`relay_to_requester`, the default) or merges it straight into the approved action's args (`run_with_amend`) — both modes read from the universal callback table in `core/approvals/approvalCallbacks.ts` (`ToolCallback`, `on_approve`/`on_reject`/`on_amend`, line 34+), the one surviving file under `core/approvals/` after `resolver.ts`, `orphanBackfill.ts` and `coordBookingHandler.ts` were all deleted when this spine replaced them. Amend ping-pong is capped at `MAX_COUNTER_ROUNDS = 2` (resolver.ts:41) across both directions.

**Nothing on this table is pruned by age.** `reconcile.ts`'s `pruneOldTerminalRequests()` (deleted terminal rows older than 30 days, called from the background tick) was DELETED OUTRIGHT in v4.5.4, owner's explicit ruling — the requests table now keeps every row forever; a query orders newest-to-oldest instead of a retention window doing the forgetting.

**What no longer exists on this spine, confirmed by grep:** `coord_jobs`, `multi_coord_jobs`, `coordination_jobs` (dropped tables, `db/client.ts:173-174`), `src/core/approvals/{resolver,orphanBackfill,coordBookingHandler}.ts`, `src/skills/meetings/coord/*`, `src/utils/coordGuard.ts`, `src/skills/research.ts`, `src/connections/router.ts` — zero hits in `src/` for any of them except historical comments explaining that they were removed (e.g. `planMeeting.ts:235`, `resolver.ts:2`).

---

## Output-time security posture — the gate stack

`src/utils/guards/runOutputGates.ts` is where postReply's gate POLICY lives (extracted from `connectors/slack/postReply.ts`, which still owns pure delivery — history save, threading, the ack reaction). Three entry points:

1. **`runOutputGates(draft, ctx)`** (line 143) — the main stack.
2. **`runCodaGates(coda, ctx)`** (line 634) — a separate, much smaller gate for the social coda (see Social engine below): detect-only, fails CLOSED (drop the coda) rather than open, and never rewrites.
3. **`runEmailLegGates`** (line 555) — a third leg for the email transport, not a third value of the Slack two-axis test below.

**The gate policy is two axes, not one role check** (line 163-222, this is the load-bearing design decision documented in the file itself): `ownerIsActing` (`senderId === profile.user.slack_user_id`, line 210) decides whether the phantom-action honesty check runs; `colleagueReadable` (`role !== 'owner' || isOwnerInGroup === true`, line 211) decides whether the leak-scrub and the colleague voice frame run. They coincide in a 1:1 DM but diverge in a group DM or a channel — which is exactly the seam a single combined test used to miss (a channel had neither `role==='owner'` nor `isOwnerInGroup`, so the honesty check silently never ran there until this was fixed).

**Owner-private leg** (a 1:1 DM only the owner reads): claim-check + `humanGate('owner')` + date-verify, probed concurrently first and falling back to the exact serial chain only if any flags (a latency optimization documented at line 268-320).

**Colleague-readable leg** (a colleague DM, a channel, or a group DM): claim-check (only if the owner is acting) → security gate (leak filter + identity-spoof) → `humanGate('internal')` → date-verify LAST (line 322-508) — date-verify runs last on purpose because it's the only gate whose subject a REWRITER can introduce (a rewritten sentence could contain a new weekday word).

**Email leg** (`runEmailLegGates`, line 555): claim-check (unconditional — the sender gate upstream already restricts this whole leg to the owner) → `humanGate('external')` → date-verify (mandatory: a forwarded scheduling reply is almost entirely date claims). Deliberately skips the availability floor and the security gate — both assume Slack-specific state that doesn't exist on this leg (documented at line 537-551).

**The gate primitives themselves**, each its own file under `utils/`, dynamically imported so a clean reply never loads them:
- `claimChecker.ts` — narrow JSON classifier for false action claims ("I sent it" when no tool fired), owner-path only; remedy is a tool-less "own the miss" rewrite, never a re-run of the orchestrator.
- `dateVerifier.ts` — language-agnostic weekday/date mismatch detection (Haiku extracts pairs, code judges against a 14-day lookup, code performs the literal swap).
- `humanGate.ts` — voice/persona consistency (no "I have a backend issue" self-as-infrastructure framing, no mechanical refusal phrasing), runs on both owner and colleague drafts.
- `securityGate.ts` — colleague-facing leak filter (regex triggers + Haiku rewriter) plus the identity-spoof check (is the sender claiming to be someone else).
- `addresseeGate.ts` — MPIM "is this message even for Maelle" classifier (Haiku), fast-pathed by an explicit @-mention.
- `imageGuard.ts` — Sonnet image-text injection scanner, owner-only today (log + shadow-notify; documented to flip to refuse-and-notify once colleague image paths open).
- `availabilityPreCheck.ts` / `availabilityGate.ts` — the "don't eyeball free/busy" fix: a colleague-path availability question runs the SAME `checkSlot` rule engine the booking path runs, so a narrated verdict can never disagree with what booking would actually do.

**Everything fails open except the leak gate**, which fails SAFE (substitutes a fixed, undraftable line rather than ship an unvetted colleague-facing reply) — the file's own header states this is deliberate and names the one place a throw used to silently eat a colleague's entire reply (fixed in v4.2.x).

**Tool-level defense in depth**, in `skills/registry.ts`:
- `COLLEAGUE_ALLOWED_TOOLS` (line 368-450) — the positive allowlist a colleague-path Sonnet ever sees.
- `CHANNEL_TOOL_CLAMP` (line 276-280) — a transport-keyed ceiling; today only `email: [find_available_slots, create_meeting, get_person_memory, log_interaction]`, because the email sender gate is a spoofable From-header compare and this is the write-side backstop.
- `executeSkillTool`'s chokepoint (line 642-739) re-applies BOTH allowlists at dispatch time, independent of what got shipped to the model — a defense-in-depth pairing against a scope-map gap ever shipping a tool by accident (documented via the `web_research` incident it was written to prevent).
- `WRITE_TOOLS` (line 473-498) is the single source of "is this tool a mutation," consumed by the abort-if-safe inbound queue, the date-verifier retry's `proseOnly` strip, and the ack-guard.

---

## Approvals / requests flow, end to end

1. A tool call (owner or colleague path) hits a rule and returns `rule_violation` with a `_deferred_action_hint`, OR the model calls `create_approval` directly (`tasks/skill.ts`).
2. The orchestrator loop auto-attaches the captured hint to the approval payload (`core/orchestrator/index.ts:589-606`).
3. `createRequest()` (`db/requests.ts:49`) inserts a `kind='approval'` row, `state='awaiting_owner'`, with `details_json.callbacks` set (or the legacy `deferred_action` shape, transparently bridged by `extractCallbacks()` in `approvalCallbacks.ts`).
4. The owner sees it in his **owner daily decision thread** (`utils/ownerDailyThread.ts`, `owner_daily_threads` table, `db/client.ts:801-808`) — one lazily-created thread per owner per effective day, holding every approval ask that day.
5. Owner reacts (✅/❌) or replies in chat → `resolve_approval` → `resolveRequest()` (`resolver.ts:190`).
6. On approve with a replayable `on_approve.tool`, `runApproveCallback()` (`resolver.ts:614`) calls `runDeferredAction()` (`core/requests/deferredActionReplay.ts`) which re-invokes the exact original tool with an override flag (`relaxed: true` / `confirm_outside_window: true`) and stamps `_fulfilling_request_id` on the call so the booking-side cascade (`utils/closeMeetingArtifacts.ts`) knows to skip its own close+relay — this request already owns it.
7. `closeRequest()` fires, the requester (if any) is notified via `notifyRequesterOfDecision()` — composed as free text by an LLM for language-correctness, with machine-decided values (times, durations) PINNED verbatim so translation can't drift a number (resolver.ts:996-1018).
8. If nobody ever answers, `runner.ts`'s `runApprovalReminder` nags once at the midpoint (respecting the owner's work hours via `workHours.ts:workTimeBaseFromNow`), then `runExpiry` closes the row as `expired` and tells BOTH sides the truthful story of who actually went quiet (read off `state` at fire time, not off `kind` — an amended request sits on the colleague, not the owner, and the copy has to say so).

---

## Scheduling / booking engine

- **`skills/meetings.ts`** — `MeetingsSkill`, the single skill owning every calendar-touching tool (`get_calendar`, `find_available_slots`, `create_meeting`, `move_meeting`, `update_meeting`, `delete_meeting`, `check_join_availability`, `check_calendar_health`, `book_floating_block`, `set_event_category`, `manage_calendar_issue`, `set_work_schedule_override`, `get_work_schedule_overrides`, `hold_slot`, `revert_last_auto_move`, `find_venue` — tool list read directly from `getTools()`, `meetings.ts:36-120+`). Delegates direct-op handlers to a private `ops` instance (the former `SchedulingSkill`, `skills/meetings/ops.ts`).
- **`skills/meetings/planMeeting.ts`** — the one pipeline every scheduling intent (`book | move | cancel | find_slots`) flows through: load state → detect/reuse category → resolve location → check rules → decide action. Returns one of a fixed set of plan actions (`book`, `find_slots`, `confirm_override`, `escalate_approval`, `decline_as_attendee`, `refuse_not_owners`) — no free-text branching inside the pipeline (header comment, planMeeting.ts:1-35).
- **`utils/scheduleRules.ts`** — `checkSlot()` (line 524) is the ONE "is this slot OK?" validator; both the slot finder and the direct booking path call it, so they can never disagree.
- **`utils/workHours.ts`** — `getEffectiveWorkDay()` (line 109) / `getEffectiveWorkDayForInstant()` (line 155) are the ONE work-day resolver: the YAML base schedule, overridden per-date by a row in `owner_schedule_overrides` (`db/client.ts:124-135`, `db/scheduleOverrides.ts`) when one exists, fail-safe back to YAML otherwise. This is the #143 mechanism that replaced the old full-day "Working Elsewhere" travel-marker spine (see `project_we_timezone_spine.md`).
- **`utils/weTimeResolver.ts`** — the away-day dual-clock renderer (kept from the WE spine even though the booking mechanism itself moved to per-date overrides).
- Supporting: `utils/floatingBlocks.ts`, `utils/rebalanceFloatingBlocks.ts`, `utils/calendarDensity.ts`, `utils/categoryRules.ts`, `utils/meetingProtection.ts`, `utils/attendeeAvailability.ts`.
- **`connectors/graph/calendar.ts`** is a 4-line barrel (`export * from './calendarTypes' / './calendarReads' / './findAvailableSlots' / './calendarMutations'`) — the Outlook/Graph backend, not a messaging `Connection`. `calendarCache.ts` sits alongside it.

---

## Transport layer — `connections/` (outbound) + `connectors/` (inbound)

**`connections/types.ts`** defines the `Connection` interface (line 120) every transport implements: `sendDirect`, `sendBroadcast`, `sendGroupConversation`, `postToChannel`, `findUserByName`, `findChannelByName`, plus optional `collectCoreInfo`, `getTools`/`executeToolCall` (transport-owned tools), `reactToMessage`, `updateMessage`/`deleteMessage`, `resolveDirectChannelId`/`resolveChannelCounterpart`. `SendResult` (line 35-37) is the uniform outcome shape every transport returns. Skills import ONLY from here and from `connections/registry.ts` — never from `connectors/*`.

**`connections/registry.ts`** — a per-profile `Map<ConnectionId, Connection>` (line 16); `registerConnection` / `getConnection` / `listConnections`. There is **no `connections/router.ts`** in the current tree (zero hits — confirmed removed) — routing "which transport does a reply go out on" is handled by callers passing the turn's `inboundConnectionId` through and calling `getConnection(profileId, channel)` directly, not by a separate policy-routing file.

**Slack** (the primary, fully-live transport):
- Inbound: `connectors/slack/app.ts` (Bolt Socket Mode app) + `connectors/slack/app/{context,handlers,processMessage,helpers,fileIngestion}.ts`. `processMessage.ts` derives `senderRole` from the authenticated Slack sender (`getSenderRole`) and CLAMPS it to `'colleague'` in any MPIM, any channel, or colleague-test mode (line 128-139) — this clamp is the security boundary the output gates' `ownerIsActing`/`colleagueReadable` axes are built on top of.
- Outbound: `connections/slack/index.ts` (`SlackConnection`) + `connections/slack/messaging.ts` (raw primitives).
- Delivery pipeline: `connectors/slack/postReply.ts` (normalize → gate stack → send → persist history once).
- Supporting: `inboundQueue.ts` (debounce + abort-if-safe), `processedDedup.ts`, `socketWatermark.ts` (recovery watermark), `coordinator.ts` (outreach reply classification — despite the filename, this is the outreach-reply handler, not the deleted meeting-coordination subsystem).

**Email** (v4.3.0+, live but narrow):
- Inbound: `connectors/graph/mailPoll.ts` (the poller — delta/isRead dedup, loop-guard against Maelle's own outgoing mail) hands surviving messages to `connectors/email/inbound.ts` (`registerMailInbound`), which owns the sender-authorization gate (owner + configured aliases only), forwarded-header participant extraction (`extractParticipants.ts`), HTML→text (`htmlToText.ts`), and the orchestrator call.
- Outbound: `connections/email/index.ts` (`createEmailConnection`) — a **one-address transport by construction**: `sendDirect` hard-caps every reachable field (`recipientRef`, `cc`, `bcc`) against `ownerEmailAddresses(profile)` (line 88-96) and REPLIES ONLY (`opts.replyToMessageId` required, no fresh-compose path — line 97-107), using Graph's native reply action (`connectors/graph/mail.ts:replyToMail`) with the validated address PATCHed onto `to` explicitly rather than trusted from Graph's own Reply-To inference (a real gap closed 2026-07-29, documented in the file's own header).
- Gated by `CHANNEL_TOOL_CLAMP.email` in `skills/registry.ts` (see Security posture above) and by the dedicated `runEmailLegGates` output leg.

**WhatsApp** (`connectors/whatsapp.ts`) — **dormant, not removed.** Its own header (line 1-27) states Steps 1-2 are built and wired: `src/index.ts` calls `startWhatsApp(profile)` at boot for every profile, but it is a no-op — byte-identical to Slack-only — unless that profile's YAML sets `user.whatsapp_phone`. No profile in this deployment sets it today. Inbound is owner-phone-only; anyone else is silently dropped before any content work. There is no `WhatsAppConnection` implementing the outbound `Connection` interface yet (Steps 3-6 of `.claude/WHATSAPP_PROJECT.md` are unbuilt) — this matches `ARCHITECTURE_MAP.md`'s "Dormant" classification.

---

## Skills registry

`skills/registry.ts` — `CORE_MODULES` (line 19, always active regardless of YAML): `AssistantSkill` (`core/assistant.ts`, memory), `OutreachCoreSkill` (`skills/outreach.ts`), `TasksSkill` (`tasks/skill.ts`), `CronsSkill` (`tasks/crons.ts`, routines). Togglable skills (`SKILL_MAP`, built once at startup): `meetings`, `search`, `calendar` (calendar-health), `summary`, `knowledge`, `social`, `venue`, `news` — each lazy-`require`'d so a broken skill file can never crash boot (`tryLoadSkill`, line 30-37).

**Module G — owner-path scope filtering** (`ALWAYS_ON_TOOLS` line 142, `SCOPE_TO_TOOLS` line 157): the orchestrator's `classifyTurn` picks scopes (`meetings`, `tasks`, `knowledge`, `people`, `venue`, `news`, or the widening `general`); `filterToolsByScope()` (line 288) ships always-on tools plus every tool in a requested scope — trims the tool list to keep the cached prompt prefix small. A tool that's neither always-on nor scope-mapped ships anyway (fail open) with a once-per-process warning, so a forgotten mapping never silently vanishes a tool.

`getSkillTools()` (line 573) also merges in the CURRENT turn's own-transport `Connection`'s tools only (`ownConnection = getConnection(profileId, channel)`, line 605) — a fix for email/WhatsApp tools leaking onto Slack turns once those connections got registered.

---

## Task pipeline

`tasks/runner.ts`'s `runDueTasks()` (line 29) is now a THIN wrapper: it calls `sweepDueRequests()` (the requests spine, primary) first, then pulls due rows from the legacy `tasks` table and dispatches through `DISPATCHERS` (`tasks/dispatchers/index.ts:25-31`) — which today only holds `routine`, `calendar_fix`, `summary_action_followup`, `social_decay`, `social_ping_rank_check`. The old `reminder`/`follow_up`/`research` dispatchers are gone (dispatchers/index.ts's own comment, line 18-24): that work lives entirely on the requests spine now (`create_task` → `createRequest` with `next_check_handler = reminder_fire | research_run`). The `tasks` table survives as the owner-facing work LEDGER (the daily brief, `get_my_tasks`, thread-context injection, the ✅-completion reaction) — a deliberate two-system split, not redundancy: the spine owns lifecycle+timers, `tasks` owns visibility.

`core/background.ts`'s `startBackgroundTimer()` (line 127) drives everything: a 5-min `setInterval` (line 155-166) runs `materializeRoutineTasks → runDueTasks → processSlotHoldsIfDue`, plus a fire-and-forget requests-spine prune and end-of-chat capture pass every tick. A separate 10-min `setInterval` (line 224+) runs a periodic catch-up safety net (`catchUpMissedMessages`, line 479) scoped to a persisted socket-alive watermark, independent of what the socket itself reports connected (the "half-dead socket" case this exists to catch).

---

## Person store / social engine

- **`db/people.ts`** — one `people_memory` table for everyone (internal/external/self), keyed by `slack_id` (schema `db/client.ts:327-338`, extended with ~25 `ALTER TABLE` migrations through the file for gender, travel, VIP, core-field provenance, language). `resolvePerson()` (line 1332) is the identity chokepoint: slack_id → email → fuzzy-name, find-or-create-or-merge.
- **`memory/capturePass.ts`** — the end-of-chat capture pass (5-min tick): for DM threads gone quiet, one Haiku call extracts deltas from the conversation against current state and writes them (profile fields + `.md` file mirrors) — the deterministic backstop for a colleague-volunteered fact the live turn's prompt didn't prompt Sonnet to save.
- **`core/social/{classifyTurn,stateMachine,generateCoda,logEngagement}.ts`** — the social engine, gated behind `skills.social` (off by default). `stateMachine.ts`'s `chooseSocialDirective` is pure TypeScript (no LLM, no DB writes) picking ONE mode (`celebrate | engage | revive_ack | continue | raise_new | none`) per turn from the active-subjects picker; `generateCoda.ts` composes the actual line; the coda ships as its own message a beat after the real reply, gated by `runCodaGates` (see Security posture), never inline with the answer.

---

## LLM layer

`llm/models.ts` — `MODEL_SONNET = 'claude-sonnet-5'` (line 41), bundled with `thinking: { type: 'disabled' }` as `SONNET` (line 43-46, used by every guard/classifier). The orchestrator's own agentic loop overrides this locally to `thinking: { type: 'adaptive' }, effort: 'high'` — documented in the file as a staged retry after a v4.0.0→v4.0.1 regression traced to Sonnet 5 being markedly less tool-eager with reasoning off. `MODEL_HAIKU = 'claude-haiku-4-5'` (line 64) is the cheap/fast tier for every guard and classifier.

`llm/client.ts`'s `getAnthropicClient()` (line 35) returns either the direct Anthropic SDK client or (`config.LLM_PROVIDER === 'vertex'`) a lazily-`require`'d `AnthropicVertex` client — same `messages.create()` contract either way, so no call site needs to know which provider is live.

---

## DB schema — tables that exist today

Confirmed via `CREATE TABLE` statements in `src/db/client.ts` (line numbers as of this writing; re-grep if the file has moved):

`conversation_threads` (69), `known_contacts` (79), `outreach_jobs` (89, `status` column DROPPED — the linked `requests` row is the only lifecycle now), `user_preferences` (107), `owner_schedule_overrides` (124, the #143 per-date mechanism), `events` (138, the away-log, not calendar events), `audit_log` (153), `tasks` (287), `people_memory` (327), `engagement_rank_log` (428), `social_categories` (468), `social_subjects` (485), `social_topics` (508), `slot_holds` (529, the #30 tentative-hold mechanism), `routines` (559), `calendar_issues` (662), `summary_sessions` (707), `requests` (738, the spine — see above), `owner_daily_threads` (801), `venues` (814).

**Dropped on every boot** (`DROP TABLE IF EXISTS`, idempotent no-op once gone): `multi_coord_jobs`, `coordination_jobs` (173-174, the removed multi-party coordination subsystem), `approvals` (181, superseded by `requests` rows of `kind='approval'`), `cron_schedules` (186, dead CRUD that was never wired — `routines` is the live path), `assistant_threads` (187, dead registry — replaced by history-based thread discovery), `social_topics_v2` / `social_engagements` (462-463), `calendar_dismissed_issues` (693).

---

## What surprised or needs a human call (flagged, not guessed)

- `connectors/slack/coordinator.ts` is NOT the old meeting-coordination subsystem despite the name overlap with `skills/meetings/coord/` (removed) — it is the **outreach-reply classifier** (`handleOutreachReply`, `calcResponseDeadline`). Worth a rename someday, but out of scope for this rewrite.
- `connectors/whatsapp.ts` is further along than "placeholder" — it is live-wired for the owner front door (Step 1-2 of the build spec), just inert because no profile sets `whatsapp_phone`. The WHATSAPP_PROJECT.md doc's own "paused, steps 1-2 built" framing is accurate; only its planned reuse of `coordGuard`/`coordinate_meeting` for later steps is stale (both were removed in v3.5.0 — flagged with a header note in that file).
- **`db/client.ts` defines the `events` table TWICE** — byte-identical `CREATE TABLE IF NOT EXISTS events` + `CREATE INDEX IF NOT EXISTS idx_events_unseen` blocks at line 138 (correctly listed above) and again at line 310, sandwiched inside the `tasks` table's setup block. Harmless at runtime (`IF NOT EXISTS` makes the second a no-op) but it's dead duplication nobody's caught — a cleaner-shaped finding, not something this rewrite should silently fix by deleting code.
