/**
 * Shared context threaded from SchedulingSkill.executeToolCall into the
 * extracted per-tool handlers (pass B). Captures exactly the free variables the
 * case bodies read that are NOT module imports or the `args` param:
 *   - context: the SkillContext param
 *   - userEmail / timezone: destructured from context.profile.user at the top of
 *     executeToolCall (indexed-access types keep them identical to the source).
 * No `self: this` — no case body references `this`.
 */
import type { SkillContext } from '../../../types';
import type { BookingRequest } from '../../bookingRequest';

export interface OpCtx {
  context: SkillContext;
  userEmail: SkillContext['profile']['user']['email'];
  timezone: SkillContext['profile']['user']['timezone'];
  /**
   * gh#154-R3 (2026-08-06) — `grantRelaxed(args, context)`'s result, computed ONCE
   * by `SchedulingSkill.executeToolCall` (the same call it needs for its own
   * room-bend disclosure chokepoint) and threaded down so
   * `handleFindAvailableSlots` reads it here instead of calling
   * `grantRelaxed` a second time — that second call was harmless
   * (deterministic given the same args/context) but logged its own
   * DENIED/owner_room_bend line a second time per turn. Only ever set for
   * `find_available_slots`; every other handler ignores it.
   */
  relaxedGrant?: { relaxed: boolean; relaxedReason: BookingRequest['relaxedReason'] };
}
