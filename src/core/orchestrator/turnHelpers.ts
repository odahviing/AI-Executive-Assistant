import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { getAnthropicClient } from '../../llm/client';
import { logLlmUsage } from '../../utils/usageLog';
import logger from '../../utils/logger';

const anthropic = getAnthropicClient();

/**
 * Wraps anthropic.messages.create with a single retry on 429 rate-limit errors.
 * Reads the retry-after header so we wait exactly as long as the API needs.
 */
async function callClaude(
  params: Anthropic.MessageCreateParamsNonStreaming,
  retriesLeft = 1,
): Promise<Anthropic.Message> {
  try {
    const resp = await anthropic.messages.create(params) as Anthropic.Message;
    // v3.0.6 — usage logging. This wrapper is the main orchestrator loop's
    // sole API path, so one log here captures every iteration of every turn
    // — the dominant Sonnet cost. Tagged 'orchestrator'.
    logLlmUsage('orchestrator', String(params.model), resp);
    return resp;
  } catch (err: any) {
    if (err?.status === 429 && retriesLeft > 0) {
      const retryAfter = parseInt(err?.headers?.['retry-after'] ?? '30', 10);
      const waitMs = Math.min(retryAfter * 1000, 120_000); // cap at 2 min
      logger.warn('Rate limited — waiting before retry', { waitMs, retryAfter });
      await new Promise(r => setTimeout(r, waitMs));
      return callClaude(params, retriesLeft - 1);
    }
    throw err;
  }
}

/**
 * Trims conversation history to fit within token budget before sending to the API.
 * Keeps the most recent messages up to maxMessages count and maxChars total.
 * Always preserves the final user message (current turn).
 */
function trimHistory(
  messages: Anthropic.MessageParam[],
  maxChars = 12_000,
  maxMessages = 20,
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const current = messages[messages.length - 1];         // always keep current turn
  const history = messages.slice(0, -1).slice(-maxMessages); // cap message count

  // Walk backwards, accumulate until we hit char limit
  let total = 0;
  const kept: Anthropic.MessageParam[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const len = typeof history[i].content === 'string'
      ? (history[i].content as string).length
      : JSON.stringify(history[i].content).length;
    if (total + len > maxChars && kept.length >= 2) break; // always keep ≥2 for context
    total += len;
    kept.unshift(history[i]);
  }

  return [...kept, current];
}

// v2.2.5 — outcome-aware summary for mutation tools. The claim-checker reads
// these summaries to decide if a reply's success language is honest. Without
// outcome info, a failed move_meeting looked the same as a successful one and
// "all done" got waved through. Now mutations emit OK or FAILED so the checker
// can flag false-success drafts.
function mutationOutcome(result: unknown): { ok: boolean; reason?: string; eventId?: string } {
  if (result == null || typeof result !== 'object') return { ok: false, reason: 'no_result' };
  const r = result as Record<string, unknown>;
  // Common positive shapes: { success: true, ... }, { ok: true, ... }, { meetingId: ... }, { id: ... }
  // Common negative shapes: { success: false, error: '...' }, { ok: false, reason: '...' }, { warning: '...', needs_confirmation: true }
  if (r.success === false) return { ok: false, reason: typeof r.error === 'string' ? r.error : 'tool_returned_false' };
  if (r.ok === false) return { ok: false, reason: typeof r.reason === 'string' ? r.reason : 'tool_returned_false' };
  if (r.needs_confirmation === true) return { ok: false, reason: typeof r.warning === 'string' ? r.warning : 'needs_confirmation' };
  if (r.needs_owner_approval === true) return { ok: false, reason: typeof r.reason === 'string' ? r.reason : 'needs_owner_approval' };
  if (r.success === true || r.ok === true || typeof r.meetingId === 'string' || typeof r.id === 'string' || typeof r.event_id === 'string') {
    const eventId = (r.meetingId ?? r.id ?? r.event_id) as string | undefined;
    return { ok: true, eventId };
  }
  // No clear shape — be conservative, treat as not-confirmed-success.
  return { ok: false, reason: 'unclear_result' };
}

/**
 * v4.1.x (G3) — THE mutation marker. Which tools change state, and in which
 * domain, is knowledge that belongs HERE: this is the one place that holds the
 * tool name and its result at the same time, so it is the only place that can say
 * "a real state change happened" instead of guessing it later from a string.
 *
 * Before this, the claim-checker's false-positive shield re-derived the same fact
 * downstream by matching tool NAMES out of the rendered summary text — four
 * action_type branches over a 5-tool, a 2-tool and a 14-tool alternation, each
 * grown after a distinct incident, and every new mutating tool had to be
 * remembered in it or it would produce a false phantom-action flag (G2). The
 * shield now reads ONE field. Name-matching is gone from the guard entirely.
 *
 * The domain vocabulary is deliberately the claim-checker's own `action_type`
 * enum, so the shield is a single `includes('mutated=' + action_type)`. Membership
 * is exactly the set the old alternations covered — this change moves WHERE the
 * list lives, it does not change WHICH tools count.
 */
type MutationDomain = 'book' | 'task' | 'message' | 'other';
const MUTATION_DOMAIN: Record<string, MutationDomain> = {
  // calendar mutations → the claim-checker's 'book' class
  create_meeting: 'book', move_meeting: 'book', update_meeting: 'book',
  delete_meeting: 'book', book_floating_block: 'book',
  // work items raised for someone
  create_task: 'task', create_approval: 'task',
  // an outbound DM actually queued
  message_colleague: 'message',
  // the memory / preference / routine / knowledge write family
  update_my_preferences: 'other', manage_preference: 'other',
  note_about_person: 'other', note_about_self: 'other', log_interaction: 'other',
  confirm_gender: 'other', update_person_profile: 'other', update_person_memory: 'other',
  manage_routine: 'other', manage_calendar_issue: 'other', update_task: 'other',
  update_summary_draft: 'other', manage_knowledge: 'other', resolve_approval: 'other',
};

/**
 * The domain this call actually mutated, or null when nothing changed.
 *
 * Only an OK outcome earns a marker — the same convention the tool log already
 * uses (`[<tool> OK …]` vs `[<tool> FAILED …]`, #137b). A failed mutation means she
 * did NOT act, so it must not back a "done" claim: the old shield matched the tool
 * NAME and so suppressed the honesty rewrite even on `[create_meeting FAILED: …]`.
 */
function mutationDomain(toolName: string, result: unknown): MutationDomain | null {
  const domain = MUTATION_DOMAIN[toolName];
  if (!domain) return null;
  if (result == null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  // Any explicit negative — a thrown/refused call, or a skill's own no-op verdict
  // (resolve_approval's `{ok:false}`) — changed nothing.
  if (typeof r.error === 'string') return null;
  if (r.ok === false || r.success === false) return null;
  // Calendar mutations carry a rich outcome (needs_confirmation / needs_owner_approval
  // / unclear shapes are all NOT a completed write) — reuse the one reader for it.
  if (domain === 'book' && !mutationOutcome(result).ok) return null;
  return domain;
}

function summarizeToolCall(toolName: string, input: Record<string, unknown>, result: unknown): string {
  const summary = renderToolSummary(toolName, input, result);
  const domain = mutationDomain(toolName, result);
  // Stamped OUTSIDE the tool's bracket on purpose: MUTATION_OK_RE below lifts the
  // bracketed span verbatim into the pinned action tape, so keeping the marker out
  // of it leaves that prompt block byte-identical to before. The marker still rides
  // along everywhere it needs to — the summaries are persisted to conversation
  // history joined verbatim (postReply Step 1b), which is exactly what the shield
  // reads for both this turn and prior turns.
  return domain ? `${summary} mutated=${domain}` : summary;
}

/**
 * v4.1.x — the tool-log line for an INTERNAL action: a mutation a skill performed
 * inside its own run (active-mode calendar health rebooking lunch, or auto-moving a
 * meeting) rather than as its own top-level tool call. The orchestrator surfaces
 * these onto the same tape so the claim-checker can see them.
 *
 * It lives HERE, beside summarizeToolCall, because it is the SAME surface and has to
 * carry the same marker — and when it didn't, it broke exactly the reply it exists to
 * protect. The retired name-matching alternation happened to match these lines on the
 * tool name (`[book_floating_block (via …`, `[move_meeting (via …`), so moving the
 * shield onto the carried marker silently dropped both paths: with
 * calendar_health_mode "active" (config/users/idan.yaml:228), "how's my calendar
 * today?" auto-rebooks lunch, and Maelle's TRUE "I put lunch back at 12:30" would be
 * flagged as a phantom action and sent to rewriteOwningTheMiss.
 *
 * No outcome gate here, unlike a real tool call: an internal action is only ever
 * emitted AFTER its mutation succeeded (checkHealth.ts:727 gates on `ok && created`;
 * autoMove.ts:206 pushes once the move and its notifications have landed), so the
 * entry's existence IS the confirmation. Reusing MUTATION_DOMAIN keeps coverage
 * identical to the tool path — set_event_category and rebalance_floating_blocks are
 * not in it, and were not in the old alternations either, so they stay unmarked.
 */
function summarizeInternalAction(tool: string, viaTool: string, detail?: string): string {
  const line = `[${tool} (via ${viaTool}): ${detail ?? ''}]`;
  const domain = MUTATION_DOMAIN[tool];
  return domain ? `${line} mutated=${domain}` : line;
}

/**
 * Build a compact one-line summary of a tool call for conversation history.
 * This lets Claude know what it did on previous turns without storing the full JSON.
 */
function renderToolSummary(toolName: string, input: Record<string, unknown>, result: unknown): string {
  try {
    // v3.0.5 — generic FAILED detection. registry.ts wraps every thrown
    // tool call in `{ error: 'Tool "X" failed: <reason>' }`, and skills also
    // return `{ error: ... }` for non-thrown refusals. Surface both as
    // `[<tool> FAILED: <reason>]` BEFORE the per-tool cases — otherwise a
    // throw-from-message_colleague would render as `[message_colleague: Yael]`
    // and the claim-checker shield treats it as success (silent-fail bug:
    // outreach DM never sent, draft "Sent the message" sneaks past the
    // checker because the tool is "in toolSummaries").
    if (result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string') {
      const reason = String((result as { error: string }).error).replace(/\s+/g, ' ').trim().slice(0, 80);
      return `[${toolName} FAILED: ${reason}]`;
    }
    switch (toolName) {
      case 'analyze_calendar': {
        const days = Array.isArray(result) ? result : [];
        const totalIssues = days.reduce((n: number, d: any) => n + (d.issues?.length ?? 0), 0);
        return `[analyze_calendar ${input.start_date}→${input.end_date}: ${days.length} days, ${totalIssues} issues]`;
      }
      case 'get_calendar': {
        const events = Array.isArray(result) ? result : [];
        return `[get_calendar ${input.start_date}→${input.end_date}: ${events.length} events]`;
      }
      case 'find_available_slots': {
        // v3.0.3 — enrich the summary with the actual slot list returned,
        // not just the input duration. Pre-fix the compact string was
        // `[find_available_slots: duration_minutes=N]` — claim-checker
        // couldn't verify specific time claims in the draft because the
        // summary carried no slot data. Now lists up to 5 slots so the
        // checker can audit "draft says 12:00 fits" against tool output.
        const slots: Array<{ start?: string; end?: string }> =
          Array.isArray(result) ? result :
          (result && typeof result === 'object' && Array.isArray((result as any).slots)) ? (result as any).slots :
          [];
        const fmt = (s: { start?: string; end?: string }) => {
          if (!s.start) return '?';
          const t = String(s.start).slice(11, 16);  // 'HH:MM'
          const d = String(s.start).slice(0, 10);   // 'YYYY-MM-DD'
          return s.end ? `${d} ${t}-${String(s.end).slice(11, 16)}` : `${d} ${t}`;
        };
        const slotList = slots.slice(0, 5).map(fmt).join(', ');
        const dur = (input as any).duration_minutes;
        const from = (input as any).search_from;
        const to = (input as any).search_to;
        const window = from && to ? ` ${String(from).slice(0, 16)}→${String(to).slice(0, 16)}` : '';
        if (slots.length === 0) {
          return `[find_available_slots${window} dur=${dur}m: 0 slots]`;
        }
        const more = slots.length > 5 ? ` +${slots.length - 5} more` : '';
        return `[find_available_slots${window} dur=${dur}m → ${slots.length} slots: ${slotList}${more}]`;
      }
      case 'find_slack_user':
        return `[find_slack_user: "${input.name}"]`;
      case 'message_colleague':
        return `[message_colleague: ${(input as any).colleague_name}]`;
      // v2.2.5 — mutation tools: read the outcome so the claim-checker sees
      // FAILED vs OK rather than just "the call ran."
      case 'create_meeting':
      case 'move_meeting':
      case 'update_meeting':
      case 'delete_meeting':
      case 'book_floating_block': {
        const outcome = mutationOutcome(result);
        const idPart = outcome.ok && outcome.eventId ? ` event_id=${String(outcome.eventId).slice(0, 16)}…` : '';

        // v3.6.x — update_meeting changes FIELDS (subject / attendees / category
        // / location). The identifying subject alone doesn't show WHAT changed,
        // so the claim-checker couldn't verify "renamed to X" / "added Yael" and
        // inferred the change failed → fabricated a "not done yet" on a done
        // action (2026-07-08). On success, render the tool's OWN action_summary —
        // it enumerates the actual post-change values (R4: the log carries what
        // HAPPENED, not the stale label used to find the meeting).
        if (toolName === 'update_meeting' && outcome.ok) {
          const changes = typeof (result as { action_summary?: unknown }).action_summary === 'string'
            ? (result as { action_summary: string }).action_summary.replace(/\s+/g, ' ').trim().slice(0, 140)
            : '';
          // v3.7.x (#B2) — surface the structured added-attendee EMAILS beside the
          // prose. action_summary renders an added attendee by DISPLAY NAME ("added
          // Meeting Room"); a draft that names the EMAIL ("added meeting@…") then
          // can't be matched against the summary and the checker inverted a TRUE
          // add. The email is already in the tool result (added_attendees) — carry
          // it into the log the checker reads so a claim in EITHER form matches
          // (R4: carry the truth, don't make the checker guess a name↔email bridge).
          const addedEmails = Array.isArray((result as { added_attendees?: unknown }).added_attendees)
            ? ((result as { added_attendees: unknown[] }).added_attendees.filter(e => typeof e === 'string') as string[])
            : [];
          const addedPart = addedEmails.length ? ` [added: ${addedEmails.join(', ')}]` : '';
          return changes
            ? `[update_meeting OK — ${changes}${addedPart}${idPart}]`
            : `[update_meeting OK ${String((input as any).new_subject ?? (input as any).meeting_subject ?? '').slice(0, 40)}${addedPart}${idPart}]`;
        }

        // v3.4.2 (NEW-1) — NEVER fall back to meeting_id here. It was rendered
        // sliced to 40 chars with NO ellipsis, so the pinned action-tape summary
        // (e.g. `[update_meeting OK AAMkADVmMjY1…40chars]`) looked like a COMPLETE
        // id — Sonnet copied it back as meeting_id on the next edit → Graph
        // "ErrorInvalidIdMalformed: The Id is invalid" + a forced re-fetch/retry
        // (the Boston-thread failures). Use the human-readable subject instead;
        // the full canonical id reaches Sonnet via get_calendar / the just-booked
        // event injection, never a truncated summary.
        const subj = (input as any).subject ?? (input as any).meeting_subject ?? (input as any).new_start ?? (input as any).date ?? '';
        const subjPart = subj ? ` ${String(subj).slice(0, 40)}` : '';
        if (outcome.ok) {
          return `[${toolName} OK${subjPart}${idPart}]`;
        }
        return `[${toolName} FAILED${subjPart}${outcome.reason ? `: ${outcome.reason.slice(0, 60)}` : ''}]`;
      }
      case 'set_event_category': {
        // Pure mutation (no read mode) → a non-error result IS success. Emit an
        // explicit OK marker so the claim-checker can confirm a "Done / updated
        // / categorized" claim. The generic `default` below carried NO outcome
        // marker, so legit category updates ("All 7 updated to Weekly") were
        // flagged as unverifiable and rewritten (GH 2026-06-17 over-fire).
        // FAILED is already handled by the generic error check at the top.
        const cat = (input as any).category ?? (input as any).category_id ?? (input as any).label ?? '';
        return `[set_event_category OK${cat ? ` ${String(cat).slice(0, 40)}` : ''}]`;
      }
      case 'resolve_approval': {
        // v3.7.x (#B2-approval) — CARRY THE REPLAY OUTCOME so the claim-checker
        // can tell a real mutation-replay from a decision-only approve. The
        // DURABLE signal (approval chat's contract) is `action_summary`: a
        // deferred_action that replayed returns it (+ `booked` for a booking
        // tool); a freeform / callback-less approve applies NOTHING and returns an
        // explicit no-replay effect ('approved (no replay)' / 'approved — no
        // action to replay …'). The default summarizer showed only
        // `[resolve_approval: approval_id=…]`, outcome-blind, so a false "added /
        // booked X" after a no-op approve passed on the tool name alone (Maayan
        // add-attendees, 2026-07-19). Emit an UNAMBIGUOUS marker: the no-op branch
        // must never contain the word "replay" (the resolver's own 'no action to
        // replay' would otherwise read to the checker as a replay). Only the
        // EXPLICIT no-op is marked "NO calendar change"; an unknown resolve shape
        // (reject / amend / expired) stays neutral so the checker never
        // manufactures a flag off it (R7 safe-miss).
        const r = result as { ok?: boolean; state?: string; effect?: string; action_summary?: string; booked?: boolean; reason?: string };
        if (r.ok === false) {
          return `[resolve_approval — not resolved${typeof r.reason === 'string' ? `: ${r.reason.slice(0, 60)}` : ''}]`;
        }
        const effect = typeof r.effect === 'string' ? r.effect.toLowerCase() : '';
        const replayed = (typeof r.action_summary === 'string' && r.action_summary.trim().length > 0)
          || r.booked === true || effect.includes('action replayed');
        if (replayed) {
          const summ = typeof r.action_summary === 'string' && r.action_summary.trim().length
            ? `: ${r.action_summary.replace(/\s+/g, ' ').trim().slice(0, 120)}` : '';
          return `[resolve_approval OK — replayed the approved action${summ}]`;
        }
        if (effect.includes('no replay') || effect.includes('no action to replay')) {
          return `[resolve_approval OK — decision recorded, NO calendar change]`;
        }
        return `[resolve_approval OK — ${r.effect ?? r.state ?? 'resolved'}]`;
      }
      default: {
        // Generic: just tool name + first key-value
        const firstKey = Object.keys(input)[0];
        const firstVal = firstKey ? String(input[firstKey]).slice(0, 40) : '';
        return `[${toolName}${firstKey ? `: ${firstKey}=${firstVal}` : ''}]`;
      }
    }
  } catch {
    return `[${toolName}]`;
  }
}

// v2.2.5 — Action tape. Scans the assistant turns in this thread's conversation
// history for successful mutation tool summaries (the `[<tool> OK ...]` markers
// emitted by summarizeToolCall above) and pins them at the top of the system
// prompt as a fact block. Replaces the prompt-rule attempts (RULE 2e in
// systemPrompt.ts and the calendarHealth "RULE 2e principle" reference) which
// kept rotting — Sonnet ignores rules but can't ignore pinned data.
//
// Failed mutations (`[<tool> FAILED ...]`) are intentionally excluded — only
// confirmed successes belong on the tape. The closing line acknowledges the
// tool-trust gap (Graph can return OK on a write that didn't actually land):
// when the owner pushes back, Maelle re-checks instead of insisting.
const MUTATION_OK_RE = /\[(?:create_meeting|move_meeting|update_meeting|delete_meeting|book_floating_block) OK[^\]]*\]/g;

function extractActionTape(history: Array<{ role: 'user' | 'assistant'; content: string }>): string[] {
  const out: string[] = [];
  for (const msg of history) {
    if (msg.role !== 'assistant') continue;
    const matches = msg.content.match(MUTATION_OK_RE);
    if (matches) out.push(...matches);
  }
  return out.slice(-20);
}

// #131 — stamp each PRIOR user message with the absolute time it was sent, in
// owner-local time, so the model anchors relative words ("tomorrow", "today")
// to WHEN they were said, not to the current turn's "now". Without this a
// message read a day later re-resolves "tomorrow" against the new today (Dina's
// Sunday "tomorrow"=Monday silently became Tuesday on Monday). Slack gives a `ts`
// on every message; the system prompt's "now" still anchors the live turn, so we
// stamp history only. Fails open to the raw content on any bad/absent ts.
function stampHistoryTime(content: string, ts: string | undefined, tz: string): string {
  if (!ts) return content;
  const secs = parseFloat(ts);
  if (!Number.isFinite(secs)) return content;
  try {
    const when = DateTime.fromSeconds(secs).setZone(tz);
    if (!when.isValid) return content;
    return `[${when.toFormat('EEE d MMM, HH:mm')}] ${content}`;
  } catch {
    return content;
  }
}

export {
  callClaude,
  trimHistory,
  mutationOutcome,
  summarizeToolCall,
  summarizeInternalAction,
  extractActionTape,
  stampHistoryTime,
};
