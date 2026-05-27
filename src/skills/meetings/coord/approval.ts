/**
 * Waiting-owner → request helper (v2.7.0).
 *
 * Every place that parks a coord in `waiting_owner` and asks the owner to
 * decide goes through this function. Creates the user-facing approval request
 * on the spine, posts the DM via Slack Connection, and stamps the
 * terminal_dm_msg_ts so emoji ✅ on the DM resolves correctly.
 *
 * The legacy approvals table is no longer written by this path. The linked
 * `requests` row IS the source of truth: brief sees it, system prompt
 * injects it, resolver closes it. The linked coord_jobs row stays for the
 * coord state machine's internal state.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../../../config/userProfile';
import { updateCoordJob, getDb, linkCoordToRequest, type CoordJob } from '../../../db';
import {
  createRequest,
  getRequest,
  updateRequest,
} from '../../../db/requests';
import { getConnection } from '../../../connections/registry';
import { workTimeBaseFromNow } from '../../../utils/workHours';
import logger from '../../../utils/logger';

type ApprovalSubkind =
  | 'slot_pick'
  | 'duration_override'
  | 'policy_exception'
  | 'unknown_person'
  | 'calendar_conflict'
  | 'freeform';

export async function emitWaitingOwnerApproval(
  opts: {
    job: CoordJob;
    kind: ApprovalSubkind;
    payload: Record<string, unknown>;
    askText: string;
    expiresInHours?: number;
    winningSlot?: string;
    profile?: UserProfile;
  },
): Promise<{ approvalId?: string; ts?: string }> {
  const { job, kind, payload, askText, expiresInHours = 24, winningSlot, profile } = opts;

  const slackConn = getConnection(job.owner_user_id, 'slack');
  if (!slackConn) {
    logger.error('emitWaitingOwnerApproval — no Slack connection registered', {
      ownerUserId: job.owner_user_id, jobId: job.id,
    });
  }

  // Flip the coord lifecycle to waiting_owner (drives the linked request's
  // phase/state via updateCoordJob; `status` here is a transition signal, not a
  // persisted column — v3.1 Path 2 Stage 7).
  updateCoordJob(job.id, winningSlot
    ? { status: 'waiting_owner', winning_slot: winningSlot }
    : { status: 'waiting_owner' });

  // Expiry rebased off owner work time (avoid burning the first N hours when
  // colleague replied late and the owner's off-duty).
  const base = profile ? workTimeBaseFromNow(profile) : new Date().toISOString();
  const expiresAt = DateTime.fromISO(base).plus({ hours: expiresInHours }).toUTC().toISO()!;
  const expiresMs = Date.parse(expiresAt);
  const createdMs = Date.now();
  const midIso = expiresMs > createdMs + 60_000
    ? new Date(createdMs + Math.floor((expiresMs - createdMs) / 2)).toISOString()
    : null;
  const nextCheckAt = midIso ?? expiresAt;
  const nextCheckHandler = midIso ? 'approval_reminder' : 'expiry';

  // If a request is already linked to this coord (state.ts created it at
  // initiate-coord time), update its state to awaiting_owner instead of
  // creating a fresh row. Otherwise create one.
  const existingRequestId = getDb()
    .prepare(`SELECT request_id FROM coord_jobs WHERE id = ?`)
    .get(job.id) as { request_id: string | null } | undefined;
  let requestId: string;
  if (existingRequestId?.request_id) {
    requestId = existingRequestId.request_id;
    updateRequest(requestId, {
      state: 'awaiting_owner',
      subject: askText.slice(0, 120),
      description: askText,
      expiresAt,
      nextCheckAt,
      nextCheckHandler,
      details: {
        ...payload,
        coord_job_id: job.id,
        winning_slot: winningSlot ?? null,
        approval_subkind: kind,
      },
    });
  } else {
    const row = createRequest({
      ownerUserId: job.owner_user_id,
      initiatedBy: job.owner_user_id,
      initiatedByRole: 'system',
      kind: 'coord',
      subkind: kind,
      subject: askText.slice(0, 120),
      description: askText,
      state: 'awaiting_owner',
      informed: 0,
      expiresAt,
      nextCheckAt,
      nextCheckHandler,
      originChannel: job.owner_channel,
      originThreadTs: job.owner_thread_ts ?? undefined,
      ownerDmChannel: job.owner_channel,
      ownerDmThreadTs: job.owner_thread_ts ?? undefined,
      details: {
        ...payload,
        coord_job_id: job.id,
        winning_slot: winningSlot ?? null,
        approval_subkind: kind,
      },
    });
    requestId = row.id;
    linkCoordToRequest(job.id, requestId);
  }

  // DM the owner. terminal_dm_msg_ts stamped on this row — emoji ✅ binds here.
  let ts: string | undefined;
  if (slackConn) {
    const res = await slackConn.postToChannel(job.owner_channel, askText, {
      threadTs: job.owner_thread_ts ?? undefined,
    });
    if (res.ok) {
      ts = res.ts;
      if (ts) {
        updateRequest(requestId, { terminalDmMsgTs: ts });
      }
    } else {
      logger.error('emitWaitingOwnerApproval — DM failed', {
        reason: res.reason, detail: res.detail, jobId: job.id,
      });
    }
  }

  return { approvalId: requestId, ts };
}
