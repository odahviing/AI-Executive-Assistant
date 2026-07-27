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
 *   - `relaxed` is the POST-GATE value: the raw `args.relaxed` is honored only
 *     when the AUTHENTICATED sender is the owner. `grantRelaxed` is the one
 *     function that decides it, exported so the paths that don't normalize
 *     (move_meeting) and the ones that gate before normalizing
 *     (find_available_slots) share the same decision instead of copying it.
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

  // Owner-explicit override path, already gated on the authenticated sender.
  // Handlers NEVER set this from raw args — they call `grantRelaxed` (P22).
  relaxed: boolean;
  relaxedReason: 'owner_direct' | 'none';

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

  // ── relaxed — THE grant, shared with every non-normalizing path (P22) ──
  const { relaxed, relaxedReason } = grantRelaxed(args, context);

  // ── Cross-cutting context ──
  const ctx = buildContext(profile, context, slot);

  return {
    intent,
    initiator,
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
      const { resolveAttendeeEmail } = require('../../memory/resolveAttendeeEmails') as
        typeof import('../../memory/resolveAttendeeEmails');
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

/**
 * THE only place `relaxed` is granted — for EVERY meeting path, not just the
 * ones that route through this normalizer.
 *
 * P22 (v4.2.x) — exported, and every caller now reads `args.relaxed` through
 * here. It used to be private to `normalizeBookingRequest`, so the paths that
 * never normalized (move_meeting) or that gate before normalizing
 * (find_available_slots) each re-derived the same authorization inline. Six
 * copies of one decision, and `move_meeting` was the copy that got it wrong:
 * `allowRelaxed: args.relaxed === true` with no `senderRole` conjunct at all
 * (moveMeeting.ts). That made the documented invariant *"`allowRelaxed` implies
 * the owner"* (scheduleRules.ts, rule-1 note) false in code, and violated this
 * module's own contract that handlers never set it from raw args
 * (planMeeting.ts, `allowRelaxed`). Nothing exploited it — move_meeting's
 * colleague gate validates the destination STRICTLY and returns
 * `needs_owner_approval` before the plan call, so a colleague could only reach
 * it with a slot that already passed unrelaxed. But it was one edit away from
 * waiving rules 0b, 2-4, 5, 6, 7, 8 and 9 on colleague authority, and no reader
 * could trust the invariant while a counter-example sat in the tree. One
 * function, so there is nothing left to drift.
 *
 * Owner-authenticated direct is now the ONLY grant. `senderRole` is the
 * authenticated sender post-clamp — never a claim from the message.
 *
 * The two grants that used to exist and why neither survives:
 *   • OWNER-IN-MPIM PROPOSED — D7 (owner 2026-07-26: *"yes, if i want to do
 *     something wrong in group chat, raise for approval or at least tell me"*).
 *     Silent by construction: the group-DM clamp (processMessage) makes his
 *     `senderRole` 'colleague', so planMeeting's one-step owner heads-up
 *     (`initiator === 'owner'`) could never fire while `allowRelaxed` waved
 *     eight rules through — his override waived eight rules and told him about
 *     none of them. Approval is the right half, and it is what the clamp already
 *     decided: the clamp is an anti-cheat boundary across ALL tools, and his
 *     flag-and-override in his own group DM is delivered through the approval
 *     flow, not by re-granting in-group authority. A "here's what I waived"
 *     notice instead would leave the booking on colleague-level authority and
 *     make the notice the only control — a wish, not a control. The mechanism
 *     also deserved to go on its own merits: it keyed on the literal string
 *     "sender: <owner name>" appearing in message CONTENT — an authorization
 *     decision made on a claim inside a message rather than on the authenticated
 *     sender — and read that claim with an English/Hebrew regex phrase list, so
 *     the same override was unavailable to him in Russian or Spanish and
 *     available to anyone whose message happened to contain the string.
 *   • DEFERRED REPLAY — removed here as unreachable, not as a policy change. It
 *     was gated on a `NormalizeOptions.isDeferredReplay` flag that no call site
 *     ever passed, and it did not need to: a replay runs on a synthetic context
 *     with `senderRole: 'owner'` (deferredActionReplay.ts), so it is granted by
 *     the owner branch below. A replay's relaxed still survives, exactly as it
 *     did before.
 */
export function grantRelaxed(
  args: Record<string, unknown>,
  context: SkillContext,
): { relaxed: boolean; relaxedReason: BookingRequest['relaxedReason'] } {
  const rawRelaxed = args.relaxed === true;

  if (context.senderRole === 'owner' && rawRelaxed) {
    return { relaxed: true, relaxedReason: 'owner_direct' };
  }

  if (rawRelaxed) {
    logger.info('grantRelaxed — relaxed requested on a non-owner context, DENIED', {
      requester: context.userId, isMpim: context.isMpim === true,
      isOwnerInGroup: context.isOwnerInGroup === true,
    });
  }
  return { relaxed: false, relaxedReason: 'none' };
}

/**
 * The tools whose behavior `grantRelaxed` actually decides — the three schemas
 * that expose `relaxed` (meetings.ts). A stray `relaxed` arg anywhere else
 * changes nothing, so telling the owner an override "didn't apply" there would
 * be a false reason (M11).
 */
const RELAXED_AWARE_TOOLS = new Set(['find_available_slots', 'create_meeting', 'move_meeting']);

/**
 * The DISCLOSURE half of `grantRelaxed` (owner, 2026-07-27).
 *
 * `grantRelaxed` refuses relaxed on every non-owner context, and on a shared
 * surface the owner IS a non-owner context: processMessage.ts:139 clamps his
 * `senderRole` to 'colleague' for leak-safety. That refusal is correct and stays
 * exactly as it is — the clamp is the anti-cheat boundary across all tools and
 * nothing here re-grants clamped authority.
 *
 * What was wrong is that the refusal was SILENT. It went to the log line above
 * and nowhere else, and `relaxedReason: 'none'` reads identically whether an
 * override was never asked for or asked for and dropped — so no tool result
 * could tell him. He asks to bend one of his own rules, the bend is discarded,
 * and Maelle answers the un-relaxed question as though it had landed: he asked
 * for one thing, a different thing happened, and he had no way to know.
 *
 * This returns the owner-facing disclosure; ops.ts attaches it to whatever the
 * tool returns, so it rides the booked / refused / rule_violation branches
 * alike from ONE site.
 *
 * WAS HIS AUTHORITY CLAMPED — decided from the authenticated identity, which is
 * how `rawRole` itself is decided (slack/app.ts:95-97, the one definition) and
 * how postReply already tells the clamped owner from a real colleague
 * (postReply.ts:356, :568). Deliberately NOT `isOwnerInGroup`: that flag is one
 * clamp surface of three and is OPTIONAL on SkillContext, so an absent flag
 * read as "not clamped" is precisely how the channel surface stayed silent
 * after the MPIM one was fixed. `userId` and `profile` are both REQUIRED, so
 * this half cannot be lost by an incomplete context and cannot miss a surface
 * added later. It is also the exact complement of the grant: `relaxed`
 * requested while `senderRole !== 'owner'` IS the denied branch above, so this
 * can never contradict an override that was granted.
 *
 * WHICH SURFACE — needed separately, because the disclosure must carry a true
 * reason AND a true remedy (M11), and the remedy differs per surface. The three
 * are ruled on individually, since a single conjunction that only happened to
 * cover one of them is how the gap existed:
 *   • MPIM — DISCLOSE. `isMpim` is on SkillContext, so "not in a group chat,
 *     tell me in our DM" is both true and actionable.
 *   • CHANNEL — SHOULD disclose, CANNOT yet. `isChannel` / `isOwnerInChannel`
 *     (processMessage.ts:138) never reach SkillContext, and from here a
 *     clamped-owner turn that is not an MPIM is INDISTINGUISHABLE from
 *     colleague-test. Firing the group-chat wording would state a false reason
 *     in colleague-test, and M11 makes a confident wrong reason worse than
 *     silence — so it waits on the surface being plumbed. A named dependency,
 *     not an oversight.
 *   • COLLEAGUE-TEST (processMessage.ts:123) — DO NOT disclose, by decision.
 *     He deliberately asked to be treated as a colleague in that thread to see
 *     what colleagues experience; an owner-only notice injected into the reply
 *     corrupts the very behaviour under test, and its remedy would be a lie —
 *     he IS in a 1:1 DM there, so "tell me in our DM" is false.
 *
 * A 1:1 DM keeps `senderRole === 'owner'`, so the override genuinely works and
 * this stays silent; no `relaxed` in the args means no override was attempted,
 * so an ordinary shared-surface turn is never narrated at.
 */
export function clampedRelaxedNotice(
  toolName: string,
  args: Record<string, unknown>,
  context: SkillContext,
): string | undefined {
  if (args.relaxed !== true) return undefined;
  if (!RELAXED_AWARE_TOOLS.has(toolName)) return undefined;

  const ownerClamped = context.senderRole === 'colleague'
    && context.userId === context.profile.user.slack_user_id;
  if (!ownerClamped) return undefined;
  if (context.isMpim !== true) return undefined;

  const ownerFirst = context.profile.user.name.split(' ')[0];
  return `${ownerFirst} asked to bend one of his OWN scheduling rules here ("it can be tight" / "book it anyway" / "go ahead"), and that override did NOT take effect: a rule-bend counts only when he says it in your 1:1 DM with him, never in a group chat. So this result is the UN-overridden one — every one of his rules was still enforced. SAY THAT TO HIM in this reply, in one clause: his override didn't apply, what he's looking at is the strict answer, and if he wants it applied he should tell you in your DM. NEVER narrate as though it landed ("you're OK pushing through", "since you said it can be tight"), and never present these times as already bent to fit. It's for HIM — the others in this chat need no explanation of it.`;
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
