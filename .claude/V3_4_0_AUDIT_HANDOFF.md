# v3.4.0 audit handoff — 2026-06-16

**Project**: Maelle (Node.js/TypeScript executive assistant), **v3.4.0** at `E:\Code\Maelle`.
**Scope**: 8 parallel subagents — comment-archaeology/dead-code (owner's TOP ask this round), scheduling/booking, recovery/socket, guards stack, news, orchestrator/conversation-state, requests-spine/tasks/DB, cross-cutting (config/security/TS).
**Strict propose-only.** No code edited.
**Baseline**: covers the 3.3.0 → 3.4.0 arc (~13 real-day bug-bash versions). Items already-decided-skipped in prior audits were NOT re-flagged (see "Not re-flagged" at the bottom).

---

## Headline

Architecture is **healthy** — Path 2 holds, the single-validator (`checkSlot`) discipline holds, the Connection abstraction holds, permissions are sound (the v3.3.0 `executeSkillTool` chokepoint + `is_vip` owner-only + `get_person_memory` owner-only all verified intact). Config leaks: **clean** — zero new ones in the churn.

Two real shapes dominate:

1. **Comment debris is the owner's top complaint and it's real.** 999 `// vX.Y.Z` markers across 93 files; `ops.ts` alone has 151, `calendar.ts` 79, `calendarHealth.ts` 53. Worse than noise: several comments now **contradict the code** (a reader will believe the comment and ship a bug). One is stale *prompt text Sonnet reads every scheduling turn*.
2. **A tight cluster of ~12 production bugs**, mostly small fixes. The two with real teeth: a TZ-math error in the focus-floor validator (undermines the single-validator guarantee on any non-owner-TZ host) and an infinite-retry/stranded-request loop on a failed scheduled-outreach send.

⚠️ **Recommend fixing the TOP-7 before the next deploy** (all small, mostly one-liners).

---

## TOP PRIORITY — production bugs with teeth

### P-1 — Focus-floor validator parses event times in process-local TZ, not the event's zone
- **Where**: `src/utils/scheduleRules.ts:404-405` (rule 9, `focus_time_floor`)
- **What**: Rule 9 builds busy blocks with `new Date(ev.start.dateTime)`. Rules 6 and 8 in the SAME file correctly use `DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' })`. Graph returns `start.dateTime` as a bare wall-clock string (no offset) + zone in `start.timeZone`; `new Date(...)` interprets it in the **Node process's** TZ.
- **Bite**: When host TZ ≠ owner TZ (UTC server, owner in Asia/Jerusalem), every meeting in the floor calc shifts by the offset → phantom free time (floor never fires, over-books) OR false floor violations. This is the WRITE-path validator for named-time create/move/coord picks — the exact search-vs-validate divergence v3.1.2 set out to kill.
- **Fix**: Parse like rules 6/8: `DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' }).toJSDate()`. Best: extract a shared `parseEventInstant(ev.start, ownerTz)` used by rules 6, 8, 9 (folds in P-1b below). One-line-per-side otherwise.
- **P-1b (fold in)**: rules 6/8/9 should share one parse helper defaulting the fallback to **owner TZ**, not `'utc'` — the `?? 'utc'` fallback is a latent divergence if `timeZone` is ever empty.

### P-2 — `runSendScheduledOutreach` strands the request forever on a send throw
- **Where**: `src/core/requests/runner.ts:400-403`
- **What**: On a thrown `conn.sendDirect`, the catch returns `'rearmed'` but does NOT touch `next_check_at`/`next_check_handler`. Row stays `in_flight` with a past `next_check_at` → `getDueRequests` re-picks every 5-min tick → retries the send forever. Permanent failure (deactivated user, bad channel) = infinite loop + a request that never closes and pollutes the brief as open work.
- **Bite**: Infinite retry + permanently-stranded request. Medium-high.
- **Fix**: On catch, either `closeRequest(cancelled, 'scheduled_send_failed')` or re-arm with bounded backoff + retry cap. Mirror `runReminderFire`/`runResearchRun`, which always close regardless of DM success.

### P-3 — `reconcileOrphanedRequests` can mislabel a booked coord as cancelled
- **Where**: `src/core/requests/reconcile.ts:65-82` + `db/jobs.ts:520`
- **What**: Reconcile finds orphans by `coord_jobs WHERE request_id = req.id`. But `createCoordJob` inserts `request_id = NULL`, relying on `initiateCoordination` to call `linkCoordToRequest` "immediately after." If that link throws/never runs (the exact bypass class this module exists to catch), the coord_job is unreachable by request_id → reconcile branch (a) "coord_job gone" fires → closes the request as **cancelled** even if that orphaned job actually booked (its `external_event_id` is set but unreachable).
- **Bite**: Low frequency, high impact — booked-as-cancelled.
- **Fix**: Before closing-as-cancelled on a missing join, probe for an unlinked coord_job by `(owner, subject, created_at window)` with a non-null `external_event_id`; if found, resolve-as-booked. OR make `linkCoordToRequest` part of the same transaction as `createCoordJob` (closes it at the root).

### P-4 — News shown-detection breaks when the LLM alters the cited URL (silent stale-repeat)
- **Where**: `src/skills/news.ts:447` (`writeSeenLog` brief path), cite instruction `src/tasks/briefs.ts:574`
- **What**: Shown-detection is `bundle.sources.filter(s => s.url && text.includes(s.url))` — exact substring of the *gathered* URL in the posted brief. Nothing forces Sonnet to paste the URL byte-for-byte: a dropped `?utm_…`, trailing slash, `http→https`, or percent-decode makes `includes` false for an item that WAS shown.
- **Bite**: Shown article not logged → resurfaces tomorrow as "new" (the exact stale-repeat the seen-log prevents, silently). If Sonnet normalizes *every* URL, `shown.length===0` → nothing logged → whole brief re-offers tomorrow. Undermines the load-bearing v3.3.4 re-pull invariant.
- **Fix**: Normalize both sides before compare — strip scheme/`www.`/trailing-slash/query from `s.url` and from URLs scanned out of the brief (`<(...)\|` scan), compare host+path. Keep exact-includes as fast path. (Matching machine-emitted URLs in machine-emitted text — not owner free-text, so fair game.)

### P-5 — Periodic catch-up double-replies against a slow in-flight live turn
- **Where**: `src/core/background.ts:670-708` (`replayMissedMessage`) — calls `markProcessed(msgTs)` at :675 but **ignores its return value**
- **What**: Live DM handler ingests a message (marks ts) and starts a slow orchestrator turn (Anthropic latency / image describe / queue debounce) but hasn't posted yet. The 10-min periodic tick sees `userTs > botTs` (no bot reply landed), calls `markProcessed` (returns false = already marked), **discards the boolean**, and posts a second "↩ Catching up" reply. This lands precisely in the half-dead-socket case (inbound deaf, an earlier live turn still running).
- **Bite**: Double reply on the recovery path. (REC-2: a watchdog-reconnect catch-up overlapping a periodic tick is the same TOCTOU — the same fix closes it.)
- **Fix**: In `replayMissedMessage`, gate on the return: `if (!markProcessed(msgTs)) { log + return; }` before posting. The catch-up paths are the only callers that ignore the boolean.

### P-6 — Slot-hold conflict gate is one-sided (move_meeting + colleague create bypass it)
- **Where**: `src/skills/meetings/ops.ts:2895` (the override-hold gate) + `:3090` (post-book release); `move_meeting` handler at `:3607` has no gate
- **What**: Two holes in the in-flight #30 hold feature:
  - **move_meeting** has NO `getActiveHoldOverlapping` check — owner moving an existing meeting onto a held slot lands silently, no "X reserved that?" confirm, no holder DM.
  - The create gate is `if (senderRole === 'owner' && override_hold !== true)` — a **colleague** `create_meeting` over another colleague's hold skips the gate entirely (hold is invisible to free/busy). The `slotHolds.ts:18` design comment ("a race routes to the owner via create_approval — code never silently picks a winner") is NOT enforced colleague-vs-colleague.
- **Bite**: In-flight wiring gap — owner asked to be told before #30 ships. Not a privilege escalation (the colleague could book that free time anyway; the loser is DM'd), but contradicts the stated invariant.
- **Fix**: (a) mirror the gate + post-book release/DM into `move_meeting`. (b) extend the `:2895` gate to fire for colleagues when `conflictHold.holder_slack_id !== context.userId` → return `slot_on_hold`/`needs_owner_approval` so Sonnet routes to `create_approval` (as the annotation already instructs). Holder's own confirm proceeds.

### P-7 — securityGate `model_leak` regex nukes correct replies mentioning "Claude/Opus/Sonnet/Haiku"
- **Where**: `src/utils/securityGate.ts:39`
- **What**: `/\b(?:Anthropic|Claude|GPT-?\d?|OpenAI|Haiku|Sonnet|Opus|…)\b/i`. "Claude" (a real person's name), "Haiku" (a poem), "Opus"/"Sonnet" (product names) are common words. On a colleague path a benign reply mentioning any of them forces a Sonnet rewrite; if unsalvageable, falls to `SAFE_FALLBACK` ("Let me check that with Idan") — a guard replacing correct content.
- **Bite**: Medium — name/word collisions are real; the false-positive nukes real content.
- **Fix**: Drop bare `Claude|Opus|Sonnet|Haiku` from the deterministic trigger (keep `Anthropic|OpenAI|GPT|language model|claude-*`), OR require self-referential context ("I'm Claude", "powered by").

---

## HIGH — fix in the next wave

### H-1 — claimChecker 60-char floor lets short phantom-sends ship unverified
- **Where**: `src/utils/claimChecker.ts:94` — `if (input.reply.length < 60) return false;`
- **What**: `"Sent it to Yael ✅"` (18 chars) or Hebrew `"שלחתי ליעל"` (~10) skips the checker entirely. The 60-char floor predates the cheap tool-less own-the-miss rewrite; short confident false "sent/booked/done" claims are exactly the class the guard exists for.
- **Fix**: Lower to ~30 or remove (the remedy is cheap now; `bookingOccurred` already short-circuits the booking case).

### H-2 — coord_nudge re-arms to abandon even when every nudge DM failed
- **Where**: `src/core/requests/runner.ts:447-459`
- **What**: On `!res.ok` it only logs, then unconditionally stamps `follow_up_sent_at` + re-arms `coord_abandon` +4h. If all nudge DMs failed (Slack outage, all deactivated), the coord is abandoned 4h later despite no participant ever being pinged; owner told "couldn't get a response" when Maelle never reached anyone.
- **Fix**: Track a `sent` count; if zero succeeded, don't stamp `follow_up_sent_at` and re-arm `coord_nudge` (retry) instead of `coord_abandon`.

### H-3 — offeredSlots stash not cleared on coord-finalize / owner-self-book in a colleague DM
- **Where**: `src/skills/meetings/ops.ts:3250` (`clearOfferedSlots` only on direct colleague create) vs `src/utils/offeredSlotsStash.ts`
- **What**: If the colleague conversation books via `finalize_coord_meeting`, or the owner books the slot himself in that DM, the stash survives its 2h TTL → next colleague turn gets the "SLOTS ALREADY OFFERED … (binding)" block pointing at an already-booked instant. The module header calls out exactly this failure; only one booking exit clears it.
- **Fix**: Clear in the orchestrator after any `create_meeting`/`finalize_coord_meeting` that resulted in a real booking (`bookingOccurred` is already computed at `index.ts:1837`) — one chokepoint covers every exit.

### H-4 — coda language uses raw Hebrew-codepoint regex, not `detectMessageLanguage` (English-in-Hebrew-out on the coda tail)
- **Where**: `src/core/orchestrator/index.ts:2321` — `const codaLang = /[֐-׿]/.test(input.userMessage) ? 'he' : 'en'`
- **What**: The v3.3.10 language split moved decisions to `detectMessageLanguage` (dominant-script, 30% threshold). The coda generator still uses "any Hebrew codepoint → he". A mostly-English message with one Hebrew name → Hebrew coda stapled to an English reply — the exact class the split was built to kill. Also he/en only (Russian/Arabic-pref always gets English coda).
- **Fix**: Reuse `detectMessageLanguage(input.userMessage)` and map.

### H-5 — dateVerifier weekday swap uses `String.replace` (first-occurrence only)
- **Where**: `src/connectors/slack/postReply.ts:753` — `mm.matchedText.replace(mm.writtenWeekday, mm.correctWeekday)`
- **What**: String-arg `.replace` swaps only the FIRST occurrence. If the span has the weekday word twice ("Thursday — yes, Thursday the 11th", or Hebrew doubled), only the first is corrected; the draft ships a wrong weekday in the same span while the guard reports success.
- **Fix**: `split(writtenWeekday).join(correctWeekday)` (same idiom used one line down at :755), and verify `matchedText.startsWith(writtenWeekday)` before applying (H-5b: the swap assumes the weekday is span-start; the extractor LLM isn't forced to return it that way — anchor or skip).

---

## MEDIUM — opportunistic

- **M-1** — `move_meeting`'s `must_be_after_event_id` description (`meetings.ts:470`) promises a refusal that isn't enforced in the move handler (the checks live in find_available_slots + create_meeting). Either add the guard or correct the description (overpromises to Sonnet).
- **M-2** — Watchdog reads `(app as any).receiver?.client` (`app.ts:2236`); if undefined at first poll or Bolt renames it, the fail-safe disables the watchdog **permanently** with one startup log → the silent-zombie class the watchdog exists to kill, relocated up one level. Fix: hourly re-log while disabled, or a louder one-time owner shadow-notify so a Bolt upgrade that breaks it is visible. (`app.ts:2243-2249`)
- **M-3** — On-demand `news()` logs the WHOLE bundle (up to 15) as seen, not just what Sonnet surfaced (`news.ts:582`, no `briefText`) → 8+ unshown items suppressed for 7 days. Inverse of the brief-path shown-only discipline. Fix: cap the on-demand log to the shown ceiling (slice to 7), or accept as topic-level and tighten the comment.
- **M-4** — Replay path doesn't call `markContentProcessed` (`background.ts` replay) → the panel-mirror duplicate class (different ts, same content) is unguarded on recovery. Narrow (5s TTL makes it best-effort anyway). Fix: call it alongside `markProcessed` in `replayMissedMessage`.
- **M-5** — Slot-hold expiry DM fires for already-past slots (`background.ts:31-50` + `slotHolds.ts:178` `getDueSlotHolds` has no `start_iso > now` guard) → "I freed up Tuesday 2pm" on Wednesday. Fix: only DM when `start_iso > now`; release past slots silently.
- **M-6** — `runExpiry` sends the "never heard back, closed it" tombstone DM without checking `closeRequest`'s return (`runner.ts:121-150`) → if the coord booked in the same 5-min window, owner gets a false "never heard back" DM. Fix: gate the DM on the close actually happening.
- **M-7** — humanGate fact-preservation net misses spelled-out dates ("June 11", "the 11th") — only guards `@mention`/`HH:MM`/`numeric date` (`humanGate.ts:287-311`). A voice-rewrite dropping "June 11" has no backstop (dateVerifier only fixes weekday words). Low-medium; flagged as known gap.
- **M-8** — `offeredSlots` read/record gate asymmetry (read gated on `senderRole==='colleague'` at `index.ts:816`, record on `!isOwnerInitiatedSearch` at `ops.ts:2000`) — latent (no current misbehavior because owner-in-MPIM records nothing), fragile if a future change makes the meetings handler see the mutated `senderRole`. One-line comment or align both gates.
- **M-9** — SCHED-4: snapped duration (30→25) means the attendee-busy confirm text says "book anyway?" for a window length that differs from what the owner thinks he's confirming. Narrow, self-consistent; only matters if you want the confirm text to state the snapped length.
- **M-10** — NEWS-2: the "unshown resurfaces ~3 days" guarantee only holds for low-volume topics (a fast-moving topic pushes the unshown item out of Tavily's top-15 within a day). Not a bug; the comment at `news.ts:43` overstates it. Tighten the comment.
- **M-11** — coordGuard `\x00` null-byte pattern is dead (won't survive transport); securityGate `inject_marker` `/\[\]\s*$/m` over-matches any line ending in `[]` ("the array is `[]`") → benign rewrite. Fix: drop `\x00`; tighten to the `[%00]` form.
- **M-12** — `pruneSeenLog` keeps headerless preamble forever (`keepCurrent` starts `true`, `news.ts:336`) — only bites on external corruption. One-line defense-in-depth.

---

## COMMENT ARCHAEOLOGY — owner's TOP ask (999 markers, 93 files)

The owner explicitly wants this cleaned ("saw one line with 4 stacks of comments"). This **reverses** the old "#79 don't wholesale-sweep version markers" stance. Rule of thumb agreed: **keep the WHY, drop the version prefix + issue-number; delete "pre-vX it used to…" sentences entirely; collapse stacked multi-version blocks to one present-tense line.**

### Highest value (do first)
- **CMT-1 — `meetings.ts` stale coord-doctrine PROMPT block** (`:2288`,`:2295`,`:308`,`:422`,`:2207-2295`). The system prompt simultaneously **retires** the coord-state-machine doctrine (`:308` "v3.3.8 — doctrine retired") AND **re-teaches** it (`:2295` "COORD STATE MACHINE (the only thing coordinate_meeting does post-v2.7.2)…"). This is **stale prompt text Sonnet reads every scheduling turn** — correctness + noise. Collapse to the v3.3.8 reality (coord = poll calendar-invisible externals only); drop the version tags from prompt text.
- **CMT-2/3 — `ops.ts` (151 markers)** — stacked 2-version fix-blocks (`:1859-1873`, `:2960-2973`, `:2746-2799`, `:3746-3749`) + ~40 issue/scenario breadcrumbs (`(B5/#63)`, `(102a)`, `(scenario 8 row 7)`, `(Dina webinar 2026-06-14)`, `Pre-v2.4.3 used " — "`). Densest file. One pass: strip issue-numbers, delete "pre-vX used to" sentences, collapse the 2-version stacks to one WHY.

### Cross-file tombstone sweep
- **CMT-4 — `registry.ts`** (`:159-166`,`:179-182`,`:312`,`:341`) — 3 overlapping "coord demotion" stanzas across versions. Collapse to one.
- **CMT-5 — deleted-task-type tombstones** in 6 files (`coordinator.ts:11-18,206,304`, `meetingReschedule.ts:176`, `outreach.ts:282,343`, `closeMeetingArtifacts.ts:19,144`, `summaryActionFollowup.ts:171`) — "the old `type='outreach_send'` task was deleted" restated everywhere. Delete; keep one spine pointer.
- **CMT-6 — `social_ping_rank_check` tombstone** (`orchestrator/index.ts:2410`, `recentOutboundContext.ts:116`) — collapse to one live-WHY line.
- **CMT-7 — `social_outreach_tick` tombstones** (`client.ts:331-336,779`, `background.ts:294-301`) — trim; drop `'social_outreach_tick'` from the inline schema-enum comment.

### General pass on `calendar.ts` (79) / `calendarHealth.ts` (53)
Most single-line `// vX.Y` there are legitimate WHYs — **keep the sentence, drop the version prefix + issue-number**; only delete outright when it narrates a "pre-vX.Y it used to…" that no longer applies.

---

## STALE COMMENTS THAT CONTRADICT THE CODE (mini-bugs — a reader will believe them)

These are higher-priority than archaeology — they actively mislead:

- **`background.ts:334,349,375`** — three comments say catch-up "falls back to 24h on first boot" / "24h lookback". The code does `oldest = now` on no watermark (replays NOTHING). Directly contradicts code + the v3.3.10 top-of-file note. **A future reader will think first-boot sweeps 24h.**
- **`background.ts:591-597`** — says panel coords come from "the DB-backed `assistant_threads` registry, which survives restarts" — that's the registry v3.3.10 **abandoned** for `discoverThreadParents` (history-based). False.
- **`humanGate.ts:1,33-38`** — header says "v2.7.8 Module C / single **Sonnet** pass / **Owner-facing only**". Runs on **Haiku** (`:347`) on **both** owner AND colleague paths. (accurate note buried at `:344`.)
- **`coordGuard.ts:6` + `orchestrator/index.ts:1583`** — both call the judge "**Haiku**, cheap"; it's `claude-sonnet-4-6` (`coordGuard.ts:167`).
- **`briefIntent.ts:16`** + **`taskContinuity.ts:12`** — headers say "**Sonnet** judge/classifier"; both use `claude-haiku-4-5` (`:41`, `:75`).
- **`claimChecker.ts:285,290`** — comments name "**Sonnet** adds prose preamble"; the action checker runs on **Haiku** (`:273`).
- **`postReply.ts:13-18`** — file header still describes the **removed** "re-invoke orchestrator + force message_colleague, capped at one retry" path (now a tool-less rewrite). Contradicts the body + its own correct docblock at `:441`.
- **`postReply.ts:605`** — references `detectIdentitySpoof` in securityGate; that function doesn't exist (it's `detectClaimedEmail` + `judgeIdentityClaim`).
- **`processedDedup.ts:20-28`** ("60s — same as before", constant is 10min) + **`:88-90`** ("90s TTL", constant is 5s).
- **`news.ts:2,9-11`** — banner "v3.2.6"; header says gatherNews "points `runResearch`" — it calls `tavilySearch` directly since v3.2.6.
- **`runner.ts:5-7`** — header enumeration omits `reminder_fire`/`research_run`/`send_scheduled_outreach`/`coord_abandon`.
- **`closeRequest.ts:1-11`** — "Five callers, exhaustive" — no longer true (cascade + reconcile + reminder/research/outreach runners also call it).
- **`orchestrator/index.ts:2195-2206`** — v2.0.7 shadow-DM narration describing a path moved to `postReply.ts` in v3.0.8; only `void requiresApproval;` remains.

---

## DEAD CODE

- **`proactive_pending` column** (`db/client.ts:336`) — dead since v3.2.5 (only writer is the ALTER default). Leave the column (drop = risky rebuild) but trim the comment; tracked-ticket candidate.
- **4× unused `config` imports** — `claimChecker.ts:28`, `humanGate.ts:46`, `coordGuard.ts:13`, `securityGate.ts:17`. Plus **`briefIntent.ts:27`** and likely **`orchestrator/index.ts:3`** (verify by grep).
- **`getDueRequestsByHandler`** (`db/requests.ts:383`) — no callers (pre-consolidation leftover). Grep-confirm then remove.
- **`outreach_decision` handler branch + type member** (`runner.ts:90-92`, `types.ts:86`) — unreachable (nothing sets `nextCheckHandler='outreach_decision'`).
- **`last_participant_activity_at` on CoordJob** (`jobs.ts:495`, `client.ts:217`) — declared + migrated, never written/read. Vestigial.
- **`scripts/deploy-watcher.mjs`** — orphaned since v3.3.9 (ecosystem.config.js documents the removal). Owner-curated `scripts/` → manual delete.
- **`buildOutOfHoursBusy` / `hhmmToMinutes`** (`ops.ts:64-146`) — `hhmmToMinutes` kept alive only by `void hhmmToMinutes` at `:143` with a comment claiming "still referenced" — it isn't. Candidate for removal.
- **`dateVerifier._userMessage`** param (`:150`) — unused; caller still passes `userMessage`. Vestigial wiring.
- **XC-2 — slot-hold `as any` casts** (`ops.ts:1816`, `:2029`) — new in #30 churn; type as `{ start: string; end?: string }`. (Not the #80 cluster.)

---

## NOT RE-FLAGGED (already decided — do not propose again)

- **app_mention bot-author guard** (CH-3/M-1) — owner: Maelle is "human", bots CAN call her.
- **R-1 panel multi-tenant scope** — irrelevant (clone = new server).
- **R-4 stranded-`in_progress`-task auto-reset** — rejected as too risky.
- **PERF-6 `isOutreachReplyByContext` fanout** — won't happen soon.
- **M-9 (old) prefs `replace` data loss** — "can it really happen, don't fix".
- **#80 `meetings.ts` `as any` cluster** — separate ticket, deferred.
- **`dispatchSocialPingRankCheck` drain dispatcher** — intentional drain.
- **claimChecker Sonnet (rewrite-verify)** — deliberate v3.3.7 choice.
- **MPIM `senderRole` input mutation** — documented invariant #3.
- **cache_control static-only** — documented invariant #2; no hole (verified).
- **Hebrew colleague-leak** (securityGate English-only) — owned by the parallel guards chat (`.claude/GUARDS_LEAK_HANDOFF.md`); still unaddressed, NOT re-deep-dived.

---

## Recommended wave order

| Wave | Theme | Items |
|------|-------|-------|
| **W1 — before next deploy** | Production teeth | P-1, P-2, P-3, P-4, P-5, P-6, P-7 (all small) |
| **W2** | High correctness | H-1, H-2, H-3, H-4, H-5 |
| **W3 — owner's top ask** | Comment cleanup | Stale-contradicts-code list FIRST (mini-bugs), then CMT-1 (prompt text), CMT-2/3 (ops.ts), CMT-4-7 (tombstone sweep) |
| **W4** | Dead code | the dead-code list (one sweep) |
| **W5** | Medium | M-1…M-12 opportunistically |

W3's stale-contradicts-code sublist should arguably ride with W1 — those comments are how the next bug gets written.

---

**Audit complete. 8 subagents. ~12 production bugs, ~12 medium, a large comment-debris cleanup (owner's headline ask), and a dead-code sweep. Config leaks clean, permissions sound, architecture healthy.**

---

## SESSION 2 — what got FIXED (2026-06-16, post-audit build pass)

Typecheck clean (EXIT=0) after every change below. Uncommitted in the working tree (owner commits).

### Production bugs
- **P-1 — FIXED.** `scheduleRules.ts` rule 9 focus-floor now parses event times zone-aware (`DateTime.fromISO(..., { zone: ev.start.timeZone ?? 'utc' })`), matching rules 6/8. Kills the process-TZ skew on non-owner-TZ hosts.
- **P-7 — FIXED.** `securityGate.ts` `model_leak` regex no longer matches bare `Claude|Haiku|Sonnet|Opus` (names/words). Kept `Anthropic|OpenAI|GPT|claude-<id>|large language model`; added `model_self_ref` to still catch "I'm Claude / powered by Sonnet".

### Verified, AWAITING owner fix decision (explained in chat, not built)
- **P-2 — REAL, narrow.** `runner.ts:401` catch returns `'rearmed'` without re-arming → infinite retry + stranded request, but ONLY when `conn.sendDirect` THROWS (the `{ok:false}` path is handled). Fix: bounded-retry or close-on-throw.
- **P-3 — MOSTLY ALREADY FIXED** by v3.1.1 reconcile (reads `external_event_id`, branch (b) resolves-as-booked). Residual: only if `linkCoordToRequest` throws AND the unlinked coord books → branch (a) cancels. Narrow race. Optional root fix: make link atomic with `createCoordJob`.
- **P-4 — VERIFIED REAL.** `news.ts:447` shown-detection is exact-URL substring; Sonnet trimming `?utm_`/trailing-slash → shown item logged as unshown → resurfaces as stale repeat. Fix: normalize both sides (host+path) before compare.
- **P-5 — VERIFIED REAL.** `background.ts` catch-up driver never checks `hasProcessed`; `replayMissedMessage:676` ignores `markProcessed`'s return → double-reply against a slow in-flight live turn. One-line fix: `if (!markProcessed(msgTs)) return;`.
- **P-6 — CONFIRMED TRUE (both halves).** `move_meeting` has NO hold gate; colleague `create_meeting` bypasses the owner-only (`senderRole === 'owner'`) hold gate at `ops.ts:2896`. Fix: mirror the gate+release into move; extend create gate to colleagues (`holder_slack_id !== context.userId` → route to approval).

### Dead code — REMOVED
- `getDueRequestsByHandler` (`db/requests.ts`) — zero callers.
- 5 unused `config` imports: `claimChecker.ts`, `humanGate.ts`, `coordGuard.ts`, `securityGate.ts`, `briefIntent.ts`.
- LEFT (intentional): `last_participant_activity_at` (write-only, column-drop risky), `outreach_decision` case (defensive for legacy rows), `proactive_pending` column (drop = risky rebuild), `hhmmToMinutes`/`buildOutOfHoursBusy` (buildOutOfHoursBusy IS live — needs careful read), `scripts/deploy-watcher.mjs` (owner-curated scripts/).

### Comments — contradicts-code FIXED (these were mini-bugs)
- `background.ts` ×3 — the "falls back to 24h on first boot" lie → now correctly states `oldest=now` / replay-nothing (matches code at :409).
- `humanGate.ts` header — "Sonnet / owner-facing only" → Haiku / both audiences (was self-contradictory).
- `briefIntent.ts` / `taskContinuity.ts` — "Sonnet" judge → Haiku. `coordGuard.ts` — "Haiku" judge → Sonnet.
- `processedDedup.ts:89` — "90s TTL" → 5s.

### Comments — BULK version-marker sweep DONE (the "4 stacks on a line" debris)
- `ops.ts` — ~115 comment edits, **all 151 `// vX.Y.Z` markers gone**. Functional `_note`/`_deferred` strings verified intact.
- `calendar.ts` — 49 edits (~50 fewer comment lines). Diff verified comment-only.
- `calendarHealth.ts` — 37 edits. Tool `description:` + `getSystemPromptSection` prompt text left untouched.
- All three: agents ran a strict comment-only mandate + a typecheck-0-errors gate proving no code touched.

### STILL OPEN (next session / other chats)
- **CMT-1 → PROMPT MANAGER, not comment cleanup.** `meetings.ts:2288-2295` is LIVE prompt text (`getSystemPromptSection`). The "COORD STATE MACHINE (the only thing coordinate_meeting does post-v2.7.2)" block doesn't scope coord to the owner-path, even though v3.3.8 removed coord from the colleague allowlist. Editing it changes Sonnet behavior → belongs in the prompt-manager workflow, NOT a bulk comment edit. Flag filed here.
- **Lower-stakes stale comments not yet swept**: `postReply.ts:13-18` (describes the removed retry path) + `:605` (`detectIdentitySpoof` no longer exists — it's `detectClaimedEmail`+`judgeIdentityClaim`); `news.ts:2,9-11` (v3.2.6 banner + "runResearch"); `runner.ts:5-7` (handler enumeration incomplete); `closeRequest.ts:1-11` ("five callers exhaustive"); `orchestrator/index.ts:2195-2206` (v2.0.7 shadow-DM narration moved to postReply); `claimChecker.ts:285,290` (Sonnet refs — the action checker is Haiku, only the rewrite is Sonnet).
- **Long tail**: ~90 other files carry a handful of `// vX.Y` markers each (the big-3 are done). Opportunistic future pass; not worth a dedicated sweep.
- **Medium/low tier** (M-1…M-12, the HIGH items H-1…H-5): untouched — see tiers above.

**Session-2 build pass: 2 production fixes (P-1, P-7), 6 dead-code removals, ~10 contradicts-code comment fixes, 3 bulk file comment-sweeps (201 marker-comments cleared). Typecheck clean throughout. Nothing committed.**
