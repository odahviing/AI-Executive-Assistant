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
import { dispatchOutreachSend } from './outreachSend';
import { dispatchOutreachExpiry } from './outreachExpiry';
import { dispatchCoordNudge } from './coordNudge';
import { dispatchCoordAbandon } from './coordAbandon';
import { dispatchApprovalExpiry } from './approvalExpiry';
import { dispatchCalendarFix } from './calendarFix';
import { dispatchSummaryActionFollowup } from './summaryActionFollowup';

export const DISPATCHERS: Partial<Record<Task['type'], TaskDispatcher>> = {
  reminder:                 dispatchReminder,
  follow_up:                dispatchFollowUp,
  research:                 dispatchResearch,
  routine:                  dispatchRoutine,
  outreach_send:            dispatchOutreachSend,
  outreach_expiry:          dispatchOutreachExpiry,
  coord_nudge:              dispatchCoordNudge,
  coord_abandon:            dispatchCoordAbandon,
  approval_expiry:          dispatchApprovalExpiry,
  calendar_fix:             dispatchCalendarFix,
  summary_action_followup:  dispatchSummaryActionFollowup,
};
