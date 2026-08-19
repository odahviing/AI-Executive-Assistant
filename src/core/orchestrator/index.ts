import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import type { PendingSocialCoda } from '../social/generateCoda';
import { executeSkillTool, WRITE_TOOLS } from '../../skills/registry';
import type { UserProfile } from '../../config/userProfile';
import type { SkillContext, ChannelId } from '../../skills/types';
import { auditLog } from '../../db';
import { DateTime } from 'luxon';
import logger from '../../utils/logger';
import { callClaude, mutationOutcome, summarizeToolCall, summarizeInternalAction } from './turnHelpers';
import { buildTurnContext } from './buildTurnContext';

export interface OrchestratorInput {
  userMessage: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string; ts?: string }>;
  threadTs: string;
  channelId: string;
  userId: string;
  senderRole: 'owner' | 'colleague';
  senderName?: string;   // colleague's display name — injected into system prompt
  channel: ChannelId;
  /**
   * v4.4.x (#154) — the turn's authenticated authority and surface. Populated
   * by each transport's own front door (Slack) or synthetic caller (replay,
   * scheduled routines, email keepalive) — NEVER derived inside the
   * orchestrator itself. REQUIRED: see SkillContext (skills/types.ts) for the
   * full rationale. Passed through byte-for-byte into SkillContext below.
   */
  authority: 'owner' | 'colleague';
  surface: 'owner_dm' | 'colleague_dm' | 'room';
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
   * v2.6.1 — recent-outbound context block for inbound colleague DMs.
   * Populated by the Slack connector when a colleague's inbound DM lands
   * within 24h of a Maelle-originated message_colleague to that colleague,
   * AND either (a) the inbound is within 10min of the outbound (deterministic
   * match), (b) Sonnet classified it as a response to the outbound (10min-24h
   * window), or (c) the inbound is a thread reply on the outbound's ts.
   *
   * Rendered into the system prompt as a "RECENT OUTBOUND TO THIS COLLEAGUE"
   * block. Soft-framed: Sonnet treats it as the strong default but can pivot
   * if the inbound clearly switches topic. Closes the amnesia where a
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
   * v4.3.0 (#24 rows 132/133/137) — attendee email ADDRESSES a transport's
   * own inbound extraction already resolved for this turn, to be unioned
   * into the SAME `resolvedMeetingAttendees` route Slack's classifyTurn.
   * meetingPeople + resolveNamedInternalAttendees populate from NAMES
   * (buildTurnContext.ts). Slack never sets this — named-colleague
   * resolution covers it. The email connector sets it from
   * `connectors/email/extractParticipants.ts`'s forwarded-header extraction,
   * which resolves genuine EXTERNAL addresses no internal-name lookup could
   * ever produce (an external is never in people_memory under the owner's
   * own domain). One authoritative attendee route, two contributors — never
   * a second, competing spine.
   */
  extractedAttendeeEmails?: string[];
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
  /**
   * A coda is DUE this turn — NOT appended to `reply`, and not yet written.
   * It used to be glued on with "\n\n", so a scheduling answer ended on an
   * unrelated social line and read as a non-sequitur. The transport delivers
   * it as its own message in the same thread, a short beat later.
   *
   * This is a directive, not a sentence. Composing it here meant awaiting a
   * Sonnet call plus a claim-check between "answer ready" and "answer posted" —
   * two round-trips of latency on the WORK answer, for a line the transport
   * then deliberately holds for a beat anyway (5-15s, varied per delivery —
   * L7, social never delays real work). The transport calls
   * `composeSocialCoda` inside that beat instead.
   *
   * It carries its two ids because the social bookkeeping — the once-per-day
   * cadence gate and the subject raise-marker — is stamped on DELIVERY, not on
   * generation (`recordCodaDelivered`, core/social/logEngagement.ts). The
   * transport is the only layer that knows whether the coda actually went out;
   * it drops it on a leak hit, a lost lull, or a failed post.
   */
  socialCoda?: PendingSocialCoda;
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

  const {
    messages,
    systemBlocks,
    tools,
    model,
    maxTokens,
    turnSenderRole,
    turnPersonSlackId,
    socialActive,
    socialClassification,
    resolvedMeetingAttendees,
  } = await buildTurnContext(input);

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
  // coda-repeats-and-merges-with-action-confirmations (bouncer overturn,
  // 2026-08-10) — true once a calendar mutation SUCCEEDS this turn, meaning
  // the reply is about to report an executed action's result ("Done,
  // cancelled X and booked Y"). Distinct from turnLeftWorkPending (which
  // flags a mutation that DIDN'T close): a booking that resolves cleanly
  // used to sail straight through the task-turn coda piggyback below, which
  // only checked turnLeftWorkPending — so a resolved booking still got a
  // coda stacked on it (Bodyguard, 2026-08-09 — confirmed via vm-logs:
  // "Social coda DUE on a task turn" fired the same beat this booking
  // closed, no approval/request-spine row involved at all). Handoff tools
  // (create_approval / message_colleague) are deliberately excluded from
  // `mutators` below — a parking turn still earns its coda; only a genuine
  // action-result confirmation is excluded.
  let turnReportedActionResult = false;
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
  // bouncer fix (pending-cap-blocks-unrelated-questions, 2026-08-10) —
  // colleagues already sent the private cap-notice DM this turn
  // (colleaguePendingCapRefusal, tasks/skill.ts). Kept SEPARATE from
  // messagedColleaguesOkThisTurn on purpose — see that field's comment in
  // skills/types.ts for why folding it in would corrupt the resolver's
  // double-notify guard.
  const capNoticeSentThisTurn = new Set<string>();
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
      // Sonnet-5 retry (staged): the orchestrator is a decision/tool-routing loop,
      // and the thinking-OFF wave (fabricated "I checked", availability flips,
      // under-escalation) traced to Sonnet 5 being less tool-eager + more literal
      // with reasoning disabled. Adaptive thinking at `high` restores tool-reaching
      // + self-verification on the exact layer that broke; `effort` is a ceiling and
      // adaptive throttles within it, so easy turns stay cheap. The full
      // response.content (incl. thinking blocks) is echoed back unchanged at the
      // messages.push below — required on the same model. Guards/classifiers stay
      // thinking-off (SONNET bundle). Revert = MODEL_SONNET → 4.6 (one line).
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
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
      authority: input.authority,
      surface: input.surface,
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
      // bouncer fix (pending-cap-blocks-unrelated-questions) — same by-
      // reference pattern, for colleaguePendingCapRefusal's own duplicate-DM
      // suppression (see skills/types.ts for why it's not folded into the set
      // above).
      capNoticeSentThisTurn,
      // v1.8.9 — carry the inbound transport through. Today every caller is
      // the Slack transport so this defaults to 'slack'. When email/WhatsApp
      // inbound lands, those callers will set their own id.
      inboundConnectionId: input.inboundConnectionId ?? 'slack',
      // v2.8.6 — plumb recent history for the 103D/F owner-in-MPIM-proposed-slot
      // check inside the colleague-path create_meeting handler. Last 8 turns
      // is plenty for "did owner just suggest this time?" detection; passing
      // the whole history would bloat every handler call.
      conversationHistory: conversationHistory.slice(-8),
      // v3.6.4 — internal colleagues resolved from this turn's named
      // participants; find_available_slots unions them so a known attendee is
      // never dropped. Per-turn (rebuilt each response round with the turn's set).
      resolvedMeetingAttendees,
      // v4.4.x (GH#169 revisit) — the raw current-turn message, forwarded so
      // resolve_approval's anchor gate (tasks/skill.ts) can ground its
      // unanchored-but-named fallback on what the sender actually typed,
      // never on the model's own `reason` tool argument. Deliberately the
      // unaugmented `userMessage`, not `effectiveUserMessage` — a claim-
      // checker retry's appended [SYSTEM NOTE …] is not something the owner
      // said and must never satisfy a "did the owner name this" check.
      currentUserMessage: userMessage,
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
        const eventId = (toolUse.input as any)?.meeting_id ?? (toolUse.input as any)?.event_id ?? (toolUse.input as any)?.id;
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
      // v2.8.5 — no assistant-thread gating (see turn-start hook above for the
      // rationale). Slack rejects non-panel calls with channel_not_found /
      // not_in_assistant_thread; the catch in setAssistantStatus swallows that
      // at debug level.
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
      // post-hoc hallucination backstop in app.ts. Only count
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
        // v3.4.2 — owner-path event ledger: remember events created/edited
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
            // Event start date in the owner's TZ — the active-window anchor.
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
        // v4.0.x — also ledger events the owner just LOOKED AT via get_calendar,
        // so a follow-up "move it / who's on it / cancel it" resolves by id
        // instead of the model re-searching — or, as Sonnet 5 did on the "Getting
        // back the Automation" move, calling NO tool and fabricating "I can't find
        // it" one turn after reading it. The read event's id gets trimmed from
        // history within a couple turns; the (separate, capped) viewed-ledger keeps
        // it referenceable. Non-fatal + shape-guarded so an unexpected result is a
        // no-op, never a throw.
        if (toolUse.name === 'get_calendar' && Array.isArray((r as any).events) && input.threadTs) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { recordViewedThreadEvents } = require('../../utils/threadEventLedger') as
              typeof import('../../utils/threadEventLedger');
            const viewed = ((r as any).events as Array<Record<string, any>>)
              .filter(e => typeof e?.id === 'string' && typeof e?.start?.dateTime === 'string')
              .map(e => {
                const d = DateTime.fromISO(e.start.dateTime, { zone: e.start.timeZone ?? profile.user.timezone });
                return {
                  subject: typeof e.subject === 'string' ? e.subject : undefined,
                  eventId: e.id as string,
                  dateIso: d.isValid ? d.toFormat('yyyy-MM-dd') : '',
                };
              });
            recordViewedThreadEvents(input.threadTs, viewed);
          } catch { /* non-fatal */ }
        }
        // v1.6.4 — remember deleted event ids so the same id can't be deleted
        // twice in one turn. See the short-circuit at the top of the loop.
        if (toolUse.name === 'delete_meeting') {
          const eventId = (toolUse.input as any)?.meeting_id ?? (toolUse.input as any)?.event_id ?? (toolUse.input as any)?.id;
          if (typeof eventId === 'string') {
            // Only a CONFIRMED delete arms the same-turn short-circuit — a failed
            // delete must leave the id retryable (still_present_after_delete /
            // meeting_id_subject_mismatch both expect a same-turn retry to actually
            // re-attempt, not be told "already deleted this turn").
            const deleteConfirmed = r.success === true || r.deleted === true || r.ok === true;
            if (deleteConfirmed) {
              deletedEventIdsThisTurn.add(eventId);
            }
            // Drop it from the thread ledger too, so a later reference-back
            // ("change the one I just booked") never resolves to the dead id.
            if (input.threadTs && deleteConfirmed) {
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
        // v3.4.7 — record requesters the resolver relayed a NON-reject approval
        // outcome to this turn, so a same-turn message_colleague to them is
        // suppressed (the double-notify guard at the top of the loop; Ayala Geni
        // 2026-06-22). Deterministic, no clock: requester_notified_at is stamped
        // ONLY on a confirmed relay send, and state=awaiting_colleague means the
        // amend counter was relayed — either way the requester already heard the
        // substantive content. A failed/skipped relay leaves both unset, so
        // message_colleague stays available (never a silent drop).
        // AP1 (2026-07-23) — a `reject` relay is EXCLUDED here: it's a terminal
        // outcome notice, not content-bearing, so it must NOT arm the guard.
        // Arming it silently swallowed a DISTINCT follow-up message_colleague —
        // the "ask if Rita can cover?" question that reached Simon as nothing
        // after a "can't make it" reject. Excluding reject leaves message_colleague
        // free so a genuinely different message still gets through; approve/amend
        // stay armed (their relay IS the substance, so a second DM there is the
        // real duplicate this guard exists to stop).
        if (toolUse.name === 'resolve_approval' && input.senderRole === 'owner'
            && result && typeof result === 'object' && (result as { ok?: boolean }).ok === true) {
          try {
            const reqId = (result as { request_id?: string; approval_id?: string }).request_id
              ?? (result as { approval_id?: string }).approval_id;
            const verdict = (toolUse.input as { verdict?: string })?.verdict;
            if (typeof reqId === 'string' && verdict !== 'reject') {
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
      // v4.1.x — rendered by summarizeInternalAction so these lines carry the same
      // `mutated=<domain>` marker the top-level summaries do, which is what the
      // claim-checker shield reads. This is the only OTHER writer to this tape that
      // reports a COMPLETED mutation; the remaining direct pushes above (duplicate
      // send / delete short-circuits, rate-limit deferral) all describe something
      // that deliberately did NOT happen, so they correctly stay unmarked.
      if (result && typeof result === 'object' && Array.isArray((result as { internal_actions?: unknown }).internal_actions)) {
        const internalActions = (result as { internal_actions: Array<{ tool?: string; detail?: string }> }).internal_actions;
        for (const a of internalActions) {
          if (typeof a?.tool === 'string') {
            toolCallSummaries.push(summarizeInternalAction(a.tool, toolUse.name, a.detail));
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
          || Array.isArray(r.slot_options)
          // v3.7.x (1.6) — find_available_slots returns its options under `slots`;
          // the guard only knew `options`/`slot_options`, so a slot-search turn
          // (which hands the owner a pick to make) slipped past and the social
          // coda rode on it — the "spelling of Zoe's name" mid-scheduling
          // non-sequitur. A pending slate of slots IS an open decision.
          || Array.isArray(r.slots)
          // gh#chris-kelley-oof-block-a — find_available_slots's zero-result
          // branch returns the BARE array itself (findAvailableSlots.ts's
          // `return rawSlots` / `return []`), not `{ slots: [...] }` — on
          // that shape `r.slots` is undefined (arrays have no `.slots`
          // property) and the check above never fires, so the "still
          // mid-exchange" guard silently never armed for a dead-ended
          // search. A bare-array result is find_available_slots's own
          // result, not any other tool's — gate on the tool name so a bare
          // array from a different read (get_calendar's own bare-array
          // shape) is never mistaken for a pending slot slate.
          || (toolUse.name === 'find_available_slots' && Array.isArray(result));
        // A mutating meeting op that didn't close, or any tool that errored.
        const mutators = new Set(['create_meeting', 'move_meeting', 'delete_meeting', 'book_floating_block', 'book_lunch']);
        const failedMutation = mutators.has(toolUse.name)
          && r.success !== true && r.deleted !== true;
        const errored = r.ok === false || typeof r.error === 'string';
        if (awaitingDecision || failedMutation || errored) {
          turnLeftWorkPending = true;
        }
        // coda-repeats-and-merges-with-action-confirmations — the mirror of
        // failedMutation above: this mutation actually succeeded, so the
        // reply is reporting a real, executed action.
        if (mutators.has(toolUse.name) && (r.success === true || r.deleted === true)) {
          turnReportedActionResult = true;
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

      // gh#201-d — the ONE case maybeOpenInFlightMeetingRequest deliberately
      // excludes: a colleague-initiated find_available_slots search that
      // dead-ends purely because the owner is in a known away period. That
      // exclusion is still correct for every other colleague reason (those
      // route through message_colleague/create_approval already); this is
      // the new path for the one reason that had none. See
      // core/requests/colleagueOofReengage.ts for the full mechanism.
      //
      // gh#201-d (D2 fix, bouncer overturn) — gated on `input.authority`, NOT
      // `input.senderRole`. `senderRole` is CONTEXT-derived: processMessage.ts
      // clamps it to 'colleague' for the owner himself in any MPIM/channel
      // (room security — colleague-level tools/narration in a shared surface),
      // so `senderRole !== 'owner'` reads true for the owner asking about
      // availability in his own room during his own away period. `authority`
      // is the authenticated Slack sender, never clamped by surface (see its
      // own doc comment above in OrchestratorInput) — the genuine identity
      // check this trigger needs.
      //
      // gh#201-d (bouncer second pass) — `authority` alone still misses one
      // case: processMessage.ts's debounce merge clamps `effectiveAuthority`
      // to 'colleague' for the WHOLE turn whenever the merged batch spans
      // multiple senders, even when the runner (`input.userId`) is the owner's
      // own Slack id landing in the same room thread as a colleague's message
      // inside the debounce window. Compare the authenticated identity
      // directly, same pattern as core/requests/runner.ts:449, so that case
      // is covered too. Together these mean the owner can never open a
      // tracking row keyed to his own slack id or get proactively DM'd as if
      // he were the colleague he was asking about.
      if (
        toolUse.name === 'find_available_slots'
        && input.authority !== 'owner'
        && input.userId !== profile.user.slack_user_id
      ) {
        try {
          const oof = require('../requests/colleagueOofReengage') as
            typeof import('../requests/colleagueOofReengage');
          await oof.maybeTrackColleagueOofDeadEnd({
            ownerUserId: profile.user.slack_user_id,
            colleagueSlackId: input.userId,
            colleagueName: input.senderName,
            threadTs: input.threadTs,
            channel: input.channelId,
            toolInput: toolUse.input as Record<string, unknown>,
            toolResult: result,
            profile,
          });
        } catch (err) {
          logger.warn('maybeTrackColleagueOofDeadEnd threw — non-fatal', {
            err: String(err).slice(0, 200), tool: toolUse.name,
          });
        }
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
          update_task: 'updated a task',
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
          // Calendar health
          check_calendar_health: 'reviewed calendar health',
          book_floating_block: 'blocked the slot',
          set_event_category: 'categorized the event',
          manage_calendar_issue: 'updated the calendar issue',
          // Outreach
          message_colleague: 'sent the message',
          find_slack_channel: 'found the channel',
          find_slack_user: 'found the person',
          // Search / knowledge
          web_search: 'searched the web',
          web_extract: 'pulled the page',
          manage_knowledge: 'checked the knowledge base',
          // Routines
          manage_routine: 'updated your routines',
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
          'create_task', 'update_task',
          // Tier 3 — outreach + briefings
          'message_colleague', 'send_briefing_now',
          // Tier 4 — calendar health
          'check_calendar_health', 'set_event_category', 'manage_calendar_issue',
          // Tier 5 — knowledge / routines (rarely standalone)
          'manage_knowledge', 'manage_routine',
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
    ownerUserId: profile.user.slack_user_id,
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
      // Bump last_social_at on a genuine colleague social reply. That field
      // is otherwise only moved by the note_about_* tools — a plain warm
      // reply ("thanks, you too!") left it frozen, so a colleague who
      // engaged looked untouched. 'person' bumps last_social_at only
      // (NOT last_initiated_at), so the daily-ping cadence gate is unaffected.
      // (gh#198 — the old 48h coda rank-check this comment used to describe,
      // socialPingRankCheck.ts, is deleted; rank now moves only via
      // adjustRankFromColleagueResponse above and engagement signals.)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { recordSocialMoment } = require('../../db') as typeof import('../../db');
      recordSocialMoment(input.userId, 'person');
    } catch (err) {
      logger.warn('In-conversation rank adjustment threw — non-fatal', { err: String(err).slice(0, 300) });
    }
  }

  // The coda DUE this turn, handed to the transport to compose and post
  // SEPARATELY (see OrchestratorOutput.socialCoda). Every gate below still runs
  // here — eligibility is a property of the turn, and only the turn knows it —
  // but nothing is awaited: the writing happens in the transport's post-reply beat.
  let socialCoda: PendingSocialCoda | null = null;
  // v2.2.1 Pattern 1 — slack-available task turns → social coda.
  // Task always wins, BUT if the task produced a "parking" tool call (coord
  // initiated, message_colleague await_reply, create_approval, outreach_send)
  // then Maelle has nothing else to do this moment — she's waiting on
  // someone. That's the right time to weave in social if the 24h cadence
  // gate passes. ONE short sentence, handed to the transport as its own
  // message — never spliced onto the task reply, which read as a topic swerve
  // in the reply's last line ("…17:30 Sydney. Any trips coming up?").
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
    // work was ANSWERED (a question, "note saved") or HANDED OFF to someone
    // else (coordination / approval / await-reply outreach — a natural lull).
    // It is SUPPRESSED when the turn is still mid-exchange — Maelle returned a
    // question/decision to the current interlocutor (confirm-override,
    // pick-a-slot, rule exception) or a tool failed — which
    // `turnLeftWorkPending` captures during the tool loop — OR when this turn
    // is reporting an executed action's result (a booking/cancel/move that
    // actually succeeded — `turnReportedActionResult`, coda-repeats-and-
    // merges-with-action-confirmations): that confirmation is the thing the
    // person is reading right now, and L7 puts a coda stacked on top of it in
    // the "never in the way" bucket even though the work did resolve.
    //
    // History: the original piggyback (v2.2.1) fired on parking turns but the
    // picker was context-blind → mid-booking non-sequitur ("btw that Samuel L.
    // Jackson movie...", 2026-05-11). It was hard-disabled. Two things changed
    // since: (1) the claimChecker coda-validator (now inside composeSocialCoda)
    // drops invented-fact / off-base codas, and (2) the `turnLeftWorkPending`
    // guard keeps the coda off genuinely mid-process turns. The cold-open
    // socialOutreachTick is gone (v3.2.5) — this in-conversation coda is now the
    // ONLY proactive-social surface.
    const codaEligible = !turnLeftWorkPending && !turnReportedActionResult;
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
          // Eligibility is settled HERE — it is a property of this turn and
          // nothing downstream can re-derive it. The SENTENCE is not written
          // here: `composeSocialCoda` runs in the transport's existing
          // post-reply beat (a 5-15s range, not a fixed wait — see
          // CODA_DELAY_MIN_MS/MAX_MS in postReply.ts), so the LLM round-trips
          // and grounding lookups it costs land on dead time instead of
          // between the work answer being ready and the person seeing it.
          // Nothing is stamped either — the cadence gate
          // (people_memory.last_initiated_at) and the subject raise-marker are
          // written by `recordCodaDelivered` once the transport confirms the
          // post.
          // gh#198 — channelId threaded through so the composer's grounding
          // pass can re-read this person's actual past messages (SlackMaster's
          // getRecentChannelMessages) rather than a topic-beat label.
          socialCoda = {
            directive: codaDirective,
            personSlackId: turnPersonSlackId,
            subjectId: codaDirective.subjectId ?? undefined,
            channelId: input.channelId,
            senderRole: turnSenderRole,
            senderFirstName: turnSenderRole === 'owner'
              ? profile.user.name.split(' ')[0]
              : (input.senderName?.split(' ')[0] ?? 'there'),
            language: codaLang,
          };
          logger.info('Social coda DUE on a task turn — transport composes and posts it separately', {
            personSlackId: turnPersonSlackId,
            mode: codaDirective.mode,
            topic: codaDirective.subjectLabel,
            subjectId: codaDirective.subjectId ?? null,
          });
        }
      } catch (err) {
        logger.warn('Social coda eligibility check threw — continuing without coda', { err: String(err).slice(0, 300) });
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
    socialCoda: socialCoda ?? undefined,
  };
}

