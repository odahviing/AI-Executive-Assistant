import type Database from 'better-sqlite3';
import { getDb } from './client';
import { durableTransaction } from './slackDelivery';

export interface SlackCatchupRetry {
  /** Authenticated profile.user.slack_user_id, never an incoming message claim. */
  profileId: string;
  channelId: string;
  /** Earliest unscanned instant, milliseconds since epoch (catch-up's sinceMs). */
  sinceMs: number;
  nextCheckAt: number;
}

/** Additive migration: no existing rows change. Older code ignores this table;
 * retain it on rollback so deferred unread intervals survive a later upgrade.
 * These are scan cursors, never delivery receipts or permission grants. */
export function initSlackCatchupSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS slack_catchup_retries (
    profileId TEXT NOT NULL CHECK(length(profileId) > 0),
    channelId TEXT NOT NULL CHECK(length(channelId) > 0),
    sinceMs INTEGER NOT NULL CHECK(sinceMs >= 0),
    nextCheckAt INTEGER NOT NULL CHECK(nextCheckAt >= 0),
    PRIMARY KEY(profileId, channelId)
  )`);
}

function validateScope(profileId: string, channelId?: string): void {
  if (!profileId?.trim() || (channelId !== undefined && !channelId.trim())) {
    throw new Error('Catch-up retry requires authenticated profile and conversation scope');
  }
}

function validate(row: SlackCatchupRetry): void {
  validateScope(row.profileId, row.channelId);
  if (![row.sinceMs, row.nextCheckAt].every(n => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('Catch-up retry timestamps must be nonnegative safe integer milliseconds');
  }
}

/** Include pending conversations absent from a current conversations.list page.
 * Caller must still revalidate live Slack eligibility before any content read. */
export function listSlackCatchupRetries(profileId: string): SlackCatchupRetry[] {
  validateScope(profileId);
  return getDb().prepare('SELECT profileId,channelId,sinceMs,nextCheckAt FROM slack_catchup_retries WHERE profileId=? ORDER BY nextCheckAt,channelId')
    .all(profileId) as SlackCatchupRetry[];
}

/** Commit before skipping a scan. A later global watermark must never replace
 * the earliest unresolved interval. A stale overlapping retry cannot shorten
 * an already recorded backoff; actual retries still use fresh eligibility. */
export function deferSlackCatchupRetry(row: SlackCatchupRetry): SlackCatchupRetry {
  validate(row);
  const db = getDb();
  return durableTransaction(db, () => {
    db.prepare(`INSERT INTO slack_catchup_retries(profileId,channelId,sinceMs,nextCheckAt)
      VALUES(@profileId,@channelId,@sinceMs,@nextCheckAt)
      ON CONFLICT(profileId,channelId) DO UPDATE SET
        sinceMs=MIN(slack_catchup_retries.sinceMs,excluded.sinceMs),
        nextCheckAt=MAX(slack_catchup_retries.nextCheckAt,excluded.nextCheckAt)`).run(row);
    return db.prepare('SELECT profileId,channelId,sinceMs,nextCheckAt FROM slack_catchup_retries WHERE profileId=? AND channelId=?')
      .get(row.profileId, row.channelId) as SlackCatchupRetry;
  });
}

/** Clear only the exact interval/schedule successfully scanned. A concurrent
 * newer defer keeps its cursor; false means retain/reload, never assume closed. */
export function clearSlackCatchupRetry(expected: SlackCatchupRetry): boolean {
  validate(expected);
  const db = getDb();
  return durableTransaction(db, () => db.prepare(`DELETE FROM slack_catchup_retries
    WHERE profileId=@profileId AND channelId=@channelId AND sinceMs=@sinceMs AND nextCheckAt=@nextCheckAt`).run(expected).changes === 1);
}
