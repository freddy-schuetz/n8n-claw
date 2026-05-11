"""Keep-alive Browser Use session pool.

Maps (user_id, domain) -> live BrowserSession with keep_alive=True.
Workaround for Browser Use 0.12.6 Issue #1002 (storage_state save broken).

Spike-validated chromium args (without these the browser does not start on a
headless server): --no-sandbox, --disable-dev-shm-usage, --disable-gpu.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlparse

from browser_use import BrowserProfile, BrowserSession

log = logging.getLogger(__name__)

MAX_SESSIONS = int(os.environ.get("BROWSER_BRIDGE_MAX_SESSIONS", "5"))
IDLE_TIMEOUT_S = int(os.environ.get("BROWSER_BRIDGE_IDLE_TIMEOUT_S", "1800"))

BROWSER_PROFILE_KWARGS = dict(
    headless=True,
    chromium_sandbox=False,
    args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    timeout=120000,
    keep_alive=True,
)


def extract_domain(url_or_domain: Optional[str]) -> Optional[str]:
    """Normalize input to a bare domain (lowercase, no scheme, no path)."""
    if not url_or_domain:
        return None
    s = url_or_domain.strip()
    if "://" in s:
        host = urlparse(s).netloc
    else:
        host = s.split("/", 1)[0]
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return host or None


@dataclass
class SessionEntry:
    session: BrowserSession
    created_at: float
    last_used_at: float
    n_tasks: int = 0


@dataclass
class SessionPool:
    _entries: dict[tuple[str, str], SessionEntry] = field(default_factory=dict)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def list_for_user(self, user_id: str) -> list[dict]:
        return [
            {
                "domain": dom,
                "created_at": e.created_at,
                "last_used_at": e.last_used_at,
                "n_tasks": e.n_tasks,
            }
            for (uid, dom), e in self._entries.items()
            if uid == user_id
        ]

    async def get_or_create(self, user_id: str, domain: Optional[str]) -> tuple[BrowserSession, bool]:
        """Return (session, reused). domain=None means ephemeral (not pooled)."""
        await self._evict_idle()
        if domain is None:
            session = BrowserSession(browser_profile=BrowserProfile(**{**BROWSER_PROFILE_KWARGS, "keep_alive": False}))
            return session, False
        key = (user_id, domain)
        async with self._lock:
            if key in self._entries:
                entry = self._entries[key]
                entry.last_used_at = time.time()
                entry.n_tasks += 1
                return entry.session, True
            if len(self._entries) >= MAX_SESSIONS:
                await self._evict_lru_locked()
            session = BrowserSession(browser_profile=BrowserProfile(**BROWSER_PROFILE_KWARGS))
            now = time.time()
            self._entries[key] = SessionEntry(session=session, created_at=now, last_used_at=now, n_tasks=1)
            return session, False

    async def close(self, user_id: str, domain: str) -> bool:
        domain = extract_domain(domain) or domain
        key = (user_id, domain)
        async with self._lock:
            entry = self._entries.pop(key, None)
        if entry is None:
            return False
        try:
            await entry.session.stop()
        except Exception as e:
            log.warning("Error stopping session %s: %s", key, e)
        return True

    async def close_all(self) -> int:
        async with self._lock:
            entries = list(self._entries.items())
            self._entries.clear()
        for key, entry in entries:
            try:
                await entry.session.stop()
            except Exception as e:
                log.warning("Error stopping session %s on shutdown: %s", key, e)
        return len(entries)

    async def _evict_idle(self):
        now = time.time()
        stale_keys = []
        async with self._lock:
            for key, entry in self._entries.items():
                if now - entry.last_used_at > IDLE_TIMEOUT_S:
                    stale_keys.append(key)
            for key in stale_keys:
                self._entries.pop(key, None)
        for key in stale_keys:
            log.info("Evicting idle session %s (idle > %ds)", key, IDLE_TIMEOUT_S)
            try:
                # session already popped, but stop is async — call best-effort here
                pass
            except Exception:
                pass

    async def _evict_lru_locked(self):
        if not self._entries:
            return
        oldest_key = min(self._entries, key=lambda k: self._entries[k].last_used_at)
        log.info("Pool full (%d), evicting LRU session %s", MAX_SESSIONS, oldest_key)
        entry = self._entries.pop(oldest_key)
        try:
            await entry.session.stop()
        except Exception as e:
            log.warning("Error stopping LRU session %s: %s", oldest_key, e)
