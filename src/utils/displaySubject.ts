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
 */

import type { UserProfile } from '../config/userProfile';

interface SubjectableEvent {
  subject?: string | null;
  sensitivity?: string;
  categories?: unknown;
}

const PRIVATE_MASK = '[Private]';

/**
 * Returns the privacy-aware subject for display in any user-visible text.
 * Pass the event AND the owner's profile (so the category-flag check can
 * consult the yaml). If the event qualifies as private, returns `[Private]`.
 * Otherwise returns the raw subject (or empty string if undefined).
 */
export function displaySubject(event: SubjectableEvent, profile: UserProfile): string {
  if (isEventPrivate(event, profile)) return PRIVATE_MASK;
  return event.subject ?? '';
}

/**
 * Boolean predicate for "is this event private?". Exported separately so
 * call sites that need to branch (e.g., omit a field entirely vs mask)
 * can ask the question without forcing a string answer.
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
