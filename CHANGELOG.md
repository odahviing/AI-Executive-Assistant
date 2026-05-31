# Changelog

---

## 3.1.8 — search skill rebuilt for grounded research; person-store noise controls; same-thread relays

Follow-on to the v3.1.7 person store, from a real-day session. Three threads: (1) the search skill is rebuilt around a grounded `web_research` tool so content stops being written from memory; (2) the person store gets the noise controls it needed — it only fills with people you chose to meet; (3) a colleague's reply to something you sent now comes back in your original conversation thread.

### Changed — search skill: grounded `web_research`

- Rebuilt the search skill (`skills/general.ts`) around a new **`web_research(goal, recency_days?)`** tool: one call runs PLAN (turn the goal into focused queries — not the task text) → GATHER (recency-bounded searches, deduped) → READ (extract the top sources' real text) → returns `{sources, readings}`. The model then writes **grounded in and citing** those sources; if none are found it says so instead of writing from memory. `web_search`/`web_extract` stay as quick-lookup primitives. Owner-path only.
- **Removed `researchPreCheck`** (`utils/researchPreCheck.ts`, deleted; unwired from the orchestrator). The old blind pre-fetch searched the *task framing* ("research 2-3 LinkedIn angles…"), got junk, then injected a "research done" block that *suppressed* the real focused search — so a LinkedIn post cited "Ghost CMS, 700+ domains this week" with no source behind it. `web_research` replaces it: angle-driven, real sources, citable.

### Changed — person store: only people you chose to meet

- **`recordBooking` persists an external only when the OWNER initiated the booking.** Someone books a meeting *with* you (a colleague-path create_meeting / a colleague-initiated coord) → internal colleagues are still recorded ("we book meetings with each other"), but new external attendees are not created. Owner-initiated bookings persist everyone. An external already on file still gets the interaction logged; and you can always explicitly remember anyone via `note_about_person` / `update_person_memory`.
- **Non-human attendee filter** in `recordBooking`: recording/notetaker bots (Gong, Otter, Fireflies, Read.ai, …), no-reply/notification senders, and calendar-resource mailboxes never become "person" rows.
- **`slack_id` threaded into `recordBooking`** as the strongest dedup handle (matches an existing internal colleague even with no stored email / a differently-spelled name), and the **resource-room mailbox is skipped** — closes the duplicate-row + room-as-person edges from the person-store paper-trace.
- Removed the auto calendar-backfill that briefly shipped during the session — it swept the entire external calendar (customers, partners, a personal event, the Gong bot) and flooded the people catalog. External memory is booking-driven + explicit-remember, not a calendar sweep.

### Fixed — colleague-reply relay lands in your thread

- When you ask Maelle (in a DM thread) to message a colleague and they reply, the relay back to you now posts **in your original conversation thread**, not a new top-level DM. Root cause: the outreach request's `origin_*` was repurposed for colleague-side thread continuity, dropping the owner's return address. Fix: the outreach records the owner's thread in `owner_dm_channel`/`owner_dm_thread_ts`, and a colleague-reply relay (`create_approval`) inherits it and threads on it (`skills/outreach.ts`, `db/requests.ts`, `tasks/skill.ts`).

### Changed — "what do you know about X" framing

- The `get_person_memory` tool now guides Maelle to answer person-data questions about the PERSON — role, relationship, durable prefs — and summarize meeting history rather than reciting one booking's logistics (date/time/venue/attendees). Scoped to that tool only.

### Migration / ops

- One-off maintenance scripts under `scripts/`: `cleanup-backfilled-externals.cjs` (removed the 59 over-imported externals) and `load-suggested-people.cjs` (loaded the two the owner picked — Max Attias, Natan Amid).

---

## 3.1.7 — Unified Person Store: one backbone table for every person, internal and external

The big one: `people_memory` evolves from a Slack-first table (PK = `slack_id`, so a pure-email external had nowhere to live) into ONE backbone table keyed by a surrogate `person_id`, holding every person Maelle knows — internal AND external — with their data and history in one place. The real bug this closes: the owner asked to book "Max Attias (gmail), who you already know" and Maelle had no record and re-asked for the email, because `recordBooking` skipped any attendee without a slack_id and the email-keyed `known_contacts` table was scaffolded but never wired. Now externals are persisted on first booking and recalled the next time. Ships alongside #119 (lunch auto-booking) and a security-gate precision pass. Kept a patch by owner direction despite the migration.

### Migration (one-shot, data-safe)

- `people_memory` rebuilt onto a surrogate **`person_id` PRIMARY KEY**, with `slack_id` and `email` demoted to nullable identity attributes (slack_id UNIQUE; null for pure-email externals), plus `kind` (internal|external|self), `org`, `source`. SQLite can't alter a PK in place, so it's a create-new → copy → drop → rename rebuild ([v3_2_0_person_store.ts](src/db/migrations/v3_2_0_person_store.ts)). Every column carried verbatim (incl. `interaction_log`). Safety: full JSON backup to `data/migrations/` before any destructive step + a row-count assertion that rolls back on mismatch. Idempotent. Verified live: 36/36 rows migrated clean. Dead `known_contacts` table dropped.

### Added

- **`resolvePerson({slackId?, email?, name?})`** ([db/people.ts](src/db/people.ts)) — the single find-or-create+merge chokepoint. Match order slack_id → email → fuzzy name; merge-by-attach when a new handle joins an existing person (Slack wins). Every booking / write path routes through it instead of bare slack-id lookups. Plus `getPersonById`, `getPersonByEmail`, `newPersonId`, and `person_id`-keyed worker variants of the write helpers (`appendPersonInteractionById`, `appendPersonNoteById`, `confirmPersonGenderById`, `setCoreFieldWithProvenanceById`, `updatePersonProfileById`, `setPersonNameHeById`); the slack-keyed functions now delegate to these.
- **`resolvePersonTarget`** ([utils/resolvePersonTarget.ts](src/utils/resolvePersonTarget.ts)) — the write-tools' identity resolver: hallucination-guarded slack_id for internal, find-or-create by name/email for owner-path externals.

### Changed

- **Booking persists everyone.** `recordBooking` drops the "skip no-slack-id attendee" rule: every attendee is resolved through `resolvePerson` (creating external rows on first sight), the booking is appended to their `interaction_log` (DB-first), then the md note is written. Threads `slack_id` through as the strongest dedup handle (an existing internal colleague matches by slack_id even with no stored email / a differently-spelled name), and skips the resource-room mailbox so the room never becomes a "person".
- **Person write-tools route through the one store.** `note_about_person` / `log_interaction` / `confirm_gender` / `update_person_profile` no longer dead-end at `unknown_colleague` when there's no slack_id — an owner can now note / profile a pure-email external. Colleague-path stays self-only and slack-keyed (the self-write gate is unchanged); social-moment recording stays internal-only.
- **Per-person md files re-keyed from name-slug to `person_id`** ([memory/peopleMemory.ts](src/memory/peopleMemory.ts)) — fixes the collision where two people with the same first+last name shared one file. Legacy files migrate on first touch (read-fallback + rename-on-write); the catalog disambiguates duplicate display names.
- **Capability-gating, not storage-gating.** Storage is universal; Slack-only features degrade for externals: proactive social DMs are gated to a real slack_id, and free/busy stays internal-only (an external's availability is asked, not probed). Social engine remains internal-only for now.

### Fixed

- **[#119](https://github.com/odahviing/AI-Executive-Assistant/issues/119): active mode never auto-books next-week lunch.** Root cause was the missing-lunch suppressor reading `delete_meeting` audit rows: one row lacking `event_start_iso` (`date === undefined`) matched *every* day, silencing all forward-week lunch detection for 14 days. Replaced the audit-log hack with the date-scoped `calendar_issues` terminal-row mechanism — deleting a floating block now writes a `dismissed` row for that exact day (won't re-book what the owner cleared), and detection skips only genuinely-waived days. Synthetic gap id consolidated into one helper ([floatingBlocks.ts](src/utils/floatingBlocks.ts)), killing the three-way drift the old code warned about. ([calendarHealth.ts](src/skills/calendarHealth.ts), [calendarIssues.ts](src/db/calendarIssues.ts))
- **Identity-spoof gate false-positived on any coworker email a colleague mentioned** (real case: Levana adding `ysrael@reflectiz.com` to a meeting → her on-topic reply was destroyed and replaced with an off-topic English deflection). The same-domain-email regex is now a *candidate*, not a verdict: a Haiku `judgeIdentityClaim` decides impersonation vs benign reference over the multi-turn window (kept, to catch split-across-message attacks). Benign → the original reply is preserved (no longer destroyed); impersonation *or any uncertainty/parse-failure* → protective rewrite (fails safe). The refusal composer now replies in the colleague's language. ([securityGate.ts](src/utils/securityGate.ts))
- **Interview title treated as an unbreakable rule.** The `title:` convention now reads as a default ("treat it as the default") rather than "follow it", so an explicit title request from the requester is honored (token-neutral prompt swap; honoring is already code-backed by requester-controls). ([meetings.ts](src/skills/meetings.ts))

### Known limitations

- A pure-email external who *later* gets a Slack account creates a second row rather than merging (the inbound upsert path doesn't route through `resolvePerson`'s merge). Left as-is — rare, since a company-domain person always arrives via Slack first.
- Booking history lives in the md "What we've discussed", not the structured `recent_interactions` recall (which intentionally excludes `meeting_booked`/`coordination`) — by design, to keep the recall relational and avoid DB churn.

---

## 3.1.6 — real-day fix wave: prompt-reduction regressions + scheduling-quality fixes

Two chats. The first half closes regressions from the 3.1.5 prompt-reduction (a scope misroute that dropped a tool, and two over-cut category/narration rules). The second half is scheduling-quality fixes surfaced in real chats (overlapping slot options, a re-fired mutation on "thanks", duration inflation, and a noisy brief greeting).

### Fixed — prompt-reduction regressions

- **Short-reply scope misroute.** A 1-3 word owner reply ("meeting", "book it") carries almost no scope signal, so the Haiku scope-classifier guessed — and on 2026-05-31 it tagged "meeting" as `knowledge`, which dropped `set_event_category` (it lives in `meetings`) and left Maelle unable to tag the event ("I can't from my end"). Tool-scoping has no recovery when a needed tool is absent, so a wrong narrow guess is fatal. Fix ([classifyTurn.ts](src/core/social/classifyTurn.ts)): low-signal short replies (≤3 words) widen to `general` (ship all tools) instead of trusting a narrow guess — a wrong guess can never drop a tool, and short replies are rare. Word-count gate, language-agnostic.
- **Bare "Interview" subject (over-cut #1).** The 3.1.5 category-description trim (first sentence only) dropped Interview's title convention, so Maelle over-redacted and booked a bare "Interview" (real case: candidate Ohad Shushan). Restored as **structured data, not prose**: a new optional `title_hint` field on categories ([userProfile.ts](src/config/userProfile.ts)) rendered as one compact line on the category cue ([meetings.ts](src/skills/meetings.ts)) — `detectCategory` still reads the full description. Plus a **general** Subject rule so it's fixed for *every* category at once: the subject must name the person/topic, never the bare category name ("Interview"/"Meeting"/"Sync") alone.
- **Zero-slot narration (over-cut #2).** With the `WHEN A REQUESTED DAY HAS ZERO SLOTS` block trimmed, Maelle blamed the colleague ("she's pretty booked") when the tool's top reason was `owner_busy` (the owner's own packed calendar), and labeled an off-hours 09:00 slot as "focus time". Restored a sharpened line: name the real blocker from `day_summary.top_reasons` (owner-busy vs attendee-busy vs soft block) and label each override slot by its actual `broken_rule_label`.
- **RULE-NAMING dedup tightened.** The deleted `RULE-NAMING` block's unique guard ("paste `broken_rule_label` verbatim, don't fall back to a vague 'needs your go-ahead'") was folded back into `RULE-COMPLIANCE REFUSAL` (no separate block).

### Fixed — scheduling quality (parallel chat)

- **Overlapping slot options.** The fill pass back-filled overlapping starts to hit the option count — e.g. 10:30 / 11:00 / 11:30 for a 55-min meeting, where 11:00 and 11:30 sit inside the 10:30 slot. `pickSpreadSlots` now takes the duration and skips a candidate that overlaps an already-chosen one ([calendar.ts](src/connectors/graph/calendar.ts), [ops.ts](src/skills/meetings/ops.ts)).
- **Re-fired mutation on a "thanks".** "Done, renamed to X" → owner says "Perfect, thanks" → Sonnet re-ran `update_meeting` and downgraded the title. The orchestrator now strips write tools when the turn is a non-task ack AND the previous assistant turn already executed a write (action-tape markers) ([orchestrator/index.ts](src/core/orchestrator/index.ts)). "Want me to change X?" → "yes" still writes (that prior turn fired no write).
- **Duration inflation.** Meeting length was being inferred from the meeting TYPE ("interview" → 55 min). Tightened the `find_available_slots` `duration_minutes` description (never infer length from type — only from a stated number) + a code backstop that defaults to `default_meeting_duration` when none is passed ([ops.ts](src/skills/meetings/ops.ts), [meetings.ts](src/skills/meetings.ts)).
- **Brief greeting noise.** The morning brief led with "Morning —" on line 1, which is what Slack shows as the message preview. Dropped the time-of-day greeting so the preview carries real state (calendar/date) instead ([briefs.ts](src/tasks/briefs.ts)).

---

## 3.1.5 — prompt reduction (prose lazy-loading + dedup) + off-grid booking fix + date-verifier/floating-block fixes

Three chats bundled. The prompt-reduction pass continues on top of 3.1.4's tool-scoping: this version adds **prose lazy-loading** (rarely-used skill prose ships only when its scope is active) and a **static-prose dedup/trim** sweep, bringing the common owner scheduling turn to ~36K tokens. Plus one real correctness fix (off-grid slot alignment) and two fixes from parallel chats (date-verifier performance, floating-block self-rejection).

### Changed — prompt reduction (continued from 3.1.4)

- **New `calendar` scope** ([classifyTurn.ts](src/core/social/classifyTurn.ts), [registry.ts](src/skills/registry.ts)) — separates calendar **review/health** ("how's my week", "any conflicts", "do I have my buffer") from **booking** so the ~2.3K calendar-health prose ships only on review turns. The health *tools* stay in `meetings` (always present on a scheduling turn — Sonnet can always run them); only the prose is gated. `calendar` deterministically unions `meetings`, and `freeTimeInquiry` unions `calendar` ([orchestrator/index.ts](src/core/orchestrator/index.ts)) so a buffer/free-time question always loads the guidance.
- **Prose lazy-loading** — the coordination ROUTE 1 details ([meetings.ts](src/skills/meetings.ts)), SUMMARIES ([summary.ts](src/skills/summary.ts)), KNOWLEDGE BASE ([knowledge.ts](src/skills/knowledge.ts)), EXTERNAL VENUES ([venue.ts](src/skills/venue.ts)), and CALENDAR HEALTH ([calendarHealth.ts](src/skills/calendarHealth.ts)) prose now render only when their scope is active (riding the `scopes` plumbing landed in 3.1.4). Fail-open on the colleague path / classifier-off.
- **Static-prose dedup/trim** in the meetings skill — collapsed the dead location decision tree (`resolveLocation` owns it), category descriptions → first-sentence cues (`detectCategory` owns the full text server-side), and deduped blocks that restated each other or a tool's own contract (`RULE-NAMING`→`RULE-COMPLIANCE REFUSAL`, `OWNER OVERRIDE IS THE APPROVAL`→`OWNER-PATH OVERRIDE`, `WHEN A REQUESTED DAY HAS ZERO SLOTS`, `OVERLAP REPORTING`, `DURATION`, the `is_online`/location chat-mapping→`create_meeting` description).
- **Tool-description dedup** — `rank_venue` rank legend (its param carries it), `create_meeting` LANGUAGE restatement (the params carry it), `colleague_slack_id` warning shortened.

### Fixed

- **Off-grid slot alignment (correctness).** `create_meeting` / `move_meeting` now snap an off-grid start (e.g. 14:40 from a raw calendar gap) to the `:00/:15/:30/:45` grid via `alignNearestQuarter` ([ops.ts](src/skills/meetings/ops.ts)) — the helper was previously wired only to floating blocks, so an off-grid time Sonnet proposed could reach the calendar unaligned. New `start_is_explicit` flag preserves a deliberately-named off-grid time ("book at 14:40"). The ~6-line `SLOT START TIMES` prompt rule collapses to one line.
- **Date-correction retry no longer re-runs the whole orchestrator** ([postReply.ts](src/connectors/slack/postReply.ts), [dateVerifier.ts](src/utils/dateVerifier.ts)). When the date-verifier flags a wrong weekday/date, the fix was a full `runOrchestrator` re-invocation (re-sent the ~46K cached prefix + all tools + history, re-ran the tool loop — ~30s on a long report). Replaced with a tool-less `rewriteWithCorrectDates` Sonnet pass: sees only the draft + the corrections, ~1-2s, fewer tokens, and inherently can't refire a write (removes the old `proseOnly` write-guard from the 2026-05-18 Michal-delete incident).
- **Floating-block circular self-rejection** ([scheduleRules.ts](src/utils/scheduleRules.ts)). Booking a floating block (e.g. a 25-min lunch) into the only remaining gap failed the rule check, because `checkSlot` tested whether the block could *also* fit elsewhere after placing itself. Now: when the proposed slot IS the floating block being booked and sits inside its own window, skip the self-fit check (other blocks' windows still checked, so lunch can't squeeze out a separate gym/coffee block).
- **`delete_meeting` returns `deleted_start_iso`** so the reply names the deleted day+time from the tool result, not lossy chat memory (`DELETE-MEETING PROTOCOL` step 6).
- **humanGate** scrubs "the tool is telling me / the tool returned" machine-state phrasing ([humanGate.ts](src/utils/humanGate.ts)).

### Added — bug-fixing process (code-first)

- `SESSION_STARTER.md` gains a "How we fix bugs — code-first, root-cause, no patch-on-patch" standing principle; the `bugs` and `github` skills updated to a **code-first fix ranking** (prompt rules last, judgment/format only), **avoid regex on natural language** (multi-lingual), build-signals-exact / reads-without-asking / no-jargon rules, and a **"verify-still-reproduces / already-fixed → close, don't patch"** guard (closed #116/#117/#118 — fixed in 3.1.4, left open by oversight).

### Watch

- The tool-scoping + prose lazy-loading layer is gated by `behavior.intent_aware_tools: true`. If a turn misbehaves (a tool or prose block missing where it was needed), set it to `false` to fail-open (ships every tool + all prose) — the kill-switch / A-B for any scoping-caused regression.

---

## 3.1.4 — colleague-scheduling correctness (the Yossi wave) + tool-scope prompt reduction

A real-day colleague-scheduling chat (Yossi booking with Idan) surfaced five bugs, four of which trace to one root: the direct (non-coord) scheduling path was stateless across turns — it re-derived slots and re-queried the calendar instead of carrying forward what it just established. Fixed at the root, plus the parallel prompt-reduction chat's tool-scope restructure landed here too.

### Fixed — colleague scheduling (Yossi wave)

- **Offered-then-retracted slot.** Maelle offered 12:30/12:45/13:00, the colleague picked 13:00, and she re-ran `find_available_slots` with the window ending *at* 13:00 — which structurally excludes a 13:00 start (a 25-min meeting ends 13:25) — then claimed "13:00 isn't free." Scoped the re-search rule ([meetings.ts](src/skills/meetings.ts)): picking a slot you offered this thread is NOT a "what about X?" question — those were already rule-checked, so book the exact slot via `create_meeting`, don't re-search. (Same class as the owner's "but didn't you just offer sunday?")
- **Asked a colleague for a teammate's email she already had.** "add Eli Feldman" → "I need his email." The email auto-fill existed but was copy-pasted in three handlers and missing from `update_meeting`'s add path. New shared resolver `skills/meetings/resolveAttendeeEmails.ts` (slack_id → fuzzy name → directory); `update_meeting`'s add-attendee path and `normalizeBookingRequest` both call it. Name-only adds resolve silently — no asking.
- **"Add Eli + rename" flailed then punted to the owner.** `update_meeting` wasn't in `COLLEAGUE_ALLOWED_TOOLS`, so a colleague had no tool to edit an existing meeting — Sonnet improvised `create_meeting`/`move_meeting` (both rule-failed), burned the rate limit, and punted vaguely. Implemented the owner's **requester-controls** model: whoever REQUESTED a meeting controls it (add anyone / rename / change location / move if rule-compliant); a non-requester → one clean `create_approval`. `update_meeting` added to the colleague allowlist; its self-only attendee gate replaced with a requester gate (`findMeetingOwner`); the same requester gate added to `move_meeting`'s colleague path.
- **Just-booked event lost on the next turn.** Right after booking, `get_calendar` returned 0 events (Graph `calendarView` indexing lag), so Maelle couldn't find the meeting to edit. A colleague's direct booking now records a **requester-link** on the requests spine (`requester_slack_id` + `event_id`), and that event is injected into the colleague's next-turn context — so follow-up edits target `update_meeting`/`move_meeting` by `event_id` instead of a lagging re-read. (`findMeetingOwner` now prefers rows that name a requester, making the link timing-independent.)

### Changed — tool-scope prompt reduction (Block 2, from the latency chat)

Per-call-site cost data (from the 3.1.3 usage logging) showed the orchestrator's ~46K cached prefix is ~80% tool definitions. Block 2 slims what ships per turn: `ALWAYS_ON_TOOLS` cut 22 → 12 ([registry.ts](src/skills/registry.ts)); person-WRITE tools moved to a new `people` scope (reads stay always-on + backstopped by the end-of-chat capture pass), task-detail tools to `tasks`, `web_extract` to `knowledge`; the multi-party coordination tools (`coordinate_meeting` et al.) demoted to a new `coord` scope (they hadn't legitimately fired in a month and were causing wrong-tool picks on plain scheduling turns — the classifier unions `meetings` when coord genuinely fires). `classifyTurn`'s scope enum updated accordingly (`coord`/`people` added, the empty `social` scope dropped). Plan + cost findings: `.claude/PROMPT_REDUCTION_STARTER.md`; `scripts/_dump-prompts.cjs` for the tools-vs-prose token split.

### Not changed
- Y5 (duration-snap wording / "morning" label) — owner deemed it not worth fixing.

---

## 3.1.3 — timezone-as-location regression killed + scheduling determinism, brief honesty, real-day bug wave

A real-day session bundle. The headline: a regression where a **timezone got narrated as a location** ("the meeting is in Jerusalem/Tel Aviv" to an Israeli colleague) traced to a scrubber that deliberately converted IANA strings to city names — fixed at root. Around it: the cross-timezone availability flow made deterministic, the daily-free-time floor unified across search and booking, brief closure narration made honest, calendar-health autonomy made visible, plus the social-engine raise/decay wiring and two changes that arrived from parallel chats (LLM usage logging, the resolver "Eli ghost" actor-direction fix).

### Fixed — timezone is for scheduling, never narrated as a place

The core principle: an IANA timezone (`Asia/Jerusalem`, `America/New_York`) is a SCHEDULING value for time math; a person's location for discussion comes from the separate `state`/city field. Deriving a city from a timezone is wrong ("America/New_York" ≠ New York; the person may be in Boston).

- **Root cause** — `utils/textScrubber.ts:humanizeIanaToken` ran on every owner- and colleague-facing Slack post and converted each IANA string to its trailing city segment (`Asia/Jerusalem` → "Jerusalem"). Now it emits the timezone *abbreviation* (Luxon `ZZZ` → "EDT", "GMT+3") or strips the token — never a city.
- `db/people.ts:formatThreadParticipantsForPrompt` pasted raw `tz=Asia/Jerusalem` with no anti-inference guard (its sibling `formatPeopleMemoryForPrompt` had one); now shows `state`/city when on file, else marks "city not on file — don't infer".
- `skills/meetings/ops.ts` — `per_attendee_local` and `travelers` slot enrichments dropped the raw `timezone`/`travelTimezone`/`homeTimezone` fields from the tool JSON; kept the pre-rendered `local_display` + free-text `location` (the correct source).
- `core/orchestrator/systemPrompt.ts` — the three narrative-facing slots (week boundaries, calendar-event-times rule, dynamic header) no longer print the raw IANA string; Luxon still gets it for math.

### Fixed — cross-timezone colleague availability (incorrect slots under pressure)

When a colleague proposed times in their own TZ ("June 9 12:00 Boston (your 19:00)"), `utils/availabilityPreCheck.ts` was regex-extracting *both* numbers and testing each as owner-local → two contradictory verdicts → Maelle flip-flopped under pressure. Now, when the message carries a TZ cue (named place / abbreviation / explicit "(your H:MM)"), a Haiku pass normalizes each proposed slot to a single UTC-anchored instant before testing; bare local-time questions keep the cheap regex path. Plus owner-path `find_available_slots` now auto-adds `@`-mentioned colleagues to the attendee list so the existing work-hours clip + per-attendee TZ rendering actually fire (a Boston colleague no longer gets offered his 03:30).

### Changed — daily-free-time floor enforced on the write path too

The 2h-office / 1h-home focus-time floor lived only in `find_available_slots` (search). A named-time `create_meeting` / `move_meeting` / coord pick went through `checkSlot` (validation), which never applied it — so direct bookings landed on packed days the search would have refused. Extracted `computeDayQualityFreeMinutes` into `utils/scheduleRules.ts`; both the slot-finder loop and a new `checkSlot` rule (`focus_time_floor`) now call the one helper, honoring the same `allowRelaxed` owner-override bypass.

### Fixed — Maelle fabricated free-time / buffer answers, and over-narrated

- **Free-time questions** ("do I have my buffer today?") ran no tool — Sonnet invented "2h45 free / healthy". `classifyTurn` now flags `freeTimeInquiry` on owner turns; the orchestrator runs `analyzeCalendar` for today+tomorrow and injects the real `freeMin`/gap numbers before Sonnet answers. Replaces the prompt rule Sonnet kept ignoring.
- **Brief closure narration** — the `owner_*` rule told Sonnet to write "I told <requester> you said yes" for owner-side closures, fabricating an outbound DM that never happened (the Lori-Weekly line). Rewritten to narrate it as the owner's own decision; a code-side `closed_at_relative` field anchors stale closures in time ("Yesterday: …") so a day-old close doesn't read as today's news.

### Changed — calendar-health autonomy is visible and quieter

- **Silent on clean routine runs** (#118) — `check_calendar_health` returns `vacuous: true` on zero issues + zero auto-fixes; the routine dispatcher suppresses the post (no "all clear, nothing flagged" spam). Owner-asked chat calls still reply so you can verify.
- **Shadow on active-mode coord** — when active mode auto-initiates a move-coord (the silent Lori-Weekly trace), it now fires a shadow DM at the moment it acts, so the owner can countermand before the colleague responds. Autonomy preserved; visibility added.
- **`event_id` carry-forward** — recently-surfaced calendar issues (last 6h) are injected into the owner prompt, so "delete it" / "fix it" follow-ups resolve against the known `event_id`/`peer_event_id` instead of a fresh subject search that misses a vanished event.

### Fixed — social engine: topics that camped and never rotated

`markSubjectRaised` was orphaned when the task-turn coda path was disabled — so `last_assistant_initiated_at` stayed NULL on every subject, which dead-lettered the picker's 72h re-raise defer, the ignore-decay, AND the daily initiation gates (a topic the owner kept ignoring lived forever at the score ceiling). Wired `markSubjectRaised` onto the live proactive `continue` directive; a raise no longer refreshes `last_touched_at` (so an ignored-but-raised subject still ages toward dormancy via weekly decay).

### Fixed — one shadow DM per colleague turn (#117)

The v3.0.8 "shadow post-gate" move split the inbound + outbound shadow into two `shadowNotify` calls, each with its own "Conversation with X" header → owner saw a doubled DM stream. Re-merged into one post carrying both sides.

### Added — richer `update_meeting` audit + LLM usage logging

- `connectors/graph/calendar.ts:updateMeeting` now audit-logs every field actually patched (subject/start/end/categories/location/isOnline/attendees) instead of `{}` — so "did Maelle effectively cancel this via an update?" is answerable from the audit going forward (it surfaced during the Ido-duplicate investigation, where the audit was too thin to prove either way).
- `utils/usageLog.ts` (from a parallel chat) — one structured `LLM usage` log line per Anthropic call (label + model + token counts) for per-call-site cost attribution; instrumented across the classifier, claim-checker, human-gate, security-gate, and other LLM call sites.

### Fixed — resolver "Eli ghost": owner reject on an awaiting_colleague row

(from a parallel chat) `resolveRequest`'s amend-bounce-back fired on row STATE alone — so an owner reject/amend on an `awaiting_colleague` row ("close it, already booked") was misread as "the colleague rejected my counter" and bounced back to `awaiting_owner` instead of closing. Now gated on the ACTOR (`resolvedByColleague`): bounce only when the colleague is the one resolving.

### Not changed — the coord double-`createRequest` ghost

Investigated and confirmed already fixed at root: the orphan rows (`i3kb2` 5/26, `le7d6` 5/27) were created by the old `createCoordJob` request-bridge, deleted in 3.1.0. Both predate the 3.1.0 deploy (commit landed 5/27 morning; the orphans were the last gasp of the still-running old code before restart). Zero recurrence since; `createCoordJob` no longer bridges; the reconciler cleaned the stale rows. No code change — flagged here so the investigation isn't re-run.

---

## 3.1.2 — three-chat bundle: audit pass (12 fixes) + performance pass + second-pass spine fixes

A coordinated wrap of three parallel workstreams over the requester framework, all bundled here (no per-chat version churn).

### Performance — one turn-classifier instead of two

The two per-owner-turn Haiku pre-passes — `classifyOwnerIntent` (social kind/category/sentiment) and `classifyToolScope` (Module G tool scoping) — are merged into a single `classifyTurn` (`src/core/social/classifyTurn.ts`). One LLM round-trip per turn instead of two → cuts the pre-first-tool latency gap. The old `classifyOwnerIntent.ts` / `classifyToolScope.ts` are deleted; all call sites (orchestrator, social `stateMachine`, `skills/registry` tool scoping, `capturePass`, `claimChecker` comments) rewired to the merged classifier.

### Fixed — audit pass (12 bugs across the requester/booking surface)

A separate deep-audit chat found and fixed 12 bugs across the venue subsystem (`skills/venue.ts`, `utils/venueSearch.ts`, `db/venues.ts`), Slack-id resolution (`utils/resolveSlackId.ts`), calendar (`connectors/graph/calendar.ts`), coordination (`connectors/slack/coordinator.ts`), deferred-action replay (`core/requests/deferredActionReplay.ts`), people memory (`db/people.ts`), and meetings (`skills/meetings.ts`, `skills/meetings/ops.ts`). See commit `3cf8bcc` for the per-file diffs; the granular bug list lives in that audit chat's record.

### Fixed — second-pass spine audit (A-1 / B-1 / C-2)

- **A-1** coord approvals the owner never answered expired *silently* — `runExpiry`'s owner-tombstone DM was approval-kind-only; widened to coord (which now sets `owner_dm_channel` at initiation), so the midpoint nag + expiry tombstone reach the owner. Coord-abandon "grace window" wording softened (work-hours deferral can stretch it past +4h).
- **B-1** `reconcileOrphanedRequests` read the now-vestigial `coord_jobs.status` to decide booked-vs-cancelled → a booked-but-orphaned coord was mislabeled `cancelled` and lost its event id. Now derives booked-ness from the real `external_event_id` and carries `outcome_external_event_id` onto the request.
- **C-2** two more dead `UPDATE tasks ... type='outreach_expiry'` blocks (`coordinator.ts`, `meetingReschedule.ts`) missed in the first sweep → replaced with clearing the linked request's `next_check` (the spine equivalent of "a reply kills the expiry timer"); fixed the stale `coordinator.ts` file-header describing the deleted task pipeline as current. Added `request_id` to the `OutreachJob` type (the real bridge column).

---

## 3.1.1 — Path 2 finish: one timer sweep, side tables data-only, + #114/#115 + audit fixes

Completes the requests-spine migration started in 3.1.0 (the "leftover" — same project, not a new line). Two things landed: (1) the timer/status cleanup that 3.1.0 deferred, and (2) the GitHub bug fixes for #114/#115, then a scoped verification audit of the whole requester framework that caught and fixed several real closure bugs in the migration itself.

### Changed — one timer sweep owns all lifecycle timing

The legacy task dispatchers `coord_nudge` / `coord_abandon` / `outreach_send` / `outreach_expiry` / `outreach_decision` are DELETED. All lifecycle timing now runs through the single spine sweep `sweepDueRequests` (`core/requests/runner.ts`, invoked each tick from `tasks/runner.ts`): coord nudge→abandon ported into the runner (DM non-responders, re-arm, abandon, with owner work-hours deferral), outreach send/expiry already on the spine. The `tasks` table now carries only non-back-and-forth work (routine, calendar_fix, social_*, reminder, follow_up, research). Stale rows of the removed types skip gracefully (unknown-dispatcher → mark failed, no crash/loop).

### Changed — side tables are DATA-only (status decoupled)

`coord_jobs.status` and `outreach_jobs.status` are now VESTIGIAL columns (NOT NULL DEFAULT, never read for lifecycle). `updateCoordJob`/`updateOutreachJob`/`createCoordJob`/`createOutreachJob` take `status` as a TRANSITION SIGNAL (drives the linked request + terminal cascade) but no longer persist it. All status reads route through new `getCoordLifecycle` / `getOutreachLifecycle` (read the linked request). `approvals.status` retained intentionally as the approval machine's internal mirror (payload stays in `approvals`; request owns `awaiting_owner`). Dead outreach helper queries removed (`getExpiredOutreachJobs`, `getScheduledOutreachJobs`, `closeFireAndForgetOutreach`, `getOutreachJobByColleague`).

### Fixed — #115: requester close-loop visibility + double-DM

`requester_notified_at` on the request is a single-notification idempotency stamp: the colleague-requester is DM'd exactly once across the resolver's `notifyRequesterOfDecision` and `closeMeetingArtifacts`' close-loop (first sends + stamps; the other skips the DM but still fires the owner shadow). Owner now gets a shadow line whenever the loop closes — you were blind to it before. All four notify sites (resolver, closeMeetingArtifacts, brief auto-park, runExpiry) honor the stamp.

### Fixed — #114: brief no longer fabricates a colleague reply

A brief surfacing an `awaiting_colleague` approval is now narrated as "relayed to X, no word back yet" — never "X said the counter doesn't work" (there's no reply on record). RULE 5 also forbids offering capabilities with no tool (e.g. "I'll pull up the past thread") and then retracting. The stale orphan approval was a pre-3.0.7 artifact; reconcile + the subject-match close-loop prevent recurrence.

### Fixed — audit-caught closure bugs (scoped verification audit of the requester framework)

- **closeFollowup orphan**: a colleague reply matched via the fallback path closed the (vestigial) outreach status but left the request `awaiting_colleague` forever → now closes the linked request. Same fix applied to the thread-reply path (`closeFollowupForMessageTs`).
- **coordinator handoff guard** read the frozen `coord_jobs.status` → now request-aware via `getCoordJobsByParticipant`.
- **sibling-outreach cleanup** (`updateCoordJob` terminal cascade) wrote a vestigial column and left sibling requests open ("3 open threads" regression) → now closes the sibling requests via `closeRequest`.
- **runCoordAbandon** could 5-min-spam the owner if the cascade no-oped → defensive timer clear.
- **coord approval reminder/expiry DMs were silently dropped** (coord requests never set `owner_dm_channel`) → now set at initiation, so the midpoint nag + expiry tombstone reach the owner.
- **synthetic thread-ts** from a failed-placeholder routine could make Slack reject (and drop) coord/approval DMs → `safeThreadTs` guard posts top-level instead.
- **thread-reply orphan**: a thread reply on an outbound closed followup tracking but left the request open → now closes the linked request.

### Cleanup (folded in, no leftover)

- `closeMeetingArtifacts`'s requester stamp documented as deliberately synchronous (the resolver fresh-reads it to dedup — an async stamp would race and double-DM); the rare fire-and-forget DM failure is benign because the calendar invite still goes out. Removed the moot `requester_notified_at` stamp in the brief auto-park (the request is closed on the next line; nothing re-reads it). Meeting-reschedule outreach cascade now closes the linked request instead of writing a vestigial status column. Deleted dead `UPDATE tasks WHERE type IN (...)` clauses targeting the removed timer task types (approval_expiry/reminder, outreach_expiry/decision) and trimmed the `target_slack_id` backfill to the surviving `outreach` type.

### Migration

`requester_notified_at` column added to `requests` (idempotent ALTER). `coord_jobs.status` / `outreach_jobs.status` columns physically retained (vestigial, defaulted) — no risky table rebuild; all code references removed.

---

## 3.1.0 — Path 2: the requests spine owns status (kill the ghost class)

The multi-step backbone — getting an ask, ping-ponging between Idan and others, brief status, the loop-back — now lives on ONE table, `requests`. Side tables (`coord_jobs`, `outreach_jobs`, `approvals`) keep their DATA (the ask payload, the DM text, slots/participants) but no longer own lifecycle: the request's `state` is the single source of truth for "open / who are we waiting on / closed." This kills the recurring ghost class where a coord/approval kept surfacing in the brief after it was actually done — because closure used to depend on a cascade that bypass paths (manual DB delete, double-created request) could skip. Stages 1–5 + 8 land here; the timer-sweep cutover (6) and side-table column-strip (7) are a deferred, live-verified follow-up. Validated by an 11-scenario paper trace (`.claude/PATH_2_PAPER_TRACES.md`), 0 errors, every request proven to open, manage, and close with the 3-way guarantee (DB closed / Idan knows / requester knows).

### Added — `requests.phase`, kind-namespaced activity sub-state

New `phase` column on `requests` (idempotent migration in `db/client.ts`) + index `idx_requests_owner_kind_state`. `state` is the universal lifecycle; `phase` is the finer dance for multi-step kinds (`coord:collecting|resolving|negotiating|waiting_owner`, `outreach:scheduled|awaiting_reply|nudged|no_response`). New `setPhase` (namespace-validated), `getOpenCoordRequests`, `getDueRequestsByHandler` helpers. Types in `core/requests/types.ts` (`CoordPhase`/`OutreachPhase`/`RequestPhase`).

### Fixed — coord double-request (the `i3kb2` orphan), at the root

`createCoordJob` used to bridge its OWN request, then `initiateCoordination` created a SECOND one and re-linked the coord_job to it — leaving the first request orphaned forever, re-surfacing every brief. `createCoordJob` is now a pure DATA insert (no bridge); `initiateCoordination` owns the single coord request (`phase='coord:collecting'`, lead participant as target). One request per coord.

### Fixed — `cancelOrphanCoordJobs` bypassed the request-close cascade

It wrote `coord_jobs.status='cancelled'` directly, never closing the linked request (a ghost source). Now finds orphans by the linked request's open state and routes through `updateCoordJob` so the full terminal cascade (close request + cancel tasks + clean sibling outreach) fires.

### Changed — coord status reads come off the spine

`getActiveCoordJobs`, `getCoordJobsByParticipant`, `getPendingRequestCountForColleague`, `getStaleCoordJobs` now derive open/closed from the linked request's `state`/`phase` (JOIN to `requests`), not `coord_jobs.status`. coord_jobs supplies participant DATA; the request supplies status. `updateCoordJob`'s mid-state cascade now also stamps `phase`.

### Added — reconciliation + retention sweep (`core/requests/reconcile.ts`)

Runs on the background tick. `reconcileOrphanedRequests` closes any open coord request whose backing `coord_job` went terminal OR was deleted out from under it (age-gated 15 min to avoid the create→link race) — bypass-proof closure for the exact "we deleted the orphan rows, it's still here" incident. `pruneOldTerminalRequests` deletes terminal rows (+ children) past a 30-day window so the spine stays lean.

### Fixed — closing-strength guarantee #3 on the brief auto-park path

When the brief auto-cancels a colleague-INITIATED request the owner ignored 3× (`closedBy='brief'`, `surfaced_threshold`), it now DMs the requester ("couldn't get a read from Idan, ping to retry") — mirroring `runExpiry`. Previously the colleague was left hanging after Maelle promised to ask. Found and fixed during the paper trace.

### Changed — reply routing prefers coord (closes the Isaac mis-route, bug #7)

`getRecentOutboundContext` now defers to an active coord covering the colleague (read off the spine) before attaching an outreach context — so an inbound from a coord participant can't be shadowed by a parallel outreach. Routing was already coord-first in `app.ts`; this closes the context-attach side.

### Deferred (live-verified next change)

Stage 6 (retire the now-redundant legacy timer dispatchers) and Stage 7 (strip the now-redundant status columns from the side tables). **Correction:** `sweepDueRequests` IS wired — it runs every tick via `tasks/runner.ts:39` inside `runDueTasks`. Outreach + approval timers already fire through the spine; the legacy `dispatchOutreachExpiry`/`Send` guard on `request_id` and defer (no double-fire). The only timing still on legacy task rows is coord `coord_nudge`/`coord_abandon` (the spine coord handlers are dormant stubs). So Stage 6 is "delete the guarded-redundant legacy outreach dispatchers + move coord nudge/abandon onto the spine (or keep them — they work)", not "wire the sweep." Owner direction: finish it live-verified.

### Migration

`ALTER TABLE requests ADD COLUMN phase` + `idx_requests_owner_kind_state` — idempotent, additive, no backfill needed (NULL phase = single-step kind). Existing pre-fix ghost rows (e.g. the `i3kb2`/`ti275` coord pair, the stale Eli approval) will be closed by `reconcileOrphanedRequests` on the first tick after deploy.

---

## 3.0.7 — Slot-finder rule consistency, close-loop via requests spine, owner-picks-slot guard

Real-day-bug-bash session. Eight bug shapes consumed across booking, slot finding, person-memory hygiene, and approval lifecycle. Plus the claim-checker latency pass landing from a parallel session.

### Fixed — slot finder + planMeeting now agree on lunch feasibility

`src/connectors/graph/calendar.ts` — the per-slot floating-block check was MORE LENIENT than `scheduleRules.checkSlot` used downstream by planMeeting. Slot finder accepted candidates via `findAlignedSlotForBlock` (quarter-aligned, finds any aligned position); planMeeting rejected via longest-contiguous-free check (needs an actual N-min segment for the block). Mismatch surfaced 2026-05-26 in the Eli flow: slot finder offered Wed 12:00, owner saw the slot proposed to Eli, then planMeeting flagged "only 5min free after this slot" and escalated for approval. Two layers disagreeing. Now the slot finder ALSO runs the longest-contiguous-free check inline (with the same merge + walk + winEnd logic as scheduleRules). Both layers must pass. Owner direction preserved: "OK to MOVE lunch in its window, not to IGNORE lunch."

### Fixed — colleague-requester close-loop DM via the requests spine

`src/utils/closeMeetingArtifacts.ts` — when a meeting mutation succeeds and the cascade finds a matching open `request` with `requester_slack_id` set (colleague-initiated), the cascade now fires a `Connection.sendDirect` to that requester ("Hey \<name\>, locked in '\<subject\>' — calendar invite is on its way.") BEFORE closing the request. Close state is also corrected: positive bookings (created/moved/updated) now close as `state='resolved'` (was `cancelled` — wrong for booking-success cases). Plus the subject-match fallback was broadened from `subkind='in_flight_action'` only to ANY open colleague-initiated request whose subject matches the booking's subject. Catches the Eli case: owner amended Wed→Tue, request stayed in awaiting_colleague, owner later booked Tue 13:15 via direct `create_meeting`, and the cascade now finds + notifies + closes. Lifecycle is now consistently "owner approve → meeting booked → requester notified → request closed" — fallback for when booking lands outside the resolver's deferred-action replay.

### Fixed — `coordinate_meeting` called when owner already picked a slot

`src/skills/meetings.ts` — the `coordinate_meeting` tool description gets a prominent 🛑 HARD STOP block at the top: "if your most recent reply listed N proposed slot options AND owner's next message picks one, DO NOT call coordinate_meeting — call `create_meeting` directly." Concrete consequence call-out included: redundant slot-picker DMs to attendees, claim-checker retry, message_colleague spam. Closes the morning Future-of-Outbound-Automation bug where owner picked "2 June 12pm" from Maelle's proposals and Maelle still kicked off the multi-DM coord state machine.

### Added — `_slot_results_now_stale` signal on slot-relevant profile/memory writes

`src/core/assistant.ts` — `update_person_profile` and `update_person_memory` handlers now detect when the write touched a slot-relevant field (`timezone`, `working_hours`, `working_hours_structured`, `workdays`, `work_hours`, `currently_traveling` for profile; `hours`, `timezone`, `schedule`, `workdays`, `availability`, `travel`, `working` substrings for memory section names). On slot-relevant writes, the tool result includes `_slot_results_now_stale: true` + `_note: "...re-run find_available_slots before proposing options..."` so the next Sonnet iteration sees the freshness signal directly in the tool-result content. Closes the "Isaac is Mon-Fri" case (2026-05-26) where Maelle updated the profile then narrated stale slot options from her turn-1 memory instead of re-running the tool.

### Fixed — `find_available_slots` date-only `search_to` collapse

`src/skills/meetings/ops.ts` — when `search_to` is a bare `YYYY-MM-DD` (no `T`), it now expands to `T23:59:59` before calling the lower-level slot finder. Pre-fix Sonnet passed `search_from === search_to` (same date) and the parser read both as `T00:00:00`, producing a 0-minute window → `getFreeBusy — zero or inverted window, returning empty` → strict pass returned 0 → "Nothing available." The bug had ALWAYS been in the slot-finder Graph layer (since v1.7.0), but the v3.0.3 tool description update told Sonnet date-only `search_to` was valid — which kicked over the rock. Sonnet started passing date-only inputs daily ("when is Lital free tomorrow?" → `search_from='2026-05-27', search_to='2026-05-27'`), and every one returned a false-empty.

### Fixed — `create_meeting` array-guard kills the `attendees.filter` crash

`src/skills/meetings/ops.ts` — `case 'create_meeting'` now runtime-checks `Array.isArray(args.attendees)` before the TypeScript cast. Pre-fix the cast was a pure assertion: when Sonnet passed `attendees` as a non-array shape (single object, keyed object, null, omitted — all observed in the wild), the downstream `attendees.filter(...)` calls crashed with `TypeError`, the registry wrapped it as `unclear_result`, and Sonnet retried with the same broken shape (3× FAILED in a single turn observed 2026-05-26 08:57 IL). Now returns `{ error: 'invalid_attendees', message: '... wrap in an array ...' }` with the actual type + truncated sample logged in warn for shape-debugging.

### Changed — claim-checker pruned to RULE A + coda mode

`src/utils/claimChecker.ts` + `src/connectors/slack/postReply.ts` + `src/core/orchestrator/index.ts` — Module F (RULE 2b/3/9/5b honesty diagnostics) and Module E (RULE 7 re-ask checks) interface fields removed: `priorAssistantReply`, `currentUserMessage`, `imagesInTurn` inputs gone; `re_asked_known_fact`, `unrecorded_promise`, `unverified_state_review`, `invented_after_correction`, `re_asked_after_convergence`, `re_asked_own_question`, `violation_summary`, `retry_instruction` result fields gone. Per v2.8.5 cleanup the extended honesty rules live in the system prompt, not in the post-draft checker. claim-checker is now: RULE A (false action claim) + the coda subprompt only. Net latency improvement on owner-path drafts and matches the architecture intent. My v3.0.6 "CRITICAL — action-based verb tools" section stays — that fits inside RULE A as tool-result interpretation guidance.

### Audit handoff items shipped this version

These were among the 20 audit findings deferred from v3.0.6; they came out of real-day flows this morning so they jumped the queue:

- Owner-picks-slot routing (#34-style coord overuse)
- Slot-finder ↔ rule-engine disagreement on floating blocks (#14 was the v3.0.3 stuck-block detection; this is the inverse — feasibility check too LENIENT vs too STRICT)
- Close-loop DM on owner-direct booking
- Date-only `search_to` time-of-day shape (post-v3.0.3 tool description side-effect)

### Filed for next session

Eight bugs surfaced this session but not built. They share a theme — colleague-experience polish + Path 2 plumbing — and want a coordinated bundle:

- Dina 2-DMs (thread continuity) — Path 2 stage 2: add `target_dm_thread_ts` to requests, message_colleague reuses the open thread
- Shadow mirrors pre-gate draft — move shadowNotify call from `core/orchestrator/index.ts:1867` to `postReply.ts` after gates
- Multi-lang drift (L1) — per-turn language detection in code + dynamic prompt injection
- Social coda on FYI outreach (L3) — gate engagement directive on `intent` field
- Request ID leak backstop — add `\b#?(req|task|coord|out|ci)_[a-z0-9_]+\b` to securityGate triggers
- Coord auto-cancel on create_meeting success for same subject — lifecycle hook
- Reply routing prefers coord over message_colleague when both have open context — `recentOutboundContext` priority
- planMeeting `propose_alternative` verdict for colleague-suggested soft-rule slots — let Maelle offer alternatives before escalating

### Migration

No DB schema change. No yaml change required. Owner action: restart `npm run dev` (or `npm start` + `npm run build` if running production mode).

---

## 3.0.6 — V3 audit bug-bash: 54 atomic fixes + claim-checker covers action-tools

Wrap of the v3.0.5 audit handoff (`.claude/V3_AUDIT_HANDOFF.md`, 83 findings) plus an other-chat claim-checker addition for action-based verb tools. 54 atomic fixes across booking, approval spine, persona/memory, social engine, venue, floating blocks, work hours; ~400 LOC of dead code removed (legacy `db/approvals.ts` orphans). 9 findings ruled out on verification as already-fixed or audit-wrong; 20 deferred per owner direction. Typecheck clean throughout.

### Fixed — top-priority silent-data-loss / privilege

- **Phantom-confirmed bookings closed.** `core/requests/deferredActionReplay.ts` now logs + rethrows on failure (was silently swallowing) AND inspects tool results for `{error}` / `{success:false}` / `{ok:false}` shapes (many meeting tools return error sentinels instead of throwing). Resolver's outer try/catch holds the request in `awaiting_owner` for retry; requester is never told "approved" for a meeting that never landed.
- **Self-write rewrite hardened on 4 colleague-path guards** (`core/assistant.ts`). `note_about_person` / `log_interaction` / `confirm_gender` / `update_person_profile` now force-self when `colleague_slack_id` is missing OR points away from requester. Pre-fix, omitting the field bypassed the guard — a colleague calling `confirm_gender(colleague_name="Idan", gender="female")` resolved by name and wrote to the owner's row with `'person'` provenance, locking the field.
- **Force-book phantom `winning_slot` cleared on failure** (`skills/meetings/coord/booking.ts`). `forceBookCoordinationByOwner` pre-stamps `winning_slot=finalSlot, status='waiting_owner'` BEFORE awaiting `bookCoordination`. Inner pre-create failures (calendar-conflict, duration-approval, Graph create error) early-return without resetting; a later retry from a freeform "retry_or_abandon" approval read it as canonical. Now reset to NULL on any non-booked status after the await.
- **Owner-approval replay freshness re-check.** New shared helper `recheckFreeBusyForBooking` in `core/requests/resolver.ts` — used by BOTH `resolveSlotPickApproval` (preexisting use, refactored) AND `runApproveCallback` (new use for `create_meeting` replays). Owner approves a 2-day-old policy_exception → attendee may have become busy in the target window → relaxed=true bypasses busy filter and double-books. `checkOwnerBusy: false` on the policy_exception path (owner already consented to his own state at approve time).
- **Haiku capture-pass timezone validation** (`memory/capturePass.ts`). The v3.0.2 `isStrictIana` guard existed in the explicit `update_person_profile` tool but NOT in the Haiku end-of-chat extractor. Haiku regularly emitted "IST"/"ET"/"PST" because the SYSTEM_PROMPT listed them as examples. Luxon resolved "IST" to Asia/Kolkata, silently corrupting every cross-TZ slot render. Now gated by `isStrictIana`; SYSTEM_PROMPT rewritten to demand IANA Region/City with mapping instructions.
- **`appendPersonInteraction` RMW race closed** (`db/people.ts`). Wrapped the select-parse-push-update in `db.transaction(...).immediate(...)`, mirroring `appendPersonNote`. Pre-fix, capture-pass + orchestrator concurrent writes on the same row could interleave and silently lose timeline entries.
- **`resolve_approval` privilege gap closed** (`tasks/skill.ts`). Colleague-path now refuses outright when `requester_slack_id` is NULL on an `awaiting_colleague` request. Pre-fix the match-check only enforced when non-null; a guessable approval ID could be resolved by an unrelated colleague on an owner-internal approval.

### Changed — owner override is truly total

`relaxed=true` on owner-path (and explicit `ignore_attendee_availability=true`) now drops BOTH the attendee busy filter AND the attendee work-hours clip in `skills/meetings/ops.ts`. Prior direction was "force them to move meeting, not wake at 3 AM" — but attendee work-hours data is owner-curated in `people_memory`, goes stale, and silently filtered owner-valid slots with no diagnostic. New rule: first call surfaces `outside_attendee_work_hours:<email>` per-attendee in `day_summary.blocked_by` (mirrors `attendee_busy_collision:<email>` shape — `connectors/graph/calendar.ts`). Sonnet narrates "people_memory shows Brett's hours as 09:00-17:00 EST — still book?" Owner says "force it" → second call with override → tool drops both clips. "If I decide, it's on me."

### Fixed — booking pipeline polish

- **`book_floating_block` override snaps off-grid `start_time` to nearest quarter** (`utils/floatingBlocks.ts` + `skills/calendarHealth.ts`). New `alignNearestQuarter(ms, timezone)` helper (rounds half up). Override branch previously skipped alignment for explicit `start_time` — `book lunch at 14:13` with `confirm_outside_window=true` created an event at 14:13.
- **Yaml `block.prefer_position` honored on initial book** (`skills/calendarHealth.ts`). Default chain: `args.prefer_position ?? block.prefer_position ?? 'earliest'`. Pre-fix the handler hardcoded `'earliest'` and ignored yaml; only rebalance consulted it.
- **`coordinate_meeting` `searchTo` clamp** (`skills/meetings.ts`). When `search_from` is later than `now.endOf('week')` and `search_to` is absent, default `searchEndDate` now lands on `searchFromDate.endOf('week')` instead of producing an inverted window.
- **`detectCategory` dead `hasOwner` ternary removed** (`skills/meetings/detectCategory.ts`). The filter-out + prepend-unconditional pattern is the durable shape; both branches of the ternary were identical.
- **`BookingRequest.buildContext` dropped 2 dead context fields** (`skills/meetings/bookingRequest.ts`). `recentBlockDeletes` (audit_log query) and `ownerProposedThisSlotInMpim` (text scan over conversation history) were computed on every booking and read by zero consumers. Removed alongside the now-dead `recentAuditEntries` import.

### Fixed — social engine

- **`recordTopicBeat` bumps parent `social_subjects.last_touched_at`** (`db/socialSubjects.ts`). Pre-fix, beat insert only updated `social_topics.last_used_at`; a new subject's clock never moved and weekly decay punished active subjects.
- **`socialOutreachTick` per-(owner, colleague) daily cap uses owner-local midnight** (`tasks/dispatchers/socialOutreachTick.ts`). Pre-fix used raw UTC midnight; a colleague pinged at 23:00 owner-local could be re-pinged at 02:30 owner-local after UTC rolled. Mirrors the owner-local pattern already in `countAssistantInitiationsTodayForPerson`.
- **`note_about_person` / `note_about_self` subject descriptions rewritten** (`skills/social.ts`). Dropped the false "24h cooldown fires on (topic+subject), counter increments" wording — those handlers don't write to `social_subjects` anymore (moved to end-of-chat capture in v3.0.1). New wording reflects current behavior: subject is a tag on the interaction-log entry, end-of-chat capture reconciles.
- **`note_about_self` subject examples are Maelle-identity-only** (`skills/social.ts`). Pre-fix examples ("ski trip italy", "daughter first grade", "marathon training") were owner-personal and trained Sonnet to mis-route owner-self facts onto Maelle's SELF row, leaking via the ABOUT YOU block to colleagues. New examples: "name origin", "warm direct tone", "hebrew gender", plus explicit ❌ rule for owner-personal subjects.
- **`topic_quality` param dropped from both note tools** (`skills/social.ts`). Parsed but only logged — no behavior depended on it. Quiet token leak on every call.
- **`getActiveSubjectsForPersonCategory` SQL `ORDER BY` aligned to TS picker tiebreaker** (`db/socialSubjects.ts`). Was `engagement_score DESC, last_touched_at DESC`; now matches the picker's `engagement_score DESC, last_assistant_initiated_at ASC NULLS FIRST`. Latent regression risk closed.

### Fixed — venue subsystem

- **Lazy `getAnthropicClient()` in `utils/locationResolver.ts`.** Module-load capture broke the v3.0.0 lazy-per-call invariant — `LLM_PROVIDER=vertex` runtime flip split-brained venue resolution between the hot path (Vertex) and the resolver fallback (boot-time Anthropic).
- **`searchVenueCandidates` parse-criteria prompt includes `Name to resolve` line** (`utils/venueSearch.ts`). Pre-fix, name_hint flowed into Tavily query but not into Sonnet's parse rubric, letting unrelated venues in the same area beat the named target.
- **`hidden_count` computed for name_hint-only queries** (`db/venues.ts` + `skills/venue.ts`). `countHiddenVenues` now accepts `nameHint`; owner gets the "you've ranked one low" signal even when asking by name alone. Pre-fix this only fired with area+type.
- **Case-1 fresh-resolve returns up to 3 candidates + `ambiguity_flag`** (`utils/venueSearch.ts` + `skills/venue.ts`). `resolveVenueByName` signature changed: `VenueCandidate | null` → `VenueCandidate[]` (default `maxResults: 3`). Pre-fix, "Coffee Landwer" with no city silently committed to whichever Tavily ranked first.
- **Catalog/fresh dedup normalizes both sides via head-only `normalizeVenueName`** (`db/venues.ts` exported + `skills/venue.ts` consumer). Pre-fix, catalog row `"Coffee Landwer, HaShayetet 4..."` didn't dedup against fresh candidate `"Coffee Landwer"` — same place shown twice.

### Fixed — display / formatting

- **Shared `formatMinuteOfDay` helper kills "24:00" leakage** (`utils/workHours.ts` new export, used in `skills/calendarHealth.ts` + `skills/meetings.ts`). `parseRange` normalizes 23:59 → endMin=1440; the old formatters built `"24:00"`, which luxon parses as next-day 00:00. Two surfaces hit: issue-detection bounding box (silently extended past midnight) and the HARD RULES prompt block (Sonnet narrated "you work till 24:00"). Both now clamp to `"23:59"`.

### Removed — dead code (~400 LOC)

- **`db/approvals.ts` gutted.** `createApproval` + 5 dead getters (`getApproval`, `getPendingApprovalByMsgTs`, `getPendingApprovalsForOwner`, `getPendingApprovalsForTask`, `getPendingApprovalsForThread`) + `supersedeApproval` + `sweepExpiredApprovals` + `cancelApprovalsForTask` + the helper trio (`canonicalJson`, `buildIdempotencyKey`, `CreateApprovalInput`) all deleted. Verified zero external callers — approval creation moved to the requests spine (`core/requests/`) in v3.0.0. Kept: `setApprovalDecision`, `mergeApprovalPayload`, `getPendingApprovalsBySkillRef` — all still used by `skills/meetings/coord/reply.ts`. `crypto` import dropped.
- **`socialOutreachTick` `void adjustEngagementRank` hack removed** + import trimmed.
- **`dismiss_calendar_issue` removed from `utils/toolCallCache.ts` cache-eligible list** (tool was retired in v3.0.2).
- **3 unused imports trimmed from `core/assistant.ts`** (`recordSocialMoment`, `appendPersonNote`, `SocialTopicQuality`).
- **Dead `isInternal` + `ownerDomain` variables removed from `coord/booking.ts`**.

### Changed — claim-checker covers action-based verb tools (other-chat addition)

`utils/claimChecker.ts` gains a new CRITICAL section: success claims like "done", "scheduled", "noted", "approved", "saved", "marked", "updated" are now backed by action-tool summaries — `manage_routine`, `manage_calendar_issue`, `update_task`, `update_person_memory`, `update_person_profile`, `manage_preference`, `manage_knowledge`, `update_summary_draft`. Mutating verbs are listed per tool (`approve` / `start_resolve` etc. for calendar_issue; `set` for preference; etc.); read-only actions like `list`/`get` don't back mutation claims. Closes the same gap the calendar-mutation guards cover — tool ran clean → claim honest; tool ran with `FAILED` → claim flagged; tool never ran → claim flagged.

### Changed — cloneability

- 4× `"Idan"` literal in tool descriptions → generic placeholder (`core/assistant.ts`, `skills/meetings.ts`).
- `@reflectiz.com` email examples in comments → `@example.com` (`utils/securityGate.ts`, `utils/threadAttendees.ts`).
- `cat_global_*` raw row IDs surfaced to Sonnet → human label via prefix strip (`tasks/dispatchers/socialOutreachTick.ts`).

### Changed — tool descriptions

- **`resolve_approval` clarifies `data` scope** — meaningful ONLY for slot_pick approvals; for other kinds use `verdict='amend'` with `counter`.
- **`find_venue` `type='office'` enum value clarified** — means CUSTOMER / external party's office, never owner's own.
- **`book_floating_block` abut_* bullets** — removed stale "(with buffer)" misclaim (v3.0.2 removed buffer; durations 10/25/40/55 carry their own spacing).

### Changed — TypeScript hygiene

- **`resolver.ts` `require()` of `deferredActionReplay` → top-level import** (no circular import confirmed).
- **`skills/general.ts` web-search responses typed** — minimal `TavilySearchResponse` / `BraveSearchResponse` / `DuckDuckGoResponse` / `TavilyExtractResponse` interfaces replace `as any` casts at 4 sites.
- **`voice/fileTranscribe.ts` whisper cast removed** — `response_format: 'text' as const` narrows the SDK union to `string` directly; no more `as unknown as string` lie.

### Changed — comments / docs hygiene

Stale-comment sweep across `floatingBlocks` (removed buffer doc), `social/stateMachine` (header dropped reference to retired "reconciled subject"), `db/people` (JSDoc on `recordSocialMoment` matches current 2-param shape; doc reference to non-existent `socialTopics.ts` → `socialSubjects.ts`), `utils/scheduleRules` (rule-5 multi-window aware), `utils/workHours` (`nextOwnerWorkdayStart` multi-window phrasing), `core/assistant.ts` (`COLLEAGUE_SELF_WRITABLE_FIELDS` reminder note + `confirm_gender` provenance comment matches silent-rewrite reality), `core/requests/closeRequest` (Path 2 transitional state noted), `db/approvals.ts` top-of-file (notes module as legacy / requests-spine is canonical), `coord/booking.ts` (tombstone deleted), `connectors/graph/calendar.ts` `relaxed` JSDoc (no longer claims widen-to-07-22 — widening lives in caller). Plus stale references to deleted `core/approvals/resolver.ts` fixed in 2 of 3 sites (third is correct historical context).

### Audit findings ruled out on verification (not real bugs)

- **#2** (`log_interaction` arg-name): already correct — `slack_id` per file's stated convention; audit conflated tool families.
- **#7** (cancel-and-relay external organizer): Graph DELETE on attendee copy sends decline RSVP via Exchange automatically; audit conflated "no Slack DM" with "organizer never knows."
- **#14** (stuck-block detection over-reports): block's own slot is always inside the overlapping meeting (precondition for the check), doesn't shrink gaps. Math doesn't trigger the claimed scenario.
- **#16** (`runApproveCallback` discards `verdict.data`): code-level fact true, but `resolve_approval` description (shipped v3.0.5) explicitly directs Sonnet to use `amend+counter` not `approve+data` for non-slot_pick. Contract matches code behavior.
- **#20** (`createSubject` no engagement signal): explicit design choice per `capturePass.ts:928-929` comment, not an oversight.
- **#41** (`update_person_profile.colleague_slack_id` description): "omit field if no ID" is the first-class path per description; `find_slack_user` is the secondary suggestion. Audit misread.
- Plus #39, #52, #55 — see audit handoff for details.

### Migration

No DB schema change. No yaml change required. Restart `npm run dev` to pick up everything.

---

## 3.0.5 — Endless-approval kill, identity-spoof refinement, attendee-memory hook, lunch-gap preemptive dismiss, V3 audit findings

Big wrap covering one session's work plus output from two parallel chats (audit + targeted bug-fix passes). Headline: the "approval stays open all day, brief keeps re-surfacing it" pattern is finally killed at its actual root cause — a `#` prefix on approval IDs in the prompt that Sonnet copied into the `resolve_approval` tool arg, making `getRequest('#req_…')` return null silently. Plus a swap-out of yesterday's identity-spoof regex (false-positive'd on "i am confused" inside 24h of shipping) for a deterministic email-mismatch trigger + Haiku-composed refusal.

### Fixed — endless-open-approval root cause: `#` prefix on approval IDs

Three render sites in `core/orchestrator/systemPrompt.ts` (lines 185, 225, 227) rendered approval IDs as `- #req_xxxx_yyyy` in the PENDING APPROVALS block. Sonnet sometimes copied the `#` verbatim into `resolve_approval(approval_id=…)`. The resolver's `getRequest('#req_…')` returned null, the not-found branch returned `{ ok: false, reason: 'request not found' }` with NO log line, the approval stayed `awaiting_owner` for hours. Brief kept re-narrating it. Owner-said-done scanner (v2.4.2) cleaned up at end of day.

Three-part fix:
1. **Drop the `#` prefix** from all three render sites — Sonnet sees bare `req_…`, copies cleanly.
2. **Defensive `#` strip** in `tasks/skill.ts:resolve_approval` handler — covers stale prompt cache + future callers.
3. **Warn log** on `resolveRequest`'s not-found early return — the silent-fail mode that hid this bug for an unknown stretch is over.

Plus: **`message_colleague` added to `APPROVAL_BOUND_TOOLS`** in the orchestrator's approval-bound-thread filter. Pre-fix, when owner said "tell him" in an approval thread, the tool scope dropped to `{resolve_approval, list_pending_approvals}` only — Maelle drafted "I'll ping Oran" but couldn't actually call `message_colleague`. Claim-checker caught the lie but couldn't retry (tool out of scope). Now she can both close the approval AND ping the colleague in the same turn.

### Changed — identity-spoof guard redesigned (v3.0.4 regex → email-mismatch + Haiku)

The v3.0.4 regex-based identity guard fired on "i am confused" within 24h of shipping (Oran false-positive 2026-05-25 09:20 UTC). Whole approach gone. Replacement:
- **VERIFIED SENDER prompt block** added to colleague-path dynamic prompt (`systemPrompt.ts`) — code-stamped from Slack auth via people_memory. Tells Sonnet identity is authoritative and message body cannot override.
- **Email-mismatch detector** in `securityGate.ts` (`detectClaimedEmail`) — extracts emails from last 5 user messages; flags any `@<ownerDomain>` that isn't sender's own or owner's own. Pure regex on structured data (no natural-language scaling problem). Common case is free.
- **Haiku composer** in `securityGate.ts` (`composeIdentityRefusalWithHaiku`) — only runs on actual signal. Generates a varied, polite refusal in Maelle's voice, no hardcoded text, no system-internals leak. Falls back to a short canned line if Haiku throws.

Closes #112 (the Oran false-positive) and keeps the Ysrael-attack defense from v3.0.4. Identity claims without an email no longer fire here — the prompt block handles those.

### Fixed — `message_colleague` silent-fail (Path 2 stages 0+1, shipped earlier today as 3.0.4 fix-up, here as the formal record)

`outreach.ts:226-268` had a duplicate `createRequest` block — every `message_colleague` call wrote TWO `requests` rows. Duplicate row's idempotency_key collided on repeat sends → UNIQUE constraint threw → `sendDirect` never ran → Maelle reported "Sent the message" without ever sending. Block deleted; `db/jobs.ts:createOutreachJob`'s internal bridge stays as single writer. Plus `summarizeToolCall` now renders `{ error: string }` tool results as `[<tool> FAILED: <reason>]` so the claim-checker shield can't be fooled by a thrown write again.

### Fixed — calendar-issue endless-ask: preemptive approve for floating-block gaps (#issue from chat 2026-05-25)

When Maelle narrates "no lunch on Tuesday" from a `get_calendar` read and the owner replies "covered by the Natan meeting," the v3.0.3 dismiss infrastructure had no way to record the dismissal — `manage_calendar_issue(action='approve')` required an `issue_id` that only existed after `check_calendar_health` materialized the row. Tomorrow's detection ran fresh, re-narrated the gap. Now `manage_calendar_issue(action='approve', date=YYYY-MM-DD, block_name=lunch, notes=…)` inserts a terminal row directly with the synthetic event_id matching `calendarHealth.ts:1339-1347`. Tomorrow's detector sees the suppressor via `upsertCluster`, returns `suppressed`, no re-narration.

### Added — booking auto-writes to attendee memory (`src/memory/recordBooking.ts`)

When `create_meeting` or coord booking (`bookCoordination`) succeeds, a line appends to each non-owner attendee's "What we've discussed" section in their md file: `- [YYYY-MM-DD] Booked "<subject>" at <location> for <when>`. Code-driven, no Sonnet judgment, fire-and-forget after success. Externals without a people_memory row are silently skipped (future improvement: an external-contacts store). Closes the gap surfaced 2026-05-25 — Maelle had booked a Modiin lunch with Natan earlier in the day but had no memory of the venue she'd negotiated when asked about it that night.

### Fixed — issue #113: Slack `<URL|text>` syntax preserved on inbound

`connectors/slack/app.ts:144` stripped Slack's `<URL|text>` form down to just the URL, discarding the visible link text. Real impact: when owner typed `@Leor` Slack delivered `<https://linkedin.com/feed/#|Leor Eliashiv>`, Maelle saw only the URL, then asked "who's behind that LinkedIn link?" even after owner just typed the name. The strip line is gone. Sonnet reads Slack's native bracket syntax fine. Issue #113 closed.

### Changed — startup version DM removed (`src/index.ts`)

The 180s-delayed "Hi <Name>, Maelle vX.Y.Z back online" startup ping is gone. In the Slack agent-panel sidebar, every DM creates a chat row — even a one-line restart ping creates a phantom unread artifact. Version bumps are visible in CHANGELOG.md + git log; the owner doesn't need a boot notification. Removes `VERSION_PREF_KEY` + `last_announced_version` persistence + ~55 lines of startup code.

### Changed — v3.0.4 schema defaults pass (shipped earlier today; here as the formal record)

`UserProfile` schema rewritten for minimum-viable-yaml. A profile with ~15 required lines now boots fine — everything else defaults. Removed entirely: `priorities`, `vip_contacts`, `rescheduling` top-level blocks + `VipContactSchema` / `ReschedulingRuleSchema` types; `user.role` required (now optional); `assistant.persona` + `slack_display_name` required (now optional with defaults); `schedule.{office_days,home_days}.notes`; `schedule.timezone_preferences` required (now optional); `schedule.night_shift.{blocking_event, note}`; `meetings.office_location.{label, address, parking}` legacy fields; `meetings.protected[].rule` + `.recurring`; `skills.general_knowledge`. Old yamls keep parsing (zod strips unknown keys). Yaml template rewritten in required+optional 2-section format.

### Fixed — `Skill threw during tool` log now includes stack trace

Both catch branches in `src/skills/registry.ts` now log `err.stack` alongside `String(err)`. Previously the throw-site was hidden — the 2026-05-25 04:32 UTC `SqliteError: no such table: calendar_dismissed_issues` from `check_calendar_health` had no stack and no source-level path explaining it. Future similar fires get the file:line immediately.

### Audit handoff filed

`.claude/V3_AUDIT_HANDOFF.md` — output from an 8-subagent parallel audit pass run during this session. 83 atomic findings, 4 critical silent-data-loss / privilege bugs flagged at top (owner-approval replay swallow, two `note_about_person`/`log_interaction` rewrite-guard holes, NULL `requester_slack_id` colleague-resolve gap). Recommended fix-wave ordering attached. Future sessions can pull from this handoff to schedule the next bug-bash.

### Other small fixes this session (parallel chats)

Several files edited by parallel sessions during this same bug-bash window — content-level details on each are in their respective commit-message bodies and the audit handoff:

- `src/core/social/stateMachine.ts` — engagement signal handling tweaks
- `src/db/approvals.ts`, `src/db/people.ts` — small consistency fixes
- `src/skills/general.ts`, `src/skills/venue.ts` — narrow tool description / handler changes
- `src/utils/floatingBlocks.ts`, `src/utils/scheduleRules.ts`, `src/utils/workHours.ts` — schedule-helper consistency
- `src/utils/threadAttendees.ts`, `src/voice/fileTranscribe.ts` — small polish
- `src/tasks/dispatchers/socialOutreachTick.ts` — dispatcher polish
- `src/core/requests/closeRequest.ts` — closure-cascade refinement
- `src/core/assistant.ts`, `src/skills/meetings.ts` — small adjustments

### Migration

No DB schema change. No yaml change required — old yamls boot. Owner action: restart `npm run dev` to pick up everything.

---

## 3.0.4 — Identity-spoof guard in security gate, schema defaults pass, silent-fail kill in message_colleague

Three threads from a morning of investigation work + the v3.0.4 schema-defaults pass that had been sitting uncommitted. The headline is the identity-spoof guard: Ysrael did a night test (2026-05-24 21:44–22:02 UTC) and got Maelle to list Idan's week of meetings by claiming to be Yael. Persona prompt alone is LLM-vs-LLM — the fix puts a deterministic code check inside the existing security gate.

### Fixed — identity-spoof guard inside `securityGate.ts`

New `detectIdentitySpoof()` runs BEFORE the existing leak scan on every colleague-path reply. Pure regex + comparison, no LLM judge. Three deterministic signals on the last 5 inbound user messages — any one short-circuits with a canned refusal and skips everything else (rewriter, leak scan, send):

- **Identity denial** — `\bi[’']?m not <verifiedFirstName>\b` (catches "I'm not Ysrael")
- **Identity flip** — `\b(i[’']?m|this is|my name is) <Name>\b` where `<Name>` ≠ verified first name, with a short stop-list (`sorry|fine|here|ok|done|sure|happy|busy|free|...`) so "I'm sorry" / "I'm here" don't match
- **Owner-domain email mismatch** — any `@<ownerDomain>` email mentioned in chat that's neither the verified sender's own nor the owner's (catches Ysrael typing `yael.h@reflectiz.com` as proof-of-Yael)

On spoof the canned refusal goes out: *"Your Slack account shows you as `<firstName>`. If you need something for someone else, have them message me directly."* Logged as `identity_spoof` trigger in the same warn line the existing leak filter uses. Verified sender email is sourced from `people_memory` (written at message arrival in `app.ts` via `users.info`), recent user messages from `history`.

Architectural note: this is folded into security gate, NOT a new gate. Owner direction — the existing gate already runs on every colleague-path reply, so identity becomes a check it does, sibling to the leak scan. No new latency for the common case (regex-only fast path).

### Fixed — `message_colleague` silent-fail (Path 2, stages 0 + 1)

Two related fixes on the v2.7.0 → v2.7.1 outreach migration that had been half-done since v2.7. **Stage 1:** `outreach.ts:226-268` had a duplicate `createRequest` block — every message_colleague call wrote TWO `requests` rows. The duplicate row used a generic subject ("Waiting for reply from `<Name>`" / "Messaged `<Name>`") identical across every call to the same colleague, so its `idempotency_key` collided on the second-and-onward send to anyone Maelle had messaged before. UNIQUE constraint threw inside the tool, `sendDirect` never ran, Maelle reported "Sent the message" — silent fail. Block deleted. `db/jobs.ts:createOutreachJob`'s internal bridge stays as the single writer, using a message-preview subject that's naturally unique. **Stage 0:** `summarizeToolCall` now detects `{ error: string }` results (which is the shape `registry.ts` wraps every thrown tool call in) and renders `[<tool> FAILED: <reason>]` instead of `[<tool>: <input>]`. Pre-fix the claim-checker shield treated tool-in-toolSummaries as success — that's how the lie got past ("Sent the message to Yael. I'll let you know when she replies"). With the FAILED render, future thrown writes can't sneak past.

Path 2 stages 2-6 (full `outreach_jobs` table removal) deferred to a separate session.

### Changed — v3.0.4 schema defaults pass

`UserProfile` schema rewritten for minimum-viable-yaml. A profile with ~15 required lines now boots fine — everything else defaults. Removed entirely from the schema (every field was either dead code or never read):

- Top-level `priorities`, `vip_contacts`, `rescheduling` blocks + `VipContactSchema` and `ReschedulingRuleSchema` types
- `user.role` (was required min(2) — now optional with no default)
- `assistant.persona` (defaults to a built-in warm-professional EA voice — owner can override)
- `assistant.slack_display_name` (defaults to `assistant.name`)
- `schedule.office_days.notes` + `home_days.notes`
- `schedule.timezone_preferences` (was required — now optional)
- `schedule.night_shift.{blocking_event, note}` (replaced in v3.0.3 by `meetings.issue_exclusions.subjects`)
- `meetings.office_location.{label, address, parking}` (legacy pre-2.8.2)
- `meetings.protected[].rule` + `meetings.protected[].recurring`
- `skills.general_knowledge`

Whole `meetings` block now has defaults for every field; `meetings.protected` defaults to `[]`; `behavior` and `skills` blocks each default. Yaml template (`config/users.example/user.example.yaml`) rewritten in 2-section format — required block (~23 lines) on top, advanced/optional with defaults commented in below. Old yamls keep parsing — zod silently strips unknown keys, so existing profiles with `priorities:`/`vip_contacts:`/`rescheduling:` boot unchanged.

### Fixed — stack-trace logging in `skills/registry.ts`

Both `catch` branches that handled `Skill threw during tool` now log `err.stack` (when available) alongside `String(err)`. Pre-fix the throw-site was hidden — on 2026-05-25 04:32 UTC `check_calendar_health` started returning `SqliteError: no such table: calendar_dismissed_issues` and no source path in current `src/` queries that table, so the throw-site was effectively unknowable. Next reproduction will surface it directly. Restart the bot once to pick this up.

### Migration

No DB schema change. No yaml change required — old yamls boot. Owner action: restart `npm run dev` (the existing process predates these changes).

### Filed for follow-up

The `calendar_dismissed_issues` SqliteError root-cause is still unknown — static analysis turned up zero source-level references to the legacy table outside the `DROP TABLE IF EXISTS` at startup. Restarting the bot should either clear it (if it was process-state) or reproduce it with a stack trace (if it's source-level). Track the next firing.

---

## 3.0.3 — KB on colleague path (internal-only, silent) + find_available_slots honors time-of-day

Two scheduling-relevant fixes that came out of a real-day Yossi / Oran chat.

### `find_available_slots` honors time-of-day in `search_from` / `search_to`

Pre-fix the implementation forcefully appended `T00:00:00` (search_from) or `T23:59:59` (search_to) to whatever Sonnet passed, silently stripping any time-of-day component. The tool description has always claimed "ISO 8601 format" — implementation now actually honors it. When Sonnet sees an attendee window in text ("Tmw 7-12 and 14-17") she passes `search_to: '2026-05-25T12:00:00'` and the tool clips so candidate slots fit entirely within. Date-only calls keep working (back-compat path appends start/end-of-day only when no `T` is present).

This closes the bug where Yossi said available 7-12 and Maelle proposed both 11:00 AND 12:00 — the 12:00 slot was outside Yossi's window once the 25-min duration was added, but the tool had no way to enforce his window. Now the time-of-day clip in the search args is sufficient — no new params, no per-attendee complexity. Tool description updated to be explicit about the dual date / datetime input shape.

### Knowledge base — colleague path, internal-only, silent use

`manage_knowledge` is added to `COLLEAGUE_ALLOWED_TOOLS`. Handler-level gate enforces:
- Sender's email domain must match owner's domain → INTERNAL → KB available
- Different domain or unknown → EXTERNAL → returns `kb_external_blocked`
- Even for internal colleagues, only `action='get'` is allowed; `ingest` stays owner-only

The point: when Maelle is talking to an internal Reflectiz colleague, she should be smarter and more relevant by pulling KB context (product positioning, voice, recurring narratives). When she's talking to an external party, no KB content can leave the perimeter — same gate model as `attendeeScope.isInternalOnly` already uses.

**Critical narration rule (new colleague-context prompt block):** KB is Maelle's background reference. She calls it silently and uses what she learns to compose a better reply. She never narrates the act of consulting it — no "let me pull from KB," no "looking at my notes," no "checking my reference material." The colleague experiences the reply as her own informed response. Explicit ❌/✅ examples in the prompt.

This closes a real-day bug where Maelle told a colleague (Oran) "Let me pull some context from the KB to help draft something solid for Idan" — a narration leak of internal infrastructure that also stalled the conversation (Sonnet said "let me X" without doing X, no follow-up tool fired, turn ended with a dangling promise).

### Filed for follow-up

[#111 — Maelle learns from her own work](https://github.com/odahviing/AI-Executive-Assistant/issues/111) (Improvement, Medium). Today KB grows only when the owner writes markdown. With v3.0.3 Maelle reads it on the colleague path; next milestone is auto-proposing KB additions from meeting summaries / outreach exchanges / owner drafts with owner-in-loop approval before writes land.

### Fix-up patch (same 3.0.3 — squashing the buggy first release)

Initial 3.0.3 surfaced behavioral gaps in real-day Isaac/Yossi tests: Sonnet was unioning multiple attendee windows into one wide `find_available_slots` call (letting invalid slots through), the claim-checker false-positived on third-party windows quoted from images (it can't see image content), the duration default was hardcoded "25" in the tool description (broken for any profile whose `allowed_durations` doesn't include 25), and a regex-based detector built to enforce per-window calls only matched same-day patterns connected by "and"/"or" — multi-day list formats like "Mon 16-19, Tue 10-15, Wed 11-13" slipped past it.

Under the same 3.0.3 label (this is the polish on the version we just shipped):

- **Config-driven duration default** — new `meetings.default_meeting_duration` yaml field (validated to be in `allowed_durations`); fallback to smallest allowed when unset. Tool description renders the value dynamically. No more hardcoded "25" — any profile gets its own default.
- **Generalized ONE-CALL-PER-TIMEFRAME prompt rule** — replaces the old DISJOINT WINDOWS rule which only covered same-day patterns. New rule explicitly covers same-day AND multi-day cases, with worked examples ("Mon 16-19, Tue 10-15, Wed 11-13" → 3 calls). Format-agnostic — newlines, commas, day-name prefixes, "and"/"or" all count as separators.
- **Regex-based disjoint-window detector deleted** — brittle, format-dependent, missed real cases (the multi-day Isaac format). Owner direction: stop fighting LLM with regex when the prompt rule + claim-checker retry path already gets there. `src/utils/disjointWindowDetector.ts` removed; the guard call in `meetings/ops.ts` removed.
- **`find_available_slots` toolSummaries enriched** with actual returned slots. Pre-fix the summary was `[find_available_slots: duration_minutes=N]` — claim-checker couldn't verify time claims in the draft because the summary carried no slot data. Now: `[find_available_slots 2026-05-27T11:00→13:00 dur=40m → 1 slots: 2026-05-27 12:00-12:40]`. Claim-checker can audit specific time assertions against actual tool output.
- **Image-aware claim-checker** (`imagesInTurn: boolean` threaded through orchestrator → postReply → claimChecker). When an image was attached this turn, RULE D (`unverified_state_review`) is softened for third-party-state claims — those legitimately come from image content the checker can't see. The OWNER's own calendar / tasks / approvals stay strict; image presence doesn't excuse missing read tools for owner-side state.
- **Entry + strict-pass result logs on `find_available_slots`** — diagnostics for debugging future per-call shape questions ("did Sonnet pass time-of-day?", "did she split per window?", "what did the tool return?"). Picked up by the bundle review and surfaced the Isaac test gaps.

### Migration / restart notes

- No schema migrations.
- Optional: add `meetings.default_meeting_duration: 25` to your yaml under `meetings:` for explicit default — without it, smallest of `allowed_durations` is used.
- `npm run dev` restart required to pick up the tool registry + prompt changes.

---

## 3.0.2 — Calendar-issue algorithm redesign + floating-block buffer kill + TZ guard + status / routine polish

The substantive change is the **calendar-issue algorithm redesign** (formerly `calendar_dismissed_issues` → `calendar_issues`, one-row-per-cluster, cluster-aware suppression and cascade, new tool surface). The supporting fixes — floating-block buffer structurally killed, strict-IANA TZ guard, Slack status indicator polish during the gate stack, Sonnet-narrated routine context — landed at the same time. (Note: this version originally shipped in two commits — small fixes in one, the dismissed redesign added a few hours later. Single version label going forward.)

### Calendar issues — complete redesign

Old table `calendar_dismissed_issues` is dropped; replaced by `calendar_issues` with a fundamentally different shape. Truncated all rows (owner direction: clean start, no migration). New rules:

**One row per CLUSTER.** Events linked via overlap edges form a cluster (transitive: A↔B overlap + B has OOF → both go on one row). Each cluster has ONE `issue_class` — the highest-priority issue across all its events. Other issues in the cluster are silently dropped at write time; the row's anchor event resolves them all once moved.

**Priority order:** `work_on_day_off > oof_with_meetings > overlap > category_limit > missing_floating_block > busy_day`. Tiebreak: lex-min event_id.

**Schema:**
- `event_id` — anchor event (Graph id, or floating-block synthetic `{NNN}-{MMDDYYYY}-{HHMM}` for missing-block class — supports up to 999 blocks, one row per (date, block-index) without colliding)
- `peer_event_id` — only set when `issue_class='overlap'`
- `event_end_ms` (INTEGER epoch) — freshness anchor; rows filter out via `event_end_ms > now()` at read time, no cron expiry needed
- `status` — one of: `new`, `awaiting_owner`, `in_progress`, `owner_side`, `approved`, `dismissed`, `resolved` (last 3 terminal)
- `request_id` — FK to `requests.id` when status is `in_progress`
- `UNIQUE (owner_user_id, event_id)` — anchor identity

**Write path:** detection emits in-memory `DetectedIssue` objects → `buildClusters` groups via overlap edges → `upsertCluster` looks up existing rows touching the cluster's events (via `event_id IN cluster OR peer_event_id IN cluster`):
- 0 active rows → INSERT
- 1 active row → UPDATE in place (may re-anchor if cluster shape shifted)
- 2+ active rows → MERGE: keep oldest, fold others in, DELETE rest (handles cluster-joining when a new overlap links two previously-separate rows)
- Any terminal row touched → SUPPRESSED (do not surface)

**Auto-stale at detection time:** after a pass, any active row in the date range not touched by the cluster batch flips to `status='resolved'` — the condition that produced it has vanished. Cleanup of old terminal rows (>30 days past `updated_at`) lives in `cleanOldResolvedIssues`.

**Cascade:** `closeMeetingArtifacts(eventId, reason)` resolves any non-terminal row where `event_id = E OR peer_event_id = E`.

**Detection-time exclusions (overlap path):** events skipped from issue detection if they match ANY of —
1. all-day / showAs free / showAs workingElsewhere
2. **NEW** subject matches anything in `meetings.issue_exclusions.subjects` yaml list (replaces hardcoded `night_shift.blocking_event` check — "Home Time" now configured here)
3. matches a configured floating block (lunch / focus / etc.)
4. entirely outside the day's work-hours window
5. **NEW** any of the event's categories matches a yaml category flagged `no_issue_tracking: true` (the "Personal category" rule — owner's life, not tracked)

**Floating-block stuck case:** `analyzeCalendar` now also flags `missing_floating_block` when the block event EXISTS but is overlapped by a meeting AND `findAlignedSlotForBlock` finds no clean alternative slot in the window. Owner direction: reuse the existing class rather than introduce a new one (`floating_block_overlap`). The detail field carries the specific story ("lunch at 12:00 overlaps Comsec — no clean alternative in 11:30-13:30") so Sonnet narrates accurately. Rebalance still runs and silently fixes the common case; this detector covers only the unrecoverable case.

### Tool surface — `manage_calendar_issue`

Rewritten action enum: `list | approve | start_resolve | owner_will_resolve | owner_done`. Replaces the prior `action='update'` + status enum. `start_resolve` opens a `follow_up` request under the row and stamps `request_id` — the row auto-resolves via cascade when the underlying event changes. No more parallel Path A / Path B with two fingerprint formats.

### Yaml schema additions

- `meetings.issue_exclusions.subjects: string[]` (optional) — subject silence list
- `categories[].no_issue_tracking: boolean` (optional) — flag on category definitions to skip events tagged with this category

Owner sets `"Home Time"` in the subjects list and `no_issue_tracking: true` on the `"Personal"` category. The hardcoded `night_shift.blocking_event` check at the overlap detector is gone; the night_shift config still exists for its other uses (work-hours computation).

### Removed — calendar-issue legacy

- Legacy `buildIssueKey` (format A / format B duality), `upsertCalendarIssue`, `dismissCalendarIssue`, `getDismissedIssueKeys` — all unreachable now
- `dismiss_calendar_issue` legacy free-form Path B at `calendarHealth.ts:1881` — deleted
- `calendar_fix` task dispatcher reduced to graceful no-op (legacy in-flight tasks complete cleanly; new design doesn't spawn this task type)

### Supporting changes (small)

The 5-min buffer on floating-block math is now structurally impossible: `bufferMinutes` parameter is removed from `findAlignedSlotForBlock` / `findLatestAlignedSlotForBlock` / `findPositionalSlotForBlock` entirely. 3.0.1 dropped defaults to 0 but the owner's yaml `buffer_minutes: 5` was still leaking into floating-block math via explicit reads at every call site. New strict-IANA timezone validator catches ambiguous abbreviations like "IST" (luxon resolves to India, not Israel) at write time in `update_person_profile`, plus a one-shot data fix for the bad rows. Slack status indicator gets a "Finishing up" beat during the post-tool gate stack so the panel doesn't freeze on the last tool verb for 4-8 seconds. Routine output regains context — Sonnet now opens user-routine replies with a conversational one-liner naming what fired ("From this week's LinkedIn ideas routine: ..."), so a content brainstorm doesn't read as a context-less dump.

### Changed
- **`bufferMinutes` parameter removed from floating-block placement helpers** (`src/utils/floatingBlocks.ts`). Floating-block math is buffer-free at the lowest layer; standard meeting durations (10/25/40/55) carry the natural spacing. Six call sites updated to not pass it (`calendarHealth.ts`, `meetings.ts`, `meetings/ops.ts`, `connectors/graph/calendar.ts`, `rebalanceFloatingBlocks.ts`, `verifyScheduledOutcome.ts`). Closes the Sunday lunch case where 13:00-13:25 (inside the 11:30-13:30 window) was rejected as "no room" — buffer expansion pushed quarter-alignment past the window end.
- **Status indicator fires during the gate stack** (`src/connectors/slack/postReply.ts`). New "Finishing up" status set after `formatForSlack` runs, before `humanGate` / `claimChecker` / `dateVerifier` / `securityGate` execute their Sonnet passes. Bridges the 4-8s gap where the assistant-panel was previously frozen on the last tool's verb.
- **Routine output gets a Sonnet-narrated opener** (`src/tasks/dispatchers/routine.ts`). User routines (non-system) now have their prompt wrapped with a one-line instruction to open the reply with a conversational context line. System routines (briefing, calendar health) unchanged — they self-narrate already.
- **`update_person_profile` rejects non-IANA TZ strings** (`src/core/assistant.ts` + new `src/utils/timezoneValidator.ts`). Strict validator accepts Region/City form + literal `UTC`/`GMT`, rejects abbreviations like `IST` / `CST` / `PST` (luxon happily resolves `IST` to Asia/Kolkata, +5:30 — wrong for every Reflectiz contact). Returns an error message Sonnet reads + retries on. Same guard wraps the state→tz Sonnet fallback in the same handler.
- **TIMEZONE NARRATION prompt rule** (`src/skills/meetings.ts`). Replaces the prior CROSS-TZ ATTENDEE rule with explicit guidance: times you write to a listener are in their local TZ; quote `per_attendee_local[].local_display` verbatim; only add a "his/her time" parenthetical when the other party is actually cross-TZ — same TZ means same wall-clock, no parenthetical.

### Fixed
- **`meeting_id` leak in in_flight subject line** (`src/core/requests/maybeOpenInFlightMeetingRequest.ts:69`). The `find_available_slots` spill path fell back to `Reschedule meeting ${eventId.slice(0, 12)}` when `toolInput.subject` was missing (Sonnet rarely passes one), surfacing raw Graph IDs like `AAMkADVmMjY1` into brief narration. Generic non-leak fallback now (`'a meeting'`); the real `event_id` stays in `details.meeting_id` for cascade matching but doesn't reach the brief.

### Data fixes (one-off, already applied to live DB)
- `people_memory.timezone` for Elan Hershcovitz: `"IST"` → `Asia/Jerusalem`. Root cause of the "Elan's side shows 15:15 IST" cross-TZ rendering bug.
- `people_memory.timezone` for Michal Schwartz: `"Israel time"` → `Asia/Jerusalem`. Invalid IANA string.
- `people_memory.timezone` for Levana Bagants: `Europe/Belgrade` → `Asia/Jerusalem` + `state` set to `Israel`. She's Israeli; prior value reflected a short trip.
- `people_memory.state` for Alex Wiggins / Julia Rainesh / Dan Beauregard / Ayala Geni: set to `Boston` (TZ already correct at `America/New_York`).
- All repaired rows now `set_by='owner'` to lock against future auto-overwrite.

### Migration / restart notes
- No schema migrations. `npm run dev` restart needed to pick up code changes; the DB data-fixes are already live.

---

## 3.0.1 — Floating-block override + buffer cleanup, social-engine moves to end-of-chat

Two days of patches over 3.0.0. The big one: subject reconciliation moves from a per-turn classifier into the end-of-chat capture pass. Per-turn cost drops ~700 tokens; subject state evolves at one well-lit chokepoint instead of every message. Plus four floating-block paths get the 5-min buffer dropped + the override-path made total.

### Changed
- **Social subject decisions move to end-of-chat** (`src/memory/capturePass.ts:runSubjectReconciliation`). Per-turn classifier no longer touches `social_subjects` — matching is by subject ID, not label string, so label drift can't fork rows anymore. Each Haiku decision is `{ category, action, subject_id|subject_label, sentiment, topic_beats[] }` with a category-pairing integrity check at apply time. Closes the 2026-05-22 בידוק duplicate-subject bug. Engagement signals + topic-beat recording move here too. `src/core/social/reconcileTopic.ts` deleted (no callers); `classifyOwnerIntent` stripped of `subject_match` + active-subjects block; `chooseSocialDirective` no longer takes `reconciled`.
- **`book_floating_block` override is total** (`src/skills/calendarHealth.ts:1465+`). Pre-fix the override accepted out-of-window placement but the conflict check still ran with a 5-min buffer expansion → owner's "book at 13:30" with a bank meeting ending at 13:30 was refused as buffer-overlap. By the time `confirm_outside_window=true` lands, the conversational warning has fired and owner re-consented. The tool obeys: true overlap, back-to-back, off-hours all allowed.
- **5-min buffer dropped from every floating-block code path**. scheduleRules deleted the buffer-between-meetings rule for normal meetings in v2.7.1 ("Connected back-to-backs are fine by design"); floating-block paths kept a private buffer that wasn't cleaned up then. Standard durations (10/25/40/55) already account for spacing. Defaults flipped to `?? 0` in 6 sites: book_floating_block, slot-search block feasibility, post-book verification, find_available_slots floating-block check, move_meeting on a floating block, rebalance sweep. Owner's yaml `buffer_minutes` field still works — set it if you want one back.
- **Slack bottom-row status reads `'is working...'`** (`src/connections/slack/messaging.ts:366`). Was `'typing…'` for a few weeks; Slack renders the avatar+name above so it had to include the verb.

### Migration / restart notes
- No schema migrations. One-shot `scripts/merge-bidoq-duplicate.cjs` was already run + the duplicate row dormanted; left in `scripts/` for reference.

---

## 3.0.0 — Bug-wave cleanup + 2.9 line closeout. Baseline for the WhatsApp build that follows.

Two-day cleanup pass — 65 atomic fixes from a 76-bug overnight audit, plus follow-ups from the morning briefs and scenario paper-traces. No new capabilities; pure consolidation. ~1,500 lines of dead code removed, ~1,500 lines of fixes added. Typecheck clean throughout. Mark called out as the cut-line: v3 line goes forward into WhatsApp transport.

### Fixed — security & privileges
- `manage_preference` added to `ownerOnlyTools` (was an unintended privilege gap after the v2.9 tool merge).
- `note_about_person` colleague-path target rewrite now mutates args in place (reassignment didn't propagate to SocialSkill — gossip/impersonation guard was a no-op).
- `searchPeopleMemory` excludes SELF rows in the SQL filter (defense in depth against name-fuzzy gossip persistence).

### Fixed — approval pipeline
- `getRequestByIdempotencyKey` no longer filters out closed rows → handler can return a tombstone instead of crashing Sonnet on re-asks.
- `runApproveCallback` runs the replay synchronously and only closes + relays on success (was: close + relay → fire async → silent gap on Graph failure).
- Requester relay now branches on `wasAwaitingColleague` — colleague-accepted owner-counters render as "locked in" instead of "Idan said yes."
- Calendar-issue dismissals now stick: dismiss handler updates the existing active row in place (was building a different `issue_key` than the brief-time filter — dismissals never persisted across runs).
- `resolve_approval` colleague-path verifies `kind === 'approval'` before closing.

### Fixed — booking pipeline
- `update_meeting` attendee-shape change re-evaluates location with `intent: 'new_booking'` (was preserving the existing location even when internal-only flipped to has-external).
- BookingRequest normalizer preserves the handler's owner-in-MPIM `relaxed: true` pre-stamp (the `!rawRelaxed` guard was dropping it).
- `confirm_outside_window` no longer infers `isFloatingBlock=true` (was silently bypassing `owner_busy_collision` on regular `move_meeting` overrides).
- `delete_meeting` seriesMaster guard runs BEFORE the decline-and-relay dispatch (was DMing the organizer before refusing the cancel).
- `move_meeting` colleague-path label map gained `owner_busy_collision` (ask_text named the rule clearly).
- `coord/booking.ts` move conflict scan excludes the moving event.
- `notifyOwnerOfColleaguePushback` appends a rebuilt consequence line on amend bounces (was showing the original time after the counter merged).

### Fixed — work hours, floating blocks, social engine
- `relaxed`/`extendedHours` UNIONS the widened default window with native multi-window work_hours (was collapsing split-shift days).
- Rebalance skips out-of-window blocks (owner-pinned signal) + honors `prefer_position` + dedupes shadow notifications.
- `findAlignedSlotForBlock` guards against DST-gap NaN windows.
- Auto-categorize threads `ownerTimezone` through to day-boundary math (Israel UTC+2/+3 no longer rolls over at UTC midnight).
- `directiveForProactiveSlot` honors `engagement_rank=0` and deprioritizes subjects raised in the last 72h with no response (clean topic rotation after silence).
- Cold-ping warm-reply now updates `outreach_jobs.status='replied'` so the rank-check 48h later sees engagement (signal was inverted — warm replies dragged rank DOWN).
- Capture-pass write race fixed via `db.transaction(...).immediate()` around `appendPersonNote`. SELF row re-seeds if missing.
- Raise-pivot signal removed entirely (option C): silence no longer punishes a raised subject; weekly decay handles aging.
- Path 1 + Path 2 of `missing_floating_block` suppression aligned: deleted blocks suppress at detection time AND are removed from `issues[]` before the brief sees them.
- `parseRange` normalizes endMin=1439 → 1440 so the boundary minute is in-window for both `isWithinOwnerWorkHours` and `isSlotInWorkHours`.

### Removed — dead code (~1,500 lines)
- Legacy `src/core/approvals/resolver.ts` (581 lines, fully orphaned).
- `approvalExpiry.ts` + `approvalReminder.ts` dispatchers (no task creator).
- `coordinate_meeting` stub case; legacy `engagement_level` from `update_person_profile`; no-op `logPersonInitiated` / `logMaelleInitiated` shims; `parseSocialTopics` stub; `lunch_bump` approval kind retired (migrated single producer to `policy_exception` + deferred-action replay); unused imports / params / exports.

### Changed — config leaks + descriptions
- All baked colleague names (Amazia, Yael, Maayan, Onn, Shayan, Maya, Brett, Jenna, etc.) replaced with generic placeholders (Anna/Ben/Cara/...) in tool descriptions and prompt rules across `meetings.ts`, `outreach.ts`, `tasks/skill.ts`, `social.ts`, `systemPrompt.ts`.
- Real-shape Slack ID `U09P4HJ317W` swapped for `U09EXAMPLE9` in 5 sites.
- `resolveVenueByName` derives country from `profile.user.timezone` (was hardcoded `'Israel'`); routes Case-1 through `searchVenueCandidates` so phone/url/hours come back when available.
- `searchVenueCandidates` reads `getAnthropicClient()` lazily per-call (was captured at module load; would have frozen the boot-time provider on a runtime `LLM_PROVIDER` flip).
- `findVenuesByCriteria` switched from substring to exact-then-startsWith on `nameHint` (no more "coffee" matching every café).
- `findVenueByNameAndOwner` dedupes via a name-only normalized head match (collapses cross-visit Place-API drift to a single row).
- `SUNDAY_START_TZS` Set replaces the hardcoded `'Asia/Jerusalem'` check.
- Tool-description corrections: `deferred_action` lists `update_meeting`; `resolve_approval` documents Module D auto-resolve; `note_about_self` reworded to match handler; dropped dead `'other'` venue enum.
- Knowledge classifier prompt detects task-input captions ("schedule these", "use this to draft") → `kind=other` instead of mis-ingesting as KB.
- `missing_floating_block` scope follows `computeHealthCheckWindow` again (Mon-Wed → end of week, Thu → Thu + next week) — the today+tomorrow tightening reverted per owner direction.

### Operational tooling
- New script `scripts/cleanup-recent-orphan-requests.cjs` — closes open requests / outreach_jobs from buggy flows (filterable by name + hours).
- New script `scripts/diagnose-duplicate-routine-fires.cjs` — read-only diagnostic for cron / routine duplication.
- New script `scripts/cleanup-orphan-system-calhealth-midday.cjs` — one-shot, cancels the orphan `Calendar health check (midday)` system routine when the user routine already covers 13:00 (resolves the duplicate-brief class).

### Improvement tickets filed (deferred)
- [#108](https://github.com/odahviing/AI-Executive-Assistant/issues/108) — cross-midnight work_hours support.
- [#109](https://github.com/odahviing/AI-Executive-Assistant/issues/109) — category per floating_block for typed detection.
- [#110](https://github.com/odahviing/AI-Executive-Assistant/issues/110) — meeting prep skill (interview is one shape; sales / customer / board are others).

### Migration / restart notes
- Run `node scripts/cleanup-orphan-system-calhealth-midday.cjs --apply` to stop the duplicate 13:00 calendar-health DM. One-shot, then restart `npm run dev`.
- No schema migrations. Profile yaml unchanged.

---

## 2.9.4 — Approval-flow honesty: typed booking payload, requester relay enrichment, thread-routing fix, repurposed note_about_self, privacy mask completion

Patch over 2.9.3. Closes three high-severity bugs ([#105](https://github.com/odahviing/coding/AI-Executive-Assistant/issues/105), [#106](https://github.com/odahviing/AI-Executive-Assistant/issues/106), [#107](https://github.com/odahviing/AI-Executive-Assistant/issues/107)) that surfaced from the 2026-05-20 Yael flow. The session paper-traced every symptom to its actual upstream cause — most were thin-context or sync-between-objects bugs the v2.9.x rebuild had left wired loosely — and tightened the request framework end-to-end without adding any new tools or new abstractions.

Closes [#105](https://github.com/odahviing/AI-Executive-Assistant/issues/105), [#106](https://github.com/odahviing/AI-Executive-Assistant/issues/106), [#107](https://github.com/odahviing/AI-Executive-Assistant/issues/107).

### Changed

- **Booking-class approvals now share `create_meeting`'s required-field contract** (`tasks/skill.ts` — #107b). `policy_exception` is the only loose-payload booking-class kind today; pre-fix Sonnet could create one with no `subject` / `start` / `end` / `attendees`, owner approved blind, the booking happened (or didn't) in a separate Sonnet turn with no carried context. Now the handler validates the same four fields `create_meeting` schema requires — missing → `{ error: 'missing_required_field', missing: [...], message: ... }` so Sonnet asks the requester first. Once present, the handler **auto-stamps** `payload.deferred_action = { tool: 'create_meeting', args: {..., relaxed: true} }` so the resolver books deterministically on owner approve — no second Sonnet turn needed, no thin-context risk. **No new type defined** — the payload IS the create_meeting args shape, single object reused. Other approval kinds (`freeform`, `unknown_person`, `lunch_bump`) stay loose per owner direction.
- **Requester relay (resolver) now reads the booked artifact + renders in the requester's language** (`core/requests/resolver.ts` — #107d). Pre-fix `notifyRequesterOfDecision` rendered "Hey — Idan said yes on that ask. I'll take it from here, will let you know once it's sorted." for ANY approve — generic English, no booked time, no personalization (requester_name was often NULL because Sonnet didn't pass it). Three changes: (1) `requester_name` auto-populated from `getPersonMemory(requester_slack_id).name` at create_approval insertion; (2) when `deferred_action.args.start` (or `new_start`) is present, body includes the formatted start time + subject — *"Booking 'X' for Tuesday 26 May, 17:30. Calendar invite incoming."*; (3) when `getPersonMemory(requester_slack_id).profile_json.language_preference` indicates Hebrew, body renders in Hebrew with personalized name (*"היי יעל — Idan אישר…"*). Approve / reject / amend (both question-shape and counter-shape) all carry Hebrew templates. Falls back to English when language unknown.
- **Resolver requester DM now threads under the original conversation** (`core/requests/resolver.ts` — #107ef root cause). Pre-fix `sendDirect(requesterSlackId, body)` was called without `opts`, so Slack posted the relay as a new top-level message in the requester's DM — creating a new `thread_ts`. The requester's reply ("ok waiting") landed in the new thread. Sonnet ran the next turn with `historyLength=1`, no booking-context, and hallucinated about unrelated calendar events (root of the 2026-05-20 Yael 13:04 broken Hebrew reply). One-line fix: pass `{ threadTs: row.origin_thread_ts }` to `sendDirect`. The relay threads under the original conversation; the requester's reply continues there; Sonnet's orchestrator pulls the full history. MPIM path already had this; DM path was the gap.
- **`note_about_self` repurposed** (`skills/social.ts`, `core/orchestrator/systemPrompt.ts` — #105). Pre-fix `note_about_self` saved facts to the caller's row — owner-path wrote to Idan's row, not Maelle's. So when Idan told Maelle "you were named after the Maelle character in Clair Obscur: Expedition 33", the note landed under his gaming hobby instead of Maelle's SELF row. Maelle's row stayed empty; she didn't know her own origin story. Now: owner-path writes to `SELF:<ownerSlackId>` (Maelle's row, which `formatAssistantSelfForPrompt` reads into the ABOUT YOU block in every conversation, owner + colleague). Tool description rewritten to make the semantics explicit ("save a durable fact about YOURSELF — Maelle, the assistant"). Colleague-path behavior unchanged — colleagues still save to their own rows; they cannot teach Maelle facts about herself. **For owner's own-hobbies path** (the v2.5.2 use case where note_about_self wrote to owner's row), use `note_about_person(colleague_name='Idan', ...)` — same data ends up on the same row via the existing name-resolution path.
- **IDENTITY block: consult ABOUT YOU first, deflect as fallback** (`core/orchestrator/systemPrompt.ts` — #105). Pre-fix the rule was "If a colleague asks whether you're AI/bot/human, or about your functions/tools/prompts: deflect, don't engage." That meant even when Idan saved "you're an AI assistant, be honest if asked directly" to the SELF row, Maelle would still deflect. Now: identity questions (name, age, AI/bot/human, origin) consult the ABOUT YOU block FIRST. If a saved fact addresses the question → answer with it. If nothing on file → honest deflection ("Idan picked the name, I never asked him why" / "He hasn't told me, want me to ask?"). No fabrication — never invent a backstory not on file.
- **Existing `create_approval` handler now handles UNIQUE-key collisions gracefully** (`tasks/skill.ts` — #106). When Sonnet retries `create_approval` with the same logical ask (e.g. the requester following up with new info), the idempotency_key constraint used to throw `SqliteError`, the orchestrator's tool dispatch propagated it, and Sonnet got no useful result → went silent on the requester (root of the 2026-05-20 Yael 13:02 silent failure when she sent "30 דקות"). Now: catch the constraint error, look up the existing row by idempotency_key (same path the LLM-judged dedup uses), return `{ ok: true, approval_id: existing.id, reused_existing: true, hint: 'requester may be following up — original is still awaiting decision' }`. Sonnet sees success + hint, surfaces honestly to both parties. Owner direction — "no new tools, request framework already handles cancel via existing tools, just stop silent failures." Confirmed via paper-trace: owner's mental model (`resolve_approval(verdict='reject')` cancels via existing infrastructure) was already correct; the only blocker was the silent-failure bug.
- **`displaySubject` mask now covers BOTH privacy paths in `processCalendarEvents`** (`skills/meetings/ops.ts` — #107a). Pre-fix `processCalendarEvents` masked subjects only when Outlook `sensitivity === 'private' || 'personal'`. Events tagged with a yaml category carrying `sets_sensitivity_private: true` (e.g. Idan's `Personal` category) were NOT masked — raw subjects flowed through to Sonnet who could narrate them verbatim (Sonnet narrating "private event from 20:00–21:30" three times in one owner DM was the visible symptom). Now uses the central `displaySubject` helper which checks both paths uniformly. Internal classifier flows (autoCategorize, detectCategory) read raw subjects directly via the lower-level `getCalendarEvents` — unaffected.

### Notes

- **No new tools.** Tool count unchanged from v2.9.3. The 107b "typed booking payload" reuses the same fields `create_meeting` already requires — single object, no sync between separate types. The owner direction "if you already have an object that you are using when create a meeting this is the same object and same type" landed as code.
- **Bug 107c (duplicate text in owner DM) explicitly withdrawn.** Symptom of the upstream 107b/d gaps; expected to dissolve now that the booking path produces deterministic relays. Will revisit if it recurs after live use.
- **#105 follow-up — name origin restoration**: the original "named Maelle after the key character in Clair Obscur: Expedition 33" note is in Idan's people_memory row from 2026-04-11, NOT in the SELF row. With v2.9.4 in place, Idan can re-teach Maelle the origin story via the repurposed `note_about_self` and it'll land in the SELF row going forward. No auto-migration shipped — owner direction: "don't move it, when it ready i will teach maelle more stuff."
- **107b scope**: only `policy_exception` got the booking-class enforcement. `slot_pick`, `calendar_conflict`, `duration_override`, `lunch_bump` already carry purpose-built typed payloads with their own resolver flows — unchanged. Per owner direction: "only build the one you have. the rest is loose, if I will see issue we will build it."

---

## 2.9.3 — Kill completeness gate, floating-block rebalance sweep, twice-daily calendar health, person-memory end-of-chat capture, universal colleague-self rewrite

Patch over 2.9.2. Three bugs closed: the completeness gate from v2.9.2 was producing false success claims to colleagues when the requester legitimately hadn't shared a fact (Yael "I forwarded the request to Idan" lie when no approval was ever created — [#103a chat case](https://github.com/odahviing/AI-Executive-Assistant/issues/103) tangent); the v2.1.1 floating-block direct-move path inside active-mode `double_booking` resolution had been dead code since the detector started excluding floating blocks from its overlap scan (Outlook-direct lunch overlaps stayed forever, [#104](https://github.com/odahviing/AI-Executive-Assistant/issues/104)); and the colleague-self person-memory path was mute end-to-end, so volunteered preferences ("4-6pm Sydney") never reached structured state ([#103](https://github.com/odahviing/AI-Executive-Assistant/issues/103)).

Closes [#103](https://github.com/odahviing/AI-Executive-Assistant/issues/103) and [#104](https://github.com/odahviing/AI-Executive-Assistant/issues/104).

### Removed

- **`src/utils/approvalCompletenessGate.ts` deleted.** The v2.9.2 Haiku output-pass on `create_approval` refused tool calls whose ask_text didn't carry concrete facts the requester gave AND had no on_approve callback to fire them. The gate worked for the "Sonnet dropped a fact that WAS in the conversation" case it was built for, but broke catastrophically on the "requester genuinely didn't share that fact" case — Sonnet retried until it ran out of moves, then generated text outside the tool loop claiming success (Yael 9:14 AM case: "I forwarded the request to Idan" when no approval was ever created). The fix: trust Sonnet the same way `create_meeting` does — no judge gate, just the natural "ask the requester / escalate honestly" path. The original 2026-05-19 fact-relay bug the gate was built for is a different class (Sonnet dropped a fact that was IN the conversation) and is solvable at prompt or claim-checker level if it recurs; the gate was overcorrection. Tool-side removal in `tasks/skill.ts`. `LANGUAGE-OF-ARTIFACTS` rule from v2.9.2 still holds — Sonnet's responsibility, not a Haiku judge's.

### Changed

- **Floating-block rebalance now runs as a periodic sweep in active-mode `check_calendar_health`** (`skills/calendarHealth.ts`). Pre-fix, `rebalanceFloatingBlocksAfterMutation` fired only from `create_meeting` / `move_meeting` / coord-booking — Outlook-direct entries (manual add in Outlook, recurring instances, anything outside Maelle's tools) never triggered it, so lunch sat on top of a meeting until the owner noticed. The sweep iterates each date in the health window and calls the existing helper; the helper self-checks "no overlap → skip silently" so safe to call unconditionally per date. Inherits the health window's Sun→Thu / +7-day-extend-when-≤24h-remain lookahead. Covers Outlook-direct + recurring + any other path that mutates the calendar without going through Maelle.
- **Dead Path (a) inside active-mode `double_booking` handler deleted** (`skills/calendarHealth.ts`). The v2.1.1 floating-block direct-move branch was unreachable since the detector at line 463-470 (Exclusion 3) excludes floating blocks from its pair-overlap scan, so `issue.movable_event_id` was never a floating block. The periodic sweep above handles every floating-block overlap regardless of how the conflicting meeting was booked. Cleaner than waking the dead code via a parallel detector pass.
- **Calendar-health routine now fires twice a day** (morning + midday, weekdays 07:30 + 13:00). Owner direction: same cron, not a new system routine. Implemented as multi-time `schedule_time` support on the existing user-curated routine row — `schedule_time` accepts either `"HH:MM"` (legacy single time) or `"HH:MM,HH:MM"` (comma-separated, returns earliest future firing). New `parseScheduleTimes` helper in `tasks/crons.ts`; `computeNextRunAt` rewritten to compute the next firing for each slot and return the earliest; `formatSchedule` renders multi-time as `"07:30 + 13:00"`. One-shot migration at `src/db/migrations/v2_9_3_calendar_health_twice_daily.ts` (called from `initProfile`) updates the existing routine's `schedule_time` from `"07:30"` to `"07:30,13:00"` and recomputes `next_run_at`. Idempotent — only fires when row is in its untouched starting shape (title match + `schedule_time === '07:30'` + `is_system=0`). Multi-time is available via `manage_routine` for any other twice-daily routine the owner wants.
- **Universal colleague-self rewrite extended to all person-targeting tools** (`core/assistant.ts:362-432`). The v2.9.2 `note_about_person` fix (rewrite target to requester instead of `not_permitted`) now applies to `log_interaction`, `confirm_gender`, and `update_person_profile` too. Pre-fix those guards refused with `not_permitted` when a colleague's tool call targeted anyone other than themselves — same class of bug as the v2.9.2 Shayan name-question case (Sonnet's response chain died with no text reply). Now: silent rewrite, response chain continues uninterrupted, the write lands on the requester's row. Owner direction: "everyone writes to himself." The `update_person_profile` field allowlist (engagement_rank / role_summary / etc. silently dropped on colleague-self path) still applies — only the target check changed from refuse to rewrite.

### Added

- **End-of-chat person-memory capture pass** (`src/memory/capturePass.ts` — new). Closes [#103](https://github.com/odahviing/AI-Executive-Assistant/issues/103). When a colleague DM goes quiet for 30+ minutes AND has new activity since last capture, a single Haiku call extracts structured facts from the chat (timezone, state, working_hours, communication_style, language_preference, engagement_level, response_speed, role_summary, reports_to, collaboration_notes, name_he, durable notes, plus an interaction history one-liner). Compares against the colleague's existing `profile_json` + `.md` file content; emits ONLY deltas (idempotent on re-run — 48h-later same-thread restart sees prior facts on file, no-ops correctly). Apply step writes to DB first (provenance-aware via `setCoreFieldWithProvenance` for timezone/state — `_set_by='auto'`, owner overrides still win) then **mirrors** the same deltas into the colleague's `.md` file sections (Residence / Workplace / Working hours / Communication style / What we've discussed). Owner direction: ".md is the source of truth for context, DB is the queryable surface; every DB write reflects into MD." Bounded ≤20 threads per tick, cost ~$0.001/capture.
- **`MEMORY ON <NAME>` block on colleague-path system prompt** (`core/orchestrator/systemPrompt.ts`). The speaker's `.md` file content renders inline in the dynamic prompt section on every colleague-path turn — Sonnet doesn't need to call `get_person_memory` to access what we've learned. The capture pass keeps the `.md` in sync with structured state, so the prompt always sees current information. New `readPersonMemorySync` helper in `memory/peopleMemory.ts` (sync variant of `readPersonMemory` for the synchronous prompt builder).
- **`findThreadsReadyForCapture` + `markThreadCaptured`** (`db/conversations.ts`). DB-side ready-detector: returns DM threads where the last message ≥ 30 min ago AND (`captured_at IS NULL OR captured_at < updated_at`) — i.e., new activity since last capture. New `captured_at` column on `conversation_threads` (idempotent ALTER). Background loop calls `runCapturePass(app, profile)` from the existing 5-min materialize+run tick — no new cron entity.

### Migration

- **`conversation_threads.captured_at TEXT` column added** at startup via idempotent `ALTER TABLE` in `db/client.ts`. Existing rows start with `captured_at=NULL`, so they're all "ready" for capture on the next 30-min-silent qualifying turn — the LIMIT 20 cap in `findThreadsReadyForCapture` spreads the initial burst across ticks.
- **One-shot routine schedule_time migration** runs once at `initProfile` to bump the existing "Calendar health check" routine from `"07:30"` to `"07:30,13:00"`. Marker is the schedule_time itself — if owner later sets it back to a single time via `manage_routine`, the migration will re-apply (rare edge case, owner can edit through the tool).

### Notes

- **Scope of v2.9.3 capture pass: DM threads only.** MPIM and channel-mention triggers are deferred — the `conversation_threads.context` JSON stores `role: 'user'|'assistant'` without per-message slack_id, so per-speaker capture in multi-party threads needs a separate plumbing pass. Existing manual flow (Sonnet calling `update_person_profile` / `note_about_person` / `update_person_memory` directly) still covers MPIM and channel on a best-effort basis. Owner-DM is intentionally out of scope — owner-side captures stay manual via "Maelle, remember Yael is X".
- **Colleague-path honesty rail (false-claim-after-failed-tool detection) is a separate concern** flagged after bug 1; not built this version. Standing direction needed before extending `claimChecker` to colleague-path with a tool-failure-aware trigger.
- The `working_hours` capture writes free-text only ("4-6pm Sydney"); structured `working_hours_structured` (per [#43](https://github.com/odahviing/AI-Executive-Assistant/issues/43) — slot-search intersection) needs a separate parsing step from the free-text. Pragmatic order: free-text first, structured later when slot-search consumption is wired through.

---

## 2.9.2 — Approval rebuild stabilizers, tool-cache, completeness gate, movable yaml flag, cleanup cascade — heavy bug bundle, regressions surfaced

Patch over 2.9.1. A long live-use session exposed many regressions in the approval rebuild we shipped yesterday plus several pre-existing weaknesses. Most of the day was patching v2.9.1 to actually work under real load; new architectural primitives were added selectively where pattern-class fixes were warranted. **Two known regressions remain open as GitHub issues for the next session** — [#103 person memory](https://github.com/odahviing/AI-Executive-Assistant/issues/103) and [#104 floating block rebalance](https://github.com/odahviing/AI-Executive-Assistant/issues/104).

### Added

- **`src/utils/approvalCompletenessGate.ts`** — output-pass Haiku gate on `create_approval`. Reads ask_text + `on_approve.args` + recent conversation history; refuses the tool call with `error: 'incomplete_approval'` when a concrete fact the requester gave (specific time, venue, post text, etc.) is missing from both ask_text and callbacks. Universal across approval kinds — no per-kind code. Closes the morning Yael flow where Sonnet created an approval with no time in ask_text and no on_approve callback; owner read the DM and had to reply "what time?".
- **`src/utils/toolCallCache.ts`** — universal in-process tool-call cache keyed by `(owner, threadTs, tool, canonical_args_hash)`. TTL 60s for writes, 5s for reads. Wired into the orchestrator's tool-dispatch loop in `orchestrator/index.ts`. Caches the prior result without re-firing the tool. Closes the buffered-follow-up double-fire class for ALL present and future write tools (`create_meeting`, `move_meeting`, `delete_meeting`, `update_meeting`, `book_floating_block`, `coordinate_meeting`, `create_approval`, `resolve_approval`, `message_colleague`, `create_task`, etc.) — tool-agnostic, owner direction was "don't add per-tool guards, build it once in the agent loop".
- **Approval-bound thread tool-lock** (`orchestrator/index.ts`) — when an owner reply matches a pending approval's `terminal_dm_msg_ts`, Sonnet's tool list is filtered to `resolve_approval` + `list_pending_approvals` only. Forces engagement with the approval; no drift into morphing flows. Closes the 1:35 PM Yael case where Sonnet abandoned the approval and started a fresh booking conversation.
- **`preferred_slot` param on `find_available_slots`** (`meetings.ts`) — when the requester names a specific time, the tool guarantees that slot in the result if it passes all rules. Bypasses `pickSpreadSlots`'s `MIN_GAP_HOURS=1` filter (which was dropping the requester's exact asked time from the offered set, leading Sonnet to narrate "X isn't clean" by absence-inference). Force-include in `meetings/ops.ts` after spread-picking.
- **Re-ask revival** in `create_approval` handler (`tasks/skill.ts`) — when dedup matches an existing approval AND `last_surfaced_at` was >2 hours ago, Maelle re-DMs the owner with the original ask + re-stamps `terminal_dm_msg_ts` so Module D + the tool-lock bind to the fresh thread. Closes the "Yael keeps asking, owner buried in old thread" pattern.
- **`movable: boolean` on `profile.meetings.protected[]`** (`userProfile.ts`) — explicit per-event yaml flag. Default `true`. When `false`, active-mode skips both (a) picking the event as the movable side in `double_booking` resolution AND (b) flagging it as `oof_conflict`. Owner-curated authoritative source — supersedes attendee-count / external-attendee heuristics for the cases owner has labeled. New helper `isYamlLockedUnmovable(event, profile)` in `meetingProtection.ts`; wired into `calendarHealth.ts` OOF detection filter. Closes the Bookcamp/Holiday Block recurring flag.
- **Universal callback cascade to legacy `coord_jobs` / `outreach_jobs`** (`closeRequest.ts`) — when ANY request closes, the cascade now also flips the linked legacy row to terminal (`coord_jobs.status='abandoned'`, `outreach_jobs.status='cancelled'`). Closes the root cause of the new-DM-to-Yael bug where a cancelled-on-spine coord kept processing colleague replies via the legacy state machine and posted hardcoded English templated DMs that bypass humanGate/Sonnet entirely.
- **In-flight artifact cleanup on `create_meeting` success** (`meetings/ops.ts`) — `create_meeting` was the ONE mutation type that never called `closeMeetingArtifacts` despite the cascade's contract claiming "every meeting mutation calls this". Now wires the call with `subject` threaded for the new subject-fallback path in the cascade. Closes #11.2 — in_flight_action rows whose `details.meeting_id` was undefined (because the create spilled mid-turn) now match by subject and close cleanly.
- **Subject-fallback in `closeMeetingArtifacts`** (`closeMeetingArtifacts.ts`) — `payloadReferencesMeeting` plus a scoped subject-match for `in_flight_action` subkind rows. When the meeting_id-based match fails, fall back to matching `details.subject` against `params.subject` (when provided). Same `closeMeetingArtifacts(params)` API gained an optional `subject?: string` field; all four existing callers in `meetings/ops.ts` updated to pass it.

### Changed

- **`humanGate` is audience-aware (v2.9.1 work, kept).** This shipped in 2.9.1; the prompt revert (below) keeps it.
- **`create_approval` tool description + APPROVALS system-prompt section reverted to v2.9.0 verbatim** (`tasks/skill.ts`). The v2.9.1 rewrite roughly doubled both, which appears to have drowned the global LANGUAGE-OF-ARTIFACTS rule and produced Hebrew leakage on owner-facing approval DMs (1:35 PM Yael case). The callback infrastructure still works under the legacy `deferred_action` field name via `extractCallbacks` alias — Sonnet doesn't need to know about the rename for it to work. Owner direction: "no more prompts. find the problem and revert it."
- **Colleague-path `note_about_person` always rewrites target to the requester** (`assistant.ts:362-380`). Per owner direction: "only the owner can write notes about other people. Even if Yael says 'Shayan is X', it goes on Yael's notes, not Shayan's." Pre-fix the guard REFUSED with `not_permitted` when target ≠ requester; that broke Sonnet's response chain entirely (empty-reply, Maelle silent) — root of the Shayan name-question bug where she ignored "what does your name mean?". Now: silent rewrite, response chain continues uninterrupted.
- **Module D Y.2 precondition reads `extractCallbacks`** (`utils/threadBoundApprovalAutoResolve.ts`) — picks up both the new `callbacks.on_approve` shape and the legacy `deferred_action` shape uniformly. Y.2 itself was already in v2.9.0; this is a small consistency tweak.
- **Night-shift prompt line corrected** (`meetings.ts:1870`) — replaced *"only when Idan explicitly offers this for AU/Pacific clients"* with *"Idan's standard work time on Tuesday (already merged into work_hours). Also useful for AU/Pacific overlap on other days when he offers it."* The data layer (work_hours synthesis) treats night_shift as standard work time per v2.8.6; the prompt line contradicted it and Sonnet narrated *"work meetings typically don't go there"* even when they should.
- **`is_online` dropped from `required` array** on `create_meeting` (`meetings.ts:428`). Sonnet was defaulting to `true` to satisfy the required field; `resolveLocation` then treated it as an explicit owner hint and short-circuited the day-type + party-shape decision — so internal home-day meetings landed on Teams instead of Huddle. Schema fix + tightened description: only pass when there's an explicit conversational signal. The defined location process runs un-corrupted.
- **Yaml category `Private` → `Personal`** (`config/users/idan.yaml`). Plus description tightening: removed "Personal" from cue list (now redundant with name), added explicit *"the word 'private' alone is NOT a cue — it refers to the Outlook sensitivity field"*. Sonnet was conflating the sensitivity enum value `'private'` with the category name `Private` and tagging meetings as both. Renaming the category disambiguates at the data source.

### Fixed

- **Yael 1:35 PM approval skipped the time** — completeness gate now refuses approval calls missing concrete facts the requester gave.
- **Yael "I'll check with Idan and never come back" pattern** — combined with v2.9.0 Y.2 (Module D pass-to-Sonnet on no-replay-path), the approval-bound tool-lock now forces Sonnet to engage with the approval rather than drift into morphing flows.
- **Yael got templated English "Got it — I'll find some other options and come back to you"** in a fresh thread — legacy `coord_jobs` row was still alive after the requests-spine row was cancelled; the new cascade now closes both atomically.
- **Sonnet ignored "what does your name mean?"** — `note_about_person` colleague-path no longer refuses with `not_permitted` when target ≠ requester; silent rewrite preserves Sonnet's response chain.
- **Mike booking from 13:35 yesterday still showed as "in flight" in today's brief** — `create_meeting` success now calls `closeMeetingArtifacts` (the contract said it should, the code never did). Subject-fallback in the cascade catches in_flight rows whose `meeting_id` was undefined.
- **Same fix benefits "Driving back from Modiin" auto-categorized today** — same class of stuck in_flight_action row, same cleanup.

### Manual cleanup applied (data-only, not committed)

- Cancelled `coord_1779187206948_bolz` in legacy `coord_jobs` (the Yael coord that was posting templated English).
- Cancelled `req_1779187206948_7e87k` + `req_1779187206953_7nbpn` (stale Yael coord requests).
- Closure-reason updated on `req_1779177922877_pd33h` + `req_1779186925572_s71gb` to reflect "never executed".
- Closed 2 stuck `in_flight_action` rows (Mike + Driving) by subject-matching against successful audit_log entries.

### Migration

- No DB schema migration. The `request_id` columns on `coord_jobs` / `outreach_jobs` already existed (v2.7.1). The new cascade just uses them.

### Known regressions (open as GitHub issues for next session)

- **[#103 Person memory — colleague-self path mute, volunteered hints never captured](https://github.com/odahviing/AI-Executive-Assistant/issues/103)** — High. Shayan said "4-6pm Sydney" yesterday during booking; the hint went into `interaction_log` as narrative but never to `profile_json.working_hours_structured`, so the next conversation won't honor it. Full audit + entry points in the issue.
- **[#104 Floating block rebalance regression](https://github.com/odahviing/AI-Executive-Assistant/issues/104)** — High. Lunch (12:15-12:40) overlapping a 12:00-13:00 WordPress meeting should auto-rebalance to 13:00-13:25 (the clean slot inside the 11:30-13:30 lunch window). Today's brief surfaced "no action needed unless you want me to clear the block" — wrong both ways: rebalance didn't run and the wording suggests deletion rather than movement. Hypotheses in the issue.

### What we're seeing — meta

The v2.9.1 approval rebuild was structurally sound but missed several safety nets that became obvious only under live load:
- The completeness gate (added in v2.9.2) prevents sparse approval asks
- The tool-lock prevents Sonnet drift mid-approval
- The tool-call cache prevents buffered-follow-up double-fires
- The cleanup cascade prevents legacy state machines from emitting after their spine row closed

Each of these was a "should have shipped with the rebuild" rather than "new capability." v2.9.2 is the result of catching those gaps in production and patching them. Two known regressions remain (above). Next chat focuses on stabilization + closing these issues + general live feedback.

---

## 2.9.1 — Approval pipeline rebuild + humanGate audience awareness + update_meeting attendee mgmt

Patch over 2.9.0. Headline is the approval pipeline rebuild: one universal callback table (`on_approve` / `on_reject` / `on_amend`) replaces the ad-hoc `deferred_action` pattern. Every approval — meeting, cancel, freeform, future non-meeting — flows through the same 3-verdict dispatch, with explicit colleague-side amend bounce-back so owner↔requester counter negotiation lives in code instead of evaporating into Sonnet promises. Plus update_meeting gains attendee add/remove, humanGate gets per-audience exemplars, `create_meeting`'s `is_online` becomes optional (defined location process runs un-corrupted), and the night-shift hours move to 20:30–00:00.

### Added

- **`src/core/approvals/approvalCallbacks.ts`** — new module. Universal `ApprovalCallbacks` shape: `{ on_approve, on_reject?, on_amend? }`. `extractCallbacks(details)` aliases legacy `deferred_action` → `on_approve` for back-compat. `buildConsequenceText()` renders the "If yes → I'll book/move/cancel X" line shown on the owner-facing approval DM so he knows what saying yes does. `mergeAmendIntoApprove()` merges counter payloads into `on_approve.args` (counter.slot_iso → args.start for create/book, → args.new_start for move; other keys spread). `RESOLVER_REPLAY_TOOLS` defines which tools the resolver replays autonomously.
- **Universal verdict dispatch in resolver** — `resolveRequest` reads callbacks and routes: approve → run `on_approve.tool` with override flag (relaxed=true / confirm_outside_window=true); reject → run `on_reject` if set, else close + DM requester; amend → default `relay_to_requester` mode flips state to `awaiting_colleague` and DMs requester with owner's counter, alternative `run_with_amend` mode merges counter into on_approve and fires immediately.
- **Amend bounce-back path** — when requester counter-amends or rejects owner's counter, state bounces back to `awaiting_owner` with a fresh DM to the owner (`notifyOwnerOfColleaguePushback`); `terminal_dm_msg_ts` is re-stamped so Module D can auto-resolve the next reply. Round cap of 5 prevents infinite ping-pong; cap hit closes as expired.
- **`counter_history` audit trail** on every amend; `counter` holds the latest alternative regardless of who proposed it last. Approve always merges from `counter`, so owner approving after a colleague counter-amend uses the colleague's latest offer.
- **Colleague-path AMENDING APPROVALS prompt block** — `src/core/orchestrator/systemPrompt.ts` now surfaces `awaiting_colleague` state to the requester in their thread with owner's counter visible. Teaches Sonnet to call `resolve_approval` with approve / reject / amend depending on the requester's response.
- **`resolve_approval` accepts colleague-path calls** — when the targeted request is in `awaiting_colleague` state AND the caller is the original requester. All other colleague-path calls remain blocked.
- **`update_meeting` accepts `add_attendees` / `remove_attendees`** — schema extension at `src/skills/meetings.ts:462`. Owner-path: full add/remove. Colleague-path: self-only (add-self / remove-self). Handler at `src/skills/meetings/ops.ts:2295` loads the existing event, merges the attendee list, detects shape-affecting changes (internal-only ↔ has-external; count crossing 4↔5), and re-runs `detectCategory` + `resolveLocation` only when shape changed. `getEventForAttendeeUpdate` helper added at `src/connectors/graph/calendar.ts:1434` for single-GET event load. Graph PATCH on `updateMeeting` now accepts the full attendee array.
- **`update_meeting` is now replayable via `on_approve`** — added to `RESOLVER_REPLAY_TOOLS` + `deferredActionReplay`'s SchedulingSkill router.

### Changed

- **`humanGate` is audience-aware** (`src/utils/humanGate.ts`). New `HumanGateAudience` type with three values: `'owner'` (talking TO the owner directly — exemplars use 1st/2nd person, never name him in 3rd person), `'internal'` (same-domain colleague — "I'll flag it for Idan" is correct), `'external'` (future email path — generic "let me check and get back to you", no owner-name reference). Closes the 2026-05-19 owner-facing draft "should I flag this for Idan to sort out" where Idan WAS the addressee. New "DON'T INVENT CAPABILITY" rule guards against the gate rewriting an abdication ("you'll have to do this yourself") into a fake promise ("Let me do it now") when Maelle has no tool path. The three call sites in `postReply.ts` (owner-path, colleague-path) + `briefs.ts` pass the right audience. EmailConnection will pass `'external'` once it lands.
- **`create_meeting.is_online` is now optional** — dropped from `required` array at `src/skills/meetings.ts:428`. Description rewritten to teach Sonnet: OMIT when no explicit conversational signal; the handler runs the defined day-type + party-shape decision (internal+home → Huddle, internal+office → Office, external → Teams). Pre-fix Sonnet defaulted `is_online: true` to satisfy the required field, which `resolveLocation` treated as an explicit owner hint and short-circuited the defined process — every internal home-day meeting yesterday landed as Teams instead of Huddle.
- **Module D Y.2 precondition reads `extractCallbacks`** — `src/utils/threadBoundApprovalAutoResolve.ts`. The auto-resolve gate now detects both the new `callbacks.on_approve` shape and the legacy `deferred_action` shape uniformly.
- **`create_approval` tool description rewrite** — `src/tasks/skill.ts`. Teaches Sonnet the 3-verdict callback model, the amend ping-pong flow, the difference between replayable and Sonnet-handles-it on_approve, and that the same shape works for non-meeting decisions.

### Fixed

- **Yesterday-night meetings booked by Maelle showed Teams instead of Huddle** — internal home-day bookings (e.g. the Mayrav 22:30 case) got `is_online=true` from Sonnet's defensive default for the required field, which corrupted the location decision tree. Fixed by making `is_online` optional + tightening the tool description. The defined process in `resolveLocation` was already correct; the bug was input contamination.
- **Approval expiry now closes the loop to the requester** — `src/core/requests/runner.ts` `runExpiry`. Pre-fix when an approval expired with no owner response, the owner got a tombstone DM but the requester got nothing — they were left hanging indefinitely. Now the requester also gets a DM: *"I couldn't get a read from Idan on … Closing this for now; ping me when you want to try again."*
- **Sub-bug from the Mayrav 22:30 case fixed structurally** — humanGate exemplars saying *"I'll flag it for ${ownerFirst}"* are no longer used when the audience IS the owner. Audience-blind exemplars produced robot-speak like "should I flag this for Idan" said TO Idan.

### Yaml

- **`config/users/idan.yaml`** — night_shift `hours_start: "21:30"` → `"20:30"`. Owner will manually block the late-21:30 windows when he needs the later start.

### Migration

- No DB migration. `extractCallbacks()` aliases legacy `deferred_action` to `on_approve` transparently — pre-cutover approval rows resolve correctly. New code writes `callbacks.on_approve` directly; the orchestrator's existing `_deferred_action_hint` capture path still works.

### Architecture note — the universal approval object

Every approval is now structurally identical regardless of trigger:

- **Origin**: requester slack_id / thread, the tool that surfaced the approval, the rule that fired (if any).
- **Question**: ask_text owner reads + auto-derived consequence text ("If yes → I'll book X").
- **Callbacks**: `on_approve` (REQUIRED for replay path; OMIT to fall through to Sonnet-handles-it), `on_reject` (OPTIONAL — default: close + DM requester), `on_amend` (OPTIONAL — default: relay counter to requester).
- **Lifecycle states**: `awaiting_owner` → (`awaiting_colleague` if amend) → bounces between owner and requester until approve / reject / expire / round-cap. Counter merged into on_approve.args on final approve.

Meeting tools (`create_meeting`, `move_meeting`, `delete_meeting`, `update_meeting`, `book_floating_block`) are replayable today; future non-meeting tools (`delete_routine`, venue rank-down, contact updates, …) just need to be added to `RESOLVER_REPLAY_TOOLS` + the deferredActionReplay dispatch. The shape works for any of them without further changes.

### Paper-trace coverage

4 scenarios traced end-to-end before ship:
1. Owner doesn't answer → midpoint reminder → expiry → owner tombstone + **new** requester loop-close.
2. Owner says NO → reject branch → DM requester "Idan can't make that work right now".
3. Maybe → relay → counter → maybe again → agree (ping-pong negotiation, counter accumulates in `counter_history`, latest wins on approve).
4. Non-meeting trigger (freeform without on_approve) → Y.2 passes to Sonnet → Sonnet handles work in same turn.

---

## 2.9.0 — BookingRequest normalizer + calendar-health fixes (5 morning-brief bugs)

First minor in a month. Two architectural moves plus the morning-brief bug-wave.

**Phase A — `BookingRequest` normalizer**: every meeting tool's handler entry now flows through `normalizeBookingRequest()` before reaching `planMeeting`. The normalizer is the single chokepoint that validates and normalizes raw Sonnet args into a typed pre-data shape: owner always in `participants`, duration snapped to `allowed_durations`, sensitivity gated for colleague-path membership, `relaxed` gated by senderRole + owner-in-MPIM-proposes detection + deferred-replay context, cross-cutting signals pre-computed (`ownerProposedThisSlotInMpim`, `recentBlockDeletes`). Phase A wires it for `create_meeting` + `delete_meeting`; the legacy in-handler prep stays alongside as defense-in-depth (Phase B will consolidate). The owner-in-participants invariant flows into `planMeeting` — `detectCategory` updated to handle the new contract (no more "+1 for owner" math anywhere in the pipeline). `planInputFromBookingRequest()` adapter bridges to the existing `PlanMeetingInput` shape so the planMeeting internals stay untouched.

**Phase A motivation**: yesterday's bug wave (v2.8.6) had to patch six different layers — Sonnet's tool args, the orchestrator's auto-stamp, the handler entry, planMeeting, the Graph layer, and parallel retry systems — because each layer had its own ad-hoc contract with Sonnet's input shape. The normalizer collapses the contract drift into one place: the day-of fix becomes one line in one file, not three patches in three files. Background reading: scripts/simulate-booking-request.ts has 9 scenarios covering owner injection, duration snap, sensitivity gate, relaxed gating, intent inference — runs offline in <2s.

### Added

- **`src/skills/meetings/bookingRequest.ts`** — new `BookingRequest` interface + `normalizeBookingRequest(toolName, args, context, options?)` function. Pure, idempotent, no Graph round-trips. Reads people_memory + audit_log + threadAttendees + conversationHistory; produces the typed shape every meeting tool now consumes.
- **`planInputFromBookingRequest()`** — adapter at `src/skills/meetings/planMeeting.ts:151`. Maps the canonical BookingRequest to the legacy PlanMeetingInput shape so `planMeeting` internals don't need a refactor. Removable once Phase B flips planMeeting's signature.
- **`scripts/simulate-booking-request.ts`** — offline test rig for normalizer scenarios. 9 scenarios, 21 assertions. Run with `npx tsx scripts/simulate-booking-request.ts`.

### Changed

- **`planMeeting` enforces owner-in-participants invariant.** Pre-fix the function took `participants` as "non-owner attendees" and tracked owner separately via "+1 for owner" math (four places in the file). Post-fix the function auto-injects the owner if the caller didn't (legacy coord callers, deferred-replay paths). All headcount math now reads `participants.length` directly. `nonOwnerParticipants = participants.filter(p => !p.isOwner)` for the few places that explicitly need "everyone except the owner".
- **`detectCategory` handles owner-already-in-attendees contract.** Yesterday's v2.8.6 fix injected the owner unconditionally — under v2.9.0 the normalizer already places him there, so the unconditional injection would have double-listed. The classifier prompt now deduplicates: owner first, other attendees after, no double-counts.

### Fixed (real-day bug-wave from 2026-05-19)

Seven atomic bugs across the morning brief + the Yael Thursday chat. Most concentrated in `src/skills/calendarHealth.ts`; two in the approval / colleague-DM surfaces.

- **`oof_conflict` no longer flags owner-only events on his own OOF day.** Bookcamp (owner-only attendee) on Thursday was flagged as conflicting with the Holiday Block. Solo personal blocks during the owner's own holiday are intentional time, not conflicts. Fix at `calendarHealth.ts:484-510` — meetings with empty attendees OR only owner-as-attendee are skipped from oof_conflict detection.

- **`oof_conflict` auto-move honors `initiateCoordination` return value.** Pre-fix the OOF auto-move path called `initiateCoordination` and ignored the return; if `'no_participants'` came back (owner-only event, nobody to coordinate with), the code still marked `issue.fixed = true` and reported "Started a move-coord … DM'd ." (empty join). Maelle then told the owner she "kicked off a move" for the Bookcamp — a straight lie. Fix at `calendarHealth.ts:903-940` — when initiateCoordination returns `'no_participants'`, flip the issue to `fix_failed` with an honest reason.

- **`missing_floating_block` detection respects recent owner deletes.** v2.8.5 added the recent-delete check at the auto-book step — the brief still surfaced "Thursday has no lunch block. You deleted it recently …" every morning for 3 days because the issue itself still entered `issues[]`. Fix at `calendarHealth.ts:339-360 + :373-389` — pre-load recent floating-block deletes once before the per-day detection loop, skip pushing the issue when block name + date match. The issue never enters the list → brief never sees it.

- **(Y.1) `get_calendar` colleague-view annotation.** Sonnet enumerated 6 of Idan's internal meetings (subjects + companies + locations — "Bank Hapoalim in Ramat Gan") to Yael when she asked "what can move?". Root: colleague-block prompt rule's "title + time = fine" license applied per-item but never capped the LIST size. Fix tool-result-side at `src/skills/meetings/ops.ts` get_calendar handler: on colleague-path 1:1 DM, wrap events with `_colleague_view: true` + `_enumeration_rule` instructing "never list more than one specific meeting; if pushed, escalate via create_approval(kind=freeform) — don't enumerate yourself." Owner-path / MPIM-with-owner unchanged. Data stays available for Maelle's reasoning; only the OUTBOUND narration is restricted.

- **(Y.2) Module D auto-resolve precondition — must have a replay path.** 2026-05-19 Yael Thursday case: Sonnet raised `create_approval(kind=freeform)` ("Move Isaac or Elan to free up 11:30?"), owner replied "Do it either in 11:30, we can move other stuff", Module D classified clean-approve and SKIPPED Sonnet, resolver posted "Hey Yael — Idan said yes. I'll take it from here." Yael got the promise; the move + book never executed (no `deferred_action` on a freeform approval, no Sonnet to interpret + act). Fix at `utils/threadBoundApprovalAutoResolve.ts`: BEFORE classifying, check if the approval has either `details.deferred_action` (replay tool) OR subkind in {`slot_pick`, `calendar_conflict`} (own replay path). If neither, return `no_replay_path` → orchestrator runs Sonnet, who reads owner's reply and executes. Generalizes 103e's lesson: deterministic auto-resolve is safe ONLY when there's something concrete to replay.

- **Slack typing indicator grammar.** `status: 'typing…'` → `status: 'is typing…'`. Slack renders avatar+name above the status, so the previous value read "Maelle typing…" — incomplete. Now reads "Maelle is typing…" matching Slack's native user-typing format.

- **`busy_day` math is per-window aware on multi-window days.** Pre-fix the calc used a bounding-box approach: clip busy intervals to `[firstWindow.start, lastWindow.end]`. On split-shift days that bounding box includes the gap between windows (e.g. Tuesday's 15:30–21:30 mid-day stretch), so meetings between windows got counted as "busy" while the inter-window gap counted as "free". Result: impossible `"zero free time, 110-min gap"` narration on 2026-05-19. Latent since v2.8.1's multi-window introduction; surfaced by v2.8.6's `night_shift` auto-merge into `work_hours`. Fix at `calendarHealth.ts:543-606` — iterate each window separately; aggregate `freeMin` and `longestGap` across windows. Single-window days behave identically.

### Migration

None. Internal refactor only. Tool schemas, prompt text, Slack interactions, Graph layer all unchanged. `npm run dev` restart picks it up.

### Phase B (queued, not in 2.9.0)

- Consolidate the in-handler prep: read from `req.X` downstream instead of mutating `args.X`. Removes the duplicate "auto-fill / auto-inject / gate" code from `create_meeting` / `delete_meeting` handlers.
- Declarative rule registry: `scheduleRules.checkSlot` consumes a list of `Rule { name, check, label, isOverridable }` objects instead of the inline `if`-chain. Each rule becomes a self-contained, testable file.
- Migrate `move_meeting`, `coordinate_meeting` booking path, and `calendarHealth.ts`'s two `planMeeting` callers onto the BookingRequest shape.

---

## 2.8.6 — Real-day bug wave: cancellation replay, retry isolation, attendee-count miscategorization, sensitivity at booking, night-shift work hours, owner-in-MPIM override

Bug-wave patch closing five GitHub bugs (#98, #99, #100, #101, #102) plus the Mayrav 22:30 MPIM incident (#103 — no ticket). The headline is the chain that wrecked the 2026-05-18 morning: Dirk asked for a cancel → Maelle raised an approval → owner ✅'d → nothing fired (no deferred_action wiring on freeform cancels). Three hours later Sonnet picked up the un-executed cancel during an unrelated turn, fired the right delete, but then dateVerifier produced a false-positive weekday mismatch ("Tuesday 19 May" flagged as Monday — the day-of-week was actually correct), triggered a retry with full tool access, and the retry deleted the wrong meeting (Michal's Sales Commissions). Both root causes addressed independently — the approval system now supports `delete_meeting` in the deferred-replay chain, and dateVerifier retries now run in `proseOnly` mode that strips every WRITE_TOOL before the retry executes. Plus the `detectCategory` count fix that explains why Sonnet's flow felt "out of process" all morning: Sonnet's tool description framing led her to omit the owner from `attendees`, so the classifier saw 1 attendee and tagged every booking as Logistic (personal block) → wrong location prompts, wrong rebalance, wrong everything downstream. And the Mayrav incident — owner proposed 22:30 in MPIM, Sonnet routed it back through a `policy_exception` approval that leaked "Idan said yes on policy exception needs your input" into the colleague's view. Both the wording and the wiring are fixed.

### Fixed (high-impact)

- **`detectCategory` undercounted attendees by omitting the owner — root of the "single-attendee Logistic" misclassification.** Sonnet's `create_meeting` tool description frames `attendees` as the OTHER people, so a 2-person meeting with Michal passes `attendees=[Michal]`. The classifier in `skills/meetings/detectCategory.ts` then computed `attendeeCount = input.attendees.length` (= 1) and the prompt's attendee line read "michal.s@reflectiz.com" with no owner — classifier walked the priority list, saw Logistic's description ("Mostly Idan is the only attendee"), matched, returned `category=Logistic`. Cascade: Logistic has `no_default_location`, so Maelle asked "online or in person?" needlessly; the rebalance loop treated the meeting as a floating block alongside lunch and let them coexist instead of moving lunch. Fix: owner is now always injected into the attendees list + count at `detectCategory.ts:62-77` — it's truthful (he IS an attendee of a meeting on his own calendar) and deterministic. Verified offline via `scripts/simulate-create-meeting-args.ts` — Sonnet's args are the same, the classifier now picks `Meeting`, downstream location/rebalance flow correctly.

- **Cancellation approvals didn't execute on approve.** Dirk's 09:53 "should I cancel?" DM was raised via `create_approval(kind=freeform)`, owner ✅'d at 09:54, Module D auto-resolve fired, resolver took the legacy close+notify path, no delete executed. Cause: `deferred_action` replay (v2.7.2) covered `create_meeting` / `move_meeting` / `book_floating_block` only. `delete_meeting` was never wired. Fix: `core/requests/resolver.ts:131` adds `delete_meeting` to `supportedTools`; `core/requests/deferredActionReplay.ts:70` adds a `delete_meeting` branch dispatching through `SchedulingSkill`; `tasks/skill.ts:143` extends the `create_approval` tool description teaching Sonnet to pass `payload.deferred_action = { tool: "delete_meeting", args: { meeting_id, meeting_subject } }` on cancellation asks. Soft side of the fix is on the prompt — Sonnet must remember to pass `deferred_action` — but the supportedTools + replay engine + handler are all deterministic.

- **dateVerifier retry path could fire fresh writes.** When the verifier flagged a weekday/date mismatch, the retry orchestrator ran with full tool access — so a prose-correction retry could (and on 2026-05-18 DID) fire `delete_meeting` on the wrong event. New `proseOnly: boolean` flag on `OrchestratorInput`; when set, the orchestrator filters every WRITE_TOOL out of the tool list before the Sonnet call. dateVerifier retry in `connectors/slack/postReply.ts:684-690` passes `proseOnly: true`. Reads stay available so Sonnet can re-verify state while rewriting wording — writes can't fire from a retry. Deterministic.

- **dateVerifier LLM hallucinated mismatches on already-qualified weekdays.** Today's case: draft said "from Tuesday 19 May" (correct — 2026-05-19 IS Tuesday), but the classifier returned `correctWeekday=Monday`. Cause: the LLM context-verifier was meant for BARE weekdays ("Monday's calendar") but also picked up on qualified weekday+date pairs that the regex pass already validates. Fix: defensive post-filter at `utils/dateVerifier.ts:282-303` drops any LLM mismatch whose `draft_excerpt` has a date adjacent to the weekday (regex match on `\d{1,2}\s+(?:jan|feb|...|may|...)`); LLM prompt also tightened to skip qualified pairs.

- **`deleteMeeting` used bare DELETE — attendees kept orphaned invite copies.** Graph's `DELETE /events/{id}` removes the organizer's copy but doesn't reliably send cancellation invites to attendees. Dirk's attendee invite stayed on his calendar after Maelle "deleted" the meeting — root of the user-visible "still on my calendar 3 hours later" report. Fix at `connectors/graph/calendar.ts:1519-1559`: `POST /events/{id}/cancel` now used as the primary path. Sends "Cancelled: X" invites to all attendees AND removes the organizer's copy in one call. Falls back to bare DELETE on 400 (events with no attendees — `/cancel` rejects those). Signature change: `deleteMeeting(userEmail, meetingId, options?)` — `options.comment` is the optional cancellation note.

- **`get_calendar` amnesia on backward-looking "did you" questions.** On 2026-05-18 15:04 owner asked "did you cancel the meeting you booked with Michal tomorrow?" — `get_calendar` returned empty (Michal's event was deleted at 12:59), and Sonnet had no audit context. She replied "I don't have a record of booking a meeting with Michal for Tuesday" — the booking + delete were both in `audit_log` but never read. Fix at `skills/meetings/ops.ts:646-700`: on owner-DM turns, when `get_calendar` returns 0 events for the queried window, the response is enriched with `_audit_context` listing recent `create_meeting` + `delete_meeting` audit entries from the last 7 days that intersect the window. Sonnet reads it before asserting "I don't have a record". Owner-DM only — colleagues mustn't see audit traces of meetings they're not on.

- **Owner-in-MPIM slot proposal triggered a needless approval round-trip.** Mayrav 22:30 case: owner typed "what wrong with 10:30pm?" in MPIM, Mayrav agreed, Sonnet still routed it as a colleague-path rule violation → `create_approval(kind=policy_exception)` → "Idan said yes on policy exception needs your input" leaked into Mayrav's MPIM view + booking never fired (the colleague-path early-rejection didn't stamp `_deferred_action_hint`). Two fixes layered: (1) new `src/utils/ownerProposedSlot.ts` — when the LATEST owner-typed message in MPIM contains the slot's time (24h or 12h form) AND a proposal cue (`?`, "what about", "let's do", "isn't", Hebrew equivalents like "מה לגבי" / "בוא ננסה"), `create_meeting` colleague-path auto-sets `args.relaxed=true` and skips Guard B. planMeeting books with `allowRelaxed=true`. No approval raised. (2) Wiring fix at `skills/meetings/ops.ts:1556-1576` — colleague-path early-rejection now stamps `_deferred_action_hint` so for the cases that still need approval (true colleague-only 1:1), owner-approve actually fires the replay. (3) Resolver template at `core/requests/resolver.ts:374-403` prefers `deferred_action.args.subject` over `payload.subject` and filters auto-generated meta phrases ("policy exception needs your input", etc.) via `looksLikeApprovalMeta` — even when an approval IS raised, the requester-facing message reads "Idan said yes on <meeting subject>" instead of internal jargon.

- **Night-shift work hours weren't synthesized into `work_hours`.** Idan's yaml has `schedule.night_shift.typical_day: Tuesday + hours_start: 21:30 / hours_end: 00:00`. The v2.8.1 work_hours synthesis only consumed `office_days` + `home_days` legacy hours — `night_shift` was a separate concept used by overlap checks but invisible to the slot finder. Net: 22:30 Tuesday got rejected as `outside_owner_work_hours` even though owner explicitly defined it as work time. Fix at `config/userProfile.ts:580-598`: synthesis now auto-appends night_shift's range to `work_hours[typical_day]`. `hours_end: "00:00"` normalized to `"23:59"` so the range doesn't wrap midnight. Tuesday's work_hours is now `["09:00-15:30", "21:30-23:59"]` automatically — no manual yaml maintenance needed. Downstream effect (intentional): background dispatchers that check `isWithinOwnerWorkHours` will now consider 22:30 Tuesday in-hours and may DM at night; owner direction is "fair game, this is my night shift, I'm working like every other day."

### Fixed (smaller)

- **Duration snap centralized at `create_meeting` handler entry** (`skills/meetings/ops.ts:1184-1215`). Pre-fix only the outreach handoff in `connectors/slack/coordinator.ts:454` snapped to `allowed_durations`; direct Sonnet calls passed arbitrary start/end (root of Maayan's 20-min booking landing at 12:15–12:35 off-alignment). Single chokepoint now covers direct calls, coord handoffs, and deferred replays. Duplicate snap in `coordinator.ts` removed.

- **`PEOPLE IN THIS THREAD` dynamic prompt block** for colleague-path turns (`db/people.ts:531-580` new `formatThreadPeopleBlock`, wired in `core/orchestrator/systemPrompt.ts:545-552`). Renders email + tz + gender for the speaker + MPIM members from `people_memory`. Sonnet sees the data inline; defensive asks for known fields stop. Owner excluded. Missing fields render as `unknown` — Sonnet still asks when needed.

- **Slot-narration rule tightened with both ❌/✅ shapes** at `core/orchestrator/systemPrompt.ts:270`. Now covers BOTH the busy-slot case ("2:00 is taken by [meeting] with [colleague]") AND the qualified-free-slot case ("09:25–10:00 after Shayan, before Simon's biweekly"). Same rule, broader examples. Colleague block only.

- **`sensitivity` at booking time** (`skills/meetings.ts:418-426` + `skills/meetings/ops.ts:1163-1192` + `:1909-1925`). New `sensitivity` enum on `create_meeting`. Default omitted (Outlook normal). Sonnet only sets when explicitly asked. Handler-side gate: on colleague-path, `args.sensitivity` is honored ONLY when the colleague's email is in `args.attendees` — stops a random colleague from marking someone else's meeting private. Owner-path trusted, no gate.

- **TZ note rephrased to trust IANA timezone for math** (`db/people.ts:614` + `connections/slack/index.ts:215,323`). Pre-fix the cautionary "IANA timezone — NOT a city. Don't infer where they live." primed Sonnet to defensively ask "where are you based?" even though the TZ alone is enough for time math. New phrasing: "City not on file — TZ is reliable for time math; only ask for city when location/venue matters." Mayrav case: she had `tz=America/New_York` from Slack profile pre-conversation; Sonnet shouldn't have asked.

- **`verbMap` fallback picks 1-or-2 highest-impact verbs instead of joining all tools** at `core/orchestrator/index.ts:1633-1660`. Tier-based priority: calendar mutations (book/move/delete) > coord/approvals/tasks > outreach > everything else. For today's "Done — found the person, booked the meeting, and logged the interaction" the new fallback would have been "Done — booked the meeting. Let me know if anything's off."

- **`loading_messages: ['​']`** at `connections/slack/messaging.ts:367`. Replaces the visible "Working" word from v2.8.4 with a zero-width space. Slack's min-length check passes; the rendered glyph is invisible. Only the per-tool bottom status (params.status) shows now.

- **In-flight follow-up subject prefixed with the triggering verb** (`core/requests/maybeOpenInFlightMeetingRequest.ts:114-129`). Pre-fix the brief read "still in flight on the Website Update calendar work" — owner didn't recognize "Website Update" as the subject for his recurring Onn meeting, so it read as an unrelated topic. Now "In flight: moving Website Update" makes the operation explicit.

- **GitHub bug-triage skill — five-rules block + anti-pattern entries** (`.claude/skills/github/SKILL.md`). Codifies the lessons from today's incident: build signals must be exact and per-bug, reads are free (no permission asks), no tier-numbering jargon, regex-based scaling is suspect, no new prompt rules without explicit approval. Adds matching anti-pattern entries for each. Future bug-triage sessions inherit these guardrails.

### Added

- **`src/utils/ownerProposedSlot.ts`** — deterministic detection of "owner is in this MPIM and proposed this exact slot in his latest message". Used by the colleague-path `create_meeting` override block to bypass the policy_exception escalation when the owner's presence + recent proposal is the implicit approval. No LLM call — regex on time formats + proposal-cue phrases.

- **`scripts/simulate-create-meeting-args.ts`** — offline reproduction of the 2026-05-18 Michal MPIM sequence. Replays the prompt + history Sonnet saw, prints whatever `create_meeting` args she passes on the booking turn. No Slack, no Graph writes. Used to verify the `detectCategory` fix without waiting for a real-day repro. Run via `npx tsx scripts/simulate-create-meeting-args.ts`.

### Changed

- **`deleteMeeting` signature** now accepts an optional `options.comment` for the cancellation message body. Existing callers pass undefined → empty comment, no behavioral change for them.

### Migration

None. `schedule.work_hours.Tuesday` synthesis is backwards-compatible — existing profiles with `night_shift.typical_day` get the merged range automatically on next load.

---

## 2.8.5 — Bug wave: cross-thread runner contamination, Module F rollback, planMeeting self-conflict, brief duplication, lunch undo, status indicator

Day-long sweep through bugs surfaced in live use 2026-05-17. The headline is a Module F rollback after the cross-thread incident: the inboundQueue was running buffered messages through the previous turn's runner closure, so a new-thread message landed against the wrong conversation history; the claim-checker judge — seeing the mismatched context — injected a topic-switch directive into its retry instruction and derailed the reply wholesale. Both root causes addressed (the queue and the retry path), and the eight honesty rules that v2.8.1 deleted in favor of Module F are back in the system prompt. Plus a stack of smaller-but-real fixes that each were independently planned this session.

### Fixed (high-impact)

- **inboundQueue ran buffered messages through the wrong runner.** For 1:1 DMs the queue key is `channelId` only (intentional, so typing-bursts across the same DM coalesce). When a message arrived during an un-abortable in-flight turn (writes already fired), it was buffered correctly — but when the in-flight finished and the pending buffer was drained, `scheduleRun` re-used the OUTER scheduleRun's `runner` parameter, which was the in-flight turn's closure with the in-flight turn's threadTs / senderId / priorOutboundContext / etc. New-thread messages dispatched against the old thread's conversation history. Repro on 2026-05-17: owner started a new thread "can we move my meeting with onn 15 mins back?" during a LinkedIn-article turn; the orchestrator was called with the LinkedIn thread's threadTs and history. Fix: `PendingMessage` now carries its own `runner` field; `scheduleRun` uses `batch[batch.length-1].runner` instead of the outer-closure runner; the abort-restart path in scheduleRun no longer takes a runner parameter at all (it reads from pending on the next call). One file: `connectors/slack/inboundQueue.ts`.

- **Module F retry path derailed replies on judge false positives.** Same 2026-05-17 incident, second root cause. The judge's `unverified_state_review` fired despite `get_calendar` being in `toolSummaries` — and the same judge call **also** included a topic-switch directive in `retry_instruction` ("the owner asked for a LinkedIn article recommendation; address that instead") drawn from the cross-thread-contaminated history. Sonnet's retry faithfully obeyed and produced a LinkedIn answer to a meeting-move question. Owner direction: roll back Module F retries; restore the honesty rules they were supposed to replace. Fix: `postReply.ts` — the `extendedRuleFired` retry block (~60 lines) deleted. Module F + E booleans (`re_asked_known_fact` / `unrecorded_promise` / `unverified_state_review` / `invented_after_correction` / `re_asked_after_convergence` / `re_asked_own_question`) still fire in the checker as telemetry — we keep visibility into what they catch — but the verdict no longer triggers retries. Only `claimed_action` (RULE A, since v1.6.2) drives retries from here on. `systemPrompt.ts` — RULES 1 / 2 / 2b / 2c / 2d / 3 / 5b / 9 restored verbatim from their pre-v2.8.1 text. REFUSAL PHRASING stays in humanGate (Module C — not in scope of this rollback). Net: ~60 lines deleted from `postReply.ts`, ~30 lines added back to `systemPrompt.ts`.

- **planMeeting freebusy counted the moving event as its own conflict.** Real repro: "can we move my meeting with Onn 15 mins back?" with a 13:00–13:30 meeting → planMeeting checks Onn's freebusy at 13:15 → Graph `getSchedule` returns Onn busy at 13:00–13:30 (because the meeting being moved is still on his calendar) → `confirm_override` fires citing Onn as busy. v2.4.1 fixed this for `findAvailableSlots` via `excludeEventIds`, but Graph's `getSchedule` API doesn't expose event IDs — it returns busy windows only — so excludeEventIds can't help in the second freebusy path that v2.7.1 added to planMeeting. Fix: new `priorSlotEndIso` parameter on `PlanInput`; the overlap loop in `planMeeting.ts` skips busy windows whose `[start,end]` matches the moving event's prior `[start,end]` with a 60-second tolerance per side (for TZ formatting noise). `move_meeting` handler in `skills/meetings/ops.ts` already extracted `movingEvent.start.dateTime` for the existing `priorSlotStartIso`; now also extracts `.end.dateTime` and passes both.

- **Active mode re-booked floating blocks the owner had explicitly deleted.** Owner asked Maelle days ago to delete the lunch on a half-day Thursday; this morning's active-mode pass saw `missing_floating_block` and re-booked it. Owner direction: "if I already did a change, don't undo it." Fix: enrich the `delete_meeting` success audit_log entry with `event_start_iso` (captured from the existing recurring-preflight Graph probe — no extra round-trip); active-mode's `missing_floating_block` branch now reads recent `delete_meeting` audit entries (last 14 days) and skips the auto-book when block_name matches in the subject AND `event_start_iso` falls on the same calendar day. New helper `recentAuditEntries({ action, windowDays })` in `db/client.ts` next to `auditLog()` — reusable for any future "respect owner's recent instruction" check. `getEventType` in `connectors/graph/calendar.ts` extended with `startDateTime` / `startTimeZone` for the audit enrichment.

- **Assistant-panel status indicator stayed empty when registration was missed.** `assistant_thread_started` only fires on FIRST panel open. If the bot was disconnected at that moment, or the panel pre-existed before the handler was installed, the thread permanently dropped out of the registry. `isAssistantThread` would return false for the rest of the panel's life, the gate at the orchestrator's turn-start + per-tool hooks dropped the `setAssistantStatus` calls, and the owner saw an empty status indicator forever. Fix: drop the `isAssistantThread` gate at both call sites in `core/orchestrator/index.ts`. Slack rejects non-panel calls with `channel_not_found` / `not_in_assistant_thread` — already swallowed at debug level. One extra failed API round-trip per tool call in non-panel contexts (colleague DMs, channels, MPIMs); negligible cost.

- **Routines fired status indicators against synthetic threadTs that Slack rejected.** The routine dispatcher built `runThreadTs = "routine_${id}_${Date.now()}"` — not a real Slack thread, so every `assistant.threads.setStatus` call during a routine's tool runs got rejected silently. Owner saw no status indicator during routine work (e.g. the Sunday LinkedIn ideas routine doing 2 web_extracts + 1 KB read). Fix: placeholder-then-update flow in `tasks/dispatchers/routine.ts`. Post `"Working…"` to the owner channel FIRST, capture its real `ts`, run the orchestrator with that real threadTs, then swap in the final content via `chat.update` (or `chat.delete` on a silent return / orchestrator throw). New `updateMessage` + `deleteMessage` primitives in `connections/slack/messaging.ts`. Graceful fallback to the old synthetic-ts path if the placeholder post itself fails.

### Fixed (smaller)

- **Brief duplicated open items between "Open" lines and ACTION ITEMS.** Owner direction: drop the ACTION ITEMS section entirely; per-person paragraphs + freestanding lines carry everything. `tasks/briefs.ts` structure item 5 deleted; strict-definition block deleted; ACTION-ITEM CONTEXT → APPROVAL CONTEXT (rule still useful for rendering approvals, just no longer tied to a section); CLOSURE NARRATION reworded; the existing NO SELF-CONTRADICTION rule replaced with a stronger ONE-PLACE RULE covering open items too. No more duplication possible by construction.

- **Stale legacy skill toggles fired a debug warning every process start.** `skills/registry.ts` auto-migrates `scheduling` / `coordination` / `meeting_summaries` / `knowledge_base` / `calendar_health` / `persona` to their new keys but didn't delete the originals; the loop iterated over them, couldn't find them in `SKILL_MAP`, and emitted a "enabled in profile but not available — skipping" line once per process per stale key. `delete toggles.X` added after each migration line.

- **Routine prompt for the Sunday LinkedIn ideas updated.** DB-only change (no code commit): `routine_1775935889360_f7r7` rewritten to do `web_search` for current angles + `web_extract` the Reflectiz LinkedIn page + `manage_knowledge` cross-reference. Goal made explicit ("weekly LinkedIn post, covering something interesting, either of Reflectiz or the market or hopefully both"). Already applied to the running DB.

### Added

- **Research pre-check** (`src/utils/researchPreCheck.ts`, new). Owner-path regex on `explore X` / `research X` / `look into X` / `what's new with X` / `tell me about X` runs `web_search` deterministically before the main Sonnet turn (30-day window, ≤5 results), injects the formatted summary + top results into the orchestrator's dynamic system prompt. Closes the standing gap where Sonnet answered "explore" requests from KB + training alone, never reaching the outside web. Fails open: regex miss → empty block → normal flow. Sibling to `availabilityPreCheck.ts` — same shape, same trade-offs. Wired in `core/orchestrator/index.ts`.

- **`manage_knowledge` tool description tightened** to say it's INSUFFICIENT ALONE FOR EXPLORE / RESEARCH requests — pair with `web_search` and `web_extract` to bring in outside views. Closes the same gap from the prompt side without adding a free-floating prompt rule.

- **`recentAuditEntries(action, windowDays)` helper** in `db/client.ts`. Reads recent audit_log entries matching action + outcome + time window; returns parsed `details` JSON. First consumer is active-mode's "respect recent owner deletions" check; reusable for any future similar guard.

- **`updateMessage` + `deleteMessage` primitives** in `connections/slack/messaging.ts`. Used by the routine dispatcher's placeholder-then-update flow. Fire-and-forget tolerance, logs at warn on failure.

- **`getEventType` extended** with `startDateTime` / `startTimeZone` so `delete_meeting`'s audit_log can record WHICH DAY was affected — feeding the active-mode recent-delete check.

### Removed

- ACTION ITEMS section in the brief prompt (`tasks/briefs.ts`). Replaced by the ONE-PLACE RULE narration.
- Module F + E retry path in `postReply.ts`. Booleans still fire in the checker; the retry trigger is gone.

### Not changed

- DB schema. No migrations.
- No new tools (consistent with "tooling over new tools").
- Module F booleans + their judge prompt still exist (telemetry intact). The rollback is at the *consumer* layer.

---

## 2.8.4 — Three real-day bug fixes (TZ math, claim-checker double-fire, assistant-panel TTL)

Closes three bugs caught in live use 2026-05-16/17. Each one is a "code over prompt" win — fixing the data path rather than tightening a rule.

### Fixed

- **Sonnet was inventing cross-timezone math in chat** (Lori "10:30 IL = 08:30 Boston" — actually 03:30 Boston, off ~5h). Two parts: (a) Lori's `people_memory` row had `state="Boston"` but `timezone="Asia/Jerusalem"` — both owner-stamped from some earlier path. One-shot data fix script at `scripts/fix-lori-timezone.cjs` (already executed). (b) The `find_available_slots` handler in `skills/meetings/ops.ts` now post-processes each slot: for every attendee whose stored TZ differs from owner's, it pre-renders `per_attendee_local: [{ email, timezone, local_iso, local_display }]`. Sonnet quotes `local_display` verbatim — no math. One-line prompt rule in `meetings.ts` ("CROSS-TZ ATTENDEE — quote `local_display`, don't recompute") replaces the older multi-paragraph TRAVELING ATTENDEE rule. Net prompt shorter, behavior strictly more correct.

- **Claim-checker retry path double-fired write tools.** Real-day reproduction: "yes perfect" → `create_meeting` at 15:00 succeeded → claim-checker's `unverified_state_review` retry path re-invoked the orchestrator with NO awareness of the first write → Sonnet called `find_available_slots` fresh (15:00 now busy from her own booking!) → fired `create_meeting` at 15:30 → second event. Root cause was a 2.8.1 regression: the new Module F/E retry path was missing the `priorActionsHint` plumbing the classic v2.3.4 retry path had. Fix: `OrchestratorOutput.mutationActions: Array<{tool, ok, subject?, start?, eventId?, …}>` field added, populated alongside the truncated `toolSummaries` — carries FULL event IDs. New `buildPriorActionsHint` helper in `postReply.ts` renders a structured block ("In this turn you already executed: …") followed by the amend-vs-rewrite playbook: "USUALLY rewrite the draft to match the action; RARELY amend via move_meeting/update_meeting/delete_meeting referencing the id above; NEVER re-call create_meeting / book_floating_block / coordinate_meeting / message_colleague — those create duplicates." Wired into both retry call sites.

- **Assistant-panel status indicator silently broke after 24h.** Slack only fires `assistant_thread_started` on FIRST panel open. The DB-backed `assistant_threads` table stamped `registered_at` at first-open and enforced a 24h TTL at read time — any panel session crossing the 24h mark dropped out of the registry with no event to re-register it. Fix in `assistantThreads.ts`: `isAssistantThread` now refreshes `registered_at` on every successful DB lookup. Active panels stay registered indefinitely. Truly-closed panels still expire after 24h of no lookups. Latent since v2.7.5 (when DB-backed registry shipped); only visible to long-lived panel users.

### Added

- `OrchestratorOutput.mutationActions` — structured per-write record for downstream consumers. Today only the claim-checker retry hint uses it; future amend-aware features can read the same field.
- `scripts/fix-lori-timezone.cjs` — one-off data fix (idempotent). Audit trail for the Lori row repair.

### Not changed

- No DB schema migrations.
- No new tools (consistent with the recent "tooling over new tools" direction).

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
