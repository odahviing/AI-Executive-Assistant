# Meeting-agent chat — START HERE (handoff, 2026-06-28 · v3.5.4)

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

## 4. START HERE — current state (v3.5.4) + the parked bugs

The Craig incident (2026-06-25) is **resolved and shipped in 3.5.4**. What that taught us and what's still open:

### Shipped in 3.5.4 (this is now live — don't re-derive it)
- **The keystone was NEVER "search doesn't engage WE."** WE detection always fired; the slots came back correct Boston-band — the log just couldn't show it (`firstSlots` logs `{start,end}` only, and WE slots emit in owner-tz ISO with the tz as a separate `away_tz` tag). The real keystone was **the model doing its own tz arithmetic** because the tool shipped `away_tz` as a raw string with no pre-rendered clock. Fixed: every WE slot carries `away_local_display`, the create/move confirm carries `_trip_time_display`; prompt says quote, never compute.
- **`pickSpreadSlots` rewritten** to round-robin by **away-tz day**, target 5 (diversity first, then deepen); the chronological 30-cap removed. Killed "all Monday, nothing Tue–Thu."
- **WE offer-window is config** (`meetings.working_elsewhere`, regular vs relaxed days+hours, trip-tz; work-week + 09–17/08–20 fallback). The owner's set: regular Mon–Fri 09–17, relaxed Sun–Fri 08–20. WE is display + offer-window + approval-routing **only** — it must NEVER bind a time.
- **THE 7-HOUR DRIFT ROOT (the big one):** `normalizeForGraph` parsed a zoneless datetime in the SERVER's local tz. Maelle runs on the owner's laptop, which is on the **travel zone** while away — so a canonical "10:00" became 10:00 US-East → 17:00 Israel. **It was NOT the WE framework** (the owner's instinct was right). Fixed at the one chokepoint + a naive-parse sweep (`checkSlot`, `planMeeting`). **Lesson for next-you: any "WE timezone" symptom — check the naive-parse-in-server-tz class FIRST, not the WE markers.**
- Flight-anchor (`start_at_event_end_id` + `getEventEndInstant`), colleague free/busy backstop (owner-only fallback — rule 6), `update_meeting` location.

### Parked — meeting core, proposed-not-built (pick these up)
1. **`move_meeting` location.** Two parts: (a) add explicit `location`/`is_online` to move (mirror `update_meeting` — small); (b) **stop the move re-stamping location → "Huddle" on a day-type change** ([ops.ts ~4560](src/skills/meetings/ops.ts) `movePlanLocation`), which WIPES a custom venue on a pure time-move (the "Going out → Huddle" incident, 2026-06-28). Part (b) has a tradeoff (drops the auto Office↔Huddle flip) — owner leaned toward preserve; get his nod.
2. **Double-create hardening (defense-in-depth; the tz fix already removes the live trigger).** (a) `findDuplicateEvent` drift-robust: it fetches the whole probe day — match subject-on-day and loosen the ±2min gate (recommended: exact-match first, else the lone same-subject event that day; don't dedup when ≥2 deliberate same-subject events). (b) `created_but_drift` ([ops.ts ~3248](src/skills/meetings/ops.ts)) must RETURN the created event's `meeting_id` + a "reconcile, don't re-create" note. Owner fork: one-shot ask (recommended) vs automatic. Reachable because Module D now runs a full orchestrator turn on colleague approvals.

### Routed OUT (not meeting-core — paste-blocks were handed to the owner)
- **Prompt/tenancy:** `requester_is_attending=false` when the requester is organizing for a candidate (Yael-set interview treated her as the attendee); non-owner path must never demand an attendee email (external = uncheckable) — suggest from owner availability + annotate.
- **Guard:** the `update_meeting` tool-summary the claim-checker reads (`[update_meeting OK <old subject>]`) doesn't reflect what changed (rename/location), so a TRUE "renamed/updated" claim gets rewritten to a false "hasn't gone through" (HubSpot rename + Bosworth incidents). Plus the `created_but_drift`-retry double-create defense.

### Other parked (cross-cutting / lower)
- **Shadow-DM duplicate:** `shadowNotify`'s thread anchor is an in-memory `Map` (lost on restart) → duplicate "Conversation with X" owner-DM threads after a restart. Fix: persist the anchor (DB), optionally key per person.
- **`get_calendar` "0 events" note:** the model logged `0 events` for full days in two incidents though the fetch works (verified single-day returns events) — likely a model-summary artifact; add a definitive log if it recurs.
- **Google-Maps-link → venue:** Maelle can't resolve a maps short-link to a venue (needs the name typed). Venue-resolver feature.

Discipline unchanged: reproduce from the log, root-cause to `file:line`, fix at the chokepoint code-first, `trace` to 100%, propose-first (build only on an explicit "build it").
