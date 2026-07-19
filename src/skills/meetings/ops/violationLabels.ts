/**
 * Human one-phrase label for a checkSlot/search rejection reason. v2.6.1 —
 * Sonnet pastes it verbatim into create_approval(policy_exception).ask_text so
 * the owner sees "outside your work hours" not a rule code. v2.7.1 — no
 * owner_buffer_collision label (connected back-to-backs are fine). Extracted
 * (v3.7.x) from three identical inline copies in ops.ts.
 */
export function humanizeViolationLabel(reason: string | undefined, ownerFirst: string): string {
  switch (reason) {
    case 'outside_owner_work_hours': return `outside ${ownerFirst}'s work hours`;
    case 'outside_attendee_work_hours': return `outside the attendee's working hours`;
    case 'owner_busy_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
    // legacy label name kept as alias in case any older diagnostics path still emits it
    case 'owner_busy_or_buffer_collision': return `conflicts with another meeting on ${ownerFirst}'s calendar`;
    case 'overlaps_meeting_being_moved': return `overlaps the meeting being moved`;
    case 'focus_time_office': return `would leave ${ownerFirst} under the free-time floor (office day)`;
    case 'focus_time_home': return `would leave ${ownerFirst} under the free-time floor (home day)`;
    case 'floating_block_no_room': return `would leave no room for one of ${ownerFirst}'s daily blocks (lunch / break / etc.)`;
    case 'category_day_type': return `wrong day type for this category (e.g. office-only category on a home day)`;
    case 'category_per_day': return `over ${ownerFirst}'s per-day limit for this category`;
    case 'category_per_week': return `over ${ownerFirst}'s per-week limit for this category`;
    default: return 'unknown';
  }
}
