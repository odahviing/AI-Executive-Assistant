/** Last explicit roster for an individual scheduling request. */
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
  attendeesByThread.delete(threadTs);
  attendeesByThread.set(threadTs, new Set(cleaned));
  if (attendeesByThread.size > 2048) {
    const oldest = attendeesByThread.keys().next().value;
    if (oldest) attendeesByThread.delete(oldest);
  }
}

/**
 * Return the emails recorded for this thread, or empty array when none.
 */
export function getThreadAttendees(threadTs: string | null | undefined): string[] {
  if (!threadTs) return [];
  const set = attendeesByThread.get(threadTs);
  return set ? Array.from(set) : [];
}
