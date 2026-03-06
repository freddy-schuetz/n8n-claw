# 🤖 n8n-claw — Self-Hosted AI Agent

A fully self-hosted AI agent built on n8n + PostgreSQL + Claude. Talks to you via Telegram, builds its own MCP tools, manages reminders and memory — all running on your own infrastructure.

## What it does

Talk to your agent in natural language — it manages tasks, remembers context across conversations, builds API integrations, and proactively keeps you on track.

- **Telegram chat** — talk to your AI agent directly via Telegram
- **Long-term memory** — remembers conversations and important context with optional semantic search (RAG)
- **Task management** — create, track, and complete tasks with priorities and due dates
- **Proactive heartbeat** — automatically reminds you of overdue/urgent tasks
- **Morning briefing** — daily summary of your tasks at a time you choose
- **MCP Server Builder** — builds new API integrations on demand (just ask: *"build me an MCP server for the GitHub API"*)
- **Smart reminders** — timed Telegram reminders ("remind me in 2 hours to...")
- **Extensible** — add new tools and capabilities through natural language

## Architecture

```
Telegram
  ↓
n8n-claw Agent (Claude Sonnet)
  ├── Task Manager        — create, track, complete tasks
  ├── Memory Save/Search  — long-term memory with vector search
  ├── MCP Client          → calls tools on MCP Servers
  ├── MCP Builder          → creates new MCP Servers automatically
  ├── Reminder Factory    — timed Telegram reminders
  ├── HTTP Tool           — simple web requests
  └── Self Modify         — inspect/list n8n workflows

Background Workflows (automated):
  💓 Heartbeat              — every 15 min: proactive reminders + morning briefing
  🧠 Memory Consolidation   — daily at 3am: summarizes conversations → long-term memory
```

---

## Installation

### What you need

- A Linux VPS (Ubuntu 22.04/24.04 recommended, 2GB RAM minimum)
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
   - Domain name *(optional — enables HTTPS via Let's Encrypt + nginx)*
5. **Configure your agent's personality**:
   - Agent name
   - Your name
   - Preferred language
   - Timezone *(auto-detected from system)*
   - Communication style (casual / professional / friendly)
   - Proactive vs reactive behavior
   - Free-text custom persona *(overrides the above)*
6. **Start all services** (n8n, PostgreSQL, PostgREST, Kong)
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
| Postgres | `Supabase Postgres` | Agent (Load Soul, Load History, etc.) |
| Anthropic API | `Anthropic API` | Agent (Claude node), MCP Builder |
| Telegram Bot | `Telegram Bot` | Agent (Telegram Trigger + Reply) — *created automatically by setup* |
| OpenAI API | `OpenAI API` | Agent (Voice transcription via Whisper) — *optional, created by setup if key provided* |

**Postgres connection details** *(shown in setup output)*:
- Host: `db` | Port: `5432` | DB: `postgres` | User: `postgres`
- Password: *(shown at end of setup)*
- SSL: `disable`

**MCP Builder — select LLM model:**
- Open the MCP Builder workflow → click the LLM node
- Select `Anthropic API` as the chat model
- *(not set automatically due to n8n credential linking)*

**MCP Builder — Brave Search API Key:**
- The MCP Builder uses Brave Search to look up API documentation automatically
- Open the **MCP Builder** workflow → click the **"Search API Docs"** node
- Under *Headers*, set `X-Subscription-Token` to your Brave Search API key
- Get a free key at [brave.com/search/api](https://brave.com/search/api/) (free tier: 2,000 queries/month)
- Without this key, the MCP Builder cannot find API docs automatically — you'd need to paste docs manually into the prompt

**Optional: Embeddings for semantic memory search:**

During setup, you'll be asked for an embedding API key. This enables vector-based memory search (RAG) — the agent can find memories by meaning, not just exact keywords.

- **OpenAI** (default): `text-embedding-3-small` — [platform.openai.com](https://platform.openai.com) (requires API key)
- **Voyage AI**: `voyage-3-lite` — [voyageai.com](https://www.voyageai.com) (free tier available)
- **Ollama**: `nomic-embed-text` — local, no API key needed (requires Ollama running on your server)

Without an embedding key, the agent still works — it falls back to keyword-based memory search.

**Optional: OpenAI API Key for voice messages:**

During setup, you'll be asked for an OpenAI API key. This enables voice message transcription via Whisper. Without it, the agent cannot process voice messages — but photos, documents, and locations work without it.

### Step 3 — Activate remaining workflows

These workflows are **activated automatically** by setup — no action needed:

| Workflow | Purpose |
|---|---|
| 🤖 n8n-claw Agent | Main agent — receives Telegram messages, calls tools |
| 💓 Heartbeat | Background: proactive reminders + morning briefing (every 15 min) |
| 🧠 Memory Consolidation | Background: summarizes conversations into long-term memory (daily 3am) |

These workflows need to be **activated manually** in n8n UI:

| Workflow | Purpose |
|---|---|
| 🏗️ MCP Builder | Builds new MCP Server workflows on demand |
| ⏰ ReminderFactory | Creates timed Telegram reminders (sub-workflow) |
| 🌤️ MCP: Weather | Example MCP Server — weather via Open-Meteo (no API key) |
| ⚙️ WorkflowBuilder | Builds general n8n automations *(optional — requires [extra setup](#optional-workflowbuilder-with-claude-code))* |

Sub-workflows (called by other workflows, no manual activation needed):

| Workflow | Called by |
|---|---|
| 🔌 MCP Client | Agent — calls tools on MCP Servers |

### Step 4 — Start chatting

Send a message to your Telegram bot. It's ready!

---

## Services & URLs

After setup, these services run:

| Service | URL | Purpose |
|---|---|---|
| n8n | `http://YOUR-IP:5678` | Workflow editor |
| Supabase Studio | `http://localhost:3001` (via SSH tunnel) | Database admin UI |
| PostgREST API | `http://YOUR-IP:8000` | REST API for PostgreSQL |

### Accessing Supabase Studio

Supabase Studio is bound to `localhost` only (not publicly exposed). To access it from your browser, open an SSH tunnel:

```bash
ssh -L 3001:localhost:3001 user@YOUR-VPS-IP
```

Then open `http://localhost:3001` in your browser. The tunnel stays open as long as the SSH session runs.

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

## Memory

The agent has a multi-layered memory system — it remembers things you tell it and learns from your conversations over time.

**Automatic memory:** The agent decides on its own what's worth remembering from your conversations (preferences, facts about you, decisions). No action needed.

**Manual memory:** You can also explicitly ask it to remember something:

> "Remember that I prefer morning meetings before 10am"
> "Remember that I take my coffee black"

**Memory search:** When relevant, the agent searches its memory to give you contextual answers. With an embedding API key (configured during setup), it uses semantic search — finding memories by meaning, not just keywords.

> "What do you know about my coffee preferences?"
> "What did we discuss about the server migration?"

**Memory Consolidation** runs automatically every night at 3am. It summarizes the day's conversations into concise long-term memories with vector embeddings. This keeps the memory efficient and searchable. Requires an embedding API key (OpenAI, Voyage AI, or Ollama — configured during setup).

---

## Task Management

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

---

## Reminders

The agent can set timed reminders that arrive as Telegram messages at the specified time.

> "Remind me in 30 minutes to check the oven"
> "Remind me tomorrow at 9am about the doctor's appointment"
> "Set a reminder for Friday at 3pm: submit the report"

Each reminder creates a temporary n8n workflow that fires once at the scheduled time, sends the Telegram message, and deletes itself.

---

## Media Support

The agent understands more than just text — send voice messages, photos, documents, or locations directly in Telegram.

| Media type | What happens | Requires |
|---|---|---|
| **Voice messages** | Transcribed via OpenAI Whisper, then processed as text | OpenAI API Key |
| **Photos** | Sent directly to Claude Vision for analysis | — (built-in) |
| **Documents (PDF)** | Sent directly to Claude for reading and analysis | — (built-in) |
| **Location** | Converted to coordinates text, agent responds with context | — (built-in) |

**Voice transcription** requires an OpenAI API key (configured during setup). Without it, voice messages won't work — but all other media types function without any extra API keys.

**Photos and documents** are passed directly to Claude as multimodal content — no intermediate processing needed. Send a photo and ask "what's in this image?", or send a PDF and ask for a summary.

> "What do you see in this photo?"
> *[send a voice message]* — automatically transcribed and answered
> *[send a PDF]* — "Please summarize this document"
> *[share location]* — agent responds with location context

---

## Heartbeat & Morning Briefing

The Heartbeat is a background workflow that runs every 15 minutes. It checks for overdue or urgent tasks and sends you a short Telegram reminder — without you having to ask.

**Proactive reminders** are enabled automatically if you chose "Proactive" during setup. You can also toggle them via chat:

> "Enable the heartbeat" / "Disable proactive messages"

Rate-limited to one message every 2 hours (configurable) — no spam.

**Morning Briefing** sends you a daily summary at your chosen time:

> "Enable morning briefing at 8am"
> "Set morning briefing to 7:30"
> "Disable morning briefing"

The briefing includes: overdue tasks, today's tasks, and a short motivating note — in your preferred language.

---

## Customization

Edit the `soul` and `agents` tables directly in Supabase Studio (`http://localhost:3001` via [SSH tunnel](#accessing-supabase-studio)) to change your agent's personality, tools, and behavior — no code changes needed.

| Table | Contents |
|---|---|
| `soul` | Agent personality (name, persona, vibe, boundaries) — loaded into system prompt |
| `agents` | Tool instructions, MCP config, memory behavior — loaded into system prompt |
| `user_profiles` | User name, timezone, preferences (language, morning briefing) |
| `tasks` | Task management (title, status, priority, due date, subtasks) |
| `heartbeat_config` | Heartbeat + morning briefing settings (enabled, last_run, intervals) |
| `tools_config` | API keys for Anthropic, embedding provider — used by Heartbeat + Consolidation |
| `mcp_registry` | Available MCP servers (name, URL, tools) |
| `conversations` | Full chat history (session-based) |
| `memory_long` | Long-term memory with vector embeddings (semantic search) |
| `memory_daily` | Daily interaction log (used by Memory Consolidation) |

---

## HTTPS Setup

If you provided a domain during setup, HTTPS is configured automatically via Let's Encrypt. If not, you can add it later:

```bash
DOMAIN=n8n.yourdomain.com ./setup.sh
```

Point your domain's DNS A record to the VPS IP before running this.

> ⚠️ **Security note:** Without a domain, n8n runs over plain HTTP with no TLS and no rate limiting. This is fine for **local installs** (home server, LAN, testing). For a **public VPS**, always use a domain with HTTPS — otherwise credentials are transmitted unencrypted and the instance is exposed to the internet.

---

## Updating

**Normal update** — pulls code + Docker images, restarts services. Your personality, credentials, and data are preserved:

```bash
cd n8n-claw && ./setup.sh
```

**Full reconfigure** — re-runs the setup wizard (personality, language, timezone, proactive/reactive, embedding key). Your existing data and credentials are kept, but you can change all settings:

```bash
./setup.sh --force
```

Use `--force` when you want to change your agent's name, language, communication style, or switch between proactive/reactive mode.

---

## Troubleshooting

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
n8n-nodes-claude-code-cli
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
