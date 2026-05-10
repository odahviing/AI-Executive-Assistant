/**
 * Pre-pass intent + subject classifier (v2.6.7 redesign).
 *
 * Single Sonnet call that:
 *   1. classifies the message kind (task / social / other) + conversation_state
 *   2. when social, also resolves the SUBJECT: matches an existing one or
 *      creates a new label. The classifier sees the active subjects for this
 *      person so it can pull back to existing rather than spawn fresh rows.
 *   3. returns a topic_label — the BEAT under that subject (e.g. "ending choice"
 *      under subject "Clair Obscur Expedition 33").
 *
 * Pre-redesign: classifier returned a free-form `topic_label_hint` per turn;
 * a downstream Jaccard reconciler tried to merge with existing rows. Jaccard
 * 0.5 surface-string match was too strict for sub-beat vocabulary so subjects
 * fragmented (the 2026-05-10 Clair Obscur incident: 9 active rows for one game).
 * The classifier now does the merge decision directly with full semantic context.
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
  getActiveSubjectsForPerson,
} from '../../db/socialSubjects';

export type OwnerIntentKind = 'task' | 'social' | 'other';
export type OwnerSocialDirection = 'share' | 'ask_assistant' | 'reaction';
export type OwnerSocialSentiment = 'positive' | 'negative' | 'neutral';
export type OwnerConversationState = 'open' | 'closing';

export interface SubjectMatch {
  action: 'match_existing' | 'create_new';
  /** When match_existing: id of the matched subject. When create_new: undefined. */
  existing_subject_id?: string;
  /**
   * Subject label. For match_existing: the EXACT label of the matched row
   * (classifier echoes the row's label so it's stable across turns). For
   * create_new: the proposed new label.
   */
  label: string;
}

export interface OwnerIntentClassification {
  kind: OwnerIntentKind;
  conversation_state: OwnerConversationState;
  social?: {
    direction: OwnerSocialDirection;
    sentiment: OwnerSocialSentiment;
    category_hint?: string;
    subject_match?: SubjectMatch;
    /** A short label for THIS turn's beat under the matched/new subject. */
    topic_label?: string;
  };
}

interface ActiveSubjectSnapshot {
  id: string;
  label: string;
  category_label: string;
}

function buildActiveSubjectsBlock(personSlackId: string): { byCategory: string; lookup: ActiveSubjectSnapshot[] } {
  const subjects = getActiveSubjectsForPerson(personSlackId);
  if (subjects.length === 0) {
    return { byCategory: '', lookup: [] };
  }
  // Group by category label (compute via separate SQL? simpler: trust category_id format `cat_global_<label>`).
  const grouped = new Map<string, string[]>();
  const lookup: ActiveSubjectSnapshot[] = [];
  for (const s of subjects) {
    const categoryLabel = s.category_id.replace(/^cat_global_/, '');
    const arr = grouped.get(categoryLabel) ?? [];
    arr.push(s.label);
    grouped.set(categoryLabel, arr);
    lookup.push({ id: s.id, label: s.label, category_label: categoryLabel });
  }
  const lines = Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cat, labels]) => `  ${cat}: ${labels.join('; ')}`);
  return { byCategory: lines.join('\n'), lookup };
}

export async function classifyOwnerIntent(params: {
  anthropic: Anthropic;
  ownerMessage: string;
  profile: UserProfile;
  senderRole?: 'owner' | 'colleague';
  senderName?: string;
  recentContext?: string;
  /**
   * v2.6.7 — person whose subjects we're scoping against. Owner turns:
   * profile.user.slack_user_id. Colleague turns: the colleague's slack_id.
   * The classifier sees this person's existing active subjects so it can
   * merge instead of spawning fresh rows.
   */
  personSlackId: string;
}): Promise<OwnerIntentClassification> {
  const { anthropic, ownerMessage, profile, recentContext, personSlackId } = params;

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

  const { byCategory: activeSubjectsByCategory, lookup } = buildActiveSubjectsBlock(personSlackId);

  const subjectsBlock = activeSubjectsByCategory.length > 0
    ? `\nCurrently active subjects for this person (use these labels EXACTLY when matching — only create_new for genuinely different game / project / person / event):
${activeSubjectsByCategory}
`
    : '\n(No active subjects yet for this person — any social subject you classify is create_new.)\n';

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
${subjectsBlock}
- subject_match (when category_hint is set): decide whether this message is about an EXISTING active subject for this person, or a genuinely NEW one.
  · If the message is about an existing subject → action='match_existing' + label='<the EXACT existing label from the list above>'.
  · Only use action='create_new' when it's a genuinely different game / project / event / person — not just a new beat or stage of an existing subject. "Finished Clair Obscur" is the SAME subject as "Clair Obscur Expedition 33" — match_existing. "Heroes of Olden Era" is a different game — create_new.
  · Comparison messages ("Heroes is harder than Clair Obscur was"): pick the dominant subject of the message — usually the one being primarily discussed. If the message is genuinely about comparing, you may create_new with a label like "comparing Heroes to Clair Obscur".
- topic_label: a 2-4 word label for THIS specific beat under the subject (e.g. "ending choice", "act 3 progress", "Canvas decision"). Optional but encouraged when there's a beat-level signal in the message.

${recentContext ? `\nRecent conversation context (for reference — classify the LAST message from ${senderName}):\n${recentContext}\n` : ''}`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      tools: [{
        name: 'classify_intent',
        description: 'Classify the message as task / social / other; resolve subject when social.',
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
                subject_match: {
                  type: 'object',
                  properties: {
                    action: { type: 'string', enum: ['match_existing', 'create_new'] },
                    label: { type: 'string' },
                  },
                  required: ['action', 'label'],
                },
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

    // Validate category_hint against fixed list
    if (input.social?.category_hint) {
      const normalized = input.social.category_hint.toLowerCase().trim();
      if (!FIXED_CATEGORIES.includes(normalized)) {
        input.social.category_hint = undefined;
        // Drop the subject match too — without a category we can't place it.
        input.social.subject_match = undefined;
      } else {
        input.social.category_hint = normalized;
      }
    }

    // When match_existing: resolve label → existing_subject_id by walking the
    // lookup. If the LLM's "exact" label doesn't appear in the active list
    // (Sonnet hallucinated), demote to create_new. This is the Jaccard-replacement
    // safety net — the LLM owns the merge decision; we just verify the id exists.
    if (input.social?.subject_match?.action === 'match_existing') {
      const claimed = input.social.subject_match.label.trim().toLowerCase();
      const matched = lookup.find(s => s.label.trim().toLowerCase() === claimed);
      if (matched) {
        input.social.subject_match.existing_subject_id = matched.id;
      } else {
        logger.warn('classifyOwnerIntent — match_existing label not in active set, demoting to create_new', {
          claimed: input.social.subject_match.label,
          activeCount: lookup.length,
        });
        input.social.subject_match.action = 'create_new';
        delete input.social.subject_match.existing_subject_id;
      }
    }

    logger.info('classifyOwnerIntent', {
      kind: input.kind,
      conversation_state: input.conversation_state,
      direction: input.social?.direction,
      category: input.social?.category_hint,
      subject_action: input.social?.subject_match?.action,
      subject_label: input.social?.subject_match?.label,
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
