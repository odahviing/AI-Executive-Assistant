/**
 * v2.0.7 — retire the legacy `pending_requests` + `approval_queue` tables.
 *
 * Both tables were superseded by the `approvals` table in v1.5 but we kept
 * writing to them until 2.0.7. Now nothing writes and the tool layer has
 * been cleaned up (store_request / escalate_to_user / get_pending_requests
 * / resolve_request retired). This migration:
 *
 *   1. Backs up any rows in either legacy table to a JSON file under
 *      data/migrations/ so no history is silently lost.
 *   2. DROPs both tables.
 *
 * Idempotent — if the tables don't exist (fresh deploy or already migrated)
 * it's a no-op. Runs once per process on the first getDb() call.
 */

import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger';

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
  ).get(name) as { name: string } | undefined;
  return !!row;
}

export function runV207ConsolidateRequests(db: Database.Database, dbPath: string): void {
  const hasPendingRequests = tableExists(db, 'pending_requests');
  const hasApprovalQueue = tableExists(db, 'approval_queue');
  if (!hasPendingRequests && !hasApprovalQueue) return;  // already migrated

  const backup: Record<string, unknown[]> = {};
  try {
    if (hasPendingRequests) {
      backup.pending_requests = db.prepare(`SELECT * FROM pending_requests`).all();
    }
    if (hasApprovalQueue) {
      backup.approval_queue = db.prepare(`SELECT * FROM approval_queue`).all();
    }
  } catch (err) {
    logger.warn('v2.0.7 migration — read failed, aborting drop to be safe', {
      err: String(err),
    });
    return;
  }

  try {
    const migDir = path.join(path.dirname(dbPath), 'migrations');
    if (!fs.existsSync(migDir)) fs.mkdirSync(migDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(migDir, `v2_0_7_legacy_requests_${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
    logger.info('v2.0.7 migration — backed up legacy tables', {
      backupPath,
      pendingRequestsRows: Array.isArray(backup.pending_requests) ? backup.pending_requests.length : 0,
      approvalQueueRows: Array.isArray(backup.approval_queue) ? backup.approval_queue.length : 0,
    });
  } catch (err) {
    logger.warn('v2.0.7 migration — backup write failed, aborting drop', { err: String(err) });
    return;
  }

  try {
    if (hasPendingRequests) db.exec(`DROP TABLE pending_requests`);
    if (hasApprovalQueue) db.exec(`DROP TABLE approval_queue`);
    logger.info('v2.0.7 migration — legacy tables dropped');
  } catch (err) {
    logger.error('v2.0.7 migration — DROP failed', { err: String(err) });
  }
}
