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
   */
  getSystemPromptSection(profile: UserProfile): string;
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
  | 'email_drafting'
  | 'meeting_summaries'
  | 'proactive_alerts'
  | 'whatsapp'
  | 'search'
  | 'research'
  | 'calendar_health'
  // legacy aliases
  | 'scheduling'
  | 'coordination';

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
