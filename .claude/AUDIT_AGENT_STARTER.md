# Maelle — Audit Agent Starter

Paste-and-go seed for a fresh audit chat. Self-contained: assumes zero prior context.

Project: **Maelle** — AI executive assistant, Node.js/TypeScript, monorepo at `E:\Code\Maelle`.
Version: **check `package.json`** (it's the source of truth; was 3.4.x at last audit). Stable line.

---

## ▶ THIS RUN STARTS WITH CLEANING — not bugs

The owner's first ask this cycle is a **quick cleanup pass**, NOT a bug hunt:

- **Dead code** — unused functions, unreferenced exports, retired-path imports, unreachable branches, orphaned files.
- **Unused functions** — defined-but-never-called (verify with grep, not assumption).
- **Duplicate / stacked comments** — the "3-4 comments piled on one code block" problem: collapse to ONE.
- **Outdated comments** — comments that contradict the current code (these are mini-bugs — a reader believes them and ships the next bug), or reference deleted features / wrong version numbers.

Goal: a leaner, more honest codebase. **Then the owner has further audit plans** (bug-focused waves, design review, etc.) — the full audit playbook below still governs those; this run just front-loads hygiene.

Deliver cleanup as **propose-first batches** the owner approves, exactly like a bug audit — same discipline, different target.

---

## HARD RULES (these govern every audit run, cleanup included)

### Propose / build / commit
1. **Propose-first. Build only on an explicit per-item "go"** ("fix it" / "do it" / "remove it" / "go"). Never bundle — approval on one item is NOT approval for its neighbors.
2. **A question is not a build signal.** "how does it happen?" / "is it real?" / "recheck" / "why only M?" mean *explain more*, not *start editing*.
3. **Never commit, version-bump, or write CHANGELOG without an explicit wrap word** ("wrap" / "ship" / "commit" / "cut a version"). The owner commits.
4. **Typecheck after every change**: `npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json` run from the repo root. NOT `npm run typecheck` from a `.claude/worktrees/` worktree — that checks stale source. EXIT=0 before moving on.

### Verify before you touch anything (the load-bearing rule)
5. **VERIFY-BEFORE-FLAG.** Audit subagents have a real false-positive rate — every round last cycle produced non-bugs (a "dead" function that was live, a "contradiction" that was correct, a fix already shipped). **Re-read the cited code against the current tree before proposing or removing.** Never act on a subagent claim you haven't personally confirmed.
6. **Don't manufacture edits.** If the target doesn't actually exist (e.g. "merge the stacks" but the file has no stacks), report "nothing to do." Do not churn good code to look productive.

### Cleanup-specific
7. **Dead code — verify ZERO callers before removing** (`grep -rn` the symbol across `src/`). A local `const`/function used only by a `void x;` line is dead. But **LEAVE the risky ones**: write-only DB columns, schema-column drops that need a table rebuild, defensive legacy `case` branches that protect old rows, owner-curated `scripts/`. When unsure, propose + explain, don't delete.
8. **Comments — remove-bad + merge-stacks, but KEEP HISTORY.** Two operations only:
   - Remove comments that **contradict the code** (stale model names, wrong TTLs, "falls back to 24h" when the code does otherwise, references to deleted functions) — highest value, they mislead.
   - **Merge a 3-4-comment stack on one block into ONE line — but keep a compact combined version ref** (e.g. `// v2.7.1 + v2.9.5 — <merged why>`). **Do NOT strip all version/issue provenance** — the owner wants the history kept; `git blame` is not an acceptable substitute. (This was the one mistake last cycle: a subagent stripped every `// vX.Y` tag wholesale; the owner reverted it. Keep single-version WHY comments exactly as they are — only PILES get merged, and even then the refs survive.)
   - Keep every genuine WHY / invariant / gotcha. The enemy is redundancy and contradiction, not provenance.

### Working style
9. **Atomic findings.** Each = one fix shape, with a `file:line` citation. No "somewhere in X" hand-waves.
10. **Route in-flight-feature bugs to the owning chat via a written prompt** — don't fix new code you don't own. (Last cycle: slot-holds → #30 chat; language → language chat.)
11. **Subagent cost-awareness.** A blank-check full-file comment-sweep subagent cost ~2.5h / ~289k tokens last cycle. For bulk-but-mechanical work, prefer targeted inline edits or a *tightly-scoped* subagent mandate (comment-only + typecheck-0 gate + "restore-from-HEAD" reference). Don't hand a subagent an open-ended file rewrite.
12. **When the owner disagrees with a finding, accept it and move on.** Several "bugs" are intentional design. Don't argue.

### Shell (from CLAUDE.md)
- Never prepend `cd <path>` to a command (triggers a sandbox prompt). Use absolute paths / `git -C`.
- No compound `;` / `&&` / `||` chains — one logical command per Bash call; independent commands as parallel tool calls.
- Never `node -e` / `node -p`. Use the Read tool for files, `scripts/db-query.cjs` for the DB.
- Prefer Bash over PowerShell for portable commands.

---

## HOW TO RUN AN AUDIT (the playbook — applies to cleanup AND the bug waves that follow)

### 1. Orient
- Read the top of `CHANGELOG.md` (recent versions) + `.claude/memory/project_overview.md` for current invariants. Without these, subagents flag already-fixed behavior as bugs.
- Read the most recent `.claude/*_HANDOFF.md` (last cycle's was `V3_4_0_AUDIT_HANDOFF.md`) for the do-not-re-flag list and the left-on-purpose list (below).
- `git status` — know what's uncommitted (there's usually in-flight feature work in the tree; don't attribute it or revert it).

### 2. Dispatch parallel subagents (one per subsystem, single message, multiple Agent calls)
Each subagent gets a self-contained prompt:
```
Maelle — Node/TS AI exec assistant, vX.Y.Z, E:\Code\Maelle. You are a <subsystem> auditor. Propose-only.
YOUR SCOPE: <subsystem>
FILES: <list>
KEY INVARIANTS (correct as of vX.Y — do NOT flag): <3-6 from CHANGELOG>
DO-NOT-RE-FLAG (already decided): <list>
GOALS: <for cleanup: dead code / unused fns / duplicate+outdated comments. for bugs: production / config leak / bad description / stale comment>
REQUIRED: read files (grep large ones); for bugs, paper-trace 2-3 scenarios; atomic findings w/ file:line; DO NOT edit.
OUTPUT (<2000 words): ### ID — Where / What / Bite / Fix. Group by category. If clean, say so.
```
**Cleanup framing**: tell each agent to hunt dead code + unused exports + comment debris in its files, and to grep for callers before calling anything "unused." A whole-tree cross-cutting agent always runs (`grep -rn` for orphans, contradicts-code comments, config leaks).

### 3. Synthesize
- **Dedupe** (same finding from two agents → one).
- **Verify each finding yourself** (Rule 5) — read the code. Drop the false positives explicitly.
- **Number atomically**, stable, owner references by number.
- **Rank**: for cleanup → dead-code (verified) / unused-functions / contradicts-code-comments (mini-bugs, do first) / comment-stack-merges / outdated-refs. For bugs → TOP (production teeth) / HIGH / MEDIUM.
- **Save a self-contained handoff** at `.claude/<NAME>_HANDOFF.md` (mission + state + full list + wave order), and **append a "SESSION N — what got fixed" block** as you build, so the next chat knows true state.

### 4. Subsystem map (fold in the newer files — the skill's map is slightly stale)
Booking (`skills/meetings.ts`, `meetings/ops.ts`, `planMeeting.ts`, `bookingRequest.ts`, `coord/*`, `detectCategory.ts`, `connectors/graph/calendar.ts`, `utils/scheduleRules.ts`, `resolveLocation.ts`, `meetingProtection.ts`) · Requests-spine/approvals (`core/requests/*` incl. `resolver.ts`, `runner.ts`, `reconcile.ts`, `deferredActionReplay.ts`, `closeRequest.ts`; `tasks/skill.ts`; `db/requests.ts`, `db/approvals.ts`) · Social (`skills/social.ts`, `core/social/*`, `db/socialSubjects.ts` [NOT `socialTopics.ts` — deleted], `db/engagementRank.ts`) · Persona/memory (`core/assistant.ts`, `assistantSelf.ts`, `memory/peopleMemory.ts`, `capturePass.ts`, `db/people.ts`, `resolveSlackId.ts`) · Venue (`skills/venue.ts`, `utils/venueSearch.ts`, `db/venues.ts`) · Floating blocks (`utils/floatingBlocks.ts`, `rebalanceFloatingBlocks.ts`) · Work hours (`utils/workHours.ts`, `effectiveToday.ts`, `config/userProfile.ts`) · News (`skills/news.ts`) · Thread actions (`core/threadActions/*`) · Slot holds (`db/slotHolds.ts` — #30, may still be in-flight) · Recovery/transport (`core/background.ts`, `connectors/slack/app.ts`, `socketWatermark.ts`, `inboundReplayRegistry.ts`, `processedDedup.ts`, `connectors/whatsapp.ts` [INERT scaffolding]) · Guards (`utils/humanGate.ts`, `claimChecker.ts`, `dateVerifier.ts`, `securityGate.ts`, `coordGuard.ts`) · Cross-cutting (whole `src/` sweep).

---

## STATE CARRIED FORWARD (do not re-do / re-flag)

### Already removed last cycle (don't hunt for them)
`getDueRequestsByHandler` (db/requests.ts), 5 unused `config` imports (claimChecker/humanGate/coordGuard/securityGate/briefIntent), `hhmmToMinutes` (ops.ts). `ops.ts` version-marker stacks already merged (refs kept).

### Dead code LEFT ON PURPOSE — do NOT propose removing again
- `proactive_pending` column (db) — dropping = risky rebuild.
- `last_participant_activity_at` on CoordJob — write-only, column-drop risky.
- `outreach_decision` case in `runner.ts` dispatchHandler — defensive for legacy rows.
- `scripts/deploy-watcher.mjs` — orphaned but owner-curated `scripts/`.
- `coord_jobs.status` / `outreach_jobs.status` — vestigial-but-intentional (Path 2 keeps the columns, status lives on the request).
- `(s: any)` annotation maps in `ops.ts` — pre-existing loose shape, not worth the churn.
- `connectors/whatsapp.ts` branches — inert-until-configured, not dead.

### Bug findings already ruled out (don't re-raise as bugs when you get to bug waves)
app_mention bot-author guard (owner: bots CAN call Maelle); multi-tenant panel scope R-1 (clone = new server); stranded-`in_progress`-task auto-reset (too risky); `isOutreachReplyByContext` fanout (won't happen); prefs `replace` data-loss; `move_meeting must_be_after_event_id` "overpromise" (false positive — it's not even on move_meeting); the `#80` `meetings.ts` `as any` cluster (deferred, don't sweep); Hebrew colleague-leak in securityGate (owned by the guards chat).

---

## The one-question test
Before proposing a finding: *"If the owner fixes only this, is it a single atomic edit?"* If no, split it. Atomic granularity is the value.
