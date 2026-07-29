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
    /**
     * What the PERSON actually typed for this turn (mentions resolved, voice
     * transcribed). Machine framing never belongs in here — it goes in
     * `framing` below. The split is load-bearing, not cosmetic: this is the
     * string the owner's shadow mirror renders back to him as `X said: "…"`,
     * so anything fused into it is read as the sender's own words.
     */
    text: string;
    /**
     * The machine-written, MODEL-facing framing this turn carries: the MPIM
     * `<<GROUP DM — participants: …>>` preamble, the `[THREAD PARTICIPANTS: …]`
     * roster, the `<<THREAD ACTION …>>` directive, attached-file reference
     * blocks. processMessage composes it around `text` exactly once, for the
     * audiences that need it (the model, history, the inbound queue's merge)
     * and for no one else.
     *
     * A handler that adds framing MUST declare it here instead of
     * concatenating it into `text`. GH #150: the group-DM preamble was fused
     * in, so the owner's shadow DM showed his colleague "saying" ~360
     * characters of Maelle's own instructions — and since that overran the
     * 350-char preview cap, the colleague's real words never appeared at all.
     * Reverse-engineering the preamble back out at each consumer is not the
     * answer: the thread-action directive's roster and TASK body carry no
     * delimiters, so only the side that BUILT the framing can say where the
     * person's words start.
     */
    framing?: { prefix?: string; suffix?: string };
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
    /**
     * Catch-up only (registerInboundReplayHandler). Live paths (DM/MPIM/mention)
     * leave this unset and keep the original behavior: any image download
     * failure aborts the whole turn, text included. Replay sets this true so a
     * missed message that merely failed to fetch/attach an image still reaches
     * processMessage with its text — the owner's ruling was to exempt catch-up
     * from dropping an answerable question over an unrelated download failure.
     * This does NOT touch the security path: a colleague image flagged by
     * scanAndPrepareImage is a verdict, not a fetch failure, and keeps failing
     * closed (image dropped, refusal posted, text NOT answered) regardless of
     * this flag — see the `securityRefused` handling in fileIngestion.ts.
     */
    degradeOnDownloadFailure?: boolean;
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
