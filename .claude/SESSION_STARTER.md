# Maelle session context

Working on Maelle at `E:/Code/Maelle`. **Current version: v4.3.3** — `package.json` is the source of truth. **HEAD = the 4.3.3 wrap** (run `git log -1` for the SHA). Version-by-version history is in `CHANGELOG.md`, which is canonical — this file carries only what a session needs before it acts.

**One live shape worth knowing before you read any code:** since 4.3.0 she has a **second transport, email** (gh#24, a narrow slice of #5) — the owner forwards a meeting request to `maelle@reflectiz.com`, she computes options and **replies by email to him only**, so he stays the gatekeeper and she never emails an external. The recipient cap is in code, an email turn is clamped to four tools, and the whole path is inert without `channels.email.{enabled,mailbox}` plus a token from `scripts/email-auth.mjs`.

## ⚠️ Framework state — read before you run anything (shipped in 4.3.3)

**The loop was rebuilt on 2026-07-30 and shipped in 4.3.3.** No `src/` change in that release — it is entirely the framework: both engines, the Manager skill, this file, the architect charter, `scripts/{ledger-stats,spend,architect-file,check-syntax}.cjs`. In plain terms:

- **The report is grouped by status and may never print a number it did not compute.** The headline open count comes from `ledger-stats --open` and names the command.
- **There is a ceiling on how many items one run may put on his desk** (12, measured from seven runs). It warns; it never truncates and never merges rows to get under it.
- **The backlog is a source on EVERY run** (his ruling: *"put backlog in every run"*). `ledger-stats --open` splits into *confirmed* · *need a re-read* · *cite no file*: a row needs re-reading when a commit touched the file it cites **after** the row was written, and a row citing no file can never be checked mechanically — those are named for a hand read. A re-read marks and confirms; it never closes on its own and never spends the decision budget.
- **A verify DISCOVERY is no longer a row on his desk** — it is the next build's intake. An **overturn** still blocks the wrap.
- **A ticket's numbered complaints each become their own issue**, and every issue's id names its ticket (`156-a`); a blocker raised on a ticket is `153-blockA`, not a fresh flat number.
- **The wrap states verified-against-shipped**, so a lane that skipped its own verify pass is visible.
- **`spend.cjs` checks each dispatch's tier against that agent's charter** and names the offender.

**A chat that was open before today runs the OLD engine with none of this, silently** — framework files load once per chat. Start fresh.

## Which chat is this?

**One chat per job — his split, 2026-07-29:** a **bugs** chat · a **framework** chat (the engines, the Manager skill, this file, the architect — it never touches `src/`) · and **one chat per big feature**. If the first message does not make it obvious, ask. The standing mode below governs any **interactive** chat; the loop's agents are deliberately exempt from it (see the framework section).

Standing mode:

- **Propose-first, code-first, root-cause.** Trace `logs/maelle-YYYY-MM-DD.log` + the code before attributing; state root cause as `file:line`. Bug reports / frustration / screenshots are diagnostic signals, **not** build signals.
- **Trace the RUNTIME, not the design.** Check the actual log line / DB row / deployed dist / tool-call tape, not the code's or a verdict-log's *description* of itself. (Re-earned three times in one session — see Lessons.)
- **Build only on an explicit per-item "fix it / build it / do it"** on a *specific* bug/feature. Bare "ok / yes / go" is ambiguous — ask. On a build signal: edit → typecheck → **STOP** (uncommitted).
- **Wrap only on an explicit ship word** ("wrap / ship / commit / cut a version / bundle"). Default bump **PATCH**.
- **Prompt is a budget, not a junk drawer.** Enforcement → code (chokepoint guard / a return-value the model reacts to / a tool that owns the decision). Prompt only for judgment / tone / format / language.

## The agent framework — how Maelle is built now (`.claude/agents/` + `.claude/skills/manager`)

Maelle is built by **seven lane agents** whose charter file IS their system prompt, plus a **Manager** that orchestrates them. Two modes, one set of lanes.

**Mode 1 — the autonomous bug loop ("Bugger").** The **Manager** (`/manager`, `.claude/skills/manager/SKILL.md`) is the owner's control panel. **The owner triggers every run — there is no timer, and none is ever armed** (his call, 2026-07-28: he reaches the machine remotely, so a clock was only a substitute for being there, and it failed silently in four different ways). One run does everything: the **`scout`** finds and routes the work (open GitHub `Bug` issues **+** the log review since the watermark **+** the stale-row re-read, merged into atomic issues) → dispatch the code lanes **in parallel** (Matchmaker · Shepherd · Gatekeeper · Profiler · Transporter · Outrider) → **`instructor` LAST** → chain dependencies until nothing is owed → one **`verifier`** pass over the combined diff → cumulative report at `.claude/agent-loop/report.md`. Engine: `.claude/workflows/bugger.js`. Agents **build within their charter WITHOUT a per-item "go"** — that is the loop's whole point, and it **supersedes the propose-first standing mode above, which governs interactive human chats, NOT the loop's agents.**

**Mode 2 — feature and improvement work.** Also the **Manager**, via `/manager feature` — but on a different engine, `.claude/workflows/feature.js`. It does not go through the bug loop, whose intake and verdicts are bug-shaped (symptom / root cause / reappearance) and whose "one root = one issue" rule is bug logic. **Two invocations, deliberately:** `mode:'plan'` reads the ticket against the code and returns a per-lane decomposition plus `blockingQuestions` — **and builds nothing**; the owner approves or reshapes; then `mode:'build'` dispatches the owning lanes in dependency order, `instructor` last, and runs one `verifier` pass over the combined diff. For one ticket, pass `refs:['#<n>']` and it skips the backlog listing. **For an idea not on GitHub yet, pass `items:[{title, asks}]`** — the ticket is filed when the owner approves the plan, not before, so a rejected idea leaves no litter and an approved one arrives with its decomposition already in it. **Give it its own session** — a design decision does not fit inside a nightly bug report without deforming it.

> **A chat does not edit a lane's files — it dispatches.** If a change touches code a lane owns, that lane builds it, however small the diff. The charter is the quality bar, not the size of the change (this is Manager rule M1, and it binds every chat too). Two rationalizations to catch in yourself: **"it's small"** is not an exception — a one-line edit in a lane's file still has to pass that lane's rules; and **silence is not approval** — build only on the owner's explicit per-item word, never because an offer to build went unchallenged. When you're unsure who owns a file, ask the WhatsApp/seam tests below or ask the owner — don't default to doing it yourself.
>
> A chat may still edit files **no lane owns** (docs, `.claude/**`, scratch), and may always investigate, read, trace and propose freely.
>
> **Approval is per piece of WORK, not per lane — chain dependencies automatically.** Once the owner has approved a change, routing it through however many lanes it touches is *your* job, not a new decision for him. If a lane returns "this also needs `profiler`", dispatch `profiler` and finish the job — that is completing approved work, not new scope. Ask again ONLY when the scope genuinely grows beyond what was approved (a new capability, a different subsystem, a product call). The Bugger loop already chains `needs-dependency` automatically; an interactive chat is hand-running the same orchestration and should behave the same way. "Should this be built?" is the owner's question; "which lane builds it?" is never his.
>
> **Name every dispatch with its lane.** The background-task panel shows only the `description` and a generic "Agent" label — it never shows which agent is running. So prefix it with the lane: `slack: coda delivery split`, `guard: verify the attendee fix`. With several agents in flight, "Agent · Agent · Agent" is unreadable; lane-first matches the workflow's own `build:<lane>` labels and stays scannable.

**Feature dispatches — one charter clarification that matters.** The charters' *reduce-LOC · reduce-prompt · no-new-state* reflexes are **bug hygiene, not a ban on building.** New capability legitimately ADDS code, and sometimes state or prompt. The bar for an addition is: it **rides an existing spine, duplicates nothing, and deletes whatever it replaces.** An agent must not refuse a sanctioned feature on "the diff must trend net-negative" grounds.

**Shared by BOTH modes:** only the **owner** commits / wraps (agents never commit — they build in the tree and stop) · code-first · prove the root cause from code + logs · **security & privacy are enforced in code, never prompt** · deep fix, never a patch · **no-guess: unsure → escalate, don't build** · no regex on natural language (multilingual). Ambiguous log-review findings are **shown to the owner, never auto-fixed**. An agent that is unsure, blocked by its charter, or facing an owner-only judgment returns a verdict up the chain — it does not guess.

### The squad — lanes & boundaries

Every lane takes the product requirement into a different area. At a glance:

- **Matchmaker — the secretary.** How Maelle thinks and works on **meetings and the calendar**. Not news, not people.
- **Shepherd — the spine / tasker.** Owns the **lifecycle stage** of every async process: raise → track → decide → replay → close → loop back.
- **Gatekeeper — what stops her making mistakes.** The output-time net, and nothing more.
- **Profiler — who she works with.** Identity, what she remembers, and the social layer.
- **Instructor.** Everything she is told before she acts — the system prompt, tool descriptions, learned prefs.
- **Transporter — the pipes.** How a message reaches her and how an answer reaches a person. Slack **and email**.
- **Outrider.** Whatever no lane owns yet; it shrinks as lanes take over.

*Rule tags are one letter per lane:* **M**atchmaker · **S**hepherd · **G**atekeeper · **P**rofiler · **I**nstructor · **T**ransporter · **O**utrider. The old names — meeting / requests / guard / people / context / slack / outer — were **retired 2026-07-28**; a rule tag in a `src/` comment still reads as its letter, which did not change.

**Not a lane — `verifier`** (`.claude/agents/verifier.md`). The gate before a wrap: one adversarial read over a finished wave's combined diff, asking both *is this safe to ship* and *does it meet our standard* (no dead code · reuse before add · root not patch · one spine · cheap at runtime · security in code). Owns no code, holds no `Edit`/`Write`, runs on **Opus** while the lanes run on Sonnet. It refuses to run on an unfinished wave. Took this job off `gatekeeper` on 2026-07-27, because a lane that owns code cannot review a diff containing its own.

**Not a lane — `scout`** (`.claude/agents/scout.md`). It owns no code and builds nothing: it pulls the open GitHub `Bug` issues, reviews the logs since the watermark, re-reads the stale open rows, merges what it finds, and routes each atomic issue to the lane that owns the fix. Read-only (`Read · Grep · Glob · Bash`). **The lane table below is the map it routes against — keeping that table current is what keeps routing correct.**

**Not a lane — `architect`** (`.claude/agents/architect.md`). It maintains **the framework itself** — the two engines, the Manager skill, this file, `agent-loop/` state, and the framework's own tooling. It never writes `src/` and never rules on product code quality; its subject is whether the agents are in sync, doing their job, and efficient. **Rule tag `A`.**

> **If you hit a problem in the FRAMEWORK, file it — do not fix it, and do not ask Idan to relay it.**
> ```bash
> node scripts/architect-file.cjs --finding "…" --evidence "…" --target feature.js --source "this chat"
> ```
> A framework problem is an engine that did nothing while reporting success, a manifest that lied, a skill instruction that contradicts the code, a charter that no longer matches what a lane does. **A Maelle bug is not one** — that is a GitHub issue or a report row, and it belongs to a lane. The script refuses a row with no checkable evidence (`--targets` lists valid targets); read the backlog with `node scripts/ledger-stats.cjs --architect`. It also refuses a **re-file**: if your finding matches an open row it stops outright, and if it matches an **already-built** row it asks you to read that row and pass `--amends <id>` or `--amends none` — because a match against built work is usually an amendment, and building a mechanism that already exists costs a full dispatch for nothing. Closings live there too: `--close <id> --built "<what shipped, and where>"`, `--close <id> --declined "<his reason>"`, and `--recheck <id> --checked "<what you opened>"` for a row you re-read and found still real.
>
> **The architect proposes; Idan approves; then it edits — except for a DEFECT**, which it fixes and reports (a mechanism that cannot fire, a field nothing reads, a check that passes on known-bad input, a count that is wrong). **The question to ask is his: is this a PRODUCT DECISION, or a bug that must be fixed to complete the product spec?** Changing the framework — or a new process, a new idea, a problem in how it is **run** — is his. A bug in what was already agreed about how the workflow and process should work is the architect's. The propose-first bar is stricter than a lane's on purpose: Maelle's code ships through a deploy, framework code does not — an engine edit is live on the very next run, so there is no gap in which a mistake gets caught.
>
> **Filing is automatic; RUNNING it is only ever his call.** Append a row the moment you hit a framework problem — that costs almost nothing and losing the finding costs a wave. But no timer, no wrap step and no returning run dispatches the architect: when he wants the process checked, he asks.
>
> **And a framework edit only takes effect in a NEW session** — engines, skills and agent definitions all load once per session and none of them says so. If a framework change was made in this chat, it is not in force here.

| Lane | Owns | Never touches |
|---|---|---|
| **Matchmaker** | deterministic scheduling core — search / validate / book / move / cancel, free-busy, TZ + Working-Elsewhere, floating blocks, the Graph CALENDAR layer + cache | the requests spine · the guards · prompt wording · transport |
| **Shepherd** | the async work-item spine — everything with a row in `requests` (approvals, outreach, reminders, follow-ups, research): raise → track → decide → replay → close → loop back, incl. timers/expiry, the requester relay and the owner's daily decision thread | the meeting planner core · the guards · the prompt · **what an item DOES when it fires** (that's its domain lane) |
| **Gatekeeper** | output-time gate stack (claimChecker / humanGate / dateVerifier / securityGate / availabilityPreCheck) + `postReply` orchestration + `summarizeToolCall` truthfulness | the flows the guards protect — a broken flow is fixed in ITS lane, never papered over · **the framework's verify pass** (that is `verifier` now) |
| **Profiler** | identity + the person store (`db/people.ts`) + people memory + social (topics, codas, engagement) + Maelle's own self row | other lanes' *use* of person data |
| **Instructor** | the context budget — `systemPrompt.ts`, tool descriptions, learned-MD prefs. **Runs LAST** | anything code can enforce; **never** security / privacy; conversation/thread context (slack) |
| **Transporter** | the transport — inbound routing + queue, threading, DM/MPIM/channel posture, authority by authenticated sender, dedup + catch-up, the `postReply` delivery pipeline, the `Connection` abstraction, **the Graph MAIL layer** (`connectors/graph/mail*.ts` + `scripts/email-auth.mjs`), media/platform features | the **gate decisions** inside postReply (guard) · what an event *means* (requests) · person data (people) |
| **Outrider** | the net — news, brief, routines and non-request async jobs, the Graph CLIENT layer only (auth, tokens, `graphClient`, user/profile reads — calendar is Matchmaker, mail is Transporter), core orchestrator (non-prompt / non-gate), DB, health, config, scripts | anything a lane owns |

**Seams that cause bouncing — settle them, don't guess:**
- **Route by where the durable FIX lives, not where the symptom appeared.** A leak *appears* at output but is usually fixed in the flow that produced the data.
- **guard vs flow:** the gates = guard; whatever fed them = its own lane. **A missing backstop is not its own bug.**
- **people vs meeting:** the person store + its semantics = people; which attendees enter a search = meeting.
- **people vs context:** person *facts* = the store (people); the owner's *opinion* of a person = learned MD (Profiler routes the content, Instructor owns the injection).
- **slack vs everyone — the WhatsApp litmus:** *if Maelle switched to WhatsApp tomorrow, would this code change?* Yes → Transporter. No → the domain lane. (So: the `postReply` **pipeline** is slack, the **gates inside it** are guard; a ✅ reaction *arrives* via slack, what it *resolves* is requests.)
- **`instructor` is a last-resort destination** — never route there merely because a symptom is visible in a reply.
- **`outrider` only when no specialist owns it** — it is not a bin for the unclear; unclear = escalate to the owner.
- **calendar-health belongs to `matchmaker`** (settled): dense packing, auto-move/defrag and floating-block rebalance (`calendarHealth`, `rebalanceFloatingBlocks`, `calendarDensity`) are governed by M7 — there is no separate calendar lane. Meeting owns both halves: the commitment *and* the shape of the day.

## Shared tree — several lanes edit at once

Assume multiple lanes (and chats) hold uncommitted edits at any time. At wrap: `git fetch`, read the **FULL** working tree, and bundle everyone's work — never commit only your own files without checking the rest. Re-baseline before editing; line numbers move under you. Cross-lane hand-offs are self-contained blocks: root cause + `file:line` + log/DB evidence + a fix framed as a **suggestion to verify, not a mandate**.

**Still owner-driven (no lane owns these):** the GCP VM cutover (infra committed in 4.0.0; blocked on Idan's `.env` + SSH) and model/LLM-layer campaigns (`llm/models.ts`, thinking policy, effort per surface) — deliberate projects, not nightly bug flow.

## Open / deferred bugs

**The live list is `node scripts/ledger-stats.cjs --open` (48 rows, 2026-07-30) and `gh issue list`.** Only what neither of those can tell you is kept here:

- **1.4 — MPIM owner-clamp: KEEP it, do NOT loosen.** The clamp is an **anti-cheat security boundary across ALL tools** (colleagues must never gain owner authority / book for themselves), not just calendar privacy. Keyed on the Slack-authenticated sender, not spoofable (`app.ts`, the sender-identity read; `processMessage.ts` holds the clamp). The owner's "flag-and-override" in his own group DM is delivered SAFELY via the approval flow, NOT by re-granting in-group authority. An earlier "Option A" loosen was stood down. Live context: **#157 and #158 are open MPIM tickets** — do not read either as licence to loosen this.
- **Move-path roster: union or replace?** — still undecided, and the harm it named is already guarded. `findAvailableSlots.ts` (`resolveMovingEventAttendees` + the `#145b` overlap test) folds a moving event's roster in only when it shares an attendee with the explicit set, so the 4→7 balloon cannot recur. The open question is whether the event roster should be **authoritative** (replace) rather than merged — his call, no ticket.
- **M3 no-TZ fallback frame.** An attendee with no stored timezone is assumed in the **owner's** zone (`attendeeAvailability.ts`, `fallbackTimezone`); he asked for the **requester's** zone. Identical for owner-initiated searches, differs when a colleague in another zone requests.
- **`hasApproval` / `actionCount` log uniformly 0** (`processMessage.ts`, the `Orchestrator completed` line). A logging artifact, **not** an escalation failure — 2026-07-21 forensics showed `create_approval` did fire and resolve. Fix the counters, don't chase the escalation.
- **Remaining audit items** (`.claude/V4_AUDIT_HANDOFF.md`): mediums M5/M8–M11 and the Wave-5 lows. None block anything.
- **B&H "Outside" event** — one already-booked event still carries the wrong Outlook category. The category-authority fix is forward-only; this row needs a manual recategorize or one ask to Maelle.

## Lessons re-earned (read before trusting your own analysis)

- **Trace the runtime, not the design — three wrong calls in one session:** (1) graded a push-fallback paper-trace 14/14, but the finder's `movingEventForbiddenZones` rule rejected the move at runtime — the helper's math was traced, not the finder contract; (2) blamed model "context-bleed" for a 4→7 attendee balloon when the log showed a *code* path (the move-path roster union); (3) concluded a calendar category was "correct" from the planMeeting *verdict* log while the actual Graph write used a different value. In every case the real runtime (log / dist / tool-tape) contradicted the reasoning-from-intent.
- **When many symptoms share one cause, fix the cause — don't whack-a-mole.** Six+ distinct bugs in one session traced to a single model swap; the one-line revert collapsed the wave. The individual code fixes were still worth keeping (they close real model-independent gaps), but the leverage was in the common cause.
- **A model swap exposes prompt-only enforcement.** Behaviours held by prompt alone (approval escalation, attendee tracking, honest "I checked", category choice, mention formatting) broke when the model changed, because nothing enforced them in code. Move enforcement to code.

## Operational

- **Restart to load code:** `npm run deploy` (build → `pm2 restart maelle` → tail). Single PM2-fork process. Boot stamp prints version + gitSha — confirm it matches HEAD after any restart.
- **Exactly ONE Slack socket** — two Maelle processes on the same app → Slack `too_many_connections`. Never run local + another at once (critical for the eventual VM cutover).
- **Typecheck** (from the main repo, not a worktree): `npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json`.
- **After editing an engine or a framework script:** `node scripts/check-syntax.cjs`. **Never `node --check` on `.claude/workflows/*.js`** — it exits 0 without parsing, so a file with a deliberate `{,}` in it reports success (A28). The engines run as an async function body, which no standard parser accepts; this script compiles them that way and proves it by requiring a broken copy of each file to FAIL.
- **GitHub:** bugs flow through chat / the spawned-task chip; never `gh issue create` without an explicit "file it."

Read at session start: memory `project_architecture.md`, `project_overview.md`, `project_we_timezone_spine.md`, `project_gcp_migration.md`, and the `feedback_*` memories (auto-load via `MEMORY.md`).
