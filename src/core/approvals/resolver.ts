/**
 * Approval resolver (v1.5) — the single entry point for "the owner decided".
 *
 * The orchestrator never calls bookCoordination, never flips a coord status,
 * never runs createMeeting on its own. It calls resolveApproval with the
 * approval id and the decision the owner made. This file owns the per-kind
 * downstream effects.
 *
 * Why: free-text approvals are unreliable (B1). We centralize the state
 * transitions here so any path — orchestrator tool call, expiry cron, owner
 * DM parsed by Sonnet — flows through the same guarded logic. Freshness
 * re-check (B7), idempotency (B8), requester notification (B4) all land here.
 */

import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import type { UserProfile } from '../../config/userProfile';
import {
  getApproval,
  setApprovalDecision,
  supersedeApproval,
  createApproval,
  type Approval,
} from '../../db/approvals';
import {
  getCoordJob,
  updateCoordJob,
  type CoordParticipant,
} from '../../db/jobs';
import { getDb } from '../../db/client';
import { getCoordBookingHandler } from './coordBookingHandler';
import { getFreeBusy } from '../../connectors/graph/calendar';
import logger from '../../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ResolveDecision =
  | { verdict: 'approve'; data?: Record<string, unknown> }   // owner said yes (with optional kind-specific fields)
  | { verdict: 'reject'; reason?: string }                   // owner said no
  | { verdict: 'amend'; counter: Record<string, unknown>; reason?: string }; // owner said "not this but here's an alternative"

export interface ResolveResult {
  ok: boolean;
  approval_id: string;
  status: Approval['status'];
  effect?: string;           // short human-readable description of what happened
  reason?: string;           // why if !ok
  superseded_by?: string;    // id of the follow-up approval if we created one
  subject?: string;
  slot?: string;
}

export interface ResolveContext {
  app?: App;
  profile: UserProfile;
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function resolveApproval(
  approvalId: string,
  decision: ResolveDecision,
  ctx: ResolveContext,
): Promise<ResolveResult> {
  const approval = getApproval(approvalId);
  if (!approval) {
    return { ok: false, approval_id: approvalId, status: 'cancelled', reason: 'approval not found' };
  }

  if (approval.status !== 'pending') {
    logger.warn('resolveApproval called on non-pending approval', {
      id: approvalId,
      status: approval.status,
    });
    return {
      ok: false,
      approval_id: approvalId,
      status: approval.status,
      reason: `approval is already ${approval.status}`,
    };
  }

  logger.info('resolveApproval', {
    id: approvalId,
    kind: approval.kind,
    verdict: decision.verdict,
  });

  // Amend short-circuits every kind — owner proposed an alternative, terminal.
  // The approval closes with status='amended' and the counter recorded; the
  // orchestrator reads decision_json next turn and relays the alternative back
  // to whoever originally asked (colleague → outreach DM with the counter).
  if (decision.verdict === 'amend') {
    setApprovalDecision({
      id: approvalId,
      status: 'amended',
      decision: { counter: decision.counter, reason: decision.reason },
      notes: decision.reason,
    });
    // Flip the parent task to in_progress: the orchestrator has follow-up work
    // (relay the counter). It's NOT cancelled — the original ask is still alive,
    // just taking a different shape.
    getDb().prepare(`
      UPDATE tasks SET status = 'in_progress',
                       due_at = NULL,
                       updated_at = datetime('now')
      WHERE id = ?
    `).run(approval.task_id);
    return {
      ok: true,
      approval_id: approvalId,
      status: 'amended',
      effect: 'owner proposed a counter — orchestrator should relay the alternative to the requester/participants',
    };
  }

  // Reject short-circuits every kind
  if (decision.verdict === 'reject') {
    setApprovalDecision({ id: approvalId, status: 'rejected', decision, notes: decision.reason });
    // For coord-linked approvals, mark the coord cancelled too so it doesn't linger.
    if (approval.skill_ref) {
      const job = getCoordJob(approval.skill_ref);
      if (job && (job.status === 'waiting_owner' || job.status === 'negotiating' || job.status === 'collecting')) {
        updateCoordJob(approval.skill_ref, { status: 'cancelled', notes: decision.reason ?? 'owner rejected' });
        getDb().prepare(
          `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE skill_ref = ?`
        ).run(approval.skill_ref);
      }
    } else {
      getDb().prepare(
        `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
      ).run(approval.task_id);
    }
    return {
      ok: true,
      approval_id: approvalId,
      status: 'rejected',
      effect: 'approval rejected; linked task cancelled',
    };
  }

  // Kind-specific paths
  switch (approval.kind) {
    case 'slot_pick':
      return resolveSlotPick(approval, decision, ctx);
    case 'calendar_conflict':
      return resolveSlotPick(approval, decision, ctx);  // same shape, different origin
    case 'duration_override':
    case 'policy_exception':
    case 'lunch_bump':
    case 'unknown_person':
    case 'freeform':
      return resolveGenericApprove(approval, decision);
  }
}

// ── slot_pick / calendar_conflict ────────────────────────────────────────────

interface SlotPickPayload {
  coord_job_id: string;
  subject: string;
  slots: Array<{ iso: string; label?: string }>;  // options we offered
  participants_emails: string[];                    // who the meeting's for
  duration_min: number;
}

/**
 * decision.data for slot_pick:
 *   { slot_iso: '2026-04-19T11:15:00' }  -- must match or be close to one of payload.slots
 * Freshness check (B7):
 *   Re-query free/busy for all participants. If the chosen slot is no longer
 *   free, create a calendar_conflict approval with fresh options, supersede the
 *   current one, and return superseded.
 */
async function resolveSlotPick(
  approval: Approval,
  decision: ResolveDecision,
  ctx: ResolveContext,
): Promise<ResolveResult> {
  if (decision.verdict !== 'approve') {
    // amend and reject are handled generically above; this is a safety net.
    return {
      ok: false,
      approval_id: approval.id,
      status: approval.status,
      reason: 'slot_pick resolver only handles verdict=approve (amend/reject are handled generically)',
    };
  }

  const payload = JSON.parse(approval.payload_json) as SlotPickPayload;
  const chosenIso = (decision.data?.slot_iso as string | undefined) ?? '';
  if (!chosenIso) {
    return {
      ok: false,
      approval_id: approval.id,
      status: 'pending',
      reason: 'decision.data.slot_iso is required',
    };
  }
  const chosenDt = DateTime.fromISO(chosenIso);
  if (!chosenDt.isValid) {
    return {
      ok: false,
      approval_id: approval.id,
      status: 'pending',
      reason: `slot_iso "${chosenIso}" is not a valid ISO datetime`,
    };
  }

  if (!approval.skill_ref) {
    return {
      ok: false,
      approval_id: approval.id,
      status: 'pending',
      reason: 'slot_pick approval has no skill_ref (coord_job_id) — cannot book',
    };
  }

  const job = getCoordJob(approval.skill_ref);
  if (!job) {
    return {
      ok: false,
      approval_id: approval.id,
      status: 'pending',
      reason: `coord_job ${approval.skill_ref} not found`,
    };
  }
  if (job.status === 'booked' || job.status === 'cancelled') {
    // If it's already booked we should reflect that in the approval, not re-book.
    setApprovalDecision({
      id: approval.id,
      status: 'approved',
      decision: { slot_iso: job.winning_slot ?? chosenIso, already: job.status },
    });
    return {
      ok: true,
      approval_id: approval.id,
      status: 'approved',
      effect: `coord was already ${job.status}; approval reflects that`,
      subject: job.subject,
      slot: job.winning_slot ?? chosenIso,
    };
  }

  // Freshness re-check — catch stale slot before we book.
  // Run a best-effort getSchedule for the chosen slot ±0 window. If any
  // participant is "busy"/"tentative"/"oof" on that exact slot, supersede.
  let staleConflict: string | null = null;
  try {
    const endDt = chosenDt.plus({ minutes: payload.duration_min });
    const tz = ctx.profile.user.timezone;
    const busy = await getFreeBusy(
      ctx.profile.user.email,
      payload.participants_emails,
      chosenDt.toISO()!,
      endDt.toISO()!,
      tz,
    );
    for (const [email, slots] of Object.entries(busy)) {
      const conflict = slots.find(s => {
        if (s.status !== 'busy' && s.status !== 'tentative' && s.status !== 'oof') return false;
        // v2.0.3 — Graph getSchedule returns times in UTC (zoneless ISO). Parse
        // as UTC explicitly so comparison against chosenDt (already UTC) is correct.
        const sStart = DateTime.fromISO(s.start, { zone: 'utc' }).toMillis();
        const sEnd = DateTime.fromISO(s.end, { zone: 'utc' }).toMillis();
        const cStart = chosenDt.toMillis();
        const cEnd = endDt.toMillis();
        return sStart < cEnd && sEnd > cStart;
      });
      if (conflict) {
        staleConflict = `${email} is ${conflict.status}`;
        break;
      }
    }
  } catch (err) {
    logger.warn('Freshness re-check failed — proceeding without it', { err: String(err) });
  }

  if (staleConflict) {
    logger.info('slot went stale — superseding approval', {
      approvalId: approval.id,
      chosenIso,
      conflict: staleConflict,
    });
    // Create a new approval for the same coord with fresh options. We can't
    // easily compute fresh options inline without a richer planner, so we
    // park the coord in waiting_owner with a conflict note — the orchestrator
    // will pick it up and offer new slots next turn.
    const freshPayload: Partial<SlotPickPayload> = {
      ...payload,
      slots: [],   // explicitly empty — caller must re-plan
    };
    const follow = createApproval({
      taskId: approval.task_id,
      ownerUserId: approval.owner_user_id,
      kind: 'calendar_conflict',
      payload: { ...freshPayload, conflict_reason: staleConflict, original_slot: chosenIso },
      skillRef: approval.skill_ref,
      slackChannel: approval.slack_channel,
      slackThreadTs: approval.slack_thread_ts,
      expiresAt: approval.expires_at ?? undefined,
      notes: `supersedes ${approval.id}`,
    });
    supersedeApproval(approval.id, follow.approval.id);
    return {
      ok: false,
      approval_id: approval.id,
      status: 'superseded',
      superseded_by: follow.approval.id,
      reason: `slot no longer free (${staleConflict}) — new approval ${follow.approval.id} waiting for fresh options`,
      subject: payload.subject,
    };
  }

  // Idempotency: if we've already booked this coord at the chosen slot, don't
  // re-book. The external_event_id column flips from null to the Graph event
  // id inside bookCoordination's success path — here we just spot the happy
  // trail if we somehow got re-entered.
  if (job.external_event_id && job.winning_slot === chosenIso) {
    setApprovalDecision({
      id: approval.id,
      status: 'approved',
      decision: { slot_iso: chosenIso, external_event_id: job.external_event_id, already_booked: true },
    });
    return {
      ok: true,
      approval_id: approval.id,
      status: 'approved',
      effect: 'already booked — idempotent short-circuit',
      subject: job.subject,
      slot: chosenIso,
    };
  }

  if (!ctx.app) {
    return {
      ok: false,
      approval_id: approval.id,
      status: 'pending',
      reason: 'no Slack app in resolver context — cannot run booking synchronously',
    };
  }

  const handler = getCoordBookingHandler();
  if (!handler) {
    return {
      ok: false,
      approval_id: approval.id,
      status: 'pending',
      reason: 'no coord booking handler registered — MeetingsSkill may be disabled',
    };
  }
  try {
    const result = await handler({
      jobId: approval.skill_ref,
      chosenSlotIso: chosenIso,
      profile: ctx.profile,
      synchronous: true,
    });
    if (result.ok) {
      setApprovalDecision({
        id: approval.id,
        status: 'approved',
        decision: { slot_iso: chosenIso, booked: true, subject: result.subject },
      });
      return {
        ok: true,
        approval_id: approval.id,
        status: 'approved',
        effect: 'booked',
        subject: result.subject,
        slot: chosenIso,
      };
    }
    // Booking failed for a reason bookCoordination already surfaced to the owner.
    // Leave the approval pending so a retry can happen; record the reason.
    logger.warn('slot_pick book failed — approval stays pending', {
      approvalId: approval.id,
      reason: result.reason,
      status: result.status,
    });
    return {
      ok: false,
      approval_id: approval.id,
      status: 'pending',
      reason: result.reason ?? `booking not completed (${result.status})`,
      subject: result.subject,
      slot: chosenIso,
    };
  } catch (err) {
    logger.error('slot_pick resolver threw during book', {
      approvalId: approval.id,
      err: String(err),
    });
    return {
      ok: false,
      approval_id: approval.id,
      status: 'pending',
      reason: `booking threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Generic approve (duration_override, policy_exception, lunch_bump, unknown_person, freeform) ─

async function resolveGenericApprove(
  approval: Approval,
  decision: ResolveDecision,
): Promise<ResolveResult> {
  // amend is handled generically above before dispatching to kind — reaching
  // here with verdict !== 'approve' is a caller bug.
  const data = decision.verdict === 'approve' ? (decision.data ?? {}) : {};
  setApprovalDecision({
    id: approval.id,
    status: 'approved',
    decision: { approved: true, data },
  });
  // The downstream action for generic kinds is the orchestrator's job (the
  // owner saying "yes, override the lunch rule" still needs the orchestrator
  // to call create_meeting with the override flag set). We just record the
  // decision — the orchestrator reads `decision_json` next turn.
  return {
    ok: true,
    approval_id: approval.id,
    status: 'approved',
    effect: `approved ${approval.kind} — orchestrator should now proceed with the underlying action`,
  };
}
