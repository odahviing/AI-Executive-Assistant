#!/usr/bin/env node
/**
 * Cancel the orphan system-routine "Calendar health check (midday)" when
 * the user-curated "Calendar health check" routine already covers 13:00
 * via its multi-time schedule (e.g. "07:30,13:00").
 *
 * Background: v2.9.3 migrated the user routine to fire twice daily by
 * extending schedule_time. The migration comment explicitly says it does
 * NOT create a parallel system routine — but on some DBs an older path
 * left a `system_calhealth_midday_*` row behind. Both routines now fire
 * at 13:00, owner gets two DMs with overlapping content.
 *
 * This script:
 *   1. Detects whether the user routine schedule includes '13:00'.
 *   2. If yes, marks any active `system_calhealth_midday_*` system routine
 *      as status='cancelled' so the task runner stops materializing it.
 *
 * Usage:
 *   --list             Dry run, show what would change. No mutations.
 *   --apply            Actually cancel the orphan(s).
 *
 * Read-only by default.
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] ?? true;
}
const APPLY = flags.apply === true || flags.apply === 'true';

const DB_PATH = process.env.MAELLE_DB_PATH ?? path.resolve(__dirname, '..', 'data', 'maelle.db');
const db = new Database(DB_PATH, { readonly: !APPLY });

console.log(`\n== Orphan system-calhealth-midday cleanup (${APPLY ? 'APPLY' : 'dry run — pass --apply to cancel'}) ==\n`);

// Find user routine(s) named "Calendar health check"
const userRoutines = db.prepare(`
  SELECT id, title, schedule_time, status
  FROM routines
  WHERE is_system = 0
    AND title = 'Calendar health check'
    AND status = 'active'
`).all();

console.log(`User routines named "Calendar health check" (active): ${userRoutines.length}`);
for (const r of userRoutines) {
  console.log(`  - ${r.id}  schedule=${r.schedule_time}  status=${r.status}`);
}

const userCovers1300 = userRoutines.some(r =>
  String(r.schedule_time ?? '').split(',').map(s => s.trim()).includes('13:00')
);

console.log(`\nUser routine covers 13:00? ${userCovers1300 ? 'YES' : 'no'}`);

if (!userCovers1300) {
  console.log(`\nNothing to clean up — user routine does not cover 13:00, so any system midday routine is doing the actual work and shouldn't be cancelled.\n`);
  process.exit(0);
}

// Find orphan system midday routine(s)
const systemMiddays = db.prepare(`
  SELECT id, title, schedule_time, status, last_run_at, run_count
  FROM routines
  WHERE is_system = 1
    AND status = 'active'
    AND id LIKE 'system_calhealth_midday_%'
`).all();

console.log(`\nOrphan system midday routines (active): ${systemMiddays.length}`);
for (const r of systemMiddays) {
  console.log(`  - ${r.id}  "${r.title}"  schedule=${r.schedule_time}  runs=${r.run_count}  last=${r.last_run_at ?? '-'}`);
}

if (systemMiddays.length === 0) {
  console.log(`\nNothing to clean up — no active orphans found.\n`);
  process.exit(0);
}

if (!APPLY) {
  console.log(`\n(Dry run — would cancel ${systemMiddays.length} orphan routine(s). Pass --apply to make the change.)\n`);
  process.exit(0);
}

// Cancel the orphans
const stmt = db.prepare(`
  UPDATE routines
  SET status = 'cancelled', last_result = ?, updated_at = datetime('now')
  WHERE id = ?
`);
const reason = 'Cancelled by cleanup script — user routine schedule already covers 13:00; duplicate fires resolved.';
let cancelled = 0;
for (const r of systemMiddays) {
  const info = stmt.run(reason, r.id);
  if (info.changes > 0) {
    cancelled++;
    console.log(`  ✓ cancelled ${r.id}`);
  }
}
console.log(`\nCancelled ${cancelled}/${systemMiddays.length} orphan routine(s). Restart npm run dev to pick up the change.\n`);
