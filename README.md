<p align="center">
  <img src="social-preview.png" alt="n8n-claw logo" width="600">
</p>

# n8n-claw — Self-Hosted AI Agent

A fully self-hosted AI agent built on n8n + PostgreSQL + Claude. Talks to you via Telegram or HTTP API (Slack, Teams, custom apps), builds its own MCP tools, manages reminders and memory — all running on your own infrastructure.

**Short Introduction**

https://github.com/user-attachments/assets/10b7b93d-f482-47c1-a144-80a1b9d1be16

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Installation](#installation)
- [Services & URLs](#services--urls)
- [Webhook API & External Integrations](#webhook-api--external-integrations)
- [MCP Skills Library](#mcp-skills-library)
- [Google Services (OAuth2)](#google-services-oauth2)
- [Expert Agents](#expert-agents)
- [OpenClaw Integration](#openclaw-integration)
- [Building custom MCP Skills](#building-custom-mcp-skills)
- [Memory](#memory)
- [Project Memory](#project-memory)
- [Task Management](#task-management)
- [Reminders & Scheduled Actions](#reminders--scheduled-actions)
- [Media Support](#media-support)
- [Heartbeat & Scheduled Actions](#heartbeat--scheduled-actions-1)
- [Customization](#customization)
- [Alternative LLM Providers](#alternative-llm-providers)
- [Switching from Telegram to WhatsApp](#switching-from-telegram-to-whatsapp)
- [HTTPS Setup](#https-setup)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [WorkflowBuilder with Claude Code](#optional-workflowbuilder-with-claude-code)
- [Stack](#stack)

---

## What it does

Talk to your agent in natural language — it manages tasks, remembers context across conversations, builds API integrations, and proactively keeps you on track.

- **Telegram chat** — talk to your AI agent directly via Telegram
- **Webhook API** — call the agent from any external system via HTTP (Slack, Teams, Paperclip, custom apps)
- **Long-term memory** — remembers conversations and important context with optional semantic search (RAG)
- **Task management** — create, track, and complete tasks with priorities and due dates
- **Proactive heartbeat** — automatically reminds you of overdue/urgent tasks
- **Recurring actions** — repeating tasks on any schedule ("check my emails every 15 minutes", "daily briefing at 8am")
- **Smart background checks** — monitoring tasks only notify you when something new is found
- **Expert agents** — delegate complex tasks to specialized sub-agents (3 included, 100+ available from [agent catalog](https://github.com/freddy-schuetz/n8n-claw-agents) across 12 categories)
- **MCP Skills** — install pre-built skills or build new API integrations on demand
- **Smart reminders** — timed Telegram reminders ("remind me in 2 hours to...")
- **Scheduled actions** — the agent executes instructions at a set time ("search HN for AI news at 9am")
- **Web search** — searches the web via built-in SearXNG instance (no API key needed)
- **Web reader** — reads webpages as clean markdown via Crawl4AI (JS rendering, no boilerplate)
- **File passthrough** — stores documents and photos from Telegram so Skills can use the originals (upload to Lexware, save to Nextcloud, etc.)
- **Project memory** — persistent markdown documents for tracking ongoing work across conversations
- **OpenClaw integration** — delegate coding tasks to an autonomous AI agent that can build websites, apps, and run shell commands
- **Extensible** — add new skills and capabilities through natural language or from the skill catalog

## Architecture

```
Telegram  ───────────────────────────────────┐
Webhook API (POST /webhook/agent)  ───────┐
  │                                     │
  └─────────────────▼─────────────────────┘
n8n-claw Agent (Claude Sonnet)
  ├── Task Manager        — create, track, complete tasks
  ├── Project Manager     — persistent project notes (markdown)
  ├── Memory              — save, search, update, delete long-term memories
  ├── MCP Client          → calls tools on MCP skill servers
  ├── Library Manager     → install/remove skills from catalog
  ├── MCP Builder          → builds custom skills from scratch
  ├── Reminder            — timed reminders + scheduled actions
  ├── Expert Agent        → delegates to specialized sub-agents
  ├── Agent Library       → install/remove expert agents from catalog
  ├── Telegram Status     — sends progress updates during long tasks
  ├── HTTP Tool           — simple web requests
  ├── Web Search          — search the web (SearXNG)
  ├── Web Reader          — read webpages as markdown (Crawl4AI)
  └── Self Modify         — inspect/list n8n workflows
  │
  ├── Webhook caller? → JSON response to HTTP caller
  └── Telegram?      → Telegram Reply

Webhook Adapter (optional, connects external systems):
  💬 Slack Trigger     ──┐
  💬 Teams Trigger     ──┤
  🌐 Generic Webhook   ──┼── Map Input → POST /webhook/agent → Route Response
  🛠️ Custom Webhook    ──┘   (Set node — easy to customize, no code)

Background Workflows (automated):
  💓 Heartbeat              — every 5 min: recurring actions + proactive reminders + file cleanup
  🔍 Background Checker     — silent checks: only notifies when something new is found
  🧠 Memory Consolidation   — daily at 3am: summarizes conversations → long-term memory
  ⏰ Reminder Runner         — every 1 min: sends due reminders + triggers one-time actions

Internal Services:
  📁 File Bridge            — temporary binary storage (documents, photos) for tool passthrough
  📧 Email Bridge           — IMAP/SMTP REST API for email integration
```

---

## Installation

> **Want to run locally instead of on a VPS?** See the [Local Setup Guide](LOCAL_SETUP.md) for Docker + ngrok instructions (contributed by [@salvodmt](https://github.com/salvodmt), tested on Debian 13).

### What you need

- A Linux VPS (Ubuntu 22.04/24.04 recommended, also tested with Debian 13, 4GB RAM and 15GB Disk minimum)
- A **Telegram Bot** — create one via [@BotFather](https://t.me/BotFather)
- Your **Telegram Chat ID** — get it from [@userinfobot](https://t.me/userinfobot)
- An **Anthropic API Key** — from [console.anthropic.com](https://console.anthropic.com)
- A **domain name** (optional but recommended, required for Telegram HTTPS webhooks)

### Step 1 — Clone & run

```bash
git clone https://github.com/freddy-schuetz/n8n-claw.git && cd n8n-claw && ./setup.sh
```

The script will:

1. **Update the system** (`apt update && apt upgrade`)
2. **Install Docker** automatically if not present
3. **Start n8n** so you can generate an API key
4. **Ask you for configuration** interactively:
   - n8n API Key *(generated in n8n UI → Settings → API)*
   - Telegram Bot Token
   - Telegram Chat ID
   - Anthropic API Key
   - Domain name *(optional — enables HTTPS via Let's Encrypt + nginx, or skip nginx if you already have a reverse proxy)*
5. **Configure your agent's personality**:
   - Agent name
   - Your name
   - Preferred language
   - Timezone *(auto-detected from system)*
   - Communication style (casual / professional / friendly)
   - Proactive vs reactive behavior
   - Free-text custom persona *(overrides the above)*
6. **Start all services** (n8n, PostgreSQL, PostgREST, Kong, Supabase Studio, SearXNG, Crawl4AI, Email Bridge, File Bridge)
7. **Apply database schema** and seed data
8. **Create n8n credentials** (Telegram Bot automatically)
9. **Import all workflows** into n8n
10. **Wire workflow references** (MCP Builder, Reminders, etc.)
11. **Activate the agent** automatically

### Step 2 — Add credentials in n8n UI

Open n8n at the URL shown at the end of setup.

The easiest way is to open each workflow and click **"Create new credential"** directly on the node that needs it. n8n will prompt you automatically.

**Credentials you'll need:**

| Credential | Name (exact!) | Where needed |
|---|---|---|
| Postgres | `Supabase Postgres` | Agent, Sub-Agent Runner |
| Anthropic API | `Anthropic API` | Agent (Claude node), MCP Builder, Sub-Agent Runner |
| Telegram Bot | `Telegram Bot` | Agent (Telegram Trigger + Reply) — *created automatically by setup* |
| OpenAI API | `OpenAI API` | Agent (Voice transcription via Whisper) — *optional, created by setup if key provided* |
| Webhook Auth | `Webhook Auth` | Agent + Adapter (Webhook Triggers) — *created automatically by setup* |

**After fresh install — connect credentials in these workflows:**

| Workflow | Credentials to connect |
|---|---|
| n8n-claw Agent | Postgres, Anthropic API, OpenAI API (optional) |
| MCP Builder | Anthropic API (select on LLM node) |
| Sub-Agent Runner | Postgres, Anthropic API |

**After update (`./setup.sh`)** — credentials persist in the Agent and MCP Builder, but must be re-selected in:

| Workflow | Credentials to re-connect |
|---|---|
| Sub-Agent Runner | Postgres, Anthropic API |

**Postgres connection details** *(shown in setup output)*:
- Host: `db` | Port: `5432` | DB: `postgres` | User: `postgres`
- Password: *(shown at end of setup)*
- SSL: `disable`

**Optional: Embeddings for semantic memory search:**

During setup, you'll be asked for an embedding API key. This enables vector-based memory search (RAG) — the agent can find memories by meaning, not just exact keywords.

- **OpenAI** (default): `text-embedding-3-small` — [platform.openai.com](https://platform.openai.com) (requires API key)
- **Voyage AI**: `voyage-3-lite` — [voyageai.com](https://www.voyageai.com) (free tier available)
- **Ollama**: `nomic-embed-text` — local, no API key needed (requires Ollama running on your server)

Without an embedding key, the agent still works — it falls back to keyword-based memory search.

**Optional: OpenAI API Key for voice messages:**

If you chose OpenAI as your embedding provider, the same key is automatically used for voice transcription (Whisper) — no extra input needed. If you use a different embedding provider (or none), setup will ask separately for an OpenAI key. Without it, voice messages won't work — but photos, documents, and locations work without any extra keys.

### Step 3 — Activate remaining workflows

These workflows are **activated automatically** by setup — no action needed:

| Workflow | Purpose |
|---|---|
| n8n-claw Agent | Main agent — receives Telegram + Webhook messages, calls tools |
| Heartbeat | Background: recurring actions + proactive reminders (every 5 min) |
| Background Checker | Sub-workflow: silent background checks, only notifies on changes |
| Memory Consolidation | Background: summarizes conversations into long-term memory (daily 3am) |
| Reminder Runner | Background: delivers reminders + triggers one-time actions (every 1 min) |

These workflows need to be **activated manually** in n8n UI:

| Workflow | Purpose |
|---|---|
| MCP Builder | Builds custom MCP skills on demand |
| MCP: Weather | Example MCP Server — weather via Open-Meteo (no API key) |
| WorkflowBuilder | Builds general n8n automations *(optional — requires [extra setup](#optional-workflowbuilder-with-claude-code))* |

Sub-workflows (called by other workflows, no manual activation needed):

| Workflow | Called by |
|---|---|
| MCP Client | Agent — calls tools on MCP skill servers |
| MCP Library Manager | Agent — installs/removes skills from catalog |
| Sub-Agent Runner | Agent — runs expert agents with loaded personas |
| Agent Library Manager | Agent — installs/removes expert agents |
| ReminderFactory | Agent — creates, lists, edits, and deletes reminders/tasks |
| credential-form | Library Manager — secure form for entering API keys |
| OAuth Callback | Google Skills — handles OAuth2 authorization redirect |
| Webhook Adapter | Connects Slack, Teams, and custom apps to the agent (imported inactive) |

### Step 4 — Start chatting

Send a message to your Telegram bot. It's ready!

You can also test the webhook API:

```bash
curl -X POST https://YOUR-DOMAIN/webhook/agent \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_WEBHOOK_SECRET" \
  -d '{"message": "Hello!", "user_id": "test-user"}'
```

The `WEBHOOK_SECRET` is shown at the end of setup output (also in `.env`).

### Secure your Telegram bot

By default, your Telegram bot accepts messages from **anyone** who finds it. To restrict it to your chat only:

1. Open the **n8n-claw Agent** workflow in n8n
2. Click the **Telegram Trigger** node
3. Under **Additional Fields**, add **Allowed Chat IDs**
4. Enter your Telegram Chat ID (the one from setup)
5. Save the workflow

This ensures only you can talk to your agent. Without this, anyone on Telegram could message your bot and access the agent's capabilities.

---

<details>
<summary>

## Services & URLs

</summary>

After setup, these services run:

| Service | URL | Purpose |
|---|---|---|
| n8n | `http://YOUR-IP:5678` | Workflow editor |
| Supabase Studio | `http://localhost:3001` (via SSH tunnel) | Database admin UI |
| Webhook API | `https://YOUR-DOMAIN/webhook/agent` | Agent HTTP endpoint (POST, requires X-API-Key header) |
| Webhook Adapter | `https://YOUR-DOMAIN/webhook/adapter` | Multi-system adapter endpoint (POST) |
| Custom Webhook | `https://YOUR-DOMAIN/webhook/custom` | Easy-to-customize adapter (Set node, no code) |
| SearXNG | `http://localhost:8888` (Docker-internal) | Self-hosted web search engine |
| Crawl4AI | Docker-internal only | Web reader — JS rendering to clean markdown |
| Email Bridge | `http://localhost:3100` (Docker-internal) | IMAP/SMTP email REST API (for Email skill) |
| File Bridge | `http://localhost:3200` (Docker-internal) | Temporary file storage for binary passthrough between tools |
| PostgREST API | `http://kong:8000` (Docker-internal only) | REST API for PostgreSQL |

### Accessing Supabase Studio

Supabase Studio is bound to `localhost` only (not publicly exposed). To access it from your browser, open an SSH tunnel:

```bash
ssh -L 3001:localhost:3001 user@YOUR-VPS-IP
```

Then open `http://localhost:3001` in your browser. The tunnel stays open as long as the SSH session runs.

</details>

---

<details>
<summary>

## Webhook API & External Integrations

</summary>

n8n-claw exposes an HTTP API so external systems can talk to the agent — no Telegram required.

### Direct Webhook API

Any system that can make HTTP requests can call the agent directly:

```
POST {{N8N_URL}}/webhook/agent
Header: X-API-Key: {{WEBHOOK_SECRET}}
Content-Type: application/json

{
  "message": "What is the weather in Berlin?",
  "user_id": "my-app-user-123",
  "session_id": "my-app:conv-456",
  "source": "my-app",
  "metadata": { "any": "data you want back" }
}
```

**Response (200):**

```json
{
  "success": true,
  "response": "The weather in Berlin is...",
  "session_id": "my-app:conv-456",
  "source": "my-app",
  "metadata": { "any": "data you want back" }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `message` | yes | — | The user's message |
| `user_id` | yes | — | Unique user identifier |
| `session_id` | no | `api:{user_id}` | Conversation session ID (for history) |
| `source` | no | `api` | Source identifier (appears in logs) |
| `metadata` | no | `{}` | Arbitrary data — round-trips back in the response |

The agent uses `session_id` and `user_id` (with source prefix) for conversation history and user profiles — same as Telegram, just with different prefixes.

### Webhook Adapter (Slack, Teams, Paperclip)

For systems that need input/output mapping (different message formats, response routing), use the **Webhook Adapter** workflow. It translates between external formats and the agent's webhook API.

The adapter ships with four triggers:

| Trigger | Endpoint | Default state | Use case |
|---|---|---|---|
| **Generic Webhook** | `/webhook/adapter` | Active | Paperclip, API power-users (Code node with fallback chains) |
| **Custom Webhook** | `/webhook/custom` | Active | Your own apps — simple Set node, easy to customize without code |
| **Slack Trigger** | — | Disabled | Slack workspace integration |
| **Teams Trigger** | — | Disabled | Microsoft Teams integration |

Each trigger has a mapper node that normalizes messages → calls `/webhook/agent` → routes the response back to the right system via `metadata._responseChannel`. Paperclip payloads are auto-detected and get a dedicated response branch that posts the agent's answer as a comment and marks the issue as done.

### Enabling Slack

1. **Create a Slack App** at [api.slack.com/apps](https://api.slack.com/apps)
2. **Add Bot Token Scopes** under OAuth & Permissions: `chat:write`, `channels:history`, `channels:read`
3. **Install to workspace** and copy the Bot Token (`xoxb-...`)
4. **In n8n**: Create a Slack API credential (Bot Token + Signing Secret)
5. **Enable the Slack Trigger + Slack Reply** nodes in the Webhook Adapter workflow
6. **Activate the Webhook Adapter** workflow
7. **In Slack App settings**: Add the Slack Trigger's webhook URL under Event Subscriptions
8. **Subscribe to bot events**: `message.channels` (public channels), `message.im` (direct messages)
9. **Invite the bot** to your Slack channel (`/invite @YourBotName`)

> The Slack Trigger webhook URL changes when the adapter workflow is re-created (e.g. `setup.sh --force`). Update the Event Subscriptions URL in your Slack App after each reinstall.

### Enabling Teams

1. **Register a Bot** in [Azure Portal](https://portal.azure.com) (Bot Framework)
2. **Create App ID + Client Secret**
3. **Set Messaging Endpoint** to the Teams Trigger's webhook URL
4. **In n8n**: Create a Microsoft Teams OAuth2 credential
5. **Enable the Teams Trigger + Teams Reply** nodes in the Webhook Adapter workflow
6. **Activate the Webhook Adapter** workflow

### Enabling Paperclip

[Paperclip](https://github.com/paperclipai/paperclip) is an open-source agent orchestration platform. n8n-claw works as a Paperclip agent out of the box — no extra configuration in n8n needed.

The adapter auto-detects Paperclip's payload format (`runId` + `context`), fetches the issue title and description via the Paperclip API, and after the agent responds:
- Posts the response as a **comment** on the Paperclip issue
- Sets the issue status to **done**

**Setup in Paperclip:**

1. **Deploy Paperclip** on the same server or network as n8n-claw
2. **Create a Company** and an **Agent** with `http` adapter type
3. **Configure the agent's HTTP adapter:**
   ```json
   {
     "url": "https://YOUR-DOMAIN/webhook/adapter",
     "method": "POST",
     "headers": {
       "X-API-Key": "YOUR_WEBHOOK_SECRET"
     },
     "payloadTemplate": {
       "source": "paperclip"
     }
   }
   ```
4. **Generate an Agent API Key** in Paperclip (used by n8n-claw to post comments back)
5. **Add placeholders to `.env`** (or hardcode in the workflow):
   - `PAPERCLIP_INTERNAL_URL` — Paperclip's internal URL (e.g. `http://paperclip:3100` if on same Docker network)
   - `PAPERCLIP_AGENT_KEY` — the agent API key from step 4
6. **Create an issue** in Paperclip and assign it to the agent — the heartbeat will trigger the workflow automatically

> **Docker networking:** If Paperclip runs on the same server, connect it to n8n-claw's Docker network (`n8n-claw_n8n-claw-net`) and use the container DNS name (`paperclip:3100`) instead of `localhost`.

### Adding a Custom Integration

**Easiest way — use the Custom Webhook (no code):**

1. Open the **Map Custom Input** Set node in the Webhook Adapter workflow
2. Adjust the field mappings to match your app's JSON structure:
   - `message` → the field containing the user's text (e.g. `$json.body.text`)
   - `user_id` → the sender identifier (e.g. `$json.body.username`)
   - `session_id` → unique conversation ID
   - `source` → your app's name
3. Send a POST to `/webhook/custom` with `X-API-Key` header

**Advanced — add a new trigger (for systems with custom response routing):**

1. Add a new **Trigger node** in the Webhook Adapter workflow
2. Add a new **Map node** (Code node) that outputs: `{ message, user_id, session_id, source, metadata: { _responseChannel: "your-system" } }`
3. Add a matching output in the **Route Response** switch node
4. Add a **Reply node** for your system

The `_responseChannel` value in metadata tells the adapter where to route the agent's response.

</details>

---

<details>
<summary>

## MCP Skills Library

</summary>

**37 pre-built skills** available from the [skill catalog](https://github.com/freddy-schuetz/n8n-claw-templates) — install with a single chat command, no coding required.

> "What skills are available?"
> "Install weather-openmeteo"
> "Remove weather-openmeteo"

The Library Manager fetches skill templates from GitHub, imports the workflows into n8n, and registers the new MCP server automatically.

| Category | Examples |
|---|---|
| Communication | Gmail, Email (IMAP/SMTP), OpenClaw |
| Productivity | Todoist, Notion, GitHub, Google Calendar, Nextcloud Files |
| Finance | KontoFlux (Open Banking), Exchange Rates, Crypto Prices |
| Knowledge | Wikipedia, OpenFoodFacts, Dictionary |
| Transport | Deutsche Bahn, Route Planner, Wiener Linien |
| Language | DeepL Translate |
| News | Hacker News, NewsAPI |
| Analytics | Google Analytics, Google Ads |
| Utilities | PDF Tools, QR Code, Website Check |
| Entertainment | TMDB Movies, Recipes |

See the full catalog at [n8n-claw-templates](https://github.com/freddy-schuetz/n8n-claw-templates).

**Skills with API keys:** Some skills require an API key (e.g. NewsAPI). When you install one, the agent sends you a secure one-time link via Telegram. Click it, enter your key — done. The key is stored in the database and the skill reads it at runtime. Links expire after 10 minutes and can only be used once.

> "Install news-newsapi"
> → Agent sends a link to enter your NewsAPI key
> → Enter key in the form → skill works immediately

You can also regenerate a credential link later:
> "Add credential for news-newsapi"

Want to create your own skills? See the [template contribution guide](https://github.com/freddy-schuetz/n8n-claw-templates#creating-a-template).

> **Security notice — Skill credentials are stored in plain text**
>
> API keys entered via the credential form are currently stored **unencrypted** in the `template_credentials` table in PostgreSQL. This means:
>
> - Anyone with access to the database can read all stored API keys
> - Supabase Studio (`localhost:3001`, accessible via SSH tunnel) shows credentials in plain text
> - A compromised VPS exposes all stored API keys
>
> **What an attacker would need:** Neither the database nor the API are reachable from the internet. PostgREST runs on a Docker-internal network only, and PostgreSQL (port 5432) is bound to `127.0.0.1`. To read credentials, an attacker would need SSH access to your VPS — there is no remote network path.
>
> **Mitigation:** Secure SSH access (key-based auth, no root password, fail2ban), and use API keys with minimal permissions where possible.
>
> Encryption at rest for skill credentials is planned and in progress.

</details>

---

<details>
<summary>

## Google Services (OAuth2)

</summary>

Google Skills (Gmail, Google Calendar, Google Analytics, Google Ads) use OAuth2 for authentication — the agent handles the entire flow via Telegram, no n8n UI needed.

All Google skills share a single set of OAuth credentials (`client_id` / `client_secret`). You set them up once, and every additional Google skill reuses them automatically. If a new skill needs extra permissions, the agent generates a new consent link with the expanded scopes.

### Setup

1. **Google Cloud Console** — [console.cloud.google.com](https://console.cloud.google.com)
   - Create a project (or use an existing one)
   - Enable the APIs you need: Gmail API, Google Calendar API, Google Analytics Data API, Google Ads API
   - Go to **APIs & Services → OAuth consent screen**:
     - User Type: **External** (or Internal for Google Workspace)
     - Add your email as a **Test User**
   - Go to **APIs & Services → Credentials → Create Credentials → OAuth Client ID**:
     - Type: **Web application**
     - Authorized redirect URI: `https://YOUR-N8N-DOMAIN/webhook/oauth-callback`
     - Copy the **Client ID** and **Client Secret**

2. **Install a Google skill** — ask your agent:
   > "Install the Gmail skill"

3. **Enter credentials** — the agent sends two secure form links (Client ID + Client Secret). Click each, paste the value, submit.

4. **Authorize** — the agent generates a Google consent link. Click it, sign in with your Google account, grant permissions. The browser shows "Authorization successful" and the agent confirms via Telegram.

5. **Done** — the skill is ready to use.

### Available Google Skills

| Skill | Tools | Scopes |
|---|---|---|
| Gmail | search, read, send, create draft, list labels | gmail.readonly, gmail.modify, gmail.send |
| Google Calendar | list/create/update/delete events, list calendars | calendar, calendar.readonly |
| Google Analytics | run reports, list properties, realtime data | analytics.readonly |
| Google Ads (Beta) | list campaigns, ad groups, stats, performance | adwords |

Google Ads requires an additional **Developer Token** and **Customer ID** (entered via separate credential forms).

### Scope Expansion

When you install a second Google skill (e.g. Calendar after Gmail), the agent checks if the existing token already covers the required scopes. If not, it generates a new consent link that requests all scopes at once (existing + new). Your previously stored refresh token is replaced with one that covers all permissions.

### Important Notes

- **Testing mode**: Google OAuth apps in "Testing" status have refresh tokens that expire after **7 days**. For permanent use, publish the app as "Internal" (Google Workspace) — no verification needed.
- **Token refresh**: Access tokens are refreshed automatically (5-minute buffer before expiry).
- **Shared credentials**: All Google skills share the same `client_id`, `client_secret`, and tokens under the `google-oauth` namespace. You only authenticate once.

</details>

---

<details>
<summary>

## Expert Agents

</summary>

Delegate complex tasks to specialized sub-agents. Each expert has its own AI agent with a focused persona, tools (web search, HTTP requests, web reader, MCP), and works independently — then the main agent rephrases the result in its own tone.

**Three experts are included by default:**

| Agent | Speciality |
|---|---|
| Research Expert | Web research, fact-checking, source evaluation, structured summaries |
| Content Creator | Copywriting, social media posts, blog articles, marketing copy |
| Data Analyst | Data analysis, pattern recognition, KPI interpretation, structured reports |

**Using expert agents:**

> "Research the best hiking trails in Tyrol with sources"
> "Write an Instagram post about our new product launch"
> "Analyze these numbers and give me a summary"

The agent automatically picks the right expert based on your request — or you can ask explicitly:

> "Let the research expert look into this"
> "Delegate this to the content creator"

**Managing agents:**

> "What expert agents do I have?"
> "Install the data analyst"
> "Remove the content creator"

Install more experts from the [agent catalog](https://github.com/freddy-schuetz/n8n-claw-agents) or ask the community to contribute new ones.

**100+ more experts available** from the [agent catalog](https://github.com/freddy-schuetz/n8n-claw-agents) across 12 categories: Analytics, Communications, Creative, Development, Education, HR, Leisure, Marketing, Operations, Product, Research, and Sales.

Many agents pair with MCP Skills for enhanced capabilities — for example, the Data Analyst works with Google Analytics, or the Code Reviewer integrates with GitHub.

**Status updates:** During long-running expert tasks, the agent sends you Telegram progress updates so you know what's happening (e.g. "Starting research expert...").

</details>

---

<details>
<summary>

## OpenClaw Integration

</summary>

Connect n8n-claw to an [OpenClaw](https://github.com/claw-project/openclaw) instance and unlock a completely new class of capabilities. OpenClaw is an autonomous AI agent with full access to a Linux system — it can write code, build websites, deploy applications, manage files, run shell commands, and work on complex multi-step software projects.

With the OpenClaw skill installed, n8n-claw can delegate tasks to OpenClaw and get the results back:

> "Ask OpenClaw to build a landing page for our new product"
> "Let OpenClaw create a Python script that monitors our server uptime"
> "Send this to OpenClaw: refactor the auth module and write tests"

**How it works:**
- n8n-claw sends messages to OpenClaw's Gateway API (OpenAI-compatible)
- Conversations are persistent — OpenClaw remembers context across messages via session keys
- n8n-claw identifies itself with a configurable caller ID so OpenClaw knows who's talking

**Setup:**
1. Install the OpenClaw skill: *"Install openclaw"*
2. Enter your credentials via the secure form:
   - **Gateway URL** — `http://<your-openclaw-ip>:18789`. To find the port, run on the OpenClaw server:
     ```bash
     grep -A2 'gateway:' ~/openclaw/config.yaml | grep port
     ```
   - **API Token** — run on the OpenClaw server:
     ```bash
     grep -A2 'gateway:' ~/openclaw/config.yaml | grep api_key
     ```
   - **Caller ID** — a name that identifies your n8n-claw instance (e.g. "Greg (n8n-claw)")
3. Make sure OpenClaw's gateway is reachable from your n8n-claw server. Check the `bind` setting:
   ```bash
   grep -A2 'gateway:' ~/openclaw/config.yaml | grep bind
   ```
   If it says `"loopback"`, change it to `"lan"` and restart OpenClaw:
   ```bash
   nano ~/openclaw/config.yaml   # change bind: "loopback" → bind: "lan"
   ```
4. Start delegating tasks

This turns n8n-claw from a workflow-based agent into a bridge to a full autonomous coding agent — combining n8n-claw's strengths (memory, reminders, task management, Telegram interface, MCP skills) with OpenClaw's ability to execute arbitrary code and build software.

</details>

---

<details>
<summary>

## Building custom MCP Skills

</summary>

For APIs not covered by the skill catalog, ask your agent to build one from scratch:

> "Build me an MCP server for the OpenLibrary API — look up books by ISBN"

The MCP Builder will:
1. Search for API documentation automatically (via SearXNG + Crawl4AI)
2. Generate working tool code
3. Deploy two new n8n workflows (MCP trigger + sub-workflow)
4. Register the server in the database
5. Update the agent so it knows about the new tool

</details>

---

<details>
<summary>

## Memory

</summary>

The agent has a multi-layered memory system — it remembers things you tell it and learns from your conversations over time.

**Automatic memory:** The agent decides on its own what's worth remembering from your conversations (preferences, facts about you, decisions). No action needed.

**Manual memory:** You can also explicitly ask it to remember something:

> "Remember that I prefer morning meetings before 10am"
> "Remember that I take my coffee black"

**Memory search:** When relevant, the agent searches its memory to give you contextual answers. With an embedding API key (configured during setup), it uses semantic search — finding memories by meaning, not just keywords.

> "What do you know about my coffee preferences?"
> "What did we discuss about the server migration?"

**Memory update & delete:** The agent can correct or remove stored memories — no more contradictory entries piling up:

> "Actually, I prefer tea now" — updates the existing coffee preference instead of creating a duplicate
> "Forget that I like early meetings" — deletes the entry completely

**Memory Consolidation** runs automatically every night at 3am. It summarizes the day's conversations into concise long-term memories with vector embeddings. This keeps the memory efficient and searchable. Requires an embedding API key (OpenAI, Voyage AI, or Ollama — configured during setup).

</details>

---

<details>
<summary>

## Project Memory

</summary>

Track ongoing work across multiple conversations with persistent project documents. Each project is a markdown file the agent creates, reads, and updates on demand — like a living notebook for each topic you're working on.

**Creating a project:**
> "I'm working on a presentation about AI in tourism"
> "New project: server migration to Hetzner"

The agent creates a structured markdown document with goals, notes, and open items.

**Checking projects:**
> "What projects do I have?"
> "What's the status of the presentation?"

Active project names are shown to the agent automatically — it always knows what you're working on.

**Updating a project:**
> "Add to the presentation: slide 3 should show statistics"
> "Update the server migration: DNS is now configured"

The agent reads the current document, adds your notes, and saves the updated version.

**Archiving:**
> "The presentation is done"

Sets the project status to `completed` — it disappears from the active list but stays in the database.

</details>

---

<details>
<summary>

## Task Management

</summary>

The agent can manage tasks for you — just tell it what you need in natural language.

**Creating tasks:**
> "Remind me to call the dentist tomorrow"
> "Create a task: prepare presentation for Friday, high priority"
> "I need to buy groceries by Saturday"

**Checking tasks:**
> "What are my tasks?"
> "Show me overdue tasks"
> "Task summary"

**Updating tasks:**
> "Mark the dentist task as done"
> "Cancel the groceries task"
> "Change the presentation priority to urgent"

Tasks support priorities (`low`, `medium`, `high`, `urgent`), due dates, and subtasks.

</details>

---

<details>
<summary>

## Reminders & Scheduled Actions

</summary>

The agent supports three types of timed actions:

**Reminders** — sends a Telegram message at the specified time:

> "Remind me in 30 minutes to check the oven"
> "Remind me tomorrow at 9am about the doctor's appointment"
> "Set a reminder for Friday at 3pm: submit the report"

**Scheduled Actions** — the agent actively executes instructions at the specified time and sends the result:

> "Search Hacker News for AI articles at 9am and list them"
> "Check the weather forecast for Berlin tomorrow at 7am and send me a summary"

**Recurring Actions** — repeating scheduled actions on an interval, daily, or weekly schedule:

> "Check my emails every 15 minutes"
> "Give me a daily briefing every morning at 8am"
> "Every Monday and Friday at 9am, summarize the latest AI news"

Recurring actions are managed via natural language — list, pause, resume, or delete them:

> "Show my scheduled actions"
> "Pause the mail check"
> "Delete action 2"

One-time reminders can also be listed, edited, and deleted:

> "Show my reminders"
> "Move the workshop reminder to Monday at 10am"
> "Delete the car rental reminder"

Reminders and one-time scheduled actions are delivered by the **Reminder Runner** (polls every minute). Recurring actions are executed by the **Heartbeat** (runs every 5 minutes). Missed reminders are automatically delivered on the next run.

</details>

---

<details>
<summary>

## Media Support

</summary>

The agent understands more than just text — send voice messages, photos, documents, or locations directly in Telegram.

| Media type | What happens | Requires |
|---|---|---|
| **Voice messages** | Transcribed via OpenAI Whisper, then processed as text | OpenAI API Key |
| **Photos** | Analyzed via OpenAI Vision (GPT-4o-mini), description passed to agent. Original stored in File Bridge for later use. | OpenAI API Key |
| **Documents (PDF)** | Text extracted via n8n's built-in PDF parser, passed to agent. Original stored in File Bridge for later use. | — (built-in) |
| **Location** | Converted to coordinates text, agent responds with context | — (built-in) |

**Voice and photo analysis** require an OpenAI API key (configured during setup). Without it, voice messages and photos won't work — but documents and locations function without any extra API keys.

### File Storage (Binary Passthrough)

When you send a document or photo, the agent extracts text/description for the conversation **and** stores the original binary in the File Bridge service. This means the agent can later pass the file to MCP Skills — for example, uploading a receipt to Lexware or saving a photo to Nextcloud.

- Files are stored temporarily (24 hours) and automatically cleaned up
- The agent references stored files via `file_ref` IDs — the LLM never sees binary data
- Skills that support file uploads accept both `file_ref` (stored files) and `file_url` (external URLs)
- The agent can also send files back to the Telegram chat using the `[send_file: URL]` convention

> *[send a voice message]* — automatically transcribed and answered
> *[send a photo]* — "What do you see?" — analyzed by GPT-4o-mini Vision, original stored for tool use
> *[send a PDF]* — text extracted and analyzed, original stored for tool use
> *[share location]* — agent responds with location context

</details>

---

<details>
<summary>

## Heartbeat & Scheduled Actions

</summary>

The Heartbeat is a background workflow that runs every 5 minutes. It executes recurring scheduled actions and delivers proactive reminders.

### Recurring Actions

When you create a recurring action, the agent decides how it should notify you:

- **`always`** — always sends the result (e.g. morning briefings, reports). The main agent executes the task with full personality, conversation history, and all tools.
- **`on_change`** — only notifies when something new is found (e.g. email monitoring, price tracking). A lightweight **Background Checker** executes the task silently and only sends a Telegram message when there's actually something to report.

The agent picks the right mode automatically based on your request:

> "Give me a daily briefing at 8am" → `always` (you always want the briefing)
> "Check my emails every 15 minutes" → `on_change` (only notify on new emails)

### How it works

```
Heartbeat (every 5 min)
  → Load due actions from DB
  → For each action, check notify_mode:

    'always' (e.g. briefing):
      → Main Agent executes task → always sends Telegram

    'on_change' (e.g. mail check):
      → Background Checker executes task
      → Something new? → sends Telegram
      → Nothing new?   → stays silent
```

The Background Checker is a lightweight sub-workflow with Claude + tools (MCP skills, web search, HTTP requests, web reader) but without personality or conversation history — fast and cost-efficient.

### Proactive Reminders

The Heartbeat also checks for overdue or urgent tasks and sends you a short Telegram reminder — without you having to ask.

> "Enable the heartbeat" / "Disable proactive messages"

Rate-limited to one message every 2 hours (configurable) — no spam.

</details>

---

<details>
<summary>

## Customization

</summary>

Edit the `soul` and `agents` tables directly in Supabase Studio (`http://localhost:3001` via [SSH tunnel](#accessing-supabase-studio)) to change your agent's personality, tools, and behavior — no code changes needed.

| Table | Contents |
|---|---|
| `soul` | Agent personality (name, persona, vibe, boundaries) — loaded into system prompt |
| `agents` | Tool instructions, MCP config, memory behavior — loaded into system prompt |
| `user_profiles` | User name, timezone, preferences (language, morning briefing) |
| `tasks` | Task management (title, status, priority, due date, subtasks) |
| `projects` | Project documents (name, status, markdown content) |
| `reminders` | Scheduled reminders + one-time tasks (message, time, type, delivery status) |
| `scheduled_actions` | Recurring actions (schedule, instruction, notify_mode, next_run) |
| `heartbeat_config` | Heartbeat + morning briefing settings (enabled, last_run, intervals) |
| `tools_config` | API keys for Anthropic, embedding provider — used by Heartbeat + Consolidation |
| `mcp_registry` | Available MCP servers (name, URL, tools) |
| `template_credentials` | API keys for MCP templates (entered via credential form) |
| `credential_tokens` | One-time tokens for secure credential entry (10 min TTL) |
| `conversations` | Full chat history (session-based) |
| `memory_long` | Long-term memory with vector embeddings (semantic search) |
| `memory_daily` | Daily interaction log (used by Memory Consolidation) |

</details>

---

<details>
<summary>

## Alternative LLM Providers

</summary>

n8n-claw is built for Claude (Anthropic) but works with **any OpenAI-compatible LLM** — including llama.cpp, Ollama, LM Studio, vLLM, OpenRouter, or any provider that exposes an OpenAI-compatible API endpoint.

### How to switch

Replace the Anthropic LLM node in these workflows with an **OpenAI Chat Model** node:

| Workflow | Node to replace | Default model |
|---|---|---|
| n8n-claw Agent | "Claude" (LLM sub-node) | Claude Sonnet |
| MCP Builder | "Anthropic Chat Model" (2 nodes) | Claude Opus |
| Sub-Agent Runner | "Claude" (LLM sub-node) | Claude Sonnet |

**Steps:**

1. Open the workflow in n8n
2. Delete the existing Anthropic LLM node (the one connected to the AI Agent node)
3. Add an **OpenAI Chat Model** node and connect it in the same position
4. In the OpenAI node settings:
   - Set **Base URL** to your local endpoint (e.g. `http://localhost:8080/v1` for llama.cpp, `http://localhost:11434/v1` for Ollama)
   - Select your model
   - **Disable Responses API** (toggle off — important for local models)
5. Create an OpenAI credential with your endpoint URL and API key (use any string for local models that don't require auth)

### Known limitations

- **Heartbeat** and **Memory Consolidation** workflows currently use hardcoded Anthropic API calls in JavaScript code nodes. These won't work with alternative providers yet — deactivate them if you're running without an Anthropic key. Provider abstraction for these workflows is on the roadmap.
- **setup.sh** still requires an Anthropic API key during setup (the prompt doesn't accept empty input). Enter any placeholder value (e.g. `sk-dummy`) if you only use local models — the key is only used by Heartbeat and Memory Consolidation (which you should deactivate in that case).
- **MCP Builder** uses Claude Opus for code generation. Results may vary with smaller local models.
- Some local models may prefix tool call JSON with extra text (emojis, descriptions). This was fixed in [#13](https://github.com/freddy-schuetz/n8n-claw/issues/13) — make sure you're on the latest version.

### Community-tested providers

| Provider | Status | Notes |
|---|---|---|
| llama.cpp (qwen-coder-next) | Working | Reported by community ([Discussion #6](https://github.com/freddy-schuetz/n8n-claw/discussions/6)) — text + MCP weather confirmed |
| Ollama | Expected to work | OpenAI-compatible endpoint at `localhost:11434/v1` |

> Tested a different provider? Let us know in [Discussions](https://github.com/freddy-schuetz/n8n-claw/discussions)!

</details>

---

<details>
<summary>

## Switching from Telegram to WhatsApp

</summary>

n8n-claw uses Telegram by default, but you can switch to WhatsApp by replacing the Telegram nodes in the n8n UI. This requires changes in 3 workflows across 8 nodes — no code outside of n8n needed.

### Requirements

- A **Meta Business account** with WhatsApp Business API access — [Meta Business Suite](https://business.facebook.com/)
- A **verified business** on Meta (review can take 1–5 business days)
- A **phone number** registered with WhatsApp Business API (not your personal WhatsApp number)
- WhatsApp Business Cloud credentials configured in n8n — see [n8n WhatsApp credentials docs](https://docs.n8n.io/integrations/builtin/credentials/whatsapp/)

### Field mapping: Telegram → WhatsApp

The two platforms use different JSON structures. Here's how the fields map:

| Data | Telegram path | WhatsApp path |
|---|---|---|
| **Message text** | `$json.message.text` | `$json.messages[0].text.body` |
| **Sender ID** | `$json.message.from.id` | `$json.contacts[0].wa_id` |
| **Chat/Session ID** | `$json.message.chat.id` | `$json.contacts[0].wa_id` (phone number) |
| **Voice message** | `$json.message.voice.file_id` | WhatsApp audio media ID |
| **Photo** | `$json.message.photo.pop().file_id` | WhatsApp image media ID |
| **Document** | `$json.message.document.file_id` | WhatsApp document media ID |
| **Caption** | `$json.message.caption` | `$json.messages[0].image.caption` (or `.document.caption`) |
| **Location** | `$json.message.location.latitude/longitude` | `$json.messages[0].location.latitude/longitude` |
| **Send to** | `chatId` (numeric) | Recipient phone number (e.g. `49151...`) |
| **DB session prefix** | `telegram:{chatId}` | `whatsapp:{phoneNumber}` |
| **DB user prefix** | `telegram:{userId}` | `whatsapp:{phoneNumber}` |

### Nodes to replace

#### n8n-claw Agent (6 nodes)

| Current node | Purpose | Replace with |
|---|---|---|
| **Telegram Trigger** | Receives incoming messages | **WhatsApp Trigger** — update the "Route Media Type" switch conditions to match WhatsApp's message structure |
| **Telegram Reply** | Sends agent response | **WhatsApp → Send Message** — set recipient to sender's phone number instead of `chatId` |
| **Telegram Status** | Progress updates during long tasks (AI tool) | **WhatsApp → Send Message** (configured as [tool node](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolworkflow/)) |
| **Get Voice File** | Downloads voice messages for transcription | **HTTP Request** node calling WhatsApp's media download endpoint with the media ID |
| **Get Photo File** | Downloads photos for vision analysis | **HTTP Request** node calling WhatsApp's media download endpoint |
| **Get Doc File** | Downloads documents for text extraction | **HTTP Request** node calling WhatsApp's media download endpoint |

#### Heartbeat (1 node)

| Current node | Purpose | Replace with |
|---|---|---|
| **Send Telegram** | Sends proactive reminders + morning briefing | **WhatsApp → Send Message** — update `chatId` parameter to use phone number |

#### Reminder Runner (1 node)

| Current node | Purpose | Replace with |
|---|---|---|
| **Send Reminder** | Delivers timed reminders | **WhatsApp → Send Message** — the `chat_id` column in the `reminders` table must contain the phone number instead of Telegram chat ID |

### Code nodes to update

The **"Normalize Message"** code node in the main agent extracts message data from the Telegram Trigger output. Update these references:

```javascript
// BEFORE (Telegram)
const msg = $('Telegram Trigger').first().json.message;
const chatId = String(msg.chat.id);
const userId = String(msg.from.id);
const source = 'telegram';

// AFTER (WhatsApp)
const wa = $('WhatsApp Trigger').first().json;
const chatId = String(wa.contacts[0].wa_id);
const userId = String(wa.contacts[0].wa_id);
const source = 'whatsapp';
```

Also update the **"Format Location"** code node and any other nodes that reference `$('Telegram Trigger')`.

### Database changes

Update these values to use phone numbers instead of Telegram chat IDs:

| Table | Field | Change |
|---|---|---|
| `user_profiles` | `user_id` | `whatsapp:{phone}` instead of `telegram:{chatId}` |
| `conversations` | `session_id` | `whatsapp:{phone}` instead of `telegram:{chatId}` |
| `reminders` | `chat_id` | Phone number instead of Telegram chat ID |
| `heartbeat_config` | — | Update `{{TELEGRAM_CHAT_ID}}` in Heartbeat workflow to phone number |

### Message length limits

Telegram allows 4096 characters per message. The agent splits long messages at 4000 characters. WhatsApp allows up to 4096 characters for text messages as well, so the existing split logic works without changes.

### Media handling differences

WhatsApp media downloads work differently from Telegram. Instead of a built-in "Get File" node, you need to:

1. Get the media URL: `GET https://graph.facebook.com/v21.0/{media-id}` (with auth header)
2. Download the file from the returned URL

The existing voice transcription (Whisper) and photo analysis (GPT-4o Vision) nodes work the same once you have the file — only the download step changes.

> This is an advanced customization. If you run into issues, ask in [Discussions](https://github.com/freddy-schuetz/n8n-claw/discussions).

</details>

---

<details>
<summary>

## HTTPS Setup

</summary>

If you provided a domain during setup, HTTPS is configured automatically via Let's Encrypt + nginx. This is the default and works for most people. If not, you can add it later:

```bash
DOMAIN=n8n.yourdomain.com ./setup.sh
```

Point your domain's DNS A record to the VPS IP before running this.

### Already have a reverse proxy?

If you're running your own reverse proxy (Caddy, Traefik, nginx on another host, etc.), setup will ask whether to skip the built-in nginx + Let's Encrypt installation. Answer **yes** to skip — n8n will still be configured with the correct HTTPS webhook URLs, but TLS termination is left to your existing proxy.

You can also set this in `.env` before running setup:

```bash
SKIP_REVERSE_PROXY=true
```

Your reverse proxy should forward traffic to `localhost:5678` (n8n) with WebSocket support enabled.

> **Known issue:** When you enter a domain and skip nginx, setup sets `N8N_URL=https://your-domain` in `.env`. It then tries to reach the n8n API via that HTTPS URL — but if your reverse proxy isn't forwarding traffic to n8n yet, the "Waiting for n8n API..." step will fail and the script exits.
>
> **Workaround:**
> 1. Open `.env` and delete the `N8N_URL` line
> 2. Re-run `./setup.sh` — it will use `http://localhost:5678` instead and complete successfully
> 3. After setup is done, add `N8N_URL=https://your-domain` back to `.env`
> 4. Restart n8n: `docker compose up -d`
>
> Make sure your reverse proxy forwards HTTPS traffic to `localhost:5678` before using the agent.

> **Security note:** Without a domain, n8n runs over plain HTTP with no TLS and no rate limiting. This is fine for **local installs** (home server, LAN, testing). For a **public VPS**, always use a domain with HTTPS — otherwise credentials are transmitted unencrypted and the instance is exposed to the internet.

</details>

---

<details>
<summary>

## Updating

</summary>

**Normal update** — pulls code + Docker images, restarts services. Your personality, credentials, and data are preserved:

```bash
cd n8n-claw && ./setup.sh
```

**Full reconfigure** — re-runs the setup wizard (personality, language, timezone, proactive/reactive, embedding key). Your existing data and credentials are kept, but you can change all settings:

```bash
./setup.sh --force
```

Use `--force` when you want to change your agent's name, language, communication style, or switch between proactive/reactive mode.

</details>

---

<details>
<summary>

## Troubleshooting

</summary>

**Agent not responding to Telegram messages?**
→ Check all workflows are **activated** in n8n UI

**"Credential does not exist" error?**
→ Add the Postgres credential manually (see Step 2)

**MCP Builder fails?**
→ Make sure the LLM node in MCP Builder has Anthropic API selected

**Agent shows wrong time?**
→ Re-run `./setup.sh --force` and set the correct timezone, or update it directly in `user_profiles` table via Supabase Studio

**Heartbeat not sending messages?**
→ Check that `heartbeat_config` has `enabled = true` for `heartbeat` (proactive) or `morning_briefing`. You can enable it via chat: *"Enable the heartbeat"*

**Memory search returns nothing / vectorized: false?**
→ Check your embedding API key in the `tools_config` table (tool_name: `embedding`). Without a valid key, memory still works but falls back to keyword search.

**DB empty / Load Soul returns nothing?**
→ Re-run seed: `./setup.sh` (skips already-set config)

**MCP Skills fail with `ECONNREFUSED 127.0.1.1:443`?**
→ Many cloud providers (Hostinger, etc.) map the server hostname to `127.0.1.1` in `/etc/hosts`. When n8n tries to call its own webhook URL, it resolves to that address instead of the real IP. Fix:
```bash
# Find your real IP
curl -4 ifconfig.me

# Fix /etc/hosts — replace 127.0.1.1 with your real IP
sed -i 's/^127\.0\.1\.1\(.*\)/YOUR_REAL_IP\1/' /etc/hosts

# If your server uses cloud-init, also fix the template for persistence across reboots:
sed -i 's/^127\.0\.1\.1\(.*\)/YOUR_REAL_IP\1/' /etc/cloud/templates/hosts.debian.tmpl

# Restart n8n
docker restart n8n-claw
```

**Logs:**
```bash
docker logs n8n-claw        # n8n
docker logs n8n-claw-db     # PostgreSQL
docker logs n8n-claw-rest   # PostgREST
```

</details>

---

<details>
<summary>

## Optional: WorkflowBuilder with Claude Code

</summary>

The WorkflowBuilder tool lets your agent build complex n8n workflows using Claude Code CLI. Since n8n runs inside Docker, the Claude Code node connects to the **host machine** via SSH where the CLI is installed.

### 1. Install the community node

In n8n UI → Settings → Community Nodes → Install:
```
n8n-nodes-claude-code-cli
```

### 2. Install Claude Code on your VPS host

> **Important:** Install this on the VPS itself (the host machine), **not** inside the Docker container.

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Set your Anthropic API key in the host's shell environment (e.g. `/root/.bashrc`):

```bash
echo 'export ANTHROPIC_API_KEY=your_key_here' >> ~/.bashrc
source ~/.bashrc
```

### 3. Generate an SSH key pair

The Claude Code node runs inside Docker and connects to the host via SSH. Most VPS providers disable password authentication by default, so key-based auth is recommended.

```bash
# Generate a dedicated key pair (no passphrase)
ssh-keygen -t ed25519 -f ~/.ssh/n8n-claude-code -C "n8n-claude-code" -N ""

# Authorize it
cat ~/.ssh/n8n-claude-code.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### 4. Create the SSH credential in n8n

1. In n8n UI → **Credentials** → **Add Credential**
2. Search for **Claude Code SSH** (comes with the community node)
3. Configure:
   - **Host:** `172.17.0.1` (this is how Docker containers reach the host machine)
   - **Port:** `22`
   - **Username:** `root` (or whichever user has Claude Code installed)
   - **Authentication:** SSH Private Key
   - **Private Key:** paste the contents of `~/.ssh/n8n-claude-code`
4. Save with the name **`Claude Code Runner SSH`** (must match exactly)

### 5. Activate the workflow

1. Open the **WorkflowBuilder** workflow in n8n
2. Click **Activate** (toggle in the top right)

> Without this setup, the WorkflowBuilder tool won't function — but all other agent capabilities work fine without it.

</details>

---

## Stack

- **[n8n](https://n8n.io)** — workflow automation engine
- **PostgreSQL** — database
- **[PostgREST](https://postgrest.org)** — auto-generated REST API
- **[Supabase Studio](https://supabase.com)** — database admin UI
- **[Kong](https://konghq.com)** — API gateway
- **[Claude](https://anthropic.com)** (Anthropic) — LLM powering the agent
- **Telegram** — messaging interface
- **[SearXNG](https://docs.searxng.org)** — self-hosted meta search engine (no API key needed)
- **[Crawl4AI](https://github.com/unclecode/crawl4ai)** — self-hosted web crawler, returns clean markdown (JS rendering)
- **Email Bridge** — lightweight IMAP/SMTP REST API for email integration
- **File Bridge** — temporary file storage for binary passthrough between agent tools
- **[Open-Meteo](https://open-meteo.com)** — free weather API (example MCP, no key needed)

---

## License

MIT