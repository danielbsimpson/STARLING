// frontend/youtube-panel.js
// YouTube feed panel: trigger detection, channel RSS fetch, tile-grid rendering,
// type/channel/sort filtering, background synthesis polling, and spoken briefing.

const BACKEND_BASE_YT = 'http://localhost:8000';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const ytPanel           = document.getElementById('yt-panel');
const ytMeta            = document.getElementById('yt-meta');
const ytTitle           = document.getElementById('yt-title');
const ytTileGrid        = document.getElementById('yt-tile-grid');
const ytFetched         = document.getElementById('yt-fetched');
const ytRefreshBtn      = document.getElementById('yt-refresh-btn');
const ytSynthIndicator  = document.getElementById('yt-synth-indicator');
const ytTypeFilterBar   = document.getElementById('yt-type-filter-bar');
const ytChannelFilterBar = document.getElementById('yt-channel-filter-bar');
const ytSortBar         = document.getElementById('yt-sort-bar');

// ── Module state ──────────────────────────────────────────────────────────────
let _ytData          = null;
let _activeType      = 'all';    // 'all' | 'long' | 'shorts'
let _activeChannel   = 'all';
let _activeSort      = 'date';
let _synthPollTimer  = null;
let _synthPollCount  = 0;

const SYNTH_POLL_INTERVAL_MS = 3000;
const SYNTH_POLL_MAX         = 40;

// ── Service refs (injected by initYouTubePanel) ───────────────────────────────
let _enqueueSpeak     = null;
let _sendToOllama     = null;
let _openBrowserPanel = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if the transcript matches the YouTube feed trigger phrase, null otherwise.
 * Only matches "Open YouTube Feed" or "View YouTube Feed" (case-insensitive).
 */
export function detectYouTubeTrigger(transcript) {
  return /\b(?:open|view)\s+youtube\s+feed\b/i.test(transcript) || null;
}

/**
 * Fetch the YouTube feed and render the panel.
 * Returns the llm_context string for LLM injection, or null on failure.
 */
export async function openYouTubePanel(options = {}) {
  _activeType    = 'all';
  _activeChannel = 'all';
  _activeSort    = options.sort || 'date';

  if (ytMeta) ytMeta.textContent = 'LOADING…';
  if (ytPanel) ytPanel.classList.remove('hidden');

  const params = new URLSearchParams();
  if (options.channel) params.set('channel', options.channel);
  if (_activeSort !== 'date') params.set('sort', _activeSort);
  const query = params.toString() ? `?${params}` : '';

  let data;
  try {
    const res = await fetch(`${BACKEND_BASE_YT}/youtube${query}`);
    if (!res.ok) throw new Error(`YouTube API ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[youtube-panel] fetch failed:', err);
    if (ytMeta) ytMeta.textContent = '—';
    if (ytTitle) ytTitle.textContent = 'YOUTUBE FEED';
    if (ytTileGrid) ytTileGrid.innerHTML = '<div class="yt-empty-state">YouTube feed unavailable.</div>';
    return null;
  }

  _ytData = data;
  ytSynthIndicator?.classList.add('hidden');

  _renderPanel(data);

  if (data.synthesis_enabled && data.synthesis_status !== 'disabled') {
    _startSynthesisPolling(data.channels, data.total);
  }

  return data.llm_context || null;
}

/**
 * Hide the YouTube panel and stop synthesis polling.
 */
export function closeYouTubePanel() {
  ytPanel?.classList.add('hidden');
  _ytData = null;
  _stopSynthesisPolling();
}

/**
 * Inject service references and wire the refresh button.
 * Call once during app initialisation.
 */
export function initYouTubePanel({ enqueueSpeak, sendToOllama, openBrowserPanel } = {}) {
  _enqueueSpeak     = enqueueSpeak     || null;
  _sendToOllama     = sendToOllama     || null;
  _openBrowserPanel = openBrowserPanel || null;

  ytRefreshBtn?.addEventListener('click', async () => {
    ytRefreshBtn.textContent = '↻ FETCHING…';
    ytRefreshBtn.disabled    = true;
    await fetch(`${BACKEND_BASE_YT}/youtube/cache`, { method: 'DELETE' }).catch(() => {});
    await openYouTubePanel({ sort: _activeSort, silent: true });
    ytRefreshBtn.textContent = '↻ REFRESH';
    ytRefreshBtn.disabled    = false;
  });
}

// ── Internal rendering ────────────────────────────────────────────────────────

function _renderPanel(data) {
  if (ytTitle)   ytTitle.textContent  = 'YOUTUBE FEED';
  if (ytMeta)    ytMeta.textContent   = `${data.total} VIDEOS`;
  if (ytFetched) ytFetched.textContent = `FETCHED ${new Date(data.fetched_at).toLocaleTimeString()}`;

  _renderTypeFilterBar(data.api_key_configured);
  _renderChannelFilterBar(data.channels, data.channel_names);
  _renderSortBar();
  _renderTileGrid();
}

function _renderTypeFilterBar(apiKeyConfigured) {
  if (!ytTypeFilterBar) return;
  ytTypeFilterBar.innerHTML = '';

  const types = [
    { key: 'all',    label: 'ALL' },
    { key: 'long',   label: 'LONG FORM' },
    { key: 'shorts', label: 'SHORTS' },
  ];

  for (const { key, label } of types) {
    const btn = document.createElement('button');
    btn.className = 'yt-filter-btn';
    btn.textContent = label;
    if (key === _activeType) btn.classList.add('yt-filter-btn--active');

    if (key !== 'all' && !apiKeyConfigured) {
      btn.disabled                = true;
      btn.dataset.requiresApi     = 'true';
      btn.title                   = 'Requires YOUTUBE_API_KEY in .env';
      btn.classList.add('yt-filter-btn--disabled');
    } else {
      btn.addEventListener('click', () => {
        _activeType = key;
        _updateActiveBtn(ytTypeFilterBar, btn);
        _renderTileGrid();
      });
    }

    ytTypeFilterBar.appendChild(btn);
  }
}

function _renderChannelFilterBar(channelIds, channelNames) {
  if (!ytChannelFilterBar) return;
  ytChannelFilterBar.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className    = 'yt-filter-btn';
  allBtn.textContent  = 'ALL CHANNELS';
  if (_activeChannel === 'all') allBtn.classList.add('yt-filter-btn--active');
  allBtn.addEventListener('click', () => {
    _activeChannel = 'all';
    _updateActiveBtn(ytChannelFilterBar, allBtn);
    _renderTileGrid();
  });
  ytChannelFilterBar.appendChild(allBtn);

  for (const id of channelIds) {
    const btn       = document.createElement('button');
    btn.className   = 'yt-filter-btn';
    btn.textContent = channelNames?.[id] || id;
    if (_activeChannel === id) btn.classList.add('yt-filter-btn--active');
    btn.addEventListener('click', () => {
      _activeChannel = id;
      _updateActiveBtn(ytChannelFilterBar, btn);
      _renderTileGrid();
    });
    ytChannelFilterBar.appendChild(btn);
  }
}

function _renderSortBar() {
  if (!ytSortBar) return;
  ytSortBar.innerHTML = '';

  const sorts = [
    { key: 'date',    label: 'DATE' },
    { key: 'views',   label: 'VIEWS' },
    { key: 'channel', label: 'CHANNEL' },
  ];

  for (const { key, label } of sorts) {
    const btn       = document.createElement('button');
    btn.className   = 'yt-filter-btn';
    btn.textContent = label;
    if (key === _activeSort) btn.classList.add('yt-filter-btn--active');
    btn.addEventListener('click', () => {
      _activeSort = key;
      _updateActiveBtn(ytSortBar, btn);
      _renderTileGrid();
    });
    ytSortBar.appendChild(btn);
  }
}

function _renderTileGrid() {
  if (!ytTileGrid || !_ytData) return;
  ytTileGrid.innerHTML = '';

  let videos = [..._ytData.videos];

  // Type filter (requires Phase 2 duration data)
  if (_activeType === 'long') {
    videos = videos.filter(v => v.is_short === false);
  } else if (_activeType === 'shorts') {
    videos = videos.filter(v => v.is_short === true);
  }

  // Channel filter
  if (_activeChannel !== 'all') {
    videos = videos.filter(v => v.channel_id === _activeChannel);
  }

  // Sort
  if (_activeSort === 'views') {
    videos.sort((a, b) => b.views - a.views);
  } else if (_activeSort === 'channel') {
    videos.sort((a, b) => a.channel.localeCompare(b.channel) || b.published_ts - a.published_ts);
  } else {
    videos.sort((a, b) => b.published_ts - a.published_ts);
  }

  if (videos.length === 0) {
    const empty = document.createElement('div');
    empty.className   = 'yt-empty-state';
    empty.textContent = 'No videos match the current filter.';
    ytTileGrid.appendChild(empty);
    return;
  }

  for (const video of videos) {
    ytTileGrid.appendChild(_createVideoTile(video));
  }
}

function _createVideoTile(video) {
  const tile = document.createElement('div');
  tile.className = 'yt-tile';

  // Thumbnail
  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'yt-tile-thumb-wrap';

  if (video.thumbnail_url) {
    const img      = document.createElement('img');
    img.className  = 'yt-tile-thumb';
    img.loading    = 'lazy';
    img.src        = video.thumbnail_url;
    img.alt        = '';
    img.onerror    = () => {
      img.style.display = 'none';
      const fb = thumbWrap.querySelector('.yt-tile-thumb-fallback');
      if (fb) fb.style.display = 'flex';
    };
    thumbWrap.appendChild(img);
  }

  // Fallback placeholder (shown when image fails)
  const fallback       = document.createElement('div');
  fallback.className   = 'yt-tile-thumb-fallback';
  fallback.style.display = 'none';
  const initial        = document.createElement('span');
  initial.textContent  = (video.channel || '?')[0].toUpperCase();
  fallback.appendChild(initial);
  thumbWrap.appendChild(fallback);

  // Shorts badge (Phase 2)
  if (video.is_short === true) {
    const badge       = document.createElement('span');
    badge.className   = 'yt-shorts-badge';
    badge.textContent = 'SHORTS';
    thumbWrap.appendChild(badge);
  }

  tile.appendChild(thumbWrap);

  // Info block
  const info = document.createElement('div');
  info.className = 'yt-tile-info';

  const titleEl       = document.createElement('div');
  titleEl.className   = 'yt-tile-title';
  titleEl.textContent = video.title;
  info.appendChild(titleEl);

  const channelEl       = document.createElement('div');
  channelEl.className   = 'yt-tile-channel';
  channelEl.textContent = video.channel;
  info.appendChild(channelEl);

  const stats       = document.createElement('div');
  stats.className   = 'yt-tile-stats';
  const viewSpan    = document.createElement('span');
  viewSpan.textContent = video.views_fmt !== '—' ? `▶ ${video.views_fmt}` : '';
  const ageSpan     = document.createElement('span');
  ageSpan.textContent  = video.age;
  stats.appendChild(viewSpan);
  stats.appendChild(ageSpan);
  info.appendChild(stats);

  tile.appendChild(info);

  // Click → open in browser panel or new tab
  tile.addEventListener('click', () => {
    if (_openBrowserPanel) {
      _openBrowserPanel(video.link);
    } else {
      window.open(video.link, '_blank', 'noopener,noreferrer');
    }
  });

  return tile;
}

// ── Synthesis polling ─────────────────────────────────────────────────────────

function _startSynthesisPolling(channels, rawCount) {
  _synthPollCount = 0;
  if (ytSynthIndicator) ytSynthIndicator.classList.remove('hidden');
  if (ytMeta) ytMeta.textContent = `${rawCount} VIDEOS · ANALYSING…`;

  _synthPollTimer = setInterval(async () => {
    _synthPollCount++;
    if (_synthPollCount > SYNTH_POLL_MAX) {
      _stopSynthesisPolling();
      if (ytMeta) ytMeta.textContent = `${_ytData?.total ?? rawCount} VIDEOS`;
      return;
    }

    try {
      const res  = await fetch(`${BACKEND_BASE_YT}/youtube/synthesised`);
      const body = await res.json();

      if (body.status === 'ready' && body.result) {
        _stopSynthesisPolling();
        if (_ytData) _ytData.synthesis = body.result;
        if (ytMeta) ytMeta.textContent = `${_ytData?.total ?? rawCount} VIDEOS · ANALYSED`;
        _speakBriefing(body.result.briefing);
      } else if (body.status === 'none') {
        _stopSynthesisPolling();
        if (ytMeta) ytMeta.textContent = `${_ytData?.total ?? rawCount} VIDEOS`;
      }
    } catch (_) { /* network hiccup — keep polling */ }
  }, SYNTH_POLL_INTERVAL_MS);
}

function _stopSynthesisPolling() {
  if (_synthPollTimer) {
    clearInterval(_synthPollTimer);
    _synthPollTimer = null;
  }
  ytSynthIndicator?.classList.add('hidden');
}

function _speakBriefing(briefingText) {
  if (briefingText && typeof briefingText === 'string' && _enqueueSpeak) {
    _enqueueSpeak(briefingText);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _updateActiveBtn(container, activeBtn) {
  for (const btn of container.querySelectorAll('.yt-filter-btn')) {
    btn.classList.toggle('yt-filter-btn--active', btn === activeBtn);
  }
}
