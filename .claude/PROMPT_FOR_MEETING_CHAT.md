# Handoff → meeting-planner chat: 1.2 (WE-day conflict framing)

From the prompt chat. A small **narration/framing** item from the Dirk incident
(2026-06-23, Idan traveling in Boston) belongs with your **bug 1.1 (WE / timezone
correctness)** work — it's being routed to you because it needs a **per-turn
Working-Elsewhere signal**, which is code in your domain, not static prompt prose.

## The gap
The dual-TZ framing already exists for the slot-finder path — `ops.ts:2119` tells
Maelle, on WE-tagged slots: *"present them in HIS local time there, dual-TZ
('10:00 Boston / 17:00 your time')."* But the incident happened on the
**approval / conflict-flag path**, which doesn't call `find_available_slots`, so
that note never fired — and there is **no per-turn WE signal in the prompt
builder** (`systemPrompt.ts` / `index.ts` don't detect owner-WE; the WE util's
detection is async calendar reads, too heavy for the static builder).

## What's needed (yours — you're adding WE/tz per-turn context for 1.1 anyway)
When the owner is on a Working-Elsewhere day, inject this one framing line
**dynamically (WE-only)** — alongside the existing WE note, NOT into always-on prose:

> When {owner} himself is on a Working-Elsewhere day, lead with the
> destination-local time ("10:45 Boston / 17:45 your usual time"); and when
> flagging an over-hours / conflict, name the real reason in one clause — don't
> say "past your usual finish" unless it's true in the timezone he's in that day.

## Scope
Framing / wording only. The tz **computation** is your bug 1.1; this is just how
Maelle phrases the flag and which TZ she leads with. The prompt chat deliberately
did **not** add this to static meetings prose — it would bloat the always-on
prompt and collide with your WE/tz code. Lowest tier = fires only on a WE day.

## Context: the incident
Pending approval "book Dirk's PT Overview 17:45?"; Idan in Boston that day. Maelle
(a) flagged "past your usual finish" without saying the real reason (travel/tz),
and (b) led with Israel-time framing, only giving the ET reading ("10:45 AM ET =
17:45 Israel") after he asked twice. The sibling fix (1.3 — a clarifying question
isn't a verdict) was handled in the prompt chat (`systemPrompt.ts`, dynamic
approval block).
