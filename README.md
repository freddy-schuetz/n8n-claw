# 🤖 n8n Greg — Self-Hosted AI Agent

A fully self-hosted AI agent built on n8n + Supabase + Claude. Talks to you via Telegram, builds its own MCP tools, manages calendar, reminders, and memory — all running on your own infrastructure.

## What it does

- **Telegram chat** — talk to your AI agent directly via Telegram
- **Long-term memory** — remembers conversations and important information in Supabase
- **MCP Server Builder** — builds new API integrations on demand (just ask!)
- **Calendar integration** — reads/creates events in Nextcloud/Google Calendar
- **Smart reminders** — timed reminders via Telegram
- **Extensible** — add new tools and capabilities through natural language

## Architecture

```
Telegram ──→ n8n Greg AI Agent (Claude Sonnet)
                ├── Memory (Supabase)
                ├── MCP Client → MCP Servers (n8n workflows)
                ├── MCP Builder → creates new MCP Servers automatically
                ├── Calendar (CalDAV)
                └── Reminder Factory
```

## Prerequisites

- **n8n** (self-hosted, v1.0+)
- **Supabase** (self-hosted via Docker or cloud)
- **Telegram Bot** (from @BotFather)
- **Anthropic API Key** (Claude Sonnet recommended)
- Optional: Nextcloud for CalDAV

## Quick Start

### 1. Clone & configure

```bash
git clone https://github.com/YOUR_USERNAME/n8n-greg.git
cd n8n-greg
cp .env.example .env
# Edit .env with your values
```

### 2. Run setup

```bash
chmod +x setup.sh
./setup.sh
```

This will:
- Apply Supabase schema & seed data
- Import all workflows into n8n (with your credentials injected)

### 3. Configure n8n credentials

In n8n UI, add these credentials:
- **Anthropic API** — name it exactly `Anthropic API`
- **Telegram Bot** — name it exactly `Telegram Bot`, use your bot token

### 4. Activate

1. Open n8n UI
2. Find `🤖 Greg AI Agent`
3. Click **Activate**
4. Send `/start` to your Telegram bot

## Workflows

| Workflow | Purpose |
|---|---|
| `🤖 Greg AI Agent` | Main agent — receives Telegram messages, thinks, responds |
| `🏗️ MCP Builder` | Builds new MCP Server workflows on demand |
| `🔌 MCP Client` | Calls tools on MCP Servers (sub-workflow) |
| `📅 CalDAV Sub-Workflow` | Reads/creates calendar events |
| `⏰ ReminderFactory` | Creates timed Telegram reminders |
| `WorkflowBuilder` | Builds general n8n automations (Claude Code) |
| `MCP: Wetter` | Example MCP Server — weather via Open-Meteo |

## Supabase Schema

| Table | Purpose |
|---|---|
| `soul` | Agent personality & core behavior |
| `agents` | Tool instructions, MCP config |
| `user_profiles` | User info (name, timezone, context) |
| `conversations` | Chat history (last 20 msgs used as context) |
| `memory_long` | Long-term memory with semantic search |
| `memory_daily` | Daily interaction log |
| `mcp_registry` | Available MCP servers |

## Building new MCP tools

Just ask your agent:
> "Bau mir einen MCP Server für die GitHub API — suche Repositories per Keyword"

The MCP Builder will:
1. Search for API documentation automatically
2. Generate the tool code
3. Deploy a working n8n workflow
4. Register it so the agent can use it immediately

## Customization

Edit `soul` and `agents` rows in Supabase to change your agent's personality, tools, and behavior — no code changes needed.

## Stack

- **n8n** — workflow automation engine
- **Supabase** — PostgreSQL + REST API (memory, config)
- **Claude** (Anthropic) — LLM powering the agent
- **Telegram** — messaging interface
- **Open-Meteo** — free weather API (example MCP)

## License

MIT
