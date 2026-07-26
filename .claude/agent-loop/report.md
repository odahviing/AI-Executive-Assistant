# Agent-loop report

_Cumulative since the last wrap. Nothing here is committed until the owner says **wrap** — the agents build in the working tree and stop._

**Every row is written from the chat's point of view first** — what a person saw happen — then the bug, the fix, the agent, the risk. If a row can't be told as something that happened in a chat, it isn't ready to be a row.

**Last wrap: 2026-07-26 → `v4.2.0` (second wave, same version).** The `checkSlot` verify wave: four build rounds, five adversarial passes, 18 files, +1,637/−626. Verdict was WRAP — every destructive path traced fails closed. Full narrative in `CHANGELOG.md`; per-dispatch history in `ledger.jsonl`.

**Nothing is currently built and awaiting review.** The tables below are open work only.

---

## 🔴 Needs the owner

| # | What happened (in chat) | The bug | Why it's his call | Agent |
|---|---|---|---|---|
| D7 | Colleague asks *"what about Thursday?"*, Thursday is full → zero slots, and she never offers to look wider | A named narrow window deliberately never widens. The **opposite** gap from the one just fixed, on the surface it didn't touch | Same call he already made for the rule-violation path (*"you can suggest to wide the search"*). **Deferred to the next batch 2026-07-26** — not undecided, just not being fixed piecemeal | meeting |
| #14 | — | Internal vs external boundary: the workspace has guests, no code enforces the distinction anywhere | Genuinely unresolved, not declined. A product question | — |

---

## 🅿️ Parked — found, understood, deliberately not fixed (2026-07-26)

_Owner's call: **"we need to stop changing… if it flag we can fix them later."** None is fixed. They re-enter the queue only if they bite in production or he picks one up. Each carries enough reasoning to act on without re-deriving it._

| What would happen | Where | Why parked |
|---|---|---|
| A counter that changed only subject or duration leaves a still-valid clash **unnamed** on a surface where ✅ books | `resolver.ts:1043` `notifyOwnerOfColleaguePushback` — a **third** owner decision surface, never named in any brief | All three message parts genuinely differ from the other two surfaces, and the reject branch must carry no consequence. Needs his judgment: re-name a clash on a counter he has already seen once? |
| The pending-approvals list ships the **whole payload** — rule label with a private subject, attendee emails, the hard reason | `skill.ts:1343` | Owner-only today, blocked for colleagues at two chokepoints (verified). But nothing in that tool needs more than id/kind/subject/dates — it is one allowlist edit from a leak |
| **A colleague-path `move_meeting` can still set `relaxed` raw** — so the invariant *"`allowRelaxed` implies the owner"* is documentation-true, not code-true | `moveMeeting.ts:1094`, the one exception in a 7-site enumeration | Neutralised today by the strict pre-gate above it: relaxed can only apply to a window that already passed every rule strictly, and **nothing branches on the invariant**. Unchanged by this wave. Fix is one conjunct: `&& context.senderRole === 'owner'` |
| **The "calendar is offline" refusal never appears for a real network outage** | Graph's SDK sets `statusCode: -1` and copies only `.stack`, erasing the `cause` chain — so the transport-errno set is unreachable | Every path **fails closed**; nothing books. One is strictly better than baseline, where a failed read returned `[]` and the move proceeded on a falsely-clean verdict. Settled by one real 5xx in the logs |
| A 429 or rolling-restart 503 reads as "offline" more often than needed | the retry has no backoff — two calls, same tick | Pessimistic, not wrong |
| An outage in `check_calendar_health` / `auto_move` surfaces a raw Graph string into model context | `calendarHealth` is not routed through the offline wrapper | Fail-closed on an autonomous move is right; only the wording is inconsistent. Owner-only surface |
| During an outage the colleague pre-check injects **nothing** — a colleague asking "is Idan free at 3?" is protected only by the model choosing to call a tool | `availabilityPreCheck.ts:385` | Safe failure (silence, not a wrong verdict). The fix is upstream of the guard lane |
| The OOO pre-check says *"do NOT say he's booked"* and its own footer then supplies exactly that sentence | `availabilityPreCheck.ts:653` vs `:663` | Wording only — the verdict is a correct no |
| `owner_out_of_office` is a reason code the prompt doesn't know, and an existing line argues against narrating it correctly | `meetings.ts:197-206` | Context-lane lag behind a code change |
| An *Optional* slot on the requested day can be offered ahead of a *Free* slot elsewhere, unannotated | `planMeeting.ts:695-701` — `asAlternative` projects to `{start,end,label}` only | Pre-existing; the anchor change raised its likelihood. Belongs with whoever next touches the M3 annotation plumbing, as one change |
| A **relaxed** search on an OOO day now returns zero slots where it previously surfaced them | the day-level gate sits above the walk and isn't gated on `relaxed` | Reads as his stated intent (*"it should be blocked anyway"*). Direct `create_meeting(relaxed)` still books. A delta, not a defect |
| The soft-block hint can name an already-passed time as "excluded by day-load protections" | `in_the_past → within_lead_time` at `findAvailableSlots.ts:667`; nothing clamps `search_from` to now | The mapping is pre-existing; only the sharper claim around it is new |
| Two full 8-slot offers evict the 4 oldest from the 12-slot stash, where `6+6` used to fit | `MAX_OFFERED = 12` vs `offered_slot_count = 8` | Worst case is a re-derive on a pick from the first batch — not a wrong booking, still better than before |
| Two copies of the all-day-OOF predicate that agree exactly today | `scheduleRules.ts:409`, inline at `analysis.ts:367` | Drift risk only |
| `getFreeBusy` reads three **malformed-request** faults as "nobody is busy" | `calendarReads.ts:406-410`, `:412-417`, `:503-508` | Not outages. Converting them would recreate the #137 mis-escalation in reverse |
| `get_calendar` during an outage reaches the model as a raw error string and it improvises | `handleGetCalendar` | The one meeting surface the offline work deliberately did not cover |
| `analysis.ts:346` — the day-off push path doesn't carry `outOfOfficeAllDay` | meeting's file | Not live: the renderer skips day-off rows. An asymmetry a future consumer could trip on |
| **Two product deltas beyond the literal ask** — the soft-rule offer grew from a hard 3 to `offered_slot_count` (**8**); and an empty-requested-day + non-empty-widening now **proposes autonomously** where it used to escalate | `planMeeting.ts:930` | Both follow from his two decisions. Named so they aren't discovered later. Restoring the escalation is a one-line call |

**From the reply-path audit (2026-07-26).** Its two HIGHs were built and shipped; these are the rest. It also corrected a premise worth keeping: the `989→348` restructure was **4.1.0 (`6fe4251`)**, not the 4.2.0 wave — so this path had never had a scoped pass at all — and the 640 "deleted" lines were a **move** into `runOutputGates.ts`, not a loss.

| What would happen | Where | Why parked |
|---|---|---|
| **A Hebrew deliberation leak is never caught; and *"let me check with Idan and come back to you"* — the canonical correct colleague escalation — is sent to Sonnet to have "planning narration" stripped** | `runOutputGates.ts:637` `DELIBERATION_RE`, sole trigger, runs on **every** reply | Shipped 01:49 on 26 Jul → **zero fires in the logs, and that silence is not evidence**. The `rewriteDroppedAFact` veto only protects @mentions, times, dates and questions, so a commitment sentence carrying none can be deleted. G7: an English regex as the only eye. Replaying it over the ~200 replies already in the logs would size the false-positive rate today |
| A truthful *"I sent the file"* is rewritten into *"that didn't go through yet"* | `deliver_file` is a legal `ClaimActionType` but not a `MutationDomain`, so `mutated=deliver_file` can never be true. Same for `hold_slot`, `revert_last_auto_move`, `set_work_schedule_override` | Missing marker → shield off → the claim-checker **corrects a true claim**. Only backstop is its own Sonnet veto. Adjacent to open bug #144. The port itself was verified faithful, 22/22 alternations |
| A colleague sees a raw internal id: the scrubber failed to wrap it, and the fallback ships the original anyway | `securityGate.ts:474-480` fail-open, justified by "runOutputGates re-wraps" — but that second `formatForSlack` is a no-op on an unchanged string. Reachable via a real bound mismatch: detector `[A-Z0-9]{7,}` vs wrapper `[A-Z0-9]{7,10}` in `textScrubber.ts` | Any id 12+ chars is detected but never wrapped. **This is the 2026-07-01 Oran leak shape.** The gate's narrowing was verified correct — the defect is the circular rationale plus the bound |
| A leak `securityGate` scrubbed is stored **unscrubbed**, replayed to the model next turn, and fed to the coda generator | `postReply.ts:389-392` persists the pre-gate text; the colleague leg never writes back. Owner leg self-repairs | Pre-existing. The gate catches it once and memory re-emits it |
| A correct owner reply is replaced wholesale by *"Sorry — I hit a snag on this one"* during an API blip | `humanGate.ts:400-413` `safeFallback` fires on any throw when the draft contains a request id — which the owner legitimately sees | Deliberate trade, but the trigger is an outage and the failure mode is destroying a good answer. The probe amplifies it: one outage hits the branch twice |
| `runOutputGates.ts:35` still states *"Every gate FAILS OPEN"* | Two colleague-leg paths are unwrapped (`await import('../../db')` + a sync `getPersonMemory`; `runSecurityGate`) | Today's reply-path fix means a throw there reaches the person as a sentence instead of silence — but the module's stated contract is still wrong |
| *"The OpenAI meeting moved to 3"* becomes the English safe-fallback | `securityGate.ts:59` `model_leak` is `disclosure`-class and matches bare vendor names | Pre-existing on every colleague reply; the MPIM fix extends it to the owner's turns in that room. Wants a self-referential frame like its sibling `model_self_ref` |
| Owner in a **real channel** gets no `claimChecker` | `isChannel` never reaches the gate stack, so `ownerIsActing` is false there | A separate coverage gap, not the MPIM bug — that path already gets `securityGate` + the `'internal'` frame. Needs `isChannel` on `OutputGateContext` |
| A `securityGate` or `humanGate` rewrite is never re-date-verified | On the colleague leg `dateVerifier` runs **before** the two rewriters | Pre-existing. Unifying the order would change the owner-1:1 leg |
| The new reply-path failure lines are **English only** | `failureReply()` in `slack/app/helpers.ts` | Hebrew and Russian speakers hit this path too — and it **cannot** be fixed with an LLM, because on the 529 path the model is exactly what is unavailable. Needs `detectMessageLanguage` + a static table |
| A third copy of the overload string | `handlers.ts:182`, the file-ingest ladder | Different shape (boolean, different non-overload branch), so deliberately not folded into `failureReply` |
| `inboundQueue.ts:199-201`'s comment says an aborted turn's message "is still in pending" | `scheduleRun:244-245` clears `pending` when the batch starts | No information is lost (the message was already appended to history), but the comment describes a mechanism that does not exist. Comment-only |

---

## ⏳ Carried forward from earlier waves — not yet built

**people lane** — from the v4.1.0 person-store verify. None can fire on today's data.
1. `src/db/people.ts` (~962) — the md merge sits **outside** the row transaction. Process death between the row commit and the md fold orphans a file the migration sweep never revisits. **The only non-self-healing residue — first.**
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

#13 channel continuation · #46 the 20-message window (charter amended instead) · #47 DM queue coalescing · #50 meaning-classifiers in the transport · #5 · #21 · #24 · #52 · F1 barber vs opaque block · F2 stale coda topic. Plus, from this wave: **rule 1 (`vacation_or_off_day`) having no relaxed gate is correct** — its current behaviour is what the owner asked for.

## 📌 Known and accepted

`toolCallCache.ts:35` holds a second `WRITE_TOOLS` with different membership, driving cache TTL — merging it changes TTLs · threads predating deploy carry `[<tool> OK]` with no `mutated=` marker for one thread-lifetime; self-heals · `src/utils/weekdayGuard.ts` and `src/skills/outreach.ts` were never audited because nobody owned them (assigned 2026-07-26 to guard and requests — expect drift).

## 🕳 Blind spots the audit structurally cannot see

Coverage is bounded by the charters, not the code. **`news` · `summary` · `venue` · `knowledge` · `search` · `brief` have no behavioural rules at all** — `outer` is in PROPOSE mode there. `src/llm/` is owner-only and unaudited. Roughly **38 of 60** `src/utils/` files are named in no charter.

## 📌 Standing notes for the next run

- **The scheduling core has no runtime evidence.** Everything the second 4.2.0 wave changed is derived from reading code — she had handled zero scheduling turns when it shipped. The next log review is the first real test; weight it accordingly.
- **Pre-flight activity check must count real turns** — count `Orchestrator invoked` events, not raw log lines.
- **Backticks in `bugger.js` prompts must be escaped** — an unescaped one surfaces misleadingly as `Workflow "bugger" not found`.
- **Cron** job `638d42b0` armed daily at 18:00; session-only, **auto-expires 2026-08-01** → re-run `/manager watch` before then.
- **Verify discipline now lives in the Manager charter** — one pass per wave, clean list carried forward, depth scaled to risk, tool budget stated. Written against this wave's measured 44%.
