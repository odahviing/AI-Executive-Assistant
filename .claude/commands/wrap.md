---
description: Finish the session — bump version, write CHANGELOG, typecheck, commit, push
---

Run the `wrap` skill to bundle this session's work into a shipped version.

Follow `.claude/WRAP_UP.md` step by step:
- Default to PATCH unless the owner explicitly said minor
- Write the CHANGELOG entry above the previous one
- Update memory + README only on architectural / public-behavior changes
- Typecheck must pass before committing
- Commit + push under the owner's author (not Maelle Auto-Triage)
