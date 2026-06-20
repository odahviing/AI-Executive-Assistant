/**
 * Per-thread event ledger (v3.4.2 — F1).
 *
 * Remembers the full Graph event_id of every meeting created/edited within a
 * Slack thread, so a later "rename it / add Chris / make it Weekly / move it"
 * edits the event BY ID instead of re-searching by name. Re-searching was the
 * root of two real failures: a just-written event lags in Graph's calendarView
 * for a few seconds (so get_calendar returns it late or not at all), AND the
 * date re-resolves to the wrong week under a long thread (the "Week Summary
 * doesn't appear" miss — it was on Jul 2, searched in late June).
 *
 * Owner path only in practice (the colleague path already carries this via the
 * requests spine — see core/orchestrator/index.ts colleagueBookingBlock). This
 * is the thread-scoped, owner-inclusive equivalent.
 *
 * In-memory, process-local. Keyed by threadTs. Capped per thread; entries don't
 * expire within a session (a booking thread is a single sitting). Cleared
 * naturally on process restart — acceptable, since referencing a stale id just
 * falls back to get_calendar.
 */

interface LedgerEntry {
  subject: string;
  eventId: string;
  dateIso: string;   // yyyy-MM-dd (owner TZ) of the event's start, '' if unknown
  at: number;
}

const MAX_PER_THREAD = 30;
const ledger = new Map<string, LedgerEntry[]>();

/** Record (or refresh) an event touched in this thread. Latest subject + date win. */
export function recordThreadEvent(threadTs: string, subject: string, eventId: string, dateIso = ''): void {
  if (!threadTs || !eventId) return;
  const existing = ledger.get(threadTs) ?? [];
  // De-dup by eventId — a rename/move updates the same row, keep one entry with
  // the freshest subject + date (a move changes the date).
  const deduped = existing.filter(e => e.eventId !== eventId);
  deduped.push({ subject: subject || 'a meeting', eventId, dateIso, at: Date.now() });
  ledger.set(threadTs, deduped.slice(-MAX_PER_THREAD));
}

/**
 * Drop an event from the thread ledger — call when it's DELETED, so a later
 * reference-back ("change the one I just booked", "move it") never resolves to a
 * dead event_id. Without this the ledger kept handing Sonnet an id Graph would
 * 404 on after a delete (rule 12 — reference-back must just work).
 */
export function forgetThreadEvent(threadTs: string, eventId: string): void {
  if (!threadTs || !eventId) return;
  const existing = ledger.get(threadTs);
  if (!existing) return;
  const filtered = existing.filter(e => e.eventId !== eventId);
  if (filtered.length !== existing.length) ledger.set(threadTs, filtered);
}

/** All events touched in this thread, oldest→newest. Empty when none. */
export function getThreadEvents(threadTs: string): LedgerEntry[] {
  if (!threadTs) return [];
  return ledger.get(threadTs) ?? [];
}

/**
 * v3.4.2 (F2) — the active planning window for this thread: the date span of
 * the events booked/edited this session. This is the TRAVEL-INDEPENDENT anchor
 * for bare day references ("Thursday", "the 1st") — once the owner has booked
 * for the week of Jun 28, "Thursday" means Jul 2, not the nearest calendar
 * Thursday. Pure conversation signal: no marker, no travel needed (so it works
 * for plain "plan my July" sessions). Returns null until at least one dated
 * event exists (the first reference may still need a clarify — fine).
 */
export function getActivePlanningWindow(threadTs: string): { from: string; until: string } | null {
  const dates = getThreadEvents(threadTs).map(e => e.dateIso).filter(Boolean).sort();
  if (dates.length === 0) return null;
  return { from: dates[0], until: dates[dates.length - 1] };
}
