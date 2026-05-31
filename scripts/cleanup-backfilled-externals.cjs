#!/usr/bin/env node
/**
 * One-off cleanup (v3.1.7): remove the external person rows the v3.2.0 calendar
 * backfill over-created (it swept the whole external calendar instead of just
 * recent deliberate bookings). Deletes every people_memory row with
 * kind='external' + their md files. The owner re-loads the ones he actually
 * wants via the normal flow. Safe: nothing FKs to an external's person_id
 * (social/engagement are slack_id-keyed; externals have no slack_id).
 *
 * Run once:  node scripts/cleanup-backfilled-externals.cjs
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'maelle.db');
const db = new Database(DB_PATH);

const rows = db.prepare(`SELECT person_id, name FROM people_memory WHERE kind = 'external'`).all();
console.log(`Found ${rows.length} external rows to remove.`);

// Delete md files across any *_people dir.
const usersDir = path.resolve(__dirname, '..', 'config', 'users');
let mdDeleted = 0;
try {
  for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('_people')) continue;
    const dir = path.join(usersDir, entry.name);
    for (const r of rows) {
      const f = path.join(dir, `${r.person_id}.md`);
      if (fs.existsSync(f)) { fs.unlinkSync(f); mdDeleted++; }
    }
  }
} catch (e) {
  console.warn('md cleanup warning:', String(e).slice(0, 200));
}

const res = db.prepare(`DELETE FROM people_memory WHERE kind = 'external'`).run();
console.log(`Deleted ${res.changes} rows, ${mdDeleted} md files.`);
db.close();
