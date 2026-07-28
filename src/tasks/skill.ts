import type Anthropic from '@anthropic-ai/sdk';
import type { Skill, SkillContext } from '../skills/types';
import type { UserProfile } from '../config/userProfile';
import { DateTime } from 'luxon';
import { sendMorningBriefing } from './briefs';
import {
  createRequest,
  getRequest,
  getOpenRequestsForOwner,
  getAwaitingOwnerRequests,
  updateRequest,
  buildIdempotencyKey,
  getRequestByIdempotencyKey,
  getRecentOutreachOwnerThread,
} from '../db/requests';
import { closeRequest } from '../core/requests/closeRequest';
import { resolveRequest, renderCounter, type ResolveVerdict } from '../core/requests/resolver';
import { composeOwnerAskText } from '../core/approvals/approvalCallbacks';
import { judgeRequestDedup } from '../utils/requestDedup';
import {
  getUnseenEvents,
  markEventsSeen,
  type MaelleEvent,
} from '../db';
import type { RequestKind, RequestRow } from '../core/requests/types';
import { parseDetails, toTimerInstant } from '../core/requests/types';
import logger from '../utils/logger';
import { getAnthropicClient } from '../llm/client';
import { MODEL_HAIKU } from '../llm/models';
import { logLlmUsage } from '../utils/usageLog';

type CreateTaskType = 'reminder' | 'follow_up' | 'research';

const APPROVAL_SUBKINDS = [
  'duration_override',
  'policy_exception',
  'unknown_person',
  'freeform',
] as const;
type ApprovalSubkind = (typeof APPROVAL_SUBKINDS)[number];

const anthropic = getAnthropicClient();

/**
 * #145 (Maayan "move GTM to Wed", 2026-07-20) — calendar-freeform guard.
 * `freeform` is for NON-CALENDAR owner decisions ONLY (out-of-scope flags,
 * content review, private yes/no). A CALENDAR change — booking, moving/
 * rescheduling, adding/removing attendees, or cancelling a meeting — must go
 * through its tool → `policy_exception` carrying a replayable `deferred_action`.
 * A freeform carries NO action, so on approve NOTHING happens and the change
 * silently never lands (the empty-shell class: "Move to Wed?" approved → no
 * move, no time, no context for follow-up turns). This Haiku gate runs ONLY on
 * `freeform` and refuses a calendar-shaped one, redirecting to the structured
 * path. Meaning-detection (not regex) because the ask is bare NL and Maelle is
 * multilingual. THREE-WAY: 'calendar' → refuse + redirect; 'not_calendar' →
 * allow; 'unsure' → don't create it, have Maelle ASK (the borderline case a
 * binary would silently misjudge into an empty-shell). A classifier error routes
 * to 'unsure' (ask), NOT a silent allow — so a Haiku hiccup can't let a calendar
 * change slip through as freeform. The tool description is the primary guidance;
 * this is the enforcement that can't be regressed away in the prompt.
 */
async function classifyFreeformCalendarChange(
  question: string, context: string, subject: string,
): Promise<'calendar' | 'not_calendar' | 'unsure'> {
  const text = [subject, question, context].filter(s => s && s.trim()).join(' — ').slice(0, 600);
  if (!text.trim()) return 'not_calendar';
  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 20,
      system: `Classify an owner-approval request by whether it concerns a CALENDAR CHANGE to a meeting — booking a new meeting, moving/rescheduling an existing meeting, adding/removing attendees, or cancelling a meeting.
- 'calendar' — it clearly IS one of those.
- 'not_calendar' — it clearly is NOT (posting content, sharing info, flagging an out-of-scope request for the owner, a general non-scheduling yes/no).
- 'unsure' — genuinely ambiguous, or not enough to tell.
Judge by meaning, in any language. Bias to 'unsure' rather than guessing 'not_calendar' on a maybe — an unsure verdict just asks; a wrong 'not_calendar' silently drops a real change. Answer via the classify tool only.`,
      tools: [{
        name: 'classify',
        description: 'Classify whether the approval ask is a calendar/meeting change.',
        input_schema: {
          type: 'object' as const,
          properties: { verdict: { type: 'string', enum: ['calendar', 'not_calendar', 'unsure'] } },
          required: ['verdict'],
        },
      }],
      tool_choice: { type: 'tool', name: 'classify' },
      messages: [{ role: 'user', content: text }],
    });
    logLlmUsage('freeform_calendar_guard', MODEL_HAIKU, resp);
    const toolUse = resp.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
    const v = (toolUse?.input as { verdict?: string } | undefined)?.verdict;
    return (v === 'calendar' || v === 'not_calendar') ? v : 'unsure';
  } catch (err) {
    logger.warn('create_approval — freeform calendar guard threw; routing to UNSURE (ask, not a silent allow)', {
      err: String(err).slice(0, 200),
    });
    return 'unsure';  // fail-to-ask: an error must never silently let a calendar change ride freeform
  }
}

/**
 * The replayable action this approval is asking permission FOR, if it carries
 * one. Same shape `extractCallbacks` reads back off the row, validated here so a
 * malformed stamp can't pass as a real one.
 */
function approvalDeferredAction(
  payload: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } | null {
  const da = payload.deferred_action as { tool?: unknown; args?: unknown } | undefined;
  if (!da || typeof da.tool !== 'string' || !da.tool.trim()) return null;
  if (!da.args || typeof da.args !== 'object' || Array.isArray(da.args)) return null;
  return { tool: da.tool, args: da.args as Record<string, unknown> };
}

/**
 * The reason THIS approval exists, read from the payload fields the tool
 * description documents for its kind. Empty string = the ask states no reason.
 */
function statedApprovalReason(subkind: ApprovalSubkind, payload: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  switch (subkind) {
    case 'policy_exception':
      return s(payload.rule) || s(payload.rule_label) || s(payload.context);
    case 'duration_override':
      return s(payload.reason) || s(payload.context);
    case 'unknown_person': {
      const missing = Array.isArray(payload.missing_fields)
        ? (payload.missing_fields as unknown[]).map(s).filter(Boolean)
        : [];
      return missing.join(', ') || s(payload.reason) || s(payload.context);
    }
    case 'freeform':
      return s(payload.question) || s(payload.context);
  }
}

/** Which payload field(s) carry the reason for each kind — quoted back on refusal. */
const REASON_FIELDS: Record<ApprovalSubkind, string> = {
  policy_exception: 'payload.rule (the rule being overridden) and payload.context (why it matters)',
  duration_override: 'payload.reason (why this length instead of a standard one)',
  unknown_person: 'payload.missing_fields (what contact detail we do not have)',
  freeform: 'payload.question (the decision) and payload.context (why it needs him)',
};

/**
 * THE approval gate (S6 + S7) — the one place that decides whether an ask is
 * allowed to reach the owner at all. Runs before dedup, before the row, before
 * the DM. Returns null to let the ask through, or the refusal to hand back.
 *
 * S6 — an approval is a DEVIATION. A `policy_exception` overrides a specific
 * calendar action, so it must CARRY that action (`payload.deferred_action`).
 * That stamp is not decoration: the orchestrator copies it from the meeting
 * tool's own `_deferred_action_hint`, which only exists because a tool actually
 * refused this action this turn (index.ts:563-587). So its presence is the code's
 * proof that something really blocked the work, and its absence proves nothing
 * did — the model went straight to the owner without ever attempting the action.
 * Pre-fix that case was not refused, it was PAPERED OVER: the handler fabricated
 * a `deferred_action` from the payload (v2.9.4 auto-stamp) and DM'd the owner an
 * override for work nothing had objected to. That auto-stamp is deleted with this
 * gate — it existed only to serve the case the gate now refuses.
 *
 * Deliberately NOT keyed on re-running `checkSlot`: a clean slot does not mean
 * permitted work. `location_mode_unspecified` (online vs in person),
 * `meeting_room_unavailable_large_meeting`, a slot held for another colleague,
 * and `rule_check_failed` are all legitimate policy_exceptions on a slot that
 * breaks NO rule — refusing on "checkSlot passes" would kill every one of them.
 * And the two call sites read different inputs, so they can disagree: on
 * 2026-07-21 the write path refused B&H on travel_buffer_collision while this
 * handler's own re-check called the same slot clean (log 19:14:58 vs 19:15:06).
 * "Did a tool refuse this?" is the fact; "would checkSlot refuse it?" is a
 * second opinion, and it belongs where it already is — labelling, not gating.
 *
 * S7 — no reason, no approval. Every kind must state WHY it reached him, in the
 * field its own payload contract names, so he decides on data rather than gut.
 * The two honest outcomes when there is none are exactly the two refusals below:
 * the action was allowed (do it), or the reason isn't understood yet (find it).
 */
function gateApprovalAsk(
  subkind: ApprovalSubkind,
  payload: Record<string, unknown>,
): { error: string; reason: string } | null {
  // An off-menu kind has no payload contract, so neither of the checks below
  // means anything for it — and it would otherwise mint a row with a garbage
  // subkind that nothing downstream knows how to route.
  if (!(APPROVAL_SUBKINDS as readonly string[]).includes(subkind)) {
    return {
      error: 'unknown_kind',
      reason: `"${subkind}" is not an approval kind. Use one of: ${APPROVAL_SUBKINDS.join(' / ')}.`,
    };
  }
  if (subkind === 'policy_exception' && !approvalDeferredAction(payload)) {
    return {
      error: 'no_verified_deviation',
      reason: `Nothing refused this action, so there is nothing to override and nothing to replay if he says yes. A policy_exception is only real once a tool has actually blocked the work. Do the action instead: call create_meeting / move_meeting / update_meeting / delete_meeting with the exact time, subject and attendees. Either it is permitted and it just happens — which is the right outcome and does not cost him a decision — or the tool refuses and hands back the precise reason (broken_rule / violation_label / suggested_ask_text) plus the action itself, which rides onto your next create_approval automatically. Do not re-raise this approval before running that tool.`,
    };
  }
  if (!statedApprovalReason(subkind, payload)) {
    return {
      error: 'missing_reason',
      reason: `This ask states no reason, so it cannot reach him — he decides on data, not gut, and "${subkind}" reaching him without a why is just an interruption. Fill in ${REASON_FIELDS[subkind]} and retry. If you cannot say why this needs HIM specifically, then it does not: either the action is already allowed (do it), or you do not yet know what is blocking it (go find out first).`,
    };
  }
  return null;
}

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
- "Follow up with Anna in 3 days if she doesn't respond"
- "Check back with Ben next week"
- "Remind Cara about the board prep on Tuesday"
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
            type: { type: 'string', enum: ['reminder', 'follow_up', 'research'] },
            title: { type: 'string', description: 'Plain English title of what Maelle is doing.' },
            description: { type: 'string', description: 'More detail if needed' },
            due_at: { type: 'string', description: 'ISO 8601 datetime when to execute this task.' },
            target_slack_id: { type: 'string', description: 'If reminding someone else, their Slack user ID' },
            target_name: { type: 'string', description: 'Display name of the target person' },
            message: { type: 'string', description: 'What to say when the task fires. When reminding someone ELSE, pass the reminder CONTENT only (e.g. "the board prep deck") — Maelle adds the "<owner> asked me to remind you" framing and reports back to the owner. When reminding the owner, this is the text DM\'d to them.' },
          },
          required: ['type', 'title', 'due_at'],
        },
      },
      {
        // v2.9 — merged edit_task + cancel_task. create_task and get_my_tasks
        // stay separate (claim-checker honesty rules reference create_task by
        // name; get_my_tasks is a read with optional filter).
        name: 'update_task',
        description: `Update an existing task. Two actions:

action='edit' — change a task's title, description, due_at, message, or type. Required: task_id. Pass any subset of mutable fields.

action='cancel' — cancel a pending task. Required: task_id.

For creating a new task, use \`create_task\`. For listing tasks, use \`get_my_tasks\`.`,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['edit', 'cancel'], description: 'edit or cancel.' },
            task_id: { type: 'string', description: 'REQUIRED for both actions.' },
            title: { type: 'string', description: 'edit: optional.' },
            description: { type: 'string', description: 'edit: optional.' },
            due_at: { type: 'string', description: 'edit: optional ISO 8601 datetime.' },
            type: { type: 'string', enum: ['reminder', 'follow_up', 'research'], description: 'edit: optional task type.' },
            message: { type: 'string', description: 'edit: optional message body.' },
          },
          required: ['action', 'task_id'],
        },
      },
      {
        name: 'get_my_tasks',
        description: `Get all open tasks Maelle is currently working on or waiting on. Call this when the user asks "what tasks do you have?" or "what's pending?" or "what are you working on?"

Optional with_person filter: pass a Slack user ID to scope results to tasks involving that person. Coord tasks (multi-party meetings) are excluded from the filter since they don't have a single counterpart.

ALSO CHECK ROUTINES when the owner asks about recurring activities ("did you do my LinkedIn post?", "did the briefing run?", "weekly review this morning?").`,
        input_schema: {
          type: 'object',
          properties: {
            with_person: { type: 'string', description: 'Optional Slack user ID to filter by counterpart.' },
          },
          required: [],
        },
      },
      {
        name: 'get_briefing',
        description: `Get a summary of everything that happened since the user was last active.`,
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'send_briefing_now',
        description: `Send the morning briefing immediately as a new standalone DM — not as a reply in this thread.`,
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'create_approval',
        description: `Ask the owner for a decision. ALWAYS use this when you need the owner to decide something instead of just DMing them a question. The owner is the only one who can bypass scheduling rules — colleagues asking for something that breaks the rules MUST go through this tool. Maelle never overrides on her own.

AUTHORITY MODEL:
- If the owner tells Maelle directly to do something (even when it breaks a rule), that IS the approval — just do it, no approval needed.
- If a colleague asks for something that breaks a rule or needs an owner-only judgment, create_approval — the owner must decide.
- RELAY IT AS AN APPROVAL IN FLIGHT, NOT A DEAD END. When you raise this for a colleague, tell the requester you've SENT it to the owner (by name) to decide. If the change is theirs to make pending sign-off — e.g. the person who requested the meeting is adding attendees — say so ("you can add them — I've sent it to the owner to approve"). NEVER frame it as "the owner must make the change themselves" or "you can't change this."

Kinds:
- duration_override: approve a non-standard meeting length. Payload: { subject, duration_min, reason }.
- policy_exception: override a scheduling rule (back-to-back, off-hours, no-lunch, protected meeting, floating-block out-of-window move). Payload: { rule, context, subject, start, end, attendees, category?, is_online?, location?, body?, requester_slack_id, requester_name }. ALL the create_meeting required fields (subject, start, end, attendees) must be present in payload — the handler validates and refuses with \`missing_required_field\` if any are missing. RUN THE ACTION'S TOOL FIRST: the handler refuses with \`no_verified_deviation\` unless the action rode in from a tool that actually blocked it, because with nothing blocked there is nothing to override and nothing to replay on approve. So call create_meeting / move_meeting / update_meeting / book_floating_block for the real time and attendees — it either just happens (allowed, and the owner is never interrupted) or it comes back refused WITH the exact reason and the action attached for this approval. If you don't have a required field yet (most commonly: duration → start/end), ask the requester BEFORE running anything. HONESTY: write ask_text plainly. If the booked time hits a meeting already on the owner's calendar, NAME it ("you already have 'X' at 13:00 — book over it?") — a hard double-book is his call, but state it AS one; NEVER dress it as a soft free-time / buffer / focus-time rule. (The handler re-derives the real reason from the live calendar and leads the DM with it, so don't guess the reason from aggregate rejection lists.)
- unknown_person: book with someone we don't have full contact info for. Payload: { name, known_fields, missing_fields }.
- freeform: a NON-CALENDAR yes/no/amend ask ONLY — flag an out-of-scope request for the owner, content review, a private judgment call ("OK to share my number with X?"). Payload: { question, context, subject }. NEVER for a CALENDAR CHANGE — booking, moving/rescheduling, adding/removing attendees, or CANCELLING a meeting (a cancel is a calendar change too). The handler REFUSES a calendar-shaped freeform (\`freeform_calendar_change\`): it carries no action, so on approve NOTHING would happen and the change silently dies. Any calendar change goes through its tool FIRST — create_meeting / move_meeting / update_meeting / delete_meeting (any attendee count); if it needs sign-off the colleague-path gate raises a policy_exception with a replayable deferred_action (subject + attendees + time preserved). policy_exception is the ONLY kind whose deferred_action auto-attaches and replays — NEVER meeting_reschedule / meeting_change for a create_approval.

DEFERRED ACTION (auto-execute on approve) — v2.8.6:
When the approval is asking permission for a SPECIFIC tool call (e.g. "should I cancel Dirk's meeting?", "OK to book this off-hours?"), include payload.deferred_action so the resolver fires the action when the owner approves — instead of you having to call the tool yourself in a follow-up turn. Without this, "approved but never executed" turns happen (root of the 2026-05-18 Dirk incident).

Shape: \`payload.deferred_action = { tool: "<tool-name>", args: <full-tool-args> }\`.
Supported tools: \`create_meeting\`, \`move_meeting\`, \`update_meeting\`, \`book_floating_block\`, \`delete_meeting\`.

Cancellations: a cancel is a CALENDAR change, so raise create_approval(kind=policy_exception) — NOT freeform — with an explicit:
  payload.deferred_action = { tool: "delete_meeting", args: { meeting_id, meeting_subject } }
The handler skips the booking-field check for a delete deferred_action; the resolver calls delete_meeting the instant the owner ✅'s the DM — no second turn needed.

For policy_exception approvals raised after a rule_violation on create_meeting / move_meeting / book_floating_block, the orchestrator auto-stamps deferred_action from the prior rule_violation's hint — you don't need to set it yourself. Only a cancellation (policy_exception + a delete_meeting deferred_action, which doesn't go through rule_violation) needs you to pass deferred_action explicitly.

EVERY kind must say WHY it needs him, in its own payload field (policy_exception: rule + context · duration_override: reason · unknown_person: missing_fields · freeform: question + context). No reason → refused with \`missing_reason\`, and rightly: if you can't state why this needs HIM, either the action is already allowed (do it) or you don't yet know what's blocking it (find out first).

Behavior:
- DMs the owner immediately with ask_text. LLM-judged dedup against open requests for this (owner, requester) — if the same logical ask is already open, returns the existing one.
- Default expiry is 2 owner-workdays (Fri/Sat skipped for this profile). Owner-silent past expiry → request closes as expired + owner gets a tombstone DM.
- When approval has a colleague-originated context, include requester_slack_id in the payload so the resolver can DM the requester back with the owner's decision.`,
        input_schema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...APPROVAL_SUBKINDS] },
            payload: { type: 'object', description: 'Kind-specific payload (see tool description).' },
            ask_text: { type: 'string', description: 'The exact text to DM the owner as the approval ask.' },
            expires_in_workdays: { type: 'number', description: 'Owner-workdays until expiry. Default 2.' },
            expires_in_hours: { type: 'number', description: 'Sub-workday escape hatch.' },
          },
          required: ['kind', 'payload', 'ask_text'],
        },
      },
      {
        name: 'resolve_approval',
        description: `Record the owner's decision on a pending approval. Call this when the owner replies to an approval ask in DM.

Owner short-acks ("yes", "go", "no", "kill it") in a thread bound to a pending approval are auto-resolved BEFORE the orchestrator runs (Module D). Call this tool only when:
- the owner AMENDED ("not as asked, but try X"),
- the owner referenced a specific approval id token,
- or you need to act on an approval from a different thread.

Verdicts:
- approve: owner said yes. \`data\` is meaningful when a move/booking approval ALSO asked online-vs-in-person (external attendee, unknown timezone, office day) — pass the owner's answer as \`{ is_online: true }\` for online/Teams or \`{ is_online: false }\` for in-person, or \`{ location: "<place>" }\` for a named place. This is folded into the move/create the approval will replay, so it lands instead of re-asking. For every OTHER approval kind, \`data\` is dropped silently. If the owner wants to change the time/attendees at approve-time, use verdict='amend' with \`counter\` — never approve+data for those.
- reject: owner said a genuine NO / cancel it. This CANCELS the request AND auto-DMs the requester a decline ("<owner> can't make that work"). Use ONLY for a real no. NEVER use reject to relay a question, defer, or pass a message to the requester — reject sends them a decline and kills the whole coordination (incl. any pending booking). If the owner is still negotiating, or wants to ask the requester something, that's amend.
- amend: owner is countering, deferring, or wants to RELAY A QUESTION / MESSAGE to the requester and keep the ask alive — "no, but 13:30 would work", "tell him I'm on vacation, ask if it has to be him or someone else can cover next week", "come back to me once you check with them". Put the alternative / question / message in \`counter\`. This flips the request to awaiting_colleague, DMs the requester the counter (a question renders as "<owner> asked: …"), and keeps it OPEN + tracked so their reply reconnects. Use amend WHENEVER the instruction is relay-a-question / ask-them / defer — NOT reject.

Binding — take the explicit id token from the owner's reply; otherwise the line marked "← THIS THREAD" in PENDING APPROVALS, which renders whenever anything is pending and carries the full disambiguation rules. No anchor and several open → call list_pending_approvals and ask which one by subject; the tool refuses an unanchored bare ack.`,
        input_schema: {
          type: 'object',
          properties: {
            approval_id: { type: 'string' },
            verdict: { type: 'string', enum: ['approve', 'reject', 'amend'] },
            data: { type: 'object' },
            counter: { type: 'object' },
            reason: { type: 'string' },
          },
          required: ['approval_id', 'verdict'],
        },
      },
      {
        name: 'list_pending_approvals',
        description: 'List approvals currently waiting on the owner.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ];
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: SkillContext,
  ): Promise<unknown | null> {
    const { profile, channelId, threadTs } = context;
    const ownerUserId = profile.user.slack_user_id;

    // v2.9 — narrow merge: update_task dispatches into edit_task or cancel_task.
    // create_task and get_my_tasks stay separate (claim-checker honesty rule
    // references create_task by name; get_my_tasks is a read with optional filter).
    if (toolName === 'update_task') {
      const action = String(args.action ?? '').toLowerCase();
      if (action === 'edit')         toolName = 'edit_task';
      else if (action === 'cancel')  toolName = 'cancel_task';
      else return { error: 'bad_action', message: `update_task action must be 'edit' | 'cancel', got "${action}".` };
    }

    switch (toolName) {

      case 'create_task': {
        const taskType = args.type as CreateTaskType;
        const title = args.title as string;
        // #149 — anchor the due time to a UTC instant HERE, the boundary where a
        // model-authored wall-clock becomes a spine timer and the only place the
        // owner's zone is in hand. Pre-fix `due_at` went onto next_check_at
        // verbatim, so a bare "2026-07-27T10:32:00" only satisfied the sweep's
        // `datetime(next_check_at) <= datetime('now')` (UTC) three hours later.
        const dueAtRaw = args.due_at as string;
        const dueAt = toTimerInstant(dueAtRaw, profile.user.timezone);
        if (!dueAt) {
          return {
            error: 'bad_due_at',
            message: `due_at "${dueAtRaw}" isn't a parseable ISO 8601 datetime. Pass an owner-local wall-clock ("2026-07-27T10:32:00") or an explicit offset — I won't create a task whose timer can never fire.`,
          };
        }
        const description = args.description as string | undefined;
        const targetSlackId = args.target_slack_id as string | undefined;
        const targetName = args.target_name as string | undefined;
        const message = args.message as string | undefined;

        // Kind mapping: create_task is owner-initiated autonomous work.
        const kind: RequestKind = taskType === 'research' ? 'research' : taskType;

        // Owner-initiated → informed=1, state=in_flight (Maelle is working on it).
        // Reminders/follow-ups fire via next_check_at + handler='reminder_fire'.
        // Research uses 'research_run' — runs the full agent loop at due_at and
        // DMs the result. Both fire on the ONE spine sweep (sweepDueRequests);
        // the old tasks-table dispatchers were the duplicate path, now deleted.
        const nextCheckHandler = taskType === 'research' ? 'research_run' : 'reminder_fire';
        const row = createRequest({
          ownerUserId,
          initiatedBy: context.userId,
          initiatedByRole: 'owner',
          kind,
          subject: title,
          description,
          state: 'in_flight',
          informed: 1,
          // The reminder is an activity OWNED BY its requester (the owner
          // here — create_task is owner-path). runReminderFire reads this to
          // frame third-party reminders ("<requester> asked me to remind you").
          requesterSlackId: context.userId,
          targetSlackId,
          targetName,
          originChannel: channelId,
          originThreadTs: threadTs,
          originIsMpim: !!context.isMpim,
          expiresAt: undefined,
          nextCheckAt: dueAt,
          nextCheckHandler,
          details: { message, due_at: dueAt },
        });

        const dueDt = DateTime.fromISO(dueAt).setZone(profile.user.timezone);
        logger.info('Task created via skill', { id: row.id, type: taskType, due: dueAt });
        return {
          created: true,
          task_id: row.id,
          due: dueDt.toFormat('EEEE, d MMMM') + ' at ' + dueDt.toFormat('HH:mm'),
        };
      }

      case 'edit_task': {
        const id = args.task_id as string;
        const row = getRequest(id);
        if (!row) return { error: 'Task not found' };

        const detailsCurrent = parseDetails(row) ?? {};
        const patch: Parameters<typeof updateRequest>[1] = {};
        if (typeof args.title === 'string') patch.subject = args.title;
        if (typeof args.description === 'string') patch.description = args.description;
        // #149 — same UTC anchoring as create_task, so a rescheduled reminder
        // can't re-acquire the naive-clock delay.
        let dueAtNormalized: string | null = null;
        if (typeof args.due_at === 'string') {
          dueAtNormalized = toTimerInstant(args.due_at, profile.user.timezone);
          if (!dueAtNormalized) {
            return {
              error: 'bad_due_at',
              message: `due_at "${args.due_at}" isn't a parseable ISO 8601 datetime.`,
            };
          }
          patch.nextCheckAt = dueAtNormalized;
          patch.details = { ...detailsCurrent, due_at: dueAtNormalized };
        }
        if (typeof args.message === 'string') {
          patch.details = { ...detailsCurrent, ...(patch.details ?? {}), message: args.message };
        }
        if (Object.keys(patch).length === 0) return { updated: false, message: 'Nothing to update' };
        updateRequest(id, patch);
        logger.info('Task edited via skill', { id, fields: Object.keys(patch) });
        const result: Record<string, unknown> = { updated: true, task_id: id };
        if (dueAtNormalized) {
          const dueDt = DateTime.fromISO(dueAtNormalized).setZone(profile.user.timezone);
          result.new_due = dueDt.toFormat('EEEE, d MMMM') + ' at ' + dueDt.toFormat('HH:mm');
        }
        return result;
      }

      case 'get_my_tasks': {
        const withPerson = typeof args.with_person === 'string' && args.with_person.trim() ? args.with_person.trim() : null;
        const all = getOpenRequestsForOwner(ownerUserId);
        const filtered = withPerson
          ? all.filter(r => r.target_slack_id === withPerson || r.requester_slack_id === withPerson)
          : all;

        const hydrate = (r: RequestRow): Record<string, unknown> => {
          const det = parseDetails(r) ?? {};
          const base: Record<string, unknown> = {
            task_id: r.id,
            kind: r.kind,
            subkind: r.subkind,
            state: r.state,
            subject: r.subject,
            description: r.description,
            // #149 — next_check_at is a UTC instant (see toTimerInstant). Hand the
            // model the OWNER-LOCAL offset ISO so "due to fire today at 10:32"
            // can't come out as 07:32; still an unambiguous instant for date math.
            due_at: r.next_check_at
              ? (DateTime.fromISO(r.next_check_at).setZone(profile.user.timezone).toISO() ?? r.next_check_at)
              : null,
            requester_name: r.requester_name,
            target_name: r.target_name,
          };
          if (r.kind === 'outreach' || r.kind === 'social_outreach') {
            base.outreach = {
              colleague: r.target_name,
              colleague_slack_id: r.target_slack_id,
              message_sent: det.message ?? r.description,
              sent_at: det.sent_at ?? null,
              reply: det.reply_text ?? null,
            };
          } else if (r.kind === 'approval') {
            base.approval = {
              kind: r.subkind,
              subject: det.subject ?? r.subject,
              expires_at: r.expires_at,
            };
          }
          return base;
        };

        const awaitingOwner = filtered.filter(r => r.state === 'awaiting_owner').map(hydrate);
        const awaitingColleague = filtered.filter(r => r.state === 'awaiting_colleague').map(hydrate);
        const inFlight = filtered.filter(r => r.state === 'in_flight').map(hydrate);

        const totalOpen = awaitingOwner.length + awaitingColleague.length + inFlight.length;
        return {
          summary: {
            total: totalOpen,
            pending_your_input_count: awaitingOwner.length,
            waiting_on_others_count: awaitingColleague.length,
            active_count: inFlight.length,
            recently_done_count: 0,
          },
          pending_your_input: awaitingOwner,
          pending_approvals: awaitingOwner.filter(r => (r as any).kind === 'approval'),
          waiting_on_others: awaitingColleague,
          active_tasks: inFlight,
          recently_done: [],
          count: totalOpen,
          _note: 'Describe these to the owner USING ONLY the fields in this response. Do NOT add subjects or context remembered from past conversations or people_memory.',
        };
      }

      case 'cancel_task': {
        const id = args.task_id as string;
        const row = getRequest(id);
        if (!row) return { error: 'Task not found' };
        closeRequest({
          id,
          state: 'cancelled',
          closureReason: 'owner_cancel_task_tool',
          closedBy: 'owner',
        });
        return { cancelled: true, title: row.subject };
      }

      case 'get_briefing': {
        const events = getUnseenEvents(ownerUserId);
        const open = getOpenRequestsForOwner(ownerUserId);
        markEventsSeen(ownerUserId);
        const grouped: Record<string, MaelleEvent[]> = {};
        for (const evt of events) {
          if (!grouped[evt.type]) grouped[evt.type] = [];
          grouped[evt.type].push(evt);
        }
        logger.info('Briefing generated', { userId: ownerUserId, eventCount: events.length, openRequests: open.length });
        return {
          events,
          grouped,
          open_tasks: open,
          completed_tasks: [],
          event_count: events.length,
          task_count: open.length,
          completed_count: 0,
          nothing_new: events.length === 0 && open.length === 0,
        };
      }

      case 'send_briefing_now': {
        const app = context.app;
        if (!app) return { ok: false, reason: 'No Slack app available in this context.' };
        try {
          await sendMorningBriefing(app, context.profile, context.channelId, true, context.threadTs);
          return { ok: true };
        } catch (err) {
          logger.error('send_briefing_now failed', { err });
          return { ok: false, reason: String(err) };
        }
      }

      case 'create_approval': {
        const subkind = args.kind as ApprovalSubkind;
        const payload = (args.payload as Record<string, unknown>) ?? {};
        const askText = args.ask_text as string;

        // #145 — a CALENDAR change must never ride a freeform approval. Freeform
        // carries no action, so approving "Move GTM to Wed?" changes nothing and
        // the reschedule silently dies. Refuse it here and redirect to the tool →
        // policy_exception path (which carries a replayable deferred_action).
        // Freeform stays valid for NON-calendar asks (out-of-scope flags, content
        // review, private questions). Owner direction 2026-07-20: calendar-only kill.
        if (subkind === 'freeform') {
          const q = typeof payload.question === 'string' ? payload.question : '';
          const c = typeof payload.context === 'string' ? payload.context : '';
          const s = typeof payload.subject === 'string' ? payload.subject : '';
          const calVerdict = await classifyFreeformCalendarChange(q, c, s);
          if (calVerdict === 'calendar') {
            logger.info('create_approval — refused calendar-shaped freeform; redirecting to the structured path', {
              preview: (s || q).slice(0, 80), requesterSlackId: payload.requester_slack_id,
            });
            return {
              error: 'freeform_calendar_change',
              reason: `That's a calendar change, not a plain yes/no — a freeform approval carries no action, so on approve NOTHING would actually happen (the meeting wouldn't move/book/change). Do it through the tool: create_meeting to book, move_meeting to reschedule, update_meeting to add/remove attendees, delete_meeting to cancel. If it needs the owner's sign-off it becomes a policy_exception carrying the concrete action (real time + attendees), which replays on approve. If it's a move/book to a DAY with no time yet, run find_available_slots first (pass moving_event_ids for a move) to find when the attendees are free, THEN move/create.`,
            };
          }
          if (calVerdict === 'unsure') {
            logger.info('create_approval — freeform calendar-change ambiguous; asking before routing (no approval created)', {
              preview: (s || q).slice(0, 80), requesterSlackId: payload.requester_slack_id,
            });
            return {
              error: 'freeform_needs_clarification',
              reason: `I can't tell whether this is a calendar change or a genuine non-calendar decision, and it matters: a calendar change (book / move / reschedule / attendee edit / cancel) MUST go through the tool → policy_exception so it actually executes on approve; a real non-calendar yes/no is fine as freeform. Do NOT raise the approval yet. If the conversation makes it clear, route it now (tool → policy_exception if it touches a meeting; freeform if not). If it's genuinely unclear, ask the requester plainly — e.g. "just so I route this right, are you asking me to change something on your calendar, or is it something else?" — then act on the answer.`,
            };
          }
          // 'not_calendar' → a genuine non-calendar ask → allow; fall through.
        }

        // Boundary-validate requester_slack_id via resolveSlackId helper.
        {
          const rawId = typeof payload.requester_slack_id === 'string' ? payload.requester_slack_id : undefined;
          const rawName = typeof payload.requester_name === 'string' ? payload.requester_name : undefined;
          if (rawId !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { resolveSlackId } = require('../utils/resolveSlackId') as typeof import('../utils/resolveSlackId');
            const resolution = resolveSlackId(rawId, rawName);
            if (resolution.was_hallucinated) {
              if (resolution.slack_id) {
                payload.requester_slack_id = resolution.slack_id;
              } else {
                delete payload.requester_slack_id;
              }
            }
          }
        }

        // Capture MPIM origin so the resolver can post back to the right place.
        if (typeof payload.origin_channel !== 'string' && channelId) payload.origin_channel = channelId;
        if (typeof payload.origin_thread_ts !== 'string' && threadTs) payload.origin_thread_ts = threadTs;
        if (payload.origin_is_mpim === undefined && context.isMpim !== undefined) payload.origin_is_mpim = context.isMpim;

        // #142c — `honest_hard_reason` is the line that LEADS his decision surface,
        // so it is CODE-authored or absent: only the checkSlot re-derivation below
        // may write it. Strip whatever arrived in the payload first — the model must
        // never be able to author the sentence he decides on. (This is also why the
        // lead line can't just be read off `rule`/`rule_label`: those are
        // model-supplied by design and stay that way — an existing-event change
        // skips the re-derivation entirely and carries whatever the refusing tool
        // put there, e.g. req_1784117442212_mo7hh's model-written
        // `rule: owner_busy_collision`.)
        delete payload.honest_hard_reason;

        // ── The gate (S6 + S7) ────────────────────────────────────────────────
        // Nothing below this line runs for an ask that shouldn't reach him: no
        // row, no dedup, no DM, no slot in his signature book. See gateApprovalAsk.
        {
          const refusal = gateApprovalAsk(subkind, payload);
          if (refusal) {
            logger.info('create_approval — refused at the gate', {
              kind: subkind, error: refusal.error,
              subject: typeof payload.subject === 'string' ? payload.subject : undefined,
              start: typeof payload.start === 'string' ? payload.start : undefined,
              requesterSlackId: payload.requester_slack_id,
            });
            return { error: refusal.error, reason: refusal.reason };
          }
        }

        // Expiry: owner-workdays default (2), with sub-workday escape hatch.
        let expiresAt: string;
        if (typeof args.expires_in_hours === 'number') {
          expiresAt = DateTime.now().plus({ hours: args.expires_in_hours }).toUTC().toISO()!;
        } else {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { addWorkdays, workTimeBaseFromNow } = require('../utils/workHours') as typeof import('../utils/workHours');
          const n = typeof args.expires_in_workdays === 'number' ? args.expires_in_workdays : 2;
          const base = workTimeBaseFromNow(profile);
          expiresAt = addWorkdays(base, n, profile);
        }

        const requesterSlackId = (typeof payload.requester_slack_id === 'string' ? payload.requester_slack_id : undefined)
          ?? (context.senderRole === 'colleague' ? context.userId : undefined);
        // v2.9.4 (#107d) — when Sonnet doesn't pass requester_name, auto-populate
        // it from people_memory using requester_slack_id. Pre-fix the row stored
        // requester_name=null, and `notifyRequesterOfDecision` rendered "Hey"
        // instead of "Hey Yael" — the relay was technically delivered but
        // looked generic and got missed (root of the 2026-05-20 Yael case
        // where she didn't recognize the approval confirmation).
        let requesterName: string | undefined = typeof payload.requester_name === 'string'
          ? payload.requester_name
          : undefined;
        if (!requesterName && requesterSlackId) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getPersonMemory } = require('../db/people') as typeof import('../db/people');
          const personRow = getPersonMemory(requesterSlackId);
          if (personRow?.name) {
            requesterName = personRow.name;
            logger.info('create_approval — auto-populated requester_name from people_memory', {
              requesterSlackId, requesterName,
            });
          }
        }
        const subject =
          (typeof payload.subject === 'string' && payload.subject) ||
          (typeof payload.question === 'string' && payload.question.slice(0, 80)) ||
          `${subkind.replace(/_/g, ' ')} needs your input`;

        // v2.9.4 (#107b) — booking-kind payload enforcement. Reuses the
        // create_meeting required-field contract (subject, start, end,
        // attendees) — same object, no new type. `policy_exception` is the
        // booking-class kind that carries a loose payload validated here.
        // Non-booking kinds (freeform, etc.) stay loose per owner direction.
        //
        // When the required fields are present: validate, then auto-stamp
        // payload.deferred_action with { tool: 'create_meeting', args: ... }
        // so the resolver's on_approve replay books the meeting deterministically
        // (no separate Sonnet turn needed after owner approve, no thin-context
        // booking).
        //
        // When missing: return an error listing what's needed — Sonnet asks
        // the requester before retrying. Same trust model as create_meeting's
        // schema-level `required:` (which today is the canonical enforcement
        // point for booking input shape).
        if (subkind === 'policy_exception') {
          // #2.1b + Finding A (2026-07-19) — an approval whose deferred_action targets
          // an EXISTING event (edit attendees / reschedule / cancel), not a create,
          // carries the tool's own args (meeting_id + the change), NOT the create_meeting
          // booking shape. Attached by the orchestrator from the meeting tool's
          // `_deferred_action_hint` (index.ts, policy_exception-gated). So the
          // booking-field check and the #142c slot re-derivation below both skip for it
          // — they're CREATE-only. The resolver replays the tool on approve (owner-path
          // → the tool's requester gate is skipped → the change lands), and the
          // requester relay reads new_start/meeting_subject from the deferred_action
          // args → correct time, after the action. Pre-fix these rode create_approval
          // (freeform) with NO deferred_action → the pure-approve path replayed nothing
          // and notified early/empty (Maya move, Maayan add-attendees, 2026-07-19).
          const deferredTool = (payload.deferred_action as { tool?: string } | undefined)?.tool;
          const isExistingEventChange = deferredTool === 'update_meeting'
            || deferredTool === 'move_meeting'
            || deferredTool === 'delete_meeting';

          const hasSubject = typeof payload.subject === 'string' && payload.subject.trim().length > 0;
          const hasStart = typeof payload.start === 'string' && payload.start.trim().length > 0;
          const hasEnd = typeof payload.end === 'string' && payload.end.trim().length > 0;
          const attendees = payload.attendees as Array<{ email?: string; name?: string }> | undefined;
          const hasAttendees = Array.isArray(attendees) && attendees.length > 0;

          const missing: string[] = [];
          if (!hasSubject) missing.push('subject');
          if (!hasStart) missing.push('start');
          if (!hasEnd) missing.push('end');
          if (!hasAttendees) missing.push('attendees');

          if (!isExistingEventChange && missing.length > 0) {
            logger.info('create_approval — booking-kind payload missing required fields', {
              kind: subkind, missing,
            });
            return {
              error: 'missing_required_field',
              missing,
              message: `policy_exception is a meeting-booking approval — payload must include the same fields create_meeting requires: ${missing.join(', ')}. Ask the requester for what's missing (e.g. "how long do you need?" for duration) before retrying. Same shape as a regular booking — owner will approve the exact booking that fires on yes.`,
            };
          }

          // (The v2.9.4 auto-stamp that fabricated a deferred_action from the
          // payload when none was captured is DELETED — that is exactly the case
          // gateApprovalAsk now refuses, so by here the action is always the one a
          // meeting tool actually handed back.)

          // #142c (Keren, 2026-07-14) — HONESTY: re-derive the TRUE per-slot rule;
          // do NOT trust the Sonnet-supplied `rule`. Sonnet picks the ask reason
          // from find_available_slots' AGGREGATE top_reasons and can grab a SOFT
          // label (e.g. focus_time_office) when the BOOKED time actually fails on
          // a HARD one (owner_busy_collision) — the owner then approves what reads
          // as an overridable buffer nudge and gets double-booked over a real
          // meeting. checkSlot is the ONE validator (utils/scheduleRules.ts): run
          // it on the EXACT booked time and store its real reason. A hard
          // owner_busy_collision is surfaced verbatim to the owner (Rule 7 — the
          // hard conflict is always NAMED, never hidden behind a soft label);
          // genuine soft escalations (focus floor / work hours / category) keep
          // their honest soft label AND their ask prose unchanged. Skipped for an
          // existing-event change (edit / reschedule / cancel) — no slot to re-derive.
          //
          // This is a LABEL pass, never a gate — the deviation was already proven
          // upstream by the tool refusal gateApprovalAsk requires. That is why a
          // throw here (Graph hiccup) deliberately keeps the tool-supplied reason
          // and proceeds: blocking a proven escalation on a transient read would
          // cost the requester their answer and buy no honesty. And a CLEAN verdict
          // is not over-escalation either — the tool may well have refused for a
          // reason checkSlot doesn't model (location mode, room, another
          // colleague's hold, an unverifiable free/busy read), so we leave the
          // tool's reason standing and log the divergence rather than override it.
          if (!isExistingEventChange) try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getCalendarEvents } = require('../connectors/graph/calendar') as typeof import('../connectors/graph/calendar');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { checkSlot } = require('../utils/scheduleRules') as typeof import('../utils/scheduleRules');
            const tz = profile.user.timezone;
            const startDt = DateTime.fromISO(payload.start as string, { zone: tz, setZone: true }).setZone(tz);
            const events = await getCalendarEvents(
              profile.user.email,
              startDt.startOf('week').toFormat("yyyy-MM-dd'T'00:00:00"),
              startDt.endOf('week').toFormat("yyyy-MM-dd'T'23:59:59"),
              tz,
            );
            const check = checkSlot({
              profile,
              slotStartIso: payload.start as string,
              slotEndIso: payload.end as string,
              category: typeof payload.category === 'string' ? payload.category : null,
              events,
              // M12 — this label is OWNER-BOUND by construction: it lands on
              // payload.rule_label and, for a hard collision, leads his approval
              // DM. Nothing colleague-facing reads it (the colleague-path prompt
              // block surfaces subject/slots only, and the requester relay reads
              // details.subject/question). Without the explicit viewer it takes
              // the safe default and masks the colliding meeting's subject —
              // hiding his own calendar from him at the exact moment he's being
              // asked to book over it.
              viewer: 'owner',
            });
            if (!check.passes && check.violation_label) {
              const sonnetRule = typeof payload.rule === 'string' ? payload.rule : null;
              payload.rule = check.violation_kind ?? payload.rule;
              payload.rule_label = check.violation_label;
              // Rule 7 — a HARD busy collision MUST be named to the owner. Persist it
              // as its own structured field so the DM leads with the real reason (soft
              // rules leave the ask as-is) — and so does every LATER surface that puts
              // this same ask in front of him. It rides `details` (payload becomes
              // details_json below, and every downstream details write spreads the
              // existing object), NOT `description`: description is read by the brief,
              // the dedup judge, the runner and get_my_tasks, and an owner-voiced
              // sentence naming a private meeting's subject must not enter those.
              if (check.violation_kind === 'owner_busy_collision') {
                payload.honest_hard_reason = check.violation_label;
              }
              if (sonnetRule !== (check.violation_kind ?? null)) {
                logger.info('create_approval — re-derived policy_exception reason differs from Sonnet-supplied', {
                  subject: payload.subject, start: payload.start,
                  sonnetRule, derivedRule: check.violation_kind,
                });
              }
            } else if (check.passes) {
              logger.info('create_approval — slot breaks no scheduling rule; keeping the refusing tool\'s reason', {
                subject: payload.subject, start: payload.start, toolRule: payload.rule,
              });
            }
          } catch (err) {
            logger.warn('create_approval — reason re-derivation threw; keeping the refusing tool\'s reason', {
              err: String(err).slice(0, 200),
            });
          }
        }

        // ── Dedup via LLM judge ──────────────────────────────────────────────
        // Check open requests for this (owner, requester) before inserting.
        // Same logical ask within 48h → return existing instead of fresh row.
        let existingId: string | null = null;
        if (requesterSlackId) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getDb } = require('../db/client') as typeof import('../db/client');
          const candidates = getDb().prepare(`
            SELECT * FROM requests
            WHERE owner_user_id = ?
              AND requester_slack_id = ?
              AND state IN ('awaiting_owner','awaiting_colleague','in_flight')
              AND datetime(created_at) >= datetime('now', '-48 hours')
            ORDER BY created_at DESC
            LIMIT 8
          `).all(ownerUserId, requesterSlackId) as RequestRow[];
          if (candidates.length > 0) {
            const judged = await judgeRequestDedup({
              proposed: { kind: 'approval', subkind, subject, description: askText },
              candidates,
              requesterName,
            });
            if (judged.match === 'existing' && judged.existing_id) {
              existingId = judged.existing_id;
              logger.info('create_approval — LLM dedup matched existing', {
                existingId, reasoning: judged.reasoning,
              });
            }
          }
        }

        // v2.9.2 — re-ask revival. When dedup matches an open approval AND
        // the requester is asking AGAIN, the request has been sitting cold:
        // ${owner} got the original DM hours ago, it's buried, no fresh
        // signal nudges him. Re-surface it + re-stamp terminal_dm_msg_ts so
        // Module D and the approval-bound thread lock bind to the new message.
        // Threshold: 2 hours since last_surfaced_at (or created_at if never
        // surfaced).
        // #45 — the re-surface goes into TODAY's decision thread (postOwnerDecision),
        // not a fresh top-level DM and not the day the ask was first raised: if it
        // needs his signature today it belongs in today's book. The row's owner_dm_*
        // pointers are re-stamped to wherever it just landed, so a typed reply there
        // still binds (threadBoundApprovalAutoResolve matches on owner_dm_thread_ts).
        const REVIVAL_THRESHOLD_HOURS = 2;
        const maybeRevive = async (existing: RequestRow): Promise<void> => {
          // Only revive on awaiting_owner — awaiting_colleague is a pending
          // counter (the colleague IS the one being waited on, no point
          // re-pinging owner).
          if (existing.state !== 'awaiting_owner') return;
          const lastSurfacedIso = existing.last_surfaced_at ?? existing.created_at;
          const lastSurfacedMs = lastSurfacedIso
            ? DateTime.fromSQL(lastSurfacedIso, { zone: 'utc' }).toMillis()
            : 0;
          const hoursSince = (Date.now() - lastSurfacedMs) / (1000 * 60 * 60);
          if (!Number.isFinite(hoursSince) || hoursSince < REVIVAL_THRESHOLD_HOURS) return;

          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getConnection } = require('../connections/registry') as typeof import('../connections/registry');
            const conn = getConnection(ownerUserId, 'slack');
            if (!conn) {
              logger.warn('create_approval revival — no Slack connection', { requestId: existing.id });
              return;
            }
            // The SAME composer the first raise uses — this is the second surface
            // where a ✅ resolves the approval (terminal_dm_msg_ts is re-stamped
            // below), so it carries the same parts in the same order: the proven
            // hard reason, the ask, and what a yes actually does. Pre-fix it posted
            // the bare `description` — which is only the ask prose — so the one
            // message he could sign named neither the double-book he was overriding
            // nor the booking it would fire, and #45 had already moved it into
            // TODAY's thread, days away from the full-text original.
            const requesterFirst = existing.requester_name?.split(' ')[0] ?? 'they';
            const reviveText = await composeOwnerAskText({
              askText: existing.description ?? existing.subject,
              details: parseDetails(existing),
              profile,
              requestId: existing.id,
              lead: `${requesterFirst} just asked again about this — still need your call:`,
              reSurface: { raisedAt: existing.created_at },
            });
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { postOwnerDecision } = require('../utils/ownerDailyThread') as
              typeof import('../utils/ownerDailyThread');
            const res = await postOwnerDecision({
              profile, conn, text: reviveText, label: 'approval re-ask revival',
            });
            if (res.ok) {
              const nowIso = new Date().toISOString();
              updateRequest(existing.id, {
                ownerDmChannel: res.channel ?? existing.owner_dm_channel ?? undefined,
                ownerDmThreadTs: res.threadTs ?? existing.owner_dm_thread_ts ?? undefined,
                terminalDmMsgTs: res.ts ?? existing.terminal_dm_msg_ts ?? undefined,
                lastSurfacedAt: nowIso,
                surfacedCount: (existing.surfaced_count ?? 0) + 1,
              });
              logger.info('create_approval — revived stale approval via re-ask', {
                requestId: existing.id,
                hoursSinceLastSurface: hoursSince.toFixed(2),
                surfacedCount: (existing.surfaced_count ?? 0) + 1,
              });
            }
          } catch (err) {
            logger.warn('create_approval revival — threw, non-fatal', {
              requestId: existing.id, err: String(err).slice(0, 200),
            });
          }
        };

        if (existingId) {
          const existing = getRequest(existingId)!;
          await maybeRevive(existing);
          return {
            ok: true,
            approval_id: existing.id,
            created: false,
            expires_at: existing.expires_at,
            kind: subkind,
            reused_existing: true,
          };
        }

        // Idempotency key as deterministic fallback (unique constraint at insert).
        let idempotencyKey = buildIdempotencyKey({
          ownerUserId,
          requesterSlackId: requesterSlackId ?? null,
          kind: 'approval',
          subject,
        });
        const idempotent = getRequestByIdempotencyKey(idempotencyKey);
        if (idempotent) {
          const priorTerminal = idempotent.state === 'resolved'
            || idempotent.state === 'cancelled'
            || idempotent.state === 'expired';
          if (!priorTerminal) {
            // Live duplicate of the SAME still-open ask — reuse it (re-surface if stale).
            logger.info('create_approval — reusing OPEN idempotency match', {
              existingId: idempotent.id, state: idempotent.state, subject, requesterSlackId,
            });
            await maybeRevive(idempotent);
            return {
              ok: true,
              approval_id: idempotent.id,
              created: false,
              expires_at: idempotent.expires_at,
              kind: subkind,
              reused_existing: true,
            };
          }
          // Bug 2.2 (Maayan "Offensive GTM Q&A", 2026-07-15) — the match is
          // TERMINAL (resolved/cancelled/expired): a decided ask from a PAST turn,
          // not a live duplicate. Silently reusing it here swallowed a real
          // re-escalation (no new request, no owner DM) and left Sonnet claiming
          // "I've flagged it" — false. The LLM dedup above deliberately ignores
          // closed rows for exactly this reason; the deterministic key fallback
          // must too. Mint a FRESH key (base + the owner-local re-ask DAY) so the
          // fresh approval actually inserts and reaches the owner. The day suffix
          // keeps dedup honest at both ends: a same-turn / same-day retry re-derives
          // the SAME key → collides at insert → the catch below reuses the now-open
          // row instead of double-DMing; a genuine re-ask on a LATER day gets a
          // fresh key → a fresh approval (not a stale tombstone). (This path also
          // fires for a genuine attendee-change escalation whose subject matches an
          // earlier booking approval — same subject hashes to the same base key; the
          // fresh key lets it through. Bug 2.1's escalate wording + the invalid
          // `meeting_change` subkind live in ops.ts — routed to the meeting chat.)
          const reAskDay = DateTime.now().setZone(profile.user.timezone).toFormat('yyyy-MM-dd');
          logger.info('create_approval — prior idempotency match is TERMINAL; raising a fresh approval', {
            priorId: idempotent.id, priorState: idempotent.state, reAskDay, subject, requesterSlackId,
          });
          idempotencyKey = `${idempotencyKey}:re:${reAskDay}`;
        }

        // Midpoint reminder + expiry — one schedule on the request row.
        // The reminder dispatcher re-arms next_check to expiry when it fires.
        const expiresMs = Date.parse(expiresAt);
        const createdMs = Date.now();
        const midIso = expiresMs > createdMs + 60_000
          ? new Date(createdMs + Math.floor((expiresMs - createdMs) / 2)).toISOString()
          : null;
        const nextCheckAt = midIso ?? expiresAt;
        const nextCheckHandler = midIso ? 'approval_reminder' : 'expiry';

        // v2.9.4 (#106) — graceful UNIQUE collision handling. The
        // idempotency_key is `hash(ownerUserId, requesterSlackId, kind, subject)`.
        // When Sonnet retries create_approval with the same logical ask
        // (e.g. Yael adding duration after the initial escalation), the
        // insert hits the unique constraint. Pre-fix the SqliteError
        // propagated up, the orchestrator's tool dispatch threw, and
        // Sonnet got no useful result → went silent on the requester.
        // Now: catch the constraint error, look up the existing row by
        // idempotency_key (same path the LLM-judged dedup uses), and
        // return `reused_existing: true` so Sonnet's chain continues
        // and she can surface honestly to both parties.
        // v3.1.7 — if this approval is a colleague's message being raised to the
        // owner AND that colleague has a recent owner-outreach (the owner asked
        // them for feedback/something), relay the owner DM into the owner's
        // ORIGINAL conversation thread instead of a new top-level DM. The
        // outreach recorded the owner's return thread in owner_dm_*.
        const relayOwner = context.senderRole !== 'owner' && context.userId
          ? getRecentOutreachOwnerThread(ownerUserId, context.userId)
          : null;

        let row;
        try {
          row = createRequest({
            ownerUserId,
            initiatedBy: context.userId,
            initiatedByRole: context.senderRole === 'owner' ? 'owner' : 'colleague',
            kind: 'approval',
            subkind,
            subject,
            description: askText,
            state: 'awaiting_owner',
            requesterSlackId,
            requesterName,
            originChannel: channelId,
            originThreadTs: threadTs,
            originIsMpim: !!context.isMpim,
            ownerDmChannel: relayOwner?.owner_dm_channel,
            ownerDmThreadTs: relayOwner?.owner_dm_thread_ts,
            expiresAt,
            nextCheckAt,
            nextCheckHandler,
            idempotencyKey,
            details: {
              ...payload,
            },
          });
        } catch (err) {
          const errMsg = String(err);
          const isUniqueViolation = errMsg.includes('UNIQUE constraint failed')
            && errMsg.includes('idempotency_key');
          if (!isUniqueViolation) throw err;  // unrelated error — propagate

          const existing = getRequestByIdempotencyKey(idempotencyKey);
          if (!existing) {
            // Shouldn't happen — UNIQUE fired but lookup misses. Re-throw
            // so we don't silently swallow a real bug.
            throw err;
          }
          const isClosed = existing.state === 'resolved'
            || existing.state === 'cancelled'
            || existing.state === 'expired';
          if (isClosed) {
            // Same ask was already decided in a previous turn (resolved /
            // cancelled / expired). Don't re-open or re-create — return a
            // tombstone signal so Sonnet narrates "this was already
            // handled" instead of crashing on the UNIQUE violation.
            logger.info('create_approval — UNIQUE collision on CLOSED row, returning tombstone', {
              existingId: existing.id, state: existing.state, requesterSlackId, subject,
            });
            return {
              ok: true,
              approval_id: existing.id,
              created: false,
              expires_at: existing.expires_at,
              kind: subkind,
              reused_existing: true,
              already_closed: true,
              closed_state: existing.state,
              hint: `This ask was already handled — original approval is ${existing.state}. Acknowledge to the requester instead of re-raising the same approval.`,
            };
          }
          logger.info('create_approval — UNIQUE collision on OPEN row, returning existing', {
            existingId: existing.id, state: existing.state, requesterSlackId, subject,
          });
          await maybeRevive(existing);
          return {
            ok: true,
            approval_id: existing.id,
            created: false,
            expires_at: existing.expires_at,
            kind: subkind,
            reused_existing: true,
            hint: 'This requester already has an open approval for this ask. They may be following up — the original is still awaiting decision.',
          };
        }

        // DM the owner. terminal_dm_msg_ts gets stamped from the response so
        // emoji ✅ on this DM resolves.
        //
        // The ask is composed ONCE, by the ONE composer every decision surface
        // shares (composeOwnerAskText) — and that single composition IS the fix.
        // Pre-fix the text was assembled twice HERE: a base (hard reason + ask)
        // and then a REBUILD from askText alone to append the consequence, which
        // silently undid #142c on the one surface where he actually decides. It
        // undid it EVERY time, not occasionally: gateApprovalAsk refuses a
        // policy_exception without a deferred_action, extractCallbacks aliases
        // that to on_approve, and buildConsequenceText returns non-null for every
        // on_approve — so a hard-collision ask always had a consequence line to be
        // rebuilt by, and the named double-book was always the part thrown away.
        // The revival is the same ask on the same terms, so it calls the same
        // composer; a second assembly site is how that class of drift returns.
        const dmText = await composeOwnerAskText({
          askText, details: parseDetails(row), profile, requestId: row.id,
        });

        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getConnection } = require('../connections/registry') as typeof import('../connections/registry');
          const conn = getConnection(ownerUserId, 'slack');
          if (conn) {
            // Where the owner sees this ask:
            //   • Outreach continuation (Finding A, 2026-07-19) — a colleague's reply
            //     to a recent owner outreach → post into the owner's ORIGINAL thread
            //     (relayOwner, from the outreach's recorded owner_dm_thread_ts) so the
            //     reply stays in THAT conversation. Pre-fix relayOwner was computed +
            //     stamped on the row, then the daily-thread post below OVERWROTE it —
            //     Oran's LinkedIn reply detached onto the daily approval thread.
            //   • Otherwise — the owner's ONE daily decision thread (v3.4.6 spine
            //     collapse; lazily created, day-key honors day_boundary_hour so a 1am
            //     ask lands on the prior workday's thread).
            // Either way: terminal_dm_msg_ts = THIS message's ts (✅ resolves per
            // message); owner_dm_thread_ts = the thread we posted into (typed replies
            // route via content attribution + the bare-ack anchor gate).
            // #45 — both branches now run through postOwnerDecision, the ONE
            // owner-facing decision post path, so the daily thread stops being
            // something each call site has to remember.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { postOwnerDecision } = require('../utils/ownerDailyThread') as
              typeof import('../utils/ownerDailyThread');
            const res = await postOwnerDecision({
              profile, conn, text: dmText, label: 'approval ask',
              inThread: (relayOwner?.owner_dm_channel && relayOwner.owner_dm_thread_ts)
                ? { channel: relayOwner.owner_dm_channel, threadTs: relayOwner.owner_dm_thread_ts }
                : null,
            });
            if (res.ok) {
              updateRequest(row.id, {
                ownerDmChannel: res.channel ?? undefined,
                ownerDmThreadTs: res.threadTs ?? undefined,
                terminalDmMsgTs: res.ts ?? undefined,
              });
            } else {
              logger.error('create_approval — owner ask post failed', {
                requestId: row.id, reason: res.reason,
              });
            }
          } else {
            logger.warn('create_approval — no Slack connection registered', { requestId: row.id });
          }
        } catch (err) {
          logger.error('create_approval — DM to owner threw', { err: String(err), requestId: row.id });
        }

        return {
          ok: true,
          approval_id: row.id,
          created: true,
          expires_at: expiresAt,
          kind: subkind,
          reused_existing: false,
        };
      }

      case 'resolve_approval': {
        // v3.0.5 — strip leading `#` defensively. Prompt no longer prefixes
        // ids with `#`, but Sonnet's older cached context might still have
        // `#req_…` lines in flight, and other future callers might prepend
        // out of habit. Pre-fix this silently no-op'd: getRequest('#req_…')
        // returned null, resolver early-returned with no log, approval state
        // never changed, claim-checker eventually caught the lie hours later.
        const requestId = ((args.approval_id as string) ?? '').replace(/^#/, '');
        const verdict = args.verdict as 'approve' | 'reject' | 'amend';

        // v2.9.1 — colleague-path is permitted ONLY when the targeted request
        // is in state=awaiting_colleague (an amending approval where Maelle
        // relayed owner's counter back to the requester). Any other case is
        // owner-only.
        if (context.senderRole !== 'owner') {
          const probe = getRequest(requestId);
          if (!probe) {
            return { error: 'not_found', reason: `Request ${requestId} not found.` };
          }
          // Verify the row is actually an approval. If a colleague typed the
          // approval_id of a coord_job (kind='coord') or other non-approval
          // request, the resolver would close it under approval semantics
          // and the owner would think the coord was still running. The
          // colleague-path resolves only kind='approval' rows.
          if (probe.kind !== 'approval') {
            logger.warn('Colleague attempted resolve_approval on non-approval kind — blocked', {
              userId: context.userId, requestId, kind: probe.kind,
            });
            return { error: 'not_permitted', reason: 'That id is not an approval — only approvals can be resolved through this tool.' };
          }
          if (probe.state !== 'awaiting_colleague') {
            logger.warn('Colleague attempted resolve_approval on non-amending state — blocked', {
              userId: context.userId, requestId, state: probe.state,
            });
            return { error: 'not_permitted', reason: 'Only the owner can resolve approvals (except amending state).' };
          }
          // Also verify the colleague IS the requester on this row — prevents a
          // random colleague from approving someone else's amending approval.
          if (probe.requester_slack_id && probe.requester_slack_id !== context.userId) {
            logger.warn('Colleague attempted resolve_approval but is not the requester', {
              userId: context.userId, requestId, requesterSlackId: probe.requester_slack_id,
            });
            return { error: 'not_permitted', reason: 'Only the original requester can respond to an amending approval.' };
          }
        }

        // v3.7.2 — cross-thread bare-ack anchor gate (GH #137/#140). On the
        // owner path a bare approve/reject must be ANCHORED to the approval it
        // resolves: the owner is replying in the approval's own DM thread
        // (terminal_dm_msg_ts) or the daily decision thread (owner_dm_thread_ts).
        // Pre-fix the owner-path prompt injected ALL awaiting_owner approvals
        // with no thread scoping and nudged "pick the most recently created", so
        // a bare "Yes" typed in an UNRELATED thread — a fire-and-forget shadow
        // offer that has no request row of its own — bound to the only pending
        // approval and booked it (Athena, 2026-07-13 10:07; the owner meant a
        // lunch-bump offer in another thread). Module D and the orchestrator's
        // thread-lock both correctly declined on the mismatch; this is the same
        // gate at the tool chokepoint, where Sonnet's free-bind lands. `amend`
        // carries a specific counter (never a stray ack) and is exempt.
        if (context.senderRole === 'owner' && verdict !== 'amend') {
          const ownerRow = getRequest(requestId);
          if (ownerRow) {
            const anchored = !!context.threadTs
              && (context.threadTs === ownerRow.terminal_dm_msg_ts
                || context.threadTs === ownerRow.owner_dm_thread_ts);
            if (!anchored) {
              logger.warn('resolve_approval — bare ack not anchored to the approval thread; refusing to bind', {
                requestId, verdict, threadTs: context.threadTs,
                terminalDm: ownerRow.terminal_dm_msg_ts, ownerDaily: ownerRow.owner_dm_thread_ts,
              });
              return {
                ok: false,
                needs_clarification: true,
                reason: `Not anchored: this reply isn't in ${requestId}'s decision thread (neither its own DM thread nor a daily approval thread), so a bare yes/no is too ambiguous to bind here — the owner may be responding to something else in this thread. Do NOT resolve it. Tell him you're not sure which approval he means, name the open ones by subject, and ask him to confirm in the approval's own thread (or the daily decision thread).`,
              };
            }
          }
        }

        let decision: ResolveVerdict;
        if (verdict === 'approve') {
          decision = { verdict: 'approve', data: (args.data as Record<string, unknown>) ?? {} };
        } else if (verdict === 'reject') {
          decision = { verdict: 'reject', reason: args.reason as string | undefined };
        } else if (verdict === 'amend') {
          const counter = (args.counter as Record<string, unknown>) ?? {};
          // #153 — the gate is RELAYABILITY, not key-count. A counter that renders
          // to nothing reaches the requester as "Idan suggested a different
          // approach." with the decision missing, and leaves nothing for a later ✅
          // to replay. Gated on the SAME renderer the relay uses, so the tool can
          // never store a counter the relay would swallow.
          //
          // #153-followup — and the same call answers the other half: a key the relay
          // would have to WITHHOLD (it carries one of our own req_/task_/out_/ci_
          // ids) is refused HERE, before the counter is stored. That keeps the id out
          // of a colleague's DM and out of the replayed args, without the relay ever
          // having to drop a decided value quietly.
          const relay = renderCounter(counter, { audience: 'requester' });
          if (relay.withheld.length > 0) {
            return {
              error: 'unrelayable_counter',
              reason: `verdict=amend can't carry an internal identifier to a colleague — counter key(s) ${relay.withheld.join(', ')} hold one of our own request/task ids, which mean nothing to them. Drop those keys (or restate the value in human terms) and send the counter again: the owner's alternative in \`counter\`, his words in \`reason\`.`,
            };
          }
          if (!relay.text) {
            return {
              error: 'missing_counter',
              reason: 'verdict=amend needs a counter the requester can actually act on — put the owner\'s alternative in `counter` (e.g. {"duration_min": 55}) and his words in `reason`.',
            };
          }
          decision = { verdict: 'amend', counter, reason: args.reason as string | undefined };
        } else {
          return { error: 'bad_verdict', reason: `Unknown verdict "${verdict}".` };
        }

        try {
          const result = await resolveRequest(requestId, decision, {
            app: context.app,
            profile: context.profile,
            // v3.1.3 — the colleague-path (senderRole !== 'owner') is permitted
            // only for amending approvals; that's the one case where a reject/
            // amend should bounce back to the owner. An OWNER reject must close.
            resolvedByColleague: context.senderRole !== 'owner',
            // v3.4.7 — reverse-order double-notify guard: if Sonnet already
            // successfully message_colleague'd the requester this turn, the
            // resolver skips its own relay (they were already told).
            alreadyMessagedRequesterIds: context.messagedColleaguesOkThisTurn,
          });
          // v3.4.7 — tell Sonnet the canonical close-loop already ran, so she
          // doesn't reach for message_colleague to tell the SAME requester the
          // SAME outcome (the double-notify: a second DM in a new thread, Ayala
          // Geni 2026-06-22). requester_notified is true when the relay landed
          // (requester_notified_at stamped) or the amend counter was relayed
          // (state=awaiting_colleague). The orchestrator also hard-suppresses a
          // same-turn message_colleague to that requester — this is the nudge.
          let requesterNotified = false;
          try {
            const fresh = getRequest(result.request_id);
            requesterNotified = !!(fresh?.requester_slack_id
              && (fresh.requester_notified_at || fresh.state === 'awaiting_colleague'));
          } catch { /* best-effort nudge */ }
          // Surface as approval_id for tool-API back-compat.
          return {
            ...result,
            approval_id: result.request_id,
            requester_notified: requesterNotified,
            ...(requesterNotified
              ? { _note: 'I already closed the loop with the requester in their existing thread. Do NOT message_colleague them about this outcome — that lands as a duplicate DM in a new thread. Reference the close-loop that already went out.' }
              : {}),
          };
        } catch (err) {
          logger.error('resolve_approval threw', { err: String(err), requestId });
          return { ok: false, reason: `resolver threw: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      case 'list_pending_approvals': {
        const rows = getAwaitingOwnerRequests(ownerUserId);
        return {
          count: rows.length,
          approvals: rows.map(r => ({
            id: r.id,
            kind: r.subkind ?? r.kind,
            task_id: r.id,
            created_at: r.created_at,
            expires_at: r.expires_at,
            payload: parseDetails(r) ?? {},
          })),
        };
      }

      default:
        return null;
    }
  }

  getSystemPromptSection(_profile: UserProfile): string {
    return `## TASKS

Every future action becomes a task. When asked to remind, follow up, check back, research, or do anything at a future time — create a task.

TASK LIFECYCLE (v2.7.0 — single state machine on the requests spine):
- awaiting_owner   → waiting for your call (most approvals start here)
- awaiting_colleague → waiting on a colleague reply
- in_flight        → Maelle is working (research running, reminder scheduled, coord still collecting)
- resolved         → done normally (terminal)
- cancelled        → owner dropped (terminal)
- expired          → no action within window (terminal)

WHEN TO CREATE TASKS:
- "Remind me about X tomorrow" → create_task type=reminder
- "Follow up with Yael in 3 days" → create_task type=follow_up
- "Research Y and send me a summary" → create_task type=research
- Coordination and outreach tasks are created automatically by their respective tools.

TASK RULES:
- Always confirm task creation to the user with the scheduled date/time.
- Before creating, check get_my_tasks to avoid duplicates.
- When asked "what's pending?" → call get_my_tasks.
- Tasks created in a private DM are never surfaced in group conversations.
- edit_task to modify; don't cancel + recreate.

MORNING BRIEFING:
When the user changes their briefing time, call learn_preference with category="scheduling", key="briefing_time", value="HH:MM". Owner-initiated brief requests are routed deterministically to send_briefing_now BEFORE the orchestrator runs.

## APPROVALS — structured decisions from the owner

Every decision the owner needs to make is a request of kind=approval. Do NOT freelance a DM asking "want me to do X?" — that gets lost in chat history and has no expiry. Use create_approval and let the system track it.

WHEN TO CREATE AN APPROVAL:
- Someone requested a non-standard meeting length → kind=duration_override
- A scheduling rule would be violated, OR a meeting needs to be moved / attendees changed / cancelled with owner sign-off → kind=policy_exception (carry payload.deferred_action — create_meeting / move_meeting / update_meeting / delete_meeting — so the change fires on approve)
- Booking with a person you don't have full contact info for → kind=unknown_person
- A NON-CALENDAR yes/no (out-of-scope flag, content review, private judgment) → kind=freeform. A CALENDAR change NEVER uses freeform — the handler refuses it; route it through the tool → policy_exception above.

WHEN OWNER REPLIES:
- Read the PENDING APPROVALS section in the system prompt — that's the truth about what's open.
- Pick the approval_id that matches the reply.
- Call resolve_approval with verdict in { approve, reject, amend }.
- amend = "not this but here's an alternative" — pass the alternative in counter.

DEDUP: create_approval calls are LLM-judged against open requests for this (owner, requester). The same logical ask within 48h returns the existing request — safe to retry, no duplicate rows.

EXPIRY: default 2 owner-workdays. Owner-silent past expiry → request expires and you DM a closure note. You don't chase manually.`;
  }
}
