# Bug-wave + #143 process handoff (2026-07-14)

Owner authorized a 6-step marathon. This file tracks state so a fresh chat can resume.

## The 6-step process (owner-authorized)
1. **Build 140c** — vague auto-fix shadow message names the conflicting event + proposed action. [ops: rebalanceFloatingBlocks.ts ~:351]
2. **Verify ALL bugs 100%** — all other chats finished (except 137a). Trace today's REAL incidents (logs/transcripts) against code on disk, per bug, this-chat + other-chats. Demand 100%. Check **137a LAST** (not finished yet — may need to complete it myself).
3. **Wrap #1** — patch version bump for the bug wave; CHANGELOG + memory/files per WRAP_UP.md.
4. **Fix 137 root** (Graph `ErrorInvalidMergedFreeBusyInterval`). If clearly zero-impact → fix; else raise to owner.
5. **Build #143 in full** (phased ok, finish all) + **DELETE the full-day WE spine** (keep the timed/optional-join event WE — only remove the all-day travel-marker spine). Requirements below.
6. **Wrap #2** — after #143 trace 100% + WE removed: CHANGELOG + README + patch bump + **update SESSION_STARTER** (new chat likely).

## #143 design (unified WE model — owner confirmed direction)
One per-date record is the single input; YAML is the default; a date-record wins; no record → YAML (fail-safe).
```
owner_schedule_overrides  PK(owner_slack_id, date)
  is_workday · windows(JSON) · location('office'|'home') · timezone(IANA, optional)
```
- **Home-tz day** (no timezone): "Monday night", "office Tuesday", "off Wednesday" → normal walk + checkSlot, direct book. Fixes #141c.
- **Stated-hours travel day** (timezone set): "Boston 9-5 EST" → treat as a NORMAL work day in that zone: search rule-walks it with the stated windows, checkSlot validates (allowRelaxed=FALSE), **books directly (NO forced approval/confirm)**, weTimeResolver renders dual-clock. The forced approval existed only because hours were unknown — stated hours remove it.
- **OWNER CLARIFICATIONS (2026-07-14):**
  - **No floating blocks on ANY override day** (skip lunch/gym/etc.). Simple; revisit later.
  - **No timezone stated → use that day's YAML/home timezone** (only an explicit tz changes the zone).
  - **Timezone correctness is a first-class test** (owner burned by WE before).
  - Owner wants to **VIEW overrides** ("ask Maelle about all my overrides").
  - **Test matrix**: booking ON the override date, BEFORE it, AFTER it; how all functions connect.
- **DELETE the full-day WE spine** (all-day travel marker path): weTimeResolver usage for the all-day marker, resolveOwnerTravelContextForDate's marker source, the relax+confirm booking path. KEEP: the timed optional-join WE event (showAs workingElsewhere, non-all-day) — that's a different feature, out of scope. weTimeResolver's dual-clock RENDER is still needed (fed by the override's explicit tz) — verify what can actually be deleted vs kept before ripping.
- Reader reroute (~4 load-bearing): search getWorkHoursForDay (calendar.ts:1138), checkSlot rules 1/5/9 (scheduleRules.ts), resolveLocation.ts:116, classifyDay/walker (calendar.ts:1108/1260). Phase-2: isWithinOwnerWorkHours date-aware (the "is he working now" tail — needed to FULLY close #141).

## Disposition of the run (before this marathon)
BUILT here (uncommitted): 137-trigger (retry), 139b (dismissal memory), Part B (revert tool), 140b (past-window), 142b (duration), 141 Ch1-4 (requester-aware colleague actions).
MOVED (other chats): 137c/140a+138a+138c+141Ch5 (approval), 137a+142a (meeting), 137b (guard).
RESOLVED-as-finding: 139a, 141a (leak fixed by 141 Ch4), 141c (→#143), 138b (skip).
137a = NOT finished (meeting chat) — verify/finish last.

## CURRENT STATE (2026-07-14)
- **Step 1 (140c)** — DONE (rebalanceFloatingBlocks.ts overlap message now names event + window).
- **Step 2 (verify 100%)** — DONE. All today's incidents FIXED + verified vs the log. Two gaps found+closed during verify: **Fix A** = getFreeBusy short-window `availabilityViewInterval` (the REAL #137 root — the 400 was DETERMINISTIC on a 10-min window, so the retry alone was insufficient; windows ≥16min unchanged). **Fix B** = colleagueBookingBlock now passes `includeApprovals:true` (Talia-shaped fixed going forward). 137a completed (error-catch `_deferred_action_hint` + the meeting chat's prompt lever at meetings.ts:312).
- **Step 3 (Wrap #1)** — DONE. **3.7.2 = commit 712abdc, PUSHED to master.** package.json + CHANGELOG done. Memory/README DEFERRED to Wrap #2.
- **Step 4 (fix #137 root)** — DONE (Fix A, folded into 3.7.2).
- **Step 5 (#143 + delete full-day WE spine)** — IN PROGRESS. **Full build spec: [.claude/143_BUILD_SPEC.md]** (deletion inventory + P0-P7 + write-precise code shapes). Deletion-scope investigation DONE.
  - **P0 BUILT** (uncommitted, typecheck clean): `owner_schedule_overrides` table in db/client.ts (idempotent CREATE TABLE) + new `src/db/scheduleOverrides.ts` (sync get/list/upsert[merge]/clear/prune).
  - **P1a BUILT** (uncommitted, typecheck clean): `getEffectiveWorkDay(dateIso, profile) → EffectiveWorkDay` + `EffectiveWorkDay` interface in `src/utils/workHours.ts`. Pure accessor; NO reader rerouted yet, NO WE change yet → zero behavior change so far (safe foundation).
  - **REMAINING**: P1b travel-adapter rewire (workingElsewhere.ts) → P2 write+view tools → P3 reader reroute + tz-thread (calendar.ts/scheduleRules.ts/resolveLocation.ts) → **P4 away-day direct-book (MEETING territory — coordinate)** → P5 WE-spine deletion → P6 floating-gate + isWithinOwnerWorkHours date-aware + residual#3 → P7 trace 100% → Wrap #2. All detail in 143_BUILD_SPEC.md.
- **Step 5 (#143) — COMPLETE + 100% TRACED (uncommitted).** P0-P6 built + verified by tracers; consistency reroutes (category day_type + 5 owner-facing readers) done; **far-west AND far-east tz correctness** via getEffectiveWorkDayForInstant (checks home date + both neighbours) wired into the 5 slot-level consumers; residual #3 + no-floating-on-override + view/set tools all confirmed. Final sign-off trace: 100%, zero regression. Cosmetic-only residual: a category-reject human_explanation may name the home-tz weekday on a rare cross-midnight far-west reject (verdict correct).
- **Step 6 (Wrap #2 + SESSION_STARTER + memory + README)** — IN PROGRESS.

### Verification residuals (beyond today's incidents — NOT regressions)
1. `kind=policy_exception` still printed in the PENDING-APPROVALS LIST block (systemPrompt.ts). **ACCEPTED (owner: not critical) — leave it.**
2. Same-daily-thread + 2+ approvals disambiguation is prompt-dependent (cross-thread incident is hard-gated). Approval-chat hardening, not this run.
3. Booked-then-cancelled meeting within 7d keeps a stale requester-link id → a move attempt pings owner. **FOLD INTO #143 (owner):** getMeetingsRequestedBy must exclude cancelled/deleted meetings — either filter by the backing request/meeting state, or clear/mark the colleague_booking_record's event id on delete (closeMeetingArtifacts / resolveCalendarIssuesForMeeting cascade point). Do it as a #143 build sub-item.
4. Free/busy window ≤5 min still 400s — UNREACHABLE (min duration 10).

### #143 build phases (exact scope pending the WE-deletion investigation)
0. Storage: migration `owner_schedule_overrides` + `db/scheduleOverrides.ts` (sync get/upsert/clear, lazy-prune past).
1. `getEffectiveWorkDay(dateIso, profile) → {isWorkday, windows, location}` in workHours.ts (yaml base + override overlay + fail-safe; SYNC).
2. Reroute readers: search `getWorkHoursForDay` (calendar.ts:1138), `checkSlot` rules 1/5/9 (scheduleRules.ts), `resolveLocation.ts:116`, classifyDay/walker (calendar.ts:1108/1260). Search passes windows into checkSlot via the SAME accessor (consistency guarantee).
3. Away-day DIRECT-book: `resolveOwnerTravelContextForDate` source-0 = override.timezone; search walks the WE day WITH override windows; planMeeting validates (allowRelaxed=FALSE) + NO we_acknowledged confirm when override windows exist; keep weTimeResolver dual-clock render.
4. DELETE the full-day WE spine (per the investigation inventory).
5. `set_work_schedule_override` tool (owner-only, Sonnet-parsed dates; no-tz → yaml/home tz that day; range → N single-date rows) + a VIEW-overrides tool ("ask about all my overrides").
6. NO floating blocks on override days (gate floatingBlocks when an override exists for the day).
7. `isWithinOwnerWorkHours` date-aware variant (the "is he working now" tail — fully closes #141).
8. TRACE to 100%: book ON the override date / BEFORE / AFTER; explicit-tz ("Boston 9-5 EST") + no-tz ("Tue 9-3"); home-tz overrides ("Mon night", "office Tue", "off Wed"); WE-removal regression surface; timezone correctness first-class.
Then **Wrap #2** (CHANGELOG + README + memory + SESSION_STARTER + patch bump; likely 3.7.3).

## Version
Pre-wave HEAD 0db1584 = 3.7.1. Wrap #1 = **3.7.2 (712abdc, shipped)**. Wrap #2 (#143) → 3.7.3 (or minor if #143 warrants).
