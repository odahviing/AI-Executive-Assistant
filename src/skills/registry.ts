import Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillId, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import logger from '../utils/logger';
import { AssistantSkill } from '../core/assistant';
import { OutreachCoreSkill } from './outreach';
import { TasksSkill } from '../tasks/skill';
import { CronsSkill } from '../tasks/crons';

// Core modules — always active, not toggled in user profile.
// v1.6.0: MeetingsSkill (née CoordinationSkill) is now togglable.
// v1.6.1: OutreachCoreSkill extracted from AssistantSkill — memory (assistant)
//         and messaging (outreach) are now separate core modules.
const ASSISTANT_MODULE   = new AssistantSkill();
const OUTREACH_MODULE    = new OutreachCoreSkill();
const TASKS_MODULE       = new TasksSkill();
const CRONS_MODULE       = new CronsSkill();
const CORE_MODULES = [ASSISTANT_MODULE, OUTREACH_MODULE, TASKS_MODULE, CRONS_MODULE];

/**
 * Skills are registered lazily — if a skill fails to load it is skipped,
 * not crashed. This means unbuilt/stub skills never take down the service.
 */

// v2.3.2 — process-wide guard against per-turn debug spam from yaml toggles
// pointing at not-yet-implemented skills. Keyed `${profileId}:${skillId}`.
const warnedMissingSkills = new Set<string>();

function tryLoadSkill(name: string, loader: () => Skill): Skill | null {
  try {
    return loader();
  } catch (err) {
    logger.warn(`Skill "${name}" failed to load — skipping`, { err: String(err) });
    return null;
  }
}

function buildSkillMap(): Map<SkillId, Skill> {
  const candidates: Array<{ id: SkillId; loader: () => Skill }> = [
    {
      id: 'meetings',
      loader: () => {
        const { MeetingsSkill } = require('./meetings');
        return new MeetingsSkill();
      },
    },
    {
      id: 'search',
      loader: () => {
        const { SearchSkill } = require('./general');
        return new SearchSkill();
      },
    },
    {
      id: 'research',
      loader: () => {
        const { ResearchSkill } = require('./research');
        return new ResearchSkill();
      },
    },
    {
      id: 'calendar',
      loader: () => {
        const { CalendarHealthSkill } = require('./calendarHealth');
        return new CalendarHealthSkill();
      },
    },
    {
      id: 'summary',
      loader: () => {
        const { SummarySkill } = require('./summary');
        return new SummarySkill();
      },
    },
    {
      id: 'knowledge',
      loader: () => {
        const { KnowledgeBaseSkill } = require('./knowledge');
        return new KnowledgeBaseSkill();
      },
    },
    {
      id: 'social',
      loader: () => {
        // v2.6.2 (was 'persona' v2.2.3) — togglable social engine.
        const { SocialSkill } = require('./social');
        return new SocialSkill();
      },
    },
  ];

  const map = new Map<SkillId, Skill>();
  for (const { id, loader } of candidates) {
    const skill = tryLoadSkill(id, loader);
    if (skill) map.set(id, skill);
  }
  return map;
}

// Built once at startup — not rebuilt per request
const SKILL_MAP = buildSkillMap();

/**
 * Tools a colleague (non-owner) is allowed to trigger.
 * Everything else is owner-only — blocked before it reaches Claude.
 *
 * Colleagues can:
 *   - Look up workspace members
 *   - Check availability / free-busy
 *   - Request / coordinate a meeting with the owner
 *
 * Colleagues cannot:
 *   - Read or write owner preferences / memory
 *   - See task lists, briefings, or interaction history
 *   - Send messages on the owner's behalf
 *   - Cancel or modify existing coordinations
 *   - Create or delete calendar events
 */
const COLLEAGUE_ALLOWED_TOOLS = new Set([
  'find_slack_user',
  'get_calendar',
  'get_free_busy',
  'find_available_slots',
  // v2.0.7 — store_request retired. Colleague-initiated asks that need owner
  // input now go through create_task + create_approval, both of which ARE in
  // this allowlist so a colleague-path Sonnet can flag things up to the owner.
  'create_task',
  'create_approval',
  'coordinate_meeting',
  'check_join_availability',
  'web_search',
  // v2.2.1 — inbound reschedule auto-accept. Colleagues can ask Maelle to move
  // an existing meeting; the move_meeting handler has a colleague-path gate
  // that runs a rule-compliance check via findAvailableSlots. Rule-compliant
  // slot → moves silently + shadow-DMs owner. Rule-breaking slot → returns
  // needs_owner_approval=true so Sonnet falls back to create_approval. Owner
  // retains veto via the approval path when rules break.
  'move_meeting',
  // v2.3.2 — inbound 1:1 booking auto-accept. When a colleague has confirmed
  // slot + duration + subject in this DM, Maelle calls create_meeting directly
  // instead of falling back to "you send the invite" or kicking off a redundant
  // coordinate_meeting DM. The handler enforces: single colleague-attendee
  // (themselves), rule-compliant slot, English subject. Auto shadow-DMs owner.
  // Same trust pattern as v2.2.1 move_meeting — rule-compliance is the gate.
  'create_meeting',
  // v2.5.2 — self-write reopening. Personal-knowledge tools were over-tightened
  // pre-v2.4 as a side-effect of broader colleague-path defense. The product
  // model is: people memory + travel + social engagement are FOR colleagues —
  // they exist so Maelle is smarter with them. Each tool below is allowed on
  // the colleague path with a SELF-ONLY constraint enforced in its handler:
  // a colleague can write only about themselves, never about another person
  // (including the owner). The handler-side checks live in core/assistant.ts
  // (note_about_person, log_interaction, confirm_gender, update_person_profile)
  // and skills/social.ts (note_about_self is implicitly self-only — it writes
  // to context.userId by definition).
  //
  // What stays owner-only (still in the hard-block list at assistant.ts):
  //   learn_preference, forget_preference, recall_preferences,
  //   update_person_memory, get_person_memory, finalize_coord_meeting
  // — these touch owner's catalog or other people's memory and have no
  // self-only equivalent on the colleague side.
  //
  // update_person_profile colleague path also filters args to a self-writable
  // subset (timezone, state, working_hours, currently_traveling, language,
  // name_he) — colleagues can update operational fields about themselves but
  // not relationship fields (engagement_rank, role_summary, etc.) which the
  // owner curates.
  'update_person_profile',
  'note_about_person',
  'note_about_self',
  'confirm_gender',
  'log_interaction',
]);

/**
 * Returns the list of skills that are:
 *   1. enabled in the user's YAML profile
 *   2. successfully loaded (not crashed on require)
 */
export function getActiveSkills(profile: UserProfile): Skill[] {
  const active: Skill[] = [];

  // v1.6.0 — profile migration: `scheduling` and `coordination` both became
  // `meetings`. If an older YAML still has either, treat as meetings=true so
  // the profile boots without edits. Duplicates (both set) are idempotent.
  // v1.7.6 — three more renames: meeting_summaries → summary,
  // knowledge_base → knowledge, calendar_health → calendar.
  const toggles: Record<string, boolean | undefined> = { ...(profile.skills as any) };
  if (toggles.scheduling || toggles.coordination) toggles.meetings = true;
  if (toggles.meeting_summaries) toggles.summary = true;
  if (toggles.knowledge_base) toggles.knowledge = true;
  if (toggles.calendar_health) toggles.calendar = true;
  // v2.6.2 — `persona` skill was renamed to `social`. Old yamls auto-migrate.
  if (toggles.persona) toggles.social = true;

  for (const [id, enabled] of Object.entries(toggles)) {
    if (!enabled) continue;
    const skill = SKILL_MAP.get(id as SkillId);
    if (!skill) {
      // v2.3.2 — warn once per (profile, skill) per process. getActiveSkills
      // is called 4× per orchestrator turn (tools, exec, prompt, section),
      // and three forward-looking yaml toggles produced 12 debug lines per
      // turn pre-fix. Cache key is profile.user.slack_user_id : id so a typo
      // still surfaces once for whichever owner has it.
      const cacheKey = `${profile.user.slack_user_id}:${id}`;
      if (!warnedMissingSkills.has(cacheKey)) {
        warnedMissingSkills.add(cacheKey);
        logger.debug(`Skill "${id}" is enabled in profile but not available — skipping`, {
          user: profile.user.name,
        });
      }
      continue;
    }
    active.push(skill);
  }

  return active;
}

/**
 * Collect all Anthropic tool definitions from active skills.
 * When senderRole is 'colleague', only tools in COLLEAGUE_ALLOWED_TOOLS are returned —
 * this is a hard technical control, not just a prompt instruction.
 */
export function getSkillTools(profile: UserProfile, senderRole: 'owner' | 'colleague' = 'owner'): Anthropic.Tool[] {
  // Always include assistant and coordination skill tools regardless of config
  const assistantTools = CORE_MODULES.flatMap(s => s.getTools(profile));

  const skillTools = getActiveSkills(profile).flatMap(skill => {
    try {
      return skill.getTools(profile);
    } catch (err) {
      logger.warn(`Skill "${skill.name}" getTools() failed — no tools from this skill`, { err: String(err) });
      return [];
    }
  });

  // Deduplicate by tool name
  const allTools = [...assistantTools, ...skillTools];
  const seen = new Set<string>();
  const deduped = allTools.filter(t => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });

  // Colleagues only get the explicitly allowed subset — block everything else
  if (senderRole === 'colleague') {
    return deduped.filter(t => COLLEAGUE_ALLOWED_TOOLS.has(t.name));
  }

  return deduped;
}

/**
 * Route a tool call to whichever active skill handles it.
 * If no skill handles it, returns a safe error object (never throws).
 */
export async function executeSkillTool(
  toolName: string,
  args: Record<string, unknown>,
  context: SkillContext,
): Promise<unknown> {
  const activeSkills = getActiveSkills(context.profile);

  // Always try always-active skills first (memory, coordination)
  for (const alwaysSkill of CORE_MODULES) {
    try {
      const result = await alwaysSkill.executeToolCall(toolName, args, context);
      if (result !== null) {
        logger.info('Tool executed', { tool: toolName, skill: alwaysSkill.name });
        return result;
      }
    } catch (err) {
      logger.error(`Skill "${alwaysSkill.name}" threw during tool "${toolName}"`, { err: String(err) });
      return { error: `Tool "${toolName}" failed: ${String(err)}` };
    }
  }

  for (const skill of activeSkills) {
    try {
      const result = await skill.executeToolCall(toolName, args, context);
      if (result !== null) {
        logger.info('Tool executed', { tool: toolName, skill: skill.name });
        return result;
      }
    } catch (err) {
      logger.error(`Skill "${skill.name}" threw during tool "${toolName}"`, { err: String(err) });
      return { error: `Tool "${toolName}" failed: ${String(err)}` };
    }
  }

  logger.warn('No skill handled tool', { tool: toolName, user: context.profile.user.name });
  return { error: `No active skill handles tool: ${toolName}` };
}

/**
 * Build the skills section of the system prompt.
 * Each active skill contributes its own rules block.
 * Fails gracefully per skill — one bad skill doesn't blank the whole prompt.
 */
export function buildSkillsPromptSection(profile: UserProfile): string {
  return getActiveSkills(profile)
    .map(skill => {
      try {
        return skill.getSystemPromptSection(profile);
      } catch (err) {
        logger.warn(`Skill "${skill.name}" getSystemPromptSection() failed`, { err: String(err) });
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}
