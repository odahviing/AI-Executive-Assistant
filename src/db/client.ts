import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import logger from '../utils/logger';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(config.DB_PATH);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    db = new Database(config.DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    logger.info('Database initialized', { path: config.DB_PATH });
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    -- Pending scheduling requests being negotiated
    CREATE TABLE IF NOT EXISTS pending_requests (
      id          TEXT PRIMARY KEY,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      status      TEXT NOT NULL DEFAULT 'open',   -- open | approved | rejected | completed | expired
      source      TEXT NOT NULL,                  -- slack | email
      thread_ts   TEXT,                           -- Slack thread timestamp
      channel_id  TEXT,                           -- Slack channel
      requester   TEXT NOT NULL,                  -- name or email of who requested
      subject     TEXT NOT NULL,                  -- meeting title / topic
      participants TEXT NOT NULL,                 -- JSON array of emails
      priority    TEXT NOT NULL DEFAULT 'medium', -- highest | high | medium | low
      duration_min INTEGER NOT NULL DEFAULT 40,
      preferred_slots TEXT,                       -- JSON array of ISO datetime strings
      proposed_slot TEXT,                         -- ISO datetime Maelle proposed
      notes       TEXT                            -- any extra context
    );

    -- Actions requiring the user's approval before execution
    CREATE TABLE IF NOT EXISTS approval_queue (
      id          TEXT PRIMARY KEY,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      status      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
      action_type TEXT NOT NULL,                   -- create_meeting | reschedule | cancel | send_email
      payload     TEXT NOT NULL,                   -- JSON blob of action details
      reason      TEXT NOT NULL,                   -- why approval is needed
      slack_msg_ts TEXT                            -- message TS so we can update it
    );

    -- Conversation context per Slack thread
    CREATE TABLE IF NOT EXISTS conversation_threads (
      thread_ts   TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      context     TEXT NOT NULL DEFAULT '[]',  -- JSON array of message history
      request_id  TEXT                         -- linked pending_request id
    );

    -- Known contacts with priority hints
    CREATE TABLE IF NOT EXISTS known_contacts (
      email       TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      priority    TEXT NOT NULL DEFAULT 'medium',
      org         TEXT,
      notes       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Meeting coordination — coordinate a meeting with one or more attendees
    CREATE TABLE IF NOT EXISTS coord_jobs (
      id                TEXT PRIMARY KEY,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      owner_user_id     TEXT NOT NULL,
      owner_channel     TEXT NOT NULL,
      owner_thread_ts   TEXT,
      subject           TEXT NOT NULL,
      topic             TEXT,
      duration_min      INTEGER NOT NULL DEFAULT 40,
      status            TEXT NOT NULL DEFAULT 'collecting',
      -- collecting | resolving | negotiating | waiting_owner | confirmed | booked | cancelled
      proposed_slots    TEXT NOT NULL DEFAULT '[]',  -- JSON array of ISO datetimes (3 options)
      participants      TEXT NOT NULL DEFAULT '[]',  -- JSON array of {slack_id, name, tz, response, responded_at}
      winning_slot      TEXT,   -- final confirmed slot
      notes             TEXT,
      last_calendar_check TEXT  -- ISO timestamp of last calendar freshness check
    );

    -- General outreach jobs — non-scheduling messages sent to colleagues
    CREATE TABLE IF NOT EXISTS outreach_jobs (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      owner_user_id   TEXT NOT NULL,
      owner_channel   TEXT NOT NULL,
      owner_thread_ts TEXT,
      colleague_slack_id TEXT NOT NULL,
      colleague_name  TEXT NOT NULL,
      colleague_tz    TEXT,
      message         TEXT NOT NULL,   -- what Maelle sent
      await_reply     INTEGER NOT NULL DEFAULT 1,  -- 1=wait for reply, 0=just send
      status          TEXT NOT NULL DEFAULT 'sent', -- sent | replied | no_response | cancelled
      reply_text      TEXT,
      sent_at         TEXT,
      reply_deadline  TEXT
    );

    -- Learned preferences — things the assistant learns about the user over time
    CREATE TABLE IF NOT EXISTS user_preferences (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,          -- profile key (e.g. 'idan')
      category    TEXT NOT NULL,          -- 'scheduling' | 'communication' | 'general' | 'people'
      key         TEXT NOT NULL,          -- short label, e.g. 'prefers_morning_meetings'
      value       TEXT NOT NULL,          -- the learned fact in plain English
      source      TEXT NOT NULL,          -- 'user_taught' | 'inferred'
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, key)               -- one value per key per user, updates replace
    );

    -- Event log — things that happened while the user was away
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      owner_user_id TEXT NOT NULL,
      type        TEXT NOT NULL,  -- message | meeting_invite | task_update | coordination | outreach_reply
      title       TEXT NOT NULL,  -- short human-readable summary
      detail      TEXT,           -- more context
      actor       TEXT,           -- who triggered it (colleague name/id)
      ref_id      TEXT,           -- linked task/job ID if any
      seen        INTEGER NOT NULL DEFAULT 0,  -- 0=unseen, 1=included in briefing
      actioned    INTEGER NOT NULL DEFAULT 0   -- 0=needs attention, 1=user dealt with it
    );
    CREATE INDEX IF NOT EXISTS idx_events_unseen ON events(owner_user_id, seen);

    -- Audit log — immutable record of all actions taken
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
      action      TEXT NOT NULL,
      source      TEXT NOT NULL,  -- slack | email | system
      actor       TEXT,           -- user id or 'maelle'
      target      TEXT,           -- meeting id, user email, etc
      details     TEXT,           -- JSON
      outcome     TEXT            -- success | failure | pending_approval
    );
  `);

  // ── Migrations — safe to run every startup, idempotent ──────────────────────
  // Migrate old multi_coord_jobs → coord_jobs (drop old table if it exists)
  try {
    const hasOldTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='multi_coord_jobs'`).get();
    if (hasOldTable) {
      db.exec(`DROP TABLE multi_coord_jobs`);
      logger.info('Dropped legacy multi_coord_jobs table');
    }
  } catch (_) {}
  // Add last_calendar_check column to coord_jobs
  try { db.exec(`ALTER TABLE coord_jobs ADD COLUMN last_calendar_check TEXT`); } catch (_) {}

  // v1.6.0 — drop legacy `coordination_jobs` table entirely (superseded by coord_jobs)
  try { db.exec(`DROP TABLE IF EXISTS coordination_jobs`); } catch (_) {}

  const columnMigrations = [
    `ALTER TABLE outreach_jobs ADD COLUMN colleague_tz TEXT`,
    `ALTER TABLE outreach_jobs ADD COLUMN scheduled_at TEXT`,
    `ALTER TABLE outreach_jobs ADD COLUMN conversation_json TEXT`,
    `ALTER TABLE outreach_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN user_requested INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE tasks ADD COLUMN briefed INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE outreach_jobs ADD COLUMN briefed_at TEXT`,
    // Defensive: older coord_jobs may be missing subject (was hit by injection-driven writes)
    `ALTER TABLE coord_jobs ADD COLUMN subject TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE coord_jobs ADD COLUMN topic TEXT`,
    `ALTER TABLE coord_jobs ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 40`,
    // Bug 1B — follow-up / abandon cron
    // last_participant_activity_at = most recent participant DM/ack on this coord
    // follow_up_sent_at            = when we pinged stale non-responders (null until sent)
    // abandoned_at                 = when the coord auto-closed after no follow-up reply
    `ALTER TABLE coord_jobs ADD COLUMN last_participant_activity_at TEXT`,
    `ALTER TABLE coord_jobs ADD COLUMN follow_up_sent_at TEXT`,
    `ALTER TABLE coord_jobs ADD COLUMN abandoned_at TEXT`,
  ];
  for (const sql of columnMigrations) {
    try { db.exec(sql); } catch (_) { /* column already exists — safe to ignore */ }
  }

  // Create tasks and events tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      owner_user_id   TEXT NOT NULL,
      owner_channel   TEXT NOT NULL,
      owner_thread_ts TEXT,
      type            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'new',
      title           TEXT NOT NULL,
      description     TEXT,
      due_at          TEXT,
      completed_at    TEXT,
      skill_ref       TEXT,
      context         TEXT NOT NULL DEFAULT '{}',
      who_requested   TEXT NOT NULL DEFAULT 'system',  -- slack_user_id or 'system'
      pending_on      TEXT,                            -- JSON array of slack_user_ids
      created_context TEXT,                            -- 'dm' | 'mpim:{id}' | 'channel:{id}'
      routine_id      TEXT                             -- FK to routines.id if spawned by a routine
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);

    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      owner_user_id TEXT NOT NULL,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      detail      TEXT,
      actor       TEXT,
      ref_id      TEXT,
      seen        INTEGER NOT NULL DEFAULT 0,
      actioned    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_events_unseen ON events(owner_user_id, seen);
  `);

  // People Memory — contacts encountered in the workspace, built automatically
  db.exec(`
    CREATE TABLE IF NOT EXISTS people_memory (
      slack_id    TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT,
      timezone    TEXT,
      gender      TEXT NOT NULL DEFAULT 'unknown',  -- male | female | unknown
      notes       TEXT NOT NULL DEFAULT '[]',  -- JSON: [{date, note}]
      last_seen   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_people_memory_name ON people_memory(name);
  `);

  // Migration: add gender column to existing people_memory tables
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN gender TEXT NOT NULL DEFAULT 'unknown'`); } catch (_) {}
  // Migration: social engagement tracking
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN last_social_at TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN last_initiated_at TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN social_topics TEXT NOT NULL DEFAULT '[]'`); } catch (_) {}
  // Migration: rich person profile
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}'`); } catch (_) {}
  // Migration: interaction timeline
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN interaction_log TEXT NOT NULL DEFAULT '[]'`); } catch (_) {}
  // Migration: Hebrew name spelling — lets Maelle use the correct Hebrew form
  // without transliterating at runtime. Populated by Maelle as she observes
  // names written in Hebrew (or learns them from the owner).
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN name_he TEXT`); } catch (_) {}
  // Migration: gender_confirmed — set to 1 once the person explicitly states
  // their own gender (or the owner confirms). Once confirmed, NO automatic
  // detection path (pronouns, image, name-LLM) may overwrite it. Lower layers
  // may still tentatively fill `gender` when confirmed=0.
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN gender_confirmed INTEGER NOT NULL DEFAULT 0`); } catch (_) {}

  // Routines — recurring instructions that run automatically on a schedule
  db.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      owner_user_id   TEXT NOT NULL,
      owner_channel   TEXT NOT NULL,
      title           TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      schedule_type   TEXT NOT NULL,  -- daily | weekdays | weekly | monthly
      schedule_time   TEXT NOT NULL,  -- HH:MM in user's timezone
      schedule_day    TEXT,           -- day name for weekly; day-of-month string for monthly
      status          TEXT NOT NULL DEFAULT 'active',  -- active | paused | deleted
      next_run_at     TEXT,
      last_run_at     TEXT,
      last_result     TEXT,
      run_count       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_routines_due
      ON routines(owner_user_id, status, next_run_at);
  `);

  // ── Task table migration: old → new schema ─────────────────────────────────
  // Migrate old columns to new ones (safe to run every startup)
  const taskMigrations = [
    `ALTER TABLE tasks ADD COLUMN who_requested TEXT NOT NULL DEFAULT 'system'`,
    `ALTER TABLE tasks ADD COLUMN pending_on TEXT`,
    `ALTER TABLE tasks ADD COLUMN created_context TEXT`,
    `ALTER TABLE tasks ADD COLUMN routine_id TEXT`,
  ];
  for (const sql of taskMigrations) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }
  // Migrate old user_requested integer to who_requested text
  try {
    const hasOldCol = db.prepare(`SELECT user_requested FROM tasks LIMIT 1`).get();
    if (hasOldCol !== undefined) {
      // Copy old values: 1 → owner_user_id (we don't know it, so use 'unknown'), 0 → 'system'
      // Then drop is not possible in SQLite, so we just leave the old column harmlessly
      db.prepare(`UPDATE tasks SET who_requested = 'system' WHERE who_requested = 'system' AND user_requested = 0`).run();
    }
  } catch (_) { /* old column doesn't exist — fresh DB */ }
  // Migrate old statuses to new ones
  try {
    db.prepare(`UPDATE tasks SET status = 'new' WHERE status = 'pending'`).run();
    db.prepare(`UPDATE tasks SET status = 'pending_colleague' WHERE status = 'waiting'`).run();
    db.prepare(`UPDATE tasks SET status = 'completed' WHERE status = 'done'`).run();
  } catch (_) {}

  // Add is_system to routines
  try { db.exec(`ALTER TABLE routines ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0`); } catch (_) {}

  // v1.5.1 — routine never_stale flag (always run at next opportunity no matter how late)
  try { db.exec(`ALTER TABLE routines ADD COLUMN never_stale INTEGER NOT NULL DEFAULT 0`); } catch (_) {}

  // v1.5.1 — tasks spawned by routines are deduped by (routine_id, due_at)
  // so the materializer can't insert the same firing twice. Filtered index so
  // one-off tasks (routine_id IS NULL) aren't constrained.
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_routine_due ON tasks(routine_id, due_at) WHERE routine_id IS NOT NULL`); } catch (_) {}

  // v1.6.0 — skill_origin: which skill created this task. Used for briefings,
  // filters, and "which skill is responsible for X" questions. Nullable for
  // legacy rows.
  try { db.exec(`ALTER TABLE tasks ADD COLUMN skill_origin TEXT`); } catch (_) {}

  // Calendar issues — tracks detected calendar problems and their resolution status
  // Statuses: new (flagged, waiting for owner), approved (owner says it's fine),
  //           to_resolve (owner wants it fixed), resolved (fixed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_dismissed_issues (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      owner_user_id   TEXT NOT NULL,
      event_date      TEXT NOT NULL,          -- YYYY-MM-DD of the calendar day
      issue_type      TEXT NOT NULL,          -- double_booking | oof_conflict | back_to_back | no_buffer | no_lunch | oof_with_meetings | work_on_day_off | overlap
      issue_key       TEXT NOT NULL,          -- unique key (e.g. "double_booking:16:15:Weekly Sales Ops")
      detail          TEXT NOT NULL,          -- human-readable description
      resolution      TEXT NOT NULL DEFAULT 'new',  -- new | approved | to_resolve | resolved | dismissed
      resolution_notes TEXT                   -- what the owner said to do (for to_resolve)
    );
    CREATE INDEX IF NOT EXISTS idx_cal_dismissed_owner
      ON calendar_dismissed_issues(owner_user_id, event_date);
  `);

  // Migrate: add resolution_notes column if missing (existing DBs)
  try { db.exec(`ALTER TABLE calendar_dismissed_issues ADD COLUMN resolution_notes TEXT`); } catch (_) {}
  // Migrate: old 'dismissed' entries stay as-is — they map to 'approved' semantically

  // ── Approvals (v1.5) ────────────────────────────────────────────────────────
  // First-class structured approvals. Every decision Maelle needs from the owner
  // is a row here. Always attached to a parent task (task_id is required) so the
  // task system remains the root coordinator. The LLM (Sonnet) reads pending
  // approvals from the system prompt and calls resolve_approval when the owner
  // decides — NO buttons, natural language is fine.
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id               TEXT PRIMARY KEY,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      task_id          TEXT NOT NULL,                     -- REQUIRED. Every approval is under a task.
      owner_user_id    TEXT NOT NULL,                     -- who must decide
      kind             TEXT NOT NULL,                     -- slot_pick | duration_override | policy_exception | lunch_bump | unknown_person | calendar_conflict | freeform
      status           TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | expired | superseded | cancelled
      payload_json     TEXT NOT NULL DEFAULT '{}',        -- kind-specific input (e.g. slots list, override details)
      decision_json    TEXT,                              -- kind-specific output (what was decided)
      skill_ref        TEXT,                              -- optional link to a domain job (coord_job id, outreach id, ...)
      slack_channel    TEXT,                              -- DM channel where owner was asked
      slack_thread_ts  TEXT,                              -- thread the ask lives in (for continuity)
      slack_msg_ts     TEXT,                              -- ts of the actual ask message (for update/edit)
      expires_at       TEXT,                              -- ISO — after this the runner flips to expired
      responded_at     TEXT,                              -- ISO — when the owner decided
      superseded_by    TEXT,                              -- id of another approval that replaced this one
      idempotency_key  TEXT UNIQUE,                       -- coord_job_id + kind + payload_hash — safe retry
      notes            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_owner_status ON approvals(owner_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_expires ON approvals(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_skill_ref ON approvals(skill_ref);
  `);

  // Requesters / idempotency on coord_jobs (v1.5)
  try { db.exec(`ALTER TABLE coord_jobs ADD COLUMN requesters TEXT NOT NULL DEFAULT '[]'`); } catch (_) {}
  try { db.exec(`ALTER TABLE coord_jobs ADD COLUMN external_event_id TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE coord_jobs ADD COLUMN request_signature TEXT`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_coord_jobs_req_sig ON coord_jobs(request_signature, status)`); } catch (_) {}
}

// ── Audit log helper ─────────────────────────────────────────────────────────

export function auditLog(params: {
  action: string;
  source: string;
  actor?: string;
  target?: string;
  details?: Record<string, unknown>;
  outcome: 'success' | 'failure' | 'pending_approval';
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (action, source, actor, target, details, outcome)
    VALUES (@action, @source, @actor, @target, @details, @outcome)
  `).run({
    action:  params.action,
    source:  params.source,
    actor:   params.actor  ?? null,
    target:  params.target ?? null,
    details: params.details ? JSON.stringify(params.details) : null,
    outcome: params.outcome,
  });
}
