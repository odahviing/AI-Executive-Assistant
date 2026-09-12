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
 *   - a real Slack ID resolves through the store and may create a row.
 *   - owner-path names use the store's whole-name picker; names alone never
 *     create. An email may create an external; conflicting handles never bind.
 *   - the owner's configured assistant identity resolves its existing SELF row.
 *
 * Colleague-path with no slack_id returns null on purpose: a colleague write
 * always carries the requester's own slack_id (the self-write gate forces it),
 * and externals don't message Maelle over Slack, so there's no legitimate
 * colleague-path external write.
 */

import { resolvePerson, getPersonMemory, findPersonByName } from '../db';
import { SLACK_ID_RE } from './resolveSlackId';

export interface PersonWriteTarget {
  personId: string;
  slackId: string | null;   // null for pure-email externals
  name: string;
  hallucinated: boolean;     // resolveSlackId rejected a bad slack_id input
  created: boolean;
}

export function resolvePersonTarget(opts: {
  rawSlackId?: string;
  name?: string;
  email?: string;
  isOwner: boolean;
  ownerDomain: string;
  assistantSelf?: { slackId: string; name: string };
}): PersonWriteTarget | null {
  const selfByName = !opts.rawSlackId && !opts.email && opts.assistantSelf &&
    opts.name?.trim().toLowerCase() === opts.assistantSelf.name.toLowerCase();
  if (opts.isOwner && opts.assistantSelf &&
      (opts.rawSlackId === opts.assistantSelf.slackId || selfByName)) {
    // A supplied real handle identifies its own row. A name shared with a
    // human is ambiguous; only an explicit SELF key can select SELF then.
    if (selfByName && findPersonByName(opts.name!).status !== 'not_found') return null;
    const row = getPersonMemory(opts.assistantSelf.slackId);
    return row ? { personId: row.person_id, slackId: null, name: row.name, hallucinated: false, created: false } : null;
  }
  const slackId = opts.rawSlackId && SLACK_ID_RE.test(opts.rawSlackId) ? opts.rawSlackId : undefined;
  if (slackId || opts.isOwner) {
    // Resolve all handles together: resolving a name to Slack first would
    // bypass the store's conflicting-email gate.
    const resolved = resolvePerson({ slackId, name: opts.name, email: opts.email, ownerDomain: opts.ownerDomain });
    if (resolved) {
      return { personId: resolved.person_id, slackId: resolved.row.slack_id, name: resolved.row.name,
        hallucinated: !!opts.rawSlackId && !slackId, created: resolved.created };
    }
  }

  return null;
}
