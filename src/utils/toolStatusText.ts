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
export const TOOL_STATUS_TEXT: Record<string, string> = {
  // Calendar — reading
  get_calendar: 'Checking calendar',
  analyze_calendar: 'Reviewing calendar',
  get_free_busy: 'Checking availability',
  find_available_slots: 'Looking for a time',
  check_join_availability: 'Checking who can join',
  check_calendar_health: 'Reviewing calendar',

  // Calendar — writing
  create_meeting: 'Booking it',
  move_meeting: 'Moving the meeting',
  update_meeting: 'Updating the meeting',
  delete_meeting: 'Cancelling it',
  book_floating_block: 'Closing the time',
  set_event_category: 'Tagging the meeting',

  // Coordination
  coordinate_meeting: 'Reaching out to find a time',
  cancel_coordination: 'Calling it off',
  finalize_coord_meeting: 'Locking it in',

  // Messaging / lookups
  message_colleague: 'Reaching out',
  find_slack_user: 'Finding the right contact',
  find_slack_channel: 'Finding the channel',

  // Tasks / approvals / brief
  create_task: 'Noting it down',
  update_task: 'Updating the task',           // v2.9 — merged edit + cancel
  get_my_tasks: 'Pulling tasks',
  create_approval: 'Flagging it',
  resolve_approval: 'Closing it out',
  list_pending_approvals: 'Checking what’s pending',
  get_briefing: 'Pulling the brief',
  send_briefing_now: 'Sending the brief',

  // Routines. v2.9 — 4 tools merged into manage_routine.
  manage_routine: 'Managing the routine',

  // Knowledge / web / summary
  manage_knowledge: 'Thinking',               // v2.9 — get + ingest merged
  web_search: 'Searching the web',
  web_extract: 'Reading the page',
  share_summary: 'Sharing the summary',
  update_summary_draft: 'Tweaking the draft',

  // Preferences (v2.9 — merged)
  manage_preference: 'Memorizing it',

  // Calendar issues (v2.9 — merged)
  manage_calendar_issue: 'Checking calendar issues',

  // Venues (v2.9)
  find_venue: 'Looking for a place',
  rank_venue: 'Updating your list',
};

/**
 * Get the status text for a tool. Returns '' for unmapped tools — that
 * actively clears Slack's auto-default while observation / silent tools
 * run, so the panel stays quiet instead of showing "Gathering information…"
 */
export function statusForTool(toolName: string): string {
  return TOOL_STATUS_TEXT[toolName] ?? '';
}
