// frontend/toolkit-panel.js
// Self-contained toolkit menu panel.
// Communicates with app.js exclusively through CustomEvents dispatched on window.
// Only dependency: shared HTML-escape helper from utils.js.

import { escapeHtml } from './utils.js';

// ── Module-level DOM refs ──────────────────────────────────────────────────────
const _panel           = document.getElementById('toolkit-panel');
const _listView        = document.getElementById('toolkit-list-view');
const _confirmView     = document.getElementById('toolkit-confirm-view');
const _confirmToolName = document.getElementById('toolkit-confirm-tool-name');
const _confirmResponse = document.getElementById('toolkit-confirm-response');
const _yesBtn          = document.getElementById('toolkit-btn-yes');
const _noBtn           = document.getElementById('toolkit-btn-no');
const _closeBtn        = document.getElementById('toolkit-close-btn');
const _cardContainer   = document.getElementById('toolkit-cards');

// ── Module-level state ────────────────────────────────────────────────────────
let _registry = [];
let _resetDetail = null;  // set by initToolkitPanel; called when panel closes

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the toolkit panel with a registry of tool entries.
 * Each entry shape: { id, name, description, phrases, openFn }
 * Called once at startup by app.js after DOM is ready.
 */
export function initToolkitPanel(registry) {
  _registry = registry;
  _cardContainer.innerHTML = '';

  // ── Picker: single dropdown listing all tool names ────────────────────────
  const picker = document.createElement('div');
  picker.className = 'toolkit-picker';

  const pickerSelected = document.createElement('div');
  pickerSelected.className = 'toolkit-picker-selected';

  const pickerLabel = document.createElement('span');
  pickerLabel.className = 'toolkit-picker-label';
  pickerLabel.textContent = 'SELECT A TOOL';

  const pickerChevron = document.createElement('span');
  pickerChevron.className = 'toolkit-picker-chevron';
  pickerChevron.textContent = '\u25be';  // ▾

  pickerSelected.append(pickerLabel, pickerChevron);

  const dropdown = document.createElement('div');
  dropdown.className = 'toolkit-picker-dropdown hidden';

  registry.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'toolkit-picker-item';
    item.textContent = entry.name.toUpperCase();
    item.dataset.toolId = entry.id;
    item.addEventListener('click', e => {
      e.stopPropagation();
      dropdown.querySelectorAll('.toolkit-picker-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      pickerLabel.textContent = entry.name.toUpperCase();
      dropdown.classList.add('hidden');
      _populateDetail(entry);
      detail.classList.remove('hidden');
      window.dispatchEvent(new CustomEvent('toolkit:tool-selected', { detail: entry }));
    });
    dropdown.appendChild(item);
  });

  pickerSelected.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
    detail.classList.add('hidden');  // hide detail when re-opening the list
  });

  picker.append(pickerSelected, dropdown);

  // Close dropdown when clicking anywhere outside.
  document.addEventListener('click', () => dropdown.classList.add('hidden'));

  // ── Detail view: shown below picker when a tool is selected ───────────────
  const detail = document.createElement('div');
  detail.className = 'toolkit-detail hidden';

  const detailName   = document.createElement('div');
  detailName.className = 'toolkit-detail-name';

  const detailDesc   = document.createElement('p');
  detailDesc.className = 'toolkit-detail-desc';

  const detailPhrases = document.createElement('div');
  detailPhrases.className = 'toolkit-detail-phrases';

  const detailExtra = document.createElement('div');
  detailExtra.className = 'toolkit-detail-extra';

  const detailActions = document.createElement('div');
  detailActions.className = 'toolkit-detail-actions';

  const activateBtn = document.createElement('button');
  activateBtn.className = 'toolkit-activate-btn';
  activateBtn.textContent = 'ACTIVATE';

  const backBtn = document.createElement('button');
  backBtn.className = 'toolkit-back-btn';
  backBtn.textContent = '\u2190 BACK';  // ← BACK
  backBtn.addEventListener('click', e => {
    e.stopPropagation();
    detail.classList.add('hidden');
  });

  detailActions.append(activateBtn, backBtn);
  detail.append(detailName, detailDesc, detailPhrases, detailExtra, detailActions);
  _cardContainer.append(picker, detail);

  function _populateDetail(entry) {
    detailName.textContent  = entry.name.toUpperCase();
    detailDesc.textContent  = entry.description;
    detailPhrases.innerHTML = '';
    entry.phrases.forEach(p => {
      const tag = document.createElement('code');
      tag.className   = 'toolkit-phrase';
      tag.textContent = escapeHtml(p);
      detailPhrases.appendChild(tag);
    });
    detailExtra.innerHTML = '';
    if (typeof entry.renderExtraFn === 'function') {
      entry.renderExtraFn(detailExtra);
    }
    activateBtn.onclick = e => {
      e.stopPropagation();
      closeToolkitPanel();
      entry.openFn();
    };
  }

  // Expose reset so closeToolkitPanel can restore the picker to its default state.
  _resetDetail = () => {
    detail.classList.add('hidden');
    dropdown.classList.add('hidden');
    pickerLabel.textContent = 'SELECT A TOOL';
    dropdown.querySelectorAll('.toolkit-picker-item').forEach(el => el.classList.remove('active'));
  };

  // Wire close button.
  _closeBtn && _closeBtn.addEventListener('click', () => closeToolkitPanel());

  // Wire YES / NO buttons (retained for voice-command confirm flow).
  _yesBtn && _yesBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('toolkit:confirm', { detail: { confirmed: true } }));
  });
  _noBtn && _noBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('toolkit:confirm', { detail: { confirmed: false } }));
  });
}

/** Show the toolkit panel overlay. */
export function openToolkitPanel() {
  _panel && _panel.classList.remove('hidden');
}

/** Hide the toolkit panel overlay and reset to list view. */
export function closeToolkitPanel() {
  if (_resetDetail) _resetDetail();
  showToolkitListView();
  _panel && _panel.classList.add('hidden');
}

/** Returns true if the toolkit panel is currently visible. */
export function isToolkitPanelOpen() {
  return _panel ? !_panel.classList.contains('hidden') : false;
}

/**
 * Switch to the confirm sub-view and populate the tool name label.
 * Hides the card list; shows the YES/NO confirmation row.
 */
export function showToolkitConfirmView(toolName) {
  if (_confirmToolName) _confirmToolName.textContent = toolName;
  if (_confirmResponse) _confirmResponse.textContent = '';
  _listView    && _listView.classList.add('hidden');
  _confirmView && _confirmView.classList.remove('hidden');
}

/**
 * Switch back to the list sub-view.
 * Called by closeToolkitPanel() and _clearToolkitConfirmState() in app.js.
 */
export function showToolkitListView() {
  _confirmView && _confirmView.classList.add('hidden');
  _listView    && _listView.classList.remove('hidden');
}

// ── Internal helpers ──────────────────────────────────────────────────────────

