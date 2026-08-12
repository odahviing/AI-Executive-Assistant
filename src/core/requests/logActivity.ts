/**
 * logActivity (gh#52 piece 52-U2) — the ONE writer for `logged`-state activity
 * rows: the record of something Maelle actually DID that needed no decision
 * from the owner (a colleague DM, a resolved approval, a research run). Thin
 * wrapper over createRequest — reuse the one spine (R2), never a second table.
 *
 * Scope (owner's ruling) — OUTWARD-EFFECT tools only: calendar mutations,
 * colleague messages/DMs, approvals, research. NOT internal writes (a note, a
 * preference, any other memory-only tool). Call this from the specific
 * write-site that just completed the action — never from a generic dispatch
 * chokepoint, so a memory-only write never accidentally earns a row.
 *
 * Only call this after the action SUCCEEDED. A failed/refused action earns
 * nothing — there is nothing to recover or undo.
 *
 * Idempotency: every call gets its own timestamped key
 * (`logged:<kind>:<subkind>:<ts>:<rand>`), NEVER createRequest's default
 * derived key (owner/requester/kind/subject) — two identical successful
 * actions (the same DM sent twice, back-to-back) must both get their own row,
 * not collide on the UNIQUE constraint and throw.
 *
 * Fail-soft: a history write must never break or block the action it
 * records. Errors are caught and logged here so no caller needs its own
 * try/catch around this call.
 */

import crypto from 'crypto';
import { createRequest } from '../../db/requests';
import type { RequestKind, RequestRole } from './types';
import logger from '../../utils/logger';

export interface LogActivityInput {
  ownerUserId: string;
  kind: RequestKind;
  subkind?: string;
  subject: string;
  /** The reverse-handle payload, when the action has one (e.g. original/new time for a move). */
  outcomeJson?: Record<string, unknown>;
  initiatedBy: string;
  initiatedByRole: RequestRole;
  /**
   * gh#52 (52-U3) — the Slack thread/channel this action originated in, so a
   * privacy-scoped surface (52-U11's colleague-side read) can tell WHICH
   * conversation a logged row belongs to instead of guessing. Additive: both
   * omitted is exactly the old two-call-site behavior (originChannel/
   * originThreadTs land as NULL on the row, same as before this field pair
   * existed). Pass `undefined` rather than fabricating a thread when a site
   * genuinely has none (e.g. a synthetic/overnight-tick context).
   */
  originThreadTs?: string;
  originChannel?: string;
  /**
   * OT-4 (bouncer fix, gh#52) — who this activity CONCERNS, so
   * tasks/skill.ts's `with_person` filter on the recent_activity bucket has
   * something to match on. targetSlackId is the colleague a calendar
   * mutation or DM was ABOUT/TO; requesterSlackId is the colleague who
   * originated the thing being logged (e.g. a colleague-raised approval's
   * requester). Leave both omitted when a row genuinely has no single
   * relevant person (e.g. the owner moving his own solo meeting) — that's
   * honest, not a gap to force-fill.
   */
  targetSlackId?: string;
  requesterSlackId?: string;
  /**
   * gh#52 follow-up (revert-intent-and-single-step-undo-scope, piece 3) — the
   * display name paired with targetSlackId, threaded straight to
   * createRequest's own targetName field so a captured activity row carries a
   * human-readable identity, not just an id. Optional: a call site with no
   * resolved name (or no target at all) omits it, same as targetSlackId.
   */
  targetName?: string;
}

export function logActivity(input: LogActivityInput): void {
  try {
    const rand = crypto.randomBytes(4).toString('hex');
    createRequest({
      ownerUserId: input.ownerUserId,
      initiatedBy: input.initiatedBy,
      initiatedByRole: input.initiatedByRole,
      kind: input.kind,
      subkind: input.subkind,
      subject: input.subject,
      state: 'logged',
      // Never surfaced regardless — getRequestsForBrief excludes state='logged'
      // outright (52-U1). Stamped 1 anyway so a row is never mistaken for
      // "post-closure narration pending" by any other reader of `informed`.
      informed: 1,
      idempotencyKey: `logged:${input.kind}:${input.subkind ?? 'x'}:${Date.now()}:${rand}`,
      outcomeJson: input.outcomeJson,
      originThreadTs: input.originThreadTs,
      originChannel: input.originChannel,
      targetSlackId: input.targetSlackId,
      targetName: input.targetName,
      requesterSlackId: input.requesterSlackId,
    });
  } catch (err) {
    logger.warn('logActivity — failed to write activity row (non-fatal)', {
      kind: input.kind, subkind: input.subkind, err: String(err).slice(0, 200),
    });
  }
}
