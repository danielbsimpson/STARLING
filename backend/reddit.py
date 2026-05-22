"""
backend/reddit.py
Reddit social feed via public JSON API (no auth required for Phase 1).
Optional PRAW-based subscription discovery when credentials are configured.
Exposes GET /reddit, GET /reddit/synthesised, GET /reddit/subscriptions,
and DELETE /reddit/cache.
"""

import asyncio
import json
import logging
import os
import re
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query

import session_log

router = APIRouter()
logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
_REDDIT_SUBS_ENV = os.getenv("REDDIT_SUBREDDITS", "worldnews,technology,science,gaming")
_LIMIT_PER_SUB   = int(os.getenv("REDDIT_LIMIT_PER_SUB", "10"))
_CACHE_SECONDS   = int(os.getenv("REDDIT_CACHE_SECONDS", "900"))
_DEFAULT_SORT    = os.getenv("REDDIT_SORT", "hot")
_SYNTHESIS_ON    = os.getenv("REDDIT_SYNTHESIS_ENABLED", "true").lower() in ("1", "true", "yes")

_SUB_NAME_RE = re.compile(r"^[A-Za-z0-9_]{1,50}$")

_DEFAULT_SUBS: list[str] = [
    s.strip()
    for s in _REDDIT_SUBS_ENV.split(",")
    if s.strip() and _SUB_NAME_RE.match(s.strip())
]

# ── Phase 2 — PRAW credentials (optional) ─────────────────────────────────────
_PRAW_CLIENT_ID     = os.getenv("REDDIT_CLIENT_ID", "")
_PRAW_CLIENT_SECRET = os.getenv("REDDIT_CLIENT_SECRET", "")
_PRAW_USERNAME      = os.getenv("REDDIT_USERNAME", "")
_PRAW_PASSWORD      = os.getenv("REDDIT_PASSWORD", "")
_PRAW_CONFIGURED: bool = bool(
    _PRAW_CLIENT_ID and _PRAW_CLIENT_SECRET and _PRAW_USERNAME and _PRAW_PASSWORD
)

# ── In-memory caches ──────────────────────────────────────────────────────────
_raw_cache: dict   = {}   # cache_key → {"ts": float, "data": dict}
_synth_cache: dict = {}   # cache_key → {"ts": float, "result": dict}
_synth_busy: set   = set()
_subs_cache: dict  = {}   # {"ts": float, "subs": list[str]}

# ── Synthesis prompt ──────────────────────────────────────────────────────────
REDDIT_SYNTHESIS_PROMPT = """
You are a social media analyst summarising Reddit posts for a voice assistant.
Below is a JSON array of top Reddit posts from one or more subreddits.
For each subreddit present, produce a brief spoken summary of its top 3 posts.
Return ONLY a valid JSON object with:
- "briefing": a plain-prose spoken summary covering all subreddits (1-2 sentences per subreddit, no markdown)
- "by_subreddit": an object mapping each subreddit name to { "summary": "...", "top_posts": ["title1", "title2", "title3"] }
Do not use asterisks, hyphens as bullet points, or any markdown formatting in "briefing" since it will be read aloud.

Posts:
{posts_json}
""".strip()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _human_age(created_utc: float) -> str:
    """Convert a UTC epoch timestamp to a human-readable relative time string."""
    delta = time.time() - created_utc
    if delta < 3600:
        return f"{int(delta // 60)}m ago"
    if delta < 86400:
        return f"{int(delta // 3600)}h ago"
    return f"{int(delta // 86400)}d ago"


def _sanitise_sub(name: str) -> str | None:
    """Return the subreddit name if it passes the safety regex, else None."""
    name = name.strip()
    return name if _SUB_NAME_RE.match(name) else None


# ── Fetching ──────────────────────────────────────────────────────────────────

async def _fetch_subreddit_posts(
    subreddit: str, sort: str = "hot", limit: int = 10
) -> list[dict]:
    """Fetch hot posts from a single subreddit via the public JSON API."""
    url = (
        f"https://www.reddit.com/r/{subreddit}/{sort}.json"
        f"?limit={limit}&raw_json=1"
    )
    headers = {"User-Agent": "STARLING/1.0 (personal assistant; read-only; contact: local)"}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            logger.warning("Reddit fetch for r/%s returned HTTP %d", subreddit, resp.status_code)
            return []
        children = resp.json()["data"]["children"]
    except Exception as exc:
        logger.warning("Reddit fetch error for r/%s: %s", subreddit, exc)
        return []

    posts: list[dict] = []
    for child in children:
        d = child.get("data", {})
        title = d.get("title", "").strip()
        if not title:
            continue
        if len(title) > 300:
            title = title[:300].rsplit(" ", 1)[0] + "\u2026"

        selftext = d.get("selftext", "").strip()
        selftext = re.sub(r"<[^>]+>", " ", selftext).strip()
        selftext = re.sub(r"\s{2,}", " ", selftext)
        if len(selftext) > 280:
            selftext = selftext[:280].rsplit(" ", 1)[0] + "\u2026"

        thumbnail = d.get("thumbnail", "")
        if not (isinstance(thumbnail, str) and thumbnail.startswith("http")):
            thumbnail = None

        author = d.get("author", "[deleted]")
        if author and author != "[deleted]":
            author = f"u/{author}"

        created_utc = float(d.get("created_utc", 0.0))
        posts.append({
            "id":           d.get("id", ""),
            "title":        title,
            "score":        int(d.get("score", 0)),
            "num_comments": int(d.get("num_comments", 0)),
            "author":       author,
            "subreddit":    d.get("subreddit", subreddit),
            "url":          d.get("url", ""),
            "permalink":    f"https://www.reddit.com{d.get('permalink', '')}",
            "selftext":     selftext,
            "is_self":      bool(d.get("is_self", False)),
            "created_utc":  created_utc,
            "age":          _human_age(created_utc),
            "flair":        d.get("link_flair_text") or None,
            "thumbnail":    thumbnail,
        })

    return posts


async def _fetch_all_parallel(
    subreddits: list[str], sort: str, limit: int
) -> tuple[list[dict], dict[str, list[dict]]]:
    """Fetch all subreddits concurrently and return (flat_list_by_score, by_subreddit)."""
    results = await asyncio.gather(
        *[_fetch_subreddit_posts(sub, sort, limit) for sub in subreddits],
        return_exceptions=True,
    )
    by_subreddit: dict[str, list[dict]] = {}
    for sub, result in zip(subreddits, results):
        if isinstance(result, Exception):
            logger.warning("Exception fetching r/%s: %s", sub, result)
            continue
        if result:
            by_subreddit[sub] = result

    all_posts = [p for posts in by_subreddit.values() for p in posts]
    all_posts.sort(key=lambda p: p["score"], reverse=True)
    return all_posts, by_subreddit


def _build_llm_context(
    all_posts: list[dict],
    subreddits: list[str],
    by_subreddit: dict[str, list[dict]],
) -> str:
    """Build a compact plain-prose summary of top posts for LLM injection."""
    now = datetime.now(timezone.utc).strftime("%A, %B %d at %I:%M %p UTC")
    lines = [f"[REDDIT FEED \u2014 {now}]"]
    for sub in subreddits:
        sub_posts = by_subreddit.get(sub, [])
        if not sub_posts:
            continue
        lines.append(f"r/{sub}:")
        for i, p in enumerate(sub_posts[:_LIMIT_PER_SUB], 1):
            lines.append(
                f"  {i}. {p['title']} (\u2191{p['score']} | {p['num_comments']} comments)"
            )
    return "\n".join(lines)


# ── Synthesis ──────────────────────────────────────────────────────────────────

async def _synthesise_posts(posts: list[dict]) -> dict | None:
    """Call the local LLM to produce a briefing dict. Returns None on any failure."""
    if not posts:
        return None

    capped = [
        {
            "subreddit":    p["subreddit"],
            "title":        p["title"],
            "score":        p["score"],
            "num_comments": p["num_comments"],
        }
        for p in posts[:50]
    ]
    prompt = REDDIT_SYNTHESIS_PROMPT.format(posts_json=json.dumps(capped, ensure_ascii=False))

    llm_backend = os.getenv("LLM_BACKEND", "ollama").lower()
    if llm_backend == "llama":
        base_url = os.getenv("LLAMA_SERVER_URL", "http://localhost:8080")
        payload = {
            "model":           os.getenv("LLAMA_MODEL", "llama3.1-8b"),
            "messages":        [{"role": "user", "content": prompt}],
            "stream":          False,
            "temperature":     0.1,
            "response_format": {"type": "json_object"},
        }
        endpoint = f"{base_url}/v1/chat/completions"
    else:
        base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        payload = {
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

        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            return None
        if "briefing" not in parsed or "by_subreddit" not in parsed:
            return None
        return parsed

    except Exception as exc:
        logger.warning("Reddit synthesis failed: %s", exc)
        return None


async def _run_synthesis_bg(posts: list[dict], cache_key: str) -> None:
    """Background task: synthesise posts and write result to _synth_cache."""
    _synth_busy.add(cache_key)
    try:
        result = await _synthesise_posts(posts)
        if result:
            _synth_cache[cache_key] = {"ts": time.time(), "result": result}
            logger.info("Reddit synthesis complete for %r", cache_key)
        else:
            logger.info("Reddit synthesis returned nothing for %r", cache_key)
    finally:
        _synth_busy.discard(cache_key)


# ── Phase 2 — PRAW subscription discovery ─────────────────────────────────────

async def _fetch_user_subscriptions() -> list[str]:
    """
    Return the user's subscribed subreddits via PRAW when credentials are
    configured; otherwise return the default list from the env var.
    Results are cached for 3600 seconds.
    """
    if not _PRAW_CONFIGURED:
        return _DEFAULT_SUBS

    cached = _subs_cache.get("subs")
    if cached and (time.time() - cached["ts"]) < 3600:
        return cached["subs"]

    def _praw_get_subs() -> list[str]:
        import praw  # noqa: PLC0415
        reddit = praw.Reddit(
            client_id=_PRAW_CLIENT_ID,
            client_secret=_PRAW_CLIENT_SECRET,
            username=_PRAW_USERNAME,
            password=_PRAW_PASSWORD,
            user_agent="STARLING/1.0 (personal assistant; read-only; contact: local)",
        )
        return [s.display_name for s in reddit.user.subreddits(limit=100)]

    loop = asyncio.get_running_loop()
    try:
        subs = await loop.run_in_executor(None, _praw_get_subs)
        subs = [s for s in subs if _SUB_NAME_RE.match(s)]
        _subs_cache["subs"] = {"ts": time.time(), "subs": subs}
        return subs or _DEFAULT_SUBS
    except Exception as exc:
        logger.warning("PRAW subscription fetch failed: %s", exc)
        return _DEFAULT_SUBS


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/reddit")
async def get_reddit(
    subreddit:        str            = Query(None),
    sort:             str            = Query(None),
    limit:            int            = Query(None),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """
    Return raw Reddit posts immediately.
    Synthesis runs as a background task; poll GET /reddit/synthesised for the result.
    """
    _t0 = time.time()

    # Resolve subreddit list
    if subreddit:
        sub_clean = _sanitise_sub(subreddit)
        if not sub_clean:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid subreddit name '{subreddit}'. "
                    "Only alphanumeric and underscore allowed (max 50 chars)."
                ),
            )
        subreddits = [sub_clean]
    else:
        subreddits = await _fetch_user_subscriptions()

    # Secondary sanitisation guard
    bad = [s for s in subreddits if not _SUB_NAME_RE.match(s)]
    if bad:
        raise HTTPException(status_code=400, detail=f"Invalid subreddit name(s): {bad}")

    resolved_sort  = (sort or _DEFAULT_SORT).lower()
    resolved_limit = max(1, min(25, limit if limit is not None else _LIMIT_PER_SUB))
    cache_key      = "reddit_" + "_".join(sorted(subreddits))

    session_log.log("tool_call", {
        "endpoint":       "/reddit",
        "method":         "GET",
        "params_summary": f"subreddits={subreddits}, sort={resolved_sort}, limit={resolved_limit}",
    })

    # Serve from cache if fresh
    cached = _raw_cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_SECONDS:
        data = dict(cached["data"])
        synth = _synth_cache.get(cache_key)
        if synth:
            data["synthesis_status"] = "ready"
            data["synthesis"] = synth["result"]
        elif cache_key in _synth_busy:
            data["synthesis_status"] = "pending"
        else:
            data["synthesis_status"] = "none"
            if _SYNTHESIS_ON and cache_key not in _synth_busy:
                background_tasks.add_task(_run_synthesis_bg, cached["data"]["posts"], cache_key)
                data["synthesis_status"] = "pending"
        session_log.log("tool_result", {
            "endpoint":       "/reddit",
            "status_code":    200,
            "duration_ms":    round((time.time() - _t0) * 1000),
            "result_summary": f"source=cache, total={data.get('total', 0)}",
        })
        return data

    # Fetch fresh data
    all_posts, by_subreddit = await _fetch_all_parallel(subreddits, resolved_sort, resolved_limit)
    llm_context = _build_llm_context(all_posts, subreddits, by_subreddit)
    now = datetime.now(timezone.utc)

    response_data = {
        "posts":              all_posts,
        "by_subreddit":       by_subreddit,
        "subreddits":         subreddits,
        "total":              len(all_posts),
        "llm_context":        llm_context,
        "fetched_at":         now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fetched_at_display": now.strftime("%H:%M UTC"),
        "cache_age":          0,
        "sort":               resolved_sort,
        "synthesis_enabled":  _SYNTHESIS_ON,
        "synthesis_status":   "none",
    }

    _raw_cache[cache_key] = {"ts": time.time(), "data": response_data}

    if _SYNTHESIS_ON and cache_key not in _synth_busy:
        _synth_cache.pop(cache_key, None)
        background_tasks.add_task(_run_synthesis_bg, all_posts, cache_key)
        response_data["synthesis_status"] = "pending"

    session_log.log("tool_result", {
        "endpoint":       "/reddit",
        "status_code":    200,
        "duration_ms":    round((time.time() - _t0) * 1000),
        "result_summary": f"source=live, total={len(all_posts)}, subreddits={subreddits}",
    })
    return response_data


@router.get("/reddit/synthesised")
async def get_reddit_synthesised(subreddit: str = Query(None)):
    """Poll endpoint for synthesis status. Returns ready/pending/none."""
    if subreddit:
        sub_clean = _sanitise_sub(subreddit)
        if not sub_clean:
            return {"status": "none"}
        subreddits = [sub_clean]
    else:
        subreddits = await _fetch_user_subscriptions()

    cache_key = "reddit_" + "_".join(sorted(subreddits))
    synth = _synth_cache.get(cache_key)
    if synth:
        return {"status": "ready", "result": synth["result"]}
    if cache_key in _synth_busy:
        return {"status": "pending"}
    return {"status": "none"}


@router.get("/reddit/subscriptions")
async def get_reddit_subscriptions():
    """Return the active subreddit list (PRAW-sourced or env var)."""
    subs = await _fetch_user_subscriptions()
    source = "praw" if _PRAW_CONFIGURED else "env"
    return {"subreddits": subs, "source": source, "count": len(subs)}


@router.delete("/reddit/cache")
async def delete_reddit_cache():
    """Clear all in-memory Reddit caches."""
    _raw_cache.clear()
    _synth_cache.clear()
    _synth_busy.clear()
    return {"status": "cleared"}
