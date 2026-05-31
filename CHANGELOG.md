# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

---

## [1.9.1] — 2026-05-31

### Fixed: n8n 2.21+ startup crash from `agents` table name collision (Issue #35)

n8n 2.21.4 introduced a built-in *Agents* feature. Its boot migration `CreateAgentTables1783000000000` creates a `public.agents` table and then indexes its `projectId` column. n8n-claw already owned a `public.agents` table (persona and tool config, the source of the system prompt) in the same Postgres database, so n8n's `createTable('agents')` no-op'd, the follow-up `createIndex('agents', ['projectId'])` failed with `column "projectId" does not exist`, and n8n crash-looped on every boot without reaching "ready". The whole 2.21.x and 2.22.x lines are affected; the last n8n that booted cleanly against an existing n8n-claw DB was 2.20.12. Because `docker-compose.yml` tracks `n8nio/n8n:latest`, any `docker compose pull` after 2.21.4 shipped took the instance down. The failed migration rolls back inside its transaction, so no data is lost, but every restart re-attempts and re-fails.

Reported by an external user, who worked around it locally by pinning to 2.20.12 and then closed the issue as `NOT_PLANNED` ("handling this on our side"). The collision was real and still shipped to everyone, so it is fixed here properly rather than left to a version pin: the n8n-claw config/persona table is renamed from `agents` to `claw_agents`, freeing the `agents` name for n8n's own core table. `docker-compose.yml` stays on `:latest`, since the two no longer overlap.

### Added

- **`supabase/migrations/009_agents_rename.sql`** — idempotent, data-preserving rename. It only ever touches a `public.agents` table that has a `key` column, which uniquely identifies n8n-claw's table and never matches n8n's core `agents` (no `key` column), so it is a no-op if n8n already created its own. Two paths, because `setup.sh` applies `001_schema.sql` (which creates `claw_agents`) before `009`: if `claw_agents` does not exist yet it renames in place (carrying all rows); if `claw_agents` already exists (the empty shell `001` creates on an upgrade) it copies the legacy rows over with `INSERT ... SELECT ... ON CONFLICT (key) DO NOTHING` and then drops the legacy `agents` table. Safe on fresh installs, re-runs, and crash-looping instances alike.

### Changed

- **`supabase/migrations/001_schema.sql`** and **`002_seed.sql`** — table, sequence (`claw_agents_id_seq`), constraints (`claw_agents_pkey`, `claw_agents_key_key`), GRANTs, and both seed `INSERT`s renamed to `claw_agents`.
- **`setup.sh`** — applies `009_agents_rename.sql` right after the schema migrations and before the n8n-API wait, so a crash-looping instance frees the `agents` name and self-heals on the next restart within the same run; both persona/config seed `INSERT`s now target `claw_agents`.
- **Workflows** — raw-SQL reads in `n8n-claw-agent.json` (`Load Agents Config`) and `sub-agent-runner.json` (persona load) switched to `FROM claw_agents`; PostgREST URLs `/rest/v1/agents` switched to `/rest/v1/claw_agents` in `mcp-builder.json`, `mcp-library-manager.json`, and `agent-library-manager.json` (9 references). Persona keys (`persona:{id}`) are unchanged; only the table name moved.
- **`README.md`** — new Troubleshooting entry for the boot failure (`column "projectId" does not exist` / `CreateAgentTables1783000000000`) with the one-shot fix `git pull && ./setup.sh --force`.
- **`CLAUDE.md`** — DB schema table, "soul + claw_agents are the system prompt" section, Expert Agents section, and migrations listing updated to `claw_agents`, with an Issue #35 note explaining the collision.

### Validated

- Live verification on the n8n-claw VPS after `setup.sh --force`: `public.agents` is now n8n's core table (`id, name, projectId, ...`, 0 rows), `public.claw_agents` holds the 19 app rows (config + personas, nothing lost). n8n boots without the `CreateAgentTables` failure. Agent execution `136652` loaded 14 config rows from `claw_agents` plus the soul rows (`name: Greg`) and replied on Telegram, both recent agent executions finished with status `success`.

### Upgrade notes

- **Existing installs:** `git pull && ./setup.sh --force`. Migration `009` preserves all personas and config; n8n then creates its own clean `agents` table. No data loss, no manual steps.
- **Breaking only for custom code:** any user-added workflow or external script that queries the `agents` table or `/rest/v1/agents` directly must switch to `claw_agents`. All shipped workflows are already updated.

---

## [1.9.0] — 2026-05-11

### Browser Use — agentic browser actions, interactive 2FA, no TOTP plumbing required

n8n-claw stops being read-only on the web. Until now the agent could *read* pages (Crawl4AI as Web Reader, SearXNG as Web Search) but couldn't *do* anything — it couldn't sign you up for a newsletter, fill a contact form, click a button, log into a site to fetch private data, or run any multi-step UI flow. v1.9.0 ships **Browser Use** as a built-in capability: a real headless Chromium driven by an agentic LLM loop, exposed to the main agent as a single `browser_action` tool with three modes (`task`, `list_sessions`, `close_session`). End-to-end validated on 2026-05-11 against the live VPS — newsletter signup on jens.marketing in 70s (5 LLM steps), seven-field pizza-order form on httpbin in 65s, top-5 HN stories with article-content summaries in 206s (12 steps), and a full interactive-2FA login round-trip to GitHub that actually starred a real repo as the authenticated user.

The integration is a **REST-bridge sidecar**, not an MCP skill. Browser Use 0.12.6 ships only an `stdio` MCP server, which n8n's HTTP-based MCP Client can't speak to, so we own a thin FastAPI wrapper in `browser-bridge/` (~200 lines of Python) that adapts Browser Use's SDK to a normal HTTP API and runs alongside the existing bridges (`email-bridge`, `file-bridge`, `discord-bridge`). The agent's tool call → `workflows/browser-use.json` sub-workflow → `http://browser-bridge:3400/tasks` → live Chromium. This shape gives us two things Browser Use doesn't have natively: a **keep-alive session pool keyed by `(user_id, domain)`**, working around the broken `save_storage_state` in 0.12.6 (Issue #1002 reproduced) by simply keeping the browser process alive between calls; and **per-request LLM provider routing** that reads `tools_config.llm_provider` on every task, so the bridge follows whichever provider the main agent is currently configured for instead of being locked at container start.

Engine choice is data-driven, not vibes. A hands-on spike against **Skyvern 1.0.36+** (the obvious AGPL alternative) on three identical tasks showed Browser Use winning decisively on the use case that matters: form fills. Skyvern took **585 seconds** for a seven-field form and 16 steps; Browser Use did the same form in **65 seconds and 4 steps**. That's not a tuning gap, it's an architecture gap — Skyvern is vision-based and bills one action per step (~36 s/step end-to-end including LLM call + screenshot + reasoning), Browser Use is DOM-based and bundles up to 5 actions per step. Skyvern Issue #4439 ("4–5 min for 5–6 fields") has been open since December and matches what we measured. License also pointed the same way: Browser Use is MIT, Skyvern is AGPL-3.0 with a network-clause that would have shut the door on the `dmo-claw` commercial fork. Spike report and the engine-comparison table live at `C:\Users\fried\Seafile\Meine Bibliothek\Claude_Code_FS\browser-spike-results.md` (local, gitignored).

The cherry on top emerged unplanned during real-world testing: **interactive 2FA works end-to-end without any TOTP generator built into the bridge**. The agent hits the 2FA wall, returns a focused message asking for the code, the keep-alive session pool keeps the 2FA page loaded in the live Chromium, the user reads the code from their authenticator app and sends it as the next Telegram message, the agent makes a follow-up `browser_action` call with the matching `domain` — the code lands on the still-open form, GitHub redirects to the dashboard, and every subsequent task on that domain inherits the now-fully-authenticated session. Validated by execution chain `104757` (login → 2FA prompt) → `104760` (user supplies code, agent enters it, dashboard) → `104763` (Star repo as authenticated user) → `104776` (read private notifications). This was *not* a designed feature; it falls out of `keep_alive=True` plus the agent behaving sensibly when it doesn't have a tool for something — and it covers TOTP, SMS, and email-magic-link 2FA. The only 2FA flavour it can't cover is hardware-key / WebAuthn / passkey, because that needs a physical USB device the bridge doesn't have.

### Added

- **`browser-bridge/` service** — Python FastAPI sidecar wrapping the Browser Use 0.12.6 SDK + Playwright Chromium. Endpoints: `POST /tasks` (run a natural-language browser task, optionally pooled by `domain`), `GET /sessions/{user_id}` (list active pooled sessions), `DELETE /sessions/{user_id}/{domain}` (close a specific session), `GET /health` (liveness + browser_use version + active session count). Runs container-internal on port 3400 (no host port mapping, no public exposure). Files: `browser-bridge/Dockerfile`, `requirements.txt`, `src/main.py`, `src/llm.py` (provider routing), `src/session_pool.py` (keep-alive map + LRU eviction + idle-timeout), `src/__init__.py`, `README.md`.
- **`workflows/browser-use.json`** — thin sub-workflow with one Code node routing the agent's JSON arg by `action` (`task` / `list_sessions` / `close_session`) to the matching bridge endpoint. Falls back to `telegram:{{TELEGRAM_CHAT_ID}}` as `user_id` when the caller doesn't supply one (single-user n8n-claw default). HTTP timeout is `timeout_s + 30 s` so the bridge gets a chance to time out cleanly before the n8n side gives up.
- **`Browser Action` toolWorkflow node in `n8n-claw-agent.json`** — typeVersion 2.2, placeholder `REPLACE_BROWSER_USE_ID` patched by setup.sh post-import, wired into the AI Agent via the standard `ai_tool` connection. Description teaches the LLM the three actions, the `domain` pooling pattern, and the 30-min in-memory session-lifetime caveat.
- **`agents.browser_use` system-prompt seed** — new row in the `agents` table written by setup.sh, loaded into every agent turn alongside `mcp_instructions`, `expert_agents`, `knowledge_graph`, and `error_log`. Spells out the four-step **interactive 2FA pattern** explicitly: pause on the 2FA prompt, ask the user with a focused message, do NOT close the session, on the user's reply submit a follow-up `browser_action` call with the matching `domain` and the code. Same row covers safety rails (confirm sensitive actions, expect 30–90 s wait times, CAPTCHA escalation), session-pool mechanics, and concrete invocation examples.
- **Pool-management mechanics in the bridge** — max 5 concurrent live browsers (`BROWSER_BRIDGE_MAX_SESSIONS` env), LRU eviction when full, 30-min idle eviction (`BROWSER_BRIDGE_IDLE_TIMEOUT_S` env), `keep_alive=True` between calls. All sessions die on container restart by design — this is the v1 trade-off for Browser Use's broken `save_storage_state`.

### Changed

- **`docker-compose.yml`** — new `browser-bridge` service: `build: ./browser-bridge`, `expose: 3400`, `mem_limit: 3g`, restart `unless-stopped`, joined to the existing `n8n-claw-net`. All eight provider API keys (Anthropic, OpenAI, OpenRouter, Gemini, Groq, Mistral, DeepSeek, Ollama) are passed through from the host `.env` so the bridge can match whichever provider `tools_config.llm_provider` points at.
- **`setup.sh`** — `browser-use` added to `IMPORT_ORDER` just before `n8n-claw-agent` (so the workflow ID is patched in time), `REPLACE_BROWSER_USE_ID` added to the placeholder substitution map, `browser-use` added to the sub-workflow activation loop (the import API leaves new sub-workflows inactive even when they expose only an `executeWorkflowTrigger`, so explicit POST `/activate` is required), and the `browser_use` row added to the `agents`-table seed `INSERT ... ON CONFLICT (key) DO UPDATE`. The seed itself uses the same `{{...}}` f-string-escape + plain-prose-no-backticks convention as `error_log` and `knowledge_graph` — Python f-string formatting and Bash heredoc parsing both have rules about JSON examples that bit during the first deploy.
- **`CLAUDE.md`** — new "Browser Automation" section under "Workflow Architecture" with the stack, session-pool mechanics, mandatory Chromium args, interactive 2FA flow, and explicit dmo-claw portability note (yes, MIT). Repository-structure listing gains `browser-bridge/` and `workflows/browser-use.json`.
- **`README.md`** — Browser automation listed as a top-level feature, including the interactive-2FA hook so users know to expect the "send me the code" round-trip.

### Validated

- **Spike vs Skyvern** — same three tasks on the same VPS, same LLM (Claude Sonnet 4.6), same day. Newsletter signup on jens.marketing: Skyvern 58 s / 3 steps, Browser Use 52 s / 5 steps (gleichauf). Cookie persistence on httpbin: Skyvern works with explicit `POST /v1/browser_sessions`, Browser Use's `save_storage_state` raises `ValueError` (Issue #1002 reproduced — workaround chosen: keep-alive pool, see above). Seven-field pizza-order form on `httpbin.org/forms/post`: Skyvern **585 s / 16 steps**, Browser Use **65 s / 4 steps** — the gap that decided the engine choice. Sub-workflow execution IDs `104677` (parent agent) and `104678` (Browser Use sub) record the first production newsletter signup; results stayed consistent across all subsequent runs.
- **Session-pool reuse across separate tool calls** — execution `104708` set `freddy=test2` on httpbin.org with `domain=httpbin.org`, execution `104711` (a separate Telegram message minutes later) called `GET /cookies` with the same domain and got `{"freddy": "test2"}` back. The v1 keep-alive design works end-to-end; persistent logins are real, just bounded by container lifetime.
- **Interactive 2FA round-trip** — execution `104757` logged into github.com with username + password, hit the 2FA wall, returned cleanly with `success=true, status=completed` and a focused "send me the code" message. 90 seconds later execution `104760` entered the 6-digit code on the still-open form, GitHub redirected to the dashboard. Execution `104763` then starred `browser-use/browser-use` as the authenticated user (35 s, 3 steps), execution `104776` listed the real GitHub notifications inbox (26 s, 2 steps). PAT-as-password (execution `104741`) hit the 2-min timeout because PATs aren't valid UI-login credentials on github.com — documented as the wrong shape for this flow.
- **Long multi-step browse + summarise** — execution `104780`: top 5 HN stories with article-content summaries. 12 steps, 206 s, 5 different external sites opened, accurate 2-sentence summary each.
- **Mandatory Chromium args** — `--no-sandbox --disable-dev-shm-usage --disable-gpu` plus `chromium_sandbox=False`. Without these the browser launch times out at 30 s on a headless Linux VPS. Hardcoded in `session_pool.py BROWSER_PROFILE_KWARGS` so the agent and the docker-compose env never need to know about them.
- **LLM-provider follow-through** — bridge reads `tools_config.llm_provider` on each `POST /tasks` and instantiates the matching `browser_use.llm.Chat*` class with the corresponding env-supplied key. Falls back to Anthropic Claude Sonnet 4.6 if `tools_config` is unreachable. Switching providers does not require a bridge restart.

### Known limitations

- **Anti-bot-protected sites are out of scope.** Doctolib was the smoke test: two attempts (executions `104714` at 120 s and `104731` at 180 s), both timed out before reaching the appointment slots. Open-source headless Chromium without a residential-proxy network gets fingerprinted and slow-walked by serious bot detection (Cloudflare Bot Management, Datadome, etc.). Skyvern's Cloud product solves this with residential proxies + anti-bot fingerprint randomisation; open-source Skyvern hits the same wall. Plain Mainstream sites without aggressive detection (GitHub, Hacker News, jens.marketing, httpbin, Substack-style forms) work fine.
- **Hardware-key 2FA / WebAuthn / passkeys are not supported.** Interactive 2FA covers TOTP, SMS code, and email-magic-link — anything where the second factor is a string the user can paste. WebAuthn requires a physical USB device the bridge cannot present.
- **Sessions are in-memory only.** Container restart (or `setup.sh --force`) wipes every pooled browser. Persistence-across-reboots needs Browser Use to fix `save_storage_state` (Issue #1002) — until then, expect to re-authenticate on each fresh deploy. The 30-min idle eviction also kills idle sessions inside one container lifetime; pick a `domain` and call back within half an hour or be ready to log in again.
- **GitHub Personal Access Tokens are not valid UI-login passwords.** PATs work for `git push` over HTTPS and for the REST API, not for `github.com/login`. Use real password + interactive 2FA instead — that's the validated path.
- **CAPTCHAs.** No solver. If a CAPTCHA appears the bridge returns the screenshot URL and asks the user to handle it (same flow as 2FA in principle, but Browser Use 0.12.6 doesn't surface CAPTCHAs as cleanly as it does 2FA prompts — your mileage may vary).

### Resource impact

- **~500 MB – 1 GB RAM per active browser session.** At the 5-session pool cap, expect up to ~3 GB peak. The `mem_limit: 3g` on the service is a hard ceiling. VPS recommendation stays at 2 GB minimum (idle bridge is ~200 MB; the heavy footprint only materialises while a task is running).
- **Container image is ~1.5 GB** (Python 3.12-slim base + Playwright + Chromium binary). One-time build; rebuilds via Docker layer cache are fast.
- **LLM-token usage** — typical task is 4–12 LLM round-trips with vision-enabled prompts (~5–20k tokens per round-trip including screenshot). Newsletter signup costs roughly the same as a moderate-length conversation turn.

---

## [1.8.0] — 2026-05-11

### Apify Actors — 6,000+ web scrapers via a single MCP bridge

n8n-claw gets dynamic, instance-wide access to the entire Apify Store: **Apify Actors**, a bridge skill that wraps `https://mcp.apify.com` and exposes 8 meta-tools to the agent. The agent uses `search-actors` to discover scrapers by platform keyword, `fetch-actor-details` to read each Actor's live JSON input schema, and `call-actor` to execute any of the 6,000+ Actors in the Store — Google Maps places, Instagram posts, Trustpilot reviews, Booking.com hotels, LinkedIn profiles, Amazon bestsellers, you name it — without writing a single line of per-Actor glue code. End-to-end validated on 2026-05-11 against a real Apify token (execution 103944: agent → search-actors → fetch-actor-details → call-actor → parsed dataset → 4 real Instagram comments formatted as a markdown table for Telegram, 101 seconds for the whole chain).

This is the **first production bearer-auth MCP bridge** in n8n-claw. The previous (and only) bridge skill, `deepwiki`, ran with `auth_type: "none"`. The bearer-auth code path — `mcp_registry.auth_type` + `auth_token` written by the credential form, then read by the agent's inline `MCP Client` toolCode and injected as `Authorization: Bearer <token>` on every JSON-RPC call to the upstream MCP server — was wired since migration `006_mcp_bridge` in v1.3.0 but had never been exercised end-to-end. Apify exercises it now. No code patches were needed in `mcp-client.json`, `mcp-library-manager.json`, or `n8n-claw-agent.json` to ship this skill: the infrastructure was already there.

One subtle gotcha showed up after the first install and got fixed in a v1.0.1 bump of the manifest description: Claude, given the choice between the proper discovery chain (`search-actors` → `fetch-actor-details` → `call-actor`) and the pre-bundled `apify--rag-web-browser` meta-tool, sometimes reached for `rag-web-browser` because it's "just one call". The same regression had to be patched in the OpenWebUI-side Apify adapter. Fix on this side: a stronger workflow nudge in the manifest description that the Library Manager pulls into `mcp_registry.description` and the system prompt builder shows to the LLM on every turn — `apify--rag-web-browser` is now explicitly framed as a last-resort fallback, and the description routes plain webpage reads to Crawl4AI (Web Reader) and web search to SearXNG instead of paying Apify credits for either.

The catalog grows to **71 skills**.

### Added

- **Skill `apify`** (bridge, `utilities` category, Apify API Token required, 8 tools):
  - `search-actors` — discover Actors in the Apify Store by broad keyword (e.g. `instagram`, `google maps`, `tiktok`). Returns ranked Actor cards with name, description, pricing, usage stats, success rate, and rating. The mandatory first step in the discovery chain — the agent picks the best-rated specialised scraper for the platform instead of guessing Actor names.
  - `fetch-actor-details` — get full metadata for a specific Actor (`username/name` format): JSON input schema, README summary, pricing breakdown, output schema, deprecation status. Always called before `call-actor` so the agent reads the live input spec instead of inventing it.
  - `call-actor` — run any Actor synchronously or asynchronously. Sync returns `datasetId` plus preview items inline; async returns a `runId` for long-running scrapes. Supports `callOptions.memory` (128 MB – 32 GB) and `callOptions.timeout` for resource control. For MCP-server Actors uses the `actorName:toolName` invocation format.
  - `get-actor-run` — check status and metadata of a specific Actor run by `runId` (timestamps, stats, dataset reference) — used to poll async runs before fetching output.
  - `get-actor-output` — fetch dataset items from a completed Actor run. Supports `fields` (comma-separated, with dot notation like `crawl.statusCode`) and `offset` + `limit` for pagination, so the agent can pull large scrapes piece by piece without blowing the LLM context.
  - `search-apify-docs` — full-text search over Apify Platform / Crawlee-JS / Crawlee-Python documentation (`docSource` parameter switches between them). Returns matching URLs + content snippets.
  - `fetch-apify-docs` — fetch the full markdown content of a documentation page by URL.
  - `apify--rag-web-browser` — pre-bundled web browser Actor for one-shot Google-search-and-scrape. **Framed as a last-resort fallback** in the manifest description; the agent is steered toward Crawl4AI (Web Reader) for plain page reads and SearXNG (Web Search) for general queries instead.

- **`n8n-claw-templates/templates/apify/manifest.json`** — bridge manifest at the templates repo:
  - `type: "bridge"`, `bridge.mcp_url: "https://mcp.apify.com"`, `bridge.auth_type: "bearer"`, `bridge.auth_token_required: true`. The Library Manager's bridge-install branch detects `manifest.type === 'bridge'`, skips workflow import entirely, inserts one row into `mcp_registry` with `template_type='bridge'`, and generates a one-time `credential_tokens` link for the secure HTTPS credential form.
  - `credentials_required[].key = "auth_token"` is the magic key the credential form mirrors into `mcp_registry.auth_token` after submission (the only credential key that gets dual-written into both `template_credentials` and the registry's auth column). Reuse on reinstall: if `template_credentials` already has the token from a prior install, the new registry row picks it up without re-prompting.

- **`n8n-claw-templates/templates/index.json` + `README.md`** — catalog entry for `apify` under `utilities`, total skill count bumped from 70 → 71, Utilities section now lists Apify Actors as the lead row.

### Changed

- **`workflows/mcp-library-manager.json`**: `CDN_BASE` pinned to `freddy-schuetz/n8n-claw-templates@b522ae6` — the templates-repo commit shipping the apify skill plus the tool-selection nudge. Bumped in two steps during the v1.8.0 release: first to `@e164a65` (initial skill) in commit `e85528c`, then to `@b522ae6` (description fix) in commit `0d8c06a`.

- **Apify skill description (templates v1.0.0 → v1.0.1)** — strengthened the workflow guidance in the manifest description so the agent prefers the discovery chain over the `apify--rag-web-browser` shortcut. The Library Manager re-syncs this field from the manifest only on fresh install / reinstall (not via update_template — there is no update_template action today), so already-installed instances need a `remove_template` + `install_template` round-trip to pick up the new description. Existing token is reused via the `template_credentials` lookup in the install path, so no re-entry needed.

### Validated

- **Apify MCP endpoint** — `https://mcp.apify.com` (no `/mcp` suffix), Streamable HTTP transport (MCP protocol `2024-11-05`), SSE-formatted JSON-RPC responses (`event: message` / `id: …` / `data: {…}` framing). Bearer auth via `Authorization` header confirmed working with a real token. Tool names use dashes, not snake_case (`search-actors`, `fetch-actor-details`, `call-actor`, `apify--rag-web-browser`) — passed through verbatim by the agent's MCP Client toolCode without rewriting.
- **End-to-end production test** — execution `103944` on 2026-05-11: user message "Suche mir die letzten 10 Kommentare von dem Instagram Kanal ep_reisen, kein Zwischenstatus" → agent discovered the Instagram Actor via `search-actors`, inspected its input schema via `fetch-actor-details`, ran it via `call-actor`, parsed the returned dataset, formatted 4 real comments (with usernames, text, dates, like counts) as a Telegram-ready markdown table. Total runtime 101 seconds, 21 nodes green, no errors. First successful invocation of a bearer-auth bridge in n8n-claw.
- **Existing bearer-auth path through `n8n-claw-agent.json`** — the inline `MCP Client` toolCode (added in v1.3.0 but never used with a non-`none` auth_type until now) reads `auth_type` + `auth_token` from `mcp_registry` by the matching `mcp_url`, prepends `Bearer ` for `auth_type='bearer'` or uses the raw token verbatim for `auth_type='header'`, and injects the `Authorization` header into all three JSON-RPC roundtrips (initialize, notifications/initialized, tools/list for schema validation, tools/call). No edits required. The same toolCode also pre-fetches the upstream `tools/list` schema on each call and rewrites missing-required-args errors into schema-hint responses the LLM can self-correct from — which is why the agent recovers gracefully when it guesses `query` instead of `keywords` for `search-actors`.

### What you can ask Apify

After installing the skill, the agent routes Apify requests via `mcp_client`. The expected workflow is `search-actors` → `fetch-actor-details` → `call-actor`. Examples in natural language as you'd actually type them:

**Sales — on-the-fly lead enrichment, single contact:**
```
Just met Max from XY GmbH at the fair — get me his LinkedIn
```
Agent finds the profile, calls a LinkedIn Actor (e.g. `dev_fusion/Linkedin-Profile-Scraper`, ~$0.01 per profile), returns email + role + recent posts.

**Hospitality — competitor / partner hotel reviews:**
```
What are guests saying about Hotel Goldener Adler on Booking lately?
```
Agent picks `voyager/booking-reviews-scraper` (~$0.05 per 1,000 reviews), pulls the last batch, summarises rating trend + top complaints + top praise.

**Reputation — competitor monitoring on Trustpilot:**
```
What's the latest Trustpilot buzz about competitor X?
```
Agent uses `memo23/trustpilot-scraper-ppe` ($0.75 per 1,000 reviews, 4.86★), extracts the recent rating + recurring themes + red flags.

**E-commerce — daily bestseller intel:**
```
What's hot on Amazon DE Sports today?
```
Agent calls `junglee/amazon-bestsellers` (4.97★ in the Store), returns today's top-100 with prices and biggest movers. Schedulable via the existing `scheduled_actions` table for a fresh-every-morning digest.

### Known limitations

- **Single instance-wide token.** The Apify token lives in `mcp_registry.auth_token`, one row per installed bridge skill. There is no per-user-credential mechanism in `template_credentials` yet, so on multi-user instances (dmo-claw) every chat user consumes credits from the same Apify account and shares the same view of the data. A per-user-credential schema extension is plausible (`template_credentials.user_id` nullable + bridge-bearer-lookup priority "user-scoped first, then global") but out of scope for v1.8.0.
- **Manifest description is set once at install time.** Description text changes pushed to the templates repo (like the v1.0.0 → v1.0.1 tool-selection-nudge fix in this release) require a `remove_template` + `install_template` cycle on existing instances to land in `mcp_registry.description`. The Library Manager has no `update_template` action today. Token is preserved across the cycle.
- **`apify--rag-web-browser` is still in the tool list.** Hiding it via the manifest description (last-resort framing) is a behavioural nudge, not enforcement. Apify's MCP server exposes it unconditionally on `tools/list`, and the agent's MCP Client toolCode passes the name through verbatim if Claude does call it. The framing usually steers the agent away, but does not guarantee it.

---

## [1.7.0] — 2026-05-10

### Fitness Buddy — a personal trainer that owns the data layer, not just the chat

n8n-claw gets a real fitness coach skill: **Fitness Buddy**. Not a chat persona that pretends to track meals — a 14-tool MCP skill backed by 9 dedicated PostgreSQL tables that owns every meal, workout, body measurement, hydration log, goal, and training session. Voice transcripts are parsed via OpenAI gpt-4o-mini structured-output, meal photos go through gpt-4o-mini Vision with strict JSON-Schema for items + grams + confidence, and the multi-week training plan generator picks exercises from real wger.de IDs (verified live: 845 exercises in the anonymous `/exerciseinfo/` endpoint, no auth, no LLM hallucination on the exercise list).

Companion read-only skill **wger Exercises** ships alongside — a thin wrapper around wger.de's anonymous exercise database (search, get, list categories/muscles/equipment), useful standalone for browsing exercises without going through Buddy. Catalog grows to **70 skills** with a new `health` category.

Three small but important infrastructure additions came out of building this:

**The OpenAI key gets pre-seeded.** Most users already configured `OPENAI_API_KEY` during `setup.sh` (it powers Whisper voice transcription and the agent's photo analysis). Asking them to re-enter it via the credential form when installing fitness-buddy was annoying. setup.sh now writes `OPENAI_API_KEY` into `template_credentials` (template_id=`fitness-buddy`, cred_key=`openai_api_key`) automatically — installing the skill is a one-shot, no second key entry. Library Manager also got smarter: the "skip credential-form when cred is already stored" check used to fire only for OAuth shared credentials; it now fires for any credential, so any future skill that wants to reuse a setup-time key gets the same free pre-seed treatment.

**A dedicated `fitness_routing` system-prompt section.** Initial test runs revealed the agent was happily generating fake plans — sometimes by improvising a 12-question onboarding questionnaire ("schmeiß alles auf einmal rein, ich sortier dat dann"), sometimes by delegating "create a training plan" to the research-expert sub-agent which then web-searched a generic plan and presented it as if it came from Buddy. Nothing landed in `fitness_plans`. The skill description alone, buried inside the long `mcp_instructions` skill listing, wasn't strong enough to compete with these alternative routes. Fix: a new top-level `agents.fitness_routing` system-prompt key seeded by setup.sh that explicitly forbids fabrication, forbids delegation to research-expert, forbids Web Search / HTTP fallbacks for fitness topics, and documents the empty-string-for-unknowns call convention (next paragraph).

**The empty-string-for-unknowns call convention.** n8n's mcpTrigger node generates the external MCP tool schema with **all** non-hardcoded `value` fields marked as `required` in the `tools/list` response — regardless of whether the corresponding `schema` array entry has `"required": false`. The flag is silently ignored. So an agent calling `fitness_profile` with just `{sub_action: "setup"}` was rejected by mcp_client validation: *"missing required args [sex, birthdate, height_cm, …, notes]"*. Workaround in the tool description: instruct the agent to include every parameter on every call, using `""` for fields the user has not provided yet. The skill's setup logic already skipped empty strings (`input[f] !== ''`), so multi-turn onboarding works unchanged once the call validates. Documented as a quirk for future MCP skills — wger templates would have hit the same wall if they hadn't been removed (the `/public-templates/` endpoint turned out to be auth-required, not anonymous as the API root listing suggested).

### Added

- **Skill `fitness-buddy`** (14 tools, `health` category, OpenAI API Key required):
  - `fitness_profile` — step-by-step conversational onboarding. The skill drives a multi-turn dialog: agent calls with `sub_action='setup'` and any fields the user has provided, skill saves partial progress to `fitness_profile`, replies with the next single question (one of: sex, birthdate, height_cm, weight_kg_baseline, activity_level, goal). Agent forwards the question verbatim to the user, gets the answer, calls again. Mifflin-St-Jeor BMR × Activity-Multiplier × Goal-Modifier → daily kcal target; protein 1.6–2.2 g/kg LBM (depending on goal), fat 0.9 g/kg, carbs from remainder; hydration 35 ml/kg.
  - `log_meal` — five input modes: `from_text` ("100g Haferflocken, 200ml Milch, 1 Banane"), `from_voice` (Whisper transcript), `from_photo` (file_ref → gpt-4o-mini Vision with strict JSON-Schema for items + grams + per-item confidence + overall confidence), `from_barcode` (EAN), `from_memory` (one-click re-log of a saved meal_memory). Items resolve via OpenFoodFacts barcode lookup → OFF name search → LLM nutrition estimate fallback. Totals denormalized to columns for fast `SUM()`-by-day. Plus `edit`, `delete`, `clear_day`.
  - `meal_memory` — save frequently eaten meals as named templates ("Mein Standard-Frühstück") for one-click re-logging. After each meal log, the skill checks if the same item-set was logged ≥3× in the last 14 days and suggests promotion to memory.
  - `suggest_meal` — gpt-4o-mini takes today's remaining macro budget (calculated from `fitness_meals` SUM minus profile target), the user's allergies + dietary restrictions, plus their top-10 meal-memory favorites, and returns 3 suggestions with macros that fit. Prefers favorites when they match the budget.
  - `log_workout` — auto-extracts `exercise_type | duration_min | intensity | distance_km | perceived_exertion` from text or voice transcript via gpt-4o-mini structured-output. Calorie burn estimated via MET formula (running medium = 9 MET, strength medium = 5 MET, etc.) × profile weight × duration. Auto-links to today's planned `fitness_plan_session` if one exists and is unmarked complete; auto-updates active `workout_frequency` goals.
  - `log_body` — weight, body fat %, muscle mass, waist/chest/hip/thigh/arm circumferences. `trend` action computes change from first to last entry over a configurable window (default 30 days).
  - `log_hydration` — water intake in ml. `today` shows progress vs target. `set_target` overrides the default 35ml/kg calculation.
  - `goals` — set/list/archive. Goal types: `weight | body_fat | workout_frequency | distance | strength | habit | streak`. `current_value` auto-updates as relevant logs come in.
  - `summary` — `today` / `week` / `month`. Aggregates kcal/macros/workouts/hydration vs targets, plus a streak count (consecutive days with at least one meal or workout, computed via reverse-walk over distinct dates).
  - `training_plan` — `generate_custom` is the marquee feature: fetches 80 real exercises from wger.de's `/exerciseinfo/` endpoint (anonymous, free), packs them into the LLM prompt as `#1962 Step Jack [Cardio|none|Quads]`, instructs gpt-4o-mini to pick 4–6 exercises per session and reference them by `wger_id`, plus apply progressive overload across weeks and a deload in the final week if `weeks ≥ 4`. JSON-Schema strict-mode enforces structure; the result is decomposed into `fitness_plans` (one row, status=active, only one active plan per user enforced via partial unique index) and `fitness_plan_sessions` (one row per session, with `planned_for` date so "what's on today" is an indexed query). Plus `today`, `get_active`, `complete_session`, `adjust`. Verified live on 2026-05-10: every exercise in a generated plan resolved to a real wger ID.
  - `reminders` — three presets (`morning_meal`, `evening_summary`, `weekly_report`) that insert into the existing `scheduled_actions` table. Heartbeat fires them; agent receives the instruction and routes back to the appropriate fitness-buddy tool. Custom recurring reminders work too via the main agent's existing `Reminder` workflow — both paths land in the same table, both fired by the same Heartbeat.
  - `insights` — periodic pattern detection. `analyze` aggregates 30 days of meals/workouts/body data, sends it to gpt-4o-mini, gets back 3–5 actionable insights with importance scores, writes to `memory_long` with `category='insight'`, `entity_name='fitness'`. The main agent's existing v1.5.0 insight-loading machinery picks them up automatically — top-3 by importance get added to every system prompt.
  - `export` — CSV export of meals/workouts/body/hydration over a date range. Writes the CSV through the File Bridge and returns a `file_ref` so the agent can send it as a Telegram document. Useful for doctor visits or own analyses.
  - `nutrition_lookup` — standalone OpenFoodFacts barcode/name lookup without logging.

- **Skill `wger-exercises`** (7 tools, `health` category, no credentials):
  - `search_exercises` (filter by muscle ID / equipment ID / category / name / language / limit), `get_exercise` (full details by ID), `list_categories`, `list_muscles`, `list_equipment`, `list_public_templates`, `get_template_detail`. The last two return a clear "use generate_custom in fitness-buddy instead" message because wger's `/public-templates/` endpoint is auth-protected (HTTP 403 to anonymous callers — discovered live during integration testing) — kept as endpoints for future re-enabling if wger ever opens them.

- **`supabase/migrations/008_fitness_schema.sql`** — 9 tables, idempotent, wired into the existing migration loop in `setup.sh` after `007_pg17_compat`. All tables scoped via `user_id text NOT NULL` (matching the `tasks`/`reminders` pattern, port-ready for multi-user dmo-claw later).
  - `fitness_profile` (1 row per user, computed targets persist), `fitness_meals` (with denormalized totals + jsonb item-array), `fitness_meal_memory` (UNIQUE on `user_id, name`), `fitness_workouts`, `fitness_body` (time-series), `fitness_hydration`, `fitness_goals` (self-referencing parent_id for sub-goals), `fitness_plans` (partial unique index `WHERE status='active'` to enforce one active plan per user), `fitness_plan_sessions` (FK to plan, indexed on `(user_id, planned_for)` for the today-query). PostgREST `GRANT ALL` to anon/authenticated/service_role same as the rest of the schema. Final `NOTIFY pgrst, 'reload schema';` so the new tables are reachable via REST immediately.

- **`agents.fitness_routing` system-prompt key** — seeded by `setup.sh` alongside the existing `mcp_instructions` / `tools` / `task_management` keys. Documents which user phrases route to which fitness-buddy tool with which `sub_action`, the empty-string-for-unknowns call convention, and the explicit forbidden alternatives (no expert_agent, no Web Search, no fabrication on skill error). Loaded as its own top-level `## fitness_routing` section in the system prompt of every agent turn.

- **Pre-seeded `OPENAI_API_KEY` in `template_credentials`** — `setup.sh` now writes the key (when configured) under `template_id='fitness-buddy', cred_key='openai_api_key'` via `INSERT … ON CONFLICT DO UPDATE`. Idempotent across `--force` re-runs. Uses dollar-quoted SQL (`$$…$$`) so arbitrary key characters can't break the statement. Silent-fails so a missing table or psql error does not abort setup.

### Changed

- **`workflows/mcp-library-manager.json`**: the credential-skip check during `install_template` no longer fires only for OAuth `shared_id` credentials. It fires for any credential — first checking `template_credentials` for `(storeUnder, cred_key)` where `storeUnder = shared_id || templateId`, and skipping the credential-form-link generation if a row already exists. Picks up pre-seeded keys (the new fitness-buddy use case) and any future skill that wants the same pattern. Side effect: re-installing a skill after `remove_template` reuses the previously stored credential rather than re-prompting (consistent with current OAuth behavior; `add_credential` action remains the explicit override path).
- **`workflows/mcp-library-manager.json`**: `CDN_BASE` pinned to `freddy-schuetz/n8n-claw-templates@2ca2ee5` — the templates-repo commit shipping fitness-buddy + wger-exercises + the OpenAI strict-mode schema fix.
- **`setup.sh`**: applies migration 008 after the existing migrations; pre-seeds `OPENAI_API_KEY` into `template_credentials` for fitness-buddy; seeds the `fitness_routing` agents key alongside the existing keys.
- **`CLAUDE.md`**: 9 new `fitness_*` tables documented in the database-schema table; migrations list extended.

### Fixed

These came up during build/live-test of fitness-buddy and are bundled in this release:

- **OpenAI structured-output schemas were rejected with HTTP 400 in nested objects.** Strict mode requires every property to appear in the `required` array — making a property semantically optional is done via a `[type, "null"]` union *plus* the property still being required (the LLM is then allowed to return `null`). The first-cut training_plan schema had `wger_id`, `weight_kg`, `rest_s`, `notes` typed as `[type, "null"]` but missing from `required`, and the same latent bug was in the log_workout schema (`distance_km`, `perceived_exertion`, `notes`). Fix: every property is now in `required` across all structured-output calls in the skill (training_plan, log_meal photo, log_meal text, log_workout, suggest_meal, insights, llmEstimateNutrition).
- **OpenAI errors were being swallowed as "Request failed with status code 400".** The `helpers.httpRequest` axios error didn't propagate the response body, so the actual OpenAI validation message ("Invalid schema for response_format … 'extracted': Every property in object schema must be in the required array") was lost. Fix: `openaiChat()` wraps the call in try/catch, extracts `err.response?.body` or `err.body`, and re-throws with the actual error in the message. Debugging structured-output regressions now surfaces the real reason instead of an axios placeholder.
- **The agent fabricated training plans / onboarding questionnaires on the first integration tests.** Two distinct routes: (a) the agent saw "Profil anlegen" and improvised a 12-field questionnaire instead of calling `mcp_client → fitness-buddy`, (b) the agent saw "training plan" and delegated to the research-expert sub-agent which web-searched a generic plan. Neither path stored anything in `fitness_plans` or `fitness_meals`. Fix: the new `fitness_routing` system-prompt section explicitly forbids both — agent must call mcp_client → fitness-buddy for any fitness topic; on skill error it must surface the error verbatim and never fabricate or fall back to research-expert / Web Search / HTTP. Verified post-fix: the 4-Week Recomp Training Plan generated on 2026-05-10 stored 12 sessions in `fitness_plan_sessions`, every exercise carried a real `wger_id` (#1963 Slow Squat, #980 Commando Pull-ups, #805 Tricep Pushdown on Cable, #923 Lying Dumbbell Row SS Seated Shrug — all verified against wger.de's live API).

### What you can ask Buddy

After installing the skill, you can talk to it in natural language via Telegram. The agent routes everything via mcp_client → fitness-buddy. Examples:

**Profile setup (step-by-step, Buddy drives):**
```
ich möchte mein Profil anlegen
```
Buddy asks one thing at a time (sex → birthdate → height → weight → activity level → goal), then shows the computed daily kcal/macro/hydration targets.

**Logging meals — three input modes:**
```
Frühstück: 100g Haferflocken, 200ml Milch, 1 Banane
```
```
[send a photo of your plate + caption "Mittag"]
```
```
[voice message: "Abendessen war Hähnchenbrust mit Reis und Brokkoli"]
```
Buddy resolves nutrition via OpenFoodFacts (barcode → name → LLM-fallback for generics), shows per-item kcal/macros + total, asks for confirmation when vision confidence is low.

**Logging workouts:**
```
[voice: "Bin grad 30 Minuten joggen gewesen, mittlere Intensität"]
```
```
30 Min Krafttraining im Gym, hoch intensiv
```
Buddy auto-extracts type/duration/intensity, computes calorie burn via MET formula × your weight, links to today's planned session if one exists.

**Body & hydration:**
```
Log mein Gewicht: 78 kg, Bauchumfang 84 cm
```
```
500 ml Wasser getrunken
```
```
Wasser-Tagesziel auf 3000 ml setzen
```

**Training plan (real wger exercises, no LLM hallucinations):**
```
Erstell mir einen 4-Wochen-Plan für Muskelaufbau, 3x pro Woche, im Fitnessstudio
```
Buddy generates a periodized plan with progressive overload + deload week, picks exercises from the live wger.de database, stores 12 sessions with real exercise IDs.

```
Was steht heute auf dem Trainingsplan?
```
Returns today's planned session with sets × reps and rest periods.

**Coaching & summaries:**
```
Wie liege ich heute?
```
Today's kcal/macros/workouts/water vs targets + active streak.

```
Schlag mir was zum Abendessen vor das zu meinen Restmakros passt
```
Three meal options matching remaining macro budget, respecting allergies + dietary restrictions, preferring your meal-memory favorites.

**Goals:**
```
Setz mir ein Ziel: 4 Workouts pro Woche
```
```
Welche Ziele hab ich?
```

**Recurring reminders (custom or preset):**
```
Setup mir alle Buddy-Reminders
```
Three presets: morning meal nudge (08:00), daily summary (21:00), weekly report (Sun 19:00).

```
Buddy, geh täglich um 9:30 mit mir den Tagesplan durch — Training, Kalorien, was steht heute an
```
Custom free-form recurring action via the main agent's Reminder workflow — same `scheduled_actions` infrastructure, fired by the same Heartbeat.

**Standalone food lookups:**
```
Such mir die Nährwerte von Nutella
```
OpenFoodFacts result with kcal/macros per 100g, no logging.

**Export:**
```
Exportier meine Mahlzeiten der letzten 7 Tage als CSV
```
CSV uploaded to File Bridge, Telegram document arrives.

**After 14+ days of logs — pattern detection:**
```
Buddy, was fällt dir bei meinen Daten auf?
```
LLM analyzes recent log patterns, writes 3–5 insights to `memory_long` with `category='insight'` — the main agent's v1.5.0 insight-recall picks them up automatically and uses them to shape future responses (silently, no quoting back).

### Upgrade from v1.6.0

```bash
cd n8n-claw && git pull && ./setup.sh --force
```

Migration 008_fitness_schema.sql applies idempotently (9 new `fitness_*` tables). No conflicts with existing data. The `fitness_routing` agents key is seeded automatically. If `OPENAI_API_KEY` is configured in your `.env`, it is pre-seeded into `template_credentials` for fitness-buddy.

Then in Telegram:
```
Installiere fitness-buddy
```
No credential-form prompt if your OpenAI key is pre-seeded. Optional companion:
```
Installiere wger-exercises
```

For users who do **not** want the fitness skills: nothing changes — the 9 `fitness_*` tables stay empty (negligible storage), the `fitness_routing` system-prompt key is benign when the skill isn't installed (the routing rule will trigger an informative error if you do try to log a meal without installing).

---

## [1.6.0] — 2026-04-30

### PostgreSQL 17 by default — and a one-shot migration for existing installs

Supabase's platform support for PostgreSQL 15 winds down around May 2026; the PostgreSQL community drops PG15 in November 2027. Time to move. Fresh n8n-claw installs now ship on PostgreSQL 17.6 directly, and existing PG15 instances get an explicit `./setup.sh --upgrade-pg17` command that handles the data migration in one shot.

The right answer for n8n-claw turned out to be `pg_dump` + restore into a fresh PG17 cluster — not in-place `pg_upgrade`. Supabase's official `upgrade-pg17.sh` is tightly coupled to their full self-host stack (vault encryption, `db-config` Docker volume, pgsodium key) which n8n-claw doesn't ship. Trying to use it hard-fails in pre-flight. The dump/restore path is also a better fit for n8n-claw's typical scale: small DBs (< 1 GB), simple schema, no cross-schema triggers. The whole migration takes 3–5 minutes, original PG15 data is preserved as `./volumes/db/data.bak.pg15` for instant rollback, and the pipeline was validated end-to-end on a 286 MB live instance before shipping.

The interesting part wasn't pg_dump/restore itself — it was that the supabase/postgres:17 image's baked-in init scripts create a `pg_graphql` extension whose DDL event trigger fires on every CREATE/DROP. With thousands of statements in a real restore that means tens of thousands of trigger fires, and supautils eventually `pg_terminate_backend()`s the restore session mid-flight. The wrapper sidesteps that by mounting our own `supabase/migrations` into `/docker-entrypoint-initdb.d`, which suppresses the baked-in init entirely. Our `000_extensions.sql` and `001_schema.sql` create the same role layout the original PG15 has (postgres + supabase_admin + anon + authenticated + service_role + uuid-ossp + vector + unaccent), and pg_graphql / supautils never enter the picture.

### Added

- **`utils/upgrade-pg17.sh`** — 440-line wrapper that handles the full migration: pre-flight checks (PG version, disk space `3× DB + 2 GB`, incompatible extensions, replication slots, leftover-artefact detection), `pg_dump --clean --if-exists` from the running PG15, named-volume backup to a host bind dir, fresh PG17 cluster start via `docker run` (NOT compose, with our migrations mounted to suppress baked-in pg_graphql + `POSTGRES_USER=postgres` matching docker-compose.yml), restore via Unix socket, post-restore sanity check on `public.soul` row count, switch to compose with PG17 image, full-stack restart, verification. Hard-fails on `connection refused` patterns instead of swallowing them as harmless. Built-in rollback path printed in every error message.
- **`./setup.sh --upgrade-pg17`** — new flag, dispatches to the wrapper above. Argument-forwarded so `--upgrade-pg17 --yes` works for unattended runs.
- **`supabase/migrations/007_pg17_compat.sql`** — `ALTER FUNCTION public.immutable_unaccent(text) SET search_path = public, pg_catalog`. Pre-empts PG17's safe-search_path enforcement during maintenance ops (REINDEX, REFRESH MATERIALIZED VIEW, VACUUM) on the GIN index over `memory_long.search_vector`. Idempotent and safe under PG15, runs as part of the standard migration loop in `setup.sh` so fresh installs are forward-compatible too.
- **README "Postgres 17 Upgrade" section** — disk-space requirements, snapshot recommendation, exact commands, full rollback procedure.

### Changed

- **`docker-compose.yml`**: db image bumped from `supabase/postgres:15.8.1.085` to `supabase/postgres:17.6.1.063`. Fresh installs land on PG17 directly.
- **`hosting/hostinger.md`**: stack table reflects PG17 as the default.
- **`.gitignore`**: adds `docker-compose.override.yml`, `docker-compose.pg17.yml`, `volumes/`. The override file is generated by `--upgrade-pg17` to pin the PG17 image after migration; staying gitignored means it doesn't conflict with future `git pull`s.

### Fixed

- **`setup.sh` would have crashed existing PG15 instances on the next `git pull && ./setup.sh`.** With docker-compose.yml's default image flipped to PG17, an unprepared update would let docker compose recreate the db container with the new image, which then refuses to start with `FATAL: database files are incompatible with server`. Fixed: in update mode, `setup.sh` now reads `/data/PG_VERSION` from the existing `n8n-claw_db_data` volume, compares to the major version in `docker-compose.yml` (and any `docker-compose.override.yml`), and aborts with a clear message routing the user to `./setup.sh --upgrade-pg17` if they don't match. Existing PG17 instances (post-migration, with override file) match cleanly and proceed normally.

### Breaking changes

None for users. Existing PG15 users see a friendly error on the next update telling them exactly which command to run; their data stays online on PG15 until they decide to migrate. The community PG15 EOL isn't until November 2027, so no rush — but Supabase's image updates will increasingly focus on PG17 from Q2/2026 onwards, which is why the default flipped now.

### Upgrade from v1.5.0

**Existing installations (currently on PG15):**
```bash
cd n8n-claw && git pull
sudo ./setup.sh --upgrade-pg17        # one-shot data migration (3–5 min downtime)
```
A VM-level snapshot before running is recommended. The original PG15 data directory is preserved as `./volumes/db/data.bak.pg15` — keep it for 2–3 days while you verify, then `sudo rm -rf` it.

**Fresh installs:**
```bash
git clone https://github.com/freddy-schuetz/n8n-claw.git
cd n8n-claw && sudo ./setup.sh
```
Lands on PG17 directly. No special command, no override files.

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
