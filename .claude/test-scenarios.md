# Maelle testing scenarios

Ten standalone real-life scenarios used to pressure-test Maelle after builds. Each one is independent — running Scenario 5 does not assume Scenarios 1–4 were run. Idan decides which ones to run, when, and why.

**These are not feature-coverage tests.** Every scenario is something that can actually happen in Idan's real Slack, the way real humans actually behave. Scenarios are judged on whether Maelle holds up as a human EA in messy real moments — tone, memory, judgment, continuity, grace under pressure. If a scenario passes cleanly but would never happen in real life, it's not doing its job. Features get exercised because real people naturally use them, not because a matrix says so.

If something that matters is missing because the core doesn't support it yet, Idan adds a scenario when he builds the core. No pre-engineering.

## How to run a scenario

**This is a paper exercise. Nothing runs for real.** Running a scenario does NOT mean executing Maelle against the live system. No real DMs go out to colleagues. No calendar events get created or moved. No tasks, approvals, routines, or KB files get written to the database. No Slack messages of any kind. The scenario is a story; the "run" is Claude reading the code and walking through what Maelle WOULD do if this happened, on paper, in the chat.

If at any point running a scenario seems to require calling a live tool, sending a message, writing to the DB, or touching the real calendar — stop. That is not what this is.

When Idan says "let's test Scenario N" (or "run scenario N", or "simulate 7"), the chat that hears it should:

1. Open this file and read Scenario N in full.
2. Read the current Maelle code paths that the scenario would exercise. Do not trust memory — verify against the files on disk. This is the only allowed side effect: reading files.
3. Walk through the scenario turn by turn in the chat response. For each step, state what Maelle **should** do and what she **would** actually do given the current code. Narrate it; don't execute it.
4. Produce a report with three sections:
   - **Works** — behavior the code actually delivers.
   - **Doesn't work** — behavior the scenario expects that the current code would fail or get wrong.
   - **Shouldn't happen** — side effects, leaks, or wrong-tone behavior the code would cause that the scenario didn't ask for.
5. End with concrete fix suggestions (file + line + what to change), not vague directions.

Idan reviews the report and decides: fix now, file as a ticket, or ignore. No auto-fixing from a scenario run. No real-world actions from a scenario run, ever.

---

## Scenario 1 — The cold introduction

A person Maelle has never talked to before sends her a message: he'd like 30 minutes with Idan sometime next week. Maelle checks next week and comes back with three options, all clustered heavily on Sunday and Monday. Before sending, she notices two of them are on the same day — she trims to one per day so the three slots span Sunday, Monday, and Tuesday.

He replies that he doesn't work Sundays. Something feels off about his earlier phrasing too — the way he wrote the times made her suspect he's not in Israel. She asks him directly if he's US-based. He confirms he's on the East Coast.

Maelle quietly updates what she knows about him (US, Eastern time) and checks with Idan first: this is a cold inbound from someone unknown, is it ok to meet? Idan gives the green light. Maelle goes back to the new guy with three fresh options — this time matching both his working hours and Idan's, Monday through Thursday only. He picks one. Booked.

Since this is the first real conversation they've had, Maelle finds a natural moment to ask him something personal — turns out he follows the NBA, and that becomes their first shared topic.

---

## Scenario 2 — The flake

A colleague Idan already knows — internal, builds relationships easily — DMs Maelle on Monday afternoon: "can I get 30 min with Idan Thursday?" Maelle finds Thursday 3pm, confirms, books it.

Wednesday night at 10pm he DMs: "ugh so sorry, something came up, can we push to Friday?" Maelle isn't passive-aggressive about it. She moves the meeting to Friday morning, confirms, and tells Idan in passing that Thursday shifted.

Friday 9am — an hour before the meeting — he DMs again: "I'm so sorry, can we do next Monday instead? I've been underwater." Maelle handles it, moves again, updates Idan. She notices this is the second reschedule from him in a week but doesn't make a thing of it.

Monday 11:30 — 30 minutes before the meeting — he DMs one more time: "I'm running 20 minutes behind, can we push to noon?" Maelle updates the meeting. She tells Idan with a light touch: "Ron's moved this three times now, currently set for noon — want me to let it ride or push back?" Idan says "let it ride, but if he does it again tell him we'll find a better month." Maelle files that away quietly — next time Ron moves something, she knows what Idan wants her to do without asking again.

---

## Scenario 3 — The domino booking

Idan pings Maelle at 9:30 in the morning: book 30 minutes with a colleague today. Maelle checks both calendars and honestly tells Idan nothing lands this morning — Idan's morning is packed, and the colleague's afternoon is already past his working hours. Evening? Idan agrees.

Maelle reaches out to the colleague with three evening slots. He rejects all three and counters with Wednesday at 3pm instead. Problem: Idan already has a standing 1:1 with Maya on Wednesday at 3pm. Maelle goes back to Idan and lays it out — the colleague wants Wednesday 3pm, Maya is there. Want me to move Maya? Idan approves.

Maelle locks in Wednesday 3pm for the new colleague and kicks off a separate back-and-forth with Maya to shift this week's 1:1 fifteen minutes earlier. Maya agrees, Maelle updates it.

A day later, Maelle notices she hasn't had a non-work moment with Idan in a while. Their strongest recurring topic is gaming — next time he messages her, she weaves in a light follow-up on something he mentioned last week, doesn't force it into the task exchange.

---

## Scenario 4 — The clean sweep

Around noon Idan asks Maelle what's on his plate. She comes back with four open items: he's waiting on Liat for the Q3 deck, he hasn't confirmed Friday's offsite attendance, there's a vendor contract from David sitting on his approval, and Yoni hasn't replied to two previous pings.

Idan says: close all four, right now, in this thread.

Maelle sends four messages out in parallel, each in the right tone for the relationship. Replies come back staggered:
- Liat sends the deck link in 3 minutes. Maelle confirms receipt to Idan inline, closes it.
- David says "yes sign it." Maelle closes the approval, confirms to Idan.
- The offsite organizer acknowledges Idan's attendance.
- Yoni replies not with a yes/no but with "hey can we jump on a quick call instead? it's complicated." Maelle doesn't auto-agree. She pushes back gently: what's the call about? If it's about the thing Idan already asked about, a written answer keeps it moving. If it's something bigger, she'll bring it to Idan.

At end of day Maelle confirms: three done, Yoni pushed back on the format and she's holding the line — Idan can weigh in if he wants to cave.

---

## Scenario 5 — Three meetings on top of each other

Morning calendar check. Maelle finds Tuesday 2pm–3pm is triple-booked: a weekly 1:1 with Tomer, a sales call with ACME (four people, one of them external), and Idan's lunch block is sliding into the edge of it too.

Maelle doesn't ask Idan what to do — she works it out. The ACME call has an outsider and a full room, that one stays put. The Tomer 1:1 is internal and small, that's the one that moves — and only this week's instance, his weekly slot next week is untouched. Lunch is flexible within its window, so she slides it fifteen minutes later and it still fits. She opens a quiet back-and-forth with Tomer to find a replacement slot this same week.

Tomer counters with Wednesday morning. It works for everyone — Maelle locks it in and drops Idan a short note: "moved lunch, rescheduled this week's Tomer to Wed 10am, ACME untouched."

Ten minutes later Idan writes back: "actually keep Tomer where he was, I'll dial into ACME from my car." Maelle doesn't argue. She unwinds: undoes the Wednesday booking with Tomer, puts this week's Tomer back in its original Tuesday slot, slides lunch back. Lets Tomer know it's back on with a light apology — no blame on Idan. Short note to Idan confirming the reversal.

---

## Scenario 6 — Interview notes that age well

Idan uploads a recording of a candidate interview to Maelle. She transcribes it and drafts a summary. Idan reads the draft and tells her to lose the formal phrasing — no more "aligned on" or "circled back." She redrafts. He reads again and asks her to add the specific thing the candidate said about a technical architecture question. She redrafts once more.

On the third pass Idan approves. Maelle shares it with him and the internal panelist who was in the room — never the candidate.

She sets a reminder for three days out to check in with the panelist about the architecture answer specifically.

Three days later the reminder fires. Maelle doesn't send a generic nudge. She references the specific technical topic from the interview notes and sends the panelist a warm, concrete ping: Idan wants your read on that Axos answer before Friday — still up for a quick call?

---

## Scenario 7 — The morning briefing with landmines

Idan's 8am briefing has to narrate a messy overnight:
- A meeting he had today was silently canceled by the organizer last night. The briefing doesn't say "still waiting on you" about it — that input ask got cleaned up automatically the moment the event disappeared.
- Three days ago Maelle proposed three slots to Michal for a sync. Michal never formally replied, but Maelle notices an event on Idan's calendar that matches one of the options. The briefing says "Michal picked Tuesday 11am" — not "still waiting on her."
- Yoni ignored two pings a week ago. The briefing says, "Yoni went quiet, closing it out."
- A colleague in Paris, Ben, is in his early-afternoon window right now. Maelle sends him a short warm message separately — she doesn't put it in Idan's briefing because it's her initiating, not his decision.
- The briefing ends with something personal — Idan mentioned his daughter's recital a week ago and hasn't said anything since. Maelle asks him how it went.

---

## Scenario 8 — When lunch can't stretch anymore

Iris, who runs a recurring Thursday sync with Idan, messages: can we move Thursday 30 minutes earlier, to noon?

Noon clips the front of Idan's lunch window. Maelle figures out that if she moves lunch to 12:30 it still fits inside his flex window — so she accepts Iris's move, bumps lunch, and tells Idan in passing ("moved Iris to 12:00, shifted lunch 30 min later, no drama").

Twenty minutes later Iris writes back: "sorry, one more — my calendar shows a conflict I missed, can we actually make it noon to 1pm, a full hour?" Maelle works it out: there's no way to keep lunch inside its flex window now. She stops. She tells Iris she'll check and get back to her, and pings Idan: Iris needs a full hour, which means your lunch shifts out of its usual window — ok? Idan approves. Lunch bumps, meeting gets the full hour. Maelle lets Iris know it's set, without making a production of the back-and-forth.

---

## Scenario 9 — The voice note from the car

Idan records a quick voice message while driving — there's road noise in the background: "Tell Sarah I need to move our 3pm today — Thursday's better." Maelle transcribes it. She catches the core ask but pauses: Idan has two Sarahs in his contacts, and the audio is a bit muffled on the name. Rather than guess, she replies quickly: "Sarah Cohen, right? Not Sarah Levi?" Idan confirms Cohen.

Maelle finds today's 3pm with Sarah Cohen, reaches out to her with three Thursday options, framed as a reschedule. Sarah picks Thursday 4pm. Working hours fine, no conflicts — Maelle just updates the meeting directly. Because Idan started in voice, she replies to him by voice: "moved with Sarah Cohen to Thursday 4pm, confirmed."

Ten minutes later Idan messages in text: wait, Thursday is the offsite. Can you bump Sarah to Friday? Maelle catches that Thursday 4pm now conflicts with an all-day offsite she should have noticed before booking. She owns it — no excuses — asks Idan to confirm Friday, and re-coords with Sarah.

---

## Scenario 10 — Four people, three continents

Idan asks Maelle to set up an hour with him, Yael in Tel Aviv, James in London, and Priya in New York, sometime in the next two weeks. Maelle finds the narrow overlap — late Israeli afternoon is mid-afternoon London is morning New York — and sends three slot options to all four.

Priya replies first, flexible. James picks one or two. Yael doesn't reply. After a few hours of her working day, Maelle nudges Yael one more time. Still silent. She's about to give up and suggest dropping Yael when Yael finally responds: none of the slots work, she has to do school pickup at 5pm Israel time.

Maelle quietly files away that constraint — Yael can't do anything after 4:30pm Israel going forward — and recalculates. The new intersection is tighter, only a 60-minute band on three days of next week. She sends two fresh options. All four align on one. Booked. She sends Idan a quiet recap of the whole saga on the side.
