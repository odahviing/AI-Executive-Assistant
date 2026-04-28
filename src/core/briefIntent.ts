/**
 * Brief-request intent classifier (v2.3.2).
 *
 * Owner direction: when the owner asks Maelle for the morning brief / daily
 * summary / "what's on today", route DETERMINISTICALLY to send_briefing_now.
 * Don't let Sonnet improvise a calendar rundown via raw get_calendar calls
 * (which produced inconsistent shape, hallucinated open items, and embellished
 * with "your window is X" framing the owner doesn't want).
 *
 * Two-stage gate:
 *   1. Cheap regex pre-filter — most working DMs don't even reach the classifier.
 *      Pattern catches the obvious phrasings: "brief", "briefing", "morning
 *      update", "rundown", "what's on / what do I have", "didn't get / where's
 *      my brief", "catch me up", "any updates". Length cap (≤ 100 chars) drops
 *      long working messages that mention "brief" mid-sentence.
 *   2. Sonnet yes/no judge — only on candidates. One tool_use, ~120 tokens.
 *
 * The classifier is deliberately STRICT in its definition (see prompt): "asking
 * for the daily brief" only. NOT "brief me on Yael" / "give me a quick brief
 * on the proposal". False negatives are acceptable (fall back to orchestrator);
 * false positives produce a wrong-thing reply (the morning brief instead of
 * what was actually asked).
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import logger from '../utils/logger';

const PRE_FILTER = /\b(brief(ing)?|morning update|rundown|what.{0,4}(on|today|do i have)|catch me up|any updates|missed.{0,15}brief|where.{0,10}brief|didn.?t (get|see).{0,20}brief)\b/i;
const MAX_PREFILTER_LEN = 100;

export async function isBriefRequest(userMessage: string): Promise<boolean> {
  const trimmed = userMessage.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PREFILTER_LEN) return false;
  if (!PRE_FILTER.test(trimmed)) return false;

  try {
    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 80,
      tools: [{
        name: 'classify',
        description: 'Classify whether the message is asking for the morning brief.',
        input_schema: {
          type: 'object' as const,
          properties: {
            is_brief_request: {
              type: 'boolean',
              description: 'True ONLY if the user is asking for THEIR morning briefing / daily summary / "what is on my plate today". False if they are asking to be briefed ON A SPECIFIC PERSON or TOPIC, or asking a different question that happens to contain the word "brief".',
            },
          },
          required: ['is_brief_request'],
        },
      }],
      tool_choice: { type: 'tool', name: 'classify' },
      messages: [{
        role: 'user',
        content: `Is the following message asking for the daily morning brief / executive summary / "what's on today" rundown?

Message: "${trimmed}"

YES examples (ask for the daily brief):
- "didn't get my morning update"
- "send me the brief"
- "where's my briefing today"
- "what's on my plate"
- "what do I have today"
- "catch me up"
- "any updates this morning"

NO examples (NOT a daily-brief request):
- "brief me on Yael's status"
- "give me a quick brief on the proposal"
- "what's on the cookie post"  (asking about a specific item)
- "morning, did Yael respond?"
- "what's the briefing time set to?"  (config question)
- "schedule a meeting tomorrow"

Output via the classify tool.`,
      }],
    });

    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    const verdict = toolUse?.input?.is_brief_request === true;
    logger.debug('briefIntent classified', { trimmed: trimmed.slice(0, 80), verdict });
    return verdict;
  } catch (err) {
    logger.warn('briefIntent classifier threw — defaulting to no', { err: String(err).slice(0, 200) });
    return false;
  }
}
