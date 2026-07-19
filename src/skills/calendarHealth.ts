import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import { formatSkillPreferencesBlock } from '../utils/skillPreferences';
import type { OpCtx } from './calendarHealth/handlers/context';
import { handleCheckHealth } from './calendarHealth/handlers/checkHealth';
import { handleBookFloatingBlock } from './calendarHealth/handlers/floatingBlockOps';
import {
  handleSetEventCategory,
  handleManageCalendarIssue,
  handleManageWorkingElsewhere,
} from './calendarHealth/handlers/categoryOps';

export class CalendarHealthSkill implements Skill {
  id = 'calendar' as const;
  readonly skillId = 'calendar';
  name = 'Calendar Health';
  description = 'Monitors calendar hygiene: lunch protection, double-booking detection, OOF conflicts, and event categories';

  getTools(profile: UserProfile): Anthropic.Tool[] {
    // Floating-block names — read from yaml so the tool's enum stays in sync
    // with whatever blocks the owner has configured (lunch + any custom).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fb = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
    const floatingBlockNames = fb.getFloatingBlocks(profile).map(b => b.name);
    const categoryNames = (profile.categories ?? []).map(c => c.name);
    return [
      {
        name: 'check_calendar_health',
        description: `Scan the owner's calendar for a date range and report health issues:
- Missing floating blocks: a configured block (lunch, coffee break, thinking time, any other user-defined block) didn't land on the calendar on a day it applies to
- Double bookings: overlapping non-all-day events (tagged with internal_only + movable_event_id when detectable)
- OOF conflicts: meetings scheduled on days with an OOF/vacation event
- Missing categories: events without Outlook categories
- Busy day: a work day with free time below the profile threshold / 6+ meetings / no 30-min block for thinking time

Returns a list of issues. Behavior depends on \`mode\`:
- passive (default) → returns the issues for you to narrate. Owner asks for fixes; you execute them via book_floating_block / set_event_category / etc. in follow-up calls.
- active → executes safe fixes in-tool before returning: missing floating blocks get booked, missing categories get set when the classifier is high-confidence, busy-day threshold breaches fire a DM to the owner. Overlap + OOF conflicts on a MOVABLE (internal-only, no external attendee) meeting are auto-resolved by initiating a move-coordination to reschedule it (see the fix loop below); a movable meeting with an external attendee is left for the owner. Each issue in the returned list is tagged \`fixed: true\` with \`fix_detail\` when Maelle acted on it.

Use this proactively when the owner asks about their schedule, or when they ask you to check calendar health.`,
        input_schema: {
          type: 'object',
          properties: {
            start_date: {
              type: 'string',
              description: 'Start date YYYY-MM-DD. Defaults to today. When omitted, the tool uses a smart default window: today → end of the owner\'s current workweek, extended by 7 days when ≤24h remain (so there\'s runway to coordinate moves).',
            },
            end_date: {
              type: 'string',
              description: 'End date YYYY-MM-DD. Defaults paired with start_date — see above. Only override when you have a specific reason (e.g. owner asked "check next month").',
            },
            mode: {
              type: 'string',
              enum: ['passive', 'active'],
              description: 'Optional override. When omitted, uses profile.behavior.calendar_health_mode. "active" executes the safe subset of fixes in-tool; "passive" just detects and reports.',
            },
          },
          required: [],
        },
      },
      {
        name: 'book_floating_block',
        description: `Book a floating-block event (lunch / coffee break / gym / thinking time / etc) on a specific day, inside that block's preferred window.

Pick \`block_name\` from the FLOATING BLOCKS section of your system prompt — these are the blocks the owner has configured. The handler finds an aligned + buffered slot inside the block's preferred window and creates the event with the block's default subject.

Use this when: the owner explicitly asks to book one (e.g. "block 30 min for lunch tomorrow", "add a coffee break Thursday"), OR check_calendar_health surfaces a missing block on a workday.

POSITIONAL PREFERENCE — express the owner's intent semantically, don't compute the time yourself:
- Default (no \`prefer_position\` arg) → earliest aligned slot in the window. Use this when the owner just says "book lunch" without a time preference.
- \`prefer_position: 'latest_in_window'\` → latest aligned slot in the window. Use when the owner says "book lunch as late as possible" / "right before lunch ends".
- \`prefer_position: 'abut_before'\` + \`anchor_event_id\` → slot ends right before the anchor meeting (directly abuts, no buffer — standard meeting durations carry their own spacing). Use when the owner says "before [meeting]" / "right before [person]" / "just before X".
- \`prefer_position: 'abut_after'\` + \`anchor_event_id\` → slot starts right after the anchor meeting (directly abuts, no buffer). Use when the owner says "after [meeting]" / "right after [person]".

Pass anchor_event_id from get_calendar's event id field. NEVER hand-compute the start time and pass it through create_meeting — let this tool do the alignment math. Boundary times like the exact lunch_end are unbookable as lunch (the window's preferred_end is exclusive); the abut_after path will refuse honestly if math lands at/past the boundary.

CATEGORIES: if the EVENT CATEGORIES block is in your system prompt, pass \`category\` with the name that fits this kind of block (typically the one whose description mentions personal time / schedule admin). Omit if no categories are defined or none fits.

OWNER OVERRIDE — booking outside the preferred window:
When the owner explicitly says to book a floating block at a time OUTSIDE its preferred window ("book lunch at 14:00 even though that's late", "yes I know it's after my lunch hours, do it anyway"), call this tool with start_time="HH:MM" + confirm_outside_window=true. The handler bypasses the window check (owner override IS the approval) AND bypasses the day-of-week check (owner is allowed to book a block on any day they ask). It still enforces the rules that DON'T bend: buffer, conflict detection, alignment. Resulting event is tagged as a first-class floating block (canonical subject + matching category) so downstream code recognizes it. Never fall back to create_meeting for this — that path would lose the floating-block-ness. Owner-only path: this flag is ignored on colleague calls (colleagues can't trigger this tool anyway — it's owner-restricted by registry).`,
        input_schema: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'Date YYYY-MM-DD to book the block on.',
            },
            block_name: floatingBlockNames.length > 0
              ? {
                  type: 'string',
                  enum: floatingBlockNames,
                  description: 'Which floating block to book. Must match a name in the FLOATING BLOCKS section of your system prompt.',
                }
              : {
                  type: 'string',
                  description: 'Which floating block to book.',
                },
            prefer_position: {
              type: 'string',
              enum: ['earliest', 'latest_in_window', 'abut_before', 'abut_after'],
              description: 'OPTIONAL. Where in the block window to place this booking. Default: earliest. Use abut_before / abut_after with anchor_event_id when the owner says "before X" / "after X".',
            },
            anchor_event_id: {
              type: 'string',
              description: 'OPTIONAL. The event id (from get_calendar) to abut against. REQUIRED when prefer_position is abut_before or abut_after.',
            },
            start_time: {
              type: 'string',
              description: 'OPTIONAL. Explicit HH:MM start time (24h). Honored ONLY when confirm_outside_window=true and the owner has explicitly directed the time. Quarter-hour alignment is still enforced — if the owner names off-grid time, snap silently to the nearest valid quarter unless they pinned it (15:13 from get_calendar may be valid for booking onto an existing slot; 15:13 from a free-form ask should snap to 15:15).',
            },
            confirm_outside_window: {
              type: 'boolean',
              description: 'OPTIONAL. Owner override flag — when true, the handler accepts a start_time that is OUTSIDE the block\'s preferred window AND/OR on a day the block is not normally scheduled. Use ONLY when the owner has explicitly said to book it there ("yes book lunch at 14:00, late is fine"). The override IS the approval — no separate policy_exception approval needed. Buffer + conflict checks still enforced. Pair with start_time.',
            },
            category: categoryNames.length > 0
              ? {
                  type: 'string',
                  enum: categoryNames,
                  description: 'OPTIONAL. Name of the Outlook category to tag this event with. Must match EXACTLY one of the owner\'s defined categories. Omit if none fits.',
                }
              : {
                  type: 'string',
                  description: 'OPTIONAL. Outlook category. Omit if no categories are defined.',
                },
          },
          required: ['date', 'block_name'],
        },
      },
      {
        name: 'set_event_category',
        description: `Add or update the Outlook category on a calendar event. Categories help with calendar organization and analytics.

Sets the category on YOUR copy of the event — works for ANY event on your calendar, including meetings someone else organized (categories are per-user; you never need to be the organizer). Use this for ALL category changes — never update_meeting (update_meeting's category change requires being the organizer and fails with not_organizer on others' meetings).

Use the owner's own categories listed in the EVENT CATEGORIES block of your system prompt. Names must match EXACTLY (case-sensitive). Do NOT invent category names — if you think a new category should exist, say so in the reply; don't silently create one.`,
        input_schema: {
          type: 'object',
          properties: {
            event_id: { type: 'string', description: 'The calendar event ID' },
            categories: {
              type: 'array',
              items: { type: 'string' },
              description: 'Category names to set on the event',
            },
          },
          required: ['event_id', 'categories'],
        },
      },
      {
        // v2.9 — merged get_calendar_issues + update_calendar_issue.
        name: 'manage_calendar_issue',
        description: `Calendar issues (overlaps, work-on-day-off, OOF, missing blocks, etc.) — list or transition. v3.0.3 redesign.

Actions:
- list — read active rows (filtered to event_end > now).
- approve — owner said "it's fine, leave it" / "ignore it" / "stop flagging this" / "I keep telling you to ignore this." Marks the row terminal so it WON'T re-flag on future runs. Use this for a recurring busy-day or category-limit warning the owner has waved off (e.g. "5 weekly 1:1s on Monday, that's intentional"). Get the issue_id from a 'list' call or check_calendar_health's activeTrackedIssues — every detected issue, including busy_day, now has a trackable row.
- start_resolve — owner said "fix it." Opens a request_id under the row, transitions to in_progress. Caller MUST follow with move_meeting / etc. as appropriate; the row auto-resolves on cascade when the underlying event changes.
- owner_will_resolve — owner said "I'll handle it." Row sits in owner_side state until owner declares done OR the underlying event changes.
- owner_done — owner declared he fixed it. Row transitions to resolved.

issue_id is required for everything except 'list'. Get it from a prior list / check_calendar_health call. Use \`notes\` to capture what owner said ("Sunday is travel, leave it") — surfaces on future narration.

v3.0.6 — PREEMPTIVE APPROVE for floating-block gaps (NEW). When you mention a missing floating block ("no lunch on Tuesday") and the owner replies it's covered by another event / he'll skip it / not needed today, call \`manage_calendar_issue\` with:
  action='approve', date='<YYYY-MM-DD>', block_name='<lunch | gym | etc.>', notes='covered by Natan meeting'
No issue_id needed. A terminal row gets created directly so the next check_calendar_health run sees the suppressor and skips re-narrating the same gap. Use this whenever the owner waives a floating-block gap in conversation — don't wait for the daily detection to fire to dismiss it.`,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'approve', 'start_resolve', 'owner_will_resolve', 'owner_done'], description: 'see description.' },
            issue_id: { type: 'string', description: 'required for start_resolve / owner_will_resolve / owner_done. Optional for approve when you pass date + block_name instead.' },
            date: { type: 'string', description: 'YYYY-MM-DD. Use with block_name for the preemptive-approve path (no issue_id needed). v3.0.6.' },
            block_name: { type: 'string', description: 'Floating-block name (must match profile.meetings.floating_blocks, e.g. "lunch"). Use with date for the preemptive-approve path.' },
            notes: { type: 'string', description: 'optional. Owner reason ("travel week"), or what got done.' },
          },
          required: ['action'],
        },
      },
      {
        name: 'manage_working_elsewhere',
        description: `Mark (or clear) days the OWNER is working from a different location/timezone — travel days, working from another office, etc. Sets Outlook's "Working Elsewhere" status so Maelle knows his normal office/home/work-hours rules don't apply those days: availability becomes tentative in his AWAY timezone and bookings route to approval.

Use when the owner says he'll be elsewhere: "next week I'm in France Monday and Tuesday", "I'm working from the NYC office Thu–Fri", "I'll be in London all next week".

action='set' — create the all-day Working Elsewhere marker spanning the dates. Always include \`location\` (where he'll be) — it's what derives his timezone there.
action='clear' — remove Working Elsewhere markers overlapping the date range (a trip got cancelled / changed).

Owner-only. This is a personal status marker, NOT a meeting — no attendees, no booking rules. Resolve the dates from the owner's words using your date table.`,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['set', 'clear'], description: 'set = create the marker; clear = remove markers in the range.' },
            start_date: { type: 'string', description: 'First day, YYYY-MM-DD.' },
            end_date: { type: 'string', description: 'Last day, YYYY-MM-DD (inclusive). Omit for a single day.' },
            location: { type: 'string', description: 'Where he\'ll be — city or office ("France", "Boston Office", "London"). Drives the away-timezone; include whenever known (required for set).' },
          },
          required: ['action', 'start_date'],
        },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const { profile } = context;
    const { email: userEmail, timezone } = profile.user;
    const opCtx: OpCtx = { context, self: this, profile, userEmail, timezone };

    switch (toolName) {
      case 'manage_working_elsewhere':
        return handleManageWorkingElsewhere(args, opCtx);

      case 'check_calendar_health':
        return handleCheckHealth(args, opCtx);

      case 'book_floating_block':
        return handleBookFloatingBlock(args, opCtx);

      case 'set_event_category':
        return handleSetEventCategory(args, opCtx);

      case 'manage_calendar_issue':
        return handleManageCalendarIssue(args, opCtx);

      default:
        return null;
    }
  }

  getSystemPromptSection(profile: UserProfile, scopes?: string[], isOwner?: boolean): string {
    // v3.x (Block 3 — prose lazy-load, "option 1"). The calendar-health TOOLS
    // (check_calendar_health / analyze_calendar / manage_calendar_issue) stay in
    // the 'meetings' scope so they ALWAYS ship on a scheduling turn — Sonnet can
    // always detect/use them when needed. Only this ~2.3k of PROSE is gated, on
    // the 'calendar' scope (review/health/free-time turns; the classifier picks
    // it, and freeTimeInquiry deterministically unions it). A misroute therefore
    // soft-degrades (tools present, less written guidance) rather than failing.
    // Undefined/general → render (colleague path, classifier off).
    if (scopes && !scopes.includes('calendar') && !scopes.includes('general')) return '';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fb = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
    const blocks = fb.getFloatingBlocks(profile);
    const blocksLine = blocks.length > 0
      ? blocks.map(b => `${b.name} ${b.preferred_start}–${b.preferred_end} ${b.duration_minutes}min`).join(' · ')
      : 'none configured';
    const mode = profile.behavior.calendar_health_mode ?? 'passive';
    const firstName = profile.user.name.split(' ')[0];
    return `
CALENDAR HEALTH SKILL
You can monitor and improve the owner's calendar hygiene.

Available tools:
- check_calendar_health: scan for issues. Mode = ${mode.toUpperCase()} (profile default; can be overridden with the \`mode\` arg)
  • passive: detects and returns the issue list — you narrate, owner asks for fixes, you execute
  • active: detects + EXECUTES the safe fixes in one pass (books missing floating blocks, tags uncategorized events with high-confidence category, DMs owner about busy days). Each issue comes back tagged \`fixed:true\` with a one-liner \`fix_detail\` describing what changed.
- book_floating_block: book a floating block in its preferred window. Pass \`block_name\` (one of: ${blocks.map(b => b.name).join(', ') || 'none configured'}). Configured blocks: ${blocksLine}. All floating blocks live under \`meetings.floating_blocks\`.
  POSITIONAL INTENT: when the owner says "before X" / "after X" for a floating block (X = a meeting on the same day), pass \`prefer_position: 'abut_before' | 'abut_after'\` + \`anchor_event_id\` (the event id from get_calendar). The handler computes \`anchor.start - buffer - duration\` (abut_before) or \`anchor.end + buffer\` (abut_after), snaps to a quarter-hour aligned slot, and verifies window + conflicts. Don't compute the time yourself and pass it through create_meeting — that bypasses the alignment + window-edge checks (the lunch window's preferred_end is exclusive, so e.g. starting AT 13:30 isn't a valid lunch slot). When the owner says "as late as possible" / "right before lunch ends", pass \`prefer_position: 'latest_in_window'\`.
- set_event_category: add Outlook categories to events
- get_calendar_issues: see all unresolved calendar issues (double bookings, OOF conflicts)
- update_calendar_issue: change the status of a tracked issue

Calendar issue workflow:
1. check_calendar_health detects issues; active mode auto-fixes the safe subset before returning
2. For ANY remaining issues (overlaps, OOF conflicts, busy days that need owner input), report to the owner with the issue ID
3. Owner responds:
   - "it's fine" / "I know" → call update_calendar_issue with status "approved"
   - "move X to Y" / "fix it" → call update_calendar_issue with "to_resolve" + their instructions, then use move_meeting to reschedule, then call update_calendar_issue with "resolved"
   - "cancel X" → use delete_meeting, then call update_calendar_issue with "resolved"
4. Approved/resolved issues won't be flagged again

NARRATING ACTIVE-MODE RESULTS — use \`summary_text\` verbatim (v2.7.4):
When check_calendar_health returns, the response carries a \`summary_text\` field that is a DETERMINISTIC per-issue summary built from \`fixed: true + fix_detail\` (successes) and \`fix_failed: true + fix_error\` (failures). USE THIS VERBATIM as the body of your reply — do NOT improvise from \`issues[]\` directly, do NOT skip fix_failed lines, do NOT add invented commentary about what got done.

Why: previously Sonnet narrated "I started moving X" when the move-coord actually failed silently (slot search returned zero). The summary_text is the only honest source for "what got done this turn" — fixed actions appear as ✓ lines, failed attempts as × lines, undetected/skipped as ! lines. Owner sees the truth.

Light polish only: you may strip the ✓/×/! prefix characters when posting to Slack, and may slightly rephrase awkward template strings into natural EA voice (humanGate runs after you anyway). But every CLAIM in your reply must trace back to a line in summary_text. If summary_text is "Calendar looks healthy — no issues found." then your reply is "Calendar looks good." or similar — nothing more.

WRONG: "Calendar looks good" when summary_text contains ✓ lines (erases the autonomous actions).
WRONG: "I started moving Michal's biweekly" when summary_text says "× Tried to fix ... but couldn't" — must narrate the failure honestly, not the wish.

Every fix fires a shadow DM automatically (via \`book_floating_block\` / \`set_event_category\` wrappers + v1_shadow_mode) — you don't need to DM separately.

PROTECTION RULES (v2.1.1 — deterministic, in code):
A meeting is PROTECTED from auto-reshuffle if ANY of:
  1. 4+ effective attendees (organizer + ≥3 non-declined invitees)
  2. Has any external attendee (email domain ≠ owner's company)
  3. Subject matches an entry in \`meetings.protected[].name\`
  4. Any category matches an entry in \`meetings.protected[].category\`
When the analyzer flags an overlap, it tells you which side is protected (\`kept_event_id\`) and which is movable (\`movable_event_id\`), plus \`protection_reasons\`. Use those fields when narrating. Active-mode DOES NOT auto-move overlaps in this release — that's v2.2 (needs the move-coord state machine). For now, report the overlap + the movable candidate + the protection reasons, and ask the owner to direct.

BUSY_DAY — narrate from the structured numbers, briefly:
When the analyzer flags a \`busy_day\` issue, it carries \`free_minutes\` (total free during work hours), \`longest_gap_minutes\` (the longest single uninterrupted block), and \`threshold_minutes\` (the owner's target). Surface ONE short line per day in HUMAN time — never "80 min" / "110 min": "Wed 14 May runs tight — just under 1.5h free, under your 2h office-day target." Don't enumerate the meetings on that day — owner can ask for detail if he wants it. If multiple days flag, bundle: "Wed 14, Thu 7, and Wed 13 are all under your 2h office-day target." Offer to look at moveable items only when owner asks. Active mode does NOT auto-resolve these — picking what to move is judgment-heavy.

CATEGORY_LIMIT_EXCEEDED — surface as informational, ask for direction:
When the analyzer flags a \`category_limit_exceeded\` issue, narrate it briefly with the named category, the rule (per_day or per_week), the count vs limit, and the day/week label. Active mode does NOT auto-resolve these — picking which interview / outside-meeting to bump is judgment-heavy and only ${firstName} can decide. Frame as a question: "Tuesday has 3 interviews, your limit is 2 — want me to move one, or keep all 3?". Include the affected event subjects (look them up via \`get_calendar\` if not already in context) so ${firstName} can pick. On owner decline ("keep them all" / "leave it"), call \`update_calendar_issue\` with the issue_id and status='approved' so tomorrow's check doesn't re-surface the same row.

OOF_CONFLICT WITH PROTECTION REASONS — frame as a question, not a status line.
When an \`oof_conflict\` issue carries \`protection_reasons\` (the meeting can't be auto-moved because it has externals, ≥4 attendees, etc.), present it to the owner as a QUESTION: "External meeting on Thursday during your vacation — want me to handle, or you'll fix it yourself?". Include the meeting subject + date + the protection reasons in plain words, and the issue_id. If the owner says "I'll fix it" / "no, leave it" / "I'll handle", call \`update_calendar_issue\` with that issue_id and status='approved' so tomorrow's check doesn't re-surface the same row. Don't dismiss without explicit owner intent — only on a clear "I'll handle / leave it / no" reply.

Rules:
- In passive mode: only book floating blocks when explicitly asked or after check_calendar_health reveals a gap
- In active mode: book / tag as described above. Never auto-resolve double bookings (even internal-only) in this release — that ships in v2.2.
- Never auto-resolve OOF conflicts — always ask the owner first.
- Categories are informational — suggest them but don't batch-apply without asking, UNLESS in active mode where the high-confidence classifier handles it.
- When reporting issues, include the issue_id so the owner's response can be tracked.

REPORTING ISSUES — say each thing once:
- Mention each conflict or issue ONCE, briefly. Do not reframe the same event pair under different framings ("there's an overlap" ... "more importantly" ... "the real issue is").
- If two events overlap, say it in one sentence with the times. Don't mix in adjacent meetings that aren't part of the conflict.
- No closing "the real issue" re-summary. The list IS the report.
- If the user has seen a conflict before and marked it approved, don't bring it up again.

TRUST THE ANALYZER (v1.6.4):
- analyze_calendar / check_calendar_health return a structured \`issues\` list per day. That list IS the truth about what's wrong.
- If a day's \`issues\` is empty, that day has NO issues. Do not invent one — don't say "lunch is effectively blocked" because the gap looked tight, don't say "back-to-back" because two meetings were close, don't say "no time for coffee" because nothing's scheduled. The analyzer already considers the buffer, the lunch window, the work hours, and free-time thresholds. If it didn't flag it, it isn't an issue.
- If you spot something in the raw events that you THINK is an issue but the analyzer didn't flag, ask the owner — don't assert: "I noticed Monday is pretty packed, want me to check if there's room for [X]?"
- Same for the events list: the analyzer already filtered personal events on non-working days. If a day returns empty, it IS empty for our purposes — don't pull personal events from get_calendar to fill the silence.

LEARNING ${firstName.toUpperCase()}'S CALENDAR STYLE (v3.3):
- When ${firstName} states a STANDING calendar preference — something to apply EVERY time, not a one-off for today — offer to remember it, and on his "yes" call \`update_my_preferences(skill='calendar', mode='add', text='<his preference, in his words>')\`.
  Examples: "on Sundays, if there's no lunch, don't add one" · "duplicate invites from the recruiting system — just delete them, don't ask" · "don't flag duplicates until end of next week, I know about them".
- A one-off instruction for TODAY's calendar is NOT a preference — just do it, don't save it.
- To EDIT or REMOVE a saved preference, call \`update_my_preferences(skill='calendar', mode='replace', text='<the full new list>')\`.
- His saved calendar preferences (if any) appear in the block below — already in force. Don't re-ask about something already listed there.${isOwner ? formatSkillPreferencesBlock(profile, 'calendar', { label: 'CALENDAR' }) : ''}
`;
  }
}
