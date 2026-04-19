import { DateTime } from 'luxon';
import { completeTask, createTask, updateTask } from '../index';
import { getCoordJob, updateCoordJob, type CoordParticipant } from '../../db';
import { getConnection } from '../../connections/registry';
import { isWithinOwnerWorkHours, nextOwnerWorkdayStart } from '../../utils/workHours';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

/**
 * 24-work-hour nudge: DM non-responders once, then schedule coord_abandon
 * at +4h from now.
 *
 * Respects owner work hours — if the due_at falls outside the owner's
 * schedule (weekend, evening), re-queues the task for the next workday
 * morning. The nudge DM goes to *colleagues*, but firing it at 3am Saturday
 * still produces a Saturday-morning coord_abandon and owner notification,
 * which the owner shouldn't be woken for.
 */
export const dispatchCoordNudge: TaskDispatcher = async (_app, task, profile) => {
  if (!task.skill_ref) { updateTask(task.id, { status: 'failed' }); return; }
  const job = getCoordJob(task.skill_ref);
  if (!job) {
    logger.warn('coord_nudge — coord_job missing', { taskId: task.id });
    updateTask(task.id, { status: 'failed' });
    return;
  }
  if (job.status !== 'collecting' && job.status !== 'negotiating') {
    logger.info('coord_nudge — coord no longer needs nudge, skipping', {
      taskId: task.id,
      coordId: job.id,
      status: job.status,
    });
    completeTask(task.id);
    return;
  }

  // Defer to next work window if current time is outside owner work hours.
  const ownerNow = DateTime.now().setZone(profile.user.timezone);
  if (!isWithinOwnerWorkHours(profile, ownerNow)) {
    const deferredAt = nextOwnerWorkdayStart(profile);
    logger.info('coord_nudge — outside owner work hours; deferring', {
      taskId: task.id,
      coordId: job.id,
      now: ownerNow.toISO(),
      deferredAt,
    });
    updateTask(task.id, { due_at: deferredAt });
    return; // task stays 'new' at new due_at — runner will pick it up then
  }

  const participants = JSON.parse(job.participants) as CoordParticipant[];
  const nonResponders = participants.filter(p =>
    !p.just_invite &&
    p.dm_sent_at &&
    (p.response === null || p.response === undefined),
  );
  if (nonResponders.length === 0) {
    logger.info('coord_nudge — all key participants have responded, nothing to do', { taskId: task.id });
    completeTask(task.id);
    return;
  }

  const slackConn = getConnection(profile.user.slack_user_id, 'slack');
  if (!slackConn) {
    logger.error('coord_nudge — no Slack connection registered', { taskId: task.id });
    updateTask(task.id, { status: 'failed' });
    return;
  }
  for (const p of nonResponders) {
    if (!p.slack_id) continue;
    const res = await slackConn.sendDirect(
      p.slack_id,
      `Hi ${p.name}, gentle nudge about "${job.subject}" — let me know when you get a chance.`,
    );
    if (!res.ok) {
      logger.warn('coord_nudge — DM failed for participant', { reason: res.reason, detail: res.detail, participant: p.name });
    }
  }
  updateCoordJob(job.id, { follow_up_sent_at: new Date().toISOString() });

  // Schedule the abandon check +4h from now
  const abandonAt = DateTime.now().plus({ hours: 4 }).toUTC().toISO()!;
  createTask({
    owner_user_id: job.owner_user_id,
    owner_channel: job.owner_channel,
    owner_thread_ts: job.owner_thread_ts,
    type: 'coord_abandon',
    status: 'new',
    title: `Close "${job.subject}" if still unanswered`,
    due_at: abandonAt,
    skill_ref: job.id,
    context: JSON.stringify({ coord_job_id: job.id }),
    who_requested: 'system',
    skill_origin: 'meetings',
  });
  completeTask(task.id);
  logger.info('coord_nudge sent and abandon scheduled', {
    taskId: task.id,
    coordId: job.id,
    nudged: nonResponders.map(p => p.name),
    abandonAt,
  });
};
