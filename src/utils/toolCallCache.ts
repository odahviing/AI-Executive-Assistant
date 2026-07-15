/**
 * Tool-call cache (v2.9.2) — universal agent-loop guard against duplicate
 * tool firings within a short window.
 *
 * The pattern this exists for: owner sends a message that triggers a write
 * tool, then immediately sends a follow-up while the write is in flight.
 * inboundQueue buffers the follow-up (can't abort an in-flight write turn);
 * after turn 1 completes, turn 2 runs against the buffered message. Sonnet
 * on turn 2 sometimes misreads the follow-up as a fresh instruction and
 * re-fires the same write — could double-book, double-delete, double-move.
 *
 * Instead of adding idempotent guards inside every write tool's handler
 * (brittle — every new tool needs to remember to add one), the orchestrator
 * checks this cache BEFORE dispatching every tool call. Hit → return the
 * prior result without re-firing. Universal across present and future tools.
 *
 * Cache key: (ownerUserId, threadTs, toolName, canonicalJson(args)).
 * Cache scope: per-process Map; not persisted. Survives a turn boundary,
 * not a process restart — which is the right scope (the failure mode is
 * within-conversation rapid retries; restarts are rare and reset state).
 *
 * TTL per category:
 *   write tools → 60s. Identical writes within 60s are almost always bugs.
 *                  Sonnet's retry path + buffered-follow-up race both
 *                  resolve under this window.
 *   read tools  → 5s. Reads can legitimately re-query for fresh data
 *                  (calendar moved in Outlook, etc.). 5s suppresses
 *                  same-turn duplicate calls; doesn't mask cross-turn
 *                  fresh reads.
 */

import crypto from 'crypto';
import logger from './logger';

const WRITE_TOOLS = new Set<string>([
  // Calendar mutations
  'create_meeting',
  'move_meeting',
  'update_meeting',
  'delete_meeting',
  'book_floating_block',
  // Approval + decision side-effects (writes to requests + sends DMs)
  'create_approval',
  'resolve_approval',
  // Outbound messaging
  'message_colleague',
  // Task / routine mutations (v2.9 — the routine tools merged into manage_routine)
  'create_task',
  'update_task',
  'manage_routine',
  // Person + knowledge writes
  'update_person_profile',
  'update_person_memory',
  'note_about_person',
  'note_about_self',
  'log_interaction',
  'confirm_gender',
  'manage_preference',
  'update_my_preferences',
  'manage_knowledge',
  'manage_calendar_issue',
  'manage_working_elsewhere',
]);

const WRITE_TTL_MS = 60 * 1000;
const READ_TTL_MS = 5 * 1000;

interface CacheEntry {
  result: unknown;
  expiresAt: number;
  firstSeenAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Stable canonical JSON — same object always hashes identically. Object key
 * order is sorted; arrays preserve order; primitives serialize normally.
 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
}

function buildKey(ownerUserId: string, threadTs: string | undefined, toolName: string, args: Record<string, unknown>): string {
  const argsHash = crypto.createHash('sha256').update(canonicalJson(args)).digest('hex').slice(0, 16);
  return `${ownerUserId}|${threadTs ?? '-'}|${toolName}|${argsHash}`;
}

function ttlFor(toolName: string): number {
  return WRITE_TOOLS.has(toolName) ? WRITE_TTL_MS : READ_TTL_MS;
}

/**
 * Lookup an in-window cached result for this (owner, thread, tool, args).
 * Returns null on miss or expired entry.
 */
export function lookupRecentToolCall(input: {
  ownerUserId: string;
  threadTs?: string;
  toolName: string;
  args: Record<string, unknown>;
}): { cachedResult: unknown; ageMs: number } | null {
  const key = buildKey(input.ownerUserId, input.threadTs, input.toolName, input.args);
  const entry = cache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return { cachedResult: entry.result, ageMs: now - entry.firstSeenAt };
}

/**
 * Record a tool-call result so subsequent identical calls within TTL return
 * the cached result instead of re-firing. Called AFTER the tool succeeds.
 */
export function recordToolCall(input: {
  ownerUserId: string;
  threadTs?: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}): void {
  const key = buildKey(input.ownerUserId, input.threadTs, input.toolName, input.args);
  const now = Date.now();
  cache.set(key, {
    result: input.result,
    expiresAt: now + ttlFor(input.toolName),
    firstSeenAt: now,
  });

  // Lazy cleanup: when the cache grows past a soft cap, evict expired entries.
  // Process-memory map — no need for an interval-based sweep.
  if (cache.size > 500) {
    for (const [k, v] of cache) {
      if (v.expiresAt <= now) cache.delete(k);
    }
    if (cache.size > 500) {
      logger.info('toolCallCache — still over soft cap after sweep', { size: cache.size });
    }
  }
}

/** TEST/DEBUG only. Wipe the cache between tests. Don't use in production. */
export function _clearToolCallCacheForTests(): void {
  cache.clear();
}
