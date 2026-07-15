# Maelle — Cleanup Audit Handoff

**Mission:** front-loaded hygiene pass (dead code / unused exports / duplicate+outdated comments) per `.claude/AUDIT_AGENT_STARTER.md`. Propose-only. Bug waves + design review follow later.

**State:** v3.7.3, HEAD `6c5024f`, tree clean at start.
**Method:** 6 read-only subagents by subsystem cluster (all 165 `src/**/*.ts` covered) + a deterministic import-graph orphan/dangling scan run by the lead. Every finding below was **re-verified by the lead** (grep callers / read the cited code) — this is the verified list, not raw agent output.
**Spend:** ~1.1M tokens across the 6 discovery agents.

**Status: SESSION 1 — proposed, awaiting owner triage. NOTHING fixed. NOTHING committed.**

Comment discipline for every edit below: keep a compact version/issue ref (`// vX.Y + vZ.W — why`); never strip provenance wholesale.

---

## WAVE 1 — Whole-file dead code (highest value)

Two safe deletes; three need an owner call (built-but-unwired / forward scaffolding).

| # | File | What / proof | Disposition |
|---|------|--------------|-------------|
| 1 | `src/utils/attendeeMode.ts` | sole export `inferDefaultMeetingMode` — 0 callers (orphan scan + grep). Signal moved to `resolveLocation`/`attendeeAvailability`. | **Safe delete** |
| 2 | `src/connectors/slack/relevance.ts` | sole export `isMessageForAssistant` — 0 callers. MPIM relevance classifier deleted v3.3.x (app.ts:1795), superseded by `classifyAddressee`. | **Safe delete** |
| 3 | `src/core/taskContinuity.ts` | `classifyTaskContinuity` (v2.0.3 same-thread task-dedup) — 0 callers. Header says "called from create_task before inserting"; it isn't. | **Owner decides:** delete (accept feature gone) OR re-wire into create_task if the dedup was lost by accident |
| 4 | `src/db/cronSchedules.ts` | full CRUD module (v2.7.0) meant to replace `routines` — 0 importers anywhere; `routines` is still the live path at 3.7.3. | **Owner decides:** delete the `.ts` (safe, 0 importers); LEAVE the `cron_schedules` table (schema drop = risky) |
| 5 | `src/connections/router.ts` (+ `PersonRef`/`RoutingPolicy` in types.ts) | `resolveOutgoing`/`recipientReachableOn`/`defaultRoutingPolicy` — 0 importers; types used only by router. Dormant multi-transport scaffolding (issue #1). | **Owner decides:** keep as forward scaffolding, or delete if multi-transport isn't landing soon |

---

## WAVE 2 — Dead functions / exports (verified 0 callers; atomic edits)

| # | Location | Symbol | Note |
|---|----------|--------|------|
| 6 | `db/socialSubjects.ts:283` | `getDormantSubjectsForPerson` | safe |
| 7 | `db/socialSubjects.ts:339` | `reviveSubject` | safe (revival now at rank layer) |
| 8 | `db/socialSubjects.ts:597` | `lastTopicTouchMs` | safe (gate now reads people_memory.last_initiated_at) |
| 9 | `db/socialSubjects.ts:152` | `getAllCategories` | safe |
| 10 | `db/socialSubjects.ts:167` | `getCategoryById` | **owner decides:** currently 0 callers, but a prior audit suggested ADOPTING it at the two `cat_global_` `.replace` sites (capturePass.ts:825,869). Delete OR adopt. |
| 11 | `db/people.ts:431/437` | `updatePersonGender` + `updatePersonGenderById` (pair) | safe (gender writes go via `setCoreFieldWithProvenance`/`confirmPersonGenderById`). Re-point comment at genderDetect.ts:94. |
| 12 | `db/requests.ts:431` | `getOpenOutreachForColleague` | safe (superseded by `getOpenRequestsForColleague`) |
| 13 | `db/requests.ts:549` | `mergeRequestDetails` | safe (merges go via `updateRequest({details})`) |
| 14 | `utils/timezoneValidator.ts:35` | `assertStrictIana` | safe (callers use boolean `isStrictIana`) |
| 15 | `utils/categoryRules.ts:58` | `resolveCategoryByPriority` | safe (drop its bullet in header:12) |
| 16 | `db/scheduleOverrides.ts:114` | `pruneScheduleOverridesBefore` | safe ("correctness never depends on it") |
| 17 | `db/calendarIssues.ts:585` | `cleanOldResolvedIssues` | safe — AND its comment lies ("Called from the brief routine" — it isn't) |
| 18 | `utils/workingElsewhere.ts:83` | `resolveOwnerTravelContextForDate` | safe — dead #143 residue; consumers moved to `getTravelContextForInstant`. KEEP the `OwnerTravelContext` interface (it's used). Re-point comments at workingElsewhere.ts:10 + weTimeResolver.ts:14,40. |
| 19 | `db/events.ts:70` | `markEventActioned` | safe (leave the `actioned` column) |
| 20 | `connections/registry.ts:58` | `unregisterConnection` | safe |
| 21 | `connectors/slack/assistantThreads.ts:97/113` | `getActiveAssistantThreads` + `isAssistantThread` (pair) | safe — gate removed v2.8.5; only `registerAssistantThread` stays live. Removes stacked JSDoc (S1) + stale doc (C2) too. |
| 22 | `connectors/slack/coordinator.ts:39/485` | `sendOutreachDM` + `postToChannel` (coordinator's dead copies) | safe (live `postToChannel` is in messaging.ts). Drop bullets in header:5,8. |
| 23 | `connectors/slack/processedDedup.ts:41/45` | `hasProcessed` + `unmarkProcessed` | safe — also drop `hasProcessed` from app.ts:156 destructure |
| 24 | `connections/slack/messaging.ts:46` | `is_external_guest` interface field (set :326, never read) | safe — remove field + set-site + the claim in comment :294-298 |
| 25 | `core/briefIntent.ts:25` | unused default `import Anthropic` | trivial (file uses `getAnthropicClient()`) |
| 26 | `utils/displaySubject.ts:55` | drop `export` on `isEventPrivate` (KEEP fn — used internally :46) | trims public surface, no behavior change |

**Candidates — confirm before removing:**
| # | Location | Symbol | Why hold |
|---|----------|--------|----------|
| 27 | `db/slotHolds.ts:152` | `getSlotHoldById` | #30 slot-holds may be mid-build — confirm surface isn't in-flight |
| 28 | `utils/toolCallCache.ts:151` | `_clearToolCallCacheForTests` | deliberate test seam — keep if a test suite is planned |

---

## WAVE 3 — Contradicts-code comments (mini-bugs — a reader believes them; do FIRST among comments)

Prose edits, keep provenance.

| # | Location | Stale claim → reality |
|---|----------|------------------------|
| 29 | `utils/closeMeetingArtifacts.ts:223-230` + `:58-64` | **Highest comment value.** Both describe a subject-match / `subkind='in_flight_action'` fallback tier — code has neither (only meeting-id + origin_thread_ts match). Tier was deleted v3.4.6 (sibling comment at :271-275 confirms). One comment even contradicts the other. |
| 30 | `utils/scheduleRules.ts:13-33, :64, :65` | (a) rule list enumerates 1-8 but code has rule 0 `in_the_past` + rule 9 `focus_time_floor`; (b) "2h office / 1h home" floor is the DELETED fixed model — now length-based `requiredFreeMinutesForWorkDay`; (c) "both callers consume this export" — find_available_slots consumes it only transitively via checkSlot. |
| 31 | `db/engagementRank.ts:13-24` | 6-rule delta table; code only does `reply_engaged` (+1 any reply <24h), owner-directive, revival. The >30-char / brief-0 / 48h-−1 / −2-deflection rules are gone. |
| 32 | `core/social/logEngagement.ts:14-17` + `db/socialSubjects.ts:27,32` | pivot "→ −1" is wrong (code = no-signal, marker left alive); "applied by the orchestrator post-classifier" → applied end-of-chat by `capturePass.runSubjectReconciliation`. |
| 33 | `tasks/dispatchers/socialDecay.ts:4-11` | s/topic/subject/ — walks `social_subjects`, not topics (terminology drifted post-v2.6.7). |
| 34 | `skills/social.ts:6,22-24` | header lists removed "cold-pings" (v3.2.5) + retired "rank-check tasks" (v3.2.6). |
| 35 | `skills/news.ts:16-21` | "Tavily runs unsteered" is false — LLM planner emits preferred/avoid domains that code hands to Tavily (M-7). The MD is never *parsed*; that part is right. |
| 36 | `llm/modelId.ts:8,23` | `claude-haiku-4-6` map entry never looked up (Haiku callers use bare `claude-haiku-4-5-20251001`, not `resolveModelId`); model name also wrong. Drop the entry + comment token. |
| 37 | `core/requests/deferredActionReplay.ts:12` | header says `MeetingsSkill`; code instantiates `SchedulingSkill` (a different real class). One-word fix; misdirects readers. |
| 38 | `utils/imageGuard.ts:10` | "Sibling to coordGuard.ts" — coordGuard.ts does not exist (no import, only this comment). Drop the sentence or repoint to securityGate.ts. |
| 39 | `connectors/slack/app.ts:50-51` | routing-matrix header references a "relevance-classifier / relevance LLM" voter that was deleted v3.3.x; only `classifyAddressee` remains. |

Comment-stack merges (category 3): **effectively none** — all 6 agents found the codebase's comment density is single-WHY-per-block with distinct provenance, not redundant piles. The only "stack" (assistantThreads S1) is subsumed by finding #21.

---

## WAVE 4 — Schema / behavioral (owner decides / candidate bug ticket — NOT pure cleanup)

| # | Location | Issue |
|---|----------|-------|
| 40 | `db/client.ts:160-165 vs 626-658` | `approvals` table `DROP`ped (165) then `CREATE IF NOT EXISTS` + ALTER/index (626-658) every boot — comment promises "leave no dead storage" but code resurrects an unused table each startup. No reader/writer left (`db/index.ts:7-11`). **Schema — owner decides:** remove the CREATE/ALTER/index (the DROP already cleans legacy DBs). |
| 41 | `utils/toolCallCache.ts:50-51,59` | `WRITE_TOOLS` names `create_routine`/`update_routine`/`learn_preference` — none are emitted anymore (merged to `manage_routine` crons.ts:287 / `manage_preference` assistant.ts:33). The stale names never match AND the real names are ABSENT → routine/preference writes get the 5s read-TTL instead of the 60s write-TTL. **Latent behavioral bug** rooted in stale names — fix the names. |

---

## Do-not-re-flag carried forward (verified NOT dead this run — don't re-raise)
- `defaultWorkingHoursForTz`, `attendee_busy_collision`, all calendar.ts/floatingBlocks/workHours exports — live.
- The 3 location helpers (`resolveLocation` / `locationResolver` / `locationTz`) — all live, non-duplicative.
- `RankChangeReason` union members `colleague_initiated`/`reply_brief`/`colleague_deflected` — kept for type-safe reads of old `engagement_rank_log` rows (do NOT drop from the union).
- `voice/fileTranscribe.transcribeAudioFile` — reached via dormant whatsapp transport, not dead.
- `buildSystemPrompt` — used by `scripts/measure-prompt.ts` (outside src/).
- `manage_working_elsewhere` tool + the `working_elsewhere` yaml back-compat block — live/kept on purpose.
- All the STATE-CARRIED-FORWARD items from AUDIT_AGENT_STARTER.md (vestigial status columns, proactive_pending, etc.).

## Follow-ons DISCOVERED during execution
- **A — `assistant_threads` registry [DONE].** Whole registry removed: `assistantThreads.ts` deleted, the `assistant_thread_started` handler removed from app.ts, `CREATE TABLE assistant_threads` dropped, and a `DROP TABLE IF EXISTS` migration added. Stale comments in background.ts + orchestrator repointed to the registry-free `discoverThreadParents` path.
- **B — `userProfile.ts` `connections:` schema block is orphaned [STILL OPEN].** `router.ts` (#5) was its only consumer. The zod block (`default_routing`/`per_skill_routing`) now has zero readers. Left in place (owner-facing config/back-compat); comment updated to say it's unread scaffolding. Remove if multi-transport (issue #1) isn't coming.

## Dead DB tables dropped [DONE — owner approved]
`approvals` (already, #40), plus `cron_schedules` and `assistant_threads` — all three now `DROP TABLE IF EXISTS` in the client.ts migration block (cleans the live DB on next boot) with no recreate. Their code was already removed.

## SESSION LOG
- SESSION 1 (this run): owner approved Wave 1 (all), Wave 3 (all), Wave 2 (verified removals), #40, #41.
  APPLIED — 5 files deleted (attendeeMode, relevance, taskContinuity, cronSchedules, router) + PersonRef/RoutingPolicy types; ~20 dead functions/exports removed incl. #27 getSlotHoldById; all Wave-3 contradicts-code comments fixed (provenance kept); #40 approvals-table recreate removed (DROP kept); #41 WRITE_TOOLS names corrected (manage_routine added).
  KEPT — #10 getCategoryById REMOVED (owner said remove-if-unused); #28 `_clearToolCallCacheForTests` kept (test seam).
  Net −1,118 LOC (1,193 removed / 75 added), 39 files. Typecheck EXIT=0. NOT committed (awaiting wrap).
  Two follow-ons discovered (above). The `cron_schedules` + `assistant_threads` + `approvals` TABLES remain (schema drops left to owner).
