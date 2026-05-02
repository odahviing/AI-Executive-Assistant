---
name: Maelle Architecture
description: Four-layer model, skills system, orchestrator loop, task pipeline, state machines, security layers
type: project
originSessionId: fd199f43-f9ab-495a-9013-017e7e191338
---
Architecture reference for Maelle **v2.4.1** (floating-block schema cleanup + owner-override-as-approval extended + move-aware slot finder; v2.0.0 = Connection interface milestone).

**Floating blocks (v2.4.1) — single yaml shape, single getter.** All floating blocks (lunch, coffee, gym, prayer, daily writing hour) live under `meetings.floating_blocks` (moved from `schedule.` per owner framing — schedule = framework, meetings = events that fill it). The legacy `schedule.lunch` top-level field is gone — pre-v2.4.1 it was auto-promoted into floating_blocks at runtime, an asymmetric path that had the lunch fact in a different yaml shape than every other block. `getFloatingBlocks(profile)` now reads `meetings.floating_blocks` only — one line, one source.

**Owner-override-as-approval (v2.4.1, extended) — one pattern across the calendar tools.** Owner direct request IS the approval (no separate lunch_bump). Three flags: `find_available_slots.relaxed: true` (v2.3.3, bypasses focus/lunch/work-hours soft rules in slot search), `book_floating_block.confirm_outside_window: true` + `start_time: HH:MM` (v2.4.1, bypasses block window + day-of-week scope), `move_meeting.confirm_outside_window: true` (v2.4.1, bypasses block window on owner-path moves). Prompt rule MANDATES verify-then-act: Maelle MUST flag the cost ("lunch at 4am Friday is way outside your usual window — sure?") before passing the override flag. Colleague-path is unchanged; colleague rule violations still go to create_approval.

**Move-aware slot finder (v2.4.1) — `findAvailableSlots.excludeEventIds: string[]`.** Per id: subtract event's time from busy pool (so candidate slots aren't blocked by a meeting that's leaving) AND forbid event's time as a candidate (so options never include the original time or any overlap). One parameter, two semantics, both right for validation ("can we move 11am to 10:30?") AND discovery ("what are options to move the 11am?"). Exposed via `find_available_slots.moving_event_ids` tool arg. New rejection reason `'overlaps_meeting_being_moved'` shows up in the v2.3.6 rejection-breakdown log.

**HYPOTHETICAL VALIDATION prompt rule (v2.4.1).** "Can we do X at Y?" / "would Z work?" → call find_available_slots with narrow window; trust the tool. NO margin freelance. The minute Sonnet says "tight but workable" she's usurped a rule the owner taught the system AND killed config-portability for any future profile with different buffer/duration values. Owner principle: rules live in yaml + code enforces them, prompt expresses intent. Mission: agent that works as a human EA. Prompts vs code principle: determinism → code (booking, delete/create idempotency, date, slot rules, approval sync); judgment/tone → prompt.

**Prompt size pattern (v2.4):** owner-DM system prompt was 30K tokens — preferences shipping in full every turn (25%) + accumulated meetings rules (32%). Catalog pattern from v2.2.1 people-memory now applies to preferences too: `formatPreferencesCatalog(userId)` injects categories + key list (~150-300 chars/cat), Sonnet calls `recall_preferences(category|key)` to load full text on demand. `learn_preference.category` enum dropped `people` (person facts → `update_person_memory` / `update_person_profile`); tool description excludes business knowledge (→ KB markdown). One-shot migration scripts at `scripts/migrate-prefs-to-{kb,people-md}.cjs` (idempotent) moved 67 legacy rows out. Owner-DM prompt now 21K tokens (−29.5%).

**Observation-tool silence (v2.4 Fix A for #78):** in `core/orchestrator/index.ts` recovery-fallback path, `SILENCE_ELIGIBLE` set defines tools whose user-facing impact is zero — `note_about_self`, `note_about_person`, `log_interaction`, `learn_preference`, `forget_preference`, `recall_preferences`, `recall_interactions`, `update_person_profile`, `update_person_memory`, `get_person_memory`, `confirm_gender`. When the only tools that fired are silence-eligible AND Sonnet went silent, the orchestrator stays silent (auditLog + social-engine logging still run). Without this, the v1.7.3 verbMap fallback fires and emits tool-POV text ("Done — made a note about myself") in the middle of a social chat — violation of the v2.3.8 INTERNALS rule.

**Message flow:** Slack → `connectors/slack/app.ts` (inbound) → `runOrchestrator()` → Claude tool loop → skills execute (via `Connection` for any outbound messaging) → `postReply.ts` (normalize → claim-check → date-verify with deterministic correction → security gate → send) → reply.

---

## Runtime + deploy pipeline (v1.8.2)

**Runs under PM2 on the owner's laptop.** Two processes defined in `ecosystem.config.js`:

- `maelle` — main bot, runs `dist/index.js` (requires `npm run build` first)
- `maelle-deploy-watcher` — polls `origin/master` every 5 min via `scripts/deploy-watcher.mjs`. When `HEAD !== origin/master` AND any new commit's author is `Maelle Auto-Triage`: `git pull --ff-only` → `npm ci` (if lockfile changed) → `npm run build` → `pm2 restart maelle`. Owner's own commits are skipped (he deploys those himself by running the same commands locally).

Startup flow (one-time): `npm i -g pm2 pm2-windows-startup` → `pm2 start ecosystem.config.js` → `pm2 save` → `pm2-startup install` (Windows auto-start on reboot).

**Auto-triage + auto-build (GitHub Actions, v1.8.2 propose-only flow):**

1. **Issue opens with `Bug` label** (or added later) → `.github/workflows/auto-triage-bug.yml` fires → `scripts/auto-triage-bug.mjs`:
   - Reads issue title + body + ALL comments (so Revise re-reads owner's feedback)
   - Downloads every GitHub user-attachments image URL using `GH_TOKEN` to `/tmp/triage-<issue>/img-N.<ext>` — agent uses Read tool on them
   - Invokes Sonnet with NO pre-injected repo context (anti-recency-bias)
   - Five anti-recency guardrails: no SESSION_STARTER pre-injection, no pattern-matching recent changelog, root cause must name file+line+function+mechanism, single-keyword causes require a second signal, post-verdict sanity-check pass
   - Outputs strict JSON. Never edits files. NOT_A_BUG → auto-close. BUG → posts plan as comment + labels `Proposed`.
2. **Owner labels `Revise` + comments** → triage re-fires with full comment thread.
3. **Owner labels `Approved`** → `auto-build.yml` fires → `scripts/auto-build.mjs`: collects plan + follow-ups, invokes Sonnet to implement (`acceptEdits`, Read/Grep/Glob/Edit/Write/Bash). Safety floors: typecheck passes, 200-line cap, forbidden-path allowlist, JSON output. Violation → revert + post reason + `Failed`. Success → commit under `Maelle Auto-Triage`, push, close with fixed-in-SHA comment.

**Labels:** `Proposed` / `Approved` / `Revise` / `Failed` / `Triaged`.

---

## Layer 1 — Core (always on)

`CORE_MODULES` in `skills/registry.ts`: `[AssistantSkill, OutreachCoreSkill, TasksSkill, CronsSkill]`. Note: OutreachCoreSkill's file moved to `src/skills/outreach.ts` in v1.8.11 but it's still in CORE_MODULES (code layout convenience; not togglable).

### Skill-interface core modules
- `src/core/assistant.ts` — MemorySkill (class `AssistantSkill`, scope is memory-only). Tools: learn_preference, forget_preference, recall_preferences, recall_interactions, note_about_person, note_about_self, update_person_profile, log_interaction, confirm_gender. DB: `user_preferences`, `people_memory`.
- `src/core/assistantSelf.ts` — seed + format helpers for Maelle's own people_memory row, keyed on synthetic `SELF:<ownerSlackId>`. Renders the ABOUT YOU block into owner and colleague prompts.
- `src/core/ownerSelf.ts` — owner pre-seed in people_memory for self-tracking.
- `src/skills/outreach.ts` — OutreachCoreSkill (moved from `core/` in 1.8.11, still in CORE_MODULES). Tools: message_colleague, find_slack_channel. Sends synchronously via Connection. DB: `outreach_jobs` + task side-effects (outreach_send / outreach_expiry).
- `src/tasks/skill.ts` — TasksSkill. Tools: create_task, edit_task, get_my_tasks, cancel_task, get_briefing, send_briefing_now, create_approval, resolve_approval, list_pending_approvals, store_request, get_pending_requests, resolve_request, escalate_to_user. DB: `tasks`, `approvals`, `pending_requests`, `approval_queue`.
- `src/tasks/crons.ts` — CronsSkill (Routines). Tools: create_routine, get_routines, update_routine, delete_routine. DB: `routines` (+ `never_stale` column).

### Engine infra (non-Skill)
- `src/tasks/runner.ts` — 68-line loop: pick due tasks, look up dispatcher in `dispatchers/index.ts`, call it. Each TaskType has its own dispatcher file (reminder, followUp, research, routine, outreachSend, outreachExpiry, coordNudge, coordAbandon, approvalExpiry, calendarFix, summary_action_followup).
- `src/tasks/routineMaterializer.ts` — converts routine firings → tasks; UNIQUE(routine_id, due_at).
- `src/tasks/lateness.ts` — cadence-based skip thresholds.
- `src/core/orchestrator/index.ts` — Claude tool loop, system prompt assembly, rate limiting + coord guard for colleague path. Per-turn idempotency for delete_meeting.
- `src/core/orchestrator/systemPrompt.ts` — date/time, prefs, people memory, week boundaries, persona rules, pending approvals section (v1.5), HONESTY RULES including RULE 2b (v2.0 — prior replies are commitments).
- `src/core/background.ts` — single 5-min timer: `materializeRoutineTasks` → `runDueTasks`. Startup: ensureBriefingCron, catchUpMissedMessages (v2.0 marks ts in shared dedup before replying), orphan-approval backfill.
- `src/core/approvals/resolver.ts` — single entry for owner decisions. Freshness re-check via `getFreeBusy` before booking. Calls registered coord booking handler (v2.0) — does not import from skills.
- `src/core/approvals/orphanBackfill.ts` — one-time startup sweep for pre-v1.5 stuck `waiting_owner` coords.
- `src/core/approvals/coordBookingHandler.ts` (v2.0) — registry (`registerCoordBookingHandler` / `getCoordBookingHandler`). MeetingsSkill registers on load; resolver calls through. Inverts the core→skill dependency that would otherwise break the boundary.

### Persona
Not a module — lives as data in `config/users/<name>.yaml` and assembled inline by `buildSystemPrompt()`.

---

## Layer 2 — Skills (togglable)

Loaded via `skills/registry.ts` based on YAML `skills: { meetings: true, ... }`. Legacy YAML keys auto-migrate: `scheduling`/`coordination` → `meetings`, `meeting_summaries` → `summary`, `knowledge_base` → `knowledge`, `calendar_health` → `calendar`.

- `src/skills/meetings.ts` — MeetingsSkill. Owns every calendar-touching tool: get_calendar, analyze_calendar, dismiss_calendar_issue, get_free_busy, find_available_slots, create_meeting, move_meeting, update_meeting, delete_meeting, find_slack_user, coordinate_meeting, get_active_coordinations, cancel_coordination, finalize_coord_meeting, check_join_availability. Delegates direct-op handlers to `skills/meetings/ops.ts`. `getSystemPromptSection` owns MEETINGS HONESTY RULES, DELETE-MEETING PROTOCOL, quarter-hour alignment, HARD SCHEDULE numbers.
- `src/skills/meetings/ops.ts` (v1.8.14 relocation of `_meetingsOps.ts`) — direct calendar-op case handlers + `processCalendarEvents` + `analyzeCalendar`. Class `SchedulingSkill`, not registered, used via MeetingsSkill delegation. **create_meeting is idempotent across turns (v2.0):** pre-checks Graph for existing event at same subject+start (±2 min) and returns that id instead of creating a duplicate.
- `src/skills/meetings/coord/` (v2.0, moved from `connectors/slack/coord*`) — coord state machine, fully transport-agnostic:
  - `utils.ts` — determineSlotLocation, interpretReplyWithAI, isCoordReplyByContext (pure, zero transport)
  - `approval.ts` — emitWaitingOwnerApproval (resolves Slack via `getConnection` registry)
  - `booking.ts` — bookCoordination + forceBookCoordinationByOwner (registers handler with core approvals registry at module load)
  - `state.ts` — initiateCoordination + sendCoordDM + resolveCoordination + startPingPong + tryNextPingPongSlot + startRenegotiation + triggerRoundTwo
  - `reply.ts` — handleCoordReply + handlePreferenceReply + parseTimePreference
- `src/skills/calendarHealth.ts` — CalendarHealthSkill. Tools: check_calendar_health, book_lunch, set_event_category, get_calendar_issues, update_calendar_issue. Schedules `calendar_fix` tasks.
- `src/skills/general.ts` — SearchSkill. Tools: web_search, web_extract (Tavily).
- `src/skills/research.ts` — ResearchSkill. Owner-only.
- `src/skills/knowledge.ts` — KnowledgeBaseSkill. Tools: list_company_knowledge, get_company_knowledge. Auto-discovers `.md` files in `config/users/<owner_first_name>_kb/`. Catalog injected via prompt.
- `src/skills/summary.ts` — SummarySkill. Tools: classify_summary_feedback, learn_summary_style, update_summary_draft, share_summary, list_speaker_unknowns. Plus `ingestTranscriptUpload` helper from Slack `file_share`. 3-stage state machine (Drafting → Iterating → Sharing) via `src/db/summarySessions.ts`.

### Registry machinery
- `src/skills/registry.ts` — CORE_MODULES hardcoded (includes OutreachCoreSkill loaded from `skills/outreach.ts`), togglable skills lazy-loaded via require() under loader keys.
- `src/skills/types.ts` — `Skill` interface, `SkillContext`, `SkillId`, `CoreModuleId`, `ChannelId`, `Channel`.

### COLLEAGUE_ALLOWED_TOOLS
`find_slack_user, get_calendar, get_free_busy, find_available_slots, store_request, coordinate_meeting, check_join_availability, web_search`. Technical allow-list.

---

## Layer 3 — Connections (outbound) + Connectors (inbound + external services)

**v2.0 first-class split.** Before: `connectors/slack/*` handled both inbound Bolt events AND outbound messaging. Skills imported from it. After: outbound goes through a formal `Connection` interface, skills NEVER import from `connectors/`.

### Connections (outbound messaging interface, v2.0)
- `src/connections/types.ts` — `Connection` interface: `sendDirect(userId, text, opts?)`, `sendBroadcast`, `sendGroupConversation`, `postToChannel(channelId, text, opts?)`, `findUserByName`, `findChannelByName`. `SendOptions.threadTs` flows through. `ConnectionUser`, `ConnectionChannel`, `PersonRef`, `RoutingPolicy`.
- `src/connections/registry.ts` — per-profile `Map<profileId, Map<connectionId, Connection>>`. Skills resolve via `getConnection(ownerUserId, 'slack')`. `registerConnection` at transport startup.
- `src/connections/router.ts` — 4-layer routing policy for future multi-transport: (1) inbound-context wins, (2) person preferred, (3) per-skill routing, (4) profile default. In place; skills will consume it as email/WhatsApp land.
- `src/connections/slack/messaging.ts` — raw Slack primitives (`sendDM`, `sendMpim`, `postToChannel`, `findUserByName`, `findChannelByName`) with `{ threadTs }` opts.
- `src/connections/slack/index.ts` — `SlackConnection` that implements the Connection interface over messaging.ts.

### Connectors (inbound + non-messaging adapters)
- `src/connectors/slack/app.ts` — Slack Bolt app (Socket Mode), message event router, action dispatcher, security gate invocation, catchUpMissedMessages orchestrator call. Registers `SlackConnection` in the Connection registry at startup.
- `src/connectors/slack/postReply.ts` — outgoing reply pipeline. Normalize Slack markdown → claim-check (retry with tool_choice) → date-verify (retry + **deterministic inline correction** in v2.0 if retry also fails) → security gate → send via Connection. For owner drafts.
- `src/connectors/slack/coordinator.ts` (~668 lines) — outreach reply classifier + `handleOutreachReply`, `calcResponseDeadline`, `findSlackUser`, `findSlackChannel`, `openDM`. **Next port target** (was sub-phase E) — move classifier to `src/skills/outreach/replyHandler.ts`.
- `src/connectors/slack/relevance.ts` — message-relevance classifier (is-this-for-Maelle).
- `src/connectors/slack/processedDedup.ts` (v1.8.14) — process-global `Set<ts>` with 60s TTL. Live handlers + catchUpMissedMessages share it so a message catch-up replied to can't be re-processed by the live handler after Slack re-delivers post-reconnect.
- `src/connectors/graph/calendar.ts` — Microsoft Graph (Outlook). Events CRUD, free/busy, slot rules, `createMeeting` returns Graph event id. **Not a Connection** — calendar backend, not a messaging surface.
- `src/connectors/whatsapp.ts` — placeholder. Next concrete `Connection` implementation.

---

## Layer 4 — Tools & Utilities

- `src/voice/` — Slack audio in/out. `transcribeSlackAudio` (Whisper + ffmpeg), `textToSpeech` (gpt-4o-mini-tts), `sendAudioMessage`, `shouldRespondWithAudio`. Voice transcribes-then-discards.
- `src/vision/` — Slack image in. `downloadSlackImage` (jpeg/png/gif/webp, 5MB cap), `buildImageBlock` (Anthropic image content block). Native multimodal. Owner-only in DM + MPIM.
- `src/utils/logger.ts` — winston + daily-rotate-file (7 days info, 30 days error).
- `src/utils/securityGate.ts` — narrow regex triggers + Sonnet rewriter on colleague-facing replies. Safe canned fallback on UNFIXABLE.
- `src/utils/claimChecker.ts` — Sonnet classifier, strict JSON, OWNER path only. Detects false action claims. Retry with `tool_choice` forcing the right tool. MPIM-aware. Fails open.
- `src/utils/dateVerifier.ts` — 14-day lookup. Regex catches "Weekday N Mon" pairs (EN + HE). v1.8.5: LLM-based bare-weekday context check. **v2.0: post-retry re-verification + deterministic inline weekday-token rewrite** when retry also produces wrong pair. Owner AND colleague paths. Fails open.
- `src/utils/coordGuard.ts` — injection-pattern scan + Sonnet judge for `coordinate_meeting` on colleague path.
- `src/utils/imageGuard.ts` — Sonnet image-text injection scanner. Owner path: log + shadow-notify, proceed. Designed to flip to refuse-and-notify when colleague image paths open.
- `src/utils/workHours.ts` (v1.8.14 extracted from outreachExpiry) — `isWithinOwnerWorkHours(profile, now)` + `nextOwnerWorkdayStart(profile)`. Shared by outreach_expiry, coord_nudge, coord_abandon to defer owner DMs outside work hours.
- `src/utils/shadowNotify.ts` (v1.8.14 ported to Connection) — resolves Slack via `getConnection(ownerId, 'slack')`. No longer takes `app: App`. Caches owner DM channel per profile. Plain-text rendering with 🔍 prefix.
- `src/utils/rateLimit.ts` — sliding-window in-memory limits.
- `src/utils/genderDetect.ts` — pronouns → image → Sonnet name classifier. Never overwrites `gender_confirmed=1`.
- `src/utils/slackFormat.ts` — normalizeSlackText (`**`→`*`, strip `##`, leading `- `). Apply at every LLM→Slack post.
- `src/utils/addresseeGate.ts` — MPIM addressing check.
- `src/db/` — barrel + per-table helpers (client, people, preferences, conversations, jobs, events, requests, calendarIssues, approvals, summarySessions).
- `src/config/` — profile loader (zod schema) + env.

---

## Task pipeline (v1.6 unified, v1.6.3 split, v2.0 Connection-based)

Every background activity is a typed task with a `due_at`. Background loop (core/background.ts): **`materializeRoutineTasks(profiles) → runDueTasks(app, profiles)`** every 5 min.

`tasks/runner.ts` is a thin dispatch loop. Each TaskType has its own dispatcher file with a registry map in `dispatchers/index.ts`.

| TaskType | Creator | Dispatcher |
|---|---|---|
| reminder | create_task tool | DM owner or target at due_at (via Connection) |
| follow_up | create_task tool | DM owner |
| research | create_task tool | Runs through orchestrator |
| routine | materializeRoutineTasks | Runs routine prompt; skips silently if past cadence threshold |
| outreach_send | message_colleague (future send_at) | Post DM via Connection, flip outreach_jobs sent, queue outreach_expiry |
| outreach_expiry | outreach_send | First: follow-up + re-queue +3wh. Second: if outside owner work hours, re-queue for nextOwnerWorkdayStart. Otherwise mark no_response + notify owner via Connection. |
| coord_nudge | initiateCoordination | **v1.8.14:** if outside owner work hours, re-queue. Otherwise DM non-responders via Connection + queue coord_abandon +4h. |
| coord_abandon | coord_nudge dispatcher | **v1.8.14:** work-hours deferral. Otherwise abandon coord + notify owner via Connection. |
| approval_expiry | createApproval | Expire approval, cascade task→cancelled + coord→abandoned + notify |
| calendar_fix | update_calendar_issue (to_resolve) | Re-check in 1 day; auto-resolve if gone, re-ping + re-queue if still there |
| summary_action_followup | share_summary (Stage 3) | Sonnet composes one-line check-in DM via Connection, creates outreach_jobs row + outreach_expiry task |

`tasks.skill_origin` tags each row with its creator skill.

**All message-sending dispatchers (v2.0) use `getConnection(ownerId, 'slack').sendDirect/postToChannel` — no `app.client.*`.**

---

## Approvals (v1.5+, resolver v2.0)

First-class structured decisions in `approvals` table, always under a parent task.

- **Kinds:** slot_pick, duration_override, policy_exception, lunch_bump, unknown_person, calendar_conflict, freeform
- **Statuses:** pending | approved | rejected | amended | expired | superseded | cancelled
- **Resolver** (`core/approvals/resolver.ts`): single entry for decisions. Freshness re-check for slot_pick via `getFreeBusy`. **v2.0: calls `getCoordBookingHandler()` registry instead of importing `forceBookCoordinationByOwner` directly** — breaks the core→skill boundary violation.
- **amend** is first-class: owner says "no but 1:30 works" → counter recorded → orchestrator relays back.
- **No buttons.** Pending approvals injected into owner system prompt; Sonnet binds by subject/timing/thread and calls `resolve_approval`.
- **Expiry:** driven by `approval_expiry` task, not a sweep.
- **Idempotency:** hash(task_id + kind + payload) UNIQUE on creation; `coord_jobs.external_event_id` short-circuits double-booking.
- **Requester loop:** `coord_jobs.requesters` JSON. On booked/expired, requesters who aren't participants get a structured DM.

---

## Coord state machine (v2.0 location: `src/skills/meetings/coord/`)

- Table: `coord_jobs`. Statuses: collecting | resolving | negotiating | waiting_owner | confirmed | booked | cancelled | abandoned.
- DMs key participants with up to 3 slot options + location per slot → collect → resolve best → book. Via Connection throughout.
- just_invite participants: added to calendar invite only, no DM, no vote.
- Location auto-determined per slot: office day ≤3→Office+Teams, >3→Room+Teams; home day internal→Huddle, external→Teams.
- `emitWaitingOwnerApproval` helper: every waiting_owner parking creates a structured approval + posts via `conn.postToChannel(owner_channel, askText, {threadTs})`.
- `handleCoordReply` follow-up branch handles post-vote follow-ups without re-running resolveCoordination.
- MPIM coord (in-group): contacted_via='group', voting in MPIM thread. Thread-boundary fast-path filters out out-of-context replies.
- v1.8.6 dm_thread_ts: booking confirmations post back into the original coord DM thread when `dm_channel + dm_thread_ts` were recorded in sendCoordDM. Preserved through the port via `conn.postToChannel(dm_channel, text, {threadTs: dm_thread_ts})`.
- Reschedule intent (v1.8.4): if owner asks to move an existing meeting, `message_colleague` uses `intent='meeting_reschedule'` → `skills/meetingReschedule.ts` calls `updateMeeting` on approval (doesn't create a new event via coord).

---

## Security layers

1. **COLLEAGUE_ALLOWED_TOOLS** allow-list (`skills/registry.ts`) — deterministic gate.
2. **Rate limits** (`utils/rateLimit.ts` + orchestrator hooks) — colleague_coord 3/10min, colleague_any_tool 10/5min per sender+thread.
3. **Coord guard injection scan** (`utils/coordGuard.ts`) — regex on last 5 user messages.
4. **Coord guard LLM judge** (Sonnet) — subject, participant plausibility, coherence.
5. **Owner auto-include for colleague-initiated coord** (1.4.3+) — colleague asks to coord without owner → owner silently injected.
6. **Security gate** on outgoing colleague replies — narrow regex + Sonnet rewriter + safe canned fallback.
7. **Claim-checker** on owner drafts — narrow Sonnet classifier, JSON output, owner-only. Retry with `tool_choice`. MPIM-aware.
8. **Date verifier** — regex + LLM bare-weekday pass + **v2.0 deterministic inline correction** when retry still wrong.
9. **Calendar scope rule** (prompt) — one specific event, never multi-day.
10. **Persona rules** (prompt) — colleagues never hear AI/bot/Claude/Anthropic/"my prompt".
11. **No internal plumbing in user-visible text** (v1.6.2+) — no `_ref:` tokens; security-gate and claim-checker diagnostics never surface in Slack.
12. **Image guard** (v1.7.1) — Sonnet image-text injection scanner. Owner path: log + shadow-notify, proceed.
13. **Image scope owner-only in MPIM** (v1.7.1) — colleagues' images silently dropped.
14. **Prompt RULE 2b** (v2.0) — your prior replies are commitments; don't re-ask for info you already stated.
15. **create_meeting cross-turn idempotency** (v2.0) — Graph pre-check for same subject+start (±2 min) before creating. Prevents duplicate events across retry loops.
16. **Tool-grounded fallback verbMap** (v1.8.13) — 45 entries + safe generic default. Raw tool names can never leak.
17. **Shared message dedup** (v1.8.14) — `processedDedup` Set shared between live handlers + catchUpMissedMessages. Prevents duplicate replies after reconnect.

---

## Recovery / silence-prevention (v1.7.3, verbMap v1.8.13)

Empty-reply path has TWO fallbacks before silence:

1. **Recovery summarizer pass:** when Sonnet finishes with no text, run one more grounded Sonnet pass with the conversation + tool history, asking for a one-sentence describe-or-NO_REPLY.

2. **Tool-grounded confirmation fallback:** if recovery also empty/`NO_REPLY` AND `toolCallSummaries.length > 0`, build human-ish confirmation from mapped tool verbs (v1.8.13: 45 entries + safe default `"handled a few things"`). Only triggers when actual tool work happened.

Together: owner gets feedback whenever Maelle did real work, even if Sonnet forgot to narrate. Silent-turn-with-no-tools still silences (better than fabricating).

---

## DB imports — CRITICAL

Always use top-level ES imports: `import { getDb, appendToConversation } from '../../db'`. Never `require('../db')` inside functions — path resolution differs silently.

## Skill boundary — CRITICAL (v2.0)

Skills import ONLY from `src/connections/types` + `src/connections/registry`. NEVER from `src/connectors/slack/*`. NEVER `app.client.*`. Task dispatchers follow the same rule. If you need a Slack-specific feature, either add it to the Connection interface or keep the code inside `src/connectors/slack/`.
