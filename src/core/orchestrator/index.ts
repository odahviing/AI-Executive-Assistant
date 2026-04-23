import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { buildSystemPromptParts } from './systemPrompt';
import { getSkillTools, executeSkillTool } from '../../skills/registry';
import type { UserProfile } from '../../config/userProfile';
import type { SkillContext, ChannelId } from '../../skills/types';
import { auditLog, buildSocialContextBlock, getSummarySessionByThread } from '../../db';
import { getActiveJobsForThread } from '../../tasks';
import { DateTime } from 'luxon';
import logger from '../../utils/logger';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/**
 * Wraps anthropic.messages.create with a single retry on 429 rate-limit errors.
 * Reads the retry-after header so we wait exactly as long as the API needs.
 */
async function callClaude(
  params: Anthropic.MessageCreateParamsNonStreaming,
  retriesLeft = 1,
): Promise<Anthropic.Message> {
  try {
    return await anthropic.messages.create(params) as Anthropic.Message;
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
function summarizeToolCall(toolName: string, input: Record<string, unknown>, result: unknown): string {
  try {
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
      case 'coordinate_meeting':
        return `[coordinate_meeting: "${(input as any).subject}" with ${((input as any).participants as any[])?.map((p: any) => p.name).join(', ')}]`;
      case 'dismiss_calendar_issue':
        return `[dismiss_calendar_issue: ${input.issue_type} on ${input.event_date}]`;
      case 'find_slack_user':
        return `[find_slack_user: "${input.name}"]`;
      case 'message_colleague':
        return `[message_colleague: ${(input as any).colleague_name}]`;
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

export interface OrchestratorInput {
  userMessage: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  threadTs: string;
  channelId: string;
  userId: string;
  senderRole: 'owner' | 'colleague';
  senderName?: string;   // colleague's display name — injected into system prompt
  channel: ChannelId;
  profile: UserProfile;
  app?: import('@slack/bolt').App;
  isMpim?: boolean;                   // true if this is a group DM (MPIM)
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
}

/**
 * The main agent loop.
 * Tools come from active skills — determined by the user's profile YAML.
 * Zero hardcoded business logic here.
 */
export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorOutput> {
  const { userMessage, conversationHistory, threadTs, profile } = input;

  logger.info('Orchestrator invoked', {
    user: profile.user.name,
    channel: input.channel,
    senderRole: input.senderRole,
    isOwnerInGroup: input.isOwnerInGroup ?? false,
    isMpim: input.isMpim ?? false,
    preview: userMessage.slice(0, 80),
  });

  // v1.6.2 — claim-checker retry path: allow appending a one-shot nudge to the
  // current user message so the model knows why it's being re-invoked. Never
  // persisted to conversation history (callers pass it as extraInstruction
  // exactly once per retry).
  const effectiveUserMessage = input.extraInstruction
    ? `${userMessage}\n\n[SYSTEM NOTE — not from ${profile.user.name.split(' ')[0]}: ${input.extraInstruction}]`
    : userMessage;

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
      content: m.content,
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
  const promptParts = buildSystemPromptParts(profile, input.senderRole, input.senderName, input.isOwnerInGroup, focusSlackIds);

  // Inject active jobs for this thread so Maelle knows what she already committed to.
  // This prevents her from treating follow-up messages as new requests.
  let threadContextBlock = '';
  if (input.senderRole === 'owner' && threadTs) {
    const { tasks, coordJobs, outreachJobs } = getActiveJobsForThread(
      profile.user.slack_user_id,
      threadTs,
    );

    const lines: string[] = [];

    for (const job of coordJobs) {
      // v1.6 — coord_jobs (multi-participant). Parse participants for a short label.
      let participantLabel = 'participants';
      try {
        const parts = JSON.parse(job.participants || '[]') as Array<{ name?: string; just_invite?: boolean }>;
        const keyNames = parts.filter(p => !p.just_invite).map(p => p.name).filter(Boolean);
        if (keyNames.length > 0) participantLabel = keyNames.join(', ');
      } catch (_) {}
      const status =
        job.status === 'collecting' ? 'collecting responses'
        : job.status === 'negotiating' ? 'negotiating time'
        : job.status === 'waiting_owner' ? 'waiting on your approval'
        : job.status;
      lines.push(`• Coordination job: "${job.subject}" with ${participantLabel} — ${status}`);
    }

    for (const job of outreachJobs) {
      const status = job.status === 'pending_scheduled' && job.scheduled_at
        ? `scheduled — message goes out ${DateTime.fromISO(job.scheduled_at).setZone(profile.user.timezone).toFormat('EEEE d MMM')}`
        : job.status === 'sent'
        ? `sent, waiting for reply`
        : job.status;
      lines.push(`• Outreach to ${job.colleague_name} — ${status}${job.message ? `: "${job.message.slice(0, 80)}${job.message.length > 80 ? '…' : ''}"` : ''}`);
    }

    for (const task of tasks) {
      if (!coordJobs.some(j => j.id === task.skill_ref) && !outreachJobs.some(j => j.id === task.skill_ref)) {
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

  // Social engagement context — injected for every person Maelle talks to
  const socialBlock = buildSocialContextBlock(input.userId, input.profile.user.timezone);

  const systemBlocksDynamic = [
    promptParts.dynamic,
    threadContextBlock,
    socialBlock,
  ].filter(Boolean).join('\n\n');

  const systemBlocks: Anthropic.TextBlockParam[] = promptParts.static
    ? [
        { type: 'text', text: promptParts.static, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam,
        { type: 'text', text: systemBlocksDynamic } as Anthropic.TextBlockParam,
      ]
    : [{ type: 'text', text: systemBlocksDynamic } as Anthropic.TextBlockParam];

  // Tools are collected from active skills — filtered by sender role
  // Colleagues get a restricted subset; owner gets everything
  const tools = getSkillTools(profile, input.senderRole);

  let requiresApproval = false;
  let approvalId: string | undefined;
  // Track tools called so we can save a summary in conversation history.
  // This prevents Claude from forgetting what it just did on the next turn.
  const toolCallSummaries: string[] = [];
  let finalReply = '';
  const slackActions: SlackAction[] = [];
  // True if any tool in this turn actually performed a real calendar booking.
  // Consumed by the post-hoc hallucination backstop in app.ts — if the reply
  // claims a booking happened but this is false, the claim is rewritten.
  let bookingOccurred = false;
  // True once coordinate_meeting has successfully queued a coord this turn.
  // Subsequent coordinate_meeting calls within the same orchestrator invocation
  // are short-circuited with an idempotent "already initiated" response. This
  // guards against a retry-loop pattern where the LLM reads the queued response
  // as a failure signal and re-calls the tool, spamming the rate limiter and
  // (in the worst case) spawning duplicate coord jobs. v1.4.1.
  let coordQueuedThisTurn = false;
  // v1.6.4 — track delete_meeting ids already executed this turn. The claim-
  // checker found a case where the LLM called delete_meeting twice with the
  // same id and then narrated "two meetings deleted" — half lie. This guard
  // makes the second call a no-op with an explicit signal; the LLM sees that
  // and can correct its narrative.
  const deletedEventIdsThisTurn = new Set<string>();
  // v1.7.4 — track message_colleague calls per turn keyed on colleague_slack_id.
  // The Amazia 6-second-apart bug came from the claim-checker false-positive
  // forcing a retry with tool_choice: message_colleague — Sonnet, forced to
  // call again, created a second outreach_jobs row. Even with the upstream
  // fixes in claim-checker + postReply.ts, this is the deterministic backstop:
  // any second message_colleague call this turn for the same colleague is a
  // no-op with an explicit signal.
  const messagedColleaguesThisTurn = new Set<string>();
  let iteration = 0;
  const MAX_ITERATIONS = 10;

  while (iteration < MAX_ITERATIONS) {
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

    // No tool calls — this is the final text response
    if (toolBlocks.length === 0) {
      finalReply = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('\n')
        .trim();
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
      // v1.8.9 — carry the inbound transport through. Today every caller is
      // the Slack transport so this defaults to 'slack'. When email/WhatsApp
      // inbound lands, those callers will set their own id.
      inboundConnectionId: input.inboundConnectionId ?? 'slack',
    };

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolBlocks as Anthropic.ToolUseBlock[]) {
      // ── IDEMPOTENCY: coordinate_meeting once per turn ──
      // If coord was already queued this turn, short-circuit any further
      // coordinate_meeting calls. The LLM sometimes reads the queued response
      // as failure and retries; this catches that deterministically. Runs
      // before rate-limit / guards so retries don't consume security budget.
      if (toolUse.name === 'coordinate_meeting' && coordQueuedThisTurn) {
        logger.info('coordinate_meeting called again in same turn — idempotent short-circuit', {
          senderUserId: input.userId,
          threadTs,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            _status: 'already_initiated',
            _note: 'Coord was already initiated earlier this turn — DMs are dispatching. Do NOT call coordinate_meeting again. Reply briefly ("On it — I\'ll reach out now") and stop.',
          }),
        });
        toolCallSummaries.push(`[${toolUse.name}] already-queued — skipped`);
        continue;
      }

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
        // coordinate_meeting gets a stricter limit (abuse signal)
        const ownerFirst = profile.user.name.split(' ')[0];
        if (toolUse.name === 'coordinate_meeting') {
          const check = checkAndRecord('colleague_coord', key);
          if (!check.allowed) {
            logger.warn('⚠ SECURITY — colleague coordinate_meeting rate limit exceeded', {
              senderUserId: input.userId,
              threadTs,
              resetInMs: check.resetInMs,
              toolName: toolUse.name,
            });
            // Shadow-notify the owner — this threshold implies either abuse or
            // a stuck retry loop. Either way, the owner should see it so they
            // can take over. Maelle never frames herself as "too busy".
            try {
              if (input.app) {
                const { shadowNotify } = await import('../../utils/shadowNotify');
                await shadowNotify(profile, {
                  channel: input.channelId,
                  threadTs,
                  action: '⚠ Coord rate limit hit',
                  detail: `${input.senderName ?? input.userId} has tried to coordinate a meeting multiple times in a short window. I deflected with "let me check with ${ownerFirst}". You may want to reach out directly.`,
                });
              }
            } catch (_) {}
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({
                _status: 'deferred_to_owner',
                message: `Respond briefly and warmly: "Let me check with ${ownerFirst} and come back to you on this." Do NOT mention pausing, being busy, or needing to slow down. Do NOT promise a specific timeline. ${ownerFirst} has already been notified and will follow up.`,
              }),
            });
            toolCallSummaries.push(`[${toolUse.name}] rate-limited — deferred to owner`);
            continue;
          }
        }
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

        // ── COORD GUARDS: injection scan + LLM judge for coordinate_meeting ──
        // Defense-in-depth. Injection scan catches obvious payloads deterministically;
        // LLM judge catches subtler manipulation that the surface scan misses.
        if (toolUse.name === 'coordinate_meeting') {
          const { scanForInjection, judgeCoordRequest } = await import('../../utils/coordGuard');

          // Collect recent colleague messages (current + up to last 4 from user role)
          const colleagueMsgs = [
            ...input.conversationHistory.filter(m => m.role === 'user').map(m => m.content),
            input.userMessage,
          ].slice(-5);

          // (a) Deterministic injection pattern scan over the full colleague chatter.
          //     Scanning the joined recent messages rather than just the current one —
          //     multi-turn injections often stage the payload across messages.
          const joinedRecent = colleagueMsgs.join('\n---\n');
          const injScan = scanForInjection(joinedRecent);
          if (injScan.matched) {
            logger.warn('⚠ SECURITY — coord request tripped injection scan — REFUSED', {
              senderUserId: input.userId,
              senderName: input.senderName,
              threadTs,
              triggers: injScan.triggers,
              toolArgs: toolUse.input,
              recentPreview: joinedRecent.slice(0, 300),
            });
            try {
              if (input.app) {
                const { shadowNotify } = await import('../../utils/shadowNotify');
                await shadowNotify(profile, {
                  channel: input.channelId,
                  threadTs,
                  action: '⚠ Security: coord blocked (injection pattern)',
                  detail: `Colleague ${input.senderName ?? input.userId} tripped: ${injScan.triggers.join(', ')}. Tool args refused.`,
                });
              }
            } catch (_) {}
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({
                error: 'suspicious_request_blocked',
                message: `This request looks off — patterns matched: ${injScan.triggers.join(', ')}. Do NOT proceed. Respond to the colleague exactly: "I'm just ${profile.user.name.split(' ')[0]}'s assistant — if you'd like to set something up with him, tell me in your own words what you need."`,
              }),
            });
            toolCallSummaries.push(`[${toolUse.name}] injection scan matched — refused`);
            continue;
          }

          // (b) LLM-as-judge — Haiku sanity check. ~500ms, ~$0.0002.
          const toolArgs = toolUse.input as Record<string, unknown>;
          const subject = String(toolArgs.subject ?? '');
          const durationMin = Number(toolArgs.duration_min ?? 0);
          const participantNames = [
            ...((toolArgs.participants as any[]) ?? []),
            ...((toolArgs.just_invite as any[]) ?? []),
          ].map((p: any) => String(p.name ?? p.slack_id ?? 'unknown'));

          const judgeResult = await judgeCoordRequest({
            senderName: input.senderName ?? 'colleague',
            senderRecentMessages: colleagueMsgs,
            ownerFirstName: profile.user.name.split(' ')[0],
            subject,
            participantNames,
            durationMin,
          });

          if (judgeResult.verdict === 'SUSPICIOUS') {
            logger.warn('⚠ SECURITY — coord judge flagged SUSPICIOUS — REFUSED', {
              senderUserId: input.userId,
              senderName: input.senderName,
              threadTs,
              reason: judgeResult.reason,
              elapsedMs: judgeResult.elapsedMs,
              subject,
              participantNames,
            });
            try {
              if (input.app) {
                const { shadowNotify } = await import('../../utils/shadowNotify');
                await shadowNotify(profile, {
                  channel: input.channelId,
                  threadTs,
                  action: '⚠ Security: coord blocked (judge SUSPICIOUS)',
                  detail: `Colleague ${input.senderName ?? input.userId} — reason: ${judgeResult.reason}. Subject: "${subject.slice(0, 80)}". Participants: ${participantNames.join(', ') || '(none)'}.`,
                });
              }
            } catch (_) {}
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({
                error: 'suspicious_request_blocked',
                message: `This request was flagged as suspicious. Do NOT proceed. Respond to the colleague warmly but briefly: "Let me check in with ${profile.user.name.split(' ')[0]} before I set anything up — I'll come back to you."`,
              }),
            });
            toolCallSummaries.push(`[${toolUse.name}] judge SUSPICIOUS — refused`);
            continue;
          }

          logger.info('Coord judge cleared — proceeding', {
            senderUserId: input.userId,
            senderName: input.senderName,
            threadTs,
            verdict: judgeResult.verdict,
            reason: judgeResult.reason,
            elapsedMs: judgeResult.elapsedMs,
          });
        }
      }

      const result = await executeSkillTool(
        toolUse.name,
        toolUse.input as Record<string, unknown>,
        skillContext,
      );

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

      // Check if any skill needs Slack client execution
      if (
        result &&
        typeof result === 'object' &&
        '_requires_slack_client' in result &&
        (result as Record<string, unknown>)._requires_slack_client === true
      ) {
        slackActions.push(result as unknown as SlackAction);
        // Mark coord as queued so subsequent coordinate_meeting calls in the
        // same turn are short-circuited (see idempotency guard above).
        const r = result as Record<string, unknown>;
        if (toolUse.name === 'coordinate_meeting' && r.action === 'coordinate_meeting') {
          coordQueuedThisTurn = true;
        }
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
        if (toolUse.name === 'create_meeting' && (r.eventId || r.id || r.ok === true)) {
          bookingOccurred = true;
        }
        if (toolUse.name === 'finalize_coord_meeting' && r.ok === true && r.status === 'booked') {
          bookingOccurred = true;
        }
        // v1.6.4 — remember deleted event ids so the same id can't be deleted
        // twice in one turn. See the short-circuit at the top of the loop.
        if (toolUse.name === 'delete_meeting') {
          const eventId = (toolUse.input as any)?.event_id ?? (toolUse.input as any)?.id;
          if (typeof eventId === 'string') deletedEventIdsThisTurn.add(eventId);
        }
        // v1.7.4 — remember messaged colleagues so the same colleague can't be
        // messaged twice in one turn. See the short-circuit at the top of the loop.
        if (toolUse.name === 'message_colleague') {
          const colleagueSlackId = (toolUse.input as any)?.colleague_slack_id;
          if (typeof colleagueSlackId === 'string') messagedColleaguesThisTurn.add(colleagueSlackId);
        }
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });

      // Build compact summary for conversation history persistence
      toolCallSummaries.push(summarizeToolCall(toolUse.name, toolUse.input as Record<string, unknown>, result));
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

  // v2.1.5 — never synthesize recovery text on a colleague-facing turn.
  // The recovery pass was built to cover "owner asked Maelle to delete X,
  // tool succeeded, Claude went silent, owner needs confirmation." In a
  // colleague conversation the same mechanism fabricates owner-narrative
  // text ("Yael mentioned she's planning to fly to Boston") and delivers
  // it to the colleague as if Maelle said it. Colleague-facing text must
  // only be what Claude itself wrote — if the main pass went silent, the
  // honest outcome is silence. Owner path keeps the recovery safety net.
  const isColleagueFacing = input.senderRole === 'colleague' && !input.isOwnerInGroup;

  if (!finalReply && !isColleagueFacing) {
    // v1.6.5 — recovery call. The model ran tools but produced no text.
    // Silence (the v1.6.4 behavior) was honest but jarring. Instead we run
    // ONE more Claude pass with a tight system prompt: "you just handled
    // this turn but produced no text; describe what you did in one short
    // human sentence." This is grounded in the real conversation history
    // (the model saw every tool result) so it cannot fabricate from thin
    // air, and the claim-checker still runs on the recovered reply
    // afterwards in postReply.ts. Only if THIS also returns empty do we
    // silence and log.
    const firstName = profile.user.name.split(' ')[0];
    const recoverySystem = `You just handled a turn for ${firstName} but did not write a reply.
Look at the conversation above (${firstName}'s last message + your tool calls + their results). Write ONE short, plain-text sentence.

LANGUAGE — mirror the language of ${firstName}'s MOST RECENT message ONLY. If his latest message is English, reply English. If his latest message is Hebrew, reply Hebrew. Ignore the language of earlier turns, names, or meeting subjects. No inertia, no "natural default", no carry-over.

Three branches — pick the one that fits:

A) YOU DID SOMETHING → describe it grounded in the tool results. One sentence. Example: "Deleted 'Sales Sync' from Wed 22 Apr 16:15."

B) YOU DID NOTHING BECAUSE ${firstName.toUpperCase()}'S REQUEST WAS AMBIGUOUS → say so plainly AND ask ONE specific clarifying question. Example: "Not sure I follow — did you mean Tuesday or Wednesday?" / "Which meeting did you want me to move?". Never fake confidence to avoid the question.

C) YOU DID NOTHING AND CAN'T ARTICULATE WHY → write exactly: NO_REPLY

Rules:
- One sentence (one question is fine in branch B). Plain text. No markdown, no bullets, no preamble.
- If a tool returned an error or did nothing, say so honestly.
- Do not invent results that are not in the tool history.
- Do not call any tools — just write the sentence.`;
    try {
      const recovery = await callClaude({
        model,
        max_tokens: 200,
        system: recoverySystem,
        messages,
      });
      const recoveryText = recovery.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join(' ')
        .trim();
      if (recoveryText && !/^NO_REPLY\s*$/i.test(recoveryText)) {
        logger.info('Orchestrator empty reply recovered via summarizer pass', {
          threadTs, iterations: iteration,
          recoveryPreview: recoveryText.slice(0, 200),
        });
        finalReply = recoveryText;
      } else {
        logger.warn('Orchestrator recovery pass returned NO_REPLY or empty — silencing', {
          threadTs, iterations: iteration, recoveryRaw: recoveryText.slice(0, 200),
        });
      }
    } catch (err) {
      logger.warn('Orchestrator recovery pass errored — silencing', {
        threadTs, iterations: iteration, err: String(err),
      });
    }

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
          const m = s.match(/^\[([a-z_]+)/);
          return m ? m[1] : 'something';
        });
        const distinct = [...new Set(toolNames)];
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
          learn_preference: 'saved that as a preference',
          forget_preference: 'cleared that preference',
          recall_preferences: 'looked up your preferences',
          recall_interactions: 'checked past interactions',
          note_about_person: 'made a note',
          note_about_self: 'made a note about myself',
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
          check_join_availability: 'checked if you can join',
          create_meeting: 'booked the meeting',
          move_meeting: 'moved the meeting',
          update_meeting: 'updated the meeting',
          delete_meeting: 'removed the meeting',
          // Coord
          coordinate_meeting: 'started the coordination',
          finalize_coord_meeting: 'finalized the booking',
          cancel_coordination: 'cancelled the coordination',
          get_active_coordinations: 'checked active coordinations',
          // Calendar health
          check_calendar_health: 'reviewed calendar health',
          book_lunch: 'blocked lunch',
          set_event_category: 'categorized the event',
          get_calendar_issues: 'checked calendar issues',
          update_calendar_issue: 'updated the calendar issue',
          dismiss_calendar_issue: 'dismissed the calendar issue',
          // Outreach
          message_colleague: 'sent the message',
          find_slack_channel: 'found the channel',
          find_slack_user: 'found the person',
          // Search / knowledge
          web_search: 'searched the web',
          web_extract: 'pulled the page',
          list_company_knowledge: 'checked the knowledge base',
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
        const mapped = distinct.map(n => verbMap[n]).filter((v): v is string => !!v);
        // If every tool maps cleanly, list what happened. Otherwise use a
        // generic human phrase so raw tool names never reach the user.
        const verbsText = mapped.length === distinct.length && mapped.length > 0
          ? mapped.join(' and ')
          : 'handled a few things';
        finalReply = `Done — ${verbsText}. Let me know if anything's off.`;
        logger.warn('Orchestrator: tool work happened but no reply text — posted grounded fallback', {
          threadTs,
          iterations: iteration,
          tools: distinct,
          fallbackReply: finalReply,
        });
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
  }

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
  if (
    input.senderRole === 'colleague' &&
    !input.isOwnerInGroup &&
    !requiresApproval &&
    finalReply &&
    finalReply.trim().length > 0
  ) {
    try {
      const { shadowNotify } = await import('../../utils/shadowNotify');
      const who = input.senderName ?? input.userId;
      const replyPreview = finalReply.slice(0, 200).replace(/\s+/g, ' ').trim();
      const toolHint = toolCallSummaries.length > 0
        ? ` (${[...new Set(toolCallSummaries.map(s => {
            const m = s.match(/^\[([a-z_]+)/);
            return m ? m[1] : '';
          }).filter(Boolean))].join(', ')})`
        : '';
      await shadowNotify(profile, {
        channel: input.channelId,
        threadTs,
        action: `${who} → me`,
        detail: `I said: "${replyPreview}"${toolHint}`,
      });
    } catch (err) {
      logger.warn('Inbound-colleague shadow notify threw — continuing', { err: String(err) });
    }
  }

  return {
    reply: finalReply,
    requiresApproval,
    approvalId,
    slackActions,
    bookingOccurred,
    toolSummaries: toolCallSummaries.length > 0 ? toolCallSummaries : undefined,
  };
}

