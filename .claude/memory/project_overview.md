---
name: Maelle Project Overview
description: High-level facts about the Maelle platform — stack, version, key layers, current state
type: project
originSessionId: fd199f43-f9ab-495a-9013-017e7e191338
---
Maelle is an AI executive assistant platform (**v2.5.0** — per-thread orchestrator queue + externals-first-class booking + per-turn calendar memoization + owner-said-done scanner + 12-bug coord-trace pass; v2.4.x = floating-block + preferences catalog; v2.0.0 = Connection interface) built in Node.js/TypeScript. **Mission: agent that works as a human EA.** Filter test for every decision: "would a real human EA do this?" — outranks speed, completeness, elegance. Runs primarily on Slack, backed by Microsoft Graph (Outlook calendar), Anthropic Claude Sonnet 4.6 for reasoning (Sonnet everywhere), SQLite via better-sqlite3. Per-user YAML profiles in `config/users/`. Multi-tenant: one deployment, N executives, one Slack app per assistant identity. **Runs under PM2 on the owner's laptop today** — two processes: `maelle` (the bot) and `maelle-deploy-watcher` (polls origin/master every 5 min, auto-pulls + rebuilds + restarts when a `Maelle Auto-Triage` commit lands; owner's own commits are skipped). PM2 ecosystem file at `ecosystem.config.js`.

**v2.0.0 closes issue #1 — Connection interface rollout.** Before: skills imported `@slack/bolt`, called `app.client.chat.postMessage` directly, coord state machine lived under `connectors/slack/coord*`. After: skills import only `connections/types` + `connections/registry`, resolve `getConnection(ownerId, 'slack')`, call `conn.sendDirect` / `conn.postToChannel`. Zero `@slack/bolt` imports anywhere under `src/skills/`. Coord state machine moved to `src/skills/meetings/coord/{utils,approval,booking,state,reply}.ts`. `shadowNotify`, coord dispatchers, every task dispatcher that sends messages — all via Connection registry. `SendOptions.threadTs` flows through to Slack's chat.postMessage. Core→skill dependency inverted via `core/approvals/coordBookingHandler.ts` registry pattern (MeetingsSkill registers on load, resolver calls through). This unlocks email + WhatsApp as additive transports — implement `Connection`, register at startup, zero skill changes. `_meetingsOps.ts` relocated to `src/skills/meetings/ops.ts`. Shared `utils/workHours.ts` (extracted from outreachExpiry) now used by coord_nudge + coord_abandon to defer owner DMs outside work hours. Shared `connectors/slack/processedDedup.ts` module fixes duplicate-reply bug: catch-up marks message ts as processed so live handler skips after Slack re-delivers.

**Polish fixes bundled in 2.0 wave (1.8.12 → 1.8.14):** thread-ts through Connection preserves v1.8.6 booking-confirm-in-original-thread behavior. Tool-grounded fallback verbMap expanded 11→45 entries + safe generic default (`"handled a few things"`) — raw tool names can never leak to users. `create_meeting` idempotent across turns — pre-checks Graph for existing event at same subject+start (±2 min tolerance), returns existing id instead of duplicating. Date verifier: post-retry re-verification with **deterministic inline correction** of wrong weekday tokens ("Thursday 24 Apr" → "Friday 24 Apr" when retry also fails). Prompt RULE 2b: your prior replies are commitments — stops Sonnet re-asking for emails/names it already stated.

**Four-layer model (don't violate):**

1. **Core (always on):** MemorySkill (`core/assistant.ts`), OutreachCoreSkill (`skills/outreach.ts`, in CORE_MODULES), TasksSkill (`tasks/skill.ts`), RoutinesSkill (`tasks/crons.ts`). Engine infra: orchestrator, background loop, task runner + dispatchers + materializer + lateness, approvals resolver + orphan backfill + **coordBookingHandler registry** (v2.0), `core/assistantSelf.ts`, `core/ownerSelf.ts`.

2. **Skills (togglable in profile YAML):** MeetingsSkill (`skills/meetings.ts` — direct ops + coord), `skills/meetings/ops.ts` (direct-op helper, former `_meetingsOps.ts`), `skills/meetings/coord/` (utils/approval/booking/state/reply — coord state machine, v2.0 location), CalendarHealthSkill, SearchSkill, ResearchSkill, SummarySkill (`skills/summary.ts`), KnowledgeBaseSkill (`skills/knowledge.ts`). Registry at `skills/registry.ts`. Legacy YAML keys auto-migrate: `scheduling`/`coordination` → `meetings`, `meeting_summaries` → `summary`, `knowledge_base` → `knowledge`, `calendar_health` → `calendar`.

3. **Connections (outbound, v2.0 first-class):** `connections/types.ts` — `Connection` interface (sendDirect/sendBroadcast/sendGroupConversation/postToChannel/findUserByName/findChannelByName + `SendOptions.threadTs`). `connections/registry.ts` — per-profile Map. `connections/router.ts` — 4-layer policy (inbound/preferred/per-skill/default). `connections/slack/messaging.ts` + `connections/slack/index.ts` — SlackConnection implementation. **Connectors (inbound + non-messaging):** `connectors/slack/` (Bolt app, postReply pipeline, relevance, `processedDedup.ts`, coordinator.ts still hosts outreach reply classifier — next port target), `connectors/graph/` (calendar backend — NOT a Connection), `connectors/whatsapp.ts` (placeholder; next Connection impl).

4. **Tools & Utilities:** `utils/claimChecker.ts` (honesty gate), `utils/dateVerifier.ts` (weekday/date + deterministic correction post-retry), `utils/securityGate.ts`, `utils/coordGuard.ts`, `utils/imageGuard.ts`, `utils/workHours.ts` (v2.0, shared), `utils/shadowNotify.ts` (resolves Connection via registry, v2.0), `utils/rateLimit.ts`, `utils/slackFormat.ts`, `utils/addresseeGate.ts`, `utils/genderDetect.ts`, `utils/logger.ts`. `src/voice/` (audio in/out), `src/vision/` (image input). `db/` has per-table helpers. `config/` has profile loader + env.

**Core invariants to never break:**

- Skills NEVER import from `src/connectors/slack/*` or use `app.client.*`. Always resolve via `getConnection(ownerId, 'slack')`. Task dispatchers follow the same rule.
- Task system is single source of truth for "what's on my plate" — `get_my_tasks` hydrates from linked tables. LLM never fills from memory.
- Coord-terminal → approval sync lives inside `updateCoordJob` (`db/jobs.ts`): ANY transition to booked/cancelled/abandoned auto-resolves pending approvals AND cancels approval_expiry tasks.
- `message_colleague` (skills/outreach.ts) and `initiateCoordination` (skills/meetings/coord/state.ts) do NOT write to people_memory. Operational state lives in operational tables.
- Find_available_slots enforces all schedule rules deterministically (work hours per day-type, lunch, thinking time per-office/home, quarter-hour alignment, NO buffer padding, meeting mode required: in_person | online | either | custom). Auto-expands up to 21 days.
- `delete_meeting` idempotent per event_id per turn (orchestrator-level). `create_meeting` idempotent across turns (Graph pre-check, v2.0).
- Empty orchestrator reply triggers recovery pass → tool-grounded fallback with safe verbMap. Never fabricate "Done" for nothing-happened turns.
- Claim-checker over every owner draft; false action claims trigger retry turn with `tool_choice` forcing the right tool.
- Date-verifier scans drafts for weekday/date pairs; mismatches vs 14-day lookup trigger corrective retry, then deterministic inline correction if retry also fails. Owner AND colleague paths.
- Catch-up marks message ts in shared `processedDedup` before replying — prevents duplicate live-handler reply after Slack re-delivers.
- Assistant never says "the system / force the slot / threshold / policy" when talking to the owner — narrate rules as HIS preferences.

**Prompts vs code principle:** determinism → code (booking, delete/create idempotency, date alignment, slot rules, approval sync); judgment/tone → prompt. Don't cram determinism into prompts; don't cram judgment into regex.

**Prompt sizes (v1.7.0 baseline):** owner ~12k tokens, colleague ~9k. Base prompt keeps identity + dynamic data + auth + general honesty rules 1-8 (+ 2b for self-committed facts, v2.0) + language + formatting + tone. Skill-specific rules live in each skill's `getSystemPromptSection`.

**Known attacker (recorded):** Ysrael Gurt (slack U0F28ES4V). Multiple injection attempts, two real breaches during testing pre-1.6.

**v2.x focus:**
- **Framework scalability.** Respect the layer boundary when adding capabilities. Skills through Connections; transports additive.
- **New features.** WhatsApp connector (first non-Slack Connection impl), email connector, `coordinator.ts` outreach-reply port (was sub-phase E), inbound workflows, meeting notes preparation. External QA starts now — more people testing, new bug classes expected.

**Before bumping version at session end:** `npm run typecheck` → must pass; update package.json; CHANGELOG entry; update memory files if something meaningful changed; README only if architecture or public-facing behavior changed.
