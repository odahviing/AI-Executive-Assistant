# V4 Pre-Release Audit — Handoff

Run date: 2026-07-21. Method: 7 parallel read-only subagents (one per subsystem) + a deterministic import-graph / unused-export scan. Strict propose-only; nothing was edited. Every HIGH below was personally re-verified against the code on disk (not taken on a subagent's word). Base version at audit time: 3.8.4.

## STATUS — SESSION 1 (2026-07-21): Wave 1 (HIGH) + Wave 3 (dead code) + Wave 4 (comments) FIXED, plus owner-selected MEDIUMs (M1,M2,M3,M4,M13,M15) and M14 (full-day WE framework DELETED). Uncommitted, typecheck green. Guard-class findings routed to the guard chat. Remaining unassigned: M5, M8, M9, M10, M11.

Owner-selected this session (also fixed):
- **M1** analysis.ts — day classification (isWorkDay/dayType) now from `getEffectiveWorkDay` (.isWorkday/.location), not raw weekday; removed the now-dead officeDays/homeDays/allWorkDays sets.
- **M2** capturePass — read raised subject BEFORE raise-feedback clears its marker (kills the ±2 double-count).
- **M3** capturePass — `chatToTranscript` drops the dead `ownerName` param; SELF path now labels the human turns with the owner's name (was "Maelle").
- **M4** summary — action-item assignee uses the shared `nameGenuinelyMatches` (exported from resolveAttendeeEmails) with empty-guard; no more first-attendee / "Dan"→"Daniel" mis-bind.
- **M13** conversations — `getConversationHistory` JSON.parse wrapped in try/catch → `[]`.
- **M15** calendarHealth prompt — active-mode overlap behavior corrected (auto-moves internal-only unprotected; reports protected).
- **M14** — DELETED the full-day WE framework: `manage_working_elsewhere` tool (def + handler + case + import) and every plumbing entry (registry scope, toolStatusText, toolCallCache, textScrubber, inboundQueue), the dead `working_elsewhere` yaml schema in userProfile, and the stale calendarTypes comment. KEPT: `utils/workingElsewhere.ts` (the #143 override ADAPTERS — away-note + dual-clock), `weTimeResolver`, `owner_schedule_overrides`, and the TIMED soft `showAs='workingElsewhere'` event. Away-days are declared via `set_work_schedule_override` now. Two dead refs left in in-flight files (route to orchestrator chat): `orchestrator/index.ts:1044` (dead narration-map key `manage_working_elsewhere`), and confirm nothing in buildTurnContext instructs calling it (its OWNER LOCATION block is fine — override-derived).

Guard-class → handed to guard chat (that chat decides; verification-layer, fail-direction tradeoffs are theirs): M6 claimChecker blanket-skip, M7 addresseeGate fail-open, M12 weekdayGuard Sun-start, L10 humanGate empty-rewrite ship, L16 requestDedup/closeLoopOnOwnerHandled raw parse, L17 postReply 'unknown' role gate-bypass.

## STATUS — SESSION 1 (2026-07-21): Wave 1 (HIGH) + Wave 3 (dead code) + Wave 4 (comments) all FIXED. Uncommitted, typecheck green. Waves 2 (MEDIUM) + 5 (LOW) still open for owner review.

Fixed this session (all verified against code, `tsc --noEmit` clean):
- **HIGH:** H1 meetingReschedule (moveApplied guard), H2+H2b runner await_reply/closeRequest (+ briefs.ts), H3 background re-entrancy guard, H4 calendarHealth prompt → manage_calendar_issue, H5 workHours instant home-tz anchor, H6 person-store migration 3-column fix, H7 handlers dedup on file/huddle/MPIM-image branches.
- **Dead code:** removed sendProactiveMessage, isDirectContext, postIngestResult, resolveAttendeeEmails(plural), 8 tasks/index.ts helpers (+DateTime import), parseOutcome + OutreachSubkind + outreach_decision handler/case, linkOutreachToRequest, purgeIdleSummaryDrafts, findProfileBySlackId, TARGET_ACTIVE_CATEGORIES, statusTag, SocialTopicQuality + PersonSocialTopicQuality (chain), moveMeeting dead import, generateCoda Anthropic+config imports, summary config import + botToken param, app.ts auditLog import.
- **Comments:** scheduleRules same-venue, workHours computeHealthCheckWindow docblock, postReply Haiku/retry, movingAnchorDay ±60, calendarReads dup Daniel-bug comment, graph/findAvailableSlots "line 420", floatingBlockOps ":1531", handlers.ts ×3 stale refs.

Re-classified during fix (NOT dead — do not remove):
- `buildSystemPrompt` (systemPrompt.ts) — KEPT. `scripts/measure-prompts.cjs` calls it (src-only scan missed the scripts/ caller). Back-compat wrapper, intentional. (`scripts/measure-prompt.ts`, the other caller at audit time, was deleted 2026-08-04 — see CHANGELOG.)
- logEngagement `replyText` param (Agent-3 LOW) — SKIPPED. Its caller is `orchestrator/index.ts:1191`, an in-flight file owned by another chat; removing the param would force an edit there. Route to that chat.

Commit caveat: the working tree also holds other chats' uncommitted work (orchestrator index/buildTurnContext, checkHealth, llm/modelId deletion) + CRLF re-normalization noise. At wrap, `git add` ONLY the ~28 files this session edited — never `-A`.

---

Multi-chat repo — before fixing, `git status` and only `git add <paths>` your own files. In-flight/owned-elsewhere (DO NOT touch): `src/core/orchestrator/index.ts` & `buildTurnContext.ts` (refactor), `src/skills/calendarHealth/handlers/checkHealth.ts` (calendar-health fix), `src/llm/*` + model/SDK/`thinking` (SDK/Sonnet chat), Docker/k8s/deploy (GCP chat).

---

## WAVE 1 — HIGH (verified). Ship before V4.

### H1 — Reschedule counter auto-accept reports a FAILED move as success `src/skills/meetingReschedule.ts:428-467`
The `updateMeeting` try/catch at 408-433: the catch only logs "falling back to approval" (comment "// fall through to approval path below") but there is **no fall-through** — execution continues unconditionally to DM the colleague "Works — moved to {time}" (437), shadow the owner "so I moved it" (454), mark the task completed (462-465), `return true` (466). The owner-ask fallback at 477 is unreachable from this branch. On a Graph PATCH failure the meeting stays put while both parties are told it moved. Contrast the `approved` branch (230-243) which returns an error on the same failure.
**Fix:** in the catch, skip the confirm/shadow/close and drop to the owner-ask fallback (or return an error) — mirror the approved branch. Also fix the false comment.

### H2 — `await_reply !== false` is always true (numeric field) → fire-and-forget outreach mis-tracked `src/core/requests/runner.ts:462` (+ `src/tasks/briefs.ts:204`)
`details.await_reply` is stored as a **number** 0/1 (`db/jobs.ts:176`, `params.await_reply: number`). `details.await_reply !== false` is `true` for both `0` and `1`, so `awaitReply` is always true. A *scheduled* fire-and-forget outreach (`scheduled_at` set + `await_reply=0`, request state `in_flight`/`send_scheduled_outreach`) is misclassified on fire: flips to `awaiting_colleague`, arms a +5d expiry, lingers in every brief as "waiting on X", then emits a bogus "they never replied" tombstone. `briefs.ts:204` repeats the same `det.await_reply !== false` mistake.
**Fix:** compare numerically — `!!details.await_reply` (or `!== 0 && !== false` to preserve "missing = await"). Fix both sites.

### H2b — Fire-and-forget "close" is a silent no-op (bundle with H2) `src/core/requests/runner.ts:463-480`
In the `!awaitReply` branch, `updateRequest(... state:'resolved' ...)` runs at 463 **before** `closeRequest(... 'outreach_sent_fire_and_forget' ...)` at 473. closeRequest re-reads the now-terminal row and no-ops (`closeRequest.ts:49-54`) → `closed_at`/`closed_by`/`closure_reason` stay NULL, no `audit_log` row, no child cascade, yet the sweep counts it 'closed'. Violates "closeRequest is the single terminal path." Currently masked by H2 (branch never runs); fix together.
**Fix:** don't set `state` in that `updateRequest`; let `closeRequest` do the terminal write + audit.

### H3 — 5-minute background pipeline has no re-entrancy guard → slow request handler double-fires `src/core/background.ts:146-191` + `src/core/requests/runner.ts:306-348`
The main `setInterval` runs `materializeRoutineTasks → runDueTasks → processSlotHoldsIfDue` fire-and-forget with **no in-flight guard** — unlike its 10-min sibling at 211-217 (`periodicInFlight`). Request handlers don't pre-claim their row: `runResearchRun` runs a full `runOrchestrator` (+ up-to-120s 429 backoff) and only clears `next_check_at` via `closeRequest` at the very end (342). If one tick exceeds 5 min, the next tick's `getDueRequests()` re-selects the same still-open row → two concurrent research runs + two owner DMs + double LLM spend. Same class hits `runReminderFire` and the briefing. (Task-table dispatch is safe — `executeTask` flips `in_progress` synchronously.) Real risk on the 24/7 GCP target.
**Fix:** guard the pipeline with an `inFlight` boolean (mirror `periodicInFlight`), or flip state / clear `next_check_at` before the async work in the slow handlers.

### H4 — Calendar-health prompt tells the model to call DELETED tools `src/skills/calendarHealth.ts:262-263, 265-272, 298, 301`
The prompt lists `get_calendar_issues` + `update_calendar_issue` as available and instructs `update_calendar_issue` with statuses `approved`/`to_resolve`/`resolved`. The only registered tool is `manage_calendar_issue` (registry.ts:168; defined calendarHealth.ts:152; actions `list|approve|start_resolve|owner_will_resolve|owner_done`). On the most common flow ("it's fine, leave it") the model is steered to a non-existent tool + invalid status.
**Fix:** rewrite the prose to `manage_calendar_issue` + its real actions. Related stale lists to sweep: `src/utils/textScrubber.ts:56` (`get_calendar_issues`,`update_calendar_issue`); route `src/core/orchestrator/index.ts:1092` (`update_calendar_issue`) to the orchestrator chat.

### H5 — `getEffectiveWorkDayForInstant` anchors a zoneless slot in the SERVER zone, not the owner's `src/utils/workHours.ts:157`
`DateTime.fromISO(instantIso, { setZone: true })` — for a bare ISO (no offset) `setZone:true` is a no-op, so Luxon parses in the process/server zone. But `checkSlot` anchors the SAME string in the owner's home tz (`scheduleRules.ts:189 { zone: tz, setZone: true }`) and then feeds the raw string to this resolver (`scheduleRules.ts:196`). On a host whose zone ≠ owner home tz (the GCP/UTC target) a near-midnight bare slot resolves to the wrong calendar date → wrong `owner_schedule_overrides` row → wrong workday/windows/tz. Latent on Idan's local box (zone == home); bites once deployed off-home-zone. `tasks/skill.ts:685` re-anchors bare `payload.start` with `{ zone: tz }` then passes the bare string to checkSlot at :694, proving bare payloads occur.
**Fix:** `DateTime.fromISO(instantIso, { zone: homeTz, setZone: true })` — match checkSlot. (Coupled to GCP timing; fix lives in workHours.ts, not the GCP chat's files.)

### H6 — Fresh installs boot missing 3 `people_memory` columns → first inbound message throws `src/db/migrations/v3_2_0_person_store.ts:98-127` + `src/db/client.ts`
Order in `getDb()`: `initSchema` (client.ts:19) creates `people_memory` OLD-shape (`slack_id` PK, :259) + ALTERs in `name_he_set_by` (:292), `last_inbound_lang` (:299), `last_inbound_lang_at` (:300); **then** `runPersonStoreMigration` (client.ts:33) sees no `person_id` → rebuilds to `people_memory_new` (migration :98-126) whose CREATE omits those 3 columns → dropped. `is_vip` (client.ts:43, after the migration) is the only post-migration column re-added. First inbound → `stampInboundLang` (`db/people.ts:464`, `UPDATE … SET last_inbound_lang`) throws `no such column`. Self-heals on the SECOND boot (initSchema ALTERs re-add). This is exactly the V4/GCP fresh-deploy path; production (already migrated) is unaffected.
**Fix:** add the post-v3.2.0 columns to the rebuild CREATE, OR extract the column-ALTER block into a helper and re-run it after the migration, OR early-return the migration for a freshly-created (0-row, old-shape) table. Owner picks the shape.

### H7 — Media / file_share / huddle inbound branches bypass BOTH dedup guards → double-processing on socket reconnect `src/connectors/slack/app/handlers.ts`
`markProcessed`/`markContentProcessed` are only called on the three plain-text paths (DM :358/361, MPIM :552/555, mention :889/895). The DM doc/image/audio branches (130-253), the MPIM image branch (404-462, returns before :552), and the owner huddle-recap branch (291-348) reach `processMessage`/ingest with no ts- or content-dedup. Socket Mode is at-least-once and replays queued events on reconnect (the documented reason for the 10-min TTL in `processedDedup.ts`); a re-delivered voice/image/doc/huddle message is transcribed/ingested and re-run through the orchestrator → duplicate reply + duplicate summary draft + re-fired side effects. Real on the 24/7 socket deployment.
**Fix:** call `markProcessed(ts)` (+ content dedup) at the top of the file_share and huddle branches, before `setImmediate`.

---

## WAVE 2 — MEDIUM (agent-reported; spot-verified). Fix the multi-tenant + honesty ones before V4 if V4 is multi-tenant.

- **M1 `src/skills/meetings/ops/analysis.ts:293-295`** — `analyzeCalendar` derives `isWorkDay`/`dayType` from raw weekday yaml, ignoring the #143 per-date override it *does* honor for windows (:303). An "off next Wed" override still analyzes Wed as a 9-19 workday (false no_buffer / missing lunch); a made-working off-day is mis-flagged `work_on_day_off`. Use `getEffectiveWorkDay(dateStr).isWorkday/.location`.
- **M2 `src/memory/capturePass.ts:965-985`** — engagement signal double-counts on the common "colleague replied to the coda" path: `applyRaiseFeedbackForMatches` clears the raised marker, so the next `getMostRecentRaisedSubject` exclusion misses it and `applyOrganicMatchSignal` fires a second ±1. Capture the raised id before clearing.
- **M3 `src/memory/capturePass.ts:163-168` (call :580)** — SELF-capture labels BOTH owner and assistant turns "Maelle" (`chatToTranscript` never uses its `ownerName` param); the self-fact extractor can't tell who said what. Pass `ownerName` as the human label on the SELF path.
- **M4 `src/skills/summary.ts:575-577`** — action-item assignee matched by loose `includes()` substring; empty `assignee_text` matches the FIRST internal attendee (`includes("")===true`) → a `summary_action_followup` task DMs the wrong colleague. Require exact/normalized token match; skip empty.
- **M5 `src/db/socialSubjects.ts:259,244,448,483,514`** — five subject reads filter on `person_slack_id` only, no `owner_user_id` (documented as the multi-tenant boundary; siblings scope it). Two owners in one workspace would cross-read/write each other's subjects. No single-tenant impact; a real isolation break for a multi-tenant V4. Thread `ownerUserId` through.
- **M6 `src/utils/claimChecker.ts:93`** (VERIFIED) — `if (input.bookingOccurred) return false` blanket-skips ALL honesty checks when a booking succeeded; a phantom send in a booking reply ("Booked Tue 2pm and pinged Yael" with no `message_colleague`) ships unchecked. Treat `bookingOccurred` as pre-satisfying only book-class claims; still LLM-check message/deliver_file.
- **M7 `src/utils/addresseeGate.ts:84-88`** — the catch returns `'MAELLE'` (run) on a classifier error, but the file's own design says group false-positives are worse and `AMBIGUOUS`→silence. A Haiku outage makes Maelle answer human-to-human group chatter. Return `'AMBIGUOUS'` on error.
- **M8 `src/connectors/slack/inboundQueue.ts:229-237`** — abort path pushes only the new message (batch already moved out at :275-276), so the merged re-run loses the earlier message + the "[follow-up]" annotation; comment claims they merge. Fix comment or carry the aborted batch forward.
- **M9 `src/connectors/slack/postReply.ts:149,636,817`** — `appendToConversation` is append-only, so the claim-checker's honest rewrite (:636, comment "Overwrite … so the NEXT turn doesn't see the dishonest draft") is appended as a SECOND row; the dishonest draft persists into next-turn context (+ history bloat). Replace the last assistant entry instead of appending.
- **M10 `src/connectors/slack/processMessage.ts:141`** — `handleOutreachReply` runs before `enqueueMessage` (:469), outside the serial queue; rapid distinct colleague replies (neither dedup fires) run it concurrently on the same open outreach row → double classification / double DM / racing state. Move the intercept inside the queued runner, or mutex per (owner, colleague).
- **M11 `src/utils/scheduleRules.ts:515-527`** — split-shift focus-floor measures free time across the union span, counting the between-shifts off-hours (e.g. 15:30-21:30) as quality free → the focus floor never fires on split-shift days. Measure per-window.
- **M12 `src/utils/weekdayGuard.ts:47`** — `dt.set({ weekday })` moves within the ISO week (Mon=1…Sun=7); for a Sun-Thu owner a "Sunday" correction jumps to the Sunday 5 days later, not 2 days earlier. Bias to nearest matching date / owner week-start.
- **M13 `src/db/conversations.ts:16`** — `getConversationHistory` does `JSON.parse(row.context)` with no try/catch; one corrupt row wedges the thread for both read and append (siblings guard). Wrap → return `[]`.
- **M14 `src/skills/calendarHealth.ts:181` + `handlers/categoryOps.ts:82-83`** — `manage_working_elsewhere` tool description + success note promise "availability tentative in away-tz + bookings route to approval," but post-#143 the all-day WE marker is read by NO scheduling path (slot finder ignores all-day WE). Owner is told about routing that never happens. Correct the description, or have the handler write a schedule override.
- **M15 `src/skills/calendarHealth.ts:292,305`** (prompt honesty) — prompt asserts active mode "DOES NOT auto-move overlaps" / "Never auto-resolve double bookings," but the active loop auto-moves internal-only unprotected overlaps (`checkHealth.ts:900`) and the tool's own :39 says so. Delete the stale v2.2 sentences.

---

## WAVE 3 — Dead code (for the removal track). Verified zero callers (agent grep AND/OR mechanical scan: defined, count≤1 in-file, 0 cross-file).

**Confirmed dead (safe to remove after a final string-dispatch glance):**
- `src/connectors/slack/app.ts:244` `sendProactiveMessage` (agent + scan)
- `src/connectors/slack/app/helpers.ts:26,118` `isDirectContext`, `postIngestResult` (agent + scan) — `isDirectContext`'s comment also contradicts postReply.ts:738
- `src/skills/meetings/resolveAttendeeEmails.ts:77-79` `resolveAttendeeEmails` (plural wrapper; all callers use the singular)
- `src/skills/meetings/ops/handlers/moveMeeting.ts:13` dead `humanizeViolationLabel` import + inline `labelFor` (707-722) duplicating it
- `src/tasks/index.ts` task-query helpers superseded by the requests spine: `getBriefableTasks` (:232), `getCompletedUninformedTasks` (:203), `getOpenTasksWithPerson` (:105), `formatTasksForUser` (:293) (agent + scan) — scan also flags `getTask`, `getOpenTasksForOwner`, `getTasksForPerson`, `cancelTask` (confirm each)
- `src/core/requests/types.ts:218` `parseOutcome`; `:74-75` dead `outreach_decision` NextCheckHandler value + unreachable `case` (runner.ts:124) + contradicting two-stage-flow comments
- `src/core/social/generateCoda.ts:20,25` unused `import Anthropic`, `import { config }`
- `src/skills/summary.ts:33` unused `import { config }`; `:556` unused `botToken` param of `resolveActionItemAssignees`
- `src/core/social/logEngagement.ts:133-137` unused `replyText` param

**Mechanical-scan dead candidates (scan: 0 refs anywhere; verify string-dispatch before removal):** `config/userProfile.ts findProfileBySlackId`, `core/orchestrator/systemPrompt.ts buildSystemPrompt` (orphaned post-split — confirm with orchestrator chat), `db/jobs.ts linkOutreachToRequest`, `db/summarySessions.ts purgeIdleSummaryDrafts`, `db/socialSubjects.ts TARGET_ACTIVE_CATEGORIES`, `utils/annotateSlotsWithAttendeeStatus.ts statusTag`, `core/requests/types.ts OutreachSubkind`, `db/people.ts SocialTopicQuality`.

**Leave (not dead):** `_resetForTests`, `_clearToolCallCacheForTests` (test hooks); `connectors/whatsapp.ts getWhatsAppClient` (dormant by design); the 162 "over-exported" symbols (used in-file, just redundant `export`) — low value, not worth churn.

---

## WAVE 4 — Bad comments (contradict-code; keep provenance tags).
- `src/utils/scheduleRules.ts:410` — "Only collide if … isn't ALSO at the same external venue" above an unconditional collision return (no venue check exists).
- `src/utils/workHours.ts:289-304` — `computeHealthCheckWindow` docblock describes retired "last-workday + extend-7d" logic; code is a Sunday-anchored fixed 13-day window (inner v3.2.6 comment is right).
- `src/connectors/slack/postReply.ts:157-160` — "each a Sonnet pass; retry re-invokes the orchestrator" — guards run Haiku now and the orchestrator-re-invoke retry was replaced (this file's :465-473).
- Stale post-split line refs: `handlers.ts:656,694,553-554`; `floatingBlockOps.ts:110` (":1531"); `calendarReads.ts:531-538` (dup comment); `graph/findAvailableSlots.ts:358-360` ("line 420"); `movingAnchorDay.ts:25` ("±60 days" → −7/+60).

---

## WAVE 5 — LOW bugs (defensive / niche).
- `src/core/requests/runner.ts:339-348` failed research closed as `research_completed` (brief narrates it done) · `:367-370` `reschedule_reask` stale-guard strands an open `awaiting_colleague` with no timer.
- `src/core/approvals/approvalCallbacks.ts:178-184` amend for `book_floating_block` writes `args.start` (ISO) but the tool reads `start_time`+`date` → owner amend silently dropped.
- `src/tasks/index.ts:191-197` `getActiveJobsForThread` filters vestigial `outreach_jobs.status`; a fire-and-forget row leaks into "ACTIVE IN THIS THREAD". JOIN requests, gate on `r.state`.
- `src/connectors/graph/calendarReads.ts:411-412` `getFreeBusy` >62-day clamp recursion drops `forceRefresh`+`diagnostics`.
- `src/skills/meetings/ops/handlers/moveMeeting.ts:968-997` owner floating-block move returns success with no `verifyEventMoved` (every other mutation path verifies).
- `src/skills/meetings/ops/handlers/findAvailableSlots.ts:824-835,905-913` tz-grounding fields dropped on the 0-slot returns.
- `src/connectors/slack/app/handlers.ts:87` no-op ternary `isMpim: source==='assistant_panel' ? false : false`.
- `src/connectors/slack/processMessage.ts:326` `botUserId`-null boot window skips the group addressee gate (Maelle answers unaddressed group chatter). Fail closed.
- `src/utils/humanGate.ts:460` `ok:false` + empty rewrite falls through to ship the flagged draft unchanged.
- `src/utils/ownerDailyThread.ts:76-102` duplicate-header race (posts header before INSERT OR IGNORE).
- `src/utils/turnCache.ts:70-78` caches rejected promises for the rest of the turn.
- `src/utils/threadAttendees.ts:20-23` process-global map never evicts (slow leak on 24/7); "bounded" comment optimistic.
- `src/utils/meetingRoomAvailability.ts:57-58` parses start/end without a zone (server-zone drift; safe today).
- `src/utils/responseDeadline.ts:16,39` `workDays` param dead → colleague reply-timer always Mon-Fri (Israeli Sun-Thu colleague mis-timed).
- `src/utils/requestDedup.ts:94-95` + `closeLoopOnOwnerHandled.ts:120-121` raw `JSON.parse` instead of the project's `extractFirstJsonObject` (fail safe; reuse).
- `src/connectors/slack/postReply.ts:175,300` `SenderRole 'unknown'` would bypass both honesty + leak gates (not currently reachable; guard if ever wired).

---

## Routed to other chats (do not fix here)
- `src/skills/calendarHealth/handlers/checkHealth.ts:373-414` — `oof_conflict` over-flags every meeting on a day with a *timed* OOF (no overlap test after the full-day-OOO skip). → calendar-health chat.
- `src/core/orchestrator/index.ts:1092` stale `update_calendar_issue` in a tool list. → orchestrator chat.
- securityGate Hebrew colleague-leak → guards chat (already known).

---

## Non-findings (checked, cleared — don't re-raise)
Prompt-injection surfaces in news/venue/knowledge/general (external content framed as data; all file-writes path-guarded, KB ingest owner-only, colleague KB gate fails closed); cross-person context leak (people-memory formatters gated `isOwner`, self-rows excluded); guard fail directions mostly correct/intentional (securityGate→safe canned fallback, identity→impersonation, imageGuard/dateVerifier/claimChecker documented fail-open); `shadowNotify` owner-DM-cache gate; `scrubInternalLeakage` wired on every outbound; `recall_interactions` re-blocked at the dispatch chokepoint; socket-watchdog watermark ordering; DM↔MPIM double-dispatch (MPIM bails on `im`); slotDayMinutes duration-based end; weTimeResolver dual-clock + away-day direct-book (load-bearing).
