// frontend/news-panel.js
// News briefing panel: trigger detection, data fetch, render, and LLM context export.

import { BACKEND_BASE } from './config.js';
import { escapeHtml } from './utils.js';

// ── Category config ───────────────────────────────────────────────────────────
const CATEGORIES = [
  { key: 'world',         label: 'World'   },
  { key: 'us',            label: 'US'      },
  { key: 'technology',    label: 'Tech'    },
  { key: 'business',      label: 'Business'},
  { key: 'science',       label: 'Science' },
  { key: 'health',        label: 'Health'  },
  { key: 'sports',        label: 'Sports'  },
  { key: 'entertainment', label: 'Entmt.'  },
];

// ── Region config ─────────────────────────────────────────────────────────────
const REGIONS = [
  { key: 'all',           label: 'All Regions'  },
  { key: 'north-america', label: 'N. America'   },
  { key: 'europe',        label: 'Europe'       },
  { key: 'middle-east',   label: 'Mid. East'    },
  { key: 'africa',        label: 'Africa'       },
  { key: 'asia',          label: 'Asia'         },
  { key: 'south-america', label: 'S. America'   },
  { key: 'oceania',       label: 'Oceania'      },
];

// Maps resolved source labels (from backend) to a region key
const SOURCE_REGION = {
  // North America
  'New York Times':    'north-america',
  'NPR':               'north-america',
  'ABC News':          'north-america',
  'CBS News':          'north-america',
  'Wall Street Journal': 'north-america',
  'AP News':           'north-america',
  'Vox':               'north-america',
  'Newsweek':          'north-america',
  'Fox News':          'north-america',
  'Business Insider':  'north-america',
  'LA Times':          'north-america',
  'Chicago Tribune':   'north-america',
  'Seattle Times':     'north-america',
  'Mercury News':      'north-america',
  'Newsday':           'north-america',
  'Yahoo News':        'north-america',
  'Hacker News':       'north-america',
  'Ars Technica':      'north-america',
  'TechCrunch':        'north-america',
  'WIRED':             'north-america',
  'POLITICO':          'north-america',
  'Science Daily':     'north-america',
  'ESPN':              'north-america',
  // Europe
  'BBC News':          'europe',
  'The Guardian':      'europe',
  'The Independent':   'europe',
  'Daily Mail':        'europe',
  'TheJournal.ie':     'europe',
  'BreakingNews.ie':   'europe',
  'Irish Examiner':    'europe',
  'The Local':         'europe',
  'Agencia EFE':       'europe',
  'Euro Weekly News':  'europe',
  'UNIAN (Ukraine)':   'europe',
  'The Moscow Times':  'europe',
  'TASS':              'europe',
  // Middle East
  'Al Jazeera English': 'middle-east',
  // Africa
  'Premium Times Nigeria': 'africa',
  'Guardian Nigeria':      'africa',
  // Asia
  'Times of India':         'asia',
  'NDTV':                   'asia',
  'The Hindu':              'asia',
  'INQUIRER.net':           'asia',
  'GMA News':               'asia',
  'Hong Kong Free Press':   'asia',
  'The Standard HK':        'asia',
  'bdnews24':               'asia',
  'The Daily Star BD':      'asia',
  'The News International': 'asia',
  'Express Tribune':        'asia',
  // South America
  'The Rio Times': 'south-america',
  'Brasil Wire':   'south-america',
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const newsPanel        = document.getElementById('news-panel');
const newsMeta         = document.getElementById('news-meta');
const newsTitle        = document.getElementById('news-title');
const newsList         = document.getElementById('news-list');
const newsFetched      = document.getElementById('news-fetched');
const newsRefreshBtn   = document.getElementById('news-refresh-btn');
const newsCloseBtn     = document.getElementById('news-close-btn');
const newsCatSelect    = document.getElementById('news-cat-select');
const newsRegionSelect = document.getElementById('news-region-select');
const newsSourceSelect = document.getElementById('news-source-select');
const newsSynthIndicator = document.getElementById('news-synth-indicator');

// ── Service refs (injected by initNewsPanel) ─────────────────────────────────
let _enqueueSpeak    = null;
let _sendToOllama    = null;
let _interruptSpeech = null;
let _onNewsClose     = null;  // called when the X button closes the panel

export function initNewsPanel({ enqueueSpeak, sendToOllama, interruptSpeech, onClose } = {}) {
  _enqueueSpeak    = enqueueSpeak    || null;
  _sendToOllama    = sendToOllama    || null;
  _interruptSpeech = interruptSpeech || null;
  _onNewsClose     = onClose         || null;
}

// ── State ─────────────────────────────────────────────────────────────────────
let _newsData           = null;   // last fetched payload
let _activeTab          = 'all'; // currently selected source tab
let _activeCategory     = 'world'; // currently selected category
let _activeRegion       = 'all'; // currently selected region filter
let _activeCard         = null;  // currently tapped headline card
let _activeArticleData  = null;  // {title, summary} of the tapped card — for LLM context

// ── Filter select initialisation ──────────────────────────────────────────────
// Category and region options are static; source options are rebuilt per-fetch.
(function _initFilterSelects() {
  if (newsCatSelect) {
    CATEGORIES.forEach(({ key, label }) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label;
      newsCatSelect.appendChild(opt);
    });
    newsCatSelect.addEventListener('change', async () => {
      _activeRegion = 'all';
      if (newsRegionSelect) newsRegionSelect.value = 'all';
      await openNewsPanel(newsCatSelect.value, true);
    });
  }

  if (newsRegionSelect) {
    REGIONS.forEach(({ key, label }) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label;
      newsRegionSelect.appendChild(opt);
    });
    newsRegionSelect.addEventListener('change', () => {
      _activeRegion = newsRegionSelect.value;
      _reApplyFilters();
    });
  }

  if (newsSourceSelect) {
    newsSourceSelect.addEventListener('change', () => {
      if (!_newsData) return;
      _activeTab = newsSourceSelect.value;
      _reApplyFilters();
    });
  }
}());

// ── Refresh button ────────────────────────────────────────────────────────────
newsRefreshBtn?.addEventListener('click', async () => {
  newsRefreshBtn.textContent = '↻ FETCHING…';
  newsRefreshBtn.disabled    = true;
  await fetch(`${BACKEND_BASE}/news/cache`, { method: 'DELETE' }).catch(() => {});
  await openNewsPanel(_activeCategory, true);
  newsRefreshBtn.textContent = '↻ REFRESH';
  newsRefreshBtn.disabled    = false;
});

// ── Close button ──────────────────────────────────────────────────────────────
// The X button fires the panel-level close; app.js also listens to exit CSS state.
newsCloseBtn?.addEventListener('click', () => {
  closeNewsPanel();
  if (typeof _onNewsClose === 'function') _onNewsClose();
});

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Returns the detected category string (e.g. "technology") if the transcript
 * matches a news briefing trigger, or null if not a news request.
 * Defaults to "world" when triggered but no specific category is mentioned.
 */
export function detectNewsTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  const patterns = [
    /\bnews\s+briefing\b/,
    /\bmorning\s+briefing\b/,
    /\b(?:daily|evening|morning)\s+brief\b/,
    /\bwhat(?:'s| is)\s+(?:in\s+)?(?:the\s+)?news\b/,
    /\b(?:latest|breaking|today(?:'s)?)\s+news\b/,
    /\bnews\s+(?:update|report|summary|roundup|headlines?)\b/,
    /\btop\s+(?:stories|headlines?)\b/,
    /\bwhat(?:'s| is)\s+(?:going\s+on|happening)\b/,
    /\bcatch\s+me\s+up\b/,
    /\bbrief\s+me\b/,
    /\bheadlines?\b/,
    // Category-specific patterns — require explicit "news" or "headlines" keyword.
    // Deliberately exclude "briefing" to avoid stealing "stock briefing", "market briefing",
    // "crypto briefing", "portfolio briefing", etc. (those belong to the market tool).
    /\b(?:show\s+me(?:\s+the)?|pull\s+up(?:\s+the)?|display(?:\s+the)?|give\s+me(?:\s+the)?|get(?:\s+me)?(?:\s+the)?)\s+\w+\s+(?:news|headlines?)\b/,
    /\b\w+\s+(?:news|headlines?)\b/,
  ];

  const isNews = patterns.some(p => p.test(t));
  if (!isNews) return null;

  // Extract category keyword
  const categoryMap = {
    'tech':          'technology',
    'technology':    'technology',
    'technical':     'technology',
    'financial':     'business',
    'finance':       'business',
    'business':      'business',
    'market':        'business',
    'markets':       'business',
    'stocks':        'business',
    'economy':       'business',
    'economic':      'business',
    'american':      'us',
    'america':       'us',
    'united states': 'us',
    'us':            'us',
    'usa':           'us',
    'science':       'science',
    'scientific':    'science',
    'health':        'health',
    'medical':       'health',
    'medicine':      'health',
    'sports':        'sports',
    'sport':         'sports',
    'entertainment': 'entertainment',
    'celebrity':     'entertainment',
    'celebrities':   'entertainment',
    'world':         'world',
    'global':        'world',
    'international': 'world',
  };

  // Check multi-word keys first (e.g. "united states")
  for (const [kw, cat] of Object.entries(categoryMap)) {
    if (t.includes(kw)) return cat;
  }

  return 'world';
}

// ── Panel open / close ────────────────────────────────────────────────────────

/**
 * Fetch headlines for the given category and open the news panel.
 * Approach A: returns raw headlines immediately; synthesis patches in later via polling.
 * Approach B: feeds are fetched in parallel server-side so first render is fast (~1-3 s).
 * @param {string} [category='world']
 * @param {boolean} [silent=false] — used by refresh button
 * Returns the llm_context string for LLM injection, or null on failure.
 */
export async function openNewsPanel(category = 'world', silent = false) {
  _activeCategory = category;

  if (newsMeta) newsMeta.textContent = 'LOADING…';

  let data;
  try {
    const res = await fetch(`${BACKEND_BASE}/news?category=${encodeURIComponent(category)}`);
    if (res.status === 400) {
      const body = await res.json().catch(() => ({}));
      const msg  = `I don't have a feed set up for ${category} news.`;
      console.warn('[news-panel]', body.detail ?? msg);
      if (typeof window.enqueueSpeak === 'function') window.enqueueSpeak(msg);
      if (newsMeta) newsMeta.textContent = '—';
      return null;
    }
    if (!res.ok) throw new Error(`News API ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[news-panel] fetch failed:', err);
    if (newsMeta) newsMeta.textContent = '—';
    return null;
  }

  _newsData  = data;
  _activeTab = 'all';

  // Render raw cards immediately
  _renderPanel(data);
  newsPanel.classList.remove('hidden');

  return data.llm_context;
}

export function closeNewsPanel() {
  newsPanel?.classList.add('hidden');
  _newsData          = null;
  _activeArticleData = null;
  _activeCard        = null;
}

/** True when the news panel is visible on screen. */
export function isNewsPanelOpen() {
  return newsPanel ? !newsPanel.classList.contains('hidden') : false;
}

/**
 * Returns a formatted context string for the currently tapped article,
 * or null if no card is selected. Used by app.js to inject article context
 * into the LLM so the user can discuss the article with Starling.
 */
export function getActiveArticleContext() {
  if (!_activeArticleData) return null;
  const { title, summary } = _activeArticleData;
  let ctx = `The user currently has a news article tile selected in the news panel.\nArticle headline: "${title}"\n`;
  if (summary) ctx += `Subheadline / summary: "${summary}"\n`;
  ctx += 'The user may want to discuss this article. Answer in the context of this article when relevant.';
  return ctx;
}

// ── Render ─────────────────────────────────────────────────────────────────────

function _renderPanel(data) {
  const { headlines, by_source, sources, total, fetched_at,
          category, category_label, synthesised, synthesis_enabled } = data;

  // Panel title — e.g. "NEWS — TECHNOLOGY"
  if (newsTitle) {
    newsTitle.textContent = category_label ? `NEWS — ${category_label}` : 'NEWS BRIEFING';
  }

  newsMeta.textContent = `${total} HEADLINES`;

  const fetchedDate = new Date(fetched_at);
  newsFetched.textContent = `UPDATED ${fetchedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

  // ── Sync filter selects ───────────────────────────────────────────────────
  if (newsCatSelect) newsCatSelect.value = category ?? 'world';
  if (newsRegionSelect) newsRegionSelect.value = _activeRegion;

  // ── Populate source select ────────────────────────────────────────────────
  if (newsSourceSelect) {
    newsSourceSelect.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'All Sources';
    newsSourceSelect.appendChild(allOpt);
    sources.forEach(src => {
      const opt = document.createElement('option');
      opt.value = src;
      opt.textContent = src.length > 22 ? src.slice(0, 20) + '\u2026' : src;
      newsSourceSelect.appendChild(opt);
    });
    newsSourceSelect.value = 'all';
    _activeTab = 'all';
  }

  // ── Headline list ──────────────────────────────────────────────────────────
  _renderList(headlines);
}

function _reApplyFilters() {
  const items = _activeTab === 'all'
    ? (_newsData?.headlines ?? [])
    : (_newsData?.by_source?.[_activeTab] ?? []);
  _renderList(items);
}

function _renderList(items) {
  _activeCard = null;
  const filtered = _activeRegion === 'all'
    ? items
    : items.filter(item => (item.region || SOURCE_REGION[item.source]) === _activeRegion);
  newsList.innerHTML = '';
  if (!filtered.length) {
    newsList.innerHTML = '<div style="font-size:0.7rem;color:#444;padding:4px 0;">No headlines for this region.</div>';
    return;
  }
  // US / North America sources float to the top; within each group, pub_ts order is preserved.
  const sorted = [...filtered].sort((a, b) => {
    const ra = (a.region || SOURCE_REGION[a.source]) === 'north-america' ? 0 : 1;
    const rb = (b.region || SOURCE_REGION[b.source]) === 'north-america' ? 0 : 1;
    return ra - rb;
  });
  sorted.forEach((item, i) => {
    const card = _makeHeadlineCard(item);
    card.style.setProperty('--card-delay', `${i * 40}ms`);
    newsList.appendChild(card);
  });
}

function _renderSynthesisedList(stories, incoming = false) {
  _activeCard = null;
  const filtered = _activeRegion === 'all'
    ? stories
    : stories.filter(story =>
        story.sources?.some(s => (s.region || SOURCE_REGION[s.source ?? s.name]) === _activeRegion)
      );
  newsList.innerHTML = '';
  if (!filtered.length) {
    newsList.innerHTML = '<div style="font-size:0.7rem;color:#444;padding:4px 0;">No stories for this region.</div>';
    return;
  }
  // Stagger cards; use a longer base delay when patching in synthesis results
  // so the transition feels deliberate rather than a jarring instant swap.
  const baseDelay = incoming ? 80 : 40;
  filtered.forEach((story, i) => {
    const card = _makeStoryCard(story);
    card.style.setProperty('--card-delay', `${i * baseDelay}ms`);
    if (incoming) card.classList.add('incoming');
    newsList.appendChild(card);
  });
}

function _makeHeadlineCard(item) {
  const card     = document.createElement('div');
  card.className = 'news-item';
  const _region    = item.region || SOURCE_REGION[item.source];
  const _regionLbl = (_region ? REGIONS.find(r => r.key === _region)?.label : null) ?? '—';
  const _pub       = item.pub || '—';
  card.innerHTML = `
    <div class="news-item-meta">
      <span class="news-item-source">${escapeHtml(item.source)}</span>
      <span class="news-item-meta-sep">|</span>
      <span class="news-item-region">${escapeHtml(_regionLbl)}</span>
      <span class="news-item-meta-sep">|</span>
      <span class="news-item-pub">${escapeHtml(_pub)}</span>
    </div>
    <div class="news-item-title">${escapeHtml(item.title)}</div>
    ${item.summary ? `<div class="news-item-summary">${escapeHtml(item.summary)}</div>` : ''}
    ${item.link ? `<div class="news-item-actions"><button class="news-item-view-btn">VIEW ARTICLE</button></div>` : ''}
  `;

  // VIEW ARTICLE opens the link without bubbling up to the card click
  const viewBtn = card.querySelector('.news-item-view-btn');
  viewBtn?.addEventListener('click', e => {
    e.stopPropagation();
    window.open(item.link, '_blank', 'noopener,noreferrer');
  });

  card.style.cursor = 'pointer';
  card.addEventListener('click', () => {
    const wasActive = card.classList.contains('active');
    // Deactivate any other open card first
    if (_activeCard && _activeCard !== card) {
      _activeCard.classList.remove('active');
    }
    if (wasActive) {
      card.classList.remove('active');
      _activeCard        = null;
      _activeArticleData = null;
    } else {
      card.classList.add('active');
      _activeCard        = card;
      _activeArticleData = { title: item.title, summary: item.summary || '' };
      _speakHeadline(item);
    }
  });

  return card;
}

function _makeStoryCard(story) {
  const { headline, summary, sources = [] } = story;

  // Pick most-recent published label from sources
  const pubLabel = sources.length > 0 ? sources[0].published ?? '' : '';
  const multiSrc = sources.length > 1;
  const firstLink = sources.find(s => s.link)?.link ?? null;

  const card     = document.createElement('div');
  card.className = 'news-story-card';

  // Pills row (compact — only a few, truncate rest in expanded section)
  const pillsHtml = sources.slice(0, 4).map(s =>
    s.link
      ? `<a class="news-source-pill" href="${escapeHtml(s.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.name)}</a>`
      : `<span class="news-source-pill">${escapeHtml(s.name)}</span>`
  ).join('');

  // Expanded source list (shown on card click)
  const expandedHtml = sources.map(s => `
    <div class="news-story-source-row">
      <span class="news-story-source-name">${escapeHtml(s.name)}</span>
      <span class="news-story-source-sep">—</span>
      ${s.link
        ? `<a class="news-story-source-title" href="${escapeHtml(s.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a>`
        : `<span class="news-story-source-title">${escapeHtml(s.title)}</span>`
      }
      ${s.published ? `<span class="news-story-source-pub">${escapeHtml(s.published)}</span>` : ''}
    </div>
  `).join('');

  card.innerHTML = `
    <div class="news-story-headline">${escapeHtml(headline)}</div>
    ${summary ? `<div class="news-story-summary">${escapeHtml(summary)}</div>` : ''}
    <div class="news-story-meta-row">
      <div class="news-story-pills">${pillsHtml}</div>
      <div class="news-story-right">
        ${multiSrc ? `<span class="news-story-src-count">${sources.length} sources</span>` : ''}
        ${pubLabel  ? `<span class="news-item-pub">${escapeHtml(pubLabel)}</span>` : ''}
      </div>
    </div>
    <div class="news-story-expanded">
      <div class="news-story-expanded-sources">${expandedHtml}</div>
    </div>
    ${firstLink ? `<div class="news-item-actions"><button class="news-item-view-btn">VIEW ARTICLE</button></div>` : ''}
  `;

  // VIEW ARTICLE opens the first source link without propagating
  const viewBtn = card.querySelector('.news-item-view-btn');
  viewBtn?.addEventListener('click', e => {
    e.stopPropagation();
    window.open(firstLink, '_blank', 'noopener,noreferrer');
  });

  // Card click: deactivate others, activate this one (triggering Starling), expand sources
  card.addEventListener('click', e => {
    if (e.target.tagName === 'A') return;
    const wasActive = card.classList.contains('active');
    if (_activeCard && _activeCard !== card) {
      _activeCard.classList.remove('active');
      _activeCard.classList.remove('expanded');
    }
    if (wasActive) {
      card.classList.remove('active');
      card.classList.remove('expanded');
      _activeCard        = null;
      _activeArticleData = null;
    } else {
      card.classList.add('active');
      card.classList.add('expanded');
      _activeCard        = card;
      _activeArticleData = { title: story.headline, summary: story.summary || '' };
      _speakStory(story);
    }
  });

  return card;
}

// ── Starling speech helpers ───────────────────────────────────────────────────

// Debounce timer — prevents rapid card taps from queuing multiple LLM calls.
let _speakDebounceTimer = null;

function _scheduleSpeak(fn) {
  if (_speakDebounceTimer !== null) clearTimeout(_speakDebounceTimer);
  _speakDebounceTimer = setTimeout(() => {
    _speakDebounceTimer = null;
    fn();
  }, 80);
}

function _speakHeadline(item) {
  const interruptResult = _interruptSpeech ? _interruptSpeech() : null;
  const existingEl = interruptResult?.wasActive ? interruptResult : null;
  _scheduleSpeak(() => {
    if (!_sendToOllama) {
      if (_enqueueSpeak) _enqueueSpeak(item.title);
      return;
    }
    const sysPrompt = 'You are Starling. The user has tapped a news headline. Read the headline naturally, share a brief 1-2 sentence reaction or context, then ask if they would like to open the full article. Keep your total response under 5 sentences.';
    _sendToOllama(
      `Headline: "${item.title}"${item.summary ? `\nSummary: "${item.summary}"` : ''}`,
      { ephemeralMessages: [{ role: 'system', content: sysPrompt }], existingElement: existingEl },
    );
  });
}

function _speakStory(story) {
  const interruptResult = _interruptSpeech ? _interruptSpeech() : null;
  const existingEl = interruptResult?.wasActive ? interruptResult : null;
  _scheduleSpeak(() => {
    if (!_sendToOllama) {
      if (_enqueueSpeak) _enqueueSpeak(story.headline);
      return;
    }
    const srcList = story.sources?.length > 1
      ? `\nCovered by ${story.sources.length} outlets including: ${story.sources.slice(0, 3).map(s => s.name).join(', ')}.`
      : '';
    const sysPrompt = 'You are Starling. The user has tapped a news story. Read the headline naturally, share a brief 1-2 sentence reaction, mention the number of sources covering it, then ask if they would like to open the full article. Keep your total response under 5 sentences.';
    _sendToOllama(
      `Headline: "${story.headline}"${story.summary ? `\nSummary: "${story.summary}"` : ''}${srcList}`,
      { ephemeralMessages: [{ role: 'system', content: sysPrompt }], existingElement: existingEl },
    );
  });
}
