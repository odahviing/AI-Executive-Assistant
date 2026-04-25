/**
 * Post-booking health check (v2.2.1).
 *
 * After a meeting is added or moved on a path that REQUIRED owner approval —
 * meaning the booking happened because Idan said yes to a rule-pressured
 * coord (slot_pick / calendar_conflict) — sweep the affected day for new
 * issues that the booking introduced or surfaced. If any land, DM the owner
 * with a short summary and an offer to clean up.
 *
 * Owner-initiated direct moves (his own move_meeting calls) and rule-compliant
 * inbound reschedules (no approval needed) don't run this check — there's no
 * reason to suspect a problem when nothing was overridden.
 *
 * Fire-and-forget: never throws, never blocks the resolver.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import logger from './logger';

export async function runPostBookingHealthCheck(params: {
  profile: UserProfile;
  /** ISO timestamp of the booked/moved slot — used to derive the affected date. */
  slotIso: string;
  /** Subject of the meeting that just landed — surfaced in the owner DM. */
  subject: string;
}): Promise<void> {
  const { profile, slotIso, subject } = params;

  try {
    const tz = profile.user.timezone;
    const slotDt = DateTime.fromISO(slotIso, { zone: tz });
    if (!slotDt.isValid) {
      logger.warn('postBookingHealthCheck: invalid slotIso, skipping', { slotIso });
      return;
    }
    const dateStr = slotDt.toFormat('yyyy-MM-dd');

    // Lazy imports — keep this module light + avoid circular dep risk.
    const { getCalendarEvents } = await import('../connectors/graph/calendar');
    const { processCalendarEvents, analyzeCalendar } = await import('../skills/meetings/ops');
    const { getConnection } = await import('../connections/registry');
    const { getDismissedIssueKeys } = await import('../db/calendarIssues');

    const startIso = slotDt.startOf('day').toUTC().toISO();
    const endIso = slotDt.endOf('day').toUTC().toISO();
    if (!startIso || !endIso) return;

    const events = await getCalendarEvents(profile.user.email, startIso, endIso);
    const processed = processCalendarEvents(events, profile.user.email, profile.user.name, tz);
    const dismissed = (() => {
      try { return getDismissedIssueKeys(profile.user.slack_user_id, dateStr, dateStr); }
      catch { return new Set<string>(); }
    })();
    const analysis = analyzeCalendar(processed, dateStr, dateStr, profile, dismissed);

    const issues = analysis.flatMap(d => d.issues ?? []);
    if (issues.length === 0) {
      logger.info('postBookingHealthCheck: clean day, no DM', { dateStr, subject });
      return;
    }

    const conn = getConnection(profile.user.slack_user_id, 'slack');
    if (!conn) {
      logger.warn('postBookingHealthCheck: no Slack connection, skipping DM', { ownerId: profile.user.slack_user_id });
      return;
    }

    const dayLabel = slotDt.toFormat('EEEE d MMM');
    const issueLines = issues.slice(0, 6).map(i => {
      const sev = i.severity ? ` (${i.severity})` : '';
      return `• ${i.type}${sev}: ${i.detail}`;
    });
    const moreLine = issues.length > 6 ? `\n• ...and ${issues.length - 6} more` : '';
    const text = [
      `Booked "${subject}" — ${dayLabel} now has ${issues.length} issue${issues.length === 1 ? '' : 's'}:`,
      ...issueLines,
      moreLine,
      '',
      'Want me to look at fixing them?',
    ].filter(Boolean).join('\n');

    await conn.sendDirect(profile.user.slack_user_id, text);
    logger.info('postBookingHealthCheck: DM sent', {
      dateStr, subject, issueCount: issues.length,
    });
  } catch (err) {
    logger.warn('postBookingHealthCheck threw — swallowed', {
      slotIso, subject, err: String(err).slice(0, 300),
    });
  }
}
