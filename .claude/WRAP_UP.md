# Wrap-up process

Trigger phrases from the owner: "wrap up", "close the patch", "cut a version", "day close", "let's ship" — all map to running this checklist.

## HIS STANDING ORDER — all of it is already given, do not ask for it again

Stated 2026-07-30 and again 2026-07-31, with the explicit request that it be encoded: **patch version · take the code from other chats too · nothing left uncommitted · close the GitHub issues that are fully resolved and COMMENT the ones that are not · restart Maelle.** The skill file (`.claude/skills/wrap/SKILL.md`) carries the same list — it is the short form, this is the procedure.

**THIS FILE IS THE PROCEDURE AND THE ONLY NUMBERED COPY OF IT.** Three entry points — `.claude/commands/wrap.md`, `.claude/skills/wrap/SKILL.md` and the Manager's `wrap` verb — all delegate here, so a step that is missing here is a step that does not run. The skill used to number the checklist too, one step short and one number out of step; the wrap therefore ran for seven releases with no bookkeeping at all. **They name steps, this file numbers them** — when a step changes, it changes here.

Five consequences the old checklist did not have:

- **Step 1 claims the tree before anything else runs.** Nothing here ever wrote `state.json.lastRun`, so a wrap in progress was invisible to the one lock a `run` checks before dispatching anything — confirmed by `wf_f81323f1-791`'s own note: *"Landed mid-wrap, which forced the pre-wrap Fable pass and golden battery to be re-run over the grown tree."* Thirty seconds' different timing and a cron-fired `run` would have built onto a tree the wrap had already committed over.
- **Step 3 means the WHOLE tree.** `git status --porcelain` with no path filter, every chat's files, framework included. A commit holding only your own files is the defect, not a tidy scope.
- **Step 10 and the stamp at step 11 are the bookkeeping, and they are what gets skipped.** The ledger append is the only moment the day's history can be lost; the stamp is what stops the next run reporting a release nothing stands behind. `node scripts/ledger-stats.cjs --report` is green or the wrap is not finished.
- **Steps 12-13 are not optional.** The wrap used to end at the push and say "deploy when ready". It now ends with **Maelle running on the new sha** and the GitHub issues either closed or commented.
- **A verify overturn blocks the wrap; a discovery does not.** His ruling: *"if i do want to fix discoveries, its not blocker, its bonus."* Step 4's battery-then-Fable pass is this rule's own standing enforcement point, not a separate one.

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

### 1. Claim the tree — the same lock a `run` checks, for the wrap's entire duration

**Before anything else, read `.claude/agent-loop/state.json`.** If `lastRun.status === 'running'` or `inFlight` is non-empty, a bugger/feature run is live on this tree right now — STOP, say which run, and wait; do not touch a file. This is `manager/SKILL.md`'s own STOP 1 / STOP 2, and it is the check the wrap has to pass too: a wrap starting mid-`run` and a `run` starting mid-wrap are the same collision, and one gate now covers both directions.

Clear, then claim the SAME field a `run` sets on itself — no new key, nothing to keep in sync with the real one:

```json
"lastRun": {"id": "wrap-<start time, ISO>", "status": "running", "note": "manual wrap in progress"}
```

Until this shipped, nothing here ever wrote `lastRun`, so a wrap in progress was invisible to the one mechanism built to stop exactly this. From the moment this is set, a cron-fired `run` refuses at its own STOP 2 exactly as if a second Workflow were already running — because as far as that check can tell, one is.

**Release it only at step 12**, once every commit this wrap makes has landed: set `"status": "complete"`. **If the wrap dies before that**, the field is left `"running"` forever — the identical failure a killed Workflow run already leaves, and it takes the identical fix, no second recovery path invented for it: the next session to read it treats a running wrap exactly as STOP 2 already treats a running Workflow (may be live, wait, never resume on your own), and only the owner's explicit word turns it into `"stopped"`. There is nothing to `resumeFromRunId` here — a wrap is not a Workflow run, and there is no background process that could still be "slow" once he confirms it dead. On his word, set `"stopped"` and re-open this checklist from wherever `git log` / `git status` shows it actually got to.

### 2. Check there's something to ship

```bash
git log --author="Maelle Auto-Triage" <last-version-tag>..HEAD --oneline
git status
```

If BOTH are empty → say so and stop. Don't bump a version for nothing.

If either has content → proceed.

### 3. Inventory the changes

For **auto-triage commits**: `git show --stat <hash>` on each. Record:
- Issue number (grep commit message for `#\d+`)
- One-line summary (the commit subject minus any auto-triage preamble)
- Whether it's **high-impact** (step 6's classifier — it picks the CHANGELOG section, nothing else)
- Files touched (for architectural signal)

For **owner's uncommitted changes**: `git diff --stat` + `git diff` on anything suspicious. Record:
- What the owner built this session (pulled from conversation context + diff)
- Architectural touch-points
- New files / deleted files / renamed files

### 4. Release checkpoint — one full Golden30 and independent accumulated-diff review

Settle the accumulated tree before writing the version bump or CHANGELOG. Reuse a completed checkpoint only when its evidence and reviewed file snapshot still match; a bugger run with `releaseCheckpoint: true` can supply its full battery, so do not dispatch it again here. An ordinary package run explicitly defers Golden30 and does not supply a release pass. Engine `verification.packageReady` means its package passed independent review; `wrapReady` additionally requires the complete fixed Z1–Z30 release inventory. Feature’s external checkpoint keeps its engine `wrapReady` false; establish release completion here from the actual checkpoint evidence.

1. Run `npm run test:release -- --out <new-evidence-directory>` once on the accumulated source snapshot. It executes every discovered `scripts/test-*.cjs` suite, expands timezone suites across the existing three host zones without repeating the aggregate, and runs typecheck. Inspect each new suite for network, live writes or unsafe side effects before execution; isolate fixtures or return it to its owner, never silently exclude it. Its `report.json` must say `passed`; final red tests, skipped checks, timeout, missing output or source changes block wrap.
2. Before review, save stdout from `node scripts/workshop-release.cjs --golden-snapshot` as a new evidence snapshot file. Dispatch one independent Bouncer, separate from the builders, to review the full accumulated diff and affected dependencies AND execute all Golden30 items under GOLDEN_PATHS.md’s header. Keep product/audit/framework scope separate, each Z1–Z30 result individually evidenced, and model-dependent residue explicit. Apply WORKSHOP.md’s Codex dispatch policy; manual Claude SDK Bouncer keeps its native Fable override. If either complete review already exists on the unchanged snapshot, reuse that evidence and ask only for the missing scope. The Claude SDK engines retain their separate `releaseCheckpoint` battery dispatch; this manual combination does not change engine behavior. Explicit standalone `golden` also remains available.

After review, run `node scripts/workshop-release.cjs --golden-report <saved-snapshot.json> <reviewer-return.json>` and save its stdout beside the return as `golden-report.json`. It copies the existing `itemsInFile`/`goldenTraces` fields verbatim and attaches the saved source hashes and actual retained-output hash; it never captures a replacement snapshot. Run `node scripts/workshop-release.cjs --check-golden <golden-report.json>` before proceeding. The snapshot covers release executable source and the Golden catalog. The checker requires exact Z1–Z30 coverage, pass/stale-anchor verdicts, per-item evidence, matching retained output and current hashes; it checks completeness/integrity, not the truth of a paper trace or model obedience. Independent Bouncer still owns that judgment and the accumulated-diff verdict. Neither half can waive a failure in the other.

An overturn blocks wrap. Reuse the builder to repair it, update step 3’s inventory, invalidate the affected checks and run targeted independent rechecks including dependencies. Keep the unaffected checkpoint evidence. Record changed file hashes, dependency impact, invalidated check IDs and their replacement results against the final source inventory; unbounded impact requires the full executable/paper checkpoint again. A targeted recheck supersedes only its named affected checks, never an unrelated failure. Run `node scripts/workshop-release.cjs --check <report.json>` to test exact reuse; a mismatch requires the recorded impact/recheck evidence, never editing the old report into a pass. A discovery remains next-run intake unless the owner adds it to this release. Neither skipped checks nor old failures become passes by omission.

Before proceeding, persist every implementation and independent review using the Manager verification contract, then run `node scripts/ledger-stats.cjs --verification`. Exit 1 blocks wrap. Missing/failed regression evidence, incomplete boundary coverage, old review attempts or changed snapshots remain blocking. The cost policy never waives independent review or this gate.

### 5. Decide the version bump — and write it into `package.json`, one act

- **Patch (2.x.y → 2.x.y+1)** — only bug fixes + small improvements, no new capability. Most common for pure-triage days.
- **Minor (2.x → 2.x+1)** — owner shipped a meaningful new capability, new skill, significant behavior change, or schema migration. Common when owner + triage both contributed.
- **Major (2.0 → 3.0)** — never without explicit instruction.

Rule of thumb: when the CHANGELOG's first sentence needs to talk about a new thing (not just fix a thing), it's minor.

Owner said: *"I want every version to have big changes"* — which in practice means most wrap-ups will be minor bumps, because they'll include owner's session work on top of the day's triage fixes. Don't force-patch a minor-shaped wrap-up.

The `package.json` edit is this decision executed, not a separate judgment: single line change, verify it with `grep version package.json`.

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
### Framework (other chats, bundled)
(architect/framework-only work shipped alongside this version — engines, charters, the Manager skill, agent-loop tooling. Never Maelle's own behavior.)
```

**Classify each fix high-impact vs small — this picks which `### Fixed` section its bullet lands in, nothing else:**

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

**Rules:**
- One CHANGELOG entry per version bump — not per commit. Group the day's triage fixes under the same version as the owner's work.
- **Always use the `### Framework` heading for architect/framework-only work, never fold it into `Changed`/`Added`.** This is what lets a future charter review grep one heading across releases instead of reading every entry's full prose to find undecided product decisions — the architect ledger already tracks these separately; this is the changelog's own mirror of that split.
- Topic-level description, not function-level. "create_meeting idempotent across turns" beats "added duplicate check in ops.ts".
- No date lines (git history has that).
- No bold on the section labels — the section header carries the emphasis.
- If ONLY triage commits and no owner work → headline is "day-N fixes" or similar; the 2-3 sentence intro describes the class of bugs resolved.

### 7. Update memory files (conditional)

Keep architecture facts in `.claude/memory/project_architecture.md`, the canonical architecture memory. `.claude/memory/project_overview.md` carries product orientation and links to it; SESSION_STARTER and ARCHITECTURE_MAP remain navigation. Auto-memory copies at `C:/Users/idanc/.claude/projects/E--Code-Maelle/memory/` should contain pointers to these repo sources, not independently maintained architecture bodies. Preserve an existing body in a dated archive before replacing it with a pointer, after checking for its active writer. Update the relevant canonical source if any of the following shipped:

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

### 9. Confirm the final release snapshot

Reuse step 4’s executable regression/typecheck result when its snapshot still matches (`node scripts/workshop-release.cjs --check <report.json>`). Version, documentation or bookkeeping-only changes require recorded hash/impact reconciliation; code or dependency changes require the affected executable checks and a fresh typecheck. Preserve the original evidence and record replacement results; never run the full suite again solely because the checklist reached this step.

The final executable result must pass. If it doesn't, stop and fix — don't ship broken. A fix here lands AFTER step 4's verify and step 6's CHANGELOG: if it changes behavior, invalidate affected checks and apply step 4's targeted recheck rule; if it changes what shipped, reopen step 6's entry — then come back. This step runs BEFORE the bookkeeping on purpose: the books close at step 10, and a gate that can force more work runs before the step that closes them.

### 10. Bookkeeping — preflight, then the ledger BEFORE the report

**Before the first commit, preflight the release bookkeeping.** Draft the report counts and dispositions from the actual ledger, the writer command arguments (refs, version, run/review IDs and evidence files), and GitHub closing/partial-comment bodies. Check refs and coverage against the independent review, derive counts with `ledger-stats --open`, inspect the writer's accepted arguments, and run step 12's closing-claims check on each body. Keep SHA-dependent fields visibly unresolved in drafts; never execute a wrapped/gh-sync append or claim a release timestamp before its real commit exists. Save the checked drafts for steps 11–12.

Use `node scripts/workshop-release.cjs --bookkeeping-plan <refs.json> --version <version>` to draft the selected ledger refs (a JSON string array). Save stdout as the plan: it supplies exact current review payloads and native-writer argv arrays, disposition drafts, counts, and the untouched report for reconciliation. A blocked plan cannot proceed. Reconcile every report row and owner ruling; the helper does not infer decisions from prose or prove selected refs exhaust release scope. `node scripts/workshop-release.cjs --check-bookkeeping <plan.json>` must return `current-draft` before the first append. Materialize the supplied review JSON files and pass argv arrays to the native writer from the repo root; disposition drafts still require its validation. Regenerate after any write or interrupted batch; entries already stamped with this wrap run ID have null argv and must not be replayed. The helper is read-only: companions and real-SHA/postcommit checks remain at steps 11–12.

Run `node scripts/check-dispatch-coverage.cjs --since <last-wrap-date>` and `node scripts/check-stale-citations.cjs` before this first commit; resolve failures while the tree is still open. Preflight complements every mandatory postcommit `--report`, `--wrap` and boot-stamp check below. Final SHA substitution or changed evidence requires rechecking the affected draft before publication.

**This is the only moment the day's history can be lost, and it has been lost exactly this way.** The append once named only the *wrapped* rows while the reset took everything, so a row he had already RULED ON died with the file: `slot-hold-release-dm-role-gate` was recorded on `report.md` as *"deferred — owner: not important for now"*, the report was emptied at the 4.3.1 wrap, and `ledger.jsonl:253` still carries it as `needs-owner-decision` — so `--open` lists a decision he has already made as one he has never seen. Do these three in this order:

1. **Use the ledger writer to append EVERY current disposition on `.claude/agent-loop/report.md` to `.claude/agent-loop/ledger.jsonl`.** Shipping refs keep their evidence and exact independent review: re-append that review with `--review --ref <ref> --runId wrap-<version> --review-file <review.json>`; do not recreate a bare `built` row that discards verification. **Append every disposition** — whatever its verdict, not only the built ones. Two fields on every row, and both exist because this step dropped them:
   - **`"runId":"wrap-<version>"`** — without it `node scripts/ledger-stats.cjs --wrap <version>` cannot name a release's own rows, and the built-list check reaches back past the release to count everything since the last stamp. (This is the ledger's own per-release tag, unrelated to step 1's `state.lastRun.id`, which is the wrap's live-lock marker and never touches `ledger.jsonl`.)
   - **`"recommend":"<verb> — <one clause>"`** on every row that is not `built`. It is sitting in the **Your options** cell you are about to delete — *"Recommend: build — …"* becomes `"recommend":"build — <the clause>"`. Skip it and the row survives in a form he cannot rule on, which is how **54 of 56** standing open rows got there. A `deferred` or `declined` row also carries **his words** in `note`, or the counter he gave dies with the cell.
   - **A `built` row this wrap ships also needs a `state:"wrapped"` companion row — NOT here.** This step runs *before* step 11's commit exists, and "shipped" means a real sha to point at; nothing at this point in the checklist can honestly claim it yet — an instruction here that cannot be performed here is worse than no instruction. That companion row is minted at **step 12**, together with the GitHub sync, once the commit is real. (X152's own note guessed the gap this closes also explains `alreadyBuilt` matching 0 of 94 refs one night — checked and **refuted**: `bugger.js`'s triage match is pure LLM judgment over the `ref`/`rootCause` text handed to it, with no code path that reads `state` at all. Keep the two as separate defects.)

2. **Then reset `report.md` — never before the append.** An emptied report **still carries its headline**: run `node scripts/ledger-stats.cjs --open` and write its open total and split into that line. Empty means no rows, not *"nothing is waiting on you"*. **And the leading, bolded clause is the RULABLE figure from that same command, never the wrap's own delta** — see SKILL.md's "NEVER PRINT A ZERO YOU DID NOT COMPUTE" (X194): `**<n> rows await you** — v<version> wrapped, 0 new from this wrap.` An all-clear phrasing is correct **only** when RULABLE is genuinely 0. `node scripts/ledger-stats.cjs --report` checks this against the standing backlog now, not only against the (trivially empty) table.

3. **Then reduce `state.json` to the keys documented in `.claude/skills/manager/SKILL.md` "State you own".** The append you just made is what makes the run's notes deletable, so this is the one moment it costs nothing.

**Check the append in one command:** `node scripts/ledger-stats.cjs --open` must not name the independently verified rows; implemented, failed and unproven rows remain open and block wrap.

The third marker this step is owed is **not on a row** — it is `state.lastWrapIso`, and it is set at **step 11**, because its value is the release commit's own timestamp and that commit does not exist yet here.

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

- `"runId":"wrap-<version>"` on every row appended at step 10.
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

Step 10 already checked dispatch coverage and stale citations before the first commit. If subsequent edits invalidate either check, rerun the affected check before the bookkeeping commit.

### 12. GitHub issues — close the resolved, COMMENT the rest

Close only when all three hold: the current ref is independently `verified`, the commit exists (close *after* the push, so the sha is real), and he said wrap.

**gh#196 — publish the checked body.** Reuse step 10's draft file, substitute the real release SHA, and check the final body before it ships:

```bash
node scripts/check-closing-claims.cjs --issue <n> --body-file <tmp>.md --refs "<every ledger ref this comment is actually about>"
```

Pass `--refs` explicitly whenever a row's own `ref` was not tagged `gh#<n>` at filing time (it will not always be — that link then lives only in your own head while drafting) — the check cannot find a row it has no name for. It exits 1 naming any sentence that asserts something a ledger row's `note` explicitly denies; it is a heuristic (word-overlap, not a proof), so a flag is a prompt to re-read both, not an automatic rewrite. **Green, then close:**

```bash
gh issue comment <n> --body-file <tmp>.md
gh issue close <n>
```

**The half that used to get skipped:** a ticket whose complaints are not all resolved does not close — it gets a comment naming what landed, what is still open, and why. Use `gh issue comment <n> --body-file <tmp>.md`; never inline a markdown body. A ticket is partial when the verify's `ticketCoverage` says so, or when its numbered complaints outnumber the issues emitted for it. **Never close a row the verify overturned**, or one he has not decided.

**X152/X158 — two appends, same moment, same input (this wrap's `built` rows and `ticketCoverage`), done together right here now that the sha exists:**

1. **Every independently `verified` ref this wrap's own commits actually ship gets a companion row using `node scripts/ledger-file.cjs --wrap-companion --ref <ref> --version <version> --sha <sha>` — a SEPARATE line, never a mutation of the original.** The writer refuses missing/stale review. Historical shape: `{"date":"<today>", "runId":"wrap-<version>", "ref":"<same ref>", "verdict":"wrapped", "state":"wrapped", "note":"shipped in <sha>"}`. **`verdict:"wrapped"`, not `"built"`** — a row carrying both on one line answers its own check and is exactly the shape the acceptance test below now refuses. Closes the 313-`built`-vs-18-`wrapped` gap (measured 2026-08-04) — nothing else durably tells "in the tree, uncommitted" from "deployed weeks ago" without re-reading `git log` per ref by hand.

2. **Whatever GitHub gets, the ledger gets the identical statement — never a second, independent copy of the prose.** For every issue touched above: `{"date":"<today>", "runId":"wrap-<version>", "ref":"gh#<n>", "state":"closed"|"partial", "note":"<the exact text gh issue close/comment sent, verbatim>"}`. `state` is the FACT GitHub shows; do not hardcode a verdict off it. **A closed ticket is `"verdict":"wrapped"`** — never `"built"`: that verdict means "a fresh atomic fix," and a bare ticket ref carrying it falsely demands a companion row nothing will ever mint. **A partial ticket is unfinished work more often than it is a question for him — pick the verb the comment's own "why" actually supports**: `"recommend":"build — <the remaining piece>"` when it just needs another round, `"recommend":"defer — <what it waits on>"`, or `"verdict":"needs-owner-decision"` only when the comment itself says he must choose something. Pairing every partial with `needs-owner-decision` regardless of why would put unfinished-but-routine work on his desk that a lane could simply pick back up — and a row still awaiting his decision is never closed on GitHub in the first place (rule above), so it correctly contributes nothing here to check against. A closed-or-commented ticket with no matching row is why *"a wave ships and the source GitHub issue is never closed or even updated, and nothing reports where a ticket stands"* took him a full day to notice himself.

**Release step 1's lock in the same breath — this is the last tree-writing step the wrap has.** Set `.claude/agent-loop/state.json`'s `lastRun` to `{"id": "<the same id step 1 set>", "status": "complete", "note": "<version> wrapped"}`. One more line in the `git add -A` below, not a separate commit.

**COMMIT THESE ROWS before you check them — the check reads git history, not the working tree.** `git add -A && git commit -m "<version> bookkeeping: file <tickets> closes/comments" && git push`, riding alongside (or as) step 11's `lastWrapIso` bookkeeping commit. **The check, one command, run AFTER that commit — extends the same one already run at step 11:**

```bash
node scripts/ledger-stats.cjs --wrap <version>
```

Two lines, `BUILT -> WRAPPED` and `GITHUB <-> LEDGER SYNC`, report against this wrap's own committed rows and name any ref or ticket the two appends above missed, plus a `MUTATION-SHAPED` line if a row carries both `verdict:"built"` and `state:"wrapped"` at once. **It exits 1 on any of the three — do not call the wrap finished on a red exit**, same acceptance-test convention as `--report` at step 11.

**A third check runs in the same command: `PHANTOM CANDIDATES`.** 16 of 23 build-ready backlog rows going into the 4.5.0 wrap were bugs that wave's own diff had already fixed under a *different* ref — found by hand, after the fact, because nothing here ever cross-referenced the shipped diff against the standing backlog. `--wrap <version>` now does: it cross-references every currently-open ledger row against the files this wrap's own commits touched (plus a shared `invariant` with a row this wrap closed, plus a ref appearing in this wrap's own commit subjects), and prints any hit as a candidate. **It never auto-closes.** Verify each against the CURRENT tree, cite the exact `file:line` that makes the original failure impossible, and close it with `node scripts/ledger-file.cjs --verdict already-fixed`. If a candidate is genuinely a distinct, still-open bug, append a `{"date":"…","ref":"…","recheck":"…"}` line dated today or later so it stops being reflagged — it stays open, it just stops being asked about at every future re-run of this wrap's own check. This is the OPPOSITE direction from `alreadyBuilt` (which guards intake against re-filing a shipped fix as new); this guards the standing backlog against staying open after a later wave silently closed it.

### 13. Confirm the boot stamp — the push already restarted her

**Build and restart nothing here.** The push at step 11 is the deploy: the VM's `maelle-deploy-watcher` pulls, builds and restarts her within ~2 min (header, and `SESSION_STARTER.md`'s Operational deploy bullet). Read the stamp from the log, not the PM2 table — **the log is on the VM she runs on; the local `logs/` dir is STALE (frozen at the 2026-07-31 cutover) and grepping it confirms nothing**:

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

A lane’s self-check is not independent verification. Count newly shipped refs from their persisted independent passes and name the bounded scope and any model-dependent limitations. An implemented, failed, unproven or stale ref blocks a new wrap; an old release’s unverified count is a historical fact, never permission to skip verification now.

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
