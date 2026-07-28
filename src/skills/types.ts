import type Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../config/userProfile';

/**
 * A Skill is a self-contained capability module.
 * Each skill provides:
 *   - tools: what Claude can call
 *   - executeToolCall: how those tool calls are executed
 *   - getSystemPromptSection: the rules/context injected into the system prompt
 *
 * Skills are activated per-user via the YAML profile (skills: scheduling: true)
 * and are completely independent of each other and of channels.
 */
export interface Skill {
  /** Unique identifier — SkillId for profile-toggled skills, CoreModuleId for always-on modules */
  id: SkillId | CoreModuleId;

  /** Human-readable name shown in logs and startup */
  name: string;

  /** Short description of what this skill does */
  description: string;

  /** The Anthropic tool definitions this skill exposes to Claude */
  getTools(profile: UserProfile): Anthropic.Tool[];

  /**
   * Execute a tool call by name.
   * Returns the result to be fed back to Claude.
   * Returns null if this skill doesn't handle the given tool name.
   */
  executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null>;

  /**
   * Additional section injected into the system prompt when this skill is active.
   * Should describe rules, capabilities, and behaviour specific to this skill.
   *
   * `scopes` (v3.x) — the turn's tool scopes (owner-path, from classifyTurn).
   * A skill MAY use it to lazy-load rarely-used prose (e.g. ship coordination
   * details only when 'coord' is active). Undefined → render everything
   * (colleague path, classifier off, non-Slack callers).
   *
   * `isOwner` (v3.3) — true when the turn is the owner's. A skill MAY use it to
   * append the owner's private free-text preference block (the style layer);
   * those prefs must NEVER render on a colleague turn.
   *
   * `channel` (v4.3.0, E9, #24, gh#24 row 121) — the turn's inbound transport.
   * Only relevant to a skill that internally re-derives a shipped-tool check
   * (search.ts: whether web_research ships, to decide if its prose paragraph
   * should render) — pass it through so that check agrees with the actual
   * CHANNEL_TOOL_CLAMP-clamped tool set instead of silently assuming 'slack'.
   * Optional trailing param — every other skill ignores it, no changes needed.
   */
  getSystemPromptSection(profile: UserProfile, scopes?: string[], isOwner?: boolean, channel?: ChannelId): string;
}

/**
 * Core module IDs — always active on every agent, not toggled in profile.
 * These are engine-level capabilities: memory, task queue, cron scheduler.
 */
export type CoreModuleId = 'assistant' | 'outreach' | 'tasks' | 'routines';

/** Skill IDs — opt-in capabilities, toggled per user in YAML profile.
 *  v1.6.0: `scheduling` + `coordination` merged into `meetings`. Legacy
 *  profile YAMLs are auto-migrated in registry.getActiveSkills. */
export type SkillId =
  | 'meetings'
  | 'summary'             // v1.7.6 (renamed from meeting_summaries)
  | 'knowledge'           // v1.7.6 (renamed from knowledge_base)
  | 'calendar'            // v1.7.6 (renamed from calendar_health)
  | 'search'
  | 'social'              // v2.6.2 (renamed from persona) — social engine, codas, proactive outreach
  | 'venue'               // v2.9 — external venue discovery + rank catalog
  | 'news'                // v3.2.6 — personalized, calendar-aware grounded news (brief + on-demand)
  // legacy aliases — auto-migrated at load time, kept so old YAMLs still boot
  | 'scheduling'          // → meetings
  | 'coordination'        // → meetings
  | 'meeting_summaries'   // → summary
  | 'knowledge_base'      // → knowledge
  | 'calendar_health'     // → calendar
  | 'persona';            // → social (v2.6.2)

/** Runtime context passed to tool execution */
export interface SkillContext {
  profile: UserProfile;
  threadTs: string;
  channelId: string;
  userId: string;
  senderRole: 'owner' | 'colleague';  // who is making this request
  channel: ChannelId;
  app?: import('@slack/bolt').App;  // available for skills that need to send Slack messages
  isMpim?: boolean;                   // true if this is a group DM (MPIM)
  isOwnerInGroup?: boolean;           // true when the owner sent this message in an MPIM
  mpimMemberIds?: string[];           // all non-bot member IDs when in MPIM
  /**
   * v3.4.7 — the turn-scoped set of colleague slack_ids SUCCESSFULLY messaged
   * (message_colleague returned ok) this turn, by reference. resolve_approval
   * forwards it to the resolver so notifyRequesterOfDecision skips a relay to a
   * requester Sonnet already told this turn (the reverse-order double-notify
   * guard). Success-gated on purpose: a FAILED message_colleague is NOT in here,
   * so the resolver relay still goes — never a silent drop. Orchestrator-
   * populated; undefined on other call paths.
   */
  messagedColleaguesOkThisTurn?: Set<string>;
  /**
   * v1.9.0 — which Connection this message arrived on. Used by the router so
   * replies follow the inbound transport (Yael DMs on Slack → Maelle replies
   * on Slack). For now always 'slack' since that's the only Connection; will
   * carry 'email' / 'whatsapp' when those transports are added.
   */
  inboundConnectionId?: import('../connections/types').ConnectionId;
  /**
   * v2.8.6 — recent conversation history. Plumbed for the 103D/F deterministic
   * owner-in-MPIM check: when a colleague-path tool call runs in an MPIM where
   * the owner is present and the owner recently proposed the specific slot in
   * chat, the handler treats his presence as the approval and bypasses the
   * policy_exception escalation. Empty array when caller didn't pass history.
   */
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * v3.6.4 — internal colleagues the orchestrator resolved from the participant
   * names in THIS turn's scheduling request (deterministic pre-pass, single
   * unambiguous people_memory match only). find_available_slots UNIONS these
   * into attendee_emails so a known named colleague is never dropped because
   * Sonnet forgot to resolve the name (Lori 07-08, Simon 07-09). Per-turn (no
   * thread accumulation → no stale bleed). Empty/undefined on non-scheduling
   * turns and when nothing resolved.
   */
  resolvedMeetingAttendees?: string[];
}

/** All supported communication channels */
export type ChannelId = 'slack' | 'email' | 'whatsapp';

/**
 * A Channel is a communication surface (Slack, Email, WhatsApp).
 * Channels are activated per-user via the YAML profile (channels: slack: enabled: true)
 * Each channel knows how to send messages back to the user.
 */
export interface Channel {
  id: ChannelId;
  name: string;
  isEnabled(profile: UserProfile): boolean;
}
