/**
 * Social Engine DB helpers (v2.2).
 *
 * Three tables power the Social Engine — see db/client.ts for schema:
 *   - social_categories       fixed list of 30 top-level interest areas
 *   - social_topics_v2        specific topics under a category, lifecycle + score
 *   - social_engagements      append-only log of every social exchange
 *
 * This module is code-only (no prompt logic). Decision-making lives in
 * src/core/social/stateMachine.ts; classification in classifyOwnerIntent.ts;
 * topic matching in reconcileTopic.ts. Those layers read+write through here.
 */

import { getDb } from './client';
import logger from '../utils/logger';

// ── Fixed category list ──────────────────────────────────────────────────────
//
// Top-level, topic-shaped, non-overlapping. Plain nouns at conversational
// altitude — these are things a real EA hears an exec chat about. Subtopics
// live as social_topics_v2 rows UNDER these (Clair Obscur → gaming,
// mechanical keyboards → tech, etc). No new categories are ever created at
// runtime — the full surface is this list.
export const FIXED_CATEGORIES: string[] = [
  'family',          // generic family life, extended family
  'kids',
  'partner',         // spouse / long-term partner
  'friends',
  'pets',
  'home',            // apartment, house, projects, renovation
  'neighborhood',    // local area, community
  'commute',
  'weekend',
  'travel',
  'holidays',        // planned time off, vacation days
  'exercise',        // gym, running, yoga — participation
  'sports',          // watching + casual participation
  'health',          // medical, wellness, sleep
  'food',            // cooking, restaurants, cuisine
  'drinks',          // coffee, wine, beer
  'gaming',
  'reading',
  'shows',           // TV, streaming
  'movies',
  'music',
  'podcasts',
  'art',             // making art — painting, photography, crafts
  'outdoor',         // hiking, camping, nature
  'tech',            // gadgets, mechanical keyboards, home automation
  'learning',        // courses, languages, new skills
  'cars',
  'fashion',
  'news',            // current events, politics, world
  'side_projects',   // personal projects outside of work
];

// ── Types ────────────────────────────────────────────────────────────────────

export type CareLevel = 'unknown' | 'low' | 'medium' | 'high';
export type TopicStatus = 'active' | 'dormant';
export type EngagementDirection =
  | 'owner_initiated'
  | 'maelle_initiated'
  | 'owner_response'
  | 'maelle_response';
export type EngagementSignal = 'positive' | 'neutral' | 'negative' | 'none';

export interface SocialCategory {
  id: string;
  owner_user_id: string;
  label: string;
  care_level: CareLevel;
  signals_positive: number;
  signals_negative: number;
  created_at: string;
  updated_at: string;
}

export interface SocialTopic {
  id: string;
  owner_user_id: string;
  category_id: string;
  label: string;
  engagement_score: number;
  status: TopicStatus;
  last_touched_at: string;
  last_touched_by: 'owner' | 'maelle';
  raised_count: number;
  created_at: string;
  updated_at: string;
}

export interface SocialEngagement {
  id: string;
  owner_user_id: string;
  topic_id: string | null;
  category_id: string;
  direction: EngagementDirection;
  signal: EngagementSignal;
  score_delta: number;
  turn_ref: string | null;
  created_at: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const SCORE_CAP = 10;
export const SCORE_FLOOR = 0;
export const DORMANT_THRESHOLD = 0;
export const DECAY_DAYS = 7; // -1 score per 7 days of no touch on active topics

// ── Bootstrap: seed 30 categories for an owner ───────────────────────────────

export function ensureCategoriesSeeded(ownerUserId: string): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT COUNT(*) as n FROM social_categories WHERE owner_user_id = ?')
    .get(ownerUserId) as { n: number };
  if (existing.n >= FIXED_CATEGORIES.length) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO social_categories (id, owner_user_id, label, care_level)
    VALUES (@id, @owner_user_id, @label, 'unknown')
  `);
  const txn = db.transaction((labels: string[]) => {
    for (const label of labels) {
      const id = `cat_${ownerUserId}_${label}`.replace(/[^a-zA-Z0-9_]/g, '_');
      insert.run({ id, owner_user_id: ownerUserId, label });
    }
  });
  txn(FIXED_CATEGORIES);

  logger.info('Social categories seeded', { ownerUserId, count: FIXED_CATEGORIES.length });
}

// ── Category helpers ─────────────────────────────────────────────────────────

export function getCategoriesForOwner(ownerUserId: string): SocialCategory[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM social_categories WHERE owner_user_id = ? ORDER BY label ASC`)
    .all(ownerUserId) as SocialCategory[];
}

export function getCategoryByLabel(ownerUserId: string, label: string): SocialCategory | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM social_categories WHERE owner_user_id = ? AND label = ?`)
    .get(ownerUserId, label.toLowerCase()) as SocialCategory | undefined;
  return row ?? null;
}

export function getCategoryById(categoryId: string): SocialCategory | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM social_categories WHERE id = ?`)
    .get(categoryId) as SocialCategory | undefined;
  return row ?? null;
}

export function incrementCategorySignals(
  categoryId: string,
  kind: 'positive' | 'negative',
): void {
  const db = getDb();
  const column = kind === 'positive' ? 'signals_positive' : 'signals_negative';
  db.prepare(`
    UPDATE social_categories
    SET ${column} = ${column} + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(categoryId);
  recomputeCareLevel(categoryId);
}

/**
 * Slow-moving rule: care_level moves based on positive vs negative signal
 * accumulation across the category. Thresholds tuned conservatively so a
 * single exchange doesn't flip levels — takes a genuine pattern.
 */
function recomputeCareLevel(categoryId: string): void {
  const db = getDb();
  const cat = getCategoryById(categoryId);
  if (!cat) return;
  const pos = cat.signals_positive;
  const neg = cat.signals_negative;
  const total = pos + neg;
  if (total < 2) return; // not enough signal to change from unknown

  let next: CareLevel = cat.care_level;
  const ratio = pos / Math.max(total, 1);
  if (total >= 6 && ratio >= 0.8) next = 'high';
  else if (total >= 4 && ratio >= 0.65) next = 'medium';
  else if (ratio >= 0.5) next = 'low';
  else next = 'low'; // signals trending neg → low, not high

  if (next !== cat.care_level) {
    db.prepare(`UPDATE social_categories SET care_level = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(next, categoryId);
    logger.info('Social category care_level updated', {
      categoryId, from: cat.care_level, to: next, pos, neg,
    });
  }
}

// ── Topic helpers ────────────────────────────────────────────────────────────

export function createTopic(params: {
  ownerUserId: string;
  categoryId: string;
  label: string;
  initialScore?: number;
  createdBy: 'owner' | 'maelle';
}): SocialTopic {
  const db = getDb();
  const id = `topic_${params.ownerUserId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const score = Math.min(SCORE_CAP, Math.max(SCORE_FLOOR, params.initialScore ?? 3));
  db.prepare(`
    INSERT INTO social_topics_v2 (
      id, owner_user_id, category_id, label, engagement_score,
      status, last_touched_at, last_touched_by, raised_count
    ) VALUES (
      @id, @owner_user_id, @category_id, @label, @score,
      'active', datetime('now'), @created_by, 1
    )
  `).run({
    id,
    owner_user_id: params.ownerUserId,
    category_id: params.categoryId,
    label: params.label,
    score,
    created_by: params.createdBy,
  });
  const row = db.prepare(`SELECT * FROM social_topics_v2 WHERE id = ?`).get(id) as SocialTopic;
  logger.info('Social topic created', { id, label: params.label, categoryId: params.categoryId, createdBy: params.createdBy });
  return row;
}

export function getTopicById(topicId: string): SocialTopic | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM social_topics_v2 WHERE id = ?`).get(topicId) as SocialTopic | undefined;
  return row ?? null;
}

export function getActiveTopicsForCategory(categoryId: string): SocialTopic[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_topics_v2
    WHERE category_id = ? AND status = 'active'
    ORDER BY engagement_score DESC, last_touched_at DESC
  `).all(categoryId) as SocialTopic[];
}

export function getAllTopicsForOwner(ownerUserId: string, opts?: { includeDormant?: boolean }): SocialTopic[] {
  const db = getDb();
  if (opts?.includeDormant) {
    return db.prepare(`
      SELECT * FROM social_topics_v2
      WHERE owner_user_id = ?
      ORDER BY status ASC, engagement_score DESC, last_touched_at DESC
    `).all(ownerUserId) as SocialTopic[];
  }
  return db.prepare(`
    SELECT * FROM social_topics_v2
    WHERE owner_user_id = ? AND status = 'active'
    ORDER BY engagement_score DESC, last_touched_at DESC
  `).all(ownerUserId) as SocialTopic[];
}

export function getDormantTopicsForOwner(ownerUserId: string): SocialTopic[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_topics_v2
    WHERE owner_user_id = ? AND status = 'dormant'
    ORDER BY last_touched_at DESC
  `).all(ownerUserId) as SocialTopic[];
}

export function applyScoreDelta(topicId: string, delta: number, touchedBy: 'owner' | 'maelle'): SocialTopic | null {
  const db = getDb();
  const current = getTopicById(topicId);
  if (!current) return null;

  const nextScore = Math.min(SCORE_CAP, Math.max(SCORE_FLOOR, current.engagement_score + delta));
  const nextStatus: TopicStatus = nextScore <= DORMANT_THRESHOLD ? 'dormant' : 'active';

  db.prepare(`
    UPDATE social_topics_v2
    SET engagement_score = @score,
        status = @status,
        last_touched_at = datetime('now'),
        last_touched_by = @touched_by,
        raised_count = raised_count + 1,
        updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id: topicId,
    score: nextScore,
    status: nextStatus,
    touched_by: touchedBy,
  });
  if (current.status !== nextStatus) {
    logger.info('Social topic status flipped', {
      topicId, label: current.label, from: current.status, to: nextStatus, score: nextScore,
    });
  }
  return getTopicById(topicId);
}

export function reviveTopic(topicId: string, byOwner: boolean): SocialTopic | null {
  const db = getDb();
  const current = getTopicById(topicId);
  if (!current) return null;
  if (current.status === 'active') return current;
  if (!byOwner) return current; // only owner can revive per the owner's rule

  db.prepare(`
    UPDATE social_topics_v2
    SET engagement_score = 3,
        status = 'active',
        last_touched_at = datetime('now'),
        last_touched_by = 'owner',
        raised_count = raised_count + 1,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(topicId);
  logger.info('Social topic revived by owner', { topicId, label: current.label });
  return getTopicById(topicId);
}

// ── Engagement log ───────────────────────────────────────────────────────────

export function logEngagementRow(params: {
  ownerUserId: string;
  topicId: string | null;
  categoryId: string;
  direction: EngagementDirection;
  signal: EngagementSignal;
  scoreDelta: number;
  turnRef?: string | null;
}): void {
  const db = getDb();
  const id = `eng_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO social_engagements (
      id, owner_user_id, topic_id, category_id,
      direction, signal, score_delta, turn_ref
    ) VALUES (
      @id, @owner_user_id, @topic_id, @category_id,
      @direction, @signal, @score_delta, @turn_ref
    )
  `).run({
    id,
    owner_user_id: params.ownerUserId,
    topic_id: params.topicId,
    category_id: params.categoryId,
    direction: params.direction,
    signal: params.signal,
    score_delta: params.scoreDelta,
    turn_ref: params.turnRef ?? null,
  });
}

export function getRecentEngagementsForOwner(
  ownerUserId: string,
  sinceIso: string,
): SocialEngagement[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_engagements
    WHERE owner_user_id = ? AND created_at >= ?
    ORDER BY created_at DESC
  `).all(ownerUserId, sinceIso) as SocialEngagement[];
}

/**
 * How many times has Maelle initiated anything today? Reading the engagement
 * log for today's date (UTC). Used by the daily-slot rate limit.
 */
export function countMaelleInitiationsToday(ownerUserId: string): number {
  const db = getDb();
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const iso = startOfDay.toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM social_engagements
    WHERE owner_user_id = ?
      AND direction = 'maelle_initiated'
      AND created_at >= ?
  `).get(ownerUserId, iso) as { n: number };
  return row.n;
}

export function lastOwnerInitiatedAt(ownerUserId: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT created_at FROM social_engagements
    WHERE owner_user_id = ? AND direction = 'owner_initiated'
    ORDER BY created_at DESC LIMIT 1
  `).get(ownerUserId) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

// ── Weekly decay (triggered by the social_decay task dispatcher) ─────────────

export function runWeeklyDecay(ownerUserId: string): { decayed: number; dormantFlipped: number } {
  const db = getDb();
  const cutoff = new Date(Date.now() - DECAY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const stale = db.prepare(`
    SELECT id, engagement_score, label FROM social_topics_v2
    WHERE owner_user_id = ? AND status = 'active' AND last_touched_at < ?
  `).all(ownerUserId, cutoff) as Array<{ id: string; engagement_score: number; label: string }>;

  let decayed = 0;
  let dormantFlipped = 0;
  for (const t of stale) {
    const nextScore = Math.max(SCORE_FLOOR, t.engagement_score - 1);
    const nextStatus: TopicStatus = nextScore <= DORMANT_THRESHOLD ? 'dormant' : 'active';
    db.prepare(`
      UPDATE social_topics_v2
      SET engagement_score = @score,
          status = @status,
          updated_at = datetime('now')
      WHERE id = @id
    `).run({ id: t.id, score: nextScore, status: nextStatus });
    decayed++;
    if (nextStatus === 'dormant') dormantFlipped++;
  }

  if (decayed > 0) {
    logger.info('Social weekly decay pass', { ownerUserId, decayed, dormantFlipped });
  }
  return { decayed, dormantFlipped };
}
