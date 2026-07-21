/**
 * calendarReads — extracted VERBATIM (v3.7.x, pass B) from the 'hold_slot' + 'get_calendar' + 'revert_last_auto_move' + 'set_work_schedule_override' + 'get_work_schedule_overrides' + 'analyze_calendar' + 'get_free_busy' + 'delete_meeting' case bodies of
 * SchedulingSkill.executeToolCall in ../../ops.ts. No logic changes: the case
 * bodies are byte-for-byte identical; only relative import/require paths were
 * deepened by two levels for the ops/handlers/ location, and the free
 * variables (context, userEmail, timezone) are threaded via OpCtx.
 */
import logger from '../../../../utils/logger';
import { DateTime } from 'luxon';
import type { SkillContext } from '../../../types';

import { formatIsoTime, computeVacatedSlot, buildOutOfHoursBusy } from '../../ops/helpers';
import { humanizeViolationLabel } from '../../ops/violationLabels';
import { processCalendarEvents, analyzeCalendar, enrichUnresolvedInternal } from '../../ops/analysis';
import {
  getCalendarEvents,
  getEventEndInstant,
  findDuplicateEvent,
  findReschedulableSibling,
  type CalendarEvent,
  getFreeBusy,
  findAvailableSlots,
  createMeeting,
  deleteMeeting,
  verifyEventDeleted,
  updateMeeting,
  GraphPermissionError,
} from '../../../../connectors/graph/calendar';
import {
  getDb,
  auditLog,
  getSuppressedEventIds,
  dismissFloatingBlockGap,
  searchPeopleMemory,
  getPersonMemory,
} from '../../../../db';
import { closeMeetingArtifacts } from '../../../../utils/closeMeetingArtifacts';
import { reinterpretClockInZone, renderClockInZone } from '../../../../utils/timezoneConvert';
import { resolveStatedInstant, renderWeDualClock } from '../../../../utils/weTimeResolver';
import { checkIntendedWeekday } from '../../../../utils/weekdayGuard';
import type { OpCtx } from './context';

export async function handleHoldSlot(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
        // Tentative slot reservation. Colleague-path: only a slot WE
        // offered them this conversation, max 3, re-pick replaces same-thread.
        // Owner-path: any slot, any holder. Auto-expires at min(2 workdays,
        // slot-start) via the tick (sweepExpiredSlotHolds). See db/slotHolds.ts.
        const ownerUserId = context.profile.user.slack_user_id;
        const isOwner = context.senderRole === 'owner';
        const action = args.action as string;
        const sh = await import('../../../../db/slotHolds');

        // Normalize any provided slot bound to a UTC instant up front, so store,
        // release-match, and the readers all compare the same zone. Sonnet passes
        // a bare owner-local clock string ("2026-06-24T16:30:00", no offset);
        // stored raw, the readers (Date.parse / SQL string-compare vs a UTC
        // `nowIso`) read it as server-local and drift by the offset off a
        // non-Israel host. Interpreting in the owner TZ → UTC makes every hold
        // comparison instant-correct. (An offset-form input passes through —
        // fromISO honors an explicit offset.)
        const holdTz = context.profile.user.timezone;
        const normIso = (s: unknown): string | undefined =>
          (typeof s === 'string' && s)
            ? (DateTime.fromISO(s, { zone: holdTz }).toUTC().toISO() ?? s)
            : undefined;
        const normStartIso = normIso(args.start_iso);
        const normEndIso = normIso(args.end_iso);

        if (action === 'release') {
          if (typeof args.hold_id === 'string' && args.hold_id) {
            const ok = sh.releaseSlotHold(args.hold_id, isOwner ? 'owner_cancelled' : 'colleague_released');
            return { success: ok, released: ok ? 1 : 0 };
          }
          const released = isOwner
            ? sh.releaseHoldsForOwner(ownerUserId, { startIso: normStartIso }, 'owner_cancelled')
            : sh.releaseHoldsForOwner(ownerUserId, { holderSlackId: context.userId, startIso: normStartIso }, 'colleague_released');
          return { success: true, released: released.length };
        }

        // action === 'hold'
        const startIso = normStartIso;
        const endIso = normEndIso;
        if (!startIso || !endIso) {
          return { success: false, error: 'missing_slot', message: 'Need start_iso and end_iso to hold a slot.' };
        }
        // Expiry = min(2 owner-workdays from now, the slot's own start).
        const { addWorkdays } = await import('../../../../utils/workHours');
        const twoWd = addWorkdays(new Date().toISOString(), 2, context.profile);
        const expiresAt = Date.parse(twoWd) < Date.parse(startIso) ? twoWd : startIso;

        if (isOwner) {
          const hold = sh.createSlotHold({
            ownerUserId,
            holderSlackId: typeof args.holder_slack_id === 'string' ? args.holder_slack_id : null,
            holderName: (args.holder_name as string | undefined) ?? 'someone',
            subject: args.subject as string | undefined,
            startIso, endIso,
            originChannel: context.channelId,
            originThreadTs: context.threadTs,
            reason: args.reason as string | undefined,
            expiresAt,
          });
          return { success: true, hold_id: hold.id, expires_at: expiresAt };
        }

        // Colleague path — validate the slot was offered here, enforce the cap.
        const holderSlackId = context.userId;
        const { getOfferedSlots } = await import('../../../../utils/offeredSlotsStash');
        const offered = getOfferedSlots(context.channelId, context.threadTs) ?? [];
        const startMs = Date.parse(startIso);
        const wasOffered = offered.some(o => Math.abs(Date.parse(o.startIso) - startMs) <= 60_000);
        if (!wasOffered) {
          return { success: false, error: 'slot_not_offered', message: 'You can only hold a time I actually offered you in this conversation.' };
        }
        // v3.5.x — holds ACCUMULATE; they don't blanket-replace. The old
        // repick-replace released ALL of the holder's prior holds on every call,
        // so "hold these 3 options" left only the last — the cap of 3 was
        // unreachable and "all three are held" was a false narrative (Oran,
        // 2026-06-25). Now: re-holding the SAME slot is idempotent (drop just
        // that slot's prior hold, keep the others); a DIFFERENT slot stacks,
        // bounded by ≤MAX_HOLDS_PER_HOLDER total AND ≤MAX_HOLDS_PER_MEETING for
        // one meeting (subject). Owner: "3 per holder, no more than 2 per meeting."
        sh.releaseHoldsForOwner(ownerUserId, { holderSlackId, startIso }, 'replaced_same_slot');
        if (sh.countActiveHoldsForHolder(ownerUserId, holderSlackId) >= sh.MAX_HOLDS_PER_HOLDER) {
          return { success: false, error: 'hold_cap_reached', message: `You already have ${sh.MAX_HOLDS_PER_HOLDER} times on hold — release one before adding another.` };
        }
        if (sh.countActiveHoldsForHolderSubject(ownerUserId, holderSlackId, args.subject as string | undefined) >= sh.MAX_HOLDS_PER_MEETING) {
          return { success: false, error: 'meeting_hold_cap_reached', message: `You already have ${sh.MAX_HOLDS_PER_MEETING} slots on hold for that meeting — release one before holding another for it.` };
        }
        const { getPersonMemory: getPM } = await import('../../../../db');
        const requesterRow = getPM(holderSlackId);
        const hold = sh.createSlotHold({
          ownerUserId,
          holderSlackId,
          holderName: requesterRow?.name ?? (args.holder_name as string | undefined) ?? 'a colleague',
          subject: args.subject as string | undefined,
          startIso, endIso,
          originChannel: context.channelId,
          originThreadTs: context.threadTs,
          reason: args.reason as string | undefined,
          expiresAt,
        });
        return { success: true, hold_id: hold.id, expires_at: expiresAt, message: 'Holding it tentatively while you check.' };
}

export async function handleGetCalendar(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
        const rawEvents = await getCalendarEvents(
          userEmail,
          args.start_date as string,
          args.end_date as string,
          timezone,
          args.force_refresh === true,  // v3.2.x (#121) — user asked to LOOK now → fresh
        );
        const processed = processCalendarEvents(rawEvents, userEmail, context.profile.user.name, timezone, context.profile);

        // v3.3 (fix #2) — Working Elsewhere enrichment. If the range covers
        // WE days, attach the away-TZ note so Sonnet does NOT eyeball home-TZ
        // "mornings clear" (the regression that offered Israel mornings while
        // the owner was in Boston). Null when no WE marker → nothing attached.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const weModGc = require('../../../../utils/workingElsewhere') as typeof import('../../../../utils/workingElsewhere');
        const weNoteGc = weModGc.summarizeWorkingElsewhere(context.profile, args.start_date as string, args.end_date as string);

        // v2.8.6 (99C, Shape A) — when the query window comes back with no
        // events on an owner-DM turn, enrich the result with recent
        // delete_meeting + create_meeting audit entries that intersect the
        // window. Closes the "did you cancel the
        // meeting you booked with X?" amnesia — get_calendar returns empty
        // post-delete, but the booking + delete are both in audit_log. Owner-DM
        // only — colleagues mustn't see audit traces of meetings they're not on.
        const isOwnerDm = context.senderRole === 'owner' && context.isMpim !== true;
        const eventCount = Array.isArray(processed) ? processed.length : 0;
        if (isOwnerDm && eventCount === 0) {
          try {
            const { recentAuditEntries } = await import('../../../../db/client');
            const audits = recentAuditEntries({ action: 'delete_meeting', windowDays: 7 });
            const auditsCreate = recentAuditEntries({ action: 'create_meeting', windowDays: 7 });
            // Filter to entries whose event_start_iso falls inside the queried window.
            const windowStartMs = Date.parse(args.start_date as string);
            const windowEndMs = Date.parse(args.end_date as string);
            const inWindow = (e: { details: Record<string, unknown> | null }): boolean => {
              const start = e.details?.event_start_iso;
              if (typeof start !== 'string') return false;
              const ms = Date.parse(start);
              if (!Number.isFinite(ms)) return false;
              return ms >= windowStartMs && ms <= windowEndMs + 24 * 60 * 60 * 1000;
            };
            const relevantDeletes = audits.filter(inWindow);
            const relevantCreates = auditsCreate.filter(inWindow);
            if (relevantDeletes.length > 0 || relevantCreates.length > 0) {
              const fmt = (action: 'cancelled' | 'created', e: { timestamp: string; details: Record<string, unknown> | null }) => {
                const subj = (e.details?.subject as string | undefined) ?? '(no subject)';
                const start = (e.details?.event_start_iso as string | undefined) ?? '';
                return `- ${action} "${subj}" (was on ${start.slice(0, 16) || 'unknown date'}) at ${e.timestamp}`;
              };
              const lines = [
                ...relevantCreates.map(e => fmt('created', e)),
                ...relevantDeletes.map(e => fmt('cancelled', e)),
              ];
              return {
                events: processed,
                _audit_context: `Calendar window is empty for the requested range, but Maelle has performed recent calendar actions inside this window. When the owner asks "did you do X" / "have you booked Y" / "what happened to Z", use this audit context BEFORE saying "I don't have a record":\n${lines.join('\n')}`,
                ...(weNoteGc ?? {}),
              };
            }
          } catch (err) {
            logger.warn('get_calendar audit enrichment threw — returning bare events', {
              err: String(err).slice(0, 200),
            });
          }
        }

        // v3.3.7 (#125a) — colleague-path calendar scoping. A colleague (not in
        // MPIM with owner present) only ever sees the meetings THEY are on.
        // Shipping the full
        // day to Sonnet led to wrong availability answers eyeballed off the
        // event list. With only shared meetings visible, "when is our sync?"
        // still works, and availability can ONLY come from find_available_slots
        // / check_join_availability — there is nothing else to reason from.
        // This also closes the enumeration-privacy hole in code rather than
        // asking Sonnet nicely.
        const isColleaguePath = context.senderRole === 'colleague' && context.isOwnerInGroup !== true;
        if (isColleaguePath) {
          let colleagueEmailLower = '';
          try {
            colleagueEmailLower = (getPersonMemory(context.userId)?.email ?? '').toLowerCase();
          } catch { /* unknown colleague → no shared events, note still explains */ }
          const sharedRaw = rawEvents.filter(ev => {
            if (!colleagueEmailLower) return false;
            const onAttendees = (ev.attendees ?? []).some(
              a => (a?.emailAddress?.address ?? '').toLowerCase() === colleagueEmailLower,
            );
            const isOrganizer = ((ev.organizer?.emailAddress?.address ?? '').toLowerCase() === colleagueEmailLower);
            return onAttendees || isOrganizer;
          });
          const sharedProcessed = processCalendarEvents(sharedRaw, userEmail, context.profile.user.name, timezone, context.profile);
          return {
            events: sharedProcessed,
            _colleague_view: true,
            _scope_note: `COLLEAGUE VIEW — this list contains ONLY the meetings this colleague is on (their shared meetings with the owner). The rest of the owner's calendar is not visible here and must never be described or enumerated. This is NOT an availability source: whether the owner is free/busy at any time comes ONLY from find_available_slots (or check_join_availability for joining an existing meeting) — never from the absence or presence of events in this list. v3.7.x (#141): if this colleague asks about or to CHANGE a meeting that is NOT in this list, do NOT explain why you can't see it and do NOT speculate about how the owner got it (e.g. "he may have received the invite directly"). If it's one THEY requested (see "MEETINGS YOU REQUESTED"), act on it by its event_id — a move/cancel routes to ${context.profile.user.name.split(' ')[0]}'s approval. Otherwise, simply say you can't action that one for them and they should ask ${context.profile.user.name.split(' ')[0]} directly.`,
          };
        }

        // v3.6.4 — visibility for the optional-join tier. A TIMED
        // workingElsewhere event is a "join only if free" meeting (e.g. a daily
        // standup), not a hard commitment. Tag the result so Sonnet lists it but
        // never treats it as blocking, and knows a booking can sit over it.
        const optionalJoinNote = rawEvents.some(e => !e.isAllDay && !e.isCancelled && e.showAs === 'workingElsewhere')
          ? { _optional_join_note: 'Any listed event with showAs "workingElsewhere" that is NOT all-day is an OPTIONAL-join meeting (the owner attends only if free — e.g. a standup), NOT a hard commitment. Present it as "optional, joins if free"; it never blocks the owner and a new meeting may be booked over it (he simply skips it). (An ALL-DAY workingElsewhere event is a travel day — a different thing entirely.)' }
          : undefined;
        const gcNotes = { ...(weNoteGc ?? {}), ...(optionalJoinNote ?? {}) };
        return Object.keys(gcNotes).length > 0 ? { events: processed, ...gcNotes } : processed;
}

export async function handleRevertLastAutoMove(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
        // v3.7.x (#139 / auto-fix Part B) — owner-only deterministic undo of the
        // most recent active-mode auto-move (the "I moved X to clear a clash"
        // notice). Restores the original time, re-notifies who was told, relabels
        // the spine record as reverted, and writes a terminal dismissal so the
        // sweep won't re-move it ("if I said no, it's no").
        if (context.senderRole !== 'owner') {
          return { success: false, error: 'owner_only', message: 'Only the owner can revert an auto-move.' };
        }
        const ownerUserId = context.profile.user.slack_user_id;
        const { getRevertibleAutoMove, updateRequest } = await import('../../../../db/requests');
        const rec = getRevertibleAutoMove(ownerUserId);
        if (!rec) {
          return { success: false, error: 'nothing_to_revert', message: 'There is no recent auto-move to undo.' };
        }
        let oc: Record<string, unknown> = {};
        try { oc = rec.outcome_json ? JSON.parse(rec.outcome_json) as Record<string, unknown> : {}; } catch { /* keep empty */ }
        const eventId = rec.outcome_external_event_id;
        const originalStart = typeof oc.original_start === 'string' ? oc.original_start : undefined;
        const originalEnd = typeof oc.original_end === 'string' ? oc.original_end : undefined;
        const revNewStart = typeof oc.new_start === 'string' ? oc.new_start : undefined;
        const revSubject = typeof oc.subject === 'string' ? oc.subject : 'the meeting';
        const keptEventId = typeof oc.kept_event_id === 'string' ? oc.kept_event_id : null;
        const notifiedSlackIds = Array.isArray(oc.notified_slack_ids)
          ? (oc.notified_slack_ids as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        if (!eventId || !originalStart || !originalEnd) {
          return {
            success: false, error: 'record_incomplete',
            message: `I found the auto-move of "${revSubject}" but its record is missing the original time, so I can't safely undo it — you can move it back manually.`,
          };
        }
        // Don't clobber a later change: if the meeting is no longer where the
        // auto-move put it, someone already moved it — nothing to revert.
        if (revNewStart) {
          try {
            const { getEventType } = await import('../../../../connectors/graph/calendar');
            const probe = await getEventType(userEmail, eventId);
            if (probe?.startDateTime) {
              const curMs = DateTime.fromISO(probe.startDateTime, { zone: timezone }).toUTC().toMillis();
              const newMs = DateTime.fromISO(revNewStart).toUTC().toMillis();
              if (Number.isFinite(curMs) && Number.isFinite(newMs) && Math.abs(curMs - newMs) > 5 * 60_000) {
                return {
                  success: false, error: 'already_changed',
                  message: `"${revSubject}" isn't where I auto-moved it anymore — it's already been changed, so there's nothing to revert.`,
                };
              }
            }
          } catch (e) { logger.warn('revert_last_auto_move — position probe threw; proceeding', { err: String(e).slice(0, 160) }); }
        }
        await updateMeeting({ userEmail, timezone, meetingId: eventId, start: originalStart, end: originalEnd });
        // Relabel the record so it's no longer revertible, and write the dismissal
        // so active-mode won't re-move this pair.
        try { updateRequest(rec.id, { closureReason: 'auto_move_reverted' }); } catch { /* best-effort */ }
        try {
          const { dismissOverlapIssue } = await import('../../../../db/calendarIssues');
          dismissOverlapIssue({
            ownerUserId,
            eventId,
            peerEventId: keptEventId,
            eventDate: DateTime.fromISO(originalStart, { zone: timezone }).toFormat('yyyy-MM-dd'),
            eventEndMs: DateTime.fromISO(originalEnd, { zone: timezone }).toMillis(),
            notes: 'owner reverted auto-move — leave it',
          });
        } catch (e) { logger.warn('revert_last_auto_move — dismissal write failed', { err: String(e).slice(0, 160) }); }
        // Re-notify anyone the auto-move told.
        let reNotified = 0;
        if (notifiedSlackIds.length > 0) {
          try {
            const { getConnection } = await import('../../../../connections/registry');
            const conn = getConnection(ownerUserId, 'slack');
            const origLocal = DateTime.fromISO(originalStart, { zone: timezone }).toFormat('EEE d MMM HH:mm');
            for (const sid of notifiedSlackIds) {
              try {
                await conn?.sendDirect(sid, `Quick update: "${revSubject}" is back to its original time (${origLocal}) — please disregard my earlier note about moving it.`);
                reNotified++;
              } catch { /* skip one */ }
            }
          } catch { /* messaging unavailable */ }
        }
        const restoredLocal = DateTime.fromISO(originalStart, { zone: timezone }).toFormat('EEE d MMM HH:mm');
        logger.info('revert_last_auto_move — done', { requestId: rec.id, eventId, restoredLocal, reNotified });
        return {
          success: true, reverted: true, subject: revSubject, restored_to: restoredLocal, re_notified: reNotified,
          message: `Put "${revSubject}" back to ${restoredLocal}${reNotified ? ` and let ${reNotified} ${reNotified === 1 ? 'person' : 'people'} know` : ''}. I won't auto-move it again.`,
        };
}

export async function handleSetWorkScheduleOverride(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
        // v3.7.x (#143) — owner-only per-date override WRITE. Dates are
        // Sonnet-parsed from the DATE LOOKUP table (no NL parsing here). A range
        // writes N single-date rows via the merge-upsert; clear:true removes them.
        if (context.senderRole !== 'owner') {
          return { success: false, error: 'owner_only', message: 'Only the owner can set schedule overrides.' };
        }
        const ownerSlackId = context.profile.user.slack_user_id;
        const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
        const dateFrom = typeof args.date_from === 'string' ? args.date_from.trim() : '';
        const dateTo = (typeof args.date_to === 'string' && args.date_to.trim()) ? args.date_to.trim() : dateFrom;
        if (!isDate(dateFrom) || !isDate(dateTo)) {
          return { success: false, error: 'bad_date', message: 'I need the date(s) as YYYY-MM-DD from the date table.' };
        }
        const start = DateTime.fromISO(dateFrom, { zone: timezone });
        const end = DateTime.fromISO(dateTo, { zone: timezone });
        if (!start.isValid || !end.isValid || end < start) {
          return { success: false, error: 'bad_range', message: 'That range looks off — give me a start on or before the end.' };
        }
        const dates: string[] = [];
        for (let cur = start, guard = 0; cur <= end && guard < 400; cur = cur.plus({ days: 1 }), guard++) {
          dates.push(cur.toFormat('yyyy-MM-dd'));
        }
        const { upsertScheduleOverride, clearScheduleOverride } = await import('../../../../db/scheduleOverrides');

        if (args.clear === true) {
          for (const d of dates) clearScheduleOverride(ownerSlackId, d);
          logger.info('set_work_schedule_override — cleared', { ownerSlackId, count: dates.length });
          const dLabel = dates.length === 1 ? dates[0] : `${dates[0]} → ${dates[dates.length - 1]}`;
          return {
            success: true, cleared: dates.length, dates, _slot_results_now_stale: true,
            message: `Cleared the override${dates.length > 1 ? 's' : ''} on ${dLabel} — back to your normal schedule.`,
          };
        }

        const hours = Array.isArray(args.hours)
          ? (args.hours as unknown[]).filter((h): h is string => typeof h === 'string' && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(h))
          : null;
        const off = args.off === true;
        const location = (args.location === 'office' || args.location === 'home') ? args.location : null;
        const timezoneArg = (typeof args.timezone === 'string' && args.timezone.trim()) ? args.timezone.trim() : null;
        const note = (typeof args.note === 'string' && args.note.trim()) ? args.note.trim() : null;
        // A working-shape signal (hours / location / trip tz) forces isWorkday=true
        // so it also flips a previously-set "off" back on; off wins over all.
        const isWorkday: boolean | null = off ? false
          : ((hours && hours.length > 0) || !!location || !!timezoneArg ? true : null);

        if (!off && (!hours || hours.length === 0) && !location && !timezoneArg && !note) {
          return {
            success: false, error: 'nothing_to_set',
            message: 'Tell me what changes for that day — off, custom hours, office/home, or a travel timezone.',
          };
        }

        for (const d of dates) {
          upsertScheduleOverride(ownerSlackId, {
            date: d,
            isWorkday,
            windows: off ? null : (hours && hours.length > 0 ? hours : null),
            location,
            timezone: timezoneArg,
            source: 'chat',
            note,
          });
        }
        const summaryParts: string[] = [];
        if (off) summaryParts.push('day off');
        if (hours && hours.length > 0) summaryParts.push(`hours ${hours.join(', ')}`);
        if (location) summaryParts.push(`${location} day`);
        if (timezoneArg) summaryParts.push(`timezone ${timezoneArg}`);
        const summary = summaryParts.join(', ') || 'updated';
        const dateLabel = dates.length === 1 ? dates[0] : `${dates[0]} → ${dates[dates.length - 1]} (${dates.length} days)`;
        logger.info('set_work_schedule_override — wrote', { ownerSlackId, count: dates.length, off, hours, location, timezone: timezoneArg });
        return {
          success: true, dates,
          off: off || undefined,
          hours: hours && hours.length > 0 ? hours : undefined,
          location: location ?? undefined,
          timezone: timezoneArg ?? undefined,
          _slot_results_now_stale: true,
          message: `Done — ${dateLabel}: ${summary}.`,
        };
}

export async function handleGetWorkScheduleOverrides(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
        // v3.7.x (#143) — owner-only read of upcoming overrides (today forward).
        if (context.senderRole !== 'owner') {
          return { success: false, error: 'owner_only', message: 'Only the owner can view schedule overrides.' };
        }
        const ownerSlackId = context.profile.user.slack_user_id;
        const todayIso = DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd');
        const { listScheduleOverrides } = await import('../../../../db/scheduleOverrides');
        const rows = listScheduleOverrides(ownerSlackId, todayIso);
        const overrides = rows.map(r => ({
          date: r.date,
          off: r.isWorkday === false ? true : undefined,
          hours: r.windows ?? undefined,
          location: r.location ?? undefined,
          timezone: r.timezone ?? undefined,
          note: r.note ?? undefined,
        }));
        return {
          success: true,
          count: overrides.length,
          overrides,
          message: overrides.length === 0
            ? 'No upcoming schedule overrides — your normal weekly schedule applies.'
            : `You have ${overrides.length} upcoming override${overrides.length === 1 ? '' : 's'}.`,
        };
}

export async function handleAnalyzeCalendar(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
        const rawEvents = await getCalendarEvents(
          userEmail,
          args.start_date as string,
          args.end_date as string,
          timezone,
        );
        const processed = processCalendarEvents(rawEvents, userEmail, context.profile.user.name, timezone, context.profile);
        // v3.0.3 — analyzeCalendar is read-only. Suppression handled at
        // row-write time elsewhere.
        const _suppressed = getSuppressedEventIds(context.profile.user.slack_user_id);
        void _suppressed;
        const analysis = analyzeCalendar(processed, args.start_date as string, args.end_date as string, context.profile);
        // v3.6.x (bug 1.2) — category per-day / per-week limit breaches. The
        // detection logic already exists (findCategoryViolations, run by the
        // daily calendar-health sweep) but was never wired into the INTERACTIVE
        // review, so "how does my week look?" never flagged e.g. 4 Weeklies on a
        // day whose limit is 3. Mirror calendarHealth's pass and merge each
        // violation into the day it lands on (per_week → its week-start day, or
        // day 0 when that week-start falls outside the queried range).
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { findCategoryViolations } = require('../../../../utils/categoryRules') as
            typeof import('../../../../utils/categoryRules');
          const rangeStart = DateTime.fromISO(args.start_date as string, { zone: timezone }).startOf('day');
          const rangeEnd = DateTime.fromISO(args.end_date as string, { zone: timezone }).endOf('day');
          const violations = findCategoryViolations({ events: rawEvents, profile: context.profile, rangeStart, rangeEnd });
          for (const v of violations) {
            const target = analysis.find(d => d.date === v.window_start) ?? analysis[0];
            if (!target) continue;
            const where = v.rule_broken === 'per_day' ? `on ${v.window_label}` : `in the ${v.window_label}`;
            target.issues.push({
              type: 'category_over_limit',
              severity: 'medium',
              detail: `${v.category_name} ${v.rule_broken.replace('_', '-')} limit is ${v.rule_value}; ${where} there ${v.current_count === 1 ? 'is' : 'are'} ${v.current_count}.`,
              suggestedFix: 'Move one to another day, or confirm it\'s intentional.',
            });
          }
        } catch (err) {
          logger.warn('analyze_calendar — category violation pass threw, skipping', { err: String(err).slice(0, 200) });
        }
        // v3.3 (fix #2) — attach the Working Elsewhere note when the range has
        // WE days, so issue-narration is framed in the away timezone too.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const weModAc = require('../../../../utils/workingElsewhere') as typeof import('../../../../utils/workingElsewhere');
        const weNoteAc = weModAc.summarizeWorkingElsewhere(context.profile, args.start_date as string, args.end_date as string);
        return weNoteAc ? { day_analysis: analysis, ...weNoteAc } : analysis;
}

export async function handleGetFreeBusy(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
        try {
          const raw = await getFreeBusy(userEmail, args.emails as string[], args.start_date as string, args.end_date as string, timezone, args.force_refresh === true);
          // v2.1.5 — for colleague-context asks, synthesize out-of-work-hours
          // busy blocks on the OWNER's row so the free gaps returned to Sonnet
          // are already clipped to the owner's work hours. A colleague should not
          // be able to learn that 09:00 is free when the office day starts at
          // 10:30 — out-of-hours availability requires explicit owner override,
          // not a drive-by "check get_free_busy" bypass. Owner-path calls get
          // raw data (owner knows their own schedule and may want all gaps).
          const isColleaguePath = context.senderRole === 'colleague' && context.isOwnerInGroup !== true;
          if (isColleaguePath && Array.isArray(args.emails) && (args.emails as string[]).includes(userEmail)) {
            const ownerBusy = raw[userEmail] ?? [];
            const synthetic = buildOutOfHoursBusy(
              args.start_date as string,
              args.end_date as string,
              context.profile,
              timezone,
            );
            raw[userEmail] = [...ownerBusy, ...synthetic];
          }
          // #WE-spine — owner free/busy on a travel day: attach the away-tz note
          // so "am I free Wed 3pm?" on a Boston day isn't answered in a misleading
          // home clock. Record-based (summarizeWorkingElsewhere with no events →
          // travel-record only, ZERO Graph) — the SAME one-source the search uses.
          let weFbNote: string | null = null;
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const weModFb = require('../../../../utils/workingElsewhere') as typeof import('../../../../utils/workingElsewhere');
            const weFb = weModFb.summarizeWorkingElsewhere(context.profile, args.start_date as string, args.end_date as string);
            weFbNote = weFb?._working_elsewhere_note ?? null;
          } catch { /* fail open — no note */ }
          // Daniel-bug (offer-then-retract) — get_free_busy returns RAW per-person
          // blocks, NOT a validated set of common bookable slots. When it's called
          // with attendees, presenting its gaps as "both free / best bet" is
          // owner-only eyeballing that contradicts the booking check (planMeeting
          // DOES intersect attendees) → the 14:30 "both free" then "both busy"
          // flip. Steer to find_available_slots, the one tool that intersects
          // everyone's calendar + work hours. (Stronger than the static tool
          // description, which Sonnet ignored — this rides the result it just read.)
          const emailsArg = Array.isArray(args.emails) ? (args.emails as string[]) : [];
          const hasOtherAttendees = emailsArg.some(e => e && e.toLowerCase() !== userEmail.toLowerCase());
          if (hasOtherAttendees) {
            return {
              ...(raw as Record<string, unknown>),
              ...(weFbNote ? { _working_elsewhere_note: weFbNote } : {}),
              _note: 'These are RAW per-person free/busy blocks, NOT a validated set of common bookable slots. To present bookable meeting options across these people (or ANY meeting with attendees), call find_available_slots — it intersects everyone\'s calendar + work hours. Do NOT offer gaps from this result as "both free" / "best bet"; that is owner-only eyeballing and will contradict the attendee check at booking time.',
            };
          }
          return weFbNote ? { ...(raw as Record<string, unknown>), _working_elsewhere_note: weFbNote } : raw;
        } catch (err) {
          if (err instanceof GraphPermissionError) {
            return {
              error: 'calendar_permission_denied',
              message: 'I can read your calendar but I don\'t have permission to check other people\'s availability. ' +
                `The Azure app needs Calendars.Read application permission granted by a ${context.profile.user.company ?? 'company'} tenant admin. ` +
                'Tell the user you cannot check their colleagues\' schedules right now due to a permissions issue, ' +
                'and ask if they know when those people are free.',
            };
          }
          throw err;
        }
}

export async function handleDeleteMeeting(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
        // Defense-in-depth: refuse a series-level delete if the id resolves
        // to a seriesMaster. Mirrors the guard in update_meeting and
        // move_meeting. get_calendar normally returns occurrence ids
        // (Graph calendarView expands recurring series), so a master id
        // should never reach here through the normal path — but if it
        // ever does, a one-shot mistake would wipe an entire recurring
        // series. This probe runs BEFORE the planMeeting / decline_and_relay
        // path so a series-master refusal doesn't first fire an organizer
        // DM saying "won't make it" for a meeting that ends up untouched.
        // Also captures the event's start date so the success audit_log
        // entry can record WHICH DAY was deleted (active-mode's
        // missing_floating_block branch reads this).
        let preDeleteStartIso: string | undefined;
        let preDeleteSubject: string | undefined;
        try {
          const { getEventType } = await import('../../../../connectors/graph/calendar');
          const probe = await getEventType(userEmail, args.meeting_id as string);
          if (probe?.type === 'seriesMaster') {
            logger.info('delete_meeting refused on recurring seriesMaster', {
              meetingId: args.meeting_id,
              subject: probe.subject,
            });
            return {
              error: 'recurring_series_master',
              meeting_subject: probe.subject,
              message: `"${probe.subject}" is a recurring series. Deleting the series here would cancel every occurrence — that's not safe to do automatically. To cancel a single occurrence, call delete_meeting with that occurrence's meeting_id (get it from get_calendar for the specific date). To end the series itself, the owner should do that directly in Outlook.`,
            };
          }
          preDeleteStartIso = probe?.startDateTime;
          preDeleteSubject = probe?.subject;
        } catch (err) {
          logger.warn('delete_meeting recurring-preflight failed — proceeding', { err: String(err) });
        }

        // Track auto-relay outcome so Sonnet narrates honestly:
        //   'sent'                  → DM went out to the organizer (Slack)
        //   'skipped_no_slack_id'   → organizer is external / not in workspace;
        //                              owner-side decline still landed but the
        //                              organizer was NOT notified
        //   'not_attempted'         → owner is the organizer (no relay needed)
        let relayStatus: 'sent' | 'skipped_no_slack_id' | 'not_attempted' = 'not_attempted';
        let relayOrganizerName: string | null = null;
        let relayOrganizerEmail: string | null = null;
        // Ownership-aware delete via planMeeting.
        // Path tree (per D3 / Q1=B / D4):
        //   - owner is organizer → proceed with delete (existing flow below)
        //   - owner is attendee + asker is the requester/organizer → decline on
        //     owner's side (effectively the same Graph delete call from owner's
        //     calendar — Graph drops the event from his view)
        //   - owner is attendee + asker is someone ELSE (incl. owner himself) →
        //     decline on owner's side + auto-DM the organizer politely
        try {
          const { planMeeting, planInputFromBookingRequest } = await import('../../planMeeting');
          const { normalizeBookingRequest } = await import('../../bookingRequest');
          // v2.9.0 — normalized BookingRequest for the cancel path. Owner-
          // in-participants invariant lets findMeetingOwner / decline-and-
          // relay branch reason over a uniform shape. The cancel intent
          // doesn't carry a slot or other attendees by default — the
          // normalizer + planMeeting handle the absent fields gracefully.
          const cancelReq = await normalizeBookingRequest('delete_meeting', args, context, { intent: 'cancel' });
          // Carry the subject through for narration (delete_meeting passes
          // meeting_subject, not subject — normalizer doesn't auto-fetch it).
          if (!cancelReq.subject && typeof args.meeting_subject === 'string') {
            cancelReq.subject = args.meeting_subject;
          }
          const decision = await planMeeting(planInputFromBookingRequest(cancelReq, context.profile));
          if (decision.action === 'refuse_not_owners') {
            const ownerFirst = context.profile.user.name.split(' ')[0];
            const orgName = decision.organizerName ?? decision.organizerEmail ?? 'the organizer';
            return {
              error: 'not_organizer_refuse',
              meeting_subject: args.meeting_subject,
              organizer_name: decision.organizerName,
              organizer_email: decision.organizerEmail,
              message: `Can't cancel "${args.meeting_subject}" — ${orgName} organized that one. Only the organizer can cancel for everyone. I can remove it from ${ownerFirst}'s calendar though if that helps.`,
            };
          }
          if (decision.action === 'decline_and_relay') {
            // Proceed with the Graph delete (which removes from owner's calendar)
            // AND post the organizer-DM in parallel (fire-and-forget). Track
            // whether the DM was actually attempted so the tool result tells
            // Sonnet the honest story — no over-claiming "I notified the
            // organizer" when the organizer has no slack_id (external).
            const orgEmail = decision.organizerEmail;
            const orgSlackId = decision.organizerSlackId;
            const orgName = decision.organizerName;
            const dmText = decision.suggestedDmText;
            logger.info('delete_meeting — decline_and_relay path', {
              meetingId: args.meeting_id, organizer: orgEmail, orgSlackId,
            });
            if (orgSlackId) {
              relayStatus = 'sent';
              relayOrganizerName = orgName;
              setImmediate(async () => {
                try {
                  const { getConnection } = await import('../../../../connections/registry');
                  const conn = getConnection(context.profile.user.slack_user_id, 'slack');
                  if (conn) await conn.sendDirect(orgSlackId, dmText);
                } catch (err) {
                  logger.warn('decline_and_relay DM threw — non-fatal', {
                    err: String(err).slice(0, 200), meetingId: args.meeting_id,
                  });
                }
              });
            } else {
              // External organizer or unresolved Slack identity — no DM can be
              // sent on Slack. Sonnet must NOT claim "I notified the organizer".
              relayStatus = 'skipped_no_slack_id';
              relayOrganizerName = orgName;
              relayOrganizerEmail = orgEmail;
            }
          }
        } catch (err) {
          logger.warn('delete_meeting planMeeting threw — proceeding with raw delete', {
            err: String(err).slice(0, 200), meetingId: args.meeting_id,
          });
        }

        await deleteMeeting(userEmail, args.meeting_id as string);
        // v2.1.6 — verify the delete actually landed. Graph can return 200 OK
        // on the DELETE but still retain the event (rare: partial failures,
        // recurring-series exception edge cases). Without this check the LLM
        // would claim "cancelled" even when the event was still on the
        // calendar, and then blame "sync delay" when the owner pointed it
        // out. Now the tool returns the truth and the LLM narrates that.
        const confirmedGone = await verifyEventDeleted(userEmail, args.meeting_id as string);
        if (!confirmedGone) {
          auditLog({
            action: 'delete_meeting',
            source: context.channel,
            actor: context.userId,
            target: args.meeting_id as string,
            details: { subject: args.meeting_subject, reason: 'still_present_after_delete' },
            outcome: 'failure',
          });
          return {
            success: false,
            error: 'still_present_after_delete',
            subject: args.meeting_subject,
            message: `Delete call returned success but "${args.meeting_subject}" is still on the calendar. Tell the owner honestly — don't claim it's deleted.`,
          };
        }
        await closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'deleted',
          subject: args.meeting_subject as string | undefined,
          bookingThreadTs: context.threadTs,
          fulfillingRequestId: args._fulfilling_request_id as string | undefined,
        });
        // v3.1.7 / #119 — if the deleted event was a floating block (lunch,
        // etc.), record a date-scoped dismissal so active-mode health doesn't
        // re-book the gap the owner just cleared. Keyed to the exact day via the
        // synthetic event_id, so only THIS day is suppressed — future
        // same-weekday blocks still get placed. Subject-only match (categories
        // aren't captured pre-delete). Non-fatal on any failure.
        try {
          const delStartIso = preDeleteStartIso;
          const delSubject = (args.meeting_subject ?? preDeleteSubject ?? '') as string;
          if (delStartIso && delSubject) {
            const fbMod = require('../../../../utils/floatingBlocks') as typeof import('../../../../utils/floatingBlocks');
            const matchedBlock = fbMod.getFloatingBlocks(context.profile)
              .find(b => fbMod.isFloatingBlockEvent({ subject: delSubject }, b));
            if (matchedBlock) {
              const synth = fbMod.floatingBlockSyntheticEventId(
                context.profile, matchedBlock.name, delStartIso.slice(0, 10), context.profile.user.timezone,
              );
              if (synth) {
                dismissFloatingBlockGap({
                  ownerUserId: context.profile.user.slack_user_id,
                  eventId: synth.eventId,
                  eventDate: delStartIso.slice(0, 10),
                  eventEndMs: synth.eventEndMs,
                  notes: `Owner deleted ${matchedBlock.name} on ${delStartIso.slice(0, 10)} — gap waived (won't re-book).`,
                });
                logger.info('delete_meeting — floating-block gap dismissed', {
                  block: matchedBlock.name, date: delStartIso.slice(0, 10), syntheticEventId: synth.eventId,
                });
              }
            }
          }
        } catch (err) {
          logger.warn('delete_meeting: floating-block dismissal write failed — non-fatal', {
            err: String(err).slice(0, 200),
          });
        }
        auditLog({
          action: 'delete_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          // v2.8.5 — `event_start_iso` lets active-mode's
          // missing_floating_block branch read recent deletions and skip
          // re-booking on a day the owner just cleared. `subject` falls back
          // to the Graph probe when Sonnet didn't pass meeting_subject (the
          // probe runs on the same id, so the names match).
          details: {
            subject: args.meeting_subject ?? preDeleteSubject,
            event_start_iso: preDeleteStartIso,
          },
          outcome: 'success',
        });

        // v3.2.x (Tier 1) — a delete frees the deleted event's slot, which may
        // open a displaced floating block's window. Run the same post-mutation
        // rebalance (move_meeting/create_meeting already do) and surface any
        // reclaim candidate as a PROPOSE-ONLY offer. Guarded on preDeleteStartIso
        // (the freed slot); skipped if the pre-delete probe didn't capture it.
        let reclaimable: import('../../../../utils/rebalanceFloatingBlocks').ReclaimableBlock[] = [];
        if (preDeleteStartIso) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { rebalanceFloatingBlocksAfterMutation } = require('../../../../utils/rebalanceFloatingBlocks') as
              typeof import('../../../../utils/rebalanceFloatingBlocks');
            const rebal = await rebalanceFloatingBlocksAfterMutation({
              profile: context.profile,
              affectedSlotIso: preDeleteStartIso,
              ownerSlackId: context.profile.user.slack_user_id,
            });
            reclaimable = rebal?.reclaimable ?? [];
          } catch (err) {
            logger.warn('rebalance after delete_meeting threw — continuing', { err: String(err).slice(0, 200) });
          }
        }

        // v2.7.0 — narrate the relay outcome honestly. Three shapes:
        //   sent                 → "Removed it from your side. I let <name> know."
        //   skipped_no_slack_id  → "Removed it from your side. <name> organized this one
        //                          but they're not in Slack so I couldn't ping them — you
        //                          may want to email them directly."
        //   not_attempted        → "Cancelled it." (owner was organizer; no relay needed)
        let actionSummary = `Cancelled '${args.meeting_subject}'.`;
        if (relayStatus === 'sent') {
          actionSummary = `Removed '${args.meeting_subject}' from your calendar. I let ${relayOrganizerName ?? 'the organizer'} know on Slack.`;
        } else if (relayStatus === 'skipped_no_slack_id') {
          actionSummary = `Removed '${args.meeting_subject}' from your calendar. ${relayOrganizerName ?? 'The organizer'} set it up${relayOrganizerEmail ? ` (${relayOrganizerEmail})` : ''} but they're not in Slack — you may want to email them directly to cancel for everyone.`;
        }
        return {
          success: true,
          deleted: args.meeting_subject,
          // v3.x — surface the deleted event's start so the reply can name the
          // day+time FROM the tool result (DELETE-MEETING PROTOCOL step 6),
          // instead of from lossy chat memory. Captured pre-delete at the probe.
          deleted_start_iso: preDeleteStartIso,
          relay_status: relayStatus,
          organizer_name: relayOrganizerName ?? undefined,
          organizer_email: relayOrganizerEmail ?? undefined,
          // v3.2.x — a displaced floating block whose window this delete freed.
          // PROPOSE-ONLY: the reply offers to bring it home; not auto-moved.
          ...(reclaimable.length ? { reclaimable_block: reclaimable[0] } : {}),
          action_summary: actionSummary,
          _note: relayStatus === 'skipped_no_slack_id'
            ? 'IMPORTANT: do NOT claim "I notified the organizer" — the organizer has no Slack account, no DM was sent. Tell the owner that explicitly and offer to draft an email if they want.'
            : undefined,
        };
}

