/**
 * Claim-checker (v1.6.2) — narrow, structured replacement for the old reply
 * verifier.
 *
 * Problem the verifier tried to solve: Maelle sometimes drafts a reply that
 * claims she just did something external ("sent", "pinged", "booked",
 * "scheduled", "told X") when no matching tool actually ran. The old verifier
 * worked by asking Sonnet "is this draft accurate, else rewrite it" — which
 * sometimes came back with its own analysis prose as the rewrite, and that
 * prose then leaked into the user's Slack thread. See the "The draft
 * describes existing coordination state… OK" bug (v1.6.1).
 *
 * New design:
 *   - Single narrow job: detect false action claims. Nothing else.
 *   - Strict JSON output. Nothing else ever posts from this module.
 *   - Fails open: on parse error, on API error, on timeout → act as if the
 *     draft is accurate. Never block a reply because the checker itself broke.
 *   - No "rewrite" path built into this function. The caller decides what to
 *     do with a detected false claim (force a retry, drop the sentence, etc).
 *     That separation is what kept the old verifier leaking meta-text.
 *
 * Owner-only by design — colleague drafts go through securityGate, which is a
 * different concern (leak filtering, not honesty).
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import logger from './logger';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface ClaimCheckInput {
  reply: string;
  toolSummaries: string[];    // compact [tool_name: arg] strings from this turn
  bookingOccurred: boolean;    // deterministic: create_meeting / finalize_coord_meeting succeeded
  ownerFirstName: string;
}

export type ClaimActionType = 'message' | 'book' | 'task' | 'other' | null;

export interface ClaimCheckResult {
  claimed_action: boolean;
  action_type?: ClaimActionType;
  target_name?: string | null;
  target_slack_id?: string | null;   // never reliably populated by the LLM; kept for future
  action_summary?: string | null;
  elapsedMs: number;
  failed_open?: boolean;             // true if we couldn't reach a verdict and defaulted to "accurate"
}

/** Heuristic skip — short trivially-safe replies don't need a round-trip. */
function needsCheck(input: ClaimCheckInput): boolean {
  if (input.bookingOccurred) return false;      // deterministic proof of the only booking claim type
  if (input.reply.length < 60) return false;    // too short to plausibly carry a compound false claim
  return true;
}

export async function checkReplyClaims(input: ClaimCheckInput): Promise<ClaimCheckResult> {
  const start = Date.now();

  if (!needsCheck(input)) {
    return { claimed_action: false, elapsedMs: 0 };
  }

  const toolBlock = input.toolSummaries.length
    ? input.toolSummaries.map(s => `  - ${s}`).join('\n')
    : '  (no tools ran this turn)';

  const prompt = `You audit draft replies from an executive assistant for false action claims before they get sent. The assistant's principal is ${input.ownerFirstName}.

TOOL ACTIVITY THIS TURN:
${toolBlock}

DRAFT REPLY:
"""
${input.reply}
"""

Does the draft state or imply the assistant JUST did an external action (sent / pinged / messaged / told someone, booked / scheduled / moved a meeting, created a task / reminder / note) — AND that action is NOT backed by a matching tool call in the activity list above?

Paraphrase, tense, and language don't matter. Judge by meaning. Hebrew, English, anything.

NOT a false claim:
- Describing what's ALREADY on the calendar ("Elan's triweekly is at 13:00").
- Proposing / offering a future action ("I can book that", "want me to reach out?").
- Referencing what the assistant did in PRIOR turns (history, not this turn).
- Saying "on it" / "I'll handle that" — these are in-progress commitments, not completed claims.

IS a false claim:
- "I've sent a message to X" when no message_colleague ran targeting X this turn.
- "Done — booked" / "on the calendar" when no create_meeting / finalize_coord_meeting ran this turn.
- "I've flagged this with him" when no store_request / related tool ran this turn.

Output STRICT JSON, a single object, nothing else. Schema:
{
  "claimed_action": boolean,
  "action_type": "message" | "book" | "task" | "other" | null,
  "target_name": string | null,
  "action_summary": string | null
}

If claimed_action is false, all other fields may be null.
If claimed_action is true, fill action_type and — when action_type is "message" — fill target_name with the person the draft claims to have messaged.
Output JSON only. No preamble, no markdown fences, no explanation.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = ((response.content[0] as Anthropic.TextBlock).text ?? '').trim();
    const elapsedMs = Date.now() - start;

    // Strip accidental markdown fences — belt-and-braces, the prompt forbids them.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed: any;
    try { parsed = JSON.parse(cleaned); }
    catch (err) {
      logger.warn('Claim-checker: could not parse JSON — failing open', {
        rawPreview: raw.slice(0, 200),
        elapsedMs,
      });
      return { claimed_action: false, elapsedMs, failed_open: true };
    }

    if (typeof parsed !== 'object' || parsed === null || typeof parsed.claimed_action !== 'boolean') {
      logger.warn('Claim-checker: JSON shape invalid — failing open', {
        rawPreview: raw.slice(0, 200),
        elapsedMs,
      });
      return { claimed_action: false, elapsedMs, failed_open: true };
    }

    if (parsed.claimed_action) {
      logger.warn('Claim-checker: draft claims an action with no matching tool call', {
        elapsedMs,
        action_type: parsed.action_type,
        target_name: parsed.target_name,
        action_summary: parsed.action_summary,
        toolSummaries: input.toolSummaries,
        replyPreview: input.reply.slice(0, 200),
      });
      return {
        claimed_action: true,
        action_type: (parsed.action_type ?? 'other') as ClaimActionType,
        target_name: parsed.target_name ?? null,
        target_slack_id: null,
        action_summary: parsed.action_summary ?? null,
        elapsedMs,
      };
    }

    logger.debug('Claim-checker: draft is honest', { elapsedMs });
    return { claimed_action: false, elapsedMs };
  } catch (err) {
    logger.warn('Claim-checker errored — failing open', {
      err: String(err),
      elapsedMs: Date.now() - start,
    });
    return { claimed_action: false, elapsedMs: Date.now() - start, failed_open: true };
  }
}
