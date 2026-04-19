# Maelle — AI Executive Assistant Platform

Maelle is an open-source platform for running AI-powered executive assistants that **work as human EAs**. Each assistant lives as a real employee in your company's communication tools — Slack today, WhatsApp and email on the roadmap — and autonomously manages scheduling, coordination, tasks, and routines on behalf of the person it serves.

The project is multi-tenant: one deployment can run an assistant per executive, each with their own identity, schedule, work style, and set of active skills.

---

## The human-EA principle

Every design decision in Maelle is filtered through one question: **would a real human EA do this / say this / phrase it this way?** If the honest answer is no, the behavior is wrong — regardless of technical correctness. Concretely:

- Colleagues never see machine framings. No "the system", no "force the slot", no "threshold exceeded", no "I'm an AI."
- The owner's preferences ARE the rules. They're narrated as his ("your usual 2h focus block"), not as a system's.
- When unsure, Maelle asks a clarifying question. When she can't honestly summarize what she did, she stays silent rather than fabricate a "Done."
- When she claims to have done something, she has done it. False action claims trigger a code-level retry with tool_choice forced.

This principle outranks speed, completeness, and elegance in every tradeoff.

## Goals

- **Protect time** — enforce meeting rules, buffers, focus blocks, and lunch without being asked
- **Drive coordination** — reach out to colleagues, negotiate availability, and confirm meetings autonomously
- **Remember context** — learn preferences over time and apply them without repetition
- **Run on a schedule** — execute recurring tasks automatically (morning briefings, weekly prep, periodic checks)
- **Stay in the loop** — track open tasks, follow-ups, and pending replies so nothing falls through
- **Stay honest** — never claim an action that didn't happen; never invent context; when unsure, ask

---

## How It Works

The agent is composed of **Core modules** (always on) and **Skills** (opt-in per profile). Skills use **Connectors** to talk to external services. Connectors also bring messages IN from Slack/etc. — so the connector layer sits at both ends of the request flow.

```
Inbound message  (Slack channel | DM | group DM)
        │
        ▼
   Slack Connector              ← receives, resolves mentions, filters relevance
        │
        ▼
   Orchestrator                 ← builds system prompt, runs Claude tool-use loop
        │
        │  prompt + tools come from:
        │
   ┌────┴────────────────────────────────────┐
   │                                         │
   ▼                                         ▼
 Core modules                              Skills
 (always on, not configurable)             (opt-in per profile)
 memory, outreach, tasks, routines         meetings, calendar, summary,
                                           knowledge, search, research
                                                │
                                                │  skills call Connectors
                                                │  for external work
                                                ▼
                                           Connectors
                                           Microsoft Graph (Outlook),
                                           Slack API, web search APIs
                                                │
                                                ▼
                                           (results back to the loop)

   Final reply  →  Slack Connector  →  posted back to the user
```

### The orchestrator loop

Every message enters a Claude tool-use loop. Claude reads the system prompt (built from the user's YAML profile + active skills), decides which tools to call, and runs up to 10 iterations before replying. Tool calls are routed to the matching skill, executed, and the result is fed back to Claude for the next step.

### Profiles

Each user is configured via a YAML file in `config/users/`. The profile defines:
- Identity (name, role, timezone, language)
- Company context (`company_brief` — a short paragraph so the assistant knows the business)
- Assistant identity (name, persona, Slack credentials)
- Work schedule (office days, home days, hours, lunch)
- Meeting rules (allowed durations, buffer, protected meetings, rescheduling policy)
- Priorities and VIP contacts
- Which skills are active

---

## Architecture — the four-layer model

Every file belongs to exactly one layer. When in doubt, ask which layer before writing.

```
src/
├── core/                    # LAYER 1 — Core engine (always on per agent)
│   ├── assistant.ts         # MemorySkill: preferences, people memory, notes, gender, social
│   ├── assistantSelf.ts     # Maelle's own self-memory (her name story, etc.)
│   ├── ownerSelf.ts         # Owner pre-seed in people_memory (for self-tracking)
│   ├── outreach.ts          # OutreachCoreSkill: message_colleague, find_slack_channel
│   ├── orchestrator/        # Claude tool-use loop, system prompt builder
│   │   ├── index.ts
│   │   └── systemPrompt.ts
│   ├── approvals/           # Resolver + orphan backfill for structured decisions
│   └── background.ts        # 5-min timer: materializeRoutineTasks → runDueTasks
│
├── tasks/                   # Task system (core infra + CRUD skill)
│   ├── skill.ts             # TasksSkill — tasks, approvals, requests, briefings
│   ├── crons.ts             # RoutinesSkill — create/list/update/delete routines
│   ├── runner.ts            # Thin dispatch loop (68 lines)
│   ├── dispatchers/         # One file per TaskType (reminder, followUp, routine, outreach*, coord*, approval_expiry, calendar_fix)
│   ├── routineMaterializer.ts
│   ├── lateness.ts          # Cadence-based skip thresholds
│   └── briefs.ts
│
├── skills/                  # LAYER 2 — Togglable skills (per-profile YAML)
│   ├── meetings.ts          # MeetingsSkill: direct ops + multi-party coordination
│   ├── _meetingsOps.ts      # Internal helper (underscore prefix = not loadable)
│   ├── calendarHealth.ts    # CalendarHealthSkill: issues, lunch, categories
│   ├── summary.ts           # SummarySkill: transcript → summary → distribute (3-stage)
│   ├── knowledge.ts         # KnowledgeBaseSkill: file-based markdown KB, on-demand fetch
│   ├── general.ts           # SearchSkill: web_search, web_extract
│   ├── research.ts          # ResearchSkill: owner-only multi-step
│   ├── registry.ts          # Core module + skill loader, tool router, permission gate
│   └── types.ts
│
├── connectors/              # LAYER 3 — Communication surfaces
│   ├── slack/               # Slack Bolt app, reply pipeline, coord state machine
│   │   ├── app.ts
│   │   ├── postReply.ts     # Reply pipeline: normalize → claim-check → security gate → send
│   │   ├── coordinator.ts   # Outreach reply classifier + Slack utilities
│   │   ├── coord.ts         # Coord state machine (targeted for agent/transport split in 1.7)
│   │   ├── coord/           # utils / approval / booking submodules
│   │   └── relevance.ts
│   ├── graph/calendar.ts    # Microsoft Graph (calendar + free/busy)
│   └── whatsapp.ts          # Placeholder
│
├── utils/                   # LAYER 4 — Cross-cutting helpers
│   ├── claimChecker.ts      # Honesty gate over owner drafts (replaces reply verifier)
│   ├── dateVerifier.ts      # Weekday/date pair check with retry
│   ├── securityGate.ts      # Leak-pattern filter on colleague-facing replies
│   ├── coordGuard.ts        # Injection scan + LLM judge on coord inputs
│   ├── rateLimit.ts
│   └── logger.ts, shadowNotify.ts, slackFormat.ts, addresseeGate.ts, genderDetect.ts
│
├── db/                      # SQLite via better-sqlite3
│   ├── client.ts            # Connection + schema + migrations
│   ├── people.ts            # people_memory (notes, profile, interactions, social topics)
│   ├── jobs.ts              # coord_jobs + outreach_jobs
│   ├── approvals.ts         # Structured owner decisions
│   ├── tasks.ts, conversations.ts, preferences.ts, calendarIssues.ts, events.ts, requests.ts
│   └── index.ts             # Barrel
│
├── config/                  # Profile loader (Zod-validated YAML) + env
└── voice/                   # Whisper transcription + TTS
```

### The four layers

| Layer | What it is | Who decides |
|---|---|---|
| **Core** | Engine + always-on core modules (Memory, Outreach, Tasks, Routines) | Always active, not configurable |
| **Skills** | Opt-in domain capabilities | Toggled per profile in YAML |
| **Connectors** | Communication + external-service adapters | Configured per deployment |
| **Utilities** | Pure cross-cutting helpers | No domain state |

---

## Skills

### Always-active (Core modules)

| Core module | What it does |
|---|---|
| **MemorySkill** (`core/assistant.ts`) | Preferences, people memory, notes, interaction log, gender, owner self-tracking. Tools: `learn_preference`, `recall_preferences`, `note_about_person`, `note_about_self`, `update_person_profile`, `log_interaction`, `confirm_gender` |
| **OutreachCoreSkill** (`core/outreach.ts`) | How Maelle speaks to people on the owner's behalf. Tools: `message_colleague`, `find_slack_channel` |
| **TasksSkill** (`tasks/skill.ts`) | Tasks, approvals, structured requests, briefings. Tools: `create_task`, `get_my_tasks` (with `with_person` filter), `cancel_task`, `create_approval`, `resolve_approval`, `list_pending_approvals`, `store_request`, `get_pending_requests`, `resolve_request`, `escalate_to_user`, `get_briefing` |
| **RoutinesSkill** (`tasks/crons.ts`) | Recurring automations. Tools: `create_routine`, `get_routines`, `update_routine`, `delete_routine` |

### Optional (toggled in YAML)

| Skill | Key | What it does |
|---|---|---|
| **Meetings** | `meetings: true` | Direct calendar ops + multi-party coordination. Tools: `get_calendar`, `analyze_calendar`, `get_free_busy`, `find_available_slots`, `create_meeting`, `move_meeting`, `update_meeting`, `delete_meeting`, `find_slack_user`, `coordinate_meeting`, `get_active_coordinations`, `finalize_coord_meeting`, `check_join_availability` |
| **Calendar** | `calendar: true` | Weekly review, lunch protection, issue tracking. Tools: `check_calendar_health`, `book_lunch`, `set_event_category`, `get_calendar_issues`, `update_calendar_issue` |
| **Summary** | `summary: true` | Meeting transcript (`.txt`) → structured English summary → distribute. Three-stage state machine per Slack thread. Action items with deadlines auto-create follow-up tasks that DM the assignee at 2pm their local timezone. Tools: `classify_summary_feedback`, `learn_summary_style`, `update_summary_draft`, `share_summary`, `list_speaker_unknowns` |
| **Knowledge** | `knowledge: true` | Owner-curated markdown KB at `config/users/<name>_kb/` (auto-discovered, no restart, 32KB cap per file). Catalog injected when active; full content lazy via tool. SummarySkill auto-pulls relevant sections during Stage 1. Tools: `list_company_knowledge`, `get_company_knowledge` |
| **Search** | `search: true` | Web search + URL extraction. Tools: `web_search`, `web_extract` |
| **Research** | `research: true` | Owner-only multi-step research (reuses `web_search`) |

Legacy YAML keys auto-migrate at load time: `scheduling`/`coordination` → `meetings`, `meeting_summaries` → `summary`, `knowledge_base` → `knowledge`, `calendar_health` → `calendar`. Existing profiles keep working without edits.

### Routine examples

Routines are user-defined automations written in plain English. Examples:

- *"Every work day at 8:30am, check my calendar for back-to-backs or missing lunch"*
- *"Every Sunday at 9am, look at the week ahead and flag anything that needs attention"*
- *"Every Thursday at 4pm, summarise open tasks and outstanding coordinations"*

---

## Connectors

### Outlook Calendar

Handles all calendar operations via the Microsoft Graph API (the underlying tool we use to talk to Outlook), using an Azure service principal (client credentials flow, no user login required).

**Capabilities:**
- Read calendar events (`calendarView`) with timezone-aware queries
- Create, update, and delete events
- Set Outlook categories (`Meeting`, `Physical`, `Logistic`, `Private`) and sensitivity
- Get free/busy for any set of users
- Find available slots across all attendees within work hours

**Required Azure permissions:** `Calendars.ReadWrite` (application permission)

### Slack

The assistant runs as a dedicated Slack app (Socket Mode — no open ports). Each assistant is a separate Slack app with its own identity.

**Handles four contexts:**
- **1:1 DM** — responds to every message from the authorised user
- **Group DM / MPIM** — a Sonnet-based relevance + addressee classifier decides when to join; defaults to staying quiet unless clearly addressed
- **Channel @mention** — responds when @mentioned; never otherwise
- **Channel posting** — can post to any channel on behalf of the owner with an @mention; auto-joins public channels, returns a clear error for private channels it hasn't been invited to

### WhatsApp

Connector is implemented via `whatsapp-web.js` and is ready to enable. Currently disabled pending configuration. Shares the same orchestrator and skill set as Slack.

---

## Multi-modal input (Slack)

Maelle accepts more than text in Slack DMs:

| Input | How it works |
|---|---|
| **Voice messages** | Slack audio file_share is downloaded, transcribed by OpenAI Whisper (with ffmpeg WAV conversion), then fed into the orchestrator like a normal message. Voice in → audio reply out (when reply is short enough to listen to), text otherwise. |
| **Images / screenshots** | Owner pastes a screenshot in DM or MPIM. Sonnet sees the actual image bytes via Anthropic image content blocks (native multimodal, not pre-described summaries). `imageGuard` scans for instruction-like text on every image and shadow-notifies on suspicious finds. Conversation history stores `[Image] caption` placeholders only — bytes never persisted. |
| **Text transcripts** | Owner uploads a `.txt` meeting transcript. SummarySkill ingests it through the 3-stage state machine (Drafting → Iterating → Sharing). Auto-correlates with calendar events when the caption hints at a time. |

---

## Honesty & safety layers

Several code-level guards keep the agent from producing false claims or leaking machine framings:

| Guard | Where | Purpose |
|---|---|---|
| **Claim-checker** | `utils/claimChecker.ts` | After every owner-facing draft, a narrow Sonnet pass flags false action claims ("I sent it" when no send ran). False claims trigger a retry with `tool_choice` forcing the right tool. |
| **Date verifier** | `utils/dateVerifier.ts` | Scans drafts for weekday/date pairs; mismatches against the owner's 14-day lookup trigger a corrective retry. |
| **Security gate** | `utils/securityGate.ts` | Leak-pattern filter on colleague-facing replies (never reveals tools/prompts/model names). |
| **Coord guard** | `utils/coordGuard.ts` | Injection scan + LLM judge on `coordinate_meeting` inputs from colleagues. |
| **Rate limits** | `utils/rateLimit.ts` | Colleague-initiated coord + any-tool limits. |
| **Recovery pass** | `orchestrator/index.ts` | Empty-reply fallback: one Claude call grounded in actual tool history produces an honest one-sentence summary — never a fabricated "Done." |
| **Coord-terminal invariant** | `db/jobs.ts updateCoordJob` | Any coord → booked/cancelled/abandoned auto-syncs approvals + cancels their expiry tasks. Impossible to forget. |
| **Delete idempotency** | `orchestrator/index.ts` | Same event id can't be deleted twice in one turn. Confirm-before-delete protocol in the MeetingsSkill prompt. |

---

## Multi-tenancy

One deployment can serve multiple executives simultaneously. Each profile in `config/users/` gets:
- Its own Slack app and identity
- Its own skill configuration
- Its own conversation history, task queue, and learned preferences
- Its own morning briefing schedule

All data is scoped by `owner_user_id` in SQLite. Colleagues can interact with an assistant (to request meetings, check availability) with a hard-limited tool set — they cannot read the owner's tasks, preferences, or history.

---

## Tech Stack

| Component | Library |
|---|---|
| Language | TypeScript / Node.js |
| AI model | Anthropic Claude Sonnet 4.6 (used for every LLM call across the codebase) |
| Slack | `@slack/bolt` (Socket Mode) |
| Microsoft Graph | `@microsoft/microsoft-graph-client` + `@azure/identity` |
| WhatsApp | `whatsapp-web.js` |
| Database | SQLite via `better-sqlite3` |
| Schema validation | Zod |
| Dates/timezones | Luxon |
| Logging | Winston |

---

## Setup

### 1. Prerequisites

- Node.js 20+
- An Anthropic API key
- An Azure AD application with `Calendars.ReadWrite` permission
- A Slack app (Socket Mode) — one per assistant identity

### 2. Install

```bash
npm install
```

### 3. Environment variables

Create a `.env` file:

```env
ANTHROPIC_API_KEY=sk-ant-...

AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...

NODE_ENV=development
```

### 4. Configure a user profile

```bash
cp config/users.example/user.example.yaml config/users/yourname.yaml
```

Edit the file — set your name, email, Slack user ID, Slack app credentials, work schedule, and which skills to enable.

### 5. Run

Development (hot reload):

```bash
npm run dev
```

Production (under PM2, recommended — survives crashes, auto-restarts, pulls + rebuilds on auto-triage commits):

```bash
npm i -g pm2 pm2-windows-startup   # one-time
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2-startup install                 # Windows: auto-start on reboot
```

This starts two processes — `maelle` (the bot) and `maelle-deploy-watcher` (polls origin every 5 min; auto-pulls + rebuilds + restarts when an auto-triage commit lands).

---

## Bug auto-triage + auto-build (GitHub Action)

When you open an issue with the `Bug` label, a GitHub Action runs and uses the Claude Agent SDK to investigate and propose a plan. You review; you approve; the build happens.

**Three-phase flow:**

1. **Triage → Plan.** Agent reads the issue + comments, downloads every attached image, investigates the codebase from scratch (no pre-injected context — avoids recency bias), and writes a plan as an issue comment. Labels the issue `Proposed`. Never edits files.
2. **Your decision.** Read the plan. Label `Approved` to build, or label `Revise` and add comments explaining what to reconsider.
3. **Auto-build.** On `Approved`, a second Action runs: implements the plan, typechecks, commits + pushes under "Maelle Auto-Triage" author, closes the issue.

After push, the `maelle-deploy-watcher` PM2 process on your machine picks up the commit within 5 minutes and restarts Maelle on the new code. Only auto-triage commits trigger the auto-deploy — your own pushes you deploy yourself.

**Safety floors on auto-build:** typecheck must pass, diff ≤200 lines, path allowlist (cannot edit `.claude/`, memory files, `CHANGELOG.md`, `README.md`, `package.json`, `config/users/`, `.github/`, or the auto-triage scripts themselves). Any violation → revert + comment + `Failed` label, issue stays open.

**Image-aware triage.** The triage agent downloads every GitHub user-attachments image referenced in the issue body or comments and reads them as visual evidence before diagnosing. This is critical — most bug reports include screenshots.

**Labels:** `Proposed` / `Approved` / `Revise` / `Failed` / `Triaged`.

**Setup once:** add `ANTHROPIC_API_KEY` as a repository secret (Settings → Secrets and variables → Actions). Create the labels: `gh label create Proposed Approved Revise Failed` (any colors).

Files: [`.github/workflows/auto-triage-bug.yml`](.github/workflows/auto-triage-bug.yml), [`.github/workflows/auto-build.yml`](.github/workflows/auto-build.yml), [`scripts/auto-triage-bug.mjs`](scripts/auto-triage-bug.mjs), [`scripts/auto-build.mjs`](scripts/auto-build.mjs), [`scripts/deploy-watcher.mjs`](scripts/deploy-watcher.mjs), [`ecosystem.config.js`](ecosystem.config.js).

**Architecture context for the agents** (v1.8.4): both the triage and auto-build scripts read `.claude/memory/project_overview.md` + `.claude/memory/project_architecture.md` as reference material so they understand where files live and how the four-layer model works. Keep those files in sync with the owner's local auto-memory when architecture changes land.

---

## Outreach with intent routing (v1.8.4)

When the owner asks Maelle to ask a colleague to MOVE an existing meeting (not set up a new one), Maelle uses `message_colleague` with `intent='meeting_reschedule'` and the existing meeting's context. If the colleague approves, the calendar event is moved automatically — no second owner turn needed. Decline or counter-offer gets surfaced to the owner.

This replaces the coord-for-reschedule bug where Maelle would create a new meeting next week instead of moving today's.

---

## Roadmap

- [ ] **WhatsApp connector** — owner-only sync channel. Talk to Maelle in WhatsApp the same way you do in Slack; tasks created in either surface stay in sync. Not for general WhatsApp messaging — only the owner ↔ Maelle channel.
- [ ] **Email connector** — Maelle reads and writes emails. CC her on a meeting invite to have her book it; ask her to send a follow-up to a thread. Same skill set as Slack, different format.
- [ ] **Inbound workflows** — Maelle listens for inbound triggers (e.g. a new lead arrives in a channel) and runs a skill end-to-end (research the company, prepare a brief, hand off to the right person). Trigger → skill → result.
- [ ] **Meeting notes preparation** — for 1:1s and topic-driven meetings. Owner sends a topic ahead of time; Maelle prepares a brief based on company knowledge + history. After the meeting, she summarizes (handing off to the existing SummarySkill).

Each item is tracked as a GitHub issue.

---

## License

MIT
