import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import logger from '../../utils/logger';

// Single client instance — not recreated per call
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/**
 * Decides whether the assistant should respond to a message in a group DM (MPIM).
 *
 * This is NOT the same as channels — in a group DM the assistant was deliberately
 * added, so the default is to RESPOND. Silence is only correct on clearly-defined conditions.
 *
 * IGNORE only when one of these is clearly true:
 *   1. ADDRESSED TO SOMEONE ELSE — message speaks directly to a NAMED PERSON OTHER THAN
 *      the assistant ("John, can you…", "Julia did you…") and has no actionable request
 *      for the assistant. If the assistant's name is NOT mentioned but the message is a
 *      general question, still RESPOND.
 *   2. PURELY PERSONAL/SOCIAL — pure personal chat with zero actionable request and none
 *      of the assistant's skills (scheduling, calendar, tasks, reminders, coordination,
 *      web search) could contribute.
 *   3. EXPLICITLY EXCLUDED — someone told the assistant to stay out of the conversation
 *      or be quiet in this thread.
 *   4. OPENING GREETING — a generic social greeting (hello / good morning) AND the
 *      assistant has not yet spoken AND the message is NOT an introduction of the assistant
 *      to the group (introductions of the assistant always warrant a response).
 *
 * Multi-language: works in any language — no English-specific heuristics.
 *
 * @param text               Raw message text (before mention resolution)
 * @param assistantName      Full name of the assistant, e.g. "Maelle Perrin"
 * @param assistantActive    True if the assistant has already spoken in this thread
 * @param mpimMembers        Names of other participants in the group DM (for context)
 */
export async function isMessageForAssistant(
  text: string,
  assistantName: string,
  assistantActive: boolean = false,
  mpimMembers?: string[],
): Promise<boolean> {
  const trimmed   = text.trim();
  const firstName = assistantName.split(' ')[0].toLowerCase();

  // ── Language-agnostic fast-path ───────────────────────────────────────────
  // If the assistant's name appears AND no one else is @mentioned, respond.
  // If someone else is @mentioned, the name might appear in passing (talking ABOUT
  // the assistant, not TO her) — let the LLM decide.
  const hasMentions = /<@U[A-Z0-9]+>/.test(trimmed);
  if (trimmed.toLowerCase().includes(firstName) && !hasMentions) {
    logger.debug('MPIM relevance: name match (no @mentions) → RESPOND', { preview: trimmed.slice(0, 60) });
    return true;
  }

  // ── LLM classification ────────────────────────────────────────────────────
  const conversationContext = assistantActive
    ? `Context: ${assistantName} has already been participating in this conversation.`
    : `Context: ${assistantName} has not yet spoken in this conversation.`;

  const membersContext = mpimMembers && mpimMembers.length > 0
    ? `\nGroup DM participants (besides the sender): ${mpimMembers.join(', ')}.`
    : '';

  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 5,
      system:
`You decide if an AI assistant should stay SILENT in a group DM. Default is RESPOND.
This is a private group DM — the assistant was deliberately added, so most messages are relevant to her.

Only reply IGNORE if one of these is clearly true:
1. ADDRESSED TO SOMEONE ELSE — the message speaks directly to a named person OTHER THAN the assistant and has no actionable request for the assistant
2. PURELY PERSONAL — pure personal/social chat with zero actionable request and none of the assistant's skills (scheduling, calendar, tasks, reminders, coordination, web search) are relevant
3. EXPLICITLY EXCLUDED — someone told the assistant to be quiet or stay out of this conversation
4. OPENING GREETING — a generic social greeting (hello / good morning) AND the assistant has not yet spoken AND the message is NOT introducing or mentioning the assistant to the group

Important: introductions of the assistant to the group ("this is ${assistantName}, she will help us") always warrant RESPOND.
When in doubt — reply RESPOND. Missing a real request is worse than an extra reply.
The message may be in any language.`,
      messages: [{
        role:    'user',
        content: `Assistant name: ${assistantName}\n${conversationContext}${membersContext}\n\nMessage: "${trimmed}"\n\nReply IGNORE or RESPOND.`,
      }],
    });

    const answer        = ((response.content[0] as Anthropic.TextBlock)?.text ?? '').trim().toUpperCase();
    const shouldRespond = !answer.startsWith('IGNORE');

    logger.debug('MPIM relevance check', {
      preview:         trimmed.slice(0, 80),
      decision:        answer,
      respond:         shouldRespond,
      assistantActive,
      memberCount:     mpimMembers?.length ?? 0,
    });

    return shouldRespond;
  } catch (err) {
    logger.warn('Relevance classifier failed — defaulting to RESPOND', { err: String(err) });
    return true;
  }
}
