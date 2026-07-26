/**
 * closeRequest (v2.7.0) — THE ONLY way a request terminates.
 *
 * Principal callers:
 *   1. resolver — owner explicit verdict (approve/reject/amend/cancel)
 *   2. closeLoopOnOwnerHandled scanner — LLM matched owner free-text
 *   3. the spine runner (runner.ts) — expiry / reminder / outreach
 *      timers firing on next_check_at
 *   4. meeting mutation cascade — calendar event vanished / confirmed
 *   5. outreach reply handler — colleague replied to awaiting_colleague outreach
 *   (also: brief itself, when surfaced_count >= 3 → cancelled)
 *
 * No other code path may write `state` directly to a terminal value. Schema
 * doesn't enforce this (SQLite); convention does. Audit happens here.
 *
 * Cascade semantics:
 *   - Closing a parent cascades to its children unless skipChildren=true.
 *     Reason: a cancelled parent shouldn't leave child outreach rows still
 *     awaiting_colleague.
 *   - Closing a child does NOT cascade up — sibling children may still be
 *     in flight. Parent rolls up state via its own logic.
 *   - Next-check timers on the same row are cleared (next_check_at = NULL,
 *     handler = NULL) so the runner doesn't re-fire on a closed row.
 *
 * informed=0 on closure: the brief will surface the closure narration ("I
 * told Yael Sunday's good") once, then flip informed=1. After that, the row
 * is invisible — that's the orphan kill.
 */

import { DateTime } from 'luxon';
import { getDb } from '../../db/client';
import { getRequest, getChildRequests, updateRequest } from '../../db/requests';
import type { CloseRequestInput, RequestRow } from './types';
import logger from '../../utils/logger';

export interface CloseResult {
  ok: boolean;
  request_id: string;
  state: RequestRow['state'];
  children_closed: number;
  reason?: string;
}

export function closeRequest(input: CloseRequestInput): CloseResult {
  const row = getRequest(input.id);
  if (!row) {
    return { ok: false, request_id: input.id, state: 'cancelled', children_closed: 0, reason: 'request not found' };
  }
  if (row.state === 'resolved' || row.state === 'cancelled' || row.state === 'expired') {
    logger.info('closeRequest called on already-terminal request — no-op', {
      id: input.id, currentState: row.state, requestedState: input.state,
    });
    return { ok: true, request_id: input.id, state: row.state, children_closed: 0, reason: 'already terminal' };
  }

  const now = DateTime.now().toUTC().toISO()!;

  updateRequest(input.id, {
    state: input.state,
    closureReason: input.closureReason,
    closedBy: input.closedBy,
    closedAt: now,
    informed: 0,           // brief will narrate the closure once, then flip
    nextCheckAt: null,     // kill any pending timer on this row
    nextCheckHandler: null,
    outcomeExternalEventId: input.outcomeExternalEventId,
    outcomeJson: input.outcomeJson,
  });

  let childrenClosed = 0;
  if (!input.skipChildren) {
    const children = getChildRequests(input.id);
    for (const child of children) {
      if (child.state === 'resolved' || child.state === 'cancelled' || child.state === 'expired') continue;
      // Cascade with a derived reason so audit can distinguish parent-driven
      // closure from independent child closure.
      const sub = closeRequest({
        id: child.id,
        state: input.state,
        closureReason: `parent_${input.state}: ${input.closureReason}`,
        closedBy: input.closedBy,
        skipChildren: true,  // depth-1 only; nested coords would loop otherwise
      });
      if (sub.ok) childrenClosed++;
    }
  }

  logger.info('closeRequest', {
    id: input.id,
    state: input.state,
    closureReason: input.closureReason,
    closedBy: input.closedBy,
    childrenClosed,
    outcomeExternalEventId: input.outcomeExternalEventId,
  });

  // Audit log entry — every terminal transition is recorded.
  try {
    getDb().prepare(`
      INSERT INTO audit_log (action, source, actor, target, details, outcome)
      VALUES ('request_closed', 'requests.closeRequest', @actor, @target, @details, 'success')
    `).run({
      actor: input.closedBy,
      target: input.id,
      details: JSON.stringify({
        state: input.state,
        closure_reason: input.closureReason,
        kind: row.kind,
        subkind: row.subkind,
        children_closed: childrenClosed,
      }),
    });
  } catch (err) {
    // Audit failure must not block closure
    logger.warn('closeRequest — audit log insert threw', { err: String(err).slice(0, 200) });
  }

  return { ok: true, request_id: input.id, state: input.state, children_closed: childrenClosed };
}
