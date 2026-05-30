---
name: bugs
description: |
  Analyze bugs and improvements the owner describes directly in chat (not via the GitHub issue tracker — that's the `github` skill). Triggered when the owner says "couple of bugs", "morning bugs", "few bugs and improvements", "got some bugs", "some improvements", "i have a few things", "let me share some issues", or similar phrases that mean: I'm about to describe bugs in conversation and want analysis. STRICT propose-only flow — never auto-fix. Split each report into atomic bugs, code-trace each, prove the root cause (check logs when timing-dependent — don't assume), reappearance check (many bugs are returns of prior fixes; find out why the prior fix didn't stick), suggest fixes CODE-FIRST — fix at the core in code (a chokepoint guard / a return-value the model reacts to / a tool that owns the decision); prompt rules are a last resort for judgment/tone/format/language only, never for enforcement; avoid regex on natural-language text (Maelle is multi-lingual). Owner approves bundle by bundle, ships everything in one commit + version bump at the end via the `wrap` skill.
---

# Bug analysis from chat input

Use this skill when the owner is describing bugs / improvements directly in conversation, not via the GitHub issue tracker. The companion `github` skill handles the `gh issue list` flow.

## Strict rules

- ❌ **Never auto-fix.** Propose only. Owner approves before any code change.
- ❌ **Build signals are EXACT and per-bug.** Only an explicit, bug-specific "fix it / fix bug N / build it / do it / land it" means write code on THAT bug. A bare "yes / ok / go" with no bug reference is ambiguous — ask "go on N specifically?". "No, I want X different", "explain better", and "are you sure?" are REVISION requests, not build signals — write a new proposal, don't touch code. When in doubt, don't build: the cost of waiting is small; the cost of unwanted code is large.
- ❌ **Do reads without asking.** `git log`, log greps (`logs/maelle-YYYY-MM-DD.log`), `node scripts/db-query.cjs`, yaml/code reads, a temp read-only script — all free. Never ask "want me to verify X" — verify, then report. The owner is tired of granting permission for basic investigation.
- ❌ **No tier numbering or skill jargon in owner-facing summaries.** Don't say "tier 3 fix" / "small `if`" / "tier 4 helper". Describe the fix concretely: which file, which function, what's added vs deleted, in plain English.
- ❌ **Never assume the root cause.** Prove it via code reading and logs (`logs/maelle-YYYY-MM-DD.log`). If you're guessing, say so explicitly.
- ❌ **Code-first; the prompt is a budget, not a junk drawer.** Fix at the core in code — a chokepoint guard, a return-value the model reacts to, a tool that owns the decision. That's the durable, zero-prompt-cost fix. A one-line prompt patch Sonnet may ignore is NOT "smaller" than a code guard that holds. Touch the prompt only for judgment / tone / format / language, and NEVER to enforce something code could. Net prompt should go down, not up (we pulled the owner turn ~59k→~36k — don't regress it).
- ❌ **Avoid regex on natural language — Maelle is multi-lingual** (Hebrew, Russian, Spanish, English, …). A keyword/pattern regex on what a human typed works in English and silently fails in every other language. "Code-first" does NOT mean "regex-first." For meaning/intent → a Haiku classifier; for language/script → Unicode-block detection (e.g. `detectMessageLanguage`); for state → a structured-field / enum check. Regex is fine ONLY on language-independent STRUCTURED strings — IDs (`req_…`), emails, ISO datetimes, slack_ids — never on message text.
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

**FIRST, the reverse direction — is this already FIXED and just not closed?** An open issue (or a re-reported bug) is NOT proof the bug is live; many were fixed in a prior run and left open by oversight. Before proposing anything: confirm whether the fix is already present in current code (git log / CHANGELOG / the cited `file:line`) AND whether the reported symptom could still reproduce. If the fix is in place and the symptom can't reproduce → the output is **"already fixed — close it"**, NOT a new proposal. Do NOT hunt for residual edge cases on a fixed bug — manufacturing a fix where none is needed is the patch-on-patch trap. The trace must be allowed to conclude "nothing to do." (Especially when delegating to a sub-agent: "find the root cause and propose a fix" makes it invent one — frame it as "verify whether this still reproduces; if fixed, say so.")

Then, for bugs that DO still reproduce — many are returns of prior fixes. For each atomic bug:
- Search `git log` for fixes touching the same area
- Search `memory/` files (project_overview.md, project_architecture.md, feedback_*.md) for prior patterns
- Search the existing code for related comments or earlier commit references

If you find a prior fix:
- (a) What did the prior fix try?
- (b) Why didn't it stick? (most common: it patched the symptom, not the root cause)
- (c) What needs to be REMOVED or REPLACED to actually fix this — never stack a new layer on a rotting prior layer (RULE 2e v2.1.0 → v2.1.3 → v2.2.6 cautionary tale)

### 5. Suggest fixes — CODE-FIRST, smallest *durable* fix

The prompt is a fixed budget; growing it is the LAST resort, not the first. Default fix-shape preference:

1. **Core code enforcement** — a chokepoint guard, a return-value the model reacts to, or a tool that owns the decision. The rule lives in code: fixed once, stays fixed, zero prompt cost, language-agnostic. **This is the default.** (location → `resolveLocation`; slot alignment → `alignNearestQuarter`; language → `detectMessageLanguage`.)
2. **Small `if` / helper** inside an existing handler — the surgical version of #1. Reuse existing systems (requests spine, approvals payload, category flags) before adding new state.
3. **Tool description edit** — only when the bug is the model MISUSING a tool. The description is the tool's contract and ships only when the tool ships (scoped), so it's cheaper and safer than a global prompt rule.
4. **Prompt rule — LAST resort, judgment / tone / format / language ONLY.** Never to enforce something code could enforce. If you're adding a rule to make the model *do* a deterministic thing, the fix belongs in code. When you must touch the prompt, prefer DELETING an old rule alongside so net prompt doesn't grow.

Throughout: keep multi-lang in mind (see the no-regex-on-NL strict rule) — a fix that only works in English isn't a fix.

Per fix proposal:
- Which atomic bug it addresses
- Whether it's code or prompt (and if prompt, why code can't do it)
- Concrete shape — which file/function, what's added vs deleted, in plain English (no tier labels); show before/after if illustrative
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
- ❌ Proposing a fix for a bug that's already fixed-but-unclosed — verify it still reproduces against current code first; if it doesn't, the answer is "close it," not a patch
- ❌ Patching behavior with a prompt rule when code could enforce it (the patch-on-patch / prompt-bloat trap)
- ❌ Regex on natural-language message text — breaks the moment the user writes Hebrew/Russian/Spanish
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
