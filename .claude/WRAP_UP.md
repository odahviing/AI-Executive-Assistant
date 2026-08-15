# Wrap-up process

Trigger phrases from the owner: "wrap up", "close the patch", "cut a version", "day close", "let's ship" — all map to running this checklist.

## HIS STANDING ORDER — all of it is already given, do not ask for it again

Stated 2026-07-30 and again 2026-07-31, with the explicit request that it be encoded: **patch version · take the code from other chats too · nothing left uncommitted · close the GitHub issues that are fully resolved and COMMENT the ones that are not · restart Maelle.** The skill file (`.claude/skills/wrap/SKILL.md`) carries the same list — it is the short form, this is the procedure.

**THIS FILE IS THE PROCEDURE AND THE ONLY NUMBERED COPY OF IT.** Three entry points — `.claude/commands/wrap.md`, `.claude/skills/wrap/SKILL.md` and the Manager's `wrap` verb — all delegate here, so a step that is missing here is a step that does not run. The skill used to number the checklist too, one step short and one number out of step; the wrap therefore ran for seven releases with no bookkeeping at all. **They name steps, this file numbers them** — when a step changes, it changes here.

Four consequences the old checklist did not have:

- **Step 2 means the WHOLE tree.** `git status --porcelain` with no path filter, every chat's files, framework included. A commit holding only your own files is the defect, not a tidy scope.
- **Step 9 and the stamp at step 11 are the bookkeeping, and they are what gets skipped.** The ledger append is the only moment the day's history can be lost; the stamp is what stops the next run reporting a release nothing stands behind. `node scripts/ledger-stats.cjs --report` is green or the wrap is not finished.
- **Steps 12-13 are not optional.** The wrap used to end at the push and say "deploy when ready". It now ends with **Maelle running on the new sha** and the GitHub issues either closed or commented.
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

### 9. Bookkeeping — the ledger BEFORE the report

**This is the only moment the day's history can be lost, and it has been lost exactly this way.** The append once named only the *wrapped* rows while the reset took everything, so a row he had already RULED ON died with the file: `slot-hold-release-dm-role-gate` was recorded on `report.md` as *"deferred — owner: not important for now"*, the report was emptied at the 4.3.1 wrap, and `ledger.jsonl:253` still carries it as `needs-owner-decision` — so `--open` lists a decision he has already made as one he has never seen. Do these three in this order:

1. **Append EVERY row on `.claude/agent-loop/report.md` to `.claude/agent-loop/ledger.jsonl`** — whatever its verdict, not only the built ones. Two fields on every row, and both exist because this step dropped them:
   - **`"runId":"wrap-<version>"`** — without it `node scripts/ledger-stats.cjs --wrap <version>` cannot name a release's own rows, and the built-list check reaches back past the release to count everything since the last stamp.
   - **`"recommend":"<verb> — <one clause>"`** on every row that is not `built`. It is sitting in the Status cell you are about to delete — *"pending owner — recommend build"* becomes `"recommend":"build — <the clause>"`. Skip it and the row survives in a form he cannot rule on, which is how **54 of 56** standing open rows got there. A `deferred` or `declined` row also carries **his words** in `note`, or the counter he gave dies with the cell.
   - **A `built` row this wrap ships also needs a `state:"wrapped"` companion row — NOT here.** This step runs *before* step 11's commit exists, and "shipped" means a real sha to point at; nothing at this point in the checklist can honestly claim it yet — an instruction here that cannot be performed here is worse than no instruction. That companion row is minted at **step 12**, together with the GitHub sync, once the commit is real. (X152's own note guessed the gap this closes also explains `alreadyBuilt` matching 0 of 94 refs one night — checked and **refuted**: `bugger.js`'s triage match is pure LLM judgment over the `ref`/`rootCause` text handed to it, with no code path that reads `state` at all. Keep the two as separate defects.)

2. **Then reset `report.md` — never before the append.** An emptied report **still carries its headline**: run `node scripts/ledger-stats.cjs --open` and write its open total and split into that line. Empty means no rows, not *"nothing is waiting on you"*. **And the leading, bolded clause is the RULABLE figure from that same command, never the wrap's own delta** — see SKILL.md's "NEVER PRINT A ZERO YOU DID NOT COMPUTE" (X194): `**<n> rows await you** — v<version> wrapped, 0 new from this wrap.` An all-clear phrasing is correct **only** when RULABLE is genuinely 0. `node scripts/ledger-stats.cjs --report` checks this against the standing backlog now, not only against the (trivially empty) table.

3. **Then reduce `state.json` to the keys documented in `.claude/skills/manager/SKILL.md` "State you own".** The append you just made is what makes the run's notes deletable, so this is the one moment it costs nothing.

**Check the append in one command:** `node scripts/ledger-stats.cjs --open` must not name the rows you just wrote.

The third marker this step is owed is **not on a row** — it is `state.lastWrapIso`, and it is set at **step 11**, because its value is the release commit's own timestamp and that commit does not exist yet here.

### 10. Typecheck

```bash
npm run typecheck
```

Must pass. If it doesn't, stop and fix — don't ship broken.

### 11. Commit + push under owner author — then stamp the wrap

```bash
git add -A
git commit -m "<new version>: <same headline as CHANGELOG>

<2-3 sentence summary>

<if any high-impact fixes, list with issue numbers>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin master
```

Use the owner's author (not `Maelle Auto-Triage`).

**Then stamp the wrap, in the same turn as the push.** The wrap leaves **two** markers and they describe the same fact — *which release this wrap shipped*:

- `"runId":"wrap-<version>"` on every row appended at step 9.
- `state.lastWrapIso` — the release commit's own timestamp:

```bash
git log -1 --date=iso-strict --format=%ad     # -> .claude/agent-loop/state.json `lastWrapIso`
```

Write that value straight into `.claude/agent-loop/state.json`; it ships in the bookkeeping commit, which is what keeps standing order 3 (*nothing uncommitted*) true. It is what `ledger-stats --report` below checks a release commit against. **5 of 7 wraps skipped it; on 2026-08-01 it stood two releases behind.** (It is **not** the cleaner's clock — that is `lastCleanSha`, a separate watermark advanced by the dispatching chat, X131.)

**The check, and it is one command:**

```bash
node scripts/ledger-stats.cjs --report
```

It exits 1 naming any release commit that neither marker stands behind, and it checks the report's own headline counts against the ledger at the same time. **A green `--report` is the acceptance test for this step — do not finish the wrap on a red one.**

**gh#197 — a second check, same moment: did every builder dispatch actually leave a row?** SlackMaster was hand-dispatched three times on 2026-08-10 (real turns, real cost, real shipped code) and left zero ledger rows — the only trace of its work survived as a sentence inside a different lane's row. `node scripts/check-dispatch-coverage.cjs --since <last-wrap-date>` compares `spend.cjs`'s own record of what ran against `ledger.jsonl`'s record of what was reported, per builder lane per day, and exits 1 naming any lane-day with real turns and no row at all. **Run it before this step's commit** — a missing row found after the push is a backfill; found before, it is one line.

**A third check, same moment: did tonight's own comment edits break a line-number citation?** `wave-comment-edits-broke-stale-line-citations` was the 2nd occurrence of the identity — a code comment cites `file.ts:NNN` for where a behaviour lives, an edit to that file shifts its lines, the citation goes stale — inside a 31x `stale-mechanism-comment` pattern, caught until now only by a bouncer noticing during an unrelated pass. `node scripts/check-stale-citations.cjs` scans every comment/doc in the repo for a `file.ts:NNN`-shaped citation and reports only the ones whose TARGET is a file this session touched (working tree vs HEAD, plus untracked adds) — cheap and precise, because the only way a citation goes stale here is a line shift in the file it's pointed at. It exits 1 naming each one: a symbol named nearby whose own declaration has drifted more than 25 lines from the cited anchor, or (weaker, stated as such) a citation reaching past the target's own EOF. **Run it before this step's commit**, same reasoning as gh#197 — `--all` runs the identical check with no target filter, for an occasional full sweep outside a wrap.

### 12. GitHub issues — close the resolved, COMMENT the rest

Close only when all three hold: verdict is `built`, the commit exists (close *after* the push, so the sha is real), and he said wrap.

**gh#196 — check the comment BEFORE it ships, not after.** gh#194's closing comment claimed *"the three live rows already corrupted by this bug were cleaned up directly"* — the fix's own ledger row said the opposite, and the false claim then got copied into the ledger's own gh-sync row too. Draft the comment body to a temp file first, then:

```bash
node scripts/check-closing-claims.cjs --issue <n> --body-file <tmp>.md --refs "<every ledger ref this comment is actually about>"
```

Pass `--refs` explicitly whenever a row's own `ref` was not tagged `gh#<n>` at filing time (it will not always be — that link then lives only in your own head while drafting) — the check cannot find a row it has no name for. It exits 1 naming any sentence that asserts something a ledger row's `note` explicitly denies; it is a heuristic (word-overlap, not a proof), so a flag is a prompt to re-read both, not an automatic rewrite. **Green, then close:**

```bash
gh issue close <n> --comment "Fixed in <sha> (v<version>). <one line on what changed>"
```

**The half that used to get skipped:** a ticket whose complaints are not all resolved does not close — it gets a comment naming what landed, what is still open, and why. Use `gh issue comment <n> --body-file <tmp>.md`; never inline a markdown body. A ticket is partial when the verify's `ticketCoverage` says so, or when its numbered complaints outnumber the issues emitted for it. **Never close a row the verify overturned**, or one he has not decided.

**X152/X158 — two appends, same moment, same input (this wrap's `built` rows and `ticketCoverage`), done together right here now that the sha exists:**

1. **Every `built` ref this wrap's own commits actually ship gets a companion row — a SEPARATE line, never a mutation of the original:** `{"date":"<today>", "runId":"wrap-<version>", "ref":"<same ref>", "verdict":"wrapped", "state":"wrapped", "note":"shipped in <sha>"}`. **`verdict:"wrapped"`, not `"built"`** — a row carrying both on one line answers its own check and is exactly the shape the acceptance test below now refuses. Closes the 313-`built`-vs-18-`wrapped` gap (measured 2026-08-04) — nothing else durably tells "in the tree, uncommitted" from "deployed weeks ago" without re-reading `git log` per ref by hand.

2. **Whatever GitHub gets, the ledger gets the identical statement — never a second, independent copy of the prose.** For every issue touched above: `{"date":"<today>", "runId":"wrap-<version>", "ref":"gh#<n>", "state":"closed"|"partial", "note":"<the exact text gh issue close/comment sent, verbatim>"}`. `state` is the FACT GitHub shows; do not hardcode a verdict off it. **A closed ticket is `"verdict":"wrapped"`** — never `"built"`: that verdict means "a fresh atomic fix," and a bare ticket ref carrying it falsely demands a companion row nothing will ever mint. **A partial ticket is unfinished work more often than it is a question for him — pick the verb the comment's own "why" actually supports**: `"recommend":"build — <the remaining piece>"` when it just needs another round, `"recommend":"defer — <what it waits on>"`, or `"verdict":"needs-owner-decision"` only when the comment itself says he must choose something. Pairing every partial with `needs-owner-decision` regardless of why would put unfinished-but-routine work on his desk that a lane could simply pick back up — and a row still awaiting his decision is never closed on GitHub in the first place (rule above), so it correctly contributes nothing here to check against. A closed-or-commented ticket with no matching row is why *"a wave ships and the source GitHub issue is never closed or even updated, and nothing reports where a ticket stands"* took him a full day to notice himself.

**COMMIT THESE ROWS before you check them — the check reads git history, not the working tree.** `git add -A && git commit -m "<version> bookkeeping: file <tickets> closes/comments" && git push`, riding alongside (or as) step 11's `lastWrapIso` bookkeeping commit. **The check, one command, run AFTER that commit — extends the same one already run at step 11:**

```bash
node scripts/ledger-stats.cjs --wrap <version>
```

Two lines, `BUILT -> WRAPPED` and `GITHUB <-> LEDGER SYNC`, report against this wrap's own committed rows and name any ref or ticket the two appends above missed, plus a `MUTATION-SHAPED` line if a row carries both `verdict:"built"` and `state:"wrapped"` at once. **It exits 1 on any of the three — do not call the wrap finished on a red exit**, same acceptance-test convention as `--report` at step 11.

**A third check runs in the same command: `PHANTOM CANDIDATES`.** 16 of 23 build-ready backlog rows going into the 4.5.0 wrap were bugs that wave's own diff had already fixed under a *different* ref — found by hand, after the fact, because nothing here ever cross-referenced the shipped diff against the standing backlog. `--wrap <version>` now does: it cross-references every currently-open ledger row against the files this wrap's own commits touched (plus a shared `invariant` with a row this wrap closed, plus a ref appearing in this wrap's own commit subjects), and prints any hit as a candidate. **It never auto-closes.** Verify each against the CURRENT tree, cite the exact `file:line` that makes the original failure impossible, and close it with `node scripts/ledger-file.cjs --verdict already-fixed`. If a candidate is genuinely a distinct, still-open bug, append a `{"date":"…","ref":"…","recheck":"…"}` line dated today or later so it stops being reflagged — it stays open, it just stops being asked about at every future re-run of this wrap's own check. This is the OPPOSITE direction from `alreadyBuilt` (which guards intake against re-filing a shipped fix as new); this guards the standing backlog against staying open after a later wave silently closed it.

### 13. Confirm the boot stamp — the push already restarted her

**Build and restart nothing here.** The push at step 11 is the deploy: the VM's `maelle-deploy-watcher` pulls, builds and restarts her within ~2 min (header, and `SESSION_STARTER.md:149`). Read the stamp from the log, not the PM2 table — **the log is on the VM she runs on; the local `logs/` dir is STALE (frozen at the 2026-07-31 cutover) and grepping it confirms nothing**:

```bash
powershell -File scripts/vm-logs.ps1 "starting up" 6
```

`gitSha` must equal HEAD. Confirm database ready, connection registered, **Slack connected**, email registered if enabled, and that `powershell -File scripts/vm-logs.ps1 error 40` shows no errors since the restart. Exactly one Slack socket — two processes on the same app give `too_many_connections`. If the reader errors (`Reauthentication failed` → the owner runs `gcloud auth login`), the deploy is UNCONFIRMED — say so rather than reporting a clean boot.

If the sha is still old after ~3 min, read the watcher rather than restarting anything:

```bash
gcloud compute ssh maelle-agent-vm --zone=europe-west4-b --tunnel-through-iap --command "pm2 logs maelle-deploy-watcher --lines 20 --nostream"
```

### 14. Summary back to the owner — verified against shipped

One short block: version and sha, the headline, **how many fixes shipped and how many were verified** with the reason each gap carried, which issues closed and which were commented, and the confirmed boot stamp. Not "deploy when ready" — it is already deployed by now.

A lane may reasonably skip its own bouncer pass and it is often right; the defect is the decision being invisible at the last gate before real people see the change. So say *"6 shipped, 4 verified"* and list the two with the reason each carried, straight out of its ledger `note`. **One field, never a justification** — making the skip expensive to declare pushes lanes into asking for passes they do not need.

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
