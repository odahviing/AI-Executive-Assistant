/**
 * Engagement signal applier (v2.6.7 redesign).
 *
 * Pre-redesign: append-only `social_engagements` log with score deltas decided
 * here (positive=+3, neutral=-1, negative=-3 etc). Mismatch with the live
 * Sonnet-driven flow led to subjects camping at top scores while real
 * engagement quality didn't show through.
 *
 * Redesign rules (per the 2026-05-10 design conversation, EC4):
 *   - Person spontaneously matches existing subject (no recent assistant raise) → +1
 *   - Assistant raised + person's NEXT message:
 *       · matches subject + non-negative sentiment → +1
 *       · matches subject + negative sentiment    → −1
 *       · doesn't match (any pivot, including task, bare ack, different subject) → −1
 *   - Floor 0 → status='dormant'. Cap 5.
 *
 * The signal applier reads `last_assistant_initiated_at` on the most-recently-
 * raised subject for this person, then compares against the classifier's verdict
 * for the current inbound. Always clears the raise marker after processing
 * so we don't double-apply on subsequent turns.
 *
 * Single source of truth: subjects.engagement_score. No append-only log.
 */

import {
  applyScoreDelta,
  clearSubjectRaisedMarker,
  getMostRecentRaisedSubject,
  incrementCategorySignals,
  type SocialSubject,
} from '../../db/socialSubjects';
import { adjustEngagementRank } from '../../db/engagementRank';
import type { OwnerIntentClassification } from './classifyOwnerIntent';
import logger from '../../utils/logger';

const RANK_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const BRIEF_REPLY_CHAR_LIMIT = 30;

/**
 * Apply the engagement signal for an inbound message that arrived AFTER the
 * assistant raised a subject. Reads the most-recently-raised subject for this
 * person and decides +1 / −1 / no-op based on whether the inbound matched.
 *
 * Returns the subject that was judged + the delta applied (for logging).
 */
export function applyRaiseFeedbackSignal(params: {
  ownerUserId: string;
  personSlackId: string;
  classification: OwnerIntentClassification;
}): { subject: SocialSubject | null; delta: number; reason: string } {
  const { ownerUserId, personSlackId, classification } = params;

  const raised = getMostRecentRaisedSubject(ownerUserId, personSlackId);
  if (!raised) return { subject: null, delta: 0, reason: 'no_raised_subject' };

  const matchedSubjectId = classification.social?.subject_match?.existing_subject_id ?? null;
  const sentiment = classification.social?.sentiment ?? 'neutral';

  let delta = 0;
  let reason = '';

  if (matchedSubjectId === raised.id) {
    if (sentiment === 'negative') {
      delta = -1;
      reason = 'raised_match_negative';
    } else {
      delta = +1;
      reason = 'raised_match_engaged';
    }
  } else {
    // Pivot path — owner/colleague moved on without addressing the raised
    // subject this turn. Owner direction (option C): DO NOT apply a -1.
    // The prior implementation's blanket -1-on-pivot misclassified
    // legitimate task interruptions ("book the gym at 5pm" after yesterday's
    // marathon-training raise) as social rejection, dragging the topic
    // score down and clearing the raise so a delayed answer counted as
    // organic instead of resolving the raise.
    //
    // New behavior: no score change AND no marker clear. The raise stays
    // alive — if a later inbound matches the raised subject, it still
    // produces +1. Raises age naturally via the weekly social_decay
    // dispatcher (−1/week to active subjects untouched 7+ days).
    delta = 0;
    reason = `raised_pivot_no_signal_${classification.kind}`;
  }

  let updated: SocialSubject | null = null;
  if (delta !== 0) {
    updated = applyScoreDelta(raised.id, delta, 'assistant');
    if (sentiment === 'positive') incrementCategorySignals(raised.category_id, 'positive');
    if (sentiment === 'negative') incrementCategorySignals(raised.category_id, 'negative');
    // Clear the raise marker only when a real signal was applied. Pivot
    // path leaves it so a delayed response still counts.
    clearSubjectRaisedMarker(raised.id);
  }

  logger.info('Engagement signal applied (raised)', {
    raisedId: raised.id, raisedLabel: raised.label, delta, reason,
    newScore: updated?.engagement_score, status: updated?.status,
  });
  return { subject: updated ?? raised, delta, reason };
}

/**
 * Apply the organic-match signal: person spontaneously matched an existing
 * subject (no pending assistant raise). +1, capped at 5.
 *
 * Called when classification.social.subject_match.action === 'match_existing'
 * AND there was no pending assistant raise (or the raise applied to a
 * different subject — handled separately).
 */
export function applyOrganicMatchSignal(params: {
  ownerUserId: string;
  personSlackId: string;
  matchedSubjectId: string;
  initiator: 'owner' | 'colleague';
  sentiment: 'positive' | 'negative' | 'neutral';
}): SocialSubject | null {
  const { matchedSubjectId, initiator, sentiment } = params;
  // Negative organic mention also -1 (person is venting about it).
  const delta = sentiment === 'negative' ? -1 : +1;
  const updated = applyScoreDelta(matchedSubjectId, delta, initiator);
  logger.info('Engagement signal applied (organic)', {
    subjectId: matchedSubjectId, delta, sentiment, newScore: updated?.engagement_score,
  });
  return updated;
}

/**
 * In-conversation rank adjustment (v2.2.1 carryover).
 *
 * When a colleague replies inside an active conversation, check whether
 * the reply followed a recent assistant-initiated social moment. If so,
 * nudge the colleague's engagement_rank +/− based on quality.
 */
export function adjustRankFromColleagueResponse(params: {
  colleagueSlackId: string;
  replyText: string;
  sentiment: 'positive' | 'negative' | 'neutral';
}): void {
  // Note: lastAssistantInitiatedAt was renamed from lastMaelleInitiatedAt.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { lastAssistantInitiatedAt } = require('../../db/socialSubjects') as
    typeof import('../../db/socialSubjects');
  const lastInit = lastAssistantInitiatedAt(params.colleagueSlackId);
  if (!lastInit) return;
  const sinceMs = Date.now() - new Date(lastInit).getTime();
  if (sinceMs > RANK_RESPONSE_WINDOW_MS) return;

  const len = params.replyText.trim().length;
  if (params.sentiment === 'negative') {
    adjustEngagementRank(params.colleagueSlackId, -1, 'reply_brief');
  } else if (params.sentiment === 'positive' && len > BRIEF_REPLY_CHAR_LIMIT) {
    adjustEngagementRank(params.colleagueSlackId, 1, 'reply_engaged');
  }
}

