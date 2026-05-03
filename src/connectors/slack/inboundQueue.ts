/**
 * Per-thread inbound message queue with debounce + mutex + abort-if-safe (v2.4.3, A1).
 *
 * Background: pre-v2.4.3 every inbound Slack message immediately fired
 * `runOrchestrator(...)`. Rapid-fire messages from the same thread (typing
 * burst, multi-message instructions) created OVERLAPPING orchestrator runs
 * sharing stale conversation snapshots. Trace from 2026-05-03 showed 13+
 * tool calls for ONE booking conversation because two orchestrator runs
 * raced and re-issued the same coord/find_available_slots calls. Owner's
 * direction: collapse rapid messages into ONE turn that sees all the
 * latest context, so Sonnet responds to the actual user state instead of
 * chasing partial snapshots.
 *
 * Three layered mechanisms, each with a specific job:
 *
 *   1. DEBOUNCE (1.5 sec). When a message arrives, hold it briefly. If
 *      another arrives during that window, both go into the next batch.
 *      Catches the typing-burst case ("book Eli for Mon" then 0.5s later
 *      "actually 25 min" — both messages should reach Sonnet together).
 *
 *   2. MUTEX during processing. Only one orchestrator turn runs per
 *      thread at a time. Messages arriving during a turn buffer; they're
 *      processed once the current turn finishes (or aborted — see #3).
 *
 *   3. ABORT-IF-SAFE. When a new message arrives mid-turn AND the
 *      in-flight turn hasn't fired any WRITE tools yet (read tools are
 *      repeatable), the in-flight turn aborts and a fresh turn starts
 *      with the merged context. If a write already fired (calendar event
 *      created, DM sent, approval raised — irreversible), the in-flight
 *      turn finishes naturally and the new message is processed as a
 *      follow-up turn (with the previous turn's actions visible in
 *      conversation history).
 *
 * Per-thread isolation: each (channelId, threadTs) gets its own queue
 * state. Different threads run in parallel as before — only same-thread
 * messages interact via this queue.
 *
 * Background tasks (dispatchers, brief generation, etc.) bypass the
 * queue entirely — they call runOrchestrator directly with their own
 * synthesized inputs. The queue is for INBOUND USER MESSAGES only.
 */

import logger from '../../utils/logger';

// ── Configuration ────────────────────────────────────────────────────────────

/** Debounce window for typing-burst collapse. Milliseconds. */
const DEBOUNCE_MS = 1500;

/**
 * Tools whose execution makes the in-flight turn UN-abortable. Anything that
 * sends a message externally, creates/modifies a calendar event, raises an
 * approval, or makes an irreversible DB change. Read-only tools (get_calendar,
 * find_available_slots, find_slack_user, web_search, recall_*) stay abortable —
 * re-running them is free, the cached results from A3 even share work.
 */
export const WRITE_TOOLS = new Set([
  // Calendar mutations
  'create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting',
  'finalize_coord_meeting', 'book_floating_block', 'set_event_category',
  // Coord / outreach (sends DMs externally — irreversible)
  'coordinate_meeting', 'message_colleague', 'cancel_coordination',
  // Approvals (DM owner)
  'create_approval', 'resolve_approval',
  // Tasks (visible state)
  'create_task', 'edit_task', 'cancel_task',
  // Routines
  'create_routine', 'update_routine', 'delete_routine',
  // Calendar issues
  'dismiss_calendar_issue', 'update_calendar_issue',
  // Knowledge / summary writes
  'share_summary', 'ingest_knowledge_from_url',
  'learn_summary_style', 'update_summary_draft',
  // Memory writes
  'learn_preference', 'forget_preference',
  'note_about_person', 'note_about_self',
  'log_interaction', 'update_person_profile', 'update_person_memory',
  'confirm_gender',
  // Briefing
  'send_briefing_now',
]);

// ── Per-thread state ─────────────────────────────────────────────────────────

interface PendingMessage {
  text: string;
  arrivedAt: number;
  senderName?: string;
  /** Optional metadata the runner needs (channel, ts, etc.) — opaque to the queue. */
  meta: Record<string, unknown>;
}

interface ThreadState {
  /** Messages waiting to be merged into the next turn. */
  pending: PendingMessage[];
  /** Active debounce timer; null when no messages waiting. */
  debounceTimer: NodeJS.Timeout | null;
  /** AbortController for the currently-running orchestrator turn; null when idle. */
  inFlight: AbortController | null;
  /** True once a write tool has fired in the current turn — abort no longer safe. */
  hasWriteFired: boolean;
}

const threadStates: Map<string, ThreadState> = new Map();

/**
 * Build the queue key.
 *
 * - 1:1 DM channels: key = channelId ONLY. In a DM each top-level message
 *   gets its own threadTs from Slack (threadTs == ts), so threadTs-scoping
 *   would put every message into its own queue and never merge — the exact
 *   bug observed on the v2.5.0 first-deploy test ("3 fast messages, no
 *   batching"). Logically a DM is one ongoing conversation; we coalesce
 *   accordingly.
 *
 * - MPIM / channel: key = channelId|threadTs. These genuinely have parallel
 *   conversations (different threads of replies, different topics) that
 *   shouldn't collapse into each other.
 */
function keyFor(channelId: string, threadTs: string | undefined, isOneOnOneDm: boolean): string {
  if (isOneOnOneDm) return channelId;
  return `${channelId}|${threadTs ?? '_none_'}`;
}

function getOrCreate(key: string): ThreadState {
  let s = threadStates.get(key);
  if (!s) {
    s = { pending: [], debounceTimer: null, inFlight: null, hasWriteFired: false };
    threadStates.set(key, s);
  }
  return s;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * The runner the queue calls when it's time to process a batch. Receives
 * the merged user message + meta from the FIRST pending message (channel,
 * threadTs, etc. don't change within a thread). Receives an AbortSignal it
 * MUST honor — when triggered, abandon the turn at the next safe point.
 *
 * The runner ALSO receives a `markWrite` callback. Call it the moment any
 * write tool starts executing, so the queue knows abort is no longer safe.
 */
export type TurnRunner = (params: {
  mergedText: string;
  meta: Record<string, unknown>;
  signal: AbortSignal;
  markWrite: () => void;
}) => Promise<void>;

/**
 * Main entry — call from the inbound message handler. Buffers the message,
 * sets/extends the debounce timer, and ultimately invokes `runner` once for
 * each batch. Returns immediately; processing happens async.
 *
 * Three behaviour cases per thread state:
 *   - IDLE: start debounce timer. When timer fires, drain pending → call runner.
 *   - DEBOUNCING: extend timer (reset to DEBOUNCE_MS), append message to pending.
 *   - RUNNING + abortable (no writes yet): abort in-flight, append message,
 *     start fresh debounce. New batch will include the previously-running
 *     message + the new one.
 *   - RUNNING + un-abortable (writes fired): append to pending, let current
 *     turn finish; pending will be processed as a follow-up batch.
 */
export function enqueueMessage(params: {
  channelId: string;
  threadTs: string | undefined;
  /** True for 1:1 DMs (owner ↔ Maelle, colleague ↔ Maelle). False for MPIMs and channel mentions. */
  isOneOnOneDm: boolean;
  text: string;
  senderName?: string;
  meta: Record<string, unknown>;
  runner: TurnRunner;
}): void {
  const key = keyFor(params.channelId, params.threadTs, params.isOneOnOneDm);
  const state = getOrCreate(key);

  const msg: PendingMessage = {
    text: params.text,
    arrivedAt: Date.now(),
    senderName: params.senderName,
    meta: params.meta,
  };

  // Case: a turn is currently running.
  if (state.inFlight) {
    if (!state.hasWriteFired) {
      logger.info('inboundQueue — aborting in-flight turn for merge (no writes yet)', {
        key, newMessagePreview: params.text.slice(0, 60),
      });
      state.inFlight.abort();
      // The aborted turn's "current message" is still in pending (the runner
      // hasn't cleared it on abort). Append the new message; both will be
      // merged together when the abort propagates back here.
      state.pending.push(msg);
      // The aborted turn's catch handler in scheduleRun will detect the
      // abort and re-trigger debounce; we don't need to start a new timer
      // ourselves.
      return;
    }
    // Writes already fired — can't abort. Buffer for after current turn.
    logger.info('inboundQueue — buffering message (current turn has writes, can\'t abort)', {
      key, newMessagePreview: params.text.slice(0, 60),
    });
    state.pending.push(msg);
    return;
  }

  // Case: debouncing or idle — append + (re)set debounce timer.
  state.pending.push(msg);
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
  }
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    void scheduleRun(key, params.runner);
  }, DEBOUNCE_MS);
}

/**
 * Drain the pending buffer into a merged user message and run one turn.
 * On abort: re-trigger debounce so the next message-arrival completes the
 * cycle. On normal completion: if pending has filled up during the run,
 * process those as a follow-up batch.
 */
async function scheduleRun(key: string, runner: TurnRunner): Promise<void> {
  const state = threadStates.get(key);
  if (!state || state.pending.length === 0) return;

  // Snapshot the batch and clear pending — new arrivals during the run go
  // into a fresh pending list.
  const batch = state.pending;
  state.pending = [];
  const mergedText = mergeMessages(batch);
  const meta = batch[0].meta;  // channel/ts/etc. are stable within a thread

  const controller = new AbortController();
  state.inFlight = controller;
  state.hasWriteFired = false;

  try {
    logger.info('inboundQueue — running turn', {
      key,
      batchSize: batch.length,
      mergedPreview: mergedText.slice(0, 100),
    });
    await runner({
      mergedText,
      meta,
      signal: controller.signal,
      markWrite: () => { state.hasWriteFired = true; },
    });
  } catch (err: any) {
    if (err?.name === 'AbortError' || err?.message === 'aborted_for_merge' || controller.signal.aborted) {
      logger.info('inboundQueue — turn aborted for merge', { key });
      // The new arrival that triggered the abort is already in pending.
      // Restart debounce so any further arrivals also collect into the batch.
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        void scheduleRun(key, runner);
      }, DEBOUNCE_MS);
      return;
    }
    logger.warn('inboundQueue — runner threw (non-abort) — proceeding', {
      key, err: String(err).slice(0, 300),
    });
  } finally {
    state.inFlight = null;
    state.hasWriteFired = false;
  }

  // Drain any messages that arrived during the turn (un-abortable case).
  if (state.pending.length > 0) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      void scheduleRun(key, runner);
    }, DEBOUNCE_MS);
  }
}

/**
 * Merge a batch of pending messages into a single user-message string.
 * Annotates each with arrival-time delta when there's more than one, so
 * Sonnet sees the rapid-fire pattern explicitly:
 *
 *   "Yael: Eli Feldman
 *    Yael (12s later): 25 min, on Mon or Thu"
 *
 * Single-message batches return the text unchanged.
 */
function mergeMessages(batch: PendingMessage[]): string {
  if (batch.length === 1) return batch[0].text;
  const first = batch[0];
  const lines: string[] = [first.text];
  for (let i = 1; i < batch.length; i++) {
    const m = batch[i];
    const deltaSec = Math.round((m.arrivedAt - first.arrivedAt) / 1000);
    const namePrefix = m.senderName ? `${m.senderName} ` : '';
    lines.push(`\n[${namePrefix}follow-up ${deltaSec}s later]: ${m.text}`);
  }
  return lines.join('');
}

/**
 * Test-only helper — clear all per-thread state. Don't call from production.
 */
export function _resetForTests(): void {
  for (const state of threadStates.values()) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.inFlight) state.inFlight.abort();
  }
  threadStates.clear();
}
