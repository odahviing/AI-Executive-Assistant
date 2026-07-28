/**
 * Email-specific outbound text formatting (v4.3.0, #24 E3).
 *
 * Applies the cross-cutting scrubber (same one Slack uses) then renders as
 * simple HTML — email has no markdown dialect, so **bold** / ## headers /
 * "- " bullets get an HTML equivalent instead of Slack's stripped-down mrkdwn.
 *
 * Layer: this lives under `src/connections/email/` because it's transport-
 * specific, mirroring `src/connections/slack/formatting.ts`.
 */

import { scrubInternalLeakage } from '../../utils/textScrubber';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Full outbound pipeline for email: scrub cross-cutting leakage, escape HTML,
 * then apply a minimal markdown→HTML rendering. Callers (EmailConnection) use
 * this as the single entry point before handing text to sendMail.
 */
export function formatForEmail(text: string): string {
  const scrubbed = scrubInternalLeakage(text);
  const escaped = escapeHtml(scrubbed);
  const withBold = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const withHeaders = withBold.replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');
  const withBullets = withHeaders.replace(/^- (.+)$/gm, '&bull;&nbsp;$1');
  return withBullets
    .split(/\n{2,}/)
    .map(paragraph => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}
