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

```
User message (Slack DM / group / @mention)
        │
        ▼
  Connector layer          ← receives the message, resolves mentions, filters relevance
  (connectors/slack/)
        │
        ▼
  Orchestrator             ← builds system prompt, runs Claude tool-use loop
  (core/orchestrator/)
        │
   ┌────┴────┐
   │  Core   │             ← always active: memory, task queue, routine scheduler
   │ modules │
   └────┬────┘
        │
   ┌────┴──────┐
   │  Skills   │           ← opt-in per user: scheduling, briefing, coordination, etc.
   └────┬──────┘
        │
   ┌────┴──────────┐
   │  Connectors   │       ← external services: Microsoft Graph, Slack API
   └───────────────┘
        │
        ▼
  Reply posted back to user
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
│   ├── assistant.ts         # MemorySkill — preferences, people memory, notes, gender, social
│   ├── assistantSelf.ts     # Maelle's own self-memory (her name story, etc.)
│   ├── outreach.ts          # OutreachCoreSkill — message_colleague, find_slack_channel
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
│   ├── meetings.ts          # MeetingsSkill — direct ops + multi-party coordination
│   ├── _meetingsOps.ts      # Internal helper (underscore prefix = not loadable)
│   ├── calendarHealth.ts    # CalendarHealthSkill — issues, lunch, categories
│   ├── general.ts           # SearchSkill — web_search, web_extract
│   ├── research.ts          # ResearchSkill — owner-only multi-step
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
| **MemorySkill** (`core/assistant.ts`) | Preferences, people memory, notes, interaction log, gender. Tools: `learn_preference`, `recall_preferences`, `note_about_person`, `update_person_profile`, `log_interaction`, `confirm_gender` |
| **OutreachCoreSkill** (`core/outreach.ts`) | How Maelle speaks to people on the owner's behalf. Tools: `message_colleague`, `find_slack_channel` |
| **TasksSkill** (`tasks/skill.ts`) | Tasks, approvals, structured requests, briefings. Tools: `create_task`, `get_my_tasks`, `cancel_task`, `create_approval`, `resolve_approval`, `list_pending_approvals`, `store_request`, `get_pending_requests`, `resolve_request`, `escalate_to_user`, `get_briefing` |
| **RoutinesSkill** (`tasks/crons.ts`) | Recurring automations. Tools: `create_routine`, `get_routines`, `update_routine`, `delete_routine` |

### Optional (toggled in YAML)

| Skill | Key | What it does |
|---|---|---|
| **Meetings** | `meetings: true` | Direct calendar ops + multi-party coordination in one skill. Tools: `get_calendar`, `analyze_calendar`, `get_free_busy`, `find_available_slots`, `create_meeting`, `move_meeting`, `update_meeting`, `delete_meeting`, `find_slack_user`, `coordinate_meeting`, `get_active_coordinations`, `finalize_coord_meeting`, `check_join_availability` |
| **Calendar health** | `calendar_health: true` | Weekly review, lunch protection, issue tracking. Tools: `check_calendar_health`, `book_lunch`, `set_event_category`, `get_calendar_issues`, `update_calendar_issue` |
| **Search** | `search: true` | Web search + URL extraction. Tools: `web_search`, `web_extract` |
| **Research** | `research: true` | Owner-only multi-step research (reuses `web_search`) |

Legacy YAML keys `scheduling: true` / `coordination: true` auto-migrate to `meetings: true` at load time.

### Routine examples

Routines are user-defined automations written in plain English. Examples:

- *"Every work day at 8:30am, check my calendar for back-to-backs or missing lunch"*
- *"Every Sunday at 9am, look at the week ahead and flag anything that needs attention"*
- *"Every Thursday at 4pm, summarise open tasks and outstanding coordinations"*

---

## Connectors

### Microsoft Graph (Outlook Calendar)

Handles all calendar operations via the Microsoft Graph API using an Azure service principal (client credentials flow — no user login required).

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
| AI model | Anthropic Claude Sonnet 4.6 (Sonnet everywhere — no Haiku anywhere in src/) |
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

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start
```

---

## Roadmap

- [ ] Email connector (read inbox, draft and send replies)
- [ ] OneNote / knowledge base integration
- [ ] Proactive alerts (anomaly detection on calendar and tasks)
- [ ] WhatsApp connector (enable for production)
- [ ] Web dashboard for profile management

---

## License

MIT
