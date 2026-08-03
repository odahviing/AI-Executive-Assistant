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
 * ── WHO is looking (v4.1.x — M12, both halves) ───────────────────────────────
 * Masking is an AUTHORIZATION decision, so it needs the authenticated caller,
 * not just the event. Pre-fix the predicate took no viewer, which broke M12 in
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

interface SubjectableEvent {
  subject?: string | null;
  sensitivity?: string;
  categories?: unknown;
}

/** Who the produced text is for. 'other' = anyone who is not the owner alone. */
export type SubjectViewer = 'owner' | 'other';

const PRIVATE_MASK = '[Private]';

/**
 * THE viewer predicate — derived from the AUTHENTICATED sender (Slack-verified
 * `senderRole`), never from anything claimed in a message. Structural fields
 * only so `utils` doesn't take a dependency on SkillContext.
 */
export function subjectViewerFor(
  caller: { senderRole?: 'owner' | 'colleague'; isMpim?: boolean; channel?: ChannelId } | undefined,
): SubjectViewer {
  return caller?.senderRole === 'owner' && caller.isMpim !== true && caller.channel !== 'email'
    ? 'owner'
    : 'other';
}

/**
 * Returns the privacy-aware subject for display in any user-visible text.
 * Pass the event, the owner's profile (so the category-flag check can consult
 * the yaml), and WHO is going to read it. Owner → always the raw subject.
 * Anyone else → `[Private]` when the event qualifies, else the raw subject
 * (M12: a colleague sees the subject by default; only a private one is hidden).
 */
export function displaySubject(
  event: SubjectableEvent,
  profile: UserProfile,
  viewer: SubjectViewer = 'other',
): string {
  if (viewer !== 'owner' && isEventPrivate(event, profile)) return PRIVATE_MASK;
  return event.subject ?? '';
}

/**
 * Boolean predicate for "is this event private?". Internal to displaySubject.
 */
function isEventPrivate(event: SubjectableEvent, profile: UserProfile): boolean {
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
