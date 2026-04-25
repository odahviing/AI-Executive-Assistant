/**
 * Orphan-meeting cleanup (v2.2.3, scenario 7 row 1).
 *
 * Sibling to `closeMeetingArtifacts` — that fires on Maelle's own delete /
 * move / update calls. This one fires when a meeting Maelle has DB artifacts
 * for (pending approvals, open follow_up tasks, in-flight reschedule
 * outreach) has DISAPPEARED from the calendar without Maelle's involvement
 * — typically because the organizer cancelled it externally.
 *
 * Without this sweep the brief still surfaces "needs your input" for events
 * that no longer exist; the cleanup cascade only triggered on Maelle-driven
 * mutations. Now we also detect external cancellations and run the same
 * cascade.
 *
 * Called from the brief builder before it collects items. Cheap: one Graph
 * lookup per distinct meeting_id referenced by open artifacts.
 *
 * Never throws — DB cleanup is best-effort. Calendar fetch failures degrade
 * to "leave artifacts as-is" (no false-positive deletes).
 */

import { getDb } from '../db';
import { closeMeetingArtifacts } from './closeMeetingArtifacts';
import { verifyEventDeleted } from '../connectors/graph/calendar';
import logger from './logger';

interface ArtifactRef {
  meetingId: string;
  source: 'approval' | 'task' | 'outreach';
}

/** Pull every meeting_id referenced by an open artifact for this owner. */
function collectReferencedMeetingIds(ownerUserId: string): ArtifactRef[] {
  const db = getDb();
  const refs: ArtifactRef[] = [];
  const seen = new Set<string>();

  // Pending approvals — payload may carry meeting_id under a few keys
  const approvalRows = db.prepare(`
    SELECT payload_json FROM approvals
    WHERE owner_user_id = ? AND status = 'pending'
  `).all(ownerUserId) as Array<{ payload_json: string }>;
  for (const row of approvalRows) {
    const ids = extractMeetingIds(row.payload_json);
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        refs.push({ meetingId: id, source: 'approval' });
      }
    }
  }

  // Open follow_up / reminder tasks
  const taskRows = db.prepare(`
    SELECT context FROM tasks
    WHERE owner_user_id = ?
      AND type IN ('follow_up', 'reminder')
      AND status IN ('new','scheduled','in_progress','pending_owner','pending_colleague')
  `).all(ownerUserId) as Array<{ context: string | null }>;
  for (const row of taskRows) {
    if (!row.context) continue;
    const ids = extractMeetingIds(row.context);
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        refs.push({ meetingId: id, source: 'task' });
      }
    }
  }

  // Reschedule outreach in-flight
  const outreachRows = db.prepare(`
    SELECT context_json FROM outreach_jobs
    WHERE owner_user_id = ?
      AND intent = 'meeting_reschedule'
      AND status IN ('sent', 'no_response', 'replied')
  `).all(ownerUserId) as Array<{ context_json: string | null }>;
  for (const row of outreachRows) {
    if (!row.context_json) continue;
    const ids = extractMeetingIds(row.context_json);
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        refs.push({ meetingId: id, source: 'outreach' });
      }
    }
  }

  return refs;
}

const MEETING_ID_KEYS = ['meeting_id', 'existing_event_id', 'event_id', 'external_event_id'];

/** Pull any meeting-id-shaped values from a JSON string under known keys. */
function extractMeetingIds(json: string): string[] {
  if (!json) return [];
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const out: string[] = [];
    for (const key of MEETING_ID_KEYS) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Sweep open artifacts for this owner. For each unique meeting_id referenced,
 * verify the event still exists in the calendar. If gone, run the standard
 * `closeMeetingArtifacts` cascade. Returns the count cleaned up.
 */
export async function cleanupVanishedMeetingArtifacts(params: {
  ownerUserId: string;
  ownerEmail: string;
}): Promise<{ checked: number; cleaned: number }> {
  const result = { checked: 0, cleaned: 0 };
  let refs: ArtifactRef[];
  try {
    refs = collectReferencedMeetingIds(params.ownerUserId);
  } catch (err) {
    logger.warn('cleanupVanishedMeetingArtifacts: collect threw', {
      ownerUserId: params.ownerUserId,
      err: String(err).slice(0, 200),
    });
    return result;
  }

  if (refs.length === 0) return result;
  result.checked = refs.length;

  for (const ref of refs) {
    try {
      const stillGone = await verifyEventDeleted(params.ownerEmail, ref.meetingId);
      if (!stillGone) continue; // event still exists — leave artifacts intact
      const cleaned = closeMeetingArtifacts({
        ownerUserId: params.ownerUserId,
        meetingId: ref.meetingId,
        reason: 'deleted',
      });
      const total = cleaned.approvalsResolved + cleaned.tasksCancelled + cleaned.outreachClosed;
      if (total > 0) {
        result.cleaned++;
        logger.info('cleanupVanishedMeetingArtifacts: closed orphan artifacts', {
          ownerUserId: params.ownerUserId,
          meetingId: ref.meetingId,
          source: ref.source,
          ...cleaned,
        });
      }
    } catch (err) {
      // Graph lookup failed — don't risk false-positive cleanup. Skip this id.
      logger.debug('cleanupVanishedMeetingArtifacts: verify failed, skipping', {
        meetingId: ref.meetingId,
        err: String(err).slice(0, 200),
      });
    }
  }

  return result;
}
