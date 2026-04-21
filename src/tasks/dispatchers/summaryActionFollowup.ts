/**
 * summary_action_followup dispatcher (v1.7.2).
 *
 * At due_at, Maelle DMs the assignee asking for a status update on a meeting
 * action item. The DM is sent via the OutreachCoreSkill flow (creates an
 * outreach_jobs row with await_reply=true) so the colleague's reply naturally
 * routes back to the owner via the existing handleOutreachReply pipeline.
 *
 * Task context shape:
 * {
 *   summary_session_id: number,
 *   target_slack_id:    string,
 *   target_name:        string,
 *   action_description: string,
 *   meeting_subject:    string,
 *   target_language?:   'en' | 'he' | undefined,  // hint from people_memory
 * }
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { completeTask, createTask, updateTask } from '../index';
import {
  createOutreachJob,
  getPersonMemory,
} from '../../db';
import { calcResponseDeadline } from '../../connectors/slack/coordinator';
import { getConnection } from '../../connections/registry';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

interface FollowupContext {
  summary_session_id?: number;
  target_slack_id: string;
  target_name: string;
  action_description: string;
  meeting_subject?: string;
  target_language?: string;
}

/**
 * Compose a one-line check-in DM in Maelle's voice. Sonnet handles language
 * (defaults to English; uses Hebrew if the target's language preference is
 * known to be Hebrew via people_memory).
 */
async function composeFollowupMessage(params: {
  ownerFirstName: string;
  assistantName: string;
  targetName: string;
  actionDescription: string;
  meetingSubject?: string;
  targetLanguage?: string;
}): Promise<string> {
  const langHint = params.targetLanguage
    ? `Their preferred language: ${params.targetLanguage}. Reply in that language.`
    : 'Reply in English.';

  const prompt = `You are ${params.assistantName}, ${params.ownerFirstName}'s personal executive assistant. Write a SHORT, warm Slack DM to ${params.targetName} checking in on something they committed to.

What they committed to: "${params.actionDescription}"
${params.meetingSubject ? `Mentioned in the "${params.meetingSubject}" meeting.` : ''}
${langHint}

Constraints:
- ONE sentence, two at most. Casual, human, not robotic.
- Do not introduce yourself ("Hi, I'm Maelle") — they know you.
- Do not mention "task", "follow-up", "deadline", or "tracking system".
- Do not say "${params.ownerFirstName} asked me to check" — say it as your own friendly check-in.
- Phrasing like "just checking in", "wanted to see how you're doing on", "any update on" works well.
- End with a question mark or a soft prompt for response.

Output ONLY the DM text — no quotes, no preamble, no explanation.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = ((resp.content[0] as Anthropic.TextBlock).text ?? '').trim();
    if (text.length < 5) throw new Error('empty response');
    return text;
  } catch (err) {
    logger.warn('summary_action_followup: Sonnet compose failed, using template fallback', { err: String(err) });
    // Safe fallback — generic and friendly enough for any case
    return `Hey ${params.targetName.split(' ')[0]}, just checking in — were you able to ${params.actionDescription}?`;
  }
}

export const dispatchSummaryActionFollowup: TaskDispatcher = async (_app, task, profile) => {
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) {
    logger.warn('dispatchSummaryActionFollowup — no Slack connection registered', { profileId: profile.user.slack_user_id });
    updateTask(task.id, { status: 'failed' });
    return;
  }
  const ctx = (() => {
    try { return JSON.parse(task.context || '{}') as FollowupContext; }
    catch { return null; }
  })();

  if (!ctx || !ctx.target_slack_id || !ctx.target_name || !ctx.action_description) {
    logger.warn('summary_action_followup: invalid context', { taskId: task.id, ctx });
    updateTask(task.id, { status: 'failed' });
    return;
  }

  // Pull target's language preference from people_memory if available
  const person = getPersonMemory(ctx.target_slack_id);
  let targetLanguage: string | undefined = ctx.target_language;
  let targetTz: string | undefined;
  try {
    const profileJson = person?.profile_json ? JSON.parse(person.profile_json) : {};
    targetLanguage = targetLanguage ?? profileJson.language_preference;
    targetTz = person?.timezone ?? undefined;
  } catch (_) {}

  // Compose message
  const message = await composeFollowupMessage({
    ownerFirstName: profile.user.name.split(' ')[0],
    assistantName: profile.assistant.name,
    targetName: ctx.target_name,
    actionDescription: ctx.action_description,
    meetingSubject: ctx.meeting_subject,
    targetLanguage,
  });

  // Send via the Connection (no outreach_jobs side effect from the send itself)
  const sendResult = await conn.sendDirect(ctx.target_slack_id, message);
  if (!sendResult.ok) {
    logger.error('summary_action_followup: send failed', {
      taskId: task.id,
      target: ctx.target_slack_id,
      reason: sendResult.reason,
      detail: sendResult.detail,
    });
    // Tell owner it failed so they can chase manually
    try {
      await conn.postToChannel(
        task.owner_channel,
        `I tried to check in with ${ctx.target_name} about "${ctx.action_description}" but the DM didn't go through (${sendResult.reason}). Want to follow up directly?`,
        { threadTs: task.owner_thread_ts ?? undefined },
      );
    } catch (_) {}
    updateTask(task.id, { status: 'failed' });
    return;
  }

  // Create the outreach_jobs row so the colleague's REPLY routes back through
  // handleOutreachReply → owner DM. Without this, the reply would look like
  // an unsolicited inbound message and not be linked to the action item.
  const deadline = calcResponseDeadline(targetTz ?? profile.user.timezone);
  const outreachJobId = createOutreachJob({
    owner_user_id: task.owner_user_id,
    owner_channel: task.owner_channel,
    owner_thread_ts: task.owner_thread_ts,
    colleague_slack_id: ctx.target_slack_id,
    colleague_name: ctx.target_name,
    colleague_tz: targetTz,
    message,
    await_reply: 1,
    status: 'sent',
    sent_at: new Date().toISOString(),
    reply_deadline: deadline,
  });

  // Queue an outreach_expiry for graceful no-reply handling (existing pattern)
  createTask({
    owner_user_id: task.owner_user_id,
    owner_channel: task.owner_channel,
    owner_thread_ts: task.owner_thread_ts,
    type: 'outreach_expiry',
    status: 'new',
    title: `Check reply deadline from ${ctx.target_name}`,
    due_at: deadline,
    skill_ref: outreachJobId,
    context: JSON.stringify({ outreach_id: outreachJobId, summary_session_id: ctx.summary_session_id }),
    who_requested: 'system',
    skill_origin: 'summary',
  });

  logger.info('summary_action_followup dispatched', {
    taskId: task.id,
    target: ctx.target_name,
    targetSlackId: ctx.target_slack_id,
    targetTz: targetTz ?? '(owner-tz fallback)',
    outreachJobId,
    summarySessionId: ctx.summary_session_id,
    skill_origin: 'summary',
  });

  completeTask(task.id);
};
