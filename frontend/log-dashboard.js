// frontend/log-dashboard.js
// Diagnostics & Logs dashboard — in-app pop-up surface opened from the SYSTEM menu.
// Three tabs: OVERVIEW (cross-session health + aggregate metrics),
// SESSIONS (per-session event table), and ANALYSIS (LLM metrics, tool-call
// breakdown, and response reviews correlating replies with injected tool calls).
//
// Talks to the backend /log/* endpoints. Self-contained; the only shared
// dependency is escapeHtml from utils.js.

import { BACKEND_BASE } from './config.js';
import { escapeHtml } from './utils.js';

// ── Event-type colours (mirror the CSS .lev-* classes) ───────────────────────
const EVENT_COLORS = {
  session_start: '#7be0a6', session_end: '#7be0a6',
  user_speech: '#88ccff', user_speech_frontend: '#66aaee', user_text: '#aaddff',
  tool_dispatch: '#ffd27b', tool_call: '#ffaa44', tool_result: '#44cc88',
  llm_request: '#cc88ff', llm_response: '#aa66ee', error: '#ff6677',
  rag_retrieval: '#5ad0c0', tts_synthesis: '#d0a0ff', system_event: '#8fb3d6',
  dream_skipped: '#c89bf0',
};

const EVENT_SUMMARY = {
  user_speech:          d => d.transcript ? `"${d.transcript.slice(0, 80)}"${d.language ? ` [${d.language}]` : ''}` : '',
  user_speech_frontend: d => d.transcript ? `"${d.transcript.slice(0, 80)}"` : '',
  user_text:            d => d.text ? `"${d.text.slice(0, 80)}"` : '',
  tool_dispatch:        d => `tool: ${d.tool || '?'}${d.trigger_phrase ? ` — "${d.trigger_phrase.slice(0, 50)}"` : ''}`,
  tool_call:            d => `${d.endpoint || ''} ${d.method || ''} — ${d.params_summary || ''}`,
  tool_result:          d => `${d.endpoint || ''} ${d.status_code != null ? d.status_code : ''} ${d.duration_ms != null ? d.duration_ms + 'ms' : ''} — ${(d.result_summary || '').slice(0, 60)}`,
  llm_request:          d => `model: ${d.model || '?'}, msgs: ${d.message_count || 0}, hash: ${d.system_prompt_hash || ''}`,
  llm_response:         d => `${d.completion_tokens ?? d.token_count_estimate ?? 0} tok, ${d.duration_ms || 0}ms${d.ttft_ms != null ? `, ttft ${d.ttft_ms}ms` : ''}${d.predicted_per_second != null ? `, ${d.predicted_per_second} tok/s` : ''} — "${(d.full_text || '').slice(0, 50)}"`,
  rag_retrieval:        d => `${d.scope || 'docs'}: ${d.hits ?? 0} hits, ${d.duration_ms ?? 0}ms${d.injected ? ' · injected' : ''}`,
  tts_synthesis:        d => `${d.voice || ''} · ${d.chunk_count ?? 0} chunks, ${d.duration_ms ?? 0}ms [${d.device || ''}]`,
  session_start:        d => `llm: ${d.llm_backend || ''}, pid: ${d.pid || ''}`,
  session_end:          d => `duration: ${d.duration_s != null ? d.duration_s + 's' : '?'}, events: ${d.total_events != null ? d.total_events : ''}`,
  system_event:         d => `${d.event || ''}${d.duration_s != null ? ` · ${d.duration_s}s` : ''}`,
  error:                d => `${d.source || ''}: ${(d.message || d.error || '').slice(0, 80)}`,
};

// ── Module state ─────────────────────────────────────────────────────────────
let _panel = null;
let _initialised = false;
let _sessions = [];
let _activeSessionId = null;
let _allEvents = [];
let _activeTypes = new Set();
let _overviewLoaded = false;
let _analysisWindowDays = null;  // active range window (days), or null for single-session mode
let _traceWindowDays = null;     // active trace window (days), or null for single-session mode
let _traceSessionId = null;      // active trace single-session id
let _charts = {};                // Chart.js instances keyed by canvas id
let _liveOn = false;
let _liveTimer = null;
const _LIVE_INTERVAL_MS = 4000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(isoStr) {
  if (!isoStr) return '';
  const t = isoStr.includes('T') ? isoStr.split('T')[1] : isoStr;
  return t.slice(0, 12);
}

function fmtSessionId(id) {
  return id.replace('session_', '').replace('_', ' ').replace(/-/g, (m, off) => off > 9 ? ':' : '-');
}

function summarise(ev) {
  const fn = EVENT_SUMMARY[ev.event];
  if (fn) { try { return fn(ev.data || {}); } catch { /* fall through */ } }
  return JSON.stringify(ev.data || {}).slice(0, 120);
}

async function _getJSON(path) {
  const r = await fetch(`${BACKEND_BASE}${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initLogDashboard() {
  _panel = document.getElementById('logdash-panel');
  if (!_panel || _initialised) return;
  _initialised = true;

  document.getElementById('logdash-close-btn')?.addEventListener('click', closeLogDashboard);
  document.getElementById('logdash-refresh-btn')?.addEventListener('click', () => _refreshActiveTab());
  document.getElementById('logdash-live-btn')?.addEventListener('click', _toggleLive);

  // Tab switching
  _panel.querySelectorAll('.logdash-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
  });

  // Sessions-tab search
  document.getElementById('logdash-search')?.addEventListener('input', _renderEventTable);

  // Analysis-tab session picker
  document.getElementById('logdash-analysis-select')?.addEventListener('change', (e) => {
    if (!e.target.value) return;
    _setActiveWindowPill(null);
    _renderSessionAnalysis(e.target.value);
  });

  // Analysis-tab time-window pills
  _panel.querySelectorAll('#logdash-window-pills .logdash-wpill').forEach(btn => {
    btn.addEventListener('click', () => {
      const days = parseInt(btn.dataset.days, 10);
      _setActiveWindowPill(days);
      const sel = document.getElementById('logdash-analysis-select');
      if (sel) sel.value = '';
      _renderRangeAnalysis(days);
    });
  });

  // Analysis-tab evaluate (local LLM-as-judge) button
  document.getElementById('logdash-evaluate-btn')?.addEventListener('click', _runEvaluation);

  // Traces-tab session picker
  document.getElementById('logdash-trace-select')?.addEventListener('change', (e) => {
    if (!e.target.value) return;
    _setActiveTracePill(null);
    _renderSessionTraces(e.target.value);
  });

  // Traces-tab time-window pills
  _panel.querySelectorAll('#logdash-trace-pills .logdash-wpill').forEach(btn => {
    btn.addEventListener('click', () => {
      const days = parseInt(btn.dataset.days, 10);
      _setActiveTracePill(days);
      const sel = document.getElementById('logdash-trace-select');
      if (sel) sel.value = '';
      _renderRangeTraces(days);
    });
  });

  // Esc closes the panel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _panel && !_panel.classList.contains('hidden')) {
      closeLogDashboard();
    }
  });
}

export async function showLogDashboard() {
  if (!_initialised) initLogDashboard();
  if (!_panel) return;
  _panel.classList.remove('hidden');
  _switchTab('overview');
  await _loadOverview();
  // Pre-load the session list so the other tabs are ready.
  if (_sessions.length === 0) await _loadSessions();
}

export function closeLogDashboard() {
  if (_panel) _panel.classList.add('hidden');
  _stopLive();
}

// ── Live mode ────────────────────────────────────────────────────────────────

function _toggleLive() {
  _liveOn ? _stopLive() : _startLive();
}

function _startLive() {
  _liveOn = true;
  document.getElementById('logdash-live-btn')?.classList.add('live-on');
  if (_liveTimer) clearInterval(_liveTimer);
  _liveTimer = setInterval(() => { _refreshActiveTab(); }, _LIVE_INTERVAL_MS);
}

function _stopLive() {
  _liveOn = false;
  document.getElementById('logdash-live-btn')?.classList.remove('live-on');
  if (_liveTimer) { clearInterval(_liveTimer); _liveTimer = null; }
}

// ── Tab management ───────────────────────────────────────────────────────────

let _activeTab = 'overview';

function _switchTab(tab) {
  _activeTab = tab;
  _panel.querySelectorAll('.logdash-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['overview', 'sessions', 'traces', 'analysis'].forEach(t => {
    document.getElementById(`logdash-${t}`)?.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'sessions' && _sessions.length === 0) _loadSessions();
  if (tab === 'analysis') _populateAnalysisPicker();
  if (tab === 'traces') _populateTracePicker();
}

async function _refreshActiveTab() {
  if (_activeTab === 'overview') { _overviewLoaded = false; await _loadOverview(); }
  else if (_activeTab === 'sessions') { await _loadSessions(); }
  else if (_activeTab === 'traces') {
    if (_traceWindowDays != null) await _renderRangeTraces(_traceWindowDays);
    else if (_traceSessionId) await _renderSessionTraces(_traceSessionId);
  }
  else if (_activeTab === 'analysis') {
    if (_analysisWindowDays != null) {
      await _renderRangeAnalysis(_analysisWindowDays);
    } else {
      const sel = document.getElementById('logdash-analysis-select');
      if (sel && sel.value) await _renderSessionAnalysis(sel.value);
    }
  }
}

// ── Overview tab ─────────────────────────────────────────────────────────────

async function _loadOverview() {
  if (_overviewLoaded) return;
  const healthEl = document.getElementById('logdash-health');
  const metricsEl = document.getElementById('logdash-metrics');
  if (healthEl) healthEl.innerHTML = '<div class="logdash-empty">Loading…</div>';
  let ov;
  try {
    ov = await _getJSON('/log/overview');
  } catch (e) {
    if (healthEl) healthEl.innerHTML = `<div class="logdash-empty">Failed to load overview: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _overviewLoaded = true;

  // Health chips — derive status from error rate.
  const errRatePct = (ov.error_rate * 100);
  const healthClass = ov.total_errors === 0 ? 'ok' : (errRatePct < 2 ? 'warn' : 'bad');
  const healthState = ov.total_errors === 0 ? 'HEALTHY' : (errRatePct < 2 ? 'DEGRADED' : 'ERRORS');
  if (healthEl) {
    healthEl.innerHTML =
      _healthChip('OVERALL', healthState, healthClass) +
      _healthChip('SESSIONS', ov.total_sessions, '') +
      _healthChip('ERROR RATE', `${errRatePct.toFixed(2)}%`, healthClass) +
      _healthChip('TOTAL ERRORS', ov.total_errors, ov.total_errors > 0 ? 'bad' : 'ok') +
      _healthChip('AVG SESSION', ov.avg_session_duration_s != null ? `${ov.avg_session_duration_s}s` : '—', '') +
      _healthChip('AVG LLM', ov.avg_llm_duration_ms != null ? `${ov.avg_llm_duration_ms}ms` : '—', '') +
      _healthChip('AVG TTFT', ov.avg_ttft_ms != null ? `${ov.avg_ttft_ms}ms` : '—', '') +
      _healthChip('AVG TOK/S', ov.avg_tokens_per_sec != null ? `${ov.avg_tokens_per_sec}` : '—', '');
  }

  _renderResources(ov.system_health || {});

  if (metricsEl) {
    metricsEl.innerHTML =
      _metric(ov.total_events, 'TOTAL EVENTS') +
      _metric(ov.total_llm_calls, 'LLM CALLS') +
      _metric(ov.total_tool_dispatches, 'TOOL DISPATCHES') +
      _metric(ov.total_user_inputs, 'USER INPUTS') +
      _metric(ov.total_completion_tokens ?? 0, 'TOTAL TOKENS') +
      _metric(ov.total_errors, 'ERRORS');
  }

  _renderToolFreq(ov.tool_frequency || []);
  _renderRecentErrors(ov.recent_errors || []);
  _renderVersions();
}

function _renderResources(h) {
  const el = document.getElementById('logdash-resources');
  if (!el) return;
  if (!h || Object.keys(h).length === 0) {
    el.innerHTML = '<div class="logdash-empty">Resource telemetry unavailable.</div>';
    return;
  }
  const llm = h.llm_server || {};
  const vram = h.gpu_vram || null;
  const cpuCls = h.cpu_percent != null ? (h.cpu_percent > 90 ? 'bad' : h.cpu_percent > 70 ? 'warn' : 'ok') : '';
  const ramCls = h.ram_percent != null ? (h.ram_percent > 90 ? 'bad' : h.ram_percent > 75 ? 'warn' : 'ok') : '';
  el.innerHTML =
    _healthChip('LLM SERVER', llm.reachable ? 'UP' : 'DOWN', llm.reachable ? 'ok' : 'bad') +
    _healthChip('CPU', h.cpu_percent != null ? `${h.cpu_percent.toFixed(0)}%` : '—', cpuCls) +
    _healthChip('RAM', h.ram_percent != null ? `${h.ram_percent.toFixed(0)}%` : '—', ramCls) +
    _healthChip('PROC MEM', h.process_rss_mib != null ? `${h.process_rss_mib} MiB` : '—', '') +
    _healthChip('GPU VRAM', vram && vram.used_mib != null ? `${vram.used_mib} MiB` : '—', '') +
    _healthChip('UPTIME', h.uptime_s != null ? _fmtUptime(h.uptime_s) : '—', '') +
    _healthChip('REQUESTS', h.request_count ?? '—', '') +
    _healthChip('SRV ERRORS', h.error_count ?? '—', (h.error_count || 0) > 0 ? 'warn' : 'ok');
}

function _fmtUptime(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

async function _renderVersions() {
  const body = document.getElementById('logdash-versions-body');
  if (!body) return;
  let data;
  try {
    data = await _getJSON('/log/versions?days=7');
  } catch {
    body.innerHTML = '<tr><td colspan="6" class="logdash-empty">Version data unavailable.</td></tr>';
    return;
  }
  const rows = data.versions || [];
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="logdash-empty">No prompt versions in the last 7 days.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(v =>
    `<tr><td><span class="lr-tool-tag">${escapeHtml(v.hash)}</span></td>` +
    `<td>${v.responses}</td>` +
    `<td>${v.avg_duration_ms != null ? v.avg_duration_ms : '—'}</td>` +
    `<td>${v.avg_ttft_ms != null ? v.avg_ttft_ms : '—'}</td>` +
    `<td>${v.avg_tokens_per_sec != null ? v.avg_tokens_per_sec : '—'}</td>` +
    `<td>${escapeHtml(fmtTime(v.last_seen))}</td></tr>`
  ).join('');
}

function _healthChip(lbl, val, cls) {
  return `<div class="logdash-health-chip ${cls}"><span class="lh-lbl">${escapeHtml(lbl)}</span><span class="lh-val">${escapeHtml(String(val))}</span></div>`;
}

function _metric(val, lbl) {
  return `<div class="logdash-metric"><div class="lm-val">${escapeHtml(String(val ?? '—'))}</div><div class="lm-lbl">${escapeHtml(lbl)}</div></div>`;
}

function _renderToolFreq(freq) {
  const el = document.getElementById('logdash-tool-freq');
  if (!el) return;
  if (freq.length === 0) { el.innerHTML = '<div class="logdash-empty">No tool usage recorded.</div>'; return; }
  const max = Math.max(...freq.map(f => f.count));
  el.innerHTML = freq.map(f => {
    const pct = max > 0 ? Math.round((f.count / max) * 100) : 0;
    return `<div class="logdash-bar-row"><span class="lb-name">${escapeHtml(f.tool)}</span>` +
           `<span class="logdash-bar-track"><span class="logdash-bar-fill" style="width:${pct}%"></span></span>` +
           `<span class="lb-count">${f.count}</span></div>`;
  }).join('');
}

function _renderRecentErrors(errors) {
  const el = document.getElementById('logdash-recent-errors');
  if (!el) return;
  if (errors.length === 0) { el.innerHTML = '<div class="logdash-empty">No errors recorded. ✓</div>'; return; }
  el.innerHTML = errors.map(e =>
    `<div class="logdash-error-item">` +
    `<div class="le-src">${escapeHtml(e.source || 'error')}</div>` +
    `<div class="le-msg">${escapeHtml(e.message || '')}</div>` +
    `<div class="le-ts">${escapeHtml(fmtSessionId(e.session_id || ''))} · ${escapeHtml(fmtTime(e.ts))}</div>` +
    `</div>`
  ).join('');
}

// ── Sessions tab ─────────────────────────────────────────────────────────────

async function _loadSessions() {
  const listEl = document.getElementById('logdash-session-list');
  if (listEl) listEl.innerHTML = '<div class="logdash-session-item">Loading…</div>';
  try {
    _sessions = await _getJSON('/log/sessions');
  } catch (e) {
    if (listEl) listEl.innerHTML = `<div class="logdash-error-item"><div class="le-msg">Failed to load: ${escapeHtml(e.message)}</div></div>`;
    return;
  }
  _renderSessionList();
  if (_sessions.length > 0) await _selectSession(_sessions[0].session_id);
}

function _renderSessionList() {
  const listEl = document.getElementById('logdash-session-list');
  if (!listEl) return;
  if (_sessions.length === 0) { listEl.innerHTML = '<div class="logdash-session-item">No sessions found.</div>'; return; }
  listEl.innerHTML = '';
  for (const s of _sessions) {
    const div = document.createElement('div');
    div.className = 'logdash-session-item' + (s.session_id === _activeSessionId ? ' active' : '');
    div.dataset.id = s.session_id;
    div.innerHTML = `<span class="lsi-id">${escapeHtml(fmtSessionId(s.session_id))}</span>` +
                    `<span class="lsi-meta">${s.event_count} events &nbsp; ${fmtBytes(s.size_bytes)}</span>`;
    div.addEventListener('click', () => _selectSession(s.session_id));
    listEl.appendChild(div);
  }
}

async function _selectSession(sessionId) {
  _activeSessionId = sessionId;
  document.querySelectorAll('.logdash-session-item').forEach(el =>
    el.classList.toggle('active', el.dataset.id === sessionId));

  const emptyEl = document.getElementById('logdash-events-empty');
  const tableEl = document.getElementById('logdash-table');
  if (emptyEl) { emptyEl.textContent = 'Loading…'; emptyEl.classList.remove('hidden'); }
  if (tableEl) tableEl.classList.add('hidden');

  try {
    const text = await (await fetch(`${BACKEND_BASE}/log/sessions/${sessionId}`)).text();
    _allEvents = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { _allEvents.push(JSON.parse(t)); } catch { /* skip */ }
    }
  } catch (e) {
    if (emptyEl) emptyEl.textContent = `Failed to load session: ${e.message}`;
    return;
  }

  const seen = new Set();
  for (const ev of _allEvents) seen.add(ev.event);
  _activeTypes = new Set(seen);
  _renderTypeFilters(seen);
  _renderEventTable();
  _loadSessionStats(sessionId);
}

function _renderTypeFilters(orderedTypes) {
  const container = document.getElementById('logdash-type-filters');
  if (!container) return;
  container.innerHTML = '';
  for (const type of orderedTypes) {
    const colour = EVENT_COLORS[type] || '#c8c8c8';
    const btn = document.createElement('button');
    btn.className = 'logdash-type-btn active';
    btn.textContent = type;
    btn.style.color = colour;
    btn.style.borderColor = colour;
    btn.addEventListener('click', () => {
      if (_activeTypes.has(type)) { _activeTypes.delete(type); btn.classList.remove('active'); }
      else { _activeTypes.add(type); btn.classList.add('active'); }
      _renderEventTable();
    });
    container.appendChild(btn);
  }
}

function _renderEventTable() {
  const searchEl = document.getElementById('logdash-search');
  const search = (searchEl?.value || '').toLowerCase();

  let sessionStartMs = null;
  const startEv = _allEvents.find(ev => ev.event === 'session_start');
  if (startEv && startEv.ts) { try { sessionStartMs = new Date(startEv.ts).getTime(); } catch { /* ignore */ } }

  const visible = _allEvents.filter(ev => {
    if (!_activeTypes.has(ev.event)) return false;
    if (search) {
      const hay = (ev.event + ' ' + (ev.source || '') + ' ' + JSON.stringify(ev.data || {})).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const countEl = document.getElementById('logdash-event-count');
  if (countEl) countEl.textContent = `${visible.length} / ${_allEvents.length} events`;

  const tbody = document.getElementById('logdash-table-body');
  const table = document.getElementById('logdash-table');
  const emptyMsg = document.getElementById('logdash-events-empty');
  if (!tbody || !table || !emptyMsg) return;

  if (visible.length === 0) {
    table.classList.add('hidden');
    emptyMsg.classList.remove('hidden');
    emptyMsg.textContent = _allEvents.length === 0 ? 'Session log is empty.' : 'No events match current filters.';
    return;
  }

  table.classList.remove('hidden');
  emptyMsg.classList.add('hidden');
  tbody.innerHTML = '';

  for (let i = 0; i < visible.length; i++) {
    const ev = visible[i];
    let elapsedStr = '';
    if (sessionStartMs !== null && ev.ts) {
      try { elapsedStr = `+${Math.round(new Date(ev.ts).getTime() - sessionStartMs)}`; } catch { /* ignore */ }
    }
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="lc-num">${i + 1}</td>` +
      `<td class="lc-ts">${escapeHtml(fmtTime(ev.ts))}</td>` +
      `<td class="lc-ms">${escapeHtml(elapsedStr)}</td>` +
      `<td class="lc-src">${escapeHtml(ev.source || '')}</td>` +
      `<td class="lc-event"><span class="lev-${escapeHtml(ev.event || '')}">${escapeHtml(ev.event || '')}</span></td>` +
      `<td class="lc-summary">${escapeHtml(summarise(ev))}</td>`;
    tr.addEventListener('click', () => _toggleDetail(tr, ev));
    tbody.appendChild(tr);
  }
}

function _toggleDetail(rowEl, ev) {
  const next = rowEl.nextElementSibling;
  if (next && next.classList.contains('logdash-detail-row')) {
    next.remove();
    rowEl.classList.remove('expanded');
    return;
  }
  const detailTr = document.createElement('tr');
  detailTr.className = 'logdash-detail-row';
  const td = document.createElement('td');
  td.setAttribute('colspan', '6');
  const inner = document.createElement('div');
  inner.className = 'logdash-detail-inner';
  inner.textContent = JSON.stringify(ev.data, null, 2);
  td.appendChild(inner);
  detailTr.appendChild(td);
  rowEl.insertAdjacentElement('afterend', detailTr);
  rowEl.classList.add('expanded');
}

async function _loadSessionStats(sessionId) {
  const strip = document.getElementById('logdash-stats-strip');
  if (!strip) return;
  strip.innerHTML = '';
  try {
    const d = await _getJSON(`/log/stats/${sessionId}`);
    const chips = [
      ['EVENTS', d.total_events, ''],
      ['DURATION', d.duration_s != null ? `${d.duration_s}s` : 'live', ''],
      ['LLM CALLS', d.llm_calls, ''],
      ['TOOL DISPATCHES', d.tool_dispatches, ''],
      ['ERRORS', d.error_count, d.error_count > 0 ? 'err' : ''],
      ['TOOLS', (d.tools_used || []).join(', ') || 'none', 'tools'],
    ];
    strip.innerHTML = chips.map(([lbl, val, cls]) =>
      `<span class="logdash-stat-chip ${cls === 'tools' ? 'tools' : ''}">${escapeHtml(lbl)}` +
      `<span ${cls === 'err' ? 'style="color:#ff6677"' : ''}>${escapeHtml(String(val))}</span></span>`
    ).join('');
  } catch (e) {
    strip.innerHTML = `<span class="logdash-stat-chip">Stats unavailable: ${escapeHtml(e.message)}</span>`;
  }
}

// ── Analysis tab ─────────────────────────────────────────────────────────────

function _setActiveWindowPill(days) {
  _analysisWindowDays = days;
  _panel.querySelectorAll('#logdash-window-pills .logdash-wpill').forEach(b =>
    b.classList.toggle('active', days != null && parseInt(b.dataset.days, 10) === days));
}

function _populateAnalysisPicker() {
  const sel = document.getElementById('logdash-analysis-select');
  if (!sel) return;
  const needsFill = sel.options.length === 0 || sel.dataset.count !== String(_sessions.length);
  if (needsFill && _sessions.length > 0) {
    sel.innerHTML = '<option value="">— single session —</option>' + _sessions.map(s =>
      `<option value="${escapeHtml(s.session_id)}">${escapeHtml(fmtSessionId(s.session_id))} (${s.event_count})</option>`
    ).join('');
    sel.dataset.count = String(_sessions.length);
  }
  // First time the tab is opened: default to the 1-day rolling window.
  if (_analysisWindowDays == null && (!sel.value)) {
    _setActiveWindowPill(1);
    sel.value = '';
    _renderRangeAnalysis(1);
  }
}

async function _renderSessionAnalysis(sessionId) {
  if (!sessionId) return;
  _analysisWindowDays = null;
  _setAnalysisScope(`Single session · <span>${escapeHtml(fmtSessionId(sessionId))}</span>`);
  await _fetchAndRenderAnalysis(`/log/review/${sessionId}`);
}

async function _renderRangeAnalysis(days) {
  const label = days === 7 ? '1 week' : (days === 30 ? '1 month' : `${days} day${days > 1 ? 's' : ''}`);
  await _fetchAndRenderAnalysis(`/log/review-range?days=${days}`, (data) => {
    const n = data.session_count ?? 0;
    _setAnalysisScope(`Last <span>${escapeHtml(label)}</span> · <span>${n}</span> session${n === 1 ? '' : 's'}`);
  });
}

function _setAnalysisScope(html) {
  const el = document.getElementById('logdash-analysis-scope');
  if (el) el.innerHTML = html;
}

// ── Traces tab (interaction waterfalls) ──────────────────────────────────────

const SPAN_COLORS = {
  stt: '#88ccff', input: '#aaddff', rag: '#5ad0c0',
  llm: '#aa66ee', tool: '#44cc88', tts: '#d0a0ff', error: '#ff6677',
};

function _setActiveTracePill(days) {
  _traceWindowDays = days;
  if (days != null) _traceSessionId = null;
  _panel.querySelectorAll('#logdash-trace-pills .logdash-wpill').forEach(b =>
    b.classList.toggle('active', days != null && parseInt(b.dataset.days, 10) === days));
}

function _setTraceScope(html) {
  const el = document.getElementById('logdash-trace-scope');
  if (el) el.innerHTML = html;
}

function _populateTracePicker() {
  const sel = document.getElementById('logdash-trace-select');
  if (!sel) return;
  const needsFill = sel.options.length === 0 || sel.dataset.count !== String(_sessions.length);
  if (needsFill && _sessions.length > 0) {
    sel.innerHTML = '<option value="">— single session —</option>' + _sessions.map(s =>
      `<option value="${escapeHtml(s.session_id)}">${escapeHtml(fmtSessionId(s.session_id))} (${s.event_count})</option>`
    ).join('');
    sel.dataset.count = String(_sessions.length);
  }
  if (_traceWindowDays == null && _traceSessionId == null && !sel.value) {
    _setActiveTracePill(1);
    sel.value = '';
    _renderRangeTraces(1);
  }
}

async function _renderSessionTraces(sessionId) {
  if (!sessionId) return;
  _traceWindowDays = null;
  _traceSessionId = sessionId;
  _setTraceScope(`Single session · <span>${escapeHtml(fmtSessionId(sessionId))}</span>`);
  await _fetchAndRenderTraces(`/log/trace/${sessionId}`);
}

async function _renderRangeTraces(days) {
  const label = days === 7 ? '1 week' : (days === 30 ? '1 month' : `${days} day${days > 1 ? 's' : ''}`);
  await _fetchAndRenderTraces(`/log/trace-range?days=${days}`, (data) => {
    const n = data.trace_count ?? 0;
    _setTraceScope(`Last <span>${escapeHtml(label)}</span> · <span>${n}</span> interaction${n === 1 ? '' : 's'}`);
  });
}

async function _fetchAndRenderTraces(path, onData) {
  const listEl = document.getElementById('logdash-trace-list');
  if (listEl) listEl.innerHTML = '<div class="logdash-empty">Loading…</div>';
  let data;
  try {
    data = await _getJSON(path);
  } catch (e) {
    if (listEl) listEl.innerHTML = `<div class="logdash-empty">Failed to load: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (onData) onData(data);
  _renderTraceLegend();
  const traces = data.traces || [];
  if (!listEl) return;
  if (traces.length === 0) {
    listEl.innerHTML = '<div class="logdash-empty">No interaction traces in range.</div>';
    return;
  }
  listEl.innerHTML = traces.map(_renderTrace).join('');
}

function _renderTraceLegend() {
  const el = document.getElementById('logdash-trace-legend');
  if (!el) return;
  el.innerHTML = Object.entries(SPAN_COLORS).map(([type, color]) =>
    `<span class="logdash-legend-item"><span class="logdash-legend-swatch" style="background:${color}"></span>${type}</span>`
  ).join('');
}

function _renderTrace(t) {
  const total = t.total_ms || 1;
  const bars = (t.spans || []).map(sp => {
    const left = Math.max(0, Math.min(100, (sp.start_ms / total) * 100));
    const width = Math.max(0.5, Math.min(100 - left, (sp.duration_ms / total) * 100));
    const color = SPAN_COLORS[sp.type] || '#8fb3d6';
    const title = `${sp.label || sp.type}: ${sp.duration_ms}ms${sp.detail ? ' — ' + sp.detail : ''}`;
    return `<div class="logdash-span" style="left:${left}%;width:${width}%;background:${color}" title="${escapeHtml(title)}">` +
      `<span class="logdash-span-label">${escapeHtml(sp.label || sp.type)}</span></div>`;
  }).join('');
  const errBadge = t.error_count > 0 ? `<span class="logdash-trace-err">⚠ ${t.error_count}</span>` : '';
  return `<div class="logdash-trace">` +
    `<div class="logdash-trace-head">` +
    `<span class="logdash-trace-turn">#${t.turn}</span>` +
    `<span class="logdash-trace-user">${escapeHtml(t.user_input || '(no input)')}</span>` +
    `<span class="logdash-trace-total">${t.total_ms}ms · ${t.span_count} spans ${errBadge}</span></div>` +
    `<div class="logdash-trace-bars">${bars}</div>` +
    `<div class="logdash-trace-resp">${escapeHtml(t.response_excerpt || '')}</div>` +
    `</div>`;
}

async function _fetchAndRenderAnalysis(path, onData) {
  const llmEl = document.getElementById('logdash-llm-metrics');
  const breakdownBody = document.getElementById('logdash-breakdown-body');
  const reviewsEl = document.getElementById('logdash-reviews');
  if (llmEl) llmEl.innerHTML = '<div class="logdash-empty">Loading…</div>';
  if (breakdownBody) breakdownBody.innerHTML = '';
  if (reviewsEl) reviewsEl.innerHTML = '';

  let data;
  try {
    data = await _getJSON(path);
  } catch (e) {
    if (llmEl) llmEl.innerHTML = `<div class="logdash-empty">Failed to load: ${escapeHtml(e.message)}</div>`;
    return;
  }

  if (onData) onData(data);

  _renderAnomalies(data.anomalies || []);

  const dur = data.llm_metrics?.duration_ms || {};
  const ttft = data.llm_metrics?.ttft_ms || {};
  const tps = data.llm_metrics?.tokens_per_sec || {};
  const ctok = data.llm_metrics?.completion_tokens || {};
  const ptok = data.llm_metrics?.prompt_tokens || {};
  if (llmEl) {
    llmEl.innerHTML =
      _metric(dur.count ?? 0, 'LLM RESPONSES') +
      _metric(dur.avg != null ? `${dur.avg}ms` : '—', 'AVG LATENCY') +
      _metric(dur.p50 != null ? `${dur.p50}ms` : '—', 'p50 LATENCY') +
      _metric(dur.p95 != null ? `${dur.p95}ms` : '—', 'p95 LATENCY') +
      _metric(dur.p99 != null ? `${dur.p99}ms` : '—', 'p99 LATENCY') +
      _metric(ttft.avg != null ? `${ttft.avg}ms` : '—', 'AVG TTFT') +
      _metric(ttft.p95 != null ? `${ttft.p95}ms` : '—', 'p95 TTFT') +
      _metric(tps.avg != null ? `${tps.avg}` : '—', 'AVG TOK/S') +
      _metric(tps.min != null ? `${tps.min}` : '—', 'MIN TOK/S') +
      _metric(ptok.total ?? 0, 'PROMPT TOKENS') +
      _metric(ctok.total ?? 0, 'OUTPUT TOKENS') +
      _metric(ctok.avg != null ? ctok.avg : '—', 'AVG OUTPUT TOK');
  }

  _renderCharts(data.series || []);
  _renderQuality(data.quality);
  _renderRagMetrics(data.rag_metrics || []);

  if (breakdownBody) {
    const rows = data.tool_breakdown || [];
    if (rows.length === 0) {
      breakdownBody.innerHTML = '<tr><td colspan="8" class="logdash-empty">No tool activity in range.</td></tr>';
    } else {
      breakdownBody.innerHTML = rows.map(r =>
        `<tr><td>${escapeHtml(r.tool)}</td><td>${r.dispatches}</td><td>${r.calls}</td>` +
        `<td style="${r.errors > 0 ? 'color:#ff6677' : ''}">${r.errors}</td>` +
        `<td style="${r.silent_failures > 0 ? 'color:#ffd27b' : ''}">${r.silent_failures ?? 0}</td>` +
        `<td style="${r.error_rate > 0.2 ? 'color:#ff9a9a' : ''}">${r.error_rate != null ? (r.error_rate * 100).toFixed(0) + '%' : '—'}</td>` +
        `<td>${r.avg_duration_ms != null ? r.avg_duration_ms : '—'}</td>` +
        `<td>${r.p95_duration_ms != null ? r.p95_duration_ms : '—'}</td></tr>`
      ).join('');
    }
  }

  if (reviewsEl) {
    const reviews = data.reviews || [];
    if (reviews.length === 0) {
      reviewsEl.innerHTML = '<div class="logdash-empty">No LLM responses in range.</div>';
    } else {
      reviewsEl.innerHTML = reviews.map(rv => {
        const tools = (rv.injected_tools && rv.injected_tools.length)
          ? rv.injected_tools.map(t => `<span class="lr-tool-tag">${escapeHtml(t)}</span>`).join('')
          : '<span class="lr-tool-tag none">no tool injection</span>';
        const ragTag = rv.rag_hits ? `<span class="lr-tool-tag rag">RAG ×${rv.rag_hits}</span>` : '';
        const metaBits = [];
        if (rv.duration_ms != null) metaBits.push(`${rv.duration_ms}ms`);
        if (rv.ttft_ms != null) metaBits.push(`ttft ${rv.ttft_ms}ms`);
        if (rv.tokens_per_sec != null) metaBits.push(`${rv.tokens_per_sec} tok/s`);
        if (rv.token_count != null) metaBits.push(`${rv.token_count} tok`);
        let evalTag = '';
        if (rv.eval && rv.eval.overall != null) {
          const cls = rv.eval.overall >= 4 ? 'ok' : (rv.eval.overall >= 3 ? 'warn' : 'bad');
          evalTag = `<span class="lr-eval ${cls}" title="${escapeHtml(rv.eval.notes || '')}">★ ${rv.eval.overall}` +
            `<span class="lr-eval-sub">R${rv.eval.relevance ?? '–'}/C${rv.eval.coherence ?? '–'}/G${rv.eval.groundedness ?? '–'}</span></span>`;
        }
        return `<div class="logdash-review">` +
          `<div class="lr-head">` +
          `<span class="lr-user">${escapeHtml(rv.user_input || '(no preceding input)')}</span>` +
          `<span class="lr-meta">${escapeHtml(metaBits.join(' · '))} ${evalTag}</span></div>` +
          `<div class="lr-tools">${ragTag}${tools}</div>` +
          `<div class="lr-resp">${escapeHtml(rv.response_excerpt || '')}</div>` +
          `</div>`;
      }).join('');
    }
  }
}

function _renderAnomalies(anomalies) {
  const el = document.getElementById('logdash-anomalies');
  if (!el) return;
  if (!anomalies.length) { el.innerHTML = ''; return; }
  el.innerHTML = anomalies.map(a =>
    `<div class="logdash-anomaly ${escapeHtml(a.severity || 'warn')}">` +
    `<span class="la-type">${escapeHtml((a.type || '').replace(/_/g, ' '))}</span>` +
    `<span class="la-msg">${escapeHtml(a.message || '')}</span></div>`
  ).join('');
}

function _renderQuality(q) {
  const el = document.getElementById('logdash-quality');
  if (!el) return;
  if (!q || !q.count) {
    el.innerHTML = '<div class="logdash-empty">Not yet evaluated. Select a single session and press EVALUATE.</div>';
    return;
  }
  el.innerHTML =
    _metric(q.count, 'SCORED') +
    _metric(q.avg_overall != null ? q.avg_overall : '—', 'AVG OVERALL') +
    _metric(q.avg_relevance != null ? q.avg_relevance : '—', 'RELEVANCE') +
    _metric(q.avg_coherence != null ? q.avg_coherence : '—', 'COHERENCE') +
    _metric(q.avg_groundedness != null ? q.avg_groundedness : '—', 'GROUNDEDNESS') +
    _metric(q.low_score_count ?? 0, 'LOW SCORES (<3)');
}

function _renderRagMetrics(rag) {
  const el = document.getElementById('logdash-rag-metrics');
  if (!el) return;
  if (!rag.length) { el.innerHTML = '<div class="logdash-empty">No RAG retrievals in range.</div>'; return; }
  el.innerHTML = rag.map(b =>
    _metric(b.retrievals, `${(b.scope || 'docs').toUpperCase()} RETRIEVALS`) +
    _metric(b.avg_hits != null ? b.avg_hits : '—', `${(b.scope || 'docs').toUpperCase()} AVG HITS`) +
    _metric(b.avg_duration_ms != null ? `${b.avg_duration_ms}ms` : '—', `${(b.scope || 'docs').toUpperCase()} AVG ms`) +
    _metric(b.injection_rate != null ? `${(b.injection_rate * 100).toFixed(0)}%` : '—', `${(b.scope || 'docs').toUpperCase()} INJECTED`)
  ).join('');
}

// ── Charts (Chart.js) ────────────────────────────────────────────────────────

function _lineChart(canvasId, points, color, fill) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;
  if (_charts[canvasId]) { _charts[canvasId].destroy(); _charts[canvasId] = null; }
  const labels = points.map((_, i) => i + 1);
  _charts[canvasId] = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [{
      data: points, borderColor: color, backgroundColor: fill,
      borderWidth: 1.5, pointRadius: 0, tension: 0.25, fill: true,
    }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      scales: {
        x: { display: false },
        y: { ticks: { color: '#8fb3d6', font: { size: 9 } }, grid: { color: 'rgba(44,94,138,0.18)' } },
      },
    },
  });
}

function _renderCharts(series) {
  const lat = series.map(s => s.duration_ms).filter(v => v != null);
  const tps = series.map(s => s.tokens_per_sec).filter(v => v != null);
  const ttft = series.map(s => s.ttft_ms).filter(v => v != null);
  _lineChart('logdash-chart-latency', lat, '#6cd3ff', 'rgba(108,211,255,0.12)');
  _lineChart('logdash-chart-tps', tps, '#7be0a6', 'rgba(123,224,166,0.12)');
  _lineChart('logdash-chart-ttft', ttft, '#ffd27b', 'rgba(255,210,123,0.12)');
}

// ── Quality evaluation (local LLM-as-judge) ──────────────────────────────────

async function _runEvaluation() {
  const sel = document.getElementById('logdash-analysis-select');
  const sessionId = sel?.value;
  const btn = document.getElementById('logdash-evaluate-btn');
  if (!sessionId) {
    _setAnalysisScope('Select a single session from the dropdown before evaluating.');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'SCORING…'; }
  try {
    const r = await fetch(`${BACKEND_BASE}/log/evaluate/${sessionId}?limit=20`, { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await _renderSessionAnalysis(sessionId);
  } catch (e) {
    _setAnalysisScope(`Evaluation failed: ${escapeHtml(e.message)}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'EVALUATE'; }
  }
}
