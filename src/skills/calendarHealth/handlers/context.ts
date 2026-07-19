/**
 * Shared context threaded from CalendarHealthSkill.executeToolCall into the
 * extracted per-tool handlers. Captures exactly the free variables the case
 * bodies read that are NOT module imports or the `args` param:
 *   - context: the SkillContext param
 *   - self:    the CalendarHealthSkill instance (check_calendar_health re-dispatches
 *              book_floating_block via self.executeToolCall — was `this`)
 *   - profile / userEmail / timezone: destructured from context at the top of
 *     executeToolCall (identical values, threaded so bodies stay verbatim).
 */
import type { SkillContext } from '../../types';
import type { UserProfile } from '../../../config/userProfile';
import type { CalendarHealthSkill } from '../../calendarHealth';

export interface OpCtx {
  context: SkillContext;
  self: CalendarHealthSkill;
  profile: UserProfile;
  userEmail: UserProfile['user']['email'];
  timezone: UserProfile['user']['timezone'];
}
