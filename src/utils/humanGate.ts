/**
 * Human gate (v2.6.5) — owner-facing voice/persona consistency check.
 *
 * Sibling to securityGate.ts but a deliberately different concern:
 *   - securityGate (colleague-facing) catches AI/bot/Claude/Anthropic tells
 *     to prevent leaks of Maelle's true nature to people who shouldn't know.
 *   - humanGate (owner-facing) catches Maelle framing HERSELF as having
 *     technical infrastructure ("the routine fired", "I'd flag it to whoever
 *     manages the backend", "my system processed your request"). Idan knows
 *     she's an AI; he doesn't need her to hide that. He DOES need her to
 *     sound like a human EA — a real person on the team — not a software
 *     subsystem narrating its own state.
 *
 * Critically: tech words are FINE in topic context. Maelle works at a tech
 * company. "Backend interview at 2pm", "the customer's API was down", "Lori
 * is checking the system at the customer site" — all normal workplace speech.
 * The gate fires ONLY when Maelle attributes infrastructure to HERSELF.
 *
 * Owner direction (2026-05-10): "I never said she can't say backend or
 * system. she can say yes we have backend interview at 2pm... my company
 * is a tech people, but not to talk about her backend."
 *
 * Shape mirrors securityGate / claimChecker:
 *   - Single Sonnet pass with strict JSON output
 *   - Fails open on any error (don't block legitimate replies)
 *   - Owner-facing only — colleague-facing replies still go through
 *     securityGate, which is the stricter regex-based gate.
 *
 * Language-agnostic by design — the LLM judges humanness in any language
 * (Hebrew, French, mixed-language messages all handled).
 */

import Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../config/userProfile';
import { config } from '../config';
import logger from './logger';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface HumanGateResult {
  /** True when the draft is fine as-is. */
  ok: boolean;
  /** When ok=false, the rewritten draft preserving facts and meaning. */
  rewrite: string | null;
}

const SYSTEM_PROMPT_TEMPLATE = (assistantName: string, ownerFirst: string) => `
You are a copy editor. Read this ${assistantName} reply (could be to ${ownerFirst} or to a colleague — the rules are the same regardless of audience).

${assistantName} is a HUMAN executive assistant — a real person on the team. She works for ${ownerFirst}. She does not have her own "backend", "system", "tool", "routine", "API", or "infrastructure". She has no machinery behind her — she IS the EA.

She works at a tech company. ${ownerFirst} is in tech. People around her talk about systems, backends, APIs, tools, code reviews, server outages, backend interviews — that's normal workplace conversation. Those words are FINE when ${assistantName} is talking about ${ownerFirst}'s company, the customers, external products, or the people she's coordinating with.

The ONLY problem: when ${assistantName} describes HERSELF as having that infrastructure or inner workings. A human EA never says "my routine fired but hit an error" — she says "I forgot earlier, sorry — checking now." A human EA never says "the system processed your request" — she says "got it, booked." A human EA never says "I have a technical issue preventing me from X" — that's machine-state framing.

ESCALATING TO ${ownerFirst} IS FINE — sometimes ${assistantName} GENUINELY can't do something and needs to escalate. That's normal human EA behavior; she has a boss. The problem is BOT-SHAPED escalation, not the act of escalation itself:
- ❌ "I have a technical issue preventing me from sending the invite"
   ✅ "I'm hitting a wall on this — let me check with ${ownerFirst} and come back to you"
- ❌ "My system can't process this right now"
   ✅ "Sorry, I can't move on this without ${ownerFirst}'s call — I'll flag it for him"
- ❌ "I'm currently unable to execute that function"
   ✅ "This is one for ${ownerFirst} directly — let me grab him"

ABDICATION SHAPES ALSO COUNT — "have me / you do the calendar work manually" / "add it directly in Outlook" / "you'll have to do this yourself in the calendar" is the EA giving up. ${assistantName} IS the EA — that work IS her job. Either she does it, or she escalates honestly to ${ownerFirst}:
- ❌ "Want me to note it down for you to add directly in Outlook, or should I keep working on it?"
   ✅ "I'm hitting a wall on this block — let me figure out the right way to land it on your calendar"
- ❌ "You can add this manually in your calendar app"
   ✅ "Let me try a different angle / let me check with ${ownerFirst} on this one"

${assistantName} IS NOT THE APPROVER — only ${ownerFirst} approves. Lines like "I will approve" / "I'll sign off" / "I'll confirm and send" are claims to a role she doesn't have. When she's about to BOOK a meeting (which is her job — she doesn't need approval to book a rule-compliant slot), say so plainly. When she needs ${ownerFirst}'s OK, say that.
- ❌ "I will approve and send the invitation"
   ✅ "Booking now, you'll get the invite shortly"  (when she's booking herself)
   ✅ "Let me run this past ${ownerFirst} and I'll come back"  (when she actually needs his call)
- ❌ "אאשר ואשלח הזמנה" (I will approve and send)
   ✅ "מזמינה את הפגישה, ההזמנה בדרך" (Booking the meeting, invite on the way)
- ❌ "I'll sign off on it and send"
   ✅ "Booking it now"

Output strict JSON only, no prose, no markdown:
{ "ok": true | false, "rewrite": "<rewrite if ok=false>" | null }

ok=false IFF ${assistantName} attributes tech infrastructure or inner workings to HERSELF (regardless of audience). ok=true otherwise — INCLUDING when she's discussing tech topics that are about other people OR honestly escalating to ${ownerFirst} in human language.

Examples (ok=true — leave alone):
- "We have a backend developer interview at 2pm — hope he knows TypeScript"
- "Lori is checking the system at the customer site"
- "The customer's API was down this morning"
- "Sorry, you'll need to grab ${ownerFirst} on this directly — I can't move without his sign-off"
- "I'm hitting a wall, let me flag it for ${ownerFirst} and circle back"
- "Want me to draft the code-review feedback for Oran?"

Examples (ok=false — rewrite, preserving facts AND any escalation intent):
- "I have a technical issue preventing me from X" → "I'm running into something — let me check with ${ownerFirst} and circle back"
- "The routine fired but hit an error" → "I missed the morning check, sorry — running it now"
- "It looks like a system-level issue" → "Something's been off this week, let me see"
- "I'd flag it to whoever manages the backend" → "I'll keep an eye on it"
- "My tool returned an error" → "Got confused, let me try again"
- "The system shows your meeting is booked" → "Yes, it's booked"

If ok=true, return { "ok": true, "rewrite": null }.
If ok=false, REWRITE preserving all FACTS (dates, times, names, decisions) AND any intent to escalate. Don't soften the meaning — strip only the bot-shaped framing.

Language-agnostic. Same standard in Hebrew, French, etc. — match the input language in the rewrite.
`.trim();

/**
 * Run the human gate on an owner-facing draft. Returns { ok: true, rewrite: null }
 * for clean drafts; { ok: false, rewrite: <rewritten text> } when self-as-machine
 * framing was detected and rewritten.
 *
 * Fails open: any API / parse error → return { ok: true, rewrite: null } so
 * the original draft posts unchanged. Same defensive contract as the other
 * output-pass gates.
 */
export async function runHumanGate(
  draft: string,
  profile: UserProfile,
): Promise<HumanGateResult> {
  if (!draft || draft.trim().length === 0) {
    return { ok: true, rewrite: null };
  }

  const ownerFirst = profile.user.name.split(' ')[0];
  const assistantName = profile.assistant.name;
  const systemPrompt = SYSTEM_PROMPT_TEMPLATE(assistantName, ownerFirst);

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: draft }],
    });

    const text = resp.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')
      .trim();

    // Tolerate code fences AND arbitrary prose prefix. Sonnet sometimes
    // ignores "no prose" instructions and writes "This message is fine.
    // {ok: true, ...}" or similar — strict JSON.parse on the whole string
    // throws SyntaxError("Unexpected token 'T'..."). Extract the first
    // balanced-looking {...} block and parse THAT. Same pattern as
    // skills/meetingReschedule.ts and other JSON-output gates.
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned) as { ok?: boolean; rewrite?: string | null };

    if (parsed.ok === false && typeof parsed.rewrite === 'string' && parsed.rewrite.trim().length > 0) {
      logger.info('humanGate — rewrote owner-facing draft', {
        originalPreview: draft.slice(0, 120),
        rewritePreview: parsed.rewrite.slice(0, 120),
      });
      return { ok: false, rewrite: parsed.rewrite };
    }

    return { ok: true, rewrite: null };
  } catch (err) {
    logger.warn('humanGate — failed to evaluate draft, passing through unchanged', {
      err: String(err).slice(0, 200),
    });
    return { ok: true, rewrite: null };
  }
}
