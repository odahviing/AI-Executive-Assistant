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

// create_task work (reminder / follow_up / research) lives on the requests
// spine now — create_task creates a request whose next_check_handler is fired
// by the ONE sweep (sweepDueRequests): reminder_fire for reminders/follow-ups,
// research_run for research. The old tasks-table dispatchReminder/FollowUp/
// Research were never invoked (nothing creates those task rows) and were the
// stranded duplicate path — deleted. This map now only holds the engine-internal
// task types that genuinely still create tasks-table rows.
//
// gh#198 (answer 0/5) — `social_decay` (weekly per-subject decay) and
// `social_ping_rank_check` (a retired no-op drain, fully drained) are both
// GONE: subjects no longer carry a score to decay (socialSubjects.ts), and
// engagement_rank hasn't moved on a schedule since v3.2.6. Their dispatcher
// files, type-union members and this registry's entries are deleted together.
export const DISPATCHERS: Partial<Record<Task['type'], TaskDispatcher>> = {
  routine:                  dispatchRoutine,
  calendar_fix:             dispatchCalendarFix,
  summary_action_followup:  dispatchSummaryActionFollowup,
};
