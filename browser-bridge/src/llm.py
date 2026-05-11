"""LLM provider routing for browser-bridge.

Reads tools_config from PostgREST at request time to pick the same LLM
provider that n8n-claw is currently configured for. Provider API keys
are passed via container ENV (from .env at compose time).
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import httpx

log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://kong:8000")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

DEFAULT_PROVIDER = "anthropic"
DEFAULT_MODEL_BY_PROVIDER = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-4o",
    "openrouter": "anthropic/claude-sonnet-4-6",
    "deepseek": "deepseek-chat",
    "gemini": "gemini-2.0-flash",
    "mistral": "mistral-large-latest",
    "ollama": "qwen2.5:14b",
    "groq": "llama-3.3-70b-versatile",
}


@dataclass
class LLMConfig:
    provider: str
    model: str


async def fetch_active_provider() -> LLMConfig:
    """Query PostgREST for the active LLM provider configured in n8n-claw."""
    provider = DEFAULT_PROVIDER
    model = None
    if SUPABASE_KEY:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(
                    f"{SUPABASE_URL}/rest/v1/tools_config",
                    headers={
                        "apikey": SUPABASE_KEY,
                        "Authorization": f"Bearer {SUPABASE_KEY}",
                    },
                    params={"select": "key,value"},
                )
                resp.raise_for_status()
                rows = {r["key"]: r["value"] for r in resp.json()}
                provider = rows.get("llm_provider", DEFAULT_PROVIDER)
                model = rows.get("llm_model")
        except Exception as e:
            log.warning("Could not read tools_config from PostgREST, falling back to %s: %s", DEFAULT_PROVIDER, e)
    if not model:
        model = DEFAULT_MODEL_BY_PROVIDER.get(provider, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER])
    return LLMConfig(provider=provider, model=model)


def build_llm(cfg: LLMConfig):
    """Construct a browser_use.llm chat model for the given provider."""
    p = cfg.provider.lower()
    if p == "anthropic":
        from browser_use.llm import ChatAnthropic
        return ChatAnthropic(model=cfg.model, api_key=_required_key("ANTHROPIC_API_KEY"))
    if p == "openai":
        from browser_use.llm import ChatOpenAI
        return ChatOpenAI(model=cfg.model, api_key=_required_key("OPENAI_API_KEY"))
    if p == "openrouter":
        from browser_use.llm import ChatOpenRouter
        return ChatOpenRouter(model=cfg.model, api_key=_required_key("OPENROUTER_API_KEY"))
    if p == "gemini":
        from browser_use.llm import ChatGoogle
        return ChatGoogle(model=cfg.model, api_key=_required_key("GEMINI_API_KEY"))
    if p == "ollama":
        from browser_use.llm import ChatOllama
        host = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434")
        return ChatOllama(model=cfg.model, host=host)
    if p == "groq":
        from browser_use.llm import ChatGroq
        return ChatGroq(model=cfg.model, api_key=_required_key("GROQ_API_KEY"))
    if p == "mistral":
        from browser_use.llm import ChatMistral
        return ChatMistral(model=cfg.model, api_key=_required_key("MISTRAL_API_KEY"))
    if p == "deepseek":
        from browser_use.llm import ChatDeepSeek
        return ChatDeepSeek(model=cfg.model, api_key=_required_key("DEEPSEEK_API_KEY"))
    raise ValueError(f"Unsupported LLM provider for browser-bridge: {cfg.provider!r}")


def _required_key(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(
            f"{name} environment variable is not set. "
            f"docker-compose must pass it through from the host .env."
        )
    return val
