---
goal: Toolkit Awareness & Fuzzy Tool Recovery for Starling
version: 1.0
date_created: 2026-05-15
owner: Daniel Simpson
status: 'Planned'
tags: [feature, frontend, backend, voice-ux]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Two complementary capabilities that make Starling aware of her own toolkit and resilient to
imperfect voice transcription. **Tier 1** injects a structured tool manifest into the system
prompt so Starling can describe her capabilities when asked. **Tier 2** adds a fuzzy-intent
layer at the tail of the intercept chain: when a near-miss transcript contains recognisable
tool keywords but doesn't fire any canonical regex, Starling asks for confirmation before
opening the tool — preventing noise fragments from reaching the LLM as plain chat.

---

## 1. Requirements & Constraints

- **REQ-001**: Tier 1 must not increase the system prompt by more than ~300 tokens — the manifest should list all active tools in plain prose, one sentence each.
- **REQ-002**: The toolkit manifest must remain accurate when tools are added or removed. Maintenance is a single constant in `frontend/app.js`.
- **REQ-003**: Tier 2 must never intercept a transcript when `journalMode` or `ideasMode` are active (once those tools are implemented). Fuzzy detection is skipped entirely when any exclusive mode flag is set.
- **REQ-004**: Fuzzy confirm state must be self-clearing after 15 seconds with no follow-up mic press, to prevent the confirm flag from silently gating future input.
- **REQ-005**: The fuzzy confirm check must be inserted at intercept-chain **position 3** (after `journalMode` and `ideasMode` checks, before dossier exit) when those modes are eventually added. For the current chain it must be position **1**, before the dossier exit check.
- **REQ-006**: Fuzzy detection must not fire on transcripts shorter than 5 characters — too short to be meaningful.
- **REQ-007**: Only tools that are currently active in `_routeInput()` should appear in `FUZZY_TOOL_MAP`. Stub entries for unimplemented tools must not be added.
- **REQ-008**: All spoken confirmation and dismissal messages must be routed through `enqueueSpeak` so they respect TTS mode (Kokoro / browser / off).
- **SEC-001**: The confirmation banner Yes / No buttons must call `_clearFuzzyConfirmState()` before any action — prevents double-fire if the user clicks after speaking a confirmation.
- **CON-001**: No new backend files, endpoints, or Python dependencies. Both tiers are purely frontend changes plus a single `.env` flag.
- **CON-002**: `SYSTEM_PROMPT` is a `const` string built at page load in `frontend/app.js`. The manifest block is appended inline — no dynamic rebuild at runtime.
- **CON-003**: The existing `_routeInput()` function is the single integration point. No changes to `handleSend()`, `mediaRecorder.onstop`, or any tool module.
- **GUD-001**: Follow the existing intercept pattern: check condition → act + `return` early → fall through to LLM otherwise.
- **GUD-002**: The confirmation banner must match the existing HUD aesthetic: dark background, monospaced font, no colour except a subtle white/grey accent on the tool name.
- **PAT-001**: New module `frontend/fuzzy-tool-detect.js` exports `detectFuzzyToolIntent()` as a named export and is imported at the top of `app.js` alongside the other tool imports.

---

## 2. Implementation Steps

### Implementation Phase 1 — Toolkit Manifest (Tier 1)

- GOAL-001: Append a plain-prose tool manifest to Starling's system prompt so she can answer "what can you do?" accurately without hallucinating.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In `frontend/app.js`, immediately before the `SYSTEM_PROMPT` const declaration, define a new `const TOOLKIT_MANIFEST_BLOCK` string. The block must be prefixed with a natural-language instruction and list every currently active tool with its canonical trigger phrases and a one-sentence description. See the **exact string content** in §5. | | |
| TASK-002 | Append `TOOLKIT_MANIFEST_BLOCK` to the `SYSTEM_PROMPT` const. The `SYSTEM_PROMPT` declaration currently ends with the `'Never narrate or describe...'` sentence. Concatenate `' ' + TOOLKIT_MANIFEST_BLOCK` immediately after that last sentence, before the closing string delimiter. This keeps the manifest co-located with the prompt so both are updated together. | | |
| TASK-003 | Add `TOOLKIT_MANIFEST_ENABLED=true` to `.env` and `.env.example` with an inline comment explaining the flag. Since the manifest is baked into the frontend JS constant there is no runtime env check — this entry is documentation-only, signalling intent for a future dynamic version. | | |
| TASK-004 | Verify manually: reload the page, open the browser console, and `console.log(SYSTEM_PROMPT)` to confirm the manifest block appears at the end. Then say or type "what tools do you have?" and confirm Starling lists all active tools in natural prose. | | |

---

### Implementation Phase 2 — Fuzzy Detect Module (Tier 2 foundation)

- GOAL-002: Create the `frontend/fuzzy-tool-detect.js` module containing the `FUZZY_TOOL_MAP`, confidence threshold, and the `detectFuzzyToolIntent()` function.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Create `frontend/fuzzy-tool-detect.js`. The file must export two named symbols: `FUZZY_THRESHOLD` (number, `0.30`) and `detectFuzzyToolIntent(transcript, activeToolCheckers)`. See §5 for the exact module source. | | |
| TASK-006 | Define `FUZZY_TOOL_MAP` as a module-level `const` array inside `fuzzy-tool-detect.js`. Include one entry per currently active tool: **Dossier**, **Timer**, **Time / Date**, **Weather**, **News**. Each entry shape: `{ toolName: string, fuzzyKeywords: string[], minMatches: number }`. `minMatches` overrides the default threshold for short keyword lists (e.g. a 2-keyword list needs `minMatches: 1` to be useful). | | |
| TASK-007 | Implement `detectFuzzyToolIntent(transcript, skipNames = [])` inside `fuzzy-tool-detect.js`. Algorithm: (1) return `null` if `transcript.trim().length < 5`; (2) normalise to lowercase, strip punctuation via `/[^a-z0-9\s]/g`; (3) for each entry in `FUZZY_TOOL_MAP` that is not in `skipNames`, count keyword hits; (4) compute `confidence = hits / entry.fuzzyKeywords.length`; (5) if `confidence >= FUZZY_THRESHOLD` **and** `hits >= entry.minMatches`, add to candidates; (6) return the candidate with the highest confidence, or `null` if none qualify. | | |
| TASK-008 | Add the import line at the top of `frontend/app.js` alongside the existing tool imports: `import { detectFuzzyToolIntent } from './fuzzy-tool-detect.js';` | | |

---

### Implementation Phase 3 — Confirm State & UI Banner

- GOAL-003: Add the in-session fuzzy confirm state variables, the 15-second auto-dismiss timeout, and the visible confirmation banner in the UI.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-009 | In `frontend/app.js`, in the "Conversation state" section (near `let conversationHistory`), declare three new module-level variables: `let _fuzzyConfirmPending = false;`, `let _fuzzyPendingTool = null;`, and `let _fuzzyTimeoutId = null;`. | | |
| TASK-010 | Write the `_clearFuzzyConfirmState()` helper function in `app.js`. It must: (1) set `_fuzzyConfirmPending = false` and `_fuzzyPendingTool = null`; (2) call `clearTimeout(_fuzzyTimeoutId)` and set `_fuzzyTimeoutId = null`; (3) hide the confirmation banner element (`document.getElementById('fuzzy-confirm-banner').classList.add('hidden')`). | | |
| TASK-011 | Write `_enterFuzzyConfirmState(tool)` helper in `app.js`. It must: (1) call `_clearFuzzyConfirmState()` to reset any prior state; (2) set `_fuzzyConfirmPending = true` and `_fuzzyPendingTool = tool`; (3) populate the banner's tool-name span with `tool.toolName`; (4) remove the `hidden` class from the banner; (5) start the 15-second auto-dismiss: `_fuzzyTimeoutId = setTimeout(() => { _clearFuzzyConfirmState(); enqueueSpeak('Okay, I\'ll cancel that.'); }, 15000)`. | | |
| TASK-012 | Add the confirmation banner HTML to `frontend/index.html`. Insert it as the first child of the `<body>` (or immediately after the `<header>` — before all tool panel divs) so it renders above all other content via z-index. Exact markup: `<div id="fuzzy-confirm-banner" class="hidden"><span class="fcb-label">Did you mean to open</span> <span id="fcb-tool-name" class="fcb-tool"></span><span class="fcb-label">?</span><div class="fcb-buttons"><button id="fcb-yes">Yes</button><button id="fcb-no">No</button></div></div>` | | |
| TASK-013 | Add CSS for `#fuzzy-confirm-banner` in `frontend/style.css`. Rules: fixed position, `bottom: 80px; left: 50%; transform: translateX(-50%)`, `background: #0d0d0d`, `border: 1px solid #333`, `padding: 10px 18px`, `border-radius: 4px`, `font-family: monospace`, `font-size: 0.75rem`, `color: #aaa`, `z-index: 9999`, `display: flex; align-items: center; gap: 8px`. `.fcb-tool` in white (`color: #fff; letter-spacing: 0.05em`). `.fcb-buttons` flex row with `gap: 8px`. `#fcb-yes, #fcb-no` styled as minimal pill buttons: `padding: 3px 10px; border: 1px solid #555; background: transparent; color: #ccc; cursor: pointer; font-family: monospace; font-size: 0.7rem; border-radius: 3px`. `#fcb-yes:hover` with `border-color: #fff; color: #fff`. `#fcb-no:hover` same. The `.hidden` class (`display: none`) is already defined globally in the project. | | |
| TASK-014 | Wire the Yes / No buttons in `app.js` (after DOM refs section). `document.getElementById('fcb-yes').addEventListener('click', () => { if (!_fuzzyConfirmPending) return; const tool = _fuzzyPendingTool; _clearFuzzyConfirmState(); enqueueSpeak('Opening ' + tool.toolName + '.'); tool.openFn(); });` and `document.getElementById('fcb-no').addEventListener('click', () => { _clearFuzzyConfirmState(); enqueueSpeak('Okay, never mind.'); });` | | |

---

### Implementation Phase 4 — Intercept Chain Integration

- GOAL-004: Insert the fuzzy confirm check and fuzzy detection call into `_routeInput()` at the correct positions, and wire cleanup into the clear button handler.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-015 | In `_routeInput(text)` in `app.js`, add the fuzzy confirm resolution block **immediately after** `dismissAllToolPanels()` and **before** the `_matchesExitPhrase` check. This is intercept position 1 in the current chain (and will become position 3 once journal/ideas modes are added). The block: check `if (_fuzzyConfirmPending)`, normalise transcript, test for affirmative tokens (`yes|yeah|yep|correct|do it|open it|go ahead|sure|please`), test for negative tokens (`no|nope|cancel|never mind|stop`), or fall through to "ambiguous" re-prompt. See §5 for the exact code block. | | |
| TASK-016 | In `_routeInput(text)`, add the fuzzy detection call as intercept position **N-1** — immediately before the final `appendMessage('user', text); await sendToOllama(text);` lines. Build a `skipNames` array from currently matched tools (all tools have already returned by this point, so the list is always empty here — include the parameter for forward compatibility). Call `const fuzzyMatch = detectFuzzyToolIntent(text, []);`. If a match is returned, call `appendMessage('user', text);`, then `_enterFuzzyConfirmState({ ...fuzzyMatch, openFn: () => _retriggerTool(fuzzyMatch.toolName, text) })`, then `return`. | | |
| TASK-017 | Write `_retriggerTool(toolName, originalTranscript)` helper in `app.js`. This function maps a confirmed `toolName` string to its actual handler call. Use a `switch` on `toolName` to call the correct handler: `'Timer'` → `handleTimerTrigger(originalTranscript, detectTimerTrigger(originalTranscript))`, `'Weather'` → `_routeWeather(originalTranscript)`, `'News'` → `_routeNews(originalTranscript)`, `'Time / Date'` → detect and call `handleTimeQuery` or `handleDateQuery`, `'Dossier'` → `enterPresMode(null)` (no subject recoverable from noise). Each case must call `setState('thinking')` first and `fetchSystemStatus()` after, following the pattern used by the same handlers inside `_routeInput()`. | | |
| TASK-018 | Add `_clearFuzzyConfirmState()` to the `clearBtn` click handler in `app.js`, alongside the existing `clearAudioQueue()` and `dismissAllToolPanels()` calls. | | |
| TASK-019 | Add `_clearFuzzyConfirmState()` to the `exitPresMode()` function body in `app.js` (called when dossier closes, preventing stale state). | | |

---

### Implementation Phase 5 — Validation & Testing

- GOAL-005: Verify both tiers work end-to-end under normal, near-miss, and edge-case conditions.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | **Tier 1 — Self-description**: Type "What can you do?" → Starling lists all active tools in plain prose, no markdown. | | |
| TASK-021 | **Tier 1 — Specific capability query**: Type "Do you have a weather tool?" → Starling confirms and describes the trigger phrases. Type "Can you set a reminder?" → Starling mentions the timer tool. | | |
| TASK-022 | **Tier 2 — Clean near-miss**: Simulate a garbled transcript by typing "weather rain temperature" (keywords but no canonical phrase) → confirm banner appears: "Did you mean to open Weather?" → say/type "yes" → weather panel opens. | | |
| TASK-023 | **Tier 2 — Negative confirmation**: Trigger fuzzy match, then say "no" → banner dismisses, Starling says "Okay, never mind.", input falls through to LLM. | | |
| TASK-024 | **Tier 2 — Ambiguous follow-up**: Trigger fuzzy match, then say something unrelated → Starling re-prompts "Did you want to open [Tool]? Say yes or no." → confirm state stays active. | | |
| TASK-025 | **Tier 2 — 15 s auto-dismiss**: Trigger fuzzy match, then do nothing for 15 seconds → banner disappears, Starling says "Okay, I'll cancel that." | | |
| TASK-026 | **Tier 2 — Button click confirmation**: Trigger fuzzy match via voice → click the Yes button in the banner (rather than speaking) → tool opens correctly. | | |
| TASK-027 | **Tier 2 — Clear button cleanup**: Trigger fuzzy match → press the clear button → banner disappears, conversation resets, no orphaned state. | | |
| TASK-028 | **Tier 2 — Short transcript guard**: Submit a 3-character transcript (e.g. "um") → fuzzy detection does not fire, falls through to LLM normally. | | |
| TASK-029 | **Tier 2 — Canonical trigger not intercepted**: Say "What's the weather?" (canonical match) → weather opens immediately without fuzzy banner appearing. | | |

---

## 3. Alternatives

- **ALT-001**: **Backend system-prompt injection via env var** — append the toolkit manifest to `LLAMA_SYSTEM_PROMPT` in `.env` instead of in `app.js`. Rejected: the backend `SYSTEM_PROMPT` in `llama_server.py` is only the fallback for when the frontend omits a system message. The real system prompt is sent by `app.js` in every request's conversation history. Changes to the env var would have no effect in practice.
- **ALT-002**: **LLM-based intent classification for fuzzy detection** — send the ambiguous transcript to the LLM and ask it to classify which tool (if any) was intended. Rejected: introduces an extra LLM round-trip (~2–3 s of latency) before even presenting a confirmation prompt; the keyword-scoring approach operates in < 1 ms entirely in-browser with no network call.
- **ALT-003**: **Levenshtein / edit-distance matching on canonical trigger phrases** — score the transcript against canonical trigger strings using edit distance. Rejected: canonical phrases are multi-word and vary in length; edit distance doesn't generalise well across "set a timer for five minutes" vs garbled "timer five mints". Keyword-presence scoring handles token-level distortion more robustly.
- **ALT-004**: **Dedicated `/fuzzy-intent` backend endpoint** — expose a POST endpoint that accepts the transcript and returns the best-matched tool. Rejected: adds backend complexity, network latency, and a new dependency, all for a computation that takes < 1 ms in plain JS.
- **ALT-005**: **Persist fuzzy confirm state in `localStorage`** — survive a page refresh within the session. Rejected: a fuzzy confirm prompt older than a few seconds is meaningless; there is no valid use case for restoring it across a page load.

---

## 4. Dependencies

- **DEP-001**: `frontend/app.js` — single integration point for both tiers. Must be edited for SYSTEM_PROMPT append (Tier 1) and `_routeInput()` changes (Tier 2).
- **DEP-002**: `frontend/fuzzy-tool-detect.js` — new file to create (Tier 2 only). No external dependencies.
- **DEP-003**: `frontend/index.html` — requires the `#fuzzy-confirm-banner` div (Tier 2 only).
- **DEP-004**: `frontend/style.css` — requires banner CSS rules (Tier 2 only).
- **DEP-005**: `.env` / `.env.example` — documentation entry `TOOLKIT_MANIFEST_ENABLED` (Tier 1). No runtime dependency.
- **DEP-006**: Existing tool handlers (`detectTimerTrigger`, `handleTimerTrigger`, `detectWeatherTrigger`, `openWeatherPanel`, `detectNewsTrigger`, `openNewsPanel`, `detectTimeTrigger`, `detectDateTrigger`, `handleTimeQuery`, `handleDateQuery`) — must all be available in scope when `_retriggerTool()` is called. All are already imported or defined in `app.js`.

---

## 5. Files

- **FILE-001**: `frontend/app.js` — append `TOOLKIT_MANIFEST_BLOCK` to `SYSTEM_PROMPT`; add state vars; add helpers `_clearFuzzyConfirmState()`, `_enterFuzzyConfirmState()`, `_retriggerTool()`; modify `_routeInput()`; modify `clearBtn` handler; modify `exitPresMode()`.
- **FILE-002**: `frontend/fuzzy-tool-detect.js` — new module; exports `detectFuzzyToolIntent()` and `FUZZY_THRESHOLD`.
- **FILE-003**: `frontend/index.html` — add `#fuzzy-confirm-banner` div.
- **FILE-004**: `frontend/style.css` — add banner styles.
- **FILE-005**: `.env` / `.env.example` — add documentation comment for `TOOLKIT_MANIFEST_ENABLED`.

### Exact source content

#### `TOOLKIT_MANIFEST_BLOCK` constant (insert in `frontend/app.js` before `SYSTEM_PROMPT`)

```js
const TOOLKIT_MANIFEST_BLOCK =
  'You have access to the following built-in tools. When the user asks what you can do, which tools are available, ' +
  'or whether you support a specific capability, describe these tools accurately in natural prose. ' +

  'Dossier mode: opens a full-screen intelligence dossier panel for a named subject. ' +
  'Trigger phrases: "open the dossier on [name]", "show me [name]\'s dossier", "pull up the dossier for [name]". ' +

  'Timers: sets and cancels named countdown timers entirely in the browser — no network required. ' +
  'Trigger phrases: "set a [duration] timer", "set a [duration] timer called [name]", "cancel the [name] timer", "what timers are running". ' +

  'Time and date: reads the local system clock and answers immediately without an LLM call. ' +
  'Trigger phrases: "what time is it", "what\'s the time", "what\'s today\'s date", "what day is it". ' +

  'Weather: fetches the current forecast and a multi-day outlook from Open-Meteo — no API key required. ' +
  'Trigger phrases: "what\'s the weather", "weather forecast", "weather in [location]", "show me the weather for [location]". ' +

  'News briefing: reads RSS headlines by category and delivers a spoken summary. ' +
  'Trigger phrases: "news briefing", "show me the headlines", "what\'s in the news", "tech news", "show me the [category] news". ';
```

> Append `' ' + TOOLKIT_MANIFEST_BLOCK` at the end of the existing `SYSTEM_PROMPT` const string — after the final `'Never narrate...'` sentence, before the closing `'` of the template literal or string.

---

#### `frontend/fuzzy-tool-detect.js` — complete module source

```js
// ── fuzzy-tool-detect.js ──────────────────────────────────────────────────────
// Keyword-scoring fuzzy intent detector for the Starling tool intercept chain.
// Called at intercept position N-1 (just before sendToOllama fallback) when no
// canonical tool trigger has matched. Returns the best-matching tool entry or null.

export const FUZZY_THRESHOLD = 0.30;   // min fraction of keywords that must hit

// One entry per currently active tool. Keep in sync with _routeInput() in app.js.
// minMatches overrides the threshold for short keyword lists.
const FUZZY_TOOL_MAP = [
  {
    toolName: 'Dossier',
    fuzzyKeywords: ['dossier', 'briefing', 'profile', 'intel', 'file', 'record'],
    minMatches: 1,
  },
  {
    toolName: 'Timer',
    fuzzyKeywords: ['timer', 'remind', 'countdown', 'alarm', 'minutes', 'seconds', 'hours'],
    minMatches: 1,
  },
  {
    toolName: 'Time / Date',
    fuzzyKeywords: ['time', 'clock', 'date', 'day', 'today', 'hour'],
    minMatches: 2,    // 'time' alone is too ambiguous; require 2 hits
  },
  {
    toolName: 'Weather',
    fuzzyKeywords: ['weather', 'forecast', 'temperature', 'rain', 'cloud', 'sunny', 'degrees'],
    minMatches: 1,
  },
  {
    toolName: 'News',
    fuzzyKeywords: ['news', 'headlines', 'briefing', 'stories', 'latest', 'update'],
    minMatches: 1,
  },
];

/**
 * Score a transcript against each tool's keyword list.
 *
 * @param {string}   transcript  Raw STT output.
 * @param {string[]} skipNames   Tool names to exclude (already matched by canonical check).
 * @returns {{ toolName: string, confidence: number } | null}
 */
export function detectFuzzyToolIntent(transcript, skipNames = []) {
  if (!transcript || transcript.trim().length < 5) return null;

  const normalised = transcript.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const tokens     = normalised.split(/\s+/);

  let best = null;

  for (const entry of FUZZY_TOOL_MAP) {
    if (skipNames.includes(entry.toolName)) continue;

    const hits       = entry.fuzzyKeywords.filter(kw => tokens.includes(kw)).length;
    const confidence = hits / entry.fuzzyKeywords.length;

    if (hits >= entry.minMatches && confidence >= FUZZY_THRESHOLD) {
      if (!best || confidence > best.confidence) {
        best = { toolName: entry.toolName, confidence };
      }
    }
  }

  return best;
}
```

---

#### Fuzzy confirm resolution block (insert in `_routeInput()`, position 1)

```js
  // ── Fuzzy confirm resolution ────────────────────────────────────────────────
  // Intercept position 1: resolve any pending tool confirmation before other checks.
  if (_fuzzyConfirmPending && _fuzzyPendingTool) {
    const norm = text.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const isYes = /\b(yes|yeah|yep|correct|do it|open it|go ahead|sure|please)\b/.test(norm);
    const isNo  = /\b(no|nope|cancel|never mind|stop)\b/.test(norm);

    if (isYes) {
      const tool = _fuzzyPendingTool;
      _clearFuzzyConfirmState();
      enqueueSpeak('Opening ' + tool.toolName + '.');
      _retriggerTool(tool.toolName, text);
      return;
    }
    if (isNo) {
      _clearFuzzyConfirmState();
      enqueueSpeak('Okay, never mind.');
      return;
    }
    // Ambiguous — re-prompt and keep state active
    enqueueSpeak(
      'I didn\'t catch that. Did you want to open ' + _fuzzyPendingTool.toolName +
      '? Say yes or no.'
    );
    return;
  }
  // ── end fuzzy confirm resolution ────────────────────────────────────────────
```

---

#### Fuzzy detection call (insert in `_routeInput()`, just before final `appendMessage + sendToOllama`)

```js
  // ── Fuzzy tool intent detection ─────────────────────────────────────────────
  // Last intercept before LLM fallback: catch near-miss transcriptions.
  const _fuzzyMatch = detectFuzzyToolIntent(text, []);
  if (_fuzzyMatch) {
    appendMessage('user', text);
    _enterFuzzyConfirmState({
      toolName: _fuzzyMatch.toolName,
      openFn:   () => _retriggerTool(_fuzzyMatch.toolName, text),
    });
    return;
  }
  // ── end fuzzy detection ─────────────────────────────────────────────────────
```

---

#### `_retriggerTool()` helper (add to `app.js` near other helper functions)

```js
/**
 * Re-invoke a tool by name after fuzzy confirmation.
 * Each case mirrors the handler call inside _routeInput().
 */
function _retriggerTool(toolName, originalTranscript) {
  setState('thinking');
  switch (toolName) {
    case 'Timer': {
      const timerTrigger = detectTimerTrigger(originalTranscript);
      if (timerTrigger) {
        setState('idle');
        handleTimerTrigger(originalTranscript, timerTrigger);
      }
      break;
    }
    case 'Time / Date': {
      setState('idle');
      if (detectDateTrigger(originalTranscript)) {
        handleDateQuery(originalTranscript);
      } else {
        handleTimeQuery(originalTranscript);
      }
      break;
    }
    case 'Weather': {
      const wxTrigger = detectWeatherTrigger(originalTranscript);
      openWeatherPanel(wxTrigger ? wxTrigger.location : null).then(wxResult => {
        if (wxResult && !wxResult._wxErr) {
          sendToOllama(
            'Give a spoken weather briefing using only the weather data in your context.',
            { ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT +
              '\n\n[WEATHER DATA]\n' + wxResult }] }
          ).then(() => { _playbackChain.then(() => startWeatherAutoDismiss()); });
        }
        fetchSystemStatus();
      });
      break;
    }
    case 'News': {
      openNewsPanel().then(newsContext => {
        if (newsContext) {
          enterNewsMode();
          sendToOllama(
            'Deliver a concise spoken news briefing based on the headlines provided.',
            { ephemeralMessages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'system', content: `${_currentTimeContext()}\n${newsContext}` },
            ]}
          );
        }
        fetchSystemStatus();
      });
      break;
    }
    case 'Dossier':
      // No subject recoverable from a garbled transcript; open in unknown state.
      enterPresMode(null);
      setState('idle');
      break;
    default:
      // Unknown tool name — fall back to LLM with the original transcript.
      appendMessage('user', originalTranscript);
      sendToOllama(originalTranscript).then(() => fetchSystemStatus());
  }
}
```

---

## 6. Testing

- **TEST-001**: `detectFuzzyToolIntent('weather temperature rain', [])` → `{ toolName: 'Weather', confidence: 0.43 }` (3 of 7 keywords hit, above threshold).
- **TEST-002**: `detectFuzzyToolIntent('um', [])` → `null` (transcript < 5 chars).
- **TEST-003**: `detectFuzzyToolIntent('what time is it today', [])` → `{ toolName: 'Time / Date', ... }` (tokens `time`, `today` → 2 hits, meets `minMatches: 2`).
- **TEST-004**: `detectFuzzyToolIntent('timer reminder minutes', ['Timer'])` → `null` (Timer is in `skipNames`).
- **TEST-005**: `detectFuzzyToolIntent('hello there how are you', [])` → `null` (no keywords, below threshold).
- **TEST-006**: End-to-end voice: say "weather rain degrees" (no canonical phrase) → fuzzy banner appears → say "yes" → weather panel opens.
- **TEST-007**: End-to-end voice: say "yes" with no pending confirm → confirm block skips (guard `_fuzzyConfirmPending` is false), falls through to LLM normally.
- **TEST-008**: SYSTEM_PROMPT includes toolkit manifest block — `SYSTEM_PROMPT.includes('Dossier mode')` evaluates to `true`.
- **TEST-009**: 15-second auto-dismiss — trigger fuzzy match; after 15 s, `_fuzzyConfirmPending === false` and banner has `hidden` class.
- **TEST-010**: Clear button — trigger fuzzy match; press clear → `_fuzzyConfirmPending === false`, banner hidden, conversation history reset.

---

## 7. Risks & Assumptions

- **RISK-001**: **False-positive fuzzy matches** — a transcript containing the word "time" twice (e.g. "last time I checked the time") could trigger the Time / Date entry. Mitigated by the `minMatches: 2` guard and the confirmation step — the user can simply say "no" and the LLM receives the original text.
- **RISK-002**: **Token budget increase** — the toolkit manifest adds ~250–280 tokens to every request's system prompt. On a 4 096-token context model this is non-trivial (~7 %). Mitigated by the `TOOLKIT_MANIFEST_ENABLED` documentation flag which signals intent to add a runtime disable path. Llama 3.2 3B and Llama 3.1 8B both have 131 072-token contexts so the cost is negligible in practice.
- **RISK-003**: **Fuzzy confirm gating future mode flags** — when `journalMode` and `ideasMode` are implemented, the fuzzy confirm check must be moved to position 3 (after those guards). Failure to reorder will cause ambiguous journal/idea segments to be misinterpreted as tool confirmations. Mitigated by: the TODO.md intercept order table has been updated, and REQ-005 documents this explicitly.
- **RISK-004**: **`_retriggerTool` drift** — as new tools are added to `_routeInput()`, the `switch` in `_retriggerTool()` must be extended. If forgotten, confirmed fuzzy matches for new tools fall through to the `default` LLM case silently. Mitigated by: the `FUZZY_TOOL_MAP` in `fuzzy-tool-detect.js` and the `switch` in `_retriggerTool()` are the two places that must be updated in tandem — document in the code with a co-change comment.
- **RISK-005**: **Manifest staleness** — if a tool is disabled or removed from `_routeInput()` but `TOOLKIT_MANIFEST_BLOCK` is not updated, Starling will describe tools she cannot actually open. Mitigated by co-locating the manifest constant immediately before `SYSTEM_PROMPT` in `app.js`, making it visible during any tool-related edit.
- **ASSUMPTION-001**: The frontend ES module flag (`<script type="module">`) is already active on `index.html` — the project completed the Phase 11 prerequisite ES module conversion. If not, `fuzzy-tool-detect.js` must be inlined into `app.js` as an IIFE-exported function instead.
- **ASSUMPTION-002**: `detectDateTrigger` is exported from `timer-panel.js` or defined in `app.js` alongside `detectTimeTrigger`. Verified: both functions are used in the existing `_routeInput()`.
- **ASSUMPTION-003**: `enqueueSpeak` is accessible in the scope where `_enterFuzzyConfirmState` and `_clearFuzzyConfirmState` are called. Verified: `enqueueSpeak` is a module-level function defined above `_routeInput()` in `app.js`.

---

## 8. Related Specifications / Further Reading

- [TODO.md — Enhancement: Toolkit Awareness & Fuzzy Tool Recovery](../markdown/TODO.md) — the originating TODO entry with high-level task checklist
- [TODO.md — Phase 11 Final Intercept Order](../markdown/TODO.md) — updated intercept chain table showing positions 3 and 19 for the two new checks
- [frontend/app.js](../frontend/app.js) — `_routeInput()` function (line 1271), `SYSTEM_PROMPT` const (~line 335), `dismissAllToolPanels()` (line 519)
- [backend/llama_server.py](../backend/llama_server.py) — `SYSTEM_PROMPT` fallback (line 20); note this is superseded by the frontend-sent system message on every request
