/**
 * Social Engine — subjects + topic-beats (v2.6.7 redesign).
 *
 * Three layers of social state:
 *
 *   social_categories — GLOBAL fixed 30 labels (gaming, family, side_projects, …).
 *                       Shared across owner + all colleagues. One canonical seed.
 *
 *   social_subjects   — per-(owner, person, category). The MEANINGFUL unit:
 *                       carries `engagement_score` (0..5), `status` (active|dormant),
 *                       `last_touched_at`, `last_assistant_initiated_at`. One subject =
 *                       one durable subject of conversation ("Clair Obscur Expedition 33").
 *                       Person-initiated creation: score 3. Assistant-initiated: score 2.
 *                       Cap 5; floor 0 → status='dormant'.
 *
 *   social_topics     — per-subject. Lightweight beats with no rank — concrete things
 *                       to talk about under a subject ("ending choice", "act 3 progress",
 *                       "Canvas decision"). Track `last_used_at` so the coda picker
 *                       avoids overusing any one beat.
 *
 * The pre-redesign schema was `social_topics_v2` (a flat layer the system used as
 * "subject" but called "topic", with no beat layer). That table fragmented heavily
 * — one game produced 5+ rows because the surface-string (Jaccard) reconciler
 * couldn't merge same-subject sub-beats. New schema: subjects merge cleanly via
 * the LLM classifier; beats persist under them as labels.
 *
 * Engagement signal rules (applied by the orchestrator post-classifier):
 *   - person spontaneously matches existing subject (no recent assistant raise) → +1
 *   - assistant raised a subject + person's NEXT message:
 *       · matches subject + non-negative sentiment → +1
 *       · matches subject + negative sentiment    → −1
 *       · doesn't match (any pivot, including task or bare ack) → −1
 *   - weekly decay: −1 to active subjects untouched 7+ days; floor 0 → dormant.
 *
 * Caps:
 *   - 5 active subjects per (person, category) — new beyond cap evicts lowest-score.
 *   - 10 topic-beats per subject — new beyond cap evicts oldest-by-last_used_at.
 *   - 3 active categories per person — soft target, picker behavior (NOT enforced here).
 */

import { getDb } from './client';
import logger from '../utils/logger';

// ── Fixed GLOBAL category list ───────────────────────────────────────────────

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
export type SubjectStatus = 'active' | 'dormant';
export type SubjectToucher = 'owner' | 'colleague' | 'assistant';
export type Sentiment = 'positive' | 'negative' | 'neutral';

export interface SocialCategory {
  id: string;
  owner_user_id: string;         // always 'global' (one canonical row per label)
  label: string;
  care_level: CareLevel;
  signals_positive: number;
  signals_negative: number;
  created_at: string;
  updated_at: string;
}

export interface SocialSubject {
  id: string;
  owner_user_id: string;          // multi-tenant boundary
  person_slack_id: string;        // whom this subject is about (owner or colleague)
  category_id: string;
  label: string;                  // "Clair Obscur Expedition 33"
  engagement_score: number;       // 0..5
  status: SubjectStatus;
  last_touched_at: string;
  last_touched_by: SubjectToucher;
  last_assistant_initiated_at: string | null;  // when the assistant last raised this
  created_by: SubjectToucher;
  created_at: string;
  updated_at: string;
}

export interface SocialTopicBeat {
  id: string;
  subject_id: string;
  label: string;                  // "ending choice", "Canvas decision", "act 3 progress"
  sentiment: Sentiment;
  created_by: SubjectToucher;
  created_at: string;
  last_used_at: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const SCORE_CAP = 5;
export const SCORE_FLOOR = 0;
export const DORMANT_THRESHOLD = 0;
export const DECAY_DAYS = 7;

// Creation values per the redesign:
//   person-initiated (owner / colleague): start at 3 (mid)
//   assistant-initiated:                  start at 2 (lower; needs engagement to grow)
export const SCORE_ON_CREATE_PERSON = 3;
export const SCORE_ON_CREATE_ASSISTANT = 2;

// Caps per the redesign.
export const MAX_ACTIVE_SUBJECTS_PER_CATEGORY = 5;
export const MAX_TOPIC_BEATS_PER_SUBJECT = 10;

// Soft target — picker behavior, not a hard cap.
export const TARGET_ACTIVE_CATEGORIES = 3;

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

// ── Category helpers ─────────────────────────────────────────────────────────

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

// ── Subject helpers ──────────────────────────────────────────────────────────

export function createSubject(params: {
  ownerUserId: string;
  personSlackId: string;
  categoryId: string;
  label: string;
  createdBy: SubjectToucher;
}): SocialSubject {
  const db = getDb();
  const id = `subj_${params.personSlackId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const score = params.createdBy === 'assistant' ? SCORE_ON_CREATE_ASSISTANT : SCORE_ON_CREATE_PERSON;

  // Cap enforcement: at most MAX_ACTIVE_SUBJECTS_PER_CATEGORY active rows per
  // (person, category). When at cap, evict the lowest-score active subject
  // (tiebreaker: oldest last_touched_at) by flipping it to dormant.
  const activeCount = db.prepare(`
    SELECT COUNT(*) as n FROM social_subjects
    WHERE owner_user_id = ? AND person_slack_id = ?
      AND category_id = ? AND status = 'active'
  `).get(params.ownerUserId, params.personSlackId, params.categoryId) as { n: number };
  if (activeCount.n >= MAX_ACTIVE_SUBJECTS_PER_CATEGORY) {
    const evictRow = db.prepare(`
      SELECT id FROM social_subjects
      WHERE owner_user_id = ? AND person_slack_id = ?
        AND category_id = ? AND status = 'active'
      ORDER BY engagement_score ASC, last_touched_at ASC
      LIMIT 1
    `).get(params.ownerUserId, params.personSlackId, params.categoryId) as { id: string } | undefined;
    if (evictRow) {
      db.prepare(`
        UPDATE social_subjects SET status = 'dormant', updated_at = datetime('now')
        WHERE id = ?
      `).run(evictRow.id);
      logger.info('Social subject evicted (cap reached)', {
        evictedId: evictRow.id, personSlackId: params.personSlackId, categoryId: params.categoryId,
      });
    }
  }

  db.prepare(`
    INSERT INTO social_subjects (
      id, owner_user_id, person_slack_id, category_id, label, engagement_score,
      status, last_touched_at, last_touched_by, last_assistant_initiated_at, created_by
    ) VALUES (
      @id, @owner_user_id, @person_slack_id, @category_id, @label, @score,
      'active', datetime('now'), @created_by, NULL, @created_by
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
  const row = db.prepare(`SELECT * FROM social_subjects WHERE id = ?`).get(id) as SocialSubject;
  logger.info('Social subject created', {
    id, label: params.label, categoryId: params.categoryId,
    personSlackId: params.personSlackId, createdBy: params.createdBy, initialScore: score,
  });
  return row;
}

export function getSubjectById(subjectId: string): SocialSubject | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM social_subjects WHERE id = ?`).get(subjectId) as SocialSubject | undefined;
  return row ?? null;
}

export function getActiveSubjectsForPersonCategory(personSlackId: string, categoryId: string): SocialSubject[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_subjects
    WHERE person_slack_id = ? AND category_id = ? AND status = 'active'
    ORDER BY engagement_score DESC, last_touched_at DESC
  `).all(personSlackId, categoryId) as SocialSubject[];
}

export function getActiveSubjectsForPerson(personSlackId: string): SocialSubject[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_subjects
    WHERE person_slack_id = ? AND status = 'active'
    ORDER BY engagement_score DESC, last_touched_at DESC
  `).all(personSlackId) as SocialSubject[];
}

export function getDormantSubjectsForPerson(personSlackId: string): SocialSubject[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_subjects
    WHERE person_slack_id = ? AND status = 'dormant'
    ORDER BY last_touched_at DESC
  `).all(personSlackId) as SocialSubject[];
}

/**
 * Subject most recently raised by the assistant (for the negative-feedback signal).
 * Used by the orchestrator on the NEXT inbound from this person to judge whether
 * they engaged with the raise.
 */
export function getMostRecentRaisedSubject(ownerUserId: string, personSlackId: string): SocialSubject | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM social_subjects
    WHERE owner_user_id = ? AND person_slack_id = ?
      AND last_assistant_initiated_at IS NOT NULL
    ORDER BY last_assistant_initiated_at DESC
    LIMIT 1
  `).get(ownerUserId, personSlackId) as SocialSubject | undefined;
  return row ?? null;
}

export function applyScoreDelta(subjectId: string, delta: number, touchedBy: SubjectToucher): SocialSubject | null {
  const db = getDb();
  const current = getSubjectById(subjectId);
  if (!current) return null;

  const nextScore = Math.min(SCORE_CAP, Math.max(SCORE_FLOOR, current.engagement_score + delta));
  const nextStatus: SubjectStatus = nextScore <= DORMANT_THRESHOLD ? 'dormant' : 'active';

  db.prepare(`
    UPDATE social_subjects
    SET engagement_score = @score,
        status = @status,
        last_touched_at = datetime('now'),
        last_touched_by = @touched_by,
        updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id: subjectId,
    score: nextScore,
    status: nextStatus,
    touched_by: touchedBy,
  });
  if (current.status !== nextStatus) {
    logger.info('Social subject status flipped', {
      subjectId, label: current.label, from: current.status, to: nextStatus, score: nextScore,
    });
  }
  return getSubjectById(subjectId);
}

export function reviveSubject(subjectId: string): SocialSubject | null {
  const db = getDb();
  const current = getSubjectById(subjectId);
  if (!current) return null;
  if (current.status === 'active') return current;
  // Revive at SCORE_ON_CREATE_PERSON (mid). Only the person can revive — caller enforces.
  db.prepare(`
    UPDATE social_subjects
    SET engagement_score = ?,
        status = 'active',
        last_touched_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(SCORE_ON_CREATE_PERSON, subjectId);
  logger.info('Social subject revived', { subjectId, label: current.label });
  return getSubjectById(subjectId);
}

/**
 * Mark that the assistant just raised this subject — used for the negative-feedback
 * signal on the next inbound. Bumps last_assistant_initiated_at.
 */
export function markSubjectRaised(subjectId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE social_subjects
    SET last_assistant_initiated_at = datetime('now'),
        last_touched_at = datetime('now'),
        last_touched_by = 'assistant',
        updated_at = datetime('now')
    WHERE id = ?
  `).run(subjectId);
}

/**
 * Clear the raised-marker after the signal is processed (so we don't double-apply).
 */
export function clearSubjectRaisedMarker(subjectId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE social_subjects
    SET last_assistant_initiated_at = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(subjectId);
}

// ── Topic-beat helpers ───────────────────────────────────────────────────────

export function recordTopicBeat(params: {
  subjectId: string;
  label: string;
  sentiment: Sentiment;
  createdBy: SubjectToucher;
}): SocialTopicBeat {
  const db = getDb();

  // Cap enforcement: at most MAX_TOPIC_BEATS_PER_SUBJECT rows per subject.
  // When at cap, evict the least-recently-used beat (last_used_at ASC).
  const beatCount = db.prepare(`
    SELECT COUNT(*) as n FROM social_topics WHERE subject_id = ?
  `).get(params.subjectId) as { n: number };
  if (beatCount.n >= MAX_TOPIC_BEATS_PER_SUBJECT) {
    const evictRow = db.prepare(`
      SELECT id FROM social_topics
      WHERE subject_id = ?
      ORDER BY last_used_at ASC, created_at ASC
      LIMIT 1
    `).get(params.subjectId) as { id: string } | undefined;
    if (evictRow) {
      db.prepare(`DELETE FROM social_topics WHERE id = ?`).run(evictRow.id);
    }
  }

  const id = `topic_${params.subjectId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO social_topics (
      id, subject_id, label, sentiment, created_by, last_used_at
    ) VALUES (
      @id, @subject_id, @label, @sentiment, @created_by, datetime('now')
    )
  `).run({
    id,
    subject_id: params.subjectId,
    label: params.label,
    sentiment: params.sentiment,
    created_by: params.createdBy,
  });
  return db.prepare(`SELECT * FROM social_topics WHERE id = ?`).get(id) as SocialTopicBeat;
}

export function getRecentTopicBeats(subjectId: string, limit: number = 5): SocialTopicBeat[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_topics
    WHERE subject_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(subjectId, limit) as SocialTopicBeat[];
}

export function pickLeastRecentlyUsedTopicBeat(subjectId: string): SocialTopicBeat | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM social_topics
    WHERE subject_id = ?
    ORDER BY last_used_at ASC
    LIMIT 1
  `).get(subjectId) as SocialTopicBeat | undefined;
  return row ?? null;
}

export function markTopicBeatUsed(beatId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE social_topics SET last_used_at = datetime('now') WHERE id = ?
  `).run(beatId);
}

// ── Per-(person, category) engagement aggregate (derived on-the-fly) ─────────
//
// AVERAGE of active subjects' engagement_score. NULL when no active subjects.
// Used by the picker for "how engaged is this category right now."

export interface CategoryEngagement {
  category_id: string;
  category_label: string;
  active_subject_count: number;
  avg_score: number | null;
}

export function getActiveCategoryEngagementForPerson(personSlackId: string): CategoryEngagement[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      c.id              AS category_id,
      c.label           AS category_label,
      COUNT(s.id)       AS active_subject_count,
      AVG(s.engagement_score) AS avg_score
    FROM social_categories c
    LEFT JOIN social_subjects s
      ON s.category_id = c.id
     AND s.person_slack_id = ?
     AND s.status = 'active'
    WHERE c.owner_user_id = 'global'
    GROUP BY c.id, c.label
    HAVING COUNT(s.id) > 0
    ORDER BY avg_score DESC
  `).all(personSlackId) as CategoryEngagement[];
}

// ── Counters used by proactive tick ──────────────────────────────────────────

/**
 * How many times has the assistant initiated social with this specific person
 * today? Used for the 1-per-day-per-person gate. Counts subjects whose
 * last_assistant_initiated_at falls today.
 */
export function countAssistantInitiationsTodayForPerson(personSlackId: string): number {
  const db = getDb();
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const iso = startOfDay.toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM social_subjects
    WHERE person_slack_id = ?
      AND last_assistant_initiated_at >= ?
  `).get(personSlackId, iso) as { n: number };
  return row.n;
}

export function lastAssistantInitiatedAt(personSlackId: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(last_assistant_initiated_at) AS most_recent FROM social_subjects
    WHERE person_slack_id = ?
  `).get(personSlackId) as { most_recent: string | null } | undefined;
  return row?.most_recent ?? null;
}

// ── Weekly decay (per-owner sweep) ───────────────────────────────────────────

export function runWeeklyDecay(ownerUserId: string): { decayed: number; dormantFlipped: number } {
  const db = getDb();
  const cutoff = new Date(Date.now() - DECAY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const stale = db.prepare(`
    SELECT id, engagement_score, label FROM social_subjects
    WHERE owner_user_id = ? AND status = 'active' AND last_touched_at < ?
  `).all(ownerUserId, cutoff) as Array<{ id: string; engagement_score: number; label: string }>;

  let decayed = 0;
  let dormantFlipped = 0;
  for (const s of stale) {
    const nextScore = Math.max(SCORE_FLOOR, s.engagement_score - 1);
    const nextStatus: SubjectStatus = nextScore <= DORMANT_THRESHOLD ? 'dormant' : 'active';
    db.prepare(`
      UPDATE social_subjects
      SET engagement_score = @score,
          status = @status,
          updated_at = datetime('now')
      WHERE id = @id
    `).run({ id: s.id, score: nextScore, status: nextStatus });
    decayed++;
    if (nextStatus === 'dormant') dormantFlipped++;
  }

  if (decayed > 0) {
    logger.info('Social weekly decay pass', { ownerUserId, decayed, dormantFlipped });
  }
  return { decayed, dormantFlipped };
}

/**
 * Most-recent topic touch for a person — used by the proactive tick eligibility
 * gate (preserved from prior behavior). Returns 0 when no subject exists.
 */
export function lastTopicTouchMs(personSlackId: string, ownerUserId: string): number {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT MAX(last_touched_at) AS most_recent
      FROM social_subjects
      WHERE owner_user_id = ?
        AND person_slack_id = ?
    `).get(ownerUserId, personSlackId) as { most_recent: string | null } | undefined;
    if (!row?.most_recent) return 0;
    const t = new Date(row.most_recent).getTime();
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}
