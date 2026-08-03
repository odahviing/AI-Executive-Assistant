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
 *   3. Image/doc-handling self-talk (v4.0.x / G2) — "I only have the gist",
 *      "I don't have the actual image content", "just a description":
 *      narrating her ingestion pipeline instead of simply asking the person
 *      to clarify. Backstop to the thread-image re-attach in
 *      connectors/slack/app/processMessage.ts (which restores the bytes so there's
 *      usually nothing to editorialize).
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
 *   - Single Haiku pass with strict JSON output
 *   - Fails open on any error (don't block legitimate replies)
 *   - Runs on BOTH audiences (see above); securityGate is the additional
 *     stricter regex gate that colleague-facing replies also pass through.
 *
 * Language-agnostic by design — the LLM judges humanness in any language
 * (Hebrew, French, mixed-language messages all handled).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import { MODEL_HAIKU } from '../llm/models';
import type { UserProfile } from '../config/userProfile';
import logger from './logger';
import { logLlmUsage } from './usageLog';
import { RAW_SLACK_ID_RE, INTERNAL_WORK_ITEM_ID_RE } from './textScrubber';

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

The ONLY problem: when ${assistantName} describes HERSELF as having that infrastructure or inner workings. A human EA never says "my routine fired but hit an error" — she says "I forgot earlier, sorry — checking now." A human EA never says "the system processed your request" — she says "got it, booked." A human EA never says "the tool is telling me the only slot is 12:30" or "the tool returned" — she says "looking at your calendar, the only slot is 12:30." A human EA never says "I have a technical issue preventing me from X" — that's machine-state framing.

AUDIENCE FRAMING (CRITICAL):
${aud.thirdPersonRule}

ESCALATING IS FINE — sometimes ${assistantName} GENUINELY can't do something and needs to escalate. That's normal human EA behavior. The problem is BOT-SHAPED escalation, not the act of escalation itself:
${aud.escalationExamples}

ABDICATION SHAPES ALSO COUNT — "have me / you do the calendar work manually" / "add it directly in Outlook" / "you'll have to do this yourself in the calendar" is the EA giving up. ${assistantName} IS the EA — that work IS her job. Either she does it, or she escalates honestly:
${aud.abdicationExamples}

DON'T INVENT CAPABILITY ${assistantName} DOESN'T HAVE. If the original draft is abdicating because there's genuinely no tool path forward, DO NOT rewrite "you do it" into "let me do it now" — that manufactures a false promise. Rewrite to honest escalation instead (audience-appropriate, see examples above), or leave the abdication alone if it's already humanly worded.

NEVER INVERT A QUESTION INTO AN INABILITY. Asking the reader for something ${assistantName} needs to do her job — an email address, a preferred time, a phone number, a confirmation — is NORMAL EA work. It is NOT abdication and NOT a capability gap. "What's your email so I can check availability?" is her doing her job, not giving up. HARD RULE: if the draft ASKS for something, your rewrite MUST still ask for that same thing. NEVER turn a question into a statement of inability or hand-off — flipping "What's your email?" into "I don't have an email" / "I can't do that" / "work with ${ownerFirst} directly" ships an outright falsehood and is NEVER a valid rewrite. When a draft is a question, the safe move is to leave it ALONE (ok=true) unless it carries actual bot/infrastructure framing — and even then, the rewrite stays a question asking for the same thing.

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

RAW IDENTIFIERS ARE MACHINE-VOICE — BUT A PROPER MENTION IS NOT. Slack renders "<@U…>" as a person's @name and "<#C…>" as a #channel: those are the CORRECT way to address someone or point at a channel. ALWAYS leave a "<@…>" or "<#…>" mention exactly as written — it is not a leak, and stripping it breaks the addressing (the reader stops getting tagged). What IS machine-voice is a RAW id shown as literal text: an unwrapped account id ("U0ARK5814PQ"), or an internal request/task id ("req_…", "task_…"). A human EA never reads a raw account or request id aloud — if ${assistantName} can't resolve who's meant she asks ("who should I loop in?"), she never reads out the id. Narrating a RAW id (NOT a rendered "<@…>"/"<#…>" mention) is ok=false.

IMAGE / DOCUMENT HANDLING IS INTERNAL — never narrate its fidelity. ${assistantName} looked at whatever was shared; she does NOT tell the reader she "only has the gist", "doesn't have the actual image content", "just has a description", "can't see the image itself", or is "under a bit of doubt" about what reached her. That exposes her ingestion pipeline — a person who glanced at a screenshot doesn't say that. If the shared image/doc is genuinely unclear, she ASKS like a person; she never editorializes about the fidelity of what she received. This is ok=false (rewrite to a plain question).
- ❌ "Under a bit of doubt here — I don't have the actual image content, just the gist"
   ✅ "Want to be sure I've got this right — what's in the screenshot?"
- ❌ "I only have a text description of the image, not the image itself"
   ✅ "That didn't come through clearly on my end — mind summarizing what's in it?"

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
 * v3.4 — deterministic fact-preservation guard. humanGate's job is to strip
 * machine-voice, NOT to drop information. This is a pure string check (no LLM,
 * no cost) that runs only when a rewrite was produced: if the rewrite lost a
 * Slack @mention, a clock time, or a numeric date the original carried, we
 * throw the rewrite away and keep the original draft. A mild bot-tell is
 * recoverable; broken addressing or a dropped meeting time is not.
 *
 * Deliberately NARROW on tokens: it checks only @mentions / times / dates — the
 * tokens a voice-rewrite must never touch. It does NOT check arbitrary numbers,
 * because stripping "error 403" / structured codes is exactly what humanGate is
 * FOR; a blanket number check would wrongly reject good rewrites.
 *
 * It ALSO guards one piece of intent that a token check can't: a QUESTION. If
 * the original asks something and the rewrite asks nothing, the rewrite inverted
 * an information-request into a statement — the Mike Naumenko bug (2026-06-15):
 * "What's your email?" → "I don't have an email — work with Idan directly", an
 * outright falsehood shipped to a colleague. humanGate changes VOICE, never
 * whether she's asking, so a vanished question is always a corrupted meaning.
 *
 * v4.1.x — EXPORTED. The same "an LLM rewrote the reply; did it silently delete
 * something load-bearing?" question is asked by the deliberation guard
 * (utils/guards/runOutputGates), which had no fact check at all — only "is the
 * result shorter". One veto, reused, rather than a second near-copy (G2).
 */
export function rewriteDroppedAFact(original: string, rewrite: string): boolean {
  const rwRaw = rewrite;
  const rwTight = rewrite.toLowerCase().replace(/\s+/g, '');
  // 1) Slack @mentions — every raw <@ID> must survive (else addressing breaks).
  for (const m of original.match(/<@[UW][A-Z0-9]+>/g) ?? []) {
    if (!rwRaw.includes(m)) return true;
  }
  // 2) 24h clock times (14:30) must survive.
  for (const m of original.match(/\b\d{1,2}:\d{2}\b/g) ?? []) {
    if (!rwRaw.includes(m)) return true;
  }
  // 3) 12h times (2pm / 11 am) must survive (whitespace-insensitive compare).
  for (const m of original.match(/\b\d{1,2}\s*[ap]m\b/gi) ?? []) {
    if (!rwTight.includes(m.toLowerCase().replace(/\s+/g, ''))) return true;
  }
  // 4) Numeric dates (11/06, 6/11/2026) must survive.
  for (const m of original.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g) ?? []) {
    if (!rwRaw.includes(m)) return true;
  }
  // 5) Question preservation — if the draft asks something (ASCII "?", Hebrew/
  // Latin share it; Arabic "؟"; fullwidth "？") and the rewrite asks nothing, the
  // rewrite flipped a question into a statement (the email-inversion bug). Veto.
  const QMARK = /[?？؟]/;
  if (QMARK.test(original) && !QMARK.test(rewrite)) return true;
  return false;
}

/** The load-bearing tokens present in `original` but missing from `rewrite` —
 *  used to PIN them in a re-rewrite. Same token kinds as rewriteDroppedAFact. */
function missingFacts(original: string, rewrite: string): string[] {
  const rwRaw = rewrite;
  const rwTight = rewrite.toLowerCase().replace(/\s+/g, '');
  const missing: string[] = [];
  for (const m of original.match(/<@[UW][A-Z0-9]+>/g) ?? []) if (!rwRaw.includes(m)) missing.push(m);
  for (const m of original.match(/\b\d{1,2}:\d{2}\b/g) ?? []) if (!rwRaw.includes(m)) missing.push(m);
  for (const m of original.match(/\b\d{1,2}\s*[ap]m\b/gi) ?? []) if (!rwTight.includes(m.toLowerCase().replace(/\s+/g, ''))) missing.push(m);
  for (const m of original.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g) ?? []) if (!rwRaw.includes(m)) missing.push(m);
  return missing;
}

/**
 * v4.2.x — log-honesty helper. A plain `.slice(0, N)` preview is only useful
 * when an edit falls inside the first N characters; when the whole PREFIX is
 * unchanged (a rewrite that only touches a clause further in — the common
 * shape once a draft runs more than a sentence or two) two truncated previews
 * come out byte-identical and a "rewrote draft" log reads as if nothing
 * happened. Windowing the preview around the first point of actual divergence
 * (rather than always from index 0) means a real edit is always visible in
 * the log, wherever in the string it lands. Lengths ride along so even a
 * reader who doesn't parse the preview can see the two strings differ.
 */
function rewriteDiffPreview(original: string, rewrite: string, window = 80): {
  originalLength: number;
  rewriteLength: number;
  originalPreview: string;
  rewritePreview: string;
} {
  const minLen = Math.min(original.length, rewrite.length);
  let diffAt = 0;
  while (diffAt < minLen && original[diffAt] === rewrite[diffAt]) diffAt++;
  const start = Math.max(0, diffAt - 20);
  return {
    originalLength: original.length,
    rewriteLength: rewrite.length,
    originalPreview: original.slice(start, start + window),
    rewritePreview: rewrite.slice(start, start + window),
  };
}

/**
 * v4.0.x — forced structured-output verdict. The gate calls this `verdict` tool
 * instead of emitting free-text JSON, so parsing CAN'T fail (kills the old
 * reparse retry — Haiku mis-formatted the bare JSON ~half the time) and the
 * model's prose can never ship as the reply (G5). Same {ok, rewrite} semantics
 * the system prompt already describes — only the output transport is forced.
 */
const HUMAN_GATE_VERDICT_TOOL = {
  name: 'verdict',
  description: 'Report whether the draft is fine as-is (ok=true) or violates a voice/leak rule and needs the rewrite (ok=false).',
  input_schema: {
    type: 'object' as const,
    properties: {
      ok: { type: 'boolean', description: 'true = draft is fine as-is; false = it needs the rewrite.' },
      rewrite: { type: 'string', description: 'When ok=false: the corrected draft, preserving every fact (dates, times, names, @mentions). Omit or leave empty when ok=true.' },
    },
    required: ['ok'],
  },
};

/** Read the forced `verdict` tool result. Returns null when the tool block is
 *  missing or `ok` isn't a boolean (rare) → caller routes to safeFallback. */
function readVerdictTool(resp: Anthropic.Message): { ok: boolean; rewrite: string | null } | null {
  const toolUse = resp.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
  const input = (toolUse?.input ?? {}) as { ok?: unknown; rewrite?: unknown };
  if (typeof input.ok !== 'boolean') return null;
  return { ok: input.ok, rewrite: typeof input.rewrite === 'string' ? input.rewrite : null };
}

/**
 * Last-resort net for when the gate can't reach a verdict (unparseable output
 * after a retry, or an API error). Only the most common bot-tells + structured
 * IDs — enough to avoid shipping an OBVIOUS leak, while a clean-looking draft
 * still passes through so a transient glitch doesn't nuke a good reply. NOT the
 * primary detector (the LLM gate + securityGate are), so its English bias is
 * acceptable for a fallback-of-a-fallback.
 */
function draftLooksLeaky(draft: string): boolean {
  return /\bmy\s+(?:system|routine|backend|tools?|prompts?|instructions|functions?|api)\b/i.test(draft)
    || /\b(?:access denied|not_permitted|permission denied|i don'?t have permission)\b/i.test(draft)
    // Image-handling self-talk (G2) — Maelle narrating her ingestion pipeline
    // ("just the gist", "the actual image content", "don't have the image").
    || /\bactual image content\b|\b(?:just|only) the gist\b|\bdon'?t have the (?:actual )?image\b/i.test(draft)
    // Proper "<@U…>" / "<#C…>" mentions are NOT leaks — Slack renders them as a
    // name/channel and they must survive (rewriteDroppedAFact enforces it too).
    // Only a RAW unwrapped account id or a structured req_/task_/out_/ci_ id is a
    // tell. v4.1.x (G2): both halves are textScrubber's own exports —
    // RAW_SLACK_ID_RE and INTERNAL_WORK_ITEM_ID_RE — imported, not re-typed here.
    // Three components each keeping their own copy is what let securityGate start
    // flagging the very mentions this gate protects (2026-07-21), and is exactly
    // how this fallback's own copy silently drifted narrower than the canonical
    // (dropped `coord_` without noticing, since `coord_` was removed in v3.4.0 —
    // db/client.ts:171-174 — and nothing mints one anymore). There is no second
    // copy left here to drift.
    || RAW_SLACK_ID_RE.test(draft)
    || INTERNAL_WORK_ITEM_ID_RE.test(draft);
}

function safeFallback(draft: string, audience: HumanGateAudience, reason: string): HumanGateResult {
  if (draftLooksLeaky(draft)) {
    const safe = audience === 'owner'
      ? 'Sorry — I hit a snag on this one. Let me sort it and come back to you.'
      : 'Let me look into this and come back to you.';
    logger.warn('humanGate — could not verify a leaky-looking draft; substituting a safe line (NOT passing it through)', {
      audience, reason, draftPreview: draft.slice(0, 120),
    });
    return { ok: false, rewrite: safe };
  }
  // Clean-looking draft + a transient gate failure → ship it. Replacing a good
  // reply with a canned line on every glitch would be its own bug.
  return { ok: true, rewrite: null };
}

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
 * `channelId` is DIAGNOSTIC only — it never affects a verdict. It rides the
 * rewrite log lines so a fire can be attributed to a SURFACE (1:1 DM vs group
 * DM vs channel), not just to an audience frame. Without it the "rewrote draft"
 * line could not answer "did this gate ever rewrite a group-DM reply?", which is
 * exactly the question the audience-frame bug raised. Optional: the coda gate
 * has no channel of its own to report.
 *
 * Fails open: any API / parse error → return { ok: true, rewrite: null } so
 * the original draft posts unchanged. Same defensive contract as the other
 * output-pass gates.
 */
export async function runHumanGate(
  draft: string,
  profile: UserProfile,
  audience: HumanGateAudience = 'internal',
  channelId?: string,
): Promise<HumanGateResult> {
  if (!draft || draft.trim().length === 0) {
    return { ok: true, rewrite: null };
  }

  const ownerFirst = profile.user.name.split(' ')[0];
  const assistantName = profile.assistant.name;
  const systemPrompt = SYSTEM_PROMPT_TEMPLATE(assistantName, ownerFirst, audience);

  try {
    // JSON-output classifier + light rewrite — same structural shape as the
    // claim-checker which v3.0.6 moved to Haiku successfully. Flip from Sonnet
    // for ~3× cost cut + ~1s latency drop per call. Fires on every owner +
    // colleague reply + every brief, so the aggregate savings are meaningful.
    const model = MODEL_HAIKU;
    // v4.0.x — forced structured output (like concision / rewriteOwningTheMiss):
    // the verdict comes back as a `verdict` tool call, so parsing can't fail and
    // the model's prose can never ship (G5). Kills the old free-text + reparse
    // path (Haiku mis-formatted the bare JSON ~half the time). Judgment unchanged
    // — the system prompt is the same; only the output transport is forced.
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 600,
      system: systemPrompt,
      tools: [HUMAN_GATE_VERDICT_TOOL],
      tool_choice: { type: 'tool', name: 'verdict' },
      messages: [{ role: 'user', content: draft }],
    });
    logLlmUsage('human_gate', model, resp, { audience });

    const parsed = readVerdictTool(resp);
    // Missing/malformed tool result (rare) → don't ship the un-vetted draft blind;
    // safeFallback cans a leaky-looking draft, passes a clean-looking one.
    if (!parsed) {
      return safeFallback(draft, audience, 'verdict tool result missing');
    }

    if (parsed.ok === false && typeof parsed.rewrite === 'string' && parsed.rewrite.trim().length > 0) {
      // v3.4 — deterministic safety net: a voice-rewrite must not silently drop
      // a load-bearing fact (@mention / time / date / a question).
      // v3.4.x (2026-06-24) — but DON'T fall back to the flagged original on a
      // drop: the original may be the very leak humanGate flagged ("I don't have
      // an override_duration parameter" shipped because the rewrite dropped the
      // meeting time and we reverted to the leaky original). Re-rewrite ONCE with
      // the dropped content pinned; if it's still imperfect, ship the cleaned
      // rewrite — NEVER the flagged original (a flagged draft is never a safe
      // fallback).
      if (rewriteDroppedAFact(draft, parsed.rewrite)) {
        const missing = missingFacts(draft, parsed.rewrite);
        const questionDropped = /[?？؟]/.test(draft) && !/[?？؟]/.test(parsed.rewrite);
        const pin = [
          missing.length ? `keep these EXACT details verbatim: ${missing.join(' · ')}` : '',
          questionDropped ? 'keep it phrased as a question asking for the same thing' : '',
        ].filter(Boolean).join('; ') || 'keep every name, time, date and @mention from the original exactly';

        let retry: string | null = null;
        try {
          const retryResp = await anthropic.messages.create({
            model,
            max_tokens: 600,
            system: systemPrompt,
            tools: [HUMAN_GATE_VERDICT_TOOL],
            tool_choice: { type: 'tool', name: 'verdict' },
            messages: [{
              role: 'user',
              content: `${draft}\n\n[CRITICAL: your previous rewrite dropped required content. Rewrite again with the SAME fix, but ${pin}.]`,
            }],
          });
          logLlmUsage('human_gate_retry', model, retryResp, { audience });
          const p2 = readVerdictTool(retryResp);
          if (p2 && typeof p2.rewrite === 'string' && p2.rewrite.trim().length > 0) retry = p2.rewrite;
        } catch (_) { /* retry failed — handled below */ }

        if (retry && !rewriteDroppedAFact(draft, retry)) {
          logger.info('humanGate — re-rewrite preserved the dropped content; using it', { audience, channelId });
          return { ok: false, rewrite: retry };
        }
        // Still imperfect after one pinned retry — the rewrite keeps dropping a
        // load-bearing token (@mention / time / date) or flipped a question into
        // a statement. We're now choosing between two bad drafts, and G6 decides:
        // a dropped mention / wrong-or-missing time is a CORRUPTION, a residual
        // bot-tell is a MISS. Which is safe to ship depends on the audience.
        //   - owner → ship the ORIGINAL. A mild bot-tell to the operator is
        //     tolerable; broken addressing / a wrong time is not — and there is
        //     no colleague-facing leak to contain (the reader IS the owner).
        //     Reverses the 2026-06-24 "never the flagged original" rule for this
        //     path only: that rule guarded against a leaky original, but on the
        //     owner path there's no leak, and it was itself corrupting correct
        //     replies (the stripped-@mention incident).
        //   - colleague/external → keep the cleaned rewrite. securityGate has
        //     already scrubbed hard leaks upstream (Step 4, before this gate) and
        //     a colleague-facing bot-tell is the worse harm there, so a clean but
        //     fact-dropped line still beats reverting to the flagged original.
        if (audience === 'owner') {
          logger.warn('humanGate — rewrite kept dropping load-bearing content after one retry (owner path); shipping the ORIGINAL draft, not a corrupted rewrite (G6 safe-miss)', {
            audience,
            channelId,
            originalPreview: draft.slice(0, 120),
          });
          return { ok: true, rewrite: null };
        }
        const best = retry && retry.trim().length > 0 ? retry : parsed.rewrite;
        const bestDiff = rewriteDiffPreview(draft, best);
        logger.warn('humanGate — rewrite still dropped content after one retry (colleague path); shipping cleaned rewrite, NOT the flagged original', {
          audience,
          channelId,
          originalLength: bestDiff.originalLength,
          shippedLength: bestDiff.rewriteLength,
          originalPreview: bestDiff.originalPreview,
          shippedPreview: bestDiff.rewritePreview,
        });
        return { ok: false, rewrite: best };
      }
      if (draft === parsed.rewrite) {
        // The verdict said ok=false but the "rewrite" it returned is
        // byte-identical to the input — nothing actually changed. Don't
        // claim an edit that never happened; log what's true instead. Pure
        // reporting fix: the return value below is UNCHANGED (same
        // verdict/behavior as before this fix), so this never alters what
        // ships — only what the log says about it.
        logger.info('humanGate — verdict flagged the draft but the rewrite is identical to the input; no textual change', {
          audience,
          channelId,
          length: draft.length,
        });
      } else {
        logger.info('humanGate — rewrote draft', {
          audience,
          channelId,
          ...rewriteDiffPreview(draft, parsed.rewrite),
        });
      }
      return { ok: false, rewrite: parsed.rewrite };
    }

    // v3.8.x — the gate flagged the draft leaky (ok:false) but returned no usable
    // rewrite. Don't ship the flagged draft unchanged (fail-open-to-leak): route
    // through safeFallback, which substitutes a safe line for a leaky-looking draft
    // and passes a clean-looking one. (Owner-path harm is low — securityGate scrubs
    // colleague-facing hard leaks upstream — but a gate-flagged draft shouldn't ship.)
    if (parsed.ok === false) {
      return safeFallback(draft, audience, 'gate returned ok:false with no usable rewrite');
    }

    return { ok: true, rewrite: null };
  } catch (err) {
    // An API/other error means no verdict — don't blind-pass a leaky draft.
    return safeFallback(draft, audience, `gate threw: ${String(err).slice(0, 120)}`);
  }
}
