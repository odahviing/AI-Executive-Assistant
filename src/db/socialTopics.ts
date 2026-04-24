/**
 * Social Engine DB helpers (v2.2.1).
 *
 * Three tables power the Social Engine — see db/client.ts for schema:
 *   - social_categories     GLOBAL fixed 30 labels, shared across owner + all colleagues
 *   - social_topics_v2      per-person topics under categories (owner_user_id + person_slack_id)
 *   - social_engagements    append-only log, scoped per-person
 *
 * Scoping model:
 *   - Categories are global. There is one canonical set of 30 category rows
 *     (seeded with owner_user_id='global'). Everyone shares them.
 *   - Topics live under a category AND are scoped to a specific person
 *     (the owner or a colleague). Idan's "Clair Obscur" and Yael's
 *     "Clair Obscur" are separate rows under the same global `gaming`
 *     category.
 *   - `owner_user_id` on topics/engagements identifies whose world this
 *     belongs to (multi-tenant boundary). `person_slack_id` identifies
 *     whom the topic is about (can be the owner or a colleague).
 */

import { getDb } from './client';
import logger from '../utils/logger';

// ── Fixed GLOBAL category list ───────────────────────────────────────────────
//
// Top-level, topic-shaped, non-overlapping. Plain nouns at conversational
// altitude. Shared across owner + colleagues — Maelle's universal social model.
export const FIXED_CATEGORIES: string[] = [
  'family',          'kids',            'partner',         'friends',
  'pets',            'home',            'neighborhood',    'commute',
  'weekend',         'travel',          'holidays',        'exercise',
  'sports',          'health',          'food',            'drinks',
  'gaming',          'reading',         'shows',           'movies',
  'music',           'podcasts',        'art',             'outdoor',
  'tech',            'learning',        'cars',            'fashion',
  'news',            'side_projects',
];

// ── Types ────────────────────────────────────────────────────────────────────

export type CareLevel = 'unknown' | 'low' | 'medium' | 'high';
export type TopicStatus = 'active' | 'dormant';
export type EngagementDirection =
  | 'owner_initiated'
  | 'colleague_initiated'
  | 'maelle_initiated'
  | 'owner_response'
  | 'colleague_response'
  | 'maelle_response';
export type EngagementSignal = 'positive' | 'neutral' | 'negative' | 'none';
export type TopicToucher = 'owner' | 'maelle' | 'colleague';

export interface SocialCategory {
  id: string;
  owner_user_id: string;         // always 'global' in v2.2.1+
  label: string;
  care_level: CareLevel;
  signals_positive: number;
  signals_negative: number;
  created_at: string;
  updated_at: string;
}

export interface SocialTopic {
  id: string;
  owner_user_id: string;          // multi-tenant boundary
  person_slack_id: string;        // whom the topic is about (owner or colleague)
  category_id: string;
  label: string;
  engagement_score: number;
  status: TopicStatus;
  last_touched_at: string;
  last_touched_by: TopicToucher;
  raised_count: number;
  created_at: string;
  updated_at: string;
}

export interface SocialEngagement {
  id: string;
  owner_user_id: string;
  person_slack_id: string;
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
export const DECAY_DAYS = 7;

const GLOBAL_OWNER = 'global';

// ── Bootstrap: seed the 30 global categories (once) ──────────────────────────

export function ensureCategoriesSeeded(_ownerUserId?: string): void {
  const db = getDb();
  const existing = db
    .prepare(`SELECT COUNT(*) as n FROM social_categories WHERE owner_user_id = ?`)
    .get(GLOBAL_OWNER) as { n: number };
  if (existing.n >= FIXED_CATEGORIES.length) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO social_categories (id, owner_user_id, label, care_level)
    VALUES (@id, 'global', @label, 'unknown')
  `);
  const txn = db.transaction((labels: string[]) => {
    for (const label of labels) {
      const id = `cat_global_${label}`;
      insert.run({ id, label });
    }
  });
  txn(FIXED_CATEGORIES);

  logger.info('Social categories seeded (global)', { count: FIXED_CATEGORIES.length });
}

// ── Category helpers (global) ────────────────────────────────────────────────

export function getAllCategories(): SocialCategory[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM social_categories WHERE owner_user_id = ? ORDER BY label ASC`)
    .all(GLOBAL_OWNER) as SocialCategory[];
}

export function getCategoryByLabel(label: string): SocialCategory | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM social_categories WHERE owner_user_id = ? AND label = ?`)
    .get(GLOBAL_OWNER, label.toLowerCase()) as SocialCategory | undefined;
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
}

// ── Topic helpers (per-person) ───────────────────────────────────────────────

export function createTopic(params: {
  ownerUserId: string;
  personSlackId: string;
  categoryId: string;
  label: string;
  initialScore?: number;
  createdBy: TopicToucher;
}): SocialTopic {
  const db = getDb();
  const id = `topic_${params.personSlackId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const score = Math.min(SCORE_CAP, Math.max(SCORE_FLOOR, params.initialScore ?? 3));
  db.prepare(`
    INSERT INTO social_topics_v2 (
      id, owner_user_id, person_slack_id, category_id, label, engagement_score,
      status, last_touched_at, last_touched_by, raised_count
    ) VALUES (
      @id, @owner_user_id, @person_slack_id, @category_id, @label, @score,
      'active', datetime('now'), @created_by, 1
    )
  `).run({
    id,
    owner_user_id: params.ownerUserId,
    person_slack_id: params.personSlackId,
    category_id: params.categoryId,
    label: params.label,
    score,
    created_by: params.createdBy,
  });
  const row = db.prepare(`SELECT * FROM social_topics_v2 WHERE id = ?`).get(id) as SocialTopic;
  logger.info('Social topic created', {
    id, label: params.label, categoryId: params.categoryId,
    personSlackId: params.personSlackId, createdBy: params.createdBy,
  });
  return row;
}

export function getTopicById(topicId: string): SocialTopic | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM social_topics_v2 WHERE id = ?`).get(topicId) as SocialTopic | undefined;
  return row ?? null;
}

export function getActiveTopicsForPersonCategory(personSlackId: string, categoryId: string): SocialTopic[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_topics_v2
    WHERE person_slack_id = ? AND category_id = ? AND status = 'active'
    ORDER BY engagement_score DESC, last_touched_at DESC
  `).all(personSlackId, categoryId) as SocialTopic[];
}

export function getAllTopicsForPerson(personSlackId: string, opts?: { includeDormant?: boolean }): SocialTopic[] {
  const db = getDb();
  if (opts?.includeDormant) {
    return db.prepare(`
      SELECT * FROM social_topics_v2
      WHERE person_slack_id = ?
      ORDER BY status ASC, engagement_score DESC, last_touched_at DESC
    `).all(personSlackId) as SocialTopic[];
  }
  return db.prepare(`
    SELECT * FROM social_topics_v2
    WHERE person_slack_id = ? AND status = 'active'
    ORDER BY engagement_score DESC, last_touched_at DESC
  `).all(personSlackId) as SocialTopic[];
}

export function getDormantTopicsForPerson(personSlackId: string): SocialTopic[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_topics_v2
    WHERE person_slack_id = ? AND status = 'dormant'
    ORDER BY last_touched_at DESC
  `).all(personSlackId) as SocialTopic[];
}

export function applyScoreDelta(topicId: string, delta: number, touchedBy: TopicToucher): SocialTopic | null {
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

export function reviveTopic(topicId: string, byPerson: boolean): SocialTopic | null {
  const db = getDb();
  const current = getTopicById(topicId);
  if (!current) return null;
  if (current.status === 'active') return current;
  if (!byPerson) return current;   // only the person themself can revive

  db.prepare(`
    UPDATE social_topics_v2
    SET engagement_score = 3,
        status = 'active',
        last_touched_at = datetime('now'),
        last_touched_by = CASE
          WHEN person_slack_id = owner_user_id THEN 'owner'
          ELSE 'colleague'
        END,
        raised_count = raised_count + 1,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(topicId);
  logger.info('Social topic revived by person', { topicId, label: current.label });
  return getTopicById(topicId);
}

// ── Engagement log ───────────────────────────────────────────────────────────

export function logEngagementRow(params: {
  ownerUserId: string;
  personSlackId: string;
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
      id, owner_user_id, person_slack_id, topic_id, category_id,
      direction, signal, score_delta, turn_ref
    ) VALUES (
      @id, @owner_user_id, @person_slack_id, @topic_id, @category_id,
      @direction, @signal, @score_delta, @turn_ref
    )
  `).run({
    id,
    owner_user_id: params.ownerUserId,
    person_slack_id: params.personSlackId,
    topic_id: params.topicId,
    category_id: params.categoryId,
    direction: params.direction,
    signal: params.signal,
    score_delta: params.scoreDelta,
    turn_ref: params.turnRef ?? null,
  });
}

/**
 * How many times has Maelle initiated social with this specific person
 * today? Used for the 1-per-day-per-person gate.
 */
export function countMaelleInitiationsTodayForPerson(personSlackId: string): number {
  const db = getDb();
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const iso = startOfDay.toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM social_engagements
    WHERE person_slack_id = ?
      AND direction = 'maelle_initiated'
      AND created_at >= ?
  `).get(personSlackId, iso) as { n: number };
  return row.n;
}

export function lastPersonInitiatedAt(personSlackId: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT created_at FROM social_engagements
    WHERE person_slack_id = ?
      AND direction IN ('owner_initiated', 'colleague_initiated')
    ORDER BY created_at DESC LIMIT 1
  `).get(personSlackId) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

export function lastMaelleInitiatedAt(personSlackId: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT created_at FROM social_engagements
    WHERE person_slack_id = ?
      AND direction = 'maelle_initiated'
    ORDER BY created_at DESC LIMIT 1
  `).get(personSlackId) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

// ── Weekly decay (per-owner sweep; walks all their persons) ──────────────────

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

// ── Back-compat aliases so 2.2.0 call sites keep working during refactor ─────

/** @deprecated v2.2.0 API — use getAllCategories() instead. */
export function getCategoriesForOwner(_ownerUserId: string): SocialCategory[] {
  return getAllCategories();
}

/** @deprecated v2.2.0 API — topics are now per-person. */
export function getAllTopicsForOwner(ownerUserId: string, opts?: { includeDormant?: boolean }): SocialTopic[] {
  return getAllTopicsForPerson(ownerUserId, opts);
}

/** @deprecated v2.2.0 API — topics are now per-person. */
export function getDormantTopicsForOwner(ownerUserId: string): SocialTopic[] {
  return getDormantTopicsForPerson(ownerUserId);
}

/** @deprecated v2.2.0 API — topics are per-(person, category). */
export function getActiveTopicsForCategory(categoryId: string): SocialTopic[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_topics_v2
    WHERE category_id = ? AND status = 'active'
    ORDER BY engagement_score DESC, last_touched_at DESC
  `).all(categoryId) as SocialTopic[];
}

/** @deprecated v2.2.0 API — use countMaelleInitiationsTodayForPerson(personSlackId) instead. */
export function countMaelleInitiationsToday(ownerUserId: string): number {
  return countMaelleInitiationsTodayForPerson(ownerUserId);
}

/** @deprecated v2.2.0 API — use lastPersonInitiatedAt / lastMaelleInitiatedAt. */
export function lastOwnerInitiatedAt(ownerUserId: string): string | null {
  return lastPersonInitiatedAt(ownerUserId);
}
