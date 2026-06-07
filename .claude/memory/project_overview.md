---
name: Maelle Project Overview
description: High-level facts about the Maelle platform — stack, current version, key layers
type: project
---

Maelle is an AI executive assistant platform (**v3.3.1**) built in Node.js/TypeScript. Runs primarily on Slack, backed by Microsoft Graph (Outlook calendar), Anthropic Claude Sonnet 4.6 for reasoning (with optional Vertex AI provider via `LLM_PROVIDER` env var), SQLite via better-sqlite3. Per-user YAML profiles in `config/users/`. Multi-tenant: one deployment, N executives, one Slack app per assistant identity.

**Mission: agent that works as a human EA.** Filter for every decision: "would a real human EA do this?" — outranks speed, completeness, elegance.

**Runs under `npm run dev` on the owner's laptop** (PM2 + auto-build watcher are wired but currently OFF). Restart needed to pick up code changes. GitHub remains the bug data source.

## v3.3.1 — audit hardening + calendar-health auto-move

Consumed the critical/high waves of an 8-subagent propose-only audit (`.claude/V3_3_0_AUDIT_HANDOFF.md`, ~80 findings). Highlights: `update_my_preferences` enum gained `'news'` (the whole news teach-vs-ask was server-rejected before — assistant.ts:341); channel rate-limit notice no longer leaks top-level (CH-1); thread-action owner-presence gate now uses a recent-tail window, not all-history (T-5); `addresseeGate` + `humanGate` flipped Sonnet→Haiku (PERF-1/4); `categories?: string[]` on the canonical Graph event type erased 16 casts (TS-6). **News:** seen-log write is now per-profile-mutexed (N-2), `todayStamp`/`keepFrom` owner-local (N-3), on-demand `news()` derives today's meeting companies (N-4), and the **source-steer parser was removed** — `news.md` is LLM-only free text, code does NOT parse it (M-7); plus seen-log semantic dedup (write pass sees the existing log, skips already-covered). **Calendar-health overlap autofix REWRITTEN** (the recurring "waiting on X" orphan): for an internal-only movable meeting it now MOVES directly to a verified-free **in-week** slot (no in-week slot → surfaces to owner, doesn't move) and notifies the attendee via a `meeting_reschedule(already_moved)` notice → pushback routes back to the owner with a revert option (`calendarHealth.ts` overlap path + `meetingReschedule.ts`). Root cause of the orphan: `initiateCoordination` built participants from calendar attendees (email, no slack_id) and never resolved one, so the colleague was never DM'd — now resolves email→slack_id (`coord/state.ts`). Idempotency guard blocks a duplicate move while a notice is open.

## v3.3 — news + thread actions (two new capabilities)

- **News skill** (`skills/news.ts`, togglable `skills.news`, default off): `gatherNews(profile, opts)` — the shared core for the on-demand `news(topic?)` tool AND the morning brief's grounded, cited "Updates" section. ONE lightweight Tavily search per goal (no per-article extraction — cost fix), goals capped (~4), per-goal timeout, **never throws** (brief fail-opens). Interests + preferred/blocked domains taught via `update_my_preferences(skill='news')` → `config/users/<owner>_prefs/news.md` (a code parser reads only the `Preferred sources:` / `Blocked sources:` lines; LLM owns the file). Brief-derived meeting companies come **read-only** from today's attendees (`getPersonByEmail`, never `resolvePerson` — no row writes). Topic-level dedup via a rolling 7-day MD seen-log `config/users/<owner>_news_seen.md` (self-dedupes on write). `runResearch`/`tavilySearch` gained an optional `{includeDomains,excludeDomains}` (backward-compatible) — the DEEP `web_research` path is unchanged; news uses the SHALLOW path. `web_research` now mapped to the `knowledge` tool-scope (was unmapped → shipped every turn).
- **Thread actions** (`core/threadActions/index.ts`, wired in `app.ts` `app_mention`): @mention in a real-channel **mid-thread** → **owner-presence gate** (`ownerPostedInThread` OR sender-is-owner; else silent — the trust control), classify book/follow_up/other, build a code-derived roster + VIP split, inject a directive executed through the existing coord/outreach/news engines. Channel-blindness drops preserved (the `message` handler at `app.ts:~1516/1521`); the ephemeral read does NOT upsert participant rows (invariant 9). MPIM + start-of-thread paths unchanged. `app_mention` now passes `isExplicitMention` → skips the addressee gate (an @mention is unambiguously addressed).
- **`people_memory.is_vip`** (INTEGER default 0): owner-only via `update_person_profile(vip)`. Seed for the full VIP feature (#58).
- **Proactive-social scoring redesign**: ignoring a coda is free; `engagement_rank` moves only on a live reply (`adjustRankFromColleagueResponse`, anchored on `last_initiated_at`). 48h `social_ping_rank_check` RETIRED. `raise_new` codas anchor to a concrete category. `reviveStaleRankZero` (rank-0 → 1 after 30 quiet days, in the weekly decay sweep). Capture pass never files WORK as a social subject.
- **Unfurl off** on Maelle's outbound (brief + replies + catch-up). **Catch-up** raw post now chunks long replies across ≤2900-char Slack section blocks (was crashing on Slack's 3000-char block limit). Coda claim-checker carve-out: subject-matter facts (a film's genre, a company's funding) are NOT "invented facts about the recipient."

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
