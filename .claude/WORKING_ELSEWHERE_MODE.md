# Working Elsewhere Mode — build spec

**Status:** BUILT (Phase 1 + 2), typecheck clean, awaiting live verification on the June-28 fixture. Designed + built in the de-tenant / memory-layer session.
**Layer:** process-layer, tenant-neutral, default-on. NOT user memory, NOT per-trip config.
**Owner action required:** none beyond an Outlook marker the owner already knows how to set.

---

## 1. Problem

When the owner works from a different location/timezone for a stretch (e.g. CEO travels to Boston for a week), **almost all his scheduling assumptions break at once** — not just timezone, but office/home day shape, work hours, the free-time floor. His home calendar still shows times as "free," but those times are the middle of the night where he physically is.

Live example (week of 2026-06-28, real calendar):
- 5-day all-day marker `Boston placeholder · showAs=workingElsewhere · Sun→Thu · location="Boston Office"`.
- `EMEA Forecast 10:00`, `BiWeekly 10:00` Israel = **03:00 Boston** → "free at 8am Israel, but asleep."
- `Brett 21:30` Israel = **14:30 Boston** → the *late*-Israel slots are the Boston-friendly ones.

Two rejected approaches and why:
- **Editing the YAML/config per trip** — breaks the "config is the stable intake form" model; churn every flight.
- **A free-text memory pref ("this week, all to approval")** — a colleague's direct `create_meeting` is a *code* path that runs whether or not Sonnet read a pref. A deterministic gate can't live in free text.

**The right signal already exists in the calendar.** Outlook's `Show As` has a native `Working Elsewhere` value. The truth lives where the owner already manages availability; Maelle just learns to read it.

---

## 2. The signal

A calendar event with **`showAs === 'workingElsewhere'`** ([calendar.ts:39](../src/connectors/graph/calendar.ts)) marks a Working-Elsewhere window:
- **All-day, possibly multi-day** (the common case — a travel week) → the whole span is WE.
- **Timed** → that window is WE.
- The event's **`location`** gives the away-location → away-timezone (see §4).
- **Category is irrelevant.** We key on `showAs` only. (A WE marker tagged "Vacation" is the owner's business; it does not affect detection and does not trip the OOF detector, which trusts `showAs`.)

Read **live** from Graph each turn — no caching of the marker itself, no config.

---

## 3. Behavior matrix

On any day/window covered by a `workingElsewhere` marker:

| Signal | Source | Behavior |
|---|---|---|
| Is it WE? | `showAs='workingElsewhere'` on owner's calendar | suspend the rule layer for that window |
| Busy / free | real events (absolute time) | **still fully respected** — never offer over a real meeting |
| Rule layer (office/home, work_hours, free-time floor, location defaults) | — | **suspended** — these are unreliable while elsewhere; do not apply them confidently |
| Local daytime | marker `location` → away-TZ (§4) | clip free gaps to away-TZ daytime; render in away-TZ / dual |
| Read ("when is he free?") | `find_available_slots` WE branch (§5) | return busy-aware open gaps, **tagged tentative**, in away-TZ |
| Write (book) | `planMeeting` / coord WE gate (§6) | **route to `create_approval`** — don't auto-book, don't auto-refuse on suspended rules |
| Active-mode health | calendar-health loop (§7) | **skip auto-fixes** on WE days |
| Location unresolvable | §4 fallback | **fail LOUD** — ask the owner the timezone; never silently offer home-TZ slots |

---

## 4. Timezone resolution (the robustness core)

**Principle: resolve once, off the hot loop; the static map is an optimization, not a gate; never fail silently.**

The slot loop is synchronous, which is why the *current* code can only use the exact-match static map ([locationTz.ts:80](../src/utils/locationTz.ts)) — and exact-match is brittle (`"Boston Office"` ≠ `"boston"` → `null`). That's single-tenant fragility: a second user won't know the magic words and won't see they got it wrong.

Fix — a `resolveWorkingElsewhereTimezone(marker)` helper, called when the WE window is **detected** (not per-slot), async-capable, cached:

1. **Structured location → deterministic.** If Outlook's `location` carries coordinates / a resolved address, derive IANA from geo. 100% reliable, no guessing. Prefer this when present.
2. **Free-text location → static fast-path → Sonnet fallback.** `inferTimezoneFromState` ([locationTz.ts:91](../src/utils/locationTz.ts)) already does static + Sonnet. Resolves "Boston Office", "Tel Aviv HQ", "our NYC hub", anything. Because resolution is off the hot loop, the async Sonnet call is fine.
3. **Cache** the resolved IANA (keyed by the location string, or stamped on the WE-window handling) so repeated slot searches that week read it synchronously — no re-resolve in the loop.
4. **Unresolvable (empty / gibberish, even Sonnet can't place it) → FAIL LOUD.** Maelle asks: *"You're working elsewhere that week — what timezone are you in?"* (optionally saves the answer). She **never** silently falls back to the home TZ and offers a slot. The silent-wrong-answer path is closed by design.

This is what makes WE-mode safe to hand to a second tenant: they write the location however they naturally do; a miss costs one Sonnet call (or one question), never a 3am booking.

---

## 5. Read path — `find_available_slots` WE branch

`find_available_slots` already fetches the owner's events for the range (for elastic-block + busy logic), so it can see the WE marker.

**Current behavior (wrong for WE):** an all-day non-free event is treated as a **full-day block** ([calendar.ts:813-825](../src/connectors/graph/calendar.ts)) → a WE day returns *zero* slots → Maelle says "busy all day." Must change.

**New WE branch** — when the search range intersects a WE window:
- **Do NOT block the day.** He's working, just elsewhere.
- **Keep the busy filter** (real meetings still block their slots — absolute time).
- **Drop the soft-rule clip** — no office/home/work_hours/free-time-floor filtering (those are suspended).
- **Clip to away-TZ daytime** — a generous band (e.g. 08:00–20:00) in the resolved away-TZ. This is what correctly excludes 08:00 Israel (= 01:00 Boston).
- **Tag returned slots** `tentative_working_elsewhere: true` + carry the away-TZ + location in the result so the caller can render and narrate.
- **Render dual-TZ** — reuse the existing traveling-attendee dual-TZ rendering (`"10:00 Boston / 17:00 your time"`), just inverted (the *owner* is the traveler now). Pattern lives near `attendeeAvailability` / slot proposal formatting.

---

## 6. Write path — `planMeeting` / coord WE gate

A booking whose slot falls in a WE window:
- **Colleague path** → `create_approval` (the owner accepted this). Don't auto-book; don't auto-refuse on a now-suspended rule. Reuse the existing `escalate_approval` verdict shape in `planMeeting` ([planMeeting.ts:355-409](../src/skills/meetings/planMeeting.ts)).
- **Owner path** → proceed (he's the authority), with a one-line heads-up ("you're marked Working Elsewhere that day — booking anyway?").
- Coord (`coordinate_meeting`) bookings into a WE window → same approval routing.

> Note: this rides *alongside* the separate `min_slot_buffer_hours` gap found this session (lead-time buffer not enforced in `planMeeting`). Different fix; don't conflate.

---

## 7. Active-mode health

On WE days, the active-mode calendar-health loop ([calendarHealth.ts](../src/skills/calendarHealth.ts)) **skips its auto-fixes** (no auto-add lunch, no auto-resolve) — same "don't assume the rules hold" logic. It may still *surface* observations to the owner, but takes no autonomous action on a day whose rules are suspended.

---

## 8. Narration

Sonnet-driven, from the `tentative_working_elsewhere` tag + away-TZ in the tool result. No new prompt enforcement rule — the result carries the facts. Target voice:

> *"He's working elsewhere Thursday (Boston). His calendar looks open around 10–11am Boston (5–6pm your time), but I'd confirm the exact time with him before locking it — want me to?"*

Honest, useful, never a dead-end "I don't know."

---

## 9. Explicitly OUT of scope

- **The owner's existing home-TZ meetings on WE days** (e.g. the 10:00-Israel standups = 03:00 Boston). Whether to flag/move those is a *separate* feature. WE-mode governs *new* availability/booking only.
- ~~**Marker hygiene.**~~ DONE (v3.3) — `manage_working_elsewhere(action:set|clear, start_date, end_date?, location)` on CalendarHealthSkill (owner-only) lets the owner create/clear the marker from chat ("next week I'm in France Mon–Tue"). Creates an all-day `showAs:workingElsewhere` event with the location. The Graph `createMeeting` gained an optional `showAs` for this (still busy-by-default for normal meetings). The owner can still set it directly in Outlook too.

---

## 10. Code touch-points (from this session's tracing)

| Concern | Location | Change |
|---|---|---|
| WE detection / type | [calendar.ts:39,65](../src/connectors/graph/calendar.ts) | `showAs:'workingElsewhere'` already typed |
| Full-day block (the bug) | [calendar.ts:813-825](../src/connectors/graph/calendar.ts) | split WE out of the all-day-block branch |
| Slot search WE branch | `findAvailableSlots` (calendar.ts) | drop soft clip, keep busy, away-TZ daytime, tentative tag |
| TZ resolution | new `resolveWorkingElsewhereTimezone`; reuse [locationTz.ts:91](../src/utils/locationTz.ts) | off-loop, geo→static→Sonnet, cache, fail-loud |
| Dual-TZ render | reuse attendee-travel rendering | invert (owner is traveler) |
| Booking gate | [planMeeting.ts:355+](../src/skills/meetings/planMeeting.ts) | WE window → `escalate_approval` |
| Active-mode skip | [calendarHealth.ts](../src/skills/calendarHealth.ts) auto-fix loop | skip auto-fixes on WE days |

---

## 11. Build phases

- **Phase 1 (MVP):** WE detection + the `find_available_slots` block→tentative branch + off-loop TZ resolution (with loud fallback) + the `planMeeting` approval gate. This is the whole user-visible behavior.
- **Phase 2 (polish):** dual-TZ narration refinement; active-mode skip; geo-coordinate resolution path; optional `respect_working_elsewhere` kill-switch (default on).

## 12. Verification fixture

Week of **2026-06-28** (real calendar, `scripts/check-calendar-period.mjs 2026-06-28 2026-07-04`):
- Expect: Sun–Thu detected WE; `location="Boston Office"` resolves to `America/New_York` (via Sonnet fallback, since static misses the " Office" suffix); availability offered in Boston daytime (excludes the 10:00-Israel/03:00-Boston slots, includes Brett-style 21:30-Israel/14:30-Boston); colleague bookings → approval; no slot before resolution is ever offered in home TZ silently.
