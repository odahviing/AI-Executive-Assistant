/**
 * Per-tool status text for the Slack assistant-panel "Working…" indicator.
 *
 * Slack's Agents & AI Apps surface shows a status line above the input field
 * while the agent is processing. When we don't set it ourselves, Slack falls
 * back to its own placeholder text (e.g. "Gathering information..."). We
 * override per tool with a short, human-EA-voiced phrase — present-progressive,
 * no jargon, neutral for owner / colleague / multi-party contexts.
 *
 * Tools not listed → '' (clears Slack's auto-default; nothing visible). This
 * covers observation tools (notes, preferences, memory) per the v2.4.0
 * SILENCE_ELIGIBLE policy — they're side effects, not "doing something
 * visible."
 *
 * Used by the orchestrator before each tool call. Fire-and-forget; never
 * blocks tool execution.
 */
// Strings may contain `{owner}` — substituted with the owner's first name
// at render time so the status reads natural for any deployment.
// Example: `Checking with {owner}` → `Checking with Idan`.
export const TOOL_STATUS_TEXT: Record<string, string> = {
  // Calendar — reading
  get_calendar: 'Checking the calendar',
  analyze_calendar: 'Going through the week',
  get_free_busy: "Checking who's free",
  find_available_slots: 'Finding a time',
  check_join_availability: 'Checking who can make it',
  check_calendar_health: 'Reviewing the calendar',

  // Calendar — writing
  create_meeting: 'Setting up the meeting',
  move_meeting: 'Rescheduling the meeting',
  update_meeting: 'Updating the meeting',
  delete_meeting: 'Cancelling the meeting',
  book_floating_block: 'Blocking the time',
  set_event_category: 'Sorting the meeting',

  // Coordination
  coordinate_meeting: 'Setting up a time',
  cancel_coordination: 'Calling off the meeting',
  finalize_coord_meeting: 'Confirming the time',

  // Messaging / lookups
  message_colleague: 'Sending the message',
  find_slack_user: 'Finding the person',
  find_slack_channel: 'Finding the channel',

  // Tasks
  create_task: 'Adding to the list',
  update_task: 'Updating the task',           // v2.9 — merged edit + cancel
  get_my_tasks: 'Checking my list',

  // Approvals — owner-name substitution
  create_approval: 'Checking with {owner}',
  resolve_approval: 'Closing the loop',
  list_pending_approvals: "Checking what's open",

  // Brief
  get_briefing: 'Reading the summary',
  send_briefing_now: 'Sending the summary',

  // Routines. v2.9 — 4 tools merged into manage_routine.
  manage_routine: 'Updating the routine',

  // Knowledge / web
  manage_knowledge: 'Going over my notes',    // v2.9 — get + ingest merged
  web_search: 'Searching the web',
  web_extract: 'Reading the page',

  // Meeting summary
  share_summary: 'Sending the recap',
  update_summary_draft: 'Editing the recap',

  // Preferences (v2.9 — merged)
  manage_preference: 'Saving the preference',

  // Calendar issues (v2.9 — merged)
  manage_calendar_issue: 'Sorting the calendar',

  // Venues (v2.9)
  find_venue: 'Finding a place',
  rank_venue: 'Updating places list',
};

/**
 * Get the status text for a tool. Returns '' for unmapped tools — that
 * actively clears Slack's auto-default while observation / silent tools
 * run, so the panel stays quiet instead of showing "Gathering information…"
 *
 * `ownerFirstName` substitutes `{owner}` placeholders in the text (e.g.
 * "Checking with {owner}" → "Checking with Idan"). Falls back to "the
 * owner" when not provided.
 */
export function statusForTool(toolName: string, ownerFirstName?: string): string {
  const raw = TOOL_STATUS_TEXT[toolName] ?? '';
  if (!raw.includes('{owner}')) return raw;
  return raw.replace(/\{owner\}/g, ownerFirstName ?? 'the owner');
}
