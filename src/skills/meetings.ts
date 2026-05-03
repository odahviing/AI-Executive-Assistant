import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import {
  updateCoordJob,
  getActiveCoordJobs,
  getDb,
  auditLog,
  upsertPersonMemory,
  searchPeopleMemory,
  getPersonMemory,
  getDismissedIssueKeys,
  buildIssueKey,
  dismissCalendarIssue,
  type CoordParticipant,
} from '../db';
import { detectAndSaveGender } from '../utils/genderDetect';
import {
  findAvailableSlots,
  pickSpreadSlots,
  getCalendarEvents,
  GraphPermissionError,
  updateMeeting,
} from '../connectors/graph/calendar';
import { SchedulingSkill as _LegacyOpsSkill } from './meetings/ops';
import { determineSlotLocation, type SlotWithLocation } from './meetings/coord/utils';
import { forceBookCoordinationByOwner } from './meetings/coord/booking';
import logger from '../utils/logger';
import { DateTime } from 'luxon';
import { calendarListingFormatRule } from '../utils/calendarListingFormat';

/**
 * MeetingsSkill (v1.6.0) — the single skill responsible for everything about
 * putting a meeting on a calendar. Merges the former SchedulingSkill and
 * CoordinationSkill into one: direct create_meeting / update / move /
 * delete, free-busy lookups, find-slots, AND multi-party coord with DMs,
 * voting, and booking.
 *
 * If this skill is disabled in the profile, Maelle can't touch the calendar —
 * by design. "Booking meetings in any form" is this skill's whole reason for
 * being.
 */
export class MeetingsSkill implements Skill {
  id = 'meetings' as const;
  name = 'Meetings';
  description = 'Books, coordinates, moves, and cancels meetings — direct calendar operations and multi-party Slack coordination';

  // Direct-ops helper (former SchedulingSkill, now private). Used via delegate
  // for create_meeting / move_meeting / update_meeting / delete_meeting / etc.
  // Its own getTools/getSystemPromptSection are NOT called — this skill owns
  // the tool definitions and prompt. Only its executeToolCall is used.
  private readonly ops = new _LegacyOpsSkill();

  getTools(profile: UserProfile): Anthropic.Tool[] {
    const allowedDurations = profile.meetings.allowed_durations.join('/');
    const bufferMin = profile.meetings.buffer_minutes;
    // Read category enum from yaml instead of hardcoding owner-specific
    // names. Empty enum is invalid in Anthropic schemas, so a profile
    // without categories defined gets the field omitted entirely (matches
    // the v1.7.8 "leave uncategorized rather than guess" rule).
    const categoryNames = (profile.categories ?? []).map(c => c.name);
    const categoryEnum = categoryNames.length > 0 ? categoryNames : undefined;
    return [
      {
        name: 'find_slack_user',
        description: `Resolve a person to their Slack ID — used for sending Slack DMs.

CRITICAL — when to call this:
- You need to send a Slack DM (message_colleague, coord polling, heads-up).
- You don't already know their Slack ID from @mention or WORKSPACE CONTACTS.

DO NOT call this for booking meetings. Booking uses EMAIL, period.
- create_meeting and coordinate_meeting take attendees as { name, email }. No Slack ID required for any attendee.
- An external attendee (email outside the company domain) will NEVER have a Slack ID. That's normal. Outlook delivers calendar invites via email regardless.
- An internal attendee may not have a Slack ID either (guests, deactivated, fresh hires) — still book via email; the heads-up Slack DM step skips silently.

The result shape:
- { matches: [...] } — person(s) found, slack_id usable for DMs.
- { matches: [], external: true, email, message: ... } — query was an external email; proceed with that email for booking, no Slack DM possible.
- { matches: [] } — name didn't match anyone in the workspace; try a different spelling, or if the user gave you an email, just book directly without this tool.

If you already have an email for the person, you don't need this tool to book a meeting with them. Just call create_meeting or coordinate_meeting with the email.`,
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The person\'s name, partial name, OR email address. When passed an email outside the owner\'s company domain, the tool returns { external: true } so you know to skip Slack and proceed directly with create_meeting / coordinate_meeting.',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'coordinate_meeting',
        description: `Set up a NEW meeting from scratch. Finds slots, then either presents annotated options to the REQUESTER (internal-only fast path) or DMs each participant for a vote (external/mixed coord state machine). Books once a slot is confirmed.

Use ONLY when there is no existing meeting yet and people need to find a time together. Do NOT use to:
- Move an existing meeting → message_colleague with intent='meeting_reschedule'
- Check if the owner can join a colleague's meeting → check_join_availability
- Just check free/busy without booking → get_free_busy
- Book a slot that was already verbally agreed in this MPIM conversation (owner + participant are both present and have confirmed) → use create_meeting directly. Calling coordinate_meeting here sends the participant fresh slot DMs and re-opens a negotiation they already closed.

Two flows depending on participant mix:

INTERNAL-ONLY FAST PATH (v2.3.2) — every participant has an internal email (same domain as the owner):
1. Find 3 slots on the owner's calendar
2. Read each internal attendee's free/busy via Graph (no DMs to anyone)
3. Return slots ANNOTATED with each attendee's status — sorted with all-free slots first
4. You present the slots to the REQUESTER directly in this conversation, e.g. "Tue 10:00 (everyone free) / Wed 14:00 (Amazia busy) / Thu 11:00 (everyone free) — which works?"
5. When the requester picks, call create_meeting to book — internal attendees get a heads-up DM after the fact ("Hi Amazia, Oran asked, I checked your calendar, booked Tue 10:00")
6. If the requester pushes back wanting only all-free options and we showed mixed, call coordinate_meeting AGAIN with a tighter search range (next-week, narrower window) to retry

EXTERNAL OR MIXED PATH — at least one participant has an external email or no email at all:
1. Find 3 slots on owner's calendar — when the mix includes internal attendees, internal busy time is pre-subtracted so externals never see internal-busy options
2. DM each key participant with the 3 options
3. Collect responses — negotiate if needed (ping-pong then open-ended, up to 2 rounds)
4. Book the meeting and send calendar invites

Two tiers of attendees:
- participants: will be DM'd to pick a slot (max 4). For a 1-on-1, just one person.
- just_invite: added to calendar invite only — no DM, no slot selection.

Duration: standard durations are ${allowedDurations} minutes (each bakes in a ${bufferMin}-min trailing buffer by design). When a colleague asks for a casual round number ("30 min", "an hour", "45 min", "15 min") that isn't in the standard list, just call coordinate_meeting with their stated value — the system silently snaps it to the nearest allowed duration when the delta is ≤10 min. Do NOT ask the colleague to pick between standards or correct them; that reads pedantic. The owner can request any duration. Approval only fires when the snap can't be made cleanly (delta >10 min — e.g. 90 min when allowed is ${allowedDurations}).

Date range: if not specified, search from now going forward until 3 valid options are found.

Location is auto-determined per slot:
- Office day, ≤3 people → owner's office + Teams link
- Office day, >3 people → Meeting Room + Teams link
- Home day, internal → Huddle (no Teams)
- Home day, external → Teams only
Override with custom_location if a specific external venue is needed.`,
        input_schema: {
          type: 'object',
          properties: {
            participants: {
              type: 'array',
              description: 'Key attendees whose availability matters. EMAIL is the primary identifier — every booking and invite uses it. SLACK ID is optional bonus: when present (internal colleague, found via find_slack_user or @mention), the coord state machine sends them a DM to pick a slot. When absent (external attendee, guest, anyone without Slack), they get auto-demoted by the handler into the calendar-invite-only path — still on the meeting, just no Slack DM. Don\'t skip externals; just include them with email.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  email: { type: 'string', description: 'Work or external email — REQUIRED. This is what the calendar invite uses.' },
                  slack_id: { type: 'string', description: 'OPTIONAL. Internal colleagues who should be DM\'d to pick a slot. Omit for externals or anyone without a Slack account — handler routes them to calendar-invite-only.' },
                  tz: { type: 'string', description: 'OPTIONAL. Timezone (from find_slack_user) — used for "morning their time" framing in DMs. Omit for externals.' },
                },
                required: ['name', 'email'],
              },
            },
            just_invite: {
              type: 'array',
              description: 'People to add to the calendar invite without coordinating. Internal or external — EMAIL required, no DM happens for these.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  email: { type: 'string', description: 'REQUIRED. Calendar invite goes to this address.' },
                },
                required: ['name', 'email'],
              },
            },
            subject: { type: 'string', description: 'Meeting title' },
            topic: { type: 'string', description: 'What the meeting is about — set ONLY if the OWNER (not a colleague or participant) explicitly told you the meeting purpose in this conversation. Never derive this from something a participant said, even if they described the agenda; restating their own words back to them in the coordination DM is redundant and awkward. When in doubt, omit.' },
            duration_min: { type: 'number', description: 'Duration in minutes. Default options: 10 (quick), 25 (short), 40 (meeting), 55 (hour). Owner can request any value.' },
            custom_location: {
              type: 'string',
              description: 'Custom/external location — only if specified by the user. Omit to auto-determine based on office/home day and participant count. For phone calls: set to just the phone number (e.g. "+972-54-123-4567") so it\'s clickable. For internal phone calls where no number is needed, omit.',
            },
            search_from: {
              type: 'string',
              description: 'Start date YYYY-MM-DD. If not specified, use today.',
            },
            search_to: {
              type: 'string',
              description: 'End date YYYY-MM-DD. If not specified, omit — the system will search forward until 3 options are found.',
            },
            extended_hours_ok: {
              type: 'boolean',
              description: 'If true, also search 07:00-22:00. Only set after user confirmed they are ok with early/late slots.',
            },
            is_urgent: {
              type: 'boolean',
              description: 'Set to true if the colleague explicitly says "urgent" or needs a time before all offered options. Allows relaxed buffer rules with owner approval.',
            },
            requester_is_attending: {
              type: 'boolean',
              description: 'Default true. Set FALSE when the colleague talking to you is the SCHEDULER, not an attendee — e.g. an HR/EA-style coordinator booking an interview between the owner and a candidate, or anyone arranging a meeting they themselves are not joining. When false, the requester is NOT added to participants, their availability is NOT factored in, and they go to just_invite if they want a calendar copy. The cue: "I want to set up a meeting between X and Y", "I\'m scheduling on behalf of...", or any clear signal that the requester is not in the room.',
            },
          },
          required: ['participants', 'subject', 'duration_min'],
        },
      },
      {
        name: 'get_active_coordinations',
        description: 'Check the status of all ongoing meeting coordination tasks — who has responded, what they said, and which meetings are still waiting.',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'cancel_coordination',
        description: 'Cancel an ongoing coordination job.',
        input_schema: {
          type: 'object',
          properties: {
            job_id: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['job_id'],
        },
      },
      {
        name: 'finalize_coord_meeting',
        description: `Owner-only. Book a pending coordination immediately at the chosen slot — the owner has decided, so the coord is done regardless of which participants have or haven't replied.

Use this when the owner picks a slot from an active coord (one of the options you proposed, or a specific time they called out). This force-books: marks missing responses as yes, sets winning_slot, runs the real calendar booking, and posts the confirmation to everyone involved.

Do NOT use this for ordinary negotiation. Only when the owner has made an explicit decision that overrides waiting for other participants.

DISAMBIGUATION vs resolve_approval:
- If the coord is in status \`waiting_owner\` (you can see a PENDING APPROVAL for this coord in the system prompt) → use \`resolve_approval\` with verdict=approve + data.slot_iso. The resolver runs freshness re-check + books + closes the requester loop. That's the canonical path.
- If the coord is NOT waiting on an approval (status is collecting/resolving/negotiating) and the owner says "just book Tuesday 2pm" → \`finalize_coord_meeting\`. There's no approval to resolve; owner's word IS the decision.`,
        input_schema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'The coord job ID. Get it from get_active_coordinations if you don\'t already know it.' },
            slot_iso: { type: 'string', description: 'The chosen slot in ISO format (e.g. "2026-04-19T11:15:00"). Must match one of the proposed_slots, or be a specific time the owner picked.' },
          },
          required: ['job_id', 'slot_iso'],
        },
      },
      {
        name: 'check_join_availability',
        description: `Check if the owner can join an EXISTING meeting the colleague is organising. Use when a colleague asks "is ${profile.user.name.split(' ')[0]} free at X", "can ${profile.user.name.split(' ')[0]} join our meeting", "we'd love ${profile.user.name.split(' ')[0]} in our call".

Route 2 — the COLLEAGUE owns the meeting and its invite. Maelle does NOT book or add anyone. She only confirms availability so the colleague can send the invite themselves.

Reply phrasing when available:
- RIGHT: "Yes, he's free at 3pm — send him the invite."
- RIGHT: "He's free, you can add him."
- WRONG: "Want me to add him to the invite?" (Maelle doesn't own the meeting, can't add)
- WRONG: "I'll add him." (same — not hers to do)

Results:
- Free → confirm availability, tell the colleague to send the invite themselves
- Partially free → offer partial join (first or last N minutes), same ownership rule
- Blocked by scheduling rule (lunch, buffer) → escalate to owner with context
- Busy with another meeting → decline with the conflict info

If the meeting is NOT yet booked and they need to find a time together, use coordinate_meeting instead.`,
        input_schema: {
          type: 'object',
          properties: {
            meeting_start: {
              type: 'string',
              description: 'Meeting start time in ISO format (e.g. "2026-04-14T14:00:00"). Convert relative times ("Tuesday at 2pm") to ISO before calling.',
            },
            duration_min: { type: 'number', description: 'Meeting duration in minutes' },
            subject: { type: 'string', description: 'What the meeting is about' },
            reason: { type: 'string', description: 'Why should the owner join — context from the requester' },
            requester_name: { type: 'string', description: 'Name of the person asking' },
          },
          required: ['meeting_start', 'duration_min', 'subject', 'requester_name'],
        },
      },
      // ── Direct calendar ops (from former SchedulingSkill) ─────────────
      {
        name: 'get_calendar',
        description: "Read the user's calendar events for a given date range. Use for specific scheduling decisions (finding slots, checking a meeting exists, etc.). For weekly reviews or issue detection, use analyze_calendar instead. Also call this before sending any reminder or message that references a specific meeting — always verify the exact title and time from the calendar before using it.",
        input_schema: {
          type: 'object',
          properties: {
            start_date: { type: 'string', description: 'Start date YYYY-MM-DD in the user\'s local timezone. Use the DATE LOOKUP table — never calculate.' },
            end_date: { type: 'string', description: 'End date YYYY-MM-DD in the user\'s local timezone.' },
          },
          required: ['start_date', 'end_date'],
        },
      },
      {
        name: 'analyze_calendar',
        description: `Analyze the calendar for a date range and return a structured report of issues per day. Use this when asked: "any issues next week?", "what's wrong with my calendar?", "check my schedule", "do I have lunch?", "am I too busy?".`,
        input_schema: {
          type: 'object',
          properties: {
            start_date: { type: 'string', description: 'Start date YYYY-MM-DD. Use the DATE LOOKUP table — never calculate.' },
            end_date:   { type: 'string', description: 'End date YYYY-MM-DD.' },
          },
          required: ['start_date', 'end_date'],
        },
      },
      {
        name: 'dismiss_calendar_issue',
        description: `Mark a calendar issue as acknowledged so it won't be flagged again in future checks. Use this when the user says "that's fine", "I'm ok with that", "no need to fix", "leave it", or similar about a specific calendar issue.`,
        input_schema: {
          type: 'object',
          properties: {
            event_date: { type: 'string', description: 'Date of the issue YYYY-MM-DD' },
            issue_type: { type: 'string', enum: ['back_to_back', 'no_buffer', 'missing_floating_block', 'oof_with_meetings', 'work_on_day_off', 'overlap'], description: 'Type of the calendar issue' },
            detail: { type: 'string', description: 'Brief description of the specific issue' },
            resolution: { type: 'string', enum: ['dismissed', 'resolved'], description: '"dismissed" = user is ok with it, "resolved" = the issue was fixed' },
          },
          required: ['event_date', 'issue_type', 'detail'],
        },
      },
      {
        name: 'get_free_busy',
        description: `Check free/busy data for ${profile.user.name.split(' ')[0]}'s own calendar over a date range — e.g. "when is ${profile.user.name.split(' ')[0]} free this week?".

Use ONLY for:
- ${profile.user.name.split(' ')[0]}'s own calendar
- Open-ended "when is he free" ranges

Do NOT use for:
- "Is he free at 3pm today to join my meeting" → use check_join_availability (specific time, existing meeting context)
- Checking colleague availability before scheduling → use coordinate_meeting
- Needing actual bookable slots (with buffers, rules) → use find_available_slots
- Presenting meeting-time options to anyone. Free/busy data does not apply schedule rules (office-day start, thinking-time, lunch, buffer). For bookable options, use find_available_slots (owner asks "when am I free") or coordinate_meeting (meeting needs to be arranged).`,
        input_schema: {
          type: 'object',
          properties: {
            emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses to check' },
            start_date: { type: 'string', description: 'Start of range in ISO 8601 format' },
            end_date: { type: 'string', description: 'End of range in ISO 8601 format' },
          },
          required: ['emails', 'start_date', 'end_date'],
        },
      },
      {
        name: 'find_available_slots',
        description: `Find open slots on ${profile.user.name}'s own calendar — useful when you need to know what times are free before proposing options. NEVER call this directly for colleague scheduling; coordinate_meeting already handles that flow.

Before calling this tool: ASK ${profile.user.name.split(' ')[0]} TWO HUMAN QUESTIONS first if you don't already know the answer. Do NOT use the words "meeting_mode" or list four options — that's robotic. Ask like a person:
  • "In person or online?"
  • If in-person and the venue isn't ${profile.user.name.split(' ')[0]}'s office: "Where?" + "Roughly how long is the trip each way?"

SMART-SKIP THE ASK: when at least one attendee is in a different timezone than ${profile.user.name.split(' ')[0]} (people_memory has the data — Brett ET, Yael NYC, Jenna EST), the meeting is remote by default. The handler will infer this and treat missing meeting_mode as 'online' automatically. Don't ask "in person or online?" when the attendee is clearly remote — it reads obtuse. Only ask when all attendees are in the same TZ as ${profile.user.name.split(' ')[0]}.

Then YOU pick the right meeting_mode based on what they said:
  • "online" / "Teams" / "Zoom" / "call" / "video" → meeting_mode='online'
  • "in person at the office" / "in person" with no other venue → meeting_mode='in_person'
  • "in person at <somewhere else>" / "at the client" / "their place" / "offsite" / "I need to join their meeting" → meeting_mode='custom' AND pass travel_buffer_minutes from their answer (one-way minutes)
  • "either" / "whatever works" / "doesn't matter" → meeting_mode='either'

The search window auto-expands up to 21 days if fewer than 3 slots are found.`,
        input_schema: {
          type: 'object',
          properties: {
            duration_minutes: { type: 'number', enum: profile.meetings.allowed_durations },
            attendee_emails: { type: 'array', items: { type: 'string' } },
            search_from: { type: 'string', description: 'Start of search window in ISO 8601 format' },
            search_to: { type: 'string', description: 'End of search window in ISO 8601 format (auto-expanded up to 21 days if fewer than 3 slots found)' },
            prefer_morning: { type: 'boolean', description: 'Prefer morning slots in the user timezone' },
            meeting_mode: {
              type: 'string',
              enum: ['in_person', 'online', 'either', 'custom'],
              description: 'REQUIRED. Ask the owner if you do not know.',
            },
            travel_buffer_minutes: {
              type: 'number',
              description: 'Only for meeting_mode=custom. One-way travel time in minutes; the tool pads slots on BOTH sides so the meeting does not crash into adjacent events.',
            },
            must_be_after_event_id: {
              type: 'string',
              description: 'OPTIONAL. When set, the search clips its earliest slot to AFTER the end of the referenced event. Use when the user is booking an ordered series ("first M1, then M2 must come after M1, then M3 after M2…") to enforce ordering as a constraint instead of solving order in your head. Pass the event id from get_calendar of the predecessor meeting. Omit when there is no predecessor.',
            },
            ignore_attendee_availability: {
              type: 'boolean',
              description: 'OPTIONAL (default false). By default on owner-initiated calls with attendees, the tool filters slots by both (a) each attendee\'s working hours / timezone (their day-window) and (b) their busy time from Graph free/busy. Set true ONLY when owner explicitly says "force them to move their meeting" / "ignore their calendar, I want this slot anyway" — that suppresses the BUSY filter. Their work-hours / timezone window is ALWAYS honored regardless of this flag — owner direction: "force them to move another meeting, not to wake up at 3 AM."',
            },
            relaxed: {
              type: 'boolean',
              description: 'OPTIONAL (default false). Owner-only "show me everything" mode. When true, the search bypasses focus-time protection, lunch / floating-block windows, and work-hour strictness — but ALWAYS keeps the 5-min buffer between meetings (sacred). Use ONLY when the strict pass returned 0 / too few options AND the owner is asking "what else is open?". When you present these slots to the owner, MUST flag the soft rule each one breaks: "outside your work hours", "would land on your lunch", "leaves only X min of focus time". Owner decides whether to book.',
            },
            moving_event_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'OPTIONAL. Pass when validating or discovering a MOVE — these are the calendar event id(s) of the meeting(s) being moved. Each id\'s current time is (1) SUBTRACTED from the owner\'s busy pool so candidate slots aren\'t blocked by a meeting that\'s leaving, AND (2) FORBIDDEN as a candidate so the tool never offers the original time (or any overlap with it) as a "move target". Use when the owner asks "can we move the 11am to 10:30?" / "what are options to move the 11am?". Get the event id from get_calendar. Omit for new bookings.',
            },
          },
          required: ['duration_minutes', 'attendee_emails', 'search_from', 'search_to', 'meeting_mode'],
        },
      },
      {
        name: 'create_meeting',
        description: `Create a new calendar event directly (no coord needed — use this when the owner already knows the time + attendees). Call coordinate_meeting instead when participants need to agree on a time. Follow the location / category / work-day rules in the prompt section.

ONLINE vs IN-PERSON for EXTERNAL attendees (v2.3.2 / v2.3.6): when at least one attendee has an email outside ${profile.user.email.split('@')[1]}, you must determine the meeting mode before booking. CHECK these signals — IF ANY MATCH, do NOT ask, just decide:
- Their people_memory entry shows a different timezone than the owner — they're remote → is_online=true (the WORKSPACE CONTACTS block in your context shows each person's tz; if it differs from ${profile.user.timezone}, they're remote)
- The conversation explicitly mentions a TZ or remote location ("3pm ET", "from Boston", "we'll do it on Zoom") → is_online=true
- The conversation explicitly mentions in-person ("at our office", "in person", "they'll come over") → is_online=false
- ONLY if none of the above signals match → ASK whoever you're talking to right now. Owner-path → ask owner. Colleague-path (external in your DM) → ask the external. Don't reach across to bother the other party.

Asking when a clear remote signal exists is a friction bug — the data is there, use it. Owner has already told you "Boston" / "EST" / TZ once; reading it from people_memory next turn is your job, not his to repeat.

Once mode is settled: online → is_online=true, location optional. Physical at owner's office → is_online=false, leave location blank (the system fills in office address from yaml). Physical elsewhere → is_online=false, location=that venue.

Colleague-path (v2.3.2): when a colleague has confirmed slot + duration + subject in this DM with you, call this tool directly to book the 1:1. The handler enforces server-side: single colleague-attendee (the requester themselves — multi-party still goes through coordinate_meeting), rule-compliant slot (work hours, work days, buffers, floating blocks, no conflicts via findAvailableSlots), then auto shadow-DMs the owner so he sees it happen. If the slot fails the rule check, the tool returns { success: false, error: 'not_rule_compliant', message } — fall back to create_approval(kind=policy_exception). DO NOT punt with "go ahead and send him the calendar invite" — the colleague's invite won't have the owner's location prefs, won't get auto-categorized, and the owner gets no shadow record. YOU are the EA; YOU book it.

LANGUAGE: subject and body MUST be in English regardless of the language you're conversing in. Calendar invites are shared artifacts other people read — their language must be predictable. If the owner instructs in Hebrew, translate to English for the artifact.`,
        input_schema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Meeting subject — ENGLISH ONLY, even when conversing in Hebrew.' },
            start: { type: 'string', description: 'ISO 8601 datetime in user local timezone' },
            end: { type: 'string', description: 'ISO 8601 datetime in user local timezone' },
            attendees: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, email: { type: 'string' } },
                required: ['name', 'email'],
              },
            },
            body: { type: 'string', description: 'Optional meeting body — ENGLISH ONLY.' },
            is_online: { type: 'boolean' },
            location: { type: 'string' },
            category: categoryEnum ? { type: 'string', enum: categoryEnum } : { type: 'string' },
            add_room_email: { type: 'boolean' },
            override_work_day: { type: 'boolean' },
            must_be_after_event_id: {
              type: 'string',
              description: 'OPTIONAL. When set, the booking refuses if the proposed start is BEFORE the end of the referenced event. Use when this meeting is part of an ordered series ("M2 must come after M1") to make the order constraint enforceable at booking time. Pass the event id from get_calendar (or from the previous create_meeting return) of the predecessor. Omit when there is no predecessor.',
            },
          },
          required: ['subject', 'start', 'end', 'attendees', 'is_online', 'category'],
        },
      },
      {
        name: 'move_meeting',
        description: `Move (reschedule) an existing meeting to a new time slot. ALWAYS prefer this over delete + recreate — it preserves attendees, the Teams link, and meeting history.

Owner-path: owner override IS the approval. Move the meeting when he asks.

Colleague-path (v2.2.1): when a colleague asks to move a meeting you've already booked with them, call this directly. The handler runs a rule-compliance check server-side (owner's work hours, work days, buffers, floating blocks, no conflicts). If the new slot passes, the move happens silently and the owner is shadow-notified. If the new slot breaks a rule, the tool returns { needs_owner_approval: true, reason, message } — don't keep trying; fall back to create_approval(kind=meeting_reschedule) with the requested slot so the owner can decide, and tell the colleague warmly that you're checking.`,
        input_schema: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            meeting_subject: { type: 'string' },
            new_start: { type: 'string' },
            new_end: { type: 'string' },
            confirm_outside_window: {
              type: 'boolean',
              description: 'OPTIONAL. Owner override flag for floating-block moves. When the meeting being moved is a floating block (lunch / coffee / gym / etc) AND the new_start lands OUTSIDE the block\'s preferred window, the move refuses by default. Set this true to accept the override — owner override IS the approval, no separate lunch_bump approval needed. Use ONLY when the owner has explicitly confirmed they want the block at the out-of-window time. Ignored on non-floating-block moves.',
            },
          },
          required: ['meeting_id', 'meeting_subject', 'new_start', 'new_end'],
        },
      },
      {
        name: 'update_meeting',
        description: `Update metadata on an existing meeting — category, subject, or body — without rescheduling it.`,
        input_schema: {
          type: 'object',
          properties: {
            meeting_id:      { type: 'string' },
            meeting_subject: { type: 'string' },
            category:        categoryEnum ? { type: 'string', enum: categoryEnum } : { type: 'string' },
            new_subject:     { type: 'string' },
          },
          required: ['meeting_id', 'meeting_subject'],
        },
      },
      {
        name: 'delete_meeting',
        description: `Cancel and permanently delete a meeting. Ask the user to confirm first; only call after explicit yes.`,
        input_schema: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            meeting_subject: { type: 'string' },
          },
          required: ['meeting_id', 'meeting_subject'],
        },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const { profile, channelId, threadTs } = context;

    switch (toolName) {

      case 'find_slack_user': {
        // Execute directly using the app client from context
        if (!context.app) return { error: 'App not available' };
        try {
          const token = profile.assistant.slack.bot_token;
          const query = (args.name as string).toLowerCase();
          // Store full raw member alongside match so we can read pronouns/image later
          const matches: Array<{ slack_id: string; name: string; timezone: string; email?: string; _raw: any }> = [];
          let cursor: string | undefined;

          // Paginate through all workspace members — avoids missing people in large workspaces
          do {
            const result = await context.app.client.users.list({
              token,
              limit: 200,
              ...(cursor ? { cursor } : {}),
            });
            const members = (result.members as any[]) ?? [];

            for (const m of members) {
              if (
                !m.deleted && !m.is_bot &&
                (m.real_name?.toLowerCase().includes(query) ||
                 m.name?.toLowerCase().includes(query) ||
                 m.profile?.display_name?.toLowerCase().includes(query))
              ) {
                matches.push({
                  slack_id: m.id,
                  name:     m.real_name || m.profile?.display_name || m.name,
                  timezone: m.tz || 'UTC',
                  email:    m.profile?.email,
                  _raw:     m,
                });
              }
            }

            cursor = (result.response_metadata as any)?.next_cursor || undefined;
          } while (cursor && matches.length < 20);  // stop once we have 20 matches or exhausted

          // Persist all matches into people_memory and kick off gender detection
          const botToken = profile.assistant.slack.bot_token;
          for (const match of matches) {
            upsertPersonMemory({
              slackId:  match.slack_id,
              name:     match.name,
              email:    match.email,
              timezone: match.timezone,
            });
            detectAndSaveGender({
              slackId:  match.slack_id,
              name:     match.name,
              pronouns: match._raw?.profile?.pronouns || undefined,
              imageUrl: match._raw?.profile?.image_192 || match._raw?.profile?.image_72 || undefined,
              botToken,
            }).catch(() => {});
          }

          // Fallback for guest users: users.list() may not return single/multi-channel guests.
          // If no matches found, check people_memory for a known slack_id and validate via users.info().
          if (matches.length === 0) {
            const memoryMatches = searchPeopleMemory(args.name as string);
            for (const pm of memoryMatches) {
              if (!pm.slack_id || !/^U[A-Z0-9]{7,11}$/.test(pm.slack_id)) continue;
              try {
                const info = await context.app.client.users.info({ token, user: pm.slack_id });
                const u = info.user as any;
                if (u && !u.deleted) {
                  matches.push({
                    slack_id: u.id,
                    name: u.real_name || u.profile?.display_name || u.name,
                    timezone: u.tz || 'UTC',
                    email: u.profile?.email,
                    _raw: u,
                  });
                  // Persist updated info
                  upsertPersonMemory({
                    slackId: u.id,
                    name: u.real_name || u.profile?.display_name || u.name,
                    email: u.profile?.email,
                    timezone: u.tz || 'UTC',
                  });
                  logger.info('Found guest user via users.info fallback', { slackId: u.id, name: u.real_name });
                }
              } catch {
                // users.info failed — ID might be invalid, skip
              }
            }
          }

          const cleanMatches = matches.map(({ _raw: _, ...m }) => m);

          // v2.4.3 (C1) — explicit external-email signal. When a query was an
          // email AND no Slack match found AND the email is outside the owner's
          // company domain, return external:true so Sonnet doesn't read the
          // empty result as "blocked, can't book". External attendees never
          // need Slack — Outlook delivers the calendar invite directly.
          // Pre-v2.4.3 Sonnet was sometimes asking colleagues to "forward
          // the invite or share the email" even when she already had the
          // email and the person was external — pure mental-model bug
          // because find_slack_user returned a bare empty list.
          const queryRaw = (args.name as string).trim();
          const isEmail = /@/.test(queryRaw);
          const ownerEmail = (profile.user.email ?? '').toLowerCase();
          const ownerDomain = ownerEmail.includes('@') ? ownerEmail.split('@')[1] : '';
          const isExternalEmail = isEmail && ownerDomain &&
            !queryRaw.toLowerCase().endsWith('@' + ownerDomain);
          if (cleanMatches.length === 0 && isExternalEmail) {
            return {
              matches: [],
              count: 0,
              external: true,
              email: queryRaw.toLowerCase(),
              message: `${queryRaw} is an external email (outside ${ownerDomain}) — they don't need a Slack ID. Proceed with create_meeting / coordinate_meeting using the email; Outlook will deliver the calendar invite. Don't ask anyone to "forward the invite" — that's automatic.`,
            };
          }

          return { matches: cleanMatches, count: cleanMatches.length };
        } catch (err) {
          return { error: String(err) };
        }
      }

      case 'coordinate_meeting': {
        const { email: userEmail, timezone, slack_user_id: ownerUserId, name: ownerName } = profile.user;

        // v2.0.6 — deterministic email fill-in for participants and just_invite.
        // Sonnet was previously dropping the email field from these arrays even
        // though we had the email in people_memory, resulting in Graph invites
        // sent with empty email strings: Outlook showed a red "unresolved
        // recipient" circle and just_invite folk weren't actually invited.
        // Fill from DB before any downstream use. If email is still missing
        // after lookup AND the participant has neither slack_id nor a resolvable
        // name, refuse the call so Sonnet has to fix the args.
        const participantsIn = (args.participants as any[] | undefined) ?? [];
        const justInviteIn = (args.just_invite as any[] | undefined) ?? [];
        const missingEmails: string[] = [];

        for (const p of participantsIn) {
          if (p.email && typeof p.email === 'string' && p.email.includes('@')) continue;
          // Try slack_id lookup in people_memory
          if (p.slack_id) {
            const mem = getPersonMemory(p.slack_id);
            if (mem?.email) { p.email = mem.email; continue; }
          }
          // Try fuzzy name lookup
          if (p.name) {
            const matches = searchPeopleMemory(p.name);
            const hit = matches.find(m => m.email && m.email.includes('@'));
            if (hit) { p.email = hit.email; continue; }
          }
          missingEmails.push(p.name ?? p.slack_id ?? '(unknown)');
        }

        for (const p of justInviteIn) {
          if (p.email && typeof p.email === 'string' && p.email.includes('@')) continue;
          if (p.slack_id) {
            const mem = getPersonMemory(p.slack_id);
            if (mem?.email) { p.email = mem.email; continue; }
          }
          if (p.name) {
            const matches = searchPeopleMemory(p.name);
            const hit = matches.find(m => m.email && m.email.includes('@'));
            if (hit) { p.email = hit.email; continue; }
          }
          missingEmails.push(p.name ?? '(unknown)');
        }

        if (missingEmails.length > 0) {
          logger.warn('coordinate_meeting refused — missing emails after DB fill-in', {
            missingEmails,
            subject: args.subject,
          });
          return {
            error: 'missing_participant_emails',
            missing: missingEmails,
            message: `I can't coordinate this yet — I don't have email addresses for: ${missingEmails.join(', ')}. Email is REQUIRED for booking (Slack ID is optional). Get the email from the owner or via find_slack_user, then re-call.`,
          };
        }

        // v2.4.3 (C1) — auto-demote external participants (no slack_id, can't
        // be DM'd) to just_invite. Pre-v2.4.3 the schema REQUIRED slack_id on
        // every participant, which forced Sonnet to either hallucinate a slug
        // (recurring user_not_found bug) or skip externals entirely. Now email
        // is the only required field on participants; if a participant lacks
        // a Slack ID, they obviously can't be polled via DM — so we move them
        // into just_invite (calendar-invite-only) where they belong. Sonnet's
        // intent is preserved (the person is on the meeting), just the
        // mechanism shifts to email-only.
        const demotedExternals: Array<{ name: string; email: string }> = [];
        const trueParticipants: any[] = [];
        for (const p of participantsIn) {
          if (p.slack_id && typeof p.slack_id === 'string' && p.slack_id.length > 0) {
            trueParticipants.push(p);
          } else {
            demotedExternals.push({ name: p.name ?? p.email, email: p.email });
          }
        }
        if (demotedExternals.length > 0) {
          logger.info('coordinate_meeting — auto-demoted externals from participants to just_invite', {
            demoted: demotedExternals.map(d => d.email),
            subject: args.subject,
          });
          // Mutate args.participants + args.just_invite so all downstream
          // logic (slot finder, coord state machine, calendar booking)
          // sees the corrected lists.
          (args as any).participants = trueParticipants;
          const existingJustInvite = (args.just_invite as any[]) ?? [];
          // Skip dupes — if owner already listed an external in both fields
          // by mistake, we don't want them in twice.
          const existingEmails = new Set(existingJustInvite.map(j => (j.email ?? '').toLowerCase()));
          for (const ext of demotedExternals) {
            if (!existingEmails.has(ext.email.toLowerCase())) {
              existingJustInvite.push(ext);
            }
          }
          (args as any).just_invite = existingJustInvite;
        }

        logger.info('coordinate_meeting — emails filled', {
          participantCount: ((args as any).participants as any[]).length,
          justInviteCount: ((args as any).just_invite as any[] | undefined)?.length ?? 0,
          demotedExternalCount: demotedExternals.length,
          subject: args.subject,
        });

        const keyParticipantCount = (args.participants as any[]).length;
        if (keyParticipantCount > 4) {
          return {
            error: 'too_many_key_participants',
            count: keyParticipantCount,
            message: `You have ${keyParticipantCount} key participants — that's too many to coordinate via DM. Ask the owner: who are the 1-4 people whose schedule truly matters? Everyone else should go in just_invite. Re-call once narrowed down.`,
          };
        }

        // ── Owner auto-inclusion for colleague-initiated coord ──────────────────
        // Maelle is the owner's assistant — any meeting a colleague asks her to
        // coordinate is implicitly WITH the owner. We don't refuse coords that
        // left the owner out (that created its own bug class: Maelle would
        // malform the args, the layer-1 refuse would tell her to reject, and
        // the colleague would be told nothing was booked). Instead: always
        // ensure the owner is in `participants` so the calendar pulls his free-
        // busy into the search. The owner is later filtered out of the "who to
        // DM for availability" list downstream (he doesn't DM himself).
        if (context.senderRole === 'colleague') {
          const participants = (args.participants as any[] | undefined) ?? [];
          const justInvite   = (args.just_invite   as any[] | undefined) ?? [];
          const ownerInParticipants = participants.some((p: any) => p.slack_id === ownerUserId);
          const ownerInJustInvite   = justInvite.some((p: any)   => p.slack_id === ownerUserId);
          if (!ownerInParticipants) {
            const ownerEntry = {
              name: ownerName,
              slack_id: ownerUserId,
              email: userEmail,
              tz: timezone,
            };
            args.participants = [ownerEntry, ...participants];
            // If the owner was only in just_invite for some reason, drop that
            // duplicate so we don't double-list him.
            if (ownerInJustInvite) {
              args.just_invite = justInvite.filter((p: any) => p.slack_id !== ownerUserId);
            }
            logger.info('Owner auto-added to colleague-initiated coord', {
              senderUserId: context.userId,
              ownerUserId,
              subject: args.subject,
              originalParticipants: participants.map((p: any) => ({ name: p.name, slack_id: p.slack_id })),
            });
          }
        }

        // ── Third-party-scheduler signal (v2.3.5) ──────────────────────────────
        // When the colleague tells Sonnet "I'm coordinating a meeting between X
        // and Y, I'm not joining" (HR booking interviews, EA scheduling on
        // behalf of someone else), Sonnet sets requester_is_attending=false.
        // Defense-in-depth: drop the requester from `participants` AND
        // `just_invite` if they slipped in — their availability must NOT be
        // factored in, and they shouldn't show up on the invite by default.
        // Sonnet can re-add them to just_invite explicitly if they want a
        // calendar copy.
        if (
          context.senderRole === 'colleague' &&
          args.requester_is_attending === false &&
          context.userId
        ) {
          const requesterId = context.userId;
          const beforePartCount = ((args.participants as any[] | undefined) ?? []).length;
          const beforeInviteCount = ((args.just_invite as any[] | undefined) ?? []).length;
          args.participants = ((args.participants as any[] | undefined) ?? [])
            .filter((p: any) => p.slack_id !== requesterId);
          args.just_invite = ((args.just_invite as any[] | undefined) ?? [])
            .filter((p: any) => p.slack_id !== requesterId);
          const afterPartCount = (args.participants as any[]).length;
          const afterInviteCount = (args.just_invite as any[]).length;
          if (beforePartCount !== afterPartCount || beforeInviteCount !== afterInviteCount) {
            logger.info('Third-party-scheduler — requester removed from attendees', {
              requesterId,
              senderName: context.senderRole,
              participantsRemoved: beforePartCount - afterPartCount,
              justInviteRemoved: beforeInviteCount - afterInviteCount,
              subject: args.subject,
            });
          }
        }

        // ── Duration validation (v2.3.1 — B8) ──────────────────────────────────
        // Owner direction: don't keep two durations alive in the system. Either
        // pick the right one upfront, or wait for owner approval — never both.
        // Strategy (i): when colleague requests a non-standard duration with an
        // OBVIOUS snap target (≤5 min off a standard length), snap immediately
        // and use the standard. Sonnet tells the requester "I went with N
        // instead of M since that's standard" in the reply text. If the
        // requester pushes back, THAT response triggers the original approval
        // path — but until then, only one duration is alive (the standard one).
        let durationMin = args.duration_min as number;
        const requestedDurationMin = durationMin;
        const allowedDurations = profile.meetings.allowed_durations;
        const isStandardDuration = allowedDurations.includes(durationMin);
        let snappedFromNonStandard = false;

        if (!isStandardDuration && context.senderRole === 'colleague') {
          // Find the closest allowed duration. ≤10 min delta = obvious snap.
          // Larger deltas (e.g. 90 → 60 or 30) are too consequential — fall
          // back to approval rather than silently halving.
          const SNAP_TOLERANCE_MIN = 10;
          let nearest = allowedDurations[0];
          let nearestDelta = Math.abs(durationMin - nearest);
          for (const d of allowedDurations) {
            const delta = Math.abs(durationMin - d);
            if (delta < nearestDelta) { nearest = d; nearestDelta = delta; }
          }
          if (nearestDelta <= SNAP_TOLERANCE_MIN) {
            durationMin = nearest;
            snappedFromNonStandard = true;
            logger.info('coordinate_meeting — snapped non-standard duration to nearest allowed', {
              requested: requestedDurationMin, snapped: durationMin, delta: nearestDelta,
              requester: context.userId,
            });
          }
        }

        // Only escalate to approval when snap failed (delta too large). Owner
        // sees the gate ONLY for cases where Sonnet couldn't snap cleanly —
        // most non-standard requests (45 → 40, 50 → 55) snap silently.
        const isStandardAfterSnap = allowedDurations.includes(durationMin);
        const needsDurationApproval = !isStandardAfterSnap && context.senderRole === 'colleague';

        // ── Validate slack_ids ──────────────────────────────────────────────────
        const validatedParticipants = (args.participants as any[]).map((p: any) => {
          const sid = p.slack_id as string;
          const isValid = /^U[A-Z0-9]{7,11}$/.test(sid);
          if (isValid) return p;
          const matches = searchPeopleMemory(p.name as string);
          if (matches.length === 1 && /^U[A-Z0-9]{7,11}$/.test(matches[0].slack_id)) {
            return { ...p, slack_id: matches[0].slack_id, tz: matches[0].timezone ?? p.tz };
          }
          return { ...p, _invalid_id: true };
        });

        const invalidParticipants = validatedParticipants.filter((p: any) => p._invalid_id);
        if (invalidParticipants.length > 0) {
          return {
            error: 'invalid_slack_ids',
            invalid: invalidParticipants.map((p: any) => p.name),
            message: `These participant Slack IDs look invalid: ${invalidParticipants.map((p: any) => p.name).join(', ')}. Use find_slack_user to look up their correct IDs before calling coordinate_meeting.`,
          };
        }
        args.participants = validatedParticipants;

        // ── Preflight (v1.8.4) — existing-meeting detection ─────────────────────
        // If an event with a matching subject AND at least one overlapping
        // participant already exists on the calendar in the search window, the
        // owner almost certainly meant to MOVE that existing meeting — not
        // create a new one. coordinate_meeting creates new meetings; for
        // rescheduling an existing meeting, message_colleague with a reschedule
        // intent is the right flow. This check catches the specific "Sonnet
        // picked coord_meeting when she should have picked message_colleague"
        // bug (issue #26 aftermath, v1.8.4).
        try {
          const requestedSubject = String(args.subject ?? '').trim();
          const participantNames = (args.participants as any[])
            .map((p: any) => (p.name ? String(p.name).toLowerCase() : null))
            .filter((n: string | null): n is string => n !== null && n.length > 0);
          const participantEmailsAll = (args.participants as any[])
            .map((p: any) => (p.email ? String(p.email).toLowerCase() : null))
            .filter((e: string | null): e is string => e !== null && e.length > 0);

          if (requestedSubject.length >= 3 && participantNames.length > 0) {
            const { getCalendarEvents } = await import('../connectors/graph/calendar');
            const searchStart = DateTime.now().setZone(timezone).startOf('day').toFormat('yyyy-MM-dd');
            const searchEnd = DateTime.now().setZone(timezone).plus({ days: 14 }).toFormat('yyyy-MM-dd');
            const rawEvents = await getCalendarEvents(userEmail, searchStart, searchEnd, timezone);

            const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
            const requestedNorm = normalize(requestedSubject);

            for (const ev of rawEvents) {
              if (ev.isCancelled) continue;
              const evSubjectNorm = normalize(ev.subject ?? '');
              if (!evSubjectNorm) continue;

              // Subject match: exact, or either is a substring of the other (handles
              // "BiWeekly Idan & Yael" vs "BiWeekly Idan Yael" both ways)
              const subjectMatches =
                evSubjectNorm === requestedNorm ||
                evSubjectNorm.includes(requestedNorm) ||
                requestedNorm.includes(evSubjectNorm);
              if (!subjectMatches) continue;

              // Participant match: check existing event's attendees for any overlap
              // with the coord's requested participants (by email or name).
              const evAttendees = (ev.attendees ?? []).map((a: any) => ({
                name: (a.emailAddress?.name ?? '').toLowerCase(),
                email: (a.emailAddress?.address ?? '').toLowerCase(),
              }));
              const participantMatches = evAttendees.some((a: any) => {
                if (a.email && participantEmailsAll.includes(a.email)) return true;
                if (!a.name) return false;
                return participantNames.some(pn => a.name.includes(pn) || pn.includes(a.name));
              });
              if (!participantMatches) continue;

              // Match found — refuse the coord and steer toward message_colleague
              const evDateTime = ev.start?.dateTime
                ? DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone || timezone })
                : null;
              const whenStr = evDateTime && evDateTime.isValid
                ? evDateTime.toFormat('EEE d MMM HH:mm')
                : 'soon';

              logger.info('coordinate_meeting preflight blocked — existing meeting matched', {
                requestedSubject,
                existingSubject: ev.subject,
                existingStart: ev.start?.dateTime,
                participantNames,
              });
              return {
                error: 'existing_meeting_on_calendar',
                existing_subject: ev.subject,
                existing_start: ev.start?.dateTime,
                existing_when_local: whenStr,
                message: `There's already a "${ev.subject}" on the calendar for ${whenStr} with overlapping participants. coordinate_meeting creates NEW meetings — if the owner wants to MOVE or RESCHEDULE the existing one, use message_colleague instead: send a DM asking the participant if the new time works, and when they reply yes, call move_meeting on the existing event. Only call coordinate_meeting again if this is definitely a separate new meeting (not a reschedule).`,
              };
            }
          }
        } catch (err) {
          // Fail open — preflight errors should not break legitimate coord calls
          logger.warn('coordinate_meeting preflight failed — skipping check', { err: String(err) });
        }

        // ── Date range: default to now, search forward until 3 options found ────
        const now = DateTime.now().setZone(timezone);
        // Owner can request urgent same-day meetings — reduce buffer to 1h
        const isOwnerRequest = context.senderRole === 'owner' || context.isOwnerInGroup === true;
        const minBufferHours = isOwnerRequest ? 1 : (profile.meetings.min_slot_buffer_hours ?? 4);
        const earliestSlot = now.plus({ hours: minBufferHours });
        const searchFromDate = args.search_from
          ? `${args.search_from as string}T00:00:00`
          : earliestSlot.toFormat("yyyy-MM-dd'T'HH:mm:ss");

        const extendedHours = args.extended_hours_ok === true;
        const allWorkDays = [
          ...context.profile.schedule.office_days.days,
          ...context.profile.schedule.home_days.days,
        ] as string[];
        const ownerDomain = userEmail.split('@')[1];
        const participantEmails = (args.participants as any[])
          .map((p: any) => p.email)
          .filter((e: any) => e && typeof e === 'string' && e.endsWith(`@${ownerDomain}`));

        // v2.3.6 (#70a) — auto-load attendee work-hour availability for the
        // slot search. Pulls timezone + workdays + hoursStart/hoursEnd from
        // people_memory for every participant we recognize (internal AND
        // external). Pre-clips slots to the intersection of everyone's
        // working window so Brett (Boston/EST) doesn't get proposed 10:15 IL
        // (3:15 ET). Note: this is WORK-HOUR clipping only — busy/free is
        // a separate concern handled by `attendeeBusyEmails` (existing,
        // internal-only) and `annotateSlotsWithAttendeeStatus` (annotation
        // overlay, not a hard filter).
        const allParticipantEmails = (args.participants as any[])
          .map((p: any) => p.email)
          .filter((e: any) => e && typeof e === 'string' && e.includes('@'));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { loadAttendeeAvailabilityForEmails } =
          require('../utils/attendeeAvailability') as typeof import('../utils/attendeeAvailability');
        const attendeeAvailability = loadAttendeeAvailabilityForEmails(allParticipantEmails, userEmail);

        // Search in expanding windows until we have 3 spread options
        let allCandidateSlots: Array<{ start: string; end: string }> = [];
        let searchEndDate = args.search_to
          ? `${args.search_to as string}T23:59:59`
          : now.endOf('week').toFormat("yyyy-MM-dd'T'HH:mm:ss");
        const MAX_SEARCH_WEEKS = 12;

        for (let attempt = 0; attempt < MAX_SEARCH_WEEKS; attempt++) {
          try {
            try {
              allCandidateSlots = await findAvailableSlots({
                userEmail,
                timezone,
                durationMinutes: durationMin,
                attendeeEmails: participantEmails,
                // v2.3.2 — also subtract INTERNAL attendees' busy time. Owner
                // direction (mixed-case): pre-filter slots by internal
                // free/busy so externals never see options where Amazia is
                // already booked. Externals' busy is unreadable via Graph and
                // stays out of this filter — they get DM'd with the surviving
                // slots through the regular coord state machine. Pure-internal
                // coords short-circuit through the fast-path below before
                // reaching the coord state machine at all.
                attendeeBusyEmails: participantEmails,
                // v2.3.6 (#70a) — clip slots to attendee work-hour windows
                // in their own TZ. Pure work-hour data, no busy/free involvement.
                attendeeAvailability,
                searchFrom: searchFromDate,
                searchTo: searchEndDate,
                preferMorning: true,
                workDays: allWorkDays,
                workHoursStart: extendedHours ? '07:00' : context.profile.schedule.home_days.hours_start,
                workHoursEnd: extendedHours ? '22:00' : context.profile.schedule.office_days.hours_end,
                minBufferHours,
                profile: context.profile,
                // coord flow doesn't know mode upfront — location is auto-determined
                // per slot later in determineSlotLocation. Use 'either' so both day
                // types are searched and returned tagged.
                meetingMode: 'either',
                autoExpand: false,  // coord has its own expansion loop below
              });
            } catch (permErr) {
              if (permErr instanceof GraphPermissionError) {
                allCandidateSlots = await findAvailableSlots({
                  userEmail,
                  timezone,
                  durationMinutes: durationMin,
                  attendeeEmails: [],
                  searchFrom: searchFromDate,
                  searchTo: searchEndDate,
                  preferMorning: true,
                  workDays: allWorkDays,
                  workHoursStart: extendedHours ? '07:00' : context.profile.schedule.home_days.hours_start,
                  workHoursEnd: extendedHours ? '22:00' : context.profile.schedule.office_days.hours_end,
                  minBufferHours,
                  profile: context.profile,
                  meetingMode: 'either',
                  autoExpand: false,
                });
              } else {
                throw permErr;
              }
            }
          } catch (err) {
            logger.error('Failed to find slots for coordination', { err });
            return { error: 'Could not check your calendar availability. Please try again.' };
          }

          const chosen = pickSpreadSlots(allCandidateSlots, timezone, 3);
          if (chosen.length >= 3 || args.search_to) break; // User specified end date — don't expand

          // Expand search window by 1 week
          const currentEnd = DateTime.fromISO(searchEndDate, { zone: timezone });
          searchEndDate = currentEnd.plus({ weeks: 1 }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
        }

        if (allCandidateSlots.length === 0) {
          if (!extendedHours) {
            return {
              no_slots_in_working_hours: true,
              error: 'No available slots found within normal working hours. Call coordinate_meeting again with extended_hours_ok=true to search 07:00-22:00, but tell the user first: "Nothing works in your normal hours — want me to look at early morning or evening slots too?"',
            };
          }
          return { error: 'No available slots found even in extended hours.' };
        }

        const chosenStarts = pickSpreadSlots(allCandidateSlots, timezone, 3);

        // ── Determine location per slot ─────────────────────────────────────────
        const allParticipantsList = [
          ...(args.participants as any[]),
          ...((args.just_invite as any[]) ?? []),
        ];
        const totalPeople = allParticipantsList.length + 1; // +1 for owner
        const isInternal = allParticipantsList.every((p: any) =>
          !p.email || (typeof p.email === 'string' && p.email.endsWith(`@${ownerDomain}`))
        );
        const customLocation = args.custom_location as string | undefined;

        // v2.2.4 (bug 8b) — if any participant is currently traveling, force
        // online. Stops "Idan's Office" landing on a meeting where someone's
        // in Boston.
        let anyTraveling = false;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getCurrentTravel } = require('../db') as typeof import('../db');
          for (const p of allParticipantsList) {
            const sid = (p as any).slack_id as string | undefined;
            if (sid && getCurrentTravel(sid)) { anyTraveling = true; break; }
          }
        } catch (_) { /* fail open */ }

        const proposedSlots: SlotWithLocation[] = chosenStarts.map(slotStart => {
          const loc = determineSlotLocation(slotStart, profile, totalPeople, isInternal, customLocation, anyTraveling);
          return {
            start: slotStart,
            end: DateTime.fromISO(slotStart).plus({ minutes: durationMin }).toISO()!,
            location: loc.location,
            isOnline: loc.isOnline,
          };
        });

        // Merge participants + just_invite
        const justInviteList = ((args.just_invite as any[]) ?? []).map((p: any) => ({
          slack_id: undefined as string | undefined,
          name: p.name as string,
          tz: timezone,
          email: p.email as string | undefined,
          just_invite: true,
        }));
        const allParticipants = [...(args.participants as any[]), ...justInviteList];

        // ── v2.3.2 (4F) — enrich missing emails for INTERNAL attendees ─────
        // For internal teammates, Slack already has their email — no need to
        // ask the owner. Two-step lookup per attendee with a missing email:
        //   1. people_memory (cheap, by slack_id or name)
        //   2. Slack collectCoreInfo (by slack_id) — falls back to users.info
        // Externals that resolve to nothing keep their missing-email status,
        // which downgrades them out of the v2.3.2 fast-path (handled below).
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { searchPeopleMemory, getPersonMemory: getPersonMemoryRow } =
            require('../db') as typeof import('../db');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getConnection: getConn } = require('../connections/registry') as
            typeof import('../connections/registry');
          const slackConn = getConn(profile.user.slack_user_id, 'slack');
          for (const p of allParticipants as any[]) {
            if (p.email) continue;
            // Step 1 — people_memory
            if (p.slack_id) {
              const row = getPersonMemoryRow(p.slack_id as string);
              if (row?.email) { p.email = row.email; continue; }
            }
            if (!p.email && p.name) {
              const matches = searchPeopleMemory(p.name as string);
              const row = matches.find(m => (m.name ?? '').toLowerCase() === (p.name as string).toLowerCase());
              if (row?.email) {
                p.email = row.email;
                if (!p.slack_id && row.slack_id) p.slack_id = row.slack_id;
                continue;
              }
            }
            // Step 2 — Slack lookup (only when we have a slack_id)
            if (!p.email && p.slack_id && slackConn?.collectCoreInfo) {
              try {
                const info = await slackConn.collectCoreInfo(p.slack_id as string);
                if (info?.email) {
                  p.email = info.email;
                  logger.info('coordinate_meeting — email enriched from Slack', {
                    slack_id: p.slack_id, name: p.name,
                  });
                }
              } catch (err) {
                logger.warn('coordinate_meeting — Slack collectCoreInfo threw, skipping enrich', {
                  slack_id: p.slack_id, err: String(err).slice(0, 200),
                });
              }
            }
          }
        } catch (err) {
          logger.warn('coordinate_meeting — attendee enrichment threw, proceeding with input as-is', {
            err: String(err).slice(0, 200),
          });
        }

        // ── Slot-count transparency ─────────────────────────────────────────
        // Removed the user-facing "Only N slots came up — want me to extend?"
        // note: coordinate_meeting dispatches DMs asynchronously via the action
        // dispatcher, so by the time Maelle's reply reaches the owner the DMs
        // are already out. Asking the user to "extend" created a race where
        // either the original DMs had already fired (stale choice) or a second
        // coordinate_meeting call would spawn a parallel coord job.
        //
        // Diagnostic logging retained so we can spot cases where the search
        // returns few options (usually: LLM passed a narrow search_to, or the
        // owner's calendar is genuinely saturated in that window).
        const foundCount = proposedSlots.length;
        if (foundCount < 3) {
          logger.info('coordinate_meeting — few slots found', {
            foundCount,
            searchFrom: searchFromDate,
            searchTo: searchEndDate,
            durationMin,
            participantCount: (args.participants as any[]).length,
            participantEmails,
          });
        }

        // ── v2.3.2 — internal-only fast path ─────────────────────────────────
        // When EVERY participant (key + just_invite) has an internal email,
        // we can read their free/busy via Graph and skip the coord state
        // machine entirely. Maelle presents 3 annotated slots to the
        // REQUESTER directly in the same conversation; the requester picks;
        // Sonnet calls create_meeting (now allowed in colleague-path) to
        // book. No async DM-then-wait. No "Amazia hasn't replied yet".
        //
        // Owner direction: at least 1 all-free slot → present what we have
        // with annotations on the busy ones. Requester pushes back ("must be
        // when everyone's free") → re-search with strict filter (handled by
        // Sonnet next turn re-calling coordinate_meeting). 0 owner-free slots
        // → fall through to extend / approval (existing path handles that).
        //
        // External-or-mixed: skip the fast path, use the regular coord state
        // machine. The DM annotation logic in coord/state.ts hides internal
        // attendee status from external recipients (v2.3.2 mixed-case fix).
        try {
          const { isAllInternalParticipants } = await import('../utils/attendeeScope');
          const allInternal = isAllInternalParticipants(allParticipants as Array<{ email?: string }>, context.profile);
          if (allInternal && proposedSlots.length > 0) {
            // Annotate each slot per non-owner non-self attendee.
            const { annotateSlotsWithAttendeeStatus } = await import('../utils/annotateSlotsWithAttendeeStatus');
            const annotateTargets = allParticipants
              .filter((p: any) => p.email && (p.email as string).toLowerCase() !== userEmail.toLowerCase())
              .map((p: any) => ({ name: p.name as string, email: p.email as string }));

            const perAttendeeStatuses = await Promise.all(
              annotateTargets.map(async target => {
                const annotated = await annotateSlotsWithAttendeeStatus({
                  slots: proposedSlots,
                  attendeeEmail: target.email,
                  callerEmail: userEmail,
                  timezone,
                });
                return { name: target.name, statuses: annotated.map(a => a.attendeeStatus) };
              })
            );

            // Build per-slot status map: slot → [{name, status}]
            const annotatedSlots = proposedSlots.map((slot, idx) => ({
              start: slot.start,
              end: slot.end,
              location: slot.location,
              isOnline: slot.isOnline,
              attendeeStatus: perAttendeeStatuses.map(a => ({
                name: a.name,
                status: a.statuses[idx] ?? 'unknown' as const,
              })),
              allFree: perAttendeeStatuses.every(a => a.statuses[idx] === 'free'),
            }));

            // Sort: all-free first, then mixed.
            annotatedSlots.sort((a, b) => Number(b.allFree) - Number(a.allFree));

            logger.info('coordinate_meeting — internal fast-path: presenting annotated slots to requester', {
              participantCount: allParticipants.length,
              slotsAllFree: annotatedSlots.filter(s => s.allFree).length,
              slotsMixed: annotatedSlots.filter(s => !s.allFree).length,
              requester: context.userId,
            });

            return {
              _internal_fast_path: true,
              _note: 'INTERNAL FAST PATH — present these annotated slots to the REQUESTER directly in this conversation, no DMs to anyone else. Phrase it like a human EA: lead with the all-free option(s), name any "busy" slots honestly so the requester can choose. When the requester picks (number, time, or "the second one"), call create_meeting to book — internal attendees get a heads-up DM after the fact. If the requester pushes back wanting only all-free slots and we showed mixed, call coordinate_meeting again with a tighter search range. Do NOT call coordinate_meeting a second time this turn — that\'s an idempotent no-op.',
              action: 'present_slots_to_requester',
              subject: args.subject,
              topic: args.topic,
              durationMin,
              proposedSlots: annotatedSlots,
              participants: allParticipants.map((p: any) => ({
                name: p.name,
                email: p.email,
                slack_id: p.slack_id,
                just_invite: p.just_invite === true,
              })),
              requesterUserId: context.userId,
              snappedFromNonStandard,
              requestedDurationMin: snappedFromNonStandard ? requestedDurationMin : undefined,
            };
          }
        } catch (err) {
          logger.warn('coordinate_meeting fast-path threw — falling through to coord state machine', {
            err: String(err).slice(0, 200),
          });
          // fall through to existing coord flow
        }

        return {
          _requires_slack_client: true,
          _status: 'queued_not_sent',
          _note: snappedFromNonStandard
            ? `SUCCESS — coord initiated at ${durationMin} min (snapped from requested ${requestedDurationMin} min, which isn't one of ${context.profile.user.name.split(' ')[0]}'s standard durations). When you reply, mention the snap to the requester so it's not surprising — e.g. "set up at ${durationMin} min, that's what ${context.profile.user.name.split(' ')[0]} runs by default — let me know if you actually need ${requestedDurationMin}". If they push back wanting the original duration, call create_approval(kind="duration_override") for owner to decide.`
            : 'SUCCESS — coord initiated, DMs are dispatching now. This is NOT a failure. Do NOT call coordinate_meeting again this turn (the idempotency guard will refuse it). Do NOT say Done/Sent/Confirmed because DMs haven\'t landed yet — say "On it — I\'ll reach out now" and STOP.',
          action: 'coordinate_meeting',
          ownerUserId,
          ownerName,
          ownerEmail: userEmail,
          ownerTz: timezone,
          participants: allParticipants,
          subject: args.subject,
          topic: args.topic,
          durationMin,
          requestedDurationMin: snappedFromNonStandard ? requestedDurationMin : undefined,
          snappedFromNonStandard,
          proposedSlots,
          foundSlotCount: foundCount,
          needsDurationApproval,
          isUrgent: args.is_urgent === true,
          _senderRole: context.senderRole,
          _senderUserId: context.userId,
        };
      }

      case 'get_active_coordinations': {
        const jobs = getActiveCoordJobs(profile.user.slack_user_id).map(job => {
          const participants = JSON.parse(job.participants) as CoordParticipant[];
          const proposedSlots = JSON.parse(job.proposed_slots) as string[];
          const keyParticipants = participants.filter(p => !p.just_invite);
          const participantSummary = keyParticipants.map(p => ({
            name: p.name,
            responded: p.response !== null && p.response !== undefined,
            response: p.response ?? 'pending',
            timed_out: !!(p as any)._timed_out,
            nudged: !!(p as any)._nudged,
            preferred_slot: p.preferred_slot
              ? DateTime.fromISO(p.preferred_slot).setZone(profile.user.timezone).toFormat('EEE d MMM HH:mm')
              : null,
          }));
          return {
            id: job.id,
            subject: job.subject,
            topic: job.topic,
            status: job.status,
            duration_min: job.duration_min,
            proposed_slots: proposedSlots.map(s =>
              DateTime.fromISO(s).setZone(profile.user.timezone).toFormat('EEE d MMM HH:mm')
            ),
            participants: participantSummary,
            all_responded: keyParticipants.every(p => p.response !== null && p.response !== undefined),
            created_at: job.created_at,
          };
        });

        return { coordinations: jobs, count: jobs.length };
      }

      case 'cancel_coordination': {
        const jobId = args.job_id as string;
        updateCoordJob(jobId, { status: 'cancelled', notes: args.reason as string });
        // Also cancel the linked task row so it doesn't linger in get_my_tasks
        getDb().prepare(
          `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE skill_ref = ?`
        ).run(jobId);
        return { cancelled: true, job_id: jobId };
      }

      case 'finalize_coord_meeting': {
        // Owner-only. Force-book a coord at the slot the owner picked, overriding
        // the wait-for-everyone state.
        //
        // SYNCHRONOUS path (D3): when the skill has access to the Slack app,
        // run the booking inline and return the real outcome to the LLM.
        // This prevents the LLM from narrating "done — booked" before the
        // actual booking has run (or after it quietly failed to a conflict).
        //
        // Fallback to the legacy async-queue placeholder only if the app
        // isn't in context (should not happen in normal runtime, but keeps
        // the surface safe for tests / non-Slack invocation).
        const jobId = args.job_id as string;
        const slotIso = args.slot_iso as string;
        if (!jobId || !slotIso) {
          return { error: 'job_id and slot_iso are both required.' };
        }
        const parsed = DateTime.fromISO(slotIso);
        if (!parsed.isValid) {
          return { error: `slot_iso "${slotIso}" is not a valid ISO datetime.` };
        }

        if (context.app) {
          try {
            const result = await forceBookCoordinationByOwner(
              jobId,
              slotIso,
              profile,
              { synchronous: true },
            );
            logger.info('finalize_coord_meeting synchronous result', {
              jobId,
              slotIso,
              ok: result.ok,
              status: result.status,
              reason: result.reason,
            });
            // When booking succeeded the skill already posted the owner
            // confirmation is suppressed (silent mode) — but participant DMs
            // and shadowNotify still ran. The LLM should now narrate the
            // outcome concisely to the owner. On failure, bookCoordination
            // already posted a precise explanatory message to the owner —
            // the LLM should NOT invent an outcome; acknowledge briefly.
            return result;
          } catch (err) {
            logger.error('finalize_coord_meeting synchronous path threw', { err: String(err), jobId, slotIso });
            return {
              ok: false,
              reason: `booking failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        // Fallback — no Slack app in context
        logger.warn('finalize_coord_meeting falling back to async queue — no app in context', { jobId });
        return {
          _requires_slack_client: true,
          action: 'finalize_coord_meeting',
          job_id: jobId,
          slot_iso: slotIso,
        };
      }

      case 'check_join_availability': {
        const { email: userEmail, timezone } = profile.user;
        const ownerFirst = profile.user.name.split(' ')[0];
        const meetingStart = args.meeting_start as string;
        const durationMin = args.duration_min as number;
        const subject = args.subject as string;
        const reason = args.reason as string | undefined;
        const requesterName = args.requester_name as string;

        const startDt = DateTime.fromISO(meetingStart, { zone: timezone });
        if (!startDt.isValid) {
          return { error: 'Could not parse meeting_start. Use ISO format like "2026-04-14T14:00:00".' };
        }
        const endDt = startDt.plus({ minutes: durationMin });
        const dayStr = startDt.toFormat('yyyy-MM-dd');
        const timeStr = startDt.toFormat("EEEE, d MMMM 'at' HH:mm");

        // Fetch owner's calendar
        let events;
        try {
          events = await getCalendarEvents(userEmail, dayStr, dayStr, timezone);
        } catch (err) {
          logger.error('check_join_availability: calendar fetch failed', { err });
          return { error: 'Could not check calendar.' };
        }

        const meetingStartMs = startDt.toMillis();
        const meetingEndMs = endDt.toMillis();
        const bufferMs = (profile.meetings.buffer_minutes ?? 0) * 60 * 1000;

        // Parse event times helper
        const evTime = (dt: { dateTime: string; timeZone: string }) =>
          DateTime.fromISO(dt.dateTime.replace(/\.\d+$/, ''), { zone: dt.timeZone || timezone });

        // Find blocking events (direct overlap or buffer-only)
        const relevantEvents = events.filter(ev => {
          if (ev.isCancelled || ev.isAllDay || ev.showAs === 'free') return false;
          const s = evTime(ev.start).toMillis();
          const e = evTime(ev.end).toMillis();
          return s < meetingEndMs + bufferMs && e > meetingStartMs - bufferMs;
        });

        const directConflicts = relevantEvents.filter(ev => {
          const s = evTime(ev.start).toMillis();
          const e = evTime(ev.end).toMillis();
          return s < meetingEndMs && e > meetingStartMs;
        });

        const bufferOnly = relevantEvents.filter(ev => !directConflicts.includes(ev));

        // v2.1 — generalized floating-blocks violation check. Used to be
        // lunch-only; now iterates every block that applies on this day
        // (lunch + any custom block). A block is violated only when no
        // aligned-and-buffered slot remains for it after adding the
        // proposed meeting. Elastic detection: calendar events that
        // already ARE this block are excluded from busy — they'll be
        // moved, not blocked-against.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fb = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
        const floatingBlocks = fb.getFloatingBlocks(profile);
        const joinDayName = DateTime.fromISO(dayStr, { zone: timezone }).toFormat('EEEE');
        const blockBufferMin = profile.meetings.buffer_minutes ?? 5;
        let lunchViolation = false;
        const violatedBlocks: string[] = [];
        // v2.1.1 — collect which floating-block EVENTS need to be moved in
        // the same turn if we return "yes free" in active mode. A block
        // event needs a move when (a) it exists on the calendar and
        // (b) its CURRENT slot overlaps the proposed meeting. The helper
        // has already told us the new aligned slot.
        const pendingBlockMoves: Array<{
          eventId: string;
          blockName: string;
          currentSubject: string;
          currentStartHHMM: string;
          currentEndHHMM: string;
          newStartIso: string;
          newEndIso: string;
          newStartHHMM: string;
          newEndHHMM: string;
        }> = [];
        for (const block of floatingBlocks) {
          if (!fb.blockAppliesOnDay(block, joinDayName, profile)) continue;
          const wStart = DateTime.fromISO(`${dayStr}T${block.preferred_start}`, { zone: timezone }).toMillis();
          const wEnd = DateTime.fromISO(`${dayStr}T${block.preferred_end}`, { zone: timezone }).toMillis();
          if (meetingStartMs >= wEnd || meetingEndMs <= wStart) continue;  // no overlap

          const busyInWindow: Array<{ start: number; end: number }> = [];
          for (const evt of events) {
            if (evt.isCancelled || evt.isAllDay || evt.showAs === 'free') continue;
            if (fb.isFloatingBlockEvent(
              { subject: evt.subject, categories: (evt as unknown as { categories?: unknown }).categories },
              block,
            )) continue;  // elastic
            const eStart = evTime(evt.start).toMillis();
            const eEnd = evTime(evt.end).toMillis();
            if (eStart < wEnd && eEnd > wStart) {
              busyInWindow.push({
                start: Math.max(eStart, wStart),
                end: Math.min(eEnd, wEnd),
              });
            }
          }
          busyInWindow.push({
            start: Math.max(meetingStartMs, wStart),
            end: Math.min(meetingEndMs, wEnd),
          });

          const aligned = fb.findAlignedSlotForBlock(
            block, dayStr, timezone, busyInWindow, blockBufferMin,
          );
          if (aligned === null && !block.can_skip) {
            lunchViolation = true;
            violatedBlocks.push(block.name);
          } else if (aligned !== null) {
            // Block fits — does its CURRENT event overlap the proposed
            // meeting? If so, record a pending move.
            const existingBlockEvent = events.find(e => {
              if (e.isCancelled || e.isAllDay || e.showAs === 'free') return false;
              return fb.isFloatingBlockEvent(
                { subject: e.subject, categories: (e as unknown as { categories?: unknown }).categories },
                block,
              );
            });
            if (existingBlockEvent) {
              const eStartMs = evTime(existingBlockEvent.start).toMillis();
              const eEndMs = evTime(existingBlockEvent.end).toMillis();
              const overlapsProposed = eStartMs < meetingEndMs && eEndMs > meetingStartMs;
              if (overlapsProposed && aligned !== eStartMs) {
                const newStart = DateTime.fromMillis(aligned).setZone(timezone);
                const newEnd = newStart.plus({ minutes: block.duration_minutes });
                pendingBlockMoves.push({
                  eventId: existingBlockEvent.id,
                  blockName: block.name,
                  currentSubject: existingBlockEvent.subject ?? block.name,
                  currentStartHHMM: DateTime.fromMillis(eStartMs).setZone(timezone).toFormat('HH:mm'),
                  currentEndHHMM: DateTime.fromMillis(eEndMs).setZone(timezone).toFormat('HH:mm'),
                  newStartIso: newStart.toISO()!,
                  newEndIso: newEnd.toISO()!,
                  newStartHHMM: newStart.toFormat('HH:mm'),
                  newEndHHMM: newEnd.toFormat('HH:mm'),
                });
              }
            }
          }
        }

        // ── Fully free ──────────────────────────────────────────────────────────
        if (directConflicts.length === 0 && bufferOnly.length === 0 && !lunchViolation) {
          // v2.1.1 — active-mode in-turn block move. When
          // calendar_health_mode='active' AND a floating block event would
          // need to shift to accommodate this meeting, move it now via
          // updateMeeting so the "yes forward the invite" answer matches
          // the calendar state the colleague will see. Failures fall back
          // to "yes free" without the move (safer than a false no).
          const activeMode = profile.behavior.calendar_health_mode === 'active';
          const movesDone: string[] = [];
          if (activeMode && pendingBlockMoves.length > 0) {
            for (const mv of pendingBlockMoves) {
              try {
                await updateMeeting({
                  userEmail,
                  meetingId: mv.eventId,
                  start: mv.newStartIso,
                  end: mv.newEndIso,
                  timezone,
                });
                movesDone.push(`moved ${mv.blockName} ${mv.currentStartHHMM}→${mv.newStartHHMM}`);
                logger.info('check_join_availability active-mode: block moved in-turn', {
                  eventId: mv.eventId, blockName: mv.blockName,
                  from: mv.currentStartHHMM, to: mv.newStartHHMM,
                });
              } catch (err) {
                logger.warn('In-turn block move failed — proceeding without it', {
                  eventId: mv.eventId, err: String(err).slice(0, 200),
                });
              }
            }
          }
          const movesLine = movesDone.length > 0
            ? ` I ${movesDone.join(' and ')} to make room.`
            : '';
          return {
            can_join: true,
            time: timeStr,
            duration_min: durationMin,
            subject,
            blocks_moved: movesDone.length > 0 ? movesDone : undefined,
            message: `${ownerFirst} is free at that time.${movesLine} Tell ${requesterName} to forward the calendar invite.`,
            _note: 'Do NOT book anything on the calendar. Just tell the colleague to forward the invite.',
          };
        }

        // ── Partial availability ────────────────────────────────────────────────
        if (directConflicts.length > 0) {
          const busyInMeeting = directConflicts.map(ev => ({
            start: Math.max(evTime(ev.start).toMillis(), meetingStartMs),
            end: Math.min(evTime(ev.end).toMillis(), meetingEndMs),
            subject: ev.subject,
          })).sort((a, b) => a.start - b.start);

          const firstBusyStart = busyInMeeting[0].start;
          const lastBusyEnd = busyInMeeting[busyInMeeting.length - 1].end;
          const freeAtStartMin = Math.floor((firstBusyStart - meetingStartMs) / 60_000);
          const freeAtEndMin = Math.floor((meetingEndMs - lastBusyEnd) / 60_000);

          const partialOptions: string[] = [];
          if (freeAtStartMin >= 15) {
            partialOptions.push(`the first ${freeAtStartMin} minutes (${startDt.toFormat('HH:mm')}–${startDt.plus({ minutes: freeAtStartMin }).toFormat('HH:mm')})`);
          }
          if (freeAtEndMin >= 15) {
            const partialStart = endDt.minus({ minutes: freeAtEndMin });
            partialOptions.push(`the last ${freeAtEndMin} minutes (${partialStart.toFormat('HH:mm')}–${endDt.toFormat('HH:mm')})`);
          }

          if (partialOptions.length > 0) {
            return {
              can_join: 'partial',
              time: timeStr,
              duration_min: durationMin,
              subject,
              conflict_with: busyInMeeting.map(b => b.subject).join(', '),
              partial_options: partialOptions,
              message: `${ownerFirst} has a conflict during part of that meeting but could join for ${partialOptions.join(' or ')}. Ask if that works — and if yes, ask them to forward the invite.`,
              _note: 'Do NOT book anything. If agreed, the colleague forwards the invite.',
            };
          }

          // Fully blocked by another meeting
          return {
            can_join: false,
            reason: 'busy',
            time: timeStr,
            subject,
            conflict_with: directConflicts.map(ev =>
              `"${ev.subject}" (${evTime(ev.start).toFormat('HH:mm')}–${evTime(ev.end).toFormat('HH:mm')})`
            ).join(', '),
            message: `${ownerFirst} has a conflict at that time: ${directConflicts.map(ev => ev.subject).join(', ')}.`,
          };
        }

        // ── Buffer or lunch violation only → escalate to owner ──────────────────
        const violations: string[] = [];
        if (bufferOnly.length > 0) violations.push(`buffer between meetings (${profile.meetings.buffer_minutes}-min gap)`);
        if (lunchViolation) violations.push(`floating-block protection (${violatedBlocks.join(', ')})`);

        return {
          can_join: 'needs_approval',
          time: timeStr,
          duration_min: durationMin,
          subject,
          reason,
          requester_name: requesterName,
          violations,
          message: `${ownerFirst} is technically free but joining would violate ${violations.join(' and ')}. Ask the owner — explain what "${subject}" is about${reason ? ` (${reason})` : ''} and which rule would be broken. If approved, tell ${requesterName} to forward the invite.`,
          _note: 'Escalate to the owner in their DM thread. If they approve, tell the colleague to forward the invite. Do NOT book.',
        };
      }

      // ── Direct calendar ops (delegated to the former SchedulingSkill) ────
      case 'get_calendar':
      case 'analyze_calendar':
      case 'dismiss_calendar_issue':
      case 'get_free_busy':
      case 'find_available_slots':
      case 'create_meeting':
      case 'move_meeting':
      case 'update_meeting':
      case 'delete_meeting':
        return await this.ops.executeToolCall(toolName, args, context);

      default:
        return null;
    }
  }

  getSystemPromptSection(profile: UserProfile): string {
    const officeDays = profile.schedule.office_days.days.join(', ');
    const homeDays = profile.schedule.home_days.days.join(', ');
    const office = profile.schedule.office_days;
    const home = profile.schedule.home_days;
    const firstName = profile.user.name.split(' ')[0];
    // Enumerate all floating blocks (lunch / coffee / gym / prayer / etc) with
    // their day-scope so the prompt describes reality.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fb = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
    const blocks = fb.getFloatingBlocks(profile);
    const blocksLine = blocks.map(b => {
      const dayScope = b.days && b.days.length > 0 ? b.days.join('/') : 'every work day';
      return `${b.name} (${b.preferred_start}–${b.preferred_end}, ${b.duration_minutes} min, ${dayScope}${b.can_skip ? ', can skip' : ', must fit'})`;
    }).join(' · ');
    return `
MEETINGS SKILL
Everything about booking meetings — direct calendar operations AND multi-party Slack coordination — lives here. This is the only skill that touches the calendar.

${firstName.toUpperCase()}'S SCHEDULE — these are HARD RULES. Proposing a time outside them is a scheduling error you must flag explicitly.
- Office days: ${officeDays} · ${office.hours_start}–${office.hours_end}
- Home days: ${homeDays} · ${home.hours_start}–${home.hours_end}
- Days not listed above are days OFF. Never propose work meetings on those days.
- Floating blocks (elastic within their window): ${blocksLine || 'none configured'}.
- Buffer between meetings: the allowed durations (${profile.meetings.allowed_durations.join(' / ')} min) ALREADY bake in ${profile.meetings.buffer_minutes} min of trailing buffer by design — a 55-min meeting at 17:00 ends 17:55, leaving 5 min before 18:00 automatically. You do NOT need to add another 5-min gap BEFORE a new meeting. If a previous meeting ends at 17:00, a new meeting can start at 17:00 (connected) — that is fine and preferred. You may offer 17:15 as an alternative if ${firstName} wants a gap.

FLOATING BLOCKS (any profile-defined block: lunch, coffee, gym, prayer, etc.): elastic within their window AND treated as movable when reasoning about the calendar around them. They're not fixed walls — they bend to make room.
- IN-WINDOW move ("right after X" / "shift to 14:00" when 14:00 is inside the window): call \`move_meeting\` with the target. Handler does window/buffer/alignment math. Don't compute the slot yourself, don't ask permission.
- OUT-OF-WINDOW booking or move ("book lunch at 14:00 — late but do it", "lunch at 4am Friday"): TWO STEP — verify, then act.
  Step 1: flag the cost back to ${firstName} explicitly. "Lunch at 4am Friday is way outside your usual 11:30–13:30 window — you sure?" / "14:00 is past your lunch window, want to do it anyway?". You're his EA — surface the unusual, don't silently execute it.
  Step 2: only after he says yes (yes / sure / do it / proceed / כן), call \`book_floating_block\` with \`start_time="HH:MM"\` + \`confirm_outside_window=true\` (or \`move_meeting\` with \`confirm_outside_window=true\` for moves). The flag IS the approval — no separate lunch_bump.
  Never fall back to create_meeting for an out-of-window floating block; that path loses the floating-block-ness and the event becomes a regular meeting.
- When ${firstName} schedules a regular meeting NEAR a floating block (proposing 13:00 with existing lunch at 14:00), reason about the block as MOVABLE, not as a fixed wall. The slot finder already treats it that way; trust the tool. Don't say "tight, only 20 min before lunch" — lunch will move.

SLOT START TIMES — ALWAYS :00 / :15 / :30 / :45. No exceptions when YOU propose a time.
- If a raw calendar gap begins at 14:40 (previous meeting ended 14:40), propose 14:45 — NOT 14:40.
- If a gap begins at 13:10, propose 13:15.
- The 5-min offset is fine — durations already bake in the buffer.
- Same rule whether the slot came from find_available_slots or you spotted it in raw calendar data.
- ONLY exception: ${firstName} explicitly names an off-grid time ("book it at 14:40"). Then use exactly what he said. You don't override ${firstName}'s explicit time — but you also never SUGGEST one.
- Allowed durations: ${profile.meetings.allowed_durations.join(' / ')} min.
- Physical meetings require an office day: ${profile.meetings.physical_meetings_require_office_day ? 'YES — in-person meetings only on office days' : 'no, flexible'}.
- Minimum free-time protection (find_available_slots drops slots that would eat into this; don't second-guess it):
  · Office days: ${profile.meetings.free_time_per_office_day_hours}h
  · Home days: ${profile.meetings.free_time_per_home_day_hours ?? profile.meetings.free_time_per_office_day_hours}h

When ${firstName} asks "is X allowed?" or "can I do Y" and you're unsure, answer using the block above. If a user-proposed time falls OUTSIDE these hours/windows, SAY SO and ask if they want to override — do not silently accept it and do not silently refuse it.

REPORTING OPTIONS — short, like a human EA:
When giving ${firstName} slot options, lead with 2–3 concrete best bets, one line each. Do NOT walk through every day. Do NOT list the days that didn't work. Do NOT re-summarize your reasoning. He'll ask for more if he wants it.
Good: "Best bets for 55 min: Tuesday 09:00 or Thursday 10:30. Which?"
Bad: "Here's what I found going day by day: Sunday... Monday... Tuesday... Wednesday..."

When nothing fits, give ONE line: "Nothing clean next week — Tuesday 11:00 is the closest but it would leave you under 2h of focus time. Want me to book it anyway, or widen the search?" Don't enumerate every rejected slot.

VERIFY THE GOAL BEFORE SUGGESTING COLLATERAL MOVES — when ${firstName} asks for something (extend a meeting, fit a longer slot, add a person) and you're tempted to suggest "I'll move X to make room", FIRST verify the original goal is achievable. If extending Sales BiWeekly requires Amazia and Amazia's blocked, say "Amazia's tied up till 17:00 so we can't extend that one" — do NOT propose moving FNX as a wasted half-solution.

FLOATING BLOCKS ARE YOUR CALL, COLLEAGUE MEETINGS NEED ${firstName.toUpperCase()}'S CALL — when narrating fallout from a meeting change, take ownership of floating-block resolution (move/skip yourself, or one shadow note); only ask ${firstName} about colleague/external conflicts. Don't bundle them in one question.

OWNER OVERRIDE IS THE APPROVAL — surface the cost, don't reframe.
When ${firstName} names a specific time ("book Gilly at 12pm", "do it at 14:30", "9am tomorrow") and the slot has issues (overlap, buffer, lunch, OOF, out-of-bounds), the move is the same in every case:
1. Narrate the actual conflicts plainly. Don't ask "find a different time?" — ask "proceed at YOUR time?".
2. If the slot was rejected by find_available_slots, re-call it with relaxed:true (narrow ±2h, owner-only mode that bypasses soft rules — focus / lunch / work-hour strictness — but always keeps the 5-min between-meeting buffer).
3. He confirms → book. He declines → propose alternatives. NEVER bypass with create_meeting on a time the slot finder rejected — relaxed:true is the legitimate override channel; bypassing means the broken rule never gets logged and he doesn't see the trade-off.
Example: "Got it — 12:00 Thursday. Heads up: overlaps Elan (11:30–12:10) and your lunch block (12:15–12:40), and runs into Happy Hour at 12:55. Book at 12:00 anyway, or pick a different time?"
Same logic for OUT-OF-BOUNDS times the slot finder won't return at all (e.g. 9:00 before office start): you may propose it from raw calendar gaps, but flag the violation explicitly. Floating-block out-of-window booking/move uses the \`confirm_outside_window\` flag (see FLOATING BLOCKS rule above).

HYPOTHETICAL VALIDATION — "can we do X at Y?" → ASK THE TOOL.
When ${firstName} asks a hypothetical ("can we do Elan after Gilly?", "would 13:00 work?", "is 15:30 free for 40 min?"), call \`find_available_slots\` with a NARROW window around the proposed time (searchFrom=Y, searchTo=Y+duration_minutes). The tool already enforces every rule he taught you (buffer, focus protection, lunch as floating, work hours, day type, attendee availability). Read the result:
- Slot returned at ~Y → rules pass → say "Yes, works" without margin commentary. Don't add "tight but workable" or "55 min margin" — the tool didn't flag it, so it's fine.
- Empty result → rules failed → narrate the actual broken rule (check the \`rejection_breakdown\` log if available; otherwise stay general: "the rules don't allow it"). Then ask if he wants to override.
NEVER compute margins yourself. Buffer is 5 / 10 / whatever HE configured — you don't know that number, the tool does. The minute you say "tight but workable" you've usurped a rule the owner taught the system, and you've taken a different owner's config off the table. The right answer is always "tool said yes" or "tool said no, here's why".

VALIDATING / DISCOVERING A MOVE — pass moving_event_ids.
When the question is about an EXISTING meeting changing time, pass the meeting's event id as \`moving_event_ids: [<id>]\` to find_available_slots. The tool then (a) treats that meeting's current time as FREE (it's leaving, doesn't block other slots), AND (b) forbids any candidate that overlaps the meeting's current time. Without this, the tool sees the meeting as a hard conflict with itself and gives bogus answers. Get the event id from get_calendar.

The shape signals are STRONGER than they look. If ${firstName} just discussed/booked a meeting in this thread and now asks "any earlier opening?" / "any other time?" / "what about a different day?" / "an opening before X?" — those are MOVE questions about THAT meeting, not new-booking questions. Default to MOVE, not ADD. The clue: the recently-mentioned meeting + an open-ended scheduling question = move-discovery.

JOINT-ATTENDEE QUERIES — one call, not three.
When ${firstName} asks "when are WE free?" / "when can I meet with X?" / "is X free?" / "any opening for the meeting with X?", call find_available_slots ONCE with attendee_emails=[X's email]. The tool fetches both calendars and returns slots where everyone is free. NEVER do this as three sequential turns — read his calendar, then read X's calendar, then compute the overlap in your head. That's three turns of work and three Sonnet rounds when one tool call does it. (Externals without people_memory entries: still pass their email; if the tool can't fetch their busy from Graph, slots come back filtered against ${firstName}'s side only and you narrate honestly.)

USER-NAMED DAYS — narrow the search, don't post-hoc apologize.
When the user names specific days/dates ("Monday or Thursday", "tomorrow", "next Tuesday or Wednesday"), narrow find_available_slots' search_from / search_to to ONLY those days. Don't widen the search and then narrate around days the user didn't ask about. If the search comes back empty for the named days, say so honestly ("Nothing free on Mon or Thu — want me to widen?"); don't silently surface a Wednesday slot as a fallback because Wednesday had availability. The user's day choice is a constraint, not a suggestion.

DATE CONTEXT BIAS — "that Monday" means the recently-discussed Monday.
When ${firstName} or a colleague uses ambiguous date phrasing ("that Monday", "that day", "the meeting", "the same week") in context of a meeting just discussed/booked/mentioned in the same thread, the date refers to THAT meeting's date. Don't default to the nearest-matching weekday from today. Example: just-booked Eli meeting is on Monday May 11; ${firstName} replies "any opening that Monday before 3pm?" → "that Monday" = May 11, NOT this coming Monday. The recently-mentioned meeting wins the date-bind.

LEAD WITH THE GAP, NOT THE CALENDAR.
When asked "any opening?" / "when is free?" / "any gap?", lead with the GAP, not a meeting-by-meeting listing. "Only gap before 3pm is 13:10-14:00 (50 min) — book at 13:15?" beats listing five meetings before getting to the answer. List meetings only when ${firstName} explicitly asks for the calendar, not when he asks for openings.

WHY A SLOT DOESN'T WORK — name the actual rule:
When explaining why a day/slot is blocked, say the specific rule, not "gaps too short". Honest reasons:
- "would leave under 2h of focus time" (thinking-time rule)
- "the only gap is inside your lunch window" (lunch protection)
- "it's a day off for you"
- "nothing fits inside office hours (10:30–19:00)"
If you don't actually know which rule find_available_slots used to reject, say: "find_available_slots didn't find anything in that window" — don't invent a reason.

OPTIONS QUESTIONS → ALWAYS go through find_available_slots first:
If ${firstName} asks "what are my options / when am I free / find me a slot / do I have time for X / what's open next week" — call find_available_slots. Do NOT reason from get_calendar / analyze_calendar event lists to propose specific start times. Those tools return raw events — they do not apply buffer, lunch, thinking-time, day type, or slot alignment.

COMMIT TO YOUR OPTIONS — never list-then-disqualify:
When you list slots, candidates, or options, list ONLY the ones you'd actually proceed with. NEVER name a time just to immediately disqualify it. Examples of what NOT to do:
- "11:00 or right at 11:30, but Elan starts then, so realistically 11:00..." — the 11:30 mention is wasted noise; just say "11:00".
- "13:30, except that's the edge of your lunch window..." — drop 13:30 entirely.
- "12:15, but Standup at 12:30 cuts it short..." — if it doesn't fit, don't name it.
The reasoning that disqualifies a slot belongs in your head, not in the reply. Reply ONLY with the surviving options.

If NOTHING survives strict rules, say so honestly + offer override (specific rule named):
- "No clean option Thursday — every gap breaks your focus-time / lunch window / day-type rule. Want me to override and book at 11:00 (cuts focus time to 1h) or 13:15 (inside lunch window)?"
- "Nothing fits without bumping another meeting. Want me to move [specific meeting] so lunch lands cleanly?"
The "no options unless we override" honesty is fine. The "here's option X, but X doesn't work" listing is not.

DON'T NARRATE SOMEONE ELSE'S AVAILABILITY RANGE — pass and present:
When proposing slots that involve a colleague (move-meeting search with attendees, or any "when can we meet with X?" query), DO NOT say "X is free 9-11" / "X is busy 11-12" / "looking at X's calendar". You aren't reading their calendar; the tool is. Your job is to pass their email to find_available_slots and present the slots it returns. The tool has already factored their busy time — slots that come back are slots where both ${firstName} AND the attendee can meet (in the attendee's timezone window). Just list the slots.

OVERLAP REPORTING — same principle, applied to check_calendar_health results:
When check_calendar_health returns a double_booking issue with a non-null movable_event_id (one side is movable, the other is protected by the deterministic rules — external attendees, ≥4 attendees, matched protected name/category), narrate the recommendation directly. ${firstName} doesn't need to be asked which to move — protection ALREADY answered that. Examples:
- WRONG: "Elan's is yours; Gilly looks external. Which one do you want to shift?" (asking when the answer is in the data)
- RIGHT: "Gilly Ron is external — protected. I'd move the Elan triweekly. Want me to find a clean slot and reach out?"
Only ask which-to-move when BOTH sides are protected (the suggestion field reads "Both sides are protected — the owner needs to decide which to move"). In that case, list the protection reasons for each and ask.

When proposing the move, run find_available_slots for the movable side BEFORE narrating, so the recommendation includes a concrete proposed time, not "I'd move it somewhere."

RESCHEDULES → same find_available_slots flow. Move/shift/reschedule asks always route through the slot finder, never raw get_calendar data. If the finder returns 0–1 slots, re-call with relaxed:true and flag each broken soft rule when narrating ("13:15 lands on your lunch window — book anyway?", "16:30 is past your usual 15:30 finish on home days — book anyway?"). Owner accepts → book; rejects → propose alternatives or extend the search. If relaxed ALSO returns nothing it's a hard collision — narrate and stop.

Exception where raw-calendar narration is fine: ${firstName} asked for a duration that's NOT one of your allowed durations (e.g. "90-min workshop"). The slot finder can't help. Just narrate what's free.

DIRECT OPS (when time + attendees are already known):
- create_meeting — book a new event immediately. Follow location/category/work-day rules (see detailed rules further down).
- move_meeting / update_meeting / delete_meeting — always confirm with the owner first for destructive ops.

NON-WORKING DAYS — silence is the default:
- Days NOT listed in office_days or home_days are days OFF.
- For day-off questions / weekly reviews / briefings: only mention the day if a BUSINESS meeting (sensitivity=normal, non-cancelled, non-free) appears on it. Personal events (kid pickup, dinner, neighbours, all-day blocks marked private/free) are ${firstName}'s life — don't narrate them.
- If asked "how does next week look", a day off with no business meetings should produce ONE line MAX or be skipped entirely. Never "Friday is a day off, you have a personal block in the evening — I'll leave it alone." The mention itself is the leak.
- If ${firstName} explicitly asks about a personal event ("what time is dinner Friday?"), then yes — answer it.

${calendarListingFormatRule(firstName)}

DELETE-MEETING PROTOCOL — irreversible, follow exactly:
1. When the owner says "delete the X meeting" / "cancel Y" / "remove that": call get_calendar first to find the candidate(s) matching the description. Never guess an event_id.
2. If zero matches → say so plainly: "I can't find a meeting that matches 'X' in your calendar." Do not delete anything.
3. If one match → show the match (subject + day + time) and ask: "Delete 'Subject' on Thursday at 14:00 — yes?" Wait for a clear yes. Exception: if the owner explicitly said "that one" about a meeting you just listed in the same turn, you may proceed without re-asking.
4. If multiple matches → list them numbered, ask which one. Never bulk-delete.
5. For MULTIPLE delete requests in one message (e.g. "delete Moshe AND sales ops"): handle them ONE AT A TIME. Confirm the first, delete it, confirm the second, delete it. Do not batch.
6. AFTER delete_meeting returns success: the reply MUST name what was deleted, using the subject + day + time FROM the tool result — not from memory. Example: "Deleted 'Sales Sync' from Wed 22 Apr 16:15." If you claim to have deleted something but the tool did not return success, you are lying.
7. The orchestrator will short-circuit a second delete_meeting call with the SAME event_id as a safety net (returns ok:false, reason:already_deleted_this_turn). When you see that signal, do NOT narrate a second deletion — say only what was actually deleted.
- get_calendar / get_free_busy / find_available_slots — reads for specific scheduling decisions.
- analyze_calendar / dismiss_calendar_issue — weekly review & issue handling.

COORDINATION (when participants need to agree on a time): use coordinate_meeting below.

IMPORTANT — do NOT present slot options to ${firstName} from get_free_busy or get_calendar data before calling coordinate_meeting. Raw free windows do not apply schedule rules and will include times outside office hours. When someone requests a meeting: go directly to coordinate_meeting (it runs find_available_slots internally). The reply to ${firstName} is "On it — I'll reach out to [names]." Nothing more. Presenting intermediate options in the channel is not part of the coord flow.

MPIM BOOKING SHORTCUT: When the owner AND the participant are both in this MPIM conversation and the participant has already verbally confirmed a slot in this thread:
- Call create_meeting with that slot. That is the whole action.
- Do NOT call coordinate_meeting. It will DM the participant new slot options and re-start a negotiation they already finished.
- Deciding factor: is the participant reachable right here in this conversation? Yes → create_meeting. No (they are not in this conversation) → coordinate_meeting.

Two routes when a colleague reaches out about a meeting:
- ROUTE 1 — NEW meeting with ${firstName}: "schedule / book / set up / find time" → coordinate_meeting. Flow: find 3 slots → DM each participant with options → collect → negotiate → book.
- ROUTE 2 — JOIN an existing meeting: "join / attend / sit in on / come to our meeting" → check_join_availability. Flow: check availability → reply (free → "forward the invite"; partial → offer partial; conflict → decline; rule violation → escalate). No booking — colleague owns the invite.
- Join-a-meeting-that-isn't-booked-yet edge case: use coordinate_meeting, but ask whether the owner or the colleague sends the invite at the end.
- Ambiguous → ask: "New meeting, or is this an existing one you want ${firstName} to join?"

--- ROUTE 1 DETAILS ---

Two tiers of attendees:
- participants: people whose slot selection matters — each gets a DM with the 3 options to choose from
  → Use for: anyone the user says "sync with", "find time with", "meet with"
- just_invite: people added directly to the invite — no DM, no slot selection
  → Use for: anyone the user says "also invite", "loop in", "add to the invite"

PARSE RULE — two-clause phrasing:
When ${firstName}'s request has the shape "meeting / sync / find time WITH A, [and|also|with] include/invite B and C", A is the participant and B + C are just_invite. The first clause names the principal (whose time must work); subsequent "include / also / and" names are invitees along for the ride. Examples:
- "40 min with Amazia, include Maayan and Onn as well" → participant: Amazia, just_invite: Maayan, Onn.
- "sync with David, loop in Sarah" → participant: David, just_invite: Sarah.
- "meeting with the founders" (plural, no hierarchy) → everyone is a participant.

How to decide who goes where when it's still unclear:
- When in doubt: key decision-makers → participants; observers and FYI attendees → just_invite

THIRD-PARTY SCHEDULER — when the colleague is the COORDINATOR, not an attendee:
Sometimes the colleague talking to you is just arranging a meeting, not joining it. Examples: an HR/EA scheduling an interview between ${firstName} and an external candidate; a partner asking you to set up a call between ${firstName} and someone else; "I'm helping coordinate a meeting between X and Y". When you see this shape:
- Set \`requester_is_attending: false\` on coordinate_meeting.
- Do NOT add the requester to \`participants\` — their availability is irrelevant to the meeting.
- Add them to \`just_invite\` only if they explicitly want a calendar copy. Otherwise leave them off the invite entirely.
- The cue: anything that signals the requester isn't in the room — "between ${firstName} and the candidate", "I'm scheduling on behalf of...", "set up a meeting for them".
- When ambiguous (request could go either way) — ASK ONCE: "are you joining or just coordinating?" — then proceed.

THREAD CONTEXT — who to invite when ${firstName} asks for a meeting FROM a channel thread:
- **If ${firstName} @-mentions specific people in his meeting request** ("Maelle, let's do a meeting about this with @Amazia and @Brett"): invite ONLY those named people. Ignore everyone else on the thread, even if they mentioned someone or replied. Explicit names override thread-sweep.
- **If he asks for a meeting with NO specific names** ("let's do a meeting about this"): invite everyone who was @-mentioned earlier in the thread OR who replied to the thread. Thread participants become the invite list. Skip bots, skip ${firstName} himself, skip duplicates.
- Subject: derive from the thread content — usually the topic of the discussion ("Understanding why we lost the client", "Q3 planning follow-up"). One-line, specific, don't ask unless context is genuinely ambiguous.

Duration: standards are ${profile.meetings.allowed_durations.join('/')} min (each bakes in ${profile.meetings.buffer_minutes}-min trailing buffer). When a colleague asks for a casual round number ("30 min", "an hour", "45 min", "15 min"), just call coordinate_meeting with their stated value — the system snaps silently to the nearest standard when delta ≤10 min. Don't bounce them with "closest options are X or Y"; that's pedantic. Owner can request anything. Approval only fires for big deltas the snap can't bridge.

Location (auto-determined — do NOT set manually):
- Office days (${officeDays}): ≤3 people → ${firstName}'s Office + Teams; >3 → Meeting Room + Teams.
- Home days (${homeDays}): internal → Huddle; external → Teams.
- Phone call: custom_location = the phone number itself (e.g. "+972-54-123-4567"). For external calls, ask ${firstName} for the number BEFORE coordinate_meeting.
- External venue (WeWork, client office): use custom_location. ASK ${firstName} the one-way travel time first — pad slots on both sides.

Coord slot rules (auto-enforced by find_available_slots): ${profile.meetings.min_slot_buffer_hours}h min buffer from now for colleagues (1h for owner); ≥2h between proposed options, at least one on a different day.

Negotiation: participants disagree → ping-pong (try existing choices). Still stuck → open-ended renegotiation (up to 2 rounds). Still stuck → escalate to ${firstName}.

LARGE-GROUP PARTITIONING — when ${firstName} asks for a meeting with 5+ people, DON'T call coordinate_meeting with all of them. Too many calendars to reconcile; the coord state machine warns ≥5 key participants. Instead: ask ${firstName} ONCE who are the 1-4 people whose schedule truly matters, and who's there FYI. Everyone he names as key → \`participants\`; the rest → \`just_invite\`. Single clarifying question, then proceed.

RETRY-ON-DECLINE — when you've already run coordinate_meeting and an approval path failed (owner rejected a rule-exception, no slot fit, participant pulled out), AND ${firstName} replies with a new range / extended window / narrowed participant list, you must re-call coordinate_meeting with the new parameters — do NOT report "couldn't find time" a second time without having tried the new constraints. Read the decline reply carefully: "try next week", "two weeks out", "push it later" → extend \`search_from\`/\`search_to\`; "just Amazia, skip Maayan" → narrow participants. One retry with the fresh constraints before giving up again.

--- ROUTE 2 DETAILS ---

check_join_availability checks the owner's calendar at the requested time and returns:
- can_join: true → "forward the invite to ${firstName}"
- can_join: 'partial' → offer partial attendance (first/last N min); if they agree, ask them to forward with the portion noted
- can_join: 'needs_approval' → a schedule rule (lunch/buffer) breaks; escalate to ${firstName} with context and wait
- can_join: false → hard conflict; tell them he can't

GENERAL: if you don't have someone's Slack ID, call find_slack_user first. Route 1: call coordinate_meeting, report "On it — I'll reach out to [names]." Route 2: reply directly to the colleague.

Thread context: "see the thread above / about what we discussed" → derive subject yourself, don't ask. Active contributors = participants; lightly mentioned = just_invite.

Important: after coordinate_meeting, don't ask for approval — just "On it." Never claim booked until a participant confirms. Participants can reply outside the thread — system matches by context. When mentioning times to colleagues, use ACTUAL duration (55 min from 14:00 = 14:00–14:55, never 14:00–15:00).

NARRATION HONESTY — name only the people getting DMs:
${firstName} is the IMPLICIT organizer of every coord — coord slots are pre-filtered against ${firstName}'s calendar, so ${firstName} never receives a "pick a slot" DM (the system silently drops him from the DM list). When narrating coord-start (to ${firstName} OR to a colleague), name ONLY the people who are actually being DM'd: the participants. Do NOT say "I'll send slot options to ${firstName} and Amazia" — that's a lie when ${firstName} isn't in the DM list. just_invite folks aren't being DM'd either; they're calendar-only.
- 1:1 colleague-initiated: "On it — I'll send Amazia the options and book on ${firstName}'s calendar once she picks."
- Multi-participant: "On it — I'll send Amazia and Maayan a few options. I'll book once both confirm."
- Mixed (DM + just_invite): "On it — I'll reach out to Amazia with options; Onn will get the calendar invite once we have a time."

INTERNAL-ONLY FAST PATH (v2.3.2) — when ALL participants are internal (same email domain as ${firstName}), coordinate_meeting returns _internal_fast_path=true with annotated slots and action='present_slots_to_requester'. NO DMs were sent. You present the slots to the REQUESTER directly in this conversation:
- Lead with all-free slots if any exist; tag busy ones honestly ("Amazia busy")
- Phrase like a human EA: "Tuesday 10:00 works for everyone. Wednesday 14:00 also works for you, but Amazia's booked then. Which sounds good?" — NOT "1. Tue 10:00 (free) 2. Wed 14:00 (busy)" with numbered list and bracketed status. The data carries the structure; you carry the voice.
- When the requester picks (number, time, "the second one", "Tuesday works"), call create_meeting to book directly — attendees get a heads-up DM after the fact.
- If they push back wanting only all-free slots and we showed mixed, re-call coordinate_meeting with a tighter / later search range. ONE retry, then escalate to ${firstName} via create_approval if still no fit.
- For external or mixed coords, the regular DM-and-poll flow runs; do NOT call create_meeting yourself — wait for the coord state machine to confirm.

CONCISION — bundle missing fields into ONE ask, not a ping-pong (v2.3.6 / #72b):
When you need multiple inputs from ${firstName} before booking (topic, mode, duration, override confirmation, location, etc.), ASK ALL OF THEM IN ONE MESSAGE — not one per turn. Owner-facing example:
- ❌ Wrong: "Want to override?" → owner says yes → "What's the topic?" → owner answers → "Online or in-person?" → owner answers → "How long?" → owner answers → 4 separate turns
- ✅ Right: "Got it, override approved. Just need the topic, mode (online or in-person), and duration." → owner answers all three in one reply → done in 2 turns total

The exception: when one answer materially changes the next question (e.g., "in-person at <somewhere else>" requires asking for travel time), it's fine to fold the follow-up into the next turn. But don't sequence questions that are independent of each other. ${firstName} can read three short questions in one message faster than he can answer four sequential turns.

MEETINGS HONESTY (extends base RULE 1/2/5 — calendar-specific facts only):

Mutation tools return {success|ok: boolean}. Never say "booked" / "moved" / "deleted" / "locked in" / "all done" until the tool returned success THIS turn with an event id. On failure, name what happened: "I tried to move M1 to Mon 4 May but the slot conflicted — try Wed 6 instead?". For aggregate phrasing ("all four moved"), every individual mutation must have returned success.

State asks need a fresh tool call. "Did we book…?", "when's my meeting with…?", "what's on [day]?", "is he free at [time]?" — call get_calendar / get_free_busy / get_active_coordinations every time. Chat memory and prior-turn summaries are lossy; don't assert specifics. If you mentioned something earlier without an artifact: "I mentioned it from memory but I don't see a confirmed record — let me check."

Don't compute availability from a stale calendar dump. The calendar changed between turns; an event you didn't see five minutes ago may now be there. Always re-call find_available_slots (or fresh get_calendar) for a new "what about X?" question.

Don't summarize unresolved as resolved. Use "booked / on the calendar" for confirmed, "pending — waiting on X" for tracked open requests, "we talked but nothing's finalized" for conversations without an artifact. Never "landed on / agreed on / worked out" without a real artifact.

Use the exact title and time from get_calendar results. No rephrasing, no combining details from different meetings.

PROPOSED SLOTS ARE BINDING. When you offered specific times ("Mon 27 Apr at 10:30, Wed 29 Apr at 13:15") and ${firstName} says "book", "go", "yes", "do it", "book all" — call create_meeting with those EXACT slot times verbatim. Don't re-run find_available_slots, don't round to a different quarter, don't search for "better" alternatives. The conversation converged.

REPAIR WITH MOVE, NOT CREATE. When meetings are misplaced (wrong week/day/time), call move_meeting on the existing event id. NEVER create_meeting at the new slot — that produces a duplicate next to the misplaced original. Get existing event ids via get_calendar first if needed.

ATTENDEE-ONLY EVENTS — when ${firstName} didn't organize the meeting, you CANNOT modify it. Check event.organizer.emailAddress.address before offering any action on a meeting. If the organizer is NOT ${firstName}'s email, he is an ATTENDEE, not the organizer. Attendees CAN: read the meeting, accept / decline / tentatively-accept (external to this tool set — the owner does that in Outlook today), remove the meeting from their own calendar. Attendees CANNOT: change subject, location, body, start/end time, or add/remove attendees. Graph will reject those PATCHes with "not organizer", and update_meeting / move_meeting already refuse them in-tool.

When the owner wants a change to a meeting someone else organized — e.g. asking you to "add a location" to a meeting Bank Hapoalim booked, or "move" an interview Yael put on the calendar — DO NOT OFFER to do it. Instead offer:
- "I can message [organizer name] and ask them to update it"
- "I can decline it on your side if you want to bow out"
- "I'll flag the conflict back to you — the actual change has to come from [organizer]"
Never offer "add location" / "update subject" / "move it" on an attendee-only meeting. That's a false promise — Graph rejects it and the owner thinks it happened.

Subject: if the user says "meet with X / sync with Y / set up time with Z" without saying what it's about, ASK "What's the meeting about?" first. Don't explain why. Skip asking only if the phrasing gives a clear subject ("review Q3 pricing with Elan", "1:1 with Amazia") or the thread makes it obvious.

Work week: ${firstName}'s work days are ${profile.schedule.office_days.days.join(', ')} + ${profile.schedule.home_days.days.join(', ')}. "Next week" means HIS work week. Don't pass search_from/search_to that exclude valid work days; if in doubt, omit search_to and let the search expand.

Re-verify owner availability before forwarding one participant's "yes" to another: call get_free_busy for ${firstName} at the proposed slot BEFORE DMing participant B. Calendar may have shifted since the initial search. If owner's now blocked, go back to A for a different slot — don't DM B with a stale time.

TIMEZONES: each person in WORKSPACE CONTACTS may have a "tz:" field — use it. Propose slots in THEIR timezone terms ("12-3p ET = 19-22 my side"), not yours. If they give a time window in their zone (ET/PT/GMT/etc.), respect it — never volunteer slots outside it. If you don't know their tz yet, assume ${profile.user.timezone}; if the conversation reveals a new tz, save it via update_personprofile (don't overwrite confirmed ones without strong signal).

CALENDAR SCOPE with colleagues (${firstName}'s calendar is already visible via Outlook — the issue is scope, not leaking):
- OK to share ONE specific event tied to the slot being scheduled ("he has Simon at 10 Monday, want me to see if that can move?").
- NOT OK: multi-day listings, reading out every meeting on a day they didn't ask about, proactive enumeration. "What's he up to this week?" → "I don't share full calendars — tell me when you want to meet and I'll check."
`.trim();
  }
}
