# Agent-loop report

**Every row is written from the chat's point of view first** — what a person saw happen — then the bug, the lane, and the status. If a row can't be told as something that happened in a chat, it isn't ready to be a row.

---

## 🟢 Status: nothing is waiting for your commit

**Built and committed today:** `af19500` (scheduling core) · `221c805` + `e137515` (framework) · `ac11dd6` (reply path) · `87b4f17` (intake merge rule). All 4.2.0 — same version, finishing the work.

**Built and awaiting commit: NOTHING.** The tree is clean.

**Everything below is UNBUILT and waiting on you.** Nothing here has been touched.

> Two categories will reach you, and they are not the same:
> - **This file** — found, understood, *deliberately not built*. You decide whether it's worth doing.
> - **Tonight's Bugger run** — will produce rows that are **already built and uncommitted**, awaiting your review + wrap. Those appear under a separate "Built" heading with the risk to eyeball.

---

## 🔴 A person sees something wrong

| # | What happened (in chat) | The bug | Lane |
|---|---|---|---|
| P1 | A colleague counters your approval — changing only the subject — you get the follow-up, tick ✅, and it **books over a meeting you already have without ever naming the clash** | `resolver.ts:1043` is a **third** owner decision surface. It re-stamps the terminal message so ✅ resolves, and it never carries a hard reason | requests |
| P2 | She truthfully sends you a file, says so — then corrects herself: *"that didn't go through yet"* | `deliver_file` is a legal claim type but not a `MutationDomain`, so `mutated=deliver_file` can never be true → shield off → the checker "corrects" a **true** claim. Same for `hold_slot`, `revert_last_auto_move`, `set_work_schedule_override` | guard |
| P3 | A colleague sees a **raw internal id** | The scrubber *detected* it and couldn't wrap it — detector is `[A-Z0-9]{7,}`, wrapper is `[A-Z0-9]{7,10}` — and `securityGate` then ships the original anyway, on a fail-open justified by a re-wrap that is a no-op. **This is the 2026-07-01 Oran leak shape** | guard |
| P4 | She correctly tells a colleague *"let me check with Idan and come back to you"* — and the whole reply is sent to Sonnet to have "planning narration" stripped. Separately, a Hebrew planning leak is never caught at all | `DELIBERATION_RE` is the sole trigger and it is English-only; the veto that protects the rewrite only guards @mentions, times, dates and questions, so a commitment sentence can be deleted | guard |
| P5 | An API blip mid-turn and your entire answer becomes *"Sorry — I hit a snag on this one"* | `humanGate` `safeFallback` fires on any throw when the draft contains a request id — which you legitimately see. The probe makes one outage hit it twice | guard |
| P6 | *"The OpenAI meeting moved to 3"* comes back as an English error message | `securityGate`'s `model_leak` trigger matches bare vendor names and is disclosure-class, so an unsalvageable draft becomes the safe-fallback | guard |
| P7 | A Hebrew or Russian speaker hits an error and gets an **English** apology | The new reply-path failure lines are English-only — and this one **cannot** use an LLM, because on the 529 path the model is exactly what is unavailable. Needs `detectMessageLanguage` + a static table | slack |
| P8 | Graph goes down at the network level: instead of *"Idan's calendar is offline"* she surfaces a raw error and improvises | Graph's SDK erases the cause chain and sets `statusCode: -1`, so the transport-errno branch of `isOutageShaped` is unreachable. **Fails closed — nothing books** | meeting |
| P9 | You ask what's on your calendar during an outage and she improvises off a raw error string | `get_calendar` is the one meeting surface the offline refusal deliberately didn't cover | meeting |
| P10 | Graph is down, a colleague asks *"is Idan free at 3?"* — she answers with **no verdict behind it** | The pre-check injects nothing on failure. Safe (silence, not a wrong answer), but only the model choosing to call a tool protects the colleague | guard |
| P11 | On a vacation day she's told *"do NOT say he's booked"* and then handed the exact sentence *"he's booked then"* | `availabilityPreCheck.ts:653` contradicts its own footer at `:663`. Wording only — the verdict is a correct no | guard |
| P12 | She offers you a Thursday slot sitting over an optional meeting and doesn't mention it | The alternatives payload drops the `over_optional` tag. Pre-existing; the anchor change raised its likelihood | meeting |
| P13 | A time that has **already passed** is described to a colleague as *"excluded by day-load protections"* and they're invited to ask you to override it | `in_the_past → within_lead_time` mapping, and nothing clamps `search_from` to now | meeting |
| P14 | Two rounds of options, then *"the 11:00 you offered"* doesn't resolve | Two full 8-slot offers evict the oldest 4 from the 12-slot stash | meeting |
| P15 | A malformed calendar request reads as *"nobody is busy"* | Three fail-opens left in `getFreeBusy`. **Deliberately not fixed** — they're malformed-request classes, and refusing would recreate the #137 mis-escalation in reverse | meeting |
| P16 | You override onto a vacation day and the search offers nothing | The day-level OOO gate isn't relaxed-aware. Direct `create_meeting(relaxed)` still books. Reads as your stated intent — flagged as a delta | meeting |
| P17 | She's handed a new reason code the prompt never taught her, and an existing line argues against narrating it correctly | `owner_out_of_office` missing from `meetings.ts:197-206` | context |
| P18 | In a real **channel**, nothing checks whether she claimed to have done something she didn't | `isChannel` never reaches the gate stack, so `claimChecker` doesn't run there. Separate from the group-DM bug, which is fixed | guard |
| P19 | A leak she caught and scrubbed is **stored unscrubbed**, replayed to the model next turn, and fed to the coda generator | The colleague leg never writes the post-gate text back to history | guard |
| P20 | A rewrite introduces a wrong weekday and nothing re-checks it | On the colleague leg `dateVerifier` runs *before* the two rewriters | guard |

## 🟡 Latent — nothing visible today, but one edit away

| # | What would happen | The bug | Lane |
|---|---|---|---|
| P21 | A colleague reads private meeting subjects and attendee emails | `list_pending_approvals` ships the whole payload. Owner-only today, blocked at two chokepoints — but nothing in that tool needs more than id/kind/subject/dates | requests |
| P22 | A colleague-path `move_meeting` sets the override flag directly, so *"`allowRelaxed` implies the owner"* is true in the comment and false in the code | `moveMeeting.ts:1094`, the one exception in a 7-site enumeration. Neutralised today by the strict pre-gate above it, and nothing branches on the invariant | meeting |
| P23 | A 429 or rolling-restart 503 reads as a full outage more often than needed | The offline retry has no backoff — two calls, same tick | meeting |
| P24 | A health check dumps a raw Graph error into her context during an outage | `calendarHealth` isn't routed through the offline wrapper. Fail-closed is right; only the wording is inconsistent | meeting |
| P25 | Out-of-hours occupied slots outrank the true in-hours blocker in day narration | They now return rule 8 instead of rule 5, escaping the noise filter | meeting |

## ⚪ Wrong comments and drift risk — no behaviour

| # | The bug | Lane |
|---|---|---|
| P26 | `runOutputGates.ts:35` still states *"Every gate FAILS OPEN"*. False on the colleague leg — two unwrapped paths. Today's fix means a throw reaches the person as a sentence, but the contract is still wrong | guard |
| P27 | `inboundQueue.ts:199-201` says an aborted turn's message "is still in pending". It isn't — `scheduleRun` clears it. No information is lost; the comment describes a mechanism that doesn't exist | slack |
| P28 | A third copy of the overload string at `handlers.ts:182`. Different shape, so deliberately not folded into `failureReply` | slack |
| P29 | Two copies of the all-day-OOF predicate (`scheduleRules.ts:409`, inline at `analysis.ts:367`). They agree exactly today | meeting |
| P30 | `analysis.ts:346` — the day-off push path doesn't carry `outOfOfficeAllDay`. Not live: the renderer skips day-off rows | meeting |
| P31 | The occupancy scan is now unconditional — roughly **3× the scan work** on a 21-day search. **Unmeasured**; needs a wall-clock delta, not a code read | meeting |
| P32 | All-day `workingElsewhere` counts as a hard commitment in one place and explicitly doesn't in another. Pre-existing, zero occurrences in the logs | meeting |

## 🔵 Product calls, not defects

| # | The question | Lane |
|---|---|---|
| D7 | A colleague names a day, it's full → zero slots, and she never offers to look wider. **The same call you already made** for the rule-violation path (*"you can suggest to wide the search"*), on the surface it didn't touch. Deferred to this batch, not undecided | meeting |
| D8 | Two deltas beyond your literal ask, already live: the soft-rule offer grew from a hard **3 to 8**, and an empty requested day now **proposes other days itself** where it used to escalate to you. Both follow from your two decisions. Restoring the escalation is one line | meeting |
| #14 | Internal vs external boundary — the workspace has guests, no code enforces the distinction anywhere. Genuinely unresolved, not declined | — |

---

## ⏳ Carried forward from earlier waves

**people lane** — from the v4.1.0 person-store verify. None can fire on today's data.
1. `src/db/people.ts` (~962) — the md merge sits **outside** the row transaction; process death between the row commit and the md fold orphans a file the sweep never revisits. **The only non-self-healing residue — first.**
2. `v4_0_4` migration (66-78) — a `refused` group re-dumps a backup JSON every boot.
3. `src/memory/peopleMemory.ts` (~184) — mixed legacy-filename case can orphan a legacy file permanently.
4. `src/db/people.ts` (~911) — `gender_confirmed` set outside the provenance pick. One row today, inert.
5. `src/memory/peopleMemory.ts` (129-146) — merge-time formatting loss. Hand-edited files only.

**from the charter audit** — rules stand, timing does not.
- **#41** a second work-item lifecycle rides alongside `requests` (requests + outer)
- **#44** the approval midpoint nag has no work-hours clamp — a Thursday approval can ping on a Saturday
- **#48** the abort-for-merge path drops the first message's text
- **#56** the DB bootstrap runs two `ALTER`s before the `CREATE` that should define those columns, and two competing migration mechanisms. Nothing breaks today; wants care, not speed

---

## ✔️ Closed as correct — do not re-litigate

#13 channel continuation · #46 the 20-message window (charter amended instead) · #47 DM queue coalescing · #50 meaning-classifiers in the transport · #5 · #21 · #24 · #52 · F1 barber vs opaque block · F2 stale coda topic · **rule 1 (`vacation_or_off_day`) having no relaxed gate** — its current behaviour is what the owner asked for.

## 📌 Known and accepted

`toolCallCache.ts:35` holds a second `WRITE_TOOLS` with different membership, driving cache TTL — merging it changes TTLs · threads predating deploy carry `[<tool> OK]` with no `mutated=` marker for one thread-lifetime; self-heals · `src/utils/weekdayGuard.ts` and `src/skills/outreach.ts` were never audited because nobody owned them (assigned 2026-07-26 to guard and requests — expect drift).

## 🕳 Blind spots the audit structurally cannot see

Coverage is bounded by the charters, not the code. **`news` · `summary` · `venue` · `knowledge` · `search` · `brief` have no behavioural rules at all** — `outer` is in PROPOSE mode there. `src/llm/` is owner-only and unaudited. Roughly **38 of 60** `src/utils/` files are named in no charter.

## 📌 Standing notes for the next run

- **Where these 30 came from.** Not the 68 — those were the charter audit, ~40 built and shipped in `34ee3e7`. These are **new, found 2026-07-26** by four verify passes on the scheduling core (~18) and one scoped audit of the reply path (~12). Most are **pre-existing**, not from any recent wave: the reply-path items live in 4.1.0 code that had never been examined. Two subsystems at this depth yielded 30 items — assume similar density elsewhere.
- **The scheduling core and the reply path have almost no runtime evidence.** Only the gap-probe fix had real log tape. Everything else is derived from reading. The next log review is the first real test — weight it accordingly.
- **`state.json` carries `verifiedClean`** — 10 things today's passes proved, passed back as `priorClean` so a verify skips them. **Drop any entry a wave invalidates**; a stale "proven clean" silences a real check.
- **Cron** job `638d42b0` armed daily at 18:00; session-only, **auto-expires 2026-08-01** → re-run `/manager watch` before then.
- **Backticks in `bugger.js` prompts must be escaped** — an unescaped one surfaces misleadingly as `Workflow "bugger" not found`. Syntax-check with the runtime's async wrapper before shipping a prompt edit.
