/**
 * Output-time gate stack — extracted from connectors/slack/postReply.ts.
 *
 * LANE BOUNDARY. postReply owns the DELIVERY pipeline (history save, mrkdwn
 * normalize, ack-reaction, shadow, audio-vs-text, threading, approval footer).
 * This module owns the GATE POLICY: what each check concludes, in what order
 * the checks run, and what may be done about a verdict (rewrite / retry).
 * The gate primitives themselves stay in their own guard files
 * (utils/claimChecker, utils/humanGate, utils/dateVerifier, utils/securityGate)
 * and are still dynamically imported — a clean reply never loads them twice.
 *
 * THREE entry points, because pipeline steps legitimately sit between them:
 *   1. runDeliberationGuard(draft, profile) — runs on the RAW draft, before
 *      postReply normalizes it to Slack mrkdwn, because what it strips is Maelle's
 *      own prose narration and the trigger reads that prose as she wrote it.
 *   2. runOutputGates(draft, ctx) — the whole gate stack, on the already
 *      normalized Slack-mrkdwn draft; returns the text to send.
 *   3. runCodaGates(coda, ctx) — the SOCIAL CODA's own, much smaller gate. It is
 *      a separate entry point rather than a mode of (2) because the coda is a
 *      different kind of message (see its own doc comment): it answers nothing,
 *      claims nothing, and its safe failure is SILENCE, not a rewrite. It
 *      therefore returns a ship/drop verdict and cannot alter the text at all.
 *
 * WHICH gates run on the SLACK transport is decided by TWO axes, never one
 * role test — see the derivation at the top of runOutputGates. Order:
 *   BOTH LEGS FIRST: the availability floor (utils/availabilityGate) — a time the
 *     rule-aware check established as unavailable may not be sold as workable to
 *     anyone, so it is decided by the calendar and not by the reader, and running
 *     it first means its rewrite is scrubbed / voice-checked / date-verified by
 *     whichever leg follows — THEN the slot-grounding check (claimChecker's
 *     'slot_grounding' mode, gh proposed-slot-not-grounded-in-search-result):
 *     the MIRROR case — a specific time never confirmed by this turn's own
 *     find_available_slots / check_join_availability may not be sold as
 *     available either. Same reader-independent placement, same reasoning.
 *   OWNER-PRIVATE (a 1:1 DM; only the owner ever reads it): claim-check +
 *     humanGate('owner') + date-verify, probed concurrently, exact serial chain
 *     on any flag.
 *   COLLEAGUE-READABLE (a colleague DM, a channel, or the owner in a group DM):
 *     claim-check (when the owner is the one acting, OR this thread carries a
 *     tracked request row — v4.4.x #154's room-approval honesty check) →
 *     owner-fact-invention check (EVERY colleague-readable turn, regardless
 *     of who's acting — see claimChecker.ts's 'owner_fact' mode) →
 *     security gate → humanGate('internal') → date-verify. The leak scrub
 *     runs after every rewriter that could emit an internal token, voice after every rewriter
 *     that could write like a machine, and date-verify LAST — after every
 *     rewriter, on both legs, because it is the only check whose subject
 *     (a weekday word) a REWRITER can introduce.
 *
 * `ctx.transport === 'email'` (gh#24) skips both axes entirely and takes a
 * dedicated THIRD leg, runEmailLegGates below — not because email is a third
 * axis value, but because it has exactly one reader-frame ('external') by
 * construction, so there is nothing for an axis test to derive. See that
 * function's own doc comment for what runs and what does not.
 *
 * NOTHING here re-runs the orchestrator (G3). Every remedy is either a
 * deterministic edit or a single tool-less rewrite pass. And since v4.2.x nothing
 * here writes to conversation history either: postReply persists ONCE, on the text
 * this returns (its Step 3b), so a corrected reply is simply what gets stored
 * — no gate has to chase the record with a second row.
 *
 * NOTHING here throws, and nothing here can cost a person their message. Every
 * gate call is individually try/caught. A VERDICT gate fails OPEN — an error leaves
 * the draft it was handed, so the worst case is that a rare defect ships (G5's safe
 * miss). The colleague leg's LEAK gate is the one that may not fail open, because
 * handing a colleague an unvetted draft is the exact failure it exists to prevent,
 * so it fails SAFE: the catch swaps the reply for a fixed line of our own text
 * (below). Delivery is kept; only the content is given up.
 *
 * v4.2.x — the first sentence is now TRUE. It used to say "every gate FAILS OPEN: a
 * throw anywhere leaves the draft it was handed" while two awaits in the colleague
 * leg's security block sat outside any try: the `../../db` import behind the spoof
 * inputs, and `filterColleagueReply` itself. Since the delivery pipeline moved the
 * history write BELOW this call, a throw there did not leave the draft it was handed
 * — it left the FUNCTION, so postReply never sent and never stored, and the runner's
 * catch answered with the generic failure line instead (processMessage.ts:572-814,
 * `delivered` still false). One unloadable module and the entire answer was gone, on
 * the one leg where a non-owner is reading it.
 *
 * runCodaGates inverts the contract deliberately (fail-CLOSED, drop) and cannot
 * throw either; runDeliberationGuard fails open.
 */

import { getAnthropicClient } from '../../llm/client';
import { SONNET, MODEL_SONNET } from '../../llm/models';

import type { UserProfile } from '../../config/userProfile';
import type { SenderRole } from '../../connectors/slack/postReply';
import type { HumanGateAudience } from '../humanGate';
import type { OrchestratorOutput } from '../../core/orchestrator';
import { formatForSlack } from '../../connections/slack/formatting';
import logger from '../logger';
import { logLlmUsage } from '../usageLog';

/**
 * Everything the gate stack reads. A subset of postReply's PostReplyInput —
 * the delivery-only fields (say / userMessageTs / voiceInput) are deliberately
 * NOT here: a gate must never be able to send.
 */
export interface OutputGateContext {
  profile: UserProfile;
  result: OrchestratorOutput;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  userMessage: string;
  senderId: string;
  channelId: string;
  threadTs: string;
  role: SenderRole;
  colleagueName?: string;
  isMpim?: boolean;
  /**
   * gh#194-b-promised-resend-never-fired (2026-08-10, bouncer overturn) — the
   * missing sibling of isMpim. postReply.ts's own PostReplyInput has always had
   * an `isChannel` (a real channel, not a DM, not an MPIM) but never forwarded
   * it into this context, so no gate downstream could tell a channel turn apart
   * from a 1:1 DM. The claim-checker relay backstop (below, "the relay-to-owner
   * backstop") is the guard that was silently trusting `!isMpim` alone to mean
   * "a real 1:1 DM" — it does not, a channel is neither. Threaded through so
   * that check (and any future one) can ask for a real DM correctly.
   */
  isChannel?: boolean;
  isOwnerInGroup?: boolean;
  mpimMemberIds?: string[];
  /**
   * Which delivery leg this draft is headed for. Defaults to 'slack' — every
   * existing caller predates this field and stays byte-identical. 'email'
   * (gh#24) takes the dedicated EMAIL LEG below instead of the two-axis
   * Slack policy: the reader is always external (the owner forwards the
   * reply verbatim), so the frame follows the READER, not the fact that the
   * only live recipient is the owner's own inbox (the one-address cap).
   * Also decides whether a gate's rewrite gets normalized through
   * `formatForSlack` mid-pipeline — see `normalizeForTransport` below for why
   * the email leg deliberately does NOT get an equivalent mid-pipeline call.
   */
  transport?: 'slack' | 'email';
}

/**
 * ctx.transport-aware outbound normalization for a gate's REWRITE (never for
 * the untouched draft). Slack's own call sites keep calling formatForSlack
 * directly since they can never see transport:'email' (runOutputGates
 * returns early for it) — this is here only so the two rewrite helpers
 * shared by both legs (claim-check, date-verify) don't have to know which
 * transport they're running under.
 *
 * The email leg is a no-op here BY DESIGN, not an oversight: formatForEmail
 * is NOT idempotent like formatForSlack — it markdown→HTML's the text and
 * HTML-escapes it, so calling it here on a mid-pipeline rewrite and AGAIN at
 * send time (EmailConnection.sendDirect's own `formatForEmail(text)` call,
 * connections/email/formatting.ts's documented "single entry point before
 * handing text to sendMail") would double-process whatever a gate rewrote —
 * escaping the first pass's own `<p>`/`<strong>` tags into literal
 * `&lt;p&gt;` text in the sent email. Leaving the email leg's rewrites as
 * plain text costs nothing: sendDirect's one formatForEmail call still runs
 * scrubInternalLeakage over whichever text — gated or not — ends up being
 * sent, so nothing ships unscrubbed either way.
 */
function normalizeForTransport(ctx: OutputGateContext, text: string): string {
  return ctx.transport === 'email' ? text : formatForSlack(text);
}

export async function runOutputGates(draft: string, ctx: OutputGateContext): Promise<string> {
  const {
    profile, result,
    role, colleagueName,
    senderId, channelId, threadTs,
    history, userMessage, isMpim, isOwnerInGroup, mpimMemberIds,
  } = ctx;
  let cleanReply = draft;

  // ── EMAIL LEG — a forwarded reply, gated in the READER's frame (gh#24) ─────
  // Bypasses the Slack two-axis policy below entirely: there is no
  // owner-vs-colleague reader split to derive here, because the email leg has
  // exactly ONE possible reader-frame — 'external' — regardless of who typed
  // the forward (the sender gate already restricts that to the owner + his
  // configured aliases). See runEmailLegGates' own doc comment for what runs
  // and, as importantly, what does NOT.
  if (ctx.transport === 'email') {
    return runEmailLegGates(ctx, cleanReply);
  }

  // ── Which gates apply: TWO axes, not one role test ────────────────────────
  // This pair IS the gate policy. It used to be a single `role === 'owner' ||
  // isOwnerInGroup` test plus its exact complement, and that one test was being
  // asked two different questions:
  //
  //   ownerIsActing     — the AUTHENTICATED owner is the one being answered.
  //                       Decides the phantom-action honesty check: the
  //                       claim-checker exists so the person who can go and
  //                       chase an un-done action learns it didn't happen.
  //   colleagueReadable — somebody other than the owner will read this text.
  //                       Decides the leak gate, the humanGate voice frame,
  //                       and (owner-personal-fact-fabricated-in-colleague-
  //                       reply, 2026-08-14) the owner-fact-invention check —
  //                       a colleague reading a fabricated personal claim
  //                       about the owner is the risk regardless of who is
  //                       typing this turn, unlike the phantom-action check
  //                       above which needs the OWNER specifically acting.
  //
  // In a 1:1 owner DM and in a colleague's DM those two answers are exact
  // negations of each other, which is why one test carried both for so long. In
  // a GROUP DM they come apart: `role` is already clamped to 'colleague'
  // (processMessage.ts:123) precisely because every colleague in the room reads
  // the reply, while `isOwnerInGroup` says the owner is the one typing. The old
  // single test read that as "owner-facing", so the one colleague-readable
  // surface in the system shipped with NO leak gate and the wrong voice frame —
  // and the SAME room was gated differently depending on who had spoken last.
  //
  // v4.2.x — ownerIsActing now asks its question DIRECTLY, of the authenticated
  // Slack sender, instead of through a proxy that answered it for two surfaces out
  // of three. `role` is derived from exactly this comparison (app.ts:95) and is then
  // CLAMPED to 'colleague' in an MPIM and in a channel (processMessage.ts:123) —
  // so the old `role === 'owner' || isOwnerInGroup` pair covered the DM and the
  // group DM and silently missed the CHANNEL: the owner @-mentions Maelle in a
  // real channel, she claims she messaged someone or moved something, and the
  // phantom-action check never ran, because the group-DM fix repaired the MPIM
  // half of the clamp with `isOwnerInGroup` and there is no `isOwnerInChannel`
  // on this side of the wire (processMessage.ts:122 computes one and never
  // passes it). Keyed on the authenticated identity in code, this covers every
  // present and future surface without a third flag to plumb or forget (shared
  // rule 10, G1). It can only ADD the honesty check, never drop it: `role ===
  // 'owner'` and `isOwnerInGroup` both already imply senderId is the owner's,
  // so this predicate is a strict superset of the pair it replaces.
  //
  // colleagueReadable keys on `role` — the clamp's own answer to "who can see
  // this" — which keeps it fail-closed for a future 'unknown' sender too. The
  // `|| isOwnerInGroup` arm is redundant TODAY (the clamp already sets role to
  // 'colleague' in any MPIM) and is written anyway so the predicate is true on
  // its own terms: a group DM has other members by definition, so if that clamp
  // ever moves this fails CLOSED — it adds the leak gate rather than dropping it.
  const ownerIsActing = senderId === profile.user.slack_user_id;
  const colleagueReadable = role !== 'owner' || isOwnerInGroup === true;
  // ONE frame decision, shared by every humanGate call below, and the same
  // convention runCodaGates already uses: anything that is not the authenticated
  // owner gets the colleague frame. In a group room the 'owner' frame is not
  // merely unnecessary, it is WRONG. Its single distinguishing rule is "NEVER
  // refer to him in third person" (humanGate.ts:97) — but naming the owner to
  // the colleagues in the room is exactly what the drafting prompt asks for
  // there (systemPrompt.ts:526 "SPEAK TO THE GROUP"), and 'internal' endorses
  // that shape verbatim (humanGate.ts:171). Every other rule in the gate is
  // identical across the two frames, so on a group reply the 'owner' frame could
  // only ever rewrite correct text — a G5 corruption, not a safe miss.
  const audience: HumanGateAudience = colleagueReadable ? 'internal' : 'owner';

  // ── The availability floor — BOTH legs, before every rewriter ─────────────
  // A time the rule-aware check ESTABLISHED as unavailable may not be described as
  // workable to anyone, so this runs on one code path for the owner and the
  // colleague alike (the 2026-07-27 incident produced both statements from the
  // same room, three minutes apart, and the colleague-facing one is what caused an
  // external invite). It sits ABOVE the leg split for two reasons: the decision is
  // reader-independent — the calendar fact is the same fact — and its rewrite is
  // then leak-scrubbed, voice-checked and date-verified by the gates below on
  // whichever leg the reply is on. On a clean turn it costs nothing: the pre-filter
  // is an empty in-memory ledger and no module is even loaded.
  cleanReply = await runAvailabilityFloorAndMaybeRewrite(ctx, cleanReply);

  // proposed-slot-not-grounded-in-search-result (2026-08-24) — the MIRROR of
  // the floor above, same placement and the same reasoning (reader-independent
  // calendar fact, rewrite gets checked by every gate below): a slot the
  // rule-aware check ESTABLISHED as blocked may not be sold as workable (the
  // floor above); a slot NEVER established as available by this turn's own
  // find_available_slots / check_join_availability may not be sold as
  // available either. Confirmed incident: a real find_available_slots call
  // returned an evening window, the drafted reply named a fabricated
  // early-afternoon time and a fabricated colleague conflict, 8 seconds
  // later, to a real colleague. RULE A (claimChecker's default mode) exempts
  // proposals from its phantom-action check by design — an EA proposing a
  // time is not claiming a completed action — which is correct for the
  // general case but left this specific class (a fabricated SPECIFIC time)
  // uncaught. On a turn that never calls either tool this costs nothing: the
  // deterministic pre-filter inside the function below returns immediately.
  cleanReply = await runSlotGroundingCheckAndMaybeRewrite(ctx, cleanReply);

  // (v3.6.x — the "booked-date honesty" backstop that used to run between the
  // two legs was RETIRED. It was a 4th output-path LLM call on every booking
  // reply, it depended on a clean ISO instant it didn't reliably get
  // (booked_start sometimes arrives as a display string → a false correction of
  // a correct reply, 2026-07-05), and its job — the wrong-day WRITE — is already
  // stopped upstream by the meeting-core weekday guard. Backstop with a bad data
  // source + zero real catches + one false alarm = not worth the call. G1 / G10.)

  // (v4.1.x — the v1.8.4 colleague "mutation-contradiction" step is RETIRED, and
  // it is the clearest G3 violation the stack had: its remedy was
  // `runOrchestrator(...)`, a SECOND full agentic turn on the reply path, to
  // reword a draft. G3 names re-running the orchestrator as never allowed — an
  // unbounded regeneration can differ from the vetted draft in any way, and it
  // cost seconds of latency plus a whole turn's tokens on the colleague path.
  // Its trigger was also English-only natural-language regex ("flagged it for",
  // "he'll decide") — G8-banned, and useless in Hebrew or Russian. And it never
  // caught anything: ZERO `Colleague draft defers to owner after mutation
  // succeeded` warns across every log on disk.
  //
  // The job it was doing is owned UPSTREAM, where it belongs (W3/G2): the
  // mutation tools return their own `action_summary` / `_must_reply_with` for the
  // drafting turn to narrate (skills/outreach.ts:348, :496) and the pinned action
  // tape replays confirmed mutations into the system prompt (turnHelpers.ts
  // extractActionTape). A draft that contradicts a mutation is a DRAFTING bug, so
  // it gets fixed where the draft is made, not policed afterwards.)

  if (!colleagueReadable) {
    // ── OWNER-PRIVATE — a 1:1 DM with the authenticated owner ───────────────
    // Claim-check + humanGate('owner') + date-verify. Nobody else ever reads
    // this text, so there is nothing to leak-scrub and the direct-address voice
    // frame is the right one.
    //
    // v4.0.x PROBE/parallelize: these three are side-effect-free cores (the
    // rewrites live in the wrappers below, not the cores — and since v4.2.x nothing
    // in this module writes to history at all), and a rewrite is RARE. Run all three
    // CONCURRENTLY on the post-concision text; if NONE wants a change (>95% of
    // turns) ship as-is — byte- AND side-effect-identical to the serial chain, which
    // on a clean turn also rewrites nothing. If ANY flags, fall back to the
    // untouched serial chain → byte-identical to the pre-4.0 behavior (the probe's
    // Haiku calls are wasted on that rare turn). Fail-safe: a probe error falls
    // through to serial. Collapses 3 serial round-trips → 1 wall-clock on the
    // common path. NO coverage change — every guard still runs.
    let ownerGuardsClean = false;
    try {
      const [{ checkReplyClaims }, { runHumanGate }, { verifyDates }] = await Promise.all([
        import('../claimChecker'),
        import('../humanGate'),
        import('../dateVerifier'),
      ]);
      const [claimV, humanV, dateV] = await Promise.all([
        checkReplyClaims({
          reply: cleanReply,
          toolSummaries: result.toolSummaries ?? [],
          bookingOccurred: result.bookingOccurred ?? false,
          ownerFirstName: profile.user.name.split(' ')[0],
          mpimContext: isMpim ? { isMpim: true, participantSlackIds: mpimMemberIds ?? [] } : undefined,
        }),
        runHumanGate(cleanReply, profile, audience, channelId),
        verifyDates(cleanReply, profile, userMessage),
      ]);
      // Each flag mirrors EXACTLY its wrapper's "would this rewrite the text?"
      // condition, so "none flags" ⇒ the serial chain would have rewritten nothing.
      const claimFlags = claimV.claimed_action === true;
      const humanFlags = !humanV.ok && !!humanV.rewrite && humanV.rewrite.trim().length > 0;
      const dateFlags = !dateV.ok && dateV.mismatches.length > 0;
      ownerGuardsClean = !claimFlags && !humanFlags && !dateFlags;
    } catch (err) {
      logger.warn('Owner-guard probe threw — falling back to the serial chain', { err: String(err).slice(0, 200) });
    }

    if (!ownerGuardsClean) {
      // SERIAL FALLBACK — the exact pre-4.0 chain (claim → humanGate → date),
      // byte-identical on a flag turn. The wrappers own the rewrite + history append.
      cleanReply = await runClaimCheckAndMaybeRewrite(ctx, cleanReply);
      try {
        const { runHumanGate } = await import('../humanGate');
        const verdict = await runHumanGate(cleanReply, profile, audience, channelId);
        if (!verdict.ok && verdict.rewrite && verdict.rewrite.trim().length > 0) {
          cleanReply = formatForSlack(verdict.rewrite);
        }
      } catch (err) {
        logger.warn('humanGate threw — leaving draft unchanged', { err: String(err).slice(0, 200) });
      }
      cleanReply = await runDateVerifierAndMaybeRetry(ctx, cleanReply);
    }
  } else {
    // ── COLLEAGUE-READABLE — a colleague's DM, a channel, or a GROUP DM ─────
    // Everything here is decided by the reader, not the sender, with one
    // exception: the honesty check, which is decided by who is acting.
    //
    // claim-check (owner acting, OR this thread carries a request row —
    // v4.4.x #154) → security gate → humanGate('internal') → date-verify.
    // The leak scrub runs after every rewriter that could emit an internal
    // token, voice after every rewriter that could write like a machine, and
    // date-verify LAST — see the note at its call below.

    // The phantom-action honesty check, kept for the owner's own turn in a
    // shared room. A straight "route the group DM to the colleague leg" would
    // have dropped it, and that trades one hole for another: the owner is IN the
    // room, he is the one directing the work, and he is the only person who can
    // go and chase an action Maelle said she'd done and hadn't. The checker was
    // also BUILT for exactly this surface — its MPIM branch (claimChecker.ts:45,
    // :124, :260, "inline mentions of these participants are LEGITIMATE
    // addressing") is reachable on no other path, so dropping it here would make
    // that branch dead. Its owner-only-ness (claimChecker.ts:22) is a statement
    // of scope, not of safety: the remedy is a tool-less own-the-miss rewrite
    // with its own keep-veto, so a wrong fire is a safe miss (G3/G5). Running it
    // FIRST also means its Sonnet-written prose is scrubbed and voice-checked by
    // the two gates below, which the owner-private leg cannot offer it.
    // v4.4.x (#154) — the room-approval honesty check. Owner ruling: she
    // announces nothing while a rule-bend escalation waits in the private
    // approval thread, so the only fabricable claim on that path is a room
    // reply asserting the decision already came back when it hasn't — INCLUDING
    // a decision that came back NEGATIVE (cancelled/expired), which is the same
    // fabrication in different clothes. Cheap, deterministic pre-filter (G10):
    // the vast majority of colleague turns carry no request at all in this
    // thread, ever, and those never reach the checker (getLatestRequestForThread
    // returns null on the first, single-query check below). Runs regardless of
    // who is acting (a real colleague asking "did he say yes?" is exactly the
    // risk surface; ownerIsActing alone would miss it).
    let approvalGrantContext: { isResolved: boolean } | undefined;
    try {
      const { anyRequestResolvedForThread, anyRequestPendingForThread, getLatestRequestForThread } = await import('../../db/requests');
      // gh#154-R7 (2026-08-06) — gh#154-R6 gated construction on hasLivePending ALONE
      // (state='awaiting_owner' right now). That correctly stopped the
      // paid-forever case on a RESOLVED thread (isResolved permanently true,
      // nothing left to falsely announce), but it also silently stopped the
      // check on a thread whose request(s) went cancelled/expired and were
      // NEVER resolved — isResolved reads false there FOREVER too, which is
      // exactly the shape of a genuine, standing risk ("he approved it" on a
      // thread that was in fact cancelled), not a cost-free non-event.
      // Measured 2026-08-06: 10 of 47 request-carrying threads are fully
      // terminal with zero resolved rows ever (9 cancelled, 1 expired) — under
      // gh#154-R6 NONE of them could ever reach the catch below, because
      // approvalGrantContext was never built for them. Gate is now
      // `hasLivePending || (thread ever carried a request && !isResolved)`:
      // a thread that resolved still goes quiet the moment isResolved flips
      // true (gh#154-R6's actual cost win, untouched — 37 of 47 threads), a thread
      // that never carried a request stays untouched at one cheap query
      // (the vast majority), and only the narrow terminal-never-resolved
      // slice (plus the one currently-live thread) keeps paying — which is
      // the same shape req_1783847332015_bgs91 had pre-gh#154-R6, except now it's
      // the genuine risk surface instead of an accidental blanket check.
      const latestRow = getLatestRequestForThread(profile.user.slack_user_id, threadTs);
      if (latestRow) {
        const hasLivePending = anyRequestPendingForThread(profile.user.slack_user_id, threadTs);
        // isResolved is "was ANY request in this thread ever resolved", not
        // just the newest row's state (see anyRequestResolvedForThread's doc
        // comment): a thread can carry 2+ requests, and gating on the latest
        // row alone inverted a TRUE "he approved it" about an OLDER,
        // already-resolved row into a rewritten false "that hasn't come
        // through yet" whenever a newer, unrelated request was still
        // pending. Passed through so the checker doesn't flag a true claim
        // about that older, already-granted row while the newer one is
        // still live.
        const isResolved = anyRequestResolvedForThread(profile.user.slack_user_id, threadTs);
        if (hasLivePending || !isResolved) {
          approvalGrantContext = { isResolved };
        }
      }
    } catch (err) {
      logger.warn('approval-grant-context lookup threw — skipping the room-approval honesty check', {
        threadTs, err: String(err).slice(0, 200),
      });
    }

    if (ownerIsActing || approvalGrantContext) {
      cleanReply = await runClaimCheckAndMaybeRewrite(ctx, cleanReply, approvalGrantContext);
    }

    // owner-personal-fact-fabricated-in-colleague-reply (2026-08-14) — runs on
    // EVERY colleague-readable turn, independent of ownerIsActing/
    // approvalGrantContext above: a colleague reading a fabricated personal
    // claim about the owner is the risk regardless of who is typing this
    // turn. Kept as its own call (claimChecker's 'owner_fact' mode, its own
    // Haiku round-trip) rather than folded into the RULE A prompt/call above,
    // so RULE A's own considered ownerIsActing/approvalGrantContext scoping
    // (claimChecker.ts's top-of-file doc comment) is untouched by this fix.
    cleanReply = await runOwnerFactCheckAndMaybeRewrite(ctx, cleanReply);

    // Security gate (leak filter + identity-spoof). This is the gate a group DM
    // never had: every trigger in securityGate's TRIGGER_PATTERNS — the disclosure
    // ones and the identifier ones alike — was skipped on the owner's turns in a
    // room full of colleagues, leaving scrubInternalLeakage (inside formatForSlack)
    // as the only thing between an internal token and a colleague's screen. Named
    // by POINTER, not re-listed here: a copy of that list is one more thing to keep
    // in sync, and the copy that used to sit here had already gone stale twice over
    // (it filed internal_ref_id under "disclosure", and it carried a trigger the
    // gate has since retired).
    //
    // v3.0.5 — pull verified colleague email from people_memory (written at
    // message-arrival in app.ts via users.info → upsertPersonMemory). Extract
    // the last few user-role turns from history for the spoof scan. Both feed
    // the identity check inside filterColleagueReply.
    //
    // Those spoof inputs are WITHHELD when the owner is the one acting, and that
    // is deliberate rather than incidental. The identity half asks "is this
    // sender claiming to be someone else?" — a question with no meaning when the
    // sender is the Slack-authenticated owner, while every on-domain address he
    // types ("add alex@… to the invite") is a normal instruction that would trip
    // its structured trigger. Its remedy REPLACES the whole reply with an "as far
    // as I can see you're <name>" line, so a wrong fire there is corruption, not
    // a miss. filterColleagueReply runs leak-scan-only when they are absent, so
    // withholding them is the control (shared rule 10 — scope the payload; don't
    // hand a check inputs it must not act on). Today colleagueName is undefined
    // for an owner-in-group turn anyway (processMessage.ts:386) — this stops that
    // cross-lane accident from being the only thing holding the branch shut.
    // 2026-08-14 (bouncer overturn) — `history` is a PRE-TURN snapshot:
    // processMessage.ts reads it (:281) BEFORE this turn's own message is
    // appended to conversation storage (:313), so built from history alone
    // this array can never carry what the sender just said THIS turn. A
    // same-message "are you AI?" either landed one turn late (thread had
    // prior history, judge checked the WRONG turns) or never ran the judge
    // at all (first message in a thread, array empty, the `length > 0` guard
    // short-circuits). `userMessage` — the sender's own words for the CURRENT
    // turn, already carried on this context (:99) — is appended as the newest
    // entry so the judges below see the actual question being answered right
    // now, not only what came before it.
    //
    // 2026-08-14 round 3 (owner-in-group fix) — built UNCONDITIONALLY, unlike
    // the spoof inputs below. This feeds ONLY the AI-identity "genuinely asked"
    // judge (securityGate's judgeAiIdentityWasAsked), a question with no
    // sender-identity angle: whether Maelle's AI-disclosure was genuinely asked
    // applies the same way when the owner himself is typing in a group DM as it
    // does for a colleague. The identity-SPOOF inputs just below stay withheld
    // on ownerIsActing — that withholding is a deliberate double-lock on a
    // DIFFERENT check (see that comment) and must not also starve this one.
    const aiIdentityContextMessages = [
      ...history.filter(h => h.role === 'user').map(h => h.content),
      userMessage,
    ].slice(-5);

    let verifiedSenderEmail: string | undefined;
    let recentUserMessages: string[] | undefined;
    let ownerEmail: string | undefined;
    if (!ownerIsActing) {
      try {
        const { getPersonMemory } = await import('../../db');
        verifiedSenderEmail = getPersonMemory(senderId)?.email ?? undefined;
        recentUserMessages = aiIdentityContextMessages;
        ownerEmail = profile.user.email;
      } catch (err) {
        // A db read is not a gate verdict, and it must not be able to cost a
        // colleague their answer. Degrade to the leak-scan-only mode the gate
        // already documents — and degrade ALL THE WAY: the spoof branch needs
        // colleagueName + ownerEmail + recentUserMessages TOGETHER
        // (securityGate.ts:547-552), so a half-filled set is the dangerous state,
        // not the safe one — it would leave detectClaimedEmail running without
        // the sender's verified address, which makes every on-domain email in
        // the thread look like an identity claim and hands a WRONG refusal to a
        // correct reply. All three cleared, so the leak scan still runs on the
        // full draft and only the identity half stands down.
        verifiedSenderEmail = undefined;
        recentUserMessages = undefined;
        ownerEmail = undefined;
        logger.warn('Spoof inputs unavailable — security gate running leak-scan-only', {
          senderId, threadTs, err: String(err).slice(0, 200),
        });
      }
    }
    // v4.1.x — normalize the gate's output like every OTHER rewrite path in this
    // file does. This was the one rewrite that shipped raw: securityGate's Sonnet
    // rewriter and its Haiku identity-refusal composer both emit free text, and it
    // went straight to Slack without formatForSlack — so the scrubber never saw it.
    // The em-dash AI-tell in the 2026-07-21 rewrite (log :838) is exactly that, and
    // any raw id or tool name the rewriter emitted would have shipped unscrubbed
    // too. Running it through formatForSlack also makes textScrubber the LAST word
    // on the slack-id token on this path: whatever the rewriter did with an id, the
    // scrubber re-wraps it into a rendered mention.
    //
    // v4.2.x — and it is CAUGHT, which it was not. Together with the db read above,
    // this was the only await in the stack outside a try, and what it cost was the
    // whole answer, on the one leg where a non-owner is reading: the throw reached the
    // runner's catch (processMessage.ts:572-814) with `delivered` still false, so the
    // colleague got the generic failure line instead of their reply, and nothing was
    // stored either (postReply's history write sits below this call).
    //
    // Fail SAFE, not open — those are different things here, and the difference is
    // the whole point of catching it. This is the LEAK gate: passing the draft
    // through because the gate is unavailable would ship a colleague-facing reply
    // that nothing vetted for the classes only this gate covers (self-as-AI,
    // internals, model/provider, payload echoes, req_/task_ ids, spoof) — the exact
    // fail-open closed one layer down. formatForSlack has already run on this
    // draft (postReply Step 2) and it is NOT a substitute: it knows about graph ids,
    // account ids, tz strings and tool names, and nothing else on that list.
    //
    // So the remedy keeps the DELIVERY and gives up the CONTENT: a fixed line of our
    // own text, which cannot leak because none of the draft survives in it. The
    // colleague gets a human sentence that invites the retry (the failure is
    // infrastructure — a module that would not load — so a retry is the only thing
    // that can help), history keeps a coherent record of what she actually said, and
    // the gates below run on a line they will trivially pass.
    //
    // A local literal rather than securityGate's own SAFE_FALLBACK, for two reasons.
    // The case we are in is "that module would not load", so anything imported from it
    // — its canned line included — is precisely what is unavailable. And its wording
    // is wrong here: "let me check that with <owner> and come back to you" promises a
    // follow-up, and after this catch there is no follow-up, only an ERROR log. A
    // guard must not fix a leak by telling a colleague something untrue. Fixed
    // English, same accepted compromise as that fallback and imageGuard's refusal.
    //
    // aiDisclosureCleared threads the security gate's own AI-identity-judge
    // outcome into humanGate below (see humanGate.ts's SYSTEM_PROMPT_TEMPLATE
    // doc comment). Defaults false: if the security gate throws before it can
    // run the judge, humanGate must NOT grant an exemption nobody verified.
    let aiDisclosureCleared = false;
    try {
      const securityResult = await runSecurityGate({
        reply: cleanReply,
        colleagueName,
        senderId,
        assistantName: profile.assistant.name,
        ownerFirstName: profile.user.name.split(' ')[0],
        verifiedSenderEmail,
        ownerEmail,
        recentUserMessages,
        aiIdentityContextMessages,
      });
      cleanReply = formatForSlack(securityResult.reply);
      aiDisclosureCleared = securityResult.aiIdentityCleared;
    } catch (err) {
      logger.error('Security gate unavailable on a colleague-readable reply — the draft was never vetted, substituting a safe line', {
        senderId, channelId, threadTs, colleagueName,
        err: String(err).slice(0, 300),
        lostDraftPreview: cleanReply.slice(0, 500),
      });
      cleanReply = `Sorry, that one didn't come out right, mind asking me again?`;
    }

    // (v2.6.5) — colleague-facing humanness gate. Same gate that runs on the
    // owner-private leg above, in the reader's frame.
    // Catches Maelle framing herself as having technical infrastructure
    // ("I have a technical issue preventing me", "my system can't process this"),
    // including the abdication shape ("you can send the invite directly")
    // worded as machine-state. Owner direction (2026-05-10): "it's ok if
    // Maelle gives up and comes to me — I rather that than nonsense — just
    // don't write it as bot." Honest escalation in human voice is fine; the
    // gate's prompt explicitly allows it. Fails open.
    try {
      const { runHumanGate } = await import('../humanGate');
      // v2.9 — Slack-side colleagues are same-domain by definition (workspace
      // membership), so `audience` resolves to 'internal' here. When
      // EmailConnection lands, its sendReply path will pass 'external' for
      // off-domain recipients. `aiDisclosureCleared` is the ONLY path that may
      // pass true — see runHumanGate's own doc comment for why every other
      // caller in this file stays at the false default.
      const verdict = await runHumanGate(cleanReply, profile, audience, channelId, aiDisclosureCleared);
      if (!verdict.ok && verdict.rewrite && verdict.rewrite.trim().length > 0) {
        cleanReply = formatForSlack(verdict.rewrite);
      }
    } catch (err) {
      logger.warn('humanGate (colleague-path) threw — leaving draft unchanged', { err: String(err).slice(0, 200) });
    }

    // Date-verify. Catches "Thursday 11 June" when the 11th is a Wednesday, in any
    // language — a wrong date to a colleague is just as bad.
    //
    // v4.2.x — LAST, after both rewriters, which is where the owner leg has always
    // had it (claim → humanGate → date). It used to run SECOND here, before the
    // security rewriter and the voice rewriter, so a weekday word that either of them
    // introduced reached the colleague with nothing checking it: this is the only
    // gate whose subject a REWRITER can introduce, and neither rewriter's
    // fact-preservation veto looks at weekday words (humanGate.ts:306 checks
    // mentions, clock times, numeric dates and questions — a weekday is a WORD, and
    // regex on weekday names is banned anyway, G8). Verifying the pre-rewrite draft
    // verified a string nobody received.
    //
    // Safe to run after the leak scrub, and the only gate of which that is true: it
    // adds no prose of its own. Its whole action is swapping one weekday token for
    // another inside the detector's own matched span (dateVerifier.ts:21), so it
    // cannot manufacture an internal token or a machine voice for the gates above to
    // have caught. The swap normalizes through formatForSlack for that last mile all
    // the same, like every other rewrite path in this file.
    cleanReply = await runDateVerifierAndMaybeRetry(ctx, cleanReply);
  }

  return cleanReply;
}

/**
 * The EMAIL LEG (gh#24). A non-Slack entry into the same gate stack, so a
 * transport that isn't `postReply` still gets gated at all — today this is
 * the only path `runOutputGates` is reachable from besides Slack.
 *
 * Three checks, same relative order the owner-private Slack leg already uses
 * (claim → humanGate → date-verify):
 *
 *  - claimChecker always runs (no `ownerIsActing` gate needed): the inbound sender
 *    authorization already restricts this whole leg to the owner + his
 *    configured aliases (connectors/email/inbound.ts), so every draft here
 *    IS the owner's own turn. A phantom "I've booked it" reaching externals
 *    over his signature, with nothing between the LLM and Graph's send call,
 *    is exactly the honesty gap the checker exists to catch.
 *  - humanGate runs in the 'external' frame — a value the type has defined
 *    since v2.9 (humanGate.ts:83) and that no caller had ever passed until
 *    this one: no owner-name third-person reference, professional register,
 *    because the reader is off-domain.
 *  - dateVerifier is MANDATORY here, not merely nice-to-have: a forwarded
 *    scheduling reply is almost entirely weekday-and-date claims, and this is
 *    the only check standing between a wrong weekday and an external inbox
 *    over the owner's own signature.
 *
 * Deliberately does NOT run the availability floor or the security gate.
 * The floor's ledger is armed only by the Slack-only `availabilityPreCheck`
 * (colleague path) and is empty here by construction — nothing to check. The
 * security gate's leak-scrub half assumes a Slack colleague (a
 * `people_memory` lookup keyed on a Slack sender id) that doesn't exist on
 * this leg, and its identity-spoof half exists to ask "is this SENDER
 * claiming to be someone else" — meaningless when the sender is already
 * gated to the owner. The structured-id / raw-token scrub it would otherwise
 * add is not lost: `EmailConnection.sendDirect` runs the SAME cross-cutting
 * `scrubInternalLeakage` (inside `formatForEmail`, its documented single
 * entry point) over whatever text this leg finally returns, gated or not —
 * exactly once, at send time. That is also why this leg's own rewrites are
 * NOT run through `formatForEmail` mid-pipeline the way Slack's are run
 * through `formatForSlack` — see `normalizeForTransport`'s doc comment for
 * why that would double-process the text.
 *
 * DOES run the slot-grounding check (2026-08-28 fix — this leg used to skip
 * it entirely, and that was never a decision, only an omission: the check
 * was built 2026-08-24, after this leg already existed, and nothing here
 * ever weighed it). Unlike the floor/security gate above, it is genuinely
 * reader-independent by its own placement on the Slack side (both legs' own
 * doc comment on it says so) — it reads this turn's own tool tape, not a
 * Slack-only ledger or a Slack sender id, and its rewrite already runs
 * through `normalizeForTransport`. A forwarded reply naming a specific time
 * as available when this turn's own search never confirmed it is the same
 * failure class the check exists for, on the one transport with no human
 * re-read before send (the owner forwards the text verbatim) — so this leg
 * needs it at least as much as Slack's does.
 *
 * Fails open at every step — same contract as every other leg in this file.
 */
async function runEmailLegGates(ctx: OutputGateContext, initialReply: string): Promise<string> {
  let cleanReply = initialReply;

  cleanReply = await runClaimCheckAndMaybeRewrite(ctx, cleanReply);
  cleanReply = await runSlotGroundingCheckAndMaybeRewrite(ctx, cleanReply);

  try {
    const { runHumanGate } = await import('../humanGate');
    // gh#175 — the email reply used to be two audiences in one string (a
    // PART 1 "FOR YOU" note for the owner, a literal cut line, then PART 2
    // the forwardable text). That's gone (owner's ruling, gh#175-a-instructor):
    // systemPrompt.ts no longer emits PART 1 or the cut line, so the whole
    // reply IS the forwardable text — one 'external' audience, same as any
    // other external-facing content.
    const verdict = await runHumanGate(cleanReply, ctx.profile, 'external', ctx.channelId);
    if (!verdict.ok && verdict.rewrite && verdict.rewrite.trim().length > 0) {
      cleanReply = normalizeForTransport(ctx, verdict.rewrite);
    }
  } catch (err) {
    logger.warn('humanGate (email leg) threw — leaving draft unchanged', { err: String(err).slice(0, 200) });
  }

  cleanReply = await runDateVerifierAndMaybeRetry(ctx, cleanReply);
  return cleanReply;
}

// ── Social-coda gate ────────────────────────────────────────────────────────

export interface CodaGateVerdict {
  /** True = post the coda EXACTLY as handed in. False = post nothing. */
  ship: boolean;
  /** Which check dropped it (for the caller's log). Null when ship=true. */
  droppedBy: string | null;
}

/**
 * The social coda's gate. Deliberately NOT `runOutputGates`.
 *
 * The coda is a one-line human aside Maelle posts on her OWN initiative, in its
 * own message, a beat after the reply already landed (postReply's
 * scheduleSocialCoda). It answers no question, states no date, claims no action
 * and carries none of the turn's tool activity — so most of the reply stack has
 * nothing to check, and several of its gates are actively HOSTILE to it:
 *
 *  - the claim-checker's remedy is rewriteOwningTheMiss, which on a false
 *    positive turns a social question into an apology about work;
 *  - and securityGate's identity-spoof branch triggers off `recentUserMessages`, NOT
 *    the draft, so it would hand the SAME refusal to the person twice.
 *
 * What DOES apply is the pair of checks that judge the text itself. Both run in
 * DETECT-ONLY form: this function's return type carries no text, so it is
 * structurally incapable of corrupting a correct coda (G5). The only action is
 * DROP, and dropping a social aside costs nothing — that asymmetry is what makes
 * an LLM verdict safe to act on here (G3: tool-less + miss-safe).
 *
 *  1. scanForLeaks — the HARD-IDENTIFIER half: raw Slack ids, req_/task_ ids,
 *     provider/model self-reference (Claude, GPT, Anthropic), JSON / tool-tag
 *     echoes, AND self_ai_claim* (4.5.6). Unlike the reply path, this call goes
 *     straight to `scanForLeaks` — never through `filterColleagueReply`, so the
 *     AI-identity trigger's conditional judge (recentUserMessages) never runs
 *     here, and a hit always drops. That is the right default for a coda: it
 *     answers no question, so there is no "was this genuinely asked" case to
 *     clear it, and it has none of the conversational context that judge would
 *     need anyway — a coda that ever claims AI/bot/human identity should never
 *     ship, full stop. Only the IDENTIFIER patterns here (raw Slack ids,
 *     req_/task_ ids) are structured and language-neutral (G8); the DISCLOSURE
 *     patterns (self_ai_claim*, self_internals, model leaks, JSON/tool-tag
 *     echoes) are English-only regex on natural language and miss the same
 *     claim in Hebrew or French. runHumanGate (step 2) runs unconditionally on
 *     every coda regardless of what this scan found, and is the
 *     language-agnostic backstop for that gap (no `aiDisclosureCleared` is
 *     ever passed on this path, so the exception never opens here and a bare
 *     disclosure is always treated as a violation) — bouncer testing
 *     (2026-08-14) proved this DIDN'T hold in practice: 0/4 casual-aside
 *     AI-disclosure claims in French/Spanish/German were caught, because
 *     runHumanGate's own prompt never actually said "a bare identity claim,
 *     with no infra vocabulary, is itself a violation" — only the
 *     infrastructure-framing rule existed, and a casual "en fait je suis une
 *     IA" trips none of it. Fixed 2026-08-18 (ledger:
 *     coda-ai-disclosure-non-english-gap): humanGate.ts's system prompt now
 *     states that rule explicitly and language-independently, so this is now
 *     a real backstop rather than an aspirational one. This scan is free, so it still runs
 *     first and a hit costs no LLM call. It is NOT redundant
 *     with the coda's inputs being "just a topic label": those labels and topic
 *     beats are free text Haiku derived from the DM transcript (social_subjects /
 *     social_topics), and each assistant turn in that transcript carries the raw
 *     `[tool …]` action tape (postReply's Step 3b) — deliberately unscrubbed, because
 *     textScrubber strips tool names and the claim-checker's truthful-recap shield
 *     reads `mutated=<domain>` out of exactly those markers. So a structured
 *     internal id CAN still reach the generator's prompt — the reply PROSE up there
 *     is post-gate now, the tape is not — and this is the check that stops it
 *     leaving.
 *  2. runHumanGate — the VOICE half, and the language-agnostic one, in the coda's
 *     audience frame ('owner' vs 'internal'). Kept because the coda is the ONE
 *     message Maelle sends unprompted, most often to a COLLEAGUE (5 of the 6
 *     codas in the 2026-07-20..25 logs), and its generator's only defence against
 *     a bot-tell or a third-person-owner slip is a line in its own prompt — which
 *     is not enforcement. Its `rewrite` is read for nothing; ok=false means DROP.
 *
 * Fails CLOSED (drop) — the inverse of the reply gates' fail-open contract, and
 * right for the same reason: a reply must always land, a social aside never has
 * to. Nothing here can throw into the caller.
 */
export async function runCodaGates(
  coda: string,
  ctx: { profile: UserProfile; role: SenderRole },
): Promise<CodaGateVerdict> {
  const text = coda.trim();
  if (text.length === 0) return { ship: false, droppedBy: 'empty' };

  try {
    const { scanForLeaks } = await import('../securityGate');
    const leaks = scanForLeaks(text);
    if (leaks.length > 0) return { ship: false, droppedBy: `leak:${leaks.join(',')}` };
  } catch (err) {
    logger.warn('Coda gate — leak scan unavailable; dropping the coda (fail closed)', {
      err: String(err).slice(0, 200),
    });
    return { ship: false, droppedBy: 'leak_scan_threw' };
  }

  try {
    const { runHumanGate } = await import('../humanGate');
    // Fail-closed on role, same convention as the reply stack: anything that is
    // not the authenticated owner gets the colleague-strict frame.
    const audience: HumanGateAudience = ctx.role === 'owner' ? 'owner' : 'internal';
    const verdict = await runHumanGate(text, ctx.profile, audience);
    // verdict.rewrite is deliberately IGNORED. A fact-preserving rewrite is the
    // right remedy for a reply that must land; for an optional social line the
    // rewrite is pure downside — it can only produce a stranger second message
    // (humanGate's own safeFallback would post "Let me look into this and come
    // back to you" as a standalone aside, 10s after the work was already done).
    if (!verdict.ok) return { ship: false, droppedBy: 'human_gate' };
  } catch (err) {
    logger.warn('Coda gate — voice check unavailable; dropping the coda (fail closed)', {
      err: String(err).slice(0, 200),
    });
    return { ship: false, droppedBy: 'human_gate_threw' };
  }

  return { ship: true, droppedBy: null };
}

// ── Internal gates ──────────────────────────────────────────────────────────

/**
 * v1.6.2 — replaces the old reply verifier. Strict JSON classifier detects
 * false action claims. v3.4 — on detection, the remedy is a single TOOL-LESS
 * rewrite that makes the draft honestly own the un-done action (see
 * rewriteOwningTheMiss). The old orchestrator re-run + force-message_colleague
 * path is GONE: it auto-fired tools on a possibly-wrong verdict (the Amazia
 * duplicate-send) and forced the matchingToolAlreadyRan shield to keep growing.
 * No tool can fire from here now, so a false claim can never become a
 * duplicate action — only an honest "that didn't go through yet".
 *
 * Fails open: verifier errors, JSON parse errors, rewrite errors — all leave
 * the original draft in place. Never blocks a reply.
 */
async function runClaimCheckAndMaybeRewrite(
  ctx: OutputGateContext,
  initialReply: string,
  approvalGrantContext?: { isResolved: boolean },
): Promise<string> {
  const { profile, result } = ctx;
  let cleanReply = initialReply;

  try {
    const { checkReplyClaims } = await import('../claimChecker');

    // v3.0.6 — claim-checker is owner-path RULE A only (false action claim).
    // Module F + E extended-rule inputs (priorAssistantReply, currentUserMessage,
    // imagesInTurn) were removed in the latency pass; honesty rules 1/2/2b/2c/2d
    // /3/5b/9 stay in the system prompt per v2.8.5.
    const verdict = await checkReplyClaims({
      reply: cleanReply,
      toolSummaries: result.toolSummaries ?? [],
      bookingOccurred: result.bookingOccurred ?? false,
      ownerFirstName: profile.user.name.split(' ')[0],
      // v1.7.5 — pass MPIM context so the checker recognizes legitimate
      // in-room @-mentions vs phantom sends to outsiders.
      mpimContext: ctx.isMpim
        ? { isMpim: true, participantSlackIds: ctx.mpimMemberIds ?? [] }
        : undefined,
      // v4.4.x (#154) — deterministic ground truth for the approval-granted
      // claim (see runOutputGates.ts caller + claimChecker.ts). Undefined on
      // every pre-existing call site (the owner-private leg's probe/serial
      // chain never pass it) — byte-identical there.
      approvalGrantContext,
    });

    // v3.0.6 — Module F + E booleans were fully removed from the checker
    // (advisory-only since v2.8.5; cost ~5s of Sonnet on every owner turn for
    // a verdict no caller acted on). Honesty rules 1/2/2b/2c/2d/3/5b/9 stay
    // in the system prompt. Only RULE A (claimed_action — false action claim)
    // drives retries from here.
    if (!verdict.claimed_action) return cleanReply;

    // v1.7.4 — defense in depth. The claim-checker can false-positive (saw
    // it happen with "the message is on its way" being flagged even when
    // message_colleague ran). If the matching tool clearly DID run this turn,
    // the claim was honest — skip. v3.4: this shield no longer guards a
    // tool-re-firing retry (that's gone); it now prevents the own-the-miss
    // rewrite from corrupting an HONEST reply into a false "that didn't go
    // through" claim when the action actually DID happen.
    // v3.4.x (#recap, 2026-06-24) — the shield must see PRIOR turns, not just
    // this one. A TRUTHFUL recap of an action done last turn ("Yael moved to
    // 11:30 ✓") has no CURRENT-turn tool, so a current-turn-only check flagged
    // it and own-the-miss NEGATED a true statement (the crash-recovery recap).
    // The reply pipeline saves each turn's `[tool OK ...]` markers into the
    // assistant's conversation content (postReply's Step 3b — and it stores
    // them RAW for this reason: formatForSlack would strip the tool names this
    // shield matches on), so the matching tool's marker is in ctx.history — scan it
    // too. Over-suppressing a genuinely-phantom claim in a thread where a similar
    // tool ran earlier is a safe MISS (G5); denying real work is not.
    const priorAssistantText = (ctx.history ?? [])
      .filter(h => h.role === 'assistant')
      .map(h => h.content)
      .join(' ');
    const toolSummariesText = [(result.toolSummaries ?? []).join(' '), priorAssistantText].join(' ');

    // v4.1.x (G1/G2) — READ the carried marker; do not re-derive it.
    //
    // This used to be four action_type branches over a 5-tool, a 2-tool and a
    // 14-tool name alternation, each one added after a distinct incident, and each
    // new mutating tool anywhere in the codebase had to be remembered here or the
    // guard would manufacture a false phantom-action flag. That is the exact
    // maintenance shape G1 exists to prevent, and it was the guard GUESSING at a
    // fact the tool layer already knew.
    //
    // summarizeToolCall now stamps `mutated=<domain>` on every call that actually
    // changed state, using the claim-checker's own action_type vocabulary — so the
    // shield is one field lookup and knows nothing about tool names. The marker is
    // OK-only by construction, which also closes a hole the name-matching had: the
    // old `book`/`task` alternations matched the tool-name PREFIX and so suppressed
    // the honesty rewrite even on `[create_meeting FAILED: …]`. A failed mutation
    // now correctly backs nothing (the same #137b convention the rest of the tool
    // log already follows).
    const mutationCarried = !!verdict.action_type
      && toolSummariesText.includes(`mutated=${verdict.action_type}`);

    // The one class where WHO matters: a DM sent to Yael does not make "already
    // flagged it to Simon" honest. The recipient is already in the summary
    // (`[message_colleague: <name>]`), so this reads existing data — it is not a
    // second list. A SKIPPED relay (`[message_colleague] <id> — … skipped`, pushed
    // straight to the tape by the orchestrator's idempotency guards) never carries
    // the marker, so it can no longer back a "sent it" claim either.
    const targetMatches = verdict.action_type !== 'message'
      || !verdict.target_name
      || toolSummariesText.toLowerCase().includes(verdict.target_name.toLowerCase());

    const matchingToolAlreadyRan = mutationCarried && targetMatches;

    // v2.6.1 — when the claim-checker LLM has named a SPECIFIC change the
    // tool that ran doesn't cover (e.g. "updated to 25 min" claim while only
    // `move_meeting` ran — start changed, duration didn't), bypass the
    // false-positive shield. The shield's coarse "any matching tool ran =
    // honest" was masking real specifics-mismatch claims (warn observed
    // 2026-05-06, draft said "updated to 25 min" with only [move_meeting OK]
    // in tool activity). When the LLM has explicitly identified the field
    // mismatch, trust the verdict — let the retry fire. Retry already carries
    // this turn's tool summaries (v2.3.4) so no duplicate-mutation risk.
    if (matchingToolAlreadyRan && !verdict.claim_specifics_mismatch) {
      // v3.8.x — accurate reason: matchingToolAlreadyRan scans THIS turn's
      // summaries AND prior-turn markers (the #recap shield). When NO tool ran
      // this turn, the match came from a prior turn — a truthful recap of an
      // earlier action (e.g. an active-mode auto-fix), NOT something that "ran
      // this turn". Say which, so the log doesn't contradict an empty tape.
      const viaPriorRecap = (result.toolSummaries ?? []).length === 0;
      logger.warn(viaPriorRecap
        ? 'Claim-checker flagged but a matching tool ran in a PRIOR turn (truthful recap) — skipping rewrite (false positive)'
        : 'Claim-checker flagged but matching tool already ran this turn — skipping rewrite (false positive)', {
        senderId: ctx.senderId,
        threadTs: ctx.threadTs,
        action_type: verdict.action_type,
        target_name: verdict.target_name,
        toolSummaries: result.toolSummaries,
        viaPriorRecap,
      });
      return cleanReply;
    }
    if (matchingToolAlreadyRan && verdict.claim_specifics_mismatch) {
      logger.warn('Claim-checker shield bypassed — specifics mismatch identified, rewrite will fire', {
        senderId: ctx.senderId,
        threadTs: ctx.threadTs,
        action_type: verdict.action_type,
        target_name: verdict.target_name,
        action_summary: verdict.action_summary,
        toolSummaries: result.toolSummaries,
      });
    }

    // o#224 / gh#154-R5 — permission_granted's ground truth (anyRequestResolvedForThread)
    // is thread-scoped, not bound to the SPECIFIC request row a sentence is
    // about — a thread carrying 2+ requests can have an approved OLDER request
    // and a still-pending NEWER one, and nothing here can tell which one a
    // given claim refers to. That is exactly why "any request in this thread
    // was EVER resolved" (not the latest row's state alone) is the binding: a
    // true grant about an older resolved row must never be inverted, so when
    // isResolved is true we NEVER rewrite here, full stop — a safe miss if the
    // checker somehow still flagged it, never a corrupted reply (G5).
    // Only when isResolved is false (no request in this thread was EVER
    // resolved — the claim can only be describing a still-open or rejected
    // escalation) is a declarative "he approved it" provably false, and the
    // catch is restored: route through the same tool-less own-the-miss
    // rewrite every other false-action claim uses (owner ruling 2026-08-06).
    if (verdict.action_type === 'permission_granted') {
      // Defensive: this action_type is only meant to fire when the checker was
      // handed ground truth (approvalGrantContext), since its prompt's whole
      // CRITICAL section is conditioned on the APPROVAL STATUS block being
      // present. An undefined context here means either that block was absent
      // (the model mis-classified) or the ground truth couldn't be read — in
      // both cases we have no thread-scoped truth to bind a rewrite to, so
      // stay on the pre-existing detect-and-log-only behavior: a safe miss,
      // never a guess.
      if (!approvalGrantContext || approvalGrantContext.isResolved) {
        logger.warn('Claim-checker flagged a permission_granted claim with no safe ground truth to rewrite against — safe-miss, keeping draft', {
          senderId: ctx.senderId,
          threadTs: ctx.threadTs,
          target_name: verdict.target_name,
          action_summary: verdict.action_summary,
          hadApprovalGrantContext: !!approvalGrantContext,
        });
        return cleanReply;
      }

      logger.warn('Claim-checker: false permission_granted claim on a thread with no resolved request — rewriting to own the miss (no tool re-fire)', {
        senderId: ctx.senderId,
        threadTs: ctx.threadTs,
        target_name: verdict.target_name,
        action_summary: verdict.action_summary,
      });
      try {
        const { rewriteOwningTheMiss } = await import('../claimChecker');
        const rewritten = await rewriteOwningTheMiss({
          draft: cleanReply,
          actionSummary: verdict.action_summary,
          actionType: verdict.action_type,
          targetName: verdict.target_name,
          ownerFirstName: profile.user.name.split(' ')[0],
          toolSummaries: result.toolSummaries ?? [],
        });
        if (rewritten && rewritten.trim().length > 0) {
          return formatForSlack(rewritten);
        }
      } catch (err) {
        logger.warn('rewriteOwningTheMiss threw for a permission_granted claim — keeping original draft', {
          senderId: ctx.senderId, threadTs: ctx.threadTs, err: String(err).slice(0, 200),
        });
      }
      return cleanReply;
    }

    // v3.4 — confirmed false claim. DO NOT re-run the orchestrator or re-fire
    // a tool. The old retry (with forceToolOnFirstTurn=message_colleague)
    // auto-sent on a possibly-wrong verdict and caused the Amazia duplicate
    // DM — the whole reason the matchingToolAlreadyRan shield had to keep
    // growing. Instead, a single TOOL-LESS rewrite re-renders the prose so it
    // HONESTLY owns the miss and makes the non-completion visible to the
    // owner (so he can nudge). Tool-less ⇒ it can never duplicate an action.
    // Fails open: rewrite null/empty → keep the original draft.
    logger.warn('Claim-checker: false claim — rewriting to own the miss (no tool re-fire)', {
      senderId: ctx.senderId,
      threadTs: ctx.threadTs,
      action_type: verdict.action_type,
      target_name: verdict.target_name,
      action_summary: verdict.action_summary,
    });

    try {
      const { rewriteOwningTheMiss } = await import('../claimChecker');
      const rewritten = await rewriteOwningTheMiss({
        draft: cleanReply,
        actionSummary: verdict.action_summary,
        actionType: verdict.action_type,
        targetName: verdict.target_name,
        ownerFirstName: profile.user.name.split(' ')[0],
        // v3.7.x — the rewriter must verify against the same tool activity
        // the checker read, so it can't invert a true completed action it can't see.
        // o#224 — no approvalGrantContext here: permission_granted claims
        // return above and never reach this call (see the block above).
        toolSummaries: result.toolSummaries ?? [],
      });
      // v4.2.x — no history write here any more. This used to append the honest
      // version so the next turn wouldn't act on the dishonest draft, because the
      // record was written one line ABOVE the gate stack and the correction had to
      // chase it. postReply persists ONCE, after the gates (its Step 3b), so
      // the honest text is simply what gets stored — and this append had become a
      // duplicate row, spending one of the 20 the blob keeps to say the same thing
      // twice. The rewrite is still made visible to the owner where it always was:
      // the warn above.
      if (rewritten && rewritten.trim().length > 0) {
        cleanReply = normalizeForTransport(ctx, rewritten);

        // gh#194-b-promised-resend-never-fired (2026-08-10, owner ruling:
        // "if she is saying that she will do a follow up or reminder, she
        // needs to do it") — an honest confession is still just words. Proven
        // incident (req_1786281967442_i5xm1, 2026-08-09): Yael asked Maelle to
        // relay urgency to Idan; the false "I forwarded it to him" claim got
        // caught and rewritten honest, but nothing then made the relay
        // actually happen — it rode on the model's memory next turn.
        //
        // Backstop: reuse the SAME durable reminder spine registrar's
        // flagUnresolvedFreeformForOwner (src/tasks/skill.ts) uses for the
        // identical shape — a colleague-raised ask the owner must see, opened
        // on the ONE requests spine and delivered immediately via
        // postOwnerDecision (a bounded runner retry only on genuine delivery
        // failure — chris-kelley-oof-block-b/c, 2026-08-18), regardless
        // of what the model does this turn or how the confession is phrased.
        // Firing unconditionally (not gated on the rewrite's wording) is
        // deliberate: whether the honest text says "that hasn't gone out
        // yet" or "let me flag this to him", the owner's point is the same —
        // the relay must land either way, so making the guarantee depend on
        // phrasing would just move the gap rather than close it.
        //
        // Scope is deliberately the proven incident, not "every false claim":
        //   - action_type==='message' — a claimed relay/send. A book/task
        //     claim has no deterministic, safe-to-replay "what" to backstop.
        //   - the ACTOR is a real colleague, in a real 1:1 DM, never the owner
        //     and never a room with more than one reader.
        // The relayed content is the colleague's OWN turn text
        // (ctx.userMessage) — deterministic, not an LLM paraphrase — the same
        // flagText shape flagUnresolvedFreeformForOwner uses.
        //
        // gh#194-b-promised-resend-never-fired (2026-08-10, bouncer overturn) —
        // this function (runClaimCheckAndMaybeRewrite) has THREE call sites —
        // the owner-private leg (:346), the colleague-readable leg gated by
        // `ownerIsActing || approvalGrantContext` (:440), and the email leg,
        // unconditional (:709, `runEmailLegGates`) — and the previous version of
        // this comment asserted only the second was "colleague-reachable". That
        // was the bug: the CALLER's gate at :440 restricts real colleague turns
        // correctly, but this check runs from ALL THREE sites and cannot rely on
        // caller-side scoping to know which one it's in — it must derive "real
        // colleague, real 1:1 DM" itself, from ctx, every time:
        //   - EMAIL LEG excluded by transport: `inbound.ts:342` passes
        //     `senderId: from`, an email address, which is trivially never equal
        //     to a Slack id — so `senderId !== slack_user_id` was ALWAYS true on
        //     that leg regardless of who actually sent it, and runEmailLegGates'
        //     own doc says every draft there IS the owner's own turn (the
        //     inbound sender gate restricts the whole leg to the owner + his
        //     aliases) — there is no colleague-relay shape on this leg at all.
        //   - CHANNEL excluded explicitly: `!ctx.isMpim` excluded a group DM but
        //     not a real channel — the exact "more than the owner can read this"
        //     case this backstop must never write a DM-shaped `reminder` row
        //     for. `isChannel` is now threaded onto OutputGateContext
        //     (postReply.ts) so this can check it directly.
        //   - Owner's own Slack turn still excluded by `senderId !==
        //     slack_user_id` (the owner-private leg, and the owner acting inside
        //     a group DM/channel at :440, both fail this).
        const isRealColleagueOneOnOneDm = ctx.transport !== 'email'
          && ctx.senderId !== profile.user.slack_user_id
          && !ctx.isMpim
          && !ctx.isChannel;

        // gh#194-b-promised-resend-never-fired (fix, 2026-08-10, bouncer
        // finding) — this backstop is scoped (see the block comment above) to
        // a false claim of relaying TO THE OWNER — "I told him" — never to a
        // third party. Without this check, a colleague DM asking Maelle to
        // relay something to someone ELSE ("tell Michal…") that ships a false
        // send claim opened a reminder that fabricates words the colleague
        // never said ("<X> asked me to pass this to you") AND never
        // surfaces the actual undelivered message. `verdict.target_name`
        // (claimChecker.ts:270, already read above at :953-954 for the
        // shield check) names whoever the draft claims it messaged —
        // comparing it against the owner's own name is the deterministic
        // gate. No match (name absent, or names someone else) is a safe MISS
        // — no reminder opens, same as before this backstop existed — never
        // a reminder that puts the wrong words in the wrong mouth.
        // v4.7.4 fix — this used to be `ownerFullNameLower.includes(target)`,
        // a SUBSTRING test that false-matches any target string that happens
        // to be a substring of either name part: owner "Idan Cohen", target
        // "Dan" → "idan cohen".includes("dan") → true, and "Cohen" alone
        // matches too. A colleague DM ("tell Dan the demo moved") about a
        // THIRD PARTY who merely shares letters with the owner's name then
        // false-fires this backstop: a spurious owner-flag DM putting words
        // in the owner's mouth, over a message that was never about him.
        // Exact token match against the owner's own name parts closes this —
        // the owner's name is never legitimately a partial string of itself.
        const ownerNameTokensLower = profile.user.name.toLowerCase().split(/\s+/).filter(Boolean);
        const targetIsOwner = !!verdict.target_name
          && ownerNameTokensLower.includes(verdict.target_name.toLowerCase());
        if (verdict.action_type === 'message' && isRealColleagueOneOnOneDm && !targetIsOwner) {
          logger.info('claim_checker_rewrite — false relay claim named a target other than the owner, skipping the backstop reminder (safe miss)', {
            senderId: ctx.senderId, threadTs: ctx.threadTs, target_name: verdict.target_name,
          });
        }

        if (verdict.action_type === 'message' && isRealColleagueOneOnOneDm && targetIsOwner) {
          try {
            const { buildIdempotencyKey, getRequestByIdempotencyKey } = await import('../../db/requests');
            const { getPersonMemory } = await import('../../db');
            const ownerUserId = profile.user.slack_user_id;
            const requesterFirst = (getPersonMemory(ctx.senderId)?.name ?? 'A colleague').split(' ')[0];
            const idempotencyKey = buildIdempotencyKey({
              ownerUserId,
              requesterSlackId: ctx.senderId,
              kind: 'reminder',
              subject: `claim_checker_relay_backstop ${ctx.threadTs} ${ctx.userMessage}`,
            });
            if (!getRequestByIdempotencyKey(idempotencyKey)) {
              const flagMessage = `${requesterFirst} asked me to pass this along and I couldn't confirm it actually went through, so flagging it directly: "${ctx.userMessage}"`;

              // chris-kelley-oof-block-b/c (2026-08-18) — deliver NOW, the same
              // immediate postOwnerDecision path the identical-shape sibling
              // backstop (flagUnresolvedFreeformForOwner, src/tasks/skill.ts)
              // uses, never a workTimeBaseFromNow/reminder_fire timer: that
              // shape is exactly the deferred-past-vacation bug the owner ruled on
              // ("approval flow is always approval, nothing should block people to
              // raise alarm as ask for approval") — an unconfirmed "I told him"
              // claim raised during a declared away period must reach him
              // immediately, not wait for the away period to end. Shared shape
              // AND, as of 2026-08-19 (o#249, bouncer finding
              // `freeform-owner-flag-delivery-duplicated-across-two-lanes`),
              // shared code: the send-then-persist mechanics live in
              // `deliverAndRecordOwnerFlag` (src/utils/ownerDailyThread.ts,
              // Handyman's connective-plumbing file) so this lane and
              // Registrar's no longer carry two copies of the same ~50 lines.

              const shared = {
                ownerUserId,
                initiatedBy: ctx.senderId,
                initiatedByRole: 'colleague' as const,
                kind: 'reminder' as const,
                // subkind is this backstop's own value, distinct from its sibling
                // flagUnresolvedFreeformForOwner's (src/tasks/skill.ts, subkind
                // 'freeform_owner_ask' as of chris-kelley-oof-block-c round 3,
                // 2026-08-18 — split apart once the shared value proved not unique
                // enough for that sibling's own dedup lookup to tell the two backstops'
                // rows apart). The two now share only the pending-cap exclusion:
                // getPendingRequestCountForColleague (src/db/jobs.ts:92) excludes
                // kind='reminder' AND subkind IN ('freeform_owner_flag',
                // 'freeform_owner_ask') from the colleague's pending-cap count. This row is a durable backstop DM to
                // the OWNER, not a tracked item the colleague asked for — without this it silently
                // spends one of their two pending slots (bouncer fix,
                // gh#194-b-promised-resend-never-fired x pending-cap-blocks-unrelated-questions,
                // 2026-08-10): two false-relay claims from one colleague would consume both slots
                // and their next genuine create_task/create_approval gets refused.
                subkind: 'freeform_owner_flag',
                subject: `Needs your read: ${requesterFirst} asked me to pass this to you`,
                description: ctx.userMessage,
                informed: 1,
                requesterSlackId: ctx.senderId,
                requesterName: requesterFirst,
                originChannel: ctx.channelId,
                originThreadTs: ctx.threadTs,
                originIsMpim: false,
                idempotencyKey,
              };

              // Send + persist (born 'logged' on confirmed delivery, 'in_flight'
              // with a bounded 5m retry — runFreeformFlagRetry, src/core/
              // requests/runner.ts — on genuine failure) is the shared helper;
              // see its doc comment for why both backstops need it identically.
              const { deliverAndRecordOwnerFlag } = await import('../ownerDailyThread');
              const posted = await deliverAndRecordOwnerFlag({
                profile,
                ownerUserId,
                flagMessage,
                label: 'claim-checker relay backstop',
                messages: {
                  dmFailed: 'claim_checker_rewrite — relay-to-owner backstop DM failed',
                  noConnection: 'claim_checker_rewrite — no Slack connection registered for relay backstop',
                  threw: 'claim_checker_rewrite — relay-to-owner backstop DM threw',
                },
                dmFailedExtra: { requesterSlackId: ctx.senderId, threadTs: ctx.threadTs },
                shared,
              });
              if (posted.ok) {
                logger.info('claim_checker_rewrite — delivered relay-to-owner backstop immediately', {
                  ownerUserId, requesterSlackId: ctx.senderId, threadTs: ctx.threadTs,
                });
              } else {
                logger.info('claim_checker_rewrite — relay-to-owner backstop delivery failed, armed short retry', {
                  ownerUserId, requesterSlackId: ctx.senderId, threadTs: ctx.threadTs,
                });
              }
            }
          } catch (backstopErr) {
            logger.warn('claim_checker_rewrite — failed to open the relay-to-owner backstop reminder', {
              err: String(backstopErr).slice(0, 200),
            });
          }
        }
      }
    } catch (rwErr) {
      logger.warn('Claim-checker rewrite errored — keeping original draft', { err: String(rwErr) });
    }
  } catch (err) {
    logger.warn('Claim-checker threw — sending original reply', { err: String(err) });
  }
  return cleanReply;
}

/**
 * bounce-fix (2026-08-26) — the SAME thread-history snippet Maelle drafted
 * from (`ctx.history`), capped (last 12 turns, 220 chars each) to bound
 * prompt size on checks that run every colleague-readable turn (G10). One
 * canonical builder (G9) shared by 'owner_fact' mode (an invented personal
 * fact may be something the owner said himself earlier) and 'slot_grounding'
 * mode (a time this thread already confirmed via a REAL search in an
 * EARLIER turn stays grounded even when THIS turn's own search result
 * doesn't repeat it) — was hand-copied per call site before this fix.
 *
 * o#259 (2026-08-28) — an assistant row is stored as
 * `toolSummaries.join(' ') + '\n' + replyText` ONLY when there were tool
 * summaries that turn (postReply.ts:532-536) — a no-tool-call turn stores
 * `cleanReply` alone, with NO tape and no synthetic `\n` prefix. Tool tape
 * deliberately RAW and prepended (the claim-checker's `mutated=<domain>`
 * shield reads it later — never touch that storage format). Slicing 220
 * chars from the FRONT of that string can burn the whole budget on a verbose
 * tool summary and leave none for the actual reply prose grounding needs to
 * see. Skip past the tool-tape prefix before slicing an assistant row — but
 * the first fix here (splitting on the first `\n` unconditionally) assumed
 * every assistant row's first `\n` was that separator, when a tool-less row
 * is just `cleanReply` and Slack replies are routinely multi-line: it
 * silently dropped the real first line of every such row.
 *
 * Detect tape STRUCTURALLY instead: every tool-summary entry
 * (`summarizeToolCall`/`summarizeInternalAction`, turnHelpers.ts:155,189)
 * is bracket-wrapped (`[tool ...]` or `[tool FAILED: ...]`), optionally
 * followed by ` mutated=<domain>`, and multiple entries are space-joined —
 * so the pre-`\n` segment of a REAL tape always starts with `[` and contains
 * a `]` before that newline. A row with no tool tape at all (no leading
 * `[...]`) keeps its full content, first line included.
 */
function buildRecentHistorySnippet(ctx: OutputGateContext): string | undefined {
  const { profile } = ctx;
  return (ctx.history ?? [])
    .slice(-12)
    .map(h => {
      const raw = h.content ?? '';
      const nl = raw.indexOf('\n');
      const preNl = nl === -1 ? '' : raw.slice(0, nl);
      const hasToolTape = h.role === 'assistant' && /^\[.*\]/.test(preNl);
      const text = hasToolTape ? raw.slice(nl + 1) : raw;
      return `${h.role === 'assistant' ? profile.assistant.name : 'User'}: ${text.slice(0, 220)}`;
    })
    .join('\n') || undefined;
}

/**
 * owner-personal-fact-fabricated-in-colleague-reply (2026-08-14) — colleague-
 * readable-only check: extends the invented-fact pattern (previously
 * coda-mode only, verified against a snapshot of what we know about the
 * RECIPIENT — src/core/social/generateCoda.ts) to a confidently-stated,
 * ungrounded PERSONAL/CAPABILITY claim about the OWNER himself, landing in
 * front of a colleague ("a phone call from the car works for him", asserted
 * with zero tool calls and zero grounding anywhere — the proven incident).
 *
 * Runs on EVERY colleague-readable turn regardless of who is acting — see
 * this file's call site for why that is deliberately independent of RULE A's
 * own ownerIsActing/approvalGrantContext scoping. Uses claimChecker's
 * dedicated 'owner_fact' mode (its own small prompt, same JSON shape and
 * `invented_fact` action_type coda mode already established) rather than a
 * clause inside RULE A's 'action' prompt — G1: this keeps RULE A's own,
 * separately-reasoned scoping untouched by this fix.
 *
 * Remedy reuses rewriteOwningTheMiss's tool-less, Sonnet-veto, fail-open
 * machinery (G1 — reuse, don't add a parallel rewriter): a fact-preserving
 * rewrite that hedges or drops the specific unfounded claim, never a
 * confession framing ("that didn't go through") that would make no sense for
 * a stated fact rather than an un-done action.
 *
 * Bouncer retry (2026-08-14) fixed three things: (1) the checker now gets
 * `recentHistorySnippet` — the SAME `ctx.history` Maelle drafted from — so a
 * fact the owner himself stated earlier in this visible thread reads as
 * grounded, not invented (see claimChecker.ts's field doc); (2) the fallback
 * (when the model's own rewrite can't be trusted) now tries a minimal,
 * verbatim-except-the-claim redaction before ever falling back to a
 * full-reply-replacing generic hedge, so one bad clause no longer costs the
 * whole otherwise-true reply; (3) that last-resort hedge carries no
 * follow-up promise and is no longer English-only (claimChecker.ts's
 * `genericHonestHedge`).
 *
 * Fails open: verifier errors, JSON parse errors, rewrite errors all leave
 * the original draft in place — never blocks a reply.
 */
async function runOwnerFactCheckAndMaybeRewrite(
  ctx: OutputGateContext,
  initialReply: string,
): Promise<string> {
  const { profile, result } = ctx;
  let cleanReply = initialReply;

  try {
    const { checkReplyClaims, rewriteOwningTheMiss } = await import('../claimChecker');

    // owner-personal-fact-fabricated-in-colleague-reply (2026-08-14, bouncer
    // retry) — ground truth the check needs beyond "did a tool run": the SAME
    // history array the orchestrator handed Maelle when she drafted this
    // reply, so "he can take a car call" reads as grounded when the owner
    // said exactly that three turns earlier in this same thread, and only as
    // invented when it has no such origin anywhere. See claimChecker.ts's
    // `recentHistorySnippet` doc comment; builder shared with 'slot_grounding'
    // mode below (G9).
    const recentHistorySnippet = buildRecentHistorySnippet(ctx);

    const verdict = await checkReplyClaims({
      reply: cleanReply,
      toolSummaries: result.toolSummaries ?? [],
      bookingOccurred: result.bookingOccurred ?? false,
      ownerFirstName: profile.user.name.split(' ')[0],
      mode: 'owner_fact',
      recentHistorySnippet,
    });

    if (!verdict.claimed_action) return cleanReply;

    logger.warn('Owner-fact check: invented personal fact about the owner in a colleague-facing reply — rewriting to hedge/drop it (no tool re-fire)', {
      senderId: ctx.senderId,
      threadTs: ctx.threadTs,
      action_summary: verdict.action_summary,
    });

    const rewritten = await rewriteOwningTheMiss({
      draft: cleanReply,
      actionSummary: verdict.action_summary,
      actionType: verdict.action_type,
      targetName: verdict.target_name,
      ownerFirstName: profile.user.name.split(' ')[0],
      toolSummaries: result.toolSummaries ?? [],
    });
    if (rewritten && rewritten.trim().length > 0) {
      cleanReply = normalizeForTransport(ctx, rewritten);
    }
  } catch (err) {
    logger.warn('Owner-fact check threw — leaving draft unchanged', { err: String(err).slice(0, 200) });
  }

  return cleanReply;
}

/**
 * The availability floor's POLICY half (the primitives live in
 * utils/availabilityGate). Three deterministic conditions decide whether the
 * detector runs at all, and each one is free:
 *
 *  1. There is at least one still-fresh slot that `checkSlot` established as hard-
 *     blocked for this owner. Empty ledger ⇒ return immediately — which is every
 *     turn that never asked about a specific time, i.e. almost all of them.
 *  2. NO calendar mutation ran this turn. This is the false-fire that would matter:
 *     the owner says "book it anyway", create_meeting fires, the draft truthfully
 *     says "booked Tuesday 11:30" — and a ledger entry from two minutes ago still
 *     says that instant is blocked. Correcting a true confirmation is exactly the
 *     G5 corruption this guard must never commit, so a changed calendar stands the
 *     floor down entirely. Read off the carried `mutated=` marker
 *     (summarizeToolCall) and `bookingOccurred`, not a tool-name list (G2).
 *  3. There is a draft to check.
 *
 * Then ONE Haiku classification; on a flag, a live re-verification of each
 * affirmed slot (fresh `checkSlot`, fresh calendar read — the entry can be up to
 * TTL_MS old) drops anything that no longer checks out, and only what survives
 * that gets the Sonnet rewrite. Fails open at every step — any error in Haiku
 * classification, any veto, any keep verdict ships the draft it was handed.
 * One deliberate exception (o#189): a live re-check that CANNOT run (a throw —
 * Graph outage, etc.) is not evidence the slot cleared, so it stays confirmed
 * rather than being silently dropped — clearing a real established fact on a
 * mere outage, and shipping the draft's false "available" claim uncorrected,
 * is the worse failure this floor exists to prevent.
 *
 * STORED OWNER-LOCAL, RENDERED PER READER — the entries are rendered for this turn's
 * reader before either LLM sees them. The ledger is keyed by owner and read across
 * threads, so it stores the owner's clock only; "the same instant where THEY are"
 * is a fact about whoever is being answered right now, and baking it in at record
 * time listed a Brussels clock to a colleague in New York — as a number the
 * rewriter is explicitly told to preserve.
 */
/**
 * Shared by the availability floor and the slot-grounding check (both below):
 * "did a calendar mutation actually complete THIS turn" — a real booking/move
 * is its own, stronger ground truth than either check's own subject (an
 * established block, a grounded search result), so both stand down rather
 * than risk contradicting a true completed action. Was two hand-typed
 * copies of the identical one-liner (G9) — extracted so the two call sites
 * can't silently drift about what "completed" means.
 */
function calendarMutationCompleted(result: OrchestratorOutput): boolean {
  return result.bookingOccurred === true
    || (result.toolSummaries ?? []).join(' ').includes('mutated=book');
}

async function runAvailabilityFloorAndMaybeRewrite(ctx: OutputGateContext, initialReply: string): Promise<string> {
  const { profile, result } = ctx;
  if (!initialReply || initialReply.trim().length === 0) return initialReply;

  try {
    const {
      freshHardBlockedSlots, detectAffirmedBlockedSlots, rewriteBlockedSlotClaim,
      forgetHardBlockedSlot, clearHardBlockedSlots, displayForAsker, armsHardFloor,
    } = await import('../availabilityGate');

    const stored = freshHardBlockedSlots(profile.user.email);
    if (stored.length === 0) return initialReply;

    if (calendarMutationCompleted(result)) {
      // CLEAR, don't merely stand down. Standing down protected this turn and
      // left every entry armed for the next one, so "move that clash to 15:00" →
      // (next turn) "so 11:30 is open now?" came back as a confident false refusal.
      // A move vacates one slot and fills another, so no entry survives a completed
      // mutation; the pre-check re-derives what is still true on the next question.
      clearHardBlockedSlots(profile.user.email);
      logger.info('Availability floor — a calendar mutation completed this turn; cleared the established blocks (they are no longer known-good)', {
        senderId: ctx.senderId, threadTs: ctx.threadTs, clearedCount: stored.length,
      });
      return initialReply;
    }

    // The asker's zone for THIS turn, off the AUTHENTICATED sender and out of the
    // same people-store field the pre-check reads when it builds the drafting block
    // (buildTurnContext.ts:667) — so the two surfaces name a moment in the same clock.
    // Below the mutation check on purpose: a turn that already stood the floor down
    // pays for nothing. Absent zone, the owner's own turn, or an unusable value all
    // leave the stored owner-local rendering untouched.
    const { getPersonMemory } = await import('../../db');
    const askerTz = getPersonMemory(ctx.senderId)?.timezone ?? undefined;
    const blocks = stored.map(b => ({
      ...b, display: displayForAsker(b, profile.user.timezone, askerTz),
    }));

    const affirmed = await detectAffirmedBlockedSlots(
      initialReply, blocks, profile.user.name.split(' ')[0], profile.user.timezone,
    );
    if (affirmed.length === 0) return initialReply;

    // Live re-verification — the rare path. Per availabilityGate.ts's own header
    // (this guard's record of truth, not a copy kept here): 0 catches, 4 false
    // fires as of 2026-08-24 — none of them yet the staleness class this rule
    // exists for ("the fact stopped being true between record and fire, with no
    // Maelle mutation to trigger an invalidation rule", e.g. someone else moved or
    // cancelled directly in Outlook); all four so far were bad input or over-match
    // at DETECTION time, closed or still open there, not here. The ledger entry can
    // be up to TTL_MS (45min) old, so this rule stays as the last live check before
    // the destructive rewrite regardless. Re-run the SAME
    // validator `checkSlot` that established the entry, on a FRESH live calendar
    // read, immediately before the destructive rewrite — the last possible moment
    // to catch a stale fact rather than ship a corrected reply that corrects nothing.
    // Any slot the checkSlot call actually RAN and found no longer blocked is
    // dropped and forgotten rather than rewritten (G5 — a safe miss, never a
    // corruption of a now-true reply). A recheck that could not run at all
    // (below) is a different case and does not drop the entry — see its catch.
    const stillBlocked: typeof affirmed = [];
    for (const s of affirmed) {
      let confirmed = false;
      try {
        const { checkSlot, bookingLeadTimeHours } = await import('../scheduleRules');
        const { getOwnerEventsForDecision } = await import('../../connectors/graph/calendar');
        const datePart = s.instantIso.slice(0, 10);
        const events = await getOwnerEventsForDecision(
          profile.user.email, `${datePart}T00:00:00`, `${datePart}T23:59:59`, profile.user.timezone,
        );
        // Re-probe at the SAME length the producer used to establish this entry
        // (`s.durationMin` — availabilityPreCheck's snapped ask, or the smallest
        // allowed duration for a gap query's "nothing fits" verdict; see
        // availabilityGate.ts's HardBlockedSlot doc). o#189: an unconditional
        // smallest-allowed-duration probe does not reproduce a block a longer ask
        // only trips on a TAIL overlap, so a 50-minute ask's established block
        // silently cleared under a 25-minute probe.
        const probeMinutes = s.durationMin;
        const startMs = Date.parse(s.instantIso);
        const verdict = checkSlot({
          profile,
          slotStartIso: s.instantIso,
          slotEndIso: new Date(startMs + probeMinutes * 60000).toISOString(),
          category: null,
          events,
          // Same shape the producer used to establish this entry
          // (availabilityPreCheck.ts) — colleague lead time, masked subject.
          leadTimeHours: bookingLeadTimeHours(profile, 'colleague'),
          viewer: 'other',
        });
        confirmed = armsHardFloor(verdict.violation_kind);
      } catch (reErr) {
        // o#189 — a throw here (Graph outage, etc.) means we COULD NOT CHECK; it
        // is not proof the slot cleared. Treating it as cleared would delete a
        // real, previously-established fact off a mere outage and ship the
        // draft's false "available" claim uncorrected — the exact failure this
        // floor exists to prevent. So an unreadable recheck keeps the prior
        // established fact: stay confirmed (the entry survives, and gets rewritten
        // same as any other still-blocked slot).
        logger.warn('Availability floor — live re-check threw; could not verify, keeping the established block rather than risk a false-clear', {
          instantIso: s.instantIso, err: String(reErr).slice(0, 200),
        });
        confirmed = true;
      }
      if (confirmed) {
        stillBlocked.push(s);
      } else {
        forgetHardBlockedSlot(profile.user.email, s.instantIso);
        logger.info('Availability floor — live re-check found this instant no longer hard-blocked; dropped without rewriting', {
          senderId: ctx.senderId, threadTs: ctx.threadTs, instantIso: s.instantIso, kind: s.kind,
        });
      }
    }
    if (stillBlocked.length === 0) return initialReply;

    logger.warn('⚠ Availability floor — the draft presents an ESTABLISHED-unavailable time as workable; rewriting', {
      senderId: ctx.senderId,
      threadTs: ctx.threadTs,
      role: ctx.role,
      isOwnerInGroup: ctx.isOwnerInGroup === true,
      slots: stillBlocked.map(s => ({ when: s.display, kind: s.kind, reasonGiven: s.phrase ?? null })),
      draftPreview: initialReply.slice(0, 300),
    });

    const rewritten = await rewriteBlockedSlotClaim({
      draft: initialReply,
      slots: stillBlocked,
      ownerFirstName: profile.user.name.split(' ')[0],
    });
    if (!rewritten || rewritten.trim().length === 0) return initialReply;

    // The correction has landed in the text the reader will get; keeping the entry
    // would re-offer the same slot for correction on every later turn in the window.
    for (const s of stillBlocked) forgetHardBlockedSlot(profile.user.email, s.instantIso);
    return formatForSlack(rewritten);
  } catch (err) {
    logger.warn('Availability floor threw — sending the original draft', { err: String(err).slice(0, 200) });
    return initialReply;
  }
}

/**
 * proposed-slot-not-grounded-in-search-result (2026-08-24) — the grounding
 * check for a SPECIFIC time offered as available. Confirmed incident: a real
 * `find_available_slots` call (11:33:21Z) returned an evening window; the
 * reply sent 8 seconds later told a colleague a fabricated early-afternoon
 * time and a fabricated colleague conflict — none of it backed by the actual
 * tool result. RULE A (claimChecker's default mode) correctly exempts a
 * PROPOSED future time from its phantom-action check ("proposing a future
 * action is not a completed action, no verification needed") — right for the
 * general case, but it means nothing ever cross-referenced a SPECIFIC time
 * against the search that supposedly produced it. This is that
 * cross-reference, modeled on claimChecker's 'owner_fact' mode: its own mode
 * ('slot_grounding'), its own always-on-once-invoked check, called on EVERY
 * colleague-readable AND owner-private turn (an owner told a fabricated time
 * can act on it just as wrongly as a colleague can).
 *
 * TWO deterministic, free pre-filters (G10) before any LLM call:
 *   1. Did `find_available_slots` or `check_join_availability` actually run
 *      THIS turn? Read off the carried compact tool-summary lines
 *      (turnHelpers.ts's `renderToolSummary` — the exact lines Sonnet herself
 *      saw, never re-derived or re-parsed here, per G2). Absent on the vast
 *      majority of turns, which never search availability at all — nothing
 *      loads, nothing costs anything. bug 1.1 (2026-08-27) exception: when
 *      `result.availabilityQuestionDetected` is true (this turn's inbound
 *      message was a detected colleague availability question —
 *      `precheckAvailability`'s own `ran`, buildTurnContext.ts), the check
 *      still runs with an empty grounded-lines list rather than skipping —
 *      a zero-tool-call answer to "is he free at X" is exactly the shape
 *      this filter used to let through unchecked (Mike Naumenko /
 *      D0ARQRD5H28: a stale time recalled from three days earlier in the
 *      same thread shipped as fact because no search ran that turn).
 *   2. Does the draft contain at least one digit? A specific clock time or
 *      date cannot be named without one, in every language this system
 *      supports — the same language-neutral structural floor claimChecker's
 *      own `needsCheck` already uses for its length heuristic (G10 — gate the
 *      LLM behind a structural signal wherever one exists).
 *
 * Detection is Haiku, read as STRUCTURED FIELDS ONLY (G4) — the model never
 * supplies its own reasoning, only `claimed_action`/`action_summary`, so a
 * hallucinated time or a leaked chain-of-thought can never reach a reader.
 * The remedy is `rewriteOwningTheMiss`'s `ungrounded_slot_claim` branch: a
 * tool-less Sonnet rewrite constrained to substitute ONLY the real confirmed
 * time(s) we hand it (never inventing its own), with the same
 * minimal-redaction fallback and fail-open contract every other branch in
 * that function already has (G3/G5).
 *
 * Fails open at every step — same contract as every other gate in this file.
 *
 * bounce-fix (2026-08-26, adversarial re-verify) — this turn's search result
 * is not the ONLY ground truth: a time a real search already confirmed in an
 * EARLIER turn of the same thread (colleague asks about a second day while a
 * first offer still stands) is passed too, via `recentHistorySnippet`
 * (`buildRecentHistorySnippet` above) — same field/builder 'owner_fact' mode
 * already uses (G9), so a genuinely-confirmed earlier offer restated
 * alongside a new search no longer reads as fabricated.
 */
async function runSlotGroundingCheckAndMaybeRewrite(ctx: OutputGateContext, initialReply: string): Promise<string> {
  const { profile, result } = ctx;
  if (!initialReply || initialReply.trim().length === 0) return initialReply;
  if (!/\d/.test(initialReply)) return initialReply;

  // A calendar mutation that actually succeeded THIS turn (booking, move,
  // etc.) is its own, stronger ground truth — the reply is very likely
  // narrating the booked/moved instant itself ("Booked Tue 20:30"), not
  // offering a candidate. That instant can legitimately differ in rendering
  // from find_available_slots' own candidate strings (a different
  // presentation timezone, a grid-snap) without being false — same G5
  // reasoning the availability floor above already applies to a completed
  // mutation (see its own "CLEAR, don't merely stand down" branch). Standing
  // down here is a safe MISS (RULE A / the matchingToolAlreadyRan shield
  // already cover a false completed-action claim); rewriting would risk
  // contradicting a true booking.
  if (calendarMutationCompleted(result)) return initialReply;

  // Deterministic pre-filter 1 — read the carried compact summary lines for
  // the two availability tools verbatim (never re-derived). Absent on this
  // turn ⇒ nothing to ground a claim against ⇒ nothing to check.
  const groundedToolLines = (result.toolSummaries ?? []).filter(
    line => line.startsWith('[find_available_slots') || line.startsWith('[check_join_availability'),
  );
  // bug 1.1 (2026-08-27, Mike Naumenko / D0ARQRD5H28) — a ZERO-tool-call turn
  // used to bail out here unconditionally, which is exactly how a stale time
  // recalled from three days earlier in the same thread shipped unchecked (no
  // search ran, so this checker never even looked at the draft). When THIS
  // turn was a detected colleague availability question
  // (`availabilityQuestionDetected`, set by `precheckAvailability`'s own `ran`
  // in buildTurnContext.ts), still call the checker with an empty
  // `groundedToolLines` — `checkReplyClaims`'s `slotGroundingPrompt` already
  // handles that case correctly by design: it flags any specific-time-as-
  // available claim not backed by this turn's real result OR the
  // EARLIER-TURNS history block. Scoped to availability-question turns only
  // (not every digit-bearing reply) to avoid a new LLM call on ordinary turns
  // that have nothing to do with availability (G10).
  if (groundedToolLines.length === 0 && !result.availabilityQuestionDetected) return initialReply;

  let cleanReply = initialReply;
  try {
    const { checkReplyClaims, rewriteOwningTheMiss } = await import('../claimChecker');

    // bounce-fix (2026-08-26) — a time confirmed by a real search in an
    // EARLIER turn of this thread (colleague asks about a second day while a
    // first offer still stands) has no other ground truth: this mode's own
    // `groundedToolLines` is THIS TURN's search only. See
    // claimChecker.ts's `recentHistorySnippet` doc comment.
    const recentHistorySnippet = buildRecentHistorySnippet(ctx);

    const verdict = await checkReplyClaims({
      reply: cleanReply,
      toolSummaries: result.toolSummaries ?? [],
      bookingOccurred: result.bookingOccurred ?? false,
      ownerFirstName: profile.user.name.split(' ')[0],
      mode: 'slot_grounding',
      slotGroundingContext: { groundedToolLines },
      recentHistorySnippet,
    });

    if (!verdict.claimed_action) return cleanReply;

    logger.warn('Slot-grounding check: draft offers a specific time as available that this turn\'s real search does not confirm — rewriting (no tool re-fire)', {
      senderId: ctx.senderId,
      threadTs: ctx.threadTs,
      action_summary: verdict.action_summary,
      groundedToolLines,
      draftPreview: cleanReply.slice(0, 300),
    });

    const rewritten = await rewriteOwningTheMiss({
      draft: cleanReply,
      actionSummary: verdict.action_summary,
      // bounce-fix finding 4 (2026-08-24) — pin the literal, not
      // `verdict.action_type`. `checkReplyClaims` does
      // `action_type: (parsed.action_type ?? 'other')` with no per-mode
      // validation (claimChecker.ts:760), and a JSON-truncation recovery
      // path can yield an unexpected value. This call site already KNOWS it
      // invoked `mode: 'slot_grounding'` (line 1737 above) — trusting an LLM
      // round-trip for control flow it already has the answer to would let a
      // malformed `action_type` silently fall through to the DEFAULT
      // phantom-action rewrite prompt (nonsense like "I'm not sure that went
      // through" on a slot offer) instead of the slot-claim branch.
      actionType: 'ungrounded_slot_claim',
      targetName: verdict.target_name,
      ownerFirstName: profile.user.name.split(' ')[0],
      toolSummaries: result.toolSummaries ?? [],
      groundedToolLines,
    });
    if (rewritten && rewritten.trim().length > 0) {
      cleanReply = normalizeForTransport(ctx, rewritten);
    }
  } catch (err) {
    logger.warn('Slot-grounding check threw — leaving draft unchanged', { err: String(err).slice(0, 200) });
  }

  return cleanReply;
}

/**
 * v1.6.2 — security gate (colleague path only). Rewrites drafts that tripped
 * leak patterns. Full original/sent/triggers detail goes to WARN logs — never
 * to Slack (used to go through shadowNotify, which dumped it into the owner's
 * active thread).
 */
async function runSecurityGate(opts: {
  reply: string;
  colleagueName?: string;
  senderId: string;
  assistantName: string;
  ownerFirstName: string;
  // v3.0.5 — identity-spoof inputs (all optional; when absent, only leak
  // filter runs). See detectClaimedEmail + judgeIdentityClaim in securityGate.ts.
  verifiedSenderEmail?: string;
  ownerEmail?: string;
  recentUserMessages?: string[];
  // 2026-08-14 round 3 — the AI-identity judge's own input, always populated
  // by the caller regardless of ownerIsActing. Required (not optional): the
  // one call site below builds this unconditionally and always passes it — see
  // filterColleagueReply's own parameter doc for why this is separate from
  // recentUserMessages.
  aiIdentityContextMessages: string[];
}): Promise<{ reply: string; aiIdentityCleared: boolean }> {
  const { filterColleagueReply } = await import('../securityGate');
  const gateResult = await filterColleagueReply({
    reply: opts.reply,
    colleagueName: opts.colleagueName,
    colleagueSlackId: opts.senderId,
    assistantName: opts.assistantName,
    ownerFirstName: opts.ownerFirstName,
    verifiedSenderEmail: opts.verifiedSenderEmail,
    ownerEmail: opts.ownerEmail,
    recentUserMessages: opts.recentUserMessages,
    aiIdentityContextMessages: opts.aiIdentityContextMessages,
  });
  if (gateResult.filtered) {
    logger.warn('⚠ Security gate rewrote colleague reply', {
      senderId: opts.senderId,
      senderName: opts.colleagueName,
      triggers: gateResult.triggers,
      original: opts.reply.slice(0, 500),
      sent: gateResult.reply.slice(0, 500),
    });
  }
  return { reply: gateResult.reply, aiIdentityCleared: gateResult.aiIdentityCleared };
}

// ── Date verifier + retry (v1.6.6) ─────────────────────────────────────────

/**
 * v3.4 (Option C) — verify weekday/date pairs in ANY language. verifyDates runs
 * a gated Haiku EXTRACTOR (reads the literal weekday+date pairs, never guesses a
 * date), then CODE judges each against the 14-day lookup. A mismatch is fixed by
 * a DETERMINISTIC literal swap of the wrong weekday word inside the exact matched
 * span — a no-op unless the lookup disagrees AND the span is literally present,
 * so it cannot corrupt a correct draft.
 *
 * Runs for BOTH owner and colleague paths — a date-wrong DM to a colleague
 * creates the same trust problem as one to the owner.
 *
 * Fails OPEN: extractor / parse errors or anything → return the original draft.
 */
async function runDateVerifierAndMaybeRetry(ctx: OutputGateContext, initialReply: string): Promise<string> {
  const { profile, userMessage } = ctx;
  let cleanReply = initialReply;

  try {
    const { verifyDates } = await import('../dateVerifier');
    const verdict = await verifyDates(cleanReply, profile, userMessage);
    if (verdict.ok || verdict.mismatches.length === 0) return cleanReply;

    // v3.4 — correct with a DETERMINISTIC weekday-token swap only. The old
    // LLM rewrite (rewriteWithCorrectDates) was removed: its riskiest edit —
    // reflowing events under a corrected day header — was never verified, so
    // it could strand an event under the wrong day (exactly the corruption the
    // date detector exists to prevent). The swap only replaces the wrong
    // weekday WORD against the authoritative lookup; it never touches event
    // content, so it cannot corrupt. The detector already guarantees every
    // mismatch is real (lookup-backed), so the swap is always safe to apply.
    for (const mm of verdict.mismatches) {
      // Swap the weekday word INSIDE the exact span the detector matched, then
      // replace that literal span in the draft. Using the matched span (not a
      // reconstructed \b regex) is language-agnostic: it fixes Hebrew
      // ("יום ראשון 19 באפריל" → "יום שני 19 באפריל") and English alike, where
      // \b word-boundaries silently fail to match around non-ASCII letters. The
      // weekday token sits at the start of the span in both detector patterns,
      // and the span carries its own date so the replace can't mis-target.
      // split/join (not .replace) so a span carrying the weekday twice
      // ("Thursday — yes, Thursday the 11th") gets BOTH corrected, not just the
      // first. .replace(string) swaps only the first occurrence and would ship
      // a wrong weekday in the same span while the guard reports success.
      const corrected = mm.matchedText.split(mm.writtenWeekday).join(mm.correctWeekday);
      if (corrected !== mm.matchedText && cleanReply.includes(mm.matchedText)) {
        cleanReply = cleanReply.split(mm.matchedText).join(corrected);
      }
    }
    // v4.2.x — normalize the corrected text, and only when a swap actually landed
    // (a mismatch whose span isn't literally present in the draft changes nothing —
    // the swap's own no-op guard, above). This is the same normalization every other
    // rewrite path in this file gets, and it matters now that this gate runs last on
    // the colleague leg: `correctWeekday` is an extractor-supplied string and nothing
    // downstream would scrub it.
    //
    // The history write that used to sit here is GONE. It existed to chase a record
    // that had already been written one line above the gate stack; postReply now
    // persists once, after the gates (its Step 3b), so the corrected text is
    // what gets stored and a write here would only duplicate the row.
    //
    // v4.2.x — log AFTER the loop, keyed on the SAME `cleanReply !== initialReply`
    // check that already gates normalization, not before it. The old log fired
    // unconditionally the moment the extractor flagged ANY mismatch, claiming
    // "correcting deterministically" even on a turn where every swap above was a
    // no-op (written weekday === "correct" weekday — an extractor mislabel, not a
    // real mismatch — or the matched span wasn't literally present in the draft).
    // Report what actually happened, not what was attempted.
    if (cleanReply !== initialReply) {
      cleanReply = normalizeForTransport(ctx, cleanReply);
      logger.warn('Date verifier: draft has wrong weekday/date pairs — corrected deterministically', {
        senderId: ctx.senderId,
        threadTs: ctx.threadTs,
        mismatches: verdict.mismatches,
      });
    } else {
      logger.warn('Date verifier: flagged weekday/date mismatches but no textual change resulted (every swap was a no-op)', {
        senderId: ctx.senderId,
        threadTs: ctx.threadTs,
        mismatches: verdict.mismatches,
      });
    }
  } catch (err) {
    logger.warn('Date verifier threw — sending original reply', { err: String(err) });
  }
  return cleanReply;
}

// ── Deliberation guard (was the v2.2.5 "concision finalizer") ────────────────
//
// v4.1.x (W3) — this pass was NOT a backstop, it was a routine second drafting
// stage sitting on the critical path of every reply, and it was rewriting correct
// answers into shorter ones. It fired on three shape heuristics — ≥2 question
// marks, ≥2 English "if" branches, or >600 chars of non-list prose — sent the whole
// reply to Sonnet with "stay under 4 short sentences", and had NO fact check at
// all: the only safety net was "is the result shorter". Because it runs before
// postReply persists history, the trimmed version was also what history kept, so
// the fuller answer could not be recovered on the next turn. In the 07-19→07-23
// logs it fired 14 times, and only 2 of those were the deliberation case; the rest
// were length/shape — including a 193-char reply cut to 109 and a 983-char one cut
// to 157. W3: reply length is DRAFTING behavior and belongs to whatever writes the
// draft (prompt / orchestrator output policy), not to a guard.
//
// What survives is the one genuine output-time concern: Sonnet emitting her
// derivation into the user-facing text ("wait, that breaks the order", "let me
// find", "OK definitive clean proposal"). That is a REASONING LEAK — the same
// family as G4 — and the reader should never see it. So:
//   - the length and self-coherence triggers are GONE (with their helpers),
//   - the prompt no longer asks for compression, only for the journey to be cut,
//   - and a wrong fire is now a safe MISS: the rewrite must survive the same
//     fact-preservation veto humanGate uses (rewriteDroppedAFact), so a dropped
//     @mention / time / date / question throws the rewrite away and ships the
//     original. Worst case the reader sees a bit of deliberation — never a
//     deleted fact.
//
// Still fails open on any error, and still never blocks a reply.

const DELIBERATION_RE = /\b(actually wait\b|on second thought\b|let me (?:think|find|check|give|ask|see|try)\b|wait,?\s+(?:that|the|i|let|professional|no)\b|on the other hand\b|on the one hand\b|definitive (?:clean )?proposal\b|hmm,?\s|so the full corrected\b|i need to (?:also )?(?:move|find|give|check)\b|let me give you the clean\b)/i;

export async function runDeliberationGuard(rawReply: string, profile: UserProfile): Promise<string> {
  const trim = rawReply.trim();
  if (!trim) return trim;
  if (!DELIBERATION_RE.test(trim)) return trim;

  try {
    const anthropic = getAnthropicClient();
    const ownerFirst = profile.user.name.split(' ')[0];
    const resp = await anthropic.messages.create({
      ...SONNET,
      max_tokens: 400,
      tools: [{
        name: 'rewrite',
        description: 'Output the cleaned final reply for the user.',
        input_schema: {
          type: 'object' as const,
          properties: { final: { type: 'string' } },
          required: ['final'],
        },
      }],
      tool_choice: { type: 'tool', name: 'rewrite' },
      messages: [{
        role: 'user',
        content: `You wrote this draft for ${ownerFirst}'s assistant. It leaked your own thinking-out-loud into the text the reader will see. Output the SAME reply with only that narration removed. Strip:
- self-correction ("wait,", "actually,", "on second thought", "OK definitive...")
- planning narration ("I need to find", "let me check", "let me give you the clean")
- references to your own reasoning process, and the order you worked things out in

This is NOT an edit for brevity. Do not shorten, summarize, compress or tidy anything else. Every fact the draft states must still be there afterwards: every time, date, name, @mention, number and list item, and every question it asks. If the draft asks the reader something, your output asks the same thing.

That includes options you talked yourself out of mid-draft: keep the INFORMATION, drop the deliberation. "I could do 11:00 — wait, that clashes with the standup. 12:30 is clean." becomes "11:00 clashes with the standup, but 12:30 is clean." — not "12:30 is clean.". The reader still needs to know 11:00 was considered and why it's out.

If removing the narration changes nothing, return the draft unchanged.

Match the language of the draft.

Draft:
${trim}`,
      }],
    });
    logLlmUsage('deliberation_guard', MODEL_SONNET, resp);
    const tool = resp.content.find((b: { type: string }) => b.type === 'tool_use') as { input?: { final?: string } } | undefined;
    const final = tool?.input?.final;
    if (!final || !final.trim()) return trim;
    const cleaned = final.trim();
    // Removing narration can only make the text shorter; a longer or near-empty
    // result means the model did something else. Keep the original.
    if (cleaned.length >= trim.length || cleaned.length < 10) return trim;
    // G5 — the veto that makes a wrong fire a safe MISS. Same deterministic,
    // free, narrow check humanGate applies to ITS rewrites: an @mention, clock
    // time, numeric date or question that the original carried and the rewrite
    // does not means content was deleted, not narration. Ship the original.
    // Imported lazily like every other guard primitive in this file — a clean
    // reply never loads humanGate at all.
    const { rewriteDroppedAFact } = await import('../humanGate');
    if (rewriteDroppedAFact(trim, cleaned)) {
      logger.warn('Deliberation guard — rewrite dropped a load-bearing fact; shipping the original draft', {
        before: trim.length,
        after: cleaned.length,
        originalPreview: trim.slice(0, 160),
        rewritePreview: cleaned.slice(0, 160),
      });
      return trim;
    }
    logger.info('Deliberation guard stripped reasoning narration', {
      before: trim.length,
      after: cleaned.length,
    });
    return cleaned;
  } catch (err) {
    logger.warn('Deliberation guard threw — sending original draft', { err: String(err).slice(0, 200) });
    return trim;
  }
}
