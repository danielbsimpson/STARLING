"""
backend/directions.py
Voice-driven drive-time / commute briefing via OpenRouteService (ORS).

Exposes:
  GET /directions
    Query params:
      - destination: str (required)
      - origin: str (optional; defaults to DIRECTIONS_HOME -> WEATHER_LOCATION)
      - profile: driving-car | cycling-regular | foot-walking

    Response shape:
      {
        duration_minutes: int | null,
        distance_km: float | null,
        distance_miles: float | null,
        origin: { label, lat, lon },
        destination: { label, lat, lon },
        profile: str,
        llm_context: str | null,
        fetched_at: str,
        traffic_adjusted: bool
      }

  DELETE /directions/cache
    Clears the in-memory route cache.

ORS deployment modes:
  - Hosted free tier: https://api.openrouteservice.org (Authorization header from ORS_API_KEY)
  - Self-hosted ORS: custom ORS_BASE_URL, keyless (leave ORS_API_KEY unset)

Important:
  - ORS coordinates are [lon, lat] (not [lat, lon]).
  - "Traffic" adjustment is a coarse time-of-day heuristic for typical rush-hour,
    not live traffic data.

Environment variables:
  ORS_BASE_URL (default: https://api.openrouteservice.org)
  ORS_API_KEY (optional; hosted ORS only)
  DIRECTIONS_HOME (default: WEATHER_LOCATION)
  DIRECTIONS_HTTP_TIMEOUT_S (default: 10)
  DIRECTIONS_CACHE_SECONDS (default: 600)
  DIRECTIONS_TRAFFIC_ADJUST (default: true)
  DIRECTIONS_RUSH_FACTOR (default: 1.3)
  DIRECTIONS_RUSH_WINDOWS (default: 07:00-09:30,16:00-18:30)
  DIRECTIONS_DEFAULT_PROFILE (default: driving-car)
  DIRECTIONS_MIN_DEST_CHARS (default: 2)
    DIRECTIONS_ROUTE_GEOMETRY (default: true)
    DIRECTIONS_SLOW_SPEED_RATIO (default: 0.65)
    DIRECTIONS_ROUTE_ANIMATION_MS (default: 7000)
    DIRECTIONS_SCHEMA_VERSION (default: 2)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query

import session_log
from weather import (
    _GEOPY_AVAILABLE,
    _geocode_open_meteo,
    _get_home_coords,
    _resolve_location_sync,
)

router = APIRouter()
logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
_ORS_BASE_URL = os.getenv("ORS_BASE_URL", "https://api.openrouteservice.org").strip().rstrip("/")
_ORS_API_KEY = os.getenv("ORS_API_KEY", "").strip()
_DIRECTIONS_HOME = os.getenv("DIRECTIONS_HOME", os.getenv("WEATHER_LOCATION", "Framingham,Massachusetts")).strip()
_TIMEOUT_S = float(os.getenv("DIRECTIONS_HTTP_TIMEOUT_S", "10"))
_CACHE_SECONDS = int(os.getenv("DIRECTIONS_CACHE_SECONDS", "600"))
_TRAFFIC_ADJUST = os.getenv("DIRECTIONS_TRAFFIC_ADJUST", "true").strip().lower() in {
    "1", "true", "yes", "on"
}
_RUSH_FACTOR = float(os.getenv("DIRECTIONS_RUSH_FACTOR", "1.3"))
_RUSH_WINDOWS = os.getenv("DIRECTIONS_RUSH_WINDOWS", "07:00-09:30,16:00-18:30")
_DEFAULT_PROFILE = os.getenv("DIRECTIONS_DEFAULT_PROFILE", "driving-car").strip().lower()
_MIN_DEST_CHARS = max(1, int(os.getenv("DIRECTIONS_MIN_DEST_CHARS", "2")))
_WEATHER_LOCATION = os.getenv("WEATHER_LOCATION", "Framingham,Massachusetts").strip()
_ROUTE_GEOMETRY = os.getenv("DIRECTIONS_ROUTE_GEOMETRY", "true").strip().lower() in {
    "1", "true", "yes", "on"
}
_SLOW_SPEED_RATIO = max(0.1, min(1.0, float(os.getenv("DIRECTIONS_SLOW_SPEED_RATIO", "0.65"))))
_ROUTE_ANIMATION_MS = max(1000, int(os.getenv("DIRECTIONS_ROUTE_ANIMATION_MS", "7000")))
_SCHEMA_VERSION = max(1, int(os.getenv("DIRECTIONS_SCHEMA_VERSION", "2")))
_OSRM_FALLBACK = os.getenv("DIRECTIONS_OSRM_FALLBACK", "true").strip().lower() in {
    "1", "true", "yes", "on"
}
_OSRM_BASE_URL = os.getenv("DIRECTIONS_OSRM_BASE_URL", "https://router.project-osrm.org").strip().rstrip("/")

_VALID_PROFILES = {"driving-car", "cycling-regular", "foot-walking"}
_UA = {"User-Agent": "STARLING/1.0"}

# Cache structure: key -> {"ts": epoch_seconds, "data": raw_route_dict}
_cache: dict[str, dict] = {}
_home_override_coords: Optional[tuple[float, float, str]] = None


def _profile_spoken_label(profile: str) -> str:
    return {
        "driving-car": "driving",
        "cycling-regular": "cycling",
        "foot-walking": "walking",
    }.get(profile, profile)


def _route_bbox(route_polyline: list[list[float]]) -> Optional[list[float]]:
    if not route_polyline:
        return None
    lats = [pt[0] for pt in route_polyline]
    lons = [pt[1] for pt in route_polyline]
    return [round(min(lats), 6), round(min(lons), 6), round(max(lats), 6), round(max(lons), 6)]


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    mid = n // 2
    if n % 2 == 1:
        return sorted_vals[mid]
    return (sorted_vals[mid - 1] + sorted_vals[mid]) / 2.0


def _build_route_segments(
    route_polyline: list[list[float]],
    ors_steps: list[dict],
    rush_adjusted: bool,
) -> list[dict]:
    if not route_polyline or not ors_steps:
        return []

    parsed_segments: list[dict] = []
    speeds: list[float] = []

    max_index = max(0, len(route_polyline) - 1)

    for step in ors_steps:
        way_points = step.get("way_points") or []
        if len(way_points) != 2:
            continue
        start_idx = max(0, min(max_index, int(way_points[0])))
        end_idx = max(0, min(max_index, int(way_points[1])))
        if end_idx < start_idx:
            start_idx, end_idx = end_idx, start_idx

        distance_m = float(step.get("distance") or 0.0)
        duration_s = float(step.get("duration") or 0.0)
        speed_kmh = (distance_m / duration_s) * 3.6 if duration_s > 0 else 0.0
        if speed_kmh > 0:
            speeds.append(speed_kmh)

        parsed_segments.append({
            "start_idx": start_idx,
            "end_idx": end_idx,
            "distance_m": round(distance_m, 1),
            "duration_s": round(duration_s, 1),
            "speed_kmh": round(speed_kmh, 1),
            "slow_zone": False,
            "estimated_slowdown": False,
        })

    if not parsed_segments:
        return []

    median_speed = _median(speeds)
    mean_speed = (sum(speeds) / len(speeds)) if speeds else 0.0
    threshold = median_speed * _SLOW_SPEED_RATIO

    for seg in parsed_segments:
        speed = seg["speed_kmh"]
        is_slow = False
        if speed > 0 and threshold > 0 and speed < threshold:
            is_slow = True
        if rush_adjusted and speed > 0 and mean_speed > 0 and speed < mean_speed:
            is_slow = True
        seg["slow_zone"] = bool(is_slow)
        seg["estimated_slowdown"] = bool(is_slow)

    return parsed_segments


def _parse_hhmm(value: str) -> int:
    hh, mm = value.split(":", 1)
    h = int(hh)
    m = int(mm)
    if h < 0 or h > 23 or m < 0 or m > 59:
        raise ValueError("invalid time")
    return h * 60 + m


def _parse_rush_windows(raw: str) -> list[tuple[int, int]]:
    windows: list[tuple[int, int]] = []
    for chunk in (raw or "").split(","):
        chunk = chunk.strip()
        if not chunk or "-" not in chunk:
            continue
        start_s, end_s = chunk.split("-", 1)
        try:
            start_m = _parse_hhmm(start_s.strip())
            end_m = _parse_hhmm(end_s.strip())
        except ValueError:
            continue
        windows.append((start_m, end_m))
    return windows


def _is_in_window(now_minutes: int, window: tuple[int, int]) -> bool:
    start, end = window
    if start <= end:
        return start <= now_minutes <= end
    # Overnight window support (e.g., 23:00-02:00)
    return now_minutes >= start or now_minutes <= end


def _apply_rush_adjust(duration_minutes: int, now_local: Optional[datetime] = None) -> tuple[int, bool]:
    """Apply a coarse rush-hour factor to a duration estimate.

    This is a typical-traffic heuristic, not live traffic.
    """
    if duration_minutes <= 0 or not _TRAFFIC_ADJUST:
        return duration_minutes, False

    windows = _parse_rush_windows(_RUSH_WINDOWS)
    if not windows:
        return duration_minutes, False

    now = now_local or datetime.now()
    minute_of_day = now.hour * 60 + now.minute
    if any(_is_in_window(minute_of_day, w) for w in windows):
        adjusted = max(1, int(round(duration_minutes * _RUSH_FACTOR)))
        return adjusted, True

    return duration_minutes, False


async def _resolve_default_origin() -> Optional[tuple[float, float, str]]:
    """Resolve the configured default origin.

    If DIRECTIONS_HOME matches WEATHER_LOCATION, reuse weather's cached home coords.
    Otherwise resolve DIRECTIONS_HOME once and cache for process lifetime.
    """
    global _home_override_coords

    if _DIRECTIONS_HOME == _WEATHER_LOCATION:
        lat, lon = await _get_home_coords()
        return lat, lon, _DIRECTIONS_HOME

    if _home_override_coords is None:
        try:
            lat, lon, label = await _geocode_open_meteo(_DIRECTIONS_HOME)
            _home_override_coords = (lat, lon, label)
        except Exception as exc:
            logger.warning("Directions default origin geocode failed: %s", exc)
            return None

    return _home_override_coords


async def _resolve_place(query: str) -> Optional[tuple[float, float, str]]:
    query = (query or "").strip()
    if not query:
        return None

    try:
        if _GEOPY_AVAILABLE:
            home_lat, home_lon = await _get_home_coords()
            lat, lon, label = await asyncio.to_thread(_resolve_location_sync, query, home_lat, home_lon)
            return lat, lon, label

        lat, lon, label = await _geocode_open_meteo(query)
        return lat, lon, label
    except HTTPException:
        return None
    except Exception as exc:
        logger.warning("Directions geocode failed for '%s': %s", query, exc)
        return None


async def _resolve_origin(origin: Optional[str]) -> Optional[tuple[float, float, str]]:
    if origin and origin.strip():
        return await _resolve_place(origin)
    return await _resolve_default_origin()


async def _resolve_destination(destination: str) -> Optional[tuple[float, float, str]]:
    return await _resolve_place(destination)


async def _fetch_route(
    origin_coords: tuple[float, float, str],
    destination_coords: tuple[float, float, str],
    profile: str,
) -> Optional[dict]:
    """Fetch route summary from ORS; returns None on any fetch/parse failure."""
    o_lat, o_lon, _ = origin_coords
    d_lat, d_lon, _ = destination_coords

    url = f"{_ORS_BASE_URL}/v2/directions/{profile}"
    headers = dict(_UA)
    if _ORS_API_KEY:
        headers["Authorization"] = _ORS_API_KEY

    body = {
        "coordinates": [
            [o_lon, o_lat],
            [d_lon, d_lat],
        ]
    }

    async def _fetch_route_osrm() -> Optional[dict]:
        if not _OSRM_FALLBACK:
            return None

        profile_map = {
            "driving-car": "driving",
            "cycling-regular": "bike",
            "foot-walking": "foot",
        }
        osrm_profile = profile_map.get(profile)
        if not osrm_profile:
            return None

        osrm_url = (
            f"{_OSRM_BASE_URL}/route/v1/{osrm_profile}/"
            f"{o_lon},{o_lat};{d_lon},{d_lat}"
        )
        params = {
            "overview": "full",
            "geometries": "geojson",
            "steps": "true",
        }

        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                osrm_res = await client.get(osrm_url, params=params, headers=_UA)
            if osrm_res.status_code < 200 or osrm_res.status_code >= 300:
                logger.warning("Directions OSRM fallback returned %s", osrm_res.status_code)
                return None

            osrm_payload = osrm_res.json()
            routes = osrm_payload.get("routes") or []
            if not routes:
                return None

            route0 = routes[0] or {}
            duration_s = float(route0.get("duration") or 0.0)
            distance_m = float(route0.get("distance") or 0.0)
            if duration_s <= 0 or distance_m <= 0:
                return None

            duration_minutes_raw = max(1, int(round(duration_s / 60.0)))

            route_polyline: list[list[float]] = []
            if _ROUTE_GEOMETRY:
                coords = (route0.get("geometry") or {}).get("coordinates") or []
                for coord in coords:
                    if not isinstance(coord, (list, tuple)) or len(coord) < 2:
                        continue
                    lon = float(coord[0])
                    lat = float(coord[1])
                    route_polyline.append([round(lat, 6), round(lon, 6)])

            return {
                "duration_minutes_raw": duration_minutes_raw,
                "distance_km": round(distance_m / 1000.0, 1),
                "distance_miles": round(distance_m * 0.000621371, 1),
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "route_polyline": route_polyline,
                "route_bbox": _route_bbox(route_polyline),
                "ors_steps": [],
            }
        except Exception as exc:
            logger.warning("Directions OSRM fallback failed: %s", exc)
            return None

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            res = await client.post(url, headers=headers, json=body)
        if res.status_code < 200 or res.status_code >= 300:
            logger.warning("Directions ORS returned %s; trying OSRM fallback", res.status_code)
            return await _fetch_route_osrm()

        payload = res.json()
        feature = payload["features"][0]
        summary = feature["properties"]["summary"]
        duration_s = float(summary["duration"])
        distance_m = float(summary["distance"])
        duration_minutes_raw = max(1, int(round(duration_s / 60.0)))

        route_polyline: list[list[float]] = []
        if _ROUTE_GEOMETRY:
            coords = (feature.get("geometry") or {}).get("coordinates") or []
            for coord in coords:
                if not isinstance(coord, (list, tuple)) or len(coord) < 2:
                    continue
                lon = float(coord[0])
                lat = float(coord[1])
                route_polyline.append([round(lat, 6), round(lon, 6)])

        ors_segments = ((feature.get("properties") or {}).get("segments") or [])
        steps = []
        if ors_segments:
            steps = (ors_segments[0] or {}).get("steps") or []

        return {
            "duration_minutes_raw": duration_minutes_raw,
            "distance_km": round(distance_m / 1000.0, 1),
            "distance_miles": round(distance_m * 0.000621371, 1),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "route_polyline": route_polyline,
            "route_bbox": _route_bbox(route_polyline),
            "ors_steps": steps,
        }
    except Exception as exc:
        logger.warning("Directions ORS fetch failed: %s; trying OSRM fallback", exc)
        return await _fetch_route_osrm()


def _cache_key(profile: str, origin: tuple[float, float, str], destination: tuple[float, float, str]) -> str:
    o_lat, o_lon, _ = origin
    d_lat, d_lon, _ = destination
    origin_key = f"{o_lat:.3f}_{o_lon:.3f}"
    dest_key = f"{d_lat:.3f}_{d_lon:.3f}"
    return f"dir_v{_SCHEMA_VERSION}_{profile}_{origin_key}_{dest_key}"


def _build_llm_context(route: Optional[dict]) -> Optional[str]:
    if not route:
        return None

    now_local = datetime.now().strftime("%I:%M %p").lstrip("0")
    dest = route["destination"]["label"]
    origin = route["origin"]["label"]
    mode = _profile_spoken_label(route["profile"])

    summary = (
        f"{route['duration_minutes']} minutes, about {route['distance_miles']:.1f} miles "
        f"by {mode} from {origin}"
    )
    if route.get("traffic_adjusted"):
        summary += "; adjusted for typical rush-hour traffic"

    if any((seg or {}).get("slow_zone") for seg in (route.get("segments") or [])):
        summary += "; includes estimated slowdown zones from typical conditions (not live traffic)"

    return f"[DRIVE TIME - to {dest} - as of {now_local}]\n{summary}."


@router.get("/directions")
async def get_directions(
    destination: str = Query(..., description="Destination place name"),
    origin: Optional[str] = Query(None, description="Optional origin place name"),
    profile: str = Query(_DEFAULT_PROFILE, description="Routing profile"),
):
    profile = (profile or _DEFAULT_PROFILE).strip().lower()
    if profile not in _VALID_PROFILES:
        raise HTTPException(status_code=422, detail="Invalid profile. Use driving-car, cycling-regular, or foot-walking.")

    destination = (destination or "").strip()
    if len(destination) < _MIN_DEST_CHARS:
        raise HTTPException(status_code=422, detail="Destination is too short.")

    session_log.log("tool_call", {
        "endpoint": "/directions",
        "method": "GET",
        "params_summary": f"destination={destination}, origin={(origin or 'default')}, profile={profile}",
    })

    origin_coords = await _resolve_origin(origin)
    if origin_coords is None:
        raise HTTPException(status_code=404, detail="Could not resolve the origin location.")

    destination_coords = await _resolve_destination(destination)
    if destination_coords is None:
        raise HTTPException(status_code=404, detail=f"Could not find destination '{destination}'.")

    key = _cache_key(profile, origin_coords, destination_coords)
    cached = _cache.get(key)
    now_ts = time.time()

    raw_route: Optional[dict] = None
    if cached and (now_ts - float(cached.get("ts", 0))) < _CACHE_SECONDS:
        raw_route = cached.get("data")

    if raw_route is None:
        raw_route = await _fetch_route(origin_coords, destination_coords, profile)
        if raw_route is not None:
            _cache[key] = {"ts": now_ts, "data": raw_route}

    origin_obj = {
        "label": origin_coords[2],
        "lat": round(origin_coords[0], 6),
        "lon": round(origin_coords[1], 6),
    }
    destination_obj = {
        "label": destination_coords[2],
        "lat": round(destination_coords[0], 6),
        "lon": round(destination_coords[1], 6),
    }

    if raw_route is None:
        response = {
            "duration_minutes": None,
            "distance_km": None,
            "distance_miles": None,
            "origin": origin_obj,
            "destination": destination_obj,
            "profile": profile,
            "llm_context": None,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "traffic_adjusted": False,
            "route_polyline": [],
            "route_bbox": None,
            "segments": [],
            "animation_ms": _ROUTE_ANIMATION_MS,
        }
        session_log.log("tool_result", {
            "endpoint": "/directions",
            "status_code": 200,
            "result_summary": "route_unavailable",
        })
        return response

    adjusted_minutes, adjusted = _apply_rush_adjust(raw_route["duration_minutes_raw"])
    segments = _build_route_segments(raw_route.get("route_polyline") or [], raw_route.get("ors_steps") or [], adjusted)

    response = {
        "duration_minutes": adjusted_minutes,
        "distance_km": raw_route["distance_km"],
        "distance_miles": raw_route["distance_miles"],
        "origin": origin_obj,
        "destination": destination_obj,
        "profile": profile,
        "llm_context": None,
        "fetched_at": raw_route.get("fetched_at", datetime.now(timezone.utc).isoformat()),
        "traffic_adjusted": adjusted,
        "route_polyline": raw_route.get("route_polyline") or [],
        "route_bbox": raw_route.get("route_bbox"),
        "segments": segments,
        "animation_ms": _ROUTE_ANIMATION_MS,
    }
    response["llm_context"] = _build_llm_context(response)

    session_log.log("tool_result", {
        "endpoint": "/directions",
        "status_code": 200,
        "result_summary": (
            f"duration_min={response['duration_minutes']}, dist_mi={response['distance_miles']}, "
            f"adjusted={response['traffic_adjusted']}"
        ),
    })
    return response


@router.delete("/directions/cache")
async def clear_directions_cache():
    cleared = len(_cache)
    _cache.clear()
    return {"ok": True, "cleared": cleared}
