# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

---

## [1.5.0] — 2026-04-18

### Memory that models the user, not just remembers facts

Three additions turn the memory layer from a passive fact store into an active user-modelling system — without adding token overhead to live conversations.

**Nightly pattern extraction.** The memory-consolidation workflow now runs a second LLM pass after the daily factual summary. It reads the day's consolidated memory alongside the last 7 days of existing insights and extracts 2–5 behavioural patterns — stressors, working rhythms, communication style, abandoned intentions — tagged as `new`, `reinforced`, or `contradicted`. Contradicted insights get marked `metadata.outdated=true` (soft-delete via knowledge-graph-style temporal validity) rather than overwritten, so the history of what the agent *used to believe* about the user stays queryable. Results are saved as `category='insight'` with `importance=8–9`, persisting via the existing half-life decay logic for roughly 250 days.

**Open loops with proactive follow-up.** New memory category `open_loop` for intentions the user mentions in passing ("I should probably compare that Hostinger quote", "don't forget Y"). The heartbeat workflow checks every 24–48h (throttled via `heartbeat_config`) for open loops older than 3 days and — if any are worth raising — asks the agent to fire a proactive Telegram ping. When the user responds with a resolution, the agent calls `memory_update` with strict rules: category stays `open_loop`, content stays byte-for-byte, only `metadata` gets merged in with `{closed, closed_at, outcome}`. The audit trail survives because pattern analysis needs the historical signal — *"Freddy opened 12 infrastructure open loops and abandoned 10 of them"* requires the original rows to remain queryable as open_loops, with original wording intact.

**Insight recall in the system prompt.** Every agent turn now preloads the top 3 non-outdated insights (by importance, then recency) into a new system-prompt section — *"What you know about the user"*. Adds ~200–500 input tokens per turn in exchange for context the agent would otherwise have to search for. The instruction tells the model to let insights *shape* its behaviour rather than quote them back at the user.

### Added

- **`memory-consolidation.json`** — 5 new nodes after the existing Save Consolidated step: `Load Recent Insights`, `Build Insight Prompt`, `Insight LLM Call` (same provider as the daily summary, temperature 0.3), `Parse Insights` (handles contradicted → outdated marking), `Save Insights`. No schema change: `memory_long.category` has no CHECK constraint, so `insight` is additive.
- **`heartbeat.json`** — new `open_loop_check` branch parallel to the existing scheduled-actions path. Fires proactive prompts via fire-and-forget sub-workflow call to the agent, updates `heartbeat_config.last_run` immediately regardless of agent outcome. Output filter drops `[SKIP]` responses before they reach Telegram.
- **`n8n-claw-agent.json`** — new `Load Insights` Postgres node (parallel to Soul / Agents / User Profile loads) and a system-prompt extension in `Build System Prompt` that appends the insights section only when rows exist (no empty header).
- **Agent instructions** — the `agents` seed in `setup.sh` now teaches the agent when to create open loops (casual intentions) vs. tasks (formal work items) vs. reminders (time-triggered pings), and the strict close-rules for open loops.

### Fixed

- **`memory_update` dropped the `metadata` field.** The tool's description and jsCode only supported content, category, importance, tags, entity_name, source — so the agent's correct `{id, metadata: {closed: true, ...}}` call silently went through without writing metadata. Fixed: description now documents `metadata (object — merged with existing metadata, not replaced)` and the jsCode does a shallow merge by fetching current metadata, spreading input on top, and PATCHing back. Existing keys survive updates.
- **`setup.sh` workflow lookup missed workflows past the first 100.** The `?limit=100` call had no cursor pagination, so with 132+ workflows on the instance the agent itself wasn't found during `--force` reimport. The lookup fell through to the CREATE branch instead of DELETE+CREATE, leaving two agent workflows (old active, new inactive) fighting over the same webhook paths. Fixed: replaced the curl with a Python loop that paginates via `nextCursor`, plus a deactivate-before-delete to ensure n8n cleans up `webhook_entity` rows. Heartbeat / Reminder Runner activation errors, previously swallowed silently, now surface.
- **`[SKIP]` heartbeat responses leaked into conversation history.** The agent's proactive-reminder output filter dropped `[SKIP]` before Telegram send, but the Save Conversation node still logged it. Fixed: filter moved upstream so `[SKIP]` turns leave no trace in `conversations` or `memory_daily`.

### Upgrade from v1.4.0
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
No schema migrations. The new memory categories (`insight`, `open_loop`) are additive — existing memories are untouched. Open loops begin accumulating as soon as the new agent instruction is seeded; the first insights will appear after the next nightly consolidation run (03:00).

---

## [1.4.0] — 2026-04-17

### Enterprise & Productivity Skills — the agent meets the real SaaS stack

Catalog expansion focused on the APIs teams actually run their business on: CRM, issue tracking, billing, project management. With this release the skill library covers the core SaaS stack (HubSpot, Salesforce, Zoho, Jira, Confluence, Stripe, Asana, Airtable) — so the agent can genuinely work alongside the user in their existing tools instead of acting as a standalone sandbox.

Total skill catalog grows to 64. All CRM/issue-tracker skills use dynamic field discovery where supported, so custom fields flow through automatically without per-org manifest tweaks.

### Added

**CRM & Sales (123 tools across 4 skills):**
- **HubSpot CRM** (28 tools) — Contacts, Companies, Deals, Tickets, Notes, Tasks, Engagements; search via HubSpot Filter API; Private App token auth.
- **Salesforce CRM** (35 tools) — Leads, Contacts, Accounts, Opportunities, Cases, Tasks; SOQL + SOSL; Client-Credentials OAuth (Connected App). Instance URL auto-prefixes `https://` when the user pastes only the hostname, and auth errors surface the actual Salesforce error body instead of axios' generic "Request failed with status code 401".
- **Zoho CRM** (37 tools) — Leads, Contacts, Accounts, Deals, Tasks, Cases, Notes, Users + `convert_lead`, `coql_query`, `describe_module`. Self-Client OAuth with **auto-exchange grant code** (no terminal / curl required — the skill trades the one-time grant code for a long-lived refresh token on first use and stores it back in the credential table). Regional endpoints (.com / .eu / .in / .com.au / .jp / .com.cn). `?fields=` capped at 50 per Zoho v8's hard limit, with subform/ownerlookup types filtered so orgs with many custom fields don't get a bare 400 on list calls.
- **Stripe** (23 tools) — Customers, Payments, Subscriptions, Invoices, Products, Prices, Refunds.

**Productivity & Project Management (49 tools across 4 skills):**
- **Asana** (16 tools) — Tasks, Projects, Sections, Stories, Users, Workspaces; full CRUD. Shipped at v1.1.0 with 6 follow-up tools beyond the initial 10-tool release.
- **Jira Cloud** (12 tools) — Issues, Projects, Users, JQL search, transitions, comments. Shares the Atlassian API token with Confluence.
- **Confluence Cloud** (14 tools) — Spaces, Pages, Blog Posts, Comments, Attachments, CQL search. Both Atlassian skills use a custom `buildQs` query-string helper instead of the n8n sandbox's `URLSearchParams`, which stringifies arrays as `[object Object]` and was corrupting JQL/CQL queries with commas or spaces.
- **Airtable** (7 tools) — Bases, Tables, Records (list / get / create / update / delete).

**Knowledge, Finance & Media (5 skills):**
- **YouTube Data API** (4 tools) — Search videos/channels, get video/channel details.
- **Finnhub Stocks** (5 tools) — Quotes, company profiles, news, earnings.
- **Open Library** (3 tools) — `search_books`, `get_book`, `get_author`.
- **Unsplash** (3 tools) — `search_photos`, `get_random_photo`, `get_photo`.
- **OpenAQ Air Quality** — v3 API, air quality measurements and stations.

**Smart Home, Maps, Messaging (3 skills):**
- **Home Assistant** — control devices and query state on a self-hosted Home Assistant instance. Includes a `speak` tool that auto-routes to TTS-capable media players for voice output. New `smart-home` category.
- **Overpass OSM** — OpenStreetMap queries via Overpass API. Ships with automatic mirror fallback (main → de → fr → kumi) so requests keep working when overpass-api.de is degraded, a `reverse_geocode` tool, and auto-reverse-geocoded results in `find_nearby` so the LLM gets street names instead of raw lat/lon. New `maps` category.
- **ntfy** — push notifications via ntfy.sh (self-hosted or hosted). Non-ASCII header values (German umlauts in Title/Message) are RFC 2047 encoded, and server errors are passed through verbatim instead of being swallowed by a generic "Failed to send notification".

### Changed
- **`mcp-client`**: empty strings are now accepted for required parameters. Previously the pre-flight schema check rejected the call before the tool could apply its own default handling, so an LLM passing `""` for a required field would get a hard error instead of the tool's graceful default.
- **Route-planner** moved from the `transport` category to `maps` to match the Overpass addition. Two new valid categories: `maps`, `smart-home`.

### Upgrade from v1.3.2
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
Then install the skills you want via chat:
- `install hubspot` / `install salesforce` / `install zoho-crm` — CRMs (each requires its own API credentials)
- `install jira` / `install confluence` — with an Atlassian API token (same token works for both)
- `install asana` / `install stripe` / `install airtable` — with the respective API key
- `install youtube` / `install finnhub` / `install unsplash` / `install openlibrary` / `install openaq` — mostly free / generous free tiers
- `install home-assistant` / `install overpass-osm` / `install ntfy` — self-hosted or free services

No schema migrations. No breaking changes to existing skills.

---

## [1.3.2] — 2026-04-15

### Discord Adapter + Webhook Adapter Default-Active

Discord joins Telegram as a supported chat interface, and the Webhook Adapter is now activated by default so generic/Paperclip integrations stop silently breaking on `--force`.

### Added
- **New workflow: `discord-bridge`** — opt-in Discord.js v14 Gateway client + Express `/reply` endpoint, packaged as a sidecar container behind the `discord` Compose profile. A single `y/N` prompt during `setup.sh` enables it; on opt-in, `COMPOSE_PROFILES` gets `discord` and the sidecar starts with the rest of the stack. Routes messages to the agent via `/webhook/adapter` and replies back through the bridge.
- **Bridge-skill docs** in README and `CLAUDE.md` — now that external MCP servers (bridge templates) are first-class, both docs call out the distinction between native (wrapped) and bridge (URL-registered) skills.

### Changed
- **`setup.sh` activates the Webhook Adapter unconditionally** — the previous "inactive by default" stance was reflex caution. Slack/Teams triggers inside the adapter are node-level disabled and stay dormant, the generic webhook is auth-protected via `WEBHOOK_SECRET`, and Paperclip + custom webhook consumers were silently breaking on every `--force`. The adapter is now always live after deploy.

### Upgrade from v1.3.1
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
To enable Discord, answer `y` at the Discord prompt during setup and provide a bot token. The sidecar only starts when the profile is active, so existing Telegram-only installs are unaffected.

---

## [1.3.1] — 2026-04-14

### Bridge MCP: Schema-Hint Retry

Follow-up to v1.3.0 that makes external MCP tool calls more resilient to LLM schema mismatches.

### Added
- **Schema-hint retry for bridge tool calls** — when a tool call to an external MCP server fails with a schema error (the LLM passed arguments the bridge target rejects), the MCP Client now retries once with the tool's JSON schema appended to the error, giving the LLM a concrete correction target. Native (wrapped) skills were unaffected by the original issue because their schemas are always in-context; bridge skills only expose schemas via `tools/list`, which the LLM sometimes misremembers.

### Upgrade from v1.3.0
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
No skill updates required. Existing bridge installs benefit automatically.

---

## [1.3.0] — 2026-04-13

### MCP Bridge — External MCP Servers as First-Class Skills

Any existing MCP server (DeepWiki, Zapier, a self-hosted Claude Code MCP, commercial vendor endpoints) can now be registered directly as a skill — no wrapper workflow, no code to maintain — just a URL plus optional bearer/header auth. This unlocks the broader MCP ecosystem without forcing every integration to be re-implemented as an n8n workflow.

### Added
- **Bridge templates** — new manifest type (`type: "bridge"`) that points at an external MCP Streamable HTTP endpoint. The Library Manager imports no workflows for bridge skills; instead it writes straight into `mcp_registry` so the agent's MCP Client can call the remote tools like any other skill.
- **Bridge manifest schema** — `bridge.mcp_url`, `auth_type` (`bearer`/`header`/`none`), `auth_token_required`, `auth_label`, `auth_hint`. Auth tokens (when required) flow through the same credential-form link that native skills use, are stored in `template_credentials`, and are reused on re-install.
- **First bridge template: DeepWiki** — no-auth reference implementation that registers the hosted DeepWiki MCP server for Q&A across public GitHub repositories.
- **Template-repo docs** — `TEMPLATE_EXAMPLE.md` gained a dedicated "Bridge Templates" section; the templates-repo `CLAUDE.md` was updated so contributors know when to reach for a bridge template vs a native workflow.

### Changed
- **Library Manager** — `install_template` / `remove_template` / `add_credential` each branch on `manifest.type` so bridge skills skip workflow import, activation, and deletion entirely. The bundled CDN hash was bumped to pick up the new template schema.

### Upgrade from v1.2.3
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
Then try the first bridge skill:
- `install deepwiki` — no credentials needed; asks the agent anything about a public GitHub repo, e.g. *"What does the `train_ppo` script in huggingface/trl do?"*

---

## [1.2.3] — 2026-04-12

### Error Notification Workflow + Proactive Failure Awareness

Workflow failures are no longer invisible. A new global error handler catches failures in the critical workflows, sends a Telegram alert, and logs the failure to long-term memory so the agent can answer questions like *"did anything fail today?"* without the user having to check n8n manually.

### Added
- **New workflow: `error-notification.json`** — Error Trigger with parallel fan-out to Telegram alert + `memory_long` via PostgREST. The log node uses the same PostgREST pattern as "Save Conversation and Log" to avoid the pg-promise `$N` escaping bug. Error rows include `category='error'`, `importance=8`, `tags=['error','workflow-failure',<workflow>]`, and a structured `metadata` jsonb with `execution_id`, `execution_url`, `workflow_id`, `node_name`, `error_name`, `error_message`, and a truncated `error_stack`.
- **Automatic wiring on deploy** — `setup.sh` now attaches the error workflow to the three critical workflows (`n8n-claw-agent`, `background-checker`, `sub-agent-runner`) via `settings.errorWorkflow` after import. Other workflows are reached transitively — their exceptions bubble up to these three entry points.
- **New `error_log` agents seed** — teaches the agent when and how to proactively check for failures. Includes a hard rule: always call `memory_search` with `{"search_query":"error","category":"error"}` rather than free-text queries, because the fulltext index uses AND-semantics with no stemming (natural-language queries like *"error workflow failure recent"* silently return nothing).

### Changed
- **LLM max output tokens: 4096 → 8192** in all three Anthropic nodes (main agent, background checker, sub-agent runner). The 4096 value was a Claude 3-era legacy default that silently truncated long-form responses mid-sentence. `setup.sh` propagates this value into every provider's tokens_key at deploy time, so all providers benefit. Zero cost impact — you only pay for generated tokens, not the cap.

### Upgrade from v1.2.2
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
No additional steps needed. Verify with: *"did any workflow crash recently?"* — the agent should now find error entries proactively.

---

## [1.2.2] — 2026-04-10

### New Skill: DZT Germany Tourism

First skill in the new **Tourism** category. Proxies the Deutsche Zentrale für Tourismus (DZT) MCP Server via One.Intelligence — no API key needed.

### Added
- **New skill: DZT Germany Tourism** — search German tourism data: POIs (museums, castles, landmarks), events (festivals, markets), hiking/cycling trails, and entity details. Uses MCP Streamable HTTP transport to proxy the DZT server at `destination.one`. Tools: `get_pois_by_criteria`, `get_events_by_criteria`, `get_trails_by_criteria`, `get_entity_details`.
- **New category: `tourism`** — template catalog gained a dedicated category for tourism and travel skills.

### Changed
- **CDN hash** updated to `03b490c` in Library Manager for the new template.

### Upgrade from v1.2.1
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
Then install the new skill via chat:
- `install dzt-germany-tourism` — no credentials needed

---

## [1.2.1] — 2026-04-10

### Token Optimization

Reduces main agent system prompt token usage by ~25% through fixing a persona data leak.

### Changed
- **Persona loading optimized** — full persona bodies no longer loaded into main system prompt; agent sees only the compact `expert_agents` meta-listing. Sub-Agent Runner loads full personas separately on delegation. Saves ~3,700 tokens per request.
- **setup.sh seed fix** — `expert_agents` seed changed from `ON CONFLICT DO UPDATE` to `ON CONFLICT DO NOTHING`, preventing `setup.sh --force` from overwriting dynamically maintained expert agent metadata.

### Upgrade from v1.2.0
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
No additional steps needed.

---

## [1.2.0] — 2026-04-09

### Hybrid Memory Search, Time Decay & Multi-Language

Memory retrieval upgraded from pure semantic search to three-branch hybrid search with Reciprocal Rank Fusion (RRF). The agent now finds people by name, survives embedding API outages, and naturally prefers recent context.

Hybrid search architecture inspired by [@geckse](https://github.com/geckse)'s [markdown-vdb](https://github.com/geckse/markdown-vdb) — a Rust-based vector DB with hybrid search (semantic + BM25 + RRF) designed for AI agents. We adapted the three-branch RRF fusion pattern for PostgreSQL using tsvector + pgvector.

### Added
- **Hybrid Search RPC** (`hybrid_search_memory`) — fuses three independent search branches via RRF (k=60, Cormack standard):
  - **Semantic** — pgvector cosine distance (unchanged from v1.1)
  - **Full-text** — tsvector with `ts_rank_cd` cover-density ranking (replaces primitive ILIKE fallback)
  - **Entity match** — direct ILIKE on `entity_name` for proper-noun boost
- **Time Decay** — exponential half-life scoring scaled by importance (`half_life = 90 + importance * 20` days, range 110–290d). Category exemption for `contact`/`preference`/`decision` (decay factor always 1.0). Enabled by default, opt-out via `use_time_decay=false`.
- **Multi-language full-text** — `unaccent` extension + `'simple'` tsvector config normalizes accents and umlauts across all languages (e.g. `München` matches `muenchen`, `résumé` matches `resume`)
- **GENERATED STORED column** `search_vector` on `memory_long` — auto-maintained by Postgres, no changes to INSERT/UPDATE workflows needed
- New migration: `supabase/migrations/005_hybrid_search.sql`

### Changed
- **Memory Search tool** now always calls `hybrid_search_memory` (single RPC, handles embedding-null gracefully via branch degradation). Old two-branch if/else removed.

### Breaking Changes
None. Old RPCs `search_memory` and `search_memory_keyword` remain in the database. Config-backup skill works unchanged (explicit column list, generated column auto-populates on restore).

### Upgrade from v1.1.1
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
No skill updates needed. The migration runs automatically and backfills `search_vector` for all existing memories.

---

## [1.1.1] — 2026-04-08

### Bugfixes, Config Backup Skill Update, and Google Media Generation

Follow-up to v1.1.0 that closes two data-loss gaps discovered after release and ships the new Google Media Generation skill, a matching expert agent, and several template catalog improvements that landed between releases.

### Fixed
- **`config-backup` skill lost Knowledge System data** — the backup skill shipped in v1.1.0 did not know about the new enriched memory columns (`tags`, `entity_name`, `source`) or the `kg_entities` / `kg_relations` tables. Backups taken with the old skill silently dropped everything the v1.1.0 Knowledge System introduced. The skill is now bumped to `1.1.0` and saves:
  - `memory_long.tags`, `memory_long.entity_name`, `memory_long.source`
  - full `kg_entities` table (with UUID primary keys so relations can be restored)
  - full `kg_relations` table, ordered after `kg_entities` so foreign keys resolve on restore
  - backup format version bumped to `1.1` (old `1.0` backups remain restore-compatible)
- **`soul.proactive` silently wiped on `setup.sh --force`** — when a custom persona was set, the personalization block explicitly cleared the `PROACTIVE` variable before writing the `soul` table. The proactive/reactive choice from the setup menu was therefore discarded on every re-deploy, leaving the agent without any proactive-behavior instruction in its system prompt. Custom persona (tone/role) and proactive behavior (initiative style) are now treated as independent settings.
- **`google-media-gen` video generation timeout** — long-running Veo 3.1 video jobs exceeded the MCP tool-call timeout. Video generation is now split into a `generate_video` call that starts the job and a separate `wait_for_video` call that polls for completion.

### Added
- **New skill: Google Media Generation** — Nano Banana Pro for image generation/editing and Veo 3.1 for video generation and image-to-video animation. Tools: `generate_image`, `edit_image`, `generate_video`, `animate_image`, `wait_for_video`.
- **New expert agent: `google-media-prompter`** — specialized sub-agent for prompt engineering around Google's generative media models. Install via the Agent Library.
- **New category: `creativity`** — template catalog gained a dedicated category for generative media and creative tooling. `google-media-gen` moved out of `utilities`.
- **Tested column in skill catalog** — `n8n-claw-templates/README.md` now shows which skills have been smoke-tested on a live instance.
- **Keep-current for proactive setting** — `setup.sh --force` now reads the existing `soul.proactive` content from the DB and offers "Choose [keep current]" as the default, so manual DB edits to that row survive re-runs.
- **Custom → preset reset** — the custom persona prompt now accepts `reset` as an explicit way to drop the current custom persona and fall back to the preset selected via the Style menu. Previously there was no path from a custom persona back to a preset without direct DB editing.

### Upgrade from v1.1.0
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
Then update the affected skills via chat:
- `update config-backup` — required to back up Knowledge System data
- `install google-media-gen` — optional, if you want Nano Banana / Veo 3.1
- `install agent google-media-prompter` — optional, expert prompter for the above

If your `soul.proactive` row was wiped by the old bug, re-running `setup.sh --force` and keeping the default choice will seed it with the proactive-behavior text.

---

## [1.1.0] — 2026-04-07

### Knowledge System & Bug Fixes

The agent now builds structured knowledge automatically — enriched memories with tags, entity tracking, auto-expiry, and a full knowledge graph with relationship mapping.

### Added
- **Enriched Memory** — memories now include tags (English lowercase keywords), entity names, and source tracking
- **Knowledge Graph** — new `kg_entities` and `kg_relations` tables for tracking people, companies, projects, events, and their relationships
- **Entity Manager** tool — search, save, update, relate, graph traversal, delete entities and relations
- **Auto-expiry** — memories expire based on category and importance (contact/preference/decision never expire, others after 90–180 days)
- **Memory Consolidation upgrade** — nightly job now extracts tags and entity names via LLM, sets auto-expiry, and cleans up expired entries
- **Proactive memory search** — agent searches memory before responding for better contextual answers
- **MCP connection guide** — docs for connecting Claude Code, Claude Desktop, and Cursor
- **New skills**: Config Backup, Lexware Office

### Fixed
- **`$` sign crash in conversations** (#26) — replaced Postgres nodes with PostgREST for Save Conversation and Log, eliminating pg-promise `$N` parameter interpretation
- **Hidden input hint** (#25) — setup now shows "(input is hidden for security)" when entering API keys. Thanks @LukasRegniet!
- **Umlaut handling** — `normalize()` transliterates ä→ae, ö→oe, ü→ue, ß→ss instead of stripping them
- **Recursive CTE** — graph traversal restructured for PostgreSQL 15 compatibility
- **Migration idempotency** — `004_knowledge.sql` drops both old and new function signatures

### Upgrade from v1.0.0
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
`--force` is required for the new workflow tools (Entity Manager, updated Memory Save).

---

## [1.0.0] — 2026-04-05

### Multi-Provider, Zero Config

n8n-claw is now fully model-agnostic. Choose your LLM provider during setup and everything works out of the box — no manual node swapping, no credential juggling. This release also streamlines the installation to a 2-step process: clone & run, then chat.

### Added
- **LLM Provider Abstraction** — setup.sh automatically patches all LLM nodes in every workflow to match your chosen provider before importing
- **8 supported providers**: Anthropic, OpenAI, OpenRouter, DeepSeek, Google Gemini, Mistral, Ollama, OpenAI-compatible
- **Mistral AI** as new provider option
- **Provider switching** via `./setup.sh --force` — re-imports all workflows with new provider nodes
- **Credential PATCH** — existing credentials are updated with current API keys on re-run (instead of reusing stale data)
- **Telegram webhook fix** — second deactivate/activate cycle at end of setup ensures reliable webhook registration on fresh install
- **Ollama model prompt** — interactive model selection during setup
- **File delivery pipeline** — agent can send files (PDFs, images, documents) back to users via `[send_file:]` markers

### Changed
- **Default models updated**: OpenAI → `gpt-5.4`, Gemini → `gemini-3-flash-preview`, Ollama → `glm-4.7-flash`
- **README simplified** — installation reduced to 2 steps (clone & run → chat), removed manual credential setup instructions
- **Memory Consolidation** reads LLM provider config from `tools_config` at runtime (works with any provider)

### Fixed
- Gemini credential type corrected to `googlePalmApi` (matches n8n node expectation)
- OpenRouter default model corrected to `anthropic/claude-sonnet-4-6`
- Connection traversal in LLM node patch for nested workflow structures

### Upgrade from v0.17.0
```bash
cd n8n-claw && git pull && ./setup.sh --force
```
Choose your provider when prompted. All workflows will be re-imported with the correct LLM nodes.

---

## Previous Releases (v0.1.0 – v0.17.0)

### [0.17.0] — 2026-04-03 — File Bridge: Binary File Passthrough
New File Bridge microservice for binary file handling between Telegram, cloud storage, and the agent. Skills (Seafile, Google Drive, Nextcloud) now support upload and download of actual files.

### [0.16.0] — 2026-03-27 — Google OAuth2 & Google Skills
OAuth2 authorization flow via Telegram. Four new Google skills: Gmail, Calendar, Analytics, Ads. Fixed cartesian product bug in agent workflow.

### [0.15.0] — 2026-03-23 — OpenClaw Integration & New MCP Skills
OpenClaw integration (autonomous Linux agent), NocoDB CRM, Vikunja task management. Logo and social preview added.

### [0.14.0] — 2026-03-20 — Webhook API & External Integrations
HTTP webhook endpoint for Slack, Teams, Paperclip, and custom apps. Unified adapter workflow with multi-system support.

### [0.13.0] — 2026-03-19 — Heartbeat Extension
Recurring scheduled actions, Background Checker for silent monitoring, notify_mode control. Email Bridge with IMAP search.

### [0.12.0] — 2026-03-15 — Expert Agents
Sub-agent system with dynamic personas. Agent Library Manager for installing expert agents from catalog. 85+ expert agents available.

### [0.11.0] — 2026-03-14 — Crawl4AI Web Reader
Self-hosted web reader with JavaScript rendering. New MCP skills.

### [0.10.0] — 2026-03-10 — Project Memory & Scheduled Actions
Project document management, scheduled agent actions, reminder system rewrite, Email Bridge microservice, dynamic MCP server loading.

### [0.9.0] — 2026-03-10 — Scheduled Actions & Reminders
Single reminder workflow, auto-cleanup, dynamic MCP loading.

### [0.8.0] — 2026-03-10 — Reminder System
Unified reminder workflow replacing per-reminder approach.

### [0.7.0] — 2026-03-08 — Credential Flow & MCP Templates
Secure credential form for MCP skill API keys. One-time tokens with 10-min TTL. MCP template registry via CDN.

### [0.6.0] — 2026-03-07 — MCP Template Registry
Skill catalog with CDN delivery. Library Manager for install/remove.

### [0.5.0] — 2026-03-06 — Self-Hosted Web Search
SearXNG integration for private web search.

### [0.4.0] — 2026-03-06 — Media Handling
Photo, document, voice message, and location support in Telegram.

### [0.3.0] — 2026-03-06 — Heartbeat & Task Management
Proactive heartbeat, task management, morning briefing.

### [0.2.0] — 2026-03-06 — RAG Pipeline & Memory
Vector embeddings for semantic memory search. Memory consolidation workflow.

### [0.1.0] — 2026-03-05 — First Release
Core agent with Telegram interface, long-term memory, conversation history, MCP Builder, personality system.
