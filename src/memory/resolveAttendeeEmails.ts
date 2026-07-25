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

import logger from '../utils/logger';

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
    const { getPersonMemory, searchPeopleMemory } = require('../db/people') as
      typeof import('../db/people');

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

export interface ResolvedInternalAttendee {
  name: string;   // the people_memory name (canonical), for narration
  email: string;  // resolved, lowercased, internal (owner-domain)
}

/**
 * Does `query` name this person for real — a WHOLE-name / token match, not a
 * loose substring? searchPeopleMemory uses SQL LIKE '%q%', so a bare "Lori"
 * substring-matches "Gloria" and "Simon" matches "Simone". That's fine for a
 * fuzzy people search, but the deterministic attendee resolver must NEVER
 * bind the wrong person — so we re-check the match here on word boundaries.
 * Language-agnostic (splits on whitespace/punctuation; a Hebrew token compares
 * as a Hebrew token). A one-word query must equal a name token (first/last),
 * never a substring of one; a multi-word query must have all its tokens present.
 */
export function nameGenuinelyMatches(candidateName: string | undefined, candidateEmail: string | undefined, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return false;
  const name = (candidateName ?? '').toLowerCase().trim();
  const emailLower = (candidateEmail ?? '').toLowerCase().trim();
  const emailLocal = emailLower.split('@')[0];
  if (name === q || emailLower === q || emailLocal === q) return true;
  const tokenize = (s: string) => s.split(/[\s.\-_,]+/).filter(Boolean);
  const nameTokens = tokenize(name);
  const qTokens = tokenize(q);
  if (qTokens.length === 0 || nameTokens.length === 0) return false;
  // Single-word query ("Lori") → must equal a whole name token, so "Gloria"
  // and "Simone" no longer match. Multi-word ("Lori Sarsfield") → every query
  // token must be present as a name token.
  return qTokens.every(t => nameTokens.includes(t));
}

/**
 * v3.6.4 — deterministic resolution of NAMED people to KNOWN INTERNAL
 * colleagues, for the orchestrator's pre-search attendee pass.
 *
 * Given the raw participant names a colleague/owner used ("Simon", "Lori"),
 * resolve ONLY those that map to a SINGLE UNAMBIGUOUS internal colleague in
 * people_memory (same email domain as the owner). This is the "resolve WHO
 * before searching WHEN" guarantee moved into code — it must not depend on
 * Sonnet remembering to call find_slack_user.
 *
 * Deliberately conservative (owner's constraint — never mis-resolve):
 *   - 1 genuine internal match → resolved (added to the search).
 *   - 0 internal matches  → UNRESOLVED (external / unknown — email only at
 *     booking; never blocks showing options). Returned in `unresolved` so the
 *     caller can tell Sonnet "show times now, don't demand their email."
 *   - >1 DISTINCT internal people (different emails) → UNRESOLVED (ambiguous —
 *     the model disambiguates; we never fuzzy-guess which "Lori"). Duplicate
 *     rows for the SAME email (calendar + Slack) collapse to one person first.
 *   - the owner himself is DROPPED from both lists — he's the search BASE, not
 *     an attendee, and must never be flagged as an unresolved/external person.
 *     Any excludeEmails (e.g. the requester) are dropped from `resolved` too.
 *
 * The external-vs-unknown JUDGMENT on an unresolved name stays model-side (owner
 * rule); this function only guarantees the deterministic part — a KNOWN internal
 * person is always resolved, and never mis-bound.
 *
 * Pure + fail-open: any DB hiccup skips that name, never throws.
 */
export function resolveNamedInternalAttendees(params: {
  names: string[];
  ownerEmail: string;
  ownerName?: string;
  excludeEmails?: string[];
}): { resolved: ResolvedInternalAttendee[]; unresolved: string[] } {
  const { names, ownerEmail, ownerName } = params;
  if (!Array.isArray(names) || names.length === 0) return { resolved: [], unresolved: [] };
  const ownerLower = ownerEmail.toLowerCase();
  const ownerDomain = ownerLower.includes('@') ? ownerLower.split('@')[1] : '';
  if (!ownerDomain) return { resolved: [], unresolved: [] };
  const exclude = new Set<string>([ownerLower, ...(params.excludeEmails ?? []).map(e => e.toLowerCase().trim())]);
  const resolved: ResolvedInternalAttendee[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { searchPeopleMemory, getPersonByEmail } = require('../db/people') as typeof import('../db/people');
    for (const rawName of names) {
      const name = (rawName ?? '').trim();
      if (!name) continue;
      // The owner himself (named as the meeting subject, e.g. "meeting with
      // Idan and Simon") is the search base — never an attendee, never external.
      if (ownerName && nameGenuinelyMatches(ownerName, ownerEmail, name)) continue;
      let matches: Array<{ name?: string; email?: string }>;
      try {
        matches = searchPeopleMemory(name) ?? [];
      } catch {
        unresolved.push(name);  // a bad lookup ≠ resolved; let the model handle it
        continue;
      }
      // Internal = a resolvable email on the owner's own domain AND a genuine
      // whole-name match (not a loose LIKE substring — no Lori→Gloria binds).
      const internal = matches.filter(m =>
        m.email && m.email.includes('@') && m.email.toLowerCase().endsWith('@' + ownerDomain)
        && nameGenuinelyMatches(m.name, m.email, name),
      );
      // Collapse duplicate rows for the SAME person before the ambiguity test.
      // people_memory legitimately holds two rows for one human — a
      // calendar-sourced, email-only row (slack_id NULL) and the later
      // Slack-sourced row, sharing one email (e.g. luke.j@reflectiz.com). Those
      // are ONE internal person, not an ambiguous pair: email is the logical key
      // (getPersonByEmail's "Slack wins" merge). Counting raw rows made a known
      // colleague who exists as both rows read as ">1 → ambiguous" and silently
      // dropped him from the search — Luke Joas (07-24) resolved turn 1 only
      // because Sonnet happened to call find_slack_user; turn 2 she didn't and
      // he vanished from every find_available_slots slot.
      const distinctEmails = new Set(internal.map(m => m.email!.toLowerCase()));
      // SINGLE UNAMBIGUOUS internal PERSON only — never fuzzy-guess.
      if (distinctEmails.size !== 1) {
        unresolved.push(name);  // 0 (external/unknown) or >1 distinct people (ambiguous)
        continue;
      }
      const email = [...distinctEmails][0];
      if (exclude.has(email)) continue;   // requester etc. — handled elsewhere, not "external"
      if (seen.has(email)) continue;
      seen.add(email);
      // Narration name from the ONE canonical row for this email — the SAME
      // "Slack wins, then most-recent" tiebreak getPersonByEmail owns; reuse it
      // so the two never drift (a re-implemented ORDER BY would). Empty/missing
      // canonical name → the raw query name.
      const canonical = getPersonByEmail(email);
      resolved.push({ name: canonical?.name || name, email });
    }
  } catch (err) {
    logger.warn('resolveNamedInternalAttendees threw — returning what resolved', { err: String(err).slice(0, 200) });
  }
  return { resolved, unresolved };
}
