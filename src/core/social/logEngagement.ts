/**
 * Engagement signal applier.
 *
 * v4.5.9 (#198) — rebased onto the per-person CATEGORY score
 * (social_person_category_scores, 0..3) instead of a per-subject score.
 * Subjects no longer carry a score at all; they carry `status` (live|dead)
 * and `unanswered_raises` (dies at 2 — see socialSubjects.ts). Rules:
 *
 *   - Person spontaneously matches an existing subject (no recent assistant
 *     raise) → the subject's CATEGORY moves +1 (−1 if negative sentiment).
 *   - Assistant raised + person's NEXT chat:
 *       · matches the raised subject + non-negative sentiment → category +1,
 *         subject's unanswered_raises resets to 0 (it was answered)
 *       · matches + negative sentiment                        → category −1,
 *         same reset (still answered — a grievance is engagement, not silence)
 *       · doesn't match (pivot)  → no category movement; the SUBJECT's
 *         unanswered_raises +1, dies at 2 (recordSubjectUnanswered)
 *
 * No time-based ENGAGEMENT movement anywhere (answer 14) — a score only ever
 * moves in response to something that actually occurred in a chat. (The one
 * calendar-driven death, `social_subjects.relevant_until` — owner design
 * 2026-08-30 — is a stored date fact about the subject itself, swept in
 * db/socialSubjects.ts; it is not an engagement signal and not this file's.)
 */

import {
  getMostRecentRaisedSubject,
  getSubjectById,
  recordSubjectAnswered,
  recordSubjectUnanswered,
  recordSubjectTouch,
  adjustCategoryScore,
  type SocialSubject,
} from '../../db/socialSubjects';
import { adjustEngagementRank } from '../../db/engagementRank';
import logger from '../../utils/logger';

const RANK_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * v3.0 follow-up — raise-feedback signal applied at end-of-chat (not
 * per-turn). Inputs: the matched subjects from this chat (subject_id +
 * per-decision sentiment). Looks at the most-recently-raised subject for
 * this person; if any matched subject equals the raised one, apply the
 * appropriate category-score delta and reset the subject's unanswered-raise
 * counter (it was answered). If the raised subject was NOT touched in this
 * chat (pivot path), record it as an unanswered raise — the subject dies at
 * MAX_UNANSWERED_RAISES, never on a clock.
 */
export function applyRaiseFeedbackForMatches(params: {
  ownerUserId: string;
  personSlackId: string;
  matchedSubjects: Array<{ id: string; sentiment: 'positive' | 'negative' | 'neutral' }>;
  /**
   * gh#198 (answer 21a) — GUARD THE PIVOT. A coda's own delivery appends a
   * message to the thread it was posted in, which is what makes end-of-chat
   * reconciliation pick that same thread up ~30-35 min later (capturePass's
   * SILENCE_MINUTES=30 + the 5-min background tick) — almost always BEFORE
   * the person has had any real chance to respond. Left unguarded, that
   * reconciliation pass sees "matched subjects" drawn from whatever the
   * thread already contained (frequently none of them the just-raised one)
   * and calls this a pivot — so a raise was routinely marked unanswered
   * inside the very chat it was delivered in, pre-empting the 24h resolve-
   * on-read mechanism this counter is supposed to run on.
   *
   * The caller (capturePass.ts) sets this false when the thread's OWN prior
   * captured_at predates the raise — i.e. this is the first reconciliation
   * pass to see the raise at all, not a genuinely separate later cycle. A
   * factual data check ("has this thread actually been captured since the
   * raise?"), never an elapsed-time guess. Defaults true so any other
   * caller (there are none today) keeps the original pivot behavior.
   */
  allowPivotDetection?: boolean;
}): { subject: SocialSubject | null; delta: number; reason: string } {
  const { ownerUserId, personSlackId, matchedSubjects, allowPivotDetection = true } = params;

  const raised = getMostRecentRaisedSubject(ownerUserId, personSlackId);
  if (!raised) return { subject: null, delta: 0, reason: 'no_raised_subject' };

  const raisedMatch = matchedSubjects.find(m => m.id === raised.id);
  if (!raisedMatch) {
    if (!allowPivotDetection) {
      // This reconciliation pass is the coda's own first capture cycle —
      // leave the raise marker standing. The next reconciliation cycle (a
      // genuine later chat) or the 24h resolve-on-read will judge it.
      logger.info('Engagement signal — raised pivot suppressed (same capture cycle as the raise)', {
        raisedId: raised.id, raisedLabel: raised.label,
      });
      return { subject: raised, delta: 0, reason: 'raised_pivot_suppressed_same_capture_cycle' };
    }
    // Pivot — the chat didn't touch the raised subject. This IS the
    // unanswered-raise signal: +1 to unanswered_raises, dies at 2. Replaces
    // both the old 72h-window ignored-raise decay and the weekly decay pass
    // — neither exists any more.
    const updated = recordSubjectUnanswered(raised.id);
    logger.info('Engagement signal — raised pivot (unanswered raise recorded)', {
      raisedId: raised.id, raisedLabel: raised.label,
      unansweredRaises: updated?.unanswered_raises, status: updated?.status,
    });
    return { subject: updated ?? raised, delta: 0, reason: 'raised_pivot_unanswered' };
  }

  const sentiment = raisedMatch.sentiment;
  const delta = sentiment === 'negative' ? -1 : +1;
  const reason = sentiment === 'negative' ? 'raised_match_negative' : 'raised_match_engaged';

  // The raise got a real reply — move the CATEGORY's per-person standing
  // (subjects no longer carry a score) and reset the subject's
  // unanswered-raise counter; it was answered, live or not.
  adjustCategoryScore({ ownerUserId, personSlackId, categoryId: raised.category_id, delta });
  const updated = recordSubjectAnswered(raised.id, 'assistant');

  logger.info('Engagement signal applied (raised)', {
    raisedId: raised.id, raisedLabel: raised.label, delta, reason, status: updated?.status,
  });
  return { subject: updated ?? raised, delta, reason };
}

/**
 * Apply the organic-match signal: person spontaneously matched an existing
 * subject (no pending assistant raise on it). Moves that subject's CATEGORY
 * +1 (−1 if venting negatively about it), capped 0..3, and records the touch
 * on the subject itself.
 *
 * v3.0 follow-up — called from the end-of-chat reconciliation pass for
 * each matched subject that isn't the recently-raised one.
 */
export function applyOrganicMatchSignal(params: {
  ownerUserId: string;
  personSlackId: string;
  matchedSubjectId: string;
  initiator: 'owner' | 'colleague';
  sentiment: 'positive' | 'negative' | 'neutral';
}): SocialSubject | null {
  const { ownerUserId, personSlackId, matchedSubjectId, initiator, sentiment } = params;
  const subject = getSubjectById(matchedSubjectId);
  if (!subject) return null;

  const delta = sentiment === 'negative' ? -1 : +1;
  adjustCategoryScore({ ownerUserId, personSlackId, categoryId: subject.category_id, delta });
  const updated = recordSubjectTouch(matchedSubjectId, initiator);
  logger.info('Engagement signal applied (organic)', {
    subjectId: matchedSubjectId, categoryId: subject.category_id, delta, sentiment,
  });
  return updated;
}

/**
 * Stamp the social bookkeeping for a coda that has actually been DELIVERED.
 *
 * Called by the transport from its fire-and-forget timer once the post is
 * confirmed; the ids come over on `OrchestratorOutput.socialCoda`.
 *
 * This used to run at GENERATION time in the orchestrator's coda block, which was
 * exact while the coda was concatenated onto the reply — stamping meant sending.
 * Once the coda became its own message posted a beat later, generation stopped
 * implying delivery: the transport drops it on a leak hit, a prep throw, the
 * person speaking again inside the beat, another turn answering first, or a failed
 * post. Every drop still burned that person's one ping for the day AND left the
 * subject marked as raised for a line nobody ever saw. Delivery is the only
 * event that should move either field.
 *
 * Two writes, guarded SEPARATELY and in this order on purpose:
 *   1. `recordSocialMoment` → `people_memory.last_initiated_at`. This is the
 *      once-per-day cadence gate AND the window anchor
 *      `adjustRankFromColleagueResponse` (below) scores replies against. For a
 *      `raise_new` coda it is the ONLY gate — there is no subject row yet — so it
 *      goes first and a failure in the second write cannot cost us the gate.
 *   2. `markSubjectRaised` → `social_subjects.last_assistant_initiated_at`, which
 *      drives the raise→ignored/answered signal on the person's next chat and
 *      (for `continue` codas) a second independent read of the daily gate.
 *      Absent on `raise_new`.
 *
 * NEVER throws. The caller is a `setTimeout` in the transport where an escaped
 * rejection is an unhandled one, and a social aside is optional by definition —
 * but the gate failing OPEN is the one outcome worth shouting about, because it is
 * the only way the same person gets pinged twice in a day.
 */
export function recordCodaDelivered(params: {
  personSlackId: string;
  subjectId?: string;
}): void {
  const { personSlackId, subjectId } = params;

  let gateStamped = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordSocialMoment } = require('../../db/people') as typeof import('../../db/people');
    // Returns false when this slack_id has no people_memory row, in which case
    // NOTHING was written — a silent no-op before the return value existed.
    gateStamped = recordSocialMoment(personSlackId, 'maelle');
  } catch (err) {
    logger.error('Coda cadence gate write THREW after delivery', {
      personSlackId, subjectId: subjectId ?? null, err: String(err).slice(0, 200),
    });
  }
  if (!gateStamped) {
    logger.error('Coda posted but the 24h gate did NOT close — this person can be pinged again today', {
      personSlackId, subjectId: subjectId ?? null,
      // `continue` codas are still gated by the raise marker below (the picker
      // reads social_subjects too); a raise_new coda has nothing else holding it.
      secondGate: subjectId ? 'raise_marker' : 'none',
    });
  }

  if (subjectId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { markSubjectRaised } = require('../../db/socialSubjects') as
        typeof import('../../db/socialSubjects');
      markSubjectRaised(subjectId);
    } catch (err) {
      logger.warn('Coda raise-marker write threw — raise-feedback signal lost for this subject', {
        personSlackId, subjectId, err: String(err).slice(0, 200),
      });
    }
  }

  logger.info('Social coda delivery recorded', {
    personSlackId, subjectId: subjectId ?? null, gateStamped,
  });
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
 * Window anchor is `people_memory.last_initiated_at`, stamped by
 * `recordCodaDelivered` above on every coda that was actually DELIVERED —
 * continue AND raise_new. The old anchor read the most-recent RAISED SUBJECT,
 * which is NULL for raise_new (discovery) codas — so a warm reply to "any good
 * music lately?" never scored. Anchoring on last_initiated_at fixes that. Because
 * the stamp now follows delivery rather than generation, a reply can no longer be
 * credited as engagement with a coda the transport dropped and the person never
 * saw. There is no longer a 48h coda rank-check (ignoring is free, and engagement
 * is credited here, live, for both coda modes).
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
