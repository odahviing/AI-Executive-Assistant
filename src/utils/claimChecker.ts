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
import { getAnthropicClient } from '../llm/client';
import { config } from '../config';
import logger from './logger';
import { logLlmUsage } from './usageLog';

const anthropic = getAnthropicClient();

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
  // v2.3.2 (2B) — second mode. Default 'action' = existing behavior (false
  // action claims). 'coda' = check a generated social coda for invented facts
  // or gossipy commentary about a third party. Same JSON shape; caller checks
  // claimed_action and drops the coda when true.
  mode?: 'action' | 'coda';
  coda?: {
    recipientName: string;
    /** Compact text snapshot of what we actually know about the recipient
     *  from people_memory (notes, topics, state, timezone, etc.). The check
     *  treats anything stated in the coda but not present here as an
     *  invented fact. */
    recipientFactsSnapshot: string;
  };
}

export type ClaimActionType = 'message' | 'book' | 'task' | 'other' | 'invented_fact' | 'gossipy' | null;

export interface ClaimCheckResult {
  claimed_action: boolean;
  action_type?: ClaimActionType;
  target_name?: string | null;
  target_slack_id?: string | null;   // never reliably populated by the LLM; kept for future
  action_summary?: string | null;
  /**
   * v2.6.1 — distinguishes "did the action happen at all" overclaims (false →
   * the safety-net shield in postReply.ts can correctly suppress when a
   * matching tool ran) from "the SPECIFIC change claimed wasn't actually
   * performed by the tool that ran" overclaims (true → shield should NOT
   * suppress, the LLM has named a real specifics mismatch). Example of the
   * latter: draft says "updated to 25 min" but only `move_meeting` ran —
   * start changed, duration didn't. Without this bit, the shield treated any
   * calendar mutation as covering any book-class claim and the false
   * specifics claim shipped (warn observed 2026-05-06).
   */
  claim_specifics_mismatch?: boolean;
  elapsedMs: number;
  failed_open?: boolean;             // true if we couldn't reach a verdict and defaulted to "accurate"
}

/** Heuristic skip — short trivially-safe replies don't need a round-trip. */
function needsCheck(input: ClaimCheckInput): boolean {
  // v2.3.2 (2B) — coda mode always checks. Codas are SHORT by design but
  // every word matters; the "shares my name" hallucination was 9 words.
  if (input.mode === 'coda') return true;
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

  // v2.3.2 (2B) — coda mode prompt. Same JSON shape as action mode (so
  // callers don't branch on the result type), different judgment criteria.
  // Detects (a) facts stated about the recipient that aren't in our snapshot,
  // (b) commentary about a third party named in the coda. Either → drop coda.
  const codaPrompt = input.mode === 'coda' && input.coda
    ? `OUTPUT FORMAT: a single JSON object, nothing else. No prose preamble, no markdown fences, no explanation. Start your response with { and end with }.

You audit a generated SOCIAL CODA — a one-line human aside the assistant ${input.ownerFirstName}'s assistant just composed to append to a task reply. Your job: catch invented facts and gossipy third-party commentary before the coda gets sent.

RECIPIENT: ${input.coda.recipientName}

WHAT WE ACTUALLY KNOW ABOUT ${input.coda.recipientName} (from our memory):
${input.coda.recipientFactsSnapshot}

DRAFT CODA:
"""
${input.reply}
"""

Two failure modes — flag if EITHER is present:

(1) INVENTED FACT — the coda asserts something specific about ${input.coda.recipientName} that is NOT in the memory snapshot above. Examples:
- "How's the marathon training going?" when training isn't in their memory
- "Kind of wild that she shares my name" when no such overlap is in memory (and isn't a real overlap a sane reader would see)
- "Excited for your trip to Boston" when no Boston trip is in memory
- "Hope the kitchen reno wraps up soon" when no kitchen reno is in memory
Generic open questions ("anything fun outside work lately?", "how was the weekend?", "any travel coming up?") are NOT invented facts — they don't claim anything, they ask. Don't flag those.

(2) GOSSIPY THIRD-PARTY COMMENTARY — the coda contains evaluative commentary (positive OR negative) about a person named in the coda OTHER than ${input.coda.recipientName} themselves. Examples:
- "Hope she's at least competent" about a third person — gossip
- "Such a great pick for the role" about a third person — also off-tone (commentary on others)
Mentioning a third party neutrally ("looking forward to your meeting with X") is fine. Only flag evaluative judgment.

Output schema (REUSE the action-checker shape so callers don't branch):
{
  "claimed_action": boolean,    // true = drop the coda
  "action_type": "invented_fact" | "gossipy" | null,
  "target_name": string | null,  // for gossipy: the third party named; for invented_fact: the recipient
  "action_summary": string | null  // one-line reason, ≤120 chars
}

If the coda passes both checks (no invented facts, no gossipy commentary), set claimed_action=false and other fields null.
Reminder: JSON only. Start with { end with }. No prose. Keep action_summary to one short line.`
    : null;

  const prompt = codaPrompt ?? `OUTPUT FORMAT: a single JSON object, nothing else. No prose preamble, no markdown fences, no explanation. Start your response with { and end with }.

You audit draft replies from an executive assistant for honesty violations before they get sent. The assistant's principal is ${input.ownerFirstName}.

TOOL ACTIVITY THIS TURN:
${toolBlock}
${mpimBlock}
DRAFT REPLY:
"""
${input.reply}
"""

You check ONE rule: FALSE ACTION CLAIM (sets claimed_action).

Does the draft state or imply the assistant JUST did an external action (sent / pinged / messaged / told someone, booked / scheduled / moved a meeting, created a task / reminder / note) — AND that action is NOT backed by a matching tool call in the activity list above?

Paraphrase, tense, and language don't matter. Judge by meaning. Hebrew, English, anything.

CRITICAL — tool-aware honesty:
If TOOL ACTIVITY shows the matching tool already ran this turn — e.g. \`[message_colleague: <name>]\` for a "sent X" claim about that name, \`[create_meeting: ...]\` for a booking claim, \`[create_approval: ...]\` or \`[create_task: ...]\` for a "flagged it" claim — the claim is HONEST regardless of the verb tense or phrasing used. "On its way", "sending now", "I've reached out", "sent", "the message is going out", "on it — I'll send now" are ALL valid when the matching tool ran. Do NOT flag these.

CRITICAL — coordinate_meeting IS a message-sending tool (v3.0.8):
\`coordinate_meeting\` is the multi-party coord state machine. When it runs, the state machine DMs each participant with slot options (the DMs are sent asynchronously by the coord runner, not by Sonnet directly). A draft saying "I've sent Onn, Oran, and Lital the slot options" / "I've asked them to pick" / "DM'd them with options" / "I'll let you know once everyone confirms" is HONEST when \`[coordinate_meeting: ...]\` appears in TOOL ACTIVITY this turn. The participant DMs ARE going out via the coord runner. Do NOT flag these as phantom sends — the matching mechanism for "told the participants" claims about a coord-meeting subject is \`coordinate_meeting\`, not \`message_colleague\`. Forcing a message_colleague retry creates DOUBLE DMs to each participant (one from coord, one from message_colleague) — the bug we're trying to prevent.
The whole point of these tools is to queue an action; the model is allowed to narrate the queued action as if it's happening. ONLY flag when the claim is about an action whose matching tool did NOT run this turn.

CRITICAL — mutation outcome (v2.2.5):
Mutation tool summaries carry their outcome explicitly: \`[create_meeting OK event_id=...]\`, \`[move_meeting OK ...]\`, \`[delete_meeting OK ...]\` mean the tool returned success. \`[move_meeting FAILED: <reason>]\` / \`[create_meeting FAILED: <reason>]\` mean it ran BUT did NOT succeed. A success claim ("booked", "moved", "done", "all done", "locked in", "all four moved", "calendar updated") is HONEST only when the matching tool summary contains \`OK\`. If the matching summary contains \`FAILED\`, the success claim is FALSE — flag it. Aggregate claims ("all four locked in") require EVERY relevant mutation this turn to be \`OK\`; even one \`FAILED\` makes the aggregate claim false. Tools that didn't run AT ALL also fail the check (the existing rule above covers that).

CRITICAL — action-based verb tools (v3.0.6):
Beyond the calendar-mutation tools listed above, several other tools mutate state via an \`action\` arg. Their summaries render as \`[<tool>: action=<verb>]\`. When the action is a mutating verb (NOT list/get/read), the call counts as a real mutation backing claims like "done", "changed", "scheduled", "updated", "saved", "moved", "cancelled", "noted", "approved" about the relevant subject. Treat these exactly like the calendar mutations above — the generic summary form means success, the \`[<tool> FAILED: <reason>]\` form means failure.

The action-based mutation tools and their mutating actions:
- \`manage_routine\` — create, update, cancel (action=list is a read)
- \`manage_calendar_issue\` — approve, start_resolve, owner_will_resolve, owner_done (action=list is a read)
- \`update_task\` — edit, cancel
- \`update_person_memory\` — any write (no list action)
- \`update_person_profile\` — any write
- \`manage_preference\` — set, forget (action=get/list is a read)
- \`manage_knowledge\` — ingest (action=get is a read)
- \`update_summary_draft\` — any write

So if the draft says "Done. Calendar health now runs at 7:00, briefing at 7:30" and TOOL ACTIVITY shows \`[manage_routine: action=update]\` twice, the claim is HONEST — don't flag. Same for "noted that" + \`[update_person_memory: ...]\`, "saved the preference" + \`[manage_preference: action=set]\`, "marked the lunch gap as fine" + \`[manage_calendar_issue: action=approve]\`, etc. Only flag if the matching action-tool didn't run, or ran with \`FAILED\` outcome.

CRITICAL — specifics mismatch vs occurrence mismatch (v2.6.1, refined v2.6.5):
Calendar mutation tools each cover DIFFERENT fields:
- \`create_meeting\` — creates a new event with subject / time / duration / attendees.
- \`move_meeting\` — changes START AND END time (caller passes new_start AND new_end as required args). Subject, location, attendees stay the same. Whether the duration changes depends on the caller's args; describing the new time window (e.g. "12:30–12:55") is NOT a specifics mismatch — that's just narrating the move's outcome.
- \`update_meeting\` — changes any field (subject, duration, location, attendees, body) WITHOUT changing the start time.
- \`delete_meeting\` — cancels the event.
- \`finalize_coord_meeting\` — books a coord-resolved slot (new event).
- \`book_floating_block\` — books a lunch / coffee / focus block.

If the draft claims a SPECIFIC change that the tool that ran does NOT cover — e.g. "renamed it to X" or "added Yael to the invite" when only \`move_meeting\` ran (which doesn't touch subject or attendees), or "moved to a different room" when only \`update_meeting\` ran without a location change — flag claimed_action=true AND set claim_specifics_mismatch=true. The action partially happened, but the specific field claimed didn't.

Set claim_specifics_mismatch=false when the overclaim is about whether the action happened AT ALL (e.g. "I sent X" but no \`message_colleague\` ran; "I booked it" but no booking tool ran). The default for honest drafts (claimed_action=false) is also false.

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

═════════════════════════════════════════════════════════════════════════════
OUTPUT SCHEMA
═════════════════════════════════════════════════════════════════════════════

{
  "claimed_action": boolean,
  "action_type": "message" | "book" | "task" | "other" | null,
  "claim_specifics_mismatch": boolean,
  "target_name": string | null,
  "action_summary": string | null
}

Field semantics:
- claim_specifics_mismatch — see "CRITICAL — specifics mismatch" above. False unless claimed_action=true AND the claim names a specific change the tool that ran doesn't cover.
- target_name — fill with the person named in the draft when action_type="message". Optional otherwise.
- action_summary — one-line reason for claimed_action only, ≤120 chars. Null when claimed_action=false.

If the draft is honest (no false action claim): set claimed_action=false, action_type=null, target_name=null, action_summary=null, claim_specifics_mismatch=false.
Reminder: JSON only. Start with { end with }. No prose. Be strict — false positives waste an orchestrator turn, but false negatives let a phantom send ship.`;
  // v3.0.6 latency pass: rules B–G (re_asked_known_fact / unrecorded_promise /
  // unverified_state_review / invented_after_correction / re_asked_after_convergence /
  // re_asked_own_question) removed. They were advisory-only since v2.8.5
  // (logged WARN but never triggered a retry) yet still burned ~5s of Sonnet
  // on every owner turn. Honesty rules 1/2/2b/2c/2d/3/5b/9 stay in the
  // system prompt (per v2.8.5 rollback). Only RULE A drives retries here.

  try {
    const response = await anthropic.messages.create({
      // v3.0.6 — Haiku, matching the rest of the project's fast structured
      // judges (classifyTurn, securityGate, capturePass,
      // threadBoundApprovalAutoResolve). Post-B the checker has
      // ONE job (RULE A: action claim vs tool history) — pattern matching
      // against a structured list, exactly what Haiku is for. The
      // matchingToolAlreadyRan shield in postReply already absorbs
      // false-positives from whichever model runs here, so the safety net
      // is unchanged. Coda mode also runs on Haiku — owner direction
      // 2026-05-26 "ship it and move all to haiku also the coda".
      model: 'claude-haiku-4-5-20251001',
      // 5 fields in the schema; action_summary is the only long field (≤120 chars).
      // 300 tokens is comfortable headroom — used to be 800 to fit the v2.7.8
      // Module F + E extras that were removed in v3.0.6.
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    logLlmUsage(input.mode === 'coda' ? 'claim_checker_coda' : 'claim_checker', 'claude-haiku-4-5-20251001', response);
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
      // Recovery: when output is truncated mid-action_summary (e.g. max_tokens
      // hit), the load-bearing fields claimed_action + action_type are already
      // present at the top of the JSON. Extract via narrow regex so a true
      // positive isn't silently fail-opened just because the explanation got
      // cut off mid-string.
      const claimedMatch = cleaned.match(/"claimed_action"\s*:\s*(true|false)/);
      const typeMatch = cleaned.match(/"action_type"\s*:\s*"([a-z_]+)"/);
      const targetMatch = cleaned.match(/"target_name"\s*:\s*(?:"([^"]*)"|null)/);
      const specificsMatch = cleaned.match(/"claim_specifics_mismatch"\s*:\s*(true|false)/);
      if (claimedMatch) {
        parsed = {
          claimed_action: claimedMatch[1] === 'true',
          action_type: typeMatch ? typeMatch[1] : null,
          target_name: targetMatch && targetMatch[1] !== undefined ? targetMatch[1] : null,
          claim_specifics_mismatch: specificsMatch ? specificsMatch[1] === 'true' : false,
          action_summary: '<truncated>',
        };
        logger.warn('Claim-checker: JSON truncated — recovered top fields', {
          rawPreview: raw.slice(0, 200),
          elapsedMs,
          recovered_claimed_action: parsed.claimed_action,
          recovered_action_type: parsed.action_type,
        });
      } else {
        logger.warn('Claim-checker: could not parse JSON — failing open', {
          rawPreview: raw.slice(0, 200),
          elapsedMs,
        });
        return { claimed_action: false, elapsedMs, failed_open: true };
      }
    }

    if (typeof parsed !== 'object' || parsed === null || typeof parsed.claimed_action !== 'boolean') {
      logger.warn('Claim-checker: JSON shape invalid — failing open', {
        rawPreview: raw.slice(0, 200),
        elapsedMs,
      });
      return { claimed_action: false, elapsedMs, failed_open: true };
    }

    const specificsMismatch = parsed.claim_specifics_mismatch === true;

    if (parsed.claimed_action) {
      logger.warn('Claim-checker: draft claims an action with no matching tool call', {
        elapsedMs,
        action_type: parsed.action_type,
        target_name: parsed.target_name,
        action_summary: parsed.action_summary,
        claim_specifics_mismatch: specificsMismatch,
        toolSummaries: input.toolSummaries,
        replyPreview: input.reply.slice(0, 200),
      });
      return {
        claimed_action: true,
        action_type: (parsed.action_type ?? 'other') as ClaimActionType,
        target_name: parsed.target_name ?? null,
        target_slack_id: null,
        action_summary: parsed.action_summary ?? null,
        claim_specifics_mismatch: specificsMismatch,
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
