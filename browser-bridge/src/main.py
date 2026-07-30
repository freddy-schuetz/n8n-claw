"""browser-bridge FastAPI service.

Wraps the Browser Use SDK as a REST API so n8n workflows can drive agentic
browser tasks. Uses a keep-alive session pool keyed by (user_id, domain) to
work around Browser Use 0.12.6 Issue #1002 (storage_state save broken).
"""
from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import Optional

from browser_use import Agent
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import browser_use

from .llm import build_llm, fetch_active_provider
from .session_pool import SessionPool, extract_domain

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("browser-bridge")

pool = SessionPool()


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("browser-bridge starting (browser_use=%s)", getattr(browser_use, "__version__", "unknown"))
    yield
    n = await pool.close_all()
    log.info("browser-bridge shutdown: closed %d sessions", n)


app = FastAPI(title="browser-bridge", version="0.1.0", lifespan=lifespan)


class TaskRequest(BaseModel):
    user_id: str = Field(..., description="Qualified user id, e.g. telegram:1810565648")
    task: str = Field(..., min_length=1, description="Natural-language task description")
    url: Optional[str] = Field(None, description="Optional starting URL")
    domain: Optional[str] = Field(None, description="If set, session is pooled for reuse on this domain")
    max_steps: int = Field(25, ge=1, le=100)
    # Lower bound is 120s, not 10s: Chromium alone may take up to
    # BROWSER_BRIDGE_START_TIMEOUT_MS (120s) to come up, inside this budget.
    timeout_s: int = Field(300, ge=120, le=900)


class TaskResponse(BaseModel):
    status: str
    result: Optional[str] = None
    elapsed_s: float
    n_steps: Optional[int] = None
    session_persisted: bool
    domain: Optional[str] = None
    error: Optional[str] = None


@app.get("/health")
async def health():
    return {
        "ok": True,
        "browser_use_version": getattr(browser_use, "__version__", "unknown"),
        "active_sessions": sum(1 for _ in pool._entries),
    }


async def _run_agent(session, llm, task_text: str, max_steps: int, budget_s: float):
    """Run one agent attempt against a session. Raises on timeout or failure."""
    agent = Agent(
        task=task_text, llm=llm, browser_session=session,
        use_vision=True, step_timeout=min(int(budget_s), 180),
    )
    return await asyncio.wait_for(agent.run(max_steps=max_steps), timeout=budget_s)


def _history_to_response(history, domain, t0) -> TaskResponse:
    is_done = history.is_done() if hasattr(history, "is_done") else None
    n_steps = len(history.history) if hasattr(history, "history") else None
    raw_final = history.final_result() if hasattr(history, "final_result") else None
    final = str(raw_final) if raw_final is not None else None
    has_errors = history.has_errors() if hasattr(history, "has_errors") else False
    # Surface model-level failures (e.g. all LLM calls 401'd) as `failed`
    # instead of silently reporting `incomplete` with result=None.
    if not is_done and has_errors:
        status, error_msg = "failed", (
            "Agent stopped due to repeated LLM errors — check bridge logs (auth, rate limit, model name)"
        )
    else:
        status, error_msg = ("completed" if is_done else "incomplete"), None
    return TaskResponse(
        status=status, result=final, elapsed_s=round(time.time() - t0, 1), n_steps=n_steps,
        session_persisted=(domain is not None), domain=domain, error=error_msg,
    )


@app.post("/tasks", response_model=TaskResponse)
async def run_task(req: TaskRequest):
    t0 = time.time()
    domain = extract_domain(req.domain) or extract_domain(req.url)

    # Build the LLM BEFORE touching the pool: a broken provider config used to
    # occupy one of the MAX_SESSIONS slots with a session that never started.
    cfg = await fetch_active_provider()
    try:
        llm = build_llm(cfg)
    except Exception as e:
        return TaskResponse(
            status="failed", elapsed_s=round(time.time() - t0, 1),
            session_persisted=False, domain=domain,
            error=f"LLM provider unavailable ({cfg.provider}): {e!r}",
        )

    task_text = req.task
    if req.url and req.url not in task_text:
        task_text = f"{task_text}\n\nStarting URL: {req.url}"

    session, reused = await pool.get_or_create(req.user_id, domain)
    try:
        try:
            history = await _run_agent(session, llm, task_text, req.max_steps, req.timeout_s)
            return _history_to_response(history, domain, t0)
        except asyncio.TimeoutError:
            return TaskResponse(
                status="timed_out", elapsed_s=round(time.time() - t0, 1),
                session_persisted=(domain is not None), domain=domain,
                error=f"Task exceeded timeout_s={req.timeout_s}",
            )
        except Exception as e:
            # A pooled session whose Chromium died (OOM kill, crash) is handed
            # out unchanged by the pool. Drop it and try once with a fresh one,
            # provided enough of the budget is left to be worth it.
            remaining = req.timeout_s - (time.time() - t0)
            if reused and domain is not None and remaining >= 60:
                log.warning("Reused session for %s failed (%r) — recreating and retrying once", domain, e)
                await pool.close(req.user_id, domain)
                session, _ = await pool.get_or_create(req.user_id, domain)
                try:
                    history = await _run_agent(session, llm, task_text, req.max_steps, remaining)
                    return _history_to_response(history, domain, t0)
                except asyncio.TimeoutError:
                    return TaskResponse(
                        status="timed_out", elapsed_s=round(time.time() - t0, 1),
                        session_persisted=True, domain=domain,
                        error=f"Task exceeded timeout_s={req.timeout_s} (after session recreate)",
                    )
                except Exception as e2:
                    log.exception("Task failed after session recreate")
                    return TaskResponse(
                        status="failed", elapsed_s=round(time.time() - t0, 1),
                        session_persisted=True, domain=domain, error=repr(e2),
                    )
            log.exception("Task failed")
            return TaskResponse(
                status="failed", elapsed_s=round(time.time() - t0, 1),
                session_persisted=(domain is not None), domain=domain,
                error=repr(e),
            )
    finally:
        # Ephemeral sessions (no domain) are in no pool, so nothing would ever
        # stop them — on timeout the Chromium process used to stay alive forever.
        if domain is None:
            try:
                await session.stop()
            except Exception as e:
                log.warning("Error stopping ephemeral session: %s", e)


@app.get("/sessions/{user_id}")
async def list_sessions(user_id: str):
    return {"sessions": pool.list_for_user(user_id)}


@app.delete("/sessions/{user_id}/{domain}")
async def close_session(user_id: str, domain: str):
    closed = await pool.close(user_id, domain)
    if not closed:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"closed": True, "domain": domain}
