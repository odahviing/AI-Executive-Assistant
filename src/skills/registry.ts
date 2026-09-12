import Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillId, SkillContext, ChannelId } from './types';
import type { UserProfile } from '../config/userProfile';
import logger from '../utils/logger';
import { AssistantSkill } from '../core/assistant';
import { OutreachCoreSkill } from './outreach';
import { TasksSkill } from '../tasks/skill';
import { CronsSkill } from '../tasks/crons';
import { getConnection } from '../connections/registry';
import { registerToolNames } from '../utils/textScrubber';

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
    // check_join_availability is the Route-2 "colleague joins an existing
    // meeting" flow — a live internal path. (The multi-party coordination tools
    // were removed with the coord subsystem in v3.4.x; all scheduling is now the
    // direct path: find_available_slots → create_meeting.)
    'check_join_availability',
    'find_available_slots', 'get_calendar', 'analyze_calendar', 'get_free_busy',
    'create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting',
    'check_calendar_health', 'book_floating_block', 'set_event_category',
    // v2.9 — get_calendar_issues + update_calendar_issue merged.
    'manage_calendar_issue',
    // v3.8.x — these were added after the scope map and never mapped, so Module G
    // shipped them on EVERY owner turn + logged "tool not mapped" each restart:
    // per-date schedule overrides (#143, replaced the WE spine), slot holds (#30),
    // and the calendar-health auto-move revert (v3.7.2). All meeting/schedule turns.
    'set_work_schedule_override', 'get_work_schedule_overrides', 'hold_slot', 'revert_last_auto_move',
    // v2.9 — find_venue is reachable from a meetings-flavored turn
    // ("book coffee with Yael"); also lives in the 'venue' scope.
    'find_venue',
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
 * v4.3.0 (#24) — per-CHANNEL tool clamp, keyed on the turn's inbound
 * transport (not on scope, not on senderRole). The email transport's sender
 * gate is a spoofable From-header string compare (owner-accepted risk —
 * containment is that a spoofed sender only ever gets a reply to the OWNER'S
 * OWN mailbox, never a disclosure elsewhere). But that containment does NOT
 * cover WRITES: a forged forward could still book a real Outlook invite to
 * real externals under the owner's name. So the email channel earns a much
 * narrower ACTION set than the scope map would otherwise ship.
 *
 * gh#24 wave follow-up (combined verify + owner ruling) — at the time, the
 * clamp was applied AFTER the ALWAYS_ON_TOOLS union (see filterToolsByScope
 * below) — an ordering the row 122 follow-up below later replaced, because
 * back then the original 2-tool clamp silently stripped get_person_memory /
 * log_interaction too — an email turn could never read the person row the
 * inbound handler writes on that same turn. Owner, verbatim: "get person memory is
 * important, log intreaction as well. but create approval or move/cancel ->
 * no need for now." The clamp is now an explicit 4-tool allowlist —
 * find_available_slots + create_meeting ("find a slot and book it," the
 * original owner instruction) plus get_person_memory + log_interaction
 * (read/record who this is). Deliberately still excludes:
 *   - create_approval / resolve_approval / list_pending_approvals — no
 *     escalation on this leg for now.
 *   - move_meeting / delete_meeting — this is the write clamp that bounds a
 *     spoofed forward to "creates a junk meeting I can delete," never
 *     "moves or cancels a real one."
 *   - message_colleague / find_slack_user / find_slack_channel —
 *     Slack-emitting; an email turn must never reach Slack.
 *   - recall_interactions / create_task / manage_preference /
 *     update_my_preferences / web_search — the owner named two memory
 *     tools specifically, not the whole always-on family. Widening this set
 *     again needs another explicit ruling, not an inferred "helpful" add.
 * Applied INSIDE filterToolsByScope (below) — not a second, parallel filter
 * living elsewhere — and mirrored at the executeSkillTool dispatch
 * chokepoint (same constant, read directly) so a call can't reach a handler
 * outside the allowlist regardless of how the tool_use got named.
 *
 * gh#24 row 122 follow-up (combined verify + owner ruling) — that AFTER-the-
 * union ordering was itself a bug: any classifier scope pick that wasn't
 * meetings/calendar/general already dropped find_available_slots/
 * create_meeting from the pre-clamp set (they live only in the 'meetings'
 * scope, not ALWAYS_ON_TOOLS), so the clamp intersection could only ever
 * subtract further — down to just the two ALWAYS_ON memory tools, silently,
 * on any classifier misfire. filterToolsByScope now treats a channel clamp as
 * AUTHORITATIVE: when one applies, scope-narrowing is skipped entirely and
 * the clamp is intersected with the full active tool set directly, so a
 * clamped channel's shipped set is a fixed function of (active skills,
 * channel) — never of the classifier's pick.
 */
const CHANNEL_TOOL_CLAMP: Partial<Record<ChannelId, Set<string>>> = {
  email: new Set<string>([
    'find_available_slots', 'create_meeting', 'get_person_memory', 'log_interaction',
  ]),
};

/**
 * Decide which tools to ship for an owner turn given the scope set from
 * classifyTurn. Returns the union of always-on tools + tools in any
 * of the requested scopes. 'general' (or no scope) → all tools, no filter.
 * Then applies the channel clamp above, regardless of scope outcome.
 */
function filterToolsByScope(
  allTools: import('@anthropic-ai/sdk').default.Tool[],
  scopes: string[] | undefined,
  channel: ChannelId = 'slack',
): import('@anthropic-ai/sdk').default.Tool[] {
  // gh#24 row 122 (combined verify + owner ruling) — a channel clamp is a
  // TRUST-BOUNDARY CEILING, not one more scope to AND against the classifier's
  // pick. This used to run scope-narrowing FIRST (ALWAYS_ON ∪ scope tools) and
  // intersect the clamp afterwards — since find_available_slots/create_meeting
  // live only in the 'meetings' scope (not ALWAYS_ON), any classifier pick
  // that wasn't meetings/calendar/general already dropped them from the
  // pre-clamp set, silently leaving a clamped-channel turn with only whatever
  // ALWAYS_ON tools the clamp happens to also allow (email: just the two
  // memory tools — no way to check the calendar or book). On a clamped
  // channel, scope-narrowing can only ever SUBTRACT from the already-small
  // clamp set — it has no useful role to play — so skip it and return the
  // clamp intersected with the full active tool set directly. Deterministic
  // regardless of classifier output (misfire, timeout, exception, or a
  // genuine non-meetings pick all resolve the same way). Non-clamped channels
  // (today: 'slack', where CHANNEL_TOOL_CLAMP['slack'] is undefined) fall
  // through to the scope logic below, unchanged.
  const clamp = CHANNEL_TOOL_CLAMP[channel];
  if (clamp) return allTools.filter(t => clamp.has(t.name));

  if (!scopes || scopes.length === 0 || scopes.includes('general')) {
    return allTools;
  }

  // v3.x — 'calendar' implies 'meetings': a calendar-review turn needs the
  // health/read tools (which live in the meetings scope). Expand deterministically
  // here so the turn is safe even if the classifier emits the sub-scope alone.
  let effectiveScopes = scopes;
  if (scopes.includes('calendar') && !scopes.includes('meetings')) {
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
  return allTools.filter(t => {
    if (allowed.has(t.name)) return true;
    if (!KNOWN_SCOPED.has(t.name) && !ALWAYS_ON_TOOLS.has(t.name)) {
      // Unmapped → keep + log once (per process) so the omission is fixable.
      logUnmappedToolOnce(t.name);
      return true;
    }
    return false;
  });
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
 *   - Accept, reject, or counter the owner's amendment to their own approval
 *
 * Colleagues cannot:
 *   - Read or write owner preferences / memory
 *   - See task lists, briefings, or interaction history
 *   - Send messages on the owner's behalf
 *   - Cancel or modify other existing coordinations
 *   - Create or delete calendar events
 */
const COLLEAGUE_ALLOWED_TOOLS = new Set([
  'find_slack_user',
  'get_calendar',
  // get_free_busy is NOT colleague-allowed (removed v3.4.x). It's a raw
  // open-time lookup that is WE-BLIND — on a Working-Elsewhere/travel day it
  // reports the owner's HOME work hours as free, so "when's Idan free Sunday?"
  // answered off it offered Israel hours while he was in Boston (the Gidon
  // incident). For a colleague, finding time to meet IS find_available_slots —
  // it's rule-aware AND travel-aware; availabilityPreCheck covers "is X free?".
  // There is no colleague booking question that get_free_busy answers correctly
  // that find_available_slots doesn't answer better.
  'find_available_slots',
  // v2.0.7 — store_request retired. Colleague-initiated asks that need owner
  // input now go through create_task + create_approval, both of which ARE in
  // this allowlist so a colleague-path Sonnet can flag things up to the owner.
  'create_task',
  'create_approval',
  // A colleague can answer the owner's counter on THEIR OWN approval. The
  // resolve_approval handler independently requires kind='approval',
  // state='awaiting_colleague', and requester_slack_id=context.userId before
  // any resolver action runs; every owner-state and other-requester row stays
  // blocked. Keeping the name in this ONE set makes both model shipping and
  // the direct dispatch chokepoint agree.
  'resolve_approval',
  // v3.4.x — the multi-party coordination subsystem (coordinate_meeting + the
  // DM-poll state machine) was fully removed. Scheduling with the owner goes
  // through the direct path: find_available_slots intersects every internal
  // attendee's calendar; create_meeting invites everyone, externals by email
  // with Outlook's native accept/decline.
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
  // instead of falling back to "you send the invite". The handler enforces: single colleague-attendee
  // (themselves), rule-compliant slot, English subject. Auto shadow-DMs owner.
  // Same trust pattern as v2.2.1 move_meeting — rule-compliance is the gate.
  'create_meeting',
  // v3.1.4 — a colleague who REQUESTED a meeting controls it: add people,
  // rename, change location. The update_meeting handler gates this on
  // requester-identity (findMeetingOwner): requester → allowed; non-requester
  // → returns a clean needs-approval signal so Sonnet fires ONE create_approval.
  // Pre-fix update_meeting was blocked here, so a colleague's "add Eli + rename"
  // had no correct tool — Sonnet flailed through create/move (both rule-failed),
  // burned the rate limit, and punted vaguely to the owner.
  'update_meeting',
  // #30 — a colleague who picks an offered slot but defers ("let me check with
  // my team") can tentatively hold it. The handler validates the slot was
  // offered in THIS conversation + caps at 3 active holds; they can never freeze
  // arbitrary calendar time, only a slot Maelle actually offered them.
  'hold_slot',
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
  //   update_person_memory, get_person_memory
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
 * v4.4.x (#154) — the room-authority ACTION floor. `senderRole` (above) is
 * the DATA gate: it reads 'colleague' both for a real colleague AND for the
 * owner typing inside a room (MPIM/channel), because his data access is
 * clamped there like anyone else's. `authority`, by contrast, is who is
 * AUTHENTICATED as acting — resolved once at the Slack front door from the
 * sender id, never clamped by surface — so it is the ACTION gate. The owner
 * keeps his booking/moving/cancelling/approving power on every surface (his
 * ruling: "action only, as any data extracting tools is problem by privacy
 * nature") while a real colleague still gets only COLLEAGUE_ALLOWED_TOOLS.
 * Built as that SAME set plus the owner-only cancellation write a colleague
 * may never reach. resolve_approval is already in the shared set for a
 * requester's guarded awaiting_colleague response; its handler uses authority
 * to retain the owner's full approval power. Owner data tools
 * (get_person_memory, manage_preference, update_my_preferences,
 * update_person_memory — the merged learn/forget/recall_preferences) are
 * deliberately NOT added here: they stay unreachable in a room regardless of
 * authority because they're absent from this set. AssistantSkill also
 * explicitly refuses these tools on room surfaces; its WRITE authority
 * comes from context.authority, while senderRole remains the DATA scope.
 */
const OWNER_ROOM_ACTION_TOOLS = new Set<string>([
  ...COLLEAGUE_ALLOWED_TOOLS,
  'delete_meeting',
]);

/**
 * The tools that MUTATE something outside this process — send a message,
 * create/modify a calendar event, raise an approval, write durable state.
 * Everything else (get_calendar, find_available_slots, find_slack_user,
 * web_search, recall_*) is a repeatable read.
 *
 * "Is this tool a write?" is a property of the TOOL, not of any transport, so
 * it belongs here with the rest of the tool-name classification
 * (ALWAYS_ON_TOOLS / SCOPE_TO_TOOLS / COLLEAGUE_ALLOWED_TOOLS above). It used
 * to be declared inside connectors/slack/inboundQueue.ts, which made core load
 * the Slack transport just to ask that question — and left the set editable
 * only from a Slack file even though not one entry is Slack-specific.
 *
 * Consumers:
 *   - abort-if-safe — an in-flight turn stops being abortable once one of these
 *     fires (orchestrator/index.ts → onWriteExecuted → the inbound queue).
 *   - proseOnly — the dateVerifier retry path strips every write so a reworded
 *     reply can't fire a fresh mutation (buildTurnContext.ts).
 *   - ack guard — "thanks" after a completed action can't re-mutate
 *     (buildTurnContext.ts; it excludes the two approval tools).
 *   - approved-action execution below — only classified mutations with an
 *     explicit outcome contract can confirm a stored owner action.
 */
export const WRITE_TOOLS = new Set<string>([
  // Calendar mutations
  'create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting',
  'book_floating_block', 'set_event_category',
  // These existing tools also persist holds/overrides or run calendar fixes.
  // Mixed read/write tools remain writes here (as manage_knowledge does).
  'hold_slot', 'revert_last_auto_move', 'set_work_schedule_override', 'check_calendar_health',
  // Outreach (sends DMs externally — irreversible)
  'message_colleague',
  // Approvals (DM owner)
  'create_approval', 'resolve_approval',
  // Tasks (visible state). v2.9 — edit/cancel merged into update_task.
  'create_task', 'update_task',
  // Routines. v2.9 — 4 tools merged into manage_routine; create/update/delete
  // actions all flow through the same write tool.
  'manage_routine',
  // Calendar issues. v2.9 — merged into manage_calendar_issue (update action is the write).
  'manage_calendar_issue',
  // Knowledge / summary writes. v2.9 — ingest merged into manage_knowledge.
  'share_summary', 'manage_knowledge',
  'learn_summary_style', 'update_summary_draft',
  // Memory writes. v2.9 — preferences merged into manage_preference (set/forget are writes).
  'manage_preference', 'update_my_preferences',
  'note_about_person', 'note_about_self',
  'log_interaction', 'update_person_profile', 'update_person_memory',
  'confirm_gender',
  // Briefing
  'send_briefing_now',
]);

export interface ApprovedSkillOutcome {
  status: 'completed' | 'tracked' | 'failed';
  /** Preserve partial effects and refusal details; failed never means nothing happened. */
  result: Record<string, unknown>;
}

/** Execute a stored owner action through the same policy/skill dispatch as a live call.
 * Result contracts belong to the tool, not to the approval's original subject.
 * This does not grant authority, enable skills, or turn a scheduled send into delivery.
 */
export async function executeApprovedSkillTool(
  toolName: string,
  args: Record<string, unknown>,
  context: SkillContext,
): Promise<ApprovedSkillOutcome> {
  const refuse = (error: string): ApprovedSkillOutcome => ({ status: 'failed', result: { error } });
  if (context.authority !== 'owner' || context.userId !== context.profile.user.slack_user_id) {
    return refuse('approved_action_requires_authenticated_owner');
  }
  if (!WRITE_TOOLS.has(toolName)) return refuse('unsupported_approved_action');
  // Calendar replay already preserves its origin for scoped domain narration.
  // Generic results can contain private data: the caller must supply the real
  // stored owner decision anchor, never relabel an origin room as owner-private.
  const originScopedCalendar = ['create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting', 'book_floating_block'];
  if (!originScopedCalendar.includes(toolName) && (context.surface !== 'owner_dm' || !context.channelId || !context.threadTs)) {
    return refuse('approved_action_requires_private_decision_context');
  }
  // The request lock rejects actual dependency cycles. Unrelated approval
  // targets still use their normal domain authorization and lifecycle.
  const value = await executeSkillTool(toolName, args, context);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return refuse('approved_action_unconfirmed');
  }
  const result = value as Record<string, unknown>;
  const failed = (uncertain = false): ApprovedSkillOutcome => ({
    status: 'failed', result: {
      ...result,
      ...(uncertain && result.error ? { execution_error: result.error } : {}),
      error: uncertain ? 'approved_action_unconfirmed' : result.error || 'approved_action_unconfirmed',
    },
  });
  // These two move results are emitted only AFTER PATCH and its readback.
  // A rule refusal before PATCH is different: never label it attempted.
  const postMoveUnconfirmed = toolName === 'move_meeting'
    && (result.error === 'moved_but_missing' || result.error === 'move_did_not_land');
  if (postMoveUnconfirmed || result.needs_verification === true || result.partial === true
    || (result.not_saved && typeof result.not_saved === 'object' && Object.keys(result.not_saved).length > 0)) {
    return failed(true);
  }
  if (result.error || result.ok === false || result.success === false) return failed();
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const list = (v: unknown): v is unknown[] => Array.isArray(v);
  const action = String(args.action ?? '').toLowerCase();
  let complete = false;
  switch (toolName) {
    case 'create_meeting': case 'move_meeting': case 'update_meeting': case 'delete_meeting':
      complete = result.success === true;
      break;
    case 'book_floating_block':
      complete = result.ok === true;
      break;
    case 'hold_slot':
      complete = result.success === true && (action === 'release'
        ? Number.isInteger(result.released) && (result.released as number) >= 0
        : text(result.hold_id) && text(result.expires_at));
      break;
    case 'revert_last_auto_move':
      complete = result.success === true && result.reverted === true;
      break;
    case 'set_work_schedule_override':
      complete = result.success === true && list(result.dates) && result.dates.length > 0
        && result.dates[0] === args.date_from
        && result.dates[result.dates.length - 1] === (args.date_to || args.date_from)
        && (args.clear !== true || result.cleared === result.dates.length);
      break;
    case 'check_calendar_health':
      complete = list(result.issues) && result.count === result.issues.length
        && ['active', 'passive'].includes(String(result.mode)) && Number.isInteger(result.fixes_applied)
        && text(result.summary)
        && result.issues.every(issue => !!issue && typeof issue === 'object'
          && !(issue as Record<string, unknown>).fix_failed && !(issue as Record<string, unknown>).fix_error);
      break;
    case 'set_event_category':
      complete = result.updated === true && text(result.event_id) && result.event_id === args.event_id;
      break;
    case 'message_colleague':
      if (result.scheduled === true && text(result.jobId) && text(result.scheduled_at)
        && result._status === 'scheduled_not_sent') return { status: 'tracked', result };
      complete = result.ok === true && text(result.jobId)
        && (result.sent === true || text(result.posted_to_channel));
      break;
    case 'create_task':
      complete = result.created === true && text(result.task_id);
      break;
    case 'create_approval':
      if (result.ok === true && text(result.approval_id)
        && (result.created === true || (result.created === false && result.reused_existing === true))) {
        if (result.already_closed === true) {
          return { status: 'failed', result: { ...result, error: 'approval_request_already_closed' } };
        }
        return { status: 'tracked', result };
      }
      break;
    case 'resolve_approval':
      if (result.ok === true && text(result.request_id)
        && result.request_id === String(args.approval_id ?? '').replace(/^#/, '')) {
        if (['awaiting_owner', 'awaiting_colleague', 'in_flight'].includes(String(result.state))
          || result.requester_notify_outcome === 'failed') return { status: 'tracked', result };
        complete = ['resolved', 'cancelled', 'expired'].includes(String(result.state));
      }
      break;
    case 'update_task':
      complete = action === 'edit' ? result.updated === true && result.task_id === args.task_id
        : action === 'cancel' && (result.cancelled === true
          || (result.ok === true && result.request_id === args.task_id && result.state === 'cancelled'));
      if (complete && result.requester_notify_outcome === 'failed') return { status: 'tracked', result };
      break;
    case 'manage_routine':
      complete = action === 'create' ? result.created === true && text(result.routine_id)
        : action === 'update' ? result.updated === true && result.routine_id === args.routine_id
        : action === 'delete' ? result.deleted === true
        : action === 'list' && list(result.routines) && result.count === result.routines.length;
      break;
    case 'manage_calendar_issue':
      if (action === 'start_resolve') {
        return result.updated === true && result.status === 'in_progress' && text(result.request_id)
          ? { status: 'tracked', result } : failed();
      }
      complete = action === 'list' ? list(result.issues) && result.count === result.issues.length
        : action === 'approve' && !args.issue_id ? result.ok === true
        : ['approve', 'owner_will_resolve', 'owner_done'].includes(action)
          && result.updated === true && result.issue_id === args.issue_id
          && result.status === ({ approve: 'approved', owner_will_resolve: 'owner_side', owner_done: 'resolved' } as Record<string, string>)[action];
      break;
    case 'share_summary':
      complete = result.ok === true && list(args.recipients) && args.recipients.length > 0
        && list(result.sent_to) && result.sent_to.length === args.recipients.length
        && result.sent_to.every(entry => !!entry && typeof entry === 'object' && text((entry as Record<string, unknown>).id))
        && list(result.refused) && result.refused.length === 0
        && list(result.send_failures) && result.send_failures.length === 0;
      break;
    case 'manage_knowledge':
      complete = result.ok === true && (action === 'ingest'
        ? ['created', 'merged', 'sibling'].includes(String(result.kind)) && text(result.section_id)
        : action === 'get' && (text(result.content) || list(result.sections)));
      break;
    case 'learn_summary_style':
      complete = result.ok === true && result.saved === true;
      break;
    case 'update_summary_draft':
      complete = result.ok === true && text(result.rendered);
      break;
    case 'manage_preference':
      complete = action === 'set' ? result.saved === true
        : action === 'forget' ? result.deleted === true
        : action === 'recall' && list(result.preferences) && result.count === result.preferences.length;
      break;
    case 'note_about_person': case 'note_about_self':
      complete = result.saved === true;
      break;
    case 'log_interaction': complete = result.logged === true; break;
    case 'confirm_gender': complete = result.confirmed === true; break;
    case 'update_person_profile': complete = result.updated === true; break;
    case 'update_my_preferences': case 'update_person_memory': case 'send_briefing_now':
      complete = result.ok === true;
      break;
  }
  return complete ? { status: 'completed', result } : failed();
}

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
 *
 * v4.3.0 (#24) — `channel` is the turn's inbound transport. It scopes
 * BOTH which Connection's tools are merged in (own-transport only — see
 * below) AND, via CHANNEL_TOOL_CLAMP, which ACTIONS that transport's trust
 * level earns (today: email → find_available_slots, create_meeting,
 * get_person_memory, log_interaction only — see CHANNEL_TOOL_CLAMP above).
 * Defaults to 'slack' — every existing call site that doesn't pass a channel
 * keeps today's behavior byte-for-byte.
 *
 * v4.4.x (#154) — `authority` is optional and additive: when senderRole is
 * 'colleague' (a real colleague, OR the owner clamped to colleague-context
 * inside a room), authority==='owner' widens the shipped set from
 * COLLEAGUE_ALLOWED_TOOLS to OWNER_ROOM_ACTION_TOOLS (see that set's comment)
 * — never past it, and never touching the owner-path branch below. Omitted
 * (every pre-existing call site) behaves byte-for-byte as before.
 */
export function getSkillTools(
  profile: UserProfile,
  senderRole: 'owner' | 'colleague' = 'owner',
  scopes?: string[],
  channel: ChannelId = 'slack',
  authority?: 'owner' | 'colleague',
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
  //
  // v4.3.0 (#24) — a connection's getTools() loads ONLY for its OWN
  // transport. This used to loop every REGISTERED connection for the
  // profile and merge ALL of their tools into EVERY turn regardless of
  // which transport the turn arrived on — so once an email connection is
  // registered, its tools (and any future WhatsApp connection's) would ship
  // to a Slack turn too. The owner's words: "why email will ship to slack?
  // the process need to be base of transport layer and load only what
  // needed." Scoped to `channel` (the turn's inbound transport) instead.
  const profileId = profile.user.slack_user_id;
  const connectionTools: Anthropic.Tool[] = [];
  const ownConnection = getConnection(profileId, channel);
  if (ownConnection?.getTools) {
    try {
      connectionTools.push(...ownConnection.getTools(profile));
    } catch (err) {
      logger.warn(`Connection "${ownConnection.id}" getTools() failed`, { err: String(err) });
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

  // Push the shipped names down to the leak scrubber (textScrubber.ts) BEFORE
  // the role filter: a colleague turn must register the owner-only names too,
  // since a name the model never received can still surface in text the
  // scrubber runs over. The scrubber only rebuilds its regex when the set grows.
  registerToolNames(deduped.map(t => t.name));

  // Colleagues only get the explicitly allowed subset — block everything else.
  // Scope filter does NOT apply on the colleague path (the static allowlist is
  // the hard limit; scope would be redundant). The channel clamp still does —
  // a colleague turn on a clamped channel gets the intersection of both.
  //
  // v4.4.x (#154) — `authority` splits this branch's floor: a real colleague
  // (authority !== 'owner') keeps COLLEAGUE_ALLOWED_TOOLS unchanged; the
  // owner clamped into a room (authority === 'owner') gets the wider
  // OWNER_ROOM_ACTION_TOOLS action floor instead. Data-only tools stay out of
  // BOTH sets, so a room never ships them regardless of who's typing.
  if (senderRole === 'colleague') {
    const actionFloor = authority === 'owner' ? OWNER_ROOM_ACTION_TOOLS : COLLEAGUE_ALLOWED_TOOLS;
    const colleagueTools = deduped.filter(t => actionFloor.has(t.name));
    const clamp = CHANNEL_TOOL_CLAMP[channel];
    return clamp ? colleagueTools.filter(t => clamp.has(t.name)) : colleagueTools;
  }

  // Owner-path Module G filter (no-op if scopes is undefined or includes 'general'),
  // plus the channel clamp above.
  return filterToolsByScope(deduped, scopes, channel);
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
  // Defense-in-depth chokepoint (T-2). Today the "owner-only" perimeter has
  // two layers:
  //   (1) Positive allowlist at SHIPPING — `filterToolsByScope` removes
  //       owner-only tools from the catalog Sonnet sees on a colleague turn.
  //       Sonnet "can't call what it can't see" → the practical wall.
  //   (2) Hard-block at HANDLE — a small `ownerOnlyTools` Set in
  //       `core/assistant.ts` (executeToolCall) refuses 4 names if a
  //       non-owner somehow names them, keyed on authenticated authority.
  //       Its separate surface === 'room' refusal keeps private memory reads
  //       and the existing preference / markdown tools blocked in rooms.
  // Problem: (1) covers ~20 owner-only tools, (2) only 5. If (1) ever ships
  // a tool by accident (Module G coverage map gap — exactly how `web_research`
  // shipped to every owner turn pre-v3.3.0), the colleague path has no second
  // wall. This chokepoint re-applies (1)'s allowlist at the dispatch boundary:
  // a colleague-context turn cannot reach any skill handler with a tool
  // outside its floor, regardless of how it got into args.
  //
  // v4.4.x (#154) — same authority split as getSkillTools above: the owner
  // clamped into a room (context.authority === 'owner') dispatches against
  // OWNER_ROOM_ACTION_TOOLS (book/move/cancel/approve); a real colleague
  // still dispatches against COLLEAGUE_ALLOWED_TOOLS unchanged. Data-only
  // tools (get_person_memory, manage_preference, update_my_preferences,
  // update_person_memory) are in neither set, so this chokepoint blocks them
  // regardless of authority — AssistantSkill's explicit room-surface refusal
  // also blocks them; its WRITE gates use authority, not the DATA scope.
  if (context.senderRole === 'colleague') {
    const actionFloor = context.authority === 'owner' ? OWNER_ROOM_ACTION_TOOLS : COLLEAGUE_ALLOWED_TOOLS;
    if (!actionFloor.has(toolName)) {
      logger.warn('executeSkillTool: colleague-path tool blocked at chokepoint', {
        tool: toolName, requesterId: context.userId, authority: context.authority,
      });
      return { error: 'not_permitted', reason: `Tool "${toolName}" is owner-only.` };
    }
  }

  // v4.3.0 (#24) — same defense-in-depth pattern, keyed on CHANNEL instead
  // of role. getSkillTools already clamps a channel-restricted turn (today:
  // email → the 4-tool allowlist in CHANNEL_TOOL_CLAMP) at SHIPPING time;
  // this re-applies that same clamp at DISPATCH so a call on a clamped
  // channel can't reach any handler outside it, regardless of how the
  // tool_use got named. See CHANNEL_TOOL_CLAMP above for why this matters for
  // email specifically (spoofable sender gate; the write clamp is the backstop).
  const channelClamp = CHANNEL_TOOL_CLAMP[context.channel];
  if (channelClamp && !channelClamp.has(toolName)) {
    logger.warn('executeSkillTool: channel-path tool blocked at chokepoint', {
      tool: toolName, channel: context.channel, requesterId: context.userId,
    });
    return { error: 'not_permitted', reason: `Tool "${toolName}" is not available on the ${context.channel} channel.` };
  }

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
      return executionFailure(toolName, err);
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
      return executionFailure(toolName, err);
    }
  }

  // v2.6.4 — fall through to the Connection for THIS transport (find_slack_channel
  // etc.). v4.3.0 (#24) — scoped to context.channel only, same seam-fix as
  // getSkillTools above: a tool call that arrived on one transport must never
  // dispatch to a DIFFERENT transport's Connection. The turn's surface rides
  // along (#154 field, resolved once at the transport front door — read here,
  // never re-derived): a Connection-owned tool that returns stored data about
  // a person scopes its payload by it in code (W9) — find_slack_user hands a
  // room identity only (connections/slack/index.ts, projectDirectoryMatch).
  const profileId = context.profile.user.slack_user_id;
  const conn = getConnection(profileId, context.channel);
  if (conn?.executeToolCall) {
    try {
      const result = await conn.executeToolCall(toolName, args, { surface: context.surface });
      if (result !== null) {
        logger.info('Tool executed', { tool: toolName, connection: conn.id });
        return result;
      }
    } catch (err) {
      logger.error(`Connection "${conn.id}" threw during tool "${toolName}"`, { err: String(err) });
      return executionFailure(toolName, err);
    }
  }

  logger.warn('No skill handled tool', { tool: toolName, user: context.profile.user.name });
  return { error: `No active skill handles tool: ${toolName}` };
}

function executionFailure(toolName: string, err: unknown): Record<string, unknown> {
  // The lock raises this before entering the cyclic target's work; it proves
  // refusal, unlike an arbitrary executor exception after a possible write.
  if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'request_lock_cycle') {
    return { error: 'request_lock_cycle', reason: 'The requested action would wait on its own pending decision.' };
  }
  return { error: `Tool "${toolName}" failed: ${String(err)}`, needs_verification: true };
}
