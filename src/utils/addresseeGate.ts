/**
 * Addressee classifier for group DMs.
 *
 * In a group DM (MPIM) or channel where Maelle is present, not every message
 * is for her. When two humans are talking to each other, she should stay
 * silent. This gate runs a cheap Haiku call before invoking the orchestrator
 * and returns one of: MAELLE | HUMAN | AMBIGUOUS.
 *
 * Fast-path: if the incoming message @-mentions the bot user, skip the Haiku
 * call and return MAELLE immediately.
 *
 * Default for AMBIGUOUS: caller treats it as silent — false-positive (she
 * chimes in when she shouldn't) is worse than false-negative (user can
 * always @mention her).
 *
 * Behavior: MAELLE → run orchestrator. HUMAN | AMBIGUOUS → do nothing.
 * AMBIGUOUS cases are logged with level=info so we can audit them later.
 */

import Anthropic from '@anthropic-ai/sdk';
import logger from './logger';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type Addressee = 'MAELLE' | 'HUMAN' | 'AMBIGUOUS';

export async function classifyAddressee(params: {
  text: string;
  botUserId: string;
  assistantName: string;
  ownerFirstName: string;
  /** Recent messages as "Name: text" lines, oldest first, up to ~5 lines. */
  recentContext?: string[];
  /** Names of the humans in the room (excluding Maelle). */
  humanNames?: string[];
}): Promise<Addressee> {
  const { text, botUserId, assistantName, ownerFirstName, recentContext = [], humanNames = [] } = params;

  // Fast-path 1a: raw @mention of the bot (before resolveSlackMentions rewrites it)
  if (text.includes(`<@${botUserId}>`)) return 'MAELLE';
  // Fast-path 1b (v1.8.8): resolved @mention — app.ts rewrites <@ID> into
  // "Name (slack_id: ID)" before the gate runs, so the raw-form check fails.
  // Detect the resolved form too so explicit bot mentions still short-circuit.
  if (text.includes(`(slack_id: ${botUserId})`)) return 'MAELLE';

  // Fast-path 2: explicit name mention at start of message ("Maelle, ...", "Hey Maelle")
  const nameRx = new RegExp(`(^|\\s)(?:hey\\s+|hi\\s+|@)?${assistantName}\\b`, 'i');
  if (nameRx.test(text.slice(0, 40))) return 'MAELLE';

  const peopleLine = humanNames.length
    ? `Humans in the room (besides ${assistantName}): ${humanNames.join(', ')}.`
    : '';
  const contextLine = recentContext.length
    ? `Recent messages (oldest first):\n${recentContext.join('\n')}`
    : '';

  try {
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 12,
      system:
        `You watch a group chat where ${assistantName} is the executive assistant to ${ownerFirstName}. ` +
        `Your job: decide whether the latest message is addressed to ${assistantName}, to a human, or ambiguous. ` +
        peopleLine + ' ' +
        `Rules:\n` +
        `- If the message @-mentions or names a specific human → HUMAN.\n` +
        `- If the message asks a question about ${ownerFirstName}'s schedule/availability/bookings in a way only ${assistantName} would answer → MAELLE.\n` +
        `- If the message continues a human-to-human thread (answering a question one human just asked another) → HUMAN.\n` +
        `- If genuinely unclear → AMBIGUOUS.\n` +
        `Reply with exactly one word: MAELLE, HUMAN, or AMBIGUOUS.`,
      messages: [{
        role: 'user',
        content: `${contextLine}\n\nLatest message: ${text}`.trim(),
      }],
    });
    const raw = ((result.content[0] as Anthropic.TextBlock).text ?? '').trim().toUpperCase();
    if (raw.startsWith('MAELLE')) return 'MAELLE';
    if (raw.startsWith('HUMAN')) return 'HUMAN';
    return 'AMBIGUOUS';
  } catch (err) {
    logger.warn('Addressee classifier failed — defaulting to MAELLE', { err: String(err) });
    // Fail-open to MAELLE so we don't silently drop messages during outages.
    return 'MAELLE';
  }
}
