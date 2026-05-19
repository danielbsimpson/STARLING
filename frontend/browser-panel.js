// frontend/browser-panel.js
// Handles the in-UI browser panel: trigger detection, rendering, and toolbar controls.

import { BACKEND_BASE } from './config.js';

const KNOWN_BLOCKED_DOMAINS = [
  'google.com', 'youtube.com', 'twitter.com', 'x.com',
  'reddit.com', 'facebook.com', 'instagram.com', 'linkedin.com',
  'amazon.com', 'netflix.com',
];

// ── State ─────────────────────────────────────────────────────────────────────

let _isOpen      = false;
let _pageText    = null;   // extracted plain-text of current page (null while fetching or closed)
let _currentUrl  = null;   // last URL we navigated to
let _jsRendered  = false;  // true when the current page is a JS SPA that couldn't be read

// ── DOM refs ──────────────────────────────────────────────────────────────────

const starlingEl = document.getElementById('starling');
const panel      = document.getElementById('browser-panel');
const frame      = document.getElementById('browser-frame');
const urlBar     = document.getElementById('browser-url-bar');
const fallback   = document.getElementById('browser-fallback');
const extLink    = document.getElementById('browser-external-link');
const iframeBox  = document.getElementById('browser-iframe-container');
const readWarn   = document.getElementById('browser-read-warn');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns whether the browser panel is currently visible.
 */
export function isBrowserPanelOpen() {
  return _isOpen;
}

/**
 * Returns the extracted plain-text of the currently loaded page, or null if unavailable.
 * Used by app.js to inject page context into the LLM when the user asks a question.
 */
export function getBrowserPageText() {
  return _pageText;
}

/**
 * Returns the URL currently loaded in the panel, or null.
 */
export function getBrowserPageUrl() {
  return _currentUrl;
}

/**
 * Returns true if the current page was detected as a JavaScript-rendered SPA
 * whose content could not be extracted server-side.
 */
export function getBrowserJsRendered() {
  return _jsRendered;
}

/**
 * Returns the current page text if already fetched, otherwise fetches it now and
 * awaits the result. Use this at query-time to guarantee the LLM has page context
 * even if the background frame.load fetch hasn't completed yet.
 */
export async function ensureBrowserPageText() {
  if (_pageText) return _pageText;
  if (!_currentUrl || _currentUrl === 'about:blank') return null;
  await _fetchPageText(_currentUrl);
  return _pageText;
}

/**
 * Given a raw Whisper transcript, check for a browser trigger phrase.
 * Returns { url, label } if matched, otherwise null.
 *   url   — resolved URL to navigate to
 *   label — natural-language description used in the LLM spoken acknowledgment
 */
export function detectBrowserTrigger(transcript) {
  const t = transcript.trim();

  // "look up X on Wikipedia" / "search Wikipedia for X" / "wikipedia for/about X"
  const wikiMatch = t.match(/(?:search|look up|open|find)\s+(.+?)\s+on\s+wikipedia/i)
                 || t.match(/(?:search|look up)\s+wikipedia\s+for\s+(.+)/i)
                 || t.match(/wikipedia\s+(?:for|on|about)\s+(.+)/i);
  if (wikiMatch) {
    const topic = wikiMatch[1].trim();
    return {
      url:   `https://en.wikipedia.org/wiki/${encodeURIComponent(topic)}`,
      label: `the Wikipedia article on "${topic}"`,
    };
  }

  // "open browser [URL]" — tolerates spoken "HTTPS"/"HTTP" without "://" and
  // Whisper-inserted spaces within a domain (e.g. "DanielB Simpson.com")
  const openBrowserMatch = t.match(/open\s+browser\s+(.+)/i);
  if (openBrowserMatch) {
    let raw = openBrowserMatch[1].trim();
    // "HTTPS example.com" → "https://example.com"
    raw = raw.replace(/^(https?)\s+/i, '$1://');
    // Collapse any spaces Whisper inserted inside the domain or path, then lowercase
    raw = raw.replace(/\s+/g, '').toLowerCase();
    // Ensure a scheme
    if (!/^https?:\/\//.test(raw)) raw = `https://${raw}`;
    const label = raw.replace(/^https?:\/\//, '');
    return { url: raw, label };
  }

  // "browser search for X" / "browser search X" — DuckDuckGo plain-HTML endpoint (iframe-friendly)
  const searchMatch = t.match(/browser\s+search(?:\s+for)?\s+(.+)/i);
  if (searchMatch) {
    const query = searchMatch[1].trim();
    return {
      url:   `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      label: `a DuckDuckGo search for "${query}"`,
    };
  }

  return null;
}

/**
 * Returns true if the transcript contains an explicit request to close the browser panel.
 */
export function detectBrowserClose(transcript) {
  const t = transcript.trim().toLowerCase();
  return /\b(?:close|exit|dismiss|hide|shut)\s+(?:the\s+)?browser\b/.test(t);
}

/**
 * Open the browser panel and navigate to the given URL.
 */
export function openBrowserPanel(url) {
  _isOpen = true;
  _showPanel();
  _navigateTo(_resolveUrl(url));
}

/**
 * Close the panel and reset state.
 */
export function closeBrowserPanel() {
  if (!_isOpen) return;
  _isOpen      = false;
  _pageText    = null;
  _currentUrl  = null;
  _jsRendered  = false;
  starlingEl.classList.remove('browser-mode');
  frame.src = 'about:blank';
  _showIframe();
  readWarn.classList.add('hidden');
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _resolveUrl(raw) {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function _isKnownBlocked(url) {
  // DuckDuckGo's plain-HTML search endpoint is embeddable; only block the main site
  if (/^https:\/\/html\.duckduckgo\.com\/html\//.test(url)) return false;
  return KNOWN_BLOCKED_DOMAINS.some(domain => url.includes(domain));
}

function _showPanel() {
  starlingEl.classList.add('browser-mode');
}

function _showIframe() {
  iframeBox.classList.remove('hidden');
  fallback.classList.add('hidden');
}

function _showFallback(url) {
  iframeBox.classList.add('hidden');
  fallback.classList.remove('hidden');
  extLink.href        = url;
  extLink.textContent = `Open ${url.replace(/^https?:\/\//, '')} in new tab \u2197`;
}

function _navigateTo(url) {
  _currentUrl  = url;
  _pageText    = null;  // clear until the page finishes loading
  _jsRendered  = false;
  urlBar.value = url;
  extLink.href = url;
  readWarn.classList.add('hidden');

  if (_isKnownBlocked(url)) {
    _showFallback(url);
    return;
  }

  _showIframe();
  frame.src     = url;
  // Catches same-origin network failures; cross-origin X-Frame-Options blocks are silent.
  frame.onerror = () => _showFallback(url);
}

/**
 * Fetch extracted page text from the backend for the given URL.
 * Only stores the result if the URL is still current when the response arrives.
 */
async function _fetchPageText(url) {
  try {
    const res  = await fetch(`${BACKEND_BASE}/api/browser/page-text?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (url !== _currentUrl) return;  // navigated away before response arrived
    if (data.error) {
      console.error('[browser-panel] page-text error from backend:', data.error);
      _showReadWarn('⚠ CANNOT READ PAGE');
    } else if (data.text) {
      _pageText = data.text;
    } else if (data.js_rendered) {
      _jsRendered = true;
      _showReadWarn('⚠ JS-RENDERED — CONTENT UNAVAILABLE');
    } else {
      _showReadWarn('⚠ CANNOT READ PAGE');
    }
  } catch (err) {
    console.error('[browser-panel] page-text fetch failed — is the backend running?', err.message);
    if (url === _currentUrl) _showReadWarn('⚠ CANNOT READ PAGE');
  }
}

function _showReadWarn(msg) {
  readWarn.textContent = msg;
  readWarn.classList.remove('hidden');
}

// ── Toolbar event listeners ───────────────────────────────────────────────────

document.getElementById('browser-close').addEventListener('click', closeBrowserPanel);

document.getElementById('browser-refresh').addEventListener('click', () => {
  if (_currentUrl) _navigateTo(_currentUrl);
});

document.getElementById('browser-back').addEventListener('click', () => {
  frame.contentWindow?.history.back();
});

document.getElementById('browser-forward').addEventListener('click', () => {
  frame.contentWindow?.history.forward();
});

document.getElementById('browser-go').addEventListener('click', () => {
  _navigateTo(_resolveUrl(urlBar.value.trim()));
});

urlBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') _navigateTo(_resolveUrl(urlBar.value.trim()));
});

// ── Page-text extraction on every frame load ──────────────────────────────────
// The load event fires each time the iframe navigates (initial load + in-frame links).
// We try to read the real URL from the frame (works for same-origin navigation);
// cross-origin navigations fall back to _currentUrl (the last URL we explicitly set).
frame.addEventListener('load', () => {
  let url = _currentUrl;

  // Attempt to get the actual current URL (throws for cross-origin — expected)
  try {
    const href = frame.contentWindow?.location?.href;
    if (href && href !== 'about:blank') {
      url = href;
      if (url !== _currentUrl) {
        _currentUrl  = url;
        urlBar.value = url;
      }
    }
  } catch { /* cross-origin restriction — use _currentUrl */ }

  if (!_isOpen || !url || url === 'about:blank') { _pageText = null; return; }
  _fetchPageText(url);
});

