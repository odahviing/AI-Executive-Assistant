import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import type { UserProfile } from '../../config/userProfile';
import {
  createCoordJob,
  updateCoordJob,
  getCoordJob,
  getCoordJobsByParticipant,
  cancelOrphanCoordJobs,
  auditLog,
  logEvent,
  getDb,
  type CoordParticipant,
  type CoordJob,
} from '../../db';
import { getOpenTasksForOwner, createTask } from '../../tasks';
import { findAvailableSlots, pickSpreadSlots } from '../graph/calendar';
import { getPersonMemory, upsertPersonMemory, appendPersonInteraction, type PersonInteraction } from '../../db';
import { shadowNotify } from '../../utils/shadowNotify';
import { type ApprovalKind } from '../../db/approvals';
import logger from '../../utils/logger';

// v1.6.2 — this file used to be 1837 lines. The size-only split factored out
// three clusters that were inflating it:
//   - coord/utils.ts  → determineSlotLocation, interpretReplyWithAI, isCoordReplyByContext
//   - coord/approval.ts → emitWaitingOwnerApproval
//   - coord/booking.ts → bookCoordination + forceBookCoordinationByOwner
// The NEXT pass (agent-vs-transport split, target after user QA) will move
// the state-machine pieces that remain here into skills/meetings/ and have
// them call a generic Connection interface instead of @slack/bolt directly.
import {
  determineSlotLocation,
  interpretReplyWithAI,
  isCoordReplyByContext,
  type SlotWithLocation,
} from './coord/utils';
import { emitWaitingOwnerApproval } from './coord/approval';
import { bookCoordination, forceBookCoordinationByOwner } from './coord/booking';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// Re-exports for existing external callers (app.ts, meetings.ts, resolver.ts,
// coordinator.ts) — keeping the old import paths working.
export {
  determineSlotLocation,
  emitWaitingOwnerApproval,
  forceBookCoordinationByOwner,
};
export type { SlotWithLocation };


// ── Initiate coordination ───────────────────────────────────────────────────

export async function initiateCoordination(
  app: App,
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
    botToken: string;
    profile: UserProfile;
    mpimMemberIds?: string[];
    needsDurationApproval?: boolean;
    isUrgent?: boolean;
    senderRole?: 'owner' | 'colleague';
    senderUserId?: string;
  }
): Promise<string> {
  const mpimMembers = new Set(params.mpimMemberIds ?? []);

  // ── Owner auto-inclusion for colleague-initiated coord (defense-in-depth) ──
  // If the skill layer missed the owner for any reason (prompt injection,
  // args mutated mid-flight, future refactor), add him here. This replaces
  // the old layer-2 refuse: Maelle is the owner's assistant, every coord a
  // colleague asks her to run is implicitly WITH the owner.
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
  }

  // Filter out the owner — they are never a coordination participant (slots are already from their calendar)
  const filteredParticipants = params.participants.filter(p => p.slack_id !== params.ownerUserId);
  if (filteredParticipants.length === 0) {
    logger.warn('All participants filtered out (all were the owner)', { ownerUserId: params.ownerUserId });
    return 'no_participants';
  }

  // ── Ensure people memory exists for every booked participant ──
  // Even first-and-last contact should leave a trace — we never know when we'll
  // hear from them again, and knowing we coordinated with them is load-bearing
  // for future interactions. upsertPersonMemory uses COALESCE so we never
  // overwrite richer data we already have.
  for (const p of filteredParticipants) {
    if (!p.slack_id) continue;   // just_invite entries with no slack_id — skip
    try {
      upsertPersonMemory({
        slackId:  p.slack_id,
        name:     p.name,
        email:    p.email,
        timezone: p.tz,
      });
      // v1.6.8 — DON'T write "Coordinating 'Subject' with X" into the person's
      // interaction_log. coord_jobs already tracks this end-to-end and the
      // people_memory log was making the LLM re-surface old coord subjects
      // long after they were cancelled. interaction_log is for social +
      // relationship context only; operational state belongs in the
      // operational tables.
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

  // Store slot start times + location metadata in notes
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
    status: 'collecting',
    proposed_slots: JSON.stringify(params.proposedSlots.map(s => s.start)),
    participants: JSON.stringify(taggedParticipants),
    notes: JSON.stringify({
      isOnline: params.proposedSlots[0]?.isOnline ?? false,
      location: params.proposedSlots[0]?.location,
      slotsMetadata,
      ...(params.needsDurationApproval ? { needsDurationApproval: true } : {}),
      ...(params.isUrgent ? { isUrgent: true } : {}),
    }),
    last_calendar_check: new Date().toISOString(),
  });

  cancelOrphanCoordJobs(params.ownerUserId, params.subject, jobId);

  // Create a task for tracking
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

  // v1.6.0 — schedule the 24-work-hour nudge as a first-class task instead of
  // relying on a background sweep. The dispatcher in runner.ts will fire at
  // that time, DM non-responders, then queue a coord_abandon task +4h later.
  // Work-hours approximation: if today is a work day and it's still work hours
  // we use 24h wall-clock; if it's evening / weekend we push to the next
  // morning + 24h. Keep it simple — the dispatcher rechecks state anyway.
  const nudgeAt = DateTime.now().plus({ hours: 24 }).toUTC().toISO()!;
  createTask({
    owner_user_id: params.ownerUserId,
    owner_channel: params.ownerChannel,
    owner_thread_ts: params.ownerThreadTs,
    type: 'coord_nudge',
    status: 'new',
    title: `Nudge non-responders for "${params.subject}"`,
    due_at: nudgeAt,
    skill_ref: jobId,
    context: JSON.stringify({ coord_job_id: jobId }),
    who_requested: 'system',
    skill_origin: 'meetings',
  });

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

      // Owner is in this DM — don't say "Idan asked me", that's impolite when
      // they're right here. Speak as if to the group directly.
      const message =
        `${mentions} — looking for a time for a ${params.durationMin}-min meeting.${topicLine}${othersLine}\n\n` +
        `Here are a few options:\n${slotLines}\n\n` +
        `Which works best for you? Happy to find something else if none of these fit.`;

      await app.client.chat.postMessage({
        token: params.botToken,
        channel: params.ownerChannel,
        thread_ts: params.ownerThreadTs,
        text: message,
      });

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

      await shadowNotify(app, params.profile, {
        channel: params.ownerChannel,
        threadTs: params.ownerThreadTs,
        action: 'Options posted in group',
        detail: `Posted slot options for "${params.subject}" in the group thread for ${inGroupParticipants.map(p => p.name).join(', ')}`,
      });
    } catch (err) {
      logger.error('Failed to post coordination in group thread', { err: String(err), jobId });
    }
  }

  // ── Private-DM participants: individual DMs ──
  for (const participant of privateDmParticipants) {
    try {
      await sendCoordDM(app, {
        botToken: params.botToken,
        participant,
        ownerName: params.ownerName,
        assistantName: params.profile.assistant.name,
        otherParticipants: allNames.filter(n => n !== participant.name),
        subject: params.subject,
        topic: params.topic,
        durationMin: params.durationMin,
        proposedSlots: params.proposedSlots,
        jobId,
      });
      await shadowNotify(app, params.profile, {
        channel: params.ownerChannel,
        threadTs: params.ownerThreadTs,
        action: 'DM sent',
        detail: `Sent ${participant.name} slot options for "${params.subject}"`,
      });
    } catch (err) {
      logger.error('Failed to DM participant', { err: String(err), participant: participant.name });
      await shadowNotify(app, params.profile, {
        channel: params.ownerChannel,
        threadTs: params.ownerThreadTs,
        action: 'DM failed',
        detail: `Could not reach ${participant.name} — Slack returned: ${String(err).slice(0, 120)}. Check their Slack ID in contacts.`,
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
  app: App,
  params: {
    botToken: string;
    participant: CoordParticipant;
    ownerName: string;
    assistantName: string;
    otherParticipants: string[];
    subject: string;
    topic?: string;
    durationMin: number;
    proposedSlots: SlotWithLocation[];
    jobId: string;
  }
): Promise<void> {
  try {
    await app.client.users.info({ token: params.botToken, user: params.participant.slack_id! });
  } catch (infoErr: any) {
    const errMsg = String(infoErr);
    if (errMsg.includes('user_not_found')) {
      throw new Error(
        `User "${params.participant.name}" (${params.participant.slack_id}) not found — ` +
        `they may be a guest user or the Slack ID may be wrong.`
      );
    }
  }

  const dmResult = await app.client.conversations.open({
    token: params.botToken,
    users: params.participant.slack_id,
  });
  const dmChannel = (dmResult.channel as any)?.id;
  if (!dmChannel) throw new Error(`Could not open DM with ${params.participant.name}`);

  const memory = params.participant.slack_id ? getPersonMemory(params.participant.slack_id) : null;
  const prevInteractions: PersonInteraction[] = (() => {
    try { return JSON.parse(memory?.interaction_log || '[]'); } catch { return []; }
  })();

  // Known-person detection: treat as "not first contact" if ANY of:
  //   - we've messaged them before (message_sent)
  //   - we have any interaction at all of a substantive type
  //   - they have personal notes stored
  //   - last_seen is set (Slack has seen them interact with us)
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
  // Persona: Maelle presents as a human assistant to colleagues. No "AI", "bot",
  // "learning as we go". Short, warm intro on first contact; skip entirely for
  // anyone we already know.
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

  const slotLines = params.proposedSlots.map((s, i) => {
    const dt = DateTime.fromISO(s.start).setZone(params.participant.tz);
    const locLabel = s.location ? ` — ${s.location}` : '';
    return `${i + 1}. ${dt.toFormat('EEEE, d MMMM')} at ${dt.toFormat('HH:mm')}${locLabel}`;
  }).join('\n');

  const othersLine = params.otherParticipants.length > 0
    ? ` (along with ${params.otherParticipants.join(' and ')})`
    : '';
  const topicLine = params.topic ? ` It's about ${params.topic}.` : '';

  const body = `${params.ownerName} asked me to find a time for a ${params.durationMin}-min meeting with you${othersLine}.${topicLine}\n\nHere are a few options — which works best for you?\n${slotLines}\n\nLet me know which one you prefer, or if none of these work I'll find something else.`;

  // introLine already includes the greeting in both branches, so just concatenate.
  const message = `${introLine}${body}`;

  const postResult = await app.client.chat.postMessage({
    token: params.botToken,
    channel: dmChannel,
    text: message,
  });
  const dmTs = (postResult as any)?.ts as string | undefined;

  const job = getCoordJob(params.jobId);
  if (job) {
    const participants = JSON.parse(job.participants) as CoordParticipant[];
    const updated = participants.map(p =>
      p.slack_id === params.participant.slack_id
        // v1.8.6 — also record dm_channel + dm_thread_ts so follow-ups
        // (especially the booking confirmation in booking.ts) can post back
        // into the same thread instead of starting a new top-level DM.
        ? { ...p, dm_sent_at: new Date().toISOString(), dm_channel: dmChannel, dm_thread_ts: dmTs }
        : p
    );
    updateCoordJob(params.jobId, { participants: JSON.stringify(updated) });
  }
}

// ── Handle reply from participant ─────────────────────────────────────────────

/**
 * Handles a coordination reply. Supports:
 * - In-thread replies (normal)
 * - Out-of-thread replies: if the sender has active coord jobs, uses AI context
 *   to determine if the message is about scheduling. Disambiguates if multiple jobs.
 */
export async function handleCoordReply(
  app: App,
  params: {
    senderId: string;
    text: string;
    channelId: string;
    threadTs?: string;
    profile: UserProfile;
    botToken: string;
  }
): Promise<boolean> {
  const allJobs = getCoordJobsByParticipant(params.senderId, params.profile.user.slack_user_id);
  if (allJobs.length === 0) return false;

  // ── Thread-boundary fast-path ─────────────────────────────────────────────
  // If a coord was initiated in a group DM / channel (C-prefix owner_channel)
  // and this new message arrived in a different channel (e.g. participant's
  // 1:1 DM with Maelle), it's not a reply to that coord — it's a new request.
  // Filter out those jobs before running the Haiku context classifier.
  // For 1:1 DM coords, the participant's reply normally comes in the same DM,
  // so we keep those jobs in scope and let the tightened classifier decide.
  const jobs = allJobs.filter(j => {
    const coordIsGroup = j.owner_channel?.startsWith('C'); // C-prefix = group/channel
    if (!coordIsGroup) return true; // 1:1 DM coord — keep, classifier decides
    // Group coord: only consider this job if the new message is in the SAME group channel.
    return j.owner_channel === params.channelId;
  });
  if (jobs.length === 0) {
    logger.info('Coord reply: no jobs match the current thread context — routing to orchestrator', {
      senderId: params.senderId,
      channelId: params.channelId,
      filteredOutCount: allJobs.length,
    });
    return false;
  }

  // Helper: pull human-readable counterpart names from a job for the classifier.
  const namesFor = (j: CoordJob): string[] => {
    try {
      const parts = JSON.parse(j.participants) as CoordParticipant[];
      return parts.map(p => p.name).filter(Boolean);
    } catch { return []; }
  };

  let job: CoordJob;

  if (jobs.length === 1) {
    // Single active coordination — check if the message is contextually about it
    const isRelevant = await isCoordReplyByContext(params.text, jobs[0].subject, namesFor(jobs[0]));
    if (!isRelevant) return false;
    job = jobs[0];
  } else {
    // Multiple active coordinations — ask which one
    // First check if any is a clear match by context
    for (const j of jobs) {
      const isRelevant = await isCoordReplyByContext(params.text, j.subject, namesFor(j));
      if (isRelevant) {
        job = j;
        break;
      }
    }
    if (!job!) {
      // No clear match — ask for disambiguation
      const subjects = jobs.map((j, i) => `${i + 1}. "${j.subject}"`).join('\n');
      await app.client.chat.postMessage({
        token: params.botToken,
        channel: params.channelId,
        text: `I have a few open scheduling threads with you — which one is this about?\n${subjects}`,
      });
      return true;
    }
  }

  const participants = JSON.parse(job.participants) as CoordParticipant[];
  const proposedSlots = JSON.parse(job.proposed_slots) as string[];
  const participant = participants.find(p => p.slack_id === params.senderId);
  if (!participant) return false;

  logger.info('Coord reply received', { jobId: job.id, from: participant.name });

  // ── Follow-up on a waiting_owner job ────────────────────────────────────
  // Participant already responded and the job is now awaiting the owner's
  // decision. A follow-up message from this participant is usually them
  // trying to be helpful (e.g. "actually, Thursday 2pm would work better").
  // Re-running resolveCoordination here can destructively flip their prior
  // 'yes' to 'no' or trigger an unnecessary renegotiation round. Instead:
  // ack the participant and forward their follow-up to the owner so they
  // can factor it into the pending decision.
  if (job.status === 'waiting_owner' && participant.response !== null) {
    const ackInThread = participant.contacted_via === 'group' && job.owner_channel === params.channelId;
    await app.client.chat.postMessage({
      token: params.botToken,
      channel: params.channelId,
      ...(ackInThread && job.owner_thread_ts ? { thread_ts: job.owner_thread_ts } : {}),
      text: `Thanks! I'll pass that along.`,
    });
    await shadowNotify(app, params.profile, {
      channel: job.owner_channel,
      threadTs: job.owner_thread_ts ?? undefined,
      action: 'Follow-up received',
      detail: `${participant.name} followed up on "${job.subject}": "${params.text.trim()}"`,
    });
    return true;
  }

  // ── Preference reply: they were asked "what times work for you?" ─
  if ((participant as any)._awaiting_preference) {
    await handlePreferenceReply(app, job, participant, params.text.trim(), params.profile, params.botToken);
    return true;
  }

  // ── Normal slot-selection reply ─
  const text = params.text.trim();
  let preferredSlot: string | undefined;
  let response: 'yes' | 'no' | 'maybe' = 'maybe';
  let suggestedAlternative: string | null = null;
  let locationOverride: string | undefined;

  const numMatch = text.match(/^[123]/);
  if (numMatch) {
    const idx = parseInt(numMatch[0]) - 1;
    if (idx >= 0 && idx < proposedSlots.length) {
      preferredSlot = proposedSlots[idx];
      response = 'yes';
    }
  } else if (/\b(none|doesn'?t work|no time|can'?t|cannot|busy|not available|nope|no)\b/i.test(text)) {
    response = 'no';
  } else if (/\b(any|works|fine|good|ok|sure|yes|yep|yeah|perfect|great|sounds good)\b/i.test(text)) {
    response = 'yes';
    preferredSlot = proposedSlots[0];
  } else {
    const aiResult = await interpretReplyWithAI(text, proposedSlots, params.profile.user.timezone);
    response = aiResult.response;
    suggestedAlternative = aiResult.suggestedAlternative;
    locationOverride = aiResult.locationOverride ?? undefined;
    if (aiResult.response === 'yes') {
      const idx = aiResult.slotIndex ?? 0;
      preferredSlot = proposedSlots[idx] ?? proposedSlots[0];
    }

    if (aiResult.preferOnline !== undefined || locationOverride) {
      try {
        const existingNotes = JSON.parse(job.notes ?? '{}');
        const updatedNotes: Record<string, unknown> = { ...existingNotes };
        if (aiResult.preferOnline !== undefined) updatedNotes.isOnline = aiResult.preferOnline;
        if (locationOverride) updatedNotes.location = locationOverride;
        updateCoordJob(job.id, { notes: JSON.stringify(updatedNotes) });
      } catch (_) {}
    }
  }

  logger.info('Coord reply parsed', {
    jobId: job.id,
    participant: participant.name,
    response,
    preferredSlot: preferredSlot ?? null,
    suggestedAlternative,
  });

  // ── Handle 'maybe' ─
  if (response === 'maybe' && suggestedAlternative) {
    response = 'no';
  }
  if (response === 'maybe') {
    await app.client.chat.postMessage({
      token: params.botToken,
      channel: params.channelId,
      text: `Thanks! Just to make sure I've got it right — could you pick a number (1, 2, or 3) for the options above? Or if none of those work, just tell me what times are better for you and I'll find something else.`,
    });
    await shadowNotify(app, params.profile, {
      channel: job.owner_channel,
      threadTs: job.owner_thread_ts ?? undefined,
      action: 'Reply received',
      detail: `${participant.name} replied to "${job.subject}" — response unclear, asked for clarification`,
    });
    return true;
  }

  // Pre-parse preference from suggestedAlternative
  let preParsedPreference: { searchFrom: string; searchTo: string; hoursStart: string; hoursEnd: string } | undefined;
  if (response === 'no' && suggestedAlternative) {
    preParsedPreference = await parseTimePreference(suggestedAlternative, params.profile.user.timezone);
  }

  // Update participant response
  const updatedParticipants = participants.map(p =>
    p.slack_id === params.senderId
      ? {
          ...p,
          response,
          preferred_slot: preferredSlot,
          responded_at: new Date().toISOString(),
          ...(suggestedAlternative ? { _suggestedAlternative: suggestedAlternative } : {}),
          ...(preParsedPreference ? { _preference: preParsedPreference } : {}),
        }
      : p
  );
  updateCoordJob(job.id, {
    participants: JSON.stringify(updatedParticipants),
    // Bug 1B — record the latest participant activity so the follow-up cron
    // can see this coord is still alive.
    last_participant_activity_at: new Date().toISOString(),
  });

  // Acknowledge
  const ackText = response === 'no'
    ? `Got it — I'll find some other options and come back to you.`
    : `Great, noted! I'll confirm once everyone responds.`;

  // If the participant replied inside the originating group DM thread, keep
  // the ack in that thread so it visually connects to the original request
  // rather than floating as a top-level message.
  const ackInThread = participant.contacted_via === 'group' && job.owner_channel === params.channelId;
  await app.client.chat.postMessage({
    token: params.botToken,
    channel: params.channelId,
    ...(ackInThread && job.owner_thread_ts ? { thread_ts: job.owner_thread_ts } : {}),
    text: ackText,
  });

  // Shadow
  const slotLabel = preferredSlot
    ? DateTime.fromISO(preferredSlot).setZone(params.profile.user.timezone).toFormat('EEE d MMM HH:mm')
    : 'no slot picked';
  const responseLabel = response === 'yes'
    ? `✓ ${slotLabel}`
    : `✗ can't make any slot${suggestedAlternative ? ` (suggested: "${suggestedAlternative}")` : ''}`;
  await shadowNotify(app, params.profile, {
    channel: job.owner_channel,
    threadTs: job.owner_thread_ts ?? undefined,
    action: 'Reply received',
    detail: `${participant.name} responded to "${job.subject}": ${responseLabel}`,
  });

  // Check if all KEY participants responded
  const keyParticipants = updatedParticipants.filter(p => !p.just_invite);
  const allResponded = keyParticipants.every(p => p.response !== null && p.response !== 'maybe');
  if (allResponded) {
    await resolveCoordination(app, job.id, params.profile, params.botToken);
  }

  return true;
}

// ── Resolve responses ─────────────────────────────────────────────────────────

export async function resolveCoordination(
  app: App,
  jobId: string,
  profile: UserProfile,
  botToken: string
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
    await bookCoordination(app, jobId, bestSlot, profile, botToken);
    return;
  }

  // ── Ping-pong negotiation: participants picked different slots ────────────
  // If no one said 'no' but they picked different specific slots, try ping-pong
  if (noResponders.length === 0 && bestCount < keyParticipants.length) {
    const specificVoters = keyParticipants.filter(p => p.response === 'yes' && p.preferred_slot);
    const uniqueSlots = [...new Set(specificVoters.map(p => p.preferred_slot!))];
    if (uniqueSlots.length > 1) {
      await startPingPong(app, job, specificVoters, participants, profile, botToken);
      return;
    }
  }

  // Round 1 conflict: ask "no" voters what times work
  if (!isRound2 && noResponders.length > 0) {
    await startRenegotiation(app, job, noResponders, participants, profile, botToken);
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
    await emitWaitingOwnerApproval(app, {
      job,
      kind: 'freeform',
      payload: { subject: job.subject, question: 'retry_with_new_slots', no_responders: finalNoResponders.map(p => p.name) },
      askText,
      botToken,
    });
    return;
  }

  if (finalNoResponders.length > 0) {
    const bestDt = DateTime.fromISO(bestSlot).setZone(profile.user.timezone);
    const askText = `After two rounds, ${bestDt.toFormat("EEEE, d MMMM 'at' HH:mm")} works for most people on "${job.subject}" — but ${finalNoResponders.map(p => p.name).join(' and ')} can't make it. Book anyway, or look for a new time?`;
    const participantsParsed = JSON.parse(job.participants) as CoordParticipant[];
    await emitWaitingOwnerApproval(app, {
      job,
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
      botToken,
      winningSlot: bestSlot,
    });
    return;
  }

  await bookCoordination(app, jobId, bestSlot, profile, botToken);
}

// ── Ping-pong negotiation ───────────────────────────────────────────────────

/**
 * When participants pick different slots: try converging on one of the chosen slots.
 * Start with the soonest, ask the holdout: "[Name] suggests [slot], can you do it?"
 */
async function startPingPong(
  app: App,
  job: CoordJob,
  specificVoters: CoordParticipant[],
  allParticipants: CoordParticipant[],
  profile: UserProfile,
  botToken: string,
): Promise<void> {
  // Sort chosen slots by time (soonest first)
  const uniqueSlots = [...new Set(specificVoters.map(p => p.preferred_slot!))];
  uniqueSlots.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  // Mark job as negotiating
  updateCoordJob(job.id, {
    status: 'negotiating',
    notes: JSON.stringify({
      ...JSON.parse(job.notes ?? '{}'),
      pingPongQueue: uniqueSlots,
      pingPongIndex: 0,
    }),
  });

  await tryNextPingPongSlot(app, job.id, profile, botToken);
}

/**
 * Try the next slot in the ping-pong queue.
 * Find who didn't pick this slot and ask them if it works.
 */
async function tryNextPingPongSlot(
  app: App,
  jobId: string,
  profile: UserProfile,
  botToken: string,
): Promise<void> {
  const job = getCoordJob(jobId);
  if (!job) return;

  const notes = JSON.parse(job.notes ?? '{}');
  const queue: string[] = notes.pingPongQueue ?? [];
  const index: number = notes.pingPongIndex ?? 0;

  if (index >= queue.length) {
    // All ping-pong slots exhausted — fall back to open-ended renegotiation
    const participants = JSON.parse(job.participants) as CoordParticipant[];
    const noResponders = participants.filter(p => !p.just_invite && p.response === 'no');
    if (noResponders.length > 0) {
      await startRenegotiation(app, job, noResponders, participants, profile, botToken);
    } else {
      await emitWaitingOwnerApproval(app, {
        job,
        kind: 'freeform',
        payload: { coord_job_id: job.id, subject: job.subject, question: 'no_slot_found_try_new_options' },
        askText: `I couldn't find a time that works for everyone on "${job.subject}". Want me to try different options?`,
        botToken,
      });
    }
    return;
  }

  const targetSlot = queue[index];
  const targetDt = DateTime.fromISO(targetSlot).setZone(profile.user.timezone);
  const participants = JSON.parse(job.participants) as CoordParticipant[];
  const keyParticipants = participants.filter(p => !p.just_invite);

  // Who picked this slot? Who didn't?
  const pickedThis = keyParticipants.filter(p => p.preferred_slot === targetSlot);
  const didntPickThis = keyParticipants.filter(p => p.preferred_slot !== targetSlot && p.response === 'yes');

  if (didntPickThis.length === 0) {
    // Everyone already picked this slot — book
    await bookCoordination(app, jobId, targetSlot, profile, botToken);
    return;
  }

  // Ask each holdout: "[name] suggests [time], can you do it?"
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
    proposed_slots: JSON.stringify([targetSlot]),  // Focus on this one slot
  });

  for (const holdout of didntPickThis) {
    if (!holdout.slack_id) continue;
    try {
      const dmResult = await app.client.conversations.open({ token: botToken, users: holdout.slack_id });
      const dmChannel = (dmResult.channel as any)?.id;
      if (!dmChannel) continue;

      const holdoutDt = DateTime.fromISO(targetSlot).setZone(holdout.tz);
      await app.client.chat.postMessage({
        token: botToken,
        channel: dmChannel,
        text: `${suggesterNames} suggested ${holdoutDt.toFormat("EEEE, d MMMM 'at' HH:mm")} for "${job.subject}" — can you make it?`,
      });
    } catch (err) {
      logger.warn('Could not send ping-pong DM', { err: String(err), participant: holdout.name });
    }
  }

  await shadowNotify(app, profile, {
    channel: job.owner_channel,
    threadTs: job.owner_thread_ts ?? undefined,
    action: 'Negotiating',
    detail: `Asking ${didntPickThis.map(p => p.name).join(', ')} if ${slotLabel} works (suggested by ${suggesterNames})`,
  });
}

// ── Renegotiation (open-ended: "what times work?") ──────────────────────────

async function startRenegotiation(
  app: App,
  job: CoordJob,
  noVoters: CoordParticipant[],
  allParticipants: CoordParticipant[],
  profile: UserProfile,
  botToken: string,
): Promise<void> {
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
    try {
      await app.client.chat.postMessage({
        token: botToken,
        channel,
        thread_ts: threadTs,
        text:
          `${mentions} — none of the times I suggested for "${job.subject}" worked for you. ` +
          `What times work best? For example: "mornings", "Tuesday afternoon", or "any time Thursday". ` +
          `I'll find something that fits and check with the others.`,
      });
    } catch (err) {
      logger.warn('Could not post renegotiation in group thread', { err: String(err) });
    }
  }

  for (const p of privateDmFollowUp) {
    if (!p.slack_id) continue;
    try {
      const dmResult = await app.client.conversations.open({ token: botToken, users: p.slack_id });
      const dmChannel = (dmResult.channel as any)?.id;
      if (!dmChannel) continue;
      await app.client.chat.postMessage({
        token: botToken,
        channel: dmChannel,
        text:
          `Hi ${p.name}, none of the options I proposed for "${job.subject}" worked for you — ` +
          `what times work best for you? For example: "mornings", "Tuesday afternoon", or "any time Thursday". ` +
          `I'll find something that fits and check with the others.`,
      });
    } catch (err) {
      logger.warn('Could not send renegotiation DM', { err: String(err), participant: p.name });
    }
  }

  await shadowNotify(app, profile, {
    channel: job.owner_channel,
    threadTs: job.owner_thread_ts ?? undefined,
    action: 'Renegotiating',
    detail: noVoters.map(p => p.name).join(', ') + ' — asking what times work',
  });

  // If ALL no-voters already had preferences — skip waiting, go straight to round 2
  if (needsFollowUp.length === 0) {
    await triggerRoundTwo(app, job, updated, profile, botToken);
  }
}

/**
 * Use Haiku to parse a free-text time preference into a concrete search window.
 */
async function parseTimePreference(
  text: string,
  timezone: string,
): Promise<{ searchFrom: string; searchTo: string; hoursStart: string; hoursEnd: string }> {
  const today = DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd');
  const nextWeek = DateTime.now().setZone(timezone).plus({ days: 7 }).toFormat('yyyy-MM-dd');
  try {
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system:
        `Today is ${today} (timezone: ${timezone}). ` +
        `Parse this scheduling preference into a search window.\n` +
        `Reply with JSON only — no other text:\n` +
        `{"searchFrom":"YYYY-MM-DD","searchTo":"YYYY-MM-DD","hoursStart":"HH:MM","hoursEnd":"HH:MM"}\n\n` +
        `Rules:\n` +
        `- "morning" = 08:00-12:00, "afternoon" = 13:00-17:00, "evening" = 17:00-20:00\n` +
        `- If a specific day is named, use that day for both from and to\n` +
        `- If no day specified, use today through ${nextWeek}\n` +
        `- Default hours (no preference stated): 09:00-18:00`,
      messages: [{ role: 'user', content: text }],
    });
    const raw = ((result.content[0] as Anthropic.TextBlock).text ?? '').trim();
    const parsed = JSON.parse(raw);
    return {
      searchFrom: parsed.searchFrom ?? today,
      searchTo: parsed.searchTo ?? nextWeek,
      hoursStart: parsed.hoursStart ?? '09:00',
      hoursEnd: parsed.hoursEnd ?? '18:00',
    };
  } catch {
    return { searchFrom: today, searchTo: nextWeek, hoursStart: '09:00', hoursEnd: '18:00' };
  }
}

async function handlePreferenceReply(
  app: App,
  job: CoordJob,
  participant: CoordParticipant,
  text: string,
  profile: UserProfile,
  botToken: string,
): Promise<void> {
  const window = await parseTimePreference(text, profile.user.timezone);

  const allParticipants = JSON.parse(job.participants) as CoordParticipant[];
  const updated = allParticipants.map(p =>
    p.slack_id === participant.slack_id
      ? { ...p, _awaiting_preference: false, _preference: window, response: 'yes' as const, preferred_slot: undefined, responded_at: new Date().toISOString() }
      : p
  );
  updateCoordJob(job.id, { participants: JSON.stringify(updated) });

  if (participant.contacted_via === 'group' && participant.group_channel && participant.group_thread_ts) {
    await app.client.chat.postMessage({
      token: botToken,
      channel: participant.group_channel,
      thread_ts: participant.group_thread_ts,
      text: `Got it ${participant.name} — I'll find some options that work for you and check with the others.`,
    });
  } else {
    const dmResult = await app.client.conversations.open({ token: botToken, users: participant.slack_id! });
    const dmChannel = (dmResult.channel as any)?.id;
    if (dmChannel) {
      await app.client.chat.postMessage({
        token: botToken,
        channel: dmChannel,
        text: `Got it — I'll find some options that work for you and check with the others.`,
      });
    }
  }

  const stillWaiting = updated.filter(p => !p.just_invite && (p as any)._awaiting_preference === true);
  if (stillWaiting.length > 0) {
    await shadowNotify(app, profile, {
      channel: job.owner_channel,
      threadTs: job.owner_thread_ts ?? undefined,
      action: 'Preference received',
      detail: `${participant.name} said they prefer ${text} — still waiting for ${stillWaiting.map(p => p.name).join(', ')}`,
    });
    return;
  }

  await triggerRoundTwo(app, job, updated, profile, botToken);
}

async function triggerRoundTwo(
  app: App,
  job: CoordJob,
  allParticipants: CoordParticipant[],
  profile: UserProfile,
  botToken: string,
): Promise<void> {
  const keyParticipants = allParticipants.filter(p => !p.just_invite);
  const preferenceGivers = keyParticipants.filter(p => (p as any)._preference);

  const windows = preferenceGivers.map(p => (p as any)._preference as { searchFrom: string; searchTo: string; hoursStart: string; hoursEnd: string });
  const searchFrom = windows.reduce((latest, w) => w.searchFrom > latest ? w.searchFrom : latest, windows[0].searchFrom);
  const searchTo = windows.reduce((earliest, w) => w.searchTo < earliest ? w.searchTo : earliest, windows[0].searchTo);
  const hoursStart = windows.reduce((latest, w) => w.hoursStart > latest ? w.hoursStart : latest, windows[0].hoursStart);
  const hoursEnd = windows.reduce((earliest, w) => w.hoursEnd < earliest ? w.hoursEnd : earliest, windows[0].hoursEnd);

  if (searchFrom > searchTo || hoursStart >= hoursEnd) {
    const names = preferenceGivers.map(p => p.name).join(' and ');
    await emitWaitingOwnerApproval(app, {
      job,
      kind: 'freeform',
      payload: { coord_job_id: job.id, subject: job.subject, question: 'conflicting_preferences', names },
      askText: `I couldn't find overlapping availability for "${job.subject}" — ${names} have conflicting time preferences. Want to handle this differently?`,
      botToken,
    });
    return;
  }

  const allWorkDays = [
    ...profile.schedule.office_days.days,
    ...profile.schedule.home_days.days,
  ] as string[];

  let newSlots: Array<{ start: string; end: string }> = [];
  try {
    newSlots = await findAvailableSlots({
      userEmail: profile.user.email,
      timezone: profile.user.timezone,
      durationMinutes: job.duration_min,
      attendeeEmails: [],
      searchFrom: `${searchFrom}T${hoursStart}:00`,
      searchTo: `${searchTo}T${hoursEnd}:00`,
      workDays: allWorkDays,
      workHoursStart: hoursStart,
      workHoursEnd: hoursEnd,
      meetingMode: 'either',  // coord renegotiation — location determined later
      autoExpand: false,
    });
  } catch (err) {
    logger.error('Failed to find slots for round 2', { err });
  }

  if (newSlots.length === 0) {
    await emitWaitingOwnerApproval(app, {
      job,
      kind: 'freeform',
      payload: { coord_job_id: job.id, subject: job.subject, question: 'no_slots_within_preferences' },
      askText: `No available slots found for "${job.subject}" within the preferences given. Want me to try different times?`,
      botToken,
    });
    return;
  }

  const chosenSlots = pickSpreadSlots(newSlots, profile.user.timezone, 3);

  // Determine location per new slot
  const ownerDomain = profile.user.email.split('@')[1];
  const isInternal = allParticipants.every(p =>
    !p.email || p.email.endsWith(`@${ownerDomain}`)
  );
  const totalPeople = allParticipants.length + 1; // +1 for owner

  const slotsWithLocation: SlotWithLocation[] = chosenSlots.map(slotStart => {
    const loc = determineSlotLocation(slotStart, profile, totalPeople, isInternal);
    return {
      start: slotStart,
      end: DateTime.fromISO(slotStart).plus({ minutes: job.duration_min }).toISO()!,
      location: loc.location,
      isOnline: loc.isOnline,
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

  // Store slot metadata in notes
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

  // In-group re-voters
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
    try {
      await app.client.chat.postMessage({
        token: botToken,
        channel,
        thread_ts: threadTs,
        text:
          `${mentions} — ${preferenceNames} can do other times, so here are new options for "${job.subject}":\n${displaySlots}\n\nDo any of these work? Reply with the number.`,
      });
    } catch (err) {
      logger.warn('Could not post round-2 in group thread', { err: String(err) });
    }
  }

  for (const p of privateDmReVoters) {
    if (!p.slack_id) continue;
    try {
      const dmResult = await app.client.conversations.open({ token: botToken, users: p.slack_id });
      const dmChannel = (dmResult.channel as any)?.id;
      if (!dmChannel) continue;
      const slotLines = slotsWithLocation.map((s, i) => {
        const dt = DateTime.fromISO(s.start).setZone(p.tz);
        const locLabel = s.location ? ` — ${s.location}` : '';
        return `${i + 1}. ${dt.toFormat('EEEE, d MMMM')} at ${dt.toFormat('HH:mm')}${locLabel}`;
      }).join('\n');
      await app.client.chat.postMessage({
        token: botToken,
        channel: dmChannel,
        text:
          `Hi ${p.name}, ${preferenceNames} can do other times, so here are new options for "${job.subject}":\n${slotLines}\n\nDo any of these work? Reply with the number.`,
      });
    } catch (err) {
      logger.warn('Could not send round-2 DM', { err: String(err), participant: p.name });
    }
  }

  await shadowNotify(app, profile, {
    channel: job.owner_channel,
    threadTs: job.owner_thread_ts ?? undefined,
    action: 'Round 2 started',
    detail: `New slots found within ${preferenceNames}'s window — re-asking ${reVoters.map(p => p.name).join(', ')}`,
  });
}

