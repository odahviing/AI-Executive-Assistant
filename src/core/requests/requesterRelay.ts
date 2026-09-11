/**
 * Shared requester-relay primitives (R1 — the close-loop is part of the spine,
 * not a mechanism beside it; R3 — whoever is waiting hears the real outcome,
 * exactly once).
 *
 * notifyRequesterOfDecision (resolver.ts) is the FULL relay for decision
 * verdicts — LLM-composed wording, owner shadow, history/outbound-tracker
 * stamps. But three other closure paths (expiry, the freeform-flag give-up,
 * the non-resolver booking cascade in closeMeetingArtifacts) each hand-rolled
 * a thin English-only copy with no leak filter: a Hebrew-speaking requester
 * got an English relay (the exact #107d class, re-grown outside the resolver),
 * and closeMeetingArtifacts could print an internal auto-generated
 * "… needs your input" row.subject verbatim into a colleague's DM.
 *
 * `relayClosureToRequester` is the ONE deterministic composer those paths now
 * share: language (he/en, derived exactly as notifyRequesterOfDecision does),
 * leak-filtered subject (usableRelaySubject), MPIM/DM origin-thread routing,
 * and `requester_notified_at` stamped ONLY on a confirmed ok send. Callers
 * supply only the outcome-specific sentence, in both languages.
 */

import type { UserProfile } from '../../config/userProfile';
import type { RequestRow } from './types';
import { parseDetails } from './types';
import { getConnection } from '../../connections/registry';
import { getRequest, updateRequest } from '../../db/requests';
import logger from '../../utils/logger';

/**
 * v2.8.6 — filter out the auto-generated `<subkind> needs your input` phrase
 * that lands on row.subject when Sonnet didn't pass an explicit subject. That
 * phrase leaked into MPIM resolution messages as "Idan said yes on policy
 * exception needs your input" — internal jargon visible to colleagues. When
 * this returns true, the caller falls back to a generic phrase instead.
 */
function looksLikeApprovalMeta(subject: string): boolean {
  const lower = subject.trim().toLowerCase();
  return lower.endsWith('needs your input')
    || lower === 'unknown person'
    || lower === 'policy exception'
    || lower === 'duration override'
    || lower === 'lunch bump'
    || lower === 'calendar conflict';
}

// v3.3.x (Dina webinar, 2026-06-14) — a candidate subject that is phrased as a
// QUESTION is the internal approval ASK ("Can Idan find 10 minutes with Dina
// tomorrow for Zoom webinar setup?"), framed to the OWNER. Pasting it into the
// requester-facing "{owner} said yes on {X}" relay leaked that internal framing
// to Dina ("said yes on Can Idan find 10 minutes…?"). A real meeting subject is
// a noun phrase, never a question — reject question-form candidates so the relay
// falls back to a clean generic.
function looksLikeApprovalQuestion(subject: string): boolean {
  const t = subject.trim();
  if (t.endsWith('?')) return true;
  return /^(can|could|would|will|should|does|is|are|may|shall)\b/i.test(t);
}

export function usableRelaySubject(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const s = candidate.trim();
  if (!s) return undefined;
  if (looksLikeApprovalMeta(s) || looksLikeApprovalQuestion(s)) return undefined;
  return s;
}

/**
 * v2.9.4 (#107d) → v3.5.x — the relay language is DERIVED from the requester's
 * most recent inbound (default English), never a frozen one-off
 * language_preference (the Ayala bug). Renders he/en only; any non-Hebrew code
 * (en/ru/ar/…) → English. Fail-open to English on any read error.
 */
export function requesterRelayLanguage(requesterSlackId: string): 'he' | 'en' {
  try {
    // Lazy require mirrors resolver.ts — keeps db/people off this module's
    // static import graph.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPersonMemory, resolveOutboundLanguageForPerson } = require('../../db/people') as typeof import('../../db/people');
    return resolveOutboundLanguageForPerson(getPersonMemory(requesterSlackId)) === 'he' ? 'he' : 'en';
  } catch {
    return 'en';
  }
}

export interface RelayComposeParams {
  lang: 'he' | 'en';
  /** Ready greeting — "Hey {first}" / "היי {first}" (name-less fallback handled). */
  hi: string;
  requesterFirst: string;
  ownerFirst: string;
  /** Leak-filtered subject (usableRelaySubject over caller candidates + row fields), or the fallback. */
  subject: string;
}

/**
 * The one deterministic closure relay to a requester. Returns true only when
 * the message confirmably landed (and requester_notified_at was stamped).
 * Never throws.
 */
export async function relayClosureToRequester(opts: {
  row: RequestRow;
  /** Needed only when the compose copy names the owner (ownerFirst is '' without it). */
  profile?: UserProfile;
  /** Log label, e.g. 'runExpiry requester loop-close'. */
  label: string;
  /** Extra subject candidates tried FIRST (each still leak-filtered). */
  subjectCandidates?: unknown[];
  /** Per-language generic fallback; default "that ask" / "הבקשה הזאת". */
  subjectFallback?: { en: string; he: string };
  compose: (p: RelayComposeParams) => string;
}): Promise<boolean> {
  const { row, label } = opts;
  const requesterSlackId = row.requester_slack_id;
  // requester-relay-never-targets-owner — requester_slack_id can end up
  // self-referential (the owner's own id) when an upstream creation path
  // misreads his authority as 'colleague' (the same clamp class documented at
  // tasks/skill.ts's flagUnresolvedFreeformForOwner; confirmed in production
  // data as colleague_booking_record rows keyed on the owner himself).
  // Enforced once here rather than at each caller: closeMeetingArtifacts.ts
  // already filtered this before calling in; runExpiry/runFreeformFlagRetry
  // (runner.ts) hadn't.
  if (!requesterSlackId || requesterSlackId === row.owner_user_id) return false;
  // Once-only idempotency — the same field notifyRequesterOfDecision stamps and
  // reads. Fresh read: the row in hand may predate a stamp another path (the
  // resolver's relay, a prior cascade) just wrote.
  try {
    const fresh = getRequest(row.id);
    if (fresh && (readOutcome(fresh).requester_relay as { delivery?: string } | undefined)?.delivery === 'unconfirmed') return false;
    if (fresh?.requester_notified_at) {
      logger.info(`${label} — requester already notified, skipping`, { requestId: row.id });
      return false;
    }
  } catch { /* fall through — worst case is one extra DM attempt, still logged below */ }
  const conn = getConnection(row.owner_user_id, 'slack');
  const lang = requesterRelayLanguage(requesterSlackId);
  const requesterFirst = row.requester_name?.split(/\s+/)[0] ?? '';
  const hi = requesterFirst
    ? (lang === 'he' ? `היי ${requesterFirst}` : `Hey ${requesterFirst}`)
    : (lang === 'he' ? 'היי' : 'Hey there');
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  const fallback = opts.subjectFallback ?? { en: 'that ask', he: 'הבקשה הזאת' };
  const subject = [
    ...(opts.subjectCandidates ?? []),
    details.subject, details.question, row.subject,
  ].map(usableRelaySubject).find(Boolean) ?? (lang === 'he' ? fallback.he : fallback.en);
  const body = opts.compose({
    lang, hi, requesterFirst, subject,
    ownerFirst: opts.profile?.user.name.split(' ')[0] ?? '',
  });
  if (!conn) {
    recordRequesterRelayFailure(row, body, false);
    logger.warn(`${label} — no Slack connection; terminal delivery retained`, { requestId: row.id });
    return false;
  }
  // Requester's origin thread (MPIM channel or 1:1 DM) — same routing as
  // notifyRequesterOfDecision, so the close-loop never lands as a stray new
  // top-level DM with no history (v3.4.6).
  try {
    const res = row.origin_is_mpim && row.origin_channel
      ? await conn.postToChannel(row.origin_channel, body, { threadTs: row.origin_thread_ts ?? undefined })
      : await conn.sendDirect(requesterSlackId, body, { threadTs: row.origin_thread_ts ?? undefined });
    if (res.ok) {
      // Stamp ONLY on a confirmed send — a soft failure stays retryable and
      // never reads downstream (tasks/skill.ts's requester_notified nudge) as
      // "they were told" when they weren't.
      completeRequesterRelay(row);
      logger.info(`${label} — sent`, { requestId: row.id, requesterSlackId, lang });
      return true;
    }
    logger.warn(`${label} — send failed, requester_notified_at left unset`, {
      requestId: row.id, requesterSlackId, reason: res.reason,
    });
    recordRequesterRelayFailure(row, body, isRequesterSendUnconfirmed(res));
  } catch (err) {
    logger.warn(`${label} — send threw, requester_notified_at left unset`, {
      requestId: row.id, err: String(err).slice(0, 200),
    });
    recordRequesterRelayFailure(row, body, true);
  }
  return false;
}

/** Slack's generic error includes post timeouts; its receipt is unknown. */
export function isRequesterSendUnconfirmed(result: { ok: boolean; reason?: string }): boolean {
  return result.ok !== true && result.reason === 'error';
}

/** Exact terminal copy lives on its request; no second lifecycle or recomposition. */
export function recordRequesterRelayFailure(row: RequestRow, body: string, unconfirmed: boolean): void {
  const current = getRequest(row.id) ?? row;
  if (!['resolved', 'cancelled', 'expired'].includes(current.state) || current.requester_notified_at) return;
  const outcome = readOutcome(current);
  updateRequest(row.id, {
    outcomeJson: { ...outcome, requester_relay: { body, delivery: unconfirmed ? 'unconfirmed' : 'failed' } },
    nextCheckAt: unconfirmed ? null : new Date(Date.now() + 5 * 60000).toISOString(),
    nextCheckHandler: unconfirmed ? null : 'requester_relay_retry',
  });
}

function readOutcome(row: RequestRow): Record<string, unknown> {
  try { return JSON.parse(row.outcome_json ?? '{}') as Record<string, unknown>; } catch { return {}; }
}

export function completeRequesterRelay(row: RequestRow): void {
  const current = getRequest(row.id) ?? row;
  const outcome = readOutcome(current);
  const hadRetry = !!outcome.requester_relay;
  delete outcome.requester_relay;
  updateRequest(row.id, {
    requesterNotifiedAt: new Date().toISOString(),
    ...(hadRetry ? { outcomeJson: outcome, nextCheckAt: null, nextCheckHandler: null } : {}),
  });
}

/** Called under the same request lock as decisions and closure writers. */
export async function retryRequesterRelay(row: RequestRow, profile: UserProfile): Promise<boolean> {
  const stored = readOutcome(row).requester_relay as { body?: unknown; delivery?: unknown } | undefined;
  if (row.requester_notified_at || stored?.delivery !== 'failed' || typeof stored.body !== 'string') {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return false;
  }
  const body = stored.body;
  const sent = await relayClosureToRequester({ row, profile, label: 'terminal requester delivery retry', compose: () => body });
  if (!sent) return false;
  // Match the ordinary resolver relay's history grounding after recovery.
  try {
    const { appendToConversation } = await import('../../db/conversations');
    if (row.origin_thread_ts) appendToConversation(row.origin_thread_ts, row.origin_channel ?? '', { role: 'assistant', content: body });
    if (!row.origin_is_mpim && row.requester_slack_id) {
      const { createOutreachJob } = await import('../../db/jobs');
      createOutreachJob({ owner_user_id: row.owner_user_id, owner_channel: row.origin_channel ?? '',
        owner_thread_ts: row.origin_thread_ts ?? undefined, colleague_slack_id: row.requester_slack_id,
        colleague_name: row.requester_name ?? row.requester_slack_id, message: body, await_reply: 0,
        sent_at: new Date().toISOString(), skipRequestBridge: true });
    }
  } catch (err) {
    logger.warn('terminal requester retry history failed after confirmed delivery', { requestId: row.id, err: String(err).slice(0, 200) });
  }
  return true;
}
