---
name: github-board
description: |
  Regenerates the "Backlog" artifact page from the live state of GitHub issues. Triggered when the owner says "update the backlog", "refresh the board", "update the artifact", "sync the backlog page", "github board", or similar phrases meaning: re-fetch open issues and their blocked-by relations, rebuild the Next / Roadmap / Idea board, and republish to the existing artifact link. Read-only against GitHub — it never edits labels or issues, only reads and renders. Reports what changed since the last run (opened / closed / relabeled) in chat, terse.
---

# GitHub board refresh

Rebuilds `.claude/skills/github-board/template.html` into a live snapshot of the open backlog and republishes it as the "Backlog" artifact.

## Procedure

1. **Run the generator.** From the repo root:
   ```bash
   node scripts/github-board.cjs .claude/skills/github-board/backlog.html
   ```
   This fetches every open issue + its blocked-by relations via `gh`, classifies each by type (Feature / Improvement / Framework — from its label), tier (Next / Roadmap / Idea — absent means blocked, nested under its blocker), and tags (Skill / Transport / Paid API), builds the three-column board, and writes the finished HTML to the given output path. It prints a JSON summary to stdout: `artifactUrl`, `opened`, `closed`, `relabeled`, `warnings`.

2. **Publish.** Call the Artifact tool on that output path.
   - If `artifactUrl` in the JSON summary is non-null, pass it as `url` so this updates the SAME page rather than minting a new one.
   - If it's null (first run ever, or the stored link was lost), publish without `url`, then **write the returned URL into `.claude/skills/github-board/state.json`'s `artifactUrl` field** — the script can't do this itself, only you know the URL after the Artifact call returns.

3. **Report, terse.** Lead with what changed, not a re-description of the page:
   - If `opened`/`closed`/`relabeled` are all empty: "No changes since last refresh." — one line, done.
   - Otherwise list each bucket that's non-empty in one line: `Opened: #N title. Closed: #N title. Relabeled: #N title (was X/Y, now A/B).`
   - If `warnings` is non-empty, surface each one plainly — these are issues the script couldn't confidently place (no type label, no tier and not blocked, blocked by something already closed). Never silently drop a warned item off the board; the script already put it in a visible bucket or flagged it — just relay what it found.

## What this skill does NOT do

- Never edits a GitHub label, tier, or relation — read-only, always. If the owner wants a label changed, that's a normal `gh issue edit`, not this skill.
- Never invents classification. An issue with no Feature/Improvement/Framework label, or no tier and no blocker, is reported as a warning and left off the board rather than guessed into a column.
- Never touches the Workshop/naming-history artifact — that's a separate page this skill has no relationship to.
