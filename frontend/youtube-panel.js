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
const ytSettingsBtn     = document.getElementById('yt-settings-btn');
const ytSettingsView    = document.getElementById('yt-settings-view');
const ytSettingsBackBtn = document.getElementById('yt-settings-back-btn');
const ytSettingsChannelList = document.getElementById('yt-settings-channel-list');
const ytSettingsInput   = document.getElementById('yt-settings-input');
const ytSettingsAddBtn  = document.getElementById('yt-settings-add-btn');
const ytSettingsError   = document.getElementById('yt-settings-error');

// ── Video modal DOM refs ──────────────────────────────────────────────────────
const ytVideoModal       = document.getElementById('yt-video-modal');
const ytVideoModalHeader = document.getElementById('yt-video-modal-header');
const ytVideoModalFrame  = document.getElementById('yt-video-modal-frame');
const ytVideoModalTitle  = document.getElementById('yt-video-modal-title');
const ytVideoModalClose  = document.getElementById('yt-video-modal-close');

// ── Module state ──────────────────────────────────────────────────────────────
let _ytData          = null;
let _activeType      = 'all';    // 'all' | 'long' | 'shorts'
let _activeChannel   = 'all';
let _activeSort      = 'date';
let _synthPollTimer  = null;
let _synthPollCount  = 0;

const SYNTH_POLL_INTERVAL_MS = 3000;
const SYNTH_POLL_MAX         = 40;

// ── Video modal drag state ────────────────────────────────────────────────────
let _dragActive  = false;
let _dragOffsetX = 0;
let _dragOffsetY = 0;

// ── Service refs (injected by initYouTubePanel) ───────────────────────────────
let _enqueueSpeak     = null;
let _sendToOllama     = null;
let _interruptSpeech  = null;

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
  _hideSettingsView();
  ytPanel?.classList.add('hidden');
  _ytData = null;
  _stopSynthesisPolling();
}

/**
 * Inject service references and wire the refresh button.
 * Call once during app initialisation.
 */
export function initYouTubePanel({ enqueueSpeak, sendToOllama, interruptSpeech } = {}) {
  _enqueueSpeak    = enqueueSpeak    || null;
  _sendToOllama    = sendToOllama    || null;
  _interruptSpeech = interruptSpeech || null;

  // Wire video modal close button
  ytVideoModalClose?.addEventListener('click', _closeVideoModal);

  // Wire drag on modal header
  ytVideoModalHeader?.addEventListener('mousedown', _onModalDragStart);
  document.addEventListener('mousemove', _onModalDragMove);
  document.addEventListener('mouseup',   _onModalDragEnd);

  ytRefreshBtn?.addEventListener('click', async () => {
    ytRefreshBtn.textContent = '↻ FETCHING…';
    ytRefreshBtn.disabled    = true;
    await _hardRefresh();
    ytRefreshBtn.textContent = '\u21bb REFRESH';
    ytRefreshBtn.disabled    = false;
  });

  ytSettingsBtn?.addEventListener('click', _showSettingsView);
  ytSettingsBackBtn?.addEventListener('click', _hideSettingsView);
  ytSettingsAddBtn?.addEventListener('click', () => _addChannel(ytSettingsInput.value));
  ytSettingsInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _addChannel(ytSettingsInput.value);
  });
  ytSettingsInput?.addEventListener('input', _hideSettingsError);
}

// ── Internal rendering ────────────────────────────────────────────────────────

async function _hardRefresh() {
  await fetch(`${BACKEND_BASE_YT}/youtube/cache`, { method: 'DELETE' }).catch(() => {});
  await openYouTubePanel({ sort: _activeSort, silent: true });
}

function _showSettingsView() {
  ytTypeFilterBar?.classList.add('hidden');
  ytChannelFilterBar?.classList.add('hidden');
  ytSortBar?.classList.add('hidden');
  ytTileGrid?.classList.add('hidden');
  ytFetched?.classList.add('hidden');
  ytRefreshBtn?.classList.add('hidden');
  ytSettingsBtn?.classList.add('hidden');
  ytSettingsView?.classList.remove('hidden');
  _fetchAndRenderChannelList();
}

function _hideSettingsView() {
  ytSettingsView?.classList.add('hidden');
  ytTypeFilterBar?.classList.remove('hidden');
  ytChannelFilterBar?.classList.remove('hidden');
  ytSortBar?.classList.remove('hidden');
  ytTileGrid?.classList.remove('hidden');
  ytFetched?.classList.remove('hidden');
  ytRefreshBtn?.classList.remove('hidden');
  ytSettingsBtn?.classList.remove('hidden');
  _hideSettingsError();
  if (ytSettingsInput) ytSettingsInput.value = '';
}

async function _fetchAndRenderChannelList() {
  if (ytSettingsChannelList) ytSettingsChannelList.innerHTML = '<div class="yt-settings-loading">LOADING\u2026</div>';
  try {
    const res = await fetch(`${BACKEND_BASE_YT}/youtube/channels`);
    if (!res.ok) {
      if (ytSettingsChannelList) ytSettingsChannelList.innerHTML = '<div class="yt-settings-error-inline">Failed to load channels.</div>';
      return;
    }
    const channels = await res.json();
    if (ytSettingsChannelList) {
      ytSettingsChannelList.innerHTML = '';
      const resolved = channels.filter(ch => ch.resolved !== false);
      const pending  = channels.filter(ch => ch.resolved === false);
      for (const ch of resolved) {
        ytSettingsChannelList.appendChild(_createChannelRow(ch.id || ch.channel_id, ch.name));
      }
      if (pending.length > 0) {
        const header = document.createElement('div');
        header.className = 'yt-settings-pending-header';
        header.textContent = `${pending.length} CHANNEL${pending.length === 1 ? '' : 'S'} PENDING RESOLUTION`;
        ytSettingsChannelList.appendChild(header);
        for (const ch of pending) {
          ytSettingsChannelList.appendChild(_createPendingChannelRow(ch.name, ch.handle));
        }
      }
    }
  } catch (_) {
    if (ytSettingsChannelList) ytSettingsChannelList.innerHTML = '<div class="yt-settings-error-inline">Failed to load channels.</div>';
  }
}

function _createChannelRow(channelId, displayName) {
  const row = document.createElement('div');
  row.className = 'yt-settings-channel-row';

  const nameEl = document.createElement('div');
  nameEl.className = 'yt-settings-channel-name';
  nameEl.textContent = displayName || channelId;
  row.appendChild(nameEl);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'yt-settings-remove-btn';
  removeBtn.title = 'Remove channel';
  removeBtn.textContent = '\u2715';
  removeBtn.addEventListener('click', async () => {
    removeBtn.disabled = true;
    const ok = await _removeChannel(channelId);
    if (!ok) removeBtn.disabled = false;
  });
  row.appendChild(removeBtn);

  return row;
}

function _createPendingChannelRow(displayName, handle) {
  const row = document.createElement('div');
  row.className = 'yt-settings-channel-row yt-settings-channel-row--pending';

  const nameEl = document.createElement('div');
  nameEl.className = 'yt-settings-channel-name';
  nameEl.textContent = displayName || handle || '(unknown)';
  row.appendChild(nameEl);

  const badge = document.createElement('span');
  badge.className = 'yt-settings-pending-badge';
  badge.textContent = 'PENDING';
  row.appendChild(badge);

  return row;
}

async function _removeChannel(channelId) {
  try {
    const res = await fetch(`${BACKEND_BASE_YT}/youtube/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      _showSettingsError(body.detail || 'Failed to remove channel.');
      return false;
    }
    await _fetchAndRenderChannelList();
    _hardRefresh(); // background refresh — do not await
    return true;
  } catch (_) {
    _showSettingsError('Failed to remove channel.');
    return false;
  }
}

async function _addChannel(rawValue) {
  const channelId = (rawValue || '').trim();
  if (!/^UC[A-Za-z0-9_\-]{22}$/.test(channelId)) {
    _showSettingsError('Invalid format. Must be a YouTube channel ID starting with UC (26 chars total).');
    return;
  }
  if (ytSettingsAddBtn) ytSettingsAddBtn.disabled = true;
  try {
    const res = await fetch(`${BACKEND_BASE_YT}/youtube/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      _showSettingsError(body.detail || 'Failed to add channel.');
      if (ytSettingsAddBtn) ytSettingsAddBtn.disabled = false;
      return;
    }
    if (ytSettingsInput) ytSettingsInput.value = '';
    _hideSettingsError();
    if (ytSettingsAddBtn) ytSettingsAddBtn.disabled = false;
    await _fetchAndRenderChannelList();
    _hardRefresh(); // background refresh — do not await
  } catch (_) {
    _showSettingsError('Failed to add channel.');
    if (ytSettingsAddBtn) ytSettingsAddBtn.disabled = false;
  }
}

function _showSettingsError(msg) {
  if (!ytSettingsError) return;
  ytSettingsError.textContent = msg;
  ytSettingsError.classList.remove('hidden');
}

function _hideSettingsError() {
  if (!ytSettingsError) return;
  ytSettingsError.textContent = '';
  ytSettingsError.classList.add('hidden');
}

function _renderPanel(data) {
  if (ytTitle)   ytTitle.textContent  = 'YOUTUBE FEED';
  if (ytMeta)    ytMeta.textContent   = `${data.total} VIDEOS`;
  if (ytFetched) ytFetched.textContent = `FETCHED ${new Date(data.fetched_at).toLocaleTimeString()}`;

  _renderTypeFilterBar();
  _renderChannelFilterBar(data.channels, data.channel_names);
  _renderSortBar();
  _renderTileGrid();
}

function _renderTypeFilterBar() {
  if (!ytTypeFilterBar) return;
  ytTypeFilterBar.innerHTML = '';

  const sel = document.createElement('select');
  sel.className = 'yt-filter-select';

  const types = [
    { key: 'all',    label: 'ALL' },
    { key: 'long',   label: 'LONG FORM' },
    { key: 'shorts', label: 'SHORTS' },
  ];

  for (const { key, label } of types) {
    const opt = document.createElement('option');
    opt.value       = key;
    opt.textContent = label;
    if (key === _activeType) opt.selected = true;
    sel.appendChild(opt);
  }

  sel.addEventListener('change', () => {
    _activeType = sel.value;
    _renderTileGrid();
  });

  ytTypeFilterBar.appendChild(sel);
}

function _renderChannelFilterBar(channelIds, channelNames) {
  if (!ytChannelFilterBar) return;
  ytChannelFilterBar.innerHTML = '';

  const sel = document.createElement('select');
  sel.className = 'yt-filter-select';

  const allOpt = document.createElement('option');
  allOpt.value       = 'all';
  allOpt.textContent = 'ALL CHANNELS';
  if (_activeChannel === 'all') allOpt.selected = true;
  sel.appendChild(allOpt);

  for (const id of channelIds) {
    const opt = document.createElement('option');
    opt.value       = id;
    opt.textContent = channelNames?.[id] || id;
    if (_activeChannel === id) opt.selected = true;
    sel.appendChild(opt);
  }

  sel.addEventListener('change', () => {
    _activeChannel = sel.value;
    _renderTileGrid();
  });

  ytChannelFilterBar.appendChild(sel);
}

function _renderSortBar() {
  if (!ytSortBar) return;
  ytSortBar.innerHTML = '';

  const sel = document.createElement('select');
  sel.className = 'yt-filter-select';

  const sorts = [
    { key: 'date',    label: 'DATE' },
    { key: 'views',   label: 'VIEWS' },
    { key: 'channel', label: 'CHANNEL' },
  ];

  for (const { key, label } of sorts) {
    const opt = document.createElement('option');
    opt.value       = key;
    opt.textContent = label;
    if (key === _activeSort) opt.selected = true;
    sel.appendChild(opt);
  }

  sel.addEventListener('change', () => {
    _activeSort = sel.value;
    _renderTileGrid();
  });

  ytSortBar.appendChild(sel);
}

function _renderTileGrid() {
  if (!ytTileGrid || !_ytData) return;
  ytTileGrid.innerHTML = '';

  let videos = [..._ytData.videos];

  // Type filter — use is_short when available (Phase 2), otherwise fall back
  // to URL-based detection (/shorts/ in the link).
  if (_activeType !== 'all') {
    videos = videos.filter(v => {
      const isShort = v.is_short !== null
        ? v.is_short
        : /\/shorts\//.test(v.link || '');
      return _activeType === 'shorts' ? isShort : !isShort;
    });
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

  // Click → open in floating video modal using embed URL (avoids X-Frame-Options block),
  // or fall back to new tab if video ID can't be extracted.
  tile.addEventListener('click', () => {
    const embedUrl = _toYouTubeEmbedUrl(video.link);
    if (embedUrl) {
      _openVideoModal(embedUrl, video.title);
    } else {
      window.open(video.link, '_blank', 'noopener,noreferrer');
    }
  });

  return tile;
}

/**
 * Convert a standard YouTube watch URL or youtu.be short URL to the embeddable
 * /embed/ form, which is not restricted by X-Frame-Options.
 * Returns null if the video ID cannot be extracted.
 */
function _toYouTubeEmbedUrl(link) {
  const match = link.match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  );
  if (!match) return null;
  return `https://www.youtube.com/embed/${match[1]}?autoplay=1`;
}

// ── Video modal helpers ───────────────────────────────────────────────────────

function _openVideoModal(embedUrl, title) {
  if (!ytVideoModal || !ytVideoModalFrame) return;

  // Stop Starling speaking — the video has its own audio
  _interruptSpeech?.();

  // Reset position to default (top-right) each time a new video opens
  ytVideoModal.style.left = '';
  ytVideoModal.style.top  = '';
  ytVideoModal.style.right  = '40px';
  ytVideoModal.style.bottom = '';

  if (ytVideoModalTitle) {
    ytVideoModalTitle.textContent = `▶ ${title || 'VIDEO'}`;
  }
  ytVideoModalFrame.src = embedUrl;
  ytVideoModal.classList.remove('hidden');
}

function _closeVideoModal() {
  if (!ytVideoModal || !ytVideoModalFrame) return;
  ytVideoModalFrame.src = '';
  ytVideoModal.classList.add('hidden');
  _dragActive = false;
}

function _onModalDragStart(e) {
  if (e.button !== 0) return;            // left mouse button only
  if (e.target === ytVideoModalClose) return; // don't drag when clicking close

  _dragActive = true;
  const rect  = ytVideoModal.getBoundingClientRect();

  // Convert to absolute positioning so we can freely move the element
  ytVideoModal.style.right  = '';
  ytVideoModal.style.bottom = '';
  ytVideoModal.style.left   = `${rect.left}px`;
  ytVideoModal.style.top    = `${rect.top}px`;

  _dragOffsetX = e.clientX - rect.left;
  _dragOffsetY = e.clientY - rect.top;
  e.preventDefault();
}

function _onModalDragMove(e) {
  if (!_dragActive) return;

  const maxX = window.innerWidth  - ytVideoModal.offsetWidth;
  const maxY = window.innerHeight - ytVideoModal.offsetHeight;
  const x    = Math.max(0, Math.min(e.clientX - _dragOffsetX, maxX));
  const y    = Math.max(0, Math.min(e.clientY - _dragOffsetY, maxY));

  ytVideoModal.style.left = `${x}px`;
  ytVideoModal.style.top  = `${y}px`;
}

function _onModalDragEnd() {
  _dragActive = false;
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


