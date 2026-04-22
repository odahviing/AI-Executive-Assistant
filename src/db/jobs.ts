import { getDb } from './client';

// ── Coord vs coordination_jobs (historical) ──────────────────────────────────
// The old `coordination_jobs` single-colleague table is dropped in 1.6.0.
// All coord flows go through `coord_jobs` (multi-participant) below.
// `getPendingRequestCountForColleague` kept but now queries coord_jobs only.

export function getPendingRequestCountForColleague(ownerUserId: string, colleagueSlackId: string): number {
  const db = getDb();
  const coordJobCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM coord_jobs
    WHERE owner_user_id = ?
    AND status IN ('collecting', 'resolving', 'negotiating', 'waiting_owner')
    AND participants LIKE ?
  `).get(ownerUserId, `%${colleagueSlackId}%`) as any)?.cnt ?? 0;
  return coordJobCount;
}

// ── Outreach jobs ─────────────────────────────────────────────────────────────

export interface OutreachJob {
  id: string;
  created_at: string;
  updated_at: string;
  owner_user_id: string;
  owner_channel: string;
  owner_thread_ts?: string;
  colleague_slack_id: string;
  colleague_name: string;
  colleague_tz?: string;
  message: string;
  scheduled_at?: string;  // if set, do not send until this datetime
  await_reply: number;
  status: 'sent' | 'replied' | 'no_response' | 'cancelled' | 'pending_scheduled';
  reply_text?: string;
  sent_at?: string;
  reply_deadline?: string;
  conversation_json?: string;  // JSON array of {role:'maelle'|'colleague', text:string}
  // v1.8.4 — intent routing. When set, the outreach reply dispatcher routes
  // the colleague's reply to the registered handler for this intent (instead
  // of just surfacing the reply to the owner). context_json carries
  // intent-specific payload (e.g. { meeting_id, proposed_start, proposed_end }
  // for 'meeting_reschedule'). Optional — legacy rows have both NULL and
  // fall through to the default "report reply to owner" behavior.
  intent?: string;
  context_json?: string;
}

export function createOutreachJob(params: Omit<OutreachJob, 'id' | 'created_at' | 'updated_at'>): string {
  const db = getDb();
  const id = `out_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO outreach_jobs (
      id, owner_user_id, owner_channel, owner_thread_ts,
      colleague_slack_id, colleague_name, colleague_tz, message, await_reply, status,
      sent_at, reply_deadline, scheduled_at, intent, context_json
    ) VALUES (
      @id, @owner_user_id, @owner_channel, @owner_thread_ts,
      @colleague_slack_id, @colleague_name, @colleague_tz, @message, @await_reply, @status,
      @sent_at, @reply_deadline, @scheduled_at, @intent, @context_json
    )
  `).run({
    id,
    owner_user_id: params.owner_user_id,
    owner_channel: params.owner_channel,
    owner_thread_ts: params.owner_thread_ts ?? null,
    colleague_slack_id: params.colleague_slack_id,
    colleague_name: params.colleague_name,
    colleague_tz: params.colleague_tz ?? null,
    message: params.message,
    await_reply: params.await_reply,
    status: params.status,
    sent_at: params.sent_at ?? null,
    reply_deadline: params.reply_deadline ?? null,
    scheduled_at: params.scheduled_at ?? null,
    intent: params.intent ?? null,
    context_json: params.context_json ?? null,
  });
  return id;
}

export function updateOutreachJob(id: string, updates: Partial<OutreachJob>): void {
  const db = getDb();
  const fields = Object.keys(updates)
    .filter(k => k !== 'id' && k !== 'created_at')
    .map(k => `${k} = @${k}`)
    .join(', ');
  if (!fields) return;
  const params: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(updates)) params[k] = v ?? null;
  db.prepare(`UPDATE outreach_jobs SET ${fields}, updated_at = datetime('now') WHERE id = @id`).run(params);

  // v1.6.9 — terminal-state history. When an outreach resolves (replied /
  // no_response), write past-tense history to the colleague's
  // interaction_log so Maelle remembers "we talked about X last week" in
  // future conversations. We do NOT write on 'sent' (in-flight) or
  // 'cancelled' (purge / owner cancel — not worth remembering).
  const terminal = updates.status;
  if (terminal === 'replied' || terminal === 'no_response') {
    try {
      const job = db.prepare(
        `SELECT colleague_slack_id, colleague_name, message, reply_text FROM outreach_jobs WHERE id = ?`
      ).get(id) as { colleague_slack_id: string; colleague_name: string; message: string; reply_text?: string | null } | undefined;
      if (job && job.colleague_slack_id) {
        const existing = db.prepare(
          `SELECT interaction_log FROM people_memory WHERE slack_id = ?`
        ).get(job.colleague_slack_id) as { interaction_log: string } | undefined;
        if (existing) {
          const today = new Date().toISOString().slice(0, 10);
          const msgPreview = (job.message || '').slice(0, 140);
          let summary = '';
          if (terminal === 'replied') {
            const replyPreview = (job.reply_text || '').slice(0, 140);
            summary = `Exchange: sent "${msgPreview}" → replied: "${replyPreview}".`;
          } else {
            summary = `Reached out ("${msgPreview}") — no response after follow-ups.`;
          }
          let log: Array<{ date: string; type: string; summary: string }> = [];
          try { log = JSON.parse(existing.interaction_log || '[]'); } catch (_) {}
          log.push({
            date: today,
            type: terminal === 'replied' ? 'message_sent' : 'message_sent',
            summary,
          });
          db.prepare(
            `UPDATE people_memory SET interaction_log = ?, updated_at = datetime('now') WHERE slack_id = ?`
          ).run(JSON.stringify(log), job.colleague_slack_id);
        }
      }
    } catch (_) { /* non-fatal */ }
  }
}

export function getOutreachJobByColleague(
  colleagueSlackId: string,
  ownerUserId: string
): OutreachJob | null {
  const db = getDb();
  // Include 'no_response' so replies that arrive after the deadline timer fires are still processed.
  // The 7-day window prevents ancient jobs from accidentally swallowing unrelated messages.
  return db.prepare(`
    SELECT * FROM outreach_jobs
    WHERE colleague_slack_id = ? AND owner_user_id = ?
    AND await_reply = 1
    AND status IN ('sent', 'no_response')
    AND created_at >= datetime('now', '-7 days')
    ORDER BY created_at DESC LIMIT 1
  `).get(colleagueSlackId, ownerUserId) as OutreachJob | null;
}

/**
 * All active outreach jobs for a colleague — used by the bare-reply matcher
 * to decide whether a reply is about an existing outreach or a new request,
 * and to disambiguate when more than one is active.
 */
export function getOutreachJobsByColleague(
  colleagueSlackId: string,
  ownerUserId: string
): OutreachJob[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM outreach_jobs
    WHERE colleague_slack_id = ? AND owner_user_id = ?
    AND await_reply = 1
    AND status IN ('sent', 'no_response')
    AND created_at >= datetime('now', '-7 days')
    ORDER BY created_at DESC
  `).all(colleagueSlackId, ownerUserId) as OutreachJob[];
}

export function getExpiredOutreachJobs(): OutreachJob[] {
  const db = getDb();
  // Expire if: deadline passed OR sent more than 3 days ago with no reply
  return db.prepare(`
    SELECT * FROM outreach_jobs
    WHERE status = 'sent' AND await_reply = 1
    AND (
      (reply_deadline IS NOT NULL AND datetime(reply_deadline) <= datetime('now'))
      OR sent_at <= datetime('now', '-3 days')
    )
  `).all() as OutreachJob[];
}

/**
 * Auto-close outreach jobs that don't await a reply.
 * These are "fire and forget" — the message was sent, nothing to wait for.
 * Also marks their linked task as done.
 */
export function closeFireAndForgetOutreach(): number {
  const db = getDb();
  const jobs = db.prepare(`
    SELECT id FROM outreach_jobs
    WHERE status = 'sent' AND await_reply = 0
    AND sent_at <= datetime('now', '-5 minutes')
  `).all() as { id: string }[];

  for (const { id } of jobs) {
    db.prepare(`UPDATE outreach_jobs SET status = 'replied', updated_at = datetime('now') WHERE id = ?`).run(id);
    db.prepare(
      `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE skill_ref = ? AND status IN ('new','in_progress','pending_colleague')`
    ).run(id);
  }
  return jobs.length;
}

export function getScheduledOutreachJobs(): OutreachJob[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM outreach_jobs
    WHERE status = 'pending_scheduled'
    AND scheduled_at IS NOT NULL
    AND datetime(scheduled_at) <= datetime('now')
    ORDER BY scheduled_at ASC
  `).all() as OutreachJob[];
}

// ── Meeting coordination ─────────────────────────────────────────────────────

export interface CoordParticipant {
  slack_id?: string;         // absent for just_invite participants
  name: string;
  tz: string;
  email?: string;
  just_invite?: boolean;     // true = add to calendar invite only, no DM, no vote
  response?: 'yes' | 'no' | 'maybe' | null;
  preferred_slot?: string;
  responded_at?: string;
  dm_sent_at?: string;
  contacted_via?: 'dm' | 'group';  // 'group' = options posted in the MPIM thread, 'dm' = private DM
  group_channel?: string;           // channel ID of the MPIM when contacted_via='group'
  group_thread_ts?: string;         // thread ts in the MPIM when contacted_via='group'
  // v1.8.6 — for contacted_via='dm', the DM channel ID and the ts of Maelle's
  // initial coord DM (which becomes the thread root for the participant's
  // replies). Used to post follow-ups — including the final booking
  // confirmation — back into the same thread instead of as a new top-level DM.
  dm_channel?: string;
  dm_thread_ts?: string;
}

export interface CoordJob {
  id: string;
  created_at: string;
  updated_at: string;
  owner_user_id: string;
  owner_channel: string;
  owner_thread_ts?: string;
  subject: string;
  topic?: string;
  duration_min: number;
  status: 'collecting' | 'resolving' | 'negotiating' | 'waiting_owner' | 'confirmed' | 'booked' | 'cancelled' | 'abandoned';
  proposed_slots: string;   // JSON string
  participants: string;     // JSON string
  winning_slot?: string;
  notes?: string;
  last_calendar_check?: string;
  // Follow-up / abandon tracking (Bug 1B)
  last_participant_activity_at?: string;  // ISO — most recent participant DM or ack
  follow_up_sent_at?: string;              // ISO — when we pinged stale non-responders
  abandoned_at?: string;                   // ISO — when we auto-closed
  // v1.5 — approvals-era fields
  requesters?: string;                     // JSON array of { slack_id, name? } — colleagues who asked for this coord
  external_event_id?: string;              // Graph event id once booked — idempotency guard
  request_signature?: string;              // hash(subject, participants, day) — dedupe across duplicate asks
  // v2.1.1 — MOVE intent. When intent='move', the terminal booking step
  // calls moveMeeting on existing_event_id instead of createMeeting.
  // DM phrasing to participants also branches on intent.
  intent?: 'schedule' | 'move';
  existing_event_id?: string;              // set only when intent='move'
}

export function createCoordJob(params: Omit<CoordJob, 'id' | 'created_at' | 'updated_at'>): string {
  const db = getDb();
  const id = `coord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO coord_jobs (
      id, owner_user_id, owner_channel, owner_thread_ts,
      subject, topic, duration_min, status, proposed_slots, participants, notes, last_calendar_check,
      intent, existing_event_id
    ) VALUES (
      @id, @owner_user_id, @owner_channel, @owner_thread_ts,
      @subject, @topic, @duration_min, @status, @proposed_slots, @participants, @notes, @last_calendar_check,
      @intent, @existing_event_id
    )
  `).run({
    id,
    owner_user_id: params.owner_user_id,
    owner_channel: params.owner_channel,
    owner_thread_ts: params.owner_thread_ts ?? null,
    subject: params.subject,
    topic: params.topic ?? null,
    duration_min: params.duration_min,
    status: params.status,
    proposed_slots: params.proposed_slots,
    participants: params.participants,
    notes: params.notes ?? null,
    last_calendar_check: params.last_calendar_check ?? new Date().toISOString(),
    intent: params.intent ?? 'schedule',
    existing_event_id: params.existing_event_id ?? null,
  });
  return id;
}

export function updateCoordJob(id: string, updates: Partial<Omit<CoordJob, 'id' | 'created_at'>>): void {
  const db = getDb();
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  if (!fields) return;
  const params: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(updates)) params[k] = v ?? null;
  db.prepare(`UPDATE coord_jobs SET ${fields}, updated_at = datetime('now') WHERE id = @id`).run(params);

  // v1.6.2 — whenever a coord reaches a terminal state, sync its approvals to
  // a matching terminal state in the same transaction. This is THE single
  // invariant for "coord done → approvals resolved". Every call site that
  // booked / abandoned / cancelled a coord previously had to remember to
  // resolve its approvals; forgetting produced orphans that re-nagged the
  // owner after the meeting was already on the calendar. Now: impossible to
  // forget — updateCoordJob is the only gate.
  const terminal = updates.status;
  if (terminal === 'booked' || terminal === 'cancelled' || terminal === 'abandoned') {
    const newApprovalStatus =
      terminal === 'booked' ? 'approved'
      : 'superseded';  // cancelled | abandoned both mean "not acting on this approval"
    const pending = db.prepare(
      `SELECT id FROM approvals WHERE skill_ref = ? AND status = 'pending'`
    ).all(id) as { id: string }[];
    for (const a of pending) {
      db.prepare(`
        UPDATE approvals
        SET status = @status,
            decision_json = COALESCE(decision_json, @decision_json),
            responded_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: a.id,
        status: newApprovalStatus,
        decision_json: JSON.stringify({
          auto_synced: true,
          coord_terminal_status: terminal,
          winning_slot: (updates as any).winning_slot ?? null,
          external_event_id: (updates as any).external_event_id ?? null,
        }),
      });
      // Also cancel the approval_expiry follow-up task so it doesn't re-fire
      // and DM the owner "you never got back to me" after the thing is done.
      db.prepare(`
        UPDATE tasks
        SET status = 'cancelled', updated_at = datetime('now')
        WHERE type = 'approval_expiry'
          AND skill_ref = @approval_id
          AND status IN ('new','scheduled','in_progress','pending_owner')
      `).run({ approval_id: a.id });
    }

    // v1.6.9 — write terminal-state history to each key participant's
    // interaction_log. This is legitimate past-tense history ("we booked
    // Subject for Thursday", "we tried to coord Subject, it didn't happen")
    // — NOT in-flight state. Writes fire only at terminal transitions
    // (booked / cancelled / abandoned) so the log stays clean of churning
    // status. Safe to read in formatPeopleMemoryForPrompt without filters.
    try {
      const job = db.prepare(
        `SELECT subject, duration_min, participants, winning_slot FROM coord_jobs WHERE id = ?`
      ).get(id) as { subject: string; duration_min: number; participants: string; winning_slot?: string } | undefined;
      if (job) {
        let participants: Array<{ slack_id?: string; name?: string; just_invite?: boolean }> = [];
        try { participants = JSON.parse(job.participants || '[]'); } catch (_) {}

        const today = new Date().toISOString().slice(0, 10);
        let summary = '';
        if (terminal === 'booked') {
          const slot = (updates as any).winning_slot || job.winning_slot;
          const slotLabel = slot
            ? (() => {
                try { return new Date(slot).toISOString().replace('T', ' ').slice(0, 16); }
                catch { return slot; }
              })()
            : '';
          summary = `Booked meeting "${job.subject}"${slotLabel ? ` for ${slotLabel}` : ''} (${job.duration_min} min).`;
        } else if (terminal === 'cancelled') {
          summary = `Tried to set up "${job.subject}" — was cancelled before booking.`;
        } else if (terminal === 'abandoned') {
          summary = `Tried to set up "${job.subject}" — didn't get a response, closed it out.`;
        }

        if (summary) {
          const interactionType = terminal === 'booked' ? 'meeting_booked' : 'conversation';
          for (const p of participants) {
            if (!p.slack_id || p.just_invite) continue;
            try {
              const existing = db.prepare(
                `SELECT interaction_log FROM people_memory WHERE slack_id = ?`
              ).get(p.slack_id) as { interaction_log: string } | undefined;
              if (!existing) continue;  // don't auto-create rows here; only log on known contacts
              let log: Array<{ date: string; type: string; summary: string }> = [];
              try { log = JSON.parse(existing.interaction_log || '[]'); } catch (_) {}
              log.push({ date: today, type: interactionType, summary });
              db.prepare(
                `UPDATE people_memory SET interaction_log = ?, updated_at = datetime('now') WHERE slack_id = ?`
              ).run(JSON.stringify(log), p.slack_id);
            } catch (err) {
              // Non-fatal — the coord terminal transition itself already committed
            }
          }
        }
      }
    } catch (_) { /* non-fatal */ }

    // v2.0.7 — close sibling outreach_jobs. When a coord books (or hits
    // cancelled/abandoned), any outreach_job with the SAME colleague_slack_id
    // in the last 14 days that's still waiting on a reply is a zombie — the
    // conversation has moved on via the coord. Previously those rows lingered
    // as `no_response` / `sent` / `replied+await_reply=0` and the morning
    // brief kept re-surfacing them (the "three open Amazia threads" bug from
    // v2.0.6). Auto-close to `done` with a note pointing back at the coord
    // so the audit trail stays traversable.
    try {
      const coordRow = db.prepare(
        `SELECT participants FROM coord_jobs WHERE id = ?`
      ).get(id) as { participants: string } | undefined;
      if (coordRow) {
        let siblingSlackIds: string[] = [];
        try {
          const parts = JSON.parse(coordRow.participants || '[]') as Array<{ slack_id?: string; just_invite?: boolean }>;
          siblingSlackIds = parts
            .filter(p => p.slack_id && !p.just_invite)
            .map(p => p.slack_id!) as string[];
        } catch (_) {}
        if (siblingSlackIds.length > 0) {
          const placeholders = siblingSlackIds.map(() => '?').join(',');
          const info = db.prepare(`
            UPDATE outreach_jobs
            SET status = 'done',
                updated_at = datetime('now')
            WHERE colleague_slack_id IN (${placeholders})
              AND status IN ('sent', 'no_response', 'replied')
              AND datetime(created_at) >= datetime('now', '-14 days')
          `).run(...siblingSlackIds);
          if (info.changes > 0) {
            // Also cancel any outreach_expiry / outreach_decision follow-up
            // tasks still pending for these jobs so they don't DM the owner
            // "X hasn't replied" after the coord already booked.
            db.prepare(`
              UPDATE tasks
              SET status = 'cancelled',
                  updated_at = datetime('now')
              WHERE type IN ('outreach_expiry', 'outreach_decision')
                AND status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague')
                AND skill_ref IN (
                  SELECT id FROM outreach_jobs
                  WHERE colleague_slack_id IN (${placeholders})
                )
            `).run(...siblingSlackIds);
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const logger = require('../utils/logger').default;
            logger.info('updateCoordJob — closed sibling outreach_jobs', {
              coordId: id,
              terminal,
              closed: info.changes,
              colleagues: siblingSlackIds,
            });
          }
        }
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const logger = require('../utils/logger').default;
      logger.warn('updateCoordJob sibling-outreach cleanup threw — non-fatal', {
        err: String(err), coordId: id,
      });
    }
  }
}

export function getCoordJob(id: string): CoordJob | null {
  const db = getDb();
  return db.prepare('SELECT * FROM coord_jobs WHERE id = ?').get(id) as CoordJob | null;
}

export function getActiveCoordJobs(ownerUserId: string): CoordJob[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM coord_jobs
    WHERE owner_user_id = ?
    AND (
      status IN ('collecting', 'resolving', 'negotiating', 'waiting_owner')
      OR (status = 'booked' AND winning_slot > datetime('now'))
    )
    ORDER BY created_at DESC
  `).all(ownerUserId) as CoordJob[];
}

/**
 * Cancel all active coordination jobs for the same owner + subject, EXCEPT the given jobId.
 * Also marks their linked task rows as cancelled.
 */
export function cancelOrphanCoordJobs(ownerUserId: string, subject: string, exceptJobId: string): void {
  const db = getDb();
  const orphans = db.prepare(`
    SELECT id FROM coord_jobs
    WHERE owner_user_id = ?
    AND subject = ?
    AND id != ?
    AND status IN ('collecting', 'resolving', 'negotiating', 'waiting_owner')
  `).all(ownerUserId, subject, exceptJobId) as { id: string }[];

  for (const { id } of orphans) {
    db.prepare(`UPDATE coord_jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(id);
    db.prepare(`UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE skill_ref = ?`).run(id);
  }
}

/**
 * Find the active coordination job for a given participant.
 * Returns ALL matching jobs if multiple exist (for disambiguation).
 */
export function getCoordJobsByParticipant(slackId: string, ownerUserId: string): CoordJob[] {
  const db = getDb();
  const jobs = db.prepare(`
    SELECT * FROM coord_jobs
    WHERE owner_user_id = ?
    AND status IN ('collecting', 'resolving', 'negotiating', 'waiting_owner')
    ORDER BY created_at DESC
  `).all(ownerUserId) as CoordJob[];

  return jobs.filter(j => {
    const participants = JSON.parse(j.participants) as CoordParticipant[];
    return participants.some(p => !p.just_invite && p.slack_id === slackId);
  });
}

/**
 * Returns coordination jobs in 'collecting' status where at least one key participant
 * was DM'd 3+ hours ago and hasn't responded yet.
 */
export function getStaleCoordJobs(): CoordJob[] {
  const db = getDb();
  const jobs = db.prepare(`
    SELECT * FROM coord_jobs
    WHERE status = 'collecting'
    AND created_at <= datetime('now', '-3 hours')
  `).all() as CoordJob[];

  return jobs.filter(job => {
    const participants = JSON.parse(job.participants) as CoordParticipant[];
    return participants.some(p =>
      !p.just_invite &&
      p.dm_sent_at &&
      new Date(p.dm_sent_at).getTime() <= Date.now() - 3 * 60 * 60 * 1000 &&
      (p.response === null || p.response === undefined)
    );
  });
}
