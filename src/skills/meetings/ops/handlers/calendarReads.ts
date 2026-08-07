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
  findDuplicateEvent,
  findReschedulableSibling,
  type CalendarEvent,
  getFreeBusy,
  findAvailableSlots,
  createMeeting,
  deleteMeeting,
  declineMeeting,
  verifyEventDeleted,
  updateMeeting,
  GraphPermissionError,
} from '../../../../connectors/graph/calendar';
import {
  getDb,
  auditLog,
  dismissFloatingBlockGap,
  searchPeopleMemory,
  getPersonMemory,
} from '../../../../db';
import { closeMeetingArtifacts } from '../../../../utils/closeMeetingArtifacts';
import { reinterpretClockInZone, renderClockInZone } from '../../../../utils/timezoneConvert';
import { resolveStatedInstant, renderWeDualClock } from '../../../../utils/weTimeResolver';
import { checkIntendedWeekday } from '../../../../utils/weekdayGuard';
import { displaySubject, subjectViewerFor, viewerEmailFor, PRIVATE_MASK } from '../../../../utils/displaySubject';
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
        // ── Who may see how much (#8a) ────────────────────────────────────────
        // A SHARED surface (group DM / channel) is never a private one. The
        // transport clamps every sender there — the owner included — to
        // senderRole 'colleague' (processMessage.ts:122), so that single field is
        // the whole test. It used to be written
        // `senderRole === 'colleague' && isOwnerInGroup !== true`, and that
        // second clause was an escape hatch: in a group DM the owner's OWN turn
        // skipped the clamp entirely and this handler returned his FULL calendar
        // — every subject, every attendee list — into the context of a thread
        // colleagues read. Nothing but the model's discretion stood between that
        // payload and disclosure, which is the inversion shared rule 10 forbids.
        const isSharedSurface = context.senderRole === 'colleague';
        // The requester's AUTHENTICATED identity (Slack-verified sender vs the
        // configured owner id) — never a claim made in a message. Needed because
        // the scoped view below filters to "events this requester is on": when
        // the requester IS the owner, that predicate matches his entire calendar,
        // so dropping the escape hatch alone would have returned the same leak
        // wearing a `_colleague_view: true` label. On a shared surface the owner
        // gets NO calendar listing at all — he asks in his own DM.
        const requesterIsOwner = context.userId === context.profile.user.slack_user_id;
        if (isSharedSurface && requesterIsOwner) {
          logger.info('get_calendar — owner asked on a shared surface; calendar listing withheld', {
            channelId: context.channelId, isMpim: context.isMpim === true,
          });
          // gh#157 (2026-07-29) / gh#166 (2026-07-29) — this branch has no
          // scoped-by-colleague view to fall back on (every event on the
          // calendar is "his"), so there is nothing safe to hand back as data.
          // The old shape returned `events: []` — the literal wire shape of
          // "checked, nothing's there" — and needed a comment to explain that
          // it actually meant WITHHELD; Sonnet read the array, not the
          // comment, and fabricated "there's nothing on the calendar at all,
          // no Leadership Alignment" for a meeting that had existed for
          // months. An `error` shape (matching every other owner-only /
          // withheld refusal in this file: `owner_only`, `freebusy_not_read`,
          // `event_not_found`) means there is no `events` key at all to
          // misread — and the generic FAILED handling in
          // orchestrator/turnHelpers.ts persists this same honest refusal
          // into conversation history instead of "0 events", which is the
          // ambiguity that mattered on the NEXT turn, not just this one.
          return {
            error: 'calendar_withheld_shared_surface',
            message: `This is a group conversation, so ${context.profile.user.name.split(' ')[0]}'s calendar is not readable here — other people are in this thread. You have NOT checked his calendar: do NOT say or imply that nothing exists, that nothing is booked, or that something "hasn't been booked yet". Do NOT list, summarise, count, confirm, or deny anything about his day, and do NOT try another tool to get around it. Tell him plainly you can't check or confirm calendar details on a shared surface and you'll go through it with him in your 1:1 DM. You can still ACT on one specific meeting he references by name/id here (move it, cancel it) — that is not the same as confirming whether something exists, and must never be used to answer an existence question.`,
          };
        }
        const rawEvents = await getCalendarEvents(
          userEmail,
          args.start_date as string,
          args.end_date as string,
          timezone,
          // v3.2.x (#121) — user asked to LOOK now → past both caches. The key is
          // the normalized day window now, so this also refreshes the entry the
          // slot finder reads instead of a parallel spelling of the same day.
          args.force_refresh === true ? 'force' : 'cached',
        );
        // v4.1.x (M12) — the owner reading his OWN calendar in his own DM sees
        // his real subjects; every other surface (colleague, or the owner in an
        // MPIM where colleagues read along) keeps the [Private] mask.
        const processed = processCalendarEvents(
          rawEvents, userEmail, context.profile.user.name, timezone, context.profile,
          subjectViewerFor(context),
        );

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
            const ownerUserId = context.profile.user.slack_user_id;
            const audits = recentAuditEntries({ ownerUserId, action: 'delete_meeting', windowDays: 7 });
            const auditsCreate = recentAuditEntries({ ownerUserId, action: 'create_meeting', windowDays: 7 });
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
        // Shared-surface requester who is NOT the owner: scope to the meetings
        // they are actually on. (The owner-on-a-shared-surface case returned at
        // the top of this handler — there is no scoped view that means anything
        // for him, since every event is "his".)
        if (isSharedSurface) {
          // gh#154-R1 (owner ruling 2026-08-06, verbatim: "o#230 - is revert and
          // then do trace only for that, as this is a core security item.")
          // — o#230 widened this branch to list EVERY meeting on the
          // calendar (existence + time + attendee names) with only the
          // subject gated to attendance. REVERTED to the pre-o#230 scope: a
          // colleague sees ONLY the meetings they are themselves an
          // attendee or organizer of. The wider capability (existence + time
          // + attendee names for meetings they're not on) is NOT preserved
          // here in any partial form — it returns later as its own item.
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
          // Colleague view — masked by construction (no viewer arg = 'other').
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
        // gh#180 (bounce 2) — the colleague-masked view of the same subject,
        // stored alongside `subject` (owner view) by autoMove.ts specifically
        // so THIS re-notify DM to colleagues never carries the real title of
        // a meeting the owner marked private. Records written before this
        // field existed (pre-deploy, within the 12h revert TTL) have no
        // `colleague_subject` — fall back to the mask rather than the owner's
        // real subject: M12's "permission unclear → return less" default.
        const revColleagueSubject = typeof oc.colleague_subject === 'string' ? oc.colleague_subject : PRIVATE_MASK;
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
          const { dismissOverlapIssue, DISMISSAL_NEVER_EXPIRES } = await import('../../../../db/calendarIssues');
          dismissOverlapIssue({
            ownerUserId,
            eventId,
            peerEventId: keptEventId,
            eventDate: DateTime.fromISO(originalStart, { zone: timezone }).toFormat('yyyy-MM-dd'),
            // gh#180 — NOT the occurrence's own end. That snapshot goes stale the
            // moment this same event is later rescheduled further out (the
            // terminal-row cascade skip means it's never refreshed), silently
            // un-suppressing an autofix the owner already rejected. A stated
            // "don't touch this event again" is permanent, by event id.
            eventEndMs: DISMISSAL_NEVER_EXPIRES,
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
                await conn?.sendDirect(sid, `Quick update: "${revColleagueSubject}" is back to its original time (${origLocal}) — please disregard my earlier note about moving it.`);
                reNotified++;
              } catch { /* skip one */ }
            }
          } catch { /* messaging unavailable */ }
        }
        const restoredLocal = DateTime.fromISO(originalStart, { zone: timezone }).toFormat('EEE d MMM HH:mm');
        // gh#180 — the active-mode auto-move's shadowNotify (autoMove.ts) told the
        // owner "I moved X to Y... say revert if you'd rather I hadn't" as a
        // STANDALONE DM (no threadTs — see autoMove.ts's call), separate from
        // whatever conversation the "revert" command itself arrives in. Threading
        // this correction under context.threadTs (the revert command's OWN
        // thread) does not put it anywhere near that original claim — it's a
        // different thread entirely, so the stale "moved to Y" message still
        // sits uncorrected (owner: "it just said it did it, not really did").
        // Fix: use the SAME conversationKey (the auto-move request id) the
        // original call tagged itself with — shadowNotify's own threading cache
        // then replies under that exact message regardless of where THIS
        // command came from.
        try {
          const { shadowNotify } = await import('../../../../utils/shadowNotify');
          await shadowNotify(context.profile, {
            channel: context.channelId,
            icon: '🔧',
            action: 'Active-mode autofix — reverted',
            detail: `Reverted "${revSubject}" back to ${restoredLocal} — disregard my earlier note about moving it.`,
            conversationKey: rec.id,
          });
        } catch (e) { logger.warn('revert_last_auto_move — owner correction shadowNotify threw', { err: String(e).slice(0, 160) }); }
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
        // v4.1.x (M12) — owner-only tool, but still masked when he runs it in an
        // MPIM (colleagues read that transcript).
        const processed = processCalendarEvents(
          rawEvents, userEmail, context.profile.user.name, timezone, context.profile,
          subjectViewerFor(context),
        );
        // v3.0.3 — analyzeCalendar is read-only; suppression is handled at
        // row-write time elsewhere. (The dead `void getSuppressedEventIds(...)`
        // that used to sit here was removed in v4.2.x — it read the set and threw
        // it away, so it only made the suppression surface look wider than it is.)
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
          // P15 — `notChecked` = the read never happened (malformed window / Graph
          // rejected it). Pre-fix this tool returned `{}`, which is the literal
          // wire shape of "nobody has a single busy block" — so the answer to "is
          // he free?" was an unqualified yes, from a call that never reached his
          // calendar. Reported as an explicit refusal-to-answer below, not as data.
          const fbDiag: { notChecked?: string[] } = {};
          const raw = await getFreeBusy(userEmail, args.emails as string[], args.start_date as string, args.end_date as string, timezone, args.force_refresh === true ? 'force' : 'cached', fbDiag);
          if ((fbDiag.notChecked ?? []).length > 0) {
            logger.warn('get_free_busy — the free/busy read never happened; refusing to report anyone as free', {
              emails: args.emails, start_date: args.start_date, end_date: args.end_date,
            });
            return {
              error: 'freebusy_not_read',
              not_checked: fbDiag.notChecked,
              message: `I could not read free/busy for ${(fbDiag.notChecked ?? []).join(', ')} — the window I was given (${String(args.start_date)} → ${String(args.end_date)}) could not be queried, so NO calendar was actually looked at. This is NOT "they are free": say you could not check, or retry with a valid start_date/end_date where the end is after the start.`,
            };
          }
          // v2.1.5 — for colleague-context asks, synthesize out-of-work-hours
          // busy blocks on the OWNER's row so the free gaps returned to Sonnet
          // are already clipped to the owner's work hours. A colleague should not
          // be able to learn that 09:00 is free when the office day starts at
          // 10:30 — out-of-hours availability requires explicit owner override,
          // not a drive-by "check get_free_busy" bypass. Owner-path calls get
          // raw data (owner knows their own schedule and may want all gaps).
          // v4.1.x (#8a) — keyed on the effective senderRole ALONE, the same as
          // get_calendar's clamp above. The old `&& isOwnerInGroup !== true`
          // escape is gone: a shared surface is never a private one, whoever is
          // typing. This particular branch is currently unreachable (get_free_busy
          // is not colleague-allowed, so the registry chokepoint refuses it first)
          // — but leaving a second copy of a pattern that was a real leak next
          // door is how it comes back.
          const isSharedSurface = context.senderRole === 'colleague';
          if (isSharedSurface && Array.isArray(args.emails) && (args.emails as string[]).includes(userEmail)) {
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
        const meetingId = args.meeting_id as string;
        // Defense-in-depth: refuse a series-level delete if the id resolves
        // to a seriesMaster. Mirrors the guard in update_meeting and
        // move_meeting. get_calendar normally returns occurrence ids
        // (Graph calendarView expands recurring series), so a master id
        // should never reach here through the normal path — but if it
        // ever does, a one-shot mistake would wipe an entire recurring
        // series. This probe runs BEFORE the planMeeting / decline path
        // so a series-master refusal never touches the calendar.
        // Also captures the event's start so the success audit_log entry can
        // record WHICH DAY was cancelled (active-mode's
        // missing_floating_block branch reads this) and so the reply can name
        // the occurrence from the calendar rather than from chat memory.
        let preDeleteStartIso: string | undefined;
        let preDeleteStartTz: string | undefined;
        let preDeleteSubject: string | undefined;
        // gh#154-R2 (2026-08-06) — the masked (display) version of preDeleteSubject,
        // authoritative because it comes from the probe, never from
        // args.meeting_subject (model-supplied, can carry the real title from
        // earlier context regardless of THIS turn's surface).
        let preDeleteSubjectMasked: string | undefined;
        try {
          const { getEventType } = await import('../../../../connectors/graph/calendar');
          const probe = await getEventType(userEmail, meetingId);
          if (probe?.type === 'seriesMaster') {
            // o#216 — same mask as update_meeting/move_meeting's seriesMaster
            // refusals (moveMeeting.ts). delete_meeting became newly reachable
            // from a room this wave (OWNER_ROOM_ACTION_TOOLS, registry.ts) —
            // this is the leak that wave widened, since the raw probe.subject
            // would otherwise render into a room full of colleagues.
            // gh#154-W5/gh#154-R4 (2026-08-06) — room-tightening lives inside
            // viewerEmailFor now (surface==='room' → null); call it directly
            // — a blanket ?? null here also masked the email leg's subjects.
            const maskedSubject = displaySubject(
              { subject: probe.subject, sensitivity: probe.sensitivity, categories: probe.categories, organizer: probe.organizer, attendees: probe.attendees },
              context.profile,
              subjectViewerFor(context),
              viewerEmailFor(context),
            );
            logger.info('delete_meeting refused on recurring seriesMaster', {
              meetingId, subject: probe.subject,
            });
            return {
              error: 'recurring_series_master',
              meeting_subject: maskedSubject,
              message: `"${maskedSubject}" is a recurring series. Deleting the series here would cancel every occurrence — that's not safe to do automatically. To cancel a single occurrence, call delete_meeting with that occurrence's meeting_id (get it from get_calendar for the specific date). To end the series itself, the owner should do that directly in Outlook.`,
            };
          }
          preDeleteStartIso = probe?.startDateTime;
          preDeleteStartTz = probe?.startTimeZone;
          preDeleteSubject = probe?.subject;
          // gh#154-R2 (2026-08-06) — the SAME mask, computed here (the one place
          // that has the raw probe) and carried through to the SUCCESS
          // narration below (`cancelledSubject`). Pre-fix only the refusal
          // branch above was masked; the success path shipped probe.subject
          // raw all the way to `cancelled_label` / `action_summary` — the
          // exact leak the refusal fix was supposed to close for this
          // room-reachable tool (o#216).
          preDeleteSubjectMasked = probe
            ? displaySubject(
                { subject: probe.subject, sensitivity: probe.sensitivity, categories: probe.categories, organizer: probe.organizer, attendees: probe.attendees },
                context.profile,
                subjectViewerFor(context),
                viewerEmailFor(context),
              )
            : undefined;
        } catch (err: any) {
          // #147.2 — a STALE id (already cancelled earlier in the thread, or a
          // dead id from an injected ledger block) must come back as "it isn't
          // there", never as a cancellation. Pre-fix the probe just warned and
          // the flow carried on: the organizer lookup failed too, so the plan
          // fell to the attendee branch, and the raw Graph 404 surfaced as
          // `[delete_meeting FAILED: The specified object was not found in the
          // store]` — a leaked mechanism string (M11) that the model then
          // folded into "all 11 declined". Stop here with the real reason and
          // change nothing. Only NOT-FOUND takes this exit; a transient Graph
          // fault still falls through so a live meeting is never reported gone.
          const code = err?.statusCode ?? err?.code;
          const notFound = code === 404 || code === 'ErrorItemNotFound'
            || /not found in the store/i.test(String(err?.message ?? err));
          if (notFound) {
            logger.info('delete_meeting — event no longer on the calendar, nothing to cancel', {
              meetingId, subject: args.meeting_subject,
            });
            // Drop the dead id from both thread ledgers so the next turn stops
            // presenting it as live and the model stops retrying it.
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { forgetThreadEvent } = require('../../../../utils/threadEventLedger') as
                typeof import('../../../../utils/threadEventLedger');
              if (context.threadTs) forgetThreadEvent(context.threadTs, meetingId);
            } catch { /* non-fatal */ }
            return {
              success: false,
              error: 'event_not_found',
              meeting_subject: args.meeting_subject,
              message: `"${args.meeting_subject}" is not on the calendar under that id — it was already cancelled, or the id is stale. Nothing was changed by this call. Do NOT count it as one you just cancelled; if it should still exist, re-read the day with get_calendar and use the id from there.`,
            };
          }
          logger.warn('delete_meeting recurring-preflight failed — proceeding', { err: String(err) });
        }

        // ── Which Graph verb, and therefore who Outlook notifies ────────────
        // #147.1/.2/.4 — ONE ownership decision (planMeeting → findMeetingOwner),
        // TWO Graph verbs, and the notification claim derived from whichever
        // actually landed. Pre-fix this handler called `deleteMeeting` for every
        // path: Graph refuses /cancel for a non-organizer with 400, so every
        // attendee-side decline silently degraded to a bare DELETE and the
        // organizer was told NOTHING (17 of these in the 2026-07-26 log). Maelle
        // covered for that with a fire-and-forget Slack DM whose `relayStatus`
        // was set to 'sent' BEFORE the send and never checked after — the "Julia's
        // been notified" that hadn't gone out — and whose text said Idan "won't be
        // able to make it anymore" once per occurrence, reading as forever when
        // two dates were declined. That whole relay layer is deleted: the
        // organizer's notice is now Outlook's own per-occurrence decline
        // response, which cannot claim more than happened.
        let declineAsAttendee = false;
        let roleResolved = false;
        let organizerName: string | null = null;
        let organizerEmail: string | null = null;
        try {
          const { planMeeting, planInputFromBookingRequest } = await import('../../planMeeting');
          const { normalizeBookingRequest } = await import('../../bookingRequest');
          // v2.9.0 — normalized BookingRequest for the cancel path. The
          // owner-in-participants invariant lets findMeetingOwner reason over a
          // uniform shape. The cancel intent doesn't carry a slot or other
          // attendees by default — the normalizer + planMeeting handle the
          // absent fields gracefully.
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
          roleResolved = true;
          if (decision.action === 'decline_as_attendee') {
            declineAsAttendee = true;
            organizerName = decision.organizerName;
            organizerEmail = decision.organizerEmail;
            logger.info('delete_meeting — declining the owner copy (he is an attendee)', {
              meetingId, organizer: organizerEmail,
            });
          }
        } catch (err) {
          logger.warn('delete_meeting planMeeting threw — proceeding with raw delete', {
            err: String(err).slice(0, 200), meetingId,
          });
        }

        // Who Outlook actually told — read off the call that ran, never asserted.
        let notifiedVia: 'outlook_decline_to_organizer' | 'outlook_cancellation_to_attendees' | 'nobody' | 'unknown';
        let notifiedWho: string | null = null;
        if (declineAsAttendee) {
          const { notified } = await declineMeeting(userEmail, meetingId);
          notifiedVia = notified === 'organizer' ? 'outlook_decline_to_organizer'
            : notified === 'attendees' ? 'outlook_cancellation_to_attendees'
            : 'nobody';
          notifiedWho = notified === 'organizer' ? (organizerName ?? organizerEmail ?? 'the organizer')
            : notified === 'attendees' ? 'everyone on the invite'
            : null;
        } else {
          const { cancellationSent } = await deleteMeeting(userEmail, meetingId);
          notifiedVia = !roleResolved ? 'unknown' : (cancellationSent ? 'outlook_cancellation_to_attendees' : 'nobody');
          notifiedWho = notifiedVia === 'outlook_cancellation_to_attendees' ? 'everyone on the invite' : null;
        }
        // v2.1.6 — verify the delete actually landed. Graph can return 200 OK
        // on the DELETE but still retain the event (rare: partial failures,
        // recurring-series exception edge cases). Without this check the LLM
        // would claim "cancelled" even when the event was still on the
        // calendar, and then blame "sync delay" when the owner pointed it
        // out. Now the tool returns the truth and the LLM narrates that.
        const confirmedGone = await verifyEventDeleted(userEmail, meetingId);
        if (!confirmedGone) {
          auditLog({
            ownerUserId: context.profile.user.slack_user_id,
            action: 'delete_meeting',
            source: context.channel,
            actor: context.userId,
            target: meetingId,
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
        // #147.2 — the cancel is now CONFIRMED, so retire the id from both thread
        // ledgers here, at the one place that knows it landed. The orchestrator's
        // generic tool loop tried to do this but keyed on `event_id`/`id`, and
        // delete_meeting's argument is `meeting_id` — so it never fired once, and
        // every cancelled occurrence stayed in the injected "already on his
        // calendar" block for the rest of the thread.
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { forgetThreadEvent } = require('../../../../utils/threadEventLedger') as
            typeof import('../../../../utils/threadEventLedger');
          if (context.threadTs) forgetThreadEvent(context.threadTs, meetingId);
        } catch { /* non-fatal */ }
        await closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId,
          reason: 'deleted',
          subject: args.meeting_subject as string | undefined,
          bookingThreadTs: context.threadTs,
          fulfillingRequestId: args._fulfilling_request_id as string | undefined,
        });
        // #147.2 / M13-M14 — resolve the cancelled occurrence's instant ONCE, in
        // code, and reuse it for every consumer below (the floating-block day, the
        // narration label). `getEventType` sends no `Prefer: outlook.timezone`
        // header, so Graph answers in UTC and says so in `startTimeZone` — bind to
        // THAT zone, then convert to the owner's. Never re-derive the clock and
        // never let the server's zone decide it.
        const preDeleteStart = preDeleteStartIso
          ? DateTime.fromISO(preDeleteStartIso, { zone: preDeleteStartTz ?? 'UTC' }).setZone(timezone)
          : null;
        const preDeleteLocalDate = preDeleteStart?.isValid ? preDeleteStart.toFormat('yyyy-MM-dd') : undefined;

        // v3.1.7 / #119 — if the deleted event was a floating block (lunch,
        // etc.), record a date-scoped dismissal so active-mode health doesn't
        // re-book the gap the owner just cleared. Keyed to the exact day via the
        // synthetic event_id, so only THIS day is suppressed — future
        // same-weekday blocks still get placed. Subject-only match (categories
        // aren't captured pre-delete). Non-fatal on any failure.
        try {
          const delSubject = (args.meeting_subject ?? preDeleteSubject ?? '') as string;
          if (preDeleteLocalDate && delSubject) {
            const fbMod = require('../../../../utils/floatingBlocks') as typeof import('../../../../utils/floatingBlocks');
            const matchedBlock = fbMod.getFloatingBlocks(context.profile)
              .find(b => fbMod.isFloatingBlockEvent({ subject: delSubject }, b));
            if (matchedBlock) {
              const synth = fbMod.floatingBlockSyntheticEventId(
                context.profile, matchedBlock.name, preDeleteLocalDate, context.profile.user.timezone,
              );
              if (synth) {
                dismissFloatingBlockGap({
                  ownerUserId: context.profile.user.slack_user_id,
                  eventId: synth.eventId,
                  eventDate: preDeleteLocalDate,
                  eventEndMs: synth.eventEndMs,
                  notes: `Owner deleted ${matchedBlock.name} on ${preDeleteLocalDate} — gap waived (won't re-book).`,
                });
                logger.info('delete_meeting — floating-block gap dismissed', {
                  block: matchedBlock.name, date: preDeleteLocalDate, syntheticEventId: synth.eventId,
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
          ownerUserId: context.profile.user.slack_user_id,
          action: 'delete_meeting',
          source: context.channel,
          actor: context.userId,
          target: meetingId,
          // v2.8.5 — `event_start_iso` lets active-mode's
          // missing_floating_block branch read recent deletions and skip
          // re-booking on a day the owner just cleared. `subject` falls back
          // to the Graph probe when Sonnet didn't pass meeting_subject (the
          // probe runs on the same id, so the names match).
          details: {
            subject: args.meeting_subject ?? preDeleteSubject,
            event_start_iso: preDeleteStartIso,
            notified_via: notifiedVia,
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

        // #147.2/.3 — ONE quotable line naming exactly WHICH occurrence went, with
        // the day + time computed here from the calendar. Pre-fix the summary was
        // `Cancelled 'X'.` with no date, so on a multi-occurrence sweep the model
        // rebuilt the date list itself from truncated subjects and got it wrong
        // (12 deletes narrated as "all 11 declined … Aug 13, 14, 17, 18, 19, 20,
        // 21, 24, 25, 26, 28" — Aug 27 was cancelled and never mentioned).
        // gh#154-R2 (2026-08-06) — the masked, probe-derived subject wins over
        // args.meeting_subject: the model's own argument can carry the real
        // title (e.g. recalled from earlier owner-DM context) even when THIS
        // narration is read in a room. Only fall back to args when the probe
        // never captured anything (event_not_found already returned earlier;
        // this is the "preflight threw, proceeding" case).
        const cancelledSubject = (preDeleteSubjectMasked ?? args.meeting_subject ?? preDeleteSubject ?? 'the meeting') as string;
        const whenLabel = preDeleteStart?.isValid ? preDeleteStart.toFormat('EEE d MMM HH:mm') : null;
        const cancelledLabel = whenLabel ? `${cancelledSubject} — ${whenLabel}` : cancelledSubject;

        // #147.1/.4 — the notification sentence is DERIVED, never composed from an
        // intention. Each shape corresponds to a Graph call whose outcome we read.
        const notifiedSentence =
          notifiedVia === 'outlook_decline_to_organizer'
            ? `Outlook sent ${notifiedWho} the decline for this occurrence. I did NOT send any Slack message.`
            : notifiedVia === 'outlook_cancellation_to_attendees'
              ? 'Outlook sent the cancellation to everyone on the invite. I did NOT send any Slack message.'
              : notifiedVia === 'nobody'
                ? 'Nobody was notified — there was no one to notify (no attendees / no organizer response accepted). I did NOT send any Slack message.'
                : 'I could not confirm who Outlook notified. I did NOT send any Slack message.';

        return {
          success: true,
          deleted: cancelledSubject,
          // v3.x — surface the deleted event's start so the reply can name the
          // day+time FROM the tool result (DELETE-MEETING PROTOCOL step 6),
          // instead of from lossy chat memory. Captured pre-delete at the probe.
          deleted_start_iso: preDeleteStartIso,
          /** Owner-local "subject — Thu 13 Aug 09:00". Quote this; don't re-derive it. */
          cancelled_label: cancelledLabel,
          /** Which real notification went out, read off the Graph call that ran. */
          notified_via: notifiedVia,
          notified_who: notifiedWho ?? undefined,
          organizer_name: organizerName ?? undefined,
          organizer_email: organizerEmail ?? undefined,
          // v3.2.x — a displaced floating block whose window this delete freed.
          // PROPOSE-ONLY: the reply offers to bring it home; not auto-moved.
          ...(reclaimable.length ? { reclaimable_block: reclaimable[0] } : {}),
          action_summary: `Cancelled '${cancelledLabel}'. ${notifiedSentence}`,
          _note: 'Report ONLY this occurrence, named by cancelled_label, and report the notification ONLY as notified_via says. Maelle sends NO Slack message on a cancellation — never write "I let <name> know" / "<name> has been notified" / "I\'ll notify them", and never say the decline is permanent or covers other dates: each call cancels exactly one occurrence and Outlook\'s notice says so. If several cancellations ran this turn, list one line per SUCCESSFUL call\'s cancelled_label and nothing else.',
        };
}

