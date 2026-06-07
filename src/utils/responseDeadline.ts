/**
 * Reply-deadline tz math — transport-agnostic.
 *
 * Extracted from connectors/slack/coordinator.ts (v3.3.x, audit T-1/M-19) so
 * CORE consumers (outreach skill, dispatchers) don't reach DOWN into a
 * Slack-bound connector for a pure date helper. No Slack dependency lives here —
 * just luxon. When the email/WhatsApp Connections come online they share this.
 */
import { DateTime } from 'luxon';

/**
 * Next "business hour start" ≥ now, using the supplied work days (defaults to
 * Mon–Fri). Used by calcResponseDeadline so reply timers never fire during
 * someone's night.
 */
function nextWorkingHourStart(timezone: string, workDays?: string[]): DateTime {
  let dt = DateTime.now().setZone(timezone);
  const dayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  for (let i = 0; i < 10; i++) {
    const todayName = dayNames[dt.weekday];
    const isWorkDay = workDays
      ? workDays.includes(todayName)
      : dt.weekday >= 1 && dt.weekday <= 5;
    if (isWorkDay) {
      if (dt.hour < 8) return dt.set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
      if (dt.hour < 19) return dt;
    }
    dt = dt.plus({ days: 1 }).set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
  }
  return dt;
}

/**
 * Reply deadline: 3 working hours from now in the colleague's timezone.
 * Shared with message_colleague and outreach_expiry task scheduling.
 */
export function calcResponseDeadline(colleagueTz: string): string {
  const workStart = nextWorkingHourStart(colleagueTz);
  return workStart.plus({ hours: 3 }).toUTC().toISO()!;
}
