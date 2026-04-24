/**
 * Per-person engagement rank (v2.2).
 *
 * Replaces the legacy 5-level string `profile_json.engagement_level`. Numeric
 * 0..3 scale:
 *
 *   3 — loves to chat; always engaged
 *   2 — open / neutral (default for newly-encountered people)
 *   1 — minimal; replies when pinged but doesn't lean in
 *   0 — doesn't want social with Maelle. NEVER initiated by Maelle; only
 *        responds when the colleague reaches out first.
 *
 * Rank moves deterministically via `adjustEngagementRank` — signal-driven,
 * not LLM-judgment. The usual deltas:
 *
 *   colleague initiates social                          → +1
 *   Maelle ping got engaged reply (>30 chars in <24h)  → +1
 *   Maelle ping got brief reply (<=30 chars)           →  0
 *   Maelle ping got NO reply in 48h                    → -1
 *   colleague explicit deflection                      → -2
 *   owner directive                                    → setEngagementRank
 *
 * All changes audit-log to `engagement_rank_log` with a reason string so we
 * can answer "why is Ysrael at 0?" later.
 */

import { getDb } from './client';
import logger from '../utils/logger';

export const RANK_MIN = 0;
export const RANK_MAX = 3;
export const RANK_DEFAULT = 2;

export type EngagementRank = 0 | 1 | 2 | 3;

export type RankChangeReason =
  | 'colleague_initiated'
  | 'reply_engaged'
  | 'reply_brief'
  | 'no_reply_to_ping'
  | 'colleague_deflected'
  | 'owner_directive'
  | 'migration_from_legacy'
  | 'manual';

function clamp(rank: number): EngagementRank {
  if (rank < RANK_MIN) return RANK_MIN;
  if (rank > RANK_MAX) return RANK_MAX;
  return rank as EngagementRank;
}

export function getEngagementRank(slackId: string): EngagementRank {
  const db = getDb();
  const row = db
    .prepare('SELECT engagement_rank FROM people_memory WHERE slack_id = ?')
    .get(slackId) as { engagement_rank?: number } | undefined;
  if (!row) return RANK_DEFAULT;
  return clamp(row.engagement_rank ?? RANK_DEFAULT);
}

export function setEngagementRank(
  slackId: string,
  rank: EngagementRank,
  reason: RankChangeReason,
): EngagementRank {
  const db = getDb();
  const current = getEngagementRank(slackId);
  const next = clamp(rank);
  if (next === current) return current;

  db.prepare(`
    UPDATE people_memory
    SET engagement_rank = ?, updated_at = datetime('now')
    WHERE slack_id = ?
  `).run(next, slackId);

  logRankChange({ slackId, delta: next - current, newRank: next, reason });
  return next;
}

export function adjustEngagementRank(
  slackId: string,
  delta: number,
  reason: RankChangeReason,
): EngagementRank {
  if (delta === 0) return getEngagementRank(slackId);
  const db = getDb();
  const row = db
    .prepare('SELECT engagement_rank FROM people_memory WHERE slack_id = ?')
    .get(slackId) as { engagement_rank?: number } | undefined;
  if (!row) return RANK_DEFAULT;

  const current = clamp(row.engagement_rank ?? RANK_DEFAULT);
  const next = clamp(current + delta);
  if (next === current) return current;

  db.prepare(`
    UPDATE people_memory
    SET engagement_rank = ?, updated_at = datetime('now')
    WHERE slack_id = ?
  `).run(next, slackId);

  logRankChange({ slackId, delta: next - current, newRank: next, reason });
  return next;
}

function logRankChange(params: {
  slackId: string;
  delta: number;
  newRank: number;
  reason: RankChangeReason;
}): void {
  try {
    const db = getDb();
    const id = `rank_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO engagement_rank_log (id, slack_id, delta, new_rank, reason)
      VALUES (@id, @slack_id, @delta, @new_rank, @reason)
    `).run({
      id,
      slack_id: params.slackId,
      delta: params.delta,
      new_rank: params.newRank,
      reason: params.reason,
    });
    logger.info('engagement_rank updated', {
      slackId: params.slackId,
      delta: params.delta,
      newRank: params.newRank,
      reason: params.reason,
    });
  } catch (err) {
    logger.warn('engagement_rank audit log write threw', { err: String(err).slice(0, 200) });
  }
}

/**
 * One-time migration: translate legacy `profile_json.engagement_level` strings
 * to numeric `engagement_rank` for any row where migration hasn't happened yet.
 * Idempotent — only writes when engagement_rank is still at the default AND a
 * legacy level exists in profile_json.
 */
export function migrateLegacyEngagementLevel(): void {
  const db = getDb();
  const rows = db.prepare(`
    SELECT slack_id, profile_json, engagement_rank FROM people_memory
  `).all() as Array<{ slack_id: string; profile_json: string; engagement_rank: number }>;

  const map: Record<string, EngagementRank> = {
    avoidant: 0,
    minimal: 1,
    neutral: 2,
    friendly: 3,
    interactive: 3,
  };

  let migrated = 0;
  for (const r of rows) {
    // Only migrate rows that still carry the default rank — owner may have
    // explicitly set rank later and we don't want to overwrite.
    if (r.engagement_rank !== RANK_DEFAULT) continue;
    let level: string | undefined;
    try {
      const profile = JSON.parse(r.profile_json || '{}') as Record<string, unknown>;
      level = typeof profile.engagement_level === 'string' ? profile.engagement_level : undefined;
    } catch (_) { continue; }
    if (!level || !(level in map)) continue;
    const rank = map[level];
    if (rank === RANK_DEFAULT) continue;
    setEngagementRank(r.slack_id, rank, 'migration_from_legacy');
    migrated++;
  }
  if (migrated > 0) {
    logger.info('engagement_rank migration pass complete', { migrated });
  }
}
