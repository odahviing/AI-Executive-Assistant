/**
 * Social Engine — categories, per-person category scores, subjects + topic-beats.
 *
 * Three layers of social state:
 *
 *   social_categories               — GLOBAL fixed 30 labels (gaming, family,
 *                                     side_projects, …). Shared across owner +
 *                                     all colleagues. One canonical seed, no
 *                                     per-person state of its own.
 *
 *   social_person_category_scores   — per-(owner, person, category) standing,
 *                                     0..3, directly queryable (v4.5.9 / #198).
 *                                     Moves ONLY on engagement — a match, a
 *                                     new subject, a raise that lands — never
 *                                     on the passage of time. Replaces the old
 *                                     on-the-fly AVG(subject.engagement_score)
 *                                     derivation; that read (and the per-
 *                                     category signals_positive/negative
 *                                     counters it used to feed) is gone.
 *
 *   social_subjects                 — per-(owner, person, category). The
 *                                     MEANINGFUL unit: one durable subject of
 *                                     conversation ("Clair Obscur Expedition
 *                                     33"). Carries `status` (live|dead) and
 *                                     `unanswered_raises` — a subject dies on
 *                                     TWO unanswered raises, an explicit
 *                                     reject (capturePass.ts), or — when it is
 *                                     inherently time-bound — its
 *                                     `relevant_until` date passing. Subjects
 *                                     themselves no longer carry a score
 *                                     (v4.5.9) — standing lives on the
 *                                     category above.
 *
 *   social_topics                   — per-subject. Lightweight beats with no
 *                                     rank — concrete things to talk about
 *                                     under a subject ("ending choice", "act 3
 *                                     progress", "Canvas decision").
 *
 * v4.5.9 (#198) redesign — replaced the v2.6.7 engagement_score/weekly-decay
 * model (subjects 0..5, floor→dormant, −1/week untouched) entirely:
 *   - Category standing moved to social_person_category_scores (0..3).
 *   - Subjects lost their score; `status` is repurposed active|dormant →
 *     live|dead, and a subject dies on the raise counter or an explicit
 *     reject — never on time. `runWeeklyDecay` and the picker's 72h
 *     ignored-raise-decay (`applyIgnoredRaiseDecay`) are both gone —
 *     "unanswered" is now detected once, at end-of-chat reconciliation
 *     (core/social/logEngagement.ts), not re-derived from a clock on every
 *     picker sweep.
 *
 * Owner design 2026-08-30 — three additions on top of that:
 *   - `relevant_until` (nullable date) on subjects: an inherently time-bound
 *     subject ("vacation in August", "the conference next week") is
 *     calendar-dead once its date passes, regardless of engagement — a
 *     second, independent path into the same `dead` status, swept lazily at
 *     the live-only read sites (sweepExpiredSubjectsForPerson). This is NOT
 *     the removed engagement decay coming back: it is a stored fact about
 *     the subject, set by the reconciler (capturePass.ts, same Haiku call)
 *     only when the content is genuinely date-bound. Most subjects never
 *     carry one.
 *   - In-place category-raise tracking on social_person_category_scores
 *     (`last_raise_attempt_at` + `unanswered_raises`): a raise_new aimed at
 *     a category that already has standing (score > 0) leaves no subject row
 *     behind, so its silence is judged on the category row itself — two
 *     unanswered in-place raises zero the score (the category dies, same
 *     MAX_UNANSWERED_RAISES threshold), mirroring the subject rule (L12's
 *     silence-twice natural death). Any subject landing in the category
 *     resets it (resetCategoryRaiseState).
 *   - A dead subject the person genuinely re-raises themselves is REVIVED by
 *     the reconciler (reviveSubject), never duplicated into a second row
 *     (L11 / L12).
 *
 * Caps:
 *   - 5 live subjects per (person, category) — new beyond cap evicts the
 *     least-recently-touched live subject (no score left to break ties on).
 *   - 10 topic-beats per subject — new beyond cap evicts oldest-by-last_used_at.
 *   - 3 active categories per person (score > 0) — HARD cap, enforced at the
 *     creation site (capturePass.ts), not here and not in the picker.
 */

import { DateTime } from 'luxon';
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

export type SubjectStatus = 'live' | 'dead';
export type SubjectToucher = 'owner' | 'colleague' | 'assistant';
export type Sentiment = 'positive' | 'negative' | 'neutral';

export interface SocialCategory {
  id: string;
  owner_user_id: string;         // always 'global' (one canonical row per label)
  label: string;
  created_at: string;
  updated_at: string;
}

export interface PersonCategoryScore {
  id: string;
  owner_user_id: string;
  person_slack_id: string;
  category_id: string;
  score: number;                 // 0..3
  // Owner design 2026-08-30 — in-place raise tracking (see file header).
  unanswered_raises: number;     // in-place raises with no reply; score zeroed at MAX_UNANSWERED_RAISES
  last_raise_attempt_at: string | null;  // when a raise_new coda targeting this category was last DELIVERED (markCategoryRaised, via recordCodaDelivered)
  created_at: string;
  updated_at: string;
}

export interface PersonCategoryScoreWithLabel extends PersonCategoryScore {
  category_label: string;
}

export interface SocialSubject {
  id: string;
  owner_user_id: string;          // multi-tenant boundary
  person_slack_id: string;        // whom this subject is about (owner or colleague)
  category_id: string;
  label: string;                  // "Clair Obscur Expedition 33"
  status: SubjectStatus;          // live | dead
  unanswered_raises: number;      // dies at MAX_UNANSWERED_RAISES
  last_touched_at: string;
  last_touched_by: SubjectToucher;
  last_assistant_initiated_at: string | null;  // when the assistant last raised this
  created_by: SubjectToucher;
  created_at: string;
  updated_at: string;
  // gh#(item-3, 2026-08-16) — running per-subject summary, MERGED across every
  // reconciliation that touches this subject (never overwritten wholesale).
  // Column added by the idempotent ALTER in db/client.ts (initSchema).
  // Optional/nullable: absent reads as "no summary yet", not an error.
  summary?: string | null;
  // Owner design 2026-08-30 — optional calendar expiry, "YYYY-MM-DD". Only
  // inherently time-bound subjects carry one (set by the reconciler's
  // existing Haiku call, capturePass.ts); once the date passes the subject
  // is swept to `dead` (sweepExpiredSubjectsForPerson) regardless of
  // engagement. NULL/absent = no natural expiry (the normal case).
  relevant_until?: string | null;
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

export const MAX_ACTIVE_SUBJECTS_PER_CATEGORY = 5;
export const MAX_TOPIC_BEATS_PER_SUBJECT = 10;

// Owner asked for "5-10 sentences... cap the size but we have room" — generous
// per L14, but not unbounded: a defensive code-side ceiling so a runaway Haiku
// merge can't grow one subject's summary without limit. ~1800 chars covers 10
// generous sentences with room to spare.
export const MAX_SUBJECT_SUMMARY_CHARS = 1800;

// A subject dies after this many raises in a row that got no reply. Keyed on
// the existing last_assistant_initiated_at stamp: every raise clears to NULL
// once the person's next chat reconciles it (matched → answered, resets to 0;
// pivot → unanswered, +1 here) so no time window is ever consulted.
// Owner design 2026-08-30 — also the death threshold for in-place CATEGORY
// raises (recordCategoryRaiseUnanswered below): same L12 silence-twice rule,
// one constant, never a bespoke scale per surface.
export const MAX_UNANSWERED_RAISES = 2;

// Per-person category standing, 0..3.
export const CATEGORY_SCORE_CAP = 3;
export const CATEGORY_SCORE_FLOOR = 0;

// Hard cap on how many categories a person can be "active" in at once
// (score > 0). Enforced at the reconciler's create branch (capturePass.ts) —
// a 4th is refused outright, never rotated in over an existing one.
export const MAX_ACTIVE_CATEGORIES_PER_PERSON = 3;

const GLOBAL_OWNER = 'global';

// ── Bootstrap: seed the 30 global categories (once) ──────────────────────────

export function ensureCategoriesSeeded(_ownerUserId?: string): void {
  const db = getDb();
  const existing = db
    .prepare(`SELECT COUNT(*) as n FROM social_categories WHERE owner_user_id = ?`)
    .get(GLOBAL_OWNER) as { n: number };
  if (existing.n >= FIXED_CATEGORIES.length) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO social_categories (id, owner_user_id, label)
    VALUES (@id, 'global', @label)
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

export function getCategoryByLabel(label: string): SocialCategory | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM social_categories WHERE owner_user_id = ? AND label = ?`)
    .get(GLOBAL_OWNER, label.toLowerCase()) as SocialCategory | undefined;
  return row ?? null;
}

// ── Per-person category score helpers (v4.5.9 / #198) ────────────────────────

/** Every category this person has ANY standing in (score 0..3), joined to
 *  its label. Used for the create-time active-category count. */
export function getCategoryScoresForPerson(personSlackId: string): PersonCategoryScoreWithLabel[] {
  const db = getDb();
  return db.prepare(`
    SELECT p.*, c.label AS category_label
    FROM social_person_category_scores p
    JOIN social_categories c ON c.id = p.category_id
    WHERE p.person_slack_id = ?
    ORDER BY p.score DESC
  `).all(personSlackId) as PersonCategoryScoreWithLabel[];
}

/** Categories with real, current standing (score > 0) — what the picker
 *  chooses among. Replaces the old on-the-fly
 *  AVG(subject.engagement_score) derivation. */
export function getActiveCategoriesForPerson(personSlackId: string): PersonCategoryScoreWithLabel[] {
  const db = getDb();
  return db.prepare(`
    SELECT p.*, c.label AS category_label
    FROM social_person_category_scores p
    JOIN social_categories c ON c.id = p.category_id
    WHERE p.person_slack_id = ? AND p.score > 0
    ORDER BY p.score DESC
  `).all(personSlackId) as PersonCategoryScoreWithLabel[];
}

export function countActiveCategoriesForPerson(personSlackId: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM social_person_category_scores
    WHERE person_slack_id = ? AND score > 0
  `).get(personSlackId) as { n: number };
  return row.n;
}

export function isCategoryActiveForPerson(personSlackId: string, categoryId: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT score FROM social_person_category_scores WHERE person_slack_id = ? AND category_id = ?
  `).get(personSlackId, categoryId) as { score: number } | undefined;
  return !!row && row.score > 0;
}

/**
 * Move a person's standing in one category by `delta`, clamped to
 * [CATEGORY_SCORE_FLOOR, CATEGORY_SCORE_CAP]. Upserts — a person's first
 * touch of a category creates its row at the clamped delta (from 0).
 * The ONLY mover of this score; nothing moves it on a schedule (answer 14).
 */
export function adjustCategoryScore(params: {
  ownerUserId: string;
  personSlackId: string;
  categoryId: string;
  delta: number;
}): PersonCategoryScore {
  const db = getDb();
  const { ownerUserId, personSlackId, categoryId, delta } = params;
  const existing = db.prepare(`
    SELECT * FROM social_person_category_scores
    WHERE owner_user_id = ? AND person_slack_id = ? AND category_id = ?
  `).get(ownerUserId, personSlackId, categoryId) as PersonCategoryScore | undefined;

  const current = existing?.score ?? 0;
  const nextScore = Math.min(CATEGORY_SCORE_CAP, Math.max(CATEGORY_SCORE_FLOOR, current + delta));
  // Same id scheme the v4.5.9 backfill migration used, so a migrated row and
  // a freshly-written one for the same (person, category) are the same row.
  const id = existing?.id ?? `pcs_${personSlackId}_${categoryId}`;

  db.prepare(`
    INSERT INTO social_person_category_scores (id, owner_user_id, person_slack_id, category_id, score)
    VALUES (@id, @owner_user_id, @person_slack_id, @category_id, @score)
    ON CONFLICT(owner_user_id, person_slack_id, category_id)
    DO UPDATE SET score = @score, updated_at = datetime('now')
  `).run({
    id, owner_user_id: ownerUserId, person_slack_id: personSlackId,
    category_id: categoryId, score: nextScore,
  });

  return db.prepare(`SELECT * FROM social_person_category_scores WHERE id = ?`).get(id) as PersonCategoryScore;
}

/**
 * gh#198 (answer 3/10 follow-up, bounce fix) — mark that a category was just
 * OFFERED a `raise_new` candidate, even though nothing has engaged with it
 * yet (no subject exists to carry that memory). Without this, a dormant
 * category with no active subject was indistinguishable from one Maelle has
 * never mentioned, so `pickDormantCategory` (stateMachine.ts) — deterministic
 * by design — picked the exact same dormant category every single day until
 * a subject happened to land in it: re-asking the same thing forever, the
 * opposite of "she never re-asks what she already asked."
 *
 * Called at COMPOSE time (generateCoda.ts), before the validator — a
 * candidate the validator later drops still consumed this category's one
 * free rotation slot. That slot is ALL a failed candidate consumes: this
 * only plants a fresh score-0 row (an existing row is left untouched) and
 * NEVER writes `last_raise_attempt_at` — the silence-judgment stamp that
 * recordCategoryRaiseUnanswered counts toward category death is charged at
 * confirmed delivery only (markCategoryRaised below), so a dropped or
 * never-sent candidate can never read as "raised and ignored". Never itself
 * a form of engagement (answer 14 — score moves on engagement alone), so it
 * never bumps the score.
 */
export function recordCategoryRaiseTried(params: {
  ownerUserId: string;
  personSlackId: string;
  categoryId: string;
}): void {
  const db = getDb();
  const { ownerUserId, personSlackId, categoryId } = params;
  const id = `pcs_${personSlackId}_${categoryId}`;
  db.prepare(`
    INSERT INTO social_person_category_scores
      (id, owner_user_id, person_slack_id, category_id, score)
    VALUES (@id, @owner_user_id, @person_slack_id, @category_id, 0)
    ON CONFLICT(owner_user_id, person_slack_id, category_id) DO NOTHING
  `).run({
    id, owner_user_id: ownerUserId, person_slack_id: personSlackId, category_id: categoryId,
  });
}

/**
 * Stamp that a `raise_new` coda targeting this category was actually
 * DELIVERED — the category analog of markSubjectRaised, called only from
 * recordCodaDelivered (logEngagement.ts) at the transport's confirmed-post
 * point. For a dormant category the stamp is inert (the picker's resolve
 * pass only judges rows with score > 0); for an ACTIVE one (an in-place
 * raise, stage 2 of the picker) it is the marker that pass reads to judge
 * the raise's silence — see recordCategoryRaiseUnanswered below. Upserts
 * defensively, though in practice recordCategoryRaiseTried already planted
 * the row at compose time.
 */
export function markCategoryRaised(params: {
  ownerUserId: string;
  personSlackId: string;
  categoryId: string;
}): void {
  const db = getDb();
  const { ownerUserId, personSlackId, categoryId } = params;
  const id = `pcs_${personSlackId}_${categoryId}`;
  db.prepare(`
    INSERT INTO social_person_category_scores
      (id, owner_user_id, person_slack_id, category_id, score, last_raise_attempt_at)
    VALUES (@id, @owner_user_id, @person_slack_id, @category_id, 0, datetime('now'))
    ON CONFLICT(owner_user_id, person_slack_id, category_id)
    DO UPDATE SET last_raise_attempt_at = datetime('now'), updated_at = datetime('now')
  `).run({
    id, owner_user_id: ownerUserId, person_slack_id: personSlackId, category_id: categoryId,
  });
}

/**
 * Owner design 2026-08-30 — an in-place raise (raise_new into a category with
 * standing but no live subject) got no reply: +1 unanswered, marker cleared;
 * at MAX_UNANSWERED_RAISES the category's score is zeroed — it dies and its
 * picker slot frees. The counter also resets on death so a later organic
 * revival of the category starts clean. The score-0 row left behind reads as
 * "tried" to pickDormantCategory, so the just-killed category is not
 * immediately re-offered as a discovery.
 *
 * Called ONLY from the picker's resolve-on-read pass (stateMachine.ts), the
 * same lazy moment subject raises are judged — never on a background timer.
 */
export function recordCategoryRaiseUnanswered(params: {
  ownerUserId: string;
  personSlackId: string;
  categoryId: string;
}): { died: boolean } {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM social_person_category_scores
    WHERE owner_user_id = ? AND person_slack_id = ? AND category_id = ?
  `).get(params.ownerUserId, params.personSlackId, params.categoryId) as PersonCategoryScore | undefined;
  if (!row) return { died: false };

  const nextCount = row.unanswered_raises + 1;
  const dies = nextCount >= MAX_UNANSWERED_RAISES;
  db.prepare(`
    UPDATE social_person_category_scores
    SET unanswered_raises = @count,
        score = @score,
        last_raise_attempt_at = NULL,
        updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id: row.id,
    count: dies ? 0 : nextCount,
    score: dies ? CATEGORY_SCORE_FLOOR : row.score,
  });
  if (dies) {
    logger.info('Social category died — 2 unanswered in-place raises, score zeroed', {
      personSlackId: params.personSlackId, categoryId: params.categoryId,
    });
  }
  return { died: dies };
}

/**
 * Owner design 2026-08-30 — clear a category's in-place raise state: a live
 * subject landed in it (created or revived), which is engagement, so any
 * standing raise marker/counter is moot. Also consulted lazily by the picker
 * when it finds live subjects under a marked category.
 */
export function resetCategoryRaiseState(ownerUserId: string, personSlackId: string, categoryId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE social_person_category_scores
    SET unanswered_raises = 0, last_raise_attempt_at = NULL, updated_at = datetime('now')
    WHERE owner_user_id = ? AND person_slack_id = ? AND category_id = ?
      AND (unanswered_raises != 0 OR last_raise_attempt_at IS NOT NULL)
  `).run(ownerUserId, personSlackId, categoryId);
}

// ── Subject helpers ──────────────────────────────────────────────────────────

/**
 * Cap enforcement: at most MAX_ACTIVE_SUBJECTS_PER_CATEGORY live rows per
 * (person, category). At cap, evict the least-recently-touched live subject
 * (subjects no longer carry a score to break ties on). Shared by
 * createSubject and reviveSubject — both add a live row.
 */
function evictLruLiveSubjectIfAtCap(ownerUserId: string, personSlackId: string, categoryId: string): void {
  const db = getDb();
  const activeCount = db.prepare(`
    SELECT COUNT(*) as n FROM social_subjects
    WHERE owner_user_id = ? AND person_slack_id = ?
      AND category_id = ? AND status = 'live'
  `).get(ownerUserId, personSlackId, categoryId) as { n: number };
  if (activeCount.n < MAX_ACTIVE_SUBJECTS_PER_CATEGORY) return;
  const evictRow = db.prepare(`
    SELECT id FROM social_subjects
    WHERE owner_user_id = ? AND person_slack_id = ?
      AND category_id = ? AND status = 'live'
    ORDER BY last_touched_at ASC
    LIMIT 1
  `).get(ownerUserId, personSlackId, categoryId) as { id: string } | undefined;
  if (evictRow) {
    db.prepare(`
      UPDATE social_subjects SET status = 'dead', updated_at = datetime('now')
      WHERE id = ?
    `).run(evictRow.id);
    logger.info('Social subject evicted (cap reached)', {
      evictedId: evictRow.id, personSlackId, categoryId,
    });
  }
}

/**
 * Owner design 2026-08-30 — lazy calendar-death sweep. Flips to `dead` every
 * live subject whose `relevant_until` date has passed; called at the
 * live-only read chokepoints below so every consumer (picker, reconciler,
 * coda composer, caps) sees post-expiry truth without a background timer.
 * Independent of the unanswered-raise path — two ways into the same status.
 * Date-granular on purpose ("until roughly when" is inherently rough): the
 * subject stays raisable through its relevant_until day, UTC.
 */
export function sweepExpiredSubjectsForPerson(personSlackId: string): void {
  const db = getDb();
  const info = db.prepare(`
    UPDATE social_subjects
    SET status = 'dead', last_assistant_initiated_at = NULL, updated_at = datetime('now')
    WHERE person_slack_id = ? AND status = 'live'
      AND relevant_until IS NOT NULL
      AND date(relevant_until) < date('now')
  `).run(personSlackId);
  if (info.changes > 0) {
    logger.info('Social subject(s) expired — relevant_until passed', {
      personSlackId, count: info.changes,
    });
  }
}

export function createSubject(params: {
  ownerUserId: string;
  personSlackId: string;
  categoryId: string;
  label: string;
  createdBy: SubjectToucher;
}): SocialSubject {
  const db = getDb();
  const id = `subj_${params.personSlackId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  evictLruLiveSubjectIfAtCap(params.ownerUserId, params.personSlackId, params.categoryId);

  db.prepare(`
    INSERT INTO social_subjects (
      id, owner_user_id, person_slack_id, category_id, label,
      status, unanswered_raises, last_touched_at, last_touched_by,
      last_assistant_initiated_at, created_by
    ) VALUES (
      @id, @owner_user_id, @person_slack_id, @category_id, @label,
      'live', 0, datetime('now'), @created_by, NULL, @created_by
    )
  `).run({
    id,
    owner_user_id: params.ownerUserId,
    person_slack_id: params.personSlackId,
    category_id: params.categoryId,
    label: params.label,
    created_by: params.createdBy,
  });

  // Creating a subject IS an engagement signal — the person just surfaced
  // this topic for the first time. Register it against the category's
  // per-person standing (this piece's own design choice — the category
  // score moves on engagement alone, and a first mention is the simplest
  // form of engagement there is).
  adjustCategoryScore({
    ownerUserId: params.ownerUserId,
    personSlackId: params.personSlackId,
    categoryId: params.categoryId,
    delta: 1,
  });

  // Owner design 2026-08-30 — a subject landing in this category answers (or
  // moots) any standing in-place raise on it: clear the marker/counter.
  resetCategoryRaiseState(params.ownerUserId, params.personSlackId, params.categoryId);

  const row = db.prepare(`SELECT * FROM social_subjects WHERE id = ?`).get(id) as SocialSubject;
  logger.info('Social subject created', {
    id, label: params.label, categoryId: params.categoryId,
    personSlackId: params.personSlackId, createdBy: params.createdBy,
  });
  return row;
}

export function getSubjectById(subjectId: string): SocialSubject | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM social_subjects WHERE id = ?`).get(subjectId) as SocialSubject | undefined;
  return row ?? null;
}

export function getActiveSubjectsForPersonCategory(personSlackId: string, categoryId: string): SocialSubject[] {
  sweepExpiredSubjectsForPerson(personSlackId);
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_subjects
    WHERE person_slack_id = ? AND category_id = ? AND status = 'live'
    ORDER BY last_assistant_initiated_at ASC NULLS FIRST, last_touched_at DESC
  `).all(personSlackId, categoryId) as SocialSubject[];
}

export function getActiveSubjectsForPerson(personSlackId: string): SocialSubject[] {
  sweepExpiredSubjectsForPerson(personSlackId);
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_subjects
    WHERE person_slack_id = ? AND status = 'live'
    ORDER BY last_touched_at DESC
  `).all(personSlackId) as SocialSubject[];
}

/**
 * EVERY subject for this person, live or dead, live-first then most
 * recently touched. Used by get_person_memory (item 2, 2026-08-16) — a dead
 * subject is real memory ("we used to talk about X"), not a row to hide, and
 * 4.6.0 already made revival-on-mention a designed behaviour (L12). Distinct
 * from `getActiveSubjectsForPerson`, which stays live-only for every
 * proactive-social caller that must never raise a dead topic.
 */
export function getAllSubjectsForPerson(personSlackId: string): SocialSubject[] {
  sweepExpiredSubjectsForPerson(personSlackId);  // live/dead split shown must be post-expiry truth
  const db = getDb();
  return db.prepare(`
    SELECT * FROM social_subjects
    WHERE person_slack_id = ?
    ORDER BY CASE WHEN status = 'live' THEN 0 ELSE 1 END, last_touched_at DESC
  `).all(personSlackId) as SocialSubject[];
}

/**
 * Subject most recently raised by the assistant (for the raise-feedback
 * signal). Used by the orchestrator on the NEXT inbound from this person to
 * judge whether they engaged with the raise.
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

/**
 * Mark that the assistant just raised this subject — used for the raise-
 * feedback signal on the next inbound + the picker's once-per-day
 * initiation gates. Bumps ONLY last_assistant_initiated_at.
 */
export function markSubjectRaised(subjectId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE social_subjects
    SET last_assistant_initiated_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(subjectId);
}

/**
 * The person answered the subject the assistant most recently raised on
 * them (their next chat matched it). Resets unanswered_raises to 0 — the
 * raise got a real reply — clears the raise marker, and records the touch.
 * Never revives a dead subject on its own; a dead subject never appears in
 * `getActiveSubjectsForPerson*` in the first place, so this is only ever
 * called on a subject that was live when raised.
 */
export function recordSubjectAnswered(subjectId: string, touchedBy: SubjectToucher): SocialSubject | null {
  const db = getDb();
  db.prepare(`
    UPDATE social_subjects
    SET unanswered_raises = 0,
        last_touched_at = datetime('now'),
        last_touched_by = @touched_by,
        last_assistant_initiated_at = NULL,
        updated_at = datetime('now')
    WHERE id = @id
  `).run({ id: subjectId, touched_by: touchedBy });
  return getSubjectById(subjectId);
}

/**
 * The assistant raised this subject and the person's next chat did NOT touch
 * it (pivot) — an unanswered raise. +1 to unanswered_raises; at
 * MAX_UNANSWERED_RAISES (2) the subject dies. Replaces both the old
 * 72h-window applyIgnoredRaiseDecay and the weekly runWeeklyDecay sweep.
 * The other paths into `dead`: an explicit reject (capturePass.ts), the
 * per-category cap eviction, and — since 2026-08-30 — a time-bound subject's
 * `relevant_until` passing (sweepExpiredSubjectsForPerson above).
 */
export function recordSubjectUnanswered(subjectId: string): SocialSubject | null {
  const db = getDb();
  const current = getSubjectById(subjectId);
  if (!current) return null;

  const nextCount = current.unanswered_raises + 1;
  // Never resurrect: a subject already dead (explicit reject, cap eviction,
  // relevant_until expiry) stays dead — this call may still land on one via
  // getMostRecentRaisedSubject's status-blind read (logEngagement.ts pivot)
  // when the subject died between the raise and its resolution. Before this
  // guard, a rejected subject with its raise marker still standing was
  // flipped BACK to live by the very next pivot (count 0→1 < 2 → 'live').
  const nextStatus: SubjectStatus = current.status === 'dead' || nextCount >= MAX_UNANSWERED_RAISES
    ? 'dead' : 'live';

  db.prepare(`
    UPDATE social_subjects
    SET unanswered_raises = @count,
        status = @status,
        last_assistant_initiated_at = NULL,
        updated_at = datetime('now')
    WHERE id = @id
  `).run({ id: subjectId, count: nextCount, status: nextStatus });

  if (nextStatus === 'dead') {
    logger.info('Social subject died — 2 unanswered raises', { subjectId, label: current.label });
  }
  return getSubjectById(subjectId);
}

/**
 * Kill a subject outright — the person explicitly waved it off ("not
 * relevant" / "stop"), or the reconciler classified the content as work and
 * is rejecting an existing row that was wrongly capturing it. Distinct from
 * the raise-counter path above: this is immediate, not a count. Also clears
 * any standing raise marker — the reject IS the raise's resolution, so it
 * must not linger for a later pivot pass to "resolve" again (see the
 * never-resurrect guard in recordSubjectUnanswered).
 */
export function markSubjectDead(subjectId: string): SocialSubject | null {
  const db = getDb();
  db.prepare(`
    UPDATE social_subjects
    SET status = 'dead', last_assistant_initiated_at = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(subjectId);
  return getSubjectById(subjectId);
}

/**
 * Owner design 2026-08-30 — REVIVE a dead subject the person genuinely
 * re-raised themselves (L12: self-raised again = positive, revives above
 * where it died; L11: never a duplicate row for the same subject). Called by
 * the reconciler (capturePass.ts) when Haiku matches a dead row shown in its
 * inactive list. Resets the raise counter, clears any stale raise marker,
 * records the touch, and clears the category's in-place raise state — the
 * person re-engaging with the subject IS engagement with its category.
 *
 * `relevant_until` is deliberately NOT cleared: a time-bound subject revived
 * by a retrospective mention ("the trip was great") re-retires at the next
 * sweep unless the reconciler also emitted a fresh date — the row still got
 * the summary/beat writes, which is the point of matching over duplicating.
 *
 * Respects the 5-live-per-category cap via the same LRU eviction as create.
 */
export function reviveSubject(subjectId: string, touchedBy: SubjectToucher): SocialSubject | null {
  const db = getDb();
  const current = getSubjectById(subjectId);
  if (!current) return null;
  if (current.status === 'live') return current;

  evictLruLiveSubjectIfAtCap(current.owner_user_id, current.person_slack_id, current.category_id);
  db.prepare(`
    UPDATE social_subjects
    SET status = 'live', unanswered_raises = 0,
        last_touched_at = datetime('now'), last_touched_by = @touched_by,
        last_assistant_initiated_at = NULL,
        updated_at = datetime('now')
    WHERE id = @id
  `).run({ id: subjectId, touched_by: touchedBy });
  resetCategoryRaiseState(current.owner_user_id, current.person_slack_id, current.category_id);
  logger.info('Social subject revived — person re-raised it themselves', {
    subjectId, label: current.label,
  });
  return getSubjectById(subjectId);
}

/**
 * Owner design 2026-08-30 — set/refresh a subject's calendar expiry. Written
 * by the reconciler (capturePass.ts) from the same Haiku call that decides
 * match/create; `relevantUntil` is already validated upstream to a strict
 * YYYY-MM-DD (a structured string, W4-legal regex). Never clears — an
 * omitted date leaves the stored fact standing.
 */
export function updateSubjectRelevantUntil(subjectId: string, relevantUntil: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE social_subjects SET relevant_until = @ru, updated_at = datetime('now')
    WHERE id = @id
  `).run({ id: subjectId, ru: relevantUntil });
}

/**
 * Organic touch — the person spontaneously engaged with an existing subject
 * that wasn't the pending raise. Bumps last_touched_at/by; the engagement
 * itself is scored on the category (adjustCategoryScore), not here —
 * subjects no longer carry a score.
 *
 * gh#198 (answer 21b) — also resets `unanswered_raises` to 0. A subject can
 * carry a stale unanswered count (1, not yet dead) from an earlier raise that
 * genuinely got no reply at the time — resolve-on-read (stateMachine.ts)
 * already recorded that. If the person THEN comes back later and touches the
 * subject on their own (no pending raise to answer directly, so this organic
 * path is what fires, not recordSubjectAnswered), that touch is real
 * engagement and must clear the count — otherwise a late answer never resets
 * it and a subject that WAS eventually answered can still die on its next
 * unrelated pivot.
 */
export function recordSubjectTouch(subjectId: string, touchedBy: SubjectToucher): SocialSubject | null {
  const db = getDb();
  db.prepare(`
    UPDATE social_subjects
    SET last_touched_at = datetime('now'), last_touched_by = @touched_by,
        unanswered_raises = 0, updated_at = datetime('now')
    WHERE id = @id
  `).run({ id: subjectId, touched_by: touchedBy });
  return getSubjectById(subjectId);
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

  // Bump the parent subject's last_touched_at — recording a beat IS an
  // activity signal, so a subject with ongoing topic-beat activity keeps
  // its touch timestamp current (used for the eviction tiebreak above and
  // the picker's least-recently-touched pick).
  db.prepare(`
    UPDATE social_subjects
    SET last_touched_at = datetime('now'),
        last_touched_by = @created_by,
        updated_at = datetime('now')
    WHERE id = @subject_id
  `).run({ subject_id: params.subjectId, created_by: params.createdBy });

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

/**
 * Write the MERGED running summary for a subject (item 3, 2026-08-16) —
 * called from capturePass.ts's `runSubjectReconciliation`, the SAME Haiku
 * call that already decides match/create/reject, never a second call. The
 * caller is responsible for the merge itself (Haiku sees the current summary
 * in its prompt context and returns the complete updated text); this is a
 * plain overwrite of that already-merged value, capped defensively so a
 * runaway response can't grow the row without bound.
 *
 * REQUIRES the `social_subjects.summary` column — see the migration note on
 * `SocialSubject.summary` above. Until that column exists this throws
 * "no such column"; every caller here runs inside `runSubjectReconciliation`'s
 * existing try/catch (fire-and-forget, logged, never fatal).
 */
export function updateSubjectSummary(subjectId: string, summary: string): void {
  const db = getDb();
  const trimmed = summary.trim().slice(0, MAX_SUBJECT_SUMMARY_CHARS);
  if (!trimmed) return;
  db.prepare(`
    UPDATE social_subjects SET summary = @summary, updated_at = datetime('now')
    WHERE id = @id
  `).run({ id: subjectId, summary: trimmed });
}

// ── Read-side shaping for get_person_memory (item 2, 2026-08-16) ────────────

export interface PersonSocialSubjectView {
  category: string;
  label: string;
  summary: string | null;
  recent_beats: string[];
}

export interface PersonSocialSummary {
  live: PersonSocialSubjectView[];
  dead: PersonSocialSubjectView[];
}

/**
 * Shaped, capped social memory for one person — subjects + their merged
 * summary (once the item-3 column exists) or, until then, their recent
 * topic-beat labels as the fallback content. Dead subjects are included and
 * marked, never dropped (L12) — "we used to talk about X" is real memory.
 * Capped (not every row) per the owner's own proportionality note: this
 * payload already runs to 24KB for a well-known person before social data is
 * added at all.
 */
export function getPersonSocialSummary(
  personSlackId: string,
  maxLive: number = 10,
  maxDead: number = 5,
): PersonSocialSummary {
  const all = getAllSubjectsForPerson(personSlackId);
  const shape = (s: SocialSubject): PersonSocialSubjectView => ({
    category: s.category_id.replace(/^cat_global_/, ''),
    label: s.label,
    summary: s.summary ?? null,
    recent_beats: getRecentTopicBeats(s.id, 3).map(b => b.label),
  });
  return {
    live: all.filter(s => s.status === 'live').slice(0, maxLive).map(shape),
    dead: all.filter(s => s.status === 'dead').slice(0, maxDead).map(shape),
  };
}

// gh#198 — `pickLeastRecentlyUsedTopicBeat` / `markTopicBeatUsed` deleted.
// They existed solely to give the coda composer a rotating label to avoid
// repeating itself; the composer now grounds on the person's actual past
// messages and a live search instead (generateCoda.ts's `groundCoda`), which
// supersedes the beat-label mechanism entirely. `last_used_at` itself stays —
// `createTopicBeat`'s LRU eviction at cap still reads/writes it.

// ── Counters used by proactive tick ──────────────────────────────────────────

/**
 * How many times has the assistant initiated social with this specific person
 * today? Used for the 1-per-day-per-person gate. Counts subjects whose
 * last_assistant_initiated_at falls today.
 *
 * The "today" boundary is computed in the OWNER'S local timezone (when
 * provided). For Israel (UTC+2/+3), the UTC-midnight cutoff was 2-3 hours
 * AHEAD of the local-midnight cutoff, so an initiation at 02:00 local
 * Israel time crossed UTC-midnight but not local-midnight — the count
 * reset prematurely and the daily gate could re-fire. Owner-local boundary
 * keeps the gate true to its name. Falls back to UTC when no timezone
 * passed (back-compat).
 */
export function countAssistantInitiationsTodayForPerson(
  personSlackId: string,
  ownerTimezone?: string,
): number {
  const db = getDb();
  let iso: string;
  if (ownerTimezone) {
    const startOfLocalDay = DateTime.now().setZone(ownerTimezone).startOf('day');
    iso = startOfLocalDay.toUTC().toISO()!;
  } else {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    iso = startOfDay.toISOString();
  }
  // Compare via SQLite datetime() on BOTH sides — markSubjectRaised stores
  // datetime('now') ("2026-06-23 09:06:33", space-separated) while `iso` is a
  // luxon .toISO() ("...T...Z"). A raw string >= compares space (0x20) vs 'T'
  // (0x54), so a subject raised TODAY sorted BEFORE today-start → the count was
  // always 0 → the once-per-day coda gate never tripped → a coda fired in every
  // chat. datetime() normalizes both formats to the same UTC clock for a correct
  // comparison.
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM social_subjects
    WHERE person_slack_id = ?
      AND datetime(last_assistant_initiated_at) >= datetime(?)
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

// ── Per-turn kind persistence (gh#198-LIB-6, "answer 19") ───────────────────
//
// classifyTurn already computes `kind: 'task' | 'social' | 'other'` on every
// interactive turn at no extra cost. It was never persisted anywhere the
// end-of-chat reconciler could read back, so the work-gate in capturePass.ts
// rested on a prompt instruction alone. These two functions give the
// orchestrator's classifyTurn call site a place to stamp the per-thread
// signal, and give the reconciler's create branch a deterministic code-side
// read of it — neither a second LLM call nor a keyword blocklist.

/**
 * Stamp that at least one turn in this thread classified as 'social'. Called
 * from buildTurnContext.ts right after classifyTurn returns. Upsert — a
 * thread only ever needs the OR of every turn seen, never a downgrade.
 */
export function markThreadHadSocialTurn(threadTs: string): void {
  if (!threadTs) return;
  const db = getDb();
  db.prepare(`
    INSERT INTO social_thread_turn_kind (thread_ts, had_social_turn, updated_at)
    VALUES (?, 1, datetime('now'))
    ON CONFLICT(thread_ts) DO UPDATE SET had_social_turn = 1, updated_at = datetime('now')
  `).run(threadTs);
}

/**
 * Did ANY turn in this thread classify as 'social'? Consulted by
 * capturePass.ts's create branch before it lets a `create` decision through —
 * a thread that never had a turn classified 'social' (i.e. every turn was
 * 'task' or 'other', or classifyTurn's intent half never ran) blocks subject
 * creation regardless of the reconciler's own verdict. Defaults to false
 * (no row = no social turn ever recorded), which is fail-CLOSED on the
 * create path — the safer default for "don't turn work into a social
 * subject" per the owner's ruling.
 */
export function threadHadSocialTurn(threadTs: string): boolean {
  if (!threadTs) return false;
  const db = getDb();
  const row = db.prepare(`
    SELECT had_social_turn FROM social_thread_turn_kind WHERE thread_ts = ?
  `).get(threadTs) as { had_social_turn: number } | undefined;
  return row?.had_social_turn === 1;
}
