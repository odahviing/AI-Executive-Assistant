# Oversized-file split proposals

> Propose-only. Behavior-preserving refactors — none applied. Snapshot v3.7.3.
> **Golden rule:** do ONE file at a time, `tsc --noEmit` after each, then run `/trace` on the touched flow. Moving 1,000+ lines out of a class risks subtle breakage (shared `this`, closed-over locals, import cycles) — the work is *threading context explicitly*, not the cut itself.

## Files over 1,000 LOC (10)

| LOC | File | Split priority |
|---:|---|---|
| 5,712 | `skills/meetings/ops.ts` | **1 — worst, named by owner** |
| 2,778 | `skills/calendarHealth.ts` | 4 |
| 2,600 | `core/orchestrator/index.ts` | 5 — hardest (one giant fn) |
| 2,458 | `connectors/slack/app.ts` | **2 — splits cleanest** |
| 2,325 | `connectors/graph/calendar.ts` | 3 |
| 1,417 | `skills/summary.ts` | tier-2 |
| 1,249 | `skills/meetings.ts` | tier-2 (mostly tool defs) |
| 1,164 | `db/people.ts` | tier-2 (cohesive DAL) |
| 1,157 | `tasks/skill.ts` | tier-2 |
| 1,115 | `core/assistant.ts` | tier-2 |

---

## ⚡ Quick win first (do this before any big split)
**`ops.ts` — extract the triplicated violation-label switch.** The identical `case 'outside_owner_work_hours': return …` humanizer is copy-pasted at **lines 1822, 3138, 4745** (inside find_available_slots, create_meeting, move_meeting). Extract to one `humanizeViolationLabel(kind, ownerFirst): string` in `ops/violationLabels.ts`. Kills ~2×40 lines of dup, isolated, near-zero risk, and it's the same shape you'll reuse when the big cases move out.

---

## 1. `ops.ts` (5,712) → `skills/meetings/ops/` (~6 modules)
It's `class SchedulingSkill` + a giant `executeToolCall` switch + calendar-analysis fns on top. Keep `ops.ts` as the **thin class shell** (constructor + `executeToolCall` dispatch that delegates each case to an imported `handleX(args, ctx)` function).

| New file | Contents | ~LOC | Source lines |
|---|---|---:|---|
| `ops/analysis.ts` | `processCalendarEvents`, `analyzeCalendar` + helpers (`parseGraphDateTime`, `isOtherPersonsAllDayEvent`, `enrichUnresolvedInternal`) | 630 | 161–790 |
| `ops/findSlots.ts` | `find_available_slots` handler | 1,300 | 1317–2617 |
| `ops/createMeeting.ts` | `create_meeting` handler | 1,470 | 2618–4086 |
| `ops/moveMeeting.ts` | `move_meeting` + `update_meeting` handlers | 1,350 | 4087–5445 |
| `ops/calendarReads.ts` | small cases: `hold_slot`, `get_calendar`, `revert_last_auto_move`, `set/get_work_schedule_override`, `analyze_calendar`, `get_free_busy`, `delete_meeting` | 1,000 | 790–1316 + 5446–end |
| `ops/violationLabels.ts` + `ops/shared.ts` | the dedup helper + `formatIsoTime`, `computeVacatedSlot`, `buildOutOfHoursBusy` | 250 | 25–160 |

Result: `ops.ts` shell ~300 LOC, nothing else over ~1,500. **The real work:** each case closes over `ctx`, `profile`, `this.*` — every extracted handler needs an explicit params object. Do `analysis.ts` + `violationLabels.ts` first (pure, safe), then one big case at a time.

## 2. `app.ts` (2,458) → `connectors/slack/app/` — **cleanest split, do early**
Independent event handlers = natural modules. Keep `app.ts` as the wiring shell (`createSlackAppForProfile` registers imported handlers).

- `app/messageProcessor.ts` — the shared message processor + reply-pipeline block (238–900)
- `app/fileIngestion.ts` — image `file_share` + shared file-ingestion primitives (901–1210)
- `app/handlers/dm.ts` (1211), `mpim.ts` (1503), `reactions.ts` (1829), `channel.ts` / app_mention (1969) — the 4 handlers
- `app/watchdog.ts` — `startSocketWatchdog` (2347) + `sendProactiveMessage` (2436)

Low risk: handlers already communicate through explicit args + the DB, not shared locals.

## 3. `calendar.ts` (2,325) → `connectors/graph/`
Keep `calendar.ts` as a barrel re-export so no import churn elsewhere.
- `graph/client.ts` — auth, `getClient`, types (12–134)
- `graph/reads.ts` — `getCalendarEvents`, `getFreeBusy`, `findDuplicateEvent`, `findReschedulableSibling`, the `getEvent*` getters + verifiers
- `graph/slots.ts` — `findAvailableSlots` (626–1770, ~1,150) + `pickSpreadSlots` + slot-rule helpers
- `graph/mutations.ts` — `createMeeting`, `updateMeeting`, `deleteMeeting`, `normalizeForGraph`

## 4. `calendarHealth.ts` (2,778) → `skills/calendarHealth/`
`class CalendarHealthSkill`; the `check_calendar_health` case is the monster (~1,280 LOC).
- `calendarHealth/checkHealth.ts` — the `check_calendar_health` auto-fix loop (699–1979: missing blocks / double-bookings / dead-gaps / OOF / categories / busy-day)
- `calendarHealth/autoMove.ts` — `executeInternalAutoMove` + `pullInternalMeetingToAbut` (206–618)
- `calendarHealth/floatingBlockOps.ts` — `book_floating_block` (1979–2469)
- `calendarHealth/categoryOps.ts` — `classifyEventCategory` + `set_event_category` + `manage_calendar_issue`
- shell keeps `manage_working_elsewhere` + dispatch

## 5. `orchestrator/index.ts` (2,600) — hardest, do last
`runOrchestratorImpl` is one ~1,200-line function (434→1600+). Lower-hanging fruit first:
- `orchestrator/turnHelpers.ts` — pull the pure helpers `callClaude`, `trimHistory`, `mutationOutcome`, `summarizeToolCall`, `extractActionTape`, `stampHistoryTime` (23–420, ~250 LOC). Safe.
- Then extract phases of `runOrchestratorImpl` into named helpers: the colleague idempotency/rate-limit guards (1606–1690), tool-result post-processing, prompt assembly. Medium risk (shared turn state) — extract to a `TurnState` object passed by reference.

## Tier-2 (1,000–1,500 — big but not urgent)
- **`meetings.ts` (1,249)** — mostly verbose `getTools()` tool-definitions + `getSystemPromptSection`. Move the tool JSON to `meetings/toolDefs.ts`; the file becomes wiring + prompt. Declarative, low risk.
- **`summary.ts` (1,417)** — split the 3-stage state machine (Drafting / Iterating / Sharing) into per-stage modules; `ingestTranscriptUpload` separate.
- **`tasks/skill.ts` (1,157)** — split the approval tools (`create_approval`/`resolve_approval`/`list_pending_approvals`) from the task tools (`create_task`/`get_my_tasks`/briefing).
- **`people.ts` (1,164)** / **`assistant.ts` (1,115)** — cohesive DALs/skills; split reads vs writes only if they keep growing. Lowest priority.

## Suggested order
1. `ops.ts` violation-label dedup (quick win) → 2. `app.ts` (clean) → 3. `calendar.ts` → 4. `ops.ts` big-case extractions → 5. `calendarHealth.ts` → 6. `orchestrator/index.ts`. Tier-2 opportunistically.
