"""
backend/papers.py
Research paper briefing via free public APIs (no API key required).

Endpoints:
- GET /papers?topic=<str>&since=<today|week|month|year|any>&source=<arxiv|semanticscholar|auto>&limit=<int>
- DELETE /papers/cache

Upstream APIs:
- arXiv Atom API: http://export.arxiv.org/api/query
- Semantic Scholar Graph API: https://api.semanticscholar.org/graph/v1/paper/search

Normalized item schema:
- {
    id: str,
    title: str,
    authors: list[str],
    summary: str,
    published: "YYYY-MM-DD",
    url: str,
    source: "arXiv" | "Semantic Scholar",
    venue: str | None,
    citation_count: int | None,
  }

Supported since tokens:
- today, week, month, year, any

Environment variables:
- PAPERS_DEFAULT_SINCE (default: week)
- PAPERS_CACHE_SECONDS (default: 1800)
- PAPERS_HTTP_TIMEOUT_S (default: 10)
- PAPERS_LLM_LIMIT (default: 8)
- PAPERS_MAX_RESULTS (default: 20)
- PAPERS_SUMMARY_CHARS (default: 240)
- PAPERS_MIN_TOPIC_CHARS (default: 3)
- PAPERS_DEFAULT_SOURCE (default: auto)
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Query

import session_log

try:
    import feedparser  # type: ignore
except Exception:  # pragma: no cover - only hit in minimal test envs
    feedparser = None

router = APIRouter()
logger = logging.getLogger(__name__)

# -- Config -------------------------------------------------------------------
_PAPERS_DEFAULT_SINCE = os.getenv("PAPERS_DEFAULT_SINCE", "week").strip().lower()
_PAPERS_CACHE_SECONDS = int(os.getenv("PAPERS_CACHE_SECONDS", "1800"))
_PAPERS_HTTP_TIMEOUT_S = float(os.getenv("PAPERS_HTTP_TIMEOUT_S", "10"))
_PAPERS_LLM_LIMIT = int(os.getenv("PAPERS_LLM_LIMIT", "8"))
_PAPERS_MAX_RESULTS = int(os.getenv("PAPERS_MAX_RESULTS", "20"))
_PAPERS_SUMMARY_CHARS = int(os.getenv("PAPERS_SUMMARY_CHARS", "240"))
_PAPERS_MIN_TOPIC_CHARS = int(os.getenv("PAPERS_MIN_TOPIC_CHARS", "3"))
_PAPERS_DEFAULT_SOURCE = os.getenv("PAPERS_DEFAULT_SOURCE", "auto").strip().lower()

if _PAPERS_DEFAULT_SINCE not in {"today", "week", "month", "year", "any"}:
    _PAPERS_DEFAULT_SINCE = "week"

if _PAPERS_DEFAULT_SOURCE not in {"arxiv", "semanticscholar", "auto"}:
    _PAPERS_DEFAULT_SOURCE = "auto"

_ARXIV_BASE = "http://export.arxiv.org/api/query"
_S2_BASE = "https://api.semanticscholar.org/graph/v1/paper/search"
_UA = {"User-Agent": "STARLING/1.0"}
_SINCE_DAYS: dict[str, int | None] = {
    "today": 0,
    "week": 7,
    "month": 31,
    "year": 366,
    "any": None,
}

_cache: dict[str, dict] = {}


def _normalise_topic(topic: str) -> str:
    return re.sub(r"\s+", " ", (topic or "").strip().lower())


def _safe_topic(topic: str) -> str:
    normal = _normalise_topic(topic)
    if len(normal) < _PAPERS_MIN_TOPIC_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"Topic must be at least {_PAPERS_MIN_TOPIC_CHARS} characters.",
        )
    return normal


def _since_cutoff(since: str) -> datetime.date | None:
    token = (since or _PAPERS_DEFAULT_SINCE).strip().lower()
    if token not in _SINCE_DAYS:
        return None

    days = _SINCE_DAYS[token]
    if days is None:
        return None

    today = datetime.now(timezone.utc).date()
    if token == "today":
        return today
    return today - timedelta(days=days)


def _parse_published_date(value: str | None) -> datetime.date | None:
    if not value:
        return None
    s = value.strip()
    if not s:
        return None

    # Prefer strict YYYY-MM-DD first.
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date()
    except Exception:
        pass

    # Handle full ISO datetimes.
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except Exception:
        return None


def _within(published: str | None, cutoff: datetime.date | None) -> bool:
    if cutoff is None:
        return True
    parsed = _parse_published_date(published)
    if parsed is None:
        return False
    return parsed >= cutoff


def _clean_text(value: str | None, max_chars: int | None = None) -> str:
    text = (value or "").strip()
    if "<" in text:
        text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if max_chars and len(text) > max_chars:
        text = text[:max_chars].rsplit(" ", 1)[0] + "..."
    return text


def _published_sort_key(item: dict) -> tuple:
    date_obj = _parse_published_date(item.get("published"))
    citation_count = item.get("citation_count") or 0
    return (date_obj or datetime(1970, 1, 1, tzinfo=timezone.utc).date(), citation_count)


def _title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (title or "").lower())


async def _fetch_arxiv(topic: str, since: str, limit: int) -> list[dict]:
    """Fetch arXiv Atom entries and normalize to the papers schema."""
    _ = since  # Recency filtering is applied in merge/filter for consistency.
    safe_limit = max(1, min(_PAPERS_MAX_RESULTS, int(limit)))
    encoded_topic = quote(topic)
    url = (
        f"{_ARXIV_BASE}?search_query=all:{encoded_topic}"
        f"&sortBy=submittedDate&sortOrder=descending&max_results={safe_limit}"
    )

    try:
        if feedparser is None:
            logger.warning("feedparser unavailable; arXiv fetch disabled")
            return []

        async with httpx.AsyncClient(timeout=_PAPERS_HTTP_TIMEOUT_S, follow_redirects=False) as client:
            resp = await client.get(url, headers=_UA)
            if resp.status_code != 200:
                logger.warning("arXiv returned HTTP %s for topic=%r", resp.status_code, topic)
                return []

        loop = asyncio.get_running_loop()
        feed = await loop.run_in_executor(None, lambda: feedparser.parse(resp.text))

        items: list[dict] = []
        for entry in feed.entries:
            title = _clean_text(entry.get("title"))
            if not title:
                continue

            authors: list[str] = []
            for a in entry.get("authors", []) or []:
                name = _clean_text((a or {}).get("name"))
                if name:
                    authors.append(name)

            published_raw = entry.get("published") or entry.get("updated")
            published = ""
            pub_date = _parse_published_date(published_raw)
            if pub_date:
                published = pub_date.isoformat()

            summary = _clean_text(entry.get("summary"))
            link = _clean_text(entry.get("link"))
            entry_id = _clean_text(entry.get("id"))

            items.append({
                "id": entry_id or hashlib.md5(f"arxiv:{title}".encode("utf-8")).hexdigest()[:16],
                "title": title,
                "authors": authors,
                "summary": summary,
                "published": published,
                "url": link,
                "source": "arXiv",
                "venue": None,
                "citation_count": None,
            })
        return items
    except Exception as exc:
        logger.warning("arXiv fetch failed for topic=%r: %s", topic, exc)
        return []


async def _fetch_semantic_scholar(topic: str, since: str, limit: int) -> list[dict]:
    """Fetch Semantic Scholar paper search results and normalize schema."""
    _ = since  # Recency filtering is applied in merge/filter for consistency.
    safe_limit = max(1, min(_PAPERS_MAX_RESULTS, int(limit)))
    params = {
        "query": topic,
        "limit": safe_limit,
        "fields": "title,abstract,authors,year,publicationDate,url,venue,citationCount,tldr",
    }

    try:
        async with httpx.AsyncClient(timeout=_PAPERS_HTTP_TIMEOUT_S, follow_redirects=False) as client:
            resp = await client.get(_S2_BASE, params=params, headers=_UA)

        if resp.status_code == 429:
            logger.warning("Semantic Scholar rate-limited (429) for topic=%r", topic)
            return []
        if resp.status_code != 200:
            logger.warning("Semantic Scholar returned HTTP %s for topic=%r", resp.status_code, topic)
            return []

        data = resp.json().get("data", [])
        items: list[dict] = []
        for row in data:
            title = _clean_text(row.get("title"))
            if not title:
                continue

            authors = [
                _clean_text(a.get("name"))
                for a in (row.get("authors") or [])
                if _clean_text((a or {}).get("name"))
            ]

            summary = ""
            tldr = row.get("tldr") or {}
            if isinstance(tldr, dict):
                summary = _clean_text(tldr.get("text"))
            if not summary:
                summary = _clean_text(row.get("abstract"))

            published = ""
            pub_date = _parse_published_date(row.get("publicationDate"))
            if pub_date:
                published = pub_date.isoformat()
            else:
                year = row.get("year")
                if isinstance(year, int) and year > 0:
                    published = f"{year:04d}-01-01"

            citation_count = row.get("citationCount")
            if not isinstance(citation_count, int):
                citation_count = None

            paper_id = _clean_text(row.get("paperId"))
            url = _clean_text(row.get("url"))
            if not url and paper_id:
                url = f"https://www.semanticscholar.org/paper/{paper_id}"

            items.append({
                "id": paper_id or hashlib.md5(f"s2:{title}".encode("utf-8")).hexdigest()[:16],
                "title": title,
                "authors": authors,
                "summary": summary,
                "published": published,
                "url": url,
                "source": "Semantic Scholar",
                "venue": _clean_text(row.get("venue")) or None,
                "citation_count": citation_count,
            })
        return items
    except Exception as exc:
        logger.warning("Semantic Scholar fetch failed for topic=%r: %s", topic, exc)
        return []


def _merge_and_filter(arxiv_items: list[dict], s2_items: list[dict], since: str, limit: int) -> tuple[list[dict], list[str]]:
    cutoff = _since_cutoff(since)

    filtered_arxiv = [p for p in arxiv_items if _within(p.get("published"), cutoff)]
    filtered_s2 = [p for p in s2_items if _within(p.get("published"), cutoff)]

    merged: list[dict] = []
    seen_titles: set[str] = set()

    for item in filtered_arxiv + filtered_s2:
        key = _title_key(item.get("title", ""))
        if not key or key in seen_titles:
            continue
        seen_titles.add(key)
        merged.append(item)

    merged.sort(key=_published_sort_key, reverse=True)

    safe_limit = max(1, min(_PAPERS_MAX_RESULTS, int(limit)))
    merged = merged[:safe_limit]

    sources_used: list[str] = []
    if any(p.get("source") == "arXiv" for p in merged):
        sources_used.append("arXiv")
    if any(p.get("source") == "Semantic Scholar" for p in merged):
        sources_used.append("Semantic Scholar")

    return merged, sources_used


def _human_since(since: str) -> str:
    mapping = {
        "today": "today",
        "week": "this week",
        "month": "this month",
        "year": "this year",
        "any": "any time",
    }
    return mapping.get((since or "").lower(), "this week")


def _build_llm_context(papers: list[dict], topic: str, since: str) -> str | None:
    if not papers:
        return None

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [f"[RESEARCH PAPERS - {topic}, {_human_since(since)} - as of {now}]"]

    for idx, paper in enumerate(papers[:_PAPERS_LLM_LIMIT], start=1):
        title = paper.get("title") or "Untitled"
        authors = paper.get("authors") or []
        first_author = authors[0] if authors else "Unknown author"
        source = paper.get("source") or "Unknown source"
        published = paper.get("published") or "unknown date"
        citation_count = paper.get("citation_count")
        summary = _clean_text(paper.get("summary"), max_chars=_PAPERS_SUMMARY_CHARS)

        line = f"{idx}. {title} - {first_author} et al. ({source}, {published})"
        if isinstance(citation_count, int):
            line += f", cited {citation_count}x"
        if summary:
            line += f": {summary}"
        lines.append(line)

    return "\n".join(lines)


@router.get("/papers")
async def get_papers(
    topic: str = Query(...),
    since: Literal["today", "week", "month", "year", "any"] = Query(_PAPERS_DEFAULT_SINCE),
    source: Literal["arxiv", "semanticscholar", "auto"] = Query(_PAPERS_DEFAULT_SOURCE),
    limit: int = Query(8, ge=1),
):
    t0 = time.time()
    safe_topic = _safe_topic(topic)
    safe_since = (since or _PAPERS_DEFAULT_SINCE).lower()
    safe_source = (source or _PAPERS_DEFAULT_SOURCE).lower()
    safe_limit = max(1, min(_PAPERS_MAX_RESULTS, int(limit)))

    session_log.log("tool_call", {
        "endpoint": "/papers",
        "method": "GET",
        "params_summary": f"topic={safe_topic}, since={safe_since}, source={safe_source}, limit={safe_limit}",
    })

    cache_key = f"papers_{safe_source}_{safe_since}_{safe_topic}"
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _PAPERS_CACHE_SECONDS:
        data = cached["data"]
        session_log.log("tool_result", {
            "endpoint": "/papers",
            "status_code": 200,
            "duration_ms": round((time.time() - t0) * 1000),
            "result_summary": f"source=cache, total={data.get('total', 0)}",
        })
        return data

    arxiv_items: list[dict] = []
    s2_items: list[dict] = []

    if safe_source == "arxiv":
        arxiv_items = await _fetch_arxiv(safe_topic, safe_since, safe_limit)
    elif safe_source == "semanticscholar":
        s2_items = await _fetch_semantic_scholar(safe_topic, safe_since, safe_limit)
    else:
        # Auto strategy: arXiv first for recency; Semantic Scholar for fallback/enrichment.
        arxiv_items = await _fetch_arxiv(safe_topic, safe_since, safe_limit)
        cutoff = _since_cutoff(safe_since)
        arxiv_in_window = [p for p in arxiv_items if _within(p.get("published"), cutoff)]
        if not arxiv_in_window or len(arxiv_in_window) < safe_limit:
            s2_items = await _fetch_semantic_scholar(safe_topic, safe_since, safe_limit)

    papers, sources_used = _merge_and_filter(arxiv_items, s2_items, safe_since, safe_limit)

    response_data = {
        "papers": papers,
        "total": len(papers),
        "llm_context": _build_llm_context(papers, safe_topic, safe_since),
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "topic": safe_topic,
        "since": safe_since,
        "source": safe_source,
        "sources_used": sources_used,
    }

    _cache[cache_key] = {"ts": time.time(), "data": response_data}

    session_log.log("tool_result", {
        "endpoint": "/papers",
        "status_code": 200,
        "duration_ms": round((time.time() - t0) * 1000),
        "result_summary": f"source=live, total={response_data['total']}, sources_used={sources_used}",
    })
    return response_data


@router.delete("/papers/cache")
async def delete_papers_cache():
    _cache.clear()
    return {"status": "cleared"}
