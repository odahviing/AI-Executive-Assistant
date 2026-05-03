/**
 * Per-turn caching scope (v2.4.3, A3).
 *
 * Background: a single orchestrator turn often re-queries the same data
 * multiple times because (a) Sonnet calls multiple tools that each fetch
 * independently, (b) the same find_available_slots call internally fetches
 * the calendar for floating-block detection AND for the slot walker, and
 * (c) iterations of Sonnet's tool loop may re-issue the same query. Owner
 * trace from 2026-05-03 showed 5 identical Graph calendar queries within
 * 12 seconds for the SAME date range — pure waste.
 *
 * This helper exposes a per-turn cache via AsyncLocalStorage so any code
 * inside an orchestrator turn can opt-in to memoization. Cache lifecycle
 * matches the turn exactly:
 *   - Created when runOrchestrator wraps the turn in withTurnCache().
 *   - Lives only for the duration of the turn (one per thread, one per turn).
 *   - Cleaned up automatically when the wrapped function returns —
 *     AsyncLocalStorage scope tears down, the Map is GC'd.
 *   - Different threads never share a cache (different async contexts).
 *
 * Per owner direction: short-lived, per-thread. Calendar state changes
 * frequently — long TTLs would be stale; per-turn TTL is the right window
 * (the user is having one conversation, the calendar isn't moving under
 * her between Sonnet's tool iterations).
 *
 * Code outside an orchestrator turn (background tasks, dispatchers, brief
 * generation) sees `getTurnCache()` return undefined and bypasses memo —
 * safe default, no opt-in change required.
 */

import { AsyncLocalStorage } from 'async_hooks';

/**
 * Cache shape: arbitrary string keys → arbitrary values (typed by caller).
 * Promise values supported so concurrent callers within the same turn share
 * one in-flight fetch instead of firing duplicates.
 */
export type TurnCache = Map<string, unknown>;

const storage = new AsyncLocalStorage<TurnCache>();

/**
 * Run `fn` inside a fresh per-turn cache. The orchestrator wraps each turn
 * in this; all downstream `getTurnCache()` calls see the same Map for the
 * duration of the run. Returns whatever `fn` returns.
 */
export function withTurnCache<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const cache: TurnCache = new Map();
  return storage.run(cache, fn);
}

/**
 * Returns the active turn cache, or undefined when called outside a
 * runOrchestrator turn (background tasks, dispatchers, brief generation).
 * Callers should treat undefined as "no memo, fetch normally".
 */
export function getTurnCache(): TurnCache | undefined {
  return storage.getStore();
}

/**
 * Convenience wrapper: get-or-fetch with promise sharing. When the cache is
 * absent (no active turn), just calls `fetch()`. When present, dedups by
 * key — the FIRST caller's promise is stored; subsequent callers within
 * the same turn await that same promise.
 *
 * Use for any expensive read where the same args within a turn yield the
 * same result.
 */
export async function memoize<T>(key: string, fetch: () => Promise<T>): Promise<T> {
  const cache = getTurnCache();
  if (!cache) return fetch();
  const hit = cache.get(key);
  if (hit !== undefined) return hit as Promise<T>;
  const promise = fetch();
  cache.set(key, promise);
  return promise;
}
