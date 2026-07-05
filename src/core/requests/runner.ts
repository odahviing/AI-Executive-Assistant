/**
 * Request runner (v2.7.0).
 *
 * Sweeps `requests` rows whose `next_check_at <= now` and dispatches to the
 * named `next_check_handler`. Per Q2(a) — lifecycle timers live ON the request
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
import { closeRequest } from './closeRequest';
import type { NextCheckHandler, RequestRow } from './types';
import { parseDetails } from './types';
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
    case 'outreach_decision':
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
 * Generic expiry — close the request as expired + DM owner a tombstone.
 *
 * v2.9.1 — also notify the REQUESTER on approval-kind expiry (scenario A:
 * someone asks, owner never answers → without this the requester is left
 * hanging). Pre-fix the tombstone went only to the owner.
 */
async function runExpiry(row: RequestRow, profile: UserProfile): Promise<'closed'> {
  closeRequest({
    id: row.id,
    state: 'expired',
    closureReason: 'no_action_in_window',
    closedBy: 'expiry',
  });
  // Tombstone DM to owner for approval decisions he never answered.
  if (row.kind === 'approval' && row.owner_dm_channel) {
    try {
      const conn = getConnection(profile.user.slack_user_id, 'slack');
      if (conn) {
        const what = `I never heard back on the approval I asked about. I've closed it, let me know if you want to try again.`;
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
        const requesterFirst = row.requester_name?.split(' ')[0] ?? 'there';
        const ownerFirst = profile.user.name.split(' ')[0];
        const subject = row.subject && row.subject.toLowerCase().endsWith('needs your input')
          ? 'that ask'
          : (row.subject || 'that ask');
        const body = `Hey ${requesterFirst} — I couldn't get a read from ${ownerFirst} on ${subject}. Closing this for now; ping me when you want to try again.`;
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
 * Approval midpoint reminder — nag the owner once at the halfway point.
 * Then re-arm next_check_at = expires_at, handler = 'expiry'.
 */
async function runApprovalReminder(row: RequestRow, profile: UserProfile): Promise<'rearmed' | 'closed'> {
  if (!row.expires_at) {
    // No expiry → just clear the timer (defensive — shouldn't happen since
    // approval_reminder is only set when expires_at exists).
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'rearmed';
  }
  // Nag DM. We deliberately do NOT stamp terminal_dm_msg_ts on this DM —
  // emoji ✅ on the reminder is a no-op per Q3. The owner must react on the
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
async function runResearchRun(row: RequestRow, profile: UserProfile, app: App | undefined): Promise<'closed'> {
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  const researchPrompt = (typeof details.message === 'string' && details.message)
    ? details.message
    : (row.description ?? `Research: ${row.subject ?? ''}`);
  const ownerId = profile.user.slack_user_id;
  const channelId = row.origin_channel ?? '';

  try {
    // Dynamic import avoids a load-time cycle (orchestrator → skills → spine).
    const { runOrchestrator } = await import('../orchestrator');
    const result = await runOrchestrator({
      userMessage: researchPrompt,
      conversationHistory: [],
      threadTs: `research_${row.id}_${Date.now()}`,
      channelId,
      userId: row.owner_user_id,
      senderRole: 'owner',
      channel: 'slack',
      interactive: false,  // scheduled research run, not a conversation: no social coda
      profile,
      app,
    });
    if (result.reply) {
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
    state: 'resolved',
    closureReason: 'research_completed',
    closedBy: 'system',
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
    const awaitReply = details.await_reply !== false;
    updateRequest(row.id, {
      state: awaitReply ? 'awaiting_colleague' : 'resolved',
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
