/**
 * Cross-cutting text scrubber (v2.0.2).
 *
 * Strips content that should NEVER reach any user, on any channel:
 *   - Sentinel tokens (NO_ISSUES, ALL_CAPS_SNAKE_CASE in general)
 *   - Tool names (analyze_calendar, get_free_busy, ... all 57 of them)
 *   - "- " separators (AI writing tell, see systemPrompt PUNCTUATION rule)
 *   - Leftover orphan backticks, empty lines, doubled whitespace
 *
 * Transport-agnostic — applies identically to Slack, email, WhatsApp.
 * Transport-specific formatting (Slack's `*bold*` dialect, HTML for email,
 * etc.) lives in `src/connections/<transport>/formatting.ts`.
 *
 * Paraphrased leaks ("the analyzer" for analyze_calendar, "my scheduler") are
 * NOT caught here — regex can't reverse paraphrase. Those are prevented by
 * the base-prompt rule ("NEVER NAME YOUR TOOLS OR INTERNAL PROCESSES") in
 * orchestrator/systemPrompt.ts. Code handles verbatim, prompt handles paraphrased.
 */

import { DateTime } from 'luxon';

// Tool names that must never appear verbatim in user-facing text. Keep in sync
// with `name: '...'` tool definitions across src/skills/ + src/core/assistant.ts
// + src/tasks/*.
const TOOL_NAMES = [
  // Calendar / meeting
  'analyze_calendar', 'book_floating_block',
  'check_calendar_health', 'check_join_availability',
  'create_meeting', 'delete_meeting', 'escalate_to_user',
  'find_available_slots', 'get_calendar', 'get_free_busy',
  'move_meeting', 'set_event_category', 'update_meeting', 'manage_calendar_issue',
  // Slack lookups
  'find_slack_channel', 'find_slack_user',
  // Knowledge
  'manage_knowledge', 'classify_document',
  // Memory / people
  'manage_preference', 'update_my_preferences', 'recall_interactions', 'update_person_profile',
  'update_person_memory', 'get_person_memory', 'confirm_gender', 'log_interaction',
  // Social writes
  'note_about_person', 'note_about_self',
  // Tasks + routines
  'create_task', 'update_task', 'get_my_tasks', 'manage_routine',
  // Briefing + approvals
  'get_briefing', 'send_briefing_now',
  'create_approval', 'resolve_approval', 'list_pending_approvals',
  // Outreach + web + summary
  'message_colleague', 'web_extract', 'web_search',
  'classify_summary_feedback', 'learn_summary_style', 'list_speaker_unknowns',
  'share_summary', 'update_summary_draft',
  // Venue (v2.9)
  'find_venue', 'rank_venue',
  // Legacy names — kept so any leak still gets scrubbed during the rollout
  'cancel_task', 'edit_task',
  'create_routine', 'delete_routine', 'update_routine', 'get_routines',
  'get_calendar_issues', 'update_calendar_issue',
  'get_company_knowledge', 'ingest_knowledge_from_url',
  'learn_preference', 'forget_preference', 'recall_preferences',
  'get_pending_requests', 'resolve_request', 'store_request', 'file_document',
  'classify_engagement',
];
const TOOL_NAME_RE = new RegExp(`\\b(?:${TOOL_NAMES.join('|')})\\b`, 'g');
// Matches ALL_CAPS_WITH_UNDERSCORES tokens (2+ segments). Real prose never
// uses this shape; known internal flags always do. Safe to strip generically.
const SENTINEL_RE = /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g;

// v2.1.6 — Microsoft Graph event/calendar IDs are opaque base64url blobs that
// start with "AAMk" and run 100+ chars. A human EA never quotes an internal
// identifier; the LLM occasionally did when narrating "here's what I'll
// delete". Deterministic strip prevents the leak regardless of prompt drift.
// Matches the ID standalone, or wrapped in Slack inline-code backticks, or in
// the "AAMk...==" terminal padding form. Very long run (≥40) avoids false
// positives on accidental AAMk words.
const GRAPH_ID_RE = /`?AAMk[A-Za-z0-9+/=_-]{40,}`?/g;

// v2.2.4 (bug 5b) — IANA timezone strings ("America/New_York", "Asia/Jerusalem",
// "Europe/London") are internal data-format names that should never reach a
// user. Operates on common shapes: standalone tokens, in parentheses
// ("(Asia/Jerusalem)"), or wrapped in inline-code. Conservative scope
// (Region/Subregion[/Sub]) avoids matching non-tz path-like strings.
//
// v3.1.2 — DO NOT convert the IANA token to its trailing city segment. The
// old behavior (`split('/').pop()`) manufactured a LOCATION from a TIMEZONE:
// "America/New_York" → "New York" for someone actually in Boston,
// "Asia/Jerusalem" → "Jerusalem" leaked into a colleague reply (real bug
// 2026-05-29). A timezone is a scheduling value, NOT where someone is — the
// person's location comes from the separate `state`/city field, never from
// the tz tag. So when a raw IANA string slips into outbound text, replace it
// with the timezone ABBREVIATION (e.g. "EDT", "GMT+3") — a legitimate time
// qualifier that names no city — or strip it if the zone can't be resolved.
const IANA_TZ_RE = /\b(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g;
function humanizeIanaToken(match: string): string {
  try {
    const dt = DateTime.now().setZone(match);
    if (dt.isValid) {
      // 'ZZZ' → short offset/abbreviation: "EDT", "GMT", "GMT+3". Never a city.
      const abbr = dt.toFormat('ZZZ');
      if (abbr && abbr.trim().length > 0) return abbr;
    }
  } catch { /* fall through to strip */ }
  // Unresolvable (not a real zone, or a non-tz path that matched the regex) —
  // strip it rather than leak the raw internal string.
  return '';
}

// v4.0.x — bare / @-prefixed Slack user id leaked as literal text (NOT a rendered
// <@…> mention): the group/DM context header feeds "Name (slack_id: U…)" and the
// model sometimes echoes the id bare (Alex Wiggins → "@U09DGGSJJP9 …", 2026-07-21).
// This deterministic scrub is the path-agnostic fix (runs on every outbound via
// formatForSlack). Wrap → <@id> so Slack renders the display name. Tuned to Slack's
// id shape: uppercase-only + a REQUIRED digit (so all-caps words like "MEETING" /
// "UPDATED" can't match); the two lookbehinds prevent double-wrapping an id already
// inside a proper <@…>/<#…> mention. Structured token → the allowed kind of regex.
const BARE_SLACK_ID_RE = /(?<!<@)(?<!<)@?\b([UW](?=[A-Z0-9]*\d)[A-Z0-9]{7,10})\b/g;

/**
 * v4.1.x (G2) — THE single definition of "a raw Slack account id shown as literal
 * text", i.e. an id this scrubber did NOT turn into a rendered `<@…>` mention.
 *
 * This module OWNS the slack-id token: it is the one component that acts on it
 * deterministically, on every outbound, on every path (formatForSlack). The
 * output-time gates are READERS — securityGate and humanGate import this pattern
 * instead of each carrying their own. Three components keeping three regexes for
 * one token is what shipped the 2026-07-21 bug: securityGate's `<@[UW]…>` trigger
 * flagged the very mention THIS function manufactures, and the Sonnet rewriter
 * stripped it out of two correct colleague replies (logs/maelle-2026-07-21.log:838,
 * :908). A rendered mention is CORRECT output, never a leak.
 *
 * The `(?<![@<])` lookbehind is what encodes that: an id inside `<@…>`, or carrying
 * an `@` prefix, is either already rendered or already handled above — only a truly
 * naked id matches. No `/g` flag on purpose: callers use `.test()`, which is
 * stateful (and therefore alternates true/false) on a global regex.
 */
export const RAW_SLACK_ID_RE = /(?<![@<])\b[UW](?=[A-Z0-9]*\d)[A-Z0-9]{7,}\b/;

export function scrubInternalLeakage(text: string): string {
  return text
    .replace(GRAPH_ID_RE, '')
    .replace(BARE_SLACK_ID_RE, '<@$1>')
    .replace(IANA_TZ_RE, humanizeIanaToken)
    // v2.3.2 — sentence-separator dashes. Both forms ("foo - bar" and the
    // em-dash "foo — bar") are AI writing tells and the prompt rule alone
    // doesn't stick. Replace with comma so the sentence still flows. Tight
    // pattern (space-dash-space) so word-internal hyphens ("10-minute",
    // "well-known") and time-range en-dashes ("12:00–12:55") are untouched.
    .replace(/ [-—] /g, ', ')
    .replace(SENTINEL_RE, '')
    .replace(TOOL_NAME_RE, '')
    .replace(/`\s*`/g, '')             // empty inline code spans left over
    .replace(/^[ \t]*[\r\n]/gm, '')    // drop lines that became empty
    .replace(/[ \t]{2,}/g, ' ')        // collapse multi-spaces
    .replace(/\n{3,}/g, '\n\n')        // collapse excessive blank lines
    .trim();
}
