/**
 * Thread activity tracker (v2.6.5).
 *
 * Two halves of one mechanism:
 *   1. An in-process Map of "the most recent message Maelle sent in this thread."
 *      Updated on every successful outbound from postReply.ts.
 *   2. `reactActivityComplete` — the ✅ tick that gets put ON that message when a
 *      piece of work in the thread actually finishes.
 *
 * Why this exists: the v2.6.2 emoji-feedback change reacted ✅ on EVERY Maelle
 * reply, which was annoying mid-flow. The owner's intent was "react when an
 * activity completes." So the tick is fired by whichever code completes the
 * work, and this module remembers which message ts to put it on.
 *
 * Process-global Map. Bounded by natural turnover — only the most-recent
 * entry per threadTs is kept. No TTL needed at this volume; a long-running
 * process accumulates ~1 entry per active thread.
 *
 * Bypassed for messages with no thread (top-level channel posts) since
 * there's nothing to track against.
 */

import logger from './logger';

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
 * Look up the most recent Maelle message in a thread. Used by the completion
 * tick below, and by postReply's coda lull check ("has she said something else
 * since I composed this?").
 */
export function getLastMaelleMessage(threadTs: string | null | undefined): MaelleMessageRef | null {
  if (!threadTs) return null;
  return lastMessageByThread.get(threadTs) ?? null;
}

/**
 * Tick ✅ on Maelle's most recent message in a thread — "the thing you asked
 * for in here is done."
 *
 * Called by whichever code finished the work:
 *   - tasks/completeTask, for the task-table dispatchers (routine, calendar_fix,
 *     summary_action_followup, social_*).
 *   - the message_colleague send path, for a fire-and-forget send (v4.2.x). That
 *     send used to mint a throwaway `tasks` row with status='completed' purely so
 *     createTask's react hook would fire; the row is gone (no dispatcher owned
 *     it, so the sweep marked it 'failed' at its due_at) and the send path now
 *     calls straight through.
 *
 * Fire-and-forget: wrapped in setImmediate so the caller returns without waiting
 * on the transport, and failures are non-fatal. Threads with no recorded Maelle
 * message (system work, background routines) skip silently — nothing to react on.
 * `ref` is only for the failure log (a task id, an outreach job id).
 */
export function reactActivityComplete(ownerUserId: string, threadTs: string, ref: string): void {
  setImmediate(async () => {
    try {
      const msg = getLastMaelleMessage(threadTs);
      if (!msg) return;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getConnection } = require('../connections/registry') as typeof import('../connections/registry');
      const conn = getConnection(ownerUserId, 'slack');
      if (conn?.reactToMessage) {
        await conn.reactToMessage(msg.channelId, msg.messageTs, 'white_check_mark');
      }
    } catch (err) {
      logger.warn('completion react ✅ failed — non-fatal', { ref, err: String(err).slice(0, 200) });
    }
  });
}
