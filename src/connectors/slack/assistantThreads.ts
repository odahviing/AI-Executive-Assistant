/**
 * Assistant thread tracking (v2.7.3).
 *
 * Slack's "assistant panel" is a separate UI surface from regular DMs. When a
 * user opens Maelle in the assistant panel, Slack fires `assistant_thread_started`
 * with the channel/thread coordinates of that assistant thread. Messages
 * exchanged there look like regular `message` events but support extra
 * affordances — chiefly `assistant.threads.setStatus` for a "Working…"
 * indicator while tools run.
 *
 * This module is the in-memory registry of "which threads ARE assistant
 * threads". The orchestrator's setStatus helper consults this before calling
 * the Slack API, so we don't spam status calls into regular DM threads
 * (which would error). Process-global Set, TTL'd to avoid unbounded growth.
 *
 * Lost on process restart — re-populated as users re-open assistant panels.
 * That's fine: the cost of missing setStatus calls until first event is
 * just a brief moment of silence in the panel.
 */

import logger from '../../utils/logger';

interface AssistantThreadKey {
  channelId: string;
  threadTs: string;
}

interface TrackedEntry {
  registeredAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;  // 24h — covers a full work day of assistant-panel use
const tracked = new Map<string, TrackedEntry>();

function keyOf({ channelId, threadTs }: AssistantThreadKey): string {
  return `${channelId}:${threadTs}`;
}

/**
 * Register a thread as an assistant-panel thread. Called from the
 * `assistant_thread_started` event handler.
 */
export function registerAssistantThread(key: AssistantThreadKey): void {
  const k = keyOf(key);
  tracked.set(k, { registeredAt: Date.now() });
  // Opportunistic GC — every register, sweep entries older than TTL.
  // Cheap (Map iteration), keeps the table bounded without a separate timer.
  const cutoff = Date.now() - TTL_MS;
  for (const [k2, entry] of tracked) {
    if (entry.registeredAt < cutoff) tracked.delete(k2);
  }
  logger.info('assistantThreads — registered', { channelId: key.channelId, threadTs: key.threadTs, total: tracked.size });
}

/**
 * True iff the given (channel, thread) has been seen via
 * assistant_thread_started within the TTL window.
 */
export function isAssistantThread(key: AssistantThreadKey): boolean {
  const k = keyOf(key);
  const entry = tracked.get(k);
  if (!entry) return false;
  if (Date.now() - entry.registeredAt > TTL_MS) {
    tracked.delete(k);
    return false;
  }
  return true;
}
