// frontend/toolkit-panel.js
// Self-contained toolkit menu panel. Zero imports.
// Communicates with app.js exclusively through CustomEvents dispatched on window.

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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the toolkit panel with a registry of tool entries.
 * Each entry shape: { id, name, description, phrases, openFn }
 * Called once at startup by app.js after DOM is ready.
 */
export function initToolkitPanel(registry) {
  _registry = registry;

  // Render a card for each tool
  _cardContainer.innerHTML = '';
  for (const entry of _registry) {
    const card = document.createElement('div');
    card.className = 'toolkit-card';

    const phrases = entry.phrases
      .slice(0, 3)
      .map(p => `<code class="toolkit-phrase">${_escapeHtml(p)}</code>`)
      .join('');

    card.innerHTML =
      `<div class="toolkit-card-name">${_escapeHtml(entry.name.toUpperCase())}</div>` +
      `<div class="toolkit-card-desc">${_escapeHtml(entry.description)}</div>` +
      `<div class="toolkit-card-phrases">${phrases}</div>`;

    card.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('toolkit:tool-selected', { detail: entry }));
    });

    _cardContainer.appendChild(card);
  }

  // Wire close button
  _closeBtn && _closeBtn.addEventListener('click', () => closeToolkitPanel());

  // Wire YES / NO buttons
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

/** Minimal HTML escaping to prevent XSS when injecting registry strings. */
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
