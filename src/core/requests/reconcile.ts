/**
 * Requests-spine retention (v3.1, Path 2 Stage 8).
 *
 * pruneOldTerminalRequests keeps the spine lean (owner: "don't store
 * everything forever — truncate if needed"): terminal rows past the retention
 * window are deleted, children with them.
 *
 * Runs from the background tick. Read-mostly, fail-soft, idempotent.
 */

import { getDb } from '../../db/client';
import logger from '../../utils/logger';

/** Terminal requests older than this are pruned. */
const RETENTION_DAYS = 30;

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
