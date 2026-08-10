/**
 * categoryOps — the `set_event_category` and `manage_calendar_issue` case
 * bodies, extracted VERBATIM from
 * ../../calendarHealth.ts. No logic changes: relative import depth deepened two
 * levels; free vars threaded via OpCtx (each handler destructures only what its
 * body uses).
 */
import { updateMeeting } from '../../../connectors/graph/calendar';
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

        // start_resolve opens a follow_up request before flipping the row
        // so the row carries a request_id back. Other actions just update.
        let requestId: string | undefined;
        if (action === 'start_resolve') {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createRequest } = require('../../../db/requests') as
              typeof import('../../../db/requests');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getCalendarIssueById } = require('../../../db/calendarIssues') as
              typeof import('../../../db/calendarIssues');
            const row = getCalendarIssueById(issueId);
            const subject = row
              ? `Resolve ${row.issue_class}: ${(notes ?? '').slice(0, 60) || row.event_date}`
              : 'Resolve calendar issue';
            const created = createRequest({
              ownerUserId,
              initiatedBy: ownerUserId,
              initiatedByRole: 'owner',
              kind: 'follow_up',
              subkind: 'calendar_fix',
              subject,
              description: `Calendar issue fix — ${row?.issue_class ?? '(unknown class)'} on ${row?.event_date ?? '?'}. ${notes ?? ''}`.trim(),
              state: 'in_flight',
              informed: 1,
              outcomeExternalEventId: row?.event_id,
              details: { calendar_issue_id: issueId, notes },
            });
            requestId = created.id;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { attachRequestToIssue } = require('../../../db/calendarIssues') as
              typeof import('../../../db/calendarIssues');
            attachRequestToIssue(issueId, requestId);
          } catch (err) {
            logger.warn('start_resolve — request creation failed, falling back to status-only', {
              issueId, err: String(err).slice(0, 200),
            });
          }
        }

        const updated = updateCalendarIssueStatus(issueId, newStatus, notes);
        if (!updated) {
          return { error: 'not_found', message: `Issue "${issueId}" not found.` };
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
          start_resolve:      requestId
            ? 'Request opened. Call move_meeting as appropriate; cascade auto-resolves the row on event change.'
            : 'Marked for resolution. Call move_meeting as appropriate.',
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
