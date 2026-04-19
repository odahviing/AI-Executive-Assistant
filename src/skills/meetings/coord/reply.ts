/**
 * Coord reply handling.
 *
 * Ported from connectors/slack/coord.ts (issue #1 sub-phase D5).
 * Handles incoming participant replies:
 *   - Out-of-thread disambiguation (Sonnet context classifier)
 *   - Follow-up on a waiting_owner job (ack + relay to owner)
 *   - Preference replies ("mornings", "Tuesday PM") via parseTimePreference
 *   - Normal slot picks (regex + AI fallback)
 *
 * Calls into state.ts for resolveCoordination / triggerRoundTwo once input
 * is recorded.
 */

import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import type { UserProfile } from '../../../config/userProfile';
import { config } from '../../../config';
import {
  updateCoordJob,
  getCoordJobsByParticipant,
  type CoordParticipant,
  type CoordJob,
} from '../../../db';
import { shadowNotify } from '../../../utils/shadowNotify';
import { getConnection } from '../../../connections/registry';
import { interpretReplyWithAI, isCoordReplyByContext } from './utils';
import { resolveCoordination, triggerRoundTwo } from './state';
import logger from '../../../utils/logger';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/**
 * Handles a coordination reply. Supports in-thread replies and out-of-thread
 * replies (falls back to Sonnet context check when the sender has active coord
 * jobs). Disambiguates if multiple jobs match.
 */
export async function handleCoordReply(
  params: {
    senderId: string;
    text: string;
    channelId: string;
    threadTs?: string;
    profile: UserProfile;
  }
): Promise<boolean> {
  const slackConn = getConnection(params.profile.user.slack_user_id, 'slack');
  if (!slackConn) {
    logger.error('handleCoordReply — no Slack connection registered');
    return false;
  }

  const allJobs = getCoordJobsByParticipant(params.senderId, params.profile.user.slack_user_id);
  if (allJobs.length === 0) return false;

  // ── Thread-boundary fast-path ─────────────────────────────────────────────
  // If a coord was initiated in a group DM / channel (C-prefix owner_channel)
  // and this new message arrived in a different channel (e.g. participant's
  // 1:1 DM with Maelle), it's not a reply to that coord — it's a new request.
  const jobs = allJobs.filter(j => {
    const coordIsGroup = j.owner_channel?.startsWith('C');
    if (!coordIsGroup) return true;
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

  const namesFor = (j: CoordJob): string[] => {
    try {
      const parts = JSON.parse(j.participants) as CoordParticipant[];
      return parts.map(p => p.name).filter(Boolean);
    } catch { return []; }
  };

  let job: CoordJob;

  if (jobs.length === 1) {
    const isRelevant = await isCoordReplyByContext(params.text, jobs[0].subject, namesFor(jobs[0]));
    if (!isRelevant) return false;
    job = jobs[0];
  } else {
    for (const j of jobs) {
      const isRelevant = await isCoordReplyByContext(params.text, j.subject, namesFor(j));
      if (isRelevant) {
        job = j;
        break;
      }
    }
    if (!job!) {
      const subjects = jobs.map((j, i) => `${i + 1}. "${j.subject}"`).join('\n');
      await slackConn.postToChannel(
        params.channelId,
        `I have a few open scheduling threads with you — which one is this about?\n${subjects}`,
        { threadTs: params.threadTs },
      );
      return true;
    }
  }

  const participants = JSON.parse(job.participants) as CoordParticipant[];
  const proposedSlots = JSON.parse(job.proposed_slots) as string[];
  const participant = participants.find(p => p.slack_id === params.senderId);
  if (!participant) return false;

  logger.info('Coord reply received', { jobId: job.id, from: participant.name });

  // ── Follow-up on a waiting_owner job ────────────────────────────────────
  if (job.status === 'waiting_owner' && participant.response !== null) {
    const ackInThread = participant.contacted_via === 'group' && job.owner_channel === params.channelId;
    await slackConn.postToChannel(params.channelId, `Thanks! I'll pass that along.`, {
      threadTs: ackInThread ? (job.owner_thread_ts ?? undefined) : undefined,
    });
    await shadowNotify(params.profile, {
      channel: job.owner_channel,
      threadTs: job.owner_thread_ts ?? undefined,
      action: 'Follow-up received',
      detail: `${participant.name} followed up on "${job.subject}": "${params.text.trim()}"`,
    });
    return true;
  }

  // ── Preference reply: they were asked "what times work for you?" ─
  if ((participant as any)._awaiting_preference) {
    await handlePreferenceReply(job, participant, params.text.trim(), params.profile);
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
    await slackConn.postToChannel(
      params.channelId,
      `Thanks! Just to make sure I've got it right — could you pick a number (1, 2, or 3) for the options above? Or if none of those work, just tell me what times are better for you and I'll find something else.`,
      { threadTs: params.threadTs },
    );
    await shadowNotify(params.profile, {
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
    last_participant_activity_at: new Date().toISOString(),
  });

  // Acknowledge
  const ackText = response === 'no'
    ? `Got it — I'll find some other options and come back to you.`
    : `Great, noted! I'll confirm once everyone responds.`;

  const ackInThread = participant.contacted_via === 'group' && job.owner_channel === params.channelId;
  await slackConn.postToChannel(params.channelId, ackText, {
    threadTs: ackInThread ? (job.owner_thread_ts ?? undefined) : undefined,
  });

  // Shadow
  const slotLabel = preferredSlot
    ? DateTime.fromISO(preferredSlot).setZone(params.profile.user.timezone).toFormat('EEE d MMM HH:mm')
    : 'no slot picked';
  const responseLabel = response === 'yes'
    ? `✓ ${slotLabel}`
    : `✗ can't make any slot${suggestedAlternative ? ` (suggested: "${suggestedAlternative}")` : ''}`;
  await shadowNotify(params.profile, {
    channel: job.owner_channel,
    threadTs: job.owner_thread_ts ?? undefined,
    action: 'Reply received',
    detail: `${participant.name} responded to "${job.subject}": ${responseLabel}`,
  });

  // Check if all KEY participants responded
  const keyParticipants = updatedParticipants.filter(p => !p.just_invite);
  const allResponded = keyParticipants.every(p => p.response !== null && p.response !== 'maybe');
  if (allResponded) {
    await resolveCoordination(job.id, params.profile);
  }

  return true;
}

/**
 * Use Sonnet to parse a free-text time preference into a concrete search window.
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
  job: CoordJob,
  participant: CoordParticipant,
  text: string,
  profile: UserProfile,
): Promise<void> {
  const slackConn = getConnection(profile.user.slack_user_id, 'slack');
  if (!slackConn) {
    logger.error('handlePreferenceReply — no Slack connection registered');
    return;
  }

  const window = await parseTimePreference(text, profile.user.timezone);

  const allParticipants = JSON.parse(job.participants) as CoordParticipant[];
  const updated = allParticipants.map(p =>
    p.slack_id === participant.slack_id
      ? { ...p, _awaiting_preference: false, _preference: window, response: 'yes' as const, preferred_slot: undefined, responded_at: new Date().toISOString() }
      : p
  );
  updateCoordJob(job.id, { participants: JSON.stringify(updated) });

  if (participant.contacted_via === 'group' && participant.group_channel && participant.group_thread_ts) {
    await slackConn.postToChannel(
      participant.group_channel,
      `Got it ${participant.name} — I'll find some options that work for you and check with the others.`,
      { threadTs: participant.group_thread_ts },
    );
  } else if (participant.slack_id) {
    await slackConn.sendDirect(
      participant.slack_id,
      `Got it — I'll find some options that work for you and check with the others.`,
    );
  }

  const stillWaiting = updated.filter(p => !p.just_invite && (p as any)._awaiting_preference === true);
  if (stillWaiting.length > 0) {
    await shadowNotify(profile, {
      channel: job.owner_channel,
      threadTs: job.owner_thread_ts ?? undefined,
      action: 'Preference received',
      detail: `${participant.name} said they prefer ${text} — still waiting for ${stillWaiting.map(p => p.name).join(', ')}`,
    });
    return;
  }

  await triggerRoundTwo(job, updated, profile);
}
