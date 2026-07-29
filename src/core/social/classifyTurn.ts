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
import { MODEL_HAIKU } from '../../llm/models';

const MODEL = MODEL_HAIKU;

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
export type ToolScope = 'meetings' | 'calendar' | 'people' | 'tasks' | 'knowledge' | 'summary' | 'social' | 'venue' | 'news' | 'general';

export const ALL_SCOPES: ToolScope[] = ['meetings', 'calendar', 'people', 'tasks', 'knowledge', 'summary', 'social', 'venue', 'news', 'general'];

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
  /**
   * v3.6.4 — people named as participants in a scheduling request, as written
   * (any language/script). Empty when not a scheduling turn or none named. The
   * orchestrator resolves the internal ones deterministically and threads them
   * into the search — so a known colleague is never dropped because Sonnet
   * forgot to resolve the name. Never fuzzy-matched here; this is raw extraction.
   */
  meetingPeople: string[];
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
  /** v3.6.4 — also extract the people named as MEETING PARTICIPANTS, so the
   *  orchestrator can resolve known internal colleagues deterministically
   *  BEFORE the search instead of trusting Sonnet to call find_slack_user
   *  (the recurring dropped-attendee bug: Lori 07-08, Simon 07-09). */
  needMeetingPeople?: boolean;
  senderRole?: 'owner' | 'colleague';
  senderName?: string;
  recentContext?: string;
}): Promise<ClassifyTurnResult> {
  const { anthropic, message, profile, needIntent, needScopes, recentContext } = params;
  const needMeetingPeople = params.needMeetingPeople === true;

  // Nothing requested — return safe defaults (caller shouldn't get here, but
  // be defensive).
  if (!needIntent && !needScopes && !needMeetingPeople) {
    return { intent: INTENT_OTHER, scope: ALL_TOOLS, freeTimeInquiry: false, meetingPeople: [] };
  }

  if (!message || message.trim().length === 0) {
    return { intent: INTENT_OTHER, scope: ALL_TOOLS, freeTimeInquiry: false, meetingPeople: [] };
  }

  // Pure-ack short-circuit — no LLM call for either half. Intent='other'
  // matches what the intent classifier would return for a bare ack (its
  // RULE 3: cut the ack word, nothing substantive left → other), and scope
  // widens to general. Saves the whole roundtrip on "ok" / "thanks" / etc.
  if (looksLikePureAck(message)) {
    return { intent: INTENT_OTHER, scope: ALL_TOOLS, freeTimeInquiry: false, meetingPeople: [] };
  }

  // v3.1.6 — low-signal short reply (1-3 words): "meeting", "book it",
  // "yes do it". A reply this short carries almost no SCOPE signal, so the
  // Haiku classifier is guessing — and a confidently-wrong narrow scope
  // silently drops a needed tool with no recovery (the 2026-05-30 "meeting"
  // → 'knowledge' misroute that dropped set_event_category and left Maelle
  // unable to tag the event). Widen scope to general on short replies: a wrong
  // guess can never drop a tool, short replies are rare so the token cost is
  // negligible, and the continuation almost always needs the prior turn's
  // tools anyway. Word-count is language-agnostic (not regex on meaning).
  // Scope only — intent classification still runs when needed.
  const isLowSignalShortReply = message.trim().split(/\s+/).length <= 3;
  if (isLowSignalShortReply && !needIntent && !needMeetingPeople) {
    return { intent: INTENT_OTHER, scope: ALL_TOOLS, freeTimeInquiry: false, meetingPeople: [] };
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
  const newsActive = (profile.skills as any)?.news === true;
  // v3.x (Change A) — 'people' is always in play (person-write tools moved off
  // ALWAYS_ON). The old 'social' SCOPE was an empty no-op; person notes now
  // route through 'people', so 'social' is no longer offered to the classifier.
  const inPlayScopes: string[] = ['meetings', 'calendar', 'people', 'tasks'];
  if (knowledgeActive) inPlayScopes.push('knowledge');
  if (summaryActive) inPlayScopes.push('summary');
  if (venueActive) inPlayScopes.push('venue');
  if (newsActive) inPlayScopes.push('news');
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
- meetings    — booking/scheduling: checking the calendar to book, moving, cancelling, finding slots, "when am I free", "is X open", attendee availability, "do I have lunch?", "book a meeting with someone". This is the DEFAULT for almost all scheduling — direct booking lives here.
- calendar    — calendar REVIEW & health (not booking): "how's my calendar / next week", "any conflicts / overlaps", "what's broken", "am I double-booked", "is my week ok", weekly review, "do I have my buffer / focus time", "how packed is Thursday". Fires alongside 'meetings'.
- people      — saving or noting a durable fact about a PERSON (a colleague, not the owner's own prefs): where they live/work, timezone, working hours, communication style, gender, a hobby or personal detail — or any "remember / note that <X> about <someone>". Fires when the turn TEACHES you something about a person. (Just reading what you know about someone needs no scope — that tool is always available.)
- tasks       — task list / routines / briefing: "what's pending?", "what did I miss?", "show my tasks", "set up a daily routine", "what's on my brief?".
${knowledgeActive ? '- knowledge   — KB lookups / save a URL / research / "what do we know about X": company, product, customer, competitor, market.\n' : ''}${summaryActive ? '- summary     — post-meeting summary workflow only: classifying summary feedback, sharing a summary, updating a draft, listing speaker unknowns.\n' : ''}${venueActive ? '- venue       — external-venue management: ranking a venue ("rank Coffee Landwer 3"), or asking about saved venues. Finding a venue for a meeting fires here AND \'meetings\'.\n' : ''}${newsActive ? '- news        — personalized NEWS: "what\'s the latest / any news on X", "anything new with <company/topic>", "catch me up on the news", or saving a news interest / preferred source. NOT a general background lookup (that\'s web_search/knowledge).\n' : ''}- general     — pick when ambiguous, or to err toward shipping every tool. Cheap to over-include.

How to choose scopes:
- Default to UNION when the message could touch multiple things.
- "What's pending? Also any conflicts next week?" → ['tasks', 'meetings'].
- Chit-chat / vague / unclear → ['general'].
- ONE scope when unambiguously single-purpose. "Book Mon 10:30 with Yael" → ['meetings'].
- DO NOT include scopes not listed above.
` : '';

  const meetingPeopleSection = needMeetingPeople ? `
MEETING PARTICIPANTS (meeting_people) — set this ONLY when ${senderName} is giving a NEW instruction to set up, schedule, move, or book a MEETING WITH someone. List the people that meeting is WITH, exactly as each is named in the message (first name, full name, nickname, @handle — however written; any language or script).
- Include everyone named as a participant EXCEPT ${assistantName} (you) and ${senderName} (the person writing this message).
- "${isOwner ? 'book 30 min with Lori and Simon' : `I need a meeting with ${ownerFirst} and Simon`}" → the participants named are the OTHER people (e.g. Lori, Simon${isOwner ? '' : `, ${ownerFirst}`}).
- A name can surface without being an instruction to include them. Test each named person: is this a REAL ASK to include them (now or going forward), or a question DISPUTING whether you already checked them, with nothing new asked?
  - Disputing, nothing new asked ("are you sure you didn't check Yael?", "you didn't even look at Yael's calendar") → that name is excluded, even though it's named.
  - A real ask, even phrased as a question ("did you also check Dana?", "can you add Yael too?") → that name IS included.
- The two can share one sentence: "you didn't check Yael — anyway find me 25 min with Levana" disputes Yael (excluded) and separately asks for Levana (included) → return only Levana, never both.
- NOT a scheduling request, or nobody named → return an empty array.
- Do NOT invent, translate, or normalize names — copy them as written. Do NOT guess who a vague reference means; only list explicitly named people.
` : '';

  const systemPrompt = `You classify a single message from ${senderName} (${isOwner ? `${ownerFirst} — the executive who owns this account` : `a colleague talking to ${assistantName}`}) to ${assistantName}.

Output EXACTLY ONE call to classify_turn. No prose.
${intentSection}${scopeSection}${meetingPeopleSection}${recentContext ? `\nRecent conversation (classify the LAST message from ${senderName}):\n${recentContext}\n` : ''}`;

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
  if (needMeetingPeople) {
    properties.meeting_people = {
      type: 'array',
      description: 'People named as participants in a scheduling request, copied as written. Empty array when this is not a scheduling request or nobody is named.',
      items: { type: 'string' },
    };
    // Deliberately NOT in `required` — an empty array (the common non-scheduling
    // case) must be a first-class answer, not a forced hallucination.
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
    const raw = toolUse?.input as (OwnerIntentClassification & { scopes?: string[]; free_time_inquiry?: boolean; meeting_people?: unknown }) | undefined;

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
    // (When isLowSignalShortReply, scope stays ALL_TOOLS — see the short-reply
    // note above: don't trust a narrow classifier guess on a 1-3 word message.)
    let scope: ToolScopeResult = ALL_TOOLS;
    if (needScopes && !isLowSignalShortReply) {
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

    // ── Resolve meeting participants (raw extraction only; the deterministic
    //    name→email resolution is the orchestrator's job) ──
    const meetingPeople = (needMeetingPeople && Array.isArray(raw?.meeting_people))
      ? (raw!.meeting_people as unknown[])
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map(s => s.trim())
          .slice(0, 12)
      : [];

    logger.info('classifyTurn', {
      ...(needIntent ? {
        kind: intent.kind,
        conversation_state: intent.conversation_state,
        direction: intent.social?.direction,
        category: intent.social?.category_hint,
        sentiment: intent.social?.sentiment,
      } : {}),
      ...(needScopes ? { scopes: scope.scopes } : {}),
      ...(needMeetingPeople && meetingPeople.length > 0 ? { meetingPeople } : {}),
      preview: message.slice(0, 80),
    });

    const freeTimeInquiry = isOwner && needIntent && raw?.free_time_inquiry === true;

    return { intent, scope, freeTimeInquiry, meetingPeople };
  } catch (err) {
    logger.warn('classifyTurn threw — defaulting to other / general', { err: String(err).slice(0, 300) });
    return { intent: INTENT_OTHER, scope: ALL_TOOLS, freeTimeInquiry: false, meetingPeople: [] };
  }
}
