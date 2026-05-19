"""
backend/journal_routes.py
Journal storage and retrieval.
Entries are stored as individual JSON files in JOURNAL_DIR (one file per entry).
Exposes POST /journal/entry, GET /journal/entries, GET /journal/search,
DELETE /journal/entry/{entry_id}.
"""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

# ── Config ─────────────────────────────────────────────────────────────────────
_JOURNAL_DIR  = Path(os.getenv("JOURNAL_DIR", "memory/journal"))
_MAX_ENTRIES  = int(os.getenv("JOURNAL_MAX_ENTRIES", "500"))


# ── Models ─────────────────────────────────────────────────────────────────────
class JournalEntryIn(BaseModel):
    raw_transcript: str
    summary:        str
    tags:           list[str] = []
    recorded_at:    Optional[str] = None   # ISO 8601; client supplies for accuracy


class JournalEntryOut(BaseModel):
    id:             str
    recorded_at:    str
    summary:        str
    raw_transcript: str
    tags:           list[str]


# ── File helpers ────────────────────────────────────────────────────────────────
def _entry_path(entry_id: str) -> Path:
    return _JOURNAL_DIR / f"{entry_id}.json"


def _load_entry(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _all_entry_paths(newest_first: bool = True) -> list[Path]:
    """Return all .json paths in JOURNAL_DIR sorted chronologically."""
    _JOURNAL_DIR.mkdir(parents=True, exist_ok=True)
    paths = sorted(_JOURNAL_DIR.glob("*.json"))
    return list(reversed(paths)) if newest_first else paths


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/journal/entry", response_model=JournalEntryOut, status_code=201)
def save_journal_entry(body: JournalEntryIn):
    """
    Save a journal entry to disk as a JSON file.
    Filename is derived from the entry timestamp for natural chronological sorting.
    """
    _JOURNAL_DIR.mkdir(parents=True, exist_ok=True)

    try:
        dt = datetime.fromisoformat(body.recorded_at) if body.recorded_at else None
    except ValueError:
        dt = None
    if dt is None:
        dt = datetime.now(timezone.utc)

    entry_id = dt.strftime("%Y-%m-%d_%H-%M-%S")

    # Handle same-second collisions by appending milliseconds
    path = _entry_path(entry_id)
    if path.exists():
        entry_id += f"_{int(dt.microsecond / 1000):03d}"
        path = _entry_path(entry_id)

    entry = {
        "id":             entry_id,
        "recorded_at":    dt.isoformat(),
        "summary":        body.summary.strip(),
        "raw_transcript": body.raw_transcript.strip(),
        "tags":           [t.strip().lower() for t in body.tags if t.strip()],
    }
    path.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
    return entry


@router.get("/journal/entries")
def list_journal_entries(
    limit:  int = 10,
    offset: int = 0,
    date:   Optional[str] = None,   # "today" | "YYYY-MM-DD"
):
    """
    Return recent journal entries, newest first.
    Optional ?date=today or ?date=YYYY-MM-DD filters to a specific day.
    """
    paths = _all_entry_paths(newest_first=True)

    if date:
        target = (
            datetime.now().strftime("%Y-%m-%d")
            if date.lower() == "today"
            else date
        )
        paths = [p for p in paths if p.stem.startswith(target)]

    total  = len(paths)
    sliced = paths[offset: offset + min(limit, _MAX_ENTRIES)]
    entries = []
    for p in sliced:
        try:
            entries.append(_load_entry(p))
        except Exception:
            continue

    return {"entries": entries, "total": total, "offset": offset, "limit": limit}


@router.get("/journal/search")
def search_journal(q: str, limit: int = 10):
    """
    Full-text search across summary + raw_transcript + tags.
    Case-insensitive substring match — sufficient for personal journal volumes.
    """
    if not q.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    query   = q.strip().lower()
    results = []

    for p in _all_entry_paths(newest_first=True):
        try:
            entry = _load_entry(p)
        except Exception:
            continue
        haystack = (
            entry.get("summary", "")        + " " +
            entry.get("raw_transcript", "") + " " +
            " ".join(entry.get("tags", []))
        ).lower()
        if query in haystack:
            results.append(entry)
        if len(results) >= limit:
            break

    return {"results": results, "total": len(results), "query": q}


@router.delete("/journal/entry/{entry_id}", status_code=204)
def delete_journal_entry(entry_id: str):
    """Delete a single journal entry by id."""
    # Sanitise: only allow the filename pattern we generate (digits, hyphens, underscores)
    if not re.fullmatch(r'[\d\-_]+', entry_id):
        raise HTTPException(status_code=400, detail="Invalid entry id")
    path = _entry_path(entry_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Entry not found")
    path.unlink()
