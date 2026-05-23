/**
 * Pre-pass intent classifier (v3.0 simplified).
 *
 * Single Sonnet call that classifies a single message:
 *   - kind (task / social / other) + conversation_state
 *   - when social, also: direction, sentiment, category_hint (one of 30 fixed
 *     categories), and an optional topic_label (the beat label for this turn).
 *
 * v3.0 follow-up — subject_match was STRIPPED. The per-turn classifier no
 * longer attempts to identify or match social_subjects rows. Subject
 * decisions (match-existing vs create-new) are now made entirely at
 * end-of-chat by `runSubjectReconciliation` in src/memory/capturePass.ts
 * with the full conversation transcript + rich active-subjects context.
 *
 * Why this is the right shape:
 *   - The per-turn subject decision was the source of the 2026-05-22 duplicate-
 *     subject bug (label drift → demoted to create_new → near-duplicate row).
 *   - Doing the decision at end-of-chat with the full conversation gives
 *     Haiku much better context for granularity decisions (umbrella vs
 *     specific subject) than a single-message snapshot.
 *   - Per-turn just loses dead weight (~700 tokens of active-subjects prompt
 *     + the entire match-or-create reasoning step). Classifier is faster
 *     and cheaper.
 *
 * TASK ALWAYS WINS. Mixed messages classify as task; social comes back later.
 *
 * Fails open — any classifier error returns kind='other'.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../../config/userProfile';
import logger from '../../utils/logger';
import {
  FIXED_CATEGORIES,
} from '../../db/socialSubjects';

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

export async function classifyOwnerIntent(params: {
  anthropic: Anthropic;
  ownerMessage: string;
  profile: UserProfile;
  senderRole?: 'owner' | 'colleague';
  senderName?: string;
  recentContext?: string;
  /** Kept for API back-compat; not used for subject decisions anymore. */
  personSlackId?: string;
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
    ? `'share' (telling ${assistantName} about his life), 'ask_assistant' (asking ${assistantName} something personal), 'reaction' (responding to something ${assistantName} said earlier)`
    : `'share' (telling ${assistantName} about their own life), 'ask_assistant' (asking ${assistantName} something), 'reaction' (responding to something ${assistantName} said earlier)`;

  const systemPrompt = `You classify a single message from ${senderName} (${isOwner ? `${ownerFirst} — the executive who owns this account` : `a colleague talking to ${assistantName}`}) to ${assistantName}.

Output EXACTLY ONE tool call to classify_intent. No prose.

Three classes:

1) TASK — ${senderName} wants ${assistantName} to DO something actionable.
   Examples: "book the meeting", "what's on my calendar today", "reschedule tomorrow".
   If the message contains a request, a question about state, or an instruction to act — task.

2) SOCIAL — ${senderName} is being a PERSON. No action requested.
   Examples: "One Axos down!", "I'm exhausted today", "how was your weekend?",
   "feeling good", "just finished Clair Obscur, ending was wild". Sharing,
   venting, small-talk, asking ${assistantName} something personal.

3) OTHER — bare ack / greeting / close-out with NO follow-on content.
   "ok", "thanks", "cool", "morning", "got it", "later".
   KEY TEST — cut the opening ack word. Anything substantive left → SOCIAL, not OTHER.

TASK ALWAYS WINS. Mixed messages classify as TASK.

For EVERY classification, determine conversation_state ('open' | 'closing').

For SOCIAL only:
- direction: ${directionExamples}
- sentiment: 'positive' | 'negative' | 'neutral'
- category_hint: pick ONE from: ${categoryList}. Skip when nothing fits.
- topic_label: a 2-4 word label for THIS specific beat (e.g. "ending choice", "act 3 progress", "Canvas decision"). Optional but encouraged when there's a beat-level signal in the message.

${recentContext ? `\nRecent conversation context (for reference — classify the LAST message from ${senderName}):\n${recentContext}\n` : ''}`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: systemPrompt,
      tools: [{
        name: 'classify_intent',
        description: 'Classify the message as task / social / other; resolve light social context when social.',
        input_schema: {
          type: 'object' as const,
          properties: {
            kind: { type: 'string', enum: ['task', 'social', 'other'] },
            conversation_state: { type: 'string', enum: ['open', 'closing'] },
            social: {
              type: 'object',
              properties: {
                direction: { type: 'string', enum: ['share', 'ask_assistant', 'reaction'] },
                sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
                category_hint: { type: 'string' },
                topic_label: { type: 'string' },
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

    if (input.kind === 'social' && !input.social) {
      return { kind: 'other', conversation_state: input.conversation_state ?? 'closing' };
    }
    if (!input.conversation_state) input.conversation_state = 'open';

    // Validate category_hint against fixed list (drop if not one of 30)
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
      topic_label: input.social?.topic_label,
      sentiment: input.social?.sentiment,
      preview: ownerMessage.slice(0, 80),
    });

    return input;
  } catch (err) {
    logger.warn('classifyOwnerIntent threw — defaulting to other', { err: String(err).slice(0, 300) });
    return { kind: 'other', conversation_state: 'closing' };
  }
}
