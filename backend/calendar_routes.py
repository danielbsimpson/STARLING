"""
backend/calendar_routes.py
Calendar data fetching via CalDAV (iCloud, Nextcloud, Fastmail, etc.).
Exposes GET /calendar and DELETE /calendar/cache endpoints.
"""

import json
import os
import time
from datetime import datetime, timedelta, time as dt_time
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

# ── Config ────────────────────────────────────────────────────────────────────
_BASE_DIR      = Path(__file__).parent

_TZ_NAME       = os.getenv("CALENDAR_TIMEZONE", "America/New_York")
_LOOKAHEAD     = int(os.getenv("CALENDAR_LOOKAHEAD_DAYS", "7"))
_CACHE_SECONDS = int(os.getenv("CALENDAR_CACHE_SECONDS", "3600"))  # 1 hour default
_CACHE_FILE    = _BASE_DIR / os.getenv("CALENDAR_CACHE_FILE", "memory/calendar_cache.json")
_CRED_FILE     = _BASE_DIR / "memory" / "calendar_credentials.json"

_CALDAV_URL  = os.getenv("CALDAV_URL", "")
_CALDAV_USER = os.getenv("CALDAV_USERNAME", "")
_CALDAV_PASS = os.getenv("CALDAV_PASSWORD", "")

# ── Ensure cache directory exists ─────────────────────────────────────────────
_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
if not _CACHE_FILE.exists():
    _CACHE_FILE.write_text("{}", encoding="utf-8")

# ── In-memory hot cache (avoids disk read on every request) ───────────────────
_mem_cache: dict = {}


# ── Credential helpers ────────────────────────────────────────────────────────

def _load_stored_credentials() -> dict:
    """Load CalDAV credentials from the local JSON store."""
    try:
        if _CRED_FILE.exists():
            return json.loads(_CRED_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _apply_credentials(creds: dict) -> None:
    """Update the module-level CalDAV globals from a credentials dict."""
    global _CALDAV_URL, _CALDAV_USER, _CALDAV_PASS
    _CALDAV_URL  = creds.get("url",      os.getenv("CALDAV_URL",      ""))
    _CALDAV_USER = creds.get("username", os.getenv("CALDAV_USERNAME", ""))
    _CALDAV_PASS = creds.get("password", os.getenv("CALDAV_PASSWORD", ""))


# Apply any saved credentials at import time (overrides .env if a file exists)
_stored_creds = _load_stored_credentials()
if _stored_creds:
    _apply_credentials(_stored_creds)


# ── File I/O helpers ──────────────────────────────────────────────────────────

def _load_cache() -> dict:
    try:
        return json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_cache(data: dict) -> None:
    tmp = _CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _CACHE_FILE)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _tz() -> ZoneInfo:
    return ZoneInfo(_TZ_NAME)


def _day_window(offset_days: int = 0) -> tuple[datetime, datetime]:
    tz    = _tz()
    base  = datetime.now(tz).date() + timedelta(days=offset_days)
    start = datetime.combine(base, dt_time.min, tzinfo=tz)
    end   = datetime.combine(base, dt_time.max, tzinfo=tz)
    return start, end


def _week_window() -> tuple[datetime, datetime]:
    start, _ = _day_window(0)
    _, end   = _day_window(_LOOKAHEAD)
    return start, end


def _format_event_time(dt_val: datetime, all_day: bool) -> str:
    if all_day:
        return "All day"
    tz = _tz()
    if dt_val.tzinfo is None:
        dt_val = dt_val.replace(tzinfo=tz)
    local = dt_val.astimezone(tz)
    # Remove leading zero from hour (Windows-safe)
    return local.strftime("%I:%M %p").lstrip("0")


def _today_label(tz: ZoneInfo) -> str:
    now = datetime.now(tz)
    # Remove zero-padding from day (Windows-safe)
    return now.strftime("%A, %B %d").replace(" 0", " ")


def _build_llm_context(events_today: list, events_week: list, label: str) -> str:
    tz  = _tz()
    now = datetime.now(tz)
    time_str = now.strftime("%I:%M %p").lstrip("0")

    lines = [f"[CALENDAR DATA — {label} at {time_str} {_TZ_NAME}]", ""]

    # ── Today ─────────────────────────────────────────────────────────────────
    lines.append(f"TODAY ({label}):")
    if events_today:
        for e in events_today:
            t = e["time"] if e["time"] != "All day" else "All day"
            loc = f"  [at {e['location']}]" if e.get("location") else ""
            lines.append(f"  - {t}: {e['title']}{loc}")
    else:
        lines.append("  (no events today)")

    lines.append("")

    # ── Upcoming ─────────────────────────────────────────────────────────────
    today_date = now.strftime("%Y-%m-%d")
    upcoming   = [e for e in events_week if e["date"] != today_date]

    lines.append("UPCOMING:")
    if upcoming:
        by_day: dict = {}
        for e in upcoming:
            key = (e["date"], e["day"])
            by_day.setdefault(key, []).append(e)
        for (date_str, day_name), evts in sorted(by_day.items()):
            # Human-readable date label, e.g. "Tuesday, June 3"
            dt_obj = datetime.strptime(date_str, "%Y-%m-%d")
            day_label = dt_obj.strftime("%A, %B %d").replace(" 0", " ")
            for e in evts:
                t   = e["time"] if e["time"] != "All day" else "All day"
                loc = f"  [at {e['location']}]" if e.get("location") else ""
                lines.append(f"  - {day_label}: {t}: {e['title']}{loc}")
    else:
        lines.append("  (nothing scheduled this period)")

    return "\n".join(lines)


# ── CalDAV fetch ──────────────────────────────────────────────────────────────

async def _fetch_caldav(start: datetime, end: datetime) -> list[dict]:
    import asyncio

    def _call() -> list[dict]:
        import caldav
        from icalendar import Calendar as iCal

        if not _CALDAV_URL or not _CALDAV_USER or not _CALDAV_PASS:
            raise HTTPException(
                status_code=500,
                detail="CalDAV credentials not configured. Check CALDAV_URL, CALDAV_USERNAME, CALDAV_PASSWORD in .env",
            )

        client    = caldav.DAVClient(url=_CALDAV_URL, username=_CALDAV_USER, password=_CALDAV_PASS)
        principal = client.principal()
        events: list[dict] = []

        for calendar in principal.calendars():
            try:
                cal_events = calendar.date_search(start=start, end=end, expand=True)
            except Exception:
                continue
            for vevent in cal_events:
                try:
                    comp = iCal.from_ical(vevent.data)
                except Exception:
                    continue
                for component in comp.walk():
                    if component.name != "VEVENT":
                        continue
                    dtstart = component.get("DTSTART")
                    if dtstart is None:
                        continue
                    dt       = dtstart.dt
                    all_day  = not hasattr(dt, "hour")
                    tz_local = _tz()
                    if all_day:
                        dt = datetime.combine(dt, dt_time.min, tzinfo=tz_local)
                    elif dt.tzinfo is None:
                        dt = dt.replace(tzinfo=tz_local)
                    dt = dt.astimezone(tz_local)

                    events.append({
                        "id":          str(component.get("UID", "")),
                        "title":       str(component.get("SUMMARY", "(No title)")),
                        "time":        _format_event_time(dt, all_day),
                        "all_day":     all_day,
                        "date":        dt.strftime("%Y-%m-%d"),
                        "day":         dt.strftime("%A"),
                        "location":    str(component.get("LOCATION", "")),
                        "description": str(component.get("DESCRIPTION", "")),
                        "calendar":    str(calendar.name),
                        "color":       "",
                    })

        events.sort(key=lambda e: (e["date"], e["time"]))
        return events

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _call)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/calendar")
async def get_calendar():
    """
    Return today's events plus a lookahead window.
    Served from disk cache for up to CALENDAR_CACHE_SECONDS (default 1 hour).
    """
    tz        = _tz()
    today_key = datetime.now(tz).strftime("%Y-%m-%d")
    cache_key = f"cal_{today_key}"

    # 1. Check hot in-memory cache first (fastest path)
    cached = _mem_cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_SECONDS:
        return cached["data"]

    # 2. Check disk cache (survives server restarts)
    disk = _load_cache()
    entry = disk.get(cache_key)
    if entry and (time.time() - entry["ts"]) < _CACHE_SECONDS:
        _mem_cache[cache_key] = entry  # warm memory cache
        return entry["data"]

    # 3. Fetch from iCloud
    today_start, today_end = _day_window(0)
    week_start,  week_end  = _week_window()

    try:
        today_events = await _fetch_caldav(today_start, today_end)
        week_events  = await _fetch_caldav(week_start, week_end)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"CalDAV fetch failed: {exc}") from exc

    label       = _today_label(tz)
    llm_context = _build_llm_context(today_events, week_events, label)

    data = {
        "today":       today_events,
        "week":        week_events,
        "today_label": label,
        "timezone":    _TZ_NAME,
        "llm_context": llm_context,
        "backend":     "caldav",
    }

    new_entry = {"ts": time.time(), "data": data}
    _mem_cache[cache_key] = new_entry

    # Persist to disk (keep only the latest key to avoid unbounded growth)
    _save_cache({cache_key: new_entry})

    return data


@router.delete("/calendar/cache")
async def bust_calendar_cache():
    """Force-clear both the in-memory and disk calendar cache."""
    _mem_cache.clear()
    _save_cache({})
    return {"status": "cleared"}


# ── Credential endpoints ──────────────────────────────────────────────────────

@router.get("/calendar/credentials")
async def get_calendar_credentials():
    """Return current login status (username only — password never returned)."""
    creds = _load_stored_credentials()
    username = creds.get("username") or _CALDAV_USER
    if username:
        return {"linked": True, "username": username}
    return {"linked": False, "username": None}


class _CalendarCredentials(BaseModel):
    username: str
    password: str


@router.post("/calendar/credentials")
async def save_calendar_credentials(body: _CalendarCredentials):
    """Save Apple iCloud CalDAV credentials and reload module globals."""
    username = body.username.strip()
    if not username or not body.password:
        raise HTTPException(status_code=422, detail="username and password are required")

    creds = {
        "url":      "https://caldav.icloud.com",
        "username": username,
        "password": body.password,
    }
    tmp = _CRED_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(creds, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _CRED_FILE)
    _apply_credentials(creds)
    # Bust calendar cache so next fetch uses the new credentials
    _mem_cache.clear()
    _save_cache({})
    return {"status": "saved", "username": username}


@router.delete("/calendar/credentials")
async def delete_calendar_credentials():
    """Remove stored credentials and revert to .env values."""
    if _CRED_FILE.exists():
        _CRED_FILE.unlink()
    _apply_credentials({})
    _mem_cache.clear()
    _save_cache({})
    return {"status": "removed"}
