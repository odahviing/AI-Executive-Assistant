# #143 build spec — unified per-date schedule override + delete full-day WE spine

Owner-approved. Model: ONE per-date record `{is_workday, windows, location, timezone}`. YAML default → date-record wins → no record = YAML (fail-safe). Timezone-bearing record ⇒ **away day, rule-walked + validated in that zone, books DIRECTLY (no forced approval)**. No timezone ⇒ home tz that day. **No floating blocks on ANY override day.** `weTimeResolver` KEPT (dual-clock + stated-time, now fed override-derived context). Timed optional-join WE event KEPT (separate feature). Only capability retired: Outlook all-day-marker / `currently_traveling` away-detection for the OWNER → replaced by chat override.

## Deletion inventory (delete/keep/rewire)
- `weTimeResolver.ts` — **KEEP ENTIRELY** (resolveStatedInstant, renderWeDualClock, ABBREV_TO_IANA). Still resolves a bare/named clock on a tz-override day + renders dual-clock; now fed an `OwnerTravelContext` derived from the override table.
- `workingElsewhere.ts`:
  - `detectWorkingElsewhereDays:46` → **DELETE** (all-day-marker only).
  - `resolveWorkingElsewhereTz:217` → **DELETE** (location→IANA inference; override stores explicit IANA).
  - `getWeWindow`+`WeWindow:290` → **DELETE** (offer band; tentative path gone).
  - `computeTentativeWeSlots`+`TentativeSlot:321` → **DELETE**.
  - `resolveOwnerTravelContextForDate:144` → **REWIRE**: read override table only (drop marker step 151-156 + record step 161-171); becomes **sync**; drop `events` param, take `profile`; return same `OwnerTravelContext` (thin adapter over getEffectiveWorkDay).
  - `getTravelContextForInstant:184` → **REWIRE/SIMPLIFY** (no Graph fetch; resolve override for the instant's day; keep signature usable by ops/approval).
  - `detectOwnerAwayDaysInWindow:86` → **REWIRE** (list override rows with a timezone over the window via `listScheduleOverrides`; keep return `Map<date,{date,location}>`).
  - `summarizeWorkingElsewhere:241` → **REWIRE** (away-note from override rows, explicit tz).
  - `OwnerTravelContext:36`, `WorkingElsewhereDay:138` types → **KEEP**.
- `weConfirmStash.ts` + `we_acknowledged` arg → **DELETE** (dead once away-days direct-book). KEEP `stated_zone`/`start_timezone` args.
- `calendar.ts`: `detectOwnerAwayDaysInWindow` call:1006 → REWIRE; **WE-day skip in walk ~1260 → DELETE** (walk normally with effectiveDay windows in effectiveDay.timezone); **tentative away path 1490-1543 → DELETE**; `getWorkHoursForDay:1138-1160` → REWIRE to `getEffectiveWorkDay(dayKey,profile).windows` + thread `.timezone`.
- `planMeeting.ts`: **DELETE the WE branch 392-443** (onWorkingElsewhereDay relax+confirm); line **454** → `allowRelaxed: !!input.allowRelaxed` (drop `|| onWorkingElsewhereDay`); pass resolved effectiveDay into checkSlot.
- `availabilityPreCheck.ts`: **DELETE the isAway short-circuit 418-424** (`bookable:false`) → away slots flow into normal checkSlot fed override windows/tz.
- `ops.ts`: create (2578-2600), move (4278-4300), duplicate-check (4172), booked dual-clock (3243/3907/5205) → KEEP (travel object now override-derived); `summarizeWorkingElsewhere` calls (912/1137/1178) → KEEP (rewired).
- `orchestrator/index.ts:1186` → REWIRE detectOwnerAwayDaysInWindow → override away-days; keep the `## OWNER LOCATION` block.
- `calendarHealth.ts:1010` → REWIRE weActiveDays → override-day set; keep suppressor:1013 (floating-block skip on override days).
- `approvalCallbacks.ts:146-160` + `resolver.ts:960` + `tasks/skill.ts:785` → KEEP (getTravelContextForInstant override-sourced).
- **Marker/`currently_traveling` for OWNER**: resolver stops reading them. **`currently_traveling` STAYS for COLLEAGUES** (`attendeeAvailability.ts:127`, `attendeeMode.ts` — untouched).
- **Timed optional-join WE (KEEP, verify untouched)**: `scheduleRules.ts:309/425/489` + `calendar.ts:985-992 softOccupied` — inline `!isAllDay && showAs==='workingElsewhere'`, no deleted-fn calls. Leave as-is.

## Breaks-if-deleted (runtime, must-change-or-regress)
1. calendar.ts:1260 skip → if not deleted, override away-day yields no slots.
2. planMeeting.ts:454 `|| onWorkingElsewhereDay` → if not flipped false, away days bypass ALL rules (opposite of "validate normally").
3. availabilityPreCheck.ts:421 `bookable:false` → if not deleted, colleague pre-check refuses every away-day slot.
4. calendarHealth.ts:1013 suppressor → if weActiveDays not rewired, floating-block auto-book fires on override days.
5. orchestrator/index.ts:1186 → if not rewired, OWNER LOCATION block vanishes (loses grounding).

## Phases (ordered)
- **P0 Storage**: `CREATE TABLE IF NOT EXISTS owner_schedule_overrides` in db/client.ts boot (idempotent, like the other tables) + new `src/db/scheduleOverrides.ts` (sync helpers). (No separate migration file needed for a fresh table.)
- **P1 Accessor + travel-adapter rewire**: `getEffectiveWorkDay` in workHours.ts; rewire resolveOwnerTravelContextForDate/getTravelContextForInstant/detectOwnerAwayDaysInWindow to derive from getEffectiveWorkDay/listScheduleOverrides; delete detectWorkingElsewhereDays.
- **P2 Write + view tools** (early, so P3-P4 testable): `set_work_schedule_override` + `get_work_schedule_overrides` in meetings.ts getTools + ops.ts handler. Owner-only (not in COLLEAGUE_ALLOWED_TOOLS + senderRole gate).
- **P3 Reader reroute (home-tz axis) + tz-thread**: resolve `effectiveDay` once/day, thread into calendar.ts:1138 getWorkHoursForDay (+ minute-of-day in effectiveDay.timezone), scheduleRules checkSlot rules 1/5/9, resolveLocation.ts:116, classifyDay:1108 + walker:1265. **Consistency: search + checkSlot both derive effectiveDay from the SAME getEffectiveWorkDay(date) + evaluate in effectiveDay.timezone; search passes effectiveDay into checkSlot (add to RuleCheckInput, replaces workHourWindowsOverride). No override → home tz + YAML windows → byte-identical to today.**
- **P4 Away-day direct-book** (MEETING-AGENT territory — coordinate): delete calendar.ts:1260 skip + 1490-1543 tentative; delete planMeeting.ts:392-443 + flip :454; delete availabilityPreCheck.ts:418-424. Away days walk+validate via P3 tz-threaded path + book directly; resolveStatedInstant/renderWeDualClock render dual-clock.
- **P5 WE-spine deletion**: delete the DELETE-tagged symbols; delete weConfirmStash.ts + we_acknowledged; rewire summarizeWorkingElsewhere. `meetings.working_elsewhere` yaml block becomes unread (leave or remove — owner call).
- **P6 Floating gate + tails**: no-floating on override days via `effectiveDay.hasOverride` at checkSlot rule 6 (:278), calendarHealth suppressor (:1013), rebalanceFloatingBlocks, book_floating_block handler. Make isWithinOwnerWorkHours/nextOwnerWorkdayStart (workHours.ts:134,247) date-aware (the #141 "is he working now" tail). **Residual #3 fold-in**: getMeetingsRequestedBy exclude cancelled/deleted meetings (clear/mark the colleague_booking_record on delete, or filter by state).
- **P7 Trace to 100%** (`trace` skill): (a) no record = identical to today; (b) #141 home-tz night window; (c) office↔home flip; (d) off-day; (e) Boston 9-5 EST (search EST, checkSlot EST, direct book, dual-clock, DST-mid-window, colleague pre-check bookable); (f) search==checkSlot verdict on same away slot; (g) no floating on override days; (h) view-overrides lists rows. TZ correctness first-class.
- **Wrap #2**: CHANGELOG + README + memory (project_architecture: revert tool, dismissal memory, getMeetingsRequestedBy, the override subsystem, WE-spine deletion) + SESSION_STARTER + patch bump (→ 3.7.3, or minor if warranted).

## Migration + scheduleOverrides.ts + getEffectiveWorkDay (write-precise)
```sql
CREATE TABLE IF NOT EXISTS owner_schedule_overrides (
  owner_slack_id TEXT NOT NULL,
  date           TEXT NOT NULL,   -- yyyy-MM-dd, owner home tz
  is_workday     INTEGER,         -- null=keep base · 0=off · 1=on
  windows        TEXT,            -- JSON ["09:00-17:00", ...] · null=keep base
  location       TEXT,            -- 'office'|'home' · null=keep base
  timezone       TEXT,            -- IANA · presence ⇒ away day · null=home tz
  source         TEXT NOT NULL DEFAULT 'chat',
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_slack_id, date)
);
```
```ts
// src/db/scheduleOverrides.ts  (all sync — better-sqlite3, like getTravelRecord)
export interface ScheduleOverride { date; isWorkday:boolean|null; windows:string[]|null;
  location:'office'|'home'|null; timezone:string|null; source:string; note:string|null; created_at:string }
getScheduleOverride(ownerSlackId, dateIso): ScheduleOverride|null   // lazy-prune date<today → delete+null (mirror getTravelRecord:222)
upsertScheduleOverride(ownerSlackId, o): void                       // INSERT..ON CONFLICT(owner,date) DO UPDATE
clearScheduleOverride(ownerSlackId, dateIso): void
listScheduleOverrides(ownerSlackId, fromIso?, toIso?): ScheduleOverride[]
```
```ts
// src/utils/workHours.ts
export interface EffectiveWorkDay { isWorkday:boolean; windows:WorkHourRange[]; location:'office'|'home'|'elsewhere';
  timezone:string; isAway:boolean; hasOverride:boolean; source:'yaml'|'override' }
export function getEffectiveWorkDay(dateIso, profile): EffectiveWorkDay
//  homeTz=profile.user.timezone; dayName from dateIso@homeTz
//  base = getOwnerWorkHoursForDay(profile,dayName) + office/home sets
//  row = getScheduleOverride(profile.user.slack_user_id, dateIso)  (try/catch → base on error)
//  tz = row?.timezone ?? homeTz            ← "no tz → home tz that day"
//  windows = row?.windows ? parse : baseWindows
//  isWorkday = row?.isWorkday ?? (windows.length>0 || baseIsWorkday)   (off:false forces off)
//  location = row?.location ?? (row?.timezone ? 'elsewhere' : baseLoc)
//  isAway = tz!==homeTz ; hasOverride = !!row ; source = row?'override':'yaml'
```
Thread into checkSlot: add `effectiveDay?: EffectiveWorkDay` to RuleCheckInput (replaces `workHourWindowsOverride`); absent → checkSlot resolves via getEffectiveWorkDay(slotDate,profile).

**Write tool** `set_work_schedule_override` args (Sonnet-parsed, NO NL regex; dates from prompt DATE-LOOKUP; hours composed from base hours at meetings.ts:799): `{date_from, date_to?, off?, hours?, location?, timezone?, note?, clear?}`. Range → N single-date rows. Emit `_slot_results_now_stale` (assistant.ts:1098). **View tool** `get_work_schedule_overrides` → listScheduleOverrides(today→future).

## Ownership
P0-P3, P5-P7 = main chat. **P4 (planMeeting/availabilityPreCheck/calendar.ts away edits + ops.ts travel-source rewire) = Meeting-agent territory — coordinate that slice** (SESSION_STARTER: WE/timezone → meeting).

## WE health note
Spine is WORKING (3.6.0 traced 11/11, extended 3.6.5, no WE regression in 3.7.0/3.7.1). This deletion is a deliberate simplification, not a rescue; it *reduces* residual model-tagging (explicit stored IANA vs location-string inference).
