"""Tests for the per-day hourly series shaping in backend/weather.py."""

from __future__ import annotations

import weather


def _mock_raw() -> dict:
    """Minimal Open-Meteo-shaped payload spanning two calendar days."""
    times = [f"2026-05-29T{h:02d}:00" for h in range(24)] + \
            [f"2026-05-30T{h:02d}:00" for h in range(24)]
    temps = [60 + i % 10 for i in range(48)]
    # Include some None values to exercise the coalesce-to-0 path.
    precip = [None if i % 7 == 0 else (i % 100) for i in range(48)]
    return {
        "current": {
            "weather_code": 0, "temperature_2m": 65, "apparent_temperature": 63,
            "relative_humidity_2m": 40, "wind_speed_10m": 8, "wind_direction_10m": 180,
            "cloud_cover": 10, "precipitation": 0, "is_day": 1,
            "uv_index": 6.4, "us_aqi": 42,
        },
        "daily": {
            "time": ["2026-05-29", "2026-05-30"],
            "weather_code": [0, 1],
            "temperature_2m_max": [72, 70],
            "temperature_2m_min": [55, 54],
            "precipitation_sum": [0, 0.1],
            "wind_speed_10m_max": [12, 14],
            "sunrise": ["2026-05-29T05:20", "2026-05-30T05:19"],
            "sunset": ["2026-05-29T20:10", "2026-05-30T20:11"],
        },
        "hourly": {
            "time": times,
            "temperature_2m": temps,
            "precipitation_probability": precip,
        },
    }


def test_hourly_is_list_of_per_day_entries():
    resp = weather._build_response(_mock_raw(), "Testville", True)
    hourly = resp["hourly"]
    assert isinstance(hourly, list)
    assert len(hourly) == 2
    for entry in hourly:
        assert set(entry) >= {"date", "time", "temperature", "precip_probability"}
        n = len(entry["time"])
        assert n == 24
        assert len(entry["temperature"]) == n
        assert len(entry["precip_probability"]) == n


def test_hourly_dates_and_time_format():
    resp = weather._build_response(_mock_raw(), "Testville", True)
    hourly = resp["hourly"]
    assert hourly[0]["date"] == "2026-05-29"
    assert hourly[1]["date"] == "2026-05-30"
    assert hourly[0]["time"][0] == "00:00"
    assert hourly[0]["time"][-1] == "23:00"


def test_none_precip_coalesces_to_zero():
    resp = weather._build_response(_mock_raw(), "Testville", True)
    flat = [
        v
        for entry in resp["hourly"]
        for v in entry["precip_probability"]
    ]
    assert all(isinstance(v, int) for v in flat)
    assert None not in flat
    # Index 0 was None in the mock → coalesced to 0.
    assert resp["hourly"][0]["precip_probability"][0] == 0


def test_missing_hourly_block_yields_empty_list():
    raw = _mock_raw()
    del raw["hourly"]
    resp = weather._build_response(raw, "Testville", True)
    assert resp["hourly"] == []


def test_current_includes_uv_and_aqi():
    resp = weather._build_response(_mock_raw(), "Testville", True)
    cur = resp["current"]
    assert cur["uv_index"] == 6            # 6.4 rounded
    assert cur["uv_label"] == "High"       # 6 ≤ uv < 8
    assert cur["us_aqi"] == 42
    assert cur["aqi_label"] == "Good"      # aqi ≤ 50


def test_uv_and_aqi_labels_handle_missing_values():
    raw = _mock_raw()
    raw["current"].pop("uv_index")
    raw["current"].pop("us_aqi")
    resp = weather._build_response(raw, "Testville", True)
    cur = resp["current"]
    assert cur["uv_index"] is None
    assert cur["uv_label"] == "—"
    assert cur["us_aqi"] is None
    assert cur["aqi_label"] == "—"


def test_is_stale_schema_flags_old_responses():
    # Missing uv_label in current → stale.
    assert weather._is_stale_schema({"current": {}, "forecast": [{}] * 10})
    # Fewer than 10 forecast days → stale.
    assert weather._is_stale_schema(
        {"current": {"uv_label": "Low"}, "forecast": [{}] * 7}
    )
    # Non-dict payload → stale.
    assert weather._is_stale_schema(None)
    # Complete current schema with 10 days → fresh.
    assert not weather._is_stale_schema(
        {"current": {"uv_label": "Low"}, "forecast": [{}] * 10}
    )
