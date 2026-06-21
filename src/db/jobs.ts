import { getDb } from './client';
import { closeRequest } from '../core/requests/closeRequest';

// ══════════════════════════════════════════════════════════════════════════
// PATH 2 INVARIANT (v3.1.0+) — read this once, the rest of the file references it.
//
// The `requests` table is the single source of truth for lifecycle. The
// physical `coord_jobs.status` and `outreach_jobs.status` columns are
// VESTIGIAL: defaulted, never read for lifecycle decisions.
//
// • `OutreachStatus` / `CoordJob.status` remain in code ONLY as the TRANSITION
//   SIGNAL passed to create*/update* (drives the linked request + terminal
//   cascade via closeRequest). Never persisted as authoritative state.
// • All "is this open?" reads JOIN to `requests` (see getActiveCoordJobs,
//   getPendingRequestCountForColleague, getCoordLifecycle, getOutreachLifecycle).
// • Inline comments below repeat slices of this rule at each call site —
//   they're correct, just verbose. This block is the canonical reference.
// ══════════════════════════════════════════════════════════════════════════

// ── Bridge helpers (v2.7.0) ──────────────────────────────────────────────────
// Link a legacy outreach_jobs / coord_jobs row to its user-facing requests row.
// The legacy table stays as the internal state machine; the request is what
// surfaces in brief, system prompt, scanner. When the legacy row transitions
// to terminal status, updateOutreachJob / updateCoordJob (below) read the
// linked request_id and call closeRequest with the appropriate state.

export function linkOutreachToRequest(outreachId: string, requestId: string): void {
  getDb().prepare(`UPDATE outreach_jobs SET request_id = ?, updated_at = datetime('now') WHERE id = ?`).run(requestId, outreachId);
}

export function linkCoordToRequest(coordId: string, requestId: string): void {
  getDb().prepare(`UPDATE coord_jobs SET request_id = ?, updated_at = datetime('now') WHERE id = ?`).run(requestId, coordId);
}

// v3.0.8 — exported for skills/outreach.ts thread-continuity hook. Lookup
// the request_id linked to an outreach_jobs row when only jobId is in scope.
export function getLinkedRequestIdForOutreach(outreachId: string): string | null {
  const row = getDb().prepare(`SELECT request_id FROM outreach_jobs WHERE id = ?`).get(outreachId) as { request_id: string | null } | undefined;
  return row?.request_id ?? null;
}

function getLinkedRequestIdForCoord(coordId: string): string | null {
  const row = getDb().prepare(`SELECT request_id FROM coord_jobs WHERE id = ?`).get(coordId) as { request_id: string | null } | undefined;
  return row?.request_id ?? null;
}


// ── Coord vs coordination_jobs (historical) ──────────────────────────────────
// The old `coordination_jobs` single-colleague table is dropped in 1.6.0.
// All coord flows go through `coord_jobs` (multi-participant) below.
// `getPendingRequestCountForColleague` kept but now queries coord_jobs only.

export function getPendingRequestCountForColleague(ownerUserId: string, colleagueSlackId: string): number {
  const db = getDb();
  // v3.1 (Path 2) — openness comes from the linked request's state, NOT
  // coord_jobs.status. coord_jobs is data; the request owns lifecycle.
  const coordJobCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM coord_jobs cj
    JOIN requests r ON cj.request_id = r.id
    WHERE cj.owner_user_id = ?
    AND r.state IN ('awaiting_owner', 'awaiting_colleague', 'in_flight')
    AND cj.participants LIKE ?
  `).get(ownerUserId, `%${colleagueSlackId}%`) as any)?.cnt ?? 0;
  return coordJobCount;
}

// ── Outreach jobs ─────────────────────────────────────────────────────────────

/**
 * v3.1 (Path 2 Stage 7) — outreach lifecycle status is NO LONGER an
 * outreach_jobs column. It lives on the linked request (state + phase).
 * `OutreachStatus` remains only as the TRANSITION SIGNAL passed to
 * createOutreachJob / updateOutreachJob (drives the request + terminal
 * cascade); never persisted. The physical `outreach_jobs.status` column is
 * vestigial (defaulted 'sent', unread).
 */
export type OutreachStatus =
  | 'sent' | 'replied' | 'no_response' | 'cancelled' | 'pending_scheduled' | 'done' | 'expired' | 'failed';

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
  // v2.1.4 — when the outreach proposed specific times to the colleague
  // and the colleague (or someone on their side) will send an invite back
  // to Idan, these fields capture enough structure for the brief verifier
  // to match incoming calendar events to this outreach. proposed_slots is
  // a JSON array of ISO timestamps (what Maelle offered). subject_keyword
  // is a short string (e.g. "bank visit" / "Privacy GTM") used to fuzzy-
  // match the calendar event subject. Both optional — legacy rows have
  // NULL and skip verification.
  proposed_slots?: string;    // JSON array of ISO strings
  subject_keyword?: string;
  // v2.1.5 — Slack ts + channel of the initial outreach DM. Used by
  // follow-up sends (confirmation after approval, relay handlers) to
  // thread back into the same DM conversation instead of creating a
  // fresh top-level DM.
  dm_message_ts?: string;
  dm_channel_id?: string;
  // v2.6.1 (D4) — DM follow-up tracking, independent of `status`. Populated
  // when the conversation around this outbound DM has closed: emoji reaction
  // on the message, thread reply, deterministic <10min match, LLM-classified
  // 10min-24h response, 24h auto-expiry, or any existing pipeline transition
  // (status → replied/done/cancelled/expired/failed via handleOutreachReply
  // / meetingReschedule / coordinator paths). The latter is auto-set inside
  // updateOutreachJob below so existing call sites don't need to be touched.
  followup_closed_at?: string;
  followup_close_reason?:
    | 'deterministic_match'
    | 'llm_response_match'
    | 'thread_reply'
    | 'emoji_ack'
    | 'auto_expired_24h'
    | 'pipeline_consumed';
  // v2.7.1 — bridge FK to the paired requests-spine row (the lifecycle owner).
  request_id?: string | null;
}

export function createOutreachJob(
  params: Omit<OutreachJob, 'id' | 'created_at' | 'updated_at'> & { status?: OutreachStatus },
): string {
  const db = getDb();
  const id = `out_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // v2.7.1 — bridge to requests spine. Every outreach_jobs row now has a
  // paired request (kind='outreach') so the brief reads from one source of
  // truth. State mapping:
  //   - scheduled_at set       → state='in_flight', next_check=send_scheduled_outreach
  //   - status='sent' + await_reply → state='awaiting_colleague'
  //   - status='sent' + !await_reply → state='resolved' (informational, no reply needed)
  //   - status='cancelled'     → state='cancelled'
  // Terminal transitions in updateOutreachJob cascade to closeRequest.
  let requestId: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const requests = require('./requests') as typeof import('./requests');
    let reqState: 'in_flight' | 'awaiting_colleague' | 'resolved' | 'cancelled' = 'awaiting_colleague';
    let nextCheckAt: string | undefined;
    let nextCheckHandler: 'send_scheduled_outreach' | 'outreach_expiry' | undefined;
    // v3.1 (Path 2) — phase carries the outreach activity sub-state ON the
    // request, so status reads never touch outreach_jobs.status.
    let phase: string | undefined;
    if (params.scheduled_at) {
      reqState = 'in_flight';
      nextCheckAt = params.scheduled_at;
      nextCheckHandler = 'send_scheduled_outreach';
      phase = 'outreach:scheduled';
    } else if (params.status === 'cancelled') {
      reqState = 'cancelled';
    } else if (params.await_reply === 0) {
      reqState = 'resolved';
    } else if (params.reply_deadline) {
      reqState = 'awaiting_colleague';
      nextCheckAt = params.reply_deadline;
      nextCheckHandler = 'outreach_expiry';
      phase = 'outreach:awaiting_reply';
    } else {
      // sent, awaiting reply, no explicit deadline yet
      phase = 'outreach:awaiting_reply';
    }
    const details: Record<string, unknown> = {
      message: params.message,
      await_reply: params.await_reply,
      sent_at: params.sent_at,
      scheduled_at: params.scheduled_at,
      intent: params.intent,
      context_json: params.context_json,
      proposed_slots: params.proposed_slots,
      subject_keyword: params.subject_keyword,
    };
    const subjectPreview = params.message.slice(0, 80).replace(/\s+/g, ' ').trim();
    const row = requests.createRequest({
      ownerUserId: params.owner_user_id,
      initiatedBy: params.owner_user_id,
      initiatedByRole: 'system',
      kind: 'outreach',
      subkind: params.intent ?? undefined,
      subject: subjectPreview || `Outreach to ${params.colleague_name}`,
      description: params.message,
      state: reqState,
      phase,
      informed: 1,  // owner-initiated outreach; he asked for it
      targetSlackId: params.colleague_slack_id,
      targetName: params.colleague_name,
      originChannel: params.owner_channel,
      originThreadTs: params.owner_thread_ts ?? undefined,
      nextCheckAt,
      nextCheckHandler,
      details,
    });
    requestId = row.id;
  } catch (err) {
    // Bridge failure is non-fatal. Legacy row still writes; brief will miss
    // this one until next deploy. Log loudly so we catch the regression.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const logger = require('../utils/logger').default;
    logger.warn('createOutreachJob — requests bridge threw, legacy row only', {
      err: String(err).slice(0, 200), colleague: params.colleague_name,
    });
  }

  // v3.1 (Path 2 Stage 7) — `status` not persisted (column defaults 'sent',
  // vestigial). Lifecycle is the linked request; params.status above is the
  // transition signal that set reqState/phase/next_check.
  db.prepare(`
    INSERT INTO outreach_jobs (
      id, owner_user_id, owner_channel, owner_thread_ts,
      colleague_slack_id, colleague_name, colleague_tz, message, await_reply,
      sent_at, reply_deadline, scheduled_at, intent, context_json,
      proposed_slots, subject_keyword, request_id
    ) VALUES (
      @id, @owner_user_id, @owner_channel, @owner_thread_ts,
      @colleague_slack_id, @colleague_name, @colleague_tz, @message, @await_reply,
      @sent_at, @reply_deadline, @scheduled_at, @intent, @context_json,
      @proposed_slots, @subject_keyword, @request_id
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
    sent_at: params.sent_at ?? null,
    reply_deadline: params.reply_deadline ?? null,
    scheduled_at: params.scheduled_at ?? null,
    intent: params.intent ?? null,
    context_json: params.context_json ?? null,
    proposed_slots: params.proposed_slots ?? null,
    subject_keyword: params.subject_keyword ?? null,
    request_id: requestId,
  });
  return id;
}

export function updateOutreachJob(id: string, updates: Partial<OutreachJob> & { status?: OutreachStatus }): void {
  const db = getDb();
  // v3.1 (Path 2 Stage 7) — `status` is a transition SIGNAL (drives the linked
  // request + terminal cascade below), never persisted to outreach_jobs.
  const dataKeys = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at' && k !== 'status');
  if (dataKeys.length > 0) {
    const fields = dataKeys.map(k => `${k} = @${k}`).join(', ');
    const params: Record<string, unknown> = { id };
    for (const k of dataKeys) params[k] = (updates as Record<string, unknown>)[k] ?? null;
    db.prepare(`UPDATE outreach_jobs SET ${fields}, updated_at = datetime('now') WHERE id = @id`).run(params);
  }

  // v2.6.1 (D4) — when status transitions to terminal via the existing
  // pipelines (handleOutreachReply, meetingReschedule, outreachExpiry,
  // outreachDecision, etc.) ALSO close followup_closed_at if not already
  // set. Without this, the existing reply pipeline consumes the outreach
  // (status → replied) but the D4 followup tracker stays open, and a
  // SECOND inbound DM from the same colleague would falsely match the
  // already-consumed row. Idempotent — preserves existing
  // followup_close_reason if D4's own paths already closed it.
  const terminalForFollowup = (() => {
    switch (updates.status) {
      case 'replied':
      case 'done':
      case 'cancelled':
      case 'expired':
      case 'failed':
        return true;
      default:
        return false;
    }
  })();
  if (terminalForFollowup) {
    db.prepare(`
      UPDATE outreach_jobs
      SET followup_closed_at = COALESCE(followup_closed_at, datetime('now')),
          followup_close_reason = COALESCE(followup_close_reason, 'pipeline_consumed')
      WHERE id = ?
    `).run(id);
  }

  // v2.2.4 — defensive linked-task closure. Every outreach has a parent task
  // created by message_colleague (skill_origin='outreach', skill_ref=jobId).
  // When the outreach reaches a terminal status, the parent task should
  // follow. Most call sites already do this explicitly (closeFireAndForget,
  // the outreach reply pipeline), but newer paths (verifier-driven 'done',
  // outreach_decision auto-close) didn't — leaving stranded pending tasks
  // that the v2.2.4 tasks-first brief would re-surface forever. Idempotent:
  // tasks already in a terminal state won't be touched (the IN clause
  // narrows it). Cancellation paths cancel the task; success paths complete.
  const terminalTask = (() => {
    switch (updates.status) {
      case 'done':
      case 'replied':
        return 'completed';
      case 'cancelled':
      case 'expired':
      case 'failed':
        return 'cancelled';
      default:
        return null;
    }
  })();
  if (terminalTask) {
    if (terminalTask === 'completed') {
      db.prepare(
        `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
         WHERE skill_ref = ? AND status IN ('new','in_progress','pending_colleague','pending_owner')`
      ).run(id);
    } else {
      db.prepare(
        `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
         WHERE skill_ref = ? AND status IN ('new','in_progress','pending_colleague','pending_owner')`
      ).run(id);
    }

    // v2.7.0 — bridge to requests spine. When the legacy outreach_job
    // transitions to terminal, close the linked request row too so the brief
    // narrates closure cleanly. Reason carries the legacy status verbatim
    // so audit can trace which path closed it.
    const linkedRequestId = getLinkedRequestIdForOutreach(id);
    if (linkedRequestId) {
      const requestState: 'resolved' | 'cancelled' | 'expired' =
        updates.status === 'replied' || updates.status === 'done' ? 'resolved'
        : updates.status === 'expired' ? 'expired'
        : 'cancelled';
      try {
        closeRequest({
          id: linkedRequestId,
          state: requestState,
          closureReason: `outreach_${updates.status}`,
          closedBy: updates.status === 'replied' ? 'colleague_reply' : 'system',
        });
      } catch (_) { /* non-fatal */ }
    }
  }

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

/**
 * All active outreach jobs for a colleague — used by the bare-reply matcher
 * to decide whether a reply is about an existing outreach or a new request,
 * and to disambiguate when more than one is active.
 *
 * v3.1 (Path 2 Stage 7) — "active" comes from the linked request's open state
 * (awaiting_colleague), NOT outreach_jobs.status. The job row supplies DATA;
 * the request owns lifecycle.
 */
export function getOutreachJobsByColleague(
  colleagueSlackId: string,
  ownerUserId: string
): OutreachJob[] {
  const db = getDb();
  return db.prepare(`
    SELECT oj.* FROM outreach_jobs oj
    JOIN requests r ON oj.request_id = r.id
    WHERE oj.colleague_slack_id = ? AND oj.owner_user_id = ?
    AND oj.await_reply = 1
    AND r.state = 'awaiting_colleague'
    AND oj.created_at >= datetime('now', '-7 days')
    ORDER BY oj.created_at DESC
  `).all(colleagueSlackId, ownerUserId) as OutreachJob[];
}

// v3.1 (Path 2 Stage 6/7) — getExpiredOutreachJobs / closeFireAndForgetOutreach
// / getScheduledOutreachJobs / getOutreachJobByColleague were REMOVED. Their
// timing is now the spine sweep (send_scheduled_outreach / outreach_expiry on
// the request); fire-and-forget closes via createOutreachJob setting the
// request to 'resolved' on await_reply=0. No status-keyed outreach sweeps remain.

/**
 * v3.1 (Path 2 Stage 7) — outreach lifecycle from its linked request (the
 * single source of truth). Replaces reads of the retired outreach_jobs.status.
 */
export function getOutreachLifecycle(outreachJobId: string): {
  requestState: string | null; phase: string | null; terminal: boolean;
} {
  const reqId = getLinkedRequestIdForOutreach(outreachJobId);
  if (!reqId) return { requestState: null, phase: null, terminal: false };
  const row = getDb().prepare(`SELECT state, phase FROM requests WHERE id = ?`).get(reqId) as
    { state?: string; phase?: string } | undefined;
  const state = row?.state ?? null;
  const terminal = state === 'resolved' || state === 'cancelled' || state === 'expired';
  return { requestState: state, phase: row?.phase ?? null, terminal };
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

/**
 * v3.1 (Path 2 Stage 7) — coord lifecycle status is NO LONGER a coord_jobs
 * column. It lives on the linked request (state + phase). `CoordStatus` remains
 * only as the TRANSITION SIGNAL passed to updateCoordJob (which drives the
 * request + the terminal cascade) — it is never persisted to coord_jobs. The
 * physical `coord_jobs.status` column is vestigial (defaulted, unread).
 */
export type CoordStatus =
  | 'collecting' | 'resolving' | 'negotiating' | 'waiting_owner'
  | 'confirmed' | 'booked' | 'cancelled' | 'abandoned';

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

  // v3.1 (Path 2) — coord_jobs is now a DATA table. It does NOT create a
  // request. The orchestrating layer (initiateCoordination) owns the single
  // coord request (kind='coord') and calls linkCoordToRequest(jobId, reqId)
  // immediately after. Pre-v3.1 this function ALSO bridged a request, and
  // initiateCoordination created a SECOND one and re-linked — leaving the
  // bridge's request orphaned forever (the i3kb2 ghost). One request per
  // coord now, owned upstream. request_id starts NULL, set by the link call.
  const requestId: string | null = null;

  // v3.1 (Path 2 Stage 7) — `status` no longer written; the column defaults to
  // 'collecting' (vestigial). The coord's lifecycle is the request, whose phase
  // is set to 'coord:collecting' by initiateCoordination right after this.
  db.prepare(`
    INSERT INTO coord_jobs (
      id, owner_user_id, owner_channel, owner_thread_ts,
      subject, topic, duration_min, proposed_slots, participants, notes, last_calendar_check,
      intent, existing_event_id, request_id
    ) VALUES (
      @id, @owner_user_id, @owner_channel, @owner_thread_ts,
      @subject, @topic, @duration_min, @proposed_slots, @participants, @notes, @last_calendar_check,
      @intent, @existing_event_id, @request_id
    )
  `).run({
    id,
    owner_user_id: params.owner_user_id,
    owner_channel: params.owner_channel,
    owner_thread_ts: params.owner_thread_ts ?? null,
    subject: params.subject,
    topic: params.topic ?? null,
    duration_min: params.duration_min,
    proposed_slots: params.proposed_slots,
    participants: params.participants,
    notes: params.notes ?? null,
    last_calendar_check: params.last_calendar_check ?? new Date().toISOString(),
    intent: params.intent ?? 'schedule',
    existing_event_id: params.existing_event_id ?? null,
    request_id: requestId,
  });
  return id;
}

/**
 * v3.1 (Path 2 Stage 7) — `status` is a TRANSITION SIGNAL, not a persisted
 * column. It drives the linked request (mid-state phase/state + terminal
 * cascade) but is filtered out of the coord_jobs write. All other keys are
 * DATA (participants, slots, winning_slot, notes, ...) and persist normally.
 */
export function updateCoordJob(
  id: string,
  updates: Partial<Omit<CoordJob, 'id' | 'created_at'>> & { status?: CoordStatus },
): void {
  const db = getDb();
  // Persist only DATA fields — never the transition signal `status`.
  const dataEntries = Object.entries(updates).filter(([k]) => k !== 'status');
  if (dataEntries.length > 0) {
    const fields = dataEntries.map(([k]) => `${k} = @${k}`).join(', ');
    const params: Record<string, unknown> = { id };
    for (const [k, v] of dataEntries) params[k] = v ?? null;
    db.prepare(`UPDATE coord_jobs SET ${fields}, updated_at = datetime('now') WHERE id = @id`).run(params);
  }

  // v2.7.2 — mid-state cascade to the linked request. When coord_jobs.status
  // transitions WITHOUT being terminal (terminal is handled below by the
  // existing closeRequest cascade), reflect the lifecycle stage on the
  // request so the brief + system-prompt awaiting-owner block read truth.
  //   waiting_owner  → request.state='awaiting_owner'  (owner must pick a slot)
  //   collecting / negotiating / resolving → request.state='in_flight'
  // Safety: skip if the linked request is already terminal — never re-open
  // a closed row from a stale coord_jobs update.
  if (updates.status === 'waiting_owner'
      || updates.status === 'collecting'
      || updates.status === 'negotiating'
      || updates.status === 'resolving') {
    const linkedRequestId = getLinkedRequestIdForCoord(id);
    if (linkedRequestId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const requests = require('./requests') as typeof import('./requests');
        const reqRow = requests.getRequest(linkedRequestId);
        if (reqRow && reqRow.state !== 'resolved' && reqRow.state !== 'cancelled' && reqRow.state !== 'expired') {
          // v3.1 (Path 2) — carry BOTH the lifecycle state and the coord
          // activity phase onto the request. state drives brief/prompt/routing;
          // phase is the finer dance. collecting/negotiating = waiting on
          // participants (awaiting_colleague); resolving = Maelle working
          // (in_flight); waiting_owner = owner must pick (awaiting_owner).
          const newState: 'awaiting_owner' | 'awaiting_colleague' | 'in_flight' =
            updates.status === 'waiting_owner' ? 'awaiting_owner'
            : updates.status === 'resolving' ? 'in_flight'
            : 'awaiting_colleague';  // collecting | negotiating
          const newPhase = `coord:${updates.status}`;
          const patch: { state?: typeof newState; phase?: string } = { phase: newPhase };
          if (reqRow.state !== newState) patch.state = newState;
          requests.updateRequest(linkedRequestId, patch);
        }
      } catch (_) { /* non-fatal */ }
    }
  }

  // v3.4.6 (spine collapse) — the legacy "sync coord-terminal → approvals
  // table" block that lived here is GONE. The approvals table is dropped;
  // the linked spine REQUEST is closed by the terminal cascade below
  // (getLinkedRequestIdForCoord → closeRequest), which is the single invariant
  // now. The approval_expiry/approval_reminder TASK cancel was also dead (those
  // task types no longer exist — approval timing is on the spine).
  const terminal = updates.status;
  if (terminal === 'booked' || terminal === 'cancelled' || terminal === 'abandoned') {
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
          // v3.1 (Path 2 fix) — close the sibling outreach REQUESTS, not just
          // the vestigial outreach_jobs.status. Pre-fix this flipped a dead
          // column and the sibling requests stayed awaiting_colleague → the
          // brief kept re-surfacing "still waiting on X" after the coord
          // booked (the v2.0.6 "three open Amazia threads" regression). Find
          // the still-open sibling outreach via their linked request and close
          // each through closeRequest (which clears its next_check timer too).
          const siblingReqs = db.prepare(`
            SELECT oj.request_id AS request_id FROM outreach_jobs oj
            JOIN requests r ON oj.request_id = r.id
            WHERE oj.colleague_slack_id IN (${placeholders})
              AND r.state IN ('awaiting_owner', 'awaiting_colleague', 'in_flight')
              AND datetime(oj.created_at) >= datetime('now', '-14 days')
          `).all(...siblingSlackIds) as Array<{ request_id: string | null }>;
          let closed = 0;
          for (const { request_id } of siblingReqs) {
            if (!request_id) continue;
            try {
              closeRequest({ id: request_id, state: 'resolved', closureReason: `sibling_coord_${terminal}`, closedBy: 'system' });
              closed++;
            } catch (_) { /* non-fatal */ }
          }
          if (closed > 0) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const logger = require('../utils/logger').default;
            logger.info('updateCoordJob — closed sibling outreach requests', {
              coordId: id, terminal, closed, colleagues: siblingSlackIds,
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

    // v2.2.4 — defensive linked-task closure on the COORD's parent task.
    // Every coord has a parent task (skill_origin='meetings', type='coordination',
    // skill_ref=jobId). The cancelled path of cancelOrphanCoordJobs already
    // cancels its task, and bookCoordination explicitly completes the task on
    // success. Mirror those here so any future code path that flips status
    // through updateCoordJob (without remembering the explicit task update)
    // still keeps the spine clean. Idempotent — already-terminal tasks won't
    // match the IN clause.
    if (terminal === 'booked') {
      db.prepare(
        `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
         WHERE skill_ref = ? AND type = 'coordination'
         AND status IN ('new','in_progress','pending_colleague','pending_owner')`
      ).run(id);
    } else if (terminal === 'cancelled' || terminal === 'abandoned') {
      db.prepare(
        `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
         WHERE skill_ref = ? AND type = 'coordination'
         AND status IN ('new','in_progress','pending_colleague','pending_owner')`
      ).run(id);
    }

    // v2.7.0 — bridge to requests spine. When the coord legacy row reaches
    // terminal, close the linked request too. booked → resolved (with
    // outcome_external_event_id stamped from updates if present);
    // cancelled / abandoned → cancelled.
    const linkedRequestId = getLinkedRequestIdForCoord(id);
    if (linkedRequestId) {
      const requestState: 'resolved' | 'cancelled' = terminal === 'booked' ? 'resolved' : 'cancelled';
      try {
        closeRequest({
          id: linkedRequestId,
          state: requestState,
          closureReason: `coord_${terminal}`,
          closedBy: terminal === 'booked' ? 'owner' : 'system',
          outcomeExternalEventId: (updates as any).external_event_id ?? undefined,
        });
      } catch (_) { /* non-fatal */ }
    }
  }
}

export function getCoordJob(id: string): CoordJob | null {
  const db = getDb();
  return db.prepare('SELECT * FROM coord_jobs WHERE id = ?').get(id) as CoordJob | null;
}

/** v3.1 (Path 2 Stage 6) — fetch a coord_job's DATA by its linked request id.
 * Used by the spine timer handlers (coord_nudge/coord_abandon) which receive a
 * request row and need the participant/slot data that lives in coord_jobs. */
export function getCoordJobByRequestId(requestId: string): CoordJob | null {
  const db = getDb();
  return db.prepare('SELECT * FROM coord_jobs WHERE request_id = ?').get(requestId) as CoordJob | null;
}

/**
 * v3.1 (Path 2 Stage 7) — the coord's lifecycle, read from its linked request
 * (the single source of truth). Replaces reads of the retired coord_jobs.status
 * column. `terminal` = the coord is done (booked→resolved or cancelled/abandoned
 * →cancelled/expired); `phase` carries the fine sub-state (coord:waiting_owner
 * etc.); `booked` distinguishes a successful booking from a cancel/abandon.
 */
export function getCoordLifecycle(coordJobId: string): {
  requestState: string | null; phase: string | null; terminal: boolean; booked: boolean;
} {
  const reqId = getLinkedRequestIdForCoord(coordJobId);
  if (!reqId) return { requestState: null, phase: null, terminal: false, booked: false };
  const row = getDb().prepare(`SELECT state, phase FROM requests WHERE id = ?`).get(reqId) as
    { state?: string; phase?: string } | undefined;
  const state = row?.state ?? null;
  const terminal = state === 'resolved' || state === 'cancelled' || state === 'expired';
  return { requestState: state, phase: row?.phase ?? null, terminal, booked: state === 'resolved' };
}

export function getActiveCoordJobs(ownerUserId: string): CoordJob[] {
  const db = getDb();
  // v3.1 (Path 2) — "active" = linked request still open, OR booked with a
  // future winning_slot (request resolved but meeting hasn't happened yet —
  // surfaced so get_active_coordinations can still show it). Status read off
  // the request; winning_slot is coord_jobs data.
  return db.prepare(`
    SELECT cj.* FROM coord_jobs cj
    JOIN requests r ON cj.request_id = r.id
    WHERE cj.owner_user_id = ?
    AND (
      r.state IN ('awaiting_owner', 'awaiting_colleague', 'in_flight')
      OR (r.state = 'resolved' AND cj.winning_slot IS NOT NULL AND cj.winning_slot > datetime('now'))
    )
    ORDER BY cj.created_at DESC
  `).all(ownerUserId) as CoordJob[];
}

/**
 * Cancel all active coordination jobs for the same owner + subject, EXCEPT the given jobId.
 * Also marks their linked task rows as cancelled.
 */
export function cancelOrphanCoordJobs(ownerUserId: string, subject: string, exceptJobId: string): void {
  const db = getDb();
  // v3.1 (Path 2) — find orphans by their linked request's open state, not
  // coord_jobs.status. Route cancellation through updateCoordJob so the FULL
  // terminal cascade fires (closes the linked request, cancels tasks, cleans
  // sibling outreach). Pre-v3.1 this UPDATE'd coord_jobs.status directly,
  // bypassing the cascade and orphaning the linked request — a ghost source.
  const orphans = db.prepare(`
    SELECT cj.id FROM coord_jobs cj
    JOIN requests r ON cj.request_id = r.id
    WHERE cj.owner_user_id = ?
    AND cj.subject = ?
    AND cj.id != ?
    AND r.state IN ('awaiting_owner', 'awaiting_colleague', 'in_flight')
  `).all(ownerUserId, subject, exceptJobId) as { id: string }[];

  for (const { id } of orphans) {
    updateCoordJob(id, { status: 'cancelled' });
  }
}

/**
 * Find the active coordination job for a given participant.
 * Returns ALL matching jobs if multiple exist (for disambiguation).
 */
export function getCoordJobsByParticipant(slackId: string, ownerUserId: string): CoordJob[] {
  const db = getDb();
  // v3.1 (Path 2) — open coords come from the linked request's state.
  const jobs = db.prepare(`
    SELECT cj.* FROM coord_jobs cj
    JOIN requests r ON cj.request_id = r.id
    WHERE cj.owner_user_id = ?
    AND r.state IN ('awaiting_owner', 'awaiting_colleague', 'in_flight')
    ORDER BY cj.created_at DESC
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
  // v3.1 (Path 2) — "still collecting" is the request's phase, not
  // coord_jobs.status.
  const jobs = db.prepare(`
    SELECT cj.* FROM coord_jobs cj
    JOIN requests r ON cj.request_id = r.id
    WHERE r.phase = 'coord:collecting'
    AND r.state IN ('awaiting_colleague', 'in_flight')
    AND cj.created_at <= datetime('now', '-3 hours')
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
