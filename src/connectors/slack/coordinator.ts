/**
 * Slack outreach + utilities (v1.6.0).
 *
 * What lives here:
 *   - handleOutreachReply: triggered by app.ts when a colleague replies to an
 *     outreach — matches the reply to its job (thread anchor or Sonnet
 *     classifier), routes it to the job's own intent handler when it has one
 *     (meeting_reschedule, oof_reengage), and otherwise hands it to the full
 *     orchestrator instead of drafting a reply itself (see the generic-branch
 *     comment inside the function for why — gh#daniel-sharabi-decisive-reply-
 *     stuck-in-continue-loop)
 *   - findSlackUser / openDM: Slack utilities
 *
 * `findSlackChannel` was here too and is GONE (v4.2.x): zero callers, and it was a
 * second copy of connections/slack/messaging.findChannelByName — same
 * conversations.list, same substring filter — which meant a second, separately
 * maintained path that listed private channels. One listing path is enough, and it
 * belongs behind the Connection (W11), not in the connector.
 *
 * What used to live here but is gone in 1.6:
 *   - sendCoordinationDM / handleCoordinationReply / confirmAndBook / handleDecline:
 *     single-colleague `coordination_jobs` flow (table dropped)
 *   - checkExpiredCoordinations + sendScheduledOutreach: replaced by the
 *     requests-spine timer. v3.1 (Path 2): outreach scheduled-send and expiry,
 *     and coord nudge/abandon, are NOT tasks — they live on the request row as
 *     `next_check_at` / `next_check_handler` and are swept by
 *     `core/requests/runner.ts:sweepDueRequests`. The old `type='outreach_send'`
 *     / `type='outreach_expiry'` task types were deleted.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../../llm/client';
import { SONNET } from '../../llm/models';
import { App } from '@slack/bolt';
import { formatForSlack } from '../../connections/slack/formatting';
import { config } from '../../config';
import type { UserProfile } from '../../config/userProfile';
import type { OrchestratorOutput } from '../../core/orchestrator';
import { updateRequest, getOpenRequestsForThread, getRequest } from '../../db/requests';
import { calcResponseDeadline } from '../../utils/responseDeadline';
import { getConnection } from '../../connections/registry';
import {
  updateOutreachJob,
  getOutreachJobsByColleague,
  getLinkedRequestIdForOutreach,
  logEvent,
  type OutreachJob,
} from '../../db';
import logger from '../../utils/logger';

// ── Outreach reply classifier (Sonnet) ───────────────────────────────────────

/**
 * Decides whether the colleague's message continues an open outreach (answers
 * what we asked) or is an unrelated new request. Returning `false` lets the
 * message fall through to the normal inbound pipeline.
 *
 * gh#201-c bouncer overturn (2026-08-16) — a prior version of this file
 * replaced this per-job classifier with one comparative call across every
 * open candidate, on the theory that independent per-job calls let a stale
 * job "outvote" a fresh one (gh#201: Gidon's 07:53 reply allegedly matched a
 * stale 2026-08-13 job instead of his own 07:21 ask). Re-traced: that never
 * happened — the Aug-13 job WAS the correct match (Maelle's own follow-up
 * DM, which Gidon's reply correctly answered), and
 * `getOutreachJobsByColleague` requires `await_reply=1` + an
 * `awaiting_colleague` request state, so the 07:21 turn (which opened no job
 * at all) was never a competing candidate — `allJobs.length === 1` at match
 * time. There was nothing to disambiguate and nothing for a comparative call
 * to differentiate. The replacement also quietly deleted the 2+-candidate
 * disambiguation DM below and defaulted to a silent newest-wins guess — a
 * real safety-valve regression for a genuinely ambiguous case. Reverted to
 * this per-job form; the thread-identity anchor added in the same pass
 * (handleOutreachReply, below) is real and stays.
 */
async function isOutreachReplyByContext(params: {
  newReply: string;
  originalMessage: string;
  conversation: Array<{ role: 'maelle' | 'colleague'; text: string }>;
  colleagueName: string;
  assistantName: string;
}): Promise<boolean> {
  try {
    const anthropic = getAnthropicClient();
    const historyText = params.conversation.length > 0
      ? '\n\nPrior back-and-forth:\n' + params.conversation
          .map(m => `${m.role === 'maelle' ? params.assistantName : params.colleagueName}: ${m.text}`)
          .join('\n')
      : '';

    const prompt =
      `${params.assistantName} previously sent ${params.colleagueName} this message:\n` +
      `"${params.originalMessage}"${historyText}\n\n` +
      `${params.colleagueName} just sent: "${params.newReply}"\n\n` +
      `Is this new message a reply to / continuation of the conversation above, or is it an unrelated new request?\n\n` +
      `Answer with ONLY "reply" or "new". A short acknowledgement, "yes/no/sounds good", a time preference, a follow-up question about the topic, or any feedback on what was asked → "reply". Anything that introduces a new subject, asks for something different, or reads as a fresh incoming request → "new".`;

    const resp = await anthropic.messages.create({
      ...SONNET,
      max_tokens: 10,
      messages: [{ role: 'user', content: prompt }],
    });
    const out = ((resp.content[0] as Anthropic.TextBlock).text ?? '').trim().toLowerCase();
    return out.startsWith('reply');
  } catch (err) {
    logger.warn('isOutreachReplyByContext failed — defaulting to reply', { err: String(err) });
    return true;
  }
}

/**
 * Structured description of a matched outreach job with no routed intent,
 * handed to the full orchestrator as `priorOutboundContext` (same injection
 * point `recentOutboundContext.ts`'s `buildContextBlock` uses) instead of
 * this module drafting the colleague's reply itself.
 * (gh#daniel-sharabi-decisive-reply-stuck-in-continue-loop) — sourced from
 * the job THIS module already matched (thread anchor or
 * `isOutreachReplyByContext` above), never from `recentOutboundContext.ts`'s
 * own, separate, shorter-window mechanism.
 */
function buildOutreachJobContextBlock(job: OutreachJob): string {
  const preview = job.message.slice(0, 400);
  return [
    `AN OUTREACH YOU SENT THIS COLLEAGUE ON THE OWNER'S BEHALF IS STILL OPEN`,
    `You asked ${job.colleague_name}: "${preview}${job.message.length > preview.length ? '…' : ''}"`,
    `Their message just now is almost certainly the reply to that. If it resolves what was asked (a time, a yes/no, an edit), use your real tools to act on it now — never just acknowledge it in words. If it needs the owner's judgment, route it through the normal approval flow.`,
  ].join('\n');
}

/**
 * Primary entry for colleague replies on DM. Called by app.ts before the
 * general orchestrator runs. `handled: true` means the orchestrator is
 * skipped entirely — the reply was fully handled here (disambiguation DM, or
 * an intent-routed handler). `handled: false` means the caller should fall
 * through to the normal orchestrator call; when a matched job carried no
 * routed intent, `priorOutboundContext` is set so that call sees what this
 * job already asked (gh#daniel-sharabi-decisive-reply-stuck-in-continue-loop
 * — see the generic branch below for why this module stopped drafting that
 * reply itself).
 *
 * Side effects:
 *   - Marks the outreach job continued (conversation_json + reply_text) or
 *     hands off to an intent handler (which owns its own terminal closure)
 *   - Re-arms / clears the linked request's reply-deadline timer as needed
 *     (never left un-resolvable — see R3/R4 in the Registrar charter)
 *   - Logs an event
 */
export async function handleOutreachReply(
  app: App,
  params: {
    senderId: string;
    text: string;
    profile: UserProfile;
    bot_token: string;
    /**
     * gh#201-c — the inbound message's own ts and Slack's resolved thread_ts
     * (processMessage.ts's callers already default threadTs to the message's
     * own ts when Slack reports no real thread — same idiom as
     * app/handlers.ts). Optional only so a caller with no Slack event context
     * (none exist today) degrades to the pre-thread-anchor recency-only path
     * instead of throwing.
     */
    messageTs?: string;
    threadTs?: string;
  }
): Promise<{ handled: boolean; priorOutboundContext?: string; matchedJobId?: string }> {
  const allJobs = getOutreachJobsByColleague(params.senderId, params.profile.user.slack_user_id);
  if (allJobs.length === 0) return { handled: false };

  // gh#201-c — a genuine Slack thread reply names its own job outright.
  // threadTs !== messageTs only when Slack itself reports this message as a
  // reply inside an existing thread; dm_message_ts is the ts of the outbound
  // DM that opened that job's thread. Thread identity is ground truth — skip
  // the content guess entirely when Slack already told us which conversation
  // this is.
  let job: OutreachJob | undefined;
  if (params.threadTs && params.messageTs && params.threadTs !== params.messageTs) {
    job = allJobs.find(j => j.dm_message_ts === params.threadTs);
  }

  if (!job) {
    // No thread anchor — a fresh top-level message, the common case for a
    // bare DM reply. Classify against each active outreach independently —
    // if nothing plausibly matches, let the message fall through as a new
    // request; if MORE THAN ONE genuinely matches, ask which one instead of
    // silently guessing (gh#201-c bouncer restore — see isOutreachReplyByContext's
    // own doc comment for why the comparative one-call replacement was reverted).
    const matches: OutreachJob[] = [];
    for (const j of allJobs) {
      const conv: Array<{ role: 'maelle' | 'colleague'; text: string }> =
        j.conversation_json ? JSON.parse(j.conversation_json) : [];
      const isReply = await isOutreachReplyByContext({
        newReply: params.text,
        originalMessage: j.message,
        conversation: conv,
        colleagueName: j.colleague_name,
        assistantName: params.profile.assistant.name,
      });
      if (isReply) matches.push(j);
    }

    if (matches.length === 0) {
      logger.info('Outreach classifier — no match, treating as new request', {
        senderId: params.senderId,
        activeCount: allJobs.length,
      });
      return { handled: false };
    }

    if (matches.length === 1) {
      job = matches[0];
    } else {
      const lines = matches.map((j, i) => `${i + 1}. ${j.message.slice(0, 100)}${j.message.length > 100 ? '…' : ''}`).join('\n');
      const dmChannel = await openDM(app, params.bot_token, params.senderId);
      await app.client.chat.postMessage({
        token: params.bot_token,
        channel: dmChannel,
        text: formatForSlack(`I have a couple of open threads with you — which one is this about?\n${lines}`),
      });
      logger.info('Outreach classifier — multiple matches, asked to disambiguate', {
        senderId: params.senderId,
        matchCount: matches.length,
      });
      return { handled: true };
    }
  }

  logger.info('Outreach reply received', {
    jobId: job.id,
    from: job.colleague_name,
    preview: params.text.slice(0, 80),
    intent: job.intent ?? null,
  });

  // v1.8.4 — intent-routed outreach replies. If the outreach was tagged with
  // a recognized intent (meeting_reschedule for now), dispatch to the skill's
  // dedicated handler instead of the generic no-intent fallback below.
  // Handler returns true if it handled the reply; false if we should fall
  // through (e.g. context_json missing or unparseable).
  if (job.intent === 'meeting_reschedule') {
    try {
      const { handleRescheduleReply } = await import('../../skills/meetingReschedule');
      const handled = await handleRescheduleReply(app, {
        job,
        replyText: params.text,
        profile: params.profile,
        bot_token: params.bot_token,
      });
      if (handled) return { handled: true };
    } catch (err) {
      logger.error('meeting_reschedule intent handler threw — falling through', { err: String(err), jobId: job.id });
    }
  }

  // gh#201-d — intent-routed reply for a colleague reengaged after the owner's
  // away period ended (see core/requests/colleagueOofReengage.ts).
  if (job.intent === 'oof_reengage') {
    try {
      const { handleOofReengageReply } = await import('../../core/requests/colleagueOofReengage');
      const handled = await handleOofReengageReply(app, {
        job,
        replyText: params.text,
        profile: params.profile,
        bot_token: params.bot_token,
      });
      if (handled) return { handled: true };
    } catch (err) {
      logger.error('oof_reengage intent handler threw — falling through', { err: String(err), jobId: job.id });
    }
  }

  // gh#daniel-sharabi-decisive-reply-stuck-in-continue-loop — a matched job
  // with NO routed intent used to be classified in-house right here
  // (done/continue/schedule, via the now-deleted `processOutreachReply`) and
  // answered with a Sonnet-drafted TEXT reply: no tool access, no
  // `runOutputGates` coverage, and no owner-facing trace at all. That is
  // exactly how a decisive "let's do Wednesday" turned into an unexecuted,
  // untraceable promise ("I'll move it to Wednesday") — confirmed via a live
  // DB query, nothing was logged anywhere for the owner. That classifier and
  // its draft are gone. The reply now falls through (below, `handled: false`)
  // to the FULL orchestrator, with real tools and real gate coverage, via
  // `priorOutboundContext` — carrying what THIS module already matched, never
  // `recentOutboundContext.ts`'s own, separate, shorter-window mechanism
  // (its 24h *calendar*-hour tracking is shorter than the real reply
  // deadline — routing through it would silently reintroduce the false
  // "never replied" closure, cfd5bbc/wrap-4.5.6).
  const conversation: Array<{ role: 'maelle' | 'colleague'; text: string }> =
    job.conversation_json ? JSON.parse(job.conversation_json) : [];
  conversation.push({ role: 'colleague', text: params.text });
  // round 2 (2026-08-18) — persist reply_text HERE, unconditionally, the
  // moment a real reply lands, regardless of what the orchestrator turn below
  // goes on to do with it. This is what buildTurnContext's hasReply reads
  // (the OWNER's own "has X replied yet" thread block, buildTurnContext.ts:512)
  // — without it that block stays "sent, waiting for reply" even after a real
  // reply already landed (the old done/schedule branches set it; this generic
  // path never did). See closeOutreachReplyIfResolvedThisTurn below for the
  // separate question of whether the reply also RESOLVED the ask.
  updateOutreachJob(job.id, { conversation_json: JSON.stringify(conversation), reply_text: params.text });

  // Lifecycle bookkeeping — re-arm the SAME reply-deadline this outreach
  // already carries, identical formula/window to a fresh send
  // (calcResponseDeadline) and to what the old `continue` branch did: the
  // colleague just re-engaged, so the clock restarts from now. Never close
  // here — this module no longer classifies "fully resolved" vs "needs
  // another round" itself (that judgment moved to the orchestrator; see
  // closeOutreachReplyIfResolvedThisTurn below, called by the caller AFTER
  // the orchestrator turn completes), and re-arming is the safe default
  // either way: if nothing further happens, this expires on its own and BOTH
  // sides are told (R3 — runner.ts's runOutreachExpiryOrDecision; phase
  // 'outreach:re_engaged' makes that read "replied but never came back"
  // rather than "never replied" — see outreach-expiry-tombstone-says-never-
  // replied, 2026-08-12); if the reply resolves into a real action this same
  // turn, closeOutreachReplyIfResolvedThisTurn supersedes this re-arm with a
  // real closure. Never a silent drop either way (R3/R4).
  if (job.request_id) {
    const freshDeadline = calcResponseDeadline(job.colleague_tz || params.profile.user.timezone);
    updateRequest(job.request_id, {
      nextCheckAt: freshDeadline,
      nextCheckHandler: 'outreach_expiry',
      phase: 'outreach:re_engaged',
    });
  }

  logger.info('Outreach reply — no routed intent, handing to full orchestrator', {
    jobId: job.id,
    colleague: job.colleague_name,
  });

  return { handled: false, priorOutboundContext: buildOutreachJobContextBlock(job), matchedJobId: job.id };
}

/**
 * gh#daniel-sharabi-decisive-reply-stuck-in-continue-loop (round 2, 2026-08-18)
 * — called by the caller (processMessage.ts) AFTER the full orchestrator
 * finishes the turn `handleOutreachReply` handed to it above (generic
 * no-intent branch, `matchedJobId` returned). Decides whether THIS turn
 * actually took a resolving action on the colleague's reply, and if so closes
 * the outreach it answered. "Whatever tool acts now owns its own closure"
 * isn't true of anything in the tree today — create_meeting / move_meeting /
 * create_approval only ever touch THEIR OWN row, never the outreach request
 * that prompted them — so this is the one place that does it.
 *
 * Mirrors the pattern the deleted `done`/`schedule` branches used:
 * `updateOutreachJob(job.id, { status: 'replied' })` is a TRANSITION SIGNAL
 * (db/jobs.ts) that itself closes the linked request, writes the
 * interaction_log history line, and closes the followup tracker — the one
 * place that already owns all three, so this never re-derives a second
 * closure path. `reply_text` is already persisted (handleOutreachReply,
 * above) by the time this runs, so the interaction_log line reads correctly
 * even though this call passes no data fields of its own.
 *
 * Gated on genuine resolving evidence, never "any reply arrived" —
 * recentOutboundContext.ts closes on that alone, and routing this job
 * through that blunter rule is exactly the shorter-window regression the
 * generic branch above exists to avoid. Two signals count:
 *   - a calendar mutation landed this turn (mutationActions has an ok:true
 *     entry, or bookingOccurred) — "orchestrator moves the meeting".
 *   - the reply was escalated into a FRESH approval now awaiting the owner:
 *     kind='approval', created in the SAME thread, at or after this turn
 *     started — "relays an approval [for] the owner [to answer]". Scoped to
 *     kind='approval' so it never trips on the freeform-owner-flag backstop
 *     (tasks/skill.ts's flagUnresolvedFreeformForOwner mints kind='reminder'
 *     rows — those are a DIFFERENT escalation for a DIFFERENT bug and must
 *     never be read as "this outreach got resolved").
 * A turn that only replied in words trips neither signal and leaves the
 * request exactly as handleOutreachReply already re-armed it (R4's "let me
 * check and come back to you" case, or any other non-decisive reply).
 *
 * registrar fix (generic-outreach-branch-no-proactive-owner-relay, o#247/o#248,
 * 2026-08-19) — the deleted `done`/`schedule` branches (dab6f25) also
 * proactively posted a summary into the owner's own outreach-conversation
 * thread PLUS `logEvent`, whenever a colleague's reply needed him; this
 * replacement closed the job but dropped both, leaving zero owner-visible
 * trace even on the SAME resolving signals (mutated/booked/freshApproval)
 * this function already computes. Wired below, gated on the identical two
 * signals — never on "any reply arrived" — so a trivial reply that leaves the
 * request open (R4's "checking" case) stays silent exactly as before.
 *
 * round 2 (bouncer, 2026-08-19) — the Slack post below only fires on
 * mutated/booked, NOT on freshApproval. When the reply escalates into a
 * fresh approval, `createApprovalRequest` (tasks/skill.ts ~1330) already
 * looks up this SAME colleague's SAME recent outreach
 * (`getRecentOutreachOwnerThread`, keyed on `target_slack_id` + kind
 * 'outreach') and posts the approval ask itself into this exact
 * `owner_dm_channel`/`owner_dm_thread_ts` — so a second post here would be
 * the owner seeing two messages about the identical event (R3's "never
 * twice"). `logEvent` still fires for both signals: it's a durable trace
 * (surfaced only via get_briefing), never a second live notification.
 */
export async function closeOutreachReplyIfResolvedThisTurn(params: {
  ownerUserId: string;
  threadTs: string;
  jobId: string;
  /** ISO instant captured immediately before the orchestrator call. */
  turnStartedAt: string;
  result: Pick<OrchestratorOutput, 'mutationActions' | 'bookingOccurred'>;
}): Promise<void> {
  const mutated = params.result.mutationActions?.some(m => m.ok) ?? false;
  const booked = params.result.bookingOccurred === true;
  let freshApproval = false;
  if (!mutated && !booked) {
    const turnStartMs = Date.parse(params.turnStartedAt);
    freshApproval = getOpenRequestsForThread(params.ownerUserId, params.threadTs).some(r => {
      if (r.kind !== 'approval') return false;
      // created_at is a bare SQLite-UTC datetime ('YYYY-MM-DD HH:MM:SS') —
      // normalize to a parseable instant before comparing (same idiom as
      // colleagueOofReengage.ts).
      const createdMs = Date.parse(r.created_at.replace(' ', 'T') + 'Z');
      return Number.isFinite(createdMs) && Number.isFinite(turnStartMs) && createdMs >= turnStartMs;
    });
  }
  if (!mutated && !booked && !freshApproval) return;

  try {
    updateOutreachJob(params.jobId, { status: 'replied' });
    logger.info('Outreach reply resolved this turn — linked request closed', {
      jobId: params.jobId, mutated, booked, freshApproval,
    });
  } catch (err) {
    logger.warn('closeOutreachReplyIfResolvedThisTurn — close failed', {
      jobId: params.jobId, err: String(err).slice(0, 200),
    });
  }

  // Owner-visible trace/relay — see the doc comment above. A durable
  // `logEvent` row always; a real Slack message into the outreach's own
  // owner-conversation thread ONLY on mutated/booked — freshApproval's own
  // owner-facing post already happened inside createApprovalRequest, so
  // posting again here would double him up on the same event (R3).
  try {
    const linkedRequestId = getLinkedRequestIdForOutreach(params.jobId);
    const requestRow = linkedRequestId ? getRequest(linkedRequestId) : null;
    const who = requestRow?.target_name ?? requestRow?.requester_name ?? 'They';
    const subject = requestRow?.subject || 'that outreach';
    const detail = (mutated || booked)
      ? `${who} replied to "${subject}" and it's handled — I acted on it directly.`
      : `${who} replied to "${subject}" and it needed your call, so I've raised a fresh approval for it.`;
    if ((mutated || booked) && requestRow?.owner_dm_channel) {
      const conn = getConnection(params.ownerUserId, 'slack');
      if (conn) {
        await conn.postToChannel(requestRow.owner_dm_channel, detail, {
          threadTs: requestRow.owner_dm_thread_ts ?? undefined,
        });
      }
    }
    logEvent({
      ownerUserId: params.ownerUserId,
      type: 'outreach_reply',
      title: (mutated || booked) ? `${who} — outreach resolved` : `${who} — outreach escalated`,
      detail,
      actor: who,
      refId: params.jobId,
    });
  } catch (err) {
    logger.warn('closeOutreachReplyIfResolvedThisTurn — owner relay failed', {
      jobId: params.jobId, err: String(err).slice(0, 200),
    });
  }
}

// ── Slack utilities ──────────────────────────────────────────────────────────

export async function findSlackUser(
  app: App,
  bot_token: string,
  name: string
): Promise<Array<{ id: string; name: string; real_name: string; tz: string }>> {
  try {
    const result = await app.client.users.list({ token: bot_token, limit: 200 });
    const members = (result.members ?? []) as any[];
    const query = name.toLowerCase();

    return members
      .filter(m =>
        !m.deleted && !m.is_bot &&
        (
          m.real_name?.toLowerCase().includes(query) ||
          m.name?.toLowerCase().includes(query) ||
          m.profile?.display_name?.toLowerCase().includes(query)
        )
      )
      .map(m => ({
        id: m.id,
        name: m.name,
        real_name: m.real_name ?? m.name,
        tz: m.tz ?? 'UTC',
      }));
  } catch (err) {
    logger.error('Failed to search Slack users', { err, name });
    return [];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export async function openDM(app: App, bot_token: string, userId: string): Promise<string> {
  const result = await app.client.conversations.open({ token: bot_token, users: userId });
  return (result.channel as any)?.id;
}
