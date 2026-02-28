# 🤖 n8n-claw — Self-Hosted AI Agent

A fully self-hosted AI agent built on n8n + PostgreSQL + Claude. Talks to you via Telegram, builds its own MCP tools, manages calendar, reminders, and memory — all running on your own infrastructure.

## What it does

- **Telegram chat** — talk to your AI agent directly via Telegram
- **Long-term memory** — remembers conversations and important information
- **MCP Server Builder** — builds new API integrations on demand (just ask!)
- **Calendar integration** — reads/creates events via CalDAV (Nextcloud, etc.)
- **Smart reminders** — timed reminders via Telegram
- **Extensible** — add new tools and capabilities through natural language

## Architecture

```
Telegram ──→ n8n-claw Agent (Claude Sonnet)
                ├── Memory (PostgreSQL via PostgREST)
                ├── MCP Client → MCP Servers (n8n workflows)
                ├── MCP Builder → creates new MCP Servers automatically
                ├── Calendar (CalDAV)
                └── Reminder Factory
```

## Quick Start

**Requirements:** A Linux VPS (Ubuntu/Debian recommended), root access, open ports 5678 + 8000.

```bash
git clone https://github.com/freddy-schuetz/n8n-claw.git
cd n8n-claw
./setup.sh
```

That's it. The setup script will:
1. Install Docker automatically (if not present)
2. Start n8n so you can create an API key
3. Ask you for your API keys interactively
4. Start all services (n8n, PostgreSQL, PostgREST, Kong)
5. Apply the database schema
6. Create n8n credentials automatically
7. Import and wire all workflows
8. Activate the Setup Wizard

**You'll need:**
- Anthropic API key → [console.anthropic.com](https://console.anthropic.com)
- Telegram Bot token → create via [@BotFather](https://t.me/BotFather)
- Telegram Chat ID → get via [@userinfobot](https://t.me/userinfobot)

## After Setup

1. Open n8n at `http://YOUR-VPS-IP:5678`
2. Activate these workflows manually:
   - `🤖 n8n-claw Agent`
   - `🏗️ MCP Builder`
3. Send `/start` to your Telegram bot → **Setup Wizard** guides you through personalization
4. Start chatting!

## Workflows

| Workflow | Purpose |
|---|---|
| `🤖 n8n-claw Agent` | Main agent — receives Telegram messages, thinks, responds |
| `🚀 Setup Wizard` | First-run onboarding: name, language, context |
| `🏗️ MCP Builder` | Builds new MCP Server workflows on demand |
| `🔌 MCP Client` | Calls tools on MCP Servers (sub-workflow) |
| `📅 CalDAV Sub-Workflow` | Reads/creates calendar events |
| `⏰ ReminderFactory` | Creates timed Telegram reminders |
| `WorkflowBuilder` | Builds general n8n automations |
| `MCP: Wetter` | Example MCP Server — weather via Open-Meteo (no API key needed) |

## Database Schema

| Table | Purpose |
|---|---|
| `soul` | Agent personality & core behavior (editable!) |
| `agents` | Tool instructions, MCP config |
| `user_profiles` | User info (name, timezone, context) |
| `conversations` | Chat history (last 20 msgs used as context) |
| `memory_long` | Long-term memory with semantic search |
| `memory_daily` | Daily interaction log |
| `mcp_registry` | Available MCP servers |

## Building new MCP tools

Just ask your agent:
> "Build me an MCP server for the GitHub API that searches repositories"

The MCP Builder will:
1. Search for API documentation automatically (via Brave Search + Jina Reader)
2. Generate working tool code
3. Deploy a new n8n workflow
4. Register it so the agent can use it immediately

## Customization

Edit the `soul` and `agents` rows directly in the database to change your agent's personality, tools, and behavior — no code changes needed.

## Stack

- **n8n** — workflow automation engine
- **PostgreSQL + PostgREST** — database + REST API (memory, config)
- **Kong** — API gateway
- **Claude** (Anthropic) — LLM powering the agent
- **Telegram** — messaging interface
- **Open-Meteo** — free weather API (example MCP, no key needed)

## License

MIT
