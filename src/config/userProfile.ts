import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';
import logger from '../utils/logger';

// ── Name validation ───────────────────────────────────────────────────────────
// Names must look like real professional names — enforced for both the user
// and the assistant. This matters because the assistant will appear as a real
// employee in Slack, email, and future channels.

const BLOCKED_PATTERNS = [
  /fuck/i, /shit/i, /ass(?:hole)?/i, /bitch/i, /dick/i, /cock/i,
  /pussy/i, /cunt/i, /bastard/i, /whore/i, /slut/i, /piss/i,
  /damn/i, /crap/i, /idiot/i, /moron/i, /retard/i, /nigger/i,
  /faggot/i, /racist/i,
];

const REAL_NAME_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ'\-]+([ ][A-Za-zÀ-ÖØ-öø-ÿ'\-]+)+$/;

function validateProfessionalName(name: string): boolean {
  if (!REAL_NAME_REGEX.test(name.trim())) return false;
  if (BLOCKED_PATTERNS.some(p => p.test(name))) return false;
  const words = name.trim().split(/\s+/);
  // Must have at least first + last name
  if (words.length < 2) return false;
  // Each word must be at least 2 chars
  if (words.some(w => w.replace(/['\-]/g, '').length < 2)) return false;
  return true;
}

const ProfessionalNameSchema = z.string().refine(
  validateProfessionalName,
  (val) => ({
    message: `"${val}" is not a valid professional name. Must be a real first and last name (e.g. "John Smith"). No offensive words, no single names.`,
  })
);

const ASSISTANT_NAME_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ'\-]+([ ][A-Za-zÀ-ÖØ-öø-ÿ'\-]+)*$/;

function validateAssistantName(name: string): boolean {
  if (!ASSISTANT_NAME_REGEX.test(name.trim())) return false;
  if (BLOCKED_PATTERNS.some(p => p.test(name))) return false;
  const words = name.trim().split(/\s+/);
  // Each word must be at least 2 chars (single name is fine)
  if (words.some(w => w.replace(/['\-]/g, '').length < 2)) return false;
  return true;
}

const AssistantNameSchema = z.string().refine(
  validateAssistantName,
  (val) => ({
    message: `"${val}" is not a valid assistant name. No offensive words.`,
  })
);

// ── Email validation ──────────────────────────────────────────────────────────
// Assistant email must follow a real company scheme (not a generic placeholder)

const CompanyEmailSchema = z.string().email().refine(
  (email) => {
    const local = email.split('@')[0];
    // Must not be a placeholder
    const placeholders = ['you', 'user', 'admin', 'test', 'example', 'assistant', 'bot', 'ai'];
    return !placeholders.includes(local.toLowerCase());
  },
  { message: 'Email looks like a placeholder. Use a real company email (e.g. maelle.p@company.com).' }
);

// ── Schema ────────────────────────────────────────────────────────────────────

// v3.0.4 — `VipContactSchema` and `ReschedulingRuleSchema` removed alongside
// the `vip_contacts`, `rescheduling`, and `priorities` top-level fields.
// Audit showed each was declared in schema (and `ReschedulingRule` exported
// as a type) but never read by any code path in src/. Old yamls with these
// keys still boot (Zod strips unknown keys silently); the dead surface area
// is just gone from new templates and the codebase.

const UserProfileSchema = z.object({

  // v3.0.4 — required fields ONLY. Everything optional has a default below
  // so a minimal yaml (~15 lines) is enough to boot Maelle for a new user.
  user: z.object({
    name: ProfessionalNameSchema,                          // REQUIRED — real first + last name
    email: CompanyEmailSchema,                             // REQUIRED — work email
    timezone: z.string().min(3),                           // REQUIRED — IANA TZ, no default that fits everyone
    slack_user_id: z.string().regex(/^U[A-Z0-9]+$/, 'Slack user ID must start with U followed by uppercase letters/numbers'),  // REQUIRED — owner's Slack ID
    name_he: z.string().optional(),                        // optional — Hebrew spelling
    role: z.string().optional(),                           // optional — defaults to '' (was required min(2) — now optional)
    language: z.string().default('en'),
    units: z.enum(['metric', 'imperial']).default('metric'),
    company: z.string().optional(),                        // optional — company name for prompt
    company_brief: z.string().optional(),                  // optional — short company description
  }),

  assistant: z.object({
    name: AssistantNameSchema,                             // REQUIRED — assistant's display name
    slack: z.object({                                      // REQUIRED — Slack app credentials
      bot_token: z.string().startsWith('xoxb-', 'Bot token must start with xoxb-'),
      app_token: z.string().startsWith('xapp-', 'App-level token must start with xapp-'),
      signing_secret: z.string().min(10, 'Signing secret too short — check your Slack app dashboard'),
    }),
    slack_display_name: z.string().min(2).max(80).optional(),  // optional — defaults to assistant.name (resolved at load time)
    email: CompanyEmailSchema.optional(),                  // optional
    // Default persona is concise + professional. Owner can override for a stronger voice.
    persona: z.string().min(20).default(
      `You are a sharp, warm, and direct executive assistant. ` +
      `You communicate like a real person: natural greetings, clear and efficient, never robotic. ` +
      `You're confident and professional, with a light touch of personality. ` +
      `Match the user's language if they switch (e.g. Hebrew, Spanish) — keep the same tone in any language.`,
    ),
  }),

  schedule: z.object({
    // v2.8.1 — DAYS-ONLY classification. Each entry is the list of weekday
    // names where the owner is on office / home schedule. NO HOURS here —
    // those live in `work_hours` (the canonical source). Day-type
    // classification is used by category rules + location resolution.
    office_days: z.object({
      days: z.array(z.enum(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])).min(1),
      // Back-compat input only — accepted on read, normalized into work_hours,
      // then stripped from the canonical profile. Don't read these anywhere.
      hours_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      hours_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    }),
    home_days: z.object({
      days: z.array(z.enum(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])).min(1),
      hours_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      hours_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    }),
    // v2.8.1 — CANONICAL work hours per weekday. After normalization this is
    // always populated. Multiple ranges per day supported (split shifts).
    //
    //   work_hours:
    //     Sunday:    ["09:00-17:30"]
    //     Monday:    ["09:00-17:30"]
    //     Tuesday:   ["09:00-15:30", "21:30-23:59"]   # split day
    //     Wednesday: ["10:30-18:30"]
    //     Thursday:  ["10:30-18:30"]
    //
    // Legacy yaml shape (office_days.hours_start/hours_end +
    // home_days.hours_start/hours_end) is accepted on input and synthesized
    // into this map at load time. Profiles can use either input style; in-memory
    // representation is always the canonical `work_hours` map.
    work_hours: z.record(
      z.enum(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']),
      z.array(z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)).min(1),
    ).optional(),
    // v3.0.4 — optional. Owner-curated guidance for slot-picking preference
    // by attendee TZ. When unset, slot finder uses default spread logic.
    timezone_preferences: z.object({
      local_participants: z.string(),
      remote_participants: z.string(),
      note: z.string().optional(),
    }).optional(),
    // v3.0.4 — `note` + `blocking_event` removed. `blocking_event` was replaced
    // by the generic `meetings.issue_exclusions.subjects` yaml list in v3.0.3;
    // `note` was never read by any code path.
    night_shift: z.object({
      hours_start: z.string().regex(/^\d{2}:\d{2}$/),
      hours_end: z.string().regex(/^\d{2}:\d{2}$/),
      typical_day: z.string().optional(),
    }).optional(),
    // Owner's mental day boundary. Local-clock hour before which "today"
    // is still treated as the previous calendar day — late-night work
    // bleeds backwards into the workday it belongs to. Anchors the prompt's
    // DATE LOOKUP table and the date verifier's lookup so they agree about
    // what day "today" / "tomorrow" mean. Format "HH:MM". Default "00:00"
    // (no shift — owner's day boundary is real midnight).
    day_boundary_hour: z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
  }),

  // v3.0.4 — all meeting fields default. A profile that omits `meetings:`
  // entirely OR has `meetings:` with no children (yaml parses to null) both
  // boot. The preprocess coerces null → {} so the .default() below kicks in.
  meetings: z.preprocess(v => v ?? undefined, z.object({
    allowed_durations: z.array(z.number()).min(1).default([25, 50]),                 // Meeting lengths Maelle picks from
    default_meeting_duration: z.number().optional(),                                  // Default when conversation doesn't name one; falls back to smallest above
    buffer_minutes: z.number().min(0).max(30).default(0),                             // Buffer between meetings (0 = back-to-back fine)
    free_time_per_office_day_hours: z.number().min(0).max(8).default(0),              // Protected focus time per office day. NEUTRAL default 0 = no floor imposed; each owner sets their own number (v3.2.x de-tenant — was 2, which silently imposed one owner's focus theory on every tenant).
    free_time_per_home_day_hours: z.number().min(0).max(8).optional(),                // Home-day focus target (defaults to office value)
    thinking_time_min_chunk_minutes: z.number().min(15).max(120).default(30),         // Smallest focus block worth counting
    min_slot_buffer_hours: z.number().min(0).max(12).default(4),                      // How far ahead colleagues can book (owner gets 1h)
    physical_meetings_require_office_day: z.boolean().default(false),                 // Force in-person meetings to office days only
    room_email: z.string().email().optional(),                                         // Meeting-room mailbox for room booking
    // v2.8.2 — three labels for the three output flavors of the location
    // decision tree (see src/utils/resolveLocation.ts). All optional so
    // workspaces without an office can leave them unset; the resolver falls
    // back to "${firstName} Office" / "Meeting Room" defaults.
    office_location: z.object({
      short_label: z.string().optional(),               // internal-only office day, ≤3 people
      meeting_room_label: z.string().optional(),       // internal-only office day, ≥4 people
      small_meeting_room_label: z.string().optional(), // fallback when meeting room is busy and ≤5 people
      full_label: z.string().optional(),               // external attendee physical visit
    }).optional(),
    // v2.1.1 — each entry must supply EITHER name (subject match, existing)
    // OR category (Outlook-category match, new). This is additive-compatible:
    // existing profiles with only `name` keep working. When the owner adds an
    // Outlook category (e.g. "Protected") in the future, a single yaml entry
    // `{category: "Protected", rule: "never_move"}` auto-protects every event
    // tagged with it — no code change.
    // v3.0.4 — protected list defaults to empty. Legacy `rule` enum (replaced
    // by `movable: false`) and never-read `recurring` flag removed.
    protected: z.array(z.object({
      name: z.string().optional(),
      category: z.string().optional(),
      movable: z.boolean().optional().default(true),
    }).refine(p => !!p.name || !!p.category, {
      message: 'protected entry must have either `name` or `category`',
    })).default([]),
    // Floating blocks — protected N-minute periods that can live anywhere
    // inside a defined window (preferred_start..preferred_end). Lunch is
    // one example; coffee breaks, gym, prayer time, daily writing hour all
    // use the same shape. Elastic within the window (Maelle reshuffles to
    // make room for meetings, no approval needed). Out-of-window booking
    // or move requires the owner-override flag on book_floating_block and
    // move_meeting (confirm_outside_window=true) — owner direct request IS
    // the approval.
    //
    // Lives under `meetings` (not `schedule`) because floating blocks are
    // EVENTS that happen during the day — same conceptual bucket as the
    // protected list above. `schedule` is the daily framework (work days,
    // hours, timezone); `meetings` is the events that fill it.
    //
    // v2.4.1 — pre-v2.4.1 had a special-case `schedule.lunch` field that
    // was auto-promoted into this list. That asymmetric path is gone; lunch
    // (or whatever your day-anchor block is) lives here like any other.
    floating_blocks: z.array(z.object({
      name: z.string().min(1),                          // "lunch" | "coffee_break" | "thinking_time" | ...
      preferred_start: z.string().regex(/^\d{2}:\d{2}$/),
      preferred_end: z.string().regex(/^\d{2}:\d{2}$/),
      duration_minutes: z.number().min(5).max(240),
      can_skip: z.boolean().default(true),              // true = fine to leave un-booked when no room
      // Day-of-week scope. Optional. Examples:
      //   days: ["Thursday"]                              → only Thursday (e.g. a Thursday coffee break)
      //   days: ["Sunday","Monday","Wednesday","Thursday"] → every work day except Tuesday
      // When omitted, the block applies to every day listed in
      // schedule.office_days + schedule.home_days (i.e. all work days).
      days: z.array(z.enum([
        'Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday',
      ])).optional(),
      // Optional event-detection hints. If absent, Maelle matches calendar
      // events by subject/category containing the block's `name`.
      match_subject_regex: z.string().optional(),
      match_category: z.string().optional(),
      // Optional defaults when BOOKING a new instance of this block
      default_subject: z.string().optional(),
      default_category: z.string().optional(),
      // Default placement preference inside the preferred window. Honored
      // by rebalance + book_floating_block when no explicit prefer_position
      // arg is passed. Omitting → 'earliest_in_window'.
      prefer_position: z.enum(['earliest_in_window', 'latest_in_window']).optional(),
    })).optional(),
    // v3.0.3 — issue-detection exclusions. Subjects in this list are skipped
    // by the calendar-issue detector entirely (overlap, work_on_day_off, etc.).
    // Use for events the owner keeps on the calendar as personal markers but
    // doesn't want flagged (e.g. "Home Time" before night_shift exclusion
    // was generalized). Substring match, case-insensitive.
    issue_exclusions: z.object({
      subjects: z.array(z.string()).default([]),
    }).optional(),
  }).default({
    allowed_durations: [25, 50],
    buffer_minutes: 0,
    free_time_per_office_day_hours: 0,
    thinking_time_min_chunk_minutes: 30,
    min_slot_buffer_hours: 4,
    physical_meetings_require_office_day: false,
    protected: [],
  }).refine(
    m => m.default_meeting_duration === undefined || m.allowed_durations.includes(m.default_meeting_duration),
    { message: 'meetings.default_meeting_duration must be one of meetings.allowed_durations' },
  )),

  // v1.7.8 — Owner's Outlook categories. Optional. When defined, Maelle reads
  // these and picks the right one per event (book_floating_block,
  // create_meeting, set_event_category). When absent, tools skip category tagging.
  //
  // IMPORTANT: names must match EXACTLY what's defined in the owner's Outlook
  // (case-sensitive on some Outlook installs). Descriptions guide the LLM —
  // write them so Claude can tell which category fits a given event.
  categories: z.array(z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    // v3.1.6 — optional compact title convention, surfaced on the category cue
    // line in the owner prompt so the booking model composes the right SUBJECT.
    // The first-sentence category trim (Block 3) dropped multi-sentence
    // conventions like Interview's "Title: 'Interview with <first name>', role
    // in body, never the title" — this restores just that rule as structured
    // data, not prose. detectCategory still reads the full `description`; this
    // only shapes the title.
    title_hint: z.string().optional(),
    // When true, events created under this category are stamped with
    // sensitivity='private' on the Graph side. Lets the owner mark a
    // category as "personal/sensitive" without code knowing the literal
    // name. Default false.
    sets_sensitivity_private: z.boolean().optional(),
    // When true, create_meeting under this category skips the office-address
    // auto-fill. For categories that represent personal time-on-calendar
    // (focus blocks, buffer / think time, errands) where stamping the
    // office address would be wrong — the event isn't a meeting at a place,
    // it's a hold on the owner's own time. Default false.
    no_default_location: z.boolean().optional(),
    // ── v2.6 — category scheduling rules ───────────────────────────────────
    // The yaml ORDER of categories IS the priority. When a meeting could
    // fit multiple categories, the FIRST match in this array wins. List
    // most-restrictive first. No code computes "restrictiveness" — owner
    // controls priority by reordering.
    //
    // limits — caps per calendar window. Each is a max-count.
    limits: z.object({
      // Maximum instances of this category per calendar day (owner TZ).
      // Recurring meetings count per occurrence.
      per_day: z.number().int().positive().optional(),
      // Maximum instances per ISO week (owner TZ).
      per_week: z.number().int().positive().optional(),
    }).optional(),
    // day_type — restrict bookings to specific day types.
    //   'office_days' → only on profile.schedule.office_days.days
    //   'home_days'   → only on profile.schedule.home_days.days
    //   'any'         → no day-type restriction (default)
    day_type: z.enum(['office_days', 'home_days', 'any']).optional(),
    // default_location — what create_meeting stamps when Sonnet leaves
    // both is_online and location unspecified. Overrides the v2.5.2
    // day-aware default for THIS category.
    //   'office'           → stamp profile.meetings.office_location, isOnline=default_is_online
    //   'online'           → no physical location, isOnline=true
    //   'custom_required'  → Sonnet MUST ask the owner / colleague for the venue
    //   'none'             → fall through to v2.5.2 day-aware default
    default_location: z.enum(['office', 'online', 'custom_required', 'none']).optional(),
    // When default_location='office', whether the meeting is hybrid
    // (in-person + Teams link) or strictly in-person. Default true (hybrid).
    default_is_online: z.boolean().optional(),
    // When true, create_meeting / find_available_slots auto-pad slots with
    // profile.meetings.travel_buffer_minutes on both sides. The flag is
    // about the meeting category ("this requires travel"), not the buffer
    // length itself — that lives in profile.meetings.travel_buffer_minutes.
    requires_travel_buffer: z.boolean().optional(),
    // v2.6.5 — when true, colleague-path create_meeting checks the owner's
    // calendar for an existing same-attendee occurrence in the same week
    // BEFORE creating a new event. If found, the handler refuses with
    // existing_event_id + a message telling Sonnet to call move_meeting on
    // the existing one instead. Prevents duplicate-occurrence pattern (e.g.
    // colleague says "reinstate the BiWeekly" → Maelle creates a new one
    // while the original-day occurrence still sits on the calendar).
    // Owner curates which categories this applies to. Typical: Weekly,
    // Cadence — categories where the meeting series exists already.
    is_recurring: z.boolean().optional(),
    // v3.0.3 — when true, events tagged with this category are skipped by
    // the calendar-issue detector entirely. Use for personal categories
    // (e.g. "Personal") where overlaps / work_on_day_off / etc. shouldn't
    // be tracked because they're owner's life, not work calendar problems.
    no_issue_tracking: z.boolean().optional(),
  })).optional(),

  // v3.0.4 — preprocess null → undefined so `behavior:` with all children
  // commented out (parses to null) falls through to the .default() below.
  behavior: z.preprocess(v => v ?? undefined, z.object({
    // v2.6.3 — five vestigial fields removed: rescheduling_style,
    // adaptive_learning, escalate_after_days, can_contact_others_via_slack,
    // autonomous_meeting_creation. They were declared in the schema since
    // v1 but never read anywhere in src/. Old yamls with these fields still
    // boot — Zod strips unknown keys silently.
    // v1 safety net: post a shadow receipt in the owner's thread for every
    // autonomous action (DMs sent, meetings booked, etc.) even if no approval needed.
    // Lets the owner catch bugs in real time. Set to false once v1 is stable.
    v1_shadow_mode: z.boolean().default(false),
    // v2.1.1 — calendar-health mode. Same routine, same tool, different
    // outcome:
    //   passive (default) → detect issues + return report. Sonnet narrates
    //     to the owner, owner asks for fixes, Maelle executes per-tool.
    //   active → detect + execute safe fixes in one pass. Missing floating
    //     blocks get booked (via book_floating_block + floating-blocks helper),
    //     missing categories get set (high-confidence classifier only),
    //     busy-day threshold breaches fire a DM to the owner. Internal-
    //     overlap auto-resolve ships in v2.2 (needs move-coord state).
    calendar_health_mode: z.enum(['passive', 'active']).default('passive'),
    // v2.7.7 (Module G) — intent-aware tool scoping. When true, a pre-Sonnet
    // Haiku classifier picks the tool scopes relevant to this turn (e.g.
    // "meetings", "tasks") and getSkillTools filters the tool list to
    // always-on core + the chosen scopes. Cuts tools JSON from ~23k to ~12k
    // tokens per typical turn (uncached, billed every turn). When false (the
    // default), Sonnet sees all tools every turn (legacy behavior). Owner
    // path only — colleague path keeps the COLLEAGUE_ALLOWED_TOOLS allowlist
    // unchanged regardless.
    intent_aware_tools: z.boolean().default(false),
    // v2.7.7 (Module D) — deterministic auto-resolve for thread-bound vague-yes.
    // When true, a pre-orchestrator Haiku pre-pass detects short owner replies
    // that match a pending approval's thread (`terminal_dm_msg_ts`), classifies
    // verdict as 'approve' / 'reject' / 'pass_to_sonnet', and on approve/reject
    // calls resolveRequest directly — skipping the full Sonnet owner-DM turn.
    // Cuts latency from ~3s to ~300ms on these turns + removes a Sonnet-misroute
    // risk on multi-pending-approval threads. Amend cases pass through to Sonnet
    // (amend counter shape is approval-kind-specific; Haiku can't build it
    // reliably). Fails open: any classifier error → pass to Sonnet.
    deterministic_approval_resolve: z.boolean().default(false),
    // v2.2 — proactive colleague social knobs. Master on/off has moved to
    // `skills.social` (v2.6.2 rename + consolidation); this block keeps the
    // fine-tuning sub-config (window hours, cooldown, weekend skip).
    // The `enabled` field was retired — `skills.social: true` turns the
    // hourly tick on; `false` no-ops every dispatcher. Old yamls with
    // `enabled` still parse (kept optional below) but the value is ignored.
    proactive_colleague_social: z.object({
      enabled: z.boolean().optional(),  // legacy — value ignored, master is skills.social
      daily_window_hours: z.tuple([z.number(), z.number()]).default([13, 15]),
      cooldown_days: z.number().default(5),
      skip_weekends: z.boolean().default(true),
    }).default({
      daily_window_hours: [13, 15],
      cooldown_days: 5,
      skip_weekends: true,
    }),
  }).default({
    v1_shadow_mode: false,
    calendar_health_mode: 'passive',
    intent_aware_tools: false,
    deterministic_approval_resolve: false,
    proactive_colleague_social: { daily_window_hours: [13, 15], cooldown_days: 5, skip_weekends: true },
  })),

  // v3.0.4 — same null→undefined preprocess as behavior above.
  skills: z.preprocess(v => v ?? undefined, z.object({
    meetings: z.boolean().default(true),
    summary: z.boolean().default(false),         // was meeting_summaries
    knowledge: z.boolean().default(false),       // was knowledge_base
    calendar: z.boolean().default(true),         // was calendar_health
    search: z.boolean().default(true),
    // v2.6.3 — three vestigial toggles removed: email_drafting, proactive_alerts,
    // whatsapp. None had a matching skill in registry.ts; setting them to true
    // produced a one-time debug warn and otherwise no-op'd. Old yamls with
    // these fields still boot — Zod strips unknown keys silently.
    // v2.6.4 — research skill removed (placeholder that returned no tools).
    // Stronger search skill covers the same ground; old yamls with
    // `research: true|false` still boot — Zod strips it.
    // v2.6.2 (renamed from `persona` v2.2.3) — social engine. Master on/off
    // for everything social Maelle does: engage replies, codas (task-tail
    // warm lines), proactive cold-pings via the hourly outreach tick, topic
    // memory, engagement-rank ladder, social context blocks, social decay.
    // Default false — Maelle is task-only out of the box; opt in to the
    // friend-of-the-team behavior. The CORE memory layer (gender, name,
    // timezone, state, preferences, per-person md operational facts) is
    // always on regardless.
    social: z.boolean().default(false),
    // v2.9 — external-venue discovery + rank catalog. Off by default; flip true
    // to expose `find_venue` + `rank_venue` and auto-save bookings to the catalog.
    venue: z.boolean().default(false),
    // v3.2.6 — personalized, calendar-aware grounded news. Off by default; flip
    // true to expose the `news` tool and fold an "Updates" section into the
    // morning brief (topics + source steer taught via update_my_preferences).
    news: z.boolean().default(false),
    // Legacy aliases — auto-migrated at runtime; kept optional so old YAMLs boot.
    persona: z.boolean().optional(),             // → social (v2.6.2)
    scheduling: z.boolean().optional(),          // → meetings
    coordination: z.boolean().optional(),        // → meetings
    meeting_summaries: z.boolean().optional(),   // → summary
    knowledge_base: z.boolean().optional(),      // → knowledge
    calendar_health: z.boolean().optional(),     // → calendar
  }).default({
    meetings: true, summary: false, knowledge: false, calendar: true,
    search: true, social: false, venue: false, news: false,
  })),

  // Which communication channels the assistant is active on
  channels: z.object({
    slack: z.object({
      enabled: z.boolean(),
    }),
    email: z.object({
      enabled: z.boolean(),
    }).optional(),
    whatsapp: z.object({
      enabled: z.boolean(),
    }).optional(),
  }).default({ slack: { enabled: true } }),

  // v1.9.0 — outbound routing policy. Governs which Connection the router
  // picks when Maelle sends a message. Orthogonal to `channels` above
  // (which toggles inbound listeners).
  //
  // Three layers of resolution (src/connections/router.ts):
  //   1. SkillContext.inboundConnectionId — replies follow inbound transport
  //   2. PersonRef.preferred_external — per-recipient override on people_memory
  //   3. per_skill_routing[skill] — skill-specific override here
  //   4. default_routing — profile-wide default
  //   5. Hardcoded fallback: internal=slack, external=email
  connections: z.object({
    default_routing: z.object({
      internal: z.string().default('slack'),
      external: z.string().default('email'),
    }).default({ internal: 'slack', external: 'email' }),
    per_skill_routing: z.record(z.object({
      internal: z.string().optional(),
      external: z.string().optional(),
    })).optional(),
  }).default({
    default_routing: { internal: 'slack', external: 'email' },
  }),
});

// Canonical UserProfile — after the loader normalizes legacy fields.
// `work_hours` is always populated; `office_days.hours_start/hours_end` and
// `home_days.hours_start/hours_end` are stripped at load time. Callers
// MUST NOT read those legacy fields — they don't exist on the runtime object.
type _RawUserProfile = z.infer<typeof UserProfileSchema>;
export type UserProfile = Omit<_RawUserProfile, 'schedule'> & {
  schedule: Omit<_RawUserProfile['schedule'], 'office_days' | 'home_days' | 'work_hours'> & {
    office_days: { days: Array<'Sunday'|'Monday'|'Tuesday'|'Wednesday'|'Thursday'|'Friday'|'Saturday'>; notes?: string };
    home_days:   { days: Array<'Sunday'|'Monday'|'Tuesday'|'Wednesday'|'Thursday'|'Friday'|'Saturday'>; notes?: string };
    work_hours:  Record<'Sunday'|'Monday'|'Tuesday'|'Wednesday'|'Thursday'|'Friday'|'Saturday', string[]>;
  };
};

// ── Loader ────────────────────────────────────────────────────────────────────

const profileCache = new Map<string, UserProfile>();

export function loadUserProfile(profileName: string): UserProfile {
  if (profileCache.has(profileName)) {
    return profileCache.get(profileName)!;
  }

  const filePath = path.resolve(process.cwd(), 'config', 'users', `${profileName}.yaml`);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `User profile not found: ${filePath}\n` +
      `Copy config/users.example/user.example.yaml to config/users/${profileName}.yaml and fill it in.`
    );
  }

  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
  const parsed = UserProfileSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `  [${i.path.join('.')}] ${i.message}`)
      .join('\n');
    throw new Error(`Invalid user profile (${profileName}.yaml):\n${issues}`);
  }

  // v2.6.2 — legacy `skills.persona` → canonical `skills.social`. Code paths
  // outside the skills registry read `profile.skills.social` directly
  // (orchestrator gates, dispatchers, prompt-builder), so the migration has
  // to happen at PARSE time, not just at registry load. Idempotent — when
  // both are set, `social: true` wins (already canonical).
  const skillsAny = parsed.data.skills as { persona?: boolean; social: boolean };
  if (skillsAny.persona === true) {
    skillsAny.social = true;
  }

  // v3.0.4 — slack_display_name defaults to assistant.name when unset.
  // Common case: new owners don't want to think about a separate display name.
  const asst = parsed.data.assistant as { name: string; slack_display_name?: string };
  if (!asst.slack_display_name) {
    asst.slack_display_name = asst.name;
  }

  // v2.8.1 — normalize work_hours. If yaml uses the legacy shape
  // (office_days.hours_start/hours_end + home_days.hours_start/hours_end),
  // synthesize the canonical work_hours map from it. Then strip the legacy
  // fields so callers never see two sources of truth. If yaml already has
  // work_hours set, the legacy fields (if any) are ignored and stripped.
  const sched = parsed.data.schedule as {
    office_days: { days: string[]; hours_start?: string; hours_end?: string };
    home_days:   { days: string[]; hours_start?: string; hours_end?: string };
    work_hours?: Record<string, string[]>;
    night_shift?: { typical_day?: string; hours_start?: string; hours_end?: string };
  };

  if (!sched.work_hours || Object.keys(sched.work_hours).length === 0) {
    const wh: Record<string, string[]> = {};
    const officeStart = sched.office_days.hours_start;
    const officeEnd = sched.office_days.hours_end;
    const homeStart = sched.home_days.hours_start;
    const homeEnd = sched.home_days.hours_end;
    if (officeStart && officeEnd) {
      for (const d of sched.office_days.days) {
        wh[d] = [`${officeStart}-${officeEnd}`];
      }
    }
    if (homeStart && homeEnd) {
      for (const d of sched.home_days.days) {
        // If a day appears in BOTH lists (unusual), home wins by being last.
        wh[d] = [`${homeStart}-${homeEnd}`];
      }
    }
    if (Object.keys(wh).length === 0) {
      throw new Error(
        `Profile ${profileName}.yaml: no work_hours and no legacy hours_start/hours_end. ` +
        `Add a schedule.work_hours map, e.g.:\n  schedule:\n    work_hours:\n      Sunday: ["09:00-17:30"]\n      Monday: ["09:00-17:30"]\n      ...`,
      );
    }
    sched.work_hours = wh;
  }

  // v2.8.6 — auto-merge `night_shift` into the day's work_hours when the
  // typical_day is set. Before this, the night-shift block was a separate
  // concept used only by overlap/double-booking checks; the slot finder had
  // no knowledge of it, so a 22:30 Tuesday ask got rejected as
  // outside_owner_work_hours even though the owner's profile clearly defines
  // Tuesday as a night-shift day. Owner had to manually duplicate the range
  // into schedule.work_hours.Tuesday — the v2.8.1 "owner action" that never
  // got committed. With this synthesis it's automatic. If yaml also has an
  // explicit work_hours entry for the same day, the night_shift range is
  // APPENDED (split-shift), not replaced — so day + night both work.
  // hours_end="00:00" is treated as "23:59" so isSlotInWorkHours doesn't
  // wrap around midnight (we never bookwork past local midnight).
  const ns = sched.night_shift;
  if (ns?.typical_day && ns.hours_start && ns.hours_end) {
    const day = ns.typical_day;
    const endNormalized = ns.hours_end === '00:00' ? '23:59' : ns.hours_end;
    const range = `${ns.hours_start}-${endNormalized}`;
    const existing = sched.work_hours[day] ?? [];
    if (!existing.includes(range)) {
      sched.work_hours[day] = [...existing, range];
    }
  }

  // Strip legacy fields so callers can't accidentally read stale hours.
  delete sched.office_days.hours_start;
  delete sched.office_days.hours_end;
  delete sched.home_days.hours_start;
  delete sched.home_days.hours_end;

  profileCache.set(profileName, parsed.data as unknown as UserProfile);
  logger.info('User profile loaded', {
    profile: profileName,
    user: parsed.data.user.name,
    assistant: parsed.data.assistant.name,
  });

  return parsed.data as unknown as UserProfile;
}

export function loadAllProfiles(): Map<string, UserProfile> {
  const usersDir = path.resolve(process.cwd(), 'config', 'users');
  if (!fs.existsSync(usersDir)) return new Map();

  const profiles = new Map<string, UserProfile>();
  const files = fs.readdirSync(usersDir).filter(f => f.endsWith('.yaml'));

  for (const file of files) {
    const name = path.basename(file, '.yaml');
    try {
      profiles.set(name, loadUserProfile(name));
    } catch (err) {
      // Log clearly but don't crash — other profiles should still load
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to load profile "${name}" — fix the YAML and restart`, { error: message });
      // Also print directly to console so it's impossible to miss
      console.error(`\n❌ Profile error in config/users/${name}.yaml:\n${message}\n`);
    }
  }

  return profiles;
}

export function findProfileBySlackId(
  slackUserId: string,
  allProfiles: Map<string, UserProfile>
): UserProfile | null {
  for (const profile of allProfiles.values()) {
    if (profile.user.slack_user_id === slackUserId) return profile;
  }
  return null;
}

