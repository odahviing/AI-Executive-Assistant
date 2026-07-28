#!/usr/bin/env node
/**
 * One-off delegated OAuth bootstrap for the email channel (#24, E1).
 *
 * Maelle's mail access is DELEGATED (authorization-code + refresh token) —
 * NOT the app-only ClientSecretCredential path calendar uses. Delegated auth
 * is scoped to whichever mailbox signs in here, by construction, so this is
 * the only setup step: one browser sign-in, no Exchange admin/RBAC action.
 * Reuses the EXISTING Azure app registration (same client id/secret/tenant
 * as calendar) — you only need to add, once, on that app registration:
 *   - API permissions → Microsoft Graph → Delegated: Mail.ReadWrite, Mail.Send
 *   - Authentication → platform "Mobile and desktop applications" →
 *     redirect URI: http://localhost:8734/callback
 * Do NOT add Mail.* APPLICATION permissions — that's the tenant-wide mode
 * this design deliberately avoids.
 *
 * Usage:
 *   node scripts/email-auth.mjs <profileName>
 *   e.g. node scripts/email-auth.mjs idan
 *
 * Prerequisites:
 *   - .env has AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
 *     (already required for calendar — nothing new to add here).
 *   - config/users/<profileName>.yaml has channels.email.enabled: true and
 *     channels.email.mailbox set to the mailbox address.
 *
 * What it does: opens a temporary localhost listener, prints a Microsoft
 * sign-in URL, waits for the OAuth redirect, exchanges the code for tokens,
 * and writes the refresh token to data/graph-mail-token.<slack_user_id>.json
 * — the exact file src/connectors/graph/mail.ts reads its seed from. After
 * this, mail.ts refreshes (and rotates) the token on its own; this script
 * never needs to run again unless the token is revoked (invalid_grant).
 *
 * Safety while the listener is open: the authorize URL carries a random
 * per-run `state`, and /callback rejects (logs + 400, keeps waiting) any
 * hit whose state doesn't match — so a stray or spoofed redirect can't be
 * mistaken for the real sign-in. The listener also gives up on its own
 * after 5 minutes if no valid redirect arrives, so it never hangs open
 * indefinitely (see "Invalid state" / "closing listener" console lines).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import yaml from 'js-yaml';

dotenv.config();

const REDIRECT_PORT = 8734;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = [
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'offline_access',
].join(' ');
// How long the listener stays open waiting for the one legitimate redirect.
const LISTEN_TIMEOUT_MS = 5 * 60 * 1000;
// Random per-run secret, round-tripped through the `state` param. Without
// this, ANY request to /callback while the listener is open — e.g. the
// operator's browser being steered through a look-alike authorize URL that
// shares this same redirect_uri (it's registered on the Azure app, not
// secret) — would be accepted and its `code` exchanged for tokens as if it
// were the real sign-in. `state` binds the redirect that comes back to the
// authorize request this run actually sent.
const expectedState = crypto.randomBytes(24).toString('hex');

function die(msg) {
  console.error(`email-auth: ${msg}`);
  process.exit(1);
}

const profileName = process.argv[2];
if (!profileName) die('usage: node scripts/email-auth.mjs <profileName>');

const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;
if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
  die('missing AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET in .env');
}

const profilePath = path.resolve(process.cwd(), 'config', 'users', `${profileName}.yaml`);
if (!fs.existsSync(profilePath)) die(`profile not found: ${profilePath}`);

let profileRaw;
try {
  profileRaw = yaml.load(fs.readFileSync(profilePath, 'utf-8'));
} catch (err) {
  die(`could not parse ${profilePath}: ${err.message}`);
}

const slackUserId = profileRaw?.user?.slack_user_id;
const mailbox = profileRaw?.channels?.email?.mailbox;
if (!slackUserId) die(`config/users/${profileName}.yaml has no user.slack_user_id`);
if (!mailbox) die(`config/users/${profileName}.yaml has no channels.email.mailbox — set it before running this`);

const authUrl = new URL(`https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/authorize`);
authUrl.searchParams.set('client_id', AZURE_CLIENT_ID);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_mode', 'query');
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('login_hint', mailbox);
authUrl.searchParams.set('state', expectedState);

console.log(`\nSign in as ${mailbox} (the MAILBOX, not your personal account), then open:\n`);
console.log(authUrl.toString());
console.log(`\nWaiting for the redirect on ${REDIRECT_URI} ...\n`);

let timeoutHandle;

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
  } catch {
    res.writeHead(400); res.end(); return;
  }
  if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

  // State check FIRST — before anything else in this request is trusted.
  // A mismatch means this hit did not originate from the authorize URL this
  // run printed above (e.g. the operator's browser landing here via some
  // OTHER sign-in flow that happens to share this same redirect_uri — it's
  // registered on the Azure app, not secret). Reject it and keep waiting —
  // don't close the listener or exit — so the real redirect (still in
  // flight) can still land and complete the sign-in.
  const gotState = url.searchParams.get('state');
  if (gotState !== expectedState) {
    console.error('email-auth: rejected a /callback hit with a missing or non-matching state param — ignoring it, still waiting for the real redirect.');
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid state.');
    return;
  }

  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Auth failed: ${error} — ${url.searchParams.get('error_description') || ''}`);
    clearTimeout(timeoutHandle);
    server.close();
    die(`authorization failed: ${error}`);
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('No code in redirect.');
    return;
  }

  try {
    const tokenRes = await fetch(`https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
      }),
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok || !tokenJson.refresh_token) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Token exchange failed — see console.');
      clearTimeout(timeoutHandle);
      server.close();
      die(`token exchange failed: ${JSON.stringify(tokenJson)}`);
      return;
    }

    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const storePath = path.join(dataDir, `graph-mail-token.${slackUserId}.json`);
    fs.writeFileSync(storePath, JSON.stringify({
      refreshToken: tokenJson.refresh_token,
      updatedAt: new Date().toISOString(),
    }, null, 2));

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Signed in. Refresh token stored — you can close this tab.');
    console.log(`\nDone. Refresh token written to ${storePath}`);
    console.log('Restart Maelle to start using the email channel.\n');
    clearTimeout(timeoutHandle);
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('email-auth: unexpected error during token exchange', err);
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Unexpected error — see console.');
    } catch { /* response may already be sent */ }
    clearTimeout(timeoutHandle);
    server.close();
    process.exit(1);
  }
});

timeoutHandle = setTimeout(() => {
  console.error(`\nemail-auth: no valid sign-in redirect received within ${LISTEN_TIMEOUT_MS / 1000}s — closing listener.`);
  server.close();
  process.exit(1);
}, LISTEN_TIMEOUT_MS);

server.listen(REDIRECT_PORT);
