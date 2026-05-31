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
import json
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
        model = getattr(stt, "_WHISPER_MODEL_SIZE", "unknown")
        # Whisper resolves its device lazily on first transcription (to avoid a
        # CUDA stall while llama-server loads VRAM). At boot _active_device is
        # still None, so predict from the requested env device — mirroring the
        # live /system-status endpoint — instead of reporting "unknown"/"?".
        active = getattr(stt, "_active_device", None)
        requested = getattr(stt, "_DEVICE", "cpu")
        device = active if active is not None else requested
        return {
            "engine":    "whisper",
            "model":     model,
            "device":    "GPU" if device == "cuda" else "CPU",
            "predicted": active is None,
        }
    except Exception:
        return {"engine": "whisper", "model": "unknown", "device": "unknown"}


def _probe_tts() -> dict:
    try:
        import tts
        # Kokoro resolves its ONNX provider lazily on first synthesis. At boot
        # _onnx_provider is None, so predict from the providers onnxruntime
        # reports as available — mirroring the live /system-status endpoint —
        # rather than defaulting to CPU.
        resolved = getattr(tts, "_onnx_provider", None)
        if resolved:
            providers = [resolved]
        else:
            try:
                providers = tts._get_available_providers()
            except Exception:
                providers = []
        is_gpu = any(
            kw in p for p in providers
            for kw in ("CUDA", "Tensorrt", "ROCM", "Dml")
        )
        return {
            "engine":    "kokoro",
            "model":     "kokoro-v1.0",
            "provider":  resolved or (providers[0] if providers else "CPU"),
            "device":    "GPU" if is_gpu else "CPU",
            "predicted": resolved is None,
        }
    except Exception:
        return {"engine": "kokoro", "model": "unknown", "provider": "unknown", "device": "unknown"}


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


# ── User-tunable LLM runtime settings ─────────────────────────────────────────
# Persisted to memory/llm_settings.json. launch.py reads the same file at boot
# to decide llama-server's --ctx-size, so changes take effect on next restart.
_LLM_SETTINGS_FILE = _MEMORY_DIR / "llm_settings.json"
_CTX_MIN = 2048
_CTX_MAX = 131072
_CTX_DEFAULT = 8192


def get_llm_settings() -> dict:
    """Return persisted LLM runtime settings, falling back to defaults."""
    ctx = _CTX_DEFAULT
    try:
        if _LLM_SETTINGS_FILE.exists():
            data = json.loads(_LLM_SETTINGS_FILE.read_text(encoding="utf-8"))
            raw = int(data.get("ctx_size", _CTX_DEFAULT))
            ctx = max(_CTX_MIN, min(_CTX_MAX, raw))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        ctx = _CTX_DEFAULT
    return {"ctx_size": ctx, "ctx_min": _CTX_MIN, "ctx_max": _CTX_MAX, "ctx_default": _CTX_DEFAULT}


def save_llm_settings(ctx_size: int) -> dict:
    """Persist the desired llama-server context size. Returns the stored settings.

    Raises ValueError if ctx_size is outside the supported range.
    """
    raw = int(ctx_size)
    if raw < _CTX_MIN or raw > _CTX_MAX:
        raise ValueError(f"ctx_size must be between {_CTX_MIN} and {_CTX_MAX}")
    _MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _LLM_SETTINGS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"ctx_size": raw}, indent=2), encoding="utf-8")
    tmp.replace(_LLM_SETTINGS_FILE)
    return {"ctx_size": raw, "ctx_min": _CTX_MIN, "ctx_max": _CTX_MAX, "ctx_default": _CTX_DEFAULT}


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
    stt_part = f"{stt.get('engine', 'whisper')} {stt.get('model', '?')} on {stt.get('device', '?')}"
    tts_part = f"{tts_.get('engine', 'kokoro')} {tts_.get('model', '?')} on {tts_.get('device', '?')}"

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
