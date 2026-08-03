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

/**
 * v4.2.x (G2/G3) — THE shape of a Slack account id, written ONCE.
 *
 * Both regexes below are built from it: the WRAPPER that turns a naked id into a
 * rendered mention, and the READER (`RAW_SLACK_ID_RE`) that the output gates use to
 * ask "did an unwrapped id survive?". They used to be typed separately and had
 * drifted — the wrapper capped the run at `{7,10}` while the reader was open-ended
 * `{7,}` — so an id 11+ chars past the `U`/`W` was DETECTED as a leak and could
 * never be WRAPPED. securityGate then shipped the draft anyway on the
 * identifier-class fail-open whose entire justification is "textScrubber re-wraps
 * this token on the way out": a no-op for exactly the ids that reached it. That is
 * the 2026-07-01 Oran-leak shape (a raw account id in front of a colleague),
 * re-opened by a two-character width difference.
 *
 * Slack documents no maximum length for account ids (member ids have already grown
 * from 9 to 11 characters), so nothing here may assume one. Uppercase-only with a
 * REQUIRED digit is what keeps all-caps words ("MEETING", "UPDATED") out.
 */
const SLACK_ID_SHAPE = '[UW](?=[A-Z0-9]*\\d)[A-Z0-9]{7,}';

/**
 * A RENDERED mention — `<@U…>`, or the legacy `<@U…|label>`. The one form of this
 * token that is CORRECT output rather than a leak (Slack draws it as the person's
 * @name), and therefore the one form the predicate below skips.
 *
 * Rendering requires the CLOSING `>`: Slack prints `<@U…` with no `>` as literal
 * text, so a half-written mention is a raw id in a costume, not a mention.
 */
const RENDERED_MENTION = `<@${SLACK_ID_SHAPE}(?:\\|[^>\\n]*)?>`;

/**
 * v4.2.x (G2) — THE predicate: "an account id that is NOT a rendered mention".
 * One string, both jobs — the WRAPPER below replaces every hit, the READER
 * (`RAW_SLACK_ID_RE`) tests for one.
 *
 * It used to be two hand-typed lookbehinds, `(?<!<@)(?<!<)` on the wrapper and
 * `(?<![@<])` on the reader, and both excluded a preceding `<` outright. So
 * `<U0ARK5814PQ` — an id behind a lone, unclosed angle bracket — was invisible to
 * BOTH: the wrapper could not wrap it, the reader could not flag it, and Slack
 * renders it as literal text, so it just shipped. Same for `<@U0ARK5814PQ` with the
 * `>` missing. Those lookbehinds were answering "am I inside a rendered mention?"
 * through a proxy — any `<` to the left — and the proxy is wrong in exactly the
 * cases where the mention is broken. The lookahead answers it directly instead, so
 * a broken half-mention is simply a raw id again, and gets treated like one.
 *
 * Groups: 1 = a stray opening `<` if one was consumed, 2 = the id, 3 = a stray
 * closing `>`. The replacer keeps group 3 only when group 1 is empty, because a `>`
 * beside an id that brought no `<` of its own belongs to whatever came before it.
 *
 * `(?<![<@])` stays, doing the job it can actually do: it blocks the two positions
 * INSIDE a rendered `<@U…>` (the `@` and the `U`), so a proper mention comes out
 * byte-identical — the 2026-07-21 de-tagging regression stays fixed by
 * construction, on both patterns at once rather than in two places that can drift.
 */
const UNRENDERED_SLACK_ID =
  `(?<![<@])(?!${RENDERED_MENTION})(<?)@?\\b(${SLACK_ID_SHAPE})\\b(>?)`;

// v4.0.x — bare / @-prefixed Slack user id leaked as literal text (NOT a rendered
// <@…> mention): the group/DM context header feeds "Name (slack_id: U…)" and the
// model sometimes echoes the id bare (Alex Wiggins → "@U09DGGSJJP9 …", 2026-07-21).
// This deterministic scrub is the path-agnostic fix (runs on every outbound via
// formatForSlack). Wrap → <@id> so Slack renders the display name. Structured
// token → the allowed kind of regex (G7).
const BARE_SLACK_ID_RE = new RegExp(UNRENDERED_SLACK_ID, 'g');

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
 * No `/g` flag on purpose: callers use `.test()`, which is stateful (and therefore
 * alternates true/false) on a global regex.
 *
 * Not merely the same SHAPE as the wrapper now but the same PREDICATE, so a hit
 * here means "this text never went through the scrubber" (a path that skips
 * formatForSlack, or a gate re-scanning a rewriter's fresh output) — never "the
 * wrapper saw this id and couldn't act", and never "the two patterns disagree".
 */
export const RAW_SLACK_ID_RE = new RegExp(UNRENDERED_SLACK_ID);

/**
 * An internal work-item id — the inverse of the four expressions that MINT one:
 * `req_` (db/requests.ts:51), `task_` (tasks/index.ts:13), `out_` (db/jobs.ts:164),
 * `ci_` (db/calendarIssues.ts:372). A structured token, so regex is the allowed kind.
 *
 * `req_`/`task_` match loosely: neither prefix begins an English word, and a model
 * volunteering an id-SHAPED string it made up ("req_abc123") has to be caught too.
 * `out_`/`ci_` require the minted `<epoch>_<base36>` tail, because a loose match
 * there swallows ordinary words ("out_of_office").
 *
 * Lives here (a leaf util), not in core/requests/resolver.ts where it originated,
 * because `securityGate`'s `internal_ref_id` trigger needs the exact same pattern
 * and utils must not import FROM core — that reversed edge is what let a future
 * static import of securityGate from anywhere under core/requests turn into a real
 * cycle (core/requests → securityGate → core/requests), silently leaving the
 * trigger's pattern undefined at module-init. `core/requests/resolver.ts` imports
 * this constant instead of defining it, matching the `RAW_SLACK_ID_RE` shape above:
 * one canonical source in utils, every gate and core module a reader.
 */
export const INTERNAL_WORK_ITEM_ID_RE = /\b(?:(?:req|task)_[a-z0-9][a-z0-9_]*|(?:out|ci)_\d{10,}_[a-z0-9]+)\b/i;

export function scrubInternalLeakage(text: string): string {
  return text
    .replace(GRAPH_ID_RE, '')
    // Always emits the rendered form. The stray `>` is only swallowed when a stray
    // `<` came with it — otherwise it belonged to whatever preceded the id, so it is
    // handed back untouched.
    .replace(BARE_SLACK_ID_RE, (_m: string, open: string, id: string, close: string) =>
      `<@${id}>${open ? '' : close}`)
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
