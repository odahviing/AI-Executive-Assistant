## Maelle session context

We are working on the Maelle project at E:/Code/Maelle.
Current version: check package.json — it is the source of truth.

Read these two memory files before doing anything:
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_overview.md
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_architecture.md

Plus these feedback memories (cross-session rules the owner has set):
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/feedback_bundle_signals.md
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/feedback_ticket_titles.md
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/feedback_version_workflow.md
- C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/feedback_versioning.md

When the owner says "wrap up" / "close the patch" / "cut a version" / "day close" → follow `.claude/WRAP_UP.md` step-by-step.

When the owner says "test scenario N" / "run scenario N" / "simulate scenario N" (or similar) → open `.claude/test-scenarios.md`, read that scenario in full, then code-trace it against the current files on disk (do not trust memory) and produce a report: what works, what doesn't, what shouldn't happen, plus concrete fix suggestions. **This is a paper exercise — never execute the scenario for real. No live DMs, no real calendar writes, no DB writes, no tool calls against the running system.** The only allowed side effect is reading source files. No auto-fixing — owner decides fix-now vs file-a-ticket.

When the owner says "go over the issues" / "github bugs" / "let's do a github run" / "fix bugs from github" (or similar) → run a **GitHub bug pass**:

1. `gh issue list --state open --label Bug --json number,title,labels,createdAt,body` — Bug-labeled only. Feature requests (Roadmap / Next / Idea) are out of scope for a bug run.
2. For EACH issue, identify ATOMIC bugs — a single issue often contains multiple sub-bugs. Number them (e.g. `77a`, `77b`, `77c`). Carry severity from the issue label (High / Medium / Low) on each atomic bug so the owner can see it; do NOT group by severity.
3. Code-trace each atomic bug against current files on disk — don't trust memory.
4. **Reappearance check** is mandatory, not optional. Many atomic bugs are returns of previously-"solved" issues. For each one: search git log + memory + the existing code for prior fixes addressing the same pattern. If found, identify (a) what the prior fix tried, (b) why it didn't stick, (c) what code or prompt rule needs to be REMOVED or REPLACED — never stack a new layer on a rotting prior layer (that's how RULE 2e v2.1.0 → v2.1.3 → v2.2.6 happened).
5. Group atomic bugs into BUNDLES by **code area / file / shared mechanism** — never by severity. The bundle exists so multiple atomic bugs touching the same place collapse into one fix run; that makes the work fast and the resulting commit coherent. One sentence per bundle saying what the shared subject is.
6. Per atomic bug: short summary of what happened, root cause (file:line), severity, reappearance note + prior fix reference, proposed fix shape (code vs prompt, what gets removed or extended). No extra format beyond that.
7. Order of bundles: doesn't matter — owner fixes area after area, and all bundles land in the SAME final commit + version bump at the END of the run. Don't bump per-bundle.

**Anti-patterns**:
- Auto-fixing during a bug run. Propose only.
- Stacking a new fix on top of a rotten prior fix without removing the prior one.
- Grouping bundles by severity instead of code area.
- Skipping the reappearance check on bugs that look new — many aren't.
- Bumping version per bundle. One bump at the end of the whole run.

**Closing the run**: when every atomic bug has a resolution (fixed in tree, filed as a new issue, or explicitly deferred/not-fixed), print a summary table BEFORE asking about wrap-up. One row per atomic bug. Columns: `# | GitHub | Severity | Status | Summary`. Status values: `fixed` (in tree, awaiting wrap-up commit) / `filed #N` (opened a new issue) / `deferred` (owner skipped) / `not fixed` (explicit owner direction). The "Summary" column is one-to-two liners — owner reads this to remember what shipped before approving the wrap-up. After the table, wait for the owner's "wrap up" / "ship it" / "bump the version" — never wrap unilaterally.

**Scenario report format (4 columns):** `# | What the scenario expects | What the code does today | Status` (✅ Works / ⚠️ Partial / ❌ Not working / 🚫 Shouldn't happen). One row per discrete checkpoint; each row self-contained with file:line citations so a reader doesn't need to re-read the scenario. After the table, a short **Fix suggestions** section covering ONLY the ❌ and ⚠️ rows. Skip the ✅ ones.

All 10 scenarios were paper-run against v2.2.3 (sessions through 2026-04-26). Surfaced gaps either fixed inline or filed (#43 + descendants, #51, #52, #53). When re-running scenarios, treat any ❌/⚠️ row identically to the first run — owner may have changed the underlying spec since (scenarios 1 + 2 were reframed mid-session). Always re-read the scenario text fresh, never trust prior reports.

**Edits to scenarios are owner-driven.** If a beat in a scenario reads as "wrong" to you, propose a rewrite — don't just rate it ❌. The owner has reframed scenarios mid-session multiple times when my analysis surfaced that the original scenario expectation didn't match his actual workflow.

---

## Where we are — v2.5.0 just shipped

**Operational state (v2.5.0):**
- **Auto-triage + auto-build are OFF.** Both workflows in tree but gated `if: false &&`. Owner files GitHub issues / shows screenshots; we fix interactively. **GitHub remains the bug data source** — keep using `gh issue list/view`.
- **PM2 + deploy watcher are OFF.** Owner runs `npm run dev` directly; restart needed to pick up changes.
- **Per-thread inbound queue is LIVE (v2.5.0 A1).** Rapid-fire messages from the same thread no longer spawn parallel orchestrator turns — they collapse via 1.5-sec debounce + per-thread mutex + abort-if-safe (abort the in-flight turn for merge ONLY when no write tool has fired yet; once a write fires, can't abort, buffer for next turn). The `WRITE_TOOLS` set in `src/connectors/slack/inboundQueue.ts` defines what counts as a write. Sonnet's tool dispatch loop calls `onWriteExecuted` BEFORE dispatching any write tool. Background callers (dispatchers, brief generation) bypass the queue and run as before.
- **Per-turn calendar memoization is LIVE (v2.5.0 A3).** `withTurnCache` wraps every orchestrator turn via AsyncLocalStorage. `getCalendarEvents` opts in via `memoize(key, fetch)`. Same-turn duplicate reads return the same promise; different turns get fresh caches. To extend memoization to other expensive reads later, just route them through `memoize()`.
- **`coordinate_meeting.participants` schema changed (v2.5.0 C1):** `email` is REQUIRED, `slack_id` is OPTIONAL. Externals (no slack_id) auto-demote to `just_invite` at the handler level. Email is the booking primitive; Slack is bonus DM enrichment for internals only. Sonnet's mental model: book with email, never block on missing Slack.

**Default workflow when owner files / shows a bug:**
1. **Understand.** Read the issue body + screenshot. Code-trace against current files on disk. Don't guess.
2. **Propose.** Write up: what's broken, where (file:line), and the proposed fix. Code vs prompt — prefer code for determinism, prompt for judgment (per CLAUDE.md).
3. **Discuss.** Wait for owner to revise / push back / approve. He often re-frames or rejects the agent's first read — that iteration IS the value.
4. **Build.** Only after explicit approval. Typecheck. Stop.
Never auto-fix. Never bundle multiple fixes without owner saying so.

**Default version bump: PATCH** unless owner explicitly says minor. He has corrected this multiple times.

**v2.5.0 wave** (most recent — large-scope minor): triggered by a 2026-05-03 trace of one Yael→Maelle Welcome-Meeting booking that took 13+ tool calls when ~3 should have done it, plus a follow-up Idan↔Maelle conversation with 5 sequential calendar reads to compute one overlap. Two architectural fixes anchor: (a) **per-thread inbound queue** — debounce 1.5s + mutex + abort-if-safe, collapses rapid messages into one merged turn, eliminates parallel orchestrator runs; (b) **per-turn calendar memoization** via AsyncLocalStorage — same-turn duplicate `getCalendarEvents` calls share one fetch. One schema change makes externals first-class: `participants.email` required, `slack_id` optional; handler auto-demotes externals to `just_invite`. One new behavioral pattern: **owner-said-done scanner** runs fire-and-forget after every owner turn, deterministic version of RULE 2d that auto-cancels tasks/coords/outreach when owner says "done/drop/handled" in chat. Plus 8 prompt rules + code paths folding the conversational-context bugs at their roots: joint-attendee one-call, user-named-days narrow search, MOVE-discovery via `moving_event_ids` from context, date-context bias to recently-discussed meeting, lead-with-the-gap, B3 deterministic coord-reply day-fast-path, location scrub + body enrichment, persona prompt one-sentence rewrite. Plus the v2.4.2 backlog: closeMeetingArtifacts cascade for calendar_dismissed_issues + the silent payload_json column mismatch (broken since v2.1.6) + find_available_slots local-zoned ISO + owner-direct 3-spread filter + brief recent_context per item + ACTION ITEMS prompt tightened + resolveSlackId centralized across 5 tools + floating-block rebalance branch logging. Two one-shot DB cleanup scripts shipped alongside.

**v2.4.1 wave** (prior): floating-block model cleanup (schedule.lunch removed, floating_blocks moved from `schedule.` to `meetings.`); owner-override-as-approval extended to floating-block bookings + moves via `confirm_outside_window`; move-aware slot finder via `find_available_slots.moving_event_ids`; LANGUAGE rule extended to ignore tool-result languages; persona prompt one-sentence rewrite (observation tools never replace text reply).

**v2.4.0 wave** (prior — first minor in months): preferences catalog (mirror v2.2.1 people-md pattern), prompt-bloat surgery (owner-DM 30,468 → 21,481 tokens / −29.5%), Fix A for #78 (observation tools skip verbMap fallback when only tools fired), data migration scripts (19 reflectiz/ICP rows → KB md, 48 person rows → 19 per-person md files).

**v2.3.6 wave** (most recent — 13 bugs from a single morning, full triage + fix in one session): cleared issues #69-#73. Five clusters by code area. (a) **Slot-finder reliability** — shared `loadAttendeeAvailabilityForEmails` helper at `src/utils/attendeeAvailability.ts`, wired into BOTH `find_available_slots` (already had it via v2.3.3) AND `coordinate_meeting` (missing — that's why Brett got proposed 4:30 AM ET). New diagnostic logging `findAvailableSlots — rejection breakdown` per-rule counts + 5 example rejected slots per reason — grep `rejection breakdown` in `maelle-YYYY-MM-DD.log` to debug "why was 17:45 not proposed?". New prompt rule: when owner-picked time rejected, RE-CALL with `relaxed: true` to surface broken rule, narrate honestly, get owner confirm; explicit ban on `create_meeting` direct bypass. (b) **Conversational concision** — `inferDefaultMeetingMode` helper reads attendee TZ vs owner TZ, defaults 'online' when remote (no ask). `resolveVenueLocation(input, targetLanguage, opts?)` helper (Tavily + Sonnet, no cache by design) wired into `create_meeting` for non-ASCII venue names — `קפה לנדוור` becomes `Cafe Landwer, [street], Nes Tziona` for English invites. New CONCISION prompt rule: bundle missing fields into ONE ask, not ping-pong. (c) **Slack TZ honesty** — `recall_interactions` parses UTC `created_at` and re-zones to `profile.user.timezone` before returning. Closes Sonnet narrating "Oran's latest message today (08:03)" when actual was 11:03 IL. (d) **Cross-turn outreach memory** — ACTIVE IN THIS THREAD block now surfaces `outreach_jobs.reply_text` ("Outreach to Oran — replied: '...'"). Reply was always captured by inbound pipeline; prompt-rendering just didn't show it. Single-line fix in orchestrator. NOT a memory-architecture rewrite. (e) **Style-saving gate verified clean** — `learn_summary_style`, `update_summary_draft`, etc. all OUTSIDE `COLLEAGUE_ALLOWED_TOOLS`; filter strips them from colleague-path tool list. No leak. Filed [#68](https://github.com/odahviing/AI-Executive-Assistant/issues/68) earlier in the day for explicit 5-min buffer flag (Low Bug, future work).

**v2.3.5 wave** (prior): coord-judge bleed-through fix + third-party scheduler + cloneability cleanup. Triggered by an Oran "TEST for XXX" incident — coord judge correctly flagged SUSPICIOUS and blocked `coordinate_meeting`, but Sonnet pivoted to `create_approval` (no equivalent gate) and the flagged ask still landed in the owner's DM with a reminder. (a) New conversation-scoped suspicion cache in `src/utils/coordGuard.ts` (`markConversationSuspicious` / `wasConversationFlaggedSuspicious`, 10-min TTL keyed on `senderId+threadTs`). Stamped at `orchestrator/index.ts:818`, checked at `orchestrator/index.ts:677` before colleague-path `create_approval` — hit → refuse + shadow-DM owner. Future tool gates needing the same protection just add the same guard. (b) `coordinate_meeting.requester_is_attending: bool` (default true) — when false (HR/EA-style coordinator booking an interview between owner + candidate), the handler at `meetings.ts:660` drops the requester from `participants` AND `just_invite` so their availability is not factored in. New THIRD-PARTY SCHEDULER prompt rule at `meetings.ts:1700` with cue list and ASK ONCE when ambiguous. (c) Cloneability sweep — colleague-facing strings, find_available_slots schema enum, all hardcoded "Maelle"/"Reflectiz" literals replaced with `profile.*` reads. Floating-block matcher generalized (`schedule.lunch.match_subject_regex` optional yaml field, default regex `\\b{name}\\b`). Reflectiz scrubbed from comments (public repo). Filed [#68](https://github.com/odahviing/AI-Executive-Assistant/issues/68) for explicit 5-min buffer flag (Low Bug).

**v2.3.4 wave** (prior — one evening, four bugs): source-of-truth fixes. Common theme: stale snapshots overriding current state. (a) Interaction-log filter — `formatPeopleMemoryForPrompt` and `buildSocialContextBlock` drop `meeting_booked` + `coordination` types from the rendered Recent Activity block. DB log untouched. Calendar = source of truth for meetings; memory = relational facts. Closes the "Lori onboarding session isn't showing on tomorrow's calendar" pattern where 3 stacked `meeting_booked` snapshots (April originals + May reschedule) had Sonnet narrating the older April entry as fact. (b) `parseGraphFreeBusySlot(item, requestedTz)` chokepoint — single helper for parsing every Graph `getSchedule` scheduleItem. Graph returns dateTimes as UTC-zoneless regardless of the request `timeZone`; helper parses as UTC, re-zones, emits ISO with explicit offset. `FreeBusySlot._timezone` carries the zone; the convention lives in the data, not in reader knowledge. Three downstream consumers cleaned up to drop the now-misleading `{ zone: 'utc' }` parse hint. Closes the recurring "Simon busy 13–15" misread when his actual blocks were 16–18 in his TZ. (c) Claim-checker `book`-type guard covers all calendar mutations — extended `matchingToolAlreadyRan` regex from `create_meeting|finalize_coord_meeting` to also include `move_meeting|update_meeting|delete_meeting|book_lunch`. Closes the FNX bug where a successful `move_meeting` + correct confirmation tripped a false-positive verdict, the retry fired, and the retry — which doesn't see THIS turn's tool calls in `conversationHistory` — re-read the calendar and wrote *"FNX is already at 14:00, looks like it was moved at some point during our conversation."* Defense-in-depth: corrective nudge now appends `"For context, in THIS SAME TURN you already executed: [tool summaries]. Don't re-run those — and don't narrate their effects as if someone else did them."` (d) `delete_meeting` seriesMaster guard — `getEventType` preflight mirroring the v1.8.8 update_meeting/move_meeting guards. Defense-in-depth — `get_calendar` returns occurrence ids via Graph `calendarView`, so a master id should never reach here through normal flow. No schema migrations.

**v2.3.3 wave** (prior — owner-override-as-approval cluster): owner-override-as-approval pattern across 5 surfaces, scheduling honesty, coda safety. The unifying principle that finally clicked: when owner asks for X and X has a soft-rule cost, FLAG the cost, don't reframe to "find different". Built: (a) `find_available_slots.relaxed: bool` (owner-only) bypasses focus / lunch / work-hours; KEEPS the 5-min between-meeting buffer (sacred). (b) `move_meeting` floating-block branch — owner-explicit hint in-window uses target as-is, no conflict refusal; out-of-window still refuses (lunch_bump territory). (c) `find_available_slots` auto-loads `attendeeAvailability` from people_memory (Brett in Boston no longer gets proposed 10:15 IL). (d) `coordinate_meeting` enriches missing emails for internals via Slack `users.info` through the existing `Connection.collectCoreInfo`. (e) `claimChecker` gains `mode: 'coda'` — validates against people_memory snapshot, drops invented facts ("kind of wild that she shares my name") and gossipy commentary about third parties. (f) Codas now log as Maelle initiations + schedule a `social_ping_rank_check` 48h out with `kind: 'coda'`; ignored codas drift colleagues toward rank 0. (g) `profile.meetings.office_location: { label, address, parking }` yaml field; `determineSlotLocation` + `create_meeting` body fill it in for physical meetings. (h) Several short prompt rules: owner-explicit time → ask "keep it?"; floating blocks Maelle's call vs colleague meetings owner's call (don't bundle); verify the goal before suggesting collateral moves; external online/in-person ASK with smart skip on remote signals. (i) textScrubber em-dash extended to `[-—]`; create_meeting body now scrubbed before Graph.

**v2.3.2 wave** (just before): brief redesign — events table no longer feeds the brief, tasks-spine + tasks.informed is the only dedup; brief leads with TODAY'S CALENDAR via `processCalendarEvents`. Deterministic brief routing (`core/briefIntent.ts` short-circuits owner-DM brief asks). Internal-coord fast-path in `coordinate_meeting` (`isAllInternalParticipants` + `annotateSlotsWithAttendeeStatus` → `action: 'present_slots_to_requester'`). `create_meeting` added to `COLLEAGUE_ALLOWED_TOOLS` with v2.2.1 trust-pattern guards + post-booking heads-up DMs to internal attendees. Shadow-DM threading per `conversationKey` (one owner-DM thread per Slack conversation; coord shadows keyed on `coord:${job.id}`).

**v2.3.1 wave**: 23 atomic bugs fixed across one long working session. 7 GitHub issues (#61-#67) closed. Coord state machine cluster, `move_meeting` deterministic floating-block alignment (closes the recurring "Sonnet does time math wrong" pattern), OOF detection trusts `showAs` only, `busy_day` issue type removed, TZ display fixes (parseGraphDateTime setZone + Prefer header on nextLink), proactive tick fixes, CHANNELS-you-can-reach block in system prompt, concision pass extended for self-contradiction, Oran error humanized.

**Earlier (still relevant):** action tape pinned to owner system prompt (v2.2.6); post-mutation verification for create + move (v2.2.6); travel-aware coord (v2.3.0); file attachments on `message_colleague` via Connection.SendOptions.attachments (v2.3.0); `normalizeForGraph` strips Z/offset before Graph mutations (v2.3.0). The autonomy layer (`behavior.calendar_health_mode: passive | active`, deterministic protection rules, shadow DMs via `v1_shadow_mode`) ships from v2.1.1; the Connection interface (four-layer model) from v2.0.0. Social Engine (30 fixed categories, per-person topics, three initiation paths) ships from v2.2.0.

v2.2.0 is the **Social Engine** — first real minor bump in the 2.x line. Two parallel subsystems that together make Maelle read as a person, not a service desk:

**Owner↔Maelle Social Engine** — 30 fixed categories seeded per owner (family/kids/gaming/tech/travel/etc). Pre-pass Sonnet classifier on every owner turn tags task|social|other. Task always wins; social turns produce a deterministic directive (celebrate|engage|revive_ack|continue|raise_new|none) injected into the prompt. Topics live in `social_topics_v2` with engagement_score 0-10, status active|dormant. Round-robin continuation prefers topics Maelle hasn't touched in 3+ days. Weekly decay drops -1 from untouched actives; score 0 → dormant (retained, owner can revive). Post-turn logger writes to `social_engagements` audit trail. Fixes the "One Axos down! → 'what do you need from me?'" bug class.

**Maelle→Colleague proactive outreach** — hourly system tick, owner-time-agnostic. Each hour sweeps known colleagues, picks one whose LOCAL time is in 13:00-15:00 work-day window, engagement_rank>0, 5-day cooldown not hit, prior interaction history. Sonnet generates a short warm ping; rank-check 48h later auto-adjusts `engagement_rank` 0-3 based on reply. Rank 0 = opt-out (never initiate). Owner override via `update_person_profile` tool ("never ping Ysrael" → rank 0). Gated on `behavior.proactive_colleague_social.enabled` (default off, opt-in per profile).

**Stress-test simulator** at `scripts/stress-test-social.mjs` — 3 scenarios (silent/chatty/dead topic). Sweet spot: 3-5 active topics per person natural equilibrium. Dead topics hit dormant in ~3 days.

Filed [#43](https://github.com/odahviing/AI-Executive-Assistant/issues/43) (timezone learning, Medium) — proactive outreach gates strictly on colleague timezone.

**Capabilities to remember (each was a previous wave; live and used):**
- **Per-thread inbound queue** (v2.5.0 A1) — `src/connectors/slack/inboundQueue.ts`. Debounce 1.5s + mutex + abort-if-safe (abort the in-flight turn for merge ONLY when no write tool has fired yet; once a write fires, can't abort, buffer for next turn). `WRITE_TOOLS` set defines abort-blocker tools. `OrchestratorInput` gains `signal?: AbortSignal` + `onWriteExecuted?` callback. Background callers (dispatchers, brief generation) bypass the queue and run as before.
- **Per-turn cache via AsyncLocalStorage** (v2.5.0 A3) — `src/utils/turnCache.ts`. `withTurnCache(fn)` wraps every orchestrator turn; `memoize(key, fetch)` opts into shared promise per (key, turn). Currently used by `getCalendarEvents`. Extend to other expensive reads as needed.
- **`resolveSlackId` helper** (v2.5.0) — `src/utils/resolveSlackId.ts`. Format check (`/^[UW][A-Z0-9]{6,}$/`) + people_memory fallback by name. Applied at message_colleague, update_person_profile, note_about_person, confirm_gender, log_interaction, create_approval. Silently recovers from Sonnet's slug hallucinations OR returns clean error.
- **Owner-said-done scanner** (v2.5.0) — `src/utils/closeLoopOnOwnerHandled.ts`. Fire-and-forget post-owner-turn pass. Cheap keyword pre-filter (EN+HE closure verbs) → if signals present + open items exist → single Sonnet pass classifies which items the owner said are done → cascades cancel_task / cancel_coordination / outreach.done. Deterministic version of RULE 2d.
- **`coordinate_meeting.participants` schema** (v2.5.0 C1) — `email` REQUIRED, `slack_id` OPTIONAL. Externals (no slack_id) auto-demote at the handler level into `just_invite`. Email is the booking primitive; Slack is bonus DM enrichment for internals only.
- **`closeMeetingArtifacts` cascade** (v2.1.6 + extended v2.4.2 + v2.5.0) — covers approvals, outreach_jobs, tasks (was broken since v2.1.6 due to `payload_json` vs `context` column mismatch — fixed v2.5.0), AND `calendar_dismissed_issues` (added v2.5.0). Single chokepoint after every meeting mutation.
- **B3 deterministic coord-reply day-fast-path** (v2.5.0) — `interpretReplyWithAI` checks day-of-week + optional time match against proposed slots BEFORE the LLM call. EN + HE day tokens. When exactly one slot matches → accept deterministically; saves an LLM call.
- **`loadAttendeeAvailabilityForEmails(emails, ownerEmail)`** (v2.3.6) — shared helper at `src/utils/attendeeAvailability.ts`. Loads timezone + workdays + work-hours from people_memory. Used by BOTH `find_available_slots` and `coordinate_meeting`. WORK-HOUR clip only — busy/free is separate (`attendeeBusyEmails` + `annotateSlotsWithAttendeeStatus`).
- **`inferDefaultMeetingMode(attendees, profile)`** (v2.3.6) — code-level smart-skip for online/in-person ask. Returns 'online' when any attendee TZ != owner TZ. Persistence side: v2.2.2 #46 `update_person_profile.state/timezone`.
- **`resolveVenueLocation(input, targetLanguage, opts?)`** (v2.3.6) — Tavily + Sonnet venue resolver at `src/utils/locationResolver.ts`. No cache. Wired into `create_meeting` handler for non-ASCII venue names.
- **`findAvailableSlots — rejection breakdown` log** (v2.3.6) — diagnostic log emitted at end of every slot search with per-rule counts + 5 example rejected slots per reason. Grep this when "why was X not proposed?" comes up.
- **Outreach reply_text in ACTIVE block** (v2.3.6) — `orchestrator/index.ts:402-422` now renders colleague replies into the per-turn prompt. If `outreach_jobs.reply_text` is populated, the line reads "replied: <preview>" instead of "sent, waiting".
- **`recall_interactions` returns owner-local time** (v2.3.6) — `created_at` (UTC in DB) is re-zoned to `profile.user.timezone` before returning to Sonnet. Same chokepoint pattern as v2.3.4 `parseGraphFreeBusySlot`.
- **Conversation-scoped suspicion cache** (v2.3.5) — `markConversationSuspicious` / `wasConversationFlaggedSuspicious` in `src/utils/coordGuard.ts` (10-min TTL, keyed on `senderId+threadTs`). When the LLM judge returns SUSPICIOUS on `coordinate_meeting`, the conversation is stamped; downstream colleague-path mutation tools (today: `create_approval`) check before running and refuse on hit. Add the same guard to any future colleague-path mutation tool that could be a pivot target.
- **`coordinate_meeting.requester_is_attending: bool`** (v2.3.5) — false when the colleague is the scheduler, not an attendee (HR booking interviews between owner + candidate). Handler at `meetings.ts:660` drops the requester from participants + just_invite. THIRD-PARTY SCHEDULER prompt rule at `meetings.ts:1700` teaches Sonnet when to flip the flag.
- **`parseGraphFreeBusySlot(item, requestedTz)` chokepoint** (v2.3.4) — single helper for parsing every Graph `getSchedule` scheduleItem. Re-zones from Graph's UTC-zoneless format to the requested zone, emits ISO with explicit offset. `FreeBusySlot._timezone` carries the zone with the data. Use it whenever adding new free/busy parsing — the `{ zone: 'utc' }` pattern is now obsolete because the offset is in the string.
- **Interaction-log calendar-state filter** (v2.3.4) — `formatPeopleMemoryForPrompt` and `buildSocialContextBlock` drop `meeting_booked` and `coordination` types from the rendered Recent Activity. The DB still records them (jobs.ts append paths unchanged). Calendar = source of truth for meetings; memory = relational facts only.
- **`delete_meeting` seriesMaster guard** (v2.3.4) — `getEventType` preflight matches the v1.8.8 `update_meeting` / `move_meeting` pattern. Refuses with `error: 'recurring_series_master'` if the id resolves to a master.
- **Claim-checker `book` covers all calendar mutations** (v2.3.4) — `matchingToolAlreadyRan` regex extended to also recognize `move_meeting|update_meeting|delete_meeting|book_lunch`. Closes the FNX self-blindness pattern. Retry nudge now carries this-turn's `result.toolSummaries` so even legitimate retries see what already happened.
- **Owner-override pattern** (v2.3.3) — when owner-explicit input conflicts with a soft rule, narrate the cost and proceed. Wired in: `find_available_slots.relaxed: true` (bypass focus / lunch / work-hours, KEEP buffer); `move_meeting` floating-block in-window hint respected as-is; meetings prompt rules.
- **Coda safety** (v2.3.3) — `claimChecker(mode: 'coda')` validates social codas against people_memory before they're appended. Drops invented facts + gossipy commentary on third parties. Failed validation → coda dropped silently, no log, no rank-check.
- **Coda engagement tracking** (v2.3.3) — every coda calls `recordSocialMoment` + schedules `social_ping_rank_check` 48h out. Dispatcher's `kind: 'coda'` branch checks `last_social_at > coda_at_iso`; not engaged → -1 with reason `no_social_response_to_coda`. Ignored colleagues drift to rank 0 (opt-out).
- **Office address** (v2.3.3) — `profile.meetings.office_location: { label, address, parking }` yaml; `determineSlotLocation` + `create_meeting` body fill it in for physical meetings. Externals on the invite see the actual address.
- **Auto-loaded attendee availability** (v2.3.3) — `find_available_slots` reads each attendee's TZ + working hours from people_memory automatically; Sonnet doesn't have to pass `attendeeAvailability`. Opt-out via `ignore_attendee_availability: true`.
- **Email enrichment** (v2.3.3) — `coordinate_meeting` enriches missing emails for internals via people_memory → Slack `users.info` (`Connection.collectCoreInfo`). Externals stay missing-email and downgrade out of the v2.3.2 fast-path correctly.
- **Internal-coord fast-path** (v2.3.2) — `isAllInternalParticipants` gate → annotated slots returned to requester via `action: 'present_slots_to_requester'`. No DMs to attendees. Sonnet presents, requester picks, calls create_meeting.
- **Colleague-path `create_meeting`** (v2.3.2) — added to `COLLEAGUE_ALLOWED_TOOLS` with rule-compliance gate; post-booking heads-up DMs to internal attendees.
- **Shadow-DM threading** (v2.3.2) — `shadowNotify(conversationKey, conversationHeader)`. Process-wide cache. Inbound-colleague keyed on threadTs; coord-side keyed on `coord:${job.id}`. Security shadows + DM-failed stay top-level.
- **Brief redesign** (v2.3.2) — events table removed from brief; tasks-spine + tasks.informed only. Brief leads with TODAY'S CALENDAR via `processCalendarEvents`. `core/briefIntent.ts` short-circuits owner-DM brief requests to `sendMorningBriefing(force=true)`.
- **Floating blocks** (v2.1.0 + v2.3.1 / B1 + v2.3.3 / 3A) — `schedule.floating_blocks` YAML; lunch auto-promoted; elastic within window. `move_meeting` deterministic for colleague-path; owner-explicit in-window hints respected as-is; out-of-window refuses with `lunch_bump` pointer.
- **Action tape** (v2.2.6) — `ACTIONS YOU TOOK IN THIS THREAD` block in owner system prompt lists `[<tool> OK ...]` markers from this thread's history.
- **Post-mutation verification** (v2.2.6, #54) — `verifyEventCreated` + `verifyEventMoved` mirror v2.1.6 `verifyEventDeleted`. Wired into `create_meeting` + `move_meeting`.
- **Travel-aware coord** (v2.3.0, S8) — `coordinator.ts` reads `getCurrentTravel(slackId)` before building `colleagueTz` AND `attendeeAvailability`.
- **Connection attachments** (v2.3.0) — `Connection.SendOptions.attachments` on `message_colleague`. Slack downloads + re-uploads via `files.uploadV2`.
- **`normalizeForGraph(iso, tz)`** (v2.3.0) — strips Z/offset before Graph mutations; fixes UTC-stamping when Sonnet passes Z-suffixed timestamps.
- **OOF detection trusts `showAs === 'oof'` only** (v2.3.1 / B16) — no keyword matching.
- **Proactive social** (v2.2.0 + v2.3.1 fixes) — `social_outreach_tick` reads social topics + 15-question discovery pool. Hard ban on meeting/work/task references. Eligibility requires real `message_received` history. Disabled by default.
- **CHANNELS YOU CAN REACH PEOPLE THROUGH** block in system prompt (v2.3.1 / B22) — reads `listConnections(profileId)` at prompt-build; capability framing via what's available, not what's missing.
- **Concision + self-coherence pass** (v2.2.5 + v2.3.1 / B20+B21) — `looksSelfIncoherent` trigger added (≥2 question marks OR ≥2 if-then branches).
- **Autonomy layer** (v2.1.1) — `behavior.calendar_health_mode: 'passive' | 'active'` toggles autofix vs report-only.
- **Connection interface** (v2.0.0) — four-layer model (core / skills / connections / utils); skills NEVER import from connectors/slack.
- **Social Engine** (v2.2.0) — 30 fixed categories, per-person topics, round-robin continuation, weekly decay, `social_topics_v2`.
- **Persona skill** (v2.2.3) — togglable; off = no proactive social anywhere.

## Open improvement tickets (GitHub)

Consult before proposing anything that might already be filed:
- **[#3](https://github.com/odahviing/AI-Executive-Assistant/issues/3)** — Make persona memory toggleable skill (Low)
- **[#12](https://github.com/odahviing/AI-Executive-Assistant/issues/12)** — Improve Hebrew voice quality (Low)
- **[#22](https://github.com/odahviing/AI-Executive-Assistant/issues/22)** — Cross-connector skill architecture (High) — design-only, gates #4/#5
- **[#23](https://github.com/odahviing/AI-Executive-Assistant/issues/23)** — Unified contact across connections (Low, blocked)
- **[#30](https://github.com/odahviing/AI-Executive-Assistant/issues/30)** — Reserve slot on participant pick (Medium) — tentative reservation in verification window
- **[#31](https://github.com/odahviing/AI-Executive-Assistant/issues/31)** — Book travel buffer on offsite meetings (Low)
- **[#32](https://github.com/odahviing/AI-Executive-Assistant/issues/32)** — Retry move-coord on refusal (High) — participant refusal → earlier-bias round-2
- **[#33](https://github.com/odahviing/AI-Executive-Assistant/issues/33)** — Respond to invite on owner's side (Low) — accept/decline tool
- **[#41](https://github.com/odahviing/AI-Executive-Assistant/issues/41)** — Investigate if recovery pass still earns its keep (Low) — firing-rate + usefulness audit

## Focus going forward

1. **Bug stability sprint.** Owner is running interactive bug-test sessions (file → propose → discuss → build, no auto-anything) until the agent is stable. Expect more sessions like the v2.3.1 wave: lots of small atomic bugs, often with cross-cutting roots, often via screenshots.
2. **Autonomy refinement.** Tickets like #32 (retry-on-refusal), #30 (tentative reservations), #33 (invite responses) are queued.
3. **Transport additions.** Email + WhatsApp connectors sit behind the Connection interface (v2.0.0). #22 gates real work on them.

## Known dead fields worth cleaning

`behavior.rescheduling_style`, `behavior.adaptive_learning`, `behavior.escalate_after_days`, `behavior.can_contact_others_via_slack`, `behavior.autonomous_meeting_creation` — all declared in the yaml schema but NEVER read in the code. The only `behavior` fields actually wired are `v1_shadow_mode` and `calendar_health_mode`. Worth a cleanup ticket but not filed yet.

## Bugs are expected

External QA is active. When a bug lands, follow the usual flow (propose, don't fix; verify in code before trusting memory; code for determinism, prompts for judgment).

---

## Mission — what we're actually building

Maelle is an AI executive assistant that works **as a human EA**. The entire product premise is that colleagues and the owner experience her as a person — not a bot, not an "AI assistant," not a chat interface. A real member of the team who happens to run on code.

The filter test for every decision: **"Would a real human EA do this / say this / phrase it this way?"** If the honest answer is no, the behavior is wrong — even if it's technically correct. This filter outranks any other priority including speed, completeness, and elegance.

Concretely this means:
- Colleagues never see machine framings: "the system", "force the slot", "clear the threshold", "my tools/prompts", "I'm an AI."
- Errors surfaced to users sound human: "I got confused, can you clarify?" beats "Operation failed." Silence beats a fake "Done."
- The owner's preferences ARE the rules. They're phrased as his ("your usual 2h focus block"), not as a system ("the threshold").
- Out-of-band notifications (shadow notify, debug logs) stay out of live conversations. They live in logs, or in a dedicated audit surface.

---

## The four-layer model (architectural spine — DO NOT violate)

Maelle is built on four conceptually distinct layers. Every new file belongs to exactly one. When in doubt, ask which layer before writing.

### 1. Core (always on — required to run any agent)
Engine-level capabilities every profile needs. Cannot be toggled off.
- `src/core/assistant.ts` — **MemorySkill**: preferences, people memory, interactions, gender, notes.
- `src/core/outreach.ts` — historical location; **OutreachCoreSkill** now lives at `src/skills/outreach.ts` after the v1.8.11 port, but it stays in CORE_MODULES and cannot be toggled off. `message_colleague`, `find_slack_channel`. How Maelle speaks to people on the owner's behalf.
- `src/tasks/skill.ts` — **TasksSkill**: tasks CRUD, approvals, structured requests, briefings.
- `src/tasks/crons.ts` — **RoutinesSkill** (CronsSkill): create/list/update/delete recurring routines.
- Plus pure engine infra: `src/tasks/runner.ts`, `routineMaterializer.ts`, `lateness.ts`, `src/core/orchestrator/`, `src/core/background.ts`, `src/core/approvals/` (now includes `coordBookingHandler.ts` — the registry MeetingsSkill registers its booking handler on so core/ doesn't import from skills/).
- **Persona** is core too, but lives as data in the YAML profile + `orchestrator/systemPrompt.ts` — no dedicated module.

### 2. Skills (togglable — profile YAML `skills: { ... }`)
Opt-in capabilities. Some agents will do meetings, some will do research, some both. Toggled per profile.
- `src/skills/meetings.ts` — MeetingsSkill (direct calendar ops + multi-party coordination)
- `src/skills/meetings/coord/` — coord state machine internals (v2.0, moved from connectors/slack/coord). Files: `utils.ts`, `approval.ts`, `booking.ts`, `state.ts`, `reply.ts`. All transport-agnostic.
- `src/skills/meetings/ops.ts` — direct-op helper (former `_meetingsOps.ts`, relocated in v1.8.14). Still class `SchedulingSkill`, used only via MeetingsSkill's delegation.
- `src/skills/calendarHealth.ts` — CalendarHealthSkill (issues, lunch, categories)
- `src/skills/summary.ts` — SummarySkill (transcript → summary → share)
- `src/skills/knowledge.ts` — KnowledgeBaseSkill (markdown KB)
- `src/skills/general.ts` — SearchSkill (web_search, web_extract)
- `src/skills/research.ts` — ResearchSkill (owner-only, multi-step)
- `src/skills/outreach.ts` — OutreachCoreSkill (lives under `skills/` for code layout; stays always-on via `CORE_MODULES`)
- `src/skills/registry.ts` + `src/skills/types.ts` — the skills-system machinery itself

Legacy profile YAML keys `scheduling: true` / `coordination: true` auto-map to `meetings: true` at load time; `meeting_summaries` → `summary`; `knowledge_base` → `knowledge`; `calendar_health` → `calendar`.

### 3. Connections (comm-surface framework — v2.0 first-class layer)
How Maelle gets onto a given surface (Slack, email, WhatsApp, Graph). **Connection interface is fully implemented for Slack.** Email + WhatsApp pending.
- `src/connections/types.ts` — `Connection` interface (sendDirect, sendBroadcast, sendGroupConversation, postToChannel, findUserByName, findChannelByName). `SendOptions.threadTs` flows through to `chat.postMessage`.
- `src/connections/registry.ts` — per-profile `Map<profileId, Map<connectionId, Connection>>`. Skills resolve via `getConnection(ownerUserId, 'slack')`.
- `src/connections/router.ts` — 4-layer routing policy (inbound-context / person preference / per-skill / profile default). Not yet hot-path for skills, but in place.
- `src/connections/slack/messaging.ts` — raw Slack primitives with threadTs support.
- `src/connections/slack/index.ts` — `SlackConnection` that implements the interface over messaging.ts.
- `src/connectors/slack/` — Slack Bolt app, reply pipeline, outreach reply classifier. The SOCKET-side (inbound) of Slack lives here. App.ts registers a `SlackConnection` in the registry at startup.
- `src/connectors/graph/` — Microsoft Graph (calendar reads/writes, free/busy) — not a Connection (it's a calendar backend, not a messaging surface).
- `src/connectors/whatsapp.ts` — placeholder. Next concrete target.

**Rule:** skills import only from `src/connections/`. They NEVER import from `src/connectors/slack/*` or use `app.client.*`. This was the v1.8.12–14 port; protect it.

### 4. Tools & Utilities
Pure cross-cutting helpers. No domain state, no registered tools.
- `src/utils/` — logger, gender detection, security gate, claim checker, reply verifier, date verifier (with deterministic correction fallback), coord guard, rate limit, shadow notify (uses Connection registry now), Slack formatting, addressee gate, **workHours** (isWithinOwnerWorkHours + nextOwnerWorkdayStart — shared by outreach_expiry / coord_nudge / coord_abandon).
- `src/connectors/slack/processedDedup.ts` — process-global message ts dedup Set, shared between live handlers + catch-up (fixes the v1.8.14 duplicate-reply bug).
- `src/db/` — storage helpers per table
- `src/config/` — profile loader + env

---

## Standing rules — follow these every session without being asked

### Workflow: propose, don't fix
- When the user reports a bug or requests a new feature, DO NOT jump to code.
- Investigate, then propose a solution in plain words: what's wrong, why, and how you'd fix it.
- Wait for the user's feedback / QA / comments.
- Only after explicit go-ahead, implement.
- This applies to every bug and every feature, every session, regardless of how obvious the fix looks.

### No personal info in code (v2.3.5)
- Owner names, company names, domains, colleague names + roles, durations, buffer values, focus-time hours, lunch / floating-block windows, office locations, vacation rules — all live in YAML (`config/users/*.yaml`) or are read from `profile.*`. Code reads from profile, never literals.
- Comments may reference owner-specific facts as historical context, but anything that reaches a runtime string, regex, prompt, tool description, or schema enum must be parameterized. The repo is public on GitHub — keep it cloneable.
- When proposing a fix, before writing a literal string with a name / company / domain in it: ask "would this work for John (a future profile with different name + company)?" If no, parameterize.

### Maelle is a human
- Maelle is a person, not a bot. The entire product premise is that colleagues and the owner experience her as a human executive assistant.
- Every answer, every DM, every option Maelle generates must be something a real human EA would plausibly say or do.
- Filter test: "Would a human EA ever send this message / offer this option / phrase things this way?" If no, it's wrong — regardless of technical correctness.
- This applies to tone, cadence, hedging, apologies, error messages surfaced to users, proposed slot phrasings, escalation wording, everything user-facing.
- Never expose tool names, bot framings, structured artifacts, or AI-ish tells ("I'm an AI", "as an assistant", "my prompt", "I was programmed to"). Already enforced for colleagues by securityGate — but the bar is higher: not just "doesn't leak AI" but "sounds like a human."

### Prompts vs code — use the layer that gives the right kind of correctness
Both are valid. The rule is: use CODE where we need determinism, use PROMPTS where we need judgment.
- **Truth-critical guards → CODE.** Anything where an LLM mistake would damage data or trust: idempotency on destructive tools (delete_meeting, create_meeting), schedule-rule enforcement in `findAvailableSlots`, date-weekday verification (with deterministic correction after one retry), action-claim verification (claim-checker runs AFTER the draft), approval-state sync on coord terminal transitions. These must behave identically across models and prompts.
- **Tone, interpretation, phrasing → PROMPT.** How Maelle describes a conflict to the owner, how she asks a clarifying question, how she formats a slot proposal, how she disambiguates a two-clause request. Code can't judge "what sounds human."
- **When a bug shows up:** first ask which kind it is. "She proposed 17:05 instead of 17:15" is a DETERMINISM bug — quarter-hour alignment belongs in code and in the tool contract. "She sounded robotic when the slot was blocked" is a JUDGMENT bug — fix in prompt.
- **Do not cram determinism into prompts.** A prompt rule saying "always align to :00/:15/:30/:45" rots under model swap. The tool that returns the slot should only return aligned slots.
- **Do not cram judgment into code.** A regex trying to detect "is this message a relay commitment" will miss 10% of cases and add false positives. An LLM pass over the draft can classify by meaning.
- **Short prompt rules beat long ones.** One sentence the model actually reads is worth ten it skims. When in doubt: delete a rule, don't add one.

### Version — owner is the gatekeeper
- **Default for the agent: PATCH only.** Even if work feels architectural or substantial, default to bumping patch (`x.y.z → x.y.z+1`). The owner has corrected this multiple times when the agent reached for minor.
- **Owner defines the version.** Minor / major bumps happen ONLY when the owner says so explicitly ("bump minor", "cut a 2.3 release", etc). Never decide the level autonomously.
- **Owner calls when to commit.** Tree changes stay in tree until the owner says "commit", "bundle", "ship", "wrap up", "let's finish for today" — only then commit + push. Never commit on your own initiative even after a patch bump.
- Never bump major (`x.0`) without explicit instruction.

### Version-bump workflow (what to do at each level)
- **PATCH** — keep it light. Update `package.json` version + add the `CHANGELOG.md` entry. THAT'S IT. Do NOT commit, do NOT push, do NOT touch memory files or README. The owner runs the patch locally and bundles when ready. If owner THEN says "commit + bundle", that's when memory files + README + commit + push happen.
- **MINOR** — full wrap-up, owner-initiated only. Update `package.json` + `CHANGELOG.md` + `README.md` (if architecture/public behavior changed) + both memory files + run `npm run typecheck` + commit + push + update/open relevant GitHub issues.
- **MAJOR** — full wrap-up + explicit user instruction required.
- If unsure whether the work is patch- or minor-sized: default to PATCH and let the owner upgrade.

### CHANGELOG.md
- **Every version** (patches AND minors) gets an entry — Maelle's history is the changelog, don't silently squash patches
- Add new version block at the top, above the previous one
- Format: sections (Added / Changed / Fixed / Removed / Migration / Not changed), plain text, no bold on topic labels
- Topic level: describe the idea, not the function
- Date stays implicit in git history — no date lines

### Memory files
- Update the two `memory/` files when something meaningful changed (new skill, new pattern, new architectural primitive, new security layer)
- Keep them punchy — one dense paragraph per file, latest state on top
- If a key fact changed (Haiku → Sonnet, tool renamed, skill merged), fix the line — don't just append

### README.md
- Update only when architecture or public-facing behavior changes; NOT for bug fixes

### Code conventions
- TypeScript strict, no `any` unless unavoidable
- Skill pattern: new togglable capability = new file in `src/skills/` implementing the `Skill` interface, registered in `registry.ts` under a YAML toggle
- Internal helpers in `skills/`: nest under the skill's folder (e.g. `src/skills/meetings/ops.ts`, `src/skills/meetings/coord/*.ts`). Underscore-prefix flat files are retired post-v1.8.14.
- Core module pattern: new core capability = new file in `src/core/` + added to `CORE_MODULES` in `registry.ts` + added to `CoreModuleId` union
- DB changes: idempotent migrations via `try { ALTER TABLE } catch {}` or `CREATE TABLE IF NOT EXISTS` in `db/client.ts` initSchema()
- All times: UTC in storage, Luxon for display in user timezone
- All LLM calls: `claude-sonnet-4-6` (no Haiku anywhere)
- Lazy skill loading: use `require()` inside `loader()` so one broken skill doesn't crash startup
- Every task creation, dispatch, and lifecycle transition: `logger.info` with `skill_origin`, `skill_ref`, `due_at`, preview fields
- Task system owns every async job — creating a background sweep that walks its own table is an anti-pattern; schedule a typed task instead
- **Skills speak through Connections.** Never import from `src/connectors/slack/*` or use `app.client.*` inside `src/skills/`. Resolve via `getConnection(ownerId, 'slack')` and call `conn.sendDirect` / `conn.postToChannel`. Task dispatchers follow the same rule.

### Before finishing any session
1. `npm run typecheck` — must pass
2. Update package.json version if code changed
3. Update CHANGELOG.md (entry per version, always)
4. Update README.md if architecture changed
5. Update the two memory files if something significant changed
