/**
 * Slack-specific outbound text formatting (v2.0.2 — split from utils/slackFormat).
 *
 * Applies Slack's markdown dialect (single-asterisk bold, no markdown headers,
 * no leading "- " list items) AFTER the cross-cutting scrubber has stripped
 * internal leakage. Every LLM → Slack post path should run through this.
 *
 * Layer: this lives under `src/connections/slack/` because it's transport-
 * specific. Email and WhatsApp connections will have their own formatting
 * modules when they land.
 */

import { scrubInternalLeakage } from '../../utils/textScrubber';

/**
 * Full outbound pipeline for Slack: scrub cross-cutting leakage, then apply
 * Slack's markdown dialect. Callers use this as the single entry point.
 */
export function formatForSlack(text: string): string {
  return scrubInternalLeakage(text)
    .replace(/\*\*/g, '*')       // Slack: bold is *single* asterisk
    .replace(/##+ /g, '')        // Slack: no markdown headers
    .replace(/^- /gm, '')        // Slack: strip leading "- " list prefixes
    // v2.0.8 — Sonnet defaults to markdown-safe escaping on literal angle
    // brackets (e.g. calendar event titles like "Reflectiz<>Strauss" → she
    // outputs "Reflectiz\<\>Strauss"). Slack's mrkdwn doesn't use backslash
    // escaping, so the backslashes render literally and look like garbage.
    // Slack only treats `<...>` as a link/mention when it looks like one
    // (`<https://…>` or `<@USERID>`); bare `<>` in text renders as-is, so
    // the escape is always noise. Strip them unconditionally here.
    .replace(/\\</g, '<')
    .replace(/\\>/g, '>')
    .trim();
}
