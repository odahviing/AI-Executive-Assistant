/**
 * Reply pipeline (v1.6.2 split from app.ts).
 *
 * The stage between "runOrchestrator returned a draft" and "a message lands in
 * Slack". DELIVERY only — the output-time gate stack (deliberation guard,
 * claim-checker, humanGate, date verifier, security gate) lives in
 * `utils/guards/runOutputGates` so transport and gate policy change
 * independently of each other.
 *
 * Steps, in order:
 *   1  Deliberation guard (guard module) on the raw draft.
 *   2  Normalize markdown artefacts (** → *, etc) for Slack rendering, and
 *      park a 'Finishing up' status in the assistant panel.
 *   3  Run the output gate stack (guard module). Owner path and colleague
 *      path are both decided in there; it returns the text to send.
 *   3b Save what the person will actually SEE to conversation history — the
 *      POST-gate text, so the record and the wire can never disagree.
 *   4  Ack-class emoji replacement, then the colleague shadow-notify.
 *   5  Audio vs text branch based on the input modality + TTS availability.
 *   6  Optional approval footer when the orchestrator flagged a pending ask.
 *   7  Social coda, if the turn produced one — its OWN in-thread message a beat
 *      after the reply lands, never a last line glued onto it. On a confirmed
 *      post it closes the social cadence gate and mirrors to the owner's shadow.
 */

import type { App } from '@slack/bolt';
import type { UserProfile } from '../../config/userProfile';
import { appendToConversation } from '../../db';
import type { OrchestratorOutput } from '../../core/orchestrator';
import { formatForSlack } from '../../connections/slack/formatting';
import { config } from '../../config';
import { textToSpeech, sendAudioMessage, shouldRespondWithAudio } from '../../voice';
import logger from '../../utils/logger';
import { runDeliberationGuard, runOutputGates, runCodaGates } from '../../utils/guards/runOutputGates';
import { isThreadActive } from './inboundQueue';
import { getLastMaelleMessage } from '../../utils/threadActivity';
import { recordCodaDelivered } from '../../core/social/logEngagement';
import { composeSocialCoda } from '../../core/social/generateCoda';

export type SenderRole = 'owner' | 'colleague' | 'unknown';

export interface PostReplyInput {
  app: App;
  profile: UserProfile;
  result: OrchestratorOutput;
  say: (msg: { text: string; thread_ts?: string; unfurl_links?: boolean; unfurl_media?: boolean }) => Promise<unknown>;
  role: SenderRole;
  colleagueName?: string;
  senderId: string;
  channelId: string;
  threadTs: string;
  // v2.6.2 — the user's actual message ts (NOT the parent thread anchor when
  // it's a thread reply). Used for ack-class emoji replacement: when Maelle's
  // reply is a pure short ack ("Got it" / "On it" / "Done"), suppress the
  // text and react 👍 on the user's message instead. Optional for back-compat;
  // when omitted, ack-replacement is skipped and the reply posts as text.
  userMessageTs?: string;
  // Turn inputs the gate stack reads (prior-turn mutation markers for the
  // claim-checker shield, the spoof scan, the date verifier's anchor). Passed
  // straight to runOutputGates.
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * The sender's OWN words for this turn — transport framing excluded (see
   * `ProcessMessageParams.framing` in app/context.ts). Handed to the gate stack,
   * and — the reason the distinction is load-bearing — rendered back to the
   * OWNER by the Step 4.6 mirror as `X said: "…"`. Pass the framed string here
   * and the owner reads Maelle's own group-DM preamble as his colleague's
   * sentence, with the real words pushed past the preview cap (GH #150).
   */
  userMessage: string;
  /**
   * v4.3.x (#144) — a description of a non-text payload this turn
   * carried (today: the Haiku vision description of an attached image,
   * already computed once at ingestion for the history string — see
   * processMessage.ts's `imageDescPart`). Optional, and DELIBERATELY not
   * folded into `userMessage` itself: `userMessage` also feeds the Step 3
   * gate stack (runOutputGates — claimChecker/humanGate/securityGate read
   * it), and overloading it would silently change what those gates see.
   * This field is consumed ONLY by the Step 4.6 shadow-mirror receipt: an
   * owner-facing receipt should report what the message CONTAINED, not just
   * its text field — "(image attached)" with no description already
   * computed is a receipt that failed.
   */
  inboundAttachmentNote?: string;
  isMpim?: boolean;
  // True when this turn arrived in a real channel (not a DM, not an MPIM). The
  // missing sibling of isMpim — the pipeline needs the full posture to decide
  // what it may deliver on its own initiative (the social coda is 1:1-DM-only)
  // and to address the inbound queue by the same key the inbound side used.
  isChannel?: boolean;
  isOwnerInGroup?: boolean;
  mpimMemberIds?: string[];
  voiceInput?: boolean;
  /**
   * Fired the instant something from this turn is in front of the person — the
   * reply text, the audio clip, or the 👍 that stands in for a one-word ack.
   * Nothing else counts: not a tool that DM'd a third party, not a history row.
   *
   * Its one consumer is the caller's failure handler. A throw AFTER delivery is
   * reachable (the approval footer's own `say`, the threadActivity import at the
   * tail of sendReply), and an "I'm having trouble" posted on top of an answer
   * the person is already reading is a worse bug than the one it apologises for.
   * A callback rather than a return value because a return value cannot survive
   * the throw it is needed for — same shape, same reason, as the queue's
   * `markWrite`.
   */
  onDelivered?: () => void;
}

/**
 * v2.6.2 — pure-ack reply detector for the emoji-replacement path.
 *
 * A reply qualifies as a pure ack when it's short AND matches one of a small
 * set of single-phrase acknowledgments — "Got it", "On it", "Done", "Noted",
 * "Sure", "Okay", "Will do", and minor variants (case-insensitive, with
 * trailing . / !). When the reply has any actual content (a name, a time, a
 * follow-up question, a clarification), it does NOT qualify and posts as
 * text.
 *
 * Conservative by design — false negatives (a real ack posts as text) are
 * fine; false positives (a content reply gets swallowed into a reaction) are
 * the failure mode to avoid. Owner direction: "no free spirit for now."
 */
function isPureAckReply(reply: string): boolean {
  const trimmed = reply.trim();
  if (trimmed.length === 0 || trimmed.length > 30) return false;
  // Strip a single trailing emoji or punctuation cluster if present.
  const normalized = trimmed
    .replace(/[!.…]+$/, '')
    .replace(/^[!.…]+/, '')
    .trim()
    .toLowerCase();
  // Allowed single-phrase acks. Conservative — extend only when a real case
  // surfaces; over-eager additions risk swallowing content.
  const ACK_PHRASES = new Set([
    'got it',
    'got it!',
    'on it',
    'done',
    'noted',
    'sure',
    'sure thing',
    'will do',
    'okay',
    'ok',
    'thanks',
    'thank you',
    'all set',
    'sounds good',
    'no problem',
    'np',
    'cool',
  ]);
  return ACK_PHRASES.has(normalized);
}

/**
 * Shadow-mirror preview. Flattens to one line and caps with an ellipsis, so a
 * real overflow reads as truncated rather than ended. Cap was raised from 200
 * because it cut a normal slot proposal / colleague ask off mid-sentence.
 * Shared by the conversation mirror (Step 4.6) and the coda mirror.
 */
const SHADOW_PREVIEW_MAX = 350;
function shadowPreview(s: string | undefined): string {
  const flat = (s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > SHADOW_PREVIEW_MAX ? `${flat.slice(0, SHADOW_PREVIEW_MAX).trim()}…` : flat;
}

// ── Social coda — a separate message, not a last line ───────────────────────

/**
 * How long after the reply LANDS the coda follows. Owner's call: 10 seconds —
 * long enough to read as a second thought rather than a swerve in the first
 * one. Measured from delivery of the reply, not from the inbound message: a
 * turn can take 30s, so anchoring on the inbound would collapse the beat to
 * zero and reproduce the very run-on the split exists to fix.
 */
const CODA_DELAY_MS = 10_000;

/**
 * Deliver the social coda as its OWN in-thread message, a beat after the reply.
 *
 * It used to be concatenated (`reply + "\n\n" + coda`), so a Sydney slot
 * proposal ended on an unrelated social line and read as a non-sequitur
 * ("…17:30 Sydney. Any trips coming up?"). The orchestrator now settles only
 * ELIGIBILITY during the turn and hands over a `PendingSocialCoda` — a directive,
 * not a sentence. Composition and delivery both happen here, inside the beat.
 *
 * Contract:
 * - SAME thread (S3), always — never a new top-level message. It is a follow-on
 *   to the reply, not a new topic.
 * - TEXT, never audio, even when the turn came in as a voice note. TTS exists so
 *   an answer comes back in the modality it was asked in; the coda was not asked
 *   for. A one-line social question you can read at a glance beats a second clip
 *   the person has to play.
 * - Scheduled only from a delivery-SUCCESS point, so a reply that failed to send
 *   can never be followed by a cheerful aside about someone's weekend.
 * - Dropped if the person has typed again by the time it fires — the coda's
 *   premise is a lull, and a lull broken inside 10s wasn't one.
 * - 1:1 DM only (S4/S6). The orchestrator already restricts it; asserted again
 *   here so no future caller can put personal small-talk in a shared surface.
 * - Fire-and-forget: it cannot delay, fail or crash the turn. Nothing on this
 *   path is ever awaited by the person's reply — composition included, which is
 *   the whole reason it moved in here.
 * - A confirmed post is what closes the social gate (`recordCodaDelivered`) and
 *   what the owner's shadow mirror reflects. Nothing is charged, and nothing is
 *   reported to the owner, for a coda that never went out.
 *
 * Order inside the beat, and why it is that order: lull checks → compose →
 * gate → post. Everything that can drop the coda for free runs before anything
 * that costs a model call, so the common "they started typing again" case spends
 * nothing. Composition is one call into the social lane (`composeSocialCoda`) —
 * we ask for a sentence and get a sentence or null; the payload is theirs, the
 * timing is ours.
 *
 * Gate coverage: the coda does NOT run the reply gate stack — it runs the
 * guard-owned `runCodaGates` instead (utils/guards/runOutputGates), which owns
 * the whole ship-or-drop decision and explains there why the reply stack's gates
 * are wrong for this message. Together with the `claimChecker mode='coda'`
 * validator inside `composeSocialCoda` and the cross-cutting
 * `scrubInternalLeakage` inside formatForSlack, that is the coda's vetting.
 */
function scheduleSocialCoda(opts: {
  coda: OrchestratorOutput['socialCoda'];
  say: PostReplyInput['say'];
  profile: UserProfile;
  senderId: string;
  colleagueName?: string;
  channelId: string;
  threadTs: string;
  role: SenderRole;
  isMpim: boolean;
  isChannel: boolean;
}): void {
  const { coda, say, profile, senderId, colleagueName, channelId, threadTs, role, isMpim, isChannel } = opts;
  if (!coda) return;

  const isOneOnOneDm = !isMpim && !isChannel;
  if (!isOneOnOneDm) {
    logger.warn('Social coda suppressed — not a 1:1 DM', { threadTs, isMpim, isChannel });
    return;
  }

  // The one thing still done before the timer, guarded, and every failure DROPS
  // the coda. Fail-CLOSED here is the inverse of the reply gates' fail-open
  // contract, and it is right precisely because nothing is lost by staying quiet
  // — a social aside is optional by definition. The guard also makes "cannot
  // fail the turn" literally true: this runs at two delivery-success points, one
  // of them inside the ack branch's try, where a throw would fall through to the
  // fallback text send and duplicate an already-acked reply. It has to stay out
  // here: it is the BASELINE the fire-time check compares against, so reading it
  // 10s later would compare the thread to itself and never detect a new turn.
  let replyTsAtSchedule: string | null;
  try {
    // The reply we are trailing. Two cheap lookups at fire time decide whether
    // the lull survived the 10s: the inbound queue answers "is a turn running or
    // queued RIGHT NOW" (the person typed and we are already answering), and
    // this snapshot answers "did a whole turn come and go" — a fast follow-up
    // (the deterministic approval auto-resolve returns in ~300ms) can start and
    // finish inside the window, leaving the queue idle again. Together they
    // mean: nothing happened in this thread since the reply landed.
    replyTsAtSchedule = getLastMaelleMessage(threadTs)?.messageTs ?? null;
  } catch (err) {
    logger.warn('Social coda prep threw — dropping the coda (fail closed)', {
      threadTs, err: String(err).slice(0, 200),
    });
    return;
  }

  setTimeout(() => {
    void (async () => {
      try {
        if (isThreadActive(channelId, threadTs, isOneOnOneDm)) {
          logger.info('Social coda dropped — the person is talking again, the lull is gone', {
            threadTs, personSlackId: coda.personSlackId,
          });
          return;
        }
        const replyTsNow = getLastMaelleMessage(threadTs)?.messageTs ?? null;
        if (replyTsNow !== replyTsAtSchedule) {
          logger.info('Social coda dropped — another turn already answered in this thread', {
            threadTs, replyTsAtSchedule, replyTsNow,
          });
          return;
        }
        // WRITE the coda — here, and not a moment earlier. This is the first
        // point at which the line is certainly going to be offered: both lull
        // checks are behind us, so a coda the lull already killed now costs
        // nothing at all — no Sonnet call, no claim-check, no burnt topic beat.
        //
        // It used to be composed during the turn, which put two round-trips
        // between "answer ready" and "answer posted": the person waited on their
        // WORK reply so that a social aside could be written — one the transport
        // then deliberately sits on for 10 seconds. Social never delays real
        // work. The 10s beat is dead time and is the right place to spend it.
        //
        // ONE call into the social lane, by design. Composing and vetting are its
        // job, and the vet needs the person's notes; splitting the two would have
        // meant assembling that snapshot out here, putting someone's private
        // memory in the pipes for no reason the pipes have. Only the finished
        // sentence crosses. Total by contract — null means "nothing to post".
        const composed = await composeSocialCoda(coda, profile);
        if (!composed) {
          logger.info('Social coda not composed — nothing to post', {
            threadTs, personSlackId: coda.personSlackId,
          });
          return;
        }
        const text = formatForSlack(composed.trim());
        if (text.length === 0) return;

        // Guard-owned ship/drop verdict, LAST so it is never spent on a coda the
        // lull checks above already killed. Inside the timer on purpose: the 10s
        // beat is dead time, so the check adds nothing to any user-visible path —
        // not the reply (already delivered), not the turn (fire-and-forget).
        const gate = await runCodaGates(text, { profile, role });
        if (!gate.ship) {
          logger.warn('Social coda dropped by the coda gate — never rewritten', {
            threadTs, role, droppedBy: gate.droppedBy, codaPreview: text.slice(0, 80),
          });
          return;
        }
        // Social bookkeeping — the once-per-day cadence gate + the subject
        // raise-marker — goes in on the line BEFORE the post, not after.
        //
        // A DB write either side of a network call leaves residue; the choice is
        // which side carries it. AFTER: posted, gate still open → the same person
        // can be pinged twice today (the 3-codas-in-8-minutes class the owner
        // reported). BEFORE: gate burned, nothing posted → one silent skipped
        // social day, self-healing in 24h. Cheap side wins — but the decisive
        // reason is subtler: a `say` REJECTION does not prove the message didn't
        // land (an accepted post whose response times out throws here), so
        // stamping only on success would leave the gate open on a coda the person
        // is looking at. Stamping first is correct, not merely cheaper. Every
        // drop path — both lull checks, the prep guard, an empty compose,
        // runCodaGates — already sits above this line, so the original bug
        // (charging a ping for a coda nobody saw) stays fixed either way. Never
        // throws by contract.
        recordCodaDelivered({ personSlackId: coda.personSlackId, subjectId: coda.subjectId });
        await say({ text, thread_ts: threadTs, unfurl_links: false, unfurl_media: false });
        // History, so the NEXT turn knows she asked — otherwise she re-asks, or
        // misreads the answer ("yeah, Berlin", with no memory of the question).
        // Written only after a confirmed post, and only on the quiet-thread path,
        // so history can never claim a coda the person never saw or interleave
        // one behind a message that arrived first.
        //
        // Deliberately NOT recordMaelleMessage(): that names the message the
        // completeTask hook reacts ✅ on, and the tick belongs on the task
        // confirmation, not on a question about someone's weekend.
        appendToConversation(threadTs, channelId, { role: 'assistant', content: text });
        logger.info('Social coda posted as its own in-thread message', {
          threadTs, role, delayMs: CODA_DELAY_MS, codaPreview: text.slice(0, 80),
        });

        // Owner receipt (owner's call: "I do want to see the coda in the shadow
        // DM"). Fires only here — after a confirmed post — so a coda the gate
        // dropped or the lull killed is never mirrored as if it had been sent,
        // and it mirrors the exact post-gate string the person received (the same
        // rationale as the v3.0.8 move that put the shadow after the gates).
        //
        // Its OWN shadowNotify call, but NOT a second "Conversation with X"
        // header: the same conversationKey threads it under the anchor Step 4.6
        // cached (shadowNotify.ts:95), so the owner sees one conversation with the
        // coda as a labelled line inside it. Labelled 'Social coda' because
        // telling it apart from the reply at a glance is the whole point of the
        // request. Colleague-facing only — the owner doesn't need his own DM
        // mirrored back, and the senderId check excludes him. (No isOwnerInGroup
        // check: the coda is 1:1-DM-only, asserted above, and that clamp only
        // exists inside an MPIM.)
        if (role === 'colleague' && senderId !== profile.user.slack_user_id) {
          const who = colleagueName ?? senderId;
          const { shadowNotify } = await import('../../utils/shadowNotify');
          await shadowNotify(profile, {
            channel: channelId,
            threadTs,
            action: 'Social coda',
            detail: `I → ${who}: "${shadowPreview(text)}"`,
            conversationKey: threadTs,
            // Identical to Step 4.6's header so a re-anchor (approval turn, or a
            // restart that lost the cache) can't label the same conversation two
            // different ways.
            conversationHeader: `Conversation with ${who}`,
          });
        }
      } catch (err) {
        logger.warn('Social coda post failed — dropped, turn unaffected', {
          threadTs, err: String(err).slice(0, 200),
        });
      }
    })();
  }, CODA_DELAY_MS);
}

export async function postOrchestratorReply(input: PostReplyInput): Promise<void> {
  const {
    app, profile, result, say,
    role, colleagueName,
    senderId, channelId, threadTs,
    history, userMessage, inboundAttachmentNote, isMpim, isChannel, isOwnerInGroup, mpimMemberIds, voiceInput,
    onDelivered,
  } = input;
  const { assistant } = profile;

  // v1.6.4 — if the orchestrator produced an empty reply (no tools, no text,
  // or a stuck loop) we do NOT fabricate a "Done." or equivalent. We post
  // nothing and log. The owner seeing silence in their thread is a clearer
  // signal that something went wrong than a fake confirmation.
  if (!result.reply || result.reply.trim().length === 0) {
    logger.warn('postOrchestratorReply: empty reply from orchestrator — posting nothing', {
      senderId, threadTs, channelId,
      toolSummaries: result.toolSummaries ?? [],
    });
    return;
  }

  // Step 1 — deliberation guard. When Sonnet emits a single text block with her
  // derivation embedded ("wait,", "let me find", "OK definitive proposal"), strip
  // that narration and keep the answer. Backstops the base-prompt anti-
  // deliberation rule when Sonnet ignores it. Rare (a couple of fires a week) and
  // it never shortens an answer — a rewrite that drops a fact is discarded.
  // Falls back to the original draft on any error.
  const finalReply = await runDeliberationGuard(result.reply, profile);

  // Step 2 — normalize markdown → Slack mrkdwn.
  let cleanReply = formatForSlack(finalReply);

  // Step 2a (v3.0.2) — surface a status in the assistant panel while the
  // gate stack runs. Between "last tool returned" and "message lands" we
  // burn 4-8s on humanGate + claimChecker + dateVerifier + securityGate
  // (Haiku passes now; the claim-checker's honesty rewrite is a tool-less pass,
  // not an orchestrator re-invoke). Pre-v3.0.2 the panel froze on the last tool's verb
  // ("Checking the calendar"…) or went blank if no tool fired. Single
  // 'Finishing up' status covers the whole stack. Fire-and-forget, same
  // pattern as the orchestrator's pre-tool and turn-start status hooks.
  // Slack rejects non-panel calls; setAssistantStatus swallows at debug.
  if (channelId && threadTs) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { setAssistantStatus } = require('../../connections/slack/messaging') as
        typeof import('../../connections/slack/messaging');
      void setAssistantStatus(app, profile.assistant.slack.bot_token, {
        channelId, threadTs, status: 'Finishing up',
      });
    } catch (_) { /* helper failure is non-fatal */ }
  }

  // Step 3 — the output-time GATE STACK (guard lane, utils/guards/runOutputGates).
  //
  // WHICH gates run on which leg, in WHAT order, and what a verdict may do about
  // the text are that module's policy, not this pipeline's — canonical note in its
  // own module header. This comment used to carry a COPY of the order, and it went
  // stale the moment guard moved date-verify last on the colleague leg (P20): a
  // pointer cannot rot, a duplicated enumeration did. Don't re-add one here.
  //
  // What the delivery pipeline is entitled to assume, and no more: the call returns
  // the text to send, and nothing in there re-enters the orchestrator (G4). Since
  // guard's P26 it also always DOES return — every await and every rewrite on both
  // legs now sits inside a try. But returning is not the same as returning the
  // DRAFT, and the two unavailability cases were given deliberately different
  // behaviours that this pipeline must not flatten: the spoof-input db read fails
  // OPEN (the answer is untouched, and all three inputs are cleared together so the
  // identity half stands down as a unit rather than running half-fed), while the LEAK
  // gate fails SAFE — a fixed line of guard's own text, an ERROR log carrying the
  // draft it dropped, and delivery, history and the remaining gates all carry on. So
  // a gate failure costs the ANSWER, never the DELIVERY, and what lands back here can
  // be text that no draft ever contained. Which is the sharpest reason the history
  // write sits BELOW this line and not above it — see Step 3b.
  cleanReply = await runOutputGates(cleanReply, {
    profile, result,
    history, userMessage,
    senderId, channelId, threadTs,
    role, colleagueName, isMpim, isOwnerInGroup, mpimMemberIds,
  });

  // Step 3b — persist history, and NOT one line above the gate stack, where this
  // write used to live. Up there the record kept the PRE-gate draft while the person
  // received the post-gate one: the owner leg papered over half of it (the claim
  // rewriter and the date swapper each append their correction), but the colleague
  // leg's rewriters — securityGate, humanGate — append nothing, so a leak the gates
  // caught and scrubbed was stored intact and replayed three ways: the next turn's
  // model context (processMessage.ts:256), `recall_interactions`
  // (core/assistant.ts:552), and the capture pass that mines the transcript for the
  // social subjects the coda is built from (memory/capturePass.ts:418). The gates
  // protected the wire and not the record — 2026-07-26 08:42:57, humanGate rewrote a
  // colleague reply in thread 1784807021.443139; it also changed the QUESTION the
  // draft asked, so history had Maelle asking something she never asked.
  //
  // A third corrective append was not the fix: appendToConversation only appends,
  // then trims to the last 20 (db/conversations.ts:33-35), so the leaky row stays in
  // the blob — still replayed, still feeding the capture pass — and evicts a real
  // message to sit there. One write, of the vetted text, where the vetted text exists.
  //
  // Safe to move because nothing in between reads the stored blob: formatForSlack is
  // a pure transform, setAssistantStatus is a Slack call, and the gate stack reads
  // the `history` ARRAY it was handed — snapshotted at message arrival, before even
  // this turn's user row — so it cannot see this write from either side of the move.
  // Below the gates is also the more honest record twice over: when the leak gate is
  // unavailable it SUBSTITUTES a fixed line for the draft rather than passing it
  // through (Step 3), so a row written above the gates would preserve, and then
  // replay, a draft that nothing vetted and that the colleague never saw — while the
  // person holds the substitute; and `cleanReply` has been through formatForSlack, which is
  // where scrubInternalLeakage runs — the pre-gate draft never was, so history also
  // used to keep raw slack ids, Graph ids and verbatim tool names.
  //
  // The tool markers stay RAW on purpose: the claim-checker's truthful-recap shield
  // reads `mutated=<domain>` out of prior assistant rows and the scrubber strips tool
  // names, so formatting the action tape would erase the evidence the shield needs.
  // Only the prose half is the scrubber's business.
  //
  // ABOVE Step 4.5, so the ack-reaction branch — which returns before Step 5 — still
  // records the answer its 👍 stood in for, exactly as it did before.
  appendToConversation(threadTs, channelId, {
    role: 'assistant',
    content: result.toolSummaries?.length
      ? `${result.toolSummaries.join(' ')}\n${cleanReply}`
      : cleanReply,
    // v4.4.10 — stamp a synthetic ts even though the real Slack ts isn't known
    // yet (chat.postMessage hasn't run — that's Step 5, below). Wall-clock at
    // write time, in Slack ts format (unix seconds, 6-decimal fraction).
    //
    // processMessage.ts's channel/MPIM catch-up merge sorts
    // `[...dbHistory, ...missedMessages]` by `parseFloat(m.ts || '0')`. An
    // un-stamped assistant row parses to 0 and the sort puts EVERY one of
    // Maelle's own past replies at the very front of the merged history,
    // ahead of every real message — scrambling the order the model sees on
    // every catch-up merge, independent of (and in addition to) the
    // duplication bug the `m.user !== ctx.botUserId` exclusion above already
    // closed (processMessage.ts:360). This write runs strictly after the
    // user's message ts and strictly before this turn's real Slack post, so
    // the synthetic value sorts correctly relative to both.
    ts: (Date.now() / 1000).toFixed(6),
  });

  // Step 4.5 (v2.6.2) — ack-class emoji replacement. When the cleaned reply
  // is a pure short ack ("Got it" / "On it" / "Done" / "Noted" / "Sure"),
  // suppress the text reply and react 👍 on the user's message instead.
  // Owner direction: "if nothing smart to say, we can say 👍 = positive ack."
  // Conservative match — single-phrase, ≤30 chars, no punctuation other
  // than . / !. Reply with actual content always posts as text.
  // Skipped when: voice input (audio path expects text), no userMessageTs
  // (can't react), already an emoji-only reply.
  const userMsgTs = (input as PostReplyInput).userMessageTs;
  if (!voiceInput && userMsgTs && isPureAckReply(cleanReply)) {
    // Same shape as the audio branch below, for the same reason: this catch
    // FALLS THROUGH TO A TEXT SEND, so nothing that runs after the reaction has
    // landed may sit inside the try — a throw in there would post the same
    // answer a second time.
    let ackPosted = false;
    try {
      await app.client.reactions.add({
        token: assistant.slack.bot_token,
        channel: channelId,
        timestamp: userMsgTs,
        name: '+1',
      });
      ackPosted = true;
    } catch (err) {
      logger.warn('Ack-replacement reaction failed — falling back to text', {
        err: String(err).slice(0, 200),
      });
      // Fall through to send text.
    }
    if (ackPosted) {
      logger.debug('Ack-class reply replaced with 👍 reaction', {
        senderId, threadTs, replyPreview: cleanReply.slice(0, 40),
      });
      // The reaction IS the reply, so this is a delivery like any other.
      onDelivered?.();
      // The reaction IS the reply and it landed, so the coda's beat starts here
      // too. Without this the ack path — which returns before Step 5 — would
      // silently swallow every coda that rode a one-word task confirmation.
      scheduleSocialCoda({
        coda: result.socialCoda, say, profile, senderId, colleagueName,
        channelId, threadTs, role,
        isMpim: isMpim === true, isChannel: isChannel === true,
      });
      return;  // No text post; the reaction IS the reply.
    }
  }

  // Step 4.6 (v3.0.8) — shadow-notify the owner about the colleague-facing
  // exchange. MOVED here from orchestrator/index.ts so the shadow reflects
  // the POST-GATE text (what the colleague actually sees) rather than the
  // raw pre-gate draft. Pre-fix the shadow fired from inside the orchestrator
  // BEFORE postReply.ts ran humanGate / securityGate / claim-checker;
  // when those gates rewrote a leaky draft (request ID in colleague reply,
  // bot-tell phrasing, etc.) the colleague got the clean version but the
  // shadow showed the leaky version. Confusing for the owner: he thought
  // colleagues saw leaks they never saw. Now shadow mirrors `cleanReply`
  // — the same string that's about to land in the colleague's DM.
  if (
    role === 'colleague' &&
    !isOwnerInGroup &&
    // The owner clamped to colleague-context in a channel (v3.7.0) is not a real
    // colleague — don't shadow him about his own conversation. (!isOwnerInGroup
    // already handles the MPIM clamp; this closes the channel case.)
    senderId !== profile.user.slack_user_id &&
    !result.requiresApproval &&
    cleanReply &&
    cleanReply.trim().length > 0
  ) {
    try {
      const { shadowNotify } = await import('../../utils/shadowNotify');
      const who = colleagueName ?? senderId;
      const replyPreview = shadowPreview(cleanReply);
      // v4.3.x (#144) — fold in the attachment description (already
      // computed at ingestion, zero new LLM calls) so the owner reads what
      // the picture actually showed, not just "(image attached, no
      // caption)". Same bracket shape processMessage.ts already uses when
      // persisting the turn to history — reused, not reinvented.
      const rawInboundPreview = shadowPreview(userMessage);
      const inboundPreview = inboundAttachmentNote && inboundAttachmentNote.trim().length > 0
        ? `[Image${inboundAttachmentNote}] ${rawInboundPreview}`
        : rawInboundPreview;
      const distinctTools = [...new Set(
        (result.toolSummaries ?? [])
          .map(s => s.match(/^\[([a-z0-9_]+)/)?.[1] ?? '')
          .filter(name => name.length > 0)
      )];
      const toolHint = distinctTools.length > 0 ? ` (${distinctTools.join(', ')})` : '';
      // v3.1.2 fix (#117) — ONE shadow per turn, not two. The v3.0.8 split
      // ("shadow post-gate", cc1ca30) put inbound + outbound in separate
      // shadowNotify calls, each rendering its own "Conversation with X"
      // header — owner saw a doubled DM stream. Re-merged: one post carrying
      // both sides under a single conversationHeader. If inbound text is
      // empty (reaction-only event), the outbound stands alone.
      const combinedDetail = inboundPreview.length > 0
        ? `${who} said: "${inboundPreview}"\nI → ${who}: "${replyPreview}"${toolHint}`
        : `I → ${who}: "${replyPreview}"${toolHint}`;
      await shadowNotify(profile, {
        channel: channelId,
        threadTs,
        action: 'Reply',
        detail: combinedDetail,
        conversationKey: threadTs,
        conversationHeader: `Conversation with ${who}`,
      });
    } catch (err) {
      logger.warn('Inbound-colleague shadow notify threw — continuing', { err: String(err) });
    }
  }

  // Step 5 — audio vs text. The answer itself; everything below is a trailer.
  await sendReply({
    app, botToken: assistant.slack.bot_token,
    channelId, threadTs,
    cleanReply,
    voiceInput: voiceInput === true,
    say,
    onDelivered,
  });

  // Step 6 — approval footer, if any.
  if (result.requiresApproval && result.approvalId) {
    const approvalMsg =
      `To approve: \`approve ${result.approvalId}\`\n` +
      `To reject: \`reject ${result.approvalId}\``;
    await say({ text: approvalMsg, thread_ts: threadTs });
  }

  // Step 7 — the social coda, as its own message. LAST on purpose: everything
  // this turn owes the person is already in Slack, so the coda can only ever
  // follow the answer, never precede or replace it. If Step 5 threw, we never
  // get here — a failed reply is not followed by small talk.
  scheduleSocialCoda({
    coda: result.socialCoda, say, profile, senderId, colleagueName,
    channelId, threadTs, role,
    isMpim: isMpim === true, isChannel: isChannel === true,
  });
}

// ── Delivery ───────────────────────────────────────────────────────────────

/**
 * Audio branch: voice input + TTS available + short-enough reply → audio.
 * Anything else → text via say(). Never block text on audio failure.
 */
async function sendReply(opts: {
  app: App;
  botToken: string;
  channelId: string;
  threadTs: string;
  cleanReply: string;
  voiceInput: boolean;
  say: (msg: { text: string; thread_ts?: string; unfurl_links?: boolean; unfurl_media?: boolean }) => Promise<unknown>;
  onDelivered?: () => void;
}): Promise<void> {
  const useAudio = shouldRespondWithAudio({
    inputWasVoice: opts.voiceInput,
    responseText: opts.cleanReply,
  });

  if (useAudio && config.OPENAI_API_KEY) {
    // `audioSent` rather than a `return` inside the try, because the delivery
    // callback has to fire OUTSIDE it: anything thrown between here and the
    // return gets read as "audio failed" and falls through to a text send, so a
    // callback raising in there would post the same answer twice.
    let audioSent = false;
    try {
      const audioBuffer = await textToSpeech(opts.cleanReply);
      await sendAudioMessage({
        app: opts.app,
        botToken: opts.botToken,
        channelId: opts.channelId,
        threadTs: opts.threadTs,
        audioBuffer,
      });
      audioSent = true;
    } catch (audioErr) {
      if (opts.voiceInput) {
        logger.warn('Audio response failed — falling back to text', { err: String(audioErr) });
      } else {
        logger.debug('Audio TTS unavailable — using text', { err: String(audioErr) });
      }
      // Fall through to text.
    }
    if (audioSent) {
      opts.onDelivered?.();
      return;
    }
  }
  // v2.6.5 — capture the posted message ts and record it on threadActivity.
  // The unconditional ✅ react that lived here in v2.6.2 was annoying mid-flow
  // — it fired on every Maelle reply regardless of whether the activity was
  // complete. Replacement: tasks/index.ts:completeTask now reacts ✅ on the
  // most recent Maelle message in the thread when an actual task transitions
  // to completed. The recordMaelleMessage call below is what gives that hook
  // a target to react on. No reaction here.
  // Bolt's `say` returns ChatPostMessageResponse at runtime even though the
  // surface type is Promise<unknown> (postReply abstracts from app-direct).
  // v3.2.6 — suppress Slack link/media unfurl on Maelle's replies. An EA's
  // replies (esp. a news answer with many source links) shouldn't balloon into
  // a wall of previews. Cited links stay clickable; they just don't auto-expand.
  const sayRes = await opts.say({ text: opts.cleanReply, thread_ts: opts.threadTs, unfurl_links: false, unfurl_media: false }) as
    | { ts?: string; ok?: boolean } | undefined;
  // The answer is in the thread. Signalled here and not at the end of the
  // function on purpose — the threadActivity import below is a bookkeeping tail
  // that can still reject, and a reply the person is reading must never be
  // followed by an apology for it.
  opts.onDelivered?.();
  if (sayRes?.ts) {
    const { recordMaelleMessage } = await import('../../utils/threadActivity');
    recordMaelleMessage(opts.threadTs, opts.channelId, sayRes.ts);
  }
}
