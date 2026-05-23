---
goal: Visual Toolkit Menu — Browse Tools, LLM Briefing & One-Click Activation
version: 1.0
date_created: 2026-05-23
last_updated: 2026-05-23
owner: Daniel Simpson
status: 'Planned'
tags: [feature, frontend, voice-ux, toolkit, llm-interaction]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

A voice- and button-triggered overlay panel that presents every Starling tool as a
browsable card: tool name, one-sentence description, and canonical activation phrases.
Clicking any card silences the panel, hands the tool's name and description to the LLM,
and Starling speaks a natural briefing — then asks the user whether to activate it.
A Yes / No confirmation row (voice or click) either opens the tool directly or returns
to the menu. The panel is fully self-contained in `frontend/toolkit-panel.js` and wires
into the existing `_routeInput()` dispatch chain without touching any existing tool module.

---

## 1. Requirements & Constraints

- **REQ-001**: The toolkit menu must display every currently active tool: Dossier, Timer, Time, Date, Weather, News, Stocks / Market, Browser, Ideas Vault, Voice Journal, Wikipedia RAG. Planned (unimplemented) tools such as Wake Word, Calendar, and Gmail must not appear.
- **REQ-002**: Each tool card must show: tool name (uppercase, monospaced), a one-sentence plain-English description, and up to three representative activation phrases shown as `<code>` tags.
- **REQ-003**: When a card is clicked, the panel switches to a confirmation view. The LLM is called with a silent ephemeral system message containing the tool name and description plus a hard instruction to describe the tool in one or two sentences and ask whether the user wants to activate it now.
- **REQ-004**: The LLM's spoken response must be routed through `enqueueSpeak` so it respects TTS mode (Kokoro / browser / off).
- **REQ-005**: Confirmation must be possible by both button click ("YES" / "NO") and by voice — the confirm state intercept in `_routeInput()` must check the active transcript for affirmative / negative keywords.
- **REQ-006**: The confirm state must auto-cancel after 20 seconds with no follow-up input; Starling speaks `"Okay, closing the toolkit menu."` and the panel closes entirely.
- **REQ-007**: The toolkit registry (tool name, description, phrases, `openFn`) must be defined entirely in `app.js` as `const TOOLKIT_REGISTRY` and passed into `initToolkitPanel()` at startup. `toolkit-panel.js` must have zero imports from other panel modules, preventing circular dependencies.
- **REQ-008**: The voice trigger for the toolkit menu must fire before the dossier check in `_routeInput()` so it is not accidentally consumed by another intercept.
- **SEC-001**: The `openFn` callbacks stored in `TOOLKIT_REGISTRY` must be closures — no dynamic `eval()`, `new Function()`, or string-to-code execution.
- **CON-001**: No new backend endpoints or Python changes. This is a purely frontend feature.
- **CON-002**: The panel must be visually consistent with the existing HUD: `var(--bg)` background, `Share Tech Mono` for labels, `var(--c)` border accents, `hidden` class toggle for show/hide.
- **CON-003**: The confirmation view replaces the list view in-panel (not a separate DOM element) — toggle `.hidden` on `.toolkit-list-view` and `.toolkit-confirm-view` within the same `#toolkit-panel` div.
- **GUD-001**: Follow the module pattern established by `ideas-panel.js` and `weather-panel.js`: named exports for every public function, module-level DOM refs, no default export.
- **GUD-002**: The confirmation voice intercept must be inserted at position **1** in `_routeInput()` — the very first check — so it cannot be stolen by journal mode, ideas mode, or fuzzy detect (if present). Clear the state before routing to any tool action.
- **PAT-001**: The toolkit panel close button must call `closeToolkitPanel()` which internally calls `_clearToolkitConfirmState()` before hiding the panel, mirroring the fuzzy-confirm teardown pattern.

---

## 2. Implementation Steps

### Implementation Phase 1 — TOOLKIT_REGISTRY Definition

- GOAL-001: Define the canonical tool registry in `frontend/app.js` so every tool is described in one place and the data drives both the menu UI and the LLM confirmation prompt.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In `frontend/app.js`, immediately after the `SYSTEM_PROMPT` const (around line 346), declare `const TOOLKIT_REGISTRY`. This must be an `Array` of plain objects, one per active tool, in the order they appear in the dispatch chain. Each object shape: `{ id: string, name: string, description: string, phrases: string[], openFn: () => void }`. The `openFn` for tools that require parameters (e.g. Weather, News) should call the open function with no arguments to trigger a default/generic open. See §5 for the exact array literal. | | |
| TASK-002 | Populate TOOLKIT_REGISTRY with one entry for each of the 11 active tools listed in REQ-001. Field values must match the trigger phrase documentation in `toolkit/TRIGGER_PHRASES.md` and the descriptions in `toolkit/README.md`. The `openFn` for each tool must be a zero-argument arrow function calling the relevant panel's exported `open*` function (already imported at the top of `app.js`). Dossier's `openFn` should call `_openDossier(null)` (generic open with no subject). | | |

---

### Implementation Phase 2 — `frontend/toolkit-panel.js` Module

- GOAL-002: Create the self-contained toolkit panel module that owns the DOM interaction logic, tool-card rendering, and the custom event bridge to `app.js`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Create `frontend/toolkit-panel.js`. The file must have zero imports. Export the following named symbols: `initToolkitPanel(registry)`, `openToolkitPanel()`, `closeToolkitPanel()`, `isToolkitPanelOpen()`, `showToolkitConfirmView(toolName)`, `showToolkitListView()`. See §5 for the exact module source skeleton. | | |
| TASK-004 | Inside `toolkit-panel.js`, declare module-level DOM refs at the top (after the opening comment): `const _panel`, `const _listView`, `const _confirmView`, `const _confirmToolName`, `const _confirmResponse`, `const _yesBtn`, `const _noBtn`, `const _closeBtn`, `const _cardContainer`. Each assigned via `document.getElementById(...)` using the IDs defined in TASK-008. | | |
| TASK-005 | Implement `initToolkitPanel(registry)`. This function must: (1) store the registry in a module-level `let _registry`; (2) render a tool card for each registry entry into `_cardContainer` (see TASK-006 for card HTML); (3) wire the close button to `closeToolkitPanel()`; (4) wire `_yesBtn` and `_noBtn` to dispatch a `CustomEvent('toolkit:confirm', { detail: { confirmed: true/false } })` on `window`. | | |
| TASK-006 | Implement the card rendering logic inside `initToolkitPanel`. Each card must be a `<div class="toolkit-card">` containing: a `<div class="toolkit-card-name">` with the tool name in uppercase; a `<div class="toolkit-card-desc">` with the description; a `<div class="toolkit-card-phrases">` containing up to 3 `<code class="toolkit-phrase">` elements from `entry.phrases.slice(0, 3)`. Clicking the card must dispatch `CustomEvent('toolkit:tool-selected', { detail: entry })` on `window`. | | |
| TASK-007 | Implement `openToolkitPanel()`, `closeToolkitPanel()`, `isToolkitPanelOpen()`, `showToolkitConfirmView(toolName)`, and `showToolkitListView()`. `closeToolkitPanel` must always call `showToolkitListView()` before hiding so the panel resets to list state on next open. `showToolkitConfirmView(toolName)` populates `_confirmToolName.textContent = toolName`, hides `_listView`, and shows `_confirmView`. `showToolkitListView()` does the inverse. | | |

---

### Implementation Phase 3 — `frontend/index.html` Panel Markup

- GOAL-003: Add the toolkit panel HTML structure to the page.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | In `frontend/index.html`, insert the toolkit panel div immediately after the `<!-- Two-column body -->` opening `<div class="body-cols">` tag and before the `<!-- Left column -->` div. The panel must be a full-viewport overlay positioned absolutely. Exact markup: `<div id="toolkit-panel" class="toolkit-panel hidden"><div class="toolkit-header"><div class="toolkit-title">TOOLKIT</div><button class="toolkit-close-btn" id="toolkit-close-btn">✕</button></div><div class="toolkit-list-view" id="toolkit-list-view"><div class="toolkit-cards" id="toolkit-cards"></div></div><div class="toolkit-confirm-view hidden" id="toolkit-confirm-view"><div class="toolkit-confirm-label">Activate <span class="toolkit-confirm-tool-name" id="toolkit-confirm-tool-name"></span>?</div><div class="toolkit-confirm-response" id="toolkit-confirm-response"></div><div class="toolkit-confirm-buttons"><button class="toolkit-btn-yes" id="toolkit-btn-yes">YES</button><button class="toolkit-btn-no" id="toolkit-btn-no">NO — BACK</button></div></div></div>` | | |

---

### Implementation Phase 4 — `frontend/style.css` Panel Styles

- GOAL-004: Add styles that make the toolkit panel visually consistent with the existing dark HUD aesthetic.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-009 | Append a `/* ── Toolkit Menu Panel ──────────────────────────────────────────────── */` section to `frontend/style.css`. The `.toolkit-panel` rule must: `position: absolute; inset: 0; z-index: 80; background: rgba(10,10,10,0.97); display: flex; flex-direction: column; padding: 28px 32px; overflow: hidden;`. The `.hidden` class (already defined globally) handles show/hide. | | |
| TASK-010 | Add `.toolkit-header` styles: `display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; border-bottom: 1px solid rgba(200,200,200,0.12); padding-bottom: 12px;`. Add `.toolkit-title`: `font-family: 'Share Tech Mono', monospace; font-size: 11px; letter-spacing: 4px; color: rgba(200,200,200,0.5); text-transform: uppercase;`. Add `.toolkit-close-btn`: mirror the existing `.weather-close-btn` style — no background, no border, `color: rgba(200,200,200,0.45)`, `font-size: 18px`, `cursor: pointer`, `:hover` brightens to `rgba(200,200,200,0.9)`. | | |
| TASK-011 | Add `.toolkit-list-view` styles: `flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;`. Add `.toolkit-card`: `padding: 12px 14px; border: 1px solid rgba(200,200,200,0.1); border-radius: 2px; cursor: pointer; transition: border-color 0.2s, background 0.2s;`. On `:hover`: `border-color: rgba(200,200,200,0.35); background: rgba(200,200,200,0.04);`. | | |
| TASK-012 | Add `.toolkit-card-name`: `font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: 3px; color: var(--c); text-transform: uppercase; margin-bottom: 4px;`. Add `.toolkit-card-desc`: `font-size: 12px; color: rgba(200,200,200,0.55); line-height: 1.5; margin-bottom: 6px;`. Add `.toolkit-card-phrases`: `display: flex; flex-wrap: wrap; gap: 6px;`. Add `.toolkit-phrase`: `font-family: 'Share Tech Mono', monospace; font-size: 9px; color: rgba(200,200,200,0.4); background: rgba(200,200,200,0.06); padding: 2px 6px; border-radius: 2px;`. | | |
| TASK-013 | Add `.toolkit-confirm-view` styles: `flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 18px; padding: 12px 0;`. Add `.toolkit-confirm-label`: `font-family: 'Share Tech Mono', monospace; font-size: 13px; letter-spacing: 2px; color: rgba(200,200,200,0.6); text-transform: uppercase;`. Add `.toolkit-confirm-tool-name`: `color: var(--c);`. Add `.toolkit-confirm-response`: `font-size: 13px; color: rgba(200,200,200,0.7); line-height: 1.6; max-width: 580px;`. Add `.toolkit-confirm-buttons`: `display: flex; gap: 14px;`. Add `.toolkit-btn-yes` and `.toolkit-btn-no`: monospaced, small, uppercase buttons — YES in `rgba(200,200,200,0.8)` border/text, NO in `rgba(200,200,200,0.3)`. Both `:hover` states invert fill. | | |

---

### Implementation Phase 5 — `frontend/app.js` Integration

- GOAL-005: Wire the toolkit panel into the main app: import the module, define the voice trigger, register event listeners for card selection and confirmation, and manage the confirm state lifecycle.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-014 | Add the import line at the top of `frontend/app.js` alongside the other tool imports (after the journal import block): `import { initToolkitPanel, openToolkitPanel, closeToolkitPanel, isToolkitPanelOpen, showToolkitConfirmView, showToolkitListView } from './toolkit-panel.js';` | | |
| TASK-015 | After `TOOLKIT_REGISTRY` is declared (after TASK-001), call `initToolkitPanel(TOOLKIT_REGISTRY)` inside the existing `window.addEventListener('DOMContentLoaded', ...)` or equivalent startup block. Place it alongside `initTimerPanel()`, `initWeatherPanel()`, etc. | | |
| TASK-016 | In the "Conversation state" section of `app.js` (near `let conversationHistory`), declare two new module-level variables: `let _toolkitConfirmPending = false;` and `let _toolkitPendingTool = null;`. Also declare `let _toolkitConfirmTimeoutId = null;`. | | |
| TASK-017 | Write `_clearToolkitConfirmState()` helper in `app.js`. It must: (1) set `_toolkitConfirmPending = false` and `_toolkitPendingTool = null`; (2) `clearTimeout(_toolkitConfirmTimeoutId)` and set it to `null`; (3) call `showToolkitListView()`. | | |
| TASK-018 | Register a `window.addEventListener('toolkit:tool-selected', async (e) => { ... })` handler in `app.js`. On receipt: (1) call `_clearToolkitConfirmState()`; (2) store `_toolkitPendingTool = e.detail`; (3) call `showToolkitConfirmView(e.detail.name)`; (4) clear `_toolkitConfirmResponse` element text; (5) build LLM call: `ephemeralMessages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'The user is browsing the Starling toolkit menu and has selected the tool called "' + e.detail.name + '". Here is its description: ' + e.detail.description + ' In one or two concise sentences, tell the user what this tool does, then ask them plainly whether they would like to activate it now.' }]`; (6) stream the LLM response, display it in `#toolkit-confirm-response`, and enqueue it via `enqueueSpeak`; (7) start the 20-second auto-dismiss timeout: `_toolkitConfirmTimeoutId = setTimeout(() => { _clearToolkitConfirmState(); closeToolkitPanel(); enqueueSpeak('Okay, closing the toolkit menu.'); }, 20000)`. | | |
| TASK-019 | Register a `window.addEventListener('toolkit:confirm', (e) => { ... })` handler in `app.js`. On receipt: (1) call `clearTimeout(_toolkitConfirmTimeoutId)`; (2) if `e.detail.confirmed` is `true` and `_toolkitPendingTool` is not null, call `_toolkitPendingTool.openFn()` then call `closeToolkitPanel()`; (3) if `e.detail.confirmed` is `false`, call `_clearToolkitConfirmState()` (which returns to list view, panel stays open). | | |
| TASK-020 | Write `detectToolkitMenuTrigger(transcript)` as a module-level function in `app.js`. The function must return `true` if the lowercased transcript matches any of: `/\b(?:show|open|display|list)\b.{0,20}\b(?:tools?|toolkit|menu)\b/i`, `/\bwhat tools?\b/i`, `/\bshow me (?:your|all) tools?\b/i`, `/\btool (?:menu|list)\b/i`. Returns `false` otherwise. | | |
| TASK-021 | Insert the toolkit confirm intercept and toolkit menu trigger into `_routeInput(text)`. The toolkit confirm intercept must be the **first** check in the function body (before all other checks): `if (_toolkitConfirmPending) { const t = text.trim().toLowerCase(); if (/\b(?:yes|yeah|yep|sure|do it|activate|open it|confirm)\b/.test(t)) { window.dispatchEvent(new CustomEvent('toolkit:confirm', { detail: { confirmed: true } })); return; } if (/\b(?:no|nope|cancel|never mind|nevermind|back|go back|close)\b/.test(t)) { window.dispatchEvent(new CustomEvent('toolkit:confirm', { detail: { confirmed: false } })); return; } }`. Immediately after the existing dossier exit check (not before it — dossier exit must still fire while toolkit is open), add: `if (detectToolkitMenuTrigger(text)) { openToolkitPanel(); return; }`. | | |

---

## 3. Alternatives

- **ALT-001**: Embed the TOOLKIT_REGISTRY in `toolkit-panel.js` and import the open functions directly into that module. Rejected because it creates circular imports — `toolkit-panel.js` would depend on `weather-panel.js`, `news-panel.js`, etc., and those modules are already imported by `app.js`.
- **ALT-002**: Use a dedicated route / page for the toolkit menu rather than an overlay panel. Rejected to maintain UX continuity — the existing HUD design uses in-page overlays (dossier mode, wiki panel, weather panel) and the toolkit menu should follow the same pattern.
- **ALT-003**: Skip the LLM confirmation step and activate the tool immediately on card click. Rejected per the feature specification — the LLM briefing and confirmation step is a first-class requirement.
- **ALT-004**: Persist the confirmation state in `toolkit-panel.js` rather than `app.js`. Rejected because the LLM call, TTS queueing, and voice intercept all live in `app.js`. Splitting state across modules without a shared event bus would create hidden coupling.

---

## 4. Dependencies

- **DEP-001**: All tool panel modules (`weather-panel.js`, `news-panel.js`, `stocks-panel.js`, `browser-panel.js`, `ideas-panel.js`, `journal-panel.js`, `wiki-panel.js`, `timer-panel.js`) must export a callable zero-argument open function (or a wrapper for it) before `TOOLKIT_REGISTRY` can reference them.
- **DEP-002**: `enqueueSpeak` must be accessible at module scope in `app.js` at the time the `toolkit:tool-selected` event handler fires — it already is per the existing codebase.
- **DEP-003**: The `SYSTEM_PROMPT` const must be declared before `TOOLKIT_REGISTRY` in `app.js` since TASK-018 references it inside the event handler closure.

---

## 5. Files

- **FILE-001**: `frontend/toolkit-panel.js` — new module; owns panel DOM logic, card rendering, and custom event dispatch.
- **FILE-002**: `frontend/app.js` — add `TOOLKIT_REGISTRY` const, `detectToolkitMenuTrigger()`, `_clearToolkitConfirmState()`, event listeners, and state variables; modify `_routeInput()`.
- **FILE-003**: `frontend/index.html` — add `#toolkit-panel` overlay div with list and confirm sub-views.
- **FILE-004**: `frontend/style.css` — add toolkit panel styles.

---

## 6. Testing

- **TEST-001**: Voice trigger — say or type `"show me your tools"` and verify the toolkit panel opens, displaying all 11 active tool cards, each with name, description, and up to 3 phrases.
- **TEST-002**: Card click → LLM flow — click the "Weather" card; verify the panel switches to the confirm view, the `#toolkit-confirm-response` element is populated with a spoken briefing from the LLM, and `enqueueSpeak` receives the same text.
- **TEST-003**: Voice confirmation — while in confirm state, say `"yes"` and verify the Weather panel opens and the toolkit panel closes.
- **TEST-004**: Voice rejection — repeat TASK-002 but say `"no"` and verify the toolkit panel returns to the list view without opening any tool.
- **TEST-005**: Button confirmation — click the YES button in the confirm view and verify the target tool opens.
- **TEST-006**: Auto-dismiss timeout — open the confirm view, do nothing for 20 seconds, and verify Starling speaks `"Okay, closing the toolkit menu."` and the panel closes.
- **TEST-007**: Dispatch chain priority — with `_toolkitConfirmPending = true`, say `"weather"` (a weather trigger); verify the voice intercept consumes it as a non-matching confirm response (no affirmative/negative keyword) and does NOT route to the weather tool, demonstrating the confirm intercept fires first.
- **TEST-008**: Panel reset — open toolkit, click a card (enter confirm view), click NO, verify list view is restored, then click close button and verify panel is hidden and `_toolkitConfirmPending` is `false`.
- **TEST-009**: Dossier tool entry — click the Dossier card; verify `_openDossier(null)` is called on confirmation, opening the dossier panel in its generic (no-subject) state.
- **TEST-010**: Toolkit trigger phrases — test all regex branches in `detectToolkitMenuTrigger`: `"show tools"`, `"open toolkit"`, `"what tools do you have"`, `"tool menu"`, `"list tools"`, `"show me all your tools"`.

---

## 7. Risks & Assumptions

- **RISK-001**: If the LLM is slow to respond in the `toolkit:tool-selected` handler, the confirm view will show an empty response area briefly. Mitigation: populate `#toolkit-confirm-response` with a placeholder string `"…"` immediately before the LLM call, replace it as tokens stream in.
- **RISK-002**: The 20-second auto-dismiss timeout in TASK-018 may conflict with a slow LLM response that is still streaming when the timeout fires. Mitigation: `_clearToolkitConfirmState()` does not cancel the TTS queue — the already-enqueued speech will still play even after the panel closes.
- **RISK-003**: If a tool's `openFn` requires internal state to be set first (e.g., journal mode flags), calling it from `TOOLKIT_REGISTRY` may produce an incomplete open. Mitigation: inspect each tool's open function signature before populating `openFn`; use a wrapper if setup steps are needed.
- **ASSUMPTION-001**: All tool open functions exported from the panel modules accept zero arguments for a generic/default open — verified for Weather (`openWeatherPanel()`), News (`openNewsPanel()`), Browser (`openBrowserPanel()`). Dossier requires a subject argument; the wrapper will pass `null`.
- **ASSUMPTION-002**: The `hidden` CSS class is defined globally in `style.css` as `display: none !important` (or equivalent), consistent with its use throughout the existing codebase for all panel show/hide toggling.
- **ASSUMPTION-003**: The voice intercept priority defined in TASK-021 (toolkit confirm as position 1) will not conflict with the fuzzy-detect confirm intercept defined in `plan/TOOL_AWARENESS.md` — the two plans must be reconciled if both are implemented simultaneously. The toolkit confirm intercept should take priority over fuzzy confirm since it is an explicit user-initiated flow.

---

## 8. Related Specifications / Further Reading

- [plan/TOOL_AWARENESS.md](../plan/TOOL_AWARENESS.md) — Toolkit manifest injection and fuzzy tool recovery; shares system-prompt tool data with this feature.
- [toolkit/TRIGGER_PHRASES.md](../toolkit/TRIGGER_PHRASES.md) — Canonical voice trigger reference for all tools; source of truth for `phrases` arrays in `TOOLKIT_REGISTRY`.
- [toolkit/README.md](../toolkit/README.md) — Tool inventory, status, and dispatch priority order; source of truth for which tools are active (REQ-001).
- [frontend/app.js](../frontend/app.js) — Primary integration file; `_routeInput()` dispatch chain and `SYSTEM_PROMPT` const.
- [frontend/ideas-panel.js](../frontend/ideas-panel.js) — Reference module pattern for named exports, DOM refs, and trigger detection.
