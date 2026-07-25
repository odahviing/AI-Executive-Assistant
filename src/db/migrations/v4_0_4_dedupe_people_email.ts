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
 * Data safety: every row of every affected group is dumped to
 * data/migrations/v4_0_4_people_dedupe_<ts>.json BEFORE the first merge (mirrors
 * the v2.0.7 / v3.2.0 pattern). No backup written ⇒ no merge attempted.
 * Registered AFTER the `is_vip` ALTER in client.ts so the merge writes against
 * the final column shape.
 */

import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger';
import { mergePersonRows } from '../people';

interface DupeGroup { key: string; n: number }

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

  const affected = groups.flatMap(g => rowsFor.all(g.key) as Record<string, unknown>[]);
  try {
    const migDir = path.join(path.dirname(dbPath), 'migrations');
    if (!fs.existsSync(migDir)) fs.mkdirSync(migDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(migDir, `v4_0_4_people_dedupe_${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(affected, null, 2), 'utf8');
    logger.info('people-dedupe migration — backed up affected rows', {
      backupPath, groups: groups.length, rows: affected.length,
    });
  } catch (err) {
    logger.error('people-dedupe migration — backup write failed, no merge attempted', { err: String(err) });
    return;
  }

  let merged = 0;
  let refused = 0;
  for (const group of groups) {
    const rows = rowsFor.all(group.key) as { person_id: string }[];
    if (rows.length < 2) continue;
    const survivorId = rows[0].person_id;
    for (const loser of rows.slice(1)) {
      if (mergePersonRows(survivorId, loser.person_id)) merged++;
      else refused++;
    }
  }

  logger.warn('people-dedupe migration — duplicate-email rows collapsed', {
    groups: groups.length, merged, refused,
    emails: groups.map(g => g.key),
  });
}
