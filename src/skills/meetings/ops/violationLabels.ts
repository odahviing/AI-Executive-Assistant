/**
 * Human one-phrase label for a checkSlot/search rejection reason. v2.6.1 —
 * Sonnet pastes it verbatim into create_approval(policy_exception).ask_text so
 * the owner sees "outside your work hours" not a rule code. v2.7.1 — no
 * owner_buffer_collision label (connected back-to-backs are fine). Extracted
 * (v3.7.x) from three identical inline copies in ops.ts.
 */
export function humanizeViolationLabel(reason: string | undefined, ownerFirst: string): string {
  // The walker tags per-attendee rejections as `<reason>:<email>` so day_summary
  // can attribute blame. Strip the suffix (structured string, not natural
  // language) — otherwise every attendee-blamed reason humanized to "unknown",
  // which is exactly the mechanical non-answer M11 forbids.
  const kind = typeof reason === 'string' && reason.includes(':') ? reason.split(':')[0] : reason;
  switch (kind) {
    case 'outside_owner_work_hours': return `outside ${ownerFirst}'s work hours`;
    case 'outside_attendee_work_hours': return `outside the attendee's working hours`;
    case 'attendee_busy_collision': return `an attendee is already booked then`;
    case 'within_lead_time': return `too soon — ${ownerFirst} needs more notice than that`;
    case 'in_the_past': return `that time has already passed`;
    case 'wrong_day_type': return `not the right kind of day for that (${ownerFirst} is not in the office then)`;
    case 'outside_requested_window': return `outside the time window that was asked for`;
    case 'travel_buffer_collision': return `no room for travel time around it`;
    case 'vacation_or_off_day': return `${ownerFirst} is off that day`;
    // D6 — the search's day-level verdict when his own calendar carries an
    // all-day out-of-office. Distinct from owner_busy_collision on purpose: "the
    // whole day is gone" and "that hour clashes" invite completely different
    // next moves from the person reading it.
    case 'owner_out_of_office': return `${ownerFirst} is out of office that whole day`;
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
