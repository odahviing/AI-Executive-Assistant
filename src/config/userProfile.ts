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

const VipContactSchema = z.object({
  name: z.string().min(2),
  email: z.string().email().optional(),
  priority: z.enum(['highest', 'high', 'medium', 'low']),
  note: z.string().optional(),
});

// Rescheduling rule — three distinct behaviours:
//   immutable       → cannot be moved under any circumstance (e.g. board meetings, leadership sync, or whatever the user defines)
//   flexible   → can be moved within bounds, no approval needed
//   approval   → requires explicit user approval before moving
const ReschedulingRuleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('immutable'),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('flexible'),
    flexibility: z.enum(['same_week', 'same_or_next_week']),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('approval_required'),
    description: z.string().optional(),
  }),
]);

const UserProfileSchema = z.object({

  user: z.object({
    name: ProfessionalNameSchema,
    name_he: z.string().optional(),   // Hebrew spelling of the user's name, e.g. "עידן"
    email: CompanyEmailSchema,
    role: z.string().min(2),
    slack_user_id: z.string().regex(/^U[A-Z0-9]+$/, 'Slack user ID must start with U followed by uppercase letters/numbers'),
    timezone: z.string().min(3),
    language: z.string().default('en'),
    units: z.enum(['metric', 'imperial']).default('metric'),
    company: z.string().optional(),       // company name — used in identity/persona prompts
    company_brief: z.string().optional(), // short paragraph injected into system prompt so assistant knows the business
  }),

  assistant: z.object({
    name: AssistantNameSchema,
    slack_display_name: z.string().min(2).max(80),
    email: CompanyEmailSchema.optional(),
    persona: z.string().min(20),

    // Each assistant has their own dedicated Slack app
    // Create at https://api.slack.com/apps — one app per assistant identity
    slack: z.object({
      bot_token: z.string().startsWith('xoxb-', 'Bot token must start with xoxb-'),
      app_token: z.string().startsWith('xapp-', 'App-level token must start with xapp-'),
      signing_secret: z.string().min(10, 'Signing secret too short — check your Slack app dashboard'),
    }),
  }),

  schedule: z.object({
    office_days: z.object({
      days: z.array(z.enum(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])).min(1),
      hours_start: z.string().regex(/^\d{2}:\d{2}$/),
      hours_end: z.string().regex(/^\d{2}:\d{2}$/),
      notes: z.string().optional(),
    }),
    home_days: z.object({
      days: z.array(z.enum(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])).min(1),
      hours_start: z.string().regex(/^\d{2}:\d{2}$/),
      hours_end: z.string().regex(/^\d{2}:\d{2}$/),
      notes: z.string().optional(),
    }),
    timezone_preferences: z.object({
      local_participants: z.string(),
      remote_participants: z.string(),
      note: z.string().optional(),
    }),
    night_shift: z.object({
      hours_start: z.string().regex(/^\d{2}:\d{2}$/),
      hours_end: z.string().regex(/^\d{2}:\d{2}$/),
      typical_day: z.string().optional(),
      blocking_event: z.string(),
      note: z.string().optional(),
    }).optional(),
    // Owner's mental day boundary. Local-clock hour before which "today"
    // is still treated as the previous calendar day — late-night work
    // bleeds backwards into the workday it belongs to. Anchors the prompt's
    // DATE LOOKUP table and the date verifier's lookup so they agree about
    // what day "today" / "tomorrow" mean. Format "HH:MM". Default "00:00"
    // (no shift — owner's day boundary is real midnight).
    day_boundary_hour: z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
  }),

  meetings: z.object({
    allowed_durations: z.array(z.number()).min(1),
    buffer_minutes: z.number().min(0).max(30),
    // Thinking-time protection — how much quality free time ${user} wants
    // preserved per day. Office days and home days can differ because the
    // owner usually blocks more deep-work on office days.
    free_time_per_office_day_hours: z.number().min(0).max(8),
    // v1.6.11 — optional home-day threshold. Falls back to office value if
    // unset (old profiles keep their previous behavior).
    free_time_per_home_day_hours: z.number().min(0).max(8).optional(),
    thinking_time_min_chunk_minutes: z.number().min(15).max(120).default(30),
    min_slot_buffer_hours: z.number().min(0).max(12).default(4),
    physical_meetings_require_office_day: z.boolean(),
    room_email: z.string().email().optional(),   // e.g. "meeting@company.com" — used to book physical meeting rooms
    // v2.3.2 (1C) — owner's actual office address for physical meetings.
    // Lands in the calendar invite location so external attendees know where
    // to go (vs. just "Idan's Office" label which means nothing to them).
    // All fields optional — if unset, fall back to the legacy label-only behavior.
    office_location: z.object({
      label: z.string().optional(),     // override the "${name}'s Office" label
      address: z.string().optional(),   // street address, building, floor
      parking: z.string().optional(),   // parking instructions for visitors
    }).optional(),
    // v2.1.1 — each entry must supply EITHER name (subject match, existing)
    // OR category (Outlook-category match, new). This is additive-compatible:
    // existing profiles with only `name` keep working. When the owner adds an
    // Outlook category (e.g. "Protected") in the future, a single yaml entry
    // `{category: "Protected", rule: "never_move"}` auto-protects every event
    // tagged with it — no code change.
    protected: z.array(z.object({
      name: z.string().optional(),
      category: z.string().optional(),
      rule: z.enum(['never_move', 'never_override']),
      recurring: z.boolean().optional(),
    }).refine(p => !!p.name || !!p.category, {
      message: 'protected entry must have either `name` or `category`',
    })),
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
    })).optional(),
  }),

  priorities: z.object({
    highest: z.array(z.string()),
    high: z.array(z.string()),
    medium: z.array(z.string()),
    low: z.array(z.string()),
  }),

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
    // When true, events created under this category are stamped with
    // sensitivity='private' on the Graph side. Lets the owner mark a
    // category as "personal/sensitive" without code knowing the literal
    // name. Default false.
    sets_sensitivity_private: z.boolean().optional(),
  })).optional(),

  vip_contacts: z.array(VipContactSchema).default([]),

  behavior: z.object({
    rescheduling_style: z.enum(['conservative', 'balanced', 'proactive']),
    adaptive_learning: z.boolean(),
    escalate_after_days: z.number().min(0).max(14),
    can_contact_others_via_slack: z.boolean(),
    autonomous_meeting_creation: z.boolean(),
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
    // v2.2 — proactive colleague social. When enabled, a system-level
    // hourly tick picks one colleague per day whose LOCAL time is in the
    // mid-day window and sends a short warm check-in. Rank-aware
    // (engagement_rank 0 = opt-out) + cooldown + no weekend.
    proactive_colleague_social: z.object({
      enabled: z.boolean().default(false),
      daily_window_hours: z.tuple([z.number(), z.number()]).default([13, 15]),
      cooldown_days: z.number().default(5),
      skip_weekends: z.boolean().default(true),
    }).default({
      enabled: false,
      daily_window_hours: [13, 15],
      cooldown_days: 5,
      skip_weekends: true,
    }),
  }),

  // Rescheduling rules — now strongly typed with discriminated union
  // Each key is a meeting category name
  rescheduling: z.record(ReschedulingRuleSchema),

  interviews: z.object({
    max_per_day: z.number().min(1).max(10),
    title_prefix: z.string(),   // used to detect interview events on the calendar
    note: z.string().optional(),
  }).optional(),

  skills: z.object({
    // v1.7.6 — single-word skill names. Each identifies a capability the agent
    // can DO (search, summary, knowledge). Legacy multi-word keys still parse
    // and auto-migrate at runtime in skills/registry.ts.
    meetings: z.boolean().default(true),
    email_drafting: z.boolean().default(false),
    summary: z.boolean().default(false),         // was meeting_summaries
    knowledge: z.boolean().default(false),       // was knowledge_base
    calendar: z.boolean().default(true),         // was calendar_health
    proactive_alerts: z.boolean().default(false),
    whatsapp: z.boolean().default(false),
    search: z.boolean().default(true),
    research: z.boolean().default(false),
    // v2.2.3 (#3) — persona / social layer. Toggable bonus capability:
    // off-topic chat, gaming/NBA/family conversation tracking, the 30-category
    // social engine, proactive colleague pings, hourly outreach tick. Default
    // false — Maelle is task-only out of the box; opt in to the friend-of-the-
    // team behavior. The CORE memory layer (gender, name, timezone, state,
    // preferences, per-person md operational facts) is always on regardless.
    persona: z.boolean().default(false),
    // Legacy aliases — auto-migrated at runtime; kept optional so old YAMLs boot.
    scheduling: z.boolean().optional(),          // → meetings
    coordination: z.boolean().optional(),        // → meetings
    meeting_summaries: z.boolean().optional(),   // → summary
    knowledge_base: z.boolean().optional(),      // → knowledge
    calendar_health: z.boolean().optional(),     // → calendar
    general_knowledge: z.boolean().optional(),
  }),

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

export type UserProfile = z.infer<typeof UserProfileSchema>;
export type VipContact = z.infer<typeof VipContactSchema>;
export type ReschedulingRule = z.infer<typeof ReschedulingRuleSchema>;

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

  profileCache.set(profileName, parsed.data);
  logger.info('User profile loaded', {
    profile: profileName,
    user: parsed.data.user.name,
    assistant: parsed.data.assistant.name,
    vips: parsed.data.vip_contacts.length,
  });

  return parsed.data;
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

