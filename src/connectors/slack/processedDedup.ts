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
// v2.7.0 — bumped 60s → 10min. Slack socket mode is at-least-once: when the
// bot disconnects (e.g. `npm run dev` restart) Slack queues events and
// re-delivers on reconnect. The retry window can run several minutes after
// the catch-up flow has already processed and marked the message. 60s TTL
// expired before that retry landed → duplicate orchestrator turn → duplicate
// reply. 10min covers realistic socket-reconnect retry windows with no
// downside (memory cost negligible; ts collisions are essentially impossible
// at Slack's microsecond ts precision).
const TTL_MS = 10 * 60 * 1000;

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

// v2.8.7 — content-based dedup for the "same message, different ts" case.
// Slack's AI assistant panel can mirror an MPIM message into the panel
// thread, producing a SECOND event with a DIFFERENT ts than the main
// channel's event. ts-based markProcessed dedup never fires; both events
// drive full orchestrator turns; owner sees a duplicate reply in two
// different thread anchors (root of 2026-05-19 "Maelle replied outside
// the thread" incident — two events with ts=...554 and ts=...508 for the
// identical "Hi @Maelle I need a meeting with @Mayrav..." message).
//
// Key shape: `${channelId}|${senderId}|${textHash}`. Hash is a stable
// 32-bit fold over the message text — Slack will deliver the exact same
// text bytes on both events, so a simple hash collides them deterministically.
// TTL is short (90s) — long enough to cover Slack's mirror delay window,
// short enough that legitimately repeated content (owner typing the same
// phrase twice on purpose) is treated as new.
const processedContent: Set<string> = new Set();
const CONTENT_TTL_MS = 90 * 1000;

function hashString(s: string): string {
  // FNV-1a-ish 32-bit; deterministic and cheap. No security needs here —
  // just a stable key for in-memory dedup.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Mark a (channel, sender, text) tuple as seen. Returns true if it was
 * newly added; false if the same content from the same sender in the same
 * channel was already processed within the 90s TTL — caller should skip
 * to avoid duplicate orchestrator runs from Slack assistant-panel mirrors.
 */
export function markContentProcessed(channelId: string, senderId: string, text: string): boolean {
  const key = `${channelId}|${senderId}|${hashString(text)}`;
  if (processedContent.has(key)) return false;
  processedContent.add(key);
  setTimeout(() => processedContent.delete(key), CONTENT_TTL_MS);
  return true;
}
