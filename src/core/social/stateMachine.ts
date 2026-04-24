/**
 * Social state machine (v2.2.1).
 *
 * Pure TypeScript. No LLM, no DB writes. Takes the classifier output + the
 * reconciled topic + rate-limit state and decides ONE directive for the
 * current turn. The directive is what the orchestrator injects into the
 * system prompt for Sonnet to phrase. Mode selection is deterministic;
 * tone is judgment, so we pass a short cue for Sonnet to run with.
 *
 * Works for both owner turns and colleague turns — the caller passes the
 * relevant person_slack_id and the classifier output.
 */

import type { OwnerIntentClassification } from './classifyOwnerIntent';
import type { ReconcileResult } from './reconcileTopic';
import type { SocialTopic } from '../../db/socialTopics';
import {
  countMaelleInitiationsTodayForPerson,
  getAllTopicsForPerson,
  lastMaelleInitiatedAt,
} from '../../db/socialTopics';
import logger from '../../utils/logger';

export type SocialMode =
  | 'celebrate'
  | 'engage'
  | 'revive_ack'
  | 'continue'
  | 'raise_new'
  | 'none';

export interface SocialDirective {
  mode: SocialMode;
  topicId: string | null;
  topicLabel: string | null;
  categoryLabel: string | null;
  toneCue: string;
  topic: SocialTopic | null;
  firstMention: boolean;
}

// ── Person-initiated social turn ─────────────────────────────────────────────

export function directiveForPersonSocial(params: {
  classification: OwnerIntentClassification;
  reconciled: ReconcileResult;
}): SocialDirective {
  const { classification, reconciled } = params;
  const social = classification.social;
  if (!social) return noDirective();

  const topic = reconciled.topic;
  const firstMention = reconciled.action === 'created_under_category';

  if (reconciled.action === 'revived_dormant') {
    return {
      mode: 'revive_ack',
      topicId: topic?.id ?? null,
      topicLabel: topic?.label ?? null,
      categoryLabel: reconciled.category?.label ?? null,
      toneCue: 'acknowledge the return; pick up where it left off',
      topic,
      firstMention: false,
    };
  }

  if (social.direction === 'share' && social.sentiment === 'positive') {
    return {
      mode: 'celebrate',
      topicId: topic?.id ?? null,
      topicLabel: topic?.label ?? reconciled.category?.label ?? null,
      categoryLabel: reconciled.category?.label ?? null,
      toneCue: 'match the energy; a real congrats, not a pivot to tasks',
      topic,
      firstMention,
    };
  }

  let toneCue: string;
  if (social.sentiment === 'negative') {
    toneCue = 'commiserate, light empathy; no solutions unless asked';
  } else if (social.direction === 'ask_maelle') {
    toneCue = 'answer warmly, like a colleague who\'s been around';
  } else {
    toneCue = 'follow the thread naturally; one short follow-up is fine';
  }

  return {
    mode: 'engage',
    topicId: topic?.id ?? null,
    topicLabel: topic?.label ?? reconciled.category?.label ?? null,
    categoryLabel: reconciled.category?.label ?? null,
    toneCue,
    topic,
    firstMention,
  };
}

// ── Proactive slot (Maelle piggybacks social on 'other'-kind turns) ──────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Called on 'other'-kind turns (and optionally on idle sweeps). Evaluates
 * whether Maelle should piggyback a proactive social moment onto the reply.
 * Rules:
 *   - Maelle must not have initiated with this person in the last 24h
 *   - If there are active topics with score >= 3, pick the longest-since-
 *     Maelle-touched (round-robin); return mode='continue'
 *   - If no continuable topics, return mode='raise_new' (Sonnet picks a
 *     category/topic from the global pool at prompt time)
 */
export function directiveForProactiveSlot(params: {
  personSlackId: string;
}): SocialDirective {
  const { personSlackId } = params;

  // One-per-day-per-person gate
  if (countMaelleInitiationsTodayForPerson(personSlackId) >= 1) {
    return noDirective();
  }
  const lastInit = lastMaelleInitiatedAt(personSlackId);
  if (lastInit) {
    const sinceMs = Date.now() - new Date(lastInit).getTime();
    if (sinceMs < ONE_DAY_MS) return noDirective();
  }

  const activeTopics = getAllTopicsForPerson(personSlackId);

  // Same-day freshness: skip topics Maelle already touched today
  const startOfDayMs = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const freshActive = activeTopics.filter(t => {
    const lastMs = new Date(t.last_touched_at).getTime();
    return lastMs < startOfDayMs || t.last_touched_by !== 'maelle';
  });

  const continuable = freshActive.filter(t => t.engagement_score >= 3);
  if (continuable.length > 0) {
    const threeDaysAgoMs = Date.now() - THREE_DAYS_MS;
    const maelleTouchedRecently = (t: typeof continuable[number]) =>
      t.last_touched_by === 'maelle' && new Date(t.last_touched_at).getTime() >= threeDaysAgoMs;

    const preferred = continuable.filter(t => !maelleTouchedRecently(t));
    const pool = preferred.length > 0 ? preferred : continuable;

    const choice = pool.slice().sort((a, b) => {
      const aMaelle = a.last_touched_by === 'maelle' ? new Date(a.last_touched_at).getTime() : 0;
      const bMaelle = b.last_touched_by === 'maelle' ? new Date(b.last_touched_at).getTime() : 0;
      if (aMaelle !== bMaelle) return aMaelle - bMaelle;
      return b.engagement_score - a.engagement_score;
    })[0];

    return {
      mode: 'continue',
      topicId: choice.id,
      topicLabel: choice.label,
      categoryLabel: null,
      toneCue: 'one short, natural follow-up on this topic',
      topic: choice,
      firstMention: false,
    };
  }

  return {
    mode: 'raise_new',
    topicId: null,
    topicLabel: null,
    categoryLabel: null,
    toneCue: 'one plain human question from a fresh category; no preamble',
    topic: null,
    firstMention: false,
  };
}

export function noDirective(): SocialDirective {
  return {
    mode: 'none',
    topicId: null,
    topicLabel: null,
    categoryLabel: null,
    toneCue: '',
    topic: null,
    firstMention: false,
  };
}

/**
 * Single entry the orchestrator calls. Picks the right branch:
 *   kind='task'   → NEVER social (task always wins)
 *   kind='social' → directiveForPersonSocial (person initiated)
 *   kind='other'  → directiveForProactiveSlot (Maelle piggybacks if conditions)
 */
export function chooseSocialDirective(params: {
  personSlackId: string;
  classification: OwnerIntentClassification;
  reconciled: ReconcileResult;
}): SocialDirective {
  const { classification, personSlackId } = params;

  if (classification.kind === 'task') {
    return noDirective();
  }
  if (classification.kind === 'social') {
    return directiveForPersonSocial(params);
  }
  // 'other' — Maelle may proactively piggyback
  return directiveForProactiveSlot({ personSlackId });
}

export function formatDirectiveForPromptBlock(directive: SocialDirective): string {
  if (directive.mode === 'none') return '';
  const lines: string[] = [];
  lines.push('## SOCIAL DIRECTIVE (this turn)');
  lines.push(`Mode: ${directive.mode}`);
  if (directive.categoryLabel) lines.push(`Category: ${directive.categoryLabel}`);
  if (directive.topicLabel) lines.push(`Topic: ${directive.topicLabel}`);
  lines.push(`Tone: ${directive.toneCue}`);
  lines.push('');
  lines.push('Mode rules:');
  lines.push('- celebrate: acknowledge the win first. No "what do you need" pivot. A real congrats, specific to what was shared.');
  lines.push('- engage: follow the thread naturally. One short reaction or follow-up is fine. Don\'t interrogate, don\'t deflect to tasks.');
  lines.push('- revive_ack: note you remember this topic from before. Pick up where it left off.');
  lines.push('- continue: one short follow-up on a topic from a prior day. Don\'t overdo it.');
  lines.push('- raise_new: one plain human question from a fresh category. No preamble ("speaking of...", "by the way..."). Just ask.');
  lines.push('');
  lines.push('ABOVE ALL: speak like a person, not a service desk. Celebration, empathy, or genuine curiosity IS the response. Don\'t tack "let me know if you need anything" onto social turns.');
  logger.info('Social directive produced', {
    mode: directive.mode, topic: directive.topicLabel, category: directive.categoryLabel,
  });
  return lines.join('\n');
}
