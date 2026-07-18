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
import { getEffectiveWorkDay } from './workHours';
import { prefersDensePacking, densityConfigFromProfile } from './calendarDensity';
import type { CalendarEvent } from '../connectors/graph/calendar';
import logger from './logger';

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
        // Build busy-in-window for THIS block (excluding the block itself —
        // it's the one we'd be moving). Mirror the overlap-branch math below.
        const reclaimBusy: Array<{ start: number; end: number }> = [];
        for (const e of realEvents) {
          if (e.id === blockEvent.id) continue;
          const eStart = DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? 'utc' })
            .setZone(tz).toMillis();
          const eEnd = DateTime.fromISO(e.end.dateTime, { zone: e.end.timeZone ?? 'utc' })
            .setZone(tz).toMillis();
          if (eStart < ownerPinWinEnd && eEnd > ownerPinWinStart) {
            reclaimBusy.push({
              start: Math.max(eStart, ownerPinWinStart),
              end: Math.min(eEnd, ownerPinWinEnd),
            });
          }
        }
        const reclaimSlot = block.prefer_position === 'latest_in_window'
          ? fb.findLatestAlignedSlotForBlock(block, dateStr, tz, reclaimBusy)
          : fb.findAlignedSlotForBlock(block, dateStr, tz, reclaimBusy);
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
          const commitments = realEvents
            .filter(e => e.id !== blockEvent.id)   // meetings + any OTHER floating block, never this one
            .map(e => ({
              start: DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? 'utc' }).setZone(tz).toMillis(),
              end: DateTime.fromISO(e.end.dateTime, { zone: e.end.timeZone ?? 'utc' }).setZone(tz).toMillis(),
            }));
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
              await shadowNotify(profile, {
                channel: '',
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

      // Build busyInWindow for the block's preferred window (excluding the
      // block itself — Maelle is the one moving it).
      const winStart = fb.windowMsForDay(dateStr, block.preferred_start, tz);
      const winEnd = fb.windowMsForDay(dateStr, block.preferred_end, tz);
      const busyInWindow: Array<{ start: number; end: number }> = [];
      for (const e of realEvents) {
        if (e.id === blockEvent.id) continue;
        const eStart = DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? 'utc' })
          .setZone(tz).toMillis();
        const eEnd = DateTime.fromISO(e.end.dateTime, { zone: e.end.timeZone ?? 'utc' })
          .setZone(tz).toMillis();
        if (eStart < winEnd && eEnd > winStart) {
          busyInWindow.push({
            start: Math.max(eStart, winStart),
            end: Math.min(eEnd, winEnd),
          });
        }
      }

      // Honor block.prefer_position: 'latest_in_window' picks the latest
      // aligned gap (via the existing findLatestAlignedSlotForBlock) so a
      // "lunch at end-of-window" preference survives rebalance instead of
      // silently resetting to earliest. Default (no prefer_position) →
      // earliest aligned slot, existing behavior.
      const aligned = block.prefer_position === 'latest_in_window'
        ? fb.findLatestAlignedSlotForBlock(block, dateStr, tz, busyInWindow)
        : fb.findAlignedSlotForBlock(block, dateStr, tz, busyInWindow);
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
          await shadowNotify(profile, {
            channel: '',  // sendDirect path; cache handles the channel
            action: 'Floating block rebalanced',
            detail: `Moved ${block.name} to ${newStart.toFormat('HH:mm')}–${newEnd.toFormat('HH:mm')} on ${slotDt.toFormat('EEE d MMM')}.`,
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
