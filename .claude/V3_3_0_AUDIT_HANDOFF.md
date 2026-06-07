# v3.3.0 audit handoff — 2026-06-06

**Project**: Maelle (Node.js/TypeScript executive assistant), **v3.3.0** at `E:\Code\Maelle`.
**Scope**: 8 parallel subagents covered: news skill, channel handling + thread actions, recovery/crash resilience, skill memory architecture, performance/API efficiency, agentic-loop design review, transport+permissions+security design review, cross-cutting sweep.
**Strict propose-only.** No code edits. Owner picks waves.

---

## Headline

**Architecture is healthy.** Path 2 holds, the Connection abstraction holds, the security model is sound. The findings cluster in three real shapes:

1. **The news skill ships with a critical contract break** — its `update_my_preferences(skill='news')` tool call **fails server-side** because `'news'` isn't in the Anthropic input_schema enum. The entire teach-vs-ask routing path is dead until that one-line edit lands.
2. **Latency & cost are 30–50% recoverable** by Haiku-flipping 4 always-firing Sonnet calls (addresseeGate, humanGate, closeLoopOnOwnerHandled, dateVerifier).
3. **Permission defense-in-depth is asymmetric** — the colleague positive-allowlist is the only wall for ~15 owner-only write tools; a single regression in `getSkillTools` widens the surface silently.

⚠️ **6 critical items.** Recommend fixing all 6 before next deploy:

1. **N-1/M-1** — `update_my_preferences` schema enum missing `'news'` (entire news teach-vs-ask broken)
2. **CH-1** — rate-limit DM leaked into public channel (privacy regression now that thread-actions reach channels)
3. **PERF-1** — `addresseeGate` uses Sonnet for a 12-token binary classifier (one-line model flip)
4. **R-2** — catch-up vs live socket re-delivery double-replies on restart
5. **T-5** — thread-action gate permanently authorizes ANY participant once owner has posted in the thread (stale-presence privilege grant)
6. **T-3** — identity-spoof judge can be social-engineered via window starvation + only checks same-domain emails

---

## TIER 1 — CRITICAL (production data loss / privacy / security)

### #1 — `update_my_preferences` enum missing `'news'`
- **Where**: `src/core/assistant.ts:341`
- **What**: Anthropic's tool-input validator rejects `skill='news'` server-side. The news system prompt (`news.ts:487`) instructs Sonnet to call this on every news-config message. Either the call errors or Sonnet silently drops a "news" save into the wrong skill file.
- **Bite**: Entire news teach-vs-ask path is broken. Owner says "track Acme" → nothing saves → next news fetch ignores it.
- **Fix**: Add `'news'` to the enum. Better: derive the enum from `PREF_SKILLS` at runtime so they can't drift.
- **Risk**: One-line.

### #2 — Rate-limit DM leaked into public channel (CH-1)
- **Where**: `src/connectors/slack/app.ts:332-342`
- **What**: When a colleague @-mentions Maelle in a channel/MPIM thread and they already have ≥2 pending requests with the owner, Maelle posts *"Hi — you already have a couple of pending requests with `<Owner Name>`. I'll follow up when those are resolved"* via `chat.postMessage` with **only `channel: channelId`, no `thread_ts`** → message lands at the TOP of the channel, visible to every member.
- **Bite**: Privacy regression. Discloses owner's name + backlog existence to anyone in the channel. Was tolerable when path only fired in 1:1 DMs.
- **Fix**: Pass `thread_ts` to thread the response; or DM the colleague when `isChannel === true`.

### #3 — `addresseeGate` uses Sonnet (PERF-1)
- **Where**: `src/utils/addresseeGate.ts:60`
- **What**: `model: 'claude-sonnet-4-6'`, `max_tokens: 12`, returns MAELLE/HUMAN/AMBIGUOUS — a binary classifier. Top-of-file comment says "cheap Haiku call" but code uses Sonnet (the rename never happened).
- **Bite**: ~1.5–2.5s + ~$0.003 per MPIM/channel message that hits the path. Fires whenever `<<GROUP DM>>` preamble pushes the name match out of the first-40-char fast-path.
- **Fix**: Change model string to `claude-haiku-4-5-20251001`. One-line, 50–70% latency drop on every gate hit.

### #4 — Catch-up vs live re-delivery double-reply on restart (R-2)
- **Where**: `src/connectors/slack/processedDedup.ts:19` (in-memory `Set`), `src/core/background.ts:483`
- **What**: `markProcessed`'s dedup Set is process-local; restart empties it. Bot restarts, `app.start()` accepts queued events from the outage, live handler replies (dedup empty), THEN catch-up runs ~5–15s later and finds the same DM with no bot reply indexed yet → posts a SECOND "↩ Catching up…" reply.
- **Bite**: Real on every restart with messages queued during the outage. The 10-min TTL comment at processedDedup.ts:20-27 only protects within one process lifetime.
- **Fix**: Persist dedup to a tiny `processed_msg_ts` table, OR run catch-up BEFORE `app.start()` accepts events, OR have catch-up check `conversations.replies` after posting to detect a live-handler double.

### #5 — Thread-action gate has no recency window (T-5)
- **Where**: `src/connectors/slack/app.ts:2012-2020` + `src/core/threadActions/index.ts:37`
- **What**: Owner-presence gate passes if `ownerSlackId` appears ANYWHERE in the thread's message history. Owner posts "👍" Monday; Friday a colleague in the same thread @-mentions Maelle and the gate passes — Maelle acts with owner authority indefinitely.
- **Bite**: Stale-presence authorization. A colleague who shares any old thread with the owner gets persistent write access to Maelle through that thread.
- **Fix**: Require owner to be one of the last N speakers (e.g. 3) OR posted within the last 24h.

### #6 — Identity-spoof judge window starvation + same-domain only (T-3)
- **Where**: `src/utils/securityGate.ts:79` (`detectClaimedEmail`), `:128` (`judgeIdentityClaim` slice(-5))
- **What**: Two holes: **(a)** judge sees only `recentUserMessages.slice(-5)` — pad the conversation with 5+ benign turns AFTER the impersonation claim to push it out of window. **(b)** detection requires `lower.endsWith('@' + ownerDomain)` — a colleague claiming "I'm Yael from acme.com" (off-domain) never triggers detection at all.
- **Bite**: Spoof bypass via simple conversation padding or off-domain claim.
- **Fix**: Tag the trigger line in the judge's full history, not just last-5. Drop the same-domain restriction — any first-person identity claim with an email mismatch should fire.

---

## TIER 2 — HIGH (real production bites, fix in next patch wave)

### Booking / thread actions
- **CH-2** — `app.ts:2007`. Owner-presence gate skipped when `threadTs === event.ts` (top-of-thread mention in real channel). Non-owner can drive Maelle in a brand-new channel thread.
- **CH-3** — `app.ts:1843-1844`. `app_mention` handler has no `bot_id` / `bot_message` guard. Another bot's `<@Maelle>` triggers thread actions / loops.
- **CH-6** — `app.ts:1991-1993`. On `conversations.replies` fetch failure, owner-as-sender still passes the gate but roster is empty → ships a booking directive with NO participants. Sonnet then invents attendees.

### News skill
- **N-2** — `news.ts:380-415`. Seen-log read→Haiku→write is non-atomic; brief + on-demand `news()` racing each other can lose entries. Cross-day dedup degrades.
- **N-3** — `news.ts:275-278`. `todayStamp()` uses `new Date().toISOString().slice(0,10)` — UTC date, comment lies. For Pacific owners between 4pm–midnight local, daily log goes into tomorrow's section.
- **N-4** — `news.ts:464-465` + `:499`. Prompt promises "today's meetings" on no-topic on-demand, but executor doesn't pass `meetingCompanies`. Sonnet narrates including meeting companies; gather doesn't include them.

### Recovery
- **R-1** — `assistant_threads` table has no `owner_user_id` column. `getActiveAssistantThreads` returns ALL panels regardless of profile. **Latent until 2nd tenant**, then N parallel double-replies per panel.
- **R-4** — No startup sweep re-queues stranded `in_progress` tasks. A crash mid-dispatch silently strands the firing — owner gets no routine, no error, no log.

### Skill memory / preferences
- **M-2** — `skillPreferences.ts:125-126,153`. `mode='replace'` skips dedup AND can erase the file with one bullet (after Sonnet misreads "the full new list"). No backup, no diff.
- **M-3** — `skillPreferences.ts:128,159`. Non-atomic read→compute→write. Two rapid `update_my_preferences` calls (Sonnet sometimes double-fires) clobber each other. Also `replace` racing the brief compose can produce a partial-file read.
- **M-7** — `news.ts:222` + `news.ts:500`. News source-steer parser **reads code-side** from the free-text MD file, breaking the "LLM-only — code doesn't parse" architecture claim. If Sonnet writes "prefer stratechery.com" instead of "Preferred sources: stratechery.com", domain steer silently drops to `[]`.

### Performance
- **PERF-2** — `app.ts:1700` + `app.ts:521`. TWO relevance gates fire on the same MPIM message when no @-bot AND not recently active. Collapse into one Haiku classifier.
- **PERF-3** — `orchestrator/index.ts:2138-2154`. `closeLoopOnOwnerHandled` (Sonnet, ~400 tokens) fires fire-and-forget on EVERY owner turn ≥3 chars whenever any open scanner items exist (normal state: 5–15 items). ~$0.005–$0.015/turn pure cost. Pre-filter with closure-shaped phrase lexicon + flip to Haiku.
- **PERF-4** — `humanGate.ts:294`. Sonnet, fires on every reply (owner + colleague) and every brief. Highest aggregate cost. Same shape as claim-checker which is already Haiku. Test a Haiku-flip.
- **PERF-6** — `coordinator.ts:261`. `isOutreachReplyByContext` calls Sonnet **serially** per active outreach. N=5 active = ~10s of pre-LLM latency. Batch into one call, or parallelize, or Haiku.

### Security / permissions
- **T-2** — `assistant.ts:386` `ownerOnlyTools` list contains 5 names; `COLLEAGUE_ALLOWED_TOOLS` positive allowlist is the only wall for 15+ owner-only write tools (`manage_routine`, `manage_calendar_issue`, `update_task`, `update_summary_draft`, etc.). One regression in `getSkillTools` and the surface widens silently. Add a chokepoint in `executeSkillTool` that re-checks the allowlist after dispatch.

---

## TIER 3 — MEDIUM (opportunistic, fix when nearby code is touched)

- **CH-4** — `app.ts:1843-1880`. No `event.user === botUserId` guard on `app_mention`. Self-loop possible if Maelle's text contains `<@MaelleId>`.
- **CH-7** — `app.ts:1932-1934`. `conversations.info` failure routes an MPIM as a real channel.
- **CH-10** — `core/threadActions/index.ts:131`. Raw Slack ID (`U0ABCDEF`) leaks into directive when no `people_memory` row. Pass the `users.info` name map into `buildThreadRoster`.
- **N-5** — `briefs.ts:63-87`. `deriveMeetingCompanies` doesn't cap inner loop — busy days run unbounded DB lookups.
- **N-6** — `news.ts:401`. `pruneSeenLog` uses unanchored substring `.replace()` on owner data. Use `^## YYYY-MM-DD\s*$/m` regex.
- **N-7** — `news.ts:189-212`. Tavily 5xx storms = 4× `logger.error` per brief. Add short-circuit on first 429/5xx to skip remaining goals.
- **M-4** — `skillPreferences.ts:140`. Dedup skips lines that don't start with `-`. After any `replace`, dedup is blind until owner re-teaches with `add`.
- **M-5** — `skillPreferences.ts:135-145`. Jaccard ≥ 0.6 too generous — refinements of existing prefs silently swallowed. Surface duplicate + prior line in `_note` so Sonnet can ask before dropping.
- **M-6** — `assistant.ts:331-355`. `replace` description says "the full new list" but schema doesn't enforce. Soft warning if new body is much shorter than prior.
- **PERF-5** — `orchestrator/index.ts:905-910`. Only static block cached. Split into (static skills) + (semi-static date/prefs/people) + (volatile turn-specific) for ≥2 more cache breakpoints across the tool-loop iterations.
- **PERF-7** — `briefs.ts:354-356`. Brief fetches `now - 2d .. now + 30d` of calendar; renders only today/tomorrow. Narrow to `today-2..today+8`. Saves 2–4 paginated Graph calls per brief.
- **PERF-8** — `postReply.ts:861-867`. Concision pass triggers on `≥2` question marks; "Want X? Or Y?" trips it unnecessarily. Raise threshold to 3 OR flip to Haiku.
- **PERF-9** — `dateVerifier.ts:268`. Sonnet for "find one wrong weekday" — Haiku-grade.
- **PERF-10** — `briefIntent.ts:41`. Sonnet for a single boolean classify.
- **PERF-11** — `taskContinuity.ts:75`. Sonnet for simple text matching inside the tool loop (blocks the loop).
- **PERF-15** — `calendar.ts:283`. `forceRefresh: true` overused — defeats the 300s cache TTL when owner says "check the calendar" 3× in a row.
- **PERF-16** — `briefs.ts:531-597`. Brief Sonnet system prompt grew to ~5KB across versions. Enable prompt caching on the static rules.
- **T-6** — `orchestrator/index.ts:385`. MPIM senderRole rewrite MUTATES `input.senderRole`. Use a derived const instead of overwriting input.
- **T-1** — `skills/outreach.ts:32` imports `calcResponseDeadline` from `connectors/slack/coordinator`. CORE module reaching into a Slack-bound connector breaks the Connection abstraction layering. Move helper to `utils/responseDeadline.ts`.

---

## TIER 4 — LOW / cosmetic / latent

- **CH-5** — Thread-action directive ordering risks owner-domain spoofing (latent; bypass-gate today).
- **CH-8** — `app.ts:2033`. `event.text.match()` without null guard (theoretical).
- **CH-9** — `app.ts:1977`. Duplicate `upsertPersonMemory` in MPIM thread path (wasted `users.info`).
- **CH-12** — `app.ts:1356`. Dead `containsSelfMention` branch under always-true `is1on1DM` gate.
- **N-8/9** — News polish: orphan `goals` not in seen-log; URL-encoding for `<url|label>` form.
- **N-11** — Scrubber missing `'news'` (collides with normal English; probably skip).
- **R-5** — Catch-up runs after `app.start()` — amplifies R-2.
- **R-6** — Panel `oldest` not passed to `conversations.replies` — false-negative skip only, safe direction.
- **T-4** — `securityGate.ts:319` comment claims fail-open; behavior is fail-safe. Fix the comment.
- **T-7** — APPROVAL_BOUND_TOOLS dynamic widening could re-fire a partially-completed deferred action.
- **T-8** — Shadow-notify regex tool-name extraction is fragile to digit/capital names.

---

## DEAD CODE

- **C-1** — `proactive_pending` column. Dead since v3.2.5; perpetuated into fresh clones via `migrations/v3_2_0_person_store.ts:32,122,136,143,174`. Drop from migration. `db/client.ts:336` ALTER stays for existing DBs.
- **C-2** — `dispatchSocialPingRankCheck` retired in v3.2.6; kept as drain. Schedule deletion after a couple of versions (`tasks/dispatchers/index.ts:19,29` + `tasks/types.ts:45`).
- **C-3** — `NewsReading` type + `readings` field on `NewsBundle` — populated `[]` always (Tavily extract removed); drop until needed (`news.ts:48,257`).
- **C-4** — `core/threadActions/` is in-flight Phase T1 scaffolding (T3–T5 not built). **Finish or revert** before next release.

---

## STALE COMMENTS

- **S-1** — `tasks/types.ts:40-45`. Block comment claims `social_ping_rank_check` "serves the coda path" — retired. Rewrite to "RETIRED in v3.2.6 — kept only to drain in-flight rows."
- **S-2** — `connectors/slack/recentOutboundContext.ts:111-119`. JSDoc references `social_ping_rank_check 48h later` as a downstream consumer (retired). Drop sentence, keep the write.
- **S-3** — `db/jobs.ts` has 12 repeated Path-2 invariant explainers. Consolidate to one canonical top-of-file note, replace others with `// see top-of-file Path 2 note`.
- **N-10/N-12** — `news.ts` carries 11 `v3.2.6` markers; package is v3.3.0. Per standing rule: don't sweep wholesale. Comment at `news.ts:276` ("Local date is fine here") actively lies — fix when N-3 lands.
- **CH-11** — `app.ts:46-56` header describes pre-v3.3.0 channel routing — update to summarize new thread-action behavior + owner-presence gate.

---

## TS HOLES

- **TS-6** — `categories?: string[]` missing from the canonical Graph event type (`connectors/graph/calendar.ts`). **16 `(ev as unknown as { categories?: string[] }).categories` casts** across calendar code. One-line fix erases all 16.
- **TS-3** — `JSON.parse` without try/catch in 4 hot paths in `tasks/briefs.ts:128,177,195,272`. A malformed log row crashes the brief task. Wrap each in try/skip.
- **TS-4** — `(person as unknown as { interaction_log?: string }).interaction_log` at `db/people.ts:1017`. Add `interaction_log?: string` to the row type.
- **TS-5** — `as unknown as UserProfile` at `userProfile.ts:625,632`. Zod-inferred type diverges from `UserProfile` interface.
- **TS-2** — `(profile.skills as any)?.social === true` at `socialDecay.ts:26`. Unnecessary cast; `profile.skills` is typed.
- **TS-1** — 138 `as any` across 30 files; `skills/meetings.ts` carries 39 alone. Known #80, deferred.

---

## DESIGN REVIEW — substantive observations (not bug fixes)

### Agentic loop

- **D-1**: `orchestrator/index.ts` is 2,370 lines, one function from line 361 to ~2,100 owning ~30 distinct concerns (pre-passes, tool-loop guards, post-processing, social coda). Order-dependency between guards is invisible without reading every comment block. **Future-pain landmine.** Suggest peeling into `core/orchestrator/turnPipeline/{preflight,classify,precheck,toolLoopGuards,postTurn}.ts` — opportunistically as next guards land.
- **D-2**: Four pre-check blocks (`availability`, `freeTime`, `recentCalendarIssues`, `colleagueBooking`) plus `priorOutbound`, action-tape, thread-context — all share the contract "build markdown block from deterministic facts, inject before Sonnet, fail open" but share zero code. Define a `Precheck` interface; collect+run+order in one place.
- **D-3**: `AssistantSkill` (core memory module) owns write tool handlers for `update_person_profile`/`update_person_memory` that are scope-filtered out of the colleague tool catalog at `registry.ts:215-218` but stay always-resolvable. Either make `'people'` a real skill OR split AssistantSkill into `MemoryReadsCore` + `PeopleWritesSkill`.
- **D-4**: Orchestrator has 20+ inline `require()` calls; pulls `WRITE_TOOLS` from `connectors/slack/inboundQueue` (lower layer). Move `WRITE_TOOLS` to `skills/registry.ts` or `orchestrator/toolMetadata.ts`. Promote dialed-in requires to top-level imports.
- **D-5**: Module G's coverage map (`ALWAYS_ON_TOOLS` + `SCOPE_TO_TOOLS`) is implicit; an unmapped tool ships everywhere with a warn-once log. The `web_research` case (v3.3.0) was exactly this. Add a CI test: every registered tool must be in `ALWAYS_ON ∪ ⋃ SCOPE_TO_TOOLS`.
- **D-6**: Gate stack order differs owner vs colleague (claim-checker first vs security-gate first). Top-of-file comment in `postReply.ts` enumerating order + why would save many future readers.
- **D-7**: `APPROVAL_BOUND_TOOLS` started as 2 tools (resolve_approval, list_pending_approvals); grown to ~12 (full scheduling + messaging + dynamic add-ins). Not a lock anymore — a drift filter. Rename to reflect what it actually is, or invert as `OFF_TOPIC_FOR_APPROVAL_THREAD`.
- **D-8**: Coda's own claim-check pass lives 1500 lines from the postReply.ts claim-check call site with no cross-reference. Extract `composeAndValidateCoda(...)` to `core/social/`.
- **D-9**: Skill `getSystemPromptSection(profile, scopes, isOwner)` is the right shape, but discipline ("if scope inactive, return small routing block") is informal. Add a JSDoc norm + a startup measurement (all-skill profile token size per skill).
- **D-10**: A handful of silent invariants need a single home doc (`docs/AGENT_LOOP_INVARIANTS.md`):
  - `turnLeftWorkPending` is sticky once set (never cleared mid-turn)
  - `cache_control` attaches to the static block only — no test asserts the static block stays static
  - MPIM rewrite mutates `input.senderRole` while `isOwnerInGroup` stays true
  - Tool-call cache treats `{error:string}` as not-cacheable; `summarizeToolCall` treats same shape as FAILED — consistent by accident

### Transport + security

- **T-1** (also production-tier): `OutreachCoreSkill` imports from `connectors/slack/coordinator` — abstraction leak that will break the Email/WhatsApp consumers when they come online.
- **What's clean**: Connection abstraction is real; force-self guards close the omit-target bypass; positive-allowlist for colleagues is the right architecture; VIP is owner-only by construction (`is_vip` not in `COLLEAGUE_SELF_WRITABLE_FIELDS`); identity-spoof Haiku fails safe.

---

## Recommended wave order

| Wave | Theme | Items | Risk |
|------|-------|-------|------|
| **W1 — Tonight** | Critical correctness | #1, #2, #3, #4, #5, #6 | Mostly one-line fixes; #4 needs careful design |
| **W2** | Latency wins (PERF cluster) | PERF-1 done in W1; PERF-2, 3, 4, 6 | Medium — model flips need spot-check on rewrite quality |
| **W3** | High-severity correctness | CH-2, CH-3, CH-6, N-2/3/4, M-2/3/7, T-2, R-1, R-4 | Medium |
| **W4** | Medium polish | All TIER 3 items + TS-6 (kills 16 casts) | Low |
| **W5** | Cleanup | Dead code (C-1/C-2/C-3), stale comments (S-1/S-2/CH-11) | Low |
| **W6** | Design refactors | D-1 (orchestrator peel), D-2 (Precheck type), D-5 (CI tool-map test), D-10 (invariants doc) | Schedule when load allows |

W1 is the only one with deploy-gate weight. The rest can wait for the next opportune patch.

---

## What's verified clean

- **Path 2 spine**: requests table owns lifecycle; coord_jobs/outreach_jobs status vestigial-but-correctly-handled.
- **Identity-spoof Haiku**: fails closed on parse error; refusal composer fails safe on throw.
- **VIP gate**: `is_vip` filtered out of `COLLEAGUE_SELF_WRITABLE_FIELDS`; owner-only writes confirmed.
- **Force-self guards**: 4 colleague-path guards close omit-field + wrong-target bypasses.
- **Cache write-invalidation**: `createMeeting`/`updateMeeting`/`deleteMeeting` invalidate before return.
- **Slack socket transient guard**: matches by stack + message, no exit on `unhandledRejection`.
- **News cost discipline**: 1 search per goal (was 8); 7-day seen-log dedup; fail-open.
- **Brief-in-thread routing**: brief asked inside thread replies in thread; scheduled brief stays DM.
- **Connection abstraction**: real except for the one T-1 leak.

---

**End of handoff. 8 subagents, ~80 atomic findings (6 critical, 17 high, ~30 medium, ~15 low/cosmetic, ~12 design observations). Project at v3.3.0.**
