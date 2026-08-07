/**
 * v4.4.9 — backfill the pre-fix social provenance mis-stamp (gh#154-R7).
 *
 * Before cc7d4ce (4.4.8), `runSubjectReconciliation` (capturePass.ts) stamped
 * EVERY write `created_by='owner'` regardless of which leg was reconciling.
 * cc7d4ce fixed the writer going forward (`toucher` now derives 'owner' vs
 * 'colleague' from whether `personSlackId` is the owner's own), but that only
 * affects NEW writes — every row the old code produced on a colleague-DM leg
 * is still wearing the wrong stamp, and `buildSocialContextBlockById`'s
 * `created_by !== 'owner'` filter (people.ts) drops every one of them, so the
 * "Things you've talked about together" block still renders empty for every
 * colleague on file.
 *
 * A subject's own `person_slack_id` says which leg created it:
 * `person_slack_id === owner_user_id` is the owner's own subject (genuinely
 * owner-authored); anything else can ONLY have been written on a colleague-DM
 * leg, because the owner-leg only ever reconciles subjects scoped to the
 * owner's own person_slack_id (`getActiveSubjectsForPerson(personSlackId)`
 * called with the owner's id). So a row with `person_slack_id != owner_user_id`
 * still marked `created_by='owner'` (or `last_touched_by='owner'`) can never be
 * a legitimate owner-authored row post-fix — it is the pre-fix mis-stamp.
 * `social_topics` carries no owner/person columns of its own; it inherits the
 * same test via its parent subject.
 *
 * Idempotent: only rows matching that combination are touched, and a clean
 * table (post-backfill, or a fresh install) makes both statements no-ops.
 * Runs on every boot — cheap (bounded by social_subjects/social_topics size).
 */

import type Database from 'better-sqlite3';
import logger from '../../utils/logger';

export function runSocialProvenanceBackfill(db: Database.Database): void {
  let subjectsFixed = 0;
  let topicsFixed = 0;
  try {
    const subjRes = db.prepare(`
      UPDATE social_subjects
      SET created_by = 'colleague',
          last_touched_by = CASE WHEN last_touched_by = 'owner' THEN 'colleague' ELSE last_touched_by END,
          updated_at = datetime('now')
      WHERE person_slack_id != owner_user_id AND created_by = 'owner'
    `).run();
    subjectsFixed = subjRes.changes;

    const topicRes = db.prepare(`
      UPDATE social_topics
      SET created_by = 'colleague'
      WHERE created_by = 'owner'
        AND subject_id IN (
          SELECT id FROM social_subjects WHERE person_slack_id != owner_user_id
        )
    `).run();
    topicsFixed = topicRes.changes;
  } catch (err) {
    logger.error('v4.4.9 social-provenance backfill threw — continuing', { err: String(err) });
    return;
  }
  if (subjectsFixed > 0 || topicsFixed > 0) {
    logger.warn('v4.4.9 social-provenance backfill — mis-stamped colleague rows corrected', {
      subjectsFixed, topicsFixed,
    });
  }
}
