/**
 * Coord booking handler registry.
 *
 * Breaks the circular core→skill import that would otherwise appear:
 *   - The resolver (core/approvals/resolver.ts) needs to book a coord when
 *     the owner approves a slot_pick.
 *   - The booking logic lives in skills/meetings/coord/booking.ts.
 *   - core/ importing from skills/ would invert the layer dependency.
 *
 * Instead MeetingsSkill registers its booking handler here at skill load
 * (skills/meetings.ts loader()). The resolver then calls `getCoordBookingHandler()`
 * and invokes the handler if present. Skills subscribe, core publishes.
 *
 * If no handler is registered (e.g. MeetingsSkill disabled in the profile),
 * the resolver logs and returns ok:false — booking can't happen anyway
 * without the skill.
 */

import type { UserProfile } from '../../config/userProfile';

export type CoordBookingHandler = (args: {
  jobId: string;
  chosenSlotIso: string;
  profile: UserProfile;
  synchronous?: boolean;
}) => Promise<{
  ok: boolean;
  reason?: string;
  status?: string;
  subject?: string;
  slot?: string;
}>;

let handler: CoordBookingHandler | null = null;

export function registerCoordBookingHandler(h: CoordBookingHandler): void {
  handler = h;
}

export function getCoordBookingHandler(): CoordBookingHandler | null {
  return handler;
}
