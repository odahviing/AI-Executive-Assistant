/**
 * ⚠️ DEMOTED + SLATED FOR FULL REMOVAL (v3.4.x). The coordinate_meeting TOOL is
 * unused, but this module is NOT actually dead — it's still reached via the
 * OUTREACH→SCHEDULING HANDOFF (coordinator.ts:604 → initiateCoordination), which
 * fired HARMFULLY on 2026-06-23 (the Luke incident: a colleague agreed to a
 * specific time, the handoff threw it away, re-coordinated the whole week, and
 * reported a fabricated "everyone agreed on Sunday"). Full rip-out is the next
 * task — the handoff must become a direct create_meeting of the agreed time.
 * If ever rebuilt (external/calendar-invisible transport), build FRESH as the
 * SOLE track for that requester, never parallel to a direct path. Why it was
 * demoted (v3.3.8): parallel-track desync + orphan nudging (the Isaac incident).
 *
 * Coord state machine.
 *
 * Moved from connectors/slack/coord.ts as part of the Connection-interface
 * port (issue #1 sub-phase D6). Slack-specific `app.client.*` calls go through
 * the Slack Connection resolved via registry.
 *
 * Functions:
 *   - initiateCoordination: entry point from MeetingsSkill (coordinate_meeting
 *     tool) and coordinator.ts (outreach reply triggering coord).
 *   - sendCoordDM (private): DM one participant with slot options, record
 *     dm_channel + dm_thread_ts for later confirmation threading.
 *   - resolveCoordination: tally votes → book / ping-pong / renegotiate /
 *     final-round approval.
 *   - startPingPong + tryNextPingPongSlot: converge on one of the chosen
 *     slots by asking holdouts.
 *   - startRenegotiation: open-ended "what times work?" ask.
 *   - triggerRoundTwo: merge preference windows, find new slots, re-DM.
 *
 * Reply-side (handleCoordReply, handlePreferenceReply, parseTimePreference)
 * lives in sibling reply.ts.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../../../config/userProfile';
import {
  createCoordJob,
  updateCoordJob,
  getCoordJob,
  cancelOrphanCoordJobs,
  upsertPersonMemory,
  getPersonMemory,
  getPersonByEmail,
  searchPeopleMemory,
  linkCoordToRequest,
  type PersonInteraction,
  type CoordParticipant,
  type CoordJob,
} from '../../../db';
import { createTask } from '../../../tasks';
import { createRequest } from '../../../db/requests';
import { findAvailableSlots, pickSpreadSlots } from '../../../connectors/graph/calendar';
import { shadowNotify } from '../../../utils/shadowNotify';
import { getConnection } from '../../../connections/registry';
import { type SlotWithLocation } from './utils';
import { emitWaitingOwnerApproval } from './approval';
import { bookCoordination } from './booking';
import logger from '../../../utils/logger';

// ── Initiate coordination ───────────────────────────────────────────────────

export async function initiateCoordination(
  params: {
    ownerUserId: string;
    ownerChannel: string;
    ownerThreadTs?: string;
    ownerName: string;
    ownerEmail: string;
    ownerTz: string;
    subject: string;
    topic?: string;
    durationMin: number;
    participants: CoordParticipant[];
    proposedSlots: SlotWithLocation[];
    profile: UserProfile;
    mpimMemberIds?: string[];
    needsDurationApproval?: boolean;
    isUrgent?: boolean;
    senderRole?: 'owner' | 'colleague';
    senderUserId?: string;
    // v2.1.1 — MOVE intent. When set, the coord reshuffles an existing
    // meeting instead of creating a new one. Participant DMs are phrased
    // as "can we shift..." and the terminal booking step calls
    // moveMeeting on `existing.id` rather than createMeeting.
    moveExistingEvent?: {
      id: string;
      currentStartIso: string;    // original start, for DM framing
      currentEndIso: string;
      conflictReason?: string;    // optional — e.g. "conflicts with the Fulcrum Product Sync 14:00"
    };
  }
): Promise<string> {
  const mpimMembers = new Set(params.mpimMemberIds ?? []);
  const slackConn = getConnection(params.ownerUserId, 'slack');
  if (!slackConn) {
    logger.error('initiateCoordination — no Slack connection registered', { ownerUserId: params.ownerUserId });
    return 'no_connection';
  }

  // ── Owner auto-inclusion for colleague-initiated coord (defense-in-depth) ──
  if (params.senderRole === 'colleague') {
    const ownerIncluded = params.participants.some(p => p.slack_id === params.ownerUserId);
    if (!ownerIncluded) {
      logger.info('Owner auto-added at invite-time (layer 2 catch)', {
        senderUserId: params.senderUserId,
        ownerUserId: params.ownerUserId,
        subject: params.subject,
        originalParticipants: params.participants.map(p => ({ name: p.name, slack_id: p.slack_id })),
      });
      params.participants = [
        {
          name: params.profile.user.name,
          slack_id: params.ownerUserId,
          email: params.ownerEmail,
          tz: params.ownerTz,
        } as CoordParticipant,
        ...params.participants,
      ];
    }

    // v2.3.1 (B4 / #62) — auto-add the requesting colleague when the meeting
    // is clearly 1:1 with the owner. Without this, Yael saying "let's set up
    // a meeting with Idan" doesn't include herself in participants, the
    // filter strips owner out, count goes to zero → silent no_participants.
    // NUANCE: only fire on clear 1:1 (zero other non-owner participants).
    // For interview-style "arrange Idan with X" — where X is a third party
    // and Yael isn't joining — don't auto-add Yael. Ambiguous mid-cases
    // (Sonnet unsure who's joining) get caught by the system prompt rule
    // in meetings.ts COORDINATION block telling her to ask first.
    if (params.senderUserId) {
      const requesterIncluded = params.participants.some(p => p.slack_id === params.senderUserId);
      const otherParticipantsCount = params.participants
        .filter(p => p.slack_id !== params.ownerUserId && p.slack_id !== params.senderUserId)
        .length;
      if (!requesterIncluded && otherParticipantsCount === 0) {
        logger.info('Requesting colleague auto-added (1:1 with owner case)', {
          senderUserId: params.senderUserId,
          subject: params.subject,
        });
        // Try to resolve the requester's name + email from people_memory; fall
        // back to a placeholder name + empty email if not found (coord can
        // still DM them via slack_id).
        let requesterName = 'Colleague';
        let requesterEmail: string | undefined;
        let requesterTz: string | undefined;
        try {
          const row = getPersonMemory(params.senderUserId);
          if (row) {
            requesterName  = row.name || requesterName;
            requesterEmail = row.email || undefined;
            requesterTz    = row.timezone || undefined;
          }
        } catch (_) { /* fail open — placeholder name is acceptable */ }
        params.participants = [
          ...params.participants,
          {
            name: requesterName,
            slack_id: params.senderUserId,
            email: requesterEmail,
            tz: requesterTz,
          } as CoordParticipant,
        ];
      }
    }
  }

  const filteredParticipants = params.participants.filter(p => p.slack_id !== params.ownerUserId);
  if (filteredParticipants.length === 0) {
    logger.warn('All participants filtered out (all were the owner)', { ownerUserId: params.ownerUserId });
    return 'no_participants';
  }

  // v3.2.6 — resolve email-only participants to a slack_id. Callers like the
  // calendar-health autofix build participants from calendar attendees (email,
  // no slack_id); the participant DM needs a slack_id, so without this the coord
  // is dead-on-arrival (the colleague is never messaged — the Eli orphan). For
  // an internal colleague, getPersonByEmail finds the existing row + its slack_id.
  for (const p of filteredParticipants) {
    if (!p.slack_id && p.email) {
      try {
        const row = getPersonByEmail(p.email.trim().toLowerCase());
        if (row?.slack_id) {
          p.slack_id = row.slack_id;
          logger.info('initiateCoordination — resolved participant slack_id from email', {
            email: p.email, slackId: row.slack_id,
          });
        } else {
          logger.warn('initiateCoordination — participant has no resolvable slack_id; DM will not reach them', {
            name: p.name, email: p.email,
          });
        }
      } catch (err) {
        logger.warn('initiateCoordination — slack_id resolve threw', { email: p.email, err: String(err).slice(0, 160) });
      }
    }
  }

  // Ensure people memory exists for every booked participant.
  // upsertPersonMemory uses COALESCE so we never overwrite richer data.
  for (const p of filteredParticipants) {
    if (!p.slack_id) continue;
    try {
      upsertPersonMemory({
        slackId:  p.slack_id,
        name:     p.name,
        email:    p.email,
        timezone: p.tz,
      });
    } catch (err) {
      logger.warn('Failed to upsert person memory during coord init', { err: String(err), slackId: p.slack_id });
    }
  }

  const taggedParticipants = filteredParticipants.map(p => ({
    ...p,
    response: null as 'yes' | 'no' | 'maybe' | null,
    contacted_via: (p.slack_id && mpimMembers.has(p.slack_id) ? 'group' : 'dm') as 'dm' | 'group',
    group_channel: (p.slack_id && mpimMembers.has(p.slack_id)) ? params.ownerChannel : undefined,
    group_thread_ts: (p.slack_id && mpimMembers.has(p.slack_id)) ? params.ownerThreadTs : undefined,
  }));

  const slotsMetadata = params.proposedSlots.map(s => ({
    start: s.start,
    location: s.location,
    isOnline: s.isOnline,
  }));

  const jobId = createCoordJob({
    owner_user_id: params.ownerUserId,
    owner_channel: params.ownerChannel,
    owner_thread_ts: params.ownerThreadTs,
    subject: params.subject,
    topic: params.topic,
    duration_min: params.durationMin,
    proposed_slots: JSON.stringify(params.proposedSlots.map(s => s.start)),
    participants: JSON.stringify(taggedParticipants),
    notes: JSON.stringify({
      isOnline: params.proposedSlots[0]?.isOnline ?? false,
      location: params.proposedSlots[0]?.location,
      slotsMetadata,
      ...(params.needsDurationApproval ? { needsDurationApproval: true } : {}),
      ...(params.isUrgent ? { isUrgent: true } : {}),
      ...(params.moveExistingEvent ? {
        moveContext: {
          currentStart: params.moveExistingEvent.currentStartIso,
          currentEnd: params.moveExistingEvent.currentEndIso,
          conflictReason: params.moveExistingEvent.conflictReason ?? null,
        },
      } : {}),
    }),
    last_calendar_check: new Date().toISOString(),
    intent: params.moveExistingEvent ? 'move' : 'schedule',
    existing_event_id: params.moveExistingEvent?.id,
  });

  cancelOrphanCoordJobs(params.ownerUserId, params.subject, jobId);

  const keyNames = params.participants.filter(p => !p.just_invite).map(p => p.name);
  const extraNames = params.participants.filter(p => p.just_invite).map(p => p.name);
  const taskTitle = extraNames.length > 0
    ? `Coordinating "${params.subject}" with ${keyNames.join(', ')} (+ ${extraNames.join(', ')})`
    : `Coordinating "${params.subject}" with ${keyNames.join(', ')}`;
  createTask({
    owner_user_id: params.ownerUserId,
    owner_channel: params.ownerChannel,
    owner_thread_ts: params.ownerThreadTs,
    type: 'coordination',
    status: 'pending_colleague',
    title: taskTitle,
    skill_ref: jobId,
    context: JSON.stringify({ jobId }),
    who_requested: params.ownerUserId,
    pending_on: JSON.stringify(taggedParticipants.filter(p => !p.just_invite).map(p => p.slack_id)),
    skill_origin: 'meetings',
  });

  // v2.7.0 — paired request on the spine. Brief / system prompt / scanner
  // surface from requests. updateCoordJob's terminal hook closes this request
  // via linkCoordToRequest below.
  const participantNames = taggedParticipants.filter(p => !p.just_invite).map(p => p.name);
  const firstKey = taggedParticipants.find(p => !p.just_invite && p.slack_id);
  const requestRow = createRequest({
    ownerUserId: params.ownerUserId,
    initiatedBy: params.ownerUserId,
    initiatedByRole: 'owner',
    kind: 'coord',
    subkind: params.moveExistingEvent ? 'move' : 'schedule',
    subject: taskTitle,
    description: params.topic ?? undefined,
    state: 'awaiting_colleague',
    // v3.1 (Path 2) — coord activity sub-state lives on the request. At
    // initiation we're collecting votes from participants.
    phase: 'coord:collecting',
    informed: 1,
    // Surface the lead participant so colleague-scoped spine queries
    // (reply routing, double-DM guard) can find this coord without a join.
    targetSlackId: firstKey?.slack_id,
    targetName: firstKey?.name,
    outcomeExternalEventId: params.moveExistingEvent?.id,
    originChannel: params.ownerChannel,
    originThreadTs: params.ownerThreadTs,
    // v3.1 (audit fix) — set the owner-DM target so the spine's
    // runApprovalReminder + runExpiry (guarded on `owner_dm_channel`) actually
    // fire the midpoint nag + expiry tombstone for coord approvals. Pre-fix
    // these were NULL on coord requests → those DMs were silently dropped for
    // EVERY coord approval (the initial approval DM still landed via
    // job.owner_channel, but reminder/closure vanished). Mirrors the initial
    // approval DM destination.
    ownerDmChannel: params.ownerChannel,
    ownerDmThreadTs: params.ownerThreadTs,
    // v3.1 (Path 2 Stage 6) — the 24-work-hour nudge is now a spine timer on
    // the request, NOT a separate coord_nudge task. The sweep's coord_nudge
    // handler (core/requests/runner.ts) DMs non-responders then re-arms for
    // coord_abandon. One timer system, one source of truth.
    nextCheckAt: DateTime.now().plus({ hours: 24 }).toUTC().toISO()!,
    nextCheckHandler: 'coord_nudge',
    details: {
      coord_job_id: jobId,
      subject: params.subject,
      topic: params.topic ?? null,
      duration_min: params.durationMin,
      participants: taggedParticipants,
      participant_names: participantNames,
      proposed_slots: params.proposedSlots.map(s => s.start),
    },
  });
  linkCoordToRequest(jobId, requestRow.id);

  const keyParticipants = taggedParticipants.filter(p => !p.just_invite);
  const allNames = params.participants.map(p => p.name);

  const inGroupParticipants = keyParticipants.filter(p => p.contacted_via === 'group');
  const privateDmParticipants = keyParticipants.filter(p => p.contacted_via === 'dm');

  // ── In-group participants: post ONE message in the group thread ──
  if (inGroupParticipants.length > 0 && params.ownerChannel && params.ownerThreadTs) {
    try {
      const slotLines = params.proposedSlots.map((s, i) => {
        const dt = DateTime.fromISO(s.start).setZone(inGroupParticipants[0].tz);
        const locLabel = s.location ? ` — ${s.location}` : '';
        return `${i + 1}. ${dt.toFormat('EEEE, d MMMM')} at ${dt.toFormat('HH:mm')}${locLabel}`;
      }).join('\n');

      const mentions = inGroupParticipants.map(p => `<@${p.slack_id}>`).join(' ');
      const topicLine = params.topic ? ` It's about ${params.topic}.` : '';
      const othersLine = privateDmParticipants.length > 0
        ? ` I'm also checking with ${privateDmParticipants.map(p => p.name).join(' and ')}.`
        : '';

      // Owner is in this DM — speak to the group directly.
      const message =
        `${mentions} — looking for a time for a ${params.durationMin}-min meeting.${topicLine}${othersLine}\n\n` +
        `Here are a few options:\n${slotLines}\n\n` +
        `Which works best for you? Happy to find something else if none of these fit.`;

      const res = await slackConn.postToChannel(params.ownerChannel, message, {
        threadTs: params.ownerThreadTs,
      });
      if (!res.ok) {
        logger.error('Failed to post coordination in group thread', { reason: res.reason, detail: res.detail, jobId });
      } else {
        const now = new Date().toISOString();
        const updatedParticipants = taggedParticipants.map(p =>
          inGroupParticipants.some(ig => ig.slack_id === p.slack_id)
            ? { ...p, dm_sent_at: now }
            : p
        );
        updateCoordJob(jobId, { participants: JSON.stringify(updatedParticipants) });

        logger.info('Coordination options posted in group thread', {
          jobId,
          channel: params.ownerChannel,
          inGroupParticipants: inGroupParticipants.map(p => p.name),
        });

        await shadowNotify(params.profile, {
          channel: params.ownerChannel,
          threadTs: params.ownerThreadTs,
          action: 'Options posted in group',
          detail: `Posted slot options for "${params.subject}" in the group thread for ${inGroupParticipants.map(p => p.name).join(', ')}`,
        });
      }
    } catch (err) {
      logger.error('Failed to post coordination in group thread', { err: String(err), jobId });
    }
  }

  // ── Private-DM participants: individual DMs ──
  for (const participant of privateDmParticipants) {
    try {
      // v3.3.8 (#126) — the REQUESTER asked for this coord inside their own
      // DM conversation; their slot-options DM continues THAT thread instead
      // of opening a parallel one. Guards: colleague-initiated only (owner-
      // path coords have no requester among participants), origin must be a
      // 1:1 DM ('D'-channel — an MPIM origin is handled by the in-group
      // branch above), and an origin thread must exist.
      const isRequesterInOwnDm =
        params.senderRole === 'colleague'
        && !!params.senderUserId
        && participant.slack_id === params.senderUserId
        && !!params.ownerChannel && params.ownerChannel.startsWith('D')
        && !!params.ownerThreadTs;
      await sendCoordDM({
        participant,
        ownerName: params.ownerName,
        assistantName: params.profile.assistant.name,
        otherParticipants: allNames.filter(n => n !== participant.name),
        subject: params.subject,
        topic: params.topic,
        durationMin: params.durationMin,
        proposedSlots: params.proposedSlots,
        jobId,
        profile: params.profile,
        originThread: isRequesterInOwnDm
          ? { channel: params.ownerChannel, threadTs: params.ownerThreadTs! }
          : undefined,
        moveContext: params.moveExistingEvent
          ? {
              currentStartIso: params.moveExistingEvent.currentStartIso,
              currentEndIso: params.moveExistingEvent.currentEndIso,
              conflictReason: params.moveExistingEvent.conflictReason,
            }
          : undefined,
      });
      // v2.2.4 (bug 3c) — per-participant 'DM sent' shadow dropped. Was
      // firing once per participant in the loop, contributing to the "4
      // shadow messages for one coord" noise. The owner sees the coord
      // initiation through other surfaces; the audit log captures the send
      // at info level.
    } catch (err) {
      logger.error('Failed to DM participant', { err: String(err), participant: participant.name });
      // v2.3.1 (B14a + B14b) — humanize the error text AND pin it to a
      // standalone DM (no threadTs) so it doesn't leak into an unrelated
      // conversation thread the owner happens to be reading. A failed DM
      // is operational news, not in-conversation context — keep it visible
      // and isolated.
      const errStr = String(err);
      const humanDetail = errStr.includes('no slack_id')
        ? `I tried to message ${participant.name} for the "${params.subject}" coord, but I don't have a Slack ID for them yet. Want me to add their contact, or skip them on this one?`
        : errStr.includes('user_not_found')
          ? `I couldn't reach ${participant.name} for the "${params.subject}" coord — Slack didn't recognize the user. They may be a guest account or the ID may be off.`
          : `Couldn't reach ${participant.name} for the "${params.subject}" coord — got "${errStr.slice(0, 80)}".`;
      await shadowNotify(params.profile, {
        channel: params.ownerChannel,
        // threadTs intentionally omitted — failures land top-level in the
        // owner's DM, never threaded under an unrelated conversation.
        action: 'DM failed',
        detail: humanDetail,
      });
    }
  }

  logger.info('Coordination initiated', {
    jobId,
    subject: params.subject,
    keyParticipants: keyParticipants.map(p => p.name),
    inGroup: inGroupParticipants.map(p => p.name),
    privateDm: privateDmParticipants.map(p => p.name),
    justInvite: params.participants.filter(p => p.just_invite).map(p => p.name),
    slots: params.proposedSlots.length,
  });

  return jobId;
}

async function sendCoordDM(
  params: {
    participant: CoordParticipant;
    ownerName: string;
    assistantName: string;
    otherParticipants: string[];
    subject: string;
    topic?: string;
    durationMin: number;
    proposedSlots: SlotWithLocation[];
    jobId: string;
    profile: UserProfile;
    // v2.1.1 — when intent='move', frame the DM as "can we shift our
    // existing sync" rather than "find a time for a new meeting".
    moveContext?: {
      currentStartIso: string;
      currentEndIso: string;
      conflictReason?: string;
    };
    // v3.3.8 (#126) — when this participant is the coord's REQUESTER and the
    // coord was initiated from their own DM conversation, post the slot
    // options INTO that thread instead of opening a fresh top-level DM.
    // Pre-fix the requester asked in one thread, got the options in a brand
    // new thread, and had to juggle two parallel threads for one request
    // (the Maayan PT-Sales-Simulation incident). Cold participants (no
    // existing conversation) keep the top-level DM.
    originThread?: {
      channel: string;
      threadTs: string;
    };
  }
): Promise<void> {
  const slackConn = getConnection(params.profile.user.slack_user_id, 'slack');
  if (!slackConn) throw new Error('no Slack connection registered');

  const memory = params.participant.slack_id ? getPersonMemory(params.participant.slack_id) : null;
  const prevInteractions: PersonInteraction[] = (() => {
    try { return JSON.parse(memory?.interaction_log || '[]'); } catch { return []; }
  })();

  // Known-person detection: "not first contact" if ANY of messaging / substantive
  // interaction / stored notes / last_seen is already set.
  const hasMessageSent = prevInteractions.some(i => i.type === 'message_sent');
  const hasSubstantiveInteraction = prevInteractions.some(i =>
    ['meeting_booked', 'conversation', 'coordination', 'message_received'].includes(i.type),
  );
  const hasNotes = (() => {
    try {
      const notes = JSON.parse(memory?.notes || '[]');
      return Array.isArray(notes) && notes.length > 0;
    } catch { return false; }
  })();
  const hasLastSeen = !!memory?.last_seen;
  const isFirstContact = !(hasMessageSent || hasSubstantiveInteraction || hasNotes || hasLastSeen);

  const ownerFirstName = params.ownerName.split(' ')[0];
  const introLine = isFirstContact
    ? `Hi ${params.participant.name}, I'm ${params.assistantName} — I help ${ownerFirstName} with his schedule.\n\n`
    : `Hi ${params.participant.name}, `;

  logger.info('Coord DM intro chosen', {
    participant: params.participant.name,
    slackId: params.participant.slack_id,
    isFirstContact,
    hasMessageSent,
    hasSubstantiveInteraction,
    hasNotes,
    hasLastSeen,
  });

  // v2.2.3 (#43) — annotate each slot with this participant's status
  // (free / busy / tentative / oof) at that exact time. ONE getFreeBusy call
  // per attendee covering the proposed range. Lets the recipient decide
  // without Maelle assuming any of their meetings are movable.
  let slotStatuses: import('../../../utils/annotateSlotsWithAttendeeStatus').AnnotatedSlot<{ start: string; end: string }>[] = [];
  if (params.participant.email) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { annotateSlotsWithAttendeeStatus } = require('../../../utils/annotateSlotsWithAttendeeStatus') as
        typeof import('../../../utils/annotateSlotsWithAttendeeStatus');
      slotStatuses = await annotateSlotsWithAttendeeStatus({
        slots: params.proposedSlots.map(s => ({ start: s.start, end: s.end })),
        attendeeEmail: params.participant.email,
        callerEmail: params.profile.user.email,
        timezone: params.profile.user.timezone,
      });
    } catch (err) {
      logger.warn('coord DM: status annotation failed — proceeding without tags', {
        attendee: params.participant.name, err: String(err).slice(0, 200),
      });
    }
  }
  const statusByStart = new Map(slotStatuses.map(a => [a.slot.start, a.attendeeStatus]));

  // v2.2.3 (#43) — cross-TZ dual rendering. When attendee TZ differs from
  // owner TZ, show BOTH times so they can quickly see what time it'll be on
  // each side. Same TZ → owner-time-only (current behavior).
  const ownerTz = params.profile.user.timezone;
  const showDualTz = !!params.participant.tz && params.participant.tz !== ownerTz;
  const ownerFirst = params.ownerName.split(' ')[0];

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { statusTag } = require('../../../utils/annotateSlotsWithAttendeeStatus') as
    typeof import('../../../utils/annotateSlotsWithAttendeeStatus');

  const slotLines = params.proposedSlots.map((s, i) => {
    const dt = DateTime.fromISO(s.start).setZone(params.participant.tz);
    const locLabel = s.location ? ` — ${s.location}` : '';
    const dualTz = showDualTz
      ? ` / ${DateTime.fromISO(s.start).setZone(ownerTz).toFormat('HH:mm')} ${ownerFirst}'s time`
      : '';
    const status = statusByStart.get(s.start);
    const tag = status ? statusTag(status) : '';
    const tagPart = tag ? ` (${tag})` : '';
    return `${i + 1}. ${dt.toFormat('EEEE, d MMMM')} at ${dt.toFormat('HH:mm')}${dualTz}${tagPart}${locLabel}`;
  }).join('\n');

  // v2.2.3 (#43) — when ALL proposed slots show busy/oof for this participant,
  // offer a one-sentence opt-in to search their calendar. Internal-only —
  // never offer this to externals (calendar access norms differ + feels invasive).
  const ownerDomain = params.profile.user.email.split('@')[1];
  const isInternal = !!params.participant.email && params.participant.email.endsWith(`@${ownerDomain}`);
  const allBusyOrOof = slotStatuses.length > 0
    && slotStatuses.every(a => a.attendeeStatus === 'busy' || a.attendeeStatus === 'oof');
  const optInLine = (isInternal && allBusyOrOof)
    ? '\n\nLooks like all three are busy on your end — want me to look for times you\'re free?'
    : '';

  const othersLine = params.otherParticipants.length > 0
    ? ` (along with ${params.otherParticipants.join(' and ')})`
    : '';
  const topicLine = params.topic ? ` It's about ${params.topic}.` : '';

  // v2.1.1 — MOVE vs SCHEDULE phrasing. A move is never a "new meeting" —
  // framing it that way would confuse the participant. We say: there's a
  // conflict at the current time; pick a new slot and I'll move it.
  let body: string;
  if (params.moveContext) {
    const curDt = DateTime.fromISO(params.moveContext.currentStartIso).setZone(params.participant.tz);
    const curLabel = `${curDt.toFormat('EEEE, d MMMM')} at ${curDt.toFormat('HH:mm')}`;
    const conflictClause = params.moveContext.conflictReason
      ? ` — ${params.moveContext.conflictReason}`
      : '';
    body = `small scheduling conflict for our "${params.subject}"${othersLine}${conflictClause}. Any chance we shift it from ${curLabel}? Here are a few options that work for ${params.ownerName}:\n${slotLines}${optInLine}\n\nWhich of these works for you? (Happy to suggest other times if none fit.)`;
  } else {
    body = `${params.ownerName} asked me to find a time for a ${params.durationMin}-min meeting with you${othersLine}.${topicLine}\n\nHere are a few options — which works best for you?\n${slotLines}${optInLine}\n\nLet me know which one you prefer, or if none of these work I'll find something else.`;
  }

  const message = `${introLine}${body}`;

  // v2.3.1 (B14a) — fall-back resolution. Owner direction: "she knows who
  // Oran is — he's on Slack, mentioned in the past." So before declaring
  // unknown, try people_memory by name. If found there, use that slack_id
  // (and keep the participant object updated for downstream use).
  if (!params.participant.slack_id && params.participant.name) {
    try {
      const matches = searchPeopleMemory(params.participant.name);
      const m0 = matches[0];
      if (matches.length === 1 && m0.slack_id && /^U[A-Z0-9]{7,11}$/.test(m0.slack_id)) {
        logger.info('sendCoordDM — resolved missing slack_id from people_memory', {
          name: params.participant.name, resolved: m0.slack_id,
        });
        params.participant.slack_id = m0.slack_id;
        if (!params.participant.email && m0.email) {
          params.participant.email = m0.email;
        }
      }
    } catch (_) { /* fail open — original error path catches truly unknown */ }
  }

  if (!params.participant.slack_id) {
    throw new Error(`Participant ${params.participant.name} has no slack_id — cannot DM`);
  }

  let res = await slackConn.sendDirect(
    params.participant.slack_id,
    message,
    params.originThread ? { threadTs: params.originThread.threadTs } : undefined,
  );
  // Threaded send failed (stale/foreign thread ts)? The options MUST reach
  // the requester — retry top-level rather than failing the whole coord leg.
  if (!res.ok && params.originThread) {
    logger.warn('sendCoordDM — threaded send into origin thread failed, retrying top-level', {
      jobId: params.jobId, participant: params.participant.name,
      reason: res.reason, detail: res.detail,
    });
    params.originThread = undefined;
    res = await slackConn.sendDirect(params.participant.slack_id, message);
  }
  if (!res.ok) {
    // Surface user_not_found clearly (was the users.info probe's job).
    if (res.detail?.includes('user_not_found')) {
      throw new Error(
        `User "${params.participant.name}" (${params.participant.slack_id}) not found — ` +
        `they may be a guest user or the Slack ID may be wrong.`,
      );
    }
    throw new Error(`Could not DM ${params.participant.name}: ${res.reason} ${res.detail ?? ''}`);
  }

  const dmChannel = res.ref;
  // v3.3.8 (#126) — when the options were threaded into the requester's
  // existing conversation, the thread ROOT is the origin ts, not this
  // message's ts (Slack threads anchor to roots). Recording the root keeps
  // the v1.8.6 booking-confirmation threading in the SAME conversation
  // thread instead of forking a third one.
  const dmTs = params.originThread ? params.originThread.threadTs : res.ts;

  const job = getCoordJob(params.jobId);
  if (job) {
    const participants = JSON.parse(job.participants) as CoordParticipant[];
    const updated = participants.map(p =>
      p.slack_id === params.participant.slack_id
        // Record dm_channel + dm_thread_ts so the booking confirmation (v1.8.6)
        // can thread back into the original coord DM.
        ? { ...p, dm_sent_at: new Date().toISOString(), dm_channel: dmChannel, dm_thread_ts: dmTs }
        : p
    );
    updateCoordJob(params.jobId, { participants: JSON.stringify(updated) });
  }
}

// ── Resolve responses ─────────────────────────────────────────────────────────

export async function resolveCoordination(
  jobId: string,
  profile: UserProfile,
): Promise<void> {
  const job = getCoordJob(jobId);
  if (!job) return;

  const participants = JSON.parse(job.participants) as CoordParticipant[];
  const currentSlots = JSON.parse(job.proposed_slots) as string[];
  const keyParticipants = participants.filter(p => !p.just_invite);

  const isRound2 = keyParticipants.some(p => (p as any)._re_voter === true);

  // Vote tally
  const voteCounts: Record<string, number> = {};
  for (const slot of currentSlots) voteCounts[slot] = 0;

  const flexibleYes = keyParticipants.filter(p => p.response === 'yes' && !p.preferred_slot);
  for (const p of keyParticipants) {
    if (p.response === 'yes' && p.preferred_slot && voteCounts[p.preferred_slot] !== undefined) {
      voteCounts[p.preferred_slot]++;
    }
  }

  const noResponders = keyParticipants.filter(p => p.response === 'no');
  const bestSlot = currentSlots.reduce((best, slot) =>
    (voteCounts[slot] || 0) > (voteCounts[best] || 0) ? slot : best
  , currentSlots[0]);
  const bestCount = (voteCounts[bestSlot] || 0) + flexibleYes.length;

  logger.info('Coordination resolution', {
    jobId,
    isRound2,
    bestSlot,
    bestCount,
    totalKey: keyParticipants.length,
    noCount: noResponders.length,
  });

  // Everyone agrees — book
  if (noResponders.length === 0 && bestCount >= keyParticipants.length) {
    await bookCoordination(jobId, bestSlot, profile);
    return;
  }

  // Ping-pong negotiation: participants picked different slots
  if (noResponders.length === 0 && bestCount < keyParticipants.length) {
    const specificVoters = keyParticipants.filter(p => p.response === 'yes' && p.preferred_slot);
    const uniqueSlots = [...new Set(specificVoters.map(p => p.preferred_slot!))];
    if (uniqueSlots.length > 1) {
      await startPingPong(job, specificVoters, participants, profile);
      return;
    }
  }

  // Round 1 conflict: ask "no" voters what times work
  if (!isRound2 && noResponders.length > 0) {
    await startRenegotiation(job, noResponders, participants, profile);
    return;
  }

  // Round 2 complete — final decision
  const finalNoResponders = keyParticipants.filter(p => p.response === 'no');

  if (bestCount === 0 || bestCount < keyParticipants.length - finalNoResponders.length) {
    const noNames = finalNoResponders.map(p => p.name).join(' and ');
    const askText = isRound2
      ? `I tried two rounds for "${job.subject}" and couldn't find a time that works for everyone. ${noNames} still can't make any option. Want me to look for completely different slots?`
      : noNames
        ? `I couldn't find a time for "${job.subject}" that works — ${noNames} can't make any of the proposed options. Want me to look for different slots?`
        : `I couldn't find a time for "${job.subject}" that works for everyone. Want me to try different options?`;
    await emitWaitingOwnerApproval({
      job,
      profile,
      kind: 'freeform',
      payload: { subject: job.subject, question: 'retry_with_new_slots', no_responders: finalNoResponders.map(p => p.name) },
      askText,
    });
    return;
  }

  if (finalNoResponders.length > 0) {
    const bestDt = DateTime.fromISO(bestSlot).setZone(profile.user.timezone);
    const askText = `After two rounds, ${bestDt.toFormat("EEEE, d MMMM 'at' HH:mm")} works for most people on "${job.subject}" — but ${finalNoResponders.map(p => p.name).join(' and ')} can't make it. Book anyway, or look for a new time?`;
    const participantsParsed = JSON.parse(job.participants) as CoordParticipant[];
    await emitWaitingOwnerApproval({
      job,
      profile,
      kind: 'slot_pick',
      payload: {
        coord_job_id: job.id,
        subject: job.subject,
        slots: [{ iso: bestSlot, label: bestDt.toFormat("EEEE, d MMMM 'at' HH:mm") }],
        participants_emails: participantsParsed.filter(p => !!p.email).map(p => p.email!),
        duration_min: job.duration_min,
        override_no_responders: finalNoResponders.map(p => p.name),
      },
      askText,
      winningSlot: bestSlot,
    });
    return;
  }

  await bookCoordination(jobId, bestSlot, profile);
}

// ── Ping-pong negotiation ───────────────────────────────────────────────────

async function startPingPong(
  job: CoordJob,
  specificVoters: CoordParticipant[],
  _allParticipants: CoordParticipant[],
  profile: UserProfile,
): Promise<void> {
  const uniqueSlots = [...new Set(specificVoters.map(p => p.preferred_slot!))];
  uniqueSlots.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  updateCoordJob(job.id, {
    status: 'negotiating',
    notes: JSON.stringify({
      ...JSON.parse(job.notes ?? '{}'),
      pingPongQueue: uniqueSlots,
      pingPongIndex: 0,
    }),
  });

  await tryNextPingPongSlot(job.id, profile);
}

async function tryNextPingPongSlot(
  jobId: string,
  profile: UserProfile,
): Promise<void> {
  const job = getCoordJob(jobId);
  if (!job) return;

  const slackConn = getConnection(profile.user.slack_user_id, 'slack');
  if (!slackConn) {
    logger.error('tryNextPingPongSlot — no Slack connection registered', { jobId });
    return;
  }

  const notes = JSON.parse(job.notes ?? '{}');
  const queue: string[] = notes.pingPongQueue ?? [];
  const index: number = notes.pingPongIndex ?? 0;

  if (index >= queue.length) {
    const participants = JSON.parse(job.participants) as CoordParticipant[];
    const noResponders = participants.filter(p => !p.just_invite && p.response === 'no');
    if (noResponders.length > 0) {
      await startRenegotiation(job, noResponders, participants, profile);
    } else {
      await emitWaitingOwnerApproval({
        job,
        profile,
        kind: 'freeform',
        payload: { coord_job_id: job.id, subject: job.subject, question: 'no_slot_found_try_new_options' },
        askText: `I couldn't find a time that works for everyone on "${job.subject}". Want me to try different options?`,
      });
    }
    return;
  }

  const targetSlot = queue[index];
  const targetDt = DateTime.fromISO(targetSlot).setZone(profile.user.timezone);
  const participants = JSON.parse(job.participants) as CoordParticipant[];
  const keyParticipants = participants.filter(p => !p.just_invite);

  const pickedThis = keyParticipants.filter(p => p.preferred_slot === targetSlot);
  const didntPickThis = keyParticipants.filter(p => p.preferred_slot !== targetSlot && p.response === 'yes');

  if (didntPickThis.length === 0) {
    await bookCoordination(jobId, targetSlot, profile);
    return;
  }

  const suggesterNames = pickedThis.map(p => p.name).join(' and ');
  const slotLabel = targetDt.toFormat("EEEE, d MMMM 'at' HH:mm");

  // Reset holdout responses and mark them as ping-pong targets
  const updatedParticipants = participants.map(p => {
    if (didntPickThis.some(h => h.slack_id === p.slack_id)) {
      return {
        ...p,
        response: null as 'yes' | 'no' | 'maybe' | null,
        preferred_slot: undefined,
        responded_at: undefined,
        _pingPongTarget: true,
        _pingPongSlot: targetSlot,
      };
    }
    return p;
  });
  updateCoordJob(jobId, {
    participants: JSON.stringify(updatedParticipants),
    proposed_slots: JSON.stringify([targetSlot]),
  });

  for (const holdout of didntPickThis) {
    if (!holdout.slack_id) continue;
    const holdoutDt = DateTime.fromISO(targetSlot).setZone(holdout.tz);
    const res = await slackConn.sendDirect(
      holdout.slack_id,
      `${suggesterNames} suggested ${holdoutDt.toFormat("EEEE, d MMMM 'at' HH:mm")} for "${job.subject}" — can you make it?`,
    );
    if (!res.ok) {
      logger.warn('Could not send ping-pong DM', { reason: res.reason, participant: holdout.name });
    }
  }

  await shadowNotify(profile, {
    channel: job.owner_channel,
    threadTs: job.owner_thread_ts ?? undefined,
    action: 'Negotiating',
    detail: `Asking ${didntPickThis.map(p => p.name).join(', ')} if ${slotLabel} works (suggested by ${suggesterNames})`,
    // v2.3.2 — group all coord-progress shadows for THIS coord under one
    // owner-DM thread, keyed on the coord_job id.
    conversationKey: `coord:${job.id}`,
    conversationHeader: `Coord: "${job.subject}"`,
  });
}

// ── Renegotiation (open-ended: "what times work?") ──────────────────────────

export async function startRenegotiation(
  job: CoordJob,
  noVoters: CoordParticipant[],
  allParticipants: CoordParticipant[],
  profile: UserProfile,
): Promise<void> {
  const slackConn = getConnection(profile.user.slack_user_id, 'slack');
  if (!slackConn) {
    logger.error('startRenegotiation — no Slack connection registered', { jobId: job.id });
    return;
  }

  const updated = allParticipants.map(p => {
    const isNoVoter = noVoters.some(nv => nv.slack_id === p.slack_id);
    if (!isNoVoter) return p;
    const alreadyHasPref = !!(p as any)._preference;
    return { ...p, response: null, preferred_slot: undefined, responded_at: undefined, _awaiting_preference: !alreadyHasPref };
  });
  updateCoordJob(job.id, { participants: JSON.stringify(updated) });

  const needsFollowUp = noVoters.filter(p => !(p as any)._preference);
  const inGroupFollowUp = needsFollowUp.filter(p => p.contacted_via === 'group' && p.group_channel && p.group_thread_ts);
  const privateDmFollowUp = needsFollowUp.filter(p => p.contacted_via !== 'group');

  if (inGroupFollowUp.length > 0) {
    const channel = inGroupFollowUp[0].group_channel!;
    const threadTs = inGroupFollowUp[0].group_thread_ts!;
    const mentions = inGroupFollowUp.map(p => `<@${p.slack_id}>`).join(' ');
    const res = await slackConn.postToChannel(
      channel,
      `${mentions} — none of the times I suggested for "${job.subject}" worked for you. ` +
      `What times work best? For example: "mornings", "Tuesday afternoon", or "any time Thursday". ` +
      `I'll find something that fits and check with the others.`,
      { threadTs },
    );
    if (!res.ok) {
      logger.warn('Could not post renegotiation in group thread', { reason: res.reason, detail: res.detail });
    }
  }

  for (const p of privateDmFollowUp) {
    if (!p.slack_id) continue;
    const res = await slackConn.sendDirect(
      p.slack_id,
      `Hi ${p.name}, none of the options I proposed for "${job.subject}" worked for you — ` +
      `what times work best for you? For example: "mornings", "Tuesday afternoon", or "any time Thursday". ` +
      `I'll find something that fits and check with the others.`,
    );
    if (!res.ok) {
      logger.warn('Could not send renegotiation DM', { reason: res.reason, participant: p.name });
    }
  }

  // v2.2.4 (bug 3c) — 'Renegotiating' state-hop shadow dropped. Round 2
  // launching is the decision-worthy event; that shadow (state.ts ~929)
  // carries the consolidated narration with what triggered it. Owner doesn't
  // need a separate "asking what times work" line in between.

  // If ALL no-voters already had preferences — skip waiting, go straight to round 2
  if (needsFollowUp.length === 0) {
    await triggerRoundTwo(job, updated, profile);
  }
}

export async function triggerRoundTwo(
  job: CoordJob,
  allParticipants: CoordParticipant[],
  profile: UserProfile,
): Promise<void> {
  const slackConn = getConnection(profile.user.slack_user_id, 'slack');
  if (!slackConn) {
    logger.error('triggerRoundTwo — no Slack connection registered', { jobId: job.id });
    return;
  }

  const keyParticipants = allParticipants.filter(p => !p.just_invite);
  const preferenceGivers = keyParticipants.filter(p => (p as any)._preference);

  const windows = preferenceGivers.map(p => (p as any)._preference as { searchFrom: string; searchTo: string; hoursStart: string; hoursEnd: string });
  const searchFrom = windows.reduce((latest, w) => w.searchFrom > latest ? w.searchFrom : latest, windows[0].searchFrom);
  const searchTo = windows.reduce((earliest, w) => w.searchTo < earliest ? w.searchTo : earliest, windows[0].searchTo);
  const hoursStart = windows.reduce((latest, w) => w.hoursStart > latest ? w.hoursStart : latest, windows[0].hoursStart);
  const hoursEnd = windows.reduce((earliest, w) => w.hoursEnd < earliest ? w.hoursEnd : earliest, windows[0].hoursEnd);

  if (searchFrom > searchTo || hoursStart >= hoursEnd) {
    const names = preferenceGivers.map(p => p.name).join(' and ');
    await emitWaitingOwnerApproval({
      job,
      profile,
      kind: 'freeform',
      payload: { coord_job_id: job.id, subject: job.subject, question: 'conflicting_preferences', names },
      askText: `I couldn't find overlapping availability for "${job.subject}" — ${names} have conflicting time preferences. Want to handle this differently?`,
    });
    return;
  }

  const allWorkDays = [
    ...profile.schedule.office_days.days,
    ...profile.schedule.home_days.days,
  ] as string[];

  // Round 2 widening + annotation. Three coordinated fixes:
  //   - extendedHours=true: actually widens the search. Pre-fix the
  //     workHoursStart/End strings were ineffective without this flag, so
  //     round 2 didn't widen at all. Post-wave-4 (#8) extendedHours UNIONS
  //     widened + native windows instead of collapsing, so split-shift
  //     days survive.
  //   - attendeeAvailability (work-hours clip via loadAttendeeAvailabilityForEmails):
  //     don't propose 22:00 to someone who works 09:00-17:00.
  //   - NO attendeeBusyEmails: per owner direction, when a colleague is the
  //     poll target, busy time is ANNOTATION (let them decide via DM-poll
  //     in the next round), not blocking. Pre-fix round 2 also passed [] for
  //     attendeeEmails so even work-hours clip was skipped — propose slots
  //     colleagues couldn't make.
  let newSlots: Array<{ start: string; end: string }> = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadAttendeeAvailabilityForEmails } = require('../../../utils/attendeeAvailability') as
      typeof import('../../../utils/attendeeAvailability');
    const participantEmails = allParticipants
      .map(p => p.email)
      .filter((e): e is string => !!e);
    const attendeeAvailability = loadAttendeeAvailabilityForEmails(
      participantEmails,
      profile.user.email,
    );
    newSlots = await findAvailableSlots({
      userEmail: profile.user.email,
      timezone: profile.user.timezone,
      durationMinutes: job.duration_min,
      attendeeEmails: participantEmails,
      attendeeAvailability,
      searchFrom: `${searchFrom}T${hoursStart}:00`,
      searchTo: `${searchTo}T${hoursEnd}:00`,
      workDays: allWorkDays,
      extendedHours: true,
      meetingMode: 'either',
      autoExpand: false,
      profile,
    });
  } catch (err) {
    logger.error('Failed to find slots for round 2', { err });
  }

  if (newSlots.length === 0) {
    await emitWaitingOwnerApproval({
      job,
      profile,
      kind: 'freeform',
      payload: { coord_job_id: job.id, subject: job.subject, question: 'no_slots_within_preferences' },
      askText: `No available slots found for "${job.subject}" within the preferences given. Want me to try different times?`,
    });
    return;
  }

  const chosenSlots = pickSpreadSlots(newSlots, profile.user.timezone, 3);

  // Determine location per new slot
  const ownerDomain = profile.user.email.split('@')[1];
  const isInternal = allParticipants.every(p =>
    !p.email || p.email.endsWith(`@${ownerDomain}`)
  );
  const totalPeople = allParticipants.length + 1;

  // v2.2.4 (bug 8b) — any traveling participant forces online location.
  let anyTraveling = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCurrentTravel } = require('../../../db') as typeof import('../../../db');
    for (const p of allParticipants) {
      if (p.slack_id && getCurrentTravel(p.slack_id)) { anyTraveling = true; break; }
    }
  } catch (_) { /* fail open */ }

  // v2.7.0 — unified location via resolveLocation. Replaces determineSlotLocation.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveLocation: rl } = require('../../../utils/resolveLocation') as typeof import('../../../utils/resolveLocation');
  const hasExternal = !isInternal;
  const slotsWithLocation: SlotWithLocation[] = chosenSlots.map(slotStart => {
    // v2.8.2 — categories no longer drive location. ask_owner can't be asked
    // here (we're mid-coord), so default to online if it fires.
    const v = rl({
      profile,
      startIso: slotStart,
      intent: 'new_booking',
      participantCount: totalPeople,
      hasExternalAttendee: hasExternal,
      anyParticipantRemote: anyTraveling,
    });
    let location = '';
    let isOnline = true;
    if (v.kind === 'resolved') {
      location = v.location;
      isOnline = v.isOnline;
    }
    return {
      start: slotStart,
      end: DateTime.fromISO(slotStart).plus({ minutes: job.duration_min }).toISO()!,
      location,
      isOnline,
    };
  });

  const reVoters = keyParticipants.filter(p => p.response === 'yes' && !(p as any)._preference);
  const updatedParticipants = allParticipants.map(p => {
    if (reVoters.some(r => r.slack_id === p.slack_id)) {
      return { ...p, response: null, preferred_slot: undefined, responded_at: null, _re_voter: true };
    }
    if ((p as any)._preference) {
      return { ...p, preferred_slot: undefined };
    }
    return p;
  });

  const existingNotes = JSON.parse(job.notes ?? '{}');
  updateCoordJob(job.id, {
    proposed_slots: JSON.stringify(chosenSlots),
    participants: JSON.stringify(updatedParticipants),
    last_calendar_check: new Date().toISOString(),
    notes: JSON.stringify({
      ...existingNotes,
      slotsMetadata: slotsWithLocation.map(s => ({ start: s.start, location: s.location, isOnline: s.isOnline })),
    }),
  });

  const preferenceNames = preferenceGivers.map(p => p.name).join(' and ');

  const inGroupReVoters = reVoters.filter(p => p.contacted_via === 'group' && p.group_channel && p.group_thread_ts);
  const privateDmReVoters = reVoters.filter(p => p.contacted_via !== 'group');

  if (inGroupReVoters.length > 0) {
    const channel = inGroupReVoters[0].group_channel!;
    const threadTs = inGroupReVoters[0].group_thread_ts!;
    const mentions = inGroupReVoters.map(p => `<@${p.slack_id}>`).join(' ');
    const displaySlots = slotsWithLocation.map((s, i) => {
      const dt = DateTime.fromISO(s.start).setZone(inGroupReVoters[0].tz);
      const locLabel = s.location ? ` — ${s.location}` : '';
      return `${i + 1}. ${dt.toFormat('EEEE, d MMMM')} at ${dt.toFormat('HH:mm')}${locLabel}`;
    }).join('\n');
    const res = await slackConn.postToChannel(
      channel,
      `${mentions} — ${preferenceNames} can do other times, so here are new options for "${job.subject}":\n${displaySlots}\n\nDo any of these work? Reply with the number.`,
      { threadTs },
    );
    if (!res.ok) {
      logger.warn('Could not post round-2 in group thread', { reason: res.reason, detail: res.detail });
    }
  }

  for (const p of privateDmReVoters) {
    if (!p.slack_id) continue;
    const slotLines = slotsWithLocation.map((s, i) => {
      const dt = DateTime.fromISO(s.start).setZone(p.tz);
      const locLabel = s.location ? ` — ${s.location}` : '';
      return `${i + 1}. ${dt.toFormat('EEEE, d MMMM')} at ${dt.toFormat('HH:mm')}${locLabel}`;
    }).join('\n');
    const res = await slackConn.sendDirect(
      p.slack_id,
      `Hi ${p.name}, ${preferenceNames} can do other times, so here are new options for "${job.subject}":\n${slotLines}\n\nDo any of these work? Reply with the number.`,
    );
    if (!res.ok) {
      logger.warn('Could not send round-2 DM', { reason: res.reason, participant: p.name });
    }
  }

  await shadowNotify(profile, {
    channel: job.owner_channel,
    threadTs: job.owner_thread_ts ?? undefined,
    action: 'Round 2 started',
    detail: `New slots found within ${preferenceNames}'s window — re-asking ${reVoters.map(p => p.name).join(', ')}`,
    conversationKey: `coord:${job.id}`,
    conversationHeader: `Coord: "${job.subject}"`,
  });
}
