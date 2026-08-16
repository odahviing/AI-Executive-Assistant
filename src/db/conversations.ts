import { getDb } from './client';

// ── Conversation threads ─────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant';
export interface ConversationMessage {
  role: MessageRole;
  content: string;
  ts?: string;
}

export function getConversationHistory(threadTs: string): ConversationMessage[] {
  const db = getDb();
  const row = db.prepare('SELECT context FROM conversation_threads WHERE thread_ts = ?').get(threadTs) as any;
  if (!row) return [];
  // Defensive — a corrupt context blob must not wedge the thread. appendToConversation
  // reads this first, so an unguarded throw here would block BOTH reads and writes
  // for this thread on every turn thereafter.
  try {
    return JSON.parse(row.context) as ConversationMessage[];
  } catch {
    return [];
  }
}

export function appendToConversation(
  threadTs: string,
  channelId: string,
  message: ConversationMessage
): void {
  const db = getDb();
  const existing = getConversationHistory(threadTs);
  existing.push(message);
  // Keep last 20 messages in DB — orchestrator further trims by character count before sending
  const trimmed = existing.slice(-20);

  db.prepare(`
    INSERT INTO conversation_threads (thread_ts, channel_id, context)
    VALUES (@thread_ts, @channel_id, @context)
    ON CONFLICT(thread_ts) DO UPDATE SET context = @context, updated_at = datetime('now')
  `).run({ thread_ts: threadTs, channel_id: channelId, context: JSON.stringify(trimmed) });
}

/**
 * v3.3.7 (#125c) — verbatim recall. Flatten the most recent threads in a
 * channel into one message list (last `maxMessages`, oldest first). Used by
 * recall_interactions to ground "what did you tell X?" answers in what was
 * ACTUALLY exchanged, not the capture-pass summary — the summary-only answer
 * is how Maelle confidently misdescribed the Yael conversation (#125).
 * Thread order approximates chronology via updated_at; messages keep their
 * within-thread order.
 *
 * v4.5.8 (#198) — this is also the channel-scoped read path for re-reading a
 * subject's actual past messages (the social coda's LIB-side grounding calls
 * it via `../../db`). Answer 13: no new message table, no index, no backfill
 * — the raw text is already durable in `conversation_threads` and this is the
 * one reader over it. `maxThreads` was added (default unchanged at 5, so the
 * recall caller above is untouched) purely so a caller needing more of a
 * channel's history than the last 5 threads can ask for it without a second
 * copy of this query. A DM's channel_id is 1:1 with the person, so this never
 * widens what a caller sees beyond that person's own thread history.
 */
export function getRecentChannelMessages(
  channelId: string,
  maxMessages: number = 10,
  maxThreads: number = 5,
): Array<ConversationMessage & { thread_ts: string }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT thread_ts, context FROM conversation_threads
     WHERE channel_id = ?
     ORDER BY updated_at DESC
     LIMIT ?
  `).all(channelId, maxThreads) as Array<{ thread_ts: string; context: string }>;
  const all: Array<ConversationMessage & { thread_ts: string }> = [];
  for (const row of rows.reverse()) {  // oldest thread first
    try {
      const msgs = JSON.parse(row.context) as ConversationMessage[];
      for (const m of msgs) all.push({ ...m, thread_ts: row.thread_ts });
    } catch {
      // corrupt context row — skip, never break recall
    }
  }
  return all.slice(-maxMessages);
}

// ── v2.9.3 (#103) end-of-chat capture support ────────────────────────────────

/**
 * Find DM threads whose chat session looks "complete" and ready for the
 * Haiku end-of-chat capture pass.
 *
 * Definition of ready:
 *   - channel_id starts with 'D' (DM — MVP scope; MPIM/channel-mention come later)
 *   - the last message arrived ≥ `silenceMinutes` minutes ago (chat went quiet)
 *   - AND (captured_at IS NULL OR captured_at < updated_at) — fresh activity
 *     happened since the last capture, so there might be something new to learn
 *
 * Returns the thread metadata only; the caller (capturePass.ts) resolves the
 * colleague's slack_id via Slack API on a per-thread basis.
 *
 * Hard limit on count to keep the background loop bounded — we process up to
 * `limit` threads per tick; the rest catch the next tick.
 */
export function findThreadsReadyForCapture(
  silenceMinutes: number = 30,
  limit: number = 20,
): Array<{ thread_ts: string; channel_id: string; updated_at: string; captured_at: string | null }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT thread_ts, channel_id, updated_at, captured_at
      FROM conversation_threads
     WHERE channel_id LIKE 'D%'
       AND datetime('now') > datetime(updated_at, '+' || @minutes || ' minutes')
       AND (captured_at IS NULL OR captured_at < updated_at)
     ORDER BY updated_at ASC
     LIMIT @limit
  `).all({ minutes: silenceMinutes, limit }) as Array<{
    thread_ts: string;
    channel_id: string;
    updated_at: string;
    captured_at: string | null;
  }>;
  return rows;
}

/** Mark a thread as captured at the current moment. */
export function markThreadCaptured(threadTs: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE conversation_threads
       SET captured_at = datetime('now'), updated_at = updated_at
     WHERE thread_ts = ?
  `).run(threadTs);
}
