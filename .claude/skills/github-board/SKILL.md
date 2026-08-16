---
name: github-board
description: |
  Regenerates the "Backlog" artifact page from the live state of GitHub issues — this page is the owner's substitute for looking at GitHub directly, so coverage is the whole point. Triggered when the owner says "update the backlog", "refresh the board", "update the artifact", "sync the backlog page", "github board", or similar phrases meaning: re-fetch open issues and their blocked-by relations, rebuild the Next / Roadmap / Idea board, and republish to the existing artifact link. Classifies and tiers anything that's gone stale (no type label, or no tier and not blocked — often: just lost its blocker) where it confidently can; anything it can't place, including a bug hiding with no label, renders in a permanent "Needs a label" section on the page itself. Bugs are excluded on purpose — they're managed in separate bug waves — every other open issue is guaranteed to appear somewhere on this page: correctly placed, or visibly flagged. Reports what changed since the last run (opened / closed / relabeled / label fixes / newly classified) in chat, terse.
---

# GitHub board refresh

Rebuilds `.claude/skills/github-board/template.html` into a live snapshot of the open backlog and republishes it as the "Backlog" artifact.

## Procedure

1. **Run the generator.** From the repo root:
   ```bash
   node scripts/github-board.cjs .claude/skills/github-board/backlog.html
   ```
   This fetches every open issue + its blocked-by relations via `gh`, classifies each by type (Feature / Improvement / Framework — from its label), tier (Next / Roadmap / Idea — absent means blocked, nested under its blocker), and tags (Skill / Transport / Paid API), builds the three-column board, and writes the finished HTML to the given output path. **Along the way it enforces one rule directly on GitHub: if a blocked item still carries a tier label — drift from another chat, another session, anyone editing issues outside this skill — it removes that label.** A blocked item's position is inherited from its parent's tier, never its own; this is what keeps that true even when this skill isn't the only thing touching the tracker. It prints a JSON summary to stdout: `artifactUrl`, `opened`, `closed`, `relabeled`, `fixedLabels`, `needsClassification`, `warnings`.

1b. **Classify and tier anything the script surfaced in `needsClassification`.** These are items that are NOT blocked and have no tier — most commonly because they just lost their blocker (its parent closed), or they're a fresh issue nobody's labeled yet. The script deliberately does not guess here — it has no reading comprehension, only labels and relations. Each entry carries `number`, `title`, `type` (may already be set), and `body` (first 1500 chars). For each one:
   - **First check: is this actually a Bug wearing no label, not a Feature/Improvement at all?** Text describing something that used to work and broke, a regression, wrong/broken behavior — that's a Bug. Apply `gh issue edit <n> --add-label "Bug"` plus a severity (Low/Medium/High, your read of the text) and stop there — it belongs to the separate bug-triage flow, not this board, and the next run will correctly drop it off here once the Bug label is in place.
   - **If it's genuinely Feature or Improvement territory and `type` is missing**, decide from the body: **Feature** = a capability she doesn't do today at all; **Improvement** = an existing capability, being refined. Apply with `gh issue edit <n> --add-label "Feature"` (or `"Improvement"`).
   - **Decide the tier. Default to Roadmap.** Only use **Next** if the text itself signals real immediacy (already scoped, ready to build, explicitly urgent) — not just because it sounds important. Only use **Idea** if the text signals it's speculative or low-conviction (a "maybe," "not committed," "if we ever"). Everything else, including anything ambiguous, is Roadmap — that is the safe default, not a placeholder. Apply with `gh issue edit <n> --add-label "<Tier>"`.
   - **If you genuinely can't tell — not confidently Bug, not confidently Feature/Improvement, no real signal either way — leave it alone.** Don't force a label just to clear the list. It stays in `needsClassification`, which means it renders in the page's own "Needs a label" section — visible to the owner directly on the artifact, not just in this chat. That section exists specifically so nothing requires you to have gotten every call right this run; an unresolved item is still covered, just flagged instead of placed.
   - **Re-run the generator once more** after applying any labels, so the board reflects their real position instead of the pre-classification snapshot that excluded them.
   - If a body came back empty (the script's own best-effort fetch failed), open the issue yourself (`gh issue view <n>`) before deciding — never tier, or decide Bug-vs-not, from the title alone.

2. **Publish.** Call the Artifact tool on that output path.
   - If `artifactUrl` in the JSON summary is non-null, pass it as `url` so this updates the SAME page rather than minting a new one.
   - If it's null (first run ever, or the stored link was lost), publish without `url`, then **write the returned URL into `.claude/skills/github-board/state.json`'s `artifactUrl` field** — the script can't do this itself, only you know the URL after the Artifact call returns.

3. **Report, terse.** Lead with what changed, not a re-description of the page:
   - If `opened`/`closed`/`relabeled`/`fixedLabels`/`needsClassification` were all empty: "No changes since last refresh." — one line, done.
   - Otherwise list each non-empty bucket in one line: `Opened: #N title. Closed: #N title. Relabeled: #N title (was X/Y, now A/B). Fixed: #N — removed stale "Roadmap" (blocked by #5). Classified: #N — Improvement/Roadmap (lost its blocker when #198 closed).`
   - If `warnings` is non-empty, surface each one plainly — these are issues the script couldn't confidently place for reasons beyond step 1b (an orphaned block pointing at a closed issue, etc). Never silently drop a warned item off the board; relay what it found.

## What this skill does NOT do

- Never edits a GitHub label except two enforcement cases: stripping a stale tier off a blocked item (fully mechanical, no judgment), and classifying/tiering an item in `needsClassification` (step 1b — real judgment, done by the agent running this skill, always reported).
- Never touches tags or blocked-by relations themselves — those are never inferred, only the type and tier labels are.
- Never guesses from the title alone. Step 1b reads the actual body before deciding anything; a body that can't be fetched means opening the issue directly, not skipping the read.
- Never touches the Workshop/naming-history artifact — that's a separate page this skill has no relationship to.
