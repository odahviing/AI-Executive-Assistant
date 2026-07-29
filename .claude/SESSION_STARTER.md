# Maelle session context

Working on Maelle at `E:/Code/Maelle`. **Current version: v4.3.0** — `package.json` is the source of truth. **HEAD = the 4.3.0 wrap commit** (run `git log -1` for the SHA).

**4.3.0 = Maelle's FIRST non-Slack transport, and it is LIVE.** The *semi-manual email chain* (gh#24, a deliberately narrow v1 slice of the full #5 connector): the owner forwards a meeting-request email to `maelle@reflectiz.com`, she reads the whole chain, extracts the participants, computes options against his real calendar and rules, and replies **by email to him only** — he forwards it onward, so he is the gatekeeper and she never emails an external. Shape: a delegated-OAuth Graph mail layer (NOT app-only — app-only `Mail.*` is tenant-wide and narrowing it needs org Exchange RBAC, which would make Maelle un-cloneable), its own ~30s delta poll on a durable `deltaLink`, an `EmailConnection` whose `sendDirect` hard-caps the recipient in code, an inbound front door whose sender gate runs before anything else, and a new **channel** axis on tool scoping (`CHANNEL_TOOL_CLAMP`) that limits an email turn to exactly four tools: `find_available_slots`, `create_meeting`, `get_person_memory`, `log_interaction`. No move, no cancel, no approval, no Slack-emitting tool. Enable with `channels.email.{enabled,mailbox}` plus a token from `scripts/email-auth.mjs`; absent that config the whole path is inert. **Also in 4.3.0:** the seven lane agents were renamed and re-scoped (`matchmaker · shepherd · gatekeeper · profiler · instructor · transporter · outrider`, tags M·S·G·P·I·T·O) with the Graph MAIL layer moving to `transporter` and outrider keeping only the Graph CLIENT layer — and the rule-tag citations in `src/` comments were threaded through with it. Plus a prompt-reachability fix that cut up to ~13.4k tokens from a scope-narrowed owner **Slack** turn, which was the largest single saving of the release and had nothing to do with email.

**Read `.claude/agent-loop/report.md` before touching the email leg** — three real live runs produced a batch of findings, and two are named residuals rather than fixed: `meetings.ts`'s ~400-line prose still renders on the email leg (so she is taught move/cancel/escalate tools the clamp blocks), and `humanGate('external')` rewrites the new two-part reply wholesale with nothing protecting the cut line. **4.1.0 = the agent framework** (the squad + Manager + Bugger loop below) plus the person-store "one human, one row" fix and its boot migration, the attendee-resolution fix, and the gate stack moving out of the delivery pipeline. The boot log stamps `version` + `gitSha` — confirm it matches HEAD after any restart. **Running model: `claude-sonnet-5`** — the Sonnet-5 retry is LIVE: the orchestrator runs adaptive thinking at `high`, and (4.0.2) COMPOSITION passes also think — brief `medium`, summary `medium`, knowledge `low`; the ~25 cheap classifier/guard passes stay thinking-off. 4.0.2 also parallelized the owner-facing guard stack (claim+humanGate+date, one wall-clock) + forced humanGate's verdict tool + moved close_loop to Haiku. Revert model = flip `MODEL_SONNET` back to `claude-sonnet-4-6` (one line). **4.0.3** = a real-day bug wave across all subsystems (meeting slot spread + cross-TZ, approval `reject`-vs-`amend` verdicts, image re-attach across turns, honesty guards, brief/news routing — see CHANGELOG); the 4.0.2-deferred `isBriefRequest` misroute is now FIXED. **Known follow-ups:** Ayala `MAX_PER_DAY` pre-spread cap (a single wide cross-TZ window still surfaces ~2 options, not the fuller set); M3 no-TZ fallback uses the owner's zone, not the requester's.

## This chat = FEATURES **and** BUGS

General features + bugs chat. Standing mode:

- **Propose-first, code-first, root-cause.** Trace `logs/maelle-YYYY-MM-DD.log` + the code before attributing; state root cause as `file:line`. Bug reports / frustration / screenshots are diagnostic signals, **not** build signals.
- **Trace the RUNTIME, not the design.** Re-earned hard this session (I was wrong THREE times reasoning from intent/logs instead of the real runtime — see Lessons). Check the actual log line / DB row / deployed dist / tool-call tape, not the code's or a verdict-log's *description* of itself.
- **Build only on an explicit per-item "fix it / build it / do it"** on a *specific* bug/feature. Bare "ok / yes / go" is ambiguous — ask. On a build signal: edit → typecheck → **STOP** (uncommitted).
- **Wrap only on an explicit ship word** ("wrap / ship / commit / cut a version / bundle"). Default bump **PATCH**. (This session's follow-up was an explicit "commit but keep it 4.0.0" → committed with NO bump.)
- **Prompt is a budget, not a junk drawer.** Enforcement → code (chokepoint guard / a return-value the model reacts to / a tool that owns the decision). Prompt only for judgment / tone / format / language.

## The agent framework — how Maelle is built now (`.claude/agents/` + `.claude/skills/manager`)

Maelle is built by **seven lane agents** whose charter file IS their system prompt, plus a **Manager** that orchestrates them. Two modes, one set of lanes.

**Mode 1 — the autonomous bug loop ("Bugger").** The **Manager** (`/manager`, `.claude/skills/manager/SKILL.md`) is the owner's control panel. **The owner triggers every run — there is no timer, and none is ever armed** (his call, 2026-07-28: he reaches the machine remotely, so a clock was only a substitute for being there, and it failed silently in four different ways). One run does everything: the **`scout`** finds and routes the work (open GitHub `Bug` issues **+** the log review since the watermark, merged into atomic issues) → dispatch the code lanes **in parallel** (Matchmaker · Shepherd · Gatekeeper · Profiler · Transporter · Outrider) → **`instructor` LAST** → chain dependencies until nothing is owed → one **`verifier`** pass over the combined diff → cumulative report at `.claude/agent-loop/report.md`. Engine: `.claude/workflows/bugger.js`. Agents **build within their charter WITHOUT a per-item "go"** — that is the loop's whole point, and it **supersedes the propose-first standing mode above, which governs interactive human chats, NOT the loop's agents.**

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

- **meeting — the secretary.** How Maelle thinks and works on **meetings and the calendar**. Not news, not people.
- **requests — the spine / tasker.** Owns the **lifecycle stage** of every async process: raise → track → decide → replay → close → loop back.
- **guard — what stops her making mistakes.** The output-time net, and nothing more.
- **people — who she works with.** Identity, what she remembers, and the social layer.
- **context.** Everything she is told before she acts — the system prompt, tool descriptions, learned prefs.
- **slack — the pipes.** How a message reaches her and how an answer reaches a person.
- **outer.** Whatever no lane owns yet; it shrinks as lanes take over.

*Rule tags are one letter per lane:* **M**atchmaker · **S**hepherd · **G**atekeeper · **P**rofiler · **I**nstructor · **T**ransporter · **O**utrider.

**Not a lane — `verifier`** (`.claude/agents/verifier.md`). The gate before a wrap: one adversarial read over a finished wave's combined diff, asking both *is this safe to ship* and *does it meet our standard* (no dead code · reuse before add · root not patch · one spine · cheap at runtime · security in code). Owns no code, holds no `Edit`/`Write`, runs on **Opus** while the lanes run on Sonnet. It refuses to run on an unfinished wave. Took this job off `gatekeeper` on 2026-07-27, because a lane that owns code cannot review a diff containing its own.

**Not a lane — `scout`** (`.claude/agents/scout.md`). It owns no code and builds nothing: it pulls the open GitHub `Bug` issues, reviews the logs since the watermark, merges the two, and routes each atomic issue to the lane that owns the fix. Read-only (`Read · Grep · Glob · Bash`). **The lane table below is the map it routes against — keeping that table current is what keeps routing correct.**

**Not a lane — `architect`** (`.claude/agents/architect.md`). It maintains **the framework itself** — the two engines, the Manager skill, this file, `agent-loop/` state, and the framework's own tooling. It never writes `src/` and never rules on product code quality; its subject is whether the agents are in sync, doing their job, and efficient. **Rule tag `A`.**

> **If you hit a problem in the FRAMEWORK, file it — do not fix it, and do not ask Idan to relay it.**
> ```bash
> node scripts/architect-file.cjs --finding "…" --evidence "…" --target feature.js --source "this chat"
> ```
> A framework problem is an engine that did nothing while reporting success, a manifest that lied, a skill instruction that contradicts the code, a charter that no longer matches what a lane does. **A Maelle bug is not one** — that is a GitHub issue or a report row, and it belongs to a lane. The script refuses a row with no checkable evidence (`--targets` lists valid targets); read the backlog with `node scripts/ledger-stats.cjs --architect`.
>
> **The architect proposes; Idan approves; then it edits.** This is stricter than a lane on purpose: Maelle's code ships through a deploy, framework code does not — an engine edit is live on the very next run, so there is no gap in which a mistake gets caught.
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

## ⚠️ Sonnet 5 RETRY is LIVE as of 4.0.1 — orchestrator = adaptive thinking, effort `high`

4.0.0 flipped `claude-sonnet-4-6` → `claude-sonnet-5` **thinking-DISABLED, blind** → broad regression wave → reverted same-day. **4.0.1 retries it correctly.** Forensics (2026-07-21 logs) traced the wave to the thinking-OFF policy, NOT the model: Sonnet 5 with reasoning off is less tool-eager + more literal, so it answered from memory instead of calling the tool. So the orchestrator agentic loop now runs `thinking:{type:'adaptive'}` at `output_config:{effort:'high'}` (`orchestrator/index.ts`), restoring tool-reaching + self-verification; guards/classifiers stay thinking-off (`SONNET` bundle). `maxTokens` bumped to 12k/16k for thinking headroom (`buildTurnContext.ts`). **Revert = flip `MODEL_SONNET` back to 4.6, one line** (`src/llm/models.ts`). No sampling params / `budget_tokens` anywhere → no other migration breakage; forced-tool-first-turn + adaptive is fine on Vertex/direct (Bedrock-only restriction, N/A).

**Watch live (first real use after redeploy):** (1) truncation — grep `Orchestrator — response truncated at max_tokens`; bump maxTokens if it fires. (2) The one `classify_summary_feedback` forced-tool path — if it 400s, drop the forced tool_choice on adaptive. (3) Does it CALL the tool now instead of fabricating "I checked". (4) Cost/latency per turn + reply verbosity (Sonnet 5 narrates more — a PROMPT tune, not maxTokens).

**The wave (watch against these — most already fixed in 4.0.1):** attendee-set drift 4→7 — **FIXED** (#145b disjoint-roster guard, `findAvailableSlots.ts`); availability flipping turn-to-turn — was attendee-driven, same fix; fabricated "I checked" with no tool call — adaptive should fix, claim-checker backstops; colleague "still waiting on Idan" on a dead approval — **FIXED** (#145-followup, `requests.ts`/`systemPrompt.ts`); hallucinated "Outside" category — NOT reproduced in the forensic logs, category-authority fix already covers it; raw slack-id leak — caught by the security gate; approval-escalation "not firing" — forensics showed this was a **MISREAD of the dead `actionCount`/`hasApproval` counters** (create_approval actually fired & resolved; the counters are uniformly 0 — a logging artifact worth fixing). **Meta-lesson stands (move enforcement to code), but the wave's PRIME cause was one policy — thinking-off — so adaptive-on fixes the root, not each symptom.**

## What shipped this session (in 4.0.0 `9eeec8b` + follow-up `cda1728`) — all KEPT through the revert

- **SDK 0.24 → 0.112** + `@anthropic-ai/vertex-sdk` (cloud path). Kept.
- **V4 pre-release audit** (7-subagent, `.claude/V4_AUDIT_HANDOFF.md`): Wave-1 HIGH all fixed (H1–H7), dead-code + stale-comment sweep, owner-selected mediums, and the **full-day Working-Elsewhere framework DELETED** (M14 — `manage_working_elsewhere` + plumbing; away-days via `set_work_schedule_override`).
- **Cloud-VM prep committed** — pivoted GKE→VM (`scripts/vm-setup.sh`, `deploy-watcher.mjs`, `ecosystem.config.js`; Docker/k8s kept as fallback). The old "exclude GCP from commits" rule is **LIFTED**. Nothing provisioned; awaiting Idan's `.env` + SSH. See `project_gcp_migration`.
- **Calendar-health defrag now actually executes** — the v2.4.1 `movingEventForbiddenZones` rule blocked *every* small defrag move (target overlaps the meeting's own slot). New opt-in `allowMovingEventOverlap` on `findAvailableSlots` (default off; the two defrag helpers set it). Model-independent bug. Plus a **meeting↔meeting push-fallback** (push the earlier meeting when the later can't come back — busy or off-hours cross-TZ).
- **create_meeting category authority** — `plan.category` (the classifier, now reconciling the model's arg as a HINT) is authoritative for the write; was letting the model's raw arg override (Sonnet-5 "Outside" hallucination). ⚠️ This is the ONE fix that CHANGED behavior (precedence flip) rather than filling a gap — safe on 4.6 (only overrides implausible args), but **if a mis-categorization appears on 4.6, this is the first suspect**; the `category applied` log (applied/verdict/model-requested) shows the divergence.
- **Viewed-event ledger** — `get_calendar`-read meetings are recorded (`threadEventLedger`) + injected so a follow-up "move it / who's on it" resolves by id instead of re-searching or fabricating "can't find it".
- **Health scan skips already-elapsed events** (no more flagging a past meeting) + **stale OOF rows on a full-day-OOO day self-resolve** (the Aug-13 flight re-flag).
- **Bare slack-id outbound scrub** (guard chat — `textScrubber`, deterministic `@U…` → `<@id>`) + **group-DM "name whose conflict" narration** (prompt chat — `systemPrompt`).

## Shared tree — several lanes edit at once

Assume multiple lanes (and chats) hold uncommitted edits at any time. At wrap: `git fetch`, read the **FULL** working tree, and bundle everyone's work — never commit only your own files without checking the rest (`cda1728` swept the guard lane's `textScrubber` + the prompt lane's `systemPrompt` per this policy). Re-baseline before editing; line numbers move under you. Cross-lane hand-offs are self-contained blocks: root cause + `file:line` + log/DB evidence + a fix framed as a **suggestion to verify, not a mandate**.

**Still owner-driven (no lane owns these):** the GCP VM cutover (infra committed in 4.0.0; blocked on Idan's `.env` + SSH) and model/LLM-layer campaigns (`llm/models.ts`, thinking policy, effort per surface) — deliberate projects, not nightly bug flow.

## Open / deferred bugs

- **1.3 — approval escalation not firing (approval chat OWNS the whole thing).** On the Alex/"Getting back the Automation" flows, `create_approval` never fired (`hasApproval:false` every turn) though it's in `ALWAYS_ON_TOOLS`. Owner's steer: investigate WHY beyond "the model didn't call it" — is there a code chokepoint that *should* auto-escalate; did 4.0.0's requests/runner/skill changes break it. **Escalation scope (MEMORY note):** colleague-attendee-busy is the colleague's OWN call, NOT an owner approval — only owner-RULE violations (#128) escalate. Do NOT touch these areas from other chats.
- **1.4 — MPIM owner-clamp: KEEP it, do NOT loosen.** Owner clarified the clamp is an **anti-cheat security boundary across ALL tools** (colleagues must never gain owner authority / book for themselves), not just calendar privacy. Keyed on the Slack-authenticated sender (`app.ts:96`, not spoofable). The owner's "flag-and-override" in his own group DM is delivered SAFELY via the approval flow (1.3), NOT by re-granting in-group authority. I stood down on the "Option A" loosen. `processMessage.ts:66/77` = the clamp.
- **`addFromEvent` union-vs-replace (meeting chat, OPEN, NOT built).** `findAvailableSlots.ts:248-252` on the owner move-path UNIONS the model's `attendee_emails` with the moving event's real roster → a wrong/hallucinated model set poisons the search (the "Getting back the Automation" 4-vs-7: model passed chris/isaac/onn/dina, event resolved yael/elan/ysrael → 7 → 0 slots). The comment claims "MOVE-PATH AUTHORITY" but unions instead of replacing. Fix = event roster is authoritative (replace, not union). **NEEDS Idan to confirm the meeting's real attendees** (was it model hallucination, or a wrong `moving_event_ids`?). Was left unbuilt because we reverted to 4.6 instead.
- **2.1 — "Idan Cohen is typing" indicator.** Not code-diagnosable (bot identity correct `U0ARK5814PQ`, no socket conflict, setStatus uses bot token + 1:1-only). Owner said "no worry about it" — dropped pending a repro/screenshot.
- **Remaining audit items** (`V4_AUDIT_HANDOFF.md`): mediums M5/M8/M9/M10/M11, Wave-5 lows, gatekeeper-class → the Gatekeeper lane. None block anything.
- **#144** — forward a colleague's attached image to the owner: honesty fix shipped earlier, the actual owner-ward file-forward NOT built. Still open.
- **4.0.3 follow-up — Ayala slot count (meeting chat).** `MAX_PER_DAY=4` (`connectors/graph/findAvailableSlots.ts:583`) caps the per-day candidate pool BEFORE the spread picker, so a single wide cross-TZ window surfaces ~2 spaced options, not the fuller set (a 5th slot like 3:15 is culled pre-spread). The 4.0.3 relaxed-fill fixed the ≥1h same-day collapse; lifting/window-aware'ing the per-day cap is the remaining half.
- **4.0.3 follow-up — M3 fallback frame.** The no-TZ attendee assumption (`attendeeAvailability.ts`) uses the OWNER's zone; owner asked for the REQUESTER's zone (identical for owner-initiated, differs when a colleague in another zone requests).
- **B&H "Outside" event** — the already-booked "B&H Photo Video" event still carries the "Outside" category in Outlook; the category-authority fix is forward-only (prevents new mis-tags, doesn't rewrite history). Recategorize manually or ask Maelle once deployed.

## Next up — many more real-day bugs + a proper Sonnet 5 retry

Owner's plan: keep resolving real-day bugs, AND retry Sonnet 5 — this time eval-gated and staged (test thinking-ON, watch the wave symptoms above). Build the code backstops first so the retry isn't leaning on prompt-following.

## Lessons re-earned this session (read before trusting your own analysis)

- **Trace the runtime, not the design — I was wrong three times:** (1) graded a push-fallback paper-trace 14/14, but the finder's `movingEventForbiddenZones` rule rejected the move at runtime — I traced the helper's math, not the finder contract; (2) blamed Sonnet-5 "context-bleed" for the 4→7 attendee balloon when the log showed a *code* path (`addFromEvent` union); (3) concluded the B&H category was "correct" from the planMeeting *verdict* log when the actual Graph write used a different value. In every case the real runtime (log/dist/tool-tape) contradicted the reasoning-from-intent.
- **When many symptoms share one cause, fix the cause — don't whack-a-mole.** Six+ distinct bugs this session all traced to the Sonnet-5 swap; the one-line model revert collapsed the wave. The individual code fixes were still worth keeping (they close real model-independent gaps), but the leverage was in the common cause.
- **Sonnet 5 exposed prompt-only enforcement.** Behaviors 4.6 held via prompt (approval escalation, attendee tracking, honest "I checked", category choice, mention formatting) broke on 5 because nothing enforced them in code. Move enforcement to code.

## Recent arc — 3.7.x → 4.0.0 (CHANGELOG.md is canonical)

- **3.7.x–3.8.4** — real-day bug waves; efficient-calendar packing #133 (dense defrag) + round 2 (lunch consolidation, before/after-lunch push/pull); work-time overrides replace the full-day WE spine (#143); OOO-day calendar-health skip (#146); GKE deploy-doc merge. (Details in CHANGELOG / memory.)
- **4.0.0** — SDK 0.112, V4 pre-release audit, cloud-VM prep, dense-defrag finally executing. **Sonnet 5 attempted → reverted to 4.6 same-day** (the CHANGELOG 4.0.0 entry was corrected to record the revert, not claim Sonnet 5). Version held at 4.0.0 across the same-day follow-up commit.
- **4.0.1–4.0.3** — Sonnet 5 retry done RIGHT (adaptive thinking, orchestrator `high`; 4.0.1); thinking tuned per surface + guard stack parallelized (4.0.2); then a real-day bug wave (4.0.3) — meeting slot spread/cross-TZ, approval `reject`-vs-`amend`, image re-attach across turns, honesty guards, brief/news routing. (CHANGELOG canonical.)

## Watch live (first real use after redeploy)

- **Model:** boot stamp `4.0.0` / gitSha `cda1728`; LLM-usage logs show `claude-sonnet-4-6` on orchestrator + Sonnet guards, ZERO `claude-sonnet-5`.
- **Dense defrag:** an internal-only 6–29 min dead gap → calendar-health pulls the later meeting back-to-back (or pushes the earlier one) same-day, on-grid, only when the other person is free. This is the highest-risk autonomous path — verify each move.
- **Category:** an online external-client meeting tags as "Meeting", not "Outside" (watch the `category applied` log).
- **Reference-back:** read a meeting via get_calendar, then "move it / who's on it" → resolves by id, no "can't find it".
- **Group DM:** narration names whose conflict ("Alex is busy then"), no raw `@U…` ids.

## Operational

- **Restart to load code:** `npm run deploy` (build → `pm2 restart maelle` → tail). Single PM2-fork process. Boot stamp prints version + gitSha.
- **Exactly ONE Slack socket** — two Maelle processes on the same app → Slack `too_many_connections`. Never run local + another at once (critical for the eventual VM cutover).
- **Typecheck** (from the main repo, not a worktree): `npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json`.
- **GitHub:** bugs flow through chat / the spawned-task chip; never `gh issue create` without an explicit "file it."

Read at session start: memory `project_architecture.md`, `project_overview.md`, `project_we_timezone_spine.md`, `project_gcp_migration.md`, and the `feedback_*` memories (auto-load via `MEMORY.md`).
