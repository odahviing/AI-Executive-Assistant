/**
 * The engine-internal task table. NOT the work-item spine — everything an owner
 * or a colleague is actually waiting on lives in `requests` (one state machine,
 * one timer via next_check_handler, one closure). What is left here is the set of
 * background jobs that fire on their own due_at and answer to nobody: routines,
 * calendar re-checks, summary action follow-ups, the social maintenance passes.
 *
 * A type belongs in this union ONLY if something creates rows of it AND
 * `dispatchers/index.ts` has an entry to execute it. A type with no dispatcher is
 * a stranded timer: getTasksDueNow picks the row up at its due_at and
 * runner.ts:83-86 marks it 'failed' with nothing else happening. That is exactly
 * what the v4.2.x deletion of `outreach` removed — message_colleague minted a
 * third work-item row per send (beside the request and the outreach_job) whose
 * only real effect was that bogus 'failed' write.
 *
 * coordination/reminder/follow_up/research/briefing were removed o#192 (2026-08-03):
 * create_task now creates a `requests` row (kind=reminder/follow_up/research,
 * next_check_handler='reminder_fire'|'research_run' — see tasks/skill.ts) rather
 * than a tasks-table row, and 'coordination'/'briefing' had no creator at all.
 *
 * Task types:
 *   routine       — materialized firing of a routine (v1.5.1: routines are a
 *                   thin layer that inserts tasks; no longer scheduled separately)
 */

export type TaskType =
  | 'routine'
  // v1.6.0 — unified sweep model: every background check is a task with a due_at.
  // These are "system" tasks (who_requested='system'); they run when their due_at
  // fires and then self-complete. Replace the old parallel sweeps.
  // v3.1 (Path 2 Stage 6) — ALL lifecycle timers now live on the request via
  // next_check_handler + the single spine sweep (core/requests/runner.ts):
  // outreach send/expiry/decision, coord nudge/abandon, approval expiry/reminder.
  // The legacy task-type dispatchers for these were deleted; the values are
  // gone so nothing can re-create a parallel timer.
  | 'calendar_fix'       // re-check a calendar issue marked to_resolve
  // v1.7.2 — Summary skill action-item follow-ups. At due_at the dispatcher
  // DMs the assignee asking for a status update; the reply flows back to the
  // owner via the existing outreach reply pipeline.
  | 'summary_action_followup';
  // gh#198 (2026-08-15) — 'social_decay' (the weekly per-subject decay pass)
  // and 'social_ping_rank_check' (RETIRED v3.2.6, a no-op drain) are both
  // REMOVED. Subjects no longer carry a score to decay — a subject now dies
  // on 2 unanswered raises or an explicit reject (socialSubjects.ts,
  // capturePass.ts), never on a clock — and the ping-rank-check queue was
  // confirmed fully drained (0 pending rows) before removal. No dispatcher
  // remains for either type; do not re-add rows of these types.

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
  skill_ref?: string;          // links to the originating skill's own row (summary_sessions, calendar_dismissed_issues)
  context: string;             // JSON blob with task-specific data
  who_requested: string;       // slack_user_id of requester, or 'system'
  pending_on?: string;         // JSON array of slack_user_ids we're waiting on
  created_context?: string;    // 'dm' | 'mpim:{channel_id}' | 'channel:{channel_id}'
  routine_id?: string;         // links to routine that spawned this task
  skill_origin?: string;       // v1.6.0 — which skill created this task (e.g. 'summary', 'calendar_health', 'system')
  // v1.7.2 — counterpart resolution for "what's open with X?" queries
  target_slack_id?: string;    // 1:1 counterpart for summary_action_followup tasks
  target_name?: string;        // display name of the counterpart
}
