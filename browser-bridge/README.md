# browser-bridge

REST wrapper around [Browser Use](https://github.com/browser-use/browser-use) so n8n-claw workflows can drive agentic browser tasks (form fill, newsletter signup, click flows, logged-in actions).

## Why a wrapper

Browser Use ships as a Python SDK, not as a service. We need an HTTP surface n8n's HTTP Request node can call, plus a session pool to work around [Browser Use Issue #1002](https://github.com/browser-use/browser-use/issues/1002) (storage_state save is broken in 0.12.6 — we keep browsers alive in-memory instead).

## Endpoints

```
POST /tasks                          run a task (sync, waits for completion)
GET  /sessions/{user_id}             list active pooled sessions
DELETE /sessions/{user_id}/{domain}  close a pooled session
GET  /health                         liveness + browser_use version
```

### POST /tasks

```json
{
  "user_id": "telegram:1810565648",
  "task": "Sign up for the newsletter with email X",
  "url": "https://jens.marketing/",
  "domain": "jens.marketing",
  "max_steps": 25,
  "timeout_s": 300
}
```

If `domain` is set, the browser session is **pooled** and reused by subsequent tasks with the same `(user_id, domain)` — that's how "save my login" works.
If omitted, the session is ephemeral.

## Session pool

- Keyed by `(user_id, domain)`
- Max 5 concurrent (`BROWSER_BRIDGE_MAX_SESSIONS`)
- Auto-evicted after 30 min idle (`BROWSER_BRIDGE_IDLE_TIMEOUT_S`)
- LRU-evicted when pool full
- All sessions die on container restart (in-memory only, v1 limitation)

## LLM provider

Reads `tools_config.llm_provider` from PostgREST at task start so the bridge follows the same provider n8n-claw uses. Provider API keys are passed via docker-compose env from the host `.env`.

## Critical chromium args

`--no-sandbox --disable-dev-shm-usage --disable-gpu` and `chromium_sandbox=False` are mandatory on a headless server — without them the browser start times out (spike-validated).

## Local dev

```bash
docker compose up -d --build browser-bridge
docker logs -f n8n-claw-browser-bridge
curl http://localhost:3400/health   # if you exposed the port for dev
```

In production the service is container-internal only (`expose: 3400`, no host port).
