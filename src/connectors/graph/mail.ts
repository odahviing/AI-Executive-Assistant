/**
 * Graph MAIL module (v4.3.0, #24) — low-level Outlook mail access, kept
 * deliberately separate from graphClient.ts (calendar).
 *
 * AUTH MODE — this is DELEGATED OAuth (authorization-code + refresh token),
 * NOT the app-only ClientSecretCredential path graphClient.ts uses for
 * calendar. Owner decision (#24): app-only Mail.* is tenant-wide and the
 * only way to narrow it is Exchange RBAC for Applications at org level —
 * every deployment of Maelle would need its IT department. Delegated auth
 * is scoped to whichever mailbox signs in, by construction — one browser
 * sign-in (scripts/email-auth.mjs), no admin. Reuses the EXISTING Azure app
 * registration (same AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
 * as calendar) with delegated Mail.ReadWrite + Mail.Send scopes added — do
 * NOT add Mail.* APPLICATION permissions to that registration.
 *
 * This module knows NOTHING about scheduling, participants, sender
 * authorization, or reply composition — it lists/reads/sends raw messages.
 * Everything else (sender gate, participant extraction, tool scoping) is a
 * different piece of work (front door / scoping), layered on top.
 *
 * Token lifecycle:
 *   - Seed refresh token comes from data/graph-mail-token.<slack_user_id>.json
 *     (written by scripts/email-auth.mjs) or, if that file doesn't exist yet,
 *     from profile.channels.email.refresh_token (yaml/env — same precedent
 *     as the Slack tokens; see userProfile.ts).
 *   - Microsoft rotates the refresh token on every redemption (verified
 *     2026-07-28 against Microsoft's docs) — every refresh persists the NEW
 *     token back to that same file so the next refresh, and the next
 *     process restart, use it instead of the one just spent.
 *   - `invalid_grant` (the stored token was revoked — admin reset / explicit
 *     revoke-all, or the 90-day confidential-client idle limit, which a
 *     ~30s poll never approaches) is surfaced as MailAuthRevokedError — a
 *     clear, logged, reportable condition. Callers must not crash-loop on
 *     it. The one caller today (connectors/graph/mailPoll.ts) reports it
 *     once, then skips that profile on every future tick — re-running
 *     scripts/email-auth.mjs alone does NOT resume polling, because that
 *     only fixes the token ON DISK. The in-memory "revoked" latch is
 *     cleared only by restarting the process, which then re-seeds
 *     initMailAuth from whatever token is on disk at that point.
 *
 * Both the token store and the delta watermark live under data/ (gitignored,
 * same as the sqlite db) — never in the committed yaml.
 */

import fs from 'fs';
import path from 'path';
import { Client } from '@microsoft/microsoft-graph-client';
import type { AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { config } from '../../config';
import type { UserProfile } from '../../config/userProfile';
import logger from '../../utils/logger';

const TOKEN_ENDPOINT = (tenantId: string) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

// offline_access is required to receive a refresh token at all. Duplicated
// (not imported) in scripts/email-auth.mjs, which can't import this TS
// module pre-build — same reason db-query.cjs is self-contained rather than
// importing src/db/*.
const MAIL_DELEGATED_SCOPES = [
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'offline_access',
];

/** Thrown when the stored refresh token is dead — revoked or past its idle
 * window. Never retry-loop on this; it needs a human to re-run
 * scripts/email-auth.mjs. */
export class MailAuthRevokedError extends Error {
  constructor(detail: string) {
    super(`Email channel refresh token is invalid/revoked: ${detail}. Re-run: node scripts/email-auth.mjs <profile>`);
    this.name = 'MailAuthRevokedError';
  }
}

// ── Token + delta persistence (data/, gitignored) ───────────────────────────

function dataDir(): string {
  return path.resolve(process.cwd(), 'data');
}

function ensureDataDir(): void {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function tokenStorePath(profileId: string): string {
  return path.join(dataDir(), `graph-mail-token.${profileId}.json`);
}

function deltaStorePath(profileId: string): string {
  return path.join(dataDir(), `graph-mail-delta.${profileId}.json`);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    logger.warn('mail.ts — failed to read store file, treating as absent', {
      filePath, err: String(err).slice(0, 160),
    });
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  try {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error('mail.ts — failed to persist store file', {
      filePath, err: String(err).slice(0, 160),
    });
  }
}

function readStoredRefreshToken(profileId: string): string | null {
  return readJsonFile<{ refreshToken: string }>(tokenStorePath(profileId))?.refreshToken ?? null;
}

function writeStoredRefreshToken(profileId: string, refreshToken: string): void {
  writeJsonFile(tokenStorePath(profileId), { refreshToken, updatedAt: new Date().toISOString() });
}

function readDeltaLink(profileId: string): string | null {
  return readJsonFile<{ deltaLink: string }>(deltaStorePath(profileId))?.deltaLink ?? null;
}

function writeDeltaLink(profileId: string, deltaLink: string): void {
  writeJsonFile(deltaStorePath(profileId), { deltaLink, updatedAt: new Date().toISOString() });
}

function clearDeltaLink(profileId: string): void {
  try {
    const p = deltaStorePath(profileId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* best-effort */ }
}

// ── Auth state (per profile, in-memory) ─────────────────────────────────────

interface MailAuthState {
  accessToken: string | null;
  accessTokenExpiresAt: number; // epoch ms
  refreshToken: string;
}

const authStates = new Map<string, MailAuthState>();

function profileIdOf(profile: UserProfile): string {
  return profile.user.slack_user_id;
}

/**
 * Seed the in-memory auth state for a profile from the durable token store
 * (preferred — reflects the latest rotation) or the yaml/env fallback.
 * Idempotent — a second call for an already-initialized profile is a no-op.
 * Throws if no refresh token is available anywhere (nothing to seed with —
 * run scripts/email-auth.mjs first).
 */
export function initMailAuth(profile: UserProfile): void {
  const profileId = profileIdOf(profile);
  if (authStates.has(profileId)) return;

  const seedToken = readStoredRefreshToken(profileId) ?? profile.channels?.email?.refresh_token;
  if (!seedToken) {
    throw new Error(
      `mail.ts — no refresh token for profile ${profileId}. Run: node scripts/email-auth.mjs <profile>`,
    );
  }

  authStates.set(profileId, { accessToken: null, accessTokenExpiresAt: 0, refreshToken: seedToken });
}

async function refreshAccessToken(profileId: string): Promise<string> {
  const state = authStates.get(profileId);
  if (!state) throw new Error(`mail.ts — auth not initialized for profile ${profileId} (call initMailAuth first)`);

  const body = new URLSearchParams({
    client_id: config.AZURE_CLIENT_ID,
    client_secret: config.AZURE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: state.refreshToken,
    scope: MAIL_DELEGATED_SCOPES.join(' '),
  });

  const res = await fetch(TOKEN_ENDPOINT(config.AZURE_TENANT_ID), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json: any = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (json?.error === 'invalid_grant') {
      logger.error('mail.ts — refresh token invalid/revoked; email channel needs re-auth', {
        profileId, description: json.error_description,
      });
      throw new MailAuthRevokedError(json.error_description || 'invalid_grant');
    }
    logger.error('mail.ts — token refresh failed', { profileId, status: res.status, error: json?.error, description: json?.error_description });
    throw new Error(`mail.ts — token refresh failed (${res.status}): ${json?.error || 'unknown error'}`);
  }

  const newAccessToken: string | undefined = json.access_token;
  if (!newAccessToken) {
    throw new Error(`mail.ts — token refresh response had no access_token (profile ${profileId})`);
  }

  // Microsoft rotates the refresh token on every redemption — persist the
  // NEW one immediately. Falls back to the token just spent only if the
  // response is missing one (shouldn't happen with offline_access, but
  // never leave the state with an unusable token).
  const newRefreshToken: string = json.refresh_token || state.refreshToken;
  state.accessToken = newAccessToken;
  // 60s safety margin so a request started right before expiry doesn't race it.
  state.accessTokenExpiresAt = Date.now() + Math.max(0, (json.expires_in ?? 0) - 60) * 1000;
  state.refreshToken = newRefreshToken;
  writeStoredRefreshToken(profileId, newRefreshToken);

  return newAccessToken;
}

function createAuthProvider(profileId: string): AuthenticationProvider {
  return {
    async getAccessToken(): Promise<string> {
      const state = authStates.get(profileId);
      if (!state) throw new Error(`mail.ts — auth not initialized for profile ${profileId} (call initMailAuth first)`);
      if (state.accessToken && Date.now() < state.accessTokenExpiresAt) return state.accessToken;
      return refreshAccessToken(profileId);
    },
  };
}

const clients = new Map<string, Client>();

function getMailClient(profile: UserProfile): Client {
  const profileId = profileIdOf(profile);
  initMailAuth(profile);
  let client = clients.get(profileId);
  if (!client) {
    client = Client.initWithMiddleware({ authProvider: createAuthProvider(profileId) });
    clients.set(profileId, client);
  }
  return client;
}

/**
 * True when a refresh token already exists for this profile — the stored
 * (rotated) file, or the yaml/env seed if the file hasn't been written yet.
 * Never throws (unlike initMailAuth). This is the gate the poll timer
 * (connectors/graph/mailPoll.ts) uses to decide whether there's anything to
 * poll — it does NOT check `channels.email.enabled` (the caller's job).
 */
export function hasMailRefreshToken(profile: UserProfile): boolean {
  const profileId = profileIdOf(profile);
  const seed = readStoredRefreshToken(profileId) ?? profile.channels?.email?.refresh_token;
  return !!seed;
}

// ── Message shape ────────────────────────────────────────────────────────────

export interface MailMessage {
  id: string;
  conversationId: string;
  subject: string;
  from: string;
  toRecipients: string[];
  /** The message's Reply-To header, normalized the same way as `from`.
   * Fetched for OBSERVABILITY ONLY (2026-07-29 — the recipient-validation
   * overturn): a reply's actual recipient no longer depends on this field at
   * all (`replyToMail` PATCHes `toRecipients` explicitly rather than relying
   * on Graph's own reply-target inference), but a `replyTo` that diverges
   * from `from` is exactly the tell for the spoofed-Reply-To attack that fix
   * closed, so callers can log it. Empty array when the message has none. */
  replyTo: string[];
  receivedDateTime: string;
  /** The message's own `body` (NOT `uniqueBody`) — uniqueBody strips the
   * quoted chain, which is exactly the history the owner asked her to read. */
  body: string;
  bodyContentType: 'html' | 'text';
  /** v4.3.x (report row 144) — Graph's OWN server-side isolation of the text
   * unique to THIS message, excluding whatever it quotes from earlier in the
   * conversation. This is the structural fact `connectors/email/inbound.ts`
   * uses to decide whether a stated timezone was actually written by the
   * current (already sender-gated) sender himself, rather than trusting a
   * classifier's guess about where in the body a snippet sat. Empty string
   * when Graph has nothing unique to report — treat empty as "nothing
   * provably new", never as "everything is new". */
  uniqueBody: string;
  uniqueBodyContentType: 'html' | 'text';
  isRead: boolean;
}

function normalizeMessage(raw: any): MailMessage {
  return {
    id: raw.id,
    conversationId: raw.conversationId ?? '',
    subject: raw.subject ?? '',
    from: raw.from?.emailAddress?.address ?? '',
    toRecipients: ((raw.toRecipients ?? []) as any[])
      .map(r => r?.emailAddress?.address)
      .filter((a): a is string => !!a),
    replyTo: ((raw.replyTo ?? []) as any[])
      .map(r => r?.emailAddress?.address)
      .filter((a): a is string => !!a),
    receivedDateTime: raw.receivedDateTime ?? '',
    body: raw.body?.content ?? '',
    bodyContentType: raw.body?.contentType === 'text' ? 'text' : 'html',
    uniqueBody: raw.uniqueBody?.content ?? '',
    uniqueBodyContentType: raw.uniqueBody?.contentType === 'text' ? 'text' : 'html',
    isRead: !!raw.isRead,
  };
}

const MESSAGE_SELECT = 'id,conversationId,subject,from,toRecipients,replyTo,receivedDateTime,body,uniqueBody,isRead';

/**
 * List messages new since the last call, via /messages/delta. The
 * @odata.deltaLink is the durable watermark — persisted to
 * data/graph-mail-delta.<profileId>.json and reused as the starting point
 * next call, so this never re-reads the whole inbox.
 *
 * On a 410 Gone (Graph's "delta token expired, resync" signal) the stored
 * link is dropped and the delta is restarted from scratch exactly once.
 */
export async function listNewMessages(profile: UserProfile): Promise<MailMessage[]> {
  const profileId = profileIdOf(profile);
  const client = getMailClient(profile);

  const runDelta = async (fromScratch: boolean): Promise<MailMessage[]> => {
    const deltaLink = fromScratch ? null : readDeltaLink(profileId);
    let response = deltaLink
      ? await client.api(deltaLink).get()
      : await client.api('/me/mailFolders/inbox/messages/delta').select(MESSAGE_SELECT).get();

    const messages: MailMessage[] = [];
    for (;;) {
      for (const raw of response.value ?? []) {
        messages.push(normalizeMessage(raw));
      }
      const nextLink = response['@odata.nextLink'];
      if (nextLink) {
        response = await client.api(nextLink).get();
        continue;
      }
      const newDeltaLink = response['@odata.deltaLink'];
      if (newDeltaLink) writeDeltaLink(profileId, newDeltaLink);
      break;
    }
    return messages;
  };

  try {
    return await runDelta(false);
  } catch (err: any) {
    const status = err?.statusCode ?? err?.code ?? err?.response?.status;
    if (status === 410 || String(err?.code) === 'ResyncRequired') {
      logger.warn('mail.ts — delta token expired (410), resyncing from scratch', { profileId });
      clearDeltaLink(profileId);
      return runDelta(true);
    }
    throw err;
  }
}

/** Mark a message read — second-layer dedup (in addition to the caller's own
 * processed-set) and a visible signal in the mailbox that Maelle handled it. */
export async function markMessageRead(profile: UserProfile, messageId: string): Promise<void> {
  const client = getMailClient(profile);
  await client.api(`/me/messages/${encodeURIComponent(messageId)}`).update({ isRead: true });
}

export interface ReplyToMailOptions {
  /** The Graph id of the message being replied to. Threading headers, the
   * quoted chain and the "Re:" subject prefix all come from Graph's own
   * createReply draft for this id — nothing here overrides any of that. */
  messageId: string;
  /** The validated recipient address (recipient-hardening overturn,
   * 2026-07-29) — the SAME address the caller already checked against the
   * one-address cap (`connections/email/index.ts::sendDirect`). PATCHed
   * explicitly onto the draft's `toRecipients` rather than left to whatever
   * Graph's createReply would infer from the original message (Reply-To when
   * present, From otherwise — a spoofed forward can set Reply-To
   * independently of the already-spoofable From this transport's sender gate
   * checks). Required, not optional: there is no caller-supplied cc/bcc
   * override here, only this one already-validated address — see the doc
   * comment on `replyToMail` below for the full reasoning. */
  to: string;
  /** HTML for the NEW text only. Graph's createReply draft already carries
   * the quoted original beneath it — do not re-supply the original body,
   * the "Re:" subject prefix, or any threading header; all three come from
   * Graph for free via `messageId`. */
  bodyHtml: string;
}

/**
 * Reply to an existing message (v4.3.0, #24 row 130a; recipient hardened
 * 2026-07-29) — createReply → patch recipient+body → send, instead of
 * POST /me/messages/{id}/reply's one-call shortcut.
 *
 * WHY createReply+patch+send OVER the one-call action: `/reply` takes a
 * single `comment` string that Graph prepends above its own quote wrapper —
 * fast, but the caller never controls the resulting HTML, only feeds a
 * comment into a template Graph owns. createReply instead returns a DRAFT
 * whose body already contains the full quoted chain (the "From/Sent/To/
 * Subject" separator Outlook readers expect), so this function inserts its
 * own HTML into that draft explicitly rather than trusting an implicit
 * prepend. The owner asked for exactly this — her new text, then the
 * complete original beneath it — and an inspectable draft gets that
 * deterministically; a one-line `comment` does not.
 *
 * Both threading headers (In-Reply-To / References) and the subject's "Re:"
 * prefix come from createReply's draft — this function never sets either by
 * hand, so there is nothing here to get wrong or drift from Graph's own
 * convention.
 *
 * RECIPIENT IS EXPLICITLY SET, NOT INFERRED — corrected 2026-07-29. This
 * paragraph used to claim there was deliberately no `to`/`cc` in
 * ReplyToMailOptions because a reply's recipient was fixed "by construction"
 * once Graph knew `messageId`. That claim was false: Graph's createReply
 * follows ordinary mail-client reply semantics and addresses a reply using
 * the original message's `Reply-To` header when present, `From` otherwise —
 * and a spoofed forward can set `Reply-To` independently of `From`. A
 * message with `From: <owner>` / `Reply-To: <attacker>` used to pass both
 * the sender gate (connectors/email/inbound.ts) and the one-address cap
 * (connections/email/index.ts::sendDirect) — both check `From`-derived
 * values — while Graph would have sent the actual reply to the Reply-To
 * attacker: the validated string and the address Graph would use were two
 * different things. Fixed at the root, not patched over: `opts.to` (the
 * exact address `sendDirect` already validated against `ownerEmailAddresses`)
 * is now PATCHed onto the draft's `toRecipients` in the same call that sets
 * the body, below, so the address Graph actually sends to is the one this
 * code wrote — never whatever Graph's own inference would have produced.
 * This is not a caller override in the sense the old comment warned against:
 * `opts.to` carries no new freedom, only the same already-validated address
 * made explicit instead of assumed.
 *
 * WIRED (#24 row 130) — `connections/email/index.ts`'s `EmailConnection.
 * sendDirect` is the only caller, and always uses this: the old always-
 * fresh-compose `sendMail` has been deleted rather than kept as a second,
 * unused send path. See that file's header for how the one-address cap is
 * validated before this function is ever called, and how `to` now carries
 * that same validated address into the actual Graph write.
 *
 * CLEANUP ON FAILURE — the update/send steps below are wrapped so a failure
 * between createReply and send deletes the already-created draft rather than
 * leaving it behind: mailPoll's delta only watches /mailFolders/inbox, so a
 * draft left in Drafts is never revisited and would otherwise accumulate
 * forever, one per failed send.
 */
export async function replyToMail(profile: UserProfile, opts: ReplyToMailOptions): Promise<void> {
  const client = getMailClient(profile);
  const draft: any = await client.api(`/me/messages/${encodeURIComponent(opts.messageId)}/createReply`).post({});
  const draftId: string = draft.id;
  const existingBody: string = draft?.body?.content ?? '';
  try {
    await client.api(`/me/messages/${encodeURIComponent(draftId)}`).update({
      // Explicit recipient override — see the doc comment above for why this
      // is load-bearing and not defensive redundancy: it replaces whatever
      // Graph's own createReply would have inferred (From or Reply-To) with
      // the address the caller already validated.
      toRecipients: [{ emailAddress: { address: opts.to } }],
      body: { contentType: 'HTML', content: insertReplyHtml(opts.bodyHtml, existingBody) },
    });
    await client.api(`/me/messages/${encodeURIComponent(draftId)}/send`).post({});
  } catch (err) {
    // createReply already left a draft behind by the time update/send can
    // fail — a bare rethrow here orphans it in the mailbox's Drafts folder
    // forever (mailPoll only watches /mailFolders/inbox, so nothing ever
    // revisits it). Best-effort delete so a transient Graph error doesn't
    // accumulate dead drafts; the delete failing is logged but never
    // swallows the original error, which is what sendDirect's catch turns
    // into `send_failed` and inbound.ts treats as never-delivered.
    try {
      await client.api(`/me/messages/${encodeURIComponent(draftId)}`).delete();
    } catch (cleanupErr) {
      logger.warn('mail.ts:replyToMail — draft cleanup after send failure also failed, orphan draft may remain', {
        draftId,
        cleanupErr: String(cleanupErr).slice(0, 200),
      });
    }
    throw err;
  }
}

/**
 * Insert the composed reply HTML at the top of the draft's existing body —
 * inside <body> when createReply returned a full document (the normal Graph
 * shape) rather than naively concatenated in front of it, which would leave
 * the new text sitting outside <html> in a technically malformed document.
 * Falls back to a plain prepend when no <body> tag is found (a bare
 * fragment, which Graph can also return for a message with no prior
 * content) — still correct, just simpler.
 */
function insertReplyHtml(newHtml: string, existingBody: string): string {
  const bodyOpen = existingBody.match(/<body[^>]*>/i);
  if (!bodyOpen) return newHtml + existingBody;
  const insertAt = bodyOpen.index! + bodyOpen[0].length;
  return existingBody.slice(0, insertAt) + newHtml + existingBody.slice(insertAt);
}
