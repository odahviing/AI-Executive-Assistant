/**
 * findMeetingOwner (v2.7.0) — single lookup for "who's the meeting's
 * requester / organizer?"
 *
 * Per Q3 the chain is:
 *   1. requests table — find a request whose outcome_external_event_id
 *      matches this Graph event. ALL states (open + resolved + cancelled +
 *      expired) — a booked coord is state=resolved by now, still relevant.
 *   2. Graph organizer.emailAddress.address — fallback when no linked
 *      request (legacy / external bookings like Calendly).
 *
 * Used by `delete_meeting` / `move_meeting` to decide:
 *   - asker == requester/organizer → just do it
 *   - asker != requester/organizer → decline owner-side + DM organizer
 *     (per D3/Q1=B), or refuse for move (per D4).
 */

import { getDb } from '../../db/client';
import { getEventOrganizer } from '../../connectors/graph/calendar';
import { searchPeopleMemory } from '../../db/people';
import type { RequestRow } from '../../core/requests/types';
import logger from '../../utils/logger';

export interface MeetingOwnerInfo {
  /** True when Graph says owner.email === organizer.emailAddress.address. */
  ownerIsOrganizer: boolean;
  /** Slack id of the person who originated this meeting (if known). */
  requesterSlackId: string | null;
  requesterName: string | null;
  /** Always populated when ownerIsOrganizer is false (or null if Graph lookup fails). */
  organizerEmail: string | null;
  organizerName: string | null;
  /** Where the answer came from. */
  source: 'requests' | 'graph_organizer' | 'graph_only' | 'unknown';
}

/**
 * Across-all-states variant of getRequestsByExternalEventId. The default
 * helper only returns open rows; for organizer/requester lookup we need
 * closed (resolved) coords too since booking sets state=resolved.
 */
function findRequestByEventId(ownerUserId: string, eventId: string): RequestRow | null {
  return (getDb().prepare(`
    SELECT * FROM requests
    WHERE owner_user_id = ?
      AND outcome_external_event_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(ownerUserId, eventId) as RequestRow | null) ?? null;
}

export async function findMeetingOwner(opts: {
  ownerUserId: string;
  ownerEmail: string;
  eventId: string;
}): Promise<MeetingOwnerInfo> {
  // Step 1 — requests table lookup
  let req: RequestRow | null = null;
  try {
    req = findRequestByEventId(opts.ownerUserId, opts.eventId);
  } catch (err) {
    logger.warn('findMeetingOwner — requests query threw', { err: String(err).slice(0, 200) });
  }

  // Step 2 — Graph organizer
  let organizerEmail: string | null = null;
  let organizerName: string | null = null;
  try {
    const og = await getEventOrganizer(opts.ownerEmail, opts.eventId);
    if (og) {
      organizerEmail = og.address.toLowerCase();
      organizerName = og.name ?? null;
    }
  } catch (err) {
    logger.warn('findMeetingOwner — getEventOrganizer threw', { err: String(err).slice(0, 200) });
  }

  const ownerIsOrganizer = organizerEmail !== null
    && organizerEmail === opts.ownerEmail.toLowerCase();

  if (req && (req.requester_slack_id || req.requester_name)) {
    return {
      ownerIsOrganizer,
      requesterSlackId: req.requester_slack_id,
      requesterName: req.requester_name,
      organizerEmail,
      organizerName,
      source: 'requests',
    };
  }

  // No request row — the COMMON case (most of owner's calendar is invites
  // owner didn't book through Maelle: weeklies he books himself, customer/
  // partner invites, Calendly, Outlook invites from colleagues). Graph
  // organizer is the truth; back-fill the organizer's slack_id from
  // people_memory so callers can do a clean slack_id == slack_id comparison
  // (asker vs organizer) without falling back to email matching.
  if (organizerEmail) {
    let resolvedSlackId: string | null = null;
    let resolvedName: string | null = organizerName;
    try {
      const hits = searchPeopleMemory(organizerEmail);
      const hit = hits.find(p => (p.email ?? '').toLowerCase() === organizerEmail.toLowerCase());
      if (hit?.slack_id) {
        resolvedSlackId = hit.slack_id;
        if (!resolvedName && hit.name) resolvedName = hit.name;
      }
    } catch (err) {
      logger.warn('findMeetingOwner — people_memory lookup threw, returning null slack_id', {
        err: String(err).slice(0, 200),
      });
    }
    return {
      ownerIsOrganizer,
      requesterSlackId: resolvedSlackId,
      requesterName: resolvedName,
      organizerEmail,
      organizerName,
      source: ownerIsOrganizer ? 'graph_only' : 'graph_organizer',
    };
  }

  return {
    ownerIsOrganizer: false,
    requesterSlackId: null,
    requesterName: null,
    organizerEmail: null,
    organizerName: null,
    source: 'unknown',
  };
}
