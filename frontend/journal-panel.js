// frontend/journal-panel.js
// Voice journal: multi-segment dictation, silent LLM summarisation, save, read-back.
// app.js only calls the exported functions and checks the exported journalMode flag.

import { BACKEND_BASE } from './config.js';
import { escapeHtml } from './utils.js';
import { getPrompt } from './prompts.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const journalPanel        = document.getElementById('journal-panel');
const journalTimestamp    = document.getElementById('journal-timestamp');
const journalTranscript   = document.getElementById('journal-transcript');
const journalSegCount     = document.getElementById('journal-segment-count');
const journalSubmitBtn    = document.getElementById('journal-submit-btn');
const journalDiscardBtn   = document.getElementById('journal-discard-btn');
const journalSummaryEl    = document.getElementById('journal-summary');
const journalTagsRow      = document.getElementById('journal-tags-row');
const journalConfirmBtn   = document.getElementById('journal-confirm-btn');
const journalRerecordBtn  = document.getElementById('journal-rerecord-btn');
const journalDiscardBtn2  = document.getElementById('journal-discard-btn-2');
const journalEntriesList    = document.getElementById('journal-entries-list');
const journalEntriesTitle   = document.getElementById('journal-entries-title');
const journalEntriesClose   = document.getElementById('journal-entries-close');
const journalInterviewerBtn = document.getElementById('journal-interviewer-btn');

const vDictation = document.getElementById('journal-dictation-view');
const vReview    = document.getElementById('journal-review-view');
const vEntries   = document.getElementById('journal-entries-view');

// ── Mode state — exported as live binding so app.js reads the current value ───
export let journalMode   = false;  // true while dictation or interview is active
export let interviewMode = false;  // true while waiting for an interview answer

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_INTERVIEW_QUESTIONS = 8;
const MIN_INTERVIEW_QUESTIONS = 3;

// ── Internal state ────────────────────────────────────────────────────────────
let _segments         = [];    // transcript strings from each manual dictation press
let _startedAt        = null;  // ISO timestamp of when dictation began
let _pendingSave      = null;  // { summary, tags, rawTranscript } awaiting confirmation
let _interviewPairs   = [];    // [{ q, a }] completed Q&A pairs during interview mode
let _pendingQuestion  = null;  // current question waiting for user's spoken answer
let _interviewQACount = 0;     // number of completed Q&A pairs

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Detect a journal start trigger.
 * Activation phrases:
 *   "start journal entry", "new journal entry", "open journal",
 *   "add journal entry", "create journal entry", "journal entry",
 *   "begin journal", "start a new entry"
 */
export function detectJournalStartTrigger(transcript) {
  const t = transcript.trim().toLowerCase();
  const patterns = [
    /\b(?:start|begin|new|open|add|create)\b.{0,20}\bjournal\b/,
    /\bjournal\s+(?:entry|note|log)\b/,
    /\bstart\s+(?:a\s+)?(?:new\s+)?entry\b/,
  ];
  return patterns.some(p => p.test(t)) ? true : null;
}

/**
 * Detect a journal submit phrase (spoken while in dictation mode).
 * Activation phrases:
 *   "submit", "done", "finished", "save entry", "that's all",
 *   "submit entry", "save it", "end entry", "complete"
 */
export function detectJournalSubmit(transcript) {
  const t = transcript.trim().toLowerCase();
  const patterns = [
    /^\s*(?:submit|done|finished|complete|end entry|that(?:'s| is) all|submit entry|save entry|save it)\s*$/,
    /\b(?:submit|save)\s+(?:the\s+)?(?:entry|journal)\b/,
  ];
  return patterns.some(p => p.test(t)) ? true : null;
}

/**
 * Detect a journal read / retrieval trigger.
 * Activation phrases:
 *   "read my last journal entry", "show journal", "search journal for [topic]",
 *   "what did I write about [topic]", "show today's entries",
 *   "open journal entries", "journal history"
 *
 * Returns { action: 'search', query } | { action: 'today' } | { action: 'list' } | null
 */
export function detectJournalReadTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  // Search: "search journal for X", "find in journal for X"
  const searchMatch = t.match(/\b(?:search|find|look up|look for)\b.{0,15}\bjournal\b.{0,10}\bfor\s+(.+)/);
  if (searchMatch) return { action: 'search', query: searchMatch[1].trim() };

  // "what did I write / say / note about X"
  const writeMatch = t.match(/\bwhat\s+did\s+i\s+(?:write|say|note)\b.{0,20}\babout\s+(.+)/);
  if (writeMatch) return { action: 'search', query: writeMatch[1].trim() };

  // Today's entries
  if (/\btoday(?:'s)?\s+(?:journal\s+)?entries\b/.test(t) ||
      /\bwhat\s+(?:did\s+i\s+)?(?:write|log)\s+today\b/.test(t)) {
    return { action: 'today' };
  }

  // Generic list / read-back
  const listPatterns = [
    /\b(?:show|open|view|read|display)\b.{0,20}\b(?:my\s+)?journal\b/,
    /\b(?:read|show)\s+(?:my\s+)?(?:last|latest|recent)\s+journal\b/,
    /\bjournal\s+(?:entries|history|log)\b/,
  ];
  if (listPatterns.some(p => p.test(t))) return { action: 'list' };

  return null;
}

// ── Dictation mode ─────────────────────────────────────────────────────────────

/**
 * Enter journal dictation mode.
 * Resets all state, shows the dictation view, adds journal-mode class.
 */
export function enterJournalMode() {
  _segments         = [];
  _interviewPairs   = [];
  _pendingQuestion  = null;
  _interviewQACount = 0;
  interviewMode     = false;
  _startedAt        = new Date().toISOString();
  journalMode       = true;
  journalInterviewerBtn?.classList.remove('hidden');

  _showView('dictation');
  journalTranscript.innerHTML =
    '<span class="journal-placeholder">Start speaking — each mic press adds a segment. ' +
    'Or press INTERVIEWER to have the system ask you questions. ' +
    'Press SUBMIT or say "submit" when finished.</span>';
  journalSegCount.textContent = '0 segments';

  const local = new Date(_startedAt).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  journalTimestamp.textContent = local.toUpperCase();

  journalPanel.classList.remove('hidden');
  document.getElementById('starling')?.classList.add('journal-mode');
}

/**
 * Append a dictated segment to the running buffer (no audio feedback — visual only).
 * Called from app.js while journalMode is true and no submit phrase detected.
 */
export function appendJournalSegment(transcript) {
  _segments.push(transcript.trim());
  journalTranscript.innerHTML = '';
  _segments.forEach((seg, i) => {
    const line = document.createElement('div');
    line.style.cssText = 'margin-bottom:6px;';
    line.innerHTML =
      `<span style="color:#444;font-size:0.65em;margin-right:6px;">${String(i + 1).padStart(2, '0')}</span>` +
      `<span>${escapeHtml(seg)}</span>`;
    journalTranscript.appendChild(line);
  });
  journalTranscript.scrollTop = journalTranscript.scrollHeight;
  journalSegCount.textContent =
    `${_segments.length} segment${_segments.length !== 1 ? 's' : ''}`;
}

/** Returns true if there is any content (segments or interview pairs) ready to submit. */
export function journalHasSegments() {
  return _segments.length > 0 || _interviewPairs.length > 0;
}

// ── Interview mode ────────────────────────────────────────────────────────────

/**
 * Start the LLM-driven interview. Generates an opening question, speaks it aloud,
 * and sets interviewMode = true so subsequent mic presses are treated as answers.
 */
export async function enterInterviewMode(callLLMFn, speakFn, systemPrompt) {
  _interviewPairs   = [];
  _interviewQACount = 0;
  _pendingQuestion  = null;
  interviewMode     = true;
  journalInterviewerBtn?.classList.add('hidden');

  journalTranscript.innerHTML =
    '<span class="journal-placeholder">Interview mode — listen for each question, ' +
    'then press the mic button and speak your answer.</span>';
  journalSegCount.textContent = `0 of up to ${MAX_INTERVIEW_QUESTIONS} questions`;

  const question = await _generateNextQuestion(callLLMFn, systemPrompt);
  if (!question || !question.trim()) {
    interviewMode = false;
    journalInterviewerBtn?.classList.remove('hidden');
    return;
  }

  _pendingQuestion = question.trim();
  _renderInterviewTranscript();
  speakFn(_pendingQuestion, () => {});
}

/**
 * Handle a spoken answer during an active interview session.
 * Records the answer, generates the next question (or wraps up when done).
 */
export async function handleInterviewAnswer(text, callLLMFn, speakFn, systemPrompt) {
  if (!_pendingQuestion) return;

  _interviewPairs.push({ q: _pendingQuestion, a: text.trim() });
  _pendingQuestion  = null;
  _interviewQACount++;
  journalSegCount.textContent =
    `${_interviewQACount} of up to ${MAX_INTERVIEW_QUESTIONS} questions answered`;
  _renderInterviewTranscript();

  if (_interviewQACount >= MAX_INTERVIEW_QUESTIONS) {
    interviewMode = false;
    _renderInterviewTranscript(true);
    speakFn("That's all the questions. Say submit or press SUBMIT to save your entry.", () => {});
    return;
  }

  const nextQ = await _generateNextQuestion(callLLMFn, systemPrompt);
  if (!nextQ || !nextQ.trim() || nextQ.trim().toUpperCase() === 'DONE') {
    interviewMode = false;
    _renderInterviewTranscript(true);
    speakFn("That covers everything. Say submit or press SUBMIT when you're ready to save.", () => {});
    return;
  }

  _pendingQuestion = nextQ.trim();
  _renderInterviewTranscript();
  speakFn(_pendingQuestion, () => {});
}

// ── Submit ─────────────────────────────────────────────────────────────────────

/**
 * Submit the dictated transcript for LLM summarisation.
 * Uses a silent LLM call (no chat bubble created).
 *
 * @param {Function} callLLMFn   — async (prompt: string, systemMessages: Array) => string
 *                                 Silent, non-streaming LLM call provided by app.js.
 * @param {string}   systemPrompt
 * @returns {boolean} true if submitted, false if no segments.
 */
export async function submitJournalEntry(callLLMFn, systemPrompt) {
  if (!_segments.length && !_interviewPairs.length) return false;

  const rawTranscript = _interviewPairs.length > 0
    ? 'INTERVIEW SESSION:\n\n' + _interviewPairs.map((p, i) =>
        `Q${i + 1}: ${p.q}\nA: ${p.a}`
      ).join('\n\n')
    : _segments.join('\n\n');
  const now = new Date();
  const dateLine = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeLine = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  // Switch to review view and show in-progress state
  _showView('review');
  journalSummaryEl.textContent = 'Summarising…';
  journalTagsRow.innerHTML = '';

  const prompt = getPrompt('JOURNAL_SUMMARIZE', {
    date_line:      dateLine,
    time_line:      timeLine,
    raw_transcript: rawTranscript,
  });

  let summaryRaw = '';
  try {
    summaryRaw = await callLLMFn(prompt, [{ role: 'system', content: systemPrompt }]) ?? '';
  } catch { summaryRaw = ''; }

  // Parse summary and tags from the LLM response
  const tagLineMatch = summaryRaw.match(/TAGS?:\s*(.+)/i);
  const tags = tagLineMatch
    ? tagLineMatch[1].split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
    : [];
  const summary = summaryRaw.replace(/TAGS?:.*/is, '').trim();

  _pendingSave = { summary, tags, rawTranscript };

  // Render the review panel
  journalSummaryEl.textContent = summary ||
    '(No summary generated — the raw transcript will be saved.)';
  journalTagsRow.innerHTML = '';
  tags.forEach(tag => {
    const span = document.createElement('span');
    span.className   = 'journal-tag';
    span.textContent = tag;
    journalTagsRow.appendChild(span);
  });

  return true;
}

// ── Confirm ────────────────────────────────────────────────────────────────────

/**
 * Save the pending entry to the backend.
 * On success, switches to the entries view (shows the saved + recent entries).
 * Returns the saved entry object or null on failure.
 */
export async function confirmJournalEntry() {
  if (!_pendingSave) return null;
  const { summary, tags, rawTranscript } = _pendingSave;

  try {
    const res = await fetch(`${BACKEND_BASE}/journal/entry`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_transcript: rawTranscript,
        summary,
        tags,
        recorded_at: _startedAt,
      }),
    });
    if (!res.ok) throw new Error(`Save failed: ${res.status}`);
    const saved = await res.json();

    // Transition: dictation done, show entries list
    journalMode  = false;
    _pendingSave = null;
    await _loadAndShowEntries('RECENT ENTRIES');
    return saved;
  } catch (err) {
    console.error('[journal] save failed:', err);
    return null;
  }
}

// ── Re-record ──────────────────────────────────────────────────────────────────

/**
 * Discard the pending summary and restart dictation from scratch.
 */
export function rerecordJournalEntry() {
  _segments         = [];
  _interviewPairs   = [];
  _pendingQuestion  = null;
  _interviewQACount = 0;
  interviewMode     = false;
  _pendingSave      = null;
  journalMode       = true;
  journalInterviewerBtn?.classList.remove('hidden');
  _showView('dictation');
  journalTranscript.innerHTML =
    '<span class="journal-placeholder">Re-recording. Speak segments or use INTERVIEWER. Press SUBMIT when done.</span>';
  journalSegCount.textContent = '0 segments';
}

// ── Exit / discard ─────────────────────────────────────────────────────────────

/**
 * Fully exit journal mode: hides panel, resets all state, removes CSS class.
 */
export function exitJournalMode() {
  journalMode       = false;
  interviewMode     = false;
  _segments         = [];
  _interviewPairs   = [];
  _pendingQuestion  = null;
  _interviewQACount = 0;
  _pendingSave      = null;
  journalPanel.classList.add('hidden');
  document.getElementById('starling')?.classList.remove('journal-mode');
}

// ── Read-back / retrieval ──────────────────────────────────────────────────────

/**
 * Load journal entries matching the trigger and show the entries panel.
 * Returns an LLM context string for the spoken summary, or null on failure.
 *
 * @param {{ action: string, query?: string }} trigger
 */
export async function handleJournalRead(trigger) {
  let entries    = [];
  let titleLabel = 'RECENT ENTRIES';

  try {
    if (trigger.action === 'search') {
      const res  = await fetch(
        `${BACKEND_BASE}/journal/search?q=${encodeURIComponent(trigger.query)}&limit=10`
      );
      const data = await res.json();
      entries    = data.results ?? [];
      titleLabel = `SEARCH: ${trigger.query.toUpperCase()}`;
    } else if (trigger.action === 'today') {
      const res  = await fetch(`${BACKEND_BASE}/journal/entries?date=today&limit=20`);
      const data = await res.json();
      entries    = data.entries ?? [];
      titleLabel = "TODAY'S ENTRIES";
    } else {
      const res  = await fetch(`${BACKEND_BASE}/journal/entries?limit=10`);
      const data = await res.json();
      entries    = data.entries ?? [];
    }
  } catch (err) {
    console.error('[journal] read failed:', err);
    return null;
  }

  _renderEntriesView(titleLabel, entries);
  journalPanel.classList.remove('hidden');
  document.getElementById('starling')?.classList.add('journal-mode');

  if (!entries.length) return 'No journal entries found for that query.';

  const count   = entries.length;
  const context = entries.slice(0, 5).map((e, i) =>
    `Entry ${i + 1} (${
      new Date(e.recorded_at).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
      })
    }):\n${e.summary}`
  ).join('\n\n');

  return `[JOURNAL ENTRIES — ${count} found]\n\n${context}`;
}

// ── Button wiring ─────────────────────────────────────────────────────────────

/**
 * Wire all journal panel buttons. Call once after DOM is ready (bottom of app.js).
 */
export function wireJournalButtons({ onSubmit, onConfirm, onRerecord, onDiscard, onEntriesClose, onInterviewer }) {
  journalSubmitBtn?.addEventListener('click',      onSubmit);
  journalDiscardBtn?.addEventListener('click',     onDiscard);
  journalConfirmBtn?.addEventListener('click',     onConfirm);
  journalRerecordBtn?.addEventListener('click',    onRerecord);
  journalDiscardBtn2?.addEventListener('click',    onDiscard);
  journalEntriesClose?.addEventListener('click',   onEntriesClose);
  journalInterviewerBtn?.addEventListener('click', onInterviewer);
}

// ── Private helpers ────────────────────────────────────────────────────────────

async function _generateNextQuestion(callLLMFn, systemPrompt) {
  const interviewSystemPrompt = getPrompt('JOURNAL_INTERVIEWER', {
    question_number: String(_interviewQACount + 1),
    max_questions:   String(MAX_INTERVIEW_QUESTIONS),
    min_questions_reached_instruction: _interviewQACount >= MIN_INTERVIEW_QUESTIONS
      ? 'If you have gathered at least one substantive answer across three or more different domains, respond with exactly the single word DONE. Otherwise ask one question on the most important uncovered domain.\n'
      : '',
  });

  const priorMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: interviewSystemPrompt },
    ..._interviewPairs.flatMap(({ q, a }) => [
      { role: 'assistant', content: q },
      { role: 'user',      content: a },
    ]),
  ];

  const userMsg = _interviewPairs.length === 0
    ? "Start the interview. Ask your opening question about the person's day."
    : 'Continue the interview with your next follow-up question.';

  return await callLLMFn(userMsg, priorMessages);
}

function _renderInterviewTranscript(showSubmitHint = false) {
  journalTranscript.innerHTML = '';

  _interviewPairs.forEach(({ q, a }) => {
    const qEl = document.createElement('div');
    qEl.style.cssText = 'margin-bottom:3px;';
    qEl.innerHTML =
      `<span style="color:rgba(180,160,255,0.65);font-size:0.62em;letter-spacing:0.06em;margin-right:5px;">Q</span>` +
      `<span style="color:#999;">${escapeHtml(q)}</span>`;
    journalTranscript.appendChild(qEl);

    const aEl = document.createElement('div');
    aEl.style.cssText = 'margin-bottom:9px;padding-left:14px;';
    aEl.innerHTML =
      `<span style="color:rgba(120,220,160,0.65);font-size:0.62em;letter-spacing:0.06em;margin-right:5px;">A</span>` +
      `<span style="color:#ccc;">${escapeHtml(a)}</span>`;
    journalTranscript.appendChild(aEl);
  });

  if (_pendingQuestion) {
    const pEl = document.createElement('div');
    pEl.style.cssText = 'margin-bottom:3px;';
    pEl.innerHTML =
      `<span style="color:rgba(180,160,255,0.65);font-size:0.62em;letter-spacing:0.06em;margin-right:5px;">Q</span>` +
      `<span style="color:#ddd;">${escapeHtml(_pendingQuestion)}</span>`;
    journalTranscript.appendChild(pEl);
  }

  if (showSubmitHint) {
    const hint = document.createElement('div');
    hint.style.cssText =
      'margin-top:10px;color:rgba(180,160,255,0.45);font-size:0.62em;letter-spacing:0.06em;font-style:italic;';
    hint.textContent = 'Interview complete — say "submit" or press SUBMIT to save.';
    journalTranscript.appendChild(hint);
  }

  journalTranscript.scrollTop = journalTranscript.scrollHeight;
}

function _showView(which) {
  vDictation.classList.toggle('hidden', which !== 'dictation');
  vReview.classList.toggle('hidden',    which !== 'review');
  vEntries.classList.toggle('hidden',   which !== 'entries');
}

async function _loadAndShowEntries(titleLabel) {
  try {
    const res  = await fetch(`${BACKEND_BASE}/journal/entries?limit=10`);
    const data = await res.json();
    _renderEntriesView(titleLabel, data.entries ?? []);
  } catch {
    _renderEntriesView(titleLabel, []);
  }
}

function _renderEntriesView(titleLabel, entries) {
  if (journalEntriesTitle) journalEntriesTitle.textContent = titleLabel;
  _showView('entries');
  if (!journalEntriesList) return;
  journalEntriesList.innerHTML = '';

  if (!entries.length) {
    journalEntriesList.innerHTML =
      '<div style="font-size:0.7rem;color:#444;padding:4px 0;">No entries found.</div>';
    return;
  }

  entries.forEach(e => {
    const card = document.createElement('div');
    card.className = 'journal-entry-card';
    const dt = new Date(e.recorded_at).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    card.innerHTML =
      `<div class="journal-entry-date">${escapeHtml(dt.toUpperCase())}</div>` +
      `<div class="journal-entry-summary">${escapeHtml(e.summary)}</div>` +
      `<div class="journal-entry-tags">${
        (e.tags || []).map(t => `<span class="journal-tag">${escapeHtml(t)}</span>`).join('')
      }</div>`;
    journalEntriesList.appendChild(card);
  });
}
