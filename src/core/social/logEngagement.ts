/**
 * Post-turn engagement logger (v2.2).
 *
 * Called by the orchestrator AFTER the reply is produced, whenever the social
 * pre-pass decided a non-'none' directive fired. Writes one row to the
 * social_engagements log, applies a score delta to the involved topic (if
 * any), and nudges the category's signal counters so care_level can drift.
 *
 * Two triggers:
 *
 * 1) `logOwnerInitiated` — owner said something social. The classification
 *    already ran; the reconciler created/matched a topic. We log the owner's
 *    initiation and apply a positive score bump.
 *
 * 2) `logMaelleInitiated` — Maelle proactively raised or continued a topic.
 *    (Not wired yet in this pass — scaffolding for the future "proactive
 *    social tick" path. Left here so the logging surface is complete.)
 *
 * Upgrade-on-response logic (the v2.0.2 pattern of upgrading quality when
 * the owner engages with depth) is deliberately NOT ported. The new model
 * tracks score deltas per-engagement directly — each owner response after
 * a Maelle initiation writes its own row with the appropriate score_delta.
 * The state machine and reconciler decide when; this function just writes.
 */

import {
  applyScoreDelta,
  incrementCategorySignals,
  logEngagementRow,
  type EngagementDirection,
  type EngagementSignal,
  type SocialTopic,
} from '../../db/socialTopics';
import type { SocialDirective } from './stateMachine';
import type { OwnerIntentClassification } from './classifyOwnerIntent';
import logger from '../../utils/logger';

// Scoring table — aligned with the design locked in for v2.2.
//
// Cap at 10, floor at 0 (enforced inside applyScoreDelta).
export function scoreDeltaFor(params: {
  direction: EngagementDirection;
  signal: EngagementSignal;
  newTopic: boolean;
}): number {
  const { direction, signal, newTopic } = params;

  if (direction === 'owner_initiated') {
    return newTopic ? 5 : 3; // Owner surfacing a topic gets the biggest boost
  }

  if (direction === 'maelle_initiated') {
    if (signal === 'positive') return 3;
    if (signal === 'neutral') return -1;
    if (signal === 'negative') return -3;
    return 0;
  }

  if (direction === 'maelle_response') {
    // Maelle responding to something owner brought up — we don't re-score
    // here, owner_initiated already bumped. Engagement log gets the row
    // (audit trail) but score_delta is 0.
    return 0;
  }

  if (direction === 'owner_response') {
    // Owner replying to a Maelle-initiated turn. The valence of their
    // response is what changes the score — effectively the same table as
    // maelle_initiated but attached to owner_response for the audit log.
    if (signal === 'positive') return 3;
    if (signal === 'neutral') return -1;
    if (signal === 'negative') return -3;
    return 0;
  }

  return 0;
}

export function logOwnerInitiated(params: {
  ownerUserId: string;
  directive: SocialDirective;
  classification: OwnerIntentClassification | null;
  turnRef?: string | null;
}): void {
  const { ownerUserId, directive, classification, turnRef } = params;

  // No topic / no category → nothing meaningful to log. Classifier may have
  // returned 'social' without category hint (rare, generic small talk) — we
  // skip the log since there's no topic_id / category_id FK target.
  const categoryIdFromTopic = directive.topic?.category_id;
  const fallbackCategoryId = directive.categoryLabel
    ? deriveCategoryIdFromLabel(ownerUserId, directive.categoryLabel)
    : null;
  const categoryId = categoryIdFromTopic ?? fallbackCategoryId;
  if (!categoryId) return;

  const topicId = directive.topic?.id ?? null;
  const signal: EngagementSignal = classification?.social?.sentiment === 'positive'
    ? 'positive'
    : classification?.social?.sentiment === 'negative'
    ? 'negative'
    : 'neutral';

  const firstMention = directive.firstMention;
  const delta = scoreDeltaFor({
    direction: 'owner_initiated',
    signal,
    newTopic: firstMention,
  });

  try {
    // Double-count guard: when the topic was just created by the reconciler
    // this turn, the initial score already reflects the owner-initiated
    // boost (createTopic seeded it at 5 for owner). Log the engagement row
    // for the audit trail, but skip applyScoreDelta — otherwise one mention
    // would double-bump from 5 → 10 in a single turn.
    if (topicId && delta !== 0 && !firstMention) {
      applyScoreDelta(topicId, delta, 'owner');
    }

    logEngagementRow({
      ownerUserId,
      topicId,
      categoryId,
      direction: 'owner_initiated',
      signal,
      scoreDelta: delta,
      turnRef: turnRef ?? null,
    });

    // Positive signals nudge the category's care_level up; negatives nudge down.
    if (signal === 'positive') incrementCategorySignals(categoryId, 'positive');
    else if (signal === 'negative') incrementCategorySignals(categoryId, 'negative');
  } catch (err) {
    logger.warn('logOwnerInitiated threw — non-fatal', { err: String(err).slice(0, 300) });
  }
}

/**
 * Scaffolding for when a proactive-social-tick path is added. Not called
 * anywhere in v2.2's owner-turn flow (Maelle-initiated social currently
 * doesn't land in the main orchestrator path). Safe to invoke manually.
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

function deriveCategoryIdFromLabel(ownerUserId: string, label: string): string {
  return `cat_${ownerUserId}_${label}`.replace(/[^a-zA-Z0-9_]/g, '_');
}
