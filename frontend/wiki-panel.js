/**
 * frontend/wiki-panel.js — Wikipedia Article Q&A panel for S.T.A.R.L.I.N.G.
 *
 * Exports:
 *   wikiMode              — boolean, true while a Wikipedia session is active
 *   wikiArticleTitle      — string, title of the currently loaded article
 *   detectWikiTrigger(t)  — returns search query string or null
 *   detectWikiExitTrigger(t) — returns true if the user wants to exit wiki mode
 *   startWikiSession(q)   — POST /wiki/start → {title, chunk_count, ...}
 *   enterWikiMode(title)  — show panel + reset transcript + set wiki-mode class
 *   exitWikiMode()        — hide panel + clear session on backend
 *   appendWikiMessage(role, text) → {wrap, txt} DOM refs
 *   getWikiHistory()      → copy of conversation history array
 *   addToWikiHistory(role, content) — append to history
 */

import { BACKEND_BASE } from './config.js';

// ── Module state ──────────────────────────────────────────────────────────────
export let wikiMode         = false;
export let wikiArticleTitle = '';
let _wikiHistory            = [];   // [{role, content}, ...]

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Detect a Wikipedia search trigger in a transcript.
 * Supports several natural phrasings:
 *   "wikipedia search <query>"
 *   "search wikipedia for <query>"
 *   "look up <query> on wikipedia"
 *   "wikipedia <query>"
 * Returns the extracted search query string, or null if no trigger matched.
 */
export function detectWikiTrigger(text) {
  const patterns = [
    /\bwikipedia\s+search\s+(?:for\s+)?(.+)/i,
    /\bsearch\s+wikipedia\s+(?:for\s+)?(.+)/i,
    /\blook\s+up\s+(.+?)\s+on\s+wikipedia\b/i,
    /\bwikipedia\s+(.+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const q = m[1].trim().replace(/[?.!,]+$/, '');
      if (q) return q;
    }
  }
  return null;
}

/**
 * Detect an exit phrase for Wikipedia mode.
 */
export function detectWikiExitTrigger(text) {
  const patterns = [
    /\b(?:exit|close|quit|leave|stop|end)\s+(?:wikipedia|wiki|article|mode)\b/i,
    /\bback\s+to\s+(?:chat|main)\b/i,
    /\b(?:never\s*mind|nevermind|cancel\s+that)\b/i,
    /\bclose\s+(?:this|the)\s+(?:panel|article)\b/i,
    /\bgo\s+back\b/i,
  ];
  return patterns.some(p => p.test(text));
}

// ── Session API ───────────────────────────────────────────────────────────────

/**
 * Start a Wikipedia session on the backend for the given search query.
 * Resolves with the session object: {title, chunk_count, active, created_at}.
 * Throws on network error or when the article is not found (404).
 */
export async function startWikiSession(query) {
  const res = await fetch(`${BACKEND_BASE}/wiki/start`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Wiki start failed (${res.status})`);
  }
  return await res.json();
}

// ── Panel control ─────────────────────────────────────────────────────────────

export function enterWikiMode(title) {
  wikiMode         = true;
  wikiArticleTitle = title;
  _wikiHistory     = [];

  const titleEl = document.getElementById('wiki-article-title');
  if (titleEl) titleEl.textContent = title.toUpperCase();

  const transcript = document.getElementById('wiki-transcript');
  if (transcript) transcript.innerHTML = '';

  // Add wiki-mode class to drive CSS layout transitions
  document.getElementById('starling').classList.add('wiki-mode');
}

export function exitWikiMode() {
  wikiMode         = false;
  wikiArticleTitle = '';
  _wikiHistory     = [];

  document.getElementById('starling').classList.remove('wiki-mode');

  const transcript = document.getElementById('wiki-transcript');
  if (transcript) transcript.innerHTML = '';

  // Clear the backend session (fire-and-forget — never blocks the UI)
  fetch(`${BACKEND_BASE}/wiki/clear`, { method: 'POST' }).catch(() => {});
}

// ── Transcript helpers ────────────────────────────────────────────────────────

/**
 * Append a message bubble to the wiki transcript.
 * Returns { wrap, txt } DOM element refs so the caller can update the text
 * during streaming (same pattern as appendMessage in app.js).
 */
export function appendWikiMessage(role, text) {
  const transcript = document.getElementById('wiki-transcript');
  if (!transcript) return null;

  const wrap = document.createElement('div');
  wrap.className = `wiki-msg ${role === 'user' ? 'wiki-user' : 'wiki-asst'}`;

  const lbl = document.createElement('span');
  lbl.className   = 'wiki-msg-lbl';
  lbl.textContent = role === 'user' ? 'USER' : 'S.T.A.R.L.I.N.G.';

  const txt = document.createElement('span');
  txt.className   = 'wiki-msg-text';
  txt.textContent = text;

  wrap.appendChild(lbl);
  wrap.appendChild(txt);
  transcript.appendChild(wrap);
  transcript.scrollTop = transcript.scrollHeight;
  return { wrap, txt };
}

// ── History management ────────────────────────────────────────────────────────

/** Return a shallow copy of the current wiki conversation history. */
export function getWikiHistory() {
  return [..._wikiHistory];
}

/** Append a message to the wiki conversation history. */
export function addToWikiHistory(role, content) {
  _wikiHistory.push({ role, content });
}
