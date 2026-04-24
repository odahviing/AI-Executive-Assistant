/**
 * Topic reconciler (v2.2).
 *
 * Translates a classifier hint ({category, topic_label}) into a concrete
 * (categoryId, topicId) pair. Creates topic rows on first mention so the
 * engagement log can reference them. Revives dormant topics when owner
 * mentions them again.
 *
 * Fuzzy matching is intentionally generous — a topic label is a short human
 * phrase ("Clair Obscur", "Clair Obscur axons", "clair obscur progress"
 * should all map to the same topic). Levenshtein would be overkill; a
 * normalized-substring strategy is sufficient at this scale (few topics per
 * category, conversational labels).
 */

import {
  type SocialCategory,
  type SocialTopic,
  getCategoryByLabel,
  getActiveTopicsForCategory,
  getDormantTopicsForOwner,
  createTopic,
  reviveTopic,
} from '../../db/socialTopics';
import logger from '../../utils/logger';

export type ReconcileAction =
  | 'matched_active'        // existing active topic matched
  | 'revived_dormant'       // owner revived a dormant topic
  | 'created_under_category'// new topic created under a known category
  | 'category_only'         // category matched but no topic label given
  | 'no_category';          // classifier gave no category hint — no-op

export interface ReconcileResult {
  action: ReconcileAction;
  category: SocialCategory | null;
  topic: SocialTopic | null;
}

export function reconcileTopic(params: {
  ownerUserId: string;
  categoryHint?: string;
  topicLabelHint?: string;
  initiator: 'owner' | 'maelle';
}): ReconcileResult {
  const { ownerUserId, categoryHint, topicLabelHint, initiator } = params;

  if (!categoryHint) {
    return { action: 'no_category', category: null, topic: null };
  }

  const category = getCategoryByLabel(ownerUserId, categoryHint);
  if (!category) {
    // Shouldn't happen — classifier only returns categories from FIXED_CATEGORIES
    // and those are all seeded on startup. Log and bail.
    logger.warn('reconcileTopic — category hint not found in DB', { categoryHint, ownerUserId });
    return { action: 'no_category', category: null, topic: null };
  }

  if (!topicLabelHint || topicLabelHint.trim().length === 0) {
    return { action: 'category_only', category, topic: null };
  }

  const normalized = normalizeLabel(topicLabelHint);

  // Try to match an existing active topic under this category
  const active = getActiveTopicsForCategory(category.id);
  const activeMatch = active.find(t => labelsMatch(normalizeLabel(t.label), normalized));
  if (activeMatch) {
    return { action: 'matched_active', category, topic: activeMatch };
  }

  // Try to match a dormant topic for this owner (any category, then verify)
  const dormant = getDormantTopicsForOwner(ownerUserId);
  const dormantMatch = dormant.find(
    t => t.category_id === category.id && labelsMatch(normalizeLabel(t.label), normalized),
  );
  if (dormantMatch) {
    if (initiator === 'owner') {
      const revived = reviveTopic(dormantMatch.id, true);
      return { action: 'revived_dormant', category, topic: revived };
    }
    // Maelle cannot revive dormant topics on her own — spec rule.
    // Treat as no-match and DO NOT create a duplicate; return category-only.
    return { action: 'category_only', category, topic: null };
  }

  // No match — create a new topic. Per owner instruction: create on first
  // mention so the category accumulates signal (evidence of caring).
  const created = createTopic({
    ownerUserId,
    categoryId: category.id,
    label: topicLabelHint.trim(),
    createdBy: initiator,
    initialScore: initiator === 'owner' ? 5 : 3, // owner-initiated gets head start
  });

  return { action: 'created_under_category', category, topic: created };
}

/**
 * Normalize a topic label for fuzzy matching:
 *   - lowercase
 *   - strip punctuation
 *   - collapse whitespace
 *   - remove common filler words
 */
function normalizeLabel(label: string): string {
  const FILLER = new Set([
    'the', 'a', 'an', 'my', 'your', 'our', 'their', 'his', 'her',
    'is', 'are', 'was', 'were', 'of', 'for', 'with', 'about',
    'progress', 'update', 'news', 'thing', 'stuff',
  ]);
  const cleaned = label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 0 && !FILLER.has(w))
    .join(' ');
  return cleaned;
}

/**
 * Two labels match if one is a substring of the other, or if they share
 * a significant number of tokens. Loose by design — conversational labels
 * like "Clair Obscur", "Clair Obscur axons", "clair obscur lately" should
 * all resolve to the same topic.
 */
function labelsMatch(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const tokensA = new Set(a.split(' '));
  const tokensB = new Set(b.split(' '));
  const intersection = [...tokensA].filter(t => tokensB.has(t)).length;
  const unionSize = new Set([...tokensA, ...tokensB]).size;
  if (unionSize === 0) return false;
  const jaccard = intersection / unionSize;
  return jaccard >= 0.5;
}

export { normalizeLabel, labelsMatch };
