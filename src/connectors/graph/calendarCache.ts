/**
 * Cross-turn calendar cache (#121).
 *
 * Background: `getCalendarEvents` / `getFreeBusy` were re-fetched cold on every
 * turn of a conversation (a single scheduling chat fired the same Graph queries
 * turn after turn). The per-turn `turnCache` dedups WITHIN a turn but dies at
 * turn end. This adds a short-TTL, cross-turn layer so Maelle's calendar
 * knowledge stays warm across a conversation — read once until a booking, then
 * refresh.
 *
 * THE INVARIANT: a read after a write must never return pre-write state. Every
 * calendar mutation (create/update/delete) calls `invalidateCalendarCache`,
 * which drops the owner's event ranges AND all free/busy entries (a write can
 * change an attendee's busy state too) — at BOTH read scopes: the cross-turn maps
 * here and the per-turn memo in `turnCache`. The TTL is the backstop for changes
 * we can't observe (owner edits in Outlook, a colleague moving something).
 *
 * Scope: both the owner's own events AND other people's free/busy are cached
 * (their calendars change like ours → same write-invalidation + TTL + the
 * explicit force-refresh path when someone asks Maelle to look at the calendar).
 *
 * Config: TTL via `CALENDAR_CACHE_TTL_SECONDS` (default 300 = 5 min, ON). Set
 * to 0 to disable the cache entirely (every read goes straight to Graph) — a
 * one-env-var kill switch, no code revert.
 */

import logger from '../../utils/logger';
import { getTurnCache } from '../../utils/turnCache';

interface CacheEntry<T> { data: T; fetchedAtMs: number; }

const eventsCache = new Map<string, CacheEntry<unknown>>();
const freeBusyCache = new Map<string, CacheEntry<unknown>>();

function ttlMs(): number {
  const raw = process.env.CALENDAR_CACHE_TTL_SECONDS;
  const s = raw === undefined ? 300 : Number(raw);
  return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
}

function getFresh<T>(cache: Map<string, CacheEntry<unknown>>, key: string): T | null {
  const ttl = ttlMs();
  if (ttl === 0) return null;             // disabled → always miss
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAtMs > ttl) { cache.delete(key); return null; }
  return entry.data as T;
}

function put<T>(cache: Map<string, CacheEntry<unknown>>, key: string, data: T): void {
  if (ttlMs() === 0) return;
  cache.set(key, { data, fetchedAtMs: Date.now() });
}

export function getCachedEvents<T>(key: string): T | null { return getFresh<T>(eventsCache, key); }
export function setCachedEvents<T>(key: string, data: T): void { put(eventsCache, key, data); }
export function getCachedFreeBusy<T>(key: string): T | null { return getFresh<T>(freeBusyCache, key); }
export function setCachedFreeBusy<T>(key: string, data: T): void { put(freeBusyCache, key, data); }

/**
 * Drop cached state after a calendar mutation. Removes the owner's event ranges
 * (keyed by `|<userEmail>|`) and ALL free/busy (a write can flip an attendee's
 * busy state, and free/busy keys aren't owner-scoped). Cheap — the next read
 * re-fetches. This is the guarantee that a read after a write is never stale.
 */
export function invalidateCalendarCache(userEmail: string, reason: string): void {
  let eventsDropped = 0;
  for (const key of [...eventsCache.keys()]) {
    if (key.includes(`|${userEmail}|`)) { eventsCache.delete(key); eventsDropped++; }
  }
  const freeBusyDropped = freeBusyCache.size;
  freeBusyCache.clear();
  // The per-turn memo is a read cache too, and it survives a mutation that happens
  // mid-turn — so the invariant has to hold at both scopes or a write followed by a
  // read inside one turn hands back pre-write state (create_meeting →
  // rebalanceFloatingBlocks re-reads the affected day in the same turn). It became
  // load-bearing the moment the decision reads (getOwnerEventsForDecision /
  // getFreeBusyForDecision) stopped consulting the cross-turn layer at all: the
  // memo is now the only cache standing between a booking and the next validation
  // of the slot it just filled. Same scoping as above — this owner's event windows,
  // every free/busy entry. `memoize` has no callers outside the two calendar reads,
  // so these two prefixes are the whole calendar surface of that Map.
  let memoDropped = 0;
  const turn = getTurnCache();
  if (turn) {
    for (const key of [...turn.keys()]) {
      const ownerEvents = key.startsWith('getCalendarEvents|') && key.includes(`|${userEmail}|`);
      if (ownerEvents || key.startsWith('getFreeBusy|')) { turn.delete(key); memoDropped++; }
    }
  }
  if (eventsDropped > 0 || freeBusyDropped > 0 || memoDropped > 0) {
    logger.info('calendarCache — invalidated after mutation', {
      userEmail, reason, eventsDropped, freeBusyDropped, memoDropped,
    });
  }
}
