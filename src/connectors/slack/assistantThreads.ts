/**
 * Assistant thread tracking (v2.7.3 + DB persistence).
 *
 * Slack's "assistant panel" is a separate UI surface from regular DMs. When a
 * user opens Maelle in the assistant panel, Slack fires `assistant_thread_started`
 * with the channel/thread coordinates of that assistant thread. Messages
 * exchanged there look like regular `message` events but support extra
 * affordances — chiefly `assistant.threads.setStatus` for a status indicator
 * while tools run.
 *
 * Registry shape: SQLite `assistant_threads` is the source of truth; a
 * process-local Set caches lookups so the per-tool-call `isAssistantThread`
 * check stays sync + cheap. The cache is populated on first hit from the DB,
 * or directly on register. Lost on restart — the next `isAssistantThread`
 * call repopulates from DB. 24h TTL is enforced at read time against
 * `registered_at`; older rows are deleted lazily.
 *
 * Why persist: pre-fix the registry was in-memory only. `assistant_thread_started`
 * fires only on FIRST open of a panel thread — Slack doesn't re-fire it on
 * bot reconnect. So after every `npm run dev` restart, existing open panel
 * threads stopped getting setStatus until the user closed and re-opened the
 * panel. The DB-backed registry survives restarts and avoids that gap.
 */

import { getDb } from '../../db/client';
import logger from '../../utils/logger';

interface AssistantThreadKey {
  channelId: string;
  threadTs: string;
}

const TTL_MS = 24 * 60 * 60 * 1000;  // 24h

const cacheHits = new Set<string>();
const cacheMisses = new Set<string>();

function keyOf({ channelId, threadTs }: AssistantThreadKey): string {
  return `${channelId}:${threadTs}`;
}

/**
 * Register a thread as an assistant-panel thread. Called from the
 * `assistant_thread_started` event handler. Idempotent (UPSERT on PK).
 */
export function registerAssistantThread(key: AssistantThreadKey): void {
  const k = keyOf(key);
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO assistant_threads (channel_id, thread_ts, registered_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(channel_id, thread_ts) DO UPDATE SET registered_at = datetime('now')
    `).run(key.channelId, key.threadTs);

    // Opportunistic TTL sweep on every register.
    const cutoff = new Date(Date.now() - TTL_MS).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`DELETE FROM assistant_threads WHERE registered_at < ?`).run(cutoff);

    cacheHits.add(k);
    cacheMisses.delete(k);
    logger.info('assistantThreads — registered', { channelId: key.channelId, threadTs: key.threadTs });
  } catch (err) {
    logger.warn('assistantThreads — register failed', {
      channelId: key.channelId, threadTs: key.threadTs, err: String(err).slice(0, 200),
    });
  }
}

/**
 * True iff the given (channel, thread) is a registered assistant-panel thread
 * within the TTL. Sync (the orchestrator's pre-tool-call hook needs sync) —
 * cache-first with one-time DB lookup on miss per process.
 *
 * v2.8.3+ — REFRESH ON ACTIVITY. Slack fires `assistant_thread_started` only
 * on FIRST panel open, never on subsequent messages. Pre-fix the row's
 * registered_at was frozen at first-open, so any panel session crossing the
 * 24h TTL would silently drop out of the registry — leaving the owner with
 * "no status indicator" for the same panel he uses daily. Now: every time
 * this function does a DB lookup that finds a valid row, registered_at is
 * bumped to NOW. Active panels stay registered indefinitely. Truly idle
 * panels (panel closed, never used again) still expire after 24h of no
 * lookups. The TTL still gets the deletion sweep on register and on stale
 * read; only the TIMER restarts.
 *
 * Process-local cache (`cacheHits`) is per-run only. After every restart
 * the cache rebuilds from DB lookups, which refresh registered_at. So the
 * combination of (frequent dev restarts + refresh-on-lookup) keeps the
 * row alive without needing to refresh on every cached hit.
 */
/**
 * All registered assistant-panel threads still within the TTL window. Used by
 * the on-restart catch-up (background.ts) to know which panel threads to scan
 * for missed messages — panel messages are thread replies that the DM
 * `conversations.history` scan can't see. Read-only; does not bump TTL.
 */
export function getActiveAssistantThreads(): AssistantThreadKey[] {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - TTL_MS).toISOString().replace('T', ' ').slice(0, 19);
    const rows = db.prepare(`
      SELECT channel_id, thread_ts FROM assistant_threads
      WHERE registered_at >= ?
      ORDER BY registered_at DESC
    `).all(cutoff) as Array<{ channel_id: string; thread_ts: string }>;
    return rows.map(r => ({ channelId: r.channel_id, threadTs: r.thread_ts }));
  } catch (err) {
    logger.warn('getActiveAssistantThreads failed', { err: String(err).slice(0, 200) });
    return [];
  }
}

export function isAssistantThread(key: AssistantThreadKey): boolean {
  const k = keyOf(key);
  if (cacheHits.has(k)) return true;
  if (cacheMisses.has(k)) return false;

  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT registered_at FROM assistant_threads
      WHERE channel_id = ? AND thread_ts = ?
    `).get(key.channelId, key.threadTs) as { registered_at: string } | undefined;

    if (!row) {
      cacheMisses.add(k);
      return false;
    }

    // TTL check against the EXISTING registered_at — if the row hasn't been
    // touched in 24h+, drop it. Otherwise refresh registered_at to now so
    // active panels never expire.
    const registeredAtMs = Date.parse(row.registered_at.replace(' ', 'T') + 'Z');
    if (Date.now() - registeredAtMs > TTL_MS) {
      db.prepare(`DELETE FROM assistant_threads WHERE channel_id = ? AND thread_ts = ?`)
        .run(key.channelId, key.threadTs);
      cacheMisses.add(k);
      return false;
    }

    // Within TTL — refresh the timestamp so the row stays alive while the
    // panel is being actively used. Fire-and-forget feel; this is a 1-row
    // UPDATE so cost is negligible.
    try {
      db.prepare(`UPDATE assistant_threads SET registered_at = datetime('now') WHERE channel_id = ? AND thread_ts = ?`)
        .run(key.channelId, key.threadTs);
    } catch (_) { /* refresh is opportunistic; never block the read */ }

    cacheHits.add(k);
    return true;
  } catch (err) {
    logger.debug('isAssistantThread DB read failed (non-fatal)', { err: String(err).slice(0, 200) });
    return false;
  }
}
