"""backend/system_state.py — Single source of truth for system awareness.

Holds the boot snapshot, tool inventory, last-run event metrics, runtime
telemetry, cross-session trend computation, and the always-injected static
prompt block. All other modules talk to this module via ``record_event()``
and the various ``get_*`` readers. This module never imports from heavy
peer modules at module load time — cross-module references are local
inside functions to avoid circular imports.
"""

from __future__ import annotations

import logging
import os
import platform
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── Module-level state ────────────────────────────────────────────────────────
_BOOT_MONOTONIC: float = time.monotonic()
_BOOT_SNAPSHOT: dict | None = None
_TOOL_INVENTORY: dict[str, dict] = {}
_LAST_EVENTS: dict[str, dict] = {}
_STATIC_PROMPT_BLOCK: str | None = None
_REQUEST_COUNT: int = 0
_ERROR_COUNT: int = 0
_TRENDS_CACHE: dict | None = None
_TRENDS_CACHE_TS: float = 0.0
_TRENDS_CACHE_TTL_S: float = 30.0
MAX_TREND_FILES: int = 20

# Inject-block escape hatch (RISK-001).
_INJECT_ENABLED: bool = os.getenv("LLM_SYSTEM_STATE_INJECT", "true").lower() == "true"


# ── GPU probes ────────────────────────────────────────────────────────────────

def _run_nvidia_smi(query: str) -> str | None:
    """Run ``nvidia-smi`` with a 2 s timeout. Returns stdout or None on any failure."""
    try:
        result = subprocess.run(
            ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=2.0,
            check=False,
        )
        if result.returncode != 0:
            return None
        return result.stdout.strip() or None
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None


def _probe_gpu_name() -> dict | None:
    """Return {name, total_vram_mib} for the first GPU, or None when unavailable."""
    out = _run_nvidia_smi("name,memory.total")
    if not out:
        return None
    first = out.splitlines()[0]
    parts = [p.strip() for p in first.split(",")]
    if len(parts) < 2:
        return None
    try:
        return {"name": parts[0], "total_vram_mib": int(parts[1])}
    except ValueError:
        return None


def _probe_gpu_vram() -> dict | None:
    """Return {used_mib, free_mib} for the first GPU, or None when unavailable."""
    out = _run_nvidia_smi("memory.used,memory.free")
    if not out:
        return None
    first = out.splitlines()[0]
    parts = [p.strip() for p in first.split(",")]
    if len(parts) < 2:
        return None
    try:
        return {"used_mib": int(parts[0]), "free_mib": int(parts[1])}
    except ValueError:
        return None


# ── Module probes ─────────────────────────────────────────────────────────────

def _probe_llm() -> dict:
    backend = os.getenv("LLM_BACKEND", "ollama").lower()
    if backend == "llama":
        model = os.getenv("LLAMA_MODEL", "llama3.1-8b")
        n_ctx_env = os.getenv("LLAMA_N_CTX") or os.getenv("LLAMA_CTX_SIZE")
        try:
            n_ctx = int(n_ctx_env) if n_ctx_env else None
        except ValueError:
            n_ctx = None
    else:
        model = os.getenv("OLLAMA_MODEL", "llama3.2:3b")
        n_ctx = None
    return {"backend": backend, "model": model, "n_ctx": n_ctx}


def _probe_stt() -> dict:
    try:
        import stt
        return {
            "model":  getattr(stt, "_WHISPER_MODEL_SIZE", "unknown"),
            "device": getattr(stt, "_active_device",      "unknown"),
        }
    except Exception:
        return {"model": "unknown", "device": "unknown"}


def _probe_tts() -> dict:
    try:
        import tts
        provider = getattr(tts, "_onnx_provider", None) or "CPU"
        is_gpu = any(
            kw in provider for kw in ("CUDA", "Tensorrt", "ROCM", "Dml")
        )
        return {
            "model":    "kokoro-v1.0",
            "provider": provider,
            "device":   "cuda" if is_gpu else "cpu",
        }
    except Exception:
        return {"model": "unknown", "provider": "unknown", "device": "unknown"}


def _probe_rag() -> dict:
    try:
        import rag
        status = {}
        try:
            status = rag.get_status()
        except Exception:
            status = {}
        return {
            "enabled":        bool(getattr(rag, "RAG_ENABLED", False)),
            "memory_enabled": bool(getattr(rag, "MEMORY_RAG_ENABLED", False)),
            "collection":     status.get("collection", getattr(rag, "COLLECTION", "")),
            "chunk_count":    int(status.get("chunk_count", 0)),
            "embed_model":    status.get("embed_model", getattr(rag, "EMBED_MODEL", "")),
        }
    except Exception:
        return {"enabled": False, "memory_enabled": False, "collection": "", "chunk_count": 0, "embed_model": ""}


# ── Boot snapshot ─────────────────────────────────────────────────────────────

def build_boot_snapshot() -> dict:
    """Build and cache the boot snapshot — call once at FastAPI startup."""
    global _BOOT_SNAPSHOT
    # Warm-call cpu_percent so subsequent reads are meaningful (RISK-003).
    try:
        import psutil
        psutil.cpu_percent(interval=None)
    except Exception:
        pass

    _BOOT_SNAPSHOT = {
        "llm":             _probe_llm(),
        "stt":             _probe_stt(),
        "tts":             _probe_tts(),
        "rag":             _probe_rag(),
        "os":              platform.system(),
        "os_release":      platform.release(),
        "python_version":  platform.python_version(),
        "gpu":             _probe_gpu_name(),
        "boot_duration_s": None,
        "boot_started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    return _BOOT_SNAPSHOT


def mark_boot_complete() -> None:
    """Stamp the boot duration onto the snapshot and emit a session_event."""
    global _BOOT_SNAPSHOT
    if _BOOT_SNAPSHOT is None:
        return
    duration = round(time.monotonic() - _BOOT_MONOTONIC, 2)
    _BOOT_SNAPSHOT["boot_duration_s"] = duration
    record_event("boot", duration_s=duration, metadata={"completed": True})
    # Rebuild static block now that the duration is known.
    invalidate_static_prompt_block()


def get_boot_snapshot() -> dict:
    """Return a shallow copy of the current boot snapshot."""
    return dict(_BOOT_SNAPSHOT) if _BOOT_SNAPSHOT else {}


# ── Event recording ───────────────────────────────────────────────────────────

def record_event(
    event: str,
    duration_s: float | None = None,
    metadata: dict | None = None,
) -> None:
    """Record a system-wide event in memory and append to the session log."""
    entry = {
        "ts":         datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "duration_s": None if duration_s is None else round(float(duration_s), 3),
        "metadata":   dict(metadata or {}),
    }
    _LAST_EVENTS[event] = entry
    try:
        import session_log
        session_log.log("system_event", {"event": event, **entry})
    except Exception:
        logger.debug("session_log unavailable while recording system_event '%s'.", event)


def get_last_events() -> dict[str, dict]:
    """Return a shallow copy of the last-known event metrics."""
    return {k: dict(v) for k, v in _LAST_EVENTS.items()}


# ── Request / error counters ──────────────────────────────────────────────────

def increment_request() -> None:
    global _REQUEST_COUNT
    _REQUEST_COUNT += 1


def increment_error() -> None:
    global _ERROR_COUNT
    _ERROR_COUNT += 1


def get_request_counters() -> dict:
    return {"request_count": _REQUEST_COUNT, "error_count": _ERROR_COUNT}


def uptime_s() -> int:
    return int(time.monotonic() - _BOOT_MONOTONIC)


def is_boot_complete() -> bool:
    return bool(_BOOT_SNAPSHOT and _BOOT_SNAPSHOT.get("boot_duration_s") is not None)


# ── Tool inventory ────────────────────────────────────────────────────────────

_BASE_DIR = Path(__file__).parent
_MEMORY_DIR = _BASE_DIR / "memory"


def _check_mail() -> tuple[bool, str | None]:
    mail_file = _MEMORY_DIR / "mail_credentials.json"
    cal_file  = _MEMORY_DIR / "calendar_credentials.json"
    if mail_file.exists() or cal_file.exists():
        return True, None
    if os.getenv("IMAP_USERNAME") and os.getenv("IMAP_PASSWORD"):
        return True, None
    return False, "no IMAP credentials"


def _check_calendar() -> tuple[bool, str | None]:
    cal_file = _MEMORY_DIR / "calendar_credentials.json"
    if cal_file.exists():
        return True, None
    if os.getenv("CALDAV_USERNAME") and os.getenv("CALDAV_PASSWORD"):
        return True, None
    return False, "no CalDAV credentials"


def _always_on() -> tuple[bool, str | None]:
    return True, None


_TOOL_PROBES = {
    "mail":     _check_mail,
    "calendar": _check_calendar,
    "news":     _always_on,
    "weather":  _always_on,
    "stocks":   _always_on,
    "reddit":   _always_on,
    "youtube":  _always_on,
    "wiki":     _always_on,
    "journal":  _always_on,
    "ideas":    _always_on,
    "soul":     _always_on,
}


def build_tool_inventory() -> dict[str, dict]:
    """Build and cache the tool inventory."""
    global _TOOL_INVENTORY
    inventory: dict[str, dict] = {}
    for tool_id, probe in _TOOL_PROBES.items():
        try:
            enabled, reason = probe()
        except Exception as exc:
            enabled, reason = False, f"probe failed: {exc}"
        inventory[tool_id] = {
            "id":               tool_id,
            "enabled":          enabled,
            "degraded_reason":  reason,
            "last_used_at":     None,
        }
    _TOOL_INVENTORY = inventory
    invalidate_static_prompt_block()
    return inventory


def refresh_tool_inventory() -> dict[str, dict]:
    """Re-probe credentials/state and return the refreshed inventory."""
    return build_tool_inventory()


def get_tool_inventory() -> dict[str, dict]:
    return {k: dict(v) for k, v in _TOOL_INVENTORY.items()}


def mark_tool_used(tool_id: str) -> None:
    """Optional: update the last_used_at timestamp on a tool entry."""
    if tool_id in _TOOL_INVENTORY:
        _TOOL_INVENTORY[tool_id]["last_used_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")


# ── Runtime telemetry ─────────────────────────────────────────────────────────

def sample_runtime_telemetry() -> dict:
    """On-demand snapshot of process/system/GPU/LLM-server state."""
    proc_rss_mib: int | None = None
    cpu_percent:  float | None = None
    ram_percent:  float | None = None
    try:
        import psutil
        proc        = psutil.Process()
        proc_rss_mib = int(proc.memory_info().rss / (1024 * 1024))
        cpu_percent = float(psutil.cpu_percent(interval=None))
        ram_percent = float(psutil.virtual_memory().percent)
    except Exception:
        pass

    llm = _probe_llm_server()
    counters = get_request_counters()
    return {
        "process_rss_mib": proc_rss_mib,
        "cpu_percent":     cpu_percent,
        "ram_percent":     ram_percent,
        "gpu_vram":        _probe_gpu_vram(),
        "llm_server":      llm,
        "request_count":   counters["request_count"],
        "error_count":     counters["error_count"],
        "uptime_s":        uptime_s(),
    }


def _probe_llm_server() -> dict:
    backend = os.getenv("LLM_BACKEND", "ollama").lower()
    if backend == "llama":
        base = os.getenv("LLAMA_SERVER_URL", "http://localhost:8080")
        url  = f"{base}/health"
    else:
        base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        url  = f"{base}/api/tags"
    try:
        import httpx
        with httpx.Client(timeout=1.0) as client:
            resp = client.get(url)
            return {"backend": backend, "reachable": resp.status_code == 200, "url": base}
    except Exception:
        return {"backend": backend, "reachable": False, "url": base}


# ── Historical trends ─────────────────────────────────────────────────────────

def compute_historical_trends(window: int = 50) -> dict:
    """Read recent system_event records from session logs and compute p50/p95 per event."""
    global _TRENDS_CACHE, _TRENDS_CACHE_TS
    now = time.monotonic()
    if _TRENDS_CACHE is not None and (now - _TRENDS_CACHE_TS) < _TRENDS_CACHE_TTL_S:
        return _TRENDS_CACHE

    try:
        import session_log
        log_dir = session_log.LOG_DIR
    except Exception:
        return {}

    if not Path(log_dir).exists():
        return {}

    files = sorted(Path(log_dir).glob("*.jsonl"), reverse=True)[:MAX_TREND_FILES]
    buckets: dict[str, list[float]] = {}
    import json
    for path in files:
        try:
            with path.open("r", encoding="utf-8") as fh:
                for raw in fh:
                    if '"system_event"' not in raw:
                        continue
                    try:
                        record = json.loads(raw)
                    except Exception:
                        continue
                    if record.get("event") != "system_event":
                        continue
                    data = record.get("data", {})
                    name = data.get("event")
                    dur  = data.get("duration_s")
                    if not name or dur is None:
                        continue
                    bucket = buckets.setdefault(name, [])
                    if len(bucket) < window:
                        bucket.append(float(dur))
        except OSError:
            continue
        if all(len(v) >= window for v in buckets.values()) and buckets:
            break

    result: dict[str, dict] = {}
    for name, values in buckets.items():
        if not values:
            continue
        ordered = sorted(values)
        result[name] = {
            "p50_s": round(_percentile(ordered, 50), 3),
            "p95_s": round(_percentile(ordered, 95), 3),
            "count": len(values),
        }

    _TRENDS_CACHE = result
    _TRENDS_CACHE_TS = now
    return result


def _percentile(ordered: list[float], pct: float) -> float:
    if not ordered:
        return 0.0
    if len(ordered) == 1:
        return ordered[0]
    k = (len(ordered) - 1) * (pct / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(ordered) - 1)
    frac = k - lo
    return ordered[lo] + (ordered[hi] - ordered[lo]) * frac


# ── Static prompt block ───────────────────────────────────────────────────────

def render_static_prompt_block() -> str:
    """Return a compact, deterministic system-state summary (cached, ≤ 250 tokens)."""
    global _STATIC_PROMPT_BLOCK
    if _STATIC_PROMPT_BLOCK is not None:
        return _STATIC_PROMPT_BLOCK
    if _BOOT_SNAPSHOT is None:
        return ""

    snap = _BOOT_SNAPSHOT
    llm  = snap.get("llm", {}) or {}
    stt  = snap.get("stt", {}) or {}
    tts_ = snap.get("tts", {}) or {}
    rag  = snap.get("rag", {}) or {}
    gpu  = snap.get("gpu") or {}

    llm_part = f"{llm.get('backend', '?')} {llm.get('model', '?')}"
    if llm.get("n_ctx"):
        llm_part += f" (n_ctx={llm['n_ctx']})"
    stt_part = f"{stt.get('model', '?')} on {stt.get('device', '?')}"
    tts_part = f"{tts_.get('model', '?')} on {tts_.get('device', '?')}"

    if rag.get("enabled"):
        rag_part = f"enabled, {rag.get('chunk_count', 0)} chunks"
    else:
        rag_part = "disabled"
    mem_part = "enabled" if rag.get("memory_enabled") else "disabled"

    tools_available = sorted(t for t, v in _TOOL_INVENTORY.items() if v.get("enabled"))
    tools_degraded  = sorted(t for t, v in _TOOL_INVENTORY.items() if not v.get("enabled"))

    lines = ["[SYSTEM STATE]"]
    lines.append(f"LLM: {llm_part}.")
    lines.append(f"STT: {stt_part}. TTS: {tts_part}.")
    lines.append(f"RAG: {rag_part}. Memory RAG: {mem_part}.")
    if gpu.get("name"):
        lines.append(f"GPU: {gpu['name']} ({gpu.get('total_vram_mib', '?')} MiB).")
    lines.append(f"Host: {snap.get('os', '?')} / Python {snap.get('python_version', '?')}.")
    if tools_available:
        lines.append("Tools available: " + ", ".join(tools_available) + ".")
    if tools_degraded:
        lines.append("Tools degraded: " + ", ".join(tools_degraded) + ".")
    if snap.get("boot_duration_s") is not None:
        lines.append(f"Boot took {snap['boot_duration_s']} s.")

    _STATIC_PROMPT_BLOCK = "\n".join(lines)
    return _STATIC_PROMPT_BLOCK


def invalidate_static_prompt_block() -> None:
    global _STATIC_PROMPT_BLOCK
    _STATIC_PROMPT_BLOCK = None


def is_inject_enabled() -> bool:
    return _INJECT_ENABLED
