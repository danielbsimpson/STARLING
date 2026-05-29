"""
backend/weather.py
Weather data fetching via Open-Meteo (free, no API key required).

Exposes:
  GET /weather          — current conditions + 7-day forecast (file-cached, 1-hour TTL)
  GET /weather/history  — cached historical entries keyed by rounded lat/lon

Enhancement 1 — Local JSON Cache & Historical Tracking:
  Responses are persisted to WEATHER_CACHE_FILE (default: memory/weather_cache.json).
  The file is keyed by "<lat_2dp>_<lon_2dp>" so each location has its own entry list.
  Entries are capped at WEATHER_HISTORY_MAX (default 168, ~one week of hourly snapshots).
  A force=true query param bypasses the cache and always calls Open-Meteo.

Enhancement 2 — Location-Aware Weather Queries:
  GET /weather?location=<name> geocodes the query via Nominatim (geopy) and picks the
  candidate geographically closest to the home coordinates from .env — so "Brighton"
  resolves to Brighton, MA rather than Brighton, England when home is Framingham, MA.
  The response includes display_name and is_default_location for the frontend to label
  the panel correctly.
"""

import asyncio
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query
import session_log

try:
    from geopy.geocoders import Nominatim
    from geopy.distance import geodesic as _geodesic
    _GEOPY_AVAILABLE = True
except ImportError:
    _GEOPY_AVAILABLE = False

router = APIRouter()

# ── Config ────────────────────────────────────────────────────────────────────
_MEMORY_DIR    = Path(__file__).parent / "memory"
_LOCATION_ENV  = os.getenv("WEATHER_LOCATION", "Framingham,Massachusetts")
_DEFAULT_LABEL = os.getenv("WEATHER_DEFAULT_LABEL", "Framingham")
_UNITS         = os.getenv("WEATHER_UNITS", "fahrenheit").lower()
_CACHE_FILE    = Path(os.getenv("WEATHER_CACHE_FILE", str(_MEMORY_DIR / "weather_cache.json")))
_HISTORY_MAX   = int(os.getenv("WEATHER_HISTORY_MAX", "168"))
_CACHE_TTL_S   = 3600  # 1 hour — file-cache TTL per location

# ── Startup: ensure cache directory and file exist ───────────────────────────
_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
if not _CACHE_FILE.exists():
    _CACHE_FILE.write_text("{}", encoding="utf-8")

# ── Module-level home-coords cache (resolved once, lazily) ───────────────────
_home_coords: Optional[tuple[float, float]] = None

# ── WMO weather code → human-readable label ──────────────────────────────────
WMO_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Icy fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
    85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
}

# ── File-cache helpers ────────────────────────────────────────────────────────

def _load_cache() -> dict:
    """Load the on-disk JSON cache. Returns {} on read/parse error."""
    try:
        return json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_cache(cache: dict) -> None:
    """Write cache atomically via the shared file_utils helper."""
    from file_utils import atomic_write_json
    atomic_write_json(_CACHE_FILE, cache)


def _loc_key(lat: float, lon: float) -> str:
    """Cache key: lat/lon rounded to 2 decimal places."""
    return f"{round(lat, 2)}_{round(lon, 2)}"


# ── Geocoding ─────────────────────────────────────────────────────────────────

async def _geocode_open_meteo(location: str) -> tuple[float, float, str]:
    """
    Resolve a location string via Open-Meteo's geocoding API.
    Accepts "City,State" names or "lat,lon" numeric strings.
    Returns (lat, lon, resolved_name).
    """
    if "," in location:
        parts = location.split(",")
        try:
            lat = float(parts[0].strip())
            lon = float(parts[1].strip())
            return lat, lon, location
        except ValueError:
            pass  # fall through to geocoding

    city = location.split(",")[0].strip()
    url = (
        f"https://geocoding-api.open-meteo.com/v1/search"
        f"?name={city}&count=1&language=en&format=json"
    )
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        results = resp.json().get("results")
        if not results:
            raise HTTPException(status_code=404, detail=f"Location not found: {location}")
        r = results[0]
        name = f"{r['name']}, {r.get('admin1', '')} {r.get('country_code', '')}".strip(", ")
        return r["latitude"], r["longitude"], name


async def _get_home_coords() -> tuple[float, float]:
    """Return home (lat, lon) — resolved once per process lifetime and cached."""
    global _home_coords
    if _home_coords is None:
        lat, lon, _ = await _geocode_open_meteo(_LOCATION_ENV)
        _home_coords = (lat, lon)
    return _home_coords


def _resolve_location_sync(query: str, home_lat: float, home_lon: float) -> tuple[float, float, str]:
    """
    Synchronous Nominatim lookup; run via asyncio.to_thread to avoid blocking the
    event loop. Returns (lat, lon, display_name) for the candidate closest to home,
    breaking ties like "Brighton, MA" vs "Brighton, England" by geodesic distance.
    Raises HTTPException(422) if no candidates are found.
    """
    geolocator = Nominatim(user_agent="starling-weather")
    results = geolocator.geocode(query, exactly_one=False, limit=5)
    if not results:
        raise HTTPException(status_code=422, detail=f"Unknown location: {query}")
    home = (home_lat, home_lon)
    closest = min(results, key=lambda r: _geodesic(home, (r.latitude, r.longitude)).km)
    return closest.latitude, closest.longitude, closest.address


# ── Weather fetch ──────────────────────────────────────────────────────────────

async def _fetch_weather(lat: float, lon: float) -> dict:
    """Call Open-Meteo for current conditions + 7-day daily forecast."""
    temp_unit   = "fahrenheit" if _UNITS == "fahrenheit" else "celsius"
    wind_unit   = "mph"        if _UNITS == "fahrenheit" else "kmh"
    precip_unit = "inch"       if _UNITS == "fahrenheit" else "mm"

    params = {
        "latitude":  lat,
        "longitude": lon,
        "current": ",".join([
            "temperature_2m", "apparent_temperature", "relative_humidity_2m",
            "wind_speed_10m", "wind_direction_10m", "weather_code",
            "cloud_cover", "precipitation", "is_day",
        ]),
        "daily": ",".join([
            "weather_code", "temperature_2m_max", "temperature_2m_min",
            "precipitation_sum", "wind_speed_10m_max", "sunrise", "sunset",
        ]),
        "temperature_unit":   temp_unit,
        "wind_speed_unit":    wind_unit,
        "precipitation_unit": precip_unit,
        "timezone":           "auto",
        "forecast_days":      7,
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get("https://api.open-meteo.com/v1/forecast", params=params)
        resp.raise_for_status()
        return resp.json()


def _wind_direction_label(degrees: float) -> str:
    dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    return dirs[round(degrees / 45) % 8]


def _build_response(raw: dict, location_name: str, is_default: bool) -> dict:
    """Shape the raw Open-Meteo JSON into a clean, frontend-ready dict."""
    cur   = raw["current"]
    daily = raw["daily"]
    unit_temp   = "°F" if _UNITS == "fahrenheit" else "°C"
    unit_wind   = "mph" if _UNITS == "fahrenheit" else "km/h"
    unit_precip = "in"  if _UNITS == "fahrenheit" else "mm"

    current = {
        "condition":     WMO_CODES.get(cur["weather_code"], "Unknown"),
        "weather_code":  cur["weather_code"],
        "temp":          round(cur["temperature_2m"]),
        "feels_like":    round(cur["apparent_temperature"]),
        "humidity":      cur["relative_humidity_2m"],
        "wind_speed":    round(cur["wind_speed_10m"]),
        "wind_dir":      _wind_direction_label(cur["wind_direction_10m"]),
        "cloud_cover":   cur["cloud_cover"],
        "precipitation": cur["precipitation"],
        "is_day":        bool(cur["is_day"]),
        "unit_temp":     unit_temp,
        "unit_wind":     unit_wind,
        "unit_precip":   unit_precip,
    }

    forecast = []
    for i in range(len(daily["time"])):
        day_name = datetime.fromisoformat(daily["time"][i]).strftime("%A")
        forecast.append({
            "day":          day_name,
            "date":         daily["time"][i],
            "condition":    WMO_CODES.get(daily["weather_code"][i], "Unknown"),
            "weather_code": daily["weather_code"][i],
            "high":         round(daily["temperature_2m_max"][i]),
            "low":          round(daily["temperature_2m_min"][i]),
            "precip":       daily["precipitation_sum"][i],
            "wind_max":     round(daily["wind_speed_10m_max"][i]),
            "sunrise":      daily["sunrise"][i].split("T")[1] if "T" in daily["sunrise"][i] else daily["sunrise"][i],
            "sunset":       daily["sunset"][i].split("T")[1] if "T" in daily["sunset"][i] else daily["sunset"][i],
        })

    f0 = forecast[0]  # today
    today_label = datetime.now().strftime("%A, %B %d, %Y")
    # Use explicit ordinal offsets so the LLM cannot misidentify which day is tomorrow
    ordinals = ["TOMORROW", "IN TWO DAYS", "IN THREE DAYS",
                "IN FOUR DAYS", "IN FIVE DAYS", "IN SIX DAYS"]
    upcoming_lines = "\n".join(
        f"  {ordinals[i] if i < len(ordinals) else d['day'].upper()} "
        f"({d['day']} {d['date']}): high {d['high']}{unit_temp} / low {d['low']}{unit_temp}, {d['condition']}"
        + (f", precip {d['precip']}{unit_precip}" if d['precip'] > 0 else "")
        for i, d in enumerate(forecast[1:])
    )
    llm_context = (
        f"WEATHER DATA for {location_name}\n"
        f"TODAY ({today_label}): {current['condition']}, currently {current['temp']}{unit_temp} "
        f"(feels like {current['feels_like']}{unit_temp}), "
        f"humidity {current['humidity']}%, wind {current['wind_speed']} {unit_wind} {current['wind_dir']}, "
        f"cloud cover {current['cloud_cover']}%. "
        f"Today's high: {f0['high']}{unit_temp}, low tonight: {f0['low']}{unit_temp}. "
        f"Sunrise {f0['sunrise']}, sunset {f0['sunset']}.\n"
        f"UPCOMING — use these exact high temperatures, do not substitute today's values:\n"
        f"{upcoming_lines}"
    )

    return {
        "location":            location_name,
        "display_name":        location_name,
        "is_default_location": is_default,
        "current":             current,
        "forecast":            forecast,
        "llm_context":         llm_context,
        "fetched_at":          datetime.now(timezone.utc).isoformat(),
        "units":               _UNITS,
    }


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("/weather")
async def get_weather(
    location: Optional[str] = None,
    force: bool = Query(False, description="Bypass file cache and always call Open-Meteo"),
):
    """
    Return current weather + 7-day forecast.

    - location — override the default home location (optional, e.g. "Boston" or "London")
    - force    — bypass the 1-hour file cache (optional)

    Response includes:
      source              "cache" | "live"
      cache_age_seconds   seconds since the cached data was fetched (0 when source=live)
      display_name        resolved human-readable location name
      is_default_location true when no location override was requested
    """
    is_default = location is None

    _t0 = time.monotonic()
    session_log.log("tool_call", {
        "endpoint": "/weather",
        "method":   "GET",
        "params_summary": f"location={location or _DEFAULT_LABEL}",
    })
    if location:
        if _GEOPY_AVAILABLE:
            home_lat, home_lon = await _get_home_coords()
            lat, lon, resolved_name = await asyncio.to_thread(
                _resolve_location_sync, location, home_lat, home_lon
            )
        else:
            lat, lon, resolved_name = await _geocode_open_meteo(location)
    else:
        lat, lon, resolved_name = await _geocode_open_meteo(_LOCATION_ENV)

    key = _loc_key(lat, lon)

    # File-cache check (skipped when force=True)
    if not force:
        cache   = _load_cache()
        entries = cache.get(key, [])
        if entries:
            last  = entries[-1]
            age_s = (
                datetime.now(timezone.utc)
                - datetime.fromisoformat(last["fetched_at"])
            ).total_seconds()
            if age_s < _CACHE_TTL_S:
                data = dict(last["data"])
                data["source"]            = "cache"
                data["cache_age_seconds"] = int(age_s)
                _elapsed_ms = round((time.monotonic() - _t0) * 1000)
                session_log.log("tool_result", {
                    "endpoint":      "/weather",
                    "status_code":   200,
                    "duration_ms":   _elapsed_ms,
                    "result_summary": f"source=cache, condition={data.get('current', {}).get('condition', '?')}, temp={data.get('current', {}).get('temp', '?')}",
                })
                return data

    # Cache miss or forced refresh — call Open-Meteo
    raw  = await _fetch_weather(lat, lon)
    data = _build_response(raw, resolved_name, is_default)
    data["source"]            = "live"
    data["cache_age_seconds"] = 0

    # Append to file cache and trim to WEATHER_HISTORY_MAX
    cache   = _load_cache()
    entries = cache.get(key, [])
    entries.append({"fetched_at": data["fetched_at"], "data": data})
    if len(entries) > _HISTORY_MAX:
        entries = entries[-_HISTORY_MAX:]
    cache[key] = entries
    _save_cache(cache)

    _elapsed_ms = round((time.monotonic() - _t0) * 1000)
    session_log.log("tool_result", {
        "endpoint":      "/weather",
        "status_code":   200,
        "duration_ms":   _elapsed_ms,
        "result_summary": f"condition={data.get('current', {}).get('condition', '?')}, temp={data.get('current', {}).get('temp', '?')}",
    })
    try:
        import system_state
        system_state.record_event(
            "weather_fetch",
            duration_s=round(_elapsed_ms / 1000.0, 3),
            metadata={"location": resolved_name, "cache_hit": False},
        )
    except Exception:
        pass
    return data


@router.get("/weather/history")
async def get_weather_history(location: Optional[str] = None):
    """
    Return cached historical weather entries.

    - No location param: returns the full cache dict keyed by "<lat>_<lon>".
    - With location param: resolves and returns entries for that specific location.
    """
    cache = _load_cache()

    if location is None:
        return {"history": cache}

    if _GEOPY_AVAILABLE:
        home_lat, home_lon = await _get_home_coords()
        lat, lon, _ = await asyncio.to_thread(
            _resolve_location_sync, location, home_lat, home_lon
        )
    else:
        lat, lon, _ = await _geocode_open_meteo(location)

    key = _loc_key(lat, lon)
    return {"location_key": key, "entries": cache.get(key, [])}
