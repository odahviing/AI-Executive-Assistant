/**
 * Merged per-turn classifier (v3.0.6).
 *
 * One Haiku call that does BOTH jobs the orchestrator used to split across
 * two serial LLM calls:
 *   - INTENT  (was classifyOwnerIntent, on Sonnet) — kind / conversation_state
 *     + light social context. Drives the social directive.
 *   - SCOPES  (was classifyToolScope, on Haiku) — which tool scopes to ship.
 *
 * Why merge: same message, same recent-context, both are "classify this turn."
 * Two serial roundtrips (~2.9s: Sonnet intent + Haiku scope) collapse into one
 * Haiku call (~1s). Both halves are independently fail-safe and bias in
 * aligned directions (task-message → meetings/tasks scope; social-message →
 * general/social), so combining them in one prompt doesn't create conflicts.
 *
 * The two halves are gated independently by the caller via `needIntent` /
 * `needScopes`:
 *   - Owner turn, both flags on  → one call, both parts.
 *   - Colleague turn, social on  → one call, intent only (colleagues get the
 *                                  static tool allowlist, scopes unused).
 *   - Only one flag on           → one call, that part only.
 *   - Neither                    → caller skips this entirely.
 *
 * Fails open on every axis: intent → kind='other' (drops the soft social
 * nudge), scopes → ['general'] (ships every tool). A misclassification is
 * never a correctness bug.
 *
 * Model note: Haiku. The hard social work (subject matching, granularity) was
 * already moved to the end-of-chat reconciler (also Haiku). The per-turn
 * intent classifier is a 3-way bucket with simple heuristics — Haiku-class.
 * If intent quality degrades in the logs, the model is a one-line flip.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../../config/userProfile';
import logger from '../../utils/logger';
import { logLlmUsage } from '../../utils/usageLog';
import { FIXED_CATEGORIES } from '../../db/socialSubjects';

const MODEL = 'claude-haiku-4-5-20251001';

// ── Intent types (formerly in classifyOwnerIntent.ts, removed in the v3.0.6
//    merge — this module is now the sole owner of per-turn classification) ──
export type OwnerIntentKind = 'task' | 'social' | 'other';
export type OwnerSocialDirection = 'share' | 'ask_assistant' | 'reaction';
export type OwnerSocialSentiment = 'positive' | 'negative' | 'neutral';
export type OwnerConversationState = 'open' | 'closing';

export interface OwnerIntentClassification {
  kind: OwnerIntentKind;
  conversation_state: OwnerConversationState;
  social?: {
    direction: OwnerSocialDirection;
    sentiment: OwnerSocialSentiment;
    category_hint?: string;
    /** A short label for THIS turn's beat. End-of-chat reconciler pairs it to a subject. */
    topic_label?: string;
  };
}

// ── Tool-scope types (formerly in classifyToolScope.ts, removed in v3.0.6) ──
export type ToolScope = 'meetings' | 'coord' | 'people' | 'tasks' | 'knowledge' | 'summary' | 'social' | 'venue' | 'general';

export const ALL_SCOPES: ToolScope[] = ['meetings', 'coord', 'people', 'tasks', 'knowledge', 'summary', 'social', 'venue', 'general'];

export interface ToolScopeResult {
  scopes: ToolScope[];
  /** Whether the classifier was actually consulted, or we short-circuited. */
  source: 'classifier' | 'fallback' | 'short_circuit_empty' | 'flag_off';
}

const ALL_TOOLS: ToolScopeResult = { scopes: ['general'], source: 'fallback' };
const INTENT_OTHER: OwnerIntentClassification = { kind: 'other', conversation_state: 'closing' };

export interface ClassifyTurnResult {
  intent: OwnerIntentClassification;
  scope: ToolScopeResult;
  /**
   * v3.1.2 (D) — true when the OWNER is asking a "do I have buffer / free
   * time / how packed is X / am I free" question. Orchestrator uses this
   * to deterministically run analyzeCalendar + inject real numbers BEFORE
   * Sonnet narrates, replacing the broken prompt rule at meetings.ts:2044
   * ("USE THE TOOL — don't math by hand") that Sonnet kept ignoring. Set
   * only on owner-path intent classification; false on colleague turns
   * (those go through precheckAvailability separately).
   */
  freeTimeInquiry: boolean;
}

/** Pure-ack short-circuit — shared by both halves. Bare ack/greeting/close-out
 *  has no actionable intent (→ 'other') and needs no specific tool scope
 *  (→ 'general'). No LLM call. (Mirrors classifyToolScope.looksLikePureAck.) */
function looksLikePureAck(msg: string): boolean {
  const trimmed = msg.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  if (trimmed.length > 20) return false;
  const acks = ['ok', 'okay', 'thanks', 'thank you', 'thx', 'ty', 'cool', 'got it',
    'sure', 'yes', 'no', 'yep', 'nope', 'k', 'kk', 'morning', 'hi', 'hey', 'hello',
    'later', 'bye', 'תודה', 'אוקיי', 'כן', 'לא', 'בוקר טוב', 'ערב טוב'];
  return acks.includes(trimmed) || acks.some(a => trimmed === a + '!' || trimmed === a + '.');
}

export async function classifyTurn(params: {
  anthropic: Anthropic;
  message: string;
  profile: UserProfile;
  needIntent: boolean;
  needScopes: boolean;
  senderRole?: 'owner' | 'colleague';
  senderName?: string;
  recentContext?: string;
}): Promise<ClassifyTurnResult> {
  const { anthropic, message, profile, needIntent, needScopes, recentContext } = params;

  // Nothing requested — return safe defaults (caller shouldn't get here, but
  // be defensive).
  if (!needIntent && !needScopes) {
    return { intent: INTENT_OTHER, scope: ALL_TOOLS, freeTimeInquiry: false };
  }

  if (!message || message.trim().length === 0) {
    return { intent: INTENT_OTHER, scope: ALL_TOOLS, freeTimeInquiry: false };
  }

  // Pure-ack short-circuit — no LLM call for either half. Intent='other'
  // matches what the intent classifier would return for a bare ack (its
  // RULE 3: cut the ack word, nothing substantive left → other), and scope
  // widens to general. Saves the whole roundtrip on "ok" / "thanks" / etc.
  if (looksLikePureAck(message)) {
    return { intent: INTENT_OTHER, scope: ALL_TOOLS, freeTimeInquiry: false };
  }

  const ownerFirst = profile.user.name.split(' ')[0];
  const assistantName = profile.assistant.name;
  const senderRole = params.senderRole ?? 'owner';
  const senderName = senderRole === 'owner' ? ownerFirst : (params.senderName ?? 'the colleague');
  const isOwner = senderRole === 'owner';

  // ── Scope setup (only relevant when needScopes) ──
  const summaryActive = (profile.skills as any)?.summary === true;
  const knowledgeActive = (profile.skills as any)?.knowledge === true;
  const venueActive = (profile.skills as any)?.venue === true;
  // v3.x (Change A) — 'people' is always in play (person-write tools moved off
  // ALWAYS_ON). The old 'social' SCOPE was an empty no-op; person notes now
  // route through 'people', so 'social' is no longer offered to the classifier.
  const inPlayScopes: string[] = ['meetings', 'coord', 'people', 'tasks'];
  if (knowledgeActive) inPlayScopes.push('knowledge');
  if (summaryActive) inPlayScopes.push('summary');
  if (venueActive) inPlayScopes.push('venue');
  inPlayScopes.push('general');

  // ── Intent setup (only relevant when needIntent) ──
  const categoryList = FIXED_CATEGORIES.join(', ');
  const directionExamples = isOwner
    ? `'share' (telling ${assistantName} about his life), 'ask_assistant' (asking ${assistantName} something personal), 'reaction' (responding to something ${assistantName} said earlier)`
    : `'share' (telling ${assistantName} about their own life), 'ask_assistant' (asking ${assistantName} something), 'reaction' (responding to something ${assistantName} said earlier)`;

  // ── Build the combined prompt — include only the requested sections ──
  const intentSection = needIntent ? `
INTENT — classify what ${senderName} is doing:

1) TASK — ${senderName} wants ${assistantName} to DO something actionable.
   Examples: "book the meeting", "what's on my calendar today", "reschedule tomorrow".
   A request, a question about state, or an instruction to act — task.

2) SOCIAL — ${senderName} is being a PERSON. No action requested.
   Examples: "One Axos down!", "I'm exhausted today", "how was your weekend?".
   Sharing, venting, small-talk, asking ${assistantName} something personal.

3) OTHER — bare ack / greeting / close-out with NO follow-on content.
   "ok", "thanks", "cool", "morning". KEY TEST — cut the opening ack word.
   Anything substantive left → SOCIAL, not OTHER.

TASK ALWAYS WINS. Mixed messages classify as TASK.

For EVERY classification set conversation_state ('open' | 'closing').

${isOwner ? `Also set free_time_inquiry (boolean) — true when ${ownerFirst} is asking about his free time / buffer / focus protection / how packed a day is / whether he has time today.
- TRUE examples: "do I have my buffer today?", "how packed is Thursday?", "am I free at all this afternoon?", "do I have any focus time?", "what's my buffer looking like?", "יש לי זמן היום?", "כמה עמוס היום?".
- FALSE for specific-slot questions ("am I free at 2pm?" → use find_available_slots, not analyze_calendar) and for booking requests.
- A general "how's my day" → false unless it specifically mentions free time / buffer / focus / how packed.
` : ''}For SOCIAL only, also set:
- direction: ${directionExamples}
- sentiment: 'positive' | 'negative' | 'neutral'
- category_hint: pick ONE from: ${categoryList}. Skip when nothing fits.
- topic_label: a 2-4 word label for THIS beat (e.g. "ending choice", "act 3 progress"). Optional.
` : '';

  const scopeSection = needScopes ? `
SCOPES — pick which tool scopes are relevant (one or more):
- meetings    — anything calendar-shaped: checking calendar, booking, moving, cancelling, finding slots, "when am I free", "is X open", attendee availability, "do I have lunch?", booking a meeting with someone. Includes calendar-health. This is the DEFAULT for almost all scheduling — direct booking lives here.
- coord       — RARE. ONLY multi-party coordination where Maelle must reach out to SEVERAL people SEPARATELY to negotiate a time they all agree on ("coordinate a sync between Anna, Ben and me", "set up a meeting between the candidate and Idan and find a time that works for everyone"). NOT for booking a known time, NOT a 1:1, NOT when the people are already here in the conversation, NOT a direct "book X with Y". When unsure, pick 'meetings', not 'coord'. Fires alongside 'meetings'.
- people      — saving or noting a durable fact about a PERSON (a colleague, not the owner's own prefs): where they live/work, timezone, working hours, communication style, gender, a hobby or personal detail — or any "remember / note that <X> about <someone>". Fires when the turn TEACHES you something about a person. (Just reading what you know about someone needs no scope — that tool is always available.)
- tasks       — task list / routines / briefing: "what's pending?", "what did I miss?", "show my tasks", "set up a daily routine", "what's on my brief?".
${knowledgeActive ? '- knowledge   — KB lookups / save a URL / research / "what do we know about X": company, product, customer, competitor, market.\n' : ''}${summaryActive ? '- summary     — post-meeting summary workflow only: classifying summary feedback, sharing a summary, updating a draft, listing speaker unknowns.\n' : ''}${venueActive ? '- venue       — external-venue management: ranking a venue ("rank Coffee Landwer 3"), or asking about saved venues. Finding a venue for a meeting fires here AND \'meetings\'.\n' : ''}- general     — pick when ambiguous, or to err toward shipping every tool. Cheap to over-include.

How to choose scopes:
- Default to UNION when the message could touch multiple things.
- "What's pending? Also any conflicts next week?" → ['tasks', 'meetings'].
- Chit-chat / vague / unclear → ['general'].
- ONE scope when unambiguously single-purpose. "Book Mon 10:30 with Yael" → ['meetings'].
- DO NOT include scopes not listed above.
` : '';

  const systemPrompt = `You classify a single message from ${senderName} (${isOwner ? `${ownerFirst} — the executive who owns this account` : `a colleague talking to ${assistantName}`}) to ${assistantName}.

Output EXACTLY ONE call to classify_turn. No prose.
${intentSection}${scopeSection}${recentContext ? `\nRecent conversation (classify the LAST message from ${senderName}):\n${recentContext}\n` : ''}`;

  // ── Build the tool schema — include only the requested fields ──
  const properties: Record<string, any> = {};
  const required: string[] = [];
  if (needIntent) {
    properties.kind = { type: 'string', enum: ['task', 'social', 'other'] };
    properties.conversation_state = { type: 'string', enum: ['open', 'closing'] };
    properties.social = {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['share', 'ask_assistant', 'reaction'] },
        sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
        category_hint: { type: 'string' },
        topic_label: { type: 'string' },
      },
      required: ['direction', 'sentiment'],
    };
    // v3.1.2 (D) — owner-only field, flagging buffer/free-time inquiries so
    // the orchestrator can deterministically run analyzeCalendar before
    // Sonnet narrates instead of trusting the leaky prompt rule.
    if (isOwner) {
      properties.free_time_inquiry = {
        type: 'boolean',
        description: 'True when the owner is asking about his free time / buffer / focus protection / how packed a day is.',
      };
    }
    required.push('kind', 'conversation_state');
  }
  if (needScopes) {
    properties.scopes = {
      type: 'array',
      description: 'One or more tool scopes from the list above. Bias toward UNION when ambiguous; ["general"] ships everything.',
      items: { type: 'string', enum: inPlayScopes },
      minItems: 1,
    };
    required.push('scopes');
  }

  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 250,
      system: systemPrompt,
      tools: [{
        name: 'classify_turn',
        description: 'Classify the message — intent and/or relevant tool scopes for this turn.',
        input_schema: { type: 'object' as const, properties, required },
      }],
      tool_choice: { type: 'tool', name: 'classify_turn' },
      messages: [{ role: 'user', content: message.slice(0, 4000) }],
    });
    logLlmUsage('classify_turn', MODEL, resp);

    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    const raw = toolUse?.input as (OwnerIntentClassification & { scopes?: string[]; free_time_inquiry?: boolean }) | undefined;

    // ── Resolve intent ──
    let intent: OwnerIntentClassification = INTENT_OTHER;
    if (needIntent) {
      if (!raw || !raw.kind) {
        logger.warn('classifyTurn — no intent in response, defaulting to other');
        intent = INTENT_OTHER;
      } else {
        intent = {
          kind: raw.kind,
          conversation_state: raw.conversation_state ?? 'open',
          social: raw.social,
        };
        if (intent.kind === 'social' && !intent.social) {
          intent = { kind: 'other', conversation_state: intent.conversation_state };
        }
        // Validate category_hint against the fixed list.
        if (intent.social?.category_hint) {
          const normalized = intent.social.category_hint.toLowerCase().trim();
          intent.social.category_hint = FIXED_CATEGORIES.includes(normalized) ? normalized : undefined;
        }
      }
    }

    // ── Resolve scopes ──
    let scope: ToolScopeResult = ALL_TOOLS;
    if (needScopes) {
      const rawScopes = raw?.scopes;
      if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
        logger.warn('classifyTurn — no scopes returned, falling back to general');
        scope = ALL_TOOLS;
      } else {
        const filtered = rawScopes.filter((s): s is ToolScope =>
          ALL_SCOPES.includes(s as ToolScope) && inPlayScopes.includes(s)
        );
        scope = filtered.length > 0
          ? { scopes: filtered, source: 'classifier' }
          : ALL_TOOLS;
      }
    }

    logger.info('classifyTurn', {
      ...(needIntent ? {
        kind: intent.kind,
        conversation_state: intent.conversation_state,
        direction: intent.social?.direction,
        category: intent.social?.category_hint,
        sentiment: intent.social?.sentiment,
      } : {}),
      ...(needScopes ? { scopes: scope.scopes } : {}),
      preview: message.slice(0, 80),
    });

    const freeTimeInquiry = isOwner && needIntent && raw?.free_time_inquiry === true;

    return { intent, scope, freeTimeInquiry };
  } catch (err) {
    logger.warn('classifyTurn threw — defaulting to other / general', { err: String(err).slice(0, 300) });
    return { intent: INTENT_OTHER, scope: ALL_TOOLS, freeTimeInquiry: false };
  }
}
