/**
 * Shared calendar-listing format rule.
 *
 * Same format whether the owner asks for today's brief, "tomorrow", "next
 * week", or a single weekday. Lives here so the morning-brief prompt
 * (`tasks/briefs.ts`) and the orchestrator's meetings prompt
 * (`skills/meetings.ts`) cite identical wording — image-2 prose drift was
 * a "format rule lived in only one path" bug.
 */
export function calendarListingFormatRule(firstName: string): string {
  return `CALENDAR LISTING FORMAT — same shape for daily brief, "tomorrow", "next week", or any specific day:
- One line per meeting: time, subject, key attendee(s), location/online tag. No prose paragraphs that group multiple meetings.
- Multi-day listings get a date header line per day (e.g. "Sunday 3 May (home day)") followed by the per-meeting lines for that day. Same per-line format every day, regardless of range.
- No editorialization around the listing. Never "your window is X" / "it's a short day" / "you finish at Y" / "busiest day of the week" / "I'd recommend booking one" / "good morning with three solid meetings" / "well structured". ${firstName} already knows the shape of his own schedule — describing it back to him in adjectives is noise.
- Skip events tagged \`is_floating_block\` (lunch / coffee / gym / etc — personal protected time) and other short personal blocks UNLESS they are the only items on the day.
- Issues / suggestions / questions go on a SEPARATE line after the listing — not woven into individual event lines. Example: "No lunch block today — want me to squeeze one in?" goes on its own line after the meeting list, not inside it.`;
}
