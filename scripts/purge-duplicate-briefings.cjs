// One-shot cleanup (v1.6.10): delete user-created routines that duplicate
// the system morning briefing.
//
// Background: `ensureBriefingCron` creates one canonical briefing routine
// per owner (`system_briefing_<ownerId>`, `is_system=1`). Before v1.6.10 the
// create_routine tool happily accepted "Morning briefing" creates from the
// LLM, producing a second routine that coexisted with the system one —
// firing every morning alongside it.
//
// v1.6.10 blocks the create path at the tool level. This script is the DB
// side: it soft-deletes existing user routines (is_system=0) whose title
// matches the briefing pattern, AND cancels any routine-tasks those
// routines already materialized.
//
// Previews first. Only touches routines with is_system=0. Leaves system
// briefings alone.
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'data', 'maelle.db');
const db = new Database(dbPath);

console.log(`DB: ${dbPath}\n`);

const BRIEFING_TITLE_RE = /\b(morning|daily)?\s*brief(ing)?\b/i;

const rows = db.prepare(
  `SELECT id, owner_user_id, title, schedule_type, schedule_time, status, is_system FROM routines
   WHERE is_system = 0 AND status != 'deleted'`
).all();

const matches = rows.filter(r => BRIEFING_TITLE_RE.test(r.title ?? ''));

console.log(`User-created routines with briefing-like titles: ${matches.length}`);
for (const r of matches) {
  console.log(`  - ${r.id} · "${r.title}" · ${r.schedule_type} @ ${r.schedule_time} · owner=${r.owner_user_id} · status=${r.status}`);
}

if (matches.length === 0) {
  console.log('\nNothing to clean. Exiting.');
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  let routinesDeleted = 0;
  let tasksCancelled = 0;
  for (const r of matches) {
    const up = db.prepare(
      `UPDATE routines SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`
    ).run(r.id);
    routinesDeleted += up.changes;
    const taskUp = db.prepare(
      `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
       WHERE routine_id = ? AND status IN ('new','in_progress','scheduled')`
    ).run(r.id);
    tasksCancelled += taskUp.changes;
  }
  console.log(`\nRoutines soft-deleted: ${routinesDeleted}`);
  console.log(`Linked open tasks cancelled: ${tasksCancelled}`);
});

tx();
db.close();
console.log('\nDone. Restart Maelle if it was running.');
