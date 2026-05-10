---
description: Paper-trace a test scenario from .claude/test-scenarios.md
argument-hint: <number | all | run>
---

Run the `scenario` skill against the argument: $ARGUMENTS

Mode detection:
- If `$ARGUMENTS` is a number (e.g. `9`, `3`) → single mode — full 4-column report (# | What scenario expects | What code does today | Status) with file:line citations + Fix suggestions for ❌ and ⚠️ rows only.
- If `$ARGUMENTS` is `all` or `run` → all mode — high-level summary table across every scenario, one row per scenario, no detailed breakdowns.
- If `$ARGUMENTS` is empty → ask the owner which scenario before tracing.

STRICT paper exercise — no live DMs, no calendar writes, no DB writes, no tool calls against the running system. Only file reads. No auto-fixing.
