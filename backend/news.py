"""
backend/news.py
News headline fetching via RSS (no API key required).
Exposes GET /news and DELETE /news/cache.
"""

import asyncio
import hashlib
import json as _json
import logging
import os
import re
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import feedparser
import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
import session_log

router = APIRouter()
logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
_FEEDS_ENV       = os.getenv(
    "NEWS_FEEDS",
    "https://feeds.bbci.co.uk/news/rss.xml,"
    "https://feeds.reuters.com/reuters/topNews,"
    "https://feeds.npr.org/1001/rss.xml",
)
_PER_FEED        = int(os.getenv("NEWS_PER_FEED", "5"))
_LLM_LIMIT       = int(os.getenv("NEWS_LLM_LIMIT", "10"))
_CACHE_SECONDS   = int(os.getenv("NEWS_CACHE_SECONDS", "900"))
_SYNTHESIS_ON    = os.getenv("NEWS_SYNTHESIS_ENABLED", "true").lower() in ("1", "true", "yes")
_SYNTHESIS_MAX   = int(os.getenv("NEWS_SYNTHESIS_MAX_HEADLINES", "40"))

# ── Category config ───────────────────────────────────────────────────────────
_CATEGORY_LABELS: dict[str, str] = {
    "world":         "WORLD HEADLINES",
    "us":            "US NEWS",
    "technology":    "TECHNOLOGY",
    "business":      "BUSINESS",
    "science":       "SCIENCE",
    "health":        "HEALTH",
    "sports":        "SPORTS",
    "entertainment": "ENTERTAINMENT",
}

# Default feeds per category — used when the env var is not set
_CATEGORY_DEFAULT_FEEDS: dict[str, str] = {
    "world": (
        "https://feeds.bbci.co.uk/news/rss.xml,"
        "https://rss.nytimes.com/services/xml/rss/nyt/World.xml,"
        "https://apnews.com/index.rss,"
        "https://feeds.reuters.com/reuters/topNews"
    ),
    "us": (
        "https://feeds.npr.org/1001/rss.xml,"
        "https://rss.nytimes.com/services/xml/rss/nyt/US.xml,"
        "https://abcnews.go.com/abcnews/topstories,"
        "https://www.cbsnews.com/latest/rss/main"
    ),
    "technology": (
        "https://feeds.arstechnica.com/arstechnica/index,"
        "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml"
    ),
    "business": (
        "https://feeds.content.dowjones.io/public/rss/RSSUSnews,"
        "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml"
    ),
    "science": (
        "https://www.sciencedaily.com/rss/all.xml,"
        "https://rss.nytimes.com/services/xml/rss/nyt/Science.xml"
    ),
    "health": (
        "https://rss.nytimes.com/services/xml/rss/nyt/Health.xml,"
        "https://feeds.npr.org/1128/rss.xml"
    ),
    "sports": (
        "https://www.espn.com/espn/rss/news,"
        "https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml"
    ),
    "entertainment": (
        "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml,"
        "https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml"
    ),
}

# ── Synthesis prompt ──────────────────────────────────────────────────────────
NEWS_SYNTHESIS_PROMPT = """
You are a news editor. Below is a JSON array of raw headlines from multiple news sources.
Group headlines that refer to the same real-world story.
For each group, produce:
- "headline": a single neutral synthesised headline (plain prose, no markdown)
- "summary": one concise sentence summarising the story (plain prose, no markdown)
- "sources": the original objects for every headline in the group, unchanged

Return ONLY a valid JSON array. No commentary, no markdown fences.

Headlines:
{headlines_json}
""".strip()

# ── In-memory caches ─────────────────────────────────────────────────────────
# Raw headlines cache — populated by GET /news (fast parallel fetch)
_raw_cache: dict   = {}  # f"news_{category}" → {ts, data}
# Synthesis cache — populated by background task after raw fetch
_synth_cache: dict = {}  # f"news_{category}" → {ts, stories}
# Tracks which categories have synthesis in progress
_synth_busy: set   = set()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _source_name_from_url(url: str) -> str:
    """Derive a short human-readable source label from a feed URL."""
    labels = {
        "bbci.co.uk":          "BBC News",
        "reuters.com":         "Reuters",
        "npr.org":             "NPR",
        "apnews":              "AP News",
        "arstechnica.com":     "Ars Technica",
        "hnrss.org":           "Hacker News",
        "theguardian.com":     "The Guardian",
        "nytimes.com":         "New York Times",
        "dowjones.io":         "Wall Street Journal",
        "wsj.com":             "Wall Street Journal",
        "techcrunch.com":      "TechCrunch",
        "wired.com":           "WIRED",
        "abcnews.go.com":      "ABC News",
        "cbsnews.com":         "CBS News",
        "nbcnews.com":         "NBC News",
        "sciencedaily.com":    "Science Daily",
        "espn.com":            "ESPN",
        "politico.com":        "POLITICO",
        "latimes.com":         "LA Times",
        "chicagotribune.com":  "Chicago Tribune",
        "seattletimes.com":    "Seattle Times",
        "mercurynews.com":     "Mercury News",
        "newsday.com":         "Newsday",
        "vox.com":             "Vox",
        "newsweek.com":        "Newsweek",
        "foxnews.com":         "Fox News",
        "businessinsider.com": "Business Insider",
        "yahoo.com":           "Yahoo News",
    }
    for key, label in labels.items():
        if key in url:
            return label
    try:
        from urllib.parse import urlparse
        return urlparse(url).netloc.replace("www.", "").replace("feeds.", "")
    except Exception:
        return "Unknown"


def _get_feeds_for_category(category: str) -> list[str]:
    """Return the feed URL list for a given category, checking env vars first."""
    env_key = f"NEWS_FEEDS_{category.upper()}"
    raw = os.getenv(env_key, "")
    if raw.strip():
        return [u.strip() for u in raw.split(",") if u.strip()]
    default = _CATEGORY_DEFAULT_FEEDS.get(category)
    if default:
        return [u.strip() for u in default.split(",") if u.strip()]
    # Unknown category — no feeds configured
    return []


def _parse_feed(url: str) -> list[dict]:
    """Fetch and parse a single RSS feed. Returns up to _PER_FEED items."""
    try:
        feed = feedparser.parse(url, request_headers={"User-Agent": "STARLING/1.0"})
    except Exception:
        return []

    source = feed.feed.get("title", _source_name_from_url(url))
    items: list[dict] = []

    for entry in feed.entries[:_PER_FEED]:
        title   = entry.get("title", "").strip()
        summary = entry.get("summary", entry.get("description", "")).strip()
        link    = entry.get("link", "")

        # Strip inline HTML from summary
        if "<" in summary:
            summary = re.sub(r"<[^>]+>", " ", summary).strip()
            summary = re.sub(r"\s{2,}", " ", summary)

        if len(summary) > 280:
            summary = summary[:280].rsplit(" ", 1)[0] + "\u2026"

        pub_raw = entry.get("published", entry.get("updated", ""))
        pub    = ""
        pub_ts = 0.0
        try:
            pub_dt = parsedate_to_datetime(pub_raw)
            pub_ts = pub_dt.timestamp()
            today  = datetime.now(timezone.utc).date()
            pub    = pub_dt.strftime("%H:%M") if pub_dt.date() == today else pub_dt.strftime("%b %-d")
        except Exception:
            pass

        dedup_key = hashlib.md5(title.lower().encode()).hexdigest()[:8]

        items.append({
            "id":      dedup_key,
            "title":   title,
            "summary": summary,
            "source":  source,
            "link":    link,
            "pub":     pub,
            "pub_ts":  pub_ts,
        })

    return items


def _build_llm_context(headlines: list[dict]) -> str:
    """Build a compact plain-prose summary of the top headlines for LLM injection."""
    now   = datetime.now(timezone.utc).strftime("%A, %B %d at %I:%M %p UTC")
    lines = [f"[NEWS BRIEFING \u2014 {now}]"]
    for i, h in enumerate(headlines[:_LLM_LIMIT], 1):
        line = f"{i}. {h['title']} ({h['source']})"
        if h["summary"] and h["summary"].lower() != h["title"].lower():
            line += f" \u2014 {h['summary']}"
        lines.append(line)
    return "\n".join(lines)


async def _synthesise_headlines(headlines: list[dict]) -> list[dict] | None:
    """
    Call the local LLM to cluster raw headlines into deduplicated story groups.
    Returns None on any failure; caller falls back to the raw headline list.
    """
    if not headlines:
        return None

    capped = [
        {
            "name":      h["source"],
            "title":     h["title"],
            "link":      h["link"],
            "published": h["pub"],
        }
        for h in headlines[:_SYNTHESIS_MAX]
    ]
    prompt = NEWS_SYNTHESIS_PROMPT.format(headlines_json=_json.dumps(capped, ensure_ascii=False))

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

        if llm_backend == "llama":
            content = data["choices"][0]["message"]["content"]
        else:
            content = data["message"]["content"]

        parsed = _json.loads(content)
        # LLM may wrap the array in a top-level object key
        if isinstance(parsed, dict):
            for key in ("stories", "groups", "synthesised", "articles", "headlines"):
                if key in parsed and isinstance(parsed[key], list):
                    parsed = parsed[key]
                    break
        if not isinstance(parsed, list):
            return None
        return parsed

    except Exception as exc:
        logger.warning("News synthesis failed: %s", exc)
        return None


async def _fetch_all_parallel(category: str) -> list[dict]:
    """
    Fetch all RSS feeds for a category concurrently in a thread pool.
    Returns deduplicated, newest-first headline list.
    Approach B: parallel I/O means overall wait ≈ slowest single feed
    rather than the sum of all feed latencies.
    """
    feed_urls = _get_feeds_for_category(category)
    loop      = asyncio.get_running_loop()

    results = await asyncio.gather(
        *[loop.run_in_executor(None, _parse_feed, url) for url in feed_urls],
        return_exceptions=True,
    )

    all_items: list[dict] = []
    seen_ids: set = set()
    for r in results:
        if isinstance(r, Exception):
            continue
        for item in r:
            if item["id"] not in seen_ids:
                seen_ids.add(item["id"])
                all_items.append(item)

    all_items.sort(key=lambda h: h["pub_ts"], reverse=True)
    return all_items


async def _run_synthesis_bg(headlines: list[dict], category: str) -> None:
    """
    Background task: synthesise headlines and write to _synth_cache.
    Runs after GET /news has already returned raw data to the client.
    """
    cache_key = f"news_{category}"
    _synth_busy.add(cache_key)
    try:
        stories = await _synthesise_headlines(headlines)
        if stories:
            _synth_cache[cache_key] = {"ts": time.time(), "stories": stories}
            logger.info("News synthesis complete for %r: %d stories", category, len(stories))
        else:
            logger.info("News synthesis returned nothing for %r, keeping raw view", category)
    finally:
        _synth_busy.discard(cache_key)


# ── Endpoints ─────────────────────────────────────────────────────────────────

VALID_CATEGORIES = set(_CATEGORY_LABELS.keys())


def _attach_synthesis(data: dict, category: str) -> dict:
    """
    Return a shallow copy of data with the current synthesis state merged in.
    Does not mutate the cached dict.
    """
    cache_key = f"news_{category}"
    synth     = _synth_cache.get(cache_key)
    out       = dict(data)
    if synth:
        out["synthesised"]      = synth["stories"]
        out["synthesis_status"] = "ready"
    elif cache_key in _synth_busy:
        out["synthesis_status"] = "pending"
    else:
        out["synthesis_status"] = "none" if not _SYNTHESIS_ON else "pending"
    return out


@router.get("/news")
async def get_news(
    category:         str            = Query("world"),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """
    Return raw headlines immediately (Approach A/B — fast first render).
    Synthesis runs as a background task; poll GET /news/synthesised for the result.
    Feeds are fetched in parallel so total wait ≈ slowest single feed, not their sum.
    """
    category = category.lower().strip()
    if category not in VALID_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown news category '{category}'. Valid categories: {sorted(VALID_CATEGORIES)}",
        )

    _t0 = time.time()
    session_log.log("tool_call", {
        "endpoint": "/news",
        "method":   "GET",
        "params_summary": f"category={category}",
    })

    cache_key = f"news_{category}"

    # ── Serve from raw cache if fresh ─────────────────────────────────────────
    cached = _raw_cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_SECONDS:
        # Synthesis may have completed since the raw cache was written — merge it in
        resp = _attach_synthesis(cached["data"], category)
        # Re-trigger synthesis if it hasn't started yet (e.g. after a server restart)
        if _SYNTHESIS_ON and cache_key not in _synth_busy and not _synth_cache.get(cache_key):
            background_tasks.add_task(_run_synthesis_bg, cached["data"]["headlines"], category)
        _headlines = cached["data"].get("headlines", [])
        _first = _headlines[0]["title"][:100] if _headlines else ""
        session_log.log("tool_result", {
            "endpoint":      "/news",
            "status_code":   200,
            "duration_ms":   round((time.time() - _t0) * 1000),
            "result_summary": f"source=cache, total={len(_headlines)}, first={_first}",
        })
        return resp

    feed_urls = _get_feeds_for_category(category)
    if not feed_urls:
        raise HTTPException(
            status_code=400,
            detail=f"No feeds configured for category '{category}'.",
        )

    # ── Parallel RSS fetch (Approach B core speedup) ──────────────────────────
    all_items = await _fetch_all_parallel(category)

    by_source: dict[str, list] = {}
    for item in all_items:
        by_source.setdefault(item["source"], []).append(item)

    data = {
        "headlines":          all_items,
        "by_source":          by_source,
        "total":              len(all_items),
        "llm_context":        _build_llm_context(all_items),
        "fetched_at":         datetime.now(timezone.utc).isoformat(),
        "sources":            list(by_source.keys()),
        "category":           category,
        "category_label":     _CATEGORY_LABELS[category],
        "synthesised":        None,
        "synthesis_enabled":  _SYNTHESIS_ON,
        "synthesis_status":   "pending" if _SYNTHESIS_ON else "disabled",
    }

    _raw_cache[cache_key] = {"ts": time.time(), "data": data}

    # ── Kick off background synthesis (Approach A) ────────────────────────────
    if _SYNTHESIS_ON and cache_key not in _synth_busy:
        _synth_cache.pop(cache_key, None)  # clear stale synth for this fresh fetch
        background_tasks.add_task(_run_synthesis_bg, all_items, category)

    _first_hl = all_items[0]["title"][:100] if all_items else ""
    session_log.log("tool_result", {
        "endpoint":      "/news",
        "status_code":   200,
        "duration_ms":   round((time.time() - _t0) * 1000),
        "result_summary": f"total={len(all_items)}, first={_first_hl}",
    })
    return data


@router.get("/news/synthesised")
async def get_synthesised(category: str = Query("world")):
    """
    Poll endpoint for synthesis progress (Approach A frontend polling).
    Returns one of:
      {status: 'ready',   stories: [...]}  — synthesis complete, stories available
      {status: 'pending'}                  — synthesis in progress, try again shortly
      {status: 'none'}                     — synthesis disabled or failed
    """
    category  = category.lower().strip()
    cache_key = f"news_{category}"
    synth     = _synth_cache.get(cache_key)
    if synth:
        return {"status": "ready", "stories": synth["stories"]}
    if cache_key in _synth_busy:
        return {"status": "pending"}
    return {"status": "none"}


@router.delete("/news/cache")
async def bust_news_cache():
    """Force-clear all news caches so the next GET /news fetches live data."""
    _raw_cache.clear()
    _synth_cache.clear()
    _synth_busy.clear()
    return {"status": "cleared"}
