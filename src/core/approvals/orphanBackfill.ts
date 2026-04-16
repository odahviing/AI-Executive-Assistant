/**
 * Orphan-coord approval backfill (v1.5.1).
 *
 * Runs once on startup. Finds coord_jobs stuck in `waiting_owner` (and their
 * variants) that were created before the approvals system existed, or whose
 * approval got lost in a previous bug. For each one we can confidently
 * characterize, create a slot_pick (or duration_override) approval so it
 * shows up in the owner's PENDING APPROVALS list on the next DM.
 *
 * Concrete recovery example this is designed to catch: "Yael asked to extend
 * meeting by 30 min, Maelle said 'passed to Idan', Idan never got anything."
 * That coord sits in `waiting_owner` with a `winning_slot` and a duration
 * override in notes, but has no linked approval row. This sweeper backfills.
 *
 * Rule: only backfill when we have enough metadata to reconstruct the ask
 * faithfully. If the coord is too opaque (no subject, no winning_slot, no
 * notes), leave it — better to stay silent than guess wrong.
 */

import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import type { UserProfile } from '../../config/userProfile';
import { getDb } from '../../db/client';
import { createApproval, getPendingApprovalsBySkillRef } from '../../db/approvals';
import type { CoordJob, CoordParticipant } from '../../db/jobs';
import logger from '../../utils/logger';

export async function backfillOrphanApprovals(
  app: App,
  profiles: Map<string, UserProfile>,
): Promise<number> {
  const db = getDb();
  const orphans = db.prepare(`
    SELECT * FROM coord_jobs
    WHERE status = 'waiting_owner'
    AND created_at >= datetime('now', '-14 days')
  `).all() as CoordJob[];

  let backfilled = 0;

  for (const job of orphans) {
    // Skip if an approval already exists for this coord
    const existing = getPendingApprovalsBySkillRef(job.id);
    if (existing.length > 0) continue;

    const profile = [...profiles.values()].find(p => p.user.slack_user_id === job.owner_user_id);
    if (!profile) continue;

    // Find the parent task (skill_ref = job.id)
    const taskRow = db.prepare(
      `SELECT id, owner_channel, owner_thread_ts FROM tasks WHERE skill_ref = ? ORDER BY created_at DESC LIMIT 1`
    ).get(job.id) as { id: string; owner_channel: string; owner_thread_ts: string | null } | undefined;
    if (!taskRow) {
      logger.debug('orphanBackfill — coord has no parent task, skipping', { jobId: job.id });
      continue;
    }

    let notesObj: Record<string, unknown> = {};
    try { notesObj = JSON.parse(job.notes ?? '{}'); } catch (_) {}
    let participants: CoordParticipant[] = [];
    try { participants = JSON.parse(job.participants || '[]'); } catch (_) {}

    // Characterize: what kind of approval?
    const slot = job.winning_slot;
    const subject = job.subject;

    let kind: 'slot_pick' | 'duration_override' | 'freeform';
    let payload: Record<string, unknown>;
    let askText: string;

    if (notesObj.needsDurationApproval && slot) {
      kind = 'duration_override';
      const slotDt = DateTime.fromISO(slot).setZone(profile.user.timezone);
      payload = {
        coord_job_id: job.id,
        subject,
        duration_min: job.duration_min,
        slot,
        reason: 'non-standard duration requested by colleague',
      };
      askText = `Heads up — I had this waiting on your approval: "${subject}" at ${slotDt.toFormat("EEEE, d MMMM 'at' HH:mm")} (${job.duration_min} min). The duration isn't one of your standard lengths. Shall I book it as-is, or adjust?`;
    } else if (slot && subject) {
      kind = 'slot_pick';
      const slotDt = DateTime.fromISO(slot).setZone(profile.user.timezone);
      payload = {
        coord_job_id: job.id,
        subject,
        slots: [{ iso: slot, label: slotDt.toFormat("EEEE, d MMMM 'at' HH:mm") }],
        participants_emails: participants.filter(p => !!p.email).map(p => p.email!),
        duration_min: job.duration_min,
        recovered: true,
      };
      askText = `Heads up — this was pending your confirmation: "${subject}" at ${slotDt.toFormat("EEEE, d MMMM 'at' HH:mm")}. Want me to book it?`;
    } else if (subject) {
      kind = 'freeform';
      payload = { coord_job_id: job.id, subject, question: 'recovered_waiting_owner_no_slot' };
      askText = `Heads up — I had "${subject}" waiting on your call. Want me to keep going with it, or drop it?`;
    } else {
      // Too opaque to reconstruct — leave alone
      logger.debug('orphanBackfill — coord too opaque, leaving', { jobId: job.id });
      continue;
    }

    try {
      const expiresAt = DateTime.now().plus({ hours: 24 }).toUTC().toISO()!;
      const { approval } = createApproval({
        taskId: taskRow.id,
        ownerUserId: job.owner_user_id,
        kind,
        payload,
        skillRef: job.id,
        slackChannel: taskRow.owner_channel,
        slackThreadTs: taskRow.owner_thread_ts ?? undefined,
        expiresAt,
        notes: 'backfilled on startup (pre-v1.5 orphan)',
      });

      // DM the owner with the recovered ask so it doesn't silently sit there.
      // v1.6.2 — no visible ref token appended (see tasks/skill.ts rationale).
      try {
        const res = await app.client.chat.postMessage({
          token: profile.assistant.slack.bot_token,
          channel: taskRow.owner_channel,
          thread_ts: taskRow.owner_thread_ts ?? undefined,
          text: askText,
        });
        if (res.ts) {
          db.prepare(
            `UPDATE approvals SET slack_msg_ts = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(res.ts, approval.id);
        }
      } catch (err) {
        logger.warn('orphanBackfill — failed to DM recovered approval', { err: String(err), jobId: job.id });
      }

      logger.info('orphanBackfill — recovered approval for orphaned waiting_owner coord', {
        jobId: job.id,
        approvalId: approval.id,
        kind,
        subject,
      });
      backfilled++;
    } catch (err) {
      logger.error('orphanBackfill — createApproval threw', { err: String(err), jobId: job.id });
    }
  }

  if (backfilled > 0) {
    logger.info('orphanBackfill — sweep complete', { backfilled });
  }
  return backfilled;
}
