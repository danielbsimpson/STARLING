// frontend/papers-panel.js
// Research papers panel: trigger detection, fetch/render, and LLM context export.

import { BACKEND_BASE } from './config.js';
import { escapeHtml } from './utils.js';

const PAPERS_MIN_TOPIC_CHARS = 3;
const DEFAULT_SINCE = 'week';

const _starlingEl = document.getElementById('starling');
const papersPanel = document.getElementById('papers-panel');
const papersTitle = document.getElementById('papers-title');
const papersMeta = document.getElementById('papers-meta');
const papersList = document.getElementById('papers-list');
const papersFetched = document.getElementById('papers-fetched');
const papersRefreshBtn = document.getElementById('papers-refresh-btn');
const papersCloseBtn = document.getElementById('papers-close-btn');

let _enqueueSpeak = null;
let _sendToOllama = null;
let _interruptSpeech = null;

let _papersContext = null;
let _lastPapersQuery = null; // { topic, since }
let _papersData = null;

export function initPapersPanel({ enqueueSpeak, sendToOllama, interruptSpeech } = {}) {
  _enqueueSpeak = enqueueSpeak || null;
  _sendToOllama = sendToOllama || null;
  _interruptSpeech = interruptSpeech || null;
}

function _normaliseSince(transcript) {
  const t = (transcript || '').toLowerCase();
  if (/\b(?:today|this\s+day)\b/.test(t)) return 'today';
  if (/\b(?:this\s+week|past\s+week|last\s+week|weekly)\b/.test(t)) return 'week';
  if (/\b(?:this\s+month|past\s+month|last\s+month|monthly)\b/.test(t)) return 'month';
  if (/\b(?:this\s+year|past\s+year|last\s+year|yearly)\b/.test(t)) return 'year';
  if (/\b(?:any\s+time|all\s+time|ever)\b/.test(t)) return 'any';
  return DEFAULT_SINCE;
}

function _stripTrailingRecency(topic) {
  return topic
    .replace(/\b(?:this\s+week|past\s+week|last\s+week|today|this\s+month|past\s+month|last\s+month|this\s+year|past\s+year|last\s+year|any\s+time|all\s+time)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function _extractTopic(transcript) {
  const t = (transcript || '').trim();

  const patterns = [
    /\b(?:any\s+)?(?:new|recent|latest)\s+(?:papers?|research|stud(?:y|ies)|preprints?)\s+(?:on|about|for)\s+(.+)$/i,
    /\b(?:find|show|list|get|search\s+for)\s+(?:recent\s+|latest\s+)?(?:papers?|research|stud(?:y|ies)|preprints?)\s+(?:on|about|for)\s+(.+)$/i,
    /\b(?:papers?|research|stud(?:y|ies)|preprints?)\s+(?:on|about|for)\s+(.+)$/i,
    /\barxiv\s+(?:papers?\s+)?(?:on|about|for)\s+(.+)$/i,
    /\bwhat(?:'s|\s+is)\s+new\s+in\s+(.+?)\s+research\b/i,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) return _stripTrailingRecency(m[1]);
  }

  return '';
}

/**
 * Detect paper-search intent and extract topic + recency token.
 * Returns { topic, since } or null.
 */
export function detectPapersTrigger(transcript) {
  const t = (transcript || '').trim();
  if (!t) return null;

  const lower = t.toLowerCase();
  const hasPaperIntent = /\b(?:paper|papers|research|arxiv|preprint|study|studies|publication|publications)\b/.test(lower);
  if (!hasPaperIntent) return null;

  const topic = _extractTopic(t);
  if (!topic || topic.length < PAPERS_MIN_TOPIC_CHARS) return null;

  return {
    topic,
    since: _normaliseSince(t),
  };
}

function _renderPapers(data) {
  if (!papersTitle || !papersMeta || !papersList || !papersFetched) return;

  const topic = data.topic || (_lastPapersQuery?.topic || 'topic');
  const total = Number(data.total || 0);

  papersTitle.textContent = `RESEARCH PAPERS - ${topic.toUpperCase()}`;
  papersMeta.textContent = `${total} RESULTS`;

  const fetchedDate = data.fetched_at ? new Date(data.fetched_at) : null;
  papersFetched.textContent = fetchedDate && !Number.isNaN(fetchedDate.valueOf())
    ? `UPDATED ${fetchedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
    : 'UPDATED -';

  if (!Array.isArray(data.papers) || data.papers.length === 0) {
    papersList.innerHTML = '<div class="papers-empty">No papers found in that time window.</div>';
    return;
  }

  const cards = data.papers.map((paper, idx) => {
    const title = escapeHtml(paper.title || 'Untitled');
    const authors = Array.isArray(paper.authors) && paper.authors.length
      ? escapeHtml(paper.authors.join(', '))
      : 'Unknown author';
    const summary = escapeHtml(paper.summary || 'No summary available.');
    const source = escapeHtml(paper.source || 'Unknown source');
    const published = escapeHtml(paper.published || 'unknown date');
    const venue = paper.venue ? `<span class="papers-venue">${escapeHtml(paper.venue)}</span>` : '';
    const cited = Number.isInteger(paper.citation_count)
      ? `<span class="papers-citations">CITED ${paper.citation_count}x</span>`
      : '';
    const paperUrl = paper.url ? escapeHtml(paper.url) : '';
    const linkTagOpen = paperUrl ? `<a class="papers-item-title" href="${paperUrl}" target="_blank" rel="noopener noreferrer">` : '<div class="papers-item-title">';
    const linkTagClose = paperUrl ? '</a>' : '</div>';

    return (
      `<div class="papers-item" style="--card-delay:${idx * 28}ms">` +
        `<div class="papers-item-meta">` +
          `<span class="papers-source">${source}</span>` +
          `<span class="papers-meta-sep">•</span>` +
          `<span class="papers-date">${published}</span>` +
          venue +
          cited +
        `</div>` +
        `${linkTagOpen}${title}${linkTagClose}` +
        `<div class="papers-authors">${authors}</div>` +
        `<div class="papers-summary">${summary}</div>` +
      `</div>`
    );
  }).join('');

  papersList.innerHTML = cards;
}

export async function openPapersPanel({ topic, since = DEFAULT_SINCE } = {}) {
  const cleanTopic = (topic || '').trim();
  if (!cleanTopic || cleanTopic.length < PAPERS_MIN_TOPIC_CHARS) {
    return null;
  }

  const cleanSince = (since || DEFAULT_SINCE).toLowerCase();
  _lastPapersQuery = { topic: cleanTopic, since: cleanSince };

  if (papersMeta) papersMeta.textContent = 'LOADING...';

  try {
    const url = `${BACKEND_BASE}/papers?topic=${encodeURIComponent(cleanTopic)}&since=${encodeURIComponent(cleanSince)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Papers API ${res.status}`);

    const data = await res.json();
    _papersData = data;
    _papersContext = data.llm_context || null;

    _renderPapers(data);
    papersPanel?.classList.remove('hidden');
    _starlingEl?.classList.add('papers-mode');

    return _papersContext;
  } catch (err) {
    console.error('[papers-panel] fetch failed:', err);
    if (papersMeta) papersMeta.textContent = 'FETCH ERROR';
    _papersContext = null;
    return null;
  }
}

export function closePapersPanel() {
  papersPanel?.classList.add('hidden');
  _starlingEl?.classList.remove('papers-mode');
  _papersContext = null;
}

export function isPapersPanelOpen() {
  return papersPanel ? !papersPanel.classList.contains('hidden') : false;
}

export function getPapersContext() {
  return _papersContext;
}

export function getLastPapersQuery() {
  return _lastPapersQuery;
}

papersCloseBtn?.addEventListener('click', closePapersPanel);

papersRefreshBtn?.addEventListener('click', async () => {
  if (!_lastPapersQuery) return;
  papersRefreshBtn.disabled = true;
  papersRefreshBtn.textContent = 'REFRESHING...';
  try {
    await fetch(`${BACKEND_BASE}/papers/cache`, { method: 'DELETE' });
  } catch (_) {
    // ignore cache clear failures
  }
  await openPapersPanel(_lastPapersQuery);
  papersRefreshBtn.disabled = false;
  papersRefreshBtn.textContent = 'REFRESH';
});
