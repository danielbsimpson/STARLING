"""browser.py — Page-text extraction endpoint for the in-UI browser panel.

GET /api/browser/page-text?url=<encoded-url>
Returns clean text scraped from the page, suitable for LLM context injection.
Runs server-side to avoid iframe cross-origin restrictions.
"""

import asyncio
import os
import re
import time
from html.parser import HTMLParser
from urllib.parse import unquote

import httpx
import requests as _requests
from fastapi import APIRouter
from pydantic import BaseModel
import session_log

router = APIRouter()

_OLLAMA_BASE  = os.getenv('OLLAMA_BASE_URL', 'http://localhost:11434')
_DEFAULT_MODEL = os.getenv('OLLAMA_MODEL', 'llama3.2:3b')

# Tags whose entire subtree (including nested content) is discarded
_SKIP_TAGS = frozenset({
    'script', 'style', 'noscript', 'head', 'nav', 'footer', 'header',
    'aside', 'iframe', 'svg', 'form', 'button', 'select', 'option',
    'template', 'canvas',
})

# Limit extracted text to keep prompts manageable.
# Wikipedia uses the MediaWiki plain-text API (no HTML noise) so can carry more.
_MAX_CHARS      = 12_000   # general web scraping
_MAX_WIKI_CHARS = 40_000   # Wikipedia API — clean text, worth sending in full


class _TextExtractor(HTMLParser):
    """Strips all HTML tags, retaining only visible text content."""

    def __init__(self):
        super().__init__()
        self._depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self._depth += 1

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS:
            self._depth = max(0, self._depth - 1)

    def handle_data(self, data):
        if self._depth == 0:
            text = data.strip()
            if text:
                self.parts.append(text)


def _extract_text(html: str) -> str:
    ex = _TextExtractor()
    ex.feed(html)
    raw = ' '.join(ex.parts)
    clean = re.sub(r'\s+', ' ', raw).strip()
    if len(clean) > _MAX_CHARS:
        clean = clean[:_MAX_CHARS] + ' \u2026[truncated]'
    return clean


_BROWSER_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/125.0.0.0 Safari/537.36'
    ),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
}

# Wikipedia API User-Agent must identify the tool per WMF policy.
_WIKI_UA = 'STARLING-VoiceUI/1.0 (personal-assistant; non-commercial)'

_WIKI_RE = re.compile(
    r'^https?://(?P<lang>[a-z]{2,3})\.wikipedia\.org/wiki/(?P<title>[^?#]+)',
    re.IGNORECASE,
)


async def _fetch_wikipedia(lang: str, title: str) -> str:
    """Use the MediaWiki API to fetch plain-text article content.

    Runs synchronous `requests` in a thread because httpx is blocked by
    Wikipedia's bot policy while urllib3/requests is accepted.
    """
    def _sync() -> str:
        resp = _requests.get(
            f'https://{lang}.wikipedia.org/w/api.php',
            params={
                'action':        'query',
                'prop':          'extracts',
                'titles':        unquote(title).replace('_', ' '),
                'format':        'json',
                'formatversion': '2',
                'explaintext':   '1',
                'exintro':       '0',
                'exlimit':       '1',
            },
            headers={'User-Agent': _WIKI_UA},
            timeout=15,
        )
        resp.raise_for_status()
        data  = resp.json()
        pages = data.get('query', {}).get('pages', [])
        return pages[0].get('extract', '') if pages else ''

    return await asyncio.get_running_loop().run_in_executor(None, _sync)


@router.get('/browser/page-text')
async def fetch_page_text(url: str):
    """Fetch a URL server-side and return clean page text for LLM context."""
    if not url.startswith(('http://', 'https://')):
        return {'text': None, 'error': 'Invalid URL scheme'}

    _t0 = time.monotonic()
    session_log.log("tool_call", {
        "endpoint": "/api/browser/page-text",
        "method":   "GET",
        "params_summary": f"url={url[:120]}",
    })

    try:
        async with httpx.AsyncClient(
            timeout=15,
            follow_redirects=True,
        ) as client:
            wiki = _WIKI_RE.match(url)
            if wiki:
                raw = await _fetch_wikipedia(wiki.group('lang'), wiki.group('title'))
                final_url = url
            else:
                resp = await client.get(url, headers=_BROWSER_HEADERS)
                resp.raise_for_status()
                raw       = _extract_text(resp.text)
                final_url = str(resp.url)

        text_out = raw.strip() or None
        # Empty text from a successful HTTP fetch almost always means a JS-rendered
        # SPA — the HTML shell has no visible content until JavaScript runs.
        js_rendered = (text_out is None) and (not wiki)
        result = {'text': text_out, 'url': final_url}
        if js_rendered:
            result['js_rendered'] = True
        char_limit = _MAX_WIKI_CHARS if wiki else _MAX_CHARS
        if text_out and len(text_out) > char_limit:
            result['text'] = text_out[:char_limit] + ' …[truncated]'
        session_log.log("tool_result", {
            "endpoint":      "/api/browser/page-text",
            "status_code":   200,
            "duration_ms":   round((time.monotonic() - _t0) * 1000),
            "result_summary": f"url={url[:80]}, chars={len(text_out) if text_out else 0}",
        })
        return result

    except httpx.TimeoutException:
        session_log.log("tool_result", {"endpoint": "/api/browser/page-text", "status_code": 408, "duration_ms": round((time.monotonic() - _t0) * 1000), "result_summary": "timeout"})
        return {'text': None, 'error': 'Request timed out'}
    except httpx.HTTPStatusError as exc:
        session_log.log("tool_result", {"endpoint": "/api/browser/page-text", "status_code": exc.response.status_code, "duration_ms": round((time.monotonic() - _t0) * 1000), "result_summary": f"HTTP {exc.response.status_code}"})
        return {'text': None, 'error': f'HTTP {exc.response.status_code}'}
    except Exception as exc:  # noqa: BLE001
        session_log.log("tool_result", {"endpoint": "/api/browser/page-text", "status_code": 500, "duration_ms": round((time.monotonic() - _t0) * 1000), "result_summary": str(exc)[:200]})
        return {'text': None, 'error': str(exc)}


@router.get('/browser/wiki-section')
async def fetch_wiki_section(url: str, section: str):
    """Fetch a specific named section from a Wikipedia article as plain text.

    Fuzzy-matches the requested section name against the article's section list,
    then fetches only that section's HTML and converts it to clean plain text.
    Returns available section names when no match is found.
    """
    wiki = _WIKI_RE.match(url)
    if not wiki:
        return {'text': None, 'error': 'URL is not a Wikipedia article'}

    lang  = wiki.group('lang')
    title = unquote(wiki.group('title')).replace('_', ' ')

    def _sync():
        base = f'https://{lang}.wikipedia.org/w/api.php'
        ua   = {'User-Agent': _WIKI_UA}

        # 1. Retrieve section list
        r = _requests.get(base, params={
            'action': 'parse', 'page': title,
            'prop': 'sections', 'format': 'json',
        }, headers=ua, timeout=15)
        r.raise_for_status()
        sections = r.json().get('parse', {}).get('sections', [])

        # 2. Fuzzy-match: exact → query-in-title → title-in-query
        q = section.strip().lower()
        matched = (
            next((s for s in sections if s['line'].lower() == q), None)
            or next((s for s in sections if q in s['line'].lower()), None)
            or next((s for s in sections if s['line'].lower() in q), None)
        )
        if not matched:
            return {'found': False, 'available': [s['line'] for s in sections]}

        # 3. Fetch that section's rendered HTML and strip to plain text
        r2 = _requests.get(base, params={
            'action': 'parse', 'page': title,
            'prop': 'text', 'section': matched['index'],
            'format': 'json', 'disableeditsection': '1',
        }, headers=ua, timeout=15)
        r2.raise_for_status()
        html = r2.json().get('parse', {}).get('text', {}).get('*', '')
        text = _extract_text(html)
        return {'found': True, 'text': text, 'section': matched['line']}

    try:
        result = await asyncio.get_running_loop().run_in_executor(None, _sync)
    except Exception as exc:  # noqa: BLE001
        return {'text': None, 'error': str(exc)}

    if not result['found']:
        return {
            'text': None,
            'error': f'Section "{section}" not found.',
            'available_sections': result.get('available', []),
        }
    return {'text': result['text'], 'section': result['section']}


# ── URL resolver ──────────────────────────────────────────────────────────────

class _ResolveUrlRequest(BaseModel):
    text: str
    model: str = _DEFAULT_MODEL


_RESOLVE_SYSTEM = (
    "You are a URL extraction assistant. Your only job is to extract a valid URL "
    "from a spoken voice command and return it as a clean URL.\n"
    "Rules:\n"
    "- Return ONLY the URL — no explanation, no punctuation, no markdown, no quotes.\n"
    "- Spoken artifacts: 'DOT' means '.', 'SLASH' or 'forward slash' means '/', "
    "'COLON' means ':', 'DASH' or 'hyphen' means '-', 'UNDERSCORE' means '_'.\n"
    "- Remove any spaces that appear inside domain names or paths.\n"
    "- Always prefix with https:// unless the user explicitly said http://.\n"
    "- If no recognisable URL or domain is present, return exactly: UNKNOWN"
)


@router.post('/browser/resolve-url')
async def resolve_browser_url(req: _ResolveUrlRequest):
    """Use the LLM to extract and normalise a URL from a spoken transcript.

    Returns { url, label } on success or { url: null, error } on failure.
    Uses temperature=0 and a system prompt that corrects common STT artefacts
    such as 'DOT' being transcribed instead of '.'.
    """
    session_log.log('tool_call', {
        'endpoint': '/api/browser/resolve-url',
        'method':   'POST',
        'params_summary': f'text={req.text[:120]}',
    })

    payload = {
        'model': req.model,
        'messages': [
            {'role': 'system', 'content': _RESOLVE_SYSTEM},
            {'role': 'user',   'content': f'Extract the URL from this spoken command: {req.text}'},
        ],
        'options': {'temperature': 0},
        'stream': False,
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(f'{_OLLAMA_BASE}/api/chat', json=payload)
            resp.raise_for_status()
            data    = resp.json()
            raw_url = data.get('message', {}).get('content', '').strip()

        if not raw_url or raw_url.upper() == 'UNKNOWN':
            return {'url': None, 'label': None, 'error': 'LLM could not extract a URL'}

        # Ensure a scheme
        if not re.match(r'^https?://', raw_url, re.IGNORECASE):
            raw_url = f'https://{raw_url}'

        label = re.sub(r'^https?://', '', raw_url, flags=re.IGNORECASE)
        session_log.log('tool_result', {
            'endpoint': '/api/browser/resolve-url',
            'status_code': 200,
            'result_summary': f'resolved={raw_url[:120]}',
        })
        return {'url': raw_url, 'label': label}

    except Exception as exc:  # noqa: BLE001
        session_log.log('tool_result', {
            'endpoint': '/api/browser/resolve-url',
            'status_code': 500,
            'result_summary': str(exc)[:200],
        })
        return {'url': None, 'label': None, 'error': str(exc)}
