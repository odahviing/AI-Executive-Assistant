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

// Tool names that must never appear verbatim in user-facing text. Keep in sync
// with `name: '...'` tool definitions across src/skills/ + src/core/assistant.ts
// + src/tasks/*.
const TOOL_NAMES = [
  'analyze_calendar', 'book_lunch', 'cancel_coordination', 'cancel_task',
  'check_calendar_health', 'check_join_availability', 'classify_summary_feedback',
  'confirm_gender', 'coordinate_meeting', 'create_approval', 'create_meeting',
  'create_routine', 'create_task', 'delete_meeting', 'delete_routine',
  'dismiss_calendar_issue', 'edit_task', 'escalate_to_user', 'finalize_coord_meeting',
  'find_available_slots', 'find_slack_channel', 'find_slack_user',
  'forget_preference', 'get_active_coordinations', 'get_briefing', 'get_calendar',
  'get_calendar_issues', 'get_company_knowledge', 'get_free_busy', 'get_my_tasks',
  'get_pending_requests', 'get_routines', 'ingest_knowledge_from_url',
  'learn_preference', 'learn_summary_style', 'list_company_knowledge',
  'list_pending_approvals', 'list_speaker_unknowns', 'log_interaction',
  'message_colleague', 'move_meeting', 'note_about_person', 'note_about_self',
  'recall_interactions', 'recall_preferences', 'resolve_approval', 'resolve_request',
  'send_briefing_now', 'set_event_category', 'share_summary', 'store_request',
  'update_calendar_issue', 'update_meeting', 'update_person_profile',
  'update_routine', 'update_summary_draft', 'web_extract', 'web_search',
  'file_document', 'classify_document', 'classify_engagement',
];
const TOOL_NAME_RE = new RegExp(`\\b(?:${TOOL_NAMES.join('|')})\\b`, 'g');
// Matches ALL_CAPS_WITH_UNDERSCORES tokens (2+ segments). Real prose never
// uses this shape; known internal flags always do. Safe to strip generically.
const SENTINEL_RE = /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g;

export function scrubInternalLeakage(text: string): string {
  return text
    .replace(/ - /g, ', ')            // hyphen-separator AI tell
    .replace(SENTINEL_RE, '')
    .replace(TOOL_NAME_RE, '')
    .replace(/`\s*`/g, '')             // empty inline code spans left over
    .replace(/^[ \t]*[\r\n]/gm, '')    // drop lines that became empty
    .replace(/[ \t]{2,}/g, ' ')        // collapse multi-spaces
    .replace(/\n{3,}/g, '\n\n')        // collapse excessive blank lines
    .trim();
}
