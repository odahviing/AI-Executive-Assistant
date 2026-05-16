# Maelle session context

We're working on the Maelle project at `E:/Code/Maelle`. **Current version: v2.8.3** — check `package.json` if unsure; it is the source of truth.

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

## Where we are — v2.8.3 shipped

**Current phase**: prompt-reduction project ([#95](https://github.com/odahviing/AI-Executive-Assistant/issues/95)) + opportunistic consolidation. The 2.8 line has been all-in on the two governing principles above.

**v2.8.3 highlights**:
- New `venue` skill — external-venue discovery + per-owner rank catalog (1=hidden, 2=default, 3=favorite). Tavily-backed search; Google Places migration tracked at [#96](https://github.com/odahviing/AI-Executive-Assistant/issues/96).
- 5 tool consolidations: `manage_preference` (3→1), `manage_routine` (4→1), `manage_calendar_issue` (2→1), `manage_knowledge` (2→1), `update_task` (edit+cancel only — `create_task` stays separate because the claim-checker honesty rule references it by name). 13 owner tools → 5.

Earlier in the 2.8 line:
- **v2.8.2**: `resolveLocation` rewritten as a single deterministic decision tree; `planMeeting` `preserve_existing` verdict for moves within same day-type; meeting-room availability check.
- **v2.8.1**: Vertex AI prep (`LLM_PROVIDER` env var); multi-window work hours (split-shift days); 8 honesty rules code-replaced via extended claim-checker.

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
