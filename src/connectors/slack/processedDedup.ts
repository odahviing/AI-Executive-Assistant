/**
 * Cross-handler message dedup.
 *
 * The live Slack handler used to keep a local `processedTs` Set inside the
 * app closure. That worked for the "Slack retried the event within a few
 * seconds because we didn't ack in time" case, but missed two others:
 *
 *   1. The catch-up path (core/background.ts) replies to a missed message,
 *      then Slack delivers the SAME event to the live socket handler — the
 *      local Set didn't know what catch-up did → duplicate reply.
 *   2. Multiple Bolt handlers for the same message (DM / MPIM / app_mention)
 *      can race on the same ts — one would win, the other would also post.
 *
 * This module hoists the Set to process-global and exposes mark/has/unmark.
 * Both catch-up and all live handlers share it. Short TTL (60s) — same as
 * before — enough to cover Slack retry windows without leaking memory.
 */

const processedTs: Set<string> = new Set();
const TTL_MS = 60_000;

/**
 * Mark a message ts as handled. Returns true if it was newly added;
 * false if it was already there (caller should skip processing).
 */
export function markProcessed(ts: string): boolean {
  if (processedTs.has(ts)) return false;
  processedTs.add(ts);
  setTimeout(() => processedTs.delete(ts), TTL_MS);
  return true;
}

export function hasProcessed(ts: string): boolean {
  return processedTs.has(ts);
}

export function unmarkProcessed(ts: string): void {
  processedTs.delete(ts);
}
