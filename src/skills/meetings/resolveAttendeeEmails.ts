/**
 * Shared attendee email resolver (v3.1.4 — Y2).
 *
 * Single source of truth for "I have a name (and maybe a slack_id) — what's
 * the email?" Pre-this, the lookup chain (slack_id → people_memory, then
 * fuzzy name → people_memory) was copy-pasted inside coordinate_meeting and
 * normalizeBookingRequest, and ABSENT from update_meeting's add-attendee
 * path — so "add Eli Feldman" (name only) hit a missing-email wall and Maelle
 * asked the colleague for an email she already had on file.
 *
 * Owner direction (2026-05-29): make this a function the booking entry points
 * call, not a prompt rule. Pass a name; get the email back from the directory.
 *
 * Pure + fail-open: any DB hiccup returns the input email unchanged ('' if
 * none), never throws.
 */

import logger from '../../utils/logger';

export interface AttendeeContactInput {
  name?: string;
  email?: string;
  slack_id?: string;
}

export interface ResolvedAttendeeContact {
  name?: string;
  email: string;     // resolved, lowercased, '' when unresolvable
  slack_id?: string;
}

/**
 * Resolve a single attendee's email from people_memory when missing/malformed.
 * Chain: explicit valid email wins → slack_id lookup → fuzzy name lookup.
 */
export function resolveAttendeeEmail(input: AttendeeContactInput): ResolvedAttendeeContact {
  let email = (input.email ?? '').trim().toLowerCase();
  let name = input.name?.trim();
  const slackId = input.slack_id?.trim();

  if (email && email.includes('@')) {
    return { name, email, slack_id: slackId };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPersonMemory, searchPeopleMemory } = require('../../db/people') as
      typeof import('../../db/people');

    if (slackId) {
      const mem = getPersonMemory(slackId);
      if (mem?.email) {
        email = mem.email.toLowerCase();
        if (!name && mem.name) name = mem.name;
      }
    }
    if ((!email || !email.includes('@')) && name) {
      const matches = searchPeopleMemory(name);
      const hit = matches.find(m => m.email && m.email.includes('@'));
      if (hit) {
        email = hit.email!.toLowerCase();
        if (!name && hit.name) name = hit.name;
      }
    }
  } catch (err) {
    logger.warn('resolveAttendeeEmail threw — returning input', { err: String(err).slice(0, 200) });
  }

  return {
    name,
    email: email && email.includes('@') ? email : '',
    slack_id: slackId,
  };
}

/** Resolve a list; preserves order. */
export function resolveAttendeeEmails(list: AttendeeContactInput[]): ResolvedAttendeeContact[] {
  return list.map(resolveAttendeeEmail);
}
