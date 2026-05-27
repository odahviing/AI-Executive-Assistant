/**
 * Requests-spine reconciliation + retention (v3.1, Path 2 Stage 8).
 *
 * closeRequest cascades request → legacy table (closing a coord/outreach row
 * when its request closes). This module handles the REVERSE direction and the
 * cases no cascade covers — the ghost class the owner hit on 2026-05-27:
 *
 *   "We resolved the bug, we deleted the orphan tasks from the DB — it's
 *    still here."
 *
 * Root cause: a coord closed via a path that bypassed updateCoordJob (a manual
 * DB delete of the coord_job / tasks), so the linked request never closed.
 * The brief reads only requests, so the ghost kept surfacing.
 *
 * reconcileOrphanedRequests closes any open coord request whose backing
 * coord_job is (a) terminal already, or (b) gone entirely. Bypass-proof: it
 * doesn't matter HOW the coord_job reached terminal/absent — the request
 * follows. Age-gated so a freshly-created coord (request made, coord_job link
 * a few ms later) is never mistaken for an orphan.
 *
 * pruneOldTerminalRequests keeps the spine lean (owner: "don't store
 * everything forever — truncate if needed"): terminal rows past the retention
 * window are deleted, children with them.
 *
 * Both run from the background tick. Read-mostly, fail-soft, idempotent.
 */

import { getDb } from '../../db/client';
import { closeRequest } from './closeRequest';
import type { RequestRow } from './types';
import logger from '../../utils/logger';

/** A coord request younger than this is never treated as an orphan (link race). */
const ORPHAN_MIN_AGE_MINUTES = 15;

/** Terminal requests older than this are pruned. */
const RETENTION_DAYS = 30;

/**
 * Close open coord requests whose backing coord_job is terminal or missing.
 * Returns the number of requests closed.
 */
export function reconcileOrphanedRequests(ownerUserId: string): number {
  const db = getDb();
  let closed = 0;

  try {
    // Open coord requests for this owner, old enough that the create→link
    // race window has passed.
    const openCoord = db.prepare(`
      SELECT * FROM requests
      WHERE owner_user_id = ?
        AND kind = 'coord'
        AND parent_request_id IS NULL
        AND state IN ('awaiting_owner','awaiting_colleague','in_flight')
        AND datetime(created_at) <= datetime('now', ?)
    `).all(ownerUserId, `-${ORPHAN_MIN_AGE_MINUTES} minutes`) as RequestRow[];

    for (const req of openCoord) {
      const coordRow = db.prepare(
        `SELECT id, status FROM coord_jobs WHERE request_id = ?`
      ).get(req.id) as { id: string; status: string } | undefined;

      // (a) coord_job gone entirely → manual delete / never linked. Orphan.
      if (!coordRow) {
        closeRequest({
          id: req.id,
          state: 'cancelled',
          closureReason: 'reconcile_coord_job_missing',
          closedBy: 'system',
        });
        closed++;
        logger.info('reconcileOrphanedRequests — closed coord request (coord_job missing)', {
          requestId: req.id, subject: req.subject,
        });
        continue;
      }

      // (b) coord_job already terminal but request still open → a close path
      // bypassed the cascade. Mirror the terminal state onto the request.
      if (['booked', 'cancelled', 'abandoned'].includes(coordRow.status)) {
        closeRequest({
          id: req.id,
          state: coordRow.status === 'booked' ? 'resolved' : 'cancelled',
          closureReason: `reconcile_coord_${coordRow.status}`,
          closedBy: 'system',
        });
        closed++;
        logger.info('reconcileOrphanedRequests — closed coord request (coord_job terminal)', {
          requestId: req.id, coordJobId: coordRow.id, coordStatus: coordRow.status,
        });
      }
    }
  } catch (err) {
    logger.warn('reconcileOrphanedRequests threw — non-fatal', {
      ownerUserId, err: String(err).slice(0, 200),
    });
  }

  return closed;
}

/**
 * Delete terminal requests (and their children) older than the retention
 * window. Global (not per-owner) since it's pure housekeeping. Returns rows
 * deleted. Idempotent and safe — only touches already-closed rows.
 */
export function pruneOldTerminalRequests(retentionDays: number = RETENTION_DAYS): number {
  const db = getDb();
  try {
    // Children first (FK-free schema, but keeps the tree consistent if a
    // parent prunes and a child's closed_at is newer). Delete children whose
    // parent is being pruned, then the parents, then any stale standalone
    // terminal rows.
    const cutoff = `-${retentionDays} days`;

    const delChildren = db.prepare(`
      DELETE FROM requests
      WHERE parent_request_id IN (
        SELECT id FROM requests
        WHERE state IN ('resolved','cancelled','expired')
          AND closed_at IS NOT NULL
          AND datetime(closed_at) < datetime('now', ?)
      )
    `).run(cutoff);

    const delParents = db.prepare(`
      DELETE FROM requests
      WHERE state IN ('resolved','cancelled','expired')
        AND closed_at IS NOT NULL
        AND datetime(closed_at) < datetime('now', ?)
    `).run(cutoff);

    const total = (delChildren.changes ?? 0) + (delParents.changes ?? 0);
    if (total > 0) {
      logger.info('pruneOldTerminalRequests — pruned terminal requests', {
        retentionDays, children: delChildren.changes, parents: delParents.changes,
      });
    }
    return total;
  } catch (err) {
    logger.warn('pruneOldTerminalRequests threw — non-fatal', { err: String(err).slice(0, 200) });
    return 0;
  }
}
