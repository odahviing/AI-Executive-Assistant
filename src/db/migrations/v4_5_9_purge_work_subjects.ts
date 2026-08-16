/**
 * v4.5.9 (#198) — purge work-shaped social_subjects rows (owner ruling,
 * "answer 6", 2026-08-15). Five subjects were logged work, not social
 * interest, and were polluting the social layer — a one-time cleanup, named
 * exactly by the owner, never inferred:
 *
 *   'Ido Adulamy interview'          (learning)
 *   'Idan call scheduling'           (partner)
 *   'Brainrocket POC scoping'        (side_projects)
 *   'Idan social media posts'        (side_projects)
 *   'Sydney settling into Reflectiz' (friends)   — work, by the owner's own rule
 *
 * MUST run BEFORE v4_5_9_social_category_scores' backfill — these five rows
 * are exactly the content the #198 redesign is decontaminating the social
 * layer OF; letting them feed the new per-person category score table before
 * being purged would carry the pollution into the new storage under a new
 * name instead of removing it.
 *
 * Matched on (label, category_id) — a global category's id is deterministic
 * (`cat_global_<label>`, see ensureCategoriesSeeded in socialSubjects.ts), so
 * no join is needed and no other row can collide with these five. Deletes
 * topic-beats first, then the subject rows, so an interrupted run never
 * leaves an orphaned beat.
 *
 * Data safety: every matched subject + its topic-beats is dumped to a JSON
 * backup under data/migrations/ before deletion. Reverse: re-INSERT the rows
 * from that backup file. Idempotent — a row already gone matches nothing on
 * a later boot, so this is a safe no-op once it has run (verified against a
 * scratch copy of the live db: 5 subjects + 33 topic-beats matched and
 * purged cleanly on first run, 0 on a second run).
 */

import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger';

const PURGE_SET: Array<{ label: string; categoryId: string }> = [
  { label: 'Ido Adulamy interview', categoryId: 'cat_global_learning' },
  { label: 'Idan call scheduling', categoryId: 'cat_global_partner' },
  { label: 'Brainrocket POC scoping', categoryId: 'cat_global_side_projects' },
  { label: 'Idan social media posts', categoryId: 'cat_global_side_projects' },
  { label: 'Sydney settling into Reflectiz', categoryId: 'cat_global_friends' },
];

export function runPurgeWorkShapedSocialSubjects(db: Database.Database, dbPath: string): void {
  const wherePredicate = PURGE_SET.map(() => '(label = ? AND category_id = ?)').join(' OR ');
  const whereParams = PURGE_SET.flatMap(p => [p.label, p.categoryId]);

  let subjects: Record<string, unknown>[];
  try {
    subjects = db.prepare(`SELECT * FROM social_subjects WHERE ${wherePredicate}`).all(...whereParams) as Record<string, unknown>[];
  } catch (err) {
    logger.error('v4.5.9 purge-work-subjects — read failed, aborting', { err: String(err) });
    return;
  }
  if (subjects.length === 0) return; // already purged (or never present) — no-op

  const subjectIds = subjects.map(s => String(s.id));
  const inList = subjectIds.map(() => '?').join(',');
  let topics: Record<string, unknown>[] = [];
  try {
    topics = db.prepare(`SELECT * FROM social_topics WHERE subject_id IN (${inList})`).all(...subjectIds) as Record<string, unknown>[];
  } catch (err) {
    logger.error('v4.5.9 purge-work-subjects — topic-beat read failed, aborting', { err: String(err) });
    return;
  }

  try {
    const migDir = path.join(path.dirname(dbPath), 'migrations');
    if (!fs.existsSync(migDir)) fs.mkdirSync(migDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(migDir, `v4_5_9_purge_work_subjects_${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ social_subjects: subjects, social_topics: topics }, null, 2), 'utf8');
    logger.warn('v4.5.9 purge-work-subjects — backed up rows about to be deleted', {
      backupPath, subjects: subjects.length, topics: topics.length,
    });
  } catch (err) {
    logger.error('v4.5.9 purge-work-subjects — backup write failed, aborting deletion', { err: String(err) });
    return;
  }

  const purge = db.transaction(() => {
    db.prepare(`DELETE FROM social_topics WHERE subject_id IN (${inList})`).run(...subjectIds);
    db.prepare(`DELETE FROM social_subjects WHERE ${wherePredicate}`).run(...whereParams);
  });

  try {
    purge();
    logger.warn('v4.5.9 purge-work-subjects — deleted', { subjects: subjects.length, topics: topics.length });
  } catch (err) {
    logger.error('v4.5.9 purge-work-subjects — delete failed, rolled back', { err: String(err) });
  }
}
