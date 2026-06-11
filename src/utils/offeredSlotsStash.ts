/**
 * offeredSlotsStash (v3.3.8) — per-conversation memory of the slots Maelle
 * OFFERED a colleague, so a pick binds to the offered instant instead of
 * being re-derived from prose.
 *
 * Why: the coord state machine stored its offers on the job row
 * (`proposed_slots`) and parsed picks against them — deterministic. The
 * direct booking path (now THE colleague journey after the v3.3.8 coord
 * demotion) kept its offers only as prose in chat history, so a pick like
 * "יום שלישי 20:30" got its date re-resolved from scratch — and "Tuesday"
 * from a Wednesday split between Jun 16 (the offered one) and Jun 23,
 * producing a false "not free" on a slot that was open (the Liza interview
 * incident). Quiet variant of the same class: the wrong day is FREE and the
 * meeting books a week late, silently.
 *
 * This module is the missing state; the orchestrator injects it as a
 * binding block on later turns in the same conversation (same rail as the
 * availability pre-check verdicts). Sonnet stays the only decider — it just
 * receives the exact instants it offered.
 *
 * Keying mirrors inboundQueue.keyFor: a 1:1 DM is ONE conversation (every
 * top-level DM message gets its own threadTs, so thread-keying would never
 * match a pick to the offer); group surfaces keep per-thread separation.
 *
 * In-memory by design — an offer is conversational state, not durable data.
 * A restart drops open offers; the cost is one re-search, same as today.
 */
import { DateTime } from 'luxon';

export interface OfferedSlot {
  startIso: string;
  display: string;   // owner-TZ "Tuesday 2026-06-16 20:30" — unambiguous date
}

interface Entry {
  slots: OfferedSlot[];
  expiresAt: number;
}

/** Offers go stale with the conversation — 2h covers a same-sitting pick. */
const TTL_MS = 2 * 60 * 60 * 1000;

const stash: Map<string, Entry> = new Map();

function keyFor(channelId: string, threadTs?: string): string {
  return channelId.startsWith('D') ? channelId : `${channelId}|${threadTs ?? '_none_'}`;
}

/** Record the slots just offered in a conversation (replaces any prior offer). */
export function recordOfferedSlots(params: {
  channelId: string;
  threadTs?: string;
  timezone: string;                       // owner TZ — display is rendered here
  slots: Array<{ start: string }>;
}): void {
  const slots: OfferedSlot[] = [];
  for (const s of params.slots.slice(0, 6)) {
    const dt = DateTime.fromISO(s.start, { setZone: true }).setZone(params.timezone);
    if (!dt.isValid) continue;
    slots.push({ startIso: s.start, display: dt.toFormat('EEEE yyyy-MM-dd HH:mm') });
  }
  if (slots.length === 0) return;
  stash.set(keyFor(params.channelId, params.threadTs), {
    slots,
    expiresAt: Date.now() + TTL_MS,
  });
}

/** The offer currently on the table for this conversation, or null. */
export function getOfferedSlots(channelId: string, threadTs?: string): OfferedSlot[] | null {
  const key = keyFor(channelId, threadTs);
  const entry = stash.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    stash.delete(key);
    return null;
  }
  return entry.slots;
}

/**
 * Clear the offer once it's consumed (a booking landed in this conversation)
 * — a stale "bind to these" block after the meeting exists would mislead the
 * next exchange.
 */
export function clearOfferedSlots(channelId: string, threadTs?: string): void {
  stash.delete(keyFor(channelId, threadTs));
}
