#!/usr/bin/env node
/**
 * One-shot cleanup for orphan open requests and outreach_jobs left behind by
 * buggy flows (e.g. multi-approval mess that produced stale awaiting_colleague
 * rows surfacing in the next morning's brief).
 *
 * Two modes:
 *   - `node scripts/cleanup-recent-orphan-requests.cjs --list`
 *       Prints candidate rows. No mutations.
 *   - `node scripts/cleanup-recent-orphan-requests.cjs --close`
 *       Closes (cancels) the rows shown by --list.
 *
 * Filters:
 *   --hours=N       (default 48)  Only rows created within last N hours.
 *   --name=STRING                  Case-insensitive substring match on
 *                                  requester_name or colleague_name.
 *   --reason=STRING                Closure reason recorded in outcome_json
 *                                  (default "manual cleanup post buggy flow").
 *
 * Examples:
 *   node scripts/cleanup-recent-orphan-requests.cjs --list --name=yael
 *   node scripts/cleanup-recent-orphan-requests.cjs --close --name=yael --hours=72
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

// Parse argv flags
const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] ?? true;
}
const MODE = flags.close ? 'close' : 'list';
const HOURS = Number(flags.hours ?? 48);
const NAME = typeof flags.name === 'string' ? flags.name.toLowerCase() : null;
const REASON = typeof flags.reason === 'string' ? flags.reason : 'manual cleanup post buggy flow';

const DB_PATH = process.env.MAELLE_DB_PATH ?? path.join(process.cwd(), 'maelle.db');
const db = new Database(DB_PATH, { readonly: MODE === 'list' });

const cutoffIso = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();

function nameMatches(haystack) {
  if (!NAME) return true;
  return (haystack ?? '').toLowerCase().includes(NAME);
}

// ── Candidate requests ──────────────────────────────────────────────────────
const reqs = db.prepare(`
  SELECT id, kind, subkind, state, subject, requester_name, requester_slack_id,
         created_at, expires_at
  FROM requests
  WHERE state IN ('awaiting_owner', 'awaiting_colleague', 'in_flight')
    AND created_at >= ?
  ORDER BY created_at DESC
`).all(cutoffIso).filter(r => nameMatches(r.requester_name));

// ── Candidate outreach_jobs ─────────────────────────────────────────────────
const jobs = db.prepare(`
  SELECT id, colleague_name, colleague_slack_id, status, message,
         await_reply, sent_at, created_at, followup_closed_at
  FROM outreach_jobs
  WHERE status IN ('sent', 'no_response', 'pending_scheduled')
    AND created_at >= ?
    AND followup_closed_at IS NULL
  ORDER BY created_at DESC
`).all(cutoffIso).filter(j => nameMatches(j.colleague_name));

console.log(`\n== Recent orphan candidates (last ${HOURS}h${NAME ? `, name~"${NAME}"` : ''}) ==\n`);
console.log(`Requests: ${reqs.length}`);
for (const r of reqs) {
  console.log(`  - ${r.id}  ${r.kind}/${r.subkind ?? '-'}  state=${r.state}  requester=${r.requester_name ?? '?'}`);
  console.log(`      subject: ${(r.subject ?? '').slice(0, 80)}`);
  console.log(`      created: ${r.created_at}  expires: ${r.expires_at ?? '-'}`);
}

console.log(`\nOutreach jobs: ${jobs.length}`);
for (const j of jobs) {
  console.log(`  - ${j.id}  status=${j.status}  await_reply=${j.await_reply}  colleague=${j.colleague_name ?? '?'}`);
  console.log(`      message: ${(j.message ?? '').slice(0, 80)}`);
  console.log(`      sent_at: ${j.sent_at ?? '-'}  created_at: ${j.created_at}`);
}

if (MODE !== 'close') {
  console.log(`\n(Dry run — pass --close to cancel these rows.)\n`);
  process.exit(0);
}

// ── Close mode ──────────────────────────────────────────────────────────────
console.log(`\n== Closing ${reqs.length} requests + ${jobs.length} outreach_jobs ==\n`);
const now = new Date().toISOString();

const closeReq = db.prepare(`
  UPDATE requests
  SET state = 'cancelled',
      closure_reason = ?,
      closed_by = 'manual',
      closed_at = ?,
      updated_at = datetime('now')
  WHERE id = ? AND state IN ('awaiting_owner', 'awaiting_colleague', 'in_flight')
`);
const closeJob = db.prepare(`
  UPDATE outreach_jobs
  SET status = 'done',
      followup_closed_at = datetime('now'),
      followup_close_reason = 'manual_cleanup',
      updated_at = datetime('now')
  WHERE id = ?
`);

const closeMany = db.transaction(() => {
  let reqCount = 0;
  let jobCount = 0;
  for (const r of reqs) {
    const info = closeReq.run(REASON, now, r.id);
    if (info.changes > 0) reqCount++;
  }
  for (const j of jobs) {
    const info = closeJob.run(j.id);
    if (info.changes > 0) jobCount++;
  }
  return { reqCount, jobCount };
});

const result = closeMany();
console.log(`Closed ${result.reqCount}/${reqs.length} requests`);
console.log(`Closed ${result.jobCount}/${jobs.length} outreach_jobs`);
console.log(`\nDone.\n`);
