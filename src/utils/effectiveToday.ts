/**
 * Owner's effective "today" anchor.
 *
 * When the owner is up past midnight (late-night work, night shift), their
 * mental "today" is still the prior calendar day — the workday they haven't
 * finished yet — and "tomorrow" is the day they're heading into. Without
 * this shift, "calendar for tomorrow" at 00:48 would resolve to two days
 * ahead of where the owner thinks he is.
 *
 * Cutoff lives in yaml at `schedule.day_boundary_hour` ("HH:MM"). Default
 * "00:00" means no shift (real midnight is the day boundary). Idan's
 * profile sets "05:00".
 *
 * Used by:
 *   - `core/orchestrator/systemPrompt.ts` to anchor the DATE LOOKUP table
 *   - `utils/dateVerifier.ts` for `buildLookup` and the LLM context pass
 *
 * Both must agree, otherwise the verifier flags Maelle's correct answers
 * as wrong (real bug — surfaced 2026-04-30 at 00:47).
 */

import { DateTime } from 'luxon';
import type { UserProfile } from '../config/userProfile';

/**
 * Returns the owner's effective "today" — start-of-day in their timezone,
 * shifted back one calendar day when the local clock is before
 * `schedule.day_boundary_hour`.
 */
export function getEffectiveToday(profile: UserProfile): DateTime {
  const tz = profile.user.timezone;
  const cutoff = profile.schedule.day_boundary_hour ?? '00:00';
  const [h, m] = cutoff.split(':').map(n => parseInt(n, 10));
  const cutoffMin = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);

  const now = DateTime.now().setZone(tz);
  const nowMin = now.hour * 60 + now.minute;

  if (cutoffMin > 0 && nowMin < cutoffMin) {
    return now.minus({ days: 1 }).startOf('day');
  }
  return now.startOf('day');
}
