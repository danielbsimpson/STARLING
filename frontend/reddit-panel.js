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

// ── State ──────────────────────────────────────────────────────────────────────
let _redditData      = null;
let _activeSubreddit = 'all';
let _synthPollTimer  = null;
let _synthPollCount  = 0;

const SYNTH_POLL_INTERVAL_MS = 3000;
const SYNTH_POLL_MAX         = 40;

// ── Module-level callbacks (set via initRedditPanel) ──────────────────────────
let _enqueueSpeak = null;

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
  if (redditPanel) redditPanel.classList.add('hidden');
  _redditData = null;
  _stopSynthesisPolling();
}

/**
 * Wire up enqueueSpeak and the refresh button click handler.
 * Must be called once during app init before any panel interactions.
 */
export function initRedditPanel({ enqueueSpeak }) {
  _enqueueSpeak = enqueueSpeak;

  redditRefreshBtn?.addEventListener('click', async () => {
    try {
      await fetch(`${BACKEND_BASE_REDDIT}/reddit/cache`, { method: 'DELETE' });
    } catch (_) { /* ignore cache-clear errors */ }
    await openRedditPanel({ silent: true });
  });
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
