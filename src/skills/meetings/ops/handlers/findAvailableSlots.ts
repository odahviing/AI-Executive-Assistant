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

export async function handleFindAvailableSlots(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
        // v1.6.4 — meeting_mode is required from the LLM. Let findAvailableSlots
        // scope the workDays per mode (in_person → office only, else both). Do
        // NOT pre-pass workDays from here — the function's own mode-aware logic
        // decides so in_person is enforced as a hard rule.
        {
          // v3.1.6 (L2) — duration safety default — code backstop for when
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

          // MOVE-PATH AUTO-FILL (owner-path only): when moving_event_ids is set AND
          // the owner is the initiator, auto-read the moving event's roster so a later
          // call that DROPPED an attendee still checks everyone. Owner direction:
          // "find_available_slots should just take the list of people to check" — tool
          // reads them itself; Sonnet doesn't have to remember. Closes the Sales
          // BiWeekly trace where Sonnet dropped Isaac and 17:00 was proposed without
          // him. GUARDED below (#145b): the event roster is folded in ONLY when it
          // shares an attendee with the explicit set (same meeting) or the explicit set
          // is empty; a moving_event_id that points at a DIFFERENT meeting is ignored,
          // never ballooned in. Colleague-path skips this — that flow uses per-attendee
          // annotation (see v2.7.0 colleague-path block below).
          const isOwnerInitiatedSearch =
            context.senderRole === 'owner' || context.isOwnerInGroup === true;
          const movingIdsForAttendees = (isOwnerInitiatedSearch && Array.isArray(args.moving_event_ids))
            ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
            : [];
          if (movingIdsForAttendees.length > 0) {
            try {
              const { resolveMovingEventAttendees } = await import('../../../../utils/movingEventAttendees');
              const fromEvent = await resolveMovingEventAttendees(
                movingIdsForAttendees,
                userEmail,
                timezone,
              );
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

          // v3.1.2 (Ayala-TZ) — auto-add @-mentioned colleagues to attendeeEmails
          // on owner-path turns. When the owner pings Maelle quoting a colleague
          // ("@Maelle @Ayala asking if I'm free at..."), Sonnet often calls
          // find_available_slots WITHOUT including the colleague in
          // attendee_emails — so loadAttendeeAvailabilityForEmails below has
          // nothing to load, work-hours clip never runs, and slots fall in the
          // colleague's middle-of-the-night. Auto-add catches this so the
          // v2.8.3 per_attendee_local enrichment also kicks in, giving Sonnet the
          // dual-TZ rendering she needs.
          //
          // Owner-path only. Detection is structured Slack mention syntax
          // <@Uxxx>, not freeform NL — no scaling concern.
          if (isOwnerInitiatedSearch && context.conversationHistory && context.conversationHistory.length > 0) {
            try {
              const lastUserMsg = [...context.conversationHistory]
                .reverse()
                .find(m => m.role === 'user');
              const mentionRe = /<@(U[A-Z0-9]+)>/g;
              const mentionedIds = new Set<string>();
              if (lastUserMsg) {
                for (const m of lastUserMsg.content.matchAll(mentionRe)) {
                  mentionedIds.add(m[1]);
                }
              }
              if (mentionedIds.size > 0) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getPersonMemory } = require('../../../../db') as typeof import('../../../../db');
                const ownerLower = userEmail.toLowerCase();
                const ownerSlackId = context.profile.user.slack_user_id;
                const existingLower = new Set(attendeeEmails.map(e => e.toLowerCase()));
                const added: string[] = [];
                for (const id of mentionedIds) {
                  if (id === ownerSlackId) continue;  // skip @Maelle/@Owner-self mentions
                  const person = getPersonMemory(id);
                  const email = person?.email;
                  if (!email || email.toLowerCase() === ownerLower) continue;
                  if (existingLower.has(email.toLowerCase())) continue;
                  attendeeEmails.push(email);
                  existingLower.add(email.toLowerCase());
                  added.push(email);
                }
                if (added.length > 0) {
                  logger.info('find_available_slots — auto-added @-mentioned colleagues to attendees', {
                    threadTs: context.threadTs,
                    added,
                  });
                }
              }
            } catch (err) {
              logger.warn('find_available_slots — @-mention auto-add threw, proceeding without', {
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
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { getPersonMemory } = require('../../../../db') as typeof import('../../../../db');
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
            || (args.relaxed === true && isOwnerInitiatedSearch);

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
            : loadAttendeeAvailabilityForEmails(attendeeEmails, userEmail);

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
              logger.info('find_available_slots — attendee hours override applied', {
                email: entry.email, hoursStart: entry.hoursStart, hoursEnd: entry.hoursEnd, tz: entry.timezone,
              });
            }
          }

          // #77 — owner-initiated path with attendees: auto-pass
          // attendeeBusyEmails so Graph free/busy filters the candidate pool,
          // not just work-hour clipping. Prior fixes (v2.2.3 #43, v2.3.6 #71)
          // wired the work-hours half. The colleague-initiated path (coord state
          // machine) deliberately does NOT auto-pass — coord uses
          // annotateSlotsWithAttendeeStatus to TAG slots with status, showing
          // all options per owner's rule.
          const attendeeBusyEmails = (isOwnerInitiatedSearch && !ignoreAttendeeBusy && attendeeEmails.length > 0)
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
            }>;
            unresolvedAttendees?: string[];
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
            const candidates = args.candidate_slots as Array<{ start: string; end?: string }>;
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
                let endIso = c.end
                  ? (searchWindowTz ? reinterpretClockInZone(c.end, searchWindowTz, timezone) : c.end)
                  : undefined;
                if (!endIso) {
                  const s = DateTime.fromISO(startConv, { zone: timezone });
                  endIso = s.isValid ? (s.plus({ minutes: durationMin }).toISO() ?? startConv) : startConv;
                }
                return { start: startConv, end: endIso as string };
              });

            // Same rule-label mapping as Guard B uses; kept in sync (extract
            // to a shared helper next time we touch this file).
            const labelFor = (reason: string | undefined): string => humanizeViolationLabel(reason, ownerFirst);

            // #148 — the zone the candidate times were STATED in (searchWindowTz), or an
            // explicit present_in_timezone, used to echo each result back in that zone.
            const groundTz = searchWindowTz || (typeof args.present_in_timezone === 'string' ? args.present_in_timezone.trim() : '');
            const results = await Promise.all(normalized.map(async (cand) => {
              const diag: {
                rejectedCounts?: Record<string, number>;
              } = {};
              try {
                const slots = await findAvailableSlots({
                  userEmail,
                  timezone,
                  durationMinutes: durationMin,
                  attendeeBusyEmails,
                  attendeeAvailability,
                  searchFrom: cand.start,
                  searchTo: cand.end,
                  meetingMode: mode as import('../../../../connectors/graph/calendar').MeetingMode,
                  travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
                  profile: context.profile,
                  category: args.category as string | undefined,
                  relaxed: args.relaxed === true && context.senderRole === 'owner',
                  excludeEventIds: Array.isArray(args.moving_event_ids)
                    ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
                    : undefined,
                  autoExpand: false,
                  minBufferHours: (context.senderRole === 'owner' || context.isOwnerInGroup === true)
                    ? 1
                    : (context.profile.meetings.min_slot_buffer_hours ?? 4),
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
                return {
                  start: cand.start,
                  end: cand.end,
                  available: matches,
                  ...(presentLocal ? { presentation_local: presentLocal } : {}),
                  ...(brokenRule ? { broken_rule: brokenRule, broken_rule_label: labelFor(brokenRule) } : {}),
                };
              } catch (err) {
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

            return {
              mode: 'candidate_validation',
              duration_minutes: durationMin,
              candidates_checked: normalized.length,
              results,
              ...(groundTz ? { _requested_time_local: `Each result carries presentation_local — the slot in ${groundTz}, the zone the times were given in. Quote that alongside the owner-local time ("08:00 ET = 15:00 his time"); NEVER recompute the cross-timezone conversion yourself.` } : {}),
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
              minBufferHours: (context.senderRole === 'owner' || context.isOwnerInGroup === true)
                ? 1
                : (context.profile.meetings.min_slot_buffer_hours ?? 4),
              profile: context.profile,
              // v2.3.2 (2A) — relaxed mode opt-in (owner-only). Bypasses
              // focus / lunch / work-hours; keeps the 5-min between-meeting buffer.
              relaxed: args.relaxed === true && context.senderRole === 'owner',
              // v2.4.1 — when validating/discovering a MOVE, the meeting(s)
              // being moved are subtracted from busy AND forbidden as
              // candidates. See findAvailableSlots.excludeEventIds for the full
              // semantics.
              excludeEventIds: Array.isArray(args.moving_event_ids)
                ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
                : undefined,
              // v2.6 — category scheduling rules. When set, slot loop filters
              // out slots that would violate the category's day_type / per_day /
              // per_week limits.
              category: args.category as string | undefined,
              diagnosticsOut,
            });
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
              relaxed: args.relaxed === true && context.senderRole === 'owner',
              slotCount: rawSlots.length,
              firstSlots: rawSlots.slice(0, 5).map(s => ({ start: s.start, end: s.end })),
              daySummary: diagnosticsOut.daySummary?.map(d => ({
                date: d.date, accepted: d.accepted, top_reasons: d.top_reasons,
              })),
            });

            // v3.3.7 (#124h) — internal attendee addresses Graph could NOT
            // resolve. A nonexistent mailbox returns NO busy data → reads as
            // fully free → slots get offered without that person's calendar ever
            // being checked. External addresses are skipped: Graph never has
            // their data, and first-time externals are normal. did_you_mean
            // comes from people_memory by the address's first name token.
            const ownerDomainLower = userEmail.includes('@') ? userEmail.split('@')[1].toLowerCase() : '';
            const unresolvedInternal = (diagnosticsOut.unresolvedAttendees ?? [])
              .filter(e => ownerDomainLower && e.endsWith('@' + ownerDomainLower));
            let attendeeEmailWarning: Record<string, unknown> | undefined;
            if (unresolvedInternal.length > 0) {
              const entries = enrichUnresolvedInternal(unresolvedInternal, ownerDomainLower);
              attendeeEmailWarning = {
                unresolved_attendee_emails: entries,
                _attendee_email_warning: 'These attendee addresses do NOT exist in the company directory — their availability was NOT checked (a nonexistent mailbox reads as fully free). The address is most likely a wrong guess. Re-call find_available_slots with the corrected address (see did_you_mean) or resolve the person via find_slack_user first. Do NOT present any slot as working for that person until the address resolves.',
              };
              logger.warn('find_available_slots — unresolved internal attendee email(s)', {
                unresolvedInternal,
                entries,
              });
            }

            // v3.3.7 (#125a) — colleague-path soft-block narration hint. When
            // the strict pass rejected slots on the owner's SOFT, owner-
            // relaxable protections (free-time floor / 5-min buffer / floating
            // block), the colleague must hear "his day is too loaded around
            // then" (true, mechanism-free) — and an insisted-on time goes to
            // the owner as an approval, never a flat refusal. Hard busy stays
            // "he's booked".
            const SOFT_REJECT_PREFIXES = ['focus_time', 'owner_buffer_collision', 'floating_block_no_room', 'within_lead_time'];
            const softRejectLabels = Object.keys(diagnosticsOut.rejectedCounts ?? {})
              .filter(l => SOFT_REJECT_PREFIXES.some(p => l.startsWith(p)));
            const colleagueSoftBlockHint = (!isOwnerInitiatedSearch && softRejectLabels.length > 0)
              ? {
                  _colleague_soft_block_hint: `Some times in this window were excluded by ${context.profile.user.name.split(' ')[0]}'s day-load protections — NOT by real meetings. To the colleague, phrase those as "his day is pretty loaded around then" (never reveal the mechanism, never enumerate his calendar). If the requester INSISTS on one of those specific times, do NOT flatly refuse and do NOT book it: raise it via create_approval(kind=policy_exception) with the requested slot so he decides.`,
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
            const isAlreadyRelaxed = args.relaxed === true && context.senderRole === 'owner';
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
            //   'colleague_owner_only' — owner-only (attendees drop to a high-
            //       level caveat; a colleague never sees calendar detail, rule 7).
            //       If the owner is himself busy, owner-only also returns 0 →
            //       honest "he's booked then."
            const recoverAttendeeBlockedSlots = (audience: 'owner_tagged' | 'colleague_owner_only') => {
              const ownerAudience = audience === 'owner_tagged';
              return findAvailableSlots({
                userEmail,
                timezone,
                durationMinutes: args.duration_minutes as number,
                attendeeBusyEmails: ownerAudience ? attendeeEmails : undefined,
                attendeeAvailability: ownerAudience ? attendeeAvailability : undefined,
                tagAttendeeConflicts: ownerAudience,   // owner: keep his day strict, TAG attendee busy (never drop)
                searchFrom: effectiveSearchFrom,
                searchTo: effectiveSearchTo,
                preferMorning: args.prefer_morning as boolean | undefined,
                meetingMode: mode as import('../../../../connectors/graph/calendar').MeetingMode,
                travelBufferMinutes: args.travel_buffer_minutes as number | undefined,
                autoExpand: !userNamedNarrowWindow,
                minBufferHours: ownerAudience ? 1 : (context.profile.meetings.min_slot_buffer_hours ?? 4),
                profile: context.profile,
                relaxed: false,
                excludeEventIds: Array.isArray(args.moving_event_ids)
                  ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
                  : undefined,
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
              if (attendeeEmailWarning || colleagueSoftBlockHint) {
                return {
                  slots: rawSlots,
                  ...(diagnosticsOut.daySummary && diagnosticsOut.daySummary.length > 0
                    ? { day_summary: diagnosticsOut.daySummary } : {}),
                  ...(attendeeEmailWarning ?? {}),
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
            // lunch / work-hours. Only relax when he has no open slot at all.
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
                  minBufferHours: (context.senderRole === 'owner' || context.isOwnerInGroup === true || mustBe)
                    ? 1   // #128 — must-be: the owner overrides his own colleague booking lead-time for an urgent ask
                    : (context.profile.meetings.min_slot_buffer_hours ?? 4),
                  profile: context.profile,
                  relaxed: true,  // bypass focus/lunch/work-hours; attendee busy still enforced
                  excludeEventIds: Array.isArray(args.moving_event_ids)
                    ? (args.moving_event_ids as string[]).filter(id => typeof id === 'string' && id.length > 0)
                    : undefined,
                  category: args.category as string | undefined,
                  autoExpand: false,  // recovery stays inside the user's window
                });
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
              // v3.1.7 — clip the AUTO-recovery to the owner's working DAY. The
              // recovery relaxes IN-DAY soft blocks (focus / lunch / category) so
              // it can surface "13:00 breaks your lunch — book anyway?" — but it
              // must NEVER offer a slot outside his working hours (pre-start /
              // post-end). Relaxing a soft block ≠ extending his day.
              // (When the OWNER explicitly names an off-hours time, that call
              // passes relaxed=true directly and never enters this
              // auto-recovery branch.)
              if (relaxedRecoverySlots.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const wh = require('../../../../utils/workHours') as typeof import('../../../../utils/workHours');
                const durMin = args.duration_minutes as number;
                relaxedRecoverySlots = relaxedRecoverySlots.filter(s => {
                  const sd = DateTime.fromISO(s.start, { zone: timezone });
                  if (!sd.isValid) return true;
                  // v3.7.x (#143) — clip to the date's EFFECTIVE work-hour
                  // windows so an override (custom hours / day off) governs the
                  // recovery, not raw weekday yaml.
                  const windows = wh.getEffectiveWorkDay(sd.toFormat('yyyy-MM-dd'), context.profile).windows;
                  if (windows.length === 0) return false; // day off → never offer
                  const startMin = sd.hour * 60 + sd.minute;
                  return wh.isSlotInWorkHours(windows, startMin, startMin + durMin);
                });
                logger.info('find_available_slots — recovery clipped to work-day', {
                  kept: relaxedRecoverySlots.length,
                });
              }
              if (relaxedRecoverySlots.length === 0) {
                // Recovery also empty — return original empty result with day_summary.
                if ((strictDaySummary && strictDaySummary.length > 0) || attendeeEmailWarning || colleagueSoftBlockHint) {
                  return {
                    slots: [],
                    ...(strictDaySummary && strictDaySummary.length > 0 ? { day_summary: strictDaySummary } : {}),
                    ...(attendeeEmailWarning ?? {}),
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
                const pickedMustBe = new Set(pickSpreadMustBe(relaxedRecoverySlots, timezone, 5, undefined, args.duration_minutes as number | undefined));
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
            //   3) colleague owner-only — his open times, attendees uncheckable.
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
            const chosenStarts = new Set(pickSpreadSlots(pickPool, timezone, 5, anchorDay, args.duration_minutes as number | undefined));

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
                logger.info('find_available_slots — preferred_slot not in candidate set (rule violation or outside window)', {
                  preferredSlot,
                });
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
            const presentTz = typeof args.present_in_timezone === 'string'
              ? args.present_in_timezone.trim()
              : '';
            if (presentTz) {
              // v3.4.2 (A2) — shared renderer, same string create/move echo back.
              annotatedSlots = annotatedSlots.map((s: any) => {
                const display = renderClockInZone(s.start, timezone, presentTz);
                return display ? { ...s, presentation_local: display } : s;
              });
            }
            // v3.3.8 — remember what's being OFFERED in this conversation so a
            // later pick ("Tuesday 20:30") binds to the offered instant instead
            // of re-deriving the date. The orchestrator injects these on
            // subsequent turns. Colleague-path only — the owner-path has its own
            // correction loop.
            if (!isOwnerInitiatedSearch && annotatedSlots.length > 0 && context.channelId) {
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
            if (travelers.length > 0 || hasDaySummary || isRecoveryResult || attendeeEmailWarning || colleagueSoftBlockHint || hasAttendeeConflicts || usedColleagueOwnerOnly || usedOwnerAttendeeTagged || hasOverOptional || requestedTimeLocal || timezoneHint) {
              const result: Record<string, unknown> = { slots: annotatedSlots };
              // #148 — grounded timezone strings so Sonnet quotes the conversion, never recomputes it.
              Object.assign(result, tzGroundingFields);
              if (travelers.length > 0) result.travelers = travelers;
              if (hasDaySummary) result.day_summary = daySummary;
              if (attendeeEmailWarning) Object.assign(result, attendeeEmailWarning);
              if (colleagueSoftBlockHint) Object.assign(result, colleagueSoftBlockHint);
              if (hasAttendeeConflicts && !usedOwnerAttendeeTagged) {
                result._attendee_conflicts_note =
                  'You searched with override on, so these include slots where an attendee is busy or outside their working hours — each such slot has `attendee_conflicts: [{email, reason}]`. Present them, but say plainly who is busy / off-hours on those (e.g. "Tue 10:00 — Anna is busy then"). Never present a conflicted slot as clean. The owner can still book any of them.';
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
                  result._no_all_attendee_free_note =
                    `No time in this window is free for EVERYONE, so these are ${ownerFirst}'s genuinely open slots (his working hours, focus time and own calendar all still respected) with each attendee conflict tagged in \`attendee_conflicts: [{email, reason}]\`. Present them and say plainly, per slot, who can't make it (e.g. "Tue 16:15 — Maayan's busy then", "Tue 16:30 — both are busy"). NEVER present a conflicted slot as clean. ${ownerFirst} can book any of them — it's his call. ALSO offer to look at a different timeframe or widen the window, since nothing here works for all.`;
                }
              }
              if (hasOverOptional) {
                result._over_optional_note =
                  'Some slots carry `over_optional: "<subject>"` — they sit over an OPTIONAL meeting the owner joins only if free (e.g. a daily standup), not a hard commitment. They only appear because clean times were too few. Present them AFTER any clean options and say the trade-off plainly ("Wed 16:00 — over your optional <subject>, which you\'d drop"). Booking one is fine and needs NO approval — the optional event stays on the calendar (he just skips it); do NOT delete it, do NOT flag a conflict.';
              }
              if (isRecoveryResult) {
                // Flag so Sonnet knows these slots break soft rules — she
                // should narrate the trade-off, not present as clean options.
                result._relaxed_recovery = true;
                result._recovery_note =
                  'Strict pass returned 0 in the named window. These slots come from a relaxed retry that bypassed soft rules (free-time floor / lunch / work-hours). Read day_summary.top_reasons to see WHICH rule each slot is breaking, and present with that trade-off explicitly ("X fits but dips under the free-time floor — book anyway?"). Owner gets the final say.';
              }
              if (usedColleagueOwnerOnly) {
                result._attendee_unverified_note =
                  `No slot worked once the OTHER attendee(s)' availability was applied, so these are ${context.profile.user.name.split(' ')[0]}'s OWN open times instead — attendee free/busy is a helper, never a blocker. Offer these as options; do NOT demand an attendee's email to proceed (an external attendee can't be checked at all). Say plainly you could not confirm the other side(s) yet ("here are his open times — I'll confirm the other side once you pick"). Do NOT claim the other attendee is free. The pick routes to ${context.profile.user.name.split(' ')[0]}'s approval as usual.`;
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

