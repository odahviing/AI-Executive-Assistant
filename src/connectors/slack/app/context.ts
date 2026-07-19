/**
 * Shared context + parameter types for the extracted Slack inbound layer.
 *
 * app.ts (createSlackAppForProfile) builds ONE SlackAppContext and threads it
 * to the extracted helpers / message processor / handlers. Everything that used
 * to be a closure over the factory body (profile, app, the live botUserId, the
 * colleague-test Set, and the cross-referencing helper fns) is reached through
 * this object. botUserId is a LIVE getter — it is set asynchronously by the
 * startup auth.test and must never be snapshotted.
 */

import type { App } from '@slack/bolt';
import type { UserProfile } from '../../../config/userProfile';
import type { AnthropicImageBlock, DownloadedImage } from '../../../vision';

  // Role-based access:
  //   'owner'     → the user this assistant belongs to — full access
  //   'colleague' → anyone else in the workspace — can request meetings, ask availability
export type SenderRole = 'owner' | 'colleague';

/** Params for the shared message processor. */
export interface ProcessMessageParams {
    senderId: string;
    text: string;
    channelId: string;
    ts: string;
    threadTs: string;
    say: Function;
    client: App['client'];
    isChannel: boolean;
    isMpim?: boolean;
    mpimMemberIds?: string[];  // all non-bot member IDs when in MPIM
    // v3.2.6 (#14) — true when this turn arrived via app_mention (an explicit
    // @Maelle). An explicit mention is unambiguously addressed to her, so the
    // group-DM/channel addressee gate (which silences messages aimed at a human)
    // must be skipped — otherwise a mid-thread thread-action mention, whose bot
    // <@id> was stripped from the text and where Maelle hasn't spoken yet, gets
    // mis-judged HUMAN/AMBIGUOUS and dropped.
    isExplicitMention?: boolean;
    voiceInput?: boolean;      // true if input came from a voice message
    images?: AnthropicImageBlock[];  // v1.7.1 — image content blocks attached to this turn
    imageUrls?: string[];            // v2.5.2 — Slack url_private per attached image, persisted to history so Sonnet can forward via message_colleague.attachments
}

/** Params for the image file_share helper. */
export interface ProcessImageFileShareParams {
    files: any[];
    message: any;
    channelId: string;
    ts: string;
    threadTs: string;
    client: App['client'];
    isMpim: boolean;
    mpimMemberIds?: string[];
}

/** Params for the per-image injection guard. */
export interface ScanAndPrepareImageParams {
    dl: DownloadedImage;
    senderId: string;
    senderRole: SenderRole;
    channelId: string;
    threadTs: string;
    post: (text: string) => Promise<void>;
}

/**
 * The threading scaffold passed to every extracted function. The factory owns
 * the mutable state (colleagueTestThreads, the live botUserId) and binds the
 * cross-referencing helpers as methods so moved bodies keep calling them by name.
 */
export interface SlackAppContext {
  profile: UserProfile;
  app: App;
  colleagueTestThreads: Set<string>;
  /** LIVE — set asynchronously by the startup auth.test; never snapshot. */
  readonly botUserId: string | null;
  getSenderRole(senderId: string): SenderRole;
  resolveSlackMentions(text: string): Promise<string>;
  processMessage(params: ProcessMessageParams): Promise<void>;
  processImageFileShare(params: ProcessImageFileShareParams): Promise<void>;
  scanAndPrepareImage(params: ScanAndPrepareImageParams): Promise<AnthropicImageBlock | null>;
}
