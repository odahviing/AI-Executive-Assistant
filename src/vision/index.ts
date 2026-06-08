/**
 * Vision module (v1.7.1) — Slack image input.
 *
 * Parallel to src/voice/ for the audio path. Where voice transcribes-then-discards,
 * vision keeps the image bytes live for the current turn so Sonnet sees the
 * actual pixels (exact error text, UI layout, log lines). The image is NOT
 * persisted in conversation history — see app.ts for the placeholder write.
 *
 * Owner-only in v1.7.1. When colleague paths open (issue #1 Connection work),
 * the image guard policy in src/utils/imageGuard.ts flips from log-and-proceed
 * to refuse-and-notify; this module itself stays transport-agnostic.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../llm/client';
import { logLlmUsage } from '../utils/usageLog';
import logger from '../utils/logger';

const anthropic = getAnthropicClient();

export const SUPPORTED_IMAGE_MIMETYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

// Anthropic vision limit per image. Anything bigger gets a friendly DM back.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface DownloadedImage {
  buffer: Buffer;
  mimetype: ImageMediaType;
  bytes: number;
}

export type ImageDownloadFailure = {
  error: 'unsupported_type' | 'too_large' | 'download_failed';
  detail: string;
};

export type AnthropicImageBlock = Anthropic.ImageBlockParam;

/**
 * Download a Slack image file and return the buffer + normalised mimetype.
 * Returns an error object instead of throwing — caller decides what to tell
 * the user (size limit hit → "could you try a smaller version", etc).
 */
export async function downloadSlackImage(
  fileUrl: string,
  botToken: string,
  mimetype: string,
): Promise<DownloadedImage | ImageDownloadFailure> {
  const baseType = (mimetype ?? '').split(';')[0].trim().toLowerCase();
  if (!SUPPORTED_IMAGE_MIMETYPES.includes(baseType as ImageMediaType)) {
    return {
      error: 'unsupported_type',
      detail: `${baseType || '(unknown)'} not supported (jpeg/png/gif/webp only)`,
    };
  }

  try {
    const response = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!response.ok) {
      return { error: 'download_failed', detail: `HTTP ${response.status} ${response.statusText}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > MAX_IMAGE_BYTES) {
      return {
        error: 'too_large',
        detail: `${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds 5MB limit`,
      };
    }

    if (!contentType.startsWith('image/')) {
      logger.warn('Slack returned non-image content for image download', {
        contentType,
        bytes: buffer.length,
      });
      return { error: 'download_failed', detail: `expected image, got ${contentType}` };
    }

    logger.info('Slack image downloaded', {
      mimetype: baseType,
      contentType,
      bytes: buffer.length,
    });
    return { buffer, mimetype: baseType as ImageMediaType, bytes: buffer.length };
  } catch (err) {
    return { error: 'download_failed', detail: String(err) };
  }
}

/**
 * Build an Anthropic image content block from a downloaded image buffer.
 * The block goes inside a user message's content array alongside the text part.
 */
export function buildImageBlock(image: DownloadedImage): AnthropicImageBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mimetype,
      data: image.buffer.toString('base64'),
    },
  };
}

/**
 * Extract a compact text description of an image at INGESTION time so it can be
 * persisted into conversation history like any other message text.
 *
 * Image bytes are native-multimodal for ONLY the turn they arrive (see the
 * placeholder write in connectors/slack/app.ts) — so anything the image
 * contained that the reply didn't restate is lost on the next turn (the
 * "book me 25 mins" + screenshot bug: turn 2 "online" had no subject/time/
 * attendees left). Persisting this description means the image's content rides
 * the SAME conversation-history path as a normal message; nothing else changes.
 *
 * Tuned for ACTIONABLE detail (names, dates, times, durations, subjects,
 * locations, numbers, the ask) so a follow-up turn still has what it needs.
 * Fails soft → returns null and the caller falls back to the bare placeholder.
 */
export async function describeImage(block: AnthropicImageBlock): Promise<string | null> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 220,
      messages: [{
        role: 'user',
        content: [
          block,
          {
            type: 'text',
            text:
              'Describe this image in ONE compact line of plain text, capturing every ACTIONABLE detail an executive assistant would need later: people/names, dates, days, times, durations, meeting subject, locations, numbers, and what is being asked or decided. If it is a screenshot of a chat or email, summarize who is involved and the key content. No preamble, no markdown, no quotes — just the single descriptive line.',
          },
        ],
      }],
    });
    logLlmUsage('image_describe', 'claude-haiku-4-5-20251001', response);
    const text = ((response.content[0] as Anthropic.TextBlock)?.text ?? '').trim().replace(/\s+/g, ' ');
    return text || null;
  } catch (err) {
    logger.warn('describeImage — vision pass threw', { err: String(err).slice(0, 200) });
    return null;
  }
}
