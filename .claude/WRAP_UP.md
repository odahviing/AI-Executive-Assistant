# Wrap-up process

Trigger phrases from the owner: "wrap up", "close the patch", "cut a version", "day close", "let's ship" — all map to running this checklist.

## HIS STANDING ORDER — all of it is already given, do not ask for it again

Stated 2026-07-30 and again 2026-07-31, with the explicit request that it be encoded: **patch version · take the code from other chats too · nothing left uncommitted · close the GitHub issues that are fully resolved and COMMENT the ones that are not · restart Maelle.** The skill file (`.claude/skills/wrap/SKILL.md`) carries the same list — it is the short form, this is the procedure.

Three consequences the old checklist did not have:

- **Step 2 means the WHOLE tree.** `git status --porcelain` with no path filter, every chat's files, framework included. A commit holding only your own files is the defect, not a tidy scope.
- **Steps 12-13 are new and they are not optional.** The wrap used to end at the push and say "deploy when ready". It now ends with **Maelle running on the new sha** and the GitHub issues either closed or commented.
- **A verify overturn blocks the wrap; a discovery does not.** His ruling: *"if i do want to fix discoveries, its not blocker, its bonus."*

**Deploy is now AUTOMATIC and REMOTE — there is no local restart.** Maelle runs on the GCP VM; after the push, the VM's `maelle-deploy-watcher` pulls, builds, and restarts her within ~2 min. Do NOT `npm run deploy` / `pm2 restart maelle` (no local Maelle exists — starting one = a second Slack socket). Confirm the deploy from the VM's boot stamp: `powershell -File scripts/vm-logs.ps1 "starting up" 6`. The stamp's `gitSha` must equal **HEAD** (the *last* commit — a bookkeeping commit after the version commit shows that one).

**Timing:** not strictly end-of-day. Any time enough has accumulated to warrant a version bump. Typical shape: owner made bigger changes this session + auto-triage landed some bug fixes during the day → one wrap-up bundles both into a single version.

---

## What you're wrapping

Two sources of change since the last version tag:

1. **Auto-triage commits** — authored by `Maelle Auto-Triage`, one per fixed issue. Already pushed.
2. **Owner's session changes** — uncommitted staged/unstaged edits from the current session.

Most wrap-ups contain both. A few are pure-triage (owner off for a day, bugs auto-resolved). Rare case is pure-owner (no triage activity). The checklist handles all three.

---

## Checklist

### 1. Check there's something to ship

```bash
git log --author="Maelle Auto-Triage" <last-version-tag>..HEAD --oneline
git status
```

If BOTH are empty → say so and stop. Don't bump a version for nothing.

If either has content → proceed.

### 2. Inventory the changes

For **auto-triage commits**: `git show --stat <hash>` on each. Record:
- Issue number (grep commit message for `#\d+`)
- One-line summary (the commit subject minus any auto-triage preamble)
- Whether it's **high-impact** (see classifier below)
- Files touched (for architectural signal)

For **owner's uncommitted changes**: `git diff --stat` + `git diff` on anything suspicious. Record:
- What the owner built this session (pulled from conversation context + diff)
- Architectural touch-points
- New files / deleted files / renamed files

### 3. Classify high-impact vs small

**High-impact bug (gets its own CHANGELOG sub-entry + issue link):**
- Fixes a user-visible wrong behavior (wrong date, duplicate message, data loss, broken flow)
- Touches a core invariant (honesty guards, approval state, coord state machine, Connection boundary)
- Affects any safety layer (claim-checker, date-verifier, security gate, rate limits)
- Has a screenshot-worthy symptom (owner explicitly showed you the bug)

**Small bug (one-line bullet, grouped with siblings):**
- Typo, log message, minor prompt tweak
- Off-by-one in a non-critical path
- Stylistic / formatting
- Refactor without behavior change

When unsure → classify as high-impact. Better to over-link than to bury something load-bearing in a one-liner.

### 4. Decide the version bump

- **Patch (2.x.y → 2.x.y+1)** — only bug fixes + small improvements, no new capability. Most common for pure-triage days.
- **Minor (2.x → 2.x+1)** — owner shipped a meaningful new capability, new skill, significant behavior change, or schema migration. Common when owner + triage both contributed.
- **Major (2.0 → 3.0)** — never without explicit instruction.

Rule of thumb: when the CHANGELOG's first sentence needs to talk about a new thing (not just fix a thing), it's minor.

Owner said: *"I want every version to have big changes"* — which in practice means most wrap-ups will be minor bumps, because they'll include owner's session work on top of the day's triage fixes. Don't force-patch a minor-shaped wrap-up.

### 5. Update `package.json`

Single line change. Verify it with `grep version package.json`.

### 6. Write the CHANGELOG entry

**Structure** (top of file, above the previous entry):

```markdown
## <new version> — <one-line headline describing the biggest change>

<2-3 sentences explaining the main thing shipped this version — usually the owner's session work.>

### Added / Changed / Fixed / Removed / Migration
(use the sections that apply — skip empty ones)

### Fixed (high-impact, from auto-triage)
- [#N: Issue title](https://github.com/<owner>/<repo>/issues/N) — one sentence on what changed and why. (commit <short-sha>)
- [#N: Issue title](...) — ...

### Fixed (small)
- #N one-liner
- #N one-liner
- #N one-liner

### Invariants preserved (if architectural work)
### Not changed (if worth calling out)
### Migration (if any schema/config change)
```

**Rules:**
- One CHANGELOG entry per version bump — not per commit. Group the day's triage fixes under the same version as the owner's work.
- Topic-level description, not function-level. "create_meeting idempotent across turns" beats "added duplicate check in ops.ts".
- No date lines (git history has that).
- No bold on the section labels — the section header carries the emphasis.
- If ONLY triage commits and no owner work → headline is "day-N fixes" or similar; the 2-3 sentence intro describes the class of bugs resolved.

### 7. Update memory files (conditional)

Update `.claude/memory/project_overview.md` + `project_architecture.md` (also the owner's auto-memory at `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/`) if any of the following shipped:

- New skill / new core module / new Connection implementation
- New architectural primitive (registry pattern, new layer, new invariant)
- New safety layer (guard / verifier / dedup mechanism)
- A renamed / moved / deleted file that future-me needs to find
- A fact that contradicts what the memory currently says (version number, file path, behavior)

Do NOT update for:
- Simple bug fixes that don't change architecture
- Prompt tweaks
- Log message changes
- Pure refactors that don't move files

Keep memory punchy — edit existing lines, don't append history. If you add more than 3 lines, you're probably over-documenting.

### 8. Update `README.md` (conditional)

Update ONLY if architecture or public-facing behavior changed:
- New transport / Connection implementation (email, WhatsApp)
- New user-visible feature worth advertising
- File-tree changed significantly
- New setup step / new env var
- Changed roadmap items

Do NOT update for:
- Bug fixes
- Internal refactors
- Prompt tweaks

### 9. Typecheck

```bash
npm run typecheck
```

Must pass. If it doesn't, stop and fix — don't ship broken.

### 10. Commit + push under owner author

```bash
git add -A
git commit -m "<new version>: <same headline as CHANGELOG>

<2-3 sentence summary>

<if any high-impact fixes, list with issue numbers>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin master
```

Use the owner's author (not `Maelle Auto-Triage`). That makes the commit NOT trigger the deploy watcher auto-pull — owner deploys their own wrap-up commits manually (or via PM2 restart if changes affect the running process).

### 12. GitHub issues — close the resolved, COMMENT the rest

Close only when all three hold: verdict is `built`, the commit exists (close *after* the push, so the sha is real), and he said wrap.

```bash
gh issue close <n> --comment "Fixed in <sha> (v<version>). <one line on what changed>"
```

**The half that used to get skipped:** a ticket whose complaints are not all resolved does not close — it gets a comment naming what landed, what is still open, and why. Use `gh issue comment <n> --body-file <tmp>.md`; never inline a markdown body. A ticket is partial when the verify's `ticketCoverage` says so, or when its numbered complaints outnumber the issues emitted for it. **Never close a row the verify overturned**, or one he has not decided.

### 13. Restart Maelle and confirm the boot stamp

```bash
npm run build
```

```bash
pm2 restart maelle
```

Then read the stamp from the log, not the PM2 table:

```bash
grep -n "starting up" logs/maelle-$(date +%Y-%m-%d).log | tail -2
```

`gitSha` must equal HEAD. Confirm database ready, connection registered, **Slack connected**, email registered if enabled, and `grep -c '"level":"error"' logs/error-$(date +%Y-%m-%d).log` returns 0. Exactly one Slack socket — two processes on the same app give `too_many_connections`.

### 14. Summary back to the owner — verified against shipped

One short block: version and sha, the headline, **how many fixes shipped and how many were verified** with the reason each gap carried, which issues closed and which were commented, and the confirmed boot stamp. Not "deploy when ready" — it is already deployed by now.

---

## Edge cases

**What if auto-triage landed fixes that conflict with owner's in-flight work?**
- `git status` will show merge conflicts. Resolve them before committing. Prefer the more recent / more complete version; ask the owner if unsure.

**What if an auto-triage commit broke something?**
- If owner mentions a regression, investigate before wrapping. Don't ship a wrap-up that includes a known-bad auto-triage commit without first reverting it.

**What if the owner's session introduced a breaking change?**
- That's a minor bump, not a patch. Don't let patch-sized wrap-up habit downgrade a minor bump.

**What if multiple unrelated things shipped?**
- Still one CHANGELOG entry per version. Use the `### Added / ### Changed / ### Fixed` subsections to keep them visually separate. The headline picks the biggest.

**What if the owner wants to wrap WITHOUT a version bump (rare)?**
- Possible if nothing really changed (doc-only tweak). In that case: commit normally, skip package.json + CHANGELOG. Flag it in the summary: "No version bump — nothing material to ship."

---

## The one-question test

At the end of wrap-up, ask yourself: *"If someone reads the CHANGELOG in 6 months, do they know what shipped in this version and why?"*

If no → the entry needs more. If yes → you're done.
