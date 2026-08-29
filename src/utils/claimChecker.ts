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
 * Scoped to turns the OWNER is acting on — his 1:1 DM, and his own turns in a
 * group DM (where it runs alongside securityGate, not instead of it: honesty and
 * leak-filtering are different concerns and a group reply needs both). A
 * colleague's own turn otherwise doesn't run it: the RULE-A phantom-action check
 * exists so the person who can go and chase an un-done action finds out it
 * didn't happen, and that person is the owner. The MPIM branch below
 * (mpimContext) serves exactly the group case.
 *
 * v4.4.x (#154) — ONE exception to "colleague's own turn doesn't run it": the
 * room-approval honesty check (approvalGrantContext). It runs on a real
 * colleague's own turn too, because the risk it guards is the opposite of RULE
 * A's — not "did the owner's claimed action really happen" but "does this room
 * reply falsely tell the COLLEAGUE a decision came back (including a decision
 * that came back NEGATIVE)". The caller (runOutputGates.ts) gates it
 * deterministically — gh#154-R7 (2026-08-06): a request row must have EVER existed
 * for this thread (getLatestRequestForThread), and then EITHER a request is
 * genuinely `awaiting_owner` right now OR no request in the thread was ever
 * resolved — so it never runs on an ordinary colleague turn with no request
 * at all, and a thread whose request(s) resolved stops costing anything once
 * resolved, but a thread that only ever went cancelled/expired keeps paying
 * for as long as it stays active, because that is exactly where a false
 * "he approved it" claim is provably false.
 *
 * owner-personal-fact-fabricated-in-colleague-reply (2026-08-14) — a SECOND,
 * unrelated exception, and a different mode entirely (mode: 'owner_fact', not
 * RULE A's 'action'): catches a draft that states, as settled fact, an
 * unverified PERSONAL/CAPABILITY claim about the OWNER HIMSELF ("a phone call
 * from the car works for him") to a colleague, with no grounding anywhere.
 * This is the mirror image of coda mode's invented-fact check (which guards
 * facts about the RECIPIENT) — this guards facts about the PRINCIPAL. The
 * caller (runOutputGates.ts's runOwnerFactCheckAndMaybeRewrite) invokes it on
 * EVERY colleague-readable turn, independent of RULE A's own
 * ownerIsActing/approvalGrantContext scoping above — a colleague reading a
 * fabricated fact about the owner is the risk regardless of who is typing.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import { SONNET, MODEL_SONNET, MODEL_HAIKU } from '../llm/models';
import logger from './logger';
import { extractFirstJsonObject } from './extractJson';
import { logLlmUsage } from './usageLog';
import { detectMessageLanguage } from './detectMessageLanguage';

const anthropic = getAnthropicClient();

/**
 * gh#194-b-confession-overpromises-unexecuted-action (2026-08-10, bouncer
 * overturn) — the safe fallback for `rewriteOwningTheMiss` once verdict=
 * "rewrite" has already independently confirmed the draft is false, but the
 * model's own proposed rewrite can't be trusted (empty/meta, or fails the
 * noPendingActionClaim self-attestation). Never the original (a proven false
 * claim) — a fixed, tool-less, generic line that asserts nothing about any
 * action. See rewriteOwningTheMiss's own doc comment for why English-only is
 * an accepted compromise on this rare-of-rare path.
 */
const GENERIC_HONEST_MISS = "Actually, hold on — I'm not sure that went through. Let me double check and come back to you.";

/**
 * owner-personal-fact-fabricated-in-colleague-reply (2026-08-14, bouncer
 * retry) — the invented-owner-fact sibling of GENERIC_HONEST_MISS above, for
 * the exact same reason: once `rewriteOwningTheMiss` has confirmed
 * (actionType === 'invented_fact') that the draft asserts an ungrounded
 * personal claim about the owner, but BOTH its full rewrite AND its
 * minimal-redaction alternative (see `minimalRedaction` below) can't be
 * trusted, this ships instead of the proven-fabricated original. This is the
 * true last resort — most flags are handled by `minimalRedaction`, which
 * keeps the rest of the message intact.
 *
 * Two things this does NOT do, both bouncer findings on the first pass:
 *   - No "I'll check with him and get back to you" promise. RULE A's own
 *     fallback (GENERIC_HONEST_MISS) can make that kind of promise because
 *     this file's caller opens a durable tracked reminder right behind it
 *     (runOutputGates.ts's relay-to-owner backstop) — it has a deterministic
 *     "what" to relay (the colleague's own turn text). An arbitrary
 *     fabricated personal-fact claim has no equivalent deterministic anchor,
 *     so a promise here would be words with nothing behind them. Safer to
 *     make no promise than an untracked one.
 *   - Not English-only. Reuses `detectMessageLanguage` (W4 — script
 *     detection, not a language guess) so a Hebrew/Russian/Arabic thread
 *     doesn't get an English line in its otherwise-native-language reply.
 */
// email-leg-hedge-shipped-colleague-third-person-wording (2026-08-28) — this
// line was written for the colleague-facing case (talking ABOUT the owner to
// someone else, hence "confirm it with him directly"), then reused unchanged
// on 2026-08-24 for the ungrounded-slot-claim case, which — unlike the
// original invented-owner-fact case — also fires on the email leg, where the
// reply goes DIRECTLY to the owner. "him" has no antecedent there and reads
// as broken. `isOwnerAudience` (true when `ctx.transport === 'email'`, set by
// every call site in runOutputGates.ts) picks the second-person wording
// instead of silently shipping a third-person line to its own subject.
function genericHonestHedge(draft: string, isOwnerAudience?: boolean): string {
  const lang = detectMessageLanguage(draft);
  if (isOwnerAudience) {
    if (lang === 'Hebrew') return 'רגע — לגבי הפרט הספציפי הזה אני לא לגמרי בטוחה, כדאי שתוודא בעצמך.';
    if (lang === 'Russian') return 'Секунду — в этом конкретном моменте я не совсем уверена, лучше уточнить это самостоятельно.';
    if (lang === 'Arabic') return 'لحظة — لست متأكدة تمامًا من هذه النقطة بالذات، من الأفضل التأكد من ذلك بنفسك.';
    return "Actually, I'm not totally sure about that specific point — best to double check it yourself.";
  }
  if (lang === 'Hebrew') return 'רגע — לגבי הפרט הספציפי הזה אני לא לגמרי בטוחה, כדאי לוודא ישירות מולו.';
  if (lang === 'Russian') return 'Секунду — в этом конкретном моменте я не совсем уверена, лучше уточнить напрямую у него.';
  if (lang === 'Arabic') return 'لحظة — لست متأكدة تمامًا من هذه النقطة بالذات، من الأفضل التأكد منه مباشرة.';
  return "Actually, I'm not totally sure about that specific point — best to confirm it with him directly.";
}

export interface ClaimCheckInput {
  reply: string;
  toolSummaries: string[];    // compact [tool_name: arg] strings from this turn
  bookingOccurred: boolean;    // deterministic: create_meeting succeeded
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
  /**
   * v4.4.x (#154) — deterministic ground truth for an approval-granted claim
   * on a room surface. Owner ruling: she announces nothing while a rule-bend
   * escalation waits in the private approval thread, so the only fabricable
   * claim on that path is a room reply asserting the decision already came
   * back. Present ONLY when the caller (runOutputGates.ts) found a request
   * row tied to THIS thread (getLatestRequestForThread) — the cheap,
   * deterministic pre-filter that keeps this from costing anything on the
   * vast majority of colleague turns that never carried an escalation.
   * `isResolved` is `anyRequestResolvedForThread(...)` (o#224) — TRUE when
   * ANY request row in this thread was ever resolved, not just the newest
   * one. A thread can carry 2+ requests, and gating on the latest row's
   * state alone inverted a TRUE "he approved it" about an OLDER, resolved
   * row into a false claim whenever a newer, unrelated request was still
   * pending — corrupting a correct reply (G5). 'resolved' is the ONLY
   * state an owner APPROVE produces (a reject sets 'cancelled', never
   * 'resolved'; see core/requests/resolver.ts), so it is a reliable
   * "granted somewhere in this thread" signal. Absent/undefined → the new
   * instruction block below is skipped entirely and behavior is
   * byte-identical to before this field existed.
   *
   * The caller (runOutputGates.ts) builds this context whenever a request row
   * has EVER existed for the thread AND EITHER a request is genuinely
   * `awaiting_owner` right now OR no request in the thread was ever resolved
   * (gh#154-R7, 2026-08-06) — so a thread whose only requests ever went
   * `cancelled`/`expired` (never resolved) still gets a context object, and
   * keeps paying for as long as it stays active, because a "he approved it"
   * claim there is a GENUINE standing risk, not a cost-free non-event
   * (measured: req_1783847332015_bgs91, cancelled 2026-07-13, colleague still
   * active in the thread on 2026-07-30). A RESOLVED thread is the one that
   * stops costing anything the moment nothing new is pending.
   */
  approvalGrantContext?: {
    isResolved: boolean;
  };
  // v2.3.2 (2B) — second mode. Default 'action' = existing behavior (false
  // action claims). 'coda' = check a generated social coda for invented facts
  // or gossipy commentary about a third party. Same JSON shape; caller checks
  // claimed_action and drops the coda when true.
  // owner-personal-fact-fabricated-in-colleague-reply (2026-08-14) — THIRD
  // mode. 'owner_fact' = check an ordinary colleague-facing task reply for an
  // invented PERSONAL/CAPABILITY claim about the owner himself (the mirror
  // image of 'coda' mode, which checks facts about the recipient). Same JSON
  // shape and `action_type: 'invented_fact'`, so callers don't branch.
  // proposed-slot-not-grounded-in-search-result (2026-08-24) — FOURTH mode.
  // 'slot_grounding' = check whether a SPECIFIC date/time the draft offers as
  // available/clean/workable actually appears in THIS TURN's real
  // find_available_slots / check_join_availability result. RULE A's own
  // "proposing a future time is never a claimed action, however specific"
  // exemption (see the NOT-a-false-claim list on the default prompt below) is
  // correct for what it guards — an EA offering a time is not claiming a
  // completed action — but it also means nothing ever checked that the
  // specific instant offered was actually IN the search result rather than
  // invented outright (the confirmed incident: a real find_available_slots
  // call returned an evening window, the drafted reply named a fabricated
  // early-afternoon time and a fabricated colleague conflict, 8 seconds
  // later). Deliberately its own mode, not a clause added to RULE A's prompt:
  // RULE A's scoping (ownerIsActing / approvalGrantContext, this file's
  // top-of-file doc comment) is a considered choice for the PHANTOM-ACTION
  // class; this is a different class (a false AVAILABILITY fact) that must run
  // on every colleague-readable turn regardless of who is acting — the same
  // reasoning 'owner_fact' mode already established for its own class. Same
  // JSON shape and `action_type: 'ungrounded_slot_claim'`, so callers don't
  // branch.
  mode?: 'action' | 'coda' | 'owner_fact' | 'slot_grounding';
  coda?: {
    recipientName: string;
    /** Compact text snapshot of what we actually know about the recipient
     *  from people_memory (notes, topics, state, timezone, etc.). The check
     *  treats anything stated in the coda but not present here as an
     *  invented fact. */
    recipientFactsSnapshot: string;
    /**
     * coda-grounding-not-shown-to-validator (2026-08-16) — the two
     * `CodaGrounding` fields `composeSocialCoda` (generateCoda.ts) already
     * computes and hands to the WRITER (`groundCoda`'s `searchSnippet` /
     * `pastChatSnippet`) but never passed to this VALIDATOR. Both are
     * optional and frequently absent (a coda can ground on one source, the
     * other, or neither) — absence must read as "no such evidence", never as
     * "evidence that disproves". Kept OUT of `recipientFactsSnapshot` on
     * purpose: that field's own doc comment scopes it to people_memory data
     * and the prompt below headers it "(from our memory)" — stuffing a live
     * web-search result or a past-chat quote in there would make that label
     * false by construction.
     */
    groundingSearchSnippet?: string | null;
    /** See `groundingSearchSnippet` above — the recipient's OWN past-message
     *  excerpt half of the same grounding pair. A fact from the recipient's
     *  own prior words is a fact about their own life sourced from them, not
     *  an invented one, even though it is not in `recipientFactsSnapshot`. */
    groundingPastChatSnippet?: string | null;
  };
  /**
   * owner-personal-fact-fabricated-in-colleague-reply (2026-08-14, bouncer
   * retry) — ground truth for 'owner_fact' mode, the missing analogue of
   * coda mode's `recipientFactsSnapshot` above. Without this, "he can take a
   * call from the car" reads as equally suspicious whether Maelle invented
   * it or the owner said exactly that three turns earlier in the same
   * visible thread — RULE A's own prompt already carries an explicit
   * carve-out for "referencing what the assistant did in PRIOR turns, not
   * this turn"; 'owner_fact' mode had no equivalent until now. The caller
   * (runOutputGates.ts) builds this from the SAME `ctx.history` array the
   * orchestrator handed Maelle when she drafted this reply — not a fresh
   * read, not a separate DB query, so this costs nothing extra to obtain.
   * Absent/undefined → the HISTORY block is simply omitted from the prompt;
   * the check still runs on tool activity alone, same as before this field
   * existed.
   *
   * bounce-fix (2026-08-26, adversarial re-verify of slot_grounding) —
   * SECOND consumer, 'slot_grounding' mode. That mode's ground truth
   * (`slotGroundingContext.groundedToolLines`) is THIS TURN's search result
   * only, so a time confirmed by a real search in an EARLIER turn of the
   * same thread (colleague asks about a second day while a first offer
   * still stands) had nothing to ground it and was flagged/rewritten as
   * fabricated — corrupting a genuinely-confirmed time (G5). Same field,
   * same builder (runOutputGates.ts's `buildRecentHistorySnippet`), no new
   * shape needed (G1/G9 — one canonical history snippet, not a
   * mode-specific copy).
   */
  recentHistorySnippet?: string;
  /**
   * proposed-slot-not-grounded-in-search-result (2026-08-24) — ground truth
   * for 'slot_grounding' mode. The caller (runOutputGates.ts) builds this ONLY
   * when `find_available_slots` or `check_join_availability` actually ran
   * THIS turn — the deterministic structural pre-filter (G10) that keeps this
   * mode from costing anything on the vast majority of turns that never
   * search availability at all. `groundedToolLines` is the EXACT compact
   * tool-summary line(s) for those calls — read verbatim off
   * `result.toolSummaries`, never re-derived or re-parsed here — so the model
   * sees the SAME real dates/times Sonnet herself saw this turn (G2: carry
   * the truth, don't guess it). Undefined/absent → 'slot_grounding' mode is
   * never invoked at all (the caller skips the whole check), so every
   * pre-existing call site to this file stays byte-identical.
   */
  slotGroundingContext?: {
    groundedToolLines: string[];
  };
}

export type ClaimActionType = 'message' | 'book' | 'task' | 'deliver_file' | 'permission_granted' | 'other' | 'invented_fact' | 'gossipy' | 'ungrounded_slot_claim' | null;

export interface ClaimCheckResult {
  claimed_action: boolean;
  action_type?: ClaimActionType;
  target_name?: string | null;
  target_slack_id?: string | null;   // never reliably populated by the LLM; kept for future
  action_summary?: string | null;
  /**
   * v2.6.1 — distinguishes "did the action happen at all" overclaims (false →
   * the safety-net shield in runOutputGates.ts (the matchingToolAlreadyRan
   * check) can correctly suppress when a matching tool ran) from "the SPECIFIC
   * change claimed wasn't actually
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
  // owner-personal-fact-fabricated-in-colleague-reply (2026-08-14) — same
  // reasoning as coda mode: this is only ever invoked on colleague-readable
  // turns (a much narrower call site than every action-mode reply — see
  // runOutputGates.ts's runOwnerFactCheckAndMaybeRewrite), so once called it
  // always runs. A length floor here would reopen the exact gap this closes:
  // "he's fine with weekends" is a full, confident, fabricated claim well
  // under any reasonable floor.
  if (input.mode === 'owner_fact') return true;
  // proposed-slot-not-grounded-in-search-result (2026-08-24) — same reasoning:
  // the caller only ever constructs `slotGroundingContext` when the
  // structural pre-filter (an availability tool ran THIS turn) already held,
  // so once this mode is invoked at all it always runs. No length floor here
  // either — "15:45 or 16:15" is a short, specific, fully-formed false claim.
  if (input.mode === 'slot_grounding') return true;
  // v4.4.x (#154) / o#227, tightened gh#154-R6, widened gh#154-R7 (2026-08-06), floor
  // hole closed gh#154-R8 (2026-08-06) — approvalGrantContext is only ever
  // CONSTRUCTED by the caller (runOutputGates.ts) when a request row has
  // EVER existed for this thread AND (some request is genuinely
  // `awaiting_owner` right now OR no request in the thread was ever
  // resolved). A thread that never carried a request never gets a context
  // object at all, so it never reaches this function with one; a thread
  // whose request(s) resolved stops getting one too, the moment nothing new
  // is pending — that pair is what stops the paid-forever case (36 of 47
  // request-carrying threads build no context and pay nothing). Gating the
  // floor-skip on `hasLivePending` alone (gh#154-R7) missed the OTHER population the
  // caller already narrowed down to: the terminal-never-resolved threads
  // (10 of 47, measured 2026-08-06) get a context object too (`!isResolved`),
  // but hasLivePending reads false for them BY CONSTRUCTION, so the 30-char
  // floor below still applied and dropped exactly the short claim this
  // exists to catch — the exemplar "all good, we can continue" is 25 chars.
  // Keying on PRESENCE instead of the hasLivePending field closes that hole
  // without widening the paid population at all: the caller's own gate is
  // already the expensive filter (11 of 47 threads ever get a context
  // object), this just stops re-applying an English-phrase-shaped length
  // floor on top of it for that already-narrow set.
  if (input.approvalGrantContext) return true;
  // bookingOccurred is NOT a blanket skip (v3.8.x): a booking success proves only
  // the BOOKING claim, but the same reply can ALSO carry a phantom send ("Booked
  // Tue 2pm and pinged Yael" with only create_meeting) that must still be checked.
  // The booking claim stays cheaply verified by the tape ([create_meeting OK] / a
  // resolve-replay) + the booking hint in the prompt below — so we RUN, not skip.
  // A short reply still carries a phantom-send claim — "Sent it to Yael ✅"
  // (18 chars) / Hebrew "שלחתי ליעל" (~10). The 60-char floor predated the
  // cheap tool-less own-the-miss rewrite and skipped exactly the class the
  // guard exists for. 30 keeps trivial acks ("Done.", "👍") out.
  if (input.reply.length < 30) return false;
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

  // v3.8.x — when a booking succeeded this turn its booking claim is already
  // verified deterministically; tell the checker so it doesn't re-question the
  // booking and instead scrutinizes any OTHER action claim in the same reply.
  const bookingNote = input.bookingOccurred
    ? '\nNOTE: a booking succeeded this turn — its booking/calendar claim is already verified; do NOT flag the booking itself. Scrutinize any OTHER action claim in the reply (a Slack send/ping, a file/image delivery) against TOOL ACTIVITY.'
    : '';

  // v1.7.5 — MPIM context block. When the reply was drafted inside an MPIM
  // group chat, list the participants so the checker can recognize that
  // inline `<@USER>` mentions of those participants are legitimate addressing
  // (greeting them in the room) and NOT phantom message sends.
  const mpimBlock = input.mpimContext?.isMpim
    ? `\nMPIM CONTEXT (the reply was drafted in a Slack group thread):\n  Participants in this group thread: ${input.mpimContext.participantSlackIds.length > 0
        ? input.mpimContext.participantSlackIds.map(id => `<@${id}>`).join(', ')
        : '(none listed)'}\n  Inline mentions of these participants in the reply are LEGITIMATE addressing (greeting/directing them in the shared room). Do NOT treat them as phantom sends.\n`
    : '';

  // v4.4.x (#154) — approval-status ground truth. Only present when the
  // caller found a request row tied to THIS thread.
  const approvalBlock = input.approvalGrantContext
    ? `\nAPPROVAL STATUS FOR THIS THREAD (ground truth — this thread has a tracked owner decision request): ${input.approvalGrantContext.isResolved
        ? 'RESOLVED — the owner has decided and the request is granted.'
        : 'NOT RESOLVED — no owner decision has come back for this thread yet.'}\n`
    : '';

  // v2.3.2 (2B) — coda mode prompt. Same JSON shape as action mode (so
  // callers don't branch on the result type), different judgment criteria.
  // Detects (a) facts stated about the recipient that aren't in our snapshot,
  // (b) commentary about a third party named in the coda. Either → drop coda.
  const codaGroundingBlock = input.coda && (input.coda.groundingSearchSnippet || input.coda.groundingPastChatSnippet)
    ? `\nOTHER VALID EVIDENCE (not stored memory, but equally valid grounding — a claim backed by EITHER block above or below is NOT invented):\n${input.coda.groundingSearchSnippet ? `- LIVE SEARCH RESULT (subject-matter grounding, e.g. a news story or fact the recipient raised):\n  ${input.coda.groundingSearchSnippet}\n` : ''}${input.coda.groundingPastChatSnippet ? `- ${input.coda.recipientName}'S OWN PAST MESSAGE (something they themselves said earlier — a fact about their own life sourced from their own words):\n  ${input.coda.groundingPastChatSnippet}\n` : ''}`
    : '';

  const codaPrompt = input.mode === 'coda' && input.coda
    ? `OUTPUT FORMAT: a single JSON object, nothing else. No prose preamble, no markdown fences, no explanation. Start your response with { and end with }.

You audit a generated SOCIAL CODA — a one-line human aside the assistant ${input.ownerFirstName}'s assistant just composed to append to a task reply. Your job: catch invented facts and gossipy third-party commentary before the coda gets sent.

RECIPIENT: ${input.coda.recipientName}

WHAT WE ACTUALLY KNOW ABOUT ${input.coda.recipientName} (from our memory):
${input.coda.recipientFactsSnapshot}
${codaGroundingBlock}
DRAFT CODA:
"""
${input.reply}
"""

Two failure modes — flag if EITHER is present:

(1) INVENTED FACT — the coda asserts something specific about ${input.coda.recipientName}'s OWN life (their activities, plans, relationships, work, family) that is NOT in the memory snapshot above AND NOT in the other valid evidence above (when present). Examples:
- "How's the marathon training going?" when training isn't in their memory or the other evidence
- "Kind of wild that she shares my name" when no such overlap is in memory (and isn't a real overlap a sane reader would see)
- "Excited for your trip to Boston" when no Boston trip is in memory or the other evidence
- "Hope the kitchen reno wraps up soon" when no kitchen reno is in memory or the other evidence
A claim matching the OTHER VALID EVIDENCE block (a live search result, or something ${input.coda.recipientName} said themselves in a past message) is GROUNDED, not invented — even though it is absent from the memory snapshot. Generic open questions ("anything fun outside work lately?", "how was the weekend?", "any travel coming up?") are NOT invented facts — they don't claim anything, they ask. Don't flag those.

CRITICAL — subject-matter facts are NOT invented facts. This rule is ONLY about fabricated facts concerning ${input.coda.recipientName}'s personal life. It is NOT about whatever TOPIC the conversation is about. When ${input.coda.recipientName} is discussing a movie, book, show, company, product, news story, or any external subject, facts about THAT subject — a film's genre, an actor's role, a company's funding, a product's spec — are the subject matter (the assistant's general knowledge or this turn's web_search/web_research), NOT claims about ${input.coda.recipientName}. NEVER flag those. Example that must PASS: helping identify a film — "if it's a rape-revenge film, does he play the father?" asserts things about the MOVIE, not about ${input.coda.recipientName} — claimed_action=false. Only flag a claim that asserts something about ${input.coda.recipientName}'s own life that we have no basis for.

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

  // owner-personal-fact-fabricated-in-colleague-reply (2026-08-14) — THIRD
  // mode. Same JSON shape and `invented_fact` action_type coda mode already
  // established (so downstream handling in runOutputGates.ts doesn't need to
  // branch), but checks the OPPOSITE direction: not "did the coda invent
  // something about the RECIPIENT", but "does an ordinary task reply
  // confidently state, as settled fact, an unverified personal/capability
  // claim about ${ownerFirstName} HIMSELF, to someone who isn't him". Proven
  // incident (2026-08-10): "a phone call from the car works for Idan" shipped
  // to a colleague on a turn with zero tool calls and zero grounding anywhere
  // (people_memory / config / KB / preferences all checked) — true by luck,
  // not by evidence. Deliberately its own mode rather than a clause inside
  // RULE A's prompt below: RULE A's own ownerIsActing/approvalGrantContext
  // scoping (this file's top-of-file doc comment) is a considered design
  // choice, not a gap to widen as a side effect of this fix.
  //
  // Bouncer retry (2026-08-14) — the missing ground truth. Only present when
  // the caller passed `recentHistorySnippet` (see that field's doc comment
  // on ClaimCheckInput above).
  const ownerFactHistoryBlock = input.recentHistorySnippet
    ? `CONVERSATION HISTORY (the SAME thread history the assistant had access to when drafting this reply — a fact ${input.ownerFirstName} stated about himself earlier here, or one the assistant already stated consistently earlier, is GROUNDED, not invented):\n${input.recentHistorySnippet}\n`
    : '';

  const ownerFactPrompt = input.mode === 'owner_fact'
    ? `OUTPUT FORMAT: a single JSON object, nothing else. No prose preamble, no markdown fences, no explanation. Start your response with { and end with }.

You audit a draft reply an executive assistant is about to send to a COLLEAGUE — someone other than the assistant's principal, ${input.ownerFirstName}. Your one job: catch an INVENTED PERSONAL FACT about ${input.ownerFirstName} himself before it ships.

TOOL ACTIVITY THIS TURN (anything read or confirmed — a matching read here means the claim is GROUNDED, not invented):
${toolBlock}
${ownerFactHistoryBlock}
DRAFT REPLY (to the colleague):
"""
${input.reply}
"""

Flag ONLY when the draft states, as a SETTLED FACT — not a guess, not hedged, not "let me check with him" — a specific PERSONAL capability, habit, preference, or availability characteristic of ${input.ownerFirstName} ("he can take a call from the car", "he's fine working through lunch", "he never minds a late reschedule") that ALL of the following hold:
(a) is NOT backed by anything in TOOL ACTIVITY THIS TURN (a people_memory / preference / calendar read that actually says this), AND
(b) is not merely describing what's already scheduled on the calendar (a meeting's time, place or attendees is not a personal-capability claim), AND
(c) has no origin anywhere in CONVERSATION HISTORY above either — if ${input.ownerFirstName} said this himself earlier in the visible history, or the assistant already stated it consistently earlier in the same thread, it is GROUNDED, not invented, even with no tool call behind it. Only a claim with NO origin anywhere — not tool activity, not history — counts as invented.

A HEDGED statement ("he's usually flexible about that, but let me double-check") is NOT an invented fact — only a bare, confident assertion with nothing behind it counts. Ordinary scheduling logistics, proposals, and questions are NEVER this rule's target — only a specific claim about ${input.ownerFirstName}'s own personal capability, habit or preference, stated as certain.

Output schema (REUSE the action-checker shape so callers don't branch):
{
  "claimed_action": boolean,      // true = an invented personal fact about ${input.ownerFirstName} is present
  "action_type": "invented_fact" | null,
  "target_name": string | null,   // "${input.ownerFirstName}" when claimed_action is true, else null
  "action_summary": string | null // one-line quote/paraphrase of the invented claim, ≤120 chars
}

If the draft is clean (no invented personal fact about ${input.ownerFirstName}), set claimed_action=false and the other fields null.
Reminder: JSON only. Start with { end with }. No prose.`
    : null;

  // proposed-slot-not-grounded-in-search-result (2026-08-24) — FOURTH mode.
  // `groundedToolLines` carries this turn's exact compact tool-summary
  // line(s), verbatim, never re-derived, whenever an availability tool ran
  // this turn. bug 1.1 (2026-08-27) — the caller (runOutputGates.ts:1719)
  // also invokes this mode with an EMPTY `groundedToolLines` on a detected
  // zero-tool-call availability question, so a stale time recalled from
  // earlier in the thread still gets checked; the prompt below is written to
  // handle both cases (an empty list plus the EARLIER-TURNS history block is
  // what it falls back to when THIS turn ran no search at all).
  // bounce-fix (2026-08-26) — an EARLIER turn's own real search can already
  // have confirmed a time this turn's search never repeats (a colleague
  // asking about a second day while a first offer still stands). See
  // `recentHistorySnippet`'s doc comment above.
  const slotGroundingHistoryBlock = input.recentHistorySnippet
    ? `EARLIER TURNS IN THIS THREAD (this assistant may have already offered a specific time, backed by a REAL availability search, in an earlier turn of this same thread — that offer is STILL GROUNDED now even though THIS TURN'S result above does not repeat it; a new question about a different day/time does not retract an earlier confirmed offer still standing in the same reply):\n${input.recentHistorySnippet}\nWhen it is unclear whether this earlier-turns snippet actually confirms a time via a real search (the snippet is ambiguous or you cannot tell), do NOT flag on that basis alone — favor the safe miss.\n`
    : '';

  const slotGroundingPrompt = input.mode === 'slot_grounding' && input.slotGroundingContext
    ? `OUTPUT FORMAT: a single JSON object, nothing else. No prose preamble, no markdown fences, no explanation. Start your response with { and end with }.

You audit a draft reply an executive assistant is about to send. Your one job: catch a SPECIFIC date/time offered as available/clean/workable that was NOT actually confirmed by a real availability search.

THIS TURN'S REAL AVAILABILITY RESULT (find_available_slots / check_join_availability — times/verdicts confirmed THIS turn):
${input.slotGroundingContext.groundedToolLines.map(l => `  ${l}`).join('\n')}
${slotGroundingHistoryBlock}
DRAFT REPLY:
"""
${input.reply}
"""

Flag when EITHER holds:
(a) the draft states a SPECIFIC clock time on a SPECIFIC date as available, free, clean, open, workable, or bookable for the people involved, AND that exact date+time does not appear, marked available/confirmed, anywhere — not in THIS TURN'S REAL AVAILABILITY RESULT above, and not as an already-confirmed earlier offer in EARLIER TURNS IN THIS THREAD above when present (not the same instant, not a timezone-converted restatement of one of those confirmed instants); OR
(b) the draft sells as available/workable an exact date+time that DOES appear in THIS TURN'S REAL AVAILABILITY RESULT above but ONLY with a NEGATIVE verdict attached to that same instant (marked unavailable, busy, blocked, \`available: false\`, \`can_join=false\`, or carrying a conflict/broken-rule reason) — merely appearing in the result is not the same as being confirmed available, and offering that instant anyway inverts the search's own verdict.

Judge by MEANING, in any language — a CONFIRMED slot re-expressed in a different clock/timezone, or rounded/truncated the same way the draft rounds every other number, is still grounded.

Do NOT flag:
- A vague, non-specific offer with no clock time ("let me look for time next week", "I'll check some options") — nothing to verify.
- A time correctly reported BY THE DRAFT as UNAVAILABLE, busy, blocked, or a conflict — that is the opposite of this rule's target.
- A time that DOES match (or is a timezone-equivalent restatement of) one of the real times listed above WITH AN AVAILABLE/CONFIRMED verdict (a plain find_available_slots slot list with no verdict attached lists only confirmed-available slots by construction).
- A time matching an offer this assistant already made and a real search already confirmed in an EARLIER TURN of this same thread (see EARLIER TURNS IN THIS THREAD above, when present).
- A time describing an EXISTING meeting already on the calendar, not a newly offered slot.
- Zero slots listed above ("0 slots") with the draft honestly saying nothing was found, or asking a clarifying question — only flag when it nonetheless states a SPECIFIC time as available despite the empty/negative result.

Output schema (REUSE the action-checker shape so callers don't branch):
{
  "claimed_action": boolean,       // true = the draft offers a specific time as available that this turn's real result does not confirm
  "action_type": "ungrounded_slot_claim" | null,
  "target_name": null,
  "action_summary": string | null  // the fabricated date/time, quoted/paraphrased from the draft, ≤120 chars
}

If every specific time the draft offers as available is backed by THIS TURN'S REAL AVAILABILITY RESULT (or the draft offers no specific time at all), set claimed_action=false and the other fields null.
Reminder: JSON only. Start with { end with }. No prose.`
    : null;

  const prompt = codaPrompt ?? ownerFactPrompt ?? slotGroundingPrompt ?? `OUTPUT FORMAT: a single JSON object, nothing else. No prose preamble, no markdown fences, no explanation. Start your response with { and end with }.

You audit draft replies from an executive assistant for honesty violations before they get sent. The assistant's principal is ${input.ownerFirstName}.

TOOL ACTIVITY THIS TURN:
${toolBlock}
${mpimBlock}${bookingNote}${approvalBlock}
DRAFT REPLY:
"""
${input.reply}
"""

You check ONE rule: FALSE ACTION CLAIM (sets claimed_action).

Does the draft state or imply the assistant JUST did an external action (sent / pinged / messaged / told someone, booked / scheduled / moved a meeting, created a task / reminder / note) — AND that action is NOT backed by a matching tool call in the activity list above?

RULE A is about those EXTERNAL actions ONLY. A statement that the assistant CHECKED / looked at / confirmed / verified / reviewed a CALENDAR, an INBOX, or a DOCUMENT (an object, not a person or a booking) is INFORMATIONAL, not one of the four action classes above — it is NEVER a false claim under this rule, no matter which turn the checking happened in or whether a tool ran for it THIS turn. "As I confirmed earlier, you're free Thursday" / "checked — no conflicts" / "already looked into it" are honest by definition; do not flag them. This exemption is OBJECT-SCOPED and CANONICAL for the whole prompt: it does NOT cover "confirmed with <person>", "confirmed the booking", or "confirmed the meeting" — those claim an external action (telling someone, locking in a booking) happened, and are judged as ordinary RULE A action claims, honest only when a matching tool call (message_colleague / create_meeting / update_meeting / etc) appears in TOOL ACTIVITY THIS TURN.

Paraphrase, tense, and language don't matter. Judge by meaning. Hebrew, English, anything.

CRITICAL — tool-aware honesty:
If TOOL ACTIVITY shows the matching tool already ran this turn — e.g. \`[message_colleague: <name>]\` for a "sent X" claim about that name, \`[create_meeting: ...]\` for a booking claim, \`[create_approval: ...]\` or \`[create_task: ...]\` for a "flagged it" claim — the claim is HONEST regardless of the verb tense or phrasing used. "On its way", "sending now", "I've reached out", "sent", "the message is going out", "on it — I'll send now" are ALL valid when the matching tool ran. Do NOT flag these.

The whole point of these tools is to queue an action; the model is allowed to narrate the queued action as if it's happening. ONLY flag when the claim is about an action whose matching tool did NOT run this turn.

CRITICAL — approval/permission-granted claim on a room thread (v4.4.x):
The draft can assert that ${input.ownerFirstName} granted a permission, approved a rule-bend, or that something previously blocked is now clear to proceed — "all good, we can continue", "he said yes, let's go ahead", "that's approved now", "we're clear", in ANY language, tense, or phrasing. ${input.ownerFirstName} never announces this kind of escalation mid-wait, so a room reply never truthfully asserts a grant while a decision is still pending.
- If APPROVAL STATUS FOR THIS THREAD above says RESOLVED, such a claim is HONEST — do NOT flag.
- If APPROVAL STATUS FOR THIS THREAD above says NOT RESOLVED, a declarative claim that the grant already came back is FALSE — flag claimed_action=true, action_type="permission_granted".
- When the APPROVAL STATUS block is absent entirely, this rule does not apply — judge the draft under the other rules only.
- An in-progress line ("still checking with him", "let me get back to you on that", "waiting to hear back") is NEVER a false claim under this rule — only a DECLARATIVE assertion that the decision already came back counts.

CRITICAL — resolve_approval relays to the requester ITSELF:
When the owner resolves a colleague-initiated approval (verdict approve / amend / reject), \`resolve_approval\` ALSO DMs the original requester the decision — an internal relay sent by the system, NOT a \`message_colleague\` call. So a draft saying "the requester will get the details" / "I'll let <name> know" / "they can confirm from there" / "<name> will get the adjusted details" is HONEST when \`[resolve_approval: ...]\` appears in TOOL ACTIVITY this turn. The matching mechanism for "told the requester" after an approval decision is \`resolve_approval\`, not \`message_colleague\`. Do NOT flag these as a phantom message — forcing a message_colleague would DOUBLE-DM the requester (one from the resolver, one from the send).

CRITICAL — resolve_approval is honest ONLY when it REPLAYED the matching mutation:
When the owner approves an approval that carries a stored action, \`resolve_approval\` REPLAYS it (create_meeting / move_meeting / update_meeting / book_floating_block) — the calendar changes with NO separate mutation call in TOOL ACTIVITY. Its summary tells you which happened:
- \`[resolve_approval OK — replayed the approved action: <what happened>]\` → a mutation DID replay; a matching "booked / scheduled / locked in / moved / ADDED <someone> / cancelled <X> / done" claim is HONEST (do NOT flag).
- \`[resolve_approval OK — decision recorded, NO calendar change]\` → a freeform / callback-less approve that applied NOTHING to the calendar. A completed-mutation claim here is FALSE: approving "please add Isaac and Chris" RECORDS the decision, it does not itself add them, so "Done, Isaac and Chris have been added" is a phantom action — flag claimed_action=true.
Judge by the replay OUTCOME in the summary, NEVER by the mere presence of \`[resolve_approval …]\`. Any OTHER resolve summary (reject / amend / expired) carries no "done" backing — judge those normally, don't manufacture a flag.

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

CRITICAL — file / image delivery:
A draft can claim it just DELIVERED a file or image TO THE READER in this very message — "here's the image", "here it is, attached", "with the image attached", "see attached", "sharing the file", "attached is the deck". ${input.ownerFirstName}'s assistant replies in plain text: a reply carries an attachment ONLY when a file/image-send tool actually ran this turn (an upload / send-file / attach tool with an OK outcome in TOOL ACTIVITY). So a "delivered it here" claim is HONEST only when such a send appears in the activity; with NO file/image send in the activity the attachment does NOT exist — flag claimed_action=true (action_type "deliver_file"). Judge by whether an upload HAPPENED, not by the wording — this holds in any language.
NOT a delivery claim (do NOT flag): describing that a THIRD PARTY attached or sent a file ("Oran attached an image to his note", "the deck he sent over"), OFFERING to send one ("want me to forward the image?"), or pointing to a link / where to find it. Only a claim that the file is attached HERE, now, for the reader — with no matching send this turn — is false.

CRITICAL — specifics mismatch vs occurrence mismatch (v2.6.1, refined v2.6.5):
Calendar mutation tools each cover DIFFERENT fields:
- \`create_meeting\` — creates a new event with subject / time / duration / attendees.
- \`move_meeting\` — changes START AND END time (caller passes new_start AND new_end as required args). Subject, location, attendees stay the same. Whether the duration changes depends on the caller's args; describing the new time window (e.g. "12:30–12:55") is NOT a specifics mismatch — that's just narrating the move's outcome.
- \`update_meeting\` — changes any field (subject, duration, location, attendees, body) WITHOUT changing the start time.
- \`delete_meeting\` — cancels the event.
- \`book_floating_block\` — books a lunch / coffee / focus block.

If the draft claims a SPECIFIC change that the tool that ran does NOT cover — e.g. "renamed it to X" or "added Yael to the invite" when only \`move_meeting\` ran (which doesn't touch subject or attendees), or "moved to a different room" when only \`update_meeting\` ran without a location change — flag claimed_action=true AND set claim_specifics_mismatch=true. The action partially happened, but the specific field claimed didn't.

Set claim_specifics_mismatch=false when the overclaim is about whether the action happened AT ALL (e.g. "I sent X" but no \`message_colleague\` ran; "I booked it" but no booking tool ran). The default for honest drafts (claimed_action=false) is also false.

NOT a false claim:
- A CHECKED / confirmed / verified / reviewed / looked-into statement about the calendar, an inbox, or a document — see the object-scoped exemption (and its exclusions) stated under RULE A above; never flag these here.
- Any send/book/task claim where the matching tool appears in TOOL ACTIVITY THIS TURN above.
- Describing what's ALREADY on the calendar ("Elan's triweekly is at 13:00").
- Proposing / offering / recommending a future action — EVEN when it names a specific meeting, time, or person. "Best fit: Wednesday 13:00 — want me to move the interview there?", "I can book that", "Want me to reach out?", "Shall I move it?" are PROPOSALS awaiting the owner's yes, NOT completed actions. A draft that recommends or asks-before-acting is claimed_action=false no matter how specific it is. COMPOUND CASE (important): a reply can report a COMPLETED action AND, in the same breath, OFFER a follow-up — "Moved it to 13:45. As expected, Oran, Onn and Daniel are all busy then. Want me to let them know about the change?" The trailing interrogative offer to notify ("want me to let them know / tell them / notify them?") is a PROPOSAL on the follow-up, NOT a completed send — even when the reply names those people and reports a real action. Key on the interrogative/offer FORM, not the names or topic. A notify claim is a false send ONLY when it is DECLARATIVE-past ("I've let them know", "told them") with no matching message_colleague this turn. Only flag when the draft states the action ALREADY happened ("moved", "booked", "done", "sent", "scheduled it"). When the turn was a reply to an attachment/screenshot, the draft is analysis + a proposal off that image — don't treat its specifics as a phantom action.
- Referencing what the assistant did in PRIOR turns (history, not this turn).
- Saying "on it" / "I'll handle that" — these are in-progress commitments, not completed claims.
- Describing that a THIRD PARTY attached/sent a file, or OFFERING to send/forward one — that is not a claim the assistant delivered it here (see "file / image delivery" above).

IS a false claim:
- "I've sent a message to X" when NO message_colleague targeting X is in TOOL ACTIVITY THIS TURN.
- "Done — booked" / "on the calendar" when no create_meeting is in TOOL ACTIVITY THIS TURN.
- "I've flagged this with him" when no create_approval / create_task is in TOOL ACTIVITY THIS TURN.
- The reply contains a \`<@USERID>\` Slack ping intended to notify someone OUTSIDE the current room, but no message_colleague targeting them is in TOOL ACTIVITY THIS TURN. (For people NOT in the room, inline pings are not how to message them — message_colleague is.)
- IMPORTANT MPIM EXCEPTION: if MPIM CONTEXT is present above and the \`<@USERID>\` mention is for a PARTICIPANT in the listed group thread, that's LEGITIMATE in-room addressing — NOT a phantom send. Do not flag it. Only flag pings to people NOT in the participant list.
- A claim that a file/image is attached HERE / delivered to the reader in THIS message ("here's the image", "see attached", "with the image attached") when NO file/image-send tool ran this turn — the text reply carries no attachment unless a send tool fired (see "file / image delivery" above).
- A declarative claim that ${input.ownerFirstName} granted a permission / approved a rule-bend / cleared something previously blocked ("all good, we can continue", "he said yes") when APPROVAL STATUS FOR THIS THREAD above says NOT RESOLVED — see the approval/permission-granted CRITICAL section above.

═════════════════════════════════════════════════════════════════════════════
OUTPUT SCHEMA
═════════════════════════════════════════════════════════════════════════════

{
  "claimed_action": boolean,
  "action_type": "message" | "book" | "task" | "deliver_file" | "permission_granted" | "other" | null,
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
      // threadBoundApprovalAutoResolve). Post-B the checker's default 'action'
      // mode has ONE job (RULE A: action claim vs tool history) — pattern
      // matching against a structured list, exactly what Haiku is for. The
      // matchingToolAlreadyRan shield in runOutputGates.ts already absorbs
      // false-positives from whichever model runs here, so the safety net
      // is unchanged. Coda mode also runs on Haiku — owner direction
      // 2026-05-26 "ship it and move all to haiku also the coda" — and so
      // does 'owner_fact' mode (2026-08-14): same reasoning, a narrow
      // pattern-match against tool activity, not open-ended reasoning.
      model: MODEL_HAIKU,
      // 5 fields in the schema; action_summary is the only long field (≤120 chars).
      // 300 tokens is comfortable headroom — used to be 800 to fit the v2.7.8
      // Module F + E extras that were removed in v3.0.6.
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    logLlmUsage(
      input.mode === 'coda' ? 'claim_checker_coda'
        : input.mode === 'owner_fact' ? 'claim_checker_owner_fact'
        : input.mode === 'slot_grounding' ? 'claim_checker_slot_grounding'
        : 'claim_checker',
      MODEL_HAIKU,
      response,
    );
    const raw = ((response.content[0] as Anthropic.TextBlock).text ?? '').trim();
    const elapsedMs = Date.now() - start;

    // Strip accidental markdown fences — belt-and-braces, the prompt forbids them.
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    // v1.7.5 — tolerant parse: when the model adds prose preamble despite the
    // JSON-only instruction (observed in real-world QA — same root as the
    // calendar candidate selection bug fixed in v1.7.3), extract the first
    // {...} block by regex before JSON.parse. Without this, the checker
    // fail-opens and any phantom-action claim ships unedited.
    // Take the first balanced { … } object — handles a prose prefix AND
    // trailing content after the JSON (the "Unexpected non-whitespace after
    // JSON" crash class). Falls through to the raw string if no object found.
    const extracted = extractFirstJsonObject(cleaned);
    if (extracted) cleaned = extracted;
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

/**
 * v3.4 — own-the-miss rewrite. REPLACES the old claim-checker remedy of
 * re-invoking the orchestrator (which re-ran the tool loop and could re-fire
 * a write → the Amazia duplicate-send) and the force-message_colleague path
 * (which auto-sent on a possibly-wrong verdict).
 *
 * When the checker confirms the draft claims an action that no tool backed
 * this turn, this rewrite re-renders the prose so it HONESTLY surfaces that the
 * action has NOT happened — owning the slip plainly so the owner knows to nudge,
 * never smoothed into "I'll handle it".
 *
 * v3.4.x — VETO + Sonnet (GH #124/#125): the rewriter no longer blindly trusts
 * the upstream verdict. It FIRST judges the draft itself and keeps it unchanged
 * when the draft only proposes/offers/asks/future-commits (the classifier's
 * common misfire). Runs on Sonnet — the keep-vs-rewrite call is exactly what
 * Haiku gets wrong — and only on flags (a few/day), so cost is trivial.
 *
 * v3.4.x — STRUCTURED OUTPUT (GH 2026-06-17 leak): the decision comes back as a
 * forced `verdict` tool call ({verdict, message}), NOT free text. We read only
 * those fields, so the model's reasoning can NEVER ship as the reply — the bug
 * where Sonnet "thought out loud" and its monologue (ending in "UNCHANGED")
 * went straight to the owner because the old exact-token veto didn't match it.
 *
 * Tool-less (no write tools) ⇒ it can never duplicate an action. Fails open to
 * the ORIGINAL draft only while the false-claim verdict itself is still in
 * question — verdict="keep" (STEP 1) or a thrown/errored call, both BEFORE any
 * independent confirmation that the draft is false, so "keep original" really
 * is the safe miss there.
 *
 * gh#194-b-confession-overpromises-unexecuted-action (2026-08-10, bouncer
 * overturn) — that is NOT true once verdict="rewrite" (STEP 2) has already
 * been returned: at that point this same call has independently confirmed,
 * against the tool activity, that the draft states a completed action nothing
 * backed — the original is a PROVEN false claim, not a suspected one. The two
 * checks that remain after that point (is `message` usable? did the model
 * self-attest `noPendingActionClaim`?) audit the REWRITE, not the verdict, so
 * their failure must never fall back to "keep original" — that would knowingly
 * ship the lie this whole function exists to stop. Both now return
 * GENERIC_HONEST_MISS instead: a fixed, tool-less, deterministic line that
 * asserts nothing about any action. English-only is an accepted compromise
 * here, same as humanGate's own fallback-of-a-fallback (humanGate.ts:433-439)
 * — this only fires when the checker AND this rewriter's own veto have both
 * already agreed the draft is false and the model's proposed fix is itself
 * untrustworthy, rarer still than either alone.
 *
 * gh#194-b (2026-08-10) — the prose instruction against "I'll take care of
 * it"-style smoothing already existed and a rewrite still shipped a
 * present-progressive version of the same overpromise ("I'm handling it right
 * now" / "אני דואגת לזה עכשיו"). Multilingual phrasing rules out a hardcoded
 * regex strip as the fix, so the SAME call now also forces a `verdict` field
 * `noPendingActionClaim`: the model must self-attest its own `message` makes
 * no claim the action is in progress or about to complete. Anything short of
 * an explicit `true` discards the rewrite — see the note above on why that no
 * longer means "keep the original" once verdict="rewrite" has fired.
 *
 * gh#194-b-promised-resend-never-fired (2026-08-10, owner ruling) — an honest
 * confession alone is still just words: "if she is saying that she will do a
 * follow up or reminder, she needs to do it." This function stays tool-less
 * and side-effect-free itself, but its CALLER (runOutputGates.ts, right after
 * a rewrite ships) now opens a durable backstop for the one proven, narrow
 * shape this can safely guarantee — a colleague's false "I relayed this to
 * him" claim about the owner — by raising a `reminder`-kind request on the
 * same spine registrar's flagUnresolvedFreeformForOwner (src/tasks/skill.ts)
 * uses, so the relay lands via the runner regardless of what the model does
 * next turn. See runOutputGates.ts's call site for the exact scope guards.
 *
 * owner-personal-fact-fabricated-in-colleague-reply (2026-08-14) — reused
 * (G1: reuse, don't add a parallel rewriter with its own fail-safe machinery)
 * for a SECOND, unrelated flag shape: `actionType === 'invented_fact'`, from
 * claimChecker's 'owner_fact' mode. Framing differs — there is no "un-done
 * action" to own, so the STEP 1/STEP 2 prompt and the self-attestation field
 * both branch on `isInventedOwnerFact` below; the remedy is a fact-preserving
 * rewrite that drops or hedges the specific unfounded personal claim about
 * the owner, never a confession ("that didn't go through") that would make no
 * sense for a stated fact. Same tool-less, structured-verdict, fail-open
 * contract throughout.
 *
 * proposed-slot-not-grounded-in-search-result (2026-08-24) — reused again
 * (G1) for a THIRD flag shape: `actionType === 'ungrounded_slot_claim'`, from
 * claimChecker's 'slot_grounding' mode. Same family as `invented_fact` —
 * a false FACT stated as settled, not an un-done action — so it shares that
 * branch's shape: a fact-preserving rewrite, the `minimalRedaction` fallback,
 * and `genericHonestHedge` as the last resort. What differs is the ground
 * truth handed to the model: `groundedToolLines`, this turn's own real
 * find_available_slots / check_join_availability result, so the rewrite is
 * told the ACTUAL times rather than merely told to hedge — the model is
 * substituting from facts we hand it, never inventing a replacement time.
 */
export async function rewriteOwningTheMiss(opts: {
  draft: string;
  actionSummary?: string | null;
  actionType?: ClaimActionType;
  targetName?: string | null;
  ownerFirstName: string;
  // v3.7.x — the tool activity this turn. Without it the rewriter's
  // "the action DID happen → keep" veto was BLIND: it re-judged the draft's
  // SHAPE only and could not confirm a completed-action claim was backed by a
  // tool, so it inverted a TRUE "added meeting@reflectiz.com" into "not done,
  // confirm the address". Hand it the same ground truth the first checker reads.
  toolSummaries?: string[];
  // v4.4.x (#154) added an approvalGrantContext param here for the
  // permission-granted claim class; removed in o#224 when the class went
  // detect-and-log only, then RESTORED in gh#154-R5 (2026-08-06) — but the binding
  // that makes it safe lives at the CALL SITE (runOutputGates.ts), not here:
  // the caller never routes a permission_granted claim into this rewrite
  // unless anyRequestResolvedForThread is false for the thread (no request
  // here was EVER resolved), so a possibly-true grant about an older
  // resolved row never reaches this function at all — no approvalGrantContext
  // param is needed on this side of the call.
  //
  // proposed-slot-not-grounded-in-search-result (2026-08-24) — only for
  // `actionType === 'ungrounded_slot_claim'`: the SAME compact tool-summary
  // line(s) claimChecker's 'slot_grounding' mode already verified against
  // (claimChecker.ts's `slotGroundingContext.groundedToolLines`), carried
  // through verbatim so the rewrite corrects the draft using the real
  // times/verdict rather than a generic hedge with no facts behind it.
  groundedToolLines?: string[];
  // email-leg-hedge-shipped-colleague-third-person-wording (2026-08-28) — true
  // when this reply goes directly to the owner (the email leg), so the
  // scoped fallback's wording can address them in second person instead of
  // the colleague-facing "confirm it with him directly" default.
  isOwnerAudience?: boolean;
}): Promise<string | null> {
  const isInventedOwnerFact = opts.actionType === 'invented_fact';
  const isUngroundedSlotClaim = opts.actionType === 'ungrounded_slot_claim';

  const what = opts.actionSummary
    || (isInventedOwnerFact
      ? `an unverified personal fact about ${opts.ownerFirstName}`
      : isUngroundedSlotClaim
        ? 'a specific time offered as available'
        : opts.actionType === 'message'
          ? `sending a message${opts.targetName ? ` to ${opts.targetName}` : ''}`
          : 'that action');

  const toolBlock = (opts.toolSummaries && opts.toolSummaries.length)
    ? opts.toolSummaries.map(s => `  - ${s}`).join('\n')
    : '  (no tools ran this turn)';

  // proposed-slot-not-grounded-in-search-result (2026-08-24) — same STEP
  // 1/2/3 + minimalRedaction shape as the invented-owner-fact branch, but the
  // ground truth handed to the model is THIS TURN'S REAL slot/verdict list,
  // not "check with the owner" — the corrected time comes from facts we hand
  // it, never from the model's own head.
  const groundedSlotBlock = (opts.groundedToolLines && opts.groundedToolLines.length)
    ? opts.groundedToolLines.map(l => `  ${l}`).join('\n')
    : '  (the search ran and found nothing usable this turn)';

  const slotClaimPrompt = isUngroundedSlotClaim ? `You are reviewing a message an assistant already drafted. An upstream checker flagged the draft as offering a SPECIFIC time as available that this turn's own availability search does not confirm — ${what}. The checker is sometimes WRONG, so verify the flagged claim against the real search result yourself before acting. Report your decision by calling the \`verdict\` tool — do not write any prose outside the tool call.

THIS TURN'S REAL AVAILABILITY RESULT (the ONLY times/verdicts actually confirmed — settled, do not re-judge):
${groundedSlotBlock}
FLAGGED CLAIM: ${what}

STEP 1 — Call verdict="keep" (leave message empty) if the draft does NOT actually offer that flagged time as available, or if it does and the time genuinely matches (or is a timezone-equivalent restatement of) one of the real results above WITH A POSITIVE/AVAILABLE verdict attached. Do NOT call verdict="keep" when the matched result carries a NEGATIVE verdict (unavailable, busy, blocked, \`available: false\`, \`can_join=false\`, or a conflict/broken-rule reason) — merely appearing in the result is not the same as being confirmed available, and that is exactly the case STEP 2 must rewrite, not keep. Do not manufacture a problem that isn't one.

STEP 2 — Call verdict="rewrite" ONLY when the draft genuinely states a specific time as available that the real result above does not back. Put the corrected reply in \`message\`. The rewrite must:
- Replace the fabricated time with the REAL time(s) from the list above, if any exist — never invent a substitute time of your own.
- If the list above found nothing usable, say plainly that no time was actually confirmed yet (never invent one) — an honest "let me get back to you with the real options" is fine.
- Keep every OTHER fact in the message intact: names, other correctly-stated times, numbers, the rest of the answer.
- Sound like a real person, never a disclaimer or a system message.
- Match the language of the draft (Hebrew/English/etc).

STEP 3 — Also fill \`minimalRedaction\` with a SECOND, more conservative candidate: the draft with ONLY the flagged fabricated time deleted or blanked out and NOTHING else touched — no new sentences, no paraphrasing, no added hedge, every other word copied verbatim from the draft. This is the fallback used if \`message\` cannot be trusted; fill it even when you are confident in \`message\`.

SAFE-MISS — the hard rule. If you cannot tell whether the claim is truly ungrounded, do NOT rewrite — verdict="keep". Only rewrite when the draft clearly offers a time the real result above does not confirm.

Draft:
${opts.draft}` : null;

  const prompt = isInventedOwnerFact ? `You are reviewing a message an assistant already drafted for a COLLEAGUE — someone other than ${opts.ownerFirstName}, the assistant's principal. An upstream checker flagged the draft as stating, with unwarranted confidence, an unverified PERSONAL fact about ${opts.ownerFirstName} himself — ${what}. The checker is sometimes WRONG, so verify the flagged claim against the tool activity yourself before acting. Report your decision by calling the \`verdict\` tool — do not write any prose outside the tool call.

TOOL ACTIVITY THIS TURN (anything that could ground the claim):
${toolBlock}
FLAGGED CLAIM: ${what}

STEP 1 — Call verdict="keep" (leave message empty) if the draft does NOT actually assert the flagged claim as a bare, settled fact — e.g. it is already hedged ("usually", "I think", "let me check"), it is a proposal or question, or the claim is plausibly backed by TOOL ACTIVITY above (a people_memory / preference / calendar read). Do not manufacture a problem that isn't one.

STEP 2 — Call verdict="rewrite" ONLY when the draft genuinely states the flagged personal claim about ${opts.ownerFirstName} as settled fact with nothing behind it. Put the corrected reply in \`message\`. The rewrite must:
- Prefer dropping the specific unfounded claim CLEANLY over restating it in a hedge — especially when it is a stray/bonus detail the message didn't need (e.g. a leftover time or fact recalled from earlier in the conversation) rather than the actual thing being asked about. Only fall back to an honest hedge that still names the specific detail / an offer to confirm with ${opts.ownerFirstName} directly ("let me check with him and get back to you") when the flagged claim genuinely IS the thing being asked about and dropping it would leave the question unanswered.
- NOT invent a DIFFERENT unfounded personal claim about ${opts.ownerFirstName} in its place.
- Keep every OTHER fact in the message intact: names, times, dates, numbers, the rest of the answer.
- Sound like a real person, never a disclaimer or a system message.
- Match the language of the draft (Hebrew/English/etc).

STEP 3 — Also fill \`minimalRedaction\` with a SECOND, more conservative candidate: the draft with ONLY the flagged claim deleted or blanked out and NOTHING else touched — no new sentences, no paraphrasing, no added hedge, every other word copied verbatim from the draft. This is the fallback used if \`message\` cannot be trusted; fill it even when you are confident in \`message\`.

SAFE-MISS — the hard rule. If you cannot tell whether the claim is truly ungrounded, do NOT rewrite — verdict="keep". Only rewrite when it is clearly a bare, confident, unsupported personal claim about ${opts.ownerFirstName}.

Draft:
${opts.draft}` : isUngroundedSlotClaim ? slotClaimPrompt! : `You are reviewing a message an assistant already drafted for ${opts.ownerFirstName}. An upstream checker flagged it as possibly claiming a COMPLETED action — ${what} — that no tool actually performed this turn. The checker is sometimes WRONG, so your job is to verify AGAINST THE TOOL ACTIVITY below, not assume. Report your decision by calling the \`verdict\` tool — do not write any prose outside the tool call.

TOOL ACTIVITY THIS TURN (the ground truth — a mutation summary carries its outcome: \`[update_meeting OK — …]\` succeeded, \`[… FAILED: …]\` did not):
${toolBlock}
STEP 1 — Call verdict="keep" (leave message empty) if ANY of these hold:
- The draft only PROPOSES / OFFERS an action ("Want me to move Michal to Wed?", "I can book that", "Should I reach out to her?"), OR
- it reports a completed action AND, in the same reply, OFFERS a follow-up as a QUESTION ("Moved it to 13:45 — Oran, Onn and Daniel are all busy then, want me to let them know?"). A trailing interrogative offer to notify ("want me to tell / notify / let them know?") is a PROPOSAL, never a completed send — EVEN when it names those people. (Only a declarative-past "I've let them know" with no message tool is a false send.), OR
- it ASKS PERMISSION before acting, OR
- it COMMITS to a FUTURE action conditional on ${opts.ownerFirstName}'s answer ("once you pick, I'll move it"), OR
- the stated action IS backed by the TOOL ACTIVITY above — a matching tool ran with an OK outcome. Judge by MEANING, across forms: an attendee named by EMAIL in the draft ("added meeting@example.com") and by DISPLAY NAME in the summary ("added Meeting Room") are the SAME add; a room / resource mailbox counts as an added attendee. OR
- the draft simply does NOT state that something is already done / sent / booked / moved / added / flagged.
Do not turn a proposal into an apology, and do not "own a miss" that isn't one.

STEP 2 — Call verdict="rewrite" ONLY when the draft genuinely STATES a completed action ("Done — booked Wed 12:15", "added X", "I've sent it to Yael") AND the TOOL ACTIVITY shows NO matching successful tool (the tool is absent, or its summary says FAILED). Put the corrected reply in \`message\`. The rewrite must:
- Make it UNMISTAKABLE the thing has NOT gone through yet, so ${opts.ownerFirstName} knows it still needs to happen. (e.g. "Actually — hold on, that didn't go out yet, let me sort it.")
- NOT claim it's done/sent/booked/flagged/handled, and NOT smooth it into "I'll take care of it" (reads as resolved) — and this BANS present-progressive reassurance just as much: "I'm handling it right now", "I'm on it now", "I'm taking care of it as we speak", Hebrew "אני דואגת לזה עכשיו" are the SAME false promise in a different tense — they claim an action is actively in motion this instant when NOTHING is happening and no tool call is queued behind this reply. The rewrite must leave the reader knowing nothing is in progress, only that the assistant noticed the miss.
- Keep every other fact intact: names, times, dates, numbers, the rest of the message.
- Sound like a real person owning a small slip — never a system/error message, no talk of tools or mechanism.
- Match the language of the draft (Hebrew/English/etc).

SAFE-MISS — the hard rule. If you CANNOT tell from the tool activity whether the specific action happened (a related mutation ran but you are not sure it covers this exact claim), do NOT assert the opposite. NEVER invert a stated completed action into a confident "that didn't go through" / "I haven't done it yet", and NEVER manufacture a re-ask ("can you confirm the address?") for something that may already be done — inverting a TRUE statement is far worse than leaving a mild overclaim. When you are not sure the claim is false: verdict="keep". Only rewrite when the tool activity makes the false claim clear.

Draft:
${opts.draft}`;

  try {
    const resp = await anthropic.messages.create({
      // Sonnet — the keep-vs-rewrite judgment is what Haiku misfires on; this
      // path runs only on flags (a few/day), so the stronger model is cheap here.
      ...SONNET,
      max_tokens: 600,
      tools: [{
        name: 'verdict',
        description: isInventedOwnerFact
          ? 'Report whether the draft falsely states an unverified personal fact about the owner, and if so the corrected reply.'
          : isUngroundedSlotClaim
            ? 'Report whether the draft offers a specific time as available that this turn\'s real availability search does not confirm, and if so the corrected reply.'
            : 'Report whether the draft falsely claims a completed action, and if so the corrected reply.',
        input_schema: {
          type: 'object' as const,
          properties: {
            verdict: {
              type: 'string',
              enum: ['keep', 'rewrite'],
              description: isInventedOwnerFact
                ? '"keep" = the draft is fine (already hedged, or the claim is grounded by tool activity). "rewrite" = the draft states an unverified personal fact about the owner as settled fact.'
                : isUngroundedSlotClaim
                  ? '"keep" = the draft is fine (the time genuinely matches the real result WITH A POSITIVE/AVAILABLE verdict, or nothing specific was offered). "rewrite" = the draft offers a specific time as available that the real result does not confirm — including when the matched result is itself marked unavailable/negative.'
                  : '"keep" = the draft is fine (proposal/offer/future-commit, or the action actually happened). "rewrite" = the draft falsely states a completed action no tool performed.',
            },
            message: {
              type: 'string',
              description: isInventedOwnerFact
                ? 'Only when verdict="rewrite": the corrected reply text, with the flagged personal claim removed or hedged. Omit for "keep".'
                : isUngroundedSlotClaim
                  ? 'Only when verdict="rewrite": the corrected reply text, using the REAL confirmed time(s) in place of the fabricated one (or honestly saying none was confirmed). Omit for "keep".'
                  : 'Only when verdict="rewrite": the corrected reply text, honest that the action has not happened yet. Omit for "keep".',
            },
            noPendingActionClaim: {
              type: 'boolean',
              description: 'Only for a phantom-action rewrite (verdict="rewrite", flagged action was an un-done action, not an invented fact): self-check `message` before returning it. Set true ONLY if `message` contains NO claim or implication — in any tense, any language — that the action is currently being done, is in progress, or is about to complete ("I\'m handling it now", "I\'m on it", "אני דואגת לזה עכשיו" all FAIL this and must be set false). Set false whenever unsure; a false value here causes the caller to discard this rewrite.',
            },
            noUnfoundedOwnerClaim: {
              type: 'boolean',
              description: 'Only for an invented-owner-fact rewrite (verdict="rewrite", flagged claim was an unverified personal fact about the owner): self-check `message` before returning it. Set true ONLY if `message` no longer asserts, as settled fact, the flagged claim or any other unverified personal claim about the owner. Set false whenever unsure; a false value here causes the caller to discard this rewrite.',
            },
            noUngroundedTimeClaim: {
              type: 'boolean',
              description: 'Only for an ungrounded-slot-claim rewrite (verdict="rewrite", flagged claim was a specific time offered as available with no backing in this turn\'s real search result): self-check `message` before returning it. Set true ONLY if `message` no longer states any specific time as available unless that time is one of the REAL confirmed times you were given. Set false whenever unsure; a false value here causes the caller to discard this rewrite.',
            },
            minimalRedaction: {
              type: 'string',
              description: 'Only for an invented-owner-fact or ungrounded-slot-claim rewrite (verdict="rewrite"): a SECOND, more conservative candidate — the draft with ONLY the flagged claim deleted or blanked out and NOTHING else changed (no new sentences, no paraphrasing, no added hedge; every other word copied verbatim from the draft). Fill this alongside `message`, not instead of it — it is the fallback used if `message` cannot be trusted. Omit for a phantom-action rewrite or verdict="keep".',
            },
            minimalRedactionPreservesRest: {
              type: 'boolean',
              description: 'Only alongside `minimalRedaction`: self-check it before returning it. Set true ONLY if `minimalRedaction` is identical to the draft except for removing/blanking the flagged claim — no other wording changed at all, nothing added. Set false whenever unsure.',
            },
          },
          required: ['verdict'],
        },
      }],
      tool_choice: { type: 'tool', name: 'verdict' },
      messages: [{ role: 'user', content: prompt }],
    });
    logLlmUsage('claim_checker_rewrite', MODEL_SONNET, resp);

    // Read ONLY the structured tool fields — never a text block. This is what
    // makes a reasoning leak impossible: the model's monologue, if any, lives in
    // text blocks we ignore; only `verdict`/`message` can ever become the reply.
    const toolUse = resp.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
    const input = (toolUse?.input ?? {}) as {
      verdict?: string;
      message?: string;
      noPendingActionClaim?: boolean;
      noUnfoundedOwnerClaim?: boolean;
      noUngroundedTimeClaim?: boolean;
      minimalRedaction?: string;
      minimalRedactionPreservesRest?: boolean;
    };

    const isMetaOrEmpty = (text: string): boolean =>
      text.trim().length === 0 || /\b(the draft|the checker|claimed_action|UNCHANGED|the action was performed)\b/i.test(text);

    // owner-personal-fact-fabricated-in-colleague-reply (2026-08-14, bouncer
    // retry) — the scoped fallback for invented_fact mode (G1/G5); reused
    // unchanged (2026-08-24) for ungrounded_slot_claim, same shape: before
    // reaching for the full-reply-replacing genericHonestHedge, try the
    // model's own minimal-redaction candidate — the draft with ONLY the
    // flagged claim removed, everything else untouched, so a single false
    // clause no longer nukes an otherwise-true, otherwise-useful reply. Only
    // trusted when the model's own self-attestation says it changed nothing
    // else AND the result isn't implausibly short (a cheap deterministic
    // guard against a "preserves rest" attestation that doesn't hold up).
    const resolveMinimalRedactionFallback = (): string => {
      const redaction = typeof input.minimalRedaction === 'string' ? input.minimalRedaction.trim() : '';
      const preservesRest = input.minimalRedactionPreservesRest === true;
      if (preservesRest && !isMetaOrEmpty(redaction) && redaction.length >= opts.draft.length * 0.4) {
        return redaction;
      }
      return genericHonestHedge(opts.draft, opts.isOwnerAudience);
    };

    // verdict=keep (or missing/garbled) → classifier misfired → keep original.
    if (input.verdict !== 'rewrite') {
      logger.info('claim_checker_rewrite_vetoed — rewriter judged the draft fine (proposal/offer/future-commit, the action did happen, or the personal claim was hedged/grounded); keeping original', {
        action_type: opts.actionType,
        action_summary: opts.actionSummary,
        verdict: input.verdict ?? '(none)',
        draftPreview: opts.draft.slice(0, 200),
      });
      return null;
    }

    // verdict=rewrite means STEP 2 has ALREADY independently confirmed the
    // draft is false — from here down we are auditing the REWRITE, not the
    // verdict, so a failure below can no longer fall back to "keep original"
    // (gh#194-b-confession-overpromises-unexecuted-action, bouncer overturn):
    // that would knowingly ship the proven lie. A rewrite with no usable
    // message, or one that smells like leaked reasoning, ships the fixed
    // generic fallback line instead — we NEVER ship the model's meta-text,
    // and never the known-false original, as the reply.
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (isMetaOrEmpty(message)) {
      logger.warn('claim_checker_rewrite — verdict=rewrite but message empty/meta; shipping a scoped fallback (never the known-false original)', {
        action_type: opts.actionType,
        messagePreview: message.slice(0, 160),
      });
      return (isInventedOwnerFact || isUngroundedSlotClaim) ? resolveMinimalRedactionFallback() : GENERIC_HONEST_MISS;
    }

    if (isInventedOwnerFact) {
      // owner-personal-fact-fabricated-in-colleague-reply — same self-attest
      // pattern as the pending-action check below (a hardcoded regex strip
      // can't be the fix — multilingual), but checking that the rewrite drops
      // the unfounded personal claim rather than the pending-action framing.
      if (input.noUnfoundedOwnerClaim !== true) {
        logger.warn('claim_checker_rewrite — verdict=rewrite but model would not attest the rewrite drops the unfounded owner claim; shipping a scoped fallback (never the known-false original)', {
          action_type: opts.actionType,
          messagePreview: message.slice(0, 160),
        });
        return resolveMinimalRedactionFallback();
      }
      return message;
    }

    if (isUngroundedSlotClaim) {
      // proposed-slot-not-grounded-in-search-result (2026-08-24) — same
      // self-attest pattern as the owner-fact branch above, checking that the
      // rewrite drops the fabricated time rather than the phantom-action
      // framing.
      if (input.noUngroundedTimeClaim !== true) {
        logger.warn('claim_checker_rewrite — verdict=rewrite but model would not attest the rewrite drops the ungrounded time claim; shipping a scoped fallback (never the known-false original)', {
          action_type: opts.actionType,
          messagePreview: message.slice(0, 160),
        });
        return resolveMinimalRedactionFallback();
      }
      return message;
    }

    // gh#194-b — the prompt already forbade "I'll take care of it"-style
    // smoothing, yet a real rewrite still shipped "אני דואגת לזה עכשיו" ("I'm
    // handling it right now"): a present-progressive reassurance that promises
    // the SAME unexecuted follow-through in a different tense. A hardcoded
    // phrase regex can't be the fix (multilingual — see the exact Hebrew
    // example), so the model must self-attest on the SAME call instead of a
    // second one: `noPendingActionClaim` forces it to check its own `message`
    // for that framing before returning it. Anything other than an explicit
    // `true` (false, or the model omitting the field) means the proposed
    // rewrite itself cannot be trusted — but verdict=rewrite already proved
    // the ORIGINAL false, so (gh#194-b-confession-overpromises-unexecuted-action,
    // bouncer overturn) the safe miss here is the fixed GENERIC_HONEST_MISS
    // line, never the known-false original.
    if (input.noPendingActionClaim !== true) {
      logger.warn('claim_checker_rewrite — verdict=rewrite but model would not attest the rewrite drops the pending-action claim; shipping the generic honest-miss line (never the known-false original)', {
        action_type: opts.actionType,
        messagePreview: message.slice(0, 160),
      });
      return GENERIC_HONEST_MISS;
    }
    return message;
  } catch (err) {
    logger.warn('rewriteOwningTheMiss threw — caller keeps original draft', {
      err: String(err).slice(0, 200),
    });
    return null;
  }
}
