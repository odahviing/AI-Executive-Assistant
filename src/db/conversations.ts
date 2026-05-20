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
  return JSON.parse(row.context);
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
