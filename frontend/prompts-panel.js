// frontend/prompts-panel.js
// Prompt Registry editor — sub-view rendered inside #toolkit-panel.
//
// Opens when the user clicks "OPEN EDITOR" in the PROMPT REGISTRY menu section
// or triggers the voice command "open prompt editor".
//
// Requires the #prompts-editor-view element in index.html (inside #toolkit-panel).

import { BACKEND_BASE } from './config.js';
import { escapeHtml } from './utils.js';
import { setPrompt, resetPrompt } from './prompts.js';
import { openToolkitPanel, showToolkitListView } from './toolkit-panel.js';

// ── DOM refs (populated on first open) ───────────────────────────────────────
let _editorView    = null;
let _editorContent = null;
let _backBtn       = null;
let _reloadBtn     = null;
let _initialised   = false;

// ── Risk level config ─────────────────────────────────────────────────────────
const _RISK_CONFIG = {
  critical: {
    label:   'SYSTEM-CRITICAL',
    message: 'This prompt is injected into every LLM request or defines core identity. ' +
             'Incorrect edits can break all responses. Edit with extreme caution.',
    cls:     'prompt-warn-critical',
  },
  caution: {
    label:   'CAUTION',
    message: 'This prompt affects a key pipeline stage. Changes may alter structured output ' +
             'parsing. Review the pipeline note before saving.',
    cls:     'prompt-warn-caution',
  },
  safe: null,
};

// ── Category order ────────────────────────────────────────────────────────────
const _CATEGORY_ORDER = ['starling', 'wiki', 'journal', 'ideas', 'browser', 'dossier', 'tool', 'dream'];
const _CATEGORY_LABELS = {
  starling: 'STARLING IDENTITY',
  wiki:     'WIKIPEDIA',
  journal:  'JOURNAL',
  ideas:    'IDEAS VAULT',
  browser:  'BROWSER',
  dossier:  'DOSSIER',
  tool:     'TOOL STATUS',
  dream:    'DREAM STATE',
};

// ── Public API ────────────────────────────────────────────────────────────────

/** Open the prompt editor sub-view. Fetches fresh catalog each time. */
export async function openPromptsPanel() {
  _ensureRefs();
  openToolkitPanel();

  // Hide list view and confirm view; show editor view.
  const listView = document.getElementById('toolkit-list-view');
  const confirmView = document.getElementById('toolkit-confirm-view');
  listView    && listView.classList.add('hidden');
  confirmView && confirmView.classList.add('hidden');
  _editorView.classList.remove('hidden');

  _editorContent.innerHTML = '<div class="prompts-loading">Loading prompt registry\u2026</div>';

  try {
    const res = await fetch(`${BACKEND_BASE}/prompts/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = await res.json();
    _render(catalog);
  } catch (err) {
    _editorContent.innerHTML =
      `<div class="prompts-error">Failed to load prompts: ${escapeHtml(err.message)}</div>`;
  }
}

/** Close the prompt editor sub-view and return to the list view. */
export function closePromptsPanel() {
  _ensureRefs();
  _editorView.classList.add('hidden');
  showToolkitListView();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function _render(catalog) {
  _editorContent.innerHTML = '';

  // Group by category preserving order.
  const grouped = new Map();
  for (const cat of _CATEGORY_ORDER) grouped.set(cat, []);
  for (const entry of catalog) {
    const cat = entry.category ?? 'tool';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(entry);
  }

  for (const [cat, entries] of grouped) {
    if (!entries.length) continue;

    const section = document.createElement('div');
    section.className = 'prompts-category-section';

    const label = document.createElement('div');
    label.className   = 'prompts-category-label';
    label.textContent = _CATEGORY_LABELS[cat] ?? cat.toUpperCase();
    section.appendChild(label);

    for (const entry of entries) {
      section.appendChild(_buildCard(entry));
    }
    _editorContent.appendChild(section);
  }
}

function _buildCard(entry) {
  const card = document.createElement('div');
  card.className = 'prompt-card';
  card.dataset.key = entry.key;

  // ── Header ────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'prompt-card-header';

  const keyEl = document.createElement('span');
  keyEl.className   = 'prompt-card-key';
  keyEl.textContent = entry.key;

  const badges = document.createElement('div');
  badges.className = 'prompt-card-badges';

  const catBadge = document.createElement('span');
  catBadge.className   = 'prompt-card-category';
  catBadge.textContent = entry.category.toUpperCase();
  badges.appendChild(catBadge);

  if (entry.is_overridden) {
    const dot = document.createElement('span');
    dot.className   = 'prompt-card-override-dot';
    dot.title       = 'Custom override active';
    dot.textContent = '\u25cf OVERRIDDEN';
    badges.appendChild(dot);
  }

  header.append(keyEl, badges);
  card.appendChild(header);

  // ── Risk warning ──────────────────────────────────────────────────────────
  const riskCfg = _RISK_CONFIG[entry.risk_level];
  if (riskCfg) {
    const warn = document.createElement('div');
    warn.className = `prompt-card-warning ${riskCfg.cls}`;
    warn.innerHTML = `<strong>${escapeHtml(riskCfg.label)}:</strong> ${escapeHtml(riskCfg.message)}`;
    card.appendChild(warn);
  }

  // ── Description ───────────────────────────────────────────────────────────
  const desc = document.createElement('p');
  desc.className   = 'prompt-card-desc';
  desc.textContent = entry.description;
  card.appendChild(desc);

  // ── Pipeline note ─────────────────────────────────────────────────────────
  if (entry.pipeline_note) {
    const pipeline = document.createElement('div');
    pipeline.className = 'prompt-card-pipeline';

    const pipeLabel = document.createElement('span');
    pipeLabel.className   = 'prompt-card-pipeline-label';
    pipeLabel.textContent = 'Pipeline:';

    const pipeText = document.createElement('span');
    pipeText.textContent = entry.pipeline_note;

    pipeline.append(pipeLabel, pipeText);
    card.appendChild(pipeline);
  }

  // ── Template variables ────────────────────────────────────────────────────
  if (entry.template_vars && entry.template_vars.length) {
    const varsEl = document.createElement('div');
    varsEl.className = 'prompt-card-vars';

    const varsLabel = document.createElement('span');
    varsLabel.className   = 'prompt-card-vars-label';
    varsLabel.textContent = 'Template variables:';
    varsEl.appendChild(varsLabel);

    const pillRow = document.createElement('div');
    pillRow.className = 'prompt-card-var-pills';

    for (const v of entry.template_vars) {
      const pill = document.createElement('code');
      pill.className   = 'prompt-var-pill';
      pill.textContent = `{${v}}`;
      pill.title       = _varGuide(entry.key, v);
      pillRow.appendChild(pill);
    }
    varsEl.appendChild(pillRow);
    card.appendChild(varsEl);
  }

  // ── Source file ───────────────────────────────────────────────────────────
  if (entry.source_file) {
    const src = document.createElement('div');
    src.className   = 'prompt-card-source';
    src.textContent = `Source: ${entry.source_file}`;
    card.appendChild(src);
  }

  // ── Textarea ──────────────────────────────────────────────────────────────
  const textarea = document.createElement('textarea');
  textarea.className   = 'prompt-card-textarea';
  textarea.value       = entry.current_value;
  textarea.spellcheck  = false;
  textarea.rows        = Math.min(20, Math.max(4, entry.current_value.split('\n').length + 2));
  card.appendChild(textarea);

  // ── Actions ───────────────────────────────────────────────────────────────
  const actions = document.createElement('div');
  actions.className = 'prompt-card-actions';

  const status = document.createElement('span');
  status.className = 'prompt-card-status';

  const saveBtn = document.createElement('button');
  saveBtn.className   = 'prompt-card-save-btn';
  saveBtn.textContent = 'SAVE';
  saveBtn.addEventListener('click', async () => {
    const newVal = textarea.value;
    saveBtn.disabled = true;
    status.textContent = 'Saving\u2026';
    try {
      await setPrompt(entry.key, newVal);
      status.textContent = '\u2713 Saved';
      status.className   = 'prompt-card-status prompt-card-status--ok';
      // Update override dot
      const existingDot = card.querySelector('.prompt-card-override-dot');
      if (!existingDot) {
        const dot = document.createElement('span');
        dot.className   = 'prompt-card-override-dot';
        dot.title       = 'Custom override active';
        dot.textContent = '\u25cf OVERRIDDEN';
        card.querySelector('.prompt-card-badges').appendChild(dot);
      }
      entry.is_overridden = true;
    } catch (err) {
      status.textContent = `\u2717 ${err.message}`;
      status.className   = 'prompt-card-status prompt-card-status--err';
    }
    saveBtn.disabled = false;
    setTimeout(() => { status.textContent = ''; status.className = 'prompt-card-status'; }, 4000);
  });

  const resetBtn = document.createElement('button');
  resetBtn.className   = 'prompt-card-reset-btn';
  resetBtn.textContent = 'RESET TO DEFAULT';
  resetBtn.addEventListener('click', async () => {
    if (!confirm(`Reset "${entry.key}" to its default value?`)) return;
    resetBtn.disabled = true;
    status.textContent = 'Resetting\u2026';
    try {
      const updated = await resetPrompt(entry.key);
      textarea.value = updated.current_value;
      textarea.rows  = Math.min(20, Math.max(4, updated.current_value.split('\n').length + 2));
      status.textContent = '\u2713 Reset to default';
      status.className   = 'prompt-card-status prompt-card-status--ok';
      const dot = card.querySelector('.prompt-card-override-dot');
      if (dot) dot.remove();
      entry.is_overridden = false;
    } catch (err) {
      status.textContent = `\u2717 ${err.message}`;
      status.className   = 'prompt-card-status prompt-card-status--err';
    }
    resetBtn.disabled = false;
    setTimeout(() => { status.textContent = ''; status.className = 'prompt-card-status'; }, 4000);
  });

  actions.append(saveBtn, resetBtn, status);
  card.appendChild(actions);

  return card;
}

// ── Live variable guide ───────────────────────────────────────────────────────

const _VAR_GUIDES = {
  whisper_device: 'Hardware device running Whisper STT — auto-detected at startup (e.g. "CUDA" or "CPU")',
  kokoro_device:  'Hardware device running Kokoro TTS — auto-detected at startup (e.g. "CUDA" or "CPU")',
  llm_device:     'Hardware device running the LLM — auto-detected at startup (e.g. "CUDA" or "CPU")',
  title:          'Wikipedia article title — filled automatically from the open article',
  excerpts:       'Wikipedia article text excerpts — filled automatically from the ChromaDB retrieval',
  section_name:   'Section name the user requested — filled from the voice transcript',
  available_sections_hint: 'Optional sentence listing available sections, or empty string',
  date_line:      'Today\'s date in human-readable form — filled at journal submit time',
  time_line:      'Current time — filled at journal submit time',
  raw_transcript: 'The user\'s full dictated journal text — filled from the transcript',
  question_number:'Current interview question number (1-based integer as string)',
  max_questions:  'Maximum number of interview questions allowed (from MAX_INTERVIEW_QUESTIONS constant)',
  min_questions_reached_instruction: 'Empty string until minimum questions reached; then the DONE-exit instruction',
  raw_text:       'The user\'s full dictated idea text — filled from the transcript',
  page_label:     'Human-readable page name shown in the browser panel (e.g. "Google" or "bbc.co.uk")',
  page_text:      'Full extracted text content of the open browser page',
  url:            'Full URL of the open browser page',
};

function _varGuide(key, varName) {
  return _VAR_GUIDES[varName] ?? `Template variable used in ${key}`;
}

// ── Initialisation ────────────────────────────────────────────────────────────

function _ensureRefs() {
  if (_initialised) return;
  _editorView    = document.getElementById('prompts-editor-view');
  _editorContent = document.getElementById('prompts-editor-content');
  _backBtn       = document.getElementById('prompts-editor-back-btn');
  _reloadBtn     = document.getElementById('prompts-reload-btn');

  _backBtn  && _backBtn.addEventListener('click',  closePromptsPanel);
  _reloadBtn && _reloadBtn.addEventListener('click', _handleReload);
  _initialised = true;
}

async function _handleReload() {
  if (!_reloadBtn) return;
  _reloadBtn.disabled    = true;
  _reloadBtn.textContent = 'Reloading\u2026';
  try {
    const res = await fetch(`${BACKEND_BASE}/prompts/reload`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _reloadBtn.textContent = `\u2713 Loaded ${data.overrides_loaded} override${data.overrides_loaded !== 1 ? 's' : ''}`;
    setTimeout(() => { _reloadBtn.textContent = 'RELOAD FROM DISK'; _reloadBtn.disabled = false; }, 3000);
    // Refresh the panel content.
    await openPromptsPanel();
  } catch (err) {
    _reloadBtn.textContent = `\u2717 ${err.message}`;
    setTimeout(() => { _reloadBtn.textContent = 'RELOAD FROM DISK'; _reloadBtn.disabled = false; }, 3000);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
