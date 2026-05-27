/**
 * Recent-outbound context attachment for inbound colleague DMs (v2.6.1, D4).
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
 *   recent OUTBOUND DMs to this colleague. Apply three time-windows:
 *
 *     1. ≤ 10 min from sent_at  → deterministic match. Treat the inbound
 *        as a response, attach the outbound as context. No LLM call.
 *
 *     2. 10 min – 24 h          → ambiguous. Run a small Sonnet
 *        classifier: "is this inbound a response to that outbound, or a
 *        new topic?" If response → attach context + close the outbound.
 *        If new topic → leave the outbound open; treat inbound as fresh.
 *
 *     3. > 24 h                 → auto-expire the outbound (mark
 *        followup_closed_at). Treat inbound as new.
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
import { getDb } from '../../db/client';
import logger from '../../utils/logger';
import { config } from '../../config';
import type { OutreachJob } from '../../db/jobs';

const anthropic = getAnthropicClient();

/** Minutes inside which an inbound DM is deterministically treated as a continuation. */
const DETERMINISTIC_WINDOW_MINUTES = 10;

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
  matchedVia?: 'deterministic_under_10min' | 'llm_classified_response' | 'thread_reply';
}

/**
 * Look up the most recent OPEN outreach_jobs row for this colleague within
 * the last 24h (regardless of status — `status` is task-lifecycle bookkeeping
 * and gets churned by closeFireAndForgetOutreach 5min after send; we use
 * `followup_closed_at` for D4's conversational-closure tracking).
 *
 * Returns the row, or null when nothing eligible exists.
 */
function findOpenOutboundForColleague(params: {
  ownerUserId: string;
  colleagueSlackId: string;
}): OutreachJob | null {
  const db = getDb();
  const cutoff = new Date(Date.now() - AUTO_EXPIRE_HOURS * 60 * 60 * 1000).toISOString();
  const row = db.prepare(`
    SELECT * FROM outreach_jobs
    WHERE owner_user_id = ?
      AND colleague_slack_id = ?
      AND followup_closed_at IS NULL
      AND sent_at IS NOT NULL
      AND datetime(sent_at) >= datetime(?)
    ORDER BY datetime(sent_at) DESC
    LIMIT 1
  `).get(params.ownerUserId, params.colleagueSlackId, cutoff) as OutreachJob | undefined;
  return row ?? null;
}

/**
 * Mark an outreach_jobs row as having its conversational follow-up closed.
 * When `replyText` is provided, the inbound represents a real text reply —
 * also stamp status='replied' + reply_text so downstream consumers
 * (notably social_ping_rank_check 48h later) can see the engagement
 * signal and bump rank correctly. Without this stamp the rank-check
 * reads status='sent' / reply_text=null → interprets warm engagement
 * as "ignored" → DECREMENTS the cold-pinged colleague's rank, the
 * opposite of intent.
 *
 * Omit `replyText` for non-reply closures (emoji acks, auto-expire,
 * outbound-to-outbound matching) — those keep status untouched.
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
          status = 'replied',
          reply_text = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(reason, options.replyText, jobId);
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
 * Sonnet classifier for the 10min-24h ambiguous window. Returns true when
 * the inbound looks like a response to the outbound; false when it looks
 * like a new topic.
 *
 * Fails open to TRUE (treat as response) — over-attaching context costs a
 * minor "extra context for an unrelated message" risk; under-attaching
 * costs "Hey, what can I help you with?" amnesia. Owner direction is to
 * lean on continuity assumption, so failing open to true matches that.
 */
async function classifyResponseVsNewTopic(params: {
  outboundText: string;
  inboundText: string;
  deltaMinutes: number;
  colleagueName: string;
  ownerFirstName: string;
}): Promise<boolean> {
  try {
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 12,
      system:
        `You decide whether a Slack DM from ${params.colleagueName} is a continuation of a prior message ${params.ownerFirstName}'s assistant sent them, or a fresh new topic. ` +
        `Reply with exactly one word: RESPONSE (it's likely a reply / acknowledgment / follow-up to the prior message) or NEW_TOPIC (it's clearly about something else). ` +
        `When in doubt, prefer RESPONSE — short replies like "ok", "thanks", "got it", "sure", emoji-only acks, or any text that isn't an obviously different request count as RESPONSE.`,
      messages: [{
        role: 'user',
        content:
          `What ${params.ownerFirstName}'s assistant said (${params.deltaMinutes} min ago):\n"${params.outboundText.slice(0, 500)}"\n\n` +
          `What ${params.colleagueName} just sent now:\n"${params.inboundText.slice(0, 500)}"\n\n` +
          `One word: RESPONSE or NEW_TOPIC.`,
      }],
    });
    const raw = ((result.content[0] as Anthropic.TextBlock).text ?? '').trim().toUpperCase();
    if (raw.startsWith('NEW_TOPIC') || raw.startsWith('NEW TOPIC')) return false;
    return true;  // default to RESPONSE on anything else (incl. plain "RESPONSE")
  } catch (err) {
    logger.warn('recentOutboundContext classifier failed — defaulting to RESPONSE', {
      err: String(err).slice(0, 200),
    });
    return true;
  }
}

/**
 * Main entry point. Call from the Slack inbound colleague-DM handler
 * BEFORE invoking the orchestrator.
 *
 * Behavior:
 *   - No open outbound found       → returns matched=false, no context.
 *   - Outbound within 10 min       → deterministic match, attach context,
 *                                    close followup as 'deterministic_match'.
 *   - Outbound 10min-24h           → Sonnet classifies. If RESPONSE: attach
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
  // v3.1 (Path 2) — coord takes precedence (closes deferred bug #7). If an
  // active coord covers this colleague, an inbound from them belongs to the
  // coord, NOT a parallel outreach. handleCoordReply runs before this in the
  // inbound path (app.ts), but if it didn't consume the message we must not
  // let a stale outreach context shadow the live coord. Openness is read off
  // the requests spine (getCoordJobsByParticipant is request-state-aware as
  // of Stage 3), so this is reliable even if coord_jobs.status drifted.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCoordJobsByParticipant } = require('../../db/jobs') as typeof import('../../db/jobs');
    if (getCoordJobsByParticipant(params.colleagueSlackId, params.ownerUserId).length > 0) {
      logger.info('recentOutboundContext — active coord covers colleague, deferring to coord', {
        colleague: params.colleagueName,
      });
      return { matched: false, contextBlock: null };
    }
  } catch (_) { /* non-fatal — fall through to outreach matching */ }

  const job = findOpenOutboundForColleague({
    ownerUserId: params.ownerUserId,
    colleagueSlackId: params.colleagueSlackId,
  });
  if (!job || !job.sent_at) {
    return { matched: false, contextBlock: null };
  }

  const sentMs = Date.parse(job.sent_at);
  if (!Number.isFinite(sentMs)) {
    logger.warn('recentOutboundContext — outreach_jobs.sent_at unparseable, skipping', {
      jobId: job.id, sent_at: job.sent_at,
    });
    return { matched: false, contextBlock: null };
  }
  const deltaMs = Date.now() - sentMs;
  const deltaMinutes = deltaMs / 60_000;

  // Bucket 1 — deterministic match within 10 min.
  if (deltaMinutes <= DETERMINISTIC_WINDOW_MINUTES) {
    closeFollowup(job.id, 'deterministic_match', { replyText: params.inboundText });
    logger.info('recentOutboundContext — deterministic match', {
      jobId: job.id, colleague: params.colleagueName, deltaMinutes: Math.round(deltaMinutes * 10) / 10,
    });
    return {
      matched: true,
      matchedJobId: job.id,
      contextBlock: buildContextBlock(job, deltaMs / 1000),
      matchedVia: 'deterministic_under_10min',
    };
  }

  // Bucket 3 — over 24h, auto-expire (lazy cleanup).
  if (deltaMinutes > AUTO_EXPIRE_HOURS * 60) {
    closeFollowup(job.id, 'auto_expired_24h');
    logger.info('recentOutboundContext — auto-expired (>24h)', {
      jobId: job.id, colleague: params.colleagueName, deltaHours: Math.round(deltaMinutes / 60),
    });
    return { matched: false, contextBlock: null };
  }

  // Bucket 2 — 10min-24h, run Sonnet classifier.
  const isResponse = await classifyResponseVsNewTopic({
    outboundText: job.message,
    inboundText: params.inboundText,
    deltaMinutes: Math.round(deltaMinutes),
    colleagueName: params.colleagueName,
    ownerFirstName: params.ownerFirstName,
  });

  if (isResponse) {
    closeFollowup(job.id, 'llm_response_match', { replyText: params.inboundText });
    logger.info('recentOutboundContext — LLM classified as RESPONSE', {
      jobId: job.id, colleague: params.colleagueName, deltaMinutes: Math.round(deltaMinutes),
    });
    return {
      matched: true,
      matchedJobId: job.id,
      contextBlock: buildContextBlock(job, deltaMs / 1000),
      matchedVia: 'llm_classified_response',
    };
  }

  // NEW_TOPIC — leave the outbound open (it might still get acked later).
  logger.info('recentOutboundContext — LLM classified as NEW_TOPIC, no context attached', {
    jobId: job.id, colleague: params.colleagueName, deltaMinutes: Math.round(deltaMinutes),
  });
  return { matched: false, contextBlock: null };
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
