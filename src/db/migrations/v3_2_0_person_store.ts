/**
 * v3.2.0 — Unified Person Store.
 *
 * Evolves `people_memory` from a Slack-first table (PK = slack_id, so a
 * pure-email external person had nowhere to live) into ONE backbone table for
 * EVERY person Maelle knows — internal AND external — keyed by a stable
 * surrogate `person_id`.
 *
 * Why a rebuild and not an ALTER: SQLite cannot drop/replace a PRIMARY KEY or
 * make a PK column nullable in place. Demoting `slack_id` from PK to a
 * nullable-unique identity attribute therefore requires the standard
 * create-new → copy → drop → rename dance. Every column is carried over
 * verbatim (including `interaction_log` — history stays exactly as it is
 * today, just connected to the person via `person_id`).
 *
 * Data safety (owner hard requirement — "don't lose the data on transition"):
 *   1. Every row is dumped to a JSON backup under data/migrations/ BEFORE any
 *      destructive step (mirrors the v2.0.7 migration pattern).
 *   2. The rebuild runs in a single transaction with a row-count assertion —
 *      any mismatch throws and rolls back, leaving the original table intact.
 *
 * New shape:
 *   - person_id TEXT PRIMARY KEY      surrogate, stable, never changes
 *   - slack_id  TEXT  (nullable, UNIQUE)   null for pure-email externals
 *   - email     TEXT  (nullable, indexed)  logical key; resolvePerson matches on it
 *   - kind      TEXT NOT NULL DEFAULT 'internal'   internal | external | self
 *   - org       TEXT                       company (mostly external)
 *   - source    TEXT                       row origin: slack | calendar | manual
 *   - …all existing columns carried verbatim (name, name_he, timezone, gender,
 *     gender_confirmed, notes, interaction_log, profile_json, state +
 *     *_set_by provenance, working_hours_auto, engagement_rank,
 *     last_seen/social/initiated, proactive_pending, currently_traveling,
 *     created_at, updated_at).
 *
 * Also drops the dead `known_contacts` table (scaffolded in v? but never wired
 * — zero readers/writers; externals now live in people_memory instead).
 *
 * Idempotent: if `people_memory.person_id` already exists, this is a no-op.
 * Runs once per process on the first getDb() call, AFTER initSchema (so all
 * legacy columns exist to be copied).
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

/** Deterministic, stable person_id from an existing row's slack_id. Existing
 *  rows always have a slack_id (it was the PK), so this is total and unique.
 *  Sanitize to a safe token; `SELF:<owner>` → `p_SELF_<owner>`. */
function personIdFromSlackId(slackId: string): string {
  return `p_${slackId.replace(/[^A-Za-z0-9]/g, '_')}`;
}

export function runPersonStoreMigration(db: Database.Database, dbPath: string): void {
  if (!tableExists(db, 'people_memory')) return;       // fresh install handles it via initSchema + first write
  if (hasColumn(db, 'people_memory', 'person_id')) return;  // already migrated

  // ── 1. Read + back up every row BEFORE any destructive step ──
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(`SELECT * FROM people_memory`).all() as Record<string, unknown>[];
  } catch (err) {
    logger.error('person-store migration — read failed, aborting (table left intact)', { err: String(err) });
    return;
  }
  const oldCount = rows.length;

  try {
    const migDir = path.join(path.dirname(dbPath), 'migrations');
    if (!fs.existsSync(migDir)) fs.mkdirSync(migDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(migDir, `v3_2_0_people_memory_${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2), 'utf8');
    logger.info('person-store migration — backed up people_memory', { backupPath, rows: oldCount });
  } catch (err) {
    logger.error('person-store migration — backup write failed, aborting rebuild', { err: String(err) });
    return;
  }

  // ── 2. Transactional rebuild with row-count assertion ──
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE people_memory_new (
        person_id           TEXT PRIMARY KEY,
        slack_id            TEXT,                                  -- nullable; UNIQUE index below
        email               TEXT,                                  -- nullable; logical key
        kind                TEXT NOT NULL DEFAULT 'internal',      -- internal | external | self
        org                 TEXT,
        source              TEXT,                                  -- slack | calendar | manual
        name                TEXT NOT NULL,
        name_he             TEXT,
        timezone            TEXT,
        gender              TEXT NOT NULL DEFAULT 'unknown',
        gender_confirmed    INTEGER NOT NULL DEFAULT 0,
        notes               TEXT NOT NULL DEFAULT '[]',
        interaction_log     TEXT NOT NULL DEFAULT '[]',
        profile_json        TEXT NOT NULL DEFAULT '{}',
        state               TEXT,
        state_set_by        TEXT,
        timezone_set_by     TEXT,
        gender_set_by       TEXT,
        working_hours_auto  TEXT,
        engagement_rank     INTEGER NOT NULL DEFAULT 2,
        last_seen           TEXT,
        last_social_at      TEXT,
        last_initiated_at   TEXT,
        proactive_pending   INTEGER NOT NULL DEFAULT 0,
        currently_traveling TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const insert = db.prepare(`
      INSERT INTO people_memory_new (
        person_id, slack_id, email, kind, org, source,
        name, name_he, timezone, gender, gender_confirmed,
        notes, interaction_log, profile_json,
        state, state_set_by, timezone_set_by, gender_set_by, working_hours_auto,
        engagement_rank, last_seen, last_social_at, last_initiated_at,
        proactive_pending, currently_traveling, created_at, updated_at
      ) VALUES (
        @person_id, @slack_id, @email, @kind, @org, @source,
        @name, @name_he, @timezone, @gender, @gender_confirmed,
        @notes, @interaction_log, @profile_json,
        @state, @state_set_by, @timezone_set_by, @gender_set_by, @working_hours_auto,
        @engagement_rank, @last_seen, @last_social_at, @last_initiated_at,
        @proactive_pending, @currently_traveling, @created_at, @updated_at
      )
    `);

    for (const r of rows) {
      const slackId = String(r.slack_id ?? '');
      const isSelf = slackId.startsWith('SELF:');
      insert.run({
        person_id:           personIdFromSlackId(slackId),
        slack_id:            r.slack_id ?? null,
        email:               r.email ?? null,
        kind:                isSelf ? 'self' : 'internal',  // all pre-migration rows are internal/self
        org:                 null,
        source:              'slack',
        name:                r.name ?? '',
        name_he:             r.name_he ?? null,
        timezone:            r.timezone ?? null,
        gender:              r.gender ?? 'unknown',
        gender_confirmed:    r.gender_confirmed ?? 0,
        notes:               r.notes ?? '[]',
        interaction_log:     r.interaction_log ?? '[]',
        profile_json:        r.profile_json ?? '{}',
        state:               r.state ?? null,
        state_set_by:        r.state_set_by ?? null,
        timezone_set_by:     r.timezone_set_by ?? null,
        gender_set_by:       r.gender_set_by ?? null,
        working_hours_auto:  r.working_hours_auto ?? null,
        engagement_rank:     r.engagement_rank ?? 2,
        last_seen:           r.last_seen ?? null,
        last_social_at:      r.last_social_at ?? null,
        last_initiated_at:   r.last_initiated_at ?? null,
        proactive_pending:   r.proactive_pending ?? 0,
        currently_traveling: r.currently_traveling ?? null,
        created_at:          r.created_at ?? null,
        updated_at:          r.updated_at ?? null,
      });
    }

    const newCount = (db.prepare(`SELECT COUNT(*) AS c FROM people_memory_new`).get() as { c: number }).c;
    if (newCount !== oldCount) {
      throw new Error(`person-store migration row mismatch: old=${oldCount} new=${newCount} — rolling back`);
    }

    db.exec(`DROP TABLE people_memory`);
    db.exec(`ALTER TABLE people_memory_new RENAME TO people_memory`);

    // slack_id was the PK → guaranteed unique + non-null for legacy rows, so a
    // UNIQUE index is safe (SQLite allows multiple NULLs for future externals).
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_people_slack ON people_memory(slack_id)`);
    // email is a logical key, but legacy data MAY contain dup/empty emails — a
    // plain index avoids aborting the migration; resolvePerson enforces "one
    // person per email" logically (first match wins, Slack row preferred).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_people_email ON people_memory(email)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_people_memory_name ON people_memory(name)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_people_kind ON people_memory(kind)`);
  });

  try {
    rebuild();
    logger.info('person-store migration — people_memory rebuilt', { migrated: oldCount });
  } catch (err) {
    logger.error('person-store migration — rebuild failed, original table preserved', { err: String(err) });
    // Best-effort cleanup of the staging table if the transaction left it.
    try { db.exec(`DROP TABLE IF EXISTS people_memory_new`); } catch { /* noop */ }
    return;
  }

  // ── 3. Drop the dead known_contacts table (zero readers/writers) ──
  try {
    if (tableExists(db, 'known_contacts')) {
      db.exec(`DROP TABLE known_contacts`);
      logger.info('person-store migration — dropped dead known_contacts table');
    }
  } catch (err) {
    logger.warn('person-store migration — known_contacts drop failed (non-fatal)', { err: String(err) });
  }
}
