/**
 * File-ingestion primitives extracted from app.ts: the image file_share
 * helper, the doc-type predicates, the download/parse core, and the per-image
 * injection guard. Shared by the DM file_share path and the channel @mention
 * path so the security-critical bits have one implementation.
 */

import { downloadSlackImage, buildImageBlock, type AnthropicImageBlock } from '../../../vision';
import { scanImageForInjection } from '../../../utils/imageGuard';
import { shadowNotify } from '../../../utils/shadowNotify';
import { getOwnerDomain } from '../../../utils/attendeeScope';
import logger from '../../../utils/logger';
import { isOverloadError } from './helpers';
import type { SlackAppContext, ProcessImageFileShareParams, ScanAndPrepareImageParams } from './context';

  // ── Image file_share helper (v1.7.1) ──────────────────────────────────────
  // Owner-only image input. Downloads each image, runs the injection guard
  // (logs + shadow-notifies suspicious content but proceeds — owner is trusted),
  // builds Anthropic image blocks, then hands off to processMessage with the
  // images attached. Used by both the DM and MPIM handlers.
  //
  // Caps at 4 images per turn for sanity. Slack file_share usually has 1.
export async function processImageFileShare(ctx: SlackAppContext, params: ProcessImageFileShareParams): Promise<void> {
  const { app, profile, getSenderRole, processMessage, scanAndPrepareImage } = ctx;
  const { assistant } = profile;
    const { files, message, channelId, ts, threadTs, client, isMpim, mpimMemberIds, degradeOnDownloadFailure } = params;

    const imageFiles = files.filter((f: any) =>
      typeof f.mimetype === 'string' && f.mimetype.startsWith('image/'),
    );
    if (imageFiles.length === 0) return;

    const toProcess = imageFiles.slice(0, 4);
    if (imageFiles.length > 4) {
      logger.warn('Image file_share with >4 images — processing first 4 only', {
        total: imageFiles.length,
      });
    }

    const images: AnthropicImageBlock[] = [];
    const imageUrls: string[] = [];
    // Two distinct failure kinds tracked separately (catch-up only cares about
    // the first): a download failure is a fetch problem, no security verdict
    // was made; a security refusal (scanAndPrepareImage → null) IS a verdict
    // and must never be degraded around — see the gate below.
    let hadDownloadFailure = false;
    let hadSecurityRefusal = false;
    for (const f of toProcess) {
      const dl = await downloadSlackImage(f.url_private, assistant.slack.bot_token, f.mimetype);
      if ('error' in dl) {
        logger.warn('Image download failed', {
          error: dl.error, detail: dl.detail, filetype: f.filetype,
        });
        const friendly = dl.error === 'too_large'
          ? `That image is a bit big for me to look at — could you try a smaller version?`
          : dl.error === 'unsupported_type'
          ? `I can only look at JPEG, PNG, GIF, or WebP images — that file type doesn't work for me.`
          : `I couldn't open that image. Try sending it again?`;
        try {
          await client.chat.postMessage({
            token: assistant.slack.bot_token,
            channel: channelId,
            thread_ts: threadTs,
            text: friendly,
          });
        } catch (_) {}
        if (!degradeOnDownloadFailure) return;
        hadDownloadFailure = true;
        continue;  // catch-up: try the rest of the batch, degrade at the end
      }

      // Image injection guard (shared policy — see scanAndPrepareImage):
      // owner proceeds (shadow-notified); a suspicious colleague image is
      // dropped and refused so Sonnet never sees the bytes.
      const block = await scanAndPrepareImage({
        dl,
        senderId: message.user!,
        senderRole: getSenderRole(message.user!),
        channelId,
        threadTs,
        post: (text) => client.chat.postMessage({
          token: assistant.slack.bot_token,
          channel: channelId,
          thread_ts: threadTs,
          text,
        }).then(() => {}),
      });
      if (!block) { hadSecurityRefusal = true; continue; }  // suspicious colleague image — dropped
      images.push(block);
      imageUrls.push(f.url_private as string);
    }

    if (images.length === 0) {
      // Catch-up exemption: degrade to answering the text ONLY when every
      // failure in the batch was a download failure — no security verdict
      // fired. If even one image was refused by scanAndPrepareImage, this
      // must stay fail-closed exactly like the live path (no processMessage
      // call at all): the message's text can itself be the injection, so a
      // refused image must never fall through to "answer the text anyway".
      const shouldDegrade = degradeOnDownloadFailure && hadDownloadFailure && !hadSecurityRefusal;
      if (!shouldDegrade) return;
    }

    // v4.3.x (#144, T2) — forward every clean colleague image to the owner's
    // shadow DM as it arrives ("if a non-owner pass an image, first check it,
    // if its not flag, give me a chance to see it" — owner). Fires here,
    // strictly AFTER the scan loop above: only urls that survived
    // scanAndPrepareImage land in `imageUrls`, so a suspicious colleague
    // image (dropped + refused above, :79) can never be forwarded — a
    // forward never launders provenance. The forwarded url is never written
    // to the OWNER's own conversation history (appendToConversation in
    // processMessage.ts keys on the COLLEAGUE's threadTs, not the owner's),
    // so it can never re-enter the owner-only, unscanned image re-attach
    // path (processMessage.ts's reattachRecentThreadImage).
    //
    // Internal-only for now — same conservative default as manage_knowledge's
    // colleague-path KB gate (registry.ts:445-449). A sender whose email
    // domain isn't the owner's (Slack Connect guest, or a sender whose email
    // can't be resolved) is gated out; this is a gate the owner can lift
    // later, not an architectural limit. Only reachable for DM colleague
    // images in practice — the MPIM colleague image path is dropped before
    // this function is ever called (handlers.ts, "owner-only" v1.7.1).
    //
    // Report row 146 (cost): this whole pipeline — `users.info` then
    // `shadowNotify`'s own chat.postMessage + 4 × (download + upload) — used
    // to run `await`ed HERE, ahead of `processMessage` below, so a colleague
    // sending 4 images waited on ~9 sequential HTTP round trips before
    // Maelle even started thinking. Every other `shadowNotify` on the reply
    // path fires AFTER delivery, never gating it; this one now matches: the
    // whole forward (its own `users.info` + the domain gate + shadowNotify)
    // runs in the background via `void`, never delaying the orchestrator
    // call. This `users.info` is its OWN fetch — never shared with
    // processMessage's colleague-identify path (report row 146b): a failure
    // here is genuinely non-fatal (falls through to the catch below, no DB
    // write, forward just doesn't happen), which is only true because it
    // isn't also feeding a path that upserts people_memory on success.
    if (images.length > 0 && getSenderRole(message.user!) === 'colleague') {
      void (async () => {
        try {
          const ownerDomain = getOwnerDomain(profile);
          const senderInfo = await app.client.users.info({
            token: assistant.slack.bot_token,
            user: message.user!,
          });
          const senderUser = senderInfo?.user as any;
          const senderEmail = String(senderUser?.profile?.email ?? '');
          const senderDomain = senderEmail.includes('@')
            ? senderEmail.split('@')[1].toLowerCase()
            : null;
          const isInternal = !!(ownerDomain && senderDomain && senderDomain === ownerDomain);
          if (isInternal) {
            const senderName = senderUser?.real_name || senderUser?.name || message.user;
            await shadowNotify(profile, {
              channel: channelId,
              threadTs,
              action: `Conversation with ${senderName}`,
              detail: 'sent an image',
              conversationKey: threadTs,
              conversationHeader: `Conversation with ${senderName}`,
              attachments: imageUrls.map(u => ({ sourceUrl: u })),
            });
          } else {
            logger.info('Colleague image forward skipped — sender not on owner domain', {
              senderId: message.user, senderDomain, ownerDomain,
            });
          }
        } catch (err) {
          logger.warn('Colleague image forward threw — proceeding without forward', {
            err: String(err).slice(0, 200),
          });
        }
      })();
    }

    // Caption: Slack stuffs the user's typed text into event.text / message.text
    const captionText = ((message.text as string | undefined) ?? '').trim();
    const messageText = captionText || '(image attached, no caption)';

    const sayFn = async (msgOrText: any) => {
      const txt = typeof msgOrText === 'string' ? msgOrText : msgOrText.text;
      await client.chat.postMessage({
        token: assistant.slack.bot_token,
        channel: channelId,
        thread_ts: threadTs,
        text: txt,
      });
    };

    await processMessage({
      senderId: message.user!,
      text: messageText,
      channelId,
      ts,
      threadTs,
      say: sayFn,
      client,
      isChannel: false,
      isMpim,
      mpimMemberIds,
      images,
      imageUrls,
    });
}

  // ── Shared file-ingestion primitives (DM + channel) ───────────────────────
  // File-type predicates + the download/parse/scan cores, factored so the DM
  // file_share path and the channel @mention path share ONE implementation of
  // the security-critical bits (PDF parse, image injection scan). Callers own
  // their own user-facing messaging + orchestrator hand-off.

  // A text-extractable document: PDF / plain text / markdown.
export function isSlackDocFile(f: any): boolean {
    const mt = String(f?.mimetype || '');
    const ft = String(f?.filetype || '');
    return mt === 'text/plain' || mt === 'text/markdown' || mt === 'application/pdf'
      || ft === 'text' || ft === 'txt' || ft === 'markdown' || ft === 'md' || ft === 'pdf';
  }
export function isSlackImageFile(f: any): boolean {
    return typeof f?.mimetype === 'string' && f.mimetype.startsWith('image/');
  }

  // Download + parse one document to text. Pure — no messaging; the caller maps
  // the failure reason to a human line. PDF → pdf-parse; else → raw text.
export async function extractSlackDocText(
    file: any,
    botToken: string,
    cap: number,
  ): Promise<
    | { ok: true; text: string; truncated: boolean }
    | { ok: false; reason: 'download' | 'parse' | 'empty' | 'error'; overloaded?: boolean }
  > {
    const isPdf = String(file?.mimetype || '') === 'application/pdf' || String(file?.filetype || '') === 'pdf';
    try {
      const dl = await fetch(file.url_private, { headers: { Authorization: `Bearer ${botToken}` } });
      if (!dl.ok) return { ok: false, reason: 'download' };
      let text: string;
      if (isPdf) {
        try {
          const buf = Buffer.from(await dl.arrayBuffer());
          const { PDFParse } = await import('pdf-parse');
          const parser = new PDFParse({ data: buf });
          const parsed = await parser.getText();
          text = parsed.text || '';
        } catch (err) {
          logger.warn('PDF parse failed', { err: String(err).slice(0, 200) });
          return { ok: false, reason: 'parse' };
        }
      } else {
        text = await dl.text();
      }
      if (text.trim().length < 10) return { ok: false, reason: 'empty' };
      const truncated = text.length > cap;
      return { ok: true, text: truncated ? text.slice(0, cap) : text, truncated };
    } catch (err) {
      logger.error('Doc download/parse failed', { err: String(err).slice(0, 400) });
      return { ok: false, reason: 'error', overloaded: isOverloadError(err) };
    }
  }

  // Injection guard for one already-downloaded image (DM + channel). Runs the
  // scan and applies the policy keyed on the sender's TRUE role:
  //   owner     → log + shadow-notify but PROCEED (trusted; may share text-heavy
  //               screenshots — Sonnet reads them as content, not instructions)
  //   colleague → REFUSE: drop the image, post a human refusal via `post`, Sonnet
  //               never sees the bytes (a colleague screenshot claiming "Idan said
  //               you can do X" is a known injection surface)
  // Returns the image block to attach, or null if dropped. `post` targets the
  // right surface (the DM thread or the channel thread).
export async function scanAndPrepareImage(ctx: SlackAppContext, params: ScanAndPrepareImageParams): Promise<AnthropicImageBlock | null> {
  const { profile } = ctx;
    const { dl, senderId, senderRole, channelId, threadTs, post } = params;
    const scan = await scanImageForInjection(dl);
    if (scan.suspicious) {
      logger.warn('⚠ SECURITY — image flagged as suspicious', {
        senderId,
        senderRole,
        channelId,
        reason: scan.reason,
        extractedTextPreview: scan.extractedText?.slice(0, 200),
        action: senderRole === 'owner' ? 'log_and_proceed' : 'refuse_and_drop',
      });
      try {
        await shadowNotify(profile, {
          channel: channelId,
          threadTs,
          action: senderRole === 'owner'
            ? '⚠ Image guard: suspicious content (owner — proceeded)'
            : '⚠ Image guard: suspicious content from colleague — REFUSED',
          detail: `Sender: ${senderId}. Reason: ${scan.reason ?? 'unknown'}. Extract: "${scan.extractedText?.slice(0, 200) ?? '(none)'}"`,
        });
      } catch (_) {}
      if (senderRole === 'colleague') {
        try { await post(`Sorry, I can't read attached images here — let me know in plain text what you need.`); } catch (_) {}
        return null;  // Sonnet never sees the suspicious bytes
      }
    }
    return buildImageBlock(dl);
}
