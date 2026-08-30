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
 *
 * SILENT BY CONSTRUCTION (2026-08-30): this sweep never messages a colleague.
 * Its evidence is a 404, which cannot tell a rotated/stale id from a real
 * cancellation, so it passes `inferredFromAbsence: true` to suppress the
 * cascade's requester close-loop. Only callers that performed and verified the
 * mutation relay an outcome to a human.
 */

import { getDb } from '../db';
import { getOpenRescheduleOutreach } from '../db/jobs';
import { getOpenRequestsForOwner } from '../db/requests';
import { closeMeetingArtifacts } from './closeMeetingArtifacts';
import { verifyEventDeleted } from '../connectors/graph/calendar';
import logger from './logger';

interface ArtifactRef {
  meetingId: string;
  source: 'request' | 'task' | 'outreach';
}

/** Pull every meeting_id referenced by an open artifact for this owner. */
function collectReferencedMeetingIds(ownerUserId: string): ArtifactRef[] {
  const db = getDb();
  const refs: ArtifactRef[] = [];
  const seen = new Set<string>();

  // Open spine requests — details may carry meeting_id under a few keys.
  // v3.4.6 (spine collapse) — approvals are requests now; the legacy approvals
  // table is dropped, so scan the requests spine instead.
  const reqRows = getOpenRequestsForOwner(ownerUserId);
  for (const r of reqRows) {
    const ids = extractMeetingIds(r.details_json ?? '');
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        refs.push({ meetingId: id, source: 'request' });
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

  // Reschedule outreach still awaiting an outcome. #41 — openness is the linked
  // REQUEST's state, asked once in db/jobs.ts. Rows this drops (settled, or
  // pre-bridge with no request at all) are ones the cascade below could never act
  // on, so following them only spent a Graph existence check per brief.
  for (const row of getOpenRescheduleOutreach(ownerUserId)) {
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

/**
 * Pull any meeting-id-shaped values from a JSON string under known keys —
 * top-level, or (vanished-meeting-sweep-blind-to-deferred-action-ref,
 * 2026-08-30) nested under `deferred_action.args`, the same shape
 * closeMeetingArtifacts.ts's `payloadReferencesMeeting` already reads. An
 * approval's own meeting reference lives there (the tool + args the resolver
 * replays on approve), never duplicated at the payload's top level — this
 * matcher was written before that storage shape existed and never looked
 * there, so a pending hold whose only meeting reference was nested was
 * invisible to this sweep: a meeting the organizer cancelled directly in
 * Outlook (no Maelle mutation to fire closeMeetingArtifacts itself) never
 * closed or relayed to the colleague waiting on it.
 */
function extractMeetingIds(json: string): string[] {
  if (!json) return [];
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const out: string[] = [];
    for (const key of MEETING_ID_KEYS) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) out.push(v);
    }
    const deferredArgs = (obj.deferred_action as { args?: Record<string, unknown> } | undefined)?.args;
    if (deferredArgs) {
      for (const key of MEETING_ID_KEYS) {
        const v = deferredArgs[key];
        if (typeof v === 'string' && v.length > 0) out.push(v);
      }
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
      const cleaned = await closeMeetingArtifacts({
        ownerUserId: params.ownerUserId,
        meetingId: ref.meetingId,
        reason: 'deleted',
        // requester-close-loop-never-notifies-cancelled-hold (2026-08-30) — this
        // sweep INFERS the delete from `verifyEventDeleted`, which is true on any
        // 404 (calendarReads.ts:1313-1329): a rotated or stale id reads exactly
        // like a real cancellation. The cascade's colleague close-loop is
        // therefore suppressed for this caller — artifacts still close (that is
        // this sweep's job), but no human is told an outcome we cannot vouch for.
        inferredFromAbsence: true,
      });
      const total = cleaned.tasksCancelled + cleaned.outreachClosed + cleaned.calendarIssuesResolved;
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
