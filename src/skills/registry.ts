import Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillId, SkillContext } from './types';
import type { UserProfile } from '../config/userProfile';
import logger from '../utils/logger';
import { AssistantSkill } from '../core/assistant';
import { OutreachCoreSkill } from './outreach';
import { TasksSkill } from '../tasks/skill';
import { CronsSkill } from '../tasks/crons';
import { listConnections, getConnection } from '../connections/registry';

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
    {
      id: 'venue',
      loader: () => {
        // v2.9 — external venue discovery + rank catalog.
        const { VenueSkill } = require('./venue');
        return new VenueSkill();
      },
    },
    {
      id: 'news',
      loader: () => {
        // v3.2.6 — personalized, calendar-aware grounded news.
        const { NewsSkill } = require('./news');
        return new NewsSkill();
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
 * Module G (v2.7.7) — owner-side tool scoping.
 *
 * The orchestrator may pass a scope set (from classifyTurn) to filter
 * which tools Sonnet sees this turn. Tools listed here in ALWAYS_ON ship
 * every turn; every other tool maps to one scope and only ships when that
 * scope (or 'general') is requested.
 *
 * The scope filter is OWNER-PATH ONLY. Colleagues already have the static
 * COLLEAGUE_ALLOWED_TOOLS allowlist applied later in this file; scope is
 * not consulted for colleague turns.
 *
 * "general" is the widening scope — pass it (or include it alongside others)
 * to get every owner tool back. Returned by classifyTurn on uncertainty.
 *
 * Tools not in ALWAYS_ON and not in any scope map (forgotten? misnamed?) are
 * SHIPPED by default — better to over-include than to lose a tool silently.
 * They'll show up in the diagnostic log line.
 */
// v3.x (Block 2 Change A) — ALWAYS_ON slimmed from 22 → 12. The cut tools were
// expensive-and-rare on the common scheduling turn and have a natural home scope:
//   - person WRITES (update_person_profile 1.9k, update_person_memory,
//     confirm_gender, note_about_person, note_about_self) → 'people' scope.
//     READS stay always-on (get_person_memory, recall_interactions) so loading a
//     contact is always one call away. Person writes are also backstopped by the
//     end-of-chat capture pass, so a missed in-turn save is recovered.
//   - task detail (update_task, get_my_tasks, get_briefing, send_briefing_now)
//     → 'tasks' scope. create_task stays (cross-cutting; claim-checker refs it).
//   - web_extract → 'knowledge' scope (pairs with research). web_search stays.
const ALWAYS_ON_TOOLS = new Set<string>([
  // Memory + people READS + preference learning (cross-cutting, any turn).
  'manage_preference', 'update_my_preferences', 'get_person_memory', 'recall_interactions', 'log_interaction',
  // Outreach
  'message_colleague',
  // Tasks — create is cross-cutting (claim-checker references create_task by name).
  'create_task',
  // Approvals — any turn might escalate or resolve.
  'create_approval', 'resolve_approval', 'list_pending_approvals',
  // Slack directory lookups — any turn might need a slack_id.
  'find_slack_user', 'find_slack_channel',
  // Web — light research available anywhere.
  'web_search',
]);

const SCOPE_TO_TOOLS: Record<string, Set<string>> = {
  meetings: new Set<string>([
    // v3.x (Block 2 coord demotion) — the multi-party coordination tools
    // (coordinate_meeting + get_active_coordinations + cancel_coordination +
    // finalize_coord_meeting) moved OUT to the 'coord' scope below. They
    // hadn't legitimately fired in a month — the internal-Slack flow is direct
    // booking (find_available_slots → create_meeting), and shipping
    // coordinate_meeting on every scheduling turn was causing wrong-tool picks.
    // check_join_availability stays: it's the Route-2 "colleague joins an
    // existing meeting" flow, a live internal path distinct from coordination.
    'check_join_availability',
    'find_available_slots', 'get_calendar', 'analyze_calendar', 'get_free_busy',
    'create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting',
    'check_calendar_health', 'book_floating_block', 'set_event_category',
    // v2.9 — get_calendar_issues + update_calendar_issue merged.
    'manage_calendar_issue',
    // v3.3 — owner marks travel / working-elsewhere days (Working Elsewhere mode).
    'manage_working_elsewhere',
    // v2.9 — find_venue is reachable from a meetings-flavored turn
    // ("book coffee with Yael"); also lives in the 'venue' scope.
    'find_venue',
  ]),
  // v3.x (Block 2) — multi-party coordination (DM-poll several people for a
  // shared time). Rare; the classifier unions 'meetings' when it fires so
  // Sonnet still has the calendar reads. Kept as code for the future
  // email-external coordination path — just no longer shipped by default.
  coord: new Set<string>([
    'coordinate_meeting', 'get_active_coordinations', 'cancel_coordination',
    'finalize_coord_meeting',
  ]),
  tasks: new Set<string>([
    // v2.9 — 4 routine tools merged into manage_routine.
    'manage_routine',
    // v3.x (Change A) — task detail + briefing moved off ALWAYS_ON.
    'update_task', 'get_my_tasks', 'get_briefing', 'send_briefing_now',
  ]),
  knowledge: new Set<string>([
    // v2.9 — get_company_knowledge + ingest_knowledge_from_url merged.
    'manage_knowledge', 'classify_document',
    // v3.x (Change A) — deep URL fetch pairs with research; web_search stays always-on.
    'web_extract',
    // v3.2.6 — web_research (the deep PLAN→GATHER→READ engine) was UNMAPPED, so
    // filterToolsByScope shipped it on EVERY owner turn — which is why Maelle
    // kept reaching for deep research on news/scheduling/chit-chat turns. Map it
    // here with web_extract: it ships on research-flavored turns ('knowledge' /
    // 'general'), not by default. web_search stays always-on for quick facts.
    'web_research',
  ]),
  summary: new Set<string>([
    'classify_summary_feedback', 'share_summary', 'update_summary_draft',
    'learn_summary_style', 'list_speaker_unknowns',
  ]),
  // v3.x (Change A) — person WRITES live here, off the always-on set. The
  // classifier picks 'people' when a turn teaches Maelle a durable fact about
  // someone. Person READS (get_person_memory / recall_interactions) stay
  // always-on; the end-of-chat capture pass backstops any missed in-turn write.
  // note_about_* are SocialSkill tools — listed here too, but only ship when
  // social is on (filterToolsByScope works off the actually-loaded tool list).
  people: new Set<string>([
    'update_person_profile', 'update_person_memory', 'confirm_gender',
    'note_about_person', 'note_about_self',
  ]),
  // 'social' scope is a recognized NO-OP signal scope (person writes moved to
  // 'people' v3.x). Kept so the enum stays stable; ships nothing extra.
  social: new Set<string>([]),
  // v2.9 — venue skill: external-venue discovery and rank curation.
  // find_venue is also useful from a meetings-shaped turn (booking a coffee
  // chat), so it's accessible through both 'venue' and 'meetings' scopes
  // via the union semantics in filterToolsByScope.
  venue: new Set<string>([
    'find_venue', 'rank_venue',
  ]),
  // v3.2.6 — personalized grounded news. Ships only when the classifier picks
  // 'news' (or 'general'); a non-news turn pays zero tokens for it.
  news: new Set<string>([
    'news',
  ]),
};

/**
 * Decide which tools to ship for an owner turn given the scope set from
 * classifyTurn. Returns the union of always-on tools + tools in any
 * of the requested scopes. 'general' (or no scope) → all tools, no filter.
 */
function filterToolsByScope(
  allTools: import('@anthropic-ai/sdk').default.Tool[],
  scopes: string[] | undefined,
): import('@anthropic-ai/sdk').default.Tool[] {
  if (!scopes || scopes.length === 0 || scopes.includes('general')) {
    return allTools;
  }
  // v3.x — 'coord' and 'calendar' both imply 'meetings': coordination needs the
  // calendar reads to reason about times, and a calendar-review turn needs the
  // health/read tools (which live in the meetings scope). Expand deterministically
  // here so the turn is safe even if the classifier emits the sub-scope alone.
  let effectiveScopes = scopes;
  if ((scopes.includes('coord') || scopes.includes('calendar')) && !scopes.includes('meetings')) {
    effectiveScopes = [...scopes, 'meetings'];
  }
  // Build the set of allowed tool names: always-on + every tool in any
  // requested scope.
  const allowed = new Set<string>(ALWAYS_ON_TOOLS);
  for (const scope of effectiveScopes) {
    const tools = SCOPE_TO_TOOLS[scope];
    if (tools) for (const t of tools) allowed.add(t);
  }
  // Tools not in always-on and not in any known scope → ship anyway. This
  // catches the "forgot to map it" case so new tools don't disappear silently.
  const KNOWN_SCOPED = new Set<string>();
  for (const set of Object.values(SCOPE_TO_TOOLS)) for (const t of set) KNOWN_SCOPED.add(t);
  const filtered = allTools.filter(t => {
    if (allowed.has(t.name)) return true;
    if (!KNOWN_SCOPED.has(t.name) && !ALWAYS_ON_TOOLS.has(t.name)) {
      // Unmapped → keep + log once (per process) so the omission is fixable.
      logUnmappedToolOnce(t.name);
      return true;
    }
    return false;
  });
  return filtered;
}

const _unmappedLoggedOnce = new Set<string>();
function logUnmappedToolOnce(toolName: string): void {
  if (_unmappedLoggedOnce.has(toolName)) return;
  _unmappedLoggedOnce.add(toolName);
  logger.warn('Module G — tool not mapped to ALWAYS_ON or any scope; shipping by default', { tool: toolName });
}

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
  // v3.1.4 (Y3) — a colleague who REQUESTED a meeting controls it: add people,
  // rename, change location. The update_meeting handler gates this on
  // requester-identity (findMeetingOwner): requester → allowed; non-requester
  // → returns a clean needs-approval signal so Sonnet fires ONE create_approval.
  // Pre-fix update_meeting was blocked here, so a colleague's "add Eli + rename"
  // had no correct tool — Sonnet flailed through create/move (both rule-failed),
  // burned the rate limit, and punted vaguely to the owner.
  'update_meeting',
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
  // v3.0.3 — colleague-path KB. INTERNAL colleagues only; the manage_knowledge
  // handler gates externally (sender's email domain ≠ owner's domain → blocked).
  // Sub-action 'get' is allowed; 'ingest' is owner-only (handler enforces). KB
  // content makes colleague conversations smarter without leaking to externals.
  'manage_knowledge',
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
  // v2.8.5 — also DELETE the legacy keys after the migration. Pre-fix the
  // loop below iterated over the stale keys, couldn't find them in
  // SKILL_MAP, and fired the "enabled in profile but not available"
  // debug warning once per process per stale key. Harmless but noisy.
  const toggles: Record<string, boolean | undefined> = { ...(profile.skills as any) };
  if (toggles.scheduling || toggles.coordination) toggles.meetings = true;
  delete toggles.scheduling;
  delete toggles.coordination;
  if (toggles.meeting_summaries) toggles.summary = true;
  delete toggles.meeting_summaries;
  if (toggles.knowledge_base) toggles.knowledge = true;
  delete toggles.knowledge_base;
  if (toggles.calendar_health) toggles.calendar = true;
  delete toggles.calendar_health;
  // v2.6.2 — `persona` skill was renamed to `social`. Old yamls auto-migrate.
  if (toggles.persona) toggles.social = true;
  delete toggles.persona;

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
 *
 * v2.7.7 (Module G) — owner-path only: `scopes` filters the tool list to
 * (always-on core) ∪ (tools in any requested scope). Pass undefined (or
 * include 'general') to ship every tool. Colleagues always see the static
 * allowlist regardless of `scopes`.
 */
export function getSkillTools(
  profile: UserProfile,
  senderRole: 'owner' | 'colleague' = 'owner',
  scopes?: string[],
): Anthropic.Tool[] {
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

  // v2.6.4 — Connection-bound tools (e.g. Slack's find_slack_channel) live
  // on the Connection itself, not as a separate skill. Merge them in here so
  // Sonnet sees one unified tool list. Same dedupe + colleague filter applies.
  const profileId = profile.user.slack_user_id;
  const connectionTools: Anthropic.Tool[] = [];
  for (const connId of listConnections(profileId)) {
    const conn = getConnection(profileId, connId);
    if (conn?.getTools) {
      try {
        connectionTools.push(...conn.getTools(profile));
      } catch (err) {
        logger.warn(`Connection "${connId}" getTools() failed`, { err: String(err) });
      }
    }
  }

  // Deduplicate by tool name
  const allTools = [...assistantTools, ...skillTools, ...connectionTools];
  const seen = new Set<string>();
  const deduped = allTools.filter(t => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });

  // Colleagues only get the explicitly allowed subset — block everything else.
  // Scope filter does NOT apply on the colleague path (the static allowlist is
  // the hard limit; scope would be redundant).
  if (senderRole === 'colleague') {
    return deduped.filter(t => COLLEAGUE_ALLOWED_TOOLS.has(t.name));
  }

  // Owner-path Module G filter (no-op if scopes is undefined or includes 'general').
  return filterToolsByScope(deduped, scopes);
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
      logger.error(`Skill "${alwaysSkill.name}" threw during tool "${toolName}"`, {
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
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
      logger.error(`Skill "${skill.name}" threw during tool "${toolName}"`, {
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return { error: `Tool "${toolName}" failed: ${String(err)}` };
    }
  }

  // v2.6.4 — fall through to registered Connections (find_slack_channel etc.).
  const profileId = context.profile.user.slack_user_id;
  for (const connId of listConnections(profileId)) {
    const conn = getConnection(profileId, connId);
    if (conn?.executeToolCall) {
      try {
        const result = await conn.executeToolCall(toolName, args);
        if (result !== null) {
          logger.info('Tool executed', { tool: toolName, connection: connId });
          return result;
        }
      } catch (err) {
        logger.error(`Connection "${connId}" threw during tool "${toolName}"`, { err: String(err) });
        return { error: `Tool "${toolName}" failed: ${String(err)}` };
      }
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
export function buildSkillsPromptSection(profile: UserProfile, scopes?: string[], isOwner?: boolean): string {
  return getActiveSkills(profile)
    .map(skill => {
      try {
        return skill.getSystemPromptSection(profile, scopes, isOwner);
      } catch (err) {
        logger.warn(`Skill "${skill.name}" getSystemPromptSection() failed`, { err: String(err) });
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}
