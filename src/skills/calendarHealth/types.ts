/**
 * calendarHealth shared types — the HealthIssue shape produced by the
 * check_calendar_health detector and threaded through the auto-move engines.
 * Moved VERBATIM (interface body byte-for-byte) out of ../calendarHealth.ts;
 * only `export` was added so the sibling modules + handlers can import it.
 */

export interface HealthIssue {
  type:
    | 'missing_floating_block'   // owner-configured block didn't land on the calendar; block_name carries which one (lunch, coffee, gym, thinking time, ...)
    | 'double_booking'
    | 'oof_conflict'
    | 'missing_category'
    | 'category_limit_exceeded'  // v2.6 — per_day or per_week limit on a category violated
    | 'busy_day'                  // v2.1.1 — day exceeds busy thresholds (free-time / count / longest-free-block)
    | 'inefficient_gap';          // #133 — dead gap (6–29 min) between two meetings on a dense-packing day; movable_event_id = the later internal meeting to pull back-to-back
  date: string;
  description: string;
  eventIds?: string[];
  suggestion?: string;
  // v2.6 — for category_limit_exceeded
  category_name?: string;
  rule_broken?: 'per_day' | 'per_week';
  rule_value?: number;
  current_count?: number;
  // v2.5.6 — for busy_day (re-enabled)
  free_minutes?: number;
  longest_gap_minutes?: number;
  threshold_minutes?: number;
  is_office_day?: boolean;
  // v2.1.1 — structured fields used by active-mode fix loop. Optional so
  // older callers / narration paths keep working unchanged.
  block_name?: string;            // for missing_floating_block: which block ('lunch', 'coffee_break', ...)
  internal_only?: boolean;        // for double_booking: every attendee same company domain
  movable_event_id?: string;      // for double_booking: which side is unprotected (4+ attendees / external / matched rule)
  kept_event_id?: string;         // for double_booking: the protected side
  protection_reasons?: string[];  // for double_booking: WHY the kept side is protected (≥4 attendees, external, ...)
  synthetic_id?: string;          // v3.5.x — stable anchor id for day/window-level issues (busy_day) that have no real event_id
  fixed?: boolean;                // set by active-mode loop when Maelle acted on this issue
  fix_detail?: string;            // human-readable one-liner describing the fix applied
  fix_failed?: boolean;           // set when active-mode tried to fix and an error was thrown
  fix_error?: string;
}
