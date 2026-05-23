"""
backend/ideas_routes.py
Ideas tracker — quick-capture storage and retrieval.
All ideas live in a single JSON array file (IDEAS_FILE).
Exposes POST /ideas/add, GET /ideas, GET /ideas/search, DELETE /ideas/{id}, DELETE /ideas.
"""

import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import session_log

router = APIRouter()

# ── Config ─────────────────────────────────────────────────────────────────────
_IDEAS_FILE = Path(os.getenv("IDEAS_FILE", str(Path(__file__).parent / "memory" / "ideas.json")))
_MAX_RETURN = int(os.getenv("IDEAS_MAX_RETURN", "100"))

# ── File I/O helpers ──────────────────────────────────────────────────────────

def _load() -> list[dict]:
    """Load all ideas from disk. Returns empty list if file does not exist."""
    if not _IDEAS_FILE.exists():
        return []
    try:
        data = json.loads(_IDEAS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save(ideas: list[dict]) -> None:
    """Write the full ideas list back to disk atomically."""
    _IDEAS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _IDEAS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(ideas, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(_IDEAS_FILE)


# ── Models ─────────────────────────────────────────────────────────────────────

class IdeaIn(BaseModel):
    raw_text:   str
    title:      str
    tags:       list[str] = []
    created_at: Optional[str] = None   # ISO 8601; client supplies for accuracy


class IdeaOut(BaseModel):
    id:         str
    created_at: str
    title:      str
    raw_text:   str
    tags:       list[str]


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/ideas/add", response_model=IdeaOut, status_code=201)
def add_idea(body: IdeaIn):
    """Append a new idea to ideas.json."""
    _t0 = time.monotonic()
    session_log.log("tool_call", {
        "endpoint": "/ideas/add",
        "method":   "POST",
        "params_summary": body.raw_text[:80],
    })
    ideas = _load()

    try:
        dt = datetime.fromisoformat(body.created_at) if body.created_at else None
    except ValueError:
        dt = None
    if dt is None:
        dt = datetime.now(timezone.utc)

    idea = {
        "id":         str(uuid.uuid4())[:8],  # short 8-char hex id
        "created_at": dt.isoformat(),
        "title":      body.title.strip(),
        "raw_text":   body.raw_text.strip(),
        "tags":       [t.strip().lower() for t in body.tags if t.strip()],
    }
    ideas.append(idea)
    _save(ideas)
    session_log.log("tool_result", {
        "endpoint":      "/ideas/add",
        "status_code":   201,
        "duration_ms":   round((time.monotonic() - _t0) * 1000),
        "result_summary": f"id={idea['id']}, title={idea['title'][:60]}",
    })
    return idea


@router.get("/ideas")
def list_ideas(limit: int = 20, offset: int = 0, newest_first: bool = True):
    """Return paginated ideas, optionally sorted newest-first."""
    _t0 = time.monotonic()
    session_log.log("tool_call", {"endpoint": "/ideas", "method": "GET", "params_summary": f"limit={limit}"})
    ideas = _load()
    if newest_first:
        ideas = list(reversed(ideas))
    total  = len(ideas)
    sliced = ideas[offset: offset + min(limit, _MAX_RETURN)]
    session_log.log("tool_result", {"endpoint": "/ideas", "status_code": 200, "duration_ms": round((time.monotonic() - _t0) * 1000), "result_summary": f"total={total}, returned={len(sliced)}"})
    return {"ideas": sliced, "total": total, "offset": offset, "limit": limit}


@router.get("/ideas/search")
def search_ideas(q: str, limit: int = 20):
    """Full-text search across title + raw_text + tags."""
    if not q.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")
    query   = q.strip().lower()
    results = []
    for idea in reversed(_load()):   # newest first
        haystack = (idea.get("title", "") + " " +
                    idea.get("raw_text", "") + " " +
                    " ".join(idea.get("tags", []))).lower()
        if query in haystack:
            results.append(idea)
        if len(results) >= limit:
            break
    return {"results": results, "total": len(results), "query": q}


@router.delete("/ideas/{idea_id}", status_code=204)
def delete_idea(idea_id: str):
    """Remove a single idea by its short id."""
    ideas = _load()
    original_len = len(ideas)
    ideas = [i for i in ideas if i.get("id") != idea_id]
    if len(ideas) == original_len:
        raise HTTPException(status_code=404, detail="Idea not found")
    _save(ideas)


@router.delete("/ideas", status_code=204)
def clear_all_ideas():
    """Wipe all ideas — used by the 'clear all ideas' voice command."""
    _save([])
