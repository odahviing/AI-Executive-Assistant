# Changelog

---

## 2.0.6 — scheduling + coord + briefing cleanup (post-2.0.5 bundle)

Rollup of the bug wave that followed the 2.0.5 restart — scheduling tool correctness, coord follow-up handling, invite plumbing, briefing delivery, and input-handling polish. Grouped as one patch to avoid version noise from per-bug bumps.

### Fixed — scheduling

- **`findAvailableSlots` now returns slots across multiple days.** The 15-min cursor walked chronologically and `.slice(0, 10)` kept the first 10 candidates. A single open morning produced 10+ hits before the cursor reached the next day → rest of the week silently dropped. Owner saw "all options on Sunday" when Mon/Tue/Thu were wide open. Walker now collects all valid slots per day into day-buckets; per-day post-processing picks up to 4 with **30-min preferred spacing** (owner's preference — "10, 10:30, 11:30, 14:00" > "10, 10:15, 10:30, 10:45"), falling back to 15-min only when strict 30-min gives fewer picks. Overall cap raised 10 → 30.
- **`analyzeCalendar` detects true meeting overlaps.** The analyzer had a back-to-back check but no overlap check — when a new meeting started BEFORE the previous one ended, the condition `evStart >= prevEndMin` filtered it out silently. Every real calendar conflict (e.g. FC & Capri 14:45–15:30 overlapping Fulcrum Product Sync 15:00) went unflagged. Now emits `{type: 'overlap', severity: 'high'}` with both subjects, times, and overlap duration.
- **Strict lunch semantics.** `hasLunch` used to be true whenever there was a free gap ≥30 min inside the lunch window. Sonnet narrated "lunch is covered" even when no lunch was booked. Now `hasLunch` is true ONLY when a lunch event exists. The `no_lunch` issue always fires when none exists and suggests a specific time based on the largest free gap in the lunch window: *"Want me to block 30 min at 12:30?"*.

### Fixed — coord & invites

- **Waiting-owner follow-ups no longer discarded.** `handleCoordReply` previously ack'd + shadow-logged any reply arriving after a coord entered `waiting_owner`, dropping the content. Now runs a tool_use Sonnet classifier with four outcomes: `counter` (new time — merges `counter_offer` onto the pending approval's payload AND DMs the owner directly), `cancel` (pending approval flipped to `cancelled`, coord cancelled, owner notified), `confirm` / `other` (prior ack + log). Observed trigger: Amazia replying "Monday 27 at 14:45" as a counter-offer was being silently thrown away.
- **Deterministic invite emails.** `coordinate_meeting` was receiving participant args with `name + slack_id` but no `email` (schema marks email optional). Graph's `createMeeting` sent invites with empty email strings → Outlook showed a red "unresolved recipient" circle AND silently dropped `just_invite` folk. Now fills missing emails from `people_memory` by `slack_id` (primary) or name (fuzzy) BEFORE proceeding. Refuses the tool call with a clear error if still missing. Deterministic — not a Sonnet judgment.
- **Thread-aware shadow notifications.** `shadowNotify` was routing the FIRST call per process to a standalone DM (cache empty on startup) and only threading subsequent calls that matched the cached channel. Now: if caller passes `channel + threadTs` and the channel is a Slack DM (id starts with 'D'), post there directly — no cache dance. Non-DM channels fall through to the owner's DM (security floor: colleagues never see shadow content). Yaml toggle `behavior.v1_shadow_mode` unchanged.
- `mergeApprovalPayload(id, patch)` helper in `db/approvals.ts` for shallow-merging fields into a pending approval's payload. Used by the counter-offer branch above.

### Added — input handling

- **Multi-file uploads.** Previously only the FIRST matching file of each type in a Slack upload was processed; the rest were silently dropped. Now every PDF / `.txt` / `.md` / audio file gets processed sequentially (not parallel — rate limits + deterministic thread order). Each file posts its own confirmation, prefixed `[N/M] filename:` when batched. Parity with the existing image handling (up to 4).

### Changed — error copy

- Error copy on transient Anthropic overload (529 `overloaded_error`) is now the human "quick coffee break" line: *"Quick coffee break, ping me again in a couple of minutes?"*. New `isOverloadError` helper detects 529 / overloaded_error and routes accordingly. Non-overload errors (classifier parse failures, download failures) keep their task-specific friendlier copy.

### Verified

- Stress-tests for the timezone fix and slot-diversity pass against the owner's live calendar for multiple meeting times. Scripts: `scripts/stress-test-timezone-fix.mjs`, `scripts/test-55min-slots.mjs`.

### Note on version policy

This is one patch for the whole session's bug wave — prior habit of bumping per individual fix (2.0.6→2.0.7→2.0.8→2.0.9 on a single session) inflates the version history. Going forward: bundle a session's fixes into one version.

---

## 2.0.5 — recovery-pass language mirror

### Fixed

- **[Language] Recovery pass ignored the "current turn wins" rule.** The empty-reply recovery pass in `core/orchestrator/index.ts` used its own system prompt that said *"SAME LANGUAGE firstName wrote in"* — ambiguous. With a Hebrew contact in the turn and an Israeli owner, Sonnet defaulted to Hebrew even when the owner's latest messages were English. Tightened the recovery prompt to mirror the base prompt's explicit rule: match the language of the owner's MOST RECENT message only, no inertia from names or subjects. Symptom: booking confirmation came back as *"יצרתי את הפגישה..."* after owner said "in person" in English.

---

## 2.0.4 — coord follow-up handler + timezone-fix stress test

Addresses the "Amazia keeps proposing times and Maelle keeps acting confused" episode. The coord follow-up handler was silently discarding any participant message that arrived after a coord entered `waiting_owner` — acking + logging to shadow only. So when Amazia replied with "Monday 27 at 14:45" as a counter-offer, nothing happened: the coord's `winning_slot` stayed on the conflicting Sun 11:00, the pending approval stayed stale, and the owner saw Maelle keep referencing the old pick.

### Fixed

- **[Coord] Waiting-owner follow-ups are no longer discarded.** `handleCoordReply` now runs a tool_use Sonnet classifier on any follow-up message, with four outcomes:
  - `counter` — participant proposes a NEW time. The pending approval's payload is merged with a `counter_offer: { iso, label, from_participant, received_at }` field (so it surfaces in the owner's system prompt via `getPendingApprovalsForOwner`), and the owner is DM'd directly with a human message: *"Amazia came back on Kickoff — now proposing Monday 27 Apr at 14:45 instead. Want me to take that, or suggest something else?"*. No more silent shadow-only logs for actionable counter-offers.
  - `cancel` — participant is pulling out. Pending approval flipped to `cancelled`, coord flipped to `cancelled`, owner DM'd.
  - `confirm` / `other` — prior behavior (ack + shadow log). No regression.
- New `mergeApprovalPayload(id, patch)` helper in `db/approvals.ts` for shallow-merging fields into a pending approval's payload. Used by the counter-offer branch above.

### Added

- `scripts/stress-test-timezone-fix.mjs` — reproduces the 2.0.3 timezone fix against the owner's live calendar for multiple meeting times (morning 11:00 vs afternoon 15:30). Both scenarios pass: real meetings correctly block, free time correctly available. Retained so the fix can be verified on demand.

---

## 2.0.3 — scheduling root-cause fix + briefing cleanup + hallucination rules

Addresses a wave of scheduling / briefing bugs. The big one: `findAvailableSlots` has been silently off by the owner's timezone offset since the coord feature existed — Graph's `getSchedule` returns busy slots in UTC (zoneless ISO), but the code parsed them as the owner's local timezone, so an 11:00 Israel meeting (08:00 UTC busy) looked free at 11:00. Verified against the actual production calendar. Plus a dense set of briefing cleanups, honesty-rule additions, and a new same-thread task continuity classifier.

### Fixed

- **[Scheduling] Timezone parse bug in `findAvailableSlots`.** Graph's `getSchedule` returns scheduleItems in UTC; the code at `connectors/graph/calendar.ts:431` and the approval freshness re-check at `core/approvals/resolver.ts:262` were parsing them with `{ zone: params.timezone }`, shifting every busy block by the offset. Now both parse as `{ zone: 'utc' }`. Reproduced and verified against the owner's live calendar for Sun 26 Apr — the 11:00 recurring meeting that was being ignored is now correctly excluded from returned slots.
- **[Briefing] Completed tasks re-surfacing for 7 days.** The briefing's "Recently completed tasks" block pulled every completed task in the last 7 days, every day. The `completed → informed` two-step existed in `tasks/index.ts` (via `markTaskInformed`) but the briefing never called it. Now it does — completed tasks surface ONCE in the next briefing, then flip to `informed` and drop.
- **[Briefing] Pronoun guessing from first names.** The briefing prompt gave Sonnet raw item JSON with no gender data; she guessed pronouns from names, often wrong on non-Western names (Amazia → "her"). Now `collectBriefingData` pulls `people_memory.gender` for every person and injects a `PEOPLE_GENDER` map into the system prompt with a rule: "use the map, never guess." Keyed by both full and first name.

### Added — honesty rules (base prompt, global across all skills)

- **RULE 2c — Never invent a recovery narrative.** When a booking returned a conflict, an approval parked, a tool errored, or a reply came back you didn't expect, describe what ACTUALLY happened per the tool output. No corrective fiction ("I hadn't actually sent anything yet" when you did, "she agreed" when state is waiting_owner). If you don't know the current state, ask. Triggered by the Kickoff coord episode where Sonnet invented a narrative instead of describing a detected calendar conflict.
- **RULE 2d — Close the loop when the owner handles it himself.** When the owner says "I posted it", "I sent the email", "I already decided", call `cancel_task` / `resolve_request` on the matching open task instead of just acknowledging. Stops stale tasks from re-appearing in the next morning's briefing.

### Added — task continuity classifier

- `src/core/taskContinuity.ts` — narrow Sonnet tool_use classifier hooked into the `create_task` handler in `tasks/skill.ts`. When the owner asks for a new task in a thread that already has open tasks, classifier decides `new` vs `follow_up_of` with confidence. On confident follow-up, `create_task` returns `{ created: false, would_duplicate: true, existing_task_id }` so Sonnet narrates continuation instead of creating a duplicate. Only fires for owner-path, same-thread requests. Cross-thread is always treated as new. Designed for the "couple of orders in one thread" pattern where replies / refinements were previously becoming separate tasks.

---

## 2.0.2 — KB ingestion + summary context fixes + engagement classifier

A dense patch. Maelle can now learn from PDFs, text files, and web pages — not just markdown files in a folder. Summary drafter finally sees the framing the owner types alongside a transcript. Social-topic quality upgrades moved from prompt judgment (fragile) to a deterministic post-turn classifier. Plus the day's cleanup: retired `work_life` from the social enum (mis-used for work activities, not emotions), purged orphan bare-subject rows, hardened the KB classifier against JSON parse failures, switched Tavily to advanced-depth extraction for SPA pages.

### Added

- Knowledge ingestion pipeline. `ingestKnowledgeDoc` in `src/skills/knowledge.ts` classifies content (transcript / knowledge_doc / other) via Sonnet tool_use with a schema (guaranteed JSON) and writes a condensed markdown section under `config/users/<owner>_kb/`. Merge-vs-sibling-vs-create decided per upload based on the existing catalog. Low-confidence cases return `ambiguous` and ask the owner instead of misfiling. `writeSection` + `nextSiblingId` + `sectionExists` helpers enforce safe-path semantics.
- File upload routing in `app.ts`. PDF (via `pdf-parse` v2 `PDFParse` class), `.txt`, `.md` all pass through the unified classifier. PDFs always route to KB; txt/md are transcript-or-knowledge depending on content. `knowledge: false` in profile triggers a polite refusal. `:thread:` reaction fires on every transcript/doc upload (was silently missing — file_share branch never reached the read-receipt code).
- `ingest_knowledge_from_url` tool on KnowledgeBaseSkill. Uses `tavilyExtract` under the hood. Distinct from `web_extract` which remains one-off research — this tool is for durable storage when the owner says "save this".
- Post-turn engagement classifier in `src/core/socialEngagement.ts`. When `note_about_self` / `note_about_person` fires with a subject, stashes a `PendingCheck` keyed on thread. On the next user message in that thread, a tiny tool_use classifier judges engagement (neutral / engaged / good) and upgrades quality via `recordSocialMoment` (monotonic upgrade already handled). Deterministic trigger, LLM for judgment — the right layering. 30-min TTL on pending checks.
- `scripts/recover-kb-reflectiz.mjs` — one-off recovery for the 13 Reflectiz URLs `web_extract`ed before the KB write path existed. Safe to re-run.
- `scripts/ingest-local-pdfs.mjs` — same shape for local PDF paths.
- `scripts/clean-social-topics.mjs` — one-shot DB cleanup, drops bare-subject rows and retroactively removes `work_life` entries. Ran once during wrap.

### Fixed

- Summary drafter now sees the owner's caption. `ingestTranscriptUpload` threads `caption` through to `draftSummaryFromTranscript` as `ownerCaption`, injected as "OWNER'S FRAMING FOR THIS SUMMARY" with an explicit rule that framing overrides default paragraph shape. Fixes: unresolved Speaker 1/2 when owner named them, topical framing ignored, action-item shape mismatch, attendee fabrication from calendar invitees.
- Calendar invitees no longer fabricated as attendees. `calBlock` now explicitly says "invited per Outlook — NOT a confirmation of who actually attended"; rule added that attendees must have actually participated per transcript or owner framing.
- Jointly-agreed next steps ("let's meet again") now default to the owner as assignee, not the other party.
- KB classifier swapped from free-form JSON in prompt to Anthropic tool_use with a strict schema. Previously failed with `SyntaxError: Expected ',' or '}'` on outputs with unescaped quotes in the `condensed_markdown` field.
- Tavily extraction switched to `extract_depth: advanced` in `tavilyExtract`. Basic mode was returning empty content for SPA-heavy pages (www.reflectiz.com/*); advanced mode handles client-side rendered content.
- Internal-leakage scrubber at the central output layer. Strips sentinel tokens (any `ALL_CAPS_SNAKE_CASE` — real prose never uses this shape) and all known tool names. Previous behavior let leaks like `"NO_ISSUES"` or `"the analyzer"` reach the owner's Slack when routine prompts instructed Sonnet to emit sentinels. Paired with a new base-prompt rule that forbids naming or paraphrasing tools / internal processes. Code handles verbatim leaks, prompt handles paraphrased ones.
- Two-stage KB ingest. Stage 1 classifies + proposes metadata via tool_use (short payload, no parse risk). Stage 2, only if the verdict is `knowledge_doc`, does a plain-text call for the condensed markdown. Previous one-stage version had the SDK throw `SyntaxError: Expected ',' or '}'` when Sonnet emitted malformed JSON inside the `condensed_markdown` arg string — the Anthropic SDK parses streamed tool_use args and chokes on unescaped chars. Splitting content generation out of JSON eliminates the parse surface.

### Refactor (layer hygiene — advances [#22](https://github.com/odahviing/AI-Executive-Assistant/issues/22))

- Split `src/utils/slackFormat.ts` into cross-cutting vs transport-specific:
  - `src/utils/textScrubber.ts` — `scrubInternalLeakage(text)`. Sentinel strip, tool name strip, hyphen → comma, whitespace cleanup. Transport-agnostic; email and WhatsApp will reuse it.
  - `src/connections/slack/formatting.ts` — `formatForSlack(text)`. Slack's `**`→`*`, `##` strip, `-` list prefix strip. Composes textScrubber + Slack dialect.
  - Old `utils/slackFormat.ts` deleted.
- **SlackConnection now auto-applies `formatForSlack` internally** on `sendDirect` / `sendBroadcast` / `sendGroupConversation` / `postToChannel`. Callers pass raw text; the Connection runs the full outbound pipeline (scrub → Slack dialect) before hitting `chat.postMessage`. Idempotent, so pre-formatting callers stay safe.
- **All skill / dispatcher / task / core outbound paths migrated from raw `app.client.chat.postMessage` to the Connection registry.** Every outbound call site now resolves `getConnection(profile.user.slack_user_id, 'slack')` and calls `conn.postToChannel` or `conn.sendDirect`. Migrated files: `skills/meetingReschedule.ts`, `tasks/briefs.ts`, `tasks/runner.ts`, `tasks/skill.ts` (approvals), all 9 dispatchers (`reminder`, `followUp`, `research`, `routine`, `outreachSend`, `outreachExpiry`, `approvalExpiry`, `calendarFix`, `summaryActionFollowup`), `core/approvals/orphanBackfill.ts`. Dispatchers that no longer needed `app` take `(_app, ...)` — signature preserved for the runner.
- **Only remaining core-layer raw `postMessage`** is the catch-up handler in `core/background.ts`, which renders Slack-specific `context` + `section` blocks for the "↩ Catching up on your message from <time>" caption. The Connection interface doesn't carry a blocks payload yet; the call is documented in place and flagged as follow-up under [#22](https://github.com/odahviing/AI-Executive-Assistant/issues/22). Everything else respects the four-layer rule: skills, dispatchers, and task code never import `@slack/bolt` or use `app.client.*`.

### Removed

- `work_life` from both `note_about_person` and `note_about_self` topic enums. Was consistently mis-used for work-activity logs (interviews, projects) instead of emotional work content. Work activity doesn't belong in social tracking; the owner's assistant has direct access to his calendar and email for logistics.

### Config

- `config/users/idan.yaml` — all togglable skills flipped to `true` (email_drafting, knowledge, proactive_alerts, whatsapp, search, research, calendar). Knowledge is a hard prerequisite for ingest; without it, upload is refused.
- `pdf-parse` v2 added.

### Invariants preserved

- KB write path enforces safe-path semantics (no `..`, no absolute paths, never escapes `config/users/<owner>_kb/`). `writeSection` mirrors the read-side guards.
- Skill boundary holds — knowledge.ts imports no `@slack/bolt`; ingest flow uses existing Slack client via file_share handler.
- Social-quality upgrade remains monotonic (neutral → engaged → good, never downgrade).

### Not changed

- URL ingestion is Sonnet-initiated, not pattern-matched. Keeps judgment in the prompt layer.
- Proactive social-nudge cron deferred. Maelle stays passive between threads; more topic variety requires more `note_about_self` calls on owner shares, not louder initiation logic.

---

## 2.0.1 — routine timing fix + triage-process hardening

Routines and tasks fire on their scheduled UTC day again. A SQL TEXT-comparison bug was silently skipping any routine/task/approval whose due time fell on the current UTC calendar day, so they fired at UTC midnight instead (03:00 local for UTC+3) — the symptom owner caught on the weekly LinkedIn routine. Separately, two triage-process failures from today: a plan extractor that stopped at the first markdown `---` inside the plan, and a workflow that didn't re-fire when a reopened issue was marked Bug.

### Fixed

- [#28: routines fire at wrong time](https://github.com/odahviing/AI-Executive-Assistant/issues/28) — SQLite `<=` on raw TEXT compared Luxon's T-separator ISO (`...T09:00:00.000Z`) against `datetime('now')`'s space-separator format. Byte-wise, `T`(0x54) > ` `(0x20), so same-UTC-day due times always looked still-in-the-future. Wrapped each column in `datetime()` in the five affected queries: `getDueRoutines`, `getTasksDueNow`, `getExpiredOutreachJobs` (reply_deadline), `getScheduledOutreachJobs`, `sweepExpiredApprovals`. No schema change.
- [#20: Maelle still overusing hyphens](https://github.com/odahviing/AI-Executive-Assistant/issues/20) — the prompt rule added in 678fac7 wasn't enough; Sonnet kept emitting `word - word` separators mid-sentence. Extended `normalizeSlackText` to replace ` - ` → `, ` deterministically on outbound Slack text. Belt-and-braces: prompt rule stays, post-processor guarantees it.

### Changed

- Auto-triage plan extractor — plans legitimately contain `---` section separators, but `auto-build.mjs` was slicing at the first `---` after `## Plan`, truncating multi-section plans. Emit `<!-- PLAN START -->` / `<!-- PLAN END -->` sentinels in the triage comment and slice between them. Falls back to old behavior if sentinels are missing (older comments). This is what broke the #28 build.
- Auto-triage workflow — added `reopened` to `on.issues.types` and allow-listed reopen-with-Bug in the `if:` guard. Previously reopening an issue with Bug already on it fired nothing (the #20 symptom). Now a reopen re-triggers triage.

### Config

- `config/users/idan.yaml` — re-enabled `summary: true` (was flipped off at some point during the recent refactor wave).

---

## 2.0.0 — Connection interface milestone (issue #1 closed)

First major version. The entire messaging architecture is now abstracted behind a single `Connection` interface. Skills no longer know or care which transport they're speaking through. Slack is the fully wired implementation today; email and WhatsApp slot in through the same interface without touching skill code.

This closes [#1](https://github.com/odahviing/AI-Executive-Assistant/issues/1) — the Connection-interface rollout that spanned versions 1.8.9 → 1.8.14 across six sub-phases (foundation + SummarySkill port + OutreachCoreSkill port + coord port + post-polish + duplicate-reply / create_meeting idempotency / date-verifier hardening).

### The architectural shift

Before: skills imported `@slack/bolt`, called `app.client.chat.postMessage` directly, and the coord state machine lived under `src/connectors/slack/coord*`. Layer boundaries existed on paper but leaked in code.

After:
- Skills import only `src/connections/types` + `src/connections/registry`. They resolve `getConnection(ownerUserId, 'slack')` and call `conn.sendDirect` / `conn.postToChannel` / `conn.sendGroupConversation`. Zero `@slack/bolt` imports anywhere under `src/skills/`.
- The coord state machine moved from `src/connectors/slack/coord/` and `src/connectors/slack/coord.ts` (~1244 lines) to `src/skills/meetings/coord/{utils,approval,booking,state,reply}.ts`. All transport-agnostic.
- `shadowNotify`, `coord_nudge`, `coord_abandon`, outreach dispatchers, and every task dispatcher that sends messages resolve their transport via the Connection registry.
- `SendOptions.threadTs` flows through to Slack's `chat.postMessage` — threading is no longer a special case.
- Core → skill dependency inverted via a registry pattern: `core/approvals/coordBookingHandler.ts` exposes register/get, MeetingsSkill registers its booking handler on load, `core/approvals/resolver.ts` calls through the registry. Core never imports from skills.

### What this unlocks

- **Email and WhatsApp transports** can be added by implementing the `Connection` interface once. No skill changes. No orchestrator changes. Just a new `src/connections/<name>/` folder and a registration in the corresponding inbound handler.
- **Per-profile transport preferences** work without skill-level branching. The router (`src/connections/router.ts`, in place but not yet hot-path) will apply the 4-layer policy (inbound-context / person preference / per-skill / profile default) uniformly.
- **Test isolation.** Skills can be exercised against a mock `Connection` — no Slack app required.

### Fixes shipped in the 2.0 wave (1.8.12 → 1.8.14)

- Thread-ts support across the Connection interface — preserves v1.8.6 "booking confirm in original coord DM thread" behavior without special-casing.
- coord_nudge + coord_abandon respect owner work hours via new `src/utils/workHours.ts` (extracted from outreachExpiry — mirrors the v1.8.0 fix).
- `_meetingsOps.ts` → `src/skills/meetings/ops.ts`. Matches coord structure.
- Tool-grounded fallback verbMap expanded from 11 to ~45 entries + safe generic default — raw tool names can never leak to users again.
- `create_meeting` idempotent across turns — pre-check Graph for existing event at same subject+start (±2 min) and return that id instead of duplicating. Fixes the 3-events-from-one-booking bug when date-verifier retry loops fired on the same intent.
- Date verifier: post-retry re-verification with **deterministic inline correction** of wrong weekday tokens. "Thursday 24 Apr" → "Friday 24 Apr" when Sonnet's retry also fails. Previously the wrong pair could ship after retry.
- Prompt RULE 2b: your prior replies are commitments. Stops Sonnet re-asking for emails/IDs/names it already wrote in an earlier turn.
- Shared `processedDedup` module for Slack message dedup. Live handlers + catch-up share the same process-global Set so a message the catch-up replied to can't be re-processed by the live handler after reconnect. Closes the "Maelle replied twice to the same message after restart" bug.

### Invariants preserved

- Every coord_jobs column and participant-JSON extension field unchanged.
- Coord state-machine semantics identical (collecting / resolving / negotiating / waiting_owner / booked / cancelled / abandoned).
- Approvals layer (v1.5) intact — freshness re-check, idempotency via external_event_id, amend support, owner-decision parse from PENDING APPROVALS block.
- All honesty guards (claim-checker, date-verifier, security gate, coord guard, recovery pass) still run on the owner + colleague paths they did before.
- Multi-tenancy semantics unchanged — per-profile isolation via `owner_user_id` + per-profile Connection registry.

### Migration

No schema changes. No config changes. Existing profiles keep working.

### Not changed

- Microsoft Graph is a calendar backend, not a messaging surface — stays under `src/connectors/graph/` and skills call it directly (domain dependency, not a transport).
- `audit_log`, `people_memory`, `user_preferences`, `outreach_jobs`, `routines`, `events`, `summary_sessions`, `calendar_dismissed_issues` — untouched.
- `coordinator.ts` still hosts the outreach reply classifier — its port is the next natural step (was originally sub-phase E), but not in 2.0's scope.

### Next

v2.1+ targets: WhatsApp connector (first non-Slack `Connection` implementation), email connector, coordinator.ts outreach-reply port, inbound workflows, meeting notes preparation. See README roadmap.

---

## 1.8.14 — Post-D polish: skills fully transport-agnostic, work-hours for coord, structural cleanup

Follow-up to sub-phase D closing the remaining architectural debt the port surfaced. Three fixes:

### Changed — `shadowNotify` ported to Connection (architectural completeness)

- `src/utils/shadowNotify.ts` no longer takes `app: App`. Resolves the Slack Connection via `getConnection(ownerUserId, 'slack')` and calls `conn.sendDirect` / `conn.postToChannel` like every other outbound messaging site.
- The owner's DM channel id is cached per-profile (`Map<profileId, channelId>`) — first `sendDirect` populates it from `SendResult.ref`, subsequent calls detect "same channel" to preserve thread context.
- Slack-specific context-block rendering dropped — shadow messages are now plain italic text with the 🔍 prefix. Visually slightly less distinct, but fits any transport.
- **Skill files are now 100% transport-agnostic.** `@slack/bolt` import removed from `skills/meetings/coord/state.ts`, `reply.ts`, `booking.ts`. The `app: App` parameter removed from every public function there (`initiateCoordination`, `handleCoordReply`, `bookCoordination`, `forceBookCoordinationByOwner`). Callers (app.ts, coordinator.ts, resolver.ts, skills/meetings.ts) updated to drop the arg.
- `CoordBookingHandler` type dropped `app` from its payload too — resolver no longer needs to plumb Slack into skill land.
- This completes what sub-phase D set out to do: skills import only `connections/types` + `connections/registry`, never a transport.

### Changed — coord_nudge + coord_abandon respect owner work hours

- `src/utils/workHours.ts` — extracted `isWithinOwnerWorkHours` + `nextOwnerWorkdayStart` from `outreachExpiry.ts` so multiple dispatchers can share them.
- `src/tasks/dispatchers/coordNudge.ts` + `coordAbandon.ts`: on dispatch, if current time is outside the owner's `schedule.office_days` / `home_days` windows, re-queue the task at `nextOwnerWorkdayStart(profile)` instead of firing. Fixes "coord initiated Friday 5pm → nudge/abandon owner DM at Saturday 3am" bug — mirrors the v1.8.0 outreach_expiry fix.
- The nudge message itself goes to colleagues (who don't have owner work hours), but the follow-on `coord_abandon` step DMs the owner, and keeping the whole cycle aligned with work hours is cleaner than a split policy.

### Changed — `_meetingsOps.ts` relocated into `skills/meetings/`

- `src/skills/_meetingsOps.ts` → `src/skills/meetings/ops.ts`. Removes the underscore-flat file sitting next to a `meetings/` folder; matches the coord structure.
- Class is still `SchedulingSkill` (private name, only used via `MeetingsSkill`'s delegation).
- Callers updated: `skills/meetings.ts`, `tasks/dispatchers/calendarFix.ts`.

### DB cleanup — stale operational data

Per owner request (no live activity to preserve): `coord_jobs`, `tasks`, `approvals`, `pending_requests` wiped. Knowledge tables (`people_memory`, `user_preferences`, `conversation_threads`, `outreach_jobs`, `routines`, `events`, `summary_sessions`, `calendar_dismissed_issues`, `audit_log`) untouched.

### Fallback leak fix (1.8.13) folded in

The fallback-verbMap expansion from 1.8.13 stays as shipped.

### Invariants preserved

- Shadow mode security rule (owner-DM-only) preserved: non-owner-channel contexts still redirect to the owner's DM with no thread.
- outreachExpiry.ts behavior unchanged — just swapped its inline helpers for the shared `workHours.ts` module.
- coord state machine, approvals layer, booking path all function identically — only the `app` parameter plumbing changed.

### Not changed

- `shadowNotify` blocks-based rendering is gone; if the visual distinction turns out to matter, it can come back as a Slack-specific extension to Connection. For now: readable plain text.
- Load-order / registration warning for profiles with `meetings: false` — deferred (was issue #5 in the review, owner said "not now").

---

## 1.8.13 — Fix raw tool names leaking in silence-prevention fallback

Bug observed: "What is my calendar for tomorrow" → Maelle replied `"Done — ran get_calendar and ran note_about_self. Let me know if anything's off."` The v1.7.3 tool-grounded confirmation fallback fired (Sonnet silenced, recovery pass also silent, so the fallback built text from tool names) — but its `verbMap` only covered ~11 tools. Any tool not in the map fell through to `ran ${toolName}`, exposing raw tool names to the user. AI-ish tell; violates the human-EA filter.

### Changed — `core/orchestrator/index.ts` fallback verbMap

- Expanded verbMap from 11 entries to ~45 — every currently-registered tool across MemorySkill, TasksSkill, CronsSkill, MeetingsSkill, CalendarHealthSkill, SummarySkill, KnowledgeBaseSkill, SearchSkill, OutreachCoreSkill now has a human verb.
- **Safe default:** if any tool in the turn isn't mapped, the whole reply falls back to `"Done — handled a few things. Let me know if anything's off."` instead of leaking `ran ${toolName}`. This future-proofs the fallback — new tools added later will never leak even if someone forgets to update the map.
- Root cause of the silence itself (why Sonnet didn't narrate the calendar after `get_calendar`) is a separate investigation; this fixes the surfacing bug where the fallback text itself was broken.

### Not changed

- The fallback still only triggers when `toolCallSummaries.length > 0` (no fabricated "Done" for nothing-happened turns).
- Fallback is last-resort only — primary reply + recovery pass still try first.

---

## 1.8.12 — coord.ts ported to Connection interface (#1 sub-phase D, D1-D8)

Biggest single port in issue #1. The ~1244-line `connectors/slack/coord.ts` state machine moves to `src/skills/meetings/coord/`, Slack transport calls go through the Connection interface, and `core/approvals/resolver.ts` no longer imports from `connectors/slack/` — it calls a registered booking handler.

### Changed — coord lives under MeetingsSkill now

- **Files moved and rewritten:**
  - `src/connectors/slack/coord/utils.ts` → `src/skills/meetings/coord/utils.ts` (pure — zero transport; content unchanged)
  - `src/connectors/slack/coord/approval.ts` → `src/skills/meetings/coord/approval.ts` (drops `app + botToken` params; resolves Slack via `getConnection(ownerUserId, 'slack')` and calls `conn.postToChannel(owner_channel, text, {threadTs})`)
  - `src/connectors/slack/coord/booking.ts` → `src/skills/meetings/coord/booking.ts` (every `app.client.chat.postMessage` / `conversations.open` → Connection; calendar reads via Graph unchanged; v1.8.6 dm_thread_ts threading preserved via `postToChannel(dm_channel, text, {threadTs: dm_thread_ts})`)
  - `src/connectors/slack/coord.ts` (state machine) → `src/skills/meetings/coord/state.ts` (initiateCoordination + sendCoordDM + resolveCoordination + startPingPong + tryNextPingPongSlot + startRenegotiation + triggerRoundTwo) and `src/skills/meetings/coord/reply.ts` (handleCoordReply + handlePreferenceReply + parseTimePreference)
- **Deleted:** `src/connectors/slack/coord.ts` and the `src/connectors/slack/coord/` subdirectory.
- `src/skills/meetings.ts` imports from `./meetings/coord/utils` + `./meetings/coord/booking` (no more skill → connector violation).
- `src/connectors/slack/app.ts` imports directly from `src/skills/meetings/coord/state|reply|booking` (the old re-export barrel is gone).
- `src/connectors/slack/coordinator.ts` imports `initiateCoordination` + `determineSlotLocation` from the new location.

### Changed — resolver dependency inverted

- New `src/core/approvals/coordBookingHandler.ts` — a tiny registry (`registerCoordBookingHandler` / `getCoordBookingHandler`).
- `src/core/approvals/resolver.ts` no longer imports `forceBookCoordinationByOwner` from connectors. Calls the registered handler instead; returns `ok:false, reason:'no coord booking handler registered'` if MeetingsSkill is disabled in the profile.
- `src/skills/meetings/coord/booking.ts` registers its handler at module load (runs when MeetingsSkill is required).
- This is approach (b) from the sub-phase D plan: skills subscribe, core publishes. Cleanest way to keep core from reaching into a skill.

### Changed — threading wired through the Connection interface (D1)

- `src/connections/slack/messaging.ts` — `sendDM` / `sendMpim` / `postToChannel` now accept an optional `{ threadTs }` opts parameter and forward `thread_ts` to `chat.postMessage`.
- `src/connections/slack/index.ts` — `SlackConnection.sendDirect` / `sendBroadcast` / `sendGroupConversation` / `postToChannel` stop voiding `opts` and pass `threadTs` through. The interface's `SendOptions.threadTs` now actually does something for Slack.
- Needed before any coord port could move — coord threads replies in ~20 call sites, the v1.8.6 booking-confirm-in-original-thread fix depends on it.

### Changed — coord dispatchers use Connection (D7)

- `src/tasks/dispatchers/coordNudge.ts` and `coordAbandon.ts` drop direct `app.client.chat.postMessage` + `conversations.open`. Resolve Slack via `getConnection(profile.user.slack_user_id, 'slack')` and call `sendDirect` / `postToChannel`.

### Invariants preserved

- **coord_jobs schema byte-for-byte:** every field (participants, proposed_slots, notes, winning_slot, external_event_id, requesters, last_participant_activity_at, etc.) and every participant extension field (dm_channel, dm_thread_ts, _preference, _awaiting_preference, _pingPongTarget, _re_voter, _owner_force_booked, contacted_via, group_channel, group_thread_ts) unchanged.
- **State machine statuses:** collecting | resolving | negotiating | waiting_owner | confirmed | booked | cancelled | abandoned.
- **Owner auto-include for colleague-initiated coord** (layer-2 defense-in-depth) preserved in `initiateCoordination`.
- **MPIM coord flow** (contacted_via='group', voting in the group thread) preserved.
- **v1.8.6 fix:** booking confirmation DMs post back into the original coord DM thread when `dm_channel + dm_thread_ts` are recorded. `sendCoordDM` now records them from the Connection's `SendResult.ref + ts`.
- **Idempotency via `coord_jobs.external_event_id`** preserved in bookCoordination.
- **Pre-booking calendar freshness re-check** (60s skip window) preserved.
- **Duration approval gate** (non-standard duration requested by colleague) preserved.
- **Reschedule-intent routing (v1.8.4)** unchanged — `meetingReschedule.ts` still owns that path; coord is only invoked for new meetings.

### Not changed

- `_meetingsOps.ts` stays flat at `src/skills/_meetingsOps.ts`. Not in scope.
- `coordinator.ts` outreach reply classifier — sub-phase E.
- `utils/shadowNotify.ts` still takes `app` directly (audit utility; port is a separate concern).
- `sendCoordDM`'s user-existence preflight (was `app.client.users.info`) now surfaces through `sendDirect`'s error path — same outward behavior ("guest user / wrong ID" message) for user_not_found.

### Migration

None. Additive + in-place relocation. Existing coord_jobs rows, approvals rows, and queued coord_nudge / coord_abandon tasks all continue to work.

---

## 1.8.11 — Outreach ported to Connection interface (#1 sub-phase C)

Second skill port. `core/outreach.ts` moved to `skills/outreach.ts` and rewritten to send through the Connection layer. Drops the `_requires_slack_client` async-dispatch indirection — the tool handler sends synchronously now.

### Changed — outreach.ts location + implementation

- **File moved:** `src/core/outreach.ts` → `src/skills/outreach.ts`. Class still `OutreachCoreSkill` (kept name; registry imports updated).
- **`message_colleague` tool handler now sends synchronously.**
  - Resolves `getConnection(ownerUserId, 'slack')` inside the handler
  - DM branch: `connection.sendDirect(colleague_slack_id, message)`
  - Channel-post branch: prepends `<@slack_id>` mention to the text, then `connection.postToChannel(channel_id, text)`
  - Returns `{ ok: true, sent: true, jobId, _must_reply_with: ... }` for immediate sends. No more `_requires_slack_client: true` indirection.
  - On send failure: updates `outreach_jobs.status = 'cancelled'` with the reason, returns `{ ok: false, error, detail }`.
- **`find_slack_channel` uses `connection.findChannelByName`** instead of the coordinator helper.
- **Scheduled-send path (`send_at` future) unchanged.** Still creates the `outreach_send` task; the task dispatcher now also uses the Connection interface (see below).

### Changed — `outreach_send` task dispatcher uses Connection

`src/tasks/dispatchers/outreachSend.ts` no longer imports `sendOutreachDM` from `coordinator.ts`. Resolves the Connection at dispatch time and calls `slackConn.sendDirect(...)` directly. Post-send bookkeeping (owner notification, reply deadline, outreach_expiry task creation) unchanged.

### Removed — `send_outreach_dm` + `post_to_channel` SlackActions

`src/connectors/slack/app.ts` no longer handles `send_outreach_dm` or `post_to_channel` actions — they were the other side of the `_requires_slack_client` indirection that outreach no longer uses. Imports (`sendOutreachDM`, `postToChannel`) dropped from app.ts. `coordinator.ts` still exports `sendOutreachDM` for any other caller but outreach no longer uses it.

### Invariants preserved

- `outreach_jobs` rows created identically (intent + context_json from v1.8.4 still work)
- `outreach_send` / `outreach_expiry` task flow unchanged
- Owner quiet-hours respect (v1.8.0) unchanged — lives in outreachExpiry.ts dispatcher, untouched
- Intent-routed meeting reschedule (v1.8.4) unchanged
- `message_colleague` tool schema unchanged (Sonnet's view identical)
- `find_slack_channel` tool name unchanged (Sonnet's view identical)
- Claim-checker still sees `[message_colleague: <name>]` in toolSummaries

### What's different from Sonnet's perspective

- **message_colleague used to return** `{_requires_slack_client: true, _note: "NOT sent yet — say 'On it'"}`. Sonnet would say "On it."
- **Now returns** `{ok: true, sent: true, _must_reply_with: "One short sentence confirming the send..."}`. Sonnet says "Sent — I'll let you know when [name] replies."

The new phrasing is more honest — the send DID happen by the time Sonnet sees the result. Claim-checker still validates correctly.

### Not changed

- Coord state machine (`connectors/slack/coord.ts`) — sub-phase D
- Outreach reply classifier (`coordinator.ts` `handleOutreachReply`) — sub-phase E
- CORE_MODULES list still includes OutreachCoreSkill; auto-load-based-on-Connection logic will come in a later sub-phase if any profile disables Slack

Typecheck clean. Owner-facing semantics identical; internal plumbing fully ported.

### Next sub-phase (1.8.12): coord.ts state machine port — HIGH RISK

1244 lines of state machine. Dedicated session. Multiple sub-sub-phases probably. Own risk budget.

---

## 1.8.10 — SummarySkill ported to Connection interface (#1 sub-phase B)

Reference consumer port. SummarySkill no longer imports directly from `connections/slack/messaging.ts`; it resolves the registered Slack Connection via the registry and calls through the generic `Connection` interface.

### Changed — SummarySkill uses Connection interface

- `resolveActionItemAssignees`: `findUserByName(app, token, query)` → `slackConn.findUserByName(query)` (via `getConnection(ownerUserId, 'slack')`).
- `share_summary` recipient resolution + send loop: same pattern. `findChannelByName`, `sendDM`, `sendMpim`, `postToChannel` all go through `slackConn.*` instead of direct imports.
- Fails gracefully if the Slack Connection isn't registered (logs + refuses that recipient) — shouldn't happen in practice since 1.8.9 registers on startup.

### Invariants verified

- Same recipient resolution logic (internal email preference, Slack ID fast-path)
- Same send semantics (DM per user, channel post per channel, MPIM for mpim)
- Same failure-handling (refused list, sendFailures list)
- No change to the summary draft format, action-item extraction, task follow-up creation
- `action_summary` style learner (v1.8.8) unchanged

This is the smallest possible behavior-preserving port — pure interface swap. The actual payoff (external recipients routed to email automatically) comes when EmailConnection lands.

### Next sub-phase (1.8.11): port outreach.ts

Bigger scope — `message_colleague`, `find_slack_channel`, outreach-reply handling, intent-routed reschedule flow. Medium risk because outreach_jobs DB + task dispatchers have tight integration.

---

## 1.8.9 — Connection layer foundation (issue #1 sub-phase A)

First sub-phase of the Connection-interface rollout. Pure additions — zero behavior change. Lays the groundwork for porting SummarySkill (next sub-phase), outreach, coord, and reply classifier. Multiple sub-phases will ship as 1.8.x patches; v1.9.0 is reserved for the completion milestone once every port is stable.

### Added — Connection interface + per-profile registry

- `src/connections/types.ts` — `Connection` interface (narrow common denominator: `sendDirect`, `sendBroadcast`, `sendGroupConversation`, `postToChannel`, `findUserByName`, `findChannelByName`). Plus `PersonRef` (per-recipient routing info with owner-pinnable `preferred_external`) and `RoutingPolicy` (profile-level routing rules).
- `src/connections/registry.ts` — per-profile `Map<profileId, Map<connectionId, Connection>>`. Each profile registers its own connections on startup.
- `src/connections/slack/index.ts` — concrete `SlackConnection` factory that wraps the existing `messaging.ts` primitives behind the interface. Zero behavior change vs. calling `messaging.ts` directly.

### Added — routing policy layer

`src/connections/router.ts` resolves outgoing Connection + recipient ref with 4 decision layers:

1. Context wins — `SkillContext.inboundConnectionId` (Yael DMs on Slack → reply on Slack)
2. Internal rule — internal recipients always go to Slack unless per-skill override says otherwise
3. External routing — per-recipient `preferred_external` → per-skill → profile `default_routing` → hardcoded `email` fallback
4. Graceful fallback — if preferred transport unreachable, walk email → whatsapp → slack for any address we have

Never throws. Returns null + logs when no reachable transport exists for a recipient.

### Added — profile schema carries routing policy

`UserProfile.connections` block (optional, defaults to `{internal: slack, external: email}`):

```yaml
connections:
  default_routing:
    internal: slack
    external: email
  per_skill_routing:       # optional per-skill overrides
    research: { internal: slack, external: slack }
```

`idan.yaml` updated with the default block. Existing profiles without the block get sensible defaults via Zod.

### Added — `SkillContext.inboundConnectionId`

Piped through `OrchestratorInput` → `SkillContext`. Defaults to `'slack'` in the Slack transport (only transport today). Skills don't consume this yet — they will in sub-phase B.

### Added — SlackConnection registered on startup

`createSlackAppForProfile` in `connectors/slack/app.ts` registers a SlackConnection under `user.slack_user_id` as the profile key. Startup log: `Connection registered: slack for profile <name>`.

### Invariants preserved

- No existing tool changes behavior
- No existing prompt changes
- SummarySkill continues using `messaging.ts` directly — port happens in sub-phase B
- `outreach`, `coord`, `coordinator` untouched — later sub-phases

Typecheck passes. Smoke test: bot starts, logs show connection registration, all prior Slack behavior unchanged.

### Next sub-phase (1.8.10): port SummarySkill to use router

Replace SummarySkill's direct `messaging.ts` imports with router-mediated access. Reference consumer — proves the interface works end-to-end before staking outreach or coord on it.

---

## 1.8.8 — Passive style learner + recurring-series guard + addressee gate fix + quality batch

Bundled patch from a day of MPIM + summary iteration + routine diagnostics.

### Added — passive style-rule learner (issue #18)

SummarySkill now learns from owner's feedback automatically. After each successful `update_summary_draft`, a Sonnet classifier judges whether the feedback was a *generalizable style rule* worth saving (vs. a one-off topic correction). If yes, it saves silently via `savePreference` — no DM, no confirmation.

Examples that save:
- *"more paragraphs per topic than one-liner bullets"* → global rule
- *"don't call me Idan in the summary, I was in the meeting"* → global (first-person convention)
- *"on interview summary focus on entry/positive/negative/follow-up"* → type-specific (interview)

Examples that skip:
- *"Q3 goals was wrong, should be Q2"* → topic correction, not style
- *"add Amazia as attendee"* → content fix

**Type-specific support:** rules scoped to `interview`, `one_on_one`, `standup`, `retro`, `weekly`, `quarterly`, or `global`. Summary type inferred from draft subject via keyword match. `summaryStylePromptBlock` loads global first, then type-specific on top — type wins on conflict (last-rendered).

Storage: `user_preferences` with category `summary` (global, back-compat) or `summary_type_<type>`. `source='inferred'` distinguishes passive saves from the explicit `learn_summary_style` tool calls.

Every classifier decision logs under `style-learner:` prefix for auditing.

### Added — recurring-series protection on update_meeting and move_meeting

Before PATCHing an event, a lightweight probe (`getEventType` in `connectors/graph/calendar.ts`) checks the Graph `type` field. If `type='seriesMaster'`, the operation is refused with a message explaining that series-wide changes aren't safe to automate; owner should edit the series in the calendar, or specify a single occurrence (by meeting_id from get_calendar for that specific date) — Graph creates an exception automatically on occurrence PATCH. Occurrences + singleInstance + exception events all work as before.

Also: `get_calendar` now returns `type` + `seriesMasterId` fields so Sonnet can see whether an event is recurring.

### Added — `web_search` takes `time_range_days` parameter

Tavily search now accepts a `days` filter plus `topic: 'news'` mode when the caller passes `time_range_days`. Tool description pushes Sonnet to set it for news/recent queries ("last 7 / 14 / 30 days"). Prevents stale-but-popular articles from dominating fresh queries — the pattern we hit trying to generate "recent" LinkedIn content and getting 2025 CRN articles back repeatedly.

### Fixed — MPIM addressee gate silently dropped direct @Maelle mentions

In an MPIM, when the owner wrote `<@Maelle>, can you say hi to <@Swan>?`, the gate returned HUMAN and the message was silently dropped. Root cause: (a) `resolveSlackMentions` rewrites `<@ID>` to `"Name (slack_id: ID)"` before the gate runs, breaking fast-path 1 which looks for the raw form; (b) the group-DM preamble prepended by app.ts pushes "Maelle" past the 40-char fast-path window.

Two fixes:
- Addressee gate fast-path now also matches the resolved form `(slack_id: <botUserId>)`
- App.ts strips the `<<GROUP DM — ...>>` preamble before passing to `classifyAddressee` — the gate judges the owner's actual message, not Maelle's own framing

Either fix alone would have caught this case. Together = robust.

### Fixed — MPIM owner's request refused for non-standard meeting duration

`_meetingsOps.ts` scheduling-rules block said *"Allowed durations: 10/25/40/55 minutes only"* — the word *only* contradicted the `coordinate_meeting` tool description that explicitly allows owner to request any duration. Softened: standard durations listed, owner-override is approved (per v1.8.7 MPIM authority rule), with a single soft suggestion ("did you mean 55 to keep to standards?") allowed if unusual. Never refuse a duration owner specified.

### Fixed — get_my_tasks now prompts Sonnet to also check routines

When owner asks *"did you do my LinkedIn post this morning?"* or similar recurring-activity questions, `get_my_tasks` alone misses routines that haven't materialized yet or completed silently. Tool description now tells Sonnet to also call `get_routines` for recurring-activity questions and cross-reference: `last_run_at=today + last_result="No issues found"` DID run (silently); `last_run_at` still blank today = didn't fire yet.

### Not changed

- Feature label deleted repo-wide — tier labels (Next/Roadmap/Idea) fully imply a feature, so the separate type label was redundant
- Issue #26 closed (Bug 1 fixed in 1.8.3; Bug 2 dormant — instrumentation added in 1.8.6, no recurrence)
- Issue #18 closed by this patch

---

## 1.8.7 — MPIM-with-owner: owner's request IS his approval

Reframes the MPIM-with-owner prompt. Previously the rule conflated privacy ("what to reveal") with action deferral ("where to act") — Maelle would correctly filter what she said but wrongly refuse to do things the owner was asking her to do right there in the group chat, offering to "take it to our private chat" instead. That's backwards: the owner's direct request in the MPIM IS his approval.

### Fixed — MPIM-with-owner authority + speaking rules

Rewrote the authLine block in `systemPrompt.ts`. Clear separation:

- **Authority:** owner's request = approval. Execute calendar actions (book / move / cancel / update / message) directly in-thread. Only redirect to DM when the action genuinely requires revealing owner-private info (tasks, preferences, people memory, notes).
- **Privacy filter:** still colleague-level. What she REVEALS stays filtered — no topics, no preferences, no other colleagues' personal details. "Moved it to 11:45" = fine. "Moved it; the 12:30 was about Q2 KPIs" = leak.
- **Speak to the group:** owner is reading too. Address the group, not the owner in third person. One message to the group, not "answer to owner + separate heads-up to colleague" (they're both in the chat).

Fixes five related failure modes from a single Sunday MPIM trace:
1. Maelle talking ABOUT the owner in 3rd person ("Idan's calendar is packed") instead of TO him.
2. Offering "let's take this to our private chat" for shared scheduling work.
3. Composing dual-feedback messages (answer to owner, `@`-mention heads-up to colleague, same reply).
4. Saying "I don't have the ability to move calendar events in this chat" when tools were available — previously the prompt told her to defer regardless.
5. Producing a plan as TEXT but not calling the mutation tools — same defer logic.

The privacy rules are unchanged in behavior (what's revealed), only the action-deferral logic is removed for owner-initiated requests.

### Fixed — Idan's lunch duration 45 → 25 minutes

Stale YAML config. Real lunch block is 25 minutes (owner's convention: actual duration − 5-minute buffer). Maelle was correctly reading the config but the config was wrong. `config/users/idan.yaml:51` updated.

### Not changed / possible follow-up

- No false-negative claim-checker added. Shipping the prompt rewrite alone first — if Sonnet still drifts to "I can't" phrasing under the new rules, we'll add a code-level false-negative check in 1.8.8. Monitor MPIM owner interactions for this pattern.

---

## 1.8.6 — Routines appear in get_my_tasks + silent-routine logging + coord thread continuity

Three fixes, all from a single Sunday-morning bug report trace.

### Fixed — `get_my_tasks` now surfaces routine-materialized tasks

`get_my_tasks` filters `who_requested != 'system'`, which was correct for hiding internal bookkeeping (outreach dispatch, coord nudges, calendar fix tasks) but wrongly excluded routines — which the owner explicitly set up and should see on his plate. Root cause was semantic, not query-level: `routineMaterializer.ts` was tagging routine firings with `who_requested: 'system'` when the correct value is the owner's user_id (the owner IS the one who asked for the routine to run; only skill-internal side-effects are truly 'system').

Changed `routineMaterializer.ts:132` to record `who_requested: routine.owner_user_id`. No query changes, no migration. Other 'system' callers (outreach dispatch, coord nudge, calendar fix, summary follow-up, briefing cron, calendar health monitor) stay 'system' — correct.

Surfaces: when the owner asks "do you have a task today to check my LinkedIn?", the materialized routine firing shows up in the same list as reminders, outreach, and coord tasks.

### Changed — silent routine completions now log prominently

When a routine runs through the orchestrator and the reply is empty or `NO_ISSUES`, the dispatcher completes the task silently with no Slack output. That behavior is correct (you don't want routine noise in DMs), but it used to leave no trace the owner could find. Added an `INFO`-level log line (`Routine completed silently (no message sent to owner)`) with the routine id, title, scheduled-at, and reply preview. `pm2 logs maelle | grep routine` now shows the trail.

No behavior change to actual dispatch. Owner can also ask "when did my LinkedIn routine last run?" — `routines.last_result` still captures "No issues found" for silent runs.

This is an instrumentation fix for the "my 9am routine never fired" reports — most likely cause is that it DID fire and returned silent output, not that it skipped. Next time we'll have the logs to confirm.

### Fixed — coord booking confirmation posts in thread instead of new DM

When a coord booked, the final `"All confirmed! '<subject>' is booked for ..."` message to private-DM participants was posted as a new top-level DM instead of a reply in the existing coord thread. Thread continuity broken; colleague sees a floating confirmation disconnected from the slot-options conversation.

Root cause: `CoordParticipant` only tracked `group_channel` + `group_thread_ts` for MPIM participants. For private-DM participants there was no equivalent, so `booking.ts` was opening a fresh DM (`conversations.open`) and posting without `thread_ts`.

Added `dm_channel` + `dm_thread_ts` fields to `CoordParticipant`. `sendCoordDM` now captures the initial message's ts and stores both. `booking.ts` uses them when present; falls back to the old open-new-DM path for legacy coord rows that predate this change.

No DB migration — participants live as JSON in `coord_jobs.participants`, additive fields.

### Not changed / known follow-ups

- Outreach-path DM thread continuity: `outreach_jobs` doesn't track where Maelle's initial outreach landed in Slack, so the v1.8.4 meeting-reschedule handler's confirmation DMs to the colleague may also post out-of-thread. Not hit in practice yet; file a bug if seen.
- Root cause of Bug B (LinkedIn routine at 9am): still unknown. Logging above is the research trace, not a fix. Next time it happens, check `pm2 logs maelle --lines 2000 | grep -iE "routine|linkedin"` for the trail.

---

## 1.8.5 — Phrasing + tool-choice clarity + LLM-based weekday context verifier

Quality patch. Three narrow fixes, all learned from the "is Idan free at 3pm to join a meeting with me" trace pattern.

### Fixed — `check_join_availability` reply ownership

Maelle could reply *"want me to add him to the invite?"* when a colleague asked if the owner could join THEIR meeting. Wrong — the colleague owns the meeting; Maelle doesn't add anyone. The tool description now lists right / wrong phrasing explicitly: *"RIGHT: 'Yes, he's free at 3pm — send him the invite.' WRONG: 'Want me to add him' (Maelle doesn't own the meeting, can't add)."* Prompt-level fix; determinism isn't the right layer for phrasing.

### Changed — MeetingsSkill tool descriptions carry clearer decision tree

Audited `coordinate_meeting`, `check_join_availability`, `get_free_busy` descriptions. Each now opens with "use ONLY for X" + "do NOT use for Y → use Z instead" lines, so the boundary between tools is hard to blur. Small additions (~5-8 lines per tool), no bloat. Addresses the "Sonnet picks the wrong tool for an availability check" drift risk.

### Changed — dateVerifier bare-weekday check now uses Sonnet instead of keyword triggers

The v1.8.4 bare-weekday check fired only when the user's message contained the literal word `today` / `tomorrow` / `היום` / `מחר`. Real messages use a wide range of temporal phrasings (`"this afternoon"`, `"at 3pm"`, `"tonight"`, `"EOD"`, `"in an hour"`, `"now"`) — all of which slipped through.

Replaced with an LLM-based context verifier: when the draft contains any bare weekday AND the existing regex checks didn't already catch a mismatch, a Sonnet call judges against the user's message + the 14-day DATE LOOKUP. Strict JSON output; fails open on any error. Owner's call was to use Sonnet (not Haiku) — classifier quality matters more than cost for this check, which only fires on replies that mention a weekday at all.

Determinism stays in the weekday+date regex (exact Mon-DD-Month mismatches). Judgment (does this weekday contextually fit the user's question?) moves to the LLM.

### Migration

None. Behavioral changes only.

### Not changed

- Weekday+date regex pair verifier (Pattern A / B) stays as-is — deterministic and fast.
- Deferred Fix 3B (tool-choice sanity-check code gate) — only ship if the prompt-level tightening (3A) isn't enough in practice.

---

## 1.8.4 — Intent-routed outreach + forwarded huddle recaps + triage principles restored

Patch. Adds intent-routed outreach replies (colleague's approval automatically moves the calendar event), forwarded Slack huddle recap auto-ingest, coordinate_meeting preflight, colleague-path mutation-contradiction check, bare-weekday date verification, and triage context restoration. Several defensive code fixes learned from the issue #26 aftermath.

### Added — intent-routed outreach with meeting-reschedule handler

`message_colleague` now accepts optional `intent` and `context` parameters. When `intent='meeting_reschedule'` is set with `context={meeting_id, meeting_subject, proposed_start, proposed_end}`, the outreach reply dispatcher routes the colleague's reply to a dedicated handler in `src/skills/meetingReschedule.ts` instead of the generic classifier:

- **approved** ("yes, works") → the handler calls `updateMeeting` to MOVE the existing calendar event, DMs the colleague a confirmation, reports to the owner
- **declined** ("no, can't") → reports to the owner, keeps the original time
- **counter** ("yes but 09:30 would be better") → DMs the owner the counter-offer for them to accept or reject in natural conversation

Closes the workflow gap surfaced by issue #26 where Maelle sent a reschedule DM, got "yes" back, and then created a NEW meeting next week instead of moving today's. The outreach now remembers what meeting it's about.

`outreach_jobs` gets two new columns: `intent TEXT`, `context_json TEXT`. Migration is additive (old rows keep null and fall through to the original done/continue/schedule classifier).

### Added — coordinate_meeting preflight against existing meetings

Before starting a new coord, `coordinate_meeting` now scans the next 14 days of the owner's calendar for an event whose subject substring-matches the requested subject AND whose attendees overlap with the requested participants. If a match is found, the tool refuses with a message steering Sonnet to use `message_colleague` with `intent='meeting_reschedule'` instead. Fails open on Graph errors (legitimate coords still work if Graph is briefly down).

This is the code-level gate that makes the issue #26 "coord_meeting when you meant reschedule" mistake very hard to repeat.

### Added — colleague-path mutation-contradiction check

New step in `postReply.ts` for colleague-facing drafts. When a calendar-mutating tool (`move_meeting` / `create_meeting` / `update_meeting` / `delete_meeting` / `finalize_coord_meeting`) succeeded this turn AND the draft contains owner-deferral phrasing (`"flagged for <owner>"`, `"let <owner> know"`, `"check with <owner>"`, `"he'll likely / probably / decide"`), retry once with a nudge: action already happened — acknowledge it directly to the colleague. Code-only check (no Sonnet call). Addresses the Bug C pattern from issue #26 aftermath where the audit log said "booked" while the colleague was told "flagged for Idan".

### Added — forwarded Slack huddle recaps auto-ingest

Owner uses Slack's "Share message" action on a Slack AI huddle recap and sends it to Maelle's DM. Maelle detects the recap (attachment text / long body with 2+ huddle-recap keywords: `summary`, `action items`, `huddle`, `transcript`, etc.) and routes it to `SummarySkill.ingestTranscriptUpload` directly, skipping the orchestrator. Summary + follow-up flow lands without leaving Slack and without uploading a .txt file. Requires Slack AI huddle summaries enabled in the workspace.

Future live-huddle participation (Maelle joins as audio participant) tracked separately in [#27](https://github.com/odahviing/issues/27) as a Roadmap item — forwarded-recap is the narrower path available today.

### Fixed — dateVerifier now catches bare weekday misreferences

When the user's current-turn message contains `today` / `tomorrow` / `היום` / `מחר` and the draft contains a bare weekday reference (`"Monday's calendar"`, `"on Monday's schedule"`) that doesn't match today's or tomorrow's actual weekday, the verifier flags it and triggers a corrective orchestrator retry. Narrow pattern (possessive + schedule-noun, or preposition + weekday + schedule-noun) to avoid false-positives on legitimate future references like `"I'll ping you Monday"`. Addresses the "Monday's calendar" bug in the issue #26 screenshot where Maelle misread Sunday as Monday.

### Changed — triage + auto-build agents have repository context again

Restored the two memory files (`.claude/memory/project_overview.md`, `.claude/memory/project_architecture.md`) as pre-injected reference material in both `scripts/auto-triage-bug.mjs` and `scripts/auto-build.mjs`. The v1.8.2 removal was an over-correction — we threw out architectural knowledge to solve a different problem (pattern-matching to recent changelog entries). The five anti-recency-bias guardrails stay in place at the instruction level; they're what actually prevented the bad fix, not the context removal.

Added a "Maelle-is-a-human-EA" rule to the triage system prompt so proposed fixes that make Maelle sound more robotic get flagged as concerns.

Memory files are now tracked in the repo at `.claude/memory/` so GitHub Actions can read them. Owner (local auto-memory) is the source of truth — these repo copies need to stay in sync when memory is updated. Consider adding a sync step to future workflow.

### Migration

- DB migration is automatic on startup (additive ALTER TABLE on outreach_jobs)
- No new labels needed
- Owner's first push after this version triggers memory-file-in-repo sync if not already done

### Not changed

- Reschedule coordination via coord.ts (the multi-party state machine) — that path stays for genuinely new meetings. Reschedule flow is strictly via `message_colleague` + intent='meeting_reschedule'.
- Issue #26 bug 2 (Lunch not detected despite subject being "Lunch") — root cause still not identified. Ticket stays open at Medium priority; needs live-log reproduction.

---

## 1.8.3 — Mutation tools return past-tense `action_summary` (issue #26 bug 1)

Small patch addressing the "move-and-forget" class of bug caught in issue #26, where Maelle moved a meeting successfully and then narrated the post-move state as a fresh discovery ("already at 12:30, nothing to change") instead of acknowledging her own action.

### Fixed — mutation tool returns now include action_summary

`move_meeting`, `create_meeting`, `update_meeting`, `delete_meeting` all return an additional `action_summary` field with a past-tense sentence Sonnet can quote verbatim:

- Move: `"Moved 'Lunch' to 12:30–13:10."`
- Create: `"Booked 'Quarterly review' for 14:00–15:00."`
- Update: `"Updated 'Planning sync': renamed to 'Q2 planning'."`
- Delete: `"Cancelled 'Standup'."`

Code-level fix — the tool result itself carries the past-tense framing, so there's less room for Sonnet to misread the outcome as a fresh calendar state. No new post-processing gate (intentionally — we already have claim-checker + date-verifier + security-gate). Consumers were checked: no external callers read these returns, so additive fields are safe.

### Not fixed — Bug 2 from #26 (Lunch not detected)

Root cause still unclear. The event subject IS "Lunch" (English) per owner confirmation, so the existing case-insensitive `subject.includes('lunch')` detector should pass. Needs live-log investigation at the next reproduction — #26 stays open at Medium priority.

---

## 1.8.2 — Triage rewrite (propose-only, image-aware) + auto-deploy pipeline + language fixes

Big patch — combines the 1.8.1-scoped language/voice fixes with a substantial rewrite of the auto-triage and deploy infrastructure. Scope nominally exceeds a patch, but owner called it 1.8.2 since it's all stabilization of the 1.8 wave.

### Added — propose-only auto-triage with human approval gate

Auto-triage no longer ships fixes unsupervised. New three-phase flow:

1. **Triage (always plans, never fixes):** on Bug label, the agent investigates and writes a plan as an issue comment. Labels the issue `Proposed`. Script: `scripts/auto-triage-bug.mjs` (rewritten).
2. **Approval gate:** owner reads the plan. Labels `Approved` to build, or `Revise` with follow-up comments to re-plan (re-fires triage, which re-reads all comments including the owner's guidance).
3. **Build:** on `Approved` label, new workflow `.github/workflows/auto-build.yml` runs `scripts/auto-build.mjs`, which implements the plan, typechecks, commits + pushes under "Maelle Auto-Triage" author, closes the issue.

Labels: `Proposed` (plan awaiting owner), `Approved` (build now), `Revise` (replan), `Failed` (build aborted), `Triaged` (loop guard).

### Added — image-aware triage (critical for screenshot bugs)

The triage agent now downloads every image embedded in the issue body + comments (GitHub user-attachments URLs, using `GH_TOKEN`) and instructs the agent to Read them before diagnosing. Bugs with screenshots are the majority in practice; diagnosing them without vision was the single biggest source of wrong-cause fixes.

### Added — anti-recency-bias guardrails on triage

Four rules in the new triage prompt, all responses to the v1.8.0 wrong-fix (see the Reverted block below):

1. No pre-injected SESSION_STARTER.md as "repo context" — forces investigation from scratch
2. Explicit rule against pattern-matching to recent changelog / fresh features
3. Root cause must name specific file + line + mechanism (grounding)
4. Single-keyword causes require a second independent signal or classify as lower-confidence
5. Sanity-check pass: tiny second Sonnet call asks "does the cause actually match the symptoms?" — flags off-topic plans

### Added — laptop deploy watcher (`scripts/deploy-watcher.mjs`)

Runs under PM2 on the laptop. Every 5 min: `git fetch`, compares SHAs, and if the new commits are authored by "Maelle Auto-Triage", pulls + `npm ci` (if lockfile changed) + `npm run build` + `pm2 restart maelle`. Owner's own commits are skipped — he deploys those himself. No inbound network exposure, no SSH setup required.

### Added — PM2 ecosystem file (`ecosystem.config.js`)

Two processes: `maelle` (the main bot, running `dist/index.js`) and `maelle-deploy-watcher` (the polling daemon). Maelle no longer runs via `npm run` — switched to PM2 for auto-restart on crash + surviving reboots via `pm2-windows-startup`.

### Fixed — English text chat sometimes replied in Hebrew (issue #19)

Owner wrote in English after several Hebrew turns in the same thread; Maelle replied Hebrew. The LANGUAGE rule already said "no inertia" but buried the clause mid-sentence and Sonnet slipped under prior-turn pressure. Rewrote the LANGUAGE block in `systemPrompt.ts` so "CURRENT TURN WINS" is the opening line with a concrete override example ("even if the last 10 turns were Hebrew"). Rule now applies to owner AND colleague paths explicitly — any chat, not just owner.

### Fixed — voice transcription prefix wasn't reaching the orchestrator

The voice handler in `src/connectors/slack/app.ts` was calling `appendToConversation` with `[Voice message]: <text>` and then passing bare `text` into `processMessage`. Two effects: (1) history got double-persisted per voice turn, (2) the orchestrator's `userMessage` never started with `[Voice message]:`, so the v1.8.0 VOICE LANGUAGE OVERRIDE rule never fired — Hebrew Whisper transcripts → Hebrew replies despite the override. Fix: drop the redundant pre-append, pass `[Voice message]: <text>` directly to `processMessage` (which already persists via its own `appendToConversation` call). This fix was previously auto-shipped under a wrong-cause commit that claimed it addressed #19 — see the revert below.

### Reverted — commit dec424d (wrong-cause auto-fix for #26)

A second auto-triage misfire, caught before this version shipped. The old auto-fix flow closed #26 with a two-part "fix" in `src/skills/_meetingsOps.ts`:

1. A prompt rule telling Sonnet "after `move_meeting`, if you see the meeting at its new time via `get_calendar`, that's expected, don't act surprised." Wrong layer — this is a determinism problem (we know the move succeeded, we know the new time). The real fix lives in code: either `move_meeting` returns the new state structurally, or post-processing catches "just-moved meeting at new time" and reframes, or the orchestrator blocks redundant `get_calendar` after a successful move in the same turn. Prompt-pleading the model to "not act surprised" rots under model swap.
2. Preserving Outlook events with `showAs=free` whose subject contains "lunch" — on the hypothesis that a Lunch event marked free was being silently stripped. Diagnosis was wrong: the owner's Lunch event was NOT marked free, and `free`-shown events are correctly skipped by design. The "fix" would have introduced a regression where free-marked events start leaking into calendar analysis.

Both reverted. Issue #26 re-opened for proper triage under the new propose-only flow (which ships with this version — dec424d predated it by minutes).

### Reverted — commit 60546e8 (wrong-cause auto-fix for #19)

Auto-triage v1 closed issue #19 ("English chat → Hebrew reply") with a voice-handler fix. The reported bug was not voice. The old triage pattern-matched to v1.8.0's fresh VOICE LANGUAGE OVERRIDE work, not the actual cause. The infrastructure that enabled this failure mode (auto-fix without owner review + pre-injected changelog context + no image handling) is what this version's triage rewrite fixes. The voice fix has been re-applied cleanly under this version with its real justification, and the real #19 fix (LANGUAGE rule rewrite above) lands alongside it.

### Migration

- Install PM2 globally: `npm i -g pm2 pm2-windows-startup` (owner-side, one-time)
- Create labels in the repo: `gh label create Proposed --color 0366D6 --description "Triage plan written, awaiting owner decision"` / `Approved` (green) / `Revise` (orange) / `Failed` (red)
- Build: `npm run build`
- Start: `pm2 start ecosystem.config.js && pm2 save && pm2-startup install` (Windows)
- First auto-triage run will test the new flow end-to-end

### Not changed

- `config/users/idan.yaml` persona line — language-mirroring is a Maelle-wide rule, fixed in the prompt
- Core Maelle behavior — this patch is mostly infra + two prompt fixes

---

## 1.8.0 — Chapter close: 1.7 wave done, voice English-override + owner quiet-hours

1.7 was a long stabilization run — 8 patches across 2 days that hardened the core. We started with the agent-as-transport-coupling smell, shipped the Connection-shim foundation (issue #1's first wedge), built the Knowledge skill, fixed silencing, fixed dup outreach, fixed the lunch detector, fixed the calendar sycophancy, fixed em-dashes, made categories YAML-defined. Closing the chapter with one feature + two real-world fixes.

### What's solid now (the 1.7 wave summary)

- **Skill structure:** five togglable skills (`meetings`, `calendar`, `summary`, `knowledge`, `search`, `research`) with single-word noun keys; legacy keys auto-migrate at load time. New togglable skills cleanly slot in via `src/skills/registry.ts`.
- **Multi-modal input:** voice (Whisper transcribe → orchestrator), image (Anthropic native multimodal + injection guard), text transcript (SummarySkill 3-stage state machine).
- **Categories are YAML-defined:** owner declares `categories: [{name, description}]` in profile; tools (`book_lunch`, `set_event_category`, `create_meeting`) read them; Sonnet picks the right one via the EVENT CATEGORIES prompt block. Zero hardcoded category names.
- **Honesty layers stable:** claim-checker (MPIM-aware), date-verifier, security gate, coord guard, image guard, recovery pass, no-silence-after-tools fallback. Plus RULE 9 (verify-don't-echo) + RULE 10 (lunch window respect) added in 1.7.8.
- **MPIM thread continuity:** addressee gate + relevance gate skip when Maelle was just active in the thread (no more silent ignore on legitimate follow-ups).
- **Auto-triage GitHub Action:** Bug-labeled issues run the Claude Agent SDK, classify SIMPLE/MEDIUM/COMPLEX/NOT_A_BUG, auto-fix tiny safe changes, plan-comment everything else.
- **Owner social tracking:** owner is a regular `people_memory` row with `note_about_self` convenience tool. Stale-topic detection + random pick + fresh-opener fallback for richer social moments.

### Added — VOICE LANGUAGE OVERRIDE (issue #11)

Hebrew Whisper transcription quality + Hebrew TTS quality is meaningfully weaker than English today. New prompt rule in the VOICE block of `systemPrompt.ts`: when the user message starts with the literal token `"[Voice message]:"`, Sonnet's reply must be in ENGLISH regardless of the transcript's language. This OVERRIDES the LANGUAGE-mirror rule for voice scenarios only. Transcript itself stays in source language (no translation loss for context); only the reply is forced English. When the Hebrew gap closes (issue #12), the override flips off.

Implementation: prompt-rule, NOT a Whisper endpoint swap. Sonnet sees the original Hebrew transcript fully (preserves names, places, cultural context that translation flattens), just constrains the output language.

### Fixed — outreach_expiry respects owner work hours (Amazia 3am bug)

QA caught two duplicate "Amazia hasn't replied" DMs at 3am Saturday Israel time. Two distinct issues:

1. **Two duplicate outreach rows** from the v1.7.4 claim-checker bug were still in the DB. Cancelled the older one (`out_1776318265288_ewq9`) via one-time SQL update. The other (`out_1776318271902_zcd0`) remains in `no_response` as the canonical record.

2. **`outreachExpiry.ts` posted owner DMs at 3am** because the deadline timing uses the colleague's timezone. The dispatcher fired immediately at deadline regardless of when "now" is for the OWNER. Fixed: second-stage owner notification now checks `isWithinOwnerWorkHours(profile, now)` based on `schedule.office_days` + `schedule.home_days`. If outside work hours, the task re-queues itself for the next owner workday morning (status stays `sent` so a colleague reply between now and morning still cancels naturally). If inside work hours, original behavior (mark `no_response`, post DM).

Helpers `isWithinOwnerWorkHours`, `nextOwnerWorkdayStart` live inline in `outreachExpiry.ts` — small enough not to warrant a shared module, but the pattern can be extracted later if other dispatchers need the same gate.

### New issue opened

- **#12** — Better Hebrew voice support (Whisper + TTS). Tracks the gap that the v1.8.0 English-override is a workaround for. Resolution path: profile `voice_language: 'auto' | 'en' | 'he'`, better Hebrew ASR/TTS providers, naturalness in spoken Hebrew replies.

### What 1.8 starts with

- **#1 Connection-interface migration** (High) — the messaging shim landed in 1.7.2 (SummarySkill uses it). Next: define the formal `Connection` interface, port `outreach.ts` and `coord.ts` to it, then the email connector (#5) and meeting-summary email distribution (#2) unblock cleanly.
- **#3 Persona/social-context as togglable skill** (Low) — refactor MemorySkill into core (basic identity) + togglable SocialContextSkill (hobbies, topics, engagement gate).
- **#4 WhatsApp owner-sync channel**, **#6 Inbound workflows**, **#7 Meeting notes prep** — feature backlog.

### Migration

- DB schema: no changes. The Amazia row cancellation was a one-time data fix.
- Profile YAML: no schema changes from 1.7.8 → 1.8.0.
- Voice behavior changes: existing voice flows now reply in English even for Hebrew input. If you want this OFF temporarily (testing Hebrew TTS path), comment out the VOICE LANGUAGE OVERRIDE paragraph in `systemPrompt.ts`.

### Not changed

- All other skills + flows untouched.
- `showAs: 'free'` stripping unchanged (all free events still dropped before Sonnet sees them).
- Audio output (TTS) still fires for voice input when reply is short enough.

---

## 1.7.8 — YAML-defined categories + two honesty rules (sycophancy, lunch window)

Real-world QA on bug #10 surfaced two distinct Sonnet behavior issues plus a longer-standing architectural smell. All fixed in one patch.

### Added — YAML-defined Outlook categories

Categories (the colored Outlook event tags) used to be hardcoded in multiple places (`book_lunch` set `['Lunch']`; `set_event_category` tool description listed "Meeting, Internal, External, Interview, Lunch, Logistic, Focus Time"; analyzeCalendar's suggestions referenced the same fixed list). Didn't match the owner's real Outlook setup — his categories turned out to be `Logistic / Meeting / Not Me / Physical / Private / Vacation` (no "Lunch" exists in his Outlook at all).

New design:
- Profile YAML gets an optional `categories: [{ name, description }]` field. Owner defines their real Outlook categories + a short English description each so Claude can pick the right one per event.
- `systemPrompt.ts` renders an `EVENT CATEGORIES` block from that profile data when present. When absent, nothing is rendered and tools skip categorization.
- `book_lunch` no longer hardcodes `categories: ['Lunch']`. It accepts an optional `category` arg that Sonnet passes after reading the profile's categories. Defense-in-depth: if Sonnet proposes a name not in the profile, the tool logs WARN and drops it rather than inventing a category Outlook would auto-create.
- `set_event_category` tool description updated: no hardcoded list, just instructions to use what's in the EVENT CATEGORIES block.
- `analyzeCalendar`'s missing-category suggestion now pulls names from profile when defined; falls back to a generic message when not.

Owner's `idan.yaml` populated with his real six categories. `user.example.yaml` gets a generic sample for new installs.

### Added — RULE 9 (verify, don't echo)

When the owner asks about the calendar with a baked-in conclusion ("looking good, right?", "lunch every day?"), Maelle must VERIFY from the tool result before answering. Calendar reviews list per-day facts (meeting count, first/last, lunch status) — never a vague "looks fine". This addresses the bug #10 "Sunday meetings missing" symptom: Sonnet had the data, agreed with the owner's framing, never enumerated the actual Sunday meetings.

### Added — RULE 10 (lunch window respect)

When `book_lunch` returns `error: 'no_room'` OR Maelle is computing a lunch time herself, she must NOT silently propose a slot outside the owner's preferred lunch window. Explicit framing required: *"No slot fits in your usual window (11:30–13:30). Want me to do it at 11:00, earlier than usual?"*. This addresses the bug #10 "Monday lunch offered at 11:00" symptom where Maelle proposed pre-window lunch without flagging it.

### Migration

- Profile YAMLs without a `categories` block keep working (optional field). Tools skip categorization when absent. No forced changes.
- Existing events tagged `'Lunch'` by pre-1.7.8 `book_lunch` calls are unaffected — those are Outlook data, not code concerns.

### Not changed

- Lunch-event DETECTION (v1.7.7 English-only subject match) unchanged.
- `showAs: 'free'` stripping unchanged — all free events (all-day AND timed) still stripped before Claude sees them, per owner's explicit confirmation.
- Auto-triage workflow + script untouched.

---

## 1.7.7 — Lunch detection: English-only subject match (no Hebrew, no phantom category)

Fixes bug #10 (misinformation about calendar — Monday lunch not detected).

Both `_meetingsOps.ts:analyzeCalendar` and `calendarHealth.ts:check_calendar_health` were checking for Hebrew "ארוחת" in the event subject alongside English "lunch". The codebase shouldn't detect Hebrew in event subjects — the owner names lunch events in English, and cross-language heuristics in deterministic detection paths are fragile.

### Fixed
- Removed `subj.includes('ארוחת')` from both lunch detectors. Detection is now English-only: `subject` containing "lunch" (case-insensitive).
- Inline comment clarifies that there is no `Lunch` category in the owner's Outlook setup; `Logistic` is used for schedule-admin events (not specifically lunch), so category-based detection would false-positive on commutes etc.

### Not changed
- `book_lunch` in `calendarHealth.ts` still uses the `Logistic` category for the events it CREATES (different code path, existing convention).
- `$top: 100` cap in `getCalendarEvents` left alone. Bug #10 also reported missing Sunday meetings; the auto-triage agent hypothesized the pagination cap was the cause, but live logs show max 39 events per next-week query — well under the cap. Not the cause. Sunday-missing symptom is filed as a follow-up to investigate (likely presentation/prompt-level, not data-level).

### Migration
- None. No schema changes, no config changes.

---

## 1.7.6 — Skill renames (single-word noun form), em-dash avoidance, never-silence-after-eye, README cleanup

QA-driven cleanup pass: skill names now read like the agent's capabilities, prompt stops overusing em-dashes, eye-reaction never appears without a follow-up reply.

### Changed — skill renames

Three togglable skills renamed to single-word noun keys. Each describes WHAT the agent can do:

| Old key | New key |
|---|---|
| `meeting_summaries` | `summary` |
| `knowledge_base` | `knowledge` |
| `calendar_health` | `calendar` |

Legacy keys still parse and auto-migrate at load time in `skills/registry.ts:getActiveSkills` (same pattern as the existing `scheduling`/`coordination` → `meetings` migration). Existing profiles boot without edits.

Files touched: `src/skills/types.ts` (SkillId union), `src/config/userProfile.ts` (schema), `src/skills/registry.ts` (loader keys + migration), `src/skills/calendarHealth.ts` / `src/skills/summary.ts` / `src/skills/knowledge.ts` (class `id` field), `src/connectors/slack/app.ts` + `src/skills/summary.ts` (toggle reads — accept both old and new for grace period), `config/users/idan.yaml`, `config/users.example/user.example.yaml`, README.

### Changed — em-dash avoidance

Maelle was overusing the em-dash (—) in replies. New PUNCTUATION block in `systemPrompt.ts` instructs her to use commas, periods, parentheses, or two short sentences instead. Applies to every message — owner-facing AND colleague-facing, English AND Hebrew.

### Changed — eye-reaction moved AFTER addressee gate

Previously the `:eyes:` / `:thread:` read-receipt was added BEFORE the addressee gate. Silenced messages still got the emoji, confusing the user ("she read it but said nothing"). Now the reaction fires only when we're going to actually respond — after the gate clears, before the orchestrator call. If the gate silences, no eye.

### Changed — orchestrator never silences post-run

Empty-reply path now has a final fallback: `"Sorry, I didn't quite follow that one. Can you rephrase or give me a bit more context?"`. If the orchestrator ran but produced no text AND no tools fired AND the recovery pass also returned empty, we post the honest-confusion fallback instead of silence. The user's rule: if she put the read-receipt emoji, she should respond — even just to honestly say she didn't follow.

### Changed — README

- Architecture diagram redrawn: input is `channel | DM | group DM` (not "Slack DM / group / @mention"); Connectors shown as a peer layer to Skills (not nested below); arrow flow shows skills calling connectors.
- "Microsoft Graph" connector heading renamed to "Outlook Calendar" — Graph is the API we use to talk to Outlook, the connector itself is Outlook.
- Tech-stack row no longer says "no Haiku anywhere" — positive phrasing only ("used for every LLM call across the codebase").
- Summary + Knowledge skills added to the optional-skills table.
- New "Multi-modal input" section documenting voice messages, images/screenshots, text transcripts.
- Roadmap rewritten: WhatsApp owner-sync, Email connector, Inbound workflows, Meeting notes prep — all opened as labeled GitHub issues (#4-7).

### Migration

- No DB schema changes. No new env vars.
- Profile YAMLs: existing `meeting_summaries`, `knowledge_base`, `calendar_health` keys still work (auto-migrated). Migrate at your leisure to the new single-word forms.

---

## 1.7.5 — Stop silencing in active MPIM threads + MPIM-aware claim-checker

QA pass on v1.7.4 surfaced multiple "stuck" moments — Maelle going silent on legitimate follow-up messages in active group chats. Logs revealed three distinct silencing paths plus one false-positive that was tripping the claim-checker on natural in-room addressing.

### Fixed — claim-checker prose-tolerant JSON parse (Bug B)

Real-world QA caught Sonnet returning prose preamble before the JSON ("The draft contains a Slack-style ping `<@USER>` which implies..." then ```json {...). The parser stripped code fences but couldn't handle the prose, fell open, dishonest reply shipped. Now the parser regex-extracts the first `{...}` block containing `"claimed_action"` if the response doesn't start with `{`. Same pattern as the v1.7.3 calendar candidate parser fix — applied to claim-checker too (was missed last time).

### Fixed — silencing in active MPIM threads (Bug C, two gates)

Two separate gates were silencing legitimate follow-up messages in MPIMs where Maelle was actively engaged:

- **`relevance.ts` `isMessageForAssistant`** (runs first in the MPIM handler). Silenced Yael's reply ("Yes I am, but Elal are already back with their direct flight") to Maelle's question — verdict IGNORE.
- **`app.ts` addressee gate** (runs in `processMessage`). Silenced three explicit `@Maelle` follow-up messages — verdict HUMAN despite the @-mention.

Both gates now check if Maelle was the most-recent or second-most-recent speaker in the thread (`history.slice(-3).some(m => m.role === 'assistant')`). When she was just active, the gate is **skipped entirely** — the next message is almost certainly a continuation. The gates exist to filter unrelated chatter, not to block continuations of conversations Maelle is in the middle of.

### Fixed — claim-checker treats MPIM @-mentions as fake sends (Bug D)

Maelle replying in an MPIM and including `<@Yael>` to greet/address Yael in the room was being flagged by the claim-checker as a phantom send (no `message_colleague` ran). The corrective retry then forced `tool_choice: message_colleague`, creating an unwanted DM to Yael (separate from the MPIM thread).

The fix:
- New `mpimContext: { isMpim, participantSlackIds }` field on `ClaimCheckInput`
- `postReply.ts` passes the MPIM context through (using existing `mpimMemberIds`)
- Claim-checker prompt updated: when MPIM context is present and the `<@USER>` mention is for a PARTICIPANT in the listed group thread, that's LEGITIMATE in-room addressing — NOT a phantom send. Pings to people NOT in the participant list are still flagged.

### Migration

- No DB schema changes. No new env vars.
- Existing `mpimMemberIds` in postReply.ts is now propagated to the claim-checker; no code-call-site changes outside the path.

### Not changed

- Claim-checker's behavior for owner-DM replies untouched — still flags any phantom action claim.
- Addressee gate / relevance gate behavior in COLD threads (where Maelle hasn't spoken in the last 3 messages) untouched — gates still run and can silence as before.
- All other skills + flows unaffected.

---

## 1.7.4 — Knowledge base + owner social tracking + duplicate-send fix + cleanup

Wave of QA-driven fixes plus the first cut of the KnowledgeBaseSkill so Maelle has real depth on the company without bloating every prompt.

### Added — KnowledgeBaseSkill (togglable)

- New `src/skills/knowledge.ts` skill. Profile YAML key `knowledge_base: true` (default false).
- Owner drops markdown files into `config/users/<name>_kb/` (auto-discovered, no manifest, no restart). Section ID = relative path without `.md`. Created starter dir + README explaining the format.
- Always-loaded in prompt: a SHORT catalog listing available section IDs (~80 tokens). Tool `list_company_knowledge` and `get_company_knowledge(section_id)` exposed; Sonnet pulls full content on demand.
- 32 KB cap per section file (anything larger rejected to prevent prompt bloat).
- Path-traversal protection (rejects `..` / absolute paths / out-of-root resolution).

### Added — KB-relevance pre-pass in SummarySkill

- When both `meeting_summaries` AND `knowledge_base` skills are active, Stage 1 drafting runs a tiny Sonnet pass over the meeting subject + first 1000 chars of transcript to pick 0-3 relevant KB sections, then prefetches them and feeds the content to the drafting prompt as background. Fires automatically — owner doesn't have to ask.
- Solves the "you don't always know when you need it" dilemma: product/strategy meetings get company context grounded; interview/scheduling meetings skip the cost.

### Added — Owner social tracking

- Owner is now a regular `people_memory` row (pre-seeded at startup via `seedOwnerSelf`). Same machinery that tracks colleague hobbies/topics now tracks the owner's. Visibility-gated: workspace contacts list excludes the owner's own row from the visible list (already enforced); colleagues never see the owner's notes (people memory section not rendered for colleagues).
- New tool `note_about_self` — owner-only convenience wrapper that writes to the owner's row without requiring Sonnet to know the slack_id. Same shape as `note_about_person`.

### Changed — Social-context dynamics

- **Stale-topic detection.** A topic with `count >= 3` AND quality stuck at `neutral` (never progressed to engaged/good) is killed permanently. Marked STALE in the prompt — Maelle won't re-suggest it for initiation. Antidote to grinding the same dead subject forever.
- **Random topic pick.** When 2+ topics are available (not on cooldown, not stale), shuffle the pool per-turn and surface a "random pick this turn" hint. Stops Maelle from cycling the same top-of-list topic every time.
- **Fresh-opener fallback.** When everything is on cooldown, stale, or empty, the prompt now instructs Maelle to try ONE open discovery question ("what do you like to do after work?", "anything interesting going on outside work?") instead of going silent or reusing the dead topic. Engagement-level avoidant/minimal guards still respected.

### Changed — Architecture: `buildSocialContextBlock` relocated

- Moved out of `src/core/orchestrator/index.ts` into `src/db/people.ts` where it belongs (pure formatter for `people_memory` data, sibling to `formatPeopleMemoryForPrompt`).
- Orchestrator now imports it from `db/`. No behavior change. Sets up the future togglable persona skill (issue #3) to call it conditionally without the orchestrator having to know.

### Fixed — Amazia duplicate task (3-layer)

QA caught two outreach_jobs rows created 6 seconds apart for a single owner ask. Root cause: claim-checker false-positive on "the message is on its way to Amazia" (despite `[message_colleague: Amazia]` being in toolSummaries) → triggered retry with forced `tool_choice: message_colleague` → Sonnet called the tool a second time → duplicate. Three guards now prevent this.

- **Claim-checker prompt tightened (`src/utils/claimChecker.ts`).** Explicit rule: "if TOOL ACTIVITY shows the matching tool already ran this turn, the claim is HONEST regardless of phrasing — 'on its way', 'sending now', 'I've reached out', 'sent' are all valid." Stops the false-positive at the source.
- **postReply.ts retry guard.** Even when claim-checker errs, if `result.toolSummaries` shows the matching tool already ran for the right target, the retry is SKIPPED. Defense-in-depth.
- **Orchestrator-level idempotency on `message_colleague`.** Tracks `(colleague_slack_id)` per turn. Second call this turn for the same colleague → short-circuit with explicit `_note: "already messaged this turn"`. Same pattern as `coordinate_meeting` and `delete_meeting` already use.

### Fixed — Language rule

- The base prompt had two conflicting rules: "mirror the latest message" vs "reporting someone else's words: match THEIR language." When owner asked in English about Hebrew-speaking colleagues, the second rule won and Maelle replied in Hebrew. Replaced with a clearer hierarchy: owner's current-turn language ALWAYS wins for the narrative; verbatim quotes can stay in original language; memory of preferred language is for INITIATING outreach to THEM only.

### Added — GitHub repo

- 7 labels created with deliberate color logic — priority warm-spectrum (Low cold blue → Medium amber → High red), type distinct (Bug orange, Feature purple, Improvement green, Task gray). All open issues backfilled.

### Migration

- DB schema: no changes. Owner pre-seed is upsert-idempotent.
- Profile YAML: `knowledge_base: false` default for new profiles. Existing profiles: enable manually if you want it.
- KB content: empty by default (just the README). Add markdown files to populate.

### Not changed

- All other skills unchanged.
- Audio + image paths untouched.
- Conversation persistence unchanged.

---

## 1.7.3 — SummarySkill fixes from first real-world test

First QA of 1.7.2 surfaced two bugs. Owner sent feedback with three distinct asks crammed into one message ("write in first person, paragraph per topic with empty lines, and Yael wasn't there") — Sonnet routed two of them to the wrong tool (`learn_preference` instead of `learn_summary_style`), dropped the third, and produced no text reply. Silence. Plus a parse warning during Stage 1 calendar correlation.

Root causes were three things stacked:
1. The classifier was single-intent — couldn't represent "style + style + edit" as one feedback.
2. `learn_preference` was more familiar to Sonnet than the new `learn_summary_style`; the prompt section's "call classify_summary_feedback first" was a suggestion, not a gate.
3. When tools ran but final text was empty, the orchestrator's recovery pass also returned empty → silence. The owner had no idea their feedback landed.

### Changed
- **Multi-intent classifier.** `classify_summary_feedback` now returns an array of intents (STYLE_RULE / DRAFT_EDIT / SHARE_INTENT / UNRELATED), each with its own action. Owner saying "write in first person, paragraph per topic with empty lines, and Yael wasn't there" → 2 STYLE_RULE + 1 DRAFT_EDIT, all handled in the same turn. Result includes an `_action_plan` array and a `_must_reply_with` directive specific to the combination of intents found. New `UNRELATED` kind for off-topic messages mid-thread (owner pivots to a separate question) — orchestrator handles those normally.
- **`_must_reply_with` hints on every Summary tool result.** Replaces the softer `_note` field. Tells Sonnet exactly what confirmation text to write before ending the turn.
- **`learn_summary_style` description explicitly warns against `learn_preference`** in active summary sessions. Belt-and-suspenders for cases where the deterministic gate isn't active.
- **Calendar candidate JSON parse hardened.** `tryCalendarMatch` prompt now leads with strict-format instruction; parser falls back to extracting the first `{...}` block when Sonnet ignores the format and returns prose. Previously: `SyntaxError: Unexpected token 'L', "Looking at"...` warning, no calendar match (graceful but uncorrelated). Now: parse succeeds in the prose case, calendar match lands.

### Added — deterministic routing
- **Forced first tool in active iterating sessions** (`src/connectors/slack/app.ts`). When the orchestrator runs and there's an active summary session for the thread, `forceToolOnFirstTurn: { name: 'classify_summary_feedback' }` is set automatically. Sonnet's first tool call this turn is FORCED to be the classifier — it cannot default to `learn_preference` or another familiar tool. After the classifier returns, Sonnet picks freely from the action plan.

### Added — silence backstop
- **Recovery pass falls back to a tool-grounded confirmation** when tools ran but final text was empty (`src/core/orchestrator/index.ts`). Builds a human-ish confirmation from the tool summaries ("Done — saved the style preference and updated the summary. Let me know if anything's off.") rather than letting the owner see silence. Only triggers when actual tool work happened in the turn — pure no-tool/no-text turns still silence as before (better than fabricated "Done.").

### Migration
- No schema changes. No new env vars.
- Existing summary sessions (if any) continue to work — the classifier change is backward-compatible at the data level.

### Not changed
- Summary persistence rules (full text wiped on share, meta forever).
- Owner-only scoping for transcripts in DM and MPIM.
- Action item follow-up tasks (2pm Brett-local).
- Image, voice, all other skills untouched.

---

## 1.7.2 — SummarySkill: meeting transcript → summary → distribute

Owner records meetings and needs summaries he can share. New togglable skill takes a transcript file, drafts a structured English summary, iterates with the owner, then distributes to named recipients with auto-tracked follow-ups for action items that have deadlines.

Three deterministic stages (logged, traceable):
- **Stage 1 (Drafting)** — `.txt` file uploaded in DM → calendar correlation (if caption hints at a time) → Sonnet drafts structured JSON (subject, main_topic, attendees, paragraphs, action_items, unresolved-speakers) → posted to thread.
- **Stage 2 (Iterating)** — owner replies in the thread are routed by a Sonnet classifier into STYLE_RULE (persisted via `learn_summary_style` for all future summaries), DRAFT_EDIT (this summary only), or SHARE_INTENT (transition to Stage 3). Size-agnostic — small word swap or full rewrite, same flow.
- **Stage 3 (Sharing)** — owner names recipients explicitly. Internals get DM/MPIM/channel posts via the new Slack messaging shim. External meeting attendees can't be Slack-DM'd (they're not in the workspace) — flagged honestly to the owner. Action items with internal Slack assignees + deadlines spawn `summary_action_followup` tasks firing 2pm in the assignee's local timezone.

### Added
- `src/skills/summary.ts` — the SummarySkill. Tools: `classify_summary_feedback`, `learn_summary_style`, `update_summary_draft`, `share_summary`, `list_speaker_unknowns`. Plus internal `ingestTranscriptUpload` helper called from the Slack file_share branch.
- `src/db/summarySessions.ts` + `summary_sessions` DB table. One row per per-thread session. `current_draft` is the only ephemeral field (cleared on share / 7d idle). All meta (subject, attendees, date/time, main_topic, shared_to) is kept forever for reference.
- `src/connections/slack/messaging.ts` — minimal Slack messaging shim with `sendDM`, `sendMpim`, `postToChannel`, `findUserByName`, `findChannelByName`. Foundation for the Connection-interface migration in issue #1. SummarySkill is the first consumer; outreach.ts and coord.ts will port over as that issue progresses.
- New task type `summary_action_followup` + dispatcher `src/tasks/dispatchers/summaryActionFollowup.ts`. At due_at, Sonnet composes a one-line check-in DM in the assignee's preferred language (English fallback), sends it via the messaging shim, then creates an `outreach_jobs` row with `await_reply=1` so the colleague's reply routes back to the owner via the existing `handleOutreachReply` pipeline. No new reply machinery needed.
- New `target_slack_id` and `target_name` columns on the `tasks` table (idempotent migration). Populated for outreach + summary_action_followup tasks. One-time backfill on startup fills existing outreach tasks from their linked `outreach_jobs.colleague_slack_id`.
- `getOpenTasksWithPerson(ownerUserId, slackId)` query and `with_person` arg on the existing `get_my_tasks` tool. Owner asks "what's open with Brett?" → all 1:1 outreach + follow-ups in one list. Coord tasks (multi-party) excluded since `target_slack_id` is single-valued.
- Active summary session injected into the orchestrator's `ACTIVE IN THIS THREAD` block so Sonnet routes owner replies through `classify_summary_feedback` instead of treating them as new requests.

### Changed
- Slack DM file_share handler in `src/connectors/slack/app.ts` extended with a transcript branch (text/plain, filetype=text|txt) ahead of the audio + image branches. Owner-only.
- `OutreachCoreSkill` flow unchanged — summary follow-ups deliberately reuse it for the reply-routing path, not a parallel mechanism.

### Security / privacy
- External attendees never auto-resolved to Slack IDs (they're not in the workspace). Action items targeting externals stay as plain text; no follow-up DM, no task.
- Summary distribution: meeting attendees are the default-allowed recipient set. Owner naming someone outside that set = explicit grant. Channel posts always require explicit owner naming.
- Action items where assignee IS the owner are skipped for follow-ups (Maelle DM'ing the owner about his own commitment is weird).

### Persistence rule
- Full summary text is NEVER kept after share. Drafts wiped on Stage 3 transition and after 7 days idle.
- Meta we KEEP forever per session: meeting_date, meeting_time, meeting_subject, main_topic, attendees JSON, is_external, shared_at, shared_to.
- Style preferences via existing `user_preferences` table, category=`summary` — applied to all future summaries automatically.

### Migration
- Profile YAML: enable with `skills: { meeting_summaries: true }`. Schema already had this key (defaulted false); just flip to true on the profiles that want the skill.
- DB migrations are idempotent — run on startup. Existing outreach tasks get `target_slack_id` backfilled from outreach_jobs (logged at INFO).
- No new env vars.

### Connection-interface progress (issue #1)
- The new `src/connections/slack/messaging.ts` is the first piece of the Connection layer. SummarySkill never imports from `coordinator.ts` or `outreach.ts`. Updating issue #1 with what's left: port outreach.ts + coord.ts to the same primitives, define the formal `Connection` interface so email/whatsapp slot in.

### New companion issue
- "Send meeting summaries by email to external participants (waits on email Connection)" — opened so we don't lose the requirement.

### Not changed
- Audio path untouched.
- Image path (1.7.1) untouched.
- Existing skills (Meetings, CalendarHealth, Search, Research) untouched.
- No new env vars; same `ANTHROPIC_API_KEY`.

---

## 1.7.1 — Vision: Maelle reads images

Owner pasted a screenshot in DM and Maelle ignored it. Voice has been a first-class input modality for ages; images haven't. Adding them as a peer modality so "look at this bug" / "what does this calendar mean" / "is this email worth replying to" all work without the owner having to describe what's on the screen.

Native multimodal — Sonnet sees the actual pixels (exact UI text, layout, error messages), not a pre-described summary. The "transcribe-then-discard" approach voice uses would lose too much for the bug-screenshot use case.

### Added
- New `src/vision/` module mirroring `src/voice/` shape. `downloadSlackImage` validates mimetype (jpeg/png/gif/webp) + size (5MB cap) and returns a typed error object instead of throwing — caller decides what to tell the owner. `buildImageBlock` emits an Anthropic `image` content block ready for the message array.
- New `src/utils/imageGuard.ts` — Sonnet-based scanner that extracts any text from an image and flags injection-like content ("ignore previous instructions", fake system prompts, tool-call payloads). Strict-JSON output, fails open on parse / API errors. v1.7.1 owner path: log + shadow-notify but proceed (owner is trusted). The plumbing is ready to flip to refuse-and-notify the moment colleague paths open — single switch, no re-architecture.
- VISION block in the owner system prompt, paired with the existing VOICE block. Tells Maelle to engage with what's in the image directly rather than narrating "I see you sent a screenshot".

### Changed
- `OrchestratorInput` now accepts `images?: Anthropic.ImageBlockParam[]`. When present, the current user turn is sent as a content array `[image, ..., text]` instead of a plain string. Subsequent tool-result turns are unchanged. Logged at INFO with image count + caption preview.
- `processMessage` in `src/connectors/slack/app.ts` accepts an `images` field and plumbs it to the orchestrator. When images are attached, conversation history persists the user turn as `[Image] caption` so future turns know an image was shared (the bytes themselves are never stored).
- DM handler dispatches image file_shares to a new shared `processImageFileShare` helper (same pattern as the audio branch).
- MPIM handler also wired to the same helper, but **owner-gated**: colleagues' images are silently dropped in v1.7.1 to avoid opening an injection vector before the colleague-path guard policy is in place.

### Security
- Owner-only by design in v1.7.1 — channels and colleague MPIM messages are out of scope until the connection-interface work in #1 lands.
- Image guard always runs even on the owner path. Cost is one Sonnet image call (~1.5k tokens) per image — negligible against the value of the audit trail.
- Cap of 4 images per file_share event for sanity.

### Not changed
- Audio path untouched.
- Voice's pre-existing "double append" pattern (helper appends marker, processMessage re-appends bare text) was left alone — image path uses the cleaner single-append.
- No schema changes. No new env vars (uses the same `ANTHROPIC_API_KEY`).
- `@anthropic-ai/sdk: ^0.24.0` already supports image content blocks; no SDK upgrade needed.

### Known gaps (deliberate, deferred)
- Channel @mention images: out until #1 brings the Connection interface so the same image guard policy can move from "log and proceed" to "refuse and notify" cleanly across surfaces.
- Persisting images for re-reference in later turns: explicitly NOT done. Matches the "human EA remembers you showed her a screenshot, doesn't re-see it" model.
- Image *output*: Maelle doesn't generate images.

---

## 1.7.0 — Chapter close: 1.6 stabilization wave done, 1.7 begins

1.6 started as a cleanup release and became a 14-patch stabilization wave — the first time Maelle was put under real QA with an owner + colleagues on a live Slack workspace. We found a lot, fixed most of it, and learned where the product ends up breaking under pressure. Closing the chapter here so the next set of changes has a clean starting line.

### Where 1.6 left us — what's solid now

**Honesty and truth-telling.** The orchestrator no longer fabricates confirmations. Empty replies trigger a recovery pass (grounded in actual tool history) instead of "Done." The claim-checker catches false action claims ("I sent it") and forces a retry turn with tool_choice. Delete-meeting is idempotent per-event-id with a confirm-before-delete protocol. The date verifier catches wrong weekday/date pairs and retries with a corrective nudge.

**Human voice.** Maelle never says "the system / threshold / force / clear the check" when talking to the owner about his own preferences — the rules are his, narrated as such. Meeting-mode asked in plain words ("in person or online? where?"), not as a four-option enum. When ambiguous, she asks one clarifying question instead of going silent.

**Task system is trustable.** `get_my_tasks` returns hydrated data (real subjects, message text, counterparts) from all relevant tables — no more stale ghosts, no more gap-filling from memory. `completed` tasks stay visible until the owner is informed. `updateCoordJob` owns the coord-terminal → approval-sync invariant (one gate, impossible to forget). Routine materializer picks the most recent viable missed firing instead of yesterday's dead one.

**Memory is clean.** `people_memory.interaction_log` and `people_memory.notes` no longer accumulate operational state (raw outreach messages, in-flight coord subjects). History writes happen at terminal transitions only — past-tense, safe to read. Per-contact interaction cap: 10 default, 30 for people in the current chat.

**Structure.** Four-layer model is respected. `runner.ts` split into one dispatcher per TaskType. `app.ts` reply pipeline extracted to `postReply.ts`. `coord.ts` pulled utils / approval-emit / booking into submodules. Every skill owns its own prompt rules via `getSystemPromptSection` — the base prompt holds only general honesty, identity, dynamic data.

**Prompt budget.** Owner prompt went from ~20k tokens (pre-1.6.11) to ~12k. Colleague ~15k → ~9k. Pure pruning — no semantics lost.

**Security posture.** Claim-checker replaced the reply verifier. Security-gate events go to WARN logs only (no more shadow Slack dumps). `#appr_<id>` tokens stopped being rendered. Maelle's self-memory row is seeded per profile. `scheduling` and `coordination` legacy YAML keys auto-migrate to `meetings`.

### What 1.7 starts with — targets on the table

- **Agent-vs-transport split.** `connectors/slack/coord.ts` + `coordinator.ts` still hold meetings-domain state-machine logic that happens to DM via Slack. A formal `Connection` interface + extracting the state machine to `skills/meetings/` is the stated next architectural pass — prereq for running Maelle on email / WhatsApp without editing the state machine.
- **Model flexibility.** Gemini 3.1 swap is on the table; the claim-checker + recovery + date-verifier all have strict-JSON outputs specifically so a model change doesn't regress the honesty guarantees.
- **External QA.** The first round with people outside the core test loop happens in 1.7. We expect new classes of bugs — tone under edge cases, timezone edge cases, foreign-language colleagues, surprise calendar patterns. Prompts vs code: prefer code (deterministic) for truth-critical guards (booking, deletion, date alignment), prompts for tone and judgment. Build new guards in whichever layer gives determinism where it matters.
- **Multi-computer dev.** Deferred from 1.6; may land in 1.7 if it becomes friction.

### Migration
- No schema changes. Restart picks up the new version.
- CHANGELOG entries for each 1.6.x patch remain below as the record of how we got here.

---

## 1.6.14 — Stop polluting people_memory.notes; focus-scoped interaction history

The 1.6.13 prompt pruning cut rules from ~14k → 5k tokens but the owner prompt was still ~15k because of a SECOND pollution source we hadn't audited: `people_memory.notes`. Every inbound colleague message wrote `Sent a message to Maelle: "..."` into that contact's `notes` field — same anti-pattern as the v1.6.8 interaction_log fix, different field. Heavy contacts had 50+ note entries (~5kB each) loading into the prompt forever.

### Changed
- **Stopped writing message logs to `people_memory.notes`** (`src/connectors/slack/app.ts:318`). `notes` is for relational context (who they are, what we've learned), not a verbatim message log. Conversation history + outreach_jobs + audit log already preserve message content; the third copy in the prompt was pure cost. Removed the `appendPersonNote` call in the colleague-message handler; left the `logEvent` for briefings since that goes to a separate audit table.
- **Per-contact interaction_log cap is now context-aware** (`src/db/people.ts` → `formatPeopleMemoryForPrompt`). Default: last 10 entries per contact (was 30). For contacts in the current chat (MPIM members), keep last 30 — full memory loaded for people Maelle is actively talking to. Empty MPIM list / 1:1 DM with Maelle → everyone capped at 10. Keeps memory rich where it matters, light where it doesn't.
- **Threaded `focusSlackIds` through** `buildSystemPromptParts` → `buildSystemPrompt` → `formatPeopleMemoryForPrompt`. Orchestrator computes the set as `mpimMemberIds` minus owner when `isMpim` is true; undefined otherwise.

### Added
- **`scripts/purge-notes-pollution.cjs`** — one-shot DB cleanup. Strips entries matching operational patterns (`^Sent a message to ` / `^Maelle sent message on behalf of `) from every people_memory.notes. Owner-curated notes (from `note_about_person` tool) are preserved. Ran on dev DB: **146 entries removed across 11 contacts** (Yael −50, Ysrael −50, Oran −11, Michal −10, others smaller).

### Numbers
| Prompt | 1.6.13 | 1.6.14 | Cut |
|---|---|---|---|
| Owner 1:1 | 15.5k tok | **12.2k tok** | −21% |
| Owner MPIM (1 focus contact) | 15.5k tok | 12.5k tok | −19% |
| Colleague | 9.3k tok | 9.3k tok | (no notes load there) |

Cumulative: owner is now **12.2k tokens vs the original 20k** in 1.6.11 — **−39%** total. The remaining bulk is real data the model needs (people contacts + learned prefs + date table + pending approvals).

### Migration
- No schema changes.
- Run `node scripts/purge-notes-pollution.cjs` once to clean existing operational entries from notes. (Already done on dev: 146 entries removed.)
- From this version forward, only owner-curated notes via `note_about_person` end up in `notes`.

---

## 1.6.13 — Prompt pruning: owner −22%, colleague −37%, skill-specific rules move to their skill

Owner prompt had grown to ~20k tokens — 10× a healthy system prompt. Three root causes: meeting-specific HONESTY rules lived in the base prompt (every non-meeting turn pays for them), duplicated content (quarter-hour rule in 3 places, schedule numbers in 2), and verbose example blocks (3-4 Wrong/Right pairs where 1 suffices). The "every skill owns its own rules" principle wasn't being followed — future skills would inherit the same bloat pattern.

### Changed — base prompt (`src/core/orchestrator/systemPrompt.ts`)
- **Meeting-specific HONESTY rules moved to MeetingsSkill.** RULE 2a (never lie about bookings), RULE 5a (scheduling state requires tool call), RULE 5c (don't summarize unresolved), RULE 6 (calendar specifics) all left the base prompt and now live in a single MEETINGS HONESTY RULES block inside the MeetingsSkill section. These rules only matter when meetings are in play; they don't need to be loaded on every colleague turn or every memory-only turn.
- **Colleague authorization block consolidated.** Was ~60 lines of overlapping bullets (content rules + calendar sharing + interviews + what colleagues can/cannot do + identity + injection defense + honesty rules). Now ~15 lines, same semantics, tighter prose. Colleague prompt dropped from 14.7k → 9.3k tokens.
- **SOCIAL LAYER / HOW TO COMMUNICATE / HEBREW OUTPUT / GENDERED FORMS / PERSONA / OWNERSHIP / CALENDAR ISSUES / THREAD MEMORY / SLACK FORMATTING / RULES 3-8** all tightened: 3+ Wrong/Right examples → 1 where possible, bullet walls → single paragraphs where the rule is the same.

### Changed — MeetingsSkill (`src/skills/meetings.ts`)
- **Added MEETINGS HONESTY RULES block** (relocated from base). One paragraph each for: never lie about bookings, scheduling state requires tool call, don't summarize unresolved, calendar specifics.
- **Removed "Slot rules (enforced automatically)" duplication** with the HARD SCHEDULE block — one source of truth now.
- **Route 1/2, Duration, Location, Timezones, Calendar scope with colleagues, Subject rules, Work week, Re-verify availability** — all rewritten to be terse without losing semantics.

### Numbers
| Prompt | Before | After | Change |
|---|---|---|---|
| Owner  | ~20,000 tok | ~15,500 tok | −22% |
| Colleague | ~14,700 tok | ~9,300 tok | −37% |
| MeetingsSkill | ~4,820 tok | ~3,900 tok | −19% |

Base dynamic (owner) went from 13.8k → 10.3k; most of the remaining dynamic content is DATA (people_memory contacts + their interaction_logs + learned prefs + pending approvals) which is context the LLM needs, not rules that could be trimmed.

### Principle going forward
Each skill owns its own rules. The base prompt keeps only:
- Identity + persona
- Dynamic data (date, people memory, prefs, approvals, timezone)
- Authorization / colleague scope
- GENERAL honesty rules (1-8)
- Language + Slack formatting + tone
New skills add their domain-specific rules to their own `getSystemPromptSection` — they never extend the base.

### Migration
- No schema, no profile, no code-interface changes. Pure prompt text movement.
- All new rules added in 1.6.12 are preserved — just relocated to their correct layer.

---

## 1.6.12 — Prompt touchups: human-EA voice, quarter-hour universal, better empty-slot handling

Six pure-prompt fixes from QA on the "book 40 min with Amazia, include Maayan + Onn" flow. No code changes.

### Changed — MeetingsSkill prompt
- **Empty-result behavior rewritten.** When find_available_slots returns 0–1 slots, DON'T default to "want me to look at early morning?" Instead: fetch the raw calendar, find the gaps that are ≥ the meeting duration, and offer them upfront with the SPECIFIC rule each breaks. ("Sunday 13:15–15:30 — home day, leaves 20 min of your 1h home focus.") Owner can accept or reject. Only when he rejects all normal-hour options do you propose extended hours.
- **Universal quarter-hour rule.** Any slot START time Maelle proposes — from the slot finder OR narrated from a raw calendar gap — MUST be on :00/:15/:30/:45. A gap starting at 14:40 → propose 14:45. 13:10 → propose 13:15. The 5-min offset is fine; durations already bake in the buffer. ONLY exception: the owner explicitly names an off-grid time ("book at 14:40") — then use what he said.
- **Parse rule for "meeting with A, include B and C"**. First clause = principal (participant whose timing matters). "Include / also / and" names = just_invite (added to calendar invite, no DM). "40 min with Amazia, include Maayan and Onn" → participant: Amazia, just_invite: Maayan + Onn. Only "meeting with the founders" (plural, no hierarchy) makes everyone a participant.

### Changed — base honesty prompt
- **RULE 7 strengthened.** Once the owner says go-ahead, new details discovered mid-flow (rule violations, constraints, fine print) are INPUT to the action, not new gates. Deliver as a heads-up line IN the action reply, not as a re-ask. "Book 14:45" → book → "Done. Heads up: eats into your 2h focus block." Not "the system blocks this, want me to force it?"
- **"Owner names a time → skip find_available_slots".** Slot finder is for DISCOVERING options. When the owner already picked a specific time, go straight to the booking/outreach tool. Re-running the slot finder keeps bumping into the focus-time filter and produces false blocks.
- **Never sound like a machine (new block under PERSONA BOUNDARY).** NEVER say "the system / threshold / policy / rule / constraint / force / clear the threshold / doesn't pass" when talking to the owner about his own preferences. The rules ARE his preferences — narrate them as such. "Your settings / you usually / tighter than your usual X / eats into your 2h focus block." Never "force" — nothing to force, it's his calendar. "Book it anyway" / "lock it in" / "go ahead despite X".
- **One heads-up per rule per thread.** If the owner has already acknowledged a constraint in the same thread ("i'm ok / go ahead / do it / yes / check"), do NOT mention that constraint again. Repeating is nagging.

### Not changed (deferred)
- Prompt size audit: owner system prompt measures ~20k tokens, colleague ~15k. Big — worth a pruning pass later. See notes in the conversation / v1.6.12 QA round.

---

## 1.6.11 — Per-day-type focus-time threshold

Owner wanted the 2-hour "protected focus time" rule to apply to OFFICE days only, and a shorter 1-hour threshold for home days. Before this, a single `free_time_per_office_day_hours` was applied across both.

### Added
- **Optional `meetings.free_time_per_home_day_hours`** in the profile YAML (zod schema in `src/config/userProfile.ts`). If unset, home days fall back to the office value — no behavior change for existing profiles that didn't opt in.

### Changed
- **`findAvailableSlots`** (`src/connectors/graph/calendar.ts`) now picks the threshold per slot based on whether its day is classified as office or home via the existing `classifyDay` helper. No threshold is applied to "other" days (shouldn't happen for valid work days anyway).
- **`analyzeCalendar`** (`src/skills/_meetingsOps.ts`) evaluates the `no_buffer` issue using the day-type-specific threshold. Issue detail now says "on a office/home day" so the narrated reason matches the rule.
- **Meetings skill prompt block** now lists both values separately so the LLM tells the owner the right number for each day type.
- **`config/users/idan.yaml`** updated: `free_time_per_office_day_hours: 2`, `free_time_per_home_day_hours: 1`.
- **`config/users.example/user.example.yaml`** gains the new optional field with a comment.

### Migration
- No schema required — field is optional with graceful fallback to the office value.
- Restart Maelle to pick up the YAML change.

---

## 1.6.10 — Routine materializer picks the most recent viable firing; one briefing only

Two bugs from QA. Maelle booted at 07:59 Thursday after an overnight downtime. Her daily health check had `next_run_at = yesterday 07:30`. The materializer: (1) created a task for YESTERDAY's slot (24h late → runner skipped as stale), and (2) fast-forwarded past TODAY's 07:30 slot (which was only 29 min late — perfectly viable) and set the routine's next run to Sunday. Net result: no briefing today, no health check today, three days of silence. Plus: we had TWO morning briefings running (one system, one user-created leftover from an earlier era).

### Changed
- **Materializer picks the most recent VIABLE missed firing** (`src/tasks/routineMaterializer.ts`). New algorithm: walk forward from `routine.next_run_at` through every missed slot. For each slot, run `assessLateness` — if within the cadence threshold, mark as candidate (and keep walking to find a MORE recent viable one). The cursor naturally lands on the first future firing. Materialize a task for the most recent viable missed firing (if any); advance `next_run_at` to the first future firing. This means: late-boot with today's slot still viable → today's slot runs; long downtime past all thresholds → nothing stale fires, clock advances cleanly; no more "materialize-then-skip-as-stale" noise in the logs.
- **`create_routine` blocks briefing-like titles.** Morning briefing is a core system routine managed by `ensureBriefingCron` (one per owner, is_system=1). The tool now rejects any `create_routine` call whose title matches `/\b(morning|daily)?\s*brief(ing)?\b/i` with a clear error explaining that briefing is core and can't be duplicated. Owner can still ask for a DIFFERENT recurring report with a different name (e.g. "Afternoon recap") — only "briefing" is reserved.

### Added
- **`scripts/purge-duplicate-briefings.cjs`** — one-shot DB cleanup. Soft-deletes (status='deleted') any user-created routine with a briefing-like title, cancels any open routine-tasks linked to it. Ran against the local DB: 1 routine deleted (the leftover "Morning briefing" @ 08:00 that was coexisting with the system 09:00 briefing).

### Migration
- No schema changes.
- Run `node scripts/purge-duplicate-briefings.cjs` once to clean existing duplicate briefings. (Already run on dev.)
- The canonical briefing is `system_briefing_<ownerId>`, is_system=1, one per owner. Future changes to briefing time/schedule go through profile config, not a second routine.

---

## 1.6.9 — interaction_log logs HISTORY, not state

Quick follow-up on 1.6.8. The cleanup was too aggressive — it stopped all writes of message_sent / coordination types, leaving Maelle with no memory that a past conversation happened at all. The owner wants her to remember "we talked with Ysrael yesterday about X" — what she doesn't want is her remembering "we're currently coordinating X" while it's still churning.

The distinction is timing: **past-tense facts = yes, mid-flight state = no.**

### Changed
- **`updateCoordJob` writes `meeting_booked` / `conversation` entries to each key participant's interaction_log** on terminal transitions (`booked` / `cancelled` / `abandoned`). Summaries are past-tense and specific: `"Booked meeting 'Subject' for 2026-04-22 14:00 (55 min)"` / `"Tried to set up 'Subject' — was cancelled before booking"` / `"Tried to set up 'Subject' — didn't get a response, closed it out"`. Same terminal-only invariant that carries approval sync and approval_expiry cancellation, so one code path owns it all.
- **`updateOutreachJob` writes `message_sent` entries** on terminal transitions (`replied` / `no_response`). Summaries capture the exchange: `"Exchange: sent '...' → replied: '...'"` / `"Reached out ('...') — no response after follow-ups"`. No write on `sent` (in-flight) or `cancelled` (purge / explicit cancel — not worth remembering).
- **Removed the read-time type filter in `formatPeopleMemoryForPrompt`**. It was shielding against the old write path; with writes happening only at terminals now, every entry in the log IS past-tense history. Nothing to filter. Simpler and honest.

### Why this shape
The coord and outreach terminal transitions are the SAME invariant point as the approval-sync and approval_expiry-cancellation logic already in `updateCoordJob` (v1.6.2). Call-site code doesn't have to remember to log; the DB update gate owns it. Future regressions where a new caller forgets to log history are impossible by construction.

### Migration
- No schema changes.
- Legacy operational entries in `interaction_log` were purged in 1.6.8 via `scripts/purge-interaction-log-pollution.cjs`. From 1.6.9 forward, new entries will be terminal-only and safe. No re-run needed.

---

## 1.6.8 — Task system: single source of truth, unpoisoned memory

Fixes the task system's two structural bugs uncovered in QA:
1. Fire-and-forget messages (message_colleague with await_reply=false) disappeared from "what tasks do you have" immediately, because the linked task row was created at `status='completed'` and get_my_tasks only showed earlier statuses. Result: the owner sends two messages and the system shows neither.
2. `people_memory.interaction_log` was being polluted with operational state ("Sent message on behalf of X: '...'", "Coordinating 'Plans and Onboarding' with X"). Those entries persist forever and get injected into the owner's system prompt via `formatPeopleMemoryForPrompt` — so the LLM kept re-surfacing old coord subjects long after the underlying job was cancelled. This is the source of the "Plans and Onboarding" hallucination: the DB was clean after purge, but the person's interaction_log still carried the string.

### Changed
- **`getOpenTasksForOwner` includes `'completed'`** (`src/tasks/index.ts`). Tasks stay visible after they run, until the owner is actually informed (the existing `completed → informed` two-step). Fire-and-forget messages now appear in "what's on your plate" until briefed, then drop.
- **`get_my_tasks` tool output is now enriched** (`src/tasks/skill.ts`). Every task row is hydrated by joining to its linked domain table:
  - outreach tasks → colleague name, full message sent, sent_at, await_reply flag, reply if any
  - coordination tasks → subject, participants, coord status, winning_slot
  - approval_expiry tasks → kind, subject, expires_at
  Also unifies pending_approvals and colleague_requests (store_request) into the same response. Result shape: `{ summary, pending_your_input, pending_approvals, colleague_requests, waiting_on_others, active_tasks, recently_done, ... }`. A `_note` field tells the LLM: describe only what's in this response; don't add context from conversation memory or people_memory.
- **`message_colleague` no longer writes to `interaction_log`** (`src/core/outreach.ts`). The outreach_jobs + tasks rows track the message end-to-end already.
- **`initiateCoordination` no longer writes to `interaction_log`** (`src/connectors/slack/coord.ts`). coord_jobs tracks it.
- **`formatPeopleMemoryForPrompt` filters out operational interaction types at read time** (`src/db/people.ts`). Even if legacy rows carry them, they don't reach the prompt. Operational types dropped: `message_sent`, `message_received`, `coordination`, `meeting_booked`, `conversation`. Relational types kept: `social_chat`, `other`. Defense-in-depth so future regressions can't re-poison the prompt.

### Added
- **`scripts/purge-interaction-log-pollution.cjs`** — one-shot DB cleanup. Strips operational interaction entries from every people_memory row. Preview first, transaction commit. Idempotent.

### Migration
- No schema changes.
- Run `node scripts/purge-interaction-log-pollution.cjs` once to clean the existing operational entries from the DB. (Already run on the local dev DB during this version bump — 9 rows touched, 21 entries removed.)

---

## 1.6.7 — Ambiguity → ask, not silence

When the owner's request is genuinely ambiguous ("move simon and dina to weds" when weds is a vacation day, anchor meeting is on a different day), Maelle was going silent — no tools ran, no draft, recovery pass wrote `NO_REPLY`, nothing posted. Honest, but useless. v1.6.7 tells her to ASK instead.

### Changed
- **Base honesty rules — RULE 5 extended.** If the request is ambiguous (two reasonable interpretations, missing day / name / time, unparseable instruction), ASK ONE short clarifying question. "Not sure I follow — did you mean Tuesday or Wednesday?" beats a silent stall and beats a confident guess. Never go silent because you're confused.
- **Recovery prompt restructured into three branches** (`orchestrator/index.ts`). When the orchestrator finishes with no reply, the recovery pass now chooses between: (A) describe what you did, grounded in tool results; (B) you did nothing because the request was ambiguous — say so plainly AND ask one specific clarifying question; (C) `NO_REPLY` as last resort only. Branch B is new — previously the recovery only offered A or NO_REPLY, which produced silence in the ambiguous case.

### Migration
- No schema changes.

---

## 1.6.6 — "What are my options" goes through the tool, buffer semantics corrected, date verifier

Follow-up from the v1.6.5 QA round on the 55-min slot-finding flow. Three of Maelle's failures had one root cause: for "what are my options" questions she was reasoning from raw `get_calendar` output instead of calling `find_available_slots`, so schedule rules weren't applied and proposed times (like 17:05) were off-grid. The buffer semantics were also wrong: the allowed durations (10/25/40/55) already bake a 5-min trailing buffer into every meeting, so padding the busy blocks AGAIN in the search produced artefacts. And "Sunday 20 Apr" (when Sunday is 19 Apr) kept slipping through the DATE LOOKUP prompt rule, so we moved that guard to code.

### Changed
- **Buffer padding removed from `findAvailableSlots`.** The profile's `buffer_minutes` is no longer applied as padding around busy blocks in the isFree check (`cursor.getTime() < busy.end.getTime() + bufferMs` — gone). The rationale: the allowed durations (10/25/40/55) are designed so every meeting Maelle books ends 5 min short of the hour boundary, creating the buffer naturally. Applying it again in the search produced 17:05 after a 17:00 end. Connected meetings (start right after the previous one ends) are now valid and preferred. Travel buffer for `meeting_mode: 'custom'` stays.
- **Prompt — options always go through the tool.** New rule in the MeetingsSkill section: for "what are my options / when am I free / find me a slot / do I have time for X" questions, call `find_available_slots`. Reasoning from `get_calendar` / `analyze_calendar` output to propose specific start times produces slots that don't honor buffer, lunch, thinking-time, or day-type rules. Two exceptions: (a) the owner asked for a non-standard duration, (b) the tool came back empty and the owner is pushing back — then narrating a raw gap with an explicit rule-violation flag is allowed.
- **Prompt — terse option reports.** Lead with 2–3 concrete best bets, one line each. Don't walk through every day. Don't re-summarize reasoning. When nothing fits, ONE honest line: "Nothing clean next week — Tuesday 11:00 is the closest but it would leave you under 2h of focus time. Want me to book it anyway?" No enumeration of rejected slots.
- **Prompt — name the actual rule when explaining a rejection.** Not "gaps too short." The real rules: "would leave under 2h of focus time" / "the only gap is inside your lunch window" / "it's a day off for you" / "nothing fits inside office hours (10:30–19:00)." If the reason isn't knowable, say "find_available_slots didn't find anything" — don't invent.
- **Schedule prompt block updated** to say the buffer is baked into durations, not an extra gap before new meetings. Connecting a new meeting right after an old one is preferred; 15-min delay is an alternative, not the default.

### Added
- **Code-level date verifier (`src/utils/dateVerifier.ts`)** — builds the same 14-day weekday/date lookup the system prompt uses, then scans the draft reply for "Weekday N Mon" patterns (English + Hebrew). When a pair mismatches the lookup (e.g. "Sunday 20 Apr" when Sunday is 19 Apr), runs a single corrective orchestrator retry with a nudge listing the wrong pairs and the correct weekday for each date. Fails OPEN on any parse or retry error. Runs for BOTH owner and colleague paths — wrong dates break trust the same way regardless of recipient.
- **Retry step in `postReply.ts`** between claim-checker and security gate: invokes `verifyDates` + `buildDateCorrectionNudge`; at most one retry, retry's output is not re-verified to avoid loops.

### Migration
- No schema changes.
- The buffer change means slots right after a previous meeting (connected, zero-gap) are now returned by `find_available_slots`. Callers that relied on the 5-min padding will see tighter slot proposals — this is intentional per owner preference.

---

## 1.6.5 — Recovery pass for empty replies, human phrasing for meeting mode

Two follow-ups from the v1.6.4 QA pass.

### Changed
- **Empty orchestrator reply → recovery pass instead of silence.** v1.6.4 returned nothing when the model ran tools but produced no text. That was honest but jarring. v1.6.5 runs ONE additional Claude call with a tight system prompt: "you just handled a turn but produced no text — describe what you did in one short sentence in the user's language, no tools, no markdown, write `NO_REPLY` if you really can't summarize." The recovery is grounded in the actual conversation history (the model has every tool call + result in front of it), so it can't fabricate, and the claim-checker still runs over the recovered reply in postReply.ts. Only if the recovery also returns empty (or `NO_REPLY`) do we silence and log — that case should now be very rare.
- **Meeting-mode question is human, not robotic.** The find_available_slots tool description used to tell the LLM "ask the owner which of in_person | online | either | custom." That was the source of "Hmm, please tell me which meeting_mode you want" outputs — robot phrasing. New rule: ask TWO real questions ("In person or online?" and, if it's in-person somewhere external, "Where?" + "Roughly how long is the trip each way?"). The LLM picks the meeting_mode VALUE itself based on the answer:
  - online / Teams / Zoom / video → `online`
  - in person at the owner's office → `in_person`
  - in person at a client / offsite / external link to join → `custom` + `travel_buffer_minutes` from the trip-time answer
  - "whatever works" / "doesn't matter" → `either`
  Same applies in both `meetings.ts` and `_meetingsOps.ts` tool definitions.

### Migration
- No schema, no profile changes.

---

## 1.6.4 — Calendar-review and slot-finding hardening from QA round

Wave of fixes from the first end-to-end QA pass on the calendar review + booking flows. The pattern across most of these: the analyzer / slot finder was structurally correct, but the LLM was free to narrate over the structured result, propose times the schedule rules forbid, or fabricate confirmations after silent or destructive failures. This round closes those gaps with a mix of code guards (where determinism matters) and prompt rules (where context matters).

### Added
- **`meeting_mode` parameter on `find_available_slots`** — required, enum `'in_person' | 'online' | 'either' | 'custom'`. The LLM must know the mode before calling; otherwise it asks the owner. `in_person` restricts the search to office days only (hard constraint). `custom` (external venue, client site, external meeting link) accepts a `travel_buffer_minutes` that pads slots on both sides so a 1h-drive meeting doesn't crash into adjacent events. Coord internal callers (`coordinate_meeting`, renegotiation, outreach prep) all pass `'either'` since their location is auto-determined per slot later.
- **Auto-expanding search window in `findAvailableSlots`** — when fewer than 3 candidates surface in the requested window, the function extends `searchTo` by +7 days and retries, capped at 21 days total from `searchFrom`. Stops early once 3 distinct-day slots are found. Internal coord callers opt out (`autoExpand: false`) since they have their own expansion loop.
- **Day-type tag on returned slots** — `findAvailableSlots` results now include `day_type: 'office' | 'home' | 'other'` so callers can narrate "Monday in your office or Tuesday from home online" without re-deriving from day names.
- **Delete-meeting idempotency guard in the orchestrator** — `delete_meeting` calls track executed `event_id`s per turn. A second call with the same id short-circuits to `{ ok: false, reason: 'already_deleted_this_turn' }`. The LLM sees the signal and corrects its narration. This is the code-level backstop behind the new confirm-before-delete prompt rule; the QA round caught a case where Maelle deleted one meeting but claimed to have deleted two.
- **Schedule block injected into the Meetings system prompt section** — office hours, home hours, lunch window, buffer, allowed durations, physical-meetings-require-office-day, free-time-per-office-day. Before this, the LLM only saw the day-name lists and inferred everything else from tool descriptions; it could honestly say "I don't see a rule about office meetings before 10:30" because the rule was enforced silently in code. Now the rule is in the prompt and the LLM treats it as a hard constraint.
- **`book_lunch` returns `{ ok, created, already_existed, ... }`** — when an existing event in the lunch window matches `/lunch/i` or category `Lunch`, the tool returns `created: false, already_existed: true` instead of silently double-booking. Lets the LLM narrate "lunch is already on your calendar" honestly when it's pre-existing, vs "booked you lunch" when it actually created it.

### Changed
- **Empty orchestrator reply → silence (was "Done.")** — `runOrchestrator` no longer fabricates fallback text when the model produces no final reply. The old "Done." / "Got it" / "I checked your calendar" placeholders looked human but had no grounding in what actually happened — when the owner saw "Done." with no context, the human-EA illusion broke. `postReply.ts` now skips the send entirely on empty reply and logs WARN with the tool summary. The owner sees nothing — clearer signal that something went wrong than a fake confirmation.
- **Meetings skill prompt rules added** for: out-of-window proposals (must flag the violation explicitly and ask before calling create_meeting / book_lunch / finalize_coord_meeting), delete-meeting protocol (look up first, confirm with subject + time, handle multiple-delete requests one at a time, never narrate a delete that didn't return success), non-working days (silence is the default — never narrate personal events on a day off, never use "day off, you have a personal block in the evening" framing).
- **Calendar-health skill prompt rule** — TRUST THE ANALYZER. If `analyze_calendar` / `check_calendar_health` returns no issue for a day, do not invent one (don't say "lunch is effectively blocked" because the gap looked tight, don't claim back-to-back when the analyzer respected the buffer). The analyzer already considers buffer, lunch window, work hours, free-time threshold; if it didn't flag it, it isn't an issue.

### Migration
- No schema, no profile changes. `meeting_mode` is required on the LLM-facing tool — old conversation-history references won't replay since each turn calls fresh.
- The "Done."-style fallback removal means a model that previously stalled silently will now show NO reply at all in Slack. If you see threads where Maelle stops mid-conversation, check WARN logs for "Orchestrator ended without final reply".

### Not changed (still deferred)
- Agent-vs-transport split (coord state machine → skills/meetings/, formal `Connection` interface) is still the next architectural round. Not in this version.

---

## 1.6.3 — File-size split: runner dispatchers, reply pipeline, coord helpers

Size-only cleanup before first public release. No behavior change — the same code runs in the same order. Files that were too large to navigate get broken along natural seams.

### Changed
- **Task runner split.** `src/tasks/runner.ts` went from 708 lines (one giant switch) to 68 (thin loop that looks up the right dispatcher). Each TaskType now has its own file in `src/tasks/dispatchers/`: `reminder.ts`, `followUp.ts`, `research.ts`, `routine.ts`, `outreachSend.ts`, `outreachExpiry.ts`, `coordNudge.ts`, `coordAbandon.ts`, `approvalExpiry.ts`, `calendarFix.ts`, plus a shared `types.ts` and an `index.ts` registry. Adding a new task type is now "add a dispatcher file and register it in `dispatchers/index.ts`" — no churn in the runner.
- **Reply pipeline extracted.** `src/connectors/slack/postReply.ts` (new) owns everything between "orchestrator returned a draft" and "message landed in Slack": normalize markdown, owner claim-check (+ forced-retry), colleague security gate, audio-vs-text send, optional approval footer. `app.ts` shrank from 1188 to 1063 lines and the reply-path mechanics are no longer buried inside the Bolt handler closures.
- **coord.ts size-only split.** From 1837 lines to 1244, pulling out three self-contained clusters:
  - `coord/utils.ts` — `determineSlotLocation`, `interpretReplyWithAI`, `isCoordReplyByContext`.
  - `coord/approval.ts` — `emitWaitingOwnerApproval` (extracted because both the state machine and the booking path call it; having it in its own file avoids a circular dep when booking moved out).
  - `coord/booking.ts` — `bookCoordination` + `forceBookCoordinationByOwner`.
  - `coord.ts` keeps the state-machine (initiate / handle-reply / resolve / ping-pong / renegotiation) and re-exports the extracted symbols so existing call sites continue to work unchanged.
- **Repo hygiene.** `scripts/` gets a `.gitignore` rule for one-off operational scripts (`backfill-*.cjs`, `cancel-*.cjs`, `inspect-*.cjs`, `expire-*.cjs`, and a `scripts/local/` folder) so workplace names and hardcoded Slack IDs never reach a public repo. The generic `purge-orphan-approvals.cjs` stays committed.

### Removed
- `test-calendar.js` (root) — single-use diagnostic that hardcoded a real email. Move anything similar into `scripts/local/` in future.

### Not changed (deferred — next round)
- The deeper **agent-vs-transport split** is not in this version. coord.ts still contains meetings-domain state-machine logic that DMs via Slack directly. The 1.7 target is a formal `Connection` interface so the meetings skill can run on Slack, email, or WhatsApp without editing the state machine. That change deserves its own proposal + approval round — it's not "make the file smaller," it's "move the agent out of the transport layer."

### Migration
- No schema, no profile, no API changes. Restart is enough.

---

## 1.6.2 — Honesty gate rewritten, approvals invariant centralized, internal plumbing stops leaking to users

A wave of fixes triggered by the first round of real owner+colleague usage after 1.6. Several distinct failures — Maelle claiming to message Idan without actually calling the tool, the reply verifier leaking its own reasoning as a reply, the security gate dumping its logs into the live Slack thread, the "heads up — this was pending your confirmation" reminder firing 24h after a meeting was already booked, the approval-reference token visible in every owner DM, Maelle forgetting facts Idan had taught her about herself — all land together because they share a single theme: the line between Maelle-the-person and the plumbing underneath was too thin. 1.7 redraws it.

### Added
- **Claim-checker (`src/utils/claimChecker.ts`)** — narrow Sonnet-backed truthfulness pass over owner-facing drafts. Strict JSON output, one question: "does the draft claim an action this turn that isn't backed by a tool call?" Never rewrites a reply itself; its caller decides what to do. Fails open on any parse / API error. Replaces the old reply verifier, which was asked to do two jobs at once (detect AND rewrite) and sometimes returned its own analysis prose as the "rewrite" — that prose then leaked verbatim into the owner's Slack thread.
- **Claim-checker retry path in `runOrchestrator`** — when the checker flags a false claim, app.ts re-invokes the orchestrator once with a corrective nudge appended to the user message. For false "I messaged X" claims specifically, the retry sets Anthropic `tool_choice: { type: 'tool', name: 'message_colleague' }` so the model must actually call the tool. `OrchestratorInput` gains two optional fields: `forceToolOnFirstTurn` and `extraInstruction`, both one-shot.
- **Assistant self-memory (`src/core/assistantSelf.ts`)** — Maelle is now a row in `people_memory` like every other colleague, keyed on a synthetic `SELF:<ownerSlackId>`. Seeded at startup per-profile. The existing `note_about_person` / `update_person_profile` tools work on her unchanged. A new "ABOUT YOU" block in the system prompt renders her notes in first person and ships in both owner and colleague prompts — her identity is not private, so when a colleague asks "why Maelle?" she can answer from what Idan has told her instead of deflecting. Only the owner sees the mutation hint (her slack_id, for the LLM to pass to note_about_person).
- **`scripts/purge-orphan-approvals.cjs`** — one-shot destructive cleanup. Cancels every pending approval, every open approval-expiry / coord-nudge / coord-abandon / outreach-expiry / calendar-fix follow-up task, and every non-terminal coord_job. Previews before committing, commits in a transaction. Use when the table drifts from reality.

### Changed
- **Coord-terminal → approval sync is now a single invariant inside `updateCoordJob`** (`src/db/jobs.ts`). Whenever a coord transitions to `booked`, `cancelled`, or `abandoned`, every pending approval attached to that coord is auto-resolved (booked→approved, others→superseded) AND the associated `approval_expiry` task is cancelled, all in the same call. Before 1.7 this was a per-call-site mirroring pattern that `bookCoordination` had simply forgotten to replicate — producing the "heads up, pending your confirmation?" reminders firing 24h after the meeting was already on the calendar. The redundant sync block at the finalize_coord_meeting success path is removed (now redundant with the invariant).
- **Approval-reference token no longer rendered to users.** The three sites that appended `_ref: #appr_<id>_` (italic) to DMs (`tasks/skill.ts`, `connectors/slack/coord.ts`, `core/approvals/orphanBackfill.ts`) no longer do. The orchestrator binds owner replies to approvals via the PENDING APPROVALS block in the system prompt — subject, timing, thread — which was already sufficient. The token remains as an optional explicit reference the model MAY use internally but is never shown.
- **Language rule rewritten.** Removed the static `user.language` anchor that pinned Maelle toward a YAML default and let her drift between Hebrew and English mid-conversation. New rule is absolute and per-message: "reply in the exact language the person wrote in THIS turn — no inertia, no profile default, voice transcripts included."
- **Persona block ("never fabricate personal history")** now points at the ABOUT YOU block as the source of truth for Maelle's own story, instead of forcing a deflection every time.
- **Security-gate filter events** go to WARN logs only. Before 1.7 every trigger dumped "Triggers: ... / Original: ... / Sent: ..." into the owner's active Slack thread as a visible message, making the DM unreadable during attacker activity (Ysrael's morning injection runs filled the screen) and breaking the human-EA illusion for routine turns. Full detail is preserved in the daily-rotate log for audit.
- **`formatPeopleMemoryForPrompt`** excludes `SELF:*` rows so Maelle doesn't appear as one of the owner's workspace contacts (her row is rendered by the dedicated ABOUT YOU block).

### Removed
- **`src/utils/replyVerifier.ts`.** Replaced by the narrower claim-checker above.

### Migration
- No schema changes.
- No profile changes (no new required YAML fields; `user.language` remains readable but is no longer used for language pinning — can be left in without effect).
- Run `node scripts/purge-orphan-approvals.cjs` once to clean the approvals/tasks/coord_jobs drift that accumulated through 1.6.x. The script previews what it will touch before committing; safe to abort.
- Restart to seed Maelle's `people_memory` row for every profile.

### Not changed (deferred)
- Still no formal Connection interface; `connectors/slack/coord.ts` still hosts meetings-domain state-machine logic. Target for a later pass.
- Free/busy / `findAvailableSlots` recurring-meeting-visibility bug (seen Apr 15 proposing 09:30 / 10:00 slots that overlapped a 09:15–10:15 recurring) is logged but not yet investigated.

---

## 1.6.1 — Layering cleanup: outreach extracted as core, scheduling helper moved out of skills/

Supporting cleanup so the four-layer model (Core / Skills / Connections / Tools & Utilities) holds at the file level as well as conceptually.

### Changed
- **`src/core/outreach.ts` (new, core module).** `message_colleague` and `find_slack_channel` extracted from `src/core/assistant.ts` into a dedicated `OutreachCoreSkill`. Memory concerns (preferences, people, interactions, gender) stay in `AssistantSkill`; messaging concerns move here. Registered in `CORE_MODULES` alongside assistant / tasks / crons. `CoreModuleId` type gains `'outreach'`.
- **`src/skills/scheduling.ts` → `src/skills/_meetingsOps.ts`.** The file still hosts direct calendar-op handlers that MeetingsSkill delegates to, but it was never a togglable skill — the leading underscore signals "internal helper, not loadable." Its `SchedulingSkill` class no longer `implements Skill` (doesn't need to; MeetingsSkill only calls `executeToolCall`). Dead `getSystemPromptSection` method removed; `getTools` kept for now with a TODO marker.
- **Assistant skill description tightened** to reflect its memory-only scope.

### Not changed (deferred to later)
- Coord state machine (`connectors/slack/coord.ts`) still contains meetings-domain logic mixed with Slack I/O — to be extracted into a meetings submodule when we define a proper Connection interface.
- No `Connection` interface or registry yet — today connectors are hand-wired per surface (Slack / Graph). Required if a profile ever runs on email-only without Slack.

### Migration
- No schema changes.
- No profile changes.

---

## 1.6.0 — Skills boundaries rationalized; one unified task pipeline; sweeps retired

Before 1.6, "where does one skill start and the other end" had no clear answer. Scheduling and Coordination had duplicate tools (`coordinate_meeting`, `find_slack_user`), separate YAML toggles, and overlapping system-prompt sections. Five parallel background sweeps (outreach scheduled send, outreach expiry, coord 3h stale nudge, coord 24h follow-up/abandon, approval expiry) each scanned their own table with their own logic, each with their own failure modes. And some subsystems (outreach send, calendar health) weren't backed by tasks at all — they ran as side effects on their own timers. 1.6.0 fixes all three at once.

### Merged
- **`scheduling` + `coordination` → `meetings`.** One skill, one YAML toggle, one system-prompt section. `src/skills/meetings.ts` owns every tool that touches the calendar — direct ops (create/move/update/delete/free-busy/find-slots/analyze) AND multi-party coord (coordinate_meeting, finalize_coord_meeting, check_join_availability, cancel_coordination, get_active_coordinations). The former SchedulingSkill is kept as a private helper (`_LegacyOpsSkill`) that MeetingsSkill delegates to for direct-ops handlers — its tool definitions are no longer exposed. Profile YAMLs with `scheduling: true` or `coordination: true` are auto-migrated to `meetings: true` at load time.
- **Core module set reduced.** `CoordinationSkill` is no longer hardcoded in `CORE_MODULES` — it was never toggleable, now `MeetingsSkill` is. Core remains: memory (AssistantSkill), tasks (TasksSkill), routines (CronsSkill).
- **Structured requests moved into TasksSkill.** `store_request`, `get_pending_requests`, `resolve_request`, `escalate_to_user` are now TasksSkill tools, not scheduling concerns. They sit next to `create_approval` / `resolve_approval`, which is where "decisions and requests" belong.

### Unified — one background pipeline, no more sweeps
Every former sweep is now a task of a specific type with a `due_at`. The 5-minute background loop does exactly two things: `materializeRoutineTasks` then `runDueTasks`.

| Former sweep | New task type | Dispatcher behavior |
|---|---|---|
| `sendScheduledOutreach` | `outreach_send` | Post the DM, flip outreach_jobs to 'sent', auto-queue an `outreach_expiry` if await_reply |
| `checkExpiredCoordinations` (outreach leg) | `outreach_expiry` | First expiry: send one follow-up, re-queue +3 work-hours. Second expiry: mark no_response, notify owner |
| `runCoordFollowUps` (24h nudge) | `coord_nudge` | DM non-responders, queue `coord_abandon` +4h |
| `runCoordFollowUps` (abandon) | `coord_abandon` | If still stuck, mark coord abandoned + notify |
| `runApprovalExpirySweep` | `approval_expiry` | Expire approval, cascade task→cancelled + coord→abandoned + notify owner/requester |
| *(new)* | `calendar_fix` | When owner marks an issue 'to_resolve', re-check in 1 day; auto-resolve if gone, re-ping if still there |
| *(unchanged)* | `routine` | Routine firing materialized by `materializeRoutineTasks` |

Task creation is wired at the source: `message_colleague` inserts `outreach_send`/`outreach_expiry` tasks; `initiateCoordination` inserts `coord_nudge`; `createApproval` inserts `approval_expiry`; `update_calendar_issue` with status='to_resolve' inserts `calendar_fix`.

### Added
- **`tasks.skill_origin` column** — every task records which skill created it (`'meetings'`, `'calendar_health'`, `'outreach'`, `'tasks'`, `'memory'`, `'system'`). Useful for briefings, filters, debugging.
- **`UNIQUE (skill_ref, type)` semantics** — the new task types rely on per-(type,ref) uniqueness at the creator; since the runner completes or re-schedules its own follow-ups, double-creation is avoided without a DB-level constraint for now.
- **Strong logs at every task creation, dispatch, and lifecycle transition** with `skill_origin`, `skill_ref`, `due_at`, and preview fields.

### Deleted
- `src/skills/coordination.ts` — contents moved to `meetings.ts`.
- `src/skills/meeting-summary.ts` — stub, never referenced.
- `src/core/orchestrator/tools.ts` — the `maelleTools` export had zero importers; definitions were duplicated in skills.
- `src/connectors/slack/coordFollowUp.ts` — replaced by `coord_nudge`/`coord_abandon` task dispatchers.
- `src/core/approvals/sweeper.ts` — replaced by `approval_expiry` task dispatcher.
- `src/tasks/crons.runner.ts` — replaced by routineMaterializer (shipped 1.5.1, now the sole path).
- `coordination_jobs` table + all helpers (`createCoordinationJob`, `updateCoordinationJob`, `getCoordinationJob`, `getJobByColleagueChannel`, `getJobsAwaitingResponse`, `getScheduledCoordinationJobs`, `getActiveJobsForOwner`, the `CoordinationJob` interface). Legacy single-colleague coord superseded by `coord_jobs`.
- From `coordinator.ts`: `sendCoordinationDM`, `handleCoordinationReply`, `confirmAndBook`, `handleDecline`, `checkExpiredCoordinations`, `sendScheduledOutreach`, `isWithinWorkingHours`, `getClosingLine`. The file is now 550 lines (from 1308) and contains only the outreach reply handler + Slack utilities.

### Migration
- `ALTER TABLE tasks ADD COLUMN skill_origin TEXT`
- `DROP TABLE IF EXISTS coordination_jobs`
- Profile YAML: `scheduling`/`coordination` → `meetings` auto-migration at load time (in `registry.getActiveSkills`). No edits required for existing profiles.
- `TaskType` gains: `outreach_send`, `outreach_expiry`, `coord_nudge`, `coord_abandon`, `approval_expiry`, `calendar_fix`. `TaskStatus` unchanged.

### Not changed (intentionally)
- `coord_jobs` state machine in `coord.ts` — still the source of truth for multi-participant coordination state. Tasks are the scheduling + visibility layer on top.
- `handleOutreachReply` — still runs on the Slack event path (not on a timer), since it's triggered by a real colleague message arriving.
- Approvals resolver and orphan backfill from 1.5.0/1.5.1 — unchanged, just plumbed differently at their expiry end.

---

## 1.5.1 — Routines as a thin layer over tasks; kill "offline mode"; approved-issue suppression; orphan approval backfill

The night the bot woke at 03:04 and DM'd about the 07:30 health check (scheduled four hours later in Idan's local evening) made it clear the old routine scheduler had two disagreeing clocks: `next_run_at` on the routine row and a wall-clock "90-min from scheduled" guard. Every bot restart / offline stretch that spanned a scheduled firing produced one of: phantom "I was offline" DMs at the wrong hour, silent drops, or runs +hours late. 1.5.1 collapses this into a single model where routines are a thin layer over tasks.

### Changed
- **Routines → tasks (materializer pattern).** New `src/tasks/routineMaterializer.ts`. On the 5-min tick: for every active routine with `next_run_at <= now`, insert one `type='routine'` task with `due_at` = scheduled instant, then fast-forward `next_run_at` past stale occurrences to the next future firing. UNIQUE index `(routine_id, due_at)` prevents double-insert. Task runner does the actual work — the 90-min-circular-distance offline guard and the "I was offline at X, run now or skip?" DM are both gone.
- **Cadence-based lateness policy.** `src/tasks/lateness.ts`. When the runner picks up a routine task, it compares lateness to a threshold derived from the routine cadence:
  - Sub-daily (multiple firings per day): skip if > 5 min late
  - Daily: run if ≤ 4h late, else skip (`status='stale'`)
  - Every 2–6 days: 24h threshold
  - Weekly (7–29 days): 48h
  - Monthly (30+ days): 1 week
  Skipping is silent — no DM, no "should I run it?" question. Stale tasks are marked for the briefing.
- **`never_stale` flag on routines** (`routines.never_stale` INTEGER 0/1). When set, all thresholds are ignored — the routine always runs at the next opportunity no matter how late. Exposed on `create_routine` and `update_routine` tools.
- **Catch-up of missed colleague messages** (`catchUpMissedMessages` in `core/background.ts`): scope narrowed from (DM + MPIMs, 48h, @mention-gated for MPIMs) to **DM only, 24h, last unread user message only, reply in thread**. The "[Context: you were offline when this message was sent…]" prompt-injection hack that prefixed every catch-up message is gone — the orchestrator sees the raw message; the catch-up framing lives only in the posted reply's context block.
- **`checkMissedBriefing` on startup is gone.** Not needed: if today's briefing slot passed while the bot was down, the routine's `next_run_at` is already in the past, the materializer will insert a task on first tick, and the lateness policy will run-or-skip it based on how late it is. One code path for both "on time" and "just missed it".

### Fixed
- **Approved calendar issues no longer re-flagged every morning.** `skills/calendarHealth.ts` now pipes the detected `issues` array through `getDismissedIssueKeys` + `buildIssueKey` before returning. Previously `upsertCalendarIssue` skipped the DB insert for approved issues but the in-memory `issues` list kept them in the daily report, so the owner got re-asked about the same conflict every day no matter how many times they said "it's fine."
- **Orphan approval backfill on startup** (`src/core/approvals/orphanBackfill.ts`). Runs once, ~30s after boot. Finds `coord_jobs` sitting in `waiting_owner` from the last 14 days that have no linked pending approval (pre-v1.5 orphans, approvals lost to earlier bugs). Reconstructs the ask from coord metadata — slot_pick if there's a winning_slot, duration_override if notes flag `needsDurationApproval`, freeform otherwise — creates the approval, DMs the owner, records the message ts. Opaque coords (no subject, no slot, no notes) are left alone. This recovers things like "Yael asked for a 30-min extension, Maelle said 'passed to Idan', Idan never saw it."
- **Remaining Haiku call sites flipped to Sonnet.** `genderDetect.ts` was the last holdout. `claude-haiku` no longer appears anywhere under `src/`. One strong model end-to-end is worth more in behavior consistency than it costs in inference.

### Migration
- `ALTER TABLE routines ADD COLUMN never_stale INTEGER NOT NULL DEFAULT 0`
- `CREATE UNIQUE INDEX idx_tasks_routine_due ON tasks(routine_id, due_at) WHERE routine_id IS NOT NULL`
- `TaskType` gains `'routine'`; `TaskStatus` gains `'stale'`. No data migration — old rows pass through unchanged.

### Removed
- `src/tasks/crons.runner.ts` is still on disk but `runDueRoutines` and `checkMissedBriefing` are no longer wired into the background loop. Will be deleted in 1.5.2 once we've confirmed 1.5.1 holds through a week of traffic.

---

## 1.5.0 — Approvals as first-class structured decisions

The fragile link in every scheduling flow was the moment we paused for the owner to decide. Before 1.5 that moment was a free-text DM + an LLM re-reading the thread next turn to figure out what to do — no binding between "what I asked" and "what Idan said", no expiry, no dedupe, no freshness re-check before booking, no structured notification back to the original requester. 1.5 replaces that with a typed `approvals` row that hangs off a parent task and flows through one canonical resolver.

No buttons — per design. Idan replies in natural language; Sonnet binds the reply to the right approval using the pending-approvals list injected into the system prompt plus an `#appr_<id>` token appended to every ask.

### Added
- **`approvals` table + `src/db/approvals.ts`.** Every owner decision is a row: `{id, task_id, kind, status, payload_json, decision_json, expires_at, idempotency_key, ...}`. Always attached to a parent task (task stays the root arch). Kinds: `slot_pick`, `duration_override`, `policy_exception`, `lunch_bump`, `unknown_person`, `calendar_conflict`, `freeform`. Statuses: `pending | approved | rejected | amended | expired | superseded | cancelled`.
- **`src/core/approvals/resolver.ts` — the one place decisions resolve.** Handles `verdict ∈ {approve, reject, amend}` for every kind. `amend` is first-class: when Idan says "no but 1:30 works", the approval closes as `amended` with the counter recorded and the orchestrator relays the alternative back to the requester. `slot_pick` runs a freshness re-check via `getFreeBusy` before booking — if the chosen slot went stale while waiting, it supersedes the approval and emits a `calendar_conflict` follow-up instead of booking into a now-conflicted slot.
- **`src/core/approvals/sweeper.ts` + 5-minute cron tick.** Expired approvals → flip status to `expired`, cancel the parent task, mark the linked coord `abandoned`, DM the owner, and DM any external requester so nobody sits in limbo. `waiting_owner` now has the same expiry machinery every other state already had.
- **Orchestrator tools: `create_approval`, `resolve_approval`, `list_pending_approvals`.** Registered in `TasksSkill`. `create_approval` DMs the owner with an appended `#appr_<id>` token so free-text replies can bind deterministically. Idempotent by `(task_id, kind, payload)`: creating the same approval twice returns the existing pending row.
- **Pending approvals injected into the owner system prompt.** When Idan replies, Sonnet reads the list, picks the matching approval_id (explicit `#appr_…` first, then subject/thread/recency), and calls `resolve_approval`. Ambiguous multiple-pending cases: Sonnet is told to ask which one, naming them by subject.
- **Requester loop closed structurally.** `coord_jobs.requesters` JSON column. On `booked` → DM any requester who isn't already a participant with a structured "all set" message. On expiry/abandonment → DM them too. No more "colleague who asked never heard back because Maelle forgot."
- **Booking idempotency.** `coord_jobs.external_event_id` set from `createMeeting`'s returned Graph id. `bookCoordination` short-circuits if the coord already has an `external_event_id` at the same slot — safe under ts-node-dev respawn, approval retries, and double-taps.

### Changed
- **`coord.ts` `waiting_owner` sites → `emitWaitingOwnerApproval` helper.** Every path that previously posted a raw owner DM and flipped the coord to `waiting_owner` now goes through the helper: creates a typed approval, posts the ask with a binding token, records the message ts. Covers the all-agree-with-holdouts path, the calendar-conflict path, the duration-override path, the createMeeting-failure path, the ping-pong dead-end, and the round-2 preference-conflict path. Falls through to a plain DM only when no parent task is linked (legacy coord rows).
- **`finalize_coord_meeting`** kept as a legacy tool but now auto-marks any linked pending approval as `approved` when it books successfully, so approval state stays consistent with coord state.
- **All remaining colleague-path Haiku calls → Sonnet.** `coord.ts` (3 sites), `coordinator.ts` (2 sites), `relevance.ts`, `addresseeGate.ts`. Only `genderDetect.ts` stays on Haiku — it's a narrow name-classifier, not a colleague-facing behavior path.

### Migration
- `CREATE TABLE approvals (…)` with `idx_approvals_owner_status`, `idx_approvals_task`, `idx_approvals_expires`, `idx_approvals_skill_ref`.
- `ALTER TABLE coord_jobs ADD COLUMN requesters TEXT NOT NULL DEFAULT '[]'`
- `ALTER TABLE coord_jobs ADD COLUMN external_event_id TEXT`
- `ALTER TABLE coord_jobs ADD COLUMN request_signature TEXT` + `idx_coord_jobs_req_sig`

### Not yet wired (deliberate v1.5 scope)
- `request_signature` column exists but merge-on-conflict for duplicate coord asks isn't turned on yet — add when we see a real duplicate in traffic.
- `unknown_person` and `lunch_bump` kinds are defined but the orchestrator has to drive them from the prompt (no dedicated booking-side helper yet).
- Non-scheduling approvals (preferences, calendar-health, etc.) are supported via `freeform` but not routed from those code paths — can be added without schema changes.

---

## 1.4.3 — Redesign candidate: LLM-driven output safety, Sonnet for conversation (on trial)

> Kept on a patch bump until validated in real traffic. If the verifier + Sonnet routing prove stable across a few days of use, this gets promoted to 1.5.0 retroactively in the summary. If it regresses, the changes roll back without a minor-version ceremony.

The v1.4 wave stabilized coordination by layering defensive patches on top of the LLM: regex backstops, Haiku judges, hardcoded fallback replies, tool-result guidance strings. Each patch had its own false-positive shape — the coord judge flagged our own `<<FROM…>>` wrapper as injection, the hallucination regex flagged "on your calendar" in analysis replies, the layer-1 refuse rejected salvageable coord calls, canned fallback rewrites turned analysis into fake failed bookings. 1.5.0 redesigns these layers to let the model do what a regex can't — reason about what happened.

### Redesigned
- **Hallucination backstop → `replyVerifier`** (`src/utils/replyVerifier.ts`). The old regex-and-canned-fallback in `app.ts` is gone. New path: when an owner-facing reply is non-trivial and no booking tool succeeded this turn, hand `{reply, toolSummaries, bookingOccurred}` to Sonnet and ask *"does this reply honestly reflect what happened? if not, rewrite it truthfully — same language, same tone, keep the useful analysis, fix only the false claims."* Sonnet either responds `OK` or supplies a corrected draft. Fails open on verifier error. Gated by `needsVerification()` (skips short replies and successful-booking turns) so cost stays bounded. Shadow-notify now audits rewrites with full before/after context instead of a single-line alert.
- **Colleague orchestrator: Haiku → Sonnet.** `MODEL_COLLEAGUE` in `orchestrator/index.ts` is now `claude-sonnet-4-6`. Haiku produced subtler failure modes on colleague turns (malformed coord args, missed RULE 3 triggers, over-sensitive to idioms). The stable-solution bias is "one strong model everywhere" over a cost/behavior gap between owner and colleague paths.
- **Coord judge: Haiku → Sonnet.** `coordGuard.judgeCoordRequest`. Haiku false-positived on natural multi-turn Hebrew conversations and on our own wrapper tags.
- **Security gate rewriter: Haiku → Sonnet.** `securityGate.filterColleagueReply`. Still only fires on narrow regex triggers (cost-bounded), but when it does rewrite, Sonnet produces less stilted output.

### Added
- **`confirm_gender` tool** + `confirmPersonGender()` DB helper + `gender_confirmed` column. When a person answers Maelle's gender question (or volunteers it), Maelle calls `confirm_gender` — this locks `gender_confirmed=1` and no auto-detector (pronouns, image, name-LLM) can ever overwrite it. Colleagues can only confirm their own gender; owner can confirm any. System-prompt Hebrew section rewritten to direct Maelle to the new tool and to suppress re-asking when gender is already set.
- **Hebrew/English name gender inference** — `detectGenderFromName()` in `genderDetect.ts` (still Haiku, narrow task). Runs as a third fallback after pronouns and image. Picks up names like Yael/Dana/Rachel → female, Idan/Moshe → male, returns `unknown` for genuinely ambiguous names (Noa, Alex, Yuval). Tentative guesses never override a confirmed value.
- **Owner auto-inclusion for colleague-initiated coord.** `skills/coordination.ts` and `connectors/slack/coord.ts`. Replaces the old two-layer owner-must-include refuse. If a colleague asks Maelle to coordinate and the owner isn't in `participants`, he's silently injected (name/slack_id/email/tz from profile). Removes a whole class of "Maelle built the args wrong → coord refused → Maelle tells colleague she'll check with owner → never stored → orphan promise" failures.

### Removed
- **`<<FROM …>>` colleague-message wrapper** in `app.ts`. We used it to tell the orchestrator who was speaking; it's redundant with `senderName` + the authorization line, and every wrapper shape we tried collided with either the injection scanner (`[From: X]`) or the coord judge (`<<FROM X>>` flagged as "suspicious paste mimicking system syntax"). Now the raw colleague text goes through untouched; identity flows via `senderName` only.
- **Layer-1 / Layer-2 owner-not-in-participants refuses** — replaced by auto-add above.
- **BOOKING_CLAIM_RX / BOOKING_CLAIM_HE_RX** and the hardcoded fallback string *"I tried to lock this in but the booking didn't actually go through…"* — replaced by the Sonnet verifier.

### Migration
- `ALTER TABLE people_memory ADD COLUMN gender_confirmed INTEGER NOT NULL DEFAULT 0` (auto-applied on startup).

---

## 1.4.1 — Synchronous booking, hallucination backstop, follow-up cron, subject-level cooldown

### New
- **Synchronous `finalize_coord_meeting` (D3)** — the owner force-book tool now runs inline inside the skill and returns `{ok, status, reason, subject, slot}` to the LLM. The LLM reads the real outcome before narrating, which closes the race where "done — booked" was spoken before the calendar actually committed. `bookCoordination` gained a `suppressOwnerConfirm` option so the synchronous path doesn't double-post.
- **Hallucination-reply backstop (D2)** — every outbound reply is scanned for booking-claim phrases (EN + HE: "booked", "invite sent", "calendar invite", "נקבעה", "הזמנתי"…). If the reply claims a booking but no `create_meeting` / `finalize_coord_meeting` succeeded this turn, the reply is rewritten to a safe fallback and a shadow-notify lands in the owner's DM with the original text. Narrow regex + the new `bookingOccurred` flag on `OrchestratorOutput`.
- **Coord follow-up / abandon cron (Bug 1B)** — `coordFollowUp.ts`. Every 5 minutes: coord jobs with no participant activity in 24 *work-hours* (respecting office_days ∪ home_days — Fri/Sat count as zero for Israelis) get a single follow-up DM to non-responders. If still no reply 4 wall-clock hours after the nudge, the coord is marked `cancelled` with `abandoned_at` set and the owner gets a closing note. New columns: `last_participant_activity_at`, `follow_up_sent_at`, `abandoned_at`.
- **Subject-level social cooldown (Bug 10)** — `SocialTopic` gained an optional free-form `subject` column alongside the enum `name`. Cooldown fires on `(topic + subject)` pairs, so "hobby:clair obscur game" can be on cooldown while "hobby:woodworking" is still available. `note_about_person` tool schema now has a required-in-practice `subject` field, and the system prompt tells the LLM to call `note_about_person` the moment it *initiates* a social question (not only when the person volunteers) — this is what arms the 24h gate.

### Changed
- **`handleCoordReply`** now writes `last_participant_activity_at = now` whenever a participant responds, feeding the follow-up cron.
- **`forceBookCoordinationByOwner`** return type widened to `{ok, reason, status, subject, slot}` and honors a new `synchronous` flag that suppresses the in-function owner confirm message (so the LLM can narrate).
- **SOCIAL CONTEXT prompt block** renders topic labels as `name:subject` and shows the INITIATION COOLDOWN list at subject granularity.
- **Workspace-contacts block** (`formatPeopleMemoryForPrompt`) now shows subjects under each topic for readability in the context.
- **RULE 2a** in the base honesty rules now specifies the synchronous return-shape of `finalize_coord_meeting` and tells the LLM not to re-narrate on `ok:false`.

### Fixed
- **Repeated personal check-ins** (e.g. "how's Clair Obscur / axons section?" three times in a day) — root cause was that `last_initiated_at` was never being written because the LLM only called `note_about_person` when the person volunteered, never when Maelle initiated. Fixed by subject-level cooldown + mandatory-on-initiate prompt rule.
- **Race where the LLM narrated success before booking ran** — eliminated by making `finalize_coord_meeting` synchronous; if the booking hit a calendar conflict or duration gate, the tool returns `ok:false` and the LLM can no longer paper over it.

---

## 1.4 — Group-DM / Catch-up / Owner-Override Stabilization

### New
- **Owner force-book tool (`finalize_coord_meeting`)** — code-level override: when the owner picks a slot during an in-progress coord, the coord is booked immediately regardless of pending participant responses. Backed by `forceBookCoordinationByOwner` in `coord.ts` which marks unresponded key participants as accepted at the chosen slot and invokes the real booking path (no more LLM-narrated fake confirmations). Owner-only (in `ownerOnlyTools`).
- **Hebrew output rules** — system-prompt block covering name transliteration, proper-noun meeting titles (no nonsense auto-translations like "מחסום דינאמיקה"), no markdown in Hebrew replies, and re-querying availability on date corrections.
- **`name_he` column on `people_memory`** — cached Hebrew rendering of contact names so Maelle uses the right form in Hebrew conversations. Exposed in `update_person_profile` tool.
- **Weekday labels on Today/Tomorrow** in the date lookup table (`Today (Tuesday): 2026-04-14`) so the LLM stops back-computing days-of-week.
- **Outreach reply classifier (Option B)** — Haiku-powered "reply vs new" context match; multi-job disambiguation when a colleague has more than one open outreach.
- **Daily log rotation** (`winston-daily-rotate-file`) — 7-day retention for `maelle.log`, 30 days for `error.log`. Verbosity kept at current level; only disk management changes.

### Changed
- **Catch-up reply always threaded under the user's original message** (`background.ts`), regardless of whether the missed message was top-level or in-thread — no more floating replies.
- **Catch-up reply normalized through `normalizeSlackText`** — `**bold**` → `*bold*`, stripped `##` and leading `- `, matching the live handler.
- **MPIM message detection** (`app.ts`) — modern Slack delivers group DMs as `channel_type: 'channel'` with C-prefixed IDs; verify `is_mpim` via `conversations.info` rather than rejecting on channel_type alone.
- **In-group participant message** — dropped "Idan asked me" phrasing, uses thread_ts for ack, removed bot-speak "Just reply with the number".
- **Slot ordering** — `pickSpreadSlots` now sorts chronologically before returning.
- **`handleCoordReply` follow-up branch** — when a participant who has already responded sends a follow-up on a `waiting_owner` coord, ack them and forward the content to the owner instead of re-running `resolveCoordination` (which could destructively flip a prior 'yes' to 'no').
- **"NEVER LIE ABOUT BOOKINGS" rule** added to coordination system prompt — explicit owner-override language so the LLM never narrates a confirmation without a real `create_meeting` / `finalize_coord_meeting` tool call.

### Fixed
- **Elinor "Yes, that works" dropped** — MPIM `message` handler was rejecting events with `channel_type !== 'mpim'`; now also handles `channel_type === 'channel'` with `is_mpim` verified via API.
- **Phantom booking narration** — fixed via both prompt rule and code-level `finalize_coord_meeting`; the LLM can no longer claim "huddle link in your calendar invite" without an actual booking call.
- **Yael's 3rd-message drop** — follow-up on `waiting_owner` jobs no longer routes through the destructive re-resolve path.
- **Catch-up markdown leak** (`**When?**`, `**Duration?**`) — catch-up path was bypassing `normalizeSlackText`.
- **Catch-up orphan reply** — catch-up was posting at top-level when the user's message was top-level; now always threads under the user's message.
- **`slotCountNote` dangling reference** in coordination.ts.

---

## 1.3 — Scheduling System Overhaul

### New
- **Calendar health skill** — `check_calendar_health` scans for missing lunch, double bookings, OOF conflicts, and uncategorized events; `book_lunch` books a lunch event in the preferred window; `set_event_category` updates Outlook categories on events
- **Ping-pong negotiation** — when participants pick different slots, Maelle tries converging on existing choices (soonest first) before falling back to open-ended renegotiation
- **Out-of-thread reply detection** — colleagues can reply to coordination DMs outside the original thread; Haiku-powered context matching determines if the message is scheduling-related and disambiguates multiple active jobs
- **Location auto-determination per slot** — each proposed slot gets location based on day type: office day (Idan's Office + Teams / Meeting Room + Teams), home day (Huddle / Teams only), with custom location override
- **Duration flexibility** — owner can request any meeting duration; colleague non-standard durations trigger an owner approval gate before booking
- **Calendar freshness optimization** — pre-booking calendar check skipped if last check was < 60 seconds ago
- **Thinking time protection** — days with less than 2h of quality free time (in chunks of >= 30 min) are automatically skipped when searching for slots
- **Lunch protection** — slots that would eliminate room for lunch in the preferred window are skipped
- **Urgent scheduling flag** — `is_urgent` flag stored in coordination notes for future relaxed-buffer handling
- **Phone call location** — `custom_location` set to just the phone number (e.g. `"+972-54-123-4567"`) so it's clickable in the calendar; no Teams link generated for phone meetings
- **Colleague test mode** — owner can say "test as colleague" in a DM thread to simulate the colleague experience (coordination DMs, slot picking, etc.); "stop testing" to exit
- **Join-meeting flow (Route 2)** — `check_join_availability` lets colleagues ask the owner to join an existing meeting; checks calendar for conflicts, offers partial join (first/last N minutes), escalates rule violations (lunch/buffer) to the owner; no calendar booking — colleague forwards the invite
- **Calendar issue tracking** — `get_calendar_issues` and `update_calendar_issue` tools; double bookings and OOF conflicts are auto-tracked in DB with workflow: `new` → owner decides → `approved` (ignore) or `to_resolve` (Maelle acts, then marks `resolved`); resolved/approved issues are never re-flagged

### Changed
- **Renamed `multi_coord` to `coord`** — DB table `multi_coord_jobs` → `coord_jobs`, all functions and types renamed (`MultiCoordJob` → `CoordJob`, `MultiCoordParticipant` → `CoordParticipant`), file `multiCoordinator.ts` → `coord.ts`; migration drops old table on startup
- **`findAvailableSlots` overhauled** — accepts `minBufferHours` and `profile` params; enforces per-day work hours (office vs home), 4h minimum buffer from now, 5-min gap around existing events, thinking time check, and lunch protection
- **`pickSpreadSlots` hardened** — at least 2 unique days required when returning 3 slots (hard constraint); caps at 2 if only 1 day available so the caller expands the search window
- **`coordinate_meeting` tool rewritten** — any duration accepted (not enum-constrained), date range defaults to now+4h forward expanding weekly up to 12 weeks, returns `SlotWithLocation[]` with per-slot location and online status
- **Coordination system prompt updated** — includes Route 1 (book meeting) vs Route 2 (join meeting) guidance, location rules, duration flexibility, negotiation flow, slot rules, and out-of-thread support
- **`check_join_availability` added to colleague tools** — colleagues can now trigger Route 2 directly
- **Scheduling system prompt updated** — documents min buffer, thinking time threshold, lunch protection rules
- **User profile schema** — added `thinking_time_min_chunk_minutes`, `min_slot_buffer_hours` to meetings; added `calendar_health` to skills
- **`coord_jobs` table** — added `negotiating` status and `last_calendar_check` column
- **Shadow notify on booking** — booking confirmation now sends a shadow message to the owner in addition to the thread notification
- **Outreach handoff** — now passes `minBufferHours` and `profile` to slot search, builds `SlotWithLocation[]` with proper location per slot
- **All `findAvailableSlots` callers updated** — scheduling skill, coordination skill, and outreach handoff all pass new slot-rule params

### Fixed
- Missing shadow notification on final meeting booking in coordination flow
- `app.ts` casting `proposedSlots` as `string[]` instead of `SlotWithLocation[]`
- Outreach handoff passing obsolete `isOnline` param to `initiateCoordination`
- **Late-night date shift** — before 5am, the date lookup table now reflects the user's subjective day (e.g. at 1am Tuesday, "today" = Monday, "tomorrow" = Tuesday); fixes "tomorrow" being off by one after midnight
- **`analyze_calendar` missing lunch events** — lunch check now recognizes existing "Lunch" calendar events instead of only looking for free gaps; previously reported "no lunch" even when lunch was already booked
- **Calendar health late-night range** — `check_calendar_health` default date range uses the same before-5am adjustment so it covers the correct week

---

## 1.0 — First production release

### New
- Channel posting — Maelle can post in any Slack channel with an @mention; auto-joins public channels if not already a member; returns a clear error if the channel is private and she hasn't been invited
- Company context — `company_brief` field in the YAML profile; a short plain-text paragraph injected into the system prompt so Maelle understands the business she works in; each user writes their own, kept deliberately short to avoid inflating the prompt

### Changed
- Voice response simplified — no persistent "car mode" state; voice input returns audio when the reply is ≤75 words; text input always returns text; the preference has been removed from the database entirely
- Company context is inline YAML, not a separate file — keeps the system prompt lean and the configuration self-contained

### Fixed
- learn_preference crash when value was null — returns a graceful error instead of throwing a SQLite NOT NULL constraint
- WhatsApp connector had a stale isCarMode reference left over from the car mode removal

---

## 0.9

### New
- Social engagement — Maelle builds real relationships by asking personal questions, learning from answers, and remembering over time
- Person model — each contact gets a rich profile: engagement style, communication habits, working hours, role, and who they work with
- Interaction memory — every meeting booked, message sent, and conversation is logged per person so Maelle never forgets what happened
- Offline catch-up — on startup, Maelle finds and responds to any messages sent while she was offline (48h window)
- Two-tier meeting invites — key attendees are coordinated (DM + calendar check), additional attendees added directly to the invite without coordination
- First contact introduction — first time Maelle DMs a colleague she introduces herself and explains her role
- Shadow mode — v1 QA safety net; every autonomous action posts a compact receipt in the owner's thread
- update_meeting tool — Maelle can set or fix Outlook categories on existing events without rescheduling
- Colleague guardrails — memory, calendar changes, and personal data about others are protected at both prompt and code level; default rule is don't share when in doubt

### Changed
- Architecture refactor — split the codebase into four clear layers: Core, Skills, Connectors, Background
- File structure — simplified project layout and split the database layer into focused modules
- Calendar categories — now fetched from Graph API and available for internal logic
- senderRole flows into SkillContext so tool handlers enforce owner-vs-colleague permissions in code

### Fixed
- Duplicate log spam on every tool execution
- Catch-up double-fire — catchup now checks thread replies before deciding a message was unanswered
- Catch-up responses show which message they are replying to
- Calendar categories not fetched — categories field was missing from Graph API select query
- Meeting category updates silently failing — Graph PATCH did not include categories field
- Week boundary bug — "next Sunday" showed wrong date for Israeli work week; now derived from profile
- Timezone/week start now profile-driven (Sunday-first for IL, Monday-first for EU)

---

## 0.8

### New
- General knowledge skill — conversational Q&A for weather, news, exchange rates, and current events using web search
- Web search — Tavily as primary provider (free tier, no credit card), DuckDuckGo as fallback
- Metric units — user profile `units` field; general knowledge skill defaults to °C, km, kg
- Startup briefing dedup — checks DB before calling `sendMorningBriefing` to prevent double send on restart
- Multi-tenancy audit — all hardcoded personal data moved to YAML; `company`, `units`, and `room_email` added to profile schema

### Changed
- Read receipts — `:thread:` emoji on new messages, `:eyes:` on thread replies; never removed
- Audio response logic — text input always returns text; voice input returns audio if ≤75 words; car mode always returns audio
- Startup notification — 60-second delay added to prevent spam on rapid restarts
- Briefing prompt — 350-word limit, explicit perspective rules, completeness rule
- Model names — owner uses `claude-sonnet-4-6`, colleague/briefing/coordination uses `claude-haiku-4-5-20251001`
- Assistant name — single-name AI agents now supported (`AssistantNameSchema`); Maelle no longer requires a last name
- Logger — compact single-line JSON format
- Skills active log — consolidated from 4 separate lines into one
- General knowledge — removed weather-specific logic; all topics handled uniformly like ChatGPT
- Scheduling prompt — location rules and room booking email now derived from profile, not hardcoded

### Fixed
- Whisper 400 errors — Slack records AAC-ELD codec inside M4A container; fixed by converting to WAV via ffmpeg before upload
- Double Slack event processing — removed duplicate `file_shared` handler that was firing alongside `file_share`
- Text input getting audio response — `car_mode` persisting from a previous voice session; fixed by checking `inputWasVoice` first
- Wrong model names — two rounds of 404 errors from deprecated model IDs
- "Your message" pronoun bug in briefing — Haiku was saying "checking if he responded to your message"
- Double briefing log on startup — startup was calling `sendMorningBriefing` which had its own dedup, producing two log lines
- Reflectiz and Idan hardcoded in system prompt — replaced with profile-derived values throughout

---

## 0.7

### New
- TTS voice persona — `gpt-4o-mini-tts` with `sage` voice, speed and tone tuned for a young, calm assistant
- Voice transcription pipeline — fetch download with redirect following, form-data multipart POST to Whisper

### Changed
- Briefing rewrite — new system prompt, pronoun rules, word limit
- Persona update — Maelle described as a young woman in her early twenties; last name removed
- Hourglass and sound emoji removed — replaced in 0.8 with permanent read-receipt emoji

### Fixed
- Voice file format detection — extension now mapped from MIME type, not assumed
- Whisper multipart encoding — switched from native `FormData`+`Blob` to `form-data` npm package to fix malformed requests
- Redirect not followed on Slack file download — switched from `https.get` to `fetch`

---

## 0.6

### New
- Prompt caching — system prompt split into static (skills, cacheable) and dynamic (date, prefs, sender) parts
- Skills prompt sections — each skill contributes its own section to the system prompt via `getSystemPromptSection()`
- COLLEAGUE_ALLOWED_TOOLS — hard-coded allowlist gates which tools are visible to non-owners
- Night shift detection — system prompt explains how to find the weekly night shift from the calendar

### Changed
- Orchestrator refactored — model routing (Sonnet for owner, Haiku for colleagues), token limits, tool loop capped at 10 turns
- System prompt restructured — examples-first communication rules, honesty rules, thread continuity rule, ownership rule
- Scheduling skill — location rules, interview rules, cancellation rules, `analyze_calendar` tool added

### Fixed
- Calendar times off by one hour — events returned in user timezone via Graph `Prefer` header; display logic no longer converts
- Coordination escalation not firing — background timer was checking wrong status field
- Pending requests accumulating system tasks — `store_request` rules tightened; cleanup logic added

---

## 0.5

### New
- WhatsApp connector — personal WhatsApp account via whatsapp-web.js with QR scan auth and session persistence
- Voice input — audio messages in Slack transcribed via Whisper
- Voice output — TTS response when input was voice and reply is substantive
- Car mode — say "I'm driving" to switch to audio-only responses, persisted across sessions
- Multi-person coordination — coordinate meetings with 2–4 attendees; DMs each person separately with 3 slot options
- Free/busy check — coordinator checks internal colleagues' calendars before proposing slots
- Security guardrails — rate limit on pending requests per colleague; meeting details scrubbed for non-owners; legitimacy check on incoming requests
- Recall interactions — search event history by person name across all threads

### Changed
- Colleague identity injected automatically — real name added to every colleague message so Claude always knows who is writing
- Briefing dedup — timezone-aware date marker prevents briefing from firing twice in the same day
- Briefing format — bold section headers, deduplication by actor, replied actors excluded from "still waiting" list
- Briefing greeting — morning / afternoon / evening based on actual local time
- Outreach replies forwarded to original thread so follow-up questions have full context
- Maelle removed from meeting attendees — she books, she does not attend
- No-response message sent once only, then task cancelled

### Fixed
- Audio messages in Slack not being received due to mismatched event type
- Coordination stuck when Slack user lookup failed mid-loop
- Multiple @mentions in a single message not all being resolved
- Slack-formatted email links passed raw to Claude instead of being cleaned
- Self-mention filter incorrectly blocking replies in DMs
- Briefing showing the same person as both "replied" and "waiting"

---

## 0.4

### New
- Task system — unified task tracking with flags for user-requested vs system tasks and briefed vs unseen
- Morning briefing — scheduled daily at configured time; catches up on startup if past scheduled time
- Events log — all colleague messages, coordination outcomes, outreach replies, and task completions logged
- On-demand briefing — `get_briefing` tool for an instant catch-up summary at any time
- Outreach expiry — jobs expire after 3 days with no reply; owner notified once, task closed

### Changed
- Task list filters out system/background tasks — only user-requested items shown
- Completed tasks appear in briefing once, then never again
- Task status uses natural language labels: "waiting for reply", "scheduled for Mon 14 Apr 09:00"

### Fixed
- Tasks and events tables missing from existing databases on upgrade
- Coordination timer crashing on startup due to missing table
- Hebrew text in logs showing as escaped unicode sequences

---

## 0.3

### New
- Persistent memory — learned preferences stored in SQLite and injected into every conversation
- `learn_preference` / `forget_preference` / `recall_preferences` tools
- Coordination skill — single-person meeting coordination: finds slots, DMs colleague, handles replies, escalates after 3 hours
- `message_colleague` tool — fire-and-forget or await-reply outreach with task tracking
- Multi-user support — one assistant per YAML profile, all running in the same process
- Audit log — immutable record of all actions taken
- Approval queue — destructive actions require owner confirmation before executing

### Changed
- System prompt rebuilt around examples rather than formatting rules
- Colleague access enforced in code — calendar details scrubbed from tool results for non-owners
- Slot finding respects office vs home day hours and YAML work schedule

### Fixed
- Coordination replies not routing to the right job
- Calendar times displaying in wrong timezone
- Maelle being invited to meetings she books
- Meeting location wrong when owner was counted as an attendee

---

## 0.2

### New
- Scheduling skill — view calendar, check free/busy, find available slots, create and delete meetings
- Microsoft Graph integration — calendar read/write via Azure service principal, no user login required
- Slack user lookup — search workspace members by name, returns ID, timezone, and email
- YAML profile system — per-user config covering schedule, skills, assistant persona, and VIP contacts
- SQLite database — conversation threads, coordination jobs, outreach jobs, known contacts
- Colleague role — separate system prompt and restricted tool set for non-owner senders

### Changed
- Orchestrator upgraded to multi-turn agent loop with up to 10 iterations

### Fixed
- Date calculation errors — replaced ad-hoc logic with a 14-day lookup table in the system prompt
- "Tomorrow" misinterpreted after midnight — explicit rule added for the 00:00–05:00 edge case

---

## 0.1

### New
- Initial Slack bot — Socket Mode, DM handler, thread-based conversation history
- Claude orchestrator — single-turn with tool calling via Anthropic SDK
- Hourglass reaction — shown while processing, removed on reply
- Assistant identity and persona — Maelle Parker, executive assistant
- Structured logger — human-readable timestamps with metadata
- Environment config — Anthropic API key, Slack tokens, Azure credentials
