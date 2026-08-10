/**
 * v4.5.3 — calendar-issues-schema-lacks-axis-column.
 *
 * `calendar_issues` carried `UNIQUE(owner_user_id, event_id)` with no axis
 * dimension, so a day-shape problem (conflict axis: overlap, oof_with_meetings,
 * category_limit, missing_floating_block, busy_day, work_on_day_off) and a
 * "which category should this be?" question (question axis: missing_category)
 * on the SAME event could never both hold a row — the second insert hit the
 * UNIQUE constraint, and `upsertCluster` (db/calendarIssues.ts) had to catch
 * it, diagnose whether the collision was cross-axis, and no-op rather than
 * risk silently erasing the other axis's row (including a PERMANENT
 * dismissal — gh#180's exact harm). That whole defensive branch existed only
 * because the schema couldn't tell the two axes apart.
 *
 * This rebuild adds `axis` ('conflict' | 'question', derived from
 * issue_class — see db/calendarIssues.ts axisFor()) and widens the UNIQUE
 * constraint to (owner_user_id, event_id, axis), so both axes can hold a row
 * on the same event at once — which is exactly what QUESTION_ONLY_CLASSES
 * already assumed at the application layer.
 *
 * Why a rebuild and not an ALTER: SQLite cannot add or change a UNIQUE table
 * constraint in place (mirrors v3_2_0_person_store's PK-change rebuild).
 * Every column is carried over verbatim; `axis` is backfilled from each row's
 * existing `issue_class`.
 *
 * Data safety: every row is dumped to a JSON backup under data/migrations/
 * BEFORE any destructive step, and the rebuild runs in a single transaction
 * with a row-count assertion — any mismatch throws and rolls back, leaving
 * the original table intact.
 *
 * Idempotent: if `calendar_issues.axis` already exists, this is a no-op.
 * Runs once per process on the first getDb() call, AFTER initSchema (so a
 * fresh install — which gets the new shape straight from initSchema — never
 * reaches this at all: hasColumn() is already true).
 */

import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger';

interface ColInfo { name: string }

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[];
  return cols.some(c => c.name === col);
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
  ).get(name) as { name: string } | undefined;
  return !!row;
}

// Single source of truth for the axis mapping, mirrored from
// db/calendarIssues.ts's QUESTION_ONLY_CLASSES so a migrated row's axis
// always agrees with what axisFor() would compute for it today.
const QUESTION_ONLY_CLASSES = new Set(['missing_category']);
function axisForClass(issueClass: string): 'conflict' | 'question' {
  return QUESTION_ONLY_CLASSES.has(issueClass) ? 'question' : 'conflict';
}

export function runCalendarIssuesAxisMigration(db: Database.Database, dbPath: string): void {
  if (!tableExists(db, 'calendar_issues')) return;      // fresh install — initSchema creates the final shape
  if (hasColumn(db, 'calendar_issues', 'axis')) return;  // already migrated

  // ── 1. Read + back up every row BEFORE any destructive step ──
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(`SELECT * FROM calendar_issues`).all() as Record<string, unknown>[];
  } catch (err) {
    logger.error('calendar-issues axis migration — read failed, aborting (table left intact)', { err: String(err) });
    return;
  }
  const oldCount = rows.length;

  try {
    const migDir = path.join(path.dirname(dbPath), 'migrations');
    if (!fs.existsSync(migDir)) fs.mkdirSync(migDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(migDir, `v4_5_3_calendar_issues_${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2), 'utf8');
    logger.info('calendar-issues axis migration — backed up calendar_issues', { backupPath, rows: oldCount });
  } catch (err) {
    logger.error('calendar-issues axis migration — backup write failed, aborting rebuild', { err: String(err) });
    return;
  }

  // ── 2. Transactional rebuild with row-count assertion ──
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE calendar_issues_new (
        id              TEXT PRIMARY KEY,
        owner_user_id   TEXT NOT NULL,
        event_id        TEXT NOT NULL,
        peer_event_id   TEXT,
        event_date      TEXT NOT NULL,
        event_end_ms    INTEGER NOT NULL,
        issue_class     TEXT NOT NULL,
        axis            TEXT NOT NULL DEFAULT 'conflict',
        status          TEXT NOT NULL DEFAULT 'new',
        notes           TEXT,
        request_id      TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (owner_user_id, event_id, axis)
      )
    `);

    const insert = db.prepare(`
      INSERT INTO calendar_issues_new (
        id, owner_user_id, event_id, peer_event_id, event_date, event_end_ms,
        issue_class, axis, status, notes, request_id, created_at, updated_at
      ) VALUES (
        @id, @owner_user_id, @event_id, @peer_event_id, @event_date, @event_end_ms,
        @issue_class, @axis, @status, @notes, @request_id, @created_at, @updated_at
      )
    `);

    for (const r of rows) {
      const issueClass = String(r.issue_class ?? '');
      insert.run({
        id:             r.id,
        owner_user_id:  r.owner_user_id,
        event_id:       r.event_id,
        peer_event_id:  r.peer_event_id ?? null,
        event_date:     r.event_date,
        event_end_ms:   r.event_end_ms,
        issue_class:    issueClass,
        axis:           axisForClass(issueClass),
        status:         r.status,
        notes:          r.notes ?? null,
        request_id:     r.request_id ?? null,
        created_at:     r.created_at,
        updated_at:     r.updated_at,
      });
    }

    const newCount = (db.prepare(`SELECT COUNT(*) AS c FROM calendar_issues_new`).get() as { c: number }).c;
    if (newCount !== oldCount) {
      throw new Error(`calendar-issues axis migration row mismatch: old=${oldCount} new=${newCount} — rolling back`);
    }

    db.exec(`DROP TABLE calendar_issues`);
    db.exec(`ALTER TABLE calendar_issues_new RENAME TO calendar_issues`);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_issues_active ON calendar_issues(owner_user_id, status, event_end_ms)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_issues_peer ON calendar_issues(owner_user_id, peer_event_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_issues_request ON calendar_issues(request_id)`);
  });

  try {
    rebuild();
    logger.info('calendar-issues axis migration — calendar_issues rebuilt', { migrated: oldCount });
  } catch (err) {
    logger.error('calendar-issues axis migration — rebuild failed, original table preserved', { err: String(err) });
    try { db.exec(`DROP TABLE IF EXISTS calendar_issues_new`); } catch { /* noop */ }
  }
}
