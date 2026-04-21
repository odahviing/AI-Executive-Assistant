#!/usr/bin/env node
/**
 * One-shot cleanup: drop orphan bare-subject rows + retroactively drop work_life
 * entries from every person's social_topics. Bare-subject rows predate the
 * v1.7.4 subject-required enforcement; work_life was removed from the enum in
 * 2.0.2 because it was mis-used for work activities instead of emotional
 * work content.
 *
 * Safe to re-run (idempotent).
 */

import Database from 'better-sqlite3';

const db = new Database('data/maelle.db');

const rows = db.prepare('SELECT slack_id, name, social_topics FROM people_memory').all();
let updated = 0;

for (const row of rows) {
  if (!row.social_topics) continue;
  let topics;
  try { topics = JSON.parse(row.social_topics); } catch { continue; }
  if (!Array.isArray(topics)) continue;

  const before = topics.length;
  const cleaned = topics.filter(t =>
    t &&
    typeof t.subject === 'string' &&
    t.subject.trim().length > 0 &&
    t.name !== 'work_life'
  );

  const bareDropped = topics.filter(t => !t || !t.subject || (typeof t.subject === 'string' && t.subject.trim().length === 0));
  const workLifeDropped = topics.filter(t => t && t.name === 'work_life');

  if (cleaned.length !== before) {
    db.prepare('UPDATE people_memory SET social_topics = ?, updated_at = datetime(\'now\') WHERE slack_id = ?')
      .run(JSON.stringify(cleaned), row.slack_id);
    updated++;
    console.log(`${row.name} (${row.slack_id}): dropped ${before - cleaned.length} row(s)`);
    for (const t of bareDropped) console.log('  bare-subject:', JSON.stringify(t));
    for (const t of workLifeDropped) console.log('  work_life:', JSON.stringify(t));
  }
}

console.log(`\nDone. Updated ${updated} people.`);
