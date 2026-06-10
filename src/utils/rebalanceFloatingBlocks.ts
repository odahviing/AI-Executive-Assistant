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
}): Promise<{ moved: number; overlapping: number; reclaimable: ReclaimableBlock[] }> {
  const result: { moved: number; overlapping: number; reclaimable: ReclaimableBlock[] } =
    { moved: 0, overlapping: 0, reclaimable: [] };
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

    const events = await getCalendarEvents(profile.user.email, startIso, endIso, tz);
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
              detail: `${block.name} on ${slotDt.toFormat('EEE d MMM')} overlaps another event and can't fit elsewhere in its window. Want me to bump it outside?`,
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
