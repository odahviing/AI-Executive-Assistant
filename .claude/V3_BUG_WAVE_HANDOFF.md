# V3 BUG WAVE — HANDOFF FOR NEW CHAT SESSION

**Purpose of this document**: hand off a 76-atomic-bug audit + a few owner-supplied additions to a fresh chat session, clean them all, then wrap to v3.0. The audit was done overnight in the prior chat — paper-traces and citations are in this file so no re-research is needed.

---

## 1. Mission

Maelle is at **v2.9.4** with four follow-up commits today (typing indicator fix, gate kill, rebalance sweep, orchestrator text-capture). The 2.9 line is feature-complete; we're closing a v2.9.4 → v3.0 release window with a clean bug-wave. After this wave + a few additional bugs the owner has noted, **wrap to v3.0** (minor bump justified by the cleanup volume + new bigger surface — capture pass, BookingRequest normalizer, approval rebuild, multi-window work_hours all stabilized through the 2.9 line).

---

## 2. Critical operational context (READ FIRST)

### Environment
- **Repo root**: `E:\Code\Maelle` (master branch — where `npm run dev` runs)
- **Worktree path**: `E:\Code\Maelle\.claude\worktrees\youthful-burnell-4a047d` (branch `claude/youthful-burnell-4a047d`)
- **YOU MUST WORK IN THE WORKTREE** — owner ran into a pattern earlier where edits using absolute master paths accidentally landed on master. Always use worktree absolute paths for Edit/Write/Read.
- Typecheck command: `npx tsc --noEmit -p E:/Code/Maelle/.claude/worktrees/youthful-burnell-4a047d/tsconfig.json`
- To deploy: `git -C E:/Code/Maelle merge --ff-only claude/youthful-burnell-4a047d && git -C E:/Code/Maelle push origin master`
- Owner runs `npm run dev` directly. Restart needed for changes (ts-node-dev `--respawn` is unreliable on Windows).

### How to operate this wave
- **Propose-first, never auto-fix.** Each bug or wave needs explicit build signal from owner ("fix N", "do wave 1", "build that"). Build signals are per-bug/per-wave specific. "OK" / "yes" / "go ahead" are NOT build signals on their own.
- **No version bumps** during the wave. Each commit can land normally; owner says "wrap" or "ship v3" at the end. The wrap is the only moment we touch `package.json` + CHANGELOG.
- **Owner direction is constant**: code-over-prompt, tooling-over-new-tools, prompt-shorter, code-more-deterministic, no new tools without explicit ask. Multiple bugs in this audit have prompt-side AND code-side fix options — when ambiguous, propose the code-side first.
- **Group bugs into waves** per the order at the bottom. Don't bundle waves without owner saying so.
- **After each wave**: typecheck, commit on worktree, fast-forward master, push, summarize tree. Owner restarts `npm run dev` and confirms before next wave.

### Read at session start
- `E:/Code/Maelle/.claude/SESSION_STARTER.md` — always-read project context
- `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_overview.md` — auto-memory (may be stale at v2.8.2 leader; ignore the version leader, read the latest section)
- `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_architecture.md` — four-layer model, skills, connections, security layers
- This file (you're reading it)

---

## 3. The 76 atomic bugs

Numbered 1–76. Each: short title, file:line, what, bite (production impact), fix direction. Numbering is stable — owner will reference by number.

### TOP PRIORITY (10 items)

#### 1. Colleague can write to owner's preference catalog via `manage_preference`
- **Where**: `src/core/assistant.ts:357`
- **What**: `ownerOnlyTools = ['learn_preference', 'forget_preference', 'recall_preferences', ...]`. These three names were merged into `manage_preference` in v2.9; the new name is NOT in the hard-block list. `manage_preference` handler reads `userId = context.profile.user.slack_user_id` (owner's id) regardless of who called it.
- **Bite**: Privilege escalation — any colleague can write to owner's preference catalog.
- **Fix**: Replace the three legacy names with `'manage_preference'`.

#### 2. `note_about_person` colleague-path target rewrite is dead code
- **Where**: `src/core/assistant.ts:376-384` + `src/skills/social.ts:174`
- **What**: AssistantSkill's rewrite reassigns a local `args` variable. Handler lives in SocialSkill. Registry dispatches with original args reference. Reassignment never reaches the handler.
- **Bite**: v2.9.2 gossip/impersonation surface is wide open. Colleague notes about other people land on wrong row.
- **Fix**: Move rewrite into `SocialSkill.executeToolCall` at top of `case 'note_about_person'`, OR mutate args in place (`(args as any).colleague_slack_id = context.userId`) instead of reassigning.

#### 3. UNIQUE-key collision lookup misses CLOSED rows → re-throws to Sonnet
- **Where**: `src/tasks/skill.ts:716-727` + `src/db/requests.ts:137-142`
- **What**: `getRequestByIdempotencyKey` filters out `state IN ('resolved','cancelled','expired')`. Schema has `idempotency_key TEXT UNIQUE` globally. Re-asks after closure → INSERT collides → recovery lookup returns null → re-throws SqliteError.
- **Bite**: Same colleague asks twice across days with same subject = Sonnet sees error, goes silent. v2.9.4 #106 fix only covers still-open collisions.
- **Fix**: Either drop state filter from recovery lookup, OR make UNIQUE partial via `WHERE state IN ('awaiting_owner','awaiting_colleague','in_flight')`.

#### 4. `update_meeting` attendee-shape change never re-stamps location
- **Where**: `src/skills/meetings/ops.ts:2454-2468`
- **What**: When attendee shape changes (internal-only → has-external) but time doesn't, calls `resolveLocation({ intent: 'move', priorStartIso: existing.startIso })`. resolveLocation hits `intent='move' + day-type unchanged + no owner hint` → `preserve_existing`. Location never re-stamped.
- **Bite**: Owner adds external attendee to internal-only Huddle home-day meeting → external shows up to "Huddle" with no Teams link. Hybrid leak.
- **Fix**: For attendee-shape re-eval, pass `intent: 'new_booking'` (or omit `priorStartIso`).

#### 5. Owner-in-MPIM auto-relax broken by BookingRequest normalizer
- **Where**: `src/skills/meetings/ops.ts:1558-1579` + `src/skills/meetings/bookingRequest.ts:336-380`
- **What**: Handler pre-stamps `args.relaxed = true` for owner-in-MPIM. Normalizer's `gateRelaxed` checks `rawRelaxed = args.relaxed === true`; MPIM branch has `!rawRelaxed` guard, so doesn't re-apply; falls through to `relaxed: false`. Net: handler's pre-stamp gets DROPPED.
- **Bite**: Mayrav 22:30 class regresses — owner-in-MPIM proposes a time → flagged as rule_violation → owner gets approval he just proposed himself.
- **Fix**: Move MPIM check into normalizer's `gateRelaxed` (drop the `!rawRelaxed` guard for that branch), OR pass via `NormalizeOptions`.

#### 6. `runApproveCallback` closes BEFORE replay fires
- **Where**: `src/core/requests/resolver.ts:374-405`
- **What**: `closeRequest(state='resolved')` runs synchronously, then `setImmediate(runDeferredAction)` fires booking async. If Graph throws, catch only logs "owner may need to retry manually". Meanwhile relay said "Booking incoming."
- **Bite**: One transient Graph failure = silent gap. Relay says "Calendar invite incoming" but no invite comes.
- **Fix**: Either run replay synchronously then close on success (pattern used by `resolveSlotPickApproval`), OR on replay failure post recovery DM to owner + flip state back to `awaiting_owner`.

#### 7. Requester relay fires unconditionally even when replay didn't run
- **Where**: `src/core/requests/resolver.ts:354, 407`
- **What**: `notifyRequesterOfDecision(row, 'approve', ...)` called even when on_approve tool isn't in `RESOLVER_REPLAY_TOOLS` AND when async dispatch failed.
- **Bite**: Compounds #6. Requester always hears "Idan said yes" regardless of whether anything booked.
- **Fix**: Make relay conditional on replay actually succeeding, OR defer relay (send from inside runDeferredAction on success).

#### 8. `relaxed`/`extendedHours` collapses multi-window work_hours
- **Where**: `src/connectors/graph/calendar.ts:873-878`
- **What**: When `relaxed`/`extendedHours` is true, `getWorkHoursForDay()` short-circuits to single `[defaultStartHour, defaultEndHour]`. Multi-window map ignored. On night-shift Tuesday (`["09:00-15:30","21:30-23:59"]`), 22:30 candidate rejected.
- **Bite**: Owner override HIDES the legitimate night-shift window — opposite of intent.
- **Fix**: When relaxed/extendedHours is on, UNION widened default window with day's native `getOwnerWorkHoursForDay`.

#### 9. `parseRange` silently drops midnight-spanning yaml entries
- **Where**: `src/utils/workHours.ts:31-38`
- **What**: Returns null when `endMin <= startMin`. Yaml `Tuesday: ["22:00-02:00"]` parses to null, gets filtered out → Tuesday becomes non-workday. No log, no error.
- **Bite**: Owner hand-edits → Tuesday silently becomes non-workday across slot finder, brief, dispatchers, expiry math.
- **Fix**: Reject cross-midnight at zod-time with clear error, OR split at midnight on parse.

#### 10. `note_about_person/self` tool descriptions promise a counter that doesn't exist
- **Where**: `src/skills/social.ts:107, 151` + `src/db/people.ts:489-513`
- **What**: Tools call `recordSocialMoment(slackId, topic, quality, initiatedBy, subject)`. Since v2.2, function IGNORES `_topic`, `_quality`, `_subject` args. No insert into `social_subjects`/`social_topics` from tool path. 24h `(topic+subject)` cooldown described in tool is fiction.
- **Bite**: Sonnet follows "reuse subject string so counter increments" — but no counter exists. Duplicate timeline entries.
- **Fix**: Either route subject/topic through `reconcileSubject`/`createSubject`+`recordTopicBeat`, OR drop the cooldown/counter language from descriptions.

### HIGH PRIORITY (18 items)

#### 11. `confirm_outside_window` flag conflated with floating-block intent
- **Where**: `src/skills/meetings/bookingRequest.ts:178-180`
- **What**: `isFloatingBlock` set true when `confirm_outside_window` set — but that flag is also valid on regular `move_meeting`. Regular move with flag ends up tagged floating-block → bypasses rule 8 `owner_busy_collision`.
- **Bite**: Owner approves rule_violation → replay with `relaxed=true` → `confirm_outside_window` may ride along → double-book lands silently.
- **Fix**: Only treat as floating block when `args.is_floating_block` is real object with `name`.

#### 12. `bookCoordination` move conflict scan doesn't exclude moving event
- **Where**: `src/skills/meetings/coord/booking.ts:295-303`
- **What**: For `intent==='move'`, source event still on calendar at booking time. New slot overlapping old → flags source as conflict → fake `calendar_conflict` approval.
- **Bite**: Coord-driven moves where new slot overlaps old (shift-by-15min) bounce to phantom approval.
- **Fix**: Add `ev.id !== job.existing_event_id` to filter when isMove.

#### 13. Recurring delete: `decline_and_relay` DM fires BEFORE seriesMaster refusal
- **Where**: `src/skills/meetings/ops.ts:3135-3168` vs `:3189-3207`
- **What**: planMeeting returns `decline_and_relay`, fires setImmediate DM to organizer, THEN seriesMaster guard refuses delete. Organizer was told "Idan won't make it" for nothing.
- **Bite**: Owner asks to cancel a recurring; organizer gets "won't make it" DM, meeting stays on calendar.
- **Fix**: Move seriesMaster probe BEFORE decline_and_relay setImmediate dispatch.

#### 14. `forceBookCoordinationByOwner` creates two pending approvals
- **Where**: `src/skills/meetings/coord/booking.ts:88-108, 329-345`
- **What**: Force-book updates status `waiting_owner`, calls `bookCoordination` which checks `notesObj.needsDurationApproval` and emits SECOND approval if set → returns without booking.
- **Bite**: Approval ping-pong; owner sees two approvals for same coord.
- **Fix**: Clear `needsDurationApproval` on force-book, OR add `skipGates` option to `bookCoordination`.

#### 15. `move_meeting` colleague-path label map missing `owner_busy_collision`
- **Where**: `src/skills/meetings/ops.ts:2587-2601`
- **What**: Label map lacks canonical reason `owner_busy_collision`. create_meeting Guard B (`:1686-1700`) has it.
- **Bite**: Colleague-requested move into double-booked slot → approval ask_text says "couldn't tell which rule fired" instead of "conflicts with another meeting."
- **Fix**: Add `owner_busy_collision` to move_meeting label map, or factor `ruleLabelFor` helper.

#### 16. Capture pass races Sonnet's in-turn `note_about_self` writes
- **Where**: `src/memory/capturePass.ts:506-575` + `src/skills/social.ts:212-282`
- **What**: `appendPersonNote` does read-modify-write without transaction. Capture pass + active chat can interleave.
- **Bite**: Lost note writes when capture fires while chat is going.
- **Fix**: Wrap `appendPersonNote` in `BEGIN IMMEDIATE; SELECT; UPDATE; COMMIT`.

#### 17. Standalone slot_pick approval (no coord) never DMs requester
- **Where**: `src/core/requests/resolver.ts:598`
- **What**: `notifyRequesterOfDecision` early-returns on `kind==='approval' && subkind==='slot_pick'`. Slot_pick raised STANDALONE (no coord_job_id) gets booked silently.
- **Bite**: Requester dangling without acknowledgment.
- **Fix**: Skip relay only when `kind==='coord'`, OR check `coord_job_id` presence.

#### 18. Colleague approves owner's counter → relay says "Idan said yes" (wrong actor)
- **Where**: `src/core/requests/resolver.ts:407, 685-696`
- **What**: When `wasAwaitingColleague=true` + verdict='approve', body says "Hey Yael — Idan said yes" — but the COLLEAGUE just hit approve on owner's counter.
- **Bite**: Confusing — Yael accepts counter, gets DM crediting Idan.
- **Fix**: Branch on `wasAwaitingColleague` → "Locked in — booking [subject] for [time]" instead of "Idan said yes."

#### 19. `directiveForProactiveSlot` doesn't honor `engagement_rank=0`
- **Where**: `src/core/social/stateMachine.ts:146-212`
- **What**: Reads cooldowns/counts but never reads engagement_rank. Same function called for in-conversation "other + open" turns.
- **Bite**: Rank-0 (do-not-engage) contract violated on every inbound. Maelle pushed to initiate small talk with opt-out person.
- **Fix**: `if (getEngagementRank(personSlackId) === 0) return noDirective();` at top.

#### 20. Cold-ping warm-reply doesn't bump engagement_rank (outreach_jobs flow broken)
- **Where**: `src/tasks/dispatchers/socialOutreachTick.ts` → `socialPingRankCheck.ts:80-110`
- **What**: rank-check reads `outreach_jobs.status='replied'` + `reply_text`. No visible code in inbound handler flips matching outreach_jobs row to 'replied'.
- **Bite**: Cold-ping rank-2 person, they engage warmly → 48h later rank drifts DOWN to 1. Inverts signal.
- **Fix**: Wire inbound message handler to update matching open outreach_jobs row.

#### 21. `isFloatingBlockEvent` false-positive on subject prefix substrings
- **Where**: `src/utils/floatingBlocks.ts:102`
- **What**: Default matcher: `subject.includes(block.name.toLowerCase())`. "lunch with vendor", "Pre-lunch sync", "Lunch & Learn" all match. Excluded from busy pool / double_booking detection.
- **Bite**: Owner schedules "Pre-lunch prep call" 11:30-12:00 → check_calendar_health thinks lunch booked → actual lunch never lands.
- **Fix**: Default to `\\b<name>\\b` word-boundary, OR only fall through to substring when event has no attendees.

#### 22. Override path can create duplicate block events same day
- **Where**: `src/skills/calendarHealth.ts:1382-1402`
- **What**: `confirm_outside_window=true` idempotency check only matches within ±60s of override start. Lunch at 11:30-11:55 + override to 14:00 → creates SECOND lunch.
- **Bite**: Owner says "actually do lunch at 14:00" → two lunch events same day.
- **Fix**: Before creating in override branch, run same "any existing block event on this day" probe as line 1531.

#### 23. Rebalance helper default buffer (15min) mismatches everywhere else (5min)
- **Where**: `src/utils/rebalanceFloatingBlocks.ts:71` vs `src/skills/calendarHealth.ts:1380, 1582` + `src/connectors/graph/calendar.ts:714`
- **What**: Rebalance defaults `?? 15`; everywhere else `?? 5`. Profile without explicit buffer → sweep applies stricter buffer than original placement.
- **Bite**: Owner-with-unset-buffer: meetings that fit when first booked → reported "no in-window slot fits" by sweep → shadow noise.
- **Fix**: One source of truth — `?? 5` everywhere OR `getBlockBufferMinutes(profile)` helper.

#### 24. `computeHealthCheckWindow` stops at first non-workday
- **Where**: `src/utils/workHours.ts:178-188`
- **What**: Walks today..today+6, STOPS once non-workday reached after any workday. Default Sun-Thu → Thursday correctly. Sun/Mon/Wed/Thu (Tuesday off) called Sunday → returns Monday — loses Wed+Thu.
- **Bite**: Non-contiguous workweeks get shorter health-check coverage.
- **Fix**: Walk full 7 days; take last workday seen.

#### 25. `applyRaiseFeedbackSignal` clears raise on legitimate task interruption
- **Where**: `src/core/social/logEngagement.ts:46-90`
- **What**: Yesterday raised "marathon training". Today: "book the gym at 5pm" (task). logEngagement applies `-1` + clears raise. Owner answering raise hour later treated as fresh organic match.
- **Bite**: Engaged subjects camp at low scores.
- **Fix**: Gate pivot signal on `kind==='social'` only, OR window raise (count pivot only within N hours).

#### 26. `searchPeopleMemory` can resolve name to SELF row (latent — saved by regex accident)
- **Where**: `src/db/people.ts:520-529` + `src/utils/resolveSlackId.ts:84-94`
- **What**: `LIKE '%query%'` across ALL rows including SELF (name="Maelle"). Saved BY ACCIDENT — `SLACK_ID_RE = /^[UW][A-Z0-9]{6,}$/` rejects "SELF:" prefix.
- **Bite**: Fragile — if regex extends or SELF re-keyed, gossip about Maelle persists to SELF row from any colleague.
- **Fix**: Add `WHERE slack_id NOT LIKE 'SELF:%'` to `searchPeopleMemory` (defense in depth).

#### 27. Capture pass SELF dedup relies entirely on Haiku judgment
- **Where**: `src/memory/capturePass.ts:445-473`
- **What**: `appendPersonNote` has zero dedup. Full burden on Haiku's "DEDUP RULE — same essential fact = skip" prompt. Variance leaks dups.
- **Bite**: Note bloat on Maelle's SELF row. ABOUT YOU block renders all notes uncapped.
- **Fix**: `appendPersonNoteDedup(slackId, note)` skip if last-10 notes share ≥80% normalized overlap. OR cap rendered notes in `formatAssistantSelfForPrompt` to last 20.

#### 28. Venue catalog dedup misses on string drift in `planLocation`
- **Where**: `src/skills/meetings/ops.ts:2242-2248` + `src/db/venues.ts:147-155`
- **What**: Save-on-book passes full "Name, Street, City" string as name. `findVenueByNameAndOwner` matches by `lower(name)` exactly. Slight drift inserts new row.
- **Bite**: Recurring venue silently fails — same café accumulates 10 near-duplicates.
- **Fix**: Split name vs address at save site (needs Place API — [#96]), or strip after first comma when matching.

### MEDIUM PRIORITY (18 items)

#### 29. `coordinate_meeting` `hasInternalPollableNonOwner` runs AFTER demote
- **Where**: `src/skills/meetings.ts:1297-1300, 604-632, 1208-1253`
- **What**: Demote moves participants lacking slack_id to just_invite. Then check returns false → `no_internal_to_poll` refusal. Sonnet falls back but extra round trip.
- **Fix**: Move people-memory enrichment EARLIER (before demote).

#### 30. `triggerRoundTwo` slot finder ignores multi-window
- **Where**: `src/skills/meetings/coord/state.ts:927-939`
- **What**: Passes `workHoursStart`/`workHoursEnd` strings; only matter when `extendedHours=true`. Round-two doesn't set it.
- **Bite**: Round-two ignores preference-narrowing OR violates split-shift schedule.
- **Fix**: Drop those args; post-filter slots to preference intersection.

#### 31. `triggerRoundTwo` passes empty `attendeeEmails: []`
- **Where**: `src/skills/meetings/coord/state.ts:931`
- **What**: Round-2 calls slot finder with NO attendee emails — busy/work-hours filtering skipped.
- **Bite**: Can propose slots colleagues can't make.
- **Fix**: Pass active participants' emails.

#### 32. `back_to_back` analyzer fires on patterns scheduleRules doesn't treat as violations
- **Where**: `src/skills/meetings/ops.ts:508-514`
- **What**: scheduleRules.ts:283-287 says buffer rule was DELETED (v2.7.1). Analyzer still emits `back_to_back`.
- **Bite**: Brief keeps flagging back-to-back as issues when scheduler considers it preferred.
- **Fix**: Delete `back_to_back` issue type OR gate when bufferMin is owner-default.

#### 33. `requesterLang` outer guard too broad
- **Where**: `src/core/requests/resolver.ts:639-655`
- **What**: Outer accepts any pref containing 'he' substring. Saved by conservative inner whitelist.
- **Bite**: Fragile.
- **Fix**: Delete outer guard; keep only inner explicit whitelist `['he', 'hebrew', 'עברית', 'he-il']`.

#### 34. `resolve_approval` colleague-path doesn't verify `kind='approval'`
- **Where**: `src/tasks/skill.ts:806-823`
- **What**: Resolves by id + requester_slack_id + state. If colleague references parent coord id in awaiting_colleague, resolver closes it.
- **Bite**: Owner thinks coord still running.
- **Fix**: Add `if (probe.kind !== 'approval') return not_permitted`.

#### 35. Stale consequence DM after amend ping-pong
- **Where**: `src/tasks/skill.ts:748-762`
- **What**: Owner's original DM says "If yes → I'll book X at 14:00". After amend bounce (owner→colleague→owner), merge will book at 16:00.
- **Bite**: Owner approves thinking 14:00, gets 16:00.
- **Fix**: `notifyOwnerOfColleaguePushback` includes rebuilt consequence text.

#### 36. SELF capture skip on missing row logs warn, no recovery
- **Where**: `src/memory/capturePass.ts:514-520`
- **What**: If SELF row wiped, runSelfCapture silently no-ops.
- **Fix**: Re-seed inside runSelfCapture when missing (idempotent — same as startup).

#### 37. `update_person_profile` field-filter mutates caller's args
- **Where**: `src/core/assistant.ts:421-446`
- **What**: When target IS requester, no clone. `delete (args as ...)[k]` mutates orchestrator's cached args object.
- **Bite**: Cache miss on retries → re-fires tool.
- **Fix**: Always clone `args = { ...args }` at top of colleague-path block.

#### 38. Periodic sweep keeps moving owner-pinned floating blocks
- **Where**: `src/utils/rebalanceFloatingBlocks.ts:104-146`
- **What**: Twice-daily sweep can't distinguish "owner intentionally placed" from "got overlapped."
- **Bite**: Owner pins lunch on top of meeting (plans to delete later) → sweep undoes placement.
- **Fix**: Skip rebalance for blocks placed OUTSIDE preferred window (owner-pinned), OR stamp `override_used` on event body. **DECIDE WITH OWNER** before coding.

#### 39. Sweep shadowNotify has no de-dupe
- **Where**: `src/utils/rebalanceFloatingBlocks.ts:170-178`
- **What**: Same overlap shadow-DMed twice a day every day until owner resolves.
- **Fix**: Stable fingerprint `floating-overlap:<date>:<blockName>:<overlappingEventId>` to collapse.

#### 40. Rebalance can't honor `prefer_position: 'latest_in_window'`
- **Where**: `src/utils/rebalanceFloatingBlocks.ts:144`
- **What**: Always picks earliest. No persisted prefer_position on block event.
- **Fix**: Persist position hint on event body / category; read in rebalance.

#### 41. `windowMsForDay` returns NaN on DST-folded times silently
- **Where**: `src/utils/floatingBlocks.ts:119-125`
- **What**: DST spring-forward gap → invalid DateTime → NaN. Comparisons silently break.
- **Bite**: Custom block ("gym 02:00-04:00") on DST boundary → false `no_room` refusal.
- **Fix**: Validate finite in `findAlignedSlotForBlock`; return null with log.

#### 42. Venue Case-1 ambiguity false-positive on substring nameHint
- **Where**: `src/skills/venue.ts:225` + `src/db/venues.ts:239-242`
- **What**: "Coffee Landwer" matches "Coffee Bar" + "Coffee Landwer" → asks "did you mean…"
- **Fix**: Case-1: match `lower(name) = lower(name_hint)` exact first, fall back to startswith.

#### 43. Venue Case-1 fresh resolve drops phone/reservation_url/hours
- **Where**: `src/utils/venueSearch.ts:246-263`
- **What**: `resolveVenueByName` returns only `{name, address, area_tags}`. Prompt tells Sonnet "surface phone and reservation_url" → never present on fresh Case-1.
- **Bite**: Every first-time venue says "no phone in my data".
- **Fix**: Either resolveVenueByName calls searchVenueCandidates, OR strip phone/reservation_url from prompt expectation.

#### 44. Module-level Anthropic client capture in venue
- **Where**: `src/utils/venueSearch.ts:128`
- **What**: `const anthropic = getAnthropicClient();` at module import. Stale on provider flip.
- **Fix**: Call `getAnthropicClient()` inside `searchVenueCandidates`.

#### 45. `getBriefingHourMin` picks earliest across ALL days
- **Where**: `src/tasks/briefs.ts:638-658`
- **What**: Global lex-min start across all weekday windows.
- **Bite**: Multi-window / per-day variance → briefing fires too early.
- **Fix**: Accept `dt: DateTime` arg, return that day's earliest, OR document the across-all-days intent.

#### 46. `isWithinOwnerWorkHours` exclusive vs `isSlotInWorkHours` inclusive boundary
- **Where**: `src/utils/workHours.ts:97` vs `:73`
- **What**: Tuesday endMin=1439 (23:59) → `isWithinOwnerWorkHours` at 23:59:00 false; `isSlotInWorkHours` for 23:30-23:59 true.
- **Bite**: 1-min dead zone at boundary.
- **Fix**: Standardize: exclusive throughout (normalize `00:00`→`24:00` internally), OR document.

#### 47. UTC day boundary in `countAssistantInitiationsTodayForPerson`
- **Where**: `src/db/socialSubjects.ts:488-499`
- **What**: `setUTCHours(0,0,0,0)` — Israel resets at 02:00 local. Possible races.
- **Fix**: Compute day boundary in owner-local TZ via luxon.

### DEAD CODE (12 items, ~1500 lines)

#### 48. `src/core/approvals/resolver.ts` (581 lines) fully orphaned
Zero imports in src/. Legacy v1.5 layer entirely superseded by `src/core/requests/resolver.ts`.
**Fix**: Delete file.

#### 49. `approvalExpiry.ts` + `approvalReminder.ts` operate on legacy approvals table
Both call `getApproval`/`setApprovalDecision` on `db/approvals.ts`. v2.7.0+ approvals dispatch via `core/requests/runner.ts`. No task creator writes `task.type='approval_expiry'` anymore.
**Fix**: Delete both + remove from `dispatchers/index.ts:21-22, 39-40`.

#### 50. `src/db/approvals.ts` (505 lines) — almost entirely legacy
Only live importer is the dead dispatchers (#49). One script (`scripts/measure-prompt.ts`) uses `getPendingApprovalsForOwner`.
**Fix**: Migrate script to `getAwaitingOwnerRequests`, then delete.

#### 51. `coordinate_meeting` stub-handler in `meetings/ops.ts:3286-3289`
Unreachable case; returns misleading "Coordination feature initializing".
**Fix**: Delete the case.

#### 52. `logPersonInitiated`/`logMaelleInitiated`/`logOwnerInitiated` no-op shims
`src/core/social/logEngagement.ts:148-161` marked `@deprecated v2.6.7`. Still called from `orchestrator/index.ts:1912, 1914, 1926, 2017, 2110`. `logOwnerInitiated` has zero callers.
**Fix**: Delete shims + remove call sites.

#### 53. `parseSocialTopics` is no-op stub still consumed
`src/db/people.ts:307-309` returns `[]` (column dropped v2.2). Caller at `:621` builds `topicStr` always empty. `PersonMemory.social_topics: string` interface lies.
**Fix**: Delete function, call site, interface field.

#### 54. Legacy `engagement_level` enum still in `update_person_profile`
`src/core/assistant.ts:101, 124-128, 735`; `src/memory/capturePass.ts:81, 105, 206, 272`; `src/db/people.ts:50`. `engagement_rank` is canonical.
**Fix**: Drop `engagement_level` from `update_person_profile` schema + `capturePass`.

#### 55. `recordSocialMoment` 3-of-5 args ignored
`src/db/people.ts:489-513` — `_topic`, `_quality`, `_subject` dropped since v2.2.
**Fix**: Strip unused params OR (paired with #10) wire them through.

#### 56. `lunch_bump` approval kind survives though deprecated
`src/db/approvals.ts:22`, `src/core/requests/types.ts:31`, `src/skills/meetings/coord/approval.ts:31`, `src/core/approvals/resolver.ts:161`, `src/tasks/skill.ts:33, 140, 912`. Only producer is colleague-path floating-block refusal at `ops.ts:2794`.
**Fix**: Retire — migrate the lone caller to `policy_exception` + deferred-action replay.

#### 57. Unused imports in `threadBoundApprovalAutoResolve.ts:27-29`
`import Anthropic from '@anthropic-ai/sdk'` and `import { config } from '../config'` — never referenced.
**Fix**: Delete.

#### 58. `task_id` arg on `create_approval` deprecated in schema
`src/tasks/skill.ts:164`. Description: "Legacy field — kept for back-compat, no longer required." Code never reads it.
**Fix**: Remove from schema.

#### 59. `bumpVenueLastUsed` helper is unused
`src/db/venues.ts:185-187`. Exported but no callers.
**Fix**: Delete or migrate two save-on-book call sites to use it.

### CONFIG LEAKS (7 items)

#### 60. Hardcoded colleague names in `meetings.ts` prompt sections (heavy)
**Where**: `src/skills/meetings.ts:308, 1122, 1846, 1918, 1946, 1986-1988, 2059, 2075, 2093, 2111-2113, 2155`
**What**: "Brett ET, Yael NYC, Jenna EST" example list. "Yael is on another call". "Amazia and Maayan". "Onn will get the calendar invite". Tool description bake owner's social graph.
**Fix**: Abstract placeholders.

#### 61. Hardcoded colleague names in `outreach.ts` / `tasks/skill.ts` / `social.ts`
**Where**: `src/skills/outreach.ts:52, 118, 471`; `src/tasks/skill.ts:52-54, 890`; `src/skills/social.ts:88`
**What**: "Share this in #marketing, tag Yael". "Follow up with Yael in 3 days". "Remind Ysrael about the board prep". Tool description examples bake Yael/Michal/Isaac/Ysrael/Ike.
**Fix**: Abstract placeholders.

#### 62. Maya/Comsec + Yael in systemPrompt examples
**Where**: `src/core/orchestrator/systemPrompt.ts:353, 354, 512-513`
**What**: CANNOT-REACH RULE hardcodes "Maya is external"; requester-not-attending example hardcodes "@Yael does Tuesday 19 May work" / "fits Shayan's window".
**Fix**: Generic person tokens / interpolated placeholders.

#### 63. Maelle identity narrative baked into `note_about_self` description
**Where**: `src/skills/social.ts:125-139`
**What**: Examples bake "Clair Obscur Expedition 33", "Built around January 2026", "AI assistant not human".
**Bite**: Burns ~1k tokens/turn. Rebadged deployment collides.
**Fix**: Strip to one-line abstract pattern; identity facts live in SELF row data (already, post v2.9.4).

#### 64. Real-shaped Slack ID `U09P4HJ317W` in 5 tool descriptions
**Where**: `src/core/assistant.ts:118, 228, 264`; `src/skills/social.ts:97`; `src/utils/resolveSlackId.ts:57`
**What**: All five use exactly the same ID. If real, leak.
**Fix**: Use `"U09EXAMPLE9"` or similar obviously-fake.

#### 65. `countryHint: 'Israel'` hardcoded in `resolveVenueByName`
**Where**: `src/utils/venueSearch.ts:253`
**Fix**: Take from `profile.user.timezone`-derived region or `profile.user.country`.

#### 66. Israel TZ hardcoded in `computeLocalWeekStartMs`
**Where**: `src/tasks/dispatchers/socialOutreachTick.ts:193`
**What**: `const isSundayStart = zone === 'Asia/Jerusalem'`.
**Fix**: Lift to yaml `profile.meetings.sunday_start_tzs: [...]` default Mon-start.

### BAD TOOL DESCRIPTIONS (6 items)

#### 67. `deferred_action` description missing `update_meeting`
**Where**: `src/tasks/skill.ts:149`
**What**: Lists 4 tools. Actual `RESOLVER_REPLAY_TOOLS` includes `update_meeting` too.
**Fix**: Add `update_meeting`.

#### 68. `resolve_approval` doesn't mention Module D auto-resolve
**Where**: `src/tasks/skill.ts:176-198`
**What**: Description doesn't say short-acks get auto-resolved pre-orchestrator. Sonnet calls redundantly.
**Fix**: Add: "Owner short-acks ('yes', 'go', 'no') are auto-resolved pre-orchestrator. Call this only on AMEND or when owner referenced a specific approval id."

#### 69. `note_about_self` description says "mute when called by colleague" but handler writes to colleague's row
**Where**: `src/skills/social.ts:139`
**What**: Description contradicts v2.9.4 handler at `social.ts:222-225, 250-282`.
**Fix**: Reword: "Owner-path saves to Maelle's SELF row. Colleague-path saves to colleague's own row."

#### 70. `note_about_self` example contradicts IDENTITY block runtime rule
**Where**: `src/skills/social.ts:135-137` vs `src/core/orchestrator/systemPrompt.ts:422`
**What**: Example: owner teaches "be honest you're AI" → save. IDENTITY rule: "deflect, don't engage" on AI questions.
**Fix**: Change example to non-colliding fact, OR update IDENTITY block to defer to ABOUT YOU on AI/human when saved.

#### 71. `find_available_slots` hardcodes "Brett ET, Yael NYC, Jenna EST"
**Where**: `src/skills/meetings.ts:308`
**Fix**: Drop parenthetical or replace with generic.

#### 72. `type='other'` enum in venue tool is dead
**Where**: `src/skills/venue.ts:103`
**Fix**: Drop 'other'.

### STALE COMMENTS (4 items, low priority)

#### 73. Real-day-incident dates pinned to comments throughout
**Where**: `src/utils/threadBoundApprovalAutoResolve.ts:110`; `src/skills/meetings/ops.ts:715, 894-896, 1592-1597`; `src/core/orchestrator/index.ts:651, 774, 852`; `src/core/orchestrator/systemPrompt.ts:137`; many more
**Fix**: Sweep — strip incident names/dates; keep abstract failure pattern.

#### 74. `ops.ts:1359-1372` "98A diagnostic" debug logger leftover
98A closed by v2.9.0. **Fix**: Delete the diagnostic block.

#### 75. Pre-v2.x stale references across files
**Where**: `src/core/assistantSelf.ts:7-8, 64`; `src/core/ownerSelf.ts:22-25`; `src/index.ts:23-24`; `src/skills/meetings.ts:455-458, 165-168`; `src/connectors/graph/calendar.ts:466, 710, 786, 1084`; `src/skills/calendarHealth.ts:785-786`; `src/utils/workHours.ts:225-228, 236-240`; `src/tasks/dispatchers/socialOutreachTick.ts:24-28, 69, 115, 445-452, 463-470`; `src/db/people.ts:821`; `src/tasks/dispatchers/socialDecay.ts:1-13`; `src/skills/meetings.ts:1509, 1558, 1577`; `src/utils/rebalanceFloatingBlocks.ts:9, 169`
**Fix**: Sweep when touching nearby code.

#### 76. Yaml `venues:` seeding block doesn't exist (claimed but not implemented)
**Where**: `src/config/userProfile.ts` — no schema, no loader
**Fix**: Decide — implement OR strike from design notes.

---

## 4. Plus owner's additional bugs

**Owner has a few additional bugs to add at session start.** Ask owner for the list and add them numbered 77+. Treat them as inline with the wave plan — slot them into the appropriate wave by category.

---

## 5. Recommended fix order (waves)

**Wave 1 — security / privilege**: #1, #2, #26
**Wave 2 — approval pipeline structural**: #3, #6, #7
**Wave 3 — booking pipeline**: #4, #5, #11, #12, #13
**Wave 4 — work hours / floating blocks**: #8, #9, #21, #22, #23, #24 (also resolve #38 with owner first)
**Wave 5 — social engine**: #10 (DECIDE: wire counter or strip description), #19, #20, #25
**Wave 6 — dead code mass deletion**: #48-#59 (one commit, ~1500 lines)
**Wave 7 — config leaks**: #60-#66 (find-and-replace patterns; can group in single pass)
**Wave 8 — descriptions + stale comments**: #67-#76 (cleanup commit)

MEDIUM items (#29-#46) interleave wherever surrounding code is touched. None individually load-bearing enough to schedule alone.

**After each wave**:
1. Typecheck against worktree tsconfig
2. Commit on worktree branch with descriptive message
3. Fast-forward master + push
4. Tell owner to restart `npm run dev` if behavior changed
5. WAIT for owner to confirm before next wave

---

## 6. Wrap to v3.0

When owner says "wrap" / "ship v3" / "cut v3":

1. **Run the `wrap` skill** (or `.claude/WRAP_UP.md` checklist manually)
2. **Version bump**: 2.9.4 → **3.0.0** (minor jump to mark the 2.9 line closeout — owner has consistently said v3 marks "after this big cleanup")
3. **CHANGELOG entry**: large entry titled "v3.0 — bug-wave cleanup + 2.9 line closeout". 5-paragraph intro covering the wave themes (security, approval pipeline, booking pipeline, work hours, social engine, dead code mass deletion, config leaks, descriptions). Then `### Fixed (high-impact)` bullets for items #1-#28 (one bullet each). `### Removed (dead code)` for #48-#59. `### Changed (config / descriptions / comments)` summary for #60-#76. Mention owner's additions inline. End with "Phase B BookingRequest normalizer migration deferred to v3.1" if it hasn't been done in the wave.
4. **Memory files update**: `.claude/memory/project_overview.md` — append a `## Where v3 landed` section. Also update version leader.
5. **Typecheck final**: must pass
6. **Commit on worktree, fast-forward master, push**
7. **Close any GitHub issues** the wave addressed (if any were filed)
8. **Summary back to owner**: "Shipped v3.0. Bug wave closed N items + your M additions. Tree clean, deploy when ready."

---

## 7. Final reminders

- **Worktree path only** — never edit master directly. Always use `E:/Code/Maelle/.claude/worktrees/youthful-burnell-4a047d/...` for Edit/Write/Read paths.
- **Propose first** — owner has been burnt by auto-fix multiple times. Even with this audit in hand, propose the specific edit before making it.
- **Wave granularity** — don't bundle waves unless owner says so.
- **Per-bug discussions OK** — owner may want to discuss the fix shape on individual bugs (especially #10 cooldown wire-or-strip and #38 owner-pinning). Don't assume the proposed direction is final.
- **Owner's overall direction**: code-over-prompt, tooling-over-new-tools, prompt-shorter, no-new-tools-without-justification. The wave fits cleanly — most fixes are subtractive or one-line code edits.

Good luck. Sleep is wealth; let's make v3 a clean line.
