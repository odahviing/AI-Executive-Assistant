---
name: golden
description: |
  Run the golden-path battery — the fixed 30-item unit-test floor in .claude/GOLDEN_PATHS.md — in full, on demand. Triggered when the owner says "golden", "run the golden paths", "golden check", "run the battery". The full battery runs once at the release checkpoint (WRAP_UP.md); ordinary package reviews use targeted regressions. This skill is the explicit standalone full-run entry point.
---

# Golden — run the golden-path battery

Every rule of the run — verdict vocabulary, evidence bar, paper-only, blocking semantics — lives in `.claude/GOLDEN_PATHS.md`'s own header. This file deliberately restates none of it (the wrap skill once kept a half-copy of WRAP_UP.md's checklist and ran wrong for seven releases).

**The one instruction:** apply WORKSHOP.md’s provider policy and dispatch the paper battery (Codex Sol medium; Claude SDK general-purpose Sonnet medium) with a brief that says to read `.claude/GOLDEN_PATHS.md` and run every item per its own header, returning one verdict per item plus `itemsInFile` — the same dispatch shape the automated paths use. Report the returned table to the owner. A `fail` is a finding for the owner (or, mid-wave, an overturn for the engine) — never auto-fix anything from this skill.
