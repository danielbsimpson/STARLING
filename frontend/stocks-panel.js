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

// ── Back button & keyboard ────────────────────────────────────────────────────
mktBackBtn?.addEventListener('click', closeDetailView);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && _detailSymbol) closeDetailView();
});

// ── Window resize ─────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  Object.values(_tileCharts).forEach(c => c?.resize?.());
  _detailChart?.resize?.();
});

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
  if (sym) openDetailView(sym);
});

// ── Selectors (tiles 4 & 5) ───────────────────────────────────────────────────
document.getElementById('sel-4')?.addEventListener('change', e => {
  document.getElementById('tile-4').dataset.symbol = e.target.value;
  _loadTileHistory(4, _tilePeriod[4], true);
  _updateTileQuote(4);
});
document.getElementById('sel-5')?.addEventListener('change', e => {
  document.getElementById('tile-5').dataset.symbol = e.target.value;
  _loadTileHistory(5, _tilePeriod[5], true);
  _updateTileQuote(5);
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

  _renderGroupTabs(data.groups, data.default_group);
  _populateSelectors(data.groups);
  _updateAllTileQuotes(data.tickers);
  await _loadAllTileHistories(force);

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

// ── Tile 4 / 5 selector population ───────────────────────────────────────────
function _populateSelectors(groups) {
  const equities = [];
  const cryptos  = [];
  groups.forEach(g => {
    g.tickers.forEach(t => {
      if (t.type === 'crypto') cryptos.push(t);
      else if (t.type !== 'index') equities.push(t);
    });
  });

  const sel4  = document.getElementById('sel-4');
  const sel5  = document.getElementById('sel-5');
  const tile4 = document.getElementById('tile-4');
  const tile5 = document.getElementById('tile-5');

  if (sel4 && equities.length) {
    sel4.innerHTML = equities.map(t =>
      `<option value="${escapeHtml(t.symbol)}">${escapeHtml(t.symbol)} — ${escapeHtml(t.name)}</option>`
    ).join('');
    tile4.dataset.symbol = equities[0].symbol;
  }

  if (sel5 && cryptos.length) {
    sel5.innerHTML = cryptos.map(t => {
      const label = t.symbol.replace('-USD','').replace('-USDT','');
      return `<option value="${escapeHtml(t.symbol)}">${escapeHtml(label)}</option>`;
    }).join('');
    tile5.dataset.symbol = cryptos[0].symbol;
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
  const tile4sym = document.getElementById('tile-4')?.dataset.symbol || '';
  const tile5sym = document.getElementById('tile-5')?.dataset.symbol || '';
  const allSyms  = [...new Set(['^GSPC','^IXIC','^DJI','BTC-USD','ETH-USD', tile4sym, tile5sym].filter(Boolean))];

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

  if (tile4sym && bySymbol[tile4sym]) _renderTileChart(4, [{data: _toXY(bySymbol[tile4sym].candles), color: TILE_COLORS[4]}]);
  if (tile5sym && bySymbol[tile5sym]) _renderTileChart(5, [{data: _toXY(bySymbol[tile5sym].candles), color: TILE_COLORS[5]}]);
}

async function _loadTileHistory(tileIdx, win, force = false) {
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
