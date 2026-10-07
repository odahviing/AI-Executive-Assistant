import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { getDb } from './client';

export type SlackDeliveryStatus = 'sending' | 'confirmed' | 'failed' | 'unknown';
export interface SlackDeliveryAttempt {
  profileId: string; channelId: string; threadTs: string | null;
  attemptId: string; status: SlackDeliveryStatus; messageTs: string | null;
  updatedAt: number; nextCheckAt: number | null; inboundTs: string[];
}

/** Additive only: existing rows are untouched. Retain these tables on rollback;
 * dropping them after use would discard the protection against duplicate sends. */
export function initSlackDeliverySchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS slack_delivery_attempts (
    attemptId TEXT PRIMARY KEY, profileId TEXT NOT NULL, channelId TEXT NOT NULL,
    threadTs TEXT, status TEXT NOT NULL CHECK(status IN ('sending','confirmed','failed','unknown')),
    messageTs TEXT, updatedAt INTEGER NOT NULL, nextCheckAt INTEGER,
    CHECK ((status IN ('sending','unknown') AND nextCheckAt IS NOT NULL)
      OR (status IN ('confirmed','failed') AND nextCheckAt IS NULL))
  );
  CREATE TABLE IF NOT EXISTS slack_delivery_inbound (
    profileId TEXT NOT NULL, channelId TEXT NOT NULL, inboundTs TEXT NOT NULL,
    attemptId TEXT NOT NULL REFERENCES slack_delivery_attempts(attemptId),
    PRIMARY KEY(profileId,channelId,inboundTs)
  );
  CREATE INDEX IF NOT EXISTS slack_delivery_due ON slack_delivery_attempts(profileId,nextCheckAt);
  CREATE INDEX IF NOT EXISTS slack_delivery_members ON slack_delivery_inbound(attemptId);`);
}

function hydrate(db: Database.Database, row: Omit<SlackDeliveryAttempt, 'inboundTs'>): SlackDeliveryAttempt {
  return { ...row, inboundTs: (db.prepare('SELECT inboundTs FROM slack_delivery_inbound WHERE attemptId=? ORDER BY inboundTs')
    .all(row.attemptId) as { inboundTs: string }[]).map(r => r.inboundTs) };
}

/** A send may start only after its claim is durably committed. WAL NORMAL can
 * lose committed transactions on power loss, so isolate these commits at FULL
 * without changing the shared connection's policy for unrelated work. These
 * synchronous callbacks cannot interleave with other JS database callers.
 * A nested transaction would only release a savepoint, not commit the claim. */
function durableTransaction<T>(db: Database.Database, operation: () => T): T {
  if (db.inTransaction) throw new Error('Slack delivery requires an independent durable transaction');
  const previous = db.pragma('synchronous', { simple: true }) as number;
  try {
    db.pragma('synchronous = FULL');
    return db.transaction(operation).immediate();
  } finally {
    db.pragma(`synchronous = ${previous}`);
  }
}

/** All members are claimed or none. Only explicit failed attempts can be replaced.
 * UUID is also the Slack client_msg_id; callers must never substitute a new ID. */
export function beginSlackDelivery(input: {
  profileId: string; channelId: string; threadTs?: string | null; inboundTs: string[];
  now?: number; nextCheckAt: number;
}): SlackDeliveryAttempt | null {
  const db = getDb();
  const now = input.now ?? Date.now();
  const members = [...new Set(input.inboundTs)];
  if (!input.profileId || !input.channelId || !members.length || members.some(ts => !ts)
    || !Number.isFinite(now) || !Number.isFinite(input.nextCheckAt) || input.nextCheckAt <= now) {
    throw new Error('Invalid Slack delivery claim');
  }
  return durableTransaction(db, () => {
    const read = db.prepare(`SELECT a.status FROM slack_delivery_inbound i
      JOIN slack_delivery_attempts a ON a.attemptId=i.attemptId
      WHERE i.profileId=? AND i.channelId=? AND i.inboundTs=?`);
    for (const ts of members) {
      const prior = read.get(input.profileId, input.channelId, ts) as {status: SlackDeliveryStatus} | undefined;
      if (prior && prior.status !== 'failed') return null;
    }
    const attempt: SlackDeliveryAttempt = { profileId: input.profileId, channelId: input.channelId,
      threadTs: input.threadTs ?? null, attemptId: randomUUID(), status: 'sending', messageTs: null,
      updatedAt: now, nextCheckAt: input.nextCheckAt, inboundTs: members };
    db.prepare(`INSERT INTO slack_delivery_attempts VALUES
      (@attemptId,@profileId,@channelId,@threadTs,@status,@messageTs,@updatedAt,@nextCheckAt)`).run(attempt);
    const claim = db.prepare(`INSERT INTO slack_delivery_inbound VALUES(?,?,?,?)
      ON CONFLICT(profileId,channelId,inboundTs) DO UPDATE SET attemptId=excluded.attemptId`);
    for (const ts of members) claim.run(input.profileId, input.channelId, ts, attempt.attemptId);
    return attempt;
  });
}

export function getSlackDelivery(profileId: string, channelId: string, inboundTs: string): SlackDeliveryAttempt | null {
  const db = getDb();
  const row = db.prepare(`SELECT a.* FROM slack_delivery_attempts a JOIN slack_delivery_inbound i
    ON a.attemptId=i.attemptId WHERE i.profileId=? AND i.channelId=? AND i.inboundTs=?`)
    .get(profileId, channelId, inboundTs) as Omit<SlackDeliveryAttempt, 'inboundTs'> | undefined;
  return row ? hydrate(db, row) : null;
}

/** Expected-attempt + expected-status CAS, shared by send completion and operator
 * resolution. Unknown -> failed requires explicit operator/evidence judgment.
 * Audio/reaction transport success may have no outbound message timestamp;
 * callers must explicitly attest that success, never infer it from a timeout. */
export function resolveSlackDelivery(input: {
  profileId: string; channelId: string; attemptId: string;
  expectedStatus: 'sending' | 'unknown'; status: 'confirmed' | 'failed' | 'unknown';
  messageTs?: string | null; nextCheckAt?: number | null; now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)
    || (input.status === 'unknown' && (!Number.isFinite(input.nextCheckAt) || input.nextCheckAt! <= now))) {
    throw new Error('Invalid Slack delivery resolution');
  }
  const db = getDb();
  return durableTransaction(db, () => db.prepare(`UPDATE slack_delivery_attempts SET status=?, messageTs=?,updatedAt=?,nextCheckAt=?
    WHERE profileId=? AND channelId=? AND attemptId=? AND status=?`).run(input.status,
    input.status === 'confirmed' ? input.messageTs || null : null, now,
    input.status === 'unknown' ? input.nextCheckAt! : null,
    input.profileId, input.channelId, input.attemptId, input.expectedStatus).changes === 1);
}

/** Heartbeat calls this before history discovery. Expired sending is uncertain,
 * never failed; unresolved work is retained indefinitely and remains due. */
export function listDueSlackDeliveries(profileId: string, now = Date.now(), limit = 100): SlackDeliveryAttempt[] {
  const db = getDb();
  if (!Number.isFinite(now) || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid due query');
  return db.transaction(() => {
    db.prepare(`UPDATE slack_delivery_attempts SET status='unknown',updatedAt=?
      WHERE profileId=? AND status='sending' AND nextCheckAt<=?`).run(now, profileId, now);
    return (db.prepare(`SELECT * FROM slack_delivery_attempts WHERE profileId=?
      AND status='unknown' AND nextCheckAt<=? ORDER BY nextCheckAt,attemptId LIMIT ?`)
      .all(profileId, now, limit) as Omit<SlackDeliveryAttempt, 'inboundTs'>[]).map(row => hydrate(db, row));
  }).immediate();
}

export function postponeSlackDelivery(profileId: string, channelId: string, attemptId: string,
  nextCheckAt: number, now = Date.now()): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(nextCheckAt) || nextCheckAt <= now) throw new Error('Invalid next check');
  return getDb().prepare(`UPDATE slack_delivery_attempts SET nextCheckAt=?,updatedAt=?
    WHERE profileId=? AND channelId=? AND attemptId=? AND status='unknown'`)
    .run(nextCheckAt, now, profileId, channelId, attemptId).changes === 1;
}
