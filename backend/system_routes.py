"""backend/system_routes.py — Localhost-only endpoints for system awareness."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

import system_state
from session_log import LOCALHOST_HOSTS

router = APIRouter(tags=["system"])


def _require_localhost(request: Request) -> None:
    if request.client is None or request.client.host not in LOCALHOST_HOSTS:
        raise HTTPException(status_code=403, detail="Forbidden")


@router.get("/system/status")
async def system_status_endpoint(request: Request):
    """Return full system awareness payload. Localhost only."""
    _require_localhost(request)
    return {
        "boot":        system_state.get_boot_snapshot(),
        "tools":       system_state.get_tool_inventory(),
        "last_events": system_state.get_last_events(),
        "runtime":     system_state.sample_runtime_telemetry(),
        "trends":      system_state.compute_historical_trends(),
        "static_block": system_state.render_static_prompt_block(),
    }


@router.post("/system/refresh-tools")
async def refresh_tools_endpoint(request: Request):
    """Re-probe tool credentials and return the updated inventory. Localhost only."""
    _require_localhost(request)
    return system_state.refresh_tool_inventory()


@router.get("/system/health")
async def system_health_endpoint():
    """Minimal public health check — no sensitive data."""
    return {
        "status":        "ok",
        "boot_complete": system_state.is_boot_complete(),
        "uptime_s":      system_state.uptime_s(),
    }
