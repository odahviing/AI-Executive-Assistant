---
name: github
description: |
  Triage open Bug-labeled GitHub issues for the Maelle repo. Triggered when the owner says "let's go through the github bugs", "go over the issues", "github bugs", "fix bugs from github", "do a bug pass", "bug triage", or similar phrases that mean: pull the open Bug-labeled issues, identify the atomic bugs inside each, code-trace them against current files on disk, propose fixes, and STOP before fixing anything. This is propose-first, fix-after — never auto-fix. Owner approves bundle by bundle, ships everything in one commit + version bump at the end of the run via the wrap skill.
---

# GitHub bug triage

Use this skill when the owner wants to walk through open GitHub bugs in this repo. Strict propose-first flow — plan thoroughly, fix only after approval.

## The five rules that override everything else

These came out of the 2026-05-18 incident where the agent built five fixes the owner had explicitly rejected. Read these before doing anything else:

1. **Build signals are EXACT and EXPLICIT, per bug.** Only these words mean "write code on this specific bug":
   - "fix it" / "fix bug N" / "go build that" / "land it" / "do it" / "build it" — applied to a SPECIFIC bug
   - The owner saying "yes" / "ok" / "go" with no bug reference is ambiguous; ask "yes on N specifically?"
   - **NOT build signals**: "No, I want X different" (this is a REJECTION asking for a revised proposal), "explain better" (this is asking for clarity, not code), "are you sure?" (this is challenging the proposal), "start with that" after rejections (this means "start by re-proposing those correctly")
   - When in doubt: do NOT build. The cost of waiting for confirmation is small; the cost of unwanted code is large.

2. **Do reads without asking.** `gh issue view`, `node scripts/db-query.cjs`, `git log`, log file grep, Graph API reads via a temp script — these are free. Never ask "want me to verify X" — verify, then report. The owner is tired of granting permission for basic investigation.

3. **No tier numbering or skill jargon when talking to the owner.** Don't say "tier 3 fix" / "small `if`" / "tier 4 helper". Describe the fix shape concretely: which file, which function, what's added vs deleted, in plain English.

4. **Regex-based scaling is suspect.** If a fix relies on regex to catch open-ended natural language input (intent, addressee, "did you X" phrasing, etc.), pause and propose alternatives — DB-side helpers, tool-result enrichment, intent classifier extensions, code-side determinism on the producer end. Regex over user input rarely scales to Hebrew, multi-clause sentences, indirect phrasings.

5. **No new prompt rules without explicit owner approval.** The project direction is `code over prompt`. v2.8.5 just rolled back Module F because broad LLM-judge layers were creating more problems than they solved. Existing prompt rules can sometimes be tightened (delete-don't-add). New ones are last resort. If proposing a prompt edit, say so clearly and wait for explicit OK.

## Procedure

### 1. Pull the open bugs (Bug-labeled only)

```bash
gh issue list --state open --label Bug --json number,title,labels,createdAt,body
```

Feature requests (`Roadmap` / `Next` / `Idea`) are out of scope here. Skip them.

### 2. Identify ATOMIC bugs

A single GitHub issue often contains multiple sub-bugs. Number them:

- `<issue number><lowercase letter>` in REPORT ORDER: `77a`, `77b`, `77c` — sub-bugs inside issue #77, lettered in the order they appear in the report
- These IDs are the conversation's shared vocabulary: the owner answers per-ID ("77b — fix it", "77c — explain more"), so once assigned, an ID must stay STABLE for the whole run — never renumber between messages, even after some bugs close
- Carry the severity label (High / Medium / Low) from the issue onto each atomic bug
- DO NOT group atomic bugs by severity — that mixes unrelated code areas

### 3. Code-trace each atomic bug — prove the cause

For every atomic bug:

- Read the current files on disk. Do NOT trust memory.
- Cite root cause as `file:line`.
- One short paragraph describing what's actually happening.
- **Prove it — don't assume.** If the symptom is timing-dependent or runtime-only, also check the logs:
  - **Logs live on the GCP VM she runs on, not here.** Read them with `powershell -File scripts/vm-logs.ps1 [term] [lines]` — same winston daily-rotate file (`maelle-YYYY-MM-DD.log`), reached over IAP SSH. The local `logs/` dir is STALE, frozen at the 2026-07-31 cutover; an empty result or a reader error means UNREACHABLE, never "it didn't happen".
  - Pass the grep term as the first argument — filtering runs on the VM, so only matches cross the wire
  - Useful diagnostic: `findAvailableSlots — rejection breakdown` for slot-finder issues
- If you're guessing, say so explicitly. Don't write "probably" without flagging it.

### 4. Reappearance check (mandatory)

**FIRST, the reverse direction — is this issue already FIXED and just not closed?** An open Bug issue is NOT proof the bug is live; many were fixed in a prior run and left open by oversight. Before proposing anything: confirm whether the fix is already present in current code (git log / CHANGELOG / the cited `file:line`) AND whether the reported symptom could still reproduce. If the fix is in place and the symptom can't reproduce → the output is **"already fixed — close it"** (`gh issue close N --comment …`), NOT a new proposal. Do NOT hunt for residual edge cases on a fixed bug — manufacturing a fix where none is needed is the patch-on-patch trap. The trace must be allowed to conclude "nothing to do." (Especially when delegating to a sub-agent: "find the root cause and propose a fix" makes it invent one — frame it as "verify whether this still reproduces; if fixed, say so.")

Then, for bugs that DO still reproduce — many "new" bugs are returns of previously-solved ones. For each atomic bug:

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

### 6. Fix-shape preference — CODE-FIRST, smallest *durable* fix

The prompt is a fixed budget; growing it is the LAST resort, not the first. A one-line prompt patch Sonnet may ignore is NOT "smaller" than a code guard that holds. Priority order:

1. **Core code enforcement** — a chokepoint guard, a return-value the model reacts to, or a tool that owns the decision. Lives in code: fixed once, stays fixed, zero prompt cost, language-agnostic. **Default.** (location → `resolveLocation`; slot alignment → `alignNearestQuarter`; language → `detectMessageLanguage`.)
2. **Small `if` / helper** inside an existing handler — surgical version of #1. Reuse existing systems (requests spine, approvals payload, category flags) before adding state.
3. **Tool description edit** — only when the bug is the model MISUSING a tool. The description is the tool's contract and ships only when the tool ships (scoped) — cheaper and safer than a global rule.
4. **Prompt rule — LAST resort, judgment / tone / format / language ONLY.** Never to enforce something code could. When you must touch the prompt, delete an old rule alongside so net prompt doesn't grow (we pulled the owner turn ~59k→~36k — don't regress it).

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
- ❌ Treating "No, I want X different" or "explain better" as a build signal. Those are revision requests — write a new proposal, do NOT touch code.
- ❌ Building MULTIPLE bugs from a single "go" / "ok" without per-bug confirmation. Each bug needs its own explicit instruction.
- ❌ Assuming the root cause without reading code or logs. Prove it.
- ❌ Asking permission for read-only investigation (Graph queries, DB SELECTs, log greps, yaml inspection). Just do them.
- ❌ Using tier numbering ("tier 3 fix") in owner-facing summaries. Describe shape concretely.
- ❌ Proposing a fix for an issue that's already fixed-but-unclosed — verify it still reproduces against current code first; if it doesn't, close it, don't patch.
- ❌ Patching behavior with a prompt rule when code could enforce it (the patch-on-patch / prompt-bloat trap). Code-first; the prompt is a budget.
- ❌ Regex-based pattern matching on open-ended natural-language input as a primary mechanism. Doesn't scale to Hebrew, multi-clause sentences, indirect phrasings.
- ❌ Stacking a new fix on top of a rotten prior fix without removing the prior one.
- ❌ Grouping bundles by severity instead of code area.
- ❌ Skipping the reappearance check on bugs that look "new" — many aren't.
- ❌ Bumping version per bundle. One bump at the end of the whole run.
- ❌ Writing "probably" / "likely" / "I think" with a confident shape underneath. Either prove it or say "uncertain" — never confident-wrong.

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

## Per-atomic-bug report format

For every atomic bug, write the report in this exact shape — no shortcuts:

```
### <id> — <one-line title>
- **What happened**: facts from logs / chat / DB. Quote actual phrasing where it matters.
- **What should have happened**: the contract, in one sentence.
- **Where the gap is**: file:line, verified against current files on disk (not memory).
- **Reappearance**: prior fix references from git log + memory files. If new, say "new pattern".
- **Suggested fix**: specific shape — which function, what's added/deleted, no jargon.
- **Tradeoffs / open questions**: anything the owner needs to decide before this can ship.
- **Broader process broken** (optional): which architectural surface this lives in — approval lifecycle / retry isolation / coord handoff / channel routing / etc. The owner cares about the architectural thread, not just the single fix.
```

Then the summary table at the end. Then **stop** — wait for per-bug build instructions.
