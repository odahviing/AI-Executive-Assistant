/**
 * Module D — Thread-bound approval auto-resolve (v2.7.7, daily-thread aware v3.4.6).
 *
 * When the owner replies in a thread tied to a pending approval, a Haiku
 * pre-pass classifies the reply as approve / reject / pass_to_sonnet and, when
 * unambiguous, resolves it WITHOUT a full owner-DM Sonnet turn.
 *
 * Two ways a reply binds to an approval:
 *   1. Per-message: the reply's parent thread is an approval's own
 *      `terminal_dm_msg_ts` (a 1:1 DM that is its own thread). Precise.
 *   2. Daily decision thread (v3.4.6): the reply's parent thread is the owner's
 *      daily-thread root (`owner_dm_thread_ts`), shared by ALL of that day's
 *      approvals. Here the reply doesn't name an approval by position, so a
 *      CONTENT-ATTRIBUTION pass picks which open approval it addresses — "I'm ok
 *      with the Isaac meeting" resolves the Isaac one even with others open; a
 *      bare "yes, go ahead" with 2+ open is genuinely ambiguous → pass to Sonnet
 *      so she asks "which one?". (Owner direction 2026-06-21: resolve when clear,
 *      ask only when unclear.) Emoji ✅/❌ stays per-message and is unaffected.
 *
 * Why LLM, not regex: natural-language acks + attribution have too many shapes
 * for a regex to cover safely, and Maelle is multilingual.
 *
 * Amend is intentionally NOT auto-handled — amend counters are approval-kind-
 * specific; those return pass_to_sonnet.
 *
 * Fails open: any miss/uncertainty/error → pass_to_sonnet. No turn ever breaks.
 *
 * Gate: profile.behavior.deterministic_approval_resolve. Caller checks the flag.
 */

import { getAnthropicClient } from '../llm/client';
import { MODEL_HAIKU } from '../llm/models';
import type { UserProfile } from '../config/userProfile';
import { getAwaitingOwnerRequests } from '../db/requests';
import { resolveRequest, type ResolveContext } from '../core/requests/resolver';
import { parseDetails, type RequestRow } from '../core/requests/types';
import { extractCallbacks } from '../core/approvals/approvalCallbacks';
import logger from './logger';
import type { App } from '@slack/bolt';

const anthropic = getAnthropicClient();

export type AutoResolveVerdict = 'approve' | 'reject' | 'pass_to_sonnet';

export interface AutoResolveResult {
  /** True when the request was resolved deterministically; caller should skip the orchestrator. */
  resolved: boolean;
  verdict?: 'approve' | 'reject';
  request_id?: string;
  /** Why we didn't shortcut (logging aid). */
  reason?: string;
}

const PASS: AutoResolveResult = { resolved: false, reason: 'pass_to_sonnet' };

interface BoundCandidate {
  id: string;
  kind: string;
  subkind: string | null;
  subject: string | null;
  requesterSlackId: string | null;
  details: Record<string, unknown>;
}

function toCandidate(r: RequestRow): BoundCandidate {
  return {
    id: r.id,
    kind: r.kind,
    subkind: r.subkind,
    subject: r.subject,
    requesterSlackId: r.requester_slack_id,
    details: parseDetails<Record<string, unknown>>(r) ?? {},
  };
}

/**
 * Replay-path precondition. Auto-resolve is safe ONLY when there's a concrete
 * next-step the resolver can execute without Sonnet: an on_approve callback
 * (replay). Otherwise a freeform approval with no callback would hit the
 * "close + notify with nothing executed" path,
 * so we pass to Sonnet to interpret + execute.
 */
function isReplayEligible(c: BoundCandidate): boolean {
  const callbacks = extractCallbacks(c.details);
  return !!callbacks.on_approve;
}

/**
 * v3.4.8 — silent-resolve is safe ONLY for owner-internal approvals (no
 * colleague to loop back to). A COLLEAGUE-requested approval (requester_slack_id
 * set, ≠ owner) must run the normal orchestrator turn instead: Module D skips
 * Sonnet entirely, so resolving silently leaves NO record of what happened in
 * the conversation and no narration — Maelle then can't tell the owner she
 * notified the requester (she did, via the resolver) and misreports / duplicates
 * (Ysrael Gurt, 2026-06-23: owner approved a colleague's move, resolver relayed
 * to the colleague, but the silent path left no memory → Maelle said "not
 * notified" → owner-prompted duplicate DM). Deferring these to the orchestrator
 * makes them a normal chat turn: Sonnet resolves, sees the requester_notified
 * result, and narrates in her own words.
 */
function isSilentResolveSafe(c: BoundCandidate, ownerUserId: string): boolean {
  return !c.requesterSlackId || c.requesterSlackId === ownerUserId;
}

/**
 * Find the approvals a reply in `threadTs` could SILENTLY resolve (Module D).
 * Per-message match takes priority (precise); else the daily-thread match
 * returns every open approval sharing that day's thread. Only replay-eligible
 * AND silent-safe (owner-internal) candidates qualify — colleague-requested
 * approvals are deliberately left for the orchestrator so Maelle narrates.
 */
function findCandidates(ownerUserId: string, threadTs: string): BoundCandidate[] {
  const requests = getAwaitingOwnerRequests(ownerUserId);
  const eligible = (c: BoundCandidate): boolean => {
    if (!isReplayEligible(c)) return false;
    if (!isSilentResolveSafe(c, ownerUserId)) {
      logger.info('autoResolveThreadBound — deferring colleague-requested approval to orchestrator (narration needed)', {
        requestId: c.id, requesterSlackId: c.requesterSlackId,
      });
      return false;
    }
    return true;
  };
  const byMessage = requests.filter(r => r.terminal_dm_msg_ts === threadTs);
  if (byMessage.length >= 1) return byMessage.map(toCandidate).filter(eligible);
  const byDaily = requests.filter(r => !!r.owner_dm_thread_ts && r.owner_dm_thread_ts === threadTs);
  return byDaily.map(toCandidate).filter(eligible);
}

function candidateContextLine(c: BoundCandidate, profile: UserProfile): string {
  const kindLabel = c.subkind ?? c.kind;
  const subj = c.subject ? ` "${c.subject}"` : '';
  const requesterName = typeof c.details.requester_name === 'string' ? c.details.requester_name as string : null;
  const who = requesterName ? ` (from ${requesterName})` : '';
  const slotsArr = Array.isArray(c.details.slots) ? (c.details.slots as Array<{ label?: string; iso?: string }>) : [];
  const slots = slotsArr.length > 0 ? ` — options: ${slotsArr.slice(0, 4).map(s => s.label || s.iso || String(s)).join(' | ')}` : '';
  const q = typeof c.details.question === 'string' ? ` — asked: ${(c.details.question as string).slice(0, 120)}` : '';
  void profile;
  return `${kindLabel}${subj}${who}${slots}${q}`;
}

export async function tryAutoResolveThreadBoundApproval(params: {
  message: string;
  threadTs: string | undefined;
  ownerUserId: string;
  profile: UserProfile;
  app?: App;
}): Promise<AutoResolveResult> {
  const { message, threadTs, ownerUserId, profile, app } = params;

  if (!threadTs) return { resolved: false, reason: 'no_thread_ts' };
  if (!message || message.trim().length === 0) return { resolved: false, reason: 'empty_message' };

  // Cost pre-filter: very long messages are almost never pure acks.
  if (message.trim().length > 400) return { resolved: false, reason: 'message_too_long' };

  const candidates = findCandidates(ownerUserId, threadTs);
  if (candidates.length === 0) return { resolved: false, reason: 'no_thread_match' };

  const ownerFirst = profile.user.name.split(' ')[0];

  // Build the classifier. ONE call handles both single and multi: it returns
  // `target` (1-based index into the candidate list, or 0 for none/ambiguous)
  // and `verdict`. With a single candidate it's a plain yes/no read; with many
  // it must also attribute the reply to the right one (or bail to 0).
  const numbered = candidates.map((c, i) => `${i + 1}. ${candidateContextLine(c, profile)}`).join('\n');
  const multi = candidates.length > 1;
  const systemPrompt = `${ownerFirst} (the owner) is replying in his decision thread, where ${candidates.length} approval${multi ? 's are' : ' is'} awaiting his call:

${numbered}

His reply:
"""
${message.slice(0, 1000)}
"""

Output EXACTLY ONE call to classify_reply. Set:
- target: which approval the reply resolves — the NUMBER (1-${candidates.length}). Use 0 if the reply doesn't clearly pick ONE of them${multi ? ' (e.g. a bare "yes" when several are open and none is named)' : ''}, or doesn't address any.
- verdict:
  · approve — a clear yes on the targeted approval. "yes", "go", "ok", "do it", "sure", "yeah", "lock it in", "go ahead", "the 11am one", "tuesday works", "כן", "אישור", "תאשר".
  · reject — a clear no. "no", "cancel", "skip it", "don't", "drop it", "לא", "ביטול".
  · pass_to_sonnet — anything else: mixed ("yes but 3pm" — that's an amend), conditional ("yes if she's free"), a question, topic change, or ambiguous tone ("fine", "I guess").

Rules:
- Resolve only when BOTH the target AND the verdict are unambiguous. If the reply names one approval but with a mixed/conditional answer → that target, verdict=pass_to_sonnet.
- ${multi ? 'Naming an approval counts: "I\'m ok with the Isaac meeting" → the Isaac one, even with others open. A reply that names none and just says "yes" → target 0.' : 'A single approval is open; resolve it on a clear yes/no.'}
- Bias to target=0 / pass_to_sonnet on ANY uncertainty — a false resolve closes something the owner didn't mean to.`;

  let target = 0;
  let verdict: AutoResolveVerdict = 'pass_to_sonnet';
  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 80,
      system: systemPrompt,
      tools: [{
        name: 'classify_reply',
        description: 'Attribute the owner reply to a pending approval and classify the verdict.',
        input_schema: {
          type: 'object' as const,
          properties: {
            target: { type: 'integer', description: `1-${candidates.length} for the approval resolved, or 0 if none/ambiguous` },
            verdict: { type: 'string', enum: ['approve', 'reject', 'pass_to_sonnet'] },
          },
          required: ['target', 'verdict'],
        },
      }],
      tool_choice: { type: 'tool', name: 'classify_reply' },
      messages: [{ role: 'user', content: message.slice(0, 1000) }],
    });
    const toolUse = resp.content.find((b: { type: string }) => b.type === 'tool_use') as
      | { input?: { target?: number; verdict?: string } } | undefined;
    const raw = toolUse?.input;
    if (!raw || typeof raw.target !== 'number' || !raw.verdict) {
      logger.warn('autoResolveThreadBound — no/partial verdict, passing to Sonnet');
      return PASS;
    }
    if (raw.verdict !== 'approve' && raw.verdict !== 'reject' && raw.verdict !== 'pass_to_sonnet') return PASS;
    target = raw.target;
    verdict = raw.verdict;
  } catch (err) {
    logger.warn('autoResolveThreadBound — classifier threw, passing to Sonnet', { err: String(err).slice(0, 200) });
    return PASS;
  }

  if (verdict === 'pass_to_sonnet' || target < 1 || target > candidates.length) {
    logger.info('autoResolveThreadBound — no confident resolve, passing to Sonnet', {
      threadTs, candidateCount: candidates.length, target, verdict,
    });
    return { resolved: false, reason: 'classifier_pass_or_ambiguous' };
  }

  const bound = candidates[target - 1];
  logger.info('autoResolveThreadBound — attributed + classified', {
    requestId: bound.id, kind: bound.subkind ?? bound.kind, verdict,
    candidateCount: candidates.length, preview: message.slice(0, 80),
  });

  // ── Deterministic resolve ─────────────────────────────────────────────────
  // v3.1.3 — owner short-form auto-resolve is always owner-driven (never the
  // colleague responding to a counter): resolvedByColleague:false so an owner
  // reject on an awaiting_colleague row closes it (doesn't bounce).
  const ctx: ResolveContext = { app, profile, resolvedByColleague: false };
  try {
    const decision = verdict === 'approve'
      ? { verdict: 'approve' as const, data: {} }
      : { verdict: 'reject' as const, reason: 'owner short-form reject' };
    const result = await resolveRequest(bound.id, decision, ctx);
    if (!result.ok) {
      logger.warn('autoResolveThreadBound — resolveRequest not-ok, passing to Sonnet to recover', {
        requestId: bound.id, verdict, reason: result.reason,
      });
      return { resolved: false, reason: `resolver_not_ok:${result.reason ?? 'unknown'}` };
    }
    logger.info('autoResolveThreadBound — resolved without Sonnet turn', {
      requestId: bound.id, verdict, effect: result.effect,
    });
    return { resolved: true, verdict, request_id: bound.id };
  } catch (err) {
    logger.warn('autoResolveThreadBound — resolveRequest threw, passing to Sonnet', {
      err: String(err).slice(0, 200), requestId: bound.id, verdict,
    });
    return { resolved: false, reason: 'resolver_threw' };
  }
}
