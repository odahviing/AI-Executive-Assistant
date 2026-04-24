/**
 * Social weekly decay dispatcher (v2.2).
 *
 * Runs once per week per owner. Walks every active topic for that owner and
 * subtracts 1 from topics whose `last_touched_at` is more than 7 days old.
 * Topics hitting score 0 flip status to 'dormant' — Maelle stops raising
 * them, but the row stays (owner can still revive by re-mentioning, and
 * category-level memory retains "yes, we've talked about X before").
 *
 * Self-rescheduling: at the end of the run the dispatcher inserts the NEXT
 * social_decay task 7 days out, so the cadence perpetuates without a
 * separate cron setup. No DM to the owner — silent maintenance.
 */

import { DateTime } from 'luxon';
import { completeTask, createTask } from '../index';
import { runWeeklyDecay } from '../../db/socialTopics';
import logger from '../../utils/logger';
import type { TaskDispatcher } from './types';

export const dispatchSocialDecay: TaskDispatcher = async (_app, task, profile) => {
  try {
    const { decayed, dormantFlipped } = runWeeklyDecay(profile.user.slack_user_id);
    logger.info('social_decay dispatcher ran', {
      ownerUserId: profile.user.slack_user_id,
      decayed,
      dormantFlipped,
    });
  } catch (err) {
    logger.warn('social_decay dispatcher threw — continuing to reschedule', {
      err: String(err).slice(0, 300),
    });
  }

  // Reschedule the next pass 7 days from now. Self-perpetuating cadence.
  try {
    const nextDue = DateTime.now().setZone(profile.user.timezone).plus({ days: 7 }).toISO();
    if (nextDue) {
      createTask({
        owner_user_id: profile.user.slack_user_id,
        owner_channel: task.owner_channel,
        type: 'social_decay',
        status: 'new',
        title: 'Social weekly decay pass',
        description: 'System maintenance — subtracts 1 from active topics untouched 7+ days.',
        due_at: nextDue,
        skill_ref: `social_decay_${profile.user.slack_user_id}`,
        context: '{}',
        who_requested: 'system',
      });
    }
  } catch (err) {
    logger.warn('social_decay self-reschedule threw', { err: String(err).slice(0, 300) });
  }

  completeTask(task.id);
};
