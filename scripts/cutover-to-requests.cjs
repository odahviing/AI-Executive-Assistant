#!/usr/bin/env node
/**
 * v2.7.0 cutover — wipe in-flight rows from the legacy tables.
 *
 * Per owner direction (V2): no migration, hard cutover. Anything actually
 * in-flight at cutover-moment vanishes; the colleague would need to re-DM.
 * Trade-off for zero migration code.
 *
 * Defensive: each table wipe is skipped if the table doesn't exist on this
 * DB (different installs have different schema state). Idempotent — safe to
 * run multiple times.
 *
 * Usage:
 *   node scripts/cutover-to-requests.cjs
 *   MAELLE_DB_PATH=/custom/path.db node scripts/cutover-to-requests.cjs
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.MAELLE_DB_PATH
  || path.resolve(__dirname, '..', 'data', 'maelle.db');

console.log(`Cutover wipe — opening ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// ── Helpers ────────────────────────────────────────────────────────────────

function tableExists(name) {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
  ).get(name);
  return !!row;
}

function safeWipe(label, sql, ...params) {
  try {
    const info = db.prepare(sql).run(...params);
    console.log(`  ${label}: ${info.changes}`);
    return info.changes;
  } catch (err) {
    console.log(`  ${label}: skipped (${err.message})`);
    return 0;
  }
}

// ── Wipe ───────────────────────────────────────────────────────────────────

const tx = db.transaction(() => {
  if (tableExists('approvals')) {
    safeWipe(
      'approvals (pending → cancelled)',
      `UPDATE approvals SET status = 'cancelled', notes = 'v2.7.0_cutover', updated_at = datetime('now')
       WHERE status = 'pending'`
    );
  } else {
    console.log(`  approvals: table not present, skipping`);
  }

  if (tableExists('tasks')) {
    safeWipe(
      'tasks (user-facing → cancelled)',
      `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
       WHERE status NOT IN ('informed','cancelled','failed','stale','completed')
         AND who_requested != 'system'`
    );
    safeWipe(
      'tasks (legacy timers → cancelled)',
      `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
       WHERE status IN ('new','in_progress','pending_owner','pending_colleague')
         AND type IN ('approval_expiry','approval_reminder','coord_nudge','coord_abandon',
                      'outreach_expiry','outreach_decision','outreach_send')`
    );
  } else {
    console.log(`  tasks: table not present, skipping`);
  }

  if (tableExists('coord_jobs')) {
    safeWipe(
      'coord_jobs (in-flight → cancelled)',
      `UPDATE coord_jobs SET status = 'cancelled',
                              notes = COALESCE(notes,'') || ' [v2.7.0_cutover]',
                              updated_at = datetime('now')
       WHERE status IN ('collecting','resolving','negotiating','waiting_owner')`
    );
  } else {
    console.log(`  coord_jobs: table not present, skipping`);
  }

  if (tableExists('outreach_jobs')) {
    safeWipe(
      'outreach_jobs (in-flight → cancelled)',
      `UPDATE outreach_jobs SET status = 'cancelled', updated_at = datetime('now')
       WHERE status IN ('sent','no_response','pending_scheduled')`
    );
  } else {
    console.log(`  outreach_jobs: table not present, skipping`);
  }
});

try {
  tx();
  console.log('\nCutover complete. Restart npm run dev to pick up the new spine.');
} catch (err) {
  console.error('Cutover failed:', err);
  process.exit(1);
} finally {
  db.close();
}
