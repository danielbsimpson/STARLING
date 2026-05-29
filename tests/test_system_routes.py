"""Tests for backend/system_routes.py — REQ-007."""

from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def client(monkeypatch, tmp_path):
    """Build a minimal FastAPI app with system_routes mounted."""
    monkeypatch.chdir(tmp_path)
    import system_state
    importlib.reload(system_state)
    system_state.build_boot_snapshot()
    system_state.build_tool_inventory()

    # TestClient uses host='testclient' — add to allowed localhost set.
    import system_routes
    monkeypatch.setattr(system_routes, "LOCALHOST_HOSTS",
                        frozenset({"127.0.0.1", "::1", "localhost", "testclient"}))

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from system_routes import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_health_endpoint_public(client):
    res = client.get("/system/health")
    assert res.status_code == 200
    body = res.json()
    assert "status" in body
    assert "boot_complete" in body
    assert "uptime_s" in body


def test_status_endpoint_localhost_only(client):
    # TestClient uses 127.0.0.1 → should succeed
    res = client.get("/system/status")
    assert res.status_code == 200
    body = res.json()
    for key in ("boot", "tools", "last_events", "runtime", "static_block"):
        assert key in body


def test_status_endpoint_rejects_non_localhost(client):
    # Spoof a non-localhost client host via header — depends on FastAPI's
    # TestClient. We can't easily change client.host, so we directly verify
    # the guard at the function level.
    from starlette.requests import Request
    import system_routes

    class _FakeClient:
        host = "10.0.0.5"

    class _FakeRequest:
        client = _FakeClient()

    with pytest.raises(Exception):
        system_routes._require_localhost(_FakeRequest())


def test_refresh_tools_endpoint(client):
    res = client.post("/system/refresh-tools")
    assert res.status_code == 200
    body = res.json()
    # Endpoint returns the tools mapping directly.
    assert isinstance(body, dict) and body, "expected non-empty tools mapping"
    # Each entry should at least carry an `enabled` flag.
    first = next(iter(body.values()))
    assert "enabled" in first
