/**
 * Recent-outbound context attachment for inbound colleague DMs (v2.6.1).
 *
 * Problem this solves:
 *   When Maelle proactively DMs a colleague via `message_colleague` (e.g. a
 *   heads-up about a meeting they're being added to), the colleague's reply
 *   sometimes arrives without any conversational context because:
 *     (a) `message_colleague(await_reply: false)` does NOT register a
 *         pending reply with the outreach pipeline — `handleOutreachReply`
 *         won't match it.
 *     (b) `message_colleague` writes to `outreach_jobs` but does NOT append
 *         the outbound text to the per-thread conversation history; the
 *         colleague's reply lands as a fresh top-level DM with empty
 *         history; orchestrator has no idea Maelle just messaged them.
 *
 *   Observed 2026-05-06: Maelle DM'd Isaac with a meeting heads-up at
 *   18:42:19. Isaac replied "Ok" ~2 min later. Maelle responded with
 *   "Hey Isaac! What can I help you with?" — zero memory.
 *
 * The fix (owner direction):
 *   At the Slack connector layer — BEFORE the orchestrator runs — look up
 *   recent OUTBOUND DMs to this colleague. Apply two time-windows:
 *
 *     1. ≤ 24 h from sent_at    → ambiguous, ALWAYS classify. ONE Sonnet
 *        call is given EVERY still-open candidate for this colleague
 *        (most-recent-first) and returns which single one (if any) the
 *        inbound continues. A match → attach that candidate's context +
 *        close it. No match (NEW_TOPIC against all of them) → leave every
 *        candidate open; treat inbound as fresh.
 *
 *     2. > 24 h                 → auto-expire the outbound (mark
 *        followup_closed_at). Treat inbound as new.
 *
 *   v2.6.2 (gh#176/#177) — there used to be a third, EARLIER bucket: any
 *   inbound within 10 min of the outbound was treated as a deterministic
 *   match, no classifier, purely on elapsed time. That bypass matched by
 *   (owner, colleague) identity ALONE — a second, unrelated topic from the
 *   same colleague arriving inside that 10-minute window was misattached
 *   to the open outbound AND closed it, starving the real continuation of
 *   that outbound (which typically arrives within the same few minutes)
 *   of any context at all. Colleague identity is not topic identity, so
 *   every inbound within 24h is now classified.
 *
 *   v2.6.3 — the classifier used to run per-candidate (a serial loop, one
 *   RESPONSE/NEW_TOPIC call per open job, fails open to RESPONSE). It now
 *   takes every open candidate in ONE call and returns the id of the single
 *   one continued (or NEW_TOPIC for all), so a colleague with several open
 *   topics costs exactly one Sonnet call, not one per topic. Fails open to
 *   the MOST RECENT candidate, so genuine quick acks ("Ok", "thanks") still
 *   attach context exactly as before; only a real new-topic message now
 *   correctly leaves every candidate open.
 *
 *   Plus two explicit acknowledgment signals (any age, while open):
 *     • Emoji reaction on the outbound message → close as 'emoji_ack'.
 *     • Thread reply on the outbound message → close as 'thread_reply'
 *       AND attach context (it IS a reply, just one in a thread).
 *
 * Tools never see this. The orchestrator gets a string-shaped context block
 * via `OrchestratorInput.priorOutboundContext`. Sonnet reads it like any
 * other system context. Matches owner's "fix at high level" direction.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../../llm/client';
import { SONNET } from '../../llm/models';
import { getDb } from '../../db/client';
import logger from '../../utils/logger';
import type { OutreachJob } from '../../db/jobs';

const anthropic = getAnthropicClient();

/** Hours after which an outbound auto-expires from follow-up tracking. */
const AUTO_EXPIRE_HOURS = 24;

/**
 * Helper return shape. The caller (Slack inbound DM handler) uses
 * `contextBlock` to populate `OrchestratorInput.priorOutboundContext` so
 * Sonnet sees a top-level "RECENT OUTBOUND TO THIS COLLEAGUE" block in
 * the system prompt.
 */
export interface RecentOutboundContextResult {
  /** True if the inbound message should be treated as a response to a recent outbound. */
  matched: boolean;
  /** When matched, the outreach_jobs row id (for follow-up updates). */
  matchedJobId?: string;
  /**
   * When matched, a one-paragraph string suitable for direct injection
   * into the orchestrator's system prompt under a "RECENT OUTBOUND" header.
   * Includes the outbound text, time delta, and a short "this is probably
   * their response" framing line. Null when not matched.
   */
  contextBlock: string | null;
  /** How the match was decided (for logging / future debugging). */
  matchedVia?: 'llm_classified_response' | 'thread_reply';
}

/**
 * Look up EVERY OPEN outreach_jobs row for this colleague, most recent
 * first — including ones already past the 24h auto-expire mark; the caller
 * (getRecentOutboundContext) is what applies the 24h split, and it needs
 * those stale rows in hand so it can actually close them. "Open" here means
 * CONVERSATIONALLY open — `followup_closed_at IS NULL` — which is this
 * module's own signal,
 * deliberately independent of the request's lifecycle. That independence is
 * the point, not an oversight: a fire-and-forget DM
 * (`message_colleague(await_reply:false)` — the case this module exists for)
 * has a request that is already `resolved` the moment it is sent
 * (db/jobs.ts:184-185), yet the colleague's reply still needs context. So
 * the filter is this field, and never the request state or a status column.
 *
 * Returns ALL eligible rows, not just the newest — a colleague can have two
 * open outbound topics at once, and a plain top-level DM reply (no thread_ts
 * to disambiguate; that case is handled separately by
 * `closeFollowupForMessageTs`) needs every candidate classified, not just
 * whichever was sent last. Capped at 10 as a sanity bound; this is a
 * low-volume per-colleague signal that auto-expires in 24h, so the cap is
 * never expected to bind.
 */
function findOpenOutboundsForColleague(params: {
  ownerUserId: string;
  colleagueSlackId: string;
}): OutreachJob[] {
  const db = getDb();
  // No cutoff here on purpose — the >24h ones are exactly what pass 1 in
  // getRecentOutboundContext below needs to see so it can actually mark them
  // 'auto_expired_24h'. A cutoff here would starve that branch permanently:
  // any row already older than 24h would never be fetched, so it could never
  // be closed, and followup_closed_at would stay NULL on it forever.
  return db.prepare(`
    SELECT * FROM outreach_jobs
    WHERE owner_user_id = ?
      AND colleague_slack_id = ?
      AND followup_closed_at IS NULL
      AND sent_at IS NOT NULL
    ORDER BY datetime(sent_at) DESC
    LIMIT 10
  `).all(params.ownerUserId, params.colleagueSlackId) as OutreachJob[];
}

/**
 * Mark an outreach_jobs row as having its conversational follow-up closed.
 *
 * `followup_closed_at` + `followup_close_reason` are this module's OWN signal
 * — "the conversation around this outbound DM is over" — and they are the
 * only state this function claims. It deliberately does NOT write
 * `outreach_jobs.status`: the linked request is the lifecycle, and that column is
 * retired (#41, "only one spine" — canonical note: db/jobs.ts, top of file). The
 * `status='replied'` write that used to live here went once the column's last
 * reader (calendarHealth checkHealth's reschedule-ping dedup) moved to the spine.
 * Don't re-add it — nothing reads the column, and a write to it is the second
 * lifecycle #41 exists to kill.
 *
 * On a REAL reply (replyText present) two further effects, both load-bearing:
 *   • `reply_text` is persisted — the ONLY path that captures it for a plain
 *     conversational reply (pipeline paths go through updateOutreachJob), and
 *     buildTurnContext.ts:363-385 renders it into the owner's "ACTIVE IN THIS
 *     THREAD — you already committed to these" block. That block's "replied"
 *     label is derived from reply_text, never from a status column.
 *   • the linked REQUEST is closed — it owns state, phase, timers and what the
 *     brief reads. Without it, a reply matched here (when handleOutreachReply's
 *     LLM gate missed) left the request stuck awaiting_colleague forever, and the
 *     brief + rate-limiter kept treating a replied-to outreach as still open.
 *
 * Omit `replyText` for non-reply closures (emoji acks, auto-expire,
 * outbound-to-outbound matching) — those close the conversation only and
 * legitimately leave the request open.
 */
function closeFollowup(
  jobId: string,
  reason: NonNullable<OutreachJob['followup_close_reason']>,
  options?: { replyText?: string },
): void {
  const db = getDb();
  if (options?.replyText !== undefined) {
    db.prepare(`
      UPDATE outreach_jobs
      SET followup_closed_at = datetime('now'),
          followup_close_reason = ?,
          reply_text = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(reason, options.replyText, jobId);
    // v3.1 (Path 2 fix) — CLOSE THE LINKED REQUEST: it owns the lifecycle, and
    // this is the only closure a reply matched here ever gets (see the note
    // above). Only on a REAL reply — emoji-ack / auto-expire below legitimately
    // leave the request open.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getLinkedRequestIdForOutreach } = require('../../db/jobs') as typeof import('../../db/jobs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { closeRequest } = require('../../core/requests/closeRequest') as typeof import('../../core/requests/closeRequest');
      const reqId = getLinkedRequestIdForOutreach(jobId);
      if (reqId) {
        closeRequest({ id: reqId, state: 'resolved', closureReason: 'colleague_reply', closedBy: 'colleague_reply' });
      }
    } catch (err) {
      logger.warn('closeFollowup — failed to close linked request on reply', { jobId, err: String(err).slice(0, 200) });
    }
  } else {
    db.prepare(`
      UPDATE outreach_jobs
      SET followup_closed_at = datetime('now'),
          followup_close_reason = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(reason, jobId);
  }
}

/**
 * Build the prompt-block string the orchestrator will inject. Soft framing —
 * Sonnet treats this as a strong default but can pivot if the inbound
 * clearly switches topic.
 */
function buildContextBlock(job: OutreachJob, deltaSeconds: number): string {
  const minutes = Math.round(deltaSeconds / 60);
  const ago = minutes < 60
    ? `${minutes} min ago`
    : minutes < 24 * 60
      ? `${Math.round(minutes / 60)}h ago`
      : `${Math.round(minutes / (60 * 24))}d ago`;
  const preview = job.message.slice(0, 400);
  return [
    `RECENT OUTBOUND TO THIS COLLEAGUE (${ago})`,
    `You sent ${job.colleague_name}: "${preview}${job.message.length > preview.length ? '…' : ''}"`,
    `Their inbound is most likely a response to that. If their text clearly switches topic, follow the new topic and don't force a connection — but the default assumption is continuity.`,
  ].join('\n');
}

/**
 * Sonnet classifier for the 24h ambiguous window. Takes EVERY still-open
 * candidate (most-recent-first) in ONE call and returns the id of the one
 * the inbound continues, or null when it matches none (NEW_TOPIC for all).
 *
 * One call regardless of candidate count — a colleague can have several
 * open outbound topics at once (see findOpenOutboundsForColleague), but the
 * common case is exactly one, and even the rare multi-candidate case must
 * not cost N serial round-trips: classifying candidates one at a time in a
 * loop turned a single quick "Ok" ack into up to `LIMIT 10` sequential
 * Sonnet calls before a reply could even reach the orchestrator. Folding
 * every candidate into one prompt keeps the cost at exactly one call no
 * matter how many open topics exist.
 *
 * Fails open to the MOST RECENT candidate (index 0) — over-attaching
 * context costs a minor "extra context for an unrelated message" risk;
 * under-attaching costs "Hey, what can I help you with?" amnesia. Owner
 * direction is to lean on continuity assumption, so failing open to the
 * newest open topic matches that.
 */
async function classifyResponseVsNewTopic(params: {
  candidates: Array<{ id: string; outboundText: string; deltaMinutes: number }>;
  inboundText: string;
  colleagueName: string;
  ownerFirstName: string;
}): Promise<string | null> {
  const { candidates } = params;
  try {
    const listing = candidates
      .map((c, i) => `${i + 1}. (sent ${c.deltaMinutes} min ago) "${c.outboundText.slice(0, 500)}"`)
      .join('\n');
    const result = await anthropic.messages.create({
      ...SONNET,
      max_tokens: 12,
      system:
        `You decide whether a Slack DM from ${params.colleagueName} is a continuation of ONE of several prior messages ${params.ownerFirstName}'s assistant sent them, or a fresh new topic unrelated to all of them. ` +
        `Reply with exactly one token: the NUMBER of the single message it continues, or NEW_TOPIC if it matches none of them. ` +
        `When in doubt, prefer the most recent one (number 1) — short replies like "ok", "thanks", "got it", "sure", emoji-only acks, or any text that isn't an obviously different request should match message 1.`,
      messages: [{
        role: 'user',
        content:
          `What ${params.ownerFirstName}'s assistant sent ${params.colleagueName} (most recent first):\n${listing}\n\n` +
          `What ${params.colleagueName} just sent now:\n"${params.inboundText.slice(0, 500)}"\n\n` +
          `One token: the number of the message it continues, or NEW_TOPIC.`,
      }],
    });
    const raw = ((result.content[0] as Anthropic.TextBlock).text ?? '').trim().toUpperCase();
    if (raw.startsWith('NEW_TOPIC') || raw.startsWith('NEW TOPIC')) return null;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= candidates.length) return candidates[n - 1].id;
    return candidates[0].id;  // unparseable non-NEW_TOPIC reply — default to newest
  } catch (err) {
    logger.warn('recentOutboundContext classifier failed — defaulting to most recent candidate', {
      err: String(err).slice(0, 200),
    });
    return candidates[0].id;
  }
}

/**
 * Main entry point. Call from the Slack inbound colleague-DM handler
 * BEFORE invoking the orchestrator.
 *
 * Behavior:
 *   - No open outbound found       → returns matched=false, no context.
 *   - Outbound within 24h          → Sonnet classifies. If RESPONSE: attach
 *                                    context, close as 'llm_response_match'.
 *                                    If NEW_TOPIC: leave open, no context.
 *   - Outbound > 24h               → close as 'auto_expired_24h', no context.
 *                                    (Lazy expiry; cheaper than a periodic
 *                                    sweep for a low-volume signal.)
 *
 * Thread replies and emoji reactions are handled by separate code paths
 * (the inbound DM handler checks thread_ts vs dm_message_ts; the
 * `reaction_added` Slack event handler covers emoji). Both call
 * `closeFollowupForMessageTs` below.
 */
export async function getRecentOutboundContext(params: {
  ownerUserId: string;
  colleagueSlackId: string;
  colleagueName: string;
  ownerFirstName: string;
  inboundText: string;
}): Promise<RecentOutboundContextResult> {
  const jobs = findOpenOutboundsForColleague({
    ownerUserId: params.ownerUserId,
    colleagueSlackId: params.colleagueSlackId,
  });

  // Pass 1 (no LLM): drop unparseable rows and auto-expire anything over 24h
  // — both are pure elapsed-time checks, never worth a Sonnet call.
  const eligible: Array<{ job: OutreachJob; deltaMs: number; deltaMinutes: number }> = [];
  for (const job of jobs) {
    if (!job.sent_at) continue;
    const sentMs = Date.parse(job.sent_at);
    if (!Number.isFinite(sentMs)) {
      logger.warn('recentOutboundContext — outreach_jobs.sent_at unparseable, skipping', {
        jobId: job.id, sent_at: job.sent_at,
      });
      continue;
    }
    const deltaMs = Date.now() - sentMs;
    const deltaMinutes = deltaMs / 60_000;
    if (deltaMinutes > AUTO_EXPIRE_HOURS * 60) {
      closeFollowup(job.id, 'auto_expired_24h');
      logger.info('recentOutboundContext — auto-expired (>24h)', {
        jobId: job.id, colleague: params.colleagueName, deltaHours: Math.round(deltaMinutes / 60),
      });
      continue;
    }
    eligible.push({ job, deltaMs, deltaMinutes });
  }

  if (eligible.length === 0) return { matched: false, contextBlock: null };

  // Pass 2 (ONE Sonnet call, not one per candidate): a plain top-level reply
  // has no thread_ts to disambiguate which open topic it belongs to, so a
  // colleague can have several open outbound topics at once and any of them
  // could be what the inbound continues (gh#176/#177: elapsed time alone
  // doesn't prove topic continuity). Folding every eligible candidate into a
  // single classification call — instead of looping and classifying each one
  // serially — keeps this at exactly one Sonnet call regardless of how many
  // topics are open, and still fails open to the most recent one.
  const matchedId = await classifyResponseVsNewTopic({
    candidates: eligible.map(e => ({
      id: e.job.id,
      outboundText: e.job.message,
      deltaMinutes: Math.round(e.deltaMinutes),
    })),
    inboundText: params.inboundText,
    colleagueName: params.colleagueName,
    ownerFirstName: params.ownerFirstName,
  });

  if (matchedId === null) {
    logger.info('recentOutboundContext — LLM classified as NEW_TOPIC against all open candidates', {
      colleague: params.colleagueName, candidateCount: eligible.length,
    });
    return { matched: false, contextBlock: null };
  }

  const match = eligible.find(e => e.job.id === matchedId) ?? eligible[0];
  closeFollowup(match.job.id, 'llm_response_match', { replyText: params.inboundText });
  logger.info('recentOutboundContext — LLM classified as RESPONSE', {
    jobId: match.job.id, colleague: params.colleagueName, deltaMinutes: Math.round(match.deltaMinutes),
  });
  return {
    matched: true,
    matchedJobId: match.job.id,
    contextBlock: buildContextBlock(match.job, match.deltaMs / 1000),
    matchedVia: 'llm_classified_response',
  };
}

/**
 * Mark a follow-up closed by matching against `dm_message_ts`. Used by:
 *   - The Slack `reaction_added` handler (emoji on the outbound).
 *   - The colleague-DM handler when an inbound is a thread reply on the
 *     outbound (thread_ts matches dm_message_ts).
 *
 * Returns the closed job (if any) so the caller can attach its message as
 * context for thread-reply cases.
 */
export function closeFollowupForMessageTs(params: {
  messageTs: string;
  reason: 'emoji_ack' | 'thread_reply';
}): OutreachJob | null {
  const db = getDb();
  const job = db.prepare(`
    SELECT * FROM outreach_jobs
    WHERE dm_message_ts = ? AND followup_closed_at IS NULL
    LIMIT 1
  `).get(params.messageTs) as OutreachJob | undefined;
  if (!job) return null;
  closeFollowup(job.id, params.reason);
  // v3.1 (audit fix) — a THREAD REPLY is a genuine reply, so also close the
  // linked request (same orphan class as closeFollowup's reply branch — pre-fix
  // a thread reply marked followup_closed_at but left the request
  // awaiting_colleague forever). An EMOJI ack is NOT a substantive reply →
  // leave the request open. We don't have the reply text here (only the ts),
  // so close the request directly rather than stamping a fake reply_text.
  if (params.reason === 'thread_reply') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getLinkedRequestIdForOutreach } = require('../../db/jobs') as typeof import('../../db/jobs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { closeRequest } = require('../../core/requests/closeRequest') as typeof import('../../core/requests/closeRequest');
      const reqId = getLinkedRequestIdForOutreach(job.id);
      if (reqId) closeRequest({ id: reqId, state: 'resolved', closureReason: 'colleague_thread_reply', closedBy: 'colleague_reply' });
    } catch (err) {
      logger.warn('closeFollowupForMessageTs — failed to close linked request on thread reply', { jobId: job.id, err: String(err).slice(0, 200) });
    }
  }
  logger.info('recentOutboundContext — followup closed via signal', {
    jobId: job.id, reason: params.reason, dm_message_ts: params.messageTs,
  });
  return job;
}

/**
 * Build the prompt-block for a thread-reply match. Slightly different
 * framing than `buildContextBlock` because the thread-parent linkage is
 * EXPLICIT — no soft "probably a response" hedge needed.
 */
export function buildThreadReplyContextBlock(job: OutreachJob): string {
  const preview = job.message.slice(0, 400);
  return [
    `RECENT OUTBOUND TO THIS COLLEAGUE (they're replying in-thread)`,
    `You sent ${job.colleague_name}: "${preview}${job.message.length > preview.length ? '…' : ''}"`,
    `Their inbound is a direct reply in the thread off your message.`,
  ].join('\n');
}
