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
  getLatestFreeformOwnerFlag,
  getRecentOutreachOwnerThread,
  isKnownRequestThreadAnchor,
  getMeetingsRequestedBy,
  getRecentActivityForOwner,
} from '../db/requests';
import { closeRequest } from '../core/requests/closeRequest';
import { resolveRequest, renderCounter, textCarriesInternalWorkItemId, type ResolveVerdict } from '../core/requests/resolver';
import { logActivity } from '../core/requests/logActivity';
import { composeOwnerAskText } from '../core/approvals/approvalCallbacks';
import { judgeRequestDedup } from '../utils/requestDedup';
import { messageReferencesRequest } from '../utils/closeLoopOnOwnerHandled';
import {
  getUnseenEvents,
  markEventsSeen,
  getPendingRequestCountForColleague,
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

// gh#pending-cap-blocks-unrelated-questions (2026-08-10) — the "max 2 pending"
// rate limit used to gate at MESSAGE-RECEIPT time (processMessage.ts step 3,
// SlackMaster's file): a capped colleague's whole next message was refused,
// including one needing zero request-spine involvement (e.g. "is Idan free at
// 16:00", pure find_available_slots territory). Moved here, to CREATION time,
// at the two chokepoints a colleague can DELIBERATELY mint a new tracked row
// via their own ask (create_task / create_approval, both in
// COLLEAGUE_ALLOWED_TOOLS) — an ordinary question never reaches either tool,
// so it's never blocked; only the specific act of opening a THIRD open item
// is. Gated on `authority`, not `senderRole` — same reasoning as
// flagUnresolvedFreeformForOwner below: `senderRole` reads 'colleague' for
// the owner clamped into a room too, and the owner is never capped.
// `getPendingRequestCountForColleague` itself (db/jobs.ts) was already
// correct — this only relocates where its result is enforced.
//
// A THIRD path mints a request row on a colleague's behalf:
// `flagUnresolvedFreeformForOwner` below opens its own durable-backstop
// `reminder` row when a freeform approval can't be confidently routed. It is
// deliberately NEVER gated through `colleaguePendingCapRefusal` — it exists
// to guarantee an ambiguous ask reaches the owner even when nothing else
// caught it (R3), so refusing it would recreate exactly the silent-drop bug
// it was built to close. It is equally deliberately EXCLUDED from
// `getPendingRequestCountForColleague`'s own count (via
// `subkind: 'freeform_owner_ask'`) — bouncer fix, 2026-08-10 — so it can
// never itself eat one of the colleague's two real slots (found: it minted
// uncapped but still counted against the cap, the worst of both).
const COLLEAGUE_PENDING_CAP = 2;
async function colleaguePendingCapRefusal(
  context: SkillContext, ownerUserId: string,
): Promise<{ error: string; reason: string } | null> {
  // gh#handyman-authority-clamp-sweep (third consumer, 2026-08-19) — `authority`
  // alone still isn't enough: processMessage.ts's debounce merge clamps
  // `effectiveAuthority` to 'colleague' for the WHOLE turn whenever the merged
  // batch spans multiple senders, even when the owner spoke last and
  // `context.userId` is still his own Slack id (same case buildTurnContext.ts:739
  // and orchestrator/index.ts:1106 already guard). Without the identity check,
  // the owner's own create_approval/create_task got refused under his
  // colleagues' pending-request cap, which is documented above as never
  // applying to him. Compare the authenticated identity directly.
  if (context.authority !== 'colleague' || context.userId === ownerUserId) return null;
  const pending = getPendingRequestCountForColleague(ownerUserId, context.userId);
  if (pending < COLLEAGUE_PENDING_CAP) return null;

  // gh#pending-cap-blocks-unrelated-questions (2026-08-10, SlackMaster hand-off) —
  // the message-receipt gate this replaced (processMessage.ts) had a
  // channel/DM privacy split: in a real channel it DM'd the colleague
  // privately ("you have pending requests with {owner}") instead of posting
  // that disclosure where bystanders could read it; in DM/MPIM it replied
  // in-thread. This tool-result refusal has no surface awareness by default
  // — it's a plain {error, reason} the model narrates itself — so it can now
  // say the same thing out loud in a room. `surface === 'room'` covers BOTH
  // channel and MPIM (the deliberate unification in orchestrator/index.ts:
  // a channel is just an MPIM with unbounded, unknowable membership), so
  // both get the room treatment here. Per W9: don't hand the model text it
  // must not repeat and trust it to be discreet — the disclosure never
  // enters the payload for a room turn at all. The real explanation goes out
  // via a private DM to the same colleague instead (mirrors the old code's
  // channel branch).
  if (context.surface === 'room') {
    // failed-private-dm-still-narrates-as-sent (2026-08-12) — the "I've already
    // messaged them privately" clause must be TRUE, not asserted unconditionally.
    // The 2026-08-10 fix made `capNoticeSentThisTurn` mark ONLY on a confirmed
    // send, but this text still claimed the DM landed regardless — so a refused
    // colleague in a room heard a room-visible lie about a private message that
    // never arrived. Build the reason from the actual outcome instead.
    const sentReason = `Don't open a new tracked request/approval right now. If this message is a plain question you can answer directly, just answer it. Otherwise keep your reply here brief and generic (e.g. "I'll follow up with you on this soon") — I've already messaged them privately with the actual reason, so don't restate it in this shared space.`;
    const notSentReason = `Don't open a new tracked request/approval right now. If this message is a plain question you can answer directly, just answer it. Otherwise keep your reply here brief and generic (e.g. "I'll follow up with you on this soon") — I could NOT reach them privately, so do not claim you messaged them and do not restate the pending-request reason in this shared space either.`;
    // bouncer fix (pending-cap-blocks-unrelated-questions, 2026-08-10) — a
    // retried/second tool call this turn (create_approval then create_task,
    // or a retry after the refusal — the refusal text itself invites one)
    // hits this same branch again. Send the private DM at most once per
    // colleague per turn; the refusal is still returned every time regardless,
    // so the model sees it on every attempt. A prior confirmed send this turn
    // means `sentReason` is genuinely true here.
    if (context.capNoticeSentThisTurn?.has(context.userId)) {
      return { error: 'colleague_pending_cap', reason: sentReason };
    }
    let sent = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getConnection } = require('../connections/registry') as typeof import('../connections/registry');
      const conn = getConnection(ownerUserId, context.inboundConnectionId ?? 'slack');
      if (conn) {
        // bouncer fix (2026-08-10) — only a CONFIRMED send marks the
        // colleague notified, matching orchestrator/index.ts:865-869's
        // `?.ok === true` gate. sendDirect never throws (transports catch
        // internally and resolve `{ok:false,...}` on failure), so marking
        // after any non-throwing call used to mark a cap notice as sent
        // even when the DM never delivered (bad token, cannot_dm_bot, rate
        // limit) — the colleague was then refused with no notice actually
        // sent, and a same-turn retry was suppressed regardless.
        const sendResult = await conn.sendDirect(
          context.userId,
          `Hi — you already have a couple of pending requests with ${context.profile.user.name}. I'll follow up with you once those are resolved.`,
        );
        if (sendResult?.ok === true) {
          sent = true;
          context.capNoticeSentThisTurn?.add(context.userId);
        } else {
          logger.warn('colleaguePendingCapRefusal — private cap notice send failed', {
            ownerUserId, userId: context.userId, sendResult,
          });
        }
      } else {
        logger.warn('colleaguePendingCapRefusal — no connection for private cap notice', {
          ownerUserId, userId: context.userId,
        });
      }
    } catch (err) {
      logger.warn('colleaguePendingCapRefusal — private cap notice failed', { err: String(err) });
    }
    return { error: 'colleague_pending_cap', reason: sent ? sentReason : notSentReason };
  }

  return {
    error: 'colleague_pending_cap',
    reason: `This person already has ${pending} pending items with the owner — don't open a new tracked request/approval for them right now. If this is a plain question you can answer directly, just answer it (that needs no new row). Otherwise, tell them you'll follow up once those existing items are resolved.`,
  };
}

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
 * gh#freeform-escalation-refused-silently-drops-owner-question (2026-08-09,
 * Noy/Eli identity mixup) — a refused 'unsure' freeform returns bare inline
 * text and TRUSTS the model to ask someone this same turn. Proven to vanish:
 * the model told the colleague "I've sent Idan the note" without ever calling
 * a tool that reached him — the claim-checker caught the false claim, but
 * nothing re-fires the actual ask, and the owner never heard the question. A
 * colleague-raised ask that needs the OWNER'S read can't depend on the model
 * self-correcting in the same turn, so the one-shot text gets a durable
 * backstop on the ONE spine (R1/R3): a `reminder` request that DMs the owner
 * the real question.
 *
 * Dedup is decided against `getLatestFreeformOwnerFlag` — the most recent row
 * THIS backstop raised in this exact thread, any state — NOT against a bare
 * idempotency-key lookup (bouncer overturn round 2, chris-kelley-oof-block-c,
 * 2026-08-18): a thread-scoped key only ever matches the FIRST row ever
 * inserted for a thread (a later new ask mints its own fresh key so the
 * UNIQUE constraint doesn't block it), so `getRequestByIdempotencyKey` can
 * never see anything past that first row once a second one exists. A match is
 * treated as a duplicate — skip, no new DM — only when it is either still
 * being delivered (state='in_flight', a live retry in progress a second
 * attempt would only race) or was delivered within
 * FREEFORM_FLAG_DEDUP_WINDOW_MINUTES. Anything older, OR a prior attempt that
 * gave up without ever delivering (state='cancelled', see below), is treated
 * as a fresh ask — never permanently blackholed (round 1 of this same fix
 * collapsed retries onto one row but then blocked every later, genuinely
 * different ambiguous ask in a long-lived thread forever; round 2 of this
 * same fix must not let a permanently-failed delivery masquerade as "already
 * handled" either).
 *
 * Round 3 (bouncer overturn, chris-kelley-oof-block-c, 2026-08-18): round 2's
 * lookup matched on `kind='reminder' AND subkind='freeform_owner_flag'`
 * alone, which is NOT unique to this backstop — runOutputGates.ts's
 * claim-checker relay backstop mints the identical kind/subkind shape (see
 * db/jobs.ts:70-80's own comment: both are excluded from the colleague
 * pending-cap count as two DIFFERENT "must never be dropped" alerts, never
 * because they're one mechanism). That let an unrelated claim-checker row
 * in the same thread get treated as "still delivering"/"recently delivered"
 * and silently swallow a genuinely different real ask. This backstop's own
 * rows now carry `subkind: 'freeform_owner_ask'` instead — a value only
 * `flagUnresolvedFreeformForOwner` ever writes — so `getLatestFreeformOwnerFlag`
 * can no longer cross paths with the claim-checker's rows. `next_check_handler`
 * was considered and rejected as the discriminator: this function's own
 * CONFIRMED-delivery path (the common case) never sets one at all, and
 * `closeRequest` unconditionally nulls it on every terminal transition
 * (closeRequest.ts's `nextCheckHandler: null`), so it can't distinguish a
 * `logged`/`cancelled` row either way. The shared `subkind='freeform_owner_flag'`
 * value stays untouched on the claim-checker's own rows — it is still load-
 * bearing there for the same pending-cap exclusion (jobs.ts:92 now excludes
 * both values).
 *
 * Delivery is IMMEDIATE, via the same `postOwnerDecision` DM path a real
 * approval ask uses (skill.ts createApprovalRequest, ~1194-1259) — never
 * deferred through `workTimeBaseFromNow` (chris-kelley-oof-block-b, live
 * incident 2026-08-17: Chris Kelley's urgent ask landed during the owner's
 * declared vacation and wasn't scheduled to reach him until the vacation
 * ended). Owner ruling, verbatim: "approval flow is always approval, nothing
 * should block people to raise alarm as ask for approval." This backstop
 * stands in for an approval under routing ambiguity, so it gets the same
 * always-immediate delivery — `workTimeBaseFromNow`/`nextOwnerWorkdayStart`
 * stay correct and untouched for the ordinary reminder class they're meant
 * for (R4's "reach a person inside their own work hours" default is about a
 * REMINDER's nag cadence, not about an escalation standing in for an
 * approval).
 *
 * On a CONFIRMED delivery the row is created already `logged` (born-terminal)
 * — the DM IS the action, nothing is left to wait on. On a genuine delivery
 * FAILURE (bouncer overturn round 2: both the thread post and the DM fallback
 * failed), the row is created `in_flight` with a short, bounded, re-fireable
 * retry timer instead (runner.ts's `freeform_flag_retry`) — NEVER
 * workTimeBaseFromNow/nextOwnerWorkdayStart, the exact deferred-past-vacation
 * timer this function exists to avoid. A born-terminal `logged` row on a
 * failed send would have (a) permanently blocked every later retry that
 * dedups against it, (b) shown up in getRecentActivityForOwner (state=
 * 'logged' only) as though it had actually reached him, and (c) had no timer
 * at all to ever try again — the exact hole round 1 of this fix introduced.
 *
 * The delivery-then-persist mechanism itself (post via `postOwnerDecision`,
 * then create the `logged`/`in_flight` row) is `deliverAndRecordOwnerFlag`
 * (src/utils/ownerDailyThread.ts) — extracted 2026-08-19 (o#249) as the one
 * shared implementation of this exact shape, since runOutputGates.ts's
 * claim-checker relay backstop needs it identically. This function still owns
 * the dedup/subkind decisions above; only the send+record mechanics are shared.
 *
 * Owner-initiated calls skip this — if create_approval was raised from the
 * owner's OWN conversation, he's already the one Maelle is talking to; there
 * is no cross-party drop to guard against.
 *
 * Gated on `authority`, not `senderRole` (bouncer overturn,
 * freeform-escalation-refused-silently-drops-owner-question, 2026-08-10):
 * `senderRole` reads 'colleague' both for a real colleague AND for the owner
 * clamped into a room/channel (see processMessage.ts's `role` vs `authority`),
 * so gating on it fired this DM at the owner ON HIMSELF whenever he raised an
 * ambiguous freeform from a room — requesterSlackId his own id, the message
 * claiming "a colleague raised something". `authority` stays 'owner' on every
 * surface (resolve_approval's own gates at 1434/1483/1705 already rely on the
 * same distinction), so it's the correct "is this genuinely the owner" check.
 */
const FREEFORM_FLAG_DEDUP_WINDOW_MINUTES = 60;

async function flagUnresolvedFreeformForOwner(
  context: SkillContext,
  ownerUserId: string,
  flagText: string,
): Promise<void> {
  // gh#handyman-authority-clamp-sweep (third consumer, 2026-08-19) — same
  // merged-batch clamp as colleaguePendingCapRefusal above: a debounce merge
  // spanning multiple senders clamps `authority` to 'colleague' for the whole
  // turn even when the owner spoke last, so `authority` alone can't tell
  // "genuinely a colleague" from "owner, clamped by the merge". Compare the
  // authenticated identity directly (matches buildTurnContext.ts:739).
  // Without this, the owner got DM'd "a colleague raised something" about
  // his own message, with the requester resolved to his own id.
  if (context.authority !== 'colleague' || context.userId === ownerUserId) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPersonMemory } = require('../db/people') as typeof import('../db/people');
    const requesterFirst = (getPersonMemory(context.userId)?.name ?? 'A colleague').split(' ')[0];

    const latest = getLatestFreeformOwnerFlag(ownerUserId, context.userId, context.threadTs);
    if (latest) {
      const createdMs = Date.parse(latest.created_at.replace(' ', 'T') + 'Z');
      const ageMinutes = Number.isFinite(createdMs) ? (Date.now() - createdMs) / 60_000 : Infinity;
      const stillDelivering = latest.state === 'in_flight';
      const deliveredRecently = latest.state === 'logged' && ageMinutes < FREEFORM_FLAG_DEDUP_WINDOW_MINUTES;
      if (stillDelivering || deliveredRecently) return;
      // Else: past the window, or the last attempt is 'cancelled' (gave up
      // without ever delivering) — fall through and raise a fresh one.
    }

    const flagMessage = `${requesterFirst} raised something I couldn't confidently route on my own, and I didn't want it to just sit unanswered: "${flagText}". Flagging it for you directly rather than risk it getting lost.`;

    // Identity for DB uniqueness only, NOT for dedup (that's
    // getLatestFreeformOwnerFlag above) — always fresh, so a fresh row here
    // never collides with an older row's key.
    const idempotencyKey = buildIdempotencyKey({
      ownerUserId,
      requesterSlackId: context.userId,
      kind: 'reminder',
      subject: `freeform_unsure ${context.threadTs} ${Date.now()}`,
    });
    const shared = {
      ownerUserId,
      initiatedBy: context.userId,
      initiatedByRole: 'colleague' as const,
      kind: 'reminder' as const,
      // bouncer fix (pending-cap-blocks-unrelated-questions, 2026-08-10) —
      // marks this row so getPendingRequestCountForColleague (db/jobs.ts)
      // excludes it from the colleague's pending-cap count. This is a
      // durable backstop DM to the OWNER, not a tracked item the colleague
      // asked for — it must mint regardless of their cap (never gated
      // through colleaguePendingCapRefusal, see the header comment above),
      // so it must not silently spend one of their two slots either.
      // 'freeform_owner_ask', NOT the shared 'freeform_owner_flag' value —
      // this subkind is written ONLY here, so getLatestFreeformOwnerFlag's
      // dedup lookup can never match runOutputGates.ts's claim-checker
      // backstop, which mints the same kind under the shared subkind
      // (round 3 fix, chris-kelley-oof-block-c, 2026-08-18 — see the header
      // comment above).
      subkind: 'freeform_owner_ask',
      subject: `Needs your read: ${flagText.slice(0, 80)}`,
      description: flagText,
      informed: 1,
      requesterSlackId: context.userId,
      requesterName: requesterFirst,
      originChannel: context.channelId,
      originThreadTs: context.threadTs,
      originIsMpim: context.surface === 'room',
      idempotencyKey,
    };

    // Delivery + persistence (post now, then record `logged`/`in_flight`) is
    // the shared helper extracted 2026-08-19 (o#249) — see its doc comment in
    // ownerDailyThread.ts. This row's audit trail (recent-activity read,
    // getLatestFreeformOwnerFlag dedup on retry) is what the `logged` state
    // exists for; a failed send lands `in_flight` with a short retry rather
    // than a dead born-terminal row (chris-kelley-oof-block-b round 2).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deliverAndRecordOwnerFlag } = require('../utils/ownerDailyThread') as typeof import('../utils/ownerDailyThread');
    const posted = await deliverAndRecordOwnerFlag({
      profile: context.profile,
      ownerUserId,
      flagMessage,
      label: 'freeform escalation flag',
      messages: {
        dmFailed: 'create_approval — freeform escalation flag DM to owner failed',
        noConnection: 'create_approval — no Slack connection registered for freeform escalation flag',
        threw: 'create_approval — freeform escalation flag DM threw',
      },
      dmFailedExtra: { requesterSlackId: context.userId },
      shared,
    });
    logger.info('create_approval — flagged unresolved freeform escalation to owner', {
      ownerUserId, requesterSlackId: context.userId, preview: flagText.slice(0, 80), posted: posted.ok,
    });
  } catch (err) {
    logger.warn('create_approval — failed to flag unresolved freeform escalation to owner', {
      err: String(err).slice(0, 200),
    });
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
 * THE approval gate (R5) — the one place that decides whether an ask is
 * allowed to reach the owner at all. Runs before dedup, before the row, before
 * the DM. Returns null to let the ask through, or the refusal to hand back.
 *
 * R5 — an approval is a DEVIATION. A `policy_exception` overrides a specific
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
 * R5 — no reason, no approval. Every kind must state WHY it reached him, in the
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

/**
 * createApprovalRequest — the `create_approval` TOOL's full logic, extracted
 * (o#223>dep) and exported so it is directly CODE-callable by a domain
 * handler that has already proven a deviation itself and must not depend on
 * the model choosing to call the tool this turn. Every other escalation in
 * the meeting subsystem returns a `_note`/`suggested_ask_text` and trusts
 * Sonnet to place the follow-up `create_approval` call; that is fine for an
 * ordinary escalation, but the owner ruled (v4.4.x #154) that a room
 * rule-bend must reach his private approval thread deterministically. This
 * function is the primitive that lets a handler do that — e.g. planMeeting's
 * `ownerRoomBend`/`escalate_approval` path (create_meeting / move_meeting)
 * calling it directly instead of returning a note and hoping. Wiring that
 * specific call site is matchmaker's (skills/meetings/*); this file only owns
 * making the raise itself reachable without a model tool-call in the loop.
 *
 * `args` is exactly the `create_approval` tool's own input shape (kind /
 * payload / ask_text / expires_in_workdays / expires_in_hours); `context` is
 * the caller's own SkillContext (a meeting handler already carries one via
 * `OpCtx.context`). Same return shape the tool returns: `{ ok, approval_id,
 * created, expires_at, kind, reused_existing }` on success, `{ error, reason }`
 * (or the more specific gate refusals) on refusal — a direct caller must
 * check `ok`/`error` exactly like the tool-dispatch path does.
 *
 * The `case 'create_approval'` tool dispatch below is now a thin wrapper
 * around this — one lifecycle, reachable from a model tool call OR straight
 * from code, never two.
 */
export async function createApprovalRequest(
  args: Record<string, unknown>,
  context: SkillContext,
): Promise<unknown> {
  const { profile, channelId, threadTs } = context;
  const ownerUserId = profile.user.slack_user_id;

        const subkind = args.kind as ApprovalSubkind;
        // The tool schema declares payload as an object, but a malformed tool
        // call can still send it as a stringified JSON blob — a plain `as`
        // assertion doesn't convert at runtime, so a later `payload.x = y`
        // write throws (TypeError: Cannot create property on string) with no
        // approval ever reaching the owner. Normalize defensively: parse a
        // string payload back into an object, and fall back to {} (logging
        // why) if it isn't valid JSON, so a bad tool call degrades instead of
        // crashing create_approval outright.
        let rawPayload = args.payload;
        if (typeof rawPayload === 'string') {
          const rawPayloadString = rawPayload;
          try {
            rawPayload = JSON.parse(rawPayloadString);
          } catch {
            logger.warn('create_approval — payload arrived as a non-JSON string; falling back to {}', {
              preview: rawPayloadString.slice(0, 200),
            });
            rawPayload = {};
          }
        }
        const payload = (rawPayload && typeof rawPayload === 'object' ? rawPayload as Record<string, unknown> : {});
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
            // gh#freeform-escalation-refused-silently-drops-owner-question —
            // don't let this refusal ride ONLY on the model asking someone in
            // this same turn; back it with a durable fallback DM to the owner.
            await flagUnresolvedFreeformForOwner(context, ownerUserId, [s, q, c].filter(part => part.trim()).join(' — ').slice(0, 500));
            return {
              error: 'freeform_needs_clarification',
              reason: `I can't tell whether this is a calendar change or a genuine non-calendar decision, and it matters: a calendar change (book / move / reschedule / attendee edit / cancel) MUST go through the tool → policy_exception so it actually executes on approve; a real non-calendar yes/no is fine as freeform. Do NOT raise the approval yet, and do NOT claim you've already asked or sent anything — you haven't. If the conversation makes it clear, route it now (tool → policy_exception if it touches a meeting; freeform if not). If it's genuinely unclear, ask the requester plainly — e.g. "just so I route this right, are you asking me to change something on your calendar, or is it something else?" — then act on the answer. I've also flagged the raw ask for the owner directly as a backstop, in case it needs his read and this doesn't get sorted out in conversation.`,
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

        // Capture room origin (MPIM or real channel) so the resolver can post
        // back to the right place. #154 — widened from MPIM-only to any room
        // surface via context.surface, which is required and re-derived per
        // turn (never absent).
        if (typeof payload.origin_channel !== 'string' && channelId) payload.origin_channel = channelId;
        if (typeof payload.origin_thread_ts !== 'string' && threadTs) payload.origin_thread_ts = threadTs;
        if (payload.origin_is_mpim === undefined) payload.origin_is_mpim = context.surface === 'room';

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

        // ── The gate (R5) ────────────────────────────────────────────────
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
        //
        // Bouncer overturn (2026-08-10), Problem B — did the #142c re-derivation
        // below actually COMPLETE this turn? Read by refreshIfOpen's
        // honest_hard_reason handling: set true only in the `!check.passes` /
        // `check.passes` arms (a real verdict was reached), never in the
        // `catch` (a throw proves nothing) and never when skipped entirely
        // (existing-event change, no slot to re-derive). A stored hard reason
        // from an earlier turn must survive a turn that didn't re-check it.
        let hardReasonReDerived = false;
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
              // gh#154-W4>dep (2026-08-06) — `reason`, not `message`: every other
              // gate refusal in this function (gateApprovalAsk's
              // unknown_kind / no_verified_deviation / missing_reason, plus
              // freeform_calendar_change / freeform_needs_clarification
              // above) returns `{ error, reason }`, and both direct-call
              // sites (createMeeting.ts / moveMeeting.ts's ownerRoomBend
              // branches) type the result as `{ error?, reason? }` and log
              // `approval.reason` uniformly. A `message`-only shape here
              // silently read back as `reason: undefined`.
              error: 'missing_required_field',
              missing,
              reason: `policy_exception is a meeting-booking approval — payload must include the same fields create_meeting requires: ${missing.join(', ')}. Ask the requester for what's missing (e.g. "how long do you need?" for duration) before retrying. Same shape as a regular booking — owner will approve the exact booking that fires on yes.`,
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
          // (gh#194-c — one narrow exception below DOES short-circuit: when the
          // "collision" turns out to be the requester's own already-linked
          // meeting, that isn't a deviation to label at all, it's a duplicate
          // create for something update_meeting should touch instead.)
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
              // M10 — this label is OWNER-BOUND by construction: it lands on
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
              hardReasonReDerived = true;
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

                // gh#194-c — the collision may be a meeting THIS SAME requester
                // already had booked. create_meeting's own advisory steer
                // (createMeeting.ts:792-793) already named this exact conflicting
                // event and told the model to call update_meeting instead of
                // raising a duplicate — but that steer lives in a return value
                // from a DIFFERENT, independent tool call, and nothing stops the
                // model from ignoring it and calling create_approval directly
                // (as happened live, thread 1786275507.424279, 2026-08-09).
                // Cross-check the SAME occupancy id (check.overCommitment.id,
                // #165b) against this requester's own linked meetings —
                // getMeetingsRequestedBy, the same reverse-requester lookup
                // buildTurnContext.ts uses for "MEETINGS YOU REQUESTED" — using
                // the request row's OWN subject (not the owner-viewer-scoped
                // check.overCommitment.subject, which nothing colleague-facing
                // may read per the M10 note above) since it is already the
                // requester's own ask. On a match this is not a deviation, it's
                // a missed update_meeting call — refuse here the same way
                // gateApprovalAsk refuses an unproven deviation, before a second
                // policy_exception row is ever minted.
                const overCommitmentId = check.overCommitment?.id;
                const ownMatch = overCommitmentId && requesterSlackId
                  ? getMeetingsRequestedBy(ownerUserId, requesterSlackId, {
                      withEventIdOnly: true, includeApprovals: true,
                    }).find(r => r.outcome_external_event_id === overCommitmentId)
                  : undefined;
                if (ownMatch) {
                  logger.info('create_approval — refused at the gate: collision is requester\'s own meeting', {
                    subject: payload.subject, start: payload.start,
                    overCommitmentId, existingRequestId: ownMatch.id, requesterSlackId,
                  });
                  return {
                    error: 'own_meeting_collision',
                    reason: `That time conflicts with "${ownMatch.subject}" (id: ${overCommitmentId}) — a meeting this same person already had booked through me. Call update_meeting(meeting_id: ${overCommitmentId}, ...) instead of raising a new approval — do not create a duplicate for a meeting that already exists and is theirs.`,
                  };
                }
              }
              if (sonnetRule !== (check.violation_kind ?? null)) {
                logger.info('create_approval — re-derived policy_exception reason differs from Sonnet-supplied', {
                  subject: payload.subject, start: payload.start,
                  sonnetRule, derivedRule: check.violation_kind,
                });
              }
            } else if (check.passes) {
              hardReasonReDerived = true;
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
        const maybeRevive = async (existing: RequestRow, opts?: { force?: boolean }): Promise<void> => {
          // Only revive on awaiting_owner — awaiting_colleague is a pending
          // counter (the colleague IS the one being waited on, no point
          // re-pinging owner).
          if (existing.state !== 'awaiting_owner') return;
          const force = opts?.force === true;
          const lastSurfacedIso = existing.last_surfaced_at ?? existing.created_at;
          const lastSurfacedMs = lastSurfacedIso
            ? DateTime.fromSQL(lastSurfacedIso, { zone: 'utc' }).toMillis()
            : 0;
          const hoursSince = (Date.now() - lastSurfacedMs) / (1000 * 60 * 60);
          // Bouncer overturn (2026-08-10), Problem A — `refreshIfOpen` passes
          // `force: true` exactly when it just changed subject/description/
          // deferred_action on this row. That change is what he must see
          // before his next ✅ can mean anything (silently he could otherwise
          // sign off a corrected time/attendee list he was never shown), so it
          // bypasses the cold-re-ask threshold — that gate answers "is he due
          // a nudge," not "did the ask change under him."
          if (!force && (!Number.isFinite(hoursSince) || hoursSince < REVIVAL_THRESHOLD_HOURS)) return;

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
              lead: force
                ? `${requesterFirst} changed the ask — here's the updated version, still need your call:`
                : `${requesterFirst} just asked again about this — still need your call:`,
              reSurface: { raisedAt: existing.created_at },
            });
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { postOwnerDecision } = require('../utils/ownerDailyThread') as
              typeof import('../utils/ownerDailyThread');
            const res = await postOwnerDecision({
              profile, conn, text: reviveText,
              label: force ? 'approval correction re-post' : 'approval re-ask revival',
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
                forced: force,
                hoursSinceLastSurface: Number.isFinite(hoursSince) ? hoursSince.toFixed(2) : null,
                surfacedCount: (existing.surfaced_count ?? 0) + 1,
              });
            }
          } catch (err) {
            logger.warn('create_approval revival — threw, non-fatal', {
              requestId: existing.id, err: String(err).slice(0, 200),
            });
          }
        };

        // deferred-replay-uses-stale-pre-rename-snapshot (2026-08-09, thread
        // 1786275507.424279) — a retry that dedup-matches an OPEN request is
        // often a CORRECTION, not an idle repeat: Yael's first ask captured a
        // deferred_action for "Sync with Yael" (Yael only); her very next
        // message renamed it to "Idan, Adi & Yael" and added Adi, which
        // re-hit a rule_violation, re-captured a FRESH deferred_action_hint,
        // and reached create_approval again — but the LLM dedup judge matched
        // it to the still-open first request ("now updated with a new name
        // and attendee" — its own reasoning) and this branch used to return
        // `existing` completely untouched. The STORED deferred_action stayed
        // the pre-correction snapshot; when the owner approved 20+ minutes
        // later, the resolver replayed THAT stale snapshot — booking "Sync
        // with Yael" with no Adi, exactly what Yael then had to flag back.
        // Refresh the row's own ask (subject/description/details, including
        // deferred_action) to the CURRENT payload. Spread EXISTING details
        // first, `payload` on top — same "counter wins on key conflict"
        // shape mergeAmendIntoApprove already uses — so the fresh capture's
        // ask-shape fields (subject/start/end/attendees/deferred_action/…)
        // win, but bookkeeping the ask-raise payload never carries (counter,
        // counter_history, amend_round, amended_at — stamped only by an
        // owner/colleague amend round, resolver.ts) survives untouched. A
        // bare overwrite would erase an in-flight counter negotiation the
        // instant a same-topic retry dedup-matched onto it. Scoped to
        // `awaiting_owner`: once the owner has counter-offered
        // (awaiting_colleague) or decided (terminal), the stored decision is
        // his, not a later retry's to overwrite.
        const refreshIfOpen = (row: RequestRow): { row: RequestRow; changed: boolean } => {
          if (row.state !== 'awaiting_owner') return { row, changed: false };
          const priorDetails = (parseDetails(row) ?? {}) as Record<string, unknown>;

          // Bouncer overturn (2026-08-10), Problem A — does this refresh
          // actually change what the owner is being asked, or the action a ✅
          // replays? Drives whether maybeRevive below must force a re-post
          // regardless of its 2h cold-re-ask gate (a correction isn't a
          // "still waiting" nudge — it's a different ask he hasn't seen).
          const changed = row.subject !== subject
            || (row.description ?? '') !== askText
            || JSON.stringify(priorDetails.deferred_action ?? null) !== JSON.stringify(payload.deferred_action ?? null);

          const mergedDetails: Record<string, unknown> = { ...priorDetails, ...payload };
          if (changed) {
            // Problem B, narrowed by bouncer overturn (2026-08-10) —
            // `honest_hard_reason` is CODE-authored only (line 393 strips it,
            // the checkSlot re-derivation above is the ONLY place that
            // re-sets it). Once the ask has materially changed, the PRIOR
            // sentence must not survive onto a different ask by spread order
            // alone — UNLESS this turn never actually re-checked the new
            // slot (existing-event change, or the checkSlot/getCalendarEvents
            // read threw — `hardReasonReDerived` false in both). "Not
            // re-proved this turn" is not "disproved": a throw on a Graph
            // hiccup must not silently erase a hard collision proven true on
            // an earlier turn (skill.ts:545-547, approvalCallbacks.ts:227-234
            // — this mechanism never flips that line off on a transient
            // read). Only clear it when the re-derivation completed and came
            // back clean/soft; keep the fresh string when it completed and
            // re-proved the hard collision.
            if (typeof payload.honest_hard_reason === 'string') {
              mergedDetails.honest_hard_reason = payload.honest_hard_reason;
            } else if (hardReasonReDerived) {
              delete mergedDetails.honest_hard_reason;
            }
          }

          updateRequest(row.id, { subject, description: askText, details: mergedDetails });

          // Trap noted by the bouncer, fixed as cheap/obvious: idempotency_key
          // is hash(owner, requester, kind, subject) — if a subject correction
          // doesn't also refresh it, a LATER retry keyed off the OLD subject
          // still resolves to this row and can revert the correction just
          // made. Best-effort: a collision with a different open row's key is
          // left alone (logged) rather than crashing this tool call over a
          // low-stakes housekeeping update.
          if (row.subject !== subject) {
            try {
              const refreshedKey = buildIdempotencyKey({
                ownerUserId, requesterSlackId: requesterSlackId ?? null, kind: 'approval', subject,
              });
              if (refreshedKey !== row.idempotency_key) {
                updateRequest(row.id, { idempotencyKey: refreshedKey });
              }
            } catch (err) {
              logger.warn('refreshIfOpen — idempotency_key refresh skipped', {
                requestId: row.id, err: String(err).slice(0, 200),
              });
            }
          }

          return { row: getRequest(row.id)!, changed };
        };

        if (existingId) {
          const { row: existing, changed } = refreshIfOpen(getRequest(existingId)!);
          await maybeRevive(existing, { force: changed });
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
            // Live duplicate of the SAME still-open ask — reuse it (re-surface if
            // stale), refreshing its stored snapshot first (same stale-replay
            // risk as the LLM-dedup branch above and the UNIQUE-collision
            // branch below — see refreshIfOpen's comment).
            logger.info('create_approval — reusing OPEN idempotency match', {
              existingId: idempotent.id, state: idempotent.state, subject, requesterSlackId,
            });
            const { row: refreshedIdempotent, changed: idempotentChanged } = refreshIfOpen(idempotent);
            await maybeRevive(refreshedIdempotent, { force: idempotentChanged });
            return {
              ok: true,
              approval_id: refreshedIdempotent.id,
              created: false,
              expires_at: refreshedIdempotent.expires_at,
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

        // gh#pending-cap-blocks-unrelated-questions — creation-time cap (see
        // colleaguePendingCapRefusal above), checked HERE and not earlier:
        // every dedup / open-idempotency reuse above this line has already
        // had its chance to return an EXISTING row without incrementing the
        // colleague's pending count. Only past this point are we actually
        // about to mint a brand-new approval — the "3rd tracked item" the
        // cap exists to stop, never a correction to one of the first two.
        {
          const capRefusal = await colleaguePendingCapRefusal(context, ownerUserId);
          if (capRefusal) {
            logger.info('create_approval — refused at the colleague pending cap', {
              requesterSlackId, subject,
            });
            return capRefusal;
          }
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
            // #154 — any room surface (MPIM or real channel), not MPIM-only.
            // See create_task above for the same widening and why.
            originIsMpim: context.surface === 'room',
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
          // Same stale-snapshot risk as the LLM-dedup branch above (a retry
          // hitting the SAME idempotency key is the same-subject case of the
          // identical bug) — refresh the stored ask before reuse.
          const { row: refreshed, changed: refreshedChanged } = refreshIfOpen(existing);
          await maybeRevive(refreshed, { force: refreshedChanged });
          return {
            ok: true,
            approval_id: refreshed.id,
            created: false,
            expires_at: refreshed.expires_at,
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

Also returns \`recent_activity\` — a newest-first history of what Maelle has already done (calendar changes, messages sent, approvals decided, research completed), with NO time cutoff (\`recent_activity_count\` in summary is its length). Use it for "what have you done?" or something from weeks/months back — not just what's still open. with_person filters this too. It's capped at the most recent items, not a date range, so a very old item can be missing simply because newer activity pushed it past that cap. Each row also carries \`target_name\`/\`target_slack_id\` when the action had a specific counterpart — match a person or action the owner describes against these to find the right \`task_id\`, e.g. to pass into revert_last_auto_move for a specific undo.

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
        description: `Send the morning briefing immediately, posted in the current thread.`,
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'create_approval',
        description: `Ask the owner for a decision. ALWAYS use this when you need the owner to decide something instead of just DMing them a question. The owner is the only one who can bypass scheduling rules — colleagues asking for something that breaks the rules MUST go through this tool. Maelle never overrides on her own.

AUTHORITY MODEL:
- If the owner tells Maelle directly to do something (even when it breaks a rule), that IS the approval — just do it, no approval needed.
- If a colleague asks for something that breaks a rule or needs an owner-only judgment, create_approval — the owner must decide.
- RELAY IT AS AN APPROVAL IN FLIGHT, NOT A DEAD END, AND NEVER AS DONE. When you raise this for a colleague, tell the requester plainly that you've SENT it to the owner (by name) to decide — nothing is confirmed yet, so never open with completion language ("you're all set", "done", "sorted", "added") that reads as if the change already happened. If a colleague who did NOT request this meeting asks to be added to it, say so plainly ("I've sent your request to join the meeting to Idan to decide — I'll let you know as soon as he does"), not "you can join — I've sent it to the owner to approve" and never "you're all set, added you to the ask I've sent Idan" (unclear what "the ask" refers to and reads as already-confirmed). NEVER frame it as "the owner must make the change themselves" or "you can't change this."

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
            payload: { type: 'object', description: 'Kind-specific payload (see tool description). Pass a real JSON object here, NOT a JSON-encoded string.' },
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

Binding — take the explicit id token from the owner's reply; otherwise the line marked "← THIS THREAD" in PENDING APPROVALS, which renders whenever anything is pending and carries the full disambiguation rules. No anchor and several open → call list_pending_approvals and ask which one by subject. Outside the anchor thread, a bare yes/no is refused UNLESS the owner's own message names this approval by subject or counterpart ("ANF already done", "reject the Erez sync") — that's detected automatically from what he actually typed, not from anything you pass in \`reason\`. If it's refused, tell him which open approvals exist and ask him to confirm in the approval's own thread, the daily thread, or by naming which one he means.`,
        input_schema: {
          type: 'object',
          properties: {
            approval_id: { type: 'string' },
            verdict: { type: 'string', enum: ['approve', 'reject', 'amend'] },
            data: { type: 'object' },
            counter: { type: 'object' },
            reason: { type: 'string', description: 'Owner\'s own words, when relevant — relayed to the requester on reject/amend to explain the decision. Does NOT unlock resolving outside the approval\'s anchor thread; that\'s checked automatically against what the owner actually typed, not against this argument.' },
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

        // Kind mapping: 'research' collapses to the research kind; every
        // other taskType maps straight onto its own RequestKind.
        const kind: RequestKind = taskType === 'research' ? 'research' : taskType;

        // state=in_flight (Maelle is working on it); informed=1 regardless of
        // who raised it — the owner sees it in the daily brief either way.
        // Reminders/follow-ups fire via next_check_at + handler='reminder_fire'.
        // Research uses 'research_run' — runs the full agent loop at due_at and
        // DMs the result. Both fire on the ONE spine sweep (sweepDueRequests);
        // the old tasks-table dispatchers were the duplicate path, now deleted.
        const nextCheckHandler = taskType === 'research' ? 'research_run' : 'reminder_fire';

        // gh#pending-cap-blocks-unrelated-questions — creation-time cap
        // (see colleaguePendingCapRefusal above). create_task is
        // colleague-reachable (o#219), so a capped colleague trying to open
        // a THIRD tracked reminder/follow_up/research is refused here —
        // never at message receipt, so an ordinary question never trips it.
        const capRefusal = await colleaguePendingCapRefusal(context, ownerUserId);
        if (capRefusal) {
          return { error: capRefusal.error, message: capRefusal.reason };
        }

        const row = createRequest({
          ownerUserId,
          initiatedBy: context.userId,
          // o#219 — create_task IS colleague-reachable (registry.ts's
          // COLLEAGUE_ALLOWED_TOOLS has no authority/senderRole gate on it), so
          // stamp the role that actually created it — same pattern as
          // create_approval below — never hardcode 'owner'. runner.ts's
          // runResearchRun derives its senderRole/authority off `initiated_by`
          // itself (not this field), so a colleague-raised research row no
          // longer replays with full owner tool access into a shared room.
          initiatedByRole: context.senderRole === 'owner' ? 'owner' : 'colleague',
          kind,
          subject: title,
          description,
          state: 'in_flight',
          informed: 1,
          // The reminder is an activity OWNED BY its requester (owner or
          // colleague — create_task is colleague-reachable too). runReminderFire
          // reads this to frame third-party reminders ("<requester> asked me to
          // remind you").
          requesterSlackId: context.userId,
          targetSlackId,
          targetName,
          originChannel: channelId,
          originThreadTs: threadTs,
          // #154 — any room surface (MPIM or real channel), not MPIM-only. The
          // return-leg readers (resolver.ts/runner.ts/briefs.ts/
          // closeMeetingArtifacts.ts) already gate on `origin_is_mpim &&
          // origin_channel`; this is what feeds that boolean.
          originIsMpim: context.surface === 'room',
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

        // gh#52 (52-U6) — "what have you done?" recall: completed activity
        // (logged-state rows), newest first, NO time cutoff (owner's ruling —
        // this table is never pruned). Default limit keeps the read cheap;
        // no with_person-style widening arg exists on this tool yet, so none
        // is added here (52-U6 dispatch note: only widen an existing arg).
        const RECENT_ACTIVITY_DEFAULT_LIMIT = 25;
        const recentActivityRows = getRecentActivityForOwner(ownerUserId, RECENT_ACTIVITY_DEFAULT_LIMIT)
          .filter(r => !withPerson || r.target_slack_id === withPerson || r.requester_slack_id === withPerson);
        const recentActivity = recentActivityRows.map((r): Record<string, unknown> => {
          let outcome: Record<string, unknown> | null = null;
          if (r.outcome_json) {
            try { outcome = JSON.parse(r.outcome_json) as Record<string, unknown>; } catch { outcome = null; }
          }
          return {
            task_id: r.id,
            kind: r.kind,
            subkind: r.subkind,
            subject: r.subject,
            // gh#52 follow-up (revert-intent-and-single-step-undo-scope, piece
            // 3a) — the captured target identity, when the row has one (see
            // OT-4's targetSlackId/targetName comment on logActivity.ts). Was
            // dropped here even though the DB row already carried it; a
            // revert-by-description ask ("undo the move I did for Dana") needs
            // this to match a described person against a specific row.
            target_name: r.target_name,
            target_slack_id: r.target_slack_id,
            // created_at is stored as a bare UTC SQL datetime (see other
            // fromSQL call sites in this codebase) — render owner-local so
            // "did X this morning" reads correctly against the owner's clock.
            done_at: DateTime.fromSQL(r.created_at, { zone: 'utc' }).setZone(profile.user.timezone).toISO() ?? r.created_at,
            outcome,
          };
        });

        const totalOpen = awaitingOwner.length + awaitingColleague.length + inFlight.length;
        return {
          summary: {
            total: totalOpen,
            pending_your_input_count: awaitingOwner.length,
            waiting_on_others_count: awaitingColleague.length,
            active_count: inFlight.length,
            recent_activity_count: recentActivity.length,
          },
          pending_your_input: awaitingOwner,
          pending_approvals: awaitingOwner.filter(r => (r as any).kind === 'approval'),
          waiting_on_others: awaitingColleague,
          active_tasks: inFlight,
          recent_activity: recentActivity,
          count: totalOpen,
          _note: 'Describe these to the owner USING ONLY the fields in this response. Do NOT add subjects or context remembered from past conversations or people_memory. recent_activity is newest-first with no time cutoff — if it looks short for an old date, that reflects what was actually logged, not a missing older page.',
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

      case 'create_approval':
        return createApprovalRequest(args, context);

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
        // v4.4.x (#154-tool-split) — gated on `authority`, not `senderRole`.
        // senderRole reads 'colleague' both for a real colleague AND for the
        // owner clamped into a room (OWNER_ROOM_ACTION_TOOLS ships/dispatches
        // resolve_approval to him there); authority is who is AUTHENTICATED
        // as acting and stays 'owner' on every surface. Gating this on
        // senderRole left the room-clamped owner's own "approve" inert — he'd
        // fall into the colleague branch below, which requires him to be the
        // amending row's own requester, and get refused with "Only the
        // original requester can respond to an amending approval."
        if (context.authority !== 'owner') {
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
        // resolves. Pre-fix the owner-path prompt injected ALL awaiting_owner
        // approvals with no thread scoping and nudged "pick the most recently
        // created", so a bare "Yes" typed in an UNRELATED thread — a
        // fire-and-forget shadow offer that has no request row of its own —
        // bound to the only pending approval and booked it (Athena,
        // 2026-07-13 10:07; the owner meant a lunch-bump offer in another
        // thread). Module D and the orchestrator's thread-lock both correctly
        // declined on the mismatch; this is the same gate at the tool
        // chokepoint, where Sonnet's free-bind lands. `amend` carries a
        // specific counter (never a stray ack) and is exempt.
        // v4.4.x (#154-tool-split) — gated on `authority`, matching the entry
        // gate above: the owner clamped into a room can never anchor to his
        // own DM thread (different channel entirely), so this correctly falls
        // through to the namedMatch check — an unnamed bare ack from a room
        // still refuses to bind, same protection the DM path gets.
        if (context.authority === 'owner' && verdict !== 'amend') {
          const ownerRow = getRequest(requestId);
          if (ownerRow) {
            // Other approvals currently awaiting the owner, excluding this
            // one — the shared "could this bare reply plausibly mean
            // something else open right now" fact every check below needs
            // (anchored's daily-thread arm, namedMatch, chronoAnchor).
            // Computed once, up front.
            const otherOpenApprovals = getAwaitingOwnerRequests(ownerRow.owner_user_id)
              .filter(r => r.kind === 'approval' && r.id !== requestId);
            // Two independent ways to be anchored to THIS approval:
            //  - messageAnchored: the reply is keyed to this approval's own
            //    posted message (terminal_dm_msg_ts) — always safe, since no
            //    other approval can share one message's own Slack ts.
            //  - dailyThreadAnchored: the reply landed in the shared "one
            //    thread a day" book (R8 — owner_dm_thread_ts is the SAME
            //    value for every approval asked or resurfaced that day, by
            //    design; see ownerDailyThread.ts). gh#194 (2026-08-10) — this
            //    arm used to fire on thread equality ALONE. Because that
            //    value is shared across every approval of the day, a
            //    contentless "Yes" typed in that thread satisfied it for BOTH
            //    a fresh Yael approval and an unrelated resurfaced Elie
            //    approval at once — being "in today's book" only proves the
            //    reply is decision-shaped, never WHICH decision it answers.
            //    `anchored` bound to whichever row the model guessed for
            //    `approval_id` (Elie's), with zero discrimination between the
            //    two open approvals, and Maelle told the wrong person the
            //    outcome. dailyThreadAnchored now only counts when this is
            //    the SOLE open approval sharing that thread — the same
            //    sole-outstanding-candidate discipline chronoAnchor below
            //    already applies to a plain untethered DM reply; a
            //    shared-thread reply gets no less scrutiny than an unthreaded
            //    one. When it's ambiguous, control falls through to
            //    namedMatch/chronoAnchor exactly as an unanchored reply
            //    already does.
            const messageAnchored = !!context.threadTs && context.threadTs === ownerRow.terminal_dm_msg_ts;
            const inDailyThread = !!context.threadTs
              && !!ownerRow.owner_dm_thread_ts
              && context.threadTs === ownerRow.owner_dm_thread_ts;
            const ambiguousDailyThread = inDailyThread
              && otherOpenApprovals.some(r => r.owner_dm_thread_ts === ownerRow.owner_dm_thread_ts);
            const dailyThreadAnchored = inDailyThread && !ambiguousDailyThread;
            const anchored = messageAnchored || dailyThreadAnchored;
            // v4.4.x (GH#169/#176, REVISITED per owner ruling — the first cut
            // wasn't trusted and was sent back) — a reply outside the anchor
            // thread still binds when the OWNER'S OWN message this turn
            // (context.currentUserMessage — the raw Slack text, plumbed from
            // orchestrator/index.ts, NOT the model's tool argument) demonstrably
            // NAMES this approval (its subject or counterpart), via the same
            // deterministic referent check the owner-says-done scanner uses
            // (messageReferencesRequest).
            //
            // The first cut grounded this on `args.reason` instead — free text
            // the MODEL itself writes, checked against a row the model ALSO
            // picked via approval_id. That is no independent grounding at all:
            // nothing stops the model from mis-picking approval_id (the exact
            // Athena failure, 2026-07-13) and then filling `reason` with a
            // plausible subject string it read elsewhere in its own context,
            // satisfying the very check meant to catch its mistake. Grounding on
            // the owner's literal turn text closes that, because the model does
            // not control what the owner actually typed. The Athena mis-bind was
            // a CONTENTLESS "Yes" that named nothing — that still fails this
            // check and stays refused. "ANF already done" / "reject that Sync
            // with Erez" name the thing they mean, so they bind even though most
            // owner replies land as plain (non-thread-clicked) DM messages,
            // which structurally can never equal
            // terminal_dm_msg_ts/owner_dm_thread_ts (GH#169 transcript: the
            // owner's very next reply to Maelle's own ask was refused 3x
            // running).
            const ownerLiteralMessage = context.currentUserMessage ?? '';
            let namedMatch = !anchored && ownerLiteralMessage.trim().length > 0
              && messageReferencesRequest(ownerLiteralMessage, ownerRow);
            // gh#169-a (owner ruling: "ok build") — a topical mention must be
            // UNIQUE among the owner's other open approvals before it can bind
            // one unanchored. Pre-fix, a shared counterpart name or subject
            // token let a bare reply bind whatever row `approval_id` happened
            // to name even when a SECOND open approval matches the exact same
            // words — the owner never said which one. Refuse (same
            // needs_clarification shape) when 2+ open awaiting_owner approvals
            // match this message; anchored replies are unaffected since
            // `anchored` (above) already requires either a message-specific
            // match or an unambiguous daily-thread match.
            let ambiguousNamedMatch = false;
            if (namedMatch) {
              if (otherOpenApprovals.some(r => messageReferencesRequest(ownerLiteralMessage, r))) {
                ambiguousNamedMatch = true;
                namedMatch = false;
              }
            }
            // gh#174-a — chronological fallback for a PLAIN top-level DM
            // reply, the structural case anchored/namedMatch can never catch
            // on content alone: handlers.ts collapses an un-threaded
            // message's thread_ts to its OWN ts (correct Slack semantics for
            // "no thread_ts field"), which can never equal
            // terminal_dm_msg_ts/owner_dm_thread_ts, and a contentless "yes"
            // has nothing for messageReferencesRequest to match (GH#169
            // transcript: the owner's very next reply to Maelle's own ask was
            // refused 3x running). Binds ONLY when every one of these holds,
            // each closing a specific misbind this gate exists to prevent:
            //  - this approval is the ONLY one currently awaiting the owner
            //    (otherOpenApprovals is empty) — never guess among several
            //    (the Athena mis-bind, 2026-07-13, had exactly one pending —
            //    this doesn't relax that, it's the same fact);
            //  - the reply landed in the SAME DM channel the ask was posted to;
            //  - the reply's ts genuinely postdates the ask's ts — a reply can
            //    only be answering something that already existed;
            //  - the reply's thread_ts isn't itself a known anchor for some
            //    OTHER tracked request (isKnownRequestThreadAnchor) — so a
            //    reply the owner deliberately sent inside a different real
            //    conversation is never stolen just because this is the only
            //    approval open right now.
            let chronoAnchor = false;
            if (!anchored && !namedMatch && !ambiguousNamedMatch
              && otherOpenApprovals.length === 0
              && context.threadTs && ownerRow.terminal_dm_msg_ts && ownerRow.owner_dm_channel
              && context.channelId === ownerRow.owner_dm_channel
            ) {
              const replyTs = parseFloat(context.threadTs);
              const askTs = parseFloat(ownerRow.terminal_dm_msg_ts);
              if (Number.isFinite(replyTs) && Number.isFinite(askTs) && replyTs > askTs
                && !isKnownRequestThreadAnchor(ownerRow.owner_user_id, context.threadTs, requestId)
              ) {
                chronoAnchor = true;
                logger.info('resolve_approval — unanchored but this is the sole outstanding approval and the reply postdates its ask; binding', {
                  requestId, verdict, threadTs: context.threadTs, askTs: ownerRow.terminal_dm_msg_ts,
                });
              }
            }
            if (!anchored && !namedMatch && !chronoAnchor) {
              logger.warn('resolve_approval — bare ack not anchored to the approval thread; refusing to bind', {
                requestId, verdict, threadTs: context.threadTs,
                terminalDm: ownerRow.terminal_dm_msg_ts, ownerDaily: ownerRow.owner_dm_thread_ts,
                ambiguous: ambiguousNamedMatch, ambiguousDailyThread,
              });
              return {
                ok: false,
                needs_clarification: true,
                reason: (ambiguousNamedMatch || ambiguousDailyThread)
                  ? `Ambiguous: more than one of your open approvals matches what you said, so I can't tell which one you mean — reply in that specific approval's own thread (or the daily approval thread), or say something that's unique to just the one you mean.`
                  : `Not anchored: this reply isn't in ${requestId}'s decision thread (neither its own DM thread nor a daily approval thread), so a bare yes/no is too ambiguous to bind here — the owner may be responding to something else in this thread. Do NOT resolve it. Tell him you're not sure which approval he means, name the open ones by subject, and ask him to confirm in the approval's own thread (or the daily decision thread) — or just name this one by subject/colleague in his own reply (e.g. "ANF already done"), which is recognized automatically whatever thread it lands in.`,
              };
            }
            if (namedMatch) {
              logger.info('resolve_approval — unanchored but the owner\'s own message names this approval; binding', {
                requestId, verdict, threadTs: context.threadTs, ownerMessage: ownerLiteralMessage.slice(0, 120),
              });
            }
          }
        }

        let decision: ResolveVerdict;
        if (verdict === 'approve') {
          decision = { verdict: 'approve', data: (args.data as Record<string, unknown>) ?? {} };
        } else if (verdict === 'reject') {
          // reject-reason-bypasses-id-veto — `reason` is relayed to the requester
          // verbatim, parenthesized onto the decline (resolver.ts's reject-branch
          // reasonTail), the exact same leak surface the amend branch below already
          // guards with textCarriesInternalWorkItemId. Same check, reused here.
          const rejectReasonArg = typeof args.reason === 'string' ? args.reason.trim() : '';
          if (rejectReasonArg && textCarriesInternalWorkItemId(rejectReasonArg)) {
            return {
              error: 'unrelayable_reason',
              reason: 'verdict=reject can\'t carry an internal identifier to a colleague — your `reason` text holds one of our own request/task ids, which mean nothing to them. Restate it in human terms and send the reject again.',
            };
          }
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
          // amend-reason-bypasses-id-veto — `reason` is free text the owner
          // types about a specific meeting, the field most likely on this
          // tool to carry one of our own ids, and it rode straight into the
          // requester relay with no veto at all. Same check the counter
          // above just passed, reused on the one other free-text field
          // reaching the requester on this verdict.
          const reasonArg = typeof args.reason === 'string' ? args.reason.trim() : '';
          if (reasonArg && textCarriesInternalWorkItemId(reasonArg)) {
            return {
              error: 'unrelayable_counter',
              reason: 'verdict=amend can\'t carry an internal identifier to a colleague — your `reason` text holds one of our own request/task ids, which mean nothing to them. Restate it in human terms and send the amend again.',
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
            // v3.1.3 — the colleague-path is permitted only for amending
            // approvals; that's the one case where a reject/amend should
            // bounce back to the owner. An OWNER reject must close.
            // v4.4.x (#154-tool-split) — gated on `authority`, not
            // `senderRole`: the room-clamped owner (senderRole reads
            // 'colleague' there) is still the owner, so his reject/amend on
            // an awaiting_colleague row must close, not bounce back to
            // himself as if a real colleague had answered.
            resolvedByColleague: context.authority !== 'owner',
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
          // OT-4 (gh#52 bouncer fix) — the request's own requester, when this
          // approval was colleague-originated, so the activity row this
          // decision earns below is with_person-filterable on them. Null for
          // an owner-initiated approval (fresh.requester_slack_id is already
          // null there) rather than guessing.
          let requesterSlackIdForLog: string | null = null;
          try {
            const fresh = getRequest(result.request_id);
            requesterNotified = !!(fresh?.requester_slack_id
              && (fresh.requester_notified_at || fresh.state === 'awaiting_colleague'));
            requesterSlackIdForLog = fresh?.requester_slack_id ?? null;
          } catch { /* best-effort nudge */ }
          // gh#52 (52-U2) — history/undo record of the decision itself (not the
          // downstream calendar action a replay may have fired — that's
          // Matchmaker's own activity row, 52-U3/Wave 2). Only a successful
          // resolveRequest (approve/reject/amend all count — each is a real,
          // completed decision, whether it closed the request or bounced the
          // ball to the other side) earns a row.
          if (result.ok) {
            logActivity({
              ownerUserId: context.profile.user.slack_user_id,
              kind: 'approval',
              subkind: verdict,
              subject: result.subject ?? `approval ${requestId}`,
              outcomeJson: {
                effect: result.effect,
                ...(result.booked ? { booked: true, start: result.start } : {}),
              },
              initiatedBy: context.userId,
              initiatedByRole: context.authority,
              requesterSlackId: requesterSlackIdForLog ?? undefined,
            });
          }
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
When the user changes their briefing time, update the system briefing routine via manage_routine(action='update', schedule_time=…) — it reschedules and persists the time. Owner-initiated brief requests are routed deterministically to send_briefing_now BEFORE the orchestrator runs.

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
