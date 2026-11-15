import type { App } from '@slack/bolt';

export type SlackHistoryMessage = Record<string, any>;

/** A broadcast is a text reply. Slack's nested root is display context only. */
export function humanBroadcastParent(message: SlackHistoryMessage, botUserId?: string | null): string | undefined {
  if (message.subtype !== 'thread_broadcast' || typeof message.user !== 'string' || !message.user || message.user === botUserId
    || message.bot_id || message.bot_profile || message.app_id || message.hidden
    || typeof message.text !== 'string' || !message.text.trim() || message.files?.length) return;
  const { ts, thread_ts } = message;
  if (typeof ts === 'string' && typeof thread_ts === 'string' && ts !== thread_ts
    && /^\d+\.\d+$/.test(ts) && /^\d+\.\d+$/.test(thread_ts)) return thread_ts;
}

/** Read the current tail, not the first page of an old thread. Never return
 * a partial first page as though it were current when pagination fails. */
export async function readSlackThread(
  client: App['client'], token: string, channel: string, ts: string, keep = 50,
): Promise<SlackHistoryMessage[]> {
  let cursor: string | undefined;
  let messages: SlackHistoryMessage[] = [];
  const seen = new Set<string>();
  do {
    const page = await client.conversations.replies({ token, channel, ts, limit: 200, cursor });
    if (!page.ok || !Array.isArray(page.messages)) throw new Error('Slack thread unavailable');
    messages.push(...((page.messages ?? []) as SlackHistoryMessage[]));
    messages.sort((a, b) => Number(a.ts) - Number(b.ts));
    if (Number.isFinite(keep)) messages = messages.slice(-keep);
    cursor = page.response_metadata?.next_cursor || undefined;
    if (page.has_more && !cursor) throw new Error('Slack thread pagination incomplete');
    if (cursor && seen.has(cursor)) throw new Error('Slack thread pagination repeated');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return messages;
}
