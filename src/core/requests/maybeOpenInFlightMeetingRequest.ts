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

// gh#placeholder-id-persisted-into-artifact — a real Microsoft Graph event id
// is a long base64url blob (observed 148 chars, "AAMkAD…", via db-query.cjs
// against a resolved outcome_external_event_id); a model-invented id
// ("placeholder", "event_id_from_calendar_placeholder") is nowhere close. 40
// is a wide margin under that observed length — comfortably clears any real
// id shape while still catching every invented one actually seen in the DB.
const MIN_PLAUSIBLE_GRAPH_ID_LENGTH = 40;
function looksLikeGraphEventId(id: string): boolean {
  return id.length >= MIN_PLAUSIBLE_GRAPH_ID_LENGTH;
}

export function maybeOpenInFlightMeetingRequest(input: MaybeOpenInput): void {
  // Owner-initiated only. Colleague-initiated meeting work is tracked via the
  // existing outreach/approval flows.
  if (input.initiatorRole !== 'owner') return;
  if (!TRACKED_TOOLS.has(input.toolName)) return;

  const result = (input.toolResult ?? {}) as Record<string, unknown>;
  const toolInput = input.toolInput ?? {};

  // v3.1.8 — a result that ASKS the owner to decide (confirm an override, approve
  // a rule exception, pick a location, confirm a duration) is a DELIBERATE PAUSE,
  // not a silently-lost action. Don't open an in-flight guard for it: the owner
  // sees the question and answers, the conversation already tracks it, and a
  // guard here just orphans when the eventual booking lands under a re-derived
  // subject (the "still working on booking Dana & Max" bug). The guard exists
  // only for actions that vanish silently — not for ones awaiting the owner.
  if (
    result._deferred_action_hint != null
    || typeof result.suggested_ask_text === 'string'
    || result.needs_confirmation === true
    || result.needs_owner_approval === true
  ) {
    return;
  }

  // v3.3.7 (#124g) — an ERRORED tool call is not a silently-lost action either.
  // The error goes straight back to Sonnet (registry wraps throws as
  // { error: "Tool ... failed: ..." }), gets narrated, and the owner retries
  // in-conversation. Opening a row here guarantees an orphan: the failed call
  // often carries a malformed/absent meeting_id (that's frequently WHY it
  // failed), so the success-retry's meeting_moved cascade can never match it —
  // it rots for 24h, pollutes the next brief ("a calendar item labeled
  // 'Meeting'"), then expires. Real case: 2026-06-09 Graph ErrorInvalidIdMalformed.
  if (typeof result.error === 'string' && result.error.length > 0) {
    return;
  }

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
    // v3.0.2 — was `Reschedule meeting ${eventId.slice(0, 12)}` which leaked
    // the first 12 chars of the Graph event_id (e.g. "AAMkADVmMjY1") into the
    // brief subject line. Sonnet quoted it verbatim → owner saw raw IDs in
    // chat. Toolinput rarely carries `subject` on find_available_slots, so this
    // fallback fires almost every time. Generic non-leak fallback now; the real
    // event_id stays in `details.meeting_id` for cascade matching but doesn't
    // surface to the brief.
    subject = (toolInput as { subject?: string }).subject ?? 'a meeting';
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

  // gh#placeholder-id-persisted-into-artifact — find_available_slots never
  // surfaces a Graph-side error for a moving_event_ids entry that doesn't
  // resolve (findAvailableSlots.ts soft-skips a non-qualifying id and still
  // returns a clean slots result), so that branch's `eventId` above is
  // whatever the model typed, never Graph-confirmed. Persisting it anyway
  // opens a row this same guard can never close — the success-retry cascade
  // matches on the real event id — the exact "guaranteed orphan" this file
  // already refuses for an errored mutation result (#124g, above). Same
  // refusal for a garbage id riding a clean result instead.
  if (eventId !== undefined && !looksLikeGraphEventId(eventId)) {
    logger.warn('maybeOpenInFlightMeetingRequest — tool-supplied id is not Graph-shaped, refusing to persist it', {
      tool: input.toolName, eventId,
    });
    return;
  }

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

  // v2.7.4 — give the row an expiry timer so the request runner sweeps it.
  // Without this, in_flight rows that never naturally close (e.g., a failed
  // tool call that nobody retries) become orphans. 24h is a reasonable
  // outer bound: if owner doesn't follow up by tomorrow's brief, the work
  // is stale. The runner's runExpiry handler closes to state='expired' on
  // fire; closeRequest cascades + informs the brief via informed=0 so it
  // surfaces once with closure narration then drops.
  const expiresAtIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // v2.8.6 — prepend the triggering verb so the brief shows WHAT was being
  // attempted, not just the event subject. Pre-fix the brief read "still in
  // flight on the Website Update calendar work" — owner didn't recognize
  // "Website Update" as the calendar subject for his recurring Onn meeting,
  // so it read as an unrelated topic. "In flight: moving Website Update"
  // makes the operation explicit.
  const verbByTool: Record<string, string> = {
    find_available_slots: 'rescheduling',
    create_meeting: 'booking',
    move_meeting: 'moving',
    delete_meeting: 'cancelling',
  };
  const verb = verbByTool[input.toolName] ?? 'updating';
  const subjectLine = `In flight: ${verb} ${subject}`;

  try {
    createRequest({
      ownerUserId: input.ownerUserId,
      initiatedBy: input.initiatorSlackId,
      initiatedByRole: 'owner',
      kind: 'follow_up',
      subkind: 'in_flight_action',
      subject: subjectLine,
      description: `Calendar work — ${verb} "${subject}" — started this turn and didn't close. Tracking until resolved.`,
      state: 'in_flight',
      informed: 1,  // owner asked for it; he already knows about it
      originChannel: input.channel,
      originThreadTs: input.threadTs,
      outcomeExternalEventId: eventId,
      idempotencyKey,
      expiresAt: expiresAtIso,
      nextCheckAt: expiresAtIso,
      nextCheckHandler: 'expiry',
      details: {
        meeting_id: eventId,
        subject,
        triggering_tool: input.toolName,
        started_at: new Date().toISOString(),
      },
    });
    logger.info('opened in_flight_action follow_up', {
      ownerUserId: input.ownerUserId, tool: input.toolName, eventId, subject, expiresAt: expiresAtIso,
    });
  } catch (err) {
    // Idempotency-key collision or other DB constraint — non-fatal.
    logger.warn('maybeOpenInFlightMeetingRequest — create skipped', {
      err: String(err).slice(0, 100), tool: input.toolName,
    });
  }
}
