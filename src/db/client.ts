import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import logger from '../utils/logger';
import { loadAllProfiles } from '../config/userProfile';
import { runV207ConsolidateRequests } from './migrations/v2_0_7_consolidate_requests';
import { runPersonStoreMigration } from './migrations/v3_2_0_person_store';
import { runDedupePeopleByEmail } from './migrations/v4_0_4_dedupe_people_email';
import { runSocialProvenanceBackfill } from './migrations/v4_4_9_social_provenance_backfill';
import { runCalendarIssuesAxisMigration } from './migrations/v4_5_3_calendar_issues_axis';
import { runPurgeWorkShapedSocialSubjects } from './migrations/v4_5_9_purge_work_subjects';
import { runSocialCategoryScoreRebase } from './migrations/v4_5_9_social_category_scores';

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
    // v3.2.0 — Unified Person Store: rebuild people_memory onto a surrogate
    // person_id PK with nullable slack_id/email + kind, so externals live in
    // the same table. Idempotent; backs up + asserts row parity before any
    // destructive step. Runs AFTER initSchema so all legacy columns exist.
    try {
      runPersonStoreMigration(db, config.DB_PATH);
    } catch (err) {
      logger.error('v3.2.0 person-store migration threw — continuing', { err: String(err) });
    }
    // v3.2.6 — is_vip on people_memory. Owner-marked VIP: their calendar is
    // ALWAYS pulled into a thread-booking free/busy search; non-VIPs are
    // invite-only (annotated, never gating). Default 0 — VIP only when the owner
    // explicitly says so. Seed for the full VIP feature (#58). Added AFTER the
    // person-store rebuild (which carries a fixed column list) so it lands on the
    // final table shape in one boot; idempotent via try/catch.
    try { db.exec(`ALTER TABLE people_memory ADD COLUMN is_vip INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
    // v4.0.4 — one human, one row. Collapse any people_memory rows that share an
    // email (the pre-4.0.4 upsertPersonMemory could mint a second row for someone
    // already on file from the calendar). Runs LAST so the merge writes against
    // the final column shape (is_vip included). Cheap grouped scan; no-ops on a
    // clean table. Backs up every affected row before touching anything.
    try {
      runDedupePeopleByEmail(db, config.DB_PATH);
    } catch (err) {
      logger.error('v4.0.4 people-dedupe migration threw — continuing', { err: String(err) });
    }
    // v4.4.9 — backfill social_subjects/social_topics rows mis-stamped
    // created_by='owner' by the pre-cc7d4ce reconciliation writer (gh#154-R7). Runs
    // AFTER the tables exist (initSchema, above); idempotent, no-ops once clean.
    try {
      runSocialProvenanceBackfill(db);
    } catch (err) {
      logger.error('v4.4.9 social-provenance backfill threw — continuing', { err: String(err) });
    }
    // calendar-issues-schema-lacks-axis-column — widen UNIQUE(owner_user_id,
    // event_id) to include axis, so a conflict-axis row and a question-axis
    // row can coexist on the same event. Rebuild (SQLite can't ALTER a
    // UNIQUE constraint); idempotent, no-ops once calendar_issues.axis exists
    // (including every fresh install, which gets it straight from initSchema).
    try {
      runCalendarIssuesAxisMigration(db, config.DB_PATH);
    } catch (err) {
      logger.error('v4.5.3 calendar-issues axis migration threw — continuing', { err: String(err) });
    }
    // v4.5.9 (#198) — Social Engine redesign. Purge work-shaped social_subjects
    // rows FIRST (they must not seed the new per-person category score
    // table), then rebase engagement_score onto social_person_category_scores
    // and drop the superseded scoring columns. Idempotent; no-ops on a fresh
    // install (which gets the final shape straight from initSchema) and on
    // every boot after the first successful run.
    try {
      runPurgeWorkShapedSocialSubjects(db, config.DB_PATH);
    } catch (err) {
      logger.error('v4.5.9 purge-work-subjects migration threw — continuing', { err: String(err) });
    }
    try {
      runSocialCategoryScoreRebase(db, config.DB_PATH);
    } catch (err) {
      logger.error('v4.5.9 social-category-score rebase migration threw — continuing', { err: String(err) });
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

    -- Per-date work-schedule overrides (v3.7.x / #143) — chat-driven exceptions
    -- to the yaml schedule for a specific date. YAML is the default; a row here
    -- WINS for that date; no row = yaml (fail-safe). A non-null timezone column marks
    -- an away day (work-hours evaluated in that zone; books directly). Any column
    -- left null keeps the yaml base for that axis.
    CREATE TABLE IF NOT EXISTS owner_schedule_overrides (
      owner_slack_id TEXT NOT NULL,
      date           TEXT NOT NULL,   -- yyyy-MM-dd in the owner's home tz
      is_workday     INTEGER,         -- null=keep base · 0=force off · 1=force on
      windows        TEXT,            -- JSON ["09:00-17:00", ...] · null=keep base
      location       TEXT,            -- 'office' | 'home' · null=keep base
      timezone       TEXT,            -- IANA (e.g. America/New_York) · presence ⇒ away day · null=home tz
      source         TEXT NOT NULL DEFAULT 'chat',
      note           TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner_slack_id, date)
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
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
      owner_user_id TEXT NOT NULL DEFAULT '',  -- backfilled below on upgrade; see #52 tenancy fix
      action        TEXT NOT NULL,
      source        TEXT NOT NULL,  -- slack | email | system
      actor         TEXT,           -- user id or 'maelle'
      target        TEXT,           -- meeting id, user email, etc
      details       TEXT,           -- JSON
      outcome       TEXT            -- success | failure | pending_approval
    );
  `);
  // idx_audit_log_owner is created further down, AFTER the owner_user_id
  // ALTER TABLE migration runs — on an upgrade the column doesn't exist yet
  // at this point (CREATE TABLE IF NOT EXISTS is a no-op on an existing
  // table), so creating the index here would throw on every pre-#52 DB.

  // ── Migrations — safe to run every startup, idempotent ──────────────────────
  // v3.4.x — the multi-party coord subsystem was removed. Drop its legacy
  // tables if they linger from an older DB (harmless no-op on a fresh DB).
  try { db.exec(`DROP TABLE IF EXISTS multi_coord_jobs`); } catch (_) {}
  try { db.exec(`DROP TABLE IF EXISTS coordination_jobs`); } catch (_) {}

  // v3.4.6 (spine collapse) — drop the legacy `approvals` table entirely.
  // Approvals are requests now (src/core/requests/, src/db/requests.ts);
  // createApproval was deleted in v3.0.6 and the last readers (coord-reply
  // counter/cancel) were migrated to the spine. No history kept — owner
  // direction: leave no dead storage.
  try { db.exec(`DROP TABLE IF EXISTS approvals`); } catch (_) {}

  // v3.7.x cleanup — drop tables whose code was removed: cron_schedules (its
  // CRUD module was never wired — routines remains the live path) and
  // assistant_threads (its readers were dead; registration was write-only).
  try { db.exec(`DROP TABLE IF EXISTS cron_schedules`); } catch (_) {}
  try { db.exec(`DROP TABLE IF EXISTS assistant_threads`); } catch (_) {}

  // known_contacts — scaffolded, never wired (zero readers/writers). The
  // v3.2.0 person-store migration (db/migrations/v3_2_0_person_store.ts) drops
  // it once, but that migration no-ops on every boot once `people_memory.person_id`
  // exists (already the case in production), so its DROP step never runs again.
  // The CREATE TABLE IF NOT EXISTS that used to sit above in this same file
  // re-created the table on every single boot after that — an empty table
  // resurrected forever. Removed that CREATE; this DROP retires what's left.
  try { db.exec(`DROP TABLE IF EXISTS known_contacts`); } catch (_) {}

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
    // v2.6.1 — independent follow-up tracking, separate from `status`.
    // The existing `status` field churns on a 5-min auto-close path
    // (closeFireAndForgetOutreach) for await_reply=false rows, which left
    // colleague replies arriving 2+ min later with no recoverable
    // "what did Maelle say?" context. These two columns track the
    // CONVERSATIONAL closure of the DM independent of task lifecycle:
    // followup_closed_at NULL = open (still expecting/accepting acknowledgment);
    // populated when the colleague reacted with emoji, threaded a reply,
    // sent a follow-up DM that matched (deterministic <10min, or LLM-
    // classified-as-response 10min-24h), or 24h elapsed.
    `ALTER TABLE outreach_jobs ADD COLUMN followup_closed_at TEXT`,
    `ALTER TABLE outreach_jobs ADD COLUMN followup_close_reason TEXT`,
    // #52 (piece 3) — audit_log was the only stateful table with no owner scope;
    // its reader (recentAuditEntries, called from the owner-DM calendar-recall
    // block) filtered action+outcome+timestamp only, so a second profile's
    // get_calendar could narrate THIS owner's audit trail. Column added here
    // for upgrades; CREATE TABLE above covers fresh installs.
    `ALTER TABLE audit_log ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT ''`,
    // v4.7.4 (#203-5) — per-venue owner-stated one-way travel time, an
    // alternative to the flat 30-min default when a venue match exists.
    // NULL = not yet stated; never derived from the calendar or a routing
    // lookup, only ever written by the owner (or preserved, not overwritten,
    // by save-on-book — see saveOrBumpVenueOnBook).
    `ALTER TABLE venues ADD COLUMN travel_time_minutes INTEGER`,
  ];
  for (const sql of columnMigrations) {
    try { db.exec(sql); } catch (_) { /* column already exists — safe to ignore */ }
  }

  // #52 (piece 3) — now that owner_user_id exists on every audit_log row (fresh
  // install via CREATE TABLE, upgrade via the ALTER TABLE above), the index
  // can be created safely, and any row still carrying the '' placeholder
  // (pre-existing rows on an upgraded DB) gets backfilled. Only backfill when
  // there is EXACTLY one configured profile — with any other count we cannot
  // safely assert whose rows these are, so we leave them '' rather than
  // guess (a query with an empty owner filter simply returns nothing, which
  // is the safe failure mode, not a leak).
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_owner ON audit_log(owner_user_id, action)`);
    const unbackfilled = db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE owner_user_id = ''`).get() as { c: number };
    if (unbackfilled.c > 0) {
      const profiles = loadAllProfiles();
      if (profiles.size === 1) {
        const [[, onlyProfile]] = [...profiles.entries()];
        const ownerId = onlyProfile.user.slack_user_id;
        const backfilled = db.prepare(`UPDATE audit_log SET owner_user_id = ? WHERE owner_user_id = ''`).run(ownerId);
        logger.info('audit_log.owner_user_id backfilled to the single configured profile', {
          ownerId, rows: backfilled.changes,
        });
      } else {
        logger.warn('audit_log.owner_user_id backfill skipped — profile count is not exactly 1, refusing to guess', {
          profileCount: profiles.size, unbackfilledRows: unbackfilled.c,
        });
      }
    }
  } catch (err) {
    logger.warn('audit_log.owner_user_id backfill failed (non-fatal)', { err: String(err) });
  }

  // #41 ("only one spine", owner ruling 2026-07-26) — retire outreach_jobs.status.
  // The linked `requests` row owns outreach lifecycle (state / phase / timers);
  // this column was a second one that never actually tracked anything: a row was
  // born at the SQL default 'sent' and only a cascade moved it, so fire-and-forget
  // sends (request `resolved` at birth) and every pre-bridge row (request_id NULL)
  // sat at 'sent' forever. Its last reader (calendarHealth's reschedule-ping dedup)
  // and both cascade writes are gone — see the ONE SPINE block at the top of
  // db/jobs.ts. Nothing SELECTs or UPDATEs it, the OutreachJob interface has no
  // `status` member (so `SELECT *` readers discard it structurally), and the INSERT
  // omits the column. No history kept — same call as the `approvals` DROP TABLE
  // above and people_memory's `social_topics` DROP COLUMN further down: leave no
  // dead storage. The 115 rows on disk carried only values written by removed code
  // (49 'done' + 2 'expired', all pre-bridge; 29 'cancelled'; 16 'replied'; 19
  // 'sent'). Idempotent: throws "no such column" on every boot after the first,
  // and on a fresh DB where the CREATE TABLE above never made it.
  try { db.exec(`ALTER TABLE outreach_jobs DROP COLUMN status`); } catch (_) {}

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
  // v3.5.x (person-memory rebuild) — provenance for the native-script name
  // (`name_he` column; despite the name it holds ANY non-Latin spelling —
  // Hebrew/Cyrillic/Arabic). Same authority chain as the other core fields
  // (owner > person > auto). Lets an owner correction ("עידן not אידן") stick
  // and stops an auto guess from re-overwriting it. Cosmetic rename of the
  // column to `name_native` is deferred (45 call-sites) — behavior is generic.
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN name_he_set_by TEXT`); } catch (_) {}
  // v3.5.x (person-memory rebuild) — derived outbound-language signal. We stamp
  // the dominant SCRIPT of each inbound human message ('he'|'ru'|'ar'|'en')
  // plus when we saw it. Outbound composition TO a person (relay / outreach /
  // coord) derives its language from the most RECENT inbound (default English)
  // instead of a frozen, one-off `language_preference`. Self-correcting: an
  // English-writing colleague stops getting Hebrew the moment they write.
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN last_inbound_lang TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN last_inbound_lang_at TEXT`); } catch (_) {}
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

  // v2.2.2 (#46) — core attendee info layer.
  // - state: free-text location (city / country) — drives timezone derivation when set first
  // - <field>_set_by: provenance tag for the authority chain (owner > person > auto)
  //   * owner: owner directly told Maelle ("Yael is in Israel")
  //   * person: the person stated it themselves OR a colleague-self confirm
  //   * auto:   inferred from Slack profile / image / name LLM
  //   Owner overrides anyone; person overrides only auto; auto can't overwrite a set value.
  // - working_hours_auto: JSON {workdays, hoursStart, hoursEnd} derived from timezone defaults
  //   (Israel TZ → Sun–Thu 09–17, else Mon–Fri 09–17). Distinct from working_hours_structured
  //   on profile_json (manual override). Readers prefer manual → fall back to auto.
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN state TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN state_set_by TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN timezone_set_by TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN gender_set_by TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN working_hours_auto TEXT`); } catch (_) {}

  // v2.2.3 — proactive ping anti-spam lock. DEAD as of v3.2.5: the cold-open
  // (socialOutreachTick) that set + read it was removed; all TS helpers are
  // deleted. The column is left in place at its default 0 (a column drop is a
  // risky table rebuild on the live DB, and nothing reads it) — safe to drop
  // in a future migration.
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN proactive_pending INTEGER NOT NULL DEFAULT 0`); } catch (_) {}

  // v2.2.4 — travel awareness. Stored profile fields (timezone, state) are
  // defaults — most of the time correct. People also TRAVEL: a Tel Aviv person
  // works from Boston for a week, an NYC person flies to London. When the
  // colleague volunteers travel info ("I'll be in NY next week", "Boston time"),
  // OR the owner tells Maelle directly ("she's in the US that week"), we
  // capture it as a travel window. Slot search and timezone display read this
  // ahead of the default. JSON column: { location: "Boston", from: "2026-06-15",
  // until: "2026-06-22" } — both dates ISO yyyy-MM-dd in the colleague's local
  // sense. Cleared automatically once `until` is in the past.
  try { db.exec(`ALTER TABLE people_memory ADD COLUMN currently_traveling TEXT`); } catch (_) {}

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
  //
  // v2.2.1 refactor: categories are GLOBAL (30 fixed labels, shared across
  // owner and all colleagues). Topics + engagements are per-person via
  // `person_slack_id` — that way Maelle can track Idan's gaming interests
  // AND Yael's gaming interests as separate rows under the same global
  // `gaming` category row. The person_slack_id column ("owner" or a
  // colleague's Slack id) is the identity axis for all topic tracking.
  // v2.6.7 — Social Engine redesign. Old `social_topics_v2` + `social_engagements`
  // dropped (they fragmented heavily — one game produced 5+ rows because the
  // surface-string reconciler couldn't merge sub-beats). Owner accepted full
  // data reset. New schema is two tables under the existing global categories:
  //
  //   social_subjects — meaningful unit (renamed from social_topics_v2 conceptually).
  //                     One subject = one durable thing ("Clair Obscur Expedition 33").
  //
  //   social_topics   — beats under a subject. No score; just labels Sonnet uses
  //                     as hooks for codas. Cap of 10 per subject; LRU eviction.
  //
  //   social_engagements — DROPPED. The append-only log was unused by the new
  //                        feedback signal; scoring is direct on subjects.
  //
  // v4.5.9 (#198) — Social Engine redesign #2. Subjects lose their score
  // entirely: `engagement_score` (0..5, decay-driven) is gone, replaced by a
  // `status` of live|dead (repurposed from active|dormant) and a new
  // `unanswered_raises` counter — a subject dies on the reject action or
  // after 2 unanswered raises, never on a time-based decay. Category standing
  // moves per-person into the new `social_person_category_scores` table
  // (0..3, directly queryable — no more on-the-fly AVG); `social_categories`
  // stays the GLOBAL label catalog only, so `care_level`/`signals_positive`/
  // `signals_negative` (seeded, never meaningfully read at the category
  // level) are dropped too. Existing installs are migrated by
  // v4_5_9_purge_work_subjects.ts (five named work-shaped rows removed first)
  // then v4_5_9_social_category_scores.ts (backfills the new table from the
  // old engagement_score, clamped to the new 3 ceiling, then drops the
  // superseded columns) — both idempotent, no-ops on a fresh install, which
  // gets the shape below directly.
  try { db.exec(`DROP TABLE IF EXISTS social_topics_v2`); } catch (_) {}
  try { db.exec(`DROP TABLE IF EXISTS social_engagements`); } catch (_) {}

  db.exec(`
    -- Global fixed list of 30 top-level interest categories. Seeded once on
    -- startup; no runtime creation. Shared across owner + colleagues. Carries
    -- no per-person state — see social_person_category_scores for that.
    CREATE TABLE IF NOT EXISTS social_categories (
      id                TEXT PRIMARY KEY,
      owner_user_id     TEXT NOT NULL DEFAULT 'global',
      label             TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_user_id, label)
    );
    CREATE INDEX IF NOT EXISTS idx_social_categories_owner ON social_categories(owner_user_id);

    -- Per-(owner, person, category) standing, 0..3. Directly queryable — no
    -- runtime aggregation. The global category catalog above is unaffected;
    -- this sits alongside it, one row per person who has ever engaged with
    -- that category.
    CREATE TABLE IF NOT EXISTS social_person_category_scores (
      id                TEXT PRIMARY KEY,
      owner_user_id     TEXT NOT NULL,
      person_slack_id   TEXT NOT NULL,
      category_id       TEXT NOT NULL,
      score             INTEGER NOT NULL DEFAULT 0,   -- 0..3
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_user_id, person_slack_id, category_id)
    );
    CREATE INDEX IF NOT EXISTS idx_social_person_cat_scores_person
      ON social_person_category_scores(person_slack_id, category_id);

    -- Subjects: meaningful unit, live|dead (no score). Per-(owner, person, category).
    -- Created on first mention by either side; LLM classifier merges sub-beats
    -- of the same subject (no Jaccard hack). Cap 5 active per (person, category)
    -- with lowest-priority eviction. Dies on the reject action or after 2
    -- unanswered raises (unanswered_raises) — no time-based decay.
    CREATE TABLE IF NOT EXISTS social_subjects (
      id                TEXT PRIMARY KEY,
      owner_user_id     TEXT NOT NULL,
      person_slack_id   TEXT NOT NULL,
      category_id       TEXT NOT NULL,
      label             TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'live',           -- live | dead
      unanswered_raises INTEGER NOT NULL DEFAULT 0,             -- dies at 2
      last_touched_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_touched_by   TEXT NOT NULL DEFAULT 'owner',          -- owner | colleague | assistant
      last_assistant_initiated_at TEXT,                         -- when assistant last raised this (NULL = never raised since last cleared)
      created_by        TEXT NOT NULL DEFAULT 'owner',
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      summary           TEXT                                     -- accumulating merged summary (~1800-char cap enforced in code); NULL = no summary yet
    );
    CREATE INDEX IF NOT EXISTS idx_social_subjects_person ON social_subjects(person_slack_id, status);
    CREATE INDEX IF NOT EXISTS idx_social_subjects_owner_person ON social_subjects(owner_user_id, person_slack_id);
    CREATE INDEX IF NOT EXISTS idx_social_subjects_cat ON social_subjects(category_id);
    CREATE INDEX IF NOT EXISTS idx_social_subjects_raised ON social_subjects(person_slack_id, last_assistant_initiated_at DESC);

    -- Topic-beats: lightweight under-subject hooks. No score. Cap 10/subject
    -- with LRU eviction (last_used_at ASC). Sonnet uses these as concrete
    -- things to talk about when crafting a coda for the chosen subject.
    CREATE TABLE IF NOT EXISTS social_topics (
      id            TEXT PRIMARY KEY,
      subject_id    TEXT NOT NULL,
      label         TEXT NOT NULL,
      sentiment     TEXT NOT NULL DEFAULT 'neutral',   -- positive | negative | neutral
      created_by    TEXT NOT NULL DEFAULT 'owner',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_social_topics_subject ON social_topics(subject_id);
    CREATE INDEX IF NOT EXISTS idx_social_topics_lru ON social_topics(subject_id, last_used_at);

    -- v4.5.9 (#198, gh#198-LIB-6, "answer 19") — persists classifyTurn's
    -- existing per-turn kind ('task' | 'social') per thread, so the
    -- end-of-chat reconciler (capturePass.ts) can consult a deterministic
    -- code-side signal before writing a social_subjects row. This is NOT a
    -- new LLM call (classifyTurn already runs on every interactive turn) and
    -- NOT a keyword blocklist — it just gives the reconciler's create branch
    -- something durable to read back. A thread with had_social_turn=0 blocks
    -- subject creation outright regardless of the reconciler's own verdict.
    -- New table (no prior data) — no migration/backfill needed.
    CREATE TABLE IF NOT EXISTS social_thread_turn_kind (
      thread_ts       TEXT PRIMARY KEY,
      had_social_turn INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // v4.5.9 (#198) upgrade path for installs that already had social_subjects
  // before this redesign: add the new column, remap the repurposed `status`
  // values. Both idempotent — additive column is a no-op once present; the
  // remap matches nothing once no 'active'/'dormant' rows remain (including
  // every fresh install, which is created with 'live' directly above).
  try { db.exec(`ALTER TABLE social_subjects ADD COLUMN unanswered_raises INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
  try {
    db.prepare(`UPDATE social_subjects SET status = 'live' WHERE status = 'active'`).run();
    db.prepare(`UPDATE social_subjects SET status = 'dead' WHERE status = 'dormant'`).run();
  } catch (_) {}

  // Subject-memory summary (item 3, 2026-08-16) — accumulating merged summary per subject,
  // written by the existing reconciliation Haiku call (no new LLM call).
  // Nullable, no default, no backfill: absent reads as "no summary yet"
  // everywhere by design. Additive column is a no-op once present, including
  // every fresh install (which gets it straight from the CREATE TABLE above).
  try { db.exec(`ALTER TABLE social_subjects ADD COLUMN summary TEXT`); } catch (_) {}

  // Slot holds (#30) — a tentative reservation on a slot someone picked but
  // hasn't confirmed (or the owner explicitly parked). Internal state ONLY,
  // never an Outlook event. Read on the hot slot-finder path to annotate a held
  // time; expires at min(2 owner-workdays, slot-start) via the 5-min tick
  // (sweepExpiredSlotHolds → release + DM the holder). Dedicated table, NOT the
  // requests spine: the spine models work awaiting someone's action (nudge,
  // notify, close, reconcile) — a hold blocks nobody, it's a passive
  // reservation, and forcing it onto the spine would create a degenerate row
  // that the spine's reconcile/retention/notification machinery has to learn
  // to ignore.
  db.exec(`
    CREATE TABLE IF NOT EXISTS slot_holds (
      id               TEXT PRIMARY KEY,
      owner_user_id    TEXT NOT NULL,
      holder_slack_id  TEXT,                                   -- internal holder; NULL for an owner-parked external
      holder_name      TEXT NOT NULL,
      subject          TEXT,                                   -- what the hold is for ("Simon 1:1")
      start_iso        TEXT NOT NULL,
      end_iso          TEXT NOT NULL,
      origin_channel   TEXT,                                   -- where to DM the holder on release
      origin_thread_ts TEXT,
      reason           TEXT,
      status           TEXT NOT NULL DEFAULT 'active',         -- active | released | expired
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at       TEXT NOT NULL,                          -- min(2 owner-workdays, slot-start)
      closure_reason   TEXT,
      closed_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_slot_holds_owner_status ON slot_holds(owner_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_slot_holds_holder ON slot_holds(holder_slack_id, status);
    CREATE INDEX IF NOT EXISTS idx_slot_holds_expiry ON slot_holds(status, expires_at);
  `);

  // Wipe per-owner category rows so the global-scope seed is canonical.
  // Safe — the global seed re-creates the 30 labels immediately.
  try {
    db.prepare(`DELETE FROM social_categories WHERE owner_user_id != 'global'`).run();
  } catch (_) {}

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

  // Issue #59 — per-routine skip notification opt-in
  try { db.exec(`ALTER TABLE routines ADD COLUMN notify_on_skip INTEGER NOT NULL DEFAULT 0`); } catch (_) {}

  // v1.5.1 — tasks spawned by routines are deduped by (routine_id, due_at)
  // so the materializer can't insert the same firing twice. Filtered index so
  // one-off tasks (routine_id IS NULL) aren't constrained.
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_routine_due ON tasks(routine_id, due_at) WHERE routine_id IS NOT NULL`); } catch (_) {}

  // v1.6.0 — skill_origin: which skill created this task. Used for briefings,
  // filters, and "which skill is responsible for X" questions. Nullable for
  // legacy rows.
  try { db.exec(`ALTER TABLE tasks ADD COLUMN skill_origin TEXT`); } catch (_) {}

  // v2.9.3 (#103) — end-of-chat capture pass tracking. The background loop
  // scans conversation_threads for DMs where the last message landed ≥30 min
  // ago AND captured_at is older than the last message — those threads are
  // treated as "session complete, ready for capture". A Haiku pass extracts
  // structured facts and writes to people_memory + the colleague's md file.
  // NULL = never captured.
  try { db.exec(`ALTER TABLE conversation_threads ADD COLUMN captured_at TEXT`); } catch (_) {}

  // Calendar issues (v3.0.3 — full redesign).
  //
  // One row per cluster of linked events. Clusters form via shared overlap
  // edges: events linked by an overlap issue belong to the same cluster.
  // Each cluster has ONE row with ONE class — the highest-priority issue
  // detected for that cluster (the rest are dropped; moving the anchor
  // event resolves the cluster anyway, slot finder handles the rest).
  //
  // Statuses:
  //   new            — detected, not yet surfaced to owner
  //   awaiting_owner — surfaced, waiting on owner's reply
  //   in_progress    — owner said "fix it", a request is in flight
  //   owner_side     — owner said "I'll handle it"
  //   approved       — owner said "leave it"        (terminal)
  //   dismissed      — Maelle decided to drop it    (terminal, reserved)
  //   resolved       — issue is gone (cascade/auto) (terminal)
  //
  // Priority (highest→lowest):
  //   work_on_day_off > oof_with_meetings > overlap > category_limit >
  //   missing_floating_block > busy_day
  //
  // UNIQUE on (owner_user_id, event_id, axis) — anchor event + axis is the
  // row's identity. Cluster membership shifts (anchor can change) so app
  // logic merges via cluster lookup on event_id OR peer_event_id
  // intersection, scoped to one axis at a time (db/calendarIssues.ts
  // QUESTION_ONLY_CLASSES / axisFor).
  //
  // calendar-issues-schema-lacks-axis-column — the axis column was ADDED to
  // the UNIQUE constraint (was just (owner_user_id, event_id)). Before this,
  // a day-shape problem (conflict axis) and a "which category?" question
  // (question axis) on the SAME event could never both hold a row — the
  // second insert hit the constraint and upsertCluster had to catch it,
  // diagnose which axis actually collided, and no-op rather than risk
  // erasing the other axis's row (see the collision comment in
  // upsertCluster — that whole class of risk needed the schema fix, not
  // another catch branch). Existing DBs are migrated by
  // db/migrations/v4_5_3_calendar_issues_axis.ts, which backfills axis from
  // issue_class and rebuilds the table (SQLite can't ALTER a UNIQUE
  // constraint in place).
  //
  // event_end_ms is the freshness anchor: rows with event_end_ms < now() are
  // filtered out at read time (past issues vanish naturally). Exception: a
  // STATED "don't auto-fix this again" dismissal writes
  // db/calendarIssues.ts's DISMISSAL_NEVER_EXPIRES sentinel instead of a real
  // timestamp, so it can't go stale when the same event is later rescheduled
  // (gh#180) — see that constant's comment.
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_issues (
      id              TEXT PRIMARY KEY,
      owner_user_id   TEXT NOT NULL,
      event_id        TEXT NOT NULL,          -- anchor event (Graph id, or
                                              -- floating-block synthetic
                                              -- '{NNN}-{MMDDYYYY}-{HHMM}')
      peer_event_id   TEXT,                   -- only when issue_class='overlap'
      event_date      TEXT NOT NULL,          -- YYYY-MM-DD owner-local
      event_end_ms    INTEGER NOT NULL,       -- epoch ms; max(anchor, peer)
      issue_class     TEXT NOT NULL,          -- work_on_day_off | oof_with_meetings
                                              -- | overlap | category_limit
                                              -- | missing_floating_block | busy_day
                                              -- | missing_category
      axis            TEXT NOT NULL DEFAULT 'conflict',  -- 'conflict' | 'question'
                                              -- — derived from issue_class,
                                              -- see db/calendarIssues.ts axisFor()
      status          TEXT NOT NULL DEFAULT 'new',
      notes           TEXT,
      request_id      TEXT,                   -- FK to requests.id when in_progress
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (owner_user_id, event_id, axis)
    );
    CREATE INDEX IF NOT EXISTS idx_cal_issues_active
      ON calendar_issues(owner_user_id, status, event_end_ms);
    CREATE INDEX IF NOT EXISTS idx_cal_issues_peer
      ON calendar_issues(owner_user_id, peer_event_id);
    CREATE INDEX IF NOT EXISTS idx_cal_issues_request
      ON calendar_issues(request_id);
  `);

  // Legacy table from pre-v3.0.3 ('calendar_dismissed_issues'). The redesign
  // truncated all rows (owner direction: clean start) and the old API is no
  // longer wired. Drop the table when running against an old DB so the old
  // schema can't be accidentally written to. Idempotent (no-op if absent).
  try { db.exec(`DROP TABLE IF EXISTS calendar_dismissed_issues`); } catch (_) {}

  // ── Approvals — REMOVED (v3.4.6 spine collapse) ──────────────────────────────
  // Approvals are requests now (core/requests/, db/requests.ts). The legacy
  // `approvals` table has no reader or writer left; the DROP above (see the
  // v3.4.6 note near the top of initSchema) cleans it off older DBs. Nothing
  // recreates it — leave no dead storage.

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

  // ── v2.7.0 — requests (the spine) ─────────────────────────────────────────
  // Single source of truth for every user-facing work item: approvals,
  // outreach, reminders, coord, research. Replaces the tasks/approvals/
  // coord_jobs/outreach_jobs four-table mess. Lifecycle timers live on the
  // row itself (next_check_at / next_check_handler) — no separate dispatch
  // table for one-shot expiries.
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id                       TEXT PRIMARY KEY,
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now')),

      owner_user_id            TEXT NOT NULL,
      initiated_by             TEXT NOT NULL,
      initiated_by_role        TEXT NOT NULL,   -- 'owner' | 'colleague' | 'system'

      parent_request_id        TEXT,            -- NULL for top-level

      kind                     TEXT NOT NULL,   -- 'approval' | 'outreach' | 'reminder' | 'follow_up' | 'research' | 'social_outreach'
      subkind                  TEXT,            -- 'policy_exception' | 'meeting_reschedule' | etc.
      subject                  TEXT NOT NULL,
      description              TEXT,

      state                    TEXT NOT NULL,   -- 'awaiting_owner' | 'awaiting_colleague' | 'in_flight' | 'resolved' | 'cancelled' | 'expired' | 'logged'
      state_changed_at         TEXT NOT NULL DEFAULT (datetime('now')),
      closure_reason           TEXT,
      closed_at                TEXT,
      closed_by                TEXT,            -- 'owner' | 'scanner' | 'expiry' | 'meeting_cascade' | 'colleague_reply' | 'system' | 'brief'

      informed                 INTEGER NOT NULL DEFAULT 0,
      surfaced_count           INTEGER NOT NULL DEFAULT 0,
      last_surfaced_at         TEXT,

      expires_at               TEXT,
      next_check_at            TEXT,
      next_check_handler       TEXT,

      requester_slack_id       TEXT,
      requester_name           TEXT,
      target_slack_id          TEXT,
      target_email             TEXT,
      target_name              TEXT,

      origin_channel           TEXT,
      origin_thread_ts         TEXT,
      origin_is_mpim           INTEGER NOT NULL DEFAULT 0,

      owner_dm_channel         TEXT,
      owner_dm_thread_ts       TEXT,
      terminal_dm_msg_ts       TEXT,

      idempotency_key          TEXT UNIQUE,

      outcome_external_event_id TEXT,
      outcome_json             TEXT,

      details_json             TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_requests_owner_state ON requests(owner_user_id, state);
    CREATE INDEX IF NOT EXISTS idx_requests_parent ON requests(parent_request_id);
    CREATE INDEX IF NOT EXISTS idx_requests_next_check ON requests(next_check_at);
    CREATE INDEX IF NOT EXISTS idx_requests_terminal_msg ON requests(terminal_dm_msg_ts);
    CREATE INDEX IF NOT EXISTS idx_requests_thread ON requests(origin_thread_ts);
    CREATE INDEX IF NOT EXISTS idx_requests_outcome_event ON requests(outcome_external_event_id);
    CREATE INDEX IF NOT EXISTS idx_requests_target ON requests(target_slack_id, state);

    -- Owner daily decision thread (v3.4.6). One thread per owner per day,
    -- lazily created by the first approval; all of that day's owner-facing asks
    -- nest under it. day_key = getEffectiveToday (honors day_boundary_hour).
    CREATE TABLE IF NOT EXISTS owner_daily_threads (
      owner_user_id          TEXT NOT NULL,
      day_key                TEXT NOT NULL,   -- ISO date of the owner's effective day
      dm_channel             TEXT NOT NULL,   -- owner DM channel id
      root_ts                TEXT NOT NULL,   -- the dated-header message ts (thread root)
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner_user_id, day_key)
    );

    -- v2.9 — venue skill: owner-curated catalog of external meeting venues
    -- (cafés, restaurants, pubs, customer offices). Populated on book whenever
    -- a non-company location lands on a calendar event. Rank 3 = offer first,
    -- 2 = offer normally (default for new venues), 1 = hidden by default.
    CREATE TABLE IF NOT EXISTS venues (
      id                TEXT PRIMARY KEY,
      owner_user_id     TEXT NOT NULL,
      name              TEXT NOT NULL,
      branch_name       TEXT,
      address           TEXT,
      area_tags         TEXT NOT NULL DEFAULT '[]',  -- JSON array
      type              TEXT,                          -- 'coffee' | 'restaurant' | 'pub' | 'park' | ...
      type_tags         TEXT NOT NULL DEFAULT '[]',  -- JSON array — refinements ('kosher', 'italian')
      phone             TEXT,
      reservation_url   TEXT,
      place_id          TEXT,                          -- Google Places place_id when available (future)
      booking_links     TEXT,                          -- JSON array of { platform, url } (future)
      notes             TEXT,
      rank              INTEGER,                       -- 1 | 2 | 3 — owner-curated
      travel_time_minutes INTEGER,                     -- one-way travel time, owner-stated (v4.7.4, #203); NULL = no override, caller falls back to its own default
      last_used_at      TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_venues_owner_type ON venues(owner_user_id, type);
    CREATE INDEX IF NOT EXISTS idx_venues_owner_rank ON venues(owner_user_id, rank);
    CREATE INDEX IF NOT EXISTS idx_venues_owner_name ON venues(owner_user_id, name);
  `);

  // ── v2.7.0 — legacy bridge columns ────────────────────────────────────────
  // outreach_jobs and coord_jobs stay as internal state machines but every row
  // gets a request_id pointing at its user-facing requests-spine row. When the
  // legacy table's status transitions to terminal, the linked request closes.
  try { db.exec(`ALTER TABLE outreach_jobs ADD COLUMN request_id TEXT`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_outreach_jobs_request ON outreach_jobs(request_id)`); } catch (_) {}

  // ── v3.1 (Path 2) — `phase`: kind-namespaced activity sub-state ───────────
  // The requests spine becomes the SINGLE source of truth for status. `state`
  // is the universal lifecycle (open/terminal + who we're blocked on). `phase`
  // carries the finer kind-specific sub-state that used to live in
  // coord_jobs.status / outreach_jobs.status — e.g. 'coord:collecting',
  // 'coord:resolving', 'coord:negotiating', 'coord:waiting_owner',
  // 'outreach:scheduled', 'outreach:awaiting_reply', 'outreach:nudged',
  // 'outreach:no_response'. The side tables keep their DATA but no longer own
  // status. Nullable — only multi-phase kinds (coord, outreach) populate it.
  try { db.exec(`ALTER TABLE requests ADD COLUMN phase TEXT`); } catch (_) {}
  // Coord/outreach status reads filter by (owner, kind, state); index it.
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_owner_kind_state ON requests(owner_user_id, kind, state)`); } catch (_) {}

  // ── v3.1 (Path 2) — `requester_notified_at`: single-notification idempotency ──
  // The request owns whether its colleague-requester has already been told the
  // outcome. Two code paths can notify (the resolver's notifyRequesterOfDecision
  // and closeMeetingArtifacts' close-loop fallback); on a resolver-driven booking
  // both used to fire → double DM. Now: whoever notifies first stamps this; the
  // other checks it and stays quiet. One field on the one table — no new gate.
  try { db.exec(`ALTER TABLE requests ADD COLUMN requester_notified_at TEXT`); } catch (_) {}

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
        AND type = 'outreach'
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
  // #52 (piece 3) — required, not optional: audit_log was the one stateful table
  // with no owner scope, and a defaulted/omitted value here would silently
  // recreate the leak it closes. Every one of the 12 call sites must supply
  // the ACTUAL owner this action belongs to — never the first-loaded profile.
  ownerUserId: string;
  action: string;
  source: string;
  actor?: string;
  target?: string;
  details?: Record<string, unknown>;
  outcome: 'success' | 'failure' | 'pending_approval';
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (owner_user_id, action, source, actor, target, details, outcome)
    VALUES (@ownerUserId, @action, @source, @actor, @target, @details, @outcome)
  `).run({
    ownerUserId: params.ownerUserId,
    action:  params.action,
    source:  params.source,
    actor:   params.actor  ?? null,
    target:  params.target ?? null,
    details: params.details ? JSON.stringify(params.details) : null,
    outcome: params.outcome,
  });
}

/**
 * Read recent audit_log entries for a specific action, within a time window.
 * Used by active-mode calendar-health to detect "owner just deleted this
 * floating block — don't re-book it" before auto-creating a missing block.
 *
 * Filters at SQL level on owner + action + outcome + timestamp (cheap,
 * indexed via idx_audit_log_owner). Returns parsed details so callers can
 * match on whatever fields they need (subject, event_start_iso, etc.).
 * Typically 0–10 rows in a normal window — no need to scan further.
 *
 * #52 (piece 3) — ownerUserId is required. Pre-fix this filtered only on
 * action+outcome+timestamp, so with a second profile configured, this
 * owner's get_calendar could narrate another owner's cancelled/created
 * meetings — the one caller (calendarReads.ts) renders these audit entries
 * straight into the model's context.
 */
export function recentAuditEntries(params: {
  ownerUserId: string;
  action: string;
  windowDays?: number;
  outcome?: 'success' | 'failure' | 'pending_approval';
}): Array<{
  id: number;
  timestamp: string;
  actor: string | null;
  target: string | null;
  details: Record<string, unknown> | null;
  outcome: string;
}> {
  const db = getDb();
  const windowDays = params.windowDays ?? 14;
  const outcome = params.outcome ?? 'success';
  const rows = db.prepare(`
    SELECT id, timestamp, actor, target, details, outcome
    FROM audit_log
    WHERE owner_user_id = @ownerUserId
      AND action = @action
      AND outcome = @outcome
      AND timestamp > datetime('now', '-' || @windowDays || ' days')
    ORDER BY id DESC
  `).all({ ownerUserId: params.ownerUserId, action: params.action, outcome, windowDays }) as Array<{
    id: number;
    timestamp: string;
    actor: string | null;
    target: string | null;
    details: string | null;
    outcome: string;
  }>;
  return rows.map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    actor: r.actor,
    target: r.target,
    details: r.details ? safeParseJson(r.details) : null,
    outcome: r.outcome,
  }));
}

function safeParseJson(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) as Record<string, unknown>; }
  catch { return null; }
}
