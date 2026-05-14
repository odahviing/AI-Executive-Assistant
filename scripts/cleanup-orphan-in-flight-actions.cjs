#!/usr/bin/env node
/**
 * cleanup-orphan-in-flight-actions.cjs (v2.7.4)
 *
 * One-shot DB cleanup for `follow_up` / `in_flight_action` request rows that
 * have no expires_at and no next_check_at — pre-v2.7.4 created these without
 * a timer, so they sit `in_flight` forever, surfacing every brief with
 * Sonnet narrating "I'm still working on X" when nothing is actually
 * happening (the underlying tool call originally failed; nobody retried).
 *
 * v2.7.4 fixes the creation path to stamp expires_at=+24h. This script
 * cleans up the orphans created before that fix landed.
 *
 * Marks matching rows state='expired', closure_reason='orphan_no_timer'.
 * Brief next morning narrates closure once via the informed=0 path, then
 * drops.
 *
 * Run: node scripts/cleanup-orphan-in-flight-actions.cjs --dry-run    # preview
 *      node scripts/cleanup-orphan-in-flight-actions.cjs               # apply
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'maelle.db');
const dryRun = process.argv.includes('--dry-run');

const db = new Database(DB_PATH, { fileMustExist: true });

const candidates = db.prepare(`
  SELECT id, owner_user_id, state, subject, created_at, expires_at, next_check_at
  FROM requests
  WHERE kind = 'follow_up'
    AND subkind = 'in_flight_action'
    AND state = 'in_flight'
    AND expires_at IS NULL
    AND next_check_at IS NULL
  ORDER BY created_at DESC
`).all();

console.log(`Found ${candidates.length} orphan in_flight_action row(s):\n`);
for (const r of candidates) {
  console.log(`  ${r.id}`);
  console.log(`    subject:    ${r.subject}`);
  console.log(`    created_at: ${r.created_at}`);
}

if (candidates.length === 0) {
  console.log('Nothing to clean up.');
  db.close();
  process.exit(0);
}

if (dryRun) {
  console.log('\n--dry-run set; no writes performed.');
  db.close();
  process.exit(0);
}

const update = db.prepare(`
  UPDATE requests
  SET state = 'expired',
      closure_reason = 'orphan_no_timer',
      closed_by = 'system',
      closed_at = datetime('now'),
      informed = 0,
      updated_at = datetime('now')
  WHERE id = ?
`);

const tx = db.transaction((ids) => {
  for (const id of ids) update.run(id);
});

tx(candidates.map(r => r.id));

console.log(`\nMarked ${candidates.length} row(s) as state='expired' closure_reason='orphan_no_timer'.`);
console.log(`Next brief will narrate the closure once via informed=0 path, then drop.`);
db.close();
