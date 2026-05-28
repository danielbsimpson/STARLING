"""backend/prompt_routes.py — REST API for the prompt registry.

Endpoints:
  GET    /prompts          — list full catalog (optionally filtered by ?category=)
  PUT    /prompts/{key}    — set an override (localhost-only)
  DELETE /prompts/{key}    — reset to default (localhost-only)
  POST   /prompts/reload   — hot-reload prompts.json from disk (localhost-only)
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import prompts
from session_log import LOCALHOST_HOSTS

router = APIRouter(prefix="/prompts", tags=["prompts"])


def _require_localhost(request: Request) -> None:
    host = request.client.host if request.client else ""
    if host not in LOCALHOST_HOSTS:
        raise HTTPException(status_code=403, detail="Localhost only")


class PromptUpdate(BaseModel):
    value: str


def _entry_for(key: str) -> dict:
    """Return the catalog entry for key, or raise 422 if not found."""
    entry = next((e for e in prompts.catalog() if e["key"] == key), None)
    if entry is None:
        raise HTTPException(status_code=422, detail=f"Unknown prompt key: {key}")
    return entry


@router.get("/")
async def list_prompts(category: str | None = None):
    """Return the full prompt catalog, optionally filtered by category."""
    items = prompts.catalog()
    if category:
        items = [e for e in items if e["category"] == category]
    return items


@router.put("/{key}")
async def update_prompt(key: str, body: PromptUpdate, request: Request):
    """Set a prompt override. Localhost only."""
    _require_localhost(request)
    _entry_for(key)  # raises 422 if key is unknown
    if len(body.value) > prompts.MAX_PROMPT_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"Value exceeds {prompts.MAX_PROMPT_CHARS} characters",
        )
    prompts.set(key, body.value)
    return _entry_for(key)


@router.delete("/{key}")
async def reset_prompt(key: str, request: Request):
    """Reset a prompt to its default. Localhost only."""
    _require_localhost(request)
    _entry_for(key)  # raises 422 if key is unknown
    prompts.reset(key)
    return _entry_for(key)


@router.post("/reload")
async def reload_prompts(request: Request):
    """Hot-reload prompts.json from disk. Localhost only."""
    _require_localhost(request)
    prompts.load_overrides()
    count = sum(1 for e in prompts.catalog() if e["is_overridden"])
    return {"ok": True, "overrides_loaded": count}
