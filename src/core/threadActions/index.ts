/**
 * Thread actions (v3.2.6, GitHub #14) — Maelle acts on an @mention inside a
 * channel/MPIM thread she wasn't part of: book a meeting, follow up on a
 * commitment, or answer/do the task in-thread.
 *
 * THIS MODULE is the trust control + the intent layer (the deterministic
 * pieces). The owner-presence gate is the single authorization: a mention
 * triggers an action ONLY if the owner has POSTED in that thread (decision 1 /
 * invariant 1 — "she's my own EA"). A colleague can never drive Maelle in a
 * thread the owner isn't part of.
 *
 * Channel-blindness (invariant 8) lives in the slack `message` handler (it drops
 * un-mentioned channel content). This module is reached ONLY from the
 * `app_mention` path, and reading a thread for an action is EPHEMERAL —
 * in-memory, for that turn, no capture pass / people-memory / interaction
 * writes from the read (invariant 9).
 *
 * Phase T1 (this commit): gate + intent classify, observable in logs. The
 * book / follow_up / other action flows (T3–T5) build on top.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../../config/userProfile';
import { getPersonMemory } from '../../db';
import logger from '../../utils/logger';
import { logLlmUsage } from '../../utils/usageLog';

const MODEL = 'claude-haiku-4-5-20251001';

export type ThreadActionKind = 'book' | 'follow_up' | 'other' | 'unclear';

/**
 * The owner-presence gate. Did the owner POST in this thread? His presence IS
 * the authorization for any thread action. Pure + synchronous over the already-
 * fetched thread messages — no I/O, no writes.
 */
export function ownerPostedInThread(
  messages: Array<{ user?: string }>,
  ownerSlackId: string,
): boolean {
  if (!ownerSlackId) return false;
  return messages.some(m => m.user === ownerSlackId);
}

/**
 * Classify the mention into book / follow_up / other / unclear. Mirrors the
 * classifyTurn Haiku pattern (forced structured tool-call). The mention text is
 * the primary signal; the thread is context. Fails open to 'other' (do the
 * task / answer in-thread) — never throws.
 */
export async function classifyThreadAction(params: {
  anthropic: Anthropic;
  mentionText: string;
  threadContext: string;
  profile: UserProfile;
}): Promise<ThreadActionKind> {
  const { anthropic, mentionText, threadContext, profile } = params;
  const assistantName = profile.assistant.name;
  if (!mentionText.trim()) return 'unclear';

  const system = `You classify what someone is asking ${assistantName} (an executive assistant) to do, given that they @mentioned her in a Slack thread. Output EXACTLY ONE call to classify_thread_action. No prose.

- book      — set up / schedule / find a time for a meeting with the people in this thread ("find us 45 min next week", "book a sync", "get us all on a call").
- follow_up — chase a commitment surfaced in the thread ("follow up on this", "make sure X gets done", "this is important — track it").
- other     — anything else to do or answer in the thread: summarize, research, answer a question, draft something ("summarize the latest on Acme here", "what do you think?").
- unclear   — the mention carries no actionable ask (a laugh, an emoji, pure ambiguity).

THREAD (context — who said what):
${threadContext.slice(0, 4000)}`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 80,
      system,
      tools: [{
        name: 'classify_thread_action',
        description: 'Classify the thread mention.',
        input_schema: {
          type: 'object' as const,
          properties: { action: { type: 'string', enum: ['book', 'follow_up', 'other', 'unclear'] } },
          required: ['action'],
        },
      }],
      tool_choice: { type: 'tool', name: 'classify_thread_action' },
      messages: [{ role: 'user', content: mentionText.slice(0, 2000) }],
    });
    logLlmUsage('classify_thread_action', MODEL, resp);
    const tu = resp.content.find((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
    const action = (tu?.input as { action?: ThreadActionKind } | undefined)?.action;
    if (action && (['book', 'follow_up', 'other', 'unclear'] as const).includes(action)) {
      logger.info('thread-action — classified', { action, preview: mentionText.slice(0, 80) });
      return action;
    }
  } catch (err) {
    logger.warn('classifyThreadAction threw — defaulting to other', { err: String(err).slice(0, 200) });
  }
  return 'other';
}

// ── Roster + action directive (T3/T4/T5) ─────────────────────────────────────
// CODE owns the deterministic pieces: who's in the thread, who's a VIP (their
// calendar always gates the time), who's invite-only (annotated, never gating).
// The booking judgment / warm voice / citation is encoded as a directive the
// orchestrator executes through the EXISTING engine (coord, outreach, news) —
// reuse, don't reinvent. The owner-presence gate (above) has already passed
// before any of this runs.

export interface ThreadRosterMember {
  slackId: string;
  name: string;
  email?: string;
  isVip: boolean;
}

/**
 * Resolve the thread roster READ-ONLY (getPersonMemory — never resolvePerson,
 * which would create rows; the app_mention path already upserted participants).
 * Excludes the owner (the principal) and any id with no usable row falls back to
 * the raw id. Invariant 9: reading the thread persists nothing new here.
 */
export function buildThreadRoster(participantIds: string[], ownerSlackId: string): ThreadRosterMember[] {
  const out: ThreadRosterMember[] = [];
  const seen = new Set<string>();
  for (const id of participantIds) {
    if (!id || id === ownerSlackId || seen.has(id)) continue;
    seen.add(id);
    const row = getPersonMemory(id);
    out.push({
      slackId: id,
      name: row?.name ?? id,
      email: row?.email,
      isVip: row?.is_vip === 1,
    });
  }
  return out;
}

/**
 * Build the thread-action directive injected into the orchestrator turn. Carries
 * the roster + VIP annotations (code-derived) and the path-specific rules
 * (judgment). The owner is in the thread → Maelle acts with his authority,
 * inside his rules, and shadows him after.
 */
export function buildThreadActionDirective(
  action: ThreadActionKind,
  roster: ThreadRosterMember[],
  profile: UserProfile,
): string {
  const ownerFirst = profile.user.name.split(' ')[0];
  const vips = roster.filter(r => r.isVip);
  const nonVips = roster.filter(r => !r.isVip);

  const rosterBlock = roster.length
    ? 'PEOPLE IN THIS THREAD:\n' + roster.map(r =>
        `- ${r.name}${r.email ? ` <${r.email}>` : ''} — ${r.isVip
          ? 'VIP: always include their calendar in the availability search and optimize around them'
          : 'invite-only: invite them, but their availability does NOT gate the time'}`).join('\n')
    : '';

  const header = `<<THREAD ACTION (${action}) — ${ownerFirst} is a participant in this thread, so you act with HIS authority, inside his rules, and shadow him after. Reading this thread is one-off: do NOT save memory about these people from it unless ${ownerFirst} explicitly asks. Post your result IN THIS THREAD.>>`;

  let body = '';
  if (action === 'book') {
    body = `TASK — book a meeting with the people in this thread.
- Optimize the time for ${ownerFirst}${vips.length ? ` and the VIP(s): ${vips.map(v => v.name).join(', ')}` : ''}. ALWAYS include their calendars in the availability search (find_available_slots / coordinate_meeting with their emails).
${nonVips.length ? `- ${nonVips.map(n => n.name).join(', ')} are invite-only — invite them, but a busy slot for them does NOT block the time.\n` : ''}- Propose exactly ONE best time in this thread. If an invite-only person is busy then, propose it anyway and ANNOTATE in human terms ("Tue 1pm works for everyone except ${nonVips[0]?.name ?? 'X'} — can you make it work?"). Free/busy level ONLY — never reveal what an event is.
- Re-search a nearby time (same week / ±a few days) ONLY if someone actually pushes back. Never start a fresh far-future sweep.
- Book once the thread agrees (you have ${ownerFirst}'s authority), confirm in-thread, then shadow ${ownerFirst}.`;
  } else if (action === 'follow_up') {
    body = `TASK — follow up on a commitment from this thread.
- Work out WHO owes WHAT by WHEN from the thread.
- Track it (create_task) on the committer, and DM them WARMLY (message_colleague, await_reply=true) — greeting + a little rapport + the ask, in a human voice. NEVER a robotic ticket. Use what you know about them.
- Check back around the deadline by ASKING them if it landed. On confirmation → tell ${ownerFirst}. If it goes quiet → one warm nudge, then tell ${ownerFirst}.`;
  } else if (action === 'other') {
    body = `TASK — do the one-off asked in this thread and post the result here.
- Read the whole thread as context. If it's a "what's the latest / summarize the news on X" ask, use the news tool (or web_research), write GROUNDED, and CITE the source links — never assert a current-events fact you didn't find a source for.
- Keep it tight and in-thread. Store nothing about the participants.`;
  } else {
    body = `The mention is ambiguous — ask ONE short clarifying question in this thread. Do not take an autonomous action.`;
  }

  return [header, rosterBlock, body].filter(Boolean).join('\n\n') + '\n\n';
}
