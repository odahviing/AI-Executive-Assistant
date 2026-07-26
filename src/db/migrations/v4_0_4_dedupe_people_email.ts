/**
 * v4.0.4 — one human, one row: collapse duplicate-email `people_memory` rows.
 *
 * The store treats `email` as the logical identity key ("Slack wins, then
 * most-recent" — `getPersonByEmail`), but nothing ever ENFORCED it: until
 * v4.0.4 `upsertPersonMemory` ran its own `INSERT … ON CONFLICT(slack_id)`
 * around the `resolvePerson` chokepoint, deduping on slack_id ONLY. So a person
 * first seen on the CALENDAR (slack_id NULL, email set) got a SECOND row the
 * first time they appeared on Slack. Luke Joas is the live case:
 *   p_mq97pufr_00pi9w  source=calendar  slack_id NULL  2026-06-11
 *   p_U07QVKMCMP0      source=slack     U07QVKMCMP0    2026-06-23
 * both holding luke.j@reflectiz.com — which downstream read as "2 matches ⇒
 * ambiguous" and silently dropped him from an availability search.
 *
 * The code fix stops NEW duplicates. This sweep heals the ones already on disk.
 * It is generic (any duplicate-email group, not just Luke's) and delegates the
 * actual field-by-field union to `mergePersonRows` — the SAME function the
 * runtime paths call, so cleanup and prevention can never drift apart.
 *
 * Runs on every boot, which is deliberate rather than one-shot: the query is a
 * grouped scan over a ~60-row table (free), it self-terminates the moment the
 * table is clean, and if some future path ever re-splits a person the sweep
 * heals it AND logs a WARN naming the rows, so the regression is visible instead
 * of silent.
 *
 * Data safety: every row of every group the sweep will ACT on is dumped to
 * data/migrations/v4_0_4_people_dedupe_<ts>.json BEFORE the first merge (mirrors
 * the v2.0.7 / v3.2.0 pattern). No backup written ⇒ no merge attempted.
 * Registered AFTER the `is_vip` ALTER in client.ts so the merge writes against
 * the final column shape.
 *
 * "Will act on" carries the weight, because this runs on EVERY boot. A group that
 * `mergePersonRows` refuses forever — two Slack accounts on one address, the
 * realistic trigger being a deactivate-then-rehire — used to dump an identical
 * backup file per boot for work that can never happen: unbounded growth. Those
 * groups are now surfaced once per boot and excluded from the dump instead. The
 * gate decides whether there is anything to back UP; it never skips backing up
 * work that is about to run, so "no backup ⇒ no merge" still holds exactly.
 */

import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger';
import { mergePersonRows } from '../people';

interface DupeGroup { key: string; n: number }
/** A full row (the backup dumps it verbatim) plus the two fields we read off it. */
type DupeRow = Record<string, unknown> & { person_id: string; slack_id: string | null };

export function runDedupePeopleByEmail(db: Database.Database, dbPath: string): void {
  let groups: DupeGroup[];
  try {
    groups = db.prepare(`
      SELECT lower(trim(email)) AS key, COUNT(*) AS n
        FROM people_memory
       WHERE email IS NOT NULL AND trim(email) != '' AND kind != 'self'
       GROUP BY lower(trim(email))
      HAVING COUNT(*) > 1
    `).all() as DupeGroup[];
  } catch (err) {
    logger.error('people-dedupe migration — scan failed, skipping', { err: String(err) });
    return;
  }
  if (groups.length === 0) return;   // clean table — the steady state

  // Same canonical order as getPersonByEmail (slack_id-bearing row wins, then
  // most-recently-seen); created_at is only a deterministic final tiebreak.
  const rowsFor = db.prepare(`
    SELECT * FROM people_memory
     WHERE lower(trim(email)) = ? AND kind != 'self'
     ORDER BY (slack_id IS NOT NULL) DESC, last_seen DESC, created_at ASC
  `);

  // Read every group's rows ONCE: the same arrays are what gets dumped and what
  // the merge loop walks, so the backup is exactly the pre-image of the rows we
  // touch (it used to re-query, so dump and merge could in principle disagree).
  const withRows = groups
    .map(g => ({ key: g.key, rows: rowsFor.all(g.key) as DupeRow[] }))
    .filter(g => g.rows.length > 1);

  // Which groups can this sweep actually ACT on? The only PERMANENT refusal in
  // `mergePersonRows` reachable from here is "two DIFFERENT slack_ids" — its
  // kind='self' refusal cannot fire (both queries above exclude self rows) and its
  // md-fold refusal is a deferral the next boot retries, so a deferred group must
  // still be backed up. `slack_id` carries a UNIQUE index (idx_people_slack), so
  // two non-null ids inside one group are always different ids ⇒ a loser pairs
  // cleanly with rows[0] exactly when the LOSER's slack_id is NULL; and when no row
  // has one, rows[0] is itself NULL-slack and every pair is fine. Hence the test:
  // one NULL-slack row in the group ⇒ at least one merge to do.
  const actionable = withRows.filter(g => g.rows.some(r => r.slack_id == null));
  const stuck      = withRows.filter(g => g.rows.every(r => r.slack_id != null));

  if (stuck.length > 0) {
    // Neither a failure nor retryable: two Slack accounts on one address are two
    // identities, and the store's rule is to FLAG that, never silently merge it. It
    // needs a human to retire an account or correct the address. Once per boot keeps
    // a standing data conflict visible in a log that rotates daily — the thing that
    // must not recur is the backup FILE, which nothing ages out.
    logger.warn('people-dedupe migration — duplicate-email rows this sweep will never merge (two Slack identities on one address; needs a human)', {
      emails: stuck.map(g => g.key),
      slackIds: stuck.map(g => g.rows.map(r => r.slack_id).join(' + ')),
    });
  }
  if (actionable.length === 0) return;   // nothing mergeable ⇒ nothing to back up

  const affected = actionable.flatMap(g => g.rows);
  try {
    const migDir = path.join(path.dirname(dbPath), 'migrations');
    if (!fs.existsSync(migDir)) fs.mkdirSync(migDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(migDir, `v4_0_4_people_dedupe_${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(affected, null, 2), 'utf8');
    logger.info('people-dedupe migration — backed up affected rows', {
      backupPath, groups: actionable.length, rows: affected.length,
    });
  } catch (err) {
    logger.error('people-dedupe migration — backup write failed, no merge attempted', { err: String(err) });
    return;
  }

  let merged = 0;
  let refused = 0;
  for (const group of actionable) {
    const survivorId = group.rows[0].person_id;
    for (const loser of group.rows.slice(1)) {
      if (mergePersonRows(survivorId, loser.person_id)) merged++;
      else refused++;
    }
  }

  logger.warn('people-dedupe migration — duplicate-email rows collapsed', {
    groups: actionable.length, merged, refused,
    emails: actionable.map(g => g.key),
  });
}
