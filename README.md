# Maelle — AI Executive Assistant Platform

Maelle is an open-source platform for running AI-powered executive assistants that **work as human EAs**. Each assistant lives as a real employee in your company's communication tools — Slack today, WhatsApp and email on the roadmap — and autonomously manages scheduling, coordination, tasks, and routines on behalf of the person it serves.

Multi-tenant: one deployment runs an assistant per executive, each with their own identity, schedule, work style, and active skills.

---

## The human-EA principle

Every design decision is filtered through one question: **would a real human EA do this / say this / phrase it this way?** If the honest answer is no, the behavior is wrong — regardless of technical correctness. Concretely:

- Colleagues never see machine framings. No "the system", no "force the slot", no "threshold exceeded", no "I'm an AI."
- The owner's preferences ARE the rules. Narrated as his ("your usual 2h focus block"), not as a system's.
- When unsure, Maelle asks a clarifying question. When she can't honestly summarize what she did, she stays silent rather than fabricate a "Done."
- When she claims to have done something, she has done it. False action claims trigger a code-level retry with `tool_choice` forced.

This principle outranks speed, completeness, and elegance.

---

## How it works

The agent is composed of **Core modules** (always on) and **Skills** (opt-in per profile). Skills send messages through the **Connection interface** — a transport-agnostic surface Slack implements today; email and WhatsApp follow the same shape.

```
Inbound (Slack DM | MPIM | channel @mention)
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
   Connection registry  →  Transport (Slack | future: email, WhatsApp)
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
| Summary | `summary` | Transcript → structured summary → distribute. 3-stage state machine per thread |
| Knowledge | `knowledge` | Owner-curated markdown KB at `config/users/<name>_kb/`. `manage_knowledge` for get/ingest |
| Search | `search` | Web search + URL extraction (Tavily) |
| Social | `social` | Off-topic chat tracking + in-conversation social codas (rides a live turn; no out-of-the-blue DMs) |
| Venue | `venue` | External meeting venues (cafés, restaurants). `find_venue` + `rank_venue` with per-owner rank catalog |
| News | `news` | Personalized, calendar-aware grounded news — folds a cited "Updates" section into the morning brief + on-demand `news` tool. Interests + source steer taught via `update_my_preferences(skill='news')`; 7-day topic-level dedup |

Legacy YAML keys auto-migrate (`scheduling`/`coordination` → `meetings`, etc.).

---

## Connectors

**Outlook Calendar** — Microsoft Graph API via Azure service principal. Required permission: `Calendars.ReadWrite` (application). Reads events, creates/updates/deletes, sets categories + sensitivity, free/busy lookup, slot search.

**Slack** — Socket Mode, no open ports. One Slack app per assistant identity. Handles four contexts:
- **1:1 DM** — responds to every message from the authorised user
- **Group DM / MPIM** — Sonnet-based relevance + addressee classifier decides when to join
- **Channel @mention** — responds when @mentioned; stays in the thread once engaged
- **Channel posting** — can post to any channel on the owner's behalf with an @mention

**WhatsApp / Email** — placeholders. Same orchestrator + skill set when implemented.

---

## Multi-modal input (Slack)

| Input | How |
|---|---|
| Voice | Slack audio → OpenAI Whisper → orchestrator. Reply may go back as TTS audio when short enough |
| Images | Native Anthropic multimodal — Sonnet sees bytes directly. `imageGuard` scans for injection (a suspicious colleague image is dropped). DMs **and** channel @mentions. Bytes never persisted |
| Documents | PDF/txt/md → parsed (`pdf-parse` for PDF), folded into the turn as framed reference material. Owner-only in DMs; in a channel, the owner's file (or a colleague's when the owner is in the thread) |
| Text transcripts | `.txt` upload → SummarySkill 3-stage state machine |

---

## Honesty & safety layers

| Guard | Purpose |
|---|---|
| **Claim-checker** | Sonnet pass after every owner-facing draft. False action claims trigger retry with `tool_choice` |
| **Date verifier** | Weekday/date pairs vs 14-day lookup. Retry + deterministic inline correction if retry fails |
| **Security gate** | Leak-pattern filter on colleague-facing replies (never reveals tools/prompts/model names) |
| **Channel privacy clamp** | In a real channel, even the owner runs with colleague-level tools + privacy-conscious narration — private calendar / owner-only data never surfaces in a shared space |
| **humanGate** | Catches mechanical-refusal phrasings on both owner-facing and colleague-facing drafts |
| **Coord guard** | Injection scan + LLM judge on `coordinate_meeting` inputs (owner-path today; colleagues book via the direct path — coords return for calendar-invisible external requesters when those transports land) |
| **Cross-handler dedup** | Process-global message-ts Set (`markProcessed`) — one atomic claim shared by the live handlers and the background catch-up, so a re-delivered message is answered exactly once regardless of which reaches it first (also what makes socket-first boot safe) |
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

PM2 (single fork-mode process) is configured in `ecosystem.config.js` for unattended operation; deploys are manual via `npm run deploy` (build → restart → tail logs). Startup logs a build stamp (version + git SHA) so `pm2 logs` shows which build is live.

---

## Roadmap

**Next**: WhatsApp connector — first non-Slack `Connection` implementation. v3 was cut as the cleanup baseline; the v3.x line goes forward into WhatsApp work.

Tracked items:
- **WhatsApp connector** — [#4](https://github.com/odahviing/AI-Executive-Assistant/issues/4)
- **Email connector** — [#5](https://github.com/odahviing/AI-Executive-Assistant/issues/5). CC Maelle on a thread to have her handle it.
- **Inbound workflows** — [#6](https://github.com/odahviing/AI-Executive-Assistant/issues/6). Listen for triggers (new lead lands in a channel) and run a skill end-to-end.
- **Meeting prep skill** — [#110](https://github.com/odahviing/AI-Executive-Assistant/issues/110). Generalizable; interview is one shape, sales / customer / board / 1:1 are others.
- **Google Places venue backend** — [#96](https://github.com/odahviing/AI-Executive-Assistant/issues/96). Structured booking metadata for the venue skill.

---

## License

MIT
