// frontend/news-panel.js
// News briefing panel: trigger detection, data fetch, render, and LLM context export.

const BACKEND_BASE_NEWS = 'http://localhost:8000';

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

// ── DOM refs ──────────────────────────────────────────────────────────────────
const newsPanel      = document.getElementById('news-panel');
const newsMeta       = document.getElementById('news-meta');
const newsTitle      = document.getElementById('news-title');
const newsTabs       = document.getElementById('news-tabs');
const newsList       = document.getElementById('news-list');
const newsFetched    = document.getElementById('news-fetched');
const newsRefreshBtn = document.getElementById('news-refresh-btn');
const newsCategories = document.getElementById('news-categories');
const newsSynthIndicator = document.getElementById('news-synth-indicator');

// ── State ─────────────────────────────────────────────────────────────────────
let _newsData        = null;   // last fetched payload
let _activeTab       = 'all'; // currently selected source tab
let _activeCategory  = 'world'; // currently selected category

// Synthesis polling state (Approach A)
let _synthPollTimer  = null;
let _synthPollCount  = 0;
const SYNTH_POLL_INTERVAL_MS = 3000;  // check every 3 s
const SYNTH_POLL_MAX         = 40;    // give up after 120 s

// ── Refresh button ────────────────────────────────────────────────────────────
newsRefreshBtn?.addEventListener('click', async () => {
  newsRefreshBtn.textContent = '↻ FETCHING…';
  newsRefreshBtn.disabled    = true;
  await fetch(`${BACKEND_BASE_NEWS}/news/cache`, { method: 'DELETE' }).catch(() => {});
  await openNewsPanel(_activeCategory, true);
  newsRefreshBtn.textContent = '↻ REFRESH';
  newsRefreshBtn.disabled    = false;
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
    // Category-specific patterns
    /\b(?:show\s+me(?:\s+the)?|pull\s+up(?:\s+the)?|display(?:\s+the)?|give\s+me(?:\s+the)?|get(?:\s+me)?(?:\s+the)?)\s+\w+\s+(?:news|headlines?|briefing)\b/,
    /\b\w+\s+(?:news|headlines?|briefing)\b/,
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
  _stopSynthesisPolling();

  if (newsMeta) newsMeta.textContent = 'LOADING…';

  let data;
  try {
    const res = await fetch(`${BACKEND_BASE_NEWS}/news?category=${encodeURIComponent(category)}`);
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

  // Ensure indicator is hidden until polling confirms synthesis is in flight
  newsSynthIndicator?.classList.add('hidden');

  // Render raw cards immediately — panel opens without waiting for synthesis
  _renderPanel(data);
  newsPanel.classList.remove('hidden');

  // Start background synthesis polling if synthesis is expected (Approach A)
  if (data.synthesis_enabled && data.synthesis_status !== 'disabled') {
    _startSynthesisPolling(category, data.total);
  }

  return data.llm_context;
}

export function closeNewsPanel() {
  newsPanel?.classList.add('hidden');
  _newsData = null;
  _stopSynthesisPolling();
}

// ── Synthesis polling (Approach A) ────────────────────────────────────────────

function _startSynthesisPolling(category, rawCount) {
  _synthPollCount = 0;
  _updateSynthMeta(rawCount, true);
  newsSynthIndicator?.classList.remove('hidden');

  _synthPollTimer = setInterval(async () => {
    _synthPollCount++;
    if (_synthPollCount > SYNTH_POLL_MAX) {
      _stopSynthesisPolling();
      _updateSynthMeta(_newsData?.total ?? rawCount, false);
      return;
    }

    try {
      const res  = await fetch(`${BACKEND_BASE_NEWS}/news/synthesised?category=${encodeURIComponent(category)}`);
      const body = await res.json();

      if (body.status === 'ready' && body.stories?.length > 0) {
        _stopSynthesisPolling();
        if (_newsData) _newsData.synthesised = body.stories;

        // Only patch the list when the user hasn't drilled into a specific source
        if (_activeTab === 'all') {
          _renderSynthesisedList(body.stories, /* incoming */ true);
          if (newsMeta) newsMeta.textContent = `${body.stories.length} STORIES`;
        } else {
          // Update meta quietly so the "ALL" tab will show synthesis if selected
          if (newsMeta) newsMeta.textContent = `${body.stories.length} STORIES`;
        }
      } else if (body.status === 'none') {
        _stopSynthesisPolling();
        _updateSynthMeta(_newsData?.total ?? rawCount, false);
      }
    } catch (_) { /* network hiccup — keep polling */ }
  }, SYNTH_POLL_INTERVAL_MS);
}

function _stopSynthesisPolling() {
  if (_synthPollTimer !== null) {
    clearInterval(_synthPollTimer);
    _synthPollTimer = null;
  }
  newsSynthIndicator?.classList.add('hidden');
}

function _updateSynthMeta(count, synthesising) {
  if (!newsMeta) return;
  newsMeta.textContent = synthesising
    ? `${count} HEADLINES · SYNTHESISING…`
    : `${count} HEADLINES`;
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

  // ── Category chips ──────────────────────────────────────────────────────────
  if (newsCategories) {
    newsCategories.innerHTML = '';
    CATEGORIES.forEach(({ key, label }) => {
      const chip       = document.createElement('button');
      chip.className   = 'news-category-chip';
      chip.textContent = label;
      chip.dataset.key = key;
      if (key === (category ?? 'world')) chip.classList.add('active');
      chip.addEventListener('click', async () => {
        if (chip.classList.contains('active')) return;
        newsCategories.querySelectorAll('.news-category-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        await openNewsPanel(key, true);
      });
      newsCategories.appendChild(chip);
    });
  }

  // ── Source tabs — "ALL" first, then one per source ──────────────────────────
  newsTabs.innerHTML = '';
  const allTab = _makeTab('ALL', 'all');
  allTab.classList.add('active');
  newsTabs.appendChild(allTab);
  sources.forEach(src => newsTabs.appendChild(_makeTab(src, src)));

  // ── Headline / story list ──────────────────────────────────────────────────
  if (synthesised && synthesised.length > 0) {
    _renderSynthesisedList(synthesised, false);
    newsMeta.textContent = `${synthesised.length} STORIES`;
  } else {
    _renderList(headlines);
  }
}

function _makeTab(label, key) {
  const btn       = document.createElement('button');
  btn.className   = 'news-tab';
  btn.textContent = label.length > 14 ? label.slice(0, 12) + '…' : label;
  btn.dataset.key = key;
  btn.addEventListener('click', () => {
    if (!_newsData) return;
    _activeTab = key;
    newsTabs.querySelectorAll('.news-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');

    // If we have synthesis results AND showing "all" sources, show synthesis cards
    if (key === 'all' && _newsData.synthesised?.length > 0) {
      _renderSynthesisedList(_newsData.synthesised, false);
    } else {
      const items = key === 'all'
        ? _newsData.headlines
        : (_newsData.by_source[key] ?? []);
      _renderList(items);
    }
  });
  return btn;
}

function _renderList(items) {
  newsList.innerHTML = '';
  if (!items.length) {
    newsList.innerHTML = '<div style="font-size:0.7rem;color:#444;padding:4px 0;">No headlines available.</div>';
    return;
  }
  // Approach B: stagger each card in with a cascade delay
  items.forEach((item, i) => {
    const card = _makeHeadlineCard(item);
    card.style.setProperty('--card-delay', `${i * 40}ms`);
    newsList.appendChild(card);
  });
}

function _renderSynthesisedList(stories, incoming = false) {
  newsList.innerHTML = '';
  if (!stories.length) {
    newsList.innerHTML = '<div style="font-size:0.7rem;color:#444;padding:4px 0;">No stories available.</div>';
    return;
  }
  // Stagger cards; use a longer base delay when patching in synthesis results
  // so the transition feels deliberate rather than a jarring instant swap.
  const baseDelay = incoming ? 80 : 40;
  stories.forEach((story, i) => {
    const card = _makeStoryCard(story);
    card.style.setProperty('--card-delay', `${i * baseDelay}ms`);
    if (incoming) card.classList.add('incoming');
    newsList.appendChild(card);
  });
}

function _makeHeadlineCard(item) {
  const card     = document.createElement('div');
  card.className = 'news-item';
  card.innerHTML = `
    <div class="news-item-meta">
      <span class="news-item-source">${_esc(item.source)}</span>
      ${item.pub ? `<span class="news-item-pub">${_esc(item.pub)}</span>` : ''}
    </div>
    <div class="news-item-title">${_esc(item.title)}</div>
    ${item.summary ? `<div class="news-item-summary">${_esc(item.summary)}</div>` : ''}
  `;
  if (item.link) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => window.open(item.link, '_blank', 'noopener,noreferrer'));
  }
  return card;
}

function _makeStoryCard(story) {
  const { headline, summary, sources = [] } = story;

  // Pick most-recent published label from sources
  const pubLabel = sources.length > 0 ? sources[0].published ?? '' : '';
  const multiSrc = sources.length > 1;

  const card     = document.createElement('div');
  card.className = 'news-story-card';

  // Pills row (compact — only a few, truncate rest in expanded section)
  const pillsHtml = sources.slice(0, 4).map(s =>
    s.link
      ? `<a class="news-source-pill" href="${_esc(s.link)}" target="_blank" rel="noopener noreferrer">${_esc(s.name)}</a>`
      : `<span class="news-source-pill">${_esc(s.name)}</span>`
  ).join('');

  // Expanded source list (shown on card click)
  const expandedHtml = sources.map(s => `
    <div class="news-story-source-row">
      <span class="news-story-source-name">${_esc(s.name)}</span>
      <span class="news-story-source-sep">—</span>
      ${s.link
        ? `<a class="news-story-source-title" href="${_esc(s.link)}" target="_blank" rel="noopener noreferrer">${_esc(s.title)}</a>`
        : `<span class="news-story-source-title">${_esc(s.title)}</span>`
      }
      ${s.published ? `<span class="news-story-source-pub">${_esc(s.published)}</span>` : ''}
    </div>
  `).join('');

  card.innerHTML = `
    <div class="news-story-headline">${_esc(headline)}</div>
    ${summary ? `<div class="news-story-summary">${_esc(summary)}</div>` : ''}
    <div class="news-story-meta-row">
      <div class="news-story-pills">${pillsHtml}</div>
      <div class="news-story-right">
        ${multiSrc ? `<span class="news-story-src-count">${sources.length} sources</span>` : ''}
        ${pubLabel  ? `<span class="news-item-pub">${_esc(pubLabel)}</span>` : ''}
      </div>
    </div>
    <div class="news-story-expanded">
      <div class="news-story-expanded-sources">${expandedHtml}</div>
    </div>
  `;

  // Toggle expand/collapse on card click (but don't interfere with pill/link clicks)
  card.addEventListener('click', e => {
    if (e.target.tagName === 'A') return;
    card.classList.toggle('expanded');
  });

  return card;
}

function _esc(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
