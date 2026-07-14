# Maelle session context

Working on Maelle at `E:/Code/Maelle`. **Current version: v3.7.3** — `package.json` is the source of truth; the boot log stamps `version` + `gitSha`, confirm it matches HEAD after any restart.

## This chat = FEATURES **and** BUGS

This is the general **features + bugs** chat (not bugs-only anymore). Real-day bug waves *and* new-capability design/build both land here. Standing mode either way:

- **Propose-first, code-first, root-cause.** Trace `logs/maelle-YYYY-MM-DD.log` + the code before attributing; state root cause as `file:line`. Bug reports / frustration / screenshots are diagnostic signals, **not** build signals.
- **Build only on an explicit per-item "fix it / build it / do it"** on a *specific* bug or feature. A bare "ok / yes / go" is ambiguous — ask. On a build signal: edit → typecheck → **STOP** (uncommitted).
- **Wrap only on an explicit ship word** ("wrap / ship / commit / cut a version / bundle"). Default bump **PATCH**.
- **Prompt is a budget, not a junk drawer.** Enforcement → code (a chokepoint guard, a return-value the model reacts to, a tool that owns the decision). Prompt only for judgment / tone / format / language. **Lesson re-learned this arc:** a prompt rule Sonnet ignored *twice* (attendee resolution) only held once it moved to code — never ship enforcement as prompt.
- **CHANGELOG = meaningful changes only.** Tactical one-liners ship with a clear commit message, no CHANGELOG line.

## Next run — planned BIG BUG RUN (core / internal issues)

The next working session is a **deep bug hunt**, not a real-day patch wave. The goal is to find **core / architectural / internal** issues and resolve many at once — the recent waves (3.6.x → 3.7.1) were mostly surface real-day bugs; this one goes deeper into the internals. Lean on the **`audit` skill** (parallel deep-read across subsystems, paper-traced, STRICT propose-only) to produce an atomic bug list ranked by severity, then work fix-waves with the owner. Expect structural findings in the load-bearing subsystems — the scheduling **rule engines** (search vs `checkSlot` consistency), the **requests-spine**, the **gate stack** (`humanGate`/`claimChecker`/`securityGate`), **boot/recovery**, cross-TZ scheduling — not just one-off symptoms. Same bar (propose-first, code-first, root-cause), wider scope. Route deep findings to the owning agent chat (see below).

## Parallel chats on the same repo — route work to the right one

These chats are **actively working the repo right now** — assume 2–4 of them have uncommitted edits in the tree at any time. At wrap: `git fetch` + read the FULL working tree (not just this chat's files) and bundle theirs too. Concrete: **3.7.1 bundled the guard chat's `humanGate` fix and the meeting chat's availability-rule fix** alongside this chat's work — both landed as uncommitted edits from handoffs. Never commit only your own files without checking the rest.

- **Meeting agent** — the meeting-planner subsystem end-to-end: scheduling core, free/busy, slot finder, timezone/WE, create/move/close-loop. Mandate + map in `.claude/MEETING_PLANNER_AGENT.md`.
- **Guard agent** — the gate stack: `claimChecker`, `securityGate`, `humanGate`, `dateVerifier`, `weekdayGuard`, `postReply`. Honesty / leak / false-positive / recap-inversion.
- **Prompt agent** — the orchestrator system prompt (`systemPrompt.ts`) **+ tool descriptions + per-skill prompt sections + yaml**. Language, narration, judgment/tone, tool-contract wording. `.claude/PROMPT_AGENT_STARTER.md`.
- **Approval agent** — approvals / requests-spine / colleague close-loop: structured requests, `deferred_action` replay, reschedule-reply classification (approve/decline/counter/**checking**).
- **GCP migration chat** — moving Maelle off Idan's local Windows box to Reflectiz **GCP** to run 24/7 (his host isn't always-on). Phase-1 codebase discovery DONE; **BLOCKED on Idan getting GCP access.** See memory `project_gcp_migration.md`.

Routing rule of thumb: honesty/leak → guard · narration/tone/tool-wording/yaml → prompt · approvals/close-loop → approval · deterministic scheduling → meeting · infra/deploy → GCP.

## Open / deferred

- **Channel document attachment — SHIPPED 3.7.0.** A channel @mention carrying a document (PDF/txt/md) or image is now read: extracted on the `app_mention` path, gated on owner-presence (owner's own file always; a colleague's file only in a thread the owner has posted in, fail-closed otherwise), documents folded into the directive as framed do-not-follow-instructions reference material, images through the existing injection guard (owner proceeds, suspicious colleague image dropped). Scoping call resolved: **owner + present-colleague**; **PDF + images** (audio in channels out of scope). Shared PDF-parse / image-scan cores now used by both the DM and channel paths. Watch live (below). See CHANGELOG 3.7.0.
- **Auto-move REVERT tool — SHIPPED 3.7.2.** `revert_last_auto_move` (owner-only) undoes the last active-mode auto-move ≤12h + re-notifies + writes a terminal `dismissed` overlap row; paired with dismissal memory (the double_booking detector skips a pair the owner dismissed OR auto-moved in the last 12h). "If I said no, it's no." See CHANGELOG 3.7.2.
- **Work-time overrides + WE-spine deletion — SHIPPED 3.7.3 (#143).** Per-date `owner_schedule_overrides` (yaml default → date-row wins → fail-safe) via `getEffectiveWorkDay` / `getEffectiveWorkDayForInstant`; owner-only `set_work_schedule_override` / `get_work_schedule_overrides`; away days (row with an explicit tz) book DIRECTLY in that zone (no relax/confirm), tz resolved per-instant (far-west/east midnight-crossing correct). The **full-day WE travel-marker spine is DELETED** (`weConfirmStash`, `we_acknowledged`, `detectWorkingElsewhereDays`, `getWeWindow`, `computeTentativeWeSlots`, `resolveWorkingElsewhereTz`); `weTimeResolver` dual-clock + the timed optional-join WE event KEPT. Full map: `.claude/143_BUILD_SPEC.md`; memory `project_we_timezone_spine.md` (rewritten).
- **GitHub bugs #137–#142 — fixed + shipped (3.7.2/3.7.3) but still OPEN on GitHub.** Close them with a fixed-in-SHA comment when convenient (owner never auto-closes without a nod).
- **Stale memory:** `project_architecture.md` still describes the coord state machine as live — coord was removed in 3.5.0. Trim when next touched.

## Recent arc — 3.6.0 → 3.7.3 (CHANGELOG.md is canonical; memory holds architecture)

- **3.6.0** — Working-Elsewhere **timezone spine**: one resolver (`weTimeResolver.ts`), one renderer, the model conveys the named zone. Memory: `project_we_timezone_spine.md`.
- **3.6.1** — review accuracy (free-time boundary, category limits in the interactive review) + **one free-time source of truth** (length-based floor, `requiredFreeMinutesForWorkDay`) + slot narration + create-vs-move guard.
- **3.6.2** — Teams online-meeting rendering; social coda restricted to 1:1 DMs.
- **3.6.3** — colleague meeting-coordination: a **structured request the booking replays** (no subject-drift / attendee re-ask); no offered-then-bounced loop.
- **3.6.4** — **deterministic attendee resolution**: `classifyTurn` extracts named participants → orchestrator resolves known internal colleagues in code → threaded into the search. Replaced a prompt rule Sonnet ignored.
- **3.6.5** — **optional-join meetings**: a **timed** `workingElsewhere` event is a "join if free" soft tier (visible, bookable-over, offered only when clean slots fall short, health treats it as reclaimable free time — split from the travel marker by `isAllDay`); + `dateVerifier` **uniform day-shift guard** (the 2026-07-11 Sun→Mon rundown); + quieter socket-mode logs.
- **3.7.0** — **channels get files + a privacy clamp** (a channel @mention reads PDF/image attachments, gated on owner-presence; owner is colleague-clamped in channels so private calendar/owner-only data never leaks into a shared space) + **instant restart** (socket opens ~1s instead of ~40s — catch-up moved off the boot-blocking path to a parallelized background scan, dedup via the shared atomic `markProcessed` claim) + **availability pre-check** is language-neutral (structural `?`/TZ/time gate, no per-language regex) and answers "how much is free there?" with the real largest-bookable length (meeting chat).
- **3.7.1** — real-day bug wave (4 chats): `get_calendar` crash guard (undefined date → `.split` throw → "trouble pulling up the calendar"; fixed at the `datePart` chokepoint) + **availability pre-check now enforces the SAME category-cap/work-hours rules as the search** and escalates owner-overridable violations to approval (closes the colleague rule-bypass) + **coda once-per-day** actually holds (gate reads `people_memory.last_initiated_at`, covers `raise_new`) + colleague-path **self-shadow** suppressed when the actor is the owner-clamped-in-MPIM/channel + humanGate keeps valid `<@…>` mentions (owner path ships the original over a corrupted rewrite) + **autonomous auto-moves recorded on the requests-spine** (`follow_up`/`auto_move`, intent-before-execute → resolved; substrate for a deterministic revert — the revert TOOL itself is NOT built yet).
- **3.7.2** — real-day bug wave II (4 chats): approval bare-"yes" cross-thread misbind gated + policy_exception jargon / self-contradiction fixed; auto-fix **dismissal memory** + owner-only **`revert_last_auto_move`**; **requester-aware colleague move/cancel** (`getMeetingsRequestedBy`) with a no-leak decline; slot offered-exclusion gating + duration search=book; **`getFreeBusy` short-window interval** root fix (the deterministic Graph 400 behind #137).
- **3.7.3** — **work-time overrides replace the full-day WE spine (#143)**: per-date `owner_schedule_overrides` drive every work-hours consumer via `getEffectiveWorkDay` / `getEffectiveWorkDayForInstant`; away days book directly in their stated tz (tz resolved per-instant → far-west/east midnight-crossing correct); the full-day WE marker spine is deleted (`weTimeResolver` dual-clock + timed optional-join WE kept); + bundled approval-honesty fixes (daily-thread bare-"yes" binding, a hard double-book NAMED in the ask).

## Watch live (first real use)

- **Attendee resolution (3.6.4)** — "meeting with Idan and Lori" should resolve the internal teammate without asking; now code-driven, confirm it holds.
- **Optional-join (3.6.5)** — set a timed `workingElsewhere` on a standup: a booking request should offer other times first, fall to that slot only when out of clean options, and health should stop flagging it.
- **dateVerifier day-shift (3.6.5)** — weekly rundowns should keep the right weekday under each day.
- **Channel files (3.7.0)** — @mention Maelle in a channel with a PDF/image: she should read + act on it (owner always; a colleague only in a thread you're in). Confirm the injection guard drops a suspicious colleague image.
- **Channel clamp (3.7.0)** — @mention her in a channel yourself: she should stay colleague-limited (no `get_free_busy`, no private-calendar narration) even though you're the owner.
- **Restart latency (3.7.0)** — after `npm run deploy`, `Assistant online` should land right after `Database ready` (was ~40s later); first reply in seconds, and missed-DM catch-up still lands (in the background).
- **Revert auto-move (3.7.2)** — after an active-mode auto-move, "put it back / revert that" restores the original time, re-notifies, and does NOT re-move on the next sweep.
- **Work-time overrides (3.7.3, #143)** — "next week I'm in Boston 9-5 EST" / "working Monday night" / "off Tuesday" / "office Wednesday" → search + checkSlot + free/busy all follow it; a Boston day books directly in EST with a dual-clock; "what are my overrides?" lists them. Watch timezone correctness first (far-west/east midnight crossings).

## Operational

- **Restart to load code:** `npm run deploy` (build → `pm2 restart maelle` → tail). Single PM2-fork process. Boot stamp prints version + gitSha.
- **Exactly ONE Slack socket** — two Maelle processes on the same app → Slack `server explicit disconnect` (too_many_connections). Never run local + another at once (critical for the GCP cutover).
- **GitHub:** bugs flow through chat / the spawned-task chip; **never** `gh issue create` without an explicit "file it." Bug issues **#137–#142 are fixed + shipped (3.7.2 / 3.7.3) but still OPEN** — close with a fixed-in-SHA comment when convenient.
- **Typecheck** (from the main repo, not a worktree): `npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json`.

Read at session start: memory `project_architecture.md`, `project_overview.md`, `project_we_timezone_spine.md`, `project_gcp_migration.md`, and the `feedback_*` memories (auto-load via `MEMORY.md`).
