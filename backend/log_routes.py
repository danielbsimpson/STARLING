"""backend/log_routes.py — Read-only session log API endpoints.

Endpoints:
  GET  /log/sessions                  — list all session log files
  GET  /log/sessions/{session_id}     — return raw JSONL for a session
  POST /log/event                     — accept a frontend-originated event
  GET  /log/viewer                    — human-readable HTML log viewer
"""

import json
import re
from pathlib import Path

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from pydantic import BaseModel, field_validator

import session_log

router = APIRouter(prefix="/log", tags=["log"])

# Session ID must match this pattern to prevent path traversal attacks.
_SESSION_ID_RE = re.compile(r"^session_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$")

_ALLOWED_FRONTEND_EVENTS = {"tool_dispatch", "user_text", "user_speech_frontend", "error"}

_LOCALHOST_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _is_localhost(request: Request) -> bool:
    return request.client is not None and request.client.host in _LOCALHOST_HOSTS


# ── Models ─────────────────────────────────────────────────────────────────────

class FrontendEvent(BaseModel):
    event_type: str
    data: dict
    source: str = "frontend"

    @field_validator("event_type")
    @classmethod
    def validate_event_type(cls, v: str) -> str:
        if v not in _ALLOWED_FRONTEND_EVENTS:
            raise ValueError(
                f"event_type '{v}' is not allowed. Must be one of: {sorted(_ALLOWED_FRONTEND_EVENTS)}"
            )
        return v


# ── Helpers ───────────────────────────────────────────────────────────────────

def _count_lines(path: Path) -> int:
    try:
        count = 0
        with open(path, "r", encoding="utf-8") as fh:
            for _ in fh:
                count += 1
        return count
    except OSError:
        return 0


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/sessions")
def list_sessions(request: Request):
    """List all session log files. Localhost only."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")

    files = sorted(session_log.LOG_DIR.glob("*.jsonl"), reverse=True)
    result = []
    for f in files:
        stat = f.stat()
        # Parse start_time from filename: session_YYYY-MM-DD_HH-MM-SS.jsonl
        ts_str = f.stem.replace("session_", "").replace("_", "T", 1).replace("-", ":", 2)
        result.append({
            "session_id":  f.stem,
            "start_time":  ts_str,
            "size_bytes":  stat.st_size,
            "event_count": _count_lines(f),
        })
    return result


@router.get("/sessions/{session_id}", response_class=PlainTextResponse)
def get_session(session_id: str, request: Request):
    """Return raw JSONL content of a session log. Localhost only."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")

    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session_id format.")

    path = session_log.LOG_DIR / f"{session_id}.jsonl"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found.")

    return path.read_text(encoding="utf-8")


@router.post("/event")
def ingest_frontend_event(event: FrontendEvent):
    """Accept a frontend-originated log event and write it to the current session."""
    session_log.log(event.event_type, event.data, source=event.source)
    return {"ok": True, "session": session_log.get_session_id()}


@router.get("/stats/{session_id}")
def get_session_stats(session_id: str, request: Request):
    """Return pre-aggregated statistics for a session log. Localhost only."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")

    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session_id format.")

    path = session_log.LOG_DIR / f"{session_id}.jsonl"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found.")

    event_counts: dict[str, int] = {}
    tools_used: list[str] = []
    _tools_seen: set[str] = set()
    session_start_ts: str | None = None
    session_end_ts: str | None = None

    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                event = record.get("event", "")
                event_counts[event] = event_counts.get(event, 0) + 1

                if event == "session_start" and session_start_ts is None:
                    session_start_ts = record.get("ts")
                if event == "session_end":
                    session_end_ts = record.get("ts")

                if event == "tool_dispatch":
                    tool = (record.get("data") or {}).get("tool")
                    if tool and tool not in _tools_seen:
                        _tools_seen.add(tool)
                        tools_used.append(tool)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not read session file: {exc}") from exc

    duration_s: float | None = None
    if session_start_ts and session_end_ts:
        try:
            start_dt = datetime.fromisoformat(session_start_ts)
            end_dt = datetime.fromisoformat(session_end_ts)
            duration_s = round((end_dt - start_dt).total_seconds(), 2)
        except ValueError:
            pass

    total_events = sum(event_counts.values())
    llm_calls = event_counts.get("llm_request", 0)
    tool_dispatches = event_counts.get("tool_dispatch", 0)
    error_count = event_counts.get("error", 0)

    return {
        "session_id": session_id,
        "total_events": total_events,
        "duration_s": duration_s,
        "llm_calls": llm_calls,
        "tool_dispatches": tool_dispatches,
        "error_count": error_count,
        "tools_used": tools_used,
        "event_counts": event_counts,
    }


@router.get("/viewer")
def log_viewer():
    """Redirect to the standalone log dashboard page."""
    return RedirectResponse(url="/log-dashboard.html", status_code=302)
