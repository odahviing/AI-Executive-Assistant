/**
 * handleBookFloatingBlock — the `book_floating_block` case body, extracted
 * VERBATIM from ../../calendarHealth.ts. No logic changes: relative import depth
 * deepened two levels; free vars (context/profile/userEmail/timezone) threaded
 * via OpCtx.
 */
import { DateTime } from 'luxon';
import {
  getOwnerEventsForDecision,
  type CalendarEvent,
  createMeeting,
  CalendarOfflineError,
} from '../../../connectors/graph/calendar';
import logger from '../../../utils/logger';
import type { PreferPosition, AnchorEvent } from '../../../utils/floatingBlocks';
import { alignNearestQuarter } from '../../../utils/calendarDensity';
import { getEffectiveWorkDay } from '../../../utils/workHours';
import { parseGraphDt } from '../classify';
import type { OpCtx } from './context';
import { logActivity } from '../../../core/requests/logActivity';
import type { SkillContext } from '../../types';

// book-floating-block-revert-dead-end-to-end (2026-08-12) — one shared
// logActivity call for both booking branches below (override and
// positional), so a future field change lands once instead of drifting
// between two near-identical copies. Floating blocks have no attendees, so
// there is no target person to attribute this to — targetSlackId/targetName
// stay omitted, matching logActivity's own doc on a row with no counterpart.
function logFloatingBlockActivity(
  context: SkillContext,
  blockLabel: string,
  eventId: string,
  startIso: string,
  endIso: string,
): void {
  logActivity({
    ownerUserId: context.profile.user.slack_user_id,
    kind: 'follow_up',
    subkind: 'book_floating_block',
    subject: `Booked '${blockLabel}'`,
    outcomeJson: { event_id: eventId, start: startIso, end: endIso },
    initiatedBy: context.userId,
    initiatedByRole: context.senderRole,
    originThreadTs: context.threadTs,
    originChannel: context.channelId,
  });
}

export async function handleBookFloatingBlock(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { context, profile, userEmail, timezone } = ctx;
        const date = args.date as string;
        const blockName = (args.block_name as string | undefined)?.trim();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fb = require('../../../utils/floatingBlocks') as typeof import('../../../utils/floatingBlocks');
        const blocks = fb.getFloatingBlocks(profile);
        if (blocks.length === 0) {
          return { error: 'no_floating_blocks', message: 'No floating blocks configured in profile.' };
        }
        const block = blockName ? blocks.find(b => b.name === blockName) : undefined;
        if (!block) {
          return {
            error: 'unknown_block',
            message: `Unknown block_name "${blockName ?? ''}". Configured blocks: ${blocks.map(b => b.name).join(', ')}.`,
          };
        }

        const blockLabel = block.default_subject ?? (block.name.charAt(0).toUpperCase() + block.name.slice(1).replace(/_/g, ' '));
        const dayName = DateTime.fromISO(date, { zone: timezone }).toFormat('EEEE');

        // v3.7.x (#143) — no floating blocks on ANY per-date override day (day
        // off, custom hours, office/home flip, or a travel day). The override
        // reshapes the day; lunch/gym/focus don't auto-slot onto it. Clear the
        // override to restore them. Covers both the active-mode auto-book and an
        // explicit owner request.
        if (getEffectiveWorkDay(date, profile).hasOverride) {
          return {
            error: 'override_day',
            message: `${date} has a schedule override, so I don't book ${blockLabel} that day. Clear the override for that date if you want your floating blocks back.`,
          };
        }

        // Owner-override path — owner explicitly directs an out-of-window
        // (or off-schedule-day) booking. The flag IS the approval; the same
        // pattern as v2.3.3 find_available_slots.relaxed and v2.2.1
        // colleague-path move_meeting auto-accept. Only the window/day-scope
        // bend; buffer + conflict + alignment checks still hold below.
        const confirmOutsideWindow = args.confirm_outside_window === true;
        const explicitStartTime = (args.start_time as string | undefined)?.trim();

        if (!confirmOutsideWindow && !fb.blockAppliesOnDay(block, dayName, profile)) {
          return {
            error: 'not_applicable_today',
            message: `${blockLabel} isn't scheduled for ${dayName} in your profile (days: ${(block.days ?? ['every work day']).join(', ')}). If owner explicitly directs you to book it on this day anyway, retry with confirm_outside_window=true and start_time="HH:MM".`,
          };
        }

        // Get events for the day to find a free slot in the block window.
        // The SHARED owner-event read, no local catch. This read decides
        // WHERE the block lands and whether it collides, so an unreadable calendar
        // is a blind spot, not a placement. It sat BEFORE the planMeeting call
        // below, so its own mechanical `Failed to fetch calendar events.` was what
        // an outage actually produced for this tool — the skill's offline wrapper never
        // saw a typed error to answer. Same read, same retry, same one refusal now.
        const events: CalendarEvent[] = await getOwnerEventsForDecision(
          userEmail, date, date, timezone,
        );

        const windowStart = DateTime.fromISO(`${date}T${block.preferred_start}`, { zone: timezone });
        const windowEnd = DateTime.fromISO(`${date}T${block.preferred_end}`, { zone: timezone });

        // Owner-override branch — when confirm_outside_window=true AND a
        // start_time was given, skip the positional/window logic entirely
        // and book at the explicit time. Buffer + conflict checks still run.
        if (confirmOutsideWindow && explicitStartTime) {
          if (!/^\d{2}:\d{2}$/.test(explicitStartTime)) {
            return {
              error: 'invalid_start_time',
              message: `start_time must be HH:MM (24h). Got "${explicitStartTime}".`,
            };
          }
          const rawOverrideStart = DateTime.fromISO(`${date}T${explicitStartTime}`, { zone: timezone });
          if (!rawOverrideStart.isValid) {
            return { error: 'invalid_start_time', message: `Couldn't parse ${date}T${explicitStartTime} in ${timezone}.` };
          }
          // Snap off-grid start_time to the NEAREST quarter so the standard
          // :00/:15/:30/:45 grid the rest of the system assumes is honored.
          // The tool description promises this; pre-fix the override branch
          // skipped alignment entirely (positional path snapped via
          // findAlignedSlotForBlock, but the override branch doesn't go
          // through that helper).
          const overrideStart = DateTime.fromMillis(
            alignNearestQuarter(rawOverrideStart.toMillis(), timezone),
          ).setZone(timezone);
          const overrideEnd = overrideStart.plus({ minutes: block.duration_minutes });

          // Idempotency — any same-block event on this day already on the
          // calendar (anywhere, not just near the override time). Pre-fix
          // this only matched within ±60s of the override start, which
          // meant a 14:00 override on a day that already had lunch booked
          // at 11:30 would CREATE A SECOND lunch. Owner sees two lunches
          // same day. Match the same shape the non-override branch uses
          // (any block event on the day → already_existed).
          const existingNearby = events.find(e => {
            if (e.isAllDay || e.isCancelled || e.showAs === 'free') return false;
            if (!fb.isFloatingBlockEvent(
              { subject: e.subject, categories: e.categories },
              block,
            )) return false;
            const eStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
            return eStart.toFormat('yyyy-MM-dd') === date;
          });
          if (existingNearby) {
            const eStart = parseGraphDt(existingNearby.start.dateTime, existingNearby.start.timeZone, timezone);
            const eEnd = parseGraphDt(existingNearby.end.dateTime, existingNearby.end.timeZone, timezone);
            return {
              ok: true, created: false, already_existed: true,
              event_id: existingNearby.id, subject: existingNearby.subject,
              start: eStart.toFormat('HH:mm'), end: eEnd.toFormat('HH:mm'),
              date, block_name: block.name, override_used: true,
              message: `${blockLabel} is already on the calendar on ${date} at ${eStart.toFormat('HH:mm')}–${eEnd.toFormat('HH:mm')}. To move it to ${explicitStartTime}, use move_meeting with confirm_outside_window=true rather than book_floating_block.`,
            };
          }

          // Override is TOTAL. No conflict / buffer check in this branch.
          // Owner direction: "she can raise a flag, but if I say yes, it's
          // yes." By the time the tool is called with confirm_outside_window
          // = true, owner has already seen the conversational warning and
          // re-consented. The tool obeys — true overlap, back-to-back,
          // off-hours all allowed. Maelle can warn in the conversation
          // (and does), but does not refuse via tool-level conflict error.

          // Delegate category/location/rule-check to planMeeting.
          // Window-aware slot finding stays here; the booking step joins
          // the unified flow. confirm_outside_window=true → allowRelaxed=true
          // so planMeeting bypasses outside-working-hours etc., matching the
          // historical override semantic.
          let blockCategories: string[] | undefined = undefined;
          let blockLocation: string = '';
          let blockIsOnline: boolean = false;
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { planMeeting } = require('../../meetings/planMeeting') as typeof import('../../meetings/planMeeting');
            const plan = await planMeeting({
              profile,
              intent: 'new_booking',
              initiator: 'owner',
              slotStartIso: overrideStart.toISO()!,
              slotEndIso: overrideEnd.toISO()!,
              subject: blockLabel,
              participants: [],
              allowRelaxed: true,  // override path always bypasses soft rules
              isFloatingBlock: true,  // skip owner_busy_collision — focus/lunch blocks coexist with meetings
            });
            if (plan.action === 'confirm_override' || plan.action === 'escalate_approval') {
              // Should be unreachable with allowRelaxed=true. If somehow
              // hit, surface the violation back to Sonnet.
              return {
                error: 'rule_violation',
                message: `Override slot still violates a rule planMeeting can't bypass: ${plan.violationLabel}`,
              };
            }
            if (plan.action === 'book') {
              if (plan.category) blockCategories = [plan.category];
              blockLocation = plan.location;
              blockIsOnline = plan.isOnline;
            }
          } catch (err) {
            // The blind spot is never a classification fallback. Same
            // one-liner the create / move / search handlers carry around their own
            // best-effort catches: an unreadable owner calendar goes to the skill's
            // one refusal, it does not silently become "no category".
            if (err instanceof CalendarOfflineError) throw err;
            logger.warn('book_floating_block override-path: planMeeting threw, falling back to raw category', {
              err: String(err).slice(0, 200),
            });
          }

          // Fallback: yaml block.default_category if planMeeting couldn't classify.
          if (!blockCategories) {
            const categoryArg = (args.category as string | undefined)?.trim();
            const validCategoryNames = (profile.categories ?? []).map(c => c.name);
            if (block.default_category && validCategoryNames.includes(block.default_category)) {
              blockCategories = [block.default_category];
            } else if (categoryArg && (validCategoryNames.length === 0 || validCategoryNames.includes(categoryArg))) {
              blockCategories = [categoryArg];
            }
          }

          try {
            const created = await createMeeting({
              subject: blockLabel,
              start: overrideStart.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
              end: overrideEnd.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
              attendees: [],
              body: `<p>${blockLabel} — booked by ${profile.assistant.name}, ${profile.user.name.split(' ')[0]} Assistant. (Owner-override: outside the ${block.preferred_start}-${block.preferred_end} window.)</p>`,
              isOnline: blockIsOnline,
              location: blockLocation || undefined,
              categories: blockCategories,
              userEmail,
              timezone,
            });
            const eventId = created.id;

            // book-floating-block-revert-dead-end-to-end (2026-08-12) —
            // undo/history record for this booking, same shape create_meeting's
            // own logActivity call writes (createMeeting.ts), so
            // ACTIVITY_REVERTIBILITY's book_floating_block entry
            // (currentStartField: 'start') and the revert dispatch's
            // create_meeting/book_floating_block delete-by-id branch
            // (calendarReads.ts:604) actually have a row to find. Before this,
            // no write site ever logged one for this subkind despite both
            // sides of that table assuming it worked — "book my lunch" /
            // "undo that" had nothing to revert.
            logFloatingBlockActivity(
              context, blockLabel, eventId,
              overrideStart.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
              overrideEnd.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            );

            logger.info('book_floating_block: owner-override booking', {
              blockName: block.name, date, start_time: explicitStartTime,
              window: `${block.preferred_start}-${block.preferred_end}`,
              event_id: eventId,
            });
            return {
              ok: true, created: true, already_existed: false,
              event_id: eventId, subject: blockLabel,
              start: overrideStart.toFormat('HH:mm'),
              end: overrideEnd.toFormat('HH:mm'),
              date, block_name: block.name, booked: true,
              override_used: true,
              window: { start: block.preferred_start, end: block.preferred_end },
              message: `I booked ${blockLabel} on ${date} from ${overrideStart.toFormat('HH:mm')} to ${overrideEnd.toFormat('HH:mm')} — outside your usual ${block.preferred_start}-${block.preferred_end} window per your direction.`,
              assistant_hint: `Acknowledge the override briefly when narrating ("booked at ${overrideStart.toFormat('HH:mm')} per your call, outside the usual window") so the owner sees the trade-off was logged. Don't apologize — they asked for it.`,
            };
          } catch (err) {
            logger.error('book_floating_block: failed to create override event', { err, blockName });
            return { error: `Failed to create ${blockLabel} event: ${String(err)}` };
          }
        }

        if (confirmOutsideWindow && !explicitStartTime) {
          return {
            error: 'override_needs_start_time',
            message: `confirm_outside_window=true requires start_time="HH:MM". The override path doesn't infer a time — owner must direct it explicitly.`,
          };
        }

        // Idempotency: if the block's event already exists in the window,
        // return created:false. Bug-3 fix: the message now ATTRIBUTES the
        // booking to Maelle herself instead of phrasing it as discovered
        // calendar state. The previous wording ("Lunch is already on the
        // calendar...") was being parroted verbatim by Sonnet, making her
        // narrate her own bookings as if she'd just stumbled onto them.
        const existingEvent = events.find(e => {
          if (e.isAllDay || e.isCancelled || e.showAs === 'free') return false;
          const matches = fb.isFloatingBlockEvent(
            { subject: e.subject, categories: e.categories },
            block,
          );
          if (!matches) return false;
          const eStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
          const eEnd = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
          return eStart.toMillis() < windowEnd.toMillis() && eEnd.toMillis() > windowStart.toMillis();
        });
        if (existingEvent) {
          const eStart = parseGraphDt(existingEvent.start.dateTime, existingEvent.start.timeZone, timezone);
          const eEnd = parseGraphDt(existingEvent.end.dateTime, existingEvent.end.timeZone, timezone);
          return {
            ok: true,
            created: false,
            already_existed: true,
            event_id: existingEvent.id,
            subject: existingEvent.subject,
            start: eStart.toFormat('HH:mm'),
            end: eEnd.toFormat('HH:mm'),
            date,
            block_name: block.name,
            // Bug-3 fix: action-attributed phrasing. Read as "you (Maelle)
            // already did this" rather than "the calendar happens to have
            // this." Pairs with the action-tape closing line that asks
            // Sonnet to lead with what she did.
            message: `You already booked ${blockLabel} on ${date} at ${eStart.toFormat('HH:mm')}–${eEnd.toFormat('HH:mm')} — same slot, no change.`,
            assistant_hint: `You (Maelle) booked this earlier in this conversation. Narrate as your action ("I booked it at ${eStart.toFormat('HH:mm')}"), not as discovered state ("it's on the calendar").`,
          };
        }

        // Busy blocks in the window, EXCLUDING events that are this block
        // (we're about to book one; don't let a stale one self-block).
        const busyInWindow = events
          .filter(e => {
            if (e.isAllDay || e.isCancelled || e.showAs === 'free') return false;
            if (fb.isFloatingBlockEvent(
              { subject: e.subject, categories: e.categories },
              block,
            )) return false;
            const eStart = parseGraphDt(e.start.dateTime, e.start.timeZone, timezone);
            const eEnd = parseGraphDt(e.end.dateTime, e.end.timeZone, timezone);
            return eStart.toMillis() < windowEnd.toMillis() && eEnd.toMillis() > windowStart.toMillis();
          })
          .map(e => ({
            start: Math.max(parseGraphDt(e.start.dateTime, e.start.timeZone, timezone).toMillis(), windowStart.toMillis()),
            end: Math.min(parseGraphDt(e.end.dateTime, e.end.timeZone, timezone).toMillis(), windowEnd.toMillis()),
          }));

        // v3.0.2 — floating-block math no longer applies a buffer (meeting
        // durations 10/25/40/55 already carry natural spacing). The previous
        // `profile.meetings.buffer_minutes ?? 0` was a path for the owner's
        // yaml-set buffer to leak in here and reject in-window slots.
        //
        // Default chain: explicit Sonnet arg wins; otherwise the yaml-set
        // `block.prefer_position` (interface doc on FloatingBlock promises
        // this); else 'earliest'. Without the middle tier, an auto-book from
        // missing_floating_block ignored an owner-set `latest_in_window` and
        // always landed at earliest.
        const yamlPreferPosition = block.prefer_position === 'latest_in_window'
          ? 'latest_in_window'
          : undefined;
        const preferPosition = ((args.prefer_position as string | undefined)
          ?? yamlPreferPosition
          ?? 'earliest') as PreferPosition;
        const anchorEventId = (args.anchor_event_id as string | undefined)?.trim();
        let anchor: AnchorEvent | undefined;
        if (anchorEventId) {
          const anchorEvent = events.find(e => e.id === anchorEventId);
          if (!anchorEvent) {
            return {
              error: 'anchor_not_found',
              message: `anchor_event_id ${anchorEventId} doesn't appear in the calendar for ${date}. Either pick a different anchor or call get_calendar to refresh ids.`,
            };
          }
          anchor = {
            start: parseGraphDt(anchorEvent.start.dateTime, anchorEvent.start.timeZone, timezone).toMillis(),
            end: parseGraphDt(anchorEvent.end.dateTime, anchorEvent.end.timeZone, timezone).toMillis(),
          };
        }

        const slotResult = fb.findPositionalSlotForBlock(
          block, date, timezone, busyInWindow, preferPosition, anchor,
        );

        if ('error' in slotResult) {
          // Diagnostic: list the busy blocks that fragmented the window.
          // Without this, "no_room" is opaque — Sonnet narrates "tight" or
          // "no clean window" with no specifics, and the owner has to guess
          // why a slot he eyeballs as free was rejected.
          const busyDetails = busyInWindow
            .sort((a, b) => a.start - b.start)
            .map(b => ({
              start: DateTime.fromMillis(b.start).setZone(timezone).toFormat('HH:mm'),
              end: DateTime.fromMillis(b.end).setZone(timezone).toFormat('HH:mm'),
            }));
          logger.info('book_floating_block: rejection — diagnostic', {
            blockName: block.name,
            date,
            window: `${block.preferred_start}-${block.preferred_end}`,
            duration_min: block.duration_minutes,
            prefer_position: preferPosition,
            anchor_event_id: anchorEventId,
            error: slotResult.error,
            detail: slotResult.detail,
            busyInWindow: busyDetails,
          });

          // Map error codes to human-friendly messages. The diagnostic detail
          // string from the helper is already specific (e.g. "abut_before
          // would land at 12:15-12:40, conflicting with a busy block at
          // 12:25-12:30") so we surface it directly.
          const messageByError: Record<string, string> = {
            no_room: `No room for a ${block.duration_minutes}-minute ${blockLabel} between ${block.preferred_start} and ${block.preferred_end} on ${date} with quarter-hour alignment.`,
            anchor_required: slotResult.detail,
            anchor_outside_window: `${blockLabel} doesn't fit ${preferPosition === 'abut_before' ? 'before' : 'after'} the anchor inside the ${block.preferred_start}-${block.preferred_end} window: ${slotResult.detail}`,
            anchor_conflicts_busy: `${blockLabel} can't abut the anchor without conflicting: ${slotResult.detail}`,
            unknown_position: slotResult.detail,
          };

          return {
            error: slotResult.error,
            message: messageByError[slotResult.error] ?? slotResult.detail,
            detail: slotResult.detail,
            window: { start: block.preferred_start, end: block.preferred_end },
            duration_minutes: block.duration_minutes,
            prefer_position: preferPosition,
            busy_blocks_in_window: busyDetails,
            assistant_hint: slotResult.error === 'no_room' && busyDetails.length > 0
              ? `The window was fragmented by these busy blocks: ${busyDetails.map(b => `${b.start}-${b.end}`).join(', ')}. With quarter-hour alignment, no aligned ${block.duration_minutes}-min slot fit any gap. If the owner pushes back ("but I have time at HH:MM"), explain WHICH busy block conflicts — don't just say "tight".`
              : slotResult.error === 'anchor_outside_window'
              ? `Tell the owner honestly: the requested position lands outside the block's preferred window (${block.preferred_start}-${block.preferred_end}). Don't fall back to create_meeting at the boundary time — that's a policy_exception approval (deferred_action move_meeting with confirm_outside_window=true) if the owner explicitly wants to override.`
              : slotResult.error === 'anchor_conflicts_busy'
              ? `Tell the owner the abut slot conflicts with another meeting (named in the detail above). Either pick a different anchor or fall back to earliest position.`
              : undefined,
          };
        }

        const bestStart = slotResult.ms;

        const blockStart = DateTime.fromMillis(bestStart).setZone(timezone);
        const blockEnd = blockStart.plus({ minutes: block.duration_minutes });

        // v2.7.4 — delegate category/location/rule-check to planMeeting so
        // the floating-block path uses the same engine as regular bookings.
        // Window-aware slot finding stayed above; the booking step is unified.
        let blockCategories: string[] | undefined = undefined;
        let blockLocation: string = '';
        let blockIsOnline: boolean = false;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { planMeeting } = require('../../meetings/planMeeting') as typeof import('../../meetings/planMeeting');
          const plan = await planMeeting({
            profile,
            intent: 'new_booking',
            initiator: 'owner',
            slotStartIso: blockStart.toISO()!,
            slotEndIso: blockEnd.toISO()!,
            subject: blockLabel,
            participants: [],
            // Inside the block's preferred window — soft rules should pass,
            // so allowRelaxed stays false. If a rule fires, return error
            // pointing Sonnet to retry with confirm_outside_window=true.
            allowRelaxed: false,
            isFloatingBlock: true,  // skip owner_busy_collision — focus/lunch blocks coexist with meetings
          });
          if (plan.action === 'confirm_override' || plan.action === 'escalate_approval') {
            return {
              error: 'rule_violation',
              violation_label: plan.violationLabel,
              suggested_ask_text: plan.suggestedAskText,
              message: `${blockLabel} at ${blockStart.toFormat('HH:mm')} on ${date} can't book: ${plan.violationLabel}. To override, retry book_floating_block with confirm_outside_window=true and start_time="${blockStart.toFormat('HH:mm')}".`,
            };
          }
          if (plan.action === 'book') {
            if (plan.category) blockCategories = [plan.category];
            blockLocation = plan.location;
            blockIsOnline = plan.isOnline;
          }
        } catch (err) {
          // As on the override path above, and it matters more here:
          // `allowRelaxed:false` means this plan call can REFUSE, so swallowing an
          // unreadable calendar would book the block with no rule check at all.
          if (err instanceof CalendarOfflineError) throw err;
          logger.warn('book_floating_block: planMeeting threw, falling back to yaml category', {
            err: String(err).slice(0, 200),
          });
        }

        // Fallback ladder: planMeeting category → yaml block.default_category → Sonnet's arg → none.
        if (!blockCategories) {
          const categoryArg = (args.category as string | undefined)?.trim();
          const validCategoryNames = (profile.categories ?? []).map(c => c.name);
          if (block.default_category && validCategoryNames.includes(block.default_category)) {
            blockCategories = [block.default_category];
          } else if (categoryArg) {
            if (validCategoryNames.length === 0 || validCategoryNames.includes(categoryArg)) {
              blockCategories = [categoryArg];
            } else {
              logger.warn('book_floating_block: agent proposed category not in profile — dropping', {
                proposed: categoryArg,
                allowed: validCategoryNames,
                blockName: block.name,
              });
            }
          }
        }

        try {
          const created = await createMeeting({
            subject: blockLabel,
            start: blockStart.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            end: blockEnd.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            attendees: [],
            // Invite-body attribution names this assistant + owner.
            body: `<p>${blockLabel} — booked by ${profile.assistant.name}, ${profile.user.name.split(' ')[0]} Assistant.</p>`,
            isOnline: blockIsOnline,
            location: blockLocation || undefined,
            categories: blockCategories,
            // No sensitivity tag — pre-v2.1.7 'personal' stamps caused the
            // recurring "Private block" misdetection bug. Floating-block
            // matching is subject-regex/category based via
            // isFloatingBlockEvent, so leaving sensitivity at default
            // ('normal') doesn't affect detection.
            userEmail,
            timezone,
          });
          const eventId = created.id;

          // book-floating-block-revert-dead-end-to-end (2026-08-12) —
          // undo/history record for this booking, same shape create_meeting's
          // own logActivity call writes (createMeeting.ts), so
          // ACTIVITY_REVERTIBILITY's book_floating_block entry
          // (currentStartField: 'start') and the revert dispatch's
          // create_meeting/book_floating_block delete-by-id branch
          // (calendarReads.ts:604) actually have a row to find. Before this,
          // no write site ever logged one for this subkind despite both sides
          // of that table assuming it worked — "book my lunch" / "undo that"
          // had nothing to revert.
          logFloatingBlockActivity(
            context, blockLabel, eventId,
            blockStart.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            blockEnd.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
          );

          // Surface any pre-existing meetings sitting inside the booked
          // floating-block window. Floating blocks coexist with meetings by
          // design, but the caller (Sonnet) should know so she can offer to
          // move them: "Blocked 13:00–18:15. Your BiWeekly at 17:00 sits
          // inside — want me to find it a new slot?"
          const overlapping = events
            .filter(ev => !ev.isCancelled && (ev as any).showAs !== 'free')
            .filter(ev => {
              const evStart = DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' });
              const evEnd = DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' });
              return evStart < blockEnd && evEnd > blockStart;
            })
            .map(ev => ({
              event_id: ev.id,
              subject: ev.subject,
              start: DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone ?? 'utc' })
                .setZone(timezone).toFormat('HH:mm'),
              end: DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone ?? 'utc' })
                .setZone(timezone).toFormat('HH:mm'),
            }));

          return {
            ok: true,
            created: true,
            already_existed: false,
            event_id: eventId,
            subject: blockLabel,
            start: blockStart.toFormat('HH:mm'),
            end: blockEnd.toFormat('HH:mm'),
            date,
            block_name: block.name,
            booked: true,
            message: `I booked ${blockLabel} on ${date} from ${blockStart.toFormat('HH:mm')} to ${blockEnd.toFormat('HH:mm')}.`,
            ...(overlapping.length > 0 ? { overlapping_events: overlapping } : {}),
          };
        } catch (err) {
          logger.error('book_floating_block: failed to create event', { err, blockName });
          return { error: `Failed to create ${blockLabel} event: ${String(err)}` };
        }
}
