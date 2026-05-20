# Maelle session context

We're working on the Maelle project at `E:/Code/Maelle`. **Current version: v2.9.2** — check `package.json` if unsure; it is the source of truth.

## Right now — known regressions, stabilization phase

The 2026-05-19 / 2026-05-20 sessions shipped a major approval-pipeline rebuild (v2.9.1) and then spent most of v2.9.2 patching regressions that surfaced under live load. **Two known issues remain open and unstable.** Next chat focus: **stabilize Maelle + fix open bugs + general live feedback on the changes**.

Open issues:
- **[#103 Person memory — colleague-self path mute, volunteered hints never captured](https://github.com/odahviing/AI-Executive-Assistant/issues/103)** (High). When a colleague volunteers a preference ("I prefer 4-6pm Sydney"), it lands in `interaction_log` as narrative but never reaches `profile_json.working_hours_structured`. Next conversation won't honor it. Full audit + entry points in the issue. Treat as a structural rewrite, not a patch.
- **[#104 Floating block rebalance regression](https://github.com/odahviing/AI-Executive-Assistant/issues/104)** (High). Lunch overlapping a meeting in its own window should auto-rebalance to a clean slot inside the window — instead the brief surfaces it as a question to the owner. The direct-move path for floating blocks (per v2.1.0/v2.1.1 design intent) isn't firing.

When opening this project: read these two issues first, then this SESSION_STARTER, then start digging.

Read these two memory files at session start:
- `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_overview.md`
- `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_architecture.md`

Plus the feedback memories (cross-session rules the owner has set) — they auto-load via `MEMORY.md`.

---

## The two principles that govern every change

**1. Code over prompt.** Determinism belongs in code (rule checks, idempotency, location decisions, date alignment, approval sync, honesty signals). Judgment and tone belong in the prompt. When something can be code-enforced, code-enforce it; when something is judgment-class, leave it to the LLM. **The work direction is constant: prompt shorter, code more deterministic, let the LLM reason within fewer rails — not against them.**

**2. Tooling over new tools.** Before proposing a new tool or a new long prompt section: look first at the existing tooling. Can we extend a current tool's action enum? Can we replace a prompt rule with a code-side guard (claim-checker check, deterministic helper)? New tools and long prompts are the last resort, not the first. The v2.8.3 consolidation (13 tools → 5) and the v2.8.1 honesty-rule code-replacement (8 prompt rules → claim-checker booleans) are the canonical examples of this direction.

---

## Bug-fix flow — never auto-fix

Every bug report follows the same four steps:

1. **Understand.** Read the screenshot / issue / chat report. Code-trace against current files on disk. Don't guess.
2. **Plan.** Identify root cause (file + line + mechanism). Map to the fewest possible changes.
3. **Suggest.** Write up the proposal: what's broken, where, what the fix is. Prefer prompt-tweak over new-rule; prefer extending an existing helper over a new file; prefer code-side determinism over a new prompt rule. Wait for owner feedback — he often re-frames or rejects the agent's first read, and that iteration IS the value.
4. **Build.** Only after explicit approval. Run typecheck. Stop. Summarize the uncommitted tree.

**Never bundle multiple fixes without owner saying so.** Default version bump is PATCH unless the owner explicitly says minor.

### The build-signal trap (read this, you WILL fail it otherwise)

The single most-recurring drift pattern: the agent treats "owner is reporting/talking about bugs" as approval to fix them. **It is not.** During the 2026-05-19 session the agent broke this rule four times in one day — three calendarHealth fixes during wrap, then three brief-side fixes immediately after. Each time owner pushed back. Each time the agent had to revert.

Recognize the trap. Frustration, ALL-CAPS, "this is disappointing", "still broken", "yesterday's wave didn't fix it" — these are **diagnostic signals**, not build signals. They mean **propose more thoroughly**, not **start typing code**.

Hard rules:
- **Only these are build signals**: "fix it" / "fix N" / "go build that" / "land it" / "do it" / "do A" / "build B" — applied to a SPECIFIC bug or fix shape. Never "OK", "yes", "go ahead" with no referent — those are ambiguous, ask.
- **NOT build signals**: bug reports, frustration, screenshots, "this should have been fixed yesterday", "doesn't make sense", "isn't it X?". When in doubt, propose and wait.
- **When the owner stops a wrap-up to flag bugs**: don't try to "fold them into the wrap". The wrap is paused. New bugs → new propose-only pass. Bundle later only on explicit "OK, wrap with these too".
- **Reads are free, writes are not**: `gh issue view`, DB queries, log greps, code reads — never ask permission. But code edits, even small, need explicit per-bug build signal.
- **Reverting your own unapproved fixes is cheap; living with rejected ones is expensive**. If you've already typed code without approval: stop, list what you wrote, offer per-fix revert, do not commit.

---

## Bundle signals — the loud rule

Do NOT bump `package.json`, write CHANGELOG, update memory, commit, or push unless the owner has explicitly said one of: **"wrap up" / "ship it" / "close the patch" / "cut a version" / "bundle" / "commit" / "push" / "let's finish for today"**.

These look like approval but are **NOT** bundle signals — they're build-only:

- "go" / "go ahead" / "go for all"
- "yes" / "ok" / "do this"
- "land it" / "fix it" / "build it" / "start building"

On those words: write code, typecheck, stop. Close with *"Built and typecheck clean. Tree shows: [files]. Your call when to bundle."* — never with *"Shipped 2.x.y, restart npm run dev."*

The full release checklist lives at `.claude/WRAP_UP.md`. It runs only when the owner triggers it.

---

## GitHub workflow

- **GitHub is the bug data source.** When the owner asks for a "bug pass" / "go over the github bugs" / etc., the `github` skill (in `.claude/skills/`) handles the triage flow.
- **NEVER open a GitHub issue unless the owner explicitly asks.** Surface bugs in chat or via the spawned-task chip; the owner files tickets himself. Filing on his behalf is a recurring drift-pattern that gets corrected.
- **Title style** (when the owner DOES ask for a ticket): short noun phrase, no hyphenated compounds, no parentheticals. See `memory/feedback_ticket_titles.md`.
- **Label axes**: Improvement uses High/Medium/Low; Feature uses Roadmap/Next/Idea. Never mix the two axes.
- **`gh` body files**: for any non-trivial issue/PR body, write to `C:/Users/idanc/AppData/Local/Temp/` first then pass `--body-file`. Inline HEREDOCs spam the chat with the whole markdown.

The auto-triage GitHub Action exists but is currently **OFF** (gated `if: false &&`). Owner files issues / shows screenshots; we fix interactively.

---

## Slash-command skills

Procedures the owner runs frequently are wired as skills under `.claude/skills/` — they auto-load when triggered:

- **`github`** — bug triage. Triggers on "github bugs" / "go over the issues" / etc. Pulls Bug-labeled open issues, code-traces, proposes fixes. Propose-first; never auto-fix.
- **`wrap`** — finish the session. Triggers on "wrap" / "ship it" / "close the patch" / etc. Runs the full WRAP_UP.md checklist.
- **`scenario`** — paper-trace a numbered test scenario from `.claude/test-scenarios.md`. STRICT paper exercise — no live DMs, no calendar writes, no tool calls against the running system.
- **`bugs`** — analyze bugs the owner describes directly in chat. Propose-only; ships everything in one commit + version bump at the end via `wrap`.

---

## Where we are — v2.9.2 shipped, approval pipeline rebuild stabilizers, regressions outstanding

**Current phase**: stabilization. The 2026-05-19 minor (v2.9.1) shipped a structural rebuild of the approval pipeline + several adjacent changes. The 2026-05-20 patch (v2.9.2) spent most of the day fixing regressions from that rebuild as they surfaced under live load. **Two known regressions remain open** ([#103](https://github.com/odahviing/AI-Executive-Assistant/issues/103) person memory, [#104](https://github.com/odahviing/AI-Executive-Assistant/issues/104) floating block rebalance).

### Approval mechanism — what was rebuilt + what was patched

**Architecture (v2.9.1)**: Every approval is a structured callback table living in `request.details_json`:

```
callbacks = {
  on_approve: { tool, args },       // REQUIRED for replay path. Resolver runs this on yes.
  on_reject:  { tool, args } | null, // Default: close + DM requester "Idan said no".
  on_amend:   { mode: 'relay_to_requester' | 'run_with_amend' } | null
}
```

Three verdicts (approve / reject / amend) flow through ONE resolver. `amend` with `relay_to_requester` mode is the ping-pong: state flips to `awaiting_colleague`, Maelle DMs requester with the owner's counter; requester answers → bounces back to owner. `counter_history` tracks rounds. Round cap = 5.

`on_approve` is universal — works for ANY tool the resolver knows how to replay (`RESOLVER_REPLAY_TOOLS` set in `src/core/approvals/approvalCallbacks.ts`). Currently includes meeting tools; future non-meeting tools (delete_routine, contact updates, etc.) plug in by adding to that set + `deferredActionReplay.ts` dispatch.

**Legacy bridge**: the v2.7.1 era `deferred_action` field on payloads still works — `extractCallbacks()` aliases it to `on_approve` transparently. The `create_approval` tool description was reverted in v2.9.2 to the v2.9.0 wording (the v2.9.1 expansion drowned out the LANGUAGE-OF-ARTIFACTS rule and produced Hebrew leakage on owner-facing DMs). Sonnet doesn't need to know about the callback model for it to work.

**v2.9.2 stabilizers layered on top**:
- **Completeness gate** at `src/utils/approvalCompletenessGate.ts` — Haiku output-pass refuses `create_approval` calls whose ask_text doesn't carry concrete facts the requester gave (specific time, venue, post text, etc.) AND has no on_approve callback to fire those facts. Universal across approval kinds; no per-kind code.
- **Approval-bound thread tool-lock** in `orchestrator/index.ts` — when an owner reply matches a pending approval's `terminal_dm_msg_ts`, Sonnet's tool list is filtered to `resolve_approval` + `list_pending_approvals` only. Forces engagement; no drift into morphing flows.
- **Re-ask revival** in `tasks/skill.ts` `create_approval` handler — when dedup matches an existing open approval AND `last_surfaced_at` was >2 hours ago, Maelle re-DMs the owner + re-stamps `terminal_dm_msg_ts`. Closes "owner buried in old thread" pattern.
- **Universal cleanup cascade** in `closeRequest.ts` — closing ANY request also cancels the linked legacy `coord_jobs` / `outreach_jobs` rows (`request_id` column from v2.7.1 bridge). Closes the root cause of templated-English-DM-from-legacy-state-machine bugs.

**Owner's model (important for the next session)**:
- `on_approve` is ALWAYS a single tool call — book the requested meeting at the requested time, with `relaxed: true` to bypass collisions.
- "Move conflicts to make room" is **separate follow-up work**, not part of the approval. Maelle can double-book; the active-mode calendar-health flow detects the conflict later and offers to resolve.
- Owner-clarifying questions ("what time?") are AMEND with text-shape `counter`. The amend ping-pong relays the question to the requester.
- The morning calendar-health flow handles all double-bookings as a separate concern — disconnected from the approval that created them.

### Request meeting config — what changed

**`find_available_slots` gained `preferred_slot` param** (`src/skills/meetings.ts`). Sonnet passes the requester's specific asked time as ISO. The tool guarantees that slot in the result if it passes all rules — even when `pickSpreadSlots`'s `MIN_GAP_HOURS=1` filter would have dropped it. Closes the "asked time vanishes from offered set" narration bug.

**`is_online` is now optional on `create_meeting`** — dropped from `required` array. Sonnet was defaulting to `true` to satisfy the field; `resolveLocation` treated it as an explicit owner hint and short-circuited the defined day-type + party-shape decision. Now: only pass when there's an explicit conversational signal. The defined location process (Home + internal → Huddle, Office + internal → Office, External → Teams) runs un-corrupted.

**`update_meeting` gained `add_attendees` / `remove_attendees`** (v2.9.1). Owner-path: full add/remove. Colleague-path: self-only. Handler routes through `planMeeting` when shape changes (internal-only ↔ has-external, count crossing 4↔5) so category + location re-resolve correctly. Graph PATCH on `updateMeeting` accepts attendee arrays.

**`movable: boolean` on `profile.meetings.protected[]`** (v2.9.2, `src/config/userProfile.ts`). Owner-curated authoritative flag. When `false`, active-mode skips both picking-as-movable in `double_booking` resolution AND flagging as `oof_conflict`. Supersedes attendee-count / external-attendee heuristics for explicit yaml entries. Use case: "Bookcamp during Holiday Block" — solo personal block placed intentionally during OOF day, shouldn't be flagged.

**Universal tool-call cache** in `src/utils/toolCallCache.ts`. Hashes `(owner, threadTs, tool, canonical_args)`; cached results returned without re-firing. TTL 60s for writes, 5s for reads. Tool-agnostic — covers all present and future write tools without per-handler guards. Owner direction: "don't add per-tool checks, build it once in the agent loop."

**Yaml category `Private` → `Personal`** (`config/users/idan.yaml`). Owner action required: rename the actual Outlook category to match so color labels stay applied. Disambiguates from the sensitivity field value `'private'`.

### Two architectural moves still on the roadmap

- **Phase 3 of v2.7.x cutover-finish**: drop the legacy `coord_jobs` / `outreach_jobs` tables entirely. The state machine logic still lives there; Phase 1+2 wired writers + state mirrors. Phase 3 migrates the state machines to pure requests-spine logic. Estimated 3-5 days focused work. The v2.9.2 cleanup cascade is the band-aid that keeps legacy tables honest while we wait.
- **Phase B of `BookingRequest` normalizer** (per v2.9.0 work): consolidate handler-side duplicate prep, move move_meeting / coord / calendarHealth's two planMeeting callers onto the normalizer. Currently Phase A wired only `create_meeting` + `delete_meeting`.

---

## Where we are — v2.9.0 shipped, BookingRequest normalizer (Phase A) + calendar-health morning-brief fixes

**Current phase**: First minor in a month. Two architectural moves bundled with the 2026-05-19 morning-brief bug-wave.

**Phase A — `BookingRequest` normalizer** (`src/skills/meetings/bookingRequest.ts`): every meeting tool's handler entry now flows raw Sonnet args through `normalizeBookingRequest()` before reaching `planMeeting`. The normalizer is the single chokepoint that validates owner-in-participants invariant, snaps duration, gates sensitivity for colleague-path attendee-membership, gates relaxed by senderRole + owner-in-MPIM-proposes detection + deferred-replay context, pre-computes cross-cutting signals (ownerProposedThisSlotInMpim, recentBlockDeletes). Wired for `create_meeting` + `delete_meeting`. `planInputFromBookingRequest()` adapter bridges to the legacy `PlanMeetingInput` shape so planMeeting internals stay untouched. The owner-in-participants invariant flows into planMeeting — `detectCategory` updated; "+1 for owner" math removed. `scripts/simulate-booking-request.ts` has 9 scenarios / 21 assertions, runs offline in <2s. Phase B (deferred) consolidates handler-side duplicate prep, rule registry, migrates move_meeting + coord + calendarHealth's two planMeeting callers.

**Phase A motivation**: yesterday's v2.8.6 bug wave touched 6 layers (Sonnet args, orchestrator auto-stamp, handler entry, planMeeting, Graph layer, parallel retry systems) because each layer had its own ad-hoc contract with Sonnet's input shape. The normalizer collapses contract drift into one place. Future booking-orbit bugs become one line in one file.

**Calendar-health fixes (5 bugs from the 2026-05-19 morning brief)** — all in `src/skills/calendarHealth.ts`, one file:
- `oof_conflict` skips owner-only events on his own OOF day (Bookcamp solo-attendee no longer flagged as clash with Holiday Block).
- `oof_conflict` auto-move honors `initiateCoordination` return: `'no_participants'` flips to `fix_failed` with honest reason (was: lying "kicked off a move" when no coord started).
- `missing_floating_block` detection respects recent owner deletes (was: brief surfaced "no lunch on Thursday" daily even though active-mode auto-book correctly skipped).
- `busy_day` math is per-window aware on multi-window days (was: bounding-box math counted mid-window gap as both busy and free → impossible "0 free time + 110-min gap" narration).
- (Phase A's owner-in-participants invariant + detectCategory dedup closes the "+1 for owner" math regression class.)

**v2.9.0 highlights** (top-level):

**v2.8.6 was**: 2026-05-18 real-day wave. Five GitHub bugs closed in one patch (#98 / #99 / #100 / #101 / #102) plus the Mayrav 22:30 MPIM incident (no ticket — referenced as #103). The headline chain: Dirk's freeform-cancel approval was ✅'d by owner but never executed (`deferred_action` replay only covered create/move/book_floating_block, not delete) → 3h later Sonnet re-fired the cancel during an unrelated turn → dateVerifier returned a false-positive weekday mismatch → retry with full tool access deleted the wrong event. Plus the `detectCategory` "owner omitted from attendees" undercount that made every Maelle-booked meeting look like a single-attendee personal block. Plus the `deleteMeeting` bare-DELETE that left Dirk's attendee copy orphaned. Plus Mayrav's owner-in-MPIM 22:30 proposal getting routed through a `policy_exception` approval that leaked "Idan said yes on policy exception needs your input" into MPIM.

**v2.9.0 top-level items**:
- New `src/skills/meetings/bookingRequest.ts` — `BookingRequest` interface + `normalizeBookingRequest()` function. Validates + normalizes raw Sonnet args into one typed shape before `planMeeting` sees them.
- `planInputFromBookingRequest()` adapter in `planMeeting.ts` — maps BookingRequest to legacy PlanMeetingInput. Phase B will flip planMeeting's signature; Phase A keeps it surgical.
- `planMeeting` enforces owner-in-participants invariant (auto-injects for legacy callers). All `+1 for owner` math removed; reads `participants.length` directly. `nonOwnerParticipants` filter for the few places that need it.
- `detectCategory` updated to dedupe-owner — handles the new "owner already in attendees" contract from the normalizer without double-listing.
- 5 calendar-health fixes (one file, `src/skills/calendarHealth.ts`): oof_conflict skips owner-only events; oof auto-move honors initiateCoordination return; missing_floating_block detection respects recent owner deletes; busy_day math iterates per-window; (BookingRequest fix above closes the +1-for-owner regression class).
- **Y.1** — get_calendar tool-result-side annotation on colleague-path 1:1 DM: wraps events with `_colleague_view: true` + `_enumeration_rule` instructing Sonnet not to list more than one meeting back to a colleague. Closes 2026-05-19 Yael chat leak (enumerated 6 internal meetings incl. "Bank Hapoalim in Ramat Gan").
- **Y.2** — Module D auto-resolve precondition at `utils/threadBoundApprovalAutoResolve.ts`: skip auto-resolve when the approval has neither `deferred_action` nor a slot_pick / calendar_conflict subkind. Generalizes 103e: deterministic auto-resolve is safe ONLY when there's a concrete replay path; otherwise Sonnet must interpret owner's reply and execute. Closes 2026-05-19 Yael Thursday "I'll take it from here" empty-promise pattern.
- Slack indicator: `status: 'is typing…'` (was `'typing…'`) — Slack renders avatar+name above, so the prior value read "Maelle typing…" missing the verb.
- `scripts/simulate-booking-request.ts` — offline 9-scenario / 21-assertion verifier for the normalizer. Runs in <2s without Slack or Graph.

**v2.8.6 highlights** (18 items bundled):
- **`detectCategory` injects owner into attendee count + list.** Root of the 2026-05-18 morning "single-attendee Logistic" cascade. Sonnet's create_meeting tool description treats `attendees` as the OTHER people; classifier saw 1 attendee and tagged Logistic, which has `no_default_location` → "online or in person?" defensive ask + rebalance skipped lunch move. Fix at `skills/meetings/detectCategory.ts` — truthful injection, classifier now picks `Meeting`. Verified offline via new `scripts/simulate-create-meeting-args.ts`.
- **Cancellation replay extended to `delete_meeting`.** `core/requests/resolver.ts` supportedTools + `deferredActionReplay.ts` delete branch + `tasks/skill.ts` tool description teaching Sonnet to pass `payload.deferred_action = {tool:'delete_meeting', args:{...}}` on cancellation asks. Soft side — Sonnet judgment dependent.
- **`proseOnly: true` flag on `OrchestratorInput`** — strips every WRITE_TOOL when set. dateVerifier retry passes it. Retries can fix prose; they cannot fire writes. Deterministic.
- **dateVerifier qualified-weekday hallucination filter** — post-filter drops LLM mismatches where `draft_excerpt` has a date adjacent to the weekday (regex on `\d{1,2}\s+(jan|...|may|...)`). LLM prompt tightened too.
- **`deleteMeeting` uses POST /events/{id}/cancel** — sends "Cancelled: X" invites + removes organizer copy in one call. Falls back to DELETE on 400 (events with no attendees). Signature change: optional `options.comment`.
- **`get_calendar` audit enrichment on empty-window owner-DM turns** — appends `_audit_context` listing recent `create_meeting` + `delete_meeting` audit entries from last 7 days that intersect the query window. Closes 99C "I don't have a record of booking" amnesia.
- **`night_shift` auto-merges into `work_hours` at profile load** — synthesis appends `night_shift.hours_start-hours_end` to `work_hours[typical_day]`. `00:00` end normalized to `23:59`. Tuesday's `work_hours` now `["09:00-15:30","21:30-23:59"]` automatically. Side effect: `isWithinOwnerWorkHours` true at 22:30 Tuesday — coord nudges / outreach expiry may fire at night per owner direction "fair game, this is my night shift."
- **`ownerProposedSlot` helper** — new `src/utils/ownerProposedSlot.ts`. Latest owner-typed message in MPIM matching slot time + proposal cue (`?`, "what about", "let's do", "isn't", Hebrew "מה לגבי") triggers `args.relaxed=true` + skips Guard B. Closes Mayrav 22:30 case.
- **103e wiring**: colleague-path early-rejection now stamps `_deferred_action_hint` (was missing — empty "I'll take it from here" promise). Resolver template prefers `deferred_action.args.subject` over `payload.subject` + filters meta phrases via `looksLikeApprovalMeta()`.
- **PEOPLE IN THIS THREAD dynamic prompt block** for colleague-path turns — `db/people.ts:formatThreadPeopleBlock`. Surfaces email + tz + gender for speaker + MPIM members. Closes 101a "asked for email already on file."
- **Duration snap at `create_meeting` handler entry** — single chokepoint for direct calls, coord handoffs, deferred replays. coordinator.ts duplicate removed.
- **`sensitivity` at booking** — `create_meeting` schema accepts the field; handler-side colleague-path gate honors only when colleague is in `args.attendees`. Closes 102a Yael-private refusal.
- **TZ note rephrased** — "City not on file — TZ is reliable for time math; only ask for city when location/venue matters." (Was: "Don't infer where they live" — over-rotated.)
- **`verbMap` fallback picks top 1-or-2 verbs by tier priority** — closes 98b "Done — found the person, booked the meeting, and logged the interaction" robot-listy phrasing.
- **Slot-narration rule tightened** with ❌/✅ covering both busy-slot AND qualified-free-slot patterns. Colleague block only.
- **`loading_messages: ['​']`** — zero-width space; Slack min-length passes, glyph invisible. Only the per-tool bottom status renders.
- **In-flight follow-up subject prefixed with verb** — "In flight: moving Website Update" instead of just "Website Update."
- **GitHub skill — five-rules block + anti-pattern entries** codifies lessons from today: build signals exact-per-bug, reads free, no tier jargon, regex suspect, no new prompt rules without approval.

**Earlier in the 2.8 line**:
- **v2.8.5**: Bug wave (10 fixes) — inboundQueue cross-thread runner bug; Module F retry path rolled back (booleans stay as telemetry, RULES 1/2/2b/2c/2d/3/5b/9 restored); planMeeting freebusy self-conflict fix via `priorSlotEndIso`; active-mode respects recent owner deletions; new `researchPreCheck.ts`; routine placeholder-then-update flow; assistant-panel gate dropped; brief ACTION ITEMS removed; legacy skill toggle cleanup.
- **v2.8.4**: Cross-TZ attendee math (`per_attendee_local.local_display` pre-rendered per slot); claim-checker retry double-fire fix (`OrchestratorOutput.mutationActions` + `buildPriorActionsHint` with amend-vs-rewrite playbook); assistant-panel TTL refresh on lookup.
- **v2.8.3**: new `venue` skill + tool consolidation (13 owner tools → 5: `manage_preference`, `manage_routine`, `manage_calendar_issue`, `manage_knowledge`, `update_task`). Google Places migration tracked at [#96](https://github.com/odahviing/AI-Executive-Assistant/issues/96).
- **v2.8.2**: `resolveLocation` rewritten as a single deterministic decision tree; `planMeeting` `preserve_existing` verdict for moves within same day-type; meeting-room availability check.
- **v2.8.1**: Vertex AI prep (`LLM_PROVIDER` env var); multi-window work hours (split-shift days); 8 honesty rules code-replaced via extended claim-checker — **partially rolled back in v2.8.5**: the booleans stay as telemetry, but the retry path that consumed them is gone, and the original prompt rules are back.

---

## Typecheck gotcha (caught in 2.8.1 hotfix, still relevant)

When running from a Claude Code worktree under `.claude/worktrees/`, `npm run typecheck` checks the **worktree's stale source**, not the main repo. To get real coverage, always run project-mode tsc against the main repo:

```bash
npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json
```

The 2.8.1 ship missed a stray `}` for hours because the worktree typecheck passed every step. Future sessions: project-mode tsc against main repo, always.

---

## Operational state

- **PM2 + auto-deploy watcher are OFF.** Owner runs `npm run dev` directly. Restart needed to pick up code changes.
- **Auto-triage GitHub Action is OFF** (gated `if: false &&`). Bugs flow through chat.
- **`processedDedup` TTL is 10 minutes** (bumped from 60s in v2.7.0) — covers Slack socket-mode reconnect retry windows.
- **assistant.threads.setStatus** ("Working…" indicator) only fires in registered AI-panel threads on Slack DESKTOP. Mobile + regular DMs don't render it.

Bigger architectural facts (Connection interface, requests spine, planMeeting / resolveLocation single-decision functions, four-layer model) live in `project_architecture.md`.
