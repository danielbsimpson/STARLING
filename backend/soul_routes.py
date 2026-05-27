"""backend/soul_routes.py — STARLING Soul File API endpoints.

Endpoints:
  GET  /soul                       — return current SOUL.md as text/plain
  GET  /soul/history               — list all archived soul versions
  GET  /soul/diff/{session_id}     — unified diff for a specific archive
  POST /soul/restore/{session_id}  — roll back to an archived version (localhost only)
  PUT  /soul                       — update SOUL.md directly (localhost only; for UI editor)
"""

import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

import soul
from session_log import LOCALHOST_HOSTS as _LOCALHOST_HOSTS

router = APIRouter(prefix="/soul", tags=["soul"])

# Session ID validation — prevents path traversal.
# Matches: session_YYYY-MM-DD_HH-MM-SS or restore_session_..._<timestamp>
_SESSION_ID_RE = re.compile(r"^(session|restore)_[\w\-]+$")


def _is_localhost(request: Request) -> bool:
    return request.client is not None and request.client.host in _LOCALHOST_HOSTS


def _validate_session_id(session_id: str) -> None:
    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(
            status_code=422,
            detail="Invalid session_id format. Must match ^(session|restore)_[\\w\\-]+$",
        )


class SoulUpdateRequest(BaseModel):
    content: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/history")
def get_soul_history():
    """Return all archived soul versions as a JSON array, newest-first."""
    return soul.list_history()


@router.get("/diff/{session_id}", response_class=PlainTextResponse)
def get_soul_diff(session_id: str):
    """Return a unified text diff for the given session archive.

    Returns 404 if no archive exists for session_id.
    """
    _validate_session_id(session_id)
    archive_path = soul._SOUL_DIR / f"SOUL_{session_id}.md"
    if not archive_path.exists():
        raise HTTPException(status_code=404, detail=f"No archive found for session: {session_id}")
    return PlainTextResponse(soul.diff(session_id))


@router.post("/restore/{session_id}")
def restore_soul(session_id: str, request: Request):
    """Roll back SOUL.md to the archived version for session_id.

    Archives current soul first. Returns 403 for non-localhost callers.
    """
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Restore is only available from localhost.")
    _validate_session_id(session_id)
    try:
        archive_path = soul.restore(session_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"No archive found for session: {session_id}")
    return {
        "ok":                   True,
        "restored_from":        session_id,
        "previous_archived_to": str(archive_path),
    }


@router.put("/")
def update_soul(body: SoulUpdateRequest, request: Request):
    """Update SOUL.md with new content (localhost only).

    Used by the UI soul editor. Archives the current soul before writing.
    """
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Soul updates are only available from localhost.")
    import session_log as _sl
    session_id = _sl.get_session_id()
    archive_path = soul.update(body.content, session_id)
    return {"ok": True, "archived_previous_to": str(archive_path)}


@router.get("/", response_class=PlainTextResponse)
def get_soul():
    """Return the current SOUL.md content as text/plain."""
    return PlainTextResponse(soul.get(), media_type="text/plain; charset=utf-8")
