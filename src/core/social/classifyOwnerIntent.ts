/**
 * Pre-pass classifier on every owner-path turn (v2.2).
 *
 * The orchestrator runs this BEFORE the main tool loop. One Sonnet call with
 * a strict tool_use schema → guaranteed JSON. Output decides whether the
 * Social Engine fires for this turn or is skipped entirely.
 *
 *   kind = 'task'   → owner wants Maelle to DO something (book, move, check,
 *                     remind, research, update memory). Skip social. No
 *                     directive, no prompt block.
 *   kind = 'social' → owner is being a person (share, vent, small-talk, joke,
 *                     ask about her weekend). Fire the Social Engine.
 *   kind = 'other'  → one-word ack / "ok" / "thanks" / greeting with no
 *                     follow-on. Skip social, no task either. Default reply.
 *
 * TASK ALWAYS WINS. If a message is genuinely mixed ("book the meeting, btw
 * did you have a nice weekend?") we still classify as 'task'. Social can
 * come back naturally in a later turn.
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

export interface OwnerIntentClassification {
  kind: OwnerIntentKind;
  social?: {
    direction: OwnerSocialDirection;
    category_hint?: string;
    topic_label_hint?: string;
    sentiment: OwnerSocialSentiment;
  };
}

export async function classifyOwnerIntent(params: {
  anthropic: Anthropic;
  ownerMessage: string;
  profile: UserProfile;
  recentContext?: string; // optional short snippet of prior turns
}): Promise<OwnerIntentClassification> {
  const { anthropic, ownerMessage, profile, recentContext } = params;

  if (!ownerMessage || ownerMessage.trim().length === 0) {
    return { kind: 'other' };
  }

  const firstName = profile.user.name.split(' ')[0];
  const categoryList = FIXED_CATEGORIES.join(', ');

  const systemPrompt = `You classify a single message from ${firstName} (an executive) to his AI assistant Maelle.

Output EXACTLY ONE tool call to classify_intent. No prose.

Three classes:

1) TASK — ${firstName} wants Maelle to DO something actionable. Examples:
   "book the meeting", "move the 3pm", "delete sales sync", "what's on my calendar today",
   "any open tasks you have?", "find a slot with Amazia", "remind me Monday to update Yael",
   "check if the brief went out", "research X". If the message contains a request, a question
   about state, or an instruction to act — it's a task.

2) SOCIAL — ${firstName} is being a PERSON. No action requested. Examples:
   "One Axos down!", "just got back from a great run", "my kid said the funniest thing",
   "I'm exhausted today", "how was your weekend?" (asking Maelle), "did you see the new elden ring update?",
   "feeling good today", "argh, hate Mondays". Sharing a win, venting, small-talk, asking Maelle
   something personal, reacting to life.

3) OTHER — minimal acknowledgement, greeting with no follow-on, short reply to Maelle's prior
   message that's neither a task nor a meaningful social share. Examples: "ok", "thanks",
   "cool", "morning", "got it", "hi". Also: confirmations like "yes do it" (in a thread where
   Maelle is waiting for approval — that's task-adjacent but doesn't need social handling).

TASK ALWAYS WINS. If a message is genuinely mixed ("book the meeting, btw hope you had a good
weekend") — classify as TASK. Social can come back in a later turn.

For SOCIAL, also determine:
- direction: 'share' (${firstName} telling Maelle about his life), 'ask_maelle' (asking Maelle
  something personal), 'reaction' (responding to something Maelle said earlier)
- category_hint: pick ONE from this fixed list if the message fits, else leave empty:
  ${categoryList}
- topic_label_hint: a short 2-4 word label for the specific topic inside that category
  (e.g. "Clair Obscur progress", "new keyboard build", "weekend hike"). Optional.
- sentiment: 'positive' (win, excitement, satisfaction), 'negative' (venting, frustration,
  bad news), 'neutral' (factual share without clear valence).

${recentContext ? `\nRecent conversation context (for reference only — classify the LAST owner message):\n${recentContext}\n` : ''}`;

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
          required: ['kind'],
        },
      }],
      tool_choice: { type: 'tool', name: 'classify_intent' },
      messages: [{ role: 'user', content: ownerMessage.slice(0, 4000) }],
    });

    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    const input = toolUse?.input as OwnerIntentClassification | undefined;
    if (!input || !input.kind) {
      logger.warn('classifyOwnerIntent — no tool_use in response, defaulting to other');
      return { kind: 'other' };
    }

    // Defense: if kind=social but social field missing, collapse to other
    if (input.kind === 'social' && !input.social) {
      return { kind: 'other' };
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
    return { kind: 'other' };
  }
}
