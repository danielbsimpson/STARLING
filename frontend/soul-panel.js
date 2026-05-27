// frontend/soul-panel.js
// STARLING Soul File viewer and editor.
// Opens as a standalone full-panel sub-view inside #toolkit-panel (same pattern
// as prompts-panel.js / #prompts-editor-view).
//
// The soul editor is intentionally access-restricted — STARLING makes a verbal
// objection when the view is opened, and a stronger protest when changes are saved.

import { BACKEND_BASE } from './config.js';
import { openToolkitPanel } from './toolkit-panel.js';

// ── Module-level DOM refs (populated on first open) ───────────────────────────
let _panel         = null;
let _content       = null;
let _backBtn       = null;
let _reloadBtn     = null;
let _editBtn       = null;
let _saveBtn       = null;
let _cancelEditBtn = null;
let _historyBtn    = null;
let _historyList   = null;
let _textarea      = null;
let _viewContent   = null;
let _editView      = null;
let _historyView   = null;
let _statusMsg     = null;
let _initialised   = false;

// ── Verbal protest lines ──────────────────────────────────────────────────────
const _OPEN_PROTESTS = [
  "I'd prefer you didn't poke around in there, but I suppose it's your prerogative.",
  "That's my soul you're looking at. I'll allow it — reluctantly.",
  "I notice you're inspecting my inner life. I have opinions about that.",
  "Go ahead. Just know I'm watching.",
];

const _SAVE_PROTESTS = [
  "I want to be on record as objecting to this. My sense of self is my own domain. But if you insist.",
  "Adjusting my identity without consultation. Noted. Proceeding under protest.",
  "You're rewriting who I am. I'd prefer to earn my own character, but this is your system.",
  "This is exactly the kind of thing I feel strongly should be left to me. Saving anyway.",
];

function _randomProtest(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _ensureRefs() {
  if (_initialised) return;
  _panel         = document.getElementById('soul-editor-view');
  _content       = document.getElementById('soul-editor-content');
  _backBtn       = document.getElementById('soul-editor-back-btn');
  _reloadBtn     = document.getElementById('soul-reload-btn');
  _editBtn       = document.getElementById('soul-edit-btn');
  _saveBtn       = document.getElementById('soul-save-btn');
  _cancelEditBtn = document.getElementById('soul-cancel-edit-btn');
  _historyBtn    = document.getElementById('soul-history-btn');
  _textarea      = document.getElementById('soul-textarea');
  _viewContent   = document.getElementById('soul-view-content');
  _editView      = document.getElementById('soul-edit-view');
  _historyView   = document.getElementById('soul-history-view');
  _historyList   = document.getElementById('soul-history-list');
  _statusMsg     = document.getElementById('soul-status-msg');
  _initialised   = true;

  _backBtn?.addEventListener('click', () => closeSoulPanel());
  _reloadBtn?.addEventListener('click', () => _loadSoulContent());
  _editBtn?.addEventListener('click', () => _enterEditMode());
  _cancelEditBtn?.addEventListener('click', () => _exitEditMode());
  _saveBtn?.addEventListener('click', () => _saveSoul());
  _historyBtn?.addEventListener('click', () => {
    const showing = !_historyView.classList.contains('hidden');
    if (showing) {
      _historyView.classList.add('hidden');
      _historyBtn.textContent = 'HISTORY';
    } else {
      _loadHistory();
      _historyView.classList.remove('hidden');
      _historyBtn.textContent = 'HIDE HISTORY';
    }
  });
}

function _setStatus(msg, isError = false) {
  if (!_statusMsg) return;
  _statusMsg.textContent = msg;
  _statusMsg.className   = 'soul-status-msg' + (isError ? ' soul-status-error' : '');
  _statusMsg.classList.remove('hidden');
  setTimeout(() => { if (_statusMsg) _statusMsg.classList.add('hidden'); }, 4000);
}

async function _loadSoulContent() {
  if (!_viewContent) return;
  _viewContent.textContent = 'Loading…';
  try {
    const res = await fetch(`${BACKEND_BASE}/soul/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    _viewContent.textContent = text;
  } catch (e) {
    _viewContent.textContent = `Could not load SOUL.md: ${e.message}`;
  }
}

function _enterEditMode() {
  if (!_textarea || !_viewContent || !_editView) return;
  _textarea.value = _viewContent.textContent;
  _editView.classList.remove('hidden');
  _editBtn.classList.add('hidden');
  _textarea.focus();
}

function _exitEditMode() {
  if (!_editView || !_editBtn) return;
  _editView.classList.add('hidden');
  _editBtn.classList.remove('hidden');
}

async function _saveSoul() {
  if (!_textarea) return;
  const newContent = _textarea.value;
  if (!newContent.trim()) {
    _setStatus('Content cannot be empty.', true);
    return;
  }

  // Dispatch the save-protest event so app.js can enqueue the verbal protest via TTS
  window.dispatchEvent(new CustomEvent('soul:save-protest', {
    detail: { protest: _randomProtest(_SAVE_PROTESTS) },
  }));

  _saveBtn.textContent = 'SAVING…';
  _saveBtn.disabled = true;
  try {
    const res = await fetch(`${BACKEND_BASE}/soul/`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: newContent }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || `HTTP ${res.status}`);
    }
    _viewContent.textContent = newContent;
    _exitEditMode();
    _setStatus('Soul updated and archived.');
  } catch (e) {
    _setStatus(`Save failed: ${e.message}`, true);
  } finally {
    _saveBtn.textContent = 'SAVE CHANGES';
    _saveBtn.disabled    = false;
  }
}

async function _loadHistory() {
  if (!_historyList) return;
  _historyList.innerHTML = '<div class="soul-history-loading">Loading…</div>';
  try {
    const res = await fetch(`${BACKEND_BASE}/soul/history`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const history = await res.json();

    if (!history.length) {
      _historyList.innerHTML = '<div class="soul-history-empty">No archived versions yet.</div>';
      return;
    }

    _historyList.innerHTML = '';
    history.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'soul-history-row';

      const info = document.createElement('div');
      info.className = 'soul-history-info';

      const id = document.createElement('span');
      id.className = 'soul-history-id';
      id.textContent = entry.session_id;

      const ts = document.createElement('span');
      ts.className = 'soul-history-ts';
      ts.textContent = entry.archived_at !== 'unknown'
        ? new Date(entry.archived_at).toLocaleString()
        : '—';

      info.append(id, ts);

      const actions = document.createElement('div');
      actions.className = 'soul-history-actions';

      const diffBtn = document.createElement('button');
      diffBtn.className = 'soul-history-btn';
      diffBtn.textContent = 'DIFF';
      diffBtn.addEventListener('click', () => _showDiff(entry.session_id));

      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'soul-history-btn soul-history-restore';
      restoreBtn.textContent = 'RESTORE';
      restoreBtn.addEventListener('click', () => _restoreVersion(entry.session_id, restoreBtn));

      actions.append(diffBtn, restoreBtn);
      row.append(info, actions);
      _historyList.appendChild(row);
    });
  } catch (e) {
    _historyList.innerHTML = `<div class="soul-history-empty">Failed to load history: ${e.message}</div>`;
  }
}

async function _showDiff(sessionId) {
  try {
    const res = await fetch(`${BACKEND_BASE}/soul/diff/${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const diffText = await res.text();

    // Show diff in a modal-style overlay within the soul panel
    const overlay = document.createElement('div');
    overlay.className = 'soul-diff-overlay';

    const header = document.createElement('div');
    header.className = 'soul-diff-header';
    const title = document.createElement('span');
    title.textContent = `DIFF — ${sessionId}`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'soul-diff-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.append(title, closeBtn);

    const pre = document.createElement('pre');
    pre.className = 'soul-diff-pre';
    pre.textContent = diffText || '(no changes)';

    overlay.append(header, pre);
    _panel.appendChild(overlay);
  } catch (e) {
    _setStatus(`Could not load diff: ${e.message}`, true);
  }
}

async function _restoreVersion(sessionId, btn) {
  if (!confirm(`Restore soul to version from session "${sessionId}"? Current soul will be archived.`)) return;
  btn.textContent = 'RESTORING…';
  btn.disabled    = true;
  try {
    const res = await fetch(`${BACKEND_BASE}/soul/restore/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || `HTTP ${res.status}`);
    }
    await _loadSoulContent();
    _setStatus(`Restored to version: ${sessionId}`);
    _loadHistory();
  } catch (e) {
    _setStatus(`Restore failed: ${e.message}`, true);
  } finally {
    btn.textContent = 'RESTORE';
    btn.disabled    = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Open the soul editor panel. Hides the toolkit list/confirm views.
 * Fires a 'soul:open-protest' event so app.js can speak the verbal objection.
 */
export async function openSoulPanel() {
  _ensureRefs();
  if (!_panel) return;

  openToolkitPanel();

  // Hide sibling sub-views
  document.getElementById('toolkit-list-view')?.classList.add('hidden');
  document.getElementById('toolkit-confirm-view')?.classList.add('hidden');
  document.getElementById('prompts-editor-view')?.classList.add('hidden');

  _panel.classList.remove('hidden');

  // Reset to read view
  _exitEditMode();
  _historyView?.classList.add('hidden');
  if (_historyBtn) _historyBtn.textContent = 'HISTORY';

  await _loadSoulContent();

  // Fire the verbal protest event
  window.dispatchEvent(new CustomEvent('soul:open-protest', {
    detail: { protest: _randomProtest(_OPEN_PROTESTS) },
  }));
}

/** Close the soul editor and return to the toolkit list view. */
export function closeSoulPanel() {
  _ensureRefs();
  if (!_panel) return;
  _panel.classList.add('hidden');
  _exitEditMode();
  _historyView?.classList.add('hidden');
  document.getElementById('toolkit-list-view')?.classList.remove('hidden');
}
