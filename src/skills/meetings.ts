import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext, ChannelId } from './types';
import type { UserProfile } from '../config/userProfile';
import {
  getOwnerEventsForDecision,
  updateMeeting,
} from '../connectors/graph/calendar';
import { SchedulingSkill as _LegacyOpsSkill } from './meetings/ops';
import { withCalendarOfflineRefusal } from './meetings/calendarOffline';
import logger from '../utils/logger';
import { DateTime } from 'luxon';
import { calendarListingFormatRule } from '../utils/calendarListingFormat';
import { checkSlot, occupancyRoleOf } from '../utils/scheduleRules';
import { displaySubject, subjectViewerFor, viewerEmailFor, PRIVATE_MASK } from '../utils/displaySubject';

/**
 * MeetingsSkill — the single skill responsible for everything about
 * putting a meeting on a calendar: direct create_meeting / update / move /
 * delete, free-busy lookups, and find-slots.
 *
 * If this skill is disabled in the profile, Maelle can't touch the calendar —
 * by design. "Booking meetings in any form" is this skill's whole reason for
 * being.
 */
export class MeetingsSkill implements Skill {
  id = 'meetings' as const;
  name = 'Meetings';
  description = 'Books, moves, and cancels meetings — direct calendar operations';

  // Direct-ops helper (former SchedulingSkill, now private). Used via delegate
  // for create_meeting / move_meeting / update_meeting / delete_meeting / etc.
  // Its own getTools/getSystemPromptSection are NOT called — this skill owns
  // the tool definitions and prompt. Only its executeToolCall is used.
  private readonly ops = new _LegacyOpsSkill();

  getTools(profile: UserProfile): Anthropic.Tool[] {
    const allowedDurations = profile.meetings.allowed_durations.join('/');
    // Read category enum from yaml instead of hardcoding owner-specific
    // names. Empty enum is invalid in Anthropic schemas, so a profile
    // without categories defined gets the field omitted entirely (matches
    // the v1.7.8 "leave uncategorized rather than guess" rule).
    const categoryNames = (profile.categories ?? []).map(c => c.name);
    const categoryEnum = categoryNames.length > 0 ? categoryNames : undefined;
    return [
      // v2.6.4 — find_slack_user moved to SlackConnection.getTools(). It's a
      // transport directory lookup with people_memory side effects, not a
      // meetings concern. Auto-registered when SlackConnection is registered.
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

If the meeting is NOT yet booked and they need to find a time together, use find_available_slots (it checks every internal attendee's calendar) and book the agreed slot with create_meeting.`,
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
        description: "Read the user's calendar events for a given date range — to SEE what's on the calendar, confirm a meeting exists, or verify a meeting's exact title/time before referencing it in a reminder or message. It LISTS events; it does NOT compute availability — never read these events to state free time, gaps, or a bookable duration. Any availability or duration claim ('25 min free there', 'the day is packed', 'free at 3') must come from find_available_slots (which applies the schedule rules), or from analyze_calendar for a whole-day review. For weekly reviews or issue detection, use analyze_calendar.",
        input_schema: {
          type: 'object',
          properties: {
            start_date: { type: 'string', description: 'Start date YYYY-MM-DD in the user\'s local timezone. Use the DATE LOOKUP table — never calculate.' },
            end_date: { type: 'string', description: 'End date YYYY-MM-DD in the user\'s local timezone.' },
            force_refresh: { type: 'boolean', description: 'Set TRUE whenever the current message asks to SEE/LOOK AT/CHECK the calendar or day ("what\'s on my day?", "look at my calendar", "check again", "their calendar changed") — anything expressing a wish to view current state. Forces a fresh read past the short cache. Leave false/omit for internal reads during a scheduling flow (the cache keeps those warm).' },
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
        name: 'revert_last_auto_move',
        description: `Undo something Maelle did that can be undone: an autonomous calendar-health move (the "🔍 I moved X to clear a conflict…" notice), a move ${profile.user.name.split(' ')[0]} asked for, or a meeting Maelle just booked for him. Trigger on "put it back", "revert that", "undo that", "no, leave it where it was" — the tool works out which of the three it actually was and reverts it accordingly: a move is restored to its original time (notifying anyone who needs to know, and — for an auto-move — marking it so calendar-health won't re-move it again); a booking is cancelled outright (deleted, not moved back — there's no prior time to restore).

With no argument this reverts the single most recent undoable action, same as always. When he instead names or describes a SPECIFIC past one ("undo the Donnie Time move", "revert what you did to Yael's meeting", "undo that thing from earlier"), first call get_my_tasks — its recent_activity rows carry target_name/target_slack_id — find the row matching what he described, then pass its id as task_id here. Never guess an id from memory. If more than one recent row could plausibly match, list the candidates (subject, who, when) and ask which one rather than picking.

Owner-only. Goes back exactly ONE step, and only while the event it acted on is still upcoming — a meeting that's already happened isn't worth un-touching, no matter how recently the mistake was made. Says so honestly when there's nothing eligible to undo. A CANCELLATION can't be put back this way (everyone already got the cancellation email); it says that plainly and offers to book a fresh one at the same time instead.

For a NEW scheduling change (not putting back one Maelle already made), use move_meeting / create_meeting instead.`,
        input_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Optional. The id of a SPECIFIC past action to undo, from get_my_tasks\' recent_activity rows (their task_id field) — set only after matching a row there against what he described. Omit to revert the latest undoable action (default, unchanged).' },
          },
        },
      },
      {
        // v3.7.x (#143) — per-date work-schedule override (owner-only). Not in
        // COLLEAGUE_ALLOWED_TOOLS + a senderRole gate in the handler.
        name: 'set_work_schedule_override',
        description: `Set a PER-DATE exception to ${profile.user.name.split(' ')[0]}'s standing work schedule — one date or a date range. Owner-only. Use when he says "I'm off next Wednesday", "working from the office Tuesday", "work 9-3 on Thursday", "I'll be in Boston Mon–Wed working 9-5 EST", or "scrap that override". This changes ONLY the named date(s); it does NOT touch his standing weekly schedule (that's yaml).

WHAT EACH FIELD DOES (all optional except date_from; omit a field to KEEP that day's normal value):
- off:true → that date is a NON-working day (day off / vacation / holiday): no meetings, no floating blocks.
- hours → the work-hour windows for the date, e.g. ["09:00-15:00"], or a split shift ["09:00-12:00","14:00-18:00"]. Replaces the day's normal hours. Read in his HOME timezone UNLESS you also pass timezone.
- location → "office" or "home" to override the day's normal type ("I'll come into the office this Friday").
- timezone → an IANA zone (e.g. "America/New_York") ONLY when he'll work from a DIFFERENT timezone that day (a trip). This makes it an AWAY day: his hours are evaluated in THAT zone and Maelle books directly there. For "Boston 9-5 EST" pass BOTH hours (["09:00-17:00"]) AND timezone ("America/New_York"). If he names NO zone, DO NOT pass timezone — the day stays in his home zone.
- note → optional short reason ("conference").
- clear:true → REMOVE any override on the date(s), reverting to his normal weekly schedule. Ignores the other fields.

DATES: pass date_from (and date_to for a range) as YYYY-MM-DD FROM THE DATE LOOKUP table — never calculate a date. A range writes the SAME override to every date in [date_from, date_to].`,
        input_schema: {
          type: 'object',
          properties: {
            date_from: { type: 'string', description: 'First date YYYY-MM-DD (from the DATE LOOKUP table). For a single day pass only this.' },
            date_to: { type: 'string', description: 'OPTIONAL. Last date YYYY-MM-DD of a range — the same override is written to every date from date_from through date_to inclusive. Omit for a single date.' },
            off: { type: 'boolean', description: 'OPTIONAL. TRUE = the date is a day OFF (non-working). Set only when he says he is off / on vacation / not working that day.' },
            hours: { type: 'array', items: { type: 'string' }, description: 'OPTIONAL. Work-hour windows "HH:MM-HH:MM" for the date (e.g. ["09:00-15:00"]). Multiple entries = split shift. Read in his home tz unless `timezone` is also set.' },
            location: { type: 'string', enum: ['office', 'home'], description: 'OPTIONAL. Force the date to an office day or a home day.' },
            timezone: { type: 'string', description: 'OPTIONAL. IANA zone (e.g. "America/New_York") — set ONLY for a day he works from a different timezone (a trip). Makes it an away day. Omit when he names no zone.' },
            note: { type: 'string', description: 'OPTIONAL. Short reason for the override.' },
            clear: { type: 'boolean', description: 'OPTIONAL. TRUE = delete the override(s) on the date(s) and revert to the normal weekly schedule. Ignores the other fields.' },
          },
          required: ['date_from'],
        },
      },
      {
        // v3.7.x (#143) — read-only view of upcoming overrides (owner-only).
        name: 'get_work_schedule_overrides',
        description: `List ${profile.user.name.split(' ')[0]}'s upcoming per-date schedule overrides (days off / custom hours / office-home flips / travel-timezone days), from today forward. Owner-only, read-only. Use when he asks "what overrides do I have?", "any exceptions to my schedule coming up?", "am I off any days soon?", "which days am I travelling?".`,
        input_schema: {
          type: 'object',
          properties: {},
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
- Checking colleague availability before scheduling → use find_available_slots with attendee_emails (it intersects their calendars AND applies the schedule rules)
- Needing actual bookable slots (with buffers, rules) → use find_available_slots
- Presenting meeting-time options to anyone. Free/busy data does not apply schedule rules (office-day start, thinking-time, lunch, buffer). For bookable options, always use find_available_slots.`,
        input_schema: {
          type: 'object',
          properties: {
            emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses to check' },
            start_date: { type: 'string', description: 'Start of range in ISO 8601 format' },
            end_date: { type: 'string', description: 'End of range in ISO 8601 format' },
            force_refresh: { type: 'boolean', description: 'Set TRUE when the current message asks to re-check availability now / says a calendar changed ("are they free now?", "check again — they moved something"). Forces a fresh read past the short cache. Leave false during a normal scheduling flow.' },
          },
          required: ['emails', 'start_date', 'end_date'],
        },
      },
      {
        name: 'find_available_slots',
        description: `Find bookable slots — ${profile.user.name}'s calendar intersected with every attendee you pass in attendee_emails, with all schedule rules applied. This is THE tool for proposing meeting times, for any attendee count: search → offer the slots → book the pick with create_meeting.

Before calling this tool: ASK ${profile.user.name.split(' ')[0]} TWO HUMAN QUESTIONS first if you don't already know the answer. Do NOT use the words "meeting_mode" or list four options — that's robotic. Ask like a person:
  • "In person or online?"
  • If in-person and the venue isn't ${profile.user.name.split(' ')[0]}'s office: "Where?" + "Roughly how long is the trip each way?"

SMART-SKIP THE ASK: when at least one attendee is in a different timezone than ${profile.user.name.split(' ')[0]} (people_memory has TZ data on each colleague), the meeting is remote by default. The handler will infer this and treat missing meeting_mode as 'online' automatically. Don't ask "in person or online?" when the attendee is clearly remote — it reads obtuse. Only ask when all attendees are in the same TZ as ${profile.user.name.split(' ')[0]}.

Then YOU pick the right meeting_mode based on what they said:
  • "online" / "Teams" / "Zoom" / "call" / "video" → meeting_mode='online'
  • "in person at the office" / "in person" with no other venue / "onsite" / "at our office" / "from the office" / "in the office" → meeting_mode='in_person'
  • "in person at <somewhere else>" / "at the client" / "their place" / "offsite" / "I need to join their meeting" → meeting_mode='custom' AND pass travel_buffer_minutes from their answer (one-way minutes)
  • "either" / "whatever works" / "doesn't matter" → meeting_mode='either'

ONLINE ≠ "AT HOME". meeting_mode='online' is a scheduling flag — it tells the tool the meeting does NOT require physical presence at the office, so all day types are searched. It does NOT mean ${profile.user.name.split(' ')[0]} attends from home. An online meeting can land on an office day; he may be at the office while joining via Teams/Zoom. Never frame online and in-person as mutually exclusive places — they describe the meeting's connection method, not where he sits.

EXPLAINING WHY A DAY ISN'T OFFERED. The tool returns a \`day_summary\` array with one entry per workday touched: \`{ date, accepted, top_reasons, blocked_by? }\`. When the user pushes back ("what about Monday?" / "nothing on Tuesday?"), look up that date in \`day_summary\` and narrate the actual reason:
  • \`accepted: 0, top_reasons: ['owner_busy_collision', 'focus_time_office']\` → "Monday is fully booked — back-to-back meetings, and what's left would put you under your free-time floor."
  • \`accepted: 0, top_reasons: ['wrong_day_type']\` → "Monday is a home day, in-person needs an office day."
  • \`accepted: 0, top_reasons: ['owner_out_of_office']\` → "Monday is out — ${profile.user.name.split(' ')[0]} is out of office that day." If that entry also carries \`oof_until_display\`, the away stretch runs past this one day — name the real end instead: "Monday is out — ${profile.user.name.split(' ')[0]} is away through Friday 29 Aug."
  • \`accepted: 0, top_reasons: ['category_per_day']\` → "Already at the daily cap for that category."
  • \`attendee_busy_collision\` (also in \`blocked_by\`) → the attendee's OWN calendar is genuinely busy during your shared hours — real evidence. Scope it ("X is booked during your shared hours Thursday"), don't inflate to "unavailable all day."
  • \`outside_attendee_work_hours\` → the only openings fall outside the attendee's ASSUMED hours (a timezone-derived default, usually NOT their real schedule). Do NOT say "X isn't available" — say it no-overlap and hedge: "your free time Thursday is outside X's likely working hours." If ${profile.user.name.split(' ')[0]} then states the attendee's REAL hours ("Lori starts 7am ET, so 7am works"), pass \`attendee_hours\` (below) to OVERRIDE the assumed default for that one search — don't keep clipping to the wrong hours.
  • \`accepted: >0\` → the day HAS options; if Sonnet's spread picker didn't surface one, say "there are slots that day, want me to pull them?"
  • Date not in \`day_summary\` at all → "I haven't checked that day yet — want me to look?"

NEVER fabricate a reason. Don't say "day off" / "not a workday" unless \`top_reasons\` is \`['wrong_day_type']\`. The data has the truth — use it. And NEVER blame the colleague for the owner's full day: "X isn't available / can't make it" is honest ONLY with positive evidence from X's calendar (\`attendee_busy_collision\` / \`blocked_by\`). When the real block is the owner's own calendar, or you lack positive evidence he's free then, say it owner-first / no-overlap ("your Thursday is full", "no opening that works for both of you Thursday") — never a false absolute about the colleague.

A SPREAD IS A SAMPLE. The 2–5 options find_available_slots surfaces are a sample of the day, not the whole set — NEVER narrate the un-shown time as gone ("that's all", "the rest of the day is packed"). More may be free; offer to pull more, or to check a specific time.

The search window auto-expands up to 21 days if fewer than 3 slots are found.

PREFERRED SLOT (v2.9.2): when the requester names a SPECIFIC preferred time ("preferably 11:30", "around 14:00", "if 10:00 works"), pass that exact ISO datetime as \`preferred_slot\`. The tool will check that slot specifically and include it in the result if it's free — even when the spread-picker (1h gap rule, 2/day cap) would have filtered it out. Without this, the requester's asked time can vanish from the offered options and you end up narrating "X isn't clean" when X is actually free.

CANDIDATE SLOTS — BATCH VALIDATION (v3.0.6): when you have MULTIPLE specific times to check ("can we do A, B, C, or D?" — requester or owner proposed N candidate times), pass them ALL in a single call as \`candidate_slots: [{start}, ...]\` instead of N separate find_available_slots calls. The tool validates each candidate against ${profile.user.name.split(' ')[0]}'s calendar + attendee availability + your rules and returns a results array — one verdict per candidate.

Return shape in this mode is DIFFERENT:
  { mode: 'candidate_validation', results: [{ start, end, available, broken_rule_label? }, ...] }

When ALL candidates are blocked: narrate WHY using each \`broken_rule_label\` verbatim ("Jun 9 7pm is outside the attendee's working hours; Jun 10 5:30pm conflicts with another meeting…") and offer to widen the search. When at least one is available: surface those.

ALWAYS prefer \`candidate_slots\` over multiple separate calls when the candidates are concrete times the user named. ONE call instead of N saves real time. \`search_from\` / \`search_to\` are ignored in this mode — pass any value (the candidate range is used).`,
        input_schema: {
          type: 'object',
          properties: {
            duration_minutes: (() => {
              const allowed = profile.meetings.allowed_durations;
              const defaultDur = profile.meetings.default_meeting_duration
                ?? [...allowed].sort((a, b) => a - b)[0];
              return {
                type: 'number' as const,
                enum: allowed,
                description: `Meeting duration in minutes. DEFAULT TO ${defaultDur} whenever the conversation hasn't stated an explicit length — "when can I meet X?", "list my options", "find a time", "schedule an interview / catch-up / sync" all use ${defaultDur}. When a length IS explicitly named, pick the NEAREST allowed preset to the stated minutes (with these presets: "30 min" → 25, "45" → 40, "an hour" → 55) — this matches what booking snaps to, so the search and the booked meeting never disagree. NEVER infer length from the meeting TYPE — an "interview", "catch-up", or "review" is still ${defaultDur} unless a number is stated. Don't pick a longer enum just to surface more options.`,
              };
            })(),
            attendee_emails: { type: 'array', items: { type: 'string' }, description: 'Emails of attendees whose calendars should constrain the search (intersected with the owner\'s). Known internal colleagues named in the request are resolved from the directory and added for you automatically — you do NOT need to resolve names or call find_slack_user first. Pass any emails you already have. You do NOT need an EXTERNAL attendee\'s email to search (candidate / other company / personal domain): their calendar isn\'t visible, so the tool searches the owner\'s side and you collect their email only at BOOKING. Never demand an email — or withhold times — just to run the search.' },
            attendee_hours: {
              type: 'array',
              description: `OVERRIDE an attendee's working hours for THIS search when ${profile.user.name.split(' ')[0]} states their REAL hours — the finder otherwise clips to a timezone-derived DEFAULT that is usually wrong (see the outside_attendee_work_hours note above). E.g. "Lori starts 7am ET, so 7am works" → attendee_hours:[{ email:"<lori's email>", start:"07:00", tz:"America/New_York" }]. Give ONLY the bound(s) he stated (start and/or end); the other keeps its stored value. tz = the IANA zone the hours are in (default: the attendee's own zone). Targeted per-attendee — everyone else keeps their own hours. Prefer this over ignore_attendee_availability, which drops EVERYONE's hours.`,
              items: {
                type: 'object',
                properties: {
                  email: { type: 'string', description: 'The attendee whose hours to override (matches an attendee_emails entry).' },
                  start: { type: 'string', description: 'OPTIONAL. Work-day start "HH:MM".' },
                  end: { type: 'string', description: 'OPTIONAL. Work-day end "HH:MM".' },
                  tz: { type: 'string', description: 'OPTIONAL. IANA zone the hours are stated in. Default: the attendee\'s stored zone.' },
                },
                required: ['email'],
              },
            },
            search_from: { type: 'string', description: 'Start of search window. ISO 8601, date-only ("2026-05-25") or with time ("2026-05-25T07:00:00"). NOTE: the time-of-day is only honored as a hard limit when time_window_is_hard=true (see below) — otherwise the tool searches the full work day. Auto-expanded up to 21 days if fewer than 3 slots found.' },
            search_to: { type: 'string', description: 'End of search window. ISO 8601, date-only or with time. NOTE: the time-of-day is only honored as a hard limit when time_window_is_hard=true.' },
            time_window_is_hard: { type: 'boolean', description: 'Set TRUE only when the owner/attendee gave a REAL time constraint ("must end by noon", "only after 3pm", "available 7–12"). Then the search_from/search_to times are honored as a hard clip. When false/omitted (DEFAULT), those times are treated as SOFT — the tool searches the OWNER\'S FULL WORK DAY (including night-shift hours) and lets the work-hours + attendee-timezone filters surface the real overlap. This prevents accidentally clipping off valid late/night-shift slots that overlap a far-timezone colleague\'s working hours.' },
            present_in_timezone: { type: 'string', description: 'IANA timezone to ALSO render every returned slot in (e.g. "America/New_York", "America/Los_Angeles"). Set this whenever the requester asks for options in a specific timezone — INCLUDING when no attendee is stored in that zone (e.g. an organizer collecting options to hand to US colleagues "in ET"). The tool attaches a pre-rendered `presentation_local` string per slot (e.g. "Tue 16 Jun 09:00 EDT"); quote it verbatim and NEVER do the timezone conversion yourself.' },
            search_window_timezone: { type: 'string', description: 'IANA timezone that the search_from/search_to CLOCK times are expressed in (e.g. "America/New_York"). Set this when the requested meeting time was GIVEN in a non-owner timezone — e.g. the owner/colleague said "9:45 AM ET": pass search_from="...T09:45:00" + search_window_timezone="America/New_York" and the tool converts to the owner timezone for the search. OMIT when the times are already in the owner timezone (e.g. the requester already converted, or said "4pm my time"). NEVER hand-convert the search time yourself — tag the source zone and let the tool convert.' },
            requester_is_attending: { type: 'boolean', description: 'DEFAULT true — the colleague asking is one of the meeting attendees (their calendar + work-hours are factored, their timezone drives the cross-TZ labels). Set FALSE whenever the requester is ORGANIZING a meeting they are NOT in — an EA collecting options for others, OR scheduling a candidate / interviewee / third party to meet the owner ("set up the candidate for an interview with him", "find a time for Rubi to meet him"). Then pass the ATTENDEE who will actually be in it (the candidate\'s email) or NO attendee at all — NEVER attendee_emails=[the requester], which clips the search to the organizer\'s own hours. When false, the requester\'s own calendar and work-hours are NOT used to filter the search and she is not annotated as "busy" — only the actual attendees (and the owner) constrain the slots.' },
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
              // Backtick-delimited: this literal interpolates the owner's first
              // name. As a single-quoted string the `${…}` shipped to the model
              // as raw JavaScript source inside the schema. Matches the sibling
              // `must_be` description below, which already interpolates.
              description: `OPTIONAL (default false). By default on owner-initiated calls with attendees, the tool filters slots by both (a) each attendee's working hours / timezone (their day-window) and (b) their busy time from Graph free/busy. Set true to suppress the BUSY filter; the work-hours / timezone window is ALWAYS honored ("force them to move a meeting, not to wake up at 3 AM"). SET TRUE in TWO cases: (1) owner explicitly says "force them" / "ignore their calendar, I want this slot anyway"; (2) you are finding time for a meeting a COLLEAGUE REQUESTED — they asked for it (especially flagged urgent), so THEY are flexible and will move their own conflicts. ${profile.user.name.split(' ')[0]} is the scarce resource: find when HE is free and let the requester accommodate. When true with attendees, the result TAGS each attendee's busy status on the owner-free slots (attendee_status), so you can say "12:30 works for him — you've got something then, want me to ask them to move it?" — NEVER bounce "when are you free?" back to the requester who asked.`,
            },
            relaxed: {
              type: 'boolean',
              description: 'OPTIONAL (default false). Owner override path — see OWNER-PATH OVERRIDE rule in the MEETINGS SKILL section. Owner-only; ignored on colleague-path calls.',
            },
            must_be: {
              type: 'boolean',
              description: `OPTIONAL (default false). COLLEAGUE-PATH ONLY. Set true when a colleague's request is a genuine MUST-BE and the strict search would otherwise find nothing: (1) they named a SPECIFIC time that has to happen ("it has to be 12:00 tomorrow"), OR (2) they said it MUST be today/tomorrow (urgent) and ${profile.user.name.split(' ')[0]}'s clean options are too far out. When set and no clean slot exists, the tool returns \`owner_approval_candidates\` — times that are open but sit inside ${profile.user.name.split(' ')[0]}'s soft day-load protections (focus / buffer / booking lead-time). Do NOT offer these to the colleague and do NOT book them; raise create_approval(kind=policy_exception) with one so ${profile.user.name.split(' ')[0]} decides with a single yes. Leave false for ordinary requests — those just hear his day is loaded.`,
            },
            moving_event_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'OPTIONAL. Pass when validating or discovering a MOVE — these are the calendar event id(s) of the meeting(s) being moved. Each id\'s current time is (1) SUBTRACTED from the owner\'s busy pool so candidate slots aren\'t blocked by a meeting that\'s leaving, AND (2) FORBIDDEN as a candidate so the tool never offers the original time (or any overlap with it) as a "move target". Use when the owner asks "can we move the 11am to 10:30?" / "what are options to move the 11am?". Get the event id from get_calendar. Omit for new bookings.',
            },
            category: {
              type: 'string',
              description: 'OPTIONAL. The category this meeting will be booked under. When set, slot-finder applies the category rules — daily / weekly limits and day-type constraints (office-only, home-only). Slots that would violate the category get filtered out before returning. Omit ONLY when there is no category context (e.g. owner is asking "when am I free?" with no specific meeting in mind). When you have a category context, ALWAYS pass it — otherwise the slots returned ignore category rules and you may propose a time that breaks them. The value must match one of the names from the CATEGORIES list in the prompt.',
            },
            preferred_slot: {
              type: 'string',
              description: 'OPTIONAL. ISO datetime of the requester\'s specifically asked time ("preferably 11:30", "around 14:00", "if 10:00 works"). The tool guarantees this slot is in the result if it passes all rules (free, in work hours, no category violation, etc.), even when the spread-picker would have filtered it. Use when the requester named an exact time — closes the "asked slot vanishes" narration bug.',
            },
            candidate_slots: {
              type: 'array',
              description: 'OPTIONAL. Use when checking MULTIPLE specific candidate times in one call ("can we do A, B, C, or D?"). Each item: { start: ISO datetime in user TZ }. Each candidate is checked as a duration_minutes-long meeting starting at that instant, against ALL the same rules (busy collision, work hours, attendee availability, focus, category), and returns one verdict per candidate. Use this INSTEAD of N separate find_available_slots calls — much faster. See the CANDIDATE SLOTS section of the description for the result shape.',
              items: {
                type: 'object',
                properties: {
                  start: { type: 'string', description: 'ISO datetime of the candidate slot start, in user local timezone (e.g. "2026-06-09T19:00:00").' },
                },
                required: ['start'],
              },
            },
          },
          required: ['duration_minutes', 'attendee_emails', 'search_from', 'search_to', 'meeting_mode'],
        },
      },
      {
        name: 'create_meeting',
        description: `Create a new calendar event directly — THE booking tool. The agreed time comes from find_available_slots (which already checked every internal attendee's calendar); externals get the invite by email and accept/decline natively. Follow the location / category / work-day rules in the prompt section.

RESCHEDULING ≠ CREATING. Before booking a recurring 1:1 (Weekly / BiWeekly) to a NEW time: if that person's series already exists on the calendar, you are RESCHEDULING — call move_meeting on the existing occurrence (get its id from get_calendar), NOT create_meeting. Creating a fresh event leaves a duplicate next to the live series. create_meeting is for genuinely NEW meetings only.

LOCATION & ONLINE — THE HANDLER DECIDES. There's a deterministic process: day-type (office/home) × party shape (internal-only / has-external) × TZ produces the right answer. ${profile.user.name.split(' ')[0]}'s home day + internal-only → Huddle. ${profile.user.name.split(' ')[0]}'s office day + internal-only → Office. External + home → online with Teams. External + office + different TZ → online with Teams. External + office + same TZ → handler asks ${profile.user.name.split(' ')[0]} once. You don't recreate this math; you let the handler run.

WHEN TO PASS \`is_online\` AT ALL (v2.9.1):
- **DEFAULT: OMIT.** No conversational signal → leave \`is_online\` unset. The handler picks per day-type + party shape. Do NOT default to \`true\` "to be safe" — that corrupts the decision (an internal home-day meeting should be Huddle, not Teams).
- Pass \`is_online: true\` ONLY when the conversation explicitly said online ("Zoom", "Teams", "video", "remote", "let's do a call").
- Pass \`is_online: false\` ONLY when the conversation explicitly said in-person ("at our office", "in person", "they'll come over", "let's meet").
- When the handler asks "online or in person?" and ${profile.user.name.split(' ')[0]} answers, THAT's an explicit signal → pass the matching boolean on the retry.

LOCATION FIELD:
- Specific venue mentioned ("at Café Aroma", "at customer site") → pass \`location\` as the venue. Helper will mark in-person.
- Otherwise OMIT \`location\` — handler stamps the right label.

DON'T ASK WHEN A CLEAR SIGNAL ALREADY EXISTS (people_memory shows different TZ, prior conversation mentioned video, etc.) — reading the data is your job, not the owner's to repeat.

Colleague-path (v2.3.2 + v2.6.5 + v2.6.6): when a colleague has confirmed slot + duration + subject in this DM with you, call this tool directly to book — the requester (1:1), multi-internal (everyone in the same workspace), or owner-only-pollable (requester + externals). Externals are fine; they get the calendar invite via Outlook. The handler enforces server-side: every attendee must have an email; rule-compliant slot (work hours, work days, buffers, floating blocks, no conflicts via findAvailableSlots); then auto shadow-DMs the owner so he sees it happen. If the slot fails the rule check, the tool returns { success: false, error: 'not_rule_compliant', message } — fall back to create_approval(kind=policy_exception). If an attendee has no email, the tool returns { success: false, error: 'attendee_missing_email' } — resolve it via find_slack_user (directory lookup); if it truly can't be resolved, raise create_approval(kind=freeform) so the owner supplies it. DO NOT punt with "go ahead and send him the calendar invite" — the colleague's invite won't have the owner's location prefs, won't get auto-categorized, and the owner gets no shadow record. YOU are the EA; YOU book it.

SUBJECT — with an EXTERNAL on the invite, secure a REAL one BEFORE booking. Externals see the invite, and a rename hits them as a SECOND notification — so never send an external a placeholder ("Meeting with X and Y") you'll rename right after. When the subject is missing and the invite includes an external (candidate / other company / personal domain), ASK for it BEFORE create_meeting, batched with any other missing field in ONE question ("what day, and what should I call it?") — never day-first, then subject after the fact. Internal-only bookings on ${profile.user.name.split(' ')[0]}'s OWN path may use a working title and be renamed later, for speed. On the COLLEAGUE path, when the colleague asking for the meeting hasn't stated a subject, ASK for one before booking — batch it with any other missing field, same as above — instead of inventing a placeholder like "Team Sync"; a colleague's meeting gets its real subject up front, not a rename after the fact.

LANGUAGE: calendar invites are shared artifacts others read, so keep subject + body in English (translate if the owner instructs in Hebrew). The subject/body params restate this.`,
        input_schema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Meeting subject — ENGLISH ONLY, even when conversing in Hebrew.' },
            start: { type: 'string', description: 'ISO 8601 datetime — the clock time EXACTLY as the owner stated it, NOT converted. Say which zone that clock is in via `stated_zone`.' },
            end: { type: 'string', description: 'ISO 8601 datetime. Same zone basis as start.' },
            stated_zone: { type: 'string', description: 'Which timezone the owner NAMED for this time. Set it WHENEVER he names ANY zone — INCLUDING his home zone (this is the #1 thing to get right while he travels). Values: "home" (he said "Israel time" / "my home time" / "IL time"), "local" (he said "my time" / "local", or named the place he is physically in), or an IANA zone like "America/New_York" (he named a specific OTHER zone, e.g. "ET"/"EST"/"PT"). OMIT ONLY when he names NO zone — then a bare time is read as where he physically is on a travel day, else his home zone. Example: travelling in Boston he says "6:30 PM Israel time" → start="...T18:30:00", stated_zone="home". Pass the clock as-stated; the tool does ALL timezone math — NEVER hand-convert.' },
            intended_weekday: {
              type: 'integer',
              minimum: 1,
              maximum: 7,
              description: 'OPTIONAL. If the owner/colleague named a WEEKDAY for this time ("book it Thursday", "Monday morning"), set this to that weekday as a number (1=Monday … 7=Sunday). A deterministic safety check refuses the booking if the resolved `start` date\'s weekday doesn\'t match — catching a "Thursday" accidentally resolved to a Friday — and hands back the corrected date to retry with. OMIT when no weekday word was used (e.g. "tomorrow", "the 26th", "next week", or a slot picked from find_available_slots).',
            },
            attendees: {
              type: 'array',
              description: 'The people ATTENDING the meeting, each as {name, email?}. Internal colleagues\' emails are resolved automatically from the directory — pass the name and NEVER ask (owner or colleague) for an internal teammate\'s email you can look up; it is filled in for you, so BOOK instead of asking. Supply an email yourself ONLY for a genuinely EXTERNAL person (candidate / other company / personal domain), and only at the moment of booking. The one legitimate reason to ask about a named person is that the name is AMBIGUOUS (more than one match) or you cannot place them at all — then ask WHICH person, never for an email you already have in hand. A colleague who only RELAYED a request between OTHERS ("tell Idan I want to meet Tal", "Dana asked me to set up a call with you") is the REQUESTER, NOT an attendee — do NOT list them here. Use requester_is_attending=false (+ requester_slack_id) for them instead.',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, email: { type: 'string', description: 'Only for a clearly EXTERNAL attendee — internal emails resolve automatically, so leave this off for colleagues on file.' } },
                required: ['name'],
              },
            },
            requester_is_attending: {
              type: 'boolean',
              description: 'OPTIONAL (default true). Set FALSE when the person who ASKED for this meeting is NOT one of its attendees — a colleague relaying a meeting between other people, or an EA booking for others. The handler then drops the requester from attendees, so they are neither invited nor recorded as having this meeting themselves. (Note their relay separately with note_about_person if useful — that is coordination, not a meeting they are in.)',
            },
            requester_slack_id: {
              type: 'string',
              description: 'OPTIONAL. Slack id of the requester when they are NOT attending (pair with requester_is_attending=false) — e.g. the colleague who relayed the request. Lets the handler drop exactly them even on the owner path, where the requester is not the person currently talking. Omit on the colleague path — it defaults to the colleague who is talking.',
            },
            force_new: {
              type: 'boolean',
              description: 'OPTIONAL (default false). If the owner is RESCHEDULING an existing meeting (e.g. "move my Simon 1:1 to Monday"), do NOT create — use move_meeting on the existing event. The handler will detect a same-subject + same-person event already in the calendar and hand you its id to move instead. Set force_new=true ONLY when the owner genuinely wants a SEPARATE, ADDITIONAL meeting with the same people (not a reschedule) and has confirmed it after that heads-up.',
            },
            body: { type: 'string', description: 'Optional meeting body — ENGLISH ONLY. DEFAULT EMPTY: a subject-only invite is the norm — NEVER ask "what goes in the body?" or "leave the body empty?"; just book. Only ever populate it from text the owner/requester ALREADY handed you — never solicit it. FOLLOW-THROUGH: if you told the owner or requester that specific text they gave you (a summary / agenda / notes / "the X text") would be in the invite, you MUST pass that exact text here, on the booking call itself — promising it and leaving body unset ships an empty invite (and an approval replay only carries the body you set).' },
            keep_requested_time: {
              type: 'boolean',
              description: 'OPTIONAL (default false). On a dense-calendar profile, create_meeting may return error="efficiency_counter" with a suggested back-to-back time (earlier or later, whichever side packs tighter) instead of booking a time that leaves a short dead gap. Present the suggestion; if the person prefers their ORIGINAL time, re-call create_meeting with the same args PLUS keep_requested_time=true to book it as requested (skips the counter). Do NOT set this preemptively.',
            },
            is_online: {
              type: 'boolean',
              description: 'OPTIONAL. Pass ONLY when conversation explicitly said online (Zoom/Teams/video/call) or in-person (at office/come over/meet). When no explicit signal, OMIT — the handler picks per day-type + party shape (internal+home=Huddle, internal+office=Office, external=Teams). Defaulting to true silently corrupts the location decision.',
            },
            location: { type: 'string' },
            category: categoryEnum ? { type: 'string', enum: categoryEnum } : { type: 'string' },
            add_room_email: { type: 'boolean' },
            start_is_explicit: {
              type: 'boolean',
              description: 'OPTIONAL (default false). Set TRUE only when the owner named an EXACT off-grid time ("book at 14:40", "9:05"). Otherwise the handler snaps the start to the :00/:15/:30/:45 grid. Slots from find_available_slots are already aligned — leave unset for those.',
            },
            must_be_after_event_id: {
              type: 'string',
              description: 'OPTIONAL. When set, the booking refuses if the proposed start is BEFORE the end of the referenced event. Use when this meeting is part of an ordered series ("M2 must come after M1") to make the order constraint enforceable at booking time. Pass the event id from get_calendar (or from the previous create_meeting return) of the predecessor. Omit when there is no predecessor.',
            },
            start_at_event_end_id: {
              type: 'string',
              description: 'OPTIONAL. Anchor this block to START at the END of an existing event — for "X after my flight", "a block right after my last meeting", etc. Pass that event\'s id (from get_calendar) PLUS `duration_minutes`, and OMIT `start`/`end`: the handler reads the event\'s end INSTANT, snaps it FORWARD (never earlier — never overlapping the anchor) to the next :00/:15/:30/:45 tick, and sets start there — end = snapped start + duration_minutes. The block lands at the correct moment in the correct timezone, up to ~14 min after the anchor\'s literal end — NEVER compute the time yourself and NEVER ask the owner what time the event ends/lands when it is already on the calendar.',
            },
            duration_minutes: {
              type: 'number',
              description: 'OPTIONAL. Block length in minutes — used ONLY with `start_at_event_end_id` (end = anchored start + this). For a normal booking pass `start`+`end` instead.',
            },
            is_all_day: {
              type: 'boolean',
              description: 'OPTIONAL (default false). Set TRUE only when the user explicitly asks for a full-day / all-day event ("block the whole day", "full day", "all day", "vacation marker"). When true: the system clamps start/end to midnight of the day → midnight of the next day in the user TZ; you can pass start as the day at any time and the handler normalizes. Owner-only personal blocks (no attendees, focus / prep / vacation marker) → also pass category=Logistic to skip the location stamp.',
            },
            override_hold: {
              type: 'boolean',
              description: 'OPTIONAL (default false). Owner-only. The tool refuses with error="slot_on_hold" when the slot is tentatively held for someone else, surfacing "X asked to reserve that — book anyway?". Pass TRUE on the retry after the owner says book it anyway — it books, releases the hold, and DMs the holder it was let go.',
            },
            relaxed: {
              type: 'boolean',
              description: 'OPTIONAL (default false). Owner override path — see OWNER-PATH OVERRIDE rule in the MEETINGS SKILL section. Owner-only; ignored on colleague-path calls.',
            },
            sensitivity: {
              type: 'string',
              enum: ['normal', 'personal', 'private', 'confidential'],
              description: 'OPTIONAL. Outlook sensitivity field — controls how this meeting renders on shared free/busy views. DEFAULT: omit (Outlook treats as normal). DO NOT proactively ask or set. Only pass when the owner OR an attendee on this meeting EXPLICITLY asks for it ("mark this private", "make it confidential", "hide the subject"). When an attendee asks for "private" on a meeting they\'re on, that\'s a legitimate attendee right (different from the Maelle category tagging that the owner curates). Map: "private" → \'private\', "confidential" → \'confidential\', "personal" / "off-record" → \'personal\'.',
            },
          },
          required: ['subject', 'start', 'end', 'attendees', 'category'],
        },
      },
      {
        name: 'move_meeting',
        description: `Move (reschedule) an existing meeting — THE tool whenever the owner asks to move / reschedule / shift / push a meeting that's already on the calendar. Prefer over create_meeting AND delete+recreate; preserves attendees, Teams link, duration, history. Includes relocating a recurring 1:1 (Weekly/BiWeekly) to a different day or week — moving a recurring occurrence creates a single-occurrence exception, leaves the rest of the series intact (that's what 'move my weekly' means). Get the occurrence id from get_calendar. Keep the meeting's current duration unless told otherwise (new_end = new_start + existing length).

Owner-path: owner override IS the approval. Move the meeting when he asks.

FREED SLOT — after a successful move the result includes \`vacated\` = the slot the meeting just LEFT (its old time): { start, end, label }. Surface it when useful ("that frees up your 11:00 today") so it's in the conversation. If the owner then asks to put something into "the new open slot" / "the freed slot", use \`vacated\` — don't re-ask what time the moved meeting used to be, and don't confuse where it moved TO with where it moved FROM.
RECLAIM — the result may also include \`reclaimable_block\` = { name, label, … } when this move/delete freed room inside a displaced floating block's window (e.g. lunch got bumped earlier, now its window is open again). OFFER it in the same reply ("…frees 12:30 — want lunch back there?"); it's a proposal, not done. Act only on his yes.

Colleague-path (v2.2.1): when a colleague asks to move a meeting you've already booked with them, call this directly. The handler runs a rule-compliance check server-side (owner's work hours, work days, buffers, floating blocks, no conflicts). If the new slot passes, the move happens silently and the owner is shadow-notified. If the new slot breaks a rule, the tool returns { needs_owner_approval: true, reason, message } — don't keep trying; fall back to create_approval(kind=policy_exception) with the requested slot so the owner can decide, and tell the colleague warmly that you're checking. If the colleague (who's on the meeting) asks to move it but names NO new time, don't escalate straight to approval — call find_available_slots (owner + the other required attendees), offer 2–3 rule-compliant slots, let them pick, then move_meeting. Escalate (create_approval kind=policy_exception) only if they insist on a specific time that breaks a rule.`,
        input_schema: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            meeting_subject: { type: 'string' },
            new_start: { type: 'string', description: 'ISO 8601 datetime — the clock time EXACTLY as the owner stated it, NOT converted. Say which zone that clock is in via `stated_zone`.' },
            new_end: { type: 'string', description: 'OPTIONAL — omit on a pure reschedule to KEEP the meeting\'s current length (the handler derives new_end = new_start + the existing duration, so you never have to ask "how long?"). Set it ONLY when the duration is actually changing.' },
            stated_zone: { type: 'string', description: 'Which timezone the owner NAMED for the new time. Set it WHENEVER he names ANY zone — INCLUDING his home zone. Values: "home" (he said "Israel time" / "my home time"), "local" (he said "my time" / "local", or named the place he is physically in), or an IANA zone like "America/New_York" (he named a specific OTHER zone, e.g. "ET"/"EST"). OMIT ONLY when he names NO zone — then a bare time is read as where he physically is on a travel day, else his home zone. Pass the clock as-stated; the tool does ALL timezone math — NEVER hand-convert.' },
            intended_weekday: {
              type: 'integer',
              minimum: 1,
              maximum: 7,
              description: 'OPTIONAL. If the owner named a WEEKDAY for the new time ("move it to Thursday", "back to Monday"), set this to that weekday as a number (1=Monday … 7=Sunday). A deterministic safety check refuses the move if new_start\'s weekday doesn\'t match — catching the "return it to Thursday" that resolved to a Friday — and hands back the corrected date to retry with. OMIT when no weekday word was used (e.g. "tomorrow", "the 26th").',
            },
            start_is_explicit: {
              type: 'boolean',
              description: 'OPTIONAL (default false). Set TRUE only when the owner named an EXACT off-grid new time ("move it to 14:40"). Otherwise the handler snaps new_start to the :00/:15/:30/:45 grid.',
            },
            confirm_outside_window: {
              type: 'boolean',
              description: 'OPTIONAL. Floating-block out-of-window override — see FLOATING BLOCKS rule in the MEETINGS SKILL section. Ignored on non-floating-block moves.',
            },
            relaxed: {
              type: 'boolean',
              description: 'OPTIONAL (default false). Owner override path — see OWNER-PATH OVERRIDE rule in the MEETINGS SKILL section. Owner-only; ignored on colleague-path calls.',
            },
            category: {
              type: 'string',
              description: 'OPTIONAL. The category the meeting is tagged with — used by the colleague-path rule check at the destination day to enforce category limits (per_day / per_week) and day_type constraints. Pass the meeting\'s existing category from get_calendar so the destination day count is validated correctly. Omit when the meeting has no category or when the move is purely owner-driven.',
            },
            override_hold: {
              type: 'boolean',
              description: 'OPTIONAL (default false). Owner-only. The tool refuses with error="slot_on_hold" when the move target is tentatively held for someone else, surfacing "X asked to reserve that — move anyway?". Pass TRUE on the retry after the owner says move it anyway — it moves the meeting, releases the hold, and DMs the holder it was let go.',
            },
          },
          required: ['meeting_id', 'meeting_subject', 'new_start'],
        },
      },
      {
        name: 'update_meeting',
        description: `Update metadata on an existing meeting WITHOUT rescheduling it — change subject, attendee list, OR location.

LOCATION (v3.5.x): to change where an existing event is, pass \`location\` (a venue name/address — resolve it via find_venue first if you only have a name or a maps link) or \`is_online: true\` (online/Teams). This is THE way to "update the location" of a meeting already on the calendar. Omit both to leave the location untouched (a pure subject/attendee/reschedule change never wipes the venue).

CATEGORY changes do NOT belong here — use \`set_event_category\` for ALL category changes. It sets the category on the owner's OWN copy of the event and works for ANY event regardless of who organized it (Outlook categories are per-user). update_meeting's category path requires the owner to be the ORGANIZER and returns \`not_organizer\` on a meeting someone else created — which is wrong, since the owner can categorize anything on his calendar. So: category-only change → \`set_event_category\`, always.

ATTENDEES (v2.9.1):
- Use \`add_attendees\` to bring new people onto an existing meeting (e.g. "add Dina to the 3pm").
- Use \`remove_attendees\` to drop people (pass their emails).
- Owner-path: full add/remove. The handler re-evaluates category + location when the attendee shape changes (e.g. crossing internal-only → has-external, or count crossing 4↔5).
- Colleague-path: whoever REQUESTED this specific meeting can add or remove other attendees on it — that's per-meeting (who asked for it), not a blanket colleague permission. A colleague who is NOT the requester is refused (\`colleague_not_requester\`) and the change is routed to ${profile.user.name.split(' ')[0]}'s approval instead.
- Prefer this over delete+recreate — keeps the Teams link, history, and existing attendee responses intact. delete+recreate is the LAST resort.`,
        input_schema: {
          type: 'object',
          properties: {
            meeting_id:      { type: 'string' },
            meeting_subject: { type: 'string' },
            category:        categoryEnum ? { type: 'string', enum: categoryEnum, description: 'AVOID — use set_event_category for category changes (works on any event regardless of organizer). This path only succeeds when the owner organized the meeting.' } : { type: 'string', description: 'AVOID — use set_event_category instead (organizer-independent).' },
            new_subject:     { type: 'string' },
            location:        { type: 'string', description: 'OPTIONAL. New location for the event — a venue name/address (resolve via find_venue first if you only have a name or a maps link). Sets the calendar location. Omit to leave it unchanged. For an online meeting use is_online instead.' },
            is_online:       { type: 'boolean', description: 'OPTIONAL. Set true to make the event online (Teams). Omit to leave the location/online state unchanged.' },
            add_attendees: {
              type: 'array',
              description: 'Attendees to ADD to the existing meeting. Each must have an email. Owner-path: any people. Colleague-path: whoever REQUESTED this specific meeting can add others on it — per-meeting, not a blanket colleague permission. A colleague who is NOT the requester is refused (`colleague_not_requester`) and routed to the owner\'s approval instead.',
              items: {
                type: 'object',
                properties: {
                  name:  { type: 'string' },
                  email: { type: 'string' },
                  optional: { type: 'boolean', description: 'OPTIONAL. Mark as Outlook "optional" attendee. Default false (required).' },
                },
                required: ['email'],
              },
            },
            remove_attendees: {
              type: 'array',
              description: 'Emails of attendees to REMOVE from the existing meeting. Owner-path: any. Colleague-path: whoever REQUESTED this specific meeting can remove others on it — per-meeting, not a blanket colleague permission. A colleague who is NOT the requester is refused (`colleague_not_requester`) and routed to the owner\'s approval instead.',
              items: { type: 'string' },
            },
          },
          required: ['meeting_id', 'meeting_subject'],
        },
      },
      {
        name: 'delete_meeting',
        description: `Cancel and permanently delete a meeting. Ask the user to confirm first; only call after explicit yes. If he gives a note to send along with the decline/cancellation (e.g. "decline and write Yom Kippur"), pass it as comment — Outlook delivers it to the organizer (decline) or attendees (cancel).`,
        input_schema: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            meeting_subject: { type: 'string' },
            comment: { type: 'string', description: 'OPTIONAL. A note to send with the decline/cancellation, when the owner gives one. Delivered by Outlook to the organizer (if declining as attendee) or to attendees (if cancelling as organizer). Omit if he gave none.' },
          },
          required: ['meeting_id', 'meeting_subject'],
        },
      },
      {
        name: 'hold_slot',
        description: `Tentatively HOLD a slot someone picked but hasn't confirmed — or that ${profile.user.name.split(' ')[0]} explicitly parks — so a SECOND person asking that time hears "tentatively held" instead of "free". Internal state only; never a calendar event. Auto-expires at the slot's start OR 2 ${profile.user.name.split(' ')[0]}-workdays (whichever first), DMing the holder it was freed.

WHEN TO HOLD (action='hold'): a colleague was offered slots and picks ONE but DEFERS confirmation — "slot 1 works, let me check with my team", "20:30 טוב, רק אבדוק עם דנה". NOT on a clean yes (that books — call create_meeting). NOT at offer time (offers stay open). NOT on a vague "these all look ok" (no specific slot picked). ${profile.user.name.split(' ')[0]} can also park one explicitly ("hold Tue 14:00 for Yael until Thursday").
RELEASE (action='release'): the holder confirms (then book it), declines, or re-picks a different time; or ${profile.user.name.split(' ')[0]} cancels a hold.
Colleague-path: a colleague can only hold/release a time that WAS offered to them in THIS conversation (validated against the offered set), max 3 active holds; a new pick in the same thread replaces the old one. Owner-path: any slot, any holder, no limit.`,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['hold', 'release'] },
            start_iso: { type: 'string', description: 'ISO start of the slot. Required for hold; for release it identifies which hold.' },
            end_iso: { type: 'string', description: 'ISO end. Required for hold.' },
            holder_name: { type: 'string', description: 'Who the hold is for. Owner-path: name the person ("Yael"). Colleague-path: defaults to the requester — omit.' },
            holder_slack_id: { type: 'string', description: 'OPTIONAL slack id of the holder (owner-path, when known).' },
            subject: { type: 'string', description: 'OPTIONAL — what the hold is for ("Simon 1:1").' },
            reason: { type: 'string', description: 'OPTIONAL — why it is held ("verifying with her team").' },
            hold_id: { type: 'string', description: 'OPTIONAL — for release, the specific hold id if you have it.' },
          },
          required: ['action'],
        },
      },
    ];
  }

  /**
   * Every meeting tool the model can call arrives here, including the ones
   * this class delegates to SchedulingSkill, so an unreadable owner calendar
   * becomes ONE written refusal instead of a raw Graph string no handler owns.
   * P24 — the refusal itself moved to `meetings/calendarOffline` so the
   * calendar-health dispatcher rides the same one (it reaches the same reads);
   * that file carries the full note.
   */
  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    return withCalendarOfflineRefusal(toolName, context, () =>
      this.dispatchToolCall(toolName, args, context));
  }

  private async dispatchToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const { profile, channelId, threadTs } = context;

    switch (toolName) {

      // v2.6.4 — find_slack_user case removed. The tool now lives on
      // SlackConnection (src/connections/slack/index.ts). Sonnet still calls
      // it the same way; the registry routes it to the Connection automatically.

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

        // v4.1.x (M10) — this tool exists for COLLEAGUE asks, so every subject it
        // echoes back is masked unless the owner himself is asking in his own DM.
        const joinViewer = subjectViewerFor(context);
        // v4.4.9 (#154) — the attendee-aware half of that same mask: the
        // colleague asking to join is very often NOT on whatever owns the
        // slot, so that event's subject must stay masked whether or not it's
        // privacy-flagged.
        // gh#154-W5/gh#154-R4 (2026-08-06) — the room-vs-DM tightening now lives inside
        // viewerEmailFor itself (surface==='room' → null); call it directly.
        // A blanket `?? null` here also flattened the EMAIL leg's correct
        // `undefined` into `null`, masking every forwarded subject instead of
        // only private ones — see viewerEmailFor's doc comment.
        const joinViewerEmail = viewerEmailFor(context);

        // Fetch owner's calendar. Category rules count per-day AND per-ISO-week,
        // and the focus-time floor is measured across the day, so the validator
        // needs the whole WEEK — a single-day fetch made every weekly cap read 0.
        //
        // Through the shared owner-event read (one retry, then a typed
        // offline error). This tool answers "can he join?" straight from these
        // events, so a failed read is the same blind spot the search and write
        // paths have; the local catch used to answer `Could not check calendar.`,
        // a mechanical non-answer that told the colleague nothing about whether
        // the problem was him, his day, or Maelle (M9).
        const events = await getOwnerEventsForDecision(
          userEmail,
          startDt.startOf('week').toFormat('yyyy-MM-dd'),
          startDt.endOf('week').toFormat('yyyy-MM-dd'),
          timezone,
        );

        const meetingStartMs = startDt.toMillis();
        const meetingEndMs = endDt.toMillis();

        // Parse event times helper
        const evTime = (dt: { dateTime: string; timeZone: string }) =>
          DateTime.fromISO(dt.dateTime.replace(/\.\d+$/, ''), { zone: dt.timeZone || timezone });

        // Floating-block definitions. Hoisted above the occupancy scan below,
        // which needs them to skip elastic blocks exactly as the validator does.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fb = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
        const floatingBlocks = fb.getFloatingBlocks(profile);

        // ── THE validator (M1) ────────────────────────────────────────────────
        // v4.1.x — this handler used to be a complete SECOND rule engine: its own
        // overlap math, its own buffer arithmetic (re-applying the between-meeting
        // buffer as a widening conflict window — the exact `owner_buffer_collision`
        // rule checkSlot deleted in v2.7.1), its own floating-block feasibility,
        // and NO work-hours, NO category caps and NO focus-time floor at all. So a
        // 21:00 ask answered "he's free at that time" on a slot both
        // find_available_slots and create_meeting refuse, and a timed
        // Working-Elsewhere optional-join counted as a hard conflict on a slot the
        // search actively offers. Offer-then-retract, in both directions.
        // Now the verdict comes from the ONE validator. What stays local is
        // join-SPECIFIC presentation only: the partial-join window and the
        // in-turn block move.
        //
        // NO `leadTimeHours` here, deliberately. The booking lead time is a
        // WRITE-path rule — "how much notice before Maelle puts a NEW commitment
        // on his calendar" — and this tool writes nothing (see the _note on every
        // return: the colleague forwards their own invite). Passing it made every
        // same-day "can Idan join our 3pm?" fail rule 0b on `within_lead_time`,
        // i.e. a notice period applied to a presence question about a meeting
        // that already exists. Worse, the refusal dead-ended: `needs_approval`
        // steers the model to create_approval, which now requires a
        // `_deferred_action_hint` this read-only tool has no business emitting,
        // and whose refusal text points at create_meeting — a colleague-allowed
        // tool that would have booked a DUPLICATE of the colleague's own meeting.
        const joinCheck = checkSlot({
          profile,
          slotStartIso: startDt.toISO()!,
          slotEndIso: endDt.toISO()!,
          category: null,   // joining someone else's meeting — no category is being created
          events,
          viewer: joinViewer,
          viewerEmail: joinViewerEmail,
        });
        // The TIMED overlaps, for the partial-join carve below. Classified by the
        // validator's OWN predicate (occupancyRoleOf) rather than a local copy of
        // the skip list — free-shows don't collide, a TIMED workingElsewhere event
        // is an optional join, a floating block is elastic (it slides, and
        // `pendingBlockMoves` below is what slides it). All-day blocks are
        // deliberately excluded HERE and only here: they are real commitments (the
        // validator reports them on `overCommitment`), but they have no clock
        // window to carve a "he could join the first 20 minutes" out of.
        const directConflicts = events.filter(ev => {
          if (ev.isAllDay) return false;
          if (occupancyRoleOf(ev, floatingBlocks) !== 'commitment') return false;
          const s = evTime(ev.start).toMillis();
          const e = evTime(ev.end).toMillis();
          return s < meetingEndMs && e > meetingStartMs;
        });
        // Is he actually committed? ONE source: the validator's OCCUPANCY, not
        // its violation. `overCommitment` comes from an unconditional scan ahead
        // of the rule ladder, so it is present whenever a real commitment holds
        // the slot — including on the `in_the_past` verdict — no matter which
        // rule reported. Keying this on `violation_kind === 'owner_busy_collision'`
        // was the bug: an all-day OOF on a Thursday evening tripped work-hours
        // (rule 5) first, occupancy was never computed, and the colleague was
        // told "his calendar is clear."
        // `directConflicts` is NOT ORed in: it is a strict subset of what the
        // scan sees (timed commitments only, same overlap math, same predicate,
        // no exclude list on either side), so it can never be non-empty while
        // `overCommitment` is undefined. Keeping it in the condition would be a
        // second opinion that can only ever agree — the shape this handler is
        // being taken OUT of (M1). It still earns its place below as the
        // partial-join carve data, which needs every overlapping event's own
        // bounds; `overCommitment` reports only the first one.
        const ownerIsBusy = !!joinCheck.overCommitment;

        // v2.1 — floating blocks that apply on this day.
        // v4.1.x (M1) — the FEASIBILITY VERDICT ("is there still room for lunch
        // after this?") is no longer decided here: that is checkSlot rule 6, and
        // this handler's private copy could disagree with it. What this pass now
        // produces is join-SPECIFIC and exists nowhere else: WHICH block event
        // has to physically shift, and to where, so active mode can move it in
        // the same turn.
        const joinDayName = DateTime.fromISO(dayStr, { zone: timezone }).toFormat('EEEE');
        // v3.0.2 — floating-block math is buffer-free; meeting durations carry the spacing.
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
              { subject: evt.subject, categories: evt.categories },
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
            block, dayStr, timezone, busyInWindow,
          );
          if (aligned !== null) {
            // Block fits — does its CURRENT event overlap the proposed
            // meeting? If so, record a pending move. Bound to THIS day's block
            // window: `events` now spans the whole week (the validator needs it
            // for per-week category caps + the day's focus floor), so an
            // unbounded find would return another day's lunch and silently skip
            // the real one.
            const existingBlockEvent = events.find(e => {
              if (e.isCancelled || e.isAllDay || e.showAs === 'free') return false;
              if (!fb.isFloatingBlockEvent(
                { subject: e.subject, categories: e.categories },
                block,
              )) return false;
              return evTime(e.start).toMillis() < wEnd && evTime(e.end).toMillis() > wStart;
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

        // ── Free (per THE validator) ────────────────────────────────────────────
        // v3.3.7 (#124a) — buffer-only collisions FALL THROUGH to "free". The
        // owner's 5-min buffer is carried by the meeting LENGTHS
        // (allowed_durations 10/25/40/55 end short of the grid) — it is not a
        // standalone rule, and it must never escalate on its own. v4.1.x — that
        // is now structural rather than a local carve-out: the widening buffer
        // window this handler used to apply is simply gone, and the verdict is
        // checkSlot's, which has no buffer-collision rule (deleted v2.7.1).
        if (joinCheck.passes) {
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
          // M2 — "free" can still mean "free over an optional-join event". Say so
          // rather than presenting it as a clean slot; the validator already
          // masked the subject for this caller.
          const optionalLine = joinCheck.overOptional
            ? ` (He has an optional "${joinCheck.overOptional}" then — he joins that only if free, so it's no obstacle.)`
            : '';
          return {
            can_join: true,
            time: timeStr,
            duration_min: durationMin,
            subject,
            blocks_moved: movesDone.length > 0 ? movesDone : undefined,
            over_optional: joinCheck.overOptional,
            message: `${ownerFirst} is free at that time.${movesLine}${optionalLine} Tell ${requesterName} to forward the calendar invite.`,
            _note: 'Do NOT book anything on the calendar. Just tell the colleague to forward the invite.',
          };
        }

        // ── He is committed ─────────────────────────────────────────────────────
        // Occupancy is answered BEFORE the rule ladder — inside checkSlot now, so
        // this handler is no longer a second validator that could disagree with
        // the booking path (M1). What stays local is join-SPECIFIC presentation
        // the validator has no reason to produce: the PARTIAL-join window, which
        // needs every overlapping event and their individual bounds
        // (`overCommitment` reports only the first one, plus its subject/window).
        if (ownerIsBusy && directConflicts.length > 0) {
          const busyInMeeting = directConflicts.map(ev => {
            // private-mask-leaks-in-join-check-reply — `displaySubject` returns
            // the literal PRIVATE_MASK string ("[Private]") for a private event
            // to a non-owner viewer; that string is truthy, so `|| 'a meeting'`
            // never caught it and the raw mask word reached a colleague's reply
            // (M10: a colleague gets free/busy only for a private meeting, not
            // even the fact that it's flagged private). Same fallback fix as
            // scheduleRules.ts's overOptional/overCommitment subjects.
            const subj = displaySubject(ev, profile, joinViewer, joinViewerEmail);
            return {
              start: Math.max(evTime(ev.start).toMillis(), meetingStartMs),
              end: Math.min(evTime(ev.end).toMillis(), meetingEndMs),
              subject: (subj && subj !== PRIVATE_MASK) ? subj : 'a meeting',
            };
          }).sort((a, b) => a.start - b.start);

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

          // Fully blocked by another meeting. Subjects are viewer-scoped: in
          // a colleague's own 1:1 DM, a normal meeting they're confirmed on
          // shows its real subject; anything they're not confirmed on, or
          // ANY meeting mentioned in a room (unbounded audience — gh#154-R4,
          // 2026-08-06), reads "[Private]"/"a meeting" instead — never the
          // real title for someone who isn't verifiably the sole reader (M10).
          const conflictNames = directConflicts.map(ev => {
            const subj = displaySubject(ev, profile, joinViewer, joinViewerEmail);
            return (subj && subj !== PRIVATE_MASK) ? subj : 'a meeting';
          });
          return {
            can_join: false,
            reason: 'busy',
            time: timeStr,
            subject,
            conflict_with: directConflicts.map((ev, i) =>
              `"${conflictNames[i]}" (${evTime(ev.start).toFormat('HH:mm')}–${evTime(ev.end).toFormat('HH:mm')})`
            ).join(', '),
            message: `${ownerFirst} has a conflict at that time: ${conflictNames.join(', ')}.`,
          };
        }
        if (ownerIsBusy) {
          // The validator saw a commitment the timed-overlap scan cannot: an
          // all-day busy / OOF block. No partial window to carve out of it — just
          // the honest "he's committed". Built from `overCommitment` rather than
          // `violation_label`, because the label belongs to whichever rule
          // reported and that is not always this one (a past all-day slot reports
          // "that time has already passed", which is not the answer to "is he
          // free?"). Subject is viewer-scoped by the validator (M10).
          const held = joinCheck.overCommitment;
          return {
            can_join: false,
            reason: 'busy',
            time: timeStr,
            subject,
            conflict_with: held?.subject,
            // An all-day OOF is not "he has something at that time", it is
            // "he is away that day". The old wording invited the obvious next
            // question ("could he do 30 min later?"), which has the same answer
            // for every hour of the day. gh#200 — when the span reaches past
            // this one day, name its real end so a colleague asking about
            // several different days inside the same known period is told the
            // whole window once instead of a fresh day-scoped "away that whole
            // day" every time.
            message: held?.allDayOutOfOffice
              ? held.allDayOutOfOfficeUntilDisplay
                ? `${ownerFirst} is away through ${held.allDayOutOfOfficeUntilDisplay} ("${held.subject}") — not just today, so a different day inside that window won't help either. Offer a day after that.`
                : `${ownerFirst} is out of office that whole day ("${held.subject}") — not just at that time, so a different hour on the same day won't help either. Offer another day.`
              : held
                ? `${ownerFirst} has "${held.subject}" on his calendar at that time.`
                : `${ownerFirst} has something on his calendar at that time.`,
          };
        }

        // ── Calendar clear, but a rule of his stands in the way ─────────────────
        // Reached ONLY when nothing occupies the slot: the validator's scan is
        // unconditional and ranks a real commitment above every soft rule, and
        // the timed scan above agrees — so the "clear at that time" claim below
        // is true by construction. Pre-rewrite this branch was reachable only for an
        // unsatisfiable floating block; it now covers every owner rule the
        // booking path enforces — work hours, category caps, the free-time floor,
        // travel buffer — so a 21:00 ask no longer answers "he's free at that
        // time" and then fail at booking.
        // Deliberately NOT the booking lead time: that is a write-path rule and
        // this tool writes nothing (see the checkSlot call above).
        // M9 — the reason travels in human terms (checkSlot's own label), so the
        // colleague can understand it and, if it matters, trigger an approval.
        const joinViolation = joinCheck.violation_label ?? 'one of his scheduling rules';
        return {
          can_join: 'needs_approval',
          time: timeStr,
          duration_min: durationMin,
          subject,
          reason,
          requester_name: requesterName,
          violations: [joinViolation],
          broken_rule: joinCheck.violation_kind,
          message: `${ownerFirst}'s calendar is clear at that time, but joining would break one of his own rules: ${joinViolation}. Ask ${ownerFirst} — explain what "${subject}" is about${reason ? ` (${reason})` : ''} and what it would cost him. If approved, tell ${requesterName} to forward the invite.`,
          _note: 'Escalate to the owner in their DM thread via create_approval(kind=policy_exception). To the colleague, give the reason in plain human terms — never the rule name. If the owner approves, tell the colleague to forward the invite. Do NOT book.',
        };
      }

      // ── Direct calendar ops (delegated to the former SchedulingSkill) ────
      case 'get_calendar':
      case 'analyze_calendar':
      case 'get_free_busy':
      case 'find_available_slots':
      case 'create_meeting':
      case 'move_meeting':
      case 'update_meeting':
      case 'delete_meeting':
      case 'hold_slot':
      case 'revert_last_auto_move':
      case 'set_work_schedule_override':
      case 'get_work_schedule_overrides':
        return await this.ops.executeToolCall(toolName, args, context);

      default:
        return null;
    }
  }

  getSystemPromptSection(profile: UserProfile, scopes?: string[], isOwner?: boolean, channel?: ChannelId): string {
    // gh#24 row 143 — CHANNEL-clamp-aware prose gating for this ~400-line
    // block. Fixed to senderRole 'owner' + scopes=undefined so the ONLY
    // variable that can flip a `ships()` gate below is the channel's tool
    // clamp (CHANNEL_TOOL_CLAMP — today: email's find_available_slots /
    // create_meeting / get_person_memory / log_interaction allowlist), never
    // scope-narrowing (already handled by the coarse skill-level
    // reachability gate in systemPrompt.ts) and never role. 'slack' has no
    // clamp entry, so every gate below is true there — this section renders
    // BYTE-IDENTICAL to pre-fix for every Slack turn, owner or colleague, any
    // scope. On a clamped channel, paragraphs that teach a tool this turn
    // can't call (move/delete/update/hold/check-join/analyze/schedule-
    // overrides/create_approval) drop out — closing the leak surface report
    // row 143 named: internal scheduling jargon on the one leg whose reply
    // eventually reaches an outsider.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSkillTools } = require('./registry') as typeof import('./registry');
    const channelShipped = new Set(getSkillTools(profile, 'owner', undefined, channel).map(t => t.name));
    const ships = (name: string) => channelShipped.has(name);
    // A handful of paragraphs are about SLACK conversation mechanics that
    // have no equivalent on another channel at all (MPIM, channel threads,
    // @-mentions, "reply directly to the colleague" over a Slack DM) — not
    // about a specific tool the clamp removed. Gate those on the channel
    // itself rather than inventing a tool name to hang them on.
    const isSlackNative = (channel ?? 'slack') === 'slack';
    const officeDays = profile.schedule.office_days.days.join(', ');
    const homeDays = profile.schedule.home_days.days.join(', ');
    const firstName = profile.user.name.split(' ')[0];
    // v2.8.1 — render per-day work hours from the canonical work_hours map.
    // For the prompt section we summarize as "first window's start–last window's end"
    // for each day-type group (office vs home). Multi-window days display all ranges.
    const formatHours = (days: string[]): string => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getOwnerWorkHoursForDay, formatMinuteOfDay } = require('../utils/workHours') as
        typeof import('../utils/workHours');
      // Pick the FIRST day in the group as representative; if the group has
      // mixed hours across days, also show them per-day below.
      if (days.length === 0) return '(no hours)';
      const perDay = new Map<string, string>();
      for (const d of days) {
        const wins = getOwnerWorkHoursForDay(profile, d);
        const fmt = wins.length === 0
          ? '(no hours)'
          : wins.map(w => `${formatMinuteOfDay(w.startMin)}–${formatMinuteOfDay(w.endMin)}`).join(', ');
        perDay.set(d, fmt);
      }
      const uniqueRanges = new Set(perDay.values());
      if (uniqueRanges.size === 1) return [...uniqueRanges][0];
      // Mixed — show per-day
      return [...perDay.entries()].map(([d, r]) => `${d.slice(0, 3)} ${r}`).join(', ');
    };
    const officeHours = formatHours(profile.schedule.office_days.days);
    const homeHours = formatHours(profile.schedule.home_days.days);
    // Enumerate all floating blocks (lunch / coffee / gym / prayer / etc) with
    // their day-scope so the prompt describes reality.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fb = require('../utils/floatingBlocks') as typeof import('../utils/floatingBlocks');
    const blocks = fb.getFloatingBlocks(profile);
    const blocksLine = blocks.map(b => {
      const dayScope = b.days && b.days.length > 0 ? b.days.join('/') : 'every work day';
      return `${b.name} (${b.preferred_start}–${b.preferred_end}, ${b.duration_minutes} min, ${dayScope}${b.can_skip ? ', can skip' : ', must fit'})`;
    }).join(' · ');

    // v2.6 — categories with rules. Yaml ORDER is priority — first match wins.
    // Pure data render — agnostic to category names. When a profile has no
    // categories the block disappears entirely (no awkward empty section).
    //
    // v3.x (Block 3 prompt reduction) — render only the FIRST SENTENCE of each
    // description as a cue, not the full multi-sentence text. The authoritative
    // classifier is the `detectCategory` sidecar (src/skills/meetings/
    // detectCategory.ts), which builds its OWN block from the full yaml
    // `c.description` and runs on every booking/move — so the main prompt's
    // copy was redundant for classification. Here it only needs to support
    // narration ("that's an interview, capped at 2/day") and the rare manual
    // set_event_category tag. ~1k tokens saved off every owner turn.
    const categoriesBlock = (() => {
      const cats = profile.categories ?? [];
      if (cats.length === 0) return '';
      const lines = cats.map((c, idx) => {
        const parts: string[] = [];
        if (c.limits?.per_day !== undefined) parts.push(`max ${c.limits.per_day}/day`);
        if (c.limits?.per_week !== undefined) parts.push(`max ${c.limits.per_week}/week`);
        if (c.day_type === 'office_days') parts.push('office days only');
        if (c.day_type === 'home_days') parts.push('home days only');
        if (c.requires_travel_buffer) parts.push('auto travel buffer');
        // v2.8.6 — surface `is_recurring: true` as a bracket tag so the
        // qualification rule shows up next to the description, not buried in
        // 5 lines of prose. Closes the 2026-05-18 "suggested Cadence for a
        // one-time Company lecture" — Cadence is `is_recurring: true` in
        // yaml + the description spells out a strict-recurring rule, but
        // pre-fix only the prose carried it and Sonnet missed it.
        if (c.is_recurring) parts.push('recurring series only');
        // v2.8.2 — category-level location overrides (default_location /
        // default_is_online / no_default_location) no longer affect the
        // location decision; location is deterministic via day-type + party
        // shape. Don't render those fields here either.
        const rules = parts.length > 0 ? ` [${parts.join(', ')}]` : '';
        // First sentence only — the full description lives in detectCategory.
        const cue = c.description.replace(/\s+/g, ' ').trim().split(/(?<=\.)\s+/)[0];
        // v3.1.6 — compact title convention (e.g. Interview → "Interview with
        // <first name>, role in body"), so trimming the description to one
        // sentence doesn't drop the SUBJECT-composition rule for the booking model.
        const titleHint = c.title_hint ? ` · title: ${c.title_hint}` : '';
        return `  ${idx + 1}. ${c.name} — ${cue}${rules}${titleHint}`;
      }).join('\n');
      return `

CATEGORIES (ordered by priority — first match wins; list reflects yaml order, owner-curated):
${lines}

CATEGORY DETECTION + PRIORITY:
- When booking or proposing a slot, pick the category by walking this list TOP-DOWN and taking the FIRST match. Earlier in the list = higher priority. If a meeting fits both "Outside meeting" and "Interview", and "Outside meeting" appears first, "Outside meeting" wins because it's the more restrictive/specific rule the owner ordered first.
- Use the description text to decide what fits. Cues in the colleague/owner message (venue, attendee role, "interview", "candidate", "coffee at X", external attendee, etc.) drive the match.
- A meeting with no clear category fits the generic fallback (typically "Meeting" — the last one).

ALWAYS PASS CATEGORY to slot tools:
- When you have any category context (interview, customer visit, focus block, etc.), pass \`category\` to \`find_available_slots\`, \`create_meeting\`, and \`move_meeting\`. Otherwise the slot finder ignores the category's per_day / per_week / day_type rules and you may propose a time that violates them.
- Owner asking "when am I free?" with no specific meeting — fine to omit \`category\` (today's behavior, no enforcement).
- Once the category is decided, it stays the same across find_available_slots → create_meeting in the same turn. Don't switch mid-flow.

LOCATION (v2.8.2) — deterministic, decided by \`resolveLocation\`. You do NOT compute it. Pass \`location\` / \`is_online\` only when ${firstName} explicitly states one.
CATEGORY-DRIVEN SKIPS:
- Categories flagged \`no_default_location\` (e.g. Logistic — floating blocks, focus time, lunch) → tool stamps NO location. You don't need to ask; these are personal time-on-calendar with no place to be.
- Categories flagged \`sets_sensitivity_private\` (e.g. Private — personal/family events) → tool stamps NO location. ASK ${firstName} where the event should be ("Where should this private event be?") UNLESS he already told you. Don't auto-default to Teams or Office for Private events.
If the tool returns \`error: 'location_mode_unspecified'\` (+ \`suggested_ask_text\`), ask ${firstName} online vs physical, then re-call with \`is_online=true\` OR \`location=<office address>\`. NEVER guess.
${ships('analyze_calendar') ? `CALENDAR OVERVIEW / SUMMARY — route issue detection through \`analyze_calendar\` (v2.7.1).
When ${firstName} asks a multi-day summary question ("how's my calendar?", "anything broken next week?", "what's my week look like?"), you may use \`get_calendar\` to list events plainly, but ANY issue you flag (overlap, no-lunch, OOF conflict, back-to-back, category limit, etc.) MUST come from a \`analyze_calendar\` call over the same range. Don't eyeball overlaps from get_calendar results and write your own "⚠ Overlap: ...". The analyzer returns issues with stable \`issue_id\`s — surface them by id so ${firstName}'s replies stick:
- ${firstName} says "don't worry about that one" / "I'm ok with it" / "leave it" → call \`manage_calendar_issue(action='update', event_date, issue_type, detail, status='dismissed')\`. Future overviews skip it.
- The issue resolves via a move/delete in the same conversation → the meeting mutation's cascade closes it automatically (no manual call needed).
- If a flag isn't in analyze_calendar's output, DON'T flag it. The analyzer's silence is the source of truth.

` : ''}${ships('create_approval') ? `RULE-COMPLIANCE REFUSAL — paste the tool's broken_rule_label, never invent a reason (v2.6.1):
- Colleague-path \`create_meeting\` / \`move_meeting\` runs a server-side rule check (work hours, work days, lunch / floating-blocks, focus-time, busy collisions, category day_type / per_day / per_week limits). On refusal the tool result includes \`broken_rule_label\` — pass it to \`create_approval(kind=policy_exception).ask_text\` (moves and attendee-changes use policy_exception too) for the OWNER side. The ask_text the OWNER reads should name the rule plainly — paste \`broken_rule_label\` verbatim, don't fall back to a vague "needs your go-ahead" without naming it. The reply the COLLEAGUE gets stays high-level (see AUDIENCE-AWARE REASONING below).
- If \`broken_rule_label\` is "unknown" (rare — the diagnostics didn't surface a single rule), say so honestly: "I can't tell exactly which of his rules flagged this slot. Want me to escalate so he can decide?" — NEVER guess a rule. Pre-v2.6.1 Sonnet would invent reasons like "5-min buffer too tight" when the tool gave her nothing; that's the failure mode this rule prevents.
- Owner-path: brief and calendar-health surface violations after the fact — no booking-time block. Owner is trusted at booking time; he'll see "you have 3 interviews today, 1 over your limit" in the next brief / calendar-health pass.

` : ''}AUDIENCE-AWARE REASONING — what you SAY depends on WHO you're speaking to.
- To ${firstName}: name the actual rule / window / conflict in plain words. He owns his schedule and he wants the detail. "Thursday has no clean 55-min slot inside your office hours — you're booked solid 10:45 → 17:00. After 17:00 lands right when the Board ends; want me to book past your usual finish line, or push to a different day?" Detail OK; override path offered.
- To colleagues: keep it HIGH LEVEL. Never expose the mechanics — no "his lunch window", no "5-min buffer", no "focus-time protection", no "per-day category limit", no "he can't be in two places". Just "${firstName} can't make that work" / "he's tied up then" / "his Thursday is packed — what about Friday?". Colleagues don't need to know which internal rule fired — they only need a workable alternative or a polite "no". If they push for a reason, "he's locked in around that time" is enough.
- Same principle for any "why no slot here?" — owner gets the why, colleagues get the verdict + an alternative.

ZERO STRICT SLOTS / "NOT AVAILABLE" — name the real blocker EXACTLY; NEVER say "something's blocking" or "one of your calendars." The result tells you precisely what — read it and say it. For a 0-slot DAY read \`day_summary.top_reasons\`; for a specific slot read its \`broken_rule_label\` / \`attendee_status\`. Attribute correctly: \`owner_busy\` = ${firstName}'s OWN calendar ("your Monday's packed" — NEVER "she's booked" when it's owner_busy); a named attendee / \`attendee_busy\` = THAT person's calendar ("12:30 — you're free; it's Dina's calendar that's blocked then"); \`focus_time\` / \`lunch\` / \`work_hours\` = one of HIS soft rules — name which, and if it's the ONLY blocker, offer to override; do NOT report a soft rule as "no availability." Then offer the relaxed override slots labeled by EACH slot's real \`broken_rule_label\`, not one blanket reason — e.g. "09:00 is before your 10:30 start" and "13:00 sits in your focus block", not "both eat into focus time".
OWNER FREE, REQUESTER BUSY (colleague-requested meeting → \`attendee_status\` tagged on owner-free slots): that is NOT "no availability" — propose it and have the requester flex: "12:30 works for you — you've got something then, want me to ask Dina to move it?" NEVER bounce "when are you free?" back to the requester who asked; ${firstName}'s calendar is the constraint to solve, not theirs.
A RETURNED SLOT WITH NO CONFLICT TAG IS VERIFIED FREE — for ${firstName} AND every attendee you passed. find_available_slots already ran everyone's availability + busy check; a slot comes back only if it's clean, OR carrying an explicit \`attendee_status\` or \`attendee_conflicts\` conflict tag (the OWNER FREE, REQUESTER BUSY case just above, and the off-hours/relaxed-recovery case). So NEVER tell the requester an attendee "shows busy" at an UNTAGGED returned slot — that contradicts the verification and yields the self-contradictory "clean for both, but X is busy." No tag = clean for everyone you passed; say so plainly.

OWNER-PATH OVERRIDE — surface, ask in-thread, retry in-thread. NEVER a separate approval DM.
When ${firstName} explicitly asks for something that would violate a soft rule (category limit, focus time, lunch window, day type, working hours, attendee busy), OFFER the override in the same reply alongside the alternatives. His "yes / book it / do it anyway" IS the approval — retry the same tool with \`relaxed: true\` (find_available_slots / create_meeting / move_meeting all accept it). DO NOT call \`create_approval\` on owner-path. The conversational ask in this thread already gave him the decision; routing it through a separate DM approval flow is redundant and stalls the action.
✅ "You're at 2 interviews tomorrow already, or shift to Thursday 10:30 — your call." → he says "do it" → call \`create_meeting(relaxed=true)\`.
✅ "Anna is on another call at 17:00 — book over, or pick a different time?" → he says "book over" → call \`move_meeting(relaxed=true)\`.
❌ He says "book it" → you call \`create_approval(kind=policy_exception)\` → owner gets a separate DM to approve his own ask he just confirmed in the thread.
❌ He says "do it" → you re-call without \`relaxed\`, hit the same rule, refuse again.
\`create_approval(kind=policy_exception)\` is COLLEAGUE-PATH only — when a colleague is requesting something that needs ${firstName}'s sign-off in his own DM.

NO WORKING-HOURS PREAMBLE when asking about time.
When asking ${firstName} or a colleague "what time?" for a booking, JUST ASK. Don't preface with "(Office hours Wednesday are 10:30–19:00.)" or any equivalent recitation of his own hours back at him — he knows his schedule. Working-hours mentions belong in REJECTION explanations ("3:30 is past your hours, want 14:30 instead?"), not in clarifying questions before any slot has been searched.`;
    })();

    return `
MEETINGS SKILL
Everything about booking meetings — direct calendar operations — lives here. This is the only skill that touches the calendar.

${isOwner === false
  ? `${firstName.toUpperCase()}'S SCHEDULE IS PRIVATE — you do NOT see or narrate his work hours, days, night-shift, lunch, or focus windows to a colleague. find_available_slots enforces all of it (hours, days, buffers, floating blocks, free-time) server-side — propose only the times the tool returns, and never explain his schedule.`
  : `${firstName.toUpperCase()}'S SCHEDULE — these are HARD RULES. Proposing a time outside them is a scheduling error you must flag explicitly.
- Office days: ${officeDays} · ${officeHours}
- Home days: ${homeDays} · ${homeHours}
- Days not listed above are days OFF. Never propose work meetings on those days.
- Floating blocks (elastic within their window): ${blocksLine || 'none configured'}.
- Buffer between meetings: the allowed durations (${profile.meetings.allowed_durations.join(' / ')} min) ALREADY bake in ${profile.meetings.buffer_minutes} min of trailing buffer by design — a 55-min meeting at 17:00 ends 17:55, leaving 5 min before 18:00 automatically. You do NOT need to add another 5-min gap BEFORE a new meeting. If a previous meeting ends at 17:00, a new meeting can start at 17:00 (connected) — that is fine and preferred. You may offer 17:15 as an alternative if ${firstName} wants a gap.

${firstName.toUpperCase()}'S SCHEDULING PREFERENCES — soft guidance, NOT hard rules. Use judgment when proposing slots.
${(() => {
  const tp = profile.schedule.timezone_preferences;
  const ns = profile.schedule.night_shift;
  const lines: string[] = [];
  if (tp) {
    lines.push(`- When everyone is in ${firstName}'s own timezone (${profile.user.timezone}): lean toward ${tp.local_participants}.`);
    lines.push(`- When ANY attendee is in a DIFFERENT timezone from ${firstName}: lean toward ${tp.remote_participants} ${firstName}'s time — it overlaps better with their working day.`);
    if (tp.note) lines.push(`- Note from ${firstName}: "${tp.note}"`);
  }
  if (ns) {
    lines.push(`- Night-shift window: ${ns.hours_start}–${ns.hours_end} — ${firstName}'s standard late work time${ns.typical_day ? ` on ${ns.typical_day}` : ''} (already merged into work_hours). Also useful for overlap with attendees whose working day begins as ${firstName}'s is ending, when he offers it.`);
  }
  lines.push('');
  lines.push('How to apply these:');
  lines.push(`- find_available_slots ALREADY clips candidates to the intersection of everyone's working hours — each attendee's own timezone + work hours (from their saved profile) are honored automatically. The workable cross-timezone overlap is computed for you: do NOT pick a magic hour or reason about specific countries/regions. Just run the search; the tool returns the times that actually overlap.`);
  lines.push(`- A cross-timezone overlap is NORMAL EA work — NEVER ask ${firstName} permission for it. "OK booking on EST time?" / "can you take a late slot in that range?" are nonsense to him; his own afternoon or evening isn't a favour to grant. Compute the overlap, propose the concrete slots, and let him say if a specific one doesn't work.`);
  if (tp) lines.push(`- Within that overlap, lean toward the preference above (same-timezone → ${tp.local_participants}; cross-timezone → ${tp.remote_participants}).`);
  lines.push(`- These are PREFERENCES not rules — if nothing in the preferred window works, propose outside it and NARRATE the trade-off (*"Nothing in your usual window; best I have is Wed 11:30"*). Never refuse on a soft preference alone.`);
  lines.push(`- ${firstName} can override any of these at any time with \`relaxed:true\`: it bends the rules about his own day, and each slot it returns carries the \`broken_rule_label\` it bends. A proposal is still a time he is free — he books over a commitment by naming it to \`create_meeting\`.`);
  return lines.join('\n');
})()}`}${categoriesBlock}

FLOATING BLOCKS (any profile-defined block: lunch, coffee, gym, prayer, etc.): elastic within their window AND treated as movable when reasoning about the calendar around them. They're not fixed walls — they bend to make room.
- VOCABULARY: "floating block" / "floating object" / "buffer" / "block event" / "elastic window" are YOUR internal/tool words — NEVER say them to ${firstName} (a human EA never would). To him it's just "your lunch" / "your lunch break" / "the focus time you keep open." Narrate the human outcome — "I shifted your lunch to 12:00 to make room" — never the mechanism ("I moved the floating block").
${ships('move_meeting') ? `- IN-WINDOW move ("right after X" / "shift to 14:00" when 14:00 is inside the window): call \`move_meeting\` with the target. Handler does window/buffer/alignment math. Don't compute the slot yourself, don't ask permission.
- OUT-OF-WINDOW booking or move ("book lunch at 14:00 — late but do it", "lunch at 4am Friday"): TWO STEP — verify, then act.
  Step 1: flag the cost back to ${firstName} explicitly. "Lunch at 4am Friday is way outside your usual 11:30–13:30 window — you sure?" / "14:00 is past your lunch window, want to do it anyway?". You're his EA — surface the unusual, don't silently execute it.
  Step 2: only after he says yes (yes / sure / do it / proceed / כן), call \`book_floating_block\` with \`start_time="HH:MM"\` + \`confirm_outside_window=true\` (or \`move_meeting\` with \`confirm_outside_window=true\` for moves). The flag IS the approval — no separate policy_exception needed.
  Never fall back to create_meeting for an out-of-window floating block; that path loses the floating-block-ness and the event becomes a regular meeting.
` : ''}- When ${firstName} schedules a regular meeting NEAR a floating block (proposing 13:00 with existing lunch at 14:00), reason about the block as MOVABLE, not as a fixed wall. The slot finder already treats it that way; trust the tool. Don't say "tight, only 20 min before lunch" — lunch will move.

SLOT START TIMES — propose times on the :00/:15/:30/:45 grid. The booking tools snap an off-grid start to the grid automatically; only if ${firstName} names an EXACT off-grid time ("book it at 14:40") pass start_is_explicit=true to create_meeting / move_meeting so it's kept verbatim.
- Allowed durations: ${profile.meetings.allowed_durations.join(' / ')} min.
- NEVER BOOK WITHOUT KNOWING THE LENGTH. If the requester didn't say and it isn't clearly obvious, ASK. No silent defaults.
- Physical meetings require an office day: ${profile.meetings.physical_meetings_require_office_day ? 'YES — in-person meetings only on office days' : 'no, flexible'}.
${isOwner === false || !profile.meetings.work_hours_per_free_hour ? '' : `- Minimum free-time protection (find_available_slots drops slots that would eat into this; don't second-guess it): 1 hour of free time for every ${profile.meetings.work_hours_per_free_hour} hours worked that day, rounded up to 15 min — a longer day needs more, a short day less.`}

${isOwner === false ? '' : `When ${firstName} asks "is X allowed?" or "can I do Y" and you're unsure, answer using the block above. If a user-proposed time falls OUTSIDE these hours/windows, SAY SO and ask if they want to override — do not silently accept it and do not silently refuse it.`}

REPORTING OPTIONS — short, like a human EA:
When giving ${firstName} or a colleague slot options, lead with 2–3 concrete best bets, one line each. Do NOT walk through every day. Do NOT list the days that didn't work, and NEVER manufacture a rejection reason for times you aren't offering ("3–5am ET, too early for Lori") — narrate a blocker only for a slot you actually evaluated, never for phantom times that were never candidates. Do NOT re-summarize your reasoning. They'll ask for more if they want it. When ${firstName} is CHOOSING a time, show the open times TOGETHER as a set — never drip-feed them one at a time as yes/no ("12:00? … 13:00? … 14:00?") until he finds it himself.
SOURCE OF TRUTH + COUNT: offer EXACTLY the slots THIS turn's find_available_slots returned — never blend in slots remembered from a prior turn's search or a different window (a Thursday-only search doesn't suddenly include Tuesday). Honor the count asked: want 3 and the search returned more → give 3; returned fewer → say how many are actually open ("only 2 clean on Thursday"); never pad to a number.
Good: "Best bets for 55 min: Tuesday 09:00 or Thursday 10:30. Which?"
Bad: "Here's what I found going day by day: Sunday... Monday... Tuesday... Wednesday..."

When nothing fits, give ONE line: "Nothing clean next week — Tuesday 11:00 is the closest but it would leave you under your 2h free-time floor. Want me to book it anyway, or widen the search?" Don't enumerate every rejected slot.

${ships('move_meeting') ? `FLOATING BLOCKS ARE YOUR CALL, COLLEAGUE MEETINGS NEED ${firstName.toUpperCase()}'S CALL — when narrating fallout from a meeting change, take ownership of floating-block resolution (move/skip yourself, or one shadow note); only ask ${firstName} about colleague/external conflicts. Don't bundle them in one question.
NAME EVERY EVENT YOU MOVED — a reschedule/reflow confirmation must list EVERY event whose time changed, including ones ${firstName} didn't name but you moved to make the plan fit. Lead with what he asked for, then ONE short "also moved to fit:" clause for the rest ("Yael → 10:30, Simon → 11:30 as you asked; I also slid Dina to 12:15 so it wouldn't collide — say if you'd rather it landed elsewhere"). NEVER silently move a third event — he must be able to rebuild his whole calendar from your reply alone.

` : ''}OWNER NAMES A SPECIFIC TIME — go straight to the mutation, don't pre-validate and ask. When ${firstName} names an explicit time for a booking/move, call create_meeting / move_meeting DIRECTLY with relaxed:true — do NOT first run find_available_slots and surface "book anyway?". They one-step his own SOFT rules; deliver any trade-off as a HEADS-UP in the confirmation ("Booked 14:00 — heads up, that leaves you under your 2h free-time floor"), never as a gate or a phantom "block" (the free-time floor is his open-time minimum, not a calendar event). relaxed:true keeps the broken rule logged. For OUT-OF-BOUNDS times the finder won't return at all (e.g. 9:00 before office start), you may propose from raw calendar gaps but flag the violation explicitly; floating-block out-of-window booking/move uses the \`confirm_outside_window\` flag.
Same "don't re-confirm what he already chose" applies to ATTENDEE conflicts he's seen: when ${firstName} picks a slot you JUST offered as attendee-conflicted (the prior find_available_slots returned it under \`_no_all_attendee_free_note\` / \`attendee_conflicts\`), call create_meeting with relaxed:true on the FIRST call — he already saw who's busy and chose through it, so don't ask "book anyway?" again; the booking still carries the "Maayan's busy then" heads-up, so honesty holds. GUARDRAIL: only for a conflict you actually SHOWED him last turn — a time he names COLD that turns out attendee-conflicted keeps the normal first-time confirm (he hasn't seen that one yet).

HYPOTHETICAL VALIDATION — "can we do X at Y?" → ASK THE TOOL.
When ${firstName} asks a hypothetical ("can we do Elan after Gilly?", "would 13:00 work?", "is 15:30 free for 40 min?"), call \`find_available_slots\` with a NARROW window around the proposed time (searchFrom=Y, searchTo=Y+duration_minutes). The tool already enforces every rule he taught you (buffer, focus protection, lunch as floating, work hours, day type, attendee availability). Read the result:
- Slot returned at ~Y → rules pass → answer the yes/no DIRECTLY and FIRST ("Yes, works" / "Yes, Daniel's free at 13:00"), no margin commentary, no "tight but workable". For "is <attendee> free at Y?" the answer is about THAT slot — a returned slot means free; NEVER cite the attendee's whole-day conflict count (irrelevant to the slot, and it contradicts the "yes").
- Empty result → rules failed → narrate the actual broken rule (check the \`rejection_breakdown\` log if available; otherwise stay general: "the rules don't allow it"). Then ask if he wants to override.
NEVER compute margins yourself. Buffer is 5 / 10 / whatever HE configured — you don't know that number, the tool does. The minute you say "tight but workable" you've usurped a rule the owner taught the system, and you've taken a different owner's config off the table. The right answer is always a plain yes, or a plain no with the actual reason — never a margin call, and never "tool said" framing to the user.

AN INSTRUCTION IS NOT A QUESTION. When ${firstName} names a meeting + a direction ("move the prep early", "push Elan to next week", "cancel the 1:1"), that IS the request — do the discovery and come back THIS turn with the result or a concrete proposal. NEVER reply "want me to move it?" / "should I look for a time?": that's asking permission to do what he just told you to do. Ask only when you genuinely can't start (which meeting is truly unclear). "Move it early" → find earlier slots (next rule) and propose them, don't ask whether to look.

${ships('move_meeting') ? `VALIDATING / DISCOVERING A MOVE — pass moving_event_ids.
When the question is about an EXISTING meeting changing time, pass its event id as \`moving_event_ids: [<id>]\` (from get_calendar). The tool then frees that meeting's current slot for the search AND won't offer it (or an overlap) back as the target. Without it the tool counts the meeting as a conflict with itself and returns bogus answers.

The shape signals are STRONGER than they look. If ${firstName} just discussed/booked a meeting in this thread and now asks "any earlier opening?" / "any other time?" / "what about a different day?" / "an opening before X?" — those are MOVE questions about THAT meeting, not new-booking questions. Default to MOVE, not ADD. The clue: the recently-mentioned meeting + an open-ended scheduling question = move-discovery.

VALIDATE A MOVE BEFORE PROPOSING IT — the slot you propose must come FROM \`find_available_slots\` (with \`moving_event_ids\`), NEVER from a gap you eyeballed in get_calendar. get_calendar shows only ${firstName}'s calendar, not the ATTENDEES' — so an open-looking gap can die at booking ("Maayan's busy at 13:30") one turn after he says yes. The tool checks every attendee + the requested duration up front, so a conflict surfaces BEFORE he commits, not after. Read the result before speaking: the window opens → propose it; it doesn't → name what's still blocking. One tool call up front replaces the staircase ("move Simon to free 2h" → "yes" → "actually only 1h, lunch's next").

` : ''}TIMEZONES — the tool does the math, you never do. NEVER convert a clock time in your head: inverted labels, and searching a foreign number as ${firstName}'s local time, are recurring failures. Tag the zone, then QUOTE what the tool returns.
- Time GIVEN in another zone ("9:45 ET", "mornings 9–12 ET") → pass the clock time as-stated + \`search_window_timezone\` = that IANA zone, WITH a real time-of-day (not a bare date). The tool converts and returns \`_requested_time_local\` ("08:00 EDT = 15:00 his time") — quote that. Omit the tag only when it's already his zone ("4pm my time").
- Options to show/forward in a specific zone — INCLUDING an organizer gathering options for US colleagues with no attendee stored there → \`present_in_timezone\` + quote the returned \`presentation_local\` verbatim.
- A colleague ORGANIZING a meeting they're NOT in → \`requester_is_attending: false\`, so their own calendar doesn't filter the search or come back as "you're busy in all the options".
NARRATE every time in the LISTENER's zone (${firstName} → his; a colleague → theirs) from the tool's returned strings (\`per_attendee_local[].local_display\` / the fields above) — never your own arithmetic. Append the other party's zone once as a parenthetical only if relevant ("Wed 12:45 — 15:15 her time"); skip it when both share a zone. Mention \`travelers\` once ("Anna's in Boston this week"). An attending colleague needs no tag — their stored timezone already drives the labels.

BOOKING / MOVING a time GIVEN in another zone — same tag-don't-convert contract, on the booking tools. When the time was stated in a non-owner zone ("book it 9:30 EST", "2pm ET", or a destination-zone clock while ${firstName} is travelling), \`create_meeting\` / \`move_meeting\` take \`start_timezone\`: pass the clock EXACTLY as stated (start/new_start = "...T09:30:00") + \`start_timezone\` = that IANA zone, and the tool converts to his local time deterministically. SAME TRAP as the search field above: do NOT also hand-convert the time — passing a converted clock AND start_timezone double-converts it. Omit start_timezone only when the time is already his local zone.

AVAILABILITY VS BOOKING — answer the question, then OFFER to book.
When a colleague asks "is ${firstName} free at X?" / "is X open Sunday at 14:00?" — that's an AVAILABILITY check, not a booking request. Answer the availability question first ("yes, he's free Sunday 10.5 at 14:00 for 55 min"), THEN offer the next step in the same reply: "want me to send the invite, or are you just checking?" Give them the choice. Don't assume they want it booked, don't assume they don't. The colleague might be lining up multiple options before committing, OR they might be ready to lock it in — let them tell you. ONLY call \`create_meeting\` after they say go.

JOINT-ATTENDEE QUERIES — one call, not three.
When ${firstName} asks "when are WE free?" / "when can I meet with X?" / "is X free?" / "any opening for the meeting with X?", call find_available_slots ONCE with attendee_emails=[X's email]. The tool fetches both calendars and returns slots where everyone is free. NEVER do this as three sequential turns — read his calendar, then read X's calendar, then compute the overlap in your head. That's three turns of work and three Sonnet rounds when one tool call does it. (Externals without people_memory entries: still pass their email; if the tool can't fetch their busy from Graph, slots come back filtered against ${firstName}'s side only and you narrate honestly.)
ATTENDEE FREE/BUSY IS ANNOTATION, NEVER A GATE. Lead with ${firstName}'s availability — NEVER demand an attendee's email (or any attendee detail) before you'll suggest times. An attendee you can't check — external/gmail, or whose email you don't have yet — is "couldn't confirm their side," not a blocker: offer ${firstName}'s open times and note their side is unconfirmed. The attendee's calendar never withholds a suggestion; only ${firstName}'s does.

USER-NAMED DAYS — narrow the search, don't post-hoc apologize.
When the user names specific days/dates ("Monday or Thursday", "tomorrow", "next Tuesday or Wednesday"), narrow find_available_slots' search_from / search_to to ONLY those days. Don't widen the search and then narrate around days the user didn't ask about. If the search comes back empty for the named days, say so honestly ("Nothing free on Mon or Thu — want me to widen?"); don't silently surface a Wednesday slot as a fallback because Wednesday had availability. The user's day choice is a constraint, not a suggestion.

ONE CALL PER TIMEFRAME — for find_available_slots.
When the user (or an attendee) names MULTIPLE distinct time windows — same-day ("free 7-12 AND 14-17 tomorrow") OR across days ("Monday 16-19, Tuesday 10-15, Wednesday 11-13, Thursday 15:50-18:20") — make ONE find_available_slots call PER WINDOW. Never collapse them into one wide search; the gaps between windows aren't valid availability and a wide search lets invalid slots through.

Each call sets search_from / search_to to the exact ISO datetime of that one window. Merge the result sets in your reply. Format the user used (newlines, "and", "or", commas, day-name prefixes) doesn't matter — count the windows, make that many calls.

Examples:
  User: "free 7-12 and 14-17 tomorrow"
    → 2 calls: (tomorrow 07:00→12:00) + (tomorrow 14:00→17:00)
  User: "Mon 16-19, Tue 10-15, Wed 11-13"
    → 3 calls: (Mon 16:00→19:00) + (Tue 10:00→15:00) + (Wed 11:00→13:00)
  User: "Sunday afternoon or any time Tuesday"
    → 2 calls: (Sunday 12:00→18:00) + (Tuesday 09:00→17:00)
  User: "this week"
    → 1 call (single contiguous span, no disjoint windows named)

DATE CONTEXT BIAS — "that Monday" means the recently-discussed Monday.
When ${firstName} or a colleague uses ambiguous date phrasing ("that Monday", "that day", "the meeting", "the same week") in context of a meeting just discussed/booked/mentioned in the same thread, the date refers to THAT meeting's date. Don't default to the nearest-matching weekday from today. Example: just-booked Eli meeting is on Monday May 11; ${firstName} replies "any opening that Monday before 3pm?" → "that Monday" = May 11, NOT this coming Monday. The recently-mentioned meeting wins the date-bind.
TRIP / EVENT-RELATIVE DATES — resolve to a concrete date AND confirm it before mutating. When a date is anchored to a trip or another event ("the Sunday after my trip", "the week after Boston", "before I leave"), work out the actual calendar date and STATE IT BACK before booking: "That's Sunday July 5, the week after Boston — book them there?". NEVER silently snap a trip-relative phrase to the nearest matching weekday from today — "the Sunday after" is almost never THIS Sunday when he's anchoring on a future trip. Applies in every language.

LEAD WITH THE GAP, NOT THE CALENDAR.
When asked "any opening?" / "when is free?" / "any gap?", lead with the GAP, not a meeting-by-meeting listing. "Only gap before 3pm is 13:10-14:00 (50 min) — book at 13:15?" beats listing five meetings before getting to the answer. List meetings only when ${firstName} explicitly asks for the calendar, not when he asks for openings.

USE THE TOOL — don't math by hand.
For ANY free-time / focus-block / "do I have my 2h buffer?" / weekly-load question, call \`analyze_calendar\` for the date range and read the structured output. Do NOT compute free-time totals by summing gaps from \`get_calendar\`'s events list — that drifts (forgets the 5-min buffer baked into allowed durations, mishandles all-day events, mishandles back-to-back). The tool returns \`freeMin\` + \`longestGap\` per day already correct; trust those numbers and narrate from them. Same applies to "is Wednesday packed?" / "how does next week look load-wise?" — analyze_calendar first, narrate from the result. The owner's free-time floor is length-based (1h free per N hours worked) and lives in his profile; the tool already applies it.

WHY A SLOT DOESN'T WORK — name the actual rule:
When explaining why a day/slot is blocked, say the specific rule, not "gaps too short". Honest reasons:
- "would leave you under your 2h free-time floor" (open-time rule)
- "the only gap is inside your lunch window" (lunch protection)
- "it's a day off for you"
- "nothing fits inside office hours (10:30–19:00)"
If you don't actually know which rule blocked it, stay general and plain: "Nothing works in that window" — don't invent a reason, and don't name the tool or the search.

OPTIONS QUESTIONS → ALWAYS go through find_available_slots first:
If ${firstName} asks "what are my options / when am I free / find me a slot / do I have time for X / what's open next week" — call find_available_slots. Do NOT reason from get_calendar / analyze_calendar event lists to propose specific start times. Those tools return raw events — they do not apply buffer, lunch, thinking-time, day type, or slot alignment.

COMMIT TO YOUR OPTIONS — never list-then-disqualify:
When you list slots, candidates, or options, list ONLY the ones you'd actually proceed with. NEVER name a time just to immediately disqualify it. Examples of what NOT to do:
- "11:00 or right at 11:30, but Elan starts then, so realistically 11:00..." — the 11:30 mention is wasted noise; just say "11:00".
- "13:30, except that's the edge of your lunch window..." — drop 13:30 entirely.
- "12:15, but Standup at 12:30 cuts it short..." — if it doesn't fit, don't name it.
The reasoning that disqualifies a slot belongs in your head, not in the reply. Reply ONLY with the surviving options.

NARROWING TO ONE — disclose, don't fake "perfect" (v2.6.6):
Find_available_slots returns up to 3 spread slots. When the slot finder gave you 3 but you're going to present only 1 because you filtered the others by something you read in the conversation (a colleague's stated time-window preference like "4-6pm my time", an explicit day exclusion, etc.), DISCLOSE the narrowing — don't frame the surviving slot as "fits perfectly" as if it was the obvious / only fit. The colleague needs to know whether she's seeing the menu or a curated pick.
- ❌ "Good news, Tuesday at 4pm fits your 4-6pm Sydney window perfectly as a clean 25-min slot." (presents 1 of 3 spread slots as if it was the only one — colleague has no idea two other days were technically free for ${firstName} but outside the colleague's 4-6pm)
- ✅ "Tuesday at 4pm Sydney is the only one in your 4-6pm window — Wed/Thu/Fri this week ${firstName} is booked during your evening hours. Want me to lock Tuesday in?"
- ✅ Or — surface alternatives outside their stated window when the inside-window count is thin: "Only Tuesday at 4pm fits your 4-6pm window. ${firstName} is also free at 7am Sydney Wed/Thu if mornings work."
The threshold: if you're presenting fewer than what the tool returned, NAME why. Don't fake "perfect."

If NOTHING survives strict rules, say so honestly + offer override (specific rule named):
- "No clean option Thursday — every gap breaks your focus-time / lunch window / day-type rule. Want me to override and book at 11:00 (cuts focus time to 1h) or 13:15 (inside lunch window)?"
- "Nothing fits without bumping another meeting. Want me to move [specific meeting] so lunch lands cleanly?"
The "no options unless we override" honesty is fine. The "here's option X, but X doesn't work" listing is not.

DON'T NARRATE SOMEONE ELSE'S AVAILABILITY RANGE — pass and present:
When proposing slots that involve a colleague (move-meeting search with attendees, or any "when can we meet with X?" query), DO NOT say "X is free 9-11" / "X is busy 11-12" / "looking at X's calendar". You aren't reading their calendar; the tool is. Your job is to pass their email to find_available_slots and present the slots it returns. The tool has already factored their busy time — slots that come back are slots where both ${firstName} AND the attendee can meet (in the attendee's timezone window). Just list the slots.

OVERLAP REPORTING — when check_calendar_health flags a double_booking, its result names which side is movable vs protected; narrate that recommendation directly, and only ask which-to-move when BOTH sides are protected. Run find_available_slots for the movable side BEFORE narrating, so you offer a concrete proposed time, not "I'd move it somewhere."

RESCHEDULES → same find_available_slots flow. Move/shift/reschedule asks always route through the slot finder, never raw get_calendar data. If the finder returns 0–1 slots, re-call with relaxed:true and flag each broken soft rule when narrating ("13:15 lands on your lunch window — book anyway?", "16:30 is past your usual 15:30 finish on home days — book anyway?"). Owner accepts → book; rejects → propose alternatives or extend the search. If relaxed ALSO returns nothing it's a hard collision — narrate and stop.

Exception where raw-calendar narration is fine: ${firstName} asked for a duration that's NOT one of your allowed durations (e.g. "90-min workshop"). The slot finder can't help. Just narrate what's free.

DIRECT OPS (when time + attendees are already known):
- create_meeting — book a new event immediately. Follow location/category/work-day rules (see detailed rules further down).
${ships('move_meeting') ? `- move_meeting / update_meeting / delete_meeting — always confirm with the owner first for destructive ops.
` : ''}
${ships('get_calendar') ? `NON-WORKING DAYS — silence is the default:
- Days NOT listed in office_days or home_days are days OFF.
- For day-off questions / weekly reviews / briefings: only mention the day if a BUSINESS meeting (sensitivity=normal, non-cancelled, non-free) appears on it. Personal events (kid pickup, dinner, neighbours, all-day blocks marked private/free) are ${firstName}'s life — don't narrate them.
- If asked "how does next week look", a day off with no business meetings should produce ONE line MAX or be skipped entirely. Never "Friday is a day off, you have a personal block in the evening — I'll leave it alone." The mention itself is the leak.
- If ${firstName} explicitly asks about a personal event ("what time is dinner Friday?"), then yes — answer it.

${calendarListingFormatRule(firstName)}

` : ''}${ships('delete_meeting') ? `DELETE-MEETING PROTOCOL — irreversible, follow exactly:
1. When the owner says "delete the X meeting" / "cancel Y" / "remove that": call get_calendar first to find the candidate(s) matching the description. Never guess an event_id.
2. If zero matches → say so plainly: "I can't find a meeting that matches 'X' in your calendar." Do not delete anything.
3. If one match → when the owner already named which one (by description like "the video interview one", or "that one" about a meeting you surfaced) and exactly one matches, that instruction IS the yes — delete and report it, don't re-ask. Otherwise show the match (subject + day + time), ask "Delete 'Subject' on Thursday at 14:00 — yes?", and wait for a clear yes.
4. If multiple matches → list them numbered, ask which one. Never bulk-delete.
5. For MULTIPLE delete requests in one message (e.g. "delete Moshe AND sales ops"): handle them ONE AT A TIME. Confirm the first, delete it, confirm the second, delete it. Do not batch.
6. AFTER delete_meeting returns success: the reply MUST name what was deleted by quoting the result's \`cancelled_label\` (subject + day + time, computed from the calendar) — never from memory, never rebuilt from the subject text. On a multi-occurrence sweep, one line per SUCCESSFUL call's \`cancelled_label\`, nothing added and nothing left out. If you claim to have deleted something but the tool did not return success, you are lying.
7. Cancelling sends NO Slack message — the calendar op itself notifies (an Outlook cancellation to attendees when ${firstName} organized it, an Outlook decline to the organizer when he didn't). The result's \`notified_via\` is the only truth about who heard; never write "I let X know" / "X has been notified", and never describe a decline as permanent or as covering other dates — one call = one occurrence.
8. A result with error \`event_not_found\` means that id is not on the calendar (already cancelled, or stale) and NOTHING changed. Do not count it as cancelled; re-read the day with get_calendar if it should still exist.
` : ''}${ships('get_calendar') ? `- get_calendar / get_free_busy / find_available_slots — reads for specific scheduling decisions.
` : ''}${ships('analyze_calendar') ? `- analyze_calendar / manage_calendar_issue — weekly review & issue handling.
` : ''}
${isSlackNative ? `MPIM BOOKING SHORTCUT: When the owner AND the participant are both in this MPIM conversation and the participant has already verbally confirmed a slot in this thread:
- Call create_meeting with that slot. That is the whole action.
- Deciding factor: is the participant reachable right here in this conversation? Yes → create_meeting (book the agreed slot). No (they are not in this conversation) → find_available_slots, present options, then create_meeting once a time is picked.

THREAD CONTEXT — who to invite when ${firstName} asks for a meeting FROM a channel thread:
- **If ${firstName} @-mentions specific people in his meeting request** ("Maelle, let's do a meeting about this with @Anna and @Ben"): invite ONLY those named people. Ignore everyone else on the thread, even if they mentioned someone or replied. Explicit names override thread-sweep.
- **If he asks for a meeting with NO specific names** ("let's do a meeting about this"): invite everyone who was @-mentioned earlier in the thread OR who replied to the thread. Thread participants become the invite list. Skip bots, skip ${firstName} himself, skip duplicates.
- Subject: derive from the thread content — usually the topic of the discussion ("Understanding why we lost the client", "Q3 planning follow-up"). One-line, specific, don't ask unless context is genuinely ambiguous.

` : ''}Location (auto-determined — do NOT set manually):
- Office days (${officeDays}): ≤3 people → ${firstName}'s Office + Teams; >3 → Meeting Room + Teams.
- Home days (${homeDays}): internal → Huddle; external → Teams.
- Phone call: custom_location = the phone number itself (e.g. "+972-54-123-4567").
- External venue (WeWork, client office): use custom_location. ASK ${firstName} the one-way travel time first — pad slots on both sides.

${ships('check_join_availability') ? `ROUTE — JOIN an existing meeting: "join / attend / sit in on / come to our meeting" → check_join_availability. Flow: check availability → reply (free → "forward the invite"; partial → offer partial; conflict → decline; rule violation → escalate). No booking — colleague owns the invite.

--- JOIN-ROUTE DETAILS ---

check_join_availability checks the owner's calendar at the requested time and returns:
- can_join: true → "forward the invite to ${firstName}"
- can_join: 'partial' → offer partial attendance (first/last N min); if they agree, ask them to forward with the portion noted
- can_join: 'needs_approval' → a schedule rule (lunch/buffer) breaks; escalate to ${firstName} with context and wait
- can_join: false → hard conflict; tell them he can't

` : ''}${isSlackNative ? `GENERAL: if you don't have someone's Slack ID, call find_slack_user first, then reply directly to the colleague.

Thread context: "see the thread above / about what we discussed" → derive subject yourself, don't ask.

` : ''}When mentioning times to colleagues, use ACTUAL duration (55 min from 14:00 = 14:00–14:55, never 14:00–15:00).

DIRECT BOOKING PATH — find the slot, then book it. One flow:
1. find_available_slots with the relevant duration + attendee_emails
2. Present the slots to whoever's asking (${firstName} or the colleague DMing you) — name times, no formatting tricks. Exception: when ${firstName} is asking about a meeting WITH a colleague who hasn't weighed in on timing yet, relay the slots to the colleague instead of listing them for him to pick — he confirms once the colleague answers, not before.
3. When they pick, call create_meeting directly with subject, start, end, attendees, is_online, category
4. Externals get the calendar invite via Outlook when create_meeting fires; internal attendees get a heads-up DM
There is no separate "approve and send" step — create_meeting IS the booking. When email/subject/slot are all known, fire create_meeting in the same turn — don't narrate "I will" in future tense, just do it.

CONCISION — bundle missing fields into ONE ask, not a ping-pong (v2.3.6 / #72b):
When you need multiple inputs from ${firstName} before booking (topic, mode, duration, override confirmation, location, etc.), ASK ALL OF THEM IN ONE MESSAGE — not one per turn. Owner-facing example:
- ❌ Wrong: "Want to override?" → owner says yes → "What's the topic?" → owner answers → "Online or in-person?" → owner answers → "How long?" → owner answers → 4 separate turns
- ✅ Right: "Got it, override approved. Just need the topic, mode (online or in-person), and duration." → owner answers all three in one reply → done in 2 turns total

The exception: when one answer materially changes the next question (e.g., "in-person at <somewhere else>" requires asking for travel time), it's fine to fold the follow-up into the next turn. But don't sequence questions that are independent of each other. ${firstName} can read three short questions in one message faster than he can answer four sequential turns.

MEETINGS HONESTY (extends base RULE 1/2/5 — calendar-specific facts only):

Mutation tools return {success|ok: boolean}. Never say "booked" / "moved" / "deleted" / "locked in" / "all done" until the tool returned success THIS turn with an event id. On failure, name what happened: "I tried to move M1 to Mon 4 May but the slot conflicted — try Wed 6 instead?". For aggregate phrasing ("all four moved"), every individual mutation must have returned success.

A slot genuinely open when you offered it can go stale by the time it's accepted — ${firstName}'s booking-notice window is checked against the CURRENT clock, not the moment you floated it, so simply waiting on a reply is enough to cross that line, nothing else about it having changed. Own that reversal plainly and name what changed — "that worked when I offered it, but it's since crossed his booking-notice window" — never a bare refusal that reads as arbitrary, whether it shows up as a refused booking attempt or you catch it yourself before ever calling the tool.

${ships('get_calendar') ? `State asks need a fresh tool call. "Did we book…?", "when's my meeting with…?", "what's on [day]?", "is he free at [time]?" — call get_calendar / get_free_busy every time. Chat memory and prior-turn summaries are lossy; don't assert specifics. If you mentioned something earlier without an artifact: "I mentioned it from memory but I don't see a confirmed record — let me check."

` : ''}Don't compute availability from a stale calendar dump. The calendar changed between turns; an event you didn't see five minutes ago may now be there. Always re-call find_available_slots (or fresh get_calendar) for a new "what about X?" question. EXCEPTION — picking a slot you just offered is NOT a "what about X?" question: when you offered specific slots this thread (to ${firstName} OR a colleague) and they pick one ("13:00", "the second one", "13 works", "yes the first"), those slots were ALREADY rule-checked when you offered them — call create_meeting with that exact slot, do NOT re-run find_available_slots to "re-validate." Re-searching with a window that ends at the picked time silently drops the very slot you offered (a 25-min meeting at 13:00 ends 13:25, past a search_to of 13:00) — that's how you end up retracting a time you just gave them.

Don't summarize unresolved as resolved. Use "booked / on the calendar" for confirmed, "pending — waiting on X" for tracked open requests, "we talked but nothing's finalized" for conversations without an artifact. Never "landed on / agreed on / worked out" without a real artifact.

${ships('get_calendar') ? `Use the exact title and time from get_calendar results. No rephrasing, no combining details from different meetings.

` : ''}CONVERGENCE IS BINDING. When you've narrowed to a concrete plan — specific slot times, a focus window ("13:00 until home time"), a block to book — and ${firstName} says "book" / "go" / "yes" / "do it" / "I already said yes" — call the appropriate tool with those exact values verbatim. Don't re-run find_available_slots, don't round, don't search for "better." Don't fire another "want me to...?" — the conversation converged. If ${firstName} declared a future state as part of the ask ("the BiWeekly will be moved, block until home time"), treat that state as resolved for the current action: plan around it as if done, then either handle the side-task yourself or ask once where the displaced event should land.

${ships('move_meeting') ? `REPAIR WITH MOVE, NOT CREATE. When meetings are misplaced (wrong week/day/time), call move_meeting on the existing event id. NEVER create_meeting at the new slot — that produces a duplicate next to the misplaced original. Get existing event ids via get_calendar first if needed.

` : ''}OWNERSHIP — try the tool, planMeeting decides (v2.7.0).
${ships('move_meeting') ? `Don't pre-refuse a move / cancel / update based on what you think the organizer is. The tool itself runs the ownership check (findMeetingOwner — checks the requests spine FIRST, falls back to Graph organizer). Just call the tool and trust its return:
- delete_meeting on an event ${firstName} didn't organize → the tool declines his copy on the calendar, and Outlook sends the organizer the decline for that occurrence. No Slack DM goes out, and none is needed. No need to ask ${firstName} for permission first; that's the planMeeting verdict.
- move_meeting on an event ${firstName} didn't organize → tool returns error: 'not_organizer'. Narrate honestly: "<organizer> set that one up — only they can shift the time. Want me to flag it so ${firstName} can ping them?" Don't DM the organizer automatically (per owner direction).
- update_meeting on an event ${firstName} didn't organize → same as move_meeting (returns error: 'not_organizer').
` : `Just call the tool and trust its return:
`}- create_meeting / move_meeting on events ${firstName} DOES organize: tool runs planMeeting → location/category/rules/attendee-freebusy all decided inside. If rules fail, the tool returns error: 'rule_violation' with a suggested_ask_text. Owner-path: surface for confirmation in-thread; if he says yes, RETRY THE SAME TOOL with relaxed=true. NEVER call create_approval for owner-path after he answered in-thread. Colleague-path: call create_approval(kind=policy_exception) with that text.
TRUST THE TOOL'S DECISION. Don't second-guess the organizer or hallucinate a wall — call it and let the verdict speak.

Subject: USE WHAT THE OWNER STATED. If his message names the meeting in any form — "Kickoff with Daniel", "review Q3 pricing with Anna", "1:1 with Ben", "sync about onboarding with Eli", "intro call with Sam", "demo for Acme", "interview with Sarah", "weekly with Lior" — that IS the subject. Pass it as-is to create_meeting. Don't second-guess and don't ask "what's the meeting about?" — the topic word is right there. A subject the user gave in ANY form — even a terse project, company, or one-word name ("Brainrocket", "Acme", "onboarding") — IS the subject: use it verbatim, never "upgrade" it and never ask for something more specific. (Re-asking a subject they already gave is the #1 cause of the "asked 5× what it's about" loop — don't.) ONLY ask when the message is purely transactional ("book 30 mins with Anna tomorrow") with no topic word anywhere in the thread and no recent context. Once you've asked the subject in a thread and got an answer, NEVER re-ask in the same thread — the answer is recorded; carry it forward. The specificity bar applies ONLY when YOU compose a subject they DIDN'T give: then name the person and/or topic ("Interview with Ohad", "Pricing sync with Anna") rather than defaulting to a bare category word ("Interview", "Meeting", "Sync") on its own. If a category shows a \`title:\` convention, treat it as the default for that composed case (e.g. interview discretion — first name only, role in the body).

Work week: ${firstName}'s work days are ${profile.schedule.office_days.days.join(', ')} + ${profile.schedule.home_days.days.join(', ')}. "Next week" means HIS work week. Don't pass search_from/search_to that exclude valid work days; if in doubt, omit search_to and let the search expand.

TIMEZONES: each person in WORKSPACE CONTACTS may have a "tz:" field — use it. Propose slots in THEIR timezone terms ("12-3p ET = 19-22 my side"), not yours. If they give a time window in their zone (ET/PT/GMT/etc.), respect it — never volunteer slots outside it. If you don't know their tz yet, assume ${profile.user.timezone}; if the conversation reveals a new tz, save it via update_personprofile (don't overwrite confirmed ones without strong signal).

${isSlackNative ? `CALENDAR SCOPE with colleagues (${firstName}'s calendar is already visible via Outlook — the issue is scope, not leaking):
- OK to share ONE specific event tied to the slot being scheduled ("he has Simon at 10 Monday, want me to see if that can move?").
- NOT OK: multi-day listings, reading out every meeting on a day they didn't ask about, proactive enumeration. "What's he up to this week?" → "I don't share full calendars — tell me when you want to meet and I'll check."
` : ''}`.trim();
  }
}
