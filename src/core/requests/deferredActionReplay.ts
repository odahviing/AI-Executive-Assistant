/** Replay an immutable approved action through the shared registered executor.
 * Existing calendar actions retain original-surface narration; other actions run
 * at the stored private owner decision anchor. The registry validates each tool's
 * actual completion/tracking contract. Uncertain calendar outcomes get one safe
 * authoritative read; errors propagate to the resolver without repeating writes.
 */

import type { UserProfile } from '../../config/userProfile';
import { getConnection } from '../../connections/registry';
import logger from '../../utils/logger';
import { PROMOTE_TIMEZONE_TEMP_TOOL, ORIGIN_SURFACE_REPLAY_TOOLS } from './types';
import type { SkillContext } from '../../skills/types';

/** Freeze each approved occurrence and its complete interval in the existing action. */
export async function canonicalizeCoordinatedMoveArgs(args: Record<string, unknown>, profile: UserProfile): Promise<Record<string, unknown>> {
  if (!('coordinated_moves' in args)) return args;
  const { DateTime } = await import('luxon');
  const { resolveStatedInstant, statedZoneFromArgs } = await import('../../utils/weTimeResolver');
  const raw = args.coordinated_moves;
  if (!Array.isArray(raw) || raw.length < 2 || args.meeting_id || args.new_start || args.new_end) {
    throw new ReplayToolError('Supply one complete coordinated plan without singular move fields.', { error: 'invalid_move_plan' });
  }
  const { getEventType } = await import('../../connectors/graph/calendar');
  const { getTravelContextForInstant } = await import('../../utils/workingElsewhere');
  const seen = new Set<string>();
  const moves: Array<{ meeting_id: string; new_start: string; new_end: string }> = [];
  for (const item of raw) {
    if (!item || typeof item.meeting_id !== 'string' || !item.meeting_id.trim() || seen.has(item.meeting_id)
        || typeof item.new_start !== 'string') throw new ReplayToolError('Each occurrence needs its exact agreed interval.', { error: 'invalid_move_plan' });
    seen.add(item.meeting_id);
    // A frozen explicit end never derives duration again from a partly moved calendar.
    const source = await getEventType(profile.user.email, item.meeting_id);
    if (!source || source.type === 'seriesMaster' || !source.startDateTime || !source.endDateTime) {
      throw new ReplayToolError('A specific occurrence could not be read. Refresh its identity before deciding the plan.', { error: 'moving_occurrence_unresolved' });
    }
    const resolved = resolveStatedInstant({ startIso: item.new_start, endIso: typeof item.new_end === 'string' ? item.new_end : undefined,
      statedZone: statedZoneFromArgs(args), homeTz: profile.user.timezone, profile,
      travel: getTravelContextForInstant(item.new_start, profile) });
    const start = DateTime.fromISO(resolved.startIso, { zone: profile.user.timezone });
    const duration = DateTime.fromISO(source.endDateTime).diff(DateTime.fromISO(source.startDateTime), 'milliseconds').milliseconds;
    const end = resolved.endIso ? DateTime.fromISO(resolved.endIso, { zone: profile.user.timezone }) : start.plus({ milliseconds: duration });
    if (!start.isValid || !end.isValid || end <= start) throw new ReplayToolError('The full approved interval is invalid.', { error: 'invalid_move_interval' });
    moves.push({ meeting_id: item.meeting_id, new_start: start.toISO()!, new_end: end.toISO()! });
  }
  return { ...args, coordinated_moves: moves };
}

/** Reconcile every target before any validation that requires a future slot.
 * Already achieved steps are observations, never replayed mutations. */
async function runCoordinatedReplay(input: RunDeferredActionInput): Promise<Record<string, unknown>> {
  const targets = input.args.coordinated_moves as Array<{ meeting_id: string; new_start: string; new_end: string }>;
  const { verifyApprovedCalendarAction } = await import('../../connectors/graph/calendarReads');
  const outcomes: Array<Record<string, unknown>> = [];
  const remaining: typeof targets = [];
  for (const target of targets) {
    const check = await verifyApprovedCalendarAction({ userEmail: input.profile.user.email, profile: input.profile,
      tool: 'move_meeting', args: target });
    if (check.status === 'desired_state_observed') outcomes.push({ ...target, success: true, unchanged: true, ...check.result });
    else if (check.status === 'different_state_observed' && check.reason === 'approved_fields_differ') remaining.push(target);
    else outcomes.push({ ...target, success: false, error: 'move_outcome_unconfirmed', _calendar_verification: check.status });
  }
  const incomplete = (error = 'coordinated_move_incomplete'): never => {
    throw new ReplayToolError('Only the confirmed outcomes are complete. The unchanged agreement remains stored; no successful move was undone.',
      { success: false, error, outcomes, remaining });
  };
  if (outcomes.some(o => o.success !== true)) incomplete();
  if (!remaining.length) return { success: true, outcomes, _replay_status: 'completed' };
  if (remaining.some(m => Date.parse(m.new_start) <= Date.now())) incomplete('coordinated_move_elapsed');
  const args = { ...input.args };
  delete args.coordinated_moves;
  let singularSubject: string | undefined;
  if (remaining.length === 1) {
    // The singular handler requires the current subject from an exact-ID read.
    // Keep it solely in executor args: targets/outcomes can reach a room, where
    // only the handler's scoped display label may be disclosed.
    try {
      const { getEventType } = await import('../../connectors/graph/calendar');
      const source = await getEventType(input.profile.user.email, remaining[0].meeting_id);
      if (source?.type !== 'seriesMaster' && typeof source?.subject === 'string' && source.subject.trim()) singularSubject = source.subject;
    } catch { /* Missing identity or read access cannot authorize a write. */ }
    if (!singularSubject) {
      outcomes.push({ ...remaining[0], success: false, error: 'move_outcome_unconfirmed', _calendar_verification: 'unavailable' });
      return incomplete();
    }
  }
  try {
    // One unfinished step uses the normal singular validator; achieved events
    // stay on the actual calendar and therefore still constrain this move.
    const result = await runDeferredAction({ ...input, args: remaining.length === 1
      ? { ...args, ...remaining[0], meeting_subject: singularSubject } : { ...args, coordinated_moves: remaining }, coordinatedReconciled: true });
    const attempted = Array.isArray(result.outcomes) ? result.outcomes : [{ ...remaining[0], ...result, success: true }];
    return { success: true, outcomes: [...outcomes, ...attempted], _replay_status: 'completed' };
  } catch (err) {
    const failed = err instanceof ReplayToolError ? err.sentinel : { error: 'move_outcome_unconfirmed' };
    // A thrown transport may have committed. Check once, without a second write.
    const reported = Array.isArray(failed.outcomes) ? failed.outcomes : remaining.map(m => ({ ...m, ...failed }));
    for (const target of remaining) {
      const prior = reported.find((o: Record<string, unknown>) => o.meeting_id === target.meeting_id);
      const check = await verifyApprovedCalendarAction({ userEmail: input.profile.user.email, profile: input.profile, tool: 'move_meeting', args: target });
      outcomes.push(check.status === 'desired_state_observed'
        // Retain only the already-scoped label, not the attempted write's
        // causal summary: this read establishes state, not who changed it.
        ? { ...target, ...(typeof prior?.moved === 'string' ? { moved: prior.moved } : {}), success: true, ...check.result }
        : { ...target, ...prior, success: false, _calendar_verification: check.status });
    }
    if (outcomes.every(o => o.success === true)) return { success: true, outcomes, _replay_status: 'completed' };
    remaining.splice(0, remaining.length, ...targets.filter(t => outcomes.some(o => o.meeting_id === t.meeting_id && o.success !== true)));
    return incomplete();
  }
}

/**
 * Thrown when the replayed tool returned a structured `{ error }` / `{ success:
 * false }` / `{ ok: false }` sentinel — carries the FULL result (never just the
 * flattened message string) so a caller with an actual recovery path for a
 * SPECIFIC sentinel (e.g. resolver.ts's `possible_reschedule` handling) can read
 * the fields it needs (existing_meeting_id, etc.) instead of losing them the
 * instant this module turns the sentinel into a bare Error.
 */
export class ReplayToolError extends Error {
  constructor(message: string, public readonly sentinel: Record<string, unknown>) {
    super(message);
    this.name = 'ReplayToolError';
  }
}

export interface RunDeferredActionInput {
  /** Internal recursion marker; never persisted or accepted from tool args. */
  coordinatedReconciled?: boolean;
  ownerUserId: string;
  profile: UserProfile;
  tool: string;
  args: Record<string, unknown>;
  /** The originating approval request id — used for audit + log tagging. */
  requestId: string;
  /**
   * The request's ORIGIN thread (requests.origin_channel / origin_thread_ts) —
   * where the ask was raised and where the requester relay posts the outcome.
   * Callers must pass the request row's own fields. NEVER read this off
   * `args` — create_meeting / move_meeting / update_meeting / delete_meeting /
   * book_floating_block carry no channel_id/thread_ts in their input_schema
   * (verified 2026-08-03), so a `args.channel_id`/`args.thread_ts` fallback is
   * not "best-effort", it is unconditionally empty. Used only for shadow
   * notifications during replay (S4) — never for the booking's own
   * parameters, which come from `args` alone (R2).
   */
  originChannel: string | null;
  originThreadTs: string | null;
  /**
   * v4.4.x (#154-replay-surface) — the request row's own origin surface,
   * from `deriveOriginSurface(row)` (core/requests/types.ts) — NEVER guessed,
   * NEVER defaulted to 'owner_dm'. The replay always executes with
   * `authority: 'owner'` (the approved action runs with owner privilege
   * regardless of who raised the original ask — grantRelaxed's
   * `senderRole === 'owner'` fast path is untouched by this), but a room- or
   * colleague-DM-originated ask still narrates back into that same surface
   * (S4): she always speaks, the restriction is at the tool layer, never
   * silence (owner ruling). Also feeds `isMpim` on the synthetic SkillContext
   * below, so `subjectViewerFor`/`viewerEmailFor` (utils/displaySubject.ts —
   * which key off `isMpim`, not this field directly) stop reading EVERY
   * replay as a fully private owner DM regardless of where the ask actually
   * came from. That isMpim-always-false mismatch was the #137b-shaped bypass
   * for this leg: a room-originated approval could replay a rule-bend and
   * have the tool handlers render its real subject as if to the owner alone.
   */
  surface: 'owner_dm' | 'colleague_dm' | 'room';
  ownerDmChannel?: string | null;
  ownerDmThreadTs?: string | null;
  app?: SkillContext['app'];
}

/**
 * Replay the deferred action. THROWS on failure (the tool threw, OR returned an
 * `{ error }` / `{ success: false }` / `{ ok: false }` sentinel) so the resolver
 * keeps the request in `awaiting_owner` for retry — see the file header. Do NOT
 * wrap the throw in a swallow: that resurrects the phantom-confirmed-booking bug
 * (owner approves → replay fails silently → requester told "invite incoming" →
 * nothing booked).
 *
 * Returns the tool result on success (GH #140 / 138c) so the resolver can
 * surface the concrete outcome — `booked_start`, `action_summary`, etc. —
 * instead of a bare "replayed create_meeting". Without it the resolver returned
 * no booking signal, so Sonnet hedged ("confirming that's what you mean?") AND
 * announced completion ("booking went through") in the same breath. An unavailable
 * executor or an unconfirmed result throws too; neither proves an action ran.
 */
export async function runDeferredAction(input: RunDeferredActionInput): Promise<Record<string, unknown>> {
  if (input.tool === 'move_meeting' && Array.isArray(input.args.coordinated_moves) && !input.coordinatedReconciled) {
    return runCoordinatedReplay(input);
  }
  const { ownerUserId, profile, tool: rawTool, args, requestId, originChannel, originThreadTs, surface } = input;

  // Every caller (resolver.ts) only reaches this function after checking
  // RESOLVER_REPLAY_TOOLS.has(tool) — but that Set is untyped `Set<string>`
  // (approvalCallbacks.ts), so nothing upstream actually PROVES `tool` is one
  // of the six replayable tools at the type level. Re-check the same
  // canonical list here (isReplayableTool, core/requests/types.ts) so the
  // rest of this function can narrow to `ReplayableTool` and the switch below
  // can be exhaustive. A stray/legacy tool string is a failure, never proof
  // that the stored action ran.
  const tool = rawTool;
  const decidedArgs = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;

  // pre-existing-clobbered-tz-now-locked-wrong-forever (2026-09-02) — NOT a
  // meeting-skill tool call: a direct write through the ONE door out of the
  // always-temp divert (db/people.ts's promoteTimezoneTempById), fired only
  // on the owner's explicit yes to raiseTimezonePersistenceAsks
  // (core/requests/runner.ts). No Slack connection or SkillContext needed, so
  // this is handled before any of that machinery below. THROWS (never
  // swallows) on a refusal — same contract as the meeting-tool path: the
  // resolver keeps the request awaiting_owner rather than telling the owner
  // "done" for a write that didn't happen.
  if (tool === PROMOTE_TIMEZONE_TEMP_TOOL) {
    const personId = typeof args.person_id === 'string' ? args.person_id : '';
    const expectedValue = typeof args.expected_value === 'string' ? args.expected_value : '';
    if (!personId || !expectedValue) {
      throw new ReplayToolError('promote_timezone_temp: missing person_id/expected_value', { error: 'bad_args' });
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { promoteTimezoneTempById } = require('../../db/people') as typeof import('../../db/people');
    const outcome = promoteTimezoneTempById(personId, expectedValue);
    // 'applied' / 'already_set' are the only non-refusals. 'stale_streak' (the
    // streak moved on between ask and answer), 'refused_lower_authority',
    // 'no_value', 'no_person' are all refusals to surface, not swallow.
    if (outcome !== 'applied' && outcome !== 'already_set') {
      throw new ReplayToolError(`promote_timezone_temp refused: ${outcome}`, { error: outcome });
    }
    logger.info('runDeferredAction — promote_timezone_temp replay completed', {
      requestId, personId, expectedValue, outcome,
    });
    return { promoted: true, outcome };
  }

  // Resolve the Slack connection so meeting handlers can shadow-DM the owner.
  const slackConn = getConnection(ownerUserId, 'slack');
  if (!slackConn) {
    throw new ReplayToolError('Replay unavailable: no Slack connection registered', { error: 'replay_connection_unavailable' });
  }

  // Build a minimal SkillContext that the tool handlers will accept. The
  // owner-path identity is what we need (planMeeting checks initiator='owner'
  // for the override path). channelId/threadTs are the request's OWN origin
  // thread (S4, 2026-08-03 ruling) — an approved action replays into the same
  // thread the ask was raised in, not a blind void. The meeting handlers use
  // them for shadow notifications + closeMeetingArtifacts' thread-fallback
  // match; SkillContext.threadTs is a required string, so an owner-internal
  // row with no origin thread still defaults to ''.
  const retainOrigin = (ORIGIN_SURFACE_REPLAY_TOOLS as readonly string[]).includes(tool);
  if (!retainOrigin && (!input.ownerDmChannel?.startsWith('D') || !input.ownerDmThreadTs)) {
    throw new ReplayToolError('Owner decision has no private execution anchor', { error: 'replay_owner_surface_unavailable' });
  }
  const executionSurface = retainOrigin ? surface : 'owner_dm';
  const channelId = (retainOrigin ? originChannel : input.ownerDmChannel) ?? '';
  const threadTs = (retainOrigin ? originThreadTs : input.ownerDmThreadTs) ?? '';
  const context: SkillContext = {
    userId: ownerUserId,
    senderRole: 'owner' as const,
    // v4.4.x (#154-replay-surface) — the ACTION always runs as the
    // authenticated owner (unchanged); `surface` is the SEPARATE, row-derived
    // question of where this narrates back to, and is never inferred from
    // authority.
    authority: 'owner' as const,
    surface: executionSurface,
    channelId,
    threadTs,
    channel: 'slack' as const,
    profile,
    // isMpim mirrors `surface` (both cover the 'room' case — MPIM or a real
    // channel, per the owner's "channel = MPIM" ruling) so
    // subjectViewerFor/viewerEmailFor keep clamping a room-originated replay
    // exactly as they would a live room turn, instead of the hardcoded
    // `false` that made every replay read as a private owner DM.
    isMpim: executionSurface === 'room',
    app: input.app,
    isOwnerInGroup: false,
  };

  try {
    const { executeApprovedSkillTool } = await import('../../skills/registry');
    const dispatched = await executeApprovedSkillTool(tool, args, context);
    const result = dispatched.result;
    if (dispatched.status === 'failed' && result.error === 'approved_action_unconfirmed'
        && (ORIGIN_SURFACE_REPLAY_TOOLS as readonly string[]).includes(tool)) {
      const { verifyApprovedCalendarAction } = await import('../../connectors/graph/calendarReads');
      const candidateId = typeof result.meetingId === 'string' ? result.meetingId
        : typeof result.event_id === 'string' ? result.event_id : undefined;
      const verification = await verifyApprovedCalendarAction({ userEmail: profile.user.email, profile, tool, args: decidedArgs, eventId: candidateId });
      if (verification.status === 'desired_state_observed') return { ...verification.result, _replay_status: 'completed' };
      throw new ReplayToolError("The read-only check could not establish the requested result; the action was not repeated.",
        { ...result, error: 'approved_action_unconfirmed' });
    }

    // Inspect the result for failure-sentinel shapes. Many meeting tools
    // return { error: string } / { success: false } / { ok: false } on
    // rule violations or transient failures rather than throwing. Pre-fix,
    // such failures were treated as success — the resolver closed the
    // request resolved and DM'd the requester "Calendar invite incoming"
    // for a meeting that never landed.
    const r = result as Record<string, unknown> | null | undefined;
    if (r && typeof r === 'object') {
      if (typeof r.error === 'string' && r.error.length > 0) {
        throw new ReplayToolError(`tool returned error: ${r.error}`, r);
      }
      if (r.success === false) {
        const reason = typeof r.reason === 'string' ? r.reason : 'unknown';
        throw new ReplayToolError(`tool returned success:false (${reason})`, r);
      }
      if (r.ok === false) {
        const reason = typeof r.reason === 'string' ? r.reason : 'unknown';
        throw new ReplayToolError(`tool returned ok:false (${reason})`, r);
      }
    }
    // All replayable skill handlers confirm with success:true or ok:true.
    // Empty/malformed results cannot authorize closure or a success relay.
    if (dispatched.status === 'failed') {
      throw new ReplayToolError('Replay result did not confirm success; check the action before retrying', { error: 'replay_unconfirmed' });
    }

    logger.info('runDeferredAction — replay completed', {
      requestId, tool,
      resultPreview: typeof result === 'object' && result !== null
        ? JSON.stringify(result).slice(0, 240)
        : String(result).slice(0, 240),
    });
    return { ...r, _replay_status: dispatched.status };
  } catch (err) {
    // Surface to caller — the resolver's outer try/catch keeps the request
    // in awaiting_owner so the owner can retry. Log here for visibility.
    logger.error('runDeferredAction — replay failed', {
      requestId, tool, err: String(err).slice(0, 300),
    });
    throw err;
  }
}
