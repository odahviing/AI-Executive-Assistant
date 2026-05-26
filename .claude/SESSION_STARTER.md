# Maelle session context

We're working on the Maelle project at `E:/Code/Maelle`. **Current version: v3.0.7** — check `package.json` if unsure; it is the source of truth.

## What just shipped (3.0.4 → 3.0.7)

Four patch versions in two days of real-day-bug-bashing. Read CHANGELOG.md top-to-bottom for the full picture; highlights:

- **3.0.4** — identity-spoof guard in security gate, v3.0.4 schema-defaults pass, `message_colleague` silent-fail kill (Path 2 stages 0+1: deleted the duplicate `createRequest` block in outreach.ts that idempotency_key-collided)
- **3.0.5** — endless-approval root cause (`#` prefix on approval IDs in prompt → resolver silent-fail), identity-spoof redesigned (email-mismatch trigger + Haiku composer), attendee-memory write on booking, lunch-gap preemptive dismiss via `manage_calendar_issue(date, block_name)`, `<URL|text>` strip deleted (#113), startup version DM removed
- **3.0.6** — 54-atomic-fix V3 audit bug-bash (phantom-confirmed bookings, force-book winning_slot leak, recheckFreeBusyForBooking shared helper, owner override truly total, capture-pass timezone gated by isStrictIana, ~400 LOC dead code removed) + claim-checker covers action-based verb tools (manage_routine/manage_calendar_issue/update_task/etc.)
- **3.0.7** — slot-finder ↔ rule-engine consistency on lunch feasibility, close-loop DM to colleague-requester via requests spine (broadened subject match), `coordinate_meeting` HARD STOP when owner just picked a slot, `_slot_results_now_stale` flag on slot-relevant profile/memory writes, `find_available_slots` date-only `search_to` expansion (was collapsing to 0-minute window when search_from === search_to), `create_meeting` array guard on `args.attendees`, claim-checker pruned to RULE A + coda mode (Module F/E extended-rule plumbing removed per v2.8.5)

## Right now — pick from the 8 deferred items below, or WhatsApp build

Each is small to mid-sized. Eight surfaced in the 3.0.7 morning session. Owner direction: propose-first per item, smaller/verified moves win.

### Deferred bug list (from 3.0.7 session — all real-day-observed)

1. **Dina 2-DMs (thread continuity)** — `message_colleague` opens a new top-level DM every call, even when there's a recent open conversation with the same colleague. Slack sidebar shows two parallel threads on the same topic. Fix is Path 2 stage 2 work: add `target_dm_channel` + `target_dm_thread_ts` to `requests` (or details_json), then in message_colleague send path: look up open colleague-initiated request for same `target_slack_id` within last N hours, post as thread reply if found.

2. **Shadow mirrors pre-gate draft** — `shadowNotify` fires from `core/orchestrator/index.ts:1867` BEFORE postReply.ts runs humanGate/securityGate/claim-checker. When humanGate rewrites a draft (e.g. scrubs a leaked `req_` ID), the shadow shows owner the LEAKY pre-gate version while the colleague gets the CLEAN post-gate version. Move shadow into `postReply.ts` after the gate stack, using the post-gate `cleanReply` variable.

3. **Multi-lang drift (L1)** — language-match rule is in the static prompt, Sonnet follows for turn 1 then drifts back to English on subsequent turns. Fix: code-side `detectMessageLanguage(text)` using Unicode-block ranges (Cyrillic/Hebrew/Arabic/Latin+diacritics), inject fresh per-turn LANGUAGE block into the dynamic prompt section.

4. **Social coda on FYI outreach (L3)** — when colleague replies to a transactional outreach (`intent='fyi'`/`'reminder'`/`'meeting_confirmation'`/etc.), Maelle still adds chatty social codas. Fix: gate `chooseSocialDirective` on `priorOutreachIntent` from the matched outreach row; skip engagement directive entirely for transactional intents. Pure DB enum check, no regex.

5. **Request-ID securityGate backstop** — Sonnet drafted `"There's already a pending approval for this exact request (#req_1779794031248_b3w7l)…"` and humanGate caught it. If humanGate ever fails open (Sonnet timeout, non-JSON), the leak ships. Add pattern `\b#?(req|task|coord|out|ci)_[a-z0-9_]+\b` to securityGate's trigger set. Regex on structured IDs is fine (different from regex on natural language).

6. **Coord auto-cancel on `create_meeting` success** — when a meeting gets booked outside the coord state machine (owner-direct create_meeting) AND there's an in-flight `coord_job` for the same subject/attendees, the coord_job stays alive and keeps DMing participants for slot selection. Add to `closeMeetingArtifacts`: detect orphaned coord_jobs by subject+attendees overlap, transition them to `cancelled` with `closure_reason='superseded_by_direct_create'`.

7. **Reply routing priority (Isaac msg_colleague vs coord)** — `recentOutboundContext` LLM classifier matched Isaac's "I can only do Monday and Thursday" reply to the message_colleague outreach instead of the coord_job that had also DM'd him 12 seconds later. Classifier should prefer coord over outreach when both have open context for the same colleague.

8. **planMeeting `propose_alternative` verdict for colleague-soft-rule slots** — currently when a colleague-proposed slot violates a soft rule (lunch/focus/work-hours), planMeeting returns `escalate_approval` and the colleague waits for owner approval. Owner direction: should first try to find alternatives nearby (same day, ±1 day). New verdict + handler path.

### Path 2 outreach-jobs migration (stages 2-6 remaining)

Stages 0+1 shipped in 3.0.4 (Stage 0: throw-aware tool summaries; Stage 1: duplicate `createRequest` block deleted). Remaining: stages 2-6 as originally scoped — migrate writers, migrate readers, drop outreach_jobs writes, drop the table. Deferred item #1 above (Dina thread continuity) is a natural Stage 2 hook — add the target-DM-thread fields while migrating writers.

### WhatsApp build (parked, return after Path 2 done or deferred items)

v3 was originally framed as the WhatsApp build — first non-Slack `Connection` implementation. Architecture is ready (skills never import from `connectors/slack/*`; everything routes through `getConnection(ownerId, 'slack')`). WhatsApp slots in as a parallel transport.

## WhatsApp build (parked, return after Path 2)

v3 was originally framed as the WhatsApp build — first non-Slack `Connection` implementation. Architecture is ready (skills never import from `connectors/slack/*`; everything routes through `getConnection(ownerId, 'slack')`). WhatsApp slots in as a parallel transport. Returns to top of the queue once the requests migration is done.

Read these two memory files at session start:
- `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_overview.md`
- `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/project_architecture.md`

Plus the feedback memories (cross-session rules the owner has set) — they auto-load via `MEMORY.md`.

---

## The two principles that govern every change

**1. Code over prompt.** Determinism belongs in code (rule checks, idempotency, location decisions, date alignment, approval sync, honesty signals). Judgment and tone belong in the prompt. When something can be code-enforced, code-enforce it; when something is judgment-class, leave it to the LLM. **The work direction is constant: prompt shorter, code more deterministic, let the LLM reason within fewer rails — not against them.**

**2. Tooling over new tools.** Before proposing a new tool or a new long prompt section: look first at the existing tooling. Can we extend a current tool's action enum? Can we replace a prompt rule with a code-side guard (claim-checker check, deterministic helper)? New tools and long prompts are the last resort, not the first.

---

## Bug-fix flow — never auto-fix

Every bug report follows the same four steps:

1. **Understand.** Read the screenshot / issue / chat report. Code-trace against current files on disk. Don't guess.
2. **Plan.** Identify root cause (file + line + mechanism). Map to the fewest possible changes.
3. **Suggest.** Write up the proposal: what's broken, where, what the fix is. Prefer prompt-tweak over new-rule; prefer extending an existing helper over a new file; prefer code-side determinism over a new prompt rule. Wait for owner feedback — he often re-frames or rejects the agent's first read, and that iteration IS the value.
4. **Build.** Only after explicit approval. Run typecheck. Stop. Summarize the uncommitted tree.

**Never bundle multiple fixes without owner saying so.** Default version bump is PATCH unless the owner explicitly says minor.

### The build-signal trap

The most-recurring drift pattern: the agent treats "owner is reporting/talking about bugs" as approval to fix them. **It is not.** Frustration, ALL-CAPS, "this is disappointing", "still broken" — these are **diagnostic signals**, not build signals. They mean **propose more thoroughly**, not **start typing code**.

Hard rules:
- **Only these are build signals**: "fix it" / "fix N" / "go build that" / "land it" / "do it" / "do A" / "build B" — applied to a SPECIFIC bug or fix shape. Never "OK", "yes", "go ahead" with no referent — those are ambiguous, ask.
- **NOT build signals**: bug reports, frustration, screenshots, "this should have been fixed yesterday", "doesn't make sense", "isn't it X?". When in doubt, propose and wait.
- **Reads are free, writes are not**: `gh issue view`, DB queries, log greps, code reads — never ask permission. But code edits, even small, need explicit per-bug build signal.

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

- **GitHub is the bug data source.** When the owner asks for a "bug pass" / "go over the github bugs" / etc., the `github` skill handles the triage flow.
- **NEVER open a GitHub issue unless the owner explicitly asks.** Surface bugs in chat or via the spawned-task chip; the owner files tickets himself.
- **Label axes**: Improvement uses High/Medium/Low; Feature uses Roadmap/Next/Idea. Never mix.
- **`gh` body files**: for any non-trivial issue/PR body, write to `C:/Users/idanc/AppData/Local/Temp/` first then pass `--body-file`. Inline HEREDOCs spam the chat.

The auto-triage GitHub Action exists but is currently **OFF** (gated `if: false &&`). Owner files issues / shows screenshots; we fix interactively.

---

## Slash-command skills

Procedures the owner runs frequently are wired as skills under `.claude/skills/`:

- **`github`** — bug triage. Pulls Bug-labeled open issues, code-traces, proposes fixes. Propose-first; never auto-fix.
- **`wrap`** — finish the session. Runs the full `.claude/WRAP_UP.md` checklist.
- **`scenario`** — paper-trace a numbered test scenario from `.claude/test-scenarios.md`. STRICT paper exercise — no live DMs, no calendar writes.
- **`bugs`** — analyze bugs the owner describes directly in chat. Propose-only.
- **`audit`** — deep parallel project audit. Spawns parallel subagents per subsystem. Returns an atomic-bug list with `file:line` citations. Propose-only.

---

## Operational state

- **PM2 + auto-deploy watcher are OFF.** Owner runs `npm run dev` directly. Restart needed to pick up code changes.
- **Auto-triage GitHub Action is OFF.** Bugs flow through chat.
- **`processedDedup` TTL is 10 minutes** — covers Slack socket-mode reconnect retry windows.
- **assistant.threads.setStatus** ("Working…" indicator) only fires in registered AI-panel threads on Slack DESKTOP. Mobile + regular DMs don't render it.

---

## Typecheck gotcha (still relevant)

When running from a Claude Code worktree under `.claude/worktrees/`, `npm run typecheck` checks the **worktree's stale source**, not the main repo. To get real coverage, always run project-mode tsc against the main repo:

```bash
npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json
```

Bigger architectural facts (Connection interface, requests spine, planMeeting / resolveLocation single-decision functions, four-layer model) live in `project_architecture.md`.
