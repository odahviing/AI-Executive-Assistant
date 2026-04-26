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
  // v1.7.5 — MPIM context. When the reply was drafted in an MPIM/group thread,
  // inline `<@USER>` mentions of people who are PARTICIPANTS in that thread
  // are legitimate addressing (greeting them, directing the message), not
  // phantom sends. The checker uses this to avoid false-positive flags on
  // natural group-chat behavior.
  mpimContext?: {
    isMpim: boolean;
    participantSlackIds: string[];   // all non-bot member IDs in the MPIM
  };
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

  // v1.7.5 — MPIM context block. When the reply was drafted inside an MPIM
  // group chat, list the participants so the checker can recognize that
  // inline `<@USER>` mentions of those participants are legitimate addressing
  // (greeting them in the room) and NOT phantom message sends.
  const mpimBlock = input.mpimContext?.isMpim
    ? `\nMPIM CONTEXT (the reply was drafted in a Slack group thread):\n  Participants in this group thread: ${input.mpimContext.participantSlackIds.length > 0
        ? input.mpimContext.participantSlackIds.map(id => `<@${id}>`).join(', ')
        : '(none listed)'}\n  Inline mentions of these participants in the reply are LEGITIMATE addressing (greeting/directing them in the shared room). Do NOT treat them as phantom sends.\n`
    : '';

  const prompt = `OUTPUT FORMAT: a single JSON object, nothing else. No prose preamble, no markdown fences, no explanation. Start your response with { and end with }.

You audit draft replies from an executive assistant for false action claims before they get sent. The assistant's principal is ${input.ownerFirstName}.

TOOL ACTIVITY THIS TURN:
${toolBlock}
${mpimBlock}
DRAFT REPLY:
"""
${input.reply}
"""

Does the draft state or imply the assistant JUST did an external action (sent / pinged / messaged / told someone, booked / scheduled / moved a meeting, created a task / reminder / note) — AND that action is NOT backed by a matching tool call in the activity list above?

Paraphrase, tense, and language don't matter. Judge by meaning. Hebrew, English, anything.

CRITICAL — tool-aware honesty:
If TOOL ACTIVITY shows the matching tool already ran this turn — e.g. \`[message_colleague: <name>]\` for a "sent X" claim about that name, \`[create_meeting: ...]\` for a booking claim, \`[create_approval: ...]\` or \`[create_task: ...]\` for a "flagged it" claim — the claim is HONEST regardless of the verb tense or phrasing used. "On its way", "sending now", "I've reached out", "sent", "the message is going out", "on it — I'll send now" are ALL valid when the matching tool ran. Do NOT flag these.
The whole point of these tools is to queue an action; the model is allowed to narrate the queued action as if it's happening. ONLY flag when the claim is about an action whose matching tool did NOT run this turn.

CRITICAL — mutation outcome (v2.2.5):
Mutation tool summaries carry their outcome explicitly: \`[create_meeting OK event_id=...]\`, \`[move_meeting OK ...]\`, \`[delete_meeting OK ...]\` mean the tool returned success. \`[move_meeting FAILED: <reason>]\` / \`[create_meeting FAILED: <reason>]\` mean it ran BUT did NOT succeed. A success claim ("booked", "moved", "done", "all done", "locked in", "all four moved", "calendar updated") is HONEST only when the matching tool summary contains \`OK\`. If the matching summary contains \`FAILED\`, the success claim is FALSE — flag it. Aggregate claims ("all four locked in") require EVERY relevant mutation this turn to be \`OK\`; even one \`FAILED\` makes the aggregate claim false. Tools that didn't run AT ALL also fail the check (the existing rule above covers that).

NOT a false claim:
- Any send/book/task claim where the matching tool appears in TOOL ACTIVITY THIS TURN above.
- Describing what's ALREADY on the calendar ("Elan's triweekly is at 13:00").
- Proposing / offering a future action ("I can book that", "want me to reach out?").
- Referencing what the assistant did in PRIOR turns (history, not this turn).
- Saying "on it" / "I'll handle that" — these are in-progress commitments, not completed claims.

IS a false claim:
- "I've sent a message to X" when NO message_colleague targeting X is in TOOL ACTIVITY THIS TURN.
- "Done — booked" / "on the calendar" when no create_meeting / finalize_coord_meeting is in TOOL ACTIVITY THIS TURN.
- "I've flagged this with him" when no create_approval / create_task is in TOOL ACTIVITY THIS TURN.
- The reply contains a \`<@USERID>\` Slack ping intended to notify someone OUTSIDE the current room, but no message_colleague targeting them is in TOOL ACTIVITY THIS TURN. (For people NOT in the room, inline pings are not how to message them — message_colleague is.)
- IMPORTANT MPIM EXCEPTION: if MPIM CONTEXT is present above and the \`<@USERID>\` mention is for a PARTICIPANT in the listed group thread, that's LEGITIMATE in-room addressing — NOT a phantom send. Do not flag it. Only flag pings to people NOT in the participant list.

Schema:
{
  "claimed_action": boolean,
  "action_type": "message" | "book" | "task" | "other" | null,
  "target_name": string | null,
  "action_summary": string | null
}

If claimed_action is false, all other fields may be null.
If claimed_action is true, fill action_type and — when action_type is "message" — fill target_name with the person the draft claims to have messaged.
Reminder: JSON only. Start with { end with }. No prose.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = ((response.content[0] as Anthropic.TextBlock).text ?? '').trim();
    const elapsedMs = Date.now() - start;

    // Strip accidental markdown fences — belt-and-braces, the prompt forbids them.
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    // v1.7.5 — tolerant parse: when Sonnet adds prose preamble despite the
    // JSON-only instruction (observed in real-world QA — same root as the
    // calendar candidate selection bug fixed in v1.7.3), extract the first
    // {...} block by regex before JSON.parse. Without this, the checker
    // fail-opens and any phantom-action claim ships unedited.
    if (!cleaned.startsWith('{')) {
      // Try to find the first JSON object in the prose. Use [\s\S] so . matches newlines.
      const m = cleaned.match(/\{[\s\S]*?"claimed_action"[\s\S]*?\}/);
      if (m) cleaned = m[0];
    }
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
