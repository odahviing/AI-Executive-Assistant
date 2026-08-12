/**
 * Activity revertibility table (gh#52 piece 52-U4a).
 *
 * When the owner says "undo that," Maelle either actually undoes it or tells
 * him plainly she can't and why — never fakes it. This is the DECLARATIVE
 * contract a future revert-tool dispatch reads: per activity kind, is it
 * revertible, which field says whether the event it acted on is still ahead
 * of now, and — when it isn't revertible at all — the honest refusal to give.
 *
 * Nothing in this file executes a revert. The calendar-side wiring (52-U3 /
 * 52-U4b) and the eventual revert tool dispatch are later work (Matchmaker).
 * This table is only what those consult.
 *
 * Keys are the underlying TOOL that ran (the same names RESOLVER_REPLAY_TOOLS
 * and executed.tool already use — approvals/approvalCallbacks.ts,
 * core/requests/resolver.ts) — never the request `kind`/`subkind` logActivity
 * writes, since one logged approval can replay any one of several tools.
 *
 * `research` is deliberately NOT a key here at all — owner ruling: "it's only
 * data in the end, we have nothing to revert — it should only be tools that
 * are changing something you'd want to un-change." A lookup miss for a
 * research activity must read as "not applicable", never as a refusal.
 */

import { DateTime } from 'luxon';

export interface ActivityRevertibility {
  revertible: boolean;
  /**
   * Owner ruling 2026-08-12 (revert-intent-and-single-step-undo-scope) —
   * eligibility is about RELEVANCE, not age: a future meeting is worth
   * correcting no matter how long ago the mistake happened; an already-passed
   * meeting is not worth touching no matter how recently the mistake was
   * made. This names which outcome_json field on the logged activity row
   * holds the event's CURRENT start (after whatever change the activity
   * made) — the one value checked against "now". Required when
   * revertible=true; unused otherwise. Superseded the old ttlHours
   * (time-since-action) gate outright — there is no longer a fixed window.
   */
  currentStartField?: string;
  /** What to tell the owner when he asks to undo a non-revertible action. */
  refusalText?: string;
}

export const ACTIVITY_REVERTIBILITY: Record<string, ActivityRevertibility> = {
  // Graph's cancel already emails every attendee (connectors/graph/calendarMutations.ts)
  // — putting the meeting back is not an undo, it's a second, different action
  // (owner ruling, 2026-07-29: a reverted cancellation is not an undo).
  delete_meeting: {
    revertible: false,
    refusalText: "I can't put that one back — everyone already got the cancellation. I can book a new one at the same time if you want.",
  },
  // Move / other calendar mutations — revertible, gated on whether the event
  // is still ahead of now (see currentStartField above), never on the age of
  // the action itself. The auto-fix engine's own `auto_move` subkind is not a
  // key here — its underlying tool IS `move_meeting` (autoMove.ts's own
  // internalActions record says so, and its own outcome_json uses the same
  // `new_start` field name), so the revert dispatch looks it up under this
  // key too.
  move_meeting: { revertible: true, currentStartField: 'new_start' },
  create_meeting: { revertible: true, currentStartField: 'start' },
  book_floating_block: { revertible: true, currentStartField: 'start' },
};

/**
 * Owner ruling 2026-08-12 — the event-date eligibility check itself. Reads
 * `rule.currentStartField` off `outcomeJson` (an offsetless OWNER-LOCAL clock
 * string per the tool schemas that write it — moveMeeting.ts/createMeeting.ts's
 * own logActivity calls — never UTC, so it's anchored in `ownerTimezone`, the
 * same move calendarReads.ts's own revert dispatch already makes for this
 * exact field) and compares it to now. Missing/unparseable reads as "can't
 * prove it already passed" → still eligible, so a malformed or pre-existing
 * row still reaches the revert dispatch's own record-completeness checks
 * instead of being silently swallowed here.
 */
export function isEventStillUpcoming(
  revKey: string,
  outcomeJson: Record<string, unknown>,
  ownerTimezone: string,
): boolean {
  const field = ACTIVITY_REVERTIBILITY[revKey]?.currentStartField;
  if (!field) return true;
  const raw = outcomeJson[field];
  if (typeof raw !== 'string') return true;
  const dt = DateTime.fromISO(raw, { zone: ownerTimezone });
  if (!dt.isValid) return true;
  return dt > DateTime.now();
}
