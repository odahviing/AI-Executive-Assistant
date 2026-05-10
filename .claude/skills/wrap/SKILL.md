---
name: wrap
description: |
  Finish the current working session by bundling the day's work into a version. Triggered when the owner says "wrap", "wrap up", "close the patch", "cut a version", "day close", "ship it", "let's ship", "let's finish for today", "bundle this", "let's commit", or similar phrases. This skill walks the full release checklist: bump package.json, write the CHANGELOG entry, update memory files if architecture changed, update README if public behavior changed, run typecheck, commit, push. Default version bump is PATCH unless the owner explicitly says minor or the work clearly calls for it. The detailed step-by-step lives at .claude/WRAP_UP.md — open it and follow it without improvising.
---

# Wrap — finish the session, ship a version

The owner has signaled they want to wrap the current session into a shipped version. The full procedure lives at `.claude/WRAP_UP.md` — open it, follow it step by step, do not skip steps.

## Quick orientation before opening WRAP_UP.md

The wrap bundles up to two sources of change since the last version tag:

1. **Auto-triage commits** authored by `Maelle Auto-Triage` (already pushed during the day).
2. **Owner's session changes** (uncommitted edits in the working tree).

Most wraps contain both. Pure-triage and pure-owner wraps happen too — the checklist handles all three.

## Standing rules — even before reading WRAP_UP.md

- **Default to PATCH.** Owner has corrected agent overreach to `minor` multiple times. Only bump minor if the owner explicitly says so or the work clearly calls for it (new skill, schema migration, meaningful new capability).
- **Owner is the gatekeeper for commit timing.** Even after a patch bump, do not commit until the owner says "commit", "ship", "bundle", or similar.
- **No major bumps without explicit instruction. Ever.**
- **Never skip hooks (`--no-verify`) or signing (`--no-gpg-sign`)** unless the owner explicitly asked for it.
- **`git add -A` only when the file list is clean.** If anything looks like a secret or large binary, stage explicitly by filename instead.

## Now — open WRAP_UP.md and run the checklist

Read `.claude/WRAP_UP.md` end-to-end. Run the 11-step checklist in order:

1. Check there's something to ship (`git log` since last tag + `git status`)
2. Inventory the changes (auto-triage commits + owner's diff)
3. Classify high-impact vs small bugs
4. Decide the version bump (patch vs minor)
5. Update `package.json`
6. Write the CHANGELOG entry (above the previous one)
7. Update memory files (conditional — only on architectural changes)
8. Update `README.md` (conditional — only on architecture / public behavior change)
9. `npm run typecheck` — must pass
10. Commit + push under the owner's author (not Maelle Auto-Triage)
11. Summary back to the owner — one paragraph

Do not improvise. The checklist is the way.

## The one-question test

At the end of the wrap, ask yourself:

> *"If someone reads the CHANGELOG in 6 months, do they know what shipped in this version and why?"*

If no → the entry needs more. If yes → you're done.
