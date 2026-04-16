/**
 * Summary sessions (v1.7.2) — meta about the meeting summaries we've drafted.
 *
 * One row per per-thread summary. The big-cost field is `current_draft`
 * (the in-progress JSON summary) — it's nulled at share or after 7 days idle.
 * Everything else is the meta we KEEP for reference: who attended, when, what
 * was the meeting about. Per the design rule, we never store the full final
 * summary text long-term.
 */

import { getDb } from './client';

export type SummaryStage = 'iterating' | 'shared' | 'cancelled';

export interface SummaryAttendee {
  slackId?: string;          // present when matched to a known internal Slack user
  name: string;
  email?: string;
  internal: boolean;         // matches owner's company domain
  source: 'calendar' | 'transcript' | 'owner';   // where this attendee was learned from
}

/** The shape we hold in current_draft while iterating. Never persisted after share. */
export interface SummaryDraft {
  subject: string;
  main_topic: string;
  is_external: boolean;
  attendees: SummaryAttendee[];
  paragraphs: string[];
  action_items: SummaryActionItem[];
  speakers_unresolved?: string[];   // ["Speaker 1", "Speaker 3"] — flagged for owner naming
}

export interface SummaryActionItem {
  assignee_text: string;            // raw label as Sonnet extracted ("Brett", "Speaker 2")
  assignee_slack_id?: string;       // resolved internal Slack ID (null for externals/unmatched)
  assignee_name?: string;
  assignee_internal?: boolean;
  description: string;              // English description of what they committed to
  deadline_iso?: string;            // ISO 8601 if a deadline was extracted
  deadline_label?: string;          // human form: "by tomorrow", "Friday morning"
}

export interface SummarySession {
  id: number;
  created_at: string;
  updated_at: string;
  owner_user_id: string;
  thread_ts: string;
  channel_id: string;
  stage: SummaryStage;
  current_draft: string | null;     // JSON SummaryDraft or null after share
  meeting_date: string | null;
  meeting_time: string | null;
  meeting_subject: string | null;
  main_topic: string | null;
  attendees: string;                // JSON SummaryAttendee[]
  is_external: number;
  transcript_chars: number | null;
  shared_at: string | null;
  shared_to: string | null;         // JSON
}

export function getSummarySessionByThread(threadTs: string): SummarySession | null {
  const db = getDb();
  return db.prepare(`SELECT * FROM summary_sessions WHERE thread_ts = ?`).get(threadTs) as SummarySession | null;
}

export function createSummarySession(params: {
  ownerUserId: string;
  threadTs: string;
  channelId: string;
  draft: SummaryDraft;
  meetingDate?: string;
  meetingTime?: string;
  transcriptChars: number;
}): SummarySession {
  const db = getDb();
  db.prepare(`
    INSERT INTO summary_sessions (
      owner_user_id, thread_ts, channel_id, stage, current_draft,
      meeting_date, meeting_time, meeting_subject, main_topic, attendees, is_external,
      transcript_chars
    ) VALUES (
      @owner_user_id, @thread_ts, @channel_id, 'iterating', @current_draft,
      @meeting_date, @meeting_time, @meeting_subject, @main_topic, @attendees, @is_external,
      @transcript_chars
    )
  `).run({
    owner_user_id: params.ownerUserId,
    thread_ts: params.threadTs,
    channel_id: params.channelId,
    current_draft: JSON.stringify(params.draft),
    meeting_date: params.meetingDate ?? null,
    meeting_time: params.meetingTime ?? null,
    meeting_subject: params.draft.subject ?? null,
    main_topic: params.draft.main_topic ?? null,
    attendees: JSON.stringify(params.draft.attendees ?? []),
    is_external: params.draft.is_external ? 1 : 0,
    transcript_chars: params.transcriptChars,
  });
  return getSummarySessionByThread(params.threadTs)!;
}

/**
 * Replace the existing session's draft (used for both Stage 2 iteration AND
 * for "owner uploaded a corrected summary" override). Updates meta fields
 * derived from the draft so the session record stays consistent.
 */
export function replaceSummaryDraft(threadTs: string, draft: SummaryDraft): void {
  const db = getDb();
  db.prepare(`
    UPDATE summary_sessions
    SET current_draft = @current_draft,
        meeting_subject = @meeting_subject,
        main_topic = @main_topic,
        attendees = @attendees,
        is_external = @is_external,
        updated_at = datetime('now')
    WHERE thread_ts = @thread_ts
  `).run({
    thread_ts: threadTs,
    current_draft: JSON.stringify(draft),
    meeting_subject: draft.subject ?? null,
    main_topic: draft.main_topic ?? null,
    attendees: JSON.stringify(draft.attendees ?? []),
    is_external: draft.is_external ? 1 : 0,
  });
}

/**
 * Override behavior for a NEW transcript in the same thread — different
 * meeting, brand-new draft + transcript size + meeting meta.
 */
export function overrideSummarySessionWithNewTranscript(params: {
  threadTs: string;
  draft: SummaryDraft;
  meetingDate?: string;
  meetingTime?: string;
  transcriptChars: number;
}): void {
  const db = getDb();
  db.prepare(`
    UPDATE summary_sessions
    SET stage = 'iterating',
        current_draft = @current_draft,
        meeting_date = @meeting_date,
        meeting_time = @meeting_time,
        meeting_subject = @meeting_subject,
        main_topic = @main_topic,
        attendees = @attendees,
        is_external = @is_external,
        transcript_chars = @transcript_chars,
        shared_at = NULL,
        shared_to = NULL,
        updated_at = datetime('now')
    WHERE thread_ts = @thread_ts
  `).run({
    thread_ts: params.threadTs,
    current_draft: JSON.stringify(params.draft),
    meeting_date: params.meetingDate ?? null,
    meeting_time: params.meetingTime ?? null,
    meeting_subject: params.draft.subject ?? null,
    main_topic: params.draft.main_topic ?? null,
    attendees: JSON.stringify(params.draft.attendees ?? []),
    is_external: params.draft.is_external ? 1 : 0,
    transcript_chars: params.transcriptChars,
  });
}

/**
 * Mark session as shared and clear the ephemeral draft (per the persistence rule:
 * keep meta for reference, never the full summary).
 */
export function markSummaryShared(params: {
  threadTs: string;
  sharedTo: Array<{ type: 'user' | 'channel' | 'mpim'; id: string; name: string }>;
}): void {
  const db = getDb();
  db.prepare(`
    UPDATE summary_sessions
    SET stage = 'shared',
        current_draft = NULL,
        shared_at = datetime('now'),
        shared_to = @shared_to,
        updated_at = datetime('now')
    WHERE thread_ts = @thread_ts
  `).run({
    thread_ts: params.threadTs,
    shared_to: JSON.stringify(params.sharedTo),
  });
}

/**
 * Cleanup hook: any session in 'iterating' state that hasn't moved in 7+ days
 * gets its draft nulled (still keeps the meta row for historical reference).
 * Call on startup; no need to schedule its own timer.
 */
export function purgeIdleSummaryDrafts(): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE summary_sessions
    SET current_draft = NULL,
        stage = CASE WHEN stage = 'iterating' THEN 'cancelled' ELSE stage END,
        updated_at = datetime('now')
    WHERE current_draft IS NOT NULL
      AND updated_at <= datetime('now', '-7 days')
  `).run();
  return result.changes;
}

export function parseDraft(session: SummarySession): SummaryDraft | null {
  if (!session.current_draft) return null;
  try {
    return JSON.parse(session.current_draft) as SummaryDraft;
  } catch {
    return null;
  }
}
