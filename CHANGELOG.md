# Changelog

---

## 2.8.3 — Venue skill + tool consolidation (13 owner tools → 5)

New `venue` skill for external meeting venues (cafés, restaurants, customer offices). Two flows: `find_venue` resolves owner-named places via Tavily OR returns 3 candidates for an area+type search; `rank_venue` curates a per-owner catalog with ranks 1-3 (1 hidden, 2 default, 3 favorite first). Save-on-book hook auto-files non-company locations to the catalog at rank 2. Toggle: `skills.venue: true`.

Tool consolidation: 5 merges, 13 → 5. `learn_preference` + `forget_preference` + `recall_preferences` → `manage_preference`. `create_routine` + `update_routine` + `delete_routine` + `get_routines` → `manage_routine`. `get_calendar_issues` + `update_calendar_issue` → `manage_calendar_issue`. `get_company_knowledge` + `ingest_knowledge_from_url` → `manage_knowledge`. `edit_task` + `cancel_task` → `update_task` (narrow — `create_task` stays separate because the claim-checker honesty rule references it by name).

### Added

- **Venue skill** (`src/skills/venue.ts`, `src/db/venues.ts`, `src/utils/venueSearch.ts`). New SQLite `venues` table with per-owner ranking. `find_venue` returns `hidden_count` so Sonnet can mention rank-1 venues without showing them; `include_hidden: true` re-call surfaces them. Tavily-backed search; Google Places migration tracked at [#96](https://github.com/odahviing/AI-Executive-Assistant/issues/96).
- **Save-on-book hook** in `create_meeting` (`skills/meetings/ops.ts`). When `skills.venue: true` and the booked location is non-company, the venue is auto-inserted at rank 2 (or `last_used_at` bumped). Company labels (`short_label` / `meeting_room_label` / `full_label` / `Huddle` / Teams URLs) are recognized and skipped.

### Changed

- **5 merged tools** with `action` enum dispatch. Old tool names removed from `ALWAYS_ON_TOOLS` and `SCOPE_TO_TOOLS`. `inboundQueue.WRITE_TOOLS` updated. `textScrubber` carries both new + legacy names for back-compat scrubbing. `toolStatusText` rewired. System prompt references migrated to the new tool names.

### Migration

- No DB migration. The legacy tool-name strings stay scrubbed by `textScrubber` so any cached transcript references won't leak.
- Restart `npm run dev` to load the new tool definitions.

---

## 2.8.2 — Location decision rewrite: deterministic by day-type and party shape

`resolveLocation` rewritten from scratch as a single, deterministic decision tree driven by day-type + party shape + owner-explicit hints. Categories no longer influence location (they still drive limits, day-type, travel buffer). New behaviors: existing event locations are preserved on same-day-type moves (Michal BiWeekly's "Huddle" no longer gets overwritten on every move); office-day + external attendee with same/unknown timezone refuses to book and asks the owner online-or-physical; office-day + internal-only ≥4 stamps a Meeting Room with the room mailbox invited as optional AND runs a Graph free/busy check on the room — busy + ≤5 people falls back to a small-room label, busy + ≥6 surfaces an ask. Online-flavor verdicts (external on home day, traveling participants, owner-explicit `is_online=true`) now patch the location field with the Teams join URL after the event lands. The three real-day bugs that motivated the rewrite (Simon empty location, Oran "Reflectiz HQ" instead of "Idan Office", Michal "Huddle" overwritten with full address) all close.

### Added

- **`resolveLocation` rewrite — single deterministic tree** (`src/utils/resolveLocation.ts`). New shape: `(profile, startIso, intent, participants, externalAttendeeInDifferentTz?, ownerLocationHint?, ownerIsOnlineHint?, priorStartIso?, existingLocation?, existingIsOnline?, category?) → LocationVerdict`. Verdicts: `resolved` (with optional `addRoomEmail` + `teamsUrlAsLocation` flags), `preserve_existing` (move within same day-type, no owner hint → keep existing event's location/isOnline as-is), `ask_owner_online_or_physical` (office day + external + same/unknown TZ → caller refuses + relays question), `skip_stamp` (category flagged `no_default_location` or `sets_sensitivity_private` → no auto-stamp). Categories' `default_location` / `default_is_online` field is no longer consulted for location.
- **Meeting room availability check** (`src/utils/meetingRoomAvailability.ts` new). When the verdict picks Meeting Room (office day + internal ≥4), `planMeeting` runs `getFreeBusy` on `profile.meetings.room_email` for the slot. Three outcomes: room free → proceed as planned; room busy + ≤5 people → swap location to `small_meeting_room_label` ("Office") and drop the room mailbox; room busy + ≥6 → refuse with `room_unavailable_large` action surfaced as `meeting_room_unavailable_large_meeting` error + `suggested_ask_text`. Fails open on Graph errors. Coord state machine path (`coord/booking.ts`) does the same check and, since it can't synchronously ask the owner mid-flow, falls back to the small label on ≥6 and shadow-DMs the owner via the existing `coord:${jobId}` conversation.
- **Teams URL as location field** (`src/connectors/graph/calendar.ts` + `ops.ts` + `coord/booking.ts`). `createMeeting` return type grew from `Promise<string>` to `Promise<{ id, joinUrl? }>`. When `resolveLocation` flags `teamsUrlAsLocation: true` (external on home day, traveling participants, owner-explicit `is_online=true`, non-work-day default), the booking flow fires one PATCH after createEvent to set `location.displayName` to the Teams join URL. Location field is never left empty for online meetings.
- **Meeting room mailbox as optional attendee.** `CreateMeetingParams.attendees` now accepts `optional?: boolean` per row; mapped to Graph attendee `type: 'optional'`. The room mailbox is appended at create-meeting time when the room is free (or omitted when the small-room fallback fires). Coord path mirrors the same behavior.
- **Owner-explicit hints flow through `move_meeting` too** (`ops.ts:2329`). Pre-fix the move pipeline ignored `args.location` and `args.is_online` — every move rebooted location resolution from day-type defaults. Now hints flow through and `resolveLocation` honors them on moves (path 1 of the tree).

### Changed

- **Office location yaml shape** (`config/users/idan.yaml` + `src/config/userProfile.ts`). New canonical fields: `meetings.office_location.{short_label, meeting_room_label, small_meeting_room_label, full_label}`. `short_label` ("Idan Office") fires for internal-only office-day meetings ≤3 people. `meeting_room_label` ("Meeting Room") fires for ≥4. `small_meeting_room_label` ("Office") is the room-busy fallback. `full_label` ("Reflectiz HQ, Shoham 5 (13th floor), Ramat Gan") fires for external attendees physically visiting. Legacy `label` / `address` / `parking` fields still accepted on input for back-compat; resolver ignores them.
- **System prompt LOCATION block** (`src/skills/meetings.ts`). Replaced the old multi-tier `DEFAULT LOCATION precedence` text (categories override day-aware default → office_location fallback) with a deterministic tree description matching the rewrite. Added CATEGORY-DRIVEN SKIPS section: Logistic / floating-block categories get no stamp; Private categories get no stamp AND Sonnet asks the owner "where should this private event be?" before booking.
- **Move-meeting preserve-on-same-day-type** (`planMeeting.ts` + `ops.ts:2363`). When a move keeps the event on the same day-type (office → office, home → home) and no owner location/online hint is set, the Graph PATCH omits `location` + `isOnlineMeeting` so the event keeps whatever it had. Closes the recurring "Huddle gets overwritten to office address on every move" pattern.

### Fixed

- **Simon: meeting on owner's office day landed with empty location.** Category-driven location override would silently pick `isOnline=true, location=''` for Cadence/Weekly. New tree always stamps `short_label` for internal-only office-day meetings ≤3 people, no category bypass.
- **Oran: office-day meeting stamped "Reflectiz HQ" instead of owner-personalized label.** Old `formatOfficeLocation` returned the yaml `label` field ("Reflectiz HQ") for internal short-path. New `short_label` carries "Idan Office" — owner-personalized for internal calendar; "Reflectiz HQ ..." full address fires only when an external attendee is physically visiting.
- **Michal BiWeekly: existing "Huddle" overwritten with full office address on every move.** `planMeeting` ran resolveLocation fresh on each move, even when day-type didn't flip. New `preserve_existing` verdict fires when intent='move' AND day-type unchanged AND no owner hint — Graph PATCH leaves location/isOnline alone. Recurring conventions stick across moves.
- **Hybrid Teams + Huddle drift on home-day internal 1:1s.** Weekly/biweekly events on owner's home days were carrying both Huddle as location AND isOnlineMeeting=true (Teams in body), accumulated from old hybrid bookings. New rule: home day + internal-only → Huddle, isOnline=false (no Teams). Future bookings stamp the clean shape; existing events stay on `preserve_existing` until rebooked.
- **Office-day external attendees got silently defaulted to Teams.** Pre-fix `inferDefaultMeetingMode` smart-skip picked online without asking when external attendee TZ wasn't known-different. New: office day + external + same/unknown TZ → refuse with `location_mode_unspecified` + `suggested_ask_text`; Sonnet asks owner online-or-physical and re-calls with the explicit hint. Office day + external + known-different TZ keeps the auto-online behavior (no point asking when one party is remote).

### Removed

- **Categories' `default_location` / `default_is_online` field** no longer affects the location decision. Field still parses (back-compat) and still renders in the categories block of the prompt for the description text, but doesn't drive `resolveLocation`. Yaml fields can be removed in a future cleanup once all profiles have been migrated.

### Migration

- **Yaml** — workspaces using `meetings.office_location.label/address/parking` should migrate to `short_label` / `full_label` to get the personalized rendering. Legacy fields keep working; falls back to `${firstName} Office` if no `short_label` set. Idan's `idan.yaml` migrated in this commit.
- **No DB migration.** All changes are code + yaml only.

---

## 2.8.1 — Vertex prep, multi-window work hours, code-replacement of honesty/refusal rules

Two parallel chats this session contributed: code-side patches (Vertex prep, multi-window work hours, calendar invites prompt trim, recovery pass deleted) and the prompt-reduction project (Modules F, E partial, C — replacing 8 honesty rules + refusal phrasing block with deterministic claim-checker + humanGate logic). Net effect: meaningful per-turn token cut from the cached static block + new optional Vertex LLM provider + per-day multi-range work hours.

### Added

- **LLM provider abstraction — Vertex AI ready** (`src/llm/client.ts` + `src/llm/modelId.ts` new, `src/config/index.ts`). New `LLM_PROVIDER` env var (`'anthropic'` default | `'vertex'`). `getAnthropicClient()` factory returned by 31 call sites in place of `new Anthropic({ apiKey })`. Vertex SDK lazy-required only when the flag is `'vertex'` — no install needed until the switch flips. Cross-field validator in config refuses startup if Vertex selected without `VERTEX_PROJECT_ID`. Model ID resolver in `modelId.ts` maps logical names (`claude-sonnet-4-6`) to Vertex versioned IDs (`claude-sonnet-4-6@20251220`) when needed. Migration path documented in client.ts file header.
- **Multi-window work hours per weekday** (`src/config/userProfile.ts` schema, `src/utils/workHours.ts` helpers). New canonical `schedule.work_hours: Record<weekday, string[]>` field where each string is a `"HH:MM-HH:MM"` range. Multiple ranges per day supported — e.g. `Tuesday: ["09:00-15:30", "21:30-23:59"]` for split-shift days. Legacy `office_days.hours_start/hours_end` + `home_days.hours_start/hours_end` accepted on input and synthesized into `work_hours` at load time, then **stripped** from the in-memory profile so callers see a single source of truth. New helpers: `getOwnerWorkHoursForDay`, `isSlotInWorkHours`, `totalWorkMinutes`. Slot finder (`findAvailableSlots` in `connectors/graph/calendar.ts`), `scheduleRules.checkSlot`, and brief/coord/verify callers all updated to multi-window. Day-type classification (office vs home) stays separate from hours — it always reads from `office_days.days` / `home_days.days` for category rules + location resolution.
- **Module F — claim-checker extended with 4 honesty checks** (`src/utils/claimChecker.ts`, `src/connectors/slack/postReply.ts`). New boolean output fields on the Sonnet validator: `re_asked_known_fact` (RULE 2b — asked for info already in a prior assistant reply), `unrecorded_promise` (RULE 3 — relay promise without a recording tool firing), `unverified_state_review` (RULE 9 — confident state/calendar review without the read tool), `invented_after_correction` (RULE 5b — owner correction → draft invents new story instead of admitting). New inputs `priorAssistantReply` + `currentUserMessage` plumbed through from `postReply.ts:360`. Retry instruction returned by checker drives the existing retry loop.
- **Module E — length/repetition validator (partial)** (`src/utils/claimChecker.ts`). Two more booleans on the same validator: `re_asked_after_convergence` (owner said yes/go/do-it, draft still asks "want me to...?"), `re_asked_own_question` (draft re-asks something already asked in the same thread). Third intended check (`too_long_for_context`) deliberately skipped per owner direction. Max-tokens bumped 400 → 800 to accommodate the extended output schema.
- **Module C — humanGate `MECHANICAL REFUSAL` section** (`src/utils/humanGate.ts`). Existing humanGate prompt gains a new section catching mechanical refusal phrasings ("I don't have permission", "Access denied", `not_permitted` / `unknown_colleague` / `rule_violation` verbatim echoes, "approval required"). Applies on BOTH owner-facing and colleague-facing drafts. No new file, no new Sonnet call — humanGate already runs in `postReply.ts` for both paths. Replaces the deleted `REFUSAL PHRASING` prompt block.

### Changed

- **`scheduleRules` rule 5 (outside_working_hours)** now reads from `getOwnerWorkHoursForDay` and accepts a slot if it fits in ANY window for the day. Violation label lists all windows so the rejection narrative names where the slot actually is.
- **`findAvailableSlots`** in calendar.ts uses `getOwnerWorkHoursForDay` per-day. The `params.workHoursStart`/`workHoursEnd` overrides still apply only in extended-hours / relaxed mode. Coord callers (`meetings.ts`, `coordinator.ts`) stop passing per-day-type hours — calendar.ts now looks them up.
- **`getDayQualityFree`** (calendar.ts) sums free minutes across all work windows for the day so focus-time budget recalculates correctly on split shifts.
- **CALENDAR INVITES prompt rule trimmed** (`src/core/orchestrator/systemPrompt.ts`). Pre-fix the rule said "say 'Outlook will send the invite' or just create the meeting and trust it" — Maelle kept narrating the mechanism. Now: "just say 'Done' / 'Booked' — the invite handles itself, don't explain the plumbing." One-line trim, no new rule added.
- **Example yaml** (`config/users.example/user.example.yaml`) updated to the canonical shape: `office_days.days` only (no hours), `home_days.days` only, full `work_hours` map with a split-shift Tuesday example commented out.

### Removed

- **Orchestrator recovery pass (#41)** (`src/core/orchestrator/index.ts`). The second Sonnet call that fired when the main pass produced tool_use but no text — built in v1.6.5 when silent-after-action was a Sonnet pattern. Sonnet 4.6 rarely goes silent post-action; the existing v1.7.3 tool-grounded verbMap fallback (45 mapped verbs + safe generic) covers the same case deterministically. Removing the LLM recovery pass: cheaper per-turn, no fabrication risk, no drift across models. ~60 lines + the recovery prompt deleted. Verb-map backstop unchanged.
- **`HONESTY RULES 1, 2, 2b, 2c, 2d, 3, 5b, 9`** (`src/core/orchestrator/systemPrompt.ts`). All 8 are now enforced via the extended claim-checker (Module F). Kept RULES 4 / 5 / 7 / 8 — judgment-class rules the checker can't replace (tone, information source honesty, one-confirmation flow, thread continuity).
- **`REFUSAL PHRASING` block** (`src/core/orchestrator/systemPrompt.ts`). Code-enforced via humanGate's new `MECHANICAL REFUSAL` section (Module C).
- **Legacy `hours_start` / `hours_end` fields** stripped from in-memory profile after loader normalization. Old yaml still parses (back-compat); the canonical runtime type has only `office_days.{days,notes?}` + `home_days.{days,notes?}` + `work_hours`.

### Migration

- **Profile yaml**: existing profiles using the legacy `office_days: { days, hours_start, hours_end }` / `home_days: { days, hours_start, hours_end }` shape continue to work — the loader synthesizes `work_hours` from those fields. To enable a split-shift day (e.g. Tuesday evening overlap), add a `schedule.work_hours` map explicitly. Once `work_hours` is set, the legacy `hours_start`/`hours_end` are ignored and stripped.
- **LLM_PROVIDER**: defaults to `'anthropic'`. Existing deploys unchanged. To switch to Vertex: install `@anthropic-ai/vertex-sdk`, set `LLM_PROVIDER=vertex VERTEX_PROJECT_ID=… VERTEX_REGION=us-east5 GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json`, restart.
- **`#41`** closed not-planned (delete-the-pass executed).

### Validated

Paper-traced 4 scenarios for the multi-window work-hours change:
1. Owner books regular Monday 10:00 with internal colleague → office-day in-hours, "Idan Office" location, hybrid Teams — works.
2. Owner books split-shift Tuesday 22:00 with ET colleague (Brett) → second window accepted, owner work-hours pass, Teams forced by cross-TZ — works.
3. Owner asks Tuesday 16:00 (the gap between windows) → all strict slots rejected as `outside_owner_work_hours`, auto-relaxed-recovery kicks in, returns 16:00 with trade-off note — works.
4. Colleague queries Idan's Tuesday 22:00 availability → multi-window owner check accepts, attendee annotation runs — works.

Module F/E/C regression coverage verified against the 8 deleted honesty rules — each has a corresponding code path catching the bug pattern it was meant to prevent (table in commit body).

---

## 2.8.0 — Stability baseline for the 2.7 wave

Owner-called release threshold: "enough massive changes in 2.7." No new code over 2.7.7 — this version is a stability rebaseline that closes out the v2.7 line and starts a clean v2.8 surface for the next phase of work (planned: continued execution of the prompt-reduction project tracked in [#95](https://github.com/odahviing/AI-Executive-Assistant/issues/95) — Modules A/B/C/E/F still ahead).

### What v2.7.x shipped, cumulative

The 2.7 line spanned 8 versions (2.7.0–2.7.7) covering three meaningful architectural shifts plus seven follow-up patches:

**The trilogy (v2.7.0):**
- **Requests spine** — single user-facing work-item table replacing scattered tasks/approvals/coord_jobs/outreach_jobs ad-hoc state. One `closeRequest` API. Lifecycle timers on the row. Legacy tables retained as internal state machines, bridged via `request_id`.
- **`planMeeting` decision engine** — every scheduling intent (find / book / move / cancel) flows through one decision function. `resolveLocation` is the single location authority. `scheduleRules.checkSlot` is the single rule engine. All five meeting tools route through it.
- **Slot finder reform** — `pickSpreadSlots` tightened (≤3 total, ≤2/day, ≥1h gap, ≥2 unique days when 3). Initiator-aware annotation. Soft preferences (timezone, night_shift) rendered in prompt with Sonnet judgment.

**Cutover-finish (v2.7.1, v2.7.2):**
- Phase 1: writers (`createOutreachJob`, `createCoordJob`, `createApproval`) bridge to requests spine.
- Phase 2: coord fast-path entirely deleted — `coordinate_meeting` always state-machine path. `relaxed` flag declared on `create_meeting` / `move_meeting` schemas. Deferred-action replay via `_deferred_action_hint` → orchestrator stamps `payload.deferred_action` → resolver replays underlying tool with `relaxed: true` on approve. Outreach dispatchers defer to runner when bridged.

**Slack assistant-panel surface (v2.7.3):**
- `assistant_thread_started` event handler, `setAssistantStatus` primitive, status indicator fired before each tool call.

**Bug-bash + observability (v2.7.4, v2.7.5, v2.7.6):**
- Attendee filter corrected (`responseStatus.response === 'none'` is untracked, not declined).
- Dismissal fingerprint stabilized (`(normalized_class, sorted_event_ids)`).
- Privacy mask via `displaySubject` for events with `sensitivity: private` or `sets_sensitivity_private` category.
- A2 orphan request lifecycle (in_flight_action follow_ups get `expires_at` + `next_check_at`).
- Route 2 deterministic narration in `check_calendar_health` via `summary_text` field.
- `book_floating_block` unified through `planMeeting`.
- Slot picker anchor-day support + same-day packing (move flows + new-booking shape).
- Owner override truly overrides (`allowRelaxed=true` bypasses owner_busy + attendee_busy on owner-path).
- Floating blocks coexist with meetings (rule 8 bypass).
- `day_summary` diagnostic with per-attendee `blocked_by` blame.
- Auto-relaxed recovery on user-named narrow windows.
- `find_available_slots` auto-fills attendees from moving event on owner-path moves.
- Per-tool Slack assistant-panel status text via `TOOL_STATUS_TEXT` map.
- Slack rotating defaults suppressed via explicit `loading_messages: ['']`.
- DB-backed assistant-thread registry (survives `npm run dev` restarts).
- System prompt cache restructure: dynamic chunk ~10.5k → ~3.3k tokens per turn.
- Office-location auto-stamp on `is_online=false` (short label internal, full address external, "Meeting Room" for 4+ internal).

**Prompt reduction begins (v2.7.7):**
- **Module G** — intent-aware tool scoping (`classifyToolScope` Haiku pre-pass + `getSkillTools` scope filter). Owner-DM tools JSON ~23k → ~12k tokens on typical meetings turn.
- **Module D** — deterministic approval auto-resolve. Thread-bound vague-yes ("yes" / "go" / "כן") on a uniquely-matched pending approval skips orchestrator Sonnet entirely. ~3s → ~300ms latency.
- Prompt trims: CALENDAR ISSUES routing dup, HEBREW GENDERED FORMS verb-list.

### Phase ahead

[#95](https://github.com/odahviing/AI-Executive-Assistant/issues/95) — prompt-reduction project continues in v2.8.x. Modules A (voice/tone scrubber), B (Hebrew processor), C (refusal humanizer), E (length/repetition validator), F (extended claimChecker) all still to build. Plan documented in [.claude/PROJECT_REDUCE_PROMPTS.md](.claude/PROJECT_REDUCE_PROMPTS.md).

### Migration

None. Pure version baseline.

### Not changed

Nothing material since 2.7.7. This is a release-marker bump only.

### Closed during the 2.7 wave

- [#43](https://github.com/odahviing/AI-Executive-Assistant/issues/43) closed completed — workdays + work-hours intersection per attendee (Shabbat, non-Israeli Mon-Fri) shipped across v2.3.6 / v2.7.6; hard constraints intentionally out of scope.
- [#48](https://github.com/odahviing/AI-Executive-Assistant/issues/48) closed not-planned — coord clarify-and-resume sub-state superseded by people_memory auto-load + Sonnet's free-form ask + existing coord_abandon dispatcher.

---

## 2.7.7 — Module G (intent-aware tool scoping) + Module D (deterministic approval auto-resolve)

Two new pre-Sonnet Haiku classifiers landed, both gated by profile yaml flags. (1) **Module G** — every owner turn classifies the relevant tool scopes (`meetings` / `tasks` / `knowledge` / `summary` / `social` / `general`) and `getSkillTools` ships only the always-on core (~24 tools) plus tools in those scopes. Cuts the uncached tools-JSON shipped to Sonnet from ~23k to ~12k tokens on a typical meetings turn (and harder on tasks/summary/knowledge turns). UNION-on-ambiguity + fails open to `general`. (2) **Module D** — when an owner replies in a thread that uniquely matches a pending approval's `terminal_dm_msg_ts`, a Haiku classifier reads the reply as `approve` / `reject` / `pass_to_sonnet`. Clean approve/reject calls `resolveRequest` deterministically and skips the full owner-DM Sonnet turn entirely. ~3s → ~300ms latency on resolved turns; eliminates the multi-pending-approval misroute risk that 2.7.2's thread-bound marker only partially addressed. Plus two prompt trims (CALENDAR ISSUES routing dup at systemPrompt.ts:469, HEBREW GENDERED FORMS verb-list at systemPrompt.ts:443).

### Added

- **Module G: `classifyToolScope`** ([src/core/social/classifyToolScope.ts](src/core/social/classifyToolScope.ts) new). Haiku-based pre-pass that picks 1+ scopes from `meetings | tasks | knowledge | summary | social | general`. Profile-aware (only offers scopes for active skills). Pure-ack short-circuit on `"ok"` / `"thanks"` / `"כן"` etc. — those skip the classifier entirely and get `['general']`. Bias toward UNION when ambiguous (e.g. `"what's pending? also any conflicts?"` → `['tasks', 'meetings']`). Fails open to `['general']` on any error.
- **Module G: scope-filtered `getSkillTools`** ([src/skills/registry.ts](src/skills/registry.ts)). New `ALWAYS_ON_TOOLS` set (~24 tools that ship every owner turn regardless: memory writes, approvals, basic task CRUD, briefing, web, outreach, Slack directory). `SCOPE_TO_TOOLS` map per scope. Owner-path filter: union of always-on + tools in any requested scope. Colleague-path unchanged (static `COLLEAGUE_ALLOWED_TOOLS` allowlist). Unmapped-tool safety net: tools not in `ALWAYS_ON` and not in any scope ship anyway + warn-once log so new tools can't silently disappear.
- **Module G wiring** ([src/core/orchestrator/index.ts](src/core/orchestrator/index.ts)). Calls `classifyToolScope` when `profile.behavior.intent_aware_tools === true`. Diagnostic log line per turn: `Module G — tool scope applied` with scopes + toolsShipped + savedTools.
- **Module D: `tryAutoResolveThreadBoundApproval`** ([src/utils/threadBoundApprovalAutoResolve.ts](src/utils/threadBoundApprovalAutoResolve.ts) new). Pre-filter: thread reply + exactly one `awaiting_owner` request matches `terminal_dm_msg_ts` + message ≤400 chars. Haiku classifier receives the approval CONTEXT (kind, subject, proposed slots, question) plus the reply, returns `approve | reject | pass_to_sonnet`. On approve/reject → calls `resolveRequest` directly. Amend cases pass to Sonnet (counter shape is approval-kind-specific; Haiku can't build it reliably). Fails open: pre-filter miss / classifier error / resolver not-ok → pass to Sonnet so the orchestrator can recover.
- **Module D wiring** ([src/connectors/slack/app.ts](src/connectors/slack/app.ts)). Hooked inside the inbound queue runner, right before `runOrchestrator`. On resolve: reacts ✅ (approve) or ❌ (reject) on the owner's message, calls `markWrite()` so the queue's abort-if-safe gate sees the write, returns early. Resolver itself handles downstream effects (booking, requester DM, closeRequest cascade) so no duplicate text reply needed.
- **Two feature flags** ([src/config/userProfile.ts](src/config/userProfile.ts) behavior block): `intent_aware_tools: boolean` (default false), `deterministic_approval_resolve: boolean` (default false). Owner-path only; colleague path keeps its static allowlists unchanged. Both flags ship off by default so legacy yamls don't change behavior; owner opts in per profile.

### Changed

- **systemPrompt.ts trim** — removed the CALENDAR ISSUES routing line ([systemPrompt.ts:469](src/core/orchestrator/systemPrompt.ts:469), ~280 chars). The "owner says fine → call update_calendar_issue" instruction is already present (more specifically) in MeetingsSkill's prompt section at [meetings.ts:1737](src/skills/meetings.ts:1737). The "don't re-check the same calendar question twice" half is covered by the adjacent THREAD MEMORY rule.
- **systemPrompt.ts trim** — HEBREW GENDERED FORMS block ([systemPrompt.ts:443](src/core/orchestrator/systemPrompt.ts:443)) cut from ~720 to ~370 chars. Removed the 14-verb conjugation list (`אתה / שואל / עובד / ...` and the feminine equivalents) — Sonnet 4.6 knows Hebrew grammar; the rule just needs the actionable bits (apply gender field both directions, unknown → male polite default + ask once, never re-ask after `confirm_gender`).

### Invariants preserved

- Module D does NOT delete the PENDING APPROVALS Binding rules from the system prompt. Sonnet still handles amend, multi-pending-approval threads, ambiguous replies, and topic-changes — those turns still need the binding rules.
- Module G's scope filter applies only on the owner path. Colleagues keep the static `COLLEAGUE_ALLOWED_TOOLS` allowlist as the hard security boundary.
- Both flags default OFF. Existing yamls without the flag continue to ship every tool + run the full orchestrator on every owner turn.

### To enable per profile

```yaml
behavior:
  intent_aware_tools: true
  deterministic_approval_resolve: true
```
Restart `npm run dev` to pick up the changes.

### Project reference

Modules G + D from [.claude/PROJECT_REDUCE_PROMPTS.md](.claude/PROJECT_REDUCE_PROMPTS.md). Per project plan: each module ships as its own patch. Remaining modules (A / B / F / E / C) are smaller post-draft scrubbers (voice/tone, Hebrew output, honesty rules extension, length validator, refusal humanizer) and can ship independently.

---

## 2.7.6 — Per-attendee slot blame, auto-relaxed recovery on narrow windows, tool consolidation

Two sessions of compounding improvements. (1) When `find_available_slots` rejects a slot for a busy collision, the cause is now attributed by email — owner-side busy stays `owner_busy_collision`, attendee-side becomes `attendee_busy_collision:<email>`, and day_summary surfaces a `blocked_by` aggregate so Sonnet can narrate "Isaac blocked 8 slots Monday" instead of fabricating "Monday is fully booked." (2) On owner-named narrow windows (≤7 days), when the strict pass returns 0 slots, the tool auto-retries with `relaxed=true` and tags the result so Sonnet presents the soft-rule violation explicitly ("12:30 fits everyone but eats into your focus block — book anyway?") instead of returning empty. (3) Two tool consolidations: `dismiss_calendar_issue` folded into `update_calendar_issue` (cross-skill merge, two storage models stay separate but one tool surface); `list_company_knowledge` folded into `get_company_knowledge` (omit `section_id` → catalog, pass it → content). Tool count 56 → 54. Plus a P1+P2 prompt-bloat pass on tool descriptions.

### Added

- **Per-attendee blame in `findAvailableSlots`** (`src/connectors/graph/calendar.ts`). Each busy interval is now tagged with its source email; rule-8 rejections become `owner_busy_collision` (owner's own) or `attendee_busy_collision:<email>` (specific attendee). `day_summary[].blocked_by` aggregates per-day per-attendee slot counts. Closes "Monday is fully booked" misattribution when an attendee's calendar was the real blocker. Owner direction: "did Maelle go only for me, or the other?".
- **Auto-relaxed recovery on user-named narrow windows** (`src/skills/meetings/ops.ts`). When the strict pass returns 0 AND the user named a specific day/window (≤7 days) AND owner didn't already opt into `relaxed`, the handler auto-runs a second pass with `relaxed: true` (bypasses focus/lunch/work-hours, keeps attendee-busy enforced). Result is tagged `_relaxed_recovery: true` with a `_recovery_note` instructing Sonnet to narrate the trade-off using the STRICT `day_summary` (the original blame, not the relaxed pass). Owner-path only. Closes the "Monday 10:30?" → "Monday fully booked" pattern when the right answer was "fits but breaks your focus block — book anyway?".
- **Narrow-window detection in slot search** (`src/skills/meetings/ops.ts`). When the span between `search_from` and `search_to` is ≤7 days, `autoExpand` is disabled — open-ended "when can we meet" asks keep the auto-expand behavior. Pairs with the auto-relaxed recovery above.

### Changed

- **`update_calendar_issue` now handles both tracked and analyze-calendar paths** (`src/skills/calendarHealth.ts`, `src/skills/meetings.ts`, `src/skills/meetings/ops.ts`). Pre-fix two tools handled "owner says it's fine about an issue": `update_calendar_issue` (DB-keyed tracked rows) and `dismiss_calendar_issue` (fingerprint-keyed analyze-calendar issues). Same intent, two storage models, two tool surfaces — Sonnet had to know which to call. Now one tool: pass `issue_id` for tracked rows (statuses `approved | to_resolve | resolved`), or pass `event_date + issue_type + detail` for analyze-calendar issues (statuses `dismissed | resolved`). Storage models stay separate; tool surface unifies. References cleaned in WRITE_TOOLS, textScrubber, orchestrator verb map + history rendering, system prompt, MeetingsSkill prompt section.
- **`get_company_knowledge` does list + fetch in one tool** (`src/skills/knowledge.ts`). Same pattern as `recall_preferences(category?, key?)`. Omit `section_id` → catalog of available sections; pass it → fetch that section's markdown content. `list_company_knowledge` removed. References cleaned in textScrubber, orchestrator verb map, toolStatusText.
- **`resolveLocation`: owner explicit `is_online=false` now auto-stamps office/Meeting Room/Huddle by day type** (`src/utils/resolveLocation.ts`). Pre-fix, owner saying "in person" without a venue produced an empty `location` field — meetings landed with no address. Now: office day + internal-only ≤3 → office stamp; office day + internal >3 → Meeting Room; home day → Huddle; vacation day → empty (untouched). Hand-in-glove with the existing day-type defaults; the only new branch is the previously-broken empty-location path.
- **`formatOfficeLocation` is attendee-aware** (`src/utils/resolveLocation.ts`). Internal-only meetings get the short office label (colleagues already know where the office is); meetings with at least one external attendee get the full address + parking notes. Threading `hasExternalAttendee` through the three call sites where it's known.
- **`getFreeBusy` guards against invalid time windows** (`src/connectors/graph/calendar.ts`). Pre-fix, edge cases in the auto-expand loop could produce zero or inverted windows; Graph returned an opaque `ErrorInvalidTimeInterval` 400 that crashed the slot finder mid-iteration. New guards: zero/inverted window → empty result + warn; >62 days → clamp to 62 + recurse; `ErrorInvalidTimeInterval` from Graph → catch + return empty + warn. Graph's hard requirement (1h–62 day window, start<end) is now enforced before the wire call.
- **Tool description hygiene pass** (`src/skills/meetings.ts`, `src/core/assistant.ts`). P1 dedupe: `coordinate_meeting` description lost its Duration paragraph + Location auto-determination block + Date-range line (all duplicated in MeetingsSkill cached prompt section); `relaxed` arg description on `find_available_slots`, `create_meeting`, `move_meeting` collapsed to a one-line pointer ("see OWNER-PATH OVERRIDE rule in skill section"); `confirm_outside_window` on `move_meeting` same. P2 trim: `learn_preference` cut ~1500 → ~400 chars (removed the 3× "what NOT to use for" repetition); `update_person_memory` ~1000 → ~600 chars (tightened "no social topics" duplication and the section-header explainer). Side win: the three `relaxed` descriptions had a `${firstName}` template inside a single-quoted string — shipping literally as text — removed by the trim.

### Removed

- **`dismiss_calendar_issue` tool** — capability folded into `update_calendar_issue` (see above).
- **`list_company_knowledge` tool** — capability folded into `get_company_knowledge` (see above).

### Added (docs)

- **`.claude/PROJECT_REDUCE_PROMPTS.md`** — the multi-version prompt-reduction project plan ([#95](https://github.com/odahviing/issues/95)). 7 modules sketched (D / A / B / F / E / C / G), build order, caching trade-off notes, standing rules. Read first when continuing this project in a new chat.

### Tool count

56 → 54. Calendar-issue trio (`get_calendar_issues` / `update_calendar_issue` / `dismiss_calendar_issue`) → pair; knowledge-base pair (`list_company_knowledge` / `get_company_knowledge`) → single.

---

## 2.7.5 — Slot-finder reform, owner override widened, Slack status text, prompt cache restructure

A session of compounding improvements: slot-finder now prefers same-day options on moves (and packs same-day on new bookings); owner's "override" flag truly overrides — bypasses his own busy AND attendee busy when he says "book it anyway"; floating blocks coexist with meetings in the conflict check (Outlook does, so should we); Slack assistant-panel status now reads from a per-tool map with Slack's built-in rotating defaults ("Gathering information…", "Reviewing findings…", "Summarizing findings…") explicitly suppressed; assistant-thread registry moved to SQLite so panel registrations survive `npm run dev` restarts; system prompt restructured to push ~7k tokens of timeless content from the dynamic chunk into the cached chunk; new `day_summary` diagnostic from find_available_slots lets Sonnet answer "why no Monday?" honestly instead of fabricating.

### Added

- **`pickSpreadSlots` anchor-day support + same-day packing** (`src/connectors/graph/calendar.ts`). New optional `anchorDay` parameter — when set (only on owner-path moves), the picker walks the anchor day FIRST, then other days chronologically. Packs up to 2 slots per day with ≥1h gap before spilling. Closes the "move BiWeekly off Mon 18" / "got offered Sun + Mon + Tue but expected 2 on Mon + 1 alt-day" pattern. New bookings (no anchor) get the same pack-up-to-2-then-spill shape — "find me time next week" yields 2 Sunday + 1 Monday instead of 1 per day across 3 days. Owner spec: "I never ask for 3 days, I ask for at least 2."
- **`day_summary` diagnostic on find_available_slots** (`src/connectors/graph/calendar.ts`, `src/skills/meetings/ops.ts`). When 0 slots come back, the tool now returns a `day_summary[]` with per-workday `{ date, accepted, top_reasons }`. `wrong_day_type` reason emitted for workweek days excluded by the requested mode (e.g. Monday is home day, meetingMode='in_person'). `outside_owner_work_hours` filtered out of top_reasons as iteration noise. Paired prompt rule (EXPLAINING WHY A DAY ISN'T OFFERED in `meetings.ts`) teaches Sonnet to narrate from this data instead of fabricating ("Monday is a day off" — fact-free hallucination from the painful Sales BiWeekly conversation). Surfaced alongside slots in the tool result.
- **Per-tool Slack assistant-panel status text** (`src/utils/toolStatusText.ts` new, `src/core/orchestrator/index.ts`). `TOOL_STATUS_TEXT` map of human-EA-voiced phrases ("Checking calendar", "Booking it", "Reaching out to find a time", "Closing the time", "Memorizing it"). Replaces literal `'Working…'`. Unmapped tools (observation/memory side-effects) get empty string. Orchestrator also fires `"On it"` at the very start of every turn before classifyOwnerIntent — closes the ~10s gap between message landing and first tool firing.
- **`loading_messages: ['']` on every `setAssistantStatus` call** (`src/connections/slack/messaging.ts`). Slack's Agents & AI Apps framework rotates built-in defaults ("Gathering information…", "Reviewing findings…", "Summarizing findings…", "Finding answers…") when `loading_messages` is omitted. Passing a single empty-string array gives Slack nothing to rotate — collapses the top banner. Bottom status (our per-tool text) remains.
- **DB-backed assistant-thread registry** (`src/connectors/slack/assistantThreads.ts` rewritten, `src/db/client.ts` new `assistant_threads` table). Pre-fix the registry was in-memory only; every `npm run dev` restart emptied it, and `assistant_thread_started` only fires on FIRST open of a panel thread (Slack doesn't re-fire on reconnect). Now writes registrations to SQLite with 24h TTL; `isAssistantThread()` reads cache-first then DB. Survives restarts. First-time only: existing open panel threads from before the upgrade need one close+reopen to register into the new table.
- **`overlapping_events` in `book_floating_block` result** (`src/skills/calendarHealth.ts`). When a floating block is booked over a window containing other meetings, the tool result lists them so Maelle can offer to move them. Pairs with the rule-8 bypass for floating blocks (see Changed).
- **`measure-prompts.cjs` script** (`scripts/measure-prompts.cjs`). One-shot tool that loads the active profile + invokes the real prompt builders and reports system-prompt + tool-JSON sizes in chars/tokens. Used to quantify the cache-restructure win and to find prompt-bloat hotspots for the upcoming code-replacement work.

### Changed

- **`scheduleRules` rule 8 (owner_busy_collision) — owner override now actually overrides** (`src/utils/scheduleRules.ts`). Pre-fix, `allowRelaxed=true` bypassed work-hours / floating-block / focus rules but NOT owner_busy. So when owner said "book it anyway, I'll handle the fallout," the tool still refused on a busy conflict. Now bypassed when `allowRelaxed=true` OR `isFloatingBlock=true`. Owner direction: "it's my calendar — I can double-book myself any time I want. Maelle can flag once, but after I approve she just books." Regular create_meeting first attempt still flags overlaps via `confirm_override`; after approve+retry with `relaxed: true`, rule 8 skips and the booking lands.
- **Floating blocks bypass owner_busy_collision unconditionally** (`src/utils/scheduleRules.ts` + `src/skills/meetings/planMeeting.ts` + `src/skills/calendarHealth.ts`). Focus / lunch / gym / "no meetings" blocks are SIGNALS that coexist with meetings, not competing time slots — Outlook accepts overlapping events, so does this rule now. `book_floating_block` always passes `isFloatingBlock: true` to planMeeting; rule 8 skips. Overlap surfaces via the new `overlapping_events` result field so Sonnet can narrate "blocked 13:00–18:15; your BiWeekly at 17:00 sits inside — want me to move it?"
- **`relaxed: true` on owner-path implies `ignoreAttendeeBusy: true`** (`src/skills/meetings/ops.ts`). When owner says "force it," he's overriding everyone's other meetings, not just his own. Their work-hours / timezone window stays enforced ("force them to move a meeting, not to wake up at 3 AM"). Symmetric with rule-8 bypass: owner override is now consistent across his own busy and attendees' busy.
- **`find_available_slots` auto-fills attendees from moving event on owner-path** (`src/skills/meetings/ops.ts` + `src/utils/movingEventAttendees.ts` new). When `moving_event_ids` is set AND `senderRole='owner'`, the handler reads the moving event's attendee list from the calendar (cheap — per-turn memoized) and unions with any explicit `attendee_emails`. Sonnet can't forget to pass attendees on a move — the tool reads them itself. Colleague-path unchanged (keeps the v2.7.0 per-attendee annotation behavior so Brett sees all slots with `free/busy/tentative/unknown` tags). Closes the painful Sales BiWeekly trace where Sonnet's later call dropped Isaac from the attendee list and 17:00 was proposed without Isaac being verified.
- **System prompt cache restructure** (`src/core/orchestrator/systemPrompt.ts` rewritten). Pre-fix, only `skillsSection` was cached; everything else (identity, honesty rules, tone, language, hebrew, channels, calendar invites, auth, mpim rules, owner learning) was treated as dynamic and billed full price every turn. New layout: STATIC includes all timeless content; DYNAMIC contains only state-changing content (date/time tables, prefs catalog, people memory, pending approvals). Owner-DM dynamic chunk: ~10.5k → ~3.3k tokens. Effective per-turn cost on system prompt drops ~50% within the 5-min cache window. No content deleted, no content moved between owner/colleague paths — pure reordering for cache friendliness. Static block must come before dynamic in the API request (Anthropic prompt-caching requirement); orchestrator already attached `cache_control: ephemeral` to the first block.
- **`pickSpreadSlots` policy unified across new bookings and moves** (`src/connectors/graph/calendar.ts`). Pre-fix the picker walked candidates chronologically and took the FIRST valid slot per day — one slot per day until 3 days were filled. New policy: walk days in order (anchor day first if set, else chronological), pack up to 2 slots per day with ≥1h gap. Honors `MAX_PER_DAY=2` + hard rule "≥2 unique days when returning 3." Same picker used by all 5 call sites (owner-direct find_available_slots, coord 2 call sites, coordinator.ts, coord state machine new-slot proposal).
- **`CONVERGENCE IS BINDING` replaces `PROPOSED SLOTS ARE BINDING`** (`src/skills/meetings.ts`). The old rule fired only when slot picks had been listed and owner said yes. Extended to ANY narrowed plan (specific times, focus windows, blocks to book). Trigger list extended to "I already said yes" — closes the Thursday focus-block pattern where owner said yes twice and Maelle still asked "Want me to...?" a third time. Inline clause: when owner declares a future state ("the BiWeekly will be moved, block until home time"), plan around it as if done — don't refuse the primary action because of a state owner just said is changing. Single rule replaces three previous patterns; net token cost unchanged.
- **Tool description: `meeting_mode` mapping covers `onsite`** (`src/skills/meetings.ts`). Added `"onsite"`, `"at our office"`, `"from the office"`, `"in the office"` to the in_person mapping line. Pre-fix Sonnet read "onsite" as off-site (asked travel time). New `ONLINE ≠ "AT HOME"` clause clarifies online is a connection method, not a location — Sonnet stops conflating "online meeting" with "owner attends from home."

### Fixed

- **Status-indicator gap during pre-first-tool reasoning**. Slack's defaults filled the ~10s window between message landing and Sonnet's first tool call (`classifyOwnerIntent` + initial reasoning). Now fires `"On it"` at orchestrator start before any sidecar Sonnet calls. Combined with `loading_messages: ['']`, the top rotating banner is suppressed and the bottom status shows our text from message landing through final reply.

### Migration

One-time only: after deploy, existing open Slack assistant-panel threads need one close + reopen so the new SQLite-backed registry receives an `assistant_thread_started` event and writes a row. Once registered, restarts no longer break status display.

### Not changed

- No prompt content was deleted in the system-prompt cache restructure — only reordered. The same blocks ship to Sonnet in the same wording; only the cache attachment point changed.
- Tool descriptions unchanged in size (still ~23k tokens for owner, ~13k for colleague). Tool-side cleanup deferred to a planned code-replacement wave.

---

## 2.7.4 — Bug bash: attendee filter, dismissal fingerprint, privacy mask, orphan lifecycle, deterministic narration, floating→planMeeting

Six bugs caught from two real-day brief inspections: (1) the morning routine narrated "I started moving Michal" when no coord row actually existed; (2) lunches booked without categories; (3) auto-categorize leaked an Interview event's full subject ("Ami Sterling Intro VP Marketing Reflectiz") into the brief despite Outlook marking it private; (4) a dismissed Monday overlap was re-flagged the next morning; (5) a failed booking left an orphan `in_flight_action` request that surfaced in every brief with Sonnet improvising "I'm still working on it"; (6) floating-block bookings used a separate path from regular bookings — different category-resolution, different rule-check, different category outcomes.

### Fixed

- **Attendee filter — `'none'` is not a declined attendee** (`src/utils/attendeeScope.ts` + 2 sites in `src/skills/calendarHealth.ts`). Microsoft Graph's `responseStatus.response === 'none'` is the default state for attendees who haven't been tracked yet (common when YOU are the organizer and they haven't accepted). Pre-fix, four code sites filtered `'none'` as if it meant "declined" — silently stripping real attendees. **Root cause of "I started moving Michal" with no coord row**: Michal's status was `'none'` (untracked), filter dropped her, autofix saw empty attendees and never initiated coord. Now only `'declined'` is filtered.
- **Dismissal fingerprint stabilized** (`src/db/calendarIssues.ts`). Old fingerprint was `(type, prose-description)` — broke whenever description prose differed between runs (Sonnet free-form vs analyzer structured), or when type was reclassified (`back_to_back` vs `double_booking` for the same overlap). New fingerprint uses `(normalized_class, sorted_event_ids)` when event IDs are available; falls back to prose-based for legacy callers. Result: dismissals carry across runs deterministically. Items dismissed before this fix may re-flag once after deploy; subsequent runs match.
- **Brief leak: Interview subject auto-categorized into "applied" item with raw subject text**. The `result.applied[].subject` field in `autoCategorize.ts` stored the raw event subject regardless of Outlook's sensitivity flag — so when the brief Sonnet quoted "Tagged 'Ami Sterling Intro VP Marketing' as Interview", an interview that was marked private leaked verbatim. New `src/utils/displaySubject.ts` helper masks `[Private]` when `event.sensitivity ∈ {'private','personal'}` OR any event category carries `sets_sensitivity_private: true` in yaml. Refactored: `autoCategorize.applied[]`, `autoCategorize.skipped_unmatched[]`, `analyzeCalendar` issue descriptions (both event subjects in overlap), `analyzeCalendar` suggestion strings, and `initiateCoordination` subject argument from the autofix path. Read-side legitimate use (classification, attendee lookup) reads `event.subject` directly with intent; only WRITE-TO-TEXT paths route through `displaySubject`.
- **A2 orphan request lifecycle** (`src/core/requests/maybeOpenInFlightMeetingRequest.ts`). Pre-fix, `in_flight_action` follow_up requests had no `expires_at` and no `next_check_at`, so failed tool calls left forever-orphan rows that surfaced in every brief. Now sets `expires_at` + `next_check_at` to +24h with `next_check_handler='expiry'`. The runner's existing `runExpiry` handles closure cleanly. Cleanup script `scripts/cleanup-orphan-in-flight-actions.cjs` ran during this session to close the one stale row (the Do Not Schedule block from May 13 that never booked because `relaxed` wasn't declared on the tool yet).

### Changed

- **Route 2 deterministic narration for `check_calendar_health`** (`src/skills/calendarHealth.ts`). The tool result now carries a `summary_text` field built deterministically from per-issue `fix_detail` / `fix_failed` / `fix_error`. ✓ lines for successful fixes, × lines for failed attempts (with the actual reason), ! lines for detected-but-unfixed. Routine narration prompt updated: use `summary_text` verbatim. humanGate humanizes the template into natural EA voice. Root fix for the "I started moving Michal" fabrication — Sonnet no longer improvises "what got done" from the issue list; she reads the deterministic summary. Internal-actions push added to the move-coord branch (was missing; previously the autofix succeeded without signaling, making claim-checker's job impossible).
- **`book_floating_block` routes through `planMeeting`** (`src/skills/calendarHealth.ts`, owner direction #3 from this session). Window-aware slot search stays in `book_floating_block` (preferred_start/end, can_skip, day-of-week scope, alignment). Once the slot is determined, the booking step delegates to `planMeeting` with `intent='new_booking'` — same engine as `create_meeting` / `move_meeting`. Category detection, location resolution, rule-check (work hours, owner busy, floating-block-movability, travel buffer) all unified. Fallback to yaml `block.default_category` when planMeeting's `detectCategory` returns null. `confirm_outside_window=true` translates to `allowRelaxed=true` so the override flow lands. Both booking sites (override path + positional path) join the unified flow. Side effect: lunch (no `default_category` in yaml) now gets correctly tagged as `Logistic` via planMeeting's detection.

### Migration

No schema changes. The dismissal fingerprint change is forward-compatible — existing dismissed rows in the legacy key format may re-flag once after deploy; re-dismissing them produces the new stable key and they stay dismissed afterward.

---

## 2.7.3 — Slack assistant-panel surface + "Working…" indicator

Slack's mid-2026 "Slack Agents" rollout is mostly branding on top of the same Slack-app model — no new platform layer, existing Bolt + socket-mode handlers unchanged. The genuinely useful new affordances are the dedicated assistant-panel UI and an in-panel status indicator while tools run. This patch opts Maelle into both, additively. Regular DM continues to work identically.

### Added

- **`assistant_thread_started` event handler** ([src/connectors/slack/app.ts](src/connectors/slack/app.ts), [src/connectors/slack/assistantThreads.ts](src/connectors/slack/assistantThreads.ts) new). When a user opens Maelle in the Slack assistant panel, the event registers the (channel_id, thread_ts) pair in a process-level Map with 24h TTL. No greeting message — the panel's native suggested-prompts UI handles that.
- **`setAssistantStatus` primitive** ([src/connections/slack/messaging.ts](src/connections/slack/messaging.ts)). Wraps Slack's `assistant.threads.setStatus` API. Fire-and-forget; failures are non-fatal (swallows the API error when called on a non-assistant thread). Requires `assistant:write` scope.
- **"Working…" status fired before each tool call** in the orchestrator ([src/core/orchestrator/index.ts](src/core/orchestrator/index.ts)). Consults the assistant-thread registry to skip the API call when in regular DM. Closes the silence gap when Maelle spends 5-15s running multiple tool iterations.

### Manifest changes (owner action required)

This release needs Slack-side configuration to take effect. In the Slack app dashboard:

1. **OAuth scopes** — add `assistant:write` under Bot Token Scopes.
2. **Event subscriptions** — subscribe to `assistant_thread_started` (under Bot Events).
3. **App home / agent features** — under "Agents & AI Apps", enable the assistant feature. Optionally configure suggested prompts.
4. Reinstall the app to your workspace so the new scope takes effect.

No manifest file in the repo — Maelle's Slack app is configured per-tenant via the Slack dashboard. Bot token comes from `profile.assistant.slack.bot_token` as before.

### Not changed

- Regular DM behavior — identical to v2.7.2. The assistant panel is a NEW surface, not a replacement.
- Event handlers for `app_mention`, `message`, `reaction_added` — unchanged.
- Bolt version — still `^3.19.0`. The `Assistant` helper class (Bolt 4.x) isn't used; we wire the event + status API at the lower level for zero breaking-change risk.
- Tool execution latency — `setAssistantStatus` is fired with `void` (no await), so it doesn't add to turn latency.

---

## 2.7.2 — Phase 2 cutover-finish: kill the coord fast path, requests as engine, deferred action replay

Driven by two real-chat bugs this morning: (1) Idan asked Maelle to block his Thursday morning 8:00-10:30; the override path didn't take because `relaxed` was declared on `find_available_slots` but never on `create_meeting` / `move_meeting` even though the handlers read it — pure tool-def oversight from the v2.7.0 trilogy. (2) Gidon (external) DMed asking for 30 min; full back-and-forth conversation, slot/subject/email all collected, zero tools fired — DB trace showed NO coord row, NO outreach row, NO request, NO calendar event. Maelle had said "I will approve and send the invitation" and stopped. Root: the v2.6.5 coord fast path (Case B — owner-only-pollable) returned slots and required Sonnet to switch tools (coordinate_meeting → create_meeting) for the booking step; she didn't switch, narrated "I'll send" without firing.

Owner direction: one strong flow, no mid-conversation tool switching. Kill the fast path. Drive every process from the requests spine. Approvals get a "redirect URL token" pattern so resolving auto-replays the original tool with the override flag.

### Removed

- **Coord fast path entirely (both Case A all-internal and Case B owner-only-pollable)** at [src/skills/meetings.ts:1178-1281](src/skills/meetings.ts) (was 100+ lines of annotate-slots-then-return code). `coordinate_meeting` now ALWAYS goes through the state-machine path. When there's no internal pollable non-owner attendee, the tool refuses with `error: 'no_internal_to_poll'` and a clear message pointing Sonnet to the direct booking path: `find_available_slots` + `create_meeting`. One flow. Helper `isAllInternalParticipants` in `src/utils/attendeeScope.ts` deleted (was sole consumer was the fast path).

### Added

- **`relaxed` flag declared on `create_meeting` and `move_meeting` tool input_schemas** at [src/skills/meetings.ts](src/skills/meetings.ts). The handler code (added v2.7.0) was reading `args.relaxed === true` but the tool defs never declared it, so Sonnet couldn't see the parameter and the override path (Bundle D in v2.7.1) was effectively dead. This was the v2.7.0 oversight that caused both the Ysrael 17:00 loop AND today's 08:00 block failure. Tool defs now match handler behavior.
- **Deferred action replay (the "redirect URL token" pattern)** — when `create_meeting` / `move_meeting` return `rule_violation`, the result now carries `_deferred_action_hint: { tool, args }`. The orchestrator auto-attaches this to `create_approval(kind=policy_exception).payload.deferred_action` for the same turn — no Sonnet copying required. The resolver, on owner approve, replays the original tool with `relaxed: true` (or `confirm_outside_window: true` for `book_floating_block`) via the new `src/core/requests/deferredActionReplay.ts` helper. Closes the long-standing gap where a colleague-path approval got approved but the booking never executed (root of the Ysrael 2026-05-12 "approved but never moved" failure even before v2.7.1's Bundle D).

### Changed

- **Outreach dispatchers defer to the request runner** ([src/tasks/dispatchers/outreachExpiry.ts](src/tasks/dispatchers/outreachExpiry.ts), [outreachDecision.ts](src/tasks/dispatchers/outreachDecision.ts), [outreachSend.ts](src/tasks/dispatchers/outreachSend.ts)). When the legacy `outreach_jobs` row has `request_id` set (Phase 1 bridge from v2.7.1), the runner's `runOutreachExpiryOrDecision` / `runSendScheduledOutreach` handlers are authoritative — the legacy dispatchers no-op to avoid double-fire. Both timer paths converge on requests as the source of truth.
- **Coord mid-state cascade to requests** ([src/db/jobs.ts](src/db/jobs.ts) `updateCoordJob`). When coord status transitions to `waiting_owner` / `collecting` / `negotiating` / `resolving`, the linked request's state mirrors (`awaiting_owner` for waiting_owner, `in_flight` for the in-progress states). v2.7.1 Phase 1 added the terminal cascade; this adds the mid-state cascade so the brief + system-prompt `awaiting_owner` block read truth throughout the coord lifecycle — not just at terminal.
- **`humanGate` ❌/✅ patterns tightened** ([src/utils/humanGate.ts](src/utils/humanGate.ts)). New patterns caught: (a) "Want me to note it down for you to add directly in Outlook" / "you can add it manually in your calendar" — abdication of EA work, ❌. (b) "I will approve" / "אאשר" / "I'll sign off and send" — claiming the approver role she doesn't have, ❌. Both surface today: 1.2 (abdication on the failed block override) and 2.2 (the Gidon coord ending in "I will approve and send" with no tool firing).
- **`coordinate_meeting` tool description rewritten** to reflect post-fast-path reality — the tool is ONLY for multi-party with internal pollable non-owner attendees; everything else routes through `find_available_slots` + `create_meeting`. Prompt section at meetings.ts also updated: the old "FAST PATH" block replaced with "DIRECT BOOKING PATH" guidance.

### Fixed

- **Bug 1.1: 8:00-10:30 block override didn't take.** Root: `relaxed` flag undeclared on tool schema. Fixed by declaring it.
- **Bug 1.2: "have me add it in Outlook" abdication.** Root: humanGate didn't catch the pattern. Fixed by tightening the prompt template.
- **Bug 2.1: asked Gidon for email already in people_memory.** This bug becomes moot under the new direct-booking path — when there's no fast-path return, Sonnet uses people_memory for participants directly (handler already auto-fills from `getPersonMemory(slack_id)` via [meetings.ts:528-549](src/skills/meetings.ts)).
- **Bug 2.2: "I will approve and send" bot-voice.** Fixed at the language layer via humanGate; root behavior fix is bug 2.3.
- **Bug 2.3: Gidon coord conversation ended with zero tools fired.** Root: Sonnet had to switch tools (coordinate_meeting → create_meeting) at the booking moment and didn't. Architectural fix: no more fast path. Sonnet uses `find_available_slots` + `create_meeting` from the start — one tool to fire at the booking moment, no switching, no narration without action.
- **Typecheck regression in v2.7.1 Phase 1 bridges** (`db/jobs.ts:132` and `db/jobs.ts:515`). `await_reply === false` should have been `=== 0` (number, not boolean). `=== 'awaiting_owner'` was a dead branch (the coord_jobs enum only has `waiting_owner`). Caught at owner's local typecheck; folded into this patch.

### Phase 2 of v2.7.0 cutover-finish

This patch completes the readers-migrated-to-requests work flagged in [#94](https://github.com/odahviing/AI-Executive-Assistant/issues/94). Combined with v2.7.1's Phase 1 (writers bridge), the spine now drives every async process: outreach (send/expiry/decision via runner), coord (state mirrored to requests at every transition), approvals (deferred action replay). Phase 3 (drop legacy tables entirely) is deferred — owner direction: "I less care if we truncate the tables; I more care that every process runs from requests" — that's now true.

The fast-path deletion is the headline simplification: ~110 lines of branching code removed, plus the per-attendee annotation logic, plus the prompt's FAST PATH section, plus the `isAllInternalParticipants` helper. One coordinator path remains: state-machine multi-party with internal pollables. Everything else goes through find_available_slots + create_meeting directly.

---

## 2.7.1 — Day-1 bug-bash on the 2.7 trilogy: buffer-rule deletion, attendee freebusy, requests-spine bridges

First patch after v2.7.0 went live, driven by two real-chat incidents (the Ysrael BiWeekly approval loop that never moved the meeting, plus the morning brief that fabricated a move-coord that didn't happen). Two interactive bug-test sessions surfaced 8 atomic bugs across 4 groups, all rooted in the v2.7.0 spine being half-built: writers weren't bridging into the requests table, so the brief was reading half the truth and Sonnet filled the gap with hallucinations. Phase 1 of the cutover-finish lands here — every legacy `coord_jobs` / `outreach_jobs` / `approvals` write now creates a paired `requests` row, so the brief sees one source of truth.

### Added

- **`createOutreachJob` / `createCoordJob` / `createApproval` bridge to requests spine** (`src/db/jobs.ts`, `src/db/approvals.ts`). Every legacy-table write now also creates a `requests` row (kind=outreach / coord / approval) and stores the request_id on the legacy row. State mapping per kind handled inline. The terminal-status hooks on `updateOutreachJob` (v2.6.1 D4) and `updateCoordJob` (v2.7.0) already closed linked requests; now `setApprovalDecision` mirrors the pattern for approvals too. This closes the brief-hallucination class: pre-fix, an autofix move-coord that started via `initiateCoordination` wrote `coord_jobs` only; the brief reads `requests` only; the work was invisible, so Sonnet narrated whatever sounded plausible.
- **`approvals.request_id` column** (`src/db/client.ts`, idempotent ALTER) — was missing relative to its sibling tables (`coord_jobs` and `outreach_jobs` had it).
- **`planMeeting` checks internal-attendee freebusy on owner-initiated move/booking** (`src/skills/meetings/planMeeting.ts`). When the owner asks to move or book a meeting that has internal attendees, the pipeline now calls `getFreeBusy` for those attendees and surfaces `confirm_override` with a clear "X is on another meeting at HH:mm" ask if any are busy. Override path stays open via `relaxed=true`. Colleague-initiated path unchanged — slot finder already annotates per-attendee status there; busy is annotation, not block. This was in the original `planMeeting` design intent and was missing on owner-path.
- **`requests.follow_up` of subkind `in_flight_action` opened from the orchestrator when owner-initiated meeting work spills past one turn** (`src/core/requests/maybeOpenInFlightMeetingRequest.ts` + call site in `src/core/orchestrator/index.ts`). When `find_available_slots(moving_event_ids=...)`, `create_meeting`, `move_meeting`, or `delete_meeting` returns a non-clean state (rule_violation, options for owner to pick, error), a tracking request is opened. Idempotency keyed on (owner, thread, subject/event) so re-asking in the same thread doesn't double-create. Closure rides on existing rails: `closeMeetingArtifacts` cascade closes on calendar mutation; `closeLoopOnOwnerHandled` scanner closes on free-text "drop it" / "forget that". No new tool exposed to Sonnet — deterministic auto-create only.
- **`scripts/cleanup-stale-policy-exception.cjs`** — one-shot DB cleanup for approval requests that were owner-approved but whose underlying action never executed (pre-v2.7.1 owner-path policy_exception loop bug). Marks them `state='expired'` with `closure_reason='action_never_executed'` so the brief stops narrating them as "you approved → done". Bundle B + D prevent recurrence; this script clears the one stale Ysrael row that triggered today's brief lie.

### Changed

- **Owner-path overrides retry in-thread, NEVER via a separate approval DM** (`src/skills/meetings.ts`). The OWNER-PATH OVERRIDE prompt block rewritten with explicit ❌/✅ examples: when `planMeeting` returns `confirm_override`, Sonnet asks once in-thread; on owner "yes / book anyway", she re-calls the same tool with `relaxed=true`. `create_approval(kind=policy_exception)` is colleague-path only — sending the owner a separate DM to approve his own ask he just confirmed conversationally is redundant and stalls the action. This closes the Ysrael cascade where the approval DM was approved but the underlying move never executed because Sonnet didn't know to retry with the override flag.
- **Audience-aware reasoning** (`src/skills/meetings.ts`). When the owner asks why a slot is unavailable, narration can name the rule plainly ("Thursday is packed 10:45 → 17:00 inside your office hours"). When a colleague asks, narration stays high-level ("Idan can't make that work" / "his Thursday is packed") — never expose internal mechanics like "his lunch window" / "5-min buffer" / "focus-time protection" / "per-day category limit". One principle, no enumerated rules. Plus a new rule: when `find_available_slots` returns 0 slots for a day the owner specifically asked about, the narration must explain WHY in the first answer (and offer the override path for owner-path) — don't pivot silently to other days.
- **Calendar overview routes through `analyze_calendar`** (prompt rule). When summarizing the week / next week / "any issues?", Sonnet calls `analyze_calendar` for the date range and surfaces only issues it returns (with their stable issue_ids). She doesn't eyeball overlaps from `get_calendar` results — the analyzer's silence is the source of truth. Owner "don't worry about that one" → existing `dismiss_calendar_issue` tool persists the dismissal so the next overview doesn't re-flag.
- **Brief auto_categorized item — split applied vs skipped_unmatched** (`src/tasks/briefs.ts`). For events Maelle figured out → one informational past-tense line ("Tagged 'Elinor & Idan Biweekly' as Weekly."). For events she couldn't classify → ASK what category, open-ended ("'Idan & Michael' — what category should that be?"). Never propose a specific category as the default in the question; that primes the wrong answer when she genuinely doesn't know.
- **Tombstoned-colleague brief line tightened** (`src/tasks/briefs.ts`). Explicit ❌/✅ examples: ✅ "I'll stop pinging Yael for now — she hasn't replied to a few of my pings." ❌ "Yael is no longer active in the system" / "removed from my working list" / anything that exposes internal tracking or bot framing.
- **`humanGate` wired into morning brief** (`src/tasks/briefs.ts`). Brief generator now runs the same owner-facing voice/persona check that `postReply.ts` uses, between brief generation and Slack post. One Sonnet rewrite pass on flag, fails open. Pre-fix the brief skipped this layer, letting machine framing like "no longer active in the system" leak through.

### Fixed

- **Rule (9) `owner_buffer_collision` deleted from `scheduleRules.ts`** — the 5-min between-meeting buffer is baked into the standard durations (10/25/40/55) at aligned starts (:00/:15/:30/:45); a separate collision check duplicated the work and incorrectly rejected slots starting at the same minute another meeting ended (e.g., 17:00 right after a meeting that ended 17:00). This was the root cause of the Ysrael cascade: the slot finder rejected the valid 17:00 Thursday slot, leading Maelle down an approval-DM rabbit hole that ended with the meeting never moving. Connected back-to-backs are the preferred shape per the existing prompt rule at `meetings.ts:1761` ("a 55-min meeting at 17:00 ends 17:55, leaving 5 min before 18:00 automatically"). Travel buffer (custom-mode meetings + categories with `requires_travel_buffer`) is untouched — that's a separate, real rule. Dead `isBufferOnly` carve-out in `ops.ts` also removed.
- **Brief no longer auto-generates approvals on owner-path** when a rule fails (root cause of the Ysrael "you approved, never moved" pattern). Owner-path conversational ask IS the approval; retry with `relaxed=true` is the action. Closed by Bundle D prompt rules.
- **One-shot cleanup of stale Ysrael policy_exception row** (`req_1778621375204_1puow`) — marked `state='expired'` with `closure_reason='action_never_executed'` so the brief stops claiming "you approved the policy exception + I booked the BiWeekly at 17:00" when neither actually happened. The Bundle B/D fixes prevent recurrence.

### Migration

- `approvals` table gains a `request_id` column via idempotent ALTER on next startup. No data migration needed; new approvals start bridging immediately. Existing rows have `request_id=NULL` — they won't bridge retroactively, but they're already terminal or in-flight in the legacy table and will close via existing paths.

### Architectural note — Phase 1 of the v2.7.0 cutover-finish

The v2.7.0 spine design said "requests is THE work-item layer; legacy tables become internal state machines bridged via request_id." The cutover script wiped in-flight rows once at deploy, but the write paths were never migrated — every new coord / outreach / approval still landed in the legacy tables only, invisible to the brief. This patch is Phase 1: every write now bridges. Phase 2 (readers fully migrated to requests as source of truth) and Phase 3 (drop legacy tables entirely) deferred to a dedicated session — they're meaningful refactors that deserve focused attention, not a tired-tail-end add-on.

---

## 2.7.0 — The 1-2-3 rewrite trilogy: orphan kill, meeting decision engine, slot finder

First minor in three weeks. Three concurrent rewrites in one sitting — owner declared each "broken by design" and asked for full rewrites instead of more patches. Each followed the same playbook: walk the algo, surface dilemmas, get sign-off, build whole batch, paper-trace against the new code on disk. Net **+1590 / -1938 lines** despite three new architectural primitives — the consolidation work it took to get there was substantial.

### Added

- **Requests spine** (`src/db/requests.ts`, `src/core/requests/`). Every user-facing async work item — approvals, outreach, reminders, follow-ups, research, coord — is now one row in one table with a single closure API (`closeRequest`). Lifecycle timers live on the row itself (`next_check_at` + `next_check_handler`) — no separate dispatch table for one-shot expiries. The four-table mess (tasks/approvals/coord_jobs/outreach_jobs) collapses to one user-facing surface with the legacy tables as internal state machines bridged via `request_id` columns.
- **`cron_schedules`** table — recurring trigger config (replaces the old `routines` concept folded together with the cron-typed rows that used to live in `tasks`).
- **`planMeeting` pipeline** (`src/skills/meetings/planMeeting.ts`). Single decision function: every scheduling intent (new_booking / move / cancel / find) flows through it. Six plan actions: `book`, `find_slots`, `confirm_override`, `escalate_approval`, `decline_and_relay`, `refuse_not_owners`. All five tools (`find_available_slots`, `create_meeting`, `move_meeting`, `delete_meeting`, `coordinate_meeting`) route through it.
- **`scheduleRules.checkSlot`** (`src/utils/scheduleRules.ts`) — single rule engine. Working hours, floating-block movability, category limits, buffer, OOF, travel buffer, owner-busy collision — one source of truth for "is this slot OK?" Replaces the duplicate rule logic that was in `find_available_slots`, `create_meeting` Guard B, `move_meeting` rule check, and `coordinate_meeting` slot loop.
- **`resolveLocation`** (`src/utils/resolveLocation.ts`) — single location decision. Priority chain: owner explicit > category default > day-type defaults > fallback. Replaces the `determineSlotLocation` + `helperForcesOnline` + `skipLocationField` mess in `create_meeting`.
- **`findMeetingOwner`** (`src/skills/meetings/findMeetingOwner.ts`) — requests-table-first lookup with Graph organizer fallback. Enriches Graph-organizer's slack_id from `people_memory` so the asker-vs-organizer check works for the common case of meetings not booked through Maelle (weeklies the owner books himself, customer invites, Calendly).
- **`detectCategory`** (`src/skills/meetings/detectCategory.ts`) — single-event LLM classifier (per-booking version of the autoCategorize batch).
- **LLM-judged request dedup** (`src/utils/requestDedup.ts`). When a colleague raises an approval, the judge compares to open requests for that (owner, requester) within 48h and returns `match: existing | new`. Conservative — when in doubt, returns `new`. Closes the "Julia 5×, Yael 4×" duplicate-row pattern at the source.
- **TZ-derived attendee availability + initiator-aware annotation**. Slot finder pre-clips candidate windows to the intersection of each attendee's working hours (TZ-converted). Owner-initiated searches drop slots where any internal attendee is busy. Colleague-initiated searches keep busy slots and tag each with per-attendee status (free/busy/tentative/oof/unknown for externals) so Sonnet narrates honestly without proposing impossibilities.
- **SCHEDULING PREFERENCES prompt block** — renders `profile.schedule.timezone_preferences` + `night_shift` dynamically from yaml. All-Israeli → prefer morning; non-Israeli attendee → prefer 15:00-19:00. These are SOFT preferences via prompt guidance, NOT hard code rules — Sonnet adapts when no preferred-window slot exists and narrates the trade-off.

### Changed

- Brief generation reads from `requests` table. Surfaces open items daily + uninformed terminal closures once. `surfaced_count >= 3` on `awaiting_owner` requests → auto-park as `cancelled` with reason `surfaced_threshold` + `informed=0`, so the next brief narrates "I stopped working on X" then drops. Auto-park gated to `awaiting_owner` ONLY — reminders/scheduled outreach/research (state=`in_flight`) never auto-cancel before they fire.
- System prompt PENDING APPROVALS block reads from `requests` table (owner sees all `awaiting_owner`; colleague-path sees thread-scoped open requests). Slot preview reads `details.winning_slot` as fallback so coord-driven approvals render the slot.
- Emoji ✅ resolution matches `requests.terminal_dm_msg_ts` — only the original terminal-question DM stamps that field; midpoint reminder DMs deliberately do NOT, so ✅ on a reminder is a no-op.
- `closeLoopOnOwnerHandled` scanner reads open requests + calls `closeRequest`. LLM-only (keyword pre-filter retired per v2.6.5 owner direction).
- `find_available_slots` colleague-path now annotates each returned slot with per-attendee status (internal: getFreeBusy; external: always `unknown`). Owner-path retains busy-drop behavior.
- `pickSpreadSlots` tightened: ≤3 total, ≤2/day, ≥1h gap between any two, ≥2 unique days when returning 3. Returns 1-2 gracefully when the caller's frame yields fewer — never crashes, never widens silently.
- `move_meeting` routes through `planMeeting` so location + category re-resolve when a move flips day-type (office↔home). New `updateMeeting` params: `location`, `isOnline` — Graph PATCH updates them when planMeeting returns a different verdict for the new slot.
- `delete_meeting` ownership-aware via `findMeetingOwner`: owner-organizer → normal delete; asker == organizer → silent decline on owner's side (no auto-DM, they ARE the asker); asker ≠ organizer → decline + auto-DM organizer with polite template. Tool returns `relay_status: sent | skipped_no_slack_id | not_attempted` so Sonnet narrates honestly when the organizer is external and no Slack DM was sent.
- `move_meeting` ownership-aware: owner-attendee on move → `refuse_not_owners` (pure refusal, no auto-DM per owner direction — different from cancel).
- Floating-block rule (lunch / coffee / focus blocks): movability check. A new slot conflicts with a floating block ONLY when accommodating it leaves no contiguous free segment ≥ `block.duration_minutes` in the window. Pre-fix the rule treated the whole window as a wall; a 25-min meeting at 12:00 inside the 11:30-13:30 lunch window falsely failed even though lunch could shift.
- `idan.yaml` categories: added explicit `default_location` + `default_is_online` to `Physical` (office hybrid) and `Outside` (custom_required, no Teams). Schema already supported these; yaml just wasn't using them.

### Fixed

- **Orphan items in brief** (Julia 5×, Yael 4× pattern across 30+ versions). Root cause: brief read from `tasks`, but the tasks table had no autonomous path home from `pending_owner` — closure required one of 8 separate cascade paths to fire correctly, and most missed. Fix: single-table spine with single closure API; `surfaced_count`/`informed` semantics; tools route through requests not legacy.
- **Max meeting location empty** (the Topic 2 symptom). Root cause: `helperForcesOnline` + `skipLocationField` flags conspired to skip the office address even when the helper had it ready. Fix: `resolveLocation` returns a single verdict; `create_meeting` reads it; office address stamps for office-day externals.
- **Wrong "I can't touch this meeting" refusal** when owner IS the organizer (Yael screenshot bug). Root cause: prompt rule + tool guard both pre-refused without trying. Fix: `findMeetingOwner` reads requests table first, Graph organizer fallback; tool actually attempts the action and reports honest verdict.
- **Slot finder returning 1 afternoon option when many exist** (Yael interview bug). Root cause: `pickSpreadSlots` picked first-of-day chronologically → morning-biased on every day. Combined with the soft-preference for non-IL attendees living only in prompt (Sonnet ignored), only Wed 16:15 survived a post-hoc "after 15:00" filter. Fix: spread rules tightened + preferences rendered as prompt guidance + Sonnet uses judgment to narrow `search_from` per attendee mix.
- **Duplicate orchestrator turn after cutover restart**. Root cause: `processedDedup` TTL was 60s; Slack socket mode retries queued events for several minutes after reconnect → second delivery bypassed the dedup window. Fix: TTL bumped to 10 minutes (covers realistic socket-reconnect retry windows; ts collisions essentially impossible at Slack's microsecond ts precision).
- **Catch-up icon missing**. `↩` unicode arrow without variation selector renders as text-style in Slack desktop. Added U+FE0F variation selector → renders as proper emoji.

### Removed

- `src/core/approvals/orphanBackfill.ts` + `src/core/approvals/outreachOrphanBackfill.ts` — the startup orphan-sweeper scripts were the textbook tell of a leaky write path. New spine is correct by construction; if it leaks we fix the leak, not patch with a sweeper.
- `determineSlotLocation` helper (`coord/utils.ts`). Replaced by `resolveLocation`.
- `helperForcesOnline` / `skipLocationField` block in `create_meeting`. Replaced by `planMeeting` verdict.
- Prompt rule about organizer pre-refusal (`meetings.ts` ~2014). Replaced with "always try the tool; planMeeting returns the right action."
- `markTaskInformed` / `getCompletedUninformedTasks` / `completed→informed` two-step in tasks. Replaced by `surfaced_count` + `informed` on requests.

### Migration

- **One-shot cutover script** (`scripts/cutover-to-requests.cjs`) — wipes in-flight rows from `tasks`/`approvals`/`coord_jobs`/`outreach_jobs` so the new spine starts clean. Per owner direction (no migration code; hard cutover). Owner ran on 2026-05-12 before restart.
- Schema: new `requests` + `cron_schedules` tables. Legacy tables retained as internal state machines + bridge columns (`request_id`) added to `outreach_jobs` and `coord_jobs`. ALTERs idempotent.

### Invariants preserved

- Maelle-is-a-human filter: every user-facing message still passes through securityGate + humanGate; no bot framings, no "I'm an AI" leaks.
- Shadow DM remains a passive log, never a notification or approval channel.
- No personal info in code: all owner names / company / domains / hours read from `profile.*`.
- Four-layer model: skills don't import from connectors/slack/*; requests spine lives in core/.
- Owner is gatekeeper of version bumps: this 2.7.0 wrap was explicitly owner-triggered ("go to 2.7. let's wrap up").

### Stress-tested (paper-trace)

10 adversarial scenarios traced against the new code on disk before this wrap — auto-park, reminder survival, dedup, emoji discipline, slot_pick fallback, Max location, home-day external, Yael cancels her own (Maelle-booked + legacy/Calendly), owner cancels someone else's, move office→home. 8/10 ✅, 2 surfaced gaps fixed in the same session (move-flow planMeeting routing + external-organizer relay_status honesty + asker-email lookup for legacy meetings).

---

## Earlier versions (1.0 → 2.6.10) — condensed

Detailed entries collapsed to headlines. Full history available in git log.

### 2.6.x — coordination polish, social engine v2, channel reach

- **2.6.10** — Doc wrap: SESSION_STARTER bundle-signals rule made loud after 4 patches shipped on build-only words.
- **2.6.9** — Channels block declares per-transport reach criteria; can't-reach rule added (closes Maya/Yael "promised to reach external with no transport" bug).
- **2.6.8** — Brief approval-hydration finally works (column-name mismatch since v2.6.4); coda piggyback disabled.
- **2.6.7** — Social Engine redesign: subjects + topic-beats, semantic merge classifier, engagement signal.
- **2.6.6** — Yael/Idan Wagner duplicate approval + Shayan MPIM 5-bug bundle.
- **2.6.5** — Coord fast-path generalized for externals-with-internals; humanGate extended to colleague-path; claim-checker move_meeting fix.
- **2.6.4** — Skills/tools organization pass.
- **2.6.2** — Channel thread-continuation; persona → social rename; emoji feedback loop (approvals via reactions).
- **2.6.1** — Multi-bug session: shadow DM both directions, exact-slot rule check + broken_rule_label, MPIM @-mention silence fix, recent-outbound context for colleague DMs.
- **2.6.0** — Category scheduling rules end-to-end + Calendly/MPIM correctness wave + brief auto-categorize + all-day events + duplicate-create idempotency.

### 2.5.x — category rules, externals first-class, queue + cache

- **2.5.5** — Category-rule narration polish; auto-categorize sees recurrence + attendee-count; dead `interviews:` block removed.
- **2.5.4** — Calendly bug fixes (organizer trust, MPIM colleague-context override, MPIM private-ask via approval); category-driven travel buffer.
- **2.5.3** — Category scheduling rules introduced (per_day / per_week limits, day_type, default_location).
- **2.5.2** — Self-write reopening on colleague path, travel-aware slot search, day-aware location for direct create_meeting.
- **2.5.1** — Move-validation prompt rule, hybrid-meeting location passthrough, small-bug pass.
- **2.5.0** — Per-thread orchestrator queue, externals-first-class booking (email REQUIRED on participants), calendar memoization via AsyncLocalStorage, owner-said-done scanner.

### 2.4.x — floating blocks unified, preferences catalog, prompt-bloat surgery

- **2.4.1** — Floating-block model cleanup; owner-override-as-approval extended; move-aware slot finder.
- **2.4.0** — Preferences catalog (mirror of people-md pattern); prompt-bloat surgery (owner-DM prompt 30k → 21k tokens); observation-tool silence.

### 2.3.x — coord state machine + scheduling honesty

- **2.3.8** — 8-bug GitHub run: routine self-healing, owner-side attendee busy filter, overlap detector hygiene.
- **2.3.7** — Lunch generalized to floating-block primitive; late-night day boundary; positional booking.
- **2.3.6** — 13-bug daily wave: slot-finder reliability + concision + venue research + Slack TZ + outreach memory.
- **2.3.5** — Coord-judge bleed-through fix + third-party scheduler + cloneability cleanup.
- **2.3.4** — Source-of-truth fixes: interaction-log filter + free/busy TZ chokepoint + claim-checker retry honesty.
- **2.3.3** — Owner-override-as-approval cluster + scheduling honesty + coda safety + office address.
- **2.3.2** — Brief redesign + internal-coord fast-path + colleague-path booking + shadow threading.
- **2.3.1** — 23-bug interactive sweep (coord state machine + floating-block determinism + OOF + proactive social).
- **2.3.0** — Connection attachments + Graph TZ honesty + travel-aware coord + first auto-triage end-to-end.

### 2.2.x — action tape, social engine v1, post-mutation verification

- **2.2.6** — action tape + post-mutation verification (close the "she booked it then forgot" loop).
- Earlier 2.2 — social engine v1 (30 fixed categories per owner), proactive colleague outreach hourly tick.

### 2.1.x — autonomy layer, active calendar-health, shadow DMs

- Autonomy layer: `behavior.calendar_health_mode: passive | active`, deterministic protection rules, shadow DMs via `v1_shadow_mode`.

### 2.0.0 — Connection interface milestone (issue #1 closed)

Single biggest architectural change. Skills stopped importing from `connectors/slack/*` or calling `app.client.*` directly. New `Connection` interface (sendDirect / postToChannel / etc.); `SlackConnection` first implementation; coord state machine moved to `src/skills/meetings/coord/`. Email + WhatsApp become additive: implement `Connection`, register at startup, zero skill changes. `_meetingsOps.ts` relocated to `src/skills/meetings/ops.ts`. Shared `utils/workHours.ts` extracted. `connectors/slack/processedDedup.ts` fixes duplicate-reply bug after reconnect.

### Pre-2.0 — foundational waves (v1.0 → v1.8.14)

The 1.x line built the foundation: orchestrator + tool loop (1.0), skills layer + togglable YAML toggles (1.5), approvals as first-class structured decisions (1.5+), tasks unified pipeline (1.6), claim-checker + honesty gates (1.7), date verifier + deterministic correction (1.7), knowledge base + summary skill (1.7.4-1.7.7), people-memory markdown files (1.8.1+), PM2 + auto-triage GitHub Action (1.8.2-1.8.4), Connection layer scaffolding (1.8.10-1.8.14). Full prose entries in commit history if anyone needs to dig.

---
