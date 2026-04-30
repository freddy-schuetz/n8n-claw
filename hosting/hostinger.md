# n8n-claw — Review Pack for Hostinger Docker Catalog

Prepared 2026-04-21 in response to Kodee's 6-point request for internal routing to the Docker-catalog team. Every claim below is validated against the current repo state at the time of writing.

---

## 1. Public source repository

- **GitHub:** https://github.com/freddy-schuetz/n8n-claw
- **License:** MIT
- **Core files reviewers will want first:**
  - `docker-compose.yml`: full service graph (11 services, one bridge network, three named volumes)
  - `setup.sh`: current installer
  - `.env.example`: canonical env reference with comments
  - `README.md`: end-user install and operation guide
  - `CLAUDE.md`: architecture reference (conventions, placeholders, DB schema)

The stack has no proprietary images. All images are either public on Docker Hub or built locally from `./email-bridge`, `./file-bridge`, `./discord-bridge` (plain Node.js, Dockerfile in each subdir).

---

## 2. Install path and environment variables

### Current state (honest)

The installer is `bash setup.sh`, run on a fresh Ubuntu VPS (tested on 22.04 and 24.04). It is **interactive**: it prompts for the handful of values that cannot be auto-generated, then writes `.env`, starts the stack, applies the DB schema, and imports/activates the n8n workflows.

- A small `ask()` wrapper (`setup.sh:104-125`) is already `.env`-aware: if a variable is already set and not a `your_*` placeholder, the prompt is skipped. This means operators can pre-populate `.env` and the installer will not ask those questions again.
- `ask()` is currently used for the four core values (`N8N_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DOMAIN`). Most other prompts (LLM provider selection, Discord opt-in, Paperclip opt-in, embedding provider, persona style) still use raw `read -rp` and do not yet consult `.env`.
- Happy to add a `--unattended` flag that reads everything from `.env` (or a manifest file) and fails fast on missing required values. Rough budget: half a dev-day plus a fresh-VPS test pass. Happy to build this to the exact spec Hostinger's deploy flow expects (e.g. env-only compose, init-container, hPanel variable schema). See Section 6.

### Required values (operator must provide)

| Variable | Source |
|---|---|
| `N8N_API_KEY` | Generated in the n8n UI after first boot (Settings, API). The installer starts n8n early specifically so the user can create this key. |
| `TELEGRAM_BOT_TOKEN` | From `@BotFather` |
| `TELEGRAM_CHAT_ID` | From `@userinfobot` |
| `LLM_PROVIDER` + `LLM_API_KEY` | One of: `anthropic`, `openai`, `openrouter`, `deepseek`, `gemini`, `mistral`, `ollama`, `openai_compatible` |
| `DOMAIN` (optional) | Required only for Telegram webhook mode / HTTPS |

### Auto-generated at first run (never user-supplied)

Generated via `openssl rand` and persisted to `.env` (`setup.sh:145-167`):

- `N8N_ENCRYPTION_KEY` (hex, 16 bytes)
- `POSTGRES_PASSWORD` (20 alphanumeric chars)
- `SUPABASE_JWT_SECRET` (base64, 32 bytes)
- `WEBHOOK_SECRET` (hex, 32 bytes)
- `SEARXNG_SECRET` (hex, 32 bytes, patched into `searxng/settings.yml`)

Two further keys are derived from `SUPABASE_JWT_SECRET` via HMAC-SHA256 in a short inline Python block (`setup.sh:417-435`) and also persisted to `.env`:

- `SUPABASE_ANON_KEY` (JWT, role=`anon`)
- `SUPABASE_SERVICE_KEY` (JWT, role=`service_role`)

On `./setup.sh --force` (re-run / provider switch), existing secrets are preserved. Nothing is re-generated unless absent.

---

## 3. Ports, services, and routing

Single user-defined bridge network `n8n-claw-net`. Only **one port** is exposed to the public interface by default.

| Service | Image / build | Host exposure | Purpose |
|---|---|---|---|
| `n8n` | `n8nio/n8n:latest` | `0.0.0.0:5678` | Agent UI + webhooks (only public port) |
| `db` | `supabase/postgres:17.6.1.063` | `127.0.0.1:5432` | PostgreSQL 17 with `uuid-ossp` + `vector` |
| `rest` | `postgrest/postgrest:v14.5` | `127.0.0.1:3000` | PostgREST (memory/config queries) |
| `kong` | `kong:2.8.1` | container-only (`expose: 8000`) | API gateway in front of PostgREST |
| `studio` | `supabase/studio:20250113-83c9420` | `127.0.0.1:3001` | Supabase Studio (DB inspection) |
| `meta` | `supabase/postgres-meta:v0.95.2` | container-only | Required by Studio |
| `email-bridge` | build `./email-bridge` | container-only (`expose: 3100`) | IMAP/SMTP REST microservice |
| `file-bridge` | build `./file-bridge` | container-only (`expose: 3200`) | Binary passthrough for agent |
| `discord-bridge` | build `./discord-bridge` | container-only (`expose: 3300`) | Optional, enabled via `COMPOSE_PROFILES=discord` |
| `crawl4ai` | `unclecode/crawl4ai:latest` | container-only (no ports/expose) | Web reader / clean markdown |
| `searxng` | `searxng/searxng:latest` | `127.0.0.1:8888` | Private web search |

Everything except n8n is either container-network-only or bound to loopback. Cross-service calls go via Docker DNS (`kong:8000`, `db:5432`, etc.). The installer's default HTTPS path is an nginx reverse proxy in front of n8n with a Let's Encrypt certificate, triggered when the operator provides a `DOMAIN`. An `SKIP_REVERSE_PROXY=true` env var lets operators plug in their own reverse proxy instead (useful if Hostinger fronts the VPS with a managed proxy).

---

## 4. Persistence and minimum specs

### Volumes

Three named volumes (persist across container recreation) plus read-only bind mounts for config:

| Volume / bind | Mount point | Contents |
|---|---|---|
| `n8n_data` (named) | `/home/node/.n8n` | n8n DB + encryption key + workflow binary data |
| `db_data` (named) | `/var/lib/postgresql/data` | PostgreSQL (all agent memory, conversations, MCP registry) |
| `file_bridge_data` (named) | `/data` | Temp files with 24h TTL |
| `./supabase/migrations` (bind, ro) | `/docker-entrypoint-initdb.d` | Schema seeds applied on first DB start |
| `./supabase/kong.deployed.yml` (bind, ro) | `/var/lib/kong/kong.yml` | Kong declarative config |
| `./searxng/settings.yml` (bind, ro) | `/etc/searxng/settings.yml` | SearXNG config |

**Nothing stateful lives in bind-mounted host paths.** The three named volumes contain all persistent agent state. A backup plan can be as simple as "snapshot these three volumes + `.env`."

### Minimum specs (observed)

- **2 vCPU, 4 GB RAM** for a lightweight install **without** Crawl4AI (disable the service in compose). Handles the agent + Postgres + PostgREST + Kong + Studio + Telegram + webhook traffic comfortably.
- **2 to 4 vCPU, 8 GB RAM** for the full default stack including Crawl4AI. Crawl4AI is the one large consumer: the compose limits it to `memory: 4G` and `shm_size: 2g`. If Hostinger's smaller tiers are meant to fit, Crawl4AI is the knob to turn (disable, swap for a lighter fetcher, or gate behind a profile).

---

## 5. Security and operations

### Public surface

Only `:5678` is reachable from outside the host. PostgREST, Postgres, Studio, and SearXNG are bound to `127.0.0.1` by explicit design so they are not reachable across the public interface even if the host firewall is permissive.

### Auth

- Webhook API endpoints (`/webhook/agent`, `/webhook/adapter`, `/webhook/custom`) require the `X-API-Key` header matching `WEBHOOK_SECRET` (auto-generated).
- n8n has its own built-in user management with login (operator creates the admin account on first boot).
- All n8n credentials (Telegram token, LLM API key, Postgres password) are encrypted at rest with `N8N_ENCRYPTION_KEY` inside the `n8n_data` volume.

### Updates

`./setup.sh --force` re-imports all workflows, patches LLM-provider nodes to match current config, and reapplies workflow-ID references. It never regenerates existing secrets. On update mode, the installer reads `N8N_ENCRYPTION_KEY` back from the Docker volume as the source of truth (`setup.sh:128-143`), so a broken `.env` cannot silently lock operators out.

### Backup

Standard Postgres routine works: `docker compose exec db pg_dump -U postgres postgres > backup.sql`. For the n8n side, the `n8n_data` volume is self-contained. `docker run --rm -v n8n-claw_n8n_data:/data alpine tar -czf - -C /data .` is sufficient.

### Logs

All services log to Docker's default stdout/stderr. `docker logs -f n8n-claw` / `docker logs -f n8n-claw-db` etc. No separate log volume.

---

## 6. Web first-run wizard (scoped plan)

The goal is to replace the interactive `setup.sh` prompts with a web form served by the stack itself, so a 1-click deploy model (boot container, open URL, configure) becomes possible.

### Proposed flow

1. Container starts with auto-generated secrets but **no LLM / Telegram / domain config**.
2. n8n starts and exposes a `/setup` route served by a small first-run workflow (or a lightweight sidecar, decision depends on Hostinger's preferred shape).
3. Operator opens `/setup` and fills a form (LLM provider + key, Telegram token + chat ID, optional Discord, optional embedding provider, optional domain).
4. Submit handler writes to the DB (`tools_config`, `soul`, `agents`) and creates the required n8n credentials via n8n's own API using `N8N_API_KEY`.
5. Wizard marks itself complete (`setup_done` flag) and the agent becomes active. Re-entering `/setup` in the future goes to a "Reconfigure" screen.

### Why this is feasible

Everything the current `setup.sh` does after n8n boots is already API-driven (credential creation, workflow activation, DB seed via PostgREST). The wizard is a thinner front for the same calls, so no new integration surface, just a UI change.

### Effort estimate

Medium refactor. Realistic budget: 2 to 3 focused dev-days including a clean end-to-end test on a fresh VPS. The `setup.sh` can stay as the power-user fallback.

### What we would need from Hostinger

- Confirmation of the expected deploy model: env-only compose, init-container, hPanel variable schema, or a custom spec.
- Whether the Docker-catalog entry ships a pre-baked `.env` template or collects variables through hPanel UI.
- Any constraints on the first-run flow (e.g. must not require shell access after deploy).

We are happy to build to spec rather than guess. The wizard and a `--unattended` flag for `setup.sh` are both on offer. We would prioritize whichever fits Hostinger's catalog model.

---

## Differentiation versus already-listed projects

Not part of Kodee's 6 questions, but relevant for the catalog team's routing decision:

- **OpenClaw** and **Hermes Agent** (both in the Hostinger catalog) are monolithic container apps where agent logic lives in application code.
- **n8n-claw** runs on n8n as the execution engine. The complete agent logic (tool calls, routing, memory ops, MCP integration) is a **visual, editable workflow**. IT teams can audit data flows, disable individual steps, or add custom logic without touching container code.
- This matters for GDPR audits, enterprise compliance reviews, and user extensibility. It also reinforces the value of n8n itself, which Hostinger already lists.

Providers are pluggable (Anthropic, OpenAI, OpenRouter, DeepSeek, Gemini, Mistral, Ollama, OpenAI-compatible). A nexos.ai preset is a natural addition once we understand Hostinger's preferred credit-provisioning flow.
