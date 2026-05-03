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
 *   - Non-matching format AND name supplied → people_memory lookup by name,
 *     return resolved real ID, was_hallucinated=true
 *   - No people_memory hit → return null, caller decides (fail clean, or
 *     skip silently depending on call site). The tool can then surface a
 *     human error message ("I don't have a Slack ID for X — call
 *     find_slack_user first") instead of a confusing "user_not_found".
 *
 * Never throws. Logging is the caller's job — a hallucination warn lands
 * in the log so we can monitor frequency over time.
 */

import { searchPeopleMemory } from '../db/people';

/**
 * Slack user IDs match `/^[UW][A-Z0-9]{6,}$/` — `U` for users, `W` for
 * Enterprise Grid users, then 6+ uppercase alphanumeric characters. Anything
 * else (a slug like `oran_frenkel`, an email, a free-form name) is invalid.
 */
const SLACK_ID_RE = /^[UW][A-Z0-9]{6,}$/;

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
 * @param rawId  the value Sonnet passed (e.g. `"U09P4HJ317W"` or `"oran_frenkel"`)
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
  if (name && name.trim().length > 0) {
    try {
      const matches = searchPeopleMemory(name.trim());
      const hit = matches.find(p => p.slack_id && SLACK_ID_RE.test(p.slack_id));
      if (hit) {
        return {
          slack_id: hit.slack_id,
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
