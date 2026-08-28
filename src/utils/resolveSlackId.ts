/**
 * Defensive resolver for Sonnet-supplied Slack ID args (v2.4.2).
 *
 * Background: tools that take a `colleague_slack_id` arg (`message_colleague`,
 * `update_person_profile`, `note_about_person`, `confirm_gender`,
 * `log_interaction`, `create_approval`'s requester_slack_id) accept whatever
 * Sonnet provides. ~99% of the time she pulls the real ID from WORKSPACE
 * CONTACTS / inbound senderId / people_memory and the call works. The other
 * 1% she improvises a slug from the name pattern (`oran_frenkel`,
 * `yael_aharon`) and the downstream send / write fails or lands on an orphan
 * row. The same protection pattern shipped in v2.x for create_approval
 * specifically; this helper centralizes it for every internal-user tool.
 *
 * Scope (per owner direction):
 *   - INTERNAL USERS only — slack_id is the right key for colleagues who DM
 *     with Maelle. External attendees use email + calendar invite paths;
 *     they never have a slack_id and never call this code.
 *   - SLACK TRANSPORT only — relevant when slack is the active connection
 *     for the profile. Other transports (email / WhatsApp future) don't use
 *     slack_id args.
 *
 * Behaviour:
 *   - Real Slack ID format → return as-is, was_hallucinated=false
 *   - Non-matching format AND name supplied → people_memory lookup by name
 *     (whole-name match, never a substring; see the gate inline below),
 *     return resolved real ID, was_hallucinated=true
 *   - No genuine hit, or >1 distinct person genuinely matching (ambiguous) →
 *     return null, caller decides (fail clean, or
 *     skip silently depending on call site). The tool can then surface a
 *     human error message ("I don't have a Slack ID for X — call
 *     find_slack_user first") instead of a confusing "user_not_found".
 *
 * Never throws. Logging is the caller's job — a hallucination warn lands
 * in the log so we can monitor frequency over time.
 */

import { searchPeopleMemory } from '../db/people';
import { nameGenuinelyMatches } from '../memory/resolveAttendeeEmails';

/**
 * Slack user IDs match `/^[UW][A-Z0-9]{6,}$/` — `U` for users, `W` for
 * Enterprise Grid users, then 6+ uppercase alphanumeric characters. Anything
 * else (a slug like `oran_frenkel`, an email, a free-form name) is invalid.
 *
 * Exported as THE definition of the slack-id shape — callers that need the
 * test (assistant.ts, memory/peopleMemory.ts, …) import it rather than
 * re-declaring the literal, so the shape can't drift per call site.
 */
export const SLACK_ID_RE = /^[UW][A-Z0-9]{6,}$/;

export interface ResolveSlackIdResult {
  /** Real Slack ID, or null when neither rawId is valid nor name resolves. */
  slack_id: string | null;
  /** True when rawId was non-null but invalid format — caller should log warn. */
  was_hallucinated: boolean;
  /** When was_hallucinated=true and slack_id is non-null, the original bad input (for logging). */
  rejected_input?: string;
}

/**
 * Resolve a Sonnet-supplied slack_id. Cheap and synchronous — single DB
 * query in the worst case (`searchPeopleMemory`).
 *
 * @param rawId  the value Sonnet passed (e.g. `"U09EXAMPLE9"` or `"oran_frenkel"`)
 * @param name   colleague name to fall back on for people_memory lookup
 */
export function resolveSlackId(
  rawId: string | null | undefined,
  name?: string | null,
): ResolveSlackIdResult {
  // Already valid format — fast path
  if (rawId && SLACK_ID_RE.test(rawId)) {
    return { slack_id: rawId, was_hallucinated: false };
  }

  // Invalid format. Try people_memory lookup by name. Returns at most 10
  // matches (LIMIT in searchPeopleMemory), pick the first with a valid
  // slack_id — there's usually at most one match for a given full name.
  //
  // v2.6.5 — when no `name` was passed but `rawId` itself looks like a name
  // (Sonnet sometimes packs the colleague's name into the slack_id slot and
  // forgets the requester_name field), fall back to using rawId as the
  // search query. Concretely fixes the colleague-approval requester loop-close
  // (now spine-based: closeMeetingArtifacts / resolver notify the requester off
  // the request's `requester_slack_id`): when an approval lands without that
  // id resolved, the loop short-circuits and never DMs them the outcome. With
  // this fallback the same name-shaped rawId resolves to the real slack_id and
  // the loop-close fires correctly.
  const lookupName = (name && name.trim().length > 0)
    ? name.trim()
    : (rawId && rawId.trim().length > 0 ? rawId.trim() : null);
  if (lookupName) {
    try {
      // Whole-name gate: searchPeopleMemory is a bare SQL LIKE '%q%' ordered
      // by last_seen, so "Dan" substring-matches "Idan" and "Simon" matches
      // "Simone" — and this resolver BINDS an identity for person-writes
      // (resolvePersonTarget) and colleague DMs (outreach, tasks/skill), where
      // the first plausible row used to win. Same rule the deterministic
      // attendee resolvers already enforce (`nameGenuinelyMatches`,
      // memory/resolveAttendeeEmails.ts) — one matching rule for identity.
      const genuine = searchPeopleMemory(lookupName).filter(p =>
        p.slack_id && SLACK_ID_RE.test(p.slack_id)
        && nameGenuinelyMatches(p.name, p.email, lookupName),
      );
      // >1 DISTINCT slack identity genuinely matching = ambiguous — never
      // guess which human. Returning null lets the tool surface "I don't have
      // a Slack ID for X — call find_slack_user first" instead of silently
      // picking whoever was seen most recently. (slack_id is UNIQUE, so
      // duplicate rows for ONE human can't both carry an id — distinct ids
      // here are genuinely distinct people.)
      const distinct = new Set(genuine.map(p => p.slack_id as string));
      if (distinct.size === 1) {
        return {
          slack_id: [...distinct][0],
          was_hallucinated: rawId !== undefined && rawId !== null,
          rejected_input: rawId ?? undefined,
        };
      }
    } catch (_) {
      // DB error → treat as miss, return null below
    }
  }

  return {
    slack_id: null,
    was_hallucinated: rawId !== undefined && rawId !== null,
    rejected_input: rawId ?? undefined,
  };
}
