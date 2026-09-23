# Maelle — AI Executive Assistant Platform

Maelle is an open-source platform for running AI-powered executive assistants that **work as human EAs**. Each assistant works in your company's communication tools — primarily Slack, with a narrow owner-only email transport — and manages scheduling, coordination, tasks, and routines on behalf of the person it serves.

Multi-tenant: one deployment runs an assistant per executive, each with their own identity, schedule, work style, and active skills.

---

## The human-EA principle

Every design decision is filtered through one question: **would a real human EA do this / say this / phrase it this way?** If the honest answer is no, the behavior is wrong — regardless of technical correctness. Concretely:

- Colleagues should hear a teammate's voice, without machine framings such as "the system" or "threshold exceeded". A direct, genuine question about whether she is AI gets an honest answer; she does not volunteer it.
- The owner's preferences ARE the rules. Narrated as his ("your usual 2h focus block"), not as a system's.
- When unsure, Maelle asks a clarifying question. When she can't honestly summarize what she did, she stays silent rather than fabricate a "Done."
- Action claims must reflect actual outcomes. The claim checker uses structured verdicts and a tool-less corrective rewrite; it does not retry the action. Model-dependent detection is not a guarantee of perfect honesty.

This principle outranks speed, completeness, and elegance.

---

## How it works

The agent is composed of **Core modules** (always on) and **Skills** (opt-in per profile). Skills send messages through the **Connection interface**, implemented by Slack and email. WhatsApp has a dormant owner-only inbound path and no outbound `Connection` implementation.

```
Inbound (Slack DM | MPIM | channel @mention; email has its own inbound handler)
        │
        ▼
   Inbound queue (debounce + mutex + abort-if-safe)
        │
        ▼
   Orchestrator (Claude tool loop, system prompt builder)
        │
        ▼  ┌────────────────┐
   Core ──┤ memory          │  Skills (opt-in)
   ──────┤ outreach         │  meetings · calendar
        │ tasks · routines │  summary · knowledge · search · social · venue · news
        └────────────────┘
        │
        ▼
   Connection registry  →  Transport (Slack | email)
        │
        ▼
   Reply back through the same Connection
```

Skills never import from `src/connectors/slack/*` or call `app.client.*` directly — only `src/connections/types` + `src/connections/registry`. Adding a new transport is a pure additive change.

### The orchestrator loop

Every message enters a Claude tool-use loop. Claude reads the system prompt (built from the user's YAML profile + active skills), decides which tools to call, and runs up to 10 iterations before replying. Tool calls are routed to the matching skill, executed, and the result is fed back to Claude for the next step.

### Profiles

Each user is configured via a YAML file in `config/users/`. The profile defines:
- Identity (name, role, timezone, language)
- Company context (`company_brief` — short paragraph about the business)
- Assistant identity (name, persona, Slack credentials)
- Work schedule: `office_days` / `home_days` (classification) + `work_hours: { day: [HH:MM-HH:MM, ...] }` (multi-window per day, supports split shifts)
- Meeting rules (allowed durations, buffer, protected meetings, floating blocks, office location labels)
- Categories with scheduling rules (`limits.per_day`, `day_type`, `requires_travel_buffer`)
- Priorities, VIP contacts, which skills are active

---

## Architecture — four layers

| Layer | What | Where |
|---|---|---|
| **Core** | Engine + always-on modules: memory, outreach, tasks, routines | `src/core/`, `src/tasks/` |
| **Skills** | Opt-in domain capabilities toggled per profile | `src/skills/` |
| **Connections (outbound) + Connectors (inbound)** | Transport-agnostic outbound `Connection` interface + inbound/external-service adapters | `src/connections/`, `src/connectors/` |
| **Utilities** | Pure cross-cutting helpers — claim-checker, date-verifier, security gate, etc. | `src/utils/` |

Detailed file map and invariants live in [`.claude/memory/project_architecture.md`](.claude/memory/project_architecture.md).

---

## Skills

Always-active core modules:

| Module | Tools |
|---|---|
| **Memory** (`core/assistant.ts`) | `manage_preference` (set/forget/recall), `recall_interactions`, `update_person_profile`, `update_person_memory`, `get_person_memory`, `log_interaction`, `confirm_gender` |
| **Outreach** (`skills/outreach.ts`) | `message_colleague` |
| **Tasks** (`tasks/skill.ts`) | `create_task`, `update_task` (edit/cancel), `get_my_tasks`, `create_approval`, `resolve_approval`, `list_pending_approvals`, `get_briefing`, `send_briefing_now` |
| **Routines** (`tasks/crons.ts`) | `manage_routine` (create/update/delete/list) |

Optional skills (toggle in YAML):

| Skill | Key | What |
|---|---|---|
| Meetings | `meetings` | Direct calendar ops + multi-party coordination. All scheduling intents flow through `planMeeting`; all location decisions through `resolveLocation` |
| Calendar | `calendar` | Weekly review, floating-block protection, issue tracking. Active mode autonomously fixes safe issues |
| Summary | `summary` | Transcript → structured summary → edit/share. Action items remain content; automatic followup scheduling is retired |
| Knowledge | `knowledge` | Owner-curated markdown KB at `config/users/<name>_kb/`. `manage_knowledge` for get/ingest |
| Search | `search` | Web search + URL extraction (Tavily) |
| Social | `social` | Off-topic chat tracking + in-conversation social codas (rides a live turn; no out-of-the-blue DMs) |
| Venue | `venue` | External meeting venues (cafés, restaurants). `find_venue` + `rank_venue` with per-owner rank catalog |
| News | `news` | Personalized, calendar-aware grounded news — folds a cited "Updates" section into the morning brief + on-demand `news` tool. Interests + source steer taught via `update_my_preferences(skill='news')`; 7-day topic-level dedup |

Legacy YAML keys auto-migrate (`scheduling`/`coordination` → `meetings`, etc.).

---

## Connectors

**Outlook Calendar** — Microsoft Graph API via Azure service principal. Required permission: `Calendars.ReadWrite` (application). Reads events, creates/updates/deletes, sets categories + sensitivity, free/busy lookup, slot search. *(The mail path below uses the same app registration but a different auth mode — delegated, not application. Both live side by side.)*

**Slack** — Socket Mode, no open ports. One Slack app per assistant identity. Handles four contexts:
- **1:1 DM** — responds to every message from the authorised user
- **Group DM / MPIM** — Sonnet-based relevance + addressee classifier decides when to join
- **Channel @mention** — responds when @mentioned; stays in the thread once engaged
- **Channel posting** — can post to any channel on the owner's behalf with an @mention

**Email** — Microsoft Graph mail on a **delegated** OAuth token (one browser sign-in per deployment, scoped to one mailbox by construction — deliberately not app-only `Mail.*`, which is tenant-wide and would need org-level Exchange RBAC to narrow). Polls its own mailbox every ~30s on a Graph delta link.

Deliberately **semi-manual**: the owner forwards a meeting-request thread to Maelle, she reads the whole chain, extracts the participants from the forwarded headers, computes options against his real calendar and rules, and replies **to him only** — he forwards it onward. She never emails an external. Enforced in code, not prompt: the send verb hard-caps the recipient, and an email turn is clamped to four tools (`find_available_slots`, `create_meeting`, `get_person_memory`, `log_interaction`) — no move, no cancel, no approval, nothing that can reach Slack.

Same orchestrator, same scheduling core, same output gates as Slack. Email is transport, not a second brain.

**WhatsApp** — dormant owner-only inbound implementation, gated by profile configuration; no outbound `Connection` implementation. Its expansion is outside this readiness work.

---

## Multi-modal input (Slack)

| Input | How |
|---|---|
| Voice | Slack audio → OpenAI Whisper → orchestrator. One 180-second transcription budget covers download, conversion and Whisper; expiry cancels the work and uses the existing failure notice, without a paid retry. Reply may go back as TTS audio when short enough |
| Images | Native Anthropic multimodal — Sonnet sees bytes directly. `imageGuard` scans for injection (a suspicious colleague image is dropped). DMs **and** channel @mentions. Bytes never persisted |
| Documents | PDF/txt/md → parsed (`pdf-parse` for PDF), folded into the turn as framed reference material. Owner-only in DMs; in a channel, the owner's file (or a colleague's when the owner is in the thread) |
| Text transcripts | `.txt` upload → SummarySkill 3-stage state machine |

---

## Honesty & safety layers

| Guard | Purpose |
|---|---|
| **Claim-checker** | Checks action claims on owner-acting paths; structured verdict and tool-less corrective rewrite |
| **Date verifier** | Extracts weekday/date pairs and checks the 14-day lookup; deterministic weekday correction |
| **Security gate** | Leak-pattern filter on colleague-facing replies (never reveals tools/prompts/model names) |
| **Channel privacy clamp** | In a real channel, even the owner runs with colleague-level tools + privacy-conscious narration — private calendar / owner-only data never surfaces in a shared space |
| **humanGate** | Catches mechanical-refusal phrasings on both owner-facing and colleague-facing drafts |
| **Coda gates** | Optional social asides require clear checks; unavailable or flagged checks drop the aside without rewriting |
| **Cross-handler dedup** | In-memory message claims shared by live handlers and catch-up, supplemented by Slack history during recovery. This is bounded duplicate suppression, not durable exactly-once delivery |
| **Idempotency** | `create_meeting` (Graph pre-check ±2 min), `delete_meeting` (per-turn per-event_id) |
| **Verb-map fallback** | When Sonnet goes silent post-tool, deterministic verb mapping ensures honest one-line confirmation (no fabricated "Done") |

Detailed in [`.claude/memory/project_architecture.md`](.claude/memory/project_architecture.md).

---

## Multi-tenancy

One deployment can serve multiple executives. Each profile gets its own Slack app, skill configuration, conversation history, task queue, learned preferences, and morning briefing schedule. All data scoped by `owner_user_id` in SQLite.

---

## Tech stack

| Component | Library |
|---|---|
| Language | TypeScript / Node.js 20+ |
| LLM | Anthropic Claude Sonnet 5 (Haiku 4.5 for sidecar classifiers). Vertex AI ready via `LLM_PROVIDER` env var (v2.8.1); SDK `@anthropic-ai/sdk` 0.112 + `@anthropic-ai/vertex-sdk` |
| Slack | `@slack/bolt` (Socket Mode) |
| Microsoft Graph | `@microsoft/microsoft-graph-client` + `@azure/identity` |
| Database | SQLite via `better-sqlite3` |
| Schema validation | Zod |
| Dates/timezones | Luxon |

---

## Setup

```bash
npm install
cp config/users.example/user.example.yaml config/users/yourname.yaml
# Edit the YAML — name, email, Slack creds, schedule, skills
```

`.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
NODE_ENV=development
```

Run:

```bash
npm run dev          # development with hot reload
npm run build && npm start    # production
```

**Optional — the email transport.** Off unless configured; absent the config nothing polls and no connection registers.

1. Give the assistant a mailbox she can sign into (a licensed user account, not a shared mailbox — the sign-in is what scopes the token).
2. On the **existing** app registration, add **delegated** `Mail.ReadWrite` + `Mail.Send` — *not* the Application variants, which are tenant-wide — and a `http://localhost:8734/callback` redirect URI under a Web platform.
3. In the profile YAML: `channels.email.enabled: true` and `channels.email.mailbox: "<her address>"`.
4. `node scripts/email-auth.mjs <profileName>` — signs in **as the mailbox**, writes a rotating refresh token under `data/` (gitignored). A delegated token belongs to whoever signs in, so signing in as the owner would point her at his own inbox.
5. Recommended: `Set-Mailbox <her address> -RequireSenderAuthenticationEnabled $true`, so only authenticated tenant senders can reach her at all.

Maelle runs under PM2 on a GCP VM (single fork-mode process, `ecosystem.config.js`). The deploy watcher polls `master` and installs, checks, builds and restarts when the target revision differs from the online PM2 process's existing `GIT_SHA`. An incomplete install/build/restart is retried on a later poll even if checkout HEAD already advanced; missing applied identity causes a rebuild. It supplies `GIT_SHA` and `APP_VERSION` at restart. This describes current source, not proof that the change is deployed. Build output and dependencies are still updated in place; no atomic rollback guarantee is implied. Read live logs with `scripts/vm-logs.ps1`.

Email sender admission currently compares the From address with the owner and configured aliases; it is not provider-backed sender authentication. Unknown delivery followed by read-mark failure and delta reset can still replay after restart. Additional durable email receipts were declined; no exactly-once or stronger sender-authentication guarantee is claimed.

---

## Roadmap

**Shipped in 4.3.0**: the email transport — the first non-Slack `Connection` implementation, in its semi-manual form (owner forwards, she replies to him, he forwards onward).

Tracked items:
- **WhatsApp connector** — [#4](https://github.com/odahviing/AI-Executive-Assistant/issues/4)
- **Email connector, remaining half** — [#5](https://github.com/odahviing/AI-Executive-Assistant/issues/5). The transport, inbound parsing and reply path landed in 4.3.0. Still open by design: outbound to non-owner recipients — currently unreachable while the one-address cap stands, which is a product decision to revisit rather than a gap to fill — plus cross-channel coordination and inbox triage into the brief.
- **Inbound workflows** — [#6](https://github.com/odahviing/AI-Executive-Assistant/issues/6). Listen for triggers (new lead lands in a channel) and run a skill end-to-end.
- **Meeting prep skill** — [#110](https://github.com/odahviing/AI-Executive-Assistant/issues/110). Generalizable; interview is one shape, sales / customer / board / 1:1 are others.
- **Google Places venue backend** — [#96](https://github.com/odahviing/AI-Executive-Assistant/issues/96). Structured booking metadata for the venue skill.

---

## License

MIT
