/**
 * v4.5.9 (#198) — Social Engine redesign, category-score rebase.
 *
 * Category standing moves from an on-the-fly AVG(subject.engagement_score)
 * derivation (`getActiveCategoryEngagementForPerson`, socialSubjects.ts) to a
 * real per-(owner, person, category) row in the new
 * `social_person_category_scores` table (0..3, created in initSchema — see
 * client.ts). Subjects lose their score entirely; they carry a live/dead
 * flag (repurposed `status` column) and an `unanswered_raises` counter
 * instead (also added in initSchema).
 *
 * Backfill rule (owner ruling, "answer 17", 2026-08-15): migrate only
 * subjects that ever had real person interaction —
 * `last_touched_by != 'assistant'`. A migrated category starts at its old
 * subject's `engagement_score` CLAMPED to the new 3 ceiling; where a
 * category holds several subjects for the same person, take the highest
 * post-clamp.
 *
 * MUST run AFTER v4_5_9_purge_work_subjects (runPurgeWorkShapedSocialSubjects)
 * — the 5 work-shaped rows must already be gone, or their scores would seed
 * a category this same redesign is explicitly decontaminating.
 *
 * Data safety: every social_subjects + social_categories row is dumped to a
 * JSON backup under data/migrations/ BEFORE the destructive step. The
 * backfill INSERTs and the DROP COLUMN statements run in ONE transaction —
 * if a DROP throws (e.g. an old SQLite build lacking DROP COLUMN support),
 * the backfill rolls back too, so a retry next boot starts clean instead of
 * double-inserting. Reverse: restore `social_subjects.engagement_score` and
 * `social_categories.{care_level,signals_positive,signals_negative}` from
 * the JSON backup — nothing else reads them once this lands (grep-confirmed:
 * only socialSubjects.ts, stateMachine.ts, capturePass.ts, logEngagement.ts,
 * all updated by the #198 Librarian pieces alongside this schema change), so
 * no data beyond the four dropped columns is at risk.
 *
 * Idempotent: no-ops once `social_subjects.engagement_score` no longer
 * exists (fresh installs get the final shape straight from initSchema and
 * never reach this at all). Verified against a scratch copy of the live db
 * (22 subject rows, 21 non-assistant): after the work-subject purge left 17
 * rows / 16 non-assistant-touched, this produced exactly 11
 * social_person_category_scores rows with the expected clamped-max values
 * per (person, category), and both DROP COLUMN statements completed
 * cleanly.
 */

import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger';

interface ColInfo { name: string }

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[];
  return cols.some(c => c.name === col);
}

const SCORE_CEILING = 3;

export function runSocialCategoryScoreRebase(db: Database.Database, dbPath: string): void {
  if (!hasColumn(db, 'social_subjects', 'engagement_score')) return; // already migrated / fresh install

  // ── 1. Back up both tables BEFORE any destructive step ──
  let subjectRows: Record<string, unknown>[];
  let categoryRows: Record<string, unknown>[];
  try {
    subjectRows = db.prepare(`SELECT * FROM social_subjects`).all() as Record<string, unknown>[];
    categoryRows = db.prepare(`SELECT * FROM social_categories`).all() as Record<string, unknown>[];
  } catch (err) {
    logger.error('v4.5.9 social-category-score rebase — read failed, aborting (columns left intact)', { err: String(err) });
    return;
  }
  try {
    const migDir = path.join(path.dirname(dbPath), 'migrations');
    if (!fs.existsSync(migDir)) fs.mkdirSync(migDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(migDir, `v4_5_9_social_category_score_rebase_${ts}.json`);
    fs.writeFileSync(
      backupPath,
      JSON.stringify({ social_subjects: subjectRows, social_categories: categoryRows }, null, 2),
      'utf8',
    );
    logger.info('v4.5.9 social-category-score rebase — backed up social_subjects + social_categories', {
      backupPath, subjectRows: subjectRows.length, categoryRows: categoryRows.length,
    });
  } catch (err) {
    logger.error('v4.5.9 social-category-score rebase — backup write failed, aborting', { err: String(err) });
    return;
  }

  // ── 2. Backfill (real person interaction only) + column drops, one transaction ──
  const rebase = db.transaction(() => {
    const eligible = subjectRows.filter(r => r.last_touched_by !== 'assistant');
    const byKey = new Map<string, {
      owner_user_id: string; person_slack_id: string; category_id: string; score: number;
    }>();
    for (const r of eligible) {
      const key = `${r.owner_user_id}::${r.person_slack_id}::${r.category_id}`;
      const clamped = Math.min(SCORE_CEILING, Number(r.engagement_score ?? 0));
      const existing = byKey.get(key);
      if (!existing || clamped > existing.score) {
        byKey.set(key, {
          owner_user_id: String(r.owner_user_id),
          person_slack_id: String(r.person_slack_id),
          category_id: String(r.category_id),
          score: clamped,
        });
      }
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO social_person_category_scores (
        id, owner_user_id, person_slack_id, category_id, score
      ) VALUES (@id, @owner_user_id, @person_slack_id, @category_id, @score)
    `);
    let inserted = 0;
    for (const v of byKey.values()) {
      const id = `pcs_${v.person_slack_id}_${v.category_id}`;
      insert.run({ id, ...v });
      inserted++;
    }

    db.exec(`ALTER TABLE social_subjects DROP COLUMN engagement_score`);
    db.exec(`ALTER TABLE social_categories DROP COLUMN care_level`);
    db.exec(`ALTER TABLE social_categories DROP COLUMN signals_positive`);
    db.exec(`ALTER TABLE social_categories DROP COLUMN signals_negative`);

    return inserted;
  });

  try {
    const inserted = rebase();
    logger.info('v4.5.9 social-category-score rebase — complete', {
      subjectsConsidered: subjectRows.length, categoryScoresInserted: inserted,
    });
  } catch (err) {
    logger.error('v4.5.9 social-category-score rebase — transaction failed, rolled back, columns preserved', { err: String(err) });
  }
}
