/**
 * Activity revertibility table (gh#52 piece 52-U4a).
 *
 * When the owner says "undo that," Maelle either actually undoes it or tells
 * him plainly she can't and why — never fakes it. This is the DECLARATIVE
 * contract a future revert-tool dispatch reads: per activity kind, is it
 * revertible, for how long, and — when it isn't — the honest refusal to give.
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

export interface ActivityRevertibility {
  revertible: boolean;
  /** How long after the action a revert is still offered. Only meaningful when revertible=true. */
  ttlHours?: number;
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
  // Move / other calendar mutations — revertible, matching the existing
  // auto-move precedent (db/requests.ts's getRevertibleActivity, 12h TTL).
  // The auto-fix engine's own `auto_move` subkind is not a key here — its
  // underlying tool IS `move_meeting` (autoMove.ts's own internalActions
  // record says so), so the revert dispatch looks it up under this key too.
  move_meeting: { revertible: true, ttlHours: 12 },
  create_meeting: { revertible: true, ttlHours: 12 },
  book_floating_block: { revertible: true, ttlHours: 12 },
};
