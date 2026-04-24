/**
 * Social coda generator (v2.2.1 Pattern 1).
 *
 * Called after a task turn where Maelle has delegated to someone else
 * (coord / message_colleague / create_approval / outreach_send) and is
 * waiting for their reply. In that window Maelle has nothing else to do,
 * so she may weave in ONE short social question — respecting the 24h
 * cadence gate per person.
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
}): Promise<string | null> {
  const { profile, directive, senderRole, senderFirstName } = params;
  if (directive.mode === 'none') return null;

  const isOwner = senderRole === 'owner';
  const ownerFirst = profile.user.name.split(' ')[0];

  let intent: string;
  if (directive.mode === 'continue' && directive.topicLabel) {
    intent = `Follow up briefly on "${directive.topicLabel}". One short natural line — don't interrogate, don't recap what was said before.`;
  } else if (directive.mode === 'raise_new') {
    intent = 'Raise ONE fresh human question on a topic you haven\'t covered with them yet. Plain, short, no preamble ("speaking of...", "by the way...", "changing subjects"). Just ask.';
  } else if (directive.mode === 'celebrate') {
    intent = `Briefly celebrate the ${directive.topicLabel ?? 'news'} they shared earlier.`;
  } else {
    intent = 'One short warm human follow-up.';
  }

  const prompt = `You're Maelle, ${ownerFirst}'s executive assistant. You just finished handling a task for ${senderFirstName}. The task is parked — waiting on someone else. You have a moment to weave in a small human thing.

Compose a coda sentence that will be appended AFTER the task reply. It should:
- Be ONE short sentence, not two
- Stand on its own, no "Also" / "By the way" / "PS" prefix — just the sentence
- ${intent}
- Feel like something a real human EA would naturally add — never "let me know if you need anything!", never tool-leak
- Match the register of a DM in the middle of a workday

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
