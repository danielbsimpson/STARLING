"""backend/dream_routes.py — FastAPI router for dream state endpoints.

Endpoints:
  POST /dream/run     — trigger dream state manually (localhost only)
  GET  /dream/status  — last dream run result
  GET  /dream/thoughts — full thoughts.md content (localhost only)

The /dream/run endpoint fires a thread and returns immediately so the HTTP
response is not held open during the (potentially long) dream state run.
"""

import threading
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

import dream
from session_log import LOCALHOST_HOSTS, get_session_id

router = APIRouter(prefix="/dream", tags=["dream"])

# ── Last result store ─────────────────────────────────────────────────────────
_last_result: Optional[dream.DreamResult] = None
_result_lock = threading.Lock()


def _require_localhost(request: Request) -> None:
    if request.client is None or request.client.host not in LOCALHOST_HOSTS:
        raise HTTPException(status_code=403, detail="Forbidden")


# ── Request model ─────────────────────────────────────────────────────────────

class DreamRunRequest(BaseModel):
    session_id: Optional[str] = None
    from_ts:    Optional[str] = None  # ISO 8601 UTC — for sleep-mode checkpoint support


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/status")
def dream_status():
    """Return the most recently completed dream state result."""
    with _result_lock:
        r = _last_result
    if r is None:
        return {"status": "no_dream_run_yet"}
    return {
        "session_id":       r.session_id,
        "completed_passes": r.completed_passes,
        "summary_path":     str(r.summary_path)  if r.summary_path  else None,
        "facts_path":       str(r.facts_path)    if r.facts_path    else None,
        "thoughts_path":    str(r.thoughts_path) if r.thoughts_path else None,
        "soul_path":        str(r.soul_path)     if r.soul_path     else None,
        "duration_s":       r.duration_s,
        "errors":           r.errors,
        "memory_ingested":  r.memory_ingested,
    }


@router.post("/run")
def dream_run(req: DreamRunRequest, request: Request):
    """Trigger the dream state pipeline. Localhost only. Returns immediately."""
    _require_localhost(request)

    sid     = req.session_id or get_session_id()
    from_ts = req.from_ts

    def _run() -> None:
        global _last_result
        result = dream.run_dream_state(sid, from_ts=from_ts)
        with _result_lock:
            _last_result = result

    threading.Thread(target=_run, daemon=True, name="dream-pipeline").start()
    return {"status": "started", "session_id": sid}


@router.get("/thoughts")
def dream_thoughts(request: Request):
    """Return the full thoughts.md content. Localhost only."""
    _require_localhost(request)
    path = dream.DREAM_DIR / "thoughts.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="No thoughts recorded yet")
    return PlainTextResponse(path.read_text(encoding="utf-8"))
