/**
 * Assistant self-memory.
 *
 * Maelle is a person. Her origin story, how she came by her name, facts Idan
 * has taught her about herself — these all belong in people_memory like any
 * other colleague, not in a separate "assistant_facts" table. That way:
 *   - the existing note_about_person / update_person_profile tools keep
 *     working on her with zero new APIs,
 *   - the same formatPeopleMemoryForPrompt pattern renders her facts in-prompt,
 *   - long-term she can learn about herself the same way she learns about
 *     anyone else.
 *
 * The slack_id for her row is a synthetic key `SELF:<ownerSlackId>` (owner-
 * scoped so multi-profile deployments each get their own self-row). No real
 * Slack user has that id shape (real ids start with 'U').
 *
 * On startup we upsert the row so it always exists. The system prompt pulls
 * it and renders the notes as a first-person "ABOUT YOU" block, visible to
 * both owner and colleagues — Maelle's identity is not private.
 */

import { getPersonMemory, upsertPersonMemory, type PersonNote, type PersonProfile, type PersonInteraction } from '../db';
import type { UserProfile } from '../config/userProfile';
import logger from '../utils/logger';

/** Synthetic slack_id used for Maelle's own people_memory row. */
export function selfSlackId(ownerSlackId: string): string {
  return `SELF:${ownerSlackId}`;
}

/**
 * Ensure a people_memory row exists for Maelle herself, and keep her core
 * identity (name, email, timezone) reconciled with the profile.
 * Safe to call on every startup — upserts identity, never overwrites
 * existing notes / interaction history (upsertPersonMemory never touches
 * those columns).
 *
 * v4.2.3 — pre-fix this early-returned whenever the row existed AND the name
 * matched, which is true on literally every boot after the first (the
 * assistant's name never changes). That froze email/timezone at whatever
 * they were the day the row was created: a later yaml correction (e.g. a
 * wrong assistant.email that never matched a real mailbox, corrected months
 * later to one that does) never propagated, because upsertPersonMemory —
 * which DOES reconcile all three safely (setPersonEmail's merge-safe
 * overwrite, the timezone provenance chokepoint, the gender_confirmed guard)
 * — was never called again after boot #1. Now every field is compared, and
 * ANY drift re-runs the same safe upsert.
 */
export function seedAssistantSelf(profile: UserProfile): void {
  const slackId = selfSlackId(profile.user.slack_user_id);
  const existing = getPersonMemory(slackId);

  const driftedFromProfile = !existing
    || existing.name !== profile.assistant.name
    || (existing.email ?? '') !== (profile.assistant.email ?? '')
    || (existing.timezone ?? '') !== (profile.user.timezone ?? '');
  if (!driftedFromProfile) return;

  upsertPersonMemory({
    slackId,
    name: profile.assistant.name,
    email: profile.assistant.email,
    timezone: profile.user.timezone,
    // Default assumption — 'Maelle' reads as female. Owner can override via
    // confirm_gender if the assistant persona should be different.
    // upsertPersonMemory never overwrites a confirmed gender
    // (gender_confirmed=1), so re-asserting this on every reconcile is safe.
    gender: 'female',
    // name/timezone here are OWNER-AUTHORED CONFIG (profile.assistant.name /
    // profile.user.timezone), never a live Slack read — 'owner' rank so a
    // later config correction always lands on the permanent column instead of
    // being treated as a differing auto-tier sync reading and silently
    // diverted (see upsertPersonMemory's `by` doc in db/people.ts).
    by: 'owner',
  });
  logger.info(existing ? 'Reconciled assistant self-memory identity from profile' : 'Seeded assistant self-memory row', {
    ownerId: profile.user.slack_user_id,
    assistantName: profile.assistant.name,
    slackId,
  });
}

/**
 * Render Maelle's self-row as a first-person "ABOUT YOU" block suitable for
 * both owner and colleague system prompts.
 *
 * Returns '' when there are no interesting facts to render — we don't want an
 * empty block polluting the prompt on a fresh install.
 *
 * includeMutationHint=true (owner-only) appends the synthetic slack_id so the
 * LLM knows how to call note_about_person / update_person_profile on itself
 * when the owner teaches it something.
 */
export function formatAssistantSelfForPrompt(
  profile: UserProfile,
  includeMutationHint: boolean,
): string {
  const slackId = selfSlackId(profile.user.slack_user_id);
  const self = getPersonMemory(slackId);
  if (!self) return '';

  let notes: PersonNote[] = [];
  let prof: PersonProfile = {};
  let log: PersonInteraction[] = [];
  try { notes = JSON.parse(self.notes || '[]'); } catch (_) {}
  try { prof  = JSON.parse(self.profile_json || '{}'); } catch (_) {}
  try { log   = JSON.parse(self.interaction_log || '[]'); } catch (_) {}

  // If there's nothing substantive, skip the block entirely.
  const anyProfile =
    prof.engagement_level || prof.communication_style || prof.language_preference ||
    prof.working_hours || prof.role_summary || prof.collaboration_notes;
  if (notes.length === 0 && !anyProfile && log.length === 0) {
    return includeMutationHint
      ? `ABOUT YOU (${profile.assistant.name}): nothing saved yet. When ${profile.user.name.split(' ')[0]} teaches you something about yourself (your name, your story, how you like to work, whether you're AI/human, your age), call note_about_self to remember it — that's the tool for facts about ${profile.assistant.name} herself.`
      : '';
  }

  const lines: string[] = [`ABOUT YOU — you are ${profile.assistant.name}, and here is what you know about yourself (speak in first person when referencing these):`];
  if (prof.role_summary)        lines.push(`  role: ${prof.role_summary}`);
  if (prof.communication_style) lines.push(`  communication style: ${prof.communication_style}`);
  if (prof.language_preference) lines.push(`  language: ${prof.language_preference}`);
  if (prof.working_hours)       lines.push(`  working hours: ${prof.working_hours}`);
  if (prof.collaboration_notes) lines.push(`  collaboration: ${prof.collaboration_notes}`);
  // v3.x (Block 3 prompt reduction) — dedup by text-prefix before rendering.
  // Capture-pass dedup is probabilistic (Haiku-judged), so exact/near-repeats
  // accumulate (the "named after the Expedition 33 character" story was stored
  // 4×). A first-80-chars key collapses those variants to one. Then cap: notes
  // carry the durable self-facts, the interaction tail is mostly redundant with
  // them, so it's capped harder.
  const dedup = <T>(arr: T[], key: (x: T) => string): T[] => {
    const seen = new Set<string>();
    return arr.filter(x => {
      const k = key(x).trim().toLowerCase().slice(0, 80);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  };
  for (const n of dedup(notes, n => n.note).slice(-15)) lines.push(`  ★ [${n.date}] ${n.note}`);
  for (const i of dedup(log, i => i.summary).slice(-4)) {
    const d = i.date.split('T')[0];
    lines.push(`  ↳ [${d}] ${i.type}: ${i.summary}`);
  }
  if (includeMutationHint) {
    lines.push(`  (To save a NEW fact about yourself when ${profile.user.name.split(' ')[0]} teaches you: call note_about_self. Keep adding — these facts make you knowable.)`);
  }
  return lines.join('\n');
}
