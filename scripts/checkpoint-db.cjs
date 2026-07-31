#!/usr/bin/env node
/**
 * checkpoint-db.cjs — fold the WAL into the main DB for a clean single-file
 * snapshot, verify integrity, and print baseline row counts.
 *
 * Run on the LAPTOP, with the bot STOPPED (`pm2 stop maelle`), right before
 * copying data/maelle.db to the VM. Folding the WAL means we copy ONE consistent
 * file (no -wal/-shm sidecars to keep in sync). The printed counts are the
 * baseline to verify against on the VM after cutover.
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'data', 'maelle.db');

const db = new Database(DB_PATH);
db.pragma('wal_checkpoint(TRUNCATE)');
const integrity = db.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') {
  console.error('INTEGRITY CHECK FAILED:', integrity);
  process.exit(1);
}

console.log('DB               :', DB_PATH);
console.log('integrity_check  :', integrity);
console.log('--- baseline row counts (verify these on the VM after cutover) ---');
for (const t of ['people_memory', 'requests', 'tasks', 'audit_log', 'social_subjects', 'user_preferences', 'slot_holds']) {
  try {
    const n = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    console.log(t.padEnd(18), n);
  } catch {
    console.log(t.padEnd(18), 'n/a');
  }
}
db.close();
