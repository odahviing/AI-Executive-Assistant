/**
 * Dispatcher registry (v1.6.2 split).
 *
 * Maps each TaskType to its dispatcher. When the runner picks up a due task
 * it looks up the dispatcher here. Previously this was a 700-line switch in
 * runner.ts — each dispatcher now lives in its own file.
 */

import type { Task } from '../index';
import type { TaskDispatcher } from './types';

import { dispatchRoutine } from './routine';
import { dispatchCalendarFix } from './calendarFix';
import { dispatchSummaryActionFollowup } from './summaryActionFollowup';
import { dispatchSocialDecay } from './socialDecay';
import { dispatchSocialPingRankCheck } from './socialPingRankCheck';

// create_task work (reminder / follow_up / research) lives on the requests
// spine now — create_task creates a request whose next_check_handler is fired
// by the ONE sweep (sweepDueRequests): reminder_fire for reminders/follow-ups,
// research_run for research. The old tasks-table dispatchReminder/FollowUp/
// Research were never invoked (nothing creates those task rows) and were the
// stranded duplicate path — deleted. This map now only holds the engine-internal
// task types that genuinely still create tasks-table rows.
export const DISPATCHERS: Partial<Record<Task['type'], TaskDispatcher>> = {
  routine:                  dispatchRoutine,
  calendar_fix:             dispatchCalendarFix,
  summary_action_followup:  dispatchSummaryActionFollowup,
  social_decay:             dispatchSocialDecay,
  social_ping_rank_check:   dispatchSocialPingRankCheck,
};
