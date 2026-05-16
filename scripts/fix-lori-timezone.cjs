#!/usr/bin/env node
/**
 * One-shot data fix — Lori Sarsfield's `people_memory` row had
 *   state = "Boston"
 *   timezone = "Asia/Jerusalem"
 * Both owner-stamped, contradictory. Triggered a real-day bug 2026-05-16
 * where Maelle proposed 10:30 IL and described it as "08:30 Lori's Boston
 * time" — wrong by ~5 hours.
 *
 * Boston is America/New_York (EDT/EST). This script:
 *   - confirms the row is the one with the mismatch
 *   - rewrites timezone → America/New_York (owner-stamped)
 *   - refreshes auto-derived working hours
 *
 * Idempotent — re-running after the fix is a no-op.
 */

const path = require('path');
const Database = require('better-sqlite3');

const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'data', 'maelle.db');
const db = new Database(dbPath);

const row = db.prepare(`
  SELECT slack_id, name, state, state_set_by, timezone, timezone_set_by
  FROM people_memory
  WHERE LOWER(name) = 'lori sarsfield'
`).get();

if (!row) {
  console.error('No row for Lori Sarsfield. Nothing to do.');
  process.exit(1);
}

console.log('Before:', row);

if (row.timezone === 'America/New_York') {
  console.log('Already America/New_York. No-op.');
  process.exit(0);
}

const updated = db.prepare(`
  UPDATE people_memory
  SET timezone = ?,
      timezone_set_by = 'owner',
      updated_at = datetime('now')
  WHERE slack_id = ?
`).run('America/New_York', row.slack_id);

const after = db.prepare(`
  SELECT slack_id, name, state, timezone, timezone_set_by
  FROM people_memory
  WHERE slack_id = ?
`).get(row.slack_id);

console.log('After: ', after);
console.log(`Rows changed: ${updated.changes}`);
console.log('\nNext: restart npm run dev so the new TZ is loaded into any cached prompt blocks.');
