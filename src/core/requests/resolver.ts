/**
 * Requests resolver (v2.7.0) — replaces core/approvals/resolver.ts.
 *
 * Single entry point for owner-decision side-effects. The orchestrator never
 * calls book/cancel/DM directly; it calls resolveRequest with the request id
 * and a verdict. This file owns per-kind downstream behavior — booking the
 * meeting on slot_pick approval, notifying the requester, etc.
 *
 * Then it calls closeRequest, which is the single closure entry. All audit,
 * cascade, and timer-clearing happen there.
 */

import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import type { UserProfile } from '../../config/userProfile';
import { getRequest, mergeRequestDetails, updateRequest } from '../../db/requests';
import { closeRequest } from './closeRequest';
import type { RequestRow } from './types';
import { parseDetails } from './types';
import { getFreeBusy } from '../../connectors/graph/calendar';
import { runPostBookingHealthCheck } from '../../utils/postBookingHealthCheck';
import { getCoordBookingHandler } from '../approvals/coordBookingHandler';
import logger from '../../utils/logger';

export type ResolveVerdict =
  | { verdict: 'approve'; data?: Record<string, unknown> }
  | { verdict: 'reject'; reason?: string }
  | { verdict: 'amend'; counter: Record<string, unknown>; reason?: string }
  | { verdict: 'cancel'; reason?: string };

export interface ResolveContext {
  app?: App;
  profile: UserProfile;
}

export interface ResolveResult {
  ok: boolean;
  request_id: string;
  state: RequestRow['state'];
  effect?: string;
  reason?: string;
  subject?: string;
  slot?: string;
}

// ── Entry ───────────────────────────────────────────────────────────────────

export async function resolveRequest(
  requestId: string,
  verdict: ResolveVerdict,
  ctx: ResolveContext,
): Promise<ResolveResult> {
  const row = getRequest(requestId);
  if (!row) {
    return { ok: false, request_id: requestId, state: 'cancelled', reason: 'request not found' };
  }
  if (row.state !== 'awaiting_owner') {
    logger.warn('resolveRequest called on non-awaiting_owner request', {
      id: requestId, state: row.state, kind: row.kind,
    });
    return {
      ok: false,
      request_id: requestId,
      state: row.state,
      reason: `request is in state ${row.state}; only awaiting_owner can be resolved`,
    };
  }

  logger.info('resolveRequest', {
    id: requestId, kind: row.kind, subkind: row.subkind, verdict: verdict.verdict,
  });

  // ── reject / cancel ────────────────────────────────────────────────────
  if (verdict.verdict === 'reject' || verdict.verdict === 'cancel') {
    const reason = verdict.reason ?? `owner ${verdict.verdict}ed`;
    closeRequest({
      id: requestId,
      state: 'cancelled',
      closureReason: reason,
      closedBy: 'owner',
    });
    await notifyRequesterOfDecision(row, 'reject', null, verdict.reason, ctx);
    return {
      ok: true, request_id: requestId, state: 'cancelled',
      effect: `${verdict.verdict}ed; linked work cancelled`,
    };
  }

  // ── amend ──────────────────────────────────────────────────────────────
  if (verdict.verdict === 'amend') {
    // Amend means owner proposed an alternative shape. The request stays
    // alive (in_flight) — orchestrator's next turn relays the counter to
    // the requester. Closure happens later when the counter is accepted /
    // rejected.
    updateRequest(requestId, {
      state: 'in_flight',
      details: { ...(parseDetails(row) ?? {}), counter: verdict.counter, amended_at: DateTime.now().toISO() },
    });
    await notifyRequesterOfDecision(row, 'amend', verdict.counter, verdict.reason, ctx);
    return {
      ok: true, request_id: requestId, state: 'in_flight',
      effect: 'owner proposed a counter — relay to requester next turn',
    };
  }

  // ── approve ────────────────────────────────────────────────────────────
  const approveData = verdict.data ?? {};

  // Subkind-specific side-effects on approve. Covers both:
  //   - standalone approval requests (kind=approval) raised by create_approval
  //   - coord requests that hit a rule (kind=coord, subkind flipped to
  //     slot_pick/calendar_conflict by emitWaitingOwnerApproval)
  if ((row.kind === 'approval' || row.kind === 'coord')
      && (row.subkind === 'slot_pick' || row.subkind === 'calendar_conflict')) {
    return resolveSlotPickApproval(row, approveData, ctx);
  }

  // v2.7.2 — deferred action replay. When the approval was raised because a
  // rule fired and the caller stamped a `deferred_action` on details_json
  // (the "redirect URL token" pattern: tool name + args saved at the moment
  // of the rule violation), replay the action with allowRelaxed/relaxed=true
  // when the owner approves. Closes the long-standing gap where approving a
  // policy_exception didn't actually do the underlying booking — Sonnet was
  // expected to retry but often didn't (Ysrael 2026-05-12 / Yael 2026-06-17).
  //
  // Shape: details_json.deferred_action = { tool: string, args: Record<string, unknown> }.
  // tool ∈ { 'create_meeting', 'move_meeting', 'book_floating_block' }.
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  const deferred = details.deferred_action as { tool?: string; args?: Record<string, unknown> } | undefined;
  if (deferred && typeof deferred.tool === 'string' && deferred.args && typeof deferred.args === 'object') {
    const supportedTools = new Set(['create_meeting', 'move_meeting', 'book_floating_block']);
    if (supportedTools.has(deferred.tool)) {
      // Inject relaxed=true (or confirm_outside_window=true for book_floating_block)
      // so the replay bypasses the same soft rule that triggered this approval.
      const replayArgs: Record<string, unknown> = { ...deferred.args };
      if (deferred.tool === 'book_floating_block') {
        replayArgs.confirm_outside_window = true;
      } else {
        replayArgs.relaxed = true;
      }
      logger.info('resolveRequest — deferred_action replay', {
        id: requestId, tool: deferred.tool, kind: row.kind, subkind: row.subkind,
      });
      // Stamp the request as resolved BEFORE the tool fires so any cascade
      // (closeMeetingArtifacts) doesn't see a still-open row when it sweeps.
      closeRequest({
        id: requestId,
        state: 'resolved',
        closureReason: `owner approved ${row.subkind ?? row.kind} (auto-replayed ${deferred.tool})`,
        closedBy: 'owner',
        outcomeJson: { approved: true, data: approveData, replayed: deferred.tool },
      });
      // Fire-and-forget the replay so this resolver doesn't block on the
      // Graph call. The orchestrator will narrate the booking on the next
      // owner turn (it sees the calendar update); for now just kick the work
      // and let the cascade close downstream artifacts.
      setImmediate(async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { runDeferredAction } = require('./deferredActionReplay') as
            typeof import('./deferredActionReplay');
          await runDeferredAction({
            ownerUserId: row.owner_user_id,
            profile: ctx.profile,
            tool: deferred.tool!,
            args: replayArgs,
            requestId: row.id,
          });
        } catch (err) {
          logger.warn('deferred_action replay threw — owner needs to retry manually', {
            id: row.id, tool: deferred.tool, err: String(err).slice(0, 300),
          });
        }
      });
      await notifyRequesterOfDecision(row, 'approve', approveData, undefined, ctx);
      return {
        ok: true, request_id: requestId, state: 'resolved',
        effect: `approved ${row.kind}/${row.subkind ?? '-'} — auto-replaying ${deferred.tool}`,
      };
    }
  }

  // No deferred action — close + notify. Sonnet retries the underlying action
  // next turn if needed. (Legacy path for approvals without deferred_action.)
  closeRequest({
    id: requestId,
    state: 'resolved',
    closureReason: `owner approved ${row.subkind ?? row.kind}`,
    closedBy: 'owner',
    outcomeJson: { approved: true, data: approveData },
  });
  await notifyRequesterOfDecision(row, 'approve', approveData, undefined, ctx);
  return {
    ok: true, request_id: requestId, state: 'resolved',
    effect: `approved ${row.kind}/${row.subkind ?? '-'}`,
  };
}

// ── slot_pick / calendar_conflict booking flow ──────────────────────────────

interface SlotPickDetails {
  coord_job_id?: string;
  subject?: string;
  slots?: Array<{ iso: string; label?: string }>;
  participants_emails?: string[];
  duration_min?: number;
}

async function resolveSlotPickApproval(
  row: RequestRow,
  data: Record<string, unknown>,
  ctx: ResolveContext,
): Promise<ResolveResult> {
  const details = (parseDetails<SlotPickDetails & { winning_slot?: string }>(row) ?? {});
  // Sonnet may omit slot_iso when the slot is already determined (coord
  // resolved to winning_slot before asking owner). Fall back to that.
  const chosenIso = (data.slot_iso as string | undefined)
    ?? details.winning_slot
    ?? '';
  if (!chosenIso) {
    return {
      ok: false, request_id: row.id, state: row.state,
      reason: 'slot_pick approve requires data.slot_iso (or details.winning_slot)',
    };
  }
  const chosenDt = DateTime.fromISO(chosenIso);
  if (!chosenDt.isValid) {
    return {
      ok: false, request_id: row.id, state: row.state,
      reason: `slot_iso "${chosenIso}" is not a valid ISO datetime`,
    };
  }

  const coordJobId = details.coord_job_id;
  if (!coordJobId) {
    return {
      ok: false, request_id: row.id, state: row.state,
      reason: 'slot_pick details missing coord_job_id',
    };
  }
  const durationMin = details.duration_min ?? 30;
  const participantsEmails = details.participants_emails ?? [];
  const subject = details.subject ?? row.subject;

  // Freshness re-check — catch stale slot before we book.
  let staleConflict: string | null = null;
  try {
    const endDt = chosenDt.plus({ minutes: durationMin });
    const tz = ctx.profile.user.timezone;
    const busy = await getFreeBusy(
      ctx.profile.user.email,
      participantsEmails,
      chosenDt.toISO()!,
      endDt.toISO()!,
      tz,
    );
    for (const [email, slots] of Object.entries(busy)) {
      const conflict = slots.find(s => {
        if (s.status !== 'busy' && s.status !== 'tentative' && s.status !== 'oof') return false;
        const sStart = DateTime.fromISO(s.start).toMillis();
        const sEnd = DateTime.fromISO(s.end).toMillis();
        const cStart = chosenDt.toMillis();
        const cEnd = endDt.toMillis();
        return sStart < cEnd && sEnd > cStart;
      });
      if (conflict) { staleConflict = `${email} is ${conflict.status}`; break; }
    }
  } catch (err) {
    logger.warn('resolveSlotPickApproval — freshness re-check failed, proceeding', {
      err: String(err).slice(0, 200),
    });
  }

  if (staleConflict) {
    // Stale slot — flip back to awaiting_owner with conflict_reason in details,
    // orchestrator's next turn will offer fresh options.
    mergeRequestDetails(row.id, {
      stale_conflict: staleConflict,
      stale_at_iso: chosenIso,
      slots: [],   // explicitly empty — caller must re-plan
    });
    return {
      ok: false, request_id: row.id, state: 'awaiting_owner',
      reason: `slot no longer free (${staleConflict}) — request stays awaiting_owner for fresh options`,
      subject,
    };
  }

  // Idempotency: if outcome_external_event_id already set + matches, skip.
  if (row.outcome_external_event_id) {
    closeRequest({
      id: row.id, state: 'resolved',
      closureReason: 'already_booked_idempotent',
      closedBy: 'system',
      outcomeJson: { slot_iso: chosenIso, external_event_id: row.outcome_external_event_id, already_booked: true },
    });
    return {
      ok: true, request_id: row.id, state: 'resolved',
      effect: 'already booked — idempotent short-circuit',
      subject, slot: chosenIso,
    };
  }

  if (!ctx.app) {
    return { ok: false, request_id: row.id, state: 'awaiting_owner', reason: 'no Slack app in resolver context — cannot book synchronously' };
  }

  const handler = getCoordBookingHandler();
  if (!handler) {
    return { ok: false, request_id: row.id, state: 'awaiting_owner', reason: 'no coord booking handler registered — MeetingsSkill may be disabled' };
  }

  try {
    const result = await handler({
      jobId: coordJobId,
      chosenSlotIso: chosenIso,
      profile: ctx.profile,
      synchronous: true,
    });
    if (result.ok) {
      closeRequest({
        id: row.id, state: 'resolved',
        closureReason: 'owner_approved_slot_pick_and_booked',
        closedBy: 'owner',
        outcomeExternalEventId: result.externalEventId ?? undefined,
        outcomeJson: { slot_iso: chosenIso, booked: true, subject: result.subject },
      });
      void runPostBookingHealthCheck({
        profile: ctx.profile,
        slotIso: chosenIso,
        subject: result.subject ?? subject ?? 'meeting',
      });
      return { ok: true, request_id: row.id, state: 'resolved', effect: 'booked', subject: result.subject, slot: chosenIso };
    }
    // Booking failed — leave request awaiting_owner so retry can happen.
    logger.warn('resolveSlotPickApproval — booking failed, request stays awaiting_owner', {
      id: row.id, reason: result.reason, status: result.status,
    });
    return {
      ok: false, request_id: row.id, state: 'awaiting_owner',
      reason: result.reason ?? `booking not completed (${result.status})`,
      subject: result.subject, slot: chosenIso,
    };
  } catch (err) {
    logger.error('resolveSlotPickApproval — booking threw', { id: row.id, err: String(err) });
    return {
      ok: false, request_id: row.id, state: 'awaiting_owner',
      reason: `booking threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Requester loop-close DM ─────────────────────────────────────────────────

async function notifyRequesterOfDecision(
  row: RequestRow,
  verdict: 'approve' | 'reject' | 'amend',
  data: Record<string, unknown> | null,
  reason: string | undefined,
  ctx: ResolveContext,
): Promise<void> {
  const requesterSlackId = row.requester_slack_id;
  if (!requesterSlackId) return;  // owner-internal request, nothing to close back
  // For coord/slot_pick the coordinator's own loop-close path handles it.
  if (row.kind === 'coord') return;
  if (row.kind === 'approval' && (row.subkind === 'slot_pick' || row.subkind === 'calendar_conflict')) return;

  const details = parseDetails(row) ?? {};
  const requesterName = row.requester_name ?? (details.requester_name as string | undefined);
  const subject =
    (typeof details.subject === 'string' && details.subject) ||
    (typeof details.question === 'string' && details.question) ||
    row.subject ||
    'that ask';

  const { getConnection } = await import('../../connections/registry');
  const conn = getConnection(row.owner_user_id, 'slack');
  if (!conn) {
    logger.warn('notifyRequesterOfDecision — no Slack connection', { id: row.id });
    return;
  }

  const ownerFirst = ctx.profile.user.name.split(' ')[0];
  const hi = requesterName ? `Hey ${requesterName.split(' ')[0]}` : 'Hey';
  let body: string;
  if (verdict === 'approve') {
    body = `${hi} — ${ownerFirst} said yes on ${subject}. I'll take it from here, will let you know once it's sorted.`;
  } else if (verdict === 'reject') {
    const reasonTail = reason && reason.trim() ? ` (${reason.trim()})` : '';
    body = `${hi} — ${ownerFirst} can't make that work right now${reasonTail}. Sorry about that — happy to find another path if you want.`;
  } else {
    const counterSummary = summarizeCounter(data);
    body = `${hi} — ${ownerFirst} suggested a different approach${counterSummary ? ': ' + counterSummary : ''}. Does that work for you?`;
  }

  // MPIM origin → post back in MPIM thread; else 1:1 DM.
  try {
    if (row.origin_is_mpim && row.origin_channel) {
      const res = await conn.postToChannel(row.origin_channel, body, { threadTs: row.origin_thread_ts ?? undefined });
      if (res.ok) {
        logger.info('notifyRequesterOfDecision — posted in MPIM origin', { id: row.id, channel: row.origin_channel });
        return;
      }
      logger.warn('notifyRequesterOfDecision — MPIM post failed, falling back to 1:1 DM', {
        id: row.id, reason: res.reason,
      });
    }
    const res = await conn.sendDirect(requesterSlackId, body);
    if (!res.ok) {
      logger.warn('notifyRequesterOfDecision — direct DM failed', {
        id: row.id, requesterSlackId, reason: res.reason,
      });
    }
  } catch (err) {
    logger.warn('notifyRequesterOfDecision — threw, non-fatal', {
      id: row.id, err: String(err).slice(0, 200),
    });
  }
}

function summarizeCounter(data: Record<string, unknown> | null): string {
  if (!data) return '';
  if (typeof data.text === 'string' && data.text.trim()) return data.text.trim();
  if (typeof data.slot_iso === 'string') return `a different time (${data.slot_iso})`;
  if (typeof data.to === 'string') return `move it to ${data.to}`;
  return '';
}
