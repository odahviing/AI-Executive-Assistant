/**
 * Request runner (v2.7.0).
 *
 * Sweeps `requests` rows whose `next_check_at <= now` and dispatches to the
 * named `next_check_handler`. Lifecycle timers live ON the request
 * row, not in a separate dispatch table. One sweep handles every kind of
 * deferred action; see `dispatchHandler` for the full set (expiry, approval
 * reminder, reminder_fire, research_run, outreach expiry/decision,
 * send_scheduled_outreach).
 *
 * After handling, the dispatcher EITHER:
 *   - clears next_check_at + next_check_handler (terminal, no more checks),
 *   - or re-arms them to the next deadline (e.g. midpoint reminder → re-arm
 *     for expiry).
 *
 * Closure flows through `closeRequest` so audit + cascade fire correctly.
 */

import { DateTime } from 'luxon';
import type { App } from '@slack/bolt';
import type { UserProfile } from '../../config/userProfile';
import { getDueRequests, updateRequest } from '../../db/requests';
import { getOutreachJobByRequestId } from '../../db/jobs';
import { workTimeBaseFromNow } from '../../utils/workHours';
import { closeRequest } from './closeRequest';
import type { NextCheckHandler, RequestRow } from './types';
import { parseDetails, deriveOriginSurface } from './types';
import { getConnection } from '../../connections/registry';
import logger from '../../utils/logger';

/**
 * The ONE notification primitive for the spine sweep: send a DM or channel post
 * and LOG the outcome (res.ok + reason). A soft Slack failure (res.ok=false, no
 * throw — channel issue, not-in-channel) must never be swallowed silently — that
 * was the EXPIRY-SILENT-SEND blind spot, the same class as the close-loop relay
 * drop. Returns whether it landed. Used by every send below so there's one path,
 * not a per-site clone.
 */
async function sendTracked(
  conn: NonNullable<ReturnType<typeof getConnection>>,
  target: { dm: string } | { channel: string },
  body: string,
  opts: { threadTs?: string } | undefined,
  label: string,
  requestId?: string,
): Promise<boolean> {
  try {
    const res = 'dm' in target
      ? await conn.sendDirect(target.dm, body, opts)
      : await conn.postToChannel(target.channel, body, opts);
    if (res.ok) logger.info(`${label} — sent`, { requestId });
    else logger.warn(`${label} — send failed`, { requestId, reason: res.reason });
    return res.ok;
  } catch (err) {
    logger.warn(`${label} — send threw`, { requestId, err: String(err).slice(0, 200) });
    return false;
  }
}

/**
 * Sweep all due requests. Called from the main runner loop on the same
 * cadence the legacy task runner uses.
 *
 * profilesByUserId: lookup so each request can be processed with its owner's
 * profile (timezones, working hours, etc).
 */
export async function sweepDueRequests(opts: {
  app?: App;
  profilesByUserId: Map<string, UserProfile>;
}): Promise<{ swept: number; closed: number; rearmed: number }> {
  const due = getDueRequests();
  let closed = 0;
  let rearmed = 0;

  for (const row of due) {
    const profile = opts.profilesByUserId.get(row.owner_user_id);
    if (!profile) {
      logger.debug('sweepDueRequests — no profile loaded for owner, skipping', {
        requestId: row.id, ownerUserId: row.owner_user_id,
      });
      continue;
    }
    try {
      const action = await dispatchHandler(row, profile, opts.app);
      if (action === 'closed') closed++;
      else if (action === 'rearmed') rearmed++;
    } catch (err) {
      logger.warn('sweepDueRequests — handler threw, clearing timer to avoid loop', {
        requestId: row.id, handler: row.next_check_handler, err: String(err).slice(0, 300),
      });
      // Defensive: clear the timer so we don't infinite-loop on a broken handler.
      updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    }
  }

  if (due.length > 0) {
    logger.info('sweepDueRequests', { swept: due.length, closed, rearmed });
  }
  return { swept: due.length, closed, rearmed };
}

async function dispatchHandler(
  row: RequestRow,
  profile: UserProfile,
  app: App | undefined,
): Promise<'closed' | 'rearmed' | 'noop'> {
  const handler = row.next_check_handler as NextCheckHandler | null;
  switch (handler) {
    case 'expiry':
      return runExpiry(row, profile);

    case 'approval_reminder':
      return runApprovalReminder(row, profile);

    case 'reminder_fire':
      return runReminderFire(row, profile);

    case 'research_run':
      return runResearchRun(row, profile, app);

    case 'reschedule_reask':
      return runRescheduleReask(row, profile);

    case 'outreach_expiry':
      return runOutreachExpiryOrDecision(row, profile);

    case 'send_scheduled_outreach':
      return runSendScheduledOutreach(row, profile);

    default:
      logger.warn('dispatchHandler — unknown handler, clearing timer', {
        requestId: row.id, handler,
      });
      updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
      return 'noop';
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * Generic expiry — close the request as expired + tell BOTH sides (R4).
 *
 * v2.9.1 — also notify the REQUESTER on approval-kind expiry (scenario A:
 * someone asks, owner never answers → without this the requester is left
 * hanging). Pre-fix the tombstone went only to the owner.
 *
 * #42 — the COPY is chosen from the row's STATE at fire time, not from `kind`
 * alone. `kind==='approval'` says nothing about who went quiet: after an amend
 * the owner has already decided and the request sits on the COLLEAGUE. Telling
 * the owner "I never heard back from you" and the requester "I couldn't get a
 * read from him" would then be a double lie about who ghosted whom — the exact
 * wrong-outcome failure R4 names. One expiry path, two truthful stories.
 */
async function runExpiry(row: RequestRow, profile: UserProfile): Promise<'closed'> {
  // Read the side BEFORE closing — closeRequest moves state to 'expired'.
  const waitingOnColleague = row.state === 'awaiting_colleague';
  const ownerFirst = profile.user.name.split(' ')[0];
  const requesterFirst = row.requester_name?.split(' ')[0] ?? 'there';
  const subject = row.subject && row.subject.toLowerCase().endsWith('needs your input')
    ? 'that ask'
    : (row.subject || 'that ask');
  closeRequest({
    id: row.id,
    state: 'expired',
    closureReason: waitingOnColleague ? 'no_colleague_reply_in_window' : 'no_action_in_window',
    closedBy: 'expiry',
  });
  // Tombstone to the owner: what actually stalled, in his decision thread.
  if (row.kind === 'approval' && row.owner_dm_channel) {
    try {
      const conn = getConnection(profile.user.slack_user_id, 'slack');
      if (conn) {
        const who = row.requester_name?.split(' ')[0] ?? 'They';
        const what = waitingOnColleague
          ? `${who} never came back on what you suggested for "${subject}". I've closed it — say the word if you want me to chase it again.`
          : `I never heard back on the approval I asked about. I've closed it, let me know if you want to try again.`;
        await sendTracked(
          conn,
          { channel: row.owner_dm_channel },
          what,
          { threadTs: row.owner_dm_thread_ts ?? undefined },
          'runExpiry owner tombstone',
          row.id,
        );
      }
    } catch (err) {
      logger.warn('runExpiry — tombstone DM failed', { requestId: row.id, err: String(err).slice(0, 200) });
    }
  }
  // v2.9.1 — requester loop-close on approval expiry. Reuses the same DM
  // path resolveRequest uses for reject; the verbiage is "couldn't get back
  // to you on this" rather than "Idan said no".
  if (row.kind === 'approval' && row.requester_slack_id && !row.requester_notified_at) {
    try {
      const conn = getConnection(profile.user.slack_user_id, 'slack');
      if (conn) {
        const body = waitingOnColleague
          // The owner ANSWERED and we relayed his counter; it's their reply we
          // never got. Saying "I couldn't get a read from him" here would blame
          // him for their silence.
          ? `Hey ${requesterFirst} — I never heard back on what ${ownerFirst} suggested for ${subject}, so I've closed this off for now. Ping me whenever you want to pick it up again.`
          : `Hey ${requesterFirst} — I couldn't get a read from ${ownerFirst} on ${subject}. Closing this for now; ping me when you want to try again.`;
        // v3.4.6 — consistent requester threading: always thread into the
        // requester's origin thread (MPIM channel or 1:1 DM), matching
        // notifyRequesterOfDecision. Pre-fix the 1:1 path dropped the thread,
        // so the close-loop landed as a new top-level DM with no history.
        const target = row.origin_is_mpim && row.origin_channel
          ? { channel: row.origin_channel }
          : { dm: row.requester_slack_id };
        await sendTracked(
          conn, target, body,
          { threadTs: row.origin_thread_ts ?? undefined },
          'runExpiry requester loop-close', row.id,
        );
        // Stamp the once-only notify flag (mirrors resolver.notifyRequesterOfDecision)
        // so no later notify path can double-DM this requester.
        updateRequest(row.id, { requesterNotifiedAt: new Date().toISOString() });
      }
    } catch (err) {
      logger.warn('runExpiry — requester loop-close DM failed', {
        requestId: row.id, err: String(err).slice(0, 200),
      });
    }
  }
  return 'closed';
}

/**
 * Approval midpoint reminder — nag the owner once at the halfway point, inside
 * his work hours. Then re-arm next_check_at = expires_at, handler = 'expiry'.
 */
async function runApprovalReminder(row: RequestRow, profile: UserProfile): Promise<'rearmed' | 'closed'> {
  // #42 — never nag the owner about a call that isn't his to make. Every
  // transition off awaiting_owner re-aims the clock (resolver timersForWaitingSide),
  // so this is the precondition made explicit rather than assumed: reaching here
  // in any other state means a re-aim was missed, and "Still waiting on your call
  // here" would be a lie. Fall straight through to expiry instead of nagging.
  if (row.state !== 'awaiting_owner') {
    logger.info('runApprovalReminder — not awaiting the owner, skipping the nag and arming expiry', {
      requestId: row.id, state: row.state,
    });
    updateRequest(row.id, {
      nextCheckAt: row.expires_at ?? null,
      nextCheckHandler: row.expires_at ? 'expiry' : null,
    });
    return 'rearmed';
  }
  if (!row.expires_at) {
    // No expiry → just clear the timer (defensive — shouldn't happen since
    // approval_reminder is only set when expires_at exists).
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'rearmed';
  }

  // R5 — an owner-facing ping respects his work hours. The midpoint is plain
  // wall-clock arithmetic laid over a WORKDAY-aware expiry (tasks/skill.ts), so
  // the two disagree the moment a weekend sits between them: a Thursday ask whose
  // 2-workday deadline lands on Monday midpoints onto SATURDAY, and the nag fired
  // there.
  //
  // Clamped HERE, at the send, not at the raise. This is the ONE place the nag is
  // emitted, so every arming path is covered by construction; and a per-date
  // schedule override added AFTER the raise (a day off, changed hours) invalidates
  // a raise-time clamp but can never invalidate this one — it is evaluated at fire
  // time against the same accessor everything else reads (getEffectiveWorkDay, via
  // workTimeBaseFromNow). That helper is already this spine's convention for
  // owner-facing timing (timersForWaitingSide, create_approval's expiry base):
  // NOW when he is inside work hours, else the next work-time start.
  //
  // Only the NUDGE defers. Expiry does not — a closure is an outcome both sides
  // are owed on time (R4), not a nudge that can wait for Sunday.
  const nextWorkTime = workTimeBaseFromNow(profile);
  const deferMs = Date.parse(nextWorkTime);
  if (Number.isFinite(deferMs) && deferMs > Date.now() + 60_000) {
    const expiresMs = Date.parse(row.expires_at);
    if (Number.isFinite(expiresMs) && deferMs >= expiresMs) {
      // The next work-hours slot is past the deadline: the nag would either
      // announce a closing time already gone, or land after expiry has closed the
      // row. Drop the nudge and go straight to the honest outcome.
      logger.info('runApprovalReminder — next work-hours slot is past expiry, skipping the nag', {
        requestId: row.id, expiresAt: row.expires_at, nextWorkTime,
      });
      updateRequest(row.id, { nextCheckAt: row.expires_at, nextCheckHandler: 'expiry' });
      return 'rearmed';
    }
    logger.info('runApprovalReminder — outside the owner work hours, deferring the nag', {
      requestId: row.id, nextWorkTime, expiresAt: row.expires_at,
    });
    updateRequest(row.id, { nextCheckAt: nextWorkTime, nextCheckHandler: 'approval_reminder' });
    return 'rearmed';
  }

  // Nag DM. We deliberately do NOT stamp terminal_dm_msg_ts on this DM —
  // emoji ✅ on the reminder is a no-op. The owner must react on the
  // original (terminal_dm_msg_ts) or reply in chat.
  if (row.owner_dm_channel) {
    try {
      const conn = getConnection(profile.user.slack_user_id, 'slack');
      if (conn) {
        const expiresLocal = DateTime.fromISO(row.expires_at, { zone: 'utc' })
          .setZone(profile.user.timezone);
        const expLabel = expiresLocal.toFormat("EEEE 'at' HH:mm");
        await conn.postToChannel(
          row.owner_dm_channel,
          `Still waiting on your call here: "${row.subject}". Closing it on ${expLabel} if I don't hear back.`,
          { threadTs: row.owner_dm_thread_ts ?? undefined },
        );
      }
    } catch (err) {
      logger.warn('runApprovalReminder — DM threw', { requestId: row.id, err: String(err).slice(0, 200) });
    }
  }
  // Re-arm for expiry.
  updateRequest(row.id, {
    nextCheckAt: row.expires_at,
    nextCheckHandler: 'expiry',
  });
  return 'rearmed';
}

/**
 * Reminder fires — DM the owner (or target) with the reminder message,
 * then close the request.
 */
async function runReminderFire(row: RequestRow, profile: UserProfile): Promise<'closed'> {
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  const message = typeof details.message === 'string' && details.message
    ? details.message
    : (row.subject ?? '');
  const ownerId = profile.user.slack_user_id;
  const targetSlackId = row.target_slack_id ?? ownerId;
  const remindingSomeoneElse = targetSlackId !== ownerId;

  try {
    const conn = getConnection(ownerId, 'slack');
    if (conn) {
      if (remindingSomeoneElse) {
        // Remind someone else: DM them framed as coming from the owner, then
        // report back to the owner (or flag if they were unreachable). This is
        // the behavior the old tasks-table dispatchReminder owned — now folded
        // into the single spine chokepoint so there's one reminder path.
        const ownerFirst = profile.user.name.split(' ')[0];
        const targetName = row.target_name ?? 'them';
        const framed = `${ownerFirst} asked me to remind you: ${message}`;
        const res = await conn.sendDirect(targetSlackId, framed);
        if (res.ok) {
          await conn.sendDirect(ownerId, `Reminded ${targetName} about "${row.subject ?? message}".`);
        } else {
          await conn.sendDirect(ownerId, `I couldn't reach ${targetName} to send that reminder — you may want to ping them directly.`);
        }
      } else {
        // Remind me — DM the owner the message.
        await conn.sendDirect(ownerId, message);
      }
    }
  } catch (err) {
    logger.warn('runReminderFire — DM threw', { requestId: row.id, err: String(err).slice(0, 200) });
  }
  closeRequest({
    id: row.id,
    state: 'resolved',
    closureReason: 'reminder_fired',
    closedBy: 'system',
  });
  return 'closed';
}

/**
 * Research fires — run the research prompt through the orchestrator (full
 * agent loop, non-interactive), DM the owner the result, then close. Ported
 * from the deleted tasks-table dispatchResearch so research lives on the one
 * spine chokepoint (create_task → kind=research → handler='research_run')
 * instead of the broken reminder_fire path that only DM'd the title and never
 * actually researched anything.
 */
// gh#52 (52-U8) — cap on what a research closure stores in outcome_json. A
// few thousand characters holds the actual answer Maelle DM'd the owner
// without keeping a full transcript or raw tool-call history (the row is
// data to recall later via get_my_tasks' recent_activity bucket, not an
// audit trace).
const RESEARCH_ANSWER_STORE_CAP = 4000;

async function runResearchRun(row: RequestRow, profile: UserProfile, app: App | undefined): Promise<'closed'> {
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  const researchPrompt = (typeof details.message === 'string' && details.message)
    ? details.message
    : (row.description ?? `Research: ${row.subject ?? ''}`);
  const ownerId = profile.user.slack_user_id;
  const channelId = row.origin_channel ?? '';
  let answer: string | undefined;

  try {
    // Dynamic import avoids a load-time cycle (orchestrator → skills → spine).
    const { runOrchestrator } = await import('../orchestrator');
    // v4.4.x (#154-replay-surface; corrected by o#219) — create_task is
    // COLLEAGUE-reachable (skills/registry.ts's COLLEAGUE_ALLOWED_TOOLS has no
    // authority/senderRole gate on it), so a research/reminder row is NOT
    // owner-only by construction — any colleague can raise one. Hardcoding
    // 'owner' here shipped the FULL owner tool set (get_calendar, etc.) plus
    // the OWNER_ROOM_ACTION_TOOLS room-action floor to a colleague-raised run,
    // whatever origin_channel it then posted the reply into.
    //
    // `row.initiated_by` is the raiser's raw, never-clamped Slack id (stamped
    // straight off context.userId at creation, tasks/skill.ts's create_task) —
    // comparing it to the owner's own id re-derives TRUE authority exactly
    // like the Slack front door's getSenderRole(senderId), rather than
    // trusting `initiated_by_role` for this: that field (like the live turn's
    // `senderRole`) is surface-clamped to 'colleague' for ANYONE — owner
    // included — raised from inside a room, so it can't alone tell an
    // owner-in-a-room from a genuine colleague.
    const rawRole: 'owner' | 'colleague' = row.initiated_by === profile.user.slack_user_id ? 'owner' : 'colleague';
    // `surface`/`isMpim` stay row-derived (unchanged from #154-replay-surface)
    // so every tool call this run makes reads subjectViewerFor/viewerEmailFor
    // honestly instead of as a fully private owner DM.
    const surface = deriveOriginSurface(row);
    // Mirrors the live-turn clamp at connectors/slack/app/processMessage.ts:
    // senderRole reads 'colleague' on any room surface no matter who raised
    // it; authority (the actual privilege floor) is never clamped by surface.
    const senderRole: 'owner' | 'colleague' = surface === 'room' ? 'colleague' : rawRole;
    const result = await runOrchestrator({
      userMessage: researchPrompt,
      conversationHistory: [],
      threadTs: `research_${row.id}_${Date.now()}`,
      channelId,
      userId: row.initiated_by,
      senderRole,
      authority: rawRole,
      surface,
      isMpim: surface === 'room',
      channel: 'slack',
      interactive: false,  // scheduled research run, not a conversation: no social coda
      profile,
      app,
    });
    if (result.reply) {
      answer = result.reply.length > RESEARCH_ANSWER_STORE_CAP
        ? `${result.reply.slice(0, RESEARCH_ANSWER_STORE_CAP)}…`
        : result.reply;
      const conn = getConnection(ownerId, 'slack');
      if (conn) {
        if (channelId) {
          await conn.postToChannel(channelId, result.reply, { threadTs: row.origin_thread_ts ?? undefined });
        } else {
          await conn.sendDirect(ownerId, result.reply);
        }
      }
    }
  } catch (err) {
    logger.warn('runResearchRun — orchestrator threw', { requestId: row.id, err: String(err).slice(0, 300) });
  }
  closeRequest({
    id: row.id,
    // gh#52 (52-U8) — 'logged', not 'resolved': a research run is exactly
    // the "completed Maelle-initiated action that needed no owner decision"
    // logActivity.ts's own header names as a canonical logged-row example
    // (research run alongside a colleague DM / a resolved approval). Closing
    // as 'resolved' left it invisible everywhere the instant the brief
    // surfaced+flipped informed — 'logged' is what makes it recallable via
    // get_my_tasks' recent_activity bucket (52-U6), forever, by design.
    state: 'logged',
    closureReason: 'research_completed',
    closedBy: 'system',
    // The answer Maelle already found, so a later "what did you find out
    // about X" is answered from this row instead of re-running the research.
    outcomeJson: answer ? { answer } : undefined,
  });
  return 'closed';
}

/**
 * v3.5.x — reschedule "checking" re-ask. A colleague replied "let me check /
 * I'll come back to you" to a meeting_reschedule ask; the reply handler kept the
 * request open and armed this at +24h. Fires ONCE: re-ping the colleague with the
 * original proposal, then re-arm to the normal outreach_expiry — so it never
 * re-asks a second time, and eventual silence still closes cleanly (owner
 * tombstone). A real reply before now would have run handleRescheduleReply and
 * cleared this timer, so reaching here means still-waiting. No new state — reads
 * the outreach detail row by request_id.
 */
async function runRescheduleReask(row: RequestRow, profile: UserProfile): Promise<'rearmed' | 'noop'> {
  const job = getOutreachJobByRequestId(row.id);
  // Stale/settled guard — the REQUEST state is the lifecycle truth: a real reply
  // (approve/decline/counter) would have cascaded the request off
  // awaiting_colleague AND cleared this timer. So reaching here in any other
  // state, or with no reschedule job, means nothing to re-ask → drop the timer.
  if (row.state !== 'awaiting_colleague' || !job || job.intent !== 'meeting_reschedule') {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'noop';
  }
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'noop';
  }
  let ctx: { meeting_subject?: string; proposed_start?: string } = {};
  try { ctx = job!.context_json ? JSON.parse(job!.context_json) : {}; } catch { /* fall back to generic */ }
  const tz = profile.user.timezone;
  const whenLocal = ctx.proposed_start
    ? DateTime.fromISO(ctx.proposed_start, { zone: tz }).toFormat("EEEE d MMM 'at' HH:mm")
    : 'the new time';
  const subj = ctx.meeting_subject ?? 'the meeting';
  const first = (job!.colleague_name ?? '').split(/\s+/)[0] || 'there';
  const msg = `Hi ${first}, just circling back on "${subj}" — were you able to check on moving it to ${whenLocal}? No rush, just want to lock it in when you can.`;
  try {
    if (job!.dm_channel_id) await conn.postToChannel(job!.dm_channel_id, msg, { threadTs: job!.dm_message_ts ?? undefined });
    else await conn.sendDirect(job!.colleague_slack_id, msg);
  } catch (err) {
    logger.warn('reschedule_reask — re-ping DM failed', { requestId: row.id, err: String(err).slice(0, 200) });
  }
  // Re-arm to the NORMAL no-response expiry — guarantees exactly one re-ask and
  // a clean eventual close. Never back to reschedule_reask.
  updateRequest(row.id, {
    nextCheckAt: DateTime.now().plus({ hours: 48 }).toUTC().toISO(),
    nextCheckHandler: 'outreach_expiry',
  });
  logger.info('reschedule_reask — re-pinged colleague once, re-armed to outreach_expiry', {
    requestId: row.id, jobId: job!.id,
  });
  return 'rearmed';
}

/**
 * Outreach awaiting_colleague past window → close as expired + tombstone DM.
 * For await_reply=false outreach this never fires (request goes resolved
 * immediately on send).
 */
async function runOutreachExpiryOrDecision(row: RequestRow, profile: UserProfile): Promise<'closed'> {
  // If colleague meanwhile replied (state changed off awaiting_colleague),
  // this is a stale timer — just clear it.
  if (row.state !== 'awaiting_colleague') {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'closed';
  }
  closeRequest({
    id: row.id,
    state: 'expired',
    closureReason: 'outreach_no_response',
    closedBy: 'expiry',
  });
  // Owner heads-up so the request appears in next brief with closure context.
  if (row.owner_dm_channel) {
    try {
      const conn = getConnection(profile.user.slack_user_id, 'slack');
      if (conn) {
        const targetName = row.target_name ?? 'them';
        await conn.postToChannel(
          row.owner_dm_channel,
          `${targetName} never replied to the message I sent — I've closed that one out. Tell me if you want to try again.`,
          { threadTs: row.owner_dm_thread_ts ?? undefined },
        );
      }
    } catch (err) {
      logger.warn('runOutreachExpiryOrDecision — tombstone DM threw', { requestId: row.id, err: String(err).slice(0, 200) });
    }
  }
  return 'closed';
}

/**
 * Scheduled outreach fires — actually send the DM now.
 * Outreach skill stamps details.message + target on the in_flight request;
 * here we send and flip state.
 */
async function runSendScheduledOutreach(row: RequestRow, profile: UserProfile): Promise<'closed' | 'rearmed'> {
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  const message = typeof details.message === 'string' ? details.message : row.description ?? row.subject;
  const targetSlackId = row.target_slack_id;
  if (!targetSlackId) {
    closeRequest({ id: row.id, state: 'cancelled', closureReason: 'no_target_slack_id', closedBy: 'system' });
    return 'closed';
  }
  try {
    const conn = getConnection(profile.user.slack_user_id, 'slack');
    if (!conn) {
      logger.warn('runSendScheduledOutreach — no Slack connection', { requestId: row.id });
      closeRequest({ id: row.id, state: 'cancelled', closureReason: 'no_slack_connection', closedBy: 'system' });
      return 'closed';
    }
    const res = await conn.sendDirect(targetSlackId, message ?? '');
    const sentTs = res.ok ? (res.ts ?? null) : null;
    // await_reply is stored NUMERIC (0/1) in details, so a bare `!== false` is
    // always true (0 !== false). Treat 0 as fire-and-forget; keep "missing = await".
    const awaitReply = details.await_reply !== false && details.await_reply !== 0;
    updateRequest(row.id, {
      // Fire-and-forget: leave state alone here so closeRequest below owns the
      // terminal 'resolved' write + audit_log row. Setting state:'resolved' here
      // made closeRequest see an already-terminal row and no-op → closed_at/
      // closed_by/closure_reason stayed NULL and no audit was written.
      state: awaitReply ? 'awaiting_colleague' : undefined,
      details: { ...details, sent_at: DateTime.now().toISO(), dm_message_ts: sentTs },
      nextCheckAt: awaitReply
        ? DateTime.now().plus({ days: 5 }).toUTC().toISO()
        : null,
      nextCheckHandler: awaitReply ? 'outreach_expiry' : null,
    });
    if (!awaitReply) {
      // Fire-and-forget — close immediately, no expiry timer needed.
      closeRequest({
        id: row.id,
        state: 'resolved',
        closureReason: 'outreach_sent_fire_and_forget',
        closedBy: 'system',
        skipChildren: true,
      });
      return 'closed';
    }
    return 'rearmed';
  } catch (err) {
    // Bounded retry. Pre-fix this returned 'rearmed' WITHOUT touching
    // next_check_at, so the row kept its past-due time and re-fired every
    // 5-min tick FOREVER on a persistent throw (deactivated user, bad channel,
    // a Slack exception rather than an {ok:false}) — infinite loop + a request
    // that never closes (pollutes the brief). Now: back off and cap. A
    // transient Slack hiccup still recovers (retry); a permanent failure
    // closes after MAX_SEND_ATTEMPTS instead of looping.
    const MAX_SEND_ATTEMPTS = 3;
    const attempts = (typeof details.send_attempts === 'number' ? details.send_attempts : 0) + 1;
    logger.warn('runSendScheduledOutreach — send threw', {
      requestId: row.id, attempt: attempts, maxAttempts: MAX_SEND_ATTEMPTS,
      err: String(err).slice(0, 200),
    });
    if (attempts >= MAX_SEND_ATTEMPTS) {
      closeRequest({ id: row.id, state: 'cancelled', closureReason: 'scheduled_send_failed', closedBy: 'system' });
      return 'closed';
    }
    // Re-arm with linear backoff (10m, 20m), bump the attempt counter.
    updateRequest(row.id, {
      details: { ...details, send_attempts: attempts },
      nextCheckAt: DateTime.now().plus({ minutes: 10 * attempts }).toUTC().toISO(),
      nextCheckHandler: 'send_scheduled_outreach',
    });
    return 'rearmed';
  }
}
