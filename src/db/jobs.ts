import { getDb } from './client';
import { closeRequest } from '../core/requests/closeRequest';

// ══════════════════════════════════════════════════════════════════════════
// ONE SPINE (#41, owner ruling 2026-07-26 — "only one spine") — read this once.
//
// `outreach_jobs` is PAYLOAD. The linked `requests` row is the LIFECYCLE, and it
// is the only thing that answers "is this outreach still open?" — state, phase,
// timers, what the brief and the rate-limiter read. Every open/closed question in
// this codebase now goes through the two spine-backed readers below
// (`getActiveOutreachForThread`, `getOpenRescheduleOutreach`) or
// `getOutreachJobsByColleague`.
//
// There is NO `outreach_jobs.status` column any more. It reached zero readers and
// zero writers and was then physically dropped by the idempotent migration in
// db/client.ts (right after the outreach_jobs ADD COLUMN list). Do NOT re-add it:
// a value nothing reads is the second lifecycle #41 exists to kill, and a stale one
// invites the next reader to trust it.
//
// WHY it could never have been that answer — proven on disk 2026-07-26, not
// inferred. A row was born at the SQL default 'sent' and only a cascade ever moved
// it. But `createOutreachJob` creates a FIRE-AND-FORGET outreach
// (`await_reply === 0`) with its request already `resolved`, so closeRequest never
// ran on it and the cascade never fired: 12 rows sat at 'sent' with a resolved
// request and `closed_at IS NULL`. A further 86 rows predated the bridge and carried
// `request_id` NULL, so nothing could ever close them at all. Counted before the
// drop: the old thread filter (`status NOT IN ('replied','cancelled','no_response')`)
// matched 70 rows, and the old reschedule filter (`status IN ('sent','no_response',
// 'replied')`) matched 2 — while the number with an actually-open request was ZERO.
// The spine has no such gap: born-resolved is resolved, and no request means no work
// item. The last reader was calendarHealth's reschedule-ping dedup
// (`intent='meeting_reschedule' AND status='sent'`, INVERTED polarity: a match
// SUPPRESSES the overlap autofix); it moved to `getOpenRescheduleOutreach(ownerUserId)`
// filtered to the event id (skills/calendarHealth/handlers/checkHealth.ts:929-930 —
// live before/after: old probe 1 row, spine reader 0, and that 1 row was the
// un-closeable request_id-NULL row that suppressed the autofix for its event forever).
// With it gone the two cascade writes went too, in reader-then-writer order:
// closeFollowup's 'replied' (connectors/slack/recentOutboundContext.ts) and
// closeRequest's 'cancelled' (core/requests/closeRequest.ts).
//
// `OutreachTransition` (the TS type) is the TRANSITION SIGNAL passed to
// createOutreachJob / updateOutreachJob — it picks the linked request's state and
// drives the terminal cascade. It is not a second lifecycle and neither function
// persists it (nothing could now: there is no column to persist it to).
//
// Conversational follow-up closure is a different question with its own field —
// `followup_closed_at` (recentOutboundContext.ts) — and never touched status.
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
//
// EXCLUDES subkind IN ('freeform_owner_flag', 'freeform_owner_ask') (bouncer
// fix, pending-cap-blocks-unrelated-questions, 2026-08-10, widened
// gh#194-b-promised-resend-never-fired x pending-cap-blocks-unrelated-questions):
// those rows are minted by two DIFFERENT backstops — runOutputGates.ts's
// claim-checker relay backstop (an unconfirmed "I told him" relay claim,
// subkind='freeform_owner_flag') and tasks/skill.ts's
// `flagUnresolvedFreeformForOwner` (an ambiguous freeform ask that can't be
// confidently routed, subkind='freeform_owner_ask' as of chris-kelley-oof-
// block-c round 3, 2026-08-18 — split from the shared value once it proved
// NOT unique enough for the latter's own dedup lookup, getLatestFreeformOwnerFlag,
// to tell the two backstops' rows apart) — both durable DMs to the owner
// that must fire regardless of the colleague's own pending count (R3: each
// exists precisely to stop a drop, so neither can itself be the thing that
// gets dropped). Counting either here would silently eat a genuine slot of
// the colleague's quota for something they never asked to have tracked.
export function getPendingRequestCountForColleague(ownerUserId: string, colleagueSlackId: string): number {
  const db = getDb();
  const count = (db.prepare(`
    SELECT COUNT(*) as cnt FROM requests
    WHERE owner_user_id = ?
    AND state IN ('awaiting_owner', 'awaiting_colleague', 'in_flight')
    AND (requester_slack_id = ? OR target_slack_id = ?)
    AND NOT (kind = 'reminder' AND (subkind IS 'freeform_owner_flag' OR subkind IS 'freeform_owner_ask'))
  `).get(ownerUserId, colleagueSlackId, colleagueSlackId) as any)?.cnt ?? 0;
  return count;
}

// ── Outreach jobs ─────────────────────────────────────────────────────────────

/**
 * Outreach LIFECYCLE lives on the linked request (state + phase), never on this
 * type. This is the TRANSITION SIGNAL passed to createOutreachJob /
 * updateOutreachJob: it picks the request's birth state and drives the terminal
 * cascade, and neither function persists it — the physical column is gone (see the
 * ONE SPINE block at the top of this file).
 *
 * These four are the only values any caller passes — verified by grep
 * 2026-08-18, with two changes since the 2026-07-26 baseline:
 * (1) gh#daniel-sharabi-decisive-reply-stuck-in-continue-loop, 2026-08-17 —
 * connectors/slack/coordinator.ts's OLD two 'replied' sites (its
 * no-routed-intent path unconditionally classifying done/continue/schedule
 * and closing on 'done'/'schedule') are GONE; `handleOutreachReply`'s
 * generic no-routed-intent branch now re-arms the request's reply-deadline
 * instead of transitioning outreach_jobs at all.
 * (2) round 2, same day — that removal left a real gap (a reply that
 * resolves the ask in the SAME turn had nothing to close it), so
 * coordinator.ts grew ONE NEW, GATED 'replied' site instead:
 * `closeOutreachReplyIfResolvedThisTurn` (coordinator.ts:390, called by
 * processMessage.ts after the orchestrator turn finishes), which transitions
 * ONLY when that turn produced genuine resolving evidence (a calendar
 * mutation, a booking, or a fresh approval) — every other reply still takes
 * the re-arm path from (1). So coordinator.ts is NOT a zero-producer site;
 * it is a conditional one.
 * Current producers: 'sent' (tasks/dispatchers/summaryActionFollowup.ts:166,
 * skills/meetingReschedule.ts:591, core/requests/colleagueOofReengage.ts:386,
 * skills/outreach.ts:286 — the isFuture ternary there also produces
 * 'pending_scheduled', so it belongs in both lists),
 * 'pending_scheduled' (skills/outreach.ts:286), 'replied' (several sites in
 * skills/meetingReschedule.ts, core/requests/colleagueOofReengage.ts:617, and
 * coordinator.ts:390 above), 'cancelled' (skills/outreach.ts:378,388,513,
 * skills/meetingReschedule.ts:616, core/requests/colleagueOofReengage.ts:402,607).
 * The old union also carried 'done', 'expired', 'failed' and 'no_response' with
 * ZERO producers — the branches keyed on them were unreachable and went with the
 * column.
 */
export type OutreachTransition = 'sent' | 'pending_scheduled' | 'replied' | 'cancelled';

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
  // v2.6.1 — DM follow-up tracking, independent of the request's lifecycle.
  // Populated when the conversation around this outbound DM has closed: emoji
  // reaction on the message, thread reply, LLM-classified <24h response, 24h
  // auto-expiry, or a terminal transition signal ('replied' / 'cancelled' via
  // handleOutreachReply / meetingReschedule / coordinator paths). The latter
  // is auto-set inside updateOutreachJob below so existing call sites don't
  // need to be touched.
  //
  // v2.6.2 (gh#176/#177) — 'deterministic_match' (<10min, no classifier) is
  // GONE: it matched on colleague identity alone, so a second unrelated topic
  // from the same colleague inside that window misattached and closed the
  // wrong outbound. Every <24h inbound is now classified (recentOutboundContext.ts).
  followup_closed_at?: string;
  followup_close_reason?:
    | 'llm_response_match'
    | 'thread_reply'
    | 'emoji_ack'
    | 'auto_expired_24h'
    | 'pipeline_consumed';
  // v2.7.1 — bridge FK to the paired requests-spine row (the lifecycle owner).
  request_id?: string | null;
}

export function createOutreachJob(
  params: Omit<OutreachJob, 'id' | 'created_at' | 'updated_at'> & {
    status?: OutreachTransition;
    // gh#179-b follow-up — a caller that only wants findOpenOutboundsForColleague
    // to see this row (a connector-layer heuristic candidate, not a new work
    // item) sets this to skip the bridge below entirely, leaving request_id
    // NULL. Without it, EVERY outreach_jobs row mints a brand-new `requests`
    // row, and a row stamped with the SAME origin_thread_ts as an existing
    // request (resolver.ts's notifyRequesterOfDecision, relaying an
    // approve/reject/amend decision back into its own thread) becomes the
    // newest row for that thread_ts — hijacking getLatestRequestForThread
    // (db/requests.ts) into reporting THIS row's synthetic 'resolved' state
    // instead of the real request's (reject→'cancelled' reads as resolved;
    // an still-open amend→'awaiting_colleague' reads as resolved too). This
    // row never needs a lifecycle of its own — findOpenOutboundsForColleague
    // reads owner_user_id/colleague_slack_id/followup_closed_at directly off
    // outreach_jobs, no join, no request required.
    skipRequestBridge?: boolean;
    // gh#201-d — link the paired request as a CHILD of an existing request
    // (e.g. the dead-end tracking row a colleague_oof_recheck resolves into
    // an outreach). Purely for hierarchy/traceability (requests.parent_
    // request_id) — the child still gets its own full lifecycle; closing the
    // parent with skipChildren:true leaves it untouched.
    parentRequestId?: string;
    // registrar fix (scheduled-first-outreach-send-not-gated-to-recipient-
    // hours, wf_29a0d866-021 round 2) — carried through to the request's
    // `details` JSON below (never a new outreach_jobs column — this is
    // payload, not lifecycle state, R1) so a SCHEDULED send's channel post /
    // attachments survive to fire time. runSendScheduledOutreach reads them
    // back and replays the decision literally (R2) instead of the deferred
    // handler's old hardcoded conn.sendDirect(targetSlackId, message) — which
    // silently turned a scheduled "post to #product and tag Anna" into a
    // private DM, and silently dropped a scheduled attachment.
    channel_id?: string;
    channel_name?: string;
    attachments?: Array<{ sourceUrl: string; filename?: string }>;
  },
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
  // Skippable (see skipRequestBridge above) for a row that is pure connector-
  // layer signal, never a work item — request_id stays NULL, and every
  // reader that answers "is this open" for the requests spine already JOINs
  // on request_id, so a NULL row is invisible to them by construction.
  let requestId: string | null = null;
  if (!params.skipRequestBridge) try {
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
      channel_id: params.channel_id,
      channel_name: params.channel_name,
      attachments: params.attachments,
    };
    const subjectPreview = params.message.slice(0, 80).replace(/\s+/g, ' ').trim();
    // Explicit idempotency key, keyed on THIS job's own id — not the default
    // content-hash `buildIdempotencyKey` would derive from ownerUserId + kind +
    // normalizeSubject(subjectPreview). Every outreach_jobs row gets exactly one
    // paired request (1:1, no dedup semantic here — the caller, not this bridge,
    // owns "is this a genuine new send"), so there is nothing to collide on. The
    // default hash ignored the target colleague entirely and truncated the
    // message to 80 chars, so two REAL, distinct sends (e.g. two separate
    // meeting-move notices whose templated opening line is identical past
    // char 80) hashed to the same key, the second INSERT threw
    // SqliteError(UNIQUE idempotency_key), and the bridge silently degraded to
    // legacy-row-only (see catch below) — that outreach never got a requests row
    // at all. Same fix shape already used by calendarHealth/autoMove.ts
    // (`idempotencyKey: auto_move:${id}:${Date.now()}`) for the same reason: a
    // caller with its own unique per-event id builds its own key instead of
    // going through the content-hash meant for de-duplicating repeated asks.
    const row = requests.createRequest({
      ownerUserId: params.owner_user_id,
      initiatedBy: params.owner_user_id,
      initiatedByRole: 'system',
      parentRequestId: params.parentRequestId,
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
      idempotencyKey: `outreach:${id}`,
      details,
    });
    requestId = row.id;
  } catch (err) {
    // Bridge failure is non-fatal. Legacy row still writes; brief will miss
    // this one until next deploy. Log loudly so we catch the regression.
    // The idempotency_key collision that used to land here routinely (two
    // real sends whose templated message hashed to the same content-derived
    // key) can't happen any more — the key above is per-job-id, not
    // content-derived — so a throw here now means a genuine DB error, not a
    // benign duplicate.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const logger = require('../utils/logger').default;
    logger.warn('createOutreachJob — requests bridge threw, legacy row only', {
      err: String(err).slice(0, 200), colleague: params.colleague_name,
    });
  }

  // There is no `status` column to insert — openness is read off the linked
  // request (top-of-file). `params.status` above is the transition signal that
  // picked reqState/phase/next_check, and it stops there.
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

export function updateOutreachJob(id: string, updates: Partial<OutreachJob> & { status?: OutreachTransition }): void {
  const db = getDb();
  // `status` here is a transition SIGNAL: it drives the linked request + the
  // terminal cascade below and is never written anywhere. The filter below is now
  // LOAD-BEARING, not just tidy: the physical column is gone (#41, db/client.ts),
  // so letting `status` through would build `SET status = @status` and throw
  // "no such column: status" on every terminal transition.
  const dataKeys = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at' && k !== 'status');
  if (dataKeys.length > 0) {
    const fields = dataKeys.map(k => `${k} = @${k}`).join(', ');
    const params: Record<string, unknown> = { id };
    for (const k of dataKeys) params[k] = (updates as Record<string, unknown>)[k] ?? null;
    db.prepare(`UPDATE outreach_jobs SET ${fields}, updated_at = datetime('now') WHERE id = @id`).run(params);
  }

  // v2.6.1 — when the transition signal is terminal (via handleOutreachReply,
  // meetingReschedule, the coordinator relay, or a failed send) ALSO close
  // followup_closed_at if not already set. Without this, the reply pipeline consumes
  // the outreach but the followup tracker stays open, and a SECOND inbound DM from
  // the same colleague would falsely match the already-consumed row. Idempotent —
  // preserves an existing followup_close_reason if the tracker's own paths closed it.
  const isTerminal = updates.status === 'replied' || updates.status === 'cancelled';
  if (isTerminal) {
    db.prepare(`
      UPDATE outreach_jobs
      SET followup_closed_at = COALESCE(followup_closed_at, datetime('now')),
          followup_close_reason = COALESCE(followup_close_reason, 'pipeline_consumed')
      WHERE id = ?
    `).run(id);

    // v2.7.0 — bridge to requests spine. When the legacy outreach_job
    // transitions to terminal, close the linked request row too so the brief
    // narrates closure cleanly. Reason carries the legacy status verbatim
    // so audit can trace which path closed it.
    //
    // v4.2.x — the v2.2.4 `UPDATE tasks ... WHERE skill_ref = <jobId>` pair that
    // used to run first is gone with the row it closed. message_colleague no
    // longer mints a per-send `tasks` row, so nothing links a task to an outreach
    // job and closing the request IS the closure — it is what the brief,
    // get_my_tasks and the thread-context injection all read.
    const linkedRequestId = getLinkedRequestIdForOutreach(id);
    if (linkedRequestId) {
      const requestState: 'resolved' | 'cancelled' =
        updates.status === 'replied' ? 'resolved' : 'cancelled';
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

  // v1.6.9 — terminal-state history. When an outreach gets a reply, write
  // past-tense history to the colleague's interaction_log so Maelle remembers "we
  // talked about X last week" in future conversations. We do NOT write on 'sent' /
  // 'pending_scheduled' (in-flight) or 'cancelled' (purge / owner cancel — not
  // worth remembering).
  //
  // #41: this used to have a second arm for a 'no_response' signal, which no caller
  // has ever passed since outreach expiry became a spine timer — the expiry path
  // closes the REQUEST directly (core/requests/runner.ts, closureReason
  // 'outreach_no_response') and never calls this function. So a
  // "reached out, never heard back" line is not written today. That is a real gap in
  // people-memory, but filling it belongs on the spine's expiry path, not on a dead
  // branch here.
  if (updates.status === 'replied') {
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
          const replyPreview = (job.reply_text || '').slice(0, 140);
          const summary = `Exchange: sent "${msgPreview}" → replied: "${replyPreview}".`;
          let log: Array<{ date: string; type: string; summary: string }> = [];
          try { log = JSON.parse(existing.interaction_log || '[]'); } catch (_) {}
          log.push({ date: today, type: 'message_sent', summary });
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

/** The one open-state set on the spine — same one getOpenRequestsForOwner uses. */
const OPEN_REQUEST_STATES = `('awaiting_owner','awaiting_colleague','in_flight')`;

/**
 * #41 — outreach still IN FLIGHT in a given owner thread. Feeds the "ACTIVE IN
 * THIS THREAD — you already committed to these" prompt block on every owner turn
 * (tasks/index.ts → core/orchestrator/buildTurnContext.ts).
 *
 * Openness is the linked REQUEST's state. It used to be
 * `outreach_jobs.status NOT IN ('replied','cancelled','no_response')`, which is
 * how a fire-and-forget send — request `resolved` at birth, so no cascade ever
 * moved its column off 'sent' — stayed in this block forever, and how every
 * pre-bridge row with `request_id` NULL did too. The model was then told, in a
 * block headed "you already committed to these", about work that was finished:
 * the "still waiting on Idan" confabulation class. That old filter matched 70 rows
 * on disk the day this was re-pointed, none of them with an open request.
 *
 * The JOIN is deliberate: no linked request means no lifecycle, and something
 * nothing can ever close does not belong in a list of live commitments.
 */
export function getActiveOutreachForThread(ownerUserId: string, threadTs: string): OutreachJob[] {
  return getDb().prepare(`
    SELECT oj.* FROM outreach_jobs oj
    JOIN requests r ON oj.request_id = r.id
    WHERE oj.owner_user_id = ?
      AND oj.owner_thread_ts = ?
      AND r.state IN ${OPEN_REQUEST_STATES}
    ORDER BY oj.created_at DESC
  `).all(ownerUserId, threadTs) as OutreachJob[];
}

/**
 * #41 — reschedule outreach still awaiting an outcome, for the two meeting-artifact
 * sweeps (`closeMeetingArtifacts`, `cleanupVanishedMeetingArtifacts`). Each had its
 * own copy of `status IN ('sent','no_response','replied')`; both now ask the spine
 * here, once.
 *
 * That old filter kept rows whose request was already resolved (a replied-to
 * reschedule) and rows with no request at all — so the vanished-meeting sweep spent
 * a Graph existence check on the same settled event on every brief, forever, and
 * the mutation cascade counted `outreachClosed` for rows whose closeRequest was a
 * no-op or impossible. Nothing is lost by the tighter filter: a row this drops is
 * one neither sweep could act on.
 */
export function getOpenRescheduleOutreach(ownerUserId: string): OutreachJob[] {
  return getDb().prepare(`
    SELECT oj.* FROM outreach_jobs oj
    JOIN requests r ON oj.request_id = r.id
    WHERE oj.owner_user_id = ?
      AND oj.intent = 'meeting_reschedule'
      AND r.state IN ${OPEN_REQUEST_STATES}
    ORDER BY oj.created_at DESC
  `).all(ownerUserId) as OutreachJob[];
}

/**
 * v4.2.x (owner decision "option C") — how many CORRECTION notices have already
 * gone out for this meeting since `sinceIso`.
 *
 * Backs the owner's "at most once per event per day" cap on correcting a
 * colleague whose stated time a later calendar write voided
 * (utils/closeMeetingArtifacts.ts → relayVoidedNotices). Deliberately counted off
 * history in the payload table rather than a new column or a new table: the
 * correction relay already writes an outreach_jobs row tagged `correction: true`
 * in its context_json, so the cap needs no state of its own.
 *
 * `sent_at` (not created_at) because the relay stamps it as a full ISO-8601 UTC
 * string, directly comparable to the caller's window boundary — created_at is
 * SQLite's own 'YYYY-MM-DD HH:MM:SS' and would silently mis-compare.
 */
export function countCorrectionNoticesSince(
  ownerUserId: string,
  meetingId: string,
  sinceIso: string,
): number {
  const rows = getDb().prepare(`
    SELECT context_json FROM outreach_jobs
    WHERE owner_user_id = ?
      AND intent = 'meeting_reschedule'
      AND sent_at IS NOT NULL
      AND sent_at >= ?
  `).all(ownerUserId, sinceIso) as Array<{ context_json: string | null }>;

  let n = 0;
  for (const row of rows) {
    if (!row.context_json) continue;
    try {
      const ctx = JSON.parse(row.context_json) as { meeting_id?: unknown; correction?: unknown };
      if (ctx.correction === true && ctx.meeting_id === meetingId) n++;
    } catch (_) { /* unparseable payload can't be counted either way */ }
  }
  return n;
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
