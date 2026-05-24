// ── reddit-panel.js ────────────────────────────────────────────────────────────
// Reddit Social Feed panel — voice-triggered read-only Reddit integration.
// Follows the same structure as news-panel.js (trigger / fetch / render / poll).

const BACKEND_BASE_REDDIT = 'http://localhost:8000';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const redditPanel          = document.getElementById('reddit-panel');
const redditTitle          = document.getElementById('reddit-title');
const redditMeta           = document.getElementById('reddit-meta');
const redditSynthIndicator = document.getElementById('reddit-synth-indicator');
const redditFilterBar      = document.getElementById('reddit-filter-bar');
const redditPostList       = document.getElementById('reddit-post-list');
const redditFetched        = document.getElementById('reddit-fetched');
const redditRefreshBtn     = document.getElementById('reddit-refresh-btn');
const redditSettingsBtn    = document.getElementById('reddit-settings-btn');
const redditSettingsView   = document.getElementById('reddit-settings-view');
const redditSettingsBackBtn  = document.getElementById('reddit-settings-back-btn');
const redditSettingsSubList  = document.getElementById('reddit-settings-sub-list');
const redditSettingsInput    = document.getElementById('reddit-settings-input');
const redditSettingsAddBtn   = document.getElementById('reddit-settings-add-btn');
const redditSettingsError    = document.getElementById('reddit-settings-error');

// ── State ──────────────────────────────────────────────────────────────────────
let _redditData      = null;
let _activeSubreddit = 'all';
let _synthPollTimer  = null;
let _synthPollCount  = 0;

const SYNTH_POLL_INTERVAL_MS = 3000;
const SYNTH_POLL_MAX         = 40;

// ── Module-level callbacks (set via initRedditPanel) ──────────────────────────
let _enqueueSpeak    = null;
let _interruptSpeech = null;
let _sendToOllama    = null;

// ── Active card state ─────────────────────────────────────────────────────────
let _activeCard = null;

// ── Trigger detection ──────────────────────────────────────────────────────────
/**
 * Returns true if the transcript matches the strict Reddit social trigger.
 * Only "open Reddit social" or "view Reddit social" (case-insensitive) match.
 */
export function detectRedditTrigger(transcript) {
  return /\b(?:open|view)\s+reddit\s+social\b/i.test(transcript) ? true : null;
}

// ── Panel lifecycle ────────────────────────────────────────────────────────────
/**
 * Fetch Reddit posts and open the panel.
 * @param {object}  options
 * @param {string}  [options.subreddit] single subreddit (omit for default list)
 * @param {string}  [options.sort]      sort method (default "hot")
 * @param {boolean} [options.silent]    suppress synthesis speech if true
 * @returns {string|null} llm_context string or null on failure
 */
export async function openRedditPanel(options = {}) {
  _activeSubreddit = 'all';
  if (redditMeta)     redditMeta.textContent  = 'LOADING\u2026';
  if (redditPostList) redditPostList.innerHTML = '';
  if (redditPanel)    redditPanel.classList.remove('hidden');

  const params = new URLSearchParams();
  if (options.subreddit) params.set('subreddit', options.subreddit);
  if (options.sort)      params.set('sort', options.sort);
  const query = params.toString() ? `?${params.toString()}` : '';

  try {
    const resp = await fetch(`${BACKEND_BASE_REDDIT}/reddit${query}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    _redditData = data;
    _renderPanel(data);

    if (data.synthesis_enabled && data.synthesis_status === 'pending') {
      _startSynthesisPolling(data.subreddits, data.total, options.silent ?? false);
    }

    return data.llm_context ?? null;
  } catch (err) {
    if (redditMeta) redditMeta.textContent = 'FETCH ERROR';
    console.error('[reddit-panel] openRedditPanel error:', err);
    return null;
  }
}

/**
 * Close the Reddit panel and stop any active synthesis polling.
 */
export function closeRedditPanel() {
  _hideRedditSettingsView();
  if (redditPanel) redditPanel.classList.add('hidden');
  _redditData = null;
  _stopSynthesisPolling();
}

/**
 * Wire up enqueueSpeak and the refresh button click handler.
 * Must be called once during app init before any panel interactions.
 */
export function initRedditPanel({ enqueueSpeak, sendToOllama, interruptSpeech } = {}) {
  _enqueueSpeak    = enqueueSpeak    || null;
  _sendToOllama    = sendToOllama    || null;
  _interruptSpeech = interruptSpeech || null;

  redditRefreshBtn?.addEventListener('click', () => _hardRefresh());

  redditSettingsBtn?.addEventListener('click', _showRedditSettingsView);
  redditSettingsBackBtn?.addEventListener('click', _hideRedditSettingsView);
  redditSettingsAddBtn?.addEventListener('click', () => _addSubreddit(redditSettingsInput.value));
  redditSettingsInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _addSubreddit(redditSettingsInput.value);
  });
  redditSettingsInput?.addEventListener('input', _hideRedditSettingsError);
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function _renderPanel(data) {
  if (redditTitle)   redditTitle.textContent  = 'REDDIT SOCIAL FEED';
  if (redditMeta)    redditMeta.textContent   = `${data.total} POSTS`;
  if (redditFetched) redditFetched.textContent = `FETCHED ${data.fetched_at_display ?? '\u2014'}`;

  _renderFilterBar(data.subreddits ?? []);
  _renderPostList();
}

function _renderFilterBar(subreddits) {
  if (!redditFilterBar) return;
  redditFilterBar.innerHTML = '';

  const allBtn = _makeFilterBtn('all', 'ALL');
  redditFilterBar.appendChild(allBtn);

  for (const sub of subreddits) {
    redditFilterBar.appendChild(_makeFilterBtn(sub, `r/${sub}`));
  }
}

function _makeFilterBtn(value, label) {
  const btn = document.createElement('button');
  btn.className = 'reddit-filter-btn' + (value === _activeSubreddit ? ' active' : '');
  btn.textContent = label; // textContent — XSS safe, no innerHTML
  btn.addEventListener('click', () => {
    _activeSubreddit = value;
    document.querySelectorAll('.reddit-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _renderPostList();
  });
  return btn;
}

function _renderPostList() {
  if (!redditPostList || !_redditData) return;
  redditPostList.innerHTML = '';

  const posts = _activeSubreddit === 'all'
    ? (_redditData.posts ?? [])
    : (_redditData.by_subreddit?.[_activeSubreddit] ?? []);

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const card = document.createElement('div');
    card.className = 'reddit-post-card';
    card.style.setProperty('--card-delay', `${i * 30}ms`);

    // Subreddit badge
    const badge = document.createElement('div');
    badge.className = 'reddit-sub-badge';
    badge.textContent = `r/${post.subreddit}`; // textContent — XSS safe

    // Title
    const titleEl = document.createElement('div');
    titleEl.className = 'reddit-post-title';
    titleEl.textContent = post.title; // textContent — XSS safe

    // Stats row
    const stats = document.createElement('div');
    stats.className = 'reddit-post-stats';

    const score    = document.createElement('span');
    score.textContent = `\u2191 ${post.score}`;

    const comments = document.createElement('span');
    comments.textContent = `\uD83D\uDCAC ${post.num_comments}`;

    const author = document.createElement('span');
    author.textContent = post.author;

    const age = document.createElement('span');
    age.textContent = post.age;

    stats.append(score, comments, author, age);

    card.append(badge, titleEl, stats);

    // Click to speak post headline + stats
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      const wasActive = card.classList.contains('active');
      if (_activeCard && _activeCard !== card) _activeCard.classList.remove('active');
      if (wasActive) {
        card.classList.remove('active');
        _activeCard = null;
      } else {
        card.classList.add('active');
        _activeCard = card;
        _speakPost(post);
      }
    });

    // Optional thumbnail (right-aligned via CSS)
    if (post.thumbnail) {
      const thumb = document.createElement('img');
      thumb.className = 'reddit-post-thumb';
      thumb.alt = '';
      thumb.src = post.thumbnail; // trusted URL from our own backend (sanitised)
      thumb.addEventListener('error', () => { thumb.style.display = 'none'; });
      card.appendChild(thumb);
    }

    redditPostList.appendChild(card);
  }
}

// ── Post speech ──────────────────────────────────────────────────────────────────

function _speakPost(post) {
  if (_interruptSpeech) _interruptSpeech();
  if (!_sendToOllama) {
    if (_enqueueSpeak) _enqueueSpeak(post.title);
    return;
  }
  const sysPrompt = `You are Starling. The user has tapped a Reddit post. Read the post title naturally, briefly mention it has ${post.score} upvotes and ${post.num_comments} comments, and share a one-sentence reaction. Keep your total response under 4 sentences.`;
  _sendToOllama(
    `Post title: "${post.title}"\nSubreddit: r/${post.subreddit}`,
    { ephemeralMessages: [{ role: 'system', content: sysPrompt }] },
  );
}

// ── Synthesis polling ──────────────────────────────────────────────────────────

function _startSynthesisPolling(subreddits, rawCount, silent) {
  _synthPollCount = 0;
  if (redditMeta) redditMeta.textContent = `${rawCount} POSTS \u00B7 SYNTHESISING\u2026`;
  if (redditSynthIndicator) redditSynthIndicator.classList.remove('hidden');

  _synthPollTimer = setInterval(async () => {
    _synthPollCount++;
    if (_synthPollCount > SYNTH_POLL_MAX) {
      _stopSynthesisPolling();
      if (redditMeta) redditMeta.textContent = `${rawCount} POSTS`;
      return;
    }

    try {
      const res  = await fetch(`${BACKEND_BASE_REDDIT}/reddit/synthesised`);
      const body = await res.json();

      if (body.status === 'ready' && body.result) {
        _stopSynthesisPolling();
        if (_redditData) _redditData.synthesis = body.result;
        if (redditMeta) redditMeta.textContent = `${rawCount} POSTS \u00B7 SYNTHESISED`;
        if (!silent && body.result.briefing) {
          _speakBriefing(body.result.briefing);
        }
      } else if (body.status === 'none') {
        _stopSynthesisPolling();
        if (redditMeta) redditMeta.textContent = `${rawCount} POSTS`;
      }
    } catch (_) { /* network hiccup — keep polling */ }
  }, SYNTH_POLL_INTERVAL_MS);
}

function _stopSynthesisPolling() {
  if (_synthPollTimer !== null) {
    clearInterval(_synthPollTimer);
    _synthPollTimer = null;
  }
  if (redditSynthIndicator) redditSynthIndicator.classList.add('hidden');
}

// ── Spoken briefing ────────────────────────────────────────────────────────────

function _speakBriefing(briefingText) {
  if (briefingText && typeof briefingText === 'string' && _enqueueSpeak) {
    _enqueueSpeak(briefingText);
  }
}

// ── Hard refresh helper ────────────────────────────────────────────────────────

async function _hardRefresh() {
  try {
    await fetch(`${BACKEND_BASE_REDDIT}/reddit/cache`, { method: 'DELETE' });
  } catch (_) { /* ignore cache-clear errors */ }
  await openRedditPanel({ silent: true });
}

// ── Settings view helpers ──────────────────────────────────────────────────────

function _showRedditSettingsView() {
  redditFilterBar?.classList.add('hidden');
  redditPostList?.classList.add('hidden');
  redditFetched?.classList.add('hidden');
  redditRefreshBtn?.classList.add('hidden');
  redditSettingsBtn?.classList.add('hidden');
  redditSynthIndicator?.classList.add('hidden');
  redditSettingsView?.classList.remove('hidden');
  _fetchAndRenderSubList();
}

function _hideRedditSettingsView() {
  redditSettingsView?.classList.add('hidden');
  redditFilterBar?.classList.remove('hidden');
  redditPostList?.classList.remove('hidden');
  redditFetched?.classList.remove('hidden');
  redditRefreshBtn?.classList.remove('hidden');
  redditSettingsBtn?.classList.remove('hidden');
  _hideRedditSettingsError();
  if (redditSettingsInput) redditSettingsInput.value = '';
}

async function _fetchAndRenderSubList() {
  if (!redditSettingsSubList) return;
  redditSettingsSubList.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'reddit-settings-loading';
  loading.textContent = 'LOADING\u2026';
  redditSettingsSubList.appendChild(loading);

  try {
    const res = await fetch(`${BACKEND_BASE_REDDIT}/reddit/subreddits`);
    if (!res.ok) {
      redditSettingsSubList.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'reddit-settings-loading';
      err.textContent = 'Failed to load subreddits.';
      redditSettingsSubList.appendChild(err);
      return;
    }
    const subs = await res.json();
    redditSettingsSubList.innerHTML = '';
    for (const { name } of subs) {
      redditSettingsSubList.appendChild(_createSubRow(name));
    }
  } catch (_) {
    redditSettingsSubList.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'reddit-settings-loading';
    err.textContent = 'Failed to load subreddits.';
    redditSettingsSubList.appendChild(err);
  }
}

function _createSubRow(name) {
  const row = document.createElement('div');
  row.className = 'reddit-settings-sub-row';

  const nameEl = document.createElement('div');
  nameEl.className = 'reddit-settings-sub-name';
  nameEl.textContent = name; // textContent — XSS safe

  const removeBtn = document.createElement('button');
  removeBtn.className = 'reddit-settings-remove-btn';
  removeBtn.title = 'Remove subreddit';
  removeBtn.textContent = '\u2715';
  removeBtn.addEventListener('click', async () => {
    removeBtn.disabled = true;
    const ok = await _removeSubreddit(name);
    if (!ok) removeBtn.disabled = false;
  });

  row.append(nameEl, removeBtn);
  return row;
}

async function _removeSubreddit(name) {
  const res = await fetch(
    `${BACKEND_BASE_REDDIT}/reddit/subreddits/${encodeURIComponent(name)}`,
    { method: 'DELETE' }
  );
  if (!res.ok) {
    try {
      const body = await res.json();
      _showRedditSettingsError(body.detail ?? 'Failed to remove subreddit.');
    } catch (_) {
      _showRedditSettingsError('Failed to remove subreddit.');
    }
    return false;
  }
  await _fetchAndRenderSubList();
  _hardRefresh(); // background refresh — no await
  return true;
}

async function _addSubreddit(rawInput) {
  const name = rawInput.trim().replace(/^r\//i, '');
  if (!/^[A-Za-z0-9_]{1,50}$/.test(name)) {
    _showRedditSettingsError('Invalid name. Use letters, numbers, and underscores only (max 50 chars).');
    return;
  }
  if (redditSettingsAddBtn) redditSettingsAddBtn.disabled = true;
  try {
    const res = await fetch(`${BACKEND_BASE_REDDIT}/reddit/subreddits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subreddit: name }),
    });
    if (!res.ok) {
      try {
        const body = await res.json();
        _showRedditSettingsError(body.detail ?? 'Failed to add subreddit.');
      } catch (_) {
        _showRedditSettingsError('Failed to add subreddit.');
      }
      return;
    }
    if (redditSettingsInput) redditSettingsInput.value = '';
    _hideRedditSettingsError();
    await _fetchAndRenderSubList();
    _hardRefresh(); // background refresh — no await
  } finally {
    if (redditSettingsAddBtn) redditSettingsAddBtn.disabled = false;
  }
}

function _showRedditSettingsError(msg) {
  if (!redditSettingsError) return;
  redditSettingsError.textContent = msg; // textContent — XSS safe
  redditSettingsError.classList.remove('hidden');
}

function _hideRedditSettingsError() {
  if (!redditSettingsError) return;
  redditSettingsError.textContent = '';
  redditSettingsError.classList.add('hidden');
}
