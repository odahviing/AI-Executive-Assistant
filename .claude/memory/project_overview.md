---
name: Maelle Project Overview
description: High-level facts about the Maelle platform — stack, current version, key layers
type: project
---

Maelle is an AI executive assistant platform (**v2.9.4**) built in Node.js/TypeScript. Runs primarily on Slack, backed by Microsoft Graph (Outlook calendar), Anthropic Claude Sonnet 4.6 for reasoning (with optional Vertex AI provider via `LLM_PROVIDER` env var), SQLite via better-sqlite3. Per-user YAML profiles in `config/users/`. Multi-tenant: one deployment, N executives, one Slack app per assistant identity.

**Mission: agent that works as a human EA.** Filter for every decision: "would a real human EA do this?" — outranks speed, completeness, elegance.

**Runs under `npm run dev` on the owner's laptop** (PM2 + auto-build watcher are wired but currently OFF). Restart needed to pick up code changes. GitHub remains the bug data source.

## Where v2.8 landed
- **2.8.0**: stability rebaseline closing the 2.7 trilogy (requests spine + planMeeting engine + slot finder reform).
- **2.8.1**: Vertex prep, multi-window work hours (`schedule.work_hours: { day: [HH:MM-HH:MM, ...] }`), prompt-reduction modules F/E/C (honesty rules code-replaced via extended claim-checker + humanGate).
- **2.8.2**: location decision rewrite — `resolveLocation` rebuilt as a deterministic tree (day-type + party shape + owner hints). Preserve-on-move so existing event locations stick. Meeting room availability check. Teams URL as location field for online cases. Categories no longer drive location.
- **2.8.3**: new `venue` skill (external venue discovery + rank catalog with auto-save-on-book). 5 tool merges (`learn/forget/recall_preference` → `manage_preference`; routines → `manage_routine`; calendar issues → `manage_calendar_issue`; knowledge → `manage_knowledge`; `edit_task`+`cancel_task` → `update_task`). Owner-facing tools cut by 8.

## Where v2.9 landed
- **2.9.0**: `BookingRequest` normalizer (Phase A) + 5 calendar-health real-day fixes + auto-resolve precondition (Module D guard) + build-signal discipline codified in SESSION_STARTER.
- **2.9.1**: Approval pipeline structural rebuild — callback table (`on_approve` / `on_reject` / `on_amend`) on every approval; amend ping-pong flips state to `awaiting_colleague` and relays counters; universal resolver replay set (`RESOLVER_REPLAY_TOOLS`). `update_meeting` gained `add_attendees`/`remove_attendees`. `is_online` opt-out on `create_meeting`. Yaml `night_shift` auto-merges into `work_hours`.
- **2.9.2**: Approval rebuild stabilizers (completeness gate, approval-bound thread tool-lock, re-ask revival, universal cleanup cascade to legacy coord/outreach tables, in-flight artifact cleanup on `create_meeting` success). Universal tool-call cache (`src/utils/toolCallCache.ts`). `movable: bool` on `protected[]` yaml. `find_available_slots.preferred_slot` param. `Private` → `Personal` category rename. Heavy bug bundle; regressions surfaced and tracked as #103 / #104.
- **2.9.3**: Closes #103 + #104. **Completeness gate deleted** (was forcing Sonnet into retry loops that ended in false-success claims to colleagues; `create_approval` trusts Sonnet the same way `create_meeting` does). **Floating-block rebalance now runs as a periodic sweep in active-mode `check_calendar_health`** + dead Path (a) inside `double_booking` removed (unreachable since the detector excludes floating blocks). **Calendar-health routine fires twice a day (07:30 + 13:00 weekdays)** via new multi-time `schedule_time` support — comma-separated `"HH:MM,HH:MM"` on the existing row, no new system cron. **End-of-chat person-memory capture pass** at `src/memory/capturePass.ts` — DM threads quiet 30+ min trigger a Haiku that extracts structured facts vs the colleague's current `profile_json` + `.md`, emits deltas only, writes DB → mirrors to `.md` sections. Speaker's `.md` content now renders inline in colleague-path system prompt (`MEMORY ON <NAME>` block). New `conversation_threads.captured_at` column. **Universal colleague-self rewrite** — all person-targeting tools on colleague-path silently retarget to requester (was: `not_permitted` refusal that killed Sonnet's response chain).
- **2.9.4**: Closes #105 + #106 + #107. Approval-flow honesty wave. **Booking-class approvals enforce `create_meeting`'s required-field contract** (`tasks/skill.ts`) — `policy_exception` payload must contain `subject` / `start` / `end` / `attendees` (same as create_meeting); handler validates and refuses with `missing_required_field` if any are missing, then auto-stamps `payload.deferred_action = { tool: 'create_meeting', args: {..., relaxed: true} }` so the resolver books deterministically on approve. **No new type — payload IS create_meeting's args shape**; single object, no sync. **Requester relay enriched** (`core/requests/resolver.ts`) — auto-populates `requester_name` from people_memory; reads `deferred_action.args.start` for concrete booked-time in body; renders in Hebrew when `profile_json.language_preference` indicates Hebrew; covers approve/reject/amend(question)/amend(counter) bodies. **Resolver DM threads under origin** — passes `{ threadTs: row.origin_thread_ts }` to `sendDirect` (DM path had the bug; MPIM path already correct), fixes the new-thread / thin-context hallucination chain. **`note_about_self` repurposed** (`skills/social.ts` + `core/orchestrator/systemPrompt.ts`) — owner-path now targets `SELF:<ownerSlackId>` (Maelle's row, visible in ABOUT YOU block everywhere); colleague-path semantics unchanged. Owner-self-hobbies path migrates to `note_about_person(colleague_name='<owner>')`. **IDENTITY block flipped** to consult ABOUT YOU before deflecting; saved identity facts answer questions, empty state honestly admits "Idan picked the name, never asked why" instead of fabricating. **Graceful UNIQUE collision** in `create_approval` handler — catches SqliteError, returns existing row with `reused_existing:true + hint`, ending silent-failure chain when Sonnet retries. **Privacy mask completion** — `processCalendarEvents` subject-mask now uses central `displaySubject` helper covering BOTH Outlook `sensitivity` AND yaml category `sets_sensitivity_private` paths. **All builds zero new tools.**

## Four-layer model — don't violate
1. **Core (always on)**: `AssistantSkill` (memory), `OutreachCoreSkill` (`skills/outreach.ts` — in CORE_MODULES), `TasksSkill`, `CronsSkill`. Engine infra: orchestrator, background loop, task runner + dispatchers + materializer + lateness, approvals resolver, requests spine, `assistantSelf` / `ownerSelf`.
2. **Skills (togglable in YAML)**: `MeetingsSkill`, `CalendarHealthSkill`, `SummarySkill`, `KnowledgeBaseSkill`, `SearchSkill`, `SocialSkill`, **`VenueSkill` (v2.9)**. Registry at `skills/registry.ts`. Legacy YAML keys auto-migrate.
3. **Connections (outbound, v2.0 first-class)**: `Connection` interface (sendDirect / postToChannel / etc.); SlackConnection only impl today. Skills NEVER import from `connectors/slack/*`; always `getConnection(ownerId, 'slack')`. **Connectors (inbound + non-messaging)**: `connectors/slack/*`, `connectors/graph/*`. WhatsApp / Email follow the Connection shape.
4. **Tools & Utilities**: claim-checker (honesty), date-verifier, securityGate, coordGuard, humanGate (mechanical-refusal scrub, v2.8.1), shadowNotify, workHours, resolveLocation, resolveSlackId, audit log. `voice/` (TTS+STT), `vision/` (image input).

## Core invariants
- Skills NEVER import from `src/connectors/slack/*` or use `app.client.*`. Always resolve via Connection registry.
- Task system is the single source of truth for "what's on my plate" — `get_my_tasks` hydrates from linked tables; LLM never fills from memory.
- Requests spine (`db/requests`) is the work-item layer; legacy `tasks` / `approvals` / `outreach_jobs` / `coord_jobs` retained as internal state machines bridged via `request_id`.
- `planMeeting` is the single decision function for every scheduling intent (book / move / cancel / find). `resolveLocation` is the single location decision; categories no longer influence location (v2.8.2).
- `create_meeting` idempotent across turns (Graph pre-check ±2 min); `delete_meeting` idempotent per event_id per turn.
- Claim-checker over every owner draft; false claims trigger retry with `tool_choice` forcing the right tool. Honesty rules 1/2/2b/2c/2d/3/5b/9 code-enforced via claim-checker (v2.8.1); 4/5/7/8 remain in prompt (judgment-class).
- humanGate runs on owner-facing AND colleague-facing drafts — catches mechanical refusal phrasings ("I don't have permission", `not_permitted` echoes).
- Empty orchestrator reply NEVER fabricates — verbMap tool-grounded fallback (45 verbs + safe default). Recovery LLM-pass was deleted in v2.8.1.
- `_meetings_, _approval_, _coord_` jobs always cascade-close on terminal status (`updateCoordJob` / `closeRequest`).

## Prompts vs code principle
Determinism → **code** (booking, location, rule checks, date alignment, slot search, approval sync, honesty signals). Judgment / tone → **prompt**. Don't cram determinism into prompts; don't cram judgment into regex. **Bug-fix flow**: understand → plan → suggest → build after owner feedback. Never auto-fix.

## Open architectural debt (deferred)
- Phase 3 cutover-finish (drop legacy `coord_jobs` / `outreach_jobs` / `approvals` tables) — owner direction: cleanup, not a blocker.
- humanGate doesn't force tool firing — colleague-path live in-the-moment fabrications still a pure model-behavior issue.
- Google Places migration for venue skill (#96).

## Known attacker
Ysrael Gurt (slack U0F28ES4V). Multiple injection attempts logged. Coord guard + security gate + image guard active.
