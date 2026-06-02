"""Syntax-level smoke check for frontend ES modules.

Runs `node --check` on every `frontend/*.js` to catch typos and
broken imports during refactors. Skipped automatically if Node.js is
not installed on the test host.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


def _frontend_modules() -> list[Path]:
    return sorted(p for p in _FRONTEND_DIR.glob("*.js") if p.is_file())


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
@pytest.mark.parametrize("module_path", _frontend_modules(),
                         ids=lambda p: p.name)
def test_frontend_module_parses(module_path: Path):
    result = subprocess.run(
        ["node", "--check", str(module_path)],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, (
        f"Syntax error in {module_path.name}:\n{result.stderr}"
    )


def test_weather_flip_markup_and_symbols_present():
    """Weather hourly-graph flip feature wires specific element ids + JS symbols."""
    index_html = (_FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
    for el_id in (
        "weather-flip", "weather-flip-back",
        "wx-back-weekly-btn", "wx-day-temp", "wx-day-precip",
        "weather-metrics", "weather-uv", "weather-aqi",
    ):
        assert el_id in index_html, f"missing element id '{el_id}' in index.html"

    panel_js = (_FRONTEND_DIR / "weather-panel.js").read_text(encoding="utf-8")
    for symbol in ("_renderHourlyCharts", "_flipToDay"):
        assert symbol in panel_js, f"missing symbol '{symbol}' in weather-panel.js"


def test_directions_map_markup_and_symbols_present():
    """Directions map enhancement wires required IDs and map module exports."""
    index_html = (_FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
    for el_id in (
        "directions-map-wrap", "directions-map-canvas", "directions-map-fallback",
        "directions-map-legend",
    ):
        assert el_id in index_html, f"missing element id '{el_id}' in index.html"

    map_js = (_FRONTEND_DIR / "directions-map.js").read_text(encoding="utf-8")
    for symbol in (
        "initDirectionsMap", "renderDirectionsMap",
        "animateRouteFromDestination", "destroyDirectionsMap",
    ):
        assert symbol in map_js, f"missing symbol '{symbol}' in directions-map.js"


def test_directions_toolkit_entry_present():
    """Toolkit menu registry should include the Drive Time / Commute tool."""
    app_js = (_FRONTEND_DIR / "app.js").read_text(encoding="utf-8")
    assert "id: 'directions'" in app_js, "missing directions toolkit id in app.js"
    assert "Drive Time / Commute" in app_js, "missing directions toolkit label in app.js"

