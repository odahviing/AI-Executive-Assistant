/**
 * Thread-scoped attendee tracker (v2.6.6).
 *
 * In-process Map of "emails Sonnet has used as attendees in this thread."
 * Recorded on every successful find_available_slots / coordinate_meeting /
 * create_meeting call that included an attendee. Consumed by find_available_slots
 * and coordinate_meeting when Sonnet calls them WITHOUT attendees on a
 * subsequent turn — auto-fills from this set so the slot search keeps
 * honoring known attendees' work hours.
 *
 * Why this exists: 2026-05-10 Shayan MPIM bug. First find_available_slots
 * call passed attendee_emails=[shayan.m@reflectiz.com]. Sonnet's 2nd call
 * (after Yael said "I'm not a factor") dropped attendee_emails entirely.
 * Without it, the slot finder skipped Shayan's work-hours filter and
 * proposed Wed 13 12:30pm Israel = 7:30pm Sydney — way outside Shayan's
 * stated 4-6pm window.
 *
 * The auto-fill is non-destructive: pre-existing args win. Only fills
 * when the caller passed nothing.
 *
 * Process-global Map. Bounded by natural thread turnover.
 */

const attendeesByThread = new Map<string, Set<string>>();

/**
 * Record one or more emails used as attendees in a thread.
 */
export function recordThreadAttendees(threadTs: string | undefined, emails: string[]): void {
  if (!threadTs) return;
  const cleaned = emails
    .map(e => (e ?? '').toLowerCase().trim())
    .filter(e => e.includes('@'));
  if (cleaned.length === 0) return;
  let set = attendeesByThread.get(threadTs);
  if (!set) {
    set = new Set<string>();
    attendeesByThread.set(threadTs, set);
  }
  for (const e of cleaned) set.add(e);
}

/**
 * Return the emails recorded for this thread, or empty array when none.
 */
export function getThreadAttendees(threadTs: string | null | undefined): string[] {
  if (!threadTs) return [];
  const set = attendeesByThread.get(threadTs);
  return set ? Array.from(set) : [];
}
