/**
 * Social state machine (v2.6.7 redesign).
 *
 * Pure TypeScript. No LLM, no DB writes. Takes the classifier output + the
 * reconciled subject + rate-limit state and decides ONE directive for the
 * current turn. The directive is what the orchestrator injects into the
 * system prompt for Sonnet to phrase.
 *
 * Picker (proactive slot, EC6):
 *   - Count active categories for this person.
 *   - If ≥3 active: random pick across them; pick subject inside (highest
 *     score, then least-recently-assistant-initiated).
 *   - If <3 active: random over existing PLUS one "raise_new" slot to push
 *     toward 3 actives. Probability schedule:
 *       count=0 → 1.0 (always raise_new)
 *       count=1 → 0.5
 *       count=2 → 0.3
 *   - Within chosen subject, the coda generator picks the least-recently-used
 *     topic-beat (separate concern, in generateCoda).
 */

import type { OwnerIntentClassification } from './classifyOwnerIntent';
import type { ReconcileResult } from './reconcileTopic';
import {
  countAssistantInitiationsTodayForPerson,
  getActiveSubjectsForPerson,
  getActiveSubjectsForPersonCategory,
  getActiveCategoryEngagementForPerson,
  lastAssistantInitiatedAt,
  type SocialSubject,
} from '../../db/socialSubjects';
import logger from '../../utils/logger';

export type SocialMode =
  | 'celebrate'
  | 'engage'
  | 'revive_ack'
  | 'continue'
  | 'raise_new'
  | 'none';

// v2.6.7 — single directive shape. New `subjectId` / `subjectLabel` /
// `subject` fields are the canonical names; legacy `topicId` / `topicLabel`
// / `topic` are mirrored for back-compat with call sites that haven't been
// renamed yet. Both always populated to the same value.
export interface SocialDirective {
  mode: SocialMode;
  subjectId: string | null;
  subjectLabel: string | null;
  categoryLabel: string | null;
  toneCue: string;
  subject: SocialSubject | null;
  firstMention: boolean;
  // Legacy field aliases — same values as subject*.
  topicId: string | null;
  topicLabel: string | null;
  topic: SocialSubject | null;
}

// Back-compat name kept so other modules can import it; same shape as SocialDirective.
export type LegacySocialDirectiveShape = SocialDirective;

function withLegacyShape(d: Omit<SocialDirective, 'topicId' | 'topicLabel' | 'topic'>): SocialDirective {
  return {
    ...d,
    topicId: d.subjectId,
    topicLabel: d.subjectLabel,
    topic: d.subject,
  };
}

// ── Person-initiated social turn ─────────────────────────────────────────────

export function directiveForPersonSocial(params: {
  classification: OwnerIntentClassification;
  reconciled: ReconcileResult;
}): LegacySocialDirectiveShape {
  const { classification, reconciled } = params;
  const social = classification.social;
  if (!social) return withLegacyShape(noDirectiveRaw());

  if (classification.conversation_state === 'closing') {
    return withLegacyShape(noDirectiveRaw());
  }

  const subject = reconciled.subject;
  const firstMention = reconciled.action === 'created_under_category';

  if (reconciled.action === 'revived_dormant') {
    return withLegacyShape({
      mode: 'revive_ack',
      subjectId: subject?.id ?? null,
      subjectLabel: subject?.label ?? null,
      categoryLabel: reconciled.category?.label ?? null,
      toneCue: 'acknowledge the return; pick up where it left off',
      subject,
      firstMention: false,
    });
  }

  if (social.direction === 'share' && social.sentiment === 'positive') {
    return withLegacyShape({
      mode: 'celebrate',
      subjectId: subject?.id ?? null,
      subjectLabel: subject?.label ?? reconciled.category?.label ?? null,
      categoryLabel: reconciled.category?.label ?? null,
      toneCue: 'match the energy; a real congrats, not a pivot to tasks',
      subject,
      firstMention,
    });
  }

  let toneCue: string;
  if (social.sentiment === 'negative') {
    toneCue = 'commiserate, light empathy; no solutions unless asked';
  } else if (social.direction === 'ask_assistant') {
    toneCue = 'answer warmly, like a colleague who\'s been around';
  } else {
    toneCue = 'follow the thread naturally; one short follow-up is fine';
  }

  return withLegacyShape({
    mode: 'engage',
    subjectId: subject?.id ?? null,
    subjectLabel: subject?.label ?? reconciled.category?.label ?? null,
    categoryLabel: reconciled.category?.label ?? null,
    toneCue,
    subject,
    firstMention,
  });
}

// ── Proactive slot picker (EC6: 3-active-categories target) ──────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TARGET_CATEGORIES = 3;

// Probability of raise_new given current active-category count.
function raiseNewProbabilityForCount(count: number): number {
  if (count === 0) return 1.0;
  if (count === 1) return 0.5;
  if (count === 2) return 0.3;
  return 0.0;
}

export function directiveForProactiveSlot(params: {
  personSlackId: string;
  /**
   * Owner timezone for owner-local "today" computation. When omitted, the
   * count helper falls back to UTC midnight (legacy behavior). Threaded
   * from callers that have profile in scope so the per-day-per-person
   * gate resets at owner-local midnight, not UTC.
   */
  ownerTimezone?: string;
}): LegacySocialDirectiveShape {
  const { personSlackId, ownerTimezone } = params;

  // Rank-0 = "do not engage" opt-out. Maelle never INITIATES with rank-0
  // people. Inbound replies / response handling go through other paths
  // (orchestrator's normal flow), so a rank-0 person who reaches out
  // first still gets a normal reply and the engagement signal can lift
  // their rank back up. This gate only blocks proactive initiation.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getEngagementRank } = require('../../db/engagementRank') as
    typeof import('../../db/engagementRank');
  if (getEngagementRank(personSlackId) === 0) {
    return withLegacyShape(noDirectiveRaw());
  }

  // One-per-day-per-person gate (owner-local "today")
  if (countAssistantInitiationsTodayForPerson(personSlackId, ownerTimezone) >= 1) {
    return withLegacyShape(noDirectiveRaw());
  }
  const lastInit = lastAssistantInitiatedAt(personSlackId);
  if (lastInit) {
    const sinceMs = Date.now() - new Date(lastInit).getTime();
    if (sinceMs < ONE_DAY_MS) return withLegacyShape(noDirectiveRaw());
  }

  // EC6: random over active categories; if <3 active, mix in a raise_new chance.
  const activeCategories = getActiveCategoryEngagementForPerson(personSlackId);
  const activeCount = activeCategories.length;

  // Decide whether to raise_new based on growth probability.
  const raiseNewProb = raiseNewProbabilityForCount(activeCount);
  const wantsRaiseNew = activeCount < TARGET_CATEGORIES && Math.random() < raiseNewProb;

  if (wantsRaiseNew || activeCount === 0) {
    return withLegacyShape({
      mode: 'raise_new',
      subjectId: null,
      subjectLabel: null,
      categoryLabel: null,
      toneCue: 'one plain human question that invites a real fact about the person; no preamble',
      subject: null,
      firstMention: false,
    });
  }

  // Pick a random active category.
  const pickedCategory = activeCategories[Math.floor(Math.random() * activeCategories.length)];
  // Within category: highest engagement_score, then least-recently-assistant-initiated.
  const subjects = getActiveSubjectsForPersonCategory(personSlackId, pickedCategory.category_id);
  if (subjects.length === 0) {
    return withLegacyShape({
      mode: 'raise_new',
      subjectId: null,
      subjectLabel: null,
      categoryLabel: null,
      toneCue: 'one plain human question; no preamble',
      subject: null,
      firstMention: false,
    });
  }
  const choice = subjects.slice().sort((a, b) => {
    if (b.engagement_score !== a.engagement_score) return b.engagement_score - a.engagement_score;
    const aTs = a.last_assistant_initiated_at ? new Date(a.last_assistant_initiated_at).getTime() : 0;
    const bTs = b.last_assistant_initiated_at ? new Date(b.last_assistant_initiated_at).getTime() : 0;
    return aTs - bTs;
  })[0];

  return withLegacyShape({
    mode: 'continue',
    subjectId: choice.id,
    subjectLabel: choice.label,
    categoryLabel: pickedCategory.category_label,
    toneCue: 'one short, natural follow-up on this subject; lean on the recent topic-beats Maelle has logged',
    subject: choice,
    firstMention: false,
  });
}

function noDirectiveRaw(): Omit<SocialDirective, 'topicId' | 'topicLabel' | 'topic'> {
  return {
    mode: 'none',
    subjectId: null,
    subjectLabel: null,
    categoryLabel: null,
    toneCue: '',
    subject: null,
    firstMention: false,
  };
}

export function noDirective(): SocialDirective {
  return withLegacyShape(noDirectiveRaw());
}

export function chooseSocialDirective(params: {
  personSlackId: string;
  classification: OwnerIntentClassification;
  reconciled: ReconcileResult;
  /** Owner timezone — threaded through to the proactive-slot daily gate. */
  ownerTimezone?: string;
}): LegacySocialDirectiveShape {
  const { classification, personSlackId, ownerTimezone } = params;

  if (classification.kind === 'task') return noDirective();
  if (classification.kind === 'social') return directiveForPersonSocial(params);
  if (classification.conversation_state === 'closing') return noDirective();
  return directiveForProactiveSlot({ personSlackId, ownerTimezone });
}

export function formatDirectiveForPromptBlock(directive: LegacySocialDirectiveShape): string {
  if (directive.mode === 'none') return '';
  const lines: string[] = [];
  lines.push('## SOCIAL DIRECTIVE (this turn)');
  lines.push(`Mode: ${directive.mode}`);
  if (directive.categoryLabel) lines.push(`Category: ${directive.categoryLabel}`);
  if (directive.subjectLabel) lines.push(`Subject: ${directive.subjectLabel}`);
  lines.push(`Tone: ${directive.toneCue}`);
  lines.push('');
  lines.push('Mode rules:');
  lines.push('- celebrate: acknowledge the win first. No "what do you need" pivot. A real congrats, specific to what was shared.');
  lines.push('- engage: follow the thread naturally. Your reply must PROGRESS the subject — react with something specific, share back, or ask a follow-up that gives the person somewhere to go. A reply that only says "wow cool" is not progress. If YOU just asked a social question and they answered with any substance, stay on that subject — never pivot to "anything work-related" or "let me know if you need anything." The subject stays open until THEY close it.');
  lines.push('- revive_ack: note you remember this subject from before. Pick up where it left off.');
  lines.push('- continue: one short follow-up on a subject from a prior day. Don\'t overdo it. Same rule as engage — progress the subject, never pivot to work.');
  lines.push('- raise_new: one plain human question from a fresh angle. No preamble ("speaking of...", "by the way..."). Just ask.');
  lines.push('');
  lines.push('ABOVE ALL: speak like a person, not a service desk. Celebration, empathy, or genuine curiosity IS the response. Don\'t tack "let me know if you need anything" onto social turns.');
  logger.info('Social directive produced', {
    mode: directive.mode, subject: directive.subjectLabel, category: directive.categoryLabel,
  });
  return lines.join('\n');
}
