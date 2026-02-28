# 🤖 n8n-claw — Self-Hosted AI Agent

A fully self-hosted AI agent built on n8n + PostgreSQL + Claude. Talks to you via Telegram, builds its own MCP tools, manages reminders and memory — all running on your own infrastructure.

## What it does

- **Telegram chat** — talk to your AI agent directly via Telegram
- **Long-term memory** — remembers conversations and important context in PostgreSQL
- **MCP Server Builder** — builds new API integrations on demand (just ask: *"build me an MCP server for the GitHub API"*)
- **Smart reminders** — timed Telegram reminders
- **Extensible** — add new tools and capabilities through natural language

## Architecture

```
Telegram
  ↓
n8n-claw Agent (Claude Sonnet)
  ├── Memory (PostgreSQL via PostgREST)
  ├── MCP Client → MCP Servers (n8n workflows)
  ├── MCP Builder → creates new MCP Servers automatically
  └── Reminder Factory
```

---

## Installation

### What you need

- A Linux VPS (Ubuntu 22.04/24.04 recommended, 2GB RAM minimum)
- A **Telegram Bot** — create one via [@BotFather](https://t.me/BotFather)
- Your **Telegram Chat ID** — get it from [@userinfobot](https://t.me/userinfobot)
- An **Anthropic API Key** — from [console.anthropic.com](https://console.anthropic.com)
- A **domain name** (optional but recommended, required for Telegram HTTPS webhooks)

### Step 1 — Clone the repo

```bash
git clone https://github.com/freddy-schuetz/n8n-claw.git
cd n8n-claw
```

### Step 2 — Run the setup script

```bash
./setup.sh
```

The script will:

1. **Update the system** (`apt update && apt upgrade`)
2. **Install Docker** automatically if not present
3. **Start n8n** so you can generate an API key
4. **Ask you for configuration** interactively:
   - n8n API Key *(generated in n8n UI → Settings → API)*
   - Telegram Bot Token
   - Telegram Chat ID
   - Domain name *(optional — enables HTTPS via Let's Encrypt + nginx)*
5. **Configure your agent's personality**:
   - Agent name
   - Your name
   - Preferred language
   - Communication style (casual / professional / friendly)
   - Proactive vs reactive behavior
   - Free-text custom persona *(overrides the above)*
6. **Start all services** (n8n, PostgreSQL, PostgREST, Kong)
7. **Apply database schema** and seed data
8. **Create n8n credentials** (Telegram Bot automatically)
9. **Import all workflows** into n8n
10. **Wire workflow references** (MCP Builder, Reminders, etc.)
11. **Activate the agent** automatically

### Step 3 — Add credentials in n8n UI

Open n8n at the URL shown at the end of setup.

The easiest way is to open each workflow and click **"Create new credential"** directly on the node that needs it. n8n will prompt you automatically.

**Credentials you'll need:**

| Credential | Name (exact!) | Where needed |
|---|---|---|
| Postgres | `Supabase Postgres` | Agent (Load Soul, Load History, etc.) |
| Anthropic API | `Anthropic API` | Agent (Claude node), MCP Builder |
| Telegram Bot | `Telegram Bot` | Agent (Telegram Trigger + Reply) |

**Postgres connection details** *(shown in setup output)*:
- Host: `db` | Port: `5432` | DB: `postgres` | User: `postgres`
- Password: *(shown at end of setup)*
- SSL: `disable`

**MCP Builder — select LLM model:**
- Open the MCP Builder workflow → click the LLM node
- Select `Anthropic API` as the chat model
- *(not set automatically due to n8n credential linking)*

### Step 4 — Activate all workflows

In n8n UI, toggle **all** of these on:

| Workflow | Purpose |
|---|---|
| 🤖 n8n-claw Agent | Main agent — receives and responds to Telegram messages |
| 🏗️ MCP Builder | Builds new MCP Server workflows on demand |
| 🔌 MCP Client | Calls tools on MCP Servers (sub-workflow) |
| ⏰ ReminderFactory | Creates timed Telegram reminders |
| 🌤️ MCP: Weather | Example MCP Server — weather via Open-Meteo (no API key) |
| ⚙️ WorkflowBuilder | Builds general n8n automations |

### Step 5 — Start chatting

Send a message to your Telegram bot. It's ready!

---

## Services & URLs

After setup, these services run:

| Service | URL | Purpose |
|---|---|---|
| n8n | `http://YOUR-IP:5678` | Workflow editor |
| Supabase Studio | `http://YOUR-IP:3001` | Database admin UI |
| PostgREST API | `http://YOUR-IP:8000` | REST API for PostgreSQL |

---

## Building new MCP tools

Just ask your agent:
> "Build me an MCP server for the OpenLibrary API — look up books by ISBN"

The MCP Builder will:
1. Search for API documentation automatically (via Brave Search + Jina Reader)
2. Generate working tool code
3. Deploy two new n8n workflows (MCP trigger + sub-workflow)
4. Register the server in the database
5. Update the agent so it knows about the new tool

> ⚠️ After each MCP build: **deactivate → reactivate** the new MCP workflow in n8n UI (required due to a webhook registration bug in n8n).

---

## Customization

Edit the `soul` and `agents` tables directly in Supabase Studio (`http://YOUR-IP:3001`) to change your agent's personality, tools, and behavior — no code changes needed.

| Table | Contents |
|---|---|
| `soul` | Agent personality (name, persona, vibe, language, boundaries) |
| `agents` | Tool instructions, MCP config, user context |
| `user_profiles` | User name, timezone, context |
| `mcp_registry` | Available MCP servers |
| `conversations` | Chat history |
| `memory_long` | Long-term memory with semantic search |

---

## HTTPS Setup

If you provided a domain during setup, HTTPS is configured automatically via Let's Encrypt. If not, you can add it later:

```bash
DOMAIN=n8n.yourdomain.com ./setup.sh
```

Point your domain's DNS A record to the VPS IP before running this.

---

## Troubleshooting

**Agent not responding to Telegram messages?**
→ Check all workflows are **activated** in n8n UI

**"Credential does not exist" error?**
→ Add the Postgres credential manually (see Step 3)

**MCP Builder fails?**
→ Make sure the LLM node in MCP Builder has Anthropic API selected

**DB empty / Load Soul returns nothing?**
→ Re-run seed: `./setup.sh` (skips already-set config)

**Logs:**
```bash
docker logs n8n-claw        # n8n
docker logs n8n-claw-db     # PostgreSQL
docker logs n8n-claw-rest   # PostgREST
```

---

## Optional: WorkflowBuilder with Claude Code

The WorkflowBuilder tool lets your agent build complex n8n workflows using Claude Code CLI. This requires additional setup:

### 1. Install the community node

In n8n UI → Settings → Community Nodes → Install:
```
n8n-nodes-claude-code
```

### 2. Install Claude Code on your VPS

```bash
# Install Node.js if needed
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install Claude Code CLI globally
npm install -g @anthropic-ai/claude-code

# Verify
claude --version
```

### 3. Configure in n8n

- Open the WorkflowBuilder workflow
- The Claude Code node needs access to the CLI
- Set `ANTHROPIC_API_KEY` environment variable in your n8n container:

```yaml
# Add to docker-compose.yml under n8n environment:
- ANTHROPIC_API_KEY=your_key_here
```

Then restart: `docker compose up -d n8n`

> Without this setup, the WorkflowBuilder tool won't function — but all other agent capabilities work fine without it.

---

## Stack

- **[n8n](https://n8n.io)** — workflow automation engine
- **PostgreSQL** — database
- **[PostgREST](https://postgrest.org)** — auto-generated REST API
- **[Kong](https://konghq.com)** — API gateway
- **[Claude](https://anthropic.com)** (Anthropic) — LLM powering the agent
- **Telegram** — messaging interface
- **[Open-Meteo](https://open-meteo.com)** — free weather API (example MCP, no key needed)

---

## License

MIT
