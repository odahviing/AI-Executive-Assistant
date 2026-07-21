# Maelle — Audit Agent Starter

Paste-and-go seed for a fresh audit chat. Self-contained: assumes zero prior context.

Project: **Maelle** — AI executive assistant, Node.js/TypeScript, monorepo at `E:\Code\Maelle`.
Version: **check `package.json`** (was **3.8.4** at last handoff; the number churns — see the multi-chat note). Stable line.

---

## ▶ STEP 0 — RECONCILE GIT STATE FIRST (this repo has MULTIPLE chats writing to it)

**More than one Claude chat operates on this repo at the same time.** Last cycle a GCP/Vertex-migration chat and an SDK-upgrade chat ran in parallel with the audit chat. Observed reality:
- HEAD moved under the audit chat mid-session (6c5024f → cea5a71 → … → e80234e).
- `package.json` version bumped 3.8.1 → 3.8.2 → 3.8.3 in minutes.
- Another chat's `git add -A` **swept the audit chat's uncommitted work into ITS commits** (turnHelpers landed in 3.8.2, buildTurnContext in 3.8.3, both authored by the other chat).

Before any audit / cleanup / wrap:
1. `git -C E:/Code/Maelle status --short` + `git log --oneline -8` — know what's committed vs uncommitted and whose it is.
2. **Files owned by OTHER chats right now — DO NOT touch, revert, or commit:**
   - GCP/Docker/k8s: `Dockerfile`, `.dockerignore`, `k8s/`, `.github/workflows/deploy-gke.yml`, `scripts/migrate-data.sh`, `src/index.ts` (build-stamp), the `vertex` branch in `src/llm/client.ts`, the Vertex map in `src/llm/modelId.ts`.
   - SDK upgrade + Sonnet 5 migration: **anything touching `@anthropic-ai/sdk`, the `claude-sonnet-*` model strings, or `thinking`/`effort` params.**
3. **When you wrap, commit ONLY your own files** with explicit `git add <paths>` — **never `git add -A`** (it will sweep the other chats' in-flight work).

---

## ▶ THIS RUN — the owner names the focus

The last two cycles are DONE and shipped (see State Carried Forward): a **dead-code hygiene sweep** and a **big file-split refactor**. This run has **no forced agenda** — the owner will say what they want (a bug wave, a design review, a specific subsystem, the queued further-splits, the open follow-ons below). If it's not clear, ask. Deliver everything as **propose-first batches**, verify-before-flag, same discipline as always.

---

## HARD RULES (govern every audit run)

### Propose / build / commit
1. **Propose-first. Build only on an explicit per-item "go"** ("fix it" / "do it" / "remove it" / "go"). Never bundle — approval on one item is NOT approval for its neighbors.
2. **A question is not a build signal.** "how does it happen?" / "is it real?" / "why?" mean *explain more*, not *start editing*.
3. **Never commit, version-bump, or write CHANGELOG without an explicit wrap word** ("wrap" / "ship" / "commit" / "cut a version"). Then commit ONLY your files (Step 0.3).
4. **Typecheck after every change**: `npx tsc --noEmit -p tsconfig.json` from the repo root. EXIT=0 before moving on.

### Verify before you touch anything (the load-bearing rule)
5. **VERIFY-BEFORE-FLAG.** Audit subagents have a real false-positive rate. Re-read the cited code against the current tree and `grep -rn` for callers before proposing or removing. Never act on a subagent claim you haven't personally confirmed. (Last cycle a deterministic import-graph scan caught two whole-file orphans the LLM subagents walked past — pair LLM subagents with mechanical grep checks.)
6. **Don't manufacture edits.** If the target doesn't exist, report "nothing to do." Don't churn good code to look productive.

### Cleanup-specific
7. **Dead code — verify ZERO callers before removing** (`grep -rn` the symbol across ALL of `src/`, plus `scripts/`). Watch for: barrel re-exports, dynamic `require()`, callers outside `src/`. LEAVE the risky ones: DB columns / table drops (a schema change), defensive legacy `case` branches, owner-curated config/back-compat, `(x:any)` shapes. When unsure, propose + explain, don't delete.
8. **Comments — remove-contradicts-code + merge-stacks, KEEP PROVENANCE.** Fix comments that contradict the code (highest value — they mislead). When merging a 3-4 comment pile, keep a compact combined version/issue ref (`// v2.7.1 + v3.4.0 — <why>`). NEVER strip `// vX.Y` / `#NNN` tags wholesale (the owner reverted exactly that once). Single-version WHY comments stay untouched.

### Working style
9. **Atomic findings.** Each = one fix shape with a `file:line` citation.
10. **Route in-flight-feature bugs to the owning chat** via a written prompt — don't fix code another chat owns (see Step 0.2).
11. **Subagent cost-awareness.** For behavior-preserving MOVES, a byte-for-byte extraction verified by tsc + re-slice-from-HEAD is very reliable (last cycle split ~13k lines this way, zero regressions caught by tsc). For discovery, scope each subagent to a subsystem + cap output. Don't hand a subagent an open-ended file rewrite.
12. **When the owner disagrees with a finding, accept it and move on.**

### Shell (from CLAUDE.md)
- Never prepend `cd <path>` to a command. Use absolute paths / `git -C`.
- No compound `;` / `&&` / `||` chains — one logical command per Bash call; independent commands as parallel tool calls.
- Never `node -e` / `node -p`. Read tool for files, `scripts/db-query.cjs` for the DB, a written `.js` in the temp dir for one-off analysis (that's how orphan-detection was done last cycle).
- Prefer Bash over PowerShell for portable commands.

---

## HOW TO RUN AN AUDIT (the playbook)

1. **Orient.** Read CHANGELOG.md top, `.claude/ARCHITECTURE_MAP.md`, this file's State section, and `git status`.
2. **Dispatch parallel subagents** (one per subsystem cluster, single message, multiple Agent calls). Self-contained prompt each: scope + file list + KEY INVARIANTS + DO-NOT-RE-FLAG + goal (dead code / unused exports / contradicts-comments; or bug-trace) + "read files, grep callers, atomic findings w/ file:line, DO NOT edit, <1500 words."
3. **Run the mechanical cross-cutting sweep yourself** (orphan files / dangling imports / unused exports) — a written import-graph script is more reliable than an LLM for exhaustive bookkeeping.
4. **Synthesize:** dedupe, **verify each finding yourself** (Rule 5, drop false positives explicitly), number atomically, rank.
5. **Save a self-contained handoff** at `.claude/<NAME>_HANDOFF.md`; append a "SESSION N — what got fixed" block as you build.

---

## SUBSYSTEM MAP (post-split — the monoliths are now directories)

- **Booking** — `skills/meetings.ts` (tools + prompt shell) → `skills/meetings/ops.ts` (104-line dispatcher) → `ops/handlers/{findAvailableSlots,createMeeting,moveMeeting,calendarReads}.ts` + `ops/{analysis,helpers,violationLabels}.ts`; `meetings/{planMeeting,bookingRequest,detectCategory,findMeetingOwner,resolveAttendeeEmails}.ts`; `utils/scheduleRules.ts` (`checkSlot` = THE validator), `utils/workHours.ts` (`getEffectiveWorkDay*` = THE work-day resolver), `coord/*`, `meetingProtection`, `resolveLocation`, `weTimeResolver`.
- **Calendar backend** — `connectors/graph/calendar.ts` is now a **4-line barrel** re-exporting `graph/{calendarTypes,graphClient,calendarReads,findAvailableSlots,calendarMutations}.ts`.
- **Calendar health** — `skills/calendarHealth.ts` (330-line shell) → `calendarHealth/{autoMove,classify,types}.ts` + `calendarHealth/handlers/{checkHealth,floatingBlockOps,categoryOps}.ts`.
- **Slack transport** — `connectors/slack/app.ts` (266-line factory shell) → `app/{processMessage,fileIngestion,handlers,helpers,context}.ts`; `postReply.ts`, `coordinator.ts`, `inboundQueue.ts`, `recentOutboundContext.ts`, `socketWatermark.ts`, `processedDedup.ts`. (`relevance.ts`, `assistantThreads.ts` were DELETED.)
- **Orchestrator** — `core/orchestrator/index.ts` (~1,395 LOC — the turn loop, left whole on purpose) + `buildTurnContext.ts` (prompt/context assembly) + `turnHelpers.ts` (`callClaude`, `summarizeToolCall`, `mutationOutcome`, …) + `systemPrompt.ts`.
- **Requests spine / approvals** — `core/requests/*` (`closeRequest` = only terminal path, `resolver`, `runner`=sweep, `reconcile`, `deferredActionReplay`, `types`); `tasks/skill.ts` (`create_approval`/`resolve_approval` → creates REQUESTS); `db/requests.ts`.
- **Tasks system** — `tasks/runner.ts` (the tick's exec entry: runs `sweepDueRequests` + task dispatchers), `tasks/dispatchers/*`, `tasks/index.ts`, `routineMaterializer`. **Shrinking legacy** — see debt.
- **Social** — `skills/social.ts` (thin shell) + `core/social/*` (classifyTurn, generateCoda, logEngagement, stateMachine) + `memory/capturePass` + `db/{socialSubjects,engagementRank}`.
- **Person / memory** — `db/people.ts` (`resolvePerson` = identity chokepoint), `memory/peopleMemory.ts`, `core/assistant.ts`.
- **Guards** — `utils/{claimChecker,dateVerifier,humanGate,securityGate,imageGuard,addresseeGate}.ts`. (There is NO `coordGuard.ts`.)
- **Leaf skills** — `news`, `venue`, `knowledge`, `summary`, `general`(search).
- **Cross-cutting** — whole-`src/` sweep (orphans, contradicts-code comments, config leaks).

Full living map: **`.claude/ARCHITECTURE_MAP.md`**.

---

## STATE CARRIED FORWARD (do not re-do / re-flag)

### Shipped this cycle (don't hunt for these; don't re-flag as bugs)
- **Dead-code sweep** — deleted whole files: `attendeeMode`, `relevance`, `taskContinuity`, `cronSchedules`, `router` (+ `PersonRef`/`RoutingPolicy` types), `assistantThreads`. Removed dead functions across socialSubjects / people / requests / timezoneValidator / categoryRules / scheduleOverrides / calendarIssues / workingElsewhere / events / registry / processedDedup / coordinator / messaging / displaySubject / slotHolds / briefIntent. Fixed ~12 contradicts-code comments (provenance kept). Fixed `toolCallCache` WRITE_TOOLS names. **Dropped 3 dead tables** (`approvals`, `cron_schedules`, `assistant_threads`) via `DROP TABLE IF EXISTS` migrations in `client.ts`. Deleted **33 spent one-shot scripts** (kept `db-query.cjs`, `auto-build`/`auto-triage-bug`, `measure-prompt(s)`, `_dump-prompts`).
- **File-split refactor** — the 4 monoliths (`ops.ts` 5,712→104, `calendarHealth.ts` 2,778→330, `app.ts` 2,458→266, `calendar.ts` 2,325→barrel) split behavior-preservingly (byte-for-byte, tsc-0), plus orchestrator `turnHelpers` + `buildTurnContext` extracted. **No file over ~1,500 LOC now.**

### Left on purpose (do NOT propose removing)
- Vestigial-by-design status columns: `coord_jobs.status` / `outreach_jobs.status` / `approvals.status` (the requests-spine row owns lifecycle — intentionally unread).
- `proactive_pending` column, `last_participant_activity_at` on CoordJob, `outreach_decision` case in `runner.ts`, `(x:any)` shape maps in the ops handlers, `connectors/whatsapp.ts` inert branches, the `working_elsewhere` yaml back-compat block in `userProfile.ts`.
- **The single-operation handlers still >1,000 LOC** — `ops/handlers/createMeeting.ts` (1,496), `ops/handlers/moveMeeting.ts` (1,403), `ops/handlers/findAvailableSlots.ts` (1,345), `calendarHealth/handlers/checkHealth.ts` (1,313), `graph/findAvailableSlots.ts` (1,108). These are ONE tool operation each — they only shrink by decomposing their *logic*, which is a separate careful effort, NOT a move. Don't flag their size as a bug.

### Open follow-ons DISCOVERED but not done (owner-decides — propose, don't auto-do)
- **`userProfile.ts` `connections:` zod block is ORPHANED** — its only reader (`router.ts`) was deleted; it's dead multi-transport scaffolding, but it's owner-facing config / back-compat surface. Kill it, or keep for issue #1. (Comment already marks it "UNREAD".)
- **Tasks table is a shrinking legacy.** The requests spine absorbed the timers; the tasks table is now the owner-facing brief/ledger substrate + 5 recurring chores. Micro-cleanup available (NOT a full-table deletion): 4 vestigial `TaskType` values `coordination`/`reminder`/`follow_up`/`research` (now request *kinds*, nothing creates task rows of them), the `social_ping_rank_check` no-op drain, and the stale `tasks/types.ts` header.
- **Further splits queued** in `.claude/FILE_SPLIT_PROPOSAL.md`: `app/handlers.ts` (1,218 → dm/mpim/reactions/mention), `moveMeeting.ts` (→ move + update), the orchestrator core-loop decomposition (risky — logic refactor, not a move), and tier-2 files (`summary` 1,417, `meetings` 1,249, `people` 1,164, `tasks/skill` 1,157, `assistant` 1,115).

### In-flight, OWNED BY OTHER CHATS — do NOT touch (route bugs to them)
- **GCP/Vertex migration:** `Dockerfile`, `.dockerignore`, `k8s/`, `deploy-gke.yml`, `migrate-data.sh`, `src/index.ts` build-stamp, `llm/client.ts` vertex branch, `modelId.ts` vertex map.
- **SDK upgrade + Sonnet 5 migration:** `@anthropic-ai/sdk` is pinned **0.24.3** (June 2024 — predates the `thinking` param; latest is 0.112.3). A separate chat is upgrading the SDK and migrating `claude-sonnet-4-6` → `claude-sonnet-5` (~40 call sites; the gotcha is Sonnet 5's adaptive-thinking-on-by-default, which the old SDK can't disable and whose thinking-block responses it can't safely round-trip — hence SDK upgrade FIRST). Guards/classifiers already run Haiku 4.5. **Do NOT touch model strings, the SDK, or thinking/effort params.**

### Bug findings already ruled out (don't re-raise as bugs)
app_mention bot-author guard (bots CAN call Maelle); multi-tenant panel scope (clone = new server); stranded-`in_progress` auto-reset (too risky); `isOutreachReplyByContext` fanout; prefs `replace` data-loss; `move_meeting must_be_after_event_id` overpromise (false positive); the `#80` `meetings.ts` `as any` cluster (deferred); Hebrew colleague-leak in `securityGate` (owned by the guards chat).

---

## Living reference docs (read for current truth)
- **`.claude/ARCHITECTURE_MAP.md`** — the core spines + peripheral map + known architectural debt (current).
- **`.claude/CLEANUP_AUDIT_HANDOFF.md`** — the dead-code cleanup session log.
- **`.claude/FILE_SPLIT_PROPOSAL.md`** — the remaining-split plan.
- **`CHANGELOG.md`** (top) — recent versions.
- **`.claude/memory/project_architecture.md`** — deep architecture (requests spine, orchestrator loop, etc.).

---

## The one-question test
Before proposing a finding: *"If the owner fixes only this, is it a single atomic edit?"* If no, split it. Atomic granularity is the value.
