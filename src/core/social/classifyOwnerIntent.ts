/**
 * Pre-pass intent classifier (v2.2.1).
 *
 * Runs BEFORE the main tool loop on every OWNER or COLLEAGUE turn. One
 * Sonnet call with strict tool_use schema → guaranteed JSON. Output decides
 * whether the Social Engine fires for this turn or is skipped entirely.
 *
 *   kind = 'task'   → the person wants ${assistantName} to DO something (book, move,
 *                     check, remind, research). Skip social.
 *   kind = 'social' → the person is being a person (share, vent, small-talk,
 *                     joke, ask about ${assistantName}). Fire the Social Engine.
 *   kind = 'other'  → one-word ack / "ok" / "thanks" / greeting with no
 *                     follow-on. Skip social; piggyback proactive social
 *                     may fire if 24h+ silence.
 *
 * TASK ALWAYS WINS. Mixed messages ("book the meeting, btw did you have a
 * nice weekend?") classify as 'task'; social comes back in a later turn.
 *
 * The function name kept as classifyOwnerIntent for back-compat; it now
 * works for colleague turns too via the senderName + senderRole args.
 *
 * Fails open — any classifier error returns kind='other' so the tool loop
 * runs normally without social context.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../../config/userProfile';
import logger from '../../utils/logger';
import { FIXED_CATEGORIES } from '../../db/socialTopics';

export type OwnerIntentKind = 'task' | 'social' | 'other';
export type OwnerSocialDirection = 'share' | 'ask_maelle' | 'reaction';
export type OwnerSocialSentiment = 'positive' | 'negative' | 'neutral';
export type OwnerConversationState = 'open' | 'closing';

export interface OwnerIntentClassification {
  kind: OwnerIntentKind;
  conversation_state: OwnerConversationState;
  social?: {
    direction: OwnerSocialDirection;
    category_hint?: string;
    topic_label_hint?: string;
    sentiment: OwnerSocialSentiment;
  };
}

export async function classifyOwnerIntent(params: {
  anthropic: Anthropic;
  ownerMessage: string;          // message content (from owner or colleague)
  profile: UserProfile;
  senderRole?: 'owner' | 'colleague';
  senderName?: string;           // colleague display name when senderRole='colleague'
  recentContext?: string;
}): Promise<OwnerIntentClassification> {
  const { anthropic, ownerMessage, profile, recentContext } = params;

  if (!ownerMessage || ownerMessage.trim().length === 0) {
    return { kind: 'other', conversation_state: 'closing' };
  }

  const ownerFirst = profile.user.name.split(' ')[0];
  const assistantName = profile.assistant.name;
  const senderRole = params.senderRole ?? 'owner';
  const senderName = senderRole === 'owner' ? ownerFirst : (params.senderName ?? 'the colleague');
  const categoryList = FIXED_CATEGORIES.join(', ');

  const isOwner = senderRole === 'owner';
  const directionExamples = isOwner
    ? `'share' (telling ${assistantName} about his life), 'ask_maelle' (asking ${assistantName} something personal), 'reaction' (responding to something ${assistantName} said earlier)`
    : `'share' (telling ${assistantName} about their own life), 'ask_maelle' (asking ${assistantName} something, e.g. about her weekend or about ${ownerFirst}), 'reaction' (responding to something ${assistantName} said earlier)`;

  const systemPrompt = `You classify a single message from ${senderName} (${isOwner ? `${ownerFirst} — the executive who owns this account` : `a colleague talking to ${assistantName}, who works for ${ownerFirst}`}) to the AI assistant ${assistantName}.

Output EXACTLY ONE tool call to classify_intent. No prose.

Three classes:

1) TASK — ${senderName} wants ${assistantName} to DO something actionable. Examples:
   ${isOwner
     ? `"book the meeting", "move the 3pm", "delete sales sync", "what's on my calendar today", "any open tasks you have?", "find a slot with Amazia", "remind me Monday", "research X"`
     : `"can you find a time for us to meet with ${ownerFirst}?", "can ${ownerFirst} join at 4pm?", "reschedule tomorrow to 5pm", "what's his availability next week?", "let him know I can't make it"`}.
   If the message contains a request, a question about state, or an instruction to act — task.

2) SOCIAL — ${senderName} is being a PERSON. No action requested. Examples:
   "One Axos down!", "just got back from a great run", "I'm exhausted today",
   "how was your weekend?" (asking ${assistantName}), "did you see the game last night?",
   "feeling good today". Sharing, venting, small-talk, asking ${assistantName} something personal.

3) OTHER — bare acknowledgement, greeting, or close-out with NO follow-on content.
   "ok", "thanks", "cool", "morning", "got it", "hi", "yeah", "sure", "later", "gn".

   KEY TEST — cut the opening ack word. Is there still a real sentence left?
   - "Good. I'm usually dodging — seems easier" → cut "Good.", left with gameplay detail → SOCIAL (not OTHER).
   - "Yeah we went to the beach, kids loved it" → cut "Yeah", left with a real share → SOCIAL.
   - "ok" → cut "ok", nothing left → OTHER.
   - "No. Just playing" → cut "No.", left with "Just playing" — a fact but no hook → OTHER / closing.

   Leading "Good"/"Yeah"/"Sure"/"No" does NOT make the message an ack if substantive content follows.

TASK ALWAYS WINS. Mixed messages classify as TASK.

For EVERY classification (task, social, other), determine conversation_state:
- 'open' — the person is still in the thread: asking, sharing, continuing, extending.
  If ${assistantName} just asked a social question (see recent context) and the reply adds ANY detail, that's OPEN — even if brief.
- 'closing' — the person is winding down: bare ack with no extension, "later", "gotta run", "No. Just playing",
  or a short reply that gives nothing to build on. Also 'closing' when ${assistantName}'s last social question
  in recent context went unanswered for a long gap and the current message is unrelated — the topic went quiet.

For SOCIAL, also determine:
- direction: ${directionExamples}
- category_hint: pick ONE from this global list if the message fits, else leave empty:
  ${categoryList}
- topic_label_hint: a short 2-4 word label for the specific topic inside that category
  (e.g. "Clair Obscur", "new keyboard build", "weekend hike"). Optional.
- sentiment: 'positive' | 'negative' | 'neutral'.

${recentContext ? `\nRecent conversation context (for reference only — classify the LAST message from ${senderName}):\n${recentContext}\n` : ''}`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: systemPrompt,
      tools: [{
        name: 'classify_intent',
        description: 'Classify the owner message as task / social / other.',
        input_schema: {
          type: 'object' as const,
          properties: {
            kind: { type: 'string', enum: ['task', 'social', 'other'] },
            conversation_state: { type: 'string', enum: ['open', 'closing'] },
            social: {
              type: 'object',
              properties: {
                direction: { type: 'string', enum: ['share', 'ask_maelle', 'reaction'] },
                category_hint: { type: 'string' },
                topic_label_hint: { type: 'string' },
                sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
              },
              required: ['direction', 'sentiment'],
            },
          },
          required: ['kind', 'conversation_state'],
        },
      }],
      tool_choice: { type: 'tool', name: 'classify_intent' },
      messages: [{ role: 'user', content: ownerMessage.slice(0, 4000) }],
    });

    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    const input = toolUse?.input as OwnerIntentClassification | undefined;
    if (!input || !input.kind) {
      logger.warn('classifyOwnerIntent — no tool_use in response, defaulting to other');
      return { kind: 'other', conversation_state: 'closing' };
    }

    // Defense: if kind=social but social field missing, collapse to other
    if (input.kind === 'social' && !input.social) {
      return { kind: 'other', conversation_state: input.conversation_state ?? 'closing' };
    }

    // Defense: default conversation_state when missing (shouldn't happen — required in schema)
    if (!input.conversation_state) {
      input.conversation_state = 'open';
    }

    // Defense: validate category_hint against fixed list (drop if unknown)
    if (input.social?.category_hint) {
      const normalized = input.social.category_hint.toLowerCase().trim();
      if (!FIXED_CATEGORIES.includes(normalized)) {
        input.social.category_hint = undefined;
      } else {
        input.social.category_hint = normalized;
      }
    }

    logger.info('classifyOwnerIntent', {
      kind: input.kind,
      conversation_state: input.conversation_state,
      direction: input.social?.direction,
      category: input.social?.category_hint,
      topic: input.social?.topic_label_hint,
      sentiment: input.social?.sentiment,
      preview: ownerMessage.slice(0, 80),
    });

    return input;
  } catch (err) {
    // Fail open — classifier failure must never break the main tool loop.
    logger.warn('classifyOwnerIntent threw — defaulting to other', { err: String(err).slice(0, 300) });
    return { kind: 'other', conversation_state: 'closing' };
  }
}
