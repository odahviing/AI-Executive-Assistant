---
name: Maelle Project Overview
description: High-level facts about the Maelle platform — stack, current version, key layers
type: project
---

Maelle is an AI executive assistant platform (**v3.0.0**) built in Node.js/TypeScript. Runs primarily on Slack, backed by Microsoft Graph (Outlook calendar), Anthropic Claude Sonnet 4.6 for reasoning (with optional Vertex AI provider via `LLM_PROVIDER` env var), SQLite via better-sqlite3. Per-user YAML profiles in `config/users/`. Multi-tenant: one deployment, N executives, one Slack app per assistant identity.

**Mission: agent that works as a human EA.** Filter for every decision: "would a real human EA do this?" — outranks speed, completeness, elegance.

**Runs under `npm run dev` on the owner's laptop** (PM2 + auto-build watcher are wired but currently OFF). Restart needed to pick up code changes. GitHub remains the bug data source.

## Where v3.0 landed

Two-day cleanup pass closing a 76-bug overnight audit + scenario / morning-brief follow-ups. ~1,500 lines of dead code removed, ~1,500 lines of fixes added. No new capabilities — pure consolidation. Marks the cut-line between the 2.9 stabilization line and the WhatsApp work that follows on v3.x.

Key fixes by theme:
- **Security/privilege**: `manage_preference` added to ownerOnlyTools; `note_about_person` colleague-target rewrite now mutates in place (was a no-op); `searchPeopleMemory` excludes SELF rows.
- **Approval pipeline**: `getRequestByIdempotencyKey` finds closed rows (tombstone instead of crash); `runApproveCallback` runs sync before close + relays only on success; calendar-issue dismissals now stick (same `issue_key` shape on dismiss-side as on filter-side); `notifyOwnerOfColleaguePushback` appends rebuilt consequence on amend.
- **Booking pipeline**: `update_meeting` attendee-shape change re-evaluates location with `intent: 'new_booking'`; BookingRequest normalizer preserves handler's owner-in-MPIM `relaxed: true`; `confirm_outside_window` no longer mis-tags non-floating moves; `delete_meeting` seriesMaster guard runs before decline-and-relay; `coord/booking.ts` excludes moving event from conflict scan; `move_meeting` label map gained `owner_busy_collision`.
- **Work hours / floating blocks**: `relaxed`/`extendedHours` UNIONS widened default with native multi-window; rebalance honors `prefer_position` + skips out-of-window owner-pinned blocks + dedupes shadow notifications; DST-gap NaN guard in `findAlignedSlotForBlock`; `parseRange` normalizes 23:59 → 1440 so boundary minute is in-window.
- **Social engine**: rank-0 honored on proactive; cold-ping warm-reply now flips `outreach_jobs.status='replied'` so rank-check sees engagement; raise-pivot signal removed (option C — weekly decay handles aging); subject pivot post-silence deterministic; capture-pass write race fixed via `db.transaction(...).immediate()`; SELF row re-seeds if missing.
- **Dead code mass deletion**: legacy `core/approvals/resolver.ts` (581 lines, orphaned); `approvalExpiry` + `approvalReminder` dispatchers; `coordinate_meeting` stub case; legacy `engagement_level` from update_person_profile; no-op shims `logPersonInitiated` / `logMaelleInitiated`; `parseSocialTopics`; `lunch_bump` approval kind retired (single producer migrated to `policy_exception` + deferred-action replay).
- **Config leaks**: all baked owner-social-graph names → generic placeholders (Anna/Ben/Cara/...); real-shape Slack ID → fake; `resolveVenueByName` derives country from TZ; venue search lazy Anthropic client.
- **Operational tooling**: three new one-shot scripts (`cleanup-recent-orphan-requests`, `diagnose-duplicate-routine-fires`, `cleanup-orphan-system-calhealth-midday`). The last one is needed at v3 to stop a duplicate 13:00 calendar-health DM caused by an orphan system routine — run once with `--apply`, restart `npm run dev`.
- **Improvement tickets filed**: [#108](https://github.com/odahviing/AI-Executive-Assistant/issues/108) cross-midnight work_hours, [#109](https://github.com/odahviing/AI-Executive-Assistant/issues/109) category per floating_block, [#110](https://github.com/odahviing/AI-Executive-Assistant/issues/110) meeting prep skill (interview is one shape — sales / customer / board / 1:1 are others).

**Owner direction for the v3 line**: WhatsApp transport. Architecture is already ready (skills route through `getConnection(ownerId, 'slack')`, never import from `connectors/slack/*`).

## Four-layer model — don't violate
1. **Core (always on)**: `AssistantSkill` (memory), `OutreachCoreSkill`, `TasksSkill`, `CronsSkill`. Engine infra: orchestrator, background loop, task runner + dispatchers + materializer + lateness, approvals resolver, requests spine, `assistantSelf` / `ownerSelf`.
2. **Skills (togglable in YAML)**: `MeetingsSkill`, `CalendarHealthSkill`, `SummarySkill`, `KnowledgeBaseSkill`, `SearchSkill`, `SocialSkill`, `VenueSkill`. Registry at `skills/registry.ts`. Legacy YAML keys auto-migrate.
3. **Connections (outbound) + Connectors (inbound + non-messaging)**: `Connection` interface (sendDirect / postToChannel / etc.); SlackConnection only impl today, WhatsApp next. Skills NEVER import from `connectors/slack/*` — always `getConnection(ownerId, 'slack')`.
4. **Tools & Utilities**: claim-checker (honesty), date-verifier, securityGate, coordGuard, humanGate (mechanical-refusal scrub), shadowNotify, workHours, resolveLocation, resolveSlackId, audit log. `voice/` (TTS+STT), `vision/` (image input).

## Core invariants
- Skills NEVER import from `src/connectors/slack/*` or use `app.client.*`. Always resolve via Connection registry.
- Task system is the single source of truth for "what's on my plate" — `get_my_tasks` hydrates from linked tables; LLM never fills from memory.
- Requests spine (`db/requests`) is the work-item layer; legacy `tasks` / `approvals` / `outreach_jobs` / `coord_jobs` retained as internal state machines bridged via `request_id`.
- `planMeeting` is the single decision function for every scheduling intent (book / move / cancel / find). `resolveLocation` is the single location decision.
- `create_meeting` idempotent across turns (Graph pre-check ±2 min); `delete_meeting` idempotent per event_id per turn.
- Claim-checker over every owner draft; false claims trigger retry with `tool_choice` forcing the right tool.
- humanGate runs on owner-facing AND colleague-facing drafts — catches mechanical refusal phrasings.
- Empty orchestrator reply NEVER fabricates — verbMap tool-grounded fallback.
- Approval / coord / outreach rows always cascade-close on terminal status.

## Prompts vs code principle
Determinism → **code** (booking, location, rule checks, date alignment, slot search, approval sync, honesty signals). Judgment / tone → **prompt**. Don't cram determinism into prompts; don't cram judgment into regex. **Bug-fix flow**: understand → plan → suggest → build after owner feedback. Never auto-fix.

## Open architectural debt (deferred)
- Phase 3 cutover-finish (drop legacy `coord_jobs` / `outreach_jobs` / `approvals` tables) — owner direction: cleanup, not a blocker. v3 audit dropped a large chunk; full retirement deferred pending `coord/reply.ts` migration off `setApprovalDecision`.
- Phase B `BookingRequest` normalizer migration (move_meeting / coord / calendarHealth onto the normalizer; Phase A wired create_meeting + delete_meeting).
- Google Places migration for venue skill ([#96](https://github.com/odahviing/AI-Executive-Assistant/issues/96)).
- Per-floating-block category typed detection ([#109](https://github.com/odahviing/AI-Executive-Assistant/issues/109)).
- Cross-midnight work_hours support ([#108](https://github.com/odahviing/AI-Executive-Assistant/issues/108)).

## Known attacker
Ysrael Gurt (slack U0F28ES4V). Multiple injection attempts logged. Coord guard + security gate + image guard active.
