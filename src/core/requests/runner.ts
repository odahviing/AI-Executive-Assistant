/**
 * Request runner (v2.7.0).
 *
 * Sweeps `requests` rows whose `next_check_at <= now` and dispatches to the
 * named `next_check_handler`. Per Q2(a) — lifecycle timers live ON the request
 * row, not in a separate dispatch table. One sweep handles every kind of
 * deferred action: approval reminders, expiry, coord nudge, outreach decision.
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
import { getCoordJobByRequestId, updateCoordJob, type CoordParticipant } from '../../db/jobs';
import { closeRequest } from './closeRequest';
import type { NextCheckHandler, RequestRow } from './types';
import { parseDetails } from './types';
import { getConnection } from '../../connections/registry';
import { isWithinOwnerWorkHours, nextOwnerWorkdayStart } from '../../utils/workHours';
import logger from '../../utils/logger';

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

    case 'outreach_expiry':
    case 'outreach_decision':
      return runOutreachExpiryOrDecision(row, profile);

    case 'send_scheduled_outreach':
      return runSendScheduledOutreach(row, profile);

    case 'coord_nudge':
      return runCoordNudge(row, profile);

    case 'coord_abandon':
      return runCoordAbandon(row, profile);

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
  // Tombstone DM to owner for decisions he never answered. v3.1.1 (audit A-1) —
  // widened to coord too: a coord reaching awaiting_owner ("book anyway / find a
  // new time?") arms next_check_handler='expiry' via emitWaitingOwnerApproval and
  // sets owner_dm_channel at initiation. Pre-fix this was approval-only, so an
  // unanswered coord decision expired SILENTLY — owner thought it was still being
  // worked, the meeting never booked, nobody was told.
  if ((row.kind === 'approval' || row.kind === 'coord') && row.owner_dm_channel) {
    try {
      const conn = getConnection(profile.user.slack_user_id, 'slack');
      if (conn) {
        const what = row.kind === 'coord'
          ? `I never heard back on "${row.subject ?? 'that meeting'}" — I've closed it for now. Want me to pick it back up?`
          : `I never heard back on the approval I asked about. I've closed it, let me know if you want to try again.`;
        await conn.postToChannel(
          row.owner_dm_channel,
          what,
          { threadTs: row.owner_dm_thread_ts ?? undefined },
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
        if (row.origin_is_mpim && row.origin_channel) {
          await conn.postToChannel(row.origin_channel, body, {
            threadTs: row.origin_thread_ts ?? undefined,
          });
        } else {
          await conn.sendDirect(row.requester_slack_id, body);
        }
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
    logger.warn('runSendScheduledOutreach — send threw', { requestId: row.id, err: String(err).slice(0, 200) });
    return 'rearmed';
  }
}

/**
 * v3.1 (Path 2 Stage 6) — coord nudge, now driven by the spine timer instead of
 * a legacy coord_nudge task. Ported from tasks/dispatchers/coordNudge.ts. The
 * coord's STATUS is the request (phase coord:collecting/negotiating); the
 * participant DATA is read from the linked coord_job. On fire: DM non-responders
 * once, then re-arm next_check for coord_abandon +4h. Defers past owner work
 * hours by re-arming for the next workday start.
 */
async function runCoordNudge(row: RequestRow, profile: UserProfile): Promise<'rearmed' | 'noop'> {
  const job = getCoordJobByRequestId(row.id);
  // Still collecting/negotiating? Phase lives on the request now.
  const stillCollecting = row.phase === 'coord:collecting' || row.phase === 'coord:negotiating';
  if (!job || !stillCollecting) {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'noop';
  }

  // Defer past owner work hours — don't nudge in a way that lands an abandon +
  // owner ping at 3am.
  const ownerNow = DateTime.now().setZone(profile.user.timezone);
  if (!isWithinOwnerWorkHours(profile, ownerNow)) {
    updateRequest(row.id, { nextCheckAt: nextOwnerWorkdayStart(profile), nextCheckHandler: 'coord_nudge' });
    return 'rearmed';
  }

  let participants: CoordParticipant[] = [];
  try { participants = JSON.parse(job.participants) as CoordParticipant[]; } catch { participants = []; }
  const nonResponders = participants.filter(p =>
    !p.just_invite && p.dm_sent_at && (p.response === null || p.response === undefined),
  );
  if (nonResponders.length === 0) {
    // Everyone keyresponded — let resolveCoordination drive; drop the timer.
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'noop';
  }

  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'noop';
  }
  for (const p of nonResponders) {
    if (!p.slack_id) continue;
    const res = await conn.sendDirect(p.slack_id, `Hi ${p.name}, gentle nudge about "${job.subject}" — let me know when you get a chance.`);
    if (!res.ok) {
      logger.warn('coord_nudge (spine) — DM failed for participant', { reason: res.reason, participant: p.name });
    }
  }
  updateCoordJob(job.id, { follow_up_sent_at: new Date().toISOString() });
  // Re-arm: abandon check +4h, on the request.
  updateRequest(row.id, {
    nextCheckAt: DateTime.now().plus({ hours: 4 }).toUTC().toISO(),
    nextCheckHandler: 'coord_abandon',
  });
  logger.info('coord_nudge (spine) — nudged + abandon armed', {
    requestId: row.id, coordId: job.id, nudged: nonResponders.map(p => p.name),
  });
  return 'rearmed';
}

/**
 * v3.1 (Path 2 Stage 6) — coord abandon, spine-driven (ported from
 * tasks/dispatchers/coordAbandon.ts). Fires roughly a grace window after the
 * nudge (~4h, but it can stretch — if the fire lands outside the owner's work
 * hours it re-arms for the next workday start, so the effective grace is "≥4h,
 * next work window"). If the coord is still unanswered when it fires, close it.
 * updateCoordJob(status='abandoned') runs the full terminal cascade (closes the
 * linked request, cancels the coordination task, writes people memory, cleans
 * sibling outreach).
 */
async function runCoordAbandon(row: RequestRow, profile: UserProfile): Promise<'closed' | 'rearmed' | 'noop'> {
  const job = getCoordJobByRequestId(row.id);
  const stillCollecting = row.phase === 'coord:collecting' || row.phase === 'coord:negotiating';
  if (!job || !stillCollecting) {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'noop';
  }

  const ownerNow = DateTime.now().setZone(profile.user.timezone);
  if (!isWithinOwnerWorkHours(profile, ownerNow)) {
    updateRequest(row.id, { nextCheckAt: nextOwnerWorkdayStart(profile), nextCheckHandler: 'coord_abandon' });
    return 'rearmed';
  }

  // Terminal cascade closes the linked request (this row) too.
  updateCoordJob(job.id, {
    status: 'abandoned',
    abandoned_at: new Date().toISOString(),
    notes: 'abandoned after the nudge + grace window (≥4h, deferred past off-hours) with no response',
  });
  // v3.1 (Path 2 fix) — defensively clear THIS row's timer. The cascade above
  // closes the request via getLinkedRequestIdForCoord→closeRequest (which nulls
  // next_check), but that lookup/closeRequest is wrapped in a swallowed try in
  // updateCoordJob. If it ever no-ops (broken forward link), the row would keep
  // firing coord_abandon every 5-min tick — re-DMing the owner + re-writing
  // people-memory. Clear the timer here regardless so 'closed' can't lie.
  updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (conn) {
    await conn.postToChannel(
      job.owner_channel,
      `I couldn't get a response on "${job.subject}" — I've closed it. Want me to try again later?`,
      { threadTs: job.owner_thread_ts ?? undefined },
    );
  }
  logger.info('coord_abandon (spine) — coord closed', { requestId: row.id, coordId: job.id, subject: job.subject });
  return 'closed';
}
