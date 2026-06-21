/**
 * Owner daily decision thread (v3.4.6).
 *
 * Maelle reaches out to the owner for essentially one reason: she needs a
 * decision — an approval. Instead of opening a fresh top-level DM per approval
 * (the "tons of threads" sprawl), every owner-facing ask of a given day nests
 * under ONE lazily-created thread: "Discussions — Sat 21 Jun". Owner direction
 * (2026-06-21): one thread per day, opened only by the FIRST approval that
 * actually needs him that day — a quiet day opens nothing.
 *
 * Day-key = `getEffectiveToday(profile)` so it reuses the owner's configured
 * late-night boundary (`schedule.day_boundary_hour`): a 1am "approve this" still
 * lands on the prior workday's thread, not a new one. NOT midnight, NOT a
 * hardcoded weekend rule.
 *
 * Resolution is unaffected: each approval is its OWN message in the thread, and
 * its message ts is stamped as the request's `terminal_dm_msg_ts` — so an ✅/❌
 * reaction resolves that one approval regardless of how many share the thread.
 * Typed replies (which carry the daily-root ts, not a per-message ts) route to
 * content attribution in threadBoundApprovalAutoResolve.
 *
 * Scope: APPROVALS ONLY. The brief, calendar-health, and colleague-conversation
 * shadows stay on their own surfaces (owner direction — don't merge those in).
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import type { Connection } from '../connections/types';
import { getEffectiveToday } from './effectiveToday';
import { getDb } from '../db/client';
import logger from './logger';

export interface OwnerDailyThread {
  channel: string;
  rootTs: string;
}

/** The day-key for the owner's effective today (honors day_boundary_hour). */
export function ownerDailyThreadKey(profile: UserProfile): string {
  return getEffectiveToday(profile).toISODate() ?? DateTime.now().toISODate()!;
}

function readRow(ownerUserId: string, dayKey: string): OwnerDailyThread | null {
  try {
    const row = getDb()
      .prepare(`SELECT dm_channel, root_ts FROM owner_daily_threads WHERE owner_user_id = ? AND day_key = ?`)
      .get(ownerUserId, dayKey) as { dm_channel: string; root_ts: string } | undefined;
    if (row?.dm_channel && row?.root_ts) return { channel: row.dm_channel, rootTs: row.root_ts };
  } catch (err) {
    logger.warn('ownerDailyThread — read failed', { ownerUserId, dayKey, err: String(err).slice(0, 200) });
  }
  return null;
}

/**
 * Return today's owner decision thread, creating it lazily on first use.
 * Posts a one-line dated header to the owner's DM and persists (channel, root).
 * Returns null only if the header post fails — callers fall back to a plain DM.
 */
export async function getOrCreateOwnerDailyThread(opts: {
  profile: UserProfile;
  conn: Connection;
}): Promise<OwnerDailyThread | null> {
  const { profile, conn } = opts;
  const ownerUserId = profile.user.slack_user_id;
  const dayKey = ownerDailyThreadKey(profile);

  const existing = readRow(ownerUserId, dayKey);
  if (existing) return existing;

  // Lazily create: post the dated header to the owner's DM. sendDirect returns
  // ref=channel, ts=root.
  const label = getEffectiveToday(profile).setLocale('en').toFormat('cccc d MMM');
  const header = `🗓️ Discussions — ${label}`;
  let res;
  try {
    res = await conn.sendDirect(ownerUserId, header);
  } catch (err) {
    logger.warn('ownerDailyThread — header post threw', { ownerUserId, dayKey, err: String(err).slice(0, 200) });
    return null;
  }
  if (!res.ok || !res.ts) {
    logger.warn('ownerDailyThread — header post not ok', { ownerUserId, dayKey, reason: res.ok ? 'no_ts' : res.reason });
    return null;
  }
  const channel = res.ref ?? '';
  const rootTs = res.ts;

  // Persist. INSERT OR IGNORE so a near-simultaneous second approval that raced
  // us doesn't clobber the first thread — then re-read to return the winner.
  try {
    getDb()
      .prepare(`INSERT OR IGNORE INTO owner_daily_threads (owner_user_id, day_key, dm_channel, root_ts) VALUES (?, ?, ?, ?)`)
      .run(ownerUserId, dayKey, channel, rootTs);
  } catch (err) {
    logger.warn('ownerDailyThread — persist failed', { ownerUserId, dayKey, err: String(err).slice(0, 200) });
  }
  const winner = readRow(ownerUserId, dayKey);
  if (winner) return winner;
  // Persist somehow failed but we DID post — use what we posted so the ask still
  // lands somewhere sensible (resolution still works off terminal_dm_msg_ts).
  return { channel, rootTs };
}
