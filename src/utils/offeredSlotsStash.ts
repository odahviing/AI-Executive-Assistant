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
 *
 * v4.3.0 (#24 E7) — ONE exception: the email leg. A Slack pick round-trips in
 * the same sitting (minutes); an email pick round-trips through a human
 * forwarding a reply, hours or overnight — sharing Slack's 2h in-memory TTL
 * would silently expire the offer mid-flight and push the picker back onto
 * re-deriving the date from quoted prose (the exact class this module exists
 * to prevent). So an offer's binding lifetime follows the conversation's
 * TEMPO, not one global constant: email-channel keys (the stable
 * `email:<conversationId>` key E4 mints) get a longer TTL AND survive a
 * process restart (a redeploy mid-flight must not drop them either).
 * Detected purely from the KEY PREFIX — no caller has to know or pass this;
 * Slack keys never start with `email:` so their behavior is byte-for-byte
 * unchanged. Persistence mirrors `connectors/slack/socketWatermark.ts`'s
 * idiom (small JSON file in data/, loaded once lazily) rather than a new SQL
 * table — email traffic is low-frequency, so a synchronous write on every
 * mutation (record/clear) needs no debounce.
 */
import { DateTime } from 'luxon';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import logger from './logger';

export interface OfferedSlot {
  startIso: string;
  display: string;   // owner-TZ "Tuesday 2026-06-16 20:30" — unambiguous date
}

interface Entry {
  slots: OfferedSlot[];
  expiresAt: number;
  // v3.7.2 (#142a) — the shaping params (duration | window | attendees) of the
  // search that produced these offers. The exclusion only drops offered slots
  // when a later search REPEATS this shape (a true "give me another option"); a
  // refinement re-parametrizes the same ask and must NOT exclude.
  searchFingerprint?: string;
}

/** Offers go stale with the conversation — 2h covers a same-sitting Slack pick. */
const TTL_MS = 2 * 60 * 60 * 1000;

/** The email leg's round trip is a human forwarding mail, not a chat reply —
 *  hours to overnight. ~48h per the owner's tempo-based call (#24 E7). */
const EMAIL_TTL_MS = 48 * 60 * 60 * 1000;
const EMAIL_KEY_PREFIX = 'email:';

/** Every email-transport key is `email:<conversationId>` (E4) composed through
 *  keyFor below — so a plain prefix test is a complete, caller-free signal. */
function ttlForKey(key: string): number {
  return key.startsWith(EMAIL_KEY_PREFIX) ? EMAIL_TTL_MS : TTL_MS;
}

const stash: Map<string, Entry> = new Map();

function keyFor(channelId: string, threadTs?: string): string {
  return channelId.startsWith('D') ? channelId : `${channelId}|${threadTs ?? '_none_'}`;
}

// ── Restart-survival for the email leg only (#24 E7) ────────────────────────
// Slack entries are never written here — losing them on restart is accepted
// (documented above); email entries must survive one because a redeploy can
// land mid-forward.
const PERSIST_FILE = join(process.cwd(), 'data', 'offered-slots-email.json');
let emailEntriesLoaded = false;

function loadPersistedEmailEntries(): void {
  if (emailEntriesLoaded) return;
  emailEntriesLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(PERSIST_FILE, 'utf8')) as Record<string, Entry>;
    const now = Date.now();
    for (const [key, entry] of Object.entries(raw)) {
      // Defensive re-check — never resurrect something that expired while
      // the process was down.
      if (entry && entry.expiresAt > now) stash.set(key, entry);
    }
  } catch {
    // No file yet (first run) or unreadable — treated as "nothing to restore".
  }
}

/** Re-derives the persisted file from whatever email-prefixed keys are
 *  currently in `stash` — called after every mutation that could touch one.
 *  Cheap: the map is small and bounded (MAX_OFFERED per conversation). */
function persistEmailEntries(): void {
  try {
    const out: Record<string, Entry> = {};
    const now = Date.now();
    for (const [key, entry] of stash.entries()) {
      // Prune anything already expired so a thread nobody ever reads again
      // (no further getLiveEntry call to trigger the usual evict-on-read)
      // doesn't grow the file forever.
      if (key.startsWith(EMAIL_KEY_PREFIX) && entry.expiresAt > now) out[key] = entry;
    }
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(PERSIST_FILE, JSON.stringify(out), 'utf8');
  } catch (err) {
    logger.warn('offeredSlotsStash — email persist failed (non-fatal, in-memory copy still live)', {
      err: String(err).slice(0, 150),
    });
  }
}

/** Max offered slots retained per conversation (the union across re-asks). */
const MAX_OFFERED = 12;

/**
 * Record the slots just offered in a conversation. v3.4.2 — ACCUMULATES (union),
 * does NOT replace: each new offer ADDS to what's been shown, so "give me
 * another option" can exclude the union of everything already offered (not just
 * the last batch) and keep advancing day after day. It also lets a pick bind to
 * a slot shown in an earlier batch. Deduped by startIso, capped, TTL refreshed.
 */
export function recordOfferedSlots(params: {
  channelId: string;
  threadTs?: string;
  timezone: string;                       // owner TZ — display is rendered here
  slots: Array<{ start: string }>;
  // v3.7.2 (#142a) — fingerprint of THIS search's shape (duration|window|
  // attendees). Passed by the spread-search recorder; OMITTED by the point-check
  // recorder — preserve-on-omit below keeps the spread fingerprint intact.
  searchFingerprint?: string;
}): void {
  // D8 — no per-call `slice(0, 6)`. It was a second, silent bound competing with
  // MAX_OFFERED (the real cap, applied to the merged union below) and with the
  // configured offered_slot_count (M6): a profile offering 8 slots recorded 6,
  // and a proposed-alternatives payload — requested-day options THEN the widening
  // — dropped exactly the widened ones, so a pick from the second list came back
  // "I never offered you that". One cap, at the end, on the union.
  const fresh: OfferedSlot[] = [];
  for (const s of params.slots) {
    const dt = DateTime.fromISO(s.start, { setZone: true }).setZone(params.timezone);
    if (!dt.isValid) continue;
    fresh.push({ startIso: s.start, display: dt.toFormat('EEEE yyyy-MM-dd HH:mm') });
  }
  if (fresh.length === 0) return;
  const key = keyFor(params.channelId, params.threadTs);
  // Gate the lazy load on the key itself — a Slack-only deployment (or any
  // turn on a Slack key) never touches the filesystem for this module at all.
  if (key.startsWith(EMAIL_KEY_PREFIX)) loadPersistedEmailEntries();
  const prior = stash.get(key);
  const priorFresh = prior && Date.now() <= prior.expiresAt ? prior : undefined;
  const merged = priorFresh ? [...priorFresh.slots] : [];
  const seen = new Set(merged.map(o => o.startIso));
  for (const f of fresh) {
    if (!seen.has(f.startIso)) { merged.push(f); seen.add(f.startIso); }
  }
  stash.set(key, {
    slots: merged.slice(-MAX_OFFERED),
    expiresAt: Date.now() + ttlForKey(key),
    // Preserve-on-omit: the point-check recorder omits searchFingerprint, so an
    // interleaved "is he free at X?" confirmation can't wipe the spread search's.
    searchFingerprint: params.searchFingerprint ?? priorFresh?.searchFingerprint,
  });
  if (key.startsWith(EMAIL_KEY_PREFIX)) persistEmailEntries();
}

/** TTL-guarded entry lookup — evicts a stale conversation on read. ONE expiry
 *  rule, shared by the slot accessor and the fingerprint accessor (no dup). */
function getLiveEntry(channelId: string, threadTs?: string): Entry | null {
  const key = keyFor(channelId, threadTs);
  // Same gate as recordOfferedSlots — no filesystem touch for a Slack key.
  if (key.startsWith(EMAIL_KEY_PREFIX)) loadPersistedEmailEntries();
  const entry = stash.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    stash.delete(key);
    if (key.startsWith(EMAIL_KEY_PREFIX)) persistEmailEntries();
    return null;
  }
  return entry;
}

/** The offer currently on the table for this conversation, or null. */
export function getOfferedSlots(channelId: string, threadTs?: string): OfferedSlot[] | null {
  return getLiveEntry(channelId, threadTs)?.slots ?? null;
}

/**
 * The search fingerprint tied to the current offer, or null. The offered-slots
 * exclusion compares it to the incoming search: SAME shape → a real "give me
 * another option" (exclude what was shown); DIFFERENT shape → a refinement of
 * the same ask (do NOT exclude — excluding dropped Michal's still-valid slots on
 * a "30 min" clarification, 2026-07-13).
 */
export function getOfferedSearchFingerprint(channelId: string, threadTs?: string): string | null {
  return getLiveEntry(channelId, threadTs)?.searchFingerprint ?? null;
}

/**
 * Clear the offer once it's consumed (a booking landed in this conversation)
 * — a stale "bind to these" block after the meeting exists would mislead the
 * next exchange.
 */
export function clearOfferedSlots(channelId: string, threadTs?: string): void {
  const key = keyFor(channelId, threadTs);
  if (key.startsWith(EMAIL_KEY_PREFIX)) {
    loadPersistedEmailEntries();
    stash.delete(key);
    persistEmailEntries();
    return;
  }
  stash.delete(key);
}
