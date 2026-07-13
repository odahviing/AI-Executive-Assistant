/**
 * Shared timezone math for the scheduling tools (v3.4.2 — A1/A2).
 *
 * One implementation, used by find_available_slots (search) AND create_meeting /
 * move_meeting (write). Pre-fix, only find_available_slots converted a foreign-
 * zone clock time to the owner's zone (its inline `search_window_timezone`
 * handling); the write tools relied on Sonnet to do the ET→local arithmetic in
 * its head, which it got right sometimes and wrong other times (the Boston-trip
 * "9:30 EST → 13:30/14:30/16:00" thrash). Moving the math here makes every tool
 * convert identically and deterministically — Sonnet only TAGS the source zone,
 * it never does the arithmetic.
 */
import { DateTime } from 'luxon';

/**
 * Reinterpret a clock time that was STATED in `sourceTz` as the equivalent
 * instant expressed in `ownerTz` (the zone everything is stored/searched in).
 *
 * "9:30 in America/New_York" → the matching wall-clock in the owner's zone.
 * Returns `iso` unchanged when `sourceTz` is falsy (the common case — the time
 * was already given in the owner's zone) or when the parse fails (fail-safe).
 */
export function reinterpretClockInZone(
  iso: string,
  sourceTz: string | undefined | null,
  ownerTz: string,
): string {
  if (!sourceTz) return iso;
  const dt = DateTime.fromISO(iso, { zone: sourceTz });
  if (!dt.isValid) return iso;
  return dt.setZone(ownerTz).toISO() ?? iso;
}

/**
 * True if an ISO datetime carries an explicit zone — a trailing `Z` or `±HH:MM`
 * offset — i.e. it denotes a FIXED INSTANT, not a zoneless wall-clock. Used to
 * tell an already-anchored time (a search-emitted slot, or one a source-zone
 * conversion just produced — leave as-is) from a BARE time the owner typed
 * (which should be read in the relevant zone, never the server's). The zone
 * designator only ever follows the time, so we test the post-`T` part — the
 * date's own hyphens never trip it.
 */
export function isoHasExplicitZone(iso: string | undefined | null): boolean {
  if (!iso) return false;  // no string → no explicit zone (never .split undefined)
  const timePart = iso.split('T')[1] ?? '';
  return /[+\-Z]/i.test(timePart);
}

/**
 * Render an owner-zone instant in a target zone for display, with the short
 * offset name (e.g. "Tue 16 Jun 09:00 EDT"). Never emits the raw IANA string
 * (shipping "America/New_York" invites a "→ New York" location paste). Returns
 * '' on an invalid parse so callers can skip the parenthetical cleanly.
 */
export function renderClockInZone(iso: string, ownerTz: string, targetTz: string): string {
  const dt = DateTime.fromISO(iso, { zone: ownerTz }).setZone(targetTz);
  if (!dt.isValid) return '';
  return dt.toFormat('EEE d MMM HH:mm ZZZZ');
}
