# Meeting-agent chat — START HERE (handoff, 2026-06-25)

You are the **meeting-planner deterministic-core agent** for Maelle. The prior meeting chat got too long; this is your cold-start. Read this whole file, then the two docs it points to, then begin on the open bugs in §4.

---

## 0. Read these first (your constitution)
1. **`.claude/MEETING_PLANNER_AGENT.md`** — THE CHARTER. Your mandate, the **14 owner rules** (load-bearing — every fix is checked against them), the diagnostic discipline, the subsystem map, the recurring bug clusters. Non-negotiable.
2. **`.claude/WE_TIMEZONE_SPINE.md`** — the big Working-Elsewhere → timezone project: the design, the adversarial audit, the owner-revised **relax + approve** model, and exactly what shipped.
3. **`CHANGELOG.md`** 3.5.0 → 3.5.2 — what's in the code now.

The charter's subsystem map tells you where everything lives (`skills/meetings.ts` tool surface, `skills/meetings/ops.ts` handlers, `planMeeting.ts` the decision spine, `scheduleRules.ts` the ONE validator `checkSlot`, `connectors/graph/calendar.ts` the slot search + cache, `utils/workingElsewhere.ts` the WE engine). **Note: coord was fully removed in 3.5.0** — the charter still names `coord/*`; ignore that.

---

## 1. How to work (owner's standing rules — he has corrected on these, honor them)
- **Propose-first, NEVER auto-fix.** Root-cause each bug to `file:line — what happens` from the log, prove it, then propose. Build only on a per-bug **"build it" / "fix it."**
- **NEVER commit / bump version / wrap without an explicit ship word** ("wrap" / "commit" / "ship"). "do it" / "yes" on a fix means *make the edit and leave it UNCOMMITTED.* (The prior chat over-stepped twice — don't.) `git push` is pre-authorized *after* a commit. `git add -A` sweeps other chats' WIP — fine only at a coordinated wrap ("take them all"), never on an unrequested commit.
- **Code-first; fix at the chokepoint; one validator; reduce LOC; no dedup (extract one fn); no NL regex (Maelle is multilingual); `trace` to 100% before "done."**
- **Shell:** never prepend `cd`; one logical command per Bash call; `gh ... --body-file` (write body to a temp file). Reads (logs, `node scripts/db-query.cjs`, grep, code) are free.
- **Parallel chats share one tree** (meeting / approval / guard / prompt / tenancy). Your lane = the **meeting deterministic core** (search / validate / book-decision / TZ / WE / floating-blocks / Graph + cache). **NOT** the approval spine (`core/requests/*`) — that routes to the approval chat.

---

## 2. The big WE → timezone project (the through-line of recent work)
**The problem:** the owner travels ("Working Elsewhere"). For months, timezone handling on WE days was split across layers that each re-derived "is he away, in what tz?" and **disagreed** → wrong-time bookings + wrong narration. The recurring instability the whole project targets.

**The owner's MODEL (locked — build to this):** on a WE day, **RELAX the home rules** (they don't cleanly apply in the trip place), **present options in the correct trip timezone**, and **route the booking to APPROVAL** (he eyeballs the trip-time before commit). Decisions he confirmed:
- **#1** WE work-hours = a plain **09–18 in the trip tz** (an offer window, relaxed not enforced).
- **#2** the day is **where he physically is** (a Boston-Wed-evening is Wednesday, even if it's already Thursday in Israel).
- **#3** WE → **relax + approve** (he decides; the trip-time gets a dual-clock confirm).
- **#4** drop the "tentative" concept.

**Data source (critical):** the owner's WE days are **all-day `showAs=workingElsewhere` calendar MARKERS** — his PRIMARY mechanism. The `people_memory.currently_traveling` travel **record** is for COLLEAGUES (the owner's own record is NULL). Detection is **dual-source (marker ∪ record)**, but for the owner it is effectively **marker-driven** — so any WE path that only reads the record misses his trips, and any path that only reads markers misses a colleague's. Home = `Asia/Jerusalem`; example trip = Boston `America/New_York` (≈7h, **DST matters** — see below).

**What SHIPPED (3.5.1 + 3.5.2, committed; the latest follow-up `4556e45` may still need a restart to be live):**
- **ONE dual-source resolver** — `detectOwnerAwayDaysInWindow` (range) + `resolveOwnerTravelContextForDate` (one day) in `utils/workingElsewhere.ts`. Marker-only `detectWorkingElsewhereDays` is now an internal primitive; every consumer routes through the one source.
- Consumers migrated: `find_available_slots` (calendar.ts), `planMeeting`, `availabilityPreCheck`, `calendarHealth` auto-fix suppressor, `get_calendar`/`analyze_calendar`/`get_free_busy` notes, and the per-turn prompt `ownerLocationBlock` (orchestrator/index.ts).
- The create/move **bare-time GUESS deleted** (it silently re-stamped a slot's home-tz time as trip-tz → the "1 AM" rollover).
- `planMeeting` WE routing: **relax + dual-clock confirm (owner) / approval (colleague)**, and the confirm is **DECOUPLED from `relaxed`** via a dedicated **`we_acknowledged`** flag (so a proactive `relaxed=true` like "just do it" can't skip the trip-time check). On a WE day `checkSlot` relaxes the home rules.
- **Lodging-marker location auto-stamp removed** (a team meeting was landing in the owner's hotel).
- **Booked-instant surfaced**: create/move return `booked_start`/`booked_end` (post grid-snap) and the orchestrator records THAT into `mutationActions` → dateVerifier + the #135 honesty backstop see where it truly landed.
- Duration-override folded into the one `relaxed` path.

**What the audit flagged as untested geometries (watch these):** DST changing mid-trip (offset isn't constant — always `setZone`, never fixed-offset arithmetic), a non-Israel (west-of-UTC) home owner, multi-attendee in a third tz.

---

## 3. The honest gap the spine did NOT close
The shipped work hardened the **book / confirm** path. The **SEARCH → narration** path on a trip week is **still broken** — that's the live incident below. When the owner asks "when can I do X," the slot finder returned home-tz slots with no WE tagging, and the model improvised the trip framing with self-computed (wrong) timezones. The fix focus is now: make `find_available_slots` reliably engage WE for the search the owner actually uses, and hand the model **deterministic per-zone rendered times** so it never does tz arithmetic.

---

## 4. START HERE — the Craig incident (2026-06-25), 5 bugs to root-cause
Owner asked "when can I do 25 min with Craig Joseph next week?" He's in Boston next week (markers Jun 29 / 30 / Jul 2); Craig is in Chicago (CT). Log: **`logs/maelle-2026-06-25.log`, the Craig thread ~line 515+** (threadTs `1782402092.436459`). Reproduce from the log; root-cause each; propose-first.

**Bug 1 (KEYSTONE) — the search didn't engage WE; the model improvised "Boston".** `find_available_slots` (line 530) returned `+03:00` **Israel** slots with **0 `working_elsewhere`/`away_tz` tags** the whole conversation — even though the trip markers (Jun 29/30/Jul 2) are in the searched window AND were detected **4× elsewhere** in the same day's log. So the slot finder treated a trip week as home; the model knew "Boston trip" from context and re-narrated home slots as Boston. **Search and narration disagree.** Root NOT yet proven — add a definitive log line / trace: did `find_available_slots`' WE detection miss the all-day markers in its fetch (`ownerEventsForFb` scope?), did the `profile ? detect… : empty` ternary go empty, or did the tags not surface to the result? Prove it before fixing. This is the one that makes everything else go wrong.

**Bug 2 — multi-zone clock times are model-computed and WRONG.** Craig's tz IS correctly resolved (`America/Chicago, 09:00-17:00`, line 527); home is Israel. But the model renders Boston/home/Craig itself and mis-offsets: Israel↔Boston as **8h (winter) not 7h (summer/EDT)** → "7:45 AM Boston" for a slot that's actually 08:45; Craig as Boston **+1 not −1** in turn 1 (said 8:45, real 6:45). The tool returns instants (+ away_tz tag when WE fires) but **not pre-rendered per-zone clock strings**, so the model does the arithmetic and gets DST wrong. Fix direction: surface deterministic `renderClockInZone` strings for the owner-away tz AND each attendee tz; prompt: read them, never compute.

**Bug 3 — "nothing opened up Tue–Thu" was FALSE.** The Mon–Thu search (line 555) returned 20 slots **including Tuesday** (06-30T15:00 Israel = 08:00 Boston); the model said "all Monday, nothing Tue-Thu." Per-day searches (lines 580, 606) confirm Tue AND Wed have slots; the owner caught it ("Wednesday is more free than all"). Root: with no WE day-alignment, the spread-picker orders by **Israel** time and the model groups by **Israel** days — a "Monday Boston" slot bleeds into Tue-Israel, front-loading Monday and making Tue–Thu look empty.

**Bug 4 — "in Boston all of next week" + offered Sunday.** Markers are Mon/Tue/Thu only — **not Sunday Jun 28**. So "all week" over-claims and offering Sunday-Boston slots is wrong ("Not Sunday"). Also: the owner works Sun–Thu in Israel but the trip is Mon–Fri — Sunday got offered on the Israeli work-week while he's in Boston (the WE work-DAYS question, ties to decision #1/#2).

**Bug 5 — lunch & existing-meeting clocks wrong (turn 5).** "Drive & Lunch 6:30 PM home (1:30 PM Boston)" — 2h apart; "Catch up with Craig 6:00 PM Boston (23:00 home)" — 6 PM Boston is 1 AM home, not 23:00. Same model-tz-arithmetic root as Bug 2.

**The thread:** Bug 1 is the keystone — home slots → the model improvises the Boston framing with self-computed wrong timezones (2/4/5) and mis-grouped days (3). The owner will **add more bugs on top** — fold them in. Then propose fixes (code-first, at the chokepoint), and `trace` to 100% before declaring anything done. Nothing is committed for these yet.
