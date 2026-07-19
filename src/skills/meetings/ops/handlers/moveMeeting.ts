/**
 * moveMeeting — extracted VERBATIM (v3.7.x, pass B) from the 'update_meeting' + 'move_meeting' case bodies of
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

export async function handleUpdateMeeting(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
        // v2.1.4 — attendee-only guard. If the event's organizer is not the
        // owner, the owner is an ATTENDEE on someone else's meeting. Graph
        // rejects PATCH from non-organizers, but the error message is unhelpful;
        // refuse early with a clear human message so Maelle doesn't offer a fake
        // "I'll add the location" then silently fail.
        try {
          // v2.7.0 — ownership via findMeetingOwner (per D4 / Q1).
          const { findMeetingOwner } = await import('../../findMeetingOwner');
          const ownerInfo = await findMeetingOwner({
            ownerUserId: context.profile.user.slack_user_id,
            ownerEmail: userEmail,
            eventId: args.meeting_id as string,
          });
          if (!ownerInfo.ownerIsOrganizer && ownerInfo.organizerEmail) {
            const ownerFirst = context.profile.user.name.split(' ')[0];
            const orgName = ownerInfo.organizerName ?? ownerInfo.organizerEmail;
            logger.info('update_meeting refused — owner is attendee, not organizer', {
              meetingId: args.meeting_id, organizer: ownerInfo.organizerEmail,
            });
            return {
              error: 'not_organizer',
              meeting_subject: args.meeting_subject,
              organizer_name: orgName,
              organizer_email: ownerInfo.organizerEmail,
              message: `Can't change "${args.meeting_subject}" — ${orgName} organized that one, not ${ownerFirst}. Only the organizer can change the subject, location, or body. Want me to flag it to ${ownerFirst}?`,
            };
          }
        } catch (err) {
          logger.warn('update_meeting attendee-only guard threw — proceeding', { err: String(err) });
        }

        // v1.8.8 — block series-level mutations on recurring meetings. If the
        // event is a seriesMaster, updating it would change every occurrence,
        // which is almost never what the owner wants. Refuse and hand back
        // control. Occurrences (single firings of a recurring series) and
        // exceptions (already-customized single firings) are allowed — Graph
        // creates/modifies an exception for that instance on PATCH.
        try {
          const { getEventType } = await import('../../../../connectors/graph/calendar');
          const probe = await getEventType(userEmail, args.meeting_id as string);
          if (probe?.type === 'seriesMaster') {
            logger.info('update_meeting refused on recurring seriesMaster', {
              meetingId: args.meeting_id,
              subject: probe.subject,
            });
            return {
              error: 'recurring_series_master',
              meeting_subject: probe.subject,
              message: `"${probe.subject}" is a recurring series. Updating the series here would change every occurrence — that's not safe to do automatically. The owner should update the series directly in the calendar. For a SINGLE occurrence, call update_meeting with that occurrence's meeting_id (get it from get_calendar for that specific date) — the system will create an exception for that one date only.`,
            };
          }
        } catch (err) {
          logger.warn('update_meeting recurring-preflight failed — proceeding', { err: String(err) });
        }

        // v2.9.1 — attendee add/remove path. When `add_attendees` or
        // `remove_attendees` is non-empty
        // we (a) gate colleague-path to self-only, (b) load the existing
        // event, (c) compute the new attendee list, (d) re-evaluate
        // category + location ONLY when the change is shape-affecting
        // (internal-only ↔ has-external, or count crossing 4↔5), and
        // (e) call updateMeeting with the merged shape.
        const rawAdd = (args.add_attendees as Array<{ name?: string; email?: string; optional?: boolean }> | undefined) ?? [];
        const rawRemove = (args.remove_attendees as string[] | undefined) ?? [];
        const hasAttendeeChange = rawAdd.length > 0 || rawRemove.length > 0;
        // v3.7.x (#A) — the owner is changing the venue/online-ness ("make it the
        // meeting room", "in person") WITHOUT naming an explicit venue string. We
        // recompute the venue via resolveLocation (the SAME source create uses) and
        // trust its full verdict — instead of the old apply that left the location
        // untouched (2026-07-15 "changed to meeting room but the location didn't
        // change") and stripped the Teams link. An explicit `location` string still
        // wins (venueChangeRequested is false when one is given).
        const venueChangeRequested =
          typeof args.is_online === 'boolean'
          && !(typeof args.location === 'string' && (args.location as string).trim());
        let mergedAttendees: Array<{ name?: string; email: string; optional?: boolean }> | undefined;
        let newCategoryFromShape: string | undefined;
        let newLocationFromShape: string | undefined;
        let newIsOnlineFromShape: boolean | undefined;

        if (hasAttendeeChange || venueChangeRequested) {
          const ownerFirst = context.profile.user.name.split(' ')[0];
          // v3.1.4 (Y2) — resolve name-only adds to emails from the directory
          // BEFORE the missing-email filter, via the shared resolver every
          // booking path uses. Without this, "add Eli Feldman" (no email) gets
          // dropped → attendee_missing_email → Maelle asks the colleague for an
          // email she already has on file.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { resolveAttendeeEmail } = require('../../resolveAttendeeEmails') as
            typeof import('../../resolveAttendeeEmails');
          const addList = rawAdd
            .map(a => {
              const resolved = resolveAttendeeEmail({ name: a.name, email: a.email });
              return { name: resolved.name, email: resolved.email, optional: a.optional === true };
            })
            .filter(a => a.email.includes('@'));
          const removeList = rawRemove
            .map(e => (e ?? '').trim().toLowerCase())
            .filter(e => e.includes('@'));

          if (addList.length === 0 && rawAdd.length > 0) {
            return {
              error: 'attendee_missing_email',
              meeting_subject: args.meeting_subject,
              message: `Can't add attendees without emails — at least one entry in add_attendees had no email. Pass each as { email: "...", name: "..." }.`,
            };
          }

          // v3.1.4 (Y3) — requester-controls gate (replaces the old self-only
          // gate). Owner direction: whoever REQUESTED a meeting controls it —
          // they can add anyone, rename, change location, even if they're not on
          // it. A non-requester colleague editing the owner's meeting → escalate
          // to ONE approval. The requester is resolved from the requests spine
          // via findMeetingOwner (coord bookings + the v3.1.4 colleague-booking
          // requester-link both populate it).
          if (context.senderRole === 'colleague') {
            let isRequester = false;
            try {
              const { findMeetingOwner } = await import('../../findMeetingOwner');
              const ownerInfo = await findMeetingOwner({
                ownerUserId: context.profile.user.slack_user_id,
                ownerEmail: userEmail,
                eventId: args.meeting_id as string,
              });
              isRequester = ownerInfo.requesterSlackId === context.userId;
            } catch (err) {
              logger.warn('update_meeting requester gate — findMeetingOwner threw, treating as non-requester', {
                err: String(err).slice(0, 200),
              });
            }
            if (!isRequester) {
              logger.info('update_meeting — non-requester colleague attendee change → escalate', {
                meetingId: args.meeting_id,
                requester: context.userId,
                adds: addList.map(a => a.email),
                removes: removeList,
              });
              return {
                error: 'colleague_not_requester',
                meeting_subject: args.meeting_subject,
                // (1) v3.7.x #2.1b — framing seed. NOT "only <owner> can change" (which
                // reads as "he must do it himself"): this change needs his sign-off, so
                // it's being SENT to him to approve. Requester-facing wording is #2.1a
                // (prompt chat); this is just the tool text that seeds it.
                message: `Changing who's on "${args.meeting_subject}" needs ${ownerFirst}'s sign-off, so I'll send it to him to approve. Call create_approval(kind=policy_exception) with a short ask_text (who wants to add/remove whom), and I'll apply the change the moment he approves.`,
                // (2) v3.7.x #2.1b — replay path. Stamp the update_meeting deferred_action
                // (mirrors the create_meeting rule-violation branches) so owner-approve
                // REPLAYS the exact attendee edit instead of resolving with nothing to
                // apply. The orchestrator auto-attaches this onto the policy_exception
                // payload; the resolver replays update_meeting (owner-path → the
                // requester gate is skipped → the add/remove lands). update_meeting is
                // already in RESOLVER_REPLAY_TOOLS.
                _deferred_action_hint: {
                  tool: 'update_meeting',
                  args: {
                    meeting_id: args.meeting_id,
                    meeting_subject: args.meeting_subject,
                    ...(addList.length > 0 ? { add_attendees: addList.map(a => ({ email: a.email, ...(a.name ? { name: a.name } : {}) })) } : {}),
                    ...(removeList.length > 0 ? { remove_attendees: removeList } : {}),
                  },
                },
              };
            }
          }

          // Load existing event for current attendees + shape signals.
          const { getEventForAttendeeUpdate } = await import('../../../../connectors/graph/calendar');
          const existing = await getEventForAttendeeUpdate(userEmail, args.meeting_id as string);
          if (!existing) {
            return {
              error: 'event_load_failed',
              meeting_subject: args.meeting_subject,
              message: `Couldn't load "${args.meeting_subject}" to update its attendees. The event may have been cancelled or moved.`,
            };
          }

          // Build the merged list: keep all existing not in removeList,
          // then append adds not already present. Dedupe by lowercase email.
          const removeSet = new Set(removeList);
          const merged = new Map<string, { name?: string; email: string; optional?: boolean }>();
          for (const a of existing.attendees) {
            if (removeSet.has(a.email)) continue;
            merged.set(a.email, a);
          }
          for (const a of addList) {
            if (removeSet.has(a.email)) continue;  // a remove + add in same call: removed wins
            if (!merged.has(a.email)) merged.set(a.email, a);
          }
          mergedAttendees = [...merged.values()];

          // Shape change detection — same signals resolveLocation reads:
          // (a) has-external flipped, (b) participant count crossed 4↔5.
          const ownerEmailLc = context.profile.user.email.toLowerCase();
          const ownerDomain = ownerEmailLc.includes('@') ? ownerEmailLc.split('@')[1] : '';
          const wasExternal = existing.attendees.some(a =>
            ownerDomain && a.email.endsWith('@' + ownerDomain) ? false : a.email !== ownerEmailLc
          );
          const isExternalNow = mergedAttendees.some(a =>
            ownerDomain && a.email.endsWith('@' + ownerDomain) ? false : a.email !== ownerEmailLc
          );
          // Count includes owner (resolveLocation reads total participantCount).
          const oldCount = existing.attendees.some(a => a.email === ownerEmailLc)
            ? existing.attendees.length
            : existing.attendees.length + 1;
          const newCount = mergedAttendees.some(a => a.email === ownerEmailLc)
            ? mergedAttendees.length
            : mergedAttendees.length + 1;
          const crossedThreshold = (oldCount <= 3 && newCount >= 4)
            || (oldCount >= 4 && newCount <= 3)
            || (oldCount <= 4 && newCount >= 5)
            || (oldCount >= 5 && newCount <= 4);
          const shapeChanged = (wasExternal !== isExternalNow) || crossedThreshold;

          if ((shapeChanged || venueChangeRequested) && existing.startIso) {
            logger.info('update_meeting — attendee shape changed, re-evaluating category + location', {
              meetingId: args.meeting_id,
              wasExternal, isExternalNow,
              oldCount, newCount,
            });
            try {
              const { detectCategory } = await import('../../detectCategory');
              const { resolveLocation } = await import('../../../../utils/resolveLocation');
              const catResult = await detectCategory({
                profile: context.profile,
                subject: args.meeting_subject as string,
                attendees: mergedAttendees,
                isRecurring: false,
              });
              const newCategory = catResult.category;
              const oldCategory = existing.categories[0] ?? null;

              if (newCategory && newCategory !== oldCategory) {
                newCategoryFromShape = newCategory;
              }

              // Attendee-shape change re-evaluation: intent='new_booking'
              // (NOT 'move') and omit priorStartIso so resolveLocation
              // doesn't take the preserve_existing path. With intent='move' +
              // priorStartIso and an unchanged day-type, resolveLocation
              // would short-circuit to preserve_existing and the location
              // would never be re-stamped — which lost Teams URLs on
              // home-day internal→has-external transitions. Existing-state
              // fields stay populated for downstream callers but don't
              // gate the verdict.
              const loc = resolveLocation({
                profile: context.profile,
                startIso: existing.startIso,
                intent: 'new_booking',
                category: newCategory ?? oldCategory ?? undefined,
                participantCount: newCount,
                hasExternalAttendee: isExternalNow,
                existingLocation: existing.location,
                existingIsOnline: existing.isOnline,
              });
              if (loc.kind === 'resolved') {
                if (venueChangeRequested) {
                  // Venue change → apply the FULL verdict verbatim (trust
                  // resolveLocation), NOT gated on "differs from existing": the
                  // owner is explicitly re-placing the meeting. isOnline follows the
                  // verdict (a 4+ Meeting Room always keeps Teams), never the raw
                  // is_online flag (which was the misread of "meeting room"). And the
                  // room mailbox is auto-added (optional), like the create path — so
                  // "change to meeting room" also lands meeting@… without a re-ask.
                  newLocationFromShape = loc.location;
                  newIsOnlineFromShape = loc.isOnline;
                  const roomEmail = (context.profile.meetings.room_email ?? '').toLowerCase().trim();
                  if (loc.addRoomEmail && roomEmail && mergedAttendees
                      && !mergedAttendees.some(a => a.email.toLowerCase() === roomEmail)) {
                    mergedAttendees.push({ email: roomEmail, optional: true });
                  }
                } else {
                  if (loc.location !== existing.location) newLocationFromShape = loc.location;
                  if (loc.isOnline !== existing.isOnline) newIsOnlineFromShape = loc.isOnline;
                }
              }
              // v3.4.2 (travel context) — when the meeting's day is a trip day,
              // an onsite (internal, not remote-forced) meeting's location is the
              // TRIP place, not the home day-type default (Huddle/Teams) the
              // re-eval above produced. This is the placeholder-update path —
              // adding people to a Boston-week meeting came back "Huddle" because
              // the re-eval was travel-blind. Mirrors create/move. No-op off-trip.
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getTravelContextForInstant } = require('../../../../utils/workingElsewhere') as
                  typeof import('../../../../utils/workingElsewhere');
                const tctx = getTravelContextForInstant(existing.startIso, context.profile);
                if (tctx.isAway && tctx.location && isExternalNow === false) {
                  newLocationFromShape = tctx.location;
                  newIsOnlineFromShape = false;
                  logger.info('update_meeting — trip day, location → trip place', { location: tctx.location });
                }
              } catch (err) {
                logger.warn('update_meeting — travel-context location override threw', { err: String(err).slice(0, 160) });
              }
              // preserve_existing / ask_owner / room_unavailable — leave the
              // event's location alone. Category change still applies if any.
            } catch (err) {
              logger.warn('update_meeting — shape re-evaluation threw, applying attendee change without category/location update', {
                err: String(err).slice(0, 200),
              });
            }
          }
        }

        // v3.5.x — explicit location / is_online change ("update the location to
        // The Bosworth"). Graph's updateMeeting already supports it; this exposes
        // it on the tool. An explicit arg WINS over the shape-derived location
        // (which only fires on an attendee add/remove). Both omitted → undefined →
        // the event's CURRENT location is preserved (a subject/attendee change
        // never wipes the venue).
        const explicitLocation = typeof args.location === 'string' && (args.location as string).trim()
          ? (args.location as string).trim()
          : undefined;
        const explicitIsOnline = typeof args.is_online === 'boolean' ? (args.is_online as boolean) : undefined;
        await updateMeeting({
          userEmail,
          timezone,
          meetingId:  args.meeting_id  as string,
          subject:    args.new_subject as string | undefined,  // subjects allow " - " (E1, owner direction)
          categories: args.category
            ? [args.category as string]
            : (newCategoryFromShape ? [newCategoryFromShape] : undefined),
          attendees: mergedAttendees,
          // v3.7.x (#A) — on a venue change TRUST the derived verdict (location +
          // online-ness from resolveLocation); the raw is_online flag no longer wins
          // (it was the misread), and a physical venue coexists with the Teams link.
          // Otherwise unchanged: an explicit `location` still wins, is_online=true
          // with no venue is still Teams-as-location, and omitting both preserves.
          location: venueChangeRequested
            ? (newLocationFromShape ?? (explicitIsOnline === true ? '' : undefined))
            : (explicitIsOnline === true ? '' : (explicitLocation ?? newLocationFromShape)),
          isOnline: venueChangeRequested
            ? (newIsOnlineFromShape ?? explicitIsOnline)
            : (explicitIsOnline ?? newIsOnlineFromShape),
        });
        await closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'updated',
          subject: (args.new_subject as string | undefined) ?? (args.meeting_subject as string | undefined),
          bookingThreadTs: context.threadTs,
          fulfillingRequestId: args._fulfilling_request_id as string | undefined,
        });
        auditLog({
          action: 'update_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          details: {
            subject: args.meeting_subject,
            category: args.category,
            new_subject: args.new_subject,
            added_attendees: (args.add_attendees as Array<{ email?: string }> | undefined)?.map(a => a.email).filter(Boolean),
            removed_attendees: (args.remove_attendees as string[] | undefined),
            shape_recategorized: newCategoryFromShape ?? null,
            shape_relocated: newLocationFromShape ?? null,
          },
          outcome: 'success',
        });
        const updateChanges: string[] = [];
        if (args.new_subject) updateChanges.push(`renamed to '${args.new_subject}'`);
        if (args.category) updateChanges.push(`category set to ${args.category}`);
        if (rawAdd.length > 0) {
          // v3.7.2 (#B1) — carry the EMAIL, not just a display name. A room mailbox's
          // name ("Meeting Room") reads as a VENUE, so the old summary "added Meeting
          // Room" was indistinguishable from a location change — the claim-checker
          // couldn't match it to a draft's "added meeting@…" and inverted a TRUE add
          // into "not added yet, confirm the address" (2026-07-15 Offensive Hub).
          const names = rawAdd
            .map(a => (a.email && a.name ? `${a.name} (${a.email})` : (a.email || a.name)))
            .filter(Boolean) as string[];
          updateChanges.push(`added ${names.join(', ')}`);
        }
        if (rawRemove.length > 0) {
          updateChanges.push(`removed ${rawRemove.join(', ')}`);
        }
        if (newCategoryFromShape) updateChanges.push(`category re-tagged ${newCategoryFromShape} (attendee shape changed)`);
        // v3.6.x — narrate EXPLICIT location / online changes too (not just the
        // shape-derived one), so action_summary — and therefore the claim-checker
        // — can verify a "moved to X" / "switched to online" claim instead of
        // seeing no evidence and flagging a done change as not-done. Explicit
        // wins over shape (matches the apply at updateMeeting above).
        if (explicitLocation) updateChanges.push(`location set to "${explicitLocation}"`);
        else if (newLocationFromShape !== undefined) updateChanges.push(`location updated to "${newLocationFromShape}"`);
        // v3.7.x (#A) — narrate the APPLIED online-ness, not the raw flag. On a venue
        // change the derived verdict wins (a Meeting Room keeps Teams → isOnline=true),
        // so a raw is_online=false must NOT read as "switched to in-person" — it's
        // hybrid (room + Teams), and the location line already states the venue.
        const summaryIsOnline = venueChangeRequested ? (newIsOnlineFromShape ?? explicitIsOnline) : explicitIsOnline;
        if (summaryIsOnline === false) updateChanges.push('switched to in-person');
        else if (explicitIsOnline === true) updateChanges.push('switched to online');
        return {
          success: true,
          updated: args.meeting_subject,
          category: args.category ?? newCategoryFromShape ?? null,
          new_subject: args.new_subject ?? null,
          added_attendees: rawAdd.map(a => a.email).filter(Boolean),
          removed_attendees: rawRemove,
          // v1.8.3 — past-tense summary for owner-visible reply. Issue #26 bug 1.
          action_summary: `Updated '${args.meeting_subject}'${updateChanges.length > 0 ? ': ' + updateChanges.join(', ') : ''}.`,
        };
}

export async function handleMoveMeeting(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, userEmail, timezone } = ctx;
        // v3.5.x (WE time spine) — the SAME single resolver as create_meeting (see
        // its block for the full rationale). On a WE day a BARE new_start the owner
        // typed is trip-LOCAL; a zone he named (`stated_zone`/start_timezone) wins;
        // an offset-tagged new_start is a fixed instant, left as-is. moveTripDisplay
        // is kept only for the dual-clock narration.
        let moveTripDisplay: { tz: string; location: string } | null = null;
        if (typeof args.new_start === 'string') {
          try {
            const { getTravelContextForInstant } = await import('../../../../utils/workingElsewhere');
            const travel = getTravelContextForInstant(args.new_start, context.profile);
            if (travel.isAway) moveTripDisplay = { tz: travel.effectiveTz, location: travel.location };
            const statedZone = (typeof args.stated_zone === 'string' && args.stated_zone.trim())
              ? args.stated_zone.trim()
              : (typeof args.start_timezone === 'string' && args.start_timezone.trim() ? args.start_timezone.trim() : undefined);
            const resolved = resolveStatedInstant({
              startIso: args.new_start,
              endIso: typeof args.new_end === 'string' ? args.new_end : undefined,
              statedZone, travel, homeTz: timezone,
            });
            if (resolved.reinterpreted) {
              logger.info('move_meeting — stated time resolved to canonical instant', {
                statedZone: statedZone ?? '(none)', sourceZone: resolved.sourceZone,
                newStartWas: args.new_start, newStartNow: resolved.startIso, isAway: travel.isAway,
              });
            }
            args.new_start = resolved.startIso;
            if (resolved.endIso) args.new_end = resolved.endIso;
          } catch (err) {
            logger.warn('move_meeting — WE time resolve threw, using time as-is', { err: String(err).slice(0, 160) });
          }
        }
        // #135c — pure reschedule keeps the meeting's length. When the model
        // omits new_end (it should, on a plain "move it to Thursday 11:00"),
        // derive it from the moving event's existing duration and populate
        // args.new_end HERE — early, before the colleague rule-check, the audit
        // log, and the success result all read it — so the model never has to
        // supply (or re-ask the owner for) a length it already knows. One light
        // event fetch, only on the omit path; 30-min fallback if unreadable.
        if ((typeof args.new_end !== 'string' || (args.new_end as string).length === 0) && typeof args.new_start === 'string') {
          let durMin = 30;
          try {
            const { getEventType } = await import('../../../../connectors/graph/calendar');
            const probe = await getEventType(userEmail, args.meeting_id as string);
            if (probe?.startDateTime && probe?.endDateTime) {
              const s0 = DateTime.fromISO(probe.startDateTime, { zone: timezone });
              const e0 = DateTime.fromISO(probe.endDateTime, { zone: timezone });
              if (s0.isValid && e0.isValid && e0.toMillis() > s0.toMillis()) durMin = Math.round(e0.diff(s0, 'minutes').minutes);
            }
          } catch (err) {
            logger.warn('move_meeting — duration probe threw; defaulting new_end to 30min', { err: String(err).slice(0, 160) });
          }
          args.new_end = DateTime.fromISO(args.new_start as string, { zone: timezone }).plus({ minutes: durMin }).toISO() ?? (args.new_start as string);
          logger.info('move_meeting — derived new_end from existing duration (new_end omitted)', {
            meetingId: args.meeting_id, durMin, new_end: args.new_end,
          });
        }

        // v2.2.1 — colleague-path rule-compliance gate. When an inbound colleague
        // DM asks Maelle to move an existing meeting, she can do it autonomously
        // IF the new slot fits the owner's rules (work hours, work days, buffers,
        // floating blocks, no conflicts). If the new slot breaks a rule, the tool
        // refuses and signals needs_owner_approval WITH a _deferred_action_hint —
        // Sonnet raises create_approval(kind=policy_exception), the orchestrator
        // stamps the deferred move, and owner-approve replays it. Owner-path callers
        // skip this check (owner override IS the approval).
        if (context.senderRole === 'colleague') {
          // v3.5.x — colleague-requested move gate (replaces the v3.1.4
          // requester-controls gate). Maelle organizes every meeting, so the old
          // "is the asker the REQUESTER?" test resolved to the owner ~every time
          // and escalated EVERY colleague move (Ysrael's clean 15:30→14:00 still
          // pinged the owner). Right axis: a colleague may move a meeting on their
          // own ONLY IF (1) they're a REQUIRED attendee, (2) every OTHER required
          // attendee is free at the new slot, (3) it fits the owner's rules. Else
          // escalate with the SPECIFIC reason. Owner-path skips this whole block —
          // owner override IS the approval (he can move over anyone).
          const ownerFirst = context.profile.user.name.split(' ')[0];
          const ownerEmailLc = userEmail.toLowerCase();

          // Load the meeting's REQUIRED attendees once — reused for the membership
          // check (step 1) AND the other-attendee free/busy check (step 2). Same
          // Graph helper update_meeting uses.
          let requiredAttendees: Array<{ name?: string; email: string }> = [];
          let attendeesLoaded = false;
          try {
            const { getEventForAttendeeUpdate } = await import('../../../../connectors/graph/calendar');
            const ev = await getEventForAttendeeUpdate(userEmail, args.meeting_id as string);
            if (ev) {
              requiredAttendees = (ev.attendees ?? [])
                .filter(a => !a.optional)
                .map(a => ({ name: a.name, email: a.email.toLowerCase() }));
              attendeesLoaded = true;
            }
          } catch (err) {
            logger.warn('move_meeting colleague gate — attendee load threw', { err: String(err).slice(0, 200) });
          }

          // Resolve the asker's email/name (the invite lists emails; match the
          // asker's slack_id → email via people_memory).
          let askerEmail: string | undefined;
          let askerName: string | undefined;
          try {
            const { getPersonMemory } = await import('../../../../db/people');
            const pm = getPersonMemory(context.userId);
            askerEmail = pm?.email?.toLowerCase() || undefined;
            askerName = pm?.name || undefined;
          } catch (_) { /* treated as non-member below */ }
          const askerFirst = askerName?.split(/\s+/)[0] ?? 'they';

          // Couldn't read the invite → don't guess; let the owner decide.
          if (!attendeesLoaded) {
            return {
              needs_owner_approval: true,
              reason: 'attendee_check_failed',
              meeting_subject: args.meeting_subject,
              requested_start: args.new_start,
              requested_end: args.new_end,
              message: `I couldn't read who's on "${args.meeting_subject}" to check whether ${askerFirst} can move it. Raise create_approval(kind=policy_exception) so ${ownerFirst} decides.`,
              // #2.1b / Approval-A — stamp the deferred move so owner-approve REPLAYS it
              // (policy_exception-gated auto-attach). Without this the approval applied nothing.
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
            };
          }

          // Step 1 — the asker must be a REQUIRED attendee of the meeting.
          const askerIsRequired = !!askerEmail && requiredAttendees.some(a => a.email === askerEmail);
          if (!askerIsRequired) {
            // v3.7.x (#141) — a non-attendee can still act on a meeting THEY
            // REQUESTED (booked through Maelle): route it to the owner's approval,
            // exactly like a cancel does ("if you can ask to book it, you can ask
            // to move it"). A non-attendee who did NOT request it gets a clean
            // decline — never a leak about the owner's calendar, never bothering
            // him with someone else's meeting. This is the #141 fix: move becomes
            // consistent with cancel instead of an inconsistent flat refusal.
            let askerIsRequester = false;
            try {
              const { findMeetingOwner } = await import('../../findMeetingOwner');
              const mo = await findMeetingOwner({
                ownerUserId: context.profile.user.slack_user_id,
                ownerEmail: userEmail,
                eventId: args.meeting_id as string,
              });
              askerIsRequester = !!mo.requesterSlackId && mo.requesterSlackId === context.userId;
            } catch (err) {
              logger.warn('move_meeting — requester lookup threw', { err: String(err).slice(0, 160) });
            }
            if (!askerIsRequester) {
              logger.info('move_meeting — asker is neither attendee nor requester → clean decline', {
                meetingId: args.meeting_id, asker: context.userId,
              });
              return {
                success: false,
                error: 'not_your_meeting',
                message: `That's not a meeting you're in or one you set up, so I can't move it for you — best to ask ${ownerFirst} directly.`,
              };
            }
            logger.info('move_meeting — asker is the requester (not an attendee) → escalate to owner approval', {
              meetingId: args.meeting_id, asker: context.userId,
            });
            return {
              needs_owner_approval: true,
              reason: 'requester_move_needs_owner',
              meeting_subject: args.meeting_subject,
              requested_start: args.new_start,
              requested_end: args.new_end,
              message: `${askerName ?? 'They'} asked to move "${args.meeting_subject}", which they set up with ${ownerFirst}. Raise create_approval(kind=policy_exception) so ${ownerFirst} confirms the new time.`,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
            };
          }
          // Step 1.5 — every OTHER required attendee must be INTERNAL so we can
          // actually verify their availability. An external attendee (client /
          // partner, different domain) can't be read cross-tenant — getFreeBusy
          // returns an empty (= "free all week") result for them, so step 2 would
          // pass them blindly. Moving a meeting that involves outside people is
          // high-stakes, so we never auto-move it: escalate to the owner with the
          // external attendee named.
          const ownerDomain = ownerEmailLc.includes('@') ? ownerEmailLc.split('@')[1] : '';
          const externalRequired = requiredAttendees.filter(a =>
            a.email !== ownerEmailLc
            && a.email !== askerEmail
            && (!ownerDomain || !a.email.endsWith('@' + ownerDomain)));
          if (externalRequired.length > 0) {
            const names = externalRequired.map(a => a.name?.split(/\s+/)[0] ?? a.email).join(', ');
            logger.info('move_meeting — external required attendee(s), availability unverifiable → escalate', {
              meetingId: args.meeting_id, external: externalRequired.map(a => a.email),
            });
            return {
              needs_owner_approval: true,
              reason: 'external_attendee_unverifiable',
              meeting_subject: args.meeting_subject,
              requested_start: args.new_start,
              requested_end: args.new_end,
              message: `${askerName ?? 'They'} asked to move "${args.meeting_subject}", but it has external attendee(s) whose availability I can't check (${names}) — moving a meeting with outside people needs ${ownerFirst}. Raise create_approval(kind=policy_exception) and note the external attendee(s).`,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
            };
          }

          const newStart = args.new_start as string | undefined;
          const newEnd = args.new_end as string | undefined;
          if (newStart && newEnd) {
            try {
              const startDt = DateTime.fromISO(newStart, { zone: timezone });
              const endDt = DateTime.fromISO(newEnd, { zone: timezone });
              if (startDt.isValid && endDt.isValid) {
                const durationMin = Math.max(5, Math.round((endDt.toMillis() - startDt.toMillis()) / 60_000));
                const { findAvailableSlots } = await import('../../../../connectors/graph/calendar');
                const startMs = startDt.toMillis();
                // v2.6.1 — pass exact requested window. See the parallel comment
                // in create_meeting Guard B for the full reasoning (±60s padding
                // lands the cursor outside work-hours boundaries by one minute,
                // and the slot is never tested).
                const fromIso = startDt.toUTC().toISO();
                const toIso = endDt.toUTC().toISO();
                let validSlots: Array<{ start: string }> = [];
                const diagnostics: { rejectedCounts?: Record<string, number>; rejectedExamples?: Record<string, string[]> } = {};
                // v3.5.x (step 2) — check the OTHER required attendees too: everyone
                // required EXCEPT the owner (checked via userEmail) and the asker (whose
                // own busy doesn't block their own request). attendeeCheckParams passes
                // their busy + work-hours/tz, so findAvailableSlots' diagnostics can name
                // WHO is unavailable in the escalation below (attendee_busy_collision /
                // outside_attendee_work_hours → nameForEmail).
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { attendeeCheckParams } = require('../../../../utils/attendeeAvailability') as typeof import('../../../../utils/attendeeAvailability');
                const moveCheckAttendees = requiredAttendees
                  .map(a => a.email)
                  .filter(e => e !== ownerEmailLc && e !== askerEmail);
                if (fromIso && toIso) {
                  validSlots = await findAvailableSlots({
                    userEmail,
                    timezone,
                    durationMinutes: durationMin,
                    ...attendeeCheckParams(moveCheckAttendees, userEmail),
                    searchFrom: fromIso,
                    searchTo: toIso,
                    profile: context.profile,
                    // v2.6 — pass category so move_meeting colleague-path also
                    // enforces day_type / per_day / per_week limits at
                    // the destination. The destination day's count excludes
                    // the event being moved (it's leaving its current day);
                    // findAvailableSlots widens its event fetch when
                    // category is set so day/week counts are accurate.
                    category: args.category as string | undefined,
                    diagnosticsOut: diagnostics,
                    // v3.0.6 — single-slot validation; see the parallel comment
                    // in create_meeting Guard B. Auto-expand would re-query the
                    // calendar at widening ranges for slots that get discarded
                    // (matches checks ±60s of newStart). Disable.
                    autoExpand: false,
                  });
                }
                const matches = validSlots.some(s => Math.abs(DateTime.fromISO(s.start).toMillis() - startMs) <= 60_000);
                if (!matches) {
                  // Surface the SPECIFIC blocker (step 2 vs step 3) so the
                  // approval tells the owner — and, downstream, the requester —
                  // exactly why. Attendee-scoped diagnostic keys
                  // (`attendee_busy_collision:<email>` /
                  // `outside_attendee_work_hours:<email>`) name the person; the
                  // rest are owner-rule violations. (ownerFirst from the gate above.)
                  const labelFor = (reason: string | undefined): string => {
                    switch (reason) {
                      case 'outside_owner_work_hours': return `outside ${ownerFirst}'s work hours`;
                      case 'owner_busy_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
                      // legacy label name kept as alias in case any older diagnostics path still emits it
                      case 'owner_busy_or_buffer_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
                      case 'overlaps_meeting_being_moved': return `overlaps the meeting being moved`;
                      case 'focus_time_office': return `would leave ${ownerFirst} under the free-time floor (office day)`;
                      case 'focus_time_home': return `would leave ${ownerFirst} under the free-time floor (home day)`;
                      case 'floating_block_no_room': return `would leave no room for one of ${ownerFirst}'s daily blocks (lunch / break / etc.)`;
                      case 'category_day_type': return `wrong day type for this category (e.g. office-only category on a home day)`;
                      case 'category_per_day': return `over ${ownerFirst}'s per-day limit for this category`;
                      case 'category_per_week': return `over ${ownerFirst}'s per-week limit for this category`;
                      default: return 'unknown';
                    }
                  };
                  const nameForEmail = (em: string): string =>
                    requiredAttendees.find(a => a.email === em.toLowerCase())?.name?.split(/\s+/)[0] ?? 'another attendee';
                  const counts = diagnostics.rejectedCounts ?? {};
                  const fired = Object.keys(counts);
                  const brokenRule = fired[0];
                  let reasonCode: string;
                  let humanReason: string;
                  if (brokenRule && brokenRule.startsWith('attendee_busy_collision')) {
                    reasonCode = 'attendee_unavailable';
                    humanReason = `${nameForEmail(brokenRule.split(':')[1] ?? '')} isn't free then`;
                  } else if (brokenRule && brokenRule.startsWith('outside_attendee_work_hours')) {
                    reasonCode = 'attendee_unavailable';
                    humanReason = `it's outside ${nameForEmail(brokenRule.split(':')[1] ?? '')}'s working hours`;
                  } else {
                    reasonCode = 'not_rule_compliant';
                    humanReason = labelFor(brokenRule);
                  }
                  logger.info('move_meeting colleague-path refused — new slot blocked', {
                    meetingId: args.meeting_id, newStart, newEnd, requester: context.userId,
                    broken_rule: brokenRule ?? 'unknown', reason_code: reasonCode, human_reason: humanReason,
                  });
                  return {
                    needs_owner_approval: true,
                    reason: reasonCode,
                    broken_rule: brokenRule ?? 'unknown',
                    broken_rule_label: humanReason,
                    meeting_subject: args.meeting_subject,
                    requested_start: newStart,
                    requested_end: newEnd,
                    message: humanReason === 'unknown'
                      ? `${askerName ?? 'They'} asked to move "${args.meeting_subject}" to that time, but it doesn't pass ${ownerFirst}'s scheduling rules and I can't tell which one. Call create_approval(kind=policy_exception) and let him decide.`
                      : `${askerName ?? 'They'} asked to move "${args.meeting_subject}" to that time, but ${humanReason}. I can't do it on my own — call create_approval(kind=policy_exception) and pass "${humanReason}" in ask_text so ${ownerFirst} knows what he's deciding.`,
                    _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
                  };
                }
              }
            } catch (err) {
              logger.warn('move_meeting colleague-path rule check threw — escalating to approval', { err: String(err) });
              return {
                needs_owner_approval: true,
                reason: 'rule_check_failed',
                meeting_subject: args.meeting_subject,
                requested_start: newStart,
                requested_end: newEnd,
                message: `I couldn't verify whether that slot fits ${context.profile.user.name.split(' ')[0]}'s rules right now. Raise create_approval(kind=policy_exception) so he can decide.`,
                _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              };
            }
          }
        }

        // v2.1.4 — same attendee-only guard as update_meeting.
        // v2.7.0 — ownership check via findMeetingOwner (requests + Graph).
        // Per D4: when owner isn't organizer, refuse politely. No DM, no
        // propose-reschedule — just tell the asker it's not the owner's to move.
        try {
          const { findMeetingOwner } = await import('../../findMeetingOwner');
          const ownerInfo = await findMeetingOwner({
            ownerUserId: context.profile.user.slack_user_id,
            ownerEmail: userEmail,
            eventId: args.meeting_id as string,
          });
          if (!ownerInfo.ownerIsOrganizer && ownerInfo.organizerEmail) {
            const ownerFirst = context.profile.user.name.split(' ')[0];
            const orgName = ownerInfo.organizerName ?? ownerInfo.organizerEmail;
            logger.info('move_meeting refused — owner is attendee, not organizer', {
              meetingId: args.meeting_id, organizer: ownerInfo.organizerEmail,
            });
            return {
              error: 'not_organizer',
              meeting_subject: args.meeting_subject,
              organizer_name: orgName,
              organizer_email: ownerInfo.organizerEmail,
              message: `Can't move "${args.meeting_subject}" — ${orgName} organized that one, not ${ownerFirst}. The organizer is the only one who can shift the time. Want me to flag it to ${ownerFirst} so he can ping them, or skip?`,
            };
          }
        } catch (err) {
          logger.warn('move_meeting ownership lookup threw — proceeding', { err: String(err) });
        }

        // v1.8.8 — same series-master block as update_meeting. Moving a
        // seriesMaster would shift every occurrence in the series. Single
        // occurrence moves (type='occurrence' or 'exception') are allowed; Graph
        // creates an exception pinning just that date.
        // v3.1.8 — capture the meeting's OLD start so the success result can
        // report the VACATED slot (the time that just opened up). Lets a
        // follow-up "move X into the freed slot" resolve without Maelle
        // re-asking what time the moved meeting used to be at.
        let preMoveStartIso: string | undefined;
        try {
          const { getEventType } = await import('../../../../connectors/graph/calendar');
          const probe = await getEventType(userEmail, args.meeting_id as string);
          if (probe?.type === 'seriesMaster') {
            logger.info('move_meeting refused on recurring seriesMaster', {
              meetingId: args.meeting_id,
              subject: probe.subject,
            });
            return {
              error: 'recurring_series_master',
              meeting_subject: probe.subject,
              message: `"${probe.subject}" is a recurring series. Moving the series here would shift every occurrence — the owner should do series-level moves directly in the calendar. For a SINGLE occurrence, call move_meeting with that occurrence's meeting_id from get_calendar for that specific date; Graph will create an exception for that one.`,
            };
          }
          preMoveStartIso = probe?.startDateTime;
        } catch (err) {
          logger.warn('move_meeting recurring-preflight failed — proceeding', { err: String(err) });
        }

        // v2.3.1 (B1 / #61) — deterministic floating-block alignment. When the
        // meeting being moved is a floating block (lunch, coffee, etc.), don't
        // trust args.new_start verbatim — Sonnet keeps doing time math in
        // chat and getting it wrong (window check, buffer, alignment). Run
        // findAlignedSlotForBlock with args.new_start as a HINT to compute
        // the correct slot; if no in-window slot fits, refuse with a clear
        // pointer to policy_exception (deferred_action move_meeting). Owner-
        // directed moves no longer ask permission for in-window adjustments
        // — code computes the right answer once.
        // #135b — weekday/date sanity (shared with create_meeting). Refuse a move
        // whose resolved new_start weekday contradicts the weekday the owner named
        // ("return it to Thursday" that resolved to a Friday — the F2 wrong-day
        // write), handing back the corrected same-week date to retry with.
        {
          const wk = checkIntendedWeekday(args.new_start as string | undefined, args.intended_weekday as number | undefined, timezone);
          if (!wk.ok) {
            const namedName = DateTime.fromISO(wk.correctedStartIso, { zone: timezone }).toFormat('EEEE');
            const resolvedName = DateTime.fromISO(args.new_start as string, { zone: timezone }).toFormat('EEEE');
            const correctedDate = DateTime.fromISO(wk.correctedStartIso, { zone: timezone }).toFormat('yyyy-MM-dd');
            logger.warn('move_meeting — weekday/date mismatch, refusing wrong-day write', {
              namedWeekday: wk.namedWeekday, resolved: wk.resolvedDate, corrected: wk.correctedStartIso,
            });
            return {
              success: false,
              error: 'weekday_date_mismatch',
              meeting_subject: args.meeting_subject,
              corrected_start: wk.correctedStartIso,
              message: `new_start resolves to ${wk.resolvedDate} (a ${resolvedName}), but this was described as a ${namedName}. The ${namedName} of that week is ${correctedDate}. Re-issue move_meeting with new_start=${wk.correctedStartIso} (same time, corrected day). If a DIFFERENT week was actually meant, resolve the right ${namedName} from the date list and retry — never move to the mismatched day.`,
            };
          }
        }

        let effectiveStart = args.new_start as string;
        let effectiveEnd   = args.new_end   as string;
        // v3.x — grid-align an off-grid move target to the :00/:15/:30/:45 grid
        // unless the owner named the exact time. Floating blocks are realigned
        // by findAlignedSlotForBlock below, so this only affects the regular
        // (non-floating) move fall-through.
        if (!args.start_is_explicit && typeof effectiveStart === 'string') {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { alignNearestQuarter } = require('../../../../utils/floatingBlocks') as typeof import('../../../../utils/floatingBlocks');
          const sDt = DateTime.fromISO(effectiveStart, { zone: timezone });
          if (sDt.isValid) {
            const alignedMs = alignNearestQuarter(sDt.toMillis(), timezone);
            if (alignedMs !== sDt.toMillis()) {
              const delta = alignedMs - sDt.toMillis();
              effectiveStart = DateTime.fromMillis(alignedMs, { zone: timezone }).toISO() ?? effectiveStart;
              const eDt = DateTime.fromISO(effectiveEnd, { zone: timezone });
              if (eDt.isValid) effectiveEnd = DateTime.fromMillis(eDt.toMillis() + delta, { zone: timezone }).toISO() ?? effectiveEnd;
              logger.info('move_meeting — snapped off-grid start to quarter grid', { from: sDt.toISO(), to: effectiveStart });
            }
          }
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fb = require('../../../../utils/floatingBlocks') as typeof import('../../../../utils/floatingBlocks');
          const blocks = fb.getFloatingBlocks(context.profile);
          // Identify whether the meeting being moved is a floating block. We
          // need its current event to match against blocks. Cheap probe via
          // the day's events using args.new_start as the day target.
          const newStartDt = DateTime.fromISO(args.new_start as string, { zone: timezone });
          if (newStartDt.isValid) {
            const dayStr = newStartDt.toFormat('yyyy-MM-dd');
            const dayEvents = await getCalendarEvents(userEmail, dayStr, dayStr, timezone);
            const movingEvent = dayEvents.find(e => e.id === args.meeting_id);
            const matchedBlock = movingEvent ? blocks.find(b => fb.isFloatingBlockEvent(movingEvent, b)) : null;
            if (matchedBlock) {
              // v3.4.2 (E1) — preserve the MOVING EVENT's own duration. Pre-fix
              // a move re-derived the end from the block CONFIG (duration_minutes,
              // e.g. 25), so moving an owner-stretched 40-min lunch silently reset
              // it to 25. Read the event's actual span; fall back to config only
              // if the event's times don't parse. effectiveBlock carries it so the
              // placement search (findAlignedSlotForBlock) also sizes for the real
              // duration.
              const movingDurationMin = (() => {
                try {
                  const s = DateTime.fromISO(movingEvent!.start.dateTime, { zone: movingEvent!.start.timeZone ?? 'utc' });
                  const e = DateTime.fromISO(movingEvent!.end.dateTime, { zone: movingEvent!.end.timeZone ?? 'utc' });
                  if (s.isValid && e.isValid && e.toMillis() > s.toMillis()) {
                    return Math.round(e.diff(s, 'minutes').minutes);
                  }
                } catch { /* fall through to config */ }
                return matchedBlock.duration_minutes;
              })();
              const effectiveBlock = movingDurationMin !== matchedBlock.duration_minutes
                ? { ...matchedBlock, duration_minutes: movingDurationMin }
                : matchedBlock;
              // Build the busy-window list for findAlignedSlotForBlock.
              // Exclude the floating block itself (it's about to move).
              const wStart = fb.windowMsForDay(dayStr, matchedBlock.preferred_start, timezone);
              const wEnd   = fb.windowMsForDay(dayStr, matchedBlock.preferred_end,   timezone);
              const busy = dayEvents
                .filter(e => e.id !== args.meeting_id && !e.isCancelled && e.showAs !== 'free')
                .map(e => ({
                  start: DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? 'utc' }).toMillis(),
                  end:   DateTime.fromISO(e.end.dateTime,   { zone: e.end.timeZone   ?? 'utc' }).toMillis(),
                }))
                .filter(b => b.end > wStart && b.start < wEnd)
                .map(b => ({ start: Math.max(b.start, wStart), end: Math.min(b.end, wEnd) }));
              // v3.0.2 — floating-block math is buffer-free; meeting durations carry the spacing.

              // v2.3.2 (3A) — owner-explicit hint respects target as-is. Don't
              // snap to a different slot, don't refuse on conflict. Out-of-window
              // is NOT refused either: owner override is total and one-step
              // (rules 1, 6, 11) — moving his own lunch to 16:00 is his call, so
              // we move it and add a heads-up rather than bouncing for a
              // confirm_outside_window re-ask.
              const isOwnerPath = context.senderRole === 'owner' || context.isOwnerInGroup === true;
              if (isOwnerPath) {
                // v3.1.8 (D5) — snap the hint to the quarter grid. The general
                // snap above is bypassed on the floating-block path because this
                // branch overwrites effectiveStart with the raw hint, so a "right
                // after" landing at :40 would book lunch at :40 instead of the
                // owner's quarter convention (:45). Redo the snap here; honor an
                // exact owner-given time (start_is_explicit) as-is.
                const alignedMs = args.start_is_explicit
                  ? newStartDt.toMillis()
                  : fb.alignNearestQuarter(newStartDt.toMillis(), timezone);
                const hintStartDt = DateTime.fromMillis(alignedMs, { zone: timezone });
                const hintStartMs = hintStartDt.toMillis();
                const hintEndMs = hintStartMs + movingDurationMin * 60 * 1000;
                const inWindow = hintStartMs >= wStart && hintEndMs <= wEnd;
                effectiveStart = hintStartDt.toISO()!;
                effectiveEnd = hintStartDt
                  .plus({ minutes: movingDurationMin })
                  .toISO()!;
                logger.info(inWindow
                  ? 'move_meeting (owner) — floating block in-window, using hint as-is'
                  : 'move_meeting (owner) — floating block out-of-window, one-step owner override', {
                  meetingId: args.meeting_id, block: matchedBlock.name, hint: args.new_start,
                  window: `${matchedBlock.preferred_start}-${matchedBlock.preferred_end}`,
                  outOfWindow: !inWindow,
                });
                const windowNote = inWindow
                  ? ''
                  : ` (outside its usual ${matchedBlock.preferred_start}–${matchedBlock.preferred_end} window — moved as asked).`;
                // Skip the colleague-path findAlignedSlotForBlock branch below.
                return await updateMeeting({
                  userEmail, timezone,
                  meetingId: args.meeting_id as string,
                  start: effectiveStart, end: effectiveEnd,
                }).then(async () => {
                  await closeMeetingArtifacts({
                    ownerUserId: context.profile.user.slack_user_id,
                    meetingId: args.meeting_id as string,
                    reason: 'moved',
                    subject: args.meeting_subject as string | undefined,
                    bookingThreadTs: context.threadTs,
                    fulfillingRequestId: args._fulfilling_request_id as string | undefined,
                  });
                  // v3.2.1 (#120 / 120b) — return the vacated slot here too. The
                  // floating-block move (e.g. lunch) is exactly the case where
                  // the owner moves a block to FREE its slot for another meeting;
                  // without this the freed-slot info was dropped.
                  const vacated = computeVacatedSlot(preMoveStartIso, effectiveStart, effectiveEnd, timezone);
                  return {
                    success: true,
                    action_summary: `Moved ${matchedBlock.name} to ${formatIsoTime(effectiveStart)}.${windowNote}`,
                    // #1.5 — surface the POST-snap booked instant on the floating-block
                    // owner-move path too (lunch is the canonical case). Without it
                    // mutationActions falls back to the pre-snap input arg and the reply
                    // narrates a time the block never landed on (the 11:10-vs-11:15 bug).
                    booked_start: effectiveStart,
                    booked_end: effectiveEnd,
                    ...(vacated ? { vacated } : {}),
                  };
                });
              }

              // Colleague-path — keep existing alignment + conflict guard.
              const alignedMs = fb.findAlignedSlotForBlock(effectiveBlock, dayStr, timezone, busy);
              if (alignedMs === null) {
                logger.info('move_meeting refused — no in-window slot for floating block', {
                  meetingId: args.meeting_id, block: matchedBlock.name, hint: args.new_start,
                });
                return {
                  success: false,
                  error: 'no_in_window_slot',
                  message: `No room in the ${matchedBlock.preferred_start}–${matchedBlock.preferred_end} window for ${matchedBlock.name} after that hint. To move it OUTSIDE the window, raise create_approval(kind='policy_exception') with deferred_action={ tool: 'move_meeting', args: { meeting_id, new_start, confirm_outside_window: true } }.`,
                };
              }
              const alignedDt = DateTime.fromMillis(alignedMs).setZone(timezone);
              const alignedEndDt = alignedDt.plus({ minutes: movingDurationMin });
              const alignedStartIso = alignedDt.toISO()!;
              const alignedEndIso   = alignedEndDt.toISO()!;
              if (alignedStartIso !== effectiveStart) {
                logger.info('move_meeting — floating block snapped to aligned slot', {
                  meetingId: args.meeting_id, block: matchedBlock.name,
                  hint: args.new_start, snapped: alignedStartIso,
                });
              }
              effectiveStart = alignedStartIso;
              effectiveEnd   = alignedEndIso;
            }
          }
        } catch (err) {
          logger.warn('move_meeting floating-block alignment threw — proceeding with caller args', {
            err: String(err).slice(0, 200),
          });
        }

        // v2.7.0 — route the move through planMeeting so location + category
        // re-resolve when the day-type flips (office↔home). Per Q2: only
        // re-detect category when location-relevant attributes change; same-
        // day-type moves keep the existing category. resolveLocation always
        // runs so the Graph PATCH can update location + isOnline.
        let movePlanLocation: string | undefined;
        let movePlanIsOnline: boolean | undefined;
        let movePlanCategories: string[] | undefined;
        let movePlanPreserveExisting = false;
        let movePlanOverrideNotice: string | undefined;   // #A — attendee-busy heads-up, surfaced on the move result
        try {
          const { planMeeting: planMove } = await import('../../planMeeting');
          // #B (2026-07-19) — fetch the moving event BY ID, not via a ±1-day window
          // around the DESTINATION. A >1-day move never found the source event in that
          // window → movingEvent=undefined → empty participants + no priorStart →
          // planMeeting re-detected the category from the owner alone (Meeting →
          // Logistic) and cleared the location ("Intro with Maya", Mon→Thu). The by-id
          // fetch returns the exact shape at any distance (and gives fix A its attendees).
          const { getEventForAttendeeUpdate } = await import('../../../../connectors/graph/calendar');
          const movingEvent = await getEventForAttendeeUpdate(userEmail, args.meeting_id as string);
          const priorStartIso = movingEvent?.startIso;
          // v2.8.5 — prior END lets planMeeting's freebusy overlap exclude the source
          // event when an attendee's calendar still shows it (a 13:00→13:15 nudge
          // otherwise trips confirm_override on the very meeting being moved).
          const priorEndIso = movingEvent?.endIso;
          const existingCats = movingEvent?.categories ?? [];
          const existingLocation = movingEvent?.location;
          const existingIsOnline = movingEvent?.isOnline;
          const moveAttendees = movingEvent?.attendees ?? [];
          const movePlan = await planMove({
            profile: context.profile,
            intent: 'move',
            initiator: context.senderRole === 'colleague' ? 'colleague' : 'owner',
            initiatorSlackId: context.userId,
            slotStartIso: effectiveStart,
            slotEndIso: effectiveEnd,
            subject: args.meeting_subject as string | undefined,
            participants: moveAttendees.map(a => ({
              email: a.email,
              name: a.name,
            })),
            existingEventId: args.meeting_id as string,
            existingEventCategories: existingCats,
            existingEventLocation: existingLocation,
            existingEventIsOnline: existingIsOnline,
            priorSlotStartIso: priorStartIso,
            priorSlotEndIso: priorEndIso,
            // v2.8.2 — owner-explicit hints flow through on move too. Without
            // these, an owner-explicit "move it to 3pm in person" loses the
            // physical signal and resolveLocation defaults to day-type rules.
            locationHint: args.location as string | undefined,
            isOnlineHint: typeof args.is_online === 'boolean' ? args.is_online : undefined,
            allowRelaxed: args.relaxed === true,
          });
          logger.info('move_meeting — planMeeting verdict', {
            action: movePlan.action, meetingId: args.meeting_id,
            priorStart: priorStartIso, newStart: effectiveStart,
            reasoning: 'reasoning' in movePlan ? movePlan.reasoning : undefined,
          });
          // v3.2.x (#8) — colleague reschedule onto a soft-rule-breaking slot:
          // offer nearby rule-compliant alternatives before escalating.
          if (movePlan.action === 'propose_alternative') {
            return {
              success: false,
              error: 'soft_rule_offer_alternatives',
              meeting_subject: args.meeting_subject,
              violation_label: movePlan.violationLabel,
              alternatives: movePlan.alternatives,
              suggested_ask_text: movePlan.suggestedAskText,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: 'The requested new time breaks one of the owner\'s soft rules. Do NOT escalate yet. Offer these nearby rule-compliant slots (2 on the requested day + 1 after) and ask if one works. If the colleague INSISTS on the original time, or none of these work, THEN call create_approval(kind=policy_exception) with suggested_ask_text so the owner decides.',
            };
          }
          if (movePlan.action === 'confirm_override' || movePlan.action === 'escalate_approval') {
            return {
              success: false,
              error: 'rule_violation',
              meeting_subject: args.meeting_subject,
              violation_label: movePlan.violationLabel,
              suggested_ask_text: movePlan.suggestedAskText,
              category: movePlan.category,
              // v2.7.2 — deferred_action_hint for resolver replay on approve.
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: movePlan.action === 'escalate_approval'
                ? 'Move violates a scheduling rule. Use create_approval(kind=policy_exception) with suggested_ask_text.'
                // v3.2.1 (#120a — one mechanism) — owner-path soft-rule override
                // flows through the SAME persisted approval path as the colleague
                // escalate, instead of the fragile "ask, then re-issue relaxed
                // next turn" path (Sonnet can drop that re-issue → the meeting
                // silently never moves). If the owner ALREADY authorized the
                // override in THIS message, retry move_meeting now with
                // relaxed=true. OTHERWISE call
                // create_approval(kind=policy_exception) — the orchestrator
                // stamps the deferred move, so the override PERSISTS and the
                // owner's later "yes" replays it deterministically.
                : 'Move violates a soft scheduling rule. If the owner ALREADY authorized overriding it in THIS message (e.g. "do it anyway", "I\'ll handle the conflict"), retry move_meeting now with relaxed=true. Otherwise call create_approval(kind=policy_exception) with suggested_ask_text — this PERSISTS the override (the orchestrator stamps the deferred move) so the owner\'s later "yes" replays it on its own. Do NOT ask and then rely on re-issuing the move yourself next turn — that pending action gets lost.',
            };
          }
          // v2.8.2 — ask_location_mode on move (rare — external attendee,
          // same/unknown TZ, and the move flips into office day). Refuse +
          // surface the ask.
          if (movePlan.action === 'ask_location_mode') {
            return {
              success: false,
              error: 'location_mode_unspecified',
              meeting_subject: args.meeting_subject,
              suggested_ask_text: movePlan.suggestedAskText,
              category: movePlan.category,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: 'Move lands on an office day with external attendee in same/unknown timezone. Ask the owner online vs physical, then re-call move_meeting with either is_online=true or location=<full office address>.',
            };
          }
          // v2.8.2 — meeting room busy + ≥6 people on the move target slot.
          if (movePlan.action === 'room_unavailable_large') {
            return {
              success: false,
              error: 'meeting_room_unavailable_large_meeting',
              meeting_subject: args.meeting_subject,
              suggested_ask_text: movePlan.suggestedAskText,
              category: movePlan.category,
              _deferred_action_hint: { tool: 'move_meeting', args: { ...args } },
              _note: 'Move target time has the Meeting Room taken and the group is too large for the small-room fallback. Ask the owner whether to push the time, trim attendees, or pick another day.',
            };
          }
          if (movePlan.action === 'book') {
            movePlanPreserveExisting = movePlan.preserveExisting === true;
            movePlanOverrideNotice = movePlan.overrideNotice;   // #A — "who's busy" heads-up, surfaced on the result below
            // (v2.8.2) preserveExisting: leave location/isOnline undefined so the
            // Graph PATCH doesn't touch them. Re-stamping the BiWeekly's "Huddle"
            // with the office address on every move is exactly what we're killing.
            if (!movePlanPreserveExisting) {
              movePlanLocation = movePlan.location;
              movePlanIsOnline = movePlan.isOnline;
            }
            if (movePlan.category) {
              // Preserve any non-yaml-category labels already on the event
              // (rare but possible), then add the canonical category once.
              const profileCatNames = new Set((context.profile.categories ?? []).map(c => c.name.toLowerCase()));
              const preserved = existingCats.filter(c => !profileCatNames.has(c.toLowerCase()));
              movePlanCategories = [...preserved, movePlan.category];
            }
          }
        } catch (err) {
          logger.warn('move_meeting — planMeeting threw, proceeding with time-only move', {
            err: String(err).slice(0, 200), meetingId: args.meeting_id,
          });
        }

        // #30 — hold-conflict gate on MOVE (mirror of the create gate). Never
        // move a meeting onto a slot tentatively held for SOMEONE ELSE. Owner →
        // confirm once (override_hold:true on retry → move + release + DM holder).
        // Colleague → route to the owner's approval. The mover's OWN hold proceeds.
        {
          const { getActiveHoldOverlapping } = await import('../../../../db/slotHolds');
          const conflictHold = getActiveHoldOverlapping(
            context.profile.user.slack_user_id, effectiveStart, effectiveEnd,
          );
          if (conflictHold && conflictHold.holder_slack_id !== context.userId) {
            if (context.senderRole === 'owner') {
              if (args.override_hold !== true) {
                return {
                  success: false,
                  error: 'slot_on_hold',
                  meeting_subject: args.meeting_subject,
                  hold_id: conflictHold.id,
                  holder_name: conflictHold.holder_name,
                  message: `${conflictHold.holder_name} asked to reserve ${formatIsoTime(effectiveStart)}${conflictHold.reason ? ` (${conflictHold.reason})` : ''}. Move "${args.meeting_subject}" over it anyway? On your yes I'll move it and let ${conflictHold.holder_name} know the hold was released.`,
                  _deferred_action_hint: { tool: 'move_meeting', args: { ...args, override_hold: true } },
                  _note: 'Surface to the owner. If he says move it anyway, retry move_meeting with override_hold:true — that moves it, releases the hold, and DMs the holder.',
                };
              }
              // owner + override_hold:true → fall through and move; release fires on success.
            } else {
              return {
                success: false,
                error: 'slot_held_needs_owner_approval',
                meeting_subject: args.meeting_subject,
                hold_id: conflictHold.id,
                message: `That time is tentatively held for someone else — don't move it there, and don't reveal who holds it. Raise create_approval(kind=policy_exception) with this slot so ${context.profile.user.name.split(' ')[0]} decides; tell the colleague warmly you're checking.`,
              };
            }
          }
        }

        await updateMeeting({
          userEmail,
          timezone,
          meetingId: args.meeting_id as string,
          start: effectiveStart,
          end: effectiveEnd,
          // v2.7.0 — pass-through location/isOnline/categories from the
          // planMeeting verdict. Undefined values leave the existing fields
          // untouched on Graph's side. v2.8.2 — preserveExisting keeps both
          // undefined so a move within the same day-type doesn't overwrite owner
          // conventions like "Huddle".
          location: movePlanLocation,
          isOnline: movePlanIsOnline,
          categories: movePlanCategories,
        });

        // v3.6.x — the post-move Teams-URL-as-location patch was REMOVED (same
        // root as the create path): overwriting the online meeting's location with
        // the raw joinUrl broke Outlook's native Teams rendering. isOnlineMeeting
        // stays true through the move, so Graph keeps the toggle / Join button /
        // "Microsoft Teams Meeting" label — nothing to stamp.

        // v2.2.5 (#54) — post-move verification. Graph PATCH can return 200 OK
        // without the change landing (sync delays, race conditions). Re-read
        // the event by id and confirm the start matches the requested move
        // target. Fail-fast: if verify fails, skip the closeMeetingArtifacts
        // cascade, audit success log, shadow notify, and rebalance — none of
        // those should fire on a move that didn't actually happen.
        {
          const { verifyEventMoved } = await import('../../../../connectors/graph/calendar');
          // v2.3.1 (B1) — verify against the EFFECTIVE start (post-snap for
          // floating blocks), not the original args.new_start hint.
          const verify = await verifyEventMoved(userEmail, args.meeting_id as string, effectiveStart, timezone);
          if (!verify.ok) {
            logger.warn('move_meeting verify failed — Graph accepted PATCH but readback drifted', {
              meetingId: args.meeting_id, reason: verify.reason,
              expected: 'expected' in verify ? verify.expected : undefined,
              got: 'got' in verify ? verify.got : undefined,
            });
            const subject = args.meeting_subject as string;
            const message = verify.reason === 'not_found'
              ? `I tried to move '${subject}' but couldn't find it on the calendar afterward — the move may not have landed. Want me to investigate?`
              : `I tried to move '${subject}' to ${verify.expected} but the calendar still shows it at ${verify.got}. Graph accepted the change but didn't apply it — want me to retry?`;
            return {
              success: false,
              error: verify.reason === 'not_found' ? 'moved_but_missing' : 'move_did_not_land',
              message,
            };
          }
        }

        await closeMeetingArtifacts({
          ownerUserId: context.profile.user.slack_user_id,
          meetingId: args.meeting_id as string,
          reason: 'moved',
          subject: args.meeting_subject as string | undefined,
          bookingThreadTs: context.threadTs,
          fulfillingRequestId: args._fulfilling_request_id as string | undefined,
        });
        // #30 — the move landed on this slot, so release any hold overlapping it
        // (overlap, not exact-start: a move target may not begin exactly at the
        // held slot). If held by someone ELSE (owner moved over it via
        // override_hold), DM that holder; the mover's own hold releases silently.
        try {
          const sh = await import('../../../../db/slotHolds');
          const overlapHold = sh.getActiveHoldOverlapping(
            context.profile.user.slack_user_id, effectiveStart, effectiveEnd,
          );
          if (overlapHold) {
            sh.releaseSlotHold(overlapHold.id, 'slot_taken_by_move');
            if (overlapHold.holder_slack_id && overlapHold.holder_slack_id !== context.userId) {
              try {
                const { getConnection } = await import('../../../../connections/registry');
                const conn = getConnection(context.profile.user.slack_user_id, 'slack');
                if (conn) {
                  await conn.sendDirect(
                    overlapHold.holder_slack_id,
                    `Quick heads up — ${context.profile.user.name.split(' ')[0]} ended up taking ${formatIsoTime(effectiveStart)}, so I've released the hold I had for you there. Happy to find you another time whenever.`,
                    overlapHold.origin_thread_ts ? { threadTs: overlapHold.origin_thread_ts } : undefined,
                  );
                }
              } catch (dmErr) {
                logger.warn('move_meeting — hold-release DM failed (hold already released)', { err: String(dmErr).slice(0, 150) });
              }
            }
          }
        } catch (err) {
          logger.warn('move_meeting — slot-hold release threw, continuing', { err: String(err).slice(0, 150) });
        }
        auditLog({
          action: 'move_meeting',
          source: context.channel,
          actor: context.userId,
          target: args.meeting_id as string,
          details: { subject: args.meeting_subject, new_start: args.new_start, new_end: args.new_end },
          outcome: 'success',
        });

        // v2.2.1 — colleague-path inbound reschedule: shadow-DM the owner so he
        // sees the move happen even when he wasn't in the approval loop.
        // v2.3.2 — threaded under the colleague conversation key so all
        // shadows from this thread group together in the owner's DM.
        // Skip the OWNER clamped to colleague-context in an MPIM/channel — he
        // moved it himself and was present; no self-shadow.
        if (context.senderRole === 'colleague' && context.userId !== context.profile.user.slack_user_id) {
          try {
            const { shadowNotify } = await import('../../../../utils/shadowNotify');
            const { getPersonMemory } = await import('../../../../db');
            const requesterRow = getPersonMemory(context.userId);
            const requesterName = requesterRow?.name ?? 'a colleague';
            const whenLocal = DateTime.fromISO(args.new_start as string, { zone: timezone });
            const whenLabel = whenLocal.isValid
              ? whenLocal.toFormat('EEE d MMM HH:mm')
              : formatIsoTime(args.new_start as string);
            await shadowNotify(context.profile, {
              channel: context.channelId,
              threadTs: context.threadTs,
              action: 'Reschedule auto-accepted',
              detail: `${requesterName} asked to move "${args.meeting_subject}" — rule-compliant, moved to ${whenLabel}.`,
              conversationKey: context.threadTs,
              conversationHeader: `Conversation with ${requesterName}`,
            });
          } catch (err) {
            logger.warn('shadowNotify after colleague reschedule failed — continuing', { err: String(err) });
          }
        }

        // v2.2.3 (scenario 8 row 7) — post-mutation floating-block rebalance.
        // The new meeting time may have landed on top of lunch (or any
        // configured floating block). Try to slide the block elsewhere in its
        // window. If no in-window slot fits, leave it overlapping and ping
        // the owner (the bumping-out-of-window decision still belongs to him,
        // via the policy_exception approval flow).
        // v3.1.8 — the VACATED slot (where the meeting WAS) lets a follow-up
        // "move X into the freed slot" resolve from this turn instead of Maelle
        // re-asking the old time. v3.2.1 — shared helper (see top of file); the
        // floating-block early return uses the same one. Computed BEFORE the
        // rebalance so it can gate reclaim detection to the slot this move
        // actually freed.
        const vacated = computeVacatedSlot(preMoveStartIso, args.new_start as string, args.new_end as string, timezone);
        // 1.4 (diagnostic) — the freed-slot narration once said 11:00 when the moved
        // occurrence was at 14:00. Log the pre-move start (from getEventType) and the
        // computed vacated so a recurrence shows whether getEventType returned the
        // series base time vs the occurrence's real start (i.e. is the bug here or
        // in the narration). Remove once diagnosed.
        logger.info('move_meeting — vacated slot computed', {
          meetingId: args.meeting_id,
          preMoveStartIso,
          newStart: args.new_start,
          vacated,
        });

        // v3.2.x (Tier 1) — capture the rebalance return so a displaced
        // floating block whose window this move just freed can be OFFERED back
        // (reclaimable_block), same propose-only pattern as `vacated`. The freed
        // range (the meeting's OLD slot) gates the offer to a relevant move.
        let reclaimable: import('../../../../utils/rebalanceFloatingBlocks').ReclaimableBlock[] = [];
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { rebalanceFloatingBlocksAfterMutation } = require('../../../../utils/rebalanceFloatingBlocks') as
            typeof import('../../../../utils/rebalanceFloatingBlocks');
          const rebal = await rebalanceFloatingBlocksAfterMutation({
            profile: context.profile,
            affectedSlotIso: effectiveStart,
            ownerSlackId: context.profile.user.slack_user_id,
            ...(vacated ? { freedRangeIso: { start: vacated.start, end: vacated.end } } : {}),
          });
          reclaimable = rebal?.reclaimable ?? [];
        } catch (err) {
          logger.warn('rebalance after move_meeting threw — continuing', { err: String(err).slice(0, 200) });
        }

        return {
          success: true,
          moved: args.meeting_subject,
          // #1.5 — the ACTUAL booked time (after the grid-snap at :4156), not the
          // pre-snap arg. So narration AND the orchestrator's mutationActions
          // (→ dateVerifier + #135 honesty backstop) reflect where it truly landed.
          new_start: effectiveStart,
          new_end: effectiveEnd,
          booked_start: effectiveStart,
          booked_end: effectiveEnd,
          // v3.1.8 — the slot that just opened up (old time of the moved meeting).
          ...(vacated ? { vacated } : {}),
          // v3.2.x — a displaced floating block this move could bring home.
          // PROPOSE-ONLY: surface it; the reply offers ("…frees 12:30 — want
          // lunch back there?"). Not auto-moved (may be owner-pinned).
          ...(reclaimable.length ? { reclaimable_block: reclaimable[0] } : {}),
          // #A (2026-07-19) — non-blocking attendee-busy heads-up. The move already went
          // through (owner override is total), but a colleague-requested move can re-land
          // on a time that attendee is busy — surface it so Maelle flags it, never re-asks.
          // This notice was computed by planMeeting but DROPPED here before the fix.
          ...(movePlanOverrideNotice ? { _attendee_busy_note: `Heads up — ${movePlanOverrideNotice}. Moved anyway (your call is total); say plainly who's busy at the new time and offer to check with them or pick another slot — don't re-ask permission.` } : {}),
          // v1.8.3 — past-tense summary the reply quotes verbatim. Issue #26 bug 1:
          // without this, Sonnet could re-read the calendar post-move and narrate
          // the new time as a fresh discovery ("already at 12:30, nothing to change")
          // instead of acknowledging her own action.
          action_summary: `Moved '${args.meeting_subject}' to ${renderWeDualClock(effectiveStart, { isAway: !!moveTripDisplay, effectiveTz: moveTripDisplay?.tz ?? timezone, location: moveTripDisplay?.location ?? '' }, timezone, { endIso: effectiveEnd })}.`,
          ...(moveTripDisplay ? { _trip_note: 'Travel day — state the moved time from `action_summary` VERBATIM (both clocks, correctly labelled); do not recompute it.' } : {}),
        };
}

