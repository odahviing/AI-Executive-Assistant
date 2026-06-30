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
import logger from '../../utils/logger';

const RANK_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * v3.0 follow-up — raise-feedback signal applied at end-of-chat (not per-turn).
 *
 * Inputs: the matched subjects from this chat (subject_id + per-decision
 * sentiment). Looks at the most-recently-raised subject for this person; if
 * any matched subject equals the raised one, apply the appropriate score
 * delta (positive sentiment → +1, negative → −1) and clear the raise marker.
 * If the raised subject was NOT touched in this chat (pivot path), leave
 * the marker alone — weekly decay handles aging.
 *
 * No classification dependency anymore (per-turn `subject_match` was
 * stripped in v3.0 follow-up; subject decisions only happen at end-of-chat).
 */
export function applyRaiseFeedbackForMatches(params: {
  ownerUserId: string;
  personSlackId: string;
  matchedSubjects: Array<{ id: string; sentiment: 'positive' | 'negative' | 'neutral' }>;
}): { subject: SocialSubject | null; delta: number; reason: string } {
  const { ownerUserId, personSlackId, matchedSubjects } = params;

  const raised = getMostRecentRaisedSubject(ownerUserId, personSlackId);
  if (!raised) return { subject: null, delta: 0, reason: 'no_raised_subject' };

  const raisedMatch = matchedSubjects.find(m => m.id === raised.id);
  if (!raisedMatch) {
    // Pivot path — chat didn't touch the raised subject. Per owner direction
    // (v2.6.7 option C): no score change, no marker clear. The raise stays
    // alive — if a later chat matches it, the +1 still fires. Raises age
    // naturally via the weekly social_decay dispatcher.
    logger.info('Engagement signal — raised pivot (no signal applied)', {
      raisedId: raised.id, raisedLabel: raised.label,
    });
    return { subject: raised, delta: 0, reason: 'raised_pivot_no_signal' };
  }

  const sentiment = raisedMatch.sentiment;
  const delta = sentiment === 'negative' ? -1 : +1;
  const reason = sentiment === 'negative' ? 'raised_match_negative' : 'raised_match_engaged';

  const updated = applyScoreDelta(raised.id, delta, 'assistant');
  if (sentiment === 'positive') incrementCategorySignals(raised.category_id, 'positive');
  if (sentiment === 'negative') incrementCategorySignals(raised.category_id, 'negative');
  clearSubjectRaisedMarker(raised.id);

  logger.info('Engagement signal applied (raised)', {
    raisedId: raised.id, raisedLabel: raised.label, delta, reason,
    newScore: updated?.engagement_score, status: updated?.status,
  });
  return { subject: updated ?? raised, delta, reason };
}

/**
 * Apply the organic-match signal: person spontaneously matched an existing
 * subject (no pending assistant raise on it). +1, capped at 5.
 *
 * v3.0 follow-up — called from the end-of-chat reconciliation pass for
 * each matched subject that isn't the recently-raised one. Pre-v3.0
 * this fired per-turn from the orchestrator based on the per-turn
 * classifier's subject_match output; that path was stripped because it
 * produced wrong-row writes on label drift.
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
 * In-conversation engagement_rank adjustment — the SOLE rank mover for
 * proactive social (v3.2.6).
 *
 * Owner model: a tail-end social coda costs nothing to ignore. So rank only
 * moves UP on a genuine reply to a coda Maelle raised:
 *   - ANY reply inside the window (pos / neg / neutral) → +1 (engagement)
 *   - no social reply at all → this path never fires → no change
 * A negative reply is NOT a brush-off — it's usually a grievance, which is
 * engagement; down-ranking is owner-directive / revival-aging only, never here.
 *
 * Window anchor is `people_memory.last_initiated_at` (set by recordSocialMoment
 * on EVERY coda — continue AND raise_new). The old anchor read the most-recent
 * RAISED SUBJECT, which is NULL for raise_new (discovery) codas — so a warm
 * reply to "any good music lately?" never scored. Anchoring on last_initiated_at
 * fixes that. There is no longer a 48h coda rank-check (ignoring is free, and
 * engagement is credited here, live, for both coda modes).
 */
export function adjustRankFromColleagueResponse(params: {
  colleagueSlackId: string;
  replyText: string;
  sentiment: 'positive' | 'negative' | 'neutral';
}): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getPersonMemory } = require('../../db/people') as typeof import('../../db/people');
  const person = getPersonMemory(params.colleagueSlackId);
  const lastInit = person?.last_initiated_at;
  if (!lastInit) return;  // no recent Maelle-raised social → nothing to score
  const sinceMs = Date.now() - new Date(lastInit).getTime();
  if (sinceMs > RANK_RESPONSE_WINDOW_MS) return;

  // v3.5.x — ANY live reply inside the window is engagement → +1, regardless of
  // sentiment. A negative reply is usually a GRIEVANCE ("you mis-gendered me"),
  // which is high engagement, not a brush-off; scoring it −1 (the old
  // 'colleague_deflected' branch) penalized the colleague for objecting (Daniel,
  // 2026-06-29). Ignoring a coda still scores nothing (early return above); a
  // down-rank now comes only from an owner directive / revival-aging, never from
  // a colleague's own words. `sentiment` is intentionally no longer consulted.
  adjustEngagementRank(params.colleagueSlackId, 1, 'reply_engaged');
}

