/**
 * Waiting-owner → approval helper.
 *
 * Every place that parks a coord in `waiting_owner` and asks the owner to
 * decide goes through this function. Instead of a raw postMessage + a prose
 * question, it:
 *
 *   1. Finds the linked task row (skill_ref = job.id).
 *   2. Creates a structured approval row (idempotent by (task, kind, payload)).
 *   3. Posts the DM via the Slack Connection (no internal token appended).
 *   4. Records the message ts on the approval for thread continuity.
 *
 * If no linked task exists (legacy coord rows, tests), we skip the approval
 * and fall back to a plain send — behavior is never worse than a raw DM.
 *
 * Moved from connectors/slack/coord/approval.ts as part of the Connection-
 * interface port (issue #1 sub-phase D3). Now resolves the Slack Connection
 * via registry instead of taking raw `app` + `botToken`.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../../../config/userProfile';
import { updateCoordJob, getDb, type CoordJob } from '../../../db';
import { createApproval, type ApprovalKind } from '../../../db/approvals';
import { getConnection } from '../../../connections/registry';
import { workTimeBaseFromNow } from '../../../utils/workHours';
import logger from '../../../utils/logger';

export async function emitWaitingOwnerApproval(
  opts: {
    job: CoordJob;
    kind: ApprovalKind;                         // usually 'slot_pick' or 'calendar_conflict'
    payload: Record<string, unknown>;
    askText: string;                            // the DM text to post
    expiresInHours?: number;                    // default 24
    winningSlot?: string;                       // set on coord_job too
    profile?: UserProfile;                      // v2.1.3 — used to rebase expiry off owner work time
  },
): Promise<{ approvalId?: string; ts?: string }> {
  const { job, kind, payload, askText, expiresInHours = 24, winningSlot, profile } = opts;

  const slackConn = getConnection(job.owner_user_id, 'slack');
  if (!slackConn) {
    logger.error('emitWaitingOwnerApproval — no Slack connection registered', {
      ownerUserId: job.owner_user_id,
      jobId: job.id,
    });
  }

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
    if (slackConn) {
      const res = await slackConn.postToChannel(job.owner_channel, askText, {
        threadTs: job.owner_thread_ts ?? undefined,
      });
      if (!res.ok) {
        logger.error('emitWaitingOwnerApproval fallback DM failed', {
          reason: res.reason,
          detail: res.detail,
          jobId: job.id,
        });
      }
    }
    return {};
  }

  // v2.1.3 — rebase expiry off owner's work time. If the approval is
  // raised at 20:00 (colleague replied late), we shouldn't burn the first
  // N hours of the window while the owner's off-duty. When profile isn't
  // passed, fall back to the legacy "from now" behavior so nothing breaks.
  const base = profile ? workTimeBaseFromNow(profile) : new Date().toISOString();
  const expiresAt = DateTime.fromISO(base).plus({ hours: expiresInHours }).toUTC().toISO()!;
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

  // No visible "_ref: #appr_..._" token appended. Orchestrator binds via
  // PENDING APPROVALS block (subject + timing + thread).
  let ts: string | undefined;
  if (slackConn) {
    const res = await slackConn.postToChannel(job.owner_channel, askText, {
      threadTs: job.owner_thread_ts ?? undefined,
    });
    if (res.ok) {
      ts = res.ts;
      if (ts && approvalId) {
        getDb().prepare(
          `UPDATE approvals SET slack_msg_ts = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(ts, approvalId);
      }
    } else {
      logger.error('emitWaitingOwnerApproval — DM failed', {
        reason: res.reason,
        detail: res.detail,
        jobId: job.id,
      });
    }
  }

  return { approvalId, ts };
}
