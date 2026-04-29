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

import Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../../config/userProfile';
import type { SocialDirective } from './stateMachine';
import { config } from '../../config';
import logger from '../../utils/logger';

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

  let intent: string;
  if (directive.mode === 'continue' && directive.topicLabel) {
    intent = `Follow up briefly on "${directive.topicLabel}". One short natural line — don't interrogate, don't recap what was said before.`;
  } else if (directive.mode === 'raise_new') {
    // v2.2.4 (bug 1B) — discovery mode. Without an existing topic to continue,
    // a "raise_new" coda was free to fabricate ("Are you joining the offsite
    // next month?" when there's no such offsite). Re-frame: ask a concrete,
    // *discoverable* question — one whose answer is a real fact about the
    // person we'd save to memory afterward. Steer away from invented
    // specifics; lean into open-ended human curiosity.
    intent = `Ask ONE plain, open human question — something whose answer is a real fact about ${senderFirstName} you don't already know (where they're based, what their week looks like, what they do outside work, whether they're traveling, family status if it comes up naturally). NEVER invent a specific event, project, or shared context that doesn't exist ("the offsite next month", "your daughter's recital", "the marathon you mentioned"). If you don't know something specific, ask something general. Plain phrasing — no "by the way", "speaking of", "changing subjects".`;
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
    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
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
