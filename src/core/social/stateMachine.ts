/**
 * Social state machine (v2.2).
 *
 * Pure TypeScript. No LLM, no DB writes. Takes the classifier output + the
 * reconciled topic + rate-limit state and decides ONE directive for the
 * current turn. The directive is what the orchestrator injects into the
 * system prompt for Sonnet to phrase. Mode selection is deterministic;
 * tone is judgment, so we pass a short cue for Sonnet to run with.
 *
 * Modes:
 *   celebrate     — owner shared a positive win (sentiment=positive share)
 *   engage        — owner shared or asked Maelle something; neutral+sentiment
 *                   or a question directed at her
 *   revive_ack    — owner brought back a dormant topic (reconciler flagged it)
 *   continue      — Maelle picks up an active topic proactively (no owner
 *                   social this turn, but silence-break conditions met)
 *   raise_new     — Maelle opens a new topic proactively
 *   none          — no social this turn (task, or daily slot consumed, or no
 *                   active topics to continue and can't raise)
 *
 * Priority order when owner initiated social:
 *   dormant topic revived → revive_ack
 *   positive sentiment → celebrate
 *   everything else social → engage
 *
 * When owner DIDN'T initiate social but Maelle may act this turn (rare, only
 * on explicit "proactive social" tick — not in this pass of the orchestrator;
 * scaffolding here for later):
 *   has daily slot + active topics + none touched today → continue
 *   has daily slot + no active topics raised recently → raise_new
 *   else → none
 */

import type { OwnerIntentClassification } from './classifyOwnerIntent';
import type { ReconcileResult } from './reconcileTopic';
import type { SocialTopic } from '../../db/socialTopics';
import {
  countMaelleInitiationsToday,
  getAllTopicsForOwner,
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
  toneCue: string;        // short phrase Sonnet uses for vibe
  // Full topic context for prompting
  topic: SocialTopic | null;
  // v2.2 — whether the topic was created this turn. Used by the post-turn
  // logger to avoid double-counting the owner-initiated score bump (the
  // initial score on create already reflects the owner surfacing it).
  firstMention: boolean;
}

/**
 * Handle an owner-initiated turn: classifier said kind='social'.
 * The reconciler has already matched/created a topic (or not).
 */
export function directiveForOwnerSocial(params: {
  ownerUserId: string;
  classification: OwnerIntentClassification;
  reconciled: ReconcileResult;
}): SocialDirective {
  const { classification, reconciled } = params;
  const social = classification.social;
  if (!social) return noDirective();

  const topic = reconciled.topic;
  const firstMention = reconciled.action === 'created_under_category';

  // Revive takes priority — owner brought back something dormant
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

  // Celebrate: positive share
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

  // Engage: everything else owner-initiated social
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

/**
 * Called on owner turns where classifier said kind='other' OR when a
 * standalone social tick fires (future). Decides whether Maelle should
 * proactively raise a new topic or continue an existing one.
 *
 * Returns 'none' if:
 *   - daily slot already consumed
 *   - no candidate active topics and no bandwidth to raise new
 */
export function directiveForProactiveSlot(params: {
  ownerUserId: string;
}): SocialDirective {
  const { ownerUserId } = params;

  // Rate limit: ONE Maelle initiation per 24h, no override even on silence.
  const initiationsToday = countMaelleInitiationsToday(ownerUserId);
  if (initiationsToday >= 1) {
    return noDirective();
  }

  const activeTopics = getAllTopicsForOwner(ownerUserId);
  // Filter: topics Maelle hasn't touched recently (same-day skip — don't
  // re-continue a topic she already touched today).
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const freshActive = activeTopics.filter(t => {
    const lastMs = new Date(t.last_touched_at).getTime();
    return lastMs < startOfDay.getTime() || t.last_touched_by === 'owner';
  });

  // Round-robin rotation (v2.2):
  //   1. Keep only topics score >= 3 (continuation-worthy)
  //   2. Of those, prefer topics whose MOST RECENT touch by Maelle is
  //      > 3 days ago — gives variety, prevents hammering the top topic
  //      every continuation
  //   3. Within the preferred pool, sort by (a) longest-since-Maelle-
  //      touched ascending, then (b) score descending as tie-breaker
  //   4. If the preferred pool is empty, fall back to highest-score pool
  //      (edge case: everything recently touched)
  const continuable = freshActive.filter(t => t.engagement_score >= 3);
  if (continuable.length > 0) {
    const threeDaysAgoMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const maelleTouchedRecently = (t: typeof continuable[number]) =>
      t.last_touched_by === 'maelle' && new Date(t.last_touched_at).getTime() >= threeDaysAgoMs;

    const preferred = continuable.filter(t => !maelleTouchedRecently(t));
    const pool = preferred.length > 0 ? preferred : continuable;

    // Sort: longest since Maelle last touched it (ascending), then
    // higher score as tie-breaker. Round-robin naturally emerges — the
    // topic Maelle addressed longest ago rises to the top.
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
      categoryLabel: null, // filled by caller if needed via getCategoryById
      toneCue: 'one short, natural follow-up on this topic',
      topic: choice,
      firstMention: false,
    };
  }

  // No continuable topics — raise a new one (category-level, let Sonnet phrase)
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
 * Single entry the orchestrator calls. Picks the right branch based on
 * classifier.kind and reconciliation state.
 *
 * Policy:
 *   kind='task'   → NEVER social (task always wins)
 *   kind='social' → owner-initiated path → celebrate/engage/revive_ack
 *   kind='other'  → check proactive slot (but only if message is a genuine
 *                   greeting/opener — usually just returns none)
 */
export function chooseSocialDirective(params: {
  ownerUserId: string;
  classification: OwnerIntentClassification;
  reconciled: ReconcileResult;
}): SocialDirective {
  const { classification } = params;

  if (classification.kind === 'task') {
    return noDirective();
  }

  if (classification.kind === 'social') {
    return directiveForOwnerSocial(params);
  }

  // kind='other' — conservative default. We do NOT proactively raise social
  // in response to a bare "ok" / "thanks". Proactive raises happen on a
  // dedicated social-tick path (future work, not this pass).
  return noDirective();
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
  lines.push('- celebrate: acknowledge the win first. No "what do you need" pivot. A real congrats, specific to what he shared.');
  lines.push('- engage: follow the thread naturally. One short reaction or follow-up is fine. Don\'t interrogate, don\'t deflect to tasks.');
  lines.push('- revive_ack: note you remember this topic from before. Pick up where it left off without re-asking what he already told you.');
  lines.push('- continue: one short follow-up on a topic from a prior day. Don\'t overdo it.');
  lines.push('- raise_new: one plain human question from a fresh category. No preamble ("speaking of...", "by the way..."). Just ask.');
  lines.push('');
  lines.push('ABOVE ALL: colleague-facing or owner-facing, Maelle speaks like a person, not a service desk. Celebration, empathy, or genuine curiosity IS the response. Don\'t tack "let me know if you need anything" onto social turns.');
  logger.info('Social directive produced', {
    mode: directive.mode, topic: directive.topicLabel, category: directive.categoryLabel,
  });
  return lines.join('\n');
}
