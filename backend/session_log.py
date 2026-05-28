"""backend/session_log.py — Thread-safe JSONL session logger singleton.

All route modules import from this file to write structured events to the
current session's log file. One JSONL file per process lifetime.
"""

import hashlib
import json
import os
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
_DEFAULT_LOG_DIR = Path(__file__).parent / "memory" / "logs"
LOG_DIR = Path(os.getenv("SESSION_LOG_DIR", str(_DEFAULT_LOG_DIR)))
LOG_DIR.mkdir(parents=True, exist_ok=True)

# Shared constant — imported by main.py and log_routes.py to avoid duplication.
LOCALHOST_HOSTS: frozenset[str] = frozenset({"127.0.0.1", "::1", "localhost"})

# ── Session identity (set once at module import time) ─────────────────────────
_session_id: str = "session_" + datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
_log_path: Path = LOG_DIR / f"{_session_id}.jsonl"
_session_start: float = time.monotonic()

# ── Thread safety ─────────────────────────────────────────────────────────────
_lock = threading.Lock()
_event_count: int = 0


# ── Core logging function ─────────────────────────────────────────────────────

def log(event_type: str, data: dict, source: str = "backend") -> None:
    """Append a single JSONL event record to the current session log file.

    Never raises — failures are printed to stderr so they never break the
    hot path (STT → dispatch → LLM → TTS).
    """
    global _event_count
    try:
        record = {
            "ts":      datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "session": _session_id,
            "source":  source,
            "event":   event_type,
            "data":    data,
        }
        line = json.dumps(record, ensure_ascii=False) + "\n"
        with _lock:
            with open(_log_path, "a", encoding="utf-8") as fh:
                fh.write(line)
            _event_count += 1
    except Exception:
        print(f"[session_log] ERROR writing event '{event_type}':", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)


# ── Convenience helpers ───────────────────────────────────────────────────────

def log_session_start(llm_backend: str, pid: int) -> None:
    log("session_start", {"version": "1.0", "llm_backend": llm_backend, "pid": pid})


def log_session_end() -> None:
    duration_s = round(time.monotonic() - _session_start, 3)
    log("session_end", {"duration_s": duration_s, "total_events": _event_count})


# ── Public accessors ──────────────────────────────────────────────────────────

def get_session_id() -> str:
    return _session_id


def get_log_path() -> Path:
    return _log_path


def system_prompt_hash(prompt: str) -> str:
    """Return the first 8 hex chars of the MD5 of a system prompt string."""
    return hashlib.md5(prompt.encode()).hexdigest()[:8]
