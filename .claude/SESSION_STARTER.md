# Maelle session context

We're working on the Maelle project at `E:/Code/Maelle`. **Current version: v3.0.3** — check `package.json` if unsure; it is the source of truth.

## Right now — Path 2: kill `outreach_jobs`, requests-spine becomes single truth

**Active task.** The 1M-token prior chat ended with the discovery of a critical silent-fail bug in `message_colleague` (Yael outreach never sent, Maelle still claimed "Sent the message to Yael. I'll let you know when she replies"). Root-caused to a duplicate `createRequest` and accepted as the trigger to finally finish the v2.7.0 → v2.7.1 requests-spine migration that's been half-done since v2.7.

Owner's words: *"don't care about the past, just care of finishing with the outreach and moving to 'request'"*. Path chosen: **Path 2** — kill `outreach_jobs` as a concept entirely; all outreach state lives in `requests`.

### The bug that triggered this (read once, then move on)

`outreach.ts:235` and `db/jobs.ts:150` both create a paired request row per `message_colleague` call (the v2.7.0 bridge and the v2.7.1 bridge — both written, neither deleted). The two rows have different subjects:
- `jobs.ts:150` bridge uses `subject = message.slice(0, 80)` — varies per call → idempotency_key naturally unique
- `outreach.ts:235` uses a generic `"Waiting for reply from X"` or `"Messaged X"` — IDENTICAL every time you message the same person → idempotency_key collides with any prior row that's still in the DB

For any colleague the owner has messaged before with the same `await_reply` value: first call worked, second call onward → UNIQUE constraint throws → `sendDirect()` never runs → Maelle reports "Sent" but message is lost. Claim-checker's shield treats tool-in-toolSummaries as success and skips the retry, so the lie surfaces unchecked.

### Scope of Path 2 (the migration)

Roughly 6-8 files, ~300 lines net:

- `requests.details_json` absorbs the outreach_jobs fields: `dm_message_ts`, `dm_channel_id`, `reply_text`, `scheduled_at`, `intent`, `proposed_slots`, `subject_keyword`, `colleague_tz`, `reply_deadline`. (Several are already there from the prior bridges.)
- `outreach.ts:message_colleague` calls `createRequest` directly. No `createOutreachJob`. One row per call.
- `db/jobs.ts` retired. The helpers — `createOutreachJob`, `updateOutreachJob`, `linkOutreachToRequest` — are either inlined into the call site or deleted. `coord_jobs` likely follows the same pattern (separate audit).
- `outreach_jobs` table dropped from `db/client.ts` schema. Old data discarded (owner: "don't care about the past").
- Dispatchers that read `outreach_jobs` get rewritten to read `requests`:
  - `tasks/dispatchers/outreachSend.ts`
  - `tasks/dispatchers/outreachExpiry.ts`
  - `tasks/dispatchers/outreachDecision.ts`
  - `connectors/slack/coordinator.ts` (handleOutreachReply path)
- The claim-checker shield needs updating too: toolSummaries should distinguish ran-and-succeeded vs ran-and-threw, so future tool-throw failures don't silently get treated as success. Tool summary should mark thrown calls as `[message_colleague FAILED: <reason>]`.

### Approach

This is real-refactor territory. Do it in stages, typecheck after each:
1. **Inventory** — find every read/write of `outreach_jobs`. Should be ~10-20 sites.
2. **Migrate writers first** — change every write to also write to requests (with the data in details_json). Keep outreach_jobs writes too as belt+suspenders during the transition.
3. **Migrate readers** — switch each dispatcher / coordinator to read from requests. Verify behavior matches.
4. **Drop outreach_jobs writes** — once all readers are on requests, stop writing to outreach_jobs.
5. **Drop the table** — schema removal in `db/client.ts`.
6. **Fix claim-checker shield** — last, in the same bundle.

Propose-first per step, especially steps 2/3 where behavior change risk is real. Don't big-bang. The owner has been clear that scope creep + over-engineering are the enemy; smaller, verified moves win.

### What's NOT in Path 2

- WhatsApp build (deferred — was the prior "next" but the outreach migration jumped the queue)
- `coord_jobs` migration (similar pattern, separate task)
- Backfill of past outreach_jobs data (owner: discard)

---

## Prior context (v3.0.3 fix-up bundle, already shipped)

Read these for what just landed:
- CHANGELOG entry for 3.0.3 + 3.0.3 fix-up (calendar-issue redesign, find_available_slots time-of-day support, KB on colleague path internal-only, claim-checker image awareness, ONE-CALL-PER-TIMEFRAME rule, config-driven duration default, slot-search toolSummary enrichment)
- Schema defaults pass (v3.0.4 prep): user.example.yaml rewritten in 2-section format (~23 required lines + advanced section all defaulted), dead fields removed (`priorities`, `vip_contacts`, `rescheduling`, several legacy meeting/schedule fields, `skills.general_knowledge`)

The schema defaults pass + dead field removal is **uncommitted** as of the chat handoff — `git status` will show the diff. Confirm with owner whether to commit before starting Path 2 or fold in.

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
