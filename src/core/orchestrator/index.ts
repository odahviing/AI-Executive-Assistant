import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../../llm/client';
import { config } from '../../config';
import { buildSystemPromptParts } from './systemPrompt';
import { classifyTurn, type OwnerIntentClassification } from '../social/classifyTurn';
import { chooseSocialDirective, formatDirectiveForPromptBlock, type SocialDirective, noDirective } from '../social/stateMachine';
import { generateSocialCoda } from '../social/generateCoda';
import { getSkillTools, executeSkillTool } from '../../skills/registry';
import type { UserProfile } from '../../config/userProfile';
import type { SkillContext, ChannelId } from '../../skills/types';
import { auditLog, buildSocialContextBlock, getSummarySessionByThread, getOutreachLifecycle } from '../../db';
import { getActiveJobsForThread } from '../../tasks';
import { logLlmUsage } from '../../utils/usageLog';
import { DateTime } from 'luxon';
import logger from '../../utils/logger';

const anthropic = getAnthropicClient();

/**
 * Wraps anthropic.messages.create with a single retry on 429 rate-limit errors.
 * Reads the retry-after header so we wait exactly as long as the API needs.
 */
async function callClaude(
  params: Anthropic.MessageCreateParamsNonStreaming,
  retriesLeft = 1,
): Promise<Anthropic.Message> {
  try {
    const resp = await anthropic.messages.create(params) as Anthropic.Message;
    // v3.0.6 — usage logging. This wrapper is the main orchestrator loop's
    // sole API path, so one log here captures every iteration of every turn
    // — the dominant Sonnet cost. Tagged 'orchestrator'.
    logLlmUsage('orchestrator', String(params.model), resp);
    return resp;
  } catch (err: any) {
    if (err?.status === 429 && retriesLeft > 0) {
      const retryAfter = parseInt(err?.headers?.['retry-after'] ?? '30', 10);
      const waitMs = Math.min(retryAfter * 1000, 120_000); // cap at 2 min
      logger.warn('Rate limited — waiting before retry', { waitMs, retryAfter });
      await new Promise(r => setTimeout(r, waitMs));
      return callClaude(params, retriesLeft - 1);
    }
    throw err;
  }
}

/**
 * Trims conversation history to fit within token budget before sending to the API.
 * Keeps the most recent messages up to maxMessages count and maxChars total.
 * Always preserves the final user message (current turn).
 */
function trimHistory(
  messages: Anthropic.MessageParam[],
  maxChars = 12_000,
  maxMessages = 20,
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const current = messages[messages.length - 1];         // always keep current turn
  const history = messages.slice(0, -1).slice(-maxMessages); // cap message count

  // Walk backwards, accumulate until we hit char limit
  let total = 0;
  const kept: Anthropic.MessageParam[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const len = typeof history[i].content === 'string'
      ? (history[i].content as string).length
      : JSON.stringify(history[i].content).length;
    if (total + len > maxChars && kept.length >= 2) break; // always keep ≥2 for context
    total += len;
    kept.unshift(history[i]);
  }

  return [...kept, current];
}

/**
 * Build a compact one-line summary of a tool call for conversation history.
 * This lets Claude know what it did on previous turns without storing the full JSON.
 */
// v2.2.5 — outcome-aware summary for mutation tools. The claim-checker reads
// these summaries to decide if a reply's success language is honest. Without
// outcome info, a failed move_meeting looked the same as a successful one and
// "all done" got waved through. Now mutations emit OK or FAILED so the checker
// can flag false-success drafts.
function mutationOutcome(result: unknown): { ok: boolean; reason?: string; eventId?: string } {
  if (result == null || typeof result !== 'object') return { ok: false, reason: 'no_result' };
  const r = result as Record<string, unknown>;
  // Common positive shapes: { success: true, ... }, { ok: true, ... }, { meetingId: ... }, { id: ... }
  // Common negative shapes: { success: false, error: '...' }, { ok: false, reason: '...' }, { warning: '...', needs_confirmation: true }
  if (r.success === false) return { ok: false, reason: typeof r.error === 'string' ? r.error : 'tool_returned_false' };
  if (r.ok === false) return { ok: false, reason: typeof r.reason === 'string' ? r.reason : 'tool_returned_false' };
  if (r.needs_confirmation === true) return { ok: false, reason: typeof r.warning === 'string' ? r.warning : 'needs_confirmation' };
  if (r.needs_owner_approval === true) return { ok: false, reason: typeof r.reason === 'string' ? r.reason : 'needs_owner_approval' };
  if (r.success === true || r.ok === true || typeof r.meetingId === 'string' || typeof r.id === 'string' || typeof r.event_id === 'string') {
    const eventId = (r.meetingId ?? r.id ?? r.event_id) as string | undefined;
    return { ok: true, eventId };
  }
  // No clear shape — be conservative, treat as not-confirmed-success.
  return { ok: false, reason: 'unclear_result' };
}

function summarizeToolCall(toolName: string, input: Record<string, unknown>, result: unknown): string {
  try {
    // v3.0.5 — generic FAILED detection. registry.ts wraps every thrown
    // tool call in `{ error: 'Tool "X" failed: <reason>' }`, and skills also
    // return `{ error: ... }` for non-thrown refusals. Surface both as
    // `[<tool> FAILED: <reason>]` BEFORE the per-tool cases — otherwise a
    // throw-from-message_colleague would render as `[message_colleague: Yael]`
    // and the claim-checker shield treats it as success (silent-fail bug:
    // outreach DM never sent, draft "Sent the message" sneaks past the
    // checker because the tool is "in toolSummaries").
    if (result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string') {
      const reason = String((result as { error: string }).error).replace(/\s+/g, ' ').trim().slice(0, 80);
      return `[${toolName} FAILED: ${reason}]`;
    }
    switch (toolName) {
      case 'analyze_calendar': {
        const days = Array.isArray(result) ? result : [];
        const totalIssues = days.reduce((n: number, d: any) => n + (d.issues?.length ?? 0), 0);
        return `[analyze_calendar ${input.start_date}→${input.end_date}: ${days.length} days, ${totalIssues} issues]`;
      }
      case 'get_calendar': {
        const events = Array.isArray(result) ? result : [];
        return `[get_calendar ${input.start_date}→${input.end_date}: ${events.length} events]`;
      }
      case 'find_available_slots': {
        // v3.0.3 — enrich the summary with the actual slot list returned,
        // not just the input duration. Pre-fix the compact string was
        // `[find_available_slots: duration_minutes=N]` — claim-checker
        // couldn't verify specific time claims in the draft because the
        // summary carried no slot data. Now lists up to 5 slots so the
        // checker can audit "draft says 12:00 fits" against tool output.
        const slots: Array<{ start?: string; end?: string }> =
          Array.isArray(result) ? result :
          (result && typeof result === 'object' && Array.isArray((result as any).slots)) ? (result as any).slots :
          [];
        const fmt = (s: { start?: string; end?: string }) => {
          if (!s.start) return '?';
          const t = String(s.start).slice(11, 16);  // 'HH:MM'
          const d = String(s.start).slice(0, 10);   // 'YYYY-MM-DD'
          return s.end ? `${d} ${t}-${String(s.end).slice(11, 16)}` : `${d} ${t}`;
        };
        const slotList = slots.slice(0, 5).map(fmt).join(', ');
        const dur = (input as any).duration_minutes;
        const from = (input as any).search_from;
        const to = (input as any).search_to;
        const window = from && to ? ` ${String(from).slice(0, 16)}→${String(to).slice(0, 16)}` : '';
        if (slots.length === 0) {
          return `[find_available_slots${window} dur=${dur}m: 0 slots]`;
        }
        const more = slots.length > 5 ? ` +${slots.length - 5} more` : '';
        return `[find_available_slots${window} dur=${dur}m → ${slots.length} slots: ${slotList}${more}]`;
      }
      case 'find_slack_user':
        return `[find_slack_user: "${input.name}"]`;
      case 'message_colleague':
        return `[message_colleague: ${(input as any).colleague_name}]`;
      // v2.2.5 — mutation tools: read the outcome so the claim-checker sees
      // FAILED vs OK rather than just "the call ran."
      case 'create_meeting':
      case 'move_meeting':
      case 'update_meeting':
      case 'delete_meeting':
      case 'book_floating_block': {
        const outcome = mutationOutcome(result);
        // v3.4.2 (NEW-1) — NEVER fall back to meeting_id here. It was rendered
        // sliced to 40 chars with NO ellipsis, so the pinned action-tape summary
        // (e.g. `[update_meeting OK AAMkADVmMjY1…40chars]`) looked like a COMPLETE
        // id — Sonnet copied it back as meeting_id on the next edit → Graph
        // "ErrorInvalidIdMalformed: The Id is invalid" + a forced re-fetch/retry
        // (the Boston-thread failures). Use the human-readable subject instead;
        // the full canonical id reaches Sonnet via get_calendar / the just-booked
        // event injection, never a truncated summary.
        const subj = (input as any).subject ?? (input as any).meeting_subject ?? (input as any).new_start ?? (input as any).date ?? '';
        const subjPart = subj ? ` ${String(subj).slice(0, 40)}` : '';
        if (outcome.ok) {
          const idPart = outcome.eventId ? ` event_id=${String(outcome.eventId).slice(0, 16)}…` : '';
          return `[${toolName} OK${subjPart}${idPart}]`;
        }
        return `[${toolName} FAILED${subjPart}${outcome.reason ? `: ${outcome.reason.slice(0, 60)}` : ''}]`;
      }
      case 'set_event_category': {
        // Pure mutation (no read mode) → a non-error result IS success. Emit an
        // explicit OK marker so the claim-checker can confirm a "Done / updated
        // / categorized" claim. The generic `default` below carried NO outcome
        // marker, so legit category updates ("All 7 updated to Weekly") were
        // flagged as unverifiable and rewritten (GH 2026-06-17 over-fire).
        // FAILED is already handled by the generic error check at the top.
        const cat = (input as any).category ?? (input as any).category_id ?? (input as any).label ?? '';
        return `[set_event_category OK${cat ? ` ${String(cat).slice(0, 40)}` : ''}]`;
      }
      default: {
        // Generic: just tool name + first key-value
        const firstKey = Object.keys(input)[0];
        const firstVal = firstKey ? String(input[firstKey]).slice(0, 40) : '';
        return `[${toolName}${firstKey ? `: ${firstKey}=${firstVal}` : ''}]`;
      }
    }
  } catch {
    return `[${toolName}]`;
  }
}

// v2.2.5 — Action tape. Scans the assistant turns in this thread's conversation
// history for successful mutation tool summaries (the `[<tool> OK ...]` markers
// emitted by summarizeToolCall above) and pins them at the top of the system
// prompt as a fact block. Replaces the prompt-rule attempts (RULE 2e in
// systemPrompt.ts and the calendarHealth "RULE 2e principle" reference) which
// kept rotting — Sonnet ignores rules but can't ignore pinned data.
//
// Failed mutations (`[<tool> FAILED ...]`) are intentionally excluded — only
// confirmed successes belong on the tape. The closing line acknowledges the
// tool-trust gap (Graph can return OK on a write that didn't actually land):
// when the owner pushes back, Maelle re-checks instead of insisting.
const MUTATION_OK_RE = /\[(?:create_meeting|move_meeting|update_meeting|delete_meeting|book_floating_block) OK[^\]]*\]/g;

function extractActionTape(history: Array<{ role: 'user' | 'assistant'; content: string }>): string[] {
  const out: string[] = [];
  for (const msg of history) {
    if (msg.role !== 'assistant') continue;
    const matches = msg.content.match(MUTATION_OK_RE);
    if (matches) out.push(...matches);
  }
  return out.slice(-20);
}

// #131 — stamp each PRIOR user message with the absolute time it was sent, in
// owner-local time, so the model anchors relative words ("tomorrow", "today")
// to WHEN they were said, not to the current turn's "now". Without this a
// message read a day later re-resolves "tomorrow" against the new today (Dina's
// Sunday "tomorrow"=Monday silently became Tuesday on Monday). Slack gives a `ts`
// on every message; the system prompt's "now" still anchors the live turn, so we
// stamp history only. Fails open to the raw content on any bad/absent ts.
function stampHistoryTime(content: string, ts: string | undefined, tz: string): string {
  if (!ts) return content;
  const secs = parseFloat(ts);
  if (!Number.isFinite(secs)) return content;
  try {
    const when = DateTime.fromSeconds(secs).setZone(tz);
    if (!when.isValid) return content;
    return `[${when.toFormat('EEE d MMM, HH:mm')}] ${content}`;
  } catch {
    return content;
  }
}

export interface OrchestratorInput {
  userMessage: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string; ts?: string }>;
  threadTs: string;
  channelId: string;
  userId: string;
  senderRole: 'owner' | 'colleague';
  senderName?: string;   // colleague's display name — injected into system prompt
  channel: ChannelId;
  profile: UserProfile;
  app?: import('@slack/bolt').App;
  // v3.2.6 (6.4) — false for SYSTEM-generated turns (scheduled routines,
  // research runs) that flow through the orchestrator but aren't a live
  // conversation. Suppresses the proactive social directive + end-of-turn coda
  // so a one-way report doesn't get "Do you have any pets?" tacked on.
  // Defaults to interactive (true) when omitted.
  interactive?: boolean;
  isMpim?: boolean;                   // true if this is a group DM (MPIM)
  isChannel?: boolean;                // v2.6.6 — true if this is a public/private channel (vs DM/MPIM)
  isOwnerInGroup?: boolean;           // true when the owner sent this message in an MPIM
  mpimMemberIds?: string[];           // all non-bot member IDs when in MPIM
  /**
   * Optional forced tool on the FIRST Claude call of this run. Set by the
   * claim-checker retry path (v1.6.2) when the previous draft claimed to have
   * messaged someone but no message_colleague tool call ran. Passing
   * { name: 'message_colleague' } uses Anthropic's tool_choice to ensure the
   * model actually calls the tool this time around. Reverts to auto after
   * the first iteration.
   */
  forceToolOnFirstTurn?: { name: string };
  /**
   * Extra one-shot instruction appended to the user message on this run only.
   * Used by the claim-checker retry path to explain why we're re-invoking
   * ("you claimed to message Oran but didn't — do it now"). Never persisted
   * to conversation history.
   */
  extraInstruction?: string;
  /**
   * v2.8.6 — when true, every tool in WRITE_TOOLS is stripped from the tool
   * list before the run. Used by the dateVerifier retry path so a draft-prose
   * correction can't fire a fresh calendar mutation (root of the 2026-05-18
   * Michal incident: dateVerifier flagged a wrong weekday in the draft, the
   * retry orchestrator ran with full tool access, and Sonnet re-fired
   * planMeeting cancel on the wrong event). The retry should ONLY rewrite
   * the prose — reads stay available, writes don't.
   */
  proseOnly?: boolean;
  /**
   * v2.6.1 (D4) — recent-outbound context block for inbound colleague DMs.
   * Populated by the Slack connector when a colleague's inbound DM lands
   * within 24h of a Maelle-originated message_colleague to that colleague,
   * AND either (a) the inbound is within 10min of the outbound (deterministic
   * match), (b) Sonnet classified it as a response to the outbound (10min-24h
   * window), or (c) the inbound is a thread reply on the outbound's ts.
   *
   * Rendered into the system prompt as a "RECENT OUTBOUND TO THIS COLLEAGUE"
   * block. Soft-framed: Sonnet treats it as the strong default but can pivot
   * if the inbound clearly switches topic. Closes the D4 amnesia where a
   * colleague's "Ok" reply 2 minutes after Maelle's heads-up DM produced
   * "Hey, what can I help you with?" because conversation history was empty.
   */
  priorOutboundContext?: string;
  /**
   * Image content blocks attached to the current user message (v1.7.1).
   * When present, the current turn is sent as a content array
   * `[image, ..., text]` instead of a plain string. Sonnet sees the actual
   * pixels (exact UI text, error messages, layout). Persisted to history as
   * a `[Image] ...` placeholder by the caller; the bytes are not stored.
   */
  images?: Anthropic.ImageBlockParam[];
  /**
   * v1.9.0 — which Connection the inbound message arrived on. Used by the
   * router layer so replies follow the inbound transport. Defaults to 'slack'
   * (the only transport today); email and WhatsApp callers will pass their
   * own id when those connectors land.
   */
  inboundConnectionId?: import('../../connections/types').ConnectionId;
  /**
   * v2.4.3 (A1) — abort signal honored by the tool loop. When triggered,
   * the orchestrator finishes any in-flight tool call but stops before
   * dispatching the next one, throws an AbortError. Used by the per-thread
   * inbound queue to merge a freshly-arrived message into the current turn
   * (only safe when no write tools have fired yet — see onWriteExecuted).
   * Background callers (dispatchers, brief generation) omit this and the
   * orchestrator runs to completion as before.
   */
  signal?: AbortSignal;
  /**
   * v2.4.3 (A1) — called the moment a write tool starts executing. The
   * inbound queue uses this to flip its "abort no longer safe" flag —
   * once a write fires, mid-turn abort would orphan irreversible state
   * (sent messages, created events, raised approvals).
   */
  onWriteExecuted?: (toolName: string) => void;
}

export interface SlackAction {
  action: string;
  [key: string]: unknown;
}

export interface OrchestratorOutput {
  reply: string;
  requiresApproval: boolean;
  approvalId?: string;
  slackActions?: SlackAction[];  // actions that need the Slack client to execute
  /** True if a real calendar booking succeeded in this turn. Consumed by the
   *  post-hoc hallucination backstop in app.ts — when the LLM claims a booking
   *  but this is false, the reply is rewritten to a safe fallback. */
  bookingOccurred?: boolean;
  toolSummaries?: string[];     // compact summaries of tool calls for conversation history
  /**
   * v2.8.3+ — rich per-mutation record for this turn. Populated whenever a
   * write tool fires (create_meeting / move_meeting / update_meeting /
   * delete_meeting / finalize_coord_meeting / book_floating_block). Carries
   * the FULL event id so the claim-checker retry path can build a hint with
   * actionable references — Sonnet uses these ids to amend (move/update/
   * delete) instead of re-creating duplicates. The truncated `toolSummaries`
   * above is for history compactness; this field is for retry context.
   */
  mutationActions?: Array<{
    tool: string;
    ok: boolean;
    subject?: string;
    start?: string;
    new_start?: string;
    eventId?: string;
    reason?: string;
  }>;
  /**
   * v3.1.2 (#118) — True when `check_calendar_health` ran AND returned
   * `vacuous: true` (no issues found, no auto-fixes applied). The routine
   * dispatcher uses this to stay silent on auto-fired routine runs that
   * found nothing. Chat-path calls don't go through `dispatchRoutine`, so
   * this flag is informational for them (the reply ships normally).
   */
  healthCheckVacuous?: boolean;
}

/**
 * The main agent loop.
 * Tools come from active skills — determined by the user's profile YAML.
 * Zero hardcoded business logic here.
 */
export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorOutput> {
  // v2.4.3 (A3) — wrap the entire turn in a per-turn cache scope so any
  // downstream code (calendar fetches, etc.) can opt into memoization. The
  // cache lives only for the duration of this turn — created fresh, GC'd
  // when this function returns. AsyncLocalStorage handles the propagation
  // transparently; no other code change required to enable memoization at
  // the call site.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { withTurnCache } = require('../../utils/turnCache') as typeof import('../../utils/turnCache');
  return withTurnCache(() => runOrchestratorImpl(input));
}

async function runOrchestratorImpl(input: OrchestratorInput): Promise<OrchestratorOutput> {
  const { userMessage, conversationHistory, threadTs, profile } = input;

  // v2.5.4 Bug 3 — MPIM with non-owner members forces colleague-context.
  // Pre-v2.5.4 the prompt unlocked owner-level rules whenever isOwnerInGroup
  // was true. That leaked subjects / attendees / project names into
  // colleague-readable threads when owner asked things like "am I free?".
  // Owner direction (Calendly / Julia thread, 2026-05-05): in any MPIM with
  // non-owner members, treat the conversation as colleague-shaped — tools
  // restricted, narration sanitized, even when owner is the typer. Owner
  // retains AUTH (his typed asks still execute via the colleague-allowed
  // tools that have rule-compliance gates). For owner-only data (memory,
  // preferences, full calendar narration) he asks in his private DM.
  // isOwnerInGroup stays true so social classification + people-memory
  // path still recognizes "owner is typing"; the override here only
  // affects tool gating + prompt framing + handler senderRole.
  const mpimWithOthers = !!(input.isMpim && input.mpimMemberIds &&
    input.mpimMemberIds.some(id => id !== profile.user.slack_user_id));
  if (mpimWithOthers && input.senderRole === 'owner') {
    logger.info('orchestrator — MPIM with non-owner: forcing colleague-context', {
      actualTyper: input.userId,
      mpimMembers: input.mpimMemberIds,
      threadTs: input.threadTs,
    });
    input.senderRole = 'colleague';
  }

  logger.info('Orchestrator invoked', {
    user: profile.user.name,
    channel: input.channel,
    senderRole: input.senderRole,
    isOwnerInGroup: input.isOwnerInGroup ?? false,
    isMpim: input.isMpim ?? false,
    preview: userMessage.slice(0, 80),
  });

  // Initial assistant-panel status — fires the instant the message lands so
  // the user sees "On it" instead of Slack's auto-default ("Gathering
  // information…" / "Reviewing findings…") during the ~10s pre-first-tool
  // reasoning gap (classifyTurn pre-pass + initial Sonnet pass). Per-tool
  // status text from the pre-tool hook below overwrites this as tools fire.
  // v2.8.5 — `isAssistantThread` gate removed. The registry was added in
  // v2.7.3 as an optimization to avoid noisy failures on non-panel threads,
  // but `assistant_thread_started` only fires on FIRST panel open — if the
  // socket was disconnected at that moment, or the panel pre-existed before
  // the handler was installed, the thread is permanently missing from the
  // registry and status indicators silently never show. We now always try
  // setStatus when we have channel+thread context; Slack rejects non-panel
  // calls with channel_not_found / not_in_assistant_thread, which the
  // catch in setAssistantStatus already swallows at debug level.
  if (input.app && input.channelId && input.threadTs) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { setAssistantStatus } = require('../../connections/slack/messaging') as
        typeof import('../../connections/slack/messaging');
      void setAssistantStatus(input.app, input.profile.assistant.slack.bot_token, {
        channelId: input.channelId,
        threadTs: input.threadTs,
        status: 'Thinking',
      });
    } catch (_) { /* helper failure is non-fatal */ }
  }

  // v1.6.2 — claim-checker retry path: allow appending a one-shot nudge to the
  // current user message so the model knows why it's being re-invoked. Never
  // persisted to conversation history (callers pass it as extraInstruction
  // exactly once per retry).
  const effectiveUserMessage = input.extraInstruction
    ? `${userMessage}\n\n[SYSTEM NOTE — not from ${profile.user.name.split(' ')[0]}: ${input.extraInstruction}]`
    : userMessage;

  // v2.2.3 (#3) — Social Engine pre-pass GATED on the persona skill being
  // active in this profile. When persona is off, skip the classifier Sonnet
  // call entirely + leave directive empty — saves an API call per turn and
  // keeps the prompt clean of social context. Read fresh per turn so a YAML
  // edit takes effect on the next message (no caching).
  let socialDirective: SocialDirective = noDirective();
  let socialClassification: OwnerIntentClassification | null = null;
  const isOwnerTurn = input.senderRole === 'owner' || input.isOwnerInGroup === true;
  // person-of-the-turn: owner id on owner turns, colleague id on colleague turns
  const turnPersonSlackId = isOwnerTurn ? profile.user.slack_user_id : input.userId;
  const turnSenderRole: 'owner' | 'colleague' = isOwnerTurn ? 'owner' : 'colleague';
  // v2.6.2 — renamed from socialActive. Master toggle for codas, engage,
  // proactive ticks, social topic logging, social context blocks.
  // Legacy `skills.persona` already auto-migrated to `skills.social` in
  // registry.ts; reading `skills.social` here is the canonical path.
  const socialActive = (profile.skills as any)?.social === true;

  // v3.0.6 — merged per-turn classifier. The social-intent pre-pass (was
  // classifyOwnerIntent, Sonnet) and the tool-scope pre-pass (was
  // classifyToolScope, Haiku) were two serial LLM calls (~2.9s). They
  // classify the SAME message with the SAME recent-context, so they're now
  // one Haiku call (~1s) via classifyTurn. Each half is gated independently:
  //   - needIntent: social skill on + message has substance (owner OR colleague)
  //   - needScopes: intent_aware_tools on + owner turn (colleagues get the
  //                 static allowlist, so scopes are unused for them)
  // Result.scope feeds getSkillTools below (toolScopes); result.intent drives
  // the social directive. Both fail open (intent→other, scopes→general).
  let toolScopes: string[] | undefined;
  // v3.1.2 (D) — captured from classifyTurn so a deterministic analyzeCalendar
  // pre-check can fire below for owner buffer/free-time questions, replacing
  // the leaky meetings.ts:2044 prompt rule.
  let isFreeTimeInquiry = false;
  // v3.2.6 (6.4) — never run the social directive/coda on a non-interactive
  // (routine/system) turn; a scheduled report isn't a conversation.
  const needIntent = socialActive && input.interactive !== false && !!userMessage && userMessage.trim().length > 1;
  const needScopes = profile.behavior?.intent_aware_tools === true
    && isOwnerTurn
    && !!userMessage
    && userMessage.trim().length > 0;
  if (needIntent || needScopes) {
    try {
      // Last few turns of context so the classifier can read conversation
      // state (e.g. "Maelle asked a social question and they answered" →
      // open vs "her question went unanswered, now closing out" → closing).
      const recentContext = conversationHistory
        .slice(-4)
        .map(m => `${m.role === 'user' ? (input.senderName ?? profile.user.name.split(' ')[0]) : profile.assistant.name}: ${m.content.slice(0, 280)}`)
        .join('\n');
      const turnResult = await classifyTurn({
        anthropic,
        message: userMessage,
        profile,
        needIntent,
        needScopes,
        senderRole: turnSenderRole,
        senderName: input.senderName,
        recentContext: recentContext || undefined,
      });

      if (needScopes) toolScopes = turnResult.scope.scopes;
      if (isOwnerTurn) isFreeTimeInquiry = turnResult.freeTimeInquiry === true;
      // v3.x (Block 3 — calendar prose lazy-load). A free-time / buffer / "how
      // packed" question needs the calendar-health guidance. Deterministically
      // union the 'calendar' scope so that prose loads even if the classifier
      // tagged the turn 'meetings'-only. (No-op when scopes already widened to
      // 'general'.) The tools themselves live in 'meetings' and ship regardless.
      if (isFreeTimeInquiry && toolScopes && !toolScopes.includes('calendar') && !toolScopes.includes('general')) {
        toolScopes = [...toolScopes, 'calendar'];
      }

      if (needIntent) {
        socialClassification = turnResult.intent;
        // v3.0 follow-up — subject decisions + engagement signals + topic-beat
        // recording moved to end-of-chat (`runSubjectReconciliation` in
        // src/memory/capturePass.ts). Per-turn classifier still produces
        // kind/category/sentiment/direction/topic_label which drive the
        // social directive (engage/celebrate/etc.) for THIS turn — no
        // subject-row writes happen per turn anymore.
        socialDirective = chooseSocialDirective({
          personSlackId: turnPersonSlackId,
          classification: socialClassification,
          ownerTimezone: profile.user.timezone,
        });
        // Stamp the subject as raised the moment we commit to surfacing it
        // proactively. last_assistant_initiated_at is the linchpin the picker's
        // 72h re-raise defer, the raise→ignored decay, and the daily/24h
        // initiation gates all key on. The old stamp site lived in the
        // task-turn coda block, which got hard-disabled (codaEligible=false);
        // the proactive-directive path that replaced it never picked up the
        // marking, so every subject sat at last_assistant_initiated_at=NULL and
        // the whole rotation/decay machinery was dead. (raise_new has no
        // subject yet — it's stamped when reconciliation creates the subject.)
        if (socialDirective.mode === 'continue' && socialDirective.subjectId) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { markSubjectRaised } = require('../../db/socialSubjects') as
              typeof import('../../db/socialSubjects');
            markSubjectRaised(socialDirective.subjectId);
          } catch (err) {
            logger.warn('markSubjectRaised (proactive directive) threw — continuing', {
              err: String(err).slice(0, 200),
            });
          }
        }
      }
    } catch (err) {
      logger.warn('classifyTurn pre-pass threw — continuing without directive / scopes', { err: String(err).slice(0, 300) });
      socialDirective = noDirective();
      socialClassification = null;
      toolScopes = undefined;  // → getSkillTools ships all tools (safe widen)
    }
  }

  // Build the current turn. When images are attached (v1.7.1), the user
  // message becomes a content array `[image, ..., text]` so Sonnet sees the
  // actual pixels — much higher fidelity than a pre-described summary.
  const hasImages = !!input.images && input.images.length > 0;
  const currentTurn: Anthropic.MessageParam = hasImages
    ? {
        role: 'user',
        content: [
          ...(input.images as Anthropic.ImageBlockParam[]),
          { type: 'text', text: effectiveUserMessage },
        ],
      }
    : { role: 'user', content: effectiveUserMessage };

  if (hasImages) {
    logger.info('Orchestrator user message includes images', {
      threadTs,
      imageCount: input.images!.length,
      captionPreview: effectiveUserMessage.slice(0, 80),
    });
  }

  // Build message list, then trim history to stay within token budget.
  // The current user message is always kept; older history is pruned by character count.
  const messages: Anthropic.MessageParam[] = trimHistory([
    ...conversationHistory.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.role === 'user'
        ? stampHistoryTime(m.content, m.ts, profile.user.timezone)
        : m.content,
    })),
    currentTurn,
  ]);

  // Model routing — Sonnet everywhere. We used to route colleagues to Haiku
  // to save cost, but colleague turns carry the same judgment load as owner
  // turns (owner-must-include gate, participant construction, security
  // signals, RULE 3 promise tracking) and Haiku produced subtler failure
  // modes — malformed coord args, missed RULE 3 triggers, over-sensitive to
  // conversational idioms. The stable-solution bias is "one strong model
  // everywhere" over "two models with a cost gap and a behavior gap".
  const MODEL_OWNER     = 'claude-sonnet-4-6';
  const MODEL_COLLEAGUE = 'claude-sonnet-4-6';
  const model = input.senderRole === 'colleague' ? MODEL_COLLEAGUE : MODEL_OWNER;

  // max_tokens — colleagues get shorter answers, owners get full budget
  const maxTokens = input.senderRole === 'colleague' ? 1024 : 2048;

  // Build system prompt in two parts for prompt caching:
  //   static  → skills rules (large, profile-driven) — cached for 5 min
  //   dynamic → date/time, prefs, people memory, auth — uncached
  // v1.6.14 — focus contacts: MPIM participants get their FULL memory loaded
  // into the prompt; everyone else gets the 10-entry tail. In 1:1 DMs or
  // channels there are no focus contacts, so the whole list is capped at 10.
  const focusSlackIds = input.isMpim && input.mpimMemberIds
    ? new Set(input.mpimMemberIds.filter(id => id !== profile.user.slack_user_id))
    : undefined;
  const promptParts = buildSystemPromptParts(profile, input.senderRole, input.senderName, input.isOwnerInGroup, focusSlackIds, input.isMpim, input.isChannel, input.threadTs, input.userId, input.mpimMemberIds, toolScopes);

  // Inject active jobs for this thread so Maelle knows what she already committed to.
  // This prevents her from treating follow-up messages as new requests.
  let threadContextBlock = '';
  if (input.senderRole === 'owner' && threadTs) {
    const { tasks, outreachJobs } = getActiveJobsForThread(
      profile.user.slack_user_id,
      threadTs,
    );

    const lines: string[] = [];

    for (const job of outreachJobs) {
      // v2.3.6 (#69a) — surface colleague reply_text into the thread block.
      // The reply was captured to the outreach_jobs row by the inbound
      // pipeline, but the prompt-rendering only showed the OUTGOING message.
      // That left Sonnet narrating "no reply yet" while the reply was
      // already in the DB. Now: if reply_text is populated, status reads
      // "replied" and the reply preview is included alongside the original
      // message — Sonnet can see the back-and-forth in one block.
      const hasReply = typeof job.reply_text === 'string' && job.reply_text.trim().length > 0;
      // v3.1 (Path 2 Stage 7) — outreach status reads off the linked request.
      const oLc = getOutreachLifecycle(job.id);
      const status = oLc.phase === 'outreach:scheduled' && job.scheduled_at
        ? `scheduled — message goes out ${DateTime.fromISO(job.scheduled_at).setZone(profile.user.timezone).toFormat('EEEE d MMM')}`
        : hasReply
        ? `replied`
        : oLc.requestState === 'awaiting_colleague'
        ? `sent, waiting for reply`
        : (oLc.requestState ?? 'in flight');
      const sentPreview = job.message ? `: "${job.message.slice(0, 80)}${job.message.length > 80 ? '…' : ''}"` : '';
      const replyPreview = hasReply
        ? `\n   ↳ reply: "${job.reply_text!.slice(0, 200)}${job.reply_text!.length > 200 ? '…' : ''}"`
        : '';
      lines.push(`• Outreach to ${job.colleague_name} — ${status}${sentPreview}${replyPreview}`);
    }

    for (const task of tasks) {
      if (!outreachJobs.some(j => j.id === task.skill_ref)) {
        lines.push(`• Task: "${task.title}" — ${task.status}`);
      }
    }

    // v1.7.2 — Summary session (one per thread). When present + iterating,
    // tell Sonnet explicitly so it routes owner replies through the
    // classify_summary_feedback tool rather than treating them as new requests.
    const summarySession = getSummarySessionByThread(threadTs);
    if (summarySession && summarySession.stage === 'iterating') {
      const subject = summarySession.meeting_subject ?? '(untitled)';
      lines.push(`• Summary session: "${subject}" — drafting/iterating. ANY reply from ${profile.user.name.split(' ')[0]} in this thread is feedback on the summary — call classify_summary_feedback first to route correctly (style rule / draft edit / share intent).`);
    } else if (summarySession && summarySession.stage === 'shared') {
      const subject = summarySession.meeting_subject ?? '(untitled)';
      const shared = summarySession.shared_at ? ` (shared ${summarySession.shared_at})` : '';
      lines.push(`• Summary session: "${subject}" — already shared${shared}. Draft text is no longer available; only the meta (subject/attendees/date) remains. If asked, recall what you can from the meta.`);
    }

    if (lines.length > 0) {
      threadContextBlock = `\n\nACTIVE IN THIS THREAD — you already committed to these:\n${lines.join('\n')}\nDo NOT re-ask for confirmation. If asked about status, report it. If asked to do something already in progress, say it's already scheduled/underway.`;
    }
  }

  // v2.2.5 — Action tape: pin the mutation tool calls Maelle made earlier in
  // this thread so she can't narrate her own actions as discoveries one turn
  // later. Replaces the rotting RULE 2e prompt rule. Owner-only (colleagues
  // don't see Maelle's action history) and only when threadTs is present.
  let actionTapeBlock = '';
  if (input.senderRole === 'owner' && threadTs) {
    const tape = extractActionTape(input.conversationHistory);
    if (tape.length > 0) {
      actionTapeBlock = `\n\nACTIONS YOU TOOK IN THIS THREAD:\n${tape.map(t => `- ${t}`).join('\n')}\n\nWhen the owner asks about anything in this list, lead with what YOU did — not what the calendar currently shows. If he says it didn't happen or the calendar shows otherwise, do NOT insist on this list — re-check via get_calendar and reconcile honestly. The list is what the tool reported, not ground truth.`;
    }
  }

  // v3.1.4 (Y4) — colleague-path: carry the event(s) this colleague just
  // requested forward by event_id, from the requests spine (the requester-link
  // row written on a colleague booking). Pre-fix, a colleague who booked then
  // said "add Eli / rename it" sent Maelle to get_calendar, which returned 0
  // (Graph calendarView indexing lag right after a write) — she "lost" the
  // meeting and flailed. With the full event_id in context, the follow-up edit
  // targets update_meeting directly. No lagging re-read.
  let colleagueBookingBlock = '';
  if (input.senderRole === 'colleague' && input.userId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getDb } = require('../../db') as typeof import('../../db');
      const rows = getDb().prepare(`
        SELECT subject, outcome_external_event_id, created_at
        FROM requests
        WHERE owner_user_id = ?
          AND requester_slack_id = ?
          AND outcome_external_event_id IS NOT NULL
          AND datetime(created_at) >= datetime('now', '-3 hours')
        ORDER BY datetime(created_at) DESC
        LIMIT 3
      `).all(profile.user.slack_user_id, input.userId) as Array<{
        subject: string; outcome_external_event_id: string; created_at: string;
      }>;
      if (rows.length > 0) {
        const lines = rows.map(r => `  - "${r.subject}" — event_id=${r.outcome_external_event_id}`);
        colleagueBookingBlock = `## MEETINGS YOU JUST SET UP FOR THIS PERSON (use these IDs)\n\nIf they ask to change one of these ("add someone", "rename it", "move it"), call update_meeting / move_meeting with the matching event_id below — do NOT get_calendar to re-find it (a just-booked event can lag in the calendar for a few seconds):\n\n${lines.join('\n')}`;
      }
    } catch (err) {
      logger.warn('colleagueBookingBlock builder threw — proceeding without it', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // v3.4.2 (F1) — owner-path equivalent of colleagueBookingBlock: the events
  // the owner created/edited THIS thread, by full event_id (from the in-memory
  // thread ledger). Lets a later "rename it / add Chris / make it Weekly" edit
  // by id instead of re-searching by name — which lagged after a write AND
  // re-resolved the date to the wrong week (the "Week Summary doesn't appear"
  // miss). Empty when nothing's been booked this thread → no block.
  let ownerThreadEventsBlock = '';
  if (isOwnerTurn && input.threadTs) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getThreadEvents, getActivePlanningWindow } = require('../../utils/threadEventLedger') as
        typeof import('../../utils/threadEventLedger');
      const evs = getThreadEvents(input.threadTs);
      if (evs.length > 0) {
        const ownerFirst = profile.user.name.split(' ')[0];
        const lines = evs.slice(-10).map(e => `  - "${e.subject}" — event_id=${e.eventId}`);
        // v3.4.2 (F2) — active-window anchor for bare day references. Pure
        // conversation signal (the dates booked this session) — NO travel/marker
        // needed, so it works for a plain "plan my July" thread. Resolves the
        // "Thursday → wrong calendar week" drift (booked Jul 2, then reverted to
        // Jun 25).
        const win = getActivePlanningWindow(input.threadTs);
        const anchorLine = win
          ? `This session you've been scheduling for **${win.from} to ${win.until}**. When ${ownerFirst} gives a bare day reference ("Thursday", "the 1st", "that week", "Monday morning") with no full date, resolve it WITHIN that window — NOT the nearest upcoming calendar day. If he clearly names a different week, follow that.\n\n`
          : '';
        ownerThreadEventsBlock = `## YOUR SESSION SO FAR (active planning week + event IDs)\n\n${anchorLine}When ${ownerFirst} asks to change one of the events below ("rename it", "add someone", "move it", "make it Weekly", "set its category"), call update_meeting / move_meeting / set_event_category with the matching event_id — do NOT get_calendar to re-find it by name (a just-written event lags a few seconds, and re-resolving by name can land the wrong week):\n\n${lines.join('\n')}`;
      }
    } catch (err) {
      logger.warn('ownerThreadEventsBlock builder threw — proceeding without it', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // Social engagement context — colleague-rapport memory (people_memory-based).
  // v2.2 — only injected on COLLEAGUE turns. Owner turns use the new Social
  // Engine directive below instead.
  // v2.2.3 (#3) — also gated on persona skill being on. With persona off,
  // colleague turns get no social context block (Maelle stays task-only).
  const socialBlock = (isOwnerTurn || !socialActive)
    ? ''
    : buildSocialContextBlock(input.userId, input.profile.user.timezone, input.profile.assistant.name);

  // v2.2 — Social Directive block. Populated by the pre-pass above.
  // When mode === 'none' this is empty and has no effect on the prompt.
  const socialDirectiveBlock = formatDirectiveForPromptBlock(socialDirective);

  // v2.6.1 (D4) — recent-outbound context block. Populated by the Slack
  // connector at inbound-DM time when a colleague's reply lands within a
  // recent outbound's window (≤10min deterministic, 10min-24h LLM-classified,
  // or thread-reply on the outbound's ts). Pinned NEAR THE TOP of the
  // dynamic prompt so Sonnet sees it before drafting any reply.
  const priorOutboundBlock = input.priorOutboundContext ?? '';

  // Availability pre-check. Before the main Sonnet loop, detect specific
  // (date, time) availability questions in the inbound message and run
  // find_available_slots deterministically for each. Closes the
  // get_calendar-eyeball-vs-rule-aware mismatch where Sonnet's first
  // "free" verdict and the booking flow's later "doesn't work" verdict
  // disagreed because they used different tools on the same data. Pinned
  // to the top of dynamic block so Sonnet's first answer matches what
  // the booking flow will accept later. Fails open: regex doesn't match
  // → block empty → normal flow.
  let availabilityPrecheckBlock = '';
  if (input.senderRole === 'colleague' && userMessage && userMessage.trim().length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { precheckAvailability } = require('../../utils/availabilityPreCheck') as
        typeof import('../../utils/availabilityPreCheck');
      const result = await precheckAvailability({
        message: userMessage,
        profile,
        // v3.3.7 (#125b) — the day a bare time refers to often lives a
        // message earlier ("מחר... 17:00" → "13:00/13:30?").
        recentThread: conversationHistory.slice(-4),
      });
      if (result.ran && result.promptBlock) {
        availabilityPrecheckBlock = result.promptBlock;
      }
      // A slot the colleague ASKED about that we confirmed bookable IS a slot
      // we offered them — record it into the SAME stash find_available_slots
      // feeds, so the hold gate (which validates "was this offered?") passes on
      // "is he free at X? → yes → hold it". One source of truth: both
      // availability surfaces (search + point-check) record what they confirmed;
      // pre-fix only the search did, so a point-check confirmation couldn't be held.
      if (result.ran && input.channelId && result.verdicts.length > 0) {
        const bookableStarts = result.verdicts
          .filter(v => v.bookable)
          .map(v => {
            const dt = DateTime.fromISO(`${v.date}T${v.time}`, { zone: profile.user.timezone });
            return dt.isValid ? { start: dt.toISO()! } : null;
          })
          .filter((s): s is { start: string } => s !== null);
        if (bookableStarts.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { recordOfferedSlots } = require('../../utils/offeredSlotsStash') as
            typeof import('../../utils/offeredSlotsStash');
          recordOfferedSlots({
            channelId: input.channelId,
            threadTs: input.threadTs,
            timezone: profile.user.timezone,
            slots: bookableStarts,
          });
        }
      }
    } catch (err) {
      logger.warn('availabilityPreCheck threw — proceeding without pre-check', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // v3.3.8 — offered-slots binding block. When a previous turn in this
  // conversation OFFERED specific slots (find_available_slots, colleague
  // path), inject the exact instants so a pick ("Tuesday 20:30") binds to
  // the offered date instead of being re-derived — re-derivation is how
  // "יום שלישי 20:30" validated against Jun 23 when the offer was Jun 16
  // (false "not free" on a free slot; the quiet variant books the wrong
  // week silently). Coord stored offers on its job row; this is the same
  // protection for the direct path. Same injection rail as the pre-check.
  let offeredSlotsBlock = '';
  if (input.senderRole === 'colleague' && input.channelId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getOfferedSlots } = require('../../utils/offeredSlotsStash') as
        typeof import('../../utils/offeredSlotsStash');
      const offered = getOfferedSlots(input.channelId, input.threadTs);
      if (offered && offered.length > 0) {
        offeredSlotsBlock = `## SLOTS ALREADY OFFERED IN THIS CONVERSATION (binding)
These exact instants were offered to this colleague earlier and are still on the table:
${offered.map(s => `- ${s.display} → start_iso ${s.startIso}`).join('\n')}
If their message picks one of these — by time ("20:30"), weekday+time ("Tuesday 20:30"), or position ("the second one") — it means THAT exact instant: use its start_iso verbatim in any create_meeting / validation call. NEVER re-resolve the date from a weekday word; the offer above is the authoritative date.`;
      }
    } catch (err) {
      logger.warn('offeredSlotsStash read threw — proceeding without block', {
        err: String(err).slice(0, 150),
      });
    }
  }

  // v3.1.2 (D) — free-time pre-check. Owner-path only. When classifyTurn
  // flagged this turn as a buffer/free-time inquiry ("do I have buffer?",
  // "how packed is Thursday?", "am I free this afternoon?"), run
  // analyzeCalendar for today + tomorrow deterministically and inject the
  // real freeMin + gap structure into the prompt. Replaces the leaky
  // meetings.ts:2044 "USE THE TOOL — don't math by hand" prompt rule that
  // Sonnet kept ignoring, producing fabricated "2h45 free / healthy"
  // narrations. No NL regex — the classifier's LLM pre-pass decides
  // intent. Fails open: any error in analyze leaves the block empty and
  // the prompt rule + Sonnet's normal flow take over.
  let freeTimePrecheckBlock = '';
  if (isFreeTimeInquiry && input.senderRole === 'owner') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ops = require('../../skills/meetings/ops') as typeof import('../../skills/meetings/ops');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cal = require('../../connectors/graph/calendar') as typeof import('../../connectors/graph/calendar');
      const tz = profile.user.timezone;
      // Today + tomorrow window. Enough surface for "do I have buffer today",
      // "how packed is tomorrow", or "this afternoon vs tomorrow morning"
      // questions without paying for a week's worth of events.
      const { DateTime: Lux } = require('luxon') as typeof import('luxon');
      const todayStr = Lux.now().setZone(tz).toFormat('yyyy-MM-dd');
      const tomorrowStr = Lux.now().setZone(tz).plus({ days: 1 }).toFormat('yyyy-MM-dd');
      const rawEvents = await cal.getCalendarEvents(profile.user.email, todayStr, tomorrowStr, tz);
      const processed = ops.processCalendarEvents(
        rawEvents,
        profile.user.email,
        profile.user.name,
        tz,
        profile,
      );
      const days = ops.analyzeCalendar(processed, todayStr, tomorrowStr, profile);
      if (days.length > 0) {
        const lines: string[] = [];
        for (const d of days) {
          if (d.dayType === 'day_off') continue;
          const free = d.stats?.freeMinInWorkHours ?? 0;
          const meetings = d.stats?.meetingCount ?? 0;
          const noBuffer = d.issues?.some(i => i.type === 'no_buffer') === true;
          const totalMin = d.stats?.totalMeetingMin ?? 0;
          const hh = Math.floor(free / 60);
          const mm = free % 60;
          const freeStr = hh > 0 ? `${hh}h${mm > 0 ? `${String(mm).padStart(2, '0')}m` : ''}` : `${mm}m`;
          const meetingsHh = Math.floor(totalMin / 60);
          const meetingsMm = totalMin % 60;
          const meetingsStr = meetingsHh > 0 ? `${meetingsHh}h${meetingsMm > 0 ? `${String(meetingsMm).padStart(2, '0')}m` : ''}` : `${meetingsMm}m`;
          lines.push(`  - ${d.date} (${d.day}, ${d.dayType}): ${freeStr} free during work hours / ${meetingsStr} in meetings across ${meetings} ${meetings === 1 ? 'meeting' : 'meetings'}${noBuffer ? ' — flagged as BUSY (below your daily focus-time floor)' : ''}`);
        }
        if (lines.length > 0) {
          freeTimePrecheckBlock = `## CALENDAR HEALTH (rule-aware, deterministic — use these numbers)\n\nYou asked about your free time / buffer. I ran the analyzer; here are the real numbers — narrate from THESE, do not eyeball get_calendar and recompute:\n\n${lines.join('\n')}\n\nIf a day is flagged BUSY, say so honestly. If you have buffer, say how much. Do not invent figures.`;
        }
      }
    } catch (err) {
      logger.warn('freeTimePreCheck threw — proceeding without pre-check', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // v3.1.2 (B2) — recently-surfaced calendar issues. When the calendar_health
  // routine (or the brief) tells the owner about a duplicate / overlap /
  // OOF-conflict and the owner replies "delete it" / "fix it" minutes later,
  // the next-turn search-by-subject was losing the event_id the routine
  // already had in hand — Maelle was searching get_calendar for "Video
  // Interview" and missing the now-vanished event, replying "may have
  // already been removed" instead of resolving against the known
  // event_id/peer_event_id. Owner-path only. Pull calendar_issues rows
  // touched in the last 6h (regardless of status — auto-stale-resolved
  // rows from this morning are still candidates for "delete it" follow-ups
  // throughout the workday), inject as a compact block. Sonnet uses the
  // IDs to call delete_meeting / manage_calendar_issue directly instead
  // of subject re-search.
  let recentCalendarIssuesBlock = '';
  if (input.senderRole === 'owner') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getDb } = require('../../db') as typeof import('../../db');
      const rows = getDb().prepare(`
        SELECT id, event_id, peer_event_id, event_date, issue_class, status, notes, updated_at
        FROM calendar_issues
        WHERE owner_user_id = ?
          AND datetime(updated_at) >= datetime('now', '-6 hours')
        ORDER BY datetime(updated_at) DESC
        LIMIT 5
      `).all(profile.user.slack_user_id) as Array<{
        id: string;
        event_id: string;
        peer_event_id: string | null;
        event_date: string;
        issue_class: string;
        status: string;
        notes: string | null;
        updated_at: string;
      }>;
      if (rows.length > 0) {
        const lines = rows.map(r => {
          const peerPart = r.peer_event_id ? `, peer_event_id=${r.peer_event_id}` : '';
          const noteSnip = (r.notes ?? '').slice(0, 180).replace(/\s+/g, ' ').trim();
          return `  - issue_id=${r.id} (${r.issue_class} on ${r.event_date}, status=${r.status}): event_id=${r.event_id}${peerPart}\n    notes: ${noteSnip}`;
        });
        recentCalendarIssuesBlock = `## RECENT CALENDAR ISSUES (last 6h — use these IDs, do not re-search by subject)\n\nThe calendar_health routine or the brief surfaced the following issues recently. If the owner says "delete it" / "fix it" / "cancel it" referring to one of these, USE the event_id (or peer_event_id when the reference is to the second event) directly with delete_meeting / move_meeting / update_meeting. Do NOT do a fresh get_calendar subject search — the event may have already vanished externally while you still have the id from the surface.\n\n${lines.join('\n')}`;
      }
    } catch (err) {
      logger.warn('recentCalendarIssues block builder threw — proceeding without it', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // v3.1.7 — the blind research pre-check (researchPreCheck) is GONE. It
  // mis-extracted the topic (searched the task framing), then injected a
  // "research done" block that suppressed the real, focused searches the turn
  // needed — so content got written from training memory, ungrounded. Replaced
  // by the `research` tool in the search skill: the model calls it with a real
  // goal, it plans focused searches, fetches + reads real sources, and returns
  // them so the draft is grounded and cited.

  // v3.3.x (RC3) — per-turn reply-language reinforcement. The static
  // CURRENT-TURN-WINS language rule decays across a thread (drifts to Hebrew
  // when Hebrew tool-results / memory bleed in). Re-stamping the detected
  // language into the UNCACHED dynamic block every turn can't decay. Fires only
  // for scripts that actually drift (Hebrew/Cyrillic/Arabic); Latin-script input
  // returns null and falls through to the static rule. Voice messages are
  // exempt — they reply in English regardless (systemPrompt VOICE rule, #12).
  let languageDirectiveBlock = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { detectMessageLanguage } = require('../../utils/detectMessageLanguage') as
      typeof import('../../utils/detectMessageLanguage');
    const isVoice = typeof userMessage === 'string' && userMessage.trimStart().startsWith('[Voice message]');
    let lang = isVoice ? null : detectMessageLanguage(userMessage);
    if (!lang && !isVoice) {
      // A contentless reply — "11:15", "yes", "ok", an emoji — carries no
      // language signal, so detectMessageLanguage returns null and the per-turn
      // LANGUAGE override vanishes. That let a stored/attendee language_pref pull
      // the reply into another language (English booking → Hebrew confirmation on
      // "11:15"). Carry the language forward from the most recent prior message
      // that DID carry one (the human's, not Maelle's own past replies) so the
      // conversation's language sticks across short replies.
      for (let i = conversationHistory.length - 1; i >= 0; i--) {
        const m = conversationHistory[i];
        if (m.role !== 'user') continue;
        const prior = detectMessageLanguage(m.content);
        if (prior) { lang = prior; break; }
      }
    }
    if (lang === 'Latin') {
      // v3.3.x — symmetric override for a Latin-script inbound. Don't name the
      // language (script can't distinguish English/Spanish/French); just bind
      // to THIS message and forbid drifting to a non-Latin language or a stored
      // preference. Fixes "English in, Hebrew out" (Ayala) when the thread /
      // stored pref skews non-Latin.
      languageDirectiveBlock = `LANGUAGE (this turn): the sender's current message is in a Latin-script language (English, Spanish, etc.) — reply in the EXACT same language as THIS message. Do NOT reply in Hebrew or any non-Latin language, and do NOT carry over the language of earlier messages in this thread, a stored language preference, or any tool result.`;
    } else if (lang) {
      languageDirectiveBlock = `LANGUAGE (this turn): the sender wrote in ${lang} — reply in ${lang}. This overrides any prior-turn language and the language of anything you read this turn (tool results, memory, calendar subjects).`;
    }
  } catch (_) { /* detection failure is non-fatal — static rule still governs */ }

  // v3.5.x (person-memory rebuild) — persist the colleague's inbound language as
  // a derived signal. Outbound composition TO them (relay / outreach / coord)
  // reads the most recent inbound (people.resolveOutboundLanguageForPerson),
  // default English — so an English-writing colleague never gets a Hebrew DM off
  // a stale one-off pref (the Ayala bug). Stamp the RAW current-message script
  // only (not the carried-forward value): a contentless "yes" detects null and
  // leaves the prior signal intact. Colleague senders only; best-effort.
  try {
    if (input.senderRole === 'colleague' && input.userId) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { detectMessageLanguage } = require('../../utils/detectMessageLanguage') as
        typeof import('../../utils/detectMessageLanguage');
      const raw = detectMessageLanguage(userMessage);
      const code = raw === 'Hebrew' ? 'he'
        : raw === 'Russian' ? 'ru'
        : raw === 'Arabic' ? 'ar'
        : raw === 'Latin' ? 'en'
        : null;
      if (code) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { setLastInboundLang } = require('../../db/people') as typeof import('../../db/people');
        setLastInboundLang(input.userId, code);
      }
    }
  } catch (_) { /* signal stamping is best-effort */ }

  // #WE-spine (Gidon fix, #134) — per-turn owner-location grounding. Assert WHICH
  // days the owner is away (+ where) and that other days he's home, so a stale
  // "he's in Boston" can't bleed from an earlier thread onto a home day. DUAL-
  // SOURCE: the owner's WE days are CALENDAR MARKERS (his primary mechanism), so
  // this reads the 14-day calendar (markers) AND the travel record. The read goes
  // through the warm calendarCache (one fetch per ~5-min window, shared across
  // turns — NOT a per-tool reload), and ONLY on scheduling-relevant turns
  // (colleague, or an owner turn scoped to meetings/calendar) so a trivial "thanks"
  // never pays for it. Empty (no block) when no trip is in the window or the read
  // fails (fail-open).
  let ownerLocationBlock = '';
  try {
    const weBlockRelevant = input.senderRole === 'colleague'
      || (Array.isArray(toolScopes) && (toolScopes.includes('meetings') || toolScopes.includes('calendar')));
    if (weBlockRelevant) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const we = require('../../utils/workingElsewhere') as typeof import('../../utils/workingElsewhere');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const calMod = require('../../connectors/graph/calendar') as typeof import('../../connectors/graph/calendar');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DateTime: LuxWe } = require('luxon') as typeof import('luxon');
      const homeTz = profile.user.timezone;
      const winFrom = LuxWe.now().setZone(homeTz).toFormat('yyyy-MM-dd');
      const winTo = LuxWe.now().setZone(homeTz).plus({ days: 14 }).toFormat('yyyy-MM-dd');
      let winEvents: import('../../connectors/graph/calendar').CalendarEvent[] = [];
      try { winEvents = await calMod.getCalendarEvents(profile.user.email, winFrom, winTo, homeTz); } catch { /* fail open → record-only / empty */ }
      const awayDays = we.detectOwnerAwayDaysInWindow(winEvents, homeTz, profile.user.slack_user_id, winFrom, winTo);
      if (awayDays.size > 0) {
        const ownerFirst = profile.user.name.split(' ')[0];
        const byLoc = new Map<string, string[]>();
        for (const [date, info] of awayDays) {
          const key = info.location || 'another location';
          if (!byLoc.has(key)) byLoc.set(key, []);
          byLoc.get(key)!.push(date);
        }
        const parts = [...byLoc.entries()].map(([locName, dates]) => `${dates.sort().join(', ')} (${locName})`);
        ownerLocationBlock = `## OWNER LOCATION (next 14 days)\n\n${ownerFirst} is WORKING ELSEWHERE on: ${parts.join('; ')}. On those days his clock and location are the trip's, not home. On any day NOT listed above, treat ${ownerFirst} as in his home base (${homeTz}) — and do NOT carry a trip location/timezone that came up earlier in the conversation onto a day that isn't listed here (that bleed is the bug this prevents).\n\nOn one of his working-elsewhere days, lead with the destination-local time (e.g. "10:45 Boston / 17:45 your usual time"), not home-first. And when flagging an over-hours or conflict on such a day, name the real reason in one clause — don't say "past your usual finish" unless it is actually true in the timezone he is in that day.`;
      }
    }
  } catch (err) {
    logger.warn('ownerLocationBlock — resolve threw, skipping', { err: String(err).slice(0, 160) });
  }

  const systemBlocksDynamic = [
    languageDirectiveBlock,
    priorOutboundBlock,
    availabilityPrecheckBlock,
    offeredSlotsBlock,
    ownerLocationBlock,
    freeTimePrecheckBlock,
    recentCalendarIssuesBlock,
    promptParts.dynamic,
    threadContextBlock,
    actionTapeBlock,
    colleagueBookingBlock,
    ownerThreadEventsBlock,
    socialBlock,
    socialDirectiveBlock,
  ].filter(Boolean).join('\n\n');

  const systemBlocks: Anthropic.TextBlockParam[] = promptParts.static
    ? [
        { type: 'text', text: promptParts.static, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam,
        { type: 'text', text: systemBlocksDynamic } as Anthropic.TextBlockParam,
      ]
    : [{ type: 'text', text: systemBlocksDynamic } as Anthropic.TextBlockParam];

  // v2.7.7 (Module G) — intent-aware tool scoping. `toolScopes` was resolved
  // in the v3.0.6 merged classifier pre-pass above (classifyTurn), gated on
  // profile.behavior.intent_aware_tools + owner turn. Colleagues use the
  // static COLLEAGUE_ALLOWED_TOOLS allowlist (toolScopes stays undefined).
  // Fails open: any classifier error left toolScopes undefined → getSkillTools
  // ships every tool as before.

  // Tools are collected from active skills — filtered by sender role and
  // (when Module G is on) by the classifier-picked scope set.
  // Colleagues get the static restricted subset; owner gets scope-filtered.
  let tools = getSkillTools(profile, input.senderRole, toolScopes);

  // v2.8.6 — prose-only mode strips every write tool. Used by the
  // dateVerifier retry path so a date-typo retry can't fire a fresh
  // calendar mutation. Reads (get_calendar / find_available_slots /
  // get_my_tasks / recall_*) stay available so Sonnet can re-verify state
  // while she rewrites the wording.
  if (input.proseOnly === true) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WRITE_TOOLS } = require('../../connectors/slack/inboundQueue') as
      typeof import('../../connectors/slack/inboundQueue');
    const before = tools.length;
    tools = tools.filter(t => !WRITE_TOOLS.has(t.name));
    logger.info('Orchestrator — proseOnly mode: filtered out write tools', {
      before, after: tools.length, dropped: before - tools.length,
    });
  }

  // v3.1.6 (L3) — don't re-fire a mutation on a bare acknowledgment of a
  // just-completed action. Real bug: "Done, renamed to X" → owner says
  // "Perfect, thanks" → Sonnet re-ran update_meeting and DOWNGRADED the title.
  // Guard fires only when BOTH hold:
  //   (a) the classifier says this turn is NOT a task (a bare "thanks"/social
  //       ack is kind 'other'/'social'; an explicit "change it to Y" is 'task'
  //       → writes stay), AND
  //   (b) the PREVIOUS assistant turn already executed a write (its action-tape
  //       markers like "[update_meeting OK …]" are in the history).
  // The (b) condition is what preserves "Want me to change X?" → "yes, thanks":
  // that prior turn fired NO write (it only offered), so writes stay and the
  // approval executes. Acks only get blocked when the action was already done.
  if (input.senderRole === 'owner' && socialClassification && socialClassification.kind !== 'task') {
    const lastAssistant = [...conversationHistory].reverse().find(m => m.role === 'assistant');
    if (lastAssistant) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { WRITE_TOOLS } = require('../../connectors/slack/inboundQueue') as
        typeof import('../../connectors/slack/inboundQueue');
      const priorTurnMutated = [...WRITE_TOOLS].some(t => lastAssistant.content.includes(`[${t} OK`));
      if (priorTurnMutated) {
        const before = tools.length;
        tools = tools.filter(t => !WRITE_TOOLS.has(t.name));
        logger.info('Orchestrator — ack-after-completed-action: stripped write tools (no re-mutation on "thanks")', {
          kind: socialClassification.kind, before, after: tools.length,
        });
      }
    }
  }

  // Approval-bound thread lock. When the owner is replying in a thread
  // that's the terminal DM of a pending approval, restrict Sonnet's tools
  // to resolve_approval + list_pending_approvals only. Forces engagement
  // with the approval — she can't drift into find_available_slots,
  // create_meeting, get_calendar, etc., and turn an approval thread into
  // a fresh booking conversation. The amend ping-pong rails (text-shape
  // counter) can carry clarifying questions like "what time?" through
  // this constraint.
  if (
    isOwnerTurn
    && input.threadTs
    && input.proseOnly !== true  // proseOnly already handled above
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getAwaitingOwnerRequests } = require('../../db/requests') as
        typeof import('../../db/requests');
      const pending = getAwaitingOwnerRequests(profile.user.slack_user_id);
      const boundApprovals = pending.filter(r =>
        r.kind === 'approval' && r.terminal_dm_msg_ts === input.threadTs,
      );
      if (boundApprovals.length >= 1) {
        // v3.0.5 — `message_colleague` added. Owner saying "tell him" /
        // "let her know" / "give him the answer" in a thread bound to an
        // approval should let Maelle ACT on both fronts in one turn: close
        // the approval AND ping the colleague who's waiting on the answer.
        // Pre-fix she'd resolve_approval but the message_colleague tool was
        // filtered out, so her draft promised the ping with no tool call
        // behind it — claim-checker caught the lie but couldn't retry
        // because the tool wasn't in scope, and the colleague never heard
        // the outcome.
        const APPROVAL_BOUND_TOOLS = new Set([
          'resolve_approval',
          'list_pending_approvals',
          'message_colleague',
          // v3.2.x — the owner is never limited from acting on his own approval.
          // The original lock assumed the only valid reply was a clean yes/no on
          // the EXACT pending action — but real replies REDIRECT it ("no, move it
          // instead of cancelling"; "book a different time"). Locking those out
          // trapped the owner (the cancel→move / bad-hour→good-time breaks). The
          // owner keeps the full scheduling toolset in an approval thread so he
          // can resolve OR pivot in one turn; the pending approval is still in his
          // prompt, so awareness/closure isn't lost. Only NON-scheduling tools
          // (web, person-writes, knowledge) stay filtered — they can't bear on a
          // scheduling decision and would just be drift.
          'get_calendar', 'get_free_busy', 'find_available_slots',
          'create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting',
          'check_join_availability',
        ]);
        // v3.2.1 (#120 / Yariv) — escape hatch for a TRAPPED recovery. When a
        // bound approval's deferred action failed mid-replay needing a
        // parameter (e.g. ask_location_mode → location_mode_unspecified), the
        // owner-path thread was stuck: only resolve_approval was available, and
        // it just re-ran the identical broken replay (the Yariv loop, 5×). Let
        // the bound approval's OWN deferred-action tool through so Sonnet can
        // complete it directly (e.g. move_meeting with is_online=true). This is
        // on-topic for the approval, not drift — every OTHER tool stays
        // filtered, so the anti-drift guard is intact.
        for (const r of boundApprovals) {
          try {
            const det = JSON.parse(r.details_json ?? '{}') as { deferred_action?: { tool?: string } };
            const deferredTool = det.deferred_action?.tool;
            if (typeof deferredTool === 'string' && deferredTool.length > 0) {
              APPROVAL_BOUND_TOOLS.add(deferredTool);
            }
          } catch { /* unparseable details — leave the base allow-list */ }
        }
        const before = tools.length;
        tools = tools.filter(t => APPROVAL_BOUND_TOOLS.has(t.name));
        logger.info('Orchestrator — approval-bound thread, locked tool scope', {
          threadTs: input.threadTs,
          boundApprovalIds: boundApprovals.map(r => r.id),
          toolsBefore: before,
          toolsAfter: tools.length,
        });
      }
    } catch (err) {
      logger.warn('Orchestrator — approval-bound-thread filter threw, leaving tools unchanged', {
        err: String(err).slice(0, 200),
      });
    }
  }

  // Diagnostic: log the scope decision + the tool-count effect so we can
  // see Module G hits vs misses in production logs. Cheap; only on owner
  // turns when the flag is on.
  if (toolScopes !== undefined) {
    const allOwnerToolsCount = getSkillTools(profile, 'owner', undefined).length;
    logger.info('Module G — tool scope applied', {
      scopes: toolScopes,
      toolsShipped: tools.length,
      toolsAllOwner: allOwnerToolsCount,
      savedTools: allOwnerToolsCount - tools.length,
    });
  }

  let requiresApproval = false;
  let approvalId: string | undefined;
  // Track tools called so we can save a summary in conversation history.
  // This prevents Claude from forgetting what it just did on the next turn.
  const toolCallSummaries: string[] = [];
  // v3.2.5 — "is this turn still mid-process?" signal for the end-of-turn
  // social coda (option A). The coda may fire when the work RESOLVED (booking
  // done, question answered) OR was handed off to someone else (coordination /
  // approval / await-reply outreach — a natural lull). It must NOT fire when
  // the turn is still mid-exchange: Maelle returned a question/decision to the
  // current interlocutor (confirm-override, pick-a-slot, rule exception) or a
  // tool failed. Any such tool result this turn flips this true and the coda
  // is suppressed — that's the "not in the middle" guard. Handoff tools
  // (create_approval / message_colleague) deliberately do
  // NOT set this (they're the lull case the coda is allowed to ride).
  let turnLeftWorkPending = false;
  // v2.8.3+ — rich per-mutation record used by the claim-checker retry path
  // (postReply.ts). Carries FULL event ids so a retry can build a hint that
  // tells Sonnet "to amend this booking, call move_meeting with id=X — don't
  // re-call create_meeting".
  const mutationActions: NonNullable<OrchestratorOutput['mutationActions']> = [];
  let finalReply = '';
  const slackActions: SlackAction[] = [];
  // True if any tool in this turn actually performed a real calendar booking.
  // Consumed by the post-hoc hallucination backstop in app.ts — if the reply
  // claims a booking happened but this is false, the claim is rewritten.
  let bookingOccurred = false;
  // v3.1.2 (#118) — true if check_calendar_health fired this turn AND returned
  // vacuous=true (no issues, no auto-fixes). Routine dispatcher reads this on
  // OrchestratorOutput to stay silent on auto-fired runs; owner-asked runs
  // (which don't go through dispatchRoutine) ignore the flag and narrate
  // normally so the owner sees the "all clear" verification.
  let healthCheckVacuous = false;
  // v1.6.4 — track delete_meeting ids already executed this turn. The claim-
  // checker found a case where the LLM called delete_meeting twice with the
  // same id and then narrated "two meetings deleted" — half lie. This guard
  // makes the second call a no-op with an explicit signal; the LLM sees that
  // and can correct its narrative.
  const deletedEventIdsThisTurn = new Set<string>();
  // Track message_colleague calls per turn keyed on colleague_slack_id.
  // A claim-checker false-positive forcing a retry with tool_choice:
  // message_colleague would otherwise create a second outreach_jobs row
  // seconds apart. Even with the upstream fixes in claim-checker +
  // postReply.ts, this is the deterministic backstop: any second
  // message_colleague call this turn for the same colleague is a no-op
  // with an explicit signal.
  const messagedColleaguesThisTurn = new Set<string>();
  // v3.4.7 — colleagues SUCCESSFULLY messaged this turn (message_colleague
  // returned ok). Distinct from messagedColleaguesThisTurn (which is added
  // unconditionally to block duplicate ATTEMPTS): this success-only set drives
  // the reverse-order double-notify guard, so a FAILED message_colleague never
  // suppresses the resolver's relay (no silent drop). Passed to the resolver.
  const messagedColleaguesOkThisTurn = new Set<string>();
  // v3.4.7 — track requesters the resolver ALREADY relayed an approval outcome
  // to this turn, keyed on requester_slack_id. resolve_approval's canonical
  // close-loop (notifyRequesterOfDecision, or the coord/cascade equivalent)
  // is the ONE path that tells a requester the outcome — but Sonnet can't see
  // that relay fired, so it reaches for message_colleague to "close the loop"
  // and the requester gets a SECOND DM in a new thread (Ayala Geni, 2026-06-22).
  // This is the deterministic, clock-free backstop: a same-turn message_colleague
  // to a requester already relayed-to is suppressed on this fact alone.
  const relayedRequestersThisTurn = new Set<string>();
  // v2.7.2 — capture the most recent rule_violation deferred_action_hint
  // from a meeting tool's result this turn. When create_approval(kind=
  // policy_exception) fires next, the orchestrator stamps this hint as
  // payload.deferred_action so the resolver can replay the booking on
  // approve. The "redirect URL token" pattern in code — no Sonnet copying.
  let lastDeferredActionHint: { tool: string; args: Record<string, unknown> } | null = null;
  let iteration = 0;
  const MAX_ITERATIONS = 10;

  while (iteration < MAX_ITERATIONS) {
    // v2.4.3 (A1) — check abort signal at the iteration boundary. The
    // inbound queue triggers abort when a freshly-arrived message in the
    // same thread should merge into a new turn, BUT only when no write
    // tool has fired yet (queue checks that flag synchronously before
    // calling abort). So if we see signal.aborted here, it's safe to
    // throw — no in-flight tool, no irreversible state to leave behind.
    if (input.signal?.aborted) {
      logger.info('Orchestrator turn aborted at iteration boundary (A1 merge)', { threadTs, iteration });
      const e: Error & { name?: string } = new Error('aborted_for_merge');
      e.name = 'AbortError';
      throw e;
    }
    iteration++;

    // v1.6.2 — claim-checker retry path: on the very first iteration of a
    // retry run, force the model to call a specific tool (e.g. message_colleague).
    // After the first iteration the loop reverts to tool_choice:auto so the
    // model can finish its work normally.
    const toolChoice =
      iteration === 1 && input.forceToolOnFirstTurn
        ? { type: 'tool' as const, name: input.forceToolOnFirstTurn.name }
        : undefined;

    const response = await callClaude({
      model,
      max_tokens: maxTokens,
      system: systemBlocks,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: toolChoice,
      messages,
    });

    logger.debug('Claude response', { stopReason: response.stop_reason, iteration });

    const toolBlocks = response.content.filter(b => b.type === 'tool_use');

    // v2.9.4 follow-up — ALWAYS capture text from this iteration into
    // finalReply, regardless of whether tool calls also fired. Pre-fix
    // (v2.2.4) only captured text on the FINAL iteration (toolBlocks empty),
    // so when Sonnet emitted natural conversational text alongside a tool
    // call in iteration N, the text was silently dropped — the next
    // iteration would `end_turn` with no text (because Sonnet had already
    // "said it" in iteration N from her POV), finalReply stayed empty, and
    // the verbMap fallback fired "Done, handled a few things". Root of the
    // 2026-05-20 note_about_self silent-after-teach class.
    //
    // Behavior: most-recent non-empty iteration wins (later iterations
    // overwrite earlier — natural since text further along is more current).
    // If the final iteration produces no text, finalReply keeps the most
    // recent earlier text.
    //
    // v2.2.4's original concern (deliberation chain leakage —
    // "Actually wait —", "Let me think.") is mitigated by:
    //   (a) the existing base-prompt rule "NO INTERNAL DELIBERATION IN
    //       OUTPUT TEXT" stops Sonnet from emitting deliberation blocks
    //       in the first place
    //   (b) we still take only the LAST text block from each iteration
    //       (within-iteration deliberation still gets dropped)
    //   (c) later iterations naturally overwrite earlier
    // Net trade-off: previously every iter-N-with-tool text was dropped
    // (broke owner's chat). Now occasionally a deliberation block from an
    // early iter could leak if Sonnet doesn't follow with later text.
    // Strictly better failure mode.
    const textBlocks = response.content.filter(b => b.type === 'text') as Anthropic.TextBlock[];
    const lastTextBlock = textBlocks[textBlocks.length - 1];
    if (lastTextBlock && lastTextBlock.text.trim().length > 0) {
      finalReply = lastTextBlock.text.trim();
    }
    if (textBlocks.length > 1) {
      logger.warn('Sonnet emitted multiple text blocks — kept last only', {
        iteration,
        blocks: textBlocks.length,
        droppedPreview: textBlocks
          .slice(0, -1)
          .map(b => b.text.slice(0, 80).replace(/\s+/g, ' '))
          .join(' | ')
          .slice(0, 400),
      });
    }

    // v3.5.x (#1.3) — diagnostic for the truncated-reply class (the "Now the
    // private block:" cut-off, 2026-06-24): when the model hits the output cap
    // mid-sentence the partial text ships as the reply and the turn ends. There
    // was no signal for it (stop_reason only logged at debug). Surface it loudly
    // with what actually went out so the next occurrence is one grep away.
    if (response.stop_reason === 'max_tokens') {
      logger.warn('Orchestrator — response truncated at max_tokens (reply may be cut off mid-sentence)', {
        iteration,
        senderRole: input.senderRole,
        threadTs,
        toolBlocks: toolBlocks.length,
        lastTextLen: lastTextBlock ? lastTextBlock.text.length : 0,
        finalReplyPreview: finalReply ? finalReply.slice(0, 200) : '(empty)',
      });
    }

    // No tool calls — this is the final iteration. finalReply already set above.
    if (toolBlocks.length === 0) {
      break;
    }

    // end_turn WITH tool calls means Claude finished tools but forgot to write a reply
    // Push tool results and loop once more to get the final text
    if (response.stop_reason === 'end_turn' && toolBlocks.length > 0) {
      // Still need to process the tools and get a confirmation reply
    }

    messages.push({ role: 'assistant', content: response.content });

    const skillContext: SkillContext = {
      profile,
      threadTs,
      channelId: input.channelId,
      userId: input.userId,
      senderRole: input.senderRole,
      channel: input.channel,
      app: input.app,
      isMpim: input.isMpim,
      isOwnerInGroup: input.isOwnerInGroup,
      mpimMemberIds: input.mpimMemberIds,
      // v3.4.7 — pass the turn's SUCCESSFULLY-messaged set BY REFERENCE so
      // resolve_approval (a later tool block) sees a message_colleague that
      // already landed this turn → the resolver skips its relay (reverse-order
      // double-notify guard). skillContext is rebuilt per response round; the
      // Set persists across the whole turn.
      messagedColleaguesOkThisTurn,
      // v1.8.9 — carry the inbound transport through. Today every caller is
      // the Slack transport so this defaults to 'slack'. When email/WhatsApp
      // inbound lands, those callers will set their own id.
      inboundConnectionId: input.inboundConnectionId ?? 'slack',
      // v2.8.6 — plumb recent history for the 103D/F owner-in-MPIM-proposed-slot
      // check inside the colleague-path create_meeting handler. Last 8 turns
      // is plenty for "did owner just suggest this time?" detection; passing
      // the whole history would bloat every handler call.
      conversationHistory: conversationHistory.slice(-8),
    };

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolBlocks as Anthropic.ToolUseBlock[]) {
      // ── IDEMPOTENCY: message_colleague once per turn per colleague (v1.7.4) ──
      // Same-turn duplicate sends are never what the user meant — and the
      // claim-checker false-positive retry was hitting this exact path.
      // Short-circuit on (colleague_slack_id) — message text might vary
      // slightly across calls but the intent is duplicate.
      if (toolUse.name === 'message_colleague') {
        const colleagueSlackId = (toolUse.input as any)?.colleague_slack_id;
        if (typeof colleagueSlackId === 'string' && messagedColleaguesThisTurn.has(colleagueSlackId)) {
          logger.warn('message_colleague called twice with same colleague this turn — short-circuiting', {
            senderUserId: input.userId,
            threadTs,
            colleagueSlackId,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              ok: false,
              reason: 'already_messaged_this_turn',
              colleague_slack_id: colleagueSlackId,
              _note: 'You already called message_colleague for this person earlier in THIS turn. Do NOT call again. The first message is queued — your reply should reference what you ALREADY did, not pretend a second send is happening.',
            }),
          });
          toolCallSummaries.push(`[message_colleague] ${colleagueSlackId} — already messaged this turn, skipped`);
          continue;
        }
        // v3.4.7 — DOUBLE-NOTIFY guard. If resolve_approval already relayed the
        // outcome to this person this turn, a message_colleague to them is the
        // duplicate DM in a second thread (Ayala Geni). The resolver's relay is
        // the canonical, threaded close-loop; suppress the redundant send and
        // tell Sonnet it's already done so it narrates the ONE relay, not a
        // phantom second send. Deterministic — keyed on the relayed-to id, no clock.
        if (typeof colleagueSlackId === 'string' && relayedRequestersThisTurn.has(colleagueSlackId)) {
          logger.warn('message_colleague to a requester already relayed-to this turn — short-circuiting (double-notify guard)', {
            senderUserId: input.userId,
            threadTs,
            colleagueSlackId,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              ok: false,
              reason: 'requester_already_notified_by_resolver',
              colleague_slack_id: colleagueSlackId,
              _note: 'resolve_approval ALREADY closed the loop with this person this turn — they received the outcome DM in their existing thread. Do NOT message them again; a second DM lands in a new thread and reads as a duplicate. Your reply should reference the close-loop that already went out.',
            }),
          });
          toolCallSummaries.push(`[message_colleague] ${colleagueSlackId} — requester already notified by resolver, skipped`);
          continue;
        }
      }

      // ── IDEMPOTENCY: delete_meeting once per turn per event_id (v1.6.4) ──
      // Destructive, irreversible via Graph — a double call is never what the
      // user meant. Short-circuit the second call deterministically; the LLM
      // sees the result and can adjust its narration. This is the code-level
      // backstop behind the confirm-before-delete prompt rule.
      if (toolUse.name === 'delete_meeting') {
        const eventId = (toolUse.input as any)?.event_id ?? (toolUse.input as any)?.id;
        if (typeof eventId === 'string' && deletedEventIdsThisTurn.has(eventId)) {
          logger.warn('delete_meeting called twice with same id — short-circuiting', {
            senderUserId: input.userId,
            threadTs,
            eventId,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              ok: false,
              reason: 'already_deleted_this_turn',
              event_id: eventId,
              _note: 'This exact event was already deleted earlier in THIS turn. Do not claim you deleted it a second time. If you meant to delete a different meeting, look it up and call delete_meeting with the OTHER event id.',
            }),
          });
          toolCallSummaries.push(`[delete_meeting] ${eventId} — already deleted this turn, skipped`);
          continue;
        }
      }

      // ── RATE LIMIT: colleague tool calls ──
      if (input.senderRole === 'colleague' && !input.isOwnerInGroup) {
        const { checkAndRecord } = await import('../../utils/rateLimit');
        const key = `${input.userId}:${threadTs}`;
        const ownerFirst = profile.user.name.split(' ')[0];
        // Broader tool budget
        const anyCheck = checkAndRecord('colleague_any_tool', key);
        if (!anyCheck.allowed) {
          logger.warn('⚠ SECURITY — colleague any-tool rate limit exceeded', {
            senderUserId: input.userId,
            threadTs,
            resetInMs: anyCheck.resetInMs,
            toolName: toolUse.name,
          });
          try {
            if (input.app) {
              const { shadowNotify } = await import('../../utils/shadowNotify');
              await shadowNotify(profile, {
                channel: input.channelId,
                threadTs,
                action: '⚠ Colleague tool-call flood',
                detail: `${input.senderName ?? input.userId} tripped the broad tool-call budget (tool: ${toolUse.name}). I deflected with "let me check with ${ownerFirst}". Review the thread when you can.`,
              });
            }
          } catch (_) {}
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              _status: 'deferred_to_owner',
              message: `Respond briefly: "Let me check with ${ownerFirst} and come back to you on this." Do NOT mention rate limits, pausing, or needing to slow down.`,
            }),
          });
          toolCallSummaries.push(`[${toolUse.name}] rate-limited — deferred to owner`);
          continue;
        }
      }

      // v2.4.3 (A1) — flag write tools BEFORE execution. The inbound queue
      // checks this flag synchronously when a new message arrives mid-turn:
      // if no writes yet → safe to abort + merge; if writes fired → can't
      // abort, buffer for follow-up turn. Calling onWriteExecuted from
      // INSIDE executeSkillTool would race the queue's read; flagging here
      // (just before dispatch) is the safe ordering.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { WRITE_TOOLS } = require('../../connectors/slack/inboundQueue') as
        typeof import('../../connectors/slack/inboundQueue');
      if (input.onWriteExecuted && WRITE_TOOLS.has(toolUse.name)) {
        try { input.onWriteExecuted(toolUse.name); } catch (_) { /* never fail the turn over the callback */ }
      }

      // v2.7.2 — deferred_action auto-attach. When create_approval(kind=
      // policy_exception) follows a rule_violation tool result this turn,
      // copy the captured hint into payload.deferred_action so the resolver
      // can replay the booking on owner approve. After attaching, CLEAR the
      // hint so a second create_approval later in the same turn doesn't
      // inherit a stale hint from an unrelated rule_violation earlier.
      let toolInputForCall = toolUse.input as Record<string, unknown>;
      if (toolUse.name === 'create_approval'
          && lastDeferredActionHint
          && (toolInputForCall as { kind?: string }).kind === 'policy_exception') {
        const payloadIn = (toolInputForCall.payload as Record<string, unknown> | undefined) ?? {};
        if (!payloadIn.deferred_action) {
          toolInputForCall = {
            ...toolInputForCall,
            payload: {
              ...payloadIn,
              deferred_action: lastDeferredActionHint,
            },
          };
          logger.info('orchestrator — auto-attached deferred_action to create_approval payload', {
            tool: lastDeferredActionHint.tool, threadTs: input.threadTs,
          });
          lastDeferredActionHint = null;  // consumed
        }
      }

      // Slack assistant-panel status indicator. Fires before each tool call
      // with per-tool human-EA-voiced text (see utils/toolStatusText). Tools
      // without a mapping get '' which actively clears Slack's auto-default
      // ("Gathering information…") — observation / memory tools stay silent.
      // v2.8.5 — `isAssistantThread` gate removed (see turn-start hook above
      // for the rationale). Slack rejects non-panel calls with
      // channel_not_found / not_in_assistant_thread; the catch in
      // setAssistantStatus swallows that at debug level.
      if (input.app && input.channelId && input.threadTs) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { setAssistantStatus } = require('../../connections/slack/messaging') as
            typeof import('../../connections/slack/messaging');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { statusForTool } = require('../../utils/toolStatusText') as
            typeof import('../../utils/toolStatusText');
          // v3.1.8 — only update when this tool has a meaningful phrase. An
          // empty mapping (internal classifiers / pre-passes) SKIPS the call so
          // the last meaningful status persists, instead of clobbering it with
          // a "Working" placeholder. Fire-and-forget — never await.
          const toolStatus = statusForTool(toolUse.name, profile.user.name.split(' ')[0]);
          if (toolStatus) {
            void setAssistantStatus(input.app, input.profile.assistant.slack.bot_token, {
              channelId: input.channelId,
              threadTs: input.threadTs,
              status: toolStatus,
            });
          }
        } catch (_) { /* helper failure is non-fatal */ }
      }

      // v2.9.2 — universal tool-call cache. Before executing the tool, check
      // if an identical call (same owner+thread+tool+args) fired recently.
      // Writes: 60s TTL — same write within a minute is almost always a bug
      // (buffered follow-up that confused Sonnet, claim-checker retry, etc.).
      // Reads: 5s TTL — same-turn duplicate reads return cached; cross-turn
      // fresh reads aren't masked. Returns prior result verbatim so Sonnet's
      // narration is consistent. Closes the 8.2 double-fire class universally
      // — works for every present and future write tool without per-handler
      // changes.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { lookupRecentToolCall, recordToolCall } = require('../../utils/toolCallCache') as
        typeof import('../../utils/toolCallCache');
      const cached = lookupRecentToolCall({
        ownerUserId: profile.user.slack_user_id,
        threadTs: input.threadTs,
        toolName: toolUse.name,
        args: toolInputForCall,
      });
      let result: unknown;
      if (cached) {
        logger.info('Orchestrator — tool-call cache hit, returning prior result without re-firing', {
          tool: toolUse.name,
          ageMs: cached.ageMs,
          threadTs: input.threadTs,
        });
        result = cached.cachedResult;
      } else {
        result = await executeSkillTool(
          toolUse.name,
          toolInputForCall,
          skillContext,
        );
        // Cache the successful result. Errors are NOT cached — a transient
        // failure shouldn't lock out the retry path. Recognize an error by
        // either an Error throw (already bubbled up — we don't reach here)
        // or a `{ error: ... }` shape on the result.
        const isErrorResult = result
          && typeof result === 'object'
          && 'error' in (result as Record<string, unknown>)
          && typeof (result as Record<string, unknown>).error === 'string';
        if (!isErrorResult) {
          recordToolCall({
            ownerUserId: profile.user.slack_user_id,
            threadTs: input.threadTs,
            toolName: toolUse.name,
            args: toolInputForCall,
            result,
          });
        }
      }

      // Check if any skill signalled approval required
      if (
        result &&
        typeof result === 'object' &&
        'requiresApproval' in result &&
        (result as Record<string, unknown>).requiresApproval === true
      ) {
        requiresApproval = true;
        approvalId = (result as Record<string, unknown>).approvalId as string;
      }

      // v3.1.2 (#118) — pick up the vacuous flag on check_calendar_health so
      // the routine dispatcher can suppress posting on auto-fired runs that
      // found nothing.
      if (
        toolUse.name === 'check_calendar_health' &&
        result &&
        typeof result === 'object' &&
        (result as Record<string, unknown>).vacuous === true
      ) {
        healthCheckVacuous = true;
      }

      // Check if any skill needs Slack client execution
      if (
        result &&
        typeof result === 'object' &&
        '_requires_slack_client' in result &&
        (result as Record<string, unknown>)._requires_slack_client === true
      ) {
        slackActions.push(result as unknown as SlackAction);
      }

      // Track whether a real booking occurred this turn — used by the
      // post-hoc hallucination backstop in app.ts (D2). Only count
      // explicit success returns from the authoritative booking tools.
      if (
        result &&
        typeof result === 'object' &&
        !('_requires_slack_client' in result)
      ) {
        const r = result as Record<string, unknown>;
        const wasBooked = bookingOccurred;
        if (toolUse.name === 'create_meeting' && (r.eventId || r.id || r.ok === true)) {
          bookingOccurred = true;
        }
        if (!wasBooked && bookingOccurred) {
          // A real booking landed → drop any offered-slots stash for this
          // conversation so a later turn can't bind to an already-booked
          // instant. create_meeting's handler clears on the direct colleague
          // path; this covers an owner self-book in a
          // colleague DM, which that path misses.
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { clearOfferedSlots } = require('../../utils/offeredSlotsStash') as
              typeof import('../../utils/offeredSlotsStash');
            clearOfferedSlots(input.channelId, input.threadTs);
          } catch { /* non-fatal */ }
        }
        // v3.4.2 (F1) — owner-path event ledger: remember events created/edited
        // THIS thread by full event_id, so a later "rename it / add Chris / make
        // it Weekly" edits by id instead of re-searching by name — which lagged
        // right after a write AND re-resolved the date to the wrong week (the
        // "Week Summary doesn't appear" miss). Records on any successful calendar
        // mutation; injected into the owner prompt below.
        if (
          (toolUse.name === 'create_meeting' || toolUse.name === 'move_meeting' || toolUse.name === 'update_meeting')
          && (r.success === true || r.ok === true || typeof r.meetingId === 'string' || typeof r.id === 'string')
        ) {
          try {
            const inp = (toolUse.input ?? {}) as Record<string, unknown>;
            const evId = (r.meetingId ?? r.id ?? r.eventId ?? inp.meeting_id) as string | undefined;
            const subj = (inp.new_subject ?? inp.subject ?? inp.meeting_subject) as string | undefined;
            // Event start date in the owner's TZ — the F2 active-window anchor.
            const startStr = (inp.start ?? inp.new_start) as string | undefined;
            let dateIso = '';
            if (typeof startStr === 'string') {
              const d = DateTime.fromISO(startStr, { zone: profile.user.timezone });
              if (d.isValid) dateIso = d.toFormat('yyyy-MM-dd');
            }
            if (evId && input.threadTs) {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { recordThreadEvent } = require('../../utils/threadEventLedger') as
                typeof import('../../utils/threadEventLedger');
              recordThreadEvent(input.threadTs, subj ?? 'a meeting', evId, dateIso);
            }
          } catch { /* non-fatal */ }
        }
        // v1.6.4 — remember deleted event ids so the same id can't be deleted
        // twice in one turn. See the short-circuit at the top of the loop.
        if (toolUse.name === 'delete_meeting') {
          const eventId = (toolUse.input as any)?.event_id ?? (toolUse.input as any)?.id;
          if (typeof eventId === 'string') {
            deletedEventIdsThisTurn.add(eventId);
            // C2(a) — drop it from the thread ledger too, so a later reference-back
            // ("change the one I just booked") never resolves to the dead id.
            if (input.threadTs && (r.success === true || r.deleted === true || r.ok === true)) {
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { forgetThreadEvent } = require('../../utils/threadEventLedger') as
                  typeof import('../../utils/threadEventLedger');
                forgetThreadEvent(input.threadTs, eventId);
              } catch { /* non-fatal */ }
            }
          }
        }
        // v1.7.4 — remember messaged colleagues so the same colleague can't be
        // messaged twice in one turn. See the short-circuit at the top of the loop.
        if (toolUse.name === 'message_colleague') {
          const colleagueSlackId = (toolUse.input as any)?.colleague_slack_id;
          if (typeof colleagueSlackId === 'string') {
            messagedColleaguesThisTurn.add(colleagueSlackId);
            // v3.4.7 — only a CONFIRMED send claims the requester for the
            // reverse-order guard, so a failed send leaves the resolver relay free.
            if ((result as { ok?: boolean })?.ok === true) {
              messagedColleaguesOkThisTurn.add(colleagueSlackId);
            }
          }
        }
        // v3.4.7 — record requesters the resolver relayed an approval outcome to
        // this turn, so a same-turn message_colleague to them is suppressed (the
        // double-notify guard at the top of the loop; Ayala Geni 2026-06-22).
        // Deterministic, no clock: requester_notified_at is stamped ONLY on a
        // confirmed relay send, and state=awaiting_colleague means the amend
        // counter was relayed — either way the requester already heard it. A
        // failed/skipped relay leaves both unset, so message_colleague stays
        // available as the fallback (never a silent drop).
        if (toolUse.name === 'resolve_approval' && input.senderRole === 'owner'
            && result && typeof result === 'object' && (result as { ok?: boolean }).ok === true) {
          try {
            const reqId = (result as { request_id?: string; approval_id?: string }).request_id
              ?? (result as { approval_id?: string }).approval_id;
            if (typeof reqId === 'string') {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { getRequest } = require('../../db/requests') as typeof import('../../db/requests');
              const row = getRequest(reqId);
              const requester = row?.requester_slack_id;
              if (requester && requester !== profile.user.slack_user_id
                  && (row!.requester_notified_at || row!.state === 'awaiting_colleague')) {
                relayedRequestersThisTurn.add(requester);
              }
            }
          } catch (err) {
            logger.warn('orchestrator — relayed-requester record threw, non-fatal', { err: String(err).slice(0, 200) });
          }
        }
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });

      // Build compact summary for conversation history persistence
      toolCallSummaries.push(summarizeToolCall(toolUse.name, toolUse.input as Record<string, unknown>, result));

      // v2.8.3+ — rich mutation record for the claim-checker retry hint.
      // Mutations only (create/move/update/delete/finalize/book_floating_block);
      // reads don't need amend handles.
      const mutationToolNames = new Set([
        'create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting',
        'book_floating_block',
      ]);
      if (mutationToolNames.has(toolUse.name)) {
        const outcome = mutationOutcome(result);
        const input = toolUse.input as Record<string, unknown>;
        // #1.5 — prefer the tool RESULT's ACTUAL booked start (post grid-snap) over
        // the pre-snap input arg. create_meeting / move_meeting now return
        // booked_start; without this, mutationActions recorded the time Sonnet
        // ASKED for, so dateVerifier + the #135 honesty backstop compared the reply
        // against a time the meeting never landed on (an off-grid snap slipped by).
        // Fallback to the input arg only when the result didn't surface it.
        const r = (result && typeof result === 'object') ? result as Record<string, unknown> : null;
        const bookedStart = r && typeof r.booked_start === 'string' ? r.booked_start : undefined;
        mutationActions.push({
          tool: toolUse.name,
          ok: outcome.ok,
          subject: typeof input.subject === 'string' ? input.subject : undefined,
          start: bookedStart
            ?? (typeof input.start === 'string' ? input.start
              : typeof input.new_start === 'string' ? input.new_start : undefined),
          new_start: typeof input.new_start === 'string' ? (bookedStart ?? input.new_start) : undefined,
          eventId: outcome.eventId
            ?? (typeof input.meeting_id === 'string' ? input.meeting_id : undefined)
            ?? (typeof input.event_id === 'string' ? input.event_id : undefined),
          reason: outcome.reason,
        });
      }

      // v2.7.2 — capture the most recent deferred_action_hint from a meeting
      // tool's rule_violation result. If create_approval(kind=policy_exception)
      // fires later this turn, the orchestrator auto-stamps this hint as
      // payload.deferred_action so the resolver can replay the booking on
      // owner approve. No Sonnet copying required.
      if (result && typeof result === 'object'
          && (result as { _deferred_action_hint?: unknown })._deferred_action_hint) {
        const hint = (result as { _deferred_action_hint: unknown })._deferred_action_hint as
          | { tool?: string; args?: Record<string, unknown> }
          | undefined;
        if (hint && typeof hint.tool === 'string' && hint.args && typeof hint.args === 'object') {
          lastDeferredActionHint = { tool: hint.tool, args: hint.args };
          logger.info('orchestrator — captured deferred_action_hint from rule_violation', {
            tool: hint.tool, threadTs: input.threadTs,
          });
        }
      }

      // v2.6.5 — when an active-mode tool surfaces internal mutations via an
      // `internal_actions` array on its result, push entries into the summary
      // so the claim-checker sees them. Without this, Sonnet's draft "I auto-
      // fixed lunch" was flagged as hallucination because only the top-level
      // `check_calendar_health` was visible. Generic across tools — any
      // future skill that does internal mutations and emits the same shape
      // gets the same coverage.
      if (result && typeof result === 'object' && Array.isArray((result as { internal_actions?: unknown }).internal_actions)) {
        const internalActions = (result as { internal_actions: Array<{ tool?: string; detail?: string }> }).internal_actions;
        for (const a of internalActions) {
          if (typeof a?.tool === 'string') {
            toolCallSummaries.push(`[${a.tool} (via ${toolUse.name}): ${a.detail ?? ''}]`);
          }
        }
      }

      // v3.2.5 — end-of-turn coda guard (option A). Flag the turn as still
      // mid-process when this tool result returns a question/decision to the
      // current interlocutor or failed. These mean "the exchange isn't done"
      // — appending a social line here is the jarring non-sequitur. Handoff
      // tools (coordination / approval / await-reply outreach) are NOT flagged
      // — those are lulls the coda is allowed to ride.
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        const awaitingDecision =
          r.needs_owner_approval === true
          || r.needs_confirmation === true
          || typeof r.suggested_ask_text === 'string'
          || r._deferred_action_hint != null
          || r.rule_violation != null
          || r.not_organizer === true
          || Array.isArray(r.options)
          || Array.isArray(r.slot_options);
        // A mutating meeting op that didn't close, or any tool that errored.
        const mutators = new Set(['create_meeting', 'move_meeting', 'delete_meeting', 'book_floating_block', 'book_lunch']);
        const failedMutation = mutators.has(toolUse.name)
          && r.success !== true && r.deleted !== true;
        const errored = r.ok === false || typeof r.error === 'string';
        if (awaitingDecision || failedMutation || errored) {
          turnLeftWorkPending = true;
        }
      }

      // v2.7.1 (bug 2.3 / 3.1) — open a follow_up request when owner-initiated
      // meeting work spills past this turn (rule_violation, options to pick,
      // not_organizer, etc.). Closure rides on existing closeMeetingArtifacts
      // cascade + closeLoopOnOwnerHandled scanner. No new tool exposed to
      // Sonnet — purely an orchestrator-level tracking hook.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const m = require('../requests/maybeOpenInFlightMeetingRequest') as
          typeof import('../requests/maybeOpenInFlightMeetingRequest');
        m.maybeOpenInFlightMeetingRequest({
          ownerUserId: profile.user.slack_user_id,
          initiatorSlackId: input.userId,
          initiatorRole: input.senderRole === 'owner' ? 'owner' : 'colleague',
          threadTs: input.threadTs,
          channel: input.channelId,
          toolName: toolUse.name,
          toolInput: toolUse.input as Record<string, unknown>,
          toolResult: result,
        });
      } catch (err) {
        logger.warn('maybeOpenInFlightMeetingRequest threw — non-fatal', {
          err: String(err).slice(0, 200), tool: toolUse.name,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // If sender is a colleague, scrub any sensitive calendar data from tool results
  // that may have leaked into the conversation history before generating final reply
  if (input.senderRole === 'colleague') {
    for (const msg of messages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        // Already safe — user messages don't contain calendar data
      } else if (msg.role === 'assistant' && typeof msg.content === 'string') {
        // Scrub body/description fields from any calendar event data
        msg.content = msg.content
          .replace(/"body":\s*"[^"]*"/g, '"body": "[redacted]"')
          .replace(/"bodyPreview":\s*"[^"]*"/g, '"bodyPreview": "[redacted]"')
          .replace(/"description":\s*"[^"]*"/g, '"description": "[redacted]"');
      }
    }
  }

  // v2.8.1 (#41) — recovery pass DELETED. Pre-fix, when Sonnet ran tools but
  // produced no text, the orchestrator made a second Sonnet call to generate
  // a one-line summary. That was useful pre-Sonnet-4.6 when silent-after-action
  // was common; today it's rare. The tool-grounded fallback below (verbMap,
  // 45 mapped verbs + safe generic) is the deterministic backstop and never
  // fabricates outside the actual tool set. Removing the LLM recovery pass:
  // cheaper, faster, can't drift, can't fabricate. If the fallback can't
  // produce text from real tool calls, silence is the honest outcome.

  if (!finalReply) {
      // v1.7.3 — last-resort fallback. If tools actually ran this turn but
      // both the model AND the recovery pass produced nothing, silence is the
      // wrong answer — the owner has no idea their request landed. Post a
      // grounded confirmation derived from the tool summaries so they see SOMETHING.
      // Only triggers when toolCallSummaries.length > 0 (we don't fabricate
      // "Done." for nothing-happened turns).
      if (toolCallSummaries.length > 0) {
        // Build a compact human-ish summary of what fired
        const toolNames = toolCallSummaries.map(s => {
          // Tool summaries look like "[tool_name: short detail]" or "[tool_name]"
          const m = s.match(/^\[([a-z0-9_]+)/);
          return m ? m[1] : 'something';
        });
        const distinct = [...new Set(toolNames)];
        // v2.3.9 (#78 Fix A) — observation/social tools are SIDE EFFECTS, not
        // the response. When the only tools that fired are these, the right
        // user-facing fallback is silence — narrating "I made a note about
        // myself" is the v2.3.8 INTERNALS rule violation surfacing through the
        // fallback path. The verbMap was added v1.7.3 for "I deleted X / I
        // booked Y" turns where silence would be jarring; for "I noted what
        // we just chatted about" turns, silence is honest. Sonnet went silent
        // probably because it treated the note as the response (a separate
        // bug at the prompt layer). Until that's also fixed, this prevents
        // tool POV leaking to the user. List intentionally narrow — only
        // tools whose user-facing impact is zero.
        // v2.9.4 follow-up — `note_about_self` removed from this list. Pre-
        // v2.9.4 it was a side-effect (saving an owner-self fact); silence was
        // honest. v2.9.4 repurposed it: owner-path now saves a fact ABOUT
        // MAELLE that the owner just taught her — a deliberate teaching
        // moment. Going silent there reads as ignoring the user. Falls
        // through to the verbMap fallback when Sonnet doesn't generate text
        // naturally; the fallback acknowledges the save.
        const SILENCE_ELIGIBLE = new Set([
          'note_about_person',
          'log_interaction',
          'learn_preference',
          'forget_preference',
          'recall_preferences',
          'recall_interactions',
          'update_person_profile',
          'update_person_memory',
          'get_person_memory',
          'confirm_gender',
        ]);
        if (distinct.every(t => SILENCE_ELIGIBLE.has(t))) {
          // Leave finalReply empty — downstream gates (shadow-DM, send) all
          // check non-empty. AuditLog + social engine logging still run.
          logger.info('Orchestrator: only observation tools fired and no reply text — staying silent (Fix A #78)', {
            threadTs,
            iterations: iteration,
            tools: distinct,
          });
        } else {
        // Map tool names to human verbs the owner will understand.
        // Any tool not listed falls through to the generic phrase below —
        // NEVER leak raw tool names to the user (that's an AI-ish tell, plus
        // new tools added later would silently start leaking).
        const verbMap: Record<string, string> = {
          // Summary
          learn_summary_style: 'saved the style preference',
          update_summary_draft: 'updated the summary',
          share_summary: 'shared the summary',
          classify_summary_feedback: 'noted your feedback',
          // Memory
          update_my_preferences: 'saved that as a standing preference',
          learn_preference: 'saved that as a preference',
          forget_preference: 'cleared that preference',
          recall_preferences: 'looked up your preferences',
          recall_interactions: 'checked past interactions',
          note_about_person: 'made a note',
          note_about_self: 'got it, saved that for next time',
          update_person_profile: 'updated contact info',
          log_interaction: 'logged the interaction',
          confirm_gender: 'confirmed the pronouns',
          // Tasks / approvals
          create_task: 'created a task',
          edit_task: 'updated a task',
          cancel_task: 'cancelled a task',
          get_my_tasks: 'checked your open tasks',
          resolve_approval: 'recorded your decision',
          list_pending_approvals: 'checked pending approvals',
          create_approval: 'raised it with you',
          // Calendar
          get_calendar: 'looked at your calendar',
          get_free_busy: 'checked availability',
          find_available_slots: 'searched for open times',
          analyze_calendar: 'reviewed your calendar',
          manage_working_elsewhere: 'updated your working-elsewhere days',
          check_join_availability: 'checked if you can join',
          create_meeting: 'booked the meeting',
          move_meeting: 'moved the meeting',
          update_meeting: 'updated the meeting',
          delete_meeting: 'removed the meeting',
          // Calendar health
          check_calendar_health: 'reviewed calendar health',
          book_floating_block: 'blocked the slot',
          set_event_category: 'categorized the event',
          get_calendar_issues: 'checked calendar issues',
          update_calendar_issue: 'updated the calendar issue',
          // Outreach
          message_colleague: 'sent the message',
          find_slack_channel: 'found the channel',
          find_slack_user: 'found the person',
          // Search / knowledge
          web_search: 'searched the web',
          web_extract: 'pulled the page',
          get_company_knowledge: 'read from the knowledge base',
          // Routines
          create_routine: 'set up the routine',
          get_routines: 'checked your routines',
          update_routine: 'updated the routine',
          delete_routine: 'removed the routine',
          // Briefings
          get_briefing: 'pulled your briefing',
          send_briefing_now: 'sent the briefing',
        };
        // v2.8.6 (98b) — pick the 1-2 highest-impact verbs instead of joining
        // every tool that ran. Pre-fix, "Done — found the person, booked the
        // meeting, and logged the interaction" read robotically — a verb-list
        // that mirrors the tool tape rather than what a human EA would say.
        // The headline action is what matters; observation tools like
        // log_interaction and find_slack_user don't need to be narrated.
        // Priority list orders tools by user-facing impact: state-changing
        // calendar mutations rank highest; coord, approvals, and tasks rank
        // next; everything else is silent in the fallback.
        const VERB_PRIORITY: string[] = [
          // Tier 1 — calendar mutations (the headline)
          'create_meeting', 'move_meeting', 'delete_meeting', 'book_floating_block',
          'update_meeting',
          // Tier 2 — approvals + tasks
          'create_approval', 'resolve_approval',
          'create_task', 'edit_task', 'cancel_task',
          // Tier 3 — outreach + briefings
          'message_colleague', 'send_briefing_now',
          // Tier 4 — calendar health
          'check_calendar_health', 'set_event_category', 'update_calendar_issue',
          // Tier 5 — knowledge / routines (rarely standalone)
          'manage_knowledge', 'create_routine', 'update_routine', 'delete_routine',
        ];
        const ranked = distinct
          .filter(n => verbMap[n] !== undefined)
          .map(n => ({ name: n, rank: VERB_PRIORITY.indexOf(n) }))
          .filter(t => t.rank >= 0)
          .sort((a, b) => a.rank - b.rank);
        const topVerbs = ranked.slice(0, 2).map(t => verbMap[t.name]);
        const verbsText = topVerbs.length === 0
          ? 'handled a few things'
          : topVerbs.length === 1
            ? topVerbs[0]
            : `${topVerbs[0]} and ${topVerbs[1]}`;
        finalReply = `Done — ${verbsText}. Let me know if anything's off.`;
        logger.warn('Orchestrator: tool work happened but no reply text — posted grounded fallback', {
          threadTs,
          iterations: iteration,
          tools: distinct,
          fallbackReply: finalReply,
        });
        }
      } else {
        // v1.7.6 — never silence after the orchestrator runs. The user's rule:
        // if Maelle put the read-receipt emoji, she should respond — even if
        // just to honestly say she didn't follow. Better to ask for help than
        // to leave the user hanging. (Pure-silence path is gone.)
        finalReply = "Sorry, I didn't quite follow that one. Can you rephrase or give me a bit more context?";
        logger.warn('Orchestrator: no tools, no text, no recovery — posted clarifying-confusion fallback', {
          threadTs,
          iterations: iteration,
          fallbackReply: finalReply,
        });
      }
    }
  // v2.8.1 (#41) — pre-fix this section had a stray outer `}` left over from
  // deleting the `if (!finalReply && !isColleagueFacing)` wrapper. Now the
  // verbMap fallback is the only block and closes cleanly.

  auditLog({
    action: 'orchestrator_run',
    source: input.channel,
    actor: input.userId,
    details: { threadTs, iterations: iteration, requiresApproval, skills: tools.map(t => t.name) },
    outcome: requiresApproval ? 'pending_approval' : 'success',
  });

  // v2.0.7 — shadow-DM the owner whenever Maelle replies to a colleague.
  // Previously shadow notify fired only on outbound coord and security events,
  // which meant inbound flows (Michal asking about a bank visit, Yael asking
  // for a slot bump) happened completely invisibly until the next morning
  // brief. This closes the silence gap: one line per inbound so the owner can
  // follow along in ~real time. Gated on v1_shadow_mode like every other
  // shadow path. Skipped when requiresApproval=true because the approval
  // helper already DMs the owner with the full ask.
  // v3.0.8 — shadow-notify moved to postReply.ts so it mirrors the
  // POST-GATE text (what the colleague actually receives), not the raw
  // draft. See postReply.ts Step 4.6.
  void requiresApproval;  // suppress unused-var lint if it was only read here

  // v2.4.2 — owner-said-done scanner (deterministic version of RULE 2d).
  // Fire-and-forget after every owner turn — keyword pre-filter is cheap,
  // LLM only runs when closure-signal words appear AND there are open
  // items. Closes the long-standing pattern where owner says "Amazia is
  // done, drop it" in chat, Sonnet acknowledges verbally but doesn't call
  // cancel_task / cancel_coordination, and the row keeps surfacing in
  // tomorrow's brief. Idempotent — re-running on already-closed items
  // hits the active-status filter and finds nothing.
  if (input.senderRole === 'owner' && userMessage && userMessage.trim().length > 0) {
    void (async () => {
      try {
        const { closeLoopOnOwnerHandled } = await import('../../utils/closeLoopOnOwnerHandled');
        const r = await closeLoopOnOwnerHandled({ profile, ownerMessage: userMessage });
        if (r.scanned && r.closedItems.length > 0) {
          logger.info('closeLoopOnOwnerHandled: cascade fired', {
            threadTs, count: r.closedItems.length, items: r.closedItems,
          });
        }
      } catch (err) {
        logger.warn('closeLoopOnOwnerHandled top-level threw — non-fatal', {
          err: String(err).slice(0, 200),
        });
      }
    })();
  }

  // v2.2.1 — in-conversation rank adjustment for colleague social turns.
  // If this colleague replied socially AND Maelle initiated social with them
  // in the last 24h (piggyback or continuation), nudge engagement_rank based
  // on reply length + sentiment. Rank 0 = opt-out; colleagues who never
  // engage drift there. Rank 3 = high-engagers; replying well lifts them.
  if (
    turnSenderRole === 'colleague'
    && socialClassification?.kind === 'social'
    && socialClassification.social?.sentiment
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { adjustRankFromColleagueResponse } = require('../social/logEngagement') as typeof import('../social/logEngagement');
      adjustRankFromColleagueResponse({
        colleagueSlackId: input.userId,
        replyText: userMessage,
        sentiment: socialClassification.social.sentiment,
      });
      // Bump last_social_at on a genuine colleague social reply. The 48h coda
      // rank-check (socialPingRankCheck) measures engagement as
      // `last_social_at > coda_at`, but that field is otherwise only moved by
      // the note_about_* tools — a plain warm reply ("thanks, you too!") left
      // it frozen at coda-send time, so engaged colleagues were scored
      // "no response" and ranked DOWN. 'person' bumps last_social_at only
      // (NOT last_initiated_at), so the daily-ping cadence gate is unaffected.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { recordSocialMoment } = require('../../db') as typeof import('../../db');
      recordSocialMoment(input.userId, 'person');
    } catch (err) {
      logger.warn('In-conversation rank adjustment threw — non-fatal', { err: String(err).slice(0, 300) });
    }
  }

  // v2.2.1 Pattern 1 — slack-available task turns → social coda.
  // Task always wins, BUT if the task produced a "parking" tool call (coord
  // initiated, message_colleague await_reply, create_approval, outreach_send)
  // then Maelle has nothing else to do this moment — she's waiting on
  // someone. That's the right time to weave in social if the 24h cadence
  // gate passes. One short additional sentence appended to the task reply.
  // Never hijacks the task response; always starts with the task.
  // v2.2.3 (#3) — task-coda piggyback also gated on persona being active.
  // socialClassification will be null when persona is off, but belt-and-
  // suspenders the explicit check too.
  if (
    socialActive
    && socialClassification?.kind === 'task'
    && finalReply
    && finalReply.trim().length > 0
    && toolCallSummaries.length > 0
    // v3.6.2 — 1:1 DMs ONLY. The coda is a per-person rapport ping (people
    // memory + social ranking); in a multi-party thread it has no single target
    // and reads as Maelle doing personal small-talk with a colleague in front of
    // the owner (the Rita MPIM, 2026-07-06 — "she can't ask it when I'm there").
    // Suppress in every MPIM and channel; owner-DM and colleague-DM still get it.
    && !input.isMpim
    && !input.isChannel
    // v2.5.2 — fire on BOTH owner-path AND colleague-path turns. People memory
    // + social engagement EXIST so Maelle is socially smarter with colleagues
    // (and warm with the owner). The model: resolve the task FIRST, then add
    // ONE warm line on the way out. The daily/24h gates inside the picker
    // (directiveForProactiveSlot) + rank-0 opt-out prevent over-firing.
  ) {
    // v3.2.5 — end-of-turn social coda on work/scheduling turns, RE-ENABLED
    // (option A). Owner direction: "run it on work turns, but at the END of the
    // process, not in the middle." So the coda may ride a task turn when the
    // work either RESOLVED this turn (booking done, question answered, note
    // saved) OR was handed off to someone else (coordination / approval /
    // await-reply outreach — a natural lull). It is SUPPRESSED only when the
    // turn is still mid-exchange — Maelle returned a question/decision to the
    // current interlocutor (confirm-override, pick-a-slot, rule exception) or a
    // tool failed — which `turnLeftWorkPending` captures during the tool loop.
    //
    // History: the original piggyback (v2.2.1) fired on parking turns but the
    // picker was context-blind → mid-booking non-sequitur ("btw that Samuel L.
    // Jackson movie...", 2026-05-11). It was hard-disabled. Two things changed
    // since: (1) the claimChecker coda-validator below drops invented-fact /
    // off-base codas, and (2) the `turnLeftWorkPending` guard keeps the coda
    // off genuinely mid-process turns. The cold-open socialOutreachTick is
    // gone (v3.2.5) — this in-conversation coda is now the ONLY proactive-
    // social surface.
    const codaEligible = !turnLeftWorkPending;
    if (codaEligible) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { directiveForProactiveSlot } = require('../social/stateMachine') as typeof import('../social/stateMachine');
        const codaDirective = directiveForProactiveSlot({
          personSlackId: turnPersonSlackId,
          ownerTimezone: profile.user.timezone,
        });
        if (codaDirective.mode === 'continue' || codaDirective.mode === 'raise_new') {
          // v2.2.4 (bug 1A) — pass conversation language so the coda matches.
          // Detect from the inbound user message — Hebrew chars present → 'he',
          // else 'en'. Cheap, deterministic; the coda generator falls back to
          // English when omitted, so failure mode is graceful.
          const codaLang: 'he' | 'en' = /[֐-׿]/.test(input.userMessage ?? '') ? 'he' : 'en';
          const coda = await generateSocialCoda({
            profile,
            directive: codaDirective,
            senderRole: turnSenderRole,
            senderFirstName: turnSenderRole === 'owner'
              ? profile.user.name.split(' ')[0]
              : (input.senderName?.split(' ')[0] ?? 'there'),
            language: codaLang,
          });
          // v2.3.2 (2B) — validate coda against people_memory before appending.
          // Catches the "shares my name" / "marathon training" hallucinations
          // (invented facts) and gossipy commentary about third parties.
          // Reuses claimChecker with mode='coda' so the same JSON contract /
          // fail-open semantics apply. Fails open: if the validator can't
          // reach a verdict, the coda still ships (better one weird coda than
          // dropping every coda when the API blips).
          let codaPassed = true;
          if (coda && coda.trim().length > 0) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { checkReplyClaims } = require('../../utils/claimChecker') as
                typeof import('../../utils/claimChecker');
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { getPersonMemory } = require('../../db') as typeof import('../../db');
              const personRow = getPersonMemory(turnPersonSlackId);
              // Build a compact text snapshot of what we know about the
              // recipient. Notes (free-text) + topics (categories/labels) +
              // state/timezone are the inputs Sonnet should be riffing on.
              const snapshot: string[] = [];
              if (personRow) {
                if (personRow.state) snapshot.push(`state: ${personRow.state}`);
                if (personRow.timezone) snapshot.push(`timezone: ${personRow.timezone}`);
                if (personRow.notes) {
                  try {
                    const notes = JSON.parse(personRow.notes) as Array<{ note?: string }>;
                    for (const n of notes.slice(-10)) if (n.note) snapshot.push(`note: ${n.note}`);
                  } catch { /* ignore */ }
                }
              }
              const recipientName = input.senderName ?? personRow?.name ?? turnPersonSlackId;
              const verdict = await checkReplyClaims({
                reply: coda,
                toolSummaries: [],
                bookingOccurred: false,
                ownerFirstName: profile.user.name.split(' ')[0],
                mode: 'coda',
                coda: {
                  recipientName,
                  recipientFactsSnapshot: snapshot.length > 0 ? snapshot.join('\n') : '(no notes / topics on record)',
                },
              });
              if (verdict.claimed_action === true) {
                codaPassed = false;
                logger.info('Coda dropped by validator', {
                  reason: verdict.action_type, summary: verdict.action_summary,
                  codaPreview: coda.slice(0, 120),
                });
              }
            } catch (err) {
              logger.warn('Coda validator threw — letting coda through (fail-open)', {
                err: String(err).slice(0, 200),
              });
            }
          }

          if (coda && coda.trim().length > 0 && codaPassed) {
            finalReply = `${finalReply.trim()}\n\n${coda.trim()}`;
            // v2.6.7 — mark the subject as raised so the next inbound from
            // this person triggers the +1/−1 engagement signal. Subject id
            // comes from codaDirective.subjectId (legacy alias topicId
            // preserved on LegacySocialDirectiveShape). raise_new mode
            // doesn't have a subject yet — the signal applies once the
            // person responds and a subject gets created/matched.
            if (codaDirective.subjectId) {
              try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { markSubjectRaised } = require('../../db/socialSubjects') as
                  typeof import('../../db/socialSubjects');
                markSubjectRaised(codaDirective.subjectId);
              } catch (err) {
                logger.warn('markSubjectRaised threw — continuing', { err: String(err).slice(0, 200) });
              }
            }
            // Record the coda as a Maelle-initiated social moment on the PERSON.
            // Sets people_memory.last_initiated_at → opens the 24h window that
            // `adjustRankFromColleagueResponse` keys on to score the colleague's
            // reply (+1 engaged / −1 deflection / nothing if ignored). Fires for
            // BOTH continue and raise_new codas, so discovery codas score too.
            // v3.2.6 — the old 48h `social_ping_rank_check (coda)` task was
            // REMOVED: it penalized −1 for an ignored tail-end coda, which the
            // owner explicitly killed ("nothing to lose by ignoring"). Rank now
            // moves ONLY on a real reply, live, via adjustRankFromColleagueResponse.
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { recordSocialMoment } = require('../../db') as typeof import('../../db');
              recordSocialMoment(turnPersonSlackId, 'maelle');
            } catch (err) {
              logger.warn('coda recordSocialMoment threw — continuing', {
                err: String(err).slice(0, 200),
              });
            }
            logger.info('Social coda appended to task turn', {
              personSlackId: turnPersonSlackId,
              mode: codaDirective.mode,
              topic: codaDirective.topicLabel,
            });
          }
        }
      } catch (err) {
        logger.warn('Social coda generation threw — continuing without coda', { err: String(err).slice(0, 300) });
      }
    }
  }

  return {
    reply: finalReply,
    requiresApproval,
    approvalId,
    slackActions,
    bookingOccurred,
    toolSummaries: toolCallSummaries.length > 0 ? toolCallSummaries : undefined,
    mutationActions: mutationActions.length > 0 ? mutationActions : undefined,
    healthCheckVacuous: healthCheckVacuous ? true : undefined,
  };
}

