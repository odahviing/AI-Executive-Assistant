# Maelle session context

We're working on the Maelle project at `E:/Code/Maelle`. **Current version: v2.8.5** — check `package.json` if unsure; it is the source of truth.

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

## Where we are — v2.8.5 shipped, bug-wave patch including Module F rollback

**Current phase**: the predicted bug wave landed on 2026-05-17 with one big cross-thread incident that surfaced two compounding root causes (inboundQueue using the wrong runner on buffered messages + the Module F judge injecting topic-switch directives into retry_instruction when the conversation context looked mismatched). Both fixed; Module F's retry path is **rolled back** at owner's direction; the eight honesty prompt rules v2.8.1 deleted in favor of Module F are **restored verbatim**. Module F + E booleans still fire as telemetry — we keep visibility into what they catch — but the verdict no longer triggers retries. Only RULE A (`claimed_action`) drives retries from here on.

**v2.8.5 highlights** (one-day bug wave, ten fixes bundled):
- inboundQueue: each `PendingMessage` carries its own runner. `scheduleRun` uses the LAST message's runner instead of the outer-closure runner. Closes cross-thread contamination when buffered messages drain after an un-abortable write turn.
- Module F retry path **deleted** in `postReply.ts` (~60 lines). Booleans still in `claimChecker.ts` as telemetry. RULES 1/2/2b/2c/2d/3/5b/9 restored in `systemPrompt.ts`. REFUSAL PHRASING stays in humanGate (Module C — separate rollback decision if ever needed).
- planMeeting freebusy: new `priorSlotEndIso` param; overlap loop skips source event's prior window (60s tolerance). Fixes "move 13:00→13:15 falsely flags Onn busy because the meeting being moved overlaps the new slot." excludeEventIds stays on the rule-check path (different mechanism, doesn't apply to Graph's getSchedule).
- Active mode `missing_floating_block` respects recent owner deletions. `delete_meeting` audit_log enriched with `event_start_iso`; new `recentAuditEntries({ action, windowDays })` helper in `db/client.ts` does a tiny SELECT (last 14 days, ≤10 rows in practice). Generic — pattern reusable for other "respect owner's recent instruction" checks.
- New `researchPreCheck.ts` — owner-path regex on `explore X` / `research X` / `look into X` / `what's new with X` / `tell me about X` runs `web_search` deterministically before the main turn, injects results as a context block. `manage_knowledge` tool description tightened ("INSUFFICIENT ALONE FOR EXPLORE/RESEARCH").
- Routine dispatcher: placeholder-then-update pattern via new `updateMessage` + `deleteMessage` primitives. Routines no longer use synthetic `routine_${id}_${ts}` threadTs — they post `"Working…"` first, capture real ts, run orchestrator with that, then `chat.update` (or `chat.delete` on silent/throw). Status indicator now works during routine tool runs.
- Assistant-panel status: `isAssistantThread` gate dropped at both orchestrator call sites. Slack rejects non-panel calls; the existing try/catch swallows at debug. Status indicator now works on panel threads that missed registration.
- Brief ACTION ITEMS section removed; replaced with a ONE-PLACE RULE for narration. Open items now appear once, in the most natural surface.
- Legacy skill toggle cleanup: `persona`/`scheduling`/`coordination`/`meeting_summaries`/`knowledge_base`/`calendar_health` deleted from the toggles map after auto-migration. No more once-per-process "enabled in profile but not available" warnings.

**Earlier in the 2.8 line**:
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
