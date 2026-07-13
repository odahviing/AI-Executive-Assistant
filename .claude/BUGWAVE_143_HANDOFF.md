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

## Version
Pre-wave HEAD 0db1584 = 3.7.1. Wrap #1 → likely 3.7.2. Wrap #2 (#143) → 3.7.3 or a minor.
