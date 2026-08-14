/**
 * Approval callbacks (v2.9.1) — the universal 3-verdict dispatch table.
 *
 * Replaces the ad-hoc `deferred_action` pattern with a structured object that
 * lives in `request.details_json.callbacks`. The resolver reads this and
 * dispatches; the same object covers every approval kind (rule_exception,
 * cancel_confirm, freeform, future non-meeting confirms).
 *
 *   on_approve  — tool that fires on yes. When omitted, Module D's Y.2 gate
 *                 skips auto-resolve so Sonnet handles the work via reasoning.
 *   on_reject   — tool that fires on no. When omitted, just close + DM the
 *                 requester (today's default).
 *   on_amend    — how owner's counter merges in. Default mode is
 *                 `relay_to_requester`: state flips to `awaiting_colleague`,
 *                 Maelle relays counter to requester for their yes/no.
 *                 Alternative `run_with_amend`: counter merges into
 *                 on_approve.args and fires immediately.
 *
 * Legacy bridge: callers still on `deferred_action` shape are transparently
 * mapped to `on_approve` via `extractCallbacks()`. We accept both for one
 * version window; new code writes `callbacks` directly.
 *
 * `composeOwnerAskText` (below) is the other half: the ONE assembly of the
 * owner-facing ask these callbacks are verbalized into. It lives here because
 * the consequence line it orders is this file's own `buildConsequenceText`.
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../../config/userProfile';
import type { OwnerTravelContext } from '../../utils/workingElsewhere';
import { renderWeDualClock } from '../../utils/weTimeResolver';
import logger from '../../utils/logger';

export interface ToolCallback {
  tool: string;
  args: Record<string, unknown>;
}

export type AmendDispatch =
  | { mode: 'relay_to_requester' }
  | { mode: 'run_with_amend' };

export interface ApprovalCallbacks {
  on_approve?: ToolCallback;
  on_reject?: ToolCallback;
  on_amend?: AmendDispatch;
}

/**
 * Read structured callbacks from a request's details_json. Bridges the legacy
 * `deferred_action` field — if `callbacks.on_approve` is unset but
 * `deferred_action` exists, treat that as on_approve. Idempotent + safe on
 * malformed input.
 */
export function extractCallbacks(details: Record<string, unknown> | null | undefined): ApprovalCallbacks {
  if (!details) return {};
  const callbacks = (details.callbacks as ApprovalCallbacks | undefined) ?? {};

  // Legacy alias: deferred_action == on_approve when on_approve isn't set.
  // EXPLICIT PRECEDENCE (extractCallbacks-precedence-silent-trap, 2026-08-14):
  // `callbacks.on_approve` always wins over `deferred_action` when BOTH are
  // present on the same row. Harmless today — nothing writes `details.callbacks`
  // on a row that also carries `deferred_action` (only `deferred_action` itself,
  // e.g. skill.ts's refreshIfOpen) — but it is a silent trap for the day
  // something does: refreshing `deferred_action` alone (as refreshIfOpen does)
  // would stop having any effect here, and the whole "replay the correction"
  // fix would go silently inert. Guarded, not just documented: a row that ever
  // DOES carry both is logged loudly so the collision is never invisible. Don't
  // add a `callbacks` writer on a `deferred_action`-carrying row shape without
  // also teaching refreshIfOpen (or this function) to keep them in sync.
  if (callbacks.on_approve && details.deferred_action) {
    logger.warn('extractCallbacks — row carries BOTH callbacks.on_approve and deferred_action; on_approve wins by precedence, deferred_action is ignored', {
      onApproveTool: callbacks.on_approve.tool,
      deferredActionTool: (details.deferred_action as { tool?: unknown } | undefined)?.tool,
    });
  }
  if (!callbacks.on_approve) {
    const legacy = details.deferred_action as ToolCallback | undefined;
    if (legacy && typeof legacy.tool === 'string' && legacy.args && typeof legacy.args === 'object') {
      return { ...callbacks, on_approve: { tool: legacy.tool, args: legacy.args } };
    }
  }

  return callbacks;
}

/**
 * Verbalize on_approve for the owner-facing approval DM. The owner reads
 * "Approve X? — If yes, I'll [verbalized consequence]" and knows what saying
 * yes actually does. When on_approve is absent, returns null (Sonnet will
 * handle the work after Module D passes-to-Sonnet).
 *
 * Heuristic per tool — kept inline because the verbalization is tightly
 * coupled to each tool's args shape; extracting to a registry would be more
 * indirection than value at this scope.
 */
export function buildConsequenceText(
  callbacks: ApprovalCallbacks,
  profile: UserProfile,
  // v3.5.x (WE preview) — pre-resolved owner travel context for the meeting day,
  // supplied by the async caller (resolveConsequenceTravel). When present, the
  // ISO-start tools render via the WE dual-clock (trip + home on a trip day,
  // single home clock otherwise) so this preview matches the post-approve
  // booked-confirmation, which the meeting chat migrated to the same renderer.
  // Absent (no start / resolve failed / non-time tool) → home-zone fmtTime,
  // byte-identical to before. Verbalizer stays SYNC — no Graph here.
  travel?: OwnerTravelContext,
): string | null {
  if (!callbacks.on_approve) return null;
  const { tool, args } = callbacks.on_approve;
  const fmtTime = (iso: string | undefined): string => {
    if (!iso) return '';
    try {
      const dt = new Date(iso);
      if (Number.isNaN(dt.getTime())) return iso;
      const opts: Intl.DateTimeFormatOptions = {
        weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: profile.user.timezone,
      };
      // Best-effort render in the owner's zone.
      return new Intl.DateTimeFormat('en-GB', opts).format(dt);
    } catch { return iso; }
  };
  // WE-aware time render for the ISO-start tools: dual trip/home clock when
  // travel is resolved, else the home-zone fallback.
  const fmtStart = (iso: string | undefined, endIso?: string): string => {
    if (!iso) return '';
    return travel ? renderWeDualClock(iso, travel, profile.user.timezone, { endIso }) : fmtTime(iso);
  };
  switch (tool) {
    case 'create_meeting': {
      const subj = (args.subject as string) ?? 'this meeting';
      const start = fmtStart(args.start as string | undefined, args.end as string | undefined);
      return start ? `If yes → I'll book "${subj}" at ${start}.` : `If yes → I'll book "${subj}".`;
    }
    case 'move_meeting': {
      const subj = (args.meeting_subject as string) ?? 'the meeting';
      const newStart = fmtStart(args.new_start as string | undefined, args.new_end as string | undefined);
      return newStart ? `If yes → I'll move "${subj}" to ${newStart}.` : `If yes → I'll move "${subj}".`;
    }
    case 'delete_meeting': {
      const subj = (args.meeting_subject as string) ?? 'the meeting';
      return `If yes → I'll cancel "${subj}".`;
    }
    case 'book_floating_block': {
      const blockName = (args.is_floating_block as { name?: string } | undefined)?.name ?? 'this block';
      const start = (args.start_time as string | undefined) ?? '';
      return start ? `If yes → I'll book ${blockName} at ${start}.` : `If yes → I'll book ${blockName}.`;
    }
    case 'update_meeting': {
      const subj = (args.meeting_subject as string) ?? 'the meeting';
      return `If yes → I'll update "${subj}".`;
    }
    default:
      return `If yes → I'll run ${tool}.`;
  }
}

/**
 * v3.5.x (WE preview) — resolve the owner's travel context for the on_approve's
 * meeting day, so buildConsequenceText can render the WE dual-clock and the
 * approval preview matches the booked-confirmation. getTravelContextForInstant
 * resolves the per-date schedule override synchronously (#143 — no Graph fetch);
 * this wrapper is kept async for the approval call sites, then its result is
 * passed into the sync verbalizer. Only the time-bearing tools carry a start;
 * everything else (and a missing/invalid start, or any failure) returns
 * undefined → the verbalizer falls back to the home clock.
 */
export async function resolveConsequenceTravel(
  callbacks: ApprovalCallbacks,
  profile: UserProfile,
): Promise<OwnerTravelContext | undefined> {
  const args = callbacks.on_approve?.args;
  const start = (args?.start ?? args?.new_start) as string | undefined;
  if (typeof start !== 'string' || !start) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getTravelContextForInstant } = require('../../utils/workingElsewhere') as
      typeof import('../../utils/workingElsewhere');
    return getTravelContextForInstant(start, profile);
  } catch {
    return undefined;  // fail-open → home-zone render, never block the approval DM
  }
}

/**
 * The SLOT an action would occupy, as a comparable signature — or `null` when no
 * start can be read off it, which means nothing about the slot can be proven.
 *
 * Only used to answer one question: did a counter MOVE the slot? Compares
 * structured ISO fields, never prose.
 */
function slotSignature(cb: ToolCallback | undefined): string | null {
  const a = cb?.args as Record<string, unknown> | undefined;
  if (!a) return null;
  const start = [a.start, a.new_start, a.start_time].find(v => typeof v === 'string' && v.trim());
  if (typeof start !== 'string') return null;
  const end = [a.end, a.new_end].find(v => typeof v === 'string' && v.trim());
  return `${start}|${typeof end === 'string' ? end : ''}`;
}

/**
 * THE owner-facing approval ask — assembled in ONE place, for every surface
 * that puts this ask in front of him to decide.
 *
 * THREE surfaces call this, and all three are LIVE DECISION SURFACES — each one
 * re-stamps `terminal_dm_msg_ts`, so a ✅ on any of them resolves the approval
 * and replays the stored action:
 *   1. the first raise (`create_approval`),
 *   2. the re-ask revival, when the requester chases a cold ask,
 *   3. the colleague bounce-back (`notifyOwnerOfColleaguePushback`) — a counter
 *      or a refusal handing the decision back to him.
 * Each of the three had to be taught the hard reason SEPARATELY, and each in turn
 * shipped without it: surface 1 assembled its text twice and the rebuild dropped
 * the reason, surface 2 posted the bare `description`, surface 3 posted a
 * hand-rolled line plus a locally-rebuilt consequence. That is why there is now
 * exactly one assembly site and no surface composes its own body: a new decision
 * surface gets the reason by construction, or it isn't a decision surface.
 *
 * Parts, in reading order:
 *   0. `lead` — the surface's own opening line, when it has one ("X asked again",
 *      "X countered — approve, reject, or counter again?"). Optional; a first
 *      raise has none.
 *   1. `details.honest_hard_reason` (#142c) — checkSlot's owner-viewer label for
 *      a HARD double-book, written ONLY by the code path that PROVED it (never
 *      by the model). It LEADS the ask, above whatever soft framing the prose chose.
 *   2. `askText` — the ask itself.
 *   3. the consequence (v2.9.1) — "If yes → I'll X", verbalized from the stored
 *      on_approve with any stored counter merged in exactly as the resolver
 *      merges it, so it always describes the action a ✅ actually replays. Last,
 *      because it says what he is authorizing, not why it needs him.
 * A missing part just drops out; it can never take another part with it.
 *
 * Both time-dependent parts are REPLAYED from the row, never re-derived: the ✅
 * replays the STORED action, so the ask must be described by the reason derived
 * against THAT stored slot — re-checking the calendar here could only produce a
 * reason for a different slot, or flip the lead line off mid-thread on a
 * transient read. `reSurface` marks any re-post of an ask already raised: replay
 * can go stale (the collision may have cleared since), so it is not asserted in
 * the present tense — it says when the check was made and lets him read it as of
 * then. Honest either way, and no Graph call on a tool path.
 *
 * WHEN A COUNTER SUPPRESSES THE REASON — and when it must not. The reason was
 * proven against one slot; a counter that MOVES the slot makes it describe an
 * action a ✅ no longer fires, so it is withheld. But the test is the slot, not
 * the mere existence of a counter: a counter that only renames the meeting (or
 * carries prose that merges into no time field) leaves the collision exactly as
 * proven, and withholding it there is how a colleague's subject-only counter
 * silenced a real double-book at the moment he ticked ✅.
 */
export async function composeOwnerAskText(input: {
  askText: string;
  /** The request row's parsed `details_json` — the one source for parts 1 and 3. */
  details: Record<string, unknown> | null | undefined;
  profile: UserProfile;
  /** For the log line when the consequence build throws. */
  requestId: string;
  /** The surface's own opening line. Absent on a first raise. */
  lead?: string;
  /** Present on any surface RE-posting an ask already raised (revival, bounce-back). */
  reSurface?: { raisedAt: string | null };
}): Promise<string> {
  const { askText, details, profile, requestId, lead, reSurface } = input;

  // A stored counter is what a ✅ ACTUALLY replays: resolveRequest merges
  // `details.counter` into on_approve before running it (resolver.ts:415-425),
  // for any amend round, owner's or colleague's. So the preview verbalizes the
  // MERGED action — otherwise a countered row bounced back to awaiting_owner
  // would promise the ORIGINAL slot and book the counter's: the "I thought yes
  // meant 14:00, got 16:00" failure.
  const rawCounter = details?.counter;
  const counter = rawCounter && typeof rawCounter === 'object' && !Array.isArray(rawCounter)
    ? rawCounter as Record<string, unknown>
    : null;
  const countered = !!counter && Object.keys(counter).length > 0;

  let consequence: string | null = null;
  // Does the action a ✅ now fires still occupy the slot the hard reason was
  // proven against? No counter → nothing moved it. Initialised so that a throw
  // below can only ever withhold a reason that a counter had already put in
  // doubt — an uncountered ask keeps its reason regardless.
  let slotHeld = !countered;
  try {
    const callbacks = extractCallbacks(details);
    const mergedApprove = (countered && counter && callbacks.on_approve)
      ? mergeAmendIntoApprove(callbacks.on_approve, counter)
      : callbacks.on_approve;
    if (countered) {
      const before = slotSignature(callbacks.on_approve);
      slotHeld = before !== null && before === slotSignature(mergedApprove);
    }
    const effective = mergedApprove ? { ...callbacks, on_approve: mergedApprove } : callbacks;
    // v3.5.x (WE preview) — resolve trip context so the preview clock matches
    // the booked-confirmation on a trip day.
    const travel = await resolveConsequenceTravel(effective, profile);
    consequence = buildConsequenceText(effective, profile, travel);
  } catch (err) {
    logger.warn('composeOwnerAskText — consequence build threw; sending the ask without the "if yes" line', {
      requestId, err: String(err).slice(0, 200),
    });
  }

  const stored = slotHeld ? details?.honest_hard_reason : undefined;
  const honest = typeof stored === 'string' ? stored.trim() : '';
  let hardReason = honest;
  if (honest && reSurface) {
    // created_at is SQLite-UTC ('YYYY-MM-DD HH:MM:SS'); anything else renders
    // invalid and simply drops the parenthetical rather than the reason.
    const raised = reSurface.raisedAt
      ? DateTime.fromSQL(reSurface.raisedAt, { zone: 'utc' }).setZone(profile.user.timezone)
      : null;
    const when = raised?.isValid ? ` (${raised.toFormat('EEE d MMM, HH:mm')})` : '';
    hardReason = `Checked when I raised this${when}: ${honest}`;
  }

  return [lead, hardReason, askText, consequence].filter(Boolean).join('\n\n');
}

/**
 * Merge owner's amend counter into on_approve.args. The counter shape is
 * approval-kind-specific (freeform: arbitrary keys, etc.). We do a shallow
 * spread: counter wins on key conflict. Caller is
 * responsible for ensuring the counter keys correspond to on_approve.args
 * keys — that's a tool-description responsibility, not a code invariant.
 */
export function mergeAmendIntoApprove(
  approveCallback: ToolCallback,
  counter: Record<string, unknown>,
): ToolCallback {
  // Common slot-pick alias: counter.slot_iso → args.start. Specific to
  // create_meeting / move_meeting whose start field carries the slot.
  const args = { ...approveCallback.args };
  if (typeof counter.slot_iso === 'string') {
    if (approveCallback.tool === 'create_meeting' || approveCallback.tool === 'book_floating_block') {
      args.start = counter.slot_iso;
    } else if (approveCallback.tool === 'move_meeting') {
      args.new_start = counter.slot_iso;
    }
  }
  // Fall-through: spread the rest, allowing kind-specific keys to land.
  for (const [k, v] of Object.entries(counter)) {
    if (k === 'slot_iso') continue;  // already handled above
    args[k] = v;
  }
  return { tool: approveCallback.tool, args };
}

/**
 * Tools the resolver knows how to replay autonomously. The deferred-action
 * replay path (`runDeferredAction`) loads SchedulingSkill / CalendarHealthSkill
 * for these; anything else falls back to "close + Sonnet next turn" behavior.
 * Keep this set in sync with deferredActionReplay.ts.
 */
export const RESOLVER_REPLAY_TOOLS = new Set<string>([
  'create_meeting',
  'move_meeting',
  'delete_meeting',
  'update_meeting',
  'book_floating_block',
]);
