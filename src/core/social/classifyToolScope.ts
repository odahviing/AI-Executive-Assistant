/**
 * Module G — Intent-aware tool scoping (v2.7.7).
 *
 * Pre-Sonnet pass that picks which tool scopes are relevant for THIS turn.
 * Returns one or more scopes; getSkillTools filters the owner's tool list
 * to (always-on core) ∪ (tools in any returned scope).
 *
 * Six scopes:
 *   - meetings    — calendar / coord / slot-finding / move / cancel
 *   - tasks       — task list, routines, briefing requests
 *   - knowledge   — KB lookup, web extract for research/ingest
 *   - summary     — post-meeting summary state machine
 *   - social      — explicit social-engine writes (note_about_*, gender)
 *   - general     — wildcard; means "ship everything, this is ambiguous"
 *
 * Classifier philosophy:
 *   - Default to UNION (return multiple scopes when ambiguous).
 *   - Default to 'general' on any uncertainty or failure (safe widen).
 *   - Haiku for cost + latency; this fires every owner turn that reaches
 *     Sonnet when the flag is on. Misclassifying a turn is more painful
 *     than running an unnecessary scope; bias toward inclusion.
 *
 * Gate: read `profile.behavior.intent_aware_tools` in the caller, NOT here.
 * This module just classifies; the orchestrator decides whether to fire it.
 *
 * Fails open: any error returns ['general'] → getSkillTools returns all
 * tools as today. No turn ever breaks because of this classifier.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../../config/userProfile';
import logger from '../../utils/logger';

export type ToolScope = 'meetings' | 'tasks' | 'knowledge' | 'summary' | 'social' | 'venue' | 'general';

export const ALL_SCOPES: ToolScope[] = ['meetings', 'tasks', 'knowledge', 'summary', 'social', 'venue', 'general'];

export interface ToolScopeResult {
  scopes: ToolScope[];
  /** Whether the classifier was actually consulted, or we short-circuited. */
  source: 'classifier' | 'fallback' | 'short_circuit_empty' | 'flag_off';
}

/**
 * The widening result — returned when we want to ship every tool.
 */
const ALL_TOOLS: ToolScopeResult = { scopes: ['general'], source: 'fallback' };

/**
 * Short-circuit: empty / pure-ack messages don't need a tool list at all.
 * The orchestrator still ships always-on core but the scope add nothing.
 * (We still return ['general'] so callers get a deterministic shape; the
 * scope filter treats general = all tools.)
 */
function looksLikePureAck(msg: string): boolean {
  const trimmed = msg.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  if (trimmed.length > 20) return false;
  // Common ack patterns — English + Hebrew
  const acks = ['ok', 'okay', 'thanks', 'thank you', 'thx', 'ty', 'cool', 'got it',
    'sure', 'yes', 'no', 'yep', 'nope', 'k', 'kk', 'morning', 'hi', 'hey', 'hello',
    'later', 'bye', 'תודה', 'אוקיי', 'כן', 'לא', 'בוקר טוב', 'ערב טוב'];
  return acks.includes(trimmed) || acks.some(a => trimmed === a + '!' || trimmed === a + '.');
}

export async function classifyToolScope(params: {
  anthropic: Anthropic;
  ownerMessage: string;
  profile: UserProfile;
  recentContext?: string;
}): Promise<ToolScopeResult> {
  const { anthropic, ownerMessage, profile, recentContext } = params;

  if (!ownerMessage || ownerMessage.trim().length === 0) {
    return { scopes: ['general'], source: 'short_circuit_empty' };
  }

  // Pure-ack messages: ship everything (always-on covers the typical
  // resolve_approval / cancel_task / acknowledgement path; widening is cheap
  // since the turn is short).
  if (looksLikePureAck(ownerMessage)) {
    return ALL_TOOLS;
  }

  const ownerFirst = profile.user.name.split(' ')[0];
  const summaryActive = (profile.skills as any)?.summary === true;
  const knowledgeActive = (profile.skills as any)?.knowledge === true;
  const socialActive = (profile.skills as any)?.social === true;
  const venueActive = (profile.skills as any)?.venue === true;

  // Build the list of in-play scopes for this profile. Disabled skills are
  // dropped — saves Sonnet's attention budget for the classifier.
  const inPlayScopes: string[] = ['meetings', 'tasks'];
  if (knowledgeActive) inPlayScopes.push('knowledge');
  if (summaryActive) inPlayScopes.push('summary');
  if (socialActive) inPlayScopes.push('social');
  if (venueActive) inPlayScopes.push('venue');
  inPlayScopes.push('general');

  const systemPrompt = `You pick which tool scopes are relevant to ${ownerFirst}'s message.

Output EXACTLY ONE call to pick_scopes. No prose.

Scopes available this turn (you may pick one or more):
- meetings    — anything calendar-shaped: checking calendar, booking, moving, cancelling, finding slots, coordinating, "when am I free", "is X open", checking attendee availability, "do I have lunch?". Includes calendar-health checks.
- tasks       — task list / routines / briefing requests: "what's pending?", "what did I miss?", "show me my tasks", "set up a daily routine", "what's on my brief?".
${knowledgeActive ? '- knowledge   — KB lookups / save this URL / research / "what do we know about X": company info, product, customer, competitor, market.\n' : ''}${summaryActive ? '- summary     — post-meeting summary workflow only: classifying summary feedback, sharing a summary, updating a draft, listing speaker unknowns. Recurring "summary" comes here.\n' : ''}${socialActive ? '- social      — explicit social write asks: "remember she\'s into X", "note that he likes Y", confirming a person\'s gender. Just chatting socially (small talk) is NOT this scope — it doesn\'t need tools.\n' : ''}${venueActive ? '- venue       — external-venue management: ranking a venue ("rank Coffee Landwer 3", "drop Aroma to 1"), or asking about saved venues ("what are my favorite cafés?"). Finding a venue for a meeting also fires here, but ALSO use \'meetings\' because the venue search feeds into a booking flow.\n' : ''}- general     — pick this when ambiguous, or when you want to err on the side of shipping every tool. Cheap to over-include.

How to choose:
- Default to UNION when the message could touch multiple things. "Move my 2pm and tell Yael" → ['meetings'] (message_colleague is always-on, no need for tasks scope). "Find time with Yael for next week and remember she prefers mornings" → ['meetings'${socialActive ? ", 'social'" : ''}].
- "What's pending? Also any conflicts next week?" → ['tasks', 'meetings'].
- Chit-chat / vague reply / unclear → ['general'].
- ONE scope when the message is unambiguously single-purpose. "Book Mon 10:30 with Yael" → ['meetings'].

DO NOT include scopes that aren't in the list above. The profile has gated some off; respect that.

${recentContext ? `\nRecent conversation (last few turns for context):\n${recentContext}\n` : ''}`;

  try {
    const resp = await anthropic.messages.create({
      // Haiku — cheap, fast, sufficient for picking from a 6-element enum.
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: systemPrompt,
      tools: [{
        name: 'pick_scopes',
        description: 'Pick the tool scopes relevant to this turn (one or more).',
        input_schema: {
          type: 'object' as const,
          properties: {
            scopes: {
              type: 'array',
              description: 'One or more scopes from the list above. Bias toward UNION when ambiguous; pick ["general"] to ship everything.',
              items: { type: 'string', enum: inPlayScopes },
              minItems: 1,
            },
          },
          required: ['scopes'],
        },
      }],
      tool_choice: { type: 'tool', name: 'pick_scopes' },
      messages: [{ role: 'user', content: ownerMessage.slice(0, 4000) }],
    });

    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    const raw = toolUse?.input as { scopes?: string[] } | undefined;
    if (!raw || !Array.isArray(raw.scopes) || raw.scopes.length === 0) {
      logger.warn('classifyToolScope — no scopes returned, falling back to general');
      return ALL_TOOLS;
    }

    // Filter to known scopes (defensive against Haiku echoing something weird).
    const filtered = raw.scopes.filter((s): s is ToolScope =>
      ALL_SCOPES.includes(s as ToolScope) && inPlayScopes.includes(s)
    );
    if (filtered.length === 0) {
      logger.warn('classifyToolScope — all returned scopes invalid, falling back to general', {
        rawScopes: raw.scopes,
      });
      return ALL_TOOLS;
    }

    logger.info('classifyToolScope', {
      scopes: filtered,
      preview: ownerMessage.slice(0, 80),
    });

    return { scopes: filtered, source: 'classifier' };
  } catch (err) {
    logger.warn('classifyToolScope threw — falling back to general', {
      err: String(err).slice(0, 300),
    });
    return ALL_TOOLS;
  }
}
