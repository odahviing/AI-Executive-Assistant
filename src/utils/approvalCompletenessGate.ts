/**
 * Approval completeness gate (v2.9.2).
 *
 * Output-pass sanity check on `create_approval` BEFORE the DM goes to the
 * owner. Reads ask_text + on_approve.args + recent conversation history,
 * asks Haiku: "Can ${owner} decide without asking a follow-up question?"
 *
 * The 2026-05-19 Yael case that triggered this: Yael said "ideally 11:30"
 * in conversation, but Sonnet's create_approval call had `ask_text` =
 * "Thursday is busy, anything to move?" — no time. Owner read the DM, had
 * to reply "what time?". Sonnet then said "Yael didn't specify" — a lie
 * the data could have caught. The gate is the safety net: it sees both the
 * ask AND the conversation history, so it knows what facts existed and
 * could have been pulled forward.
 *
 * Universal across approval kinds — Haiku judges "is the ask complete for
 * decision-making" against whatever the kind is (meeting time, dinner venue,
 * LinkedIn post text, routine cancellation reason, etc.). No per-kind code.
 *
 * Sibling to claimChecker / humanGate / dateVerifier / securityGate. Same
 * defensive contract: fails open on classifier error.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import { config } from '../config';
import type { UserProfile } from '../config/userProfile';
import logger from './logger';

const anthropic = getAnthropicClient();

export type CompletenessVerdict =
  | { ok: true }
  | { ok: false; missing: string; diagnostic: string };

export interface ApprovalCompletenessInput {
  askText: string;
  onApprove?: { tool: string; args: Record<string, unknown> };
  /** Recent conversation history from the origin thread. Last 6 messages is enough; gate uses to detect "fact existed but was dropped". */
  recentHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** For wording in the diagnostic ("the requester said 11:30 — include it"). Optional. */
  requesterName?: string;
  profile: UserProfile;
}

const SYSTEM_PROMPT_TEMPLATE = (ownerFirst: string) => `
You are a copy editor for approval requests. ${ownerFirst} is the owner. He gets a DM with an approval ask + (optionally) a "If yes → I'll do X" consequence line auto-derived from the action that will fire on approve.

Your job: given the ask_text, the on_approve action's args (if any), and the recent conversation history that produced this approval, decide whether ${ownerFirst} can make a YES/NO/COUNTER decision WITHOUT asking a follow-up clarification question.

GOLDEN RULE: every CONCRETE FACT the requester gave that would matter for the decision must be visible to ${ownerFirst}. The fact lives in ask_text directly, OR in on_approve.args (which the system renders into the consequence line).

Examples of what counts as "concrete fact that must be visible":
- Meeting bookings: proposed time, date, duration, attendees, location/venue if specified
- Dinner / outing: venue, time, party size, occasion
- Location change: from→to (or new venue), which meeting
- LinkedIn post / content approval: the actual text or a representative snippet, the audience, the tone
- Contact updates: whose contact, what field, old→new value
- Routine cancel / change: which routine, the reason

What DOES NOT count as a missing fact:
- Things the requester didn't say (don't fail on "what's your phone number?" if no phone was ever mentioned)
- Owner-side judgment context (don't fail on "is this the right time?" — that's ${ownerFirst}'s decision, not a missing input)
- Tone or politeness — wording quality is fine to skip

DECISION RULE:
- If a fact the requester ACTUALLY gave (visible in recent conversation history) is MISSING from both ask_text AND on_approve.args → ok=false. Name the missing fact specifically.
- If everything the requester said is reflected somewhere ${ownerFirst} will see → ok=true.
- If no relevant facts were given by anyone (open-ended "should we do X?" question without specifics needed) → ok=true.

Output strict JSON only:
{ "ok": true } when complete, or
{ "ok": false, "missing": "<short name of what's missing — e.g. 'proposed time', 'venue', 'post text'>", "diagnostic": "<one sentence telling Sonnet what to add and where — e.g. 'Yael said 11:30 in her last message; include the time in ask_text or set on_approve.args.start'>" } when not.

Fails-open contract: if ambiguous, lean ok=true. Only fail when there's a clear concrete fact the requester gave that ${ownerFirst} cannot see.
`.trim();

/**
 * Run the completeness check on an approval ask. Returns { ok: true } when the
 * owner has enough to decide; { ok: false, missing, diagnostic } otherwise.
 *
 * Fails open: any API / parse error → { ok: true } so legitimate approvals
 * never get blocked by a broken gate.
 */
export async function checkApprovalCompleteness(
  input: ApprovalCompletenessInput,
): Promise<CompletenessVerdict> {
  if (!input.askText || input.askText.trim().length === 0) {
    return { ok: false, missing: 'ask_text', diagnostic: 'ask_text is empty — write the question the owner needs to answer.' };
  }
  if (!config.ANTHROPIC_API_KEY) {
    return { ok: true };  // fail-open when no API key (dev environment)
  }

  const ownerFirst = input.profile.user.name.split(' ')[0];
  const systemPrompt = SYSTEM_PROMPT_TEMPLATE(ownerFirst);

  // Build the user message: ask, on_approve (if any), recent history.
  const onApproveBlock = input.onApprove
    ? `on_approve: ${JSON.stringify(input.onApprove)}`
    : 'on_approve: (none — Sonnet will handle the work on the next turn)';

  const requesterTag = input.requesterName ? ` (from ${input.requesterName})` : '';
  // Keep history short — gate doesn't need ancient context, just enough to
  // see what the requester said in the conversation that produced this ask.
  const recent = (input.recentHistory ?? []).slice(-6);
  const historyBlock = recent.length > 0
    ? recent.map(m => `${m.role}: ${m.content.slice(0, 500)}`).join('\n')
    : '(no recent history)';

  const userMessage = `
ask_text:
"""
${input.askText.slice(0, 2000)}
"""

${onApproveBlock}

Recent conversation history${requesterTag}:
"""
${historyBlock.slice(0, 4000)}
"""

Verdict?`.trim();

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = resp.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')
      .trim();

    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('approvalCompletenessGate — no JSON in response, passing open', {
        preview: text.slice(0, 200),
      });
      return { ok: true };
    }
    const parsed = JSON.parse(jsonMatch[0]) as { ok?: boolean; missing?: string; diagnostic?: string };

    if (parsed.ok === false && typeof parsed.missing === 'string' && parsed.missing.trim().length > 0) {
      logger.info('approvalCompletenessGate — flagged missing specifics', {
        missing: parsed.missing,
        diagnostic: parsed.diagnostic,
        askPreview: input.askText.slice(0, 120),
      });
      return {
        ok: false,
        missing: parsed.missing,
        diagnostic: parsed.diagnostic ?? `ask_text is missing: ${parsed.missing}. Either include it verbatim in ask_text, or set callbacks.on_approve.args so the consequence line carries it.`,
      };
    }

    return { ok: true };
  } catch (err) {
    logger.warn('approvalCompletenessGate — threw, passing open', {
      err: String(err).slice(0, 200),
    });
    return { ok: true };
  }
}
