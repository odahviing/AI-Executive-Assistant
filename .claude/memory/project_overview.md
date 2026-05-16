---
name: Maelle Project Overview
description: High-level facts about the Maelle platform — stack, current version, key layers
type: project
---

Maelle is an AI executive assistant platform (**v2.8.3**) built in Node.js/TypeScript. Runs primarily on Slack, backed by Microsoft Graph (Outlook calendar), Anthropic Claude Sonnet 4.6 for reasoning (with optional Vertex AI provider via `LLM_PROVIDER` env var), SQLite via better-sqlite3. Per-user YAML profiles in `config/users/`. Multi-tenant: one deployment, N executives, one Slack app per assistant identity.

**Mission: agent that works as a human EA.** Filter for every decision: "would a real human EA do this?" — outranks speed, completeness, elegance.

**Runs under `npm run dev` on the owner's laptop** (PM2 + auto-build watcher are wired but currently OFF). Restart needed to pick up code changes. GitHub remains the bug data source.

## Where v2.8 landed
- **2.8.0**: stability rebaseline closing the 2.7 trilogy (requests spine + planMeeting engine + slot finder reform).
- **2.8.1**: Vertex prep, multi-window work hours (`schedule.work_hours: { day: [HH:MM-HH:MM, ...] }`), prompt-reduction modules F/E/C (honesty rules code-replaced via extended claim-checker + humanGate).
- **2.8.2**: location decision rewrite — `resolveLocation` rebuilt as a deterministic tree (day-type + party shape + owner hints). Preserve-on-move so existing event locations stick. Meeting room availability check. Teams URL as location field for online cases. Categories no longer drive location.
- **2.8.3**: new `venue` skill (external venue discovery + rank catalog with auto-save-on-book). 5 tool merges (`learn/forget/recall_preference` → `manage_preference`; routines → `manage_routine`; calendar issues → `manage_calendar_issue`; knowledge → `manage_knowledge`; `edit_task`+`cancel_task` → `update_task`). Owner-facing tools cut by 8.

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
