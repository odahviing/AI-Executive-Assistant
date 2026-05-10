---
name: github
description: |
  Triage open Bug-labeled GitHub issues for the Maelle repo. Triggered when the owner says "let's go through the github bugs", "go over the issues", "github bugs", "fix bugs from github", "do a bug pass", "bug triage", or similar phrases that mean: pull the open Bug-labeled issues, identify the atomic bugs inside each, code-trace them against current files on disk, propose fixes, and STOP before fixing anything. This is propose-first, fix-after — never auto-fix. Owner approves bundle by bundle, ships everything in one commit + version bump at the end of the run via the wrap skill.
---

# GitHub bug triage

Use this skill when the owner wants to walk through open GitHub bugs in this repo. Strict propose-first flow — plan thoroughly, fix only after approval.

## Procedure

### 1. Pull the open bugs (Bug-labeled only)

```bash
gh issue list --state open --label Bug --json number,title,labels,createdAt,body
```

Feature requests (`Roadmap` / `Next` / `Idea`) are out of scope here. Skip them.

### 2. Identify ATOMIC bugs

A single GitHub issue often contains multiple sub-bugs. Number them:

- `77a`, `77b`, `77c` — sub-bugs inside issue #77
- Carry the severity label (High / Medium / Low) from the issue onto each atomic bug
- DO NOT group atomic bugs by severity — that mixes unrelated code areas

### 3. Code-trace each atomic bug — prove the cause

For every atomic bug:

- Read the current files on disk. Do NOT trust memory.
- Cite root cause as `file:line`.
- One short paragraph describing what's actually happening.
- **Prove it — don't assume.** If the symptom is timing-dependent or runtime-only, also check the logs:
  - Logs live under `logs/` (winston daily rotate). File pattern: `maelle-YYYY-MM-DD.log`
  - Grep for relevant function names, error messages, tool names
  - Useful diagnostic: `findAvailableSlots — rejection breakdown` for slot-finder issues
- If you're guessing, say so explicitly. Don't write "probably" without flagging it.

### 4. Reappearance check (mandatory)

Many "new" bugs are returns of previously-solved ones. For each atomic bug:

- Search `git log` for prior fixes addressing the same pattern.
- Search `memory/` files (project_overview.md, project_architecture.md, feedback_*.md).
- Search the existing code for related comments / earlier commits referencing the symptom.

If you find a prior fix:
- (a) What did the prior fix try?
- (b) Why didn't it stick?
- (c) What code or prompt rule needs to be REMOVED or REPLACED?

**Never stack a new layer on top of a rotting prior layer.** Delete the old layer and try again rather than piling on.

### 5. Bundle by code area / shared mechanism

Group atomic bugs into BUNDLES by code area or shared root mechanism — never by severity. The bundle is the unit of fix work; multiple atomic bugs touching the same file or sharing a root cause collapse into one fix run, one coherent commit.

One sentence per bundle stating the shared subject.

### 6. Fix-shape preference — small over big

Default to the smallest change that does the job. Priority order:

1. **Tool description edit** — most surgical. A one-line clarification often fixes model behavior without touching code.
2. **Prompt rule tweak** — modify an existing rule rather than adding new ones. Delete-a-rule-don't-add-one is in the standing rules.
3. **Small `if` condition** in code — a guard clause, a bypass, a fallback inside an existing handler.
4. **Helper function extracted** — small piece, reused, no new abstraction.
5. **New tool / new prompt rule** — last resort. When tempted, justify why a smaller change cannot do this.

Per atomic bug, write up:

- Short summary of what happened
- Root cause: `file:line`
- Severity (carried from the issue label)
- Reappearance note + reference to any prior fix
- Proposed fix shape: code vs prompt; what tier from the list above; what gets removed or extended

Tight entries. No format beyond this.

### 7. Order of bundles doesn't matter

Owner fixes area after area, then bundles everything into ONE final commit + version bump at the END of the run via the `wrap` skill. **Never bump version per bundle.**

## Anti-patterns

- ❌ Auto-fixing during the bug run. Propose first; owner says go before any code changes.
- ❌ Assuming the root cause without reading code or logs. Prove it.
- ❌ Reaching for a new tool / new prompt rule when a small edit to existing surface would do. Small over big.
- ❌ Stacking a new fix on top of a rotten prior fix without removing the prior one.
- ❌ Grouping bundles by severity instead of code area.
- ❌ Skipping the reappearance check on bugs that look "new" — many aren't.
- ❌ Bumping version per bundle. One bump at the end of the whole run.

## Closing the run — summary table FIRST

When every atomic bug has a resolution (fixed in tree, filed as a new issue, or explicitly deferred), print a summary table BEFORE asking about the wrap.

| # | GitHub | Severity | Status | Summary |
|---|---|---|---|---|

Status values:
- `fixed` — in tree, awaiting wrap commit
- `filed #N` — opened a new issue
- `deferred` — owner explicitly skipped
- `not fixed` — explicit owner direction not to fix

The "Summary" column is one to two short lines — owner reads this to remember what shipped before approving the wrap.

**After the table, wait for the owner to say "wrap" / "ship it" / "bump the version".** Never wrap unilaterally — the `wrap` skill takes over from there.

## When you're confused

If a bug doesn't fit any pattern (mislabeled feature request, two issues describing the same atomic bug, scope ambiguity), stop and ask the owner before guessing. Mislabels are part of the conversation.
