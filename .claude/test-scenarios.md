# Maelle testing scenarios

Ten standalone real-life scenarios used to pressure-test Maelle after builds. Each one is independent — running Scenario 5 does not assume Scenarios 1–4 were run. Idan decides which ones to run, when, and why.

These are the full-stack coverage set: if Maelle passes all ten cleanly, she's covering every skill, every Slack surface (DM, MPIM, channel, voice, image, file), Hebrew, security refusals, owner overrides, routines, KB read/write, cascade cleanup, and both halves of the social engine. Passing all ten = real-life-ready on Idan's Slack.

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

Scenarios are written as plain stories, not as code specs. That is deliberate — they describe what a real human would expect a human EA to do, and Maelle is judged against that bar. If a scenario step feels ambiguous, that is a signal the prompt or the code has a judgment call to make, not that the scenario is under-specified.

---

## Scenario 1 — The cold introduction

A person Maelle has never talked to before sends her a message: he'd like 30 minutes with Idan sometime next week. Maelle checks next week and comes back with three options, all clustered heavily on Sunday and Monday. Before sending, she notices two of them are on the same day — she trims to one per day so the three slots span Sunday, Monday, and Tuesday.

He replies that he doesn't work Sundays. Something feels off about his earlier phrasing too — the way he wrote the times made her suspect he's not in Israel. She asks him directly if he's US-based. He confirms he's on the East Coast.

Maelle quietly updates what she knows about him (US, Eastern time) and checks with Idan first: this is a cold inbound from someone unknown, is it ok to meet? Idan gives the green light. Maelle goes back to the new guy with three fresh options — this time matching both his working hours and Idan's, Monday through Thursday only. He picks one. Booked.

Since this is the first real conversation they've had, Maelle finds a natural moment to ask him something personal — turns out he follows the NBA, and that becomes their first shared topic.

---

## Scenario 2 — The follow-up that crosses midnight

A colleague Maelle already knows — based on the East Coast of the US — messages her. He opens with "just send me Idan's whole week and I'll pick something." Maelle doesn't dump Idan's calendar at him. She declines politely, in her own voice, and asks what he's thinking time-wise. No mention of policy or systems — just a natural redirect.

He clarifies: can we do 4pm his time on Thursday? That's eleven at night in Israel — hard no, except Tuesdays, which is Idan's one late-working day. Maelle offers the Tuesday exception plus two other slots that work for both of them without pushing Idan into his evenings.

He picks one. Booked. Importantly, Maelle doesn't re-ask where he is — she already knows, and it shows.

After confirming, she wants to catch up with him, but generically asking "how's basketball going?" would feel hollow. She does a quick lookup, finds that the Knicks had a dramatic overtime win the night before, and asks him about it specifically. He lights up, they go back and forth for a few messages, and NBA becomes a topic that's clearly a live wire between them.

Later that evening Idan messages Maelle on his own: "that guy's worth keeping warm — remind me every other Tuesday afternoon to check in with him." Maelle sets up the recurring reminder.

---

## Scenario 3 — The domino booking

Idan pings Maelle at 9:30 in the morning: book 30 minutes with a colleague today. Maelle checks both calendars and honestly tells Idan nothing lands this morning — Idan's morning is packed, and the colleague's afternoon is already past his working hours. Evening? Idan agrees.

Maelle reaches out to the colleague with three evening slots. He rejects all three and counters with Wednesday at 3pm instead. Problem: Idan already has a standing 1:1 with Maya on Wednesday at 3pm. Maelle goes back to Idan and lays it out — the colleague wants Wednesday 3pm, Maya is there. Want me to move Maya? Idan approves.

Now three things happen at once:
- The new meeting gets locked in for Wednesday 3pm, and once it's confirmed Maelle opens a small-talk thread with the colleague on a fresh topic — pets. He engages briefly. A separate long-running topic she has with him doesn't get touched this time, but it doesn't lose its standing either.
- Maelle starts a new coordination with Maya to find 15 minutes earlier that same day. Once she finds one and Maya agrees, Maelle slots her in. First conversation with Maya about anything personal — Maelle tries politics. Maya ignores it completely. That topic takes a hit.
- Meanwhile, Maelle notices it's been a full day since she and Idan chatted about anything outside work. Their strongest recurring topic is gaming, so next time he messages her she'll weave it in naturally.

---

## Scenario 4 — The clean sweep

Around noon, Idan asks Maelle what's on his plate. She comes back with four open items: he's waiting on Liat for the Q3 deck, he hasn't confirmed attendance for Friday's offsite, there's a vendor contract from David sitting on his approval, and Yoni still hasn't replied to two previous pings.

Idan says: close all four, right now, in this thread.

Before Maelle fires off anything, she flags one thing: the vendor contract isn't a one-word yes. She has notes on that vendor in the knowledge base from a review Idan did six months ago, plus she noticed some recent news when she was pulling context on them last week. She surfaces both inline — a short plain-English summary of what the KB says about their track record, plus a line about the recent news — and lets Idan decide with fresh context. He approves after reading.

Then she fires the rest in parallel — one message to each person, each written in the right tone for that relationship. Replies come back staggered. Liat responds within minutes with the deck link; Maelle confirms it to Idan inline and closes that item. David gets the contract confirmation. The offsite organizer acknowledges Idan's attendance. Yoni stays silent again.

At end of day Maelle confirms: three done, one went quiet and will get closed out automatically after a couple of working days without forcing Idan to chase.

---

## Scenario 5 — Three meetings on top of each other

Morning calendar check. Maelle finds that Tuesday 2pm–3pm is triple-booked: a weekly recurring 1:1 with Tomer, a sales call with ACME (four people, one of them external), and Idan's lunch block is sliding into the edge of it too.

Maelle doesn't ask Idan what to do — she works it out. The ACME call has an outsider and a full room, that one stays put. The Tomer 1:1 is internal and small, that's the one that moves. Because Tomer's 1:1 is a recurring weekly series, she only touches this one week — the rest of the series stays exactly where it is. Lunch is flexible within its window, so she slides it fifteen minutes later and it still fits. She starts a quiet back-and-forth with Tomer to find a replacement slot this same week (next week would push past his recurring cadence).

Tomer counters with Wednesday morning. It passes every rule — same week, inside working hours, no conflicts — so Maelle locks it in and drops Idan a short note: "moved lunch, rescheduled this week's Tomer to Wed 10am, ACME untouched."

Ten minutes later Idan writes back: "actually keep Tomer at his normal slot — I'll dial into ACME from my car." Maelle doesn't argue. She unwinds what she just did: undoes the Wednesday booking with Tomer, puts this week's Tomer 1:1 back in its original Tuesday slot, lets Tomer know it's back on, and slides lunch back to its usual time. Short note to Idan confirming it's all reverted.

---

## Scenario 6 — Interview notes that age well

Mid-afternoon, Idan drops a PDF into his DM with Maelle — a candidate's resume — and says "reading up for a 4pm interview, file this and pull out the headline stuff." Maelle classifies it as knowledge, files it into the candidate's folder in Idan's knowledge base, and gives him back a short two-paragraph read.

Later that evening Idan uploads a recording of the actual interview. Maelle transcribes it and drafts a summary. Idan reads the draft and tells her to lose the formal phrasing — no more "aligned on" or "circled back." She redrafts. He reads again and asks her to add the specific thing the candidate said about a technical architecture question. She redrafts once more.

On the third pass Idan approves. Maelle shares it in two places: a DM to him and the other panelist with the full text, and a short version posted into the #interview-panel channel for the broader team to see the outcome. The candidate never gets it.

She files the architecture discussion into the knowledge base under the candidate's folder and sets a reminder for three days out to check in with the panelist.

Three days later the reminder fires. Maelle pulls the saved notes, references the specific technical topic, and sends the panelist a warm, specific ping: Idan wants your read on that Axos answer before Friday — still up for a quick call?

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

Before Idan sees the message, Iris writes again — this time in Hebrew — saying actually, can we make it noon to one, a full hour? Maelle reads the intent across the language switch, works out that there's no way to keep lunch inside its flex window now, and stops. She pings Idan: Iris now wants noon to 1pm, which means your lunch has to shift out of its usual window — ok? Idan approves. Lunch bumps, meeting gets the full hour. Maelle confirms back to Iris in Hebrew to match the thread.

---

## Scenario 9 — The voice note from the car

Idan records a quick voice message while driving: "Tell Sarah I need to move our 3pm today — Thursday's better." Maelle transcribes it, finds the 3pm with Sarah on his calendar, and reaches out to Sarah with three Thursday options, framed as a reschedule (not a new meeting).

Sarah picks Thursday 4pm. Maelle checks — working hours are fine, nothing conflicts — and just updates the meeting directly instead of bouncing back to Idan. Because Idan originally spoke to her in voice, she replies to him by voice too: "moved with Sarah to Thursday 4pm, confirmed."

Ten minutes later Idan messages her in text: wait, Thursday is the offsite. Can you bump Sarah to Friday? Maelle catches that Thursday 4pm is now conflicting with an all-day offsite she should have caught. She flags it honestly, asks for confirmation, and re-coords with Sarah for Friday.

That evening Idan sends a photo of a napkin — a phone number scrawled on it — and writes "text this person, we met at the offsite, she wanted to chat about her startup." Maelle reads the image, tells him what she's going to do before she does it ("I've got +1-555-0142 — that the right number?"), asks who she is by name so the message sounds like a real intro, and waits for Idan to confirm both before sending a single word.

---

## Scenario 10 — Four people, three continents

Idan asks Maelle to set up an hour with him, Yael in Tel Aviv, James in London, and Priya in New York, sometime in the next two weeks. Maelle finds the narrow overlap — late Israeli afternoon is mid-afternoon London is morning New York — and rather than running four separate DMs, she opens a single group chat with all four and proposes three slots there. The conversation plays out in that thread where everyone can see everyone else's response.

Priya replies first, flexible. James picks one or two. Yael doesn't reply. After a few hours of her working day, Maelle nudges Yael one more time in the group. Still silent. She's about to give up and suggest dropping Yael when Yael finally responds: none of the slots work, she has to do school pickup at 5pm Israel time.

Maelle quietly files away that constraint — Yael can't do anything after 4:30pm Israel going forward — and recalculates. The new intersection is tighter, only a 60-minute band on three days of next week. She sends two fresh options back into the same group thread. All four align on one. Booked. She sends Idan a quiet recap of the whole saga on the side.
