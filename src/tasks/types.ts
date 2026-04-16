/**
 * Unified task system — every async job Maelle does is a Task.
 *
 * Task types:
 *   coordination  — reach out to find meeting time, book it
 *   outreach      — send a message, wait for reply, report back
 *   reminder      — remind user (or someone) about something at a future time
 *   follow_up     — check back on something after X days
 *   research      — look something up, compile summary
 *   briefing      — daily briefing delivery
 *   routine       — materialized firing of a routine (v1.5.1: routines are a
 *                   thin layer that inserts tasks; no longer scheduled separately)
 */

export type TaskType =
  | 'coordination'
  | 'outreach'
  | 'reminder'
  | 'follow_up'
  | 'research'
  | 'routine'
  // v1.6.0 — unified sweep model: every background check is a task with a due_at.
  // These are "system" tasks (who_requested='system'); they run when their due_at
  // fires and then self-complete. Replace the old parallel sweeps.
  | 'outreach_send'      // scheduled outreach post time
  | 'outreach_expiry'    // outreach reply deadline
  | 'coord_nudge'        // 24-work-hour nudge to non-responders
  | 'coord_abandon'      // +4h after nudge, close coord if still stuck
  | 'approval_expiry'    // approval expires_at
  | 'calendar_fix'       // re-check a calendar issue marked to_resolve
  // v1.7.2 — Summary skill action-item follow-ups. At due_at the dispatcher
  // DMs the assignee asking for a status update; the reply flows back to the
  // owner via the existing outreach reply pipeline.
  | 'summary_action_followup';

export type TaskStatus =
  | 'new'                // created, not started yet (may have a future due_at)
  | 'in_progress'        // runner picked it up, actively executing
  | 'pending_owner'      // blocked on owner action/decision
  | 'pending_colleague'  // blocked on colleague response(s) — pending_on has IDs
  | 'completed'          // finished successfully
  | 'informed'           // requester was notified of completion (terminal)
  | 'failed'             // something went wrong
  | 'cancelled'          // user cancelled
  | 'stale';             // v1.5.1 — past the cadence-based lateness threshold, skipped

export interface Task {
  id: string;
  created_at: string;
  updated_at: string;
  owner_user_id: string;
  owner_channel: string;
  owner_thread_ts?: string;
  type: TaskType;
  status: TaskStatus;
  title: string;
  description?: string;
  due_at?: string;
  completed_at?: string;
  skill_ref?: string;          // links to coord_jobs/outreach_jobs/approvals/calendar_dismissed_issues ID
  context: string;             // JSON blob with task-specific data
  who_requested: string;       // slack_user_id of requester, or 'system'
  pending_on?: string;         // JSON array of slack_user_ids we're waiting on
  created_context?: string;    // 'dm' | 'mpim:{channel_id}' | 'channel:{channel_id}'
  routine_id?: string;         // links to routine that spawned this task
  skill_origin?: string;       // v1.6.0 — which skill created this task (e.g. 'meetings', 'calendar_health', 'outreach', 'tasks', 'memory', 'system')
  // v1.7.2 — counterpart resolution for "what's open with X?" queries
  target_slack_id?: string;    // 1:1 counterpart for outreach + summary_action_followup tasks
  target_name?: string;        // display name of the counterpart
}
