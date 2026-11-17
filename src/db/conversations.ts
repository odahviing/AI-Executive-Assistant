import { getDb } from './client';

// ── Conversation threads ─────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant';
/** A refused booking is evidence for asking the owner, never permission to book. */
export interface RefusedBooking {
  sourceToolId: string;
  ownerId: string;
  requesterId: string;
  channelId: string;
  threadTs: string;
  reason: string;
  action: { tool: 'create_meeting'; args: Record<string, unknown> };
}
/** Human-authored scheduling details, scoped to a speaker and private thread. Never action authority. */
export interface MeetingRequestState {
  batch?: boolean;
  requestId?: string;
  requiredDay?: {date:string; zone:string; quote:string};
  bookingInstruction?: {kind:'exact'|'window'; text:string; localDate:string};
  individualSearchEmails?: string[];
  requesterPair?: boolean;
  participantGroups?: string[][];
  ownerId: string;
  requesterId: string;
  channelId: string;
  threadTs: string;
  original: string;
  updates: string[];
  clockZone?: {zone:string; quote:string};
  duration?: { minutes: number; quote: string };
}
export interface ConversationMessage {
  meetingRequest?: MeetingRequestState;
  role: MessageRole;
  content: string;
  ts?: string;
  /** Trusted runtime receipts on a confirmed delivered assistant turn only.
   * [] means a confirmed no-tool turn; absent means legacy/unknown. Never
   * populate from message prose, remote history, or user-supplied metadata. */
  toolSummaries?: string[];
  refusedBooking?: RefusedBooking;
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
  const { toolSummaries, refusedBooking, meetingRequest, ...plainMessage } = message;
  existing.push({
    ...plainMessage,
    ...(message.role === 'assistant' && Array.isArray(toolSummaries) && meetingRequest ? { meetingRequest } : {}),
    ...(message.role === 'assistant' && Array.isArray(toolSummaries) && refusedBooking ? { refusedBooking } : {}),
    ...(message.role === 'assistant' && Array.isArray(toolSummaries)
      && toolSummaries.every(line => typeof line === 'string')
      ? { toolSummaries: [...toolSummaries] } : {}),
  });
  // Keep last 20 messages in DB — orchestrator further trims by character count before sending
  const trimmed = existing.slice(-20);

  db.prepare(`
    INSERT INTO conversation_threads (thread_ts, channel_id, context)
    VALUES (@thread_ts, @channel_id, @context)
    ON CONFLICT(thread_ts) DO UPDATE SET context = @context, updated_at = datetime('now')
  `).run({ thread_ts: threadTs, channel_id: channelId, context: JSON.stringify(trimmed) });
}

/** Check the delivered operation again at dispatch. Retire it only after a durable approval exists. */
export function currentRefusedBooking(refusal: RefusedBooking, settled = false): boolean {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT context FROM conversation_threads WHERE thread_ts = ? AND channel_id = ?')
      .get(refusal.threadTs, refusal.channelId) as { context: string } | undefined;
    if (!row) return false;
    const history: ConversationMessage[] = JSON.parse(row.context);
    const current = [...history].reverse().find(message => message.role === 'assistant')?.refusedBooking;
    if (!current || current.sourceToolId !== refusal.sourceToolId || current.ownerId !== refusal.ownerId
      || current.requesterId !== refusal.requesterId || current.channelId !== refusal.channelId
      || current.threadTs !== refusal.threadTs || current.reason !== refusal.reason
      || JSON.stringify(current.action) !== JSON.stringify(refusal.action)) return false;
    if (!settled) return true;
    for (const message of history) {
      if (message.refusedBooking?.sourceToolId === refusal.sourceToolId) delete message.refusedBooking;
    }
    db.prepare('UPDATE conversation_threads SET context = ? WHERE thread_ts = ? AND channel_id = ?')
      .run(JSON.stringify(history), refusal.threadTs, refusal.channelId);
    return true;
  }).immediate();
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
