---
name: Maelle Architecture
description: Four-layer model, skills system, orchestrator loop, task pipeline, state machines, security layers
type: project
originSessionId: fd199f43-f9ab-495a-9013-017e7e191338
---
Architecture reference for Maelle **v1.8.4**. Mission: agent that works as a human EA. Prompts vs code principle: determinism → code (booking, delete, date, slot rules, approval sync); judgment/tone → prompt.

**Message flow:** Slack → `connectors/slack/app.ts` → `runOrchestrator()` → Claude tool loop → skills execute → `postReply.ts` (normalize → claim-check → date-verify → security gate → send) → reply.

---

## Runtime + deploy pipeline (v1.8.2)

**Runs under PM2 on the owner's laptop.** Two processes defined in `ecosystem.config.js`:

- `maelle` — main bot, runs `dist/index.js` (requires `npm run build` first)
- `maelle-deploy-watcher` — polls `origin/master` every 5 min via `scripts/deploy-watcher.mjs`. When `HEAD !== origin/master` AND any new commit's author is `Maelle Auto-Triage`: `git pull --ff-only` → `npm ci` (if lockfile changed) → `npm run build` → `pm2 restart maelle`. Owner's own commits are skipped (he deploys those himself by running the same commands locally).

Startup flow (one-time): `npm i -g pm2 pm2-windows-startup` → `pm2 start ecosystem.config.js` → `pm2 save` → `pm2-startup install` (Windows auto-start on reboot).

**Auto-triage + auto-build (GitHub Actions, v1.8.2 propose-only flow):**

1. **Issue opens with `Bug` label** (or `Bug` added later) → `.github/workflows/auto-triage-bug.yml` fires → `scripts/auto-triage-bug.mjs`:
   - Reads issue title + body + ALL comments (so Revise re-reads owner's feedback)
   - Downloads every GitHub user-attachments image URL using `GH_TOKEN` to `/tmp/triage-<issue>/img-N.<ext>` — agent uses Read tool on them
   - Invokes Sonnet with NO pre-injected repo context (anti-recency-bias) — agent must investigate from scratch
   - Five anti-recency guardrails in the system prompt: (a) no SESSION_STARTER.md pre-injection, (b) explicit rule against pattern-matching recent changelog/features, (c) root cause must name file + line/function + mechanism, (d) single-keyword causes require second independent signal or lower confidence, (e) post-verdict sanity-check pass (second tiny Sonnet call asks "does the cause match the symptoms?")
   - Outputs strict JSON: `{classification: NOT_A_BUG | BUG, complexity, confidence, summary, root_cause, files_likely_affected, plan, uncertainty}`
   - Never edits files. NOT_A_BUG → auto-close. BUG → posts plan as comment + labels `Proposed`.
2. **Owner labels `Revise` + adds comment with feedback** → triage re-fires, re-reads full comment thread, writes a new plan.
3. **Owner labels `Approved`** → `.github/workflows/auto-build.yml` fires → `scripts/auto-build.mjs`:
   - Finds the latest plan comment (contains `## Plan` marker, bot-authored)
   - Collects owner's follow-up comments posted after that plan
   - Writes `## Approved plan` block into issue body (locks the plan as part of issue record)
   - Invokes Sonnet to implement; `acceptEdits` permission, Read/Grep/Glob/Edit/Write/Bash tools
   - Safety floors: typecheck must pass, 200-line cap, forbidden-path allowlist, JSON output required. Any violation → revert working tree, post reason, remove `Approved`, add `Failed`, leave open.
   - Success → commit under `Maelle Auto-Triage` author, push, close issue with fixed-in-SHA comment. Laptop watcher picks up within 5 min.

**Labels:** `Proposed` (plan awaiting owner), `Approved` (build now), `Revise` (re-plan), `Failed` (build aborted — review manually), `Triaged` (loop guard, prevents re-fire).

**What this prevents:** the v1.8.0 wrong-fix (auto-triage closed a text-chat bug with a voice fix because it pattern-matched to the fresh changelog entry; see `60546e8` revert in v1.8.2 CHANGELOG). No auto-fixes ship unsupervised anymore; every real bug passes through owner approval; plans are grounded in code and sanity-checked; screenshots are actually inspected.

---

## Layer 1 — Core (always on)

`CORE_MODULES` in `skills/registry.ts`: `[AssistantSkill, OutreachCoreSkill, TasksSkill, CronsSkill]`.

### Skill-interface core modules
- `src/core/assistant.ts` — MemorySkill (v1.6.1 name-wise it's still class `AssistantSkill` but scope is memory-only). Tools: learn_preference, forget_preference, recall_preferences, recall_interactions, note_about_person, update_person_profile, log_interaction, confirm_gender. DB tables: `user_preferences`, `people_memory`.
- `src/core/assistantSelf.ts` — (v1.6.2) seed + format helpers for Maelle's own people_memory row, keyed on synthetic `SELF:<ownerSlackId>`. `seedAssistantSelf(profile)` at startup; `formatAssistantSelfForPrompt(profile, includeMutationHint)` renders the ABOUT YOU block (first person) into both owner and colleague system prompts. Excluded from `formatPeopleMemoryForPrompt` so she doesn't appear as her own contact.
- `src/core/outreach.ts` — OutreachCoreSkill (v1.6.1, extracted from assistant). Tools: message_colleague, find_slack_channel. DB: `outreach_jobs` + task side-effects (outreach_send / outreach_expiry).
- `src/tasks/skill.ts` — TasksSkill. Tools: create_task, edit_task, get_my_tasks, cancel_task, get_briefing, send_briefing_now, create_approval, resolve_approval, list_pending_approvals, store_request, get_pending_requests, resolve_request, escalate_to_user. DB: `tasks`, `approvals`, `pending_requests`, `approval_queue`.
- `src/tasks/crons.ts` — CronsSkill (Routines). Tools: create_routine, get_routines, update_routine, delete_routine. DB: `routines` (+ `never_stale` column).

### Engine infra (non-Skill)
- `src/tasks/runner.ts` — 68-line loop: pick due tasks, look up dispatcher in `dispatchers/index.ts`, call it. v1.6.3 split: each TaskType has its own file under `src/tasks/dispatchers/` (reminder, followUp, research, routine, outreachSend, outreachExpiry, coordNudge, coordAbandon, approvalExpiry, calendarFix) + shared `types.ts`.
- `src/tasks/routineMaterializer.ts` — converts routine firings → tasks; UNIQUE(routine_id, due_at).
- `src/tasks/lateness.ts` — cadence-based skip thresholds.
- `src/core/orchestrator/index.ts` — Claude tool loop, system prompt assembly, rate limiting + coord guard for colleague path.
- `src/core/orchestrator/systemPrompt.ts` — date/time, prefs, people memory, week boundaries, persona rules, pending approvals section (v1.5).
- `src/core/background.ts` — single 5-min timer: `materializeRoutineTasks` → `runDueTasks`. Startup: ensureBriefingCron, catchUpMissedMessages, orphan-approval backfill (30s delay).
- `src/core/approvals/resolver.ts` — single entry for owner decisions. Freshness re-check via `getFreeBusy` before booking.
- `src/core/approvals/orphanBackfill.ts` — one-time startup sweep recovering pre-v1.5 stuck `waiting_owner` coords.

### Persona
Not a module — lives as data in `config/users/<name>.yaml` (`assistant.name`, `user.name`, `company_brief`) and assembled inline by `buildSystemPrompt()` in `orchestrator/systemPrompt.ts`.

---

## Layer 2 — Skills (togglable)

Loaded via `skills/registry.ts` based on YAML `skills: { meetings: true, ... }`. Legacy YAML keys auto-migrate at load time: `scheduling` / `coordination` → `meetings`, `meeting_summaries` → `summary` (v1.7.6), `knowledge_base` → `knowledge` (v1.7.6), `calendar_health` → `calendar` (v1.7.6).

- `src/skills/meetings.ts` — MeetingsSkill. Owns every calendar-touching tool: get_calendar, analyze_calendar, dismiss_calendar_issue, get_free_busy, find_available_slots, create_meeting, move_meeting, update_meeting, delete_meeting, find_slack_user, coordinate_meeting, get_active_coordinations, cancel_coordination, finalize_coord_meeting, check_join_availability. Delegates direct-ops case handlers to the private `_LegacyOpsSkill` in `_meetingsOps.ts`. Its `getSystemPromptSection` owns the meeting-specific rules that were moved out of the base prompt in v1.6.13: MEETINGS HONESTY RULES (never lie about bookings, scheduling state requires tool call, don't summarize unresolved, calendar specifics), DELETE-MEETING PROTOCOL, SLOT START TIMES quarter-hour rule, OPTIONS QUESTIONS → find_available_slots, OUT-OF-WINDOW flag-then-ask, HARD SCHEDULE numbers (office/home hours, lunch, buffer, allowed durations, free-time thresholds per day type).
- `src/skills/calendarHealth.ts` — CalendarHealthSkill. Tools: check_calendar_health, book_lunch, set_event_category, get_calendar_issues, update_calendar_issue. When owner marks an issue `to_resolve`, schedules a `calendar_fix` task due +1 day.
- `src/skills/general.ts` — SearchSkill. Tools: web_search, web_extract (Tavily).
- `src/skills/research.ts` — ResearchSkill. Owner-only; no tools of its own, reuses web_search.
- `src/skills/knowledge.ts` — KnowledgeBaseSkill (v1.7.4). Profile YAML key `knowledge_base`. Tools: `list_company_knowledge`, `get_company_knowledge(section_id)`. Auto-discovers `.md` files in `config/users/<owner_first_name>_kb/` recursively. Catalog injected via `getSystemPromptSection` (~80 tokens). 32KB cap per section. Path-traversal protected. Exports `selectRelevantKbForMeeting(profile, subject, transcript_opening, anthropic)` for SummarySkill's Stage 1 KB-relevance pre-pass (cross-skill import is one-way: SummarySkill → KB, never reverse).
- `src/skills/summary.ts` — SummarySkill (v1.7.2 + v1.7.3 hardening). Profile YAML key `meeting_summaries`. Tools: `classify_summary_feedback` (MULTI-INTENT in 1.7.3 — returns array of STYLE_RULE/DRAFT_EDIT/SHARE_INTENT/UNRELATED, plus `_action_plan` and `_must_reply_with` directives), `learn_summary_style`, `update_summary_draft`, `share_summary`, `list_speaker_unknowns`. Plus exported helper `ingestTranscriptUpload` called from the Slack DM `file_share` branch when a `.txt` arrives. Owns 3-stage state machine (Drafting → Iterating → Sharing) with persistence via `src/db/summarySessions.ts`. NEVER imports from `coordinator.ts` or `outreach.ts` — uses the new `src/connections/slack/messaging.ts` shim instead. Calendar reads via `connectors/graph/calendar.ts` directly (Layer 4 utility, not a MeetingsSkill function). v1.7.3: when active iterating session exists for thread, orchestrator caller (app.ts) sets `forceToolOnFirstTurn: 'classify_summary_feedback'` so Sonnet can't default to `learn_preference`; calendar candidate JSON parse tolerates prose via regex extraction of first `{...}` block.

### Internal (not a loadable skill)
- `src/skills/_meetingsOps.ts` — direct calendar-op case handlers + `processCalendarEvents` + `analyzeCalendar` exports (used by runner's calendar_fix dispatcher). `SchedulingSkill` class kept for MeetingsSkill delegation; not registered; underscore prefix signals "internal helper."

### Registry machinery
- `src/skills/registry.ts` — CORE_MODULES hardcoded, togglable skills lazy-loaded via require() under loader keys.
- `src/skills/types.ts` — `Skill` interface, `SkillContext`, `SkillId`, `CoreModuleId`, `ChannelId`, `Channel` (unused — placeholder for future Connection interface).

### COLLEAGUE_ALLOWED_TOOLS
`find_slack_user, get_calendar, get_free_busy, find_available_slots, store_request, coordinate_meeting, check_join_availability, web_search`. Technical allow-list, not prompt-only.

---

## Layer 3 — Connections

No formal `Connection` interface yet — hand-wired per surface. 1.7 work.

- `src/connectors/slack/app.ts` — Slack Bolt app setup, message event router, action dispatcher, security gate invocation, catchUpMissedMessages orchestrator call.
- `src/connectors/slack/coord.ts` — **1244 lines, still domain-muddled.** Contains the coord state machine (`initiateCoordination`, `handleCoordReply`, `resolveCoordination`, ping-pong, renegotiation). v1.6.3 size-only split pulled helpers into:
  - `coord/utils.ts` — determineSlotLocation, interpretReplyWithAI, isCoordReplyByContext
  - `coord/approval.ts` — emitWaitingOwnerApproval
  - `coord/booking.ts` — bookCoordination, forceBookCoordinationByOwner
  coord.ts re-exports the public symbols (forceBookCoordinationByOwner, emitWaitingOwnerApproval, determineSlotLocation, SlotWithLocation). The full agent-vs-transport split (coord state → skills/meetings/, new Connection interface so Slack/email/WhatsApp all work) is the 1.7 target.
- `src/connectors/slack/coordinator.ts` — ~550 lines. Outreach reply classifier + handler (`handleOutreachReply`, `processOutreachReply`, `isOutreachReplyByContext`), `calcResponseDeadline`, Slack utility funcs (findSlackUser, findSlackChannel, postToChannel, openDM). Also domain-muddled — outreach reply classification is meetings-adjacent logic on the Slack transport.
- `src/connectors/slack/relevance.ts` — message-relevance classifier.
- `src/connectors/graph/calendar.ts` — Graph API: events CRUD, free/busy, slot rules (thinking time, lunch protection, per-day hours). `createMeeting` returns Graph event id used for coord idempotency.
- `src/connectors/whatsapp.ts` — placeholder.
- `src/connections/slack/messaging.ts` (v1.7.2) — minimal Slack messaging shim. `sendDM(app, token, userId, text)`, `sendMpim(app, token, userIds, text)`, `postToChannel(app, token, channelId, text)`, `findUserByName(app, token, query)`, `findChannelByName(app, token, query)`. Fire-and-forget — does NOT create `outreach_jobs` rows or track replies. SummarySkill is the first consumer; foundation for the issue #1 Connection-interface migration that will eventually port outreach.ts and coord.ts to the same primitives.

---

## Layer 4 — Tools & Utilities

- `src/voice/` — Slack audio in/out. `transcribeSlackAudio` (Whisper via OpenAI, ffmpeg WAV conversion), `textToSpeech` (gpt-4o-mini-tts), `sendAudioMessage`, `shouldRespondWithAudio`. Voice transcribes-then-discards (text-only forward).
- `src/vision/` (v1.7.1) — Slack image in. `downloadSlackImage` (validates jpeg/png/gif/webp + 5MB cap), `buildImageBlock` (emits Anthropic `image` content block). Native multimodal — Sonnet sees the bytes directly via `OrchestratorInput.images?: Anthropic.ImageBlockParam[]`. Owner-only in DM + MPIM (colleagues' images dropped silently). Conversation history persists `[Image] caption` placeholder via `processMessage`'s history append; bytes never stored. Cap of 4 images per file_share.
- `src/utils/logger.ts` — winston + daily-rotate-file (7 days maelle.log, 30 days error.log).
- `src/utils/securityGate.ts` — narrow-regex triggers on colleague-facing replies + Sonnet rewriter; safe canned fallback on UNFIXABLE. Never runs for owner replies.
- `src/utils/claimChecker.ts` (v1.6.2 — replaced the old `replyVerifier.ts`) — narrow Sonnet classifier, strict JSON, OWNER path only. Detects false action claims ("I sent it" when no send ran). Called from `postReply.ts` after every owner draft. On detection, `app.ts` re-invokes `runOrchestrator` with a corrective nudge + (for message-type claims) `forceToolOnFirstTurn: { name: 'message_colleague' }` which sets Anthropic `tool_choice` to force the tool call. Fails open on parse/API errors.
- `src/utils/dateVerifier.ts` (v1.6.6) — builds the same 14-day weekday/date lookup the system prompt uses; scans drafts for "Weekday N Mon" patterns (EN + HE). On mismatch vs the lookup, `postReply.ts` retries the orchestrator with a corrective nudge listing the wrong pairs. Runs on BOTH owner and colleague paths. Fails open.
- `src/utils/coordGuard.ts` — injection-pattern scan + Sonnet LLM judge for `coordinate_meeting` on colleague path. SUSPICIOUS → refuse + shadow-notify.
- `src/utils/imageGuard.ts` (v1.7.1) — Sonnet image-text injection scanner. Strict-JSON output. v1.7.1 owner path: log + shadow-notify but proceed. Designed to flip to refuse-and-notify when colleague paths open (single switch, no re-architecture). Fails open on parse / API errors.
- `src/utils/rateLimit.ts` — sliding-window in-memory limits.
- `src/utils/genderDetect.ts` — pronouns → image → Sonnet-based name classifier. Never overwrites `gender_confirmed=1`.
- `src/utils/shadowNotify.ts` — v1 QA receipts.
- `src/utils/slackFormat.ts` — normalizeSlackText (`**` → `*`, strip `##`, leading `- `). Apply at every LLM→Slack post site.
- `src/utils/addresseeGate.ts` — MPIM addressing check.
- `src/db/` — barrel + per-table helpers (client, people, preferences, conversations, jobs, events, requests, calendarIssues, approvals).
- `src/config/` — profile loader (zod schema) + env.

---

## Task pipeline (v1.6 unified, split in v1.6.3)

Every background activity is a typed task with a `due_at`. Background loop (core/background.ts): **`materializeRoutineTasks(profiles) → runDueTasks(app, profiles)`**, every 5 min.

`tasks/runner.ts` is a thin 68-line dispatch loop. Each TaskType has its own dispatcher file under `src/tasks/dispatchers/` with a registry map in `dispatchers/index.ts`. Adding a new task type = add a dispatcher file + register it; no runner edits.

| TaskType | Creator | Dispatcher (runner.ts) |
|---|---|---|
| reminder | create_task tool | DM owner or target at due_at |
| follow_up | create_task tool | DM owner |
| research | create_task tool | Runs through orchestrator |
| routine | materializeRoutineTasks | Runs routine prompt; skips silently if past cadence threshold |
| outreach_send | message_colleague (future send_at) | Post DM, flip outreach_jobs sent, queue outreach_expiry if awaiting reply |
| outreach_expiry | message_colleague / outreach_send | First expiry: follow-up + re-queue +3wh. Second: if outside owner work hours (per `schedule.office_days`+`home_days`), re-queue self for `nextOwnerWorkdayStart`. Otherwise mark `no_response` + notify owner. (v1.8.0) |
| coord_nudge | initiateCoordination | DM non-responders, queue coord_abandon +4h |
| coord_abandon | coord_nudge dispatcher | Abandon coord + notify owner |
| approval_expiry | createApproval | Expire approval, cascade task→cancelled + coord→abandoned + notify |
| calendar_fix | update_calendar_issue (to_resolve) | Re-check in 1 day; auto-resolve if gone, re-ping + re-queue if still there |
| summary_action_followup | share_summary (Stage 3) | At due_at, Sonnet composes a one-line check-in DM in target's preferred language, sends via messaging shim, creates `outreach_jobs` row + `outreach_expiry` task so reply routes back to owner via existing `handleOutreachReply` |

`tasks.skill_origin` column tags each row with its creator skill.

---

## Approvals (v1.5+)

First-class structured decisions in `approvals` table, always under a parent task.

- **Kinds:** slot_pick, duration_override, policy_exception, lunch_bump, unknown_person, calendar_conflict, freeform
- **Statuses:** pending | approved | rejected | amended | expired | superseded | cancelled
- **Resolver** (`core/approvals/resolver.ts`): single entry for decisions. Freshness re-check for slot_pick via `getFreeBusy`. Superseded → creates calendar_conflict follow-up.
- **amend** is first-class: owner says "no but 1:30 works" → counter recorded → orchestrator relays back to requester next turn.
- **No buttons.** Pending approvals injected into owner system prompt (subject + kind + timing + thread); Sonnet picks the right approval by matching subject/timing/thread and calls `resolve_approval`. v1.6.2 removed the visible `_ref: #appr_<id>_` token — orchestrator binds from the injected list alone.
- **Expiry:** driven by `approval_expiry` task, not a sweep.
- **Idempotency:** hash(task_id + kind + payload) UNIQUE on creation; `coord_jobs.external_event_id` short-circuits double-booking.
- **Requester loop:** `coord_jobs.requesters` JSON column. On booked/expired, requesters who aren't participants get a structured DM.

---

## Coord state machine (coord.ts, muddled)

- Table: `coord_jobs`. Statuses: collecting | resolving | negotiating | waiting_owner | confirmed | booked | cancelled | abandoned.
- DMs key participants with up to 3 slot options + location per slot → collect → resolve best → book.
- just_invite participants: added to calendar invite only, no DM, no vote.
- Location auto-determined per slot: office day ≤3→Office+Teams, >3→Room+Teams; home day internal→Huddle, external→Teams.
- `emitWaitingOwnerApproval` helper: every place that parks a coord in `waiting_owner` creates a structured approval instead of a raw owner DM.
- `handleCoordReply` follow-up branch handles post-vote follow-ups without re-running resolveCoordination.
- MPIM coord (in-group): contacted_via='group', voting happens in the MPIM thread instead of DMs.

---

## Security layers

1. **COLLEAGUE_ALLOWED_TOOLS** allow-list (`skills/registry.ts`) — deterministic gate.
2. **Rate limits** (`utils/rateLimit.ts` + orchestrator hooks) — colleague_coord 3/10min, colleague_any_tool 10/5min per sender+thread.
3. **Coord guard injection scan** (`utils/coordGuard.ts`) — regex on last 5 user messages.
4. **Coord guard LLM judge** (Sonnet) — subject quality, participant plausibility, conversation coherence. SUSPICIOUS → refuse + WARN log.
5. **Owner auto-include for colleague-initiated coord** (1.4.3+) — replaces the old two-layer refuse. Colleague asks to coord without owner → owner silently injected.
6. **Security gate** on outgoing colleague replies — narrow regex + Sonnet rewriter + safe canned fallback. v1.6.2: events go to WARN log only (no Slack shadow dump).
7. **Claim-checker** on owner-facing drafts (v1.6.2, replaces reply verifier) — narrow Sonnet-backed classifier, strict JSON output, owner-only. On false-claim detection, app.ts re-invokes orchestrator with corrective nudge + (for message-type claims) `tool_choice: message_colleague` forcing the actual send. Fails open. v1.7.5 hardened: prose-tolerant JSON parse (regex extracts first `{...}` block if Sonnet adds prose preamble); MPIM-aware via new `mpimContext: {isMpim, participantSlackIds}` field — `<@USER>` mentions of MPIM participants are recognized as legitimate in-room addressing, not phantom sends.
8. **Calendar scope rule** (prompt) — one specific event, never multi-day.
9. **Persona rules** (prompt) — colleagues never hear AI/bot/Claude/Anthropic/"my prompt".
10. **No internal plumbing in user-visible text** (v1.6.2) — `_ref: #appr_<id>_` token no longer appended to approval DMs; security-gate and claim-checker diagnostics never surface in Slack; shadowNotify reserved for genuine action receipts (booking confirmations), not for meta-commentary on replies.
11. **Image guard** (v1.7.1) — every image (owner-only path today) passes through Sonnet `scanImageForInjection`. Suspicious finds logged + shadow-notified to owner; proceed regardless on owner path. Hooks ready to flip to refuse-and-notify when colleague image paths open.
12. **Image scope owner-only in MPIM** (v1.7.1) — colleagues' image file_shares in group DMs are silently dropped, blocking the image-text injection vector until a Connection-level guard policy lands.

---

## Recovery / silence-prevention (v1.7.3)

The orchestrator's empty-reply path now has TWO fallbacks before silence:

1. **Recovery summarizer pass** (existed): when Sonnet finishes a turn with no text, run one more grounded Sonnet pass with the conversation + tool history asking it to describe what happened in one sentence (or write `NO_REPLY` if it can't).

2. **Tool-grounded confirmation fallback** (v1.7.3 new): if the recovery pass also produces empty/`NO_REPLY` AND `toolCallSummaries.length > 0`, build a human-ish confirmation directly from the tool names that ran (`learn_summary_style` → "saved the style preference", `update_summary_draft` → "updated the summary", etc.) — "Done — saved the style preference and updated the summary. Let me know if anything's off." Only triggers when actual tool work happened; pure no-tool/no-text turns still silence (better than fabricating "Done." for nothing).

Together: the owner gets feedback whenever Maelle did real work, even if Sonnet forgot to narrate it.

---

## DB imports — CRITICAL

Always use top-level ES imports: `import { getDb, appendToConversation } from '../../db'`. Never `require('../db')` inside functions — path resolution differs silently.
