/**
 * Topic reconciler (v2.2.1).
 *
 * Translates a classifier hint ({category, topic_label}) into a concrete
 * (categoryId, topicId) pair scoped to a specific PERSON (owner or colleague).
 * Creates topic rows on first mention so the engagement log can reference them.
 * Revives dormant topics when the person mentions them again.
 *
 * Categories are global. Topics are per-(owner, person).
 */

import {
  type SocialCategory,
  type SocialTopic,
  type TopicToucher,
  getCategoryByLabel,
  getActiveTopicsForPersonCategory,
  getDormantTopicsForPerson,
  createTopic,
  reviveTopic,
} from '../../db/socialTopics';
import logger from '../../utils/logger';

export type ReconcileAction =
  | 'matched_active'          // existing active topic matched
  | 'revived_dormant'         // person revived a dormant topic
  | 'created_under_category'  // new topic created under a known category
  | 'category_only'           // category matched but no topic label given
  | 'no_category';            // classifier gave no category hint — no-op

export interface ReconcileResult {
  action: ReconcileAction;
  category: SocialCategory | null;
  topic: SocialTopic | null;
}

export function reconcileTopic(params: {
  ownerUserId: string;
  personSlackId: string;
  categoryHint?: string;
  topicLabelHint?: string;
  initiator: TopicToucher;
}): ReconcileResult {
  const { ownerUserId, personSlackId, categoryHint, topicLabelHint, initiator } = params;

  if (!categoryHint) {
    return { action: 'no_category', category: null, topic: null };
  }

  const category = getCategoryByLabel(categoryHint);
  if (!category) {
    logger.warn('reconcileTopic — category hint not in global set', { categoryHint });
    return { action: 'no_category', category: null, topic: null };
  }

  if (!topicLabelHint || topicLabelHint.trim().length === 0) {
    return { action: 'category_only', category, topic: null };
  }

  const normalized = normalizeLabel(topicLabelHint);

  // Match existing active topic for this person under this category
  const active = getActiveTopicsForPersonCategory(personSlackId, category.id);
  const activeMatch = active.find(t => labelsMatch(normalizeLabel(t.label), normalized));
  if (activeMatch) {
    return { action: 'matched_active', category, topic: activeMatch };
  }

  // Try dormant revive (same person + same category)
  const dormant = getDormantTopicsForPerson(personSlackId);
  const dormantMatch = dormant.find(
    t => t.category_id === category.id && labelsMatch(normalizeLabel(t.label), normalized),
  );
  if (dormantMatch) {
    // Revival allowed only when initiator is the person themself (owner or colleague).
    // Maelle cannot unilaterally revive a dormant topic.
    if (initiator === 'owner' || initiator === 'colleague') {
      const revived = reviveTopic(dormantMatch.id, true);
      return { action: 'revived_dormant', category, topic: revived };
    }
    return { action: 'category_only', category, topic: null };
  }

  // Create on first mention. Person-initiated (owner/colleague) starts at 5;
  // Maelle-initiated starts at 3.
  const initialScore = (initiator === 'owner' || initiator === 'colleague') ? 5 : 3;
  const created = createTopic({
    ownerUserId,
    personSlackId,
    categoryId: category.id,
    label: topicLabelHint.trim(),
    createdBy: initiator,
    initialScore,
  });

  return { action: 'created_under_category', category, topic: created };
}

/**
 * Normalize a topic label for fuzzy matching.
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
