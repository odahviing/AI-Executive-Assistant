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
 * WHICH gates run is decided by TWO axes, never one role test — see the
 * derivation at the top of runOutputGates. Order:
 *   OWNER-PRIVATE (a 1:1 DM; only the owner ever reads it): claim-check +
 *     humanGate('owner') + date-verify, probed concurrently, exact serial chain
 *     on any flag.
 *   COLLEAGUE-READABLE (a colleague DM, a channel, or the owner in a group DM):
 *     claim-check (only when the owner is the one acting) → security gate →
 *     humanGate('internal') → date-verify. The leak scrub runs after every
 *     rewriter that could emit an internal token, voice after every rewriter
 *     that could write like a machine, and date-verify LAST — after every
 *     rewriter, on both legs, because it is the only check whose subject
 *     (a weekday word) a REWRITER can introduce.
 *
 * NOTHING here re-runs the orchestrator (G4). Every remedy is either a
 * deterministic edit or a single tool-less rewrite pass. And since v4.2.x nothing
 * here writes to conversation history either: postReply persists ONCE, on the text
 * this returns (its Step 3b), so a corrected reply is simply what gets stored
 * — no gate has to chase the record with a second row.
 *
 * NOTHING here throws, and nothing here can cost a person their message. Every
 * gate call is individually try/caught. A VERDICT gate fails OPEN — an error leaves
 * the draft it was handed, so the worst case is that a rare defect ships (G6's safe
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
 * catch answered with the generic failure line instead (processMessage.ts:744,
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
  isOwnerInGroup?: boolean;
  mpimMemberIds?: string[];
}

export async function runOutputGates(draft: string, ctx: OutputGateContext): Promise<string> {
  const {
    profile, result,
    role, colleagueName,
    senderId, channelId, threadTs,
    history, userMessage, isMpim, isOwnerInGroup, mpimMemberIds,
  } = ctx;
  let cleanReply = draft;

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
  //                       Decides the leak gate and the humanGate voice frame.
  //
  // In a 1:1 owner DM and in a colleague's DM those two answers are exact
  // negations of each other, which is why one test carried both for so long. In
  // a GROUP DM they come apart: `role` is already clamped to 'colleague'
  // (processMessage.ts:122) precisely because every colleague in the room reads
  // the reply, while `isOwnerInGroup` says the owner is the one typing. The old
  // single test read that as "owner-facing", so the one colleague-readable
  // surface in the system shipped with NO leak gate and the wrong voice frame —
  // and the SAME room was gated differently depending on who had spoken last.
  //
  // v4.2.x — ownerIsActing now asks its question DIRECTLY, of the authenticated
  // Slack sender, instead of through a proxy that answered it for two surfaces out
  // of three. `role` is derived from exactly this comparison (app.ts:95) and is then
  // CLAMPED to 'colleague' in an MPIM, in a channel, and in colleague-test mode
  // (processMessage.ts:122) — so the old `role === 'owner' || isOwnerInGroup` pair
  // covered the DM and the group DM and silently missed the CHANNEL: the owner
  // @-mentions Maelle in a real channel, she claims she messaged someone or moved
  // something, and the phantom-action check never ran, because the group-DM fix
  // repaired the MPIM half of the clamp with `isOwnerInGroup` and there is no
  // `isOwnerInChannel` on this side of the wire (processMessage.ts:121 computes one
  // and never passes it). Keyed on the authenticated identity in code, this covers
  // every present and future surface without a third flag to plumb or forget
  // (shared rule 10, G2). It can only ADD the honesty check, never drop it:
  // `role === 'owner'` and `isOwnerInGroup` both already imply senderId is the
  // owner's, so this predicate is a strict superset of the pair it replaces.
  //
  // The one surface it newly covers besides the channel is colleague-test mode,
  // and that is correct rather than incidental: the reader there IS the owner, so
  // he is exactly the person the check exists to inform.
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
  // there (systemPrompt.ts:466 "SPEAK TO THE GROUP"), and 'internal' endorses
  // that shape verbatim (humanGate.ts:171). Every other rule in the gate is
  // identical across the two frames, so on a group reply the 'owner' frame could
  // only ever rewrite correct text — a G6 corruption, not a safe miss.
  const audience: HumanGateAudience = colleagueReadable ? 'internal' : 'owner';

  // (v3.6.x — the "booked-date honesty" backstop that used to run between the
  // two legs was RETIRED. It was a 4th output-path LLM call on every booking
  // reply, it depended on a clean ISO instant it didn't reliably get
  // (booked_start sometimes arrives as a display string → a false correction of
  // a correct reply, 2026-07-05), and its job — the wrong-day WRITE — is already
  // stopped upstream by the meeting-core weekday guard. Backstop with a bad data
  // source + zero real catches + one false alarm = not worth the call. G2 / G8.)

  // (v4.1.x — the v1.8.4 colleague "mutation-contradiction" step is RETIRED, and
  // it is the clearest G4 violation the stack had: its remedy was
  // `runOrchestrator(...)`, a SECOND full agentic turn on the reply path, to
  // reword a draft. G4 names re-running the orchestrator as never allowed — an
  // unbounded regeneration can differ from the vetted draft in any way, and it
  // cost seconds of latency plus a whole turn's tokens on the colleague path.
  // Its trigger was also English-only natural-language regex ("flagged it for",
  // "he'll decide") — G7-banned, and useless in Hebrew or Russian. And it never
  // caught anything: ZERO `Colleague draft defers to owner after mutation
  // succeeded` warns across every log on disk.
  //
  // The job it was doing is owned UPSTREAM, where it belongs (G1/G3): the
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
    // claim-check (owner acting only) → security gate → humanGate('internal') →
    // date-verify. The leak scrub runs after every rewriter that could emit an
    // internal token, voice after every rewriter that could write like a machine,
    // and date-verify LAST — see the note at its call below.

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
    // with its own keep-veto, so a wrong fire is a safe miss (G4/G6). Running it
    // FIRST also means its Sonnet-written prose is scrubbed and voice-checked by
    // the two gates below, which the owner-private leg cannot offer it.
    if (ownerIsActing) {
      cleanReply = await runClaimCheckAndMaybeRewrite(ctx, cleanReply);
    }

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
    // for an owner-in-group turn anyway (processMessage.ts:366) — this stops that
    // cross-lane accident from being the only thing holding the branch shut.
    let verifiedSenderEmail: string | undefined;
    let recentUserMessages: string[] | undefined;
    let ownerEmail: string | undefined;
    if (!ownerIsActing) {
      try {
        const { getPersonMemory } = await import('../../db');
        verifiedSenderEmail = getPersonMemory(senderId)?.email ?? undefined;
        recentUserMessages = history
          .filter(h => h.role === 'user')
          .slice(-5)
          .map(h => h.content);
        ownerEmail = profile.user.email;
      } catch (err) {
        // A db read is not a gate verdict, and it must not be able to cost a
        // colleague their answer. Degrade to the leak-scan-only mode the gate
        // already documents — and degrade ALL THE WAY: the spoof branch needs
        // colleagueName + ownerEmail + recentUserMessages TOGETHER
        // (securityGate.ts:456), so a half-filled set is the dangerous state, not
        // the safe one — it would leave detectClaimedEmail running without the
        // sender's verified address, which makes every on-domain email in the
        // thread look like an identity claim and hands a WRONG refusal to a
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
    // runner's catch (processMessage.ts:720) with `delivered` still false, so the
    // colleague got the generic failure line instead of their reply, and nothing was
    // stored either (postReply's history write sits below this call).
    //
    // Fail SAFE, not open — those are different things here, and the difference is
    // the whole point of catching it. This is the LEAK gate: passing the draft
    // through because the gate is unavailable would ship a colleague-facing reply
    // that nothing vetted for the classes only this gate covers (self-as-AI,
    // internals, model/provider, payload echoes, req_/task_ ids, spoof) — the exact
    // fail-open P3 closed one layer down. formatForSlack has already run on this
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
    try {
      cleanReply = formatForSlack(await runSecurityGate({
        reply: cleanReply,
        colleagueName,
        senderId,
        assistantName: profile.assistant.name,
        ownerFirstName: profile.user.name.split(' ')[0],
        verifiedSenderEmail,
        ownerEmail,
        recentUserMessages,
      }));
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
      // off-domain recipients.
      const verdict = await runHumanGate(cleanReply, profile, audience, channelId);
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
    // regex on weekday names is banned anyway, G7). Verifying the pre-rewrite draft
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
 * structurally incapable of corrupting a correct coda (G6). The only action is
 * DROP, and dropping a social aside costs nothing — that asymmetry is what makes
 * an LLM verdict safe to act on here (G4: tool-less + miss-safe).
 *
 *  1. scanForLeaks — the HARD-IDENTIFIER half: raw Slack ids, req_/task_ ids,
 *     provider tokens, JSON / tool-tag echoes. Those patterns are structured and
 *     language-neutral (G7); the handful of English self-AI-claim patterns in the
 *     same list are a bonus, not the coverage (a Hebrew "אני בוט" passes it — see
 *     2). Free, so it runs first and a hit costs no LLM call. It is NOT redundant
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
async function runClaimCheckAndMaybeRewrite(ctx: OutputGateContext, initialReply: string): Promise<string> {
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
    // tool ran earlier is a safe MISS (R7); denying real work is not.
    const priorAssistantText = (ctx.history ?? [])
      .filter(h => h.role === 'assistant')
      .map(h => h.content)
      .join(' ');
    const toolSummariesText = [(result.toolSummaries ?? []).join(' '), priorAssistantText].join(' ');

    // v4.1.x (G2/G3) — READ the carried marker; do not re-derive it.
    //
    // This used to be four action_type branches over a 5-tool, a 2-tool and a
    // 14-tool name alternation, each one added after a distinct incident, and each
    // new mutating tool anywhere in the codebase had to be remembered here or the
    // guard would manufacture a false phantom-action flag. That is the exact
    // maintenance shape G2 exists to prevent, and it was the guard GUESSING at a
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
        // v3.7.x (#B2) — the rewriter must verify against the same tool activity
        // the checker read, so it can't invert a true completed action it can't see.
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
        cleanReply = formatForSlack(rewritten);
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
}): Promise<string> {
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
  return gateResult.reply;
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

    logger.warn('Date verifier: draft has wrong weekday/date pairs — correcting deterministically', {
      senderId: ctx.senderId,
      threadTs: ctx.threadTs,
      mismatches: verdict.mismatches,
    });

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
    if (cleanReply !== initialReply) cleanReply = formatForSlack(cleanReply);
  } catch (err) {
    logger.warn('Date verifier threw — sending original reply', { err: String(err) });
  }
  return cleanReply;
}

// ── Deliberation guard (was the v2.2.5 "concision finalizer") ────────────────
//
// v4.1.x (G1) — this pass was NOT a backstop, it was a routine second drafting
// stage sitting on the critical path of every reply, and it was rewriting correct
// answers into shorter ones. It fired on three shape heuristics — ≥2 question
// marks, ≥2 English "if" branches, or >600 chars of non-list prose — sent the whole
// reply to Sonnet with "stay under 4 short sentences", and had NO fact check at
// all: the only safety net was "is the result shorter". Because it runs before
// postReply persists history, the trimmed version was also what history kept, so
// the fuller answer could not be recovered on the next turn. In the 07-19→07-23
// logs it fired 14 times, and only 2 of those were the deliberation case; the rest
// were length/shape — including a 193-char reply cut to 109 and a 983-char one cut
// to 157. G1: reply length is DRAFTING behavior and belongs to whatever writes the
// draft (prompt / orchestrator output policy), not to a guard.
//
// What survives is the one genuine output-time concern: Sonnet emitting her
// derivation into the user-facing text ("wait, that breaks the order", "let me
// find", "OK definitive clean proposal"). That is a REASONING LEAK — the same
// family as G5 — and the reader should never see it. So:
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
    // G6 — the veto that makes a wrong fire a safe MISS. Same deterministic,
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
