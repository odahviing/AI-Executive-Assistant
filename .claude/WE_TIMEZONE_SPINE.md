# WE → Timezone: the one-spine fix (build-ready proposal)

**Status:** ✅ BUILT + VERIFIED 100% (uncommitted). Built from a 25-agent ultracode audit, owner-revised to the **relax+approval** model, then traced 11/11 + Stage-5 consumer migration verified + one-source invariant confirmed.

## BUILT — files & verification
Five stages, all typecheck-green, nothing committed:
- `utils/workingElsewhere.ts` — NEW `detectOwnerAwayDaysInWindow` (dual-source: marker ∪ travel record); `summarizeWorkingElsewhere` made dual-source.
- `connectors/graph/calendar.ts` — `find_available_slots` WE detection now dual-source (the Alliance root: travel-record trips were invisible to search).
- `skills/meetings/ops.ts` — create + move bare-time **guess deleted** (no silent trip-tz reinterpret); `get_calendar`/`analyze_calendar`/`get_free_busy` notes dual-source.
- `skills/meetings/planMeeting.ts` — WE → **relax + dual-clock confirm (owner) / approve (colleague)**, dual-source, both paths.
- `skills/calendarHealth.ts` — auto-fix suppressor dual-source (closed a silent wrong-tz auto-write hole).
- `core/orchestrator/index.ts` — per-turn `ownerLocationBlock` (home-vs-away grounding; record-based, zero Graph) — the Gidon fix.

**Trace: 11/11 scenarios pass** (Alliance, Dirk, Gidon, no-marker invariant, owner-typed time, multi-day, move, tz-unresolved, replay, DST-mid-trip, non-Israel-home), zero regressions. **Stage-5: 3/3 consumer migrations verified** correct-on-record-only-trip + no-regression-on-normal-day. **Invariant CONFIRMED:** marker-only detection is internal-only; every consumer uses the one dual-source resolver.

Residuals (by-design / pre-existing, not splits): `getTravelRecord` self-prunes only when `until < today`; `get_calendar` colleague path carries no away-note (intentional — colleagues route via `find_available_slots`); tz-unresolved location degrades the dual-clock to a single clock (still routes to approval).

---

## REVISED MODEL (owner-confirmed — THIS is what gets built; supersedes the "evaluate rules in trip tz" approach in the sections below)

The owner's model: **on a WE day, Maelle RELAXES the home rules (they don't cleanly apply when traveling), presents the open options in the correct trip timezone, and routes the booking to the owner's approval — because traveling is different timing.** WE → relax + approve. The bug was never "WE forced approval"; it was "the options + the booking showed the WRONG time (home tz)."

This **removes the riskiest third of the original design** — there is NO re-evaluation of the owner's rules in the trip tz, so the *fatal* critiques (day-key schism, home-shaped config / rule-1 off-day flip, the work-hours-shape collision) are **moot**: on WE we don't run those rules at all. `checkSlot` needs **no** `effectiveTz`/day-key change.

The hard part collapses to **time-correctness only** — every surface must show/book the right trip-tz instant:
1. **Dual-source WE detection in the SEARCH.** `find_available_slots` must detect WE the same way booking does — marker **AND** the `currently_traveling` travel record (the Alliance July-1 had a record, no marker → search saw "home"). Route WE detection through the one resolver, not marker-only `detectWorkingElsewhereDays`.
2. **WE slots carry their trip tz explicitly** (offset-bearing ISO + `away_tz`) so the booked instant = the offered instant.
3. **Delete the create/move bare-time GUESS** (`ops.ts:2185`/`3763`). A slot carries its tz; an owner-*typed* time on a WE day is interpreted in the resolved trip tz through the one resolver (the only place a bare clock is interpreted).
4. **On a WE day: relax + route to approval** (owner-path = one-step confirm with dual-clock; colleague-path = owner approval). Largely exists (`planMeeting:379` escalation) — fix it to carry the correct tz, and keep it (do NOT delete it).
5. **Persist the resolved trip tz through approval-replay** so the approved time books at the right instant.
6. **Per-turn location grounding in the prompt** (home vs away+tz) — the Gidon fix.
7. **DST mid-trip + the day-detection boundary** still matter for the *instant*; all date↔date via `setZone`, never fixed-offset arithmetic.
8. **Drop "tentative" entirely** — it bundled "show dual-clock" (now: render both clocks when `isAway`) + "needs confirm" (now: explicit WE→approval). Redundant.

Decisions resolved with owner: #1 WE hours = plain 09–18 in the trip tz (offer window, relaxed not enforced); #2 day = where you are; #3 WE → approval (relax, owner decides); #4 drop tentative.

The DELETE/CHANGE tables below still apply for the **time-correctness** items (#1 dual-source, the guess removal, away_tz carry, replay persistence, prompt, fetch windows, DST). **Ignore** the rows about adding `effectiveTz`/day-key to `checkSlot` and evaluating rules in the trip tz — superseded by relax.

---

## Why WE keeps breaking (the real root)
Working-Elsewhere correctness is split across layers that **independently re-derive "is he away today, and in what tz" — and disagree**:

1. **Dual-source vs single-source detection.** `find_available_slots` detects WE from the **all-day `showAs=workingElsewhere` marker only** (`calendar.ts:913` `detectWorkingElsewhereDays`). The book path's `resolveOwnerTravelContextForDate` (`workingElsewhere.ts:87`) reads **two** sources — the marker **and** the `people_memory.currently_traveling` travel record. **The Alliance incident:** July 1 had a travel record but no marker → search saw "home" (offered 18:00 Israel), book saw "Boston" and re-stamped it → booked `2026-07-02T01:00` (1 AM, day-rollover). Search and book read different truth.
2. **Everyone re-derives.** The slot search, `checkSlot`, `availabilityPreCheck`, `planMeeting`, create/move, the prompt — each resolves or guesses tz on its own. The create/move **bare-time reinterpret** (`ops.ts:2185` / `3763`) *guesses* "bare time on a trip day = trip tz" — which double-converts a search-emitted owner-tz time (the Alliance mechanism).
3. **`checkSlot` is home-tz blind** (`scheduleRules.ts:150`) — the Dirk "past your usual finish" false escalation: a 10:45 Boston slot judged against Israel 09–18.
4. **WE forces approval** with zero rule evaluation (`planMeeting.ts:379-401`, `availabilityPreCheck.ts:344`) — your "WE ≠ approval" complaint.
5. **The prompt has no per-turn location signal** — home days emit nothing, so stale memory invents travel (Gidon).

## The two changes you asked for
- **ONE SPINE:** resolve the day's effective tz **once per turn** when WE is detected; every consumer **uses** it — no per-tool re-derivation, no guessing.
- **WE ≠ APPROVAL:** a WE day evaluates the **same** rules in the resolved tz; it never escalates just for being WE.

## The spine

**One resolver.** `resolveOwnerTravelContextForDate` becomes THE only function answering "where/what-tz on day D" (it already unifies marker + travel record). `detectWorkingElsewhereDays` / `resolveWorkingElsewhereTz` / `getTravelRecord` are called **only inside it**. Resolved **once per turn** over already-fetched events (zero extra Graph; `resolveWorkingElsewhereTz` is memoized), into an authoritative map.

**Carry the whole context, not just a tz string.** (This is the critical correction the adversarial pass forced — a bare tz string relocates the bug.)
```
OwnerDayContext {
  dayKey: string        // yyyy-MM-dd in OWNER-HOME tz — the canonical day identity
  isAway: boolean
  effectiveTz: string   // resolved trip IANA; = homeTz when !isAway
  tzUnresolved: boolean // isAway but location→tz failed → ASK, never assume home
  homeTz: string
  location: string
}
OwnerDayContextMap = Map<homeTzDayKey, OwnerDayContext>   // for multi-day searches
```
A shared `ownerTzForDay(map, dayKey, homeTz)` mirrors the existing `attendeeAvailability.ts:attendeeTzForDay` — one helper for owner AND attendee per-day tz.

**The invariant that makes it 100% (why the one-liner failed):** decouple **"which day's rules apply"** (always the owner-home-tz `dayKey` — his *intended* day) from **"what clock the slot is in"** (the slot's `effectiveTz`). `checkSlot` must be handed the **resolved `OwnerDayContext`** and must **not** re-derive `dayName`/day-type/work-hours-key/focus-day from the away tz. Otherwise a Boston-evening slot (= Israel next-day) gets its rules looked up under the wrong calendar day — the Alliance rollover re-entering through the validator (adversarial verdict: *fatal*).

## Marked areas

### DELETE (rotting guess/duplicate layers)
| File:line | What | Why |
|---|---|---|
| `ops.ts:~2188` | create_meeting bare-time reinterpret | the GUESS that double-converted Alliance → 1 AM |
| `ops.ts:~3766` | move_meeting bare-time reinterpret (copy) | same class; poisons the colleague gate + weekday check downstream |
| `planMeeting.ts:379-401` | colleague WE `escalate_approval('owner_working_elsewhere')` | forces approval purely for WE-ness, zero rule eval — the WE≠approval violation |
| `availabilityPreCheck.ts:344-346` | unconditional `bookable:false` on `isAway` | same — short-circuits to approval without evaluating in the away tz |
| `calendar.ts:1179-1182` | WE-day hard-skip in the main walk | diverts WE days into a rules-free engine; replaced by walking them in the resolved tz |
| `workingElsewhere.ts:98/110` | silent `tz ?? homeTz` fallback | re-introduces home-tz-blind eval on an away day; must become `tzUnresolved` |

### CHANGE (consumers of the one resolution)
| File:symbol | Change |
|---|---|
| `workingElsewhere.ts` `resolveOwnerTravelContextForDate` | return `tzUnresolved` (away but tz unknown) instead of silently `effectiveTz=home`; marker-over-record precedence kept; promote to range form building the `OwnerDayContextMap` |
| `scheduleRules.ts` `RuleCheckInput`+`checkSlot` | accept the **`OwnerDayContext`** (not just a tz). Evaluate the slot **clock** in `effectiveTz`, but look up **day-type / work-hours-window / focus-day under the home-tz `dayKey`**. On `tzUnresolved` return a distinct `tz_unresolved` verdict (un-ignorable — one chokepoint, not N consumers remembering a boolean) |
| `calendar.ts` `findAvailableSlots` | accept `params.ownerDayContexts`; walk WE days in the resolved tz (no skip); **add `away_tz`/trip-offset to the emitted slot shape** and emit WE-day `start` in `effectiveTz` (offset disambiguates — kills "no tz on WE slots"); match Guard B on **epoch ms**, not re-derived wall-clock |
| `ops.ts` find_available_slots + create/move | build the `OwnerDayContextMap` once before search (reuse loaded events), pass to search AND Guard B; create/move consume the away_tz on the chosen slot + stamp `BookingRequest.ownerDayCtx` selected by the **chosen slot's dayKey**; keep one deterministic interpret for **owner-typed** times (driven by the resolver, gated by provenance: slot-sourced carries offset, typed is interpreted in `effectiveTz`) |
| `planMeeting.ts` | resolve `OwnerDayContext` once after `loadEventsForCheck` (or reuse `BookingRequest.ownerDayCtx`); thread into `checkSlot` + `resolveLocation`; delete the WE gate; `tzUnresolved` → ask |
| `core/requests/resolver.ts` (replay) | persist `ownerDayCtx` on the approval payload; replay **consumes** it, never re-resolves (marker may have changed) |
| `index.ts` + `systemPrompt.ts` | resolve owner day-context once per turn over the freeTime pre-fetch; render OWNER LOCATION (home vs away+tz) next to `Now:` and per-day in the date table — asserts HOME on home days (kills Gidon) |
| `workingElsewhere.ts:184` `summarizeWorkingElsewhere` (read tool) | update the note from "rules suspended" to "rules evaluated in trip tz" — else `get_calendar` tells the owner "no rules on travel days" while booking enforces them |
| `dateVerifier.ts` | render a WE-day booking in its resolved tz so a rollover can't certify as consistent |
| fetch windows (`calendar.ts` focus-floor, `workingElsewhere.ts:140` single-day) | always cover the full home-tz day ± max home/away offset on WE days, regardless of category — else the away-tz day straddles the fetch and the busy set is truncated (phantom-free → double-book) |
| all date↔date conversions | via `setZone`, never fixed-offset arithmetic — **DST inside a trip makes the offset non-constant** |

## DECISIONS I need from you (these are genuinely yours)

1. **WE-day work-hours shape.** On a Boston day, does your "09:00–18:00" mean **09–18 Boston** (your routine travels with you — recommended, matches "same rules, different clock") or **09–18 Israel** (you keep your home-team hours)? The spine evaluates the slot clock in trip tz either way; this decides which window the hours-rule uses.
2. **Day-type identity on a WE day.** Recommended: day-type (office/home/off) keys off your **intended (home-tz) day**, so a Boston-Thursday-evening slot is judged as Thursday, never flipped to an Israel-Friday off-day. Confirm.
3. **Colleague booking onto your WE day.** You said WE≠approval (true for *you* — one-step). But a colleague auto-booking onto your trip day relies on an **LLM-resolved** tz. Keep a **thin one-line confirm** ("he's in Boston that day — confirming the time works") only when the tz came from inference (not a marker/static map), or fully trust it? Recommended: trust the resolved verdict; keep the light confirm only on inferred-tz.
4. **Tentative label.** Decouple the dual-tz *display* label (keep, for narration) from the *approval trigger* (drop). Confirm.

## Coverage (from the scenario traces)
- **Fixed by the spine:** Alliance (no rollover), Dirk (judged in Boston, no false "past finish", no WE-only approval), Gidon (home asserted).
- **Hardened by the corrections above** (these *regressed* under the naive one-liner — that regression set is the whack-a-mole, and is why the build is the hardened spine, not the swap): owner-typed bare time, multi-day mixed home/away search, move across day-types, owner-own-WE-day validation, tz-unresolved.

## Residual gaps to watch (call them out, don't silently ship)
- **DST transition mid-trip** — the home↔away offset is not constant; the single biggest untested geometry. All conversions via `setZone`.
- **Cloneability:** a **west-of-UTC home owner** would get markers shifted a day by the `.setZone().startOf('day')` parse — fine for Israel today, a future-tenant bug.
- **Two resolvers for one location string** (marker→Sonnet vs travel-path→static map) can disagree — funnel both through the one resolver.
- **Read-tool framing** (`summarizeWorkingElsewhere`) must match the new "evaluated in trip tz" reality.
- `coordinate_meeting` multi-attendee WE interaction — **moot**: coord was removed in 3.5.0.

## Suggested build order
1. The resolver + `OwnerDayContext`/`tzUnresolved` + `ownerTzForDay` helper (the spine atom).
2. `checkSlot` consumes the context (day-key pinned, clock in effectiveTz, `tz_unresolved` verdict).
3. `find_available_slots` walks WE days in-tz + emits `away_tz` + epoch matching; `ops` builds/threads the map; delete the two reinterpret guesses.
4. `planMeeting` + `availabilityPreCheck` consume; delete the two WE-approval branches.
5. Prompt + read-tool + dateVerifier + replay persistence + fetch windows.
6. Full `trace` across all 9 scenarios + the residual-gap geometries (DST, west-of-UTC) — 100% bar.
