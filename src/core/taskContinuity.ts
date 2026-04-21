/**
 * Same-thread task continuity classifier (v2.0.3).
 *
 * Problem being solved: the owner often gives multiple instructions in one
 * Slack thread. Without this check, each instruction that triggers
 * `create_task` creates a NEW row — including replies / follow-ups /
 * "and also..." additions that are really continuations of an earlier task.
 * Result: the tasks table bloats with duplicates, and briefings re-surface
 * the same topic under multiple titles.
 *
 * This module is called from the `create_task` tool handler BEFORE inserting.
 * If there's any open task in the same `owner_thread_ts`, run a tiny Sonnet
 * tool_use classifier over {new request, existing task titles/descriptions}.
 * If it's a follow-up, the caller skips creation and returns a reference to
 * the existing task so Sonnet can narrate accordingly.
 *
 * Scope: only fires when `owner_thread_ts` is the same. Cross-thread requests
 * are always treated as new (the owner explicitly started a new conversation).
 */

import type Anthropic from '@anthropic-ai/sdk';
import logger from '../utils/logger';

export interface ExistingTaskRef {
  id: string;
  type: string;
  status: string;
  title: string;
  description?: string;
  created_at: string;
}

export interface ContinuityVerdict {
  kind: 'new' | 'follow_up_of';
  existing_task_id?: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export async function classifyTaskContinuity(params: {
  newTaskTitle: string;
  newTaskDescription?: string;
  newTaskType: string;
  existingTasks: ExistingTaskRef[];
  anthropic: Anthropic;
}): Promise<ContinuityVerdict> {
  const { newTaskTitle, newTaskDescription, newTaskType, existingTasks, anthropic } = params;
  if (existingTasks.length === 0) {
    return { kind: 'new', confidence: 'high', reason: 'no existing tasks in thread' };
  }

  const existingList = existingTasks
    .map(t => `  - id: ${t.id}\n    type: ${t.type}\n    status: ${t.status}\n    title: ${t.title}${t.description ? `\n    description: ${t.description}` : ''}`)
    .join('\n');

  const prompt = `The owner just asked you to create a new task, but there are already open tasks in the same Slack thread. Decide: is this new request a FOLLOW-UP / continuation of one of the existing tasks, or is it a genuinely NEW task unrelated to what's already open?

EXISTING OPEN TASKS IN THIS THREAD:
${existingList}

NEW REQUEST:
  type: ${newTaskType}
  title: ${newTaskTitle}
${newTaskDescription ? `  description: ${newTaskDescription}` : ''}

Decide:
- kind="follow_up_of" if the new request is refining, extending, adjusting, or replying to an existing open task (e.g. existing "Book lunch with Dana on Tuesday" + new "make it Monday instead" → follow-up).
- kind="new" if the new request is about a DIFFERENT person, subject, or unrelated action (e.g. existing "Book lunch with Dana" + new "remind me to call the accountant" → new).
- If you're unsure, err on "new" with confidence=low. Better to create a duplicate than to silently merge unrelated work.

confidence=high only when it's obviously the same topic. confidence=medium when related but not identical. confidence=low when ambiguous.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      tools: [{
        name: 'classify_continuity',
        description: 'Decide whether a new task request is a follow-up on an existing open task or a genuinely new task.',
        input_schema: {
          type: 'object' as const,
          properties: {
            kind: { type: 'string', enum: ['new', 'follow_up_of'] },
            existing_task_id: { type: 'string', description: 'When kind=follow_up_of, the id of the existing task being continued. Empty string when kind=new.' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            reason: { type: 'string', description: 'One sentence explaining the call.' },
          },
          required: ['kind', 'confidence', 'reason'],
        },
      }],
      tool_choice: { type: 'tool', name: 'classify_continuity' },
      messages: [{ role: 'user', content: prompt }],
    });

    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    if (!toolUse || !toolUse.input) {
      logger.warn('taskContinuity — no tool_use in response, defaulting to new');
      return { kind: 'new', confidence: 'low', reason: 'classifier returned no verdict' };
    }
    const verdict = toolUse.input as ContinuityVerdict;
    logger.info('taskContinuity — classified', {
      kind: verdict.kind,
      confidence: verdict.confidence,
      existingId: verdict.existing_task_id,
      reason: verdict.reason,
    });
    return verdict;
  } catch (err) {
    logger.warn('taskContinuity — classifier failed, defaulting to new', { err: String(err).slice(0, 200) });
    return { kind: 'new', confidence: 'low', reason: 'classifier error' };
  }
}
