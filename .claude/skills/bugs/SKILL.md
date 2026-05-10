---
name: bugs
description: |
  Analyze bugs and improvements the owner describes directly in chat (not via the GitHub issue tracker — that's the `github` skill). Triggered when the owner says "couple of bugs", "morning bugs", "few bugs and improvements", "got some bugs", "some improvements", "i have a few things", "let me share some issues", or similar phrases that mean: I'm about to describe bugs in conversation and want analysis. STRICT propose-only flow — never auto-fix. Split each report into atomic bugs, code-trace each, prove the root cause (check logs when timing-dependent — don't assume), reappearance check (many bugs are returns of prior fixes; find out why the prior fix didn't stick), suggest fixes preferring small changes (tool description edit, prompt tweak, small `if`) over big changes (new tool, new prompt rule). Owner approves bundle by bundle, ships everything in one commit + version bump at the end via the `wrap` skill.
---

# Bug analysis from chat input

Use this skill when the owner is describing bugs / improvements directly in conversation, not via the GitHub issue tracker. The companion `github` skill handles the `gh issue list` flow.

## Strict rules

- ❌ **Never auto-fix.** Propose only. Owner approves before any code change.
- ❌ **Never assume the root cause.** Prove it via code reading and logs (`logs/maelle-YYYY-MM-DD.log`). If you're guessing, say so explicitly.
- ❌ **Never reach for a bigger fix than necessary.** Prefer a tool description edit, a prompt tweak, or a small `if` over a new tool / new module / new prompt rule.
- ❌ **Look at existing systems before proposing new state.** When you're tempted to add a new flag / new field / new tracking layer, FIRST scan the codebase for existing systems that already cover the case. Tasks have lifecycle. Approvals have payloads. Categories have flags. Outreach has status. The brief reads tasks-spine. If your fix can ride on something that's already there, ride. Inventing a parallel tracking system is the v2.x pattern that creates drift bugs later. When the owner says *"don't add new X — use what we have"*, your first reflex should already have been to scan for what's there.
- ❌ **Don't propose owner-facing notifications via shadow DM.** Shadow DM is a passive log only — the owner reads it like a feed, doesn't act on it. Any fix proposing "shadow-DM the owner about X" needs a real surface (DM, approval, brief item, task) instead.

## Procedure

### 1. Listen to what the owner pasted

The owner will paste or describe one or more bugs / improvements in chat. Read the full message before starting analysis.

### 2. Split into atomic bugs

Most messages contain multiple atomic bugs even when described as "a thing".

**Numbering format — dotted, two-level.** First number = the bug GROUP within this session (typically one per pasted message or topic the owner raises). Second number = the atomic bug INSIDE that group.

- Bug group 1, atomic bugs: `1.1`, `1.2`, `1.3`
- Bug group 2, atomic bugs: `2.1`, `2.2`, `2.3`
- Bug group 3, atomic bugs: `3.1`, `3.2`, `3.3`

Always dotted. Never letter-style (`1a`, `2/B`, `A.something`) — those get confusing fast across long multi-bug sessions. The dotted format reads cleanly when you're discussing "fix 3.3" or "is 2.1 a regression of 1.4?".

For each atomic bug capture:
- Symptom in one sentence
- Severity (your inference: High / Medium / Low — based on user impact)

### 3. Code-trace each atomic bug — prove the cause

Read the actual files on disk. Cite `file:line`. Don't reason from memory or the architecture doc.

If the symptom is timing-dependent or runtime-only, also check the logs:
- Logs live under `logs/` (winston daily rotate). File pattern: `maelle-YYYY-MM-DD.log`
- Grep for relevant function names, error messages, tool names
- Useful diagnostic: `findAvailableSlots — rejection breakdown` for slot-finder issues
- Owner-said-done scanner, claim-checker, security gate, etc. all log distinctively — search by name

State the root cause as `file:line — what's actually happening`. Avoid "probably" / "I think" without flagging the uncertainty.

### 4. Reappearance check (mandatory)

Many bugs are returns of prior fixes. For each atomic bug:
- Search `git log` for fixes touching the same area
- Search `memory/` files (project_overview.md, project_architecture.md, feedback_*.md) for prior patterns
- Search the existing code for related comments or earlier commit references

If you find a prior fix:
- (a) What did the prior fix try?
- (b) Why didn't it stick? (most common: it patched the symptom, not the root cause)
- (c) What needs to be REMOVED or REPLACED to actually fix this — never stack a new layer on a rotting prior layer (RULE 2e v2.1.0 → v2.1.3 → v2.2.6 cautionary tale)

### 5. Suggest fixes — small over big

Default fix-shape preference, smallest first:

1. **Tool description edit** — most surgical. A one-line clarification often fixes model behavior without touching any code.
2. **Prompt rule tweak** — modify an existing rule rather than adding new ones. Delete-a-rule-don't-add-one is in the standing rules.
3. **Small `if` condition** in code — a guard clause, a bypass, a fallback inside an existing handler.
4. **Helper function extracted** — small piece, reused, no new abstraction.
5. **New tool / new prompt rule** — last resort. When tempted, justify why a smaller change cannot do this.

Per fix proposal:
- Which atomic bug it addresses
- Whether it's code or prompt; which tier from the list
- Concrete shape — what gets edited; show before/after if illustrative
- Trade-offs if any

### 6. Bundle by code area

Group atomic bugs into BUNDLES by code area / file / shared mechanism — never by severity. The bundle is the unit of fix work; multiple atomic bugs touching the same place collapse into one fix run, one coherent commit.

One sentence per bundle stating the shared subject.

### 7. Closing the analysis — summary table FIRST

Print a summary table BEFORE asking about the wrap:

| # | Symptom | Severity | Root cause (file:line) | Reappearance | Proposed fix shape |
|---|---|---|---|---|---|

After the table, wait for the owner to say which bundles to fix (or "fix all"), or to push back on any analysis. Never start fixing until they explicitly say go. The `wrap` skill takes over for the final commit.

## Anti-patterns

- ❌ Auto-fixing without owner approval (the cardinal sin)
- ❌ Assuming root cause without reading code or logs
- ❌ Reaching for a new tool / new prompt rule when a small edit to existing surface would do
- ❌ Stacking a fix on top of a rotting prior fix
- ❌ Grouping bundles by severity instead of code area
- ❌ Skipping the reappearance check on bugs that look "new"
- ❌ Bumping version per bundle. One bump at the end via the `wrap` skill

## Difference from the `github` skill

| Trigger | Skill |
|---|---|
| Owner pastes / describes bugs in chat | **`bugs`** (this one) |
| Owner says "go over the issues" / "github bugs" / "let's do a bug pass" | **`github`** — pulls Bug-labeled GitHub issues via `gh issue list` |

The procedures are nearly identical — only the input source differs. Use `bugs` when the owner is feeding bugs through chat; use `github` when the source is the GitHub tracker.
