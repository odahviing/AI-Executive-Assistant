# Changelog

---

## 2.3.3 — Owner-override-as-approval cluster + scheduling honesty + coda safety + office address

A long sweep of small bugs from a half-day of real chat use, all clustered around the same theme: Maelle was over-protecting the owner from his own decisions. The fixes restore the human-EA pattern — flag the cost, then act on what was asked. Plus a 2-mode extension to the existing `claimChecker` to catch coda hallucinations, and a yaml field for the actual office address so calendar invites stop saying "Idan's Office" with no street name.

### Added

- **`profile.meetings.office_location` yaml field** — `{ label, address, parking }` all optional. `determineSlotLocation` and `create_meeting` body fill in the real address for physical meetings so external attendees on the invite know where to go. Backwards-compatible — empty field falls back to the legacy "${name}'s Office" label.
- **`find_available_slots.relaxed: bool` (owner-only)** — bypasses focus-time protection, lunch / floating-block windows, and work-hour strictness. KEEPS the 5-min between-meeting buffer (sacred). Sonnet calls it as the second pass after a strict-empty result; MUST flag in narration which soft rule each surfaced slot breaks ("breaks your focus protection / squeezes lunch — book?"). Closes the "nothing clean tomorrow" pattern that hid 75-min open windows because of a 15-min buffer.
- **`find_available_slots.ignore_attendee_availability: bool`** — for "find me times I'm free, I'll handle the others" scenarios. Default false (auto-load attendee availability — see Changed below).
- **claimChecker `mode: 'coda'`** — second mode on the existing fact-checker. Validates a generated social coda against the recipient's people_memory snapshot — flags invented facts ("kind of wild that she shares my name" when no name overlap exists) and gossipy commentary about third parties ("hope she's at least competent"). Reuses the same JSON contract + fail-open semantics as action mode. Orchestrator drops the coda silently when flagged. No new file, no new prompts in `generateCoda.ts` — extends a battle-tested function.
- **Coda → engagement-rank tracking** — every coda now calls `recordSocialMoment` to set `last_initiated_at` and schedules a `social_ping_rank_check` task 48h out. Dispatcher gains a `kind: 'coda'` branch that compares `last_social_at > coda_at_iso`: not engaged → `-1` to engagement_rank with a new reason `no_social_response_to_coda`. Repeated ignores drift the colleague to rank 0 (opt-out), exactly as designed.

### Changed

- **`find_available_slots` auto-loads attendee availability from people_memory** — for any attendee with a known timezone + working hours (manual `working_hours_structured` or auto-derived), the tool builds an `attendeeAvailability` entry and pre-clips slots to their window. Brett (Boston/EST) no longer gets proposed 10:15 IL (3:15 ET). Sonnet doesn't have to remember to pass `attendeeAvailability` — code does it.
- **`coordinate_meeting` enriches missing emails for internal attendees** — when an attendee comes in with name only (or slack_id without email), the handler tries people_memory first (by slack_id, then by name) and falls back to Slack `users.info` via the existing `Connection.collectCoreInfo` interface. Closes the silent annotation gap where `just_invite[].email` is optional and Sonnet sometimes omits it. Externals that resolve to nothing keep their missing-email status (correctly downgrades them out of the v2.3.2 fast-path).
- **`coordinate_meeting` busy-pre-filter for mixed coords** — the existing search now passes `attendeeBusyEmails` for internal attendees in mixed (internal + external) coords. Externals only see slots where the internal attendees are also free.
- **textScrubber em-dash filter** — old hyphen-only `\.replace(/ - /g, ', ')` extended to `\.replace(/ [-—] /g, ', ')`. Catches both regular sentence-separator hyphens AND em-dashes (which were leaking despite the prompt rule). Time-range en-dashes ("12:00–12:55") and word-internal hyphens ("10-minute") untouched. The prompt rule at `systemPrompt.ts:375` stays — code is the backstop.
- **`create_meeting` body scrubbed before Graph** — calendar invites now go through `scrubInternalLeakage` before reaching Outlook. Previously bypassed the formatForSlack scrub path; now they don't.
- **`move_meeting` floating-block branch — owner override** — when owner-path AND `args.new_start` is in-window, the handler uses the hint as-is (no `findAlignedSlotForBlock` snap, no conflict refusal). Out-of-window still refuses with the lunch_bump pointer. Colleague-path keeps the existing strict alignment + conflict guard. Owner saying "move lunch to 11:30" no longer gets fought because Elan happens to be at 11:30 — owner override is the approval, the conflict shows on the calendar for him to sort.

### Fixed (prompt-only)

- **Owner-explicit time + conflict** — meetings prompt added rule: when owner names a specific time and there's a conflict, narrate the conflict and ask "keep 12:00?" not "find different?". Owner-override IS the approval — don't reframe as alternatives.
- **External-meeting online/in-person ASK rule** — clarify ONLY when there's no clear remote signal. Different-TZ attendee in people_memory, "3pm ET" mentioned, "from Boston" mentioned → online by default, no ask. "At our office" / "in person" → physical, no ask. Otherwise ask whoever you're talking to (not the other party).
- **Floating blocks vs colleague meetings ownership** — short rule: floating blocks are Maelle's call (move/skip silently), colleague conflicts need owner's call. Don't bundle them in one question.
- **Verify the goal before suggesting collateral moves** — short rule: if extending meeting X requires Y to be free, check Y first; don't suggest moving Z to make room when Y will block anyway. Closes the "want me to shift FNX?" pattern when Amazia was already blocked.
- **Trimmed find_available_slots fallback rule** — replaced "call get_calendar to find gaps yourself" with "re-call relaxed=true and flag the broken rule". Cleaner path, less manual math.

### Invariants preserved

- 5-min between-meeting buffer is never bypassed, even in relaxed mode.
- Colleague-path scheduling rules unchanged. All new owner-override paths are gated on `senderRole === 'owner' || isOwnerInGroup === true`.
- Coda validator fails open — better one weird coda than dropping every coda when the validator API blips.
- Email enrichment is a soft fallback — externals that don't resolve still get the regular coord state machine (no new owner-friction).

### Migration

None. New yaml field is optional. New tool args are optional. New rank-change reason is additive to the union.

### Not changed

- The `coord_jobs` schema, the coord state machine, the v2.3.2 internal-only fast path — all unchanged.
- `claimChecker` default behavior (action mode) — unchanged. New `'coda'` mode is opt-in via the `mode` parameter.
- `move_meeting` colleague-path floating-block behavior — unchanged (still requires alignment + conflict-free).
- Auto-triage / auto-build CI — still gated `if: false &&` (deactivated in 2.3.1).

---

## 2.3.2 — Brief redesign + internal-coord fast-path + colleague-path booking + shadow threading

A multi-front session: rewrote the morning brief to lead with today's calendar instead of a stale events feed; gave Maelle a direct booking path when a colleague has confirmed slot+duration+subject in conversation; added an internal-only fast-path to coordinate_meeting that skips the DM-and-poll round when every attendee's free/busy is readable via Graph; collapsed shadow-DM spam by threading per Slack conversation. Plus the Bug 3 wave from 28 Apr (toolHint trailing parens, narration honesty, duration auto-snap) and a process-wide warn-once cache for stub-skill yaml entries.

### Added

- **Internal-only coord fast-path** ([`meetings.ts`](src/skills/meetings.ts), [`utils/attendeeScope.ts`](src/utils/attendeeScope.ts)) — when every participant in a `coordinate_meeting` call has the owner's email domain, Maelle skips the coord state machine entirely. Reads each attendee's free/busy via Graph, annotates the 3 proposed slots with per-attendee status, sorts all-free first, returns `action: 'present_slots_to_requester'`. Sonnet presents the annotated slots to the REQUESTER directly in the conversation; the requester picks; Sonnet calls `create_meeting` to book. Closes the latency gap that made Oran (waiting on Amazia's async DM reply) give up and book via Calendly. New helper `isAllInternalParticipants(participants, profile)` is the gate.
- **Colleague-path `create_meeting`** — `create_meeting` added to `COLLEAGUE_ALLOWED_TOOLS` ([`registry.ts`](src/skills/registry.ts)). Same trust pattern as v2.2.1 `move_meeting`: `[ops.ts:751](src/skills/meetings/ops.ts:751)` colleague-path gate enforces (a) attendees are requester themselves OR internal-domain (externals require coord), (b) slot passes owner's rules via narrow-window `findAvailableSlots`, (c) auto shadow-DMs owner on success, (d) post-booking heads-up DMs to non-self internal attendees ("Hi Amazia, Oran asked for a meeting with you and Idan, I checked your calendar and booked Tue 09:00"). Removes the "go ahead and send him the invite" punt where Maelle did 90% of the work then made the colleague organize it.
- **Today's calendar in the morning brief** ([`briefs.ts`](src/tasks/briefs.ts)) — `collectBriefingData` now produces `kind: 'calendar_today'` and `kind: 'calendar_tomorrow'` items via `processCalendarEvents` (privacy mask, free-event strip, attendee extraction reused). Brief system prompt restructured: time-of-day greeting → today's calendar (one line per meeting) → tomorrow heads-up if anything notable → per-person paragraphs → ACTION ITEMS. Explicit ban on "your window is X / it's a short day" framing — owner already knows his own schedule.
- **Deterministic brief-request routing** ([`core/briefIntent.ts`](src/core/briefIntent.ts), [`connectors/slack/app.ts`](src/connectors/slack/app.ts)) — when the owner messages "didn't get my morning update" / "send the brief" / "what's on today" in a DM, route deterministically to `sendMorningBriefing(force=true)` BEFORE the orchestrator runs. Two-stage classifier: cheap regex pre-filter (≤100 chars, brief/morning-update/rundown patterns) → Sonnet yes/no judge that distinguishes "brief me" from "brief me ON Yael". Removes the failure mode where Sonnet improvised a calendar rundown via raw `get_calendar` calls.
- **Shadow-DM threading per conversation** ([`utils/shadowNotify.ts`](src/utils/shadowNotify.ts)) — new optional `conversationKey` + `conversationHeader` params. Process-wide `Map<key, ownerDmTs>` cache: first shadow on a key creates a top-level "🔍 *Conversation header*" message in owner's DM and caches the resulting ts; subsequent shadows with the same key thread under it. Wired at: inbound-colleague shadow (key = colleague threadTs), colleague-path move_meeting / create_meeting (same), coord-side state.ts/reply.ts/booking.ts shadows (key = `coord:${job.id}`). Security shadows (rate limits, injection blocked, judge SUSPICIOUS) and "DM failed" stay top-level intentionally — they need attention, not threading. Replaces the 20-shadow flood from a single colleague conversation with one collapsible thread.

### Changed

- **Mixed-coord internal busy pre-filter** — `coordinate_meeting` now passes `attendeeBusyEmails: participantEmails` to `findAvailableSlots` for the internal-domain participants. Externals (in mixed coords) only see slots where the internal attendees are also free. Their own busy state is unreadable via Graph as before.
- **Brief no longer reads `events` table** — removed the `incomingMessages` block from `collectBriefingData` and the post-send `actioned=1` flush from `sendMorningBriefing`. Tasks-spine (v2.2.4) is now the only source for the brief; `tasks.informed` is the only dedup mechanism. Events table stays a write-only log surface, consumed on demand by `recall_interactions` and the `get_briefing` tool. Closes the resurfacing pattern where every inbound colleague DM lingered as actioned=0 and got narrated again at next morning brief, even after Maelle handled it in real-time.
- **Duration auto-snap prompt** ([`meetings.ts`](src/skills/meetings.ts) — tool description + COORDINATION block) — now parameterized on `profile.meetings.allowed_durations` and `profile.meetings.buffer_minutes` instead of hardcoded `10/25/40/55`. Different owner with `[25, 50, 135]` and `buffer_minutes: 5` gets the right phrasing automatically. Sonnet learns: when colleague asks for "30 min" / "an hour" / "45 min", call coordinate_meeting with their stated value; system snaps silently for delta ≤10 min. No more "30 minutes isn't one of the standard durations, the closest options are 25 or 40" pedantic bounce.
- **Narration-honesty rule** ([`meetings.ts`](src/skills/meetings.ts) ROUTE 1) — Sonnet must name only the people getting DMs in coord narration. "Slots going to Idan and Amazia" was a lie when only Amazia is being DM'd (owner is the implicit organizer). Three honest example phrasings included for 1:1 / multi / mixed.
- **GitHub label axes (memory)** — improvements use High/Medium/Low (priority); features use Roadmap/Next/Idea (commitment-stage). Two parallel tracks, never mix. Saved as a feedback memory after [#22](https://github.com/odahviing/AI-Executive-Assistant/issues/22) was relabeled `Improvement+High → Feature+Next`.

### Fixed

- **#32 closed (won't-fix-yet)** — retry move-coord on refusal. Owner reframed: most refusals come with a counter time (handled by `parseTimePreference`); pure refusals fall through to owner-approval which works fine via shadow DM. The "earlier-bias retry" needed five-and conditions (active mode + overlap + pure refuse + earlier slots free + original window forward-biased) that don't show up often. High-priority framing was aspirational, not pressure-driven.
- **Shadow toolHint trailing `()` / `(, )`** — [`orchestrator/index.ts:1156`](src/core/orchestrator/index.ts:1156) was guarding the parens emit on `toolCallSummaries.length > 0` (raw array) but building the inner content from a filtered subset. When summaries existed but none matched the `^\[([a-z_]+)` regex, we still emitted ` (${empty})`. Now: compute distinct/non-empty tool list FIRST, guard on its length. Empty list → no parens at all.
- **`social_outreach_tick` log spam** ([`tasks/dispatchers/socialOutreachTick.ts`](src/tasks/dispatchers/socialOutreachTick.ts)) — `pickCandidate` refactored: extracted `lastInboundMs` helper, single-pass `classifyRow` with typed `RejectReason`, returns `{ pick, dropped, late_drops }`. The "no eligible candidate this hour" debug log now shows the per-reason rejection breakdown plus names of late-stage drops (cooldown / active_conversation) — names appear when there's something interesting to surface. Active-conversation SQL fetch moved up-front (one query, gone from the second filter).
- **Stub-skill yaml warn-once** ([`skills/registry.ts:142`](src/skills/registry.ts:142)) — `getActiveSkills` is called 4× per orchestrator turn; three forward-looking yaml toggles (`email_drafting`, `proactive_alerts`, `whatsapp`) produced 12 debug log lines per turn. Process-wide `Set<${profileId}:${skillId}>` cache: log once per profile-skill, then silent. Yaml typos still surface once at first call.

### Removed

- **`incoming_message` case in `buildFallbackBriefing`** — dead after the events-block removal.
- **Dead `getUnseenEvents` import in briefs.ts** — was a leftover.

### Migration

None. No schema changes. `events` table still written; just no longer read by the brief.

### Invariants preserved

- Shadow notify still gated on `behavior.v1_shadow_mode`.
- `create_meeting` colleague-path enforces rule-compliance via `findAvailableSlots` (same gate as v2.2.1 `move_meeting`).
- Coord state machine unchanged for external/mixed; only the search call gained `attendeeBusyEmails` for internal participants.
- Owner-initiated coord flow unchanged — fast-path applies regardless of who initiated, but the request-to-pick step is the same.

### Not changed

- The `coord_jobs` schema and the coord state machine (collecting / resolving / negotiating / waiting_owner / confirmed / booked) — fast-path bypasses them entirely.
- `create_meeting` for owner path — unchanged.
- `move_meeting` colleague-path (v2.2.1) — unchanged.
- Auto-triage / auto-build CI — still gated `if: false &&` (deactivated in 2.3.1).

---

## 2.3.1 — 23-bug interactive sweep (coord state machine, floating block determinism, OOF, proactive social, more)

A long working session pulling 7 GitHub bug reports + 5 chat-screenshot bugs + 11 follow-on atomic issues into a single wave. Pattern: owner files / I propose / he revises / we land. Single-shot triage was too lossy without session memory; this version is the interactive output. Auto-triage workflows deactivated alongside this wave (see CI section).

### Coord state machine

- **#62 — Inactive coordination** — three sub-bugs in the colleague-initiated coord path: (1) `[connectors/slack/app.ts:631](src/connectors/slack/app.ts:631)` await `initiateCoordination` and capture its result; on `no_participants` / `no_connection` post a corrective shadow to the owner so failures don't get masked by the prior "I started X" reply. (2) `[coord/state.ts:108](src/skills/meetings/coord/state.ts:108)` auto-add the requesting colleague as participant when it's clearly 1:1 with the owner (zero other non-owner participants). For the interview-style "arrange Idan with X" case (other participants present), don't auto-add — Sonnet asks if unclear. (3) Defense remains the existing owner auto-add at line 87.
- **#65 — Booked duplicate meetings** — two sub-bugs. (1) `[approvals/resolver.ts:429](src/core/approvals/resolver.ts:429)` `resolveGenericApprove` now updates `coord_jobs.duration_min` to the approved value AND clears `needsDurationApproval` from notes. Single source of truth — no two durations alive at once. (2) `[coord/booking.ts:292](src/skills/meetings/coord/booking.ts:292)` cross-turn idempotency check mirrors the v2.2.5 ops.ts pre-create dedup (±2 min on subject + start). Coord-side bookings can no longer create a second event next to a direct create.
- **B8-i — Snap non-standard duration upfront** in `coordinate_meeting` handler. When the requested duration is within 10 min of an allowed value, snap immediately and tell the requester ("set up at 40 min, that's standard — let me know if you actually need 45"). Approval gate only fires when the snap delta is too large to be obvious. Closes the "two durations parallel forever" pattern at the source.

### Floating blocks

- **#61 / B1 — Lunch placement done in chat instead of code** — `move_meeting` in [`ops.ts`](src/skills/meetings/ops.ts) now detects floating-block events (via `isFloatingBlockEvent` + `getFloatingBlocks`), runs `findAlignedSlotForBlock` with the caller's `new_start` as a hint, and uses the deterministic in-window aligned slot. If no in-window slot fits, refuses with `error: 'no_in_window_slot'` and points at `lunch_bump` approval. Owner-directed in-window moves no longer ask permission. Closes the recurring "Sonnet does time math, gets the window check wrong, fabricates a default position, asks for exception" pattern. Verifier and post-mutation rebalance use the effective (post-snap) start.
- **#64 / B7 — Floating block ignored after first round in coord** — `[coord/booking.ts:212](src/skills/meetings/coord/booking.ts:212)` conflict pre-check now filters floating blocks out (they're elastic by definition; the slot finder already accounted for them). Post-create rebalance fires via `rebalanceFloatingBlocksAfterMutation` so the displaced block lands cleanly in its window.

### Calendar / OOF

- **Screenshot D / B16 — OOF detection on `showAs=free` events** — `[calendarHealth.ts:358](src/skills/calendarHealth.ts:358)` keyword-based OOF detection (vacation/oof/holiday/pto in subject) removed entirely. Owner direction: trust `showAs` only. If owner marks a day OOF in Outlook it's OOF; otherwise it isn't. Free-marked all-day events with vacation-keyword subjects no longer fire false conflicts.
- **#67 / B11 — Mid-day calendar-health DM noise** — `[postBookingHealthCheck.ts](src/utils/postBookingHealthCheck.ts)` no longer auto-DMs the owner with raw issue lists after coord booking. Daily morning routine still surfaces issues; mid-day decisions go through normal approval mechanisms (calendar_conflict, oof_conflict). Telemetry log retained for future "Maelle decides to act" path.
- **#67 / B12 — `busy_day` issue type removed entirely** — owner never asked for "rough days" alerts. `[calendarHealth.ts:454](src/skills/calendarHealth.ts:454)` busy-day generator deleted; `[calendarHealth.ts:902](src/skills/calendarHealth.ts:902)` busy-day DM block deleted. Active mode now only surfaces conflict / OOF / missing-block / buffer issues.
- **#63 / B5 + B6 — Wrong TZ in briefing** — (1) `[ops.ts:127](src/skills/meetings/ops.ts:127)` `parseGraphDateTime` now `setZone(fallbackTz)` after parsing; UTC-stamped events render in owner-local TZ instead of UTC. (2) `[connectors/graph/calendar.ts:230](src/connectors/graph/calendar.ts:230)` `Prefer: outlook.timezone` header re-attached on `@odata.nextLink` requests; previously dropped, leading to mixed-TZ pagination results.

### Proactive social

- **#66 / B10 — Proactive ping fires when disabled** — `[socialOutreachTick.ts:262](src/tasks/dispatchers/socialOutreachTick.ts:262)` persona-off and feature-disabled guards moved OUT of the `try-finally`. Previously `finally` re-scheduled the tick unconditionally, so disabling the feature never killed the loop. Both early-exits now `completeTask` and return cleanly.
- **Lori ping / B18 — Eligibility requires real interaction history** — `[socialOutreachTick.ts:128](src/tasks/dispatchers/socialOutreachTick.ts:128)` filter now checks `interaction_log` for at least one `message_received` (colleague → Maelle) entry, then applies the 72h recency gate to that. Mentions in summaries, owner references, and Maelle-initiated outbound no longer qualify someone for proactive outreach.
- **Mike DM / B17 — Ping content quality** — `generatePing` in [`socialOutreachTick.ts`](src/tasks/dispatchers/socialOutreachTick.ts) rewritten. Now reads `getAllTopicsForPerson(slackId)` for the colleague's active social topics (passed as JSON) + 15-question discovery pool fallback. Hard ban on meeting/work/task references. Removed `interaction_log` (work-shaped) from inputs entirely — only social topics + personal notes feed the ping.

### Honesty & process

- **B22 — False email-confirmation promises** — new CHANNELS YOU CAN REACH PEOPLE THROUGH block in `[systemPrompt.ts](src/core/orchestrator/systemPrompt.ts)` reads from `listConnections(profileId)` at prompt-build time and lists the active transports. When email/WhatsApp connectors are added, they auto-appear. Plus 1 line clarifying calendar invites are Outlook's job, not Maelle's. Replaces the wrong "tell Sonnet what she doesn't have" framing.
- **B20 + B21 — Self-contradiction + duplicate questions in one reply** — concision pass in `[postReply.ts](src/connectors/slack/postReply.ts)` extended with a third trigger: `looksSelfIncoherent` (≥2 question marks OR ≥2 "if-then" branches over the same unknown). Rewrite prompt extended with explicit instructions to drop hedge fans, pick one question, drop self-answering. Code-driven detection, Sonnet-driven judgment — matches owner's "process oriented, not prompt" framing.
- **B14a + B14b — Oran DM error leaked plumbing into wrong thread** — `[coord/state.ts:504](src/skills/meetings/coord/state.ts:504)` falls back to `searchPeopleMemory` lookup before throwing missing-slack_id error (resolves "she should know him from past mentions"). Failed-DM shadow text rewritten in human-EA tone (no "has no slack_id"). Shadow now posts top-level in owner DM (no `threadTs`) so failures don't leak into unrelated active conversations.
- **B23 — Default invite body** — `[calendar.ts](src/connectors/graph/calendar.ts)` `CreateMeetingParams.defaultBodyAuthor` optional field. Three call sites pass `${assistant.name}, ${owner.first_name} Assistant` — invites now read "Meeting booked by Maelle, Idan Assistant" instead of "scheduled by your executive assistant".
- **B19 — System routine `notify_on_skip` carve-out (#59 follow-up)** — `[crons.ts:411](src/tasks/crons.ts:411)` `update_routine` now allows `notify_on_skip` toggle on `is_system=1` routines (morning brief). Other fields stay immutable. The original auto-triage shipped Plan v1 without this; now caught up.
- **B15 — Brief multi-conflict aggregation** — `[briefs.ts:386](src/tasks/briefs.ts:386)` new prompt rule: when several meetings need owner decision on the same day, bundle them inline ("Wednesday has 3 meetings on your OOF (A, B, C) — which do you want me to move?") instead of per-item bullet enumeration with separate questions per item.

### Prompt cleanup (per owner: don't spam the prompt)

- **RULE 10 (Lunch window respect)** removed from `[systemPrompt.ts](src/core/orchestrator/systemPrompt.ts)`. With B1's deterministic move_meeting helper, the window check + outside-window approval flow are enforced in code; the prompt rule was redundant.
- **FLOATING BLOCKS elastic-within-window rule** at `[meetings.ts:1367](src/skills/meetings.ts:1367)` trimmed from a long teaching paragraph to a one-line pointer at `move_meeting` + the `lunch_bump` approval for outside-window moves. The "how to align / when no approval needed" details are now in code.
- **OUT OF BOUNDS proposal rule** at `[meetings.ts:1414](src/skills/meetings.ts:1414)` trimmed to drop the lunch-window reference (now redundant with B1) and `book_lunch` mention. Work-hours / buffer parts kept.

### CI

- **Auto-triage and auto-build workflows DEACTIVATED** ([13565e9](https://github.com/odahviing/coderepo/commit/13565e9)). Per owner direction: the agent diagnoses produced by auto-triage were missing the session/memory context (project_overview, feedback files, prior decisions) that interactive Claude Code uses to produce useful plans. Both workflows have logic intact but gated off via `if: false &&` at the top — they never fire on issue events. Re-enable by removing the `false &&` once the triage's input context can include memory + cross-session state.

### Migration

None. All changes are code-internal. Floating-block prompt cleanup is back-compat (the helper handles what the prompt was teaching).

### Closed

- [#61](https://github.com/odahviing/AI-Executive-Assistant/issues/61), [#62](https://github.com/odahviing/AI-Executive-Assistant/issues/62), [#63](https://github.com/odahviing/AI-Executive-Assistant/issues/63), [#64](https://github.com/odahviing/AI-Executive-Assistant/issues/64), [#65](https://github.com/odahviing/AI-Executive-Assistant/issues/65), [#66](https://github.com/odahviing/AI-Executive-Assistant/issues/66), [#67](https://github.com/odahviing/AI-Executive-Assistant/issues/67) — all closed in this version.

---

## 2.3.0 — Connection attachments + Graph TZ honesty + travel-aware coord + first auto-triage end-to-end

The wave that closes the loop on Connection-layer file support, fixes a quiet Graph timezone bug that made meetings book "at the right time" but stamped UTC, makes coord slot search travel-aware (S8 fix), and ships the first issue to round-trip cleanly through the auto-triage pipeline. Plus a brief-prompt fix for a self-contradicting morning brief and a workflow-side fix for the multi-label-at-creation race that had been silently skipping triage.

### Added

**File attachments on `message_colleague`** — `Connection.SendOptions.attachments` is a new optional field on `src/connections/types.ts`: `Array<{ sourceUrl, filename? }>`. Slack-specific shape today (other transports may interpret or ignore). `SlackConnection.sendDirect` downloads each Slack file URL with bot-token auth then re-uploads via `client.files.uploadV2` to the recipient's DM under the same thread; failures log + continue (text already posted, attachments are best-effort). `message_colleague` tool gains an `attachments[]` arg with snake_case `slack_file_url`; the DM branch maps to camelCase `sourceUrl` at the boundary. Architecturally the right cut: skills go through Connection (per the four-layer rule), other transports get to implement attachments their own way when they land. Closes S6's image-attachment gap.

**Per-routine `notify_on_skip` flag** (closes [#59](https://github.com/odahviing/AI-Executive-Assistant/issues/59), shipped via auto-triage commit [`ce059e7`](https://github.com/odahviing/AI-Executive-Assistant/commit/ce059e7)) — new `notify_on_skip INTEGER NOT NULL DEFAULT 0` column on `routines`. Default off preserves current quiet behavior. Owner opts in per routine via `update_routine` / `create_routine` tools. Two skip paths now check the flag: (1) `routineMaterializer.ts` `else` branch when all missed slots are past threshold; (2) `dispatchers/routine.ts` when the runner picks up a stale task. When set, sends one human-EA-toned DM ("Just so you know — your *X* routine was due earlier, but it was too late to run it usefully, so I skipped this round. Next one is …"). System routines (the morning brief) need a follow-up — `update_routine` filter `is_system = 0` blocks toggling the flag on them; tracked separately.

**`normalizeForGraph(iso, tz)` in calendar.ts** — strips any offset/`Z` from incoming ISO timestamps and re-emits in the target timezone's wall-clock, zoneless. Wired into both `createMeeting` and `updateMeeting` (start + end). Closes a quiet bug where Sonnet sometimes passed `'2026-04-29T07:30:00Z'` thinking she was being precise — Graph honored the `Z` and stored events in UTC even though we sent `timeZone: 'Asia/Jerusalem'` next to it. Owner-visible symptom: meeting booked at the right wall-clock time but tagged UTC instead of his TZ. Now every Graph mutation is consistent regardless of what shape the caller handed us.

### Changed

**Coord slot search is travel-aware (S8 critical)** — `coordinator.ts` now calls `getCurrentTravel(slackId)` before building both `colleagueTz` (used for participant.tz / dual-TZ rendering) and `attendeeAvailability` (used for slot-window clipping). When active, derives the IANA TZ via `inferTimezoneFromStateStatic(travel.location)` and recomputes work hours via `defaultWorkingHoursForTz`. Yael flying to Boston now gets slot search clipped to Mon-Fri 09:00-17:00 ET and the DM shows both Boston and Israel times, instead of clipping to her stored Israel hours. Two call sites (line 428 + line 502) both updated; shared travel-resolution at the boundary. Static map covers ~50 common cities; locations outside the map fall back to stored TZ (tracked in [#55](https://github.com/odahviing/AI-Executive-Assistant/issues/55) as low-priority follow-up).

**`getCurrentTravel` honors `from > today`** — past trips still auto-clear; future trips (saved ahead of departure) now return `null` so the stored profile remains the source of truth until the trip actually starts. Closes a small gap surfaced during the S8 trace: setting "Yael in Boston Jun 1-7" today wouldn't have made today's coord behave as if she were already there.

**Coord booking now sets a category fallback** — [coord/booking.ts:303](src/skills/meetings/coord/booking.ts:303) passes `categories: ['Meeting']` to `createMeeting`. Direct create_meeting tool already had this fallback; coord didn't. Coord-booked meetings were landing uncategorized — Outlook color tags missing in the calendar grid. Now matches.

**Brief prompt — no self-contradiction** — [briefs.ts:386](src/tasks/briefs.ts:386) gains a NO SELF-CONTRADICTION rule. If a colleague paragraph closes an item ("nothing to do", "handled", "booked"), the same item MUST NOT appear in ACTION ITEMS. Closes the owner-screenshot pattern where Maelle said "Yael's BiWeekly is booked, nothing to do there" and then listed the same booking under ACTION ITEMS as something to verify.

**Scenario 4 trimmed** — [.claude/test-scenarios.md](.claude/test-scenarios.md) — within-threshold lateness no longer expects a preamble DM. Per owner: short delays inside the lateness window are fine to fire silently; only full skips are worth flagging (see #59 for the per-routine opt-in to notify on skip).

### CI

**Auto-triage workflow accepts multi-label opened race** ([`6945eee`](https://github.com/odahviing/AI-Executive-Assistant/commit/6945eee)) — when an issue is created with multiple labels at once (Bug + Medium), GitHub fires `opened` + a `labeled` event per label; concurrency-cancellation kills earlier runs and the surviving event might be `labeled (Medium)` which the old `if:` rejected. New condition: in the labeled clause, also accept events where Bug is on the issue regardless of which specific label triggered. Triage now runs on whichever event survives the race. Surfaced via #57 (the first bug filed via auto-triage, before this fix); resolved end-to-end on #59.

### Migration

`ALTER TABLE routines ADD COLUMN notify_on_skip INTEGER NOT NULL DEFAULT 0` — idempotent migration in `db/client.ts initSchema()`. All existing routines stay silent-skip (default 0). Owner opts in per routine.

### Invariants preserved

- Skills still import only from `connections/types` + `connections/registry`. Attachments flow through Connection, not direct `app.client.files.uploadV2` calls from skills.
- Approvals still the single path for "needs owner input."
- All LLM calls remain Sonnet 4.6.
- Action tape (v2.2.6) + post-mutation verification (v2.2.6) untouched. The new `normalizeForGraph` complements them — verifier's ±60s tolerance covers the round-trip.

### Out of scope

- System routine carve-out for `notify_on_skip` (would let owner toggle on the morning brief). File as follow-up.
- Auto-triage `if:` re-tightening to skip re-runs on Approved-label adds (the fix worked but now over-fires; tracked but not landed in this version).
- File attachments on `sendBroadcast` / `sendGroupConversation` / `postToChannel` — same Slack mechanics work, scope kept to DM for this version.
- Action items "don't fish for confirmation" rule — owner deferred.

---

## 2.2.6 — action tape + post-mutation verification (close the "she booked it then forgot" loop)

Real screenshot from the owner: Maelle booked 7 lunches, owner thanked her, next turn she narrated "looks like all 7 were already on the calendar — the system had placed them when we planned the slots." Same bug class as issue #26 bug 1 (move-and-forget), the v2.1.0 RULE 2e, and the v2.1.3 same-turn RULE 2e expansion — three prior prompt-only attempts that all rotted. This patch replaces the prompt rule with a fact block Sonnet can't ignore, and closes the silent-failure gap that made the fact block unsafe to lean on.

### Added

**Action tape pinned to owner system prompt** — every owner turn with a `threadTs` now gets an `ACTIONS YOU TOOK IN THIS THREAD:` block listing the `[<tool> OK ...]` markers extracted from this thread's conversation history (mutation tools only, capped at 20 entries). Built in `orchestrator/index.ts` next to the existing `threadContextBlock`. Closing line acknowledges the tool-trust gap explicitly: *"If he says it didn't happen or the calendar shows otherwise, do NOT insist on this list — re-check via get_calendar and reconcile honestly. The list is what the tool reported, not ground truth."* Replaces the rotting RULE 2e prompt rule with pinned data.

**Post-mutation verification for create + move (closes [#54](https://github.com/odahviing/AI-Executive-Assistant/issues/54))** — new `verifyEventCreated` and `verifyEventMoved` exports in `connectors/graph/calendar.ts` mirror the v2.1.6 `verifyEventDeleted` pattern. Both delegate to a private `verifyEventStartMatches` that re-reads the event by id post-write and confirms the start time matches the requested value (±60s tolerance for Graph ISO normalization). Wired into `create_meeting` (after `createMeeting()` resolves, before the floating-block rebalance) and `move_meeting` (after `updateMeeting()`, gated on `args.new_start`, fail-fast before `closeMeetingArtifacts` / audit / shadow / rebalance — none of those cascades fire on a move that didn't land). On drift or 404, returns `{success: false, error: 'created_but_drift' | 'created_but_missing' | 'move_did_not_land' | 'moved_but_missing'}` so the action tape, claim-checker, and brief all see FAILED and narrate honestly. One Graph round-trip per mutation. Verifier errors (network blips) treat as OK to avoid false-positive blocks.

**`book_lunch` joined the outcome-aware tool list** — `summarizeToolCall` in `orchestrator/index.ts` now emits `[book_lunch OK ...]` / `[book_lunch FAILED ...]` markers for `book_lunch` calls alongside the other five mutation tools, so book_lunch outcomes enter the action tape.

### Removed

**RULE 2e (`systemPrompt.ts`)** — both SAME-TURN and FOLLOW-UP TURNS halves. Replaced by the action tape, which gives Sonnet the data she was missing instead of asking her to remember a rule. Keeping the rule alongside the tape would be duplicate prompt spam. The dangling "RULE 2e principle" cross-reference in `calendarHealth.ts` reworded to drop the dead pointer.

### Fixed

**She booked the meetings, then forgot she booked them** — owner-confirmed pattern from this session's screenshot. The combination of action tape (pinned facts) + post-mutation verification (silent-failure detection at the tool boundary) closes the loop end-to-end: Sonnet always sees what she did, and what she sees is always what actually landed.

### Invariants preserved

- Skills still import only from `connections/types` + `connections/registry`.
- Approvals still the single path for "needs owner input."
- All LLM calls remain Sonnet 4.6.
- Action tape is owner-only (colleague turns don't inject Maelle's action history) and only when `threadTs` is present.

### Migration

None. All changes are code-internal. Existing `verifyEventDeleted` callers unchanged. New verifier exports are additive.

---

## 2.2.5 — Lori onboarding wave: concision finalizer, tool-outcome honesty, slot binding, file routing

The wave that surfaced all of these was a real onboarding scenario: book four sequential meetings (Vision → Structure → Professional Services → Wrap-Up) with a new VP starting next week. The flow exposed deliberation leaking into Slack as walls of text, false "all done" claims when moves silently failed, slots drifting between proposal and booking, file uploads getting auto-misfiled into the KB instead of helping with the actual task, and the lack of an ordering primitive when meetings were sequential. All addressed in this patch with prompt rules + targeted code-level honesty hardening.

### Added

**Concision finalizer (`postReply.ts`)** — new pipeline stage between formatForSlack and claim-check. Triggers on length > 600 chars (excluding list-style replies) OR a deliberation pattern (`actually wait`, `on second thought`, `let me find`, `OK definitive proposal`, `wait, that breaks the order`, etc.). Calls Sonnet with the draft and asks for ONLY the final user-facing answer — strips self-correction, planning narration, intermediate proposals. Capped at ~100 output tokens, ~150 input. Falls back to original on any error. Backstops the base-prompt anti-deliberation rule for cases where Sonnet emits the entire derivation in a single text block (which the v2.2.4 last-text-block fix can't catch — that one only helps with multi-block emissions).

**Outcome-aware tool summaries** — `summarizeToolCall` in `orchestrator/index.ts` now reads the result of mutation tools (`create_meeting` / `move_meeting` / `update_meeting` / `delete_meeting` / `finalize_coord_meeting`) and emits `[<tool> OK event_id=...]` or `[<tool> FAILED: <reason>]` instead of just `[<tool>: ...]`. New `mutationOutcome()` helper detects positive shapes (`success: true`, `ok: true`, `meetingId`, `id`) vs negative shapes (`success: false`, `needs_owner_approval`, `needs_confirmation`, no result). Conservative on unclear shapes (treats as not-confirmed-success).

**`must_be_after_event_id` optional parameter** on `find_available_slots` and `create_meeting`. When the LLM is booking an ordered series, it can pass the predecessor's event id as a constraint — `find_available_slots` clips its earliest candidate to AFTER the predecessor's end (with the predecessor lookup bounded to a ±30-day window so the cost is fixed); `create_meeting` refuses with `error: 'order_violation'` when the proposed start is before the predecessor's end. Composable primitive, no new tables, no series concept — Sonnet self-chains by passing pointers. Optional and additive: existing call sites unchanged.

### Changed

**Claim-checker reads tool outcome, not tool presence** — prompt block updated to explicitly call out the v2.2.5 OK/FAILED markers. Success claims ("booked", "moved", "done", "all done", "locked in", "all four moved") are honest only when the matching summary contains `OK`. Aggregate claims need EVERY relevant mutation this turn to be `OK`; even one `FAILED` flags the aggregate as false. Closes the "Maelle says 'all four locked in' when M1 + M2 actually never landed" pattern.

**Four new prompt rules in `meetings.ts`:**

- *PROPOSED SLOTS ARE BINDING* — when the assistant offers specific slot times to the owner and he replies "book", "go", "yes", "do it", call `create_meeting` with those EXACT times verbatim. Don't re-search, don't round, don't second-guess. The conversation already converged.
- *REPAIR EXISTING MEETINGS WITH MOVE, NOT CREATE* — when meetings are wrongly placed and the owner asks to fix them, call `move_meeting` on the existing event ids; do NOT call `create_meeting` at the new slot (which would produce a duplicate sitting next to the misplaced original).
- *VERIFY TOOL RESULT BEFORE NARRATING SUCCESS* — every mutation tool returns a structured result; read it. Failure = no event id / `ok: false` / `needs_confirmation` / etc. Don't say "booked" / "done" / "all done" without verifying. Aggregate claims require every individual mutation this turn to have returned success.
- *DON'T COMPUTE AVAILABILITY FROM A STALE CALENDAR LISTING* — when the owner asks for an alternative slot, call `find_available_slots` (or `get_calendar` fresh). Don't reason about gaps from a calendar dump fetched earlier in the conversation. Closes the "I proposed 14:00 because Happy Hour ends then — wait, Product Weekly is at 14:00" contradiction.

**File-handling routing (`connectors/slack/app.ts`)** — doc uploads (.txt / .md / .pdf) now route through the orchestrator with the file content embedded in the user message, instead of auto-running `ingestKnowledgeDoc` on every upload. The orchestrator's full prompt + skill catalog decides what to do based on the caption — review meetings against the list, file as KB, summarize a transcript, or ask the owner what's intended. Caption-as-task is honored; KB ingestion no longer auto-fires on every file. Closes the misfile of "Lori onboarding plan" landing as a durable KB doc when the owner had asked for meeting review.

### Fixed

**Deliberation leaked as walls of text** — when Sonnet emits a single text block with the entire derivation embedded ("wait, that breaks the order again", "let me find", "OK definitive clean proposal"), the v2.2.4 last-text-block fix can't catch it (it only helps with multi-block emissions). Concision finalizer above now catches single-block deliberation.

**False "all done" claims when moves silently failed** — the claim-checker previously flagged "you said you sent X, was the tool called?" but didn't validate "you said you booked X, did the tool RETURN success?" Outcome-aware tool summaries + claim-checker prompt update close this. A failed move can no longer get reported as success.

**Slot drift between propose-and-book** — when Maelle proposed Mon 27 Apr 10:30 / Wed 29 Apr 13:15 and the owner said "book all", the bookings landed at different times (Mon 27 Apr 12:15 / Wed 29 Apr 12:30). The PROPOSED SLOTS ARE BINDING rule pushes Sonnet to call `create_meeting` with the exact proposed slot, not re-search.

**Auto-misfile of task-instruction file uploads** — owner sent an onboarding plan with caption "go over the list and mark all the meetings relevant for me", Maelle filed it as `reflectiz/team/lori_onboarding_plan.md` in the KB instead of doing the review. Routing change above. Misfile from before this patch was deleted manually.

### Migration

None — all changes are code-internal. No new schema, no profile-level toggles. `must_be_after_event_id` is optional; existing call sites continue working unchanged.

### Invariants preserved

- Skills still import only from `connections/types` + `connections/registry`.
- Approvals still the single path for "needs owner input."
- Owner > person > auto provenance unchanged.
- All LLM calls remain Sonnet 4.6.

---

## 2.2.4 — 8-bug wave from real Yael reschedule trace + tasks-first brief

A single bad reschedule scenario (Yael in Hebrew asking to move a recurring BiWeekly from Sunday in Israel to a Wednesday afternoon in Boston) surfaced eight independent bugs across language matching, deliberation leak, shadow chatter, outreach handoff, travel awareness, thread propagation, duration handling, and location selection. All eight fixed in one wave. Brief refactored to a tasks-first spine in the same wave (separate root cause, but it was on deck and the wave bundles cleanly).

### Added

**Travel awareness (`currently_traveling`)** — new column on `people_memory`, JSON `{ location, from, until }`. Stored profile (timezone, state) is the *default*; when a colleague is travelling somewhere else for a stretch, this overrides for the window. Set via `update_person_profile.currently_traveling` (owner direction) or by Maelle when the colleague volunteers it ("I'll be in Boston that week"). New helpers `setCurrentTravel` / `clearCurrentTravel` / `getCurrentTravel` in `db/people.ts` — `getCurrentTravel` lazy-clears past windows on read so callers don't filter. Surfaced in WORKSPACE CONTACTS prompt block (`formatPeopleMemoryForPrompt`) as "currently in Boston until 22 Jun" right next to the default state/tz.

**Tasks-first morning briefing** — brief now reads the tasks table as the spine and hydrates outreach/coord-backed tasks via `skill_ref` for narration data. Replaces the prior three-parallel-queries-with-dedup model where outreach_jobs / coord_jobs / tasks each had their own visibility filters and a booked coord could keep resurfacing for 7 days regardless of `informed`. The `completed → informed` two-step now governs every surface uniformly. New `getBriefableTasks(ownerUserId, since)` helper. New helper functions `buildOutreachItem` / `buildCoordItem` / `buildTaskItem` in `briefs.ts`. `BriefingData.outreachIds + coordIds + completedTaskIds` collapsed to one `taskIdsToInform`. Defensive linked-task closure on `updateOutreachJob` (terminal `done`/`replied` → task completed; `cancelled`/`expired`/`failed` → cancelled) and `updateCoordJob` (`booked` → completed; `cancelled`/`abandoned` → cancelled) so any future code path that flips a detail-row terminal status keeps the spine clean.

**Discovery-mode social coda** — `generateSocialCoda` reframed for the empty-topic case. Without an existing topic to continue, the coda used to be free to fabricate ("Are you joining the offsite next month?" when there's no offsite). Now `raise_new` mode prompts Sonnet to ask a *concrete, discoverable* question — something whose answer is a real fact about the person Maelle would save to memory. Explicit ban on inventing events / projects / shared context.

### Changed

**Base prompt language rule generalized.** Existing "current turn wins" rule now sits next to a new "language of artifacts that land elsewhere — match the destination, not this turn" rule. One rule, every skill / tool / coda inherits — owner-facing artifacts (approval ask_text, brief, shadow notifications) always render in owner's language even when the work originated in a Hebrew thread with a colleague. Replaces ad-hoc per-skill language hints.

**Stored profile is a default — fresh signals win.** New base-prompt rule. When a colleague's message contradicts stored profile data ("Boston time" vs stored Asia/Jerusalem), the fresh signal wins for this conversation; ASK to confirm and update via `currently_traveling`, don't DECLARE the profile is right and the signal wrong.

**Anti-deliberation rule.** New base-prompt rule banning "Actually wait", "On second thought", "Let me ask", "Per the instructions" and similar deliberation/self-correction text in user-facing output. Decide, then write the answer.

**Shadow notifications consolidated.** Was firing four separate shadow DMs per coord reshuffle (DM sent → Reply received → Renegotiating → Round 2 started). Now one decision-worthy event per cycle: counter-received-and-acting on it. The intermediate state-hop shadows are dropped.

**`message_colleague` description rewritten** — `intent='meeting_reschedule'` is now MANDATORY (not optional) when the message is about moving an existing meeting, regardless of whether the owner or colleague initiated. Without the intent tag, the colleague's "yes" reply was getting routed to the new-schedule classifier → spawning a duplicate coord instead of patching the existing event. Symptom: colleague says "got it, send me the invite" but no invite arrives.

**Outreach reply classifier (`processOutreachReply`)** — anchors today's date in the prompt so partial date references in replies ("Wed 17 Jun") resolve to the right year. Tightened the SCHEDULE branch: reschedule conversations are CONTINUE not SCHEDULE; SCHEDULE is for fresh meeting requests only.

**Outreach handoff `topic`** — the literal "Handoff from outreach conversation — X prefers ..." phrase is gone from `coord_jobs.topic`. It was internal framing leaking into the colleague's DM.

**Outreach handoff narration** — single-participant handoffs now use gendered pronouns ("she wants" / "he wants") instead of plural "they want", and the framing is human ("My conversation with Yael turned into scheduling — she wants time for X. I'm sending her options now.") instead of templated.

**Location selection (`determineSlotLocation`)** — new `anyParticipantRemote` parameter short-circuits the in-person branches. When any participant is currently traveling (or otherwise remote), the meeting defaults to online. No more "Idan's Office" booked for a meeting where the colleague is in Boston. Wired through every call site: `coordinator.ts` handoff, `meetings.ts coordinate_meeting`, `coord/state.ts triggerRoundTwo`, `coord/booking.ts` fallback.

### Fixed

**Internal reasoning leaked into user-facing replies** — orchestrator was concatenating ALL text blocks Sonnet emitted in a single assistant turn with `\n`. When Sonnet thought aloud (multiple blocks: "Actually wait —", "On second thought —", "Let me ask."), the entire deliberation chain dumped to Slack including raw slack_ids and instruction-quote leaks. Now takes only the LAST text block — that's Sonnet's final answer; multi-paragraph replies are typically a single block with newlines so legitimate replies are preserved. Anti-deliberation base-prompt rule backstops it. Logs a warning when multiple text blocks were emitted so we can tell if Sonnet keeps doing it.

**Outreach reply classifier spawned zombie second handoffs** — every fresh `message_colleague` in a back-and-forth created a new outreach_job, and every reply triggered a fresh handoff classification → duplicate coord coords spawned (zombie second/third handoff DMs landing on the colleague with stale + wrong slot proposals after the original conversation already converged). Idempotency guard added: when a coord_job for this colleague is already in flight in the last 24h, the schedule branch is skipped entirely — reply routes as a CONTINUE relay; owner progresses through the existing coord/reschedule machinery.

**Outreach reply branch broke out of thread** — the CONTINUE branch in `coordinator.ts` opened a fresh DM via `openDM` and posted at top level with no `thread_ts`. v2.1.5 had added `outreach_jobs.dm_message_ts` + `dm_channel_id` precisely so follow-ups could land in the same DM thread; the branch wasn't reading them. Now routes through `Connection.sendDirect(senderId, text, { threadTs: job.dm_message_ts })` with raw-client fallback for the Connection-not-registered edge case.

**Classifier-guessed durations could land at illegal lengths** — `processOutreachReply` extracted a free-text duration guess from Sonnet ("60") and used it directly. Idan's profile has 55 in `meetings.allowed_durations` — a 60-minute slot is explicitly off the menu. Handoff branch now snaps the guess to the nearest entry in `profile.meetings.allowed_durations` before searching slots.

**Coda fabricated topics on cold colleagues** — `raise_new` directive let Sonnet invent specifics ("Are you joining the offsite next month?" when there is no offsite). Discovery-mode prompt rewrite plus owner-path-only gate on the coda branch (no piggyback on colleague turns; the colleague is there for help, not chat).

**Coda language drift** — coda generator had no language hint; defaulted to English regardless of conversation. Now passes `language: 'he' | 'en'` from orchestrator (Hebrew character detection on inbound) so the coda matches the surrounding conversation.

**IANA timezone names leaked into user-facing text** — "she's based in Israel (Asia/Jerusalem)" — `Asia/Jerusalem` is internal data format. New regex strip in `textScrubber.ts` matches IANA tokens (`Region/Subregion`) and replaces with the city/region portion (`Asia/Jerusalem` → `Jerusalem`, `America/New_York` → `New York`).

### Migration

- New column on `people_memory`: `currently_traveling TEXT`. Idempotent ALTER, safe rollback.
- The `outreach_jobs.briefed_at` column is now dead (read+written by no one); kept for one version for safe rollback, can be dropped in a follow-up patch.

### Invariants preserved

- Skills still import only from `connections/types` + `connections/registry`.
- Approvals still the single path for "needs owner input."
- Owner > person > auto provenance unchanged.
- All LLM calls remain Sonnet 4.6.

---

## 2.2.3 — Persona toggle (#3) + attendee availability (#43) + 5 scenario fixes

Big patch: closes #3 and #43, plus inline fixes for scenarios 7-9 surfaced this session, plus a real lunch-detection bug from your screenshot.

### Added

**Persona skill (#3)** — togglable social / off-topic chat layer. New `src/skills/persona.ts`. `skills.persona: true | false` (default false). When ON: Social Engine pre-pass, `note_about_person`/`note_about_self` tools, social directive prompt block, social context block in prompt, social outreach tick + decay tasks. When OFF: strictly business — none of the above fires. Read fresh per turn (YAML edit takes effect on next message). Idan's profile flipped to `true` to preserve current behavior.

**Attendee availability honored in slot search (#43)** — owner direction adopted: don't assume attendee meetings are movable. New shape:
- `findAvailableSlots` accepts `attendeeAvailability[]` (work-window per attendee in their TZ) — slots outside any attendee's window dropped pre-Graph (pure math, no API cost).
- `findAvailableSlots` accepts `attendeeBusyEmails[]` for opt-in deeper search (default: owner-only busy filter).
- New `src/utils/annotateSlotsWithAttendeeStatus.ts` — one getFreeBusy call per attendee, returns each slot tagged `free / busy / tentative / oof / unknown`.
- Coord caller (`connectors/slack/coordinator.ts`) builds availability from people_memory (`getEffectiveWorkingHours`) and threads through.
- Coord DM render: slot lines now show `(looks free)` / `(you look busy)` / `(you're out of office)` tags. Cross-TZ shows BOTH times: `"Wed 14:00 / 19:00 Idan's time"`.
- All-busy + internal participant → DM appends opt-in offer: *"Looks like all three are busy on your end — want me to look for times you're free?"* Externals never see this offer.

**Anti-spam lock for proactive social** — new `proactive_pending` column + `setProactivePending` / `clearProactivePendingOnInbound`. When socialOutreachTick sends a proactive ping, the lock flips on. Cleared ONLY by inbound message from that person — outbound (task-driven DM Maelle sends) doesn't clear. Filtered out of `pickCandidate` so no second cold ping until they respond.

**Cleanup cascade for externally-cancelled meetings** (scenario 7 row 1) — new `src/utils/cleanupVanishedMeetingArtifacts.ts`. Brief pre-pass sweeps owner's pending approvals / open follow_up tasks / in-flight reschedule outreach. For each referenced meeting_id, calls `verifyEventDeleted`. Gone from Graph → fires the existing `closeMeetingArtifacts` cascade. Brief no longer surfaces "needs your input" for events the organizer cancelled overnight.

**Floating-block rebalance after mutation** (scenario 8 row 7) — new `src/utils/rebalanceFloatingBlocks.ts`. Wired into `move_meeting` and `create_meeting` handlers. After successful Graph mutation, tries to re-place each affected floating block in its preferred window. Found in-window slot → silent move + shadow DM. No in-window slot → leave overlapping + ping owner (the bumping-out-of-window decision still belongs to him via existing lunch_bump approval flow).

**All-day busy events block their entire day** (scenario 9 row 7) — `findAvailableSlots` now injects all-day busy events as full-day blocks into the busy pool. All-day free events ignored (unchanged). Belt-and-suspenders against Graph free/busy quirks where an all-day offsite could leak through.

### Fixed

**Lunch detection missed real lunch events** (today's screenshot) — `analyzeCalendar` lunch detector still hardcoded `subj.includes('lunch')` (English-only). Owner direction: lunch IS subject-based but Hebrew variants must be covered. Now matches English `lunch` + Hebrew `ארוח` (covers ארוחת/ארוחה) + `צהריים`. Plus new explicit `is_lunch: boolean` flag on every `ProcessedEvent` so `get_calendar` consumers (Sonnet narrating raw events for "how does my week look?") see the marker directly instead of inferring from subject mid-narration.

**socialOutreachTick narrowed** — workdays now Mon-Thu only (safe intersection of IL Sun-Thu and US/EU Mon-Fri). 72h recency gate — proactive ping requires last interaction within 72h. Owner-time-agnostic preserved.

**Log noise** — "no eligible candidate this hour" + system-tick task creation + "Running due tasks" demoted to debug when only social_outreach_tick / social_decay are due. User-facing tasks still log at info.

### Tickets

- Closed [#3](https://github.com/odahviing/AI-Executive-Assistant/issues/3) (persona toggle).
- Closed [#46](https://github.com/odahviing/AI-Executive-Assistant/issues/46) — already closed in 2.2.2 build.
- [#43](https://github.com/odahviing/AI-Executive-Assistant/issues/43) implementation in tree — opt-in deeper-search re-coord wiring deferred (owner can decide if needed).
- Filed [#52](https://github.com/odahviing/AI-Executive-Assistant/issues/52) (action log for undo support, Low) and [#53](https://github.com/odahviing/AI-Executive-Assistant/issues/53) (autonomous reminder action, Medium) earlier in session.

### Migration

- New columns on `people_memory`: `proactive_pending INTEGER NOT NULL DEFAULT 0`. Idempotent ALTER.
- Profile YAML: `skills.persona: boolean` added (default false). Existing profiles without it get strictly-business Maelle. Idan's profile flipped to `true`.

### Invariants preserved

- Skills still import only from `connections/types` + `connections/registry`.
- Approvals still the single path for "needs owner input." `move_meeting` colleague-path falls back to approval when rules break.
- Owner > person > auto provenance unchanged.

---

## 2.2.2 — Core attendee info: collection layer with provenance (#46)

Closes #46. Three core fields about every person Maelle works with — gender, state (city/country), timezone — now collected with an authority chain (owner > person > auto) so the right value lands in the right place and can't be silently overwritten by a lower-rank source.

### Added

- **`setCoreFieldWithProvenance(slackId, field, value, by)`** in `src/db/people.ts` — single choke-point for writing gender / timezone / state with provenance. Owner overrides anyone; person overrides only auto; auto can't overwrite a set value. Anti-spoofing built in.
- **`state` column** on `people_memory` — free-text location ("Israel", "Boston", "Tel Aviv"). When set, derives + saves a matching IANA timezone via `src/utils/locationTz.ts` (static map for common cases, Sonnet fallback for the long tail). One-way only — knowing ET doesn't reveal Boston vs NYC.
- **`<field>_set_by` provenance columns** — `gender_set_by`, `timezone_set_by`, `state_set_by`. NULL = legacy/unknown (treated as lowest precedence).
- **`working_hours_auto` column** + `src/utils/workingHoursDefault.ts` — derived from timezone defaults. Israel TZ → Sun–Thu 09:00–17:00. Other TZ → Mon–Fri 09:00–17:00. `getEffectiveWorkingHours(person)` reader — manual `working_hours_structured` (owner-set) wins over auto.
- **`Connection.collectCoreInfo?(ref)`** — new optional method on the Connection interface (`src/connections/types.ts`). SlackConnection wraps `users.info` to return `{ timezone, pronouns, imageUrl, email, displayName }`. Future EmailConnection / WhatsAppConnection implement the same shape — no skill code changes when those land. Decoupled per the #22 lesson.
- **`update_person_profile.state`** — new tool arg. Owner-stated location auto-derives timezone with `set_by='owner'` provenance.

### Changed

- **`upsertPersonMemory`** now accepts optional `timezoneSetBy` arg and writes `timezone_set_by` on first set. Refreshes `working_hours_auto` whenever timezone lands.
- **`confirm_gender`** is provenance-aware — owner-path call sets `gender_set_by='owner'`, colleague self-confirm sets `gender_set_by='person'`. Higher-rank lock returns `confirmed: false, reason: 'higher_authority_already_set'` so the LLM doesn't claim it saved.
- **`genderDetect.ts` auto-detection** routes through the provenance helper as `set_by='auto'` — any direct statement from owner / person overrides automatically.
- **`formatPeopleMemoryForPrompt`** — dropped the `missing: <fields>` tag (owner direction: don't visibility-pressure asking). Now shows `state:` when known.
- **LEARNING prompt block rewritten.** Dropped the CORE PERSON INFO interrogation rule from 2.2.1. New rule: owner-volunteered facts are highest authority, save immediately. Don't proactively ask owner. Only ask when a task needs a field AND Slack auto-pull came up empty. Person-self statements beat auto; owner can override anything (anti-spoofing).

### Tickets

- Closed #46 (collection layer).
- Filed [#51](https://github.com/odahviing/AI-Executive-Assistant/issues/51) — Hebrew gender discovery from message content (Low, blocked on email + WhatsApp connector tickets).
- [#43](https://github.com/odahviing/AI-Executive-Assistant/issues/43) (use attendee availability in booking) — still open Medium. Data is now collected; the slot-search intersection is the remaining work. Scenarios 1 row 6 + 3 row 1 unblock when #43 ships.

### Migration

- New columns added to `people_memory` via idempotent `ALTER TABLE` in `db/client.ts`. NULL legacy values treated as lowest-precedence (auto).
- `working_hours_auto` populated lazily — first time a person's timezone is read/written via the new path, the column gets filled.

### Invariants preserved

- `gender_confirmed=1` legacy column still set whenever `gender_set_by` is `owner` or `person`. Existing readers see no change in lock semantics.
- Skills still import only from `src/connections/types` + `src/connections/registry`. The new `collectCoreInfo` method respects the boundary.

---

## 2.2.1 — Per-person md memory, inbound reschedule autonomy, social conversation_state, post-approval health check

Scenario-driven session — paper-ran scenarios 1–4 and fixed the gaps that surfaced.

### Added

- **Per-person md memory** (`src/memory/peopleMemory.ts`). Operational facts about people now live as `.md` files under `config/users/<owner>_people/` (KB pattern). Lightly sectioned: Residence, Workplace, Working hours, Communication style, What we've discussed. Catalog (~80 tokens) injects into owner prompt every turn; full content fetched on-demand via `get_person_memory(<slug>)`. Writes via `update_person_memory(<slug>, <section>, <text>)` — empty-until-real-fact. Owner is just another person file. Closes the "Maelle never knew Idan lives in Nes Ziona" gap. The 8-dim `PersonProfile.profile_json` rendering retired from the prompt; structured fields code paths read (gender, timezone, engagement_rank, working_hours_structured) stay in SQLite.
- **Inbound reschedule auto-accept** (colleague-path `move_meeting` in `skills/meetings/ops.ts`). When a colleague DMs to move a meeting, she mutates the calendar autonomously IF the new slot is rule-compliant — `findAvailableSlots` narrow-window check (work hours, work days, buffers, floating blocks, conflicts). Compliant → silent move + shadow-DM owner. Non-compliant → returns `needs_owner_approval: true`; Sonnet falls back to `create_approval(kind=meeting_reschedule)`. `move_meeting` added to `COLLEAGUE_ALLOWED_TOOLS` with the gate enforced in-handler.
- **Post-approval health check** (`src/utils/postBookingHealthCheck.ts`). After `slot_pick` / `calendar_conflict` approve+book, sweep the affected day via `analyzeCalendar` and DM owner if new issues land (Maya still in slot we gave Ron, displaced block, etc). Fire-and-forget; never blocks the resolver. Closes the domino gap from scenario 3.
- **Core attendee-info collection** (#46). `formatPeopleMemoryForPrompt` tags each contact with `missing: <fields>` (gender, timezone, working_hours, language_preference). New CORE PERSON INFO block in owner LEARNING prompt: ask naturally when missing, infer-and-confirm from cues, never silent-guess. New `working_hours_structured: { workdays, hoursStart, hoursEnd, timezone? }` on `PersonProfile`, exposed via `update_person_profile.working_hours_structured` — scaffolding for #43's slot-search intersection.

### Changed

- **Social classifier — `conversation_state: 'open' | 'closing'`** (`src/core/social/classifyOwnerIntent.ts`). New required output, distinct from `kind`. `closing` suppresses social directive in both branches — no force-continuing topics the person is winding down. `engage` directive prompt rewritten: must PROGRESS the topic ("wow cool" isn't progress), never pivot to "anything work-related" unless person closed. OTHER tightened with cut-the-ack test ("Good. I'm usually dodging" → SOCIAL). Recent context (last 4 turns) now passed to classifier so silence-after-question is detectable. Closes the gaming-thread-killed bug.
- `create_meeting` subject + body must be English regardless of conversation language. Tool description + arg descriptions updated. Calendar invites are shared artifacts; language must be predictable. SummarySkill already enforced English.

### Tickets / process

- Issue #43 split into three: #46 (collection, High — shipped), #43 itself repurposed Medium ("Honor attendee availability in booking and outreach"), #48 (coord clarify-and-resume sub-state, Medium).
- Filed #45 (save if-then handling rules, Low).
- Renamed #33 → "Accept or decline calendar invites".
- Moved #12 (Hebrew voice quality) from Improvement to Roadmap.
- Scenarios 1 + 2 edited inline (cold-stranger gate dropped, three-reschedules beat dropped).

### Migration

- `PersonProfile.working_hours_structured?: { workdays, hoursStart, hoursEnd, timezone? }` added alongside legacy free-text `working_hours`. JSON column — no schema migration.
- New dir `config/users/<owner>_people/` created on demand by first `update_person_memory` write. Empty until then.
- WORKSPACE CONTACTS block in owner prompt no longer renders the 8 `PersonProfile` dimensions — they're md territory now. Existing rows untouched.

---

## 2.2.0 — Social Engine: bi-directional topic engine + proactive colleague outreach

First real social layer. Three subsystems sharing the same primitives.

**Global category pool.** 30 fixed top-level interest categories seeded ONCE globally on startup (family, kids, gaming, tech, travel, etc — plain nouns, non-overlapping). Shared across owner AND all colleagues — the same `gaming` row is used when tracking Idan's "Clair Obscur" and Yael's "Clair Obscur" as distinct topics. No new categories ever created at runtime.

**Per-person topic tracking.** Topics live UNDER categories and are scoped per-`person_slack_id`. Created on first mention, they carry `engagement_score` (0–10 cap), `status` (active|dormant), `last_touched_at` + `last_touched_by`. A pre-pass Sonnet classifier tags every owner OR colleague message as task|social|other; **task always wins** (social machinery skips entirely). Social turns produce a deterministic directive (celebrate|engage|revive_ack|continue|raise_new|none) the LLM reads to pick tone and mode. Round-robin rotation prevents Maelle from hammering the same topic — she picks topics she hasn't touched in 3+ days first. Weekly decay drops -1 from active topics untouched 7+ days; topics at score 0 flip to dormant (kept in memory, Maelle won't raise them, person can revive by mentioning them again).

**Three initiation paths for Maelle, task always wins:**

1. **Person → Maelle** (reactive) — anyone shares something, classifier tags it, reconciler finds/creates the topic, state machine emits a directive, Sonnet stays in human mode (celebrate/engage/revive_ack). No special trigger needed.

2. **Piggyback on 'other'-kind turns** — when someone sends an ack/greeting/no-action message, `directiveForProactiveSlot` fires for that person. If 24h+ since Maelle's last initiation with them AND a continuable or raise-new option is available, social weaves into THIS thread's reply — no separate DM.

3. **Piggyback on parking-task turns (task-coda)** — task always wins, BUT when a task produces a "parking" tool call (`coordinate_meeting` / `message_colleague` / `create_approval` / `outreach_send`) Maelle is waiting on someone else. In that slack she appends ONE coda sentence via `src/core/social/generateCoda.ts`. Task reply comes first; coda is a new line after. Never fires on immediate-completion tasks (create_meeting / delete_meeting / pure reads). Once per 24h per person gate applies.

4. **Maelle → Colleague cold DM (`social_outreach_tick`)** — hourly system activity, owner-time-agnostic. Sweeps known colleagues, finds those currently in their LOCAL 13:00–15:00 window on a work day, engagement_rank > 0, 5-day cooldown respected, prior interaction history, no active conversation mid-flight. Picks at most one per owner per day, generates a short warm ping via Sonnet tool_use, sends via DM, shadow-DMs the owner, schedules a rank-check 48h out. Config gated by `behavior.proactive_colleague_social.enabled` (default false — opt-in per profile).

**Engagement rank 0–3 per person (replaces legacy 5-level string).** 3 = loves to chat, 2 = neutral default, 1 = minimal, 0 = opt-out (Maelle never initiates). Auto-adjusts:
- Cold DM rank-check at 48h: engaged reply >30 chars → +1; no reply → -1.
- In-conversation rank check (same 24h window): post-turn, if colleague replied socially to Maelle's recent piggyback/coda, same table applies via `adjustRankFromColleagueResponse`.
- Owner directive via `update_person_profile.engagement_rank` arg ("never ping Ysrael" → rank 0).

**Fixes the "rude response" class.** The pre-pass classifier catches "One Axos down!" as a positive share, directive tells Sonnet to celebrate and not pivot to tasks. The old recovery pass (colleague-gated in 2.1.5) no longer has the chance to generate owner-narrative text about a colleague since the social layer handles turns explicitly.

### Added

- `src/db/socialTopics.ts` — Social Engine CRUD: categories, topics, engagements, scoring, weekly decay (`runWeeklyDecay`).
- `src/db/engagementRank.ts` — per-person numeric 0–3 rank (replaces legacy 5-level string enum). `adjustEngagementRank(slackId, delta, reason)` with audit log to `engagement_rank_log`. Migrates legacy `profile_json.engagement_level` at startup.
- `src/core/social/classifyOwnerIntent.ts` — Sonnet tool_use classifier for every owner turn (task|social|other).
- `src/core/social/reconcileTopic.ts` — fuzzy topic matcher + first-mention creation + dormant revival.
- `src/core/social/stateMachine.ts` — deterministic directive producer. Round-robin continuation; category-aware.
- `src/core/social/logEngagement.ts` — post-turn score + engagement log writer. FirstMention flag prevents double-counting when a topic is created and scored in the same turn.
- `src/tasks/dispatchers/socialDecay.ts` — weekly decay, self-rescheduling 7d.
- `src/tasks/dispatchers/socialOutreachTick.ts` — hourly proactive colleague ping.
- `src/tasks/dispatchers/socialPingRankCheck.ts` — 48h-after rank adjustment.
- `scripts/stress-test-social.mjs` — in-memory 7-day simulator covering three scenarios (owner silent / owner chatty / dead topic). Run via `node scripts/stress-test-social.mjs`. Sweet spot finding: 3–5 active topics per person is the natural equilibrium.
- New task types: `social_decay`, `social_outreach_tick`, `social_ping_rank_check`.
- `update_person_profile` tool gains `engagement_rank: 0|1|2|3` optional arg for owner-directive override ("never ping Ysrael" → rank 0).
- Profile YAML: `behavior.proactive_colleague_social` block — `{ enabled, daily_window_hours, cooldown_days, skip_weekends }`, default disabled.

### Changed

- Orchestrator owner-path now runs the social pre-pass before the tool loop. Directive injected as a system prompt block. Post-turn logger fires when directive was non-none.
- `buildSocialContextBlock` surfaces the new numeric `engagement_rank` instead of the legacy string `engagement_level`. Topic history section removed — handled by the Social Engine now (for owner turns the directive replaces it).
- Orchestrator splits social context: owner turns use the directive; colleague turns use the simplified people_memory context block.

### Fixed

- "Rude response" class of bug: Maelle no longer defaults to "what do you need from me?" when the owner shares a win, vents, or small-talks. The pre-pass classifier tags it, the state machine produces a celebrate/engage directive, Sonnet reads the directive and stays in human mode.
- Round-robin topic selection prevents Maelle from asking about the same topic every continuation turn.
- Double-count bug where a newly-created topic + owner_initiated score boost would push a new topic from 0 → 5 → 10 in one turn.

### Removed

- Legacy `people_memory.social_topics` JSON column — dropped on startup migration (owner OK'd reset).
- `src/core/socialEngagement.ts` post-turn quality upgrader — owner signals now logged by `logEngagement.ts`, colleague rapport no longer tracks topic-quality upgrades.
- `SOCIAL_STALE_COUNT_THRESHOLD`, `SOCIAL_LONG_SILENCE_HOURS`, `SEED_TOPIC_AREAS` from `db/people.ts` — replaced by engagement_score + decay + fixed category list.
- `markPendingEngagement` / `checkAndUpgradeEngagement` call sites retired from orchestrator + `assistant.ts`.

### Added — refined during the 2.2.0 rollout

Follow-up shipped in the same release as the core Social Engine, after a scenario audit surfaced gaps in the initial scope:

- **Per-person topic scoping.** Categories stay global; topics gain `person_slack_id` column — Idan's and Yael's "Clair Obscur" become distinct rows under the same global `gaming` category.
- **Classifier runs on colleague turns too.** Previously owner-only, now symmetric. `senderRole`-aware prompt so questions are framed correctly.
- **Piggyback proactive social on 'other'-kind turns.** `directiveForProactiveSlot` fires when someone sends an ack/greeting and Maelle's 24h cadence gate is open.
- **Pattern 1 task-coda social.** Post-turn hook detects parking tool calls (`coordinate_meeting` / `message_colleague` / `create_approval` / `outreach_send`) and, when the 24h gate is open, generates one coda sentence via `src/core/social/generateCoda.ts` (Sonnet tool_use). Appended after the task reply, never replacing it.
- **In-conversation rank adjustment.** `adjustRankFromColleagueResponse` in `logEngagement.ts` — when a colleague responds socially within 24h of Maelle's initiation, engagement_rank nudges ±1.
- **`.claude/test-scenarios.md`** — 10 standalone real-life pressure-test scenarios. Plain-English stories, not code specs. Triggered by "test scenario N" / "run scenario N" / "simulate scenario N" → the chat opens the file, code-traces the scenario against current files on disk, produces a report (works / doesn't work / shouldn't happen + concrete fix suggestions). Paper exercise only — no live tool calls, no real DMs, no DB writes.
- **SESSION_STARTER.md trigger** — one new paragraph near the top referencing the scenarios file and enforcing the "paper exercise, never execute for real" rule.

### Migration

- `ALTER TABLE people_memory DROP COLUMN social_topics` (legacy JSON retired)
- `ALTER TABLE people_memory ADD COLUMN engagement_rank INTEGER NOT NULL DEFAULT 2`
- `ALTER TABLE social_topics_v2 ADD COLUMN person_slack_id TEXT NOT NULL DEFAULT ''` + backfill
- `ALTER TABLE social_engagements ADD COLUMN person_slack_id TEXT NOT NULL DEFAULT ''` + backfill
- Wipe old per-owner category rows on startup so the global seed repopulates cleanly
- New tables: `social_categories` (global scope), `social_topics_v2`, `social_engagements`, `engagement_rank_log`
- On startup, `migrateLegacyEngagementLevel` translates `profile_json.engagement_level` strings → numeric rank (avoidant→0, minimal→1, neutral→2, friendly→3, interactive→3). Idempotent.

### Follow-up tickets

- [#43](https://github.com/odahviing/aI-Executive-Assistant/issues/43) — Learn colleague timezones proactively + TZ-aware `findAvailableSlots` + coord state machine "clarify and resume" + structured per-person working hours (Medium; expanded scope from the scenario audit).
- [#44](https://github.com/odahviing/AI-Executive-Assistant/issues/44) — Enrich social openers with web search (Low). For first-time contacts, a light search pass before the opener to seed context.

### Stress-test findings

Run `node scripts/stress-test-social.mjs` any time. Current findings:

- **Owner silent, Maelle initiates daily**: round-robin alternates topics correctly. Scores decay from 5 to 2 over 6 days of neutral responses. Maelle raises a new topic when continuation pool drops below score threshold.
- **Owner raises new topic daily for 7 days**: all land at score 5 (owner-initiated boost). Spread cleanly across categories. No saturation risk under the 30-category ceiling.
- **Dead topic (Maelle raises, owner always flat)**: hits dormant in ~3 days. Maelle stops trying. Clean exit behavior.
- **Sweet spot**: 3–5 active topics per person. Below that, round-robin degenerates. Above that, the dormant graveyard grows faster than decay clears it.

### Known gaps carried into follow-up releases

- **Post-booking social injection.** Coord booking confirmation to colleagues is still templated (not Sonnet-generated). If the colleague doesn't react after the booking lands, there's no in-turn slot for Maelle to weave in social. Today's workaround: the colleague's reactive turn after booking (if any) catches the piggyback path. Potential fix: Sonnet-generate the confirmation with an optional social coda.
- **Silent-ignore rank drop for in-conversation social.** If Maelle raises social via piggyback / coda and the colleague literally doesn't respond (no next turn at all), the `adjustRankFromColleagueResponse` pass never fires — no rank drop. The 48h `social_ping_rank_check` task only covers the `social_outreach_tick` (cold DM) path. A parallel timer for piggyback would close the loop.
- **Owner-initiated DM when no active thread.** Maelle can piggyback social on any turn Idan sends (task-coda, other-kind piggyback). If Idan goes dark for days, no proactive ping to him. A once-a-day `owner_social_tick` analog to the colleague tick would fix this.

None of these block today's use; all are narrow follow-ups tracked as scenario findings.

---

## 2.1.6 — meeting state-change cascade, calendar pagination, post-delete verification, event-id scrub

Four fixes prompted by day-after-2.1.5 QA. The biggest is a centralized cleanup helper — every meeting mutation (move, update, delete) now runs the same cascade that closes pending approvals, cancels follow-up tasks, and closes outreach rows tied to that meeting. The other three harden specific failure modes: `get_calendar` silently truncated at 100 events (now paginates), `delete_meeting` trusted the Graph response (now re-verifies), and raw Graph event IDs leaked into owner-facing narration (now stripped).

### Added — single-choke-point cleanup on every meeting mutation

New helper `src/utils/closeMeetingArtifacts.ts`. One function, called after every successful `move_meeting` / `update_meeting` / `delete_meeting` in `src/skills/meetings/ops.ts`. It:

- Resolves pending approvals whose payload references the meeting_id (keys checked: `meeting_id` / `existing_event_id` / `event_id` / `external_event_id`) to `status='superseded'`, and cancels their sibling `approval_expiry` + `approval_reminder` tasks.
- Closes outreach_jobs with `intent='meeting_reschedule'` whose `context_json` references the meeting_id to `status='done'`, and cancels their `outreach_expiry` + `outreach_decision` follow-up tasks.
- Cancels open `follow_up` / `reminder` tasks whose `payload_json` references the meeting_id.

Fixes the "Yael asked to move, we handled it, but 'Needs your input' + 'Active reminder to update Yael' still show in open tasks" bug. Doesn't matter who initiated (owner or colleague) — the mutation is the terminal event, artifacts close. Additive to the existing coord-terminal cascade in `updateCoordJob`; double-cascading is idempotent. Never throws — calendar is source of truth, DB cleanup is best-effort.

### Fixed — get_calendar no longer truncates at 100 events

`getCalendarEvents` in `src/connectors/graph/calendar.ts` used `$top: 100` with no pagination. Graph returns an `@odata.nextLink` when more pages exist; the code ignored it. Over multi-week ranges with multiple recurring series, the query silently capped at the first 100 events chronologically and Sonnet narrated the truncation boundary as if it were real (*"The series doesn't seem to have instances beyond Jun 11"*). Now follows `@odata.nextLink` to completion. Hard cap 1000 events to prevent runaway queries; logs a warning if the cap is hit. All callers benefit — brief, bulk delete, analyze_calendar, find_available_slots (via internal get_calendar_events calls), check_join_availability.

### Fixed — delete_meeting verifies the event is actually gone

Previously `await deleteMeeting(...)` trusted the Graph 200 OK and returned `{success: true}`. Graph occasionally returns success on DELETE while the event persists (transient partial failures, recurring exception edge cases), and the tool would happily confirm "Cancelled 'X'" when X was still on the calendar — then blame "sync delay" when the owner pointed it out. New helper `verifyEventDeleted(userEmail, meetingId)` in `calendar.ts` runs a follow-up `GET /events/{id}` and returns `true` only on 404. Wired into the `delete_meeting` handler: if the event is still retrievable, the tool returns `{success: false, error: 'still_present_after_delete'}` with a message telling the LLM to narrate truthfully. Per-event check, so bulk delete loops catch partial failures individually.

### Fixed — Graph event IDs no longer leak into owner-facing text

Occasional narrations like *"here's what I'll delete: `AAMkADVmMjY1NmJm...Ij18-ewAEA==`"* leaked the opaque Graph identifiers. A human EA would never quote an internal ID. New `GRAPH_ID_RE` in `src/utils/textScrubber.ts` matches `AAMk` + 40+ base64url characters (with optional backtick wrap) and strips them via `scrubInternalLeakage`. Runs on every outbound text path, so any tool that accidentally returns IDs in a field Sonnet quotes will be caught regardless of prompt drift.

### Migration

No schema changes. Cleanup helper reads existing payload_json / context_json fields already populated by Sonnet when creating approvals / outreach jobs. Cascade effectiveness scales with how consistently Sonnet includes `meeting_id` in those payloads — already the common pattern for `intent='meeting_reschedule'` outreach rows (guaranteed via `RescheduleContext.meeting_id`). Follow-up tasks created by Sonnet may or may not include meeting_id in the payload; prompt tightening to make it a convention is a future pass.

### Not changed

- Auto-build commit shell-escape already fixed in 2.1.5 (commit [ce45698](https://github.com/odahviing/AI-Executive-Assistant/commit/ce45698)). Future Approved labels will build themselves.

---

## 2.1.5 — shadow + recovery no longer leak to colleagues, deterministic work-hours guard

Seven bug fixes from a day of external QA. The biggest two close a class of owner-context leakage onto colleague-facing surfaces (shadow messages landing in colleague threads, recovery pass synthesizing owner-narrative text for colleagues). One code-level hardening makes out-of-hours availability unreachable via `get_free_busy` in the colleague path. The rest are coordination polish — message dedup on MPIM bookings, ts-threaded follow-ups, counter auto-accept for solo reschedules, visibility of the built-in briefing.

### Fixed — shadow messages leaking to colleague threads

`shadowNotify` previously took the in-thread path on any channel starting with `D` — which is every 1:1 Slack DM, including colleague DMs. Shadow content (`🔍 Yael Aharon → me: I said: "..."`) was ending up inside the colleague's thread. Gate rewritten: in-thread only fires when the caller-provided channel matches the cached owner-DM channel. First-ever call (cold cache) falls through to `sendDirect(ownerId)` and populates the cache. MPIMs and public channels unchanged (they never satisfied `startsWith('D')` to begin with). File: `src/utils/shadowNotify.ts`. [#35](https://github.com/odahviing/aI-Executive-Assistant/issues/35)

### Fixed — recovery pass no longer fabricates colleague-facing text

The v1.6.5 recovery pass exists to cover "action tool succeeded, Claude forgot to narrate, owner would be confused by silence." When a colleague turn ended with only a memory-internal tool call (e.g. `note_about_person`), the recovery pass fired anyway with a prompt hardcoded to owner framing — synthesizing owner-narrative text like *"Yael mentioned she's planning to fly to Boston. Follow up if relevant."* and delivering it to the colleague. Recovery (and the tool-grounded fallback that runs after it) now skip entirely on colleague-facing turns. Colleague-facing text is only what Claude itself wrote; if the main pass went silent, silence is the honest outcome. Owner path keeps the recovery safety net. File: `src/core/orchestrator/index.ts`. Follow-up [#41](https://github.com/odahviing/AI-Executive-Assistant/issues/41) filed to investigate whether the owner-side recovery pass still earns its keep. [#38](https://github.com/odahviing/AI-Executive-Assistant/issues/38)

### Fixed — out-of-work-hours availability unreachable via get_free_busy for colleagues

Colleague-path `get_free_busy` now synthesizes out-of-work-hours busy blocks on the owner's row before returning. If the office day starts 10:30, the window 00:00–10:30 is returned as busy (`status: 'oof'`). Out-of-hours slots literally aren't present in the data Sonnet sees — she can't narrate 09:00 as available to a colleague because it's not "free" in the response. Owner-path calls (`senderRole === 'owner'` or owner-in-group) still get raw data so the owner sees their own calendar accurately. Plus a tool-description guard ("do not use to present meeting-time options") and a new `COORDINATION` prompt rule banning slot pre-narration before calling `coordinate_meeting`. Files: `src/skills/meetings/ops.ts`, `src/skills/meetings.ts`. [#39](https://github.com/odahviing/AI-Executive-Assistant/issues/39)

### Added — counter auto-accept on meetingReschedule path

Mirrors the v2.1.1 coord move-intent auto-accept. When `message_colleague` with `intent='meeting_reschedule'` gets a counter-offer reply (*"works but 09:30 would be better"*), and active mode is on AND the counter is same ISO week AND passes every schedule rule (narrow-window `findAvailableSlots` check), Maelle moves the meeting and shadow-DMs the owner — no ping for approval. "15 minutes earlier on work time" is her job, not owner's. Counters outside same week, or that break a rule, still route to owner approval. File: `src/skills/meetingReschedule.ts`. [#36](https://github.com/odahviing/AI-Executive-Assistant/issues/36)

### Added — outreach DM threading (ts captured, confirmations thread back)

`outreach_jobs` gains `dm_message_ts` + `dm_channel_id` columns. `message_colleague` DM branch stores the Slack ts + channel after successful send. The meetingReschedule approved-branch confirmation now threads into the original outreach DM via `postToChannel(dm_channel_id, msg, {threadTs: dm_message_ts})` — no more fresh top-level DM for the "Great, moved to 14:30" reply. Counter auto-accept path threads the same way. Legacy rows (no ts recorded) fall back to `sendDirect`. Idempotent migration. Files: `src/db/client.ts`, `src/db/jobs.ts`, `src/skills/outreach.ts`, `src/skills/meetingReschedule.ts`. [#37](https://github.com/odahviing/AI-Executive-Assistant/issues/37)

### Fixed — duplicate booking messages on group-thread coords

Two changes:
- The *"Great, noted! I'll confirm once everyone responds."* ack in `coord/reply.ts` is now suppressed when the yes-vote is the last one needed — booking confirmation follows in the next breath and is the real response. `allResponded` is computed BEFORE the ack so the gate works.
- In `coord/booking.ts`, the standalone *"Done — booked with …"* owner post is suppressed when the in-group *"All confirmed!"* post already landed in the owner's channel + thread. Match is exact: `group_channel === owner_channel && group_thread_ts === owner_thread_ts`. Covers MPIM coords and any channel-initiated coord where the owner is in the group. Private-DM coord path unchanged.

Three messages collapsed to one. [#40](https://github.com/odahviing/AI-Executive-Assistant/issues/40)

### Fixed — rescheduling alternatives can no longer overlap the original meeting

New `RESCHEDULING ALTERNATIVES` prompt rule in `src/skills/meetings.ts` extends the existing `OPTIONS QUESTIONS` guard to cover reschedule phrasing ("can we move this?" / "can you shift it?"). Forces `find_available_slots` instead of raw-calendar narration. The slot finder already rejects overlaps via free/busy — the bug was purely that the LLM wasn't being told to use it for the reschedule path. Trap documented in-prompt: *"seeing 'free from 9:00 before the meeting' and suggesting 9:00 — a 55-min meeting at 9:00 ends 9:55, which overlaps the original 9:15–10:10 block still on the calendar."* [#36](https://github.com/odahviing/AI-Executive-Assistant/issues/36)

### Fixed — coord topic no longer echoed back to the participant who said it

`topic` param description on `coordinate_meeting` was *"only if the user told you explicitly"* — ambiguous enough that the LLM would populate it from a participant's own message ("we'll shoot 2 videos") and then include it in the coord DM back to that participant. Tightened to *"set ONLY if the OWNER (not a colleague or participant) explicitly told you the meeting purpose in this conversation. Never derive this from something a participant said."* [#39](https://github.com/odahviing/AI-Executive-Assistant/issues/39)

### Fixed — built-in briefing visible in get_routines

`get_routines` was filtering `AND is_system = 0`, hiding the morning briefing row from the LLM. Owner would ask *"what routines do you have?"* and hear *"no daily briefing set up"* — same morning she'd already sent one. Filter removed; system routines now appear in the list ordered first, tagged with a `*(built-in)*` label. `update_routine` and `delete_routine` still carry their own `AND is_system = 0` guards so accidental mutation is impossible. No prompt change — owner's note: "if it's there, it's there; if not, not." File: `src/tasks/crons.ts`. [#34](https://github.com/odahviing/AI-Executive-Assistant/issues/34)

### Migration

Two idempotent `ALTER TABLE outreach_jobs ADD COLUMN` statements added to `db/client.ts` for `dm_message_ts` + `dm_channel_id`. Legacy rows have NULL and degrade gracefully to `sendDirect`.

### Not changed

- Auto-triage auto-build commit path — the shell-escape bug in `scripts/auto-build.mjs` (literal `\n` in commit messages breaking `sh -c`) still present. All 7 fixes were built manually after the Approved auto-build runs failed at the commit step. Separate ticket territory.

---

## 2.1.4 — smart health-check window, cadence-aware moves, attendee-only guards, third-party-booking verifier

Bundle of scenario-driven fixes. Five behavior changes with real teeth, plus filing two follow-up tickets.

### Added — smart calendar-health window

New helper `computeHealthCheckWindow(profile)` in `src/utils/workHours.ts`. Rule: `start = today`, `end = end of current workweek`. If that window is ≤24h (we're on the last workday already), extend by 7 calendar days so there's actual runway to coordinate moves. `check_calendar_health` uses this as the default when `start_date` / `end_date` args are omitted — Sonnet doesn't do date math anymore, the tool picks the right window itself.

### Added — cadence-aware move-coord window

New helper `getNextSeriesOccurrenceAfter(userEmail, seriesMasterId, afterIso)` in `connectors/graph/calendar.ts`. When active-mode auto-starts a move-coord on an overlap or OOF conflict AND the movable event is a recurring occurrence, the slot search `searchTo` is now capped at `nextOccurrence - 1min`. Prevents Maelle from pushing a weekly Brett biweekly into the week where the next biweekly already lives (cadence duplication). Biweekly can still move across the off-week; weekly stays inside its week. Non-recurring events keep the full default window.

### Added — privacy-aware conflict phrasing

New `sanitizeConflictReason(event, ownerFirstName)` in `utils/meetingProtection.ts`. When Maelle DMs a colleague asking to move their meeting because of a conflict on the owner's side, she discloses the subject by default (*"overlaps with 'Fulcrum Product Sync'"*). But when the kept meeting is flagged `sensitivity: 'private' | 'confidential'` OR categorised with a `/private/i` category, she says *"overlaps with another meeting Idan has"* — never leaks a private subject to an external attendee. Applied at all coord-initiate sites from the active-mode fix loop.

### Added — attendee-only guards on update_meeting / move_meeting

Graph rejects PATCH from non-organizers. Until now Maelle would cheerfully offer *"want me to add a location"* on a meeting a third party organized, then either silently fail or produce a recovery fiction. New `getEventOrganizer(userEmail, meetingId)` helper + pre-check in both `update_meeting` and `move_meeting` tool handlers: if `organizer.emailAddress.address` is not the owner's email, refuse early with *"Can't modify X — [organizer] organized it, [owner] is just an attendee. I can message them to request the change, or decline on [owner]'s side."* Deterministic, no chance of fake-success narration.

New prompt rule in `meetings.ts` — **ATTENDEE-ONLY EVENTS**. Spells out the attendee-vs-organizer distinction, lists the three legitimate attendee actions (accept/decline/tentative, read, remove-from-my-calendar), and bans offering "add location" / "move" / "change subject" on meetings the owner didn't organize. Complements the code guard.

### Added — verifier for third-party-booked meetings

When Maelle proposes times to a colleague who books on THEIR side (classic: Michal+Inbar bank visit — *"Wed 29 Apr noon works, confirm with Inbar"*), the invite arrives on the owner's calendar without going through Maelle. Until now she'd narrate *"still waiting to hear back"* next morning even though the meeting was already there.

- New columns on `outreach_jobs`: `proposed_slots` (JSON array of ISO strings) + `subject_keyword` (text). Idempotent migration.
- New optional args on `message_colleague`: `proposed_slots` + `subject_keyword`. Sonnet populates them when messaging a colleague with specific times.
- New helper `verifyScheduledOutcome(input, calendarEvents, profile)` in `utils/verifyScheduledOutcome.ts`. For each proposed slot's date, scans the owner's calendar for events matching by subject-keyword fuzzy match (case-insensitive substring + token overlap) + attendee-email tiebreaker. Returns `{ status: 'none' | 'booked_compliant' | 'booked_conflict', event?, issues? }`.
- Wired into `tasks/briefs.ts`: on brief assembly, fetches owner's calendar for today+30 days, runs the verifier per outreach/coord row with `proposed_slots`. Matching outreach rows get `status='done'` after the brief sends; matching items carry a `verified_outcome` field.
- Brief prompt: new **VERIFIED OUTCOMES** rule. `booked_compliant` → narrate as done (*"Michal and Inbar booked it — Wed 29 Apr at noon, you're set"*). `booked_conflict` → surface issues for owner decision (*"booked at 17:30 — but past your work hours. Approve or should I push back?"*).

### Fixed — brief narration respects `await_reply=0`

Brief prompt's outreach section used to always narrate `status='sent'` as "sent, awaiting reply" — even when `await_reply=0` (fire-and-forget message, Maelle didn't expect a reply). New status label branch: `await_reply=0` → *"sent — they're handling it on their side"*. New **AWAIT-REPLY AWARENESS** rule in the prompt reinforces: don't say "waiting" for outreach where `awaitsReply=false`.

### Added — approval reminder at halfway point (rolled up from the session)

New `approval_reminder` task type + dispatcher. Fires at midpoint of an approval expiry window. If the approval is still `pending`, DMs owner *"still waiting on X — approve, decline, or should I close it?"*. No-ops if resolved. Cascade-cancels on every resolve path (both `setApprovalDecision` and `updateCoordJob` terminal).

### Added — work-time expiry base (rolled up from the session)

New `workTimeBaseFromNow(profile)` helper. When an approval is created at 20:00 (colleague replied late), expiry no longer starts counting from 20:00 — it counts from the owner's next work-time start. Applied to both `create_approval` (tasks/skill.ts) and coord-path `emitWaitingOwnerApproval` (profile threaded through all 11 call sites). A 20:00 approval now gets its full window of owner-work-hours.

### Added — explicit @-mentions override thread sweep (rolled up)

New THREAD CONTEXT rule in `meetings.ts`. *"Meeting with @Amazia and @Brett"* invites only those two. *"Let's meet about this"* without names sweeps thread participants.

### Added — research refusal offers web-search fallback (rolled up)

New RESEARCH REQUESTS rule in colleague-path systemPrompt. Non-owner asks for research → refuse the deep skill AND offer `web_search` / `web_extract` as light alternative in the same reply.

### Updated — ticket [#30](https://github.com/odahviing/AI-Executive-Assistant/issues/30) reframed

Tentative-reservation ticket body corrected per owner's clarification. Slot PROPOSALS are not reservations. The reservation window opens only when a requester picks a specific slot AND needs to verify/confirm with their side. Three-state model documented (offer → verification window → booked/released).

### Filed — follow-up tickets

- **[#33](https://github.com/odahviing/AI-Executive-Assistant/issues/33)** — Respond to invite on owner's side (Low). Adds `respond_to_invite(meeting_id, response)` so Maelle can accept/decline/tentative an attendee-only invite. Defensive half (the guard that refuses invalid PATCH) is in v2.1.4; proactive half (the explicit accept/decline action) is this ticket.

### Verified

- `npm run typecheck` clean.
- Scenario walkthroughs on the Michal bank case, Brett biweekly vs Don interview overlap, attendee-only Bank Hapoalim meeting all mapped against the new code paths.

### Migration

- Idempotent `ALTER TABLE outreach_jobs ADD COLUMN proposed_slots / subject_keyword` on next startup. Existing rows NULL → verifier skips them.
- Yaml can (optionally) add `behavior.calendar_health_mode: "active"` to turn on the full autonomy layer — defaults to `passive`.
- One-off reconfigure script at `scripts/local/v2_1_4_reconfigure.cjs` consolidates the three duplicate calendar-health routines into one clean routine + flips active mode. Run manually, not committed (local scripts/ gitignored).

---

## 2.1.3 — approval reminder + work-time expiry base + scenario polish

Bundle of scenario-driven fixes uncovered during the walkthrough round. Three real behavior changes + two small prompt tightenings.

### Added — approval reminder at the halfway point

New task type `approval_reminder` + dispatcher at `src/tasks/dispatchers/approvalReminder.ts`. When `createApproval` schedules the existing `approval_expiry` task at the window's end, it now ALSO schedules a reminder task at the midpoint. If the approval is still `pending` when the midpoint fires, Maelle DMs the owner a single short nag — *"Still waiting on your call on [subject]. Want to approve, decline, or should I close it? I'll auto-close if I don't hear back."* No-ops if already resolved.

Why it exists: the morning brief surfaces pending approvals, but a passive list entry is easy to scroll past. A dedicated short DM at the midpoint is impossible to miss. Owner called this out in scenario 11 — *"brief is general update but if I'm ignoring an approval process, I should get reminded about it."*

Cascade-cancel: both `setApprovalDecision` (every resolve path) and `updateCoordJob` terminal transitions now cancel BOTH `approval_expiry` and `approval_reminder` tasks so they don't fire on an already-answered approval.

### Fixed — approval expiry now rebases off owner work time

Previously `expiresAt = addWorkdays(now, 2)` counted from the creation timestamp. A colleague replying at 20:00 → approval created at 20:00 → expiry 2 workdays from 20:00 → owner loses ~13 off-hours of the window before he's even at work.

New helper `workTimeBaseFromNow(profile)` in `src/utils/workHours.ts`: returns NOW if within work hours, else `nextOwnerWorkdayStart()`. Both the `create_approval` tool path (`tasks/skill.ts`) and the coord-path `emitWaitingOwnerApproval` now compute expiry from this base.

Result: 20:00 approval → base = next morning work start → 2 workdays from that moment. The reminder's midpoint calculation sits on the same base (it's halfway between creation time and the rebased `expiresAt`). `emitWaitingOwnerApproval` signature grew an optional `profile` parameter — all 11 call sites in `coord/state.ts` + `coord/booking.ts` updated to pass it.

### Fixed — explicit @-mentions override thread sweep

`src/skills/meetings.ts` system prompt gains a **THREAD CONTEXT** rule covering meeting requests made from inside a Slack thread. Two shapes:
- *"Let's meet about this"* with no names → invite thread participants (mentioned + replied).
- *"With @Amazia and @Brett"* → invite literally those two, ignore everyone else on the thread.

Explicit names override the thread-sweep. Addresses scenario 2.

### Fixed — research refusal offers web-search fallback

`src/core/orchestrator/systemPrompt.ts` colleague-path section gains a **RESEARCH REQUESTS** rule. When a non-owner asks for research, refuse the deep research skill (owner-gated) AND offer the light alternative in the same reply: *"The deeper research work is something [owner] drives — but if a quick web look is enough, I can do that. Want me to?"* Runs `web_search` / `web_extract` on consent. Addresses scenario 3.

### Updated — [#30](https://github.com/odahviing/coding/pull) reframed

Ticket body corrected per owner's clarification: proposed slots are NOT reservations, slots are open until explicitly chosen. The actual reservation window opens when a requester picks a specific slot AND needs to verify/confirm with their side. Reframed three-state model (offer → verification window → booked/released) with explicit design questions about triggers, TTL, and lock granularity.

### Verified

- `npm run typecheck` clean.
- Scenario walkthroughs 9-11 work end-to-end with existing machinery + the new reminder.
- 11 call sites of `emitWaitingOwnerApproval` updated consistently; the profile parameter is optional so back-compat is preserved for any unseen caller (none in the tree today).

### Migration

- No schema changes.
- No profile changes required.
- Existing pending approvals (created pre-2.1.3) keep their original expiry; only approvals created AFTER the restart use the work-time-rebased expiry + new halfway reminder.

---

## 2.1.2 — social-layer fix (Maelle asks real social questions, not just the same one)

Owner observation: *"still no social question, even once for the last 5 days with Maelle and we're talking all the time."* DB walk showed the literal count was non-zero — Maelle had initiated six times over 10 days — but four of those six were re-asks of the same "clair obscur axons progress" topic, with a note in her own interaction log reading *"fourth time asking, still don't have his answer."* Two failure modes compounded: the stale-topic threshold was too lax, and the "no fresh topics" fallback was too soft to actually trigger in a task-heavy conversation.

### Fixed

- **`SOCIAL_STALE_COUNT_THRESHOLD: 3 → 2`** in `src/db/people.ts`. Two neutral initiations on the same (topic + subject) now marks it STALE and off-limits. Three was too many — by the time a topic hit stale, the owner had already been re-asked the same dead question three times. Ripples directly into how "robotic" Maelle feels.
- **Seed topic areas injected into the SOCIAL CONTEXT block.** When Maelle's available pool is empty or stale, the prompt now lists concrete topic areas she hasn't tried with this person yet (family, weekend, exercise, travel, food, books, shows, health, neighborhood, plus hobby). Diffed against existing topics so suggestions are always fresh. Sonnet no longer has to invent a topic from nothing — she has a menu.
- **"No fresh topics" fallback is mandatory, not permissive.** Prompt block for this branch used to say *"If a social moment fits naturally, try ONE open discovery question"* — the *"if fits naturally"* softener let Sonnet skip whenever the turn looked transactional, which is always. New wording: *"You MUST ask ONE social question this turn — ideally after you deliver the task, but do ask. Silence is not the right answer when topics are stale / on cooldown and you're DUE. The 'if a moment feels natural' softener is gone: find the moment, don't wait for it."*
- **"Too silent" escalation at 72h.** New `SOCIAL_LONG_SILENCE_HOURS = 72`. When Maelle hasn't initiated in 3+ days (and the person isn't avoidant), the instruction upgrades from *"find ONE natural moment"* to *"It has been N days since you last started a social moment with this person — too long. You MUST find a natural moment this turn."* Same code path, imperative tone.
- **STALE rule strengthened in the block.** Was *"STALE — DO NOT REVISIT (asked 3+ times, never progressed)"*. Now *"STALE — OFF LIMITS (asked 2+ times, quality stayed neutral — the person does NOT want to talk about this)."* Reframes the signal as "don't push" rather than "we have data."
- **Static SOCIAL LAYER prompt rules tightened** in `src/core/orchestrator/systemPrompt.ts`:
  - New **VARIETY matters more than recency** rule: if a topic has two neutral pings, STOP — pick a different area.
  - New explicit *"Don't hide behind 'not a natural moment'"* line. In task-heavy conversations no moment ever feels natural; mandatory means mandatory.
  - Closing framing: *"a real EA asks her boss how his weekend was, what his kids are up to, whether he tried that new restaurant. If you never start, you're a transaction surface, not a person."*

### Not changed (filed for later)

- Auto-updating `profile.engagement_level` to `minimal` when a person shows repeat neutrals across multiple distinct topics. Worth doing — would naturally soften Maelle's cadence for genuinely-reserved people — but not this patch. The threshold drop + seed suggestions + mandatory-open-discovery should already fix the behavior for an engaged owner; the engagement_level heuristic becomes useful mainly for people who really do want less social chat.

### Verified

- `npm run typecheck` clean.
- Walked Idan's people_memory row as the regression test: one topic on cooldown (clair obscur, yesterday), the rest of the SEED_TOPIC_AREAS are all unused → next turn she gets a concrete menu of family / weekend / exercise / travel / food / books she can pick from, plus a MUST-ask line since it's been >72h since the last real new topic (the May 11 clair obscur seed note doesn't count as "new exploration").

### Migration

- No schema changes. No profile changes required.

---

## 2.1.1 — active calendar-health mode (autonomy layer)

Takes the floating-blocks work from v2.1.0 and adds the autonomy layer on top. One flag in the profile (`behavior.calendar_health_mode`) toggles `check_calendar_health` between "passive — detect and report" (today's behavior, still the default) and "active — detect and execute the safe fixes in the same call." Owner stays in the loop on everything via shadow DMs + daily brief, but Maelle does the reshuffle work herself.

### Added — the autonomy surface

- **`behavior.calendar_health_mode: 'passive' | 'active'`** in the profile schema. Default `passive`. Set to `active` to turn on the autonomous calendar maintenance. Same yaml section as `v1_shadow_mode` — both are "how aggressively does Maelle act on her own" knobs.
- **`meetings.protected[]` entries now accept `category`** alongside `name`. Forward-compatible: when the owner creates an Outlook category like "Protected", one yaml line `{category: "Protected", rule: "never_move"}` auto-protects every event tagged with it. Existing entries with only `name` keep working.
- **`src/utils/meetingProtection.ts`** (new) — `isProtected(event, profile)` + `pickMovableSide(a, b, profile)`. Deterministic rules: ≥4 effective attendees / any external attendee / matches a `protected` entry by name or category → protected. All other meetings are movable under active mode.
- **`src/utils/attendeeScope.ts`** (new) — `getOwnerDomain`, `isInternalOnly`, `countEffectiveAttendees`. Company domain derived from `profile.user.email`.
- **`coord_jobs.intent: 'schedule' | 'move'`** + **`coord_jobs.existing_event_id`** (new columns, idempotent migration). The coord state machine now handles TWO intents — scheduling a new meeting (existing flow) or moving an existing one (new). Participant DMs branch to "can we shift our sync" phrasing for move intent; the booking terminal calls `updateMeeting` on the `existing_event_id` instead of `createMeeting`. Preserves attendees + Teams link + history, creates a single-date exception for recurring meetings.

### Added — active-mode fix loop in `check_calendar_health`

When `mode: 'active'`, on a single call the tool:

- **Books every missing floating block** for days it applies to (lunch + any other `floating_blocks` the profile defines). Quarter-aligned, buffer-aware, day-scoped via `blockAppliesOnDay`.
- **Tags uncategorized events** with a Sonnet classifier that returns confidence. Only acts on `high` confidence — ambiguous stays untagged so the owner chooses. No mis-tagging.
- **Reshuffles floating-block overlaps directly** (fast-path). If a new meeting overlaps a floating-block event (lunch vs a new 1pm meeting), Maelle moves the block to the next aligned slot inside its window via `updateMeeting`. No coord needed — a floating block is elastic by definition.
- **Starts a move-coord for internal-only overlaps** where a clear movable side exists. DMs the attendees of the movable meeting with "small conflict on Idan's side — can we shift our sync from 14:00 to 13:30 or 14:45?", waits for replies via the existing reply classifier, and when they agree calls `updateMeeting` on the occurrence id. Protection rules (4+ attendees / external / rule-matched) ensure the kept side is never touched.
- **Auto-resolves OOF conflicts on a surprise vacation day.** When a meeting is scheduled on a day that becomes OOF (vacation, holiday, PTO), non-protected meetings get a move-coord pushing them 1–7 days out; protected ones (≥4 attendees / external) are left for the owner in the next-day report.
- **DMs the owner about busy days.** Three thresholds (free time below profile target, >6 meetings, no 30-min unbroken block) — any one trips a real DM (not shadow) with the reasons and "want me to suggest what to push?". No auto-move.
- **Returns a per-issue report** with `fixed: true` + `fix_detail` + optional `fix_failed` + `fix_error` so Sonnet narrates accurately — same RULE 2e principle ("narrate YOUR actions, not just resulting state").

### Added — `check_join_availability` active-mode in-turn block move

When a colleague asks "can Idan join our 1pm meeting?" and the only reason it's not immediately free is that a floating block (e.g. lunch) currently sits there:

- **Passive mode (today's default):** Maelle replies "yes, free — forward the invite" (because the block could theoretically move). The block stays where it is on the calendar until the next health-check run.
- **Active mode (v2.1.1):** same "yes" answer, but Maelle actually calls `updateMeeting` on the block event in the same turn, shifting it to a new aligned slot in its window. By the time the invite lands, the calendar already matches the answer.

### Added — counter-offer auto-accept for move-coords

When a move-coord participant counters with a different slot:

- **If the coord is `intent='move'` AND profile is active mode AND the counter is same ISO week AND the slot passes every rule** (`findAvailableSlots` is used as the rule engine — buffer, work hours, floating-block windows, protected list all enforced), Maelle accepts the counter autonomously. Move books, participant gets "works — see you then", owner gets a shadow DM: *"Isaac countered Weekly with Isaac to Wed 19:00 — same week, within your rules, so I moved it."*
- **Otherwise** (schedule-intent coord, passive mode, different week, rule break): falls through to the existing approval-to-owner path. Owner decides.

### Changed — prompt nudges

- **Meetings system prompt** now describes the passive/active mode explicitly, the protection rules inline, and uses the tools' `fix_detail` strings to narrate active-mode results.
- **New LARGE-GROUP PARTITIONING rule.** When the owner asks for a meeting with 5+ people, Sonnet must ask once "who are the 1–4 people whose schedule truly matters?", then put the rest in `just_invite`. The coord state machine already warns ≥5 key participants; the prompt makes Sonnet narrow before calling the tool.
- **New RETRY-ON-DECLINE rule.** When a coord approval was declined and the owner's reply extends the range or narrows the participant list, Sonnet must re-call `coordinate_meeting` with the new parameters before reporting "couldn't find time" a second time.
- **FLOATING BLOCKS elasticity rule** (carried over from v2.1.0) tightened: explicit callout that Maelle may move a block to another quarter-hour inside its window without asking; moving out of the window requires `create_approval(kind=lunch_bump)`.

### Follow-ups filed as improvement tickets (not in 2.1.1)

Surfaced while walking through test scenarios, scoped out of this patch:

- **[#30](https://github.com/odahviing/AI-Executive-Assistant/issues/30) — Tentative reservation awareness** (Medium). Active coord_jobs hold proposed slots that Graph doesn't know about. When a second colleague asks about the same slot, Maelle should treat it as tentatively reserved, not blindly free.
- **[#31](https://github.com/odahviing/AI-Executive-Assistant/issues/31) — Auto-book travel buffer blocks** (Low). `custom` meeting mode pads slot search but doesn't insert actual "Travel" blocks on the calendar. Offsite visits leave adjacent slots looking free when the owner's in transit.
- **[#32](https://github.com/odahviing/AI-Executive-Assistant/issues/32) — Retry-on-refusal with earlier-bias** (High). When a move-coord participant refuses ("this meeting must not move — it's important"), Maelle should try earlier-biased slots once before escalating to owner approval — rather than collapsing straight to cancel/approval.

### Verified

- `npm run typecheck` clean.
- Five scenario walkthroughs covering: colleague-initiated coord + out-of-thread reply; tentative reservation; refusal-retry; large-group partitioning + decline-extend; surprise-vacation auto-cleanup.

### Migration

- No data migration required on startup beyond the `ALTER TABLE coord_jobs ADD COLUMN intent / existing_event_id` (idempotent, runs on first `getDb()` call).
- Existing profiles unchanged (`calendar_health_mode` defaults to `passive` — today's behavior). Flip to `active` in `behavior:` to turn on autonomy.

---

## 2.1.0 — floating blocks (lunch + generalized), elastic within window + day-scoped

Lunch used to be a hardcoded, immutable calendar event: if a meeting wanted the slot lunch sat on, the meeting got rejected. The owner said: "lunch is just one example — there could be coffee breaks Thursday only, thinking-time blocks, etc. These should all be elastic within their window and config-driven, not hardcoded." This release ships the generalization + fixes the original lunch-immutability bug.

### Added

- **`schedule.floating_blocks` YAML array.** Each entry: `name`, `preferred_start`, `preferred_end`, `duration_minutes`, `can_skip`, optional `days: ["Thursday"]` / `["Sunday","Monday","Wednesday","Thursday"]` for day-of-week scoping, optional `match_subject_regex` / `match_category` for calendar-event detection, optional `default_subject` / `default_category` for booking. Example uses: `coffee_break` Thursday 16:00–17:00 (60 min), `thinking_time` every weekday 09:00–10:00 (60 min), `gym_window` Sundays 07:00–09:00 (45 min).
- **`schedule.lunch` auto-promotes to a floating block named `lunch`.** Existing profiles keep working unchanged — no migration required. A custom `floating_blocks` entry named `lunch` overrides the auto-promoted one.
- **New module `src/utils/floatingBlocks.ts`** — single source of truth. Exports `getFloatingBlocks(profile)`, `blockAppliesOnDay(block, dayName, profile)`, `isFloatingBlockEvent(event, block)`, `findAlignedSlotForBlock(block, date, tz, busy, bufferMin)`. Every call site that used to ask "is this lunch?" / "can lunch still fit?" now asks this module.

### Fixed

- **Floating blocks are ELASTIC within their window — no more "meeting rejected because it overlaps lunch".** `findAvailableSlots` no longer treats the lunch event as an immutable busy block. Two-part fix: (1) floating-block events are subtracted from the base busy pool so the `isFree` collision check won't reject slots where the block currently sits; (2) after a slot passes `isFree`, every block that applies on that day is verified to still have a quarter-aligned buffer-compliant slot somewhere in its window after the proposed meeting lands. A block with `can_skip:true` that genuinely has no room doesn't block the meeting — just doesn't get booked that day. Moving a block OUTSIDE its window still requires `create_approval(kind=lunch_bump)` — elasticity is within-window only. Same generalization applied to `check_join_availability` (was lunch-hardcoded).
- **`book_lunch` is day-scope aware.** If the profile says `lunch.days: ["Sunday","Monday","Wednesday","Thursday"]` and someone asks to book Tuesday lunch, the tool refuses honestly with `not_applicable_today` and names the configured days. Previously it would try to book anyway.
- **`book_lunch` now delegates to the floating-blocks helper.** Identifies the block (defaulting to the lunch block), runs the same quarter-alignment + buffer logic as the 2.0.7 fix — but via shared code. When (future) profiles add a coffee_break block and someone wants to book that instance, the same handler works — it's no longer lunch-specific internally. The tool name stays `book_lunch` for back-compat.

### Changed

- **Meetings system-prompt section enumerates all floating blocks with day-scope.** Was: one hardcoded line describing lunch. Now: one line per configured block showing `name (window, duration, day-scope, can-skip)`. Adding a coffee break to YAML instantly surfaces it in the prompt — no code change needed.
- **New prompt rule `FLOATING BLOCKS are ELASTIC WITHIN THEIR WINDOW`** in the meetings section. Explains the owner's mental model: Maelle may move a block to another quarter-hour inside its window without asking; moving it out of the window requires `lunch_bump` approval. Pairs with the tool behavior so Sonnet's narration matches what the code does.
- **New base-prompt rule 2e — Narrate YOUR actions, not just resulting state.** When the owner asks about something Maelle moved/booked earlier in THIS conversation, she should lead with the action ("I moved Sunday lunch from 11:55 to 12:00") instead of re-reading the calendar and describing the resulting state as if it was always there. Addresses the "she fixed it and then didn't remember she fixed it" observation.

### Removed

- **`canLunchFitAfterBooking` in `connectors/graph/calendar.ts`** — replaced by the generalized floating-blocks feasibility loop. Zero behavioral loss; all its logic lives in the helper now.

### Bundled from this session (previously uncommitted)

- **Slack `\<\>` escape strip** (`connections/slack/formatting.ts`). Sonnet markdown-safe-escapes literal `<>` in calendar event titles (e.g. `Reflectiz<>Strauss` → `Reflectiz\<\>Strauss`); Slack doesn't use backslash escaping so the slashes rendered literally. Added `replace(/\\</g, '<')` + `replace(/\\>/g, '>')` to the Slack formatter alongside the `**` → `*` and `##` strips.
- **Retro outreach-orphan backfill** (`src/core/approvals/outreachOrphanBackfill.ts`). The v2.0.7 sibling-outreach cleanup inside `updateCoordJob` only fires on NEW terminal transitions — pre-v2.0.7 bookings left zombies behind. New startup migration runs 30s after boot alongside the approval backfill: (1) for every terminal coord in the last 30 days, closes matching outreach rows to `done` and cancels their pending `outreach_expiry` / `outreach_decision` tasks; (2) for any remaining `no_response` outreach without a decision task, schedules one 2 owner-workdays out. Idempotent.
- **`book_lunch` quarter-hour alignment** (originally 2.0.8 territory, now in this release). Previously `book_lunch` picked `prev` (end of previous meeting or window start) — produced lunches at `:50` / `:55`. Now enforces `:00/:15/:30/:45` alignment deterministically + applies the profile's `buffer_minutes` before and after when there's a neighboring meeting. This was the 2.0.8 fix but got rolled into the 2.1.0 floating-blocks refactor since the new helper owns alignment centrally.

### Verified

- `npm run typecheck` clean.
- `findAvailableSlots`, `check_join_availability`, `book_lunch` all route through the same `utils/floatingBlocks` helper — single source of truth.
- Idan's existing YAML (`schedule.lunch: { preferred_start: 11:30, preferred_end: 13:30, duration_minutes: 25, can_skip: true }`) produces one floating block named `lunch` applying to all his work days — no behavior change for him.

### Migration

- Existing profiles with only `schedule.lunch` keep working — lunch auto-promotes to a floating block. No YAML changes required.
- To add new blocks: append entries under `schedule.floating_blocks:` in the user YAML. E.g.:
  ```yaml
  schedule:
    floating_blocks:
      - name: "coffee_break"
        preferred_start: "16:00"
        preferred_end: "17:00"
        duration_minutes: 15
        can_skip: true
        days: ["Thursday"]
      - name: "thinking_time"
        preferred_start: "09:00"
        preferred_end: "10:00"
        duration_minutes: 60
        can_skip: true
  ```

---

## 2.0.7 — silence-gap close + one approval path + orphan kill at source + dead-code sweep

Addresses the bug wave around the April 22 brief: Yael asked for a slot-bump, Maelle silently stored it to `pending_requests`, owner never heard. Michal DM'd about a bank visit, Maelle replied, owner never heard. Amazia "three open threads" turned out to be two zombie outreach rows + one correct booking. Three root causes this release: inbound colleague path never shadow-notified, three overlapping tools (store_request / escalate_to_user / create_approval) with the owner-facing one blocked in the colleague path, and coord-booked outreach never cleaned up its siblings.

### Fixed — the silence gap

- Every inbound colleague DM Maelle replies to now fires one shadow-DM line into the owner's DM: who messaged, what she said, which tools fired. Gated on the existing `v1_shadow_mode` yaml toggle — no new flag. Skipped when the turn raised an approval (the approval DM already reaches the owner). Closes the "I didn't hear about Michal talking to you" gap.
- `create_approval` no longer blocked when Sonnet is on the colleague path. The old guard `senderRole !== 'owner'` forced Sonnet into the dead-end `store_request` bucket whenever a colleague asked for something that needed owner input. Guard removed; approvals always `sendDirect(ownerId)` so the DM never lands in the colleague's channel regardless of where the tool was called from. `resolve_approval` stays owner-only.

### Changed — one path for "needs the owner's input"

- `store_request`, `get_pending_requests`, `resolve_request`, `escalate_to_user` retired. Three tools + a dead table (`approval_queue`) all overlapped with the v1.5 `create_approval` / `approvals` flow. Collapsed into the single approval path — fewer tools for Sonnet to choose wrongly between, one place to maintain. Removed from both `tasks/skill.ts` and `skills/meetings/ops.ts`.
- Legacy tables dropped with backup. One-shot migration (`src/db/migrations/v2_0_7_consolidate_requests.ts`) dumps `pending_requests` + `approval_queue` rows to `data/migrations/v2_0_7_legacy_requests_<ts>.json` on next startup, then DROPs both. Idempotent. `db/requests.ts` deleted entirely.
- Legacy "approve appr_xxx" / "reject appr_xxx" command parser in `connectors/slack/app.ts` retired — it wrote to the dropped `approval_queue`. Today's approvals resolve via `resolve_approval` + Sonnet's free-text binding.
- `create_approval` rewritten to be Sonnet-friendly (it's effectively a new tool):
  - `task_id` is now optional. If omitted, a `follow_up` task is auto-created with a title derived from the payload (requester name + subject). Cuts Sonnet's two-call pattern to one; the friction that made her reach for `store_request` is gone.
  - Expiry defaults to `expires_in_workdays: 2` using the new `addWorkdays` helper. Counter only advances on the owner's office/home days — Fri/Sat skipped for this profile, so an ask on Thursday expires Monday, an ask on Saturday expires Tuesday (counter starts Sunday). `expires_in_hours` still accepted as a sub-workday escape hatch.
  - Tool description now explicitly spells out the authority model: owner direct override IS the approval (no create_approval needed when the owner tells Maelle to just do it); colleagues asking for a rule break MUST go through create_approval — they can't bypass rules on their own.
- `resolver.ts` now closes the requester loop. When an approval carries `requester_slack_id` + `requester_name` in its payload (colleague-initiated ask), the resolver DMs the requester on `approve` / `reject` / `amend` with a templated owner-voiced note. Slot_pick / calendar_conflict skip this — they already use `coord_jobs.requesters` for the same job. Prevents the "owner decided but Yael never heard back" failure.
- System-prompt + tool-description callouts updated: `systemPrompt.ts` RULE 2d + RULE 3, the colleague-path OUT-OF-SCOPE rule, `meetings/ops.ts` OWNER-DECISION ASKS section, claim-checker examples, coord-guard pattern, orchestrator verbMap, `postReply.ts` claim-matcher regex. Every reference to the retired tools replaced with `create_task` / `create_approval`. `COLLEAGUE_ALLOWED_TOOLS` in `skills/registry.ts` updated: `store_request` out, `create_task` + `create_approval` in.
- `meetings.ts` `finalize_coord_meeting` now has a DISAMBIGUATION section in its description: if there's a pending approval for the coord, use `resolve_approval`; if not (owner force-booking), use `finalize_coord_meeting`. Prevents Sonnet picking the wrong path.

### Fixed — orphans at the source (no brief-side workarounds)

- `updateCoordJob` terminal transition (booked / cancelled / abandoned) auto-closes sibling `outreach_jobs` for the same colleague in the last 14 days and cancels any pending `outreach_expiry` / `outreach_decision` tasks on them. Kills the "Amazia Kickoff booked but two stale no_response outreaches keep showing in the brief" pattern at the root.
- New `outreach_decision` task type + dispatcher. When `outreachExpiry` marks a job `no_response` + DMs the owner "try again or drop?", it schedules an `outreach_decision` 2 owner-workdays out. Owner silence past that → auto-close to `done` + one-line tombstone shadow DM. No more zombies surfacing for 6+ days (the Amazia Privacy GTM pattern).
- New `utils/workHours.addWorkdays(iso, n, profile)`. Skips days outside the owner's office_days/home_days. Shared with both the approval expiry default and the outreach decision window.

### Changed — morning brief prompt

- Rewritten for per-colleague grouping (one paragraph per person, not per item), content-over-activity, human time phrasing (`~1.5 hours open`, `plenty of room midday`, `a short pocket before lunch` — never `110 min` or `pretty full` when there's open space). Dropped the 350-word cap per owner feedback: surface everything that's open, not just today's urgent items. Ban on markdown asterisks, robot phrasings, "your message" / "you messaged" stays.

### Removed — dead code

- `src/skills/meetings/ops.ts` — deleted the DEAD CODE `getTools` method (11 duplicated tool schemas) and `getSystemPromptSection` method (~200 lines). Both documented as dead since v1.7 and verified unused (zero callers anywhere — MeetingsSkill owns both; ops is only invoked via `executeToolCall`). ~420 lines gone.
- `src/db/requests.ts` deleted (createPendingRequest, resolvePendingRequest, enqueueApproval, resolveApproval-legacy, getPendingApprovals, updatePendingRequest — all for the dropped tables).
- `handleApprovalResponse` in `connectors/slack/app.ts` — removed with the legacy `approval_queue` write path.

### Migration

- On next startup: `pending_requests` + `approval_queue` get backed up to `data/migrations/` then DROPped. No action required.
- Profile yaml is unchanged — `v1_shadow_mode: true` remains the single toggle for all shadow notifications (no per-category flags, per owner decision).

### Verified

- `npm run typecheck` clean.

### Not changed

- Approval authority model. Owner can always override rules by telling Maelle directly — that counts as the approval. Colleagues can't bypass rules; they must go through `create_approval` and wait for the owner's decision. Already the design; now documented in the `create_approval` tool description.

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
