// One-shot destructive cleanup (v1.6.2, extended v1.6.5): cancel every
// open/pending row across the "waiting on / committed to" tables so the
// owner gets a clean slate.
//
// Why a script and not an auto-migration: this is destructive. It must
// happen once, under your eyes, not silently on every startup. Re-run
// whenever things drift from reality (after a bad refactor, QA loop, etc).
//
// What it touches (in order, single transaction):
//   approvals        — status='pending'                    → 'cancelled'
//   pending_requests — status='open'                       → 'cancelled'
//   outreach_jobs    — status IN ('sent','no_response',
//                                 'pending_scheduled')     → 'cancelled'
//   coord_jobs       — status IN ('collecting','resolving',
//                                 'negotiating','waiting_owner') → 'cancelled'
//   tasks            — any open status AND type IN the follow-up/domain
//                       types below                         → 'cancelled'
//
// What it does NOT touch: booked / confirmed meetings, completed work,
// anything already in a terminal state. This is a "ghost cleaner", not a
// nuke.
//
// Prints preview for every category, then commits in a transaction.
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'data', 'maelle.db');
const db = new Database(dbPath);

console.log(`DB: ${dbPath}\n`);

// ── Constants ──────────────────────────────────────────────────────────────
const followupTaskTypes = [
  'approval_expiry',
  'coord_nudge',
  'coord_abandon',
  'outreach_expiry',
  'calendar_fix',
  'outreach_send',
  'outreach',
  'coordination',
  'follow_up',
  'reminder',
];
const openTaskStatuses = [
  'new', 'scheduled', 'in_progress', 'pending_owner', 'pending_colleague',
];
const taskTypeList = followupTaskTypes.map(t => `'${t}'`).join(',');
const taskStatusList = openTaskStatuses.map(s => `'${s}'`).join(',');

// ── Preview ────────────────────────────────────────────────────────────────
const pendingApprovals = db.prepare(
  `SELECT id, kind, created_at, task_id, skill_ref FROM approvals WHERE status = 'pending'`
).all();
console.log(`[1] pending approvals: ${pendingApprovals.length}`);
for (const a of pendingApprovals) {
  console.log(`  - ${a.id} · ${a.kind} · task=${a.task_id} · coord=${a.skill_ref ?? '-'} · ${a.created_at}`);
}

let pendingReqs = [];
try {
  pendingReqs = db.prepare(
    `SELECT id, requester, subject, priority, created_at FROM pending_requests WHERE status = 'open'`
  ).all();
} catch (e) {
  // Table may not exist on very old DBs
}
console.log(`\n[2] open pending_requests (store_request): ${pendingReqs.length}`);
for (const r of pendingReqs) {
  console.log(`  - ${r.id} · ${r.priority ?? '-'} · from ${r.requester} · "${(r.subject ?? '').slice(0, 60)}"`);
}

const liveOutreach = db.prepare(
  `SELECT id, colleague_name, status, sent_at, created_at
   FROM outreach_jobs
   WHERE status IN ('sent','no_response','pending_scheduled')`
).all();
console.log(`\n[3] live outreach_jobs (sent / no_response / pending_scheduled): ${liveOutreach.length}`);
for (const o of liveOutreach) {
  console.log(`  - ${o.id} · ${o.status} · to ${o.colleague_name} · ${o.sent_at ?? o.created_at}`);
}

const stuckCoords = db.prepare(
  `SELECT id, subject, status FROM coord_jobs
   WHERE status IN ('collecting','resolving','negotiating','waiting_owner')`
).all();
console.log(`\n[4] non-terminal coord_jobs: ${stuckCoords.length}`);
for (const c of stuckCoords) {
  console.log(`  - ${c.id} · ${c.status} · ${c.subject ?? ''}`);
}

const pendingTasks = db.prepare(
  `SELECT id, type, status, title, due_at FROM tasks WHERE type IN (${taskTypeList}) AND status IN (${taskStatusList})`
).all();
console.log(`\n[5] open follow-up / domain tasks: ${pendingTasks.length}`);
for (const t of pendingTasks) {
  console.log(`  - ${t.id} · ${t.type} · ${t.status} · due=${t.due_at ?? '-'} · ${t.title ?? ''}`);
}

const totalRows =
  pendingApprovals.length +
  pendingReqs.length +
  liveOutreach.length +
  stuckCoords.length +
  pendingTasks.length;

if (totalRows === 0) {
  console.log('\nNothing to purge. Exiting.');
  db.close();
  process.exit(0);
}

// ── Commit ─────────────────────────────────────────────────────────────────
const tx = db.transaction(() => {
  const apprRes = db.prepare(
    `UPDATE approvals
       SET status = 'cancelled',
           responded_at = datetime('now'),
           notes = COALESCE(notes, '') || ' [purged]',
           updated_at = datetime('now')
     WHERE status = 'pending'`
  ).run();
  console.log(`\n[1] approvals cancelled: ${apprRes.changes}`);

  let reqRes = { changes: 0 };
  try {
    reqRes = db.prepare(
      `UPDATE pending_requests
         SET status = 'cancelled',
             updated_at = datetime('now')
       WHERE status = 'open'`
    ).run();
  } catch (e) {
    // fine if table missing
  }
  console.log(`[2] pending_requests cancelled: ${reqRes.changes}`);

  const outRes = db.prepare(
    `UPDATE outreach_jobs
       SET status = 'cancelled',
           reply_text = COALESCE(reply_text, '') || ' [purged]',
           updated_at = datetime('now')
     WHERE status IN ('sent','no_response','pending_scheduled')`
  ).run();
  console.log(`[3] outreach_jobs cancelled: ${outRes.changes}`);

  const coordRes = db.prepare(
    `UPDATE coord_jobs
       SET status = 'cancelled',
           notes = COALESCE(notes, '') || ' [purged]',
           updated_at = datetime('now')
     WHERE status IN ('collecting','resolving','negotiating','waiting_owner')`
  ).run();
  console.log(`[4] coord_jobs cancelled: ${coordRes.changes}`);

  const taskRes = db.prepare(
    `UPDATE tasks
       SET status = 'cancelled',
           updated_at = datetime('now')
     WHERE type IN (${taskTypeList}) AND status IN (${taskStatusList})`
  ).run();
  console.log(`[5] tasks cancelled: ${taskRes.changes}`);
});

tx();
db.close();
console.log('\nDone. Restart Maelle if it was running.');
