# Maelle session context

We're working on the Maelle project at `E:/Code/Maelle`. **Current version: v3.0.0** — check `package.json` if unsure; it is the source of truth.

## Right now — v3.0 baseline, WhatsApp is next

v3.0 closed a 76-bug audit + scenario / morning-brief follow-ups across a two-day cleanup pass. ~1,500 lines of dead code removed, ~1,500 lines of fixes added. No new capabilities — pure consolidation.

**The v3 line going forward is the WhatsApp build** — first non-Slack `Connection` implementation. Architecture is already ready (skills never import from `connectors/slack/*`; everything routes through `getConnection(ownerId, 'slack')`). WhatsApp slots in as a parallel transport.

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
