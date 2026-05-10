---
name: scenario
description: |
  Paper-trace one or all numbered test scenarios from .claude/test-scenarios.md against the current code on disk. Triggered when the owner says "scenario 9", "scenario 3", "test scenario N", "run scenario N", "simulate scenario N" (single-scenario mode); OR "scenario all", "scenario run", "run all scenarios", "test all scenarios" (all-scenarios mode). Single mode produces a detailed 4-column report with file:line citations + Fix suggestions. All mode produces a high-level pass/fail summary table across every scenario. STRICT paper exercise — no live DMs, no calendar writes, no DB writes, no tool calls against the running system. Only file reads. No auto-fixing — owner decides fix-now vs file-a-ticket.
---

# Scenario — paper code-trace test scenarios

Use this skill when the owner asks to test a specific scenario by number, or to run them all. Scenarios live at `.claude/test-scenarios.md`.

## Detect mode from the owner's message

**Single mode** — owner gave a number:
- "scenario 9", "scenario 3", "test scenario 9", "run scenario 9", "simulate scenario 9"
- → Run that one scenario, full detailed report

**All mode** — owner said "all" / "run":
- "scenario all", "scenario run", "run all scenarios", "test all scenarios"
- → Run every scenario in the file, output is a high-level pass/fail summary table only

If the owner's intent is ambiguous (e.g. they just said "scenario"), ask which one before tracing.

## CRITICAL — paper exercise only

Hard rule: **never execute a scenario for real.**

- ❌ No live DMs (no `message_colleague`, no Slack `chat.postMessage`, no Connection sends)
- ❌ No real calendar writes (no `create_meeting` / `move_meeting` / `delete_meeting` against Graph)
- ❌ No DB writes (no `INSERT` / `UPDATE` / `DELETE` against the SQLite store)
- ❌ No tool calls against the running Maelle system at all
- ❌ No auto-fixing inferred bugs — propose only; owner decides

The only allowed side effect is **reading source files**. Everything else is paper analysis.

---

## Single mode — detailed report

### 1. Read the scenario fresh

Open `.claude/test-scenarios.md`. Find the numbered scenario. Read it in full — do NOT trust memory or prior reports. Owner sometimes reframes scenarios mid-session; the file on disk is the truth.

### 2. Code-trace each checkpoint

For each discrete checkpoint in the scenario:

- Identify the relevant file(s) on disk.
- Read the actual code — don't reason from memory or the architecture doc.
- Determine what the code does today vs what the scenario expects.
- Cite `file:line` for everything.

### 3. Output the 4-column report

| # | What the scenario expects | What the code does today | Status |
|---|---|---|---|

Status values:
- ✅ **Works** — code matches scenario expectation
- ⚠️ **Partial** — works in some cases, fails in others (call out which)
- ❌ **Not working** — code does not produce expected behavior
- 🚫 **Shouldn't happen** — scenario expects something that violates a Maelle invariant; the scenario itself may be wrong

One row per discrete checkpoint. Each row **self-contained** with `file:line` citations — a reader shouldn't need to re-read the scenario or trace through code to understand the row.

### 4. Fix suggestions section — only for ❌ and ⚠️ rows

After the table, add a **Fix suggestions** section. Cover ONLY the ❌ and ⚠️ rows. Skip the ✅ ones.

Per fix suggestion:
- Which row it addresses
- Whether the fix is **code** or **prompt** (per the standing rule: code for determinism, prompt for judgment)
- Concrete shape — what gets removed, added, or changed
- Trade-offs if any

### 5. If a scenario beat reads as wrong, propose a rewrite

Sometimes a scenario expects something that doesn't match the owner's actual workflow — owner may have evolved the spec since the scenario was written. If a beat reads as "wrong":

- Mark the row ❌ or 🚫 as appropriate for the current code behavior
- ALSO propose a rewrite of the scenario beat in the Fix suggestions section
- Don't just rate it ❌ and move on — the scenario itself is editable

The owner is the source of truth for what the right behavior should be.

---

## All mode — high-level summary

### 1. Read every scenario

Open `.claude/test-scenarios.md`. Identify every numbered scenario (1, 2, 3, …). Don't skip any.

### 2. For each scenario, code-trace and form a verdict

For each scenario:
- Determine its overall status: ✅ / ⚠️ / ❌ / 🚫
- Pick the one or two most important findings — don't list every checkpoint
- Note `file:line` citations for any failing checkpoints

### 3. Output ONE high-level table

| # | Scenario | Status | Key finding |
|---|---|---|---|
| 1 | <one-line scenario summary> | ✅ / ⚠️ / ❌ / 🚫 | one-line headline + file:line if failing |
| 2 | … | … | … |

That's it for all-mode output. **Do NOT** produce 10 detailed 4-column reports back-to-back — the owner asked for a summary, not a flood.

### 4. After the summary table

One short paragraph: which scenarios need attention, recommended order to dig into them. No fix suggestions yet — owner picks one and re-runs in single mode for the detail.

---

## Anti-patterns (both modes)

- ❌ Trusting memory or the architecture doc instead of reading current files
- ❌ Auto-fixing what looks broken — propose only
- ❌ Running the scenario for real (live DMs, calendar writes, DB inserts) — paper only
- ❌ Skipping rows / scenarios that look fine without verifying via code read
- ❌ Suggesting fixes for ✅ rows (no fix needed; that wastes the owner's reading time)
- ❌ Rating a beat ❌ without considering whether the scenario itself drifted
- ❌ In all-mode: producing detailed per-scenario reports instead of the summary table
