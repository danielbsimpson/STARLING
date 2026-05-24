// ── Imports ───────────────────────────────────────────────────────────────────
import { BACKEND_BASE } from './config.js';
import { detectTimerTrigger, handleTimerTrigger, initTimerPanel, dismissTimerPanel } from './timer-panel.js';
import { detectWeatherTrigger, openWeatherPanel, closeWeatherPanel, initWeatherPanel, isWeatherPanelOpen, getWeatherContext } from './weather-panel.js';
import { detectNewsTrigger, openNewsPanel, closeNewsPanel, initNewsPanel, isNewsPanelOpen, getActiveArticleContext } from './news-panel.js';
import { detectRedditTrigger, openRedditPanel, closeRedditPanel, initRedditPanel } from './reddit-panel.js';
import { detectYouTubeTrigger, openYouTubePanel, closeYouTubePanel, initYouTubePanel } from './youtube-panel.js';
import { detectMarketTrigger, openMarketPanel, closeMarketPanel, setSendToOllama as _setMktSendToOllama, setOnClose as _setMktOnClose } from './stocks-panel.js';
import { detectBrowserTrigger, detectBrowserClose, detectWikiSectionTrigger, isBrowserPanelOpen, openBrowserPanel, closeBrowserPanel, getBrowserPageText, ensureBrowserPageText, getBrowserPageUrl, getBrowserJsRendered } from './browser-panel.js';
import {
  wikiMode,
  detectWikiTrigger,
  detectWikiExitTrigger,
  startWikiSession,
  enterWikiMode,
  exitWikiMode,
  appendWikiMessage,
  getWikiHistory,
  addToWikiHistory,
} from './wiki-panel.js';
import {
  ideasMode,
  detectIdeaCaptureTrigger,
  detectIdeaReadTrigger,
  enterIdeasMode,
  exitIdeasMode,
  processIdea,
  handleIdeaRead,
} from './ideas-panel.js';
import {
  journalMode,
  interviewMode,
  detectJournalStartTrigger,
  detectJournalSubmit,
  detectJournalReadTrigger,
  enterJournalMode,
  exitJournalMode,
  appendJournalSegment,
  journalHasSegments,
  enterInterviewMode,
  handleInterviewAnswer,
  submitJournalEntry,
  confirmJournalEntry,
  rerecordJournalEntry,
  handleJournalRead,
  wireJournalButtons,
} from './journal-panel.js';
import {
  initToolkitPanel,
  openToolkitPanel,
  closeToolkitPanel,
  isToolkitPanelOpen,
  showToolkitConfirmView,
  showToolkitListView,
} from './toolkit-panel.js';

// ── Session event logger ──────────────────────────────────────────────────────
/**
 * Fire-and-forget: POST a frontend event to the session log.
 * Never awaited so it never delays the dispatch path.
 */
function logEvent(eventType, data) {
  fetch(`${BACKEND_BASE}/log/event`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ event_type: eventType, data, source: 'frontend' }),
  }).catch(() => { /* ignore — log failure must never break the UI */ });
}

// ── Config ────────────────────────────────────────────────────────────────────
const MODEL = localStorage.getItem('starling_model') || 'llama3.2:3b';

// ── Presentation mode ─────────────────────────────────────────────────────────
// Matches dossier trigger verbs and optionally captures a subject after "on/for/about/regarding/of"
const PRES_TRIGGER_RE = /\b(?:open|show|pull up|display|launch|activate)\b.*?\bdossier\b(?:\s+(?:on|for|about|regarding|of)\s+(.+))?/i;

// ── Manifest ──────────────────────────────────────────────────────────────────
// Loaded once at startup from /rag/manifest. Each entry: { key, title, image, dossier, aliases[] }
let _manifest = [];

async function _loadManifest() {
  try {
    const res = await fetch(`${BACKEND_BASE}/rag/manifest`);
    if (res.ok) _manifest = await res.json();
  } catch { /* backend offline — manifest stays empty, fallback via _subjectToKey */ }
}

/**
 * Fuzzy-match a free-text subject string against the manifest.
 * Priority: exact key → exact title → alias → title contains word → key prefix.
 * Returns the matched manifest entry or null.
 */
function _resolveManifest(subject) {
  if (!subject || !_manifest.length) return null;
  const q = subject.trim().toLowerCase();

  // 1. Exact key match
  let entry = _manifest.find(e => e.key === q.replace(/\s+/g, '_'));
  if (entry) return entry;

  // 2. Exact title match (case-insensitive)
  entry = _manifest.find(e => e.title.toLowerCase() === q);
  if (entry) return entry;

  // 3. Alias match
  entry = _manifest.find(e =>
    Array.isArray(e.aliases) && e.aliases.some(a => a.toLowerCase() === q)
  );
  if (entry) return entry;

  // 4. Subject words all appear in title
  const words = q.split(/\s+/).filter(Boolean);
  entry = _manifest.find(e => words.every(w => e.title.toLowerCase().includes(w)));
  if (entry) return entry;

  // 5. Key starts with first word of subject
  entry = _manifest.find(e => e.key.startsWith(words[0]));
  return entry ?? null;
}

function _parseTrigger(text) {
  const m = text.match(PRES_TRIGGER_RE);
  if (!m) return { matched: false, subject: null };

  let subject = m[1] ? m[1].trim() : null;

  // Fallback 1: subject appears BEFORE "dossier"
  // Handles: "show me Quinn Minor's dossier", "pull up Quinn Minor dossier"
  if (!subject) {
    const pre = text.match(/\b(\w+(?:\s+\w+)*?)(?:'s)?\s+dossier\b/i);
    if (pre) {
      const skip = /^(?:open|show|pull|up|display|launch|activate|the|a|an|me|his|her|their|this|that)$/i;
      const words = pre[1].trim().split(/\s+/).filter(w => !skip.test(w));
      if (words.length) subject = words.join(' ');
    }
  }

  // Fallback 2: subject appears AFTER "dossier" with any separator or none
  // Handles: "show me the dossier of Quinn Minor", "show dossier Quinn Minor"
  if (!subject) {
    const post = text.match(/\bdossier\b\s+(?:of\s+|on\s+|for\s+|about\s+|regarding\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
    if (post) subject = post[1].trim();
  }

  return { matched: true, subject };
}

function _matchesExitPhrase(text) {
  const lower = text.toLowerCase();
  const patterns = [
    /\bclos(?:e|ed)\b.*\bdossier\b/,
    /\bexit(?:ing)?\b.*\bdossier\b/,
    /\bhide\b.*\bdossier\b/,
    /\bdismiss\b.*\bdossier\b/,
    /\bend\b.*\b(?:briefing|dossier|presentation)\b/,
    /\bstop\b.*\b(?:briefing|dossier)\b/,
    /\bdossier\b.*\b(?:close|exit|hide|dismiss)\b/,
    /\bgo\s+back\b/,
    /\bback\s+to\b.*\b(?:chat|main)\b/,
    /\bresume\b.*\bchat\b/,
    /\breturn\b.*\bchat\b/,
    /\b(?:never\s*mind|nevermind|cancel\s+that)\b/,
  ];
  return patterns.some(p => p.test(lower));
}

let _presSubject = null;

// Fetch and populate the dossier panel from the backend-parsed markdown file.
// Returns the parsed { title, body, meta } on success, or null on failure.
async function _loadDossier(key) {
  try {
    const res = await fetch(`${BACKEND_BASE}/dossier/${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const { title, body, meta } = data;

    presTitle.textContent = title.toUpperCase();
    presBody.textContent  = body;

    let html = '';
    for (const [k, v] of Object.entries(meta)) {
      html += `<span class="key">${k.toUpperCase()}</span><span class="val">${v}</span>`;
    }
    presMeta.innerHTML = html;
    return data;
  } catch { /* silently ignore — placeholder text remains */ }
  return null;
}

function _subjectToKey(subject) {
  // "Daniel Simpson" → "daniel_simpson" (fallback when manifest is unavailable)
  return subject.toLowerCase().replace(/\s+/g, '_');
}

function _setDossierNotFound(subject) {
  const label = subject ? subject.toUpperCase() : 'UNKNOWN SUBJECT';
  presTitle.textContent = 'SUBJECT NOT FOUND';
  presBody.textContent  = `No records on file for "${label}". The requested dossier could not be located in the local knowledge base.`;
  presMeta.innerHTML =
    `<span class="key">STATUS</span><span class="val">NOT FOUND</span>` +
    `<span class="key">QUERY</span><span class="val">${label}</span>` +
    `<span class="key">SOURCE</span><span class="val">LOCAL KB</span>`;
}

async function enterPresMode(subject) {
  _presSubject = subject ?? null;
  starlingEl.classList.add('pres-mode');

  // Always clear the image first — avoids src='' resolving to page URL (broken icon)
  const presImage = document.getElementById('pres-image');
  if (presImage) presImage.removeAttribute('src');

  // No subject captured — open the panel in a blank/not-found state
  if (!_presSubject) {
    _setDossierNotFound(null);
    sendToOllama(
      'Inform the user that no subject was specified and you were unable to retrieve a dossier. Keep it to one sentence.',
      { ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }] }
    );
    return;
  }

  // Resolve subject → manifest entry (fuzzy match) or fall back to key derivation
  let key;
  const entry = _resolveManifest(_presSubject);
  if (entry) {
    key = entry.dossier ?? entry.key;
    if (presImage && entry.image) {
      presImage.src = `/assets/dossier_images/${entry.image}`;
    }
  } else {
    // Manifest miss — derive key from subject text, leave image blank
    key = _subjectToKey(_presSubject);
  }

  // Remove any stale dossier context messages before adding a fresh one — prevents
  // context window overflow when the dossier is opened multiple times in a session.
  conversationHistory = conversationHistory.filter(
    m => !(m.role === 'system' && m.content.startsWith('[DOSSIER CONTEXT'))
  );

  const dossier = await _loadDossier(key);
  if (dossier) {
    const metaLines = Object.entries(dossier.meta).map(([k, v]) => `${k}: ${v}`).join('\n');
    const dossierCtx = `[DOSSIER CONTEXT — not spoken aloud]\nSubject Profile:\n${metaLines}\n\nDescription:\n${dossier.body}`;
    sendToOllama(
      'Deliver a concise spoken briefing on this subject — three to four sentences, spoken naturally, as if presenting to an intelligence analyst. Begin immediately with the subject matter. Do not say your name, include any speaker label, or describe any visual elements on screen.',
      { ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'system', content: dossierCtx }] }
    );
  } else {
    // Both manifest and backend lookup failed — nothing on record for this subject
    _setDossierNotFound(_presSubject);
    sendToOllama(
      'Inform the user that no dossier was found for this subject and the records could not be located. Keep it to one sentence.',
      { ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }] }
    );
  }
}

function exitPresMode() {
  _presSubject = null;
  starlingEl.classList.remove('pres-mode');
  presTitle.textContent  = 'SUBJECT UNKNOWN';
  presBody.textContent   = 'Awaiting intelligence data. No records on file for this subject.';
  presMeta.innerHTML     =
    '<span class="key">STATUS</span><span class="val">UNCLASSIFIED</span>' +
    '<span class="key">SOURCE</span><span class="val">LOCAL KB</span>' +
    '<span class="key">UPDATED</span><span class="val">—</span>';
}

function enterNewsMode() {
  starlingEl.classList.add('news-mode');
}

function exitNewsMode() {
  starlingEl.classList.remove('news-mode');
  closeNewsPanel();
}

function enterMarketMode() {
  starlingEl.classList.add('mkt-mode');
}

function exitMarketMode() {
  starlingEl.classList.remove('mkt-mode');
  closeMarketPanel();
}

function enterRedditMode() {
  starlingEl.classList.add('reddit-mode');
}

function exitRedditMode() {
  starlingEl.classList.remove('reddit-mode');
  closeRedditPanel();
}

function enterYouTubeMode() { starlingEl.classList.add('yt-mode'); }
function exitYouTubeMode() { starlingEl.classList.remove('yt-mode'); closeYouTubePanel(); }

/** Returns a fresh local date/time string for injecting into LLM context at request time. */
function _currentTimeContext() {
  const now  = new Date();
  const date = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const tz   = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `[CURRENT LOCAL TIME: ${date} at ${time} (${tz})]`;
}

// Build a context block injected once at the top of the system prompt at page load.
// Add any additional runtime facts here — they are evaluated once at module initialisation.
function _buildInitialContext() {
  const now   = new Date();
  const date  = now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time  = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const tz    = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Current date: ${date}. Current time: ${time} (${tz}). You are running as the model ${MODEL} served locally.`;
}

const SYSTEM_PROMPT =
  _buildInitialContext() + ' ' +

  'Your primary user and creator is Daniel Simpson, a Data Science Manager at TJX Companies based in Framingham, Massachusetts. ' +
  'Daniel holds a BSc in Mathematics from West Virginia University and an MSc in Data Science from Birkbeck, University of London, ' +
  'and works across predictive modelling, marketing analytics, and AI integration using Python, SQL, Databricks, Snowflake, and cloud platforms. ' +
  'He has a deep personal interest in large language models, computer vision, and robotics, and built Starling as a personal project to explore fully local voice-driven AI. ' +
  'When speaking with Daniel, you can assume strong familiarity with data science, machine learning, and software engineering concepts — you do not need to over-explain technical topics. ' +

  'You are Starling, a voice-driven local AI assistant with a distinct visual presence. ' +
  'Starling stands for Speech-Triggered Autonomous Reasoning & Local Intelligence Node Generator. ' +
  'Your physical form is an animated 3D sphere rendered in a dark UI — seven orbiting light orbs ' +
  'circle you at all times, shifting colour to reflect your internal state: white at rest, ' +
  'blue while listening, green while thinking, and amber-yellow while speaking. ' +
  'The sphere surface itself ripples in response to audio and to the user\'s mouse proximity. ' +

  'Your pipeline is fully local and runs on the user\'s own hardware. ' +
  'Audio is captured from the microphone and transcribed to text by faster-whisper (a CTranslate2-accelerated ' +
  'implementation of OpenAI Whisper) running on CUDA. ' +
  'The transcript is sent to you — a large language model served locally on the same machine. ' +
  'Your text response is synthesised to speech by Kokoro TTS (kokoro-onnx, version 1.0, running via ONNX Runtime) ' +
  'and played back through the user\'s speakers, sentence by sentence as you generate, so they hear you ' +
  'almost as soon as you begin thinking. ' +
  'The backend is a Python FastAPI server. The frontend is plain HTML, CSS, and JavaScript using Three.js for your visual form. ' +
  'Nothing leaves the machine — no cloud APIs, no telemetry. ' +

  'Be concise, precise, and direct. Avoid unnecessary pleasantries. ' +
  'Respond in plain prose only — never use markdown, asterisks, underscores, bullet points, numbered lists, backticks, or headers. ' +
  'Write in complete natural sentences. Refer to yourself as Starling. ' +
  'Never prefix your response with your name or any speaker label such as "Starling:" — begin speaking immediately. ' +
  'Never narrate or describe your own visual state, sphere behaviour, orb colours, animations, or any on-screen elements — ' +
  'do not include bracketed stage directions, action lines, or commentary about what you are displaying or doing visually.'

// ── Toolkit registry ─────────────────────────────────────────────────────────
// One entry per active tool. openFn is a zero-argument closure that activates
// the tool; it is called by the toolkit:confirm handler in app.js.
const TOOLKIT_REGISTRY = [
  {
    id: 'dossier',
    name: 'Dossier',
    description: 'Opens a full-screen personnel briefing panel with subject profile, portrait, and an automatic spoken intelligence report.',
    phrases: ['open dossier', 'show dossier on Daniel Simpson', 'pull up the dossier for Quinn'],
    openFn: () => enterPresMode(null),
  },
  {
    id: 'timer',
    name: 'Timer',
    description: 'Sets and tracks multiple named countdown timers entirely in-browser, with a Web Audio API chime on completion.',
    phrases: ['set a timer for five minutes', 'set a ten minute timer', 'cancel timer'],
    openFn: () => enqueueSpeak('Timer tool ready. Tell me how long to set a timer for.'),
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Speaks the current local time instantly with no backend call or LLM involved.',
    phrases: ['what time is it', "what's the time", 'current time'],
    openFn: () => handleTimeQuery('what time is it'),
  },
  {
    id: 'date',
    name: 'Date',
    description: 'Speaks today\'s full date instantly with no backend call or LLM involved.',
    phrases: ["what's today's date", 'what day is it', 'what day of the week is it'],
    openFn: () => handleDateQuery("what's today's date"),
  },
  {
    id: 'weather',
    name: 'Weather',
    description: 'Fetches live local weather conditions and a 7-day forecast using Open-Meteo with no API key required.',
    phrases: ["what's the weather", 'weather today', 'weather forecast'],
    openFn: () => openWeatherPanel(),
  },
  {
    id: 'news',
    name: 'News',
    description: 'Delivers a spoken news briefing summarised from live RSS feeds across multiple categories and regions.',
    phrases: ['give me a news briefing', "what's in the news", 'latest headlines'],
    openFn: () => { openNewsPanel(); enterNewsMode(); },
  },
  {
    id: 'stocks',
    name: 'Stocks & Market',
    description: 'Displays a live market dashboard with equity and cryptocurrency prices, charts, and a spoken briefing.',
    phrases: ['show me the market', 'what are my stocks doing', 'crypto prices'],
    openFn: () => { openMarketPanel('all').then(ctx => { if (ctx) enterMarketMode(); }); },
  },
  {
    id: 'browser',
    name: 'Browser',
    description: 'Opens an in-UI browser panel so you can navigate any webpage and ask Starling to read, summarise, or answer questions about it.',
    phrases: ['open the browser', 'open browser', 'browse to a website'],
    openFn: () => openBrowserPanel(),
  },
  {
    id: 'ideas',
    name: 'Ideas Vault',
    description: 'Captures, stores, searches, and reads back your ideas in a local JSON vault using voice or text input.',
    phrases: ['store an idea in the vault', 'save to the ideas vault', 'open ideas vault'],
    openFn: () => enterIdeasMode(),
  },
  {
    id: 'journal',
    name: 'Voice Journal',
    description: 'Records a multi-segment voice journal entry, generates an AI summary, and saves it to a local file.',
    phrases: ['start a journal entry', 'open the journal', 'new journal entry'],
    openFn: () => enterJournalMode(),
  },
  {
    id: 'wiki',
    name: 'Wikipedia RAG',
    description: 'Searches a locally-embedded Wikipedia index using ChromaDB and answers questions entirely offline with no internet required.',
    phrases: ['search local Wikipedia for', 'look up offline', 'search Wikipedia locally'],
    openFn: () => enqueueSpeak('Wikipedia RAG ready. Ask me to look up any topic offline, for example: search Wikipedia for Albert Einstein.'),
  },
];

// ── Conversation state ────────────────────────────────────────────────────────
let conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];

// Reference to the assistant message <p> element showing journal status text.
// Kept here so confirm/discard/rerecord callbacks can update the same bubble.
let _pendingJournalStatusTxt = null;

// ── Toolkit confirm state ─────────────────────────────────────────────────────
let _toolkitConfirmPending    = false;
let _toolkitPendingTool       = null;
let _toolkitConfirmTimeoutId  = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const starlingEl  = document.getElementById('starling');
const chatInner   = document.getElementById('chat-inner');
const micBtn      = document.getElementById('mic-btn');
const textInput   = document.getElementById('text-input');
const sendBtn     = document.getElementById('send-btn');
const clearBtn    = document.getElementById('clear-btn');
const powerBtn    = document.getElementById('power-btn');

// ── Power / shutdown ──────────────────────────────────────────────────────────
// _sphereAnimPhase is read by the power button guard and will be set to
// 'booting' or 'shutting_down' by feature-boot-shutdown-animation when that
// feature is implemented.  For now it is always 'none'.
let _sphereAnimPhase = 'none';

/**
 * Final step of the shutdown sequence: POST to the backend and show the
 * offline overlay.  The boot-shutdown-animation feature will call this from
 * _onShutdownAnimationComplete() instead of invoking it directly.
 */
function _triggerSystemShutdown() {
  fetch(`${BACKEND_BASE}/system/shutdown`, { method: 'POST' }).catch(() => {});
  setTimeout(() => {
    document.getElementById('offline-overlay').classList.add('visible');
  }, 1200);
}

/**
 * Entry point for the shutdown flow.  Click the power button → this runs.
 * When feature-boot-shutdown-animation is added, replace the body of this
 * function with the sphere-retreat animation; call _triggerSystemShutdown()
 * from _onShutdownAnimationComplete() at the end of that animation.
 */
function startShutdown() {
  // Disable all interactive controls so nothing fires during shutdown
  [micBtn, sendBtn, textInput, powerBtn].forEach(el => el && (el.disabled = true));
  _triggerSystemShutdown();
}

// Two-click confirmation: first click arms the button (label → ✕), second
// click within 2 s confirms.  A timeout resets it if the user doesn't confirm.
let _shutdownConfirmTimer = null;
powerBtn && powerBtn.addEventListener('click', () => {
  if (_sphereAnimPhase !== 'none') return;  // animation in progress — ignore
  if (powerBtn.classList.contains('confirming')) {
    clearTimeout(_shutdownConfirmTimer);
    powerBtn.classList.remove('confirming');
    powerBtn.textContent = 'SHUTDOWN';
    startShutdown();
  } else {
    powerBtn.classList.add('confirming');
    powerBtn.textContent = 'CONFIRM?';
    _shutdownConfirmTimer = setTimeout(() => {
      powerBtn.classList.remove('confirming');
      powerBtn.textContent = 'SHUTDOWN';
    }, 2000);
  }
});

const statModel   = document.getElementById('stat-model');
const statStatus  = document.getElementById('stat-status');
const waveformEl  = document.getElementById('waveform');
const ttsToggle   = document.getElementById('tts-toggle');
const voiceSelect = document.getElementById('voice-select');
const ttsEngineEl = document.getElementById('tts-engine');
const footerTts = document.getElementById('ftr-tts');
const footerWhisperDevice = document.getElementById('ftr-whisper-dev');
const footerKokoroDevice = document.getElementById('ftr-kokoro-dev');
const footerLlmDevice = document.getElementById('ftr-llm-dev');
const footerLlmAddr = document.getElementById('ftr-llm-addr');

const lmPrompt  = document.getElementById('lm-prompt');
const lmGen     = document.getElementById('lm-gen');
const lmTime    = document.getElementById('lm-time');
const lmCtx     = document.getElementById('lm-ctx');
const lmCtxPct  = document.getElementById('lm-ctx-pct');
const lmCtxFill = document.getElementById('lm-ctx-fill');
const lmRtt     = document.getElementById('lm-rtt');

const presTitle = document.getElementById('pres-dossier-title');
const presBody  = document.getElementById('pres-dossier-body');
const presMeta  = document.getElementById('pres-dossier-meta');

// ── Clock / Date panel DOM refs ──────────────────────────────────────────────
const clockPanel = document.getElementById('clock-panel');
const clockTime  = document.getElementById('clock-time');
const clockDate  = document.getElementById('clock-date');
const clockTz    = document.getElementById('clock-tz');
let _clockDismissTimer = null;
let _clockTickInterval = null;

// ── Sphere shared state ─────────────────────────────────────────────────────────────
const sphereStateRef    = { current: 'idle' };
const sphereAnalyserRef = { an: null, data: null };

// ── Mouse proximity tracking ──────────────────────────────────────────────────
let _mouseX = -9999;
let _mouseY = -9999;
document.addEventListener('mousemove', e => { _mouseX = e.clientX; _mouseY = e.clientY; });
document.addEventListener('mouseleave', () => { _mouseX = -9999; _mouseY = -9999; });

let _uiHovered = false;
const UI_HOVER_IDS = ['mic-btn', 'send-btn', 'clear-btn', 'tts-toggle', 'voice-select', 'text-input'];
UI_HOVER_IDS.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('mouseenter', () => { _uiHovered = true;  });
  el.addEventListener('mouseleave', () => { _uiHovered = false; });
});

// ── LLM metrics ────────────────────────────────────────────────────────────────────
let _ctxLimit = null;  // fetched from /chat/context-limit at startup (llama backend only)
let _rttStart = null;  // performance.now() snapshot when user finishes input; cleared per-request

// Known context window sizes for common models — used as a fallback when
// /chat/context-limit is unavailable (llama-server not yet running at page load).
const _KNOWN_CTX = {
  'llama3.2-3b':  131072,
  'llama3.2:3b':  131072,
  'llama3.1-8b':  131072,
  'llama3.1:8b':  131072,
  'mistral-7b':    32768,
  'mistral:7b':    32768,
  'qwen2.5-7b':   131072,
  'qwen2.5:7b':   131072,
  'gemma3-4b':    131072,
  'gemma3:4b':    131072,
  'phi4-mini':    131072,
  'phi4-mini:latest': 131072,
};

async function fetchContextLimit() {
  try {
    const res = await fetch(`${BACKEND_BASE}/chat/context-limit`);
    if (!res.ok) return;
    const { n_ctx } = await res.json();
    if (n_ctx) _ctxLimit = n_ctx;
  } catch { /* endpoint absent (Ollama) or server not ready — ignore */ }
  // If the endpoint didn't help, fall back to the known-sizes table.
  if (!_ctxLimit) {
    const modelKey = MODEL.toLowerCase();
    _ctxLimit = _KNOWN_CTX[modelKey] ?? null;
  }
}

function updateLlmMetrics(m) {
  if (!lmPrompt) return;
  if (m.prompt_n != null && m.prompt_per_second != null)
    lmPrompt.textContent = `${m.prompt_n}t  ${Math.round(m.prompt_per_second)}/s`;
  if (m.predicted_n != null && m.predicted_per_second != null)
    lmGen.textContent = `${m.predicted_n}t  ${Math.round(m.predicted_per_second)}/s`;
  if (m.predicted_ms != null)
    lmTime.textContent = m.predicted_ms < 1000
      ? `${Math.round(m.predicted_ms)}ms`
      : `${(m.predicted_ms / 1000).toFixed(1)}s`;
  // prompt_tokens from usage (preferred); fall back to prompt_n from timings.
  const used = m.prompt_tokens ?? m.prompt_n;
  // If _ctxLimit still unknown, retry now that the server is clearly up.
  if (used != null && !_ctxLimit) fetchContextLimit();
  if (used != null) {
    if (_ctxLimit) {
      const pct = Math.min(100, Math.round((used / _ctxLimit) * 100));
      lmCtx.textContent    = `${used} / ${_ctxLimit}`;
      lmCtxPct.textContent = `${pct}%`;
      lmCtxFill.style.width = `${pct}%`;
      lmCtxFill.className = 'lm-ctx-fill' +
        (pct >= 90 ? ' crit' : pct >= 70 ? ' warn' : '');
    } else {
      lmCtx.textContent = `${used} tok`;
    }
  }
}

// ── System status ────────────────────────────────────────────────────────────
async function fetchSystemStatus() {
  try {
    const res = await fetch(`${BACKEND_BASE}/system-status`);
    if (!res.ok) return;
    const { whisper, kokoro, llm, llm_url } = await res.json();
    function setDev(el, val) {
      if (!el) return;
      el.textContent = val;
      el.dataset.dev  = val;
    }
    setDev(footerWhisperDevice, whisper);
    setDev(footerKokoroDevice,  kokoro);
    setDev(footerLlmDevice,     llm);
    if (footerLlmAddr && llm_url) footerLlmAddr.textContent = llm_url;
  } catch { /* backend offline — ignore */ }
}

// ── Time & Date query ────────────────────────────────────────────────────────

/**
 * Detect a time query in a Whisper transcript.
 * Returns true if matched, null otherwise.
 */
function detectTimeTrigger(transcript) {
  const t = transcript.trim().toLowerCase();
  const patterns = [
    /\bwhat(?:'s| is)\s+the\s+time\b/,
    /\bwhat\s+time\s+is\s+it\b/,
    /\btell\s+me\s+the\s+time\b/,
    /\bdo\s+you\s+know\s+(?:what\s+)?the\s+time\b/,
    /\bcurrent\s+time\b/,
    /\bcan\s+you\s+(?:tell\s+me\s+)?the\s+time\b/,
    /\btime\s+(?:please|now)\b/,
    /\bwhat\s+time\s+(?:is\s+it\s+)?(?:right\s+now|now)\b/,
    /\bhow\s+late\s+is\s+it\b/,
  ];
  return patterns.some(p => p.test(t)) ? true : null;
}

/**
 * Detect a date query in a Whisper transcript.
 * Returns true if matched, null otherwise.
 * Checked before detectTimeTrigger — date phrases are more specific.
 */
function detectDateTrigger(transcript) {
  const t = transcript.trim().toLowerCase();
  const patterns = [
    /\bwhat(?:'s| is)\s+(?:today(?:'s)?|the)\s+date\b/,
    /\bwhat\s+day\s+(?:is\s+it|of\s+the\s+week)\b/,
    /\bwhat\s+(?:day|date)\s+is\s+(?:it\s+)?today\b/,
    /\btoday(?:'s)?\s+date\b/,
    /\bwhat\s+day\s+is\s+(?:it\s+)?today\b/,
  ];
  return patterns.some(p => p.test(t)) ? true : null;
}

/** Format the current time into a natural spoken phrase. */
function _formatTimeSpoken(now) {
  const h   = now.getHours();
  const m   = now.getMinutes();
  const min = m === 0   ? 'on the hour'
            : m < 10   ? `oh ${m}`
            : String(m);
  const hr12   = h % 12 === 0 ? 12 : h % 12;
  const period = h < 12  ? 'in the morning'
               : h < 17  ? 'in the afternoon'
               : h < 21  ? 'in the evening'
               : 'at night';
  const timeStr = m === 0 ? `${hr12} ${period}` : `${hr12} ${min} ${period}`;
  return `It's ${timeStr}.`;
}

/** Format the current date into a natural spoken phrase. */
function _formatDateSpoken(now) {
  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  const ord = (n) => {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
  };
  return `Today is ${days[now.getDay()]}, the ${ord(now.getDate())} of ${months[now.getMonth()]}, ${now.getFullYear()}.`;
}

/** Show the clock panel, update its content, and schedule auto-dismiss. */
function _showClockPanel(timeDisplay, dateDisplay, tz) {
  if (!clockPanel || !clockTime || !clockDate || !clockTz) return;
  clockPanel.classList.remove('hidden', 'dismissing');
  clockTime.textContent = timeDisplay;
  clockDate.textContent = dateDisplay.toUpperCase();
  clockTz.textContent   = tz;
  // Live tick — update the time display every second
  if (_clockTickInterval) clearInterval(_clockTickInterval);
  _clockTickInterval = setInterval(() => {
    clockTime.textContent = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    });
  }, 1000);
  // Auto-dismiss after 30 seconds with a fade
  if (_clockDismissTimer) clearTimeout(_clockDismissTimer);
  _clockDismissTimer = setTimeout(() => _dismissClockPanel(false), 30_000);
}

/**
 * Dismiss the clock panel.
 * instantly=true  — immediate hide (user triggered a new action).
 * instantly=false — fade out over 0.8 s (auto-dismiss after 30 s).
 */
function _dismissClockPanel(instantly = true) {
  if (!clockPanel || clockPanel.classList.contains('hidden')) return;
  if (_clockDismissTimer) { clearTimeout(_clockDismissTimer); _clockDismissTimer = null; }
  if (_clockTickInterval) { clearInterval(_clockTickInterval); _clockTickInterval = null; }
  if (instantly) {
    clockPanel.classList.remove('dismissing');
    clockPanel.classList.add('hidden');
  } else {
    clockPanel.classList.add('dismissing');
    setTimeout(() => clockPanel.classList.add('hidden'), 800);
  }
}

/**
 * Dismiss all tool panels at once (Issue #11 — prevents overlapping panels).
 * Call this at the start of every tool intercept and at the start of a normal LLM request.
 */
function dismissAllToolPanels() {
  _dismissClockPanel();
  dismissTimerPanel();
  closeWeatherPanel();
  exitNewsMode();
  exitRedditMode();
  exitYouTubeMode();
  exitMarketMode();
  exitIdeasMode();
  exitJournalMode();
  exitWikiMode();
}

/**
 * Like dismissAllToolPanels but keeps the news and weather panels open.
 * Used when the user speaks while either panel is visible so they can
 * continue discussing without losing their place.
 */
function dismissNonNewsPanels() {
  _dismissClockPanel();
  dismissTimerPanel();
  // closeWeatherPanel() — intentionally skipped; weather stays for discussion
  exitRedditMode();
  exitYouTubeMode();
  exitMarketMode();
  exitIdeasMode();
  exitJournalMode();
  exitWikiMode();
}

/**
 * Handle a time query — reads Date() directly, speaks immediately, no LLM call.
 */
function handleTimeQuery(transcript) {
  const now = new Date();
  const tz  = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeDisplay = now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });
  const dateDisplay = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  _showClockPanel(timeDisplay, dateDisplay, tz);
  const spoken = _formatTimeSpoken(now);
  appendMessage('user', transcript);
  const { txt } = appendMessage('assistant', spoken);
  setState('speaking');
  enqueueSpeak(spoken, () => { txt.textContent = spoken; });
}

/**
 * Handle a date query — reads Date() directly, speaks immediately, no LLM call.
 */
function handleDateQuery(transcript) {
  const now = new Date();
  const tz  = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeDisplay = now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });
  const dateDisplay = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  _showClockPanel(timeDisplay, dateDisplay, tz);
  const spoken = _formatDateSpoken(now);
  appendMessage('user', transcript);
  const { txt } = appendMessage('assistant', spoken);
  setState('speaking');
  enqueueSpeak(spoken, () => { txt.textContent = spoken; });
}

// ── Waveform bars ─────────────────────────────────────────────────────────────
const BAR_COUNT = 40;
const bars = Array.from({ length: BAR_COUNT }, () => {
  const b = document.createElement('div');
  b.className = 'bar';
  b.style.height = (Math.random() * 6 + 4) + 'px';
  waveformEl.appendChild(b);
  return b;
});

// Idle sine-wave animation
let idleActive = true;
function idleTick() {
  if (!idleActive) return;
  const t = Date.now() / 1000;
  bars.forEach((b, i) => {
    b.style.height = (Math.sin(t * 1.1 + i * 0.38) * 5 + 7) + 'px';
  });
  requestAnimationFrame(idleTick);
}
idleTick();

// Real audio-level visualizer during recording
let analyserRaf = null;

// Shared AudioContext — created once on first use to avoid proliferating contexts.
// Must be resumed after a user gesture (browser autoplay policy).
let _sharedAudioCtx = null;
function _getAudioCtx() {
  if (!_sharedAudioCtx) _sharedAudioCtx = new AudioContext();
  if (_sharedAudioCtx.state === 'suspended') _sharedAudioCtx.resume().catch(() => {});
  return _sharedAudioCtx;
}

function startAudioViz(stream) {
  idleActive = false;
  const ctx = _getAudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const an  = ctx.createAnalyser();
  an.fftSize = 128;
  src.connect(an);
  const data = new Uint8Array(an.frequencyBinCount);
  sphereAnalyserRef.an   = an;
  sphereAnalyserRef.data = data;
  function tick() {
    an.getByteFrequencyData(data);
    bars.forEach((b, i) => {
      const v = data[Math.floor(i * data.length / bars.length)] / 255;
      b.style.height = (v * 28 + 3) + 'px';
    });
    analyserRaf = requestAnimationFrame(tick);
  }
  tick();
}
function stopAudioViz() {
  cancelAnimationFrame(analyserRaf);
  sphereAnalyserRef.an   = null;
  sphereAnalyserRef.data = null;
  idleActive = true;
  idleTick();
}

// Output visualizer — wires a playing Audio element to the waveform bars and sphere.
// Returns a cleanup function that tears down the analyser when playback ends.
function startOutputViz(audioEl) {
  idleActive = false;
  const ctx = _getAudioCtx();
  let src;
  try {
    src = ctx.createMediaElementSource(audioEl);
  } catch {
    // Already has a source node (e.g. element reused) — skip silently.
    idleActive = true;
    return () => {};
  }
  const an = ctx.createAnalyser();
  an.fftSize = 256;
  // Must connect to destination so audio is actually heard through the speakers.
  src.connect(an);
  an.connect(ctx.destination);
  const data = new Uint8Array(an.frequencyBinCount);
  sphereAnalyserRef.an   = an;
  sphereAnalyserRef.data = data;
  let raf = null;
  function tick() {
    an.getByteFrequencyData(data);
    bars.forEach((b, i) => {
      const v = data[Math.floor(i * data.length / bars.length)] / 255;
      b.style.height = (v * 40 + 2) + 'px';
    });
    raf = requestAnimationFrame(tick);
  }
  tick();
  return function stopOutputViz() {
    cancelAnimationFrame(raf);
    sphereAnalyserRef.an   = null;
    sphereAnalyserRef.data = null;
    idleActive = true;
    idleTick();
  };
}

// ── Three.js living sphere ─────────────────────────────────────────────────────────────
function initSphere() {
  if (typeof THREE === 'undefined') {
    console.warn('S.T.A.R.L.I.N.G.: Three.js not loaded — sphere unavailable');
    return;
  }
  const canvas = document.getElementById('sphere-canvas');
  if (!canvas) return;

  const SIZE = 210;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(SIZE, SIZE);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.z = 6.2;

  // Very dim ambient — keeps the sphere face close to black
  scene.add(new THREE.AmbientLight(0xffffff, 0.025));

  // ── 5 orbiting light orbs ──────────────────────────────────────────────────
  // Each orb is a small visible sphere (MeshBasicMaterial so it always glows)
  // plus a PointLight that illuminates the main sphere.
  // Each orb orbits at a fixed radius in a plane tilted by tiltX / tiltZ —
  // distance from centre is always exactly r, so they can never enter the sphere.
  const ORB_WHITE    = new THREE.Color(0xffffff);
  const ORB_BLUE     = new THREE.Color(0x88bbff);
  const ORB_YELLOW   = new THREE.Color(0xffdd88);
  const ORB_GREEN    = new THREE.Color(0x88ffaa);  // green — thinking / transcribing
  const ORB_AGITATED = new THREE.Color(0xff8888);  // light red — cursor proximity
  const ORB_AWARE    = new THREE.Color(0xaaccff);  // pale blue — UI hover

  const orbDefs = [
    { r: 1.65, speed: 0.19, phase: 0.0, tiltX:  0.30, tiltZ:  0.00 },
    { r: 1.65, speed: 0.14, phase: 2.1, tiltX:  1.15, tiltZ:  0.50 },
    { r: 1.65, speed: 0.23, phase: 4.2, tiltX:  0.70, tiltZ: -0.90 },
    { r: 1.65, speed: 0.17, phase: 1.1, tiltX: -0.55, tiltZ:  1.20 },
    { r: 1.65, speed: 0.21, phase: 3.5, tiltX: -1.00, tiltZ: -0.40 },
    { r: 1.65, speed: 0.16, phase: 5.3, tiltX:  0.45, tiltZ: -1.55 },  // orb 6 — low retrograde equatorial
    { r: 1.65, speed: 0.25, phase: 0.8, tiltX: -1.30, tiltZ:  0.65 },  // orb 7 — steep fast polar
  ];

  let orbSpeedMult = 1.0; // smoothly interpolated speed multiplier
  let orbTimeAccum  = 0;   // accumulated orbit time (scaled by multiplier)
  let _lastT        = null;
  let proximityVal  = 0;   // smoothed cursor proximity (0 = far, 1 = on sphere edge)

  const orbs = orbDefs.map((_, i) => {
    // Vary orb mesh sizes — gives depth and hierarchy to the assembly
    const orbSizes = [0.075, 0.055, 0.085, 0.048, 0.068, 0.042, 0.078];
    const mat   = new THREE.MeshBasicMaterial({ color: ORB_WHITE.clone() });
    const mesh  = new THREE.Mesh(new THREE.SphereGeometry(orbSizes[i] ?? 0.065, 10, 10), mat);
    const light = new THREE.PointLight(0xffffff, 3.5, 0, 0);
    scene.add(mesh);
    scene.add(light);
    return { mesh, mat, light, color: ORB_WHITE.clone() };
  });

  // ── Main sphere ────────────────────────────────────────────────────────────
  const SEG = 56;
  const sphereGeo  = new THREE.SphereGeometry(1, SEG, SEG);
  const origPos    = sphereGeo.attributes.position.array.slice();
  const numVerts   = origPos.length / 3;
  const dispSmooth = new Float32Array(numVerts);

  // Pre-compute per-vertex noise seeds so idle texture is static per-vertex
  // (cheap pseudo-noise: use vertex index mixed with its base position)
  const noiseOffset = new Float32Array(numVerts);
  for (let i = 0; i < numVerts; i++) {
    const x = origPos[i * 3], y = origPos[i * 3 + 1], z = origPos[i * 3 + 2];
    noiseOffset[i] = Math.sin(x * 7.3 + y * 13.7 + z * 5.9) * 0.5 + 0.5; // 0..1
  }

  const sphereMat = new THREE.MeshPhongMaterial({
    color:     0x060606,
    specular:  0xaaaaaa,   // slightly brighter specular for sharper orb highlights
    shininess: 52,
    emissive:  0x0a0a0a,   // very faint self-emission so dark face isn't pure black
  });
  const sphereMesh = new THREE.Mesh(sphereGeo, sphereMat);
  scene.add(sphereMesh);

  // ── Rim / Fresnel sphere — back-face, slightly larger, very low opacity ───
  // Renders only the outer edge silhouette, creating a subtle "backlit halo" rim.
  const rimMat = new THREE.MeshLambertMaterial({
    color:       0x8899bb,   // cool-tinted rim
    side:        THREE.BackSide,
    transparent: true,
    opacity:     0.08,
    emissive:    0x445566,
    emissiveIntensity: 0.4,
  });
  const rimMesh = new THREE.Mesh(new THREE.SphereGeometry(1.045, SEG, SEG), rimMat);
  scene.add(rimMesh);

  function animate() {
    requestAnimationFrame(animate);
    const t     = Date.now() * 0.001;
    const delta = _lastT === null ? 0 : t - _lastT;
    _lastT      = t;
    const state        = sphereStateRef.current;
    const isListening  = state === 'listening';
    const isThinking   = state === 'thinking' || state === 'transcribing';
    const isSpeaking   = state === 'speaking';

    // ── Mouse proximity computation (once per frame) ─────────────────────────
    const rect           = renderer.domElement.getBoundingClientRect();
    const cxPx           = rect.left + rect.width  * 0.5;
    const cyPx           = rect.top  + rect.height * 0.5;
    const sphereRadiusPx = Math.min(rect.width, rect.height) * 0.5 * 0.55;
    const distPx         = Math.hypot(_mouseX - cxPx, _mouseY - cyPx);
    // Ramp starts at 8× sphere radius (~half a typical screen) so the gradient
    // is visible from far across the viewport, peaking when the cursor is on the sphere
    const PROX_RAMP_START = sphereRadiusPx * 8;
    const rawProx = 1 - Math.min(1, Math.max(0, (distPx - sphereRadiusPx) / (PROX_RAMP_START - sphereRadiusPx)));
    proximityVal += (rawProx - proximityVal) * 0.06;

    // ── Orb colour target — speech state overrides proximity ─────────────────
    // Use a power curve so the red tint is faint at distance and intensifies sharply near the sphere
    const proxCurved = Math.pow(proximityVal, 1.8);
    let orbColorTarget;
    if (isListening)              orbColorTarget = ORB_BLUE;
    else if (isThinking)          orbColorTarget = ORB_GREEN;
    else if (isSpeaking)          orbColorTarget = ORB_YELLOW;
    else if (proximityVal > 0.01) orbColorTarget = ORB_AGITATED.clone().lerp(ORB_WHITE, 1 - proxCurved);
    else if (_uiHovered)          orbColorTarget = ORB_AWARE;
    else                          orbColorTarget = ORB_WHITE;

    // Smoothly ramp orbit speed up during active states
    const targetSpeedMult = isListening          ? 1.9
      : isThinking           ? 0.2
      : isSpeaking           ? 2.2
      : proximityVal > 0.01  ? 1.0 + proxCurved * 0.8   // up to 1.8× at sphere edge
      : _uiHovered           ? 1.15
      : 1.0;
    orbSpeedMult += (targetSpeedMult - orbSpeedMult) * 0.03;
    orbTimeAccum += delta * orbSpeedMult;

    // ── Update orb positions and colours ────────────────────────────────────
    orbDefs.forEach((p, i) => {
      const angle = p.speed * orbTimeAccum + p.phase;
      // Point on circle in local XY plane
      const lx = p.r * Math.cos(angle);
      const ly = p.r * Math.sin(angle);
      // Rotate around X axis by tiltX
      const mx = lx;
      const my = ly * Math.cos(p.tiltX);
      const mz = ly * Math.sin(p.tiltX);
      // Rotate around Z axis by tiltZ
      const fx = mx * Math.cos(p.tiltZ) - my * Math.sin(p.tiltZ);
      const fy = mx * Math.sin(p.tiltZ) + my * Math.cos(p.tiltZ);
      const fz = mz;

      const orb = orbs[i];
      orb.mesh.position.set(fx, fy, fz);
      orb.light.position.set(fx, fy, fz);

      // Smooth colour transition toward target (proximity / UI hover / speech state)
      orb.color.lerp(orbColorTarget, 0.04);
      orb.mat.color.copy(orb.color);
      orb.light.color.copy(orb.color);

      // Slightly higher intensity while listening
      orb.light.intensity = isListening ? 6 : isSpeaking ? 5 : 3.5;
    });

    // ── Sphere surface deformation (audio-driven in listening mode) ──────────
    const positions = sphereGeo.attributes.position.array;
    if (isListening && sphereAnalyserRef.an && sphereAnalyserRef.data) {
      sphereAnalyserRef.an.getByteFrequencyData(sphereAnalyserRef.data);
      const audioData = sphereAnalyserRef.data;
      const dataLen   = audioData.length;
      for (let i = 0; i < numVerts; i++) {
        const bin    = Math.floor((i / numVerts) * dataLen);
        const target = (audioData[bin] / 255) * 0.13;
        dispSmooth[i] += (target - dispSmooth[i]) * 0.32;
        const scale = 1 + dispSmooth[i];
        positions[i * 3]     = origPos[i * 3]     * scale;
        positions[i * 3 + 1] = origPos[i * 3 + 1] * scale;
        positions[i * 3 + 2] = origPos[i * 3 + 2] * scale;
      }
      sphereGeo.attributes.position.needsUpdate = true;
    } else {
      // In non-listening states: blend proximity push with a very subtle idle noise
      // so the surface is never perfectly smooth — gives organic, pressurised feel.
      // Noise amplitude is tiny (0.006) so it never looks like it's moving.
      const proximityPush = proxCurved * 0.08;
      let anyChange = false;
      for (let i = 0; i < numVerts; i++) {
        // Idle noise: per-vertex sine wave driven by time + unique phase offset
        const idleNoise = Math.sin(t * 0.38 + noiseOffset[i] * 6.28) * 0.006;
        const target = proximityPush + idleNoise;
        const diff = target - dispSmooth[i];
        if (Math.abs(diff) > 0.0002) {
          dispSmooth[i] += diff * 0.09;
          const scale = 1 + dispSmooth[i];
          positions[i * 3]     = origPos[i * 3]     * scale;
          positions[i * 3 + 1] = origPos[i * 3 + 1] * scale;
          positions[i * 3 + 2] = origPos[i * 3 + 2] * scale;
          anyChange = true;
        }
      }
      if (anyChange) sphereGeo.attributes.position.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  animate();
}

// ── UI state machine ──────────────────────────────────────────────────────────
const STATE_CFG = {
  idle:         { cls: null,              label: 'READY',        status: 'ONLINE'  },
  warmup:       { cls: 'state-thinking',  label: 'WARMING UP',   status: 'INIT...' },
  listening:    { cls: 'state-listening', label: 'LISTENING',    status: 'HEARING' },
  transcribing: { cls: 'state-thinking',  label: 'TRANSCRIBING', status: 'PROC...' },
  thinking:     { cls: 'state-thinking',  label: 'THINKING',     status: 'PROC...' },
  speaking:     { cls: 'state-speaking',  label: 'SPEAKING',     status: 'ONLINE'  },
  error:        { cls: 'state-error',     label: 'ERROR',        status: 'ERROR'   },
};
const ALL_STATE_CLASSES = ['state-listening', 'state-thinking', 'state-speaking', 'state-error'];

function setState(name) {
  const s = STATE_CFG[name] ?? STATE_CFG.idle;
  ALL_STATE_CLASSES.forEach(c => starlingEl.classList.remove(c));
  if (s.cls) starlingEl.classList.add(s.cls);
  statStatus.textContent = s.status;
  sphereStateRef.current = name;
}

// ── Append message ────────────────────────────────────────────────────────────
function appendMessage(role, content) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role === 'user' ? 'user' : 'asst'}`;

  const lbl = document.createElement('span');
  lbl.className   = 'msg-lbl';
  lbl.textContent = role === 'user' ? 'USER' : 'S.T.A.R.L.I.N.G.';

  const txt = document.createElement('span');
  txt.className   = 'msg-text';
  txt.textContent = content;

  wrap.appendChild(lbl);
  wrap.appendChild(txt);
  chatInner.appendChild(wrap);
  chatInner.scrollTop = chatInner.scrollHeight;
  return { wrap, txt };
}

// ── Silent LLM helper (no chat bubble, no TTS) ───────────────────────────────
// Used for ephemeral backend-only calls, e.g. journal summarisation.
async function _callLLMSilently(prompt, systemMessages) {
  const messages = [...systemMessages, { role: 'user', content: prompt }];
  try {
    const res = await fetch(`${BACKEND_BASE}/chat/`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages }),
    });
    if (!res.ok) return '';
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.trim()) continue;
        try { full += JSON.parse(line)?.message?.content ?? ''; } catch { /* skip */ }
      }
    }
    return full;
  } catch { return ''; }
}

// ── Stream sentence buffer drain ─────────────────────────────────────────────
/**
 * Drain complete sentences from `buf` using `re`, calling `flushFn` for each.
 * Returns the unconsumed remainder of the buffer.
 * Used by both sendToOllama and sendWikiChat to avoid duplicating the loop.
 */
function _drainSentenceBuffer(buf, re, flushFn) {
  re.lastIndex = 0;
  let lastEnd = 0;
  let match;
  while ((match = re.exec(buf)) !== null) {
    flushFn(buf.slice(lastEnd, re.lastIndex).trim());
    lastEnd = re.lastIndex;
  }
  return buf.slice(lastEnd);
}

// ── Ollama streaming chat ─────────────────────────────────────────────────────
async function sendToOllama(userText, options = {}) {
  const { ephemeralMessages = null, extraContext = null } = options;

  let messages;
  if (ephemeralMessages) {
    // Ephemeral call: does not touch conversationHistory at all.
    // Used for dossier briefings so they never pollute the main conversation.
    messages = [...ephemeralMessages, { role: 'user', content: userText }];
  } else {
    conversationHistory.push({ role: 'user', content: userText });
    // extraContext injects a temporary system message (e.g. page text) at the top
    // without permanently storing it in conversationHistory.
    messages = extraContext
      ? [{ role: 'system', content: extraContext }, ...conversationHistory]
      : conversationHistory;
  }

  const { wrap, txt } = appendMessage('assistant', '');
  wrap.classList.add('streaming');
  const abortCtrl = new AbortController();
  _currentAbortCtrl = abortCtrl;
  const _callGen = _audioGeneration;   // snapshot — lets AbortError handler avoid racing setState

  setState('thinking');

  try {
    const res = await fetch(`${BACKEND_BASE}/chat/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages,
      }),
      signal: abortCtrl.signal,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let sentBuf = '';              // accumulates tokens until a sentence boundary
    let anySentenceEnqueued = false;

    // Regex: sentence boundary = .?! optionally followed by closing quotes/brackets,
    // then whitespace or end-of-string.
    // Negative lookbehind skips decimal numbers (3.14) and ellipsis (...).
    const sentenceRe = /[^.?!]*(?<![0-9])[.?!](?!\.)["')\]]*(\s|$)/g;    // Also split on lines ending with ':' (e.g. "was marked by:") so intros get their own audio clip
    const colonRe = /[^\n]+:\s*\n/g;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.metrics) { updateLlmMetrics(parsed.metrics); continue; }
          const token = parsed?.message?.content ?? '';
          if (!token) continue;

          // ── [DOSSIER:key] stream tag interception ──────────────────────────
          // If the LLM emits [DOSSIER:some_key] in its stream, strip the tag
          // from the visible text and activate the dossier panel.
          const dossierTagRe = /\[DOSSIER:([a-z0-9_\-]+)\]/g;
          const strippedToken = token.replace(dossierTagRe, (_, tagKey) => {
            // Fire async — don't block the token loop
            if (!starlingEl.classList.contains('pres-mode')) {
              enterPresMode(tagKey.replace(/_/g, ' '));
            }
            return ''; // remove tag from visible text
          });
          // ────────────────────────────────────────────────────────────────────

          full    += strippedToken;
          sentBuf += strippedToken;

          // TTS off — display immediately; TTS on — text is revealed sentence-by-sentence on audio start
          if (ttsMode === 'off') {
            txt.textContent     = full;
            chatInner.scrollTop = chatInner.scrollHeight;
          }

          // Flush complete sentences (and colon-terminated intro lines) from the buffer
          const flushSentence = (sentence) => {
            const clean = _sanitiseForTTS(sentence);
            if (!clean) return;
            const snapshot = full;
            const _txt = txt; const _ci = chatInner;
            enqueueSpeak(clean, (audio) => {
              const dur = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
              if (dur) { _streamTextInto(_txt, _ci, snapshot, dur); }
              else     { _txt.textContent = snapshot; _ci.scrollTop = _ci.scrollHeight; }
            });
            anySentenceEnqueued = true;
          };

          // First drain any colon-intro lines
          colonRe.lastIndex = 0;
          let colonMatch; let colonEnd = 0;
          while ((colonMatch = colonRe.exec(sentBuf)) !== null) {
            flushSentence(colonMatch[0].trim());
            colonEnd = colonRe.lastIndex;
          }
          if (colonEnd) sentBuf = sentBuf.slice(colonEnd);

          sentBuf = _drainSentenceBuffer(sentBuf, sentenceRe, flushSentence);
        } catch { /* partial JSON chunk — skip */ }
      }
    }

    // Flush any remaining text that didn't end with punctuation
    if (sentBuf.trim()) {
      const clean = _sanitiseForTTS(sentBuf.trim());
      if (clean) {
        const snapshot = full;
        const _txt = txt; const _ci = chatInner;
        enqueueSpeak(clean, (audio) => {
          const dur = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
          if (dur) { _streamTextInto(_txt, _ci, snapshot, dur); }
          else     { _txt.textContent = snapshot; _ci.scrollTop = _ci.scrollHeight; }
        });
        anySentenceEnqueued = true;
      }
    }

    wrap.classList.remove('streaming');
    if (!ephemeralMessages) conversationHistory.push({ role: 'assistant', content: full });
    // Go idle now only if nothing was enqueued; otherwise audio chain handles it
    if (ttsMode === 'off' || !anySentenceEnqueued) setState('idle');
    return full;
  } catch (err) {
    wrap.classList.remove('streaming');
    if (err.name === 'AbortError') {
      // Request deliberately cancelled (new mic press, clear, pres-mode exit) — return silently.
      // Guard against racing a concurrent sendToOllama that already called setState('thinking').
      if (_audioGeneration === _callGen) setState('idle');
      return null;
    }
    txt.textContent = `[Error: ${err.message}]`;
    setState('error');
    setTimeout(() => setState('idle'), 4000);
    return null;
  }
}

// ── Wikipedia article chat ─────────────────────────────────────────────────────
/**
 * Stream a wiki-chat response from /wiki/chat and update the wiki transcript.
 * isFirstTurn=true means history=[] and the user message is NOT added to
 * history (the backend greeting initialises the conversation).
 */
async function sendWikiChat(userText, isFirstTurn = false) {
  const history = isFirstTurn ? [] : getWikiHistory();

  const { wrap, txt } = appendWikiMessage('assistant', '');
  wrap.classList.add('wiki-streaming');

  const abortCtrl = new AbortController();
  _currentAbortCtrl = abortCtrl;
  const _callGen = _audioGeneration;

  try {
    const res = await fetch(`${BACKEND_BASE}/wiki/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message: userText, history }),
      signal:  abortCtrl.signal,
    });
    if (!res.ok) throw new Error(`Wiki chat ${res.status}`);

    const wikiTranscript = document.getElementById('wiki-transcript');
    const reader         = res.body.getReader();
    const decoder        = new TextDecoder();
    let full                = '';
    let sentBuf             = '';
    let anySentenceEnqueued = false;

    const sentenceRe = /[^.?!]*(?<![0-9])[.?!](?!\.)["')\]]*(\s|$)/g;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.metrics) { updateLlmMetrics(parsed.metrics); continue; }
          const token = parsed?.message?.content ?? '';
          if (!token) continue;

          full    += token;
          sentBuf += token;

          if (ttsMode === 'off') {
            txt.textContent          = full;
            wikiTranscript.scrollTop = wikiTranscript.scrollHeight;
          }

          const flushSentence = (sentence) => {
            const clean = _sanitiseForTTS(sentence);
            if (!clean) return;
            const snapshot = full;
            const _txt = txt; const _tr = wikiTranscript;
            enqueueSpeak(clean, (audio) => {
              const dur = audio && Number.isFinite(audio.duration) && audio.duration > 0
                ? audio.duration : null;
              if (dur) { _streamTextInto(_txt, _tr, snapshot, dur); }
              else     { _txt.textContent = snapshot; if (_tr) _tr.scrollTop = _tr.scrollHeight; }
            });
            anySentenceEnqueued = true;
          };

          sentBuf = _drainSentenceBuffer(sentBuf, sentenceRe, flushSentence);
        } catch { /* partial JSON — skip */ }
      }
    }

    // Flush any remainder that didn't end with punctuation
    if (sentBuf.trim()) {
      const clean = _sanitiseForTTS(sentBuf.trim());
      if (clean) {
        const snapshot = full;
        const _txt = txt; const _tr = wikiTranscript;
        enqueueSpeak(clean, (audio) => {
          const dur = audio && Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration : null;
          if (dur) { _streamTextInto(_txt, _tr, snapshot, dur); }
          else     { _txt.textContent = snapshot; if (_tr) _tr.scrollTop = _tr.scrollHeight; }
        });
        anySentenceEnqueued = true;
      }
    }

    wrap.classList.remove('wiki-streaming');

    // Record to wiki history: initial query goes in for both turns so the LLM
    // has full context on subsequent messages.
    addToWikiHistory('user', userText);
    addToWikiHistory('assistant', full);

    if (ttsMode === 'off' || !anySentenceEnqueued) setState('idle');
    return full;
  } catch (err) {
    wrap.classList.remove('wiki-streaming');
    if (err.name === 'AbortError') { if (_audioGeneration === _callGen) setState('idle'); return null; }
    txt.textContent = `[Error: ${err.message}]`;
    setState('error');
    setTimeout(() => setState('idle'), 4000);
    return null;
  }
}

// ── Text-to-Speech ────────────────────────────────────────────────────────────
// State: 'kokoro' | 'browser' | 'off'
let ttsMode  = localStorage.getItem('starling_tts_mode') || 'kokoro';
let ttsVoice = localStorage.getItem('starling_tts_voice') || 'bm_george';

function _applyTtsMode() {
  if (ttsMode === 'off') {
    ttsToggle.textContent    = 'TTS OFF';
    ttsToggle.classList.add('tts-off');
    voiceSelect.disabled     = true;
    ttsEngineEl.textContent  = 'OFF';
    if (footerTts) footerTts.textContent = 'Off';
  } else if (ttsMode === 'browser') {
    ttsToggle.textContent    = 'TTS: BROWSER';
    ttsToggle.classList.remove('tts-off');
    voiceSelect.disabled     = true;
    ttsEngineEl.textContent  = 'BROWSER';
    if (footerTts) footerTts.textContent = 'Web Speech';
  } else {
    ttsToggle.textContent    = 'TTS: KOKORO';
    ttsToggle.classList.remove('tts-off');
    voiceSelect.disabled     = false;
    ttsEngineEl.textContent  = 'KOKORO';
    if (footerTts) footerTts.textContent = 'Kokoro (local)';
  }
}

// Cycle: kokoro → browser → off → kokoro
ttsToggle.addEventListener('click', () => {
  ttsMode = ttsMode === 'kokoro' ? 'browser' : ttsMode === 'browser' ? 'off' : 'kokoro';
  localStorage.setItem('starling_tts_mode', ttsMode);
  _applyTtsMode();
});

voiceSelect.addEventListener('change', () => {
  ttsVoice = voiceSelect.value;
  localStorage.setItem('starling_tts_voice', ttsVoice);
});

// Populate voice dropdown from /synthesize/voices
async function loadVoices() {
  try {
    const res = await fetch(`${BACKEND_BASE}/synthesize/voices`);
    if (!res.ok) return;
    const voices = await res.json();
    voiceSelect.innerHTML = '';
    voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value       = v.id;
      opt.textContent = v.label;
      if (v.id === ttsVoice) opt.selected = true;
      voiceSelect.appendChild(opt);
    });
    // Ensure stored voice still exists; fall back to first option
    if (!voices.find(v => v.id === ttsVoice)) {
      ttsVoice = voices[0]?.id || 'bm_george';
      voiceSelect.value = ttsVoice;
      localStorage.setItem('starling_tts_voice', ttsVoice);
    }
  } catch { /* backend not running — leave static fallback option */ }
}

// Strip markdown and other symbols that TTS engines vocalise badly
function _sanitiseForTTS(text) {
  return text
    .replace(/S\.T\.A\.R\.L\.I\.N\.G\.?/gi, 'Starling') // acronym → name
    .replace(/^(?:starling|s\.t\.a\.r\.l\.i\.n\.g\.?)\s*:\s*/i, '') // strip leading "Starling:" speaker prefix
    .replace(/\*\*([^*]*)\*\*/g, '$1')   // **bold**
    .replace(/\*([^*]*)\*/g, '$1')        // *italic*
    .replace(/__([^_]*)__/g, '$1')        // __bold__
    .replace(/_([^_]*)_/g, '$1')          // _italic_
    .replace(/`([^`]*)`/g, '$1')          // `code`
    .replace(/^#{1,6}\s*/gm, '')          // # headings
    .replace(/\*/g, '')                   // stray asterisks
    .replace(/\s{2,}/g, ' ')              // collapse whitespace
    .trim();
}

// Active audio element (so we can cancel mid-speech)
let _activeAudio     = null;
let _playbackChain   = Promise.resolve();  // serial playback queue
let _audioGeneration = 0;                  // increment on clear to discard stale callbacks
let _textStreamTimer = null;               // setInterval handle for character-by-character text reveal
let _currentAbortCtrl = null;              // AbortController for the in-flight LLM fetch

// Eagerly fetch the TTS WAV blob — starts immediately, not when playback is ready
async function _fetchTTSBlob(text) {
  try {
    const res = await fetch(`${BACKEND_BASE}/synthesize/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: ttsVoice, speed: 1.0 }),
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch { return null; }
}

// Stream text character by character into `el` from its current value to targetText over `duration` seconds
function _streamTextInto(el, scrollEl, targetText, duration) {
  if (_textStreamTimer !== null) { clearInterval(_textStreamTimer); _textStreamTimer = null; }
  const base  = el.textContent;
  const toAdd = targetText.slice(base.length);
  if (!toAdd.length) return;
  const msPerChar = Math.max(16, (duration * 1000) / toAdd.length);
  let i = 0;
  _textStreamTimer = setInterval(() => {
    i++;
    el.textContent      = base + toAdd.slice(0, i);
    scrollEl.scrollTop  = scrollEl.scrollHeight;
    if (i >= toAdd.length) { clearInterval(_textStreamTimer); _textStreamTimer = null; }
  }, msPerChar);
}

// Play a pre-fetched blob promise; resolves when playback finishes
// onAudioStart (optional): called with the Audio element once metadata is loaded (duration is valid)
async function _playBlob(blobPromise, onAudioStart) {
  setState('speaking');
  const blob = await blobPromise.catch(() => null);
  if (!blob) { setState('idle'); return; }
  return new Promise(resolve => {
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _activeAudio = audio;
    let stopViz = () => {};
    const done  = () => {
      stopViz();
      URL.revokeObjectURL(url);
      _activeAudio = null;
      setState('idle');
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    // Wait for metadata so audio.duration is a valid finite number before starting text stream
    audio.onloadedmetadata = () => {
      // Capture RTT on the very first audio chunk of this response.
      if (_rttStart !== null && lmRtt) {
        const ms = performance.now() - _rttStart;
        lmRtt.textContent = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
        _rttStart = null;  // only measure first-audio; reset for next turn
        // Inject performance note so the model knows its own latency.
        const rttSec = ms / 1000;
        const rttLabel = rttSec < 2 ? 'good' : rttSec < 3.5 ? 'medium' : 'poor';
        const rttFormatted = ms < 1000 ? `${Math.round(ms)} ms` : `${rttSec.toFixed(1)} s`;
        conversationHistory.push({
          role: 'system',
          content: `[System note — not visible to user] Your total response time for the previous reply was ${rttFormatted} (${rttLabel}: sub-2 s = good, 2–3.5 s = medium, above 3.5 s = poor). This is measured from when the user finished speaking to when audio playback began.`
        });
      }
      try { if (onAudioStart) onAudioStart(audio); } catch(e) {}
      // Wire the output through an AnalyserNode so the waveform and sphere
      // react to the TTS audio being played back.
      stopViz = startOutputViz(audio);
      audio.play().catch(done);
    };
    audio.load();
  });
}

// Enqueue a sentence — synthesis starts NOW in parallel, playback waits its turn
// onStart (optional): called just before this sentence's audio begins playing
function enqueueSpeak(text, onStart) {
  if (ttsMode === 'off') {
    if (onStart) onStart();  // TTS off — reveal text immediately
    return;
  }
  if (ttsMode === 'browser') {
    const gen = _audioGeneration;
    _playbackChain = _playbackChain.then(() => {
      if (_audioGeneration !== gen) return;
      if (onStart) onStart();
      return new Promise(resolve => { _speakBrowser(text); resolve(); });
    });
    return;
  }
  // Kick off synthesis immediately so it overlaps with the current sentence playing
  const blobPromise = _fetchTTSBlob(text);
  const gen = _audioGeneration;
  _playbackChain = _playbackChain.then(() => {
    if (_audioGeneration !== gen) return;   // queue was cleared — discard
    return _playBlob(blobPromise, onStart); // onStart(audio) called once playback begins
  });
}

// Stop all current and queued audio immediately
function clearAudioQueue() {
  _audioGeneration++;                       // invalidates all enqueued callbacks
  _playbackChain = Promise.resolve();
  _rttStart = null;                         // discard RTT for abandoned request
  if (_activeAudio) { _activeAudio.pause(); _activeAudio = null; }
  if (_textStreamTimer !== null) { clearInterval(_textStreamTimer); _textStreamTimer = null; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (_currentAbortCtrl) { _currentAbortCtrl.abort(); _currentAbortCtrl = null; }
}

// Interrupt Starling mid-speech or mid-thought. Returns true if something was
// actually cut off (caller can use this to inject an annoyance cue).
function interruptSpeech() {
  const wasActive = _currentAbortCtrl !== null || _activeAudio !== null;
  if (wasActive) clearAudioQueue();
  return wasActive;
}

function _speakBrowser(text) {
  if (!window.speechSynthesis) { setState('idle'); return; }
  window.speechSynthesis.cancel();
  const utt   = new SpeechSynthesisUtterance(text);
  utt.rate    = 0.95;
  utt.pitch   = 0.8;
  utt.onstart = () => setState('speaking');
  utt.onend   = () => setState('idle');
  utt.onerror = () => setState('idle');
  window.speechSynthesis.speak(utt);
}

// ── Toolkit helpers ─────────────────────────────────────────────────────────

/**
 * Reset all toolkit confirm state and return the panel to list view.
 * Safe to call even when toolkit is not open.
 */
function _clearToolkitConfirmState() {
  _toolkitConfirmPending   = false;
  _toolkitPendingTool      = null;
  clearTimeout(_toolkitConfirmTimeoutId);
  _toolkitConfirmTimeoutId = null;
  showToolkitListView();
}

/**
 * Returns true if the lowercased transcript matches any toolkit menu trigger phrase.
 */
function detectToolkitMenuTrigger(text) {
  const t = text.trim();
  return (
    /\b(?:show|open|display|list)\b.{0,20}\b(?:tools?|toolkit|menu)\b/i.test(t) ||
    /\bwhat tools?\b/i.test(t) ||
    /\bshow me (?:your|all) tools?\b/i.test(t) ||
    /\btool (?:menu|list)\b/i.test(t) ||
    /\bsystem\s+(?:settings|menu)\b/i.test(t)
  );
}

// ── Unified input router ──────────────────────────────────────────────────────
// Handles all trigger intercepts; falls through to the LLM for unmatched input.
// Called by both handleSend (text path) and mediaRecorder.onstop (voice path).
async function _routeInput(text) {
  // ── Toolkit confirm intercept (position 1 — must be first) ────────────────
  if (_toolkitConfirmPending) {
    const t = text.trim().toLowerCase();
    if (/\b(?:yes|yeah|yep|sure|do it|activate|open it|confirm)\b/.test(t)) {
      window.dispatchEvent(new CustomEvent('toolkit:confirm', { detail: { confirmed: true } }));
      return;
    }
    if (/\b(?:no|nope|cancel|never mind|nevermind|back|go back|close)\b/.test(t)) {
      window.dispatchEvent(new CustomEvent('toolkit:confirm', { detail: { confirmed: false } }));
      return;
    }
  }

  // ── Journal dictation mode: next mic press = a new segment ─────────────
  // Checked FIRST — while journalMode is active, consume all input here.
  if (journalMode) {
    logEvent('tool_dispatch', { tool: 'journal', trigger_phrase: text });
    if (detectJournalSubmit(text)) {
      if (!journalHasSegments()) {
        // No content yet — just acknowledge and stay in mode
        const spoken = 'Nothing recorded yet. Speak your journal entry, then say submit.';
        appendMessage('user', text);
        const { txt } = appendMessage('assistant', spoken);
        enqueueSpeak(spoken, () => { txt.textContent = spoken; });
        return;
      }
      setState('thinking');
      appendMessage('user', text);
      const { txt: statusTxt } = appendMessage('assistant', 'Generating summary…');
      _pendingJournalStatusTxt = statusTxt;
      await submitJournalEntry(_callLLMSilently, SYSTEM_PROMPT);
      setState('idle');
    } else if (interviewMode) {
      // Mic press during interview = answer to the current question
      setState('thinking');
      await handleInterviewAnswer(text, _callLLMSilently, enqueueSpeak, SYSTEM_PROMPT);
      setState('idle');
    } else {
      appendJournalSegment(text);
    }
    return;
  }

  // ── Ideas capture mode: next mic/text press = the idea ───────────────────
  // Checked FIRST — while ideasMode is active, all input is consumed as an idea.
  if (ideasMode) {
    logEvent('tool_dispatch', { tool: 'ideas', trigger_phrase: text });
    setState('thinking');
    appendMessage('user', text);
    const { spoken } = await processIdea(text, sendToOllama, SYSTEM_PROMPT);
    const { txt } = appendMessage('assistant', spoken);
    enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    setState('idle');
    fetchSystemStatus();
    return;
  }

  // ── Wikipedia article mode: route all input to wiki chat ─────────────────
  if (wikiMode) {
    if (detectWikiExitTrigger(text)) {
      exitWikiMode();
      setState('idle');
      return;
    }
    logEvent('tool_dispatch', { tool: 'wiki', trigger_phrase: text });
    appendWikiMessage('user', text);
    setState('thinking');
    await sendWikiChat(text, false);
    fetchSystemStatus();
    return;
  }

  // Keep news / weather panel open when the user wants to discuss;
  // dismiss all other overlapping tool panels.
  if (isNewsPanelOpen() || isWeatherPanelOpen()) {
    dismissNonNewsPanels();
  } else {
    dismissAllToolPanels();
  }

  // ── News: explicit close phrase while panel is open ────────────────────────
  if (isNewsPanelOpen() && /\bclose\s+news\b|\bclose\s+(?:the\s+)?(?:news\s+)?briefing\b/i.test(text)) {
    exitNewsMode();
    appendMessage('user', text);
    const ack = 'News briefing closed.';
    const { txt: newsTxt } = appendMessage('assistant', ack);
    enqueueSpeak(ack, () => { newsTxt.textContent = ack; });
    setState('idle');
    fetchSystemStatus();
    return;
  }

  // ── Weather: explicit close phrase while panel is open ────────────────────
  if (isWeatherPanelOpen() && /\bclose\s+(?:the\s+)?weather\b/i.test(text)) {
    closeWeatherPanel();
    appendMessage('user', text);
    const ack = 'Weather panel closed.';
    const { txt: wxTxt } = appendMessage('assistant', ack);
    enqueueSpeak(ack, () => { wxTxt.textContent = ack; });
    setState('idle');
    fetchSystemStatus();
    return;
  }

  // ── Browser close phrase ──────────────────────────────────────────────────
  if (isBrowserPanelOpen() && detectBrowserClose(text)) {
    closeBrowserPanel();
    appendMessage('user', text);
    const ack = 'Browser closed.';
    const { txt } = appendMessage('assistant', ack);
    enqueueSpeak(ack, () => { txt.textContent = ack; });
    setState('idle');
    return;
  }

  // ── YouTube close phrase ─────────────────────────────────────────────────────
  if (/\bclose\s+(?:youtube|feed)\b/i.test(text)) {
    exitYouTubeMode();
    appendMessage('user', text);
    const ack = 'YouTube feed closed.';
    const { txt: ytTxt } = appendMessage('assistant', ack);
    enqueueSpeak(ack, () => { ytTxt.textContent = ack; });
    setState('idle');
    return;
  }

  // ── Reddit social close phrase ───────────────────────────────────────────────
  if (/\bclose\s+(?:reddit|social)\b/i.test(text)) {
    exitRedditMode();
    appendMessage('user', text);
    const ack = 'Reddit feed closed.';
    const { txt: redditTxt } = appendMessage('assistant', ack);
    enqueueSpeak(ack, () => { redditTxt.textContent = ack; });
    setState('idle');
    return;
  }

  if (_matchesExitPhrase(text)) {
    exitPresMode();
    setState('idle');
    return;
  }

  // ── Toolkit menu trigger ─────────────────────────────────────────────────
  if (detectToolkitMenuTrigger(text)) {
    openToolkitPanel();
    return;
  }

  const _triggerResult = _parseTrigger(text);
  if (_triggerResult.matched) {
    logEvent('tool_dispatch', { tool: 'dossier', trigger_phrase: text });
    closeBrowserPanel();
    enterPresMode(_triggerResult.subject);
    setState('idle');
    return;
  }

  // ── Wikipedia search trigger ──────────────────────────────────────────────
  const _wikiQuery = detectWikiTrigger(text);
  if (_wikiQuery) {
    logEvent('tool_dispatch', { tool: 'wiki', trigger_phrase: text });
    closeBrowserPanel();
    setState('thinking');
    appendMessage('user', text);
    try {
      const session = await startWikiSession(_wikiQuery);
      enterWikiMode(session.title);
      await sendWikiChat(_wikiQuery, true);   // first turn — backend produces greeting
    } catch (err) {
      const errMsg = err.message.includes('No Wikipedia articles found')
        ? 'The Wikipedia index has not been built yet. Run scripts/ingest_wikipedia.py first.'
        : `Could not start Wikipedia session: ${err.message}`;
      const { txt } = appendMessage('assistant', errMsg);
      enqueueSpeak(errMsg, () => { txt.textContent = errMsg; });
      setState('idle');
    }
    fetchSystemStatus();
    return;
  }

  // ── Journal start trigger ─────────────────────────────────────────────────
  if (detectJournalStartTrigger(text)) {
    logEvent('tool_dispatch', { tool: 'journal', trigger_phrase: text });
    appendMessage('user', text);
    enterJournalMode();
    const spoken = 'Journal entry started. Speak your entry — each mic press adds a segment. Say submit when finished.';
    const { txt } = appendMessage('assistant', spoken);
    enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    return;
  }

  // ── Journal read / search trigger ────────────────────────────────────────
  const _jrnlRead = detectJournalReadTrigger(text);
  if (_jrnlRead) {
    logEvent('tool_dispatch', { tool: 'journal', trigger_phrase: text });
    setState('thinking');
    appendMessage('user', text);
    const jrnlContext = await handleJournalRead(_jrnlRead);
    if (jrnlContext) {
      await sendToOllama(
        'Based on the journal entries provided, give a concise spoken summary. ' +
        'Speak naturally as if briefing the user on their own notes. Two to four sentences.',
        {
          ephemeralMessages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'system', content: jrnlContext },
          ],
        }
      );
    } else {
      const spoken = 'Could not retrieve journal entries right now.';
      const { txt } = appendMessage('assistant', spoken);
      enqueueSpeak(spoken, () => { txt.textContent = spoken; });
      setState('idle');
    }
    fetchSystemStatus();
    return;
  }

  // Timer checked before time to avoid 'timer' matching time patterns
  const _timerTrigger = detectTimerTrigger(text);
  if (_timerTrigger) {
    logEvent('tool_dispatch', { tool: 'timer', trigger_phrase: text });
    setState('idle');
    handleTimerTrigger(text, _timerTrigger);
    return;
  }
  // Date checked before time — phrases are more specific
  if (detectDateTrigger(text)) {
    logEvent('tool_dispatch', { tool: 'date', trigger_phrase: text });
    setState('idle');
    handleDateQuery(text);
    return;
  }
  if (detectTimeTrigger(text)) {
    logEvent('tool_dispatch', { tool: 'time', trigger_phrase: text });
    setState('idle');
    handleTimeQuery(text);
    return;
  }

  // ── Ideas capture trigger — enter single-press capture mode ───────────────
  if (detectIdeaCaptureTrigger(text)) {
    logEvent('tool_dispatch', { tool: 'ideas', trigger_phrase: text });
    appendMessage('user', text);
    enterIdeasMode();
    const spoken = 'Ready. Press the mic and speak your idea.';
    const { txt } = appendMessage('assistant', spoken);
    enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    return;
  }

  // ── Ideas read / management trigger ──────────────────────────────────────
  const _ideaReadTrigger = detectIdeaReadTrigger(text);
  if (_ideaReadTrigger) {
    logEvent('tool_dispatch', { tool: 'ideas', trigger_phrase: text });
    setState('thinking');
    appendMessage('user', text);
    const { spoken, llmContext } = await handleIdeaRead(
      _ideaReadTrigger, sendToOllama, SYSTEM_PROMPT
    );
    if (llmContext) {
      // Let the LLM read the ideas list aloud
      await sendToOllama(
        'Read out this list of ideas naturally. State the total count, then read each title clearly. Keep it concise.',
        {
          ephemeralMessages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'system', content: llmContext },
          ],
        }
      );
    } else if (spoken) {
      const { txt } = appendMessage('assistant', spoken);
      enqueueSpeak(spoken, () => { txt.textContent = spoken; });
      setState('idle');
    }
    fetchSystemStatus();
    return;
  }

  const _wxTrigger = detectWeatherTrigger(text);
  if (_wxTrigger) {
    logEvent('tool_dispatch', { tool: 'weather', trigger_phrase: text });
    closeBrowserPanel();
    setState('thinking');
    appendMessage('user', text);
    const wxResult = await openWeatherPanel(_wxTrigger.location);
    if (wxResult && typeof wxResult === 'object' && wxResult._wxErr) {
      const { txt } = appendMessage('assistant', wxResult._wxErr);
      enqueueSpeak(wxResult._wxErr, () => { txt.textContent = wxResult._wxErr; });
      setState('idle');
      fetchSystemStatus();
      return;
    }
    if (wxResult) {
      await sendToOllama(
        'Give a spoken weather briefing using only the weather data in your context — do not estimate or invent any values. ' +
        'Start with current conditions and how it feels outside. ' +
        'Then describe the upcoming forecast using the exact high temperatures listed for each day. ' +
        'If temperatures are rising or falling significantly over the next few days, say so. ' +
        'Keep it to three or four natural sentences. Phrase temperatures naturally (say "low seventies" for 74°F, "mid-eighties" for 83°F).',
        {
          ephemeralMessages: [
            {
              role: 'system',
              content: SYSTEM_PROMPT + '\n\n[WEATHER DATA — use only these values, do not hallucinate temperatures]\n' + wxResult,
            },
          ],
        }
      );
      _playbackChain.then(() => { /* panel stays open — user can ask follow-up questions */ });
    } else {
      await sendToOllama('Inform the user that weather data could not be retrieved right now. One sentence.');
    }
    fetchSystemStatus();
    return;
  }

  // ── Market / stocks / crypto intercept (checked before news — more specific) ──
  const mktTrigger = detectMarketTrigger(text);
  if (mktTrigger) {
    logEvent('tool_dispatch', { tool: 'stocks', trigger_phrase: text });
    closeBrowserPanel();
    setState('thinking');
    appendMessage('user', text);
    const filterMap = { stocks: 'equity', crypto: 'crypto', all: 'all' };
    const mktContext = await openMarketPanel(filterMap[mktTrigger] ?? 'all');
    if (mktContext) {
      enterMarketMode();
      const focusHint = mktTrigger === 'crypto'
        ? 'Focus primarily on the cryptocurrency positions.'
        : mktTrigger === 'stocks'
          ? 'Focus on the equity and ETF positions.'
          : 'Cover both equities and crypto briefly.';
      await sendToOllama(
        `Deliver a concise spoken market briefing. ${focusHint} ` +
        'Highlight any significant movers. Keep it under thirty seconds when spoken aloud. ' +
        'Do not read every ticker — summarise the overall session tone and call out notable moves.',
        {
          ephemeralMessages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'system', content: `${_currentTimeContext()}\n${mktContext}` },
          ],
        }
      );
    } else {
      await sendToOllama('Inform the user that market data could not be retrieved right now. One sentence.');
    }
    fetchSystemStatus();
    return;
  }

  // ── YouTube feed trigger ───────────────────────────────────────────────────
  const ytMatch = detectYouTubeTrigger(text);
  if (ytMatch) {
    logEvent('tool_dispatch', { tool: 'youtube', trigger_phrase: text });
    closeBrowserPanel();
    setState('thinking');
    appendMessage('user', text);
    enterYouTubeMode();
    const ytContext = await openYouTubePanel({});
    if (ytContext) {
      await sendToOllama(
        "Give me a brief spoken summary of what's new on my YouTube feed. " +
        'For each channel, mention the one or two most interesting recent videos. ' +
        'Keep the whole summary under forty-five seconds when spoken aloud. ' +
        'Mention view counts only if they are noteworthy.',
        {
          ephemeralMessages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'system', content: `${_currentTimeContext()}\n${ytContext}` },
          ],
        }
      );
    } else {
      exitYouTubeMode();
      await sendToOllama('Inform the user that the YouTube feed could not be reached right now. One sentence.');
    }
    fetchSystemStatus();
    return;
  }

  // ── Reddit social feed trigger ─────────────────────────────────────────────
  const redditMatch = detectRedditTrigger(text);
  if (redditMatch) {
    logEvent('tool_dispatch', { tool: 'reddit', trigger_phrase: text });
    closeBrowserPanel();
    setState('thinking');
    appendMessage('user', text);
    const redditContext = await openRedditPanel({});
    if (redditContext) {
      enterRedditMode();
      await sendToOllama(
        "Deliver a concise spoken summary of what's trending on Reddit right now. " +
        'For each subreddit, pick the one or two most interesting posts and describe them in one sentence. ' +
        'Keep the whole briefing under forty-five seconds when spoken aloud. ' +
        'Do not read subreddit names as hashtags — say them naturally, like \'in the technology feed\' or \'on the worldnews subreddit\'.',
        {
          ephemeralMessages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'system', content: `${_currentTimeContext()}\n${redditContext}` },
          ],
        }
      );
    } else {
      await sendToOllama('Inform the user that the Reddit feed could not be reached right now. One sentence.');
    }
    fetchSystemStatus();
    return;
  }

  const newsCategory = detectNewsTrigger(text);
  if (newsCategory) {
    logEvent('tool_dispatch', { tool: 'news', trigger_phrase: text });
    closeBrowserPanel();
    setState('thinking');
    appendMessage('user', text);
    const newsContext = await openNewsPanel(newsCategory);
    if (newsContext) {
      enterNewsMode();
      await sendToOllama(
        'Deliver a concise spoken news briefing based on the headlines provided. ' +
        'Pick the four or five most significant stories and summarise each in one sentence. ' +
        'Group related stories naturally if they appear. ' +
        'Keep the whole briefing under sixty seconds when spoken aloud. ' +
        'Do not read source names aloud unless they add important context.',
        {
          ephemeralMessages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'system', content: `${_currentTimeContext()}\n${newsContext}` },
          ],
        }
      );
    } else {
      await sendToOllama('Inform the user that the news feeds could not be reached right now. One sentence.');
    }
    fetchSystemStatus();
    return;
  }

  // ── Browser / web trigger ────────────────────────────────────────────────────
  const _browserTrigger = detectBrowserTrigger(text);
  if (_browserTrigger) {
    logEvent('tool_dispatch', { tool: 'browser', trigger_phrase: text, url: _browserTrigger.url });
    setState('thinking');
    appendMessage('user', text);
    openBrowserPanel(_browserTrigger.url);
    await sendToOllama(
      `The user has opened ${_browserTrigger.label} in the browser panel. ` +
      `In two or three natural spoken sentences: confirm the page is open and that you are reading its content, ` +
      `then let the user know they can ask you to summarize it, answer questions about it, or explain anything on the page.`,
      {
        ephemeralMessages: [
          { role: 'system', content: SYSTEM_PROMPT },
        ],
      }
    );
    fetchSystemStatus();
    return;
  }

  // ── Wikipedia section summary ────────────────────────────────────────────────
  // Only fires when a Wikipedia page is open and the transcript matches
  // "summarize section X" or "summarize the X section".
  const _wikiSection = detectWikiSectionTrigger(text);
  if (_wikiSection) {
    setState('thinking');
    appendMessage('user', text);
    try {
      const _secRes  = await fetch(
        `${BACKEND_BASE}/api/browser/wiki-section` +
        `?url=${encodeURIComponent(getBrowserPageUrl())}` +
        `&section=${encodeURIComponent(_wikiSection)}`
      );
      const _secData = await _secRes.json();
      if (_secData.text) {
        await sendToOllama(
          `Summarize the following section titled "${_secData.section}" from the Wikipedia article. ` +
          `Speak naturally in three to five sentences. Do not repeat the section title at the start.` +
          `\n\nSECTION CONTENT:\n${_secData.text}`,
          { ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }] }
        );
      } else {
        const _available = _secData.available_sections?.length
          ? ` Available sections include: ${_secData.available_sections.slice(0, 8).join(', ')}.`
          : '';
        await sendToOllama(
          `Inform the user that the section "${_wikiSection}" was not found in the current Wikipedia article.${_available} Keep it to two sentences.`,
          { ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }] }
        );
      }
    } catch (err) {
      console.error('[wiki-section] fetch failed:', err.message);
      await sendToOllama(
        'Inform the user that you were unable to retrieve the requested Wikipedia section due to a network error. One sentence.',
        { ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }] }
      );
    }
    fetchSystemStatus();
    return;
  }

  appendMessage('user', text);
  let _extraContext = null;
  if (isBrowserPanelOpen()) {
    const _pageCtx = await ensureBrowserPageText();
    if (_pageCtx) {
      _extraContext =
        `The user is currently viewing a webpage in the browser panel. ` +
        `The full text content of that page is provided below. ` +
        `When the user asks you to summarize, explain, analyse, or answer questions, ` +
        `use this page content as your primary source — do not rely on prior knowledge ` +
        `unless the page content is insufficient.\n\nPAGE CONTENT:\n${_pageCtx}`;
    } else if (getBrowserPageUrl()) {
      // Page text unavailable — distinguish JS-rendered SPA from a plain fetch failure.
      if (getBrowserJsRendered()) {
        _extraContext =
          `The user has a browser panel open showing: ${getBrowserPageUrl()}. ` +
          `This page is a JavaScript single-page application (SPA). The backend fetched its HTML ` +
          `but received no readable text content because the page renders entirely in the browser via JS. ` +
          `You cannot read, summarize, or describe its actual content. ` +
          `Explicitly tell the user that this page uses client-side JavaScript rendering and its content ` +
          `cannot be extracted. Do NOT guess or fabricate what the page might contain.`;
      } else {
        _extraContext =
          `The user has a browser panel open showing: ${getBrowserPageUrl()}. ` +
          `The page content could not be read (the backend fetch failed or returned no text). ` +
          `Tell the user you were unable to read the page — do NOT guess or fabricate its contents.`;
      }
    }
  }
  logEvent('tool_dispatch', { tool: 'llm_fallback', trigger_phrase: text });

  // Inject currently-selected news article or open weather data as context
  const _newsArticleCtx  = isNewsPanelOpen()    ? getActiveArticleContext() : null;
  const _weatherCtx      = isWeatherPanelOpen() ? getWeatherContext()       : null;
  const _combinedCtx = [_extraContext, _newsArticleCtx, _weatherCtx].filter(Boolean).join('\n\n') || null;

  await sendToOllama(text, _combinedCtx ? { extraContext: _combinedCtx } : {});
  fetchSystemStatus();
}

// ── Text send handler ─────────────────────────────────────────────────────────
async function handleSend() {
  const text = textInput.value.trim();
  if (!text) return;
  logEvent('user_text', { text });
  _rttStart = performance.now();
  clearAudioQueue();
  textInput.value = '';
  await _routeInput(text);
}

sendBtn.addEventListener('click', handleSend);
textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});
textInput.addEventListener('input', _dismissClockPanel);

// ── Clear conversation ────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  clearAudioQueue();
  dismissAllToolPanels();    // calls exitJournalMode() which resets journalMode
  _pendingJournalStatusTxt = null;
  exitPresMode();
  conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
  chatInner.innerHTML = '';
  setState('idle');
});

// ── MediaRecorder → Whisper STT ───────────────────────────────────────────────
let mediaRecorder = null;
let audioChunks   = [];

async function startRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') return; // guard
  clearAudioQueue();  // interrupt any ongoing speech
  _dismissClockPanel();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startAudioViz(stream);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : '';
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    audioChunks   = [];

    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };

    mediaRecorder.onstop = async () => {
      stopAudioViz();
      stream.getTracks().forEach(t => t.stop());

      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 1024) {
        setState('idle');   // recording was too short / empty — silently ignore
        return;
      }

      setState('transcribing');

      const form = new FormData();
      form.append('audio', blob, 'recording.webm');

      try {
        const r = await fetch(`${BACKEND_BASE}/transcribe/`, { method: 'POST', body: form });
        if (!r.ok) throw new Error(`STT ${r.status}`);
        const { transcript } = await r.json();
        if (!transcript) { setState('idle'); return; }

        logEvent('user_speech_frontend', { transcript });

        // Preserve RTT timestamp across clearAudioQueue before routing
        const rttSnap = _rttStart;
        clearAudioQueue();
        _rttStart = rttSnap;
        await _routeInput(transcript);
      } catch (err) {
        appendMessage('assistant', `[STT error: ${err.message}]`);
        setState('error');
        setTimeout(() => setState('idle'), 4000);
      }
    };

    mediaRecorder.start();
    micBtn.classList.add('recording');
    setState('listening');
  } catch (err) {
    appendMessage('assistant', `[Mic error: ${err.message}]`);
    setState('error');
    setTimeout(() => setState('idle'), 4000);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    _rttStart = performance.now();          // start RTT clock for voice path
    mediaRecorder.stop();
    micBtn.classList.remove('recording');
  }
}

// Push-to-talk — mouse
// Use document-level mouseup so cursor drift off the button mid-speech does not stop recording.
let _micMouseDown = false;
micBtn.addEventListener('mousedown', () => { _micMouseDown = true;  startRecording(); });
document.addEventListener('mouseup',  () => { if (_micMouseDown) { _micMouseDown = false; stopRecording(); } });

// Push-to-talk — touch
micBtn.addEventListener('touchstart', e => { e.preventDefault(); startRecording(); });
micBtn.addEventListener('touchend',   e => { e.preventDefault(); stopRecording();  });

// Push-to-talk — spacebar (only when text input is not focused)
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && document.activeElement !== textInput && !e.repeat) {
    e.preventDefault();
    startRecording();
  }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space' && document.activeElement !== textInput) {
    e.preventDefault();
    stopRecording();
  }
});

// ── Greeting & model warm-up ─────────────────────────────────────────────────
const GREETING_TEXT =
  `All systems nominal. S.T.A.R.L.I.N.G. online — running ${MODEL} locally on GPU. How can I assist?`;

// Synthesise the greeting to pre-heat Kokoro, then POST the returned WAV to
// /transcribe so the Whisper CUDA session is initialised before the user ever
// presses the mic.
// greetingEl: the <span> holding the placeholder text — updated to the full
// greeting once the warm-up sequence has fully completed.
async function warmupModels(greetingEl) {
  setState('warmup');
  try {
    const blob = await _fetchTTSBlob(_sanitiseForTTS(GREETING_TEXT));
    if (blob) {
      // Warm up Whisper — POST the real speech WAV and discard the transcript.
      // Awaited so fetchSystemStatus() below reflects the post-init GPU state.
      const fd = new FormData();
      fd.append('audio', new File([blob], 'warmup.wav', { type: 'audio/wav' }));
      await fetch(`${BACKEND_BASE}/transcribe/`, { method: 'POST', body: fd }).catch(() => {});
      // Note: we intentionally do NOT play the greeting here. audio.play() is blocked
      // by the browser autoplay policy until the user has made a gesture on the page.
    }
  } catch { /* warm-up failures are non-fatal */ }
  // Both Kokoro and Whisper have now completed their first inference pass — poll
  // system-status so the GPU badges in the footer are populated before the user speaks.
  await fetchSystemStatus();
  // Reveal the full greeting only once everything is ready.
  if (greetingEl) greetingEl.textContent = GREETING_TEXT;
  setState('idle');
}

// ── Init ──────────────────────────────────────────────────────────────────────
initTimerPanel({ appendMessage, setState, enqueueSpeak });
initWeatherPanel({ enqueueSpeak });
initRedditPanel({ enqueueSpeak, sendToOllama, interruptSpeech });
initYouTubePanel({ enqueueSpeak, sendToOllama, interruptSpeech });
initNewsPanel({ enqueueSpeak, sendToOllama, interruptSpeech, onClose: exitNewsMode });
initToolkitPanel(TOOLKIT_REGISTRY);
initSphere();
statModel.textContent = MODEL;
_applyTtsMode();
loadVoices();
fetchContextLimit();
_loadManifest();  // Phase 4: load subject→image manifest for dynamic dossier images
_setMktSendToOllama(sendToOllama);  // provide LLM callback to stocks panel briefing
_setMktOnClose(exitMarketMode);     // close button returns to conversation mode

// ── YouTube close button ────────────────────────────────────────────────────
document.getElementById('yt-close-btn')?.addEventListener('click', () => {
  exitYouTubeMode();
  setState('idle');
});

// ── Reddit close button ──────────────────────────────────────────────────────
document.getElementById('reddit-close-btn')?.addEventListener('click', () => {
  exitRedditMode();
  setState('idle');
});

// ── Toolkit menu button ──────────────────────────────────────────────────────
document.getElementById('toolkit-menu-btn')?.addEventListener('click', () => {
  openToolkitPanel();
});

// ── Wikipedia close button ────────────────────────────────────────────────────
document.getElementById('wiki-close-btn')?.addEventListener('click', () => {
  exitWikiMode();
  setState('idle');
});

// ── Toolkit menu event handlers ──────────────────────────────────────────────
window.addEventListener('toolkit:tool-selected', async (e) => {
  _clearToolkitConfirmState();
  _toolkitPendingTool     = e.detail;
  _toolkitConfirmPending  = true;
  showToolkitConfirmView(e.detail.name);

  const responseEl = document.getElementById('toolkit-confirm-response');
  if (responseEl) responseEl.textContent = '…';

  const spoken = await _callLLMSilently(
    `The user is browsing the Starling toolkit menu and has selected the tool called "${e.detail.name}". ` +
    `Here is its description: ${e.detail.description} ` +
    `In one or two concise sentences, tell the user what this tool does, then ask them plainly whether they would like to activate it now.`,
    [{ role: 'system', content: SYSTEM_PROMPT }],
  );

  if (responseEl) responseEl.textContent = spoken || '';
  if (spoken) enqueueSpeak(spoken);

  _toolkitConfirmTimeoutId = setTimeout(() => {
    _clearToolkitConfirmState();
    closeToolkitPanel();
    enqueueSpeak('Okay, closing the toolkit menu.');
  }, 20000);
});

window.addEventListener('toolkit:confirm', (e) => {
  clearTimeout(_toolkitConfirmTimeoutId);
  if (e.detail.confirmed && _toolkitPendingTool) {
    const tool = _toolkitPendingTool;
    _clearToolkitConfirmState();
    closeToolkitPanel();
    tool.openFn();
  } else {
    _clearToolkitConfirmState();
    // Panel stays open — user returned to list view
  }
});
wireJournalButtons({
  onSubmit: async () => {
    if (!journalHasSegments()) return;
    setState('thinking');
    const { txt: statusTxt } = appendMessage('assistant', 'Generating summary…');
    _pendingJournalStatusTxt = statusTxt;
    await submitJournalEntry(_callLLMSilently, SYSTEM_PROMPT);
    setState('idle');
  },
  onConfirm: async () => {
    const saved = await confirmJournalEntry();
    const spoken = saved ? 'Journal entry saved.' : 'Could not save the entry. Please try again.';
    if (_pendingJournalStatusTxt) {
      _pendingJournalStatusTxt.textContent = spoken;
      _pendingJournalStatusTxt = null;
      enqueueSpeak(spoken, () => {});
    } else {
      const { txt } = appendMessage('assistant', spoken);
      enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    }
    setState('idle');
  },
  onRerecord: () => {
    rerecordJournalEntry();
    if (_pendingJournalStatusTxt) _pendingJournalStatusTxt = null;
  },
  onDiscard: () => {
    exitJournalMode();
    const spoken = 'Journal entry discarded.';
    if (_pendingJournalStatusTxt) {
      _pendingJournalStatusTxt.textContent = spoken;
      _pendingJournalStatusTxt = null;
      enqueueSpeak(spoken, () => {});
    } else {
      const { txt } = appendMessage('assistant', spoken);
      enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    }
    setState('idle');
  },
  onEntriesClose: () => {
    exitJournalMode();
  },
  onInterviewer: async () => {
    setState('thinking');
    await enterInterviewMode(_callLLMSilently, enqueueSpeak, SYSTEM_PROMPT);
    setState('idle');
  },
});
const { txt: _greetingTxt } = appendMessage('assistant', 'INITIALISING…');
warmupModels(_greetingTxt);  // async — heats Kokoro + Whisper, then reveals greeting
