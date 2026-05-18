// scripts/simulate-create-meeting-args.ts
//
// Reproduces the conditions that produced the 2026-05-18 08:55 Michal MPIM
// "create_meeting / category=Logistic / single-attendee" misclassification
// (bug 98A) and prints whatever args Sonnet passes on the create_meeting
// tool call. No Graph writes happen — we stop after the model's first
// tool_use response.
//
// Run: npx tsx scripts/simulate-create-meeting-args.ts
//      [--owner-slack-id <id>]   default U0F28CK6H (idan)
//      [--mpim-member <id>]       default U09DGGUMKMM (Michal)
//      [--message "<text>"]       default "@Maelle book me a meeting with @<mpim-member> tomorrow 40 mins"
//
// Useful for paper-tracing the coord→create handoff without firing real
// Slack traffic or Graph mutations. The actual production fix lives in
// the diagnostic log inside the create_meeting handler at meetings/ops.ts;
// this script is for offline reproduction when the real-day chat isn't
// available to replay.

import Anthropic from '@anthropic-ai/sdk';
import { loadAllProfiles } from '../src/config/userProfile';
import { buildSystemPromptParts } from '../src/core/orchestrator/systemPrompt';
import { getSkillTools } from '../src/skills/registry';
import { getAnthropicClient } from '../src/llm/client';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const OWNER_ID = arg('--owner-slack-id', 'U0F28CK6H');
const MPIM_MEMBER = arg('--mpim-member', 'U09DGGUMKMM');
const MESSAGE = arg(
  '--message',
  `<@U0ARK5814PQ> book me a meeting with <@${MPIM_MEMBER}>\ntomorrow 40 mins`,
);

(async () => {
  const profiles = loadAllProfiles();
  const profile = [...profiles.values()].find(p => p.user.slack_user_id === OWNER_ID)
    ?? [...profiles.values()][0];
  if (!profile) {
    console.error('No profile loaded');
    process.exit(1);
  }

  console.log('─── simulate-create-meeting-args ───');
  console.log(`profile:     ${profile.user.name} (${profile.user.slack_user_id})`);
  console.log(`MPIM member: ${MPIM_MEMBER}`);
  console.log(`message:     ${MESSAGE.slice(0, 80)}${MESSAGE.length > 80 ? '...' : ''}`);
  console.log('────────────────────────────────────\n');

  const senderRole: 'owner' | 'colleague' = 'colleague';
  const isMpim = true;
  const isOwnerInGroup = true;
  const senderId = OWNER_ID;
  const mpimMemberIds = [OWNER_ID, MPIM_MEMBER];
  const senderName = profile.user.name;

  const parts = buildSystemPromptParts(
    profile,
    senderRole,
    senderName,
    isOwnerInGroup,
    new Set(mpimMemberIds.filter(id => id !== profile.user.slack_user_id)),
    isMpim,
    false,
    'sim-thread-' + Date.now(),
    senderId,
    mpimMemberIds,
  );
  const tools = getSkillTools(profile, senderRole, undefined);
  const writeTools = new Set([
    'create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting',
    'finalize_coord_meeting', 'book_floating_block',
    'coordinate_meeting', 'message_colleague',
    'create_approval', 'resolve_approval', 'create_task',
  ]);
  const filteredTools = tools.filter(t => !writeTools.has(t.name) || t.name === 'create_meeting');
  // ^ keep create_meeting so Sonnet can call it; strip other writes so a
  // multi-iteration cascade can't fire side effects in this simulation.

  const sysBlocks: Anthropic.TextBlockParam[] = parts.static
    ? [
        { type: 'text', text: parts.static, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: parts.dynamic },
      ]
    : [{ type: 'text', text: parts.dynamic }];

  // The MPIM prefix Sonnet expects on the user message. Mirror exactly the
  // shape connectors/slack/app.ts:1607-1612 builds so the system prompt's
  // mpimRulesBlock + addressee parsing line up.
  const memberLabels = mpimMemberIds
    .filter(id => id !== senderId)
    .map(id => id === MPIM_MEMBER ? `Michal Schwartz (slack_id: ${MPIM_MEMBER})` : `(slack_id: ${id})`)
    .join(', ');
  const prefixedMessage =
    `<<GROUP DM — participants: ${memberLabels}. ` +
    `Sender: ${profile.user.name}. ` +
    `All participants can see everything you write. ` +
    `Respond to ALL relevant people in the DM — when addressing a specific person, START your reply with <@their_slack_id> so they get a push notification. ` +
    `Do NOT say "tell her" or "let him know" when they are right here in this conversation.>>\n\n` +
    MESSAGE;

  const client = getAnthropicClient();

  // First Sonnet turn — propose slots etc.
  console.log('▸ Turn 1: owner MPIM message → expect find_available_slots or similar');
  let resp: Anthropic.Message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: sysBlocks,
    tools: filteredTools as Anthropic.Tool[],
    messages: [{ role: 'user', content: prefixedMessage }],
  });
  dumpToolUses(resp, 1);

  // Simulate the rest of the conversation up to the create_meeting moment.
  // Sequence mirrors the real 08:55-08:58 trace:
  //   1. Owner: "book me with Michal tomorrow 40 mins"
  //   2. Sonnet: find_available_slots → "Two options: 11:30-12:10 or 12:30-13:10"
  //   3. Michal: "11:30-12:10"
  //   4. Sonnet: asks subject + mode
  //   5. Michal: "Sales commissions"
  //   6. Owner: "online"
  //   7. Sonnet: create_meeting ← THIS is the call we want to inspect.
  const conversation: Anthropic.MessageParam[] = [
    { role: 'user', content: prefixedMessage },
    { role: 'assistant', content: resp.content },
  ];

  // Synthesize tool results for the find_available_slots call so Sonnet can
  // proceed. Two free slots, both 40min, internal pair.
  for (const block of resp.content) {
    if (block.type === 'tool_use') {
      conversation.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(block.name === 'find_available_slots'
            ? [
                { start: '2026-05-20T11:30:00+03:00', end: '2026-05-20T12:10:00+03:00' },
                { start: '2026-05-20T12:30:00+03:00', end: '2026-05-20T13:10:00+03:00' },
              ]
            : { ok: true }),
        }],
      });
    }
  }

  const followups = [
    { sender: MPIM_MEMBER, text: '11:30-12:10' },
    { sender: MPIM_MEMBER, text: 'Sales commissions' },
    { sender: OWNER_ID, text: 'online' },
  ];

  for (const m of followups) {
    const senderLabel = m.sender === OWNER_ID ? profile.user.name : 'Michal Schwartz';
    const recipientLabel = m.sender === OWNER_ID
      ? `Michal Schwartz (slack_id: ${MPIM_MEMBER})`
      : `${profile.user.name} (slack_id: ${OWNER_ID})`;
    const prefixed =
      `<<GROUP DM — participants: ${recipientLabel}. ` +
      `Sender: ${senderLabel}. ` +
      `All participants can see everything you write. ` +
      `Respond to ALL relevant people in the DM — when addressing a specific person, START your reply with <@their_slack_id>.>>\n\n` +
      m.text;
    conversation.push({ role: 'user', content: prefixed });

    console.log(`▸ Turn: ${senderLabel}: "${m.text}"`);
    resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: sysBlocks,
      tools: filteredTools as Anthropic.Tool[],
      messages: conversation,
    });
    dumpToolUses(resp, conversation.length);
    conversation.push({ role: 'assistant', content: resp.content });

    // If Sonnet just called create_meeting, we've reached the target moment.
    // Don't continue — we have the args.
    const hasCreate = resp.content.some(b => b.type === 'tool_use' && (b as Anthropic.ToolUseBlock).name === 'create_meeting');
    if (hasCreate) {
      console.log('\n✓ Reached create_meeting tool call. Stopping.');
      return;
    }

    // Otherwise feed back a synthetic tool result and continue.
    for (const block of resp.content) {
      if (block.type === 'tool_use') {
        conversation.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ ok: true }),
          }],
        });
      }
    }
  }

  console.log('\n(end without create_meeting call — check earlier turns)');
})().catch(err => {
  console.error('simulate-create-meeting-args failed:', err);
  process.exit(1);
});

function dumpToolUses(resp: Anthropic.Message, turn: number): void {
  for (const block of resp.content) {
    if (block.type === 'tool_use') {
      const tu = block as Anthropic.ToolUseBlock;
      console.log(`  tool_use #${turn}: ${tu.name}`);
      console.log('  input:');
      console.log('    ' + JSON.stringify(tu.input, null, 2).split('\n').join('\n    '));
    } else if (block.type === 'text') {
      const tb = block as Anthropic.TextBlock;
      const preview = tb.text.slice(0, 140);
      console.log(`  text: ${preview}${tb.text.length > 140 ? '...' : ''}`);
    }
  }
}
