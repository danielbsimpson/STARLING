// frontend/mail-panel.js
// Apple Mail inbox panel: trigger detection, IMAP fetch via backend, render, open/close.
// Follows the same module shape as calendar-panel.js.

import { BACKEND_BASE } from './config.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const mailPanel      = document.getElementById('mail-panel');
const mailCountBadge = document.getElementById('mail-count-badge');
const mailList       = document.getElementById('mail-list');
const mailCloseBtn   = document.getElementById('mail-close-btn');

// ── Close button ──────────────────────────────────────────────────────────────
mailCloseBtn?.addEventListener('click', closeMailPanel);

// ── Trigger detection ─────────────────────────────────────────────────────────
/**
 * Returns true if the transcript matches a mail inbox trigger phrase, else null.
 */
export function detectMailTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  const patterns = [
    /\b(?:check|view|show|open|read|pull up)\b.{0,20}\b(?:mail|email|emails?|inbox|messages?)\b/,
    /\b(?:any|got any|do i have)\s+(?:new\s+)?(?:emails?|mail|messages?|unread)\b/,
    /\bwhat(?:'s| is) in my\s+(?:inbox|mail|email)\b/,
    /\b(?:new\s+)?(?:emails?|mail|messages?)\s+(?:today|this morning|right now)\b/,
    /\b(?:unread|unopened)\s+(?:emails?|messages?|mail)\b/,
  ];

  return patterns.some(p => p.test(t)) ? true : null;
}

// ── Render ────────────────────────────────────────────────────────────────────
function _renderPanel(data) {
  if (mailCountBadge) mailCountBadge.textContent = data.unread_count;
  if (!mailList) return;

  mailList.innerHTML = '';

  if (!data.messages || data.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className   = 'mail-empty';
    empty.textContent = 'Inbox is empty.';
    mailList.appendChild(empty);
    return;
  }

  data.messages.forEach(msg => {
    const card = document.createElement('div');
    card.className = 'mail-card';

    const fromEl = document.createElement('div');
    fromEl.className   = 'mail-from';
    fromEl.textContent = msg.from_address;

    const subjectEl = document.createElement('div');
    subjectEl.className   = 'mail-subject';
    subjectEl.textContent = msg.subject || '(No subject)';

    card.append(fromEl, subjectEl);
    mailList.appendChild(card);
  });
}

// ── Panel open / close ────────────────────────────────────────────────────────

/**
 * Fetch mail data and open the panel.
 * Pass forceRefresh=true to bust the server-side cache first.
 * Returns the llm_context string, or null on failure.
 */
export async function openMailPanel(forceRefresh = false) {
  if (forceRefresh) {
    try {
      await fetch(`${BACKEND_BASE}/mail/cache`, { method: 'DELETE' });
    } catch (_) { /* ignore — cache bust is best-effort */ }
  }

  let data;
  try {
    const res = await fetch(`${BACKEND_BASE}/mail/unread`);
    if (!res.ok) throw new Error(`Mail API ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[mail-panel] fetch failed:', err);
    return null;
  }

  _renderPanel(data);
  mailPanel?.classList.remove('hidden');
  mailPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  return data.llm_context ?? null;
}

export function closeMailPanel() {
  mailPanel?.classList.add('hidden');
}

export function isMailPanelOpen() {
  return mailPanel ? !mailPanel.classList.contains('hidden') : false;
}
