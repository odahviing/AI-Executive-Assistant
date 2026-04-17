import Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillId, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import logger from '../utils/logger';
import { AssistantSkill } from '../core/assistant';
import { OutreachCoreSkill } from '../core/outreach';
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
  'store_request',
  'coordinate_meeting',
  'check_join_availability',
  'web_search',
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

  for (const [id, enabled] of Object.entries(toggles)) {
    if (!enabled) continue;
    const skill = SKILL_MAP.get(id as SkillId);
    if (!skill) {
      if (enabled) {
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
