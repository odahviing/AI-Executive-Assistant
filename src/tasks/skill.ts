import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from '../skills/types';
import type { UserProfile } from '../config/userProfile';
import {
  createTask,
  updateTask,
  getTask,
  getOpenTasksForOwner,
  getOpenTasksWithPerson,
  getActiveJobsForThread,
  getCompletedUninformedTasks,
  markTaskInformed,
  cancelTask,
  completeTask,
  formatTasksForUser,
  type TaskType,
} from './index';
import { classifyTaskContinuity } from '../core/taskContinuity';
import {
  getUnseenEvents,
  markEventsSeen,
  type MaelleEvent,
} from '../db';
import {
  createApproval,
  getApproval,
  getPendingApprovalsForOwner,
  type ApprovalKind,
} from '../db/approvals';
import { resolveApproval, type ResolveDecision } from '../core/approvals/resolver';
import { getDb as _getDb } from '../db/client';
import { sendMorningBriefing } from './briefs';
import { DateTime } from 'luxon';
import logger from '../utils/logger';

export class TasksSkill implements Skill {
  id = 'tasks' as const;
  name = 'Tasks';
  description = 'Creates and manages async tasks — reminders, follow-ups, pending work, briefings';

  getTools(_profile: UserProfile): Anthropic.Tool[] {
    return [
      {
        name: 'create_task',
        description: `Create a task for Maelle to handle asynchronously.
Use when asked to:
- "Remind me about X tomorrow"
- "Follow up with Yael in 3 days if she doesn't respond"
- "Check back with Isaac next week"
- "Remind Ysrael about the board prep on Tuesday"
- Any future action that shouldn't happen right now

Task types:
- reminder: remind the owner (or someone else) about something at a specific time
- follow_up: check back on an ongoing situation after X days
- research: research a topic, compile summary (runs through the full agent)
- coordination: handled automatically when initiating meeting booking
- outreach: handled automatically when sending messages to colleagues`,
        input_schema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['reminder', 'follow_up', 'research'],
              description: 'Task type',
            },
            title: {
              type: 'string',
              description: 'Plain English title of what Maelle is doing. e.g. "Remind Idan about board prep", "Follow up with Yael about interview pipeline"',
            },
            description: {
              type: 'string',
              description: 'More detail if needed',
            },
            due_at: {
              type: 'string',
              description: 'ISO 8601 datetime when to execute this task. Use the date reference table.',
            },
            target_slack_id: {
              type: 'string',
              description: 'If reminding someone else (not the owner), their Slack user ID',
            },
            target_name: {
              type: 'string',
              description: 'Display name of the target person if different from owner',
            },
            message: {
              type: 'string',
              description: 'What to say when the task executes. For reminders to others: the message to send.',
            },
          },
          required: ['type', 'title', 'due_at'],
        },
      },
      {
        name: 'edit_task',
        description: `Edit an existing task — change its title, description, due date, message, or type.
Use when asked to:
- "Change that reminder to Thursday instead"
- "Update the follow-up message to include Q1 numbers"
- "Push the reminder back by a day"`,
        input_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'ID of the task to edit' },
            title: { type: 'string' },
            description: { type: 'string' },
            due_at: { type: 'string', description: 'New ISO 8601 datetime' },
            type: { type: 'string', enum: ['reminder', 'follow_up', 'research'] },
            message: { type: 'string', description: 'Updated message content (stored in context)' },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'get_my_tasks',
        description: `Get all open tasks Maelle is currently working on or waiting on. Call this when the user asks "what tasks do you have?" or "what's pending?" or "what are you working on?"

Optional with_person filter: pass a Slack user ID to scope results to 1:1 tasks involving that person (outreach + summary action follow-ups). Use when the user asks "what's open with Brett?" or "show me everything with @Yael". Coord tasks (multi-party meetings) are excluded from the filter since they don't have a single counterpart.

ALSO CHECK ROUTINES when the owner asks about recurring activities ("did you do my LinkedIn post?", "did the briefing run?", "weekly review this morning?"). Routines only appear in get_my_tasks once a firing has materialized — if the owner asks before the scheduled time, or if a firing completed silently, the task may not be visible here. Always also call get_routines for questions about recurring activities and cross-reference: a routine with last_run_at=today + last_result="No issues found" DID run (silently); last_run_at still empty for today = didn't fire yet.`,
        input_schema: {
          type: 'object',
          properties: {
            with_person: {
              type: 'string',
              description: 'Optional Slack user ID (e.g. "U123ABC") to filter for tasks involving that specific person. Omit for all open tasks.',
            },
          },
          required: [],
        },
      },
      {
        name: 'cancel_task',
        description: 'Cancel a pending task.',
        input_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'get_briefing',
        description: `Get a summary of everything that happened since the user was last active.
Call this when the user asks:
- "What did I miss?"
- "What happened while I was away?"
- "Any new messages?"
- "Catch me up"
- "What's new?"
- "What changed since we last spoke?"

Returns unseen events grouped by type, plus open tasks needing attention.`,
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'send_briefing_now',
        description: `Send the morning briefing immediately as a new standalone DM — not as a reply in this thread.
Call this when the user asks you to:
- "Send me the briefing now"
- "Run the briefing"
- "Give me my morning briefing"
- "Send it as a new message"

This sends the full AI-generated briefing as a fresh top-level DM, bypassing the daily schedule.`,
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      // ── Approvals (v1.5) ─────────────────────────────────────────────────
      // First-class structured decisions from the owner. Always attached to a
      // parent task. Owner replies in natural language — you interpret it and
      // call resolve_approval. Do NOT DM the owner freeform to ask a yes/no
      // question for a decision; create_approval so the ask is tracked.
      {
        name: 'create_approval',
        description: `Ask the owner for a decision. ALWAYS use this when you need the owner to decide something instead of just DMing them a question. The owner is the only one who can bypass scheduling rules — colleagues asking for something that breaks the rules MUST go through this tool. Maelle never overrides on her own.

AUTHORITY MODEL:
- If the owner tells Maelle directly to do something (even when it breaks a rule), that IS the approval — just do it, no approval needed. "Book Yael at 15:00 tomorrow even though it's during my focus block" = owner explicitly overriding, proceed.
- If a colleague asks for something that breaks a rule or needs an owner-only judgment, create_approval — the owner must decide. The colleague cannot bypass rules on their own.

Kinds:
- slot_pick: pick one of N offered meeting slots. Payload: { coord_job_id, subject, slots: [{iso, label}], participants_emails, duration_min }. Resolving calls through to the booking flow automatically.
- duration_override: approve a non-standard meeting length. Payload: { subject, duration_min, reason }.
- policy_exception: override a scheduling rule (back-to-back, off-hours, no-lunch, protected meeting). Payload: { rule, context }.
- lunch_bump: move the owner's lunch block. Payload: { from, to, reason }.
- unknown_person: book with someone we don't have full contact info for. Payload: { name, known_fields, missing_fields }.
- calendar_conflict: the chosen slot went stale — offer fresh options. Payload: { coord_job_id, original_slot, conflict_reason, slots: [...] }.
- freeform: catch-all yes/no/amend question. Payload: { question, context }. Use for colleague asks that don't fit the structured kinds (e.g. "Yael wants you to free up the 15:00 slot").

Behavior:
- DMs the owner immediately with ask_text. Idempotent on (task_id, kind, payload) — safe to retry.
- Default expiry is 2 owner-workdays (Fri/Sat skipped for this profile). Owner-silent past expiry → parent task cancels + owner gets a tombstone DM.
- When approval has a colleague-originated context, include requester_slack_id in the payload so the resolver can DM the requester back with the owner's decision. No requester_slack_id = nothing to close back to (owner-internal approval).
- The owner's free-text reply is interpreted by you on the owner's next turn. Call resolve_approval with the right verdict.`,
        input_schema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'Optional. Parent task ID if you already created one. If omitted, a follow_up task is auto-created with a title derived from the payload — saves you a create_task call.',
            },
            kind: {
              type: 'string',
              enum: ['slot_pick', 'duration_override', 'policy_exception', 'lunch_bump', 'unknown_person', 'calendar_conflict', 'freeform'],
            },
            payload: {
              type: 'object',
              description: 'Kind-specific payload (see tool description). Free-form JSON; the resolver validates per kind. For colleague-initiated asks include requester_slack_id + requester_name so the resolver can DM them the outcome.',
            },
            skill_ref: {
              type: 'string',
              description: 'Optional. For coord-linked approvals, the coord_job_id. Enables the resolver to book the meeting on approve.',
            },
            ask_text: {
              type: 'string',
              description: 'The exact text to DM the owner as the approval ask. Make it warm, specific, include the decision to make. The owner sees this verbatim.',
            },
            expires_in_workdays: {
              type: 'number',
              description: 'Owner-workdays until this approval expires. Default 2. Counter only advances on the owner\'s office/home days — Fri/Sat do not count (so an ask on Thursday expires Monday, an ask on Saturday expires Tuesday). Use 1 for same-day urgency, 3+ for low-urgency.',
            },
            expires_in_hours: {
              type: 'number',
              description: 'Optional escape hatch for sub-workday precision ("this has to be decided in the next 2 hours"). If set, overrides expires_in_workdays.',
            },
          },
          required: ['kind', 'payload', 'ask_text'],
        },
      },
      {
        name: 'resolve_approval',
        description: `Record the owner's decision on a pending approval. Call this when the owner replies to an approval ask in DM.

Verdicts:
- approve: owner said yes. Provide the decision data (e.g. for slot_pick: { slot_iso: "2026-04-22T10:00:00" }).
- reject: owner said no. The parent task is cancelled.
- amend: owner said "not as asked, but here's an alternative" (e.g. "no, but 13:30 would work"). Provide counter with the alternative payload. The approval closes as amended; next turn you should relay the counter to the original requester.

Binding — how to pick the right approval_id:
- Look for an "#appr_..." token in the owner's reply first.
- If none, pick the most recently created pending approval for this owner.
- If multiple are pending and ambiguous, call list_pending_approvals and ask the owner to clarify which one.`,
        input_schema: {
          type: 'object',
          properties: {
            approval_id: { type: 'string', description: 'The approval id from the pending list.' },
            verdict: { type: 'string', enum: ['approve', 'reject', 'amend'] },
            data: {
              type: 'object',
              description: 'For verdict=approve. Kind-specific decision payload. For slot_pick: { slot_iso }. For freeform: { answer: "yes"|"no"|string }.',
            },
            counter: {
              type: 'object',
              description: 'For verdict=amend. The alternative the owner proposed. For slot_pick: { slot_iso } with the new time. For lunch_bump: { to: "13:30" }. For freeform: { text: "original request was X, alternative is Y" }.',
            },
            reason: {
              type: 'string',
              description: 'Free text — the owner\'s reasoning, if they gave one. Useful on reject and amend.',
            },
          },
          required: ['approval_id', 'verdict'],
        },
      },
      {
        name: 'list_pending_approvals',
        description: 'List approvals currently waiting on the owner. Use when the owner asks "what are you waiting on me for" or when you need to disambiguate which approval a reply is answering.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      // v2.0.7 — store_request / get_pending_requests / resolve_request /
      // escalate_to_user retired. All three paths ("colleague asked something
      // that needs owner input", "I'd like to break a rule, is that ok?",
      // "flag this for later") now go through create_approval. The old
      // store_request was a silent write-only bucket — the owner only found
      // out via the next morning brief, which is why Yael's "free the 15:00
      // slot" ask sat invisible for a day. create_approval always DMs the
      // owner immediately (via sendDirect), has a real expiry, and the
      // owner's reply binds deterministically through the resolver.
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const { profile, channelId, threadTs } = context;
    const ownerUserId = profile.user.slack_user_id;

    switch (toolName) {

      case 'create_task': {
        const taskContext: Record<string, unknown> = {};
        if (args.target_slack_id) taskContext.target_slack_id = args.target_slack_id;
        if (args.target_name) taskContext.target_name = args.target_name;
        if (args.message) taskContext.message = args.message;

        // v2.0.3 — same-thread continuity check. If there are open tasks in
        // the same thread, classify whether this new request is a follow-up
        // on an existing one vs genuinely new. Prevents the "couple orders
        // in one thread" case from creating duplicate tasks. Cross-thread
        // requests skip the check (different thread = always new).
        if (threadTs && context.senderRole === 'owner') {
          const thread = getActiveJobsForThread(ownerUserId, threadTs);
          if (thread.tasks.length > 0) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const Anthropic = (require('@anthropic-ai/sdk') as typeof import('@anthropic-ai/sdk')).default;
              const anthropic = new Anthropic();
              const verdict = await classifyTaskContinuity({
                newTaskTitle: String(args.title ?? ''),
                newTaskDescription: args.description as string | undefined,
                newTaskType: String(args.type ?? ''),
                existingTasks: thread.tasks.map(t => ({
                  id: t.id,
                  type: t.type,
                  status: t.status,
                  title: t.title,
                  description: t.description ?? undefined,
                  created_at: t.created_at,
                })),
                anthropic,
              });
              if (verdict.kind === 'follow_up_of' && verdict.confidence !== 'low' && verdict.existing_task_id) {
                logger.info('Task creation skipped — continuation of existing', {
                  existingId: verdict.existing_task_id,
                  confidence: verdict.confidence,
                  reason: verdict.reason,
                });
                return {
                  created: false,
                  would_duplicate: true,
                  existing_task_id: verdict.existing_task_id,
                  reason: verdict.reason,
                  _note: `This looks like a follow-up on task ${verdict.existing_task_id} (${verdict.reason}). Use edit_task to update it, or tell the owner you're continuing that task. Only call create_task again if this is genuinely a separate piece of work.`,
                };
              }
            } catch (err) {
              logger.warn('create_task — continuity check failed, proceeding with create', { err: String(err).slice(0, 200) });
            }
          }
        }

        // Determine created_context from current conversation context
        let createdContext = 'dm';
        if (context.isMpim) {
          createdContext = `mpim:${channelId}`;
        } else if (context.senderRole === 'colleague') {
          // Could be a channel — but we track based on what we know
          createdContext = `dm`;
        }

        const id = createTask({
          owner_user_id: ownerUserId,
          owner_channel: channelId,
          owner_thread_ts: threadTs,
          type: args.type as TaskType,
          status: 'new',
          title: args.title as string,
          description: args.description as string | undefined,
          due_at: args.due_at as string,
          context: JSON.stringify(taskContext),
          who_requested: context.userId,
          created_context: createdContext,
        });

        const dueDt = DateTime.fromISO(args.due_at as string).setZone(profile.user.timezone);
        logger.info('Task created via skill', { id, type: args.type, due: args.due_at });
        return { created: true, task_id: id, due: dueDt.toFormat('EEEE, d MMMM') + ' at ' + dueDt.toFormat('HH:mm') };
      }

      case 'edit_task': {
        const task = getTask(args.task_id as string);
        if (!task) return { error: 'Task not found' };

        const updates: Partial<Record<string, unknown>> = {};
        if (args.title) updates.title = args.title;
        if (args.description) updates.description = args.description;
        if (args.due_at) updates.due_at = args.due_at;
        if (args.type) updates.type = args.type;

        // Update message in context blob
        if (args.message) {
          const ctx = task.context ? JSON.parse(task.context) : {};
          ctx.message = args.message;
          updates.context = JSON.stringify(ctx);
        }

        if (Object.keys(updates).length === 0) {
          return { updated: false, message: 'Nothing to update' };
        }

        updateTask(args.task_id as string, updates as any);
        logger.info('Task edited via skill', { id: args.task_id, fields: Object.keys(updates) });

        const result: Record<string, unknown> = { updated: true, task_id: args.task_id };
        if (args.due_at) {
          const dueDt = DateTime.fromISO(args.due_at as string).setZone(profile.user.timezone);
          result.new_due = dueDt.toFormat('EEEE, d MMMM') + ' at ' + dueDt.toFormat('HH:mm');
        }
        return result;
      }

      case 'get_my_tasks': {
        // v1.6.8 — enriched output. Each task row is hydrated with the
        // linked domain data (outreach_jobs / coord_jobs / approvals /
        // pending_requests) so the LLM has the real subject, message, and
        // counterpart directly — no need to fill gaps from people_memory
        // interaction_log (the source of the "Plans and Onboarding"
        // hallucination). Also includes pending approvals + colleague
        // requests in one unified response so there's ONE authoritative
        // answer to "what's on my plate".
        // v1.7.2 — optional with_person filter scopes to 1:1 tasks (outreach
        // + summary follow-ups) where target_slack_id matches.
        const withPerson = typeof args.with_person === 'string' && args.with_person.trim()
          ? args.with_person.trim()
          : null;
        const tasks = withPerson
          ? getOpenTasksWithPerson(ownerUserId, withPerson)
          : getOpenTasksForOwner(ownerUserId);
        const db = _getDb();

        const hydrate = (t: any): Record<string, unknown> => {
          const base: Record<string, unknown> = {
            task_id: t.id,
            type: t.type,
            status: t.status,
            title: t.title,
            due_at: t.due_at ?? null,
          };
          if (!t.skill_ref) return base;

          // Outreach — pull the message + colleague + sent_at from outreach_jobs
          if (t.type === 'outreach' || t.type === 'outreach_send' || t.type === 'outreach_expiry') {
            const job = db.prepare(
              `SELECT id, colleague_name, colleague_slack_id, message, status, await_reply, sent_at, reply_text, reply_deadline
               FROM outreach_jobs WHERE id = ?`
            ).get(t.skill_ref) as any;
            if (job) {
              base.outreach = {
                colleague: job.colleague_name,
                colleague_slack_id: job.colleague_slack_id,
                message_sent: job.message,
                sent_at: job.sent_at,
                outreach_status: job.status,
                await_reply: job.await_reply === 1,
                reply_deadline: job.reply_deadline,
                reply: job.reply_text ?? null,
              };
            }
          }

          // Coordination — pull subject + participants + state from coord_jobs
          if (t.type === 'coordination' || t.type === 'coord_nudge' || t.type === 'coord_abandon') {
            const job = db.prepare(
              `SELECT id, subject, duration_min, participants, status, winning_slot
               FROM coord_jobs WHERE id = ?`
            ).get(t.skill_ref) as any;
            if (job) {
              let participantNames: string[] = [];
              try {
                const parts = JSON.parse(job.participants || '[]') as Array<{ name?: string; just_invite?: boolean }>;
                participantNames = parts.filter(p => !p.just_invite).map(p => p.name ?? 'someone');
              } catch (_) {}
              base.coordination = {
                subject: job.subject,
                duration_min: job.duration_min,
                participants: participantNames,
                coord_status: job.status,
                winning_slot: job.winning_slot ?? null,
              };
            }
          }

          // Approval expiry — pull kind + subject from approvals
          if (t.type === 'approval_expiry') {
            const ap = db.prepare(
              `SELECT id, kind, status, payload_json, expires_at FROM approvals WHERE id = ?`
            ).get(t.skill_ref) as any;
            if (ap) {
              let payload: any = {};
              try { payload = JSON.parse(ap.payload_json ?? '{}'); } catch (_) {}
              base.approval = {
                kind: ap.kind,
                subject: payload.subject ?? null,
                expires_at: ap.expires_at,
                approval_status: ap.status,
              };
            }
          }
          return base;
        };

        const pendingOwner       = tasks.filter(t => t.status === 'pending_owner').map(hydrate);
        const waitingOnOthers    = tasks.filter(t => t.status === 'pending_colleague').map(hydrate);
        const active             = tasks
          .filter(t => t.status === 'new' || t.status === 'in_progress')
          .map(hydrate);
        const recentlyDone       = tasks.filter(t => t.status === 'completed').map(hydrate);

        // Pending approvals — direct from approvals table (not all have a
        // parent task visible in getOpenTasksForOwner).
        // When filtering with_person, suppress global queries — they're not scoped to that person.
        const pendingApprovals = withPerson ? [] : getPendingApprovalsForOwner(ownerUserId).map(a => {
          let payload: any = {};
          try { payload = JSON.parse(a.payload_json ?? '{}'); } catch (_) {}
          return {
            approval_id: a.id,
            kind: a.kind,
            subject: payload.subject ?? null,
            question: payload.question ?? null,
            expires_at: a.expires_at,
            created_at: a.created_at,
          };
        });

        // v2.0.7 — pending_requests retired; its contents now flow through
        // the approvals table (see store_request removal in this file). No
        // separate colleague_requests bucket — every colleague-initiated ask
        // needing owner input is a `create_approval` row.
        const formatted = formatTasksForUser(tasks);
        const totalOpen =
          pendingOwner.length + waitingOnOthers.length + active.length + recentlyDone.length +
          pendingApprovals.length;

        return {
          summary: {
            total: totalOpen,
            pending_your_input_count: pendingOwner.length + pendingApprovals.length,
            waiting_on_others_count: waitingOnOthers.length,
            active_count: active.length,
            recently_done_count: recentlyDone.length,
          },
          pending_your_input: pendingOwner,
          pending_approvals: pendingApprovals,
          waiting_on_others: waitingOnOthers,
          active_tasks: active,
          recently_done: recentlyDone,
          formatted,
          count: totalOpen,
          _note: 'Describe these to the owner USING ONLY the fields in this response. Do NOT add subjects or context remembered from past conversations or people_memory — every detail you narrate must appear in this result.',
        };
      }

      case 'cancel_task': {
        const task = getTask(args.task_id as string);
        if (!task) return { error: 'Task not found' };
        cancelTask(args.task_id as string);
        return { cancelled: true, title: task.title };
      }

      case 'get_briefing': {
        const events = getUnseenEvents(ownerUserId);
        const openTasks = getOpenTasksForOwner(ownerUserId);
        const completedTasks = getCompletedUninformedTasks(ownerUserId);

        // Mark all events as seen and completed tasks as informed
        markEventsSeen(ownerUserId);
        for (const t of completedTasks) markTaskInformed(t.id);

        // Group events by type
        const grouped: Record<string, MaelleEvent[]> = {};
        for (const evt of events) {
          if (!grouped[evt.type]) grouped[evt.type] = [];
          grouped[evt.type].push(evt);
        }

        logger.info('Briefing generated', {
          userId: ownerUserId,
          eventCount: events.length,
          openTasks: openTasks.length,
        });

        return {
          events,
          grouped,
          open_tasks: openTasks,
          completed_tasks: completedTasks,
          event_count: events.length,
          task_count: openTasks.length,
          completed_count: completedTasks.length,
          nothing_new: events.length === 0 && openTasks.length === 0 && completedTasks.length === 0,
        };
      }

      case 'send_briefing_now': {
        const app = context.app;
        if (!app) {
          return { ok: false, reason: 'No Slack app available in this context.' };
        }
        try {
          // force=true skips the daily dedup check
          await sendMorningBriefing(app, context.profile, context.channelId, true);
          return { ok: true };
        } catch (err) {
          logger.error('send_briefing_now failed', { err });
          return { ok: false, reason: String(err) };
        }
      }

      // ── Approvals (v1.5, rewritten in v2.0.7) ──────────────────────────────
      case 'create_approval': {
        // v2.0.7 — owner-only guard removed. Approvals are Maelle's decision
        // (not the caller's); the DM always lands in the owner's DM channel
        // via sendDirect regardless of where the tool was invoked from. That
        // means colleague-path Sonnet can legitimately create an approval
        // when a colleague asks for something needing owner input (Yael's
        // slot-bump ask). resolve_approval still guards owner-only.
        const kind = args.kind as ApprovalKind;
        const payload = (args.payload as Record<string, unknown>) ?? {};
        const askText = args.ask_text as string;

        // v2.0.7 — expiry in owner-workdays by default. Fri/Sat don't count
        // so an approval asked Thursday 16:00 expires Monday 16:00, not
        // Saturday; one asked Saturday 10:00 expires Tuesday 10:00 (counter
        // starts Sunday). Legacy `expires_in_hours` still honored as an
        // escape hatch for sub-workday precision.
        let expiresAt: string;
        if (typeof args.expires_in_hours === 'number') {
          // Explicit hour window — use as-is. Owner said "must decide in N
          // calendar hours", we respect the urgency.
          expiresAt = DateTime.now().plus({ hours: args.expires_in_hours }).toUTC().toISO()!;
        } else {
          // v2.1.3 — workday-based expiry counts from owner WORK TIME, not
          // from the creation timestamp. A 20:00 approval (colleague asked
          // late) shouldn't silently lose 13 hours of window because the
          // owner is off-duty; the 2-workday clock starts tomorrow morning.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { addWorkdays, workTimeBaseFromNow } = require('../utils/workHours') as typeof import('../utils/workHours');
          const n = typeof args.expires_in_workdays === 'number' ? args.expires_in_workdays : 2;
          const base = workTimeBaseFromNow(profile);
          expiresAt = addWorkdays(base, n, profile);
        }

        // v2.0.7 — task_id now optional. If omitted, auto-create a follow_up
        // task with a title derived from the payload. This cuts Sonnet's
        // two-call pattern (create_task + create_approval) to one, which was
        // the friction that made her fall back to the retired store_request
        // bucket whenever a colleague asked for something.
        let taskId = (args.task_id as string | undefined) ?? '';
        let parentTask = taskId ? getTask(taskId) : null;
        if (!parentTask) {
          const derivedTitle =
            (typeof payload.subject === 'string' && payload.subject) ||
            (typeof payload.question === 'string' && payload.question.slice(0, 80)) ||
            `${kind.replace(/_/g, ' ')} needs your input`;
          const requesterName =
            (typeof payload.requester_name === 'string' && payload.requester_name) || null;
          const autoTitle = requesterName
            ? `${requesterName} asked: ${derivedTitle} — needs your input`
            : `${derivedTitle} — needs your input`;
          taskId = createTask({
            owner_user_id: ownerUserId,
            owner_channel: channelId,
            owner_thread_ts: threadTs,
            type: 'follow_up',
            status: 'new',
            title: autoTitle,
            description: askText,
            due_at: expiresAt,
            context: JSON.stringify({
              auto_created_by: 'create_approval',
              kind,
              requester_slack_id: payload.requester_slack_id ?? null,
              requester_name: requesterName,
            }),
            who_requested: context.userId,
            skill_origin: 'tasks',
          });
          parentTask = getTask(taskId);
          if (!parentTask) {
            return { error: 'task_autocreate_failed', reason: `Auto-created task ${taskId} could not be read back.` };
          }
          logger.info('create_approval — auto-created parent task', {
            taskId, kind, requesterName,
          });
        }

        // v2.0.7 — approvals always DM the owner. When triggered from a
        // colleague DM, parentTask.owner_channel points at the colleague's
        // channel — wrong destination. Resolve via sendDirect(ownerId) instead,
        // which the SlackConnection maps to the owner's actual DM channel.
        // We still persist owner_channel on the approval row AFTER the DM
        // completes so approval-in-system-prompt binding works from any
        // subsequent owner turn.
        const { approval, created } = createApproval({
          taskId,
          ownerUserId,
          kind,
          payload,
          skillRef: (args.skill_ref as string | undefined) ?? undefined,
          // Deliberately NOT passing slackChannel here — we'll stamp it after
          // the DM lands so the recorded channel is the owner's real DM, not
          // whatever channel the parent task was created in.
          expiresAt,
        });

        if (created) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getConnection } = require('../connections/registry') as typeof import('../connections/registry');
            const conn = getConnection(profile.user.slack_user_id, 'slack');
            if (conn) {
              const res = await conn.sendDirect(profile.user.slack_user_id, askText);
              if (res.ok) {
                // Record the owner's DM channel + message ts on the approval
                // row so the resolver + system-prompt binding see the correct
                // conversation surface.
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getDb } = require('../db/client') as typeof import('../db/client');
                getDb().prepare(
                  `UPDATE approvals
                      SET slack_channel = COALESCE(?, slack_channel),
                          slack_msg_ts  = COALESCE(?, slack_msg_ts),
                          updated_at    = datetime('now')
                    WHERE id = ?`
                ).run(res.ref ?? null, res.ts ?? null, approval.id);
              } else {
                logger.error('create_approval — sendDirect to owner failed', {
                  approvalId: approval.id, reason: res.reason, detail: res.detail,
                });
              }
            } else {
              logger.warn('create_approval — no Slack connection registered', { approvalId: approval.id });
            }
          } catch (err) {
            logger.error('create_approval — DM to owner failed', { err: String(err), approvalId: approval.id });
          }
        }

        return {
          ok: true,
          approval_id: approval.id,
          created,
          expires_at: expiresAt,
          kind,
          reused_existing: !created,
        };
      }

      case 'resolve_approval': {
        if (context.senderRole !== 'owner') {
          logger.warn('Colleague attempted resolve_approval — blocked', { userId: context.userId });
          return { error: 'not_permitted', reason: 'Only the owner can resolve approvals.' };
        }
        const approvalId = args.approval_id as string;
        const verdict = args.verdict as 'approve' | 'reject' | 'amend';

        let decision: ResolveDecision;
        if (verdict === 'approve') {
          decision = { verdict: 'approve', data: (args.data as Record<string, unknown>) ?? {} };
        } else if (verdict === 'reject') {
          decision = { verdict: 'reject', reason: args.reason as string | undefined };
        } else if (verdict === 'amend') {
          const counter = (args.counter as Record<string, unknown>) ?? {};
          if (Object.keys(counter).length === 0) {
            return { error: 'missing_counter', reason: 'verdict=amend requires a non-empty counter payload describing the alternative.' };
          }
          decision = { verdict: 'amend', counter, reason: args.reason as string | undefined };
        } else {
          return { error: 'bad_verdict', reason: `Unknown verdict "${verdict}". Use approve, reject, or amend.` };
        }

        try {
          const result = await resolveApproval(approvalId, decision, {
            app: context.app,
            profile: context.profile,
          });
          return result;
        } catch (err) {
          logger.error('resolve_approval threw', { err: String(err), approvalId });
          return { ok: false, reason: `resolver threw: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      case 'list_pending_approvals': {
        const rows = getPendingApprovalsForOwner(ownerUserId);
        return {
          count: rows.length,
          approvals: rows.map(a => {
            let payloadSummary: unknown;
            try { payloadSummary = JSON.parse(a.payload_json); } catch (_) { payloadSummary = a.payload_json; }
            return {
              id: a.id,
              kind: a.kind,
              task_id: a.task_id,
              skill_ref: a.skill_ref,
              created_at: a.created_at,
              expires_at: a.expires_at,
              payload: payloadSummary,
            };
          }),
        };
      }

      // v2.0.7 — store_request / get_pending_requests / resolve_request /
      // escalate_to_user retired; see tool-declaration comment above.

      default:
        return null;
    }
  }

  getSystemPromptSection(_profile: UserProfile): string {
    return `## TASKS

Every future action becomes a task. When asked to remind, follow up, check back, research, or do anything at a future time — create a task.

TASK LIFECYCLE:
- new → in_progress (runner picks it up) → completed → informed (requester notified)
- Blocked on owner input → pending_owner
- Blocked on colleague response → pending_colleague (pending_on stores who)
- failed or cancelled are terminal

WHEN TO CREATE TASKS:
- "Remind me about X tomorrow" → create_task type=reminder
- "Follow up with Yael in 3 days" → create_task type=follow_up
- "Research Y and send me a summary" → create_task type=research
- Coordination and outreach tasks are created automatically by their respective tools

TASK RULES:
- Always confirm task creation to the user with the scheduled date/time
- Before creating, check get_my_tasks to avoid duplicates
- When asked "what's pending?" or "what are you working on?" → call get_my_tasks
- Tasks created in a private DM are never surfaced in group conversations
- edit_task to modify an existing task instead of cancelling and recreating

PENDING_OWNER — these are items parked on the owner's side:
- Use when you need a decision, approval, or input before you can proceed
- get_my_tasks separates these so the owner can see everything waiting on them
- Weekly reviews: list all pending_owner items for the owner to process

MORNING BRIEFING:
When the user changes their briefing time, call learn_preference with category="scheduling", key="briefing_time", value="HH:MM" (e.g. "07:30"). The system reads this key to schedule future briefings — format matters.
Owner-initiated brief requests ("send the brief", "didn't get my morning update", "what's on today") are routed deterministically to send_briefing_now BEFORE the orchestrator runs (v2.3.2). You only see send_briefing_now as an option for edge cases the pre-router missed — never improvise a brief from raw get_calendar / get_my_tasks. If the user clearly asks for the brief and you got the message, call send_briefing_now and trust its output; never claim you've sent the brief unless the tool returned ok:true.

## APPROVALS (v1.5) — structured decisions from the owner

Every decision the owner needs to make is a structured approval row, always under a parent task. Do NOT freelance a DM asking "want me to do X?" — that gets lost in chat history and has no expiry. Use create_approval and let the system track it.

WHEN TO CREATE AN APPROVAL:
- You found the meeting slot, waiting on the owner to pick → kind=slot_pick
- Someone requested a non-standard meeting length → kind=duration_override
- A scheduling rule would be violated (lunch, back-to-back, off-hours) → kind=policy_exception
- Someone asked to move the owner's lunch → kind=lunch_bump
- Booking with a person you don't have full contact info for → kind=unknown_person
- The chosen slot just conflicted → kind=calendar_conflict (usually the system creates this automatically)
- Any other yes/no/"how about X" question → kind=freeform

SHAPE:
1. If a parent task doesn't exist, create one first with create_task (type=follow_up, due_at=expiry).
2. Call create_approval with: task_id, kind, payload (kind-specific), ask_text (the DM to send the owner).
3. The ask_text is posted verbatim with an "#appr_..." token appended; the owner replies in natural language.

WHEN OWNER REPLIES:
- Read the PENDING APPROVALS section in the system prompt — that's the truth about what's open.
- Pick the approval_id that matches the reply (see binding rules in the prompt).
- Call resolve_approval with verdict in { approve, reject, amend }.
- amend is for "not this but here's an alternative" ("no but 13:30 would work") — pass the alternative in counter. The approval closes as amended and you must relay the alternative back to whoever asked (outreach DM, or create a fresh create_approval if it's another coord step).

IDEMPOTENCY:
- Creating the same (task_id, kind, payload) twice returns the existing pending approval — safe to retry.
- Once an approval is approved/rejected/amended/expired, it cannot be resolved again. Don't try.

EXPIRY:
- Default 24 hours. The expiry sweeper closes stale approvals automatically and notifies both the owner and any external requester. You don't chase.

LEGACY:
- finalize_coord_meeting still works for the slot-pick case and will auto-mark any linked approval as approved. Prefer resolve_approval(approval_id, verdict=approve, data={slot_iso}) when there's a pending slot_pick approval for the coord — it's the canonical path and it does freshness re-checks (catches stale slots) that the legacy tool does not.`;
  }
}
