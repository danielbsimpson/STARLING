"""
backend/calendar_routes.py
Calendar data fetching via CalDAV (iCloud, Nextcloud, Fastmail, etc.).
Exposes GET /calendar and DELETE /calendar/cache endpoints.
"""

import os
import time
from datetime import datetime, timedelta, time as dt_time
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException

router = APIRouter()

# ── Config ────────────────────────────────────────────────────────────────────
_TZ_NAME       = os.getenv("CALENDAR_TIMEZONE", "America/New_York")
_LOOKAHEAD     = int(os.getenv("CALENDAR_LOOKAHEAD_DAYS", "7"))
_CACHE_SECONDS = int(os.getenv("CALENDAR_CACHE_SECONDS", "300"))

_CALDAV_URL  = os.getenv("CALDAV_URL", "")
_CALDAV_USER = os.getenv("CALDAV_USERNAME", "")
_CALDAV_PASS = os.getenv("CALDAV_PASSWORD", "")

# ── In-memory cache ───────────────────────────────────────────────────────────
_cache: dict = {}


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

    if not events_today:
        today_summary = f"You have no events scheduled for today, {label}."
    else:
        parts = []
        for e in events_today:
            t = e["time"] if e["time"] != "All day" else "all day"
            entry = f"{t}: {e['title']}"
            if e.get("location"):
                entry += f" at {e['location']}"
            parts.append(entry)
        today_summary = (
            f"Today is {label}. You have {len(events_today)} event"
            f"{'s' if len(events_today) != 1 else ''} scheduled: "
            + "; ".join(parts) + "."
        )

    upcoming = [e for e in events_week if e["date"] != datetime.now(tz).strftime("%Y-%m-%d")]
    if upcoming:
        by_day: dict = {}
        for e in upcoming:
            by_day.setdefault(e["day"], []).append(e["title"])
        week_summary = "Later this week: " + "; ".join(
            f"{day} — {', '.join(titles)}" for day, titles in list(by_day.items())[:5]
        ) + "."
    else:
        week_summary = "Nothing else scheduled for the rest of the period."

    time_str = now.strftime("%I:%M %p").lstrip("0")
    return (
        f"[CALENDAR CONTEXT — {now.strftime('%A, %B %d').replace(' 0', ' ')} "
        f"at {time_str} {_TZ_NAME}]\n{today_summary} {week_summary}"
    )


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
    Cached for CALENDAR_CACHE_SECONDS.
    """
    tz        = _tz()
    today_key = datetime.now(tz).strftime("%Y-%m-%d")
    cache_key = f"cal_{today_key}"

    cached = _cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_SECONDS:
        return cached["data"]

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

    _cache[cache_key] = {"ts": time.time(), "data": data}
    return data


@router.delete("/calendar/cache")
async def bust_calendar_cache():
    """Force-clear the calendar cache — useful after creating a new event."""
    _cache.clear()
    return {"status": "cleared"}
