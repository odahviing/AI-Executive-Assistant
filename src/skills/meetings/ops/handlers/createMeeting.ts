/**
 * createMeeting — extracted VERBATIM (v3.7.x, pass B) from the 'create_meeting' case body of
 * SchedulingSkill.executeToolCall in ../../ops.ts. No logic changes: the case
 * body is byte-for-byte identical; only relative import/require paths were
 * deepened by two levels for the ops/handlers/ location, and the free
 * variables (context, userEmail, timezone) are threaded via OpCtx.
 */
import logger from '../../../../utils/logger';
import { DateTime } from 'luxon';
import type { SkillContext } from '../../../types';

import { formatIsoTime, computeVacatedSlot, buildOutOfHoursBusy, openQuestionsField, alternativesNote, recordProposedAlternatives } from '../../ops/helpers';
import { humanizeViolationLabel } from '../../ops/violationLabels';
import { processCalendarEvents, analyzeCalendar, enrichUnresolvedInternal } from '../../ops/analysis';
import {
  getOwnerEventsForDecision,
  getEventEndInstant,
  findDuplicateEvent,
  findReschedulableSibling,
  type CalendarEvent,
  getFreeBusyForDecision,
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
import { closeMeetingArtifacts } from '../../../../utils/closeMeetingArtifacts';
import { reinterpretClockInZone, renderClockInZone } from '../../../../utils/timezoneConvert';
import { resolveStatedInstant, renderWeDualClock } from '../../../../utils/weTimeResolver';
import { checkIntendedWeekday } from '../../../../utils/weekdayGuard';
import { displaySubject, subjectViewerFor, viewerEmailFor } from '../../../../utils/displaySubject';
import { createApprovalRequest } from '../../../../tasks/skill';
import { logActivity } from '../../../../core/requests/logActivity';
import type { OpCtx } from './context';

export async function handleCreateMeeting(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
  // v4.4.9 (#154) — resolved once per call, mirroring subjectViewerFor(context)
  // below: the attendee-aware half of the subject mask, for every occupancy
  // scan / conflict message this handler produces on the colleague path.
  // gh#154-W5/gh#154-R4 (2026-08-06) — the room-tightening (a room can never be more
  // permissive than a 1:1 DM) lives inside viewerEmailFor now, keyed on
  // surface==='room'; call it directly. The old `?? null` coercion here also
  // caught the EMAIL leg's `undefined`, masking every forwarded subject
  // instead of only private ones — owner ruled email out of scope for this
  // build; see viewerEmailFor's doc comment in utils/displaySubject.ts.
  const viewerEmail = viewerEmailFor(context);
        // v3.5.x — anchor-to-event-end ("a 2h block after my flight"). When the
        // model passes start_at_event_end_id + duration_minutes and no explicit
        // start, resolve start = that event's END instant (read once, tz-correct)
        // and end = start + duration. Deterministic: no model clock-arithmetic,
        // and no "what time does your flight land?" for an event already on the
        // calendar. Done HERE, at the top, so the whole pipeline — travel context,
        // planMeeting, rules, confirm — sees the real start.
        //
        // Owner ruling (2026-08-04, verbatim): "you have to start meeting at
        // 00:15:30:45 its from day one" — no exception for an anchored "right
        // after X" booking. The anchor event's own end is very often 5 min
        // short of the quarter (the 10/25/40/55 duration presets are built that
        // way ON PURPOSE, to leave a trailing buffer) — anchoring literally onto
        // that end (13:10) both breaks the quarter-hour rule AND defeats the
        // buffer the anchor event's own duration was chosen to leave. Snap the
        // anchor's end forward (never backward — never earlier than the anchor
        // event's real end, which would silently overlap it) to the next
        // :00/:15/:30/:45 tick, then compute end = snapped-start + duration.
        {
          const anchorId = typeof args.start_at_event_end_id === 'string' ? args.start_at_event_end_id.trim() : '';
          if (anchorId && !args.start) {
            const dur = typeof args.duration_minutes === 'number' ? args.duration_minutes : 0;
            if (dur <= 0) {
              return {
                success: false,
                error: 'anchor_needs_duration',
                message: 'To place a block at the end of an event, pass duration_minutes (the block length in minutes) alongside start_at_event_end_id.',
              };
            }
            const anchor = await getEventEndInstant(userEmail, anchorId, timezone);
            if (!anchor) {
              return {
                success: false,
                error: 'anchor_event_not_found',
                message: `I couldn't load the event to anchor this block to (id ${anchorId}). Re-fetch it from the calendar and pass its current id, or give me an explicit start time.`,
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { alignUpQuarter } = require('../../../../utils/floatingBlocks') as typeof import('../../../../utils/floatingBlocks');
            const snappedStartMs = alignUpQuarter(anchor.end.toMillis(), timezone);
            const snappedStart = DateTime.fromMillis(snappedStartMs, { zone: timezone });
            args.start = snappedStart.toISO();
            args.end = snappedStart.plus({ minutes: dur }).toISO();
            args.start_is_explicit = true;  // already grid-aligned above — skip the later off-grid-only snap
            delete args.start_timezone;   // start/end are now owner-tz instants — skip the reinterpret
            logger.info('create_meeting — anchored to event end, snapped forward to quarter grid', {
              anchorId, anchorSubject: anchor.subject, anchorEnd: anchor.end.toISO(), start: args.start, end: args.end, durationMinutes: dur,
            });
          }
        }
        // v3.5.x (WE time spine) — ONE place resolves "what instant does the
        // owner's stated time mean" (resolveStatedInstant), fed the SINGLE travel
        // detection. A clock that already carries an offset (a search slot, or one
        // already zone-converted) is a fixed instant, left as-is; a BARE clock is
        // read in the zone he NAMED (`stated_zone`: home/local, or an explicit
        // IANA via start_timezone) or — if he named none — where he physically is
        // on a trip day, never the server zone. This replaces the old split (a
        // separate explicit-start_timezone block + a bare-trip guess) that let
        // "6:30 IL time" fall through as bare and become Boston (the 2026-06-29
        // cascade). tripDisplay (the trip TZ/location) is kept ONLY for the dual-
        // clock display + the location-not-stamped rule; the lodging is never a venue.
        let tripDisplay: { tz: string; location: string } | null = null;
        if (typeof args.start === 'string') {
          try {
            const { getTravelContextForInstant } = await import('../../../../utils/workingElsewhere');
            const travel = getTravelContextForInstant(args.start, context.profile);
            if (travel.isAway) tripDisplay = { tz: travel.effectiveTz, location: travel.location };
            const statedZone = (typeof args.stated_zone === 'string' && args.stated_zone.trim())
              ? args.stated_zone.trim()
              : (typeof args.start_timezone === 'string' && args.start_timezone.trim() ? args.start_timezone.trim() : undefined);
            const resolved = resolveStatedInstant({
              startIso: args.start,
              endIso: typeof args.end === 'string' ? args.end : undefined,
              statedZone, travel, homeTz: timezone,
            });
            if (resolved.reinterpreted) {
              logger.info('create_meeting — stated time resolved to canonical instant', {
                statedZone: statedZone ?? '(none)', sourceZone: resolved.sourceZone,
                startWas: args.start, startNow: resolved.startIso, isAway: travel.isAway,
              });
            }
            args.start = resolved.startIso;
            if (resolved.endIso) args.end = resolved.endIso;
          } catch (err) {
            logger.warn('create_meeting — WE time resolve threw, using time as-is', { err: String(err).slice(0, 160) });
          }
        }
        // v3.0.7 — runtime array guard. The `as Array<...>` cast is a pure-TS
        // assertion with no runtime check. When Sonnet passes `attendees` as a non-array
        // shape (single object, keyed object, null, omitted — all observed),
        // the downstream `attendees.filter(...)` crashes with a TypeError that
        // the registry wraps as an opaque FAILED, and Sonnet retries with the
        // same broken shape. Refuse early with a shape-explicit error message
        // Sonnet can react to instead.
        const rawAttendees = args.attendees;
        if (!Array.isArray(rawAttendees)) {
          logger.warn('create_meeting — args.attendees not an array, refusing', {
            actualType: rawAttendees === null ? 'null' : typeof rawAttendees,
            sample: typeof rawAttendees === 'object' && rawAttendees !== null
              ? JSON.stringify(rawAttendees).slice(0, 200)
              : String(rawAttendees).slice(0, 100),
            subject: args.subject,
            requester: context.userId,
          });
          return {
            success: false,
            error: 'invalid_attendees',
            message: `attendees must be an array of {name, email} objects. Got ${rawAttendees === null ? 'null' : typeof rawAttendees}. Retry with attendees=[{name, email}, ...] — even for a single attendee, wrap in an array.`,
          };
        }
        const attendees = rawAttendees as Array<{ name?: string; email?: string; slack_id?: string }>;
        // v3.6.4 — recover resolved internal attendees into the booking. The
        // orchestrator already resolved this turn's named participants
        // (context.resolvedMeetingAttendees — a known internal colleague's email
        // is in hand, owner + requester excluded upstream). Union any Sonnet left
        // out of args.attendees so the invite includes them DETERMINISTICALLY and
        // never depends on her re-supplying — or asking a colleague for — an email
        // we already resolved (the "what's Simon's email?" bug). `attendees`
        // aliases args.attendees, so the push is what the normalizer reads. Dedupe
        // by email; per-turn set, so nothing stale from earlier in the thread.
        if (Array.isArray(context.resolvedMeetingAttendees) && context.resolvedMeetingAttendees.length > 0) {
          const present = new Set(attendees.map(a => (a.email ?? '').toLowerCase().trim()).filter(Boolean));
          const added: string[] = [];
          for (const email of context.resolvedMeetingAttendees) {
            const lower = (email ?? '').toLowerCase().trim();
            if (!lower.includes('@') || present.has(lower)) continue;
            attendees.push({ email });
            present.add(lower);
            added.push(email);
          }
          if (added.length > 0) {
            logger.info('create_meeting — recovered resolved internal attendees into booking', {
              added, subject: args.subject, senderRole: context.senderRole,
            });
          }
        }
        // v4.3.x (gh#165-a / relay-invite gap) — ONE requester-identity
        // resolution, read by the DROP branch immediately below
        // (requester_is_attending:false: relayer/organizer, not an
        // attendee) and by the ADD (default: requester attends), which now
        // sits AFTER the colleague-path sensitivity gate a few lines down
        // (2026-08-01 overturn — see the ADD's own comment for why). Both
        // read off the SAME requesterId/requesterEmail resolved here, on
        // every path — owner included. An owner-approval REPLAY
        // (deferredActionReplay.ts) re-invokes this handler with
        // senderRole:'owner' and context.userId === the OWNER, so the
        // colleague-path fallback (context.userId) can't name the original
        // requester on replay — only a `requester_slack_id` stamped into
        // args at the ORIGINAL call survives into the replay (every
        // `_deferred_action_hint: { args: {...args} }` below snapshots
        // whatever args holds at that moment). Resolve + stamp HERE, before
        // any of those snapshots, so the add, the scrub, and the replay all
        // read the same requester.
        //
        // `isGenuineColleague` excludes the MPIM-clamped owner (senderRole
        // reads 'colleague' but context.userId IS the owner's own slack id).
        // ONE definition, read at both use sites in this handler — here, and
        // by the shadow-DM gate further down (that site used to independently
        // re-type the same test; collapsed to this one variable 2026-08-01).
        // Open Improvement #154 proposes replacing this clamp with a single
        // `ownerClampSurface` fact; when it lands, updating THIS one
        // definition covers both the invite roster and the shadow-DM, so
        // they can no longer disagree about who "the colleague" is.
        const ownerSlackId = context.profile.user.slack_user_id;
        const isGenuineColleague = context.senderRole === 'colleague' && context.userId !== ownerSlackId;
        let requesterId: string | undefined = (typeof args.requester_slack_id === 'string' && args.requester_slack_id.trim())
          ? args.requester_slack_id.trim()
          : (isGenuineColleague ? context.userId : undefined);
        if (requesterId === ownerSlackId) requesterId = undefined;  // the owner himself is never "the requester"
        if (requesterId && (typeof args.requester_slack_id !== 'string' || !args.requester_slack_id.trim())) {
          args.requester_slack_id = requesterId;
        }
        let requesterEmail: string | undefined;      // lowercased — comparisons only
        let requesterEmailRaw: string | undefined;   // original case — used when adding to attendees
        let requesterName: string | undefined;
        if (requesterId) {
          try {
            const mem = getPersonMemory(requesterId);
            requesterEmailRaw = mem?.email;
            requesterEmail = requesterEmailRaw?.toLowerCase();
            requesterName = mem?.name;
          } catch (err) {
            logger.warn('create_meeting — requester person-memory lookup threw, continuing', { err: String(err).slice(0, 160) });
          }
        }
        if (args.requester_is_attending === false) {
          // Bug 4 (2026-06-29) — a colleague who only RELAYED a meeting between OTHERS
          // ("tell Idan I want to meet Tal") is the REQUESTER, not an attendee, but the
          // model had added her to attendees → she was invited AND the booking was logged
          // against her ("What we've discussed"). Scrub them from the attendees array IN
          // PLACE — `attendees` aliases args.attendees, so the one splice covers the
          // normalizer→planMeeting→Graph event AND recordBooking (which reads this same
          // array).
          if (requesterId) {
            const before = attendees.length;
            for (let i = attendees.length - 1; i >= 0; i--) {
              const a = attendees[i];
              const byId = !!a.slack_id && a.slack_id === requesterId;
              const byEmail = !!requesterEmail && (a.email ?? '').toLowerCase() === requesterEmail;
              if (byId || byEmail) attendees.splice(i, 1);
            }
            if (attendees.length < before) {
              logger.info('create_meeting — requester not attending; scrubbed from attendees (relayer/organizer)', {
                requesterId, dropped: before - attendees.length, remaining: attendees.length,
              });
            }
          }
        }
        // (gh#165-a ADD — requester_is_attending unset/true — moved below the
        // colleague-path sensitivity gate; see there for why.)
        const assistantEmail = context.profile.assistant.email;
        const ownerEmail = context.profile.user.email;

        // v3.x — grid-align an off-grid start (e.g. 14:40 from a raw calendar
        // gap) to the :00/:15/:30/:45 grid the rest of the system assumes,
        // UNLESS the owner named the exact time (start_is_explicit). The slot
        // finder already returns aligned slots, so this is a no-op for
        // tool-sourced times; it only catches off-grid times Sonnet proposes
        // from raw calendar data. Replaces the SLOT START TIMES prompt rule
        // (alignNearestQuarter was previously wired only to floating blocks).
        {
          const startStr = args.start, endStr = args.end;
          if (!args.start_is_explicit && typeof startStr === 'string' && typeof endStr === 'string') {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { alignNearestQuarter } = require('../../../../utils/floatingBlocks') as typeof import('../../../../utils/floatingBlocks');
            const tz = context.profile.user.timezone;
            const sDt = DateTime.fromISO(startStr, { zone: tz });
            if (sDt.isValid) {
              const alignedMs = alignNearestQuarter(sDt.toMillis(), tz);
              if (alignedMs !== sDt.toMillis()) {
                const delta = alignedMs - sDt.toMillis();
                const eDt = DateTime.fromISO(endStr, { zone: tz });
                args.start = DateTime.fromMillis(alignedMs, { zone: tz }).toISO() ?? startStr;
                if (eDt.isValid) args.end = DateTime.fromMillis(eDt.toMillis() + delta, { zone: tz }).toISO() ?? endStr;
                logger.info('create_meeting — snapped off-grid start to quarter grid', {
                  from: sDt.toISO(), to: args.start, subject: args.subject,
                });
              }
            }
          }
        }

        // v2.9.0 — BookingRequest normalization. Single validated pre-data shape
        // that planMeeting consumes. The normalizer is idempotent: it reads from args
        // and produces a strict BookingRequest with owner-in-participants
        // invariant + snapped duration + gated sensitivity + gated relaxed +
        // minimal context (threadTs / isMpim / isOwnerInGroup).
        const { normalizeBookingRequest, resolveDuration, gateSensitivity } = await import('../../bookingRequest');
        const { planInputFromBookingRequest } = await import('../../planMeeting');

        // v2.8.6 (102a) / o#187 — sensitivity gate on colleague-path, handler-
        // side (raw args.attendees, before normalization). Shared with
        // normalizeBookingRequest's identical gate below (bookingRequest.ts,
        // gateSensitivity) — one function now, see its doc comment. This call
        // still runs first and deletes `args.sensitivity` when unauthorized,
        // so the later call inside normalizeBookingRequest is a no-op here.
        const gatedSensitivity = await gateSensitivity(args, context, attendees);
        if (gatedSensitivity === undefined && args.sensitivity !== undefined) {
          delete args.sensitivity;
        }

        // gh#165-a — DEFAULT case (requester_is_attending unset/true): the tool
        // description promises the requester is "one of the meeting attendees" by
        // default, but nothing enforced it — Sonnet sometimes omits her own email from
        // `attendees`, and the invite never reaches the person who asked for the
        // meeting. Add her deterministically. INVITE LIST ONLY: this only pushes into
        // `attendees` (the Graph invite roster).
        //
        // 2026-08-01 overturn — moved BELOW the sensitivity gate above (the same
        // `gateSensitivity` reached again, as a no-op, later via
        // normalizeBookingRequest below): this used to sit right after the
        // requester-identity resolution, i.e. ABOVE both gates, so "is the colleague's
        // email in attendees" always read true on this default path — a deterministic
        // privacy control was reduced to a no-op for every ordinary colleague booking.
        // Nothing between the old position and here reads `attendees` except that
        // gate, and every `{ ...args }` deferred-action snapshot is further down
        // still, so moving this add changes nothing else about what gets booked or
        // replayed.
        //
        // NOT advisory-only: planMeeting's internal-attendee freebusy check
        // (planMeeting.ts ~666-757) also sees the requester once she's added here, and
        // on a fresh owner-initiated book (not a move, not already relaxed) a
        // genuinely busy requester now trips the same one-time "book anyway, or pick a
        // different time?" confirm any other attendee would. Kept deliberately: once
        // she's a real attendee, checking her calendar the same way as everyone
        // else's is the consistent answer — carving her out would need a new
        // exclusion this gate doesn't otherwise have, for no reason a colleague's own
        // busy slot doesn't already have.
        if (args.requester_is_attending !== false && requesterId && requesterEmailRaw) {
          const already = attendees.some(a => {
            const byId = !!a.slack_id && a.slack_id === requesterId;
            const byEmail = (a.email ?? '').toLowerCase() === requesterEmail;
            return byId || byEmail;
          });
          if (!already) {
            attendees.push({ name: requesterName, email: requesterEmailRaw, slack_id: requesterId });
            logger.info('create_meeting — added requester to attendees (default: attending)', {
              requesterId, requesterEmail, senderRole: context.senderRole,
            });
          }
        }

        // v3.5.x — duration decision via the ONE shared resolver (resolveDuration
        // in bookingRequest), the same call buildSlot makes — so the gate and the
        // normalize step can't drift (the old code carried two copies of the snap +
        // owner carve-out; the mirror is gone). Owner-path honors an explicitly
        // stated length in ONE step (#127) — no "book the full 2h or 55?" on a
        // duration the owner named (the "After flight" 2h-block ask). A colleague
        // proposing an off-preset long duration still gets the verify question; a
        // ≤5-min mismatch ("1 hour"→55) snaps silently for everyone.
        const startIsoIn = args.start as string | undefined;
        const endIsoIn   = args.end   as string | undefined;
        if (typeof startIsoIn === 'string' && typeof endIsoIn === 'string') {
          const dur = resolveDuration(startIsoIn, endIsoIn, context.profile, context.senderRole === 'owner');
          if (dur?.needsConfirm) {
            return {
              warning: `You asked for a ${dur.requestedMin}-minute meeting, which is longer than the usual lengths (${context.profile.meetings.allowed_durations.join(', ')} min). Ask briefly: "That's ${dur.requestedMin} min — book the full length, or shorten to ${dur.snappedMin}?" If they want the full ${dur.requestedMin} min, retry create_meeting with relaxed=true; if ${dur.snappedMin} is fine, retry with duration_minutes=${dur.snappedMin}.`,
              needs_confirmation: true,
            };
          }
          if (dur && dur.endIso !== endIsoIn) {
            logger.info('create_meeting — snapped duration to allowed_durations', {
              requested: dur.requestedMin, snappedTo: dur.durationMin,
              start: startIsoIn, endWas: endIsoIn, endNow: dur.endIso,
            });
            args.end = dur.endIso;
          }
        }

        // Coord email auto-fill on create_meeting. Sonnet sometimes drops
        // the email field even though we have it in people_memory (it was
        // populated by an earlier find_slack_user upsert in the same flow).
        // Primary lookup: by slack_id; fallback: by fuzzy name. Only fills
        // missing entries; pre-existing emails pass through untouched. If
        // still missing after lookup, downstream Guard A returns error:
        // 'attendee_missing_email' so Sonnet asks instead of papering over.
        try {
          const { getPersonMemory, searchPeopleMemory } = await import('../../../../db');
          for (const a of attendees) {
            if (a.email && typeof a.email === 'string' && a.email.includes('@')) continue;
            if (a.slack_id) {
              const mem = getPersonMemory(a.slack_id);
              if (mem?.email) { a.email = mem.email; continue; }
            }
            if (a.name) {
              const matches = searchPeopleMemory(a.name);
              const hit = matches.find(m => m.email && m.email.includes('@'));
              if (hit) { a.email = hit.email; continue; }
            }
          }
        } catch (err) {
          logger.warn('create_meeting email auto-fill threw — proceeding with raw attendees', {
            err: String(err).slice(0, 200),
          });
        }

        // v3.7.2 (#137b) — email is required to SEND an invite, on EVERY path.
        // This was colleague-path-only (old Guard A), so the owner-approved
        // deferred replay — which runs as senderRole:'owner'
        // (deferredActionReplay.ts) — booked "Meeting with Keren (Attorney)" with
        // no email for Keren → a broken invite Outlook can't deliver (2026-07-14).
        // Giving dates/times needs no email; SENDING the invite can never happen
        // without one, for anyone, regardless of who triggered the booking. Runs
        // after the auto-fill above, so only a genuinely unresolvable attendee is
        // refused (a named internal was already filled from the directory).
        {
          const missingEmail = attendees.filter(a => !(a.email ?? '').trim());
          if (missingEmail.length > 0) {
            const ownerFirst = context.profile.user.name.split(' ')[0];
            logger.info('create_meeting refused — attendee(s) missing email', {
              senderRole: context.senderRole,
              missing: missingEmail.map(a => a.name),
            });
            return {
              success: false,
              error: 'attendee_missing_email',
              message: `I don't have an email for ${missingEmail.map(a => a.name).join(', ')}, so I can't send the calendar invite. Get it (find_slack_user for an internal teammate, or ask ${ownerFirst}/the requester for an external), then re-call — I won't book a meeting no one can be invited to.`,
            };
          }
        }

        // v2.3.2 — colleague-path booking gate. When a colleague has confirmed
        // slot + duration + subject in this DM (1:1 or fast-path multi-internal
        // flow), Maelle calls create_meeting directly instead of falling back to
        // "you send the invite" or kicking off a redundant coordinate_meeting.
        // Same trust pattern as the v2.2.1 move_meeting gate: rule-compliance is the gate.
        // Guards (in code, not prompt):
        //   - 1:1 case: just the requesting colleague — always allowed
        //   - multi-internal: every additional attendee must have an internal
        //     email (same domain as owner). Externals require coord (we can't
        //     check their free/busy or trust they'll see the invite as fast
        //     as we'd like).
        //   - new slot must pass the owner's scheduling rules via
        //     findAvailableSlots narrow-window check
        //   - on success, auto shadow-DM the owner + post-booking heads-up
        //     DMs to non-self internal attendees ("Oran asked, I checked
        //     your calendar, booked Tue 14:00")
        //
        // o#223 — gated on AUTHORITY, not senderRole (same fix as
        // move_meeting's o#221/o#223 gate, moveMeeting.ts). senderRole reads
        // 'colleague' both for a genuine colleague AND for the AUTHENTICATED
        // owner clamped into a room, so this whole ad hoc "can this asker
        // book on their own" gate (Guards A/B below) used to intercept the
        // owner's own room-clamped create_meeting too — returning its own
        // narrow not_rule_compliant refusal (a note asking Sonnet to call
        // create_approval) before planMeeting, and the ownerRoomBend-aware
        // escalate_approval path built specifically for this case
        // (planMeeting.ts's PlanMeetingInput.ownerRoomBend / the alternatives
        // skip / the escalate_approval return), ever ran — making that route
        // unreachable dead code. Only a genuine colleague needs Guards A/B;
        // the owner keeps his authority on every surface (M10) and falls
        // through to the ONE rule check (planMeeting/checkSlot, M2) below.
        if (context.authority !== 'owner') {
          // v2.6 Bug 4 — early idempotency probe BEFORE Guards A and B. When a
          // colleague's continuing chat causes Sonnet to re-attempt create_meeting after the
          // first attempt already succeeded, Guard B's rule-compliance check can
          // throw (Graph free/busy errors, transient API failures) and
          // defensively escalate to create_approval(kind=policy_exception) — a
          // stale approval that lands in the owner's DM and re-surfaces in every
          // brief until manually rejected.
          //
          // So: probe Graph for an existing meeting at this same subject+start
          // (±2-min tolerance) BEFORE Guards A/B fire. If found → return success
          // with idempotent=true. The downstream late-idempotency check stays as
          // defense-in-depth. Subject+start match is the same heuristic the late
          // check uses; attendee-list matching is a future tightening (the rare
          // collision is the owner manually booking an unrelated event with the
          // same subject; trade-off favors avoiding stale approvals).
          try {
            const duplicate = await findDuplicateEvent(userEmail, args.subject as string, args.start as string, timezone);
            if (duplicate) {
              const ownerFirst = context.profile.user.name.split(' ')[0];
              const requestedSubject = (args.subject as string).trim();
              logger.info('create_meeting colleague-path idempotent short-circuit (early) — already booked', {
                subject: requestedSubject, existingEventId: duplicate.id, requester: context.userId,
              });
              return {
                success: true,
                meetingId: duplicate.id,
                idempotent: true,
                action_summary: `'${requestedSubject}' is already on ${ownerFirst}'s calendar for ${formatIsoTime(args.start as string)}. Already booked, no action needed.`,
                _note: 'A meeting with this exact subject and start was already booked earlier in this thread. Do NOT call create_meeting again. Do NOT escalate to create_approval. Tell the colleague briefly that it is booked and move on.',
              };
            }
          } catch (probeErr) {
            logger.warn('create_meeting colleague-path early idempotency probe failed — proceeding with guards', {
              err: String(probeErr).slice(0, 200),
            });
          }

          // v2.6.5 — recurring-category check. When the meeting falls under an
          // is_recurring category (Weekly, Cadence — set in profile.categories
          // yaml), look for an existing occurrence with the same internal
          // attendees in the SAME WEEK before creating a new event. Closes the
          // duplicate-booking pattern: colleague says "reinstate the BiWeekly"
          // → Maelle creates a new event on Wed while the original-day
          // occurrence (post-revert Sun) still sits on the calendar.
          //
          // The check is owner-curated (yaml flag) — code stays generic over
          // category names. Match heuristic: at least one shared internal
          // attendee + same week + not the same start (the early idempotency
          // probe above catches subject+start collisions). When a match
          // exists, refuse with existing_event_id pointing Sonnet to
          // move_meeting on the existing event instead of stacking a duplicate.
          try {
            const { getProfileCategoryByName } = await import('../../../../utils/categoryRules');
            const catName = typeof args.category === 'string' ? args.category : null;
            const cat = getProfileCategoryByName(context.profile, catName);
            if (cat?.is_recurring) {
              const startDt = DateTime.fromISO(args.start as string, { zone: timezone });
              if (startDt.isValid) {
                const weekStart = startDt.startOf('week').toFormat('yyyy-MM-dd');
                const weekEnd = startDt.endOf('week').toFormat('yyyy-MM-dd');
                const requestedStartMs = startDt.toMillis();
                const ownerEmailLower = ownerEmail.toLowerCase();
                const requestedAttendees = new Set(
                  attendees
                    .map(a => (a.email ?? '').toLowerCase())
                    .filter(e => e && e !== ownerEmailLower),
                );
                if (requestedAttendees.size > 0) {
                  // v4.2.2 — a DECISION read (ReadFreshness): its answer is
                  // "refuse this booking" or "create it", so it must not come from
                  // the cross-turn warm copy. Cached, it could miss an occurrence
                  // added in the last few minutes and wave the duplicate through —
                  // the exact booking this guard exists to stop. A
                  // CalendarOfflineError lands in the catch below (this guard is a
                  // heuristic, never the gate) and Guard B's own read refuses the
                  // booking a few lines down, so nothing books blind.
                  const weekEvents = await getOwnerEventsForDecision(userEmail, weekStart, weekEnd, timezone);
                  const match = weekEvents.find(ev => {
                    if (ev.isCancelled) return false;
                    // Skip the exact same start — covered by the early idempotency probe above.
                    const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
                    if (Math.abs(evStart.toMillis() - requestedStartMs) <= 2 * 60 * 1000) return false;
                    const evAttendees = (ev.attendees ?? [])
                      .map(a => (a.emailAddress?.address ?? '').toLowerCase())
                      .filter(e => e && e !== ownerEmailLower);
                    return evAttendees.some(e => requestedAttendees.has(e));
                  });
                  if (match) {
                    const ownerFirst = context.profile.user.name.split(' ')[0];
                    const matchStart = DateTime.fromISO(match.start.dateTime, {
                      zone: match.start.timeZone ?? 'utc',
                    }).setZone(timezone).toFormat("EEEE d MMM 'at' HH:mm");
                    // #175 (M12) — this whole branch is colleague-path only (the
                    // `context.senderRole === 'colleague'` gate a few lines up), so
                    // subjectViewerFor(context) is always 'other' here. match.subject
                    // is the RAW Graph subject; an interview or sensitive 1:1 must not
                    // leak into a colleague-facing refusal message. Mask it with the
                    // same displaySubject helper Guard B already uses below (v4.3.4) —
                    // one masking path, not a second one invented for this branch.
                    const maskedSubject = displaySubject(match, context.profile, subjectViewerFor(context), viewerEmail);
                    logger.info('create_meeting colleague-path refused — existing recurring occurrence in same week', {
                      requester: context.userId,
                      category: cat.name,
                      existing_event_id: match.id,
                      existing_subject: maskedSubject,
                    });
                    return {
                      success: false,
                      error: 'recurring_match_exists',
                      existing_event_id: match.id,
                      existing_subject: maskedSubject,
                      existing_start: match.start.dateTime,
                      message: `An existing ${cat.name} occurrence with the same attendee is already on ${ownerFirst}'s calendar this week ("${maskedSubject}" on ${matchStart}). Don't create a duplicate — call move_meeting on the existing event (id: ${match.id}) to shift it to the requested time instead, or confirm with the colleague before doing anything else.`,
                    };
                  }
                }
              }
            }
          } catch (recurErr) {
            logger.warn('create_meeting colleague-path recurring check threw — proceeding', {
              err: String(recurErr).slice(0, 200),
            });
          }

          // (Email-required guard hoisted to run on EVERY path — see #137b above,
          // right after the attendee email auto-fill. Was colleague-only here.)

          // Guard B — slot rule-compliance via findAvailableSlots narrow window.
          //
          // Guard B no longer has an owner-in-MPIM escape. The v2.8.6 block
          // that used to sit here pre-stamped `args.relaxed = true` whenever the
          // literal string "sender: <owner name>" plus a time plus an
          // English/Hebrew proposal cue appeared in the recent history, and then
          // skipped Guard B entirely on the strength of it. Two failures in one:
          // it authorized on a claim carried inside a message rather than on the
          // authenticated sender, and the group-DM clamp meant the resulting
          // booking ran as a COLLEAGUE with eight rules waived and no heads-up
          // possible (planMeeting's one-step notice is owner-initiator only).
          // Owner 2026-07-26: "if i want to do something wrong in group chat,
          // raise for approval or at least tell me" — so a group DM now takes the
          // normal colleague route (alternatives, then policy_exception into his
          // own DM), which is also what the MPIM clamp already decided.
          try {
            const startDt = DateTime.fromISO(args.start as string, { zone: timezone });
            const endDt = DateTime.fromISO(args.end as string, { zone: timezone });
            if (startDt.isValid && endDt.isValid) {
              const durationMin = Math.max(5, Math.round((endDt.toMillis() - startDt.toMillis()) / 60_000));
              const { findAvailableSlots } = await import('../../../../connectors/graph/calendar');
              const startMs = startDt.toMillis();
              // v2.6.1 — pass the EXACT requested window — do NOT widen.
              // findAvailableSlots strides 15-min from searchFrom, so widening
              // by ±60s lands the cursor at start-1min and the requested slot is
              // never tested (a 10:30 request on an office day with hours_start:
              // '10:30' then gets rejected as outside_owner_work_hours because
              // the cursor is at 10:29). The widening defends against nothing
              // concrete — work-hours / busy / focus checks read integer-minute
              // fields, so sub-second drift doesn't matter.
              const fromIso = startDt.toUTC().toISO();
              const toIso = endDt.toUTC().toISO();
              let validSlots: Array<{ start: string }> = [];
              // v2.6.1 — collect rejection diagnostics from findAvailableSlots
              // by reference so we can name THIS slot's broken rule in the
              // refusal returned to Sonnet (instead of forcing her to guess,
              // which leads to "rule-non-compliant" + fabricated reasons).
              const diagnostics: {
                rejectedCounts?: Record<string, number>;
                rejectedExamples?: Record<string, string[]>;
                // #165b — the real event behind an owner_busy_collision, read
                // straight off checkSlot's own occupancy scan (see below).
                // gh#165-d — carries the structural all-day facts too, so the
                // refusal below can tell "the whole day is gone" from "this
                // hour clashes" without re-deriving it.
                conflictingEvent?: { id: string; subject: string; allDayOutOfOffice?: true; isAllDay?: true };
              } = {};
              if (fromIso && toIso) {
                const runSlotCheck = () => findAvailableSlots({
                  userEmail,
                  timezone,
                  durationMinutes: durationMin,
                  searchFrom: fromIso,
                  searchTo: toIso,
                  profile: context.profile,
                  // v2.6 — pass category so colleague-path rule-check also
                  // enforces day_type / per_day / per_week limits. When a
                  // colleague tries to book a slot that would push the
                  // owner over a category limit, the slot is filtered out
                  // here; outer matches() returns false; Sonnet escalates
                  // to create_approval with the rule name (RULE-NAMING).
                  category: args.category as string | undefined,
                  // #165b — matches the masking `subjectViewerFor` already
                  // applied to the conflicting-event subject below; without it
                  // checkSlot's own occupancy scan falls back to its own
                  // 'other' default, which happens to agree here but should
                  // not depend on happening to agree.
                  viewer: subjectViewerFor(context),
                  viewerEmail,
                  diagnosticsOut: diagnostics,
                  // v3.0.6 — single-slot yes/no validation. The window is
                  // exactly [start, end], so findAvailableSlots returns ≤1 slot →
                  // <3 → auto-expand would re-query the calendar 2-3 more times at
                  // widening ranges on every colleague booking, and the expanded
                  // slots are discarded anyway (matches checks ±60s of the
                  // requested start). Disable it.
                  autoExpand: false,
                });
                // v3.7.x (#137) — a transient Graph free/busy fault (e.g.
                // ErrorInvalidMergedFreeBusyInterval) must NOT masquerade as a
                // rule violation. A single blip on this verification fetch was
                // escalating a rule-COMPLIANT colleague slot to a
                // policy_exception approval, which then mis-bound and booked
                // without real owner approval (#137/#138). Retry once; only a
                // REPEATED failure falls through to the outer catch (a genuine
                // "couldn't verify" → honest escalation).
                try {
                  validSlots = await runSlotCheck();
                } catch (firstErr) {
                  // The owner-event read owns its OWN retry now
                  // (getOwnerEventsForDecision), so a CalendarOfflineError has
                  // already been retried at the source and re-running the whole
                  // check would only spend a second round-trip to reach the same
                  // verdict. This retry stays exactly what it was built for: the
                  // #137 free/busy fault class, which has no retry of its own.
                  if (firstErr instanceof CalendarOfflineError) throw firstErr;
                  logger.warn('create_meeting colleague-path rule check threw — retrying once before escalating', {
                    err: String(firstErr).slice(0, 200),
                  });
                  delete diagnostics.rejectedCounts;
                  delete diagnostics.rejectedExamples;
                  delete diagnostics.conflictingEvent;
                  validSlots = await runSlotCheck();
                }
              }
              const matches = validSlots.some(s => Math.abs(DateTime.fromISO(s.start).toMillis() - startMs) <= 60_000);
              if (!matches) {
                const ownerFirst = context.profile.user.name.split(' ')[0];
                // v2.6.1 — derive a one-phrase human label for the rule that
                // rejected this slot. Sonnet pastes this verbatim into
                // create_approval(kind=policy_exception).ask_text so the owner
                // sees "in your lunch window" / "outside your work hours" / etc.
                // instead of "rule-non-compliant" or a fabricated reason.
                // broken_rule_label === 'unknown' means the diagnostics didn't
                // fire (rare — defensive); Sonnet says so honestly rather than
                // guessing. v2.7.1 — no owner_buffer_collision label: connected
                // back-to-backs are fine by design (the buffer is baked into
                // standard durations).
                const labelFor = (reason: string | undefined): string => humanizeViolationLabel(reason, ownerFirst);
                const counts = diagnostics.rejectedCounts ?? {};
                const fired = Object.keys(counts);
                // Pick the first reason that fired. Narrow window means
                // typically only one rule rejects (one slot tested). When
                // multiple appear (rare: e.g. both work-hours AND category),
                // pick whichever shows up first — caller gets a real fact
                // either way.
                const brokenRule = fired[0];

                // v4.3.x (#165b) — name the ACTUAL conflicting event when the
                // rejection is a real calendar clash (not a work-hours/lunch/
                // category rule). Without this, a colleague follow-up that means
                // "add me to the meeting you just booked" ("include me as well,
                // no need for a new invite") but re-enters create_meeting under a
                // fresh subject collides with that very meeting and gets the same
                // generic "conflicts with another meeting — call create_approval"
                // as any unrelated conflict — producing a second, confusing
                // policy_exception for a meeting that's already booked.
                //
                // Read the event straight off `diagnostics.conflictingEvent` —
                // the SAME occupancy scan (checkSlot's overCommitment, via
                // occupancyRoleOf) that decided `owner_busy_collision` in the
                // first place, already fetched by the runSlotCheck() call above.
                // The earlier version re-queried the calendar with a SEPARATE,
                // weaker predicate (findDuplicateEvent(subject=null): "any event
                // whose START sits within 2 minutes of the requested start") —
                // which, when a real blocker overlapped from an EARLIER start
                // while an occupancyRoleOf-ignored event (a free/floating lunch
                // or focus block) happened to START exactly at the requested
                // time, named the harmless block instead of the actual
                // conflict and steered add_attendees at the wrong event. Reusing
                // checkSlot's own finding removes the second predicate entirely —
                // one occupancy scan, one answer (M2) — and costs no extra Graph
                // call. Subject is already privacy-masked (M12) by the `viewer`
                // passed into runSlotCheck above.
                const conflictingEvent = brokenRule === 'owner_busy_collision'
                  ? diagnostics.conflictingEvent
                  : undefined;
                // gh#165-d — the collision occupies the OWNER'S WHOLE DAY (a
                // vacation / offsite / day-long hold), not one hour. "Add
                // attendees to THAT meeting" is nonsense for a day-long block —
                // suppress the steer and say the true fact instead. Keyed on the
                // broad `isAllDay` (any all-day commitment), not the narrower
                // `allDayOutOfOffice` — the WORDING below still only claims
                // "out of office" when that's confirmed (M11: a held all-day
                // block that isn't actually OOF is not "he's away").
                const isAllDayCollision = conflictingEvent?.isAllDay === true;
                const brokenRuleLabel = (brokenRule === 'owner_busy_collision' && conflictingEvent?.allDayOutOfOffice)
                  ? humanizeViolationLabel('owner_out_of_office', ownerFirst)
                  // No quotes here (unlike the other labels' plain phrasing) — the
                  // message below already names the specific subject in its own
                  // quotes, and nesting quotes-in-quotes when this string is
                  // re-quoted verbatim into ask_text reads as a paste error.
                  : (brokenRule === 'owner_busy_collision' && isAllDayCollision && conflictingEvent)
                    ? `blocked all day by another commitment on ${ownerFirst}'s calendar`
                    : labelFor(brokenRule);

                logger.info('create_meeting colleague-path refused — slot breaks owner rules', {
                  start: args.start, end: args.end, requester: context.userId,
                  broken_rule: brokenRule ?? 'unknown',
                  broken_rule_label: brokenRuleLabel,
                  ...(conflictingEvent ? { conflicting_event_id: conflictingEvent.id, all_day: isAllDayCollision } : {}),
                });
                return {
                  success: false,
                  error: 'not_rule_compliant',
                  broken_rule: brokenRule ?? 'unknown',
                  broken_rule_label: brokenRuleLabel,
                  // The add-attendees steer only makes sense for a real, timed
                  // meeting — an all-day collision omits existing_event_id so
                  // nothing invites "add someone to" a day-long block.
                  ...(conflictingEvent && !isAllDayCollision ? { existing_event_id: conflictingEvent.id, existing_subject: conflictingEvent.subject } : {}),
                  message: brokenRuleLabel === 'unknown'
                    ? `That time doesn't pass ${ownerFirst}'s scheduling rules and I can't tell exactly which one flagged it. Call create_approval(kind=policy_exception) — describe the slot honestly and let him decide.`
                    : conflictingEvent && isAllDayCollision
                      ? `${ownerFirst}'s whole day is already taken by "${conflictingEvent.subject}"${conflictingEvent.allDayOutOfOffice ? ' — he is out of office' : ''}. I can't book on top of an all-day commitment, and there's no meeting there to add anyone to. Call create_approval(kind=policy_exception) if this genuinely needs to happen anyway, and pass "${brokenRuleLabel}" in ask_text.`
                      : conflictingEvent
                        ? `That time conflicts with "${conflictingEvent.subject}" (id: ${conflictingEvent.id}) already on ${ownerFirst}'s calendar. If the goal is to add someone to THAT meeting rather than book a new one, call update_meeting(meeting_id: ${conflictingEvent.id}, add_attendees: [...]) instead — do NOT create a duplicate for that. Only call create_approval(kind=policy_exception) if a genuinely separate meeting is meant to override it.`
                        : `That time is ${brokenRuleLabel} for ${ownerFirst}. I can't book it on my own — call create_approval(kind=policy_exception) and pass the same phrase ("${brokenRuleLabel}") in ask_text so he knows what he's overriding.`,
                  // v2.8.6 (103E wiring) — stamp the deferred_action_hint so the
                  // orchestrator can auto-attach it to the follow-up
                  // create_approval. Without it, owner-approve would resolve the
                  // request with no replay — booking never fires, requester gets
                  // an empty promise. This reuses the same
                  // `payload.deferred_action` machinery the planMeeting-path
                  // refusals use.
                  _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
                };
              }
            }
          } catch (err) {
            // "I couldn't verify, ask him to decide" is the right answer to
            // a rule check that FAILED; it is the wrong answer to a calendar we
            // cannot read at all. Escalating here would put an approval in front
            // of the owner for a booking nobody can validate either — and he'd be
            // approving blind too. Let it through to the offline refusal.
            if (err instanceof CalendarOfflineError) throw err;
            logger.warn('create_meeting colleague-path rule check threw — escalating to approval', {
              err: String(err).slice(0, 200),
            });
            const ownerFirst = context.profile.user.name.split(' ')[0];
            return {
              success: false,
              error: 'rule_check_failed',
              message: `I couldn't verify whether that slot fits ${ownerFirst}'s rules right now. Raise create_approval(kind=policy_exception) so he can decide.`,
              // v3.7.x (#137a) — carry the full args (incl. any invite `body` the
              // requester supplied) into the follow-up approval, so an owner-approve
              // replays create_meeting WITH the body instead of shipping an empty
              // invite. Matches the not_rule_compliant path above; only reached now
              // if BOTH free/busy attempts throw (rare, after the #137 root fix).
              _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
            };
          }
        }

        // v2.2.5 (C) — must_be_after_event_id ordering guard. When the LLM
        // booking is part of an ordered series, refuse if the proposed start
        // is BEFORE the predecessor's end. Lets owner book M2 with a
        // must_be_after pointer to M1 and trust the order; the tool catches
        // accidental order breaks deterministically.
        const mustBeAfterId = args.must_be_after_event_id as string | undefined;
        if (mustBeAfterId) {
          try {
            const requestedStart = DateTime.fromISO(args.start as string, { zone: timezone });
            // Shared by-id lookup (same helper the start_at_event_end_id anchor uses).
            const predecessor = await getEventEndInstant(userEmail, mustBeAfterId, timezone);
            if (predecessor) {
              if (requestedStart.toMillis() < predecessor.end.toMillis()) {
                // o#178 (M12) — this refusal is reachable on a colleague-readable
                // path (the requester need not be the owner), so the predecessor's
                // RAW subject must not leak if it's marked private. Same masking
                // helper Guard B already uses (:431) — one path, not a second.
                const predecessorSubject = displaySubject(predecessor, context.profile, subjectViewerFor(context), viewerEmail);
                logger.info('create_meeting refused — must_be_after_event_id ordering violated', {
                  predecessorId: mustBeAfterId,
                  predecessorEnd: predecessor.end.toISO(),
                  requestedStart: requestedStart.toISO(),
                });
                return {
                  success: false,
                  error: 'order_violation',
                  message: `That start time (${requestedStart.toFormat("EEE d MMM 'at' HH:mm")}) is BEFORE the predecessor meeting "${predecessorSubject}" ends (${predecessor.end.toFormat("EEE d MMM 'at' HH:mm")}). The series must stay in order. Pick a slot after that.`,
                };
              }
            } else {
              logger.warn('create_meeting — must_be_after_event_id not found; proceeding without order check', {
                eventId: mustBeAfterId,
              });
            }
          } catch (err) {
            logger.warn('create_meeting — predecessor lookup threw, skipping order check', {
              err: String(err).slice(0, 200),
            });
          }
        }

        // Remove the owner if Claude accidentally added them (owner is organizer)
        // Also strip the assistant if Claude added her despite instructions — she has calendar access
        // Case-insensitive compare — ownerEmail/assistantEmail aren't case-normalized
        // (no lowercase transform in CompanyEmailSchema) and an attendee's raw .email
        // (Graph or hand-typed) can arrive in a different case. A raw compare here let
        // a differently-cased owner/assistant address silently stay a booked attendee.
        const filteredAttendees = attendees.filter(a => {
          const email = (a.email ?? '').toLowerCase();
          return email !== ownerEmail.toLowerCase() && (!assistantEmail || email !== assistantEmail.toLowerCase());
        });
        attendees.length = 0;
        filteredAttendees.forEach(a => attendees.push(a));

        // If meeting room requested, add room email (configured per tenant in meetings.room_email)
        const roomEmail = context.profile.meetings.room_email;
        // Case-insensitive — same raw-case gap as the filter above: roomEmail isn't
        // case-normalized and an attendee's raw .email can differ in case, so a raw
        // compare would miss an already-present room mailbox and add a case-variant duplicate.
        if (args.add_room_email && roomEmail && !attendees.find(a => (a.email ?? '').toLowerCase() === roomEmail.toLowerCase())) {
          attendees.push({ name: 'Meeting Room', email: roomEmail });
        }

        // Typo'd internal attendee guard. A nonexistent @company mailbox
        // returns no busy data → reads as fully free → the meeting books with a
        // phantom attendee who never gets the invite. Probe internal attendees'
        // free/busy and refuse (with a did_you_mean) on any the directory can't
        // resolve, so Sonnet corrects the address instead of booking a ghost.
        // (External addresses skipped — Graph never has their data; the room
        // mailbox is excluded. Per-turn memoized, so planMeeting's pre-book check
        // shares this same getSchedule POST rather than firing a second one.)
        try {
          const ownerDomainLower = userEmail.includes('@') ? userEmail.split('@')[1].toLowerCase() : '';
          const roomLower = (roomEmail ?? '').toLowerCase();
          const internalAttendeeEmails = attendees
            .map(a => (a.email ?? '').toLowerCase())
            .filter(e => e && ownerDomainLower && e.endsWith('@' + ownerDomainLower) && e !== roomLower);
          if (internalAttendeeEmails.length > 0) {
            const fbDiag: { unresolved?: string[] } = {};
            await getFreeBusyForDecision(userEmail, internalAttendeeEmails, args.start as string, args.end as string, timezone, fbDiag);
            const unresolvedInternal = (fbDiag.unresolved ?? []).filter(e => e.endsWith('@' + ownerDomainLower));
            if (unresolvedInternal.length > 0) {
              const entries = enrichUnresolvedInternal(unresolvedInternal, ownerDomainLower);
              logger.warn('create_meeting — unresolved internal attendee email(s), refusing to book a phantom', { entries });
              return {
                success: false,
                error: 'unresolved_attendee',
                unresolved_attendee_emails: entries,
                message: 'One or more attendee addresses don\'t exist in the company directory — booking would invite someone who never gets it (a nonexistent mailbox reads as fully free). Most likely a wrong address: use did_you_mean if shown, or find the person via find_slack_user, then re-book with the corrected address. Do NOT say it\'s booked until the address resolves.',
              };
            }
          }
        } catch (err) {
          logger.warn('create_meeting — unresolved-attendee pre-check threw, proceeding', { err: String(err).slice(0, 200) });
        }

        // #135b — weekday/date sanity. If a weekday was named and the model
        // resolved `start` to a date whose weekday contradicts it (the wrong-day class —
        // "Thursday" written as a Friday), refuse with the corrected same-week
        // date so the model re-issues in the same turn, instead of booking the
        // wrong day. Number-vs-number, language-agnostic. Shared with move_meeting.
        {
          const wk = checkIntendedWeekday(args.start as string | undefined, args.intended_weekday as number | undefined, timezone);
          if (!wk.ok) {
            const namedName = DateTime.fromISO(wk.correctedStartIso, { zone: timezone }).toFormat('EEEE');
            const resolvedName = DateTime.fromISO(args.start as string, { zone: timezone }).toFormat('EEEE');
            const correctedDate = DateTime.fromISO(wk.correctedStartIso, { zone: timezone }).toFormat('yyyy-MM-dd');
            logger.warn('create_meeting — weekday/date mismatch, refusing wrong-day write', {
              namedWeekday: wk.namedWeekday, resolved: wk.resolvedDate, corrected: wk.correctedStartIso,
            });
            return {
              success: false,
              error: 'weekday_date_mismatch',
              corrected_start: wk.correctedStartIso,
              message: `The start resolves to ${wk.resolvedDate} (a ${resolvedName}), but this time was described as a ${namedName}. The ${namedName} of that week is ${correctedDate}. Re-issue create_meeting with start=${wk.correctedStartIso} (same time, corrected day). If a DIFFERENT week was actually meant, resolve the right ${namedName} from the date list in the prompt and retry — never book the mismatched day.`,
            };
          }
        }

        // Cross-turn idempotency — date-verifier / claim-checker retries can
        // re-run the orchestrator on a new turn; Graph is the source of truth.
        // (A day-off slot is no longer gated here: checkSlot rule 1 catches it
        // inside planMeeting — owner books one-step with a heads-up, colleague
        // escalates — so the old override_work_day re-ask is gone.)
        try {
          const duplicate = await findDuplicateEvent(userEmail, args.subject as string, args.start as string, timezone);
          if (duplicate) {
            const requestedSubject = (args.subject as string).trim();
            logger.warn('create_meeting idempotent short-circuit — same subject+start already on calendar', {
              subject: requestedSubject,
              start: args.start,
              existingEventId: duplicate.id,
            });
            return {
              success: true,
              meetingId: duplicate.id,
              idempotent: true,
              action_summary: `'${requestedSubject}' is already on the calendar for ${renderWeDualClock(args.start as string, { isAway: !!tripDisplay, effectiveTz: tripDisplay?.tz ?? timezone, location: tripDisplay?.location ?? '' }, timezone, { endIso: args.end as string })}. Did not create a duplicate.`,
              _note: 'A meeting with this exact subject and start time was already on the calendar. Returning the existing event id instead of creating a duplicate. Do NOT call create_meeting again for this slot.',
            };
          }
        } catch (err) {
          logger.warn('create_meeting idempotency pre-check failed — proceeding with create', { err: String(err) });
        }

        // v2.7.0 — single pipeline through planMeeting: category detection,
        // location resolution, and rule application as ONE coherent decision.
        // Output drives the rest of the booking.
        const { planMeeting } = await import('../../planMeeting');
        // v2.9.0 — build the normalized BookingRequest and feed it through
        // planInputFromBookingRequest. Args are passed AS-IS to the normalizer —
        // the in-handler prep above already applied (duration snap, sensitivity
        // gate, email auto-fill); the normalizer reads those mutated values and
        // produces the canonical shape. See bookingRequest.ts for the invariants
        // the normalizer enforces.
        // Requester add/drop now resolved once, up front (see the
        // gh#165-a / relay-invite-gap block above `assistantEmail`) — both
        // branches read the SAME `requesterId`, stamped into
        // args.requester_slack_id before any early-return can snapshot it
        // for a later approval replay.
        // Create-vs-move slop guard (2026-07-05 Simon double-book). On an explicit
        // "move X to <day>" the model sometimes calls create_meeting (it needs no
        // event id) → a duplicate beside the still-live original. Before booking,
        // look for an existing same-subject + shared-attendee event ELSEWHERE in
        // the planning window (findReschedulableSibling — time-independent, no NL
        // match). If found, SURFACE-AND-ASK (never a hard block): redirect to
        // move_meeting on the existing id so history/duration/attendees are kept;
        // a genuine second meeting with the same person still books on force_new
        // (the false-fire escape that kept the older description-only fix soft).
        if (args.force_new !== true && typeof args.start === 'string' && typeof args.subject === 'string') {
          try {
            const attendeeEmails = attendees
              .map(a => (typeof a.email === 'string' ? a.email : ''))
              .filter(e => e.length > 0);
            const sibling = await findReschedulableSibling({
              userEmail, ownerEmail, subject: args.subject, attendeeEmails,
              startIso: args.start, timezone,
            });
            if (sibling) {
              const whenStr = DateTime.fromISO(sibling.start.dateTime, { zone: sibling.start.timeZone ?? timezone })
                .setZone(timezone).toFormat('EEE d MMM HH:mm');
              // This check runs on BOTH paths (unlike the colleague-gated block
              // above), so a colleague-facing refusal must mask a private sibling
              // exactly like every other subject this file hands back (M12) — same
              // helper as :546, viewer resolved the same way.
              const maskedSiblingSubject = displaySubject(sibling, context.profile, subjectViewerFor(context), viewerEmail);
              logger.info('create_meeting — reschedulable sibling found; surfacing move-instead-of-create', {
                existingEventId: sibling.id, existingWhen: whenStr, subject: args.subject,
              });
              return {
                success: false,
                error: 'possible_reschedule',
                existing_meeting_id: sibling.id,
                existing_subject: maskedSiblingSubject,
                existing_when: whenStr,
                message: `There's already "${maskedSiblingSubject}" on ${whenStr} with the same person. If you're MOVING it, call move_meeting on meeting_id ${sibling.id} (keeps its attendees, duration, and history) — do NOT create a second one. Only if you truly want a SEPARATE additional meeting, retry create_meeting with force_new=true.`,
              };
            }
          } catch (err) {
            logger.warn('create_meeting — reschedulable-sibling check threw, proceeding with create', { err: String(err).slice(0, 160) });
          }
        }
        const bookingRequest = await normalizeBookingRequest('create_meeting', args, context);
        const plan = await planMeeting(planInputFromBookingRequest(bookingRequest, context.profile));
        logger.info('create_meeting — planMeeting verdict', {
          action: plan.action, start: args.start, subject: args.subject,
          reasoning: 'reasoning' in plan ? plan.reasoning : undefined,
          category: 'category' in plan ? plan.category : undefined,
        });

        // v3.2.x (#8) — colleague proposed a slot that breaks a soft rule and
        // planMeeting found nearby rule-compliant alternatives. Offer them first
        // instead of escalating; only if the colleague insists (or none fit)
        // does Sonnet fall to create_approval.
        if (plan.action === 'propose_alternative') {
          // These times are being SAID to the colleague, so they are offered
          // times: stash them or "the Sunday one works" comes back as
          // slot_not_offered and a bare weekday+time gets re-derived onto the
          // wrong week.
          recordProposedAlternatives({
            channelId: context.channelId,
            threadTs: context.threadTs,
            timezone,
            alternatives: plan.alternatives,
            widenedAlternatives: plan.widenedAlternatives,
          });
          return {
            success: false,
            error: 'soft_rule_offer_alternatives',
            violation_label: plan.violationLabel,
            // The day they asked for and the widening are separate fields
            // on purpose. Offer the requested day's options as THE answer; the
            // other-day ones only exist because that day ran out, so they are
            // offered as a widening, never merged into one list.
            requested_day: plan.requestedDay,
            alternatives_on_requested_day: plan.alternatives,
            alternatives_other_days: plan.widenedAlternatives,
            suggested_ask_text: plan.suggestedAskText,
            ...openQuestionsField(plan.openQuestions),
            _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
            _note: `The proposed time breaks one of the owner's soft rules. Do NOT escalate yet. ${alternativesNote(plan.requestedDay, plan.alternatives.length, plan.widenedAlternatives.length)} If they INSIST on the original time, or none of these work, THEN call create_approval(kind=policy_exception) with suggested_ask_text so the owner decides.`,
          };
        }
        // Early-return on non-book plans:
        if (plan.action === 'confirm_override' || plan.action === 'escalate_approval') {
          // v4.4.x (#154) / o#223>dep — a ROOM rule-bend (the authenticated
          // owner insisting on this EXACT slot from a clamped MPIM/channel
          // surface) must reach his private approval thread deterministically
          // — never depend on Sonnet placing the create_approval follow-up
          // call this turn. Raise it here, in code, via the same primitive the
          // create_approval TOOL itself calls (tasks/skill.ts's
          // createApprovalRequest) — identical gate, identical refusal shape —
          // instead of returning a `_note` and hoping.
          if (plan.action === 'escalate_approval' && bookingRequest.relaxedReason === 'owner_room_bend') {
            const approval = await createApprovalRequest({
              kind: 'policy_exception',
              payload: {
                rule: plan.violationLabel,
                context: `${context.profile.user.name.split(' ')[0]} asked to book this exact slot anyway from a room, bending one of his own scheduling rules — needs his sign-off in DM, not a room self-grant.`,
                subject: args.subject,
                start: args.start,
                end: args.end,
                attendees: args.attendees,
                deferred_action: { tool: 'create_meeting', args: { ...args } },
              },
              ask_text: plan.suggestedAskText,
            }, context) as { ok?: boolean; error?: string; reason?: string; approval_id?: string };
            if (approval.ok) {
              logger.info('create_meeting — ownerRoomBend escalated to create_approval directly (code path)', {
                approvalId: approval.approval_id, subject: args.subject, start: args.start,
              });
              return {
                success: false,
                error: 'escalated_to_owner',
                violation_label: plan.violationLabel,
                approval_id: approval.approval_id,
                category: plan.category,
                // gh#154-R11 (owner ruling, verbatim: "she dont need to write in the
                // room ... she doesnt need to write anything. its person to
                // person ... still will get back after hour and approved.") —
                // this is meta-instruction for the model, NEVER a sentence to
                // say. The approval is already raised in code above; the room
                // must not learn a rule was bent or that anything is pending.
                _note: `Already escalated to ${context.profile.user.name.split(' ')[0]}'s private approval DM in code — do NOT call create_approval yourself for this. Do NOT tell this room that anything was escalated, sent for approval, needs sign-off, or bent a rule — no process narration at all. Reply with something ordinary that mentions none of this (or nothing further this turn); the resolver posts the outcome back in this thread once he responds, on his own time.`,
              };
            }
            logger.warn('create_meeting — ownerRoomBend direct create_approval call refused', {
              error: approval.error, reason: approval.reason, subject: args.subject, start: args.start,
            });
            return {
              success: false,
              error: approval.error ?? 'internal_error',
              violation_label: plan.violationLabel,
              // gh#154-W4 (2026-08-06) — the SAME silence rule as the success branch
              // above applies here too: whether the private-DM raise
              // SUCCEEDED or — here — FAILED internally, the room must never
              // learn a rule-bend was even attempted. `approval.reason` is
              // written to instruct the MODEL on a retry (gateApprovalAsk),
              // never to be read aloud, so it does NOT belong in a spoken
              // `message`. Falling through to the generic (non-room-bend)
              // escalate_approval return below would be wrong here — that
              // path is written for a genuine colleague ask, where saying
              // "I'll check with him" is the correct, expected answer (M9);
              // this is the owner bending his own rule from a room, where he
              // must never learn it was even tried, success or failure.
              _note: `Raising this in ${context.profile.user.name.split(' ')[0]}'s private approval DM failed internally — do NOT call create_approval yourself for this, and do NOT tell this room that anything was escalated, sent for approval, needs sign-off, bent a rule, or failed — no process narration at all. Reply with something ordinary that mentions none of this (or nothing further this turn); try the request again in a bit.`,
            };
          }
          return {
            success: false,
            error: 'rule_violation',
            violation_label: plan.violationLabel,
            suggested_ask_text: plan.suggestedAskText,
            ...openQuestionsField(plan.openQuestions),
            category: plan.category,
            // v2.7.2 — deferred_action_hint: the original tool call, ready to be
            // stamped on a follow-up create_approval. Orchestrator auto-attaches
            // this to payload.deferred_action when Sonnet raises a
            // policy_exception this turn, so the resolver can replay the booking
            // on approve. The "redirect URL token" pattern — args round-trip
            // through the approval.
            _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
            _note: plan.action === 'escalate_approval'
              ? 'A scheduling rule was violated. Use create_approval(kind=policy_exception) with suggested_ask_text to get the owner to decide.'
              // v3.2.1 (#120a — one mechanism) — owner-path soft-rule override
              // flows through the SAME persisted approval path as escalate. If
              // the owner ALREADY authorized it in THIS message, retry
              // create_meeting now with relaxed=true. Otherwise
              // create_approval(kind=policy_exception) so the override PERSISTS
              // and his later "yes" replays it deterministically.
              : 'A soft scheduling rule was violated. If the owner ALREADY authorized overriding it in THIS message, retry create_meeting now with relaxed=true. Otherwise call create_approval(kind=policy_exception) with suggested_ask_text — this PERSISTS the override (the orchestrator stamps the deferred booking) so the owner\'s later "yes" replays it on its own, instead of relying on you to re-issue the booking next turn.',
          };
        }
        // v2.8.2 — ask_location_mode: office day + external + same/unknown TZ
        // with no owner hint. Refuse and surface the ask. Sonnet relays to the
        // owner, the owner replies online/physical, Sonnet re-calls with
        // is_online=true OR location=<full address> set explicitly.
        if (plan.action === 'ask_location_mode') {
          return {
            success: false,
            error: 'location_mode_unspecified',
            suggested_ask_text: plan.suggestedAskText,
            ...openQuestionsField(plan.openQuestions),
            category: plan.category,
            _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
            _note: 'Office day + external attendee in same/unknown timezone. Ask the owner online vs physical, then re-call create_meeting with either is_online=true or location=<full office address>.',
          };
        }
        // v2.8.2 — meeting room mailbox busy + ≥6 people (small-room fallback
        // doesn't fit). Refuse + surface the ask.
        if (plan.action === 'room_unavailable_large') {
          return {
            success: false,
            error: 'meeting_room_unavailable_large_meeting',
            suggested_ask_text: plan.suggestedAskText,
            ...openQuestionsField(plan.openQuestions),
            category: plan.category,
            _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
            _note: 'Meeting Room is taken at this time and the group is too large for the small-room fallback. Ask the owner whether to push the time, trim the attendee list, or pick a different day.',
          };
        }
        // plan.action === 'book' — extract isOnline/location/category and proceed.
        // (Other plan kinds — find_slots / decline_as_attendee / refuse_not_owners —
        // can't reach here from a new_booking intent; the type narrowing makes
        // the cast unconditional after the early-return.)
        if (plan.action !== 'book') {
          return {
            success: false,
            error: 'unexpected_plan_action',
            message: `planMeeting returned unexpected action "${plan.action}" for create_meeting — this is a bug.`,
          };
        }

        // #133 / #188 — efficient-calendar counter-offer (dense packing only). If
        // the requested time leaves a short dead gap (6–29 min) on either side —
        // after the prior meeting OR before the next one — and a back-to-back
        // start on that side is free + rule-valid, offer that instead of booking
        // as-is (earlierConnectiveStart searches both sides; a tie favours
        // earlier). The caller insists by re-calling with keep_requested_time.
        // Gated on packing_preference==='dense' → byte-identical for other
        // tenants; fail-open (any throw books as requested). Skipped under
        // relaxed — an owner override / approved policy_exception replay
        // already decided the exact time; never counter-offer over it.
        //
        // A3 — `bookingRequest.relaxed`, not `args.relaxed`. This was the last raw
        // read of that arg anywhere in the subsystem (P22 made `grantRelaxed` the one
        // grant, keyed on the AUTHENTICATED sender). It granted nothing, so no rule
        // was waived by it — but it waived an owner PROTECTION, and it waived it on
        // an arg the model fills from message content rather than on identity. The
        // suppression's own stated reason ("an owner override already decided the
        // exact time") is only ever true of the gated value: on a colleague turn — or
        // the owner's own turn inside a group DM, where the MPIM clamp makes his
        // senderRole 'colleague' — `relaxed:true` decides nothing at all.
        //
        // THE DELTA, plainly: a colleague-initiated booking that arrives with a
        // spurious `relaxed:true` (the model is told to retry that way after a soft
        // refusal, so it is reachable; zero occurrences in any log on disk, so it is
        // unevidenced) now gets the dense-packing counter-offer instead of skipping
        // it. That is not new behaviour — it is exactly what the same booking gets
        // today without the flag, and the counter-offer is only produced when the
        // back-to-back start is rule-clean AND free for every attendee. The
        // case that MUST keep the suppression keeps it: an approved
        // policy_exception replay runs on a synthetic owner context
        // (deferredActionReplay), so `grantRelaxed` grants it and the approved time
        // is booked exactly as approved.
        if (args.keep_requested_time !== true && bookingRequest.relaxed !== true) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const density = require('../../../../utils/calendarDensity') as typeof import('../../../../utils/calendarDensity');
            if (density.prefersDensePacking(context.profile.meetings)) {
              const tzc = context.profile.user.timezone;
              const reqStartIso = bookingRequest.slotStartIso;
              const reqEndIso = bookingRequest.slotEndIso;
              const rs = reqStartIso ? DateTime.fromISO(reqStartIso, { zone: tzc, setZone: true }).setZone(tzc) : DateTime.invalid('no start');
              const re = reqEndIso ? DateTime.fromISO(reqEndIso, { zone: tzc, setZone: true }).setZone(tzc) : DateTime.invalid('no end');
              if (rs.isValid && re.isValid) {
                // v4.2.2 — this block has the LAST WORD on where the meeting
                // lands, and it used to read `'cached'`. planMeeting validated the
                // REQUESTED time live (:818); this then re-decides the start from
                // its own copy of the day, and a warm copy up to
                // CALENDAR_CACHE_TTL_SECONDS old is enough to double-book: ask
                // "what's on Thursday" earlier in the thread, accept a 13:30 invite
                // in Outlook, then say "book Simon 14:00" — planMeeting's live read
                // clears 14:00 while the stale copy sees 13:30 free and pulls the
                // meeting on top of it. One array feeds both
                // `earlierConnectiveStart` and the `checkSlot` that blesses its
                // candidate, so stale data is self-consistently wrong: nothing
                // downstream can catch it. A decision read is 'live' (ReadFreshness).
                const dayEvents = await getOwnerEventsForDecision(
                  context.profile.user.email,
                  rs.startOf('day').toFormat("yyyy-MM-dd'T'00:00:00"),
                  rs.endOf('day').toFormat("yyyy-MM-dd'T'23:59:59"),
                  tzc,
                );
                const ownerBusy = dayEvents
                  .filter(e => !e.isCancelled && !e.isAllDay && (e as { showAs?: string }).showAs !== 'free' && (e as { showAs?: string }).showAs !== 'workingElsewhere')
                  .map(e => ({
                    start: DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? tzc }).toMillis(),
                    end: DateTime.fromISO(e.end.dateTime, { zone: e.end.timeZone ?? tzc }).toMillis(),
                  }));
                const cfg = density.densityConfigFromProfile(context.profile.meetings);
                const cand = density.earlierConnectiveStart(rs.toMillis(), re.toMillis(), ownerBusy, cfg, tzc);
                if (cand !== null) {
                  const durMs = re.toMillis() - rs.toMillis();
                  const candStartIso = DateTime.fromMillis(cand, { zone: tzc }).toISO()!;
                  const candEndIso = DateTime.fromMillis(cand + durMs, { zone: tzc }).toISO()!;
                  // eslint-disable-next-line @typescript-eslint/no-require-imports
                  const { checkSlot } = require('../../../../utils/scheduleRules') as typeof import('../../../../utils/scheduleRules');
                  const verdict = checkSlot({
                    profile: context.profile,
                    slotStartIso: candStartIso,
                    slotEndIso: candEndIso,
                    category: (args.category as string) ?? null,
                    events: dayEvents,
                  });
                  // Attendee-aware: the candidate slot must ALSO be free for any
                  // attendees. Critical cross-TZ — an earlier IL time can fall
                  // BEFORE a US attendee's hours (14:45 IL = 07:45 ET), and a later
                  // one can fall AFTER them. checkSlot above only covers OWNER
                  // rules; reuse the finder (attendee tz + busy) for the candidate
                  // window and only counter if it comes back.
                  let attendeeClean = true;
                  const attEmails = Array.isArray(args.attendees)
                    ? (args.attendees as Array<{ email?: string }>).map(a => a?.email).filter((e): e is string => !!e)
                    : [];
                  if (verdict.passes && attEmails.length > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { findAvailableSlots } = require('../../../../connectors/graph/calendar') as typeof import('../../../../connectors/graph/calendar');
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { attendeeCheckParams } = require('../../../../utils/attendeeAvailability') as typeof import('../../../../utils/attendeeAvailability');
                    // Re-check the candidate against the ATTENDEES too, not just the
                    // owner — attendeeCheckParams carries busy + hours/tz clip, so the cross-TZ
                    // guard (an earlier IL time BEFORE, or a later one AFTER, a US
                    // attendee's hours) actually fires.
                    const attSlots = await findAvailableSlots({
                      userEmail: context.profile.user.email,
                      timezone: tzc,
                      durationMinutes: Math.round(durMs / 60000),
                      ...attendeeCheckParams(attEmails, context.profile.user.email),
                      searchFrom: candStartIso,
                      searchTo: candEndIso,
                      minBufferHours: 0,
                      profile: context.profile,
                    });
                    attendeeClean = attSlots.some(s => DateTime.fromISO(s.start).toMillis() === cand);
                  }
                  if (verdict.passes && attendeeClean) {
                    logger.info('create_meeting — efficiency counter-offer', {
                      requested: rs.toISO(), suggested: candStartIso, subject: args.subject,
                    });
                    // #188 — the candidate can now land on either side of the
                    // request (earlierConnectiveStart searches both), so the
                    // reason/note must name the side that actually moved —
                    // a fixed "earlier" wording would be a false reason (M11)
                    // half the time.
                    const isLater = cand > rs.toMillis();
                    return {
                      success: false,
                      error: 'efficiency_counter',
                      counter_offer: {
                        requested_start: rs.toFormat("yyyy-MM-dd'T'HH:mm"),
                        suggested_start: DateTime.fromMillis(cand, { zone: tzc }).toFormat("yyyy-MM-dd'T'HH:mm"),
                        reason: isLater
                          ? 'The requested time leaves a short, unfocusable gap before the next meeting; the later start packs it back-to-back and keeps your free time in one block.'
                          : 'The requested time leaves a short, unfocusable gap after the prior meeting; the earlier start packs it back-to-back and keeps your free time in one block.',
                      },
                      _deferred_action_hint: { tool: 'create_meeting', args: { ...args } },
                      _note: isLater
                        ? 'Dense-calendar preference. Offer suggested_start as the tighter option ("X works — but Y puts it right before your next meeting instead of a dead gap. Y?"). If they keep the original time, re-call create_meeting with keep_requested_time:true to book as requested.'
                        : 'Dense-calendar preference. Offer suggested_start as the tighter option ("X works — but Y puts it right after your last meeting instead of a dead gap. Y?"). If they keep the original time, re-call create_meeting with keep_requested_time:true to book as requested.',
                    };
                  }
                }
              }
            }
          } catch (err) {
            logger.warn('create_meeting — efficiency counter-offer threw, booking as requested', { err: String(err).slice(0, 160) });
          }
        }
        const effectiveIsOnline: boolean = plan.isOnline;
        const planLocation: string = plan.location;
        const planCategory: string | null = plan.category;
        const planAddRoomEmail = plan.addRoomEmail === true;
        // #127 — owner booked through a soft own-day rule (focus floor, hours,
        // lunch, his own busy-collision). Captured here (where `plan` is narrowed
        // to 'book') so it survives into the createMeeting().then() closure below.
        const planOverrideNotice = plan.overrideNotice;
        // skipLocationField fires when resolveLocation gave us no physical string —
        // the create call sends an empty location, and for an online meeting Graph
        // fills it natively with "Microsoft Teams Meeting" (we never stamp a URL).
        const skipLocationField = planLocation.trim().length === 0;
        // v4.0.x — planMeeting's classifier (which now reconciles the model's
        // requested category as a hint) is AUTHORITATIVE for the WRITE. Previously
        // args.category (the model's raw arg) won and plan.category was only a
        // fallback + a log line — so Sonnet 5 hallucinating "Outside" on an online
        // call silently overrode the classifier's correct "Meeting" (the B&H bug:
        // verdict logged "Meeting", event written "Outside"). Now the reconciled
        // verdict overwrites the arg; the arg survives only when the classifier
        // found no clear match (planCategory null).
        const modelRequestedCategory = typeof args.category === 'string' ? args.category : null;
        if (planCategory) {
          args.category = planCategory;
        }
        logger.info('create_meeting — category applied', {
          applied: (args.category as string | undefined) ?? 'Meeting (default)',
          classifierVerdict: planCategory,
          modelRequested: modelRequestedCategory,
        });
        // v2.8.2 — location stamping is a single string from resolveLocation.
        // For owner-explicit non-ASCII venues we resolve to English for the
        // calendar.
        const resolvedLocationParts: string[] = await (async (): Promise<string[]> => {
          if (skipLocationField) return [];
          const hasNonAscii = /[^\x20-\x7e]/.test(planLocation);
          if (!hasNonAscii) return [planLocation];
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { resolveVenueLocation } = require('../../../../utils/locationResolver') as
              typeof import('../../../../utils/locationResolver');
            const resolved = await resolveVenueLocation(planLocation, 'en');
            return [resolved.resolved ? resolved.fullDisplay : planLocation];
          } catch (err) {
            logger.warn('venue resolution threw — using planMeeting location verbatim', {
              err: String(err).slice(0, 200),
            });
            return [planLocation];
          }
        })();
        // v2.8.2 — for office-day internal ≥4, planMeeting flagged addRoomEmail.
        // Add profile.meetings.room_email as an OPTIONAL attendee on the create
        // call. Room mailbox auto-accepts the slot when free.
        if (planAddRoomEmail && context.profile.meetings.room_email) {
          const roomEmail = context.profile.meetings.room_email.toLowerCase();
          const already = attendees.some(a => (a.email ?? '').toLowerCase() === roomEmail);
          if (!already) {
            attendees.push({
              email: context.profile.meetings.room_email,
              name: planLocation,           // "Meeting Room"
              optional: true,
            } as typeof attendees[number]);
          }
        }

        // #30 — hold-conflict gate. Never book over a slot tentatively held for
        // SOMEONE ELSE. Owner → confirm once ("X reserved that — book anyway?"),
        // override_hold:true on the retry → book + release + DM holder. Colleague
        // → can't override another's hold; route to the OWNER's approval (the
        // RESERVE_SLOT design: a race goes to the owner, code never silently picks
        // a winner). A holder booking the slot THEY hold proceeds (own confirm →
        // released on success below). holder_slack_id===userId skips the gate.
        {
          const { getActiveHoldOverlapping } = await import('../../../../db/slotHolds');
          const conflictHold = getActiveHoldOverlapping(
            context.profile.user.slack_user_id, args.start as string, args.end as string,
          );
          if (conflictHold && conflictHold.holder_slack_id !== context.userId) {
            if (context.senderRole === 'owner') {
              if (args.override_hold !== true) {
                return {
                  success: false,
                  error: 'slot_on_hold',
                  hold_id: conflictHold.id,
                  holder_name: conflictHold.holder_name,
                  message: `${conflictHold.holder_name} asked to reserve ${formatIsoTime(args.start as string)}${conflictHold.reason ? ` (${conflictHold.reason})` : ''}. Book over it anyway? On your yes I'll book it and let ${conflictHold.holder_name} know the hold was released.`,
                  _deferred_action_hint: { tool: 'create_meeting', args: { ...args, override_hold: true } },
                  _note: 'Surface this to the owner. If he says book it anyway, retry create_meeting with override_hold:true — that books it, releases the hold, and DMs the holder.',
                };
              }
              // owner + override_hold:true → fall through and book; release fires on success.
            } else {
              // Colleague booking over ANOTHER colleague's hold — never silently.
              // v4.1.x — this branch tells the model to raise a policy_exception
              // but shipped NO `_deferred_action_hint`, so the approval carried no
              // action of its own. Two consequences, one of them live today:
              //   • the orchestrator stamps `payload.deferred_action` ONLY from a
              //     hint, so the approval had nothing to replay and its action was
              //     fabricated downstream — on approve the replay re-entered this
              //     very gate and died, leaving the request in `awaiting_owner`.
              //     A colleague asked, the owner said yes, and nothing was booked.
              //   • the requests lane's new create_approval gate refuses an
              //     unstamped policy_exception outright, which would loop here.
              // `override_hold: true` is REQUIRED, not decoration: the replay runs
              // as the OWNER (deferredActionReplay.ts:74-83), so a bare `{...args}`
              // lands on the owner confirm two lines up and returns success:false —
              // the exact dead end above. The flag IS what the owner just approved:
              // book it, release the hold, DM the holder (handled after the write).
              return {
                success: false,
                error: 'slot_held_needs_owner_approval',
                hold_id: conflictHold.id,
                message: `That time is tentatively held for someone else — don't book it, and don't reveal who holds it. Raise create_approval(kind=policy_exception) with this slot so ${context.profile.user.name.split(' ')[0]} decides; tell the colleague warmly you're checking on it.`,
                _deferred_action_hint: { tool: 'create_meeting', args: { ...args, override_hold: true } },
              };
            }
          }
        }

        return createMeeting({
          userEmail,
          timezone,
          // v2.4.3 — subject NOT scrubbed: " - " separator is fine in
          // subjects ("Welcome Meeting - X & Y" reads naturally). The em-dash /
          // " - " pattern is only a chat-side issue; calendar subjects can keep them.
          subject:    args.subject  as string,
          start:      args.start    as string,
          end:        args.end      as string,
          // By this point Guard A has refused any attendee missing email and
          // the auto-fill has populated names. Coerce to the strict shape.
          attendees:  attendees.map(a => ({ name: a.name ?? '', email: a.email ?? '' })),
          // v2.4.3 — body scrubbed AND auto-enriched with location. The
          // Outlook location field is truncated by many clients, so the body
          // always carries a readable location line at the top — attendees can find the meeting
          // regardless of how their client renders the location field.
          body: (() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { scrubInternalLeakage } = require('../../../../utils/textScrubber') as typeof import('../../../../utils/textScrubber');
            const raw = args.body as string | undefined;
            const cleanedRaw = raw ? scrubInternalLeakage(raw) : '';
            // v2.6.2 — use skipLocationField (not effectiveIsOnline) so
            // office-day internal hybrid meetings DO get a location block in the
            // body even when a Teams link is also being added.
            if (skipLocationField) {
              // Fully online — no physical location to surface. Return body as-is.
              return cleanedRaw || undefined;
            }
            if (!resolvedLocationParts || resolvedLocationParts.length === 0) {
              return cleanedRaw || undefined;
            }
            // Build a clean location block — one line per part, no em-dash
            // separators. Reads cleanly in any client.
            const locBlock =
              `<p><strong>Location:</strong></p>\n` +
              `<ul>${resolvedLocationParts.map(p => `<li>${p}</li>`).join('')}</ul>`;
            const composed = cleanedRaw
              ? `${locBlock}\n<hr/>\n${cleanedRaw}`
              : locBlock;
            return composed;
          })(),
          // v2.5.2 — effective isOnline pulls from Sonnet's explicit arg first,
          // falls back to the day-aware decision when both is_online and location
          // were left blank.
          isOnline:   effectiveIsOnline,
          // All-day events. Sonnet sets is_all_day=true ONLY when owner
          // explicitly asks for a full-day event. createMeeting() clamps
          // start/end to midnight-of-day → midnight-of-next-day per Graph's
          // requirement; we just pass the flag through here.
          isAllDay:   args.is_all_day === true,
          // v2.3.2 (1C) / v2.3.6 (#73) / v2.4.3 — clean comma-joined
          // location with no em-dash separators (an em-dash joiner makes the
          // Outlook location field hard to read), routed through
          // scrubInternalLeakage for safety against any owner-yaml accidental
          // dashes.
          location: ((): string | undefined => {
            if (args.is_online === true) return undefined;
            if (!resolvedLocationParts || resolvedLocationParts.length === 0) return undefined;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { scrubInternalLeakage } = require('../../../../utils/textScrubber') as typeof import('../../../../utils/textScrubber');
            return scrubInternalLeakage(resolvedLocationParts.join(', '));
          })(),
          categories:  args.category ? [args.category as string] : ['Meeting'],  // default fallback
          // Stamp sensitivity=private on the Graph event when the chosen
          // category carries `sets_sensitivity_private: true` in yaml. Reads
          // from profile rather than hardcoding any specific category name —
          // a future profile that wants a different category to be its
          // privacy marker just sets the flag in yaml.
          // v2.8.6 — explicit args.sensitivity overrides the category-driven
          // default. Lets owner OR an attendee ask "mark this private" at booking
          // time. Default is undefined (Outlook normal); only set when the
          // conversation asked for it.
          sensitivity: (() => {
            const explicit = args.sensitivity as string | undefined;
            const ALLOWED = ['normal', 'personal', 'private', 'confidential'];
            if (explicit && ALLOWED.includes(explicit) && explicit !== 'normal') {
              return explicit as 'personal' | 'private' | 'confidential';
            }
            const cat = (args.category as string | undefined) ?? null;
            if (!cat) return undefined;
            const match = (context.profile.categories ?? []).find(c => c.name === cat);
            return match?.sets_sensitivity_private ? 'private' : undefined;
          })(),
          // v2.3.1 — invite-body attribution names this assistant + owner.
          defaultBodyAuthor: `${context.profile.assistant.name}, ${context.profile.user.name.split(' ')[0]} Assistant`,
        }).then(async createdMeeting => {
          const meetingId = createdMeeting.id;
          // v2.2.5 (#54) — post-create verification. Graph occasionally returns
          // 200 OK + an event id on writes that didn't actually land (sync
          // delays, race conditions). Re-read by id and confirm the start time
          // matches before declaring success. On failure, downstream layers see
          // {success:false} so the action tape, claim-checker, and brief all
          // narrate honestly instead of asserting a write that didn't happen.
          const { verifyEventCreated } = await import('../../../../connectors/graph/calendar');
          const verify = await verifyEventCreated(userEmail, meetingId, args.start as string, timezone);
          if (!verify.ok) {
            logger.warn('create_meeting verify failed — Graph returned id but readback drifted', {
              meetingId, reason: verify.reason,
              expected: 'expected' in verify ? verify.expected : undefined,
              got: 'got' in verify ? verify.got : undefined,
            });
            const subject = args.subject as string;
            const message = verify.reason === 'not_found'
              ? `I tried to book '${subject}' but couldn't read it back from the calendar afterward — the booking may not have landed. Want me to retry?`
              : `I created '${subject}' but the calendar shows it at ${verify.got} instead of ${verify.expected}. Something drifted on the write — want me to delete and retry?`;
            return {
              success: false,
              error: verify.reason === 'not_found' ? 'created_but_missing' : 'created_but_drift',
              message,
            };
          }

          // gh#52 (52-U3) — undo/history record for this booking, past the
          // verifyEventCreated read-back just above (verify.ok already
          // confirmed the write landed under this id). An undo of a create is
          // a delete-by-id, so the event id alone is the reverse handle;
          // subkind is the literal tool name (matches ACTIVITY_REVERTIBILITY's
          // keying in activityRevertibility.ts) so a later revert dispatch can
          // look it up directly off this row.
          logActivity({
            ownerUserId: context.profile.user.slack_user_id,
            kind: 'follow_up',
            subkind: 'create_meeting',
            subject: `Booked '${args.subject as string}'`,
            outcomeJson: {
              event_id: meetingId,
              start: args.start,
              end: args.end,
            },
            initiatedBy: context.userId,
            initiatedByRole: context.senderRole,
            originThreadTs: context.threadTs,
            originChannel: context.channelId,
            // OT-4 (bouncer fix, gh#52) — the colleague who asked for this
            // booking (resolved once, near the top of this handler; excludes
            // the owner himself), so the row is with_person-filterable on
            // them. Undefined on a plain owner-initiated booking with no
            // colleague requester — left null rather than guessed off
            // attendees, which can be zero, one, or many.
            requesterSlackId: requesterId,
          });

          // v3.6.x — the Teams-URL-as-location patch was REMOVED. It overwrote the
          // location Graph auto-sets on an online meeting ("Microsoft Teams
          // Meeting") with the raw joinUrl → the new Outlook then showed the URL as
          // an "Unknown" location AND dropped the native Teams rendering (the toggle
          // went off) even though isOnlineMeeting stayed true (the 2026-07-05
          // Catchup bug). A native Teams meeting needs NOTHING after create:
          // isOnlineMeeting + provider (in the createMeeting POST) already give the
          // toggle, the Join button, the body block, and the location label. Never
          // write the raw joinUrl into location.

          // v2.2.3 (scenario 8 row 7) — post-mutation floating-block rebalance.
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { rebalanceFloatingBlocksAfterMutation } = require('../../../../utils/rebalanceFloatingBlocks') as
              typeof import('../../../../utils/rebalanceFloatingBlocks');
            await rebalanceFloatingBlocksAfterMutation({
              profile: context.profile,
              affectedSlotIso: args.start as string,
              ownerSlackId: context.profile.user.slack_user_id,
            });
          } catch (err) {
            logger.warn('rebalance after create_meeting threw — continuing', { err: String(err).slice(0, 200) });
          }

          // v2.9.2 — close in-flight artifacts. Per closeMeetingArtifacts' own
          // contract (v1.8.8 / v2.4.2 comments): "Every meeting mutation —
          // create / move / update / delete — can leave stale artifacts." Every
          // mutation path must call the cascade,
          // else in_flight_action follow_ups opened during a spilled create
          // attempt never close on the successful retry. Subject is passed so
          // the subject-fallback match catches rows whose details.meeting_id is
          // undefined.
          await closeMeetingArtifacts({
            ownerUserId: context.profile.user.slack_user_id,
            meetingId,
            reason: 'created',
            subject: args.subject as string | undefined,
            bookingThreadTs: context.threadTs,
            // v3.4.6 — approve→book link: on a resolver-driven replay this is
            // the originating request id, so the cascade skips it (resolver owns
            // its close + relay). Undefined on direct/owner-path books.
            fulfillingRequestId: args._fulfilling_request_id as string | undefined,
            // v4.5.x (colleague-approval-orphaned-after-replay-failure-direct-book)
            // — the requested start, so the requests-lane cascade can retroactively
            // match this booking to an open approval whose auto-replay failed and
            // was then executed by this direct call instead of a resolve_approval
            // retry (no _fulfilling_request_id, no pre-existing meeting_id, and the
            // owner's decision thread is never the colleague's origin thread).
            bookingStartIso: args.start as string | undefined,
          });

          // The booked slot became real, so any tentative hold on it is
          // resolved. Release it; if it was held by SOMEONE ELSE (the owner
          // booked over it via override_hold), DM that holder it was let go.
          // The holder's own confirm releases silently (it's their meeting now).
          try {
            const sh = await import('../../../../db/slotHolds');
            const cleared = sh.releaseHoldsForOwner(
              context.profile.user.slack_user_id, { startIso: args.start as string }, 'slot_booked',
            );
            for (const h of cleared) {
              if (!h.holder_slack_id || h.holder_slack_id === context.userId) continue;
              // o#181 — gate the notification on the booking's OWN inbound
              // channel, not the (hardcoded-'slack') holder lookup below. An
              // email- or whatsapp-triggered booking must not fire an outbound
              // Slack DM on the requester's behalf — that surface never used
              // Slack this turn, and getConnection(..., 'slack') would happily
              // hand back the Slack connection regardless of context.channel.
              // The hold is still released (bookkeeping above); only the DM
              // is channel-gated. Slack-path notification (its legitimate use,
              // e.g. the owner booking over a colleague's held slot) is
              // unaffected.
              if (context.channel !== 'slack') {
                logger.info('create_meeting — hold-release DM skipped (non-Slack booking channel)', {
                  channel: context.channel, holder: h.holder_slack_id,
                });
                continue;
              }
              try {
                const { getConnection } = await import('../../../../connections/registry');
                const conn = getConnection(context.profile.user.slack_user_id, 'slack');
                if (conn) {
                  await conn.sendDirect(
                    h.holder_slack_id,
                    `Quick heads up — ${context.profile.user.name.split(' ')[0]} ended up taking ${formatIsoTime(args.start as string)}, so I've released the hold I had for you there. Happy to find you another time whenever.`,
                    h.origin_thread_ts ? { threadTs: h.origin_thread_ts } : undefined,
                  );
                }
              } catch (dmErr) {
                logger.warn('create_meeting — hold-release DM failed (hold already released)', { err: String(dmErr).slice(0, 150) });
              }
            }
          } catch (err) {
            logger.warn('create_meeting — slot-hold release threw, continuing', { err: String(err).slice(0, 150) });
          }

          // v2.3.2 — colleague-path booking: shadow-DM the owner so he sees the
          // book happen even when he wasn't in the loop. Mirrors the v2.2.1
          // move_meeting shadow on inbound reschedule. Threaded under the
          // colleague conversation key so all shadows from this thread group
          // together in the owner's DM.
          // Skip when the "colleague" is really the OWNER clamped to colleague-
          // context in an MPIM/channel: he booked it himself and was right there,
          // so a self-shadow ("Idan confirmed slot in DM — booked…") is nonsense.
          // `isGenuineColleague` — same clamped-owner test resolved once, above.
          if (isGenuineColleague) {
            try {
              const { shadowNotify } = await import('../../../../utils/shadowNotify');
              const { getPersonMemory } = await import('../../../../db');
              const requesterRow = getPersonMemory(context.userId);
              const requesterName = requesterRow?.name ?? 'a colleague';
              const whenLocal = DateTime.fromISO(args.start as string, { zone: timezone });
              const whenLabel = whenLocal.isValid
                ? whenLocal.toFormat('EEE d MMM HH:mm')
                : formatIsoTime(args.start as string);
              await shadowNotify(context.profile, {
                channel: context.channelId,
                threadTs: context.threadTs,
                action: 'Meeting booked',
                detail: `${requesterName} confirmed slot in DM — booked "${args.subject}" for ${whenLabel}.`,
                conversationKey: context.threadTs,
                conversationHeader: `Conversation with ${requesterName}`,
              });
            } catch (err) {
              logger.warn('shadowNotify after colleague create_meeting failed — continuing', { err: String(err).slice(0, 200) });
            }

            // v2.3.2 — post-booking heads-up DMs to non-self internal attendees.
            // The fast-path skipped DMs during slot search (we checked their
            // calendars directly via Graph) — they deserve a soft "this just got
            // booked" so they aren't surprised by the calendar invite, phrased
            // like a human EA. Lookup by email via searchPeopleMemory; skip
            // silently if no slack_id available (the calendar invite still went
            // out).
            try {
              const { searchPeopleMemory, getPersonMemory } = await import('../../../../db');
              const { getConnection } = await import('../../../../connections/registry');
              const conn = getConnection(context.profile.user.slack_user_id, 'slack');
              if (conn) {
                const requesterRow = getPersonMemory(context.userId);
                const requesterName = requesterRow?.name ?? 'a colleague';
                const requesterEmail = (requesterRow?.email ?? '').toLowerCase();
                const ownerFirst = context.profile.user.name.split(' ')[0];
                const ownerDomain = ownerEmail.includes('@') ? ownerEmail.split('@')[1].toLowerCase() : '';
                const whenLocal = DateTime.fromISO(args.start as string, { zone: timezone });
                const whenLabel = whenLocal.isValid
                  ? whenLocal.toFormat('EEEE d MMM \'at\' HH:mm')
                  : formatIsoTime(args.start as string);
                for (const att of attendees) {
                  const e = (att.email ?? '').toLowerCase();
                  if (!e) continue;
                  if (e === ownerEmail.toLowerCase()) continue;
                  if (e === requesterEmail) continue;
                  if (assistantEmail && e === assistantEmail.toLowerCase()) continue;
                  if (!ownerDomain || !e.endsWith('@' + ownerDomain)) continue;  // internal only
                  const matches = searchPeopleMemory(e);
                  const targetSlackId = matches.find(m => (m.email ?? '').toLowerCase() === e)?.slack_id;
                  if (!targetSlackId) {
                    logger.debug('post-booking heads-up DM skipped — no slack_id for attendee', { email: e });
                    continue;
                  }
                  const heuristicFirstName = (att.name ?? '').split(' ')[0];
                  const text = `Hi ${heuristicFirstName} — ${requesterName} asked for a meeting with you and ${ownerFirst}. I checked your calendar and booked "${args.subject}" for ${whenLabel}. See you then.`;
                  void conn.sendDirect(targetSlackId, text).catch(err => {
                    logger.warn('post-booking heads-up DM failed', { email: e, err: String(err).slice(0, 200) });
                  });
                }
              }
            } catch (err) {
              logger.warn('post-booking heads-up DMs threw — continuing', { err: String(err).slice(0, 200) });
            }
          }

          // v2.9 — venue skill save-on-book hook. Persist non-company venues
          // to the owner's catalog at rank=2 (or bump last_used_at if already
          // saved). Only fires when the skill is on AND the stamped location
          // is an external venue (not the office, not Huddle, not Teams URL).
          if ((context.profile.skills as any)?.venue === true && planLocation && planLocation.trim().length > 0) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { isCompanyLocation } = require('../../../../db/venues') as typeof import('../../../../db/venues');
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { saveOrBumpVenueOnBook } = require('../../../venue') as typeof import('../../../venue');
              const officeLoc = context.profile.meetings.office_location ?? {};
              if (!isCompanyLocation(planLocation, officeLoc)) {
                saveOrBumpVenueOnBook({
                  ownerUserId: context.profile.user.slack_user_id,
                  name: planLocation,
                  // address is the same as name for the v2.9 MVP — the stamped
                  // location string typically already includes "Name, Street
                  // City". Future Google-Places integration (#96) will split
                  // these out.
                });
              }
            } catch (err) {
              logger.warn('venue save-on-book hook failed — continuing', {
                err: String(err).slice(0, 200),
              });
            }
          }

          // v3.0.6 — write a "Booked X" line to each non-owner attendee's
          // person_memory md so future reads have the venue/subject/date.
          // Fire-and-forget; never blocks the response. Every human attendee is
          // recorded regardless of who initiated (L3 — a booking IS active
          // engagement); non-humans are filtered in recordBooking.ts.
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { recordBookingInPersonMemory } = require('../../../../memory/recordBooking') as
              typeof import('../../../../memory/recordBooking');
            void recordBookingInPersonMemory({
              profile: context.profile,
              subject: args.subject as string,
              startIso: args.start as string,
              location: planLocation,
              attendees: attendees
                .filter((a): a is typeof a & { email: string } => typeof a.email === 'string' && a.email.length > 0)
                .map(a => ({ email: a.email, name: a.name, slack_id: a.slack_id })),
              mutation: 'booked',
            });
          } catch (err) {
            logger.warn('recordBookingInPersonMemory invocation failed (colleague-path) — continuing', {
              err: String(err).slice(0, 200),
            });
          }

          // v3.3.8 — the offer on the table was consumed by this booking; clear
          // it so a stale "bind picks to these" block can't mislead the
          // conversation's next exchange.
          if (context.channelId) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { clearOfferedSlots } = require('../../../../utils/offeredSlotsStash') as
                typeof import('../../../../utils/offeredSlotsStash');
              clearOfferedSlots(context.channelId, context.threadTs);
            } catch (_) { /* non-fatal */ }
          }

          // v3.1.4 — record the requester-link for a colleague's direct
          // booking. findMeetingOwner reads the requests spine to decide "who
          // controls this meeting"; a direct colleague create_meeting must record its
          // requester (coord bookings already do), else a colleague editing the
          // meeting they just requested isn't recognized as its requester. One
          // terminal row keyed on the event lets the requester control
          // add/rename/location via the update_meeting + move_meeting gates.
          if (context.senderRole === 'colleague' && meetingId) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { createRequest } = require('../../../../db/requests') as typeof import('../../../../db/requests');
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { getPersonMemory } = require('../../../../db/people') as typeof import('../../../../db/people');
              const requesterName = getPersonMemory(context.userId)?.name ?? undefined;
              createRequest({
                ownerUserId: context.profile.user.slack_user_id,
                initiatedBy: context.userId,
                initiatedByRole: 'colleague',
                kind: 'follow_up',
                subkind: 'colleague_booking_record',
                subject: `Booking requested by ${requesterName ?? context.userId}: ${args.subject ?? 'meeting'}`,
                state: 'resolved',
                informed: 1,
                requesterSlackId: context.userId,
                requesterName,
                outcomeExternalEventId: meetingId,
              });
            } catch (err) {
              logger.warn('colleague booking requester-link write failed — continuing', {
                err: String(err).slice(0, 200),
              });
            }
          }

          // v3.5.x (Consumer 3) — the booked-confirmation states the time via the ONE
          // renderer (dual-clock on a travel day, single clock at home), so the model
          // quotes it instead of re-narrating from the raw home-zone `booked_start`
          // and mislabelling it (the "17:00 = 5 PM EDT" inversion, 2026-06-29).
          const bookedTravel = { isAway: !!tripDisplay, effectiveTz: tripDisplay?.tz ?? timezone, location: tripDisplay?.location ?? '' };
          const bookedWhen = renderWeDualClock(args.start as string, bookedTravel, timezone, { endIso: args.end as string });
          const bookedTripNote = tripDisplay
            ? 'Travel day — state the booked time from `action_summary` VERBATIM (it carries both clocks, correctly labelled). Do NOT recompute it from `booked_start`/`booked_end`, which are the raw home-zone instant kept for verification only.'
            : undefined;
          return {
            success: true,
            meetingId,
            // #1.5 — surface the ACTUAL booked start/end (after the grid-snap at
            // :2274 + any TZ convert), so narration, dateVerifier, and the #135
            // honesty backstop (via the orchestrator's mutationActions) see where
            // the meeting TRULY landed — not the pre-snap arg Sonnet passed.
            booked_start: args.start as string,
            booked_end: args.end as string,
            // v1.8.3 — past-tense summary the reply can quote verbatim. Prevents
            // Sonnet from narrating the post-action calendar state as a fresh
            // discovery instead of the result of her own action (issue #26 bug 1).
            action_summary: `Booked '${args.subject}' for ${bookedWhen}.`,
            ...(bookedTripNote ? { _trip_note: bookedTripNote } : {}),
            // #127 — owner booked through a soft own-day rule: surface the
            // heads-up so Maelle mentions it ONCE ("Booked — note this dips your focus floor
            // to 1h55"), never a blocking re-ask. Undefined on clean bookings.
            ...(planOverrideNotice ? { override_notice: planOverrideNotice } : {}),
          };
        });
}

