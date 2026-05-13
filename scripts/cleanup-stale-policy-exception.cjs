#!/usr/bin/env node
/**
 * cleanup-stale-policy-exception.cjs (v2.7.1)
 *
 * One-shot DB cleanup for approval requests that were resolved (owner
 * approved) but whose underlying calendar action never executed. Caused by
 * the v2.7.0 owner-path policy_exception loop bug: Sonnet escalated to a DM
 * approval, owner approved, but Sonnet never re-called the underlying tool
 * with relaxed=true. The approval row sits 'resolved' with no
 * outcome_external_event_id while the calendar still reflects the OLD state
 * — so the brief lies ("you approved + I booked").
 *
 * v2.7.1's Bundle D fix means future owner-path violations don't generate
 * approval DMs at all (Sonnet asks in-thread + retries with relaxed=true).
 * So this cleanup only needs to run ONCE for rows created before the fix
 * landed.
 *
 * What it does: finds policy_exception approval requests in state='resolved'
 * with closure_reason matching 'owner approved%' AND outcome_external_event_id
 * IS NULL. Marks them state='expired', closure_reason='action_never_executed'
 * so brief stops reading them as "you approved → done".
 *
 * Run: node scripts/cleanup-stale-policy-exception.cjs --dry-run    # preview
 *      node scripts/cleanup-stale-policy-exception.cjs               # apply
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'maelle.db');
const dryRun = process.argv.includes('--dry-run');

const db = new Database(DB_PATH, { fileMustExist: true });

const candidates = db.prepare(`
  SELECT id, owner_user_id, state, closure_reason, closed_at,
         outcome_external_event_id, details_json
  FROM requests
  WHERE kind = 'approval'
    AND subkind = 'policy_exception'
    AND state = 'resolved'
    AND closure_reason LIKE 'owner approved%'
    AND outcome_external_event_id IS NULL
  ORDER BY closed_at DESC
`).all();

console.log(`Found ${candidates.length} stale policy_exception approval(s):\n`);
for (const r of candidates) {
  let detSummary = '(no details)';
  try {
    const d = JSON.parse(r.details_json ?? '{}');
    detSummary = (d.context ?? d.rule ?? JSON.stringify(d)).slice(0, 200);
  } catch (_) { /* swallow */ }
  console.log(`  ${r.id}`);
  console.log(`    closed_at: ${r.closed_at}`);
  console.log(`    detail:    ${detSummary}`);
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
      closure_reason = 'action_never_executed',
      updated_at = datetime('now')
  WHERE id = ?
`);

const tx = db.transaction((ids) => {
  for (const id of ids) update.run(id);
});

tx(candidates.map(r => r.id));

console.log(`\nMarked ${candidates.length} row(s) as state='expired' closure_reason='action_never_executed'.`);
db.close();
