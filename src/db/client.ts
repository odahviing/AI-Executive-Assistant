import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import logger from '../utils/logger';
import { runV207ConsolidateRequests } from './migrations/v2_0_7_consolidate_requests';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(config.DB_PATH);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    db = new Database(config.DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    // v2.0.7 — one-shot migration: back up + drop pending_requests + approval_queue.
    // Runs AFTER initSchema so new installs (that never had the tables) don't
    // create-then-drop; existing installs back up first, then drop. Idempotent.
    try {
      runV207ConsolidateRequests(db, config.DB_PATH);
    } catch (err) {
      logger.error('v2.0.7 consolidate-requests migration threw — continuing', { err: String(err) });
    }
    logger.info('Database initialized', { path: config.DB_PATH });
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    -- v2.0.7: pending_requests + approval_queue retired. Their roles were
    -- consolidated into the approvals table (create_approval tool). The
    -- migration step right after initSchema drops the legacy tables if they
    -- still exist on an upgraded install; we do NOT re-create them here.

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
    // v1.8.4 — intent routing on outreach replies. Skills tag an outreach
    // with an intent (e.g. 'meeting_reschedule') and a context_json payload;
    // the reply dispatcher routes incoming replies to the right skill handler.
    `ALTER TABLE outreach_jobs ADD COLUMN intent TEXT`,
    `ALTER TABLE outreach_jobs ADD COLUMN context_json TEXT`,
    // v2.1.4 — when message_colleague proposes specific dates/times (e.g.
    // "noon works Wed 29 Apr for the bank visit"), Sonnet now passes the
    // structured proposed_slots (ISO dates) + subject_keyword alongside
    // the free-text message. Used at brief time to verify whether a
    // third-party booked the meeting on Idan's calendar and close the
    // outreach narration honestly.
    `ALTER TABLE outreach_jobs ADD COLUMN proposed_slots TEXT`,
    `ALTER TABLE outreach_jobs ADD COLUMN subject_keyword TEXT`,
    // v2.1.5 — store the Slack ts + channel of the initial outreach DM so
    // follow-up sends (confirmations after approval, relay messages) thread
    // into the same DM conversation instead of creating fresh top-level DMs.
    `ALTER TABLE outreach_jobs ADD COLUMN dm_message_ts TEXT`,
    `ALTER TABLE outreach_jobs ADD COLUMN dm_channel_id TEXT`,
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

  // v2.2 — Social Engine retires the legacy `social_topics` JSON blob on
  // people_memory. Topics + categories now live in proper tables
  // (social_categories / social_topics_v2 / social_engagements). Drop the
  // old column so stale reads can't resurface. Owner accepted the reset —
  // not much social data pre-v2.2 worth preserving.
  try { db.exec(`ALTER TABLE people_memory DROP COLUMN social_topics`); } catch (_) {}

  // v2.2 — numeric engagement rank per person (0..3). Replaces the 5-level
  // `engagement_level` string in profile_json for all new writes. Default 2
  // (neutral) so new contacts start with benefit of the doubt. Rank moves
  // based on signal: colleague replies well → +1; Maelle pings into the
  // void → -1; rank 0 = don't initiate (opt-out). See engagementRank.ts.
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN engagement_rank INTEGER NOT NULL DEFAULT 2`); } catch (_) {}

  // v2.2 — audit trail for engagement_rank changes. Small table so we can
  // answer "why is Ysrael at rank 0?". Reasons: no_reply / reply_engaged /
  // reply_brief / colleague_initiated / colleague_deflected / owner_directive.
  db.exec(`
    CREATE TABLE IF NOT EXISTS engagement_rank_log (
      id            TEXT PRIMARY KEY,
      slack_id      TEXT NOT NULL,
      delta         INTEGER NOT NULL,
      new_rank      INTEGER NOT NULL,
      reason        TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_engagement_rank_log_slack ON engagement_rank_log(slack_id, created_at DESC);
  `);

  // v2.2 — Social Engine tables.
  db.exec(`
    -- Fixed list of 30 top-level interest categories seeded per owner on first
    -- startup. No new categories are created at runtime. care_level starts
    -- 'unknown' and migrates based on signal accumulation across the topics
    -- under it (code-driven, not prompt-driven).
    CREATE TABLE IF NOT EXISTS social_categories (
      id                TEXT PRIMARY KEY,
      owner_user_id     TEXT NOT NULL,
      label             TEXT NOT NULL,
      care_level        TEXT NOT NULL DEFAULT 'unknown',
      -- unknown | low | medium | high — moves slowly via signal aggregation
      signals_positive  INTEGER NOT NULL DEFAULT 0,
      signals_negative  INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_user_id, label)
    );
    CREATE INDEX IF NOT EXISTS idx_social_categories_owner ON social_categories(owner_user_id);

    -- Topics live UNDER a category. Created on first mention (by owner or by
    -- Maelle). engagement_score drives lifecycle: starts at 3, moves with
    -- engagements, weekly -1 decay on untouched actives, floor at 0 flips
    -- status to 'dormant'. Dormant rows stay (category-level memory retained)
    -- — Maelle can't raise them, owner can revive by re-mentioning.
    CREATE TABLE IF NOT EXISTS social_topics_v2 (
      id                TEXT PRIMARY KEY,
      owner_user_id     TEXT NOT NULL,
      category_id       TEXT NOT NULL,
      label             TEXT NOT NULL,
      engagement_score  INTEGER NOT NULL DEFAULT 3,
      status            TEXT NOT NULL DEFAULT 'active',   -- active | dormant
      last_touched_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_touched_by   TEXT NOT NULL DEFAULT 'owner',    -- owner | maelle
      raised_count      INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_social_topics_v2_owner ON social_topics_v2(owner_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_social_topics_v2_cat ON social_topics_v2(category_id);

    -- Append-only engagement log. One row per social exchange. Enables rate-
    -- limit checks ("did Maelle already use today's slot?"), score auditing,
    -- and weekly decay pass ("which topics went 7+ days without an entry?").
    CREATE TABLE IF NOT EXISTS social_engagements (
      id            TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      topic_id      TEXT,        -- null when engagement is category-level only
      category_id   TEXT NOT NULL,
      direction     TEXT NOT NULL,
      -- owner_initiated | maelle_initiated | owner_response | maelle_response
      signal        TEXT NOT NULL DEFAULT 'none',
      -- positive | neutral | negative | none
      score_delta   INTEGER NOT NULL DEFAULT 0,
      turn_ref      TEXT,        -- thread_ts or similar — audit trail
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_social_engagements_owner ON social_engagements(owner_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_social_engagements_topic ON social_engagements(topic_id);
  `);

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

  // v2.1.1 — coord_jobs gains a second intent: MOVE. intent='schedule' books
  // a new meeting (today's path); intent='move' reshuffles an existing one
  // via moveMeeting on the existing_event_id. DM phrasing + terminal action
  // branch on intent. Default 'schedule' so every existing row keeps its
  // current behavior.
  try { db.exec(`ALTER TABLE coord_jobs ADD COLUMN intent TEXT NOT NULL DEFAULT 'schedule'`); } catch (_) {}
  try { db.exec(`ALTER TABLE coord_jobs ADD COLUMN existing_event_id TEXT`); } catch (_) {}

  // ── v1.7.2 — Summary skill ────────────────────────────────────────────────
  // One row per per-thread summary session. `current_draft` holds the
  // ephemeral in-progress JSON during stages 1–2; nulled at share or after
  // 7 days idle so the full summary text is never persisted long-term.
  // The other fields keep the meta we DO persist (date/time/attendees/subject).
  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      owner_user_id     TEXT NOT NULL,
      thread_ts         TEXT NOT NULL UNIQUE,   -- one session per thread
      channel_id        TEXT NOT NULL,
      stage             TEXT NOT NULL DEFAULT 'iterating',
      -- iterating | shared | cancelled
      current_draft     TEXT,                   -- ephemeral JSON; NULL after share / 7d idle
      meeting_date      TEXT,                   -- YYYY-MM-DD if known (from calendar / transcript)
      meeting_time      TEXT,                   -- HH:MM in owner-local if known
      meeting_subject   TEXT,
      main_topic        TEXT,
      attendees         TEXT NOT NULL DEFAULT '[]',
      -- JSON: [{slackId?, name, email?, internal: bool, source: 'calendar'|'transcript'}]
      is_external       INTEGER NOT NULL DEFAULT 0,
      transcript_chars  INTEGER,                -- for cost visibility on the summary call
      shared_at         TEXT,
      shared_to         TEXT                    -- JSON: [{type:'user'|'channel'|'mpim', id, name}]
    );
    CREATE INDEX IF NOT EXISTS idx_summary_sessions_owner ON summary_sessions(owner_user_id, stage);
  `);

  // ── v1.7.2 — tasks: target_slack_id / target_name ─────────────────────────
  // Lets owner ask "what's open with Brett?" and get every 1:1 task back in
  // one query. Populated for outreach tasks (1:1) and summary_action_followup
  // tasks. Coord tasks (multi-party) leave these NULL.
  try { db.exec(`ALTER TABLE tasks ADD COLUMN target_slack_id TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN target_name TEXT`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_target ON tasks(target_slack_id, status)`); } catch (_) {}

  // One-time backfill: existing outreach tasks get target_slack_id from their
  // linked outreach_jobs.colleague_slack_id (and target_name from colleague_name).
  // Idempotent — only updates rows where target_slack_id is still NULL.
  try {
    const updated = db.prepare(`
      UPDATE tasks
      SET target_slack_id = (
            SELECT colleague_slack_id FROM outreach_jobs WHERE outreach_jobs.id = tasks.skill_ref
          ),
          target_name = (
            SELECT colleague_name FROM outreach_jobs WHERE outreach_jobs.id = tasks.skill_ref
          )
      WHERE target_slack_id IS NULL
        AND skill_ref IS NOT NULL
        AND type IN ('outreach', 'outreach_send', 'outreach_expiry')
    `).run();
    if (updated.changes > 0) {
      logger.info('Backfilled tasks.target_slack_id from outreach_jobs', { rows: updated.changes });
    }
  } catch (err) {
    logger.warn('tasks.target_slack_id backfill skipped', { err: String(err) });
  }
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
