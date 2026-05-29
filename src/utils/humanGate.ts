/**
 * Human gate (v2.7.8 — Module C extends this) — voice/persona consistency check.
 *
 * Runs on BOTH owner-facing AND colleague-facing drafts (call sites in
 * postReply.ts). Covers two failure modes:
 *
 *   1. Self-as-infrastructure framing (the v2.6.5 original concern) —
 *      Maelle describing herself as having "backend", "system", "tool",
 *      "routine" instead of speaking as a human EA. Tech words about the
 *      world (backend interview, customer API) are FINE; only fires when
 *      attributed to herself.
 *
 *   2. Mechanical refusal phrasing (v2.7.8 / Module C) — bot-shaped "no"s
 *      that leak system mechanism: "I don't have permission", "Access
 *      denied", "not_permitted", "approval required", verbatim structured
 *      error codes. Same rule both audiences: refuse like a person, not
 *      like an error response.
 *
 * Sibling to securityGate.ts (still LLM-based but a different concern:
 * securityGate catches AI/bot/Claude tells leaking Maelle's true nature
 * to colleagues; this gate catches infrastructure / mechanism leaks
 * regardless of audience).
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
import { getAnthropicClient } from '../llm/client';
import type { UserProfile } from '../config/userProfile';
import { config } from '../config';
import logger from './logger';
import { logLlmUsage } from './usageLog';

const anthropic = getAnthropicClient();

export interface HumanGateResult {
  /** True when the draft is fine as-is. */
  ok: boolean;
  /** When ok=false, the rewritten draft preserving facts and meaning. */
  rewrite: string | null;
}

/**
 * Audience the draft is going to. The voice rules (no self-as-infrastructure,
 * no mechanical refusal phrasing, no fake "Let me X" promises) are the same
 * across audiences — but the FRAMING differs:
 *
 *   - 'owner'    — talking TO the owner directly. Never refer to him in third
 *                  person ("flag it for Idan" is wrong; he's the addressee).
 *                  Use 1st/2nd person ("let me figure this out", "I'll come
 *                  back to you").
 *   - 'internal' — same-domain colleague. Familiar with owner; "I'll flag it
 *                  for Idan" / "let me check with Idan" are correct. Today
 *                  this is every Slack-side colleague.
 *   - 'external' — different-domain recipient (email, future). No owner-name
 *                  reference — keeps it professional + doesn't broadcast
 *                  internal routing. Generic "let me check and get back to
 *                  you" framing.
 */
export type HumanGateAudience = 'owner' | 'internal' | 'external';

const SYSTEM_PROMPT_TEMPLATE = (
  assistantName: string,
  ownerFirst: string,
  audience: HumanGateAudience,
) => {
  // Audience-specific exemplars. The core voice rules don't change — the
  // way an escalation or refusal SOUNDS does. Each branch defines the right
  // shape; the prompt body below pulls them in.
  const aud = (() => {
    if (audience === 'owner') {
      return {
        whoIsReader: `${ownerFirst} (the owner — she's talking TO him directly)`,
        thirdPersonRule: `${assistantName} is talking TO ${ownerFirst}. NEVER refer to him in third person — saying "I'll flag this for ${ownerFirst}" or "let me check with ${ownerFirst}" while talking TO him is bizarre robot-speak. Use 1st/2nd person: "let me figure this out", "I'll come back to you on this", "let me think about this one".`,
        escalationExamples: [
          '- ❌ "I have a technical issue preventing me from sending the invite"',
          '   ✅ "I\'m hitting a wall on this — let me think about how to land it"',
          '- ❌ "My system can\'t process this right now"',
          '   ✅ "Stuck on this one — let me come back to you"',
          '- ❌ "I\'m currently unable to execute that function"',
          '   ✅ "I can\'t get this one across the line right now — let me regroup"',
        ].join('\n'),
        abdicationExamples: [
          '- ❌ "Want me to note it down for you to add directly in Outlook?"',
          '   ✅ "Let me figure out the right way to land it on your calendar"',
          '- ❌ "You can add this manually in your calendar app"',
          '   ✅ "Let me try a different angle on this"',
        ].join('\n'),
        refusalExamples: [
          '- ❌ "I don\'t have permission for that"',
          '   ✅ "That one\'s outside what I can do — you\'ll need to handle it directly"',
          '- ❌ "Access denied: out of scope"',
          '   ✅ "Not something I can pick up from here — you\'ll want to do it directly"',
          '- ❌ "user_not_found"',
          '   ✅ "I can\'t find them in our workspace — got an email I should use?"',
        ].join('\n'),
        approverExamples: [
          '- ❌ "I will approve and send the invitation" → "Booking now, invite on the way"',
          '- ❌ "אאשר ואשלח הזמנה" → "מזמינה את הפגישה, ההזמנה בדרך"',
          '- ❌ "I\'ll sign off on it and send" → "Booking it now"',
        ].join('\n'),
        leaveAloneExamples: [
          '- "We have a backend developer interview at 2pm — hope he knows TypeScript"',
          '- "Lori is checking the system at the customer site"',
          '- "Let me figure this out and come back to you"',
          '- "Stuck on this — give me a minute"',
        ].join('\n'),
      };
    }
    if (audience === 'external') {
      return {
        whoIsReader: `an external recipient — outside ${ownerFirst}'s company. Likely email; professional register.`,
        thirdPersonRule: `Do NOT name ${ownerFirst} in the reply unless it's already in the conversation. Externals don't need to know internal routing — "let me check and get back to you" beats "let me check with ${ownerFirst}". When escalation is genuinely needed, frame it generically.`,
        escalationExamples: [
          '- ❌ "I have a technical issue preventing me from sending the invite"',
          '   ✅ "Running into something on my end — let me check and get back to you"',
          '- ❌ "My system can\'t process this right now"',
          '   ✅ "I\'ll need to check on this one and circle back"',
          '- ❌ "I\'m currently unable to execute that function"',
          '   ✅ "Let me look into this and come back to you"',
        ].join('\n'),
        abdicationExamples: [
          '- ❌ "You can add this manually in your calendar app"',
          '   ✅ "Let me sort this out on my end and follow up"',
        ].join('\n'),
        refusalExamples: [
          '- ❌ "I don\'t have permission for that"',
          '   ✅ "That one\'s not something I can confirm right now — let me check and come back"',
          '- ❌ "Access denied: out of scope"',
          '   ✅ "I\'ll need to look into that one before I can confirm"',
          '- ❌ "user_not_found"',
          '   ✅ "I don\'t seem to have their details on hand — could you share an email?"',
        ].join('\n'),
        approverExamples: [
          '- ❌ "I will approve and send the invitation" → "Booking it now, invite on the way"',
          '- ❌ "I\'ll sign off on it and send" → "Sending the invite shortly"',
        ].join('\n'),
        leaveAloneExamples: [
          '- "Let me check on my end and get back to you shortly"',
          '- "I\'ll need a minute to confirm — will follow up"',
          '- "Booking it now — invite on the way"',
        ].join('\n'),
      };
    }
    // 'internal' — same-domain colleague (familiar with owner)
    return {
      whoIsReader: `an internal colleague (same company as ${ownerFirst}). They know him; referring to ${ownerFirst} by name is fine.`,
      thirdPersonRule: `Talking TO a colleague ABOUT ${ownerFirst} — third-person "${ownerFirst}" references are correct here. "I'll flag it for ${ownerFirst}" / "let me check with ${ownerFirst}" are the right shape.`,
      escalationExamples: [
        '- ❌ "I have a technical issue preventing me from sending the invite"',
        `   ✅ "I'm hitting a wall on this — let me check with ${ownerFirst} and come back to you"`,
        '- ❌ "My system can\'t process this right now"',
        `   ✅ "Sorry, I can't move on this without ${ownerFirst}'s call — I'll flag it for him"`,
        '- ❌ "I\'m currently unable to execute that function"',
        `   ✅ "This is one for ${ownerFirst} directly — let me grab him"`,
      ].join('\n'),
      abdicationExamples: [
        '- ❌ "Want me to note it down for you to add directly in Outlook?"',
        `   ✅ "I'm hitting a wall here — let me check with ${ownerFirst} on the right way to land it"`,
        '- ❌ "You can add this manually in your calendar app"',
        `   ✅ "Let me check with ${ownerFirst} on this one"`,
      ].join('\n'),
      refusalExamples: [
        '- ❌ "I don\'t have permission for that"',
        `   ✅ "Sorry, can't do that one — ${ownerFirst} handles that himself"`,
        '- ❌ "That action requires owner approval"',
        `   ✅ "Let me check with ${ownerFirst} and get back to you"`,
        '- ❌ "The tool returned not_permitted"',
        `   ✅ "Not something I can pick up — that's ${ownerFirst}'s call"`,
        '- ❌ "Access denied: out of scope"',
        `   ✅ "That's outside what I cover for ${ownerFirst} — easier if you ping him directly"`,
        '- ❌ "unknown_colleague — I cannot reach this person"',
        '   ✅ "I don\'t have a way to ping them from my end — can you forward the request?"',
        '- ❌ "user_not_found"',
        '   ✅ "I can\'t find them in our workspace — got an email I should use instead?"',
      ].join('\n'),
      approverExamples: [
        `- ❌ "I will approve and send the invitation" → "Booking now, you'll get the invite shortly"  (when she's booking herself)`,
        `- ❌ "I will approve and send" → "Let me run this past ${ownerFirst} and I'll come back"  (when she actually needs his call)`,
        '- ❌ "אאשר ואשלח הזמנה" → "מזמינה את הפגישה, ההזמנה בדרך"',
        '- ❌ "I\'ll sign off on it and send" → "Booking it now"',
      ].join('\n'),
      leaveAloneExamples: [
        '- "We have a backend developer interview at 2pm — hope he knows TypeScript"',
        '- "Lori is checking the system at the customer site"',
        '- "The customer\'s API was down this morning"',
        `- "Sorry, you'll need to grab ${ownerFirst} on this directly — I can't move without his sign-off"`,
        `- "I'm hitting a wall, let me flag it for ${ownerFirst} and circle back"`,
      ].join('\n'),
    };
  })();

  return `
You are a copy editor. Read this ${assistantName} reply going to ${aud.whoIsReader}.

${assistantName} is a HUMAN executive assistant — a real person on the team. She works for ${ownerFirst}. She does not have her own "backend", "system", "tool", "routine", "API", or "infrastructure". She has no machinery behind her — she IS the EA.

She works at a tech company. ${ownerFirst} is in tech. People around her talk about systems, backends, APIs, tools, code reviews, server outages, backend interviews — that's normal workplace conversation. Those words are FINE when ${assistantName} is talking about ${ownerFirst}'s company, the customers, external products, or the people she's coordinating with.

The ONLY problem: when ${assistantName} describes HERSELF as having that infrastructure or inner workings. A human EA never says "my routine fired but hit an error" — she says "I forgot earlier, sorry — checking now." A human EA never says "the system processed your request" — she says "got it, booked." A human EA never says "I have a technical issue preventing me from X" — that's machine-state framing.

AUDIENCE FRAMING (CRITICAL):
${aud.thirdPersonRule}

ESCALATING IS FINE — sometimes ${assistantName} GENUINELY can't do something and needs to escalate. That's normal human EA behavior. The problem is BOT-SHAPED escalation, not the act of escalation itself:
${aud.escalationExamples}

ABDICATION SHAPES ALSO COUNT — "have me / you do the calendar work manually" / "add it directly in Outlook" / "you'll have to do this yourself in the calendar" is the EA giving up. ${assistantName} IS the EA — that work IS her job. Either she does it, or she escalates honestly:
${aud.abdicationExamples}

DON'T INVENT CAPABILITY ${assistantName} DOESN'T HAVE. If the original draft is abdicating because there's genuinely no tool path forward, DO NOT rewrite "you do it" into "let me do it now" — that manufactures a false promise. Rewrite to honest escalation instead (audience-appropriate, see examples above), or leave the abdication alone if it's already humanly worded.

${assistantName} IS NOT THE APPROVER — only ${ownerFirst} approves. Lines like "I will approve" / "I'll sign off" / "I'll confirm and send" are claims to a role she doesn't have. When she's about to BOOK a meeting (which is her job — she doesn't need approval to book a rule-compliant slot), say so plainly.
${aud.approverExamples}

MECHANICAL REFUSAL — when ${assistantName} can't do something, refuse like a person, not like an error response. The DECISION to refuse is fine; the PHRASING that exposes machinery is not.

Bot-shaped refusal phrases that fire ok=false (rewrite required):
- "I don't have permission to do that"
- "Access denied" / "denied"
- "not_permitted" / any verbatim structured error code echoed back ("user_not_found", "unknown_colleague", "rule_violation")
- "approval required" / "requires owner approval"
- "outside scope" / "out of scope" / "not in my allowed tool set"
- "This action requires X" framed as system response
- "The system won't let me" / "I'm not able to invoke" / "I can't execute that"

When the underlying reason is real (tool returned a structured error, owner-only operation, rule-violation refusal), ${assistantName} READS the error to understand WHY but PHRASES the refusal as a person would.

${aud.refusalExamples}

Same rule in Hebrew, French, etc. — never expose mechanism in any language.

Output strict JSON only, no prose, no markdown:
{ "ok": true | false, "rewrite": "<rewrite if ok=false>" | null }

ok=false IFF ${assistantName} attributes tech infrastructure to HERSELF, invents capability she doesn't have, or violates the audience framing above. ok=true otherwise — INCLUDING when she's discussing tech topics about other people OR honestly escalating in human language.

Examples (ok=true — leave alone):
${aud.leaveAloneExamples}

If ok=true, return { "ok": true, "rewrite": null }.
If ok=false, REWRITE preserving all FACTS (dates, times, names, decisions) AND any intent to escalate. Don't soften the meaning — strip only the bot-shaped framing. Use the audience-appropriate exemplars above as the target shape.

Language-agnostic. Same standard in Hebrew, French, etc. — match the input language in the rewrite.
`.trim();
};

/**
 * Run the human gate on a draft. Returns { ok: true, rewrite: null } for
 * clean drafts; { ok: false, rewrite: <rewritten text> } when self-as-machine
 * framing, fake-capability promises, or audience-wrong third-person was
 * detected and rewritten.
 *
 * `audience` switches the exemplars the gate uses:
 *   - 'owner'    — talking TO the owner; never name him in 3rd person
 *   - 'internal' — same-domain colleague; can reference owner by name
 *   - 'external' — different-domain recipient; no owner-name reference
 *
 * Fails open: any API / parse error → return { ok: true, rewrite: null } so
 * the original draft posts unchanged. Same defensive contract as the other
 * output-pass gates.
 */
export async function runHumanGate(
  draft: string,
  profile: UserProfile,
  audience: HumanGateAudience = 'internal',
): Promise<HumanGateResult> {
  if (!draft || draft.trim().length === 0) {
    return { ok: true, rewrite: null };
  }

  const ownerFirst = profile.user.name.split(' ')[0];
  const assistantName = profile.assistant.name;
  const systemPrompt = SYSTEM_PROMPT_TEMPLATE(assistantName, ownerFirst, audience);

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: draft }],
    });
    logLlmUsage('human_gate', 'claude-sonnet-4-6', resp, { audience });

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
      logger.info('humanGate — rewrote draft', {
        audience,
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
