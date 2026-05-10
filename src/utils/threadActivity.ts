/**
 * Thread activity tracker (v2.6.5).
 *
 * In-process Map of "the most recent message Maelle sent in this thread."
 * Updated on every successful outbound from postReply.ts; consumed by the
 * tasks/completeTask hook which reacts ✅ on the recorded message when a
 * task transitions to completed.
 *
 * Why this exists: the v2.6.2 emoji-feedback change reacted ✅ on EVERY
 * Maelle reply, which was annoying mid-flow. The owner's intent was "react
 * when an activity completes." The task system already tracks activity
 * lifecycle — when completeTask fires, we react on the most recent Maelle
 * message in the task's thread. That requires remembering which message ts
 * was the most recent.
 *
 * Process-global Map. Bounded by natural turnover — only the most-recent
 * entry per threadTs is kept. No TTL needed at this volume; a long-running
 * process accumulates ~1 entry per active thread.
 *
 * Bypassed for messages with no thread (top-level channel posts) since
 * there's nothing to track against.
 */

interface MaelleMessageRef {
  channelId: string;
  messageTs: string;
}

const lastMessageByThread = new Map<string, MaelleMessageRef>();

/**
 * Record a Maelle outbound message. Called from postReply.ts after a
 * successful `say()`.
 */
export function recordMaelleMessage(threadTs: string | undefined, channelId: string, messageTs: string): void {
  if (!threadTs || !messageTs) return;
  lastMessageByThread.set(threadTs, { channelId, messageTs });
}

/**
 * Look up the most recent Maelle message in a thread. Used by the
 * completeTask hook to find what to react ✅ on.
 */
export function getLastMaelleMessage(threadTs: string | null | undefined): MaelleMessageRef | null {
  if (!threadTs) return null;
  return lastMessageByThread.get(threadTs) ?? null;
}
