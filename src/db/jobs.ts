import { getDb } from './client';
import { closeRequest } from '../core/requests/closeRequest';

// ══════════════════════════════════════════════════════════════════════════
// PATH 2 INVARIANT (v3.1.0+) — read this once, the rest of the file references it.
//
// The `requests` table is the single source of truth for lifecycle. The
// physical `outreach_jobs.status` column is VESTIGIAL: defaulted, never read
// for lifecycle decisions.
//
// • `OutreachStatus` remains in code ONLY as the TRANSITION SIGNAL passed to
//   createOutreachJob/updateOutreachJob (drives the linked request + terminal
//   cascade via closeRequest). Never persisted as authoritative state.
// • All "is this open?" reads JOIN to `requests` (see getOutreachLifecycle).
// • Inline comments below repeat slices of this rule at each call site —
//   they're correct, just verbose. This block is the canonical reference.
// ══════════════════════════════════════════════════════════════════════════

// ── Bridge helpers (v2.7.0) ──────────────────────────────────────────────────
// v3.0.8 — exported for skills/outreach.ts thread-continuity hook. Lookup
// the request_id linked to an outreach_jobs row when only jobId is in scope.
export function getLinkedRequestIdForOutreach(outreachId: string): string | null {
  const row = getDb().prepare(`SELECT request_id FROM outreach_jobs WHERE id = ?`).get(outreachId) as { request_id: string | null } | undefined;
  return row?.request_id ?? null;
}

// v3.5.x — reverse lookup: the outreach detail row for a spine request. Used by
// the reschedule_reask spine handler to re-ping the colleague from the request's
// timer (mirrors getCoordJobByRequestId). Reads the existing request_id column —
// no new state.
export function getOutreachJobByRequestId(requestId: string): OutreachJob | null {
  return getDb().prepare(`SELECT * FROM outreach_jobs WHERE request_id = ?`).get(requestId) as OutreachJob | null;
}

// Count open requests where this colleague is the requester or target — used by
// the colleague rate-limit gate (max 2 pending requests per colleague). Reads
// the requests spine (the lifecycle owner), independent of any side table.
export function getPendingRequestCountForColleague(ownerUserId: string, colleagueSlackId: string): number {
  const db = getDb();
  const count = (db.prepare(`
    SELECT COUNT(*) as cnt FROM requests
    WHERE owner_user_id = ?
    AND state IN ('awaiting_owner', 'awaiting_colleague', 'in_flight')
    AND (requester_slack_id = ? OR target_slack_id = ?)
  `).get(ownerUserId, colleagueSlackId, colleagueSlackId) as any)?.cnt ?? 0;
  return count;
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
