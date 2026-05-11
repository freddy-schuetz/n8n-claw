"""browser-bridge FastAPI service.

Wraps the Browser Use SDK as a REST API so n8n workflows can drive agentic
browser tasks. Uses a keep-alive session pool keyed by (user_id, domain) to
work around Browser Use 0.12.6 Issue #1002 (storage_state save broken).
"""
from __future__ import annotations

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
    timeout_s: int = Field(300, ge=10, le=900)


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


@app.post("/tasks", response_model=TaskResponse)
async def run_task(req: TaskRequest):
    t0 = time.time()
    domain = extract_domain(req.domain) or extract_domain(req.url)
    session, reused = await pool.get_or_create(req.user_id, domain)

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

    agent = Agent(
        task=task_text, llm=llm, browser_session=session,
        use_vision=True, step_timeout=min(req.timeout_s, 180),
    )
    try:
        import asyncio
        history = await asyncio.wait_for(agent.run(max_steps=req.max_steps), timeout=req.timeout_s)
        elapsed = round(time.time() - t0, 1)
        is_done = history.is_done() if hasattr(history, "is_done") else None
        n_steps = len(history.history) if hasattr(history, "history") else None
        final = str(history.final_result()) if hasattr(history, "final_result") else None
        status = "completed" if is_done else "incomplete"
        return TaskResponse(
            status=status, result=final, elapsed_s=elapsed, n_steps=n_steps,
            session_persisted=(domain is not None), domain=domain,
        )
    except asyncio.TimeoutError:
        return TaskResponse(
            status="timed_out", elapsed_s=round(time.time() - t0, 1),
            session_persisted=(domain is not None), domain=domain,
            error=f"Task exceeded timeout_s={req.timeout_s}",
        )
    except Exception as e:
        log.exception("Task failed")
        return TaskResponse(
            status="failed", elapsed_s=round(time.time() - t0, 1),
            session_persisted=(domain is not None), domain=domain,
            error=repr(e),
        )


@app.get("/sessions/{user_id}")
async def list_sessions(user_id: str):
    return {"sessions": pool.list_for_user(user_id)}


@app.delete("/sessions/{user_id}/{domain}")
async def close_session(user_id: str, domain: str):
    closed = await pool.close(user_id, domain)
    if not closed:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"closed": True, "domain": domain}
