/**
 * v3.2.0 — resolve a person-write tool's target to a surrogate person_id.
 *
 * The write-tools (note_about_person / log_interaction / confirm_gender /
 * update_person_profile) used to dead-end at `unknown_colleague` whenever no
 * slack_id resolved — so a pure-email external (a gmail candidate the owner
 * has booked) could never get a note / gender / profile write. With the
 * Unified Person Store, identity is a person_id, so these tools route through
 * here: ONE resolution path for internal AND external.
 *
 * Two paths:
 *   - slack_id resolves (hallucination-guarded via resolveSlackId) → internal
 *     person: ensure the row exists, return its person_id + slack_id.
 *   - no slack_id BUT owner-path → resolvePerson by name/email finds-or-creates
 *     the external row and returns its person_id (slack_id null).
 *
 * Colleague-path with no slack_id returns null on purpose: a colleague write
 * always carries the requester's own slack_id (the self-write gate forces it),
 * and externals don't message Maelle over Slack, so there's no legitimate
 * colleague-path external write.
 */

import { resolvePerson, getPersonMemory, upsertPersonMemory } from '../db';
import { resolveSlackId } from './resolveSlackId';

export interface PersonWriteTarget {
  personId: string;
  slackId: string | null;   // null for pure-email externals
  name: string;
  hallucinated: boolean;     // resolveSlackId rejected a bad slack_id input
}

export function resolvePersonTarget(opts: {
  rawSlackId?: string;
  name?: string;
  email?: string;
  isOwner: boolean;
  ownerDomain: string;
}): PersonWriteTarget | null {
  const idRes = resolveSlackId(opts.rawSlackId, opts.name);

  if (idRes.slack_id) {
    // Internal — ensure the row exists, then read its person_id. An EXISTING
    // row keeps its stored name: upsertPersonMemory writes `name` verbatim
    // (it's built for SLACK signals, where users.info is authoritative), but
    // `opts.name` here is a model-supplied tool arg — passing it through
    // overwrote "Luke Joas" with a bare "Luke", and when the arg was omitted
    // the `?? slack_id` fallback stomped the name with a raw "U07…" string.
    // The tool-arg name only ever seeds a BRAND-NEW row.
    const existing = getPersonMemory(idRes.slack_id);
    const seedName = (opts.name ?? '').trim() || idRes.slack_id;
    upsertPersonMemory({ slackId: idRes.slack_id, name: existing?.name?.trim() || seedName });
    const row = existing ?? getPersonMemory(idRes.slack_id);
    if (!row) return null;
    return { personId: row.person_id, slackId: idRes.slack_id, name: row.name, hallucinated: idRes.was_hallucinated };
  }

  // Owner-path external: find-or-create by name / email.
  if (opts.isOwner && ((opts.name && opts.name.trim()) || (opts.email && opts.email.trim()))) {
    const resolved = resolvePerson({ name: opts.name, email: opts.email, ownerDomain: opts.ownerDomain });
    if (resolved) {
      return { personId: resolved.person_id, slackId: resolved.row.slack_id, name: resolved.row.name, hallucinated: idRes.was_hallucinated };
    }
  }

  return null;
}
