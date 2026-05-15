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
 */
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

    // TTL check.
    const registeredAtMs = Date.parse(row.registered_at.replace(' ', 'T') + 'Z');
    if (Date.now() - registeredAtMs > TTL_MS) {
      db.prepare(`DELETE FROM assistant_threads WHERE channel_id = ? AND thread_ts = ?`)
        .run(key.channelId, key.threadTs);
      cacheMisses.add(k);
      return false;
    }

    cacheHits.add(k);
    return true;
  } catch (err) {
    logger.debug('isAssistantThread DB read failed (non-fatal)', { err: String(err).slice(0, 200) });
    return false;
  }
}
