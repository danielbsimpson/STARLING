"""Tests for backend papers tool and frontend co-change wiring."""

from __future__ import annotations

import asyncio
import importlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def papers_mod(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    import papers

    importlib.reload(papers)
    papers._cache.clear()
    return papers


@pytest.fixture
def client(papers_mod):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(papers_mod.router)
    return TestClient(app)


class _FakeResponse:
    def __init__(self, status_code=200, text="", payload=None):
        self.status_code = status_code
        self.text = text
        self._payload = payload or {}

    def json(self):
        return self._payload


def _install_fake_feedparser(monkeypatch, papers_mod, parse_fn):
    fake_mod = type("_FakeFeedparser", (), {"parse": staticmethod(parse_fn)})
    monkeypatch.setattr(papers_mod, "feedparser", fake_mod)


def test_fetch_arxiv_uses_encoded_query_and_submitted_date_sort(monkeypatch, papers_mod):
    captured = {}

    class _Entry:
        def __init__(self):
            self._data = {
                "title": "Diffusion Models for Weather",
                "summary": "Forecast paper",
                "link": "https://arxiv.org/abs/1234.5678",
                "id": "http://arxiv.org/abs/1234.5678v1",
                "published": "2026-06-02T12:00:00Z",
                "authors": [{"name": "A. Researcher"}],
            }

        def get(self, key, default=None):
            return self._data.get(key, default)

    class _Feed:
        entries = [_Entry()]

    class _Client:
        def __init__(self, timeout, follow_redirects):
            captured["timeout"] = timeout
            captured["follow_redirects"] = follow_redirects

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, headers=None):
            captured["url"] = url
            captured["headers"] = headers or {}
            return _FakeResponse(status_code=200, text="<feed></feed>")

    monkeypatch.setattr(papers_mod.httpx, "AsyncClient", _Client)
    _install_fake_feedparser(monkeypatch, papers_mod, lambda _: _Feed())

    out = asyncio.run(papers_mod._fetch_arxiv("diffusion models & control", "week", 5))

    assert captured["timeout"] == papers_mod._PAPERS_HTTP_TIMEOUT_S
    assert captured["follow_redirects"] is False
    assert captured["headers"].get("User-Agent") == "STARLING/1.0"
    assert captured["url"].startswith(papers_mod._ARXIV_BASE)
    assert "search_query=all:diffusion%20models%20%26%20control" in captured["url"]
    assert "sortBy=submittedDate" in captured["url"]
    assert "sortOrder=descending" in captured["url"]
    assert out and out[0]["source"] == "arXiv"


def test_semantic_scholar_soft_fails_on_429_and_network(monkeypatch, papers_mod, caplog):
    class _Client429:
        def __init__(self, timeout, follow_redirects):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, params=None, headers=None):
            return _FakeResponse(status_code=429, payload={})

    monkeypatch.setattr(papers_mod.httpx, "AsyncClient", _Client429)
    out_429 = asyncio.run(papers_mod._fetch_semantic_scholar("rag", "week", 5))
    assert out_429 == []
    assert "rate-limited" in caplog.text.lower()

    class _ClientFail:
        def __init__(self, timeout, follow_redirects):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, params=None, headers=None):
            raise RuntimeError("network down")

    monkeypatch.setattr(papers_mod.httpx, "AsyncClient", _ClientFail)
    out_err = asyncio.run(papers_mod._fetch_semantic_scholar("rag", "week", 5))
    assert out_err == []


def test_since_week_filters_old_papers(papers_mod):
    cutoff = papers_mod._since_cutoff("week")
    assert cutoff is not None

    assert papers_mod._within("2099-01-01", cutoff) is True
    assert papers_mod._within("2000-01-01", cutoff) is False


def test_merge_dedup_and_limit_and_sources_used(papers_mod):
    arxiv = [
        {
            "id": "a1",
            "title": "Retrieval Augmented Generation in Practice",
            "authors": ["A"],
            "summary": "a",
            "published": "2026-06-02",
            "url": "u1",
            "source": "arXiv",
            "venue": None,
            "citation_count": None,
        },
        {
            "id": "a2",
            "title": "Graph Neural Networks at Scale",
            "authors": ["B"],
            "summary": "b",
            "published": "2026-06-01",
            "url": "u2",
            "source": "arXiv",
            "venue": None,
            "citation_count": None,
        },
    ]
    s2 = [
        {
            "id": "s1",
            "title": "Retrieval-Augmented Generation in Practice",
            "authors": ["C"],
            "summary": "dup",
            "published": "2026-06-03",
            "url": "u3",
            "source": "Semantic Scholar",
            "venue": "ACL",
            "citation_count": 9,
        },
        {
            "id": "s2",
            "title": "Diffusion Models for Control",
            "authors": ["D"],
            "summary": "d",
            "published": "2026-05-30",
            "url": "u4",
            "source": "Semantic Scholar",
            "venue": "NeurIPS",
            "citation_count": 21,
        },
    ]

    papers, sources = papers_mod._merge_and_filter(arxiv, s2, "any", 3)

    assert len(papers) == 3
    titles = [p["title"] for p in papers]
    assert "Retrieval Augmented Generation in Practice" in titles or "Retrieval-Augmented Generation in Practice" in titles
    assert "arXiv" in sources
    assert "Semantic Scholar" in sources


def test_build_llm_context_prefix_caps_and_empty(papers_mod):
    papers_mod._PAPERS_LLM_LIMIT = 1
    papers_mod._PAPERS_SUMMARY_CHARS = 20

    papers = [
        {
            "title": "Paper One",
            "authors": ["Ada Lovelace", "Bob"],
            "summary": "This summary should be truncated because it is long.",
            "published": "2026-06-02",
            "source": "arXiv",
            "citation_count": 12,
        },
        {
            "title": "Paper Two",
            "authors": ["Carol"],
            "summary": "second",
            "published": "2026-06-01",
            "source": "Semantic Scholar",
            "citation_count": None,
        },
    ]

    ctx = papers_mod._build_llm_context(papers, "diffusion", "week")
    assert ctx is not None
    assert ctx.startswith("[RESEARCH PAPERS - diffusion, this week - as of")
    assert "1. Paper One - Ada Lovelace et al." in ctx
    assert "cited 12x" in ctx
    assert "2. Paper Two" not in ctx

    assert papers_mod._build_llm_context([], "x", "week") is None


def test_cache_hit_and_cache_clear(client, monkeypatch, papers_mod):
    calls = {"n": 0}

    async def _fake_arxiv(topic, since, limit):
        calls["n"] += 1
        return [{
            "id": "a1",
            "title": "Tiny",
            "authors": ["A"],
            "summary": "S",
            "published": "2026-06-02",
            "url": "u",
            "source": "arXiv",
            "venue": None,
            "citation_count": None,
        }]

    monkeypatch.setattr(papers_mod, "_fetch_arxiv", _fake_arxiv)
    monkeypatch.setattr(papers_mod, "_fetch_semantic_scholar", lambda *args, **kwargs: asyncio.sleep(0, result=[]))

    r1 = client.get("/papers", params={"topic": "diffusion", "since": "week", "source": "arxiv"})
    r2 = client.get("/papers", params={"topic": "diffusion", "since": "week", "source": "arxiv"})

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert calls["n"] == 1

    cleared = client.delete("/papers/cache")
    assert cleared.status_code == 200
    assert cleared.json()["status"] == "cleared"

    r3 = client.get("/papers", params={"topic": "diffusion", "since": "week", "source": "arxiv"})
    assert r3.status_code == 200
    assert calls["n"] == 2


def test_endpoint_soft_fail_empty(client, monkeypatch, papers_mod):
    monkeypatch.setattr(papers_mod, "_fetch_arxiv", lambda *args, **kwargs: asyncio.sleep(0, result=[]))
    monkeypatch.setattr(papers_mod, "_fetch_semantic_scholar", lambda *args, **kwargs: asyncio.sleep(0, result=[]))

    res = client.get("/papers", params={"topic": "obscure topic", "since": "week", "source": "auto"})
    assert res.status_code == 200
    body = res.json()
    assert body["papers"] == []
    assert body["total"] == 0
    assert body["llm_context"] is None


def test_limit_clamp_and_invalid_literals(client, monkeypatch, papers_mod):
    async def _fake_arxiv(topic, since, limit):
        # limit should already be clamped before it reaches fetchers
        assert limit == papers_mod._PAPERS_MAX_RESULTS
        return []

    monkeypatch.setattr(papers_mod, "_fetch_arxiv", _fake_arxiv)

    ok = client.get("/papers", params={"topic": "ai", "since": "week", "source": "arxiv", "limit": 999})
    assert ok.status_code == 400  # topic shorter than min chars

    ok2 = client.get("/papers", params={"topic": "graph neural networks", "since": "week", "source": "arxiv", "limit": 999})
    assert ok2.status_code == 200

    bad_since = client.get("/papers", params={"topic": "graph neural networks", "since": "fortnight"})
    assert bad_since.status_code == 422

    bad_source = client.get("/papers", params={"topic": "graph neural networks", "source": "google"})
    assert bad_source.status_code == 422


def test_ssrf_guard_hosts_are_fixed(monkeypatch, papers_mod):
    captured_urls = []

    class _Client:
        def __init__(self, timeout, follow_redirects):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, headers=None, params=None):
            # _fetch_arxiv passes full URL; _fetch_semantic_scholar passes fixed URL + params
            captured_urls.append(url)
            return _FakeResponse(status_code=500, text="", payload={})

    monkeypatch.setattr(papers_mod.httpx, "AsyncClient", _Client)
    _install_fake_feedparser(monkeypatch, papers_mod, lambda _: type("_F", (), {"entries": []})())

    topic = "http://evil.local/?x=1"
    asyncio.run(papers_mod._fetch_arxiv(topic, "week", 3))
    asyncio.run(papers_mod._fetch_semantic_scholar(topic, "week", 3))

    assert captured_urls[0].startswith("http://export.arxiv.org/api/query")
    assert captured_urls[1].startswith("https://api.semanticscholar.org/graph/v1/paper/search")


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
def test_detect_papers_trigger_node_runtime():
    root = Path(__file__).resolve().parents[1]
    module_path = (root / "frontend" / "papers-panel.js").as_posix()

    node_code = f"""
globalThis.document = {{ getElementById: () => null }};
const mod = await import('file:///{module_path}');
const a = mod.detectPapersTrigger('any new papers on graph neural networks this week');
const b = mod.detectPapersTrigger("what's the weather");
const c = mod.detectPapersTrigger('papers on ai');
console.log(JSON.stringify({{ a, b, c }}));
"""

    result = subprocess.run(
        ["node", "--input-type=module", "-e", node_code],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr

    parsed = json.loads(result.stdout.strip())
    assert parsed["a"] == {"topic": "graph neural networks", "since": "week"}
    assert parsed["b"] is None
    assert parsed["c"] is None  # topic too short (< 3 chars after extraction)


def test_cochange_integrity_for_papers_hooks_present():
    root = Path(__file__).resolve().parents[1]
    fuzzy = (root / "frontend" / "fuzzy-tool-detect.js").read_text(encoding="utf-8")
    app_js = (root / "frontend" / "app.js").read_text(encoding="utf-8")

    assert "toolName: 'Papers'" in fuzzy
    assert "case 'Papers':" in app_js
    assert "detectPapersTrigger(text)" in app_js
