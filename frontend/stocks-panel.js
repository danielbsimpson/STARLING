// frontend/stocks-panel.js
// Market panel — chart dashboard, detail view, LLM briefing, watchlist groups.

import { BACKEND_BASE } from './config.js';
import { escapeHtml } from './utils.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const mktPanel      = document.getElementById('mkt-panel');
const mktStatus     = document.getElementById('mkt-status');
const mktFetched    = document.getElementById('mkt-fetched');
const mktRefreshBtn = document.getElementById('mkt-refresh-btn');
const mktDashboard  = document.getElementById('mkt-dashboard');
const mktGroupTabs  = document.getElementById('mkt-group-tabs');
const mktDetail     = document.getElementById('mkt-detail');
const mktBackBtn    = document.getElementById('mkt-back-btn');
const mktHearBtn    = document.getElementById('mkt-hear-btn');
const ftrMktStatus  = document.getElementById('ftr-mkt-status');

// Detail DOM refs
const detailSym    = document.getElementById('mkt-detail-sym');
const detailName   = document.getElementById('mkt-detail-name');
const detailPrice  = document.getElementById('mkt-detail-price');
const detailChg    = document.getElementById('mkt-detail-chg');
const windowPills  = document.querySelectorAll('.wpill');
const mstatHigh    = document.getElementById('mstat-high');
const mstatLow     = document.getElementById('mstat-low');
const mstatVol     = document.getElementById('mstat-vol');
const mstatCap     = document.getElementById('mstat-cap');
const mstatUpd     = document.getElementById('mstat-upd');

// ── State ─────────────────────────────────────────────────────────────────────
let _mktData        = null;
let _tileCharts     = {};
let _detailChart    = null;
let _detailSymbol   = null;
let _detailWindow   = '1m';
let _sendToOllama   = null;
let _onClose        = null;
let _tilePeriod     = ['1m','1m','1m','1m','1m','1m'];

// My Stocks (tile 4) / My Crypto (tile 5) holdings + view mode.
// mode: 'portfolio' (combined total value) | 'price' (per-share price) | 'value' (shares × price)
let _holdings   = { my_stocks: [], my_crypto: [] };
let _profile    = { age: '', risk_profile: 'Moderate', time_horizon: '', primary_goal: '', available_capital: '' };
let _tileMode   = { 4: 'portfolio', 5: 'portfolio' };
const PORTFOLIO_VALUE = '__PORTFOLIO__';

// Static tile config (tiles 0-3 are fixed)
const TILE_SYMBOLS = ['^GSPC', '^IXIC', '^DJI', 'BTC-USD'];
const TILE_COLORS  = ['#ffffff', '#88ddff', '#aaffaa', '#f7931a', '#88ddff', '#bb88ff'];
const ETH_COLOR    = '#627eea';

// ── Callback injection ────────────────────────────────────────────────────────
export function setSendToOllama(fn) { _sendToOllama = fn; }
export function setOnClose(fn)      { _onClose = fn; }

// ── Refresh button ────────────────────────────────────────────────────────────
mktRefreshBtn?.addEventListener('click', async () => {
  mktRefreshBtn.textContent = '↻ FETCHING…';
  mktRefreshBtn.disabled    = true;
  await fetch(`${BACKEND_BASE}/stocks/cache`, { method: 'DELETE' }).catch(() => {});
  await _loadDashboard(true);
  mktRefreshBtn.textContent = '↻ REFRESH';
  mktRefreshBtn.disabled    = false;
});

// ── Close button ─────────────────────────────────────────────────────────────
document.getElementById('mkt-close-btn')?.addEventListener('click', () => {
  if (_onClose) _onClose();
  else closeMarketPanel();
});

// ── Settings (gear) button ────────────────────────────────────────────────────
document.getElementById('mkt-settings-btn')?.addEventListener('click', () => openStockSettings());

// ── Back button & keyboard ────────────────────────────────────────────────────
mktBackBtn?.addEventListener('click', closeDetailView);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && _detailSymbol) closeDetailView();
});

// ── Window resize ─────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  _resizeAllCharts();
});

// Re-fit charts once the panel finishes its width transition. Charts created
// while the panel is still expanding from width:0 read a zero/partial container
// size and render blank; resizing after the transition settles fixes that.
mktPanel?.addEventListener('transitionend', e => {
  if (e.propertyName === 'width') _resizeAllCharts();
});

function _resizeAllCharts() {
  Object.values(_tileCharts).forEach(c => c?.resize?.());
  _detailChart?.resize?.();
}

// ── Tile pill clicks (event delegation) ──────────────────────────────────────
document.getElementById('stocks-dashboard')?.addEventListener('click', e => {
  const pill = e.target.closest('.spill');
  if (!pill) return;
  const tileIdx = Number(pill.dataset.tile);
  const win     = pill.dataset.w;
  _tilePeriod[tileIdx] = win;
  pill.closest('.stocks-tile-pills').querySelectorAll('.spill').forEach(p => {
    p.classList.toggle('active', p === pill);
  });
  _loadTileHistory(tileIdx, win, true);
});

// ── Tile click → detail view ──────────────────────────────────────────────────
document.getElementById('stocks-dashboard')?.addEventListener('click', e => {
  const tile = e.target.closest('.stocks-tile');
  if (!tile || e.target.closest('.stocks-tile-pills') || e.target.closest('.stocks-tile-sel')) return;
  const sym = _getActiveTileSymbol(Number(tile.id.replace('tile-', '')));
  if (sym && sym !== PORTFOLIO_VALUE) openDetailView(sym);
});

// ── Selectors (tiles 4 & 5) ───────────────────────────────────────────────────
document.getElementById('sel-4')?.addEventListener('change', e => _onHoldingSelect(4, e.target.value));
document.getElementById('sel-5')?.addEventListener('change', e => _onHoldingSelect(5, e.target.value));

function _onHoldingSelect(tileIdx, value) {
  const tile = document.getElementById(`tile-${tileIdx}`);
  if (tile) tile.dataset.symbol = value;
  if (value === PORTFOLIO_VALUE) {
    _tileMode[tileIdx] = 'portfolio';
  } else if (_tileMode[tileIdx] === 'portfolio') {
    _tileMode[tileIdx] = 'price';
  }
  _updateValToggle(tileIdx);
  _loadMyTile(tileIdx, _tilePeriod[tileIdx], true);
}

// ── Value / price toggle (tiles 4 & 5) ────────────────────────────────────────
document.getElementById('stocks-dashboard')?.addEventListener('click', e => {
  const btn = e.target.closest('.stocks-valtoggle');
  if (!btn) return;
  e.stopPropagation();
  const tileIdx = Number(btn.dataset.tile);
  if (_tileMode[tileIdx] === 'portfolio') return;
  _tileMode[tileIdx] = _tileMode[tileIdx] === 'value' ? 'price' : 'value';
  _updateValToggle(tileIdx);
  _loadMyTile(tileIdx, _tilePeriod[tileIdx], false);
});

// ── Detail window pills ───────────────────────────────────────────────────────
windowPills.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!_detailSymbol) return;
    _detailWindow = btn.dataset.w;
    windowPills.forEach(b => b.classList.toggle('active', b === btn));
    _loadDetailChart(_detailSymbol, _detailWindow);
    _triggerBriefing(_detailSymbol, _detailWindow);
  });
});

// ── Hear Briefing button ──────────────────────────────────────────────────────
mktHearBtn?.addEventListener('click', () => {
  if (_detailSymbol) _triggerBriefing(_detailSymbol, _detailWindow);
});

// ── Trigger detection ─────────────────────────────────────────────────────────
export function detectMarketTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  const cryptoPatterns = [
    /\b(?:show|check|what(?:'s| is)|display|get)\b.{0,20}\bcrypto\b/,
    /\bcrypto(?:\s+(?:prices?|update|market|portfolio|briefing))?\b/,
    /\b(?:bitcoin|ethereum|btc|eth|solana|sol)\b.{0,15}\bprice\b/,
    /\bprice\s+of\s+(?:bitcoin|ethereum|btc|eth|solana)\b/,
    /\bbrief\s+me\s+(?:on|about)\s+(?:the\s+)?crypto\b/,
  ];
  if (cryptoPatterns.some(p => p.test(t))) return 'crypto';

  const stockPatterns = [
    /\b(?:display|show|check|pull up|open|get)\b.{0,25}\b(?:stocks?|market|equities)\b/,
    /\bwhat(?:'s| is)\b.{0,20}\b(?:market|stocks?)\b/,
    /\b(?:stocks?|market)\s+(?:briefing|prices?|update|summary|overview|report|watchlist|data|check|watch)\b/,
    /\bhow\s+(?:are|is)\s+(?:the\s+)?(?:markets?|stocks?)\b/,
    /\bmarkets?\s+(?:today|now|open|close|up|down)\b/,
    /\bportfolio\s+(?:briefing|update|summary|check|report|overview)\b/,
    /\b(?:nvda|nvidia|aapl|apple|msft|microsoft|spy|qqq|tsla|tesla|amzn|amazon|goog|meta|amd)\b/,
    /\bbrief\s+me\s+(?:on|about)\s+(?:the\s+)?(?:market|stocks?|equity|equities|portfolio)\b/,
  ];
  if (stockPatterns.some(p => p.test(t))) return 'stocks';

  const generalPatterns = [
    /\bfinancial\s+(?:update|report|summary|briefing)\b/,
    /\bwhat(?:'s| is)\s+(?:the\s+)?market\b/,
    /\bbrief\s+me\s+(?:on|about)\s+(?:the\s+)?(?:financial|investments?)\b/,
  ];
  if (generalPatterns.some(p => p.test(t))) return 'all';

  return null;
}

// ── Panel open / close ────────────────────────────────────────────────────────
export async function openMarketPanel(filter = 'all', silent = false) {
  mktPanel.classList.remove('hidden');
  _showDashboard();
  return await _loadDashboard();
}

export function closeMarketPanel() {
  closeDetailView();
  _destroyTileCharts();
  mktPanel.classList.add('hidden');
  _mktData = null;
}

// ── Dashboard load ────────────────────────────────────────────────────────────
async function _loadDashboard(force = false) {
  mktStatus.textContent = 'LOADING…';

  let data;
  try {
    const res = await fetch(`${BACKEND_BASE}/stocks`);
    if (!res.ok) throw new Error(`/stocks ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[stocks-panel]', err);
    mktStatus.textContent = 'ERROR';
    return null;
  }

  _mktData = data;
  mktStatus.textContent     = data.market_open ? 'MARKET OPEN' : 'MARKET CLOSED';
  mktStatus.dataset.open    = String(data.market_open);
  if (ftrMktStatus) {
    ftrMktStatus.textContent = data.market_open ? 'OPEN' : 'CLOSED';
    ftrMktStatus.dataset.dev = data.market_open ? 'GPU' : 'CPU';
  }

  const d = new Date(data.fetched_at);
  mktFetched.textContent = `UPDATED ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

  await _loadHoldings();
  _renderGroupTabs(data.groups, data.default_group);
  _populateSelectors();
  _updateAllTileQuotes(data.tickers);
  await _loadAllTileHistories(force);

  // Ensure tile charts pick up correct dimensions once layout has settled
  // (covers the case where the panel was mid-transition during creation).
  requestAnimationFrame(() => requestAnimationFrame(() => _resizeAllCharts()));

  return data.llm_context;
}

// ── Group tabs ────────────────────────────────────────────────────────────────
function _renderGroupTabs(groups, defaultGroup) {
  if (!mktGroupTabs) return;
  mktGroupTabs.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className    = 'mkt-tab active';
  allBtn.textContent  = 'ALL';
  allBtn.dataset.group = 'all';
  mktGroupTabs.appendChild(allBtn);

  groups.forEach(g => {
    if (!g.tickers.length) return;
    const btn = document.createElement('button');
    btn.className    = 'mkt-tab';
    btn.textContent  = g.label.toUpperCase();
    btn.dataset.group = g.label;
    mktGroupTabs.appendChild(btn);
  });

  function applyFilter(groupLabel) {
    const dashboard = document.getElementById('stocks-dashboard');
    if (!dashboard) return;
    if (groupLabel === 'all') {
      dashboard.querySelectorAll('.stocks-tile').forEach(t => t.classList.remove('hidden'));
      return;
    }
    const group = groups.find(g => g.label === groupLabel);
    if (!group) return;
    const syms = new Set(group.tickers.map(t => t.symbol));
    for (let i = 0; i < 6; i++) {
      const tile = document.getElementById(`tile-${i}`);
      if (!tile) continue;
      let show = false;
      if (i === 3) {
        show = syms.has('BTC-USD') || syms.has('ETH-USD');
      } else {
        const sym = tile.dataset.symbol || TILE_SYMBOLS[i] || '';
        show = syms.has(sym);
      }
      tile.classList.toggle('hidden', !show);
    }
  }

  mktGroupTabs.querySelectorAll('.mkt-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      mktGroupTabs.querySelectorAll('.mkt-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilter(btn.dataset.group);
    });
  });
}

// ── Holdings load ─────────────────────────────────────────────────────────────
async function _loadHoldings() {
  try {
    const res = await fetch(`${BACKEND_BASE}/stocks/holdings`);
    if (!res.ok) throw new Error(`/holdings ${res.status}`);
    const data = await res.json();
    _holdings = {
      my_stocks: Array.isArray(data.my_stocks) ? data.my_stocks : [],
      my_crypto: Array.isArray(data.my_crypto) ? data.my_crypto : [],
    };
    if (data.profile && typeof data.profile === 'object') {
      _profile = { ..._profile, ...data.profile };
    }
  } catch (err) {
    console.error('[stocks-panel] holdings:', err);
    _holdings = { my_stocks: [], my_crypto: [] };
  }
}

function _holdingsFor(tileIdx) {
  return tileIdx === 5 ? _holdings.my_crypto : _holdings.my_stocks;
}

function _kindFor(tileIdx) {
  return tileIdx === 5 ? 'crypto' : 'stocks';
}

function _sharesFor(tileIdx, symbol) {
  const h = _holdingsFor(tileIdx).find(x => x.symbol?.toUpperCase() === symbol?.toUpperCase());
  return h ? Number(h.shares) || 0 : 0;
}

// ── Tile 4 / 5 selector population (My Stocks / My Crypto) ────────────────────
function _populateSelectors() {
  _buildHoldingSelector(4);
  _buildHoldingSelector(5);
}

function _buildHoldingSelector(tileIdx) {
  const sel  = document.getElementById(`sel-${tileIdx}`);
  const tile = document.getElementById(`tile-${tileIdx}`);
  if (!sel || !tile) return;

  const items   = _holdingsFor(tileIdx);
  const isCrypto = tileIdx === 5;

  const opts = [`<option value="${PORTFOLIO_VALUE}">PORTFOLIO</option>`];
  items.forEach(h => {
    const sym   = h.symbol;
    const label = isCrypto ? sym.replace('-USD', '').replace('-USDT', '') : sym;
    opts.push(`<option value="${escapeHtml(sym)}">${escapeHtml(label)}</option>`);
  });
  sel.innerHTML = opts.join('');

  // Default to the combined portfolio view.
  sel.value          = PORTFOLIO_VALUE;
  tile.dataset.symbol = PORTFOLIO_VALUE;
  _tileMode[tileIdx]  = 'portfolio';
  _updateValToggle(tileIdx);
}

function _updateValToggle(tileIdx) {
  const btn = document.querySelector(`.stocks-valtoggle[data-tile="${tileIdx}"]`);
  if (!btn) return;
  const mode = _tileMode[tileIdx];
  if (mode === 'portfolio') {
    btn.classList.add('hidden');
  } else {
    btn.classList.remove('hidden');
    btn.classList.toggle('active', mode === 'value');
    btn.textContent = mode === 'value' ? 'VALUE' : 'PRICE';
  }
}

// ── Quote header updates ──────────────────────────────────────────────────────
function _updateAllTileQuotes(tickers) {
  const bySymbol = {};
  tickers.forEach(t => { bySymbol[t.symbol] = t; });
  for (let i = 0; i < 6; i++) {
    const tile = document.getElementById(`tile-${i}`);
    if (!tile) continue;
    const sym = tile.dataset.symbol || TILE_SYMBOLS[i];
    if (sym && bySymbol[sym]) _applyQuoteToTile(i, bySymbol[sym]);
  }
}

function _updateTileQuote(tileIdx) {
  if (!_mktData) return;
  const tile = document.getElementById(`tile-${tileIdx}`);
  const sym  = tile?.dataset.symbol;
  if (!sym) return;
  const q = _mktData.tickers.find(t => t.symbol === sym);
  if (q) _applyQuoteToTile(tileIdx, q);
}

function _applyQuoteToTile(i, q) {
  const price = document.getElementById(`tp-${i}-price`);
  const chg   = document.getElementById(`tp-${i}-chg`);
  if (price) price.textContent        = q.price_fmt;
  if (chg)  { chg.textContent         = q.change.pct;
               chg.dataset.direction  = q.change.direction; }
}

// ── History loading ───────────────────────────────────────────────────────────
async function _loadAllTileHistories(force = false) {
  const allSyms = ['^GSPC', '^IXIC', '^DJI', 'BTC-USD', 'ETH-USD'];

  const url = `${BACKEND_BASE}/stocks/history/batch?tickers=${allSyms.join(',')}&window=1m${force ? '&force=true' : ''}`;
  let batch;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`/history/batch ${res.status}`);
    batch = await res.json();
  } catch (err) {
    console.error('[stocks-panel] history batch error:', err);
    return;
  }

  const bySymbol = {};
  batch.forEach(item => { bySymbol[item.ticker] = item; });

  for (let i = 0; i < 3; i++) {
    const sym = TILE_SYMBOLS[i];
    if (bySymbol[sym]) _renderTileChart(i, [{data: _toXY(bySymbol[sym].candles), color: TILE_COLORS[i]}]);
  }

  // Tile 3: BTC + ETH
  const btcItem = bySymbol['BTC-USD'];
  const ethItem = bySymbol['ETH-USD'];
  if (btcItem || ethItem) {
    const datasets = [];
    if (btcItem) datasets.push({data: _toXY(btcItem.candles), color: TILE_COLORS[3], label: 'BTC', yAxisID: 'yBTC'});
    if (ethItem) datasets.push({data: _toXY(ethItem.candles), color: ETH_COLOR,       label: 'ETH', yAxisID: 'yETH'});
    _renderTileChartDual(3, datasets);
  }

  // Tiles 4 & 5: My Stocks / My Crypto (portfolio or per-ticker)
  await Promise.all([
    _loadMyTile(4, _tilePeriod[4], force),
    _loadMyTile(5, _tilePeriod[5], force),
  ]);
}

// Load a "My Stocks"/"My Crypto" tile in its current mode.
async function _loadMyTile(tileIdx, win, force = false) {
  const color = TILE_COLORS[tileIdx];
  const mode  = _tileMode[tileIdx];

  if (mode === 'portfolio') {
    const kind = _kindFor(tileIdx);
    let res;
    try {
      const r = await fetch(`${BACKEND_BASE}/stocks/portfolio/history?kind=${kind}&window=${win}${force ? '&force=true' : ''}`);
      res = await r.json();
    } catch (err) {
      console.error(`[stocks-panel] portfolio ${kind}:`, err);
      return;
    }
    _renderTileChart(tileIdx, [{ data: _toXY(res.candles), color }]);
    _applyPortfolioQuote(tileIdx, res);
    return;
  }

  const sym = document.getElementById(`tile-${tileIdx}`)?.dataset.symbol;
  if (!sym || sym === PORTFOLIO_VALUE) return;
  try {
    const res  = await fetch(`${BACKEND_BASE}/stocks/history?ticker=${sym}&window=${win}${force ? '&force=true' : ''}`);
    const item = await res.json();
    let pts = _toXY(item.candles);
    if (mode === 'value') {
      const sh = _sharesFor(tileIdx, sym);
      pts = pts.map(p => ({ x: p.x, y: p.y * sh }));
    }
    _renderTileChart(tileIdx, [{ data: pts, color }]);
    _applyHoldingQuote(tileIdx, sym, mode);
  } catch (err) {
    console.error(`[stocks-panel] tile ${tileIdx} history:`, err);
  }
}

function _applyPortfolioQuote(tileIdx, res) {
  const price = document.getElementById(`tp-${tileIdx}-price`);
  const chg   = document.getElementById(`tp-${tileIdx}-chg`);
  if (price) price.textContent = res?.total_fmt ?? '—';
  if (chg && res?.change) {
    chg.textContent       = res.change.pct;
    chg.dataset.direction = res.change.direction;
  }
}

function _applyHoldingQuote(tileIdx, sym, mode) {
  const q = _mktData?.tickers.find(t => t.symbol === sym);
  const price = document.getElementById(`tp-${tileIdx}-price`);
  const chg   = document.getElementById(`tp-${tileIdx}-chg`);
  if (!q) return;
  if (mode === 'value' && q.price != null) {
    const sh  = _sharesFor(tileIdx, sym);
    const val = sh * q.price;
    if (price) price.textContent = _fmtMoney(val);
  } else if (price) {
    price.textContent = q.price_fmt;
  }
  if (chg) {
    chg.textContent       = q.change.pct;
    chg.dataset.direction = q.change.direction;
  }
}

async function _loadTileHistory(tileIdx, win, force = false) {
  if (tileIdx === 4 || tileIdx === 5) {
    await _loadMyTile(tileIdx, win, force);
    return;
  }
  if (tileIdx === 3) {
    const [btcRes, ethRes] = await Promise.all([
      fetch(`${BACKEND_BASE}/stocks/history?ticker=BTC-USD&window=${win}${force ? '&force=true' : ''}`).then(r => r.json()).catch(() => null),
      fetch(`${BACKEND_BASE}/stocks/history?ticker=ETH-USD&window=${win}${force ? '&force=true' : ''}`).then(r => r.json()).catch(() => null),
    ]);
    const datasets = [];
    if (btcRes?.candles) datasets.push({data: _toXY(btcRes.candles), color: TILE_COLORS[3], label: 'BTC', yAxisID: 'yBTC'});
    if (ethRes?.candles) datasets.push({data: _toXY(ethRes.candles), color: ETH_COLOR,       label: 'ETH', yAxisID: 'yETH'});
    _renderTileChartDual(3, datasets);
    return;
  }

  const sym = _getActiveTileSymbol(tileIdx);
  if (!sym) return;
  try {
    const res  = await fetch(`${BACKEND_BASE}/stocks/history?ticker=${sym}&window=${win}${force ? '&force=true' : ''}`);
    const item = await res.json();
    _renderTileChart(tileIdx, [{data: _toXY(item.candles), color: TILE_COLORS[tileIdx]}]);
  } catch (err) {
    console.error(`[stocks-panel] tile ${tileIdx} history:`, err);
  }
}

// ── Chart — tile (small) ──────────────────────────────────────────────────────
function _renderTileChart(tileIdx, datasets) {
  const canvas = document.getElementById(`sc-${tileIdx}`);
  if (!canvas || typeof Chart === 'undefined') return;

  _tileCharts[tileIdx]?.destroy();
  delete _tileCharts[tileIdx];

  const color = datasets[0]?.color || '#ffffff';
  const pts   = datasets[0]?.data  || [];

  _tileCharts[tileIdx] = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [{
        data:            pts,
        borderColor:     color,
        borderWidth:     1.5,
        backgroundColor: _hexAlpha(color, 0.08),
        fill:            true,
        pointRadius:     0,
        tension:         0.2,
      }],
    },
    options: _tileChartOptions(),
  });
}

function _renderTileChartDual(tileIdx, datasets) {
  const canvas = document.getElementById(`sc-${tileIdx}`);
  if (!canvas || typeof Chart === 'undefined') return;

  _tileCharts[tileIdx]?.destroy();
  delete _tileCharts[tileIdx];

  _tileCharts[tileIdx] = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: datasets.map(ds => ({
        label:           ds.label,
        data:            ds.data,
        borderColor:     ds.color,
        borderWidth:     1.5,
        backgroundColor: _hexAlpha(ds.color, 0.06),
        fill:            false,
        pointRadius:     0,
        tension:         0.2,
        yAxisID:         ds.yAxisID,
      })),
    },
    options: {
      ..._tileChartOptions(),
      scales: {
        x:    { type: 'time', display: false },
        yBTC: { position: 'left',  display: false },
        yETH: { position: 'right', display: false, grid: { drawOnChartArea: false } },
      },
    },
  });
}

function _tileChartOptions() {
  return {
    responsive:          true,
    maintainAspectRatio: false,
    animation:           false,
    interaction:         { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#111', titleColor: '#aaa', bodyColor: '#eee',
        borderColor: '#333', borderWidth: 1,
        callbacks: {
          title: items => _fmtDate(items[0]?.raw?.x),
          label: item  => ` ${(item.raw?.y ?? 0).toFixed(2)}`,
        },
      },
    },
    scales: {
      x: { type: 'time', display: false },
      y: { display: false },
    },
  };
}

// ── Detail view ───────────────────────────────────────────────────────────────
export async function openDetailView(symbol) {
  if (!_mktData) return;

  _detailSymbol = symbol;
  _detailWindow = '1m';
  windowPills.forEach(b => b.classList.toggle('active', b.dataset.w === '1m'));

  const q = _mktData.tickers.find(t => t.symbol === symbol);
  if (q) {
    const sym = symbol.replace('-USD','').replace('=X','').replace('^','');
    detailSym.textContent        = sym;
    detailName.textContent       = q.name;
    detailPrice.textContent      = q.price_fmt;
    detailChg.textContent        = q.change.pct;
    detailChg.dataset.direction  = q.change.direction;
    mstatHigh.textContent        = q.week52_high;
    mstatLow.textContent         = q.week52_low;
    mstatVol.textContent         = q.volume;
    mstatCap.textContent         = q.market_cap;
  } else {
    detailSym.textContent  = symbol.replace('-USD','').replace('=X','').replace('^','');
    detailName.textContent = symbol;
  }

  mktDashboard.classList.add('hidden');
  mktDetail.classList.remove('hidden');

  await _loadDetailChart(symbol, '1m');
  _triggerBriefing(symbol, '1m');
}

export function closeDetailView() {
  if (!_detailSymbol) return;
  _detailSymbol = null;
  _detailChart?.destroy();
  _detailChart = null;
  mktDetail.classList.add('hidden');
  mktDashboard.classList.remove('hidden');
}

// ── Detail chart ──────────────────────────────────────────────────────────────
async function _loadDetailChart(symbol, win) {
  mstatUpd.textContent = 'Loading…';

  let item;
  try {
    const res = await fetch(`${BACKEND_BASE}/stocks/history?ticker=${symbol}&window=${win}`);
    if (!res.ok) throw new Error(`/history ${res.status}`);
    item = await res.json();
  } catch (err) {
    console.error('[stocks-panel] detail chart:', err);
    mstatUpd.textContent = 'Error';
    return;
  }

  if (item.fetched_at) {
    const age = Math.round((Date.now() - new Date(item.fetched_at)) / 60000);
    mstatUpd.textContent = age < 2 ? 'Just updated' : `${age} min ago`;
  }

  const canvas = document.getElementById('mkt-detail-canvas');
  if (!canvas || typeof Chart === 'undefined') return;

  _detailChart?.destroy();
  _detailChart = null;

  const pts   = _toXY(item.candles);
  const isPos = pts.length >= 2 ? pts[pts.length - 1].y >= pts[0].y : true;
  const color = isPos ? '#4ade80' : '#f87171';

  const crosshairPlugin = {
    id: 'crosshair',
    afterDraw(chart) {
      const { ctx, chartArea, tooltip } = chart;
      if (!tooltip._active?.length) return;
      const x = tooltip._active[0].element.x;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth   = 1;
      ctx.stroke();
      ctx.restore();
    },
  };

  _detailChart = new Chart(canvas, {
    type:    'line',
    plugins: [crosshairPlugin],
    data: {
      datasets: [{
        data:            pts,
        borderColor:     color,
        borderWidth:     2,
        backgroundColor: _hexAlpha(color, 0.08),
        fill:            true,
        pointRadius:     0,
        tension:         0.25,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 300 },
      interaction:         { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#111', titleColor: '#888', bodyColor: '#eee',
          borderColor: '#333', borderWidth: 1,
          callbacks: {
            title: items => _fmtDate(items[0]?.raw?.x),
            label: item  => ` Close: ${(item.raw?.y ?? 0).toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'time', display: true,
          grid: { color: 'rgba(255,255,255,0.06)' },
          ticks: { color: '#555', maxTicksLimit: 6 },
        },
        y: {
          position: 'right', display: true,
          grid:  { color: 'rgba(255,255,255,0.06)' },
          ticks: { color: '#666', maxTicksLimit: 5 },
        },
      },
    },
  });
}

// ── LLM briefing ──────────────────────────────────────────────────────────────
async function _triggerBriefing(symbol, win) {
  if (!_sendToOllama) return;

  mktHearBtn.disabled    = true;
  mktHearBtn.textContent = '♪ LOADING…';

  try {
    const res = await fetch(`${BACKEND_BASE}/stocks/briefing?ticker=${encodeURIComponent(symbol)}&window=${win}`);
    if (!res.ok) throw new Error(`/briefing ${res.status}`);
    const data = await res.json();

    const now      = new Date();
    const timePart = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const closedNote = data.market_open === false
      ? ' Markets are closed; clarify these are last-close prices.'
      : '';

    await _sendToOllama(
      `Current local time is ${timePart}. Deliver a concise spoken market briefing for ${symbol} ` +
      `in under 60 words. Do not use time-of-day greetings — begin immediately with the data.${closedNote}`,
      { ephemeralMessages: [{ role: 'system', content: data.llm_context }] }
    );
  } catch (err) {
    console.error('[stocks-panel] briefing:', err);
  } finally {
    mktHearBtn.disabled    = false;
    mktHearBtn.textContent = '♪ HEAR BRIEFING';
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function _getActiveTileSymbol(tileIdx) {
  const tile = document.getElementById(`tile-${tileIdx}`);
  if (!tile) return null;
  if (tileIdx === 4) return document.getElementById('sel-4')?.value || tile.dataset.symbol;
  if (tileIdx === 5) return document.getElementById('sel-5')?.value || tile.dataset.symbol;
  return tile.dataset.symbol || TILE_SYMBOLS[tileIdx] || null;
}

function _showDashboard() {
  mktDetail.classList.add('hidden');
  mktDashboard.classList.remove('hidden');
}

function _destroyTileCharts() {
  Object.values(_tileCharts).forEach(c => c?.destroy());
  _tileCharts = {};
}

function _toXY(candles) {
  return (candles || []).map(c => ({ x: c.t, y: c.c }));
}

function _fmtMoney(val) {
  const sym = _mktData?.currency_sym || '$';
  if (val == null || Number.isNaN(val)) return '—';
  const abs = Math.abs(val);
  if (abs >= 1000) return `${sym}${val.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  if (abs >= 1)    return `${sym}${val.toFixed(2)}`;
  return `${sym}${val.toFixed(4)}`;
}

function _hexAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function _fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Stock settings modal ──────────────────────────────────────────────────────
let _settingsOverlay = null;

export async function openStockSettings() {
  // Always pull the latest holdings so the editor is in sync with the backend.
  await _loadHoldings();

  if (!_settingsOverlay) _settingsOverlay = _buildSettingsOverlay();
  _renderSettingsRows('my_stocks', _holdings.my_stocks);
  _renderSettingsRows('my_crypto', _holdings.my_crypto);
  _populateProfileFields();
  _settingsOverlay.classList.remove('hidden');
}

function closeStockSettings() {
  _settingsOverlay?.classList.add('hidden');
}

function _buildSettingsOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'stk-settings-overlay hidden';
  overlay.id        = 'stk-settings-overlay';
  overlay.innerHTML = `
    <div class="stk-settings-modal">
      <div class="stk-settings-hdr">
        <span class="stk-settings-title">STOCK SETTINGS</span>
        <button class="stk-settings-close" id="stk-settings-close" title="Close">✕</button>
      </div>
      <p class="stk-settings-sub">Configure the tickers and share counts tracked in your My&nbsp;Stocks and My&nbsp;Crypto graphs.</p>
      <div class="stk-settings-cols">
        <div class="stk-settings-col">
          <div class="stk-settings-col-hdr">MY STOCKS</div>
          <div class="stk-settings-rows" id="stk-rows-my_stocks"></div>
          <button class="stk-settings-add" data-kind="my_stocks">+ ADD STOCK</button>
        </div>
        <div class="stk-settings-col">
          <div class="stk-settings-col-hdr">MY CRYPTO</div>
          <div class="stk-settings-rows" id="stk-rows-my_crypto"></div>
          <button class="stk-settings-add" data-kind="my_crypto">+ ADD CRYPTO</button>
        </div>
      </div>
      <div class="stk-settings-profile">
        <div class="stk-settings-col-hdr">INVESTOR PROFILE</div>
        <p class="stk-settings-sub">Used to tailor the AI portfolio analyst that activates with the market panel.</p>
        <div class="stk-profile-grid">
          <label class="stk-profile-field">
            <span>Age</span>
            <input class="stk-profile-input" id="stk-profile-age" type="number" min="0" max="120" placeholder="e.g. 34" />
          </label>
          <label class="stk-profile-field">
            <span>Risk Profile</span>
            <select class="stk-profile-input" id="stk-profile-risk_profile">
              <option value="Conservative">Conservative</option>
              <option value="Moderate">Moderate</option>
              <option value="Aggressive">Aggressive</option>
            </select>
          </label>
          <label class="stk-profile-field">
            <span>Time Horizon</span>
            <input class="stk-profile-input" id="stk-profile-time_horizon" type="text" placeholder="e.g. 20+ years" />
          </label>
          <label class="stk-profile-field">
            <span>Primary Goal</span>
            <input class="stk-profile-input" id="stk-profile-primary_goal" type="text" placeholder="e.g. retirement growth" />
          </label>
          <label class="stk-profile-field stk-profile-field-wide">
            <span>Available Capital to Deploy</span>
            <input class="stk-profile-input" id="stk-profile-available_capital" type="text" placeholder="e.g. $5,000" />
          </label>
        </div>
      </div>
      <div class="stk-settings-ftr">
        <span class="stk-settings-msg" id="stk-settings-msg"></span>
        <div class="stk-settings-actions">
          <button class="stk-settings-cancel" id="stk-settings-cancel">CANCEL</button>
          <button class="stk-settings-save" id="stk-settings-save">SAVE</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) closeStockSettings(); });
  overlay.querySelector('#stk-settings-close').addEventListener('click', closeStockSettings);
  overlay.querySelector('#stk-settings-cancel').addEventListener('click', closeStockSettings);
  overlay.querySelector('#stk-settings-save').addEventListener('click', _saveStockSettings);

  overlay.querySelectorAll('.stk-settings-add').forEach(btn => {
    btn.addEventListener('click', () => _addSettingsRow(btn.dataset.kind));
  });

  // Row remove (event delegation)
  overlay.addEventListener('click', e => {
    const rm = e.target.closest('.stk-row-remove');
    if (rm) rm.closest('.stk-row')?.remove();
  });

  return overlay;
}

function _renderSettingsRows(kind, holdings) {
  const container = document.getElementById(`stk-rows-${kind}`);
  if (!container) return;
  container.innerHTML = '';
  (holdings || []).forEach(h => container.appendChild(_settingsRow(h.symbol, h.shares)));
  if (!holdings || !holdings.length) container.appendChild(_settingsRow('', ''));
}

function _addSettingsRow(kind) {
  const container = document.getElementById(`stk-rows-${kind}`);
  container?.appendChild(_settingsRow('', ''));
}

const _PROFILE_FIELDS = ['age', 'risk_profile', 'time_horizon', 'primary_goal', 'available_capital'];

function _populateProfileFields() {
  _PROFILE_FIELDS.forEach(f => {
    const el = document.getElementById(`stk-profile-${f}`);
    if (el) el.value = _profile[f] ?? '';
  });
}

function _collectProfile() {
  const out = {};
  _PROFILE_FIELDS.forEach(f => {
    const el = document.getElementById(`stk-profile-${f}`);
    out[f] = el ? String(el.value).trim() : '';
  });
  return out;
}

function _settingsRow(symbol, shares) {
  const row = document.createElement('div');
  row.className = 'stk-row';
  row.innerHTML = `
    <input class="stk-row-sym" type="text" placeholder="TICKER" value="${escapeHtml(String(symbol ?? ''))}" maxlength="12" />
    <input class="stk-row-sh" type="number" step="any" min="0" placeholder="SHARES" value="${escapeHtml(String(shares ?? ''))}" />
    <button class="stk-row-remove" title="Remove">✕</button>`;
  return row;
}

function _collectSettings(kind) {
  const container = document.getElementById(`stk-rows-${kind}`);
  const out = [];
  container?.querySelectorAll('.stk-row').forEach(row => {
    const sym    = row.querySelector('.stk-row-sym')?.value.trim().toUpperCase();
    const shares = parseFloat(row.querySelector('.stk-row-sh')?.value);
    if (sym) out.push({ symbol: sym, shares: Number.isFinite(shares) ? shares : 0 });
  });
  return out;
}

async function _saveStockSettings() {
  const saveBtn = document.getElementById('stk-settings-save');
  const msg     = document.getElementById('stk-settings-msg');
  const profile = _collectProfile();
  const payload = {
    my_stocks: _collectSettings('my_stocks'),
    my_crypto: _collectSettings('my_crypto'),
    profile,
  };

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'SAVING…'; }
  if (msg) msg.textContent = '';

  try {
    const res = await fetch(`${BACKEND_BASE}/stocks/holdings`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`/holdings ${res.status}`);
    _holdings = { my_stocks: payload.my_stocks, my_crypto: payload.my_crypto };
    _profile  = profile;

    // Refresh the My Stocks / My Crypto tiles if the dashboard is live.
    if (!mktPanel.classList.contains('hidden')) {
      _populateSelectors();
      await Promise.all([
        _loadMyTile(4, _tilePeriod[4], true),
        _loadMyTile(5, _tilePeriod[5], true),
      ]);
    }
    closeStockSettings();
  } catch (err) {
    console.error('[stocks-panel] save settings:', err);
    if (msg) msg.textContent = 'Save failed — try again.';
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'SAVE'; }
  }
}
