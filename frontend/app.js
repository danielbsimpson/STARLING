// ── Imports ───────────────────────────────────────────────────────────────────
import { BACKEND_BASE, BOOT_ANIMATION_MS, SHUTDOWN_ANIMATION_MS, SLEEP_AFTER_MS, SLEEP_ANIMATION_MS, WAKE_ANIMATION_MS, READY_POLL_INTERVAL_MS, READY_POLL_TIMEOUT_MS } from './config.js';
import { detectTimerTrigger, handleTimerTrigger, initTimerPanel, dismissTimerPanel } from './timer-panel.js';
import { detectWeatherTrigger, openWeatherPanel, closeWeatherPanel, initWeatherPanel, isWeatherPanelOpen, getWeatherContext } from './weather-panel.js';
import { detectNewsTrigger, openNewsPanel, closeNewsPanel, initNewsPanel, isNewsPanelOpen, getActiveArticleContext } from './news-panel.js';
import { detectRedditTrigger, openRedditPanel, closeRedditPanel, initRedditPanel, openRedditSettings } from './reddit-panel.js';
import { detectYouTubeTrigger, openYouTubePanel, closeYouTubePanel, initYouTubePanel, openYouTubeSettings } from './youtube-panel.js';
import { detectMarketTrigger, openMarketPanel, closeMarketPanel, openStockSettings, setSendToOllama as _setMktSendToOllama, setOnClose as _setMktOnClose } from './stocks-panel.js';
import { detectCalendarTrigger, openCalendarPanel, closeCalendarPanel, isCalendarPanelOpen } from './calendar-panel.js';
import { detectMailTrigger, openMailPanel, closeMailPanel, isMailPanelOpen } from './mail-panel.js';
import { detectBrowserTrigger, detectBrowserClose, detectWikiSectionTrigger, isBrowserPanelOpen, openBrowserPanel, closeBrowserPanel, getBrowserPageText, ensureBrowserPageText, getBrowserPageUrl, getBrowserJsRendered } from './browser-panel.js';
import { detectSystemStatusTrigger, handleSystemStatusTrigger, initSystemPanel, showSystemPanel } from './system-panel.js';
import { initLogDashboard, showLogDashboard } from './log-dashboard.js';
import { detectFuzzyToolIntent } from './fuzzy-tool-detect.js';
import { getInterruptPhrase } from './interrupt-phrases.js';
import { easeOutCubic, easeInCubic, easeInOutQuad, easeOutBack, easeInOutSine } from './animation-easings.js';
import { IDLE_FX_CONFIG, eventEnvelope, blinkEnvelope, makeIdleScheduler } from './idle-expressiveness.js';
import { ORB_BEHAVIOR_CONFIG, warmthForState, temperatureToRGB, steerOrb, integrateOrbPosition, shouldStartChase, pickChasePair } from './orb-behavior.js';
import {
  GLOW_CONFIG,
  glowColorForState,
  bloomStrengthForState,
  smoothToward,
  smoothColor,
} from './ambient-fx.js';
import { initNebula } from './nebula-bg.js';
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
import { loadPrompts, getPrompt } from './prompts.js';
import { openPromptsPanel, closePromptsPanel } from './prompts-panel.js';
import { openSoulPanel, closeSoulPanel } from './soul-panel.js';

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
      getPrompt('DOSSIER_NO_SUBJECT'),
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
      getPrompt('DOSSIER_NOT_FOUND'),
      { ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }] }
    );
  }
}

function exitPresMode() {
  _presSubject = null;
  starlingEl.classList.remove('pres-mode');
  presTitle.textContent  = 'SUBJECT UNKNOWN';  presBody.textContent   = 'Awaiting intelligence data. No records on file for this subject.';
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
  _injectPortfolioAnalystContext();
}

function exitMarketMode() {
  starlingEl.classList.remove('mkt-mode');
  // Drop the analyst context so it doesn't linger in unrelated conversation.
  conversationHistory = conversationHistory.filter(
    m => !(m.role === 'system' && m.content.includes(STOCKS_ANALYST_MARKER))
  );
  closeMarketPanel();
}

/**
 * Fetch the portfolio analyst persona + live PORTFOLIO DATA block and inject it
 * as a persistent system message so the user can discuss their holdings while the
 * market panel is open. Fire-and-forget; failures are non-fatal.
 */
async function _injectPortfolioAnalystContext() {
  try {
    const res = await fetch(`${BACKEND_BASE}/stocks/portfolio/analysis`);
    if (!res.ok) throw new Error(`/portfolio/analysis ${res.status}`);
    const data = await res.json();
    const ctx  = data && data.llm_context;
    if (!ctx) return;

    // Remove any stale analyst context before adding the fresh one.
    conversationHistory = conversationHistory.filter(
      m => !(m.role === 'system' && m.content.includes(STOCKS_ANALYST_MARKER))
    );
    conversationHistory.push({ role: 'system', content: ctx });
  } catch (err) {
    console.error('[app] portfolio analyst context:', err);
  }
}

function enterMailMode() {
  starlingEl.classList.add('mail-mode');
}

function exitMailMode() {
  starlingEl.classList.remove('mail-mode');
  closeMailPanel();
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

// ── Toolkit manifest (Tier 1 — tool awareness) ───────────────────────────────
// Plain-prose description of every active tool, appended to SYSTEM_PROMPT so
// Starling can describe her own capabilities without hallucinating.
//
// CO-CHANGE NOTE: When a tool is added to or removed from _routeInput(), update
// this block AND FUZZY_TOOL_MAP in fuzzy-tool-detect.js AND the switch in
// _retriggerTool(). All three are kept in sync deliberately.
const TOOLKIT_MANIFEST_BLOCK =
  'You have access to the following built-in tools. When the user asks what you can do, ' +
  'which tools are available, or whether you support a specific capability, describe these ' +
  'tools accurately in plain natural prose — do not use markdown or bullet points. ' +

  'Dossier: opens a full-screen intelligence briefing panel with a subject portrait and an automatic spoken report. ' +
  'Say "open dossier on [name]", "show dossier for [name]", or "pull up the dossier". ' +

  'Timer: sets and tracks multiple named countdown timers in-browser with an audio chime on completion. ' +
  'Say "set a timer for [duration]", "set a [name] timer for [duration]", "cancel timer", or "what timers are running". ' +

  'Time: speaks the current local time instantly with no backend or LLM call. ' +
  'Say "what time is it", "what\'s the time", or "current time". ' +

  'Date: speaks today\'s full date instantly with no backend or LLM call. ' +
  'Say "what\'s today\'s date", "what day is it", or "what date is it today". ' +

  'Weather: fetches live local conditions and a 7-day forecast from Open-Meteo — no API key required. ' +
  'Say "what\'s the weather", "weather today", "weather forecast", or "weather in [city]". ' +

  'News: delivers a spoken briefing from live RSS feeds across categories: tech, business, US, science, health, sports, entertainment, and world. ' +
  'Say "news briefing", "what\'s in the news", "tech news", "morning briefing", or "top headlines". ' +

  'Stocks and Market: shows a live market dashboard with equity and cryptocurrency prices, charts, and a spoken overview. ' +
  'Say "show me the market", "crypto prices", "bitcoin price", "show stocks", or "how are the markets". ' +

  'Browser: opens an in-UI browser panel for navigating web pages, Wikipedia lookups, and web search. ' +
  'Say "open the browser", "browser search for [topic]", or "browser wikipedia [topic]". ' +

  'Ideas Vault: captures, stores, searches, and reads back ideas saved to a local JSON file. ' +
  'Say "open ideas vault", "store an idea in the vault", "save to the ideas vault", or "search the vault for [topic]". ' +

  'Voice Journal: records multi-segment dictated entries, generates an AI summary and tags, and saves them locally. ' +
  'Say "start a journal entry", "new journal entry", "show journal", or "read my journal". ' +

  'Wikipedia RAG: searches a locally-embedded offline Simple English Wikipedia index — no internet required. ' +
  'Say "search local Wikipedia for [topic]", "local wiki [topic]", or "offline Wikipedia [topic]". ' +

  'Calendar: fetches iCloud calendar events for today and the coming week via CalDAV — requires Apple ID and App-Specific Password. ' +
  'Say "show my calendar", "what\'s on my schedule", "any meetings today", or "open calendar". ' +

  'Mail: fetches unread Apple Mail messages via IMAP and delivers a spoken inbox briefing. ' +
  'Say "check my email", "view inbox", "any new emails", or "check mail". ' +

  'YouTube: opens the YouTube feed panel with the latest videos from your subscribed channels. ' +
  'Say "open youtube feed" or "view youtube feed". ' +

  'Reddit: opens the Reddit social feed with top posts from your configured subreddits. ' +
  'Say "open reddit social" or "view reddit social". ' +

  'Toolkit Menu: opens a browsable overlay listing every active tool with its description and example trigger phrases. ' +
  'Say "show tools", "open toolkit", "what tools do you have", "tool menu", or "show the menu".';

// SYSTEM_PROMPT is rebuilt after fetchSystemStatus() in warmupModels() with real device values.
// Initialised here with fallback device strings so it is never empty before warmup completes.
let SYSTEM_PROMPT =
  _buildInitialContext() + ' ' +
  getPrompt('STARLING_PERSONA', { whisper_device: 'CUDA', kokoro_device: 'CUDA', llm_device: 'CUDA' }) +
  ' ' + TOOLKIT_MANIFEST_BLOCK;

// ── Calendar login helpers (used by TOOLKIT_REGISTRY renderExtraFn) ──────────

async function _renderCalendarLogin(container) {
  container.innerHTML = '';
  let cred = { linked: false, username: null };
  try {
    const res = await fetch(`${BACKEND_BASE}/calendar/credentials`);
    if (res.ok) cred = await res.json();
  } catch (_) { /* offline — render as unlinked */ }

  if (cred.linked) {
    const badge = document.createElement('div');
    badge.className = 'cal-login-status';
    const dot  = document.createElement('span'); dot.className  = 'cal-login-dot';
    const label = document.createElement('span'); label.className = 'cal-login-label-text'; label.textContent = 'LOGGED IN AS ';
    const user = document.createElement('span'); user.className  = 'cal-login-user'; user.textContent = cred.username;
    badge.append(dot, label, user);
    container.appendChild(badge);
  }

  const loginBtn = document.createElement('button');
  loginBtn.className = 'toolkit-activate-btn cal-login-btn';
  loginBtn.textContent = cred.linked ? 'CHANGE LOGIN' : 'LOGIN';
  loginBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (cred.linked) {
      _showCalendarLoginConfirm(container, cred.username);
    } else {
      _showCalendarLoginForm(container);
    }
  });
  container.appendChild(loginBtn);
}

function _showCalendarLoginConfirm(container, currentUsername) {
  container.innerHTML = '';

  const warning = document.createElement('div');
  warning.className = 'cal-login-warning';
  const msg = document.createElement('p');
  msg.className = 'cal-login-warning-msg';
  msg.textContent = `This will remove the current login for ${currentUsername}. The new account will become the saved default.`;
  warning.appendChild(msg);
  container.appendChild(warning);

  const btnRow = document.createElement('div');
  btnRow.className = 'cal-login-btn-row';

  const yesBtn = document.createElement('button');
  yesBtn.className = 'toolkit-activate-btn';
  yesBtn.textContent = 'YES, CONTINUE';

  const noBtn = document.createElement('button');
  noBtn.className = 'toolkit-back-btn';
  noBtn.textContent = '\u2190 CANCEL';

  noBtn.addEventListener('click', e => { e.stopPropagation(); _renderCalendarLogin(container); });
  yesBtn.addEventListener('click', e => { e.stopPropagation(); _showCalendarLoginForm(container); });

  btnRow.append(yesBtn, noBtn);
  container.appendChild(btnRow);
}

function _showCalendarLoginForm(container) {
  container.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'cal-login-form-title';
  title.textContent = 'APPLE CALENDAR LOGIN';
  container.appendChild(title);

  const hint = document.createElement('p');
  hint.className = 'cal-login-hint';
  hint.textContent = 'Enter your Apple ID and an App-Specific Password from appleid.apple.com';
  container.appendChild(hint);

  const userWrap = document.createElement('div'); userWrap.className = 'cal-login-field';
  const userLabel = document.createElement('label'); userLabel.className = 'cal-login-label'; userLabel.textContent = 'APPLE ID';
  const userInput = document.createElement('input');
  userInput.type = 'email'; userInput.className = 'cal-login-input'; userInput.placeholder = 'your@apple.id';
  userWrap.append(userLabel, userInput);
  container.appendChild(userWrap);

  const passWrap = document.createElement('div'); passWrap.className = 'cal-login-field';
  const passLabel = document.createElement('label'); passLabel.className = 'cal-login-label'; passLabel.textContent = 'APP PASSWORD';
  const passInput = document.createElement('input');
  passInput.type = 'password'; passInput.className = 'cal-login-input'; passInput.placeholder = 'xxxx-xxxx-xxxx-xxxx';
  passWrap.append(passLabel, passInput);
  container.appendChild(passWrap);

  const errMsg = document.createElement('div');
  errMsg.className = 'cal-login-error hidden';
  container.appendChild(errMsg);

  const btnRow = document.createElement('div');
  btnRow.className = 'cal-login-btn-row';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'toolkit-activate-btn';
  saveBtn.textContent = 'SAVE';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'toolkit-back-btn';
  cancelBtn.textContent = '\u2190 CANCEL';

  cancelBtn.addEventListener('click', e => { e.stopPropagation(); _renderCalendarLogin(container); });

  saveBtn.addEventListener('click', async e => {
    e.stopPropagation();
    const username = userInput.value.trim();
    const password = passInput.value;
    if (!username || !password) {
      errMsg.textContent = 'Both Apple ID and App Password are required.';
      errMsg.classList.remove('hidden');
      return;
    }
    saveBtn.textContent = 'SAVING...';
    saveBtn.disabled = true;
    try {
      const res = await fetch(`${BACKEND_BASE}/calendar/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || `HTTP ${res.status}`);
      }
      await _renderCalendarLogin(container);
    } catch (err) {
      errMsg.textContent = `Save failed: ${err.message}`;
      errMsg.classList.remove('hidden');
      saveBtn.textContent = 'SAVE';
      saveBtn.disabled = false;
    }
  });

  btnRow.append(saveBtn, cancelBtn);
  container.appendChild(btnRow);
}

// ── Mail login helpers ────────────────────────────────────────────────────────
async function _renderMailLogin(container) {
  container.innerHTML = '';

  let cred = { configured: false, username: '' };
  try {
    const res = await fetch(`${BACKEND_BASE}/mail/credentials`);
    if (res.ok) cred = await res.json();
  } catch (_) { /* offline — render as unconfigured */ }

  if (cred.configured) {
    const badge = document.createElement('div');
    badge.className = 'cal-login-status';
    const dot   = document.createElement('span'); dot.className   = 'cal-login-dot';
    const label = document.createElement('span'); label.className = 'cal-login-label-text'; label.textContent = 'LOGGED IN AS ';
    const user  = document.createElement('span'); user.className  = 'cal-login-user'; user.textContent = cred.username;
    badge.append(dot, label, user);
    container.appendChild(badge);
  }

  const loginBtn = document.createElement('button');
  loginBtn.className = 'toolkit-activate-btn cal-login-btn';
  loginBtn.textContent = cred.configured ? 'CHANGE LOGIN' : 'LOGIN';
  loginBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (cred.configured) {
      _showMailLoginConfirm(container, cred.username);
    } else {
      _showMailLoginForm(container);
    }
  });
  container.appendChild(loginBtn);
}

function _showMailLoginConfirm(container, currentUsername) {
  container.innerHTML = '';

  const warning = document.createElement('div');
  warning.className = 'cal-login-warning';
  const msg = document.createElement('p');
  msg.className = 'cal-login-warning-msg';
  msg.textContent = `This will remove the current login for ${currentUsername}. The new account will become the saved default.`;
  warning.appendChild(msg);
  container.appendChild(warning);

  const btnRow = document.createElement('div');
  btnRow.className = 'cal-login-btn-row';

  const yesBtn = document.createElement('button');
  yesBtn.className = 'toolkit-activate-btn';
  yesBtn.textContent = 'YES, CONTINUE';

  const noBtn = document.createElement('button');
  noBtn.className = 'toolkit-back-btn';
  noBtn.textContent = '\u2190 CANCEL';

  noBtn.addEventListener('click', e => { e.stopPropagation(); _renderMailLogin(container); });
  yesBtn.addEventListener('click', e => { e.stopPropagation(); _showMailLoginForm(container); });

  btnRow.append(yesBtn, noBtn);
  container.appendChild(btnRow);
}

function _showMailLoginForm(container) {
  container.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'cal-login-form-title';
  title.textContent = 'APPLE MAIL LOGIN';
  container.appendChild(title);

  const hint = document.createElement('p');
  hint.className = 'cal-login-hint';
  hint.textContent = 'Enter your Apple ID and the App-Specific Password used for Apple Mail';
  container.appendChild(hint);

  const userWrap = document.createElement('div'); userWrap.className = 'cal-login-field';
  const userLabel = document.createElement('label'); userLabel.className = 'cal-login-label'; userLabel.textContent = 'APPLE ID';
  const userInput = document.createElement('input');
  userInput.type = 'email'; userInput.className = 'cal-login-input'; userInput.placeholder = 'your@apple.id';
  userWrap.append(userLabel, userInput);
  container.appendChild(userWrap);

  const passWrap = document.createElement('div'); passWrap.className = 'cal-login-field';
  const passLabel = document.createElement('label'); passLabel.className = 'cal-login-label'; passLabel.textContent = 'APP PASSWORD';
  const passInput = document.createElement('input');
  passInput.type = 'password'; passInput.className = 'cal-login-input'; passInput.placeholder = 'xxxx-xxxx-xxxx-xxxx';
  passWrap.append(passLabel, passInput);
  container.appendChild(passWrap);

  const errMsg = document.createElement('div');
  errMsg.className = 'cal-login-error hidden';
  container.appendChild(errMsg);

  const btnRow = document.createElement('div');
  btnRow.className = 'cal-login-btn-row';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'toolkit-activate-btn';
  saveBtn.textContent = 'SAVE';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'toolkit-back-btn';
  cancelBtn.textContent = '\u2190 CANCEL';

  cancelBtn.addEventListener('click', e => { e.stopPropagation(); _renderMailLogin(container); });

  saveBtn.addEventListener('click', async e => {
    e.stopPropagation();
    const username = userInput.value.trim();
    const password = passInput.value;
    if (!username || !password) {
      errMsg.textContent = 'Both Apple ID and App Password are required.';
      errMsg.classList.remove('hidden');
      return;
    }
    saveBtn.textContent = 'SAVING...';
    saveBtn.disabled = true;
    try {
      const res = await fetch(`${BACKEND_BASE}/mail/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || `HTTP ${res.status}`);
      }
      await _renderMailLogin(container);
    } catch (err) {
      errMsg.textContent = `Save failed: ${err.message}`;
      errMsg.classList.remove('hidden');
      saveBtn.textContent = 'SAVE';
      saveBtn.disabled = false;
    }
  });

  btnRow.append(saveBtn, cancelBtn);
  container.appendChild(btnRow);
}

// ── Toolkit registry ─────────────────────────────────────────────────────────
// One entry per active tool. openFn is a zero-argument closure that activates
// the tool; it is called by the toolkit:confirm handler in app.js.
const TOOLKIT_REGISTRY = [
  {
    id: 'dossier',
    name: 'Dossier',
    description: 'Opens a full-screen personnel briefing panel with subject profile, portrait, and an automatic spoken intelligence report.',
    ttsScript: 'Dossier mode displays a full-screen personnel briefing with subject profile, portrait, and a spoken intelligence report. Say: open dossier, or click Activate to launch it.',
    phrases: ['open dossier', 'show dossier on Daniel Simpson', 'pull up the dossier for Quinn'],
    openFn: () => enterPresMode(null),
  },
  {
    id: 'timer',
    name: 'Timer',
    description: 'Sets and tracks multiple named countdown timers entirely in-browser, with a Web Audio API chime on completion.',
    ttsScript: 'The Timer tool sets named countdown timers in the browser with an audio chime on completion. Say something like: set a timer for five minutes.',
    phrases: ['set a timer for five minutes', 'set a ten minute timer', 'timer for 2 minutes 30 seconds', 'cancel timer', 'cancel all timers'],
    openFn: () => enqueueSpeak('Timer tool ready. Tell me how long to set a timer for.'),
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Speaks the current local time instantly with no backend call or LLM involved.',
    ttsScript: 'The Time tool speaks the current local time instantly, with no internet or backend call needed.',
    phrases: ['what time is it', "what's the time", 'current time', 'tell me the time', 'time now'],
    openFn: () => handleTimeQuery('what time is it'),
  },
  {
    id: 'date',
    name: 'Date',
    description: 'Speaks today\'s full date instantly with no backend call or LLM involved.',
    ttsScript: "The Date tool speaks today's full date instantly, with no internet or backend call needed.",
    phrases: ["what's today's date", 'what day is it', 'what day of the week is it', 'what date is it today'],
    openFn: () => handleDateQuery("what's today's date"),
  },
  {
    id: 'weather',
    name: 'Weather',
    description: 'Fetches live local weather conditions and a 7-day forecast using Open-Meteo with no API key required.',
    ttsScript: "The Weather tool fetches live local conditions and a seven-day forecast using Open-Meteo. No API key required. Say: what's the weather.",
    phrases: ["what's the weather", 'weather today', 'weather forecast', 'weather report', 'how is it looking outside'],
    openFn: () => openWeatherPanel(),
  },
  {
    id: 'news',
    name: 'News',
    description: 'Delivers a spoken news briefing summarised from live RSS feeds across multiple categories and regions.',
    ttsScript: 'The News tool delivers a spoken briefing summarised from live RSS feeds across multiple categories. Say: give me a news briefing.',
    phrases: ['give me a news briefing', "what's in the news", 'latest headlines', 'morning briefing'],
    openFn: () => { openNewsPanel(); enterNewsMode(); },
  },
  {
    id: 'stocks',
    name: 'Stocks & Market',
    description: 'Displays a live market dashboard with equity and cryptocurrency prices, charts, and a spoken briefing.',
    ttsScript: 'The Market tool displays a live dashboard with equity and crypto prices, charts, and a spoken briefing. Say: show me the market.',
    phrases: ['show me the market', 'what are my stocks doing', 'crypto prices', 'show stocks', 'bitcoin price'],
    openFn: () => { openMarketPanel('all').then(ctx => { if (ctx) enterMarketMode(); }); },
    renderExtraFn: (container) => {
      const btn = document.createElement('button');
      btn.className   = 'toolkit-settings-btn';
      btn.textContent = '⚙ STOCK SETTINGS';
      btn.title       = 'Edit tracked tickers and share counts';
      btn.addEventListener('click', e => { e.stopPropagation(); openStockSettings(); });
      container.appendChild(btn);
    },
  },
  {
    id: 'youtube',
    name: 'YouTube Feed',
    description: 'Displays a live feed of recent videos from your tracked YouTube channels, with filtering, sorting, and a spoken briefing.',
    ttsScript: 'The YouTube Feed tool displays recent videos from your tracked channels, with filtering and a spoken briefing. Say: open YouTube feed.',
    phrases: ['open YouTube feed', 'view YouTube feed'],
    openFn: async () => {
      closeBrowserPanel();
      enterYouTubeMode();
      const ytContext = await openYouTubePanel({});
      if (ytContext) {
        await sendToOllama(
          "Give me a brief spoken summary of what's new on my YouTube feed. " +
          'For each channel, mention the one or two most interesting recent videos. ' +
          'Keep the whole summary under forty-five seconds when spoken aloud.',
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
    },
    renderExtraFn: (container) => {
      const btn = document.createElement('button');
      btn.className   = 'toolkit-settings-btn';
      btn.textContent = '⚙ YOUTUBE CHANNELS';
      btn.title       = 'Add or remove tracked YouTube channels';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        closeToolkitPanel();
        enterYouTubeMode();
        openYouTubeSettings();
      });
      container.appendChild(btn);
    },
  },
  {
    id: 'reddit',
    name: 'Reddit Social',
    description: 'Displays trending posts from your tracked subreddits, with per-subreddit filtering and a spoken briefing.',
    ttsScript: 'The Reddit Social tool displays trending posts from your tracked subreddits, with filtering and a spoken briefing. Say: open Reddit social.',
    phrases: ['open Reddit social', 'view Reddit social'],
    openFn: async () => {
      closeBrowserPanel();
      const redditContext = await openRedditPanel({});
      if (redditContext) {
        enterRedditMode();
        await sendToOllama(
          "Deliver a concise spoken summary of what's trending on Reddit right now. " +
          'For each subreddit, pick the one or two most interesting posts and describe them in one sentence. ' +
          'Keep the whole briefing under forty-five seconds when spoken aloud.',
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
    },
    renderExtraFn: (container) => {
      const btn = document.createElement('button');
      btn.className   = 'toolkit-settings-btn';
      btn.textContent = '⚙ SUBREDDITS';
      btn.title       = 'Add or remove tracked subreddits';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        closeToolkitPanel();
        enterRedditMode();
        openRedditSettings();
      });
      container.appendChild(btn);
    },
  },
  {
    id: 'browser',
    name: 'Browser',
    description: 'Opens an in-UI browser panel so you can navigate any webpage and ask Starling to read, summarise, or answer questions about it.',
    ttsScript: 'The Browser tool opens an in-display browser panel. I can navigate any webpage and read, summarise, or answer questions about it. Say: open the browser.',
    phrases: ['open the browser', 'open browser', 'browse to a website', 'look up something in the browser'],
    openFn: () => openBrowserPanel(),
  },
  {
    id: 'ideas',
    name: 'Ideas Vault',
    description: 'Captures, stores, searches, and reads back your ideas in a local JSON vault using voice or text input.',
    ttsScript: 'The Ideas Vault stores, organises, and reads back your ideas using voice or text. Say: open ideas vault, or: store an idea in the vault.',
    phrases: ['open ideas vault', 'store an idea in the vault', 'save to the ideas vault', 'search the vault for', 'what is in the ideas vault'],
    openFn: () => enterIdeasMode(),
  },
  {
    id: 'journal',
    name: 'Voice Journal',
    description: 'Records a multi-segment voice journal entry, generates an AI summary, and saves it to a local file.',
    ttsScript: 'The Voice Journal records a multi-segment entry, generates an AI summary, and saves it locally. Say: start a journal entry.',
    phrases: ['start a journal entry', 'new journal entry', 'begin a journal entry', 'show journal', 'read my journal'],
    openFn: () => enterJournalMode(),
  },
  {
    id: 'wiki',
    name: 'Wikipedia RAG',
    description: 'Searches a locally-embedded Wikipedia index using ChromaDB and answers questions entirely offline with no internet required.',
    ttsScript: 'Wikipedia RAG searches a locally-embedded Wikipedia index and answers questions entirely offline. Say: search local Wikipedia for, followed by your topic.',
    phrases: ['search local Wikipedia for', 'local wiki article on', 'offline Wikipedia search', 'look up offline'],
    openFn: () => enqueueSpeak('Wikipedia RAG ready. Ask me to look up any topic offline, for example: search Wikipedia for Albert Einstein.'),
  },
  {
    id: 'calendar',
    name: 'Calendar',
    description: 'Fetches and displays your iCloud calendar events for today and the coming week via CalDAV. Requires an Apple ID and App-Specific Password.',
    ttsScript: 'The Calendar tool fetches your iCloud events for today and the coming week. Say: show my calendar.',
    phrases: ['show my calendar', 'what is on my schedule', 'check my calendar', 'any meetings today', 'open calendar'],
    openFn: () => openCalendarPanel(),
    renderExtraFn: (container) => _renderCalendarLogin(container),
  },
  {
    id: 'mail',
    name: 'Mail',
    description: 'Check Apple Mail inbox — view unread emails and get a spoken summary.',
    ttsScript: 'The Mail tool fetches your unread Apple Mail messages via IMAP and delivers a spoken inbox briefing. Say: check my email.',
    phrases: ['check my email', 'view inbox', 'any new emails', 'check mail', 'unread messages'],
    openFn: async () => {
      const ctx = await openMailPanel(true);
      if (ctx) {
        enterMailMode();
        logEvent('mail_inbox_snapshot', { llm_context: ctx });
        await sendToOllama(getPrompt('MAIL_INBOX_SUMMARY') + '\n\n' + ctx, {
          ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }],
        });
      }
    },
    renderExtraFn: (container) => _renderMailLogin(container),
  },
];

// ── Conversation state ────────────────────────────────────────────────────────
let conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];

// Stable marker present in the injected portfolio analyst context; used to find
// and remove stale copies when re-entering or leaving market mode.
const STOCKS_ANALYST_MARKER = '[PORTFOLIO DATA';

// Reference to the assistant message <p> element showing journal status text.
// Kept here so confirm/discard/rerecord callbacks can update the same bubble.
let _pendingJournalStatusTxt = null;

// ── Toolkit confirm state ─────────────────────────────────────────────────────
let _toolkitConfirmPending    = false;
let _toolkitPendingTool       = null;
let _toolkitConfirmTimeoutId  = null;

// ── Fuzzy tool confirm state (Tier 2 — fuzzy recovery) ────────────────────────
let _fuzzyConfirmPending = false;
let _fuzzyPendingTool    = null;
let _fuzzyTimeoutId      = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const starlingEl  = document.getElementById('starling');
const chatInner   = document.getElementById('chat-inner');
const micBtn      = document.getElementById('mic-btn');
const textInput   = document.getElementById('text-input');
const sendBtn     = document.getElementById('send-btn');
const clearBtn    = document.getElementById('clear-btn');
const powerBtn    = document.getElementById('power-btn');

// ── Power / shutdown ──────────────────────────────────────────────────────────
// _sphereAnimPhase mirrors the animation state inside initSphere().
// 'booting' | 'shutting_down' | 'none'
let _sphereAnimPhase = 'none';

// Filled in by initSphere() once the Three.js scene is ready.
// Falls back to calling _triggerSystemShutdown() directly if sphere is unavailable.
let _startShutdownAnim = function () {
  _triggerSystemShutdown();
};

// ── Sleep / wake animation triggers (overwritten by initSphere()) ──────────────
// Fallbacks fire the completion callbacks directly when Three.js is unavailable.
let _startSleepAnim = function () { _onSleepAnimationComplete(); };
let _startWakeAnim  = function () { _onWakeAnimationComplete();  };

// ── Dev-only animation replays (overwritten by initSphere(); gated on ?dev=1) ──
let _replayBootAnim      = function () {};
let _previewShutdownAnim = function () {};

// ── Sleep mode state ──────────────────────────────────────────────────────────
let _isSleeping           = false;   // true while sleep overlay is showing
let _sleepEnteredAt       = 0;       // Date.now() when sleep was triggered
let _lastActivityTs       = Date.now();  // updated on every user interaction
let _lastDreamCheckpointTs = null;   // ISO 8601 UTC; updated after each sleep dream
let _currentSessionId     = null;   // cached from GET /health on startup

const sleepOverlay = document.getElementById('sleep-overlay');

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
 * Disables controls, resets sphere state, then kicks off the retreat animation.
 * If the sphere is unavailable, _startShutdownAnim() falls back to calling
 * _triggerSystemShutdown() directly.
 */
function startShutdown() {
  [micBtn, sendBtn, textInput, powerBtn].forEach(el => el && (el.disabled = true));
  setState('idle');
  _startShutdownAnim();
}

// ── Sleep / wake lifecycle ─────────────────────────────────────────────────────

/** Mark the current moment as the last user activity (resets the sleep timer). */
function _resetActivity() {
  _lastActivityTs = Date.now();
}

/** Called by animate() (or the no-sphere fallback) when the sleep animation ends. */
function _onSleepAnimationComplete() {
  sleepOverlay && sleepOverlay.classList.add('visible');
  _triggerSleepDream();
}

/** Called by animate() (or the no-sphere fallback) when the wake animation ends. */
function _onWakeAnimationComplete() {
  starlingEl.classList.remove('sleep-mode');
  [micBtn, sendBtn, textInput, powerBtn].forEach(el => el && (el.disabled = false));
  setState('idle');
  _resetActivity();
  _sendWakeGreeting();
}

/**
 * Transition the UI into sleep mode: disable controls, start the retreat
 * animation (sphere drifts off into space), then show the sleep overlay.
 */
function enterSleepMode() {
  if (_isSleeping || _sphereAnimPhase !== 'none') return;
  _isSleeping     = true;
  _sleepEnteredAt = Date.now();
  [micBtn, sendBtn, textInput, powerBtn].forEach(el => el && (el.disabled = true));
  setState('idle');
  starlingEl.classList.add('sleep-mode');
  _startSleepAnim();
}

/**
 * Wake from sleep: hide overlay, play the sphere approach animation,
 * then re-enable controls and greet the user.
 */
function wakeSleepMode() {
  if (!_isSleeping || _sphereAnimPhase !== 'none') return;
  _isSleeping = false;
  sleepOverlay && sleepOverlay.classList.remove('visible');
  _startWakeAnim();
}

/**
 * Fire-and-forget dream run after sleep.  Polls /dream/status until a pass
 * completes, then updates the checkpoint timestamp.
 */
async function _triggerSleepDream() {
  if (!_currentSessionId) return;
  const body = { session_id: _currentSessionId, from_ts: _lastDreamCheckpointTs };
  fetch(`${BACKEND_BASE}/dream/run`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }).catch(() => {});  // intentional fire-and-forget

  // Poll until at least one pass completes, then record the checkpoint.
  const pollId = setInterval(async () => {
    try {
      const r = await fetch(`${BACKEND_BASE}/dream/status`);
      if (!r.ok) return;
      const data = await r.json();
      if (data.completed_passes && data.completed_passes.length > 0) {
        _lastDreamCheckpointTs = new Date().toISOString();
        clearInterval(pollId);
      }
    } catch { /* non-fatal */ }
  }, 10000);
}

/**
 * Greet the user when they return from sleep.  Injects an ephemeral system
 * note with the elapsed idle time into the LLM context without persisting it
 * to conversationHistory.  The assistant response IS appended and spoken.
 */
async function _sendWakeGreeting() {
  const elapsedMin = Math.round((Date.now() - _sleepEnteredAt) / 60000);
  const systemNote = elapsedMin >= 1
    ? `The user has just returned after approximately ${elapsedMin} minute${elapsedMin !== 1 ? 's' : ''} of inactivity. Greet them warmly and briefly — one or two sentences maximum. Do not refer to yourself as having been asleep.`
    : `The user has just returned. Greet them briefly — one sentence.`;

  // Build the outbound message list: ephemeral system note + existing history.
  // The system note is NOT pushed to conversationHistory; it is request-only.
  const messages = [{ role: 'system', content: systemNote }, ...conversationHistory];

  const { wrap, txt } = appendMessage('assistant', '');
  wrap.classList.add('streaming');
  setState('thinking');

  try {
    const res = await fetch(`${BACKEND_BASE}/chat/`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.trim()) continue;
        try {
          const token = JSON.parse(line)?.message?.content ?? '';
          full += token;
          txt.textContent = full;
          chatInner.scrollTop = chatInner.scrollHeight;
        } catch { /* skip partial chunks */ }
      }
    }

    wrap.classList.remove('streaming');
    if (full) {
      conversationHistory.push({ role: 'assistant', content: full });
      if (ttsMode !== 'off') {
        setState('speaking');
        enqueueSpeak(full, () => { txt.textContent = full; });
      } else {
        txt.textContent = full;
        setState('idle');
      }
    } else {
      setState('idle');
    }
  } catch {
    wrap.classList.remove('streaming');
    setState('idle');
  }
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
    closeToolkitPanel();   // close the menu so the orb exit animation is visible
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
const voicePicker   = document.getElementById('voice-picker');
const voiceTestBtn    = document.getElementById('voice-test-btn');
const voiceDefaultBtn = document.getElementById('voice-default-btn');
const ttsEngineEl     = document.getElementById('tts-engine');
const llmCtxInput   = document.getElementById('llm-ctx-input');
const llmCtxSaveBtn = document.getElementById('llm-ctx-save-btn');
const llmCtxNote    = document.getElementById('llm-ctx-note');
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
const UI_HOVER_IDS = ['mic-btn', 'send-btn', 'clear-btn', 'tts-toggle', 'voice-picker', 'text-input'];
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

// ── User-tunable LLM context size (persisted backend setting) ─────────────────
let _ctxSettingMin = 2048;
let _ctxSettingMax = 131072;

async function loadLlmCtxSetting() {
  if (!llmCtxInput) return;
  try {
    const res = await fetch(`${BACKEND_BASE}/system/llm-settings`);
    if (!res.ok) return;
    const s = await res.json();
    if (s.ctx_min) { _ctxSettingMin = s.ctx_min; llmCtxInput.min = s.ctx_min; }
    if (s.ctx_max) { _ctxSettingMax = s.ctx_max; llmCtxInput.max = s.ctx_max; }
    if (s.ctx_size) llmCtxInput.value = s.ctx_size;
  } catch { /* backend offline — leave input blank */ }
}

async function saveLlmCtxSetting() {
  if (!llmCtxInput || !llmCtxSaveBtn) return;
  const val = parseInt(llmCtxInput.value, 10);
  if (!Number.isFinite(val) || val < _ctxSettingMin || val > _ctxSettingMax) {
    if (llmCtxNote) {
      llmCtxNote.textContent = `Enter ${_ctxSettingMin}–${_ctxSettingMax} tokens.`;
      llmCtxNote.classList.add('llm-ctx-note--error');
    }
    return;
  }
  const original = llmCtxSaveBtn.textContent;
  llmCtxSaveBtn.disabled = true;
  llmCtxSaveBtn.textContent = 'SAVING…';
  try {
    const res = await fetch(`${BACKEND_BASE}/system/llm-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ctx_size: val }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (llmCtxNote) {
      llmCtxNote.textContent = 'Saved — applies on next restart.';
      llmCtxNote.classList.remove('llm-ctx-note--error');
    }
    llmCtxSaveBtn.textContent = 'SAVED';
    setTimeout(() => { llmCtxSaveBtn.textContent = original; }, 1500);
  } catch {
    if (llmCtxNote) {
      llmCtxNote.textContent = 'Save failed.';
      llmCtxNote.classList.add('llm-ctx-note--error');
    }
    llmCtxSaveBtn.textContent = original;
  } finally {
    llmCtxSaveBtn.disabled = false;
  }
}

llmCtxSaveBtn && llmCtxSaveBtn.addEventListener('click', saveLlmCtxSetting);

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
      let ctxClass = 'lm-ctx-fill';
      if (pct >= 90)      ctxClass += ' crit';
      else if (pct >= 70) ctxClass += ' warn';
      lmCtxFill.className = ctxClass;
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
  return patterns.some(p => p.test(t));
}

/**
 * Detect a date query in a Whisper transcript.
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
  return patterns.some(p => p.test(t));
}

/** Format the current time into a natural spoken phrase. */
function _formatTimeSpoken(now) {
  const h  = now.getHours();
  const m  = now.getMinutes();
  const hr12 = h % 12 === 0 ? 12 : h % 12;

  let min;
  if (m === 0)      min = 'on the hour';
  else if (m < 10)  min = `oh ${m}`;
  else              min = String(m);

  let period;
  if (h < 12)      period = 'in the morning';
  else if (h < 17) period = 'in the afternoon';
  else if (h < 21) period = 'in the evening';
  else             period = 'at night';

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
  exitMailMode();
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

/** Shared clock display + speak logic for time and date queries. */
function _handleClockQuery(transcript, formatSpokenFn) {
  const now = new Date();
  const tz  = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeDisplay = now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });
  const dateDisplay = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  _showClockPanel(timeDisplay, dateDisplay, tz);
  const spoken = formatSpokenFn(now);
  appendMessage('user', transcript);
  const { txt } = appendMessage('assistant', spoken);
  setState('speaking');
  enqueueSpeak(spoken, () => { txt.textContent = spoken; });
}

function handleTimeQuery(transcript) {
  _handleClockQuery(transcript, _formatTimeSpoken);
}

function handleDateQuery(transcript) {
  _handleClockQuery(transcript, _formatDateSpoken);
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

  const RING_SIZE = 210;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(RING_SIZE, RING_SIZE);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Clear to fully transparent so neither the direct render nor the bloom
  // EffectComposer paints an opaque background. Without this the composer's
  // full-frame passes tone-map the cleared black buffer to an opaque grey disc
  // (clipped to a circle by the canvas border-radius/mask).
  renderer.setClearColor(0x000000, 0);
  if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.z = 6.2;

  // ── Post-processing bloom composer (GOAL-002, TASK-010) ───────────────────
  // Built from window.STARLING_FX which is populated by the importmap shim in
  // index.html before this module runs. When the shim fails (CDN unreachable),
  // STARLING_FX is undefined and _bloomEnabled stays false, activating the
  // Fresnel-shell fallback (GOAL-002b) defined further below.
  let _bloomEnabled  = false;
  let composer       = null;
  let bloomPass      = null;

  if (window.STARLING_FX) {
    try {
      const { EffectComposer, RenderPass, UnrealBloomPass, OutputPass } = window.STARLING_FX;
      composer  = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      bloomPass = new UnrealBloomPass(
        new THREE.Vector2(RING_SIZE, RING_SIZE),
        GLOW_CONFIG.bloomStrengthIdle,
        GLOW_CONFIG.bloomRadius,
        GLOW_CONFIG.bloomThreshold,
      );
      composer.addPass(bloomPass);
      composer.addPass(new OutputPass());
      _bloomEnabled = true;
    } catch (_err) {
      console.warn('S.T.A.R.L.I.N.G.: bloom composer failed, falling back to Fresnel-shell glow');
    }
  }
  // When the OS requests reduced motion we play a short plain dolly for each
  // lifecycle phase.
  const _prefersReducedMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Lifecycle choreography config ──────────────────────────────────────────
  // Tunable parameters per phase — designers can adjust here without touching
  // the animate() branches. See plan/feature-lifecycle-animations-2.md §2.
  const BOOT_CHOREO = {
    camStartZ: 95, camEndZ: 6.2,
    lateralAmpStart: 6.0, lateralAmpEnd: 0.0,
    swirlFreq: 4.2, sphereSpinTurns: 1.4,
    orbRadiusStart: 3.4, orbRadiusEnd: 1.65,
    orbSpeedStart: 0.35, orbSpeedEnd: 1.0,
  };
  const SHUTDOWN_CHOREO = {
    camStartZ: 6.2, camEndZ: 110,
    lateralSweep: 9, verticalSweep: 5,
    sphereTumbleTurns: 0.9,
    orbRadiusEnd: 3.2, orbOpacityEnd: 0.0, fadeStart: 0.55,
  };
  const SLEEP_CHOREO = {
    camStartZ: 6.2, camEndZ: 14,
    lateralDrift: 8, verticalDrift: 3,
    sphereTiltX: 0.85,
    orbSpeedScale: 0.35, orbOpacityEnd: 0.45,
  };
  const WAKE_CHOREO = {
    camStartZ: 14, camEndZ: 6.2,
    lateralDriftStart: 8, verticalDriftStart: 1.8,
    sphereTiltStart: 0.85,
    orbSpeedStart: 0.35, orbOpacityStart: 0.45,
  };

  // ── Runtime animation offsets (driven by the lifecycle choreography) ───────
  // These modulate steady-state orbit behaviour without mutating orbDefs.
  let _orbRadiusMult = 1.0;   // scales each orb's orbit radius
  let _orbOpacity    = 1.0;   // applied to orb material opacity + light intensity
  let _sphereSpinY   = 0;     // sphere/rim spin about Y
  let _sphereTiltX   = 0;     // sphere/rim tilt about X
  let _devShutdownPreview = false;   // when true, shutdown anim restores instead of going offline
  const idleFx = makeIdleScheduler(IDLE_FX_CONFIG);
  let _idleEventSeqSeen = -1;
  let _blinkSeqSeen     = -1;
  let _idleBrightOrbIdx = -1;
  let _rippleOriginX    = 0;
  let _rippleOriginY    = 0;
  let _rippleOriginZ    = 1;

  // ── Glow colour / strength state (eased each frame in animate()) ───────────
  let _glowColor    = { ...GLOW_CONFIG.idleColor };  // current eased glow colour {r,g,b}
  let _glowStrength = GLOW_CONFIG.bloomStrengthIdle; // current eased bloom / Fresnel strength

  // ── Lifecycle in-place flag ─────────────────────────────────────────────────
  // The lifecycle choreography (boot/shutdown/sleep/wake) plays in the sphere's
  // normal ring location — it is NOT re-parented to a full-viewport overlay, so
  // the orb animates exactly where Starling lives instead of jumping to a
  // separate centred panel. The flag only drives the halo fade.
  let _lifecycleStaged = false;

  /** Mark the lifecycle animation as active (fades the ring halo). */
  function _expandCanvasForLifecycle() {
    if (_prefersReducedMotion) return;        // skip under reduced motion
    if (_lifecycleStaged) return;             // already staged
    _lifecycleStaged = true;
    starlingEl.classList.add('is-lifecycle-animating');
    _applyFullscreenView();
  }

  /** Reverse _expandCanvasForLifecycle(): clear the lifecycle-active state. */
  function _restoreCanvasToRing() {
    if (!_lifecycleStaged) return;            // not staged
    _lifecycleStaged = false;
    starlingEl.classList.remove('is-lifecycle-animating');
    _restoreRingView();
  }

  // ── Fullscreen lifecycle view ──────────────────────────────────────────────
  // Expanding the canvas to the viewport removes the circular 210 px clip that
  // otherwise cuts off the travelling orbs (the "black wall"). To avoid the
  // sphere jumping to the screen centre, we keep its on-screen pixel size
  // constant by widening the vertical FOV in proportion to the taller canvas,
  // and use camera.setViewOffset to re-anchor the optical centre on the ring.
  const _ORIG_FOV = 40;

  function _applyFullscreenView() {
    const ringWrap = document.querySelector('.ring-wrap');
    if (!ringWrap) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const rect = ringWrap.getBoundingClientRect();
    const rcx  = rect.left + rect.width / 2;
    const rcy  = rect.top  + rect.height / 2;

    const ratio = h / RING_SIZE;
    const vFov  = THREE.MathUtils.radToDeg(
      2 * Math.atan(ratio * Math.tan(THREE.MathUtils.degToRad(_ORIG_FOV) / 2))
    );
    camera.fov    = vFov;
    camera.aspect = w / h;
    camera.setViewOffset(w, h, w / 2 - rcx, h / 2 - rcy, w, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (_bloomEnabled && composer) composer.setSize(w, h); // TASK-011
  }

  function _restoreRingView() {
    camera.clearViewOffset();
    camera.fov    = _ORIG_FOV;
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    renderer.setSize(RING_SIZE, RING_SIZE);
    if (_bloomEnabled && composer) composer.setSize(RING_SIZE, RING_SIZE); // TASK-011
  }



  // ── Boot / shutdown animation state ───────────────────────────────────────
  // Camera starts far away for the boot approach; _animPhase drives the animate() block.
  let _animPhase = 'booting';
  let _animStart = Date.now();
  _sphereAnimPhase = 'booting';
  camera.position.z = 80;   // override — boot animation will travel to 6.2
  _expandCanvasForLifecycle();   // boot plays screen-filling (TASK-007)

  // Allow startShutdown() (outside this closure) to trigger the retreat animation.
  _startShutdownAnim = function () {
    _animPhase       = 'shutting_down';
    _animStart       = Date.now();
    _sphereAnimPhase = 'shutting_down';
    _expandCanvasForLifecycle();
  };

  // Allow enterSleepMode() to trigger the sleep retreat animation.
  _startSleepAnim = function () {
    _animPhase       = 'sleeping';
    _animStart       = Date.now();
    _sphereAnimPhase = 'sleeping';
    _expandCanvasForLifecycle();
  };

  // Allow wakeSleepMode() to trigger the wake approach animation.
  _startWakeAnim = function () {
    _animPhase       = 'waking';
    _animStart       = Date.now();
    _sphereAnimPhase = 'waking';
    _expandCanvasForLifecycle();
  };

  // Dev-only: replay the boot choreography (Ctrl+Shift+B with ?dev=1).
  _replayBootAnim = function () {
    if (_sphereAnimPhase !== 'none') return;
    _resetAnimOffsets();
    _animPhase       = 'booting';
    _animStart       = Date.now();
    _sphereAnimPhase = 'booting';
    camera.position.z = 80;
    [micBtn, sendBtn, textInput, powerBtn].forEach(el => el && (el.disabled = true));
    _expandCanvasForLifecycle();
  };

  // Dev-only: preview the shutdown choreography WITHOUT POSTing /system/shutdown
  // (Ctrl+Shift+X with ?dev=1). Restores the ring instead of going offline.
  _previewShutdownAnim = function () {
    if (_sphereAnimPhase !== 'none') return;
    _devShutdownPreview = true;
    _animPhase       = 'shutting_down';
    _animStart       = Date.now();
    _sphereAnimPhase = 'shutting_down';
    _expandCanvasForLifecycle();
  };

  /** Reset all runtime animation offsets to their steady-state values. */
  function _resetAnimOffsets() {
    _orbRadiusMult = 1.0;
    _orbOpacity    = 1.0;
    _sphereSpinY   = 0;
    _sphereTiltX   = 0;
    idleFx.reset();
    _idleEventSeqSeen = -1;
    _blinkSeqSeen     = -1;
    _idleBrightOrbIdx = -1;
    _rippleOriginX    = 0;
    _rippleOriginY    = 0;
    _rippleOriginZ    = 1;
    sphereMesh.rotation.set(0, 0, 0);
    rimMesh.rotation.set(0, 0, 0);
  }

  /** Called once the boot animation finishes. Re-enables all interactive controls. */
  function _onBootAnimationComplete() {
    _animPhase       = 'none';
    _sphereAnimPhase = 'none';
    camera.position.set(0, 0, 6.2);
    _restoreCanvasToRing();
    _resetAnimOffsets();
    // Boot animation is done — but stay blue ("INIT") with controls disabled until
    // model warm-up (LLM ready) has also completed.
    _bootAnimDone = true;
    _finishStartupIfReady();
  }

  /** Called once the shutdown animation finishes. Fires the backend shutdown call. */
  function _onShutdownAnimationComplete() {
    _animPhase       = 'done';
    _sphereAnimPhase = 'none';
    if (_devShutdownPreview) {
      // Dev preview — do NOT shut the system down; restore the ring instead.
      _devShutdownPreview = false;
      _animPhase = 'none';
      camera.position.set(0, 0, 6.2);
      _restoreCanvasToRing();
      _resetAnimOffsets();
      return;
    }
    // Restore skipped — the offline overlay covers everything (TASK-008).
    _triggerSystemShutdown();
  }
  scene.add(new THREE.AmbientLight(0xffffff, 0.025));

  // ── 5 orbiting light orbs ──────────────────────────────────────────────────
  // Each orb is a small visible sphere (MeshBasicMaterial so it always glows)
  // plus a PointLight that illuminates the main sphere.
  // Each orb orbits at a fixed radius in a plane tilted by tiltX / tiltZ —
  // distance from centre is always exactly r, so they can never enter the sphere.
  const ORB_WHITE    = new THREE.Color(0xffffff);
  // The former discrete per-state colours (ORB_BLUE/ORB_GREEN/ORB_YELLOW) are
  // superseded by the continuous colour-temperature ramp (cool → cyan → gold)
  // in orb-behavior.js — state warmth now forms the orb colour baseline. The
  // proximity ("agitated"), UI-hover ("aware") and lifecycle tints below remain
  // higher-priority overrides layered on top of that baseline (REQ-008).
  const ORB_AGITATED = new THREE.Color(0xff8888);  // light red — cursor proximity
  const ORB_AWARE    = new THREE.Color(0xaaccff);  // pale blue — UI hover
  const ORB_COOLWHITE = new THREE.Color(0xddeeff); // cool-white — shutdown / sleep tint

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

  // ── Boid / colour-temperature runtime state (eased each frame) ─────────────
  const _orbMeanSpeed     = orbDefs.reduce((s, p) => s + p.speed, 0) / orbDefs.length;
  let _orbRadiusStateMult = 1.0;  // per-state radius mult (listening tightens orbits)
  let _speedEqualize      = 0;    // 0 = independent speeds, 1 = converge to mean (listening)
  let _micLean            = 0;    // 0..1 bias of the cluster toward the mic (listening)
  let _speakAmp           = 0;    // smoothed output-audio amplitude (speaking pulse)
  let _orbWarmth          = 0;    // smoothed colour-temperature warmth 0..1
  let _chase              = null; // { pair:[a,b], endsAt:ms } during a two-orb chase
  // Preallocated scratch objects — reused every frame so the n² boid loop
  // allocates nothing (CON-002 / RISK-003).
  const _steerTarget = { x: 0, y: 0, z: 0 };
  const _steerAccel  = { x: 0, y: 0, z: 0 };
  const _integrated  = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
  const _neighbors   = [];
  const _tempRGB     = { r: 0, g: 0, b: 0 };
  const _scratchColor = new THREE.Color();
  const _proxColor    = new THREE.Color();

  // Compute an orb's analytic orbit point for angle/radius into `out` {x,y,z}.
  function _orbAnalyticPoint(p, angle, r, out) {
    const lx = r * Math.cos(angle);
    const ly = r * Math.sin(angle);
    const mx = lx;
    const my = ly * Math.cos(p.tiltX);
    const mz = ly * Math.sin(p.tiltX);
    out.x = mx * Math.cos(p.tiltZ) - my * Math.sin(p.tiltZ);
    out.y = mx * Math.sin(p.tiltZ) + my * Math.cos(p.tiltZ);
    out.z = mz;
    return out;
  }

  const orbs = orbDefs.map((p, i) => {
    // Vary orb mesh sizes — gives depth and hierarchy to the assembly
    const orbSizes = [0.075, 0.055, 0.085, 0.048, 0.068, 0.042, 0.078];
    // transparent + depthWrite:false so _orbOpacity fades cleanly during
    // shutdown/sleep without render-order flicker against the dark sphere.
    const mat   = new THREE.MeshBasicMaterial({
      color: ORB_WHITE.clone(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    const mesh  = new THREE.Mesh(new THREE.SphereGeometry(orbSizes[i] ?? 0.065, 10, 10), mat);
    const light = new THREE.PointLight(0xffffff, 3.5, 0, 0);
    scene.add(mesh);
    scene.add(light);
    // Per-orb boid runtime state: integrated angle (theta), current position,
    // velocity, and a fixed ember temperature offset.
    const start = _orbAnalyticPoint(p, p.phase, p.r, { x: 0, y: 0, z: 0 });
    return {
      mesh, mat, light, color: ORB_WHITE.clone(),
      theta: p.phase,
      curPos: { x: start.x, y: start.y, z: start.z },
      vel: { x: 0, y: 0, z: 0 },
      ember: (i / (orbDefs.length - 1) - 0.5) * ORB_BEHAVIOR_CONFIG.emberSpread,
    };
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
    emissiveIntensity: 1.0,
  });
  const sphereMesh = new THREE.Mesh(sphereGeo, sphereMat);
  scene.add(sphereMesh);
  const SPHERE_EMISSIVE_INTENSITY_BASE = sphereMat.emissiveIntensity;

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
  const RIM_OPACITY_BASE = rimMat.opacity;

  // ── GOAL-002b FALLBACK: in-scene additive Fresnel-shell glow ──────────────
  // Activated when window.STARLING_FX is absent or the composer fails to init.
  // A slightly-oversized back-face sphere uses a Fresnel falloff + additive
  // blending to simulate the atmospheric scatter that UnrealBloomPass provides.
  // Uniforms are updated each frame in animate() with the same _glowColor /
  // _glowStrength so visual behaviour matches the bloom path.
  let fresnelUniforms = null;
  if (!_bloomEnabled) {
    fresnelUniforms = {
      uGlowColor:    { value: new THREE.Vector3(
        GLOW_CONFIG.idleColor.r,
        GLOW_CONFIG.idleColor.g,
        GLOW_CONFIG.idleColor.b,
      ) },
      uGlowStrength: { value: GLOW_CONFIG.bloomStrengthIdle },
    };
    const fresnelMat = new THREE.ShaderMaterial({
      vertexShader: [
        'varying vec3 vNormal;',
        'varying vec3 vViewPos;',
        'void main() {',
        '  vNormal  = normalize(normalMatrix * normal);',
        '  vViewPos = (modelViewMatrix * vec4(position, 1.0)).xyz;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3  uGlowColor;',
        'uniform float uGlowStrength;',
        'varying vec3  vNormal;',
        'varying vec3  vViewPos;',
        'void main() {',
        '  vec3  viewDir   = normalize(-vViewPos);',
        '  float fresnel   = 1.0 - abs(dot(vNormal, viewDir));',
        '  float intensity = pow(max(fresnel, 0.0), 1.8) * uGlowStrength;',
        '  gl_FragColor = vec4(uGlowColor * intensity, intensity);',
        '}',
      ].join('\n'),
      uniforms:    fresnelUniforms,
      side:        THREE.BackSide,
      blending:    THREE.AdditiveBlending,
      transparent: true,
      depthWrite:  false,
    });
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.35, 32, 32), fresnelMat));
  }

  function animate() {
    requestAnimationFrame(animate);
    const t     = Date.now() * 0.001;
    const delta = _lastT === null ? 0 : t - _lastT;
    _lastT      = t;
    const state        = sphereStateRef.current;
    const isListening  = state === 'listening';
    const isThinking   = state === 'thinking' || state === 'transcribing';
    const isSpeaking   = state === 'speaking';

    // ── Lifecycle choreography (boot / shutdown / sleep / wake) ──────────────
    // Each phase drives camera + sphere rotation + per-orb offsets, then FALLS
    // THROUGH to the shared orb-update / deformation / render code below so the
    // orbs keep orbiting the entire time (REQ-001). No early return.
    const lifecycleActive = _animPhase !== 'none' && _animPhase !== 'done';
    let _lifecycleSpeedMult = null;   // when set, overrides targetSpeedMult
    let _lifecycleColor     = null;   // when set, overrides orbColorTarget
    const REDUCED_MS = 800;           // short plain dolly under reduced motion

    if (_animPhase === 'booting') {
      const C = BOOT_CHOREO;
      if (_prefersReducedMotion) {
        const p = Math.min((Date.now() - _animStart) / REDUCED_MS, 1);
        camera.position.set(0, 0, THREE.MathUtils.lerp(C.camStartZ, C.camEndZ, easeOutCubic(p)));
        if (p >= 1) _onBootAnimationComplete();
      } else {
        const p = Math.min((Date.now() - _animStart) / BOOT_ANIMATION_MS, 1);
        const easedDolly  = easeOutCubic(p);
        const easedSwirl  = easeInOutQuad(p);
        const easedSettle = easeOutBack(p);
        camera.position.z = THREE.MathUtils.lerp(C.camStartZ, C.camEndZ, easedDolly);
        camera.position.x = C.lateralAmpStart * (1 - easedDolly) * Math.sin(p * Math.PI * C.swirlFreq);
        camera.position.y = C.lateralAmpStart * 0.5 * (1 - easedDolly) * Math.cos(p * Math.PI * C.swirlFreq * 0.78 + 0.9);
        _sphereSpinY        = C.sphereSpinTurns * Math.PI * 2 * (1 - easedSettle);
        _sphereTiltX        = 0;
        _orbRadiusMult      = THREE.MathUtils.lerp(C.orbRadiusStart / C.orbRadiusEnd, 1.0, easedSettle);
        _orbOpacity         = 1.0;
        _lifecycleSpeedMult = THREE.MathUtils.lerp(C.orbSpeedStart, C.orbSpeedEnd, easedSwirl);
        if (p >= 1) _onBootAnimationComplete();
      }
    } else if (_animPhase === 'shutting_down') {
      const C = SHUTDOWN_CHOREO;
      _lifecycleColor = ORB_COOLWHITE;
      if (_prefersReducedMotion) {
        const p = Math.min((Date.now() - _animStart) / REDUCED_MS, 1);
        camera.position.set(0, 0, THREE.MathUtils.lerp(C.camStartZ, C.camEndZ, easeInCubic(p)));
        if (p >= 1) _onShutdownAnimationComplete();
      } else {
        const p = Math.min((Date.now() - _animStart) / SHUTDOWN_ANIMATION_MS, 1);
        const easedDolly = easeInCubic(p);
        camera.position.z = THREE.MathUtils.lerp(C.camStartZ, C.camEndZ, easedDolly);
        camera.position.x = C.lateralSweep * Math.sin(p * Math.PI * 1.7) * easeInOutQuad(p);
        camera.position.y = C.verticalSweep * (p - 0.5) * easeInCubic(Math.max(0, (p - 0.3) / 0.7));
        _sphereSpinY   = C.sphereTumbleTurns * Math.PI * 2 * easeInCubic(p);
        _sphereTiltX   = 0.6 * easeInCubic(p);
        _orbRadiusMult = THREE.MathUtils.lerp(1.0, C.orbRadiusEnd / 1.65, easeInCubic(p));
        _orbOpacity    = p < C.fadeStart ? 1.0 : THREE.MathUtils.lerp(1.0, C.orbOpacityEnd, (p - C.fadeStart) / (1 - C.fadeStart));
        if (p >= 1) _onShutdownAnimationComplete();
      }
    } else if (_animPhase === 'sleeping') {
      const C = SLEEP_CHOREO;
      _lifecycleColor = ORB_COOLWHITE;
      if (_prefersReducedMotion) {
        const p = Math.min((Date.now() - _animStart) / REDUCED_MS, 1);
        camera.position.set(0, 0, THREE.MathUtils.lerp(C.camStartZ, C.camEndZ, easeInOutSine(p)));
        if (p >= 1) {
          _animPhase = 'none'; _sphereAnimPhase = 'none';
          _restoreCanvasToRing(); _resetAnimOffsets();
          _onSleepAnimationComplete();
        }
      } else {
        const p = Math.min((Date.now() - _animStart) / SLEEP_ANIMATION_MS, 1);
        const easedDrift = easeInOutSine(p);
        camera.position.z = THREE.MathUtils.lerp(C.camStartZ, C.camEndZ, easedDrift);
        camera.position.x = C.lateralDrift * easedDrift;
        camera.position.y = C.verticalDrift * Math.sin(p * Math.PI) * 0.6;
        _sphereTiltX        = C.sphereTiltX * easedDrift;
        _sphereSpinY        = 0.3 * Math.PI * easedDrift;
        _lifecycleSpeedMult = THREE.MathUtils.lerp(1.0, C.orbSpeedScale, easedDrift);
        _orbOpacity         = THREE.MathUtils.lerp(1.0, C.orbOpacityEnd, easedDrift);
        _orbRadiusMult      = 1.0;
        if (p >= 1) {
          _animPhase = 'none'; _sphereAnimPhase = 'none';
          // Restore the canvas to the ring right before the sleep overlay reveals.
          _restoreCanvasToRing();
          _resetAnimOffsets();
          _onSleepAnimationComplete();
        }
      }
    } else if (_animPhase === 'waking') {
      const C = WAKE_CHOREO;
      if (_prefersReducedMotion) {
        const p = Math.min((Date.now() - _animStart) / REDUCED_MS, 1);
        camera.position.set(0, 0, THREE.MathUtils.lerp(C.camStartZ, C.camEndZ, easeOutCubic(p)));
        if (p >= 1) {
          camera.position.set(0, 0, 6.2);
          _animPhase = 'none'; _sphereAnimPhase = 'none';
          _restoreCanvasToRing(); _resetAnimOffsets();
          _onWakeAnimationComplete();
        }
      } else {
        const p = Math.min((Date.now() - _animStart) / WAKE_ANIMATION_MS, 1);
        const easedRise = easeOutCubic(p);
        camera.position.z = THREE.MathUtils.lerp(C.camStartZ, C.camEndZ, easedRise);
        camera.position.x = C.lateralDriftStart * (1 - easedRise);
        camera.position.y = C.verticalDriftStart * (1 - easedRise);
        _sphereTiltX        = C.sphereTiltStart * (1 - easedRise);
        _sphereSpinY        = 0.3 * Math.PI * (1 - easedRise);
        _lifecycleSpeedMult = THREE.MathUtils.lerp(C.orbSpeedStart, 1.0, easedRise);
        _orbOpacity         = THREE.MathUtils.lerp(C.orbOpacityStart, 1.0, easedRise);
        _orbRadiusMult      = 1.0;
        if (p >= 1) {
          camera.position.set(0, 0, 6.2);
          _animPhase = 'none'; _sphereAnimPhase = 'none';
          _restoreCanvasToRing();
          _resetAnimOffsets();
          _onWakeAnimationComplete();
        }
      }
    }

    // Apply sphere/rim rotation offsets once per frame (kept in sync — RISK-002).
    sphereMesh.rotation.set(_sphereTiltX, _sphereSpinY, 0);
    rimMesh.rotation.copy(sphereMesh.rotation);

    const idleEligible = state === 'idle' && !lifecycleActive && !_prefersReducedMotion;
    let fx = { event: null, blink: null };
    if (idleEligible) {
      fx = idleFx.update(delta * 1000, true);
    } else {
      idleFx.reset();
      _idleEventSeqSeen = -1;
      _blinkSeqSeen     = -1;
      _idleBrightOrbIdx = -1;
      _rippleOriginX    = 0;
      _rippleOriginY    = 0;
      _rippleOriginZ    = 1;
    }
    if (fx.event && fx.event.seq !== _idleEventSeqSeen) {
      _idleEventSeqSeen = fx.event.seq;
      if (fx.event.kind === 'orbBrighten') {
        _idleBrightOrbIdx = fx.event.seq % orbs.length;
      } else if (fx.event.kind === 'ripple') {
        const originIdx = fx.event.seq % numVerts;
        const ox = origPos[originIdx * 3];
        const oy = origPos[originIdx * 3 + 1];
        const oz = origPos[originIdx * 3 + 2];
        const olen = Math.hypot(ox, oy, oz) || 1;
        _rippleOriginX = ox / olen;
        _rippleOriginY = oy / olen;
        _rippleOriginZ = oz / olen;
      }
    }
    if (fx.blink && fx.blink.seq !== _blinkSeqSeen) {
      _blinkSeqSeen = fx.blink.seq;
    }
    const idleEventEnv = fx.event ? eventEnvelope(fx.event.progress) : 0;
    const blinkDim = fx.blink ? blinkEnvelope(fx.blink.progress) : 0;
    const blinkDimMul = 1 - blinkDim * (1 - IDLE_FX_CONFIG.blinkDimFactor);
    const blinkGlowMul = THREE.MathUtils.lerp(1, IDLE_FX_CONFIG.blinkGlowFactor, blinkDim);
    const blinkRimMul = THREE.MathUtils.lerp(1, IDLE_FX_CONFIG.blinkRimOpacityFactor, blinkDim);

    // ── Mouse proximity computation (once per frame) ─────────────────────────
    // Skipped during lifecycle animations — the cursor's position relative to
    // the expanded canvas is meaningless mid-choreography (TASK-012).
    let proxCurved = 0;
    if (!lifecycleActive) {
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
      // Use a power curve so the red tint is faint at distance and intensifies sharply near the sphere
      proxCurved = Math.pow(proximityVal, 1.8);
    }

    // ── Orb colour override — lifecycle → proximity → UI hover ──────────────
    // The colour-temperature ramp (cool → cyan → gold) forms the per-orb
    // baseline (applied inside the orb loop). These three tints, when active,
    // override that baseline at higher priority (REQ-008). proxCurved drives the
    // "agitated" red exactly as before, layered over the temperature baseline.
    const _reducedMotion = _prefersReducedMotion;
    const now = Date.now();
    let orbOverrideColor = null;
    if (lifecycleActive) {
      // Shutdown/sleep tint to cool-white; boot/wake settle to plain white.
      orbOverrideColor = _lifecycleColor || ORB_WHITE;
    } else if (proximityVal > 0.01) {
      // Reuse a scratch colour so proximity never allocates per frame.
      orbOverrideColor = _proxColor.copy(ORB_AGITATED).lerp(ORB_WHITE, 1 - proxCurved);
    } else if (_uiHovered) {
      orbOverrideColor = ORB_AWARE;
    }

    // Smoothly ramp orbit speed — lifecycle choreography overrides state logic
    let targetSpeedMult;
    if (lifecycleActive)          targetSpeedMult = _lifecycleSpeedMult !== null ? _lifecycleSpeedMult : 1.0;
    else if (isListening)              targetSpeedMult = 1.9;
    else if (isThinking)          targetSpeedMult = 0.2;
    else if (isSpeaking)          targetSpeedMult = 2.2;
    else if (proximityVal > 0.01) targetSpeedMult = 1.0 + proxCurved * 0.8;  // up to 1.8× at sphere edge
    else if (_uiHovered)          targetSpeedMult = 1.15;
    else                          targetSpeedMult = 1.0;
    orbSpeedMult += (targetSpeedMult - orbSpeedMult) * 0.03;
    orbTimeAccum += delta * orbSpeedMult;

    // ── Ease per-state behaviour scalars (continuous — no position jumps) ────
    const _k = delta > 0 ? 1 - Math.exp(-3.0 * delta) : 0;
    const radiusStateTarget = (!lifecycleActive && isListening)
      ? ORB_BEHAVIOR_CONFIG.listenRadiusMult : 1.0;
    _orbRadiusStateMult += (radiusStateTarget - _orbRadiusStateMult) * _k;
    const equalizeTarget = (!lifecycleActive && isListening) ? 1 : 0;
    _speedEqualize += (equalizeTarget - _speedEqualize) * _k;
    const micLeanTarget = (!lifecycleActive && isListening) ? 1 : 0;
    _micLean += (micLeanTarget - _micLean) * _k;

    // Speaking waveform pulse — smoothed average output amplitude (suppressed
    // under reduced motion → orbs fall back to calm idle drift, CON-003).
    let speakAmpTarget = 0;
    if (!lifecycleActive && isSpeaking && !_reducedMotion
        && sphereAnalyserRef.an && sphereAnalyserRef.data) {
      sphereAnalyserRef.an.getByteFrequencyData(sphereAnalyserRef.data);
      const d = sphereAnalyserRef.data;
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i];
      speakAmpTarget = (sum / d.length) / 255;
    }
    _speakAmp += (speakAmpTarget - _speakAmp) * (delta > 0 ? 1 - Math.exp(-8.0 * delta) : 0);

    // Colour-temperature warmth — eased toward the state's warmth (idle while
    // a lifecycle animation plays so orbs cool to blue-white, TASK-015).
    const targetWarmth = lifecycleActive ? 0.0 : warmthForState(state);
    _orbWarmth += (targetWarmth - _orbWarmth)
      * (delta > 0 ? 1 - Math.exp(-ORB_BEHAVIOR_CONFIG.tempSmoothing * delta) : 0);

    // Thinking two-orb chase scheduling (deterministic via injectable rng).
    const _thinkActive = isThinking && !lifecycleActive && !_reducedMotion;
    if (_thinkActive) {
      if (_chase === null) {
        if (shouldStartChase(Math.random, ORB_BEHAVIOR_CONFIG.chaseProb)) {
          _chase = { pair: pickChasePair(Math.random, orbDefs.length), endsAt: now + ORB_BEHAVIOR_CONFIG.chaseDurationMs };
        }
      } else if (now >= _chase.endsAt) {
        _chase = null;
      }
    } else {
      _chase = null;
    }

    // ── Update orb positions and colours ────────────────────────────────────
    orbDefs.forEach((p, i) => {
      const orb = orbs[i];

      // Effective angular speed: equalise toward the mean while listening, and
      // jitter erratically while thinking. Integrating per-orb (theta) instead
      // of re-deriving from the shared accumulator keeps speed changes from
      // snapping positions (REQ-001) and exactly matches the analytic angle
      // when equalisation is off (so lifecycle motion is unchanged, CON-004).
      let effSpeed = p.speed + (_orbMeanSpeed - p.speed) * _speedEqualize;
      let jitterR = 0;
      if (_thinkActive) {
        const ja = ORB_BEHAVIOR_CONFIG.thinkJitterAmp;
        effSpeed += Math.sin(now * 0.011 + i * 1.7) * Math.sin(now * 0.017 + i * 3.1) * ja * 0.15 * p.speed;
        jitterR  = Math.sin(now * 0.013 + i * 2.3) * 0.06 * ja;
      }
      orb.theta += effSpeed * orbSpeedMult * delta;

      // Radius: lifecycle offset × per-state tighten × thinking jitter ×
      // speaking pulse.
      const radiusMult = _orbRadiusMult * (lifecycleActive ? 1.0 : _orbRadiusStateMult);
      let r = p.r * radiusMult * (1 + jitterR);
      if (!lifecycleActive && isSpeaking) r *= 1 + _speakAmp * ORB_BEHAVIOR_CONFIG.speakPulseAmount;

      // Analytic orbit target point for this orb.
      _orbAnalyticPoint(p, orb.theta, r, _steerTarget);

      if (lifecycleActive) {
        // Deterministic choreography — set positions from the analytic point
        // exactly as before and keep boid state synced so exiting the
        // lifecycle eases smoothly instead of snapping (CON-004 / RISK-004).
        orb.curPos.x = _steerTarget.x; orb.curPos.y = _steerTarget.y; orb.curPos.z = _steerTarget.z;
        orb.vel.x = 0; orb.vel.y = 0; orb.vel.z = 0;
        orb.mesh.position.set(_steerTarget.x, _steerTarget.y, _steerTarget.z);
        orb.light.position.set(_steerTarget.x, _steerTarget.y, _steerTarget.z);
      } else {
        // Listening mic-lean — bias the target toward the microphone direction.
        if (_micLean > 0.001) {
          const lean = _micLean * 0.45;
          _steerTarget.x += ORB_BEHAVIOR_CONFIG.micDir.x * lean;
          _steerTarget.y += ORB_BEHAVIOR_CONFIG.micDir.y * lean;
          _steerTarget.z += ORB_BEHAVIOR_CONFIG.micDir.z * lean;
        }
        // Chase — the first orb of the pair steers toward the second's position.
        if (_chase && i === _chase.pair[0]) {
          const other = orbs[_chase.pair[1]].curPos;
          _steerTarget.x = other.x; _steerTarget.y = other.y; _steerTarget.z = other.z;
        }
        // Build the neighbour list (reused array) and steer + integrate.
        _neighbors.length = 0;
        for (let j = 0; j < orbs.length; j++) {
          if (j !== i) _neighbors.push(orbs[j].curPos);
        }
        steerOrb(orb.curPos, _steerTarget, _neighbors, ORB_BEHAVIOR_CONFIG, _steerAccel);
        integrateOrbPosition(orb.curPos, orb.vel, _steerAccel, delta, ORB_BEHAVIOR_CONFIG.posSmoothing, _integrated);
        orb.curPos.x = _integrated.pos.x; orb.curPos.y = _integrated.pos.y; orb.curPos.z = _integrated.pos.z;
        orb.vel.x = _integrated.vel.x; orb.vel.y = _integrated.vel.y; orb.vel.z = _integrated.vel.z;
        // Clamp to a band around this frame's target radius so an orb can never
        // enter the sphere (absolute floor 1.2 > deformed sphere surface) nor
        // drift far from its orbit shell.
        const len = Math.hypot(orb.curPos.x, orb.curPos.y, orb.curPos.z) || 1e-9;
        const minR = Math.max(1.2, r * 0.8), maxR = r * 1.3;
        if (len < minR || len > maxR) {
          const target = len < minR ? minR : maxR;
          const s = target / len;
          orb.curPos.x *= s; orb.curPos.y *= s; orb.curPos.z *= s;
        }
        orb.mesh.position.set(orb.curPos.x, orb.curPos.y, orb.curPos.z);
        orb.light.position.set(orb.curPos.x, orb.curPos.y, orb.curPos.z);
      }

      // ── Colour ── override (lifecycle/proximity/hover) → temperature baseline.
      let orbTarget;
      if (orbOverrideColor) {
        orbTarget = orbOverrideColor;
      } else {
        temperatureToRGB(_orbWarmth, orb.ember, _tempRGB);
        orbTarget = _scratchColor.setRGB(_tempRGB.r, _tempRGB.g, _tempRGB.b);
      }
      orb.color.lerp(orbTarget, 0.04);
      orb.mat.color.copy(orb.color);
      orb.light.color.copy(orb.color);

      // Layering order: state/lifecycle/proximity baselines first, idle-only
      // expressiveness second, with no effect outside the idleEligible branch.
      // Base intensity by state, scaled by the lifecycle opacity offset.
      const baseIntensity = isListening ? 6 : isSpeaking ? 5 : 3.5;
      orb.light.intensity = baseIntensity * _orbOpacity;
      orb.mat.opacity     = _orbOpacity;
      if (fx.event && fx.event.kind === 'orbBrighten' && i === _idleBrightOrbIdx) {
        orb.light.intensity += IDLE_FX_CONFIG.orbBrightenAmp * idleEventEnv;
        orb.mat.opacity = Math.min(1, orb.mat.opacity + IDLE_FX_CONFIG.orbOpacityAmp * idleEventEnv);
        const brightenMix = Math.min(0.22, idleEventEnv * 0.22);
        orb.mat.color.lerp(ORB_WHITE, brightenMix);
        orb.light.color.lerp(ORB_WHITE, brightenMix);
      }
      orb.light.intensity *= blinkDimMul;
    });

    // ── Sphere surface deformation (audio-driven in listening mode) ──────────
    const positions = sphereGeo.attributes.position.array;
    if (isListening && !lifecycleActive && sphereAnalyserRef.an && sphereAnalyserRef.data) {
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
      const pulseDelta = fx.event && fx.event.kind === 'pulse'
        ? IDLE_FX_CONFIG.pulseAmp * idleEventEnv
        : 0;
      let anyChange = false;
      for (let i = 0; i < numVerts; i++) {
        // Idle noise: per-vertex sine wave driven by time + unique phase offset
        const ox = origPos[i * 3];
        const oy = origPos[i * 3 + 1];
        const oz = origPos[i * 3 + 2];
        const olen = Math.hypot(ox, oy, oz) || 1;
        const nx = ox / olen;
        const ny = oy / olen;
        const nz = oz / olen;
        const idleNoise = Math.sin(t * 0.38 + noiseOffset[i] * 6.28) * 0.006;
        const rippleDelta = fx.event && fx.event.kind === 'ripple'
          ? IDLE_FX_CONFIG.rippleAmp
            * idleEventEnv
            * Math.pow(Math.max(0, nx * _rippleOriginX + ny * _rippleOriginY + nz * _rippleOriginZ), IDLE_FX_CONFIG.rippleFalloffPow)
          : 0;
        const target = proximityPush + idleNoise + pulseDelta + rippleDelta;
        const diff = target - dispSmooth[i];
        if (fx.event || Math.abs(diff) > 0.0002) {
          dispSmooth[i] += diff * 0.09;
          const scale = Math.max(0.85, Math.min(1.2, 1 + dispSmooth[i]));
          positions[i * 3]     = origPos[i * 3]     * scale;
          positions[i * 3 + 1] = origPos[i * 3 + 1] * scale;
          positions[i * 3 + 2] = origPos[i * 3 + 2] * scale;
          anyChange = true;
        }
      }
      if (anyChange) sphereGeo.attributes.position.needsUpdate = true;
    }

    // ── Atmospheric glow — ease colour / strength, render (GOAL-002, TASK-012) ─
    if (!_prefersReducedMotion) {
      // Under reduced motion _glowStrength holds its initial constant value.
      const glowColorTarget    = lifecycleActive
        ? GLOW_CONFIG.idleColor
        : glowColorForState(state);
      const glowStrengthTarget = (lifecycleActive
        ? GLOW_CONFIG.bloomStrengthIdle
        : bloomStrengthForState(state)
      ) * (lifecycleActive ? _orbOpacity : 1.0);
      smoothColor(_glowColor, glowColorTarget, GLOW_CONFIG.colorSmoothing, delta);
      _glowStrength = smoothToward(
        _glowStrength, glowStrengthTarget, GLOW_CONFIG.strengthSmoothing, delta,
      );
    }
    const renderGlowStrength = _glowStrength * blinkGlowMul;
    sphereMat.emissiveIntensity = SPHERE_EMISSIVE_INTENSITY_BASE * blinkGlowMul;
    rimMat.opacity = RIM_OPACITY_BASE * blinkRimMul;

    if (_bloomEnabled && bloomPass) {
      // Primary bloom path: write eased strength to the pass and composite.
      bloomPass.strength = renderGlowStrength;
      composer.render();
    } else {
      // Fresnel-shell fallback path: update colour + strength uniforms (TASK-013).
      if (fresnelUniforms) {
        fresnelUniforms.uGlowColor.value.set(
          _glowColor.r, _glowColor.g, _glowColor.b,
        );
        fresnelUniforms.uGlowStrength.value = renderGlowStrength;
      }
      renderer.render(scene, camera);
    }
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

// Rough token estimate (~4 chars/token for English). Conservative enough for a
// pre-send safety guard without a real tokenizer.
function _estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function _estimateMessagesTokens(messages) {
  // ~4 tokens of per-message overhead (role tags / separators) on top of content.
  let total = 0;
  for (const m of messages) total += _estimateTokens(m.content) + 4;
  return total;
}

/**
 * Trim a message list so its estimated token count fits the model's context
 * window, reserving headroom for the model's reply. The leading system prompt
 * and the final user message are always preserved; oldest middle turns are
 * dropped first, and an over-long single message is hard-truncated as a last
 * resort. Returns a (possibly new) array; never mutates conversationHistory.
 */
function _guardContextSize(messages) {
  const limit = _ctxLimit || 4096;
  const reserve = Math.min(1024, Math.floor(limit * 0.25)); // room for the reply
  const budget = limit - reserve;
  if (budget <= 0 || _estimateMessagesTokens(messages) <= budget) return messages;

  const out = [...messages];
  // Indices we must keep: a leading system message (if present) and the last message.
  const keepHead = out.length && out[0].role === 'system' ? 1 : 0;

  // Drop oldest middle messages until within budget (always keep head + last).
  while (_estimateMessagesTokens(out) > budget && out.length > keepHead + 1) {
    out.splice(keepHead, 1);
  }

  // Still over budget — truncate the largest message's content as a last resort.
  if (_estimateMessagesTokens(out) > budget) {
    let largest = -1, largestLen = 0;
    for (let j = 0; j < out.length; j++) {
      const len = (out[j].content || '').length;
      if (len > largestLen) { largestLen = len; largest = j; }
    }
    if (largest >= 0) {
      const over = _estimateMessagesTokens(out) - budget;
      const cutChars = Math.min(largestLen, over * 4 + 64);
      const kept = (out[largest].content || '').slice(0, Math.max(0, largestLen - cutChars));
      out[largest] = { ...out[largest], content: kept + '\n…[truncated to fit context]' };
    }
  }

  if (out.length !== messages.length) {
    console.warn(`[context-guard] trimmed ${messages.length - out.length} message(s) to fit ${budget} token budget`);
  }
  return out;
}

async function sendToOllama(userText, options = {}) {
  const { ephemeralMessages = null, extraContext = null, existingElement = null } = options;

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

  // Guard against exceeding the model's context window. Trims oldest turns
  // (and over-long injected context) so a single big injection can't 400 the
  // request with an "exceeds the available context size" error.
  messages = _guardContextSize(messages);

  // If an existing interrupt bubble is provided, reuse it so the LLM response
  // appears seamlessly in the same message rather than as a new bubble.
  let wrap, txt, _prefix;
  if (existingElement) {
    wrap    = existingElement.wrap;
    txt     = existingElement.txt;
    _prefix = existingElement.phrase ? existingElement.phrase + ' ' : '';
    // Cancel any still-running interrupt typewriter before taking over the element
    if (_textStreamTimer !== null) { clearInterval(_textStreamTimer); _textStreamTimer = null; }
    txt.textContent     = _prefix;
    chatInner.scrollTop = chatInner.scrollHeight;
  } else {
    ({ wrap, txt } = appendMessage('assistant', ''));
    _prefix = '';
  }
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
            txt.textContent     = _prefix + full;
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
              if (dur) { _streamTextInto(_txt, _ci, _prefix + snapshot, dur); }
              else     { _txt.textContent = _prefix + snapshot; _ci.scrollTop = _ci.scrollHeight; }
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
          if (dur) { _streamTextInto(_txt, _ci, _prefix + snapshot, dur); }
          else     { _txt.textContent = _prefix + snapshot; _ci.scrollTop = _ci.scrollHeight; }
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
  switch (ttsMode) {
    case 'off':
      ttsToggle.textContent = 'TTS OFF';
      ttsToggle.classList.add('tts-off');
      voiceSelect.disabled = true;
      if (voicePicker)     voicePicker.classList.add('voice-picker-disabled');
      if (voiceTestBtn)    voiceTestBtn.disabled    = true;
      if (voiceDefaultBtn) voiceDefaultBtn.disabled = true;
      ttsEngineEl.textContent = 'OFF';
      if (footerTts) footerTts.textContent = 'Off';
      break;
    case 'browser':
      ttsToggle.textContent = 'TTS: BROWSER';
      ttsToggle.classList.remove('tts-off');
      voiceSelect.disabled = true;
      if (voicePicker)     voicePicker.classList.add('voice-picker-disabled');
      if (voiceTestBtn)    voiceTestBtn.disabled    = true;
      if (voiceDefaultBtn) voiceDefaultBtn.disabled = true;
      ttsEngineEl.textContent = 'BROWSER';
      if (footerTts) footerTts.textContent = 'Web Speech';
      break;
    default: // 'kokoro'
      ttsToggle.textContent = 'TTS: KOKORO';
      ttsToggle.classList.remove('tts-off');
      voiceSelect.disabled = false;
      if (voicePicker)     voicePicker.classList.remove('voice-picker-disabled');
      if (voiceTestBtn)    voiceTestBtn.disabled    = false;
      if (voiceDefaultBtn) voiceDefaultBtn.disabled = false;
      ttsEngineEl.textContent = 'KOKORO';
      if (footerTts) footerTts.textContent = 'Kokoro (local)';
      break;
  }
}

// Cycle: kokoro → browser → off → kokoro
ttsToggle.addEventListener('click', () => {
  ttsMode = ttsMode === 'kokoro' ? 'browser' : ttsMode === 'browser' ? 'off' : 'kokoro';
  localStorage.setItem('starling_tts_mode', ttsMode);
  _applyTtsMode();
});

voiceSelect.addEventListener('change', () => {
  // Only update in-session voice — use SET DEFAULT to persist across reboots.
  ttsVoice = voiceSelect.value;
});

// ── Voice preview (TEST button in the menu) ───────────────────────────────
let _previewAudio = null;

function _cancelPreview() {
  if (_previewAudio) { _previewAudio.pause(); _previewAudio.src = ''; _previewAudio = null; }
}

async function _playVoicePreview(voiceId) {
  _cancelPreview();
  if (ttsMode === 'off') return;
  try {
    const res = await fetch(`${BACKEND_BASE}/synthesize/`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: 'Hello, I am Starling.', voice: voiceId, speed: 1.0 }),
    });
    if (!res.ok) return;
    const blob  = await res.blob();
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _previewAudio = audio;
    audio.onended = audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (_previewAudio === audio) _previewAudio = null;
    };
    audio.play().catch(() => {});
  } catch { /* ignore — backend may not be ready */ }
}

if (voiceTestBtn) {
  voiceTestBtn.addEventListener('click', () => _playVoicePreview(ttsVoice));
}

if (voiceDefaultBtn) {
  voiceDefaultBtn.addEventListener('click', () => {
    localStorage.setItem('starling_tts_voice', ttsVoice);
    // Move the ★ indicator to the newly saved default item.
    if (_pickerDropdown) {
      _pickerDropdown.querySelectorAll('.voice-picker-item').forEach(item => {
        const s = item.querySelector('.voice-picker-star');
        if (s) s.hidden = item.dataset.voiceId !== ttsVoice;
      });
    }
    // Brief visual confirmation.
    voiceDefaultBtn.textContent = 'SAVED \u2713';
    voiceDefaultBtn.disabled = true;
    setTimeout(() => {
      voiceDefaultBtn.textContent = 'SET DEFAULT';
      if (ttsMode === 'kokoro') voiceDefaultBtn.disabled = false;
    }, 2000);
  });
}

// Module-level ref so the outside-click handler can reach the open dropdown.
let _pickerDropdown = null;

function _buildVoicePicker(voices) {
  if (!voicePicker) return;
  voicePicker.innerHTML = '';

  const selected = document.createElement('div');
  selected.className = 'voice-picker-selected';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'voice-picker-label';
  const currentVoice = voices.find(v => v.id === ttsVoice);
  labelSpan.textContent = currentVoice?.label ?? voices[0]?.label ?? '—';

  const chevron = document.createElement('span');
  chevron.className = 'voice-picker-chevron';
  chevron.textContent = '▾';
  selected.append(labelSpan, chevron);

  const dropdown = document.createElement('div');
  dropdown.className = 'voice-picker-dropdown hidden';
  _pickerDropdown = dropdown;

  voices.forEach(v => {
    const item = document.createElement('div');
    item.className = 'voice-picker-item';
    if (v.id === ttsVoice) item.classList.add('active');
    item.dataset.voiceId = v.id;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = v.label;
    const star = document.createElement('span');
    star.className = 'voice-picker-star';
    star.textContent = '\u2605';  // ★
    // ttsVoice equals the saved localStorage default on first load;
    // it stays in sync via _buildVoicePicker being called once at boot.
    star.hidden = v.id !== ttsVoice;
    item.append(nameSpan, star);

    item.addEventListener('click', e => {
      e.stopPropagation();
      _cancelPreview();
      voiceSelect.value = v.id;
      voiceSelect.dispatchEvent(new Event('change'));  // updates ttsVoice for this session
      labelSpan.textContent = v.label;
      dropdown.querySelectorAll('.voice-picker-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      dropdown.classList.add('hidden');
    });
    dropdown.appendChild(item);
  });

  selected.addEventListener('click', e => {
    e.stopPropagation();
    if (voicePicker.classList.contains('voice-picker-disabled')) return;
    dropdown.classList.toggle('hidden');
  });

  voicePicker.append(selected, dropdown);
}

// Close the voice picker dropdown when clicking anywhere outside it.
document.addEventListener('click', () => {
  if (_pickerDropdown) _pickerDropdown.classList.add('hidden');
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
    _buildVoicePicker(voices);
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

// Interrupt Starling mid-speech or mid-thought.
// If something was actively playing, picks a random annoyance phrase, speaks it
// immediately via Kokoro, and shows it in the conversation window.
// Returns { wasActive, wrap, txt, phrase } — callers can pass this to sendToOllama
// as { existingElement } so the LLM response continues in the same bubble.
function interruptSpeech() {
  const wasActive = _currentAbortCtrl !== null || _activeAudio !== null;
  if (wasActive) {
    clearAudioQueue();
    const phrase = getInterruptPhrase();
    const { wrap, txt } = appendMessage('assistant', '');
    // Animate the phrase character-by-character (streaming-style)
    if (_textStreamTimer !== null) { clearInterval(_textStreamTimer); _textStreamTimer = null; }
    let i = 0;
    const msPerChar = Math.max(16, 350 / phrase.length);
    _textStreamTimer = setInterval(() => {
      i++;
      txt.textContent = phrase.slice(0, i);
      chatInner.scrollTop = chatInner.scrollHeight;
      if (i >= phrase.length) {
        clearInterval(_textStreamTimer);
        _textStreamTimer = null;
        txt.textContent = phrase + ' .....';
        chatInner.scrollTop = chatInner.scrollHeight;
      }
    }, msPerChar);
    enqueueSpeak(phrase);
    return { wasActive: true, wrap, txt, phrase };
  }
  return { wasActive: false, wrap: null, txt: null, phrase: null };
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

// ── Fuzzy tool confirm helpers (Tier 2) ──────────────────────────────────────

/** Reset all fuzzy-confirm state and hide the banner. */
function _clearFuzzyConfirmState() {
  _fuzzyConfirmPending = false;
  _fuzzyPendingTool    = null;
  if (_fuzzyTimeoutId !== null) {
    clearTimeout(_fuzzyTimeoutId);
    _fuzzyTimeoutId = null;
  }
  const banner = document.getElementById('fuzzy-confirm-banner');
  if (banner) banner.classList.add('hidden');
}

/**
 * Raise the "Did you mean to open <tool>?" confirmation banner and arm a
 * 15-second auto-dismiss. The next utterance is interpreted as yes/no by the
 * fuzzy confirm intercept at the top of _routeInput().
 */
function _enterFuzzyConfirmState(toolName) {
  _clearFuzzyConfirmState();
  _fuzzyConfirmPending = true;
  _fuzzyPendingTool    = toolName;

  const nameEl = document.getElementById('fcb-tool-name');
  if (nameEl) nameEl.textContent = toolName;
  const banner = document.getElementById('fuzzy-confirm-banner');
  if (banner) banner.classList.remove('hidden');

  const spoken = `Did you mean to open ${toolName}? Say yes or no.`;
  enqueueSpeak(spoken);

  _fuzzyTimeoutId = setTimeout(() => {
    _clearFuzzyConfirmState();
    enqueueSpeak("Okay, I'll cancel that.");
  }, 15000);
}

/**
 * Re-dispatch a tool after the user confirms a fuzzy match. Mirrors the real
 * canonical handlers in _routeInput() below.
 *
 * CO-CHANGE NOTE: When adding a tool here, also add a matching entry to
 * FUZZY_TOOL_MAP in fuzzy-tool-detect.js and a handler in _routeInput().
 */
async function _retriggerTool(toolName, originalTranscript) {
  switch (toolName) {
    case 'Dossier': {
      enqueueSpeak('Which subject would you like a dossier on? Say: tell me about, followed by a name.');
      setState('idle');
      return;
    }

    case 'Timer': {
      enqueueSpeak('How long should I set the timer for?');
      setState('idle');
      return;
    }

    case 'Time / Date': {
      setState('idle');
      handleTimeQuery(originalTranscript);
      return;
    }

    case 'Weather': {
      closeBrowserPanel();
      setState('thinking');
      const wxResult = await openWeatherPanel();
      if (wxResult && typeof wxResult === 'object' && wxResult._wxErr) {
        const { txt } = appendMessage('assistant', wxResult._wxErr);
        enqueueSpeak(wxResult._wxErr, () => { txt.textContent = wxResult._wxErr; });
        setState('idle');
      } else if (wxResult) {
        await sendToOllama(
          'Give a spoken weather briefing using only the weather data in your context — do not estimate or invent any values. ' +
          'Start with current conditions and how it feels outside, then the upcoming forecast using the exact high temperatures listed. ' +
          'Keep it to three or four natural sentences.',
          {
            ephemeralMessages: [
              {
                role: 'system',
                content: SYSTEM_PROMPT + '\n\n[WEATHER DATA — use only these values, do not hallucinate temperatures]\n' + wxResult,
              },
            ],
          }
        );
        _playbackChain.then(() => { /* panel stays open for follow-ups */ });
      } else {
        await sendToOllama(getPrompt('TOOL_WEATHER_UNAVAILABLE'));
      }
      fetchSystemStatus();
      return;
    }

    case 'News': {
      closeBrowserPanel();
      setState('thinking');
      const newsContext = await openNewsPanel('top');
      if (newsContext) {
        enterNewsMode();
        await sendToOllama(
          'Deliver a concise spoken news briefing based on the headlines provided. ' +
          'Pick the four or five most significant stories and summarise each in one sentence. ' +
          'Keep the whole briefing under sixty seconds when spoken aloud.',
          {
            ephemeralMessages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'system', content: `${_currentTimeContext()}\n${newsContext}` },
            ],
          }
        );
      } else {
        await sendToOllama(getPrompt('TOOL_NEWS_UNAVAILABLE'));
      }
      fetchSystemStatus();
      return;
    }

    case 'Stocks & Market': {
      closeBrowserPanel();
      setState('thinking');
      const mktContext = await openMarketPanel('all');
      if (mktContext) {
        enterMarketMode();
        await sendToOllama(
          'Deliver a concise spoken market briefing. Cover both equities and crypto briefly. ' +
          'Highlight any significant movers. Keep it under thirty seconds when spoken aloud.',
          {
            ephemeralMessages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'system', content: `${_currentTimeContext()}\n${mktContext}` },
            ],
          }
        );
      } else {
        await sendToOllama(getPrompt('TOOL_MARKET_UNAVAILABLE'));
      }
      fetchSystemStatus();
      return;
    }

    case 'Browser': {
      enqueueSpeak('What website would you like to open? Say: open the browser to, followed by a site.');
      setState('idle');
      return;
    }

    case 'Ideas Vault': {
      enterIdeasMode();
      const spoken = 'Ready. Press the mic and speak your idea.';
      const { txt } = appendMessage('assistant', spoken);
      enqueueSpeak(spoken, () => { txt.textContent = spoken; });
      return;
    }

    case 'Voice Journal': {
      enterJournalMode();
      const spoken = 'Journal entry started. Speak your entry — each mic press adds a segment. Say submit when finished.';
      const { txt } = appendMessage('assistant', spoken);
      enqueueSpeak(spoken, () => { txt.textContent = spoken; });
      return;
    }

    case 'Wikipedia RAG': {
      enqueueSpeak('What topic should I look up? Say: search local Wikipedia for, followed by a topic.');
      setState('idle');
      return;
    }

    case 'Calendar': {
      closeBrowserPanel();
      setState('thinking');
      const calContext = await openCalendarPanel(false);
      if (calContext) {
        await sendToOllama(
          'Deliver a natural spoken calendar briefing based only on the events listed in your context. ' +
          'Do not invent, assume, or embellish any events. Start with today, then mention upcoming events using accurate relative time. ' +
          'Keep it to three or four sentences.',
          {
            ephemeralMessages: [
              { role: 'system', content: SYSTEM_PROMPT + '\n\n' + calContext },
            ],
          }
        );
      } else {
        await sendToOllama('Inform the user that the calendar could not be reached right now. One sentence.');
      }
      fetchSystemStatus();
      return;
    }

    case 'Mail': {
      closeBrowserPanel();
      setState('thinking');
      const mailCtx = await openMailPanel();
      if (mailCtx) {
        enterMailMode();
        logEvent('mail_inbox_snapshot', { llm_context: mailCtx });
        await sendToOllama(
          getPrompt('MAIL_INBOX_SUMMARY') + '\n\n' + mailCtx,
          { ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }] }
        );
      } else {
        await sendToOllama('Inform the user that the mail inbox could not be reached right now. One sentence.');
      }
      fetchSystemStatus();
      return;
    }

    case 'YouTube': {
      closeBrowserPanel();
      setState('thinking');
      enterYouTubeMode();
      const ytContext = await openYouTubePanel({});
      if (ytContext) {
        await sendToOllama(
          "Give me a brief spoken summary of what's new on my YouTube feed. " +
          'For each channel, mention the one or two most interesting recent videos. ' +
          'Keep the whole summary under forty-five seconds when spoken aloud.',
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

    case 'Reddit': {
      closeBrowserPanel();
      setState('thinking');
      const redditContext = await openRedditPanel({});
      if (redditContext) {
        enterRedditMode();
        await sendToOllama(
          "Deliver a concise spoken summary of what's trending on Reddit right now. " +
          'For each subreddit, pick the one or two most interesting posts and describe them in one sentence. ' +
          'Keep the whole briefing under forty-five seconds when spoken aloud.',
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

    case 'Toolkit Menu': {
      openToolkitPanel();
      setState('idle');
      return;
    }

    default: {
      setState('idle');
      return;
    }
  }
}

// ── Unified input router ──────────────────────────────────────────────────────
// Handles all trigger intercepts; falls through to the LLM for unmatched input.
// Called by both handleSend (text path) and mediaRecorder.onstop (voice path).
async function _routeInput(text) {  // ── Toolkit confirm intercept (position 1 — must be first) ────────────────
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

  // ── Fuzzy tool confirm intercept (Tier 2) ─────────────────────────────────
  // While a fuzzy "did you mean …?" banner is showing, the next utterance is
  // interpreted as a yes/no answer. Guarded so it never interferes with the
  // dedicated conversational modes (journal / interview / wiki / ideas).
  if (_fuzzyConfirmPending && !journalMode && !interviewMode && !wikiMode && !ideasMode) {
    const t = text.trim().toLowerCase();
    if (/\b(?:yes|yeah|yep|yup|sure|do it|open it|confirm|correct|right)\b/.test(t)) {
      const tool = _fuzzyPendingTool;
      _clearFuzzyConfirmState();
      if (tool) {
        appendMessage('user', text);
        logEvent('fuzzy_tool_confirmed', { tool, trigger_phrase: text });
        await _retriggerTool(tool, text);
      }
      return;
    }
    if (/\b(?:no|nope|nah|cancel|never mind|nevermind|wrong|incorrect)\b/.test(t)) {
      const tool = _fuzzyPendingTool;
      _clearFuzzyConfirmState();
      logEvent('fuzzy_tool_rejected', { tool, trigger_phrase: text });
      // Fall through to normal handling so the user's actual words still reach
      // the LLM if they weren't simply answering the prompt.
    } else {
      // Ambiguous reply — dismiss the banner and let the input route normally.
      _clearFuzzyConfirmState();
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

  // ── Mail inbox close phrase ──────────────────────────────────────────────────
  if (isMailPanelOpen() && /\b(?:close|hide|dismiss|exit)\b.{0,15}\b(?:mail|email|inbox)\b/i.test(text)) {
    exitMailMode();
    appendMessage('user', text);
    const ack = 'Mail panel closed.';
    const { txt: mailCloseTxt } = appendMessage('assistant', ack);
    enqueueSpeak(ack, () => { mailCloseTxt.textContent = ack; });
    setState('idle');
    return;
  }

  if (_matchesExitPhrase(text)) {
    exitPresMode();
    setState('idle');
    return;
  }

  // ── Soul editor voice trigger ────────────────────────────────────────────
  if (/\b(?:open|show|view|edit)\b.{0,20}\b(?:soul|soul\s+file|soul\s+editor)\b/i.test(text)) {
    openSoulPanel();
    return;
  }

  // ── Prompt editor voice trigger ──────────────────────────────────────────
  if (/\b(?:open|show|edit)\b.{0,20}\bprompt(?:s)?\b.{0,20}\b(?:editor|registry|panel|settings)\b/i.test(text)) {
    openPromptsPanel();
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

  // System status voice trigger — answers via spoken summary of /system/status.
  if (detectSystemStatusTrigger(text)) {
    logEvent('tool_dispatch', { tool: 'system_status', trigger_phrase: text });
    appendMessage('user', text);
    setState('thinking');
    await handleSystemStatusTrigger((spoken) => {
      const { txt } = appendMessage('assistant', spoken);
      enqueueSpeak(spoken, () => { txt.textContent = spoken; });
    });
    setState('idle');
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
      await sendToOllama(getPrompt('TOOL_WEATHER_UNAVAILABLE'));
    }
    fetchSystemStatus();
    return;
  }

  // ── Calendar intercept ─────────────────────────────────────────────────────
  if (detectCalendarTrigger(text)) {
    logEvent('tool_dispatch', { tool: 'calendar', trigger_phrase: text });
    closeBrowserPanel();
    setState('thinking');
    appendMessage('user', text);
    const forceRefresh = /\b(?:refresh|update|sync)\b/i.test(text);
    const calContext = await openCalendarPanel(forceRefresh);
    if (calContext) {
      await sendToOllama(
        'Deliver a natural spoken calendar briefing based only on the events listed in your context. ' +
        'Do not invent, assume, or embellish any events. ' +
        'Start with today, then mention upcoming events using accurate relative time (e.g. "next Tuesday", "in three weeks"). ' +
        'Phrase times naturally — say "two-thirty" not "14:30". ' +
        'If there is nothing today, say so, then move to upcoming. Keep it to three or four sentences.',
        {
          ephemeralMessages: [
            {
              role: 'system',
              content: SYSTEM_PROMPT + '\n\n' + calContext,
            },
          ],
        }
      );
    } else {
      await sendToOllama(
        'Inform the user that the calendar could not be reached right now. One sentence.'
      );
    }
    fetchSystemStatus();
    return;
  }

  // ── Mail inbox trigger ───────────────────────────────────────────────────────
  if (detectMailTrigger(text)) {
    logEvent('tool_dispatch', { tool: 'mail', trigger_phrase: text });
    closeBrowserPanel();
    setState('thinking');
    appendMessage('user', text);
    const mailCtx = await openMailPanel();
    if (mailCtx) {
      enterMailMode();
      logEvent('mail_inbox_snapshot', { llm_context: mailCtx });
      await sendToOllama(
        getPrompt('MAIL_INBOX_SUMMARY') + '\n\n' + mailCtx,
        {
          ephemeralMessages: [
            { role: 'system', content: SYSTEM_PROMPT },
          ],
        }
      );
    } else {
      await sendToOllama(
        'Inform the user that the mail inbox could not be reached right now. One sentence.'
      );
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
      await sendToOllama(getPrompt('TOOL_MARKET_UNAVAILABLE'));
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
      await sendToOllama(getPrompt('TOOL_NEWS_UNAVAILABLE'));
    }
    fetchSystemStatus();
    return;
  }

  // ── Browser / web trigger ────────────────────────────────────────────────────
  const _browserTrigger = detectBrowserTrigger(text);
  if (_browserTrigger) {
    setState('thinking');
    appendMessage('user', text);

    // Pass the raw transcript through an LLM call to get a clean, normalised URL.
    // This corrects common STT artefacts such as "DOT" being transcribed instead of ".".
    let _resolvedUrl   = _browserTrigger.url;
    let _resolvedLabel = _browserTrigger.label;
    try {
      const _resolveRes = await fetch(`${BACKEND_BASE}/api/browser/resolve-url`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, model: MODEL }),
      });
      if (_resolveRes.ok) {
        const _resolveData = await _resolveRes.json();
        if (_resolveData.url) {
          _resolvedUrl   = _resolveData.url;
          _resolvedLabel = _resolveData.label || _resolvedLabel;
        }
      }
    } catch (_e) {
      // Resolve failed — fall back to the regex-extracted URL
    }

    logEvent('tool_dispatch', { tool: 'browser', trigger_phrase: text, url: _resolvedUrl });
    openBrowserPanel(_resolvedUrl);
    await sendToOllama(
      getPrompt('BROWSER_OPENED', { page_label: _resolvedLabel }),
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
          getPrompt('WIKI_SECTION_NOT_FOUND', { section_name: _wikiSection, available_sections_hint: _available }),
          { ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }] }
        );
      }
    } catch (err) {
      console.error('[wiki-section] fetch failed:', err.message);
      await sendToOllama(
        getPrompt('WIKI_SECTION_NETWORK_ERROR'),
        { ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }] }
      );
    }
    fetchSystemStatus();
    return;
  }

  // ── Fuzzy tool recovery (Tier 2 — final intercept before LLM fallback) ────
  // No canonical trigger matched. Score the transcript against known tools; if
  // a near-miss is found, raise a confirmation banner instead of guessing. Only
  // active outside the dedicated conversational modes (already returned above).
  const _fuzzyMatch = detectFuzzyToolIntent(text, []);
  if (_fuzzyMatch) {
    logEvent('fuzzy_tool_detected', { tool: _fuzzyMatch.toolName, confidence: _fuzzyMatch.confidence, trigger_phrase: text });
    appendMessage('user', text);
    _enterFuzzyConfirmState(_fuzzyMatch.toolName);
    setState('idle');
    return;
  }

  appendMessage('user', text);
  let _extraContext = null;
  if (isBrowserPanelOpen()) {
    const _pageCtx = await ensureBrowserPageText();
    if (_pageCtx) {
      _extraContext = getPrompt('BROWSER_CONTEXT_LOADED', { page_text: _pageCtx });
    } else if (getBrowserPageUrl()) {
      // Page text unavailable — distinguish JS-rendered SPA from a plain fetch failure.
      if (getBrowserJsRendered()) {
        _extraContext = getPrompt('BROWSER_CONTEXT_SPA', { url: getBrowserPageUrl() });
      } else {
        _extraContext = getPrompt('BROWSER_CONTEXT_FAIL', { url: getBrowserPageUrl() });
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
  _resetActivity();
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
  _clearFuzzyConfirmState();
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

        _resetActivity();
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
micBtn.addEventListener('mousedown', () => {
  if (_isSleeping) { wakeSleepMode(); return; }  // wake before recording
  _micMouseDown = true;
  startRecording();
});
document.addEventListener('mouseup',  () => { if (_micMouseDown) { _micMouseDown = false; stopRecording(); } });

// Push-to-talk — touch
micBtn.addEventListener('touchstart', e => { e.preventDefault(); startRecording(); });
micBtn.addEventListener('touchend',   e => { e.preventDefault(); stopRecording();  });

// Push-to-talk — spacebar (only when text input is not focused)
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && document.activeElement !== textInput && !e.repeat) {
    e.preventDefault();
    if (_isSleeping) { wakeSleepMode(); return; }  // wake before recording
    startRecording();
  }
});
// Any other keypress while sleeping also wakes the system
document.addEventListener('keydown', e => {
  if (_isSleeping && e.code !== 'Space') { e.preventDefault(); wakeSleepMode(); }
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

// Fetch the current SOUL.md content from the backend.
// Returns the soul text on success, or "" if the backend is unreachable or times out.
async function _loadSoul() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${BACKEND_BASE}/soul`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

// ── Startup coordination ──────────────────────────────────────────────────────
// Interactive controls are revealed (and the sphere turns from blue "INIT" to its
// ready idle state) only once BOTH conditions are met:
//   1. the boot animation has finished, and
//   2. model warm-up is complete — which itself waits for the LLM to report ready.
let _bootAnimDone = false;
let _warmupDone   = false;

function _finishStartupIfReady() {
  if (!(_bootAnimDone && _warmupDone)) return;
  setState('idle');
  [micBtn, sendBtn, textInput, powerBtn].forEach(el => el && (el.disabled = false));
}

// Poll /system-status until the LLM is no longer OFFLINE (llama-server still loads
// in the background after the UI is already on screen). Keeps the UI in its blue
// "INIT" state until the model is ready, then resolves so warm-up can proceed.
async function _waitForLlmReady() {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BACKEND_BASE}/system-status`);
      if (res.ok) {
        const s = await res.json();
        if (s.llm && s.llm !== 'OFFLINE') return true;
      }
    } catch { /* backend momentarily unreachable — keep polling */ }
    await new Promise(r => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  return false;  // timed out — proceed anyway so the UI never hangs forever
}

// Synthesise the greeting to pre-heat Kokoro, then POST the returned WAV to
// /transcribe so the Whisper CUDA session is initialised before the user ever
// presses the mic.
// greetingEl: the <span> holding the placeholder text — updated to the full
// greeting once the warm-up sequence has fully completed.
async function warmupModels(greetingEl) {
  setState('warmup');
  // Load prompt registry early so getPrompt() serves live values for all subsequent calls.
  await loadPrompts();
  // Wait for llama-server to finish loading before warming up the GPU models, so
  // Whisper/Kokoro initialisation never races with llama's VRAM allocation.
  await _waitForLlmReady();
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
  // Warm up the LLM itself — llama-server has the model in VRAM (we waited on
  // /system-status), but the prompt-eval / generation path is still cold until a
  // first inference. Fire one tiny silent call so the user's first real turn does
  // not pay that cost. Output is discarded.
  try {
    await _callLLMSilently('ping', [{ role: 'system', content: 'Reply with a single word.' }]);
  } catch { /* warm-up failures are non-fatal */ }
  // Both Kokoro and Whisper have now completed their first inference pass — poll
  // system-status so the GPU badges in the footer are populated before the user speaks.
  await fetchSystemStatus();
  // Cache the current session ID for sleep-dream triggers.
  try {
    const hr = await fetch(`${BACKEND_BASE}/health`);
    if (hr.ok) { const h = await hr.json(); _currentSessionId = h.current_session || null; }
  } catch { /* non-fatal — _triggerSleepDream will silently skip if null */ }
  // Rebuild SYSTEM_PROMPT with real device values now that the footer badges are populated.
  SYSTEM_PROMPT =
    _buildInitialContext() + ' ' +
    getPrompt('STARLING_PERSONA', {
      whisper_device: footerWhisperDevice?.textContent?.trim() || 'CUDA',
      kokoro_device:  footerKokoroDevice?.textContent?.trim()  || 'CUDA',
      llm_device:     footerLlmDevice?.textContent?.trim()     || 'CUDA',
    }) +
    ' ' + TOOLKIT_MANIFEST_BLOCK;
  // Augment SYSTEM_PROMPT with the current soul content (fetched from /soul).
  // This runs after the prompt is fully built with real device values so the soul
  // is always appended to the final version, not the initial fallback.
  const soulContent = await _loadSoul();
  if (soulContent) {
    SYSTEM_PROMPT += '\n\n---\n\n# STARLING Soul File\n\n' + soulContent;
  }
  // Update the first message in the conversation history with the rebuilt prompt.
  conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
  // Reveal the full greeting only once everything is ready.
  if (greetingEl) greetingEl.textContent = GREETING_TEXT;
  // Mark warm-up complete; controls/idle state are revealed once the boot
  // animation has also finished (see _finishStartupIfReady).
  _warmupDone = true;
  _finishStartupIfReady();
}

// ── Init ──────────────────────────────────────────────────────────────────────
initTimerPanel({ appendMessage, setState, enqueueSpeak });
initWeatherPanel();
initRedditPanel({ enqueueSpeak, sendToOllama, interruptSpeech });
initYouTubePanel({ enqueueSpeak, sendToOllama, interruptSpeech });
initNewsPanel({ enqueueSpeak, sendToOllama, interruptSpeech, onClose: exitNewsMode });
initToolkitPanel(TOOLKIT_REGISTRY);
initSystemPanel();
initLogDashboard();

// ── Fuzzy confirm banner button wiring (Tier 2) ───────────────────────────────
const _fcbYes = document.getElementById('fcb-yes');
const _fcbNo  = document.getElementById('fcb-no');
if (_fcbYes) {
  _fcbYes.addEventListener('click', async () => {
    if (!_fuzzyConfirmPending) return;
    const tool = _fuzzyPendingTool;
    _clearFuzzyConfirmState();   // clear state before acting (SEC-001)
    if (tool) {
      logEvent('fuzzy_tool_confirmed', { tool, trigger_phrase: '[button]' });
      await _retriggerTool(tool, '');
    }
  });
}
if (_fcbNo) {
  _fcbNo.addEventListener('click', () => {
    if (!_fuzzyConfirmPending) return;
    const tool = _fuzzyPendingTool;
    _clearFuzzyConfirmState();
    logEvent('fuzzy_tool_rejected', { tool, trigger_phrase: '[button]' });
  });
}
// Disable interactive controls during boot animation.
// _onBootAnimationComplete() (called from animate()) re-enables them once warm-up
// has also finished. If Three.js fails to init, _sphereAnimPhase stays 'none' and
// we mark the boot phase done immediately below so warm-up alone gates the controls.
[micBtn, sendBtn, textInput, powerBtn].forEach(el => el && (el.disabled = true));
initSphere();
// ── Nebula background (GOAL-003, TASK-020) ────────────────────────────────────
// Initialise the procedural nebula after the sphere so the sphere's WebGL context
// is established first. Wrapped in try/catch: failure leaves the CSS background
// visible with no console errors (CON-005).
try {
  initNebula({ getState: () => sphereStateRef.current });
} catch (_err) {
  console.warn('S.T.A.R.L.I.N.G.: nebula background failed to initialise');
}
// If sphere didn't start a boot animation (Three.js unavailable), treat the boot
// phase as complete now — controls are then gated solely on model warm-up.
if (_sphereAnimPhase === 'none') {
  _bootAnimDone = true;
  _finishStartupIfReady();
}

// ── Dev-only lifecycle animation hotkeys (gated on ?dev=1) ────────────────────
// Ctrl+Shift+B → replay boot · Ctrl+Shift+S → sleep (wake via activity) ·
// Ctrl+Shift+X → preview shutdown choreography without POSTing /system/shutdown.
if (new URLSearchParams(window.location.search).get('dev') === '1') {
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key === 'b')      { e.preventDefault(); _replayBootAnim(); }
    else if (key === 's') { e.preventDefault(); enterSleepMode(); }
    else if (key === 'x') { e.preventDefault(); _previewShutdownAnim(); }
  });
}
statModel.textContent = MODEL;
_applyTtsMode();
loadVoices();
fetchContextLimit();
loadLlmCtxSetting();
_loadManifest();  // Phase 4: load subject→image manifest for dynamic dossier images
_setMktSendToOllama(sendToOllama);  // provide LLM callback to stocks panel briefing
_setMktOnClose(exitMarketMode);     // close button returns to conversation mode
document.getElementById('mail-close-btn')?.addEventListener('click', exitMailMode);

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

// ── Prompt Registry "OPEN EDITOR" button ─────────────────────────────────────
document.getElementById('prompt-registry-open-btn')?.addEventListener('click', () => {
  openPromptsPanel();
});

// ── Soul "VIEW / EDIT SOUL" button ────────────────────────────────────────────
document.getElementById('soul-open-btn')?.addEventListener('click', () => {
  openSoulPanel();
});

// ── System Status "SYSTEM STATUS" button ─────────────────────────────────────
document.getElementById('system-status-open-btn')?.addEventListener('click', () => {
  showSystemPanel();
});

// ── Diagnostics & Logs "DIAGNOSTICS & LOGS" button ───────────────────────────
document.getElementById('logdash-open-btn')?.addEventListener('click', () => {
  showLogDashboard();
});

// ── Soul verbal protests (fired by soul-panel.js via CustomEvent) ─────────────
window.addEventListener('soul:open-protest', (e) => {
  const protest = e.detail?.protest;
  if (protest && ttsMode !== 'off') enqueueSpeak(protest);
});

window.addEventListener('soul:save-protest', (e) => {
  const protest = e.detail?.protest;
  if (protest && ttsMode !== 'off') enqueueSpeak(protest);
});

// ── Wikipedia close button ────────────────────────────────────────────────────
document.getElementById('wiki-close-btn')?.addEventListener('click', () => {
  exitWikiMode();
  setState('idle');
});

// ── Toolkit menu event handlers ──────────────────────────────────────────────
window.addEventListener('toolkit:tool-selected', (e) => {
  // Read the pre-written script directly via Kokoro — no LLM call needed.
  const entry = e.detail;
  if (entry.ttsScript && ttsMode !== 'off') enqueueSpeak(entry.ttsScript);
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

// ── Sleep mode: overlay click, and inactivity poll ──────────────────────────────────
if (sleepOverlay) sleepOverlay.addEventListener('click', wakeSleepMode);

// Check every 15 s whether the user has been idle long enough to sleep.
// Guards: skip if an animation is playing, if the system is already sleeping,
// or if Starling is currently speaking/listening.
setInterval(() => {
  if (_sphereAnimPhase !== 'none') return;
  if (_isSleeping) return;
  const s = sphereStateRef.current;
  if (s === 'speaking' || s === 'listening' || s === 'thinking' || s === 'transcribing') return;
  if (Date.now() - _lastActivityTs >= SLEEP_AFTER_MS) enterSleepMode();
}, 15000);
