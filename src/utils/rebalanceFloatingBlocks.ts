/**
 * Post-mutation floating-block rebalance.
 *
 * After a meeting is created or moved, any floating block on the affected
 * day may now overlap that meeting. This helper tries to re-place each
 * affected block inside its preferred window. If no in-window slot is
 * available, the block is left where it is and the owner is shadow-DM'd —
 * the bumping-out-of-window decision still belongs to the owner (via the
 * policy_exception approval flow), not this cascade.
 *
 * Same shape as `closeMeetingArtifacts` (post-mutation, fire-and-forget,
 * never throws), different concern (block placement rather than DB-artifact
 * cleanup).
 *
 * Called from `move_meeting` and `create_meeting` handlers after the
 * underlying Graph mutation succeeds. Best-effort: a failure here must
 * never undo the calendar mutation that just landed.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import * as fb from './floatingBlocks';
import { densityCommitments } from './floatingBlocks';
import { getEffectiveWorkDay } from './workHours';
import { prefersDensePacking, densityConfigFromProfile } from './calendarDensity';
import type { CalendarEvent } from '../connectors/graph/calendar';
import logger from './logger';
import { logActivity } from '../core/requests/logActivity';

// floating-block-auto-rebalance-not-revertible-and-misundo-risk (2026-08-14)
// — every block this function actually relocates via updateMeeting (both
// move sites below) now writes its own activity row too, mirroring
// book_floating_block's own logFloatingBlockActivity
// (calendarHealth/handlers/floatingBlockOps.ts). Two reasons: (a) so "undo
// that" can put the block back, and (b) so right after a create_meeting /
// move_meeting whose mutation triggered this shift, the NEWEST logged row is
// THIS one, not the parent mutation's — undo then targets the shift, never
// the meeting that caused it. No precedence/undo-chaining logic against the
// triggering action is needed, even a non-revertible one like delete_meeting
// (matchmaker.md M15): the block's post-rebalance position carries no
// ranking, so logging this row and stopping is the whole job. subkind is
// literally 'move_meeting' (not a
// bespoke tag) so the EXISTING move_meeting revert path
// (ops/handlers/calendarReads.ts's handleRevertAction) picks it up with no
// new dispatch code — the same key autoMove's own auto_move rows resolve
// to (activityRevertibility.ts). ownerUserId comes off `params.ownerSlackId`
// (already threaded by every call site, previously unused in this file);
// no owner id → best-effort skip, matching logActivity's own fail-soft
// contract.
function logRebalanceMoveActivity(
  ownerSlackId: string | undefined,
  blockName: string,
  blockEvent: CalendarEvent,
  tz: string,
  newStart: DateTime,
  newEnd: DateTime,
): void {
  if (!ownerSlackId) return;
  logActivity({
    ownerUserId: ownerSlackId,
    kind: 'follow_up',
    subkind: 'move_meeting',
    subject: `Rebalanced '${blockName}'`,
    outcomeJson: {
      event_id: blockEvent.id,
      original_start: blockEvent.start.dateTime,
      original_end: blockEvent.end.dateTime,
      original_tz: blockEvent.start.timeZone ?? tz,
      new_start: newStart.toISO(),
      new_end: newEnd.toISO(),
    },
    initiatedBy: ownerSlackId,
    initiatedByRole: 'system',
  });
}

/**
 * The reclaim-slot search, shared by the real mover (the overlap branch below)
 * and the pre-booking dry-run (`dryRunFloatingBlockRelocation`) so there is
 * ONE place that decides "can this block actually move inside its window" —
 * never two implementations that can drift (M1-style: one search, one
 * answer). Mirrors the real mover's own guards: a block outside its
 * preferred window is never promised a move (`inWindow: false`); an aligned
 * slot is searched honoring `prefer_position`.
 *
 * `extraBusy` lets a caller fold in a slot that doesn't exist on the
 * calendar yet (the dry-run's not-yet-booked candidate meeting) without a
 * second busy-window builder.
 */
function computeBlockRelocation(
  block: fb.FloatingBlock,
  dateStr: string,
  tz: string,
  blockEvent: CalendarEvent,
  blockStartMs: number,
  blockEndMs: number,
  realEvents: CalendarEvent[],
  extraBusy?: { start: number; end: number },
): { inWindow: boolean; aligned: number | null; usedWorkingElsewhereFallback: boolean } {
  const winStart = fb.windowMsForDay(dateStr, block.preferred_start, tz);
  const winEnd = fb.windowMsForDay(dateStr, block.preferred_end, tz);
  if (
    Number.isFinite(winStart) && Number.isFinite(winEnd)
    && (blockStartMs < winStart || blockEndMs > winEnd)
  ) {
    return { inWindow: false, aligned: null, usedWorkingElsewhereFallback: false };
  }
  // Owner ruling (2026-08-28): this is a DESTINATION SEARCH (picking where the
  // block lands among several candidate gaps), not a single-slot capacity
  // check — so it goes through the two-pass finder: a genuinely free slot
  // first, a WE-tagged slot only as a fallback when no clear slot exists.
  const { aligned, usedWorkingElsewhereFallback } = fb.findBlockDestination(
    realEvents, block, dateStr, tz, new Set([blockEvent.id]), extraBusy,
  );
  return { inWindow: true, aligned, usedWorkingElsewhereFallback };
}

/**
 * Read-only pre-booking check: for a candidate meeting slot that has NOT
 * been written yet, does it overlap a floating block on that day, and if so
 * can the REAL mover (`rebalanceFloatingBlocksAfterMutation`'s overlap
 * branch) actually relocate that block afterward? No `updateMeeting` call —
 * a dry run of the exact same search via `computeBlockRelocation`.
 *
 * Built so the pre-booking confirmation can state a REAL fact ("no room for
 * lunch will remain" / "lunch would move to 13:00–13:25") instead of Sonnet's
 * own arithmetic on the calendar — the live incident this exists to fix
 * (2026-08-26, Slack thread D0ASFFYTCQ0): the confirmation said "20 min free
 * will remain" while the real post-write rebalance found zero viable slots.
 *
 * Deliberately narrow: only reports on blocks the CANDIDATE slot overlaps.
 * A block untouched by this booking is not this call's concern.
 */
export interface FloatingBlockImpact {
  block: string;
  relocatable: boolean;
  newSlotIso?: string;
  newSlotLabel?: string;
  /** True when the only landing spot found sits against a Working-Elsewhere
   * event rather than a fully clear gap (owner ruling 2026-08-28). */
  usedWorkingElsewhereFallback?: boolean;
}

export async function dryRunFloatingBlockRelocation(params: {
  profile: UserProfile;
  candidateStartIso: string;
  candidateEndIso: string;
  /** Pre-fetched day events, when the caller already has them (skip the Graph read). */
  preloadedDayEvents?: CalendarEvent[];
}): Promise<FloatingBlockImpact[]> {
  const results: FloatingBlockImpact[] = [];
  try {
    const { profile, candidateStartIso, candidateEndIso } = params;
    const tz = profile.user.timezone;
    const startDt = DateTime.fromISO(candidateStartIso, { zone: tz });
    const endDt = DateTime.fromISO(candidateEndIso, { zone: tz });
    if (!startDt.isValid || !endDt.isValid) return results;
    const dateStr = startDt.toFormat('yyyy-MM-dd');
    const dayName = startDt.toFormat('EEEE');

    // Mirrors the real mover: no floating blocks on a per-date override day.
    if (getEffectiveWorkDay(dateStr, profile).hasOverride) return results;

    const blocks = fb.getFloatingBlocks(profile);
    if (blocks.length === 0) return results;

    const candidateStartMs = startDt.toMillis();
    const candidateEndMs = endDt.toMillis();

    // Cheap pre-check (2026-08-28, bouncer finding) — this used to fetch the
    // day's full calendar unconditionally before checking whether the
    // candidate could even plausibly touch a block. A block's actual placed
    // event normally sits inside its own `preferred_start`/`preferred_end`
    // window (that's the whole point of the window); test the candidate
    // against those windows first — pure profile data, zero I/O — and only
    // pay for the Graph read when at least one applicable block's window
    // overlaps the candidate. A block currently sitting outside its window
    // (owner-pinned) is out of scope for this pre-booking check either way —
    // the real post-write mover already treats "outside window" as never
    // relocatable, and the caller's day-events fetch below still runs
    // whenever preloadedDayEvents wasn't already supplied and this pre-check
    // can't rule the block out.
    if (!params.preloadedDayEvents) {
      const mightOverlap = blocks.some(block => {
        if (!fb.blockAppliesOnDay(block, dayName, profile)) return false;
        const winStart = fb.windowMsForDay(dateStr, block.preferred_start, tz);
        const winEnd = fb.windowMsForDay(dateStr, block.preferred_end, tz);
        if (!Number.isFinite(winStart) || !Number.isFinite(winEnd)) return true; // can't rule out — fall through to the real check
        return candidateStartMs < winEnd && candidateEndMs > winStart;
      });
      if (!mightOverlap) return results;
    }

    const { getCalendarEvents } = await import('../connectors/graph/calendar');
    const dayStartIso = startDt.startOf('day').toUTC().toISO();
    const dayEndIso = startDt.endOf('day').toUTC().toISO();
    if (!dayStartIso || !dayEndIso) return results;
    const events = params.preloadedDayEvents ?? await getCalendarEvents(profile.user.email, dayStartIso, dayEndIso, tz);
    const realEvents = events.filter(e => !e.isCancelled && !e.isAllDay && e.showAs !== 'free');

    const nowMs = DateTime.now().setZone(tz).toMillis();

    for (const block of blocks) {
      if (!fb.blockAppliesOnDay(block, dayName, profile)) continue;

      const blockEvent = realEvents.find(e => {
        if (!fb.isFloatingBlockEvent({ subject: e.subject, categories: e.categories }, block)) return false;
        const evDay = DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? 'utc' })
          .setZone(tz).toFormat('yyyy-MM-dd');
        return evDay === dateStr;
      });
      if (!blockEvent) continue; // nothing on the calendar this day to protect

      const blockStartMs = DateTime.fromISO(blockEvent.start.dateTime, {
        zone: blockEvent.start.timeZone ?? 'utc',
      }).setZone(tz).toMillis();
      const blockEndMs = DateTime.fromISO(blockEvent.end.dateTime, {
        zone: blockEvent.end.timeZone ?? 'utc',
      }).setZone(tz).toMillis();

      // Mirrors #140 in the real mover: a slot already past today is spent —
      // never promise a relocation for it.
      if (blockEndMs <= nowMs) continue;

      // Only report blocks the CANDIDATE slot actually overlaps.
      if (!(candidateStartMs < blockEndMs && candidateEndMs > blockStartMs)) continue;

      const relocation = computeBlockRelocation(
        block, dateStr, tz, blockEvent, blockStartMs, blockEndMs, realEvents,
        { start: candidateStartMs, end: candidateEndMs },
      );
      if (!relocation.inWindow || relocation.aligned === null) {
        results.push({ block: block.name, relocatable: false });
        continue;
      }
      const rs = DateTime.fromMillis(relocation.aligned, { zone: tz });
      const re = rs.plus({ minutes: block.duration_minutes });
      results.push({
        block: block.name,
        relocatable: true,
        newSlotIso: rs.toISO()!,
        newSlotLabel: `${rs.toFormat('HH:mm')}–${re.toFormat('HH:mm')}`,
        ...(relocation.usedWorkingElsewhereFallback ? { usedWorkingElsewhereFallback: true } : {}),
      });
    }
  } catch (err) {
    logger.warn('dryRunFloatingBlockRelocation threw — swallowed', {
      err: String(err).slice(0, 200),
      candidateStartIso: params.candidateStartIso,
    });
  }
  return results;
}

// Process-lifetime dedup cache for "floating block overlap" shadows.
// Same (date, blockName, overlappingEventId) fingerprint within the TTL
// is collapsed to one DM so the owner doesn't get pinged twice a day,
// every day, until they resolve the overlap. Restarts reset the cache —
// acceptable trade-off (no persistent state, no DB schema; suppressing
// forever would risk silencing a real recurrence).
const OVERLAP_SHADOW_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const overlapShadowDedup = new Map<string, number>();
function shouldSkipOverlapShadow(fingerprint: string): boolean {
  const now = Date.now();
  // Drop expired entries on every check (cheap, bounded by TTL × call rate).
  for (const [k, expiresAt] of overlapShadowDedup) {
    if (expiresAt <= now) overlapShadowDedup.delete(k);
  }
  if ((overlapShadowDedup.get(fingerprint) ?? 0) > now) return true;
  overlapShadowDedup.set(fingerprint, now + OVERLAP_SHADOW_DEDUP_TTL_MS);
  return false;
}

/**
 * A floating block that sits OUTSIDE its preferred window and could now be
 * brought home — the mutation that just landed (a move or delete) freed an
 * aligned slot inside the block's window. Tier 1 is PROPOSE-ONLY: the helper
 * surfaces the candidate, the handler attaches it to the tool result, and the
 * reply offers it ("…frees 12:30 — want lunch back there?"). We never auto-move
 * it here, because a block outside its window may be owner-pinned on purpose;
 * a declinable offer is the safe altitude.
 */
export interface ReclaimableBlock {
  name: string;
  /** ISO start of the in-window aligned slot the block could move back to. */
  targetSlotIso: string;
  /** Human label for the reply, e.g. "Wed 3 Jun 12:30–13:00". */
  label: string;
  /** Graph event id of the displaced block (so a follow-up move can target it). */
  blockEventId: string;
  /**
   * True when no genuinely free slot existed in the window and this
   * candidate only clears the block against a Working-Elsewhere event
   * (owner ruling 2026-08-28 — WE is a second-tier fallback, never a
   * clean slot). Omitted when the slot is fully clear.
   */
  usedWorkingElsewhereFallback?: boolean;
}

export async function rebalanceFloatingBlocksAfterMutation(params: {
  profile: UserProfile;
  /** ISO timestamp of the new event start — used to derive the affected date. */
  affectedSlotIso: string;
  ownerSlackId?: string;
  /**
   * The slot this mutation actually FREED (a move's old position, a delete's
   * removed event). When provided, a reclaim candidate is only surfaced if this
   * freed range intersects the block's preferred window — i.e. THIS mutation
   * plausibly opened the room, so we don't re-offer on unrelated same-day edits.
   * Omit to fall back to permissive detection (any open window).
   */
  freedRangeIso?: { start: string; end: string };
  /**
   * #133b — DENSE consolidation opt-in. When true AND the tenant is on dense
   * packing, a block that sits in a DEAD sliver (6–29 min) but overlaps nothing
   * is slid within its window to abut a neighbour (free time → one real break).
   * Only the calendar-health sweep passes it; booking-path callers omit it, so
   * their behaviour is unchanged. This is the SINGLE place that auto-moves a
   * floating block — overlap-fix and dense-consolidate share the move+notify.
   */
  consolidateDense?: boolean;
  /**
   * #143c — the affected day's events, pre-fetched by the caller. When provided,
   * the helper SKIPS its own single-day Graph read and works from these. The
   * calendar-health sweep passes it so a whole-window sweep makes ONE range fetch
   * instead of one Graph round-trip per day. Mutation-path callers omit it → the
   * helper fetches the one affected day itself (unchanged).
   */
  preloadedDayEvents?: CalendarEvent[];
}): Promise<{ moved: number; overlapping: number; reclaimable: ReclaimableBlock[]; movedBlockEventIds: string[] }> {
  // movedBlockEventIds — every block event this call actually relocated (overlap-
  // fix OR dense consolidation). The calendar-health sweep collects these so the
  // #133c lunch-anchored fallback can SKIP a block moved this sweep: Graph
  // calendarView lags a few seconds after a write, so a fresh re-fetch may still
  // show the block's OLD position — acting on it would move a meeting to close a
  // sliver consolidation already closed. Deferring to the next sweep (settled
  // data) is correct and churn-free.
  const result: { moved: number; overlapping: number; reclaimable: ReclaimableBlock[]; movedBlockEventIds: string[] } =
    { moved: 0, overlapping: 0, reclaimable: [], movedBlockEventIds: [] };
  const { profile, affectedSlotIso } = params;

  try {
    const tz = profile.user.timezone;
    const slotDt = DateTime.fromISO(affectedSlotIso, { zone: tz });
    if (!slotDt.isValid) {
      logger.info('rebalanceFloatingBlocks: skipped — invalid affectedSlotIso', { affectedSlotIso });
      return result;
    }
    const dateStr = slotDt.toFormat('yyyy-MM-dd');
    const dayName = slotDt.toFormat('EEEE');

    // v3.7.x (#143) — no floating blocks on a per-date override day, so there's
    // nothing to rebalance or reclaim there. Skip entirely.
    if (getEffectiveWorkDay(dateStr, profile).hasOverride) {
      logger.info('rebalanceFloatingBlocks: skipped — schedule-override day', { date: dateStr });
      return result;
    }

    const blocks = fb.getFloatingBlocks(profile);
    if (blocks.length === 0) {
      logger.info('rebalanceFloatingBlocks: skipped — no floating blocks configured', { date: dateStr });
      return result;
    }
    // v2.4.2 — entry log so we can confirm the cascade fired at all. Pre-v2.4.2
    // we had no way to tell whether the helper ran (and skipped silently for
    // benign reasons) vs. never ran (e.g., stale build pre-v2.2.3). Each exit
    // path now emits exactly one log line — entry, per-block decision, summary.
    logger.info('rebalanceFloatingBlocks: starting', {
      date: dateStr,
      dayName,
      affectedSlotIso,
      blockNames: blocks.map(b => b.name),
    });

    // Lazy imports to keep helper light + avoid circular dep risk
    const { getCalendarEvents, updateMeeting } = await import('../connectors/graph/calendar');
    const { shadowNotify } = await import('./shadowNotify');

    const startIso = slotDt.startOf('day').toUTC().toISO();
    const endIso = slotDt.endOf('day').toUTC().toISO();
    if (!startIso || !endIso) return result;

    // #143c — use the caller's pre-fetched day events when provided (the sweep's
    // batched path); otherwise fetch just this one day (the per-mutation path).
    const events = params.preloadedDayEvents ?? await getCalendarEvents(profile.user.email, startIso, endIso, tz);
    const realEvents = events.filter(e => !e.isCancelled && !e.isAllDay && e.showAs !== 'free');

    // Freed-range gate (optional): when the caller tells us the slot this
    // mutation actually freed, reclaim offers are limited to blocks whose
    // window that freed range overlaps — so we don't re-offer on unrelated
    // same-day edits. Absent → permissive (any open window qualifies).
    let freedStartMs: number | null = null;
    let freedEndMs: number | null = null;
    if (params.freedRangeIso) {
      const fs = DateTime.fromISO(params.freedRangeIso.start, { zone: tz });
      const fe = DateTime.fromISO(params.freedRangeIso.end, { zone: tz });
      if (fs.isValid && fe.isValid && fe.toMillis() > fs.toMillis()) {
        freedStartMs = fs.toMillis();
        freedEndMs = fe.toMillis();
      }
    }

    // v3.0.2 — floating-block math is buffer-free; meeting durations carry the spacing.

    for (const block of blocks) {
      if (!fb.blockAppliesOnDay(block, dayName, profile)) {
        logger.info('rebalanceFloatingBlocks: block skipped — not applicable today', {
          block: block.name, dayName,
        });
        continue;
      }

      // Find the block event on this day (if any). If the block doesn't
      // currently exist on the calendar, no rebalance needed.
      //
      // DATE GUARD: the day-fetch window (startOf('day')→endOf('day') in tz,
      // converted to UTC) spills across the UTC midnight boundary, so the
      // fetched set can include the ADJACENT day's block. A plain find() then
      // grabbed the wrong day's lunch and compared it against THIS day's window
      // → misread as "out-of-window" → the sweep silently downgraded to
      // propose-only (moved:0). Match only the event whose start falls on the
      // day we're actually processing (dateStr).
      const blockEvent = realEvents.find(e => {
        if (!fb.isFloatingBlockEvent({ subject: e.subject, categories: e.categories }, block)) return false;
        const evDay = DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? 'utc' })
          .setZone(tz)
          .toFormat('yyyy-MM-dd');
        return evDay === dateStr;
      });
      if (!blockEvent) {
        logger.info('rebalanceFloatingBlocks: block skipped — no existing event on calendar', {
          block: block.name, date: dateStr,
        });
        continue;
      }

      const blockStartMs = DateTime.fromISO(blockEvent.start.dateTime, {
        zone: blockEvent.start.timeZone ?? 'utc',
      }).setZone(tz).toMillis();
      const blockEndMs = DateTime.fromISO(blockEvent.end.dateTime, {
        zone: blockEvent.end.timeZone ?? 'utc',
      }).setZone(tz).toMillis();

      // v3.7.x (#140) — never rebalance a block whose slot has already passed
      // today. On a same-day sweep at 13:01 a lunch that already sat at
      // 11:30-11:55 was surfaced as "overlaps — want me to bump it outside?",
      // which is meaningless (the block is ~90 min in the past; a bump lands
      // nowhere useful). Once the block event has ended for today its slot is
      // spent — skip it. Future days are unaffected (blockEndMs > now).
      if (blockEndMs <= DateTime.now().setZone(tz).toMillis()) {
        logger.info('rebalanceFloatingBlocks: block skipped — slot already passed today', {
          block: block.name, date: dateStr,
          blockEndLocal: DateTime.fromMillis(blockEndMs).setZone(tz).toFormat('HH:mm'),
        });
        continue;
      }

      // Block sits OUTSIDE its preferred window. We never AUTO-move it back —
      // it may be owner-pinned on purpose (confirm_outside_window / manual
      // Outlook edit), and silently undoing that is the regression the v2.x
      // sweep was careful to avoid. BUT the mutation that just landed (a move
      // or delete) may have freed an aligned slot inside the window — Tier 1
      // (v3.2.x): surface that as a PROPOSE-ONLY reclaim candidate so the reply
      // can offer to bring the block home. A wrong guess (owner-pinned) is just
      // a declinable offer, so detection here doesn't need to disambiguate.
      const ownerPinWinStart = fb.windowMsForDay(dateStr, block.preferred_start, tz);
      const ownerPinWinEnd = fb.windowMsForDay(dateStr, block.preferred_end, tz);
      if (
        Number.isFinite(ownerPinWinStart) && Number.isFinite(ownerPinWinEnd)
        && (blockStartMs < ownerPinWinStart || blockEndMs > ownerPinWinEnd)
      ) {
        // v3.2.x — DIAGNOSTIC (not a fix). A floating block sitting at the
        // window START (e.g. lunch 11:30 with window 11:30–13:30) was being
        // routed here as "out-of-window" when it should read as in-window and
        // take the auto-slide path — but the old log line carried nothing to
        // tell a boundary bug from a real out-of-window pin from a TZ-parse
        // skew. Dump the raw inputs so the NEXT occurrence is self-explaining:
        // raw event start/end (+ their stored timeZone), the computed block ms
        // vs window ms in owner-local, and which side of the comparison tripped.
        logger.info('rebalanceFloatingBlocks: OUT-OF-WINDOW classification — diagnostic', {
          block: block.name, date: dateStr,
          rawEventStart: blockEvent.start.dateTime, rawEventStartTz: blockEvent.start.timeZone ?? 'utc',
          rawEventEnd: blockEvent.end.dateTime, rawEventEndTz: blockEvent.end.timeZone ?? 'utc',
          blockLocal: `${DateTime.fromMillis(blockStartMs).setZone(tz).toFormat('HH:mm:ss')}-${DateTime.fromMillis(blockEndMs).setZone(tz).toFormat('HH:mm:ss')}`,
          windowLocal: `${DateTime.fromMillis(ownerPinWinStart).setZone(tz).toFormat('HH:mm:ss')}-${DateTime.fromMillis(ownerPinWinEnd).setZone(tz).toFormat('HH:mm:ss')}`,
          blockStartMs, blockEndMs, winStartMs: ownerPinWinStart, winEndMs: ownerPinWinEnd,
          startBelowWindow: blockStartMs < ownerPinWinStart,
          endAboveWindow: blockEndMs > ownerPinWinEnd,
          startDeltaMs: blockStartMs - ownerPinWinStart,  // 0 = exactly at window start (the suspected edge bug)
          freedRangeIso: params.freedRangeIso ?? null,
        });
        // Freed-range gate: if the caller told us what slot was freed, only
        // consider this block when that freed range overlaps its window — the
        // mutation has to plausibly be what opened the room. No overlap → this
        // mutation isn't relevant to this block; skip without offering.
        if (
          freedStartMs !== null && freedEndMs !== null
          && !(freedStartMs < ownerPinWinEnd && freedEndMs > ownerPinWinStart)
        ) {
          logger.info('rebalanceFloatingBlocks: block outside window, freed range not in its window — no offer', {
            block: block.name, date: dateStr,
          });
          continue;
        }
        // Destination search — same two-pass rule as the overlap-branch math
        // via computeBlockRelocation (owner ruling 2026-08-28): a genuinely
        // free slot first, a WE-tagged slot only as a fallback.
        const { aligned: reclaimSlot, usedWorkingElsewhereFallback: reclaimUsedWE } = fb.findBlockDestination(
          realEvents, block, dateStr, tz, new Set([blockEvent.id]),
        );
        // Any in-window aligned slot is "more home" than the current
        // out-of-window placement, so its mere existence makes this a candidate.
        if (reclaimSlot !== null) {
          const rs = DateTime.fromMillis(reclaimSlot, { zone: tz });
          const re = rs.plus({ minutes: block.duration_minutes });
          result.reclaimable.push({
            name: block.name,
            targetSlotIso: rs.toISO()!,
            label: `${rs.toFormat('EEE d MMM HH:mm')}–${re.toFormat('HH:mm')}`,
            blockEventId: blockEvent.id,
            ...(reclaimUsedWE ? { usedWorkingElsewhereFallback: true } : {}),
          });
          logger.info('rebalanceFloatingBlocks: reclaim candidate found (propose-only)', {
            block: block.name, date: dateStr,
            currentPlacement: `${DateTime.fromMillis(blockStartMs).setZone(tz).toFormat('HH:mm')}-${DateTime.fromMillis(blockEndMs).setZone(tz).toFormat('HH:mm')}`,
            reclaimTo: rs.toFormat('HH:mm'),
          });
        } else {
          logger.info('rebalanceFloatingBlocks: block outside window, no in-window slot to reclaim', {
            block: block.name, date: dateStr,
            currentPlacement: `${DateTime.fromMillis(blockStartMs).setZone(tz).toFormat('HH:mm')}-${DateTime.fromMillis(blockEndMs).setZone(tz).toFormat('HH:mm')}`,
            preferredWindow: `${block.preferred_start}-${block.preferred_end}`,
          });
        }
        continue;
      }

      // Does any non-block event overlap the block right now?
      const overlapping = realEvents.find(e => {
        if (e.id === blockEvent.id) return false;
        const eStart = DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? 'utc' })
          .setZone(tz).toMillis();
        const eEnd = DateTime.fromISO(e.end.dateTime, { zone: e.end.timeZone ?? 'utc' })
          .setZone(tz).toMillis();
        return eStart < blockEndMs && eEnd > blockStartMs;
      });
      if (!overlapping) {
        // #133b — DENSE consolidation. No meeting overlaps the block, but on a
        // dense calendar it may still leave a DEAD sliver (6–29 min) beside it.
        // Slide it within its window to abut a neighbour so the free time
        // coalesces into one real break — using the SAME move+notify this
        // function already runs for overlaps (ONE mover, two reasons).
        // findConsolidatingSlotForBlock returns null unless the slide STRICTLY
        // reduces the day's dead minutes (already-optimal / unfixable → no move
        // → idempotent across sweeps). Gated: opt-in flag + dense tenant only.
        if (params.consolidateDense && prefersDensePacking(profile.meetings)) {
          // floatingBlocksAsNeighbours: true — an OTHER floating block (gym,
          // coffee) is a real neighbour to abut for consolidation purposes,
          // same rationale as autoMove's abut-the-block guards. Was its own
          // hand-rolled filter that (unlike this) never excluded WE — fixed
          // here to match rule 6 / the other three density-pool call sites.
          const commitments = densityCommitments(realEvents, profile, {
            floatingBlocksAsNeighbours: true,
            excludeEventIds: [blockEvent.id],
          });
          const target = fb.findConsolidatingSlotForBlock(
            block, dateStr, tz, commitments, densityConfigFromProfile(profile.meetings), blockStartMs,
          );
          if (target !== null) {
            const newStart = DateTime.fromMillis(target, { zone: tz });
            const newEnd = newStart.plus({ minutes: block.duration_minutes });
            try {
              await updateMeeting({
                userEmail: profile.user.email, timezone: tz,
                meetingId: blockEvent.id, start: newStart.toISO()!, end: newEnd.toISO()!,
              });
              result.moved++;
              result.movedBlockEventIds.push(blockEvent.id);
              logRebalanceMoveActivity(params.ownerSlackId, block.name, blockEvent, tz, newStart, newEnd);
              await shadowNotify(profile, {
                channel: '',
                icon: '🔧',
                action: 'Dense calendar — floating block consolidated',
                detail: `Slid your ${block.name.replace(/_/g, ' ')} to ${newStart.toFormat('HH:mm')}–${newEnd.toFormat('HH:mm')} on ${slotDt.toFormat('EEE d MMM')} so the free time around it lands as one clean break instead of split minutes. Tell me if you'd rather it stayed at ${DateTime.fromMillis(blockStartMs).setZone(tz).toFormat('HH:mm')}.`,
              });
              logger.info('rebalanceFloatingBlocks: consolidated block (dense)', {
                block: block.name, date: dateStr,
                from: DateTime.fromMillis(blockStartMs).setZone(tz).toFormat('HH:mm'),
                to: newStart.toFormat('HH:mm'),
              });
            } catch (err) {
              logger.warn('rebalanceFloatingBlocks: dense consolidation updateMeeting failed', {
                blockId: blockEvent.id, err: String(err).slice(0, 200),
              });
            }
            continue;
          }
        }
        logger.info('rebalanceFloatingBlocks: block skipped — no overlap, current placement still fine', {
          block: block.name, date: dateStr,
          currentPlacement: `${DateTime.fromMillis(blockStartMs).setZone(tz).toFormat('HH:mm')}-${DateTime.fromMillis(blockEndMs).setZone(tz).toFormat('HH:mm')}`,
        });
        continue;
      }
      logger.info('rebalanceFloatingBlocks: overlap detected — searching for in-window slot', {
        block: block.name, date: dateStr,
        currentPlacement: `${DateTime.fromMillis(blockStartMs).setZone(tz).toFormat('HH:mm')}-${DateTime.fromMillis(blockEndMs).setZone(tz).toFormat('HH:mm')}`,
        overlappingEvent: { subject: overlapping.subject, id: overlapping.id },
      });

      // Search the block's preferred window for an aligned slot (excluding
      // the block itself — Maelle is the one moving it), honoring
      // block.prefer_position ('latest_in_window'
      // picks the latest aligned gap so a "lunch at end-of-window"
      // preference survives rebalance instead of silently resetting to
      // earliest). Shared with the pre-booking dry run — see
      // computeBlockRelocation's own doc comment.
      const relocation = computeBlockRelocation(block, dateStr, tz, blockEvent, blockStartMs, blockEndMs, realEvents);
      const aligned = relocation.aligned;
      if (aligned !== null) {
        const newStart = DateTime.fromMillis(aligned, { zone: tz });
        const newEnd = newStart.plus({ minutes: block.duration_minutes });
        try {
          await updateMeeting({
            userEmail: profile.user.email,
            timezone: tz,
            meetingId: blockEvent.id,
            start: newStart.toISO()!,
            end: newEnd.toISO()!,
          });
          result.moved++;
          result.movedBlockEventIds.push(blockEvent.id);
          logRebalanceMoveActivity(params.ownerSlackId, block.name, blockEvent, tz, newStart, newEnd);
          const weNote = relocation.usedWorkingElsewhereFallback
            ? ' (no fully clear gap in the window — this one sits against a Working-Elsewhere block.)'
            : '';
          await shadowNotify(profile, {
            channel: '',  // sendDirect path; cache handles the channel
            icon: '🔧',
            action: 'Floating block rebalanced',
            detail: `Moved ${block.name} to ${newStart.toFormat('HH:mm')}–${newEnd.toFormat('HH:mm')} on ${slotDt.toFormat('EEE d MMM')}.${weNote}`,
          });
        } catch (err) {
          logger.warn('rebalanceFloatingBlocks: updateMeeting failed', {
            blockId: blockEvent.id, err: String(err).slice(0, 200),
          });
        }
      } else {
        // No in-window slot — leave overlapping. Owner can decide to bump
        // outside the window via the policy_exception approval flow.
        result.overlapping++;
        // Dedupe shadows on a stable fingerprint so the same overlap
        // doesn't DM the owner twice a day until it resolves. Lives
        // process-lifetime — restarts reset (acceptable; we just want
        // to collapse same-run repeats, not suppress forever).
        const fingerprint = `floating-overlap:${dateStr}:${block.name}:${overlapping.id}`;
        if (!shouldSkipOverlapShadow(fingerprint)) {
          try {
            await shadowNotify(profile, {
              channel: '',
              icon: '🔧',
              action: 'Floating block overlap',
              // v3.7.x (#140c) — name the block, the conflicting event, and the
              // window so the owner knows WHAT is moving and WHY (his #140
              // complaint: "I didn't know the reason, or what I'm moving").
              // Owner-facing shadow → no subject masking needed.
              detail: `Your ${block.name.replace(/_/g, ' ')} on ${slotDt.toFormat('EEE d MMM')} overlaps "${overlapping.subject}" and there's no free spot left inside its ${block.preferred_start}–${block.preferred_end} window. Want me to bump the ${block.name.replace(/_/g, ' ')} outside that window?`,
            });
          } catch { /* shadow failure non-fatal */ }
        }
      }
    }
  } catch (err) {
    logger.warn('rebalanceFloatingBlocksAfterMutation threw — swallowed', {
      err: String(err).slice(0, 200),
      affectedSlotIso,
    });
  }

  logger.info('rebalanceFloatingBlocks: complete', {
    affectedSlotIso,
    moved: result.moved,
    overlapping: result.overlapping,
    reclaimable: result.reclaimable.length,
  });
  return result;
}
