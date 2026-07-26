/**
 * D4 — the ONE place a "his calendar is unreadable" fault becomes an answer.
 *
 * The refusal used to be inlined in `MeetingsSkill.executeToolCall`, which is
 * every meeting tool the model can call — but NOT the calendar-health tools
 * (`check_calendar_health`, `book_floating_block`, `set_event_category`,
 * `manage_calendar_issue`), which dispatch from `CalendarHealthSkill` and reach
 * the same Graph reads: `book_floating_block` goes through planMeeting's
 * `getOwnerEventsForDecision`, and the health scan's defrag calls the slot walker,
 * whose free/busy read throws the same typed error. With no catch there, the
 * registry turned the throw into `Tool "check_calendar_health" failed:
 * CalendarOfflineError: Owner calendar unreadable: <raw Graph text>`
 * (registry.ts) — a raw provider string in her context, which she then had to
 * improvise a refusal around while the meeting tools next to it had a written one.
 *
 * So it lives here, as a wrapper both dispatchers call: one message, one log line,
 * one taxonomy. Not a second outage voice — the SAME voice, reachable from the
 * second dispatcher (P24: "D4 already owns the outage-refusal voice — ride it").
 *
 * Deliberately NOT a catch-all for Graph errors. Only the typed
 * `CalendarOfflineError` is answered, and that is minted in exactly two places,
 * both a read of the OWNER's own calendar that a decision depends on
 * (`getOwnerEventsForDecision`, the slot walker's free/busy read) and both gated
 * on `isOutageShaped`. A deterministic fault (a 400 on a malformed window, a 403
 * consent problem, our own TypeError) keeps its own honest failure and travels up
 * unchanged — the same rule the two producers already follow.
 */
import type { SkillContext } from '../types';
import { CalendarOfflineError } from '../../connectors/graph/calendar';
import logger from '../../utils/logger';

export async function withCalendarOfflineRefusal(
  toolName: string,
  context: SkillContext,
  run: () => Promise<unknown | null>,
): Promise<unknown | null> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof CalendarOfflineError)) throw err;
    const ownerFirst = context.profile.user.name.split(' ')[0];
    logger.error('meeting tool refused — owner calendar offline', {
      toolName, requester: context.userId, detail: err.detail,
    });
    return {
      success: false,
      error: 'calendar_offline',
      message: `I can't reach ${ownerFirst}'s calendar right now — it's offline on my side, so I genuinely cannot see what's on his day. Nothing was booked, moved or cancelled. This is NOT "he's busy" and NOT "no time fits": I have no information at all, so do not answer as if either were true, do not offer times, do not claim anything about his availability, and do not raise an approval (he would be deciding blind too). Say plainly that his calendar is unreachable at the moment and offer to try again shortly.`,
    };
  }
}
