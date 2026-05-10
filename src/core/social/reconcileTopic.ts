/**
 * Subject reconciler (v2.6.7 redesign).
 *
 * The classifier owns the merge decision (action='match_existing' vs
 * 'create_new' with full semantic context). This module is a thin DB layer
 * that applies the verdict: load the matched subject, or insert a new one,
 * plus record the topic-beat under it.
 *
 * Pre-redesign this module had a Jaccard ≥ 0.5 surface-string matcher that
 * couldn't merge sub-beats of the same subject (the 2026-05-10 Clair Obscur
 * fragmentation). All matching logic now lives in the LLM classifier;
 * reconciler is just persistence.
 */

import {
  type SocialCategory,
  type SocialSubject,
  type SubjectToucher,
  getCategoryByLabel,
  getSubjectById,
  createSubject,
  reviveSubject,
  recordTopicBeat,
} from '../../db/socialSubjects';
import type { SubjectMatch } from './classifyOwnerIntent';
import logger from '../../utils/logger';

export type ReconcileAction =
  | 'matched_active'          // existing active subject re-touched
  | 'revived_dormant'         // dormant subject revived by person
  | 'created_under_category'  // brand-new subject
  | 'category_only'           // category matched but no subject decision (no-op)
  | 'no_category';            // classifier gave no category — no-op

export interface ReconcileResult {
  action: ReconcileAction;
  category: SocialCategory | null;
  subject: SocialSubject | null;
  topicBeatRecorded: boolean;
}

export function reconcileSubject(params: {
  ownerUserId: string;
  personSlackId: string;
  categoryHint?: string;
  subjectMatch?: SubjectMatch;
  topicLabel?: string;
  initiator: SubjectToucher;
  sentiment?: 'positive' | 'negative' | 'neutral';
}): ReconcileResult {
  const { ownerUserId, personSlackId, categoryHint, subjectMatch, topicLabel, initiator, sentiment } = params;

  if (!categoryHint) {
    return { action: 'no_category', category: null, subject: null, topicBeatRecorded: false };
  }

  const category = getCategoryByLabel(categoryHint);
  if (!category) {
    logger.warn('reconcileSubject — category hint not in global set', { categoryHint });
    return { action: 'no_category', category: null, subject: null, topicBeatRecorded: false };
  }

  if (!subjectMatch) {
    return { action: 'category_only', category, subject: null, topicBeatRecorded: false };
  }

  let subject: SocialSubject | null = null;
  let action: ReconcileAction = 'category_only';

  if (subjectMatch.action === 'match_existing' && subjectMatch.existing_subject_id) {
    const existing = getSubjectById(subjectMatch.existing_subject_id);
    if (existing) {
      if (existing.status === 'dormant' && (initiator === 'owner' || initiator === 'colleague')) {
        // Revive dormant subjects only when the person themself touches them.
        subject = reviveSubject(existing.id);
        action = 'revived_dormant';
      } else {
        subject = existing;
        action = 'matched_active';
      }
    }
  }

  if (!subject && (subjectMatch.action === 'create_new' || subjectMatch.action === 'match_existing')) {
    // Either an explicit create_new, or a match_existing that lost its row
    // (rare race / id mismatch — treat as create_new with the proposed label).
    subject = createSubject({
      ownerUserId,
      personSlackId,
      categoryId: category.id,
      label: subjectMatch.label.trim(),
      createdBy: initiator,
    });
    action = 'created_under_category';
  }

  // Record a topic-beat under the subject when we have one.
  let topicBeatRecorded = false;
  if (subject && topicLabel && topicLabel.trim().length > 0) {
    try {
      recordTopicBeat({
        subjectId: subject.id,
        label: topicLabel.trim(),
        sentiment: sentiment ?? 'neutral',
        createdBy: initiator,
      });
      topicBeatRecorded = true;
    } catch (err) {
      logger.warn('reconcileSubject — recordTopicBeat threw, continuing', {
        err: String(err).slice(0, 200),
      });
    }
  }

  return { action, category, subject, topicBeatRecorded };
}

// Back-compat name alias — orchestrator imports `reconcileTopic`.
export const reconcileTopic = reconcileSubject;
