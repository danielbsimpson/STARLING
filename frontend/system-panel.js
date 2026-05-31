// frontend/system-panel.js
// Operator-facing surface for system awareness.
// Renders boot snapshot, tool inventory, last-run events, and live runtime
// telemetry. Also exposes detectSystemStatusTrigger + handleSystemStatusTrigger
// for the voice-dispatch chain in app.js.

import { BACKEND_BASE } from './config.js';
import { escapeHtml, formatStatusForVoice } from './utils.js';

// ── Module-level DOM refs (resolved lazily — panel may not exist on init) ────
let _panel       = null;
let _closeBtn    = null;
let _refreshBtn  = null;
let _bootMount   = null;
let _toolsMount  = null;
let _eventsMount = null;
let _runtimeMount = null;
let _staticMount = null;
let _lastStatus  = null;

// ── Voice trigger ───────────────────────────────────────────────────────────
const _PHRASES = [
  /\bsystem\s+status\b/i,
  /\bhow\s+are\s+you\s+running\b/i,
  /\bwhat'?s\s+your\s+status\b/i,
  /\bare\s+you\s+healthy\b/i,
  /\bself[-\s]?diagnostic\b/i,
];

export function detectSystemStatusTrigger(text) {
  if (!text) return false;
  return _PHRASES.some(re => re.test(text));
}

// ── Public API ──────────────────────────────────────────────────────────────

export function initSystemPanel() {
  _panel       = document.getElementById('system-panel');
  if (!_panel) return;
  _closeBtn    = document.getElementById('system-close-btn');
  _refreshBtn  = document.getElementById('system-refresh-btn');
  _bootMount   = document.getElementById('system-boot');
  _toolsMount  = document.getElementById('system-tools');
  _eventsMount = document.getElementById('system-events');
  _runtimeMount = document.getElementById('system-runtime');
  _staticMount  = document.getElementById('system-static-block');

  if (_closeBtn)   _closeBtn.addEventListener('click', closeSystemPanel);
  if (_refreshBtn) _refreshBtn.addEventListener('click', async () => {
    try { await fetch(`${BACKEND_BASE}/system/refresh-tools`, { method: 'POST' }); }
    catch { /* ignore — refresh button is best-effort */ }
    await renderSystemPanel();
  });
}

export async function showSystemPanel() {
  if (!_panel) initSystemPanel();
  if (!_panel) return;
  _panel.classList.remove('hidden');
  await renderSystemPanel();
}

export function closeSystemPanel() {
  if (_panel) _panel.classList.add('hidden');
}

export async function fetchSystemSnapshot() {
  try {
    const res = await fetch(`${BACKEND_BASE}/system/status`);
    if (!res.ok) return null;
    _lastStatus = await res.json();
    return _lastStatus;
  } catch { return null; }
}

export async function handleSystemStatusTrigger(enqueueSpeak) {
  const status = await fetchSystemSnapshot();
  if (!status) {
    enqueueSpeak('System status is unavailable right now.');
    return;
  }
  enqueueSpeak(formatStatusForVoice(status));
}

// ── Rendering ───────────────────────────────────────────────────────────────

async function renderSystemPanel() {
  const status = await fetchSystemSnapshot();
  if (!status) {
    if (_bootMount) _bootMount.innerHTML = '<div class="system-error">Status unavailable.</div>';
    return;
  }

  _renderBoot(status.boot || {});
  _renderTools(status.tools || {});
  _renderEvents(status.last_events || {});
  _renderRuntime(status.runtime || {});
  if (_staticMount) {
    _staticMount.textContent = status.static_block || '';
  }
}

function _kv(label, value) {
  return `<div class="system-kv"><span class="system-kv-k">${escapeHtml(label)}</span>` +
         `<span class="system-kv-v">${escapeHtml(value ?? '—')}</span></div>`;
}

/**
 * Format an STT/TTS boot-probe entry as "engine model · DEVICE".
 * Device is uppercased (GPU/CPU); a trailing "?" marks a boot-time prediction
 * made before the model loaded and confirmed its actual device.
 */
function _engineVal(probe) {
  const engine = probe.engine ? `${probe.engine} ` : '';
  const model  = probe.model || '?';
  let device   = (probe.device || '?').toUpperCase();
  if (probe.predicted && device !== '?') device += '?';
  return `${engine}${model} · ${device}`;
}

function _renderBoot(boot) {
  if (!_bootMount) return;
  const llm = boot.llm || {}, stt = boot.stt || {}, tts = boot.tts || {};
  const rag = boot.rag || {}, gpu = boot.gpu || {};
  _bootMount.innerHTML =
    _kv('LLM',     `${llm.backend || '?'} / ${llm.model || '?'}`) +
    _kv('STT',     _engineVal(stt)) +
    _kv('TTS',     _engineVal(tts)) +
    _kv('RAG',     rag.enabled ? `enabled · ${rag.chunk_count} chunks` : 'disabled') +
    _kv('Memory RAG', rag.memory_enabled ? 'enabled' : 'disabled') +
    _kv('GPU',     gpu && gpu.name ? `${gpu.name} (${gpu.total_vram_mib} MiB)` : 'none') +
    _kv('Host',    `${boot.os || '?'} · Python ${boot.python_version || '?'}`) +
    _kv('Boot',    boot.boot_duration_s != null ? `${boot.boot_duration_s} s` : '—');
}

function _renderTools(tools) {
  if (!_toolsMount) return;
  const ids = Object.keys(tools).sort();
  if (!ids.length) { _toolsMount.innerHTML = '<div class="system-empty">No tools registered.</div>'; return; }
  _toolsMount.innerHTML = ids.map(id => {
    const t = tools[id];
    const status = t.enabled ? 'ON'  : 'OFF';
    const cls    = t.enabled ? 'on'  : 'off';
    const reason = t.degraded_reason ? ` — ${escapeHtml(t.degraded_reason)}` : '';
    return `<div class="system-tool"><span class="system-tool-badge ${cls}">${status}</span>` +
           `<span class="system-tool-id">${escapeHtml(id)}</span>` +
           `<span class="system-tool-reason">${reason}</span></div>`;
  }).join('');
}

function _renderEvents(events) {
  if (!_eventsMount) return;
  const keys = Object.keys(events).sort();
  if (!keys.length) { _eventsMount.innerHTML = '<div class="system-empty">No events recorded yet.</div>'; return; }
  _eventsMount.innerHTML = keys.map(k => {
    const e = events[k];
    const dur = e.duration_s != null ? `${e.duration_s}s` : '—';
    return _kv(k, `${dur} @ ${e.ts || '—'}`);
  }).join('');
}

function _renderRuntime(rt) {
  if (!_runtimeMount) return;
  const llm = rt.llm_server || {};
  const gpu = rt.gpu_vram   || null;
  _runtimeMount.innerHTML =
    _kv('Process RSS', rt.process_rss_mib != null ? `${rt.process_rss_mib} MiB` : '—') +
    _kv('CPU',         rt.cpu_percent     != null ? `${rt.cpu_percent}%`        : '—') +
    _kv('RAM',         rt.ram_percent     != null ? `${rt.ram_percent}%`        : '—') +
    _kv('GPU VRAM',    gpu ? `${gpu.used_mib} MiB used / ${gpu.free_mib} MiB free` : '—') +
    _kv('LLM server',  `${llm.backend || '?'} · ${llm.reachable ? 'reachable' : 'offline'}`) +
    _kv('Requests',    `${rt.request_count} (errors: ${rt.error_count})`) +
    _kv('Uptime',      `${rt.uptime_s}s`);
}
