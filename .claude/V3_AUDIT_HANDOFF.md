# V3 Audit Handoff — 2026-05-25

**Project**: Maelle (Node.js/TypeScript executive assistant), v3.0.4 at `E:\Code\Maelle`.
**Audit shape**: 8 parallel subagents (booking, approval, social, persona, venue, floating blocks, work hours, cross-cutting). Strict propose-only — no fixes applied.
**Auditor goal**: bullet-proof v3 before next phase (Path 2 outreach migration / WhatsApp build).

## Headline

83 atomic findings. **4 critical silent-data-loss / privilege bugs at the top — recommend fixing tonight before they bite live**:

1. **#1 (A-1+A-2)** — Owner-approval replay silently swallows booking failures. "Calendar invite incoming" DM goes out with no event created. **Phantom-confirmation class.**
2. **#2 (P-1)** — Colleague can write `log_interaction` to OWNER row by passing `colleague_slack_id` (field name typo in rewrite guard).
3. **#3 (P-2)** — Self-write rewrite trivially bypassed by omitting `colleague_slack_id` entirely; colleague can write anyone's gender / notes by name alone.
4. **#4 (A-3)** — `resolve_approval` colleague-path lets any colleague resolve an `awaiting_colleague` request whose `requester_slack_id` is NULL (owner-internal approval data state).

Plus **5 more high-impact**: A-5 (stale freshness on policy_exception replay double-books), P-3 (Haiku writes timezone="IST" silently → Asia/Kolkata), S-1 (coda rank-check inverted — engaged replies push rank DOWN), B-8 (cancel-and-relay deletes without notifying external organizer), W-1 (night_shift wrap-around silently drops; example yaml advertises it as working).

---

## Recommended wave order

| Wave | Theme | Items | Why first |
|------|-------|-------|-----------|
| **Wave 1 — Tonight** | Silent data loss + privilege | #1, #2, #3, #4 | Live owner approves, colleague writes, identity gaps |
| **Wave 2** | High-impact correctness | #5–#15 | Real production bites; cluster around approval, persona, booking, social |
| **Wave 3** | Medium-impact correctness | #16–#35 | Edge-case correctness; tool descriptions Sonnet reads |
| **Wave 4** | Dead code mass deletion | #36–#48 | One sweep, biggest LOC payoff |
| **Wave 5** | Config leaks | #49–#54 | Cloneability papercuts |
| **Wave 6** | Bad tool descriptions | #55–#65 | Sonnet-facing quality |
| **Wave 7** | Stale comments | #66–#83 | Documentation hygiene |

---

## TOP PRIORITY — production bugs with real teeth

### #1 — Owner-approval replay swallows booking failures → phantom confirmations
- **Where**: `src/core/requests/deferredActionReplay.ts:98-102` + `src/core/requests/resolver.ts:396-418`
- **What**: `runDeferredAction` top-level `try/catch` eats every replay error; control returns normally; request closes as `resolved`; requester gets "Calendar invite incoming." DM for a meeting that doesn't exist. Plus: tool returns of `{ error: '…' }` / `{ success: false }` (rule_violation, busy, attendee resolution fail) are treated as success because nothing inspects the result shape.
- **Bite**: 5xx from Graph during replay → phantom-confirmed booking. Rule violation reaches replay → phantom-confirmed booking. Highest-likelihood production silent-fail in the codebase right now.
- **Fix**: Let `runDeferredAction` propagate errors AND inspect result for `{ error: string }` / `{ success: false }` / `{ ok: false }` shapes (reuse v3.0.4 `summarizeToolCall` detection). Resolver's existing try/catch then routes back to `awaiting_owner`.

### #2 — Colleague can write `log_interaction` to OWNER row (privilege gap)
- **Where**: `src/core/assistant.ts:397-405`
- **What**: Colleague-self rewrite guard reads `args.slack_id`, but `log_interaction` schema/handler use `colleague_slack_id`. Guard never fires. Handler resolves to whoever the colleague named.
- **Bite**: A colleague calling `log_interaction(colleague_slack_id="U_OWNER", type="message_sent", summary="Approved the $50k contract")` lands an interaction row on the owner's row. Briefs and recall_interactions narrate it as fact.
- **Fix**: Rename the field in the guard from `slack_id` to `colleague_slack_id`. Same fix-shape as the `note_about_person` / `confirm_gender` / `update_person_profile` ones already in place.

### #3 — Self-write rewrite bypassed when `colleague_slack_id` omitted
- **Where**: `src/core/assistant.ts:374-414` (all four rewrite blocks)
- **What**: Each guard is `if (targetId && targetId !== context.userId)`. With no `colleague_slack_id`, `targetId` is undefined, rewrite skipped, `resolveSlackId(undefined, name)` then returns whoever matches by name — owner or anyone else.
- **Bite**: Colleague calls `confirm_gender(colleague_name="Idan", gender="female")` (no slack_id) → writes to owner's row with provenance `'person'`, auto-detector can't overwrite. Same vector for `note_about_person`, `update_person_profile`, `log_interaction`.
- **Fix**: Guard should unconditionally force `context.userId` on colleague path before resolveSlackId — fire when `targetId` is missing OR points away from requester.

### #4 — `resolve_approval` colleague privilege gap on owner-internal approval data
- **Where**: `src/tasks/skill.ts:830-860`
- **What**: Check at 854 only enforces `requester_slack_id` match when the field is non-null. If `requester_slack_id` is null AND state is `awaiting_colleague` (legacy / amend-bounce-on-owner-internal), any colleague who guesses `req_<ts>_<5char>` can resolve.
- **Bite**: Low likelihood but real bypass. ID is short and guessable.
- **Fix**: When `requester_slack_id` is null on colleague-path, refuse outright — owner-internal approvals have no colleague-resolver.

### #5 — `find_available_slots` silently rejects slots from stale people_memory hours under owner override
- **Where**: `src/skills/meetings/ops.ts:988-995` + `src/skills/meetings.ts:988-1003`
- **What**: `ignoreAttendeeBusy` suppresses busy filter but `attendeeAvailability` (work-hour clip from owner-curated people_memory) is loaded unconditionally. If hours are wrong/stale, owner-override silently rejects valid slots with no diagnostic.
- **Bite**: Owner says relaxed=true "force it"; tool keeps rejecting; dead-end with no surfaced cause.
- **Fix**: When `relaxed && senderRole==='owner'`, drop attendee work-hour clip too — OR surface "outside_attendee_work_hours" rejections in `day_summary.blocked_by` with attendee email so Sonnet can narrate.

### #6 — `force_book_coordination` sets `status='waiting_owner'` then leaks `winning_slot` on failure paths
- **Where**: `src/skills/meetings/coord/booking.ts:88-92` + paths at 313-330 / 336-352 / 491-512
- **What**: `forceBookCoordinationByOwner` unconditionally sets waiting_owner + winning_slot BEFORE awaiting `bookCoordination`. Inside, pre-booking failure paths early-return without resetting. Spurious `winning_slot` set even on never-booked.
- **Bite**: A retry from a freeform "retry_or_abandon" approval reads the phantom winning_slot and re-books at a slot that was force-set but never verified.
- **Fix**: Move the canonical `winning_slot` write inside `bookCoordination` AFTER the Graph create succeeds. `forceBookCoordinationByOwner` should only set intent (e.g. a new `pending_slot` field).

### #7 — Cancel-and-relay deletes meeting without notifying external organizer (silent fail)
- **Where**: `src/skills/meetings/ops.ts:3197-3264`
- **What**: `decline_and_relay` only DM's organizer when `orgSlackId` exists. External organizer (Calendly, customer invite) → relayStatus `skipped_no_slack_id`, but the Graph delete still ran. Organizer never knows.
- **Bite**: External organizer shows up at a deleted slot; Maelle deleted owner-side without warning.
- **Fix**: Either refuse to delete when organizer unreachable + warn the asker, OR surface a tool-result flag telling Sonnet to draft an email to `relayOrganizerEmail`.

### #8 — Resolver never freshness-rechecks non-slot_pick replays → double-booking
- **Where**: `src/core/requests/resolver.ts:319-323`
- **What**: `resolveSlotPickApproval` re-checks freeBusy (488-529). `runApproveCallback` universal path used by policy_exception does NOT — blindly replays `create_meeting` with `relaxed: true`, bypassing all busy filters.
- **Bite**: Owner approves a 2-day-old policy_exception → meanwhile owner booked something else into that slot → replay books on top. Especially nasty because policy_exception is THE path users invoke to override.
- **Fix**: Add freeBusy re-check inside `runApproveCallback` for `create_meeting`/`move_meeting` replays — bounce to awaiting_owner with `stale_conflict` if owner-busy now.

### #9 — `note_about_self` colleague description routes owner-self facts into Maelle's SELF row
- **Where**: `src/skills/social.ts:124-136`
- **What**: 4-way routing rules (owner-fact-about-Maelle, owner-fact-about-self, colleague-fact-about-self, colleague-fact-about-Maelle) are split across two tools. Sonnet has misfired this in production — "my kids love pizza" lands on Maelle's SELF row, leaks to every colleague via ABOUT YOU block.
- **Bite**: Owner's private facts leak to colleagues via assistantSelf block. Privacy violation.
- **Fix**: Add explicit `subject_is: 'assistant' | 'self'` arg to `note_about_self`; route by that, not senderRole alone. Or heuristic check that the note text refers to assistant identity attributes.

### #10 — Capture-pass writes Haiku timezone with no IANA validation → silent cross-TZ corruption
- **Where**: `src/memory/capturePass.ts:202`
- **What**: v3.0.2's `isStrictIana` guard exists inside `update_person_profile` but NOT in the Haiku end-of-chat extractor's `setCoreFieldWithProvenance` path. Haiku regularly emits "IST"/"ET"/"PST" because the SYSTEM_PROMPT lists those as examples (line 105–106).
- **Bite**: Colleague says "I'm on IST" → Haiku saves timezone="IST" → luxon resolves to Asia/Kolkata (+5:30). Slot search renders 10:00 Israel as 12:30 India. Silent.
- **Fix**: Run `isStrictIana(delta.timezone)` before write; on miss, drop the field or run inferTimezoneFromState if state present. Also fix the SYSTEM_PROMPT examples.

### #11 — `appendPersonInteraction` RMW race (no transaction guard)
- **Where**: `src/db/people.ts:434-451`
- **What**: `appendPersonNote` wraps RMW in `db.transaction().immediate()`. `appendPersonInteraction` does identical select-parse-push-update with no transaction. Capture-pass and orchestrator both fire it on same row concurrently.
- **Bite**: Lost interaction-log entries. Silent.
- **Fix**: Wrap `appendPersonInteraction` in the same immediate-transaction.

### #12 — Coda rank-check is inverted — engaged replies push rank DOWN
- **Where**: `src/tasks/dispatchers/socialPingRankCheck.ts:38-70`
- **What**: For `kind==='coda'`, "engaged" requires `last_social_at > coda_at + 5min`. But `last_social_at` is bumped by `recordSocialMoment` at coda-send; only `note_about_person/self` calls bump it again. A colleague's plain reply doesn't touch `last_social_at`. So engaged=false → -1 rank.
- **Bite**: Every cold-coda silently drifts colleagues toward rank 0 even when they reply warmly. Pings then dry up — directly defeats the v3.0 engagement model.
- **Fix**: Bump `last_social_at` whenever a colleague's inbound message lands (in `appendPersonInteraction` or the inbound message handler), OR compare against `last_seen` / latest inbound interaction timestamp.

### #13 — `recordTopicBeat` doesn't bump parent subject's `last_touched_at` on create path
- **Where**: `src/db/socialSubjects.ts:380-420` + `src/memory/capturePass.ts:907`
- **What**: Beat insert updates only `social_topics.last_used_at`. Match path bumps subject via organic-match score-delta, but CREATE path doesn't fire signals — new subject's clock starts and never moves until the next chat where it's matched.
- **Bite**: New subjects start at score 3 and weekly-decay to dormant within a week, even with substantial first-chat investment.
- **Fix**: In `recordTopicBeat`, after INSERT also `UPDATE social_subjects SET last_touched_at=..., last_touched_by=... WHERE id=@subjectId`. (Plus consider scaling first-chat score by topic_beats count.)

### #14 — v3.0.3 stuck-block detection counts the block's own time as busy
- **Where**: `src/skills/meetings/ops.ts:591`
- **What**: `gaps` is built from `timedMeetings` which **includes the block event itself**. The alt-slot loop then treats the block's current time range as occupied, underreporting available space.
- **Bite**: `analyzeCalendar` over-reports stuck blocks. A 12:30 lunch overlapped by a 12-13:30 meeting flagged "no clean alternative" even with 11:30 and 13:30 free — because the block's own 25 mins gets double-counted. Brief narrates phantom issues.
- **Fix**: Build a local gap list excluding `blockEvent` for the alt-slot scan; treat the block's range as elastic.

### #15 — Night-shift wrap-around silently drops at parseRange; example yaml advertises it
- **Where**: `src/config/userProfile.ts:596-605` + `src/utils/workHours.ts:31-46` + `config/users.example/user.example.yaml:167-173`
- **What**: yaml `night_shift: { hours_start: "22:00", hours_end: "02:00", typical_day: "Tuesday" }` synthesizes "22:00-02:00" into work_hours.Tuesday; parseRange returns null on cross-midnight; range silently dropped. Example yaml promotes exactly this shape.
- **Bite**: First-time users follow example, get silently broken night_shift, no error. Real-world case: any post-Idan owner trying split-shift.
- **Fix**: Split cross-midnight at midnight (22:00-23:59 on day, 00:00-02:00 on next day) OR reject at load with explicit error pointing at #108. Update example yaml comment either way.

---

## HIGH PRIORITY — fix in next patch wave

### #16 — `runApproveCallback` discards `verdict.data` for non-slot_pick approvals
- **Where**: `src/core/requests/resolver.ts:285-340`
- **What**: `approveData` is computed but only used in slot_pick branch + no-callback fallback. For policy_exception/freeform with `verdict='approve', data={slot_iso:'...'}`, the data is silently dropped.
- **Bite**: Owner correction at approve-time is lossy; "approve, but use 13:00" books the original slot.
- **Fix**: Drop `data` from approve verdict in tool schema, OR fold `verdict.data` into `effectiveApprove.args` via `mergeAmendIntoApprove` before runApproveCallback.

### #17 — `pingedTodaySet` uses UTC midnight not owner-local — re-pings same colleague after UTC rollover
- **Where**: `src/tasks/dispatchers/socialOutreachTick.ts:277-285`
- **What**: Companion check sibling to `countAssistantInitiationsTodayForPerson` (which uses ownerTimezone) still uses raw `startOfDayUtc`. 23:00 local → 02:30 local same night → "not pinged today" again.
- **Bite**: Daily per-colleague cap broken in the local-vs-UTC window (e.g. Israel 02:00-05:00 local).
- **Fix**: Compute `startOfLocalDay` from `profile.user.timezone`; mirror the luxon pattern already in `countAssistantInitiationsTodayForPerson`.

### #18 — `note_about_person` / `note_about_self` descriptions promise non-existent subject/cooldown features
- **Where**: `src/skills/social.ts:73-282`
- **What**: Description still says "24h cooldown fires on (topic+subject)… reuse same subject string so counter increments." Handler doesn't write to `social_subjects` / `social_topics` anymore (moved to capture pass v3.0.1).
- **Bite**: Sonnet wastes tokens on imagined cooldown logic; users see repeat-asks because the feature isn't there.
- **Fix**: Trim descriptions to match reality (free-form note + interaction-log + last_social_at bump only).

### #19 — `topic_quality` parameter parsed but never used post-v3.0.1
- **Where**: `src/skills/social.ts:109-119, 150-160, 193, 245`
- **What**: `topic_quality` accepted but only `logger.info`'d; no behavior depends on it.
- **Bite**: Quiet token leak on every note call.
- **Fix**: Drop from schema and handler, OR wire to a real score-delta path.

### #20 — Subject reconciliation can't apply engagement to JUST-CREATED subjects
- **Where**: `src/memory/capturePass.ts:843-921`
- **What**: Only matched subjects get organic-match signal; newly-created subjects start at 3 with no first-chat scaling.
- **Bite**: Strong inaugural conversations produce same score as a passing mention.
- **Fix**: After createSubject, apply +1 organic-match scaled by `topic_beats.length`.

### #21 — Hidden-venue counter swallows `name_hint`-only queries
- **Where**: `src/skills/venue.ts:205-212`
- **What**: `hidden_count` only computed when `hasAreaType`. Case-1 (name_hint alone) misses owner's rank=1/hidden entries; falls into fresh Tavily resolve.
- **Bite**: Owner's "avoid" mark silently ignored; catalog accumulates near-dup.
- **Fix**: For Case-1, second catalog probe with `includeHidden=true`; surface rank-1 hit with hint.

### #22 — Module-scope `getAnthropicClient()` capture in locationResolver
- **Where**: `src/utils/locationResolver.ts:34`
- **What**: `const anthropic = getAnthropicClient();` captured at module load. Breaks the v3.0.0 lazy-per-call invariant for the resolveVenueByName fallback.
- **Bite**: LLM_PROVIDER runtime flip splits brain: Case-1 hot path uses new provider, fallback uses boot-time provider.
- **Fix**: Move call inside `resolveVenueLocation` (lazy per-call).

### #23 — `searchVenueCandidates` ignores `nameQuery` in parse-criteria system prompt
- **Where**: `src/utils/venueSearch.ts:182-189`
- **What**: When called with `nameQuery` but no type/typeTags, Criteria block becomes empty. Sonnet may return unrelated candidate in same area.
- **Bite**: Wrong-branch picks for owner-named venues with no area hint.
- **Fix**: Add explicit `Name to resolve: ${params.nameQuery}` line + a name-disambiguation rule.

### #24 — `findVenuesByCriteria` reads full `name` column but dedup compares normalized head
- **Where**: `src/db/venues.ts:273-286` vs `src/skills/venue.ts:278`
- **What**: Catalog reads use exact-then-startsWith on raw `name`; dedup-on-save uses normalized head. Owner-curated rows become orphaned from owner's searches.
- **Bite**: `name_hint="Landwer"` misses row `"Coffee Landwer, addr, city"`; rank metadata wasted.
- **Fix**: Use `normalizeVenueName` head-only comparison in `findVenuesByCriteria` for nameHint matching.

### #25 — Case-2 venue dedup uses raw `name` → presents same venue twice
- **Where**: `src/skills/venue.ts:276-277`
- **What**: `catalogNames = new Set(catalogHits.map(v => v.name.toLowerCase()))` doesn't normalize. Fresh candidate "Coffee Landwer" vs. catalog "Coffee Landwer, HaShayetet 4..." — set check fails → both shown.
- **Bite**: User sees same physical venue listed twice; Maelle frames as "favorite vs new option" nonsensically.
- **Fix**: Dedup via `normalizeVenueName` head-match.

### #26 — `ambiguity_flag` hardcoded false for Case-1 fresh-resolve
- **Where**: `src/skills/venue.ts:236-243` + `src/utils/venueSearch.ts` `maxResults:1`
- **What**: Tool description promises ambiguity flagging across multiple branches; Case-1 fresh path requests 1 candidate and hardcodes `ambiguity_flag:false`.
- **Bite**: "Coffee Landwer" (4 branches) → Maelle commits the first match into create_meeting without asking.
- **Fix**: `maxResults:3` in resolveVenueByName; set `ambiguity_flag = candidates.length > 1`.

### #27 — `searchVenueCandidates` swallows infra failure as "no match"
- **Where**: `src/utils/venueSearch.ts:166-171, 245-250`
- **What**: Tavily failure and Sonnet JSON-parse failure both return `[]` with `logger.warn`. Indistinguishable from "no candidates."
- **Bite**: Backend outage looks like "couldn't find anything" forever; user re-tries fruitlessly.
- **Fix**: Return discriminated union `{ok:false, reason}` or throw on infra failure.

### #28 — `TZ_TO_COUNTRY` map only has `Asia/Jerusalem` → cloneability broken for non-Israeli owners
- **Where**: `src/utils/venueSearch.ts:258-264`
- **What**: Only one entry. Non-Israeli owners get `country=undefined` → Tavily query lacks country term → cross-country pollution.
- **Bite**: Venue subsystem is functionally Israel-only.
- **Fix**: Expand map (America/*, Europe/London, etc.), OR add `profile.user.country` field.

### #29 — `phone`/`reservation_url`/`address` "owner-curated" guard treats first-Tavily-write as canonical
- **Where**: `src/skills/venue.ts:483-487`
- **What**: `existing.phone ? {} : params.phone !== undefined ? ...` skips when existing non-empty. But "existing" is just prior Tavily — typos stick forever.
- **Bite**: First drift wins permanently; owner can't fix without rank side-effect.
- **Fix**: Add real "manually edited" signal (e.g. `manually_edited_at` column or rank=3=favorite), OR always prefer freshest non-empty.

### #30 — Override branch of `book_floating_block` books off-grid start_time without quarter-alignment
- **Where**: `src/skills/calendarHealth.ts:1499`
- **What**: Override branch (`confirm_outside_window=true`) parses `start_time` directly, books at exact minute. Tool description promises quarter-snap; code doesn't.
- **Bite**: Owner DM "book lunch at 14:13" with override → event at 14:13-14:38. Breaks quarter-alignment invariant Sonnet relies on.
- **Fix**: Snap via `alignUpQuarter` (or `alignDownQuarter`) before computing `overrideEnd`.

### #31 — `book_floating_block` initial-call ignores `block.prefer_position` yaml default
- **Where**: `src/utils/floatingBlocks.ts:48-54` (interface doc) + `src/skills/calendarHealth.ts:1698` (handler)
- **What**: Interface doc claims yaml `prefer_position` applies to initial book; handler falls through to hardcoded `'earliest'`. Only rebalance honors it.
- **Bite**: Owner sets `prefer_position: 'latest_in_window'` in yaml for lunch; active-mode auto-book lands at earliest; rebalance never gets a chance to fix it.
- **Fix**: Default chain in handler: `args.prefer_position ?? block.prefer_position ?? 'earliest'`.

### #32 — Calendar-health busy-day "missing_floating_block" uses bounding box across split-shift
- **Where**: `src/skills/calendarHealth.ts:463-471`
- **What**: `dayHoursStart`/`dayHoursEnd` = first/last window. Split-shift `09:00-15:30 + 21:30-23:59` collapses to `09:00-23:59`. Events in the 15:30-21:30 gap pass the "entirely outside work-hours" exclusion.
- **Bite**: Events in inter-window gap generate spurious overlap/missing-block flags on split-shift days.
- **Fix**: Replace exclusion 4 with per-window check — drop event only when outside ALL windows.

### #33 — `getBriefingHourMin` picks earliest start across ALL days globally
- **Where**: `src/tasks/briefs.ts:638-658`
- **What**: Owner with Tuesday `["21:30-23:59"]` and Wednesday `["09:00-17:30"]` gets brief fire-time global-min = 09:00 — wrong for Tuesday's late-shift, wrong for an owner whose only late shift is Tuesday.
- **Bite**: Brief default fires before owner-at-work most days, or after window opens on late-shift days. Owner can override via preference, but default is noisy.
- **Fix**: Compute per-day brief times (requires cron-per-day, possibly larger scope), OR change default to "earliest start that appears on ≥half of work days."

### #34 — `move_meeting` owner-path floating-block branch skips planMeeting
- **Where**: `src/skills/meetings/ops.ts:2791-2837`
- **What**: When `isOwnerPath && (inWindow || overrideOk)`, calls `updateMeeting` directly. No category re-detect on day-type flip, no `resolveLocation` re-stamp, no Teams URL patch.
- **Bite**: Block moved home-day-morning → office-day-evening keeps its old home-day location even though resolveLocation would skip_stamp on new day.
- **Fix**: After inline updateMeeting on this path, fire planMeeting with intent='move' to get correct location/category and PATCH again — OR funnel into `planMove`.

### #35 — `coordinate_meeting` searchTo defaults to `now.endOf('week')` even when search_from is later
- **Where**: `src/skills/meetings.ts:1008-1011`
- **What**: If Sonnet passes `search_from='2026-06-01'` (3 weeks out) without `search_to`, default `now.endOf('week')` is BEFORE search_from → inverted window.
- **Bite**: Coord spins on inverted windows or returns zero slots; Sonnet narrates "couldn't find any."
- **Fix**: Default `searchEndDate = max(now.endOf('week'), searchFromDate.plus({days:7}))` or anchor to `searchFromDate.endOf('week')`.

---

## MEDIUM PRIORITY — opportunistic

### #36 — `detectCategory` dead `hasOwner` ternary + double-count risk on autoCategorize path
- **Where**: `src/skills/meetings/detectCategory.ts:65-74`
- **What**: Both branches of `allAttendees = hasOwner ? [...] : [...]` produce identical output. Owner injected unconditionally. From autoCategorize.ts (owner not pre-injected), if owner email appears in input emails, attendeeCount double-counts.
- **Bite**: Categories with `attendee_count ≥ N` thresholds trip one slot early.
- **Fix**: Compute `attendeeCount` from deduped set; kill the dead ternary.

### #37 — `find_available_slots` lacks `is_floating_block_search` arg
- **Where**: `src/skills/meetings.ts:300-381`
- **What**: Schema doesn't expose `is_floating_block`. Sonnet can't query "where could I move lunch?" inside its own window — slot finder rejects floating-block-window candidates as "floating_block_no_room."
- **Bite**: Owner: "options for lunch tomorrow?" → 0 slots returned → Sonnet narrates "no room" though lunch window was the very thing asked about.
- **Fix**: Add `is_floating_block_search: boolean` to schema; route through relaxed flag.

### #38 — `mergeAmendIntoApprove` blind-spreads counter keys (unknown args land on tool calls)
- **Where**: `src/core/approvals/approvalCallbacks.ts:128-148`
- **What**: For move_meeting, maps `slot_iso → new_start`, then spreads remaining counter keys onto args. Unknown keys like `duration_min`, `end` land literally on args — most tools ignore them, but `duration_min` on create_meeting is silently dropped (create_meeting reads `end`).
- **Bite**: Sonnet's amend counter with `duration_min` override is silently lost.
- **Fix**: Per-tool counter-key translation (duration_min → end derived from start), or document explicit counter keys per tool.

### #39 — `coord_jobs` legacy cascade comment claims Path 2 is current → confusing
- **Where**: `src/core/requests/closeRequest.ts:89-99`
- **What**: Cascade code still writes `coord_jobs.status='abandoned'` and `outreach_jobs.status='cancelled'`. Path 2 is half-done per v3.0.4. Comment doesn't reflect transitional state.
- **Bite**: Confuses readers; future maintainer assumes legacy machine is fully retired.
- **Fix**: Update comment with v3.0.4 transitional note + planned Path 2 stages 2-6.

### #40 — `getActiveSubjectsForPersonCategory` SQL sort disagrees with TS picker sort
- **Where**: `src/db/socialSubjects.ts:257-264` + `src/core/social/stateMachine.ts:191-229`
- **What**: SQL orders by `engagement_score DESC, last_touched_at DESC`; TS picker re-sorts by `last_assistant_initiated_at ASC`. TS wins today; if anyone drops TS resort, picker flips to "most recently touched first" silently.
- **Bite**: Latent — works now, breaks on future refactor.
- **Fix**: Align SQL order to `engagement_score DESC, last_assistant_initiated_at ASC NULLS FIRST` OR drop SQL ORDER BY.

### #41 — `update_person_profile.colleague_slack_id` description references `find_slack_user` tool that may not be in scope
- **Where**: `src/core/assistant.ts:117, 222, 258, 685`
- **What**: Module G scoping can leave `find_slack_user` out of the active tool list this turn. Description tells Sonnet to "call it first" anyway. Sonnet omits the field; resolveSlackId looks up by name — opens P-2 vector.
- **Bite**: Tool description points at sometimes-missing tool, training Sonnet into a code path with privilege risk.
- **Fix**: Always include `find_slack_user` when any of these tools are in scope, OR rephrase: "omit field if you don't have the ID; system will look it up by name."

### #42 — `confirm_gender` provenance comment stale
- **Where**: `src/core/assistant.ts:593-595`
- **What**: Comment says colleague-path is "restricted to colleague_slack_id === context.userId (self-confirm only)" — but v2.9.3 changed restriction into silent rewrite. Misleading comment.
- **Bite**: Future reader assumes hard gate; doesn't notice the omit-field bypass (P-2).
- **Fix**: Update comment to "colleague-path is silently rewritten to self via the guard above."

### #43 — `assistantSelf` hardcoded `gender: 'female'` in seed
- **Where**: `src/core/assistantSelf.ts:46-48`
- **What**: SELF row seeded with `gender: 'female'` because "Maelle reads as female." Multi-tenant deployments with different assistant names inherit it.
- **Bite**: Wrong Hebrew gendered forms for non-Maelle assistants.
- **Fix**: Read from `profile.assistant.gender` with sensible default if absent.

### #44 — `BookingRequest.buildContext` computes two dead fields per call
- **Where**: `src/skills/meetings/bookingRequest.ts:402-449`
- **What**: `recentBlockDeletes` (audit_log query) and `ownerProposedThisSlotInMpim` (text scan) computed on every booking; neither read by any consumer. MPIM check is re-computed inline at `ops.ts:1608`.
- **Bite**: Wasted DB + O(history) scan per create_meeting/move_meeting.
- **Fix**: Either wire consumers (calendarHealth.ts:352 has its own duplicate `recentBlockDeletes` that could share) or delete.

### #45 — `dayHoursEnd` formatter yields `"24:00"` when work_hours normalize to 1440
- **Where**: `src/skills/calendarHealth.ts:467-471`
- **What**: After v3.0.0 `parseRange` normalizes `23:59 → endMin=1440`, formatter builds `"24:00"`. Luxon parses to next-day 00:00. Bounding-box for overlap-exclusion 4 extends past midnight by 1 minute.
- **Bite**: Cosmetic now, latent for future midnight-boundary code.
- **Fix**: Clamp `1440 → "23:59"` for display purposes.

### #46 — `formatHours` shows `21:30-24:00` in HARD RULES prompt block
- **Where**: `src/skills/meetings.ts:1773-1781`
- **What**: Same root as #45. Sonnet sees `"24:00"` in HARD RULES block; narration becomes "working till 24:00."
- **Bite**: Visible token leakage, awkward colleague-facing phrasing.
- **Fix**: Render 1440 as `"23:59"`.

### #47 — `night_shift` dynamic-prompt block claims window is "already merged" even when parseRange dropped it
- **Where**: `src/skills/meetings.ts:1903-1911`
- **What**: For owners whose night_shift wraps midnight (#15 case), prompt advertises a window that doesn't exist in synthesized work_hours.
- **Bite**: Sonnet proposes 22:00–02:00 slots Tuesday → slot finder rejects → Sonnet fabricates explanation.
- **Fix**: Emit line only when synthesized work_hours actually contains the night_shift range.

### #48 — `relaxed` JSDoc claims widen-to-07-22 but flag doesn't widen
- **Where**: `src/connectors/graph/calendar.ts:516-518`
- **What**: JSDoc: "widens to 07-22 (same as extendedHours)". In fact widening lives in caller — meetings.ts:1038,1060 pass `workHoursStart/End='07:00'/'22:00'`; colleague-recovery path (1123) doesn't. Flag itself only UNIONS with caller-supplied default 09:00-18:00 when no widening params.
- **Bite**: Maintainer reads JSDoc, believes flag auto-widens, doesn't pass widening params, silently wrong.
- **Fix**: Update JSDoc to say widening requires explicit `workHoursStart/End` params.

---

## DEAD CODE

### #49 — Legacy `db/approvals.ts createApproval` ~500 LOC orphan
- **Where**: `src/db/approvals.ts:95-299`
- **What**: Grep finds no live caller. Bridge bridges to requests-spine but no path writes here. Includes dead `approval_expiry` + `approval_reminder` task scheduling (#50).
- **Fix**: Verify no live caller, delete the function + `setApprovalDecision` + `supersedeApproval` + `sweepExpiredApprovals` + `cancelApprovalsForTask` if also dead. ~500 LOC removal.

### #50 — `createApproval` inserts `approval_expiry`/`approval_reminder` tasks no dispatcher handles
- **Where**: `src/db/approvals.ts:228-289`
- **What**: v3.0.0 removed those dispatchers. If anything ever calls `createApproval`, zombie task rows persist forever. Subsumed by #49.

### #51 — Stale doc references to deleted `src/db/socialTopics.ts`
- **Where**: `src/db/people.ts:708` (and possibly index.ts)
- **What**: Comment names `src/db/socialTopics.ts` which doesn't exist; helpers live in `src/db/socialSubjects.ts`.
- **Fix**: Search-and-replace `socialTopics.ts` → `socialSubjects.ts`.

### #52 — Dead `LegacySocialDirectiveShape` alias + `topicId`/`topicLabel` mirrors
- **Where**: `src/core/social/stateMachine.ts:45-69`
- **What**: Directive shape returns both `subjectId/Label/text` and `topicId/Label/topic` (legacy mirror). Orchestrator uses `subjectId`. Mirror is dead weight.
- **Fix**: Grep `topicId|topicLabel` for consumers; if none, drop mirror + alias.

### #53 — `void adjustEngagementRank` import-retention hack
- **Where**: `src/tasks/dispatchers/socialOutreachTick.ts:607`
- **What**: `void adjustEngagementRank; // keep import in scope for future` — TODO masquerading as code.
- **Fix**: Either ship the proactive-initiated signal or drop import + comment.

### #54 — `dismiss_calendar_issue` still in cacheable-tools list
- **Where**: `src/utils/toolCallCache.ts:65`
- **What**: Tool was dropped; entry is dead.
- **Fix**: Remove from list.

### #55 — `engagement_level` migration runs on every boot
- **Where**: `src/core/background.ts:127-135` + `src/db/engagementRank.ts:139-167` + `src/db/people.ts:27` (legacy `engagement_level?:` type still on PersonMemory)
- **What**: v3.0.0 dropped the field but migration still fires + type still optional.
- **Fix**: Decide whether migration is complete in prod; if yes, delete migration + type.

### #56 — Unused imports in `assistant.ts`
- **Where**: `src/core/assistant.ts:4`
- **What**: `recordSocialMoment`, `appendPersonNote`, `SocialTopicQuality` imported but no longer used (moved to social.ts).
- **Fix**: Trim import list.

### #57 — Dead `isInternal` variable in coord booking
- **Where**: `src/skills/meetings/coord/booking.ts:157`
- **What**: Computed but never referenced; fallback branch recomputes `hasExternal` inline.
- **Fix**: Delete line 157.

### #58 — Comments referencing deleted `core/approvals/resolver.ts`
- **Where**: `src/core/approvals/coordBookingHandler.ts:5`, `src/skills/meetings/coord/booking.ts:621`, `src/core/requests/resolver.ts:2`
- **What**: Three headers cite the deleted file as a live caller.
- **Fix**: Search-and-replace `core/approvals/resolver.ts` → `core/requests/resolver.ts`.

---

## CONFIG LEAKS

### #59 — `Idan` literal in 4 Sonnet-facing tool descriptions
- **Where**: `src/core/assistant.ts:308, 316`, `src/skills/meetings.ts:146, 150`
- **What**: Owner's first name used as example in `description:` strings Sonnet reads.
- **Fix**: Rename to generic ("Anna", "owner's first name").

### #60 — `@reflectiz.com` email examples in comments
- **Where**: `src/utils/securityGate.ts:251`, `src/utils/threadAttendees.ts:12`
- **What**: `yael.h@reflectiz.com`, `shayan.m@reflectiz.com` as comment examples.
- **Fix**: Swap for `@example.com`.

### #61 — `category_id` `cat_global_*` raw IDs surfaced to Sonnet
- **Where**: `src/tasks/dispatchers/socialOutreachTick.ts:354`
- **What**: `generatePing` exposes raw `category_id` like `cat_global_gaming` to Sonnet instead of human label.
- **Bite**: Cold-pings may leak the raw key as a "topic name."
- **Fix**: Strip `cat_global_` prefix or look up label via `getCategoryById`.

---

## BAD TOOL DESCRIPTIONS

### #62 — `resolve_approval` description doesn't say `data.slot_iso` is dropped on approve for non-slot_pick
- **Where**: `src/tasks/skill.ts:181-200`
- **What**: Description implies `data` is honored for any approval. Only slot_pick reads it. (Related to #16.)
- **Fix**: Clarify: data is meaningful ONLY for slot_pick; otherwise use verdict='amend' + counter.

### #63 — `find_venue` `type='office'` enum value ambiguous
- **Where**: `src/skills/venue.ts:103`
- **What**: `'office'` means customer office, but `isCompanyLocation` (`db/venues.ts:333`) prevents office-labeled locations from being saved. No signal in description.
- **Fix**: Either remove `'office'` from enum (rare case anyway), OR rename to `'customer_office'`.

### #64 — `book_floating_block` description promises buffer on abut_*
- **Where**: `src/skills/calendarHealth.ts:192-193`
- **What**: "(with buffer)" promises in abut_before / abut_after bullets — v3.0.2 removed buffer.
- **Fix**: Strip "(with buffer)"; add "directly abuts the anchor (no buffer)."

### #65 — `outreach.ts` description references `(slack_id: XXXXX)` injection format
- **Where**: `src/skills/outreach.ts:63`
- **What**: Need to confirm message-mention injection format actually still matches. If drifted, Sonnet misreads and burns round-trips.
- **Fix**: Verify against `connectors/slack/app.ts` producer; align.

---

## STALE COMMENTS

### #66 — `findPositionalSlotForBlock` docstring still describes removed buffer math
- **Where**: `src/utils/floatingBlocks.ts:306-308`
- **What**: Doc says "abut_* applies buffer... lands at 12:15-12:40 not 12:20-12:45." v3.0.2 removed buffer — current behavior IS the "wrong" 12:20-12:45.
- **Fix**: Rewrite to "abut_* abuts the anchor directly; no buffer (v3.0.2)."

### #67 — `findAlignedSlotForBlock` doc references removed `bufferMinutes` param
- **Where**: `src/utils/floatingBlocks.ts:151-162`
- **What**: Doc block describes "bufferMinutes padding" — param gone in v3.0.2; v3.0.2 rationale comment below contradicts it.
- **Fix**: Delete or rewrite the pre-v3.0.2 doc.

### #68 — `stateMachine.ts` header claims it takes "reconciled subject"
- **Where**: `src/core/social/stateMachine.ts:1-10`
- **What**: Module header references pre-v3.0.1 subject-aware shape; state machine no longer takes `reconciled`.
- **Fix**: Update to "Takes the classifier output + per-person picker state... subject decisions land at end-of-chat."

### #69 — `recordSocialMoment` JSDoc lists removed params
- **Where**: `src/db/people.ts:453-485`
- **What**: JSDoc lists `@param topic`, `@param quality`, `@param subject` — none exist in current signature `(slackId, initiatedBy)`.
- **Fix**: Update JSDoc.

### #70 — `db/people.ts` inline comment on recordSocialMoment references old design
- **Where**: `src/db/people.ts:471-472`
- **What**: Comment says topic tracking lives in social_subjects/social_topics — correct, but doesn't acknowledge end-of-chat reconciliation is the only writer now.
- **Fix**: Add "Subject + topic-beat writes happen ONLY at end-of-chat (capturePass.runSubjectReconciliation)."

### #71 — `scheduleRules.ts` rule-5 comment names retired `hours_start`/`hours_end`
- **Where**: `src/utils/scheduleRules.ts:18`
- **What**: Says "outside_working_hours — slot starts before hours_start or ends after hours_end." Legacy fields stripped at load.
- **Fix**: Update to multi-window phrasing.

### #72 — `nextOwnerWorkdayStart` comment same drift
- **Where**: `src/utils/workHours.ts:240-241`
- **What**: Docstring says "picks the relevant hours_start." Code iterates `windows`.
- **Fix**: Update to "earliest still-future window start across multi-window days."

### #73 — `securityGate.ts` v3.0.4 narrative outdated (code is v3.0.5)
- **Where**: `src/utils/securityGate.ts:61-77`, `CHANGELOG.md:11-17`, MEMORY.md headline
- **What**: Task brief and CHANGELOG describe v3.0.4 regex-based identity-spoof guard. Code in tree is v3.0.5 — Haiku-based, regex on natural language REMOVED, only structured email-mismatch trigger remains.
- **Bite**: Operators read changelog/memory and assume regex stop-list is live. "I'm not Yael, I'm Yossi" with no email reference passes the gate now.
- **Fix**: Add v3.0.5 CHANGELOG entry; update memory headline.

### #74 — `assistant.ts:344-349` allowlist comment misses new fields
- **Where**: `src/core/assistant.ts:344-349`
- **What**: Comment lists what's dropped on colleague-self path; allowlist (line 435-439) defines what's kept. Future field additions (e.g. new enum) will fall on colleague-self by default.
- **Fix**: Add reminder note in schema definition.

### #75 — `closeRequest.ts:89-99` Path 2 transitional comment
- **Where**: `src/core/requests/closeRequest.ts:89-99`
- **What**: Comment claims legacy bridge active without noting v3.0.4 Path 2 partial state.
- **Fix**: Add transitional state note.

### #76 — `db/approvals.ts` top doc-block describes dead createApproval
- **Where**: `src/db/approvals.ts:1-12`
- **What**: Block explains "the design" attached to dead code (#49). Reader may try to extend it.
- **Fix**: Move/delete with #49.

### #77 — `app.ts:859` orphan "// removed: …inside" comment
- **Where**: `src/connectors/slack/app.ts:859`
- **What**: Trailing fragment without what replaced it.
- **Fix**: Complete or delete.

### #78 — Tombstone comments older than 6 versions
- **Where**: `src/skills/meetings/coord/booking.ts:35` (and ~30 more)
- **What**: `// determineSlotLocation removed v2.7.0 — replaced by resolveLocation below.` Many similar v2.0.6 / v2.2.4 / v2.2.5 breadcrumbs throughout.
- **Fix**: Sweep tombstone comments older than 6 versions during next nearby edit.

### #79 — `v1.x`/`v2.x` version markers everywhere (~100 hits)
- **Where**: `src/config/userProfile.ts`, `src/skills/calendarHealth.ts`, `src/skills/types.ts`, etc.
- **What**: Schema fields dated with "added at vX" markers. Now at v3.0.4. Some legit (back-compat); many pure archaeology.
- **Fix**: Don't sweep wholesale; next time touching a block, prune the pure "added at vX" markers; keep "WHY" comments.

---

## TYPESCRIPT HOLES (advisory)

### #80 — `skills/meetings.ts` participant handling: 30+ `as any` casts
- **Where**: `src/skills/meetings.ts:557-984`
- **What**: Coord-arg normalization typed `any` end-to-end. Most participant-routing bugs root-cause here.
- **Fix**: Define `CoordArgsRaw`/`CoordParticipantRaw` types; replace `as any` cluster.

### #81 — `core/requests/resolver.ts` runtime `require()` of deferredActionReplay
- **Where**: `src/core/requests/resolver.ts:146-147, 398-399`
- **What**: Pattern repeats twice — likely circular-import workaround. Errors only at first owner-approval needing replay.
- **Fix**: Confirm cycle + add eslint-disable with cycle name, OR convert to top-level import.

### #82 — `general.ts` Tavily/Brave/DDG responses typed `any`
- **Where**: `src/skills/general.ts:174,179,201,202,218,225,256`
- **What**: All adapters `await res.json() as any`. Provider shape change → silent empty array.
- **Fix**: Add `WebSearchResult` shape + per-provider parsers.

### #83 — `voice/fileTranscribe.ts:21` `as unknown as string` lies about whisper shape
- **Where**: `src/voice/fileTranscribe.ts:21`
- **What**: Cast bypasses real type. If whisper ever returns `{text:'...'}`, `.trim()` throws.
- **Fix**: Type to actual SDK return.

---

## Wrap criteria

This handoff is a propose-only list. Owner picks waves. After each wave, run:
```
npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json
```
(NOT `npm run typecheck` from a worktree — it checks stale source.)

Bundle at the end via the `wrap` skill. Default version bump is PATCH per session rules.

---

**Audit complete. 83 atomic findings, 0 fixes applied.**
