/**
 * Waiting-owner → approval helper (v1.6.2 split from coord.ts).
 *
 * Every place that parks a coord in `waiting_owner` and DMs the owner goes
 * through this function. Instead of a raw postMessage + a prose question, it:
 *
 *   1. Finds the linked task row (skill_ref = job.id).
 *   2. Creates a structured approval row (idempotent by (task, kind, payload)).
 *   3. Posts the DM (no internal token appended — v1.6.2 removed that).
 *   4. Records the message ts on the approval for thread continuity.
 *
 * Lives in its own file because both the state-machine (coord.ts) and the
 * booking path (coord/booking.ts) call it — extracting it breaks a circular
 * dependency that would otherwise appear once booking was pulled out.
 *
 * If no linked task exists (legacy coord rows, tests), we skip the approval
 * and fall back to a plain postMessage — behavior is never worse than a raw DM.
 */

import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { updateCoordJob, getDb, type CoordJob } from '../../../db';
import { createApproval, type ApprovalKind } from '../../../db/approvals';
import logger from '../../../utils/logger';

export async function emitWaitingOwnerApproval(
  app: App,
  opts: {
    job: CoordJob;
    kind: ApprovalKind;                         // usually 'slot_pick' or 'calendar_conflict'
    payload: Record<string, unknown>;
    askText: string;                            // the DM text to post
    botToken: string;
    expiresInHours?: number;                    // default 24
    winningSlot?: string;                       // set on coord_job too
  },
): Promise<{ approvalId?: string; ts?: string }> {
  const { job, kind, payload, askText, botToken, expiresInHours = 24, winningSlot } = opts;

  // Find parent task
  let taskId: string | null = null;
  try {
    const row = getDb().prepare(
      `SELECT id FROM tasks WHERE skill_ref = ? ORDER BY created_at DESC LIMIT 1`
    ).get(job.id) as { id: string } | undefined;
    taskId = row?.id ?? null;
  } catch (err) {
    logger.warn('emitWaitingOwnerApproval — task lookup failed', { err: String(err), jobId: job.id });
  }

  // Always flip the coord to waiting_owner (regardless of approval success)
  const coordUpdates: Partial<CoordJob> = { status: 'waiting_owner' };
  if (winningSlot) coordUpdates.winning_slot = winningSlot;
  updateCoordJob(job.id, coordUpdates);

  if (!taskId) {
    logger.warn('emitWaitingOwnerApproval — no parent task; falling back to plain DM', { jobId: job.id });
    try {
      await app.client.chat.postMessage({
        token: botToken,
        channel: job.owner_channel,
        thread_ts: job.owner_thread_ts ?? undefined,
        text: askText,
      });
    } catch (err) {
      logger.error('emitWaitingOwnerApproval fallback DM failed', { err: String(err), jobId: job.id });
    }
    return {};
  }

  const expiresAt = DateTime.now().plus({ hours: expiresInHours }).toUTC().toISO()!;
  let approvalId: string | undefined;
  try {
    const { approval } = createApproval({
      taskId,
      ownerUserId: job.owner_user_id,
      kind,
      payload,
      skillRef: job.id,
      slackChannel: job.owner_channel,
      slackThreadTs: job.owner_thread_ts ?? undefined,
      expiresAt,
    });
    approvalId = approval.id;
  } catch (err) {
    logger.error('emitWaitingOwnerApproval — createApproval threw', { err: String(err), jobId: job.id });
  }

  // v1.6.2 — no visible "_ref: #appr_..._" token appended. Orchestrator binds
  // via PENDING APPROVALS block (subject + timing + thread).
  let ts: string | undefined;
  try {
    const res = await app.client.chat.postMessage({
      token: botToken,
      channel: job.owner_channel,
      thread_ts: job.owner_thread_ts ?? undefined,
      text: askText,
    });
    ts = res.ts ?? undefined;
    if (ts && approvalId) {
      getDb().prepare(
        `UPDATE approvals SET slack_msg_ts = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(ts, approvalId);
    }
  } catch (err) {
    logger.error('emitWaitingOwnerApproval — DM failed', { err: String(err), jobId: job.id });
  }

  return { approvalId, ts };
}
