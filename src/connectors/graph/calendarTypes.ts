// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay: boolean;
  importance: string;
  showAs?: 'free' | 'busy' | 'tentative' | 'oof' | 'workingElsewhere' | 'unknown';
  sensitivity?: 'normal' | 'personal' | 'private' | 'confidential';
  categories?: string[];
  organizer?: { emailAddress: { name: string; address: string } };
  attendees?: Array<{ emailAddress: { name: string; address: string }; status: { response: string } }>;
  isCancelled: boolean;
  isOnlineMeeting: boolean;
  onlineMeetingUrl?: string;
  // Graph's location object. displayName is the user-facing string (e.g.
  // "Idan Office", "Meeting Room", "Reflectiz HQ — Shoham 5"). When
  // isOnlineMeeting=true AND location.displayName is set, the meeting is
  // hybrid (physical room + Teams link). Brief/render code reads this to
  // narrate the physical location instead of defaulting to "Online".
  location?: { displayName?: string };
  bodyPreview?: string;
  // v1.8.8 — recurring-event metadata. type='seriesMaster' = the series root
  // (mutations affect every occurrence — don't touch). 'occurrence' = one
  // instance of a recurring series. 'exception' = an already-customized
  // occurrence. 'singleInstance' = ordinary non-recurring event.
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  seriesMasterId?: string;
}

export interface FreeBusySlot {
  start: string;
  end: string;
  status: 'free' | 'busy' | 'tentative' | 'oof' | 'workingElsewhere' | 'unknown';
  // Explicit IANA zone the start/end strings are expressed in. Set by
  // parseGraphFreeBusySlot. Without this annotation, downstream consumers
  // (Sonnet via get_free_busy, util code) silently treat raw Graph strings
  // as if they were already local — which has bitten us repeatedly when an
  // attendee in another zone is read as if their busy block were in the
  // owner's zone.
  _timezone?: string;
}

export interface CreatedMeeting {
  id: string;
  joinUrl?: string;            // Teams join URL when isOnline=true
}

export interface CreateMeetingParams {
  subject: string;
  start: string;
  end: string;
  attendees: Array<{ name: string; email: string; optional?: boolean }>;
  body?: string;
  isOnline?: boolean;         // true = generate Teams meeting link
  location?: string;          // display name e.g. "Idan's office", "Meeting Room"
  onlineMeetingProvider?: 'teamsForBusiness' | 'skypeForBusiness';
  categories?:  string[];     // Outlook category names, e.g. ["Meeting"] or ["Physical"]
  sensitivity?: 'normal' | 'personal' | 'private' | 'confidential';
  // All-day events. Graph requires isAllDay=true with start/end anchored to
  // midnight of consecutive days in the user's timezone (00:00 both ends;
  // end is the day AFTER). Pre-this change callers had no way to set this
  // and any "all day" attempt landed as a 0-min event at midnight. Default
  // false — only set true when owner explicitly asks for a full-day event.
  // showAs is intentionally not exposed for normal MEETINGS: every meeting
  // Maelle books is busy by default (owner direction). It IS settable for the
  // TIMED optional-join (soft) event that uses showAs='workingElsewhere'.
  // Omit → Graph default (busy).
  showAs?: 'free' | 'busy' | 'tentative' | 'oof' | 'workingElsewhere';
  isAllDay?: boolean;
  userEmail: string;
  timezone: string;
  // v2.3.1 (B23) — when `body` is not provided, the default attribution line
  // names this assistant + owner instead of "your executive assistant".
  // E.g. "Maelle, Idan Assistant". Pass `${assistant.name}, ${owner first name} Assistant`
  // from the call site where profile is in scope. When omitted, falls back to
  // the legacy generic line for back-compat.
  defaultBodyAuthor?: string;
}

/**
 * Meeting mode (v1.6.4) — steers the slot search.
 *   in_person : office days only (physical meetings require an office day).
 *   online    : any work day (office or home); day-type is irrelevant.
 *   either    : any work day; results tagged with day_type so the caller can
 *               narrate "Monday in your office or Tuesday from home online."
 *   custom    : venue-driven (client site, offsite, external meeting link).
 *               Caller MUST pass travelBufferMinutes; we pad slots on both
 *               sides so a 1h-drive meeting doesn't crash into the next event.
 *               day_type is returned but the caller usually asks the owner
 *               which day to pick since the venue drives it.
 */
export type MeetingMode = 'in_person' | 'online' | 'either' | 'custom';

export interface UpdateMeetingParams {
  userEmail: string;
  meetingId: string;
  timezone: string;
  subject?: string;
  start?: string;
  end?: string;
  body?: string;
  categories?: string[];
  // v2.7.0 — optional location + isOnline. Lets move_meeting flip the
  // location when a move crosses day-type (office↔home). Pass-through to
  // Graph PATCH; when omitted, the event's existing location/isOnlineMeeting
  // are preserved.
  location?: string;
  isOnline?: boolean;
  // v2.9.1 — optional full attendee list. When provided, Graph PATCH replaces
  // the event's attendees array. Caller is responsible for assembling the
  // FINAL list (existing - removed + added) before passing — Graph does not
  // diff. Omit entirely to leave attendees untouched.
  attendees?: Array<{ name?: string; email: string; optional?: boolean }>;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'start_drift'; got?: string; expected?: string };
