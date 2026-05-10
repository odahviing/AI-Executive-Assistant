/**
 * Owner-says-done scanner — LLM-only.
 *
 * Background: RULE 2d ("Close the loop when the owner handles something
 * himself") asks Sonnet to call cancel_task / cancel_coordination /
 * resolve_approval whenever the owner mentions in chat that he handled or
 * dropped a tracked item. Sonnet drops the call ~half the time — she
 * acknowledges verbally ("got it, marked done") but doesn't actually fire
 * the tool. Result: the underlying task/coord row stays open and surfaces
 * in tomorrow's brief ("Amazia coord still pending — collecting responses")
 * for an item the owner closed weeks ago.
 *
 * This helper runs as a fire-and-forget post-turn pass after every owner
 * orchestrator turn. When open tracked items exist, it runs a single LLM
 * pass against (owner_message, open_items) to identify which items the
 * owner just said are done. Each match is closed via the existing helpers
 * (updateTask cancelled / cancelCoordJob / updateOutreachJob done).
 * Idempotent: an already-closed item won't match the active-status filter
 * on next pass.
 *
 * v2.6.5 — keyword pre-filter REMOVED. Pre-fix, a list of CLOSURE_KEYWORDS
 * gated the LLM call; misses on declination phrasings ("I'm not going to
 * do it", "passing", "won't do") left items stuck open across all subsequent
 * turns. Owner direction: *"I hate the entire closing words. it's not
 * scalable. we have LLM to read answer and get reasoning... kill the entire
 * closure keywords."* The existing Sonnet pass below is conservative by
 * design (returns EMPTY when in doubt; ignores acks, questions, future-tense
 * plans) — it handles every owner turn correctly without a regex pre-filter.
 *
 * Cost: one Sonnet call per owner turn that has open items. ~$0.001 each.
 * Cheap enough to run on every owner turn; saves the keyword-list
 * maintenance burden and the language-coverage problem (Hebrew, French,
 * slang, etc. all handled by the LLM).
 *
 * Cascade order matches closeMeetingArtifacts: tasks first (broadest), then
 * coord_jobs, then outreach_jobs. Same idempotent + non-fatal contract.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { UserProfile } from '../config/userProfile';
import { getDb, updateOutreachJob } from '../db';
import { updateTask, type Task } from '../tasks';
import logger from './logger';

interface OpenItem {
  id: string;            // task id, coord id, or outreach id
  source: 'task' | 'coord' | 'outreach';
  summary: string;       // one-line description
  colleague?: string;    // colleague name if applicable
}

interface ScannerResult {
  scanned: boolean;
  closedItems: Array<{ id: string; source: string; reason: string }>;
}

const SYSTEM_PROMPT = `You scan an owner message for closure signals against a list of open tracked items.

Your job: identify which items (if any) the owner just told the assistant are DONE / DROPPED / HANDLED / NO LONGER NEEDED.

Be conservative. ONLY mark an item closed if:
  - The owner's message clearly references it (by name, colleague, topic, or unambiguous context)
  - AND the message clearly signals closure ("done", "drop it", "I handled it", "no need anymore", "cancel that", etc.)

Do NOT close items based on:
  - Vague affirmations ("ok", "yes", "thanks") — those are conversation flow, not closure signals
  - Discussion / questions about the item ("how's the X coord going?") — that's interest, not closure
  - Future-tense plans ("I'll handle it tomorrow") — that's not done yet
  - Generic positive statements ("good", "looks good") — context-dependent, default skip

When in doubt, return EMPTY closed_items. False positives close real work; false negatives leave a row open for tomorrow's brief to surface again — second chance.

Output strict JSON, no markdown:
{ "closed_items": [ { "id": "...", "reason": "<short — what owner said>" } ] }

If nothing closes: { "closed_items": [] }`;

export async function closeLoopOnOwnerHandled(params: {
  profile: UserProfile;
  ownerMessage: string;
}): Promise<ScannerResult> {
  const result: ScannerResult = { scanned: false, closedItems: [] };
  if (!params.ownerMessage || params.ownerMessage.length < 3) return result;

  // v2.6.5 — keyword pre-filter REMOVED (see file header). The LLM pass
  // below is the gate. Cheap enough to run on every owner turn that has
  // open items; the conservative SYSTEM_PROMPT keeps false positives near
  // zero. Open-items check stays as the cost-bound (no items → no LLM call).
  const openItems = collectOpenItems(params.profile.user.slack_user_id);
  if (openItems.length === 0) return result;
  result.scanned = true;

  // LLM pass — single Sonnet call, JSON output, fail-open on parse errors.
  let closedIds: Array<{ id: string; reason: string }> = [];
  try {
    const client = new Anthropic();
    const userPrompt = [
      `Owner just said: "${params.ownerMessage.slice(0, 800)}"`,
      ``,
      `Open tracked items (${openItems.length}):`,
      ...openItems.slice(0, 25).map(it => `  - id=${it.id} (${it.source}): ${it.summary}${it.colleague ? ` [colleague: ${it.colleague}]` : ''}`),
      ``,
      `Which items did the owner just close? JSON only.`,
    ].join('\n');
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = resp.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')
      .trim();
    // Strip code fences just in case Sonnet ignores the no-markdown rule
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '');
    const parsed = JSON.parse(cleaned) as { closed_items?: Array<{ id?: string; reason?: string }> };
    if (Array.isArray(parsed.closed_items)) {
      closedIds = parsed.closed_items
        .filter(c => typeof c.id === 'string' && c.id.length > 0)
        .map(c => ({ id: c.id as string, reason: typeof c.reason === 'string' ? c.reason : '' }));
    }
  } catch (err) {
    logger.warn('closeLoopOnOwnerHandled: LLM pass failed — fail-open', {
      err: String(err).slice(0, 300),
    });
    return result;
  }

  if (closedIds.length === 0) return result;

  // Resolve each id to its source bucket and close.
  const idToItem = new Map(openItems.map(it => [it.id, it]));
  for (const { id, reason } of closedIds) {
    const item = idToItem.get(id);
    if (!item) {
      logger.warn('closeLoopOnOwnerHandled: LLM returned unknown id — skipping', { id });
      continue;
    }
    try {
      if (item.source === 'task') {
        updateTask(id, { status: 'cancelled' });
      } else if (item.source === 'coord') {
        const db = getDb();
        db.prepare(`UPDATE coord_jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(id);
      } else if (item.source === 'outreach') {
        updateOutreachJob(id, { status: 'done' });
      }
      result.closedItems.push({ id, source: item.source, reason });
      logger.info('closeLoopOnOwnerHandled: closed item', {
        id, source: item.source, reason: reason.slice(0, 100),
      });
    } catch (err) {
      logger.warn('closeLoopOnOwnerHandled: cancel call threw — skipping item', {
        id, source: item.source, err: String(err).slice(0, 200),
      });
    }
  }
  return result;
}

function collectOpenItems(ownerUserId: string): OpenItem[] {
  const db = getDb();
  const items: OpenItem[] = [];

  // Tasks (excluding system / housekeeping tasks owner doesn't track)
  try {
    const tasks = db.prepare(`
      SELECT id, title, type, target_name FROM tasks
      WHERE owner_user_id = ?
        AND status IN ('new', 'in_progress', 'pending_owner', 'pending_colleague')
        AND type NOT IN ('routine', 'social_decay', 'social_outreach_tick', 'coord_nudge', 'coord_abandon', 'outreach_expiry', 'outreach_decision', 'approval_expiry', 'approval_reminder', 'calendar_fix', 'social_ping_rank_check')
      ORDER BY updated_at DESC
      LIMIT 20
    `).all(ownerUserId) as Array<Pick<Task, 'id' | 'title' | 'type'> & { target_name: string | null }>;
    for (const t of tasks) {
      items.push({
        id: t.id,
        source: 'task',
        summary: `[${t.type}] ${t.title}`,
        colleague: t.target_name ?? undefined,
      });
    }
  } catch (err) {
    logger.warn('collectOpenItems tasks query threw', { err: String(err).slice(0, 200) });
  }

  // Coord jobs (active states)
  try {
    const coords = db.prepare(`
      SELECT id, subject, participants FROM coord_jobs
      WHERE owner_user_id = ?
        AND status IN ('collecting', 'resolving', 'negotiating', 'waiting_owner', 'confirmed')
      ORDER BY updated_at DESC
      LIMIT 15
    `).all(ownerUserId) as Array<{ id: string; subject: string; participants: string }>;
    for (const c of coords) {
      let collName: string | undefined;
      try {
        const parts = JSON.parse(c.participants || '[]') as Array<{ name?: string; just_invite?: boolean }>;
        const names = parts.filter(p => !p.just_invite).map(p => p.name).filter(Boolean);
        if (names.length > 0) collName = names.join(', ');
      } catch {}
      items.push({
        id: c.id,
        source: 'coord',
        summary: `coord "${c.subject}"`,
        colleague: collName,
      });
    }
  } catch (err) {
    logger.warn('collectOpenItems coords query threw', { err: String(err).slice(0, 200) });
  }

  // Outreach jobs (sent / no_response — anything still expecting a reply)
  try {
    const outreach = db.prepare(`
      SELECT id, colleague_name, message, intent FROM outreach_jobs
      WHERE owner_user_id = ?
        AND status IN ('sent', 'no_response')
      ORDER BY updated_at DESC
      LIMIT 15
    `).all(ownerUserId) as Array<{ id: string; colleague_name: string; message: string; intent: string | null }>;
    for (const o of outreach) {
      items.push({
        id: o.id,
        source: 'outreach',
        summary: `outreach to ${o.colleague_name}${o.intent ? ` (${o.intent})` : ''}: ${(o.message ?? '').slice(0, 80)}`,
        colleague: o.colleague_name,
      });
    }
  } catch (err) {
    logger.warn('collectOpenItems outreach query threw', { err: String(err).slice(0, 200) });
  }

  return items;
}
