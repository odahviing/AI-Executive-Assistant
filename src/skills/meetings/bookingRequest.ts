/**
 * BookingRequest (v2.9.0) — validated, normalized input to planMeeting.
 *
 * The booking flow used to look like:
 *
 *   tool handler → ~150 lines of ad-hoc prep
 *               → (snap duration, auto-fill emails, recover thread attendees,
 *                  gate sensitivity, gate relaxed, detect owner-in-MPIM
 *                  proposal, pre-load audit context …)
 *               → planMeeting(input)
 *
 * Every new bug was a new prep step bolted on at the handler entry. The
 * resulting handler was ~700 lines, three handlers each had a different
 * subset of the same checks, contract drift between Sonnet's tool input
 * shape and downstream consumer needs (root of detectCategory's owner-
 * undercount, the 103D/F owner-in-MPIM regression, the sensitivity gate
 * being scattered, etc.).
 *
 * This module is the single normalization step. Every meeting tool's
 * handler entry now calls `normalizeBookingRequest(toolName, args, context)`
 * and the returned `BookingRequest` is the canonical shape that
 * planMeeting + every downstream consumer reads.
 *
 * Invariants the normalizer enforces:
 *   - `participants` ALWAYS contains the owner (with `isOwner: true`).
 *     Downstream code that needs "external participants only" filters by
 *     `!isOwner`. No more `+1 for owner` math.
 *   - `slot.durationMin` is snapped to `profile.meetings.allowed_durations`.
 *     `slot.endIso` is recomputed to match the snapped duration.
 *   - `relaxed` is the POST-GATE value. The raw `args.relaxed` is honored
 *     only when (a) initiator is owner, (b) owner is in an MPIM and just
 *     proposed this exact slot, or (c) the call is a deferred-replay.
 *   - `sensitivity` is the POST-GATE value. On colleague-path, dropped
 *     unless the colleague's email is in `participants`.
 *   - Emails are auto-filled from people_memory by slack_id or name match
 *     BEFORE the request leaves the normalizer. Unresolvable entries keep
 *     `email: ''` so the handler can refuse with `attendee_missing_email`.
 *
 * Phase B (rule registry) will move the inline scheduleRules.checkSlot
 * call inside planMeeting onto a declarative rule list. This module
 * doesn't touch rules — it only normalizes the input.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../../config/userProfile';
import type { SkillContext } from '../types';
import { getPersonMemory, searchPeopleMemory } from '../../db/people';
import { ownerProposedSlot } from '../../utils/ownerProposedSlot';
import logger from '../../utils/logger';

// ── Public types ────────────────────────────────────────────────────────────

export type BookingIntent = 'new_booking' | 'move' | 'cancel' | 'find_slots';

export interface BookingParticipant {
  email: string;          // empty string when unresolvable (handler refuses)
  name?: string;
  slack_id?: string;
  isOwner: boolean;       // exactly one participant has this set true (the owner)
  just_invite?: boolean;  // coord-imported FYI attendee (no slot polling)
}

export interface BookingRequest {
  intent: BookingIntent;
  initiator: 'owner' | 'colleague';
  initiatorSlackId: string;

  // Slot — durationMin is snapped to allowed_durations, slotEndIso
  // recomputed to match. Flat fields (matching the legacy PlanMeetingInput
  // shape) — handlers and rule checks read them directly. Optional for
  // find_slots / cancel paths that don't have a chosen time yet.
  slotStartIso?: string;
  slotEndIso?: string;
  durationMin?: number;

  participants: BookingParticipant[];

  subject?: string;
  body?: string;
  category?: string;
  sensitivity?: 'normal' | 'personal' | 'private' | 'confidential';

  isOnlineHint?: boolean;
  locationHint?: string;
  isRecurring?: boolean;
  isFloatingBlock?: boolean;

  // Move/cancel — reference to the existing event being mutated.
  existingEventId?: string;
  existingEventCategories?: string[];
  existingEventLocation?: string;
  existingEventIsOnline?: boolean;
  priorSlotStartIso?: string;
  priorSlotEndIso?: string;

  // Owner-explicit override path. Already gated for senderRole + owner-in-
  // MPIM-proposed. Handlers should NEVER set this from raw args directly.
  relaxed: boolean;
  relaxedReason: 'owner_direct' | 'owner_in_mpim_proposed' | 'deferred_replay' | 'none';

  // Cross-cutting signals the downstream pipeline needs. Computed once
  // here so individual rule checks / detectors don't each re-load them.
  context: {
    threadTs?: string;
    isMpim: boolean;
    isOwnerInGroup: boolean;
  };

  // Diagnostic-only — never used as logic. Original Sonnet args + tool name
  // are kept so logs / claim-checker / debug paths can correlate.
  _origin: {
    tool: string;
    rawArgs: Record<string, unknown>;
  };
}

// ── Normalizer ──────────────────────────────────────────────────────────────

export interface NormalizeOptions {
  /** Optional pre-determined intent override (e.g. for find_slots called inside coord). */
  intent?: BookingIntent;
  /** When true, treat this call as a deferred-replay — preserves relaxed=true regardless of senderRole. */
  isDeferredReplay?: boolean;
}

/**
 * Build a BookingRequest from a raw tool-call args dict. Pure, idempotent,
 * stateless — same args produce the same request. Calls into people_memory
 * + audit_log + threadAttendees registry; no Graph round-trips here.
 */
export async function normalizeBookingRequest(
  toolName: string,
  args: Record<string, unknown>,
  context: SkillContext,
  options: NormalizeOptions = {},
): Promise<BookingRequest> {
  const profile = context.profile;
  const ownerEmail = profile.user.email;
  const initiator: 'owner' | 'colleague' =
    context.senderRole === 'owner' ? 'owner' : 'colleague';

  const intent: BookingIntent = options.intent ?? inferIntentFromTool(toolName);

  // ── Participants — auto-fill emails, recover from threadAttendees, inject owner ──
  const rawAttendees = (args.attendees as Array<{ name?: string; email?: string; slack_id?: string; just_invite?: boolean }> | undefined) ?? [];
  const participants = await buildParticipants(rawAttendees, ownerEmail, context);

  // ── Slot — snap duration to allowed_durations, recompute endIso ──
  // (owner-relaxed honors the full requested length — see buildSlot)
  const slot = buildSlot(args, profile, initiator);

  // ── Sensitivity — colleague-path gate ──
  const sensitivity = await gateSensitivity(args, context, participants);

  // ── relaxed — gated by initiator + owner-in-MPIM-proposed + deferred-replay ──
  const { relaxed, relaxedReason } = await gateRelaxed(args, context, slot, options);

  // ── Cross-cutting context ──
  const ctx = buildContext(profile, context, slot);

  return {
    intent,
    initiator,
    initiatorSlackId: context.userId,
    slotStartIso: slot?.startIso,
    slotEndIso: slot?.endIso,
    durationMin: slot?.durationMin,
    participants,
    subject: args.subject as string | undefined,
    body: args.body as string | undefined,
    category: args.category as string | undefined,
    sensitivity,
    isOnlineHint: typeof args.is_online === 'boolean' ? args.is_online as boolean : undefined,
    locationHint: args.location as string | undefined,
    isRecurring: typeof args.is_recurring === 'boolean' ? args.is_recurring as boolean : undefined,
    // isFloatingBlock is set ONLY when the caller passed a real
    // is_floating_block object with a name. Pre-fix, `confirm_outside_window`
    // alone would set this true — but that flag is also valid on regular
    // move_meeting calls (owner override on a non-floating-block move).
    // The mis-tag tripped planMeeting / scheduleRules into bypassing rule 8
    // owner_busy_collision (floating blocks are exempt by design), so a
    // policy_exception approval that rode `confirm_outside_window=true`
    // through to its deferred_action move silently slipped past the
    // double-booking check the owner never explicitly approved.
    isFloatingBlock: typeof args.is_floating_block === 'object'
      && args.is_floating_block !== null
      && typeof (args.is_floating_block as { name?: unknown }).name === 'string'
      ? true
      : undefined,
    existingEventId: args.meeting_id as string | undefined,
    existingEventCategories: args.existing_categories as string[] | undefined,
    existingEventLocation: args.existing_location as string | undefined,
    existingEventIsOnline: typeof args.existing_is_online === 'boolean' ? args.existing_is_online as boolean : undefined,
    priorSlotStartIso: args.prior_start as string | undefined,
    priorSlotEndIso: args.prior_end as string | undefined,
    relaxed,
    relaxedReason,
    context: ctx,
    _origin: { tool: toolName, rawArgs: args },
  };
}

interface InternalSlot { startIso: string; endIso: string; durationMin: number }

// ── Helpers ─────────────────────────────────────────────────────────────────

function inferIntentFromTool(toolName: string): BookingIntent {
  switch (toolName) {
    case 'create_meeting':       return 'new_booking';
    case 'move_meeting':         return 'move';
    case 'delete_meeting':       return 'cancel';
    case 'find_available_slots': return 'find_slots';
    case 'book_floating_block':  return 'new_booking';
    default:                     return 'new_booking';
  }
}

async function buildParticipants(
  raw: Array<{ name?: string; email?: string; slack_id?: string; just_invite?: boolean }>,
  ownerEmail: string,
  _context: SkillContext,
): Promise<BookingParticipant[]> {
  const out: BookingParticipant[] = [];
  const seen = new Set<string>();
  const ownerLower = ownerEmail.toLowerCase();

  for (const a of raw) {
    let email = (a.email ?? '').trim().toLowerCase();
    let name = a.name?.trim();
    const slackId = a.slack_id?.trim();

    // v3.1.4 (Y2) — email auto-fill via the shared resolver (one function all
    // booking paths use: create / move / update). Only when raw email is
    // missing or malformed.
    if (!email || !email.includes('@')) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolveAttendeeEmail } = require('./resolveAttendeeEmails') as
        typeof import('./resolveAttendeeEmails');
      const resolved = resolveAttendeeEmail({ name, email, slack_id: slackId });
      if (resolved.email) email = resolved.email;
      if (!name && resolved.name) name = resolved.name;
    }

    if (email && seen.has(email)) continue;
    if (email) seen.add(email);

    out.push({
      email: email && email.includes('@') ? email : '',
      name,
      slack_id: slackId,
      isOwner: email === ownerLower,
      just_invite: a.just_invite === true,
    });
  }

  // Owner injection — exactly one participant has isOwner=true. If Sonnet
  // didn't include him, add him now. detectCategory + downstream consumers
  // read participant count off this list directly (no "+1 for owner" math
  // anywhere — root of 2026-05-19 98A misclassification).
  if (!out.some(p => p.isOwner)) {
    out.unshift({
      email: ownerEmail.toLowerCase(),
      isOwner: true,
    });
  }

  return out;
}

/** v3.5.x — the resolved duration decision for a booking. */
export interface DurationDecision {
  endIso: string;        // end to use (silently snapped, or original when honored)
  durationMin: number;   // resulting duration in minutes
  requestedMin: number;  // what the caller asked for
  snappedMin: number;    // nearest allowed preset (for the confirm message)
  needsConfirm: boolean; // true ONLY for a colleague-path off-preset long duration
}

/**
 * THE single place that decides what to do with a booking's requested duration,
 * shared by the create_meeting verify-gate (ops.ts) and `buildSlot` below — so
 * the two can't drift. They used to each carry their own snap + owner carve-out
 * (the "mirror" that let the owner-path fix half-work). Rules:
 *   - already an allowed preset → unchanged.
 *   - off by ≤5 min ("1 hour" → 55) → snap silently.
 *   - off by >5 min:
 *       · OWNER stated it → honor as-is, ONE step (#127 owner authority) — no
 *         "book the full 2h or 55?" on a length he explicitly named.
 *       · COLLEAGUE proposed it → needsConfirm (caller asks / escalates); the
 *         length is left untouched so the confirm shows the real ask.
 * Returns null when start/end don't parse — caller leaves the slot as-is.
 */
export function resolveDuration(
  startIso: string,
  endIso: string,
  profile: UserProfile,
  isOwner: boolean,
): DurationDecision | null {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const requestedMin = Math.round((endMs - startMs) / 60000);
  const allowed = profile.meetings.allowed_durations;
  if (!Array.isArray(allowed) || allowed.length === 0 || allowed.includes(requestedMin)) {
    return { endIso, durationMin: requestedMin, requestedMin, snappedMin: requestedMin, needsConfirm: false };
  }
  const snappedMin = allowed.reduce((best, c) =>
    Math.abs(c - requestedMin) < Math.abs(best - requestedMin) ? c : best, allowed[0]);
  const snapDelta = Math.abs(requestedMin - snappedMin);
  if (snapDelta <= 5) {
    return {
      endIso: new Date(startMs + snappedMin * 60000).toISOString(),
      durationMin: snappedMin, requestedMin, snappedMin, needsConfirm: false,
    };
  }
  // >5 min off the nearest preset.
  if (isOwner) {
    // Owner stated the length — honor it, one step. No snap, no confirm.
    return { endIso, durationMin: requestedMin, requestedMin, snappedMin, needsConfirm: false };
  }
  // Colleague proposing an off-preset long duration → surface a confirm upstream.
  return { endIso, durationMin: requestedMin, requestedMin, snappedMin, needsConfirm: true };
}

function buildSlot(args: Record<string, unknown>, profile: UserProfile, initiator: 'owner' | 'colleague'): InternalSlot | undefined {
  const start = (args.start as string | undefined) ?? (args.new_start as string | undefined);
  const end = (args.end as string | undefined) ?? (args.new_end as string | undefined);
  if (!start || !end) return undefined;

  // One shared decision (resolveDuration) — no second copy of the snap here.
  const d = resolveDuration(start, end, profile, initiator === 'owner');
  if (!d) return undefined;
  if (d.durationMin !== d.requestedMin) {
    logger.info('normalizeBookingRequest: snapped duration to allowed_durations', {
      requested: d.requestedMin, snappedTo: d.durationMin, allowed: profile.meetings.allowed_durations,
    });
  }
  return { startIso: start, endIso: d.endIso, durationMin: d.durationMin };
}

async function gateSensitivity(
  args: Record<string, unknown>,
  context: SkillContext,
  participants: BookingParticipant[],
): Promise<BookingRequest['sensitivity']> {
  const raw = args.sensitivity as BookingRequest['sensitivity'] | undefined;
  if (raw === undefined || raw === 'normal') return raw;

  // Owner-path: trusted, no gate.
  if (context.senderRole === 'owner') return raw;

  // Colleague-path: honor sensitivity ONLY when the colleague's email is
  // in participants. Prevents a random colleague from marking someone
  // else's meeting private.
  let colleagueEmail: string | undefined;
  try {
    const mem = getPersonMemory(context.userId);
    colleagueEmail = mem?.email?.toLowerCase();
  } catch (_) { /* fall through */ }
  const onAttendees = colleagueEmail && participants.some(p =>
    p.email.toLowerCase() === colleagueEmail,
  );
  if (!onAttendees) {
    logger.info('normalizeBookingRequest: sensitivity dropped (colleague not on attendee list)', {
      requester: context.userId,
      requesterEmail: colleagueEmail,
      requestedSensitivity: raw,
      attendeeEmails: participants.map(p => p.email),
    });
    return undefined;
  }
  return raw;
}

async function gateRelaxed(
  args: Record<string, unknown>,
  context: SkillContext,
  slot: InternalSlot | undefined,
  options: NormalizeOptions,
): Promise<{ relaxed: boolean; relaxedReason: BookingRequest['relaxedReason'] }> {
  const rawRelaxed = args.relaxed === true;

  // Deferred replay always preserves relaxed regardless of senderRole — the
  // approval already went through owner; the replay is the authoritative re-run.
  if (options.isDeferredReplay && rawRelaxed) {
    return { relaxed: true, relaxedReason: 'deferred_replay' };
  }

  // Owner-path direct: relaxed honored straight through.
  if (context.senderRole === 'owner' && rawRelaxed) {
    return { relaxed: true, relaxedReason: 'owner_direct' };
  }

  // Colleague-path inside an MPIM where owner is present. Two entry shapes
  // both auto-relax (bypass the policy_exception round-trip — owner's
  // presence in the group IS the authority):
  //   (a) Handler already pre-stamped args.relaxed=true based on its own
  //       owner-in-MPIM detection (create_meeting / move_meeting guard).
  //       Preserve the flag — the !rawRelaxed guard used to live here and
  //       silently DROPPED the pre-stamp, regressing the auto-relax path.
  //   (b) Caller didn't pre-stamp but Sonnet quoted an owner-proposed slot
  //       in the conversation history. Auto-relax fresh via
  //       ownerProposedSlot.
  if (context.isMpim === true && context.isOwnerInGroup === true) {
    if (rawRelaxed) {
      return { relaxed: true, relaxedReason: 'owner_in_mpim_proposed' };
    }
    if (slot) {
      try {
        const matched = ownerProposedSlot(
          context.conversationHistory,
          slot.startIso,
          context.profile.user.name,
          context.profile.user.timezone,
        );
        if (matched) {
          return { relaxed: true, relaxedReason: 'owner_in_mpim_proposed' };
        }
      } catch (err) {
        logger.warn('normalizeBookingRequest: owner-in-MPIM check threw', {
          err: String(err).slice(0, 200),
        });
      }
    }
  }

  return { relaxed: false, relaxedReason: 'none' };
}

function buildContext(
  _profile: UserProfile,
  context: SkillContext,
  _slot: InternalSlot | undefined,
): BookingRequest['context'] {
  return {
    threadTs: context.threadTs,
    isMpim: context.isMpim === true,
    isOwnerInGroup: context.isOwnerInGroup === true,
  };
}
