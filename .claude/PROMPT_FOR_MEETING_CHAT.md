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

---

# Handoff → meeting-planner chat: rename the free-time-floor label at the source

From the prompt chat (owner-DM narration incident, 2026-06-29). **Code-side naming fix — the authoritative half the prompt can't fully cover.**

## The bug
The owner was told a 14:00 slot was blocked by a "focus-time block" — but he has **no such calendar event**; it was his **2h free-time floor** (`free_time_per_office_day_hours`). The label misled him.

## Root cause is in code (verified)
`focus_time_office` (a `rejectedCounts` reason) enforces the **free-time floor** (`ops.ts:437` → `free_time_per_office_day_hours`; comment `ops.ts:1654` calls it "free-time floor"). BUT its `broken_rule_label` renders **"breaks {owner}'s focus-time protection (office day)"** at **`ops.ts:1484`, `:2742`, `:4144`** — and the prompt pastes `broken_rule_label` **verbatim** (RULE-COMPLIANCE REFUSAL rule). So the tool itself hands Maelle the misleading "focus-time" wording; a prompt rule can't override a verbatim-pasted label.

## Ask
Rename that label at the 3 sites → e.g. **"would leave {owner} under his 2h free-time floor (office day)"** (or your preferred phrasing). Also consider the `ops.ts:2227` example string ("eats into your focus block"). Once the code label says "free-time floor," the prompt examples that paste it are automatically correct.

## Caution (why I didn't just sweep the prompt)
There may be a **genuine** "focus time" concept too — a floating-block / category (see `meetings.ts:880`, `:950` "the focus time you keep open"). That's a real calendar block and should KEEP its name. Only the **`focus_time_office` free-time-floor rejection** is mislabeled. So the rename must be scoped to that reason code, not a blanket find-replace of "focus" — which is exactly why this belongs with you (you own the scheduling concept), not a prompt sweep.

## Prompt side (already done, partial)
The prompt chat fixed the incident-specific narration in `meetings.ts` (the "OWNER NAMES A SPECIFIC TIME" one-step rule, and the free-time-floor wording at lines ~148/974/979/1043) and `systemPrompt.ts` (owner "you" voice, don't-name-machinery). Residual "focus time/block" references for the floor remain at `meetings.ts:899/903/1067`; recommend leaving them until the code label is renamed, then sweeping consistently in one pass.
