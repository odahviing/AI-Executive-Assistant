/**
 * Normalize markdown → Slack formatting.
 *
 * Slack uses *single asterisks* for bold — never **double**. Claude and Sonnet
 * periodically emit Markdown bold despite system-prompt instructions, so every
 * LLM-sourced string bound for Slack must pass through this before postMessage.
 *
 * Call sites (Apr 2026):
 *  - connectors/slack/app.ts (orchestrator reply to owner/colleague)
 *  - tasks/crons.runner.ts   (user routine output, e.g. "Daily calendar check")
 *  - tasks/briefs.ts         (morning briefing)
 */
export function normalizeSlackText(text: string): string {
  return text
    .replace(/\*\*/g, '*')
    .replace(/##+ /g, '')
    .replace(/^- /gm, '')
    .replace(/ - /g, ', ');
}
