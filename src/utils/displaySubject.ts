/**
 * Privacy-aware subject display (v2.7.4).
 *
 * Maelle reads raw event subjects from Microsoft Graph for legitimate internal
 * use — classification, attendee lookup, category detection, conflict
 * reasoning. But when she WRITES a subject to Slack, email, brief items,
 * outreach DMs, or any other surface a third party might see, she must mask
 * subjects of events marked private. Otherwise an interview booking,
 * personal matter, or sensitive 1:1 leaks via casual narration.
 *
 * Single source of truth for "what subject to show". Used everywhere Maelle
 * emits an event subject to text. The mask criteria:
 *
 *   1. Graph `sensitivity` is `'private'` or `'personal'` — Outlook user marked
 *      the event private; respect it. Idan's Interview events default to
 *      private via Outlook's category-level setting.
 *   2. Any of the event's categories matches a profile category that carries
 *      `sets_sensitivity_private: true` — owner can extend privacy via yaml
 *      without touching Outlook (e.g., a "Confidential" workspace category).
 *
 * When either trips, the function returns the literal `[Private]` mask.
 * Callers should NEVER concatenate event.subject directly — always go
 * through this helper. The internal use sites that LEGITIMATELY need the raw
 * subject (autoCategorize's classifier prompt, detectCategory, etc.) read
 * event.subject directly with intent; they just must not pass that raw
 * subject downstream into Slack-bound data.
 *
 * ── WHO is looking (v4.1.x — M10, both halves) ───────────────────────────────
 * Masking is an AUTHORIZATION decision, so it needs the authenticated caller,
 * not just the event. Pre-fix the predicate took no viewer, which broke M10 in
 * BOTH directions at once:
 *   • the OWNER's own get_calendar came back with his interviews titled
 *     "[Private]" (he must always see everything — he is the one who marked it);
 *   • colleague-reachable payloads that never called this helper at all
 *     (checkSlot's owner_busy label, check_join_availability, the search's
 *     `over_optional` tag) shipped RAW subjects of the owner's private meetings
 *     into a colleague turn's model context.
 * The fix is one param, `viewer`, and a mask decision made where the payload is
 * PRODUCED — never an output scrubber. Default is `'other'` (mask): when a
 * caller's permission is unclear the safe answer is to return less.
 *
 * `'owner'` means the owner in a surface only he can read. Owner-in-MPIM is
 * deliberately NOT owner here — colleagues read that transcript — which is the
 * same posture as the `isOwnerDm` audit gate in the get_calendar handler.
 *
 * ── ATTENDEE-AWARE, not just private-aware (v4.4.9 — #154) ──────────────────
 * `viewer` alone only ever asked "owner or not" — so a genuine colleague got
 * the raw subject of ANY non-private event, including one he isn't on at all
 * (a stranger's 1:1, the CFO's review). `displaySubject`'s optional 4th param,
 * `viewerEmail` — resolved by `viewerEmailFor` — adds the second test: a
 * colleague who is not an attendee (or organizer) of THIS event never sees its
 * subject, private or not. Existence, time and attendee NAMES stay visible
 * either way (owner ruling: "he can know who is attending that meeting,
 * nothing else") — only the subject text goes through this stricter gate.
 * Opt-in on purpose: a caller that hasn't resolved a specific colleague's
 * identity (or has already scoped the event list to only that colleague's own
 * meetings) keeps the original private-flag-only behaviour.
 *
 * Email is the SAME kind of exception, for a different reason (v4.4.x). Every
 * inbound email turn is stamped `senderRole:'owner'` (there's no other sender
 * to authenticate against — see connectors/email/inbound.ts), but the reply
 * Maelle drafts is text the owner forwards on VERBATIM to whoever is on the
 * other end of that email chain — an external party, not the owner reading a
 * private surface. `runOutputGates` already treats the email leg as the
 * EXTERNAL frame for exactly this reason (see runEmailLegGates's doc comment:
 * "the gate follows the eventual READER, not the addressee"). The viewer
 * predicate has to agree, or a private meeting's real subject rides into the
 * one payload (`over_optional` / `attendee_conflicts` in
 * connectors/graph/findAvailableSlots.ts) that gets echoed straight into an
 * externally-forwarded reply. So `channel === 'email'` forces `'other'` even
 * though `senderRole` reads `'owner'`.
 */

import type { UserProfile } from '../config/userProfile';
import type { ChannelId } from '../skills/types';
import { getPersonMemory } from '../db';

interface SubjectableEvent {
  subject?: string | null;
  sensitivity?: string;
  categories?: unknown;
  // v4.4.9 (#154) — feeds the attendee-aware half of the mask below. Optional
  // and loosely typed (a subset of Graph's real shape) so every existing
  // caller that never had attendee data to pass keeps compiling unchanged.
  organizer?: { emailAddress?: { address?: string | null } | null } | null;
  attendees?: Array<{ emailAddress?: { address?: string | null } | null } | null> | null;
}

/** Who the produced text is for. 'other' = anyone who is not the owner alone. */
export type SubjectViewer = 'owner' | 'other';

// Exported so callers building a NARRATION fallback (e.g. "an optional
// meeting" when there's nothing better to call a slot's occupant) can treat
// the mask the same way they already treat an empty subject — see
// scheduleRules.ts's overOptional / overCommitment.subject.
export const PRIVATE_MASK = '[Private]';

/**
 * THE viewer predicate — derived from the AUTHENTICATED sender (Slack-verified
 * `senderRole`), never from anything claimed in a message. Structural fields
 * only so `utils` doesn't take a dependency on SkillContext.
 *
 * Keys off `surface` (the turn's 3-way room/owner_dm/colleague_dm location —
 * `skills/types.ts`'s `SkillContext.surface`, v4.4.x #154), not `isMpim`.
 * For every LIVE turn the two were already equivalent (processMessage.ts
 * clamps `senderRole` to 'colleague' for both isMpim AND isChannel before it
 * ever reaches here, so senderRole==='owner' already implied surface===
 * 'owner_dm'). The gap `isMpim` alone left open was replay: deferredAction
 * Replay.ts hardcodes `senderRole:'owner'` for every replay (the approved
 * action always executes with owner privilege) but sets `isMpim` to true
 * only for a 'room'-origin request — a colleague-DM-origin replay
 * (surface:'colleague_dm', isMpim:false) still read as the full 'owner'
 * viewer, so a replayed create_meeting/move_meeting could narrate a
 * conflicting PRIVATE event's real subject back into that colleague's own
 * DM (#154-replay-surface). Checking `surface === 'owner_dm'` directly closes
 * it: that colleague-DM replay now correctly reads as 'other'.
 */
export function subjectViewerFor(
  caller: { senderRole?: 'owner' | 'colleague'; surface?: 'owner_dm' | 'colleague_dm' | 'room'; channel?: ChannelId } | undefined,
): SubjectViewer {
  return caller?.senderRole === 'owner' && caller.surface === 'owner_dm' && caller.channel !== 'email'
    ? 'owner'
    : 'other';
}

/**
 * v4.4.9 (#154) — the requesting COLLEAGUE's own email, resolved from their
 * authenticated Slack id, for `displaySubject`'s attendee-aware test below.
 * Returns `undefined` for anyone this doesn't apply to (displaySubject keeps
 * its old, private-flag-only behaviour, so every caller that never opts in is
 * unaffected); `null` for a genuine colleague whose email didn't resolve —
 * M10's default, unclear identity means return less, so that reads as "mask
 * unconditionally", not "skip the check".
 *
 * o#217 — gated on BOTH `senderRole === 'colleague'` AND
 * `surface === 'colleague_dm'`. `senderRole` alone used to be the whole gate,
 * on the theory that it "never fires for the owner-in-a-group case" — false:
 * processMessage.ts:123 clamps `senderRole` to 'colleague' for the owner too,
 * whenever he's in a room (MPIM/channel), and his `userId` is NOT clamped —
 * it's still his own real Slack id. So the old gate resolved the OWNER's own
 * email via `getPersonMemory`, which trivially passes the attendee test on
 * nearly every event on his own calendar — unmasking a private subject into a
 * room full of colleagues, exactly what this branch exists to keep masked.
 * Requiring `surface === 'colleague_dm'` restricts the unmask to a genuine
 * 1:1 colleague DM, where the asker really is the whole audience.
 *
 * This does NOT reopen the replay gap `subjectViewerFor` closed
 * (#154-replay-surface): a colleague-DM- or owner-DM-origin replay's
 * synthetic context carries `senderRole: 'owner'` (deferredActionReplay.ts
 * hardcodes it for every replay) and `userId: ownerUserId`, never the
 * original requester's own slack id — so for THOSE two surfaces the
 * `senderRole === 'colleague'` bail below still excludes the replay (no
 * correct email to resolve for a colleague_dm replay; owner_dm doesn't need
 * one — `subjectViewerFor` already reads it as the full 'owner' viewer).
 * `surface === 'room'` is the ONE exception, checked BEFORE that bail — see
 * the room-tightening note below
 * (gh#room-origin-replay-narrates-unmasked-title-on-success, 2026-08-12): a
 * room-origin replay has no identifiable colleague either, but unlike the
 * other two surfaces it must still mask, because the room itself hasn't
 * changed just because the synthetic context says 'owner'.
 *
 * gh#154-W5/gh#154-R4 (2026-08-06) — a Slack ROOM turn (MPIM/channel) has no single
 * identifiable colleague either, yet must mask at least as strictly as a 1:1
 * DM (owner ruling: a room is never MORE permissive than a DM). That
 * tightening now lives HERE, keyed on `surface === 'room'` → `null` (opts
 * into the strict test with nobody able to pass it), rather than as a
 * `?? null` coerced onto this function's result at each of its 9 call sites —
 * which is what gh#154-R4 originally shipped, and which flattened EVERY `undefined`
 * into `null` regardless of why it was returned, including the EMAIL leg
 * (`senderRole` reads `'owner'` there, so this function already opts out
 * above `?? null` just reasserted `null` anyway) — masking every forwarded
 * meeting subject in an email reply, not only the private ones, on a channel
 * the owner ruled out of scope for this build entirely. Scoping the room
 * tightening to inside this one function restores every other surface's
 * (`owner_dm`, `email`) original opt-out, and removes the need for any call
 * site to know a surface exists at all — call `viewerEmailFor(context)`
 * directly, never `?? null`.
 *
 * gh#room-origin-replay-narrates-unmasked-title-on-success (2026-08-12) — the
 * `surface === 'room'` check below moved BEFORE the `senderRole !== 'colleague'`
 * bail. A room-origin deferred-action replay (deferredActionReplay.ts:108,114)
 * hardcodes `senderRole: 'owner'` for every replay but sets `surface: 'room'`
 * only when the approval's own origin was a room — that combination is UNIQUE
 * to replay; a genuine LIVE turn from the owner while he is physically in a
 * room is already clamped to `senderRole: 'colleague'` before it ever reaches
 * here (processMessage.ts's clamp — see this file's top-of-function doc).
 * With the old ordering the `senderRole !== 'colleague'` bail fired first for
 * that synthetic context and returned `undefined` ("opt out, fall back to
 * privacy-flag-only"), so a room-origin replay of a successful move/update
 * narrated the REAL subject of a non-privacy-flagged event the original live
 * room turn had masked to `[Private]` via this exact room test. Checking
 * `surface === 'room'` first makes a replay mask exactly as the live room
 * turn that raised it did — regardless of what `senderRole` the synthetic
 * replay context carries — without touching the colleague_dm / owner_dm
 * behaviour above, which still needs the `senderRole` bail (no correct
 * per-colleague email exists on those two replay shapes either).
 */
export function viewerEmailFor(
  caller: { senderRole?: 'owner' | 'colleague'; surface?: 'owner_dm' | 'colleague_dm' | 'room'; userId?: string } | undefined,
): string | null | undefined {
  if (!caller) return undefined;
  if (caller.surface === 'room') return null;
  if (caller.senderRole !== 'colleague') return undefined;
  if (caller.surface === 'colleague_dm') return getPersonMemory(caller.userId ?? '')?.email?.toLowerCase() ?? null;
  return undefined;
}

/**
 * Is `viewerEmailLower` on this event — as an attendee or its organizer?
 * Internal to displaySubject's attendee-aware test.
 */
function isEventAttendee(event: SubjectableEvent, viewerEmailLower: string): boolean {
  const organizerEmail = event.organizer?.emailAddress?.address?.toLowerCase();
  if (organizerEmail === viewerEmailLower) return true;
  const attendees = Array.isArray(event.attendees) ? event.attendees : [];
  return attendees.some(a => (a?.emailAddress?.address ?? '').toLowerCase() === viewerEmailLower);
}

/**
 * Returns the privacy-aware subject for display in any user-visible text.
 * Pass the event, the owner's profile (so the category-flag check can consult
 * the yaml), WHO is going to read it, and — for a genuine colleague ask —
 * that colleague's own email. Owner → always the raw subject. A private /
 * private-category event → always `[Private]` for anyone else, whether or
 * not they're on it ("private is private").
 *
 * `viewerEmail` is the v4.4.9 (#154) attendee-aware half, and it is OPT-IN:
 *   - omitted (`undefined`) → today's behaviour: mask only when the event is
 *     privacy-flagged, else the raw subject (M10's original default — used by
 *     callers that have already scoped the event list to this viewer's own
 *     meetings, or that aren't colleague-facing at all).
 *   - passed (a colleague's email, or `null` when it didn't resolve) → a
 *     non-attendee never sees the subject, private or not. Owner ruling: "he
 *     can know who is attending that meeting, nothing else" for an event he
 *     isn't on — so the subject itself is the one thing that stays masked.
 */
export function displaySubject(
  event: SubjectableEvent,
  profile: UserProfile,
  viewer: SubjectViewer = 'other',
  viewerEmail?: string | null,
): string {
  if (viewer === 'owner') return event.subject ?? '';
  if (isEventPrivate(event, profile)) return PRIVATE_MASK;
  if (viewerEmail === undefined) return event.subject ?? '';
  if (viewerEmail && isEventAttendee(event, viewerEmail)) return event.subject ?? '';
  return PRIVATE_MASK;
}

/**
 * Boolean predicate for "is this event private?" — Graph sensitivity flag or
 * a yaml category with `sets_sensitivity_private`. Exported (o#230) so a
 * caller that shows attendee NAMES independent of the subject (a non-attendee
 * colleague may see who's on an ordinary meeting, just not its title — owner
 * ruling, o#230) can gate name-visibility on the event's OWN privacy flag
 * rather than on `displaySubject`'s per-viewer result, which also masks for
 * reasons that have nothing to do with the event being private (e.g. the
 * attendee-aware test above).
 */
export function isEventPrivate(event: SubjectableEvent, profile: UserProfile): boolean {
  const sensitivity = event.sensitivity;
  if (sensitivity === 'private' || sensitivity === 'personal') return true;
  const cats = Array.isArray(event.categories) ? (event.categories as string[]) : [];
  if (cats.length === 0) return false;
  const privateCategoryNames = new Set(
    (profile.categories ?? [])
      .filter(c => c.sets_sensitivity_private === true)
      .map(c => c.name),
  );
  return cats.some(c => privateCategoryNames.has(c));
}
