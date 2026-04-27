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

    // v2.3.1 (B11 / #67) — auto-DM removed. Owner direction: he gets a full
    // morning report from the daily routine; he doesn't want a mid-day
    // disruption summary every time he approves a coord booking. Issues
    // that require his decision should already surface through the regular
    // approval mechanism (calendar_conflict, oof_conflict approvals); ones
    // she can fix herself flow through active-mode in the morning sweep.
    // Keep the analysis call (telemetry + a hook for future "Maelle decides
    // to act" without prompting owner) but drop the unsolicited DM.
    logger.info('postBookingHealthCheck: ran silently', {
      dateStr, subject, issueCount: issues.length,
      issueTypes: issues.map(i => i.type),
    });

    // Suppress unused-import warnings — getConnection is no longer used here.
    void getConnection;
  } catch (err) {
    logger.warn('postBookingHealthCheck threw — swallowed', {
      slotIso, subject, err: String(err).slice(0, 300),
    });
  }
}
