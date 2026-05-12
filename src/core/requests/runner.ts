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
import { closeRequest } from './closeRequest';
import type { NextCheckHandler, RequestRow } from './types';
import { parseDetails } from './types';
import { getConnection } from '../../connections/registry';
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

    case 'outreach_expiry':
    case 'outreach_decision':
      return runOutreachExpiryOrDecision(row, profile);

    case 'send_scheduled_outreach':
      return runSendScheduledOutreach(row, profile);

    case 'coord_nudge':
    case 'coord_abandon':
      // Coord state machine internals — for now, just clear the timer if
      // the coord is no longer open. Full coord state machine integration
      // is Phase B.
      if (row.state === 'awaiting_owner' || row.state === 'awaiting_colleague' || row.state === 'in_flight') {
        logger.info('coord_nudge / coord_abandon timer fired — coord state machine integration pending', {
          requestId: row.id, handler,
        });
      }
      updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
      return 'noop';

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
 */
async function runExpiry(row: RequestRow, profile: UserProfile): Promise<'closed'> {
  closeRequest({
    id: row.id,
    state: 'expired',
    closureReason: 'no_action_in_window',
    closedBy: 'expiry',
  });
  // Tombstone DM to owner for approval-kind requests.
  if (row.kind === 'approval' && row.owner_dm_channel) {
    try {
      const conn = getConnection(profile.user.slack_user_id, 'slack');
      if (conn) {
        await conn.postToChannel(
          row.owner_dm_channel,
          `I never heard back on the approval I asked about. I've closed it, let me know if you want to try again.`,
          { threadTs: row.owner_dm_thread_ts ?? undefined },
        );
      }
    } catch (err) {
      logger.warn('runExpiry — tombstone DM failed', { requestId: row.id, err: String(err).slice(0, 200) });
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
    : row.subject;
  const targetSlackId = row.target_slack_id ?? row.owner_user_id;

  try {
    const conn = getConnection(profile.user.slack_user_id, 'slack');
    if (conn) {
      await conn.sendDirect(targetSlackId, message);
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
