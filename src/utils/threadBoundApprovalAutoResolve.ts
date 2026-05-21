/**
 * Module D — Thread-bound approval auto-resolve (v2.7.7).
 *
 * When an owner replies in a thread that matches a pending approval's
 * `terminal_dm_msg_ts`, a Haiku pre-pass classifies the reply as
 * approve / reject / pass_to_sonnet. On approve / reject we call
 * resolveRequest directly and SKIP the full owner-DM Sonnet turn.
 *
 * Why LLM, not regex: natural-language acks have too many shapes for a
 * regex to cover safely. "yeah ok let's go", "perfect, lock it in",
 * "no but actually 3pm works" (amend, not approve) — Haiku gets it,
 * regex doesn't.
 *
 * Amend is intentionally NOT auto-handled in v1. The amend `counter`
 * payload is approval-kind-specific (slot_pick wants `slot_iso`,
 * duration_override wants `duration_min`, etc.) and Haiku can't reliably
 * build a kind-specific structured counter. Amend cases return
 * 'pass_to_sonnet' so the orchestrator handles them normally.
 *
 * Fails open: pre-filter mismatch → pass_to_sonnet; classifier error →
 * pass_to_sonnet. No turn ever breaks because of this.
 *
 * Gate: profile.behavior.deterministic_approval_resolve. Caller checks
 * the flag; this module just answers the "can we shortcut?" question.
 */

import { getAnthropicClient } from '../llm/client';
import type { UserProfile } from '../config/userProfile';
import { getAwaitingOwnerRequests } from '../db/requests';
import { resolveRequest, type ResolveContext } from '../core/requests/resolver';
import { parseDetails } from '../core/requests/types';
import logger from './logger';
import type { App } from '@slack/bolt';

// Module-level singleton — the auto-resolver fires often (every owner thread
// reply when the flag is on); reusing the client avoids per-call HTTP setup.
const anthropic = getAnthropicClient();

export type AutoResolveVerdict = 'approve' | 'reject' | 'pass_to_sonnet';

export interface AutoResolveResult {
  /** True when the request was resolved deterministically; caller should skip the orchestrator. */
  resolved: boolean;
  /** Set on resolved=true so the caller can react / log. */
  verdict?: 'approve' | 'reject';
  request_id?: string;
  /** Why we didn't shortcut (logging aid). */
  reason?: string;
}

const PASS: AutoResolveResult = { resolved: false, reason: 'pass_to_sonnet' };

/**
 * Pre-filter — cheap checks before paying for the Haiku call.
 *  1. owner thread reply (caller already ensures owner role; this checks threadTs)
 *  2. parent thread ts matches a single awaiting_owner request's terminal_dm_msg_ts
 *  3. message length is in the ack-shape range (sentences ok; essays out)
 */
function findThreadBoundRequest(params: {
  ownerUserId: string;
  threadTs: string;
}): { id: string; kind: string; subkind: string | null; subject: string | null; details: Record<string, unknown> } | null {
  const requests = getAwaitingOwnerRequests(params.ownerUserId);
  const matches = requests.filter(r => r.terminal_dm_msg_ts === params.threadTs);
  // Exactly ONE match — multi-match is genuine ambiguity that Sonnet should handle.
  if (matches.length !== 1) return null;
  const r = matches[0];
  return {
    id: r.id,
    kind: r.kind,
    subkind: r.subkind,
    subject: r.subject,
    details: parseDetails<Record<string, unknown>>(r) ?? {},
  };
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

  // Cap: very long messages are almost never pure acks. The Haiku call would
  // still be fine, but the pre-filter saves the cost on obvious essays.
  const len = message.trim().length;
  if (len > 400) return { resolved: false, reason: 'message_too_long' };

  // Pre-filter: thread matches exactly one awaiting_owner request.
  const bound = findThreadBoundRequest({ ownerUserId, threadTs });
  if (!bound) return { resolved: false, reason: 'no_unique_thread_match' };

  // Replay-path precondition. Module D auto-resolve is safe ONLY when
  // there's a concrete next-step the resolver can execute without Sonnet:
  //   • callbacks.on_approve present (or legacy deferred_action alias) →
  //     resolveRequest will replay the tool
  //   • subkind=slot_pick / calendar_conflict → resolveSlotPickApproval has
  //     its own auto-pick path
  // Otherwise (freeform approval without on_approve, etc.) the resolver
  // falls into the legacy "close + notify" path which posts "I'll take it
  // from here" to the requester but doesn't actually DO anything —
  // resulting in an apparent confirmation with no execution. Skip in that
  // case → pass to Sonnet so she interprets owner's reply + executes.
  // extractCallbacks handles both the new callbacks shape and the legacy
  // deferred_action shape uniformly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractCallbacks } = require('../core/approvals/approvalCallbacks') as
    typeof import('../core/approvals/approvalCallbacks');
  const callbacks = extractCallbacks(bound.details);
  const hasApproveCallback = !!callbacks.on_approve;
  const hasOwnReplayPath = bound.subkind === 'slot_pick' || bound.subkind === 'calendar_conflict';
  if (!hasApproveCallback && !hasOwnReplayPath) {
    logger.info('autoResolveThreadBound — no replay path, passing to Sonnet so she can execute', {
      requestId: bound.id,
      kind: bound.kind,
      subkind: bound.subkind ?? null,
    });
    return { resolved: false, reason: 'no_replay_path' };
  }

  // Build the classifier prompt. Approval-kind context helps Haiku read
  // edge cases ("yes book the 11am slot" — clearly approve even though
  // it references a specific slot from the proposed list).
  const ownerFirst = profile.user.name.split(' ')[0];
  const kindLabel = bound.subkind ?? bound.kind;
  const subjectLine = bound.subject ? `\nSubject: "${bound.subject}"` : '';
  const slotsArr = Array.isArray(bound.details.slots) ? (bound.details.slots as Array<{ label?: string; iso?: string }>) : [];
  const slotsLine = slotsArr.length > 0
    ? `\nProposed options: ${slotsArr.slice(0, 4).map(s => s.label || s.iso || String(s)).join(' | ')}`
    : '';
  const question = typeof bound.details.question === 'string' ? `\nQuestion asked: ${bound.details.question}` : '';

  const systemPrompt = `${ownerFirst} (the owner) is replying to a pending approval. Classify his reply.

Approval kind: ${kindLabel}${subjectLine}${slotsLine}${question}

His reply:
"""
${message.slice(0, 1000)}
"""

Output EXACTLY ONE call to classify_reply. No prose. Choose one verdict:

- approve — clear yes. "yes", "go", "ok", "do it", "sure", "yeah", "let's do it", "perfect", "sounds good", "lock it in", "go ahead", "כן", "אישור", "תאשר", "תעשי", "do", "yep", "yes please", "go for it". When he picks one of the proposed options ("the 11am one", "tuesday works") — also approve, since the resolver knows the proposed slots and will pick the matching one from data.

- reject — clear no. "no", "cancel", "skip it", "don't", "scrap it", "nope", "לא", "ביטול", "תעזבי", "let's not", "drop it".

- pass_to_sonnet — anything else, including:
  · Mixed: "yes but actually 3pm" / "no but tuesday works" — amend, needs Sonnet to build the counter.
  · Topic change: "actually, also book Yael" / "first tell me about X".
  · Conditional: "yes if she's free", "do it after my 2pm finishes".
  · Question: "what's the cost?", "which slot was that?", "are you sure?".
  · Ambiguous tone: "alright then", "I guess so", "fine" (could be reluctant approve OR sarcastic reject).
  · Anything substantive beyond the ack.

Bias toward pass_to_sonnet on uncertainty. Skipping Sonnet only when the reply is UNAMBIGUOUSLY a yes or no on the asked question. False positives here would resolve approvals he didn't mean to resolve.`;

  let verdict: AutoResolveVerdict;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      system: systemPrompt,
      tools: [{
        name: 'classify_reply',
        description: 'Classify the owner reply against the pending approval.',
        input_schema: {
          type: 'object' as const,
          properties: {
            verdict: { type: 'string', enum: ['approve', 'reject', 'pass_to_sonnet'] },
          },
          required: ['verdict'],
        },
      }],
      tool_choice: { type: 'tool', name: 'classify_reply' },
      messages: [{ role: 'user', content: message.slice(0, 1000) }],
    });
    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    const raw = toolUse?.input as { verdict?: string } | undefined;
    if (!raw || !raw.verdict) {
      logger.warn('autoResolveThreadBound — no verdict returned, passing to Sonnet');
      return PASS;
    }
    if (raw.verdict !== 'approve' && raw.verdict !== 'reject' && raw.verdict !== 'pass_to_sonnet') {
      logger.warn('autoResolveThreadBound — unexpected verdict, passing to Sonnet', { verdict: raw.verdict });
      return PASS;
    }
    verdict = raw.verdict;
  } catch (err) {
    logger.warn('autoResolveThreadBound — classifier threw, passing to Sonnet', {
      err: String(err).slice(0, 200),
    });
    return PASS;
  }

  logger.info('autoResolveThreadBound — classifier verdict', {
    requestId: bound.id,
    kind: kindLabel,
    verdict,
    preview: message.slice(0, 80),
  });

  if (verdict === 'pass_to_sonnet') {
    return { resolved: false, reason: 'classifier_pass' };
  }

  // ── Deterministic resolve ─────────────────────────────────────────────────
  // The resolver runs the per-kind downstream (booking, requester-notify,
  // closeRequest cascade). We just hand it the verdict.
  const ctx: ResolveContext = { app, profile };
  try {
    let result;
    if (verdict === 'approve') {
      // For slot_pick approvals, the resolver picks the slot from
      // bound.details.slots based on data.slot_iso. With auto-approve we
      // don't know WHICH slot — pass an empty data and let the resolver
      // handle: if it's slot_pick + multiple slots, the resolver should
      // either pick the first proposed slot OR refuse. Most owner-side
      // approvals that hit this path are policy_exception / freeform /
      // duration_override / single-slot — for which empty data is fine.
      // Multi-slot picks are something Sonnet should handle anyway (the
      // classifier shouldn't return approve on those; we ask "the 11am"
      // explicitly).
      result = await resolveRequest(bound.id, { verdict: 'approve', data: {} }, ctx);
    } else {
      result = await resolveRequest(bound.id, { verdict: 'reject', reason: 'owner short-form reject' }, ctx);
    }
    if (!result.ok) {
      logger.warn('autoResolveThreadBound — resolveRequest returned not-ok, passing to Sonnet so she can recover', {
        requestId: bound.id,
        verdict,
        reason: result.reason,
      });
      return { resolved: false, reason: `resolver_not_ok:${result.reason ?? 'unknown'}` };
    }
    logger.info('autoResolveThreadBound — resolved without Sonnet turn', {
      requestId: bound.id,
      verdict,
      effect: result.effect,
    });
    return { resolved: true, verdict, request_id: bound.id };
  } catch (err) {
    logger.warn('autoResolveThreadBound — resolveRequest threw, passing to Sonnet', {
      err: String(err).slice(0, 200),
      requestId: bound.id,
      verdict,
    });
    return { resolved: false, reason: 'resolver_threw' };
  }
}
