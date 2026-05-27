// frontend/ideas-panel.js
// Ideas tracker: trigger detection, single-press capture mode, save, list, search.

import { BACKEND_BASE } from './config.js';
import { getPrompt } from './prompts.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const ideasPanel        = document.getElementById('ideas-panel');
const ideasCaptureView  = document.getElementById('ideas-capture-view');
const ideasListView     = document.getElementById('ideas-list-view');
const ideasWaitingLabel = document.getElementById('ideas-waiting-label');
const ideasCancelBtn    = document.getElementById('ideas-cancel-btn');
const ideasCloseBtn     = document.getElementById('ideas-close-btn');
const ideasListEl       = document.getElementById('ideas-list');
const ideasListTitle    = document.getElementById('ideas-list-title');
const ideasCount        = document.getElementById('ideas-count');

// ── Mode state — exported so app.js can check it ──────────────────────────────
export let ideasMode = false;   // true while waiting for the next mic press = the idea

// ── Internal state ────────────────────────────────────────────────────────────
let _capturedAt = null;   // ISO timestamp set when capture mode opens

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Detect an idea capture trigger.
 * Returns 'capture' if the user wants to store a new idea, or null.
 *
 * All patterns require the word "vault" to prevent accidental triggers.
 *
 * Activation phrases:
 *   "store idea into the vault", "store an idea in the vault",
 *   "save to the ideas vault", "add to the ideas vault",
 *   "capture for the ideas vault", "log an idea to the vault"
 */
export function detectIdeaCaptureTrigger(transcript) {
  const t = transcript.trim().toLowerCase();
  if (!/\bvault\b/.test(t) || !/\bideas?\b/.test(t)) return null;
  // Verb + vault — captures any action-word phrase that ends at "vault"
  return /\b(?:store|save|add|log|capture|record|note)\b.{0,35}\bvault\b/.test(t)
    ? 'capture' : null;
}

/**
 * Detect an idea read-back or management trigger.
 *
 * All patterns require the word "vault" to prevent accidental triggers.
 *
 * Activation phrases:
 *   "open ideas vault", "show the vault", "what's in the vault",
 *   "search the ideas vault for [topic]", "search the vault for [topic]",
 *   "discard the last idea from the vault",
 *   "clear the vault", "empty the vault"
 *
 * Returns an object like { action: 'list' } | { action: 'search', query: '...' }
 *   | { action: 'discard_last' } | { action: 'clear_all' } | null
 */
export function detectIdeaReadTrigger(transcript) {
  const t = transcript.trim().toLowerCase();
  if (!/\bvault\b/.test(t) || !/\bideas?\b/.test(t)) return null;

  // Discard last — "discard the last idea from the vault"
  if (/\b(?:discard|delete|remove)\b.{0,25}\b(?:last|latest|recent)\b.{0,15}\bidea\b/.test(t)) {
    return { action: 'discard_last' };
  }

  // Clear all — "clear the vault", "empty the vault", "delete all ideas from the vault"
  if (/\b(?:clear|empty|wipe)\b.{0,25}\bvault\b/.test(t) ||
      /\b(?:delete|remove)\s+all\b.{0,25}\bvault\b/.test(t)) {
    return { action: 'clear_all' };
  }

  // Search — "search the ideas vault for X", "search the vault for X",
  //           "find machine learning in the vault"
  const searchMatch =
    t.match(/\b(?:search|find|look\s+(?:for|up))\b.{0,20}\bvault\b.{0,10}(?:for|about|on)\s+(.+)/) ||
    t.match(/\b(?:search|find|look\s+(?:for|up))\b.{0,10}(?:for|about)\s+(.+?)\s+in(?:\s+the)?\s+(?:ideas?\s+)?vault\b/);
  if (searchMatch) return { action: 'search', query: searchMatch[1].trim() };

  // List / open — "open ideas vault", "show the vault", "what's in the vault"
  const listPatterns = [
    /\b(?:open|show|list|display|view|read)\b.{0,15}\b(?:ideas?\s+)?vault\b/,
    /\bwhat(?:'s|\s+is)\b.{0,20}\b(?:in\s+the\s+)?(?:ideas?\s+)?vault\b/,
    /\bideas?\s+vault\b/,
  ];
  if (listPatterns.some(p => p.test(t))) return { action: 'list' };

  return null;
}

// ── Capture mode ──────────────────────────────────────────────────────────────

/**
 * Enter ideas capture mode.
 * The NEXT single mic press will be treated as the idea text.
 */
export function enterIdeasMode() {
  ideasMode   = true;
  _capturedAt = new Date().toISOString();

  _showView('capture');
  ideasWaitingLabel.textContent = 'WAITING FOR INPUT';
  ideasPanel.classList.remove('hidden');
  ideasPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById('starling')?.classList.add('ideas-mode');
}

export function exitIdeasMode() {
  ideasMode = false;
  ideasPanel.classList.add('hidden');
  document.getElementById('starling')?.classList.remove('ideas-mode');
}

// ── Process captured idea ─────────────────────────────────────────────────────

/**
 * Called from app.js once the single-press transcript is available.
 * Sends the idea text to the LLM for title + tag generation, then saves it.
 * Returns { spoken } — the confirmation phrase for TTS.
 *
 * @param {string}   transcript      — raw STT output
 * @param {Function} sendToOllamaFn  — app.js sendToOllama reference
 * @param {string}   systemPrompt    — SYSTEM_PROMPT constant from app.js
 */
export async function processIdea(transcript, sendToOllamaFn, systemPrompt) {
  exitIdeasMode();   // close capture panel immediately so UI feels responsive

  const rawText = transcript.trim();
  if (!rawText) return { spoken: 'No idea text captured. Please try again.' };

  // LLM call — generate a short title and tags in one request (ephemeral, no history)
  const prompt = getPrompt('IDEAS_TITLE_TAGS', { raw_text: rawText });

  let title = rawText.slice(0, 60);   // fallback: truncated raw text
  let tags  = [];

  try {
    const response = await sendToOllamaFn(prompt, {
      ephemeralMessages: [{ role: 'system', content: systemPrompt }],
    }) ?? '';

    const titleMatch = response.match(/TITLE:\s*(.+)/i);
    const tagsMatch  = response.match(/TAGS?:\s*(.+)/i);
    if (titleMatch) title = titleMatch[1].trim().replace(/^["']|["']$/g, '');
    if (tagsMatch)  tags  = tagsMatch[1].split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  } catch { /* fallback title already set */ }

  // Save to backend
  try {
    const res = await fetch(`${BACKEND_BASE}/ideas/add`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_text:   rawText,
        title,
        tags,
        created_at: _capturedAt,
      }),
    });
    if (!res.ok) throw new Error(`Save failed: ${res.status}`);
  } catch (err) {
    console.error('[ideas] save failed:', err);
    return { spoken: 'Could not save the idea. Please try again.' };
  }

  return { spoken: `Idea stored: ${title}.` };
}

// ── Read-back / management ────────────────────────────────────────────────────

/**
 * Called from app.js when a read/search/discard/clear trigger is detected.
 * Returns { spoken, llmContext }:
 *   spoken:     ready-made TTS string (used when LLM read-back is not needed)
 *   llmContext: text block to inject into an ephemeral LLM call (null = use spoken)
 */
export async function handleIdeaRead(trigger, sendToOllamaFn, systemPrompt) {
  if (trigger.action === 'discard_last') {
    try {
      const res  = await fetch(`${BACKEND_BASE}/ideas?limit=1`);
      const data = await res.json();
      const last = data.ideas?.[0];
      if (last) {
        await fetch(`${BACKEND_BASE}/ideas/${last.id}`, { method: 'DELETE' });
        return { spoken: `Last idea discarded: ${last.title}.`, llmContext: null };
      }
    } catch { /* ignore */ }
    return { spoken: 'No ideas to discard.', llmContext: null };
  }

  if (trigger.action === 'clear_all') {
    try {
      await fetch(`${BACKEND_BASE}/ideas`, { method: 'DELETE' });
    } catch { /* ignore */ }
    return { spoken: 'All ideas cleared.', llmContext: null };
  }

  let ideas = [];
  let titleLabel = 'MY IDEAS';

  if (trigger.action === 'search') {
    try {
      const res  = await fetch(`${BACKEND_BASE}/ideas/search?q=${encodeURIComponent(trigger.query)}&limit=20`);
      const data = await res.json();
      ideas      = data.results ?? [];
      titleLabel = `SEARCH: ${trigger.query.toUpperCase()}`;
    } catch { /* ignore */ }
  } else {
    // list
    try {
      const res  = await fetch(`${BACKEND_BASE}/ideas?limit=50`);
      const data = await res.json();
      ideas      = data.ideas ?? [];
    } catch { /* ignore */ }
  }

  // Render list view in the panel
  _renderIdeasList(ideas, titleLabel);
  ideasPanel.classList.remove('hidden');
  ideasPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if (!ideas.length) {
    return {
      spoken: trigger.action === 'search'
        ? `No ideas found matching "${trigger.query}".`
        : 'You have no stored ideas yet.',
      llmContext: null,
    };
  }

  // Build LLM context — titles + tags (first 20 ideas for TTS brevity)
  const ideasText = ideas.slice(0, 20).map((idea, i) =>
    `${i + 1}. ${idea.title}${idea.tags?.length ? ` [${idea.tags.join(', ')}]` : ''}`
  ).join('\n');

  const llmContext = `[IDEAS LIST — ${ideas.length} total]\n${ideasText}`;
  return { spoken: null, llmContext };   // null spoken → use LLM read-back path
}

function _renderIdeasList(ideas, title) {
  _showView('list');
  ideasListTitle.textContent = title;
  ideasCount.textContent = `${ideas.length} IDEA${ideas.length !== 1 ? 'S' : ''}`;
  ideasListEl.innerHTML = '';

  if (!ideas.length) {
    ideasListEl.innerHTML =
      '<div style="font-size:0.7rem;color:#444;padding:4px 0;">No ideas found.</div>';
    return;
  }

  ideas.forEach((idea, i) => {
    const card     = document.createElement('div');
    card.className = 'idea-card';

    const dateStr = new Date(idea.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
    });

    card.innerHTML = `
      <div class="idea-index">${String(i + 1).padStart(2, '0')}</div>
      <div class="idea-body">
        <div class="idea-title">${_esc(idea.title)}</div>
        <div class="idea-meta">
          <span class="idea-date">${_esc(dateStr)}</span>
          ${(idea.tags || []).map(t => `<span class="idea-tag">${_esc(t)}</span>`).join('')}
        </div>
      </div>
      <button class="idea-delete-btn" data-id="${_esc(idea.id)}" title="Discard this idea">✕</button>
    `;

    // Per-card delete
    card.querySelector('.idea-delete-btn').addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      await fetch(`${BACKEND_BASE}/ideas/${id}`, { method: 'DELETE' }).catch(() => {});
      card.remove();
      const remaining = ideasListEl.querySelectorAll('.idea-card').length;
      ideasCount.textContent = `${remaining} IDEA${remaining !== 1 ? 'S' : ''}`;
      // Re-number remaining cards
      ideasListEl.querySelectorAll('.idea-index').forEach((el, idx) => {
        el.textContent = String(idx + 1).padStart(2, '0');
      });
    });

    ideasListEl.appendChild(card);
  });
}

// ── Button wiring ─────────────────────────────────────────────────────────────
ideasCancelBtn?.addEventListener('click', exitIdeasMode);
ideasCloseBtn?.addEventListener('click',  () => ideasPanel.classList.add('hidden'));

// ── Helpers ───────────────────────────────────────────────────────────────────

function _showView(which) {
  ideasCaptureView.classList.toggle('hidden', which !== 'capture');
  ideasListView.classList.toggle('hidden',    which !== 'list');
}

function _esc(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
