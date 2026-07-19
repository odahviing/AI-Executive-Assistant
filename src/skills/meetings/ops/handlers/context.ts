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

export interface OpCtx {
  context: SkillContext;
  userEmail: SkillContext['profile']['user']['email'];
  timezone: SkillContext['profile']['user']['timezone'];
}
