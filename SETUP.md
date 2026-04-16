# Setup Guide

Complete step-by-step setup from zero to a live AI assistant in Slack with calendar access.

**Time to complete:** ~45–60 minutes (most of it is waiting for Azure and Slack to save settings)

---

## Table of Contents

1. [Before you start](#1-before-you-start)
2. [Where to run it](#2-where-to-run-it)
3. [Get the code](#3-get-the-code)
4. [Create the Slack app](#4-create-the-slack-app)
5. [Register an Azure AD app](#5-register-an-azure-ad-app)
6. [Get your Anthropic API key](#6-get-your-anthropic-api-key)
7. [Set up environment variables](#7-set-up-environment-variables)
8. [Create your user profile](#8-create-your-user-profile)
9. [Run for the first time](#9-run-for-the-first-time)
10. [Keep it running in production](#10-keep-it-running-in-production)
11. [Add a second assistant](#11-add-a-second-assistant)
12. [Optional services](#12-optional-services)
13. [Security checklist](#13-security-checklist)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Before you start

| Requirement | Notes |
|---|---|
| **Node.js 20+** | Check: `node --version`. Download at [nodejs.org](https://nodejs.org) |
| **npm 9+** | Comes with Node |
| **Anthropic API key** | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| **Microsoft 365 account** | The calendar you want the assistant to manage |
| **Azure AD access** | Needs permission to register an app in your tenant. If you're the admin, you have this. If not, ask your IT admin. |
| **Slack workspace** | Where the assistant will live |
| **Slack admin rights** | Needed to install the bot to the workspace |

---

## 2. Where to run it

The platform uses Slack's **Socket Mode** — the bot dials out to Slack over a WebSocket. There is **no open port, no firewall rule, no domain name needed**. It can run anywhere with internet access.

### Options

| Option | Good for | Tradeoffs |
|---|---|---|
| **Your laptop** | Testing and development | Works fine. Stops when laptop sleeps or closes. |
| **A cheap VPS** ⭐ | Personal production use | Best option. $4–10/month, always on. |
| **Home server / Raspberry Pi** | Home lab | Works on Pi 4+. Depends on your home internet uptime. |
| **Railway / Render / Fly.io** | Cloud hosting | Easy deploys, free tiers available. Set up like any Node.js app. |
| **Docker** | Any containerised setup | Straightforward — just needs a `Dockerfile` |

**Recommended for personal use:** A small VPS (Hetzner CX11 ~€4/mo, DigitalOcean Droplet ~$6/mo, Vultr ~$6/mo). SSH in, follow this guide, run with pm2. Set it up once and forget about it.

> **No open ports required.** Socket Mode means you don't need to configure firewalls, reverse proxies, or TLS certificates.

---

## 3. Get the code

```bash
git clone https://github.com/your-username/maelle.git
cd maelle
npm install
mkdir -p data logs
```

---

## 4. Create the Slack app

Each assistant needs its own dedicated Slack app — this is what makes it appear as a real named person in your workspace. If you want two assistants (e.g. one per executive), you create two apps.

### 4.1 — Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From Scratch**
2. App name: the assistant's name (e.g. `Maelle`)
3. Pick your workspace → **Create App**

### 4.2 — Enable Socket Mode

1. Left sidebar → **Socket Mode** → toggle **Enable Socket Mode** ON
2. Under **App-Level Tokens** → click **Generate Token and Scopes**
3. Token name: anything (e.g. `socket-token`)
4. Scope: `connections:write`
5. Click **Generate** → copy the token (starts with `xapp-`)
6. → save as `app_token` in your profile YAML (step 8)

### 4.3 — Add bot permissions

Left sidebar → **OAuth & Permissions** → **Bot Token Scopes** → add all of these:

| Scope | Why |
|---|---|
| `chat:write` | Send messages |
| `im:history` | Read direct message history |
| `im:read` | List DM channels |
| `im:write` | Open DM conversations |
| `mpim:history` | Read group DM history |
| `mpim:read` | List group DM channels |
| `mpim:write` | Open group DM conversations |
| `channels:history` | Read messages in public channels (for @mentions) |
| `groups:history` | Read messages in private channels |
| `app_mentions:read` | Receive @mention events |
| `users:read` | Look up users by name |
| `users:read.email` | Look up users by email address |
| `files:read` | Read voice messages |
| `reactions:write` | Add emoji reactions |
| `channels:join` | Auto-join public channels when posting on the owner's behalf |

### 4.4 — Enable events

1. Left sidebar → **Event Subscriptions** → toggle **Enable Events** ON
2. Under **Subscribe to bot events**, add:
   - `message.im` — direct messages
   - `message.mpim` — group DMs
   - `app_mention` — @mentions in channels
3. **Save Changes**

### 4.5 — Install the app

1. Left sidebar → **OAuth & Permissions** → scroll to top → **Install to Workspace → Allow**
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
3. → save as `bot_token` in your profile YAML (step 8)

### 4.6 — Get the signing secret

1. Left sidebar → **Basic Information** → **App Credentials**
2. Copy **Signing Secret**
3. → save as `signing_secret` in your profile YAML (step 8)

### 4.7 — App Home (optional but recommended)

Left sidebar → **App Home**:
- Enable the **Messages Tab**
- Tick **Allow users to send Slash commands and messages from the messages tab**
- Toggle **Always Show My Bot as Online** → gives the assistant a green presence dot

### 4.8 — Find your own Slack user ID

Open Slack → click your avatar → **Profile** → three-dot menu → **Copy member ID**
It looks like `UXXXXXXXXXX`. You'll need this for your profile YAML.

---

## 5. Register an Azure AD app

This gives the assistant read/write access to Outlook Calendar via Microsoft Graph. One Azure registration serves all assistants on your instance — you only do this once.

### 5.1 — Register the app

1. Go to [portal.azure.com](https://portal.azure.com)
2. Search **App registrations** → **New registration**
3. Name: `Assistant Platform` (or anything descriptive)
4. Supported account types: **Accounts in this organizational directory only**
5. Leave Redirect URI blank → **Register**

### 5.2 — Copy the IDs

From the app overview page:
- **Application (client) ID** → save as `AZURE_CLIENT_ID` in `.env`
- **Directory (tenant) ID** → save as `AZURE_TENANT_ID` in `.env`

### 5.3 — Create a client secret

1. Left sidebar → **Certificates & secrets** → **New client secret**
2. Description: `assistant-prod` | Expires: 24 months
3. Click **Add**
4. **Copy the Value immediately** — it is only shown once
5. → save as `AZURE_CLIENT_SECRET` in `.env`

> Set a calendar reminder to rotate this secret before it expires.

### 5.4 — Grant calendar permissions

1. Left sidebar → **API permissions** → **Add a permission → Microsoft Graph → Application permissions**
2. Add: `Calendars.ReadWrite`
3. Click **Grant admin consent for [your org]** — requires an Azure admin account
4. Confirm all permissions show ✅

> **Application permissions** (not delegated) are used here. The assistant acts as a service and accesses calendars without a user login. Admin consent is required for this to work.

> **Optional additions** for future features: `Mail.Read`, `Mail.Send` (email), `Notes.Read` (OneNote)

---

## 6. Get your Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com) → **API Keys** → **Create Key**
2. Copy the key (starts with `sk-ant-`)
3. → save as `ANTHROPIC_API_KEY` in `.env`

---

## 7. Set up environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in:

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Azure — from step 5
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_SECRET=your-secret-value

# Storage — defaults are fine
DB_PATH=./data/maelle.db
LOG_PATH=./logs

# Runtime
NODE_ENV=production

# Optional — see section 12
OPENAI_API_KEY=sk-...
TAVILY_API_KEY=tvly-...
```

> **Testing Slack before Azure is ready?** Use placeholder UUIDs for the Azure values:
> `AZURE_TENANT_ID=00000000-0000-0000-0000-000000000000` — calendar features will fail gracefully.

`.env` is gitignored and will never be committed.

---

## 8. Create your user profile

Every person the assistant serves gets their own YAML file. This is where all personalisation lives: schedule, meeting rules, assistant identity, Slack credentials, and which skills are active.

### Copy the template

```bash
cp config/users.example/user.example.yaml config/users/yourname.yaml
```

Use a simple filename like `idan.yaml` or `sarah.yaml`.

### Key sections to fill in

#### Your identity
```yaml
user:
  name: "Idan Cohen"                 # First and last — appears in prompts and greetings
  email: "idan@yourcompany.com"      # Your Microsoft 365 email — used for calendar access
  role: "CEO"
  slack_user_id: "UXXXXXXXXXX"       # From step 4.8
  timezone: "Asia/Jerusalem"         # IANA timezone string
  language: "en"
  company: "Acme Corp"               # Company name — appears in identity lines
  company_brief: |                   # Optional — injected into every prompt so the assistant knows the business
    Acme Corp builds enterprise supply chain software for mid-market manufacturers.
    We have ~80 employees and sell to logistics and retail customers globally.
    Keep this to 3–5 sentences — it's included in every request.
```

Full IANA timezone list: [en.wikipedia.org/wiki/List_of_tz_database_time_zones](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)

#### Assistant identity
```yaml
assistant:
  name: "Maelle"
  slack_display_name: "Maelle"
  email: "maelle@yourcompany.com"
  persona: |
    You are a warm, professional, and efficient executive assistant.
    You communicate like a real human — natural, concise, and always
    moving toward a resolution. You never sound robotic or verbose.
  slack:
    bot_token: "xoxb-..."            # From step 4.5
    app_token: "xapp-..."            # From step 4.2
    signing_secret: "..."            # From step 4.6
```

#### Work schedule
```yaml
schedule:
  office_days:
    days: ["Monday", "Wednesday", "Thursday"]
    hours_start: "09:30"
    hours_end: "18:30"
  home_days:
    days: ["Sunday", "Tuesday"]
    hours_start: "09:00"
    hours_end: "16:00"
  lunch:
    preferred_start: "12:00"
    preferred_end: "13:30"
    duration_minutes: 45
    can_skip: true
```

> The union of `office_days.days` and `home_days.days` is your work week. Scheduling never proposes meetings outside these days. Use full English day names.

#### Meeting rules
```yaml
meetings:
  allowed_durations: [10, 25, 40, 55]   # Durations that end 5 min before :00/:15/:30/:45
  buffer_minutes: 5
  free_time_per_office_day_hours: 2
  physical_meetings_require_office_day: true
```

#### Skills — turn on what you need
```yaml
skills:
  meetings: true            # Direct calendar ops + multi-party coordination — requires Azure (step 5)
  calendar_health: true     # Weekly review, lunch protection, issue tracking
  search: true              # Web search — requires TAVILY_API_KEY (section 12)
  research: false           # Owner-only multi-step research
  meeting_summaries: false  # Not yet implemented
  email_drafting: false     # Not yet implemented
  proactive_alerts: false   # Not yet implemented
  whatsapp: false           # Requires additional setup (section 12)
```
Legacy `scheduling: true` / `coordination: true` auto-migrate to `meetings: true` at load time.

---

## 9. Run for the first time

```bash
npm run build
npm start
```

For development with hot-reload:
```bash
npm run dev
```

**Expected output:**
```
✅ Maelle → online (for Idan Cohen)

1 assistant(s) running in Socket Mode — no open ports
```

**Test it:** Open Slack, find your assistant in the Apps list (left sidebar), send a DM:
> *"What's on my calendar today?"*

It should respond within a few seconds. If it doesn't, check `logs/` for errors.

---

## 10. Keep it running in production

If you're running on a server, you want the process to survive reboots and auto-restart on crashes.

### Option A — pm2 (recommended)

```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name maelle
pm2 save            # remember this process across reboots
pm2 startup         # generate the startup command, then run what it prints
```

Useful commands:
```bash
pm2 status          # is it running?
pm2 logs maelle     # tail live logs
pm2 restart maelle  # restart after changes
pm2 stop maelle     # stop
```

**To update:**
```bash
git pull && npm install && npm run build && pm2 restart maelle
```

### Option B — systemd (Linux only)

Create `/etc/systemd/system/maelle.service`:

```ini
[Unit]
Description=Maelle AI Assistant
After=network.target

[Service]
Type=simple
User=yourlinuxuser
WorkingDirectory=/home/yourlinuxuser/maelle
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
EnvironmentFile=/home/yourlinuxuser/maelle/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable maelle
sudo systemctl start maelle
sudo systemctl status maelle
```

---

## 11. Add a second assistant

Each executive gets their own YAML file. The platform loads every file in `config/users/` at startup and runs all assistants in parallel.

1. Create a new Slack app for the second assistant (repeat step 4 with their name)
2. Copy the template: `cp config/users.example/user.example.yaml config/users/sarah.yaml`
3. Fill in Sarah's profile, her schedule, and the new Slack app's tokens
4. Restart: `pm2 restart maelle`

All assistants share the same `.env` (Anthropic + Azure credentials) and the same database, but all data is isolated by user ID — one person's tasks, memory, and calendar are completely invisible to another.

---

## 12. Optional services

### Web search — Tavily

Required for the **Search** skill (`general_knowledge: true`).

1. Sign up at [tavily.com](https://tavily.com) — free tier, no credit card needed
2. Copy your API key
3. Add to `.env`: `TAVILY_API_KEY=tvly-...`

### Voice messages — OpenAI

Required to transcribe Slack voice messages and optionally reply with audio.

1. Sign up at [platform.openai.com](https://platform.openai.com) → API Keys
2. Copy the key
3. Add to `.env`: `OPENAI_API_KEY=sk-...`

### WhatsApp

The connector is implemented but disabled by default. Requires a dedicated phone number or SIM to scan a QR code on first launch.

1. Set `WHATSAPP_OWNER_PHONE` in `.env` (international format without `+`, e.g. `972501234567`)
2. Set `whatsapp: true` in your YAML under `skills:`
3. Uncomment the WhatsApp import lines in `src/index.ts`
4. On first run, scan the QR code printed in the terminal

---

## 13. Security checklist

- [ ] `.env` is gitignored — never committed to version control
- [ ] `config/users/` is gitignored — personal profiles stay private
- [ ] `config/users.example/` is committed — template only, no real data
- [ ] Azure app has only `Calendars.ReadWrite` (no broader permissions)
- [ ] No inbound ports open — Socket Mode is outbound only
- [ ] Client secret expiry noted — rotate every 24 months
- [ ] `data/` and `logs/` are excluded from backups shared publicly

---

## 14. Troubleshooting

| Symptom | What to check |
|---|---|
| Nothing starts, no output | Run `npm run build` first — check for TypeScript errors |
| `Missing or invalid environment variables` | Check `.env` — every required field must be filled |
| UUID validation error | Azure values in `.env` must be valid UUIDs. Use `00000000-0000-0000-0000-000000000000` as placeholder for testing |
| `No user profiles found` | YAML file must be in `config/users/` — not in `config/users.example/` |
| Assistant doesn't appear in Slack | Check `app_token` (xapp-) and that Socket Mode is enabled |
| Assistant doesn't respond to messages | Check `bot_token` (xoxb-) and that Events are subscribed in the Slack app |
| Calendar returns empty or errors | Azure admin consent granted? Is `user.email` a valid M365 account in the same tenant? |
| "Runs into an issue" on every message | Check the terminal logs — likely a missing or invalid `.env` value |
| Second assistant not starting | Confirm their YAML has all three Slack tokens filled in |
| `Skills active` not logged | Normal — that log was intentionally removed to reduce noise |

---

## Where everything lives

| What | Location |
|---|---|
| Infrastructure secrets (API keys, Azure) | `.env` |
| Your personal profile and schedule | `config/users/<yourname>.yaml` |
| Which skills are active | `config/users/<yourname>.yaml` → `skills:` section |
| Assistant's identity and Slack tokens | `config/users/<yourname>.yaml` → `assistant:` section |
| Database (tasks, memory, routines, history) | `data/maelle.db` — auto-created on first run |
| Logs | `logs/` — auto-created on first run |
| Source code | `src/` |
