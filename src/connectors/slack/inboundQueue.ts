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

// ── Per-thread state ─────────────────────────────────────────────────────────

interface PendingMessage {
  text: string;
  arrivedAt: number;
  senderName?: string;
  /** Optional metadata the runner needs (channel, ts, etc.) — opaque to the queue. */
  meta: Record<string, unknown>;
  /**
   * v2.8.5 — the runner closure that built this message's context (threadTs,
   * senderId, role, profile, app, etc.). Stored per-message so that when a
   * message buffers during an un-abortable turn and is drained later, we
   * dispatch via THIS message's runner — not the outer scheduleRun's. Pre-
   * fix, the drain re-used the in-flight turn's closure, which captured
   * the FIRST message's threadTs. For 1:1 DMs (key=channelId), a NEW thread
   * opened mid-turn would buffer correctly but then run against the OLD
   * thread's conversation history — the cross-thread contamination Idan
   * hit on 2026-05-17 with the Onn move arriving during a LinkedIn turn.
   */
  runner: TurnRunner;
}

interface ThreadState {
  /** Messages waiting to be merged into the next turn. */
  pending: PendingMessage[];
  /** Active debounce timer; null when no messages waiting. */
  debounceTimer: NodeJS.Timeout | null;
  /** AbortController for the currently-running orchestrator turn; null when idle. */
  inFlight: AbortController | null;
  /**
   * True once a write tool has fired in the current turn — abort no longer safe.
   * Set by the runner's `markWrite` callback; WHICH tools count as writes is a
   * transport-neutral question answered by WRITE_TOOLS in skills/registry.ts,
   * which core consults before dispatch (orchestrator/index.ts).
   */
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
 * Is this throw the queue's own deliberate merge-abort rather than a failure?
 *
 * Exported because the RUNNER has to ask the same question the queue asks, and
 * two copies of the predicate would eventually disagree. A runner that reports
 * a failure to the person must consult this FIRST and re-throw on true: an
 * aborted turn was superseded on purpose (S8), a fresh turn is already queued
 * behind it, and a superseded turn apologising would be a brand-new bug.
 *
 * `signal.aborted` is part of the test, not just the error shape: an abort can
 * land in the same tick as a real error (a 529 throwing while the person types
 * again), and in that case the merged turn still runs and still answers — so
 * silence here is correct, not a swallow.
 */
export function isMergeAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const e = err as { name?: string; message?: string } | null | undefined;
  return e?.name === 'AbortError' || e?.message === 'aborted_for_merge';
}

/**
 * The runner the queue calls when it's time to process a batch. Receives
 * the merged user message + meta from the FIRST pending message (channel,
 * threadTs, etc. don't change within a thread). Receives an AbortSignal it
 * MUST honor — when triggered, abandon the turn at the next safe point.
 *
 * The runner ALSO receives a `markWrite` callback. Call it the moment any
 * write tool starts executing, so the queue knows abort is no longer safe.
 *
 * CONTRACT — the runner OWNS its own failures. It is the only party in this
 * flow that can reach the person (it holds `say`, the channel and the thread);
 * the queue holds none of that and never will. So anything that throws inside
 * a turn must be caught, judged and answered THERE. A throw that escapes to
 * `scheduleRun` is a bug in the runner, not a supported path — see the catch
 * down there for what it does with one.
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

  // v2.6.1 — diagnostic to investigate D2 (duplicate orchestrator turns
  // from same Slack event). Logs the queue state at every enqueue so we
  // can correlate "two scheduleRun calls with batchSize:1" against what
  // each enqueue saw. Triggered by the 2026-05-06 21:39 incident where
  // both MPIM `message` and `app_mention` events ran independently. If
  // the second enqueue logs `inFlight=null pending=0 timer=null` despite
  // the first having just enqueued, the keys differed; if it shows the
  // first's state, then the timer was already firing — points at a
  // specific race we can address.
  logger.info('inboundQueue — enqueue', {
    key,
    channelId: params.channelId,
    threadTs: params.threadTs ?? '_none_',
    isOneOnOneDm: params.isOneOnOneDm,
    inFlight: state.inFlight !== null,
    hasWriteFired: state.hasWriteFired,
    pendingCount: state.pending.length,
    timerSet: state.debounceTimer !== null,
    textPreview: params.text.slice(0, 60),
  });

  const msg: PendingMessage = {
    text: params.text,
    arrivedAt: Date.now(),
    senderName: params.senderName,
    meta: params.meta,
    runner: params.runner,
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
    void scheduleRun(key);
  }, DEBOUNCE_MS);
}

/**
 * Drain the pending buffer into a merged user message and run one turn.
 * On abort: re-trigger debounce so the next message-arrival completes the
 * cycle. On normal completion: if pending has filled up during the run,
 * process those as a follow-up batch.
 *
 * v2.8.5 — the runner is no longer a parameter; it comes from the LAST
 * pending message in the batch. This keeps the runner aligned with the
 * thread/sender that produced the most recent context. In the abort path
 * (which restarts debounce), the same logic re-applies on the next call.
 */
async function scheduleRun(key: string): Promise<void> {
  const state = threadStates.get(key);
  if (!state || state.pending.length === 0) return;

  // Snapshot the batch and clear pending — new arrivals during the run go
  // into a fresh pending list.
  const batch = state.pending;
  state.pending = [];
  const mergedText = mergeMessages(batch);
  // Use the LAST message's runner + meta — that's the most recent context
  // (latest threadTs, latest priorOutboundContext lookup, etc.). For
  // single-message batches this is also the only choice; for multi-message
  // merges it picks the freshest snapshot.
  const last = batch[batch.length - 1];
  const meta = last.meta;
  const runner = last.runner;

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
    if (isMergeAbort(err, controller.signal)) {
      logger.info('inboundQueue — turn aborted for merge', { key });
      // The new arrival that triggered the abort is already in pending.
      // Restart debounce so any further arrivals also collect into the batch.
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        void scheduleRun(key);
      }, DEBOUNCE_MS);
      return;
    }
    // BACKSTOP, never the control. The runner owns its failures (see the
    // TurnRunner contract) and answers the person itself; reaching here means
    // its own handler threw too, so nobody told them anything. It stays because
    // scheduleRun is invoked as `void scheduleRun(key)` — without it a runner
    // throw is an unhandled rejection that can take the process down and leave
    // `inFlight` set. Logged at ERROR, not warn: this is a person staring at a
    // thread that will never answer, and error-*.log is kept 30 days for
    // exactly that postmortem. It used to be a warn, which is how the 529 on
    // 2026-07-20 09:12 (Elan, D0ARUSTT6EN) went unnoticed.
    logger.error('inboundQueue — a turn threw past its own handler; the person got NOTHING', {
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
      void scheduleRun(key);
    }, DEBOUNCE_MS);
  }
}

/**
 * Is this thread mid-conversation RIGHT NOW? True when a turn is running for
 * this queue key, a batch is buffered behind an un-abortable turn, or the
 * debounce window is open.
 *
 * Read by the delivery pipeline before it posts a DELAYED follow-up (the social
 * coda, postReply.ts). That message's whole premise is a lull — the work
 * resolved or was handed off, so there is a beat of quiet in which a human
 * thing is welcome. If the person has typed again inside that beat the lull is
 * gone, and a social one-liner would land in the middle of the next exchange —
 * exactly the non-sequitur the coda split exists to remove.
 *
 * A caller must NOT consult this from inside its own turn: the turn asking the
 * question is itself the `inFlight` one. It is only meaningful from a timer
 * that fires after the runner has returned.
 */
export function isThreadActive(
  channelId: string,
  threadTs: string | undefined,
  isOneOnOneDm: boolean,
): boolean {
  const state = threadStates.get(keyFor(channelId, threadTs, isOneOnOneDm));
  if (!state) return false;
  return state.inFlight !== null || state.pending.length > 0 || state.debounceTimer !== null;
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
