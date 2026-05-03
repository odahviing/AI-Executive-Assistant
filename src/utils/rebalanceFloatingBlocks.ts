/**
 * Post-mutation floating-block rebalance (v2.2.3, scenario 8 row 7).
 *
 * After a meeting is created or moved, any floating block on the affected
 * day may now overlap that meeting. This helper tries to re-place each
 * affected block inside its preferred window. If no in-window slot is
 * available, the block is left where it is and the owner is shadow-DM'd —
 * the bumping-out-of-window decision still belongs to the owner (via the
 * existing lunch_bump approval flow), not this cascade.
 *
 * Sibling to v2.1.6's `closeMeetingArtifacts` cascade: same shape (post-
 * mutation, fire-and-forget, never throws), different concern (block
 * placement rather than DB-artifact cleanup).
 *
 * Called from `move_meeting` and `create_meeting` handlers after the
 * underlying Graph mutation succeeds. Best-effort: a failure here must
 * never undo the calendar mutation that just landed.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import * as fb from './floatingBlocks';
import logger from './logger';

export async function rebalanceFloatingBlocksAfterMutation(params: {
  profile: UserProfile;
  /** ISO timestamp of the new event start — used to derive the affected date. */
  affectedSlotIso: string;
  ownerSlackId?: string;
}): Promise<{ moved: number; overlapping: number }> {
  const result = { moved: 0, overlapping: 0 };
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

    const bufferMin = profile.meetings.buffer_minutes ?? 15;

    for (const block of blocks) {
      if (!fb.blockAppliesOnDay(block, dayName, profile)) {
        logger.info('rebalanceFloatingBlocks: block skipped — not applicable today', {
          block: block.name, dayName,
        });
        continue;
      }

      // Find the block event on this day (if any). If the block doesn't
      // currently exist on the calendar, no rebalance needed.
      const blockEvent = realEvents.find(e =>
        fb.isFloatingBlockEvent(
          { subject: e.subject, categories: (e as unknown as { categories?: unknown }).categories },
          block,
        ),
      );
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

      const aligned = fb.findAlignedSlotForBlock(block, dateStr, tz, busyInWindow, bufferMin);
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
        // outside the window via the existing lunch_bump approval flow.
        result.overlapping++;
        try {
          await shadowNotify(profile, {
            channel: '',
            action: 'Floating block overlap',
            detail: `${block.name} on ${slotDt.toFormat('EEE d MMM')} overlaps another event and can't fit elsewhere in its window. Want me to bump it outside?`,
          });
        } catch { /* shadow failure non-fatal */ }
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
  });
  return result;
}
