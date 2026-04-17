/**
 * Owner self-tracking (v1.7.4).
 *
 * The owner is treated as a regular `people_memory` row keyed on his real
 * Slack user id (NO synthetic prefix — that's reserved for SELF:<id>, which
 * holds Maelle's own identity). This means the existing social-tracking
 * machinery (engagement levels, social topics with quality + cooldown,
 * note timeline, profile dimensions) works on the owner exactly the same
 * way it works on colleagues.
 *
 * Visibility (already enforced by existing code; documented here for clarity):
 *   - Workspace contacts list (formatPeopleMemoryForPrompt) excludes the
 *     owner's own row (`WHERE slack_id != ?` with the owner id passed in)
 *     so he doesn't see himself as a contact.
 *   - Workspace contacts list is ONLY rendered for owner-role prompts.
 *     Colleagues never see other people's memory — including the owner's.
 *   - The per-sender SOCIAL CONTEXT block (buildSocialContextBlock) loads
 *     the SENDER's own row. For owner-as-sender, that's the owner row.
 *     This is how the owner sees his own social state (topics on cooldown,
 *     stale topic detection, etc.) for self-aware initiation by Maelle.
 *
 * Pre-seeding ensures the row exists from the first message — without it,
 * note_about_self would fail because appendPersonNote/recordSocialMoment
 * silently no-op on missing rows.
 */

import { getPersonMemory, upsertPersonMemory } from '../db';
import type { UserProfile } from '../config/userProfile';
import logger from '../utils/logger';

/**
 * Ensure a people_memory row exists for the owner himself.
 * Safe to call on every startup — upserts, never overwrites notes/topics.
 */
export function seedOwnerSelf(profile: UserProfile): void {
  const ownerId = profile.user.slack_user_id;
  const existing = getPersonMemory(ownerId);
  if (existing) return; // already exists — don't touch

  upsertPersonMemory({
    slackId: ownerId,
    name: profile.user.name,
    email: profile.user.email,
    timezone: profile.user.timezone,
    // Gender unknown by default; owner can confirm via confirm_gender if/when
    // it becomes relevant for Hebrew gendered forms in self-narration.
  });
  logger.info('Seeded owner self-memory row', {
    ownerId,
    name: profile.user.name,
  });
}
