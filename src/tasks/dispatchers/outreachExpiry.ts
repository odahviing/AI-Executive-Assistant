import { DateTime } from 'luxon';
import { completeTask, createTask, updateTask } from '../index';
import { getDb, updateOutreachJob } from '../../db';
import { calcResponseDeadline } from '../../connectors/slack/coordinator';
import { isWithinOwnerWorkHours, nextOwnerWorkdayStart, addWorkdays } from '../../utils/workHours';
import { getConnection } from '../../connections/registry';
import type { TaskDispatcher } from './types';
import logger from '../../utils/logger';

/**
 * Reply deadline reached. On first expiry: send one follow-up, re-queue
 * +3 work-hours. On second expiry: mark no_response, notify owner.
 */
export const dispatchOutreachExpiry: TaskDispatcher = async (_app, task, profile) => {
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) {
    logger.warn('dispatchOutreachExpiry — no Slack connection registered', { profileId: profile.user.slack_user_id });
    updateTask(task.id, { status: 'failed' });
    return;
  }

  if (!task.skill_ref) {
    updateTask(task.id, { status: 'failed' });
    return;
  }
  const job = getDb().prepare(
    `SELECT * FROM outreach_jobs WHERE id = ?`
  ).get(task.skill_ref) as any;
  if (!job) {
    logger.warn('outreach_expiry — outreach_jobs missing', { taskId: task.id });
    updateTask(task.id, { status: 'failed' });
    return;
  }
  if (job.status !== 'sent' && job.status !== 'no_response') {
    logger.info('outreach_expiry — outreach moved past waiting state, skipping', {
      taskId: task.id,
      outreachId: job.id,
      status: job.status,
    });
    completeTask(task.id);
    return;
  }

  const attempts = job.attempts ?? 0;
  if (job.await_reply === 1 && attempts < 1) {
    // First expiry — send one follow-up, re-schedule the expiry +3h
    try {
      await conn.sendDirect(
        job.colleague_slack_id,
        `Hi ${job.colleague_name}, just following up on my earlier message. Whenever you get a chance, no rush!`,
      );
      const newDeadline = calcResponseDeadline(job.colleague_tz ?? profile.user.timezone);
      updateOutreachJob(job.id, { reply_deadline: newDeadline, attempts: 1 } as any);
      createTask({
        owner_user_id: job.owner_user_id,
        owner_channel: job.owner_channel,
        owner_thread_ts: job.owner_thread_ts,
        type: 'outreach_expiry',
        status: 'new',
        title: `Final check on ${job.colleague_name}'s reply`,
        due_at: newDeadline,
        skill_ref: job.id,
        context: JSON.stringify({ outreach_id: job.id, attempt: 2 }),
        who_requested: 'system',
        skill_origin: 'outreach',
      });
      completeTask(task.id);
      logger.info('outreach_expiry — first nudge sent, re-queued', {
        taskId: task.id,
        outreachId: job.id,
        colleague: job.colleague_name,
        newDeadline,
      });
      return;
    } catch (err) {
      logger.warn('outreach_expiry — follow-up send failed, falling through to no_response', { err: String(err) });
    }
  }

  // v1.8.0 — quiet-hours respect. If now is outside the OWNER's defined
  // work hours (per profile.schedule.office_days/home_days), defer the
  // owner-facing notification to the next workday morning. The expiry
  // deadline is set in COLLEAGUE timezone so it can fire at any hour for
  // the owner; we don't want to DM the owner at 3am about a colleague who
  // didn't reply — wait until the owner is actually working.
  // Critically: do NOT mark the job as no_response yet, so a colleague
  // reply between now and morning still cancels this expiry naturally.
  const ownerNow = DateTime.now().setZone(profile.user.timezone);
  if (!isWithinOwnerWorkHours(profile, ownerNow)) {
    const deferredAt = nextOwnerWorkdayStart(profile);
    createTask({
      owner_user_id: job.owner_user_id,
      owner_channel: job.owner_channel,
      owner_thread_ts: job.owner_thread_ts,
      type: 'outreach_expiry',
      status: 'new',
      title: `Final check on ${job.colleague_name}'s reply (deferred to your work hours)`,
      due_at: deferredAt,
      skill_ref: job.id,
      context: JSON.stringify({ outreach_id: job.id, attempt: 2, deferred_from: ownerNow.toISO() }),
      who_requested: 'system',
      skill_origin: 'outreach',
    });
    completeTask(task.id);
    logger.info('outreach_expiry — deferred owner notification (outside work hours)', {
      taskId: task.id,
      outreachId: job.id,
      colleague: job.colleague_name,
      ownerLocalNow: ownerNow.toFormat("EEE HH:mm"),
      deferredUntil: deferredAt,
    });
    return;
  }

  // In owner work hours — mark no_response and notify now.
  updateOutreachJob(job.id, { status: 'no_response' });
  getDb().prepare(
    `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
     WHERE skill_ref = ? AND type = 'outreach' AND status IN ('new','in_progress','pending_colleague')`
  ).run(job.id);

  const colleagueDt = DateTime.now().setZone(job.colleague_tz ?? 'UTC');
  const hour = colleagueDt.hour;
  const timeCtx = hour >= 22 || hour < 6
    ? `it's ${colleagueDt.toFormat('HH:mm')} for them so they're likely asleep`
    : hour < 9
    ? `it's early morning for them (${colleagueDt.toFormat('HH:mm')})`
    : `their time is ${colleagueDt.toFormat('HH:mm')}`;
  await conn.postToChannel(
    job.owner_channel,
    `${job.colleague_name} hasn't replied, I followed up once (${timeCtx}). Want me to try again or leave it?`,
    { threadTs: job.owner_thread_ts ?? undefined },
  );

  // v2.0.7 — schedule the owner-silence tombstone. If the owner doesn't
  // reply to the "try again or leave it?" DM within 2 owner-workdays, the
  // outreach_decision dispatcher will auto-close the job (done) with a
  // shadow DM so it stops re-surfacing in the morning brief. Workday math
  // skips Friday/Saturday — asking on Thursday 12:00 fires Monday 12:00,
  // asking on Saturday 12:00 fires Tuesday 12:00.
  try {
    const decisionDueAt = addWorkdays(DateTime.now().toUTC().toISO()!, 2, profile);
    createTask({
      owner_user_id: job.owner_user_id,
      owner_channel: job.owner_channel,
      owner_thread_ts: job.owner_thread_ts,
      type: 'outreach_decision',
      status: 'new',
      title: `Auto-close ${job.colleague_name}'s stuck outreach if still silent`,
      due_at: decisionDueAt,
      skill_ref: job.id,
      context: JSON.stringify({ outreach_id: job.id, reason: 'no_response_timeout_2_workdays' }),
      who_requested: 'system',
      skill_origin: 'outreach',
    });
    logger.info('outreach_expiry — scheduled outreach_decision tombstone', {
      outreachId: job.id, colleague: job.colleague_name, decisionDueAt,
    });
  } catch (err) {
    logger.warn('outreach_expiry — failed to schedule outreach_decision, non-fatal', {
      err: String(err), outreachId: job.id,
    });
  }

  completeTask(task.id);
  logger.info('outreach_expiry — marked no_response', {
    taskId: task.id,
    outreachId: job.id,
    colleague: job.colleague_name,
  });
};
