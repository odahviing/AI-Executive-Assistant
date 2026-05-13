/**
 * maybeOpenInFlightMeetingRequest (v2.7.1 — bug 2.3 / 3.1).
 *
 * Auto-tracks owner-initiated meeting work that spills past one turn. When
 * the owner asks Maelle to move / delete / find-slots-for-a-move and the
 * tool call doesn't close cleanly in that turn (returned options for the
 * owner to pick, rule_violation, not_organizer, etc.), open a follow_up
 * request row so the activity is visible in the brief and closeable via the
 * existing closeLoopOnOwnerHandled scanner.
 *
 * Closure rides on existing rails:
 *   - Underlying meeting mutation succeeds → closeMeetingArtifacts cascade
 *     closes the request via outcome_external_event_id match.
 *   - Owner says "drop it / forget it / cancel that" → closeLoopOnOwnerHandled
 *     scanner reads requests + LLM-judges + cancels.
 *
 * No new tool exposed to Sonnet; no new lifecycle. Just a deterministic
 * auto-create site that uses the existing requests spine.
 *
 * Idempotency: keyed on (owner, thread_ts, subject/event_id). Re-asking the
 * same thing in the same thread doesn't double-create.
 */

import logger from '../../utils/logger';
import { createRequest, buildIdempotencyKey, getRequestByIdempotencyKey } from '../../db/requests';

export interface MaybeOpenInput {
  ownerUserId: string;
  initiatorSlackId: string;
  initiatorRole: 'owner' | 'colleague';
  threadTs?: string;
  channel?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: unknown;
}

const TRACKED_TOOLS = new Set([
  'find_available_slots',
  'create_meeting',
  'move_meeting',
  'delete_meeting',
]);

export function maybeOpenInFlightMeetingRequest(input: MaybeOpenInput): void {
  // Owner-initiated only. Colleague-initiated meeting work is tracked via the
  // existing coord/outreach/approval flows.
  if (input.initiatorRole !== 'owner') return;
  if (!TRACKED_TOOLS.has(input.toolName)) return;

  // coordinate_meeting already creates its own coord-kind request; skipped
  // via TRACKED_TOOLS above (it's not in the set).
  const result = (input.toolResult ?? {}) as Record<string, unknown>;
  const toolInput = input.toolInput ?? {};

  // Per-tool spill detection. "Spill" = work didn't complete this turn.
  let spilled = false;
  let subject = '';
  let eventId: string | undefined;

  if (input.toolName === 'find_available_slots') {
    // Only treat this as in-flight work when it's part of an active MOVE —
    // signaled by moving_event_ids. Pure search / hypothetical / new-booking
    // exploration doesn't get a row (owner hasn't committed yet).
    const movingIds = (toolInput as { moving_event_ids?: unknown }).moving_event_ids;
    if (!Array.isArray(movingIds) || movingIds.length === 0) return;
    spilled = true;
    eventId = String(movingIds[0]);
    subject = (toolInput as { subject?: string }).subject ?? `Reschedule meeting ${eventId.slice(0, 12)}`;
  } else if (input.toolName === 'create_meeting' || input.toolName === 'move_meeting') {
    // Clean success → no row needed (work closed this turn).
    if (result.success === true) return;
    spilled = true;
    eventId = (toolInput as { meeting_id?: string }).meeting_id
            ?? (result.event_id as string | undefined)
            ?? (result.meeting_id as string | undefined);
    subject = (toolInput as { subject?: string; meeting_subject?: string }).subject
            ?? (toolInput as { meeting_subject?: string }).meeting_subject
            ?? 'Meeting';
  } else if (input.toolName === 'delete_meeting') {
    if (result.success === true || result.deleted === true) return;
    spilled = true;
    eventId = (toolInput as { meeting_id?: string }).meeting_id;
    subject = (toolInput as { meeting_subject?: string }).meeting_subject ?? 'Delete meeting';
  }

  if (!spilled) return;

  // Idempotency — same (owner, thread, subject/event) shouldn't double-open.
  // We key on event_id when available (most reliable), subject otherwise.
  const idemSource = eventId ?? subject;
  const idempotencyKey = buildIdempotencyKey({
    ownerUserId: input.ownerUserId,
    requesterSlackId: input.threadTs ?? null,
    kind: 'follow_up',
    subject: `in_flight_action:${idemSource}`,
  });

  const existing = getRequestByIdempotencyKey(idempotencyKey);
  if (existing) {
    // Already tracking — nothing to do.
    return;
  }

  try {
    createRequest({
      ownerUserId: input.ownerUserId,
      initiatedBy: input.initiatorSlackId,
      initiatedByRole: 'owner',
      kind: 'follow_up',
      subkind: 'in_flight_action',
      subject: `In flight: ${subject}`,
      description: `Calendar work for "${subject}" started this turn and didn't close — tracking until resolved.`,
      state: 'in_flight',
      informed: 1,  // owner asked for it; he already knows about it
      originChannel: input.channel,
      originThreadTs: input.threadTs,
      outcomeExternalEventId: eventId,
      idempotencyKey,
      details: {
        meeting_id: eventId,
        subject,
        triggering_tool: input.toolName,
        started_at: new Date().toISOString(),
      },
    });
    logger.info('opened in_flight_action follow_up', {
      ownerUserId: input.ownerUserId, tool: input.toolName, eventId, subject,
    });
  } catch (err) {
    // Idempotency-key collision or other DB constraint — non-fatal.
    logger.warn('maybeOpenInFlightMeetingRequest — create skipped', {
      err: String(err).slice(0, 100), tool: input.toolName,
    });
  }
}
