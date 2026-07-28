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
 *
 * `postOwnerDecision` (below) is THE post path for anything decision-shaped.
 * Call it instead of `conn.sendDirect(owner, …)` — a bare DM escapes the book.
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

/** Where a decision ask landed — the three pointers a request row stamps. */
export interface OwnerDecisionPost {
  ok: boolean;
  /** Channel it landed in → `owner_dm_channel`. */
  channel?: string;
  /** Thread root it nested under → `owner_dm_thread_ts` (Module D binds typed replies on this). */
  threadTs?: string;
  /** This message's OWN ts → `terminal_dm_msg_ts` (an ✅ on it resolves this one ask). */
  ts?: string;
  reason?: string;
}

/**
 * THE owner-facing post path for anything that needs his decision — the first
 * ask, a colleague's counter bouncing back, a stale ask being revived.
 *
 * Why this exists (#45): the daily thread had exactly ONE call site
 * (`create_approval`), so every other decision-shaped message reached the owner
 * as a bare `sendDirect` — a fresh top-level DM outside the signature book. The
 * counter bounce-back ("Approve, reject, or counter again?") and the re-ask
 * revival ("still need your call") both escaped that way. Routing them here is
 * what makes S10 a property of the code rather than of each call site
 * remembering.
 *
 * Thread choice — owner ruling 2026-07-25: a decision that resurfaces goes into
 * **TODAY's** thread, never the thread it originally came from ("new day, new
 * tasks — even if we responded to something a couple of days ago"). So the day
 * is resolved HERE, at post time, on every call; a row's stored
 * `owner_dm_thread_ts` is never read back as the destination. Callers re-stamp
 * the row from the returned pointers, so the row always names where the ask
 * currently lives and a typed reply still binds.
 *
 * `inThread` is the ONE deliberate exception: a colleague's reply relayed into
 * the owner's own ongoing outreach conversation (Finding A, 2026-07-19 — Oran's
 * LinkedIn reply belongs in the thread where the owner asked for it). Not a
 * fallback and never derived from the row: the caller passes it or it doesn't
 * apply.
 *
 * Never throws — a decision that can't reach a thread still reaches him as a
 * plain DM (an unsent ask is the worse failure).
 */
export async function postOwnerDecision(opts: {
  profile: UserProfile;
  conn: Connection;
  text: string;
  inThread?: { channel: string; threadTs: string } | null;
  /** Log label so a miss is traceable to the call site. */
  label: string;
}): Promise<OwnerDecisionPost> {
  const { profile, conn, text, label } = opts;
  const ownerUserId = profile.user.slack_user_id;
  let channel = opts.inThread?.channel;
  let threadTs = opts.inThread?.threadTs;
  if (!channel || !threadTs) {
    const daily = await getOrCreateOwnerDailyThread({ profile, conn });
    channel = daily?.channel;
    threadTs = daily?.rootTs;
  }
  try {
    if (channel && threadTs) {
      const res = await conn.postToChannel(channel, text, { threadTs });
      if (res.ok) {
        logger.info(`postOwnerDecision — posted (${label})`, { ownerUserId, channel, threadTs });
        return { ok: true, channel, threadTs, ts: res.ts };
      }
      logger.warn(`postOwnerDecision — thread post failed, falling back to plain DM (${label})`, {
        ownerUserId, channel, reason: res.reason,
      });
    }
    const dm = await conn.sendDirect(ownerUserId, text);
    if (!dm.ok) {
      logger.error(`postOwnerDecision — owner never got this decision ask (${label})`, {
        ownerUserId, reason: dm.reason,
      });
      return { ok: false, reason: dm.reason };
    }
    return { ok: true, channel: dm.ref, ts: dm.ts };
  } catch (err) {
    logger.error(`postOwnerDecision — threw, owner never got this decision ask (${label})`, {
      ownerUserId, err: String(err).slice(0, 200),
    });
    return { ok: false, reason: 'threw' };
  }
}
