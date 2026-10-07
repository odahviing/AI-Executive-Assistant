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
 *   OWNER-PRIVATE: human voice → action truth → deterministic dates.
 *   COLLEAGUE-READABLE: human voice → security → dates → final fact/action
 *     truth, using request-specific decisions and action receipts. The existing
 *     always-on fact call replaces the separately admitted approval check.
 *     Approval/completion findings receive a fixed uncertainty line; no model
 *     gets to rewrite that decision into a fresh action claim.
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
 * gate call is individually try/caught. Final truth-check unavailability keeps
 * unchanged replies but does not accept unverified rewrites. The colleague leg's LEAK gate is the one that may not fail open, because
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
import type { ConversationMessage } from '../../db/conversations';
import { toolLinesMatching } from '../../core/orchestrator/turnHelpers';
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
  history: ConversationMessage[];
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
   * from a 1:1 DM. The former relay backstop exposed why `!isMpim` alone
   * cannot establish a private DM: a channel is neither a DM nor an MPIM.
   * The surface context remains available to gates; request lifecycle and
   * relay obligations are now handled upstream by the request spine.
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

/**
 * email-leg-hedge-shipped-colleague-third-person-wording (2026-08-28; Slack
 * arm added 2026-08-30) — is the reply's DIRECT recipient the owner himself?
 * Decides only the WORDING of claimChecker's `genericHonestHedge` fallback
 * (second person vs the colleague-facing third-person "confirm it with him"),
 * never which gates run. The email arm: the one-address cap restricts that
 * leg's recipient to the owner's own mailbox (connectors/email/inbound.ts).
 * The Slack arm is the exact negation of the `colleagueReadable` axis derived
 * in runOutputGates below — the owner-private 1:1 DM. It matters because the
 * slot-grounding check runs on BOTH Slack legs (its call site sits above the
 * leg split), so the same antecedent-less "him" the 2026-08-28 email incident
 * shipped was equally reachable in the owner's own DM. A wrong value here is
 * a wrong pronoun in an already-hedged fallback line, never a dropped gate
 * (G5-safe on both misses).
 */
function isOwnerDirectAudience(ctx: OutputGateContext): boolean {
  return ctx.transport === 'email' || (ctx.role === 'owner' && ctx.isOwnerInGroup !== true);
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
    logger.info('Output gate policy', {
      senderId, channelId, threadTs: ctx.threadTs, transport: 'email',
      ownerIsActing: true, colleagueReadable: true, audience: 'external',
    });
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
  // of three. `role` is derived from exactly this comparison (app.ts's getSenderRole) and is then
  // CLAMPED to 'colleague' in an MPIM and in a channel (processMessage.ts:123) —
  // so the old `role === 'owner' || isOwnerInGroup` pair covered the DM and the
  // group DM and silently missed the CHANNEL: the owner @-mentions Maelle in a
  // real channel, she claims she messaged someone or moved something, and the
  // phantom-action check never ran, because the group-DM fix repaired the MPIM
  // half of the clamp with `isOwnerInGroup` and there is no `isOwnerInChannel`
  // on this side of the wire (processMessage.ts:isOwnerInChannel computes one and never
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
  // there (systemPrompt.ts:628 "SPEAK TO THE GROUP"), and 'internal' endorses
  // that shape verbatim (humanGate.ts:99). Every other rule in the gate is
  // identical across the two frames, so on a group reply the 'owner' frame could
  // only ever rewrite correct text — a G5 corruption, not a safe miss.
  const audience: HumanGateAudience = colleagueReadable ? 'internal' : 'owner';
  logger.info('Output gate policy', {
    senderId, channelId, threadTs: ctx.threadTs, transport: 'slack',
    ownerIsActing, colleagueReadable, audience,
  });

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
  // drafting turn to narrate (e.g. skills/outreach.ts's `_must_reply_with`) and the pinned action
  // tape replays confirmed mutations into the system prompt (turnHelpers.ts
  // extractActionTape). A draft that contradicts a mutation is a DRAFTING bug, so
  // it gets fixed where the draft is made, not policed afterwards.)

  if (!colleagueReadable) {
    // ── OWNER-PRIVATE — a 1:1 DM with the authenticated owner ───────────────
    // Voice first, then the existing truth check: no later voice writer can
    // turn failure into success. This also removes the duplicate probe calls.
    try {
      const { runHumanGate } = await import('../humanGate');
      const verdict = await runHumanGate(cleanReply, profile, audience, channelId);
      if (!verdict.ok && verdict.rewrite?.trim()) cleanReply = formatForSlack(verdict.rewrite);
    } catch (err) {
      logger.warn('humanGate threw — leaving draft unchanged', { err: String(err) });
    }
    cleanReply = await runClaimCheckAndMaybeRewrite(ctx, cleanReply, draft);
    cleanReply = await runDateVerifierAndMaybeRetry(ctx, cleanReply);
  } else {
    // ── COLLEAGUE-READABLE — a colleague's DM, a channel, or a GROUP DM ─────
    // Every colleague-readable reply receives the existing fact check after
    // voice and security writers. It includes request-specific decision and
    // completion evidence, instead of the old thread-wide resolved boolean.
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
    // for an owner-in-group turn anyway (processMessage.ts:colleagueName) — this stops that
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
    try {
      const { runHumanGate } = await import('../humanGate');
      // v2.9 — Slack-side colleagues are same-domain by definition (workspace
      // membership), so `audience` resolves to 'internal' here. When
      // EmailConnection lands, its sendReply path will pass 'external' for
      // off-domain recipients. Recent questions also let this existing check
      // judge honest identity answers outside securityGate's English prefilter.
      // Owner-private/email/coda callers supply no identity-question context.
      const verdict = await runHumanGate(cleanReply, profile, audience, channelId, false, false, aiIdentityContextMessages);
      if (!verdict.ok && verdict.rewrite && verdict.rewrite.trim().length > 0) {
        cleanReply = formatForSlack(verdict.rewrite);
      }
    } catch (err) {
      logger.warn('humanGate (colleague-path) threw — leaving draft unchanged', { err: String(err).slice(0, 200) });
    }

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
    // Date substitution is deterministic; the final semantic check sees all
    // preceding writer output. Its approval/completion remedy adds no prose
    // from a model and cannot manufacture another action claim.
    cleanReply = await runDateVerifierAndMaybeRetry(ctx, cleanReply);
    cleanReply = await runOwnerFactCheckAndMaybeRewrite(ctx, cleanReply, draft);
  }

  return cleanReply;
}

/**
 * The EMAIL LEG (gh#24). A non-Slack entry into the same gate stack, so a
 * transport that isn't `postReply` still gets gated at all — today this is
 * the only path `runOutputGates` is reachable from besides Slack.
 *
 * Order: slot grounding → humanGate → action truth → date verification →
 * final owner-fact/action truth. No generative writer follows the final check.
 *
 *  - claimChecker always runs (no `ownerIsActing` gate needed): the inbound sender
 *    authorization already restricts this whole leg to the owner + his
 *    configured aliases (connectors/email/inbound.ts), so every draft here
 *    IS the owner's own turn. A phantom "I've booked it" reaching externals
 *    over his signature, with nothing between the LLM and Graph's send call,
 *    is exactly the honesty gap the checker exists to catch.
 *  - the owner-fact-invention check (2026-08-14; wired into this leg
 *    2026-08-28 — see the call site below) runs unconditionally, same as on
 *    the colleague-readable Slack leg: an invented personal/capability claim
 *    about the owner is exactly as wrong landing in an external inbox as it
 *    is in a colleague's DM.
 *  - humanGate runs in the 'external' frame — a value the type has defined
 *    since v2.9 (humanGate.ts:107) and that no caller had ever passed until
 *    this one: no owner-name third-person reference, professional register,
 *    because the reader is off-domain.
 *  - dateVerifier is MANDATORY here, not merely nice-to-have: a forwarded
 *    scheduling reply is almost entirely weekday-and-date claims, and this is
 *    the only check standing between a wrong weekday and an external inbox
 *    over the owner's own signature.
 *
 * Deliberately does NOT run the availability floor or the security gate.
 * Corrected 2026-08-28 (charter audit) — the floor's ledger is NOT empty
 * here "by construction": it is keyed by owner EMAIL and read across
 * threads/transports (`freshHardBlockedSlots(profile.user.email)`,
 * ~availabilityGate.ts), armed by the Slack-only `availabilityPreCheck`
 * whenever `input.authority === 'colleague'` (buildTurnContext.ts:751), and
 * entries live for up to 45 minutes (`TTL_MS`, availabilityGate.ts). So an
 * email reply drafted inside that window, while a Slack-colleague turn just
 * armed the ledger, could affirm a real hard-blocked instant with nothing on
 * this leg checking it — the exposure is narrow (Slack-colleague-armed +
 * inside the 45-min TTL + an email reply naming that exact instant in the
 * meantime) but real, and NOT covered today; this leg's own turn can never
 * arm the ledger itself, since the pre-check is gated to colleague authority
 * only. Wiring the floor onto this leg is accepted as a follow-up, not done
 * here: `runAvailabilityFloorAndMaybeRewrite`'s rewrite path ends in an
 * unconditional `formatForSlack` call (not `normalizeForTransport`), so it
 * is not transport-safe for this leg as written — a real fix, not a
 * one-line wire-in. The security gate's leak-scrub half assumes a Slack colleague (a
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

  cleanReply = await runSlotGroundingCheckAndMaybeRewrite(ctx, cleanReply);
  // owner-personal-fact-fabricated-in-colleague-reply (2026-08-14) — wired in
  // 2026-08-28. This leg's own reader-frame is 'external' by construction
  // (this function's doc comment), the exact same risk the colleague-readable
  // Slack leg runs this check for on EVERY turn regardless of who is acting
  // (see runOutputGates' call site comment) — an invented personal/capability
  // claim about the owner lands in front of an outside reader either way. It
  // was simply never wired into this leg: the check was built 2026-08-14,
  // after this leg already existed, and nothing here ever weighed it — the
  // same shape of omission the slot-grounding fix above closed. Its own
  // rewrite path already calls `normalizeForTransport` (not `formatForSlack`
  // directly), so it needed no transport-awareness fix to be safe here.

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

  cleanReply = await runClaimCheckAndMaybeRewrite(ctx, cleanReply, initialReply);
  cleanReply = await runDateVerifierAndMaybeRetry(ctx, cleanReply);
  cleanReply = await runOwnerFactCheckAndMaybeRewrite(ctx, cleanReply, initialReply);
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
    const verdict = await runHumanGate(text, ctx.profile, audience, undefined, false, true);
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

/** Minimal request-specific evidence; private payloads/identifiers never enter output. */
async function requestOutcomeEvidence(ctx: OutputGateContext): Promise<string> {
  let requestEvidence = 'unavailable';
  try {
    const { getRequestsForThread } = await import('../../db/requests');
    const { ORIGIN_SURFACE_REPLAY_TOOLS } = await import('../../core/requests/types');
    requestEvidence = JSON.stringify(getRequestsForThread(ctx.profile.user.slack_user_id, ctx.threadTs).map(row => {
      let outcome: Record<string, unknown> = {};
      let details: Record<string, any> = {};
      try { outcome = JSON.parse(row.outcome_json ?? '{}') ?? {}; } catch { /* unknown */ }
      try { details = JSON.parse(row.details_json ?? '{}') ?? {}; } catch { /* unknown */ }
      const requested = details.callbacks?.on_approve ?? details.deferred_action;
      const args = { ...requested?.args, ...details.counter };
      return { subject: row.subject, created_at: row.created_at, state: row.state,
        requested: { tool: requested?.tool, meeting_subject: args.meeting_subject,
          meeting_id: args.meeting_id, new_start: args.new_start, new_end: args.new_end },
        approved: typeof outcome.approved === 'boolean' ? outcome.approved : null,
        // Resolver persists the replay TOOL NAME, not a success boolean.
        // Origin-surface replays are synchronous; unknown attempts explicitly
        // persist verified:false. Other tools can be merely tracked, with no
        // durable distinction in historical outcomes, so their completion is
        // unknown without an independent receipt.
        replayed: typeof outcome.replayed === 'string' ? outcome.replayed : null,
        verified: typeof outcome.verified === 'boolean' ? outcome.verified : null,
        completionConfirmed: row.state === 'resolved' && outcome.approved === true
          && typeof outcome.replayed === 'string' && outcome.verified !== false
          && (ORIGIN_SURFACE_REPLAY_TOOLS as readonly string[]).includes(outcome.replayed),
        booked_start: outcome.booked_start ?? null };
    }));
  } catch (err) {
    logger.warn('Final truth context unavailable', { err: String(err) });
  }
  return requestEvidence;
}

async function runClaimCheckAndMaybeRewrite(
  ctx: OutputGateContext,
  initialReply: string,
  originalDraft: string = initialReply,
): Promise<string> {
  const { profile, result } = ctx;
  let cleanReply = initialReply;

  try {
    const { checkReplyClaims, genericHonestHedge } = await import('../claimChecker');

    // v3.0.6 — claim-checker is owner-path RULE A only (false action claim).
    // Module F + E extended-rule inputs (priorAssistantReply, currentUserMessage,
    // imagesInTurn) were removed in the latency pass; honesty rules 1/2/2b/2c/2d
    // /3/5b/9 stay in the system prompt per v2.8.5.
    const requestEvidence = await requestOutcomeEvidence(ctx);
    // Preserve the existing cheap short-reply skip when nothing changed and
    // no action/decision evidence exists. A rewrite must be checked even when
    // its invented approval is only two words long.
    const finalOutcomeContext = cleanReply !== originalDraft || result.toolSummaries?.length
      || (requestEvidence !== '[]' && requestEvidence !== 'unavailable')
      ? `Requests: ${requestEvidence}` : undefined;
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
      finalOutcomeContext,
    });

    // v3.0.6 — Module F + E booleans were fully removed from the checker
    // (advisory-only since v2.8.5; cost ~5s of Sonnet on every owner turn for
    // a verdict no caller acted on). Honesty rules 1/2/2b/2c/2d/3/5b/9 stay
    // in the system prompt. Only RULE A (claimed_action — false action claim)
    // drives retries from here.
    if (verdict.failed_open) return cleanReply === originalDraft
      ? cleanReply : genericHonestHedge(originalDraft, isOwnerDirectAudience(ctx));
    if (!verdict.claimed_action) return cleanReply;
    // Approval truth is now request-specific. Never infer a grant from any
    // resolved row or substitute a generative rewrite for a missing decision.
    if (verdict.action_type === 'permission_granted') {
      return genericHonestHedge(cleanReply, isOwnerDirectAudience(ctx));
    }

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
    // check-claimed-that-never-ran (2026-09-06, bounce 2) — the READ-side
    // marker, for the one fact-shaped class RULE A itself raises. A finding
    // about a named third party's hours / busy time is backed when a slot or
    // meeting tool actually evaluated attendees — summarizeToolCall stamps
    // `attendee_check=` on exactly those calls (turnHelpers.ts
    // attendeeCheckSource) — and, like `mutated=`, the marker is scanned in
    // THIS turn's tape AND prior turns' persisted rows: on the turn AFTER a
    // search, "I checked, the mornings are outside Erez's hours" is a truthful
    // recap, and rewriting it into "I haven't checked" would make her lie
    // (G5). The checker's prompt only ever sees this turn, so this is where
    // the "no matter which turn" promise of its own RULE A exemption is kept.
    const attendeeCheckCarried = verdict.action_type === 'invented_third_party_fact'
      && toolSummariesText.includes('attendee_check=');
    // A misreport of what a check FOUND (the tape says "busy", the draft says
    // "outside their hours" — the 2026-09-05 incident) is this class's
    // specifics mismatch, and it can only have been judged against a line the
    // checker actually saw: this turn's. With no marker this turn the flag
    // rests on a prior turn's check, and the bit is ignored whatever the model
    // set — the destructive path stays on a deterministic trigger (G3).
    const specificsMismatch = verdict.claim_specifics_mismatch === true
      && (verdict.action_type !== 'invented_third_party_fact'
        || (result.toolSummaries ?? []).join(' ').includes('attendee_check='));

    // The one class where WHO matters: a DM sent to Yael does not make "already
    // flagged it to Simon" honest. The recipient is already in the summary
    // (`[message_colleague: <name>]`), so this reads existing data — it is not a
    // second list. A SKIPPED relay (`[message_colleague] <id> — … skipped`, pushed
    // straight to the tape by the orchestrator's idempotency guards) never carries
    // the marker, so it can no longer back a "sent it" claim either.
    const targetMatches = verdict.action_type !== 'message'
      || !verdict.target_name
      || toolSummariesText.toLowerCase().includes(verdict.target_name.toLowerCase());

    // approval-relay-claim-retracted-after-confirmed-delivery (2026-09-16) —
    // create_approval correctly carries `mutated=task`: creating the durable
    // request is not itself a generic message mutation. But its producer also
    // knows whether the owner-facing post actually landed and stamps the
    // separate `notified=approval_owner` marker only for owner_notified=true.
    // Accept that marker only for a MESSAGE claim whose named target is exactly
    // the configured owner's full name or one of its exact tokens. This keeps a
    // delivered approval from grounding "sent to Michal," and an absent target
    // from turning an owner-specific delivery into a blanket message shield.
    const ownerFullNameLower = profile.user.name.trim().toLowerCase();
    const ownerNameTokensLower = ownerFullNameLower.split(/\s+/).filter(Boolean);
    const claimTargetLower = verdict.target_name?.trim().toLowerCase();
    // Unlike the general mutation recap shield, an approval notification is
    // accepted from THIS turn only. A prior approval delivered to the same
    // owner says nothing about whether today's distinct ask was relayed.
    const currentToolSummariesText = (result.toolSummaries ?? []).join(' ');
    const approvalOwnerNotificationCarried = verdict.action_type === 'message'
      && !!claimTargetLower
      && (claimTargetLower === ownerFullNameLower || ownerNameTokensLower.includes(claimTargetLower))
      && currentToolSummariesText.includes('notified=approval_owner');

    const matchingToolAlreadyRan = ((mutationCarried || attendeeCheckCarried) && targetMatches)
      || approvalOwnerNotificationCarried;

    // v2.6.1 — when the claim-checker LLM has named a SPECIFIC change the
    // tool that ran doesn't cover (e.g. "updated to 25 min" claim while only
    // `move_meeting` ran — start changed, duration didn't), bypass the
    // false-positive shield. The shield's coarse "any matching tool ran =
    // honest" was masking real specifics-mismatch claims (warn observed
    // 2026-05-06, draft said "updated to 25 min" with only [move_meeting OK]
    // in tool activity). When the LLM has explicitly identified the field
    // mismatch, trust the verdict — let the retry fire. Retry already carries
    // this turn's tool summaries (v2.3.4) so no duplicate-mutation risk.
    if (matchingToolAlreadyRan && !specificsMismatch) {
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
    if (matchingToolAlreadyRan && specificsMismatch) {
      logger.warn('Claim-checker shield bypassed — specifics mismatch identified, rewrite will fire', {
        senderId: ctx.senderId,
        threadTs: ctx.threadTs,
        action_type: verdict.action_type,
        target_name: verdict.target_name,
        action_summary: verdict.action_summary,
        toolSummaries: result.toolSummaries,
      });
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
        deletionOnly: true,
        actionSummary: verdict.action_summary,
        actionType: verdict.action_type,
        targetName: verdict.target_name,
        ownerFirstName: profile.user.name.split(' ')[0],
        // v3.7.x — the rewriter must verify against the same tool activity
        // the checker read, so it can't invert a true completed action it can't see.
        // o#224 — no approvalGrantContext here: permission_granted claims
        // return above and never reach this call (see the block above).
        toolSummaries: result.toolSummaries ?? [],
        isOwnerAudience: isOwnerDirectAudience(ctx),
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
 * o#259 (2026-08-28) — where a persisted assistant row's tool tape ends and
 * its prose begins, decided by SHAPE. postReply.ts:545-547 stores a row as
 * `toolSummaries.join(' ') + '\n' + replyText` ONLY when there were tool
 * summaries that turn — a no-tool-call turn stores `cleanReply` alone, with
 * NO tape and no synthetic `\n` prefix — and the tape is deliberately RAW
 * (the claim-checker's `mutated=<domain>` shield reads it later — never touch
 * that storage format). Splitting on the first `\n` unconditionally once
 * dropped the real first line of every multi-line tool-less Slack reply.
 * Every tool-summary entry (`summarizeToolCall`/`summarizeInternalAction`,
 * turnHelpers.ts) is bracket-wrapped (`[tool ...]` or `[tool FAILED: ...]`),
 * optionally followed by ` mutated=<domain>` / ` attendee_check=<source>`,
 * space-joined — so a REAL tape's pre-`\n` segment starts with `[` and closes
 * a `]` before that newline; anything else is prose in full. ONE splitter
 * (G9) for the two readers below: the snippet wants the prose, the
 * slot-grounding lift wants the tape.
 */
function splitAssistantRow(raw: string): { tape: string; text: string } {
  const nl = raw.indexOf('\n');
  const preNl = nl === -1 ? '' : raw.slice(0, nl);
  return /^\[.*\]/.test(preNl) ? { tape: preNl, text: raw.slice(nl + 1) } : { tape: '', text: raw };
}

/**
 * bounce-fix (2026-08-26) — the SAME thread-history snippet Maelle drafted
 * from (`ctx.history`), capped (last 12 turns, 220 chars each) to bound
 * prompt size on a check that runs every colleague-readable turn (G10), for
 * 'owner_fact' mode: an invented personal fact may be something the owner
 * said himself earlier. 'slot_grounding' mode shared it from 2026-08-26 to
 * 2026-09-09 and it never grounded anything there — the prose can't show
 * that a real search backed an earlier offer; that mode reads the tape's own
 * search lines now (`priorTurnAvailabilityLines` below).
 */
function buildRecentHistorySnippet(ctx: OutputGateContext): string | undefined {
  const { profile } = ctx;
  return (ctx.history ?? [])
    .slice(-12)
    .map(h => {
      const raw = h.content ?? '';
      const text = h.role === 'assistant' ? splitAssistantRow(raw).text : raw;
      return `${h.role === 'assistant' ? profile.assistant.name : 'User'}: ${text.slice(0, 220)}`;
    })
    .join('\n') || undefined;
}

/**
 * The three producers of an availability ground-truth line, ONE head (G9) for
 * this turn's filter and the earlier-turn lift below: the two search tools'
 * compact lines (turnHelpers.ts's `renderToolSummary`) and the precheck's
 * synthetic `[availability_precheck …]` lines (availabilityPreCheck.ts's
 * `renderToolSummaryLines`). Structured tool-line prefixes, not language (W4).
 */
const AVAILABILITY_LINE_HEAD = /^\[(?:find_available_slots|check_join_availability|availability_precheck)/;

/**
 * slot-grounding-rewrite-sourced-from-precheck (2026-09-09, Sharon Duret,
 * 18:45:37Z) — the earlier turns' availability lines, lifted VERBATIM off the
 * persisted tape. Why `recentHistorySnippet` never did this job: it strips
 * the tape from every assistant row (`splitAssistantRow`) and hands the
 * checker the earlier PROSE — "Good bets for Tuesday next week: 2pm or 3:45pm
 * EDT…" — under an instruction to trust it only if "a REAL availability
 * search" backed it, which prose cannot show. So the checker flagged a
 * correct re-offer of the previous turn's 8 confirmed slots as "not confirmed
 * in this turn's availability check", and the rewrite substituted the only
 * lines it had — a mis-dated precheck's Jerusalem-local alternatives — into a
 * Boston reader's reply. The tape is persisted RAW for exactly this kind of
 * read (postReply.ts Step 3b; the `mutated=` shield reads it the same way),
 * same 12-row window the snippet uses. Lifted with `toolLinesMatching`
 * (turnHelpers.ts) because a search line nests `[local: …]` brackets.
 * Prefixed `(earlier turn)` so the prompt scopes its NEGATIVE clause to this
 * turn's lines: an earlier line can only GROUND a time (keep), never flag one
 * — keep-only by construction (G5).
 */
function priorTurnAvailabilityLines(ctx: OutputGateContext): string[] {
  return (ctx.history ?? [])
    .slice(-12)
    .filter(h => h.role === 'assistant')
    .flatMap(h => toolLinesMatching(splitAssistantRow(h.content ?? '').tape, AVAILABILITY_LINE_HEAD))
    .map(line => `(earlier turn) ${line}`);
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
 * #206 also checks a categorical denial of an earlier attendee calendar read
 * against the latest persisted search receipt. Same judge and veto rewrite;
 * the denial remedy permits only a verbatim deletion and fails open otherwise.
 * This does not establish current access or the correctness of any slot.
 *
 * Runs on EVERY colleague-readable turn regardless of who is acting — see
 * this file's call site for why that is deliberately independent of RULE A's
 * final truth checks. Uses claimChecker's
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
 * An unavailable verdict preserves unchanged text; changed unchecked text
 * receives the fixed uncertainty line. Rewrite exceptions keep its input.
 */
async function runOwnerFactCheckAndMaybeRewrite(
  ctx: OutputGateContext,
  initialReply: string,
  originalDraft: string = initialReply,
): Promise<string> {
  const { profile, result } = ctx;
  let cleanReply = initialReply;

  try {
    const { checkReplyClaims, rewriteOwningTheMiss, genericHonestHedge } = await import('../claimChecker');

    // owner-personal-fact-fabricated-in-colleague-reply (2026-08-14, bouncer
    // retry) — ground truth the check needs beyond "did a tool run": the SAME
    // history array the orchestrator handed Maelle when she drafted this
    // reply, so "he can take a car call" reads as grounded when the owner
    // said exactly that three turns earlier in this same thread, and only as
    // invented when it has no such origin anywhere. See claimChecker.ts's
    // `recentHistorySnippet` doc comment.
    const recentHistorySnippet = buildRecentHistorySnippet(ctx);

    // #206: provenance is carried separately from model-authored text. Legacy
    // or malformed assistant rows cannot authorize a destructive rewrite.
    // Explicit no-tool rows may be crossed; the newest actual result wins.
    let latestSummaries: string[] = [];
    for (const row of (ctx.history ?? []).slice(-12).filter(h => h.role === 'assistant').reverse()) {
      if (!Array.isArray(row.toolSummaries) || row.toolSummaries.some(s => typeof s !== 'string')) break;
      if (row.toolSummaries.length) {
        latestSummaries = row.toolSummaries;
        break;
      }
    }
    const priorCalendarReadLines = !(result.toolSummaries?.length)
      ? latestSummaries.slice(-1).filter(line => /^\[find_available_slots(?:\s|\])/.test(line)
        && !/^\[find_available_slots FAILED:/.test(line) && / calendars_read=/.test(line))
      : [];
    const finalOutcomeContext = `Requests: ${await requestOutcomeEvidence(ctx)}. Earlier tool receipts: ${JSON.stringify(latestSummaries)}`;
    const verdict = await checkReplyClaims({
      reply: cleanReply,
      toolSummaries: result.toolSummaries ?? [],
      bookingOccurred: result.bookingOccurred ?? false,
      ownerFirstName: profile.user.name.split(' ')[0],
      mode: 'owner_fact',
      finalOutcomeContext,
      recentHistorySnippet,
      priorCalendarReadLines,
    });

    // Unknown is distinct from clear. Preserve an unchanged legitimate reply;
    // never accept an unverified semantic rewrite when the check is unavailable.
    if (verdict.failed_open) return cleanReply === originalDraft
      ? cleanReply : genericHonestHedge(originalDraft, isOwnerDirectAudience(ctx));
    if (!verdict.claimed_action) return cleanReply;
    if (['permission_granted', 'book', 'message', 'task'].includes(verdict.action_type ?? '')) {
      return genericHonestHedge(cleanReply, isOwnerDirectAudience(ctx));
    }

    let rewriteSummaries = result.toolSummaries ?? [];
    if (verdict.action_type === 'denied_calendar_read') {
      // The semantic judge cannot manufacture a receipt or target identity.
      const target = verdict.target_name?.toLowerCase();
      const matching = priorCalendarReadLines.filter(line =>
        line.match(/ calendars_read=([^\s\]]+)/)?.[1].split('+').includes(target ?? ''));
      if (!target || !matching.length) return cleanReply;
      rewriteSummaries = matching;
    }

    // owner-fact-check-deletes-true-attendee-availability-clause (2026-09-09)
    // — do NOT add an `attendee_check=` shield here. That marker means "a real
    // check evaluated someone OTHER than the owner" (turnHelpers.ts
    // attendeeCheckSource, which explicitly never stamps owner-availability
    // tools), so it is not grounding for the owner's personal-fact class.
    // The historical-denial class above requires calendars_read instead.
    // The attendee_check marker is also carried by
    // every ordinary `find_available_slots` call with an attendee — measured on
    // the live VM over the 14 days to 2026-09-09, ALL of this check's firings
    // (06:25:57 / 12:00:37 / 12:03:32 on 09-07, each a genuine ungrounded claim
    // about Idan) sat on a turn whose own tape carried `attendee_check=slots`,
    // so such a shield would suppress the guard on essentially every scheduling
    // turn — the 2026-08-14 incident shape included. The tool-grounding this
    // mode actually needs is already in its prompt (condition (a): a matching
    // read in TOOL ACTIVITY THIS TURN makes the claim grounded).
    logger.warn('Colleague fact check: flagged claim routed to tool-less veto rewrite', {
      senderId: ctx.senderId,
      threadTs: ctx.threadTs,
      action_summary: verdict.action_summary,
      action_type: verdict.action_type,
    });

    const rewritten = await rewriteOwningTheMiss({
      draft: cleanReply,
      deletionOnly: true,
      actionSummary: verdict.action_summary,
      actionType: verdict.action_type,
      targetName: verdict.target_name,
      ownerFirstName: profile.user.name.split(' ')[0],
      toolSummaries: rewriteSummaries,
      isOwnerAudience: isOwnerDirectAudience(ctx),
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
    // (buildTurnContext.ts:778) — so the two surfaces name a moment in the same clock.
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
 *   1. Is there a real availability verdict THIS turn? Three producers count:
 *      `find_available_slots` / `check_join_availability` tool-summary lines
 *      (turnHelpers.ts's `renderToolSummary` — the exact lines Sonnet herself
 *      saw, never re-derived or re-parsed here, per G2), and — since
 *      2026-08-30 — the availability precheck's synthetic
 *      `[availability_precheck …]` lines (availabilityPreCheck.ts's
 *      `renderToolSummaryLines`, threaded into toolSummaries by the
 *      orchestrator): the precheck is the DESIGNED zero-tool-call ground
 *      truth for "is he free at X", and before it was threaded in, this mode
 *      rewrote its correct answers as ungrounded (Mike Naumenko,
 *      2026-08-30T13:35Z). Absent on the vast majority of turns, which never
 *      touch availability at all — nothing loads, nothing costs anything.
 *      bug 1.1 (2026-08-27) exception: when
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
 * bounce-fix (2026-08-26) tried to add EARLIER turns' confirmations via the
 * prose `recentHistorySnippet`; replaced 2026-09-09 by the earlier turns'
 * search LINES themselves (`priorTurnAvailabilityLines` above) — see that
 * function for why the prose never grounded anything.
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
  // the two availability tools, plus the availability precheck's synthetic
  // `[availability_precheck …]` verdict lines (2026-08-30), verbatim (never
  // re-derived). Absent on this turn ⇒ nothing to ground a claim against ⇒
  // nothing to check.
  const thisTurnLines = (result.toolSummaries ?? []).filter(line => AVAILABILITY_LINE_HEAD.test(line));
  // bug 1.1 (2026-08-27, Mike Naumenko / D0ARQRD5H28) — a ZERO-tool-call turn
  // used to bail out here unconditionally, which is exactly how a stale time
  // recalled from three days earlier in the same thread shipped unchecked (no
  // search ran, so this checker never even looked at the draft). When THIS
  // turn was a detected colleague availability question
  // (`availabilityQuestionDetected`, set by `precheckAvailability`'s own `ran`
  // in buildTurnContext.ts), still call the checker with no THIS-turn line —
  // `checkReplyClaims`'s `slotGroundingPrompt` already handles that case
  // correctly by design: it flags any specific-time-as-available claim not
  // backed by this turn's real result OR an `(earlier turn)` line. Scoped to
  // availability-question turns only (not every digit-bearing reply) to avoid
  // a new LLM call on ordinary turns that have nothing to do with
  // availability (G10). Since 2026-08-30 the precheck's own
  // `[availability_precheck …]` lines normally populate `thisTurnLines` on
  // exactly these turns (`ran` ⇒ ≥1 verdict line), so this branch is now the
  // backstop for a threading failure, not the common path.
  if (thisTurnLines.length === 0 && !result.availabilityQuestionDetected) return initialReply;

  // This turn's lines first, then the earlier turns' — see
  // `priorTurnAvailabilityLines` for the incident and why the order and the
  // `(earlier turn)` prefix matter. Handed to the checker AND the rewriter
  // (below) as one list, so a substitution can only ever come from a real
  // search line — the 18:45:37Z rewrite reached for the precheck's
  // alternatives because they were the only lines it was given.
  //
  // slot-grounding-rewrite-substituted-next-day-times-into-a-today-sentence
  // (2026-09-14) — and that is exactly what happened again at 07:39:39Z, in
  // the other direction: the list spanned TWO days (a 2026-09-14 precheck
  // verdict plus 2026-09-15 alternatives) and the rewrite carried the
  // next-day times into the draft's "today" sentence with no date on them.
  // Handing the rewriter the right lines does not make it keep their DAY, so
  // that is now enforced deterministically inside the rewriter over this very
  // list — claimChecker.ts's `substitutedTimeMissingItsDate`.
  const groundedToolLines = [...thisTurnLines, ...priorTurnAvailabilityLines(ctx)];

  let cleanReply = initialReply;
  try {
    const { checkReplyClaims, rewriteOwningTheMiss } = await import('../claimChecker');

    const verdict = await checkReplyClaims({
      reply: cleanReply,
      toolSummaries: result.toolSummaries ?? [],
      bookingOccurred: result.bookingOccurred ?? false,
      ownerFirstName: profile.user.name.split(' ')[0],
      mode: 'slot_grounding',
      slotGroundingContext: { groundedToolLines },
    });

    if (!verdict.claimed_action) return cleanReply;

    logger.warn('Slot-grounding check: draft offers a specific time as available that no real search (this turn or earlier in the thread) confirms — rewriting (no tool re-fire)', {
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
      // validation (claimChecker.ts:875), and a JSON-truncation recovery
      // path can yield an unexpected value. This call site already KNOWS it
      // invoked `mode: 'slot_grounding'` (:1830 above) — trusting an LLM
      // round-trip for control flow it already has the answer to would let a
      // malformed `action_type` silently fall through to the DEFAULT
      // phantom-action rewrite prompt (nonsense like "I'm not sure that went
      // through" on a slot offer) instead of the slot-claim branch.
      actionType: 'ungrounded_slot_claim',
      targetName: verdict.target_name,
      ownerFirstName: profile.user.name.split(' ')[0],
      toolSummaries: result.toolSummaries ?? [],
      groundedToolLines,
      isOwnerAudience: isOwnerDirectAudience(ctx),
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
