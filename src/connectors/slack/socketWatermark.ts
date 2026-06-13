/**
 * Socket-liveness watermark (v3.3.x — recovery rewrite).
 *
 * Recovery's job: when Maelle was unreachable, find messages that arrived
 * during the gap and still need a reply. To scan the GAP precisely (not a
 * blind 24h window) we need to know when she was last actually receiving
 * Slack events. That's this watermark.
 *
 * CRITICAL semantics — stamp on SOCKET liveness, never on the bare process
 * timer. The 5-min background timer fires even when the socket is dead (that
 * is exactly how a zombie process "looked alive" on 2026-06-12/13). If we
 * stamped on the timer, a dead-socket zombie's watermark would stay current
 * and recovery would think there was no gap. So stamp ONLY on:
 *   (a) a real inbound Slack message (proof the socket is delivering), and
 *   (b) a confirmed socket connect.
 * A zombie's watermark then correctly freezes at the last true inbound, so
 * recovery scans the whole gap.
 *
 * In-memory is the source of truth for the live reconnect path; the file is
 * only for the process-restart path (so startup knows the pre-crash gap).
 * Persisted debounced (≤ every 30s) + on graceful shutdown.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import logger from '../../utils/logger';

const FILE = join(process.cwd(), 'data', 'socket-watermark.json');
const PERSIST_DEBOUNCE_MS = 30 * 1000;

const lastAlive: Map<string, number> = new Map();
let loaded = false;
let lastPersist = 0;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, number>;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'number') lastAlive.set(k, v);
    }
  } catch { /* no file yet — first run; treated as "no prior watermark" */ }
}

function persist(force = false): void {
  const now = Date.now();
  if (!force && now - lastPersist < PERSIST_DEBOUNCE_MS) return;
  lastPersist = now;
  try {
    writeFileSync(FILE, JSON.stringify(Object.fromEntries(lastAlive)), 'utf8');
  } catch (err) {
    logger.warn('socketWatermark — persist failed (non-fatal)', { err: String(err).slice(0, 120) });
  }
}

/** Record that the socket is alive for this profile right now (inbound / connect). */
export function stampSocketAlive(profileId: string): void {
  load();
  lastAlive.set(profileId, Date.now());
  persist();
}

/**
 * Epoch-ms the socket was last known alive for this profile, or null if we
 * have no record (first ever boot). Recovery uses this as the gap start.
 */
export function getLastSocketAlive(profileId: string): number | null {
  load();
  return lastAlive.get(profileId) ?? null;
}

/** Flush to disk immediately — call on graceful shutdown. */
export function flushSocketWatermark(): void {
  persist(true);
}
