# Approval / booking spine — rethink handoff (dedicated chat)

**This chat owns ONE thing: the approval → booking → close-loop spine. Rethink it.** Not the meeting planner (that's a separate agent), not the guards. Read this whole file before touching code.

## Why this chat exists (the mandate)

The approval system was deliberately rebuilt in **v2.7.0 → v2.9.1** (the "requests resolver" replacing the old `approvals` resolver; a universal callback table; the request spine as single source of truth). It was a real design. **It has since regressed back into patch-on-patch** — every version after it bolted on another relay, another hold, another timer, another fuzzy-match to reconnect tracks that the v2.9 design was supposed to have unified. The owner's read: *"we rethought approval in v2.9 but it got broken — find what we did wrong and how to repair it."*

So this chat's job, in order (same discipline as the meeting agent):
1. **Understand the spine by heart** — every state, every booking path, every relay path, every reconcile mechanism, the two state systems. The map below is the starting data; verify it against code (file:line are starting points, not gospel).
2. **Find the ROOT, not the symptoms.** The recurring incidents (Yael, Isaac, Daniel, Eli, Dina) almost all trace to *one missing deterministic link* + *competing parallel paths*. Name it, prove it.
3. **Repair by collapsing, not adding.** The fix is fewer paths and one state object with a hard link — so the reconnect/timer/fuzzy-match layers can be **deleted**. A repair that adds a layer is the wrong repair.

**Standing rules (identical to the meeting agent — see `.claude/MEETING_PLANNER_AGENT.md` "Owner rules 1–14"):** propose-first, never auto-fix, wait for a per-item "fix it." Code-first, root-cause, no patch-on-patch (rule 4). Fix the process, not the guard (rule 5). No dedup/duplicate state (rule 2). No quick-wins that don't fit the arch (rule 9). Leave no dead code (rule 10). Reads (logs, db-query, code) are free; writes need a build signal.

## The owner's model — the TARGET (the correct one)

> When a colleague (Isaac) asks for a meeting and it comes to the owner as an approval, the approval's only job is to **record the DECISION** ("Idan: yes, 11am") and **hand it back to the requesting flow.** That flow — the one that already knows the colleague, owns the slot, and owns telling the colleague — performs the booking and the close-loop. **The approval must NOT book the meeting itself in the owner's chat.**

- Owner-INTERNAL approvals (no `requester_slack_id`) have no flow to return to → they can keep performing the action directly. That path is fine.
- The decision must route back via a **hard link** (an id carried on the approval), not be re-matched after the fact by subject/thread/event-id.

## Current state — the full map (the data, gathered 2026-06-20)

### A. FIVE distinct paths can BOOK a colleague→owner meeting
1. **Direct `create_meeting` (colleague-path), rules pass** — `ops.ts:2345` (v2.3.2 gate) → `createMeeting` `ops.ts:2966` → `closeMeetingArtifacts` `ops.ts:3128`. When rules FAIL it returns an error sentinel + `_deferred_action_hint` telling Sonnet to `create_approval(policy_exception)` → feeds Path 2.
2. **Owner-approve replay** — `resolveRequest` (approve) `resolver.ts:482` → `runApproveCallback` `resolver.ts:518` → injects `relaxed=true` `:556` → `runDeferredAction` `:582` → `deferredActionReplay.ts:99` re-runs `create_meeting`/`move_meeting`/`update_meeting` **as owner** → `createMeeting`. (v2.7.2 "redirect-token" auto-attach of `deferred_action` in `orchestrator/index.ts:1757`.)
3. **slot_pick / calendar_conflict approve** — `resolver.ts:429` → `resolveSlotPickApproval` `:633` → freshness recheck `recheckOwnerFreeForBooking` `:154` (the "Isaac incident" comment) → `getCoordBookingHandler()` `:718` → `forceBookCoordinationByOwner` (`coord/booking.ts:673`) → `bookCoordination` `:142`. (v2.9.1 carved slot_pick out of Path 2: *"those paths predate the callback model and run the booking themselves"* `resolver.ts:426`.)
4. **`finalize_coord_meeting`** (owner force-book, no approval) — `meetings.ts:1524` → `forceBookCoordinationByOwner` → `bookCoordination`. Same terminal as Path 3.
5. **Autonomous coord book** — last colleague reply completes consensus → coord state machine → `bookCoordination`. The `#65` comment (`coord/booking.ts:396`) is direct evidence of Path-1-vs-Path-5 competition (*"a direct create_meeting can already have booked this slot"*).

**The only thing preventing a literal double-book when two paths fire is `findDuplicateEvent` (subject + start ±tolerance)** — not attendee-aware, not event-id-aware (`ops.ts:2761`, `coord/booking.ts:401`).

### B. SEVEN paths can TELL the requester the outcome (4 say "booked/yes")
1. `notifyRequesterOfDecision` (resolver) `resolver.ts:797` — stamps `requester_notified_at` (ok-checked, terminal only). **Skips coord + slot_pick** (`:820`/`:824` — "coordinator loop-close owns it").
2. `closeMeetingArtifacts` (booking-side) `closeMeetingArtifacts.ts:295` — **now** awaited + stamps-on-ok only (v3.4.5 Yael/Eve fix — SHIPPED, see "Already shipped").
3. coord `bookCoordination` requester notify `coord/booking.ts:566` — **never touches `requester_notified_at`** (interlock blind spot).
4. `runExpiry` `runner.ts:159` — reads flag, never writes.
5. `runApprovalActionTimeout` (4h grace) `runner.ts:221` — reads, never writes.
6. brief auto-park `briefs.ts:886` — reads, never writes.
0. `message_colleague` (manual Sonnet relay) `outreach.ts:153` — **never touches the flag** (wildcard double-DM source).

**Interlock (`requester_notified_at`) is written by only 2 of 7 (Paths 1, 2), read by 5, ignored by 2 (coord + manual).** The coord/slot_pick world and the manual world are entirely outside it → drop/double-DM blind spots.

### C. TWO state systems for one decision
- The `requests` spine is canonical; `coord_jobs.status` is vestigial (`db/jobs.ts:4-18`, the v3.1 "Path 2" migration).
- **BUT** the coord-reply owner-decision readback **still runs on the legacy `approvals` table** keyed by `coord_job_id` — `getPendingApprovalsBySkillRef(job.id)` + `setApprovalDecision(...)` (`coord/reply.ts:300,332`), synced to the spine only by `updateCoordJob`'s terminal cascade (`db/jobs.ts:611-654`). **Two state objects for one coord decision** — a candidate deepest root (the v2.9 migration didn't finish here).

### D. TWELVE reconcile / hold / timer / fuzzy-match mechanisms (the papering-over layer)
`holdForFulfillingAction` + `in_flight` hold (`resolver.ts:104`, v3.4.2) · `approval_action_timeout` 4h timer (`runner.ts:199`) · `closeMeetingArtifacts` thread-match (`:242`, Dina) · exact-subject fallback (`:281`, v3.0.7) · `reconcileOrphanedRequests` (`reconcile.ts:44`) · `pruneOldTerminalRequests` (`reconcile.ts:145`) · `cleanupVanishedMeetingArtifacts` (`:115`) · `updateCoordJob` mid-state cascade (`db/jobs.ts:582`) · terminal cascade + sibling-outreach close (`:611`) · `runCoordAbandon` timer clear (`runner.ts:599`) · idempotency-key + LLM dedup judge (`tasks/skill.ts:565`) · `requester_notified_at` single-notification flag (v3.1 115a/b).

### E. THE ROOT SEAM (what all 12 mechanisms paper over)
**At approve time, nothing stamps a shared id linking the approval to the booking that will fulfill it.** Approve and book are separate events on separate tracks. So the connection is *reconstructed after the fact* by `closeMeetingArtifacts`'s **4-tier fuzzy match** (event-id → details-id → thread-ts → exact-subject), backstopped by a **4-hour grace timer**, with the retrofitted `requester_notified_at` flag trying to keep the multiple relays from colliding. Every named incident is this one seam hit from a different angle.

## What v2.9 built — and where it regressed
- **v2.7.0–v2.9.1 (the rebuild):** requests spine as single source of truth; universal `on_approve`/`on_reject`/`on_amend` callback table (`resolver.ts:232`); `resolveRequest` dispatches uniformly. *Intent: one spine, one resolution path.*
- **Where it broke down:**
  1. **slot_pick/calendar_conflict were carved OUT** of the universal model and kept their bespoke coord booking (`resolver.ts:426`) — so the "uniform" resolver immediately had two regimes.
  2. **The coord-reply decision readback never migrated** off the legacy `approvals` table (`coord/reply.ts:300,332`) — dual state.
  3. **Approve and book stayed separate events with no shared id** — so v3.4.2 had to add the `holdForFulfillingAction` bridge + 4h timer + fuzzy reconnect to glue them. That bridge is the clearest "we re-broke it" layer.
  4. **Relays multiplied** (2.8.6 → 3.0.7 → 3.4.2) and the `requester_notified_at` interlock (3.1) only covers 2 of them.

## The proven incidents (root = the seam above)
- **Yael/Eve relay drop (6/18→6/20):** colleague policy_exception, owner amended → `awaiting_colleague`, requester never told. Two causes: (a) `closeMeetingArtifacts` stamped `requester_notified_at` fire-and-forget → resolver saw the stamp → "already notified, shadow-only" → real relay never sent (**fixed in v3.4.5**); (b) the LLM-dedup swallowed the re-raise (`create_approval — LLM dedup matched existing`). Request was manually cancelled 6/20.
- **Isaac desync (6/19):** booked on the owner side while the colleague coord track stayed "11:30, waiting for Idan" — no coord-job-by-participant link in the booking path.
- **Daniel "never heard booked":** owner-approve-with-no-callback orphaned the later booking → motivated `holdForFulfillingAction`.
- **Eli ghost:** owner reject on an `awaiting_colleague` row mis-read as colleague-rejected → bounce instead of close → fixed by the actor-vs-state gate (`resolver.ts:42`, `resolvedByColleague`).

## Candidate repair directions (propose-first — THIS chat decides the shape)
Not prescriptive. The data points at a **spine collapse**:
- **One booking path.** Collapse Paths 1–5 to a single `bookMeeting` core that every entry (direct, approve-replay, coord, finalize) calls — so dedup/relay/state are done once. (Note: the meeting agent declined a *forced* wrapper earlier because the real dup was elsewhere; revisit with the spine in view.)
- **One relay.** One close-loop sender keyed on `requester_notified_at`; delete the parallel relays or make them all route through it. Bring coord (Path 3) and slot_pick into the interlock.
- **One state object.** Finish the v2.9 migration: kill the legacy `approvals` table for coord-reply readback; the `requests` spine owns the decision.
- **Hard approve→book link.** Stamp the originating request/coord id on the approval and the booking at approve time, so the decision routes back deterministically — then **delete** the 4-tier fuzzy match + the 4h timer + `holdForFulfillingAction` + half of section D.
- **Owner-internal approvals keep the direct replay** (no flow to return to).

The test for the repair: *does it let us DELETE mechanisms from section D, or does it add a 13th?*

## Already shipped — do NOT redo
- **v3.4.5 relay-drop fix:** `closeMeetingArtifacts` is now async, awaits the requester DM, stamps `requester_notified_at` **only on confirmed ok send**; on failure leaves it unset so the resolver does the real relay. Awaited at all 6 call sites → no double-DM race. (This was the standalone quick-win; the architecture is still open.)
- **v3.4.5 relay diagnostics:** `notifyRequesterOfDecision` logs entry + every early-return + send result — the next amend relay is fully provable from the log.

## Key files
`src/core/requests/resolver.ts` (resolveRequest, runApproveCallback, resolveSlotPickApproval, notifyRequesterOfDecision, holdForFulfillingAction) · `src/core/requests/deferredActionReplay.ts` · `src/core/requests/runner.ts` (timers) · `src/core/requests/reconcile.ts` · `src/utils/closeMeetingArtifacts.ts` · `src/skills/meetings/coord/booking.ts` + `coord/reply.ts` + `coord/state.ts` · `src/db/requests.ts` + `src/db/jobs.ts` (the spine + the vestigial coord_jobs + linkage) · the legacy `approvals` table (`db/approvals.ts`, still live for coord-reply) · `src/tasks/skill.ts` (create_approval, idempotency/dedup).

## Routing (four agents share the tree)
This = **approval chat**. Meeting agent owns the planner's deterministic core (search/book/validate). Guard agent owns the gate stack. Prompt agent owns the orchestrator system prompt. At wrap, `git fetch` + working-tree diff to reconcile.
