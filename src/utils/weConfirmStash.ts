/**
 * weConfirmStash (v3.5.x) — per-conversation memory that Maelle has ALREADY
 * shown the owner the dual-clock trip-time for a Working-Elsewhere slot and is
 * waiting on his confirm. When he re-issues the SAME booking, the trip-time
 * gate is satisfied DETERMINISTICALLY — the loop no longer depends on the model
 * remembering to set `we_acknowledged` (it didn't: the 2026-06-29 Boston "11am
 * ET" infinite re-confirm, where the owner said yes four times and nothing
 * booked because the flag was never carried on the retry).
 *
 * Same rail as offeredSlotsStash: in-memory, per-conversation, TTL'd. The WE
 * confirm still fires ONCE — the first create_meeting records the instant. The
 * owner's re-issue of that SAME instant in the SAME conversation clears the
 * gate. A different instant, or a different conversation, gets its own fresh
 * confirm — so this can never auto-book a trip-time the owner hasn't seen.
 *
 * Keying mirrors offeredSlotsStash/inboundQueue: a 1:1 DM is ONE conversation;
 * group surfaces keep per-thread separation. In-memory by design — a restart
 * drops pending confirms; the cost is one extra confirm, same as today.
 */

/** A pending confirm goes stale with the conversation — 2h covers a sitting. */
const TTL_MS = 2 * 60 * 60 * 1000;

interface Entry { instants: Set<number>; expiresAt: number }

const stash: Map<string, Entry> = new Map();

function keyFor(channelId: string, threadTs?: string): string {
  return channelId.startsWith('D') ? channelId : `${channelId}|${threadTs ?? '_none_'}`;
}

/** Epoch ms of the slot start — format-agnostic so a re-ask in any TZ string matches. */
function instantMs(startIso: string): number | null {
  const ms = Date.parse(startIso);
  return Number.isFinite(ms) ? ms : null;
}

/** Record that the WE trip-time confirm was shown for this slot in this conversation. */
export function recordWeConfirmShown(channelId: string, threadTs: string | undefined, startIso: string): void {
  const ms = instantMs(startIso);
  if (ms === null) return;
  const key = keyFor(channelId, threadTs);
  const prior = stash.get(key);
  const instants = prior && Date.now() <= prior.expiresAt ? prior.instants : new Set<number>();
  instants.add(ms);
  stash.set(key, { instants, expiresAt: Date.now() + TTL_MS });
}

/**
 * True if the owner was already shown this slot's trip-time in this conversation
 * — and CONSUMES it (one auto-acknowledge per shown instant). If the same time
 * comes back AGAIN it re-confirms, giving the owner a fresh chance to correct,
 * instead of silently auto-booking it on every re-issue (the repeated auto-lock
 * that compounded the 2026-06-29 wrong-time book — it kept confirming a disputed
 * instant across three corrections). The resolver now makes the instant correct;
 * consume-on-use is the belt so a re-issue is never treated as a standing yes.
 */
export function consumeWeConfirmShown(channelId: string, threadTs: string | undefined, startIso: string): boolean {
  const ms = instantMs(startIso);
  if (ms === null) return false;
  const key = keyFor(channelId, threadTs);
  const entry = stash.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    stash.delete(key);
    return false;
  }
  if (!entry.instants.has(ms)) return false;
  entry.instants.delete(ms);
  if (entry.instants.size === 0) stash.delete(key);
  return true;
}
