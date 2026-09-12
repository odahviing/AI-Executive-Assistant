/** Category updates and owner-scoped calendar issue transitions. */
import { updateMeeting } from '../../../connectors/graph/calendar';
import { DateTime } from 'luxon';
import {
  auditLog,
  axisFor,
  getActiveCalendarIssues,
  resolveCalendarIssuesForMeeting,
  updateCalendarIssueStatus,
  type IssueStatus,
} from '../../../db';
import logger from '../../../utils/logger';
import type { OpCtx } from './context';

export async function handleSetEventCategory(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { profile, userEmail, timezone } = ctx;
        const eventId = args.event_id as string;
        const categories = args.categories as string[];

        try {
          await updateMeeting({
            userEmail,
            meetingId: eventId,
            timezone,
            categories,
          });

          // #148 — the ANSWER closes the QUESTION, here, at the one place that
          // knows the category actually landed on Graph. Health writes a
          // `missing_category` row (status awaiting_owner) for every event it had
          // to ask about; without this the row stayed open after the owner
          // answered, and buildTurnContext kept injecting it as an outstanding
          // question for the next 6 hours — so Maelle asked again. That "asked
          // again without remembering" is the second half of #148, and no prompt
          // wording fixes it while the state still says the question is open.
          // Class-scoped: a live overlap / busy_day row on the same event stays
          // open, because a category answer says nothing about a clash.
          let closedIssueRows = 0;
          try {
            closedIssueRows = resolveCalendarIssuesForMeeting(profile.user.slack_user_id, eventId, {
              onlyClass: 'missing_category',
              note: ` [answered: category set to ${categories.join(', ')}]`,
            });
            if (closedIssueRows > 0) {
              logger.info('set_event_category — category question closed', {
                eventId, categories, closedIssueRows,
              });
            }
          } catch (err) {
            // Non-fatal: the category IS set. Worst case the row auto-stales on
            // the next health pass (the event no longer lacks a category).
            logger.warn('set_event_category — could not close the missing_category row', {
              eventId, err: String(err).slice(0, 200),
            });
          }

          return {
            updated: true,
            event_id: eventId,
            categories,
            /** #148 — >0 means this call ANSWERED an open category question, so
             *  the reply confirms the answer instead of re-asking. */
            answered_open_question: closedIssueRows > 0,
            message: `Categories set to: ${categories.join(', ')}`,
          };
        } catch (err) {
          logger.error('Calendar health: failed to set category', { err, eventId });
          return { error: `Failed to update event category: ${String(err)}` };
        }
}

export async function handleManageCalendarIssue(args: Record<string, unknown>, ctx: OpCtx): Promise<unknown | null> {
  const { profile, timezone } = ctx;
        const action = String(args.action ?? '').toLowerCase();
        const issueId = args.issue_id as string | undefined;
        const notes = args.notes as string | undefined;
        const ownerUserId = profile.user.slack_user_id;

        if (action === 'list') {
          const rows = getActiveCalendarIssues(ownerUserId);
          return {
            issues: rows,
            count: rows.length,
            summary: rows.length === 0
              ? 'No outstanding calendar issues.'
              : `${rows.length} active issue(s) need attention.`,
          };
        }

        // v3.0.6 — preemptive approve for floating-block gaps. When owner
        // waives a gap in conversation ("no lunch tomorrow — Natan meeting
        // includes it"), Maelle calls approve with date + block_name and we
        // insert a terminal row directly. Tomorrow's check_calendar_health
        // sees the matching synthetic event_id in upsertCluster, returns
        // 'suppressed', and the gap doesn't re-narrate. Path closed without
        // first having to materialize the issue row via check_calendar_health.
        if (action === 'approve' && !issueId) {
          const date = (args.date as string | undefined)?.trim();
          const blockName = (args.block_name as string | undefined)?.trim();
          if (!date || !blockName) {
            return {
              error: 'missing_args',
              message: `'approve' needs either issue_id OR (date + block_name) to preemptively dismiss a floating-block gap.`,
            };
          }
          const fbs = profile.meetings.floating_blocks ?? [];
          const idx = fbs.findIndex(b => b.name === blockName);
          if (idx === -1) {
            return {
              error: 'unknown_block',
              message: `block_name="${blockName}" not in profile.meetings.floating_blocks. Known: ${fbs.map(b => b.name).join(', ') || '(none configured)'}`,
            };
          }
          // v3.1.7 / #119 — synthetic id via the single-source helper (same
          // formula the detector + delete→dismiss paths use, so the terminal
          // row this writes actually matches what detection later looks up).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { floatingBlockSyntheticEventId } = require('../../../utils/floatingBlocks') as typeof import('../../../utils/floatingBlocks');
          const synth = floatingBlockSyntheticEventId(profile, blockName, date, timezone);
          if (!synth) {
            return { error: 'bad_date', message: `date="${date}" is not a valid YYYY-MM-DD.` };
          }
          const syntheticEventId = synth.eventId;
          const eventEndMs = synth.eventEndMs;

          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getDb } = require('../../../db') as typeof import('../../../db');
          const db = getDb();
          const existing = db.prepare(
            `SELECT id FROM calendar_issues WHERE owner_user_id = ? AND event_id = ?`,
          ).get(ownerUserId, syntheticEventId) as { id: string } | undefined;

          if (existing) {
            db.prepare(`
              UPDATE calendar_issues
              SET status = 'approved',
                  notes = COALESCE(?, notes),
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(notes ?? null, existing.id);
          } else {
            const id = `ci_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            db.prepare(`
              INSERT INTO calendar_issues
                (id, owner_user_id, event_id, peer_event_id, event_date, event_end_ms,
                 issue_class, axis, status, notes, request_id)
              VALUES (?, ?, ?, NULL, ?, ?, 'missing_floating_block', ?, 'approved', ?, NULL)
            `).run(id, ownerUserId, syntheticEventId, date, eventEndMs, axisFor('missing_floating_block'), notes ?? null);
          }

          auditLog({
            ownerUserId,
            action: 'manage_calendar_issue',
            source: 'calendar_health',
            actor: profile.user.name,
            details: { action: 'approve', method: 'preemptive', date, block_name: blockName, synthetic_event_id: syntheticEventId, notes },
            outcome: 'success',
          });

          return {
            ok: true,
            method: 'preemptive_approve',
            synthetic_event_id: syntheticEventId,
            message: `${blockName} gap on ${date} marked approved — future detection will suppress.`,
          };
        }

        // All other non-list actions need issue_id.
        if (!issueId) {
          return { error: 'issue_id_required', message: `${action} requires issue_id. Get it from manage_calendar_issue(list) or check_calendar_health.` };
        }

        // Map action → status. Reject unknown actions.
        const statusByAction: Record<string, IssueStatus> = {
          approve:            'approved',
          start_resolve:      'in_progress',
          owner_will_resolve: 'owner_side',
          owner_done:         'resolved',
        };
        const newStatus = statusByAction[action];
        if (!newStatus) {
          return { error: 'bad_action', message: `manage_calendar_issue action must be 'list' | 'approve' | 'start_resolve' | 'owner_will_resolve' | 'owner_done', got "${action}".` };
        }

        // IDs are global; authorize the loaded row before creating requests,
        // attaching them, changing status, or disclosing its contents.
        const { getCalendarIssueById, attachRequestToIssue } = require('../../../db/calendarIssues') as typeof import('../../../db/calendarIssues');
        const row = getCalendarIssueById(issueId);
        if (!row || row.owner_user_id !== ownerUserId) {
          return { error: 'not_found', message: `Issue "${issueId}" not found.` };
        }
        if (action === 'start_resolve' && ['approved', 'dismissed', 'resolved'].includes(row.status)) {
          return { error: 'issue_closed', message: 'This issue is already closed; no new resolution request was opened.' };
        }

        // Reuse one owned tracker, with the existing 24h expiry used by owner
        // calendar work. Persist request, attachment and status atomically.
        let requestId: string | undefined;
        const { getDb } = require('../../../db') as typeof import('../../../db');
        const { createRequest, getRequest, getRequestByIdempotencyKey, updateRequest } = require('../../../db/requests') as typeof import('../../../db/requests');
        const { closeRequest } = require('../../../core/requests/closeRequest') as typeof import('../../../core/requests/closeRequest');
        try {
          getDb().transaction(() => {
            const key = `calendar_fix:${ownerUserId}:${issueId}`;
            const linked = row.request_id ? getRequest(row.request_id) : null;
            const existing = linked ?? getRequestByIdempotencyKey(key);
            const existingIssueId = existing?.details_json
              ? (JSON.parse(existing.details_json) as { calendar_issue_id?: string }).calendar_issue_id
              : undefined;
            if (existing && (existing.owner_user_id !== ownerUserId || existing.kind !== 'follow_up' || existing.subkind !== 'calendar_fix'
                || existing.outcome_external_event_id !== row.event_id || existingIssueId !== issueId)) {
              throw new Error('The linked resolution request does not match this issue.');
            }
            const open = existing && ['awaiting_owner', 'awaiting_colleague', 'in_flight'].includes(existing.state);
            if (action === 'start_resolve') {
              if (existing && !open) throw new Error('The earlier resolution request is closed; no duplicate request was opened.');
              if (existing && (!existing.next_check_at || !existing.next_check_handler)) {
                // Repair a legacy timerless tracker without extending its life.
                const createdAt = DateTime.fromSQL(existing.created_at, { zone: 'UTC' });
                const bound = existing.expires_at ?? (createdAt.isValid ? createdAt.plus({ hours: 24 }).toUTC().toISO() : null);
                if (!bound) throw new Error('The earlier request has no valid creation time for its expiry.');
                updateRequest(existing.id, { expiresAt: bound, nextCheckAt: bound, nextCheckHandler: 'expiry' });
              }
              const expiry = DateTime.now().plus({ hours: 24 }).toUTC().toISO()!;
              const created = existing ?? createRequest({
              ownerUserId,
              initiatedBy: ownerUserId,
              initiatedByRole: 'owner',
              kind: 'follow_up',
              subkind: 'calendar_fix',
              subject: `Resolve ${row.issue_class}: ${(notes ?? '').slice(0, 60) || row.event_date}`,
              description: `Calendar issue fix — ${row.issue_class} on ${row.event_date}. ${notes ?? ''}`.trim(),
              state: 'in_flight',
              informed: 1,
              outcomeExternalEventId: row.event_id,
              details: { calendar_issue_id: issueId, notes },
              idempotencyKey: key,
              ownerDmChannel: ctx.context.channelId,
              originChannel: ctx.context.channelId,
              originThreadTs: ctx.context.threadTs,
              expiresAt: expiry,
              nextCheckAt: expiry,
              nextCheckHandler: 'expiry',
            });
            requestId = created.id;
            attachRequestToIssue(issueId, requestId);
            } else if (open) {
              const closed = closeRequest({ id: existing.id,
                state: action === 'owner_done' ? 'resolved' : 'cancelled',
                closureReason: `calendar_issue_${action}`, closedBy: 'owner',
              });
              if (!closed.ok) throw new Error('Could not close the linked resolution request.');
            }
            if (!updateCalendarIssueStatus(issueId, newStatus, notes)) throw new Error('Calendar issue no longer exists.');
          })();
        } catch (err) {
          logger.warn('manage_calendar_issue — transition failed', { issueId, err: String(err).slice(0, 200) });
          return { error: 'transition_failed', message: String(err).slice(0, 200) };
        }

        auditLog({
          ownerUserId,
          action: 'manage_calendar_issue',
          source: 'calendar_health',
          actor: profile.user.name,
          details: { issueId, action, newStatus, notes, requestId },
          outcome: 'success',
        });

        const messageByAction: Record<string, string> = {
          approve:            'Issue acknowledged — won\'t be flagged again.',
          start_resolve:      'Resolution request is open. Call move_meeting as appropriate; cascade auto-resolves the row on event change.',
          owner_will_resolve: 'Marked owner_side — waiting on you to handle.',
          owner_done:         'Issue resolved.',
        };

        return {
          updated: true,
          issue_id: issueId,
          status: newStatus,
          request_id: requestId,
          message: messageByAction[action],
        };
}
