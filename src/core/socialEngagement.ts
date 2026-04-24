/**
 * v2.2 — this module has been retired.
 *
 * The legacy post-turn "engagement upgrader" ran after Maelle asked a
 * social question, classified the colleague's reply quality, and upgraded
 * the quality of the matched social_topics row in people_memory. That
 * whole lane has moved to the Social Engine:
 *
 *   - Owner-side social signals are logged automatically on the
 *     orchestrator's post-turn pass via `core/social/logEngagement.ts`.
 *   - Colleague rapport no longer tracks topic quality upgrades.
 *
 * File kept as an empty stub so existing imports during a partial build
 * don't break. Safe to delete once all call sites are confirmed clean.
 */

export {};
