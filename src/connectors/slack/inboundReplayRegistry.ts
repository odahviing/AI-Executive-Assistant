/**
 * Inbound-replay registry.
 *
 * The on-restart catch-up (core/background.ts) must NOT reimplement the live
 * inbound path (transcribe voice/video, download images, run the orchestrator,
 * post the reply). That was duplicate code that silently drifted — it dropped
 * voice/video/image recovery entirely. Instead, the Slack app registers ONE
 * replay function (a closure over the same `processMessage` + ingestion helpers
 * the live listener uses), and catch-up just hands it each detected missed
 * message. One path, two callers (live event + replay).
 *
 * Mirrors the Connection registry pattern (per-profile Map) so background.ts
 * never imports from connectors/slack/app.
 */

/** A missed message replayed through the live inbound path. */
export interface InboundReplayParams {
  /** The raw Slack message object (from conversations.history/replies). */
  message: Record<string, unknown>;
  /** The channel the message lives in (history rows don't carry `.channel`). */
  channelId: string;
  /** Where the reply should thread (the message ts for a DM, the panel parent for a panel thread). */
  postThreadTs: string;
  /** For the "↩ Catching up …" caption framing. */
  source: 'dm' | 'assistant_panel' | 'mpim' | 'channel';
  /**
   * Surface flags — widened 2026-08-18 (S9, downtime catch-up for groups).
   * `core/background.ts` only ever produces a `mpim`/`channel` candidate when
   * the message @-mentioned the bot, so these always carry `isExplicitMention:
   * true` downstream (see the replay handler) — the same treatment a live
   * @mention gets, so the addressee gate, authority and surface all resolve
   * exactly as they would have live. Undefined for `dm`/`assistant_panel`,
   * unchanged from before this widening.
   */
  isMpim?: boolean;
  isChannel?: boolean;
  mpimMemberIds?: string[];
}

export type InboundReplayFn = (params: InboundReplayParams) => Promise<void>;

const registry: Map<string, InboundReplayFn> = new Map();

/** Called by the Slack app at startup, once processMessage + helpers exist. */
export function registerInboundReplay(profileId: string, fn: InboundReplayFn): void {
  registry.set(profileId, fn);
}

export function getInboundReplay(profileId: string): InboundReplayFn | undefined {
  return registry.get(profileId);
}
