/**
 * Post-turn engagement logger (v2.2.1).
 *
 * Called by the orchestrator AFTER a reply is produced, when the social
 * pre-pass fired a non-'none' directive. Writes one row to social_engagements,
 * applies score delta to the topic (if any), and nudges category signal
 * counters.
 *
 * Works for owner turns (person_slack_id = owner) and colleague turns
 * (person_slack_id = colleague.slack_id).
 */

import {
  applyScoreDelta,
  incrementCategorySignals,
  logEngagementRow,
  lastMaelleInitiatedAt,
  type EngagementDirection,
  type EngagementSignal,
  type SocialTopic,
  type TopicToucher,
} from '../../db/socialTopics';
import { adjustEngagementRank } from '../../db/engagementRank';
import type { SocialDirective } from './stateMachine';
import type { OwnerIntentClassification } from './classifyOwnerIntent';
import logger from '../../utils/logger';

const RANK_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const BRIEF_REPLY_CHAR_LIMIT = 30;

export function scoreDeltaFor(params: {
  direction: EngagementDirection;
  signal: EngagementSignal;
  newTopic: boolean;
}): number {
  const { direction, signal, newTopic } = params;

  if (direction === 'owner_initiated' || direction === 'colleague_initiated') {
    return newTopic ? 5 : 3;
  }

  if (direction === 'maelle_initiated') {
    if (signal === 'positive') return 3;
    if (signal === 'neutral') return -1;
    if (signal === 'negative') return -3;
    return 0;
  }

  if (direction === 'maelle_response') {
    return 0;
  }

  if (direction === 'owner_response' || direction === 'colleague_response') {
    if (signal === 'positive') return 3;
    if (signal === 'neutral') return -1;
    if (signal === 'negative') return -3;
    return 0;
  }

  return 0;
}

export function logPersonInitiated(params: {
  ownerUserId: string;
  personSlackId: string;
  senderRole: 'owner' | 'colleague';
  directive: SocialDirective;
  classification: OwnerIntentClassification | null;
  turnRef?: string | null;
}): void {
  const { ownerUserId, personSlackId, senderRole, directive, classification, turnRef } = params;

  const categoryIdFromTopic = directive.topic?.category_id;
  const fallbackCategoryId = directive.categoryLabel
    ? `cat_global_${directive.categoryLabel}`
    : null;
  const categoryId = categoryIdFromTopic ?? fallbackCategoryId;
  if (!categoryId) return;

  const topicId = directive.topic?.id ?? null;
  const signal: EngagementSignal = classification?.social?.sentiment === 'positive'
    ? 'positive'
    : classification?.social?.sentiment === 'negative'
    ? 'negative'
    : 'neutral';

  const direction: EngagementDirection = senderRole === 'owner' ? 'owner_initiated' : 'colleague_initiated';
  const initiator: TopicToucher = senderRole;

  const firstMention = directive.firstMention;
  const delta = scoreDeltaFor({ direction, signal, newTopic: firstMention });

  try {
    if (topicId && delta !== 0 && !firstMention) {
      applyScoreDelta(topicId, delta, initiator);
    }

    logEngagementRow({
      ownerUserId,
      personSlackId,
      topicId,
      categoryId,
      direction,
      signal,
      scoreDelta: delta,
      turnRef: turnRef ?? null,
    });

    if (signal === 'positive') incrementCategorySignals(categoryId, 'positive');
    else if (signal === 'negative') incrementCategorySignals(categoryId, 'negative');
  } catch (err) {
    logger.warn('logPersonInitiated threw — non-fatal', { err: String(err).slice(0, 300) });
  }
}

/**
 * Logs a Maelle-initiated social moment (proactive or continuation). Used by
 * the piggyback path. Signal defaults to 'none' at the moment of initiation;
 * the in-conversation rank-check pass updates the row (or writes a response
 * row) once the person replies.
 */
export function logMaelleInitiated(params: {
  ownerUserId: string;
  topic: SocialTopic;
  signal: EngagementSignal;
  turnRef?: string | null;
}): void {
  const { ownerUserId, topic, signal, turnRef } = params;
  const delta = scoreDeltaFor({
    direction: 'maelle_initiated',
    signal,
    newTopic: false,
  });
  try {
    if (delta !== 0) applyScoreDelta(topic.id, delta, 'maelle');
    logEngagementRow({
      ownerUserId,
      personSlackId: topic.person_slack_id,
      topicId: topic.id,
      categoryId: topic.category_id,
      direction: 'maelle_initiated',
      signal,
      scoreDelta: delta,
      turnRef: turnRef ?? null,
    });
    if (signal === 'positive') incrementCategorySignals(topic.category_id, 'positive');
    else if (signal === 'negative') incrementCategorySignals(topic.category_id, 'negative');
  } catch (err) {
    logger.warn('logMaelleInitiated threw — non-fatal', { err: String(err).slice(0, 300) });
  }
}

/**
 * In-conversation rank adjustment (v2.2.1).
 *
 * When a colleague replies inside an active conversation, check whether
 * the reply is a response to a recent Maelle-initiated social moment
 * (piggyback ping or continuation). If so, nudge the colleague's
 * engagement_rank:
 *   - positive + reply length > 30 chars → +1
 *   - negative                           → -1
 *   - neutral / brief                    → 0 (no change)
 *
 * Fires only when the last Maelle initiation for this person was within
 * the last 24h. Older than that, we assume any current reply is a fresh
 * conversation, not a response. The proactive-ping path
 * (`social_ping_rank_check`) still handles its 48h window separately for
 * out-of-conversation DMs.
 */
export function adjustRankFromColleagueResponse(params: {
  colleagueSlackId: string;
  replyText: string;
  sentiment: EngagementSignal;
}): void {
  const lastInit = lastMaelleInitiatedAt(params.colleagueSlackId);
  if (!lastInit) return;
  const sinceMs = Date.now() - new Date(lastInit).getTime();
  if (sinceMs > RANK_RESPONSE_WINDOW_MS) return;

  const len = params.replyText.trim().length;
  if (params.sentiment === 'negative') {
    adjustEngagementRank(params.colleagueSlackId, -1, 'reply_brief');
  } else if (params.sentiment === 'positive' && len > BRIEF_REPLY_CHAR_LIMIT) {
    adjustEngagementRank(params.colleagueSlackId, 1, 'reply_engaged');
  }
  // neutral/short → no change (still engagement, just not boosting)
}

// Back-compat alias (v2.2.0 called this logOwnerInitiated)
export const logOwnerInitiated = logPersonInitiated;
