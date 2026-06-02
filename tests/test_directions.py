"""Tests for backend directions tool and frontend co-change wiring."""

from __future__ import annotations

import asyncio
import importlib
from datetime import datetime
from pathlib import Path

import pytest


@pytest.fixture
def directions_mod(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    import directions

    importlib.reload(directions)
    directions._cache.clear()
    return directions


@pytest.fixture
def client(directions_mod):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(directions_mod.router)
    return TestClient(app)


class _FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


def test_fetch_route_parses_ors_summary(monkeypatch, directions_mod):
    captured = {}

    class _Client:
        def __init__(self, timeout):
            captured["timeout"] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["headers"] = headers or {}
            captured["json"] = json
            return _FakeResponse(
                200,
                {
                    "features": [
                        {
                            "properties": {
                                "summary": {
                                    "duration": 1800,
                                    "distance": 32186,
                                }
                            }
                        }
                    ]
                },
            )

    monkeypatch.setattr(directions_mod.httpx, "AsyncClient", _Client)

    route = asyncio.run(
        directions_mod._fetch_route(
            (42.0, -71.0, "Origin"),
            (42.4, -71.1, "Dest"),
            "driving-car",
        )
    )

    assert route is not None
    assert route["duration_minutes_raw"] == 30
    assert route["distance_km"] == pytest.approx(32.2, rel=0.001)
    assert route["distance_miles"] == pytest.approx(20.0, rel=0.02)
    assert captured["timeout"] == directions_mod._TIMEOUT_S
    assert captured["url"].startswith(directions_mod._ORS_BASE_URL)
    assert captured["json"]["coordinates"] == [[-71.0, 42.0], [-71.1, 42.4]]


def test_fetch_route_returns_none_on_http_error(monkeypatch, directions_mod):
    class _Client:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            return _FakeResponse(500, {})

    monkeypatch.setattr(directions_mod.httpx, "AsyncClient", _Client)

    route = asyncio.run(
        directions_mod._fetch_route((1.0, 2.0, "o"), (3.0, 4.0, "d"), "driving-car")
    )
    assert route is None


def test_fetch_route_returns_none_on_network_error(monkeypatch, directions_mod):
    class _Client:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            raise RuntimeError("network down")

    monkeypatch.setattr(directions_mod.httpx, "AsyncClient", _Client)

    route = asyncio.run(
        directions_mod._fetch_route((1.0, 2.0, "o"), (3.0, 4.0, "d"), "driving-car")
    )
    assert route is None


def test_authorization_header_optional(monkeypatch, directions_mod):
    calls = []

    class _Client:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            calls.append(headers or {})
            return _FakeResponse(
                200,
                {"features": [{"properties": {"summary": {"duration": 600, "distance": 1000}}}]},
            )

    monkeypatch.setattr(directions_mod.httpx, "AsyncClient", _Client)

    directions_mod._ORS_API_KEY = "test-secret"
    asyncio.run(directions_mod._fetch_route((1.0, 2.0, "o"), (3.0, 4.0, "d"), "driving-car"))

    directions_mod._ORS_API_KEY = ""
    asyncio.run(directions_mod._fetch_route((1.0, 2.0, "o"), (3.0, 4.0, "d"), "driving-car"))

    assert "Authorization" in calls[0]
    assert "Authorization" not in calls[1]


def test_apply_rush_adjust_inside_and_outside_window(directions_mod):
    directions_mod._TRAFFIC_ADJUST = True
    directions_mod._RUSH_FACTOR = 1.3
    directions_mod._RUSH_WINDOWS = "07:00-09:30,16:00-18:30"

    inside_minutes, inside_adjusted = directions_mod._apply_rush_adjust(
        30, datetime(2026, 6, 1, 8, 15)
    )
    outside_minutes, outside_adjusted = directions_mod._apply_rush_adjust(
        30, datetime(2026, 6, 1, 11, 0)
    )

    assert inside_adjusted is True
    assert inside_minutes == 39
    assert outside_adjusted is False
    assert outside_minutes == 30


def test_build_llm_context_labels_typical_traffic(directions_mod):
    base = {
        "duration_minutes": 25,
        "distance_miles": 12.4,
        "origin": {"label": "Framingham"},
        "destination": {"label": "Logan Airport"},
        "profile": "driving-car",
    }

    no_adjust = dict(base, traffic_adjusted=False)
    yes_adjust = dict(base, traffic_adjusted=True)

    ctx_no = directions_mod._build_llm_context(no_adjust)
    ctx_yes = directions_mod._build_llm_context(yes_adjust)

    assert ctx_no.startswith("[DRIVE TIME - to Logan Airport")
    assert "typical rush-hour traffic" not in ctx_no
    assert "typical rush-hour traffic" in ctx_yes


def test_directions_endpoint_validation_and_soft_fail(client, monkeypatch, directions_mod):
    monkeypatch.setattr(directions_mod, "_resolve_origin", lambda origin: asyncio.sleep(0, result=(42.0, -71.0, "Home")))
    monkeypatch.setattr(directions_mod, "_resolve_destination", lambda dest: asyncio.sleep(0, result=(42.3, -71.1, "Dest")))
    monkeypatch.setattr(directions_mod, "_fetch_route", lambda o, d, p: asyncio.sleep(0, result=None))

    bad = client.get("/directions", params={"destination": "Boston", "profile": "bad-mode"})
    assert bad.status_code == 422

    ok_soft = client.get("/directions", params={"destination": "Boston"})
    assert ok_soft.status_code == 200
    body = ok_soft.json()
    assert body["llm_context"] is None
    assert body["duration_minutes"] is None


def test_directions_endpoint_unresolved_destination_returns_404(client, monkeypatch, directions_mod):
    monkeypatch.setattr(directions_mod, "_resolve_origin", lambda origin: asyncio.sleep(0, result=(42.0, -71.0, "Home")))
    monkeypatch.setattr(directions_mod, "_resolve_destination", lambda dest: asyncio.sleep(0, result=None))

    res = client.get("/directions", params={"destination": "Nowhere Place"})
    assert res.status_code == 404


def test_cache_hit_fetches_once_but_reapplies_adjustment(client, monkeypatch, directions_mod):
    directions_mod._cache.clear()
    directions_mod._CACHE_SECONDS = 600

    calls = {"fetch": 0, "adjust": 0}

    async def _origin(_):
        return (42.0, -71.0, "Home")

    async def _dest(_):
        return (42.1, -71.2, "Office")

    async def _fetch(o, d, p):
        calls["fetch"] += 1
        return {
            "duration_minutes_raw": 30,
            "distance_km": 20.0,
            "distance_miles": 12.4,
            "fetched_at": "2026-06-02T12:00:00+00:00",
        }

    def _adjust(duration, now_local=None):
        calls["adjust"] += 1
        if calls["adjust"] == 1:
            return 30, False
        return 39, True

    monkeypatch.setattr(directions_mod, "_resolve_origin", _origin)
    monkeypatch.setattr(directions_mod, "_resolve_destination", _dest)
    monkeypatch.setattr(directions_mod, "_fetch_route", _fetch)
    monkeypatch.setattr(directions_mod, "_apply_rush_adjust", _adjust)

    r1 = client.get("/directions", params={"destination": "Office"})
    r2 = client.get("/directions", params={"destination": "Office"})

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert calls["fetch"] == 1
    assert calls["adjust"] == 2
    assert r1.json()["duration_minutes"] == 30
    assert r2.json()["duration_minutes"] == 39


def test_cache_clear_endpoint(client, monkeypatch, directions_mod):
    async def _origin(_):
        return (42.0, -71.0, "Home")

    async def _dest(_):
        return (42.1, -71.2, "Office")

    async def _fetch(o, d, p):
        return {
            "duration_minutes_raw": 20,
            "distance_km": 10.0,
            "distance_miles": 6.2,
            "fetched_at": "2026-06-02T12:00:00+00:00",
        }

    monkeypatch.setattr(directions_mod, "_resolve_origin", _origin)
    monkeypatch.setattr(directions_mod, "_resolve_destination", _dest)
    monkeypatch.setattr(directions_mod, "_fetch_route", _fetch)

    first = client.get("/directions", params={"destination": "Office"})
    assert first.status_code == 200
    assert directions_mod._cache

    cleared = client.delete("/directions/cache")
    assert cleared.status_code == 200
    assert cleared.json()["ok"] is True
    assert directions_mod._cache == {}


def test_cochange_directions_hooks_present():
    root = Path(__file__).resolve().parents[1]
    fuzzy = (root / "frontend" / "fuzzy-tool-detect.js").read_text(encoding="utf-8")
    app_js = (root / "frontend" / "app.js").read_text(encoding="utf-8")

    assert "toolName: 'Directions'" in fuzzy
    assert "case 'Directions':" in app_js
    assert "detectDirectionsTrigger(text)" in app_js
