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
    company: z.string().optional(),       // e.g. "Reflectiz" — used in identity/persona prompts
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
    lunch: z.object({
      preferred_start: z.string().regex(/^\d{2}:\d{2}$/),
      preferred_end: z.string().regex(/^\d{2}:\d{2}$/),
      duration_minutes: z.number().min(15).max(120),
      can_skip: z.boolean(),
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
    protected: z.array(z.object({
      name: z.string(),
      rule: z.enum(['never_move', 'never_override']),
      recurring: z.boolean().optional(),
    })),
  }),

  priorities: z.object({
    highest: z.array(z.string()),
    high: z.array(z.string()),
    medium: z.array(z.string()),
    low: z.array(z.string()),
  }),

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
    // v1.6.0: scheduling + coordination merged into meetings.
    meetings: z.boolean().default(true),
    email_drafting: z.boolean().default(false),
    meeting_summaries: z.boolean().default(false),
    proactive_alerts: z.boolean().default(false),
    whatsapp: z.boolean().default(false),
    search: z.boolean().default(true),
    research: z.boolean().default(false),
    calendar_health: z.boolean().default(true),
    // Legacy aliases — auto-migrated at runtime; kept optional so old YAMLs boot.
    scheduling: z.boolean().optional(),
    coordination: z.boolean().optional(),
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

