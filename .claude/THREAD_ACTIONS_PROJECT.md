# Thread actions — Maelle acts on an @mention in a thread

> Status: SPEC (design complete, not built). Authored by the feature/design chat.
> GitHub #14. **Build in the SAME chat as the news brief** (owner's call — both
> are modest next to WhatsApp). Spec shape mirrors the other PROJECT files.

---

## 1. Problem

Maelle lives in DMs today. The owner wants to **pull her into a thread**
(channel or MPIM) by @mentioning her, and have her **take an action** — like a
real EA you loop in. She must **read the entire thread first** and treat it as
the input/context, then do one of three things based on what the mention asks:

1. **Book a meeting** with the people in the thread.
2. **Follow up** on a commitment surfaced in the thread.
3. **Other** — answer the question / do the task and post the result in-thread
   (e.g. "Maelle, do a news summary and publish it here").

The inbound plumbing already exists: `app_mention` + a `message` handler that
accepts `channel_type==='channel'` and MPIM (`connectors/slack/app.ts:1406+`),
plus `assistant_thread_started`. So this is a **routing + intent + action layer**,
not a new transport.

### Why it was flagged HIGH-risk (design accordingly)
It combines every historical bug axis: thread/channel **routing**, **autonomy**
(she acts + chases people), **colleague-facing outbound**, and **LLM intent
extraction**. The owner-presence gate (below) is what bounds the trust surface;
reuse (coord, spine, outreach, social, news, person store) is what keeps it from
being a big new build.

---

## 2. Owner decisions (locked — build to these)

1. **Invocation = owner OR colleague, gated on OWNER PRESENCE.** A mention triggers
   an action **only if the owner is an active participant in that thread** (he's
   there and has spoken, and it concerns him). If the owner is NOT in the thread,
   Maelle does nothing — "she's my own EA." The owner's presence IS the
   authorization. (So Daniel can @mention her to book/follow-up *in a thread Idan
   is in*; Daniel mentioning her in a thread without Idan → ignored.)
2. **The "always-check calendars" people = a `is_vip` flag on the person row.**
   Set conversationally when the owner describes people ("Yael is a VIP" / "always
   consider Brett's calendar"). Stored in the person store, **reused as the seed
   for the real VIP feature (#58)**. VIP calendars are always pulled into the
   free/busy search; non-VIPs are **invite-only** (invited politely, their
   conflicts annotated, not gating).
3. **Booking = one annotated proposal in-thread, book on agreement.** Optimize the
   time for owner + VIPs, propose ONE best time, **annotate** any invite-only
   conflict in human terms ("1pm — Alex can't, can you make it work?"), and
   **re-search only if someone pushes back** — never start from "find a totally
   new day" (that lands a month out). Book directly once the thread agrees.
4. **Follow-up = chase the committer, verify by asking, nudge the owner if it
   slips — and do it WARMLY.** Create a request on the spine, DM the person who
   owns the commitment, get a done-by, check back at that time by **asking them**
   (no HubSpot/external integration in v1), ping the owner if it goes quiet. The
   DM must be **human and warm**, not a bot ticket: *"Hi Alex, how's it going?
   Any luck wrapping the doc for Idan from yesterday?"* — never "Alex → follow up
   on thread." (Owner sees this as a feature: more, warmer interaction points →
   Maelle becomes part of the team, not just the meeting-booker.)

---

## 3. Design

### 3.0 Channel behavior — STRICT BLINDNESS (the safety rule — read first)

The owner has Maelle in some channels but has never used it and does not want her
silently reading/storing channel data. **She is blind to a channel except where
she is @mentioned.** Three cases, exhaustively:

| Situation | Behavior |
|---|---|
| In a channel, **not mentioned** (top-level OR any thread, start or middle) | **Fully blind.** She does not read, classify, relevance-check, capture, or store the message. Nothing runs. |
| **@mentioned at the START of a thread** (she then engages) | She's part of that conversation, **like an MPIM** — continuation replies in that thread flow to her (existing behavior). |
| **@mentioned in the MIDDLE of a thread** she wasn't part of | **This feature.** She reads the thread **as ephemeral input for the one action**, acts, and does **not** hoard it (see below). |

**Current code already enforces the blindness foundation** (v2.6.2,
`app.ts:1483-1534`): a real-channel top-level message is dropped (`return` at
:1516 — "Maelle isn't passively reading channels"), and a thread reply where she
never spoke is dropped (:1521-1526) — **both BEFORE any relevance check, capture
pass, orchestrator call, or storage.** The build must **preserve** this and must
**not** widen the `message`-event handler to process un-mentioned channel content.
The only new entry is the **app_mention** path for a mid-thread mention.

**Ephemeral-read discipline (the strict part the owner asked for):** reading a
thread to perform a mid-thread-mention action is **read-only, in-memory, for that
turn**. It must trigger:
- **NO** capture pass / `runSubjectReconciliation` over the thread or its people.
  (Today that pass is a background sweep over **1:1 colleague DM threads**
  (`background.ts` → `runCapturePass`); it must stay that way — confirm a
  channel/MPIM thread is never enrolled into it.)
- **NO** people_memory / social-subject / interaction-log writes about the
  thread's participants merely from reading.
- **NO** persistence of the thread text beyond the transient turn context.

The **only** things that persist from a thread action are the **deliberate
outputs**: a booking's attendees (the existing owner-initiated `recordBooking`
path), a follow-up `requests` row the owner asked for, or an explicit owner
"remember this." If the owner only asks a one-off question (Path 3) and nothing
is booked/tracked, **nothing is stored.**

### 3.1 Trigger + the owner-presence gate (build this FIRST — it's the trust control)

On an @mention in a thread (channel or MPIM):
1. Fetch the **full thread** (`conversations.replies`, already used at
   `app.ts:393`).
2. **Owner-presence gate:** is the owner (`profile.user.slack_user_id`) an active
   participant — i.e. has he POSTED in this thread? If **no → do not act**
   (silent, or a one-line "I help in threads Idan's part of" only if directly
   addressed). If **yes → proceed.** This single check gates everything.
3. Determine the **invoker role** (owner vs colleague) via the existing
   `getSenderRole`. Both are allowed *past the gate*; authority still derives from
   the owner being present (owner-in-group authority, which the orchestrator
   already models via `isOwnerInGroup`, `index.ts:379`).

### 3.2 Read-the-thread-as-input (always)

The whole thread is assembled into the turn context (messages + who said them),
and the participants are resolved to people: each Slack user who **spoke or was
@mentioned** → `resolvePerson({slackId})` → person row (name, email, `is_vip`).
This roster is the raw material for all three paths.

### 3.3 Intent classification (which of the 3)

A small classifier (the mention text is the primary signal; the thread is
context): **book / follow_up / other.** The owner usually says it plainly ("book
us a meeting" / "follow up on this" / "summarize the news here"). Ambiguous →
Maelle asks one clarifying question in-thread rather than guessing. Reuse the
existing turn-classification pattern (`classifyTurn`); don't invent a parallel
engine.

### 3.4 Path 1 — Book a meeting

- **Attendees** = the resolved thread roster (speakers + mentioned), minus bots /
  Maelle / the owner-as-organizer-handled-separately.
- **Free/busy search:** include the **owner + every VIP** roster member's email in
  the `getFreeBusy`/`getSchedule` query (`calendar.ts:446` — confirmed: Graph
  `getSchedule` returns busy/free for any org mailbox). Non-VIPs are **not** gated
  on availability.
- **Proposal:** pick the best time for owner + VIPs (within the owner's rules,
  reusing `findAvailableSlots` + the rule engine). If a non-VIP is busy at that
  time, **annotate** rather than discard: post ONE proposal in-thread —
  *"Tuesday 1pm works for everyone except Alex — Alex, can you make it work?"*
- **Negotiation:** while the proposal is open, replies in that thread route to
  Maelle (coord-in-thread, same as MPIM coord). If the non-VIP confirms → book.
  If they say no → **then** re-search nearby (same week / ±days), not a fresh
  far-future sweep. Reuse the coord state machine (`initiateCoordination`,
  `skills/meetings/coord/state.ts`) with a thread-as-channel binding (the thread
  id is the coord's `origin_channel`/`thread_ts`).
- **Book** on agreement (owner present → owner authority, inside the owner's
  rules), confirm in-thread, record attendees (person store), shadow the owner.
- **Privacy:** annotations are **free/busy level only** — "Alex can't make 1pm,"
  never "Alex has a dentist appointment." (Existing rule; enforce it here too.)

### 3.5 Path 2 — Follow up

- Extract the commitment(s) from the thread (LLM, small rubric): *who owes what by
  when*. The owner saying "this is important / follow up on this" is the trigger.
- Create a **`requests` row** (kind=`follow_up`, the spine) per commitment, with
  the committer as `target_slack_id`, a `next_check_at` from the stated deadline
  or the owner's cue ("couple days"), and the thread as origin for the close-loop.
- **Warm outreach (the voice matters):** DM the committer through the outreach
  path, composed in Maelle's **social/warm voice** using the person's
  `people_memory` context — greeting + light rapport + the ask. This reuses the
  social engine's warm-opener voice; the *enforcement* (timing, re-nudge,
  close-loop) is the spine/outreach machinery. **Never a robotic ticket.**
- **Verify by asking** at `next_check_at`: "did it land?" Done on their word →
  close the request + shadow the owner. Quiet → re-nudge once, then surface to the
  owner. (No external-system verification in v1; "upload to HubSpot" is verified
  by asking the person, not by reading HubSpot.)
- This is also the social win the owner called out: more, warmer touchpoints.

### 3.6 Path 3 — Other

- Read the whole thread as input, do the asked task, **post the result back into
  the thread** (`postToChannel(threadChannel, text, {threadTs})` — the
  brief-in-thread / coord-thread pattern already does this).
- "Do a news summary and publish here" → call the **news skill's `gatherNews`**
  (the parallel build) scoped to the thread's topic, write grounded + cited, post
  in-thread. Other one-offs (answer a question, draft something) → normal tool use,
  output to the thread.

### 3.7 Thread attention lifecycle (bound the autonomy)

- Maelle acts **on the mention turn**, then works **async via the spine / DMs**.
- She **watches a thread only while an action is actively open in it** (a Path-1
  negotiation awaiting replies). Replies in that thread route to her during that
  window (coord-in-thread). Once booked/closed, she stops.
- She does **NOT** passively monitor threads/channels for digests or unmentioned
  activity (explicitly out of scope; the owner's earlier "no passive channel
  listening" rule). Re-engagement requires a new @mention.

---

## 4. Layer placement

- **Code (determinism):** owner-presence gate, participant→person resolution, VIP
  free/busy inclusion, the "annotate non-VIP conflict, re-search only on pushback"
  booking logic, request/timer creation, thread-as-coord-channel binding,
  attention-window lifecycle.
- **Prompt (judgment):** intent classification rubric, commitment extraction, the
  **warm follow-up voice**, in-thread phrasing/tone. No enforcement in prompt.
- **Learned memory / person store (taste + identity):** the `is_vip` flag;
  people_memory context that warms the follow-up DM.
- **Connection:** none new — Slack channel/thread posting already exists.

## 5. Invariants (must hold)

1. **No owner in the thread → no action.** The presence gate is absolute; a
   colleague can never make Maelle act in a thread the owner isn't part of.
2. **Non-VIP availability never blocks a booking** — it's annotated, and only a
   non-VIP's explicit pushback triggers a (nearby) re-search.
3. **Free/busy level only in any public thread** — never event detail of any
   person.
4. **Follow-up outreach is warm + human**, person-aware, never a bot ticket.
5. **No passive monitoring** — she engages only on @mention, watches a thread only
   while an action is open, stops when it closes.
8. **Channel blindness is absolute** — she never reads/classifies/stores any
   channel message she was not @mentioned in (the existing `app.ts:1483-1534`
   drops must be preserved; the handler must not widen).
9. **Reading is ephemeral** — a mid-thread-mention thread read triggers NO capture
   pass, NO people_memory/social-subject/interaction writes, NO text persistence.
   Only deliberate action outputs (booked attendees, an owner-requested follow-up,
   an explicit "remember this") persist. A Path-3 one-off that books/tracks
   nothing stores nothing.
6. **Reuse, don't invent** — coord for booking, spine+outreach for follow-up, news
   skill for case 3, person store for identity + VIP. Net-new code is the gate,
   the classifier, the VIP flag, and the annotate-don't-resweep booking tweak.
7. **Multi-tenant** — gate keys off the profile's owner id; VIP is per-person; no
   hardcoded names.

## 6. Code touch-points (file:line — verified)

- `src/connectors/slack/app.ts:393,1406+,1496` — thread fetch +
  channel/MPIM/app_mention handling exist; add the owner-presence gate + route a
  gated thread mention into the new thread-action flow.
- `src/db/people.ts` + `src/db/client.ts:784-area` — add `is_vip` (boolean) to
  `people_memory`; read in the booking free/busy assembly. Set via an existing
  person-write tool (e.g. extend `update_person_profile`, `core/assistant.ts`).
- `src/connectors/graph/calendar.ts:395,446` — `getFreeBusy`/`getSchedule` over
  the owner + VIP emails (confirmed feasible for org mailboxes).
- `src/skills/meetings/coord/state.ts` (`initiateCoordination`) — bind a coord to
  a thread (`origin_channel`/`thread_ts` = the thread) for Path-1 in-thread
  negotiation; reuse the MPIM-coord reply routing.
- `src/core/requests/*` (spine) + `src/skills/outreach.ts` — Path-2 follow-up
  request + warm DM + check-back timer (`sweepDueRequests`).
- `src/skills/news.ts` (parallel build) — Path-3 news-in-thread via `gatherNews`.
- `src/core/orchestrator/index.ts:379` — `isOwnerInGroup`/MPIM authority already
  models owner-present-in-group; feed thread context through it.
- Intent classification — reuse `classifyTurn` (orchestrator), add a thread-action
  branch; don't build a separate engine.

## 7. Build phases (ship + verify each)

1. **Trigger + owner-presence gate + thread read + intent classify.** Mention in a
   thread → gate on owner presence → read thread → classify book/follow_up/other.
   No actions yet beyond a stub reply. *Verify: colleague mention with owner absent
   = no action; with owner present = classified correctly.*
2. **VIP flag.** `is_vip` on the person row + set-via-chat + read path. *Verify:
   "Yael is a VIP" persists; flag readable.*
3. **Path 1 — book.** Roster→attendees, owner+VIP free/busy, one annotated
   proposal in-thread, in-thread negotiation, annotate-don't-resweep, book on
   agreement. *Verify: §8 S1/S2.*
4. **Path 2 — warm follow-up.** Commitment extraction → spine request + warm DM →
   check-back-by-asking → nudge owner if quiet. *Verify: S3 — the DM reads human;
   the check-back fires; quiet → owner is told.*
5. **Path 3 — other / news-in-thread.** Read thread, do task, post in-thread;
   wire the news skill for "summarize news here." *Verify: S4.*

## 8. Messy-scenario paper-trace (failure modes named)

**S1 — Colleague books in the owner's thread (happy path).** Idan + Daniel + 3
others in a thread; Idan has posted. Daniel: "@Maelle find us 45 min next week."
Gate passes (owner present). Roster resolved; owner + the 2 VIPs' calendars
checked; Maelle posts "Tue 1pm works for everyone except Alex (invite-only) —
Alex, can you do 1pm?" Alex 👍 → booked, confirmed in-thread, owner shadowed. ✅

**S2 — Owner absent (the trust failure mode).** Daniel @mentions Maelle in a
thread Idan isn't in. Gate fails → Maelle does nothing (she's Idan's EA). **If
mis-built** (treating any channel mention as actionable) a stranger/colleague
could drive Idan's calendar from a thread he's not in — the presence gate is the
control. ✅

**S3 — Warm follow-up.** Thread: "we need the security doc to the client by
Thu." Idan: "@Maelle this is important, follow up." Maelle creates a follow_up
request on Alex, DMs warmly Wed afternoon ("Hi Alex — how's it going? Any luck on
the client security doc for Idan, due tomorrow?"), logs his "yes by EOD." Thu she
asks "did it go out?"; on confirm → closes + shadows Idan; on silence → one warm
re-nudge, then tells Idan. **Failure mode:** a robotic "FOLLOW-UP: doc, due Thu"
DM (gets Maelle hated) — the warm-voice invariant prevents it. ✅

**S4 — News in a thread.** Channel thread debating a competitor; Idan present.
"@Maelle summarize the latest on Acme here." Reads thread for context, calls the
news skill's `gatherNews` scoped to Acme, posts a grounded, cited 4-bullet
summary in the thread. ✅

**S5 — Ambiguous / not-for-her.** "@Maelle 😂" or an unclear ask → one clarifying
question in-thread, no autonomous action. Bots/notetakers in the roster are
filtered (existing non-human filter). ✅

**S6 — Privacy in public.** Annotating a VIP conflict in a channel: "Maya can't
make 2pm" (free/busy only) — never "Maya is at a doctor's appointment." ✅

## 9. Open decisions for the build chat

1. **"Active participant" definition** — owner must have *posted* in the thread
   (recommended) vs merely be a channel member. Lean: posted.
2. **`is_vip` set-tool** — extend `update_person_profile` with a `vip` field vs a
   tiny dedicated verb. Lean: extend the existing tool.
3. **Colleague-invoked booking authority** — since the owner is present, treat as
   owner-authority (book inside rules) vs still shadow-confirm with the owner for
   colleague-initiated ones. Lean: owner-present = owner authority, shadow after.
4. **Commitment extraction granularity** — one follow-up per explicit commitment;
   ask the owner if several are ambiguous.

## 10. Verification fixture

- **Gate:** colleague mention, owner not in thread → no action; owner in thread →
  acts. (Invariant 1, S2.)
- **VIP:** set a person VIP in chat → flag persists → their calendar is included
  in a thread-booking free/busy search; a non-VIP's busy time does NOT block the
  proposal (it's annotated). (S1.)
- **Book:** thread booking posts ONE annotated proposal, books on agreement,
  re-searches only on explicit pushback (not from scratch).
- **Follow-up:** the DM reads human (manual eyeball + the warm-voice rule); the
  check-back timer fires; silence escalates to the owner. (S3.)
- **News-in-thread:** grounded, cited summary posted in the thread. (S4.)
- **No passive monitoring:** an un-mentioned message in a watched thread after
  close gets no reply. (Invariant 5.)
- **CHANNEL BLINDNESS — test in depth before this feature is "done" (owner's
  explicit requirement; he won't add Maelle to channels until this is proven):**
  In a real test channel, with logging on, confirm —
  1. **Top-level channel messages → zero processing.** No log line past the
     `app.ts:1516` drop, no orchestrator call, no DB write.
  2. **Thread replies in a thread she was never mentioned in → zero processing**
     (dropped at `:1521-1526`).
  3. **Mid-thread mention → she reads + acts, but stores NOTHING beyond the
     deliberate output.** After a Path-3 one-off ("summarize X here"), assert: no
     new `people_memory` rows/edits for thread participants, no new social
     subjects, no interaction-log writes, no thread text persisted — diff the DB
     before/after.
  4. **The capture-pass background sweep never enrolls a channel/MPIM thread**
     (`background.ts` / `runCapturePass` stays 1:1-DM-only) — verify with a
     populated test channel across a sweep tick.
  5. **Begin-of-thread mention behaves like MPIM** (engages + continuation) and is
     unchanged.
  Provide the before/after DB diffs as the acceptance evidence.
- **Typecheck:** `npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json`.
