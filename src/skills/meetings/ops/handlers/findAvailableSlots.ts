/**
 * findAvailableSlots — extracted VERBATIM (v3.7.x, pass B) from the 'find_available_slots' case body of
 * SchedulingSkill.executeToolCall in ../../ops.ts. No logic changes: the case
 * body is byte-for-byte identical; only relative import/require paths were
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
  verifyEventDeleted,
  updateMeeting,
  GraphPermissionError,
  CalendarOfflineError,
} from '../../../../connectors/graph/calendar';
import {
  getDb,
  auditLog,
  dismissFloatingBlockGap,
  searchPeopleMemory,
  getPersonMemory,
} from '../../../../db';
import { grantRelaxed } from '../../bookingRequest';
import { closeMeetingArtifacts } from '../../../../utils/closeMeetingArtifacts';
import { reinterpretClockInZone, renderClockInZone } from '../../../../utils/timezoneConvert';
import { resolveStatedInstant, renderWeDualClock } from '../../../../utils/weTimeResolver';
import { checkIntendedWeekday } from '../../../../utils/weekdayGuard';
import { bookingLeadTimeHours, offeredSlotCount } from '../../../../utils/scheduleRules';
import { subjectViewerFor, viewerEmailFor } from '../../../../utils/displaySubject';
import type { OpCtx } from './context';
import type { AttendeeAvailabilityEntry } from '../../../../utils/attendeeAvailability';

/**
 * Shared attendee-availability-warning construction for find_available_slots —
 * called from both the strict/spread pass (a LIST of slots) and the
 * candidate_slots point-check (a per-instant verdict). Extracted 2026-07-29
 * (row 163): the candidate branch carried its own copy of this block behind
 * an IOU ("kept in sync — extract to a shared helper next time we touch this
 * file") and had already drifted from the original within the same commit
 * (dropped two clauses of `_attendee_not_checked_warning`). One helper now;
 * nothing left to drift.
 *
 * unresolvedAttendees (#124h): an internal address Graph can't resolve reads
 * as fully-free — never offer it as checked; did_you_mean comes from
 * people_memory. attendeesNotChecked (P15): a free/busy read that never
 * happened (bad window / Graph rejection), same "don't call them free"
 * consequence but the OPPOSITE cause — a bad address is the model's to fix,
 * a bad window is not, so the wording must not blame the address.
 */
function attendeeCheckWarnings(params: {
  userEmail: string;
  ownerFirstName: string;
  unresolvedAttendees: string[];
  attendeesNotChecked: string[];
  /** Appended to both log messages so the two call sites stay distinguishable in logs. */
  logSuffix: string;
  logExtra?: Record<string, unknown>;
}): {
  attendeeEmailWarning?: Record<string, unknown>;
  attendeeNotCheckedWarning?: Record<string, unknown>;
} {
  const { userEmail, ownerFirstName, unresolvedAttendees, attendeesNotChecked, logSuffix, logExtra } = params;
  const ownerDomainLower = userEmail.includes('@') ? userEmail.split('@')[1].toLowerCase() : '';
  const unresolvedInternal = unresolvedAttendees.filter(e => ownerDomainLower && e.endsWith('@' + ownerDomainLower));
  let attendeeEmailWarning: Record<string, unknown> | undefined;
  if (unresolvedInternal.length > 0) {
    const entries = enrichUnresolvedInternal(unresolvedInternal, ownerDomainLower);
    attendeeEmailWarning = {
      unresolved_attendee_emails: entries,
      _attendee_email_warning: 'These attendee addresses do NOT exist in the company directory — their availability was NOT checked (a nonexistent mailbox reads as fully free). The address is most likely a wrong guess. Re-call find_available_slots with the corrected address (see did_you_mean) or resolve the person via find_slack_user first. Do NOT present any slot as working for that person until the address resolves.',
    };
    logger.warn(`find_available_slots — unresolved internal attendee email(s)${logSuffix}`, {
      unresolvedInternal, entries, ...(logExtra ?? {}),
    });
  }

  let attendeeNotCheckedWarning: Record<string, unknown> | undefined;
  if (attendeesNotChecked.length > 0) {
    attendeeNotCheckedWarning = {
      attendees_not_checked: attendeesNotChecked,
      _attendee_not_checked_warning: `Availability for ${attendeesNotChecked.join(', ')} could NOT be read for this window — the free/busy request failed, so their calendars were never looked at. These are NOT confirmed-free times for them. Present the slots as ${ownerFirstName}'s own openings and say plainly that you could not check the other side, or re-call with a window Graph can actually answer (this one wasn't one). Never say they are free, and never say their address is wrong — it isn't.`,
    };
    logger.warn(`find_available_slots — attendee free/busy was never read for this window${logSuffix}`, {
      notChecked: attendeesNotChecked, ...(logExtra ?? {}),
    });
  }

  return { attendeeEmailWarning, attendeeNotCheckedWarning };
}

/**
 * gh#168-a — for a day rejected on `outside_attendee_work_hours`, compute the
 * blocked attendee's hours (STATED when `entry.assumed` is falsy, or an
 * ASSUMED default — no profile on file — when it's true; #M3) converted into
 * the owner's zone for that exact date, as a self-instructing string Sonnet
 * can quote verbatim. Same
 * "grounded string" pattern as `_requested_time_local` above
 * (reinterpretClockInZone + luxon format, never left to Sonnet's own head) —
 * applied to the DAY-level narration this time. Without it, a follow-up ("why
 * does Monday fall outside Tyler's hours?") has no computed fact to quote, so
 * Sonnet converts the two zones herself and free-hands the arithmetic — which
 * produced three different answers to one question (two of them wrong) on
 * 2026-07-30, logs/maelle-2026-07-30.log:427-466. Best-effort: an attendee not
 * present in `attendeeAvailability` (no stored hours) or a parse failure just
 * yields no note — `top_reasons` / `blocked_by` still carry the fact on their own.
 */
function attendeeHoursGroundingNotes(
  blockedBy: Array<{ email: string; slots_blocked: number }> | undefined,
  date: string,
  attendeeAvailability: AttendeeAvailabilityEntry[] | undefined,
  ownerTz: string,
  ownerFirstName: string,
): string[] | undefined {
  if (!blockedBy || blockedBy.length === 0 || !attendeeAvailability || attendeeAvailability.length === 0) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { attendeeTzForDay } = require('../../../../utils/attendeeAvailability') as
    typeof import('../../../../utils/attendeeAvailability');
  const notes: string[] = [];
  for (const b of blockedBy) {
    const entry = attendeeAvailability.find(a => a.email.toLowerCase() === b.email.toLowerCase());
    if (!entry || !entry.hoursStart || !entry.hoursEnd) continue;
    const attendeeTz = attendeeTzForDay(entry, date);
    try {
      const startOwnerIso = reinterpretClockInZone(`${date}T${entry.hoursStart}:00`, attendeeTz, ownerTz);
      const endOwnerIso = reinterpretClockInZone(`${date}T${entry.hoursEnd}:00`, attendeeTz, ownerTz);
      const startOwner = DateTime.fromISO(startOwnerIso, { zone: ownerTz });
      const endOwner = DateTime.fromISO(endOwnerIso, { zone: ownerTz });
      if (!startOwner.isValid || !endOwner.isValid) continue;
      // #M3 / v4.4.x — an attendee with no stored profile timezone gets a
      // GUESS (requester's zone + standard hours), not a fact. Saying
      // "stated hours" unconditionally told Sonnet to present a guess as
      // something the attendee actually said.
      const hoursLabel = entry.assumed
        ? 'assumed hours (no profile on file for this attendee — a default, not confirmed)'
        : 'stated hours';
      notes.push(
        `${b.email}'s ${hoursLabel} ${entry.hoursStart}-${entry.hoursEnd} (${attendeeTz}) on ${date} convert to ${startOwner.toFormat('HH:mm')}-${endOwner.toFormat('HH:mm')} in ${ownerTz} (${ownerFirstName}'s zone) — quote these numbers verbatim if asked why that day is excluded${entry.assumed ? ', but say plainly these are ASSUMED, not confirmed, if asked' : ''}; do NOT recompute the conversion yourself.`,
      );
    } catch {
      // best-effort grounding note — day_summary still has top_reasons/blocked_by without it
    }
  }
  return notes.length > 0 ? notes : undefined;
}

export async function handleFindAvailableSlots(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
  // v4.1.x — resolved ONCE per call from the authenticated sender.
  //   leadHours: owner 1h vs colleague 4h, previously a literal at four sites
  //     and enforced only inside the slot walker (M2).
  //   viewer:    owner-DM-only sees a private optional event's real subject (M12).
  //   offerCount: the M6 offered-slot budget, previously a literal 5.
  //
  // `isOwnerPath` is the STRICT, post-clamp definition (senderRole alone) — the
  // effective authority + data scope. It is deliberately NOT
  // `|| isOwnerInGroup`: the lead time decides how far the owner's own booking
  // protection relaxes and therefore WHICH slots enter the payload, and the MPIM
  // clamp exists so owner-level authority is never granted in a room colleagues
  // share. His sub-lead-time booking in a group goes through the approval flow,
  // not through re-granting authority in the group.
  const isOwnerPath = context.senderRole === 'owner';
  // P22 (v4.2.x) — THE grant, resolved ONCE per call. Five sites below used to
  // spell `args.relaxed === true && context.senderRole === 'owner'` inline (and
  // one of them as `&& isOwnerInitiatedSearch`, the same predicate under a
  // second name). All five were correct; the problem was that a sixth copy of
  // the same decision, in move_meeting, was not — so the decision now lives in
  // exactly one function (bookingRequest.grantRelaxed) and every path reads it.
  // Resolving it here rather than per-site also means the DENIED log fires once
  // per tool call, not once per internal search.
  //
  // gh#154-R3 (2026-08-06) — read off `ctx.relaxedGrant`, computed ONCE by
  // `SchedulingSkill.executeToolCall` (ops.ts) before dispatch, rather than
  // calling `grantRelaxed` again here — that second call was harmless but
  // logged the same DENIED/owner_room_bend decision a second time per turn.
  // The `?? grantRelaxed(...)` fallback only matters if this handler is ever
  // invoked outside that one dispatch path (it currently isn't).
  const relaxedGranted = ctx.relaxedGrant?.relaxed ?? grantRelaxed(args, context).relaxed;
  const leadHours = bookingLeadTimeHours(context.profile, isOwnerPath ? 'owner' : 'colleague');
  const viewer = subjectViewerFor(context);
  // v4.4.9 (#154) — the attendee-aware half of that same mask, threaded
  // alongside `viewer` into every findAvailableSlots call below.
  // gh#154-W5/gh#154-R4 (2026-08-06) — room-tightening lives inside viewerEmailFor now
  // (surface==='room' → null); call it directly — a blanket ?? null here
  // also masked the email leg's forwarded subjects unconditionally.
  const viewerEmail = viewerEmailFor(context);
  const offerCount = offeredSlotCount(context.profile);
        // v1.6.4 — meeting_mode is required from the LLM. Let findAvailableSlots
        // scope the workDays per mode (in_person → office only, else both). Do
        // NOT pre-pass workDays from here — the function's own mode-aware logic
        // decides so in_person is enforced as a hard rule.
        {
          // v3.1.6 — duration safety default — code backstop for when
          // Sonnet omits duration entirely (the tool description tells her to
          // default to default_meeting_duration when no length was stated).
          if (args.duration_minutes == null) {
            const allowed = context.profile.meetings.allowed_durations;
            args.duration_minutes = context.profile.meetings.default_meeting_duration
              ?? [...allowed].sort((a, b) => a - b)[0];
          }
          // v3.0.3 — entry log for diagnostic visibility. Shows exactly what
          // Sonnet passes — critical for debugging "did the time-of-day window
          // actually clip?" and "did she pass the attendee?" cases.
          logger.info('find_available_slots — call entry', {
            senderRole: context.senderRole,
            isOwnerInGroup: context.isOwnerInGroup,
            threadTs: context.threadTs,
            search_from: args.search_from,           // raw, as Sonnet passed
            search_to: args.search_to,               // raw, as Sonnet passed
            search_from_has_time: typeof args.search_from === 'string' && args.search_from.includes('T'),
            search_to_has_time: typeof args.search_to === 'string' && args.search_to.includes('T'),
            duration_minutes: args.duration_minutes,
            attendee_emails: args.attendee_emails,
            meeting_mode: args.meeting_mode,
            relaxed: args.relaxed === true,
            ignore_attendee_availability: args.ignore_attendee_availability === true,
            moving_event_ids: args.moving_event_ids,
            preferred_slot: args.preferred_slot,
            category: args.category,
          });

          const mode = (args.meeting_mode as string | undefined) ?? 'either';
          if (!['in_person', 'online', 'either', 'custom'].includes(mode)) {
            return {
              error: 'invalid_meeting_mode',
              message: `meeting_mode must be one of: in_person, online, either, custom. Got "${mode}". Ask the owner which one applies before calling again.`,
            };
          }
          // v2.2.5 (C) — must_be_after_event_id: clip searchFrom to AFTER the
          // predecessor's end. Optional; when omitted, behavior is unchanged.
          // Predecessor lookup via getCalendarEvents window around the
          // searchFrom date — saves a per-event-id roundtrip and is bounded.
          let effectiveSearchFrom = args.search_from as string;
          // v3.0.6 — expand date-only search_to to end-of-that-day. The
          // downstream parser reads any date-only string as 00:00 of that day,
          // so a bare `search_from=search_to="2026-05-27"` would collapse to a
          // 0-minute window and return nothing on a wide-open day. Mirror what
          // getCalendarEvents does internally via `toEndOfDayLocal` — append
          // T23:59:59 to a bare YYYY-MM-DD.
          let effectiveSearchTo = ((): string => {
            const raw = args.search_to as string;
            if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
              return `${raw}T23:59:59`;
            }
            return raw;
          })();
          // Input-side timezone conversion (the Tyler bug). When the requested
          // meeting time was given in a NON-owner timezone ("9:45 AM ET"),
          // Sonnet tags it with `search_window_timezone` and passes the clock
          // time as-given (09:45). Re-interpret those clock times AS that zone
          // and convert to the owner timezone for the search — so Sonnet never
          // hand-converts a search time. Without this, Sonnet searched 09:45
          // ISRAEL for a 9:45-ET ask → before the 10:30 start →
          // outside_owner_work_hours → then mis-explained it as "Wednesday ends
          // before 16:45." Symmetric to present_in_timezone (output side).
          const searchWindowTz = typeof args.search_window_timezone === 'string'
            ? args.search_window_timezone.trim()
            : '';
          // #148 — grounded strings the tool hands back so Sonnet QUOTES the conversion
          // instead of doing it in her head (the recurring "8am ET = 22:00 / = 15:00" thrash).
          let requestedTimeLocal = '';   // (A) e.g. "Mon 21 Jul 08:00 EDT = 15:00 Idan's time"
          let timezoneHint = '';         // (B) set when a zone is tagged but no time-of-day was given
          if (searchWindowTz) {
            const searchFromHasTime = typeof args.search_from === 'string' && (args.search_from as string).includes('T');
            if (!searchFromHasTime) {
              // (B) — a zone was tagged but search_from has no clock time. Converting a
              // bare date's midnight is meaningless AND shifts the day boundary by the
              // offset, so SKIP it and tell Sonnet to re-call with the exact stated time.
              timezoneHint = `search_window_timezone=${searchWindowTz} was set but search_from has no time-of-day — nothing to convert. Re-call with the exact stated clock time (e.g. search_from="${args.search_from}T09:00:00"); do NOT convert it yourself.`;
              logger.info('find_available_slots — zone tagged without a time-of-day; conversion skipped', {
                searchWindowTz, search_from: args.search_from,
              });
            } else {
              // v3.4.2 (A2) — shared helper, identical to create/move's conversion.
              const fromRequested = effectiveSearchFrom;
              effectiveSearchFrom = reinterpretClockInZone(effectiveSearchFrom, searchWindowTz, timezone);
              effectiveSearchTo = reinterpretClockInZone(effectiveSearchTo, searchWindowTz, timezone);
              // (A) — hand back the grounded owner-local value of the STATED foreign time,
              // the mirror of present_in_timezone's presentation_local for the owner side.
              const foreignDisp = renderClockInZone(effectiveSearchFrom, timezone, searchWindowTz);
              const ownerClock = DateTime.fromISO(effectiveSearchFrom, { zone: timezone });
              if (foreignDisp && ownerClock.isValid) {
                requestedTimeLocal = `${foreignDisp} = ${ownerClock.toFormat('HH:mm')} ${context.profile.user.name.split(' ')[0]}'s time`;
              }
              logger.info('find_available_slots — converted search window from requested TZ to owner TZ', {
                searchWindowTz, from_requested: fromRequested, from_owner: effectiveSearchFrom, requestedTimeLocal,
              });
            }
          }
          // #148 — grounded fields spread into EVERY search-path return (main + the
          // 0-slots/attendee-warning early exit) so Sonnet always has the string to quote.
          const tzGroundingFields: Record<string, string> = {};
          if (requestedTimeLocal) tzGroundingFields._requested_time_local = `The stated foreign time converts to: ${requestedTimeLocal}. Quote THIS ${context.profile.user.name.split(' ')[0]}-zone value; do NOT recompute the cross-timezone conversion yourself.`;
          if (timezoneHint) tzGroundingFields._timezone_hint = timezoneHint;
          const mustBeAfterId = args.must_be_after_event_id as string | undefined;
          if (mustBeAfterId) {
            try {
              const probeFrom = DateTime.fromISO(args.search_from as string, { zone: timezone })
                .minus({ days: 30 }).toFormat('yyyy-MM-dd');
              const probeTo = DateTime.fromISO(args.search_to as string, { zone: timezone })
                .plus({ days: 30 }).toFormat('yyyy-MM-dd');
              const events = await getCalendarEvents(userEmail, probeFrom, probeTo, timezone);
              const predecessor = events.find(e => e.id === mustBeAfterId);
              if (predecessor) {
                const predEnd = DateTime.fromISO(predecessor.end.dateTime, { zone: predecessor.end.timeZone ?? 'utc' })
                  .setZone(timezone);
                const requestedFrom = DateTime.fromISO(args.search_from as string, { zone: timezone });
                if (predEnd.toMillis() > requestedFrom.toMillis()) {
                  effectiveSearchFrom = predEnd.toISO()!;
                  logger.info('find_available_slots — clipped searchFrom to after predecessor', {
                    predecessorId: mustBeAfterId,
                    predecessorEnd: predEnd.toISO(),
                    originalFrom: args.search_from,
                    clippedFrom: effectiveSearchFrom,
                  });
                }
              } else {
                logger.warn('find_available_slots — must_be_after_event_id not found, ignoring', {
                  eventId: mustBeAfterId,
                });
              }
            } catch (err) {
              logger.warn('find_available_slots — predecessor lookup threw, ignoring constraint', {
                err: String(err).slice(0, 200),
              });
            }
          }

          // v3.1.x — zero-width / inverted window guard. "Am I free at 3pm ET
          // next Tuesday?" is a point-in-time availability check; Sonnet maps it
          // to search_from == search_to (a single instant). getFreeBusy bails on
          // a zero-width (or inverted) window and returns empty, the
          // relaxed-recovery fallback also returns empty, so the whole iteration
          // is wasted and Sonnet has to redo the search with a wider window on
          // the NEXT turn. Mirror the date-only expansion above: when from >=
          // to, expand `to` to
          // from + duration_minutes so the requested instant is actually
          // tested. (A predecessor-clip that pushed `from` past `to` lands
          // here too.) The preferred_slot (when set) already pins the exact
          // instant inside this window, so the asked time is guaranteed tested.
          {
            const fromDt = DateTime.fromISO(effectiveSearchFrom, { zone: timezone });
            const toDt = DateTime.fromISO(effectiveSearchTo, { zone: timezone });
            if (fromDt.isValid && toDt.isValid && fromDt.toMillis() >= toDt.toMillis()) {
              const durMin = (args.duration_minutes as number) ?? 30;
              const expandedTo = fromDt.plus({ minutes: durMin }).toISO();
              if (expandedTo) {
                logger.info('find_available_slots — zero-width/inverted window expanded to from+duration', {
                  original_from: effectiveSearchFrom,
                  original_to: effectiveSearchTo,
                  expanded_to: expandedTo,
                  duration_minutes: durMin,
                });
                effectiveSearchTo = expandedTo;
              }
            }
          }

          // v2.3.2 (5B/5C) / v2.3.6 — auto-load attendee work-hour availability
          // from people_memory via shared helper. Pre-clips slots to the
          // intersection of every attendee's window so Brett (Boston/EST)
          // never gets proposed 10:15 IL (3:15 ET). Helper covers both this
          // path and coordinate_meeting consistently. Owner can opt out via
          // `ignore_attendee_availability: true` for "find times I'm free,
          // I'll handle the others" scenarios.
          let attendeeEmails = (args.attendee_emails as string[]) ?? [];

          // MOVE-PATH AUTO-FILL: when moving_event_ids is set, auto-read the moving
          // event's real roster so a later call that DROPPED an attendee still checks
          // everyone. Owner direction: "find_available_slots should just take the list
          // of people to check" — tool reads them itself; Sonnet doesn't have to
          // remember. Closes the Sales BiWeekly trace where Sonnet dropped Isaac and
          // 17:00 was proposed without him. GUARDED below (#145b): the event roster is
          // folded in ONLY when it shares an attendee with the explicit set (same
          // meeting) or the explicit set is empty; a moving_event_id that points at a
          // DIFFERENT meeting is ignored, never ballooned in.
          // v4.4.x (Elinor Avny trace, 2026-08-04) — runs on the COLLEAGUE path too,
          // not owner-only. A colleague asking "why 20:30? any earlier time?" about a
          // meeting she's already on used to only ever get HER OWN calendar checked —
          // the real co-attendees (Lori, Scott, Chris — all internal, all checkable)
          // never entered the search, and the model covered the narrower answer with a
          // fabricated "can't see the client attendees' calendars" excuse. Colleague path
          // gets an EXTRA gate the owner path doesn't need (the per-id filter below):
          // the requester must herself appear on a GIVEN id's OWN fetched roster
          // before THAT id's attendees fold in — tested per id, never against a
          // union of every passed id's roster (a union would let one id she's on,
          // which passes the test, drag in a second unrelated id's attendees whose
          // calendars she has no standing to read — bounced 2026-08-04). Otherwise
          // an empty explicit set (she named no one) would satisfy #145b's "explicit
          // set is empty" branch and hand her a stranger meeting's attendee list on
          // a mismatched/guessed moving_event_id. The owner has no such gate: it's
          // always his own calendar. Per-attendee annotation (v2.7.0 colleague-path
          // block below) is unrelated and untouched — that's the busy/free
          // narration layer; this is what gets INTO attendeeEmails at all.
          // v4.1.x — STRICT (post-clamp) owner path, same definition as
          // `isOwnerPath` above. It used to be `|| isOwnerInGroup === true`, and
          // this flag is not cosmetic: it decides what goes INTO the payload at
          // several points downstream — whether a held slot comes back naming the
          // colleague who holds it and why (the hold annotation below), whether
          // the relaxed recovery surfaces times that break his focus / lunch /
          // lead-time protections, and whether the "never reveal the mechanism"
          // colleague hint is attached at all. Under the loose form, the owner's
          // own turn in a group DM took the owner branch on every one of those —
          // so another colleague's hold reason and his own day-load mechanics
          // were emitted into a thread other people read. Same class as the
          // get_calendar clamp; same ruling.
          const isOwnerInitiatedSearch = isOwnerPath;
          const movingIdsForAttendees = Array.isArray(args.moving_event_ids)
            ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
            : [];
          // v4.4.x — the SAME per-id membership-checked list also gates
          // `excludeEventIds` at every downstream findAvailableSlots call in
          // this handler (five sites: candidate validation, the main pass,
          // both recovery passes, and the preferred-slot re-check). Before
          // this, each site re-filtered the RAW args.moving_event_ids straight
          // into excludeEventIds with NO membership check at all — a colleague
          // could name an owner event she isn't part of and have it excluded
          // from his busy calculation just by passing its id, even though the
          // fold-into-attendeeEmails logic below already gated that same id
          // for a different purpose. One list, one gate, both consumers.
          // Owner path stays ungated — it's always his own calendar.
          let excludeEventIdsForSearch: string[] | undefined =
            isOwnerInitiatedSearch && movingIdsForAttendees.length > 0 ? movingIdsForAttendees : undefined;
          if (movingIdsForAttendees.length > 0) {
            try {
              const { resolveMovingEventAttendees } = await import('../../../../utils/movingEventAttendees');
              const rosterById = await resolveMovingEventAttendees(
                movingIdsForAttendees,
                userEmail,
                timezone,
              );
              // v4.4.x — colleague membership gate, tested PER ID (bounced 2026-08-04:
              // a blind union let one id she's on drag in a second, unrelated id's
              // attendees). On the colleague path, an id only qualifies when ITS OWN
              // roster contains the requester; a mismatched/guessed id — or a real id
              // for a meeting she isn't on — is dropped instead of unioned in. The
              // owner path skips this check — it is always reading his own calendar.
              let qualifyingIds = movingIdsForAttendees;
              if (!isOwnerInitiatedSearch) {
                const requesterEmailLower = (getPersonMemory(context.userId)?.email ?? '').toLowerCase();
                const onOwnRoster = (id: string) => !!requesterEmailLower
                  && (rosterById.get(id) ?? []).some(e => e.toLowerCase() === requesterEmailLower);
                qualifyingIds = [];
                for (const id of movingIdsForAttendees) {
                  if (onOwnRoster(id)) { qualifyingIds.push(id); continue; }
                  // Organizing-not-attending (e.g. an EA booking for the owner):
                  // she is never on the event's own roster, so the containment
                  // test above always fails for her. Admit the id only when the
                  // REQUESTS SPINE (a verified DB fact — who actually initiated
                  // the booking that produced this event, written for every
                  // colleague direct booking at createMeeting.ts:1715-1734) names
                  // her as its requester. Never trust the model's self-declared
                  // requester_is_attending flag alone for this — any colleague
                  // could set it on a guessed id and reopen the exact roster leak
                  // #145b/2026-08-04 closed; this checks a durable record instead
                  // of a claim.
                  if (args.requester_is_attending === false) {
                    try {
                      const { findMeetingOwner } = await import('../../findMeetingOwner');
                      const info = await findMeetingOwner({
                        ownerUserId: context.profile.user.slack_user_id,
                        ownerEmail: userEmail,
                        eventId: id,
                      });
                      if (info.requesterSlackId === context.userId) qualifyingIds.push(id);
                    } catch (err) {
                      logger.warn('find_available_slots — findMeetingOwner organizing-not-attending check threw', {
                        err: String(err).slice(0, 200),
                      });
                    }
                  }
                }
                if (qualifyingIds.length < movingIdsForAttendees.length) {
                  logger.warn('find_available_slots — dropping moving_event_id(s) not on the requester\'s own roster (likely a mismatched id, or another attendee\'s meeting)', {
                    movingEventIds: movingIdsForAttendees,
                    qualifyingIds,
                    requester: requesterEmailLower || '(unresolved)',
                  });
                }
                excludeEventIdsForSearch = qualifyingIds.length > 0 ? qualifyingIds : undefined;
              }
              const fromEvent = [...new Set(qualifyingIds.flatMap(id => rosterById.get(id) ?? []))];
              if (fromEvent.length > 0) {
                const explicitLc = attendeeEmails.map(e => e.toLowerCase());
                const eventLc = fromEvent.map(e => e.toLowerCase());
                // #145b (2026-07-21 "Automation" balloon) — only fold the moving event's
                // roster into a NON-EMPTY explicit set when the two SHARE at least one
                // attendee. Zero overlap means the moving_event_id points at a DIFFERENT
                // meeting than the attendees describe: that day the model passed the real
                // four {chris,isaac,onn,dina} but a wrong sibling id whose roster is
                // {yael,elan,ysrael} — disjoint → 3 strangers unioned in → 7 people → 0
                // slots on a day everyone was actually free. resolveMovingEventAttendees
                // matches by EXACT id, so a wrong id returns a wrong-but-real roster; the
                // overlap test is what catches it. An EMPTY explicit set → Sonnet dropped
                // everyone → fill from the event (the Sales-BiWeekly case this was built for).
                const shares = eventLc.some(e => explicitLc.includes(e));
                if (explicitLc.length === 0 || shares) {
                  const merged = new Set<string>([...explicitLc, ...eventLc]);
                  const before = attendeeEmails.length;
                  attendeeEmails = [...merged];
                  if (attendeeEmails.length > before) {
                    logger.info('find_available_slots — auto-filled attendees from moving event', {
                      movingEventIds: movingIdsForAttendees,
                      addedFromEvent: fromEvent,
                      finalAttendees: attendeeEmails,
                    });
                  }
                } else {
                  // Disjoint roster → wrong / mismatched moving_event_id. Keep the explicit
                  // set as-is; never balloon the search with a different meeting's people.
                  logger.warn('find_available_slots — moving-event roster is DISJOINT from the explicit attendees; ignoring it (likely a wrong moving_event_id)', {
                    movingEventIds: movingIdsForAttendees,
                    eventRoster: fromEvent,
                    explicitAttendees: attendeeEmails,
                  });
                }
              }
            } catch (err) {
              logger.warn('find_available_slots — moving-event attendees recovery threw', {
                err: String(err).slice(0, 200),
              });
            }
          }

          // v3.6.4 — union the internal colleagues the orchestrator resolved
          // from THIS turn's named participants (deterministic pre-search pass).
          // This is the guarantee that a KNOWN named colleague is in the search
          // even when Sonnet passed a partial attendee_emails (Lori dropped,
          // 07-08) or the wrong shape — resolution no longer depends on Sonnet
          // remembering to call find_slack_user. Per-turn set (no thread
          // staleness), owner AND colleague paths, deduped; the owner-self and
          // any ambiguous/external names were already filtered out upstream.
          if (Array.isArray(context.resolvedMeetingAttendees) && context.resolvedMeetingAttendees.length > 0) {
            const existingLower = new Set(attendeeEmails.map(e => e.toLowerCase()));
            const added: string[] = [];
            for (const email of context.resolvedMeetingAttendees) {
              const lower = (email ?? '').toLowerCase().trim();
              if (!lower.includes('@') || existingLower.has(lower)) continue;
              attendeeEmails.push(email);
              existingLower.add(lower);
              added.push(email);
            }
            if (added.length > 0) {
              logger.info('find_available_slots — unioned orchestrator-resolved internal attendees', {
                added,
                finalAttendees: attendeeEmails,
                senderRole: context.senderRole,
              });
            }
          }

          // Auto-fill from this thread's prior attendee context. When Sonnet
          // calls find_available_slots WITHOUT attendee_emails but a previous
          // call in this thread already established who the meeting is for,
          // recover that list so the work-hours / availability constraint
          // isn't silently dropped between turns.
          if (attendeeEmails.length === 0 && context.threadTs) {
            try {
              const { getThreadAttendees } = await import('../../../../utils/threadAttendees');
              const recovered = getThreadAttendees(context.threadTs);
              if (recovered.length > 0) {
                logger.info('find_available_slots — auto-filled attendee_emails from thread context', {
                  threadTs: context.threadTs,
                  recovered,
                });
                attendeeEmails = recovered;
              }
            } catch (err) {
              logger.warn('find_available_slots — thread attendees recovery threw', {
                err: String(err).slice(0, 200),
              });
            }
          } else if (attendeeEmails.length > 0 && context.threadTs) {
            // Record for future calls in this thread.
            try {
              const { recordThreadAttendees } = await import('../../../../utils/threadAttendees');
              recordThreadAttendees(context.threadTs, attendeeEmails);
            } catch (_) { /* best-effort */ }
          }
          // Owner can opt out of attendee BUSY filtering (their other meetings)
          // when forcing a slot regardless of their existing calendar — but
          // their TIMEZONE / work-hours window is ALWAYS honored, no flag
          // Owner direction: when the owner triggers the full override
          // (relaxed=true on owner-path, OR explicit
          // ignore_attendee_availability=true), the override is TOTAL — drop
          // BOTH the busy filter AND the attendee work-hours clip. The attendee
          // work-hours data is owner-curated in people_memory, can go stale, and
          // would otherwise silently filter owner-valid slots. So: surface the
          // work-hours rejection once (via day_summary.blocked_by attribution
          // emitted by calendar.ts), and on owner override the tool drops the
          // clip too. "If I decide, it's on me."
          // REQUESTER ≠ ATTENDEE — but DEFAULT-SAFE for the common case. When a
          // colleague asks to book a meeting they're
          // ATTENDING, they ARE an attendee: their TZ drives per_attendee_local
          // (correct cross-TZ labels) and their work-hours correctly steer the
          // search — dropping them would BREAK that (lose the ET conversion +
          // the clip). So we only drop the requester when Sonnet explicitly
          // flags her as organizing-not-attending (`requester_is_attending:
          // false` — e.g. an EA collecting options for OTHERS, like Yael). Then
          // her own calendar/work-hours stop clipping the search and she's not
          // annotated "busy" back to herself. Default (flag unset/true) = keep,
          // so the attending-requester case is untouched.
          if (!isOwnerInitiatedSearch && context.userId && args.requester_is_attending === false) {
            try {
              const requesterEmailLower = (getPersonMemory(context.userId)?.email ?? '').toLowerCase();
              if (requesterEmailLower) {
                const before = attendeeEmails.length;
                attendeeEmails = attendeeEmails.filter(e => e.toLowerCase() !== requesterEmailLower);
                if (attendeeEmails.length < before) {
                  logger.info('find_available_slots — dropped requester from attendees (organizer, not attendee)', {
                    requester: requesterEmailLower,
                  });
                }
              }
            } catch (err) {
              logger.warn('find_available_slots — requester-exclusion lookup threw, continuing', {
                err: String(err).slice(0, 200),
              });
            }
          }

          const ignoreAttendeeBusy =
            args.ignore_attendee_availability === true
            || relaxedGranted;

          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { loadAttendeeAvailabilityForEmails } = require('../../../../utils/attendeeAvailability') as
            typeof import('../../../../utils/attendeeAvailability');
          // Drop the work-hours clip entirely when override is active. The
          // first call (no override) loads availability and lets calendar.ts
          // surface `outside_attendee_work_hours:<email>` per blocked attendee
          // so Sonnet narrates the conflict. Owner's retry with override
          // gets unfiltered slots.
          const attendeeAvailability = ignoreAttendeeBusy
            ? undefined
            // #M3 — pass the owner's TZ as the fallback: an attendee with no stored
            // timezone is assumed to be in the requester's frame (+ standard hours)
            // rather than left unclipped. A human-stated TZ/time still overrides.
            : loadAttendeeAvailabilityForEmails(attendeeEmails, userEmail, timezone);

          // v3.7.x (Bug 1.5) — conversational per-attendee hours override. When the
          // owner states an attendee's REAL hours ("Lori starts 7am ET"), thread it
          // INTO the entry the walker already clips against (calendar.ts per-attendee
          // work-window clip) — NO parallel hours route, so the clip can't drift (the
          // annotation path tags busy/free only, never hours). Partial: only the
          // bound(s) given override; tz (when given) makes the clip use it (home tz +
          // clear any stale travel window). Without this the stored default
          // (getEffectiveWorkingHours) kept rejecting 07:00 ET as
          // outside_attendee_work_hours even after the owner said 7am works (2026-07-15).
          const attendeeHoursOverride = Array.isArray(args.attendee_hours)
            ? (args.attendee_hours as Array<{ email?: string; start?: string; end?: string; tz?: string }>)
            : [];
          if (attendeeAvailability && attendeeHoursOverride.length > 0) {
            const hhmm = /^\d{1,2}:\d{2}$/;
            for (const ov of attendeeHoursOverride) {
              const ovEmail = (ov?.email ?? '').toLowerCase().trim();
              if (!ovEmail) continue;
              const entry = attendeeAvailability.find(a => a.email.toLowerCase() === ovEmail);
              if (!entry) continue;
              if (typeof ov.start === 'string' && hhmm.test(ov.start.trim())) entry.hoursStart = ov.start.trim();
              if (typeof ov.end === 'string' && hhmm.test(ov.end.trim())) entry.hoursEnd = ov.end.trim();
              if (typeof ov.tz === 'string' && ov.tz.trim()) {
                entry.timezone = ov.tz.trim();
                entry.homeTimezone = ov.tz.trim();
                entry.travelWindow = undefined;
              }
              // A conversational override IS a real statement (the owner said
              // it) — clear the #M3 assumed-default flag so downstream
              // narration says "stated", never "assumed", for this entry.
              entry.assumed = false;
              logger.info('find_available_slots — attendee hours override applied', {
                email: entry.email, hoursStart: entry.hoursStart, hoursEnd: entry.hoursEnd, tz: entry.timezone,
              });
            }
          }

          // #24 (2026-07-29) — auto-default the presentation timezone. When
          // the caller omits present_in_timezone but the loaded attendees name
          // EXACTLY ONE distinct zone that differs from the owner's, use that
          // zone as the default so every candidate still comes back with a
          // presentation_local — the same "tool completes what the caller left
          // implicit" shape as the attendee_emails auto-fill above (moving-event
          // roster / @-mention / thread-recovery), applied to the OUTPUT side.
          // Without it, a real run offered James Avery (Kevel, ET) "13:15 your
          // time" — Israel clock, no ET rendering anywhere in the reply — and
          // only the owner noticing "6am is absurd" caught a 90-minute error
          // before it reached an external person; a subtler gap would not have
          // been caught. Two or more DISTINCT non-owner zones → no single
          // "their zone" to default to — leave it unset rather than guess, the
          // same fallback-not-force philosophy as #M3 above. An explicit
          // present_in_timezone from the caller always wins (each use site
          // below checks it FIRST via `||`) — this only fills a gap, never
          // overrides a stated value.
          const nonOwnerAttendeeZones = [...new Set(
            (attendeeAvailability ?? [])
              .map(a => a.timezone)
              .filter(tz => tz && tz !== timezone),
          )];
          const autoPresentTz = nonOwnerAttendeeZones.length === 1 ? nonOwnerAttendeeZones[0] : '';
          // The requester's explicit present_in_timezone always wins; autoPresentTz
          // only fills the gap when they didn't name one. Computed ONCE here —
          // the preferred_slot branch and the main slots list below both render
          // the SAME conversation's zone choice, so a requester who asked "in ET"
          // must get every offered instant (including preferred_slot) in ET, not
          // just the ones each branch happened to recompute consistently.
          const presentTzForOutput = (typeof args.present_in_timezone === 'string'
            ? args.present_in_timezone.trim()
            : '') || autoPresentTz;

          // #77 — owner-initiated path with attendees: auto-pass
          // attendeeBusyEmails so Graph free/busy filters the candidate pool,
          // not just work-hour clipping. Prior fixes (v2.2.3 #43, v2.3.6 #71)
          // wired the work-hours half. The colleague-initiated SPREAD search
          // (the main branch below, a LIST of options) deliberately does NOT
          // auto-pass — coord/main-branch use annotateSlotsWithAttendeeStatus
          // to TAG slots with status instead, so a colleague's search never
          // silently loses an option to an attendee conflict (M6).
          const attendeeBusyEmails = (isOwnerInitiatedSearch && !ignoreAttendeeBusy && attendeeEmails.length > 0)
            ? attendeeEmails
            : undefined;

          // 2026-07-29 (row 161, the Levana "she has something" incident) —
          // candidate_slots (point validation: "is X free at exactly Y?") is
          // NOT a spread search — there is no list of options a busy-subtract
          // could silently thin out (M6 doesn't apply to a single instant).
          // Gating this on isOwnerInitiatedSearch meant a colleague-path (or
          // MPIM-clamped owner) point-check only ever consulted the named
          // attendee's generic stored WORK HOURS (loadAttendeeAvailabilityForEmails
          // is explicitly TZ+hours only, never busy/free) and the OWNER's own
          // calendar — never the attendee's actual calendar — so "available:
          // true" was asserted without ever being checked, and every re-ask
          // ("are you sure?") repeated the same unverified answer (M2: the
          // point-check must give the SAME real answer the spread search
          // would; M11: a stated availability fact must be verified, not
          // guessed). Sharing a NAMED attendee's free/busy (no detail, no
          // subject) with a colleague is exactly what M12 allows, so this
          // reuses the identical attendee_busy_collision plumbing the owner
          // path already has — only the explicit override (ignoreAttendeeBusy)
          // still turns it off.
          const candidateAttendeeBusyEmails = (!ignoreAttendeeBusy && attendeeEmails.length > 0)
            ? attendeeEmails
            : undefined;

          // Diagnostics receiver — surfaces per-day summary to Sonnet so she
          // can honestly answer "why no Monday?" instead of fabricating.
          const diagnosticsOut: {
            rejectedCounts?: Record<string, number>;
            rejectedExamples?: Record<string, string[]>;
            daySummary?: Array<{
              date: string;
              accepted: number;
              top_reasons: string[];
              blocked_by?: Array<{ email: string; slots_blocked: number }>;
              // gh#168-a — grounded, code-computed strings for a day whose
              // top_reasons names `outside_attendee_work_hours`, so a follow-up
              // ("why does Monday fall outside their hours?") is answered by
              // QUOTING this instead of Sonnet converting the two zones herself.
              attendee_hours_note?: string[];
            }>;
            unresolvedAttendees?: string[];
            attendeesNotChecked?: string[];
          } = {};

          // v2.7.6 — narrow-window detection. When owner explicitly named a
          // day/window ("Monday", "this week", "Tuesday afternoon"), the
          // search window will be ≤7 days. Disable auto-expand in that case
          // so we don't silently jump to next week. Open-ended asks ("when
          // can we meet") usually pass wider windows and benefit from
          // auto-expand.
          const userNamedNarrowWindow = (() => {
            try {
              const from = DateTime.fromISO(effectiveSearchFrom, { zone: timezone });
              const to = DateTime.fromISO(args.search_to as string, { zone: timezone });
              if (!from.isValid || !to.isValid) return false;
              const spanDays = to.diff(from, 'days').days;
              return spanDays <= 7;
            } catch { return false; }
          })();

          // v3.0.6 — candidate-slots batch validation. When the caller has N
          // specific times to check ("can we do A, B, C, or D?"), Sonnet passes
          // them all as `candidate_slots`. We fire N parallel narrow
          // findAvailableSlots calls (each autoExpand:false) and collect
          // per-candidate verdicts in ONE response — collapsing what would
          // otherwise be N sequential Sonnet round-trips into one.
          //
          // Returns a DIFFERENT shape than the default branch:
          //   { mode: 'candidate_validation', results: [{start, end,
          //     available, broken_rule?, broken_rule_label?}, ...] }
          // Caller (Sonnet) narrates blocked candidates by reading
          // broken_rule_label verbatim.
          if (Array.isArray(args.candidate_slots) && args.candidate_slots.length > 0) {
            const ownerFirst = context.profile.user.name.split(' ')[0];
            const durationMin = args.duration_minutes as number;
            const candidates = args.candidate_slots as Array<{ start: string }>;
            // The window each candidate is validated in is ALWAYS
            // [start, start + duration_minutes] — derived here, never taken from
            // the caller.
            //
            // It used to honour a model-supplied `end`, an unconstrained free
            // string (unlike `duration_minutes`, which is an enum and is
            // backstopped at :73). Two things were wrong with that. It was already
            // incoherent: the walker validates a `durationMin` meeting whatever
            // `end` says, and the verdict below matches on the START (±60s), so a
            // caller `end` only ever moved the search bound — it could never change
            // what was actually checked. And when the model emitted a 1–5 minute
            // window, `getFreeBusy` derived an availabilityViewInterval ≥ the window
            // itself (calendarReads: `windowMinutes >= 16 ? 15 : max(5, ...)`), which
            // Graph rejects with a 400 — a deterministic failure on OUR malformed
            // request that surfaced to a colleague as "his calendar is unreachable".
            // A window narrower than the meeting cannot hold the meeting, so there is
            // no reading under which the caller's `end` is the right bound.
            const normalized = candidates
              .filter(c => typeof c?.start === 'string' && c.start.length > 0)
              .map(c => {
                // #136 — apply the SAME conversion the default branch runs at :1083.
                // candidate_slots[].start is a clock time tagged with
                // search_window_timezone (the colleague's zone); reinterpret it into
                // the owner's zone BEFORE searching. Without this a 10:00-ET candidate
                // was searched as 10:00 owner-local (the Ayala July-8 bug: tested
                // 10:00 IL instead of 17:00 IL → a false outside_attendee_work_hours
                // that masked the real owner_busy reason).
                const startConv = searchWindowTz
                  ? reinterpretClockInZone(c.start, searchWindowTz, timezone)
                  : c.start;
                const s = DateTime.fromISO(startConv, { zone: timezone });
                // An unparseable start yields end:'' — answered below as this
                // candidate's own validation_error, with no Graph round-trip.
                return {
                  start: startConv,
                  end: s.isValid ? s.plus({ minutes: durationMin }).toISO()! : '',
                };
              });

            // Local partial application of the shared humanizeViolationLabel
            // (../../ops/violationLabels.ts) — already the one implementation,
            // imported here and by calendarReads/createMeeting/moveMeeting;
            // this just binds ownerFirst for the call site below.
            const labelFor = (reason: string | undefined): string => humanizeViolationLabel(reason, ownerFirst);

            // #148 — the zone the candidate times were STATED in (searchWindowTz), or an
            // explicit present_in_timezone, used to echo each result back in that zone.
            // #24 — falls back to the auto-derived attendee zone (declared above) when
            // neither was given; an explicit value here still wins outright.
            const explicitGroundTz = searchWindowTz
              || (typeof args.present_in_timezone === 'string' ? args.present_in_timezone.trim() : '');
            const groundTz = explicitGroundTz || autoPresentTz;
            // report row 145 (2026-07-29) — provenance: only the explicit branch above
            // was actually STATED (search_window_timezone / present_in_timezone are
            // both set because a person named that zone). The autoPresentTz fallback
            // is a SYSTEM inference from the attendees' stored zones — nobody said it.
            // A tool result must not claim a human said something they didn't (a lie
            // the model will faithfully repeat), so the label below must say which.
            const groundTzStated = !!explicitGroundTz;
            // 2026-07-29 (row 163, "levana@" vs the directory's "levana.b@") —
            // one diag per candidate, shared array so unresolved/not-checked
            // attendee addresses survive the Promise.all and can be surfaced
            // exactly like the main branch does below (attendeeEmailWarning /
            // attendeeNotCheckedWarning) — reusing the SAME fields calendarReads.ts
            // already populates, not a new diagnostic.
            const perCandidateDiags: Array<{ unresolvedAttendees?: string[]; attendeesNotChecked?: string[] }> = [];
            const results = await Promise.all(normalized.map(async (cand) => {
              const diag: {
                rejectedCounts?: Record<string, number>;
                unresolvedAttendees?: string[];
                attendeesNotChecked?: string[];
              } = {};
              perCandidateDiags.push(diag);
              if (!cand.end) {
                // Start didn't parse — a per-candidate fact, not a calendar fact.
                logger.warn('candidate-slot validation — unparseable start, marking unavailable', {
                  candidateStart: cand.start,
                });
                return { start: cand.start, end: cand.start, available: false, error: 'validation_error' };
              }
              try {
                const slots = await findAvailableSlots({
                  userEmail,
                  timezone,
                  durationMinutes: durationMin,
                  attendeeBusyEmails: candidateAttendeeBusyEmails,
                  attendeeAvailability,
                  searchFrom: cand.start,
                  searchTo: cand.end,
                  meetingMode: mode as import('../../../../connectors/graph/calendar').MeetingMode,
                  travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
                  profile: context.profile,
                  category: args.category as string | undefined,
                  relaxed: relaxedGranted,
                  excludeEventIds: excludeEventIdsForSearch,
                  autoExpand: false,
                  minBufferHours: leadHours,
                  viewer,
                  viewerEmail,
                  diagnosticsOut: diag,
                });
                const startMs = DateTime.fromISO(cand.start, { zone: timezone }).toMillis();
                const matches = slots.some(s => Math.abs(DateTime.fromISO(s.start).toMillis() - startMs) <= 60_000);
                // v3.7.x (#143) — an away day is now walked normally (its stated
                // hours in its own tz), so an unavailable away candidate yields a
                // real rejection reason in rejectedCounts — no WE special-casing.
                const brokenRule = matches ? undefined : Object.keys(diag.rejectedCounts ?? {})[0];
                // #148 — render the (already owner-local) slot back in the zone the
                // candidate was STATED in, so Sonnet quotes "08:00 ET (15:00 his time)"
                // instead of head-converting the owner-local time back to the foreign zone.
                // Guard the empty-string parse-fail exactly like the present_in_timezone path.
                const presentLocal = groundTz ? renderClockInZone(cand.start, timezone, groundTz) : '';
                // gh#169 — same grounding gh#168-a computes for the bulk day_summary
                // path (attendeeHoursGroundingNotes), applied to the sibling
                // candidate_validation branch: a candidate rejected on
                // outside_attendee_work_hours carries the blocked attendee's real
                // hours converted into the owner's zone, so a follow-up ("why is
                // that excluded?") is answered by quoting this instead of Sonnet
                // inferring the conversion herself.
                const brokenRuleKind = brokenRule?.includes(':') ? brokenRule.split(':')[0] : brokenRule;
                const blockedEmail = brokenRule?.includes(':') ? brokenRule.slice(brokenRule.indexOf(':') + 1) : undefined;
                const attendeeHoursNote = (brokenRuleKind === 'outside_attendee_work_hours' && blockedEmail)
                  ? attendeeHoursGroundingNotes(
                      [{ email: blockedEmail, slots_blocked: 1 }],
                      cand.start.slice(0, 10),
                      attendeeAvailability,
                      timezone,
                      ownerFirst,
                    )
                  : undefined;
                return {
                  start: cand.start,
                  end: cand.end,
                  available: matches,
                  ...(presentLocal ? { presentation_local: presentLocal } : {}),
                  ...(brokenRule ? { broken_rule: brokenRule, broken_rule_label: labelFor(brokenRule) } : {}),
                  ...(attendeeHoursNote ? { attendee_hours_note: attendeeHoursNote } : {}),
                };
              } catch (err) {
                // `available:false` is a factual claim about his calendar
                // ("that time doesn't work"). When the calendar can't be read,
                // that claim is unfounded and reads to the requester exactly
                // like "he's busy" — the confident wrong "no" M11 forbids.
                // Refuse the whole batch instead of answering every candidate
                // with a fabricated verdict.
                if (err instanceof CalendarOfflineError) throw err;
                logger.warn('candidate-slot validation threw — marking unavailable', {
                  candidateStart: cand.start,
                  err: String(err).slice(0, 200),
                });
                return { start: cand.start, end: cand.end, available: false, error: 'validation_error' };
              }
            }));

            const availableCount = results.filter(r => r.available).length;
            logger.info('find_available_slots — candidate_slots batch', {
              candidates: normalized.length,
              available_count: availableCount,
              requester: context.userId,
              threadTs: context.threadTs,
            });

            // row 163 — same surfacing the main pass does below (shared helper).
            const { attendeeEmailWarning: attendeeEmailWarningCand, attendeeNotCheckedWarning: attendeeNotCheckedWarningCand } =
              attendeeCheckWarnings({
                userEmail,
                ownerFirstName: ownerFirst,
                unresolvedAttendees: [...new Set(perCandidateDiags.flatMap(d => d.unresolvedAttendees ?? []))],
                attendeesNotChecked: [...new Set(perCandidateDiags.flatMap(d => d.attendeesNotChecked ?? []))],
                logSuffix: ' (candidate validation)',
              });

            return {
              mode: 'candidate_validation',
              duration_minutes: durationMin,
              candidates_checked: normalized.length,
              results,
              ...(attendeeEmailWarningCand ?? {}),
              ...(attendeeNotCheckedWarningCand ?? {}),
              ...(groundTz ? { _requested_time_local: `Each result carries presentation_local — the slot in ${groundTz}, ${groundTzStated ? 'the zone the times were given in' : 'a zone Maelle inferred from the attendees (nobody actually stated this zone — do not say the requester asked for it)'}. Quote that alongside the owner-local time ("08:00 ET = 15:00 his time"); NEVER recompute the cross-timezone conversion yourself.` } : {}),
            };
          }

          try {
            const rawSlots = await findAvailableSlots({
              userEmail,
              timezone,
              durationMinutes: args.duration_minutes as number,
              attendeeBusyEmails,
              searchFrom: effectiveSearchFrom,
              searchTo: effectiveSearchTo,
              preferMorning: args.prefer_morning as boolean | undefined,
              meetingMode: mode as import('../../../../connectors/graph/calendar').MeetingMode,
              travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
              attendeeAvailability,
              autoExpand: !userNamedNarrowWindow,
              minBufferHours: leadHours,
              viewer,
              viewerEmail,
              profile: context.profile,
              // v2.3.2 (2A) — relaxed mode opt-in (owner-only). Bypasses
              // focus / lunch / work-hours; keeps the 5-min between-meeting buffer.
              relaxed: relaxedGranted,
              // v2.4.1 — when validating/discovering a MOVE, the meeting(s)
              // being moved are subtracted from busy AND forbidden as
              // candidates. See findAvailableSlots.excludeEventIds for the full
              // semantics.
              excludeEventIds: excludeEventIdsForSearch,
              // v2.6 — category scheduling rules. When set, slot loop filters
              // out slots that would violate the category's day_type / per_day /
              // per_week limits.
              category: args.category as string | undefined,
              diagnosticsOut,
            });
            // gh#168-a — ground the day-level narration BEFORE any return branch
            // below reads diagnosticsOut.daySummary (one enrichment, every exit
            // path benefits — early-return, relaxed-recovery, and full success).
            if (diagnosticsOut.daySummary) {
              for (const day of diagnosticsOut.daySummary) {
                if (day.top_reasons.includes('outside_attendee_work_hours')) {
                  const notes = attendeeHoursGroundingNotes(day.blocked_by, day.date, attendeeAvailability, timezone, context.profile.user.name.split(' ')[0]);
                  if (notes) day.attendee_hours_note = notes;
                }
              }
            }
            // v3.0.3 — strict-pass log. Shows the effective args the low-level
            // function actually ran with, plus what came back. The crucial fields:
            // effectiveSearchFrom / search_to (after any internal clipping) and
            // the resulting slot count + first few. Pairs with the entry log.
            logger.info('find_available_slots — strict pass result', {
              effectiveSearchFrom,
              search_to: args.search_to,
              attendeeEmailsResolved: attendeeEmails,
              attendeeAvailabilityCount: attendeeAvailability?.length ?? 0,
              ignoreAttendeeBusy,
              userNamedNarrowWindow,
              relaxed: relaxedGranted,
              slotCount: rawSlots.length,
              firstSlots: rawSlots.slice(0, 5).map(s => ({ start: s.start, end: s.end })),
              daySummary: diagnosticsOut.daySummary?.map(d => ({
                date: d.date, accepted: d.accepted, top_reasons: d.top_reasons,
              })),
            });

            const { attendeeEmailWarning, attendeeNotCheckedWarning } = attendeeCheckWarnings({
              userEmail,
              ownerFirstName: context.profile.user.name.split(' ')[0],
              unresolvedAttendees: diagnosticsOut.unresolvedAttendees ?? [],
              attendeesNotChecked: diagnosticsOut.attendeesNotChecked ?? [],
              logSuffix: '',
              logExtra: { searchFrom: effectiveSearchFrom, searchTo: args.search_to },
            });

            // v3.3.7 (#125a) — colleague-path soft-block narration hint. When
            // the strict pass rejected slots on the owner's SOFT, owner-
            // relaxable protections (free-time floor / 5-min buffer / floating
            // block), the colleague must hear "his day is too loaded around
            // then" (true, mechanism-free) — and an insisted-on time goes to
            // the owner as an approval, never a flat refusal. Hard busy stays
            // "he's booked".
            // v4.1.x — `owner_buffer_collision` is no longer emitted anywhere
            // (the owner side of travel padding moved into checkSlot, which
            // labels it `travel_buffer_collision`); the attendee side keeps the
            // canonical label too. Same set of soft, owner-relaxable protections.
            //
            // This hint makes a FACTUAL CLAIM ("NOT by real meetings") and
            // then invites the requester to push for an override on the strength
            // of it, so it may only speak about times that genuinely were soft-
            // blocked. Two things make that true now. (1) The labels it reads come
            // from checkSlot's single ladder — a slot that is BOTH inside the lead
            // time and booked solid now reports `owner_busy_collision`, so it can
            // no longer arrive here wearing a soft label (the walker's competing
            // pre-filter is gone). (2) The hint carries the actual soft-blocked
            // INSTANTS from rejectedExamples instead of a vague "some times", so
            // in a mixed window — three soft-held slots among forty real meetings —
            // the model can only steer an override at a time that is on the list,
            // and is told plainly that everything else was a real commitment.
            const SOFT_REJECT_PREFIXES = ['focus_time', 'travel_buffer_collision', 'floating_block_no_room', 'within_lead_time'];
            const softRejectLabels = Object.keys(diagnosticsOut.rejectedCounts ?? {})
              .filter(l => SOFT_REJECT_PREFIXES.some(p => l.startsWith(p)));
            const softBlockedStarts = [...new Set(
              softRejectLabels.flatMap(l => diagnosticsOut.rejectedExamples?.[l] ?? []),
            )]
              .map(iso => DateTime.fromISO(iso, { setZone: true }).setZone(timezone))
              .filter(dt => dt.isValid)
              .sort((a, b) => a.toMillis() - b.toMillis())
              .map(dt => dt.toFormat('EEE d MMM HH:mm'));
            // `rejectedExamples` keeps at most 5 per reason, so on a busy window
            // the list can be a sample. Say which it is — "and only these" on a
            // sample would be the same false claim in a smaller font.
            const softRejectTotal = softRejectLabels
              .reduce((n, l) => n + (diagnosticsOut.rejectedCounts?.[l] ?? 0), 0);
            const softListIsComplete = softBlockedStarts.length >= softRejectTotal;
            const ownerFirstName = context.profile.user.name.split(' ')[0];
            const colleagueSoftBlockHint = (!isOwnerInitiatedSearch && softBlockedStarts.length > 0)
              ? {
                  _colleague_soft_block_hint: (softListIsComplete
                    ? `Exactly these times were excluded by ${ownerFirstName}'s day-load protections rather than by a real meeting: ${softBlockedStarts.join(', ')}. Every OTHER time missing from this window was blocked by something real (a commitment, his working hours, an attendee) — never describe those as merely protective.`
                    : `${softRejectTotal} times in this window were excluded by ${ownerFirstName}'s day-load protections rather than by a real meeting; these are examples: ${softBlockedStarts.join(', ')}. Other missing times may have been blocked by something real (a commitment, his working hours, an attendee) — do not assume a time was merely protective unless it is one of these.`
                  ) + ` For a time in that set, phrase it to the colleague as "his day is pretty loaded around then" (never reveal the mechanism, never enumerate his calendar). If the requester INSISTS on one of those times, do NOT flatly refuse and do NOT book it: raise it via create_approval(kind=policy_exception) with the requested slot so he decides.`,
                }
              : undefined;
            // v2.4.2 — narrow to 3 spread options before returning to Sonnet.
            // Owner spec: "spread 3 options" — one per day where possible, then
            // ≥2h apart same-day, then ≥30min last-resort. Single source of
            // truth: tool returns the spread, Sonnet narrates (rather than
            // receiving raw candidates and over-listing).
            // Edge case: narrow validation searches (HYPOTHETICAL VALIDATION
            // rule, "can we do X at Y?") naturally return ≤1 candidate from
            // findAvailableSlots, and pickSpreadSlots' Pass 1 (one-per-day)
            // returns it unchanged. No regression on the validation path.

            // v2.7.6 — auto-relaxed recovery on user-named narrow windows. When
            // strict returns 0 AND owner asked about a specific day/window
            // AND he didn't already opt into relaxed, automatically re-run with
            // relaxed=true so soft-rule-breaking slots surface tagged. Lets
            // Sonnet narrate "12:30 fits everyone but breaks your focus block
            // — book anyway?" instead of "Monday fully booked." Owner-path only.
            const isAlreadyRelaxed = relaxedGranted;
            // #128 part-2 — a colleague's MUST-BE request (Sonnet sets must_be:
            // they named a specific time, or said "has to be today/tomorrow" and
            // the owner's clean options are too far) reuses the SAME relaxed
            // recovery as the owner path to surface the soft-blocked candidates —
            // but they come back for the OWNER's approval ONLY, never offered to
            // the colleague (see the must-be return below). Regular colleague
            // requests stay fully blocked (no recovery, no surfacing).
            const mustBe = args.must_be === true && !isOwnerInitiatedSearch;
            const shouldRecover =
              rawSlots.length === 0
              && (isOwnerInitiatedSearch || mustBe)
              && userNamedNarrowWindow
              && !isAlreadyRelaxed;
            // ── Rule 6 backstop (shared) — attendee free/busy is a HELPER,
            // never a blocker. When the STRICT pass returned 0 ONLY because
            // attendee(s) are busy/off-hours, don't dead-end. Re-run the SAME
            // window recovering the owner's real openings, presented per
            // audience. ONE function, two callers (rule 2 — no parallel copies):
            //   'owner_tagged'         — owner rules stay STRICT (his day / focus
            //       / own busy all enforced via checkSlot); attendee conflicts
            //       come back TAGGED (attendee_conflicts[]) so he sees his open
            //       times + who can't make each and books whom he likes (rules
            //       6/7/11). This is what stops the "0 clean → Sonnet flips
            //       ignore_attendee_availability → offered-then-bounced" loop
            //       (Maayan+Lori, 2026-07-08): the tool hands back the annotated
            //       truth in ONE call, so Sonnet never guesses a blind 2nd search.
            //   'colleague_owner_only' — owner-only for real calendar BUSY detail
            //       (attendeeBusyEmails stays owner-only, rule 7: a colleague never
            //       sees another attendee's actual calendar). But the per-attendee
            //       WORK-HOURS clip (attendeeAvailability) is real, non-calendar
            //       data (just stored/assumed hours) and is exactly what the
            //       strict pass just rejected these slots for — nulling it here
            //       used to check the recovered slots against ONLY the owner's own
            //       calendar, so a slot outside every other attendee's hours came
            //       back looking clean. Keep it live and TAGGED (attendee_conflicts)
            //       so the truth survives into the result instead of vanishing.
            //       If the owner is himself busy, owner-only also returns 0 →
            //       honest "he's booked then."
            const recoverAttendeeBlockedSlots = (audience: 'owner_tagged' | 'colleague_owner_only') => {
              const ownerAudience = audience === 'owner_tagged';
              return findAvailableSlots({
                userEmail,
                timezone,
                durationMinutes: args.duration_minutes as number,
                attendeeBusyEmails: ownerAudience ? attendeeEmails : undefined,
                attendeeAvailability,   // both audiences — the work-hours clip is not calendar detail
                tagAttendeeConflicts: true,   // both audiences: keep the day strict, TAG conflicts (never silently drop)
                searchFrom: effectiveSearchFrom,
                searchTo: effectiveSearchTo,
                preferMorning: args.prefer_morning as boolean | undefined,
                meetingMode: mode as import('../../../../connectors/graph/calendar').MeetingMode,
                travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
                autoExpand: !userNamedNarrowWindow,
                // Owner-audience recovery reads his OWN lead time even on a
                // colleague turn — the slots come back for HIM to choose from.
                minBufferHours: ownerAudience
                  ? bookingLeadTimeHours(context.profile, 'owner')
                  : leadHours,
                viewer,
                viewerEmail,
                profile: context.profile,
                relaxed: false,
                excludeEventIds: excludeEventIdsForSearch,
                category: args.category as string | undefined,
              });
            };
            // Colleague path: strict-failed only on attendee busy → owner-only.
            let colleagueOwnerOnlySlots: typeof rawSlots = [];
            if (rawSlots.length === 0 && !isOwnerInitiatedSearch && !mustBe && attendeeEmails.length > 0) {
              try {
                colleagueOwnerOnlySlots = await recoverAttendeeBlockedSlots('colleague_owner_only');
                if (colleagueOwnerOnlySlots.length > 0) {
                  logger.info('find_available_slots — colleague attendee-blocker backstop: owner-only fallback', {
                    ownerOnlyCount: colleagueOwnerOnlySlots.length,
                  });
                }
              } catch (err) {
                logger.warn('find_available_slots — colleague owner-only fallback threw, continuing', { err: String(err).slice(0, 150) });
              }
            }
            // Owner path — OR an insistent colleague (mustBe) — strict-failed only on
            // attendee busy → surface the OWNER's genuinely open times with each attendee
            // conflict tagged, instead of returning empty. For the owner: "here's who can't
            // make it, your call." For the colleague (#145, 2026-07-21 owner direction):
            // "the attendee's busy, but it's YOUR call — want it anyway?" and they can book
            // over. Attendee availability is the REQUESTER's call, never the owner's; his own
            // busy/rules never land in this set (those fail strict checkSlot → recovery=0 →
            // the #128 soft-rule path handles them instead). Not run when the owner opted
            // into ignore_attendee_availability or already searched relaxed.
            let ownerAttendeeTaggedSlots: typeof rawSlots = [];
            if (
              rawSlots.length === 0 && (isOwnerInitiatedSearch || mustBe)
              && !ignoreAttendeeBusy && !isAlreadyRelaxed
              && attendeeEmails.length > 0
            ) {
              try {
                ownerAttendeeTaggedSlots = await recoverAttendeeBlockedSlots('owner_tagged');
                if (ownerAttendeeTaggedSlots.length > 0) {
                  logger.info('find_available_slots — owner attendee-blocker backstop: owner-strict + tagged conflicts', {
                    taggedCount: ownerAttendeeTaggedSlots.length,
                  });
                }
              } catch (err) {
                logger.warn('find_available_slots — owner attendee-tagged backstop threw, continuing', { err: String(err).slice(0, 150) });
              }
            }
            if (rawSlots.length === 0 && !shouldRecover && colleagueOwnerOnlySlots.length === 0 && ownerAttendeeTaggedSlots.length === 0) {
              if (attendeeEmailWarning || attendeeNotCheckedWarning || colleagueSoftBlockHint) {
                return {
                  slots: rawSlots,
                  ...(diagnosticsOut.daySummary && diagnosticsOut.daySummary.length > 0
                    ? { day_summary: diagnosticsOut.daySummary } : {}),
                  ...(attendeeEmailWarning ?? {}),
                  ...(attendeeNotCheckedWarning ?? {}),
                  ...(colleagueSoftBlockHint ?? {}),
                  ...tzGroundingFields,
                };
              }
              return rawSlots;
            }
            let relaxedRecoverySlots: typeof rawSlots = [];
            const strictDaySummary = diagnosticsOut.daySummary;
            // Owner-tagged backstop wins over relaxing soft rules: his genuinely
            // open times (attendee-conflicted) beat times that break his focus /
            // lunch / category limits. Only relax when he has no open slot at all.
            if (shouldRecover && ownerAttendeeTaggedSlots.length === 0) {
              try {
                relaxedRecoverySlots = await findAvailableSlots({
                  userEmail,
                  timezone,
                  durationMinutes: args.duration_minutes as number,
                  attendeeBusyEmails,
                  searchFrom: effectiveSearchFrom,
                  searchTo: effectiveSearchTo,
                  preferMorning: args.prefer_morning as boolean | undefined,
                  meetingMode: mode as import('../../../../connectors/graph/calendar').MeetingMode,
                  travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
                  attendeeAvailability,
                  viewer,
                  viewerEmail,
                  profile: context.profile,
                  // No `minBufferHours` — it would be set-but-never-read. `relaxed`
                  // is a TOTAL owner override in both places that consume the lead
                  // time: the walker's pre-filter collapses to "not in the past"
                  // and checkSlot rule 0b is bypassed. (It used to be passed with
                  // a comment claiming "#128 must-be searches at HIS lead"; the
                  // recovery has never honoured any lead floor, and the slots it
                  // surfaces go to the OWNER as approval candidates anyway.)
                  relaxed: true,       // bypass focus / lunch / category — his soft day-load rules
                  keepWorkHours: true, // …but relaxing a soft block is not extending his day
                  excludeEventIds: excludeEventIdsForSearch,
                  category: args.category as string | undefined,
                  autoExpand: false,  // recovery stays inside the user's window
                });
                // v3.1.7 — the recovery is clipped to the owner's working DAY, and
                // that clip now lives INSIDE the walker (`keepWorkHours`), above
                // its per-day cap. It used to run out here, re-deriving the day's
                // windows from getEffectiveWorkDay + isSlotInWorkHours AFTER the
                // walker had already spent its 8-slot budget ranking nocturnal
                // candidates — so a recovery could report 8 accepted and hand back
                // 0 (this same log, 06:59:36). One work-hours decision, taken by
                // the validator, before anything is discarded.
                logger.info('find_available_slots — relaxed recovery', {
                  strictAccepted: 0,
                  relaxedAccepted: relaxedRecoverySlots.length,
                  windowDays: 'narrow',
                });
              } catch (recErr) {
                logger.warn('find_available_slots — relaxed recovery threw', {
                  err: String(recErr).slice(0, 200),
                });
              }
              if (relaxedRecoverySlots.length === 0) {
                // Recovery also empty — return original empty result with day_summary.
                if ((strictDaySummary && strictDaySummary.length > 0) || attendeeEmailWarning || attendeeNotCheckedWarning || colleagueSoftBlockHint) {
                  return {
                    slots: [],
                    ...(strictDaySummary && strictDaySummary.length > 0 ? { day_summary: strictDaySummary } : {}),
                    ...(attendeeEmailWarning ?? {}),
                    ...(attendeeNotCheckedWarning ?? {}),
                    ...(colleagueSoftBlockHint ?? {}),
                  };
                }
                return [];
              }
              // #128 part-2 — colleague MUST-BE with surfaced candidates. These
              // times are open ONLY because the recovery relaxed the owner's soft
              // protections (booking lead-time / focus / buffer). The colleague
              // must NOT see or book them — return them as OWNER approval
              // candidates so Sonnet raises create_approval(policy_exception); the
              // owner's single yes books via the existing resolver. (Owner-path
              // recovery is unaffected — it falls through to the candidate logic
              // below as before.)
              if (mustBe && relaxedRecoverySlots.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { pickSpreadSlots: pickSpreadMustBe } = require('../../../../connectors/graph/calendar') as
                  typeof import('../../../../connectors/graph/calendar');
                const pickedMustBe = new Set(pickSpreadMustBe(relaxedRecoverySlots, timezone, offerCount, undefined, args.duration_minutes as number | undefined));
                const ownerFirst = context.profile.user.name.split(' ')[0];
                const candidates = relaxedRecoverySlots
                  .filter(s => pickedMustBe.has(s.start))
                  .map(s => {
                    const st = DateTime.fromISO(s.start).setZone(timezone);
                    const en = DateTime.fromISO(s.end).setZone(timezone);
                    return { start: s.start, end: s.end, label: `${st.toFormat('EEE d MMM HH:mm')}–${en.toFormat('HH:mm')}` };
                  });
                return {
                  slots: [],
                  owner_approval_candidates: candidates,
                  _must_be_owner_approval_note: `No clean slot here — these times are open but sit inside ${ownerFirst}'s day-load protections (focus / buffer / booking lead-time), so they're his call. This is a MUST-BE request: do NOT tell the colleague there's no time and do NOT book directly. Raise create_approval(kind=policy_exception) with ONE of owner_approval_candidates plus the urgency reason so ${ownerFirst} decides with a single yes. Never reveal these specific times (or the mechanism) to the colleague — only that you're checking with ${ownerFirst}.`,
                  ...(strictDaySummary && strictDaySummary.length > 0 ? { day_summary: strictDaySummary } : {}),
                };
              }
            }
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { pickSpreadSlots } = require('../../../../connectors/graph/calendar') as
              typeof import('../../../../connectors/graph/calendar');
            // When the call is a MOVE (moving_event_ids set), prefer same-day
            // options for the meeting being moved. resolveMovingAnchorDay
            // looks up the moving event's local date (cheap — getCalendarEvents
            // is per-turn memoized) and pickSpreadSlots walks that day first.
            // Falls back to undefined → pure chronological for new bookings.
            const { resolveMovingAnchorDay } = await import('../../../../utils/movingAnchorDay');
            const movingIds = Array.isArray(args.moving_event_ids)
              ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
              : [];
            const anchorDay = movingIds.length > 0
              ? await resolveMovingAnchorDay(movingIds, userEmail, timezone)
              : undefined;
            // v2.7.6 — when relaxed recovery surfaced slots, use those as the
            // candidate set. They came from the relaxed pass which bypassed
            // soft rules (focus / lunch / work-hours). Sonnet narrates the
            // violation from the strict day_summary so the owner sees the
            // trade-off explicitly: "12:30 fits everyone but eats into your
            // 2h focus block — want it anyway?"
            // Rule 6 backstop result selection. Precedence:
            //   1) owner-tagged backstop — his open times, attendee-conflicted
            //      (best: his day untouched; carries attendee_conflicts tags).
            //   2) relaxed recovery — times that break his soft rules.
            //   3) colleague owner-only — his open times, attendee HOURS tagged
            //      (off_hours), attendee real calendar busy stays uncheckable.
            //   4) rawSlots (the clean strict result).
            // (1) and (2) are mutually exclusive by construction — the relaxed
            // recovery is gated off when the owner-tagged backstop found slots.
            const usedOwnerAttendeeTagged = ownerAttendeeTaggedSlots.length > 0;
            const usedColleagueOwnerOnly = !usedOwnerAttendeeTagged
              && relaxedRecoverySlots.length === 0 && colleagueOwnerOnlySlots.length > 0;
            const candidateSet = usedOwnerAttendeeTagged
              ? ownerAttendeeTaggedSlots
              : relaxedRecoverySlots.length > 0
                ? relaxedRecoverySlots
                : (usedColleagueOwnerOnly ? colleagueOwnerOnlySlots : rawSlots);
            // DEPRIORITIZE held slots: a time tentatively held for someone
            // else is never the first offer. Pick from the FREE candidates; a
            // held time only surfaces (tagged, below) when there's nothing free
            // left in the window — better than "no slots", and the owner can
            // still book over it explicitly (the confirm gate fires). Holds are
            // internal state, so Graph free/busy reports them free — without this
            // they'd rank like any open slot.
            let pickPool = candidateSet;
            try {
              const { getActiveSlotHolds: getHolds } = await import('../../../../db/slotHolds');
              const heldNow = getHolds(context.profile.user.slack_user_id);
              if (heldNow.length > 0) {
                const overlapsHold = (s: { start: string; end?: string }) => {
                  const ss = Date.parse(s.start);
                  const se = Date.parse(s.end ?? s.start);
                  return heldNow.some(h => {
                    const hs = Date.parse(h.start_iso);
                    const he = Date.parse(h.end_iso);
                    return Number.isFinite(hs) && Number.isFinite(he) && ss < he && se > hs;
                  });
                };
                const freeOnly = candidateSet.filter(s => !overlapsHold(s));
                if (freeOnly.length > 0) pickPool = freeOnly;  // hold back held slots while free ones exist
              }
            } catch (err) {
              logger.warn('find_available_slots — hold deprioritization threw, using full set', { err: String(err).slice(0, 120) });
            }
            // v3.7.2 (#142a) — fingerprint THIS search's shaping params so the
            // exclusion below can tell a real "give me another option" (same
            // shape) from a refinement (duration / window / attendee change).
            // Colleague-controlled axes only; raw window (pre-expand) for stability.
            const attendeesFp = Array.isArray(args.attendee_emails)
              ? [...(args.attendee_emails as unknown[])].map(e => String(e).trim().toLowerCase()).filter(Boolean).sort().join(',')
              : '';
            const offerFingerprint = `${args.duration_minutes ?? ''}|${args.search_from ?? ''}|${args.search_to ?? ''}|${attendeesFp}`;
            // v3.4.2 — DROP slots already offered in this conversation so "give me
            // another option" returns NEW times, not the same spread again. The
            // stash is the UNION of everything shown this conversation; on the
            // FIRST search it's empty → no-op. Verifying specific named slots runs
            // in the candidate_slots path above, not here, so it's unaffected. If
            // exclusion would empty the pool, keep the full pool (never go silent).
            // v3.7.2 (#142a) — gated on a fingerprint MATCH: a refinement (a "30
            // min" clarification, a narrowed window, an added attendee) is the SAME
            // ask re-parametrized, NOT "another day", so its best slots must not be
            // dropped just because an earlier, differently-shaped search showed them
            // (Michal 2026-07-13 — "30 min" returned a disjoint set, hiding 12:45 &
            // 13:45). Bias to SKIP: a false skip merely re-shows a slot; a false
            // exclude hides an open one.
            try {
              const { getOfferedSlots, getOfferedSearchFingerprint } = await import('../../../../utils/offeredSlotsStash');
              const offered = getOfferedSlots(context.channelId, context.threadTs) ?? [];
              const priorFingerprint = getOfferedSearchFingerprint(context.channelId, context.threadTs);
              if (offered.length > 0 && priorFingerprint !== null && priorFingerprint === offerFingerprint) {
                const offeredMs = new Set(offered.map(o => Date.parse(o.startIso)).filter(Number.isFinite));
                const fresh = pickPool.filter(s => !offeredMs.has(Date.parse(s.start)));
                if (fresh.length > 0) pickPool = fresh;
              }
            } catch (err) {
              logger.warn('find_available_slots — offered-slot exclusion threw, using full pool', { err: String(err).slice(0, 120) });
            }
            const chosenStarts = new Set(pickSpreadSlots(pickPool, timezone, offerCount, anchorDay, args.duration_minutes as number | undefined));

            // v2.9.2 — preferred_slot guarantee. When the requester named a
            // specific time ("preferably 11:30"), pickSpreadSlots' MIN_GAP
            // rule could filter it (e.g. 11:00 picked first → 11:30 within
            // 1h gap → dropped). Sonnet would then narrate "11:30 isn't
            // clean" by absence-inference even though 11:30 passed all
            // rules. Force-include the preferred slot when it's in the
            // candidate set but missing from picks.
            const preferredSlot = typeof args.preferred_slot === 'string' && args.preferred_slot.trim().length > 0
              ? args.preferred_slot.trim()
              : null;
            // v4.1.x (M10/M11) — set when the named time is NOT offerable, so the
            // result can say WHY instead of letting the model infer "unavailable"
            // from absence. Never merged into `slots`: an excluded slot is still
            // excluded (#142d / M3 — a slot a real commitment already holds is
            // deliberately never PROPOSED, whoever else is on it). The bug was the
            // silence, not the drop.
            let preferredSlotStatus: Record<string, unknown> | undefined;
            if (preferredSlot) {
              const matchingCandidate = candidateSet.find(s => {
                try {
                  // Match by absolute time, tolerate format drift (offset suffix, etc.)
                  return Math.abs(
                    DateTime.fromISO(s.start).toMillis() - DateTime.fromISO(preferredSlot).toMillis()
                  ) <= 60_000;
                } catch { return false; }
              });
              if (matchingCandidate && !chosenStarts.has(matchingCandidate.start)) {
                chosenStarts.add(matchingCandidate.start);
                logger.info('find_available_slots — preferred_slot force-included (would have been spread-filtered)', {
                  preferredSlot,
                  candidateStart: matchingCandidate.start,
                });
              } else if (!matchingCandidate) {
                // Pre-fix this branch logged and did NOTHING — the named time
                // vanished from the payload and the model inferred it was
                // "not available", so the owner could not override a block he
                // was never told about (M10: the override must reach the SEARCH
                // surface too). Re-check that ONE slot through the SAME engine
                // the sibling candidate_slots branch uses and hand back its real
                // reason. Convergence, not a second path.
                try {
                  const ownerFirstPref = context.profile.user.name.split(' ')[0];
                  const durMinPref = args.duration_minutes as number;
                  const prefStartDt = DateTime.fromISO(preferredSlot, { zone: timezone });
                  const prefEndIso = prefStartDt.isValid
                    ? (prefStartDt.plus({ minutes: durMinPref }).toISO() ?? preferredSlot)
                    : preferredSlot;
                  const prefDiag: { rejectedCounts?: Record<string, number> } = {};
                  const prefSlots = await findAvailableSlots({
                    userEmail,
                    timezone,
                    durationMinutes: durMinPref,
                    attendeeBusyEmails,
                    attendeeAvailability,
                    searchFrom: preferredSlot,
                    searchTo: prefEndIso,
                    meetingMode: mode as import('../../../../connectors/graph/calendar').MeetingMode,
                    travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
                    profile: context.profile,
                    category: args.category as string | undefined,
                    relaxed: relaxedGranted,
                    excludeEventIds: excludeEventIdsForSearch,
                    autoExpand: false,
                    minBufferHours: leadHours,
                    viewer,
                    viewerEmail,
                    diagnosticsOut: prefDiag,
                  });
                  const prefAvailable = prefSlots.length > 0;
                  const brokenRule = prefAvailable ? undefined : Object.keys(prefDiag.rejectedCounts ?? {})[0];
                  // Shared presentation-zone (presentTzForOutput, declared above) —
                  // this branch answers about the SAME preferred_slot instant the
                  // main `slots` list renders below, and must use the same zone, or
                  // a requester who asked "in ET" gets every offered slot in ET
                  // except the one they specifically named.
                  const preferredPresentationLocal = presentTzForOutput
                    ? renderClockInZone(preferredSlot, timezone, presentTzForOutput)
                    : '';
                  preferredSlotStatus = {
                    start: preferredSlot,
                    end: prefEndIso,
                    available: prefAvailable,
                    ...(preferredPresentationLocal ? { presentation_local: preferredPresentationLocal } : {}),
                    ...(brokenRule
                      ? { broken_rule: brokenRule, broken_rule_label: humanizeViolationLabel(brokenRule, ownerFirstPref) }
                      : {}),
                    _note: prefAvailable
                      // Passed the engine yet isn't in the offered set → it is
                      // genuinely bookable and simply didn't make the list (the
                      // per-day cap / the spread filled it with other times, or it
                      // sits outside the window the list was drawn from). It used to
                      // read "it sits on a commitment with someone outside the
                      // company" — a guess dressed as a fact, and now a wrong one:
                      // a slot held by ANY real commitment fails this very re-check
                      // and lands in the branch below with the true label.
                      ? `The specific time asked for (${preferredSlot}) clears every one of ${ownerFirstPref}'s rules and nothing is booked on it — it just didn't make the offered list. Treat it as available and offer it alongside \`slots\`; never imply it's blocked, and never stay silent about it.`
                      : `The specific time asked for (${preferredSlot}) is NOT bookable: ${humanizeViolationLabel(brokenRule, ownerFirstPref)}. Say this plainly and in human terms — never let it just be missing from the list. Then offer the alternatives in \`slots\`. If ${ownerFirstPref} says to do it anyway, that is his call: re-book with relaxed=true.`,
                  };
                  logger.info('find_available_slots — preferred_slot not offered, annotated with its real reason', {
                    preferredSlot, available: prefAvailable, brokenRule,
                  });
                } catch (err) {
                  logger.warn('find_available_slots — preferred_slot re-check threw; no annotation', {
                    preferredSlot, err: String(err).slice(0, 160),
                  });
                }
              }
            }

            const slots = candidateSet.filter(s => chosenStarts.has(s.start));

            // v2.7.0 — initiator-aware annotation. Owner-path normally pre-drops
            // attendee-busy slots via attendeeBusyEmails. Colleague-path doesn't
            // pre-drop — it ANNOTATES each slot with the attendee's free/busy
            // status so Sonnet narrates honestly.
            //
            // v3.3.x (Dina webinar, 2026-06-14) — the OWNER path REUSES that
            // annotation when finding time for a
            // colleague-REQUESTED meeting. When the owner says "find her a time"
            // for a meeting the colleague asked for (esp. urgent), the colleague
            // is FLEXIBLE — she'll move her own thing — so her busy must NOT
            // hard-drop the owner's free slots. Sonnet signals this by setting
            // ignore_attendee_availability (→ attendeeBusyEmails undefined, no
            // hard drop); we then run the SAME annotation so the result is
            // "12:30: owner free, Dina busy" and Maelle can say "works for you —
            // want me to ask Dina to move it?" instead of "no time".
            const annotateForFlexibleRequester = isOwnerInitiatedSearch && ignoreAttendeeBusy;
            let annotatedSlots: Array<any> = slots;
            if ((!isOwnerInitiatedSearch || annotateForFlexibleRequester) && attendeeEmails.length > 0) {
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { annotateSlotsWithAttendeeStatus } = require('../../../../utils/annotateSlotsWithAttendeeStatus') as
                  typeof import('../../../../utils/annotateSlotsWithAttendeeStatus');
                const ownerDomain = userEmail.includes('@') ? userEmail.split('@')[1].toLowerCase() : '';
                const internalAttendees = attendeeEmails.filter(e => {
                  const lower = e.toLowerCase();
                  return ownerDomain && lower.endsWith('@' + ownerDomain) && lower !== userEmail.toLowerCase();
                });
                // Annotate per internal attendee — one getFreeBusy call each.
                // External attendees skipped (we can't see their calendar);
                // they appear in Sonnet's narration with explicit "external,
                // can't verify" framing instead.
                const perAttendeeAnnotations = await Promise.all(
                  internalAttendees.map(async email => {
                    const ann = await annotateSlotsWithAttendeeStatus({
                      slots: slots as any,
                      attendeeEmail: email,
                      callerEmail: userEmail,
                      timezone,
                    });
                    return { email, ann };
                  }),
                );
                annotatedSlots = slots.map((s: any) => {
                  const attendee_status = perAttendeeAnnotations.map(p => {
                    const match = p.ann.find(a => a.slot.start === s.start);
                    return { email: p.email, kind: 'internal', status: match?.attendeeStatus ?? 'unknown' };
                  });
                  // External attendees → always 'unknown'
                  const externals = attendeeEmails.filter(e => {
                    const lower = e.toLowerCase();
                    return !ownerDomain || !lower.endsWith('@' + ownerDomain);
                  }).map(email => ({ email, kind: 'external', status: 'unknown' as const }));
                  return { ...s, attendee_status: [...attendee_status, ...externals] };
                });
              } catch (err) {
                logger.warn('find_available_slots — colleague-path annotation threw, returning unannotated slots', {
                  err: String(err).slice(0, 200),
                });
              }
            }

            // v2.5.2 — surface travelers so Sonnet renders dual-TZ on slot
            // lines. Travelers list only present when at least one attendee had
            // an active travel record at availability-load time. v3.1.2 —
            // `location` (free text, e.g. "Boston") is the ONLY field Sonnet
            // should narrate; the raw IANA tz fields are deliberately NOT shipped
            // — a timezone is not a place, and leaving the IANA in the tool JSON
            // re-opens the "America/New_York → New York" paste risk. TZ math is
            // handled by per_attendee_local below + the slot-finder clip.
            const travelers = (attendeeAvailability ?? [])
              .filter(a => a.travel)
              .map(a => ({
                email: a.email,
                location: a.travel!.location,
                until: a.travel!.until,
              }));

            // v2.8.3 hotfix — when attendees live in a TZ different from owner's,
            // pre-render the slot in each such attendee's local TZ and attach to
            // the slot result. Sonnet quotes verbatim instead of doing the math
            // in chat (the conversion is pure determinism, no judgment).
            // v3.3.8 — per-day TZ resolution (travel-window aware): an attendee
            // whose trip covers a slot's day renders in the TRAVEL tz for that
            // slot and the HOME tz for others — and gets NO parenthetical at all
            // on days their effective tz matches the owner's.
            const tzCandidates = (attendeeAvailability ?? []).filter(a => a.timezone);
            if (tzCandidates.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { attendeeTzForDay } = require('../../../../utils/attendeeAvailability') as
                typeof import('../../../../utils/attendeeAvailability');
              annotatedSlots = annotatedSlots.map((s: any) => {
                const slotDt = DateTime.fromISO(s.start, { zone: timezone });
                if (!slotDt.isValid) return s;
                const slotDayIso = slotDt.toFormat('yyyy-MM-dd');
                const per_attendee_local = tzCandidates.map(a => {
                  const effTz = attendeeTzForDay(a, slotDayIso);
                  if (effTz === timezone) return null;  // same wall-clock — no parenthetical
                  const dt = slotDt.setZone(effTz);
                  if (!dt.isValid) return null;
                  // v3.1.2 — no raw IANA in the result. local_display is the
                  // pre-rendered string Sonnet quotes; local_iso carries the
                  // offset (no city). Shipping the IANA tag invites
                  // "America/New_York → New York" pastes.
                  return {
                    email: a.email,
                    local_iso: dt.toISO(),
                    local_display: dt.toFormat('EEE d MMM HH:mm'),
                  };
                }).filter((p): p is NonNullable<typeof p> => p !== null);
                return per_attendee_local.length > 0 ? { ...s, per_attendee_local } : s;
              });
            }

            // Presentation timezone — the requester asked for options in a
            // specific zone (e.g. "in ET"), even when no attendee is stored
            // there (an organizer collecting options for US colleagues). Without
            // this, the tool gave Sonnet nothing to quote and she mathed ET
            // herself and inverted it ("09:00 ET = 02:00 Israel"). Pre-render
            // each slot in the requested zone deterministically. Ship only the
            // formatted string (with the short offset name, e.g. "EDT") — never
            // the raw IANA, to avoid the "America/New_York → New York" paste.
            // #24 — presentTzForOutput (declared above) falls back to autoPresentTz
            // when the caller left this unset but exactly one loaded attendee zone
            // differs from the owner's; an explicit value here still wins.
            if (presentTzForOutput) {
              // v3.4.2 (A2) — shared renderer, same string create/move echo back.
              annotatedSlots = annotatedSlots.map((s: any) => {
                const display = renderClockInZone(s.start, timezone, presentTzForOutput);
                return display ? { ...s, presentation_local: display } : s;
              });
            }
            // v3.3.8 — remember what's being OFFERED in this conversation so a
            // later pick ("Tuesday 20:30") binds to the offered instant instead
            // of re-deriving the date. The orchestrator injects these on
            // subsequent turns. Colleague-path only — the owner-path has its own
            // correction loop. v4.3.0 (#24) — ALSO the email channel: every
            // email turn carries senderRole 'owner' (the email sender gate), but the
            // actual picker is the external on the other end of a forwarded
            // chain, so the email leg needs the exact same binding the
            // colleague path gets. offeredSlotsStash itself gives the email key
            // the longer, restart-surviving TTL (by key prefix) — this call site
            // only needs to widen WHEN it records.
            const isEmailLeg = context.channel === 'email';
            if ((!isOwnerInitiatedSearch || isEmailLeg) && annotatedSlots.length > 0 && context.channelId) {
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { recordOfferedSlots } = require('../../../../utils/offeredSlotsStash') as
                  typeof import('../../../../utils/offeredSlotsStash');
                recordOfferedSlots({
                  channelId: context.channelId,
                  threadTs: context.threadTs,
                  timezone,
                  slots: annotatedSlots as Array<{ start: string }>,
                  searchFingerprint: offerFingerprint,
                });
              } catch (err) {
                logger.warn('offeredSlotsStash record failed — continuing', {
                  err: String(err).slice(0, 150),
                });
              }
            }

            // Annotate any returned slot overlapping an active hold. Never
            // drop it (the owner arbitrates races); just tag it so Maelle narrates
            // "tentatively held". PRIVACY: the OWNER sees who holds it + why; a
            // colleague hears only "held" (never another colleague's name), unless
            // it's THEIR OWN hold ("still yours").
            try {
              const { getActiveSlotHolds } = await import('../../../../db/slotHolds');
              const holds = getActiveSlotHolds(context.profile.user.slack_user_id);
              if (holds.length > 0) {
                annotatedSlots = annotatedSlots.map((s: any) => {
                  const sStart = Date.parse(s.start);
                  const sEnd = Date.parse(s.end ?? s.start);
                  const hit = holds.find(h => {
                    const hs = Date.parse(h.start_iso);
                    const he = Date.parse(h.end_iso);
                    return Number.isFinite(hs) && Number.isFinite(he) && sStart < he && sEnd > hs;
                  });
                  if (!hit) return s;
                  if (!isOwnerInitiatedSearch && hit.holder_slack_id === context.userId) {
                    return { ...s, on_hold: { status: 'yours', note: 'You are already holding this time — confirm to book it, or pick another.' } };
                  }
                  if (isOwnerInitiatedSearch) {
                    return { ...s, on_hold: { status: 'held', holder: hit.holder_name, reason: hit.reason ?? undefined,
                      note: `Tentatively held for ${hit.holder_name}${hit.reason ? ` (${hit.reason})` : ''} — booking over it will release the hold + notify them.` } };
                  }
                  return { ...s, on_hold: { status: 'held',
                    note: 'This time is tentatively held by someone else. Offer to wait or look at alternatives — do NOT name who holds it. If they INSIST, raise create_approval(kind=policy_exception) so the owner decides; never book it directly.' } };
                });
              }
            } catch (err) {
              logger.warn('find_available_slots — hold annotation threw, continuing', { err: String(err).slice(0, 150) });
            }

            // Surface per-day summary alongside slots so Sonnet can answer
            // "why no Monday?" honestly. When both travelers and day_summary
            // are empty, fall back to the legacy array shape so existing
            // narration paths see the same plain list.
            // strictDaySummary holds the rejection breakdown from the STRICT
            // pass — that's the authoritative "why was this slot relaxed-only"
            // signal. diagnosticsOut.daySummary at this point reflects whichever
            // pass ran last (strict OR recovery); strictDaySummary was captured
            // before recovery to preserve the original blame.
            const isRecoveryResult = relaxedRecoverySlots.length > 0;
            const daySummary = isRecoveryResult
              ? strictDaySummary
              : diagnosticsOut.daySummary;
            const hasDaySummary = Array.isArray(daySummary) && daySummary.length > 0;
            // Relaxed (owner-override) search keeps attendee-conflicted slots
            // instead of dropping them, tagged with `attendee_conflicts`. Tell
            // the owner WHO's busy / off-hours per slot (rules 6 + 7) — never
            // present a conflicted slot as clean.
            const hasAttendeeConflicts = annotatedSlots.some(
              (s: any) => Array.isArray(s.attendee_conflicts) && s.attendee_conflicts.length > 0,
            );
            // v3.6.4 — any surfaced slot that sits over an optional-join event.
            // Only ever present when clean slots were too few to fill the spread
            // (the tier holds them back otherwise), so their appearance IS the
            // signal to narrate the trade-off.
            const hasOverOptional = annotatedSlots.some((s: any) => typeof s.over_optional === 'string' && s.over_optional.length > 0);
            // #Ayala-3 (2026-08-06) — a per-slot, QUOTABLE label, not just a
            // top-level "some slots" note. The Ayala/"Weekly Forecast" incident
            // had `over_optional` set and `_over_optional_note` attached (both
            // traced end to end above), yet the reply presented the WE-tagged
            // slot as clean while narrating a DIFFERENT attendee's real conflict
            // in the same message — a colleague-path search always carries a
            // SECOND per-slot signal (`attendee_status`) explained only in the
            // system prompt, and asking the model to also cross-reference a
            // free-text top-level note against "which slot" for a second,
            // unrelated fact is exactly the class of gap M14 exists to close for
            // timezone strings: don't narrate from data, quote a rendered string
            // verbatim. `less_preferred_label` is that string, attached directly
            // to the slot it describes — same pattern as `presentation_local` /
            // `broken_rule_label` below.
            //
            // Bounced 2026-08-06 (bounces:2) — owner's call: the label carries
            // NO reason and NO subject, for either audience. "i suggested 'less
            // preferred' they don't need to know why, just let them a chance to
            // choose something else." A prior version varied the string by
            // `viewer` (a second-person "your optional ..." for the owner, a
            // person-free framing for everyone else) specifically to avoid
            // narrating whose meeting it was or naming its subject — that's now
            // moot since the label never carries either, for anyone. Both
            // branches below emit the identical bare marker; the `viewer` check
            // is kept only as a structural seam for a future real difference,
            // not because the content differs today.
            if (hasOverOptional) {
              annotatedSlots = annotatedSlots.map((s: any) => {
                if (typeof s.over_optional !== 'string' || s.over_optional.length === 0) return s;
                return { ...s, less_preferred_label: 'less preferred' };
              });
            }
            // Does the payload actually CARRY the per-slot rule it breaks? The
            // walker emits `broken_rule_label` for the owner's own view only, so a
            // note that promised it unconditionally would, on any other view, tell
            // the model to quote a field that isn't there — and a model told to name
            // a reason it cannot read is a model that invents one (M11).
            const hasBrokenRuleLabel = annotatedSlots.some((s: any) => typeof s.broken_rule_label === 'string' && s.broken_rule_label.length > 0);
            // `attendee_status` (per-slot, from the annotation above) ships bare on
            // a plain colleague-initiated search. Its per-slot semantics are
            // explained unconditionally by the system prompt (meetings.ts's
            // "OWNER FREE, REQUESTER BUSY" paragraph) — o#186 removed the
            // duplicate per-call `_attendee_status_note` that repeated the same
            // instruction here. This flag's only remaining job is to force the
            // `{slots, ...}` wrapper (below) even when no OTHER condition would,
            // so a search whose sole distinguishing fact is attendee_status still
            // returns the same shape as every other annotated result.
            const hasAttendeeStatus = annotatedSlots.some(
              (s: any) => Array.isArray(s.attendee_status) && s.attendee_status.length > 0,
            );
            if (travelers.length > 0 || hasDaySummary || isRecoveryResult || attendeeEmailWarning || attendeeNotCheckedWarning || colleagueSoftBlockHint || hasAttendeeConflicts || usedColleagueOwnerOnly || usedOwnerAttendeeTagged || hasOverOptional || requestedTimeLocal || timezoneHint || preferredSlotStatus || hasAttendeeStatus) {
              const result: Record<string, unknown> = { slots: annotatedSlots };
              // #148 — grounded timezone strings so Sonnet quotes the conversion, never recomputes it.
              Object.assign(result, tzGroundingFields);
              // v4.1.x (M10/M11) — the named time that did NOT make the list, with
              // its real reason. Present only when a preferred_slot was asked for
              // and could not be offered.
              if (preferredSlotStatus) result.preferred_slot_status = preferredSlotStatus;
              if (travelers.length > 0) result.travelers = travelers;
              if (hasDaySummary) result.day_summary = daySummary;
              if (attendeeEmailWarning) Object.assign(result, attendeeEmailWarning);
              if (attendeeNotCheckedWarning) Object.assign(result, attendeeNotCheckedWarning);
              if (colleagueSoftBlockHint) Object.assign(result, colleagueSoftBlockHint);
              if (hasAttendeeConflicts && !usedOwnerAttendeeTagged && !usedColleagueOwnerOnly) {
                // o#213 sibling — same hedge-when-assumed treatment as
                // `_attendee_unverified_note` below: an `off_hours` entry can
                // come from a GUESSED default (#M3, no stored profile) rather
                // than real stored hours, tagged `assumed: true` on the
                // conflict entry in connectors/graph/findAvailableSlots.ts.
                result._attendee_conflicts_note =
                  `You searched with override on, so these include slots where an attendee is busy or outside their working hours — each such slot has \`attendee_conflicts: [{email, reason, assumed?}]\`. Present them, but say plainly who is busy / off-hours on those (e.g. "Tue 10:00 — Anna is busy then"). For an \`off_hours\` entry, when \`assumed\` is missing or false that's real stored working-hours data — say it plainly; when it carries \`assumed: true\` those hours are a GUESSED default (no profile on file for that attendee, never confirmed), so hedge instead (e.g. "Tue 10:00 — probably outside Anna's hours, though I'm not certain of her actual schedule"). Never present a conflicted slot as clean. The owner can still book any of them.`;
              }
              if (usedOwnerAttendeeTagged) {
                const ownerFirst = context.profile.user.name.split(' ')[0];
                if (mustBe) {
                  // #145 (2026-07-21 owner direction) — the requester is an INSISTENT
                  // colleague and every open time has a required attendee busy. This is
                  // the REQUESTER's call, NOT the owner's — Maelle serves the owner, not the
                  // attendee. Name who's busy, and if they still want it, book it directly.
                  // Never escalate to the owner: his own busy/rules never reach this set.
                  result._attendee_busy_colleague_note =
                    `No time here is free for everyone — every slot works for ${ownerFirst}, but a REQUIRED ATTENDEE is busy then (each slot's \`attendee_conflicts: [{email, reason}]\` names who; say ONLY that they're busy — you have no further detail, don't invent one). Tell the requester plainly ("${ownerFirst}'s free at 4pm, but <attendee>'s busy then"). This is THEIR call, not ${ownerFirst}'s — do NOT route it to him and do NOT say there's no time. If they still want it (they've usually synced with the attendee already, or they'll own the clash), BOOK IT directly with create_meeting at that slot — the attendee just gets the invite and can decline.`;
                } else {
                  // Owner-tagged backstop: no slot was clean for everyone, so these are his
                  // genuinely open times with each attendee conflict tagged. Honest framing:
                  // "nothing works for all, here's who can't + widen?".
                  // o#213 sibling — same hedge-when-assumed treatment as
                  // `_attendee_unverified_note` below: an `off_hours` entry can
                  // come from a GUESSED default (#M3, no stored profile) rather
                  // than real stored hours, tagged `assumed: true` on the
                  // conflict entry in connectors/graph/findAvailableSlots.ts.
                  result._no_all_attendee_free_note =
                    `No time in this window is free for EVERYONE, so these are ${ownerFirst}'s genuinely open slots (his working hours, focus time and own calendar all still respected) with each attendee conflict tagged in \`attendee_conflicts: [{email, reason, assumed?}]\`. Present them and say plainly, per slot, who can't make it (e.g. "Tue 16:15 — Maayan's busy then", "Tue 16:30 — both are busy"). For an \`off_hours\` entry, when \`assumed\` is missing or false that's real stored working-hours data — say it plainly; when it carries \`assumed: true\` those hours are a GUESSED default (no profile on file, never confirmed), so hedge instead (e.g. "Tue 16:15 — probably outside Maayan's hours, though I'm not certain of her actual schedule"). #M1 — BUT first read \`day_summary\`: for any day whose \`accepted:0\` with an attendee-busy reason (\`attendee_busy_collision\` / \`outside_attendee_work_hours\`), that attendee is unavailable the ENTIRE day — say "<attendee>'s busy all day <that day>", do NOT cherry-pick these 1-2 surfaced slots as if they were the only conflicts. NEVER present a conflicted slot as clean. ${ownerFirst} can book any of them — it's his call. ALSO offer to look at a different timeframe or widen the window, since nothing here works for all.`;
                }
              }
              if (hasOverOptional) {
                // Bounced 2026-08-06 (bounces:2) — owner's call: don't explain
                // or expand on WHY a slot is less preferred, to either
                // audience — just append the bare label next to it so
                // whoever's reading can pick something else if they'd like.
                // `over_optional`'s subject is internal bookkeeping only
                // (used above to decide which slots get the label); never
                // say the subject or a reason aloud, and never build a
                // homemade explanation from it.
                result._over_optional_note =
                  'Some slots carry `over_optional: "<subject>"` internally — they sit over an OPTIONAL meeting the owner joins only if free (e.g. a daily standup), not a hard commitment, but that subject is never said aloud to anyone. They only appear because clean times were too few. Present them AFTER any clean options, and NEVER as identical to a clean slot: each such slot also carries `less_preferred_label`, a bare marker with no reason or subject in it — quote it VERBATIM in parentheses right next to that slot\'s time ("Wed 16:00 (<less_preferred_label>)"), the same way you quote `presentation_local`; do not reword it, expand it, explain why, or build your own version from `over_optional` instead. It is still fully bookable and needs NO approval — the optional event stays on the calendar (he just skips it); do NOT delete it, do NOT flag a conflict.';
              }
              if (isRecoveryResult) {
                // Flag so Sonnet knows these slots break soft rules — she
                // should narrate the trade-off, not present as clean options.
                //
                // This note used to say the retry "bypassed soft rules (free-time
                // floor / lunch / work-hours)" and to read `day_summary.top_reasons`
                // for "WHICH rule each slot is breaking". Both were wrong, and
                // together they are how a double-booked 15:30 got narrated as
                // "clean for both of you" (2026-07-26 19:17Z): the retry ALSO
                // waived his own hard busy, and day_summary is a per-DAY top-2 from
                // the STRICT pass, which on that search blamed the attendee and
                // said nothing about the offered times. The walker now excludes
                // committed and out-of-hours slots outright and tags each surfaced
                // slot with the rule it actually breaks, so this note can point at
                // a real per-slot fact.
                result._relaxed_recovery = true;
                result._recovery_note =
                  'Strict pass returned 0 in the named window. These slots come from a relaxed retry that bends ONLY the owner\'s soft day-load rules (free-time floor / lunch or another floating block / category limit / booking lead time). They are inside his working hours and NONE of them collides with a meeting he already has — a time he is committed on is never offered here. '
                  + (hasBrokenRuleLabel
                    ? 'Each slot carries `broken_rule_label`: the exact rule it breaks, in his own words. QUOTE that per slot and present the trade-off explicitly ("17:30 works, heads up it dips under your free-time floor — book anyway?"); never present one as clean, and never guess a reason that isn\'t in the label. '
                    : 'Which specific rule each one bends is NOT in this payload, so do not name one — say only that his day is loaded around then and these are the times that could still work. ')
                  + 'A slot may ALSO carry `attendee_conflicts` — say who is busy on top of the rule. He gets the final say.';
              }
              if (usedColleagueOwnerOnly) {
                const ownerFirstUnverified = context.profile.user.name.split(' ')[0];
                // v4.4.7 — the strict pass rejected these slots because SOME
                // attendee's stored/assumed working hours ruled them out, and
                // this recovery re-checks that SAME real data (never nulled now
                // — see recoverAttendeeBlockedSlots above), so a returned slot
                // normally carries `attendee_conflicts: [{email, reason:'off_hours'}]`
                // naming exactly who. That part is no longer a guess.
                // v4.4.8 (bouncer overturn) — the colleague-path annotation at
                // :1506 runs on every search that reaches this branch (it fires
                // whenever !isOwnerInitiatedSearch, which usedColleagueOwnerOnly
                // implies), and ships a REAL per-slot Graph free/busy read for
                // every INTERNAL attendee as `attendee_status`. "No calendar
                // access in this fallback" was false whenever an attendee is
                // internal — the real data sits right next to the note denying
                // it. Only an EXTERNAL attendee (or one whose status came back
                // 'unknown') is genuinely unchecked here (rule 7 — a colleague
                // never gets another attendee's real calendar; the annotation
                // itself skips externals). Also: `usedColleagueOwnerOnly` always
                // implies `hasAttendeeConflicts` — the recovery differs from the
                // strict pass ONLY by tagging off-hours conflicts instead of
                // dropping them, so every slot that newly surfaces here carries
                // at least one — there is no "no conflicts at all" case on this
                // path, so no second wording for it.
                // v4.4.x — the `attendee_status` clause used to ship
                // unconditionally, telling Sonnet to look for a field that
                // isn't there on a search whose slots carry no
                // `attendee_status` at all (all-external attendees). Gated
                // on `hasAttendeeStatus` now, matching the sibling flag
                // above. Kept the concrete per-value mapping rather than
                // pointing at the system prompt's "OWNER FREE, REQUESTER
                // BUSY" paragraph (meetings.ts:1138) — that paragraph covers
                // a different scenario (owner free, REQUESTER busy) and
                // nowhere states what 'busy'/'tentative'/'oof' vs 'free'
                // actually mean; claiming it "already covers" this would
                // strip the only guidance Sonnet has for narrating these
                // values, on the one path (the attendee-conflict fallback)
                // where getting that narration right matters most.
                // o#213 — the "external/unknown attendee can't be checked
                // here" sentence used to live INSIDE the `hasAttendeeStatus`
                // ternary, so it vanished whenever no slot carried a
                // non-empty `attendee_status` (e.g. the colleague-path
                // annotation above threw, or — in the all-external,
                // no-internal-attendee case this closes — attendee_status
                // simply never got attached). The fact it states is true
                // EITHER WAY: an external or still-'unknown' attendee is
                // uncheckable here regardless of whether `attendee_status`
                // shipped at all. Ships unconditionally now; only the
                // INTERNAL 'busy'/'tentative'/'oof'/'free' teaching sentence
                // stays gated on `hasAttendeeStatus`.
                // o#213 — the off-hours sentence also used to assert every
                // `attendee_conflicts[].reason:'off_hours'` as real data
                // unconditionally, but `loadAttendeeAvailabilityForEmails`
                // (utils/attendeeAvailability.ts) can build an entry from a
                // GUESSED default (#M3, no stored profile) tagged
                // `assumed: true` — carried straight onto the conflict entry
                // in connectors/graph/findAvailableSlots.ts. That's the other
                // still-open half of `assumed-attendee-hours-narrated-as-fact`
                // (the day_summary grounding note already hedged; this one
                // didn't). Hedges per-entry now when `assumed` is true.
                result._attendee_unverified_note =
                  `These are ${ownerFirstUnverified}'s OWN open times (his rules stay strict). Some carry \`attendee_conflicts: [{email, reason:'off_hours', assumed?}]\` — when an entry has no \`assumed\` flag (or it's false) that's real stored working-hours data, so say plainly who's outside their hours (e.g. "Tue 10:00 — Elinor's outside her hours then"); when an entry carries \`assumed: true\` those hours are a GUESSED default (no profile on file for that attendee, never confirmed), so hedge instead (e.g. "Tue 10:00 — probably outside Elinor's hours, though I'm not certain of her actual schedule"). Never present a tagged slot as clean for everyone.`
                  + (hasAttendeeStatus
                    ? ` Slots also carry \`attendee_status\` per INTERNAL attendee — a REAL calendar read, not a guess: 'busy' / 'tentative' / 'oof' means they already have something then (e.g. "Lori's busy then"); 'free' means they're clear.`
                    : '')
                  + ` Only an EXTERNAL attendee (or one still 'unknown') can't be checked here — say you could not confirm THAT one yet.`
                  + ` Do NOT demand an attendee's email to proceed. The pick routes to ${ownerFirstUnverified}'s approval as usual.`;
              }
              return result;
            }
            return annotatedSlots;
          } catch (err) {
            if (err instanceof GraphPermissionError) {
              return {
                error: 'calendar_permission_denied',
                message: 'I can read your calendar but I don\'t have permission to check other people\'s availability. ' +
                  `The Azure app needs Calendars.Read application permission granted by a ${context.profile.user.company ?? 'company'} tenant admin. ` +
                  'Tell the user you cannot find a common slot right now due to a permissions issue, ' +
                  'and ask if they know when those people are free so you can proceed.',
              };
            }
            throw err;
          }
        }
}

