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
