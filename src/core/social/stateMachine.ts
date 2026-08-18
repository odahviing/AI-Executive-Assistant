/**
 * Social state machine.
 *
 * Pure TypeScript. No LLM, no DB writes. Takes the classifier output +
 * per-person picker state (active categories/subjects, rate limits) and
 * decides ONE directive for the current turn. The directive is what the
 * orchestrator injects into the system prompt for Sonnet to phrase, or hands
 * to the coda composer.
 *
 * Subject reconciliation happens END-OF-CHAT in capturePass.runSubjectReconciliation
 * (v3.0.1) — not per-turn. The state machine sees categories/subjects via the
 * DB picker (getActiveCategoriesForPerson / getActiveSubjectsForPersonCategory)
 * and never receives a `reconciled` param.
 *
 * v4.5.9 (#198) — no more time-based anything here. A subject with a raise
 * still pending an answer (`last_assistant_initiated_at` not null) is simply
 * skipped; the person's next chat clears that marker one way or the other
 * (core/social/logEngagement.ts — match resets it, pivot records an
 * unanswered raise), so there is no window to track. Also dropped per answer
 * 0: the legacy `topicId`/`topicLabel`/`topic` field mirror + `withLegacyShape`
 * wrapper (nothing consumes them any more), the unused `firstMention` flag
 * (set false everywhere, read nowhere), and the `revive_ack` mode (declared,
 * never produced).
 *
 * v4.5.9 (#198-LIB-1) — the picker used to be three independent Math.random()
 * rolls (whether to grow at all, which of a hardcoded 14-name subset to grow
 * into, which active category to continue). All three are gone: selection is
 * now deterministic and driven only by what's stored (category score, subject
 * recency, per-person id) — never a coin flip. `CONVERSATIONAL_CATEGORIES`
 * and `raiseNewProbabilityForCount` are deleted outright, not left unused —
 * the pool is the full 30 `FIXED_CATEGORIES`, no exclusion subset (answers
 * 4, 15).
 *
 * Picker (proactive slot, EC6):
 *   - Below the 3-active-category cap (`MAX_ACTIVE_CATEGORIES_PER_PERSON`,
 *     socialSubjects.ts): always grow — `raise_new` into a dormant category,
 *     picked deterministically (`pickDormantCategory`, a stable per-person
 *     rotation over the 30, so different people aren't all offered "family"
 *     first). The picker only ever SUGGESTS the category; the 3-cap itself is
 *     enforced at the reconciler's create site (capturePass.ts), not here.
 *   - At the cap: continue the highest-scoring active category that has an
 *     eligible subject (no raise currently pending an answer), least-
 *     recently-touched subject inside it wins. No eligible subject anywhere →
 *     fall back to `raise_new` (suggesting a dormant category) rather than
 *     going silent — the cap is a target for the coda to grow toward, not a
 *     hard ceiling on what it may suggest.
 *   - Only the CODA (its own direct call, `allowRaiseNew` default true) may
 *     produce `raise_new`. The in-prompt directive (`chooseSocialDirective`,
 *     feeds buildTurnContext.ts) calls with `allowRaiseNew: false` — it is a
 *     rendered suggestion Sonnet may silently ignore, so it must never be
 *     what opens a brand-new subject (answer 2). It continues an eligible
 *     existing subject if one exists, else says nothing.
 */

import type { OwnerIntentClassification } from './classifyTurn';
import {
  countAssistantInitiationsTodayForPerson,
  getActiveCategoriesForPerson,
  getActiveSubjectsForPerson,
  getActiveSubjectsForPersonCategory,
  getCategoryScoresForPerson,
  lastAssistantInitiatedAt,
  recordSubjectUnanswered,
  FIXED_CATEGORIES,
  MAX_ACTIVE_CATEGORIES_PER_PERSON,
  type SocialSubject,
} from '../../db/socialSubjects';
import logger from '../../utils/logger';

export type SocialMode =
  | 'celebrate'
  | 'engage'
  | 'continue'
  | 'raise_new'
  | 'none';

export interface SocialDirective {
  mode: SocialMode;
  subjectId: string | null;
  subjectLabel: string | null;
  categoryLabel: string | null;
  toneCue: string;
  subject: SocialSubject | null;
  /**
   * v4.6.2 (#187) — true only for the closing-turn acknowledgment path below.
   * `formatDirectiveForPromptBlock` branches its engage bullet on this flag:
   * acknowledge-and-stop instead of progress-and-stay-open, since this
   * directive exists precisely to react to what was just said, not to keep
   * the subject open.
   */
  closingAck: boolean;
}

// ── Person-initiated social turn ─────────────────────────────────────────────

export function directiveForPersonSocial(params: {
  classification: OwnerIntentClassification;
}): SocialDirective {
  const { classification } = params;
  const social = classification.social;
  if (!social) return noDirective();

  // v4.6.2 (#187) — closing no longer means "say nothing." `social` here is
  // already-computed classifier output (sentiment/direction/category_hint)
  // for what THIS message contains — closing suppresses ORIGINATION only
  // (the proactive-slot path stays gated at chooseSocialDirective:397 /
  // directiveForProactiveSlot, untouched by this change: no dormant subject
  // continues, nothing new opens). This function only ever reacts to content
  // already in the message, so a closing turn gets the same celebrate/engage
  // shape as an open one — brief acknowledgment only, via a tighter toneCue,
  // never a reason to go quiet on "that's rough about your mom."
  const isClosing = classification.conversation_state === 'closing';

  // v3.0 follow-up — per-turn directive no longer knows the matched subject
  // (subject decisions moved to end-of-chat). Directive uses category + tone
  // shape only. End-of-chat reconciliation handles subject state separately.
  const categoryLabel = social.category_hint ?? null;

  if (social.direction === 'share' && social.sentiment === 'positive') {
    return {
      mode: 'celebrate',
      subjectId: null,
      subjectLabel: categoryLabel,
      categoryLabel,
      toneCue: isClosing
        ? 'one brief, genuine line of congrats before they go — no follow-up question, let the goodbye stand'
        : 'match the energy; a real congrats, not a pivot to tasks',
      subject: null,
      closingAck: isClosing,
    };
  }

  let toneCue: string;
  if (isClosing) {
    if (social.direction === 'ask_assistant') {
      toneCue = 'answer briefly and warmly, then let the goodbye stand — no question back, this is the closing turn';
    } else if (social.sentiment === 'negative') {
      toneCue = 'one warm, brief line acknowledging what they just said — no advice, no follow-up question, let the goodbye stand';
    } else {
      toneCue = 'one brief acknowledgment of what they just said, then let the goodbye stand — no follow-up question';
    }
  } else if (social.sentiment === 'negative') {
    toneCue = 'commiserate, light empathy; no solutions unless asked';
  } else if (social.direction === 'ask_assistant') {
    toneCue = 'answer warmly, like a colleague who\'s been around';
  } else {
    toneCue = 'follow the thread naturally; one short follow-up is fine';
  }

  return {
    mode: 'engage',
    subjectId: null,
    subjectLabel: categoryLabel,
    categoryLabel,
    toneCue,
    subject: null,
    closingAck: isClosing,
  };
}

// ── Proactive slot picker (EC6: 3-active-categories target) ──────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deterministic, reproducible-from-stored-state pick of a dormant (inactive
 * for this person) category to suggest for `raise_new`. No exclusion subset
 * (answer 4) — the full 30 `FIXED_CATEGORIES` are eligible. The rotation
 * offset is a stable hash of the person's own id, purely so two different
 * people aren't both always offered the same first category ("family" every
 * time) — it carries no other meaning and is not a form of randomness.
 *
 * `triedLabels` (bounce fix) — categories already suggested at least once
 * that never went anywhere (score still 0, no subject ever landed). Without
 * this a category that got no engagement was indistinguishable from one
 * never mentioned, so this same deterministic rotation picked the identical
 * dormant category every day forever — re-asking the same thing on a loop.
 * First pass skips BOTH active and tried categories (fully fresh ground);
 * only once all 30 have some standing does it fall back to a previously-
 * tried one (still never an active one).
 */
function pickDormantCategory(
  personSlackId: string,
  activeLabels: Set<string>,
  triedLabels: Set<string>,
): string {
  let hash = 0;
  for (let i = 0; i < personSlackId.length; i++) {
    hash = (hash * 31 + personSlackId.charCodeAt(i)) >>> 0;
  }
  const offset = hash % FIXED_CATEGORIES.length;
  for (let i = 0; i < FIXED_CATEGORIES.length; i++) {
    const candidate = FIXED_CATEGORIES[(offset + i) % FIXED_CATEGORIES.length];
    if (!activeLabels.has(candidate) && !triedLabels.has(candidate)) return candidate;
  }
  // Every category has either standing or a prior unanswered try — fall
  // back to the least-bad option (still never an active one), same rotation.
  for (let i = 0; i < FIXED_CATEGORIES.length; i++) {
    const candidate = FIXED_CATEGORIES[(offset + i) % FIXED_CATEGORIES.length];
    if (!activeLabels.has(candidate)) return candidate;
  }
  // All 30 already active — MAX_ACTIVE_CATEGORIES_PER_PERSON (3) makes this
  // unreachable in practice; kept only as a total fallback.
  return FIXED_CATEGORIES[offset];
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
  /**
   * Only the coda may originate a brand-new subject (answer 2) — the
   * in-prompt directive selector (`chooseSocialDirective`) passes `false`.
   * Defaults to true for the coda's own direct call (orchestrator/index.ts).
   */
  allowRaiseNew?: boolean;
}): SocialDirective {
  const { personSlackId, ownerTimezone, allowRaiseNew = true } = params;

  // Rank-0 = "do not engage" opt-out. Maelle never INITIATES with rank-0
  // people. Inbound replies / response handling go through other paths
  // (orchestrator's normal flow), so a rank-0 person who reaches out
  // first still gets a normal reply and the engagement signal can lift
  // their rank back up. This gate only blocks proactive initiation.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getEngagementRank } = require('../../db/engagementRank') as
    typeof import('../../db/engagementRank');
  if (getEngagementRank(personSlackId) === 0) {
    return noDirective();
  }

  // One-per-day-per-person gate (owner-local "today")
  if (countAssistantInitiationsTodayForPerson(personSlackId, ownerTimezone) >= 1) {
    return noDirective();
  }
  const lastInit = lastAssistantInitiatedAt(personSlackId);
  if (lastInit) {
    const sinceMs = Date.now() - new Date(lastInit).getTime();
    if (sinceMs < ONE_DAY_MS) return noDirective();
  }
  // Per-person gate. The two checks above read social_subjects, which a
  // `raise_new` coda never stamps (it has no subject row) — so a raise_new coda
  // left the daily gate un-armed and fired on EVERY turn (owner got 3 codas in
  // 8 min, 2026-07-13). people_memory.last_initiated_at is stamped for BOTH modes
  // — it is literally the per-person 24h gate field — so read it here to make
  // once-per-day hold regardless of mode. Written by `recordCodaDelivered`
  // (core/social/logEngagement.ts) when the transport confirms the coda actually
  // posted, NOT when it was composed; for a raise_new coda it is the only gate.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getPersonMemory } = require('../../db') as typeof import('../../db');
  const personLastInit = getPersonMemory(personSlackId)?.last_initiated_at;
  if (personLastInit) {
    const sinceMs = Date.now() - new Date(personLastInit).getTime();
    if (sinceMs < ONE_DAY_MS) return noDirective();
  }

  // gh#198 (answer 20/21) — RESOLVE-ON-READ, before search and topic
  // selection. Reaching this point means the 24h gate just opened (every
  // check above passed) and a new coda is about to be considered — this is
  // the ONLY moment a previous raise's silence is judged, lazily, never on a
  // background timer. A subject still carrying `last_assistant_initiated_at`
  // here has had 24h+ pass with nobody clearing it — a real reply would
  // already have cleared it via recordSubjectAnswered/recordSubjectUnanswered
  // at end-of-chat reconciliation (logEngagement.ts) the moment it arrived,
  // so a marker still standing IS the no-feedback signal. Recording it now
  // (dies at MAX_UNANSWERED_RAISES) is what makes the two-unanswered-raises
  // death rule actually fire for a person who never chats again, not only for
  // one whose next chat happens to reconcile. Idempotent by construction:
  // recordSubjectUnanswered clears the marker as part of applying it, so a
  // repeat call before the next coda actually lands sees nothing left to
  // resolve.
  //
  // gh#198 (answer 21) — NO time-based grace window here (a `CAPTURE_
  // RECONCILE_GRACE_MS` padding was tried and refused twice: it can't fix an
  // outcome already decided ~23.5h earlier by reconciliation, and it silently
  // duplicated capturePass's SILENCE_MINUTES + the background tick interval —
  // stale the moment either one moved). The actual race — end-of-chat
  // reconciliation consuming the raise marker inside the very chat the coda
  // was delivered in, before the person had any real chance to answer — is
  // fixed at the source with a DATA check, not a clock: capturePass.ts's
  // `runSubjectReconciliation` now suppresses that pivot signal (via
  // logEngagement.ts's `allowPivotDetection`) unless the thread has already
  // been captured once SINCE the raise happened. With that guard in place, a
  // marker still standing a full 24h later genuinely means reconciliation
  // never saw an answer — the plain elapsed-time check below is correct on
  // its own.
  //
  // Applied per-subject (not against the shared daily-gate anchor above) so
  // it holds regardless of which subject's raise happened to reopen the gate.
  // No matching step for a `raise_new` (category, no subject) offer: it can
  // only ever have targeted a category already at CATEGORY_SCORE_FLOOR (0) —
  // `pickDormantCategory` only offers categories with no active standing —
  // so a further −1 is a clamped no-op; `recordCategoryRaiseAttempt` (already
  // called at compose time) is what keeps the picker from re-offering it.
  for (const s of getActiveSubjectsForPerson(personSlackId)) {
    if (!s.last_assistant_initiated_at) continue;
    const raisedAgoMs = Date.now() - new Date(s.last_assistant_initiated_at).getTime();
    if (raisedAgoMs < ONE_DAY_MS) continue;
    try {
      recordSubjectUnanswered(s.id);
    } catch (err) {
      logger.warn('Resolve-on-read: recordSubjectUnanswered threw — leaving marker as-is', {
        subjectId: s.id, err: String(err).slice(0, 200),
      });
    }
  }

  // Deterministic selection — no time-based decay pass runs here (answer 14):
  // a subject whose raise is still pending an answer is filtered out below by
  // its marker alone (now genuinely resolved by the pass above, not merely
  // deferred); the person's next real chat clears a marker on the spot too
  // (logEngagement.ts).
  const activeCategories = getActiveCategoriesForPerson(personSlackId); // score DESC
  const activeCount = activeCategories.length;
  const activeLabels = new Set(activeCategories.map(c => c.category_label));
  // Bounce fix — categories already suggested (score still 0, no engagement
  // yet) so the rotation below skips them too, not just the active ones.
  const triedLabels = new Set(
    getCategoryScoresForPerson(personSlackId)
      .filter(c => c.score === 0)
      .map(c => c.category_label),
  );

  const raiseNewDirective = (): SocialDirective => ({
    mode: 'raise_new',
    subjectId: null,
    subjectLabel: null,
    categoryLabel: pickDormantCategory(personSlackId, activeLabels, triedLabels),
    toneCue: 'one plain, natural question about this category — invite a real fact about the person; no preamble',
    subject: null,
    closingAck: false,
  });

  // Highest-scoring active category with an eligible subject wins (ties
  // broken alphabetically for a stable, reproducible order); least-recently-
  // touched subject inside it is the pick. Returns null when no active
  // category currently has anything eligible to continue.
  const continueDirective = (): SocialDirective | null => {
    const ordered = activeCategories.slice().sort((a, b) =>
      b.score - a.score || a.category_label.localeCompare(b.category_label));
    for (const cat of ordered) {
      const allSubjects = getActiveSubjectsForPersonCategory(personSlackId, cat.category_id);
      // Eligible = no raise currently awaiting an answer. Once the person's
      // next chat reconciles (match or pivot), the marker clears either way
      // (logEngagement.ts) — so this is a plain filter, not a decay site.
      const subjects = allSubjects.filter(s => !s.last_assistant_initiated_at);
      if (subjects.length === 0) continue;
      // Least-recently-touched first — rotates variety among eligible
      // subjects (subjects no longer carry a score to sort on).
      const choice = subjects.slice().sort((a, b) => {
        const aTs = a.last_touched_at ? new Date(a.last_touched_at).getTime() : 0;
        const bTs = b.last_touched_at ? new Date(b.last_touched_at).getTime() : 0;
        return aTs - bTs;
      })[0];
      return {
        mode: 'continue',
        subjectId: choice.id,
        subjectLabel: choice.label,
        categoryLabel: cat.category_label,
        toneCue: 'one short, natural follow-up on this subject; lean on the recent topic-beats Maelle has logged',
        subject: choice,
        closingAck: false,
      };
    }
    return null;
  };

  if (!allowRaiseNew) {
    // In-prompt directive: never originate a brand-new subject (answer 2).
    // Continue something eligible if there is one; otherwise say nothing.
    return continueDirective() ?? noDirective();
  }

  // Coda path: below the cap, always grow into a dormant category
  // deterministically (the cap itself is enforced at the reconciler's create
  // site — capturePass.ts — not here). At the cap, continue; if nothing is
  // currently eligible to continue, fall back to suggesting a dormant
  // category rather than going silent.
  if (activeCount < MAX_ACTIVE_CATEGORIES_PER_PERSON) {
    return raiseNewDirective();
  }
  return continueDirective() ?? raiseNewDirective();
}

export function noDirective(): SocialDirective {
  return {
    mode: 'none',
    subjectId: null,
    subjectLabel: null,
    categoryLabel: null,
    toneCue: '',
    subject: null,
    closingAck: false,
  };
}

export function chooseSocialDirective(params: {
  personSlackId: string;
  classification: OwnerIntentClassification;
  /** Owner timezone — threaded through to the proactive-slot daily gate. */
  ownerTimezone?: string;
  /**
   * gh#179-c / coda-repeats-and-merges-with-action-confirmations — true when
   * THIS turn will also render an approval-outcome relay (systemPrompt.ts's
   * PENDING APPROVALS / WORK ALREADY IN FLIGHT / STATUS OF THE REQUEST IN
   * THIS THREAD sections), computed independently of `classification` from
   * the requests spine. That relay is real work Sonnet must deliver — Maelle
   * was free-composing it into the SAME reply as a social directive (confirmed
   * live: Yael, 2026-08-03 — gh#179 comment #3, "Coda was sent at the same
   * message, prob a bug as we said coda is separate"), which is also what
   * broke the #179-b language-match rule (systemPrompt.ts:347-354). Checked
   * FIRST, ahead of `kind`, so it suppresses celebrate/engage too — not just
   * the proactive slot — because the relay always outranks a social aside (L10).
   */
  hasOperationalRelay?: boolean;
}): SocialDirective {
  const { classification, personSlackId, ownerTimezone, hasOperationalRelay } = params;

  if (hasOperationalRelay) return noDirective();
  if (classification.kind === 'task') return noDirective();
  if (classification.kind === 'social') return directiveForPersonSocial({ classification });
  if (classification.conversation_state === 'closing') return noDirective();
  // In-prompt directive — never originates a brand-new subject (answer 2):
  // only the coda's own direct call to directiveForProactiveSlot may.
  return directiveForProactiveSlot({ personSlackId, ownerTimezone, allowRaiseNew: false });
}

export function formatDirectiveForPromptBlock(directive: SocialDirective): string {
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
  if (directive.closingAck) {
    // v4.6.2 (#187) — closing turn: acknowledge-and-stop replaces
    // progress-and-stay-open. See closingAck's doc comment above.
    lines.push('- engage: this is a closing turn. Acknowledge briefly what they just said, then let the goodbye stand — no follow-up question, nothing new introduced, no invitation to keep talking.');
  } else {
    lines.push('- engage: follow the thread naturally. Your reply must PROGRESS the subject — react with something specific, share back, or ask a follow-up that gives the person somewhere to go. A reply that only says "wow cool" is not progress. If YOU just asked a social question and they answered with any substance, stay on that subject — never pivot to "anything work-related" or "let me know if you need anything." The subject stays open until THEY close it.');
  }
  lines.push('- continue: one short follow-up on a subject from a prior day. Don\'t overdo it. Same rule as engage — progress the subject, never pivot to work.');
  // v4.5.9 (#198-LIB-1) — no `raise_new` rule line: this block only ever
  // renders what chooseSocialDirective produces, and the in-prompt directive
  // can never select raise_new any more (answer 2) — only the coda can, and
  // the coda composes its own prompt (generateCoda.ts), never this one.
  lines.push('');
  lines.push('ABOVE ALL: speak like a person, not a service desk. Celebration, empathy, or genuine curiosity IS the response. Don\'t tack "let me know if you need anything" onto social turns.');
  logger.info('Social directive produced', {
    mode: directive.mode, subject: directive.subjectLabel, category: directive.categoryLabel,
  });
  return lines.join('\n');
}
