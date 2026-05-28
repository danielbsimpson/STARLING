"""
backend/youtube.py
YouTube channel feed via public Atom/RSS (no API key required for Phase 1).
Optional YouTube Data API v3 for duration/Shorts classification (Phase 2).
Optional Google OAuth2 subscription discovery (Phase 3).

Exposes:
  GET  /youtube             — fetch all channel feeds
  GET  /youtube/synthesised — poll for background LLM synthesis result
  DELETE /youtube/cache     — clear all caches

Phase 2 stubs (activated when YOUTUBE_API_KEY is set):
  _resolve_handle_to_channel_id()
  _enrich_with_durations()

Phase 3 stubs (activated when YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET are set):
  GET /youtube/auth
  GET /youtube/callback
  GET /youtube/auth-status
  GET /youtube/subscriptions
  _fetch_subscribed_channels()
"""

import asyncio
import email.utils
import functools
import hashlib
import html
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import feedparser
import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel

import session_log

router = APIRouter()
logger = logging.getLogger(__name__)

# ── Config — Phase 1 ──────────────────────────────────────────────────────────
_CHANNELS_ENV     = os.getenv("YOUTUBE_CHANNELS", "")
_CACHE_SECONDS    = int(os.getenv("YOUTUBE_CACHE_SECONDS", "1800"))
_SYNTHESIS_ON     = os.getenv("YOUTUBE_SYNTHESIS_ENABLED", "true").lower() in ("1", "true", "yes")

# Disk-cache: persists video data across restarts, 12-hour TTL
_DISK_CACHE_FILE  = Path(__file__).parent / "memory" / "youtube_cache.json"
_DISK_CACHE_TTL   = int(os.getenv("YOUTUBE_DISK_CACHE_TTL", str(12 * 3600)))  # 12 hours

# Validate channel IDs: must be UCxxxxxxxxxxxxxxxxxxxxxxxxx (24 chars)
_CHANNEL_ID_RE = re.compile(r"^UC[A-Za-z0-9_\-]{22}$")

# Persistent channel list — takes precedence over env var when the file exists
_CHANNELS_FILE = Path(__file__).parent / "memory" / "youtube_channels.json"

# Default example channels — user should set YOUTUBE_CHANNELS in .env
_EXAMPLE_CHANNELS = [
    "UCXuqSBlHAE6Xw-yeJA0Tunw",  # Linus Tech Tips
    "UCBcRF18a7Qf58cCRy5xuWwQ",  # Marques Brownlee (MKBHD)
    "UCHnyfMqiRRG1u-2MsSQLbXA",  # Veritasium
]

def _parse_channel_list(raw: str) -> list[str]:
    ids = []
    for part in raw.split(","):
        cid = part.strip()
        if not cid:
            continue
        if _CHANNEL_ID_RE.match(cid):
            ids.append(cid)
        else:
            logger.warning("Rejected invalid YouTube channel ID: %r", cid)
    return ids

_DEFAULT_CHANNELS: list[str] = (
    _parse_channel_list(_CHANNELS_ENV) if _CHANNELS_ENV.strip()
    else _EXAMPLE_CHANNELS
)


# ── Disk cache helpers ────────────────────────────────────────────────────────

def _disk_cache_key(channels: list[str], max_per_channel: int) -> str:
    """Stable hash key for the disk cache, based on channel list and max_per_channel."""
    raw = f"{max_per_channel}:{'_'.join(sorted(channels))}"
    return "yt_" + hashlib.sha1(raw.encode()).hexdigest()[:16]


def _load_disk_cache() -> dict:
    """Load the on-disk YouTube video cache. Returns {} on any error."""
    try:
        if _DISK_CACHE_FILE.exists():
            return json.loads(_DISK_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("YouTube disk cache read error: %s", exc)
    return {}


def _save_disk_cache(cache: dict) -> None:
    """Write the disk cache atomically (write to .tmp, then os.replace)."""
    try:
        _DISK_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _DISK_CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, _DISK_CACHE_FILE)
    except Exception as exc:
        logger.error("YouTube disk cache write error: %s", exc)


def _load_channel_objects() -> list[dict]:
    """Load the full channel object list from JSON. Handles both old list[str] and new list[dict] formats."""
    try:
        if _CHANNELS_FILE.exists():
            raw = json.loads(_CHANNELS_FILE.read_text(encoding="utf-8"))
            if not isinstance(raw, list):
                return []
            objects = []
            for item in raw:
                if isinstance(item, str):
                    if _CHANNEL_ID_RE.match(item):
                        objects.append({"name": None, "channel_id": item, "handle": None})
                elif isinstance(item, dict):
                    objects.append({
                        "name":       item.get("name"),
                        "channel_id": item.get("channel_id"),
                        "handle":     item.get("handle"),
                    })
            return objects
    except Exception as exc:
        logger.warning("Failed to load youtube_channels.json: %s", exc)
    return []


def _load_channels() -> list[str]:
    """Load resolved channel IDs, pre-populating _channel_name_map from stored names."""
    objects = _load_channel_objects()
    if not objects:
        return list(_DEFAULT_CHANNELS)
    ids = []
    for obj in objects:
        cid = obj.get("channel_id")
        if cid and isinstance(cid, str) and _CHANNEL_ID_RE.match(cid):
            ids.append(cid)
            name = obj.get("name")
            if name:
                _channel_name_map.setdefault(cid, name)
    return ids if ids else list(_DEFAULT_CHANNELS)


def _save_channels(channels: list[str]) -> None:
    """Persist channel IDs, merging with any existing name/handle metadata in the JSON file."""
    try:
        _CHANNELS_FILE.parent.mkdir(parents=True, exist_ok=True)
        # Preserve existing metadata (name, handle) for known channel IDs
        existing: dict[str, dict] = {}
        if _CHANNELS_FILE.exists():
            try:
                raw = json.loads(_CHANNELS_FILE.read_text(encoding="utf-8"))
                for item in raw:
                    if isinstance(item, dict) and item.get("channel_id"):
                        existing[item["channel_id"]] = item
            except Exception:
                pass  # best-effort: corrupt channels.json → start with empty existing map
        objects = [
            existing.get(cid, {"name": _channel_name_map.get(cid), "channel_id": cid, "handle": None})
            for cid in channels
        ]
        _CHANNELS_FILE.write_text(json.dumps(objects, indent=2), encoding="utf-8")
    except Exception as exc:
        logger.error("Failed to save youtube_channels.json: %s", exc)

# ── Config — Phase 2 (YouTube Data API v3, optional) ─────────────────────────
YOUTUBE_API_KEY   = os.getenv("YOUTUBE_API_KEY", "")
YOUTUBE_HANDLE    = os.getenv("YOUTUBE_HANDLE", "")
_API_CONFIGURED   = bool(YOUTUBE_API_KEY)

# ── Config — Phase 3 (Google OAuth2, optional) ────────────────────────────────
YOUTUBE_CLIENT_ID     = os.getenv("YOUTUBE_CLIENT_ID", "")
YOUTUBE_CLIENT_SECRET = os.getenv("YOUTUBE_CLIENT_SECRET", "")
_OAUTH_CONFIGURED     = bool(YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET and YOUTUBE_API_KEY)
_TOKEN_PATH           = Path(__file__).parent / "memory" / "youtube_token.json"
_OAUTH_SCOPES         = ["https://www.googleapis.com/auth/youtube.readonly"]

# ── In-memory caches ──────────────────────────────────────────────────────────
_raw_cache: dict          = {}   # cache_key → {"ts": float, "data": dict}
_synth_cache: dict        = {}   # cache_key → {"ts": float, "result": dict}
_synth_busy: set          = set()
_channel_name_map: dict   = {}   # channel_id → display name
_handle_cache: dict       = {}   # handle → channel_id  (Phase 2)
_subs_cache: dict         = {}   # "subs" → {"ts": float, "channels": list[str]}  (Phase 3)

# ── Synthesis prompt ──────────────────────────────────────────────────────────
YOUTUBE_SYNTHESIS_PROMPT = """You are a media curator summarising YouTube videos for a voice assistant.
Below is a JSON array of recent YouTube videos from one or more channels.
For each channel present, produce a brief spoken summary of its top 2-3 videos.
Return ONLY a valid JSON object with:
- "briefing": plain-prose spoken summary covering all channels (1-2 sentences per channel; no markdown, no asterisks, no bullet hyphens, since it will be read aloud)
- "by_channel": an object mapping each channel name to {{ "summary": "...", "top_videos": ["title1", "title2"] }}
Return ONLY valid JSON. No markdown fences.
Videos:
{videos_json}
""".strip()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _human_age(ts: float) -> str:
    """Return a human-readable relative age string from a Unix timestamp."""
    delta = time.time() - ts
    if delta < 3600:
        return f"{int(delta // 60)}m ago"
    if delta < 86400:
        return f"{int(delta // 3600)}h ago"
    return f"{int(delta // 86400)}d ago"


def _fmt_views(n: int) -> str:
    """Format a view count as a compact human-readable string."""
    if n <= 0:
        return "—"
    if n < 1_000:
        return str(n)
    if n < 1_000_000:
        return f"{n / 1000:.1f}K"
    return f"{n / 1_000_000:.1f}M"


def _parse_channel_feed(channel_id: str, max_videos: int = 15) -> list[dict]:
    """
    Synchronously fetch and parse a YouTube channel RSS feed.
    Returns a list of video dicts.  Called via run_in_executor.
    max_videos: maximum number of videos to return per channel (1-15).
    """
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    try:
        feed = feedparser.parse(url, request_headers={"User-Agent": "STARLING/1.0"})
    except Exception as exc:
        logger.warning("feedparser error for channel %s: %s", channel_id, exc)
        return []

    channel_name = html.unescape(feed.feed.get("title", channel_id))
    _channel_name_map[channel_id] = channel_name

    videos: list[dict] = []
    for entry in feed.entries[:max_videos]:
        # Extract video ID — prefer yt_videoid namespace attribute
        video_id = entry.get("yt_videoid", "")
        if not video_id and entry.get("link"):
            m = re.search(r"[?&]v=([A-Za-z0-9_\-]{11})", entry.get("link", ""))
            if m:
                video_id = m.group(1)
        if not video_id:
            continue

        title = html.unescape(entry.get("title", "").strip())[:300]
        link  = entry.get("link", f"https://www.youtube.com/watch?v={video_id}")

        # Parse published timestamp
        pub_str = entry.get("published", "")
        pub_ts  = 0.0
        if pub_str:
            try:
                pub_ts = email.utils.parsedate_to_datetime(pub_str).timestamp()
            except Exception:
                try:
                    # feedparser sometimes gives ISO 8601 instead of RFC 2822
                    from datetime import datetime as _dt
                    pub_ts = _dt.fromisoformat(pub_str.replace("Z", "+00:00")).timestamp()
                except Exception:
                    pub_ts = 0.0

        # View count — in media:statistics namespace
        media_stats = entry.get("media_statistics", {})
        views_raw   = media_stats.get("views", "0") if isinstance(media_stats, dict) else "0"
        try:
            views = int(views_raw or 0)
        except (ValueError, TypeError):
            views = 0

        # Description — strip HTML tags, unescape entities, truncate
        raw_desc    = entry.get("summary", entry.get("media_description", ""))
        description = html.unescape(re.sub(r"<[^>]+>", " ", raw_desc))[:280]

        # Thumbnail URL — prefer media:thumbnail, fall back to constructed URL
        media_thumb = entry.get("media_thumbnail", [])
        if media_thumb and isinstance(media_thumb, list) and isinstance(media_thumb[0], dict):
            thumbnail_url = media_thumb[0].get("url", "")
        else:
            thumbnail_url = ""
        if not thumbnail_url and video_id:
            thumbnail_url = f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg"

        # Detect Shorts from the RSS link URL — works without API key.
        # YouTube's RSS feed uses /shorts/<id> links for Shorts content.
        # Phase 2 (_enrich_with_durations) will override this with the
        # authoritative duration-based value when an API key is configured.
        is_short_from_url = bool(re.search(r"/shorts/", link))

        videos.append({
            "video_id":         video_id,
            "title":            title,
            "channel":          channel_name,
            "channel_id":       channel_id,
            "link":             link,
            "shorts_url":       f"https://www.youtube.com/shorts/{video_id}",
            "published_str":    pub_str,
            "published_ts":     pub_ts,
            "age":              _human_age(pub_ts) if pub_ts else "—",
            "views":            views,
            "views_fmt":        _fmt_views(views),
            "description":      description,
            "thumbnail_url":    thumbnail_url,
            # Phase 2 fields — populated by _enrich_with_durations()
            "duration_seconds": None,
            "is_short":         is_short_from_url if is_short_from_url else None,
        })

    return videos


async def _fetch_all_channels_parallel(channels: list[str], max_per_channel: int = 15) -> tuple[list[dict], dict]:
    """
    Fetch all channel feeds in parallel using a thread-pool executor
    (feedparser is synchronous).
    Returns (all_videos sorted by published_ts desc, by_channel dict).
    max_per_channel: number of recent videos to fetch per channel.
    """
    loop = asyncio.get_running_loop()
    fetch_fn = functools.partial(_parse_channel_feed, max_videos=max_per_channel)
    results = await asyncio.gather(
        *[loop.run_in_executor(None, fetch_fn, ch) for ch in channels],
        return_exceptions=True,
    )

    by_channel: dict[str, list[dict]] = {}
    all_videos: list[dict] = []
    for ch, result in zip(channels, results):
        if isinstance(result, Exception):
            logger.warning("Channel %s fetch failed: %s", ch, result)
            by_channel[ch] = []
            continue
        by_channel[ch] = result
        all_videos.extend(result)

    all_videos.sort(key=lambda v: v["published_ts"], reverse=True)
    return all_videos, by_channel


def _build_llm_context(videos: list[dict], channels: list[str]) -> str:
    """Build a compact plain-text summary of recent videos for LLM injection."""
    now   = datetime.now(timezone.utc).strftime("%A, %B %d at %I:%M %p UTC")
    lines = [f"[YOUTUBE FEED — {now}]"]
    for ch in channels:
        name        = _channel_name_map.get(ch, ch)
        ch_videos   = [v for v in videos if v["channel_id"] == ch][:5]
        if not ch_videos:
            continue
        lines.append(f"{name}:")
        for i, v in enumerate(ch_videos, 1):
            lines.append(f"  {i}. {v['title']} ({v['views_fmt']} views, {v['age']})")
    return "\n".join(lines)


async def _synthesise_videos(videos: list[dict]) -> dict | None:
    """
    Call the local LLM to produce a channel-by-channel spoken briefing.
    Returns a dict with 'briefing' and 'by_channel' keys, or None on failure.
    """
    if not videos:
        return None

    capped = [
        {"channel": v["channel"], "title": v["title"], "views": v["views"], "age": v["age"]}
        for v in videos[:50]
    ]
    prompt = YOUTUBE_SYNTHESIS_PROMPT.format(videos_json=json.dumps(capped, ensure_ascii=False))

    llm_backend = os.getenv("LLM_BACKEND", "ollama").lower()
    if llm_backend == "llama":
        base_url = os.getenv("LLAMA_SERVER_URL", "http://localhost:8080")
        payload  = {
            "model":           os.getenv("LLAMA_MODEL", "llama3.1-8b"),
            "messages":        [{"role": "user", "content": prompt}],
            "stream":          False,
            "temperature":     0.1,
            "response_format": {"type": "json_object"},
        }
        endpoint = f"{base_url}/v1/chat/completions"
    else:
        base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        payload  = {
            "model":    os.getenv("OLLAMA_MODEL", "llama3.2:3b"),
            "messages": [{"role": "user", "content": prompt}],
            "stream":   False,
            "options":  {"temperature": 0.1},
            "format":   "json",
        }
        endpoint = f"{base_url}/api/chat"

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(endpoint, json=payload)
            resp.raise_for_status()
            data = resp.json()

        content = (
            data["choices"][0]["message"]["content"]
            if llm_backend == "llama"
            else data["message"]["content"]
        )
        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            return None
        if "briefing" not in parsed or "by_channel" not in parsed:
            return None

        # Strip markdown artefacts from the spoken briefing
        parsed["briefing"] = re.sub(
            r"[*#]|^\s*-\s", "", parsed["briefing"], flags=re.MULTILINE
        ).strip()

        return parsed

    except Exception as exc:
        logger.warning("YouTube synthesis failed: %s", exc)
        return None


async def _run_synthesis_bg(videos: list[dict], cache_key: str) -> None:
    """
    Background task: synthesise video feed and write result to _synth_cache.
    Runs after GET /youtube has already returned raw data to the client.
    """
    _synth_busy.add(cache_key)
    try:
        result = await _synthesise_videos(videos)
        if result:
            _synth_cache[cache_key] = {"ts": time.time(), "result": result}
            logger.info("YouTube synthesis complete for %r", cache_key)
        else:
            logger.info("YouTube synthesis returned nothing for %r", cache_key)
    finally:
        _synth_busy.discard(cache_key)


# ── Phase 2 stubs — YouTube Data API v3 ──────────────────────────────────────

async def _resolve_handle_to_channel_id(handle: str) -> str | None:
    """
    Phase 2: Resolve a YouTube handle (@username) to a channel ID.
    Requires YOUTUBE_API_KEY.  Returns None if not configured or on failure.
    """
    if not _API_CONFIGURED:
        return None
    clean = handle.lstrip("@")
    if clean in _handle_cache:
        return _handle_cache[clean]
    url = (
        f"https://www.googleapis.com/youtube/v3/channels"
        f"?part=id&forHandle={clean}&key={YOUTUBE_API_KEY}"
    )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            items = resp.json().get("items", [])
            if not items:
                return None
            channel_id = items[0]["id"]
            _handle_cache[clean] = channel_id
            return channel_id
    except Exception as exc:
        logger.warning("Handle resolution failed for %r: %s", handle, exc)
        return None


async def _resolve_handle_no_api(handle: str) -> str | None:
    """
    Resolve a YouTube @handle to a channel ID by scraping the channel page.
    No API key required.  Validates the handle before making any HTTP request (SEC-006).
    """
    clean = re.sub(r'^@', '', handle.strip())
    if not re.match(r'^[A-Za-z0-9._-]{1,100}$', clean):
        return None
    url = f"https://www.youtube.com/@{clean}"
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (compatible; STARLING/1.0)"})
        # Primary: channelId JSON field embedded in page source
        m = re.search(r'"channelId":"(UC[A-Za-z0-9_\-]{22})"', resp.text)
        if m and _CHANNEL_ID_RE.match(m.group(1)):
            return m.group(1)
        # Fallback: <link rel="canonical"> tag
        m = re.search(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[A-Za-z0-9_\-]{22})"', resp.text)
        if m and _CHANNEL_ID_RE.match(m.group(1)):
            return m.group(1)
        return None
    except Exception as exc:
        logger.warning("Handle no-API resolution failed for %r: %s", handle, exc)
        return None


async def _enrich_with_durations(videos: list[dict]) -> None:
    """
    Phase 2: Mutates videos in-place adding duration_seconds (int) and
    is_short (bool).  Batches up to 50 video IDs per API call.
    Requires YOUTUBE_API_KEY.  No-op if not configured.
    """
    if not _API_CONFIGURED:
        return

    def _parse_iso8601_duration(s: str) -> int:
        m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
        if not m:
            return 0
        h, mn, sec = (int(g or 0) for g in m.groups())
        return h * 3600 + mn * 60 + sec

    need   = [v for v in videos if v["duration_seconds"] is None and v["video_id"]]
    id_map = {v["video_id"]: v for v in need}

    for i in range(0, len(need), 50):
        batch_ids = [v["video_id"] for v in need[i:i + 50]]
        ids_param = ",".join(batch_ids)
        url = (
            f"https://www.googleapis.com/youtube/v3/videos"
            f"?part=contentDetails&id={ids_param}&key={YOUTUBE_API_KEY}"
        )
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                for item in resp.json().get("items", []):
                    vid  = item["id"]
                    dur  = _parse_iso8601_duration(
                        item.get("contentDetails", {}).get("duration", "")
                    )
                    if vid in id_map:
                        id_map[vid]["duration_seconds"] = dur
                        id_map[vid]["is_short"]         = dur <= 180
        except Exception as exc:
            logger.warning("Duration enrichment batch failed: %s", exc)


# ── Phase 3 stubs — Google OAuth2 subscription discovery ─────────────────────

async def _fetch_subscribed_channels() -> tuple[list[str], str]:
    """
    Phase 3: Return (channel_id_list, source_label) where source is 'oauth' or 'env'.
    Currently always returns env channels until OAuth is implemented.
    """
    if not _OAUTH_CONFIGURED:
        return _load_channels(), "file"

    # Phase 3: Check token cache TTL
    cached = _subs_cache.get("subs")
    if cached and (time.time() - cached["ts"]) < 3600:
        return cached["channels"], "oauth"

    # Phase 3 implementation goes here — load credentials, call subscriptions.list
    logger.info("OAuth configured but Phase 3 not yet implemented; falling back to env")
    return _load_channels(), "file"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/youtube")
async def get_youtube(
    channel:         str = Query(None),
    sort:            str = Query("date"),
    max_per_channel: int = Query(default=15, ge=1, le=15),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """
    Fetch YouTube channel feeds and return a video list with LLM context.
    Query params:
      channel — single channel ID to fetch (optional, defaults to configured list)
      sort    — date | views | channel  (default: date)
    """
    # Resolve channel list
    if channel:
        if not _CHANNEL_ID_RE.match(channel):
            raise HTTPException(status_code=400, detail=f"Invalid channel ID: {channel!r}")
        channels = [channel]
        source   = "param"
    else:
        # Phase 3: _fetch_subscribed_channels() will use OAuth when configured
        channels, source = await _fetch_subscribed_channels()

        # Phase 2: lazy handle resolution for YOUTUBE_HANDLE
        if not channels and YOUTUBE_HANDLE and _API_CONFIGURED:
            resolved = await _resolve_handle_to_channel_id(YOUTUBE_HANDLE)
            if resolved:
                channels = [resolved]

    if not channels:
        raise HTTPException(
            status_code=400,
            detail=(
                "No YouTube channels configured. "
                "Set YOUTUBE_CHANNELS in .env (comma-separated channel IDs starting with UC…)."
            ),
        )

    # Validate sort param
    sort = sort if sort in ("date", "views", "channel") else "date"

    cache_key = "youtube_" + "_".join(sorted(channels))

    # ── Serve from in-memory cache if fresh ──────────────────────────────────
    cached = _raw_cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_SECONDS:
        data = dict(cached["data"])
        data["cache_age"] = int(time.time() - cached["ts"])
        # Re-trigger synthesis if cache is warm but synthesis stale/absent
        synth_cached = _synth_cache.get(cache_key)
        if _SYNTHESIS_ON and cache_key not in _synth_busy and not synth_cached:
            background_tasks.add_task(_run_synthesis_bg, cached["data"]["videos"], cache_key)
        synthesis_result = _synth_cache.get(cache_key)
        data["synthesis_status"] = (
            "ready"   if synthesis_result else
            "pending" if cache_key in _synth_busy else
            "none"
        )
        session_log.log("tool_result", {"endpoint": "/youtube", "source": "memory_cache", "total": data["total"]})
        return data

    # ── Serve from disk cache if within 12-hour TTL ───────────────────────────
    disk_key   = _disk_cache_key(channels, max_per_channel)
    disk_cache = _load_disk_cache()
    disk_entry = disk_cache.get(disk_key)
    if disk_entry and (time.time() - disk_entry["ts"]) < _DISK_CACHE_TTL:
        data = dict(disk_entry["data"])
        data["cache_age"] = int(time.time() - disk_entry["ts"])
        # Re-sort if the requested sort differs from what was cached
        if sort != data.get("sort", "date"):
            vids = data["videos"]
            if sort == "views":
                vids.sort(key=lambda v: v["views"], reverse=True)
            elif sort == "channel":
                vids.sort(key=lambda v: (v["channel"].lower(), -v["published_ts"]))
            else:
                vids.sort(key=lambda v: v["published_ts"], reverse=True)
            data["sort"] = sort
        # Warm up in-memory cache from disk
        _raw_cache[cache_key] = {"ts": disk_entry["ts"], "data": disk_entry["data"]}
        for ch_id, ch_name in (disk_entry["data"].get("channel_names") or {}).items():
            _channel_name_map.setdefault(ch_id, ch_name)
        synth_cached = _synth_cache.get(cache_key)
        if _SYNTHESIS_ON and cache_key not in _synth_busy and not synth_cached:
            background_tasks.add_task(_run_synthesis_bg, disk_entry["data"]["videos"], cache_key)
        data["synthesis_status"] = (
            "ready"   if _synth_cache.get(cache_key) else
            "pending" if cache_key in _synth_busy else
            "none"
        )
        session_log.log("tool_result", {"endpoint": "/youtube", "source": "disk_cache", "total": data["total"]})
        return data

    # Fresh fetch
    all_videos, by_channel = await _fetch_all_channels_parallel(channels, max_per_channel=max_per_channel)

    # Phase 2: enrich with durations if API key is configured
    if _API_CONFIGURED:
        await _enrich_with_durations(all_videos)

    # Apply sort
    if sort == "views":
        all_videos.sort(key=lambda v: v["views"], reverse=True)
    elif sort == "channel":
        all_videos.sort(key=lambda v: (v["channel"].lower(), -v["published_ts"]))
    else:  # date (default)
        all_videos.sort(key=lambda v: v["published_ts"], reverse=True)

    llm_context = _build_llm_context(all_videos, channels)
    channel_names = {ch: _channel_name_map.get(ch, ch) for ch in channels}

    data = {
        "videos":              all_videos,
        "by_channel":          {ch: by_channel.get(ch, []) for ch in channels},
        "channels":            channels,
        "channel_names":       channel_names,
        "total":               len(all_videos),
        "llm_context":         llm_context,
        "fetched_at":          datetime.now(timezone.utc).isoformat(),
        "cache_age":           0,
        "sort":                sort,
        "api_key_configured":  _API_CONFIGURED,
        "oauth_configured":    _OAUTH_CONFIGURED,
        "subscription_source": source,
        "synthesis_enabled":   _SYNTHESIS_ON,
        "synthesis_status":    "pending" if _SYNTHESIS_ON else "disabled",
    }

    _raw_cache[cache_key] = {"ts": time.time(), "data": data}

    # Persist to disk cache for cross-restart reuse (12-hour TTL)
    disk_cache[disk_key] = {"ts": time.time(), "data": data}
    _save_disk_cache(disk_cache)

    if _SYNTHESIS_ON and cache_key not in _synth_busy:
        _synth_cache.pop(cache_key, None)
        background_tasks.add_task(_run_synthesis_bg, all_videos, cache_key)

    session_log.log("tool_call",   {"endpoint": "/youtube", "channels": len(channels), "sort": sort})
    session_log.log("tool_result", {"endpoint": "/youtube", "total": len(all_videos)})
    return data


@router.get("/youtube/synthesised")
async def get_youtube_synthesised(channel: str = Query(None)):
    """Poll for background LLM synthesis result."""
    if channel:
        if not _CHANNEL_ID_RE.match(channel):
            raise HTTPException(status_code=400, detail=f"Invalid channel ID: {channel!r}")
        channels = [channel]
    else:
        channels, _ = await _fetch_subscribed_channels()

    cache_key     = "youtube_" + "_".join(sorted(channels))
    synth_cached  = _synth_cache.get(cache_key)

    if synth_cached:
        return {"status": "ready", "result": synth_cached["result"]}
    if cache_key in _synth_busy:
        return {"status": "pending"}
    return {"status": "none"}


@router.delete("/youtube/cache")
async def delete_youtube_cache():
    """Clear all YouTube caches — in-memory and on-disk — forcing a fresh fetch next request."""
    _raw_cache.clear()
    _synth_cache.clear()
    _synth_busy.clear()
    _channel_name_map.clear()
    _subs_cache.clear()
    _save_disk_cache({})
    session_log.log("tool_call", {"endpoint": "DELETE /youtube/cache"})
    return {"status": "cleared"}


# ── Channel management endpoints ────────────────────────────────────────────

class ChannelAddRequest(BaseModel):
    channel_id: str


@router.get("/youtube/channels")
async def get_youtube_channels():
    """Return the full channel list — resolved and pending — with name, handle, and resolution status."""
    objects = _load_channel_objects()
    if not objects:
        channels = _load_channels()
        return [{"id": ch, "channel_id": ch, "name": _channel_name_map.get(ch), "handle": None, "resolved": True} for ch in channels]
    result = []
    for obj in objects:
        cid = obj.get("channel_id")
        resolved = bool(cid and _CHANNEL_ID_RE.match(cid))
        result.append({
            "id":         cid,
            "channel_id": cid,
            "name":       obj.get("name") or _channel_name_map.get(cid or ""),
            "handle":     obj.get("handle"),
            "resolved":   resolved,
        })
    return result


@router.post("/youtube/channels")
async def post_youtube_channel(body: ChannelAddRequest):
    """Add a channel to the followed list."""
    if not _CHANNEL_ID_RE.match(body.channel_id):
        raise HTTPException(status_code=400, detail="Invalid channel ID format.")
    channels = _load_channels()
    if body.channel_id in channels:
        raise HTTPException(status_code=400, detail="Channel already in list.")
    channels.append(body.channel_id)
    _save_channels(channels)
    _raw_cache.clear()
    _synth_cache.clear()
    return {"status": "added", "channel_id": body.channel_id}


@router.post("/youtube/channels/resolve-pending")
async def resolve_pending_channels():
    """
    Attempt to resolve unresolved channels (those with a handle but no channel_id)
    by scraping their YouTube handle pages.  No API key required.
    Returns a summary of resolved / failed counts.
    """
    objects = _load_channel_objects()
    if not objects:
        return {"resolved": 0, "failed": 0, "already_resolved": 0, "total": 0}

    resolved_count  = 0
    failed_count    = 0
    already_count   = 0
    updated_objects = []

    for obj in objects:
        cid    = obj.get("channel_id")
        handle = obj.get("handle")
        name   = obj.get("name", handle or "?")

        if cid and _CHANNEL_ID_RE.match(cid):
            already_count += 1
            updated_objects.append(obj)
            continue

        if not handle:
            logger.info("No handle for channel %r — skipping", name)
            failed_count += 1
            updated_objects.append(obj)
            continue

        # Try API-based resolution first if configured
        new_id = None
        if _API_CONFIGURED:
            new_id = await _resolve_handle_to_channel_id(handle)
        if new_id is None:
            new_id = await _resolve_handle_no_api(handle)

        if new_id:
            logger.info("Resolved %r -> %s", name, new_id)
            _channel_name_map[new_id] = name
            updated_objects.append({**obj, "channel_id": new_id})
            resolved_count += 1
        else:
            logger.warning("Could not resolve handle %r for channel %r", handle, name)
            updated_objects.append(obj)
            failed_count += 1

    try:
        _CHANNELS_FILE.write_text(json.dumps(updated_objects, indent=2), encoding="utf-8")
    except Exception as exc:
        logger.error("Failed to save resolved channels: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to save resolved channels.")

    _raw_cache.clear()
    _synth_cache.clear()
    session_log.log("tool_call", {"endpoint": "POST /youtube/channels/resolve-pending",
                                   "resolved": resolved_count, "failed": failed_count})
    return {
        "resolved":         resolved_count,
        "failed":           failed_count,
        "already_resolved": already_count,
        "total":            len(updated_objects),
    }


@router.delete("/youtube/channels/{channel_id}")
async def delete_youtube_channel(channel_id: str):
    """Remove a channel from the followed list."""
    if not _CHANNEL_ID_RE.match(channel_id):
        raise HTTPException(status_code=400, detail="Invalid channel ID format.")
    channels = _load_channels()
    if channel_id not in channels:
        raise HTTPException(status_code=404, detail="Channel not in list.")
    if len(channels) <= 1:
        raise HTTPException(status_code=400, detail="Cannot remove the last channel.")
    channels.remove(channel_id)
    _save_channels(channels)
    _raw_cache.clear()
    _synth_cache.clear()
    _channel_name_map.pop(channel_id, None)
    return {"status": "removed", "channel_id": channel_id}


# ── Phase 3 endpoints (auth-gated) ───────────────────────────────────────────

@router.get("/youtube/auth-status")
async def get_youtube_auth_status():
    """Return OAuth + API key configuration status (Phase 3)."""
    token_exists = _TOKEN_PATH.exists() if _OAUTH_CONFIGURED else False
    return {
        "authenticated":    token_exists,
        "oauth_configured": _OAUTH_CONFIGURED,
        "api_key_configured": _API_CONFIGURED,
    }


@router.get("/youtube/subscriptions")
async def get_youtube_subscriptions():
    """Return the configured/subscribed channel list (Phase 3)."""
    channels, source = await _fetch_subscribed_channels()
    channel_names = {ch: _channel_name_map.get(ch, ch) for ch in channels}
    return {"channels": channels, "channel_names": channel_names, "count": len(channels), "source": source}
