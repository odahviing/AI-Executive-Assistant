/**
 * Social coda generator (v2.2.1 Pattern 1).
 *
 * Called after a task turn where Maelle has delegated to someone else
 * (coord / message_colleague / create_approval / outreach_send) and is
 * waiting for their reply. In that window Maelle has nothing else to do,
 * so she may weave in ONE short social question — respecting the 24h
 * cadence gate per person.
 *
 * v2.2.4 — owner-path only (gated upstream in orchestrator); language hint
 * passed through so the coda matches the conversation's actual language;
 * discovery-mode for raise_new with no existing topics (ask something
 * concrete-and-discoverable rather than fabricating an "offsite next month"
 * topic that doesn't exist).
 *
 * The function produces a single short sentence that gets appended to the
 * task reply (not replacing it). Task content always comes first.
 */

import { getAnthropicClient } from '../../llm/client';
import { SONNET } from '../../llm/models';
import type { UserProfile } from '../../config/userProfile';
import type { LegacySocialDirectiveShape as SocialDirective } from './stateMachine';
import logger from '../../utils/logger';
import {
  getRecentTopicBeats,
  pickLeastRecentlyUsedTopicBeat,
  markTopicBeatUsed,
} from '../../db/socialSubjects';

export async function generateSocialCoda(params: {
  profile: UserProfile;
  directive: SocialDirective;
  senderRole: 'owner' | 'colleague';
  senderFirstName: string;
  /**
   * v2.2.4 — language hint for the coda. The orchestrator passes the
   * dominant language of the current conversation. Sonnet's prompt is
   * always English here; without an explicit instruction Sonnet will
   * default to English regardless of what the surrounding conversation
   * looks like. Pass 'he' for Hebrew, 'en' for English. Falls back to
   * English when omitted.
   */
  language?: 'he' | 'en';
}): Promise<string | null> {
  const { profile, directive, senderRole, senderFirstName, language } = params;
  if (directive.mode === 'none') return null;

  const isOwner = senderRole === 'owner';
  const ownerFirst = profile.user.name.split(' ')[0];

  // v2.6.7 — for continue mode on an existing subject, pull a least-recently-
  // used topic-beat as a concrete hook (avoids spamming the same beat). Mark
  // it used so next time a different beat is preferred. Variety baked in.
  let topicBeatHook: string | null = null;
  if (directive.mode === 'continue' && directive.subjectId) {
    try {
      const lru = pickLeastRecentlyUsedTopicBeat(directive.subjectId);
      if (lru) {
        topicBeatHook = lru.label;
        markTopicBeatUsed(lru.id);
      } else {
        // No beats yet — fall back to a recent-beats list (likely also empty
        // but safe). Coda generator handles missing hook gracefully.
        const recent = getRecentTopicBeats(directive.subjectId, 3);
        if (recent.length > 0) topicBeatHook = recent[0].label;
      }
    } catch (err) {
      logger.warn('coda topic-beat picker threw — proceeding without hook', {
        err: String(err).slice(0, 200),
      });
    }
  }

  let intent: string;
  if (directive.mode === 'continue' && directive.topicLabel) {
    const hookLine = topicBeatHook
      ? ` Recent beat to lean on: "${topicBeatHook}" — only use it if it actually fits the moment, otherwise just ask in your own way.`
      : '';
    intent = `Follow up briefly on "${directive.topicLabel}". One short natural line — don't interrogate, don't recap what was said before.${hookLine}`;
  } else if (directive.mode === 'raise_new') {
    // v2.2.4 (bug 1B) — discovery mode. Without an existing topic to continue,
    // a "raise_new" coda was free to fabricate ("Are you joining the offsite
    // next month?"). Re-frame: ask a concrete, *discoverable* question whose
    // answer is a real fact we'd save to memory.
    // v3.2.6 — anchor to a CONCRETE category the picker chose (music / weekend
    // / travel …) instead of a generic "how's your week". Owner liked the
    // category-anchored ping ("any good music lately?"). Still must NOT invent
    // specifics — ask an open question ABOUT that category, discovering what
    // they're into, not assuming a particular item/event exists.
    const cat = directive.categoryLabel;
    intent = cat
      ? `Ask ONE plain, open question about ${senderFirstName}'s interest in "${cat}" — discover what they're into in that area (e.g. ${cat} = music → what they've been listening to; travel → any trips coming up; weekend → plans this weekend; pets → whether they have any). NEVER assume a specific item/event exists ("that concert", "the marathon you mentioned") — ask open. Plain phrasing — no "by the way", "speaking of".`
      : `Ask ONE plain, open human question — something whose answer is a real fact about ${senderFirstName} you don't already know (what they do outside work, whether they're traveling). NEVER invent a specific event or shared context that doesn't exist. Plain phrasing — no "by the way", "speaking of".`;
  } else if (directive.mode === 'celebrate') {
    intent = `Briefly celebrate the ${directive.topicLabel ?? 'news'} they shared earlier.`;
  } else {
    intent = 'One short warm human follow-up.';
  }

  // v2.2.4 (bug 1A) — language hint. Coda matches the conversation language,
  // not the prompt language.
  const langLine = language === 'he'
    ? 'Write the coda in Hebrew. The conversation has been in Hebrew; an English coda would jar. Match the gendered forms to the person.'
    : language === 'en'
    ? 'Write the coda in English.'
    : '';

  const prompt = `You're ${profile.assistant.name}, ${ownerFirst}'s executive assistant. You just finished handling a task for ${senderFirstName}. The task is parked — waiting on someone else. You have a moment to weave in a small human thing.

Compose a coda sentence that will be appended AFTER the task reply. It should:
- Be ONE short sentence, not two
- Stand on its own, no "Also" / "By the way" / "PS" prefix — just the sentence
- ${intent}
- Feel like something a real human EA would naturally add — never "let me know if you need anything!", never tool-leak
- Match the register of a DM in the middle of a workday
${langLine ? `- ${langLine}` : ''}

${directive.toneCue ? `Tone: ${directive.toneCue}` : ''}
${!isOwner ? `You're talking to ${senderFirstName} (not ${ownerFirst}). Address them directly.` : ''}

Output the coda sentence only. No quotes, no label.`;

  try {
    const anthropic = getAnthropicClient();
    const resp = await anthropic.messages.create({
      ...SONNET,
      max_tokens: 100,
      tools: [{
        name: 'compose_coda',
        description: 'Compose the coda sentence.',
        input_schema: {
          type: 'object' as const,
          properties: { sentence: { type: 'string' } },
          required: ['sentence'],
        },
      }],
      tool_choice: { type: 'tool', name: 'compose_coda' },
      messages: [{ role: 'user', content: prompt }],
    });
    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    const sentence = toolUse?.input?.sentence as string | undefined;
    if (!sentence) return null;
    return sentence.trim();
  } catch (err) {
    logger.warn('generateSocialCoda threw', { err: String(err).slice(0, 200) });
    return null;
  }
}
