/**
 * Request runner (v2.7.0).
 *
 * Sweeps `requests` rows whose `next_check_at <= now` and dispatches to the
 * named `next_check_handler`. Lifecycle timers live ON the request
 * row, not in a separate dispatch table. One sweep handles every kind of
 * deferred action; see `dispatchHandler` for the full set (expiry, approval
 * reminder, reminder_fire, research_run, outreach expiry/decision,
 * send_scheduled_outreach).
 *
 * After handling, the dispatcher EITHER:
 *   - clears next_check_at + next_check_handler (terminal, no more checks),
 *   - or re-arms them to the next deadline (e.g. midpoint reminder → re-arm
 *     for expiry).
 *
 * Closure flows through `closeRequest` so audit + cascade fire correctly.
 */

import { DateTime } from 'luxon';
import type { App } from '@slack/bolt';
import type { UserProfile } from '../../config/userProfile';
import { getDueRequests, updateRequest, createRequest, getRequestByIdempotencyKey, buildIdempotencyKey } from '../../db/requests';
import { getOutreachJobByRequestId } from '../../db/jobs';
import { workTimeBaseFromNow, addWorkdays } from '../../utils/workHours';
import { isColleagueSendDeferred } from '../../utils/responseDeadline';
import { closeRequest } from './closeRequest';
import type { NextCheckHandler, RequestRow } from './types';
import { parseDetails, deriveOriginSurface } from './types';
import { relayClosureToRequester } from './requesterRelay';
import { getConnection } from '../../connections/registry';
import type { SendOptions, SendResult } from '../../connections/types';
import { logActivity } from './logActivity';
import { runColleagueOofRecheck, runOofReengageReask } from './colleagueOofReengage';
import { postOwnerDecision } from '../../utils/ownerDailyThread';
import { composeOwnerAskText } from '../approvals/approvalCallbacks';
import {
  findPersistentUnaskedTimezoneDivergences,
  markTimezoneTempAskedById,
  type TimezonePersistenceCandidate,
} from '../../db/people';
import logger from '../../utils/logger';

/**
 * The ONE notification primitive for the spine sweep: send a DM or channel post
 * and LOG the outcome (res.ok + reason). A soft Slack failure (res.ok=false, no
 * throw — channel issue, not-in-channel, deactivated user) must never be
 * swallowed silently — that was the EXPIRY-SILENT-SEND blind spot, the same
 * class as the close-loop relay drop. Returns the transport SendResult (never
 * throws) so callers can branch on `ok` and read `ts`. Every send in this file
 * goes through here, except the requester-facing relays, which go through the
 * spine's shared closure relay (requesterRelay.ts — same tracking plus
 * language / leak filter / notified-stamp). No per-site conn.* clones.
 */
async function sendTracked(
  conn: NonNullable<ReturnType<typeof getConnection>>,
  target: { dm: string } | { channel: string },
  body: string,
  opts: SendOptions | undefined,
  label: string,
  requestId?: string,
): Promise<SendResult> {
  try {
    const res = 'dm' in target
      ? await conn.sendDirect(target.dm, body, opts)
      : await conn.postToChannel(target.channel, body, opts);
    if (res.ok) logger.info(`${label} — sent`, { requestId });
    else logger.warn(`${label} — send failed`, { requestId, reason: res.reason });
    return res;
  } catch (err) {
    logger.warn(`${label} — send threw`, { requestId, err: String(err).slice(0, 200) });
    return { ok: false, reason: 'send_threw', detail: String(err).slice(0, 200) };
  }
}

/**
 * Sweep all due requests. Called from the main runner loop on the same
 * cadence the legacy task runner uses.
 *
 * profilesByUserId: lookup so each request can be processed with its owner's
 * profile (timezones, working hours, etc).
 */
export async function sweepDueRequests(opts: {
  app?: App;
  profilesByUserId: Map<string, UserProfile>;
}): Promise<{ swept: number; closed: number; rearmed: number }> {
  // pre-existing-clobbered-tz-now-locked-wrong-forever (2026-09-02) — raise
  // half of the TZ-persistence ask (see raiseTimezonePersistenceAsks below).
  // Runs on this SAME 5-min cadence — no new timer, no new loop (R1);
  // throttled internally to hourly since it watches a 7-day-TTL signal.
  // Independent of the due-request sweep below — a detection-query hiccup
  // here must never block it.
  try {
    await raiseTimezonePersistenceAsks(opts.profilesByUserId);
  } catch (err) {
    logger.warn('sweepDueRequests — raiseTimezonePersistenceAsks threw — continuing', { err: String(err).slice(0, 200) });
  }

  const due = getDueRequests();
  let closed = 0;
  let rearmed = 0;

  for (const row of due) {
    const profile = opts.profilesByUserId.get(row.owner_user_id);
    if (!profile) {
      logger.debug('sweepDueRequests — no profile loaded for owner, skipping', {
        requestId: row.id, ownerUserId: row.owner_user_id,
      });
      continue;
    }
    try {
      const action = await dispatchHandler(row, profile, opts.app);
      if (action === 'closed') closed++;
      else if (action === 'rearmed') rearmed++;
    } catch (err) {
      logger.warn('sweepDueRequests — handler threw, clearing timer to avoid loop', {
        requestId: row.id, handler: row.next_check_handler, err: String(err).slice(0, 300),
      });
      // Defensive: clear the timer so we don't infinite-loop on a broken handler.
      updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    }
  }

  if (due.length > 0) {
    logger.info('sweepDueRequests', { swept: due.length, closed, rearmed });
  }
  return { swept: due.length, closed, rearmed };
}

async function dispatchHandler(
  row: RequestRow,
  profile: UserProfile,
  app: App | undefined,
): Promise<'closed' | 'rearmed' | 'noop'> {
  const handler = row.next_check_handler as NextCheckHandler | null;
  switch (handler) {
    case 'expiry':
      return runExpiry(row, profile);

    case 'approval_reminder':
      return runApprovalReminder(row, profile);

    case 'reminder_fire':
      return runReminderFire(row, profile);

    case 'research_run':
      return runResearchRun(row, profile, app);

    case 'reschedule_reask':
      return runRescheduleReask(row, profile);

    case 'outreach_expiry':
      return runOutreachExpiryOrDecision(row, profile);

    case 'send_scheduled_outreach':
      return runSendScheduledOutreach(row, profile);

    // gh#201-d
    case 'colleague_oof_recheck':
      return runColleagueOofRecheck(row, profile);

    case 'oof_reengage_reask':
      return runOofReengageReask(row, profile);

    case 'freeform_flag_retry':
      return runFreeformFlagRetry(row, profile);

    default:
      logger.warn('dispatchHandler — unknown handler, clearing timer', {
        requestId: row.id, handler,
      });
      updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
      return 'noop';
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * Generic expiry — close the request as expired + tell BOTH sides (R3).
 *
 * v2.9.1 — also notify the REQUESTER on approval-kind expiry (scenario A:
 * someone asks, owner never answers → without this the requester is left
 * hanging). Pre-fix the tombstone went only to the owner.
 *
 * #42 — the COPY is chosen from the row's STATE at fire time, not from `kind`
 * alone. `kind==='approval'` says nothing about who went quiet: after an amend
 * the owner has already decided and the request sits on the COLLEAGUE. Telling
 * the owner "I never heard back from you" and the requester "I couldn't get a
 * read from him" would then be a double lie about who ghosted whom — the exact
 * wrong-outcome failure R3 names. One expiry path, two truthful stories.
 */
async function runExpiry(row: RequestRow, profile: UserProfile): Promise<'closed'> {
  // Read the side BEFORE closing — closeRequest moves state to 'expired'.
  const waitingOnColleague = row.state === 'awaiting_colleague';
  const subject = row.subject && row.subject.toLowerCase().endsWith('needs your input')
    ? 'that ask'
    : (row.subject || 'that ask');
  closeRequest({
    id: row.id,
    state: 'expired',
    closureReason: waitingOnColleague ? 'no_colleague_reply_in_window' : 'no_action_in_window',
    closedBy: 'expiry',
  });
  // Tombstone to the owner: what actually stalled, in his decision thread.
  if (row.kind === 'approval' && row.owner_dm_channel) {
    try {
      const conn = getConnection(profile.user.slack_user_id, 'slack');
      if (conn) {
        const who = row.requester_name?.split(' ')[0] ?? 'They';
        const what = waitingOnColleague
          ? `${who} never came back on what you suggested for "${subject}". I've closed it — say the word if you want me to chase it again.`
          : `I never heard back on the approval I asked about. I've closed it, let me know if you want to try again.`;
        await sendTracked(
          conn,
          { channel: row.owner_dm_channel },
          what,
          { threadTs: row.owner_dm_thread_ts ?? undefined },
          'runExpiry owner tombstone',
          row.id,
        );
      }
    } catch (err) {
      logger.warn('runExpiry — tombstone DM failed', { requestId: row.id, err: String(err).slice(0, 200) });
    }
  }
  // v2.9.1 — requester loop-close on approval expiry (R3: expiry tells BOTH
  // sides). #42 — the copy branches on the row's pre-close state: after an
  // amend the owner ANSWERED and it's the colleague's reply that never came;
  // "I couldn't get a read from him" there would blame him for their silence.
  // Language, leak-filtered subject, origin-thread routing and the
  // stamp-only-on-confirmed-send idempotency all live in the ONE shared relay
  // (requesterRelay.ts) — this was an inline English-only copy that also
  // stamped requester_notified_at even when the send had failed.
  if (row.kind === 'approval' && row.requester_slack_id && !row.requester_notified_at) {
    await relayClosureToRequester({
      row,
      profile,
      label: 'runExpiry requester loop-close',
      compose: ({ lang, hi, ownerFirst, subject: relaySubject }) => waitingOnColleague
        ? (lang === 'he'
          ? `${hi} — לא קיבלתי תשובה על מה ש${ownerFirst} הציע לגבי ${relaySubject}, אז סגרתי את זה בינתיים. אפשר להרים את זה שוב מתי שמתאים.`
          : `${hi} — I never heard back on what ${ownerFirst} suggested for ${relaySubject}, so I've closed this off for now. Ping me whenever you want to pick it up again.`)
        : (lang === 'he'
          ? `${hi} — לא הצלחתי לקבל תשובה מ${ownerFirst} לגבי ${relaySubject}. סוגרת את זה בינתיים — אפשר לנסות שוב מתי שתרצו.`
          : `${hi} — I couldn't get a read from ${ownerFirst} on ${relaySubject}. Closing this for now; ping me when you want to try again.`),
    });
  }
  return 'closed';
}

/**
 * Approval midpoint reminder — nag the owner once at the halfway point, inside
 * his work hours. Then re-arm next_check_at = expires_at, handler = 'expiry'.
 */
async function runApprovalReminder(row: RequestRow, profile: UserProfile): Promise<'rearmed' | 'closed'> {
  // #42 — never nag the owner about a call that isn't his to make. Every
  // transition off awaiting_owner re-aims the clock (resolver timersForWaitingSide),
  // so this is the precondition made explicit rather than assumed: reaching here
  // in any other state means a re-aim was missed, and "Still waiting on your call
  // here" would be a lie. Fall straight through to expiry instead of nagging.
  if (row.state !== 'awaiting_owner') {
    logger.info('runApprovalReminder — not awaiting the owner, skipping the nag and arming expiry', {
      requestId: row.id, state: row.state,
    });
    updateRequest(row.id, {
      nextCheckAt: row.expires_at ?? null,
      nextCheckHandler: row.expires_at ? 'expiry' : null,
    });
    return 'rearmed';
  }
  if (!row.expires_at) {
    // No expiry → just clear the timer (defensive — shouldn't happen since
    // approval_reminder is only set when expires_at exists).
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'rearmed';
  }

  // R4 — an owner-facing ping respects his work hours. The midpoint is plain
  // wall-clock arithmetic laid over a WORKDAY-aware expiry (tasks/skill.ts), so
  // the two disagree the moment a weekend sits between them: a Thursday ask whose
  // 2-workday deadline lands on Monday midpoints onto SATURDAY, and the nag fired
  // there.
  //
  // Clamped HERE, at the send, not at the raise. This is the ONE place the nag is
  // emitted, so every arming path is covered by construction; and a per-date
  // schedule override added AFTER the raise (a day off, changed hours) invalidates
  // a raise-time clamp but can never invalidate this one — it is evaluated at fire
  // time against the same accessor everything else reads (getEffectiveWorkDay, via
  // workTimeBaseFromNow). That helper is already this spine's convention for
  // owner-facing timing (timersForWaitingSide, create_approval's expiry base):
  // NOW when he is inside work hours, else the next work-time start.
  //
  // Only the NUDGE defers. Expiry does not — a closure is an outcome both sides
  // are owed on time (R3), not a nudge that can wait for Sunday.
  const nextWorkTime = workTimeBaseFromNow(profile);
  const deferMs = Date.parse(nextWorkTime);
  if (Number.isFinite(deferMs) && deferMs > Date.now() + 60_000) {
    const expiresMs = Date.parse(row.expires_at);
    if (Number.isFinite(expiresMs) && deferMs >= expiresMs) {
      // The next work-hours slot is past the deadline: the nag would either
      // announce a closing time already gone, or land after expiry has closed the
      // row. Drop the nudge and go straight to the honest outcome.
      logger.info('runApprovalReminder — next work-hours slot is past expiry, skipping the nag', {
        requestId: row.id, expiresAt: row.expires_at, nextWorkTime,
      });
      updateRequest(row.id, { nextCheckAt: row.expires_at, nextCheckHandler: 'expiry' });
      return 'rearmed';
    }
    logger.info('runApprovalReminder — outside the owner work hours, deferring the nag', {
      requestId: row.id, nextWorkTime, expiresAt: row.expires_at,
    });
    updateRequest(row.id, { nextCheckAt: nextWorkTime, nextCheckHandler: 'approval_reminder' });
    return 'rearmed';
  }

  // Nag DM. We deliberately do NOT stamp terminal_dm_msg_ts on this DM —
  // emoji ✅ on the reminder is a no-op. The owner must react on the
  // original (terminal_dm_msg_ts) or reply in chat.
  if (row.owner_dm_channel) {
    const conn = getConnection(profile.user.slack_user_id, 'slack');
    if (conn) {
      const expiresLocal = DateTime.fromISO(row.expires_at, { zone: 'utc' })
        .setZone(profile.user.timezone);
      const expLabel = expiresLocal.toFormat("EEEE 'at' HH:mm");
      await sendTracked(
        conn,
        { channel: row.owner_dm_channel },
        `Still waiting on your call here: "${row.subject}". Closing it on ${expLabel} if I don't hear back.`,
        { threadTs: row.owner_dm_thread_ts ?? undefined },
        'runApprovalReminder nag',
        row.id,
      );
    }
  }
  // Re-arm for expiry.
  updateRequest(row.id, {
    nextCheckAt: row.expires_at,
    nextCheckHandler: 'expiry',
  });
  return 'rearmed';
}

/**
 * Reminder fires — DM the owner (or target) with the reminder message,
 * then close the request.
 */
async function runReminderFire(row: RequestRow, profile: UserProfile): Promise<'closed'> {
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  const message = typeof details.message === 'string' && details.message
    ? details.message
    : (row.subject ?? '');
  const ownerId = profile.user.slack_user_id;
  const targetSlackId = row.target_slack_id ?? ownerId;
  const remindingSomeoneElse = targetSlackId !== ownerId;

  try {
    const conn = getConnection(ownerId, 'slack');
    if (conn) {
      if (remindingSomeoneElse) {
        // Remind someone else: DM them framed as coming from the owner, then
        // report back to the owner (or flag if they were unreachable). This is
        // the behavior the old tasks-table dispatchReminder owned — now folded
        // into the single spine chokepoint so there's one reminder path.
        const ownerFirst = profile.user.name.split(' ')[0];
        const targetName = row.target_name ?? 'them';
        const framed = `${ownerFirst} asked me to remind you: ${message}`;
        const res = await sendTracked(conn, { dm: targetSlackId }, framed, undefined, 'runReminderFire colleague DM', row.id);
        if (res.ok) {
          await sendTracked(conn, { dm: ownerId }, `Reminded ${targetName} about "${row.subject ?? message}".`, undefined, 'runReminderFire owner report', row.id);
          // runReminderFire-same-invisibility-as-research (2026-08-14) — a
          // colleague DM is one of logActivity's own four canonical
          // outward-effect categories ("a colleague DM, a resolved approval, a
          // research run" — see logActivity.ts's header), and every other DM-
          // send site (skills/outreach.ts's message_colleague, twice) logs
          // itself the same way. This one didn't: the reminder row closing
          // below records that the REMINDER fired, not that a DM went out to
          // this specific colleague, so a later with_person/recent-activity
          // read never saw it. Logged only on a confirmed send (logActivity's
          // own "only after the action succeeded" rule).
          logActivity({
            ownerUserId: ownerId,
            kind: 'outreach',
            subkind: 'dm',
            subject: `Reminded ${targetName}: ${row.subject ?? message}`,
            initiatedBy: ownerId,
            initiatedByRole: 'owner',
            targetSlackId,
            targetName: row.target_name ?? undefined,
          });
        } else {
          await sendTracked(conn, { dm: ownerId }, `I couldn't reach ${targetName} to send that reminder — you may want to ping them directly.`, undefined, 'runReminderFire owner unreachable report', row.id);
        }
      } else {
        // Remind me — DM the owner the message.
        await sendTracked(conn, { dm: ownerId }, message, undefined, 'runReminderFire owner reminder', row.id);
      }
    }
  } catch (err) {
    logger.warn('runReminderFire — DM threw', { requestId: row.id, err: String(err).slice(0, 200) });
  }
  closeRequest({
    id: row.id,
    // gh#52 (52-U8) parity (runReminderFire-same-invisibility-as-research,
    // 2026-08-14) — 'logged', not 'resolved': a fired reminder is exactly the
    // "completed Maelle-initiated action that needed no owner decision" case
    // logActivity.ts's header names research/DMs/approvals as examples of.
    // 'resolved' made it invisible the instant the brief surfaced+flipped
    // informed — getRequestsForBrief excludes anything resolved once narrated,
    // so a later "did you remind Yael about X" had nothing to recall from.
    // 'logged' is what getRecentActivityForOwner (52-U6) can still find, forever.
    state: 'logged',
    closureReason: 'reminder_fired',
    closedBy: 'system',
  });
  return 'closed';
}

/**
 * Research fires — run the research prompt through the orchestrator (full
 * agent loop, non-interactive), DM the owner the result, then close. Ported
 * from the deleted tasks-table dispatchResearch so research lives on the one
 * spine chokepoint (create_task → kind=research → handler='research_run')
 * instead of the broken reminder_fire path that only DM'd the title and never
 * actually researched anything.
 */
// gh#52 (52-U8) — cap on what a research closure stores in outcome_json. A
// few thousand characters holds the actual answer Maelle DM'd the owner
// without keeping a full transcript or raw tool-call history (the row is
// data to recall later via get_my_tasks' recent_activity bucket, not an
// audit trace).
const RESEARCH_ANSWER_STORE_CAP = 4000;

async function runResearchRun(row: RequestRow, profile: UserProfile, app: App | undefined): Promise<'closed'> {
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  const researchPrompt = (typeof details.message === 'string' && details.message)
    ? details.message
    : (row.description ?? `Research: ${row.subject ?? ''}`);
  const ownerId = profile.user.slack_user_id;
  const channelId = row.origin_channel ?? '';
  let answer: string | undefined;

  try {
    // Dynamic import avoids a load-time cycle (orchestrator → skills → spine).
    const { runOrchestrator } = await import('../orchestrator');
    // v4.4.x (#154-replay-surface; corrected by o#219) — create_task is
    // COLLEAGUE-reachable (skills/registry.ts's COLLEAGUE_ALLOWED_TOOLS has no
    // authority/senderRole gate on it), so a research/reminder row is NOT
    // owner-only by construction — any colleague can raise one. Hardcoding
    // 'owner' here shipped the FULL owner tool set (get_calendar, etc.) plus
    // the OWNER_ROOM_ACTION_TOOLS room-action floor to a colleague-raised run,
    // whatever origin_channel it then posted the reply into.
    //
    // `row.initiated_by` is the raiser's raw, never-clamped Slack id (stamped
    // straight off context.userId at creation, tasks/skill.ts's create_task) —
    // comparing it to the owner's own id re-derives TRUE authority exactly
    // like the Slack front door's getSenderRole(senderId), rather than
    // trusting `initiated_by_role` for this: that field (like the live turn's
    // `senderRole`) is surface-clamped to 'colleague' for ANYONE — owner
    // included — raised from inside a room, so it can't alone tell an
    // owner-in-a-room from a genuine colleague.
    const rawRole: 'owner' | 'colleague' = row.initiated_by === profile.user.slack_user_id ? 'owner' : 'colleague';
    // `surface`/`isMpim` stay row-derived (unchanged from #154-replay-surface)
    // so every tool call this run makes reads subjectViewerFor/viewerEmailFor
    // honestly instead of as a fully private owner DM.
    const surface = deriveOriginSurface(row);
    // Mirrors the live-turn clamp at connectors/slack/app/processMessage.ts:
    // senderRole reads 'colleague' on any room surface no matter who raised
    // it; authority (the actual privilege floor) is never clamped by surface.
    const senderRole: 'owner' | 'colleague' = surface === 'room' ? 'colleague' : rawRole;
    const result = await runOrchestrator({
      userMessage: researchPrompt,
      conversationHistory: [],
      threadTs: `research_${row.id}_${Date.now()}`,
      channelId,
      userId: row.initiated_by,
      senderRole,
      authority: rawRole,
      surface,
      isMpim: surface === 'room',
      channel: 'slack',
      interactive: false,  // scheduled research run, not a conversation: no social coda
      profile,
      app,
    });
    if (result.reply) {
      answer = result.reply.length > RESEARCH_ANSWER_STORE_CAP
        ? `${result.reply.slice(0, RESEARCH_ANSWER_STORE_CAP)}…`
        : result.reply;
      const conn = getConnection(ownerId, 'slack');
      if (conn) {
        // A soft send failure is logged, never swallowed; the answer itself
        // survives regardless in outcome_json below, recallable via
        // get_my_tasks' recent_activity bucket.
        if (channelId) {
          await sendTracked(conn, { channel: channelId }, result.reply, { threadTs: row.origin_thread_ts ?? undefined }, 'runResearchRun result post', row.id);
        } else {
          await sendTracked(conn, { dm: ownerId }, result.reply, undefined, 'runResearchRun result DM', row.id);
        }
      }
    }
  } catch (err) {
    logger.warn('runResearchRun — orchestrator threw', { requestId: row.id, err: String(err).slice(0, 300) });
  }
  closeRequest({
    id: row.id,
    // gh#52 (52-U8) — 'logged', not 'resolved': a research run is exactly
    // the "completed Maelle-initiated action that needed no owner decision"
    // logActivity.ts's own header names as a canonical logged-row example
    // (research run alongside a colleague DM / a resolved approval). Closing
    // as 'resolved' left it invisible everywhere the instant the brief
    // surfaced+flipped informed — 'logged' is what makes it recallable via
    // get_my_tasks' recent_activity bucket (52-U6), forever, by design.
    state: 'logged',
    closureReason: 'research_completed',
    closedBy: 'system',
    // The answer Maelle already found, so a later "what did you find out
    // about X" is answered from this row instead of re-running the research.
    outcomeJson: answer ? { answer } : undefined,
  });
  return 'closed';
}

/**
 * v3.5.x — reschedule "checking" re-ask. A colleague replied "let me check /
 * I'll come back to you" to a meeting_reschedule ask; the reply handler kept the
 * request open and armed this at +24h. Fires ONCE: re-ping the colleague with the
 * original proposal, then re-arm to the normal outreach_expiry — so it never
 * re-asks a second time, and eventual silence still closes cleanly (owner
 * tombstone). A real reply before now would have run handleRescheduleReply and
 * cleared this timer, so reaching here means still-waiting. No new state — reads
 * the outreach detail row by request_id.
 */
async function runRescheduleReask(row: RequestRow, profile: UserProfile): Promise<'rearmed' | 'noop'> {
  const job = getOutreachJobByRequestId(row.id);
  // Stale/settled guard — the REQUEST state is the lifecycle truth: a real reply
  // (approve/decline/counter) would have cascaded the request off
  // awaiting_colleague AND cleared this timer. So reaching here in any other
  // state, or with no reschedule job, means nothing to re-ask → drop the timer.
  if (row.state !== 'awaiting_colleague' || !job || job.intent !== 'meeting_reschedule') {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'noop';
  }
  const conn = getConnection(profile.user.slack_user_id, 'slack');
  if (!conn) {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'noop';
  }
  // registrar fix (colleague-outreach-not-gated-to-recipient-work-hours-or-week,
  // o#245/o#246) — defer this re-ask to the colleague's own next work-time
  // start rather than firing on the raw +24h timer regardless of their clock.
  const colleagueTz = job!.colleague_tz || profile.user.timezone;
  const gate = isColleagueSendDeferred(colleagueTz);
  if (gate.deferred) {
    updateRequest(row.id, { nextCheckAt: gate.deferredTo, nextCheckHandler: 'reschedule_reask' });
    logger.info('runRescheduleReask — outside colleague work hours, deferring re-ask', {
      requestId: row.id, colleagueTz, deferredTo: gate.deferredTo,
    });
    return 'rearmed';
  }
  let ctx: { meeting_subject?: string; proposed_start?: string } = {};
  try { ctx = job!.context_json ? JSON.parse(job!.context_json) : {}; } catch { /* fall back to generic */ }
  const tz = profile.user.timezone;
  const whenLocal = ctx.proposed_start
    ? DateTime.fromISO(ctx.proposed_start, { zone: tz }).toFormat("EEEE d MMM 'at' HH:mm")
    : 'the new time';
  const subj = ctx.meeting_subject ?? 'the meeting';
  const first = (job!.colleague_name ?? '').split(/\s+/)[0] || 'there';
  const msg = `Hi ${first}, just circling back on "${subj}" — were you able to check on moving it to ${whenLocal}? No rush, just want to lock it in when you can.`;
  if (job!.dm_channel_id) {
    await sendTracked(conn, { channel: job!.dm_channel_id }, msg, { threadTs: job!.dm_message_ts ?? undefined }, 'reschedule_reask re-ping', row.id);
  } else {
    await sendTracked(conn, { dm: job!.colleague_slack_id }, msg, undefined, 'reschedule_reask re-ping', row.id);
  }
  // Re-arm to the NORMAL no-response expiry — guarantees exactly one re-ask and
  // a clean eventual close. Never back to reschedule_reask.
  updateRequest(row.id, {
    nextCheckAt: DateTime.now().plus({ hours: 48 }).toUTC().toISO(),
    nextCheckHandler: 'outreach_expiry',
  });
  logger.info('reschedule_reask — re-pinged colleague once, re-armed to outreach_expiry', {
    requestId: row.id, jobId: job!.id,
  });
  return 'rearmed';
}

/**
 * Outreach awaiting_colleague past window → close as expired + tombstone DM.
 * For await_reply=false outreach this never fires (request goes resolved
 * immediately on send).
 */
async function runOutreachExpiryOrDecision(row: RequestRow, profile: UserProfile): Promise<'closed'> {
  // If colleague meanwhile replied (state changed off awaiting_colleague),
  // this is a stale timer — just clear it.
  if (row.state !== 'awaiting_colleague') {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'closed';
  }
  // outreach-expiry-tombstone-says-never-replied (2026-08-12) — `state` alone
  // can't tell "never replied" apart from "replied once, then went quiet
  // again": a non-decisive reply (coordinator.ts's `continue` branch, and
  // meetingReschedule.ts's "checking" branch) re-arms this same deadline
  // WITHOUT moving state off awaiting_colleague. `phase==='outreach:re_engaged'`
  // is the marker those re-arms stamp; branch the closure copy on it, same
  // principle runExpiry already applies to approvals (#42: pick the copy from
  // the row's actual last-known state, not from kind/deadline alone).
  const repliedThenWentQuiet = row.phase === 'outreach:re_engaged';
  closeRequest({
    id: row.id,
    state: 'expired',
    closureReason: repliedThenWentQuiet ? 'outreach_no_further_response' : 'outreach_no_response',
    closedBy: 'expiry',
  });
  // Owner heads-up so the request appears in next brief with closure context.
  if (row.owner_dm_channel) {
    const conn = getConnection(profile.user.slack_user_id, 'slack');
    if (conn) {
      const targetName = row.target_name ?? 'them';
      const what = repliedThenWentQuiet
        ? `${targetName} replied but never came back with a real answer — I've closed that one out. Tell me if you want to try again.`
        : `${targetName} never replied to the message I sent — I've closed that one out. Tell me if you want to try again.`;
      await sendTracked(
        conn,
        { channel: row.owner_dm_channel },
        what,
        { threadTs: row.owner_dm_thread_ts ?? undefined },
        'runOutreachExpiryOrDecision owner tombstone',
        row.id,
      );
    }
  }
  return 'closed';
}

/**
 * Scheduled outreach fires — actually send the DM now.
 * Outreach skill stamps details.message + target on the in_flight request;
 * here we send and flip state.
 */
async function runSendScheduledOutreach(row: RequestRow, profile: UserProfile): Promise<'closed' | 'rearmed'> {
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  const message = typeof details.message === 'string' ? details.message : row.description ?? row.subject;
  const targetSlackId = row.target_slack_id;
  if (!targetSlackId) {
    closeRequest({ id: row.id, state: 'cancelled', closureReason: 'no_target_slack_id', closedBy: 'system' });
    return 'closed';
  }
  // registrar fix (scheduled-first-outreach-send-not-gated-to-recipient-hours,
  // wf_29a0d866-021) — o#245/o#246 gated the RE-ASK/RE-ENGAGEMENT timers
  // (runRescheduleReask, sendOofReengagement) to the colleague's own work
  // hours+workweek but left this handler — the FIRST send of a scheduled
  // outreach — firing on the raw timer regardless of the colleague's clock.
  // outreach.ts's message_colleague now gates the schedule itself, but a job
  // can still sit here past that check (retry backoff, a stale send_at from
  // before this fix shipped) — re-verify at actual fire time, same as every
  // other colleague-facing send on this spine.
  const job = getOutreachJobByRequestId(row.id);
  const colleagueTz = job?.colleague_tz || profile.user.timezone;
  const gate = isColleagueSendDeferred(colleagueTz);
  if (gate.deferred) {
    updateRequest(row.id, { nextCheckAt: gate.deferredTo, nextCheckHandler: 'send_scheduled_outreach' });
    logger.info('runSendScheduledOutreach — outside colleague work hours, deferring send', {
      requestId: row.id, colleagueTz, deferredTo: gate.deferredTo,
    });
    return 'rearmed';
  }
  try {
    const conn = getConnection(profile.user.slack_user_id, 'slack');
    if (!conn) {
      logger.warn('runSendScheduledOutreach — no Slack connection', { requestId: row.id });
      closeRequest({ id: row.id, state: 'cancelled', closureReason: 'no_slack_connection', closedBy: 'system' });
      return 'closed';
    }

    // registrar fix (scheduled-first-outreach-send-not-gated-to-recipient-
    // hours, wf_29a0d866-021 round 2) — replay the stored decision literally
    // (R2), not a downgraded reconstruction of it. Pre-fix this handler only
    // ever called conn.sendDirect(targetSlackId, message), so a scheduled
    // "post to #product and tag Anna" silently became a private DM once the
    // colleague-hours gate above started pushing more sends through this
    // deferred path, and a scheduled attachment was silently dropped either
    // way — outreach.ts now persists channel_id/channel_name/attachments on
    // the request's details for exactly this replay.
    const channelId = typeof details.channel_id === 'string' ? details.channel_id : undefined;
    const ownerId = profile.user.slack_user_id;
    const MAX_SEND_ATTEMPTS = 3;
    const attempts = (typeof details.send_attempts === 'number' ? details.send_attempts : 0) + 1;
    const attachments = Array.isArray(details.attachments)
      ? details.attachments as Array<{ sourceUrl: string; filename?: string }>
      : undefined;

    if (channelId) {
      const mention = `<@${targetSlackId}>`;
      const outcome = await sendTracked(
        conn,
        { channel: channelId },
        `${mention} ${message ?? ''}`,
        attachments?.length ? { attachments } : undefined,
        'runSendScheduledOutreach channel post',
        row.id,
      );
      if (!outcome.ok) {
        logger.warn('runSendScheduledOutreach — scheduled channel post failed', {
          requestId: row.id, reason: outcome.reason, attempt: attempts, maxAttempts: MAX_SEND_ATTEMPTS,
        });
        if (attempts >= MAX_SEND_ATTEMPTS) {
          closeRequest({ id: row.id, state: 'cancelled', closureReason: 'scheduled_channel_post_failed', closedBy: 'system' });
          return 'closed';
        }
        updateRequest(row.id, {
          details: { ...details, send_attempts: attempts },
          nextCheckAt: DateTime.now().plus({ minutes: 10 * attempts }).toUTC().toISO(),
          nextCheckHandler: 'send_scheduled_outreach',
        });
        return 'rearmed';
      }
      // Channel posts ignore await_reply — same rule as outreach.ts's
      // immediate path (no DM thread to await a reply in).
      logActivity({
        ownerUserId: ownerId,
        kind: 'outreach',
        subkind: 'channel_post',
        subject: `Posted to #${typeof details.channel_name === 'string' ? details.channel_name : channelId} — mentioned ${row.target_name ?? 'colleague'}`,
        initiatedBy: ownerId,
        initiatedByRole: 'owner',
        targetSlackId,
        targetName: row.target_name ?? undefined,
      });
      closeRequest({
        id: row.id,
        state: 'resolved',
        closureReason: 'outreach_sent_scheduled_channel_post',
        closedBy: 'system',
        skipChildren: true,
      });
      return 'closed';
    }

    const res = await sendTracked(
      conn,
      { dm: targetSlackId },
      message ?? '',
      attachments?.length ? { attachments } : undefined,
      'runSendScheduledOutreach DM',
      row.id,
    );
    if (!res.ok) {
      // Same bounded retry as the channel branch above. A soft {ok:false}
      // (deactivated user / DM open failure — sendDM returns it without
      // throwing) must never be treated as sent: pre-fix this proceeded to
      // awaiting_colleague + the 5-day outreach_expiry timer anyway, and days
      // later the owner was told "X never replied to the message I sent"
      // about a message that never went out at all.
      logger.warn('runSendScheduledOutreach — scheduled DM failed', {
        requestId: row.id, reason: res.reason, attempt: attempts, maxAttempts: MAX_SEND_ATTEMPTS,
      });
      if (attempts >= MAX_SEND_ATTEMPTS) {
        closeRequest({ id: row.id, state: 'cancelled', closureReason: 'scheduled_send_failed', closedBy: 'system' });
        return 'closed';
      }
      updateRequest(row.id, {
        details: { ...details, send_attempts: attempts },
        nextCheckAt: DateTime.now().plus({ minutes: 10 * attempts }).toUTC().toISO(),
        nextCheckHandler: 'send_scheduled_outreach',
      });
      return 'rearmed';
    }
    const sentTs = res.ts ?? null;
    // await_reply is stored NUMERIC (0/1) in details, so a bare `!== false` is
    // always true (0 !== false). Treat 0 as fire-and-forget; keep "missing = await".
    const awaitReply = details.await_reply !== false && details.await_reply !== 0;
    updateRequest(row.id, {
      // Fire-and-forget: leave state alone here so closeRequest below owns the
      // terminal 'resolved' write + audit_log row. Setting state:'resolved' here
      // made closeRequest see an already-terminal row and no-op → closed_at/
      // closed_by/closure_reason stayed NULL and no audit was written.
      state: awaitReply ? 'awaiting_colleague' : undefined,
      details: { ...details, sent_at: DateTime.now().toISO(), dm_message_ts: sentTs },
      nextCheckAt: awaitReply
        ? DateTime.now().plus({ days: 5 }).toUTC().toISO()
        : null,
      nextCheckHandler: awaitReply ? 'outreach_expiry' : null,
    });
    if (!awaitReply) {
      // Fire-and-forget — close immediately, no expiry timer needed.
      closeRequest({
        id: row.id,
        state: 'resolved',
        closureReason: 'outreach_sent_fire_and_forget',
        closedBy: 'system',
        skipChildren: true,
      });
      return 'closed';
    }
    return 'rearmed';
  } catch (err) {
    // Bounded retry. Pre-fix this returned 'rearmed' WITHOUT touching
    // next_check_at, so the row kept its past-due time and re-fired every
    // 5-min tick FOREVER on a persistent throw (deactivated user, bad channel,
    // a Slack exception rather than an {ok:false}) — infinite loop + a request
    // that never closes (pollutes the brief). Now: back off and cap. A
    // transient Slack hiccup still recovers (retry); a permanent failure
    // closes after MAX_SEND_ATTEMPTS instead of looping.
    const MAX_SEND_ATTEMPTS = 3;
    const attempts = (typeof details.send_attempts === 'number' ? details.send_attempts : 0) + 1;
    logger.warn('runSendScheduledOutreach — send threw', {
      requestId: row.id, attempt: attempts, maxAttempts: MAX_SEND_ATTEMPTS,
      err: String(err).slice(0, 200),
    });
    if (attempts >= MAX_SEND_ATTEMPTS) {
      closeRequest({ id: row.id, state: 'cancelled', closureReason: 'scheduled_send_failed', closedBy: 'system' });
      return 'closed';
    }
    // Re-arm with linear backoff (10m, 20m), bump the attempt counter.
    updateRequest(row.id, {
      details: { ...details, send_attempts: attempts },
      nextCheckAt: DateTime.now().plus({ minutes: 10 * attempts }).toUTC().toISO(),
      nextCheckHandler: 'send_scheduled_outreach',
    });
    return 'rearmed';
  }
}

/**
 * chris-kelley-oof-block-b round 2 (2026-08-18) — tasks/skill.ts's
 * flagUnresolvedFreeformForOwner's immediate postOwnerDecision attempt failed
 * (thread post AND the DM fallback both failed), so the row landed
 * `in_flight` with this handler armed instead of being born-terminal
 * `logged`. Bounded, SHORT linear backoff (5m, 10m, 15m…) — deliberately NOT
 * workTimeBaseFromNow/nextOwnerWorkdayStart (that would defer an urgent
 * escalation past a whole away period, the exact bug this backstop exists to
 * avoid). Gives up only after FREEFORM_FLAG_MAX_RETRY_ATTEMPTS, closing
 * 'cancelled' — never 'logged' — so a permanently-failed delivery can never
 * read, to getRecentActivityForOwner or a later dedup check
 * (getLatestFreeformOwnerFlag), as though it actually reached him. A
 * 'cancelled' close still lands informed=0, so the next brief gets one more
 * chance to surface it. R3 (2026-08-18) — the give-up path also tells the
 * REQUESTER their backstop flag never landed, mirroring runExpiry's own
 * requester loop-close: they were promised "I've also flagged the raw ask
 * for the owner directly" at raise time, and a silent permanent failure here
 * would leave that promise uncorrected.
 */
const FREEFORM_FLAG_MAX_RETRY_ATTEMPTS = 4;

async function runFreeformFlagRetry(row: RequestRow, profile: UserProfile): Promise<'closed' | 'rearmed'> {
  // Something else already moved this off in_flight (shouldn't happen —
  // nothing else touches this row — but stale-timer safety matches every
  // other handler in this file).
  if (row.state !== 'in_flight') {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return 'closed';
  }
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  const message = typeof details.message === 'string' && details.message
    ? details.message
    : (row.description ?? row.subject);
  const attempts = (typeof details.send_attempts === 'number' ? details.send_attempts : 0) + 1;

  let posted: { ok: boolean; channel?: string; threadTs?: string; ts?: string; reason?: string } = { ok: false };
  try {
    const conn = getConnection(profile.user.slack_user_id, 'slack');
    if (conn) {
      posted = await postOwnerDecision({ profile, conn, text: message, label: 'freeform escalation flag (retry)' });
    }
  } catch (err) {
    logger.warn('runFreeformFlagRetry — retry threw', { requestId: row.id, attempt: attempts, err: String(err).slice(0, 200) });
  }

  if (posted.ok) {
    updateRequest(row.id, {
      ownerDmChannel: posted.channel,
      ownerDmThreadTs: posted.threadTs,
      terminalDmMsgTs: posted.ts,
    });
    closeRequest({
      id: row.id,
      state: 'logged',
      closureReason: 'freeform_escalation_flag_delivered',
      closedBy: 'system',
    });
    logger.info('runFreeformFlagRetry — delivered on retry', { requestId: row.id, attempts });
    return 'closed';
  }

  if (attempts >= FREEFORM_FLAG_MAX_RETRY_ATTEMPTS) {
    logger.error('runFreeformFlagRetry — exhausted retries, giving up (owner never got this flag)', {
      requestId: row.id, attempts,
    });
    closeRequest({
      id: row.id,
      state: 'cancelled',
      closureReason: 'freeform_escalation_flag_delivery_failed',
      closedBy: 'system',
    });
    // R3 — mirror runExpiry's requester loop-close (above). skill.ts's
    // flagUnresolvedFreeformForOwner tells the requester up front "I've also
    // flagged the raw ask for the owner directly as a backstop" — if that
    // backstop itself never reached him after every retry, staying silent
    // here turns that line into an uncorrected false promise (the same harm
    // class gh#194-b-promised-resend-never-fired already ruled on). Language,
    // routing and the notified-stamp ride the one shared relay
    // (requesterRelay.ts) — this was an inline English-only copy.
    if (row.requester_slack_id) {
      await relayClosureToRequester({
        row,
        profile,
        label: 'runFreeformFlagRetry requester loop-close',
        compose: ({ lang, hi, ownerFirst }) => lang === 'he'
          ? `${hi} — סימנתי את הבקשה שלך ל${ownerFirst} כגיבוי, אבל לא הצלחתי להעביר לו אותה גם אחרי כמה ניסיונות. שווה לפנות אליו ישירות אם זה עדיין פתוח.`
          : `${hi} — I flagged your ask for ${ownerFirst} as a backstop, but couldn't actually get it to him after several tries. Worth reaching him directly if it's still open.`,
      });
    }
    return 'closed';
  }

  // Short linear backoff (5m, 10m, 15m) — retries SOON, not after a whole
  // away period. See the header comment above.
  updateRequest(row.id, {
    details: { ...details, send_attempts: attempts },
    nextCheckAt: DateTime.now().plus({ minutes: 5 * attempts }).toUTC().toISO(),
    nextCheckHandler: 'freeform_flag_retry',
  });
  return 'rearmed';
}

/**
 * pre-existing-clobbered-tz-now-locked-wrong-forever (2026-09-02) — the
 * raise/track/resolve half of the TZ-persistence ask, built on top of the
 * detection API db/people.ts owns: `findPersistentUnaskedTimezoneDivergences`
 * finds WHICH streaks have re-confirmed the same differing value, unbroken,
 * across a full TTL window and haven't been asked about yet.
 *
 * R1 — one spine, no second waiting mechanism: this mints an ordinary
 * kind='approval' subkind='timezone_persistence' row (state=awaiting_owner),
 * DM'd through the SAME daily-decision-thread path (postOwnerDecision, R8)
 * every other approval uses. The owner's yes replays deterministically (R2)
 * via the 'promote_timezone_temp' on_approve callback — see
 * approvalCallbacks.ts's RESOLVER_REPLAY_TOOLS and
 * deferredActionReplay.ts's direct db/people.ts branch. A reject / silent
 * expiry needs no further action: `on_reject` is deliberately omitted (the
 * resolver's default is just close + notify-if-requester, and there is no
 * requester here), and `markTimezoneTempAskedById` — called only once
 * delivery is CONFIRMED — already blocks this exact streak from being
 * asked again (db/people.ts's own one-ask-budget contract).
 *
 * Idempotency (R11 — never raise a duplicate): the key is derived from
 * (personId, since, value) — the STREAK itself, not a timestamp — so a crash
 * between raising the row and confirming delivery re-raises onto the SAME
 * row on the next pass (idempotency_key UNIQUE collision → look up and
 * retry delivery) instead of minting a second approval for one streak. A
 * genuinely NEW streak (different `since`, because the value changed or the
 * old streak lapsed) gets its own fresh key by construction.
 *
 * db/people.ts's `timezone_temp` is NOT owner-scoped (single-tenant data
 * model — no owner_user_id column on people_memory), so this raises under
 * whichever profile is loaded first; a later profile in the same pass sees
 * the streak already asked once the first has raised it. Multi-owner
 * colleague-data scoping, if that ever lands, is db/people.ts's (Librarian's)
 * to add — not re-derived here.
 */
const TZ_PERSISTENCE_CHECK_INTERVAL_MS = 60 * 60 * 1000;  // hourly — a 7-day-TTL signal, not a 5-min one
let lastTzPersistenceCheckMs = 0;

async function raiseTimezonePersistenceAsks(profilesByUserId: Map<string, UserProfile>): Promise<void> {
  const now = Date.now();
  if (now - lastTzPersistenceCheckMs < TZ_PERSISTENCE_CHECK_INTERVAL_MS) return;
  lastTzPersistenceCheckMs = now;

  const profile = [...profilesByUserId.values()][0];
  if (!profile) return;
  const ownerUserId = profile.user.slack_user_id;

  let candidates: TimezonePersistenceCandidate[];
  try {
    candidates = findPersistentUnaskedTimezoneDivergences();
  } catch (err) {
    logger.warn('raiseTimezonePersistenceAsks — detection query threw', { err: String(err).slice(0, 200) });
    return;
  }
  if (candidates.length === 0) return;

  const conn = getConnection(ownerUserId, 'slack');
  if (!conn) return;

  for (const c of candidates) {
    try {
      await raiseOneTimezonePersistenceAsk(c, profile, ownerUserId, conn);
    } catch (err) {
      logger.warn('raiseTimezonePersistenceAsks — one candidate threw, continuing', {
        personId: c.personId, err: String(err).slice(0, 200),
      });
    }
  }
}

async function raiseOneTimezonePersistenceAsk(
  c: TimezonePersistenceCandidate,
  profile: UserProfile,
  ownerUserId: string,
  conn: NonNullable<ReturnType<typeof getConnection>>,
): Promise<void> {
  // R4 — unlike create_approval's live-conversation asks (always raised
  // mid-turn, so they're inherently "now"), this is a BACKGROUND sweep that
  // can trip at any hour. Nothing here is urgent (R10 is for alarms; this is
  // its opposite — a routine low-priority FYI), so the raise itself, not just
  // the later midpoint nag, defaults to the owner's own work hours. Nothing
  // is created or marked asked on a skip — the streak stays un-asked and the
  // next hourly pass picks it back up, so it reaches him inside work hours
  // exactly once, never lost.
  const deferMs = Date.parse(workTimeBaseFromNow(profile));
  if (Number.isFinite(deferMs) && deferMs > Date.now() + 60_000) {
    logger.info('raiseTimezonePersistenceAsks — outside owner work hours, deferring this candidate to a later pass', {
      personId: c.personId,
    });
    return;
  }

  const first = (c.name ?? 'They').split(' ')[0];
  const sourceLabel = c.source === 'chat' ? 'Chat messages have' : 'Slack has';
  const sinceDt = DateTime.fromISO(c.since);
  const daysAgo = sinceDt.isValid ? Math.max(1, Math.round(DateTime.now().diff(sinceDt, 'days').days)) : 7;
  const askText = `${sourceLabel} had ${first} on ${c.value} for ${daysAgo} days now — has ${first} actually moved? Say yes to update their stored timezone to ${c.value}; no (or nothing) leaves it as is.`;

  // Streak-scoped key — see the header comment above for why (personId,
  // since, value), never a timestamp.
  const idempotencyKey = buildIdempotencyKey({
    ownerUserId, kind: 'approval', subject: `timezone_persistence ${c.personId} ${c.since} ${c.value}`,
  });

  const callbacks = {
    on_approve: { tool: 'promote_timezone_temp', args: { person_id: c.personId, expected_value: c.value } },
  };

  // Owner-facing decision windows, same convention create_approval raises
  // with (R4 — the midpoint nag defers to his work hours by construction via
  // runApprovalReminder above).
  const base = workTimeBaseFromNow(profile);
  const expiresAt = addWorkdays(base, 2, profile);
  const expiresMs = Date.parse(expiresAt);
  const createdMs = Date.now();
  const midIso = expiresMs > createdMs + 60_000
    ? new Date(createdMs + Math.floor((expiresMs - createdMs) / 2)).toISOString()
    : null;
  const nextCheckAt = midIso ?? expiresAt;
  const nextCheckHandler: NextCheckHandler = midIso ? 'approval_reminder' : 'expiry';

  const requestFields = {
    ownerUserId, initiatedBy: ownerUserId, initiatedByRole: 'system' as const,
    kind: 'approval' as const, subkind: 'timezone_persistence',
    subject: `${first}'s timezone — still ${c.value}?`,
    description: askText,
    state: 'awaiting_owner' as const,
    expiresAt, nextCheckAt, nextCheckHandler,
    details: { question: askText, callbacks },
  };

  let row: RequestRow;
  try {
    row = createRequest({ ...requestFields, idempotencyKey });
  } catch (err) {
    const msg = String(err);
    if (!(msg.includes('UNIQUE constraint failed') && msg.includes('idempotency_key'))) throw err;
    const existing = getRequestByIdempotencyKey(idempotencyKey);
    if (!existing) throw err;  // UNIQUE fired but lookup missed — don't swallow a real bug
    if (existing.terminal_dm_msg_ts) {
      // Already raised AND delivered on an earlier pass — delivery confirmation
      // was the only thing that didn't complete (e.g. a crash right after the
      // DM). Just stamp askedAt now so detection stops resurfacing it.
      markTimezoneTempAskedById(c.personId, c.value);
      return;
    }
    if (existing.state !== 'awaiting_owner' && existing.state !== 'expired') {
      // registrar fix (timezone-ask-revival-corner-nondm-resolution) — a
      // genuine decision (resolved/cancelled) can land on this row through a
      // surface that never touches `terminal_dm_msg_ts` at all: resolve_approval
      // reached directly by request id (e.g. after list_pending_approvals, or
      // Module D's thread-bound auto-resolve) from OUTSIDE this ask's own DM —
      // terminal_dm_msg_ts is stamped only by THIS ask's own delivery
      // (deliverTimezonePersistenceAsk), never by however it was resolved. The
      // owner already got that outcome from whatever closed it; reviving here
      // would ask him again about something he already decided (R3: never
      // twice). Burn the one-ask budget instead — a reject/cancel takes no
      // db/people.ts action, so without this the same still-differing streak
      // would keep re-surfacing as a "fresh" candidate every hourly pass.
      markTimezoneTempAskedById(c.personId, c.value);
      return;
    }
    if (existing.state === 'expired') {
      // The row timed out (generic 'expiry' closure, e.g. its whole 2-workday
      // window elapsed) with delivery never confirmed — nobody was actually
      // asked, so there's no decision pinned to it and resolveRequest refuses
      // any verdict against a non-open row (resolver.ts's `state !==
      // 'awaiting_owner' && state !== 'awaiting_colleague'` guard) — a "yes"
      // replayed against this dead row would resolve nothing. Retire its
      // idempotency key (the dead row keeps its history for audit) and mint
      // a genuinely fresh row for the still-open streak — never retry
      // delivery against a row nobody can ever act on, and never silently
      // burn the one-ask budget for an ask that was never delivered.
      updateRequest(existing.id, { idempotencyKey: `${idempotencyKey}:dead:${existing.id}` });
      const revived = createRequest({ ...requestFields, idempotencyKey });
      await deliverTimezonePersistenceAsk(revived, askText, profile, conn, c);
      return;
    }
    // Row exists, still open, delivery was never confirmed — retry against
    // the SAME row, never mint a second one for this streak.
    await deliverTimezonePersistenceAsk(existing, askText, profile, conn, c);
    return;
  }

  await deliverTimezonePersistenceAsk(row, askText, profile, conn, c);
}

/**
 * Compose (via the ONE shared composer every decision surface uses —
 * approvalCallbacks.ts's composeOwnerAskText) + post +, ONLY once delivery is
 * confirmed, burn the one-ask budget (markTimezoneTempAskedById). A failed
 * post leaves askedAt unset so the next hourly pass retries against this same
 * row (see raiseOneTimezonePersistenceAsk's UNIQUE-collision branch above) —
 * db/people.ts's own contract: "a delivery failure doesn't silently burn the
 * one-ask budget."
 */
async function deliverTimezonePersistenceAsk(
  row: RequestRow,
  askText: string,
  profile: UserProfile,
  conn: NonNullable<ReturnType<typeof getConnection>>,
  candidate: { personId: string; value: string },
): Promise<void> {
  const dmText = await composeOwnerAskText({
    askText, details: parseDetails(row), profile, requestId: row.id,
  });
  const posted = await postOwnerDecision({ profile, conn, text: dmText, label: 'timezone persistence ask' });
  if (!posted.ok) {
    logger.warn('raiseTimezonePersistenceAsks — owner DM failed, will retry next pass', {
      requestId: row.id, reason: posted.reason,
    });
    return;
  }
  updateRequest(row.id, {
    ownerDmChannel: posted.channel, ownerDmThreadTs: posted.threadTs, terminalDmMsgTs: posted.ts,
  });
  markTimezoneTempAskedById(candidate.personId, candidate.value);
  logger.info('raiseTimezonePersistenceAsks — raised + delivered', {
    requestId: row.id, personId: candidate.personId,
  });
}
