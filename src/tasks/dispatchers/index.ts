/**
 * Dispatcher registry (v1.6.2 split).
 *
 * Maps each TaskType to its dispatcher. When the runner picks up a due task
 * it looks up the dispatcher here. Previously this was a 700-line switch in
 * runner.ts — each dispatcher now lives in its own file.
 */

import type { Task } from '../index';
import type { TaskDispatcher } from './types';

import { dispatchReminder } from './reminder';
import { dispatchFollowUp } from './followUp';
import { dispatchResearch } from './research';
import { dispatchRoutine } from './routine';
import { dispatchCalendarFix } from './calendarFix';
import { dispatchSummaryActionFollowup } from './summaryActionFollowup';
import { dispatchSocialDecay } from './socialDecay';
import { dispatchSocialOutreachTick } from './socialOutreachTick';
import { dispatchSocialPingRankCheck } from './socialPingRankCheck';

export const DISPATCHERS: Partial<Record<Task['type'], TaskDispatcher>> = {
  reminder:                 dispatchReminder,
  follow_up:                dispatchFollowUp,
  research:                 dispatchResearch,
  routine:                  dispatchRoutine,
  calendar_fix:             dispatchCalendarFix,
  summary_action_followup:  dispatchSummaryActionFollowup,
  social_decay:             dispatchSocialDecay,
  social_outreach_tick:     dispatchSocialOutreachTick,
  social_ping_rank_check:   dispatchSocialPingRankCheck,
};
