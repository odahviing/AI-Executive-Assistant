import type { App } from '@slack/bolt';

export type SlackHistoryMessage = Record<string, any>;

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
    if (!page.ok) throw new Error('Slack thread unavailable');
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
