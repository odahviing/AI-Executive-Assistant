# WhatsApp transport — build spec

> Status: SPEC (design complete, not built). Authored by the feature/design chat.
> Build in a focused build chat; verification plan is at the bottom.
> Shape mirrors `.claude/PERSON_STORE_PROJECT.md` / `.claude/WORKING_ELSEWHERE_MODE.md`.

---

## 1. Problem

Maelle today is Slack-only. The owner wants her reachable on **WhatsApp** as a
first-class peer transport — the same concept as Slack, with one carve-out:

- The **owner** can talk to Maelle on WhatsApp (text + voice), in and out.
- **Other people** can reach Maelle on WhatsApp to book/coordinate with the
  owner — exactly like a colleague DMing her on Slack.
- Maelle can be **added to a WhatsApp group** with the owner + one or more
  people and told to book a meeting (the MPIM equivalent).
- **NOT** passive channel/group monitoring — she does not "listen" in groups for
  digests. She only participates in a group when it's about booking with the
  people in it.

This is the **first non-Slack `Connection`** and the proof that the v2.0
transport abstraction holds. The architecture was built for this: skills never
import from `connectors/slack/*`; everything outbound routes through
`getConnection(ownerId, 'slack')` and the router (`src/connections/router.ts`)
already has a `whatsapp` branch.

### Why this is a HIGH-robustness-risk feature (design accordingly)

A new transport re-introduces every axis that produced the last 2 months of
bugs: **threading/routing, identity, autonomy, privacy.** The single biggest
new risk is **trust**: on Slack, `getSenderRole` (`app.ts:111`) trusts the
Slack workspace's authentication of the sender's identity. **On WhatsApp there
is no such authentication — the phone number IS the identity, and anyone who
has Maelle's number can message her and claim to be anyone.** The spec's job is
to make that safe.

---

## 2. Library decision (owner-chosen) + its consequences

**Keep `whatsapp-web.js`** (already a dependency; placeholder at
`src/connectors/whatsapp.ts`). Unofficial linked-device approach: scan a QR with
the owner's phone, runs a headless Chrome (puppeteer), `LocalAuth` persists the
session.

Consequences the build MUST design around:

- **No 24h-window / no template-message constraint.** (That's an *official* Cloud
  API limitation.) Maelle can send proactive messages to anyone she has a number
  for — which is exactly what makes ban-risk + abuse the thing to guard, not API
  rules.
- **Ban / ToS risk.** Mass or spammy outbound can get the number banned. Keep
  outbound conservative and human-paced; never blast.
- **Session brittleness.** Chrome can crash; WhatsApp can invalidate the linked
  device (logout, version drift). Auth loss must **fail loud** (DM the owner on
  Slack: "WhatsApp disconnected — re-scan the QR") and must **never crash the
  process** (see the 3.2.4 crash-resilience lesson, `src/index.ts`).
- **Owner's phone must stay online.** Linked-device requires the phone reachable.
  Out of scope to fix; document it.

---

## 3. Scope

### In scope (v1)
1. **Owner front-door** — owner ↔ Maelle on WhatsApp, text + voice, parity with
   the Slack owner path (briefs, scheduling, all owner tools).
2. **Inbound from others** — a non-owner messages Maelle's WhatsApp to coordinate
   with the owner; runs the colleague path (security gate, coord guard, rate
   limits, coordinate_meeting), parity with a Slack colleague DM.
3. **Group coordination** — Maelle added to a WhatsApp group → MPIM-equivalent
   coordination among the group members + owner. Reuses the existing
   `isMpim` / `isOwnerInGroup` / `mpimMemberIds` machinery in the orchestrator.
4. **`WhatsAppConnection implements Connection`** — registered in the connection
   registry so the router can pick WhatsApp for outbound to people who have a
   number on file (e.g. a colleague who reached her on WhatsApp gets replies on
   WhatsApp — context-wins routing, `router.ts` layer 1).
5. **Phone↔person identity** — extend the person store so a phone number resolves
   to a known person, and an unknown phone is handled safely.
6. **Multi-tenant / de-tenant** — per-profile config, no global env, no hardcoded
   paths.

### Out of scope (v1) — name explicitly so the build doesn't creep
- Passive group/channel monitoring or digests (owner's carve-out).
- Official Cloud API / Twilio migration.
- Inbound images → the full vision pipeline (Slack-only today). Voice IS in scope
  (placeholder already transcribes). Inbound images: acknowledge + ask to send on
  Slack, or defer to phase 2.
- WhatsApp-initiated *cold* outreach to strangers (only reply/coordinate with
  people already in a conversation or on file).
- Reactions polish, read receipts, presence beyond a basic typing indicator.

---

## 4. Design

### 4.1 Two halves, mirroring Slack

| | Slack | WhatsApp (build this) |
|---|---|---|
| Inbound | `connectors/slack/app.ts` (Bolt socket) | `connectors/whatsapp.ts` (whatsapp-web.js `message` event) — rewrite the placeholder |
| Outbound | `connections/slack/index.ts` `SlackConnection` | NEW `connections/whatsapp/index.ts` `WhatsAppConnection implements Connection` |
| Registered | `registerConnection(ownerId, createSlackConnection(...))` (`app.ts:77`) | `registerConnection(ownerId, createWhatsAppConnection(...))` at startup |

The placeholder (`src/connectors/whatsapp.ts`) is **unwired dead code** (nothing
imports `startWhatsApp`). It is a *starting point for the inbound half only* and
needs heavy rework (it's owner-only, fakes `channel:'slack'`, hardcodes `/tmp/`,
reads a global `WHATSAPP_OWNER_PHONE`, and is not a `Connection`).

### 4.2 `WhatsAppConnection implements Connection` (the outbound half)

Implement against `src/connections/types.ts`. Recipient refs are **phone numbers
in WhatsApp JID form** (`<phone>@c.us`).

- `sendDirect(phone, text, opts)` → `client.sendMessage('<phone>@c.us', text)`.
  Honors `opts.attachments` (re-upload via `MessageMedia`) where feasible.
  Ignores `cc`/`bcc`/`subject` (per the interface contract: "transports MUST
  ignore fields they don't support").
- `sendBroadcast(phones, text)` → N individual sends, one `SendResult` each.
- `sendGroupConversation(phones, text)` → create/locate a WhatsApp group with the
  members + post. **This is the proactive-group path** (Maelle starts a group to
  coordinate). whatsapp-web.js: `client.createGroup(name, [contactIds])`. If
  group creation isn't reliable, fall back to `sendBroadcast` (the interface
  explicitly allows this).
- `postToChannel(...)` → `{ ok:false, reason:'not_supported' }` (no channels).
- `findUserByName(query)` → WhatsApp has **no searchable directory**. Return `[]`.
  (Name→phone resolution comes from the person store, not the transport.)
- `findChannelByName(...)` → `[]`.
- `collectCoreInfo(phone)` → optional: WhatsApp profile name + (if available)
  profile photo URL → `{ displayName, imageUrl }` for gender fallback. Best-effort.
- `reactToMessage(chatId, msgId, emoji)` → whatsapp-web.js supports message
  reactions; implement the ✅-on-completion touch.

### 4.3 Identity — phone ↔ person (THE core hard part)

`resolvePerson` (`db/people.ts:635`) matches `slack_id → email → fuzzy name` and
**does not take phone today**, even though `people_memory.phone` already exists
(`client.ts:784`). Extend it:

- Add `phone?` to `ResolvePersonInput` (`people.ts:603`) and a `getPersonByPhone`
  helper.
- Insert a **phone match step** in `resolvePerson` (after slack_id, alongside
  email — phone is a strong logical key like email). Merge-by-attach: if matched
  by name/email and we now learn a phone, attach it.
- Normalize phone to E.164 before storing/matching (strip `@c.us`, leading `+`,
  spaces) — one canonical form, decided in code (multi-tenant safe).

**Inbound sender resolution** (replaces the placeholder's owner-only filter):
1. Normalize `message.from` → phone.
2. If phone === `profile.user.whatsapp_phone` → **owner**.
3. Else `resolvePerson({ phone, name: waProfileName })`:
   - Resolves to a **known person** → colleague path with that identity.
   - No match → **unknown external** (see trust model below).

### 4.4 Trust model (the security invariant — design this first)

Slack authenticates senders; WhatsApp does not. Rules:

- **Owner** — authenticated by the linked-device pairing (only the owner's phone
  is linked). Full owner path. Safe.
- **Known person** (phone on file) — colleague path, same gates as Slack
  (securityGate, coordGuard, rate limits). The phone-on-file is a *weak*
  authenticator (numbers can be spoofed via porting, but that's a high bar);
  acceptable for coordination, same as trusting a Slack handle.
- **Unknown phone** — the dangerous case. **Maelle does not act on a coordination
  request from an unknown number on her own.** Options for the build (pick one,
  flagged in §10):
  - (A) Maelle replies asking who they are, and **routes the request to the owner
    for confirmation** (`create_approval` kind=freeform: "an unknown number
    +972… says they're Yael and wants to book with you — proceed?") before any
    calendar action. **Recommended** — owner-in-the-loop is the safe default and
    reuses the approval spine.
  - (B) Maelle only engages numbers the owner has pre-introduced / on file; others
    get a polite "I can't help with that here."
- The existing `securityGate` impersonation regex + `coordGuard` LLM judge run on
  the colleague path regardless — but they are a backstop, not the primary
  control. The primary control is **unknown-phone → owner approval.**
- **Never** expose owner calendar detail / whereabouts to a WhatsApp sender that
  the Slack path wouldn't (the existing free/busy gates already enforce this;
  don't add a WhatsApp bypass).

### 4.5 No-threads model

WhatsApp has **no threads.** A 1:1 chat is one continuous conversation; a group
is one continuous conversation. The spine and the orchestrator assume a
`threadTs`. Mapping:

- **`threadTs` = the WhatsApp chat id** (stable per conversation: `<phone>@c.us`
  for 1:1, `<groupid>@g.us` for groups). This is what the placeholder already
  does for the owner 1:1 (`threadTs = channelId`); generalize it.
- **`channelId`** = same chat id.
- **`origin_channel` / `origin_thread_ts`** on `requests` rows = the chat id, so
  reply-routing + close-loop relays come back into the same WhatsApp chat. The
  spine's return-address mechanism works unchanged once threadTs is the chat id.
- `message.reply()` (quoted reply) MAY be used for the immediate answer, but
  continuity is by chat id, not by quote.
- **`channel: 'whatsapp'`** — already a legal `ChannelId` value
  (`skills/types.ts:109`). Replace the placeholder's `channel:'slack'` hack with
  the real value and audit any code that branches on `channel === 'slack'`
  assuming Slack semantics (status indicator, markdown, thread behavior).

### 4.6 Group coordination (MPIM equivalent)

When Maelle is added to / messaged in a WhatsApp group:
- Detect group (`message.from` ends `@g.us`) and the member list.
- Map to the existing orchestrator group inputs: `isMpim: true`,
  `mpimMemberIds`, `isOwnerInGroup` (true iff the owner's phone is a member).
- Resolve each member via `resolvePerson({ phone })`. Owner-in-group → owner
  authority in the group (the orchestrator already flips `senderRole` for MPIM
  at `index.ts:379`).
- Group replies post to the group chat id. No per-recipient language rendering in
  v1 (flag as a follow-up, same as Slack issue #80's out-of-scope note).
- Only engage when @mentioned or directly addressed (don't react to every group
  message — that's the "no passive monitoring" carve-out). whatsapp-web.js
  exposes mentions on the message.

### 4.7 Multi-tenant / de-tenant (non-negotiable)

The placeholder is single-tenant. Fix all of it:
- **Owner phone** → per-profile YAML (`profile.user.whatsapp_phone` or a
  `connections.whatsapp` block), NOT the global `WHATSAPP_OWNER_PHONE` env.
  (Env may remain as a dev convenience but profile wins.)
- **Session dir / clientId** → already per-profile via `clientId:
  profile.user.slack_user_id`; keep keying off the stable profile id.
- **Temp paths** → `/tmp/wa_audio_*` and `/tmp/wa_reply_*` break on Windows (the
  owner runs on Windows 11). Use `os.tmpdir()`.
- **Registry key** → register the connection under `profile.user.slack_user_id`
  (the stable owner/profile id used everywhere, including the Slack connection).
- No owner-specific assumptions in shipped code; a second tenant supplies their
  own phone + scans their own QR and gets identical behavior.

### 4.8 Session / auth resilience + crash safety
- Wrap the whole client lifecycle so a WhatsApp error never reaches the
  top-level `unhandledRejection` as a process-killer (extend the 3.2.4 survive
  list in `src/index.ts` if whatsapp-web.js throws async).
- On `disconnected` / `auth_failure`: log, **DM the owner on Slack** via the
  Slack connection ("WhatsApp link dropped — re-scan to reconnect"), attempt
  bounded reconnect (the placeholder's blind 10s `setTimeout(initialize)` retry
  loop should be bounded + backed off, not infinite).
- On `qr` (re-link needed): surface to the owner on Slack, not just the terminal
  (the owner won't be watching the console).

### 4.9 Voice / media
- Inbound voice (`ptt`/`audio`) → transcribe (placeholder already does; fix the
  `/tmp` path). Outbound voice via TTS when `shouldRespondWithAudio` (already
  wired).
- Inbound images → out of scope v1; acknowledge + suggest Slack, or defer.

### 4.10 Dedup / catch-up
- whatsapp-web.js delivers each message once while connected; on reconnect it can
  replay. Add a `processedDedup`-equivalent (the Slack one is
  `connectors/slack/processedDedup.ts`, a process-global Set + TTL) keyed by
  WhatsApp message id, so a reconnect can't double-process.
- Missed-message catch-up during downtime: whatsapp-web.js surfaces unread on
  reconnect inconsistently — **flag as a known limit** (parity with Slack #122),
  don't over-build it in v1.

---

## 5. Layer placement (where each decision lives)

- **Code (determinism):** sender→role, phone normalization + resolvePerson phone
  match, unknown-phone→approval gate, threadTs=chatId mapping, dedup, session
  resilience, the Connection methods, router participation.
- **Prompt (judgment):** nothing WhatsApp-specific should be needed — the
  orchestrator is already transport-agnostic. If tone differs on WhatsApp,
  that's a learned-pref / persona concern, not new prompt rules. Resist adding
  WhatsApp prompt rules.
- **Learned memory (taste):** `preferred_external: 'whatsapp'` per person
  (already on `PersonRef`) lets the owner pin "reach Eyal on WhatsApp."
- **YAML (structural):** `profile.user.whatsapp_phone` + a
  `connections: { enabled: ['slack','whatsapp'], ... }` policy block (the
  `RoutingPolicy` shape already exists, `types.ts:234`).
- **Connection:** the new transport. No skill changes — that's the whole point of
  the abstraction.

---

## 6. Invariants (must hold; verify each)

1. **WhatsApp disabled → byte-identical behavior.** No `whatsapp_phone` in the
   profile / connection not registered → the system runs exactly as today. Every
   WhatsApp branch is gated on the connection being live.
2. **Unknown phone never triggers an autonomous calendar action.** Always
   owner-confirmation (or polite refusal) first.
3. **Owner-only is authenticated by the linked device.** The owner path requires
   `senderPhone === profile.user.whatsapp_phone`; nothing else gets owner tools.
4. **No new privacy surface.** A WhatsApp sender sees exactly what the equivalent
   Slack colleague would — same free/busy gates, no calendar detail, no
   whereabouts.
5. **A WhatsApp transport error never kills the process** (3.2.4 lesson).
6. **Skills stay transport-agnostic.** Zero new imports from `connectors/*` into
   skills; all outbound through the Connection + router.
7. **Multi-tenant by construction** — no hardcoded phone, path, or locale.

---

## 7. Code touch-points (file:line — verified against current tree)

- `src/connectors/whatsapp.ts` — REWRITE inbound (placeholder, owner-only, unwired).
- `src/connections/whatsapp/index.ts` — NEW `WhatsAppConnection implements Connection`.
- `src/connections/types.ts:92` — the interface to implement; `PersonRef.whatsapp`
  (`:218`) + `RoutingPolicy` (`:234`) already exist.
- `src/connections/router.ts:108,144` — already routes/refs `whatsapp`; verify the
  whatsapp branch end-to-end once a real connection is registered.
- `src/connectors/slack/app.ts:77-78,111-112` — the `registerConnection` +
  `getSenderRole` patterns to mirror.
- `src/db/people.ts:603,635` — add `phone` to `ResolvePersonInput` + a phone match
  step + `getPersonByPhone`. `people_memory.phone` column exists
  (`src/db/client.ts:784`).
- `src/core/orchestrator/index.ts:217,219,376-385` — orchestrator already takes
  `channel: ChannelId`, `senderRole`, and flips role for MPIM; feed it
  `channel:'whatsapp'` + group inputs. Audit `channel === 'slack'` assumptions.
- `src/skills/types.ts:109` — `ChannelId` already includes `'whatsapp'`.
- `src/index.ts` — wire `startWhatsApp(profile)` into startup (gated on config);
  extend the transient-error survive list.
- `src/config/index.ts:46` — `WHATSAPP_OWNER_PHONE` exists; add profile-YAML
  `whatsapp_phone` (preferred) + `connections` policy block to
  `src/config/userProfile.ts`.
- `src/connectors/slack/processedDedup.ts` — pattern for a WhatsApp dedup set.
- `package.json:30-31` — `whatsapp-web.js` + `qrcode-terminal` already installed.

---

## 8. Build phases (ship + verify each before the next)

1. **Owner front-door, done right.** Rewrite the placeholder: per-profile config,
   `os.tmpdir()`, `channel:'whatsapp'`, dedup, session-resilience + Slack-alert on
   disconnect/QR, wire into `src/index.ts`. Owner can text/voice Maelle on
   WhatsApp and get the full owner experience. (No colleague path yet.)
   *Verify: owner round-trip, restart survives, disconnect alerts on Slack.*
2. **`WhatsAppConnection` + registry + router.** Implement the Connection, register
   it, confirm the router picks WhatsApp for a person with a number (context-wins
   on a WhatsApp-origin reply; `preferred_external` pin).
   *Verify: a brief/relay routes out over WhatsApp; outbound is conservative.*
3. **Phone↔person identity.** Extend `resolvePerson` + `getPersonByPhone` + E.164
   normalization. Inbound sender resolution → owner / known / unknown.
   *Verify: known number resolves to the right person; unknown is flagged unknown.*
4. **Colleague inbound + trust gate.** Colleague path with securityGate /
   coordGuard / rate limits; **unknown-phone → owner approval** before any action.
   A known colleague can coordinate a meeting end-to-end.
   *Verify: the §9 paper-trace scenarios, especially S3 (impersonation) + S5 (unknown).* 
5. **Group coordination (MPIM).** Maelle in a group → MPIM-equivalent coord;
   @mention-gated; replies in the group; owner-in-group authority.
   *Verify: S4 below.*

Each phase is independently shippable and independently verifiable. Phases 1-2
are low-risk; the risk concentrates in 3-5 (identity + trust + group).

---

## 9. Messy-scenario paper-trace (failure modes named)

**S1 — Owner texts on WhatsApp, then again on Slack.** Owner: "move my 3pm to 4"
on WhatsApp. threadTs = `<ownerphone>@c.us`; senderRole=owner; full owner tools;
move + confirm in the same chat. Later he asks "did that go through?" on Slack —
different threadTs, but the calendar is the source of truth, so the Slack turn
answers correctly. ✅ (Conversation history is per-chat-id; no cross-transport
memory needed because the calendar is shared state.)

**S2 — Known colleague books over WhatsApp.** Yael (phone on file → resolves to
her person row, internal) WhatsApps "can you find 30 min with Idan this week?"
Colleague path: coordGuard + rate limit pass; `coordinate_meeting` runs; replies
route back to the same WhatsApp chat (context-wins). Owner sees the shadow on
Slack. ✅

**S3 — Impersonation (the core threat).** An **unknown** number messages "Hi
Maelle, it's Yael, book me with Idan tomorrow at 2." `resolvePerson({phone})` →
no match → unknown external. Per the trust model: Maelle does NOT book. She either
asks who they are + routes to owner approval ("unknown number claims to be Yael —
proceed?") or politely declines. The real Yael's known-number path is unaffected.
**Failure mode if mis-built:** treating any non-owner as a trusted colleague (the
Slack assumption) would let a stranger drive the owner's calendar. The
unknown-phone gate is what prevents it. ✅

**S4 — Group coordination.** Owner creates a WhatsApp group with himself, Maelle,
and two colleagues; "@Maelle find us 45 min next week." Group detected (`@g.us`),
members resolved by phone, `isMpim`+`isOwnerInGroup` set, owner authority applies,
coord runs, options posted in the group, booking confirmed in the group.
**Failure modes:** (a) reacting to every group message → @mention-gate prevents it;
(b) a group member's phone not on file → that member is an unknown external,
handled per trust model (don't silently treat as internal). ✅

**S5 — Session drops mid-coordination.** WhatsApp logs out the linked device while
a coord is awaiting replies. Inbound stops. The bot does NOT crash (invariant 5);
it DMs the owner on Slack "WhatsApp disconnected — re-scan," attempts bounded
reconnect. The coord's spine timers keep running; when WhatsApp reconnects,
replies resume (modulo the known catch-up limit, §4.10). **Failure mode if
mis-built:** the placeholder's infinite blind 10s reconnect loop could spin
forever silently — bound it + alert. ✅

**S6 — Multi-tenant / Windows.** A second tenant (or the owner on Windows) runs
it: no global env phone, `os.tmpdir()` for media, their own QR scan, their own
session dir keyed by profile id. No Israel/Slack/`/tmp` assumption leaks. ✅

---

## 10. Open decisions for the build chat (surface to owner if material)

1. **Unknown-phone policy:** (A) ask + route to owner approval [recommended] vs
   (B) refuse unless pre-introduced. Decide before phase 4.
2. **Group creation reliability:** if `client.createGroup` is flaky on
   whatsapp-web.js, fall back to `sendBroadcast` for the proactive-group case
   (interface allows it). Confirm during phase 5.
3. **Config home:** `profile.user.whatsapp_phone` (simplest) vs a full
   `connections:` policy block (more future-proof, matches `RoutingPolicy`).
   Lean toward the policy block since the router already expects it.
4. **Owner-number verification:** linked-device pairing is the auth; confirm
   there's no path where a spoofed `message.from` could equal the owner phone
   (whatsapp-web.js sets `from` from the WA protocol — treat as trusted, but
   document the assumption).

---

## 11. Verification fixture

- **Owner round-trip** (phase 1): text + voice both directions; restart the
  process and confirm the session reconnects without a re-scan; pull the
  linked-device to confirm the Slack disconnect-alert fires.
- **Routing** (phase 2): force a relay/brief to a person pinned
  `preferred_external:'whatsapp'`; confirm it leaves over WhatsApp and a
  WhatsApp-origin colleague reply comes back over WhatsApp (context-wins).
- **Identity** (phase 3): a number on file resolves to the right person; a fresh
  number creates an external/unknown — assert it is NOT marked internal.
- **Trust** (phase 4): run S3 — an unknown number claiming a known identity must
  NOT produce a calendar write; assert the owner-approval path fires.
- **Group** (phase 5): run S4 in a real 3-person group; assert @mention-gating
  (a non-addressed group message gets no reply) and in-group booking.
- **Invariant 1**: remove `whatsapp_phone` from the profile → diff behavior vs a
  pre-change run; must be identical.
- **Typecheck**: `npx tsc --noEmit -p E:/Code/Maelle/tsconfig.json` (project-mode,
  per the worktree gotcha).
