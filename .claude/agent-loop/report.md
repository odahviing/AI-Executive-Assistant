# Agent-loop report

Runs `wf_6852af85-afc` + `wf_27f03aca-0dd` + `wf_0cebe938-c81` + three hand dispatches + one verify, cumulative since the 4.3.3 wrap.

**The verify overturned 3 of 7. 3 rows await you** · 4 built and clean · 2 declined · 1 closed as correct. Ledger open total: **52** (39 confirmed, 0 needing a re-read) — `node scripts/ledger-stats.cjs --open`. **Do not wrap yet** — three of the ten changed files carry work the verify would not sign off.

> `3 of 7 row(s) are NOT built — gh#166 (needs-owner-decision), gh#158-availability-owner-not-attendee (needs-owner-decision), precheck-claims-booking-parity (needs-owner-decision).`

## Pending owner (3)

| # · Lane · Status | The chat problem | The issue | The solution | Risk |
|---|---|---|---|---|
| gh#158-availability-owner-not-attendee · matchmaker · pending — **recommend narrow the trigger, then ship** | *"does Levana free tomorrow at 10am?"* → answered with **your** hours, then *"Yes, 11am is free for her too."* | The pre-check only asks *is the owner free*, and its hard-block ledger then kept asserting that for 45 minutes. | Built: bail at `availabilityPreCheck.ts:495` + the forgetter at `:513-537`. | **Your no-booking condition HOLDS — the verify re-derived it rather than accepting my summary.** The overturn is about **scope**: the trigger is wider than the symptom. `resolvedMeetingAttendees` unions the *email transport's* forwarded-header addresses, so on a colleague-role email turn any non-owner recipient bails the pre-check entirely — a signal meaning *who's on the thread*, not *whose availability was asked*. Worse, a plain group booking loses it: *"is 10am tomorrow with Idan?"* arms NOT BOOKABLE, then *"can Yael join at 10am?"* bails **and deletes the 10:00 block your own `checkSlot` established** — so the natural reply becomes *"yes, 10am works."* That's gh#165's shape two messages deep. **Ask:** bail on *asks about a third party's availability*, not on *names one*; and scope the forget rather than deleting. |
| gh#166 · outrider · pending — **recommend gate on `force`, then ship** | Your brief arrived with no news; the gather had succeeded and been binned. | 8s outer wait against a 12s inner budget. | Built: `briefs.ts:31`, 8_000 → 20_000. | **This contradicts a ruling you made hours earlier.** `sendMorningBriefing` is also called *synchronously* with `force=true` from `processMessage.ts:517` and `skill.ts:598` when you ask for the brief in Slack, and the constant never consults `force` — so an on-demand brief now blocks **20s with no reply, up from 8s**. In this same wave you declined a fix with *"i don't want more latency."* I named this exposure when the fix landed and didn't treat it as blocking; the verify is right that I should have. **The lever is in scope and unbuilt:** `force` is already available at `briefs.ts:631`. |
| gh#164 + `precheck-claims-booking-parity` · matchmaker → instructor · pending — **recommend keep the caveat, drop the duplicated rule** | Maelle offered Michal a *"squeeze into 16:15"*, refused once he accepted, and it was booked at 16:15 anyway. | The pre-check told the model, unconditionally, that its answer matches what booking does. It doesn't. | Built: three string/comment edits, zero logic change. | **The caveat half is confirmed right** — `checkSlot` really is the one validator, and the old parity claim was a promise the code doesn't keep. Three problems with the rest: one added sentence is a **third copy** of a rule already at `systemPrompt.ts:707-708` and `meetings.ts:1375`, sitting in a `utils/` file nobody editing prompt honesty will open — **+~900 chars on every colleague turn, a third of it duplicate**. The two behavioural instructions are **instructor's**, not matchmaker's. And **it doesn't reach gh#164**: that ticket is *"the offer was ok, the second pushback was not"*, there was no booking attempt when she pushed back, so the sequence isn't prevented — the new sentence arguably sanctions it. |

**The one shape question, and it's the real decision.** The hard-block ledger gains a **fifth invalidation class, and it's the first not grounded in calendar evidence** — a regex reading of message text can now disarm a verdict `checkSlot` established. You asked for the forget, so it's probably intended; but you asked for *"don't let the floor assert an owner fact about a third party"*, and what shipped is broader. New authority over a guard spine is hard to reverse once other code assumes it. Ruling on this settles the gh#158 row too.

## Built and clean (4)

| # · Lane · Status | The chat problem | The solution | Risk |
|---|---|---|---|
| gh#167 · outrider · built | You had to ask why there was no news; the log read `gather done · sources: 55`. | Three-way branch — WARN on timeout, INFO on a genuine quiet day. Log-only. | None. The quiet-day branch leaves `newsBundle` unset exactly as before. |
| gh#165-b · matchmaker · built (rebuilt) | Ayala asked to be added to the meeting just booked for her; Maelle re-ran `create_meeting` under an invented subject, collided with her own booking, raised a second approval. | `checkSlot` stamps `overCommitment.id` with the event its own scan blamed; `createMeeting` reads it off the rule-check it already made — zero extra Graph calls. `subject:null` mode deleted. | None blocking. Two lane asks: the whole `calendarReads.ts` change is 9 lines of comment describing a mode that **never shipped in any commit** — keep the constraint, drop the archaeology; and the event id is delivered twice, the in-prose `(id: …)` copy being one a model can echo to a colleague as a raw Graph id. |
| category-classifier-blind-to-location · matchmaker · built | Onsite meeting booked as *Meeting*; you fixed it by hand. | Classifier now sees the location argument. Threaded correctly, passed verbatim, never parsed. | **My claim "renders byte-identically" was false** — `detectCategory.ts:107` emits a blank line when there's no location. Harmless, matches the existing `input.body` pattern, but the absolute was wrong. |
| 152-refresh-stale-cache · matchmaker · built | *"check again"* didn't get a fresh read. | Last cached decision read → `getOwnerEventsForDecision`. | None. Composes cleanly with the bail — `eventsForWeek` is reachable only after it returns, and a blind pre-check still asserts nothing. |

## Declined (2)

| # · Lane · Status | The chat problem | The issue | The solution | Risk |
|---|---|---|---|---|
| gh#165-a · matchmaker · declined — **different design** | Ayala asked for *"15 mins with idan, scott and Chris"* and was left off the invite. | The requester exclusion is unconditional. | **None, deliberately.** | *"it should be LLM rule and not our coding… don't try to force it."* Your idea instead: **when someone keeps asking to be added, record it in their person memory.** New capability — profiler + instructor, feature engine, not this loop. |
| gh#156-get-back-to-you (+ `>dep`) · shepherd → gatekeeper · declined — **latency** | *"let me do that now… and get back to you"* — then nothing. | `systemPrompt.ts:722-723` says a promise needs a tool call; nothing checked it. | Built, then **reverted**. | *"i don't want more latency. maybe we will do a project about it in the future."* Second time this class was refused on latency. Not re-proposable as an output gate. |

A third row was declined and removed from this table at your request — `gh#156-unprompted-inperson-online-question`, *"no need to fix."* The ledger keeps it.

## Closed as correct (1)

| # · Lane · Status | The chat problem | The issue | The solution | Risk |
|---|---|---|---|---|
| gh#156-b · gatekeeper · already-fixed | *"Yep, both work for Yael too"* with no calendar read behind it. | The claim was unbacked because **the read never happened** — not because a gate missed it. | **None owed.** Root fixed by 4.3.2 (`1bc4fcb`), which is deployed. | Your three-step ran to its end. **#156 complaint 2 is closable.** Residuals recorded, not dispatched: the **email leg** has no coverage for this class and is the highest-harm surface, but zero evidence of it firing; and if a gate is ever wanted, **extend `action` mode** — which caught this very draft in production — don't add a third. |

## Lane asks — not blocking the wrap (3, all matchmaker)

- **`calendarReads.ts` comment is archaeology** — describes a `subject: null` mode that exists in no committed revision. Keep one sentence of the constraint, drop the history.
- **`availabilityGate.ts:328-333` says "two callers"; there are three**, and the new one isn't a better-knowledge case. `:240-262`'s *"genuinely narrow and one-directional"* now under-counts, in the very file the wave's safety argument rests on. **This also corrects a row I wrote**: `hardblock-ledger-has-no-refuter` claimed one writer and one forgetter "grep-confirmed unique" — `runOutputGates.ts:943` has always been a third. Conclusion stands, evidence was wrong.
- **Raw event id in prose** — `(id: …)` alongside the structured `existing_event_id`. No prompt rule forbids echoing it to a colleague.

## Ticket coverage — none may close

**#166 · #167** satisfied, subject to the #166 latency row. **#164** partial — the honesty landed, the offer-then-reverse sequence did not. **#158** partial, plus new surface the ticket didn't ask for. **#165** partial, and still **contradicted** by `meetings.ts:482/495` telling the model a colleague may only add or remove *themselves* — this wave makes that contradiction **live rather than latent**. **#152** partial. **#156** not closable here. **#154 · #155 · #151 · #157 · #24 · #45 · #51** untouched, no accidental satisfaction.

**#168 "Timezone issues when booking meeting" is open, new, and untouched by all ten files** — named so nobody reads this wave's timezone-adjacent edits as coverage. Its transcript also corroborates the `attendee-calendar-never-read` correction: *"Tyler's got other things booked 9:00 and 10:45 ET"* is an attendee-calendar read surfacing in prose.

## Discoveries — next run's intake, not decisions

Nine carried in `state.pendingOverflow`, each with a ledger row. Three of the 07-30 batch share the invariant `claim-backing-must-match-the-claims-subject`; one principle broken in several places is usually a missing seam. New this pass: **#168**, and *on-demand and routine share one best-effort budget* — `NEWS_BRIEF_TIMEOUT_MS` and its siblings are module constants no on-demand path can shorten though `force` is in scope, which is the same root as the gh#166 row.

## Actions

Nothing is committed. **Ten** src files are modified (the earlier "eight" was wrong — the verify caught it). Production is 4.3.2, so a deploy is genuinely owed once this clears. `npx tsc --noEmit` is green on the whole tree as it stands, including the overturned work.

**What the verify did not cover, in its own words:** it took the pre-proven list as given, read no logs, didn't exercise the Haiku category-guess path, didn't measure real news-gather latency (the 20s is from the constant, not a timing run), and didn't audit the framework files in the tree.
