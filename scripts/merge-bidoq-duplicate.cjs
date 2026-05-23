#!/usr/bin/env node
/**
 * One-shot: merge duplicate "בידוק" social_subject into the older row.
 *
 * Today (2026-05-22 14:39) the per-turn classifier created `subj_..._d828`
 * labeled "בידוק" because Sonnet emitted the bare title and the strict
 * exact-label matcher couldn't tie it to the older `subj_..._xfuw` labeled
 * "בידוק - Netflix movie". v3.0 follow-up moves subject creation to
 * end-of-chat Haiku so this can't recur. This script cleans the existing
 * dup once.
 *
 * Action:
 *   - Keep the older row (xfuw): label "בידוק - Netflix movie" (more
 *     descriptive), stable id (oldest references survive).
 *   - Repoint the newer row's topic_beats to the older row's id.
 *   - Take the higher engagement_score: max(2, 3) = 3.
 *   - Take the newer last_touched_at (the newer row had real activity today).
 *   - Mark the newer row status='dormant' so it's out of the active set
 *     (preserves history; can be deleted later if owner prefers).
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', '..', '..', 'E:/Code/Maelle/data/maelle.db');
const KEEP_ID = 'subj_U0F28CK6H_1778848831437_xfuw';
const DUP_ID  = 'subj_U0F28CK6H_1779460751654_d828';

const db = new Database(DB_PATH);

const keep = db.prepare('SELECT * FROM social_subjects WHERE id = ?').get(KEEP_ID);
const dup  = db.prepare('SELECT * FROM social_subjects WHERE id = ?').get(DUP_ID);

if (!keep || !dup) {
  console.error('one or both rows missing — aborting');
  console.error('keep:', keep);
  console.error('dup:', dup);
  process.exit(1);
}

const newScore = Math.max(keep.engagement_score, dup.engagement_score);
const newLastTouched = (dup.last_touched_at > keep.last_touched_at)
  ? dup.last_touched_at
  : keep.last_touched_at;

const txn = db.transaction(() => {
  // 1. Repoint topic_beats from dup → keep (preserve all history)
  const repointed = db.prepare(
    'UPDATE social_topics SET subject_id = ? WHERE subject_id = ?'
  ).run(KEEP_ID, DUP_ID);

  // 2. Update keep row with merged values
  db.prepare(`
    UPDATE social_subjects
       SET engagement_score = ?,
           last_touched_at = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(newScore, newLastTouched, KEEP_ID);

  // 3. Mark dup as dormant
  db.prepare(`
    UPDATE social_subjects
       SET status = 'dormant',
           updated_at = datetime('now')
     WHERE id = ?
  `).run(DUP_ID);

  return repointed.changes;
});

const beatsMoved = txn();

console.log(JSON.stringify({
  ok: true,
  keep: KEEP_ID,
  dup_dormanted: DUP_ID,
  merged: {
    engagement_score: newScore,
    last_touched_at: newLastTouched,
    topic_beats_repointed: beatsMoved,
  },
}, null, 2));

db.close();
