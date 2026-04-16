/**
 * In-memory rate limiters for abuse prevention.
 *
 * Keyed by whatever the caller passes (usually `${senderUserId}:${threadTs}`).
 * Windows are sliding — old hits expire after windowMs.
 *
 * These are defense-in-depth signals. The primary gate against abuse is the
 * security filter + coord guards. Rate limits catch the case where a malicious
 * colleague tries to brute-force repeated tool calls in a short burst.
 */

import logger from './logger';

interface Limiter {
  windowMs: number;
  max: number;
  hits: Map<string, number[]>; // key → array of hit timestamps
}

const limiters = new Map<string, Limiter>();

/**
 * Register a named limiter. Safe to call multiple times (idempotent).
 */
export function registerLimiter(name: string, windowMs: number, max: number): void {
  if (!limiters.has(name)) {
    limiters.set(name, { windowMs, max, hits: new Map() });
  }
}

/**
 * Check a limiter. Returns { allowed, remaining, resetInMs }.
 * If allowed, the hit is recorded.
 */
export function checkAndRecord(name: string, key: string): { allowed: boolean; remaining: number; resetInMs: number } {
  const limiter = limiters.get(name);
  if (!limiter) {
    logger.warn('Rate limiter not registered — allowing by default', { name });
    return { allowed: true, remaining: Infinity, resetInMs: 0 };
  }

  const now = Date.now();
  const cutoff = now - limiter.windowMs;
  const existing = limiter.hits.get(key) ?? [];
  const recent = existing.filter(ts => ts > cutoff);

  if (recent.length >= limiter.max) {
    const oldestInWindow = recent[0];
    const resetInMs = limiter.windowMs - (now - oldestInWindow);
    logger.warn('⚠ Rate limit hit', {
      limiter: name,
      key,
      hits: recent.length,
      max: limiter.max,
      windowMs: limiter.windowMs,
      resetInMs,
    });
    limiter.hits.set(key, recent);
    return { allowed: false, remaining: 0, resetInMs };
  }

  recent.push(now);
  limiter.hits.set(key, recent);
  return { allowed: true, remaining: limiter.max - recent.length, resetInMs: 0 };
}

/**
 * Periodically clear out old entries to prevent unbounded memory growth.
 */
function sweep(): void {
  const now = Date.now();
  for (const limiter of limiters.values()) {
    const cutoff = now - limiter.windowMs;
    for (const [key, hits] of limiter.hits.entries()) {
      const recent = hits.filter(ts => ts > cutoff);
      if (recent.length === 0) limiter.hits.delete(key);
      else limiter.hits.set(key, recent);
    }
  }
}

setInterval(sweep, 60_000).unref();

// ── Register default limiters ───────────────────────────────────────────────

// Colleague tool calls per thread — max 3 coordinate_meeting attempts per 10 min
registerLimiter('colleague_coord', 10 * 60 * 1000, 3);

// Generic colleague tool call budget — max 10 any-tool calls per 5 min per sender per thread
registerLimiter('colleague_any_tool', 5 * 60 * 1000, 10);
