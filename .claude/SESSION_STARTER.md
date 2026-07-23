# Maelle session context

Working on Maelle at `E:/Code/Maelle`. **Current version: v4.0.2** — `package.json` is the source of truth. **HEAD = the 4.0.2 wrap commit** (run `git log -1` for the SHA). The boot log stamps `version` + `gitSha` — confirm it matches HEAD after any restart. **Running model: `claude-sonnet-5`** — the Sonnet-5 retry is LIVE: the orchestrator runs adaptive thinking at `high`, and (4.0.2) COMPOSITION passes also think — brief `medium`, summary `medium`, knowledge `low`; the ~25 cheap classifier/guard passes stay thinking-off. 4.0.2 also parallelized the owner-facing guard stack (claim+humanGate+date, one wall-clock) + forced humanGate's verdict tool + moved close_loop to Haiku. Revert model = flip `MODEL_SONNET` back to `claude-sonnet-4-6` (one line). **Deferred:** the `isBriefRequest` brief-config misroute (see CHANGELOG 4.0.2).

## This chat = FEATURES **and** BUGS

General features + bugs chat. Standing mode:

- **Propose-first, code-first, root-cause.** Trace `logs/maelle-YYYY-MM-DD.log` + the code before attributing; state root cause as `file:line`. Bug reports / frustration / screenshots are diagnostic signals, **not** build signals.
- **Trace the RUNTIME, not the design.** Re-earned hard this session (I was wrong THREE times reasoning from intent/logs instead of the real runtime — see Lessons). Check the actual log line / DB row / deployed dist / tool-call tape, not the code's or a verdict-log's *description* of itself.
- **Build only on an explicit per-item "fix it / build it / do it"** on a *specific* bug/feature. Bare "ok / yes / go" is ambiguous — ask. On a build signal: edit → typecheck → **STOP** (uncommitted).
- **Wrap only on an explicit ship word** ("wrap / ship / commit / cut a version / bundle"). Default bump **PATCH**. (This session's follow-up was an explicit "commit but keep it 4.0.0" → committed with NO bump.)
- **Prompt is a budget, not a junk drawer.** Enforcement → code (chokepoint guard / a return-value the model reacts to / a tool that owns the decision). Prompt only for judgment / tone / format / language.

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

## Parallel chats on the same repo — route work to the right one

Assume 2–4 chats have uncommitted edits at any time. At wrap: `git fetch` + read the FULL working tree and bundle theirs too (this session's `cda1728` swept the guard chat's `textScrubber` + prompt chat's `systemPrompt` in per the all-chats policy). Never commit only your own files without checking the rest.

- **Meeting agent** — deterministic scheduling core, free/busy, slot finder, TZ/WE, create/move/close-loop. **OPEN item for them:** the `addFromEvent` union-vs-replace bug (below).
- **Guard agent** — the gate stack (`claimChecker`/`securityGate`/`humanGate`/`dateVerifier`/`weekdayGuard`/`postReply`). Shipped the bare-id scrub this session. **Pending:** guard-class audit findings M6/M7/M12/L10/L16/L17 (in `V4_AUDIT_HANDOFF.md`).
- **Prompt agent** — orchestrator system prompt + tool descriptions + per-skill sections + yaml. Shipped the group-DM narration this session.
- **Approval agent** — approvals / requests-spine / colleague close-loop. **OWNS bug 1.3 entirely (below) — do NOT touch the approval/escalation code from other chats.**
- **GCP migration chat** — VM cutover; infra committed in 4.0.0; blocked on Idan's `.env` + SSH.

Routing: honesty/leak → guard · narration/tone/tool-wording/yaml → prompt · approvals/close-loop → approval · deterministic scheduling → meeting · infra/deploy → GCP. **Exception:** dense packing / calendar-health auto-move / floating-block defrag (calendarHealth + rebalanceFloatingBlocks + calendarDensity) is owned by **this general chat**. Hand-offs = self-contained paste-blocks (root cause + `file:line` + log/DB evidence + a SUGGESTED fix framed as a suggestion to verify, not a mandate).

## Open / deferred bugs

- **1.3 — approval escalation not firing (approval chat OWNS the whole thing).** On the Alex/"Getting back the Automation" flows, `create_approval` never fired (`hasApproval:false` every turn) though it's in `ALWAYS_ON_TOOLS`. Owner's steer: investigate WHY beyond "the model didn't call it" — is there a code chokepoint that *should* auto-escalate; did 4.0.0's requests/runner/skill changes break it. **Escalation scope (MEMORY note):** colleague-attendee-busy is the colleague's OWN call, NOT an owner approval — only owner-RULE violations (#128) escalate. Do NOT touch these areas from other chats.
- **1.4 — MPIM owner-clamp: KEEP it, do NOT loosen.** Owner clarified the clamp is an **anti-cheat security boundary across ALL tools** (colleagues must never gain owner authority / book for themselves), not just calendar privacy. Keyed on the Slack-authenticated sender (`app.ts:96`, not spoofable). The owner's "flag-and-override" in his own group DM is delivered SAFELY via the approval flow (1.3), NOT by re-granting in-group authority. I stood down on the "Option A" loosen. `processMessage.ts:66/77` = the clamp.
- **`addFromEvent` union-vs-replace (meeting chat, OPEN, NOT built).** `findAvailableSlots.ts:248-252` on the owner move-path UNIONS the model's `attendee_emails` with the moving event's real roster → a wrong/hallucinated model set poisons the search (the "Getting back the Automation" 4-vs-7: model passed chris/isaac/onn/dina, event resolved yael/elan/ysrael → 7 → 0 slots). The comment claims "MOVE-PATH AUTHORITY" but unions instead of replacing. Fix = event roster is authoritative (replace, not union). **NEEDS Idan to confirm the meeting's real attendees** (was it model hallucination, or a wrong `moving_event_ids`?). Was left unbuilt because we reverted to 4.6 instead.
- **2.1 — "Idan Cohen is typing" indicator.** Not code-diagnosable (bot identity correct `U0ARK5814PQ`, no socket conflict, setStatus uses bot token + 1:1-only). Owner said "no worry about it" — dropped pending a repro/screenshot.
- **Remaining audit items** (`V4_AUDIT_HANDOFF.md`): mediums M5/M8/M9/M10/M11, Wave-5 lows, guard-class → guard chat. None block anything.
- **#144** — forward a colleague's attached image to the owner: honesty fix shipped earlier, the actual owner-ward file-forward NOT built. Still open.
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
