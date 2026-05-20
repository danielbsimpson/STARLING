---
goal: Session Log Dashboard — Filterable, Searchable, Stats-Enabled Log Viewer
version: '1.0'
date_created: 2026-05-20
last_updated: 2026-05-20
owner: simps
status: 'Planned'
tags: [feature, frontend, dashboard, logging, devtools, diagnostics]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

The current `GET /log/viewer` endpoint returns a minimal inline HTML table with a session dropdown and no filtering capability. This plan replaces it with a proper **log dashboard** — a standalone HTML page served as a static frontend file, styled consistently with the S.T.A.R.L.I.N.G. aesthetic, that lets the user quickly diagnose system behaviour by browsing, filtering, searching, and inspecting every event recorded by the session logging system (`feature-session-activity-logging-1.md`).

The dashboard features a two-panel layout: a left sidebar listing all session files with their duration and event counts; a main panel showing the event table for the selected session with per-type colour coding, an event-type filter, a text search box, expandable row detail, a stats strip, an export button, and an auto-refresh toggle for the live session. A new `GET /log/stats/{session_id}` backend endpoint provides pre-aggregated statistics so the frontend does not have to scan the full JSONL itself.

## 1. Requirements & Constraints

- **REQ-001**: The dashboard must be accessible at `GET /log/viewer` (existing URL). The endpoint must redirect (HTTP 302) to `/log-dashboard.html`, which is served as a static file by the existing FastAPI `StaticFiles` mount in `main.py`.
- **REQ-002**: The dashboard must display all events for a selected session in a scrollable table with columns: row index, absolute timestamp, elapsed-since-session-start (ms), source (`frontend`/`backend`), event type (colour-coded), and a one-line summary extracted from the `data` field.
- **REQ-003**: An event-type filter must allow the user to show/hide rows by event type using a multi-select dropdown or a row of toggle buttons. Toggling a type must update the visible rows instantly without re-fetching from the server.
- **REQ-004**: A text search input must filter visible rows to those where any field (event type, source, or `data` JSON string) contains the search term (case-insensitive). Filtering must occur on `input` (keystroke), not on form submit.
- **REQ-005**: Clicking any table row must expand an inline detail section beneath that row showing the full prettified JSON of the event's `data` field. Clicking the same row again must collapse it.
- **REQ-006**: A session stats strip must display for the loaded session: total events, session wall-clock duration, count of LLM calls, count of tool dispatches, count of errors, and list of unique tools used. Stats are fetched from `GET /log/stats/{session_id}`.
- **REQ-007**: An "Export JSONL" button must download the raw JSONL for the selected session as a file named `<session_id>.jsonl` using a browser `<a download>` link pointing to `GET /log/sessions/{session_id}`.
- **REQ-008**: An "Auto-refresh" toggle must be available when the selected session matches the live session ID (obtained from `GET /health`). When enabled, the table must reload every 5 seconds and scroll to the bottom to show new events.
- **REQ-009**: The dashboard must be styled using the existing S.T.A.R.L.I.N.G. colour palette (`#0a0a0a` background, `#c8c8c8` primary text, `Share Tech Mono` / `Exo 2` fonts, matching the event type colours already defined in the existing log viewer) and the same Google Fonts CDN import used in `frontend/index.html`.
- **REQ-010**: The dashboard must be accessible only from `localhost`. The backend endpoints it calls (`/log/sessions`, `/log/sessions/{id}`, `/log/stats/{id}`) already enforce this. The dashboard HTML itself does not require an additional server-side guard.
- **CON-001**: No new npm/Python packages may be introduced. The dashboard is a single self-contained HTML file with no build step and no external JavaScript frameworks.
- **CON-002**: The dashboard must not break the existing API contract of `GET /log/sessions`, `GET /log/sessions/{session_id}`, or `POST /log/event`.
- **CON-003**: The `GET /log/viewer` endpoint must continue to work as an entry point — it redirects to the new dashboard URL rather than being removed.
- **GUD-001**: The dashboard file must be placed at `frontend/log-dashboard.html` so it is served by the existing `StaticFiles` mount at `http://localhost:8000/log-dashboard.html`.
- **GUD-002**: The event-type summary column must use a fixed mapping of event type → summary extractor function so the logic is table-driven, not a chain of if-else. For unknown event types, fall back to the first 120 characters of `JSON.stringify(data)`.
- **GUD-003**: All fetch calls in the dashboard must handle errors gracefully — display an inline error message rather than leaving the table in a loading state.
- **PAT-001**: Follow the existing event-type colour scheme from `log_routes.py` exactly: `session_start/end` → `#66ffaa`, `user_speech` → `#88ccff`, `user_text` → `#aaddff`, `tool_dispatch` → `#ffdd88`, `tool_call` → `#ffaa44`, `tool_result` → `#44cc88`, `llm_request` → `#cc88ff`, `llm_response` → `#aa66ee`, `error` → `#ff6677`.

## 2. Implementation Steps

### Implementation Phase 1 — Backend Stats Endpoint

- GOAL-001: Add `GET /log/stats/{session_id}` to `backend/log_routes.py` — parses the session JSONL and returns pre-aggregated statistics so the frontend does not have to process the full file.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In `backend/log_routes.py`, add `@router.get("/stats/{session_id}")` route. Apply the same localhost guard and `_SESSION_ID_RE` validation as `GET /log/sessions/{session_id}`. Return HTTP 403 / 400 / 404 on the same conditions. | | |
| TASK-002 | In the stats handler body, open `session_log.LOG_DIR / f"{session_id}.jsonl"` and iterate line by line. Parse each line as JSON. Accumulate: `event_counts: dict[str, int]` (count per `event` key), `tools_used: list[str]` (unique `data.tool` values from `tool_dispatch` events), `error_count: int` (count of `error` events), `session_start_ts: Optional[str]` (from the first `session_start` event's `ts`), `session_end_ts: Optional[str]` (from the last `session_end` event's `ts`). | | |
| TASK-003 | Compute derived fields before returning: `llm_calls: int = event_counts.get("llm_request", 0)`, `tool_dispatches: int = event_counts.get("tool_dispatch", 0)`, `total_events: int = sum(event_counts.values())`. Compute `duration_s: Optional[float]`: if both `session_start_ts` and `session_end_ts` are present, parse as ISO 8601 datetimes and return `(end - start).total_seconds()`. Return `None` if either is missing (live session). Return all fields as a JSON object. | | |

### Implementation Phase 2 — Redirect Existing Viewer Endpoint

- GOAL-002: Update `GET /log/viewer` in `backend/log_routes.py` to redirect to the new static dashboard page instead of returning inline HTML, preserving the existing URL as an entry point.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | In `backend/log_routes.py`, add `from fastapi.responses import RedirectResponse` to the existing `fastapi.responses` import line (already imports `HTMLResponse`, `PlainTextResponse`). | | |
| TASK-005 | Replace the `log_viewer()` function body in its entirety with: `return RedirectResponse(url="/log-dashboard.html", status_code=302)`. Remove the large `html = """..."""` string literal and the `return HTMLResponse(content=html)` line. The function signature and route decorator remain unchanged. | | |

### Implementation Phase 3 — Dashboard HTML Structure

- GOAL-003: Create `frontend/log-dashboard.html` with the full two-panel layout: left sidebar (session list + legend) and right main panel (filter bar, event table, stats strip).

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | Create `frontend/log-dashboard.html`. Add `<!DOCTYPE html>` declaration, `<html lang="en">`, `<head>` with `<meta charset="UTF-8">`, `<meta name="viewport">`, `<title>S.T.A.R.L.I.N.G. — Log Dashboard</title>`, and Google Fonts CDN link for `Exo 2` (weights 300;400;600) and `Share Tech Mono` (matching `frontend/index.html`'s font import). | | |
| TASK-007 | In the `<body>`, define the top-level layout structure: `<div class="dashboard">` containing: `<aside class="sidebar" id="sidebar">` (session list + event legend) and `<main class="main-panel" id="main-panel">` (filter bar + table + stats strip). | | |
| TASK-008 | Inside `<aside class="sidebar">`, add: a `<div class="sidebar-title">SESSIONS</div>` header, a `<div class="session-list" id="session-list">` container where session entries are rendered by JS, and below that a `<div class="legend">` containing one `<div class="legend-item">` per event type (coloured dot + label), covering all 9 event types defined in PAT-001. | | |
| TASK-009 | Inside `<main class="main-panel">`, add: (1) `<div class="top-bar">` containing a `<div class="dash-title">` with the text "LOG DASHBOARD", a filter row `<div class="filter-row">` with a `<div class="type-filters" id="type-filters">` (event-type toggle buttons, rendered by JS), a `<input type="search" id="search-box" placeholder="search events…">`, an `<button id="export-btn">EXPORT JSONL</button>`, an `<button id="refresh-toggle">AUTO-REFRESH: OFF</button>`, and a `<span class="event-count" id="event-count"></span>`; (2) `<div class="table-wrap" id="table-wrap">` containing `<table id="log-table">` with `<thead>` and `<tbody id="log-body">`; (3) `<div class="stats-strip" id="stats-strip">` for session stats. | | |
| TASK-010 | Define the `<thead>` of `#log-table` with columns: `#`, `Time`, `+ms`, `Src`, `Event`, `Summary`. | | |

### Implementation Phase 4 — Dashboard CSS

- GOAL-004: Write all CSS for the dashboard inside a `<style>` tag in `log-dashboard.html`, following the S.T.A.R.L.I.N.G. colour palette and typography.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-011 | Add CSS reset and base: `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }`. Set `html, body { height: 100%; background: #060606; color: #c8c8c8; font-family: 'Exo 2', sans-serif; font-size: 13px; overflow: hidden; }`. | | |
| TASK-012 | Add `.dashboard` layout: `display: flex; height: 100vh; gap: 0`. Add `.sidebar`: `width: 240px; flex-shrink: 0; background: #0a0a0a; border-right: 1px solid rgba(200,200,200,0.06); display: flex; flex-direction: column; overflow: hidden`. Add `.main-panel`: `flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden`. | | |
| TASK-013 | Add sidebar styles: `.sidebar-title { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: 4px; color: rgba(200,200,200,0.3); text-transform: uppercase; padding: 16px 14px 8px; flex-shrink: 0 }`. Add `.session-list { flex: 1; overflow-y: auto; padding-bottom: 8px }`. Add `.session-item { padding: 8px 14px; cursor: pointer; border-left: 2px solid transparent; font-family: 'Share Tech Mono', monospace; font-size: 10px; color: rgba(200,200,200,0.45); line-height: 1.5; transition: background 0.15s, color 0.15s, border-color 0.15s }`. Add `.session-item:hover { background: rgba(255,255,255,0.03); color: rgba(200,200,200,0.7) }`. Add `.session-item.active { border-left-color: #5599ff; color: #88aaff; background: rgba(85,153,255,0.05) }`. Add `.session-item .sess-id { display: block }`. Add `.session-item .sess-meta { color: rgba(200,200,200,0.28); font-size: 9px }`. | | |
| TASK-014 | Add legend styles: `.legend { padding: 12px 14px; border-top: 1px solid rgba(200,200,200,0.06); flex-shrink: 0 }`. Add `.legend-title { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: 3px; color: rgba(200,200,200,0.2); text-transform: uppercase; margin-bottom: 8px }`. Add `.legend-item { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; font-family: 'Share Tech Mono', monospace; font-size: 9px; color: rgba(200,200,200,0.35) }`. Add `.legend-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0 }`. | | |
| TASK-015 | Add top-bar and filter styles: `.top-bar { flex-shrink: 0; padding: 12px 16px 0; background: #080808; border-bottom: 1px solid rgba(200,200,200,0.06) }`. Add `.dash-title { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: 4px; color: rgba(85,153,255,0.5); text-transform: uppercase; margin-bottom: 10px }`. Add `.filter-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-bottom: 10px }`. Add `.type-filters { display: flex; gap: 5px; flex-wrap: wrap }`. Add `.type-btn { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: 1px; padding: 3px 8px; border-radius: 3px; border: 1px solid; cursor: pointer; background: transparent; opacity: 0.4; transition: opacity 0.15s }`. Add `.type-btn.active { opacity: 1 }`. Add `#search-box { background: #111; border: 1px solid rgba(200,200,200,0.1); color: #c8c8c8; font-family: 'Share Tech Mono', monospace; font-size: 11px; padding: 4px 10px; border-radius: 3px; width: 200px; outline: none }`. Add `#search-box:focus { border-color: rgba(85,153,255,0.4) }`. Add `.filter-row button { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: 1px; padding: 4px 12px; background: #111; border: 1px solid rgba(200,200,200,0.1); color: rgba(200,200,200,0.5); border-radius: 3px; cursor: pointer; text-transform: uppercase; transition: color 0.15s, border-color 0.15s }`. Add `.filter-row button:hover { color: #88aaff; border-color: rgba(85,153,255,0.3) }`. Add `#refresh-toggle.live { color: #66ffaa; border-color: rgba(102,255,170,0.3) }`. Add `.event-count { font-family: 'Share Tech Mono', monospace; font-size: 10px; color: rgba(200,200,200,0.25); margin-left: auto }`. | | |
| TASK-016 | Add table styles: `.table-wrap { flex: 1; overflow-y: auto; min-height: 0 }`. Add `table { width: 100%; border-collapse: collapse; font-size: 12px }`. Add `thead th { background: #0c0c0c; font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: 2px; color: rgba(85,153,255,0.6); text-transform: uppercase; text-align: left; padding: 7px 10px; border-bottom: 1px solid rgba(200,200,200,0.06); position: sticky; top: 0; z-index: 1 }`. Add `tbody tr { cursor: pointer; transition: background 0.1s }`. Add `tbody tr:hover td { background: rgba(255,255,255,0.02) }`. Add `tbody tr.expanded td { background: rgba(85,153,255,0.04) }`. Add `td { padding: 5px 10px; border-bottom: 1px solid rgba(255,255,255,0.025); vertical-align: top }`. Add `td.col-num { color: rgba(200,200,200,0.2); font-family: 'Share Tech Mono', monospace; font-size: 10px; width: 36px }`. Add `td.col-ts { font-family: 'Share Tech Mono', monospace; font-size: 10px; color: rgba(200,200,200,0.35); white-space: nowrap; width: 90px }`. Add `td.col-ms { font-family: 'Share Tech Mono', monospace; font-size: 10px; color: rgba(200,200,200,0.25); white-space: nowrap; width: 70px }`. Add `td.col-src { font-family: 'Share Tech Mono', monospace; font-size: 10px; color: rgba(200,200,200,0.3); width: 50px }`. Add `td.col-event { font-family: 'Share Tech Mono', monospace; font-size: 10px; white-space: nowrap; width: 160px }`. Add `td.col-summary { font-size: 11px; color: rgba(200,200,200,0.6); max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }`. Add `tr.detail-row td { padding: 0; background: #0c0c10 }`. Add `.detail-inner { padding: 10px 16px 10px 46px; font-family: 'Share Tech Mono', monospace; font-size: 11px; color: #aabbcc; white-space: pre-wrap; word-break: break-all; border-bottom: 1px solid rgba(85,153,255,0.1); max-height: 260px; overflow-y: auto }`. Add `.hidden { display: none }`. Add `.empty-msg { padding: 40px; text-align: center; font-family: "Share Tech Mono", monospace; font-size: 10px; letter-spacing: 2px; color: rgba(200,200,200,0.15); text-transform: uppercase }`. Add event-type colour classes matching PAT-001 (one per event type): `.ev-session_start, .ev-session_end { color: #66ffaa }`, `.ev-user_speech { color: #88ccff }`, `.ev-user_speech_frontend { color: #66aaee }`, `.ev-user_text { color: #aaddff }`, `.ev-tool_dispatch { color: #ffdd88 }`, `.ev-tool_call { color: #ffaa44 }`, `.ev-tool_result { color: #44cc88 }`, `.ev-llm_request { color: #cc88ff }`, `.ev-llm_response { color: #aa66ee }`, `.ev-error { color: #ff6677 }`. | | |
| TASK-017 | Add stats strip styles: `.stats-strip { flex-shrink: 0; padding: 8px 16px; background: #080808; border-top: 1px solid rgba(200,200,200,0.06); display: flex; gap: 24px; align-items: center; flex-wrap: wrap; min-height: 34px }`. Add `.stat-chip { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: 1px; color: rgba(200,200,200,0.35) }`. Add `.stat-chip span { color: rgba(200,200,200,0.7); margin-left: 4px }`. Add `.stat-chip.tools-list span { color: #ffdd88 }`. | | |

### Implementation Phase 5 — Dashboard JavaScript: Session List

- GOAL-005: Implement JavaScript for loading and displaying the session list in the sidebar, with auto-selection of the most recent session on page load.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-018 | At the bottom of `log-dashboard.html` in a `<script>` tag, declare module-level state variables: `let _sessions = []`, `let _activeSessionId = null`, `let _allEvents = []`, `let _liveSessionId = null`, `let _refreshInterval = null`, `let _activeTypes = new Set()`. | | |
| TASK-019 | Define `async function loadSessionList()`. Fetch `GET /log/sessions`. On success, set `_sessions = data` (sorted newest-first by the backend). Call `renderSessionList()`. If `_sessions.length > 0`, call `selectSession(_sessions[0].session_id)` to auto-load the newest session. On error, show an error message inside `#session-list`. | | |
| TASK-020 | Define `function renderSessionList()`. Clear `#session-list`. For each session in `_sessions`, create a `<div class="session-item">` with `data-id` attribute, two child spans: `.sess-id` (showing the date/time portion of the ID, e.g., `2026-05-20 14:30:00`) and `.sess-meta` (showing `event_count + " events  " + formatBytes(size_bytes)`). Attach a `click` listener: `selectSession(s.session_id)`. Mark the active item with class `active`. | | |
| TASK-021 | Define `function formatBytes(bytes)` — returns `"${(bytes/1024).toFixed(1)} KB"` if < 1 MB, else `"${(bytes/(1024*1024)).toFixed(2)} MB"`. | | |

### Implementation Phase 6 — Dashboard JavaScript: Event Table

- GOAL-006: Implement JavaScript for loading a session's JSONL, parsing it into the event table, building the event-type toggle buttons, and rendering the event-type summary column.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-022 | Define `async function selectSession(sessionId)`. Set `_activeSessionId = sessionId`. Update sidebar `active` class. Disable auto-refresh if switching sessions. Fetch `GET /log/sessions/{sessionId}`, parse JSONL lines into `_allEvents` array of objects. Determine all unique event types present and build `_activeTypes` (initialised to all types). Call `renderTypeFilters()`, `renderTable()`, `loadStats(sessionId)`. Fetch `GET /health` and set `_liveSessionId = data.current_session`. Update the auto-refresh button label and visibility. | | |
| TASK-023 | Define `function renderTypeFilters()`. Clear `#type-filters`. For each unique event type in `_allEvents` (in order of first occurrence), create a `<button class="type-btn active ev-{type}">` with `border-color` matching the event type colour and `textContent` equal to the type name. Set `border-color` and `color` inline from the PAT-001 colour map (a JS `const EVENT_COLORS = { session_start: '#66ffaa', session_end: '#66ffaa', user_speech: '#88ccff', ... }` constant declared at the top of the script). On click: toggle the type in `_activeTypes`, toggle `active` class on the button, call `renderTable()`. | | |
| TASK-024 | Define the summary extractor as `const EVENT_SUMMARY = { user_speech: d => d.transcript ? \`"\${d.transcript.slice(0,80)}"\` : '', user_speech_frontend: d => d.transcript ? \`"\${d.transcript.slice(0,80)}"\` : '', user_text: d => d.text ? \`"\${d.text.slice(0,80)}"\` : '', tool_dispatch: d => \`tool: \${d.tool || '?'}\${d.trigger_phrase ? ' — "' + d.trigger_phrase.slice(0,50) + '"' : ''}\`, tool_call: d => \`\${d.endpoint || ''} \${d.method || ''} — \${d.params_summary || ''}\`, tool_result: d => \`\${d.endpoint || ''} \${d.status_code || ''} \${d.duration_ms != null ? d.duration_ms + 'ms' : ''} — \${(d.result_summary || '').slice(0, 60)}\`, llm_request: d => \`model: \${d.model || '?'}, msgs: \${d.message_count || 0}, hash: \${d.system_prompt_hash || ''}\`, llm_response: d => \`\${d.token_count_estimate || 0} tokens, \${d.duration_ms || 0}ms — "\${(d.full_text || '').slice(0,60)}"\`, session_start: d => \`llm: \${d.llm_backend || ''}, pid: \${d.pid || ''}\`, session_end: d => \`duration: \${d.duration_s != null ? d.duration_s + 's' : '?'}, events: \${d.event_count || ''}\`, error: d => \`\${d.source || ''}: \${(d.message || d.error || '').slice(0, 80)}\` }` at the top of the script. For unknown types, fall back to `JSON.stringify(d).slice(0, 120)`. | | |
| TASK-025 | Define `function renderTable()`. Compute `const search = document.getElementById('search-box').value.toLowerCase()`. Filter `_allEvents` to only those where `_activeTypes.has(ev.event)` AND (search is empty OR `(ev.event + ev.source + JSON.stringify(ev.data)).toLowerCase().includes(search)`). Store filtered set as `_visible`. Update `#event-count` with `"${_visible.length} / ${_allEvents.length} events"`. If `_visible.length === 0`, show `#log-table` hidden and show `.empty-msg`. Otherwise clear `#log-body` and append one `<tr>` per event. | | |
| TASK-026 | In `renderTable()`, compute `_sessionStartTs` from the first `session_start` event's `ts` field (parse as `new Date()`). For each event in `_visible`, compute `const elapsedMs = _sessionStartTs ? Math.round(new Date(ev.ts) - _sessionStartTs) : null`. Render the row with cells: `col-num` (1-based index in `_visible`), `col-ts` (time portion of `ev.ts`, `HH:MM:SS.sss`), `col-ms` (`elapsedMs != null ? '+' + elapsedMs : ''`), `col-src` (`ev.source || ''`), `col-event` (`<span class="ev-{ev.event}">{ev.event}</span>`), `col-summary` (result of `EVENT_SUMMARY[ev.event]?.(ev.data) ?? JSON.stringify(ev.data).slice(0,120)`). Attach `click` listener to the row: calls `toggleDetail(rowIndex, ev)`. | | |

### Implementation Phase 7 — Dashboard JavaScript: Row Detail, Stats, Export, Auto-Refresh

- GOAL-007: Implement expandable row detail, session stats strip, export button, and auto-refresh toggle.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-027 | Define `function toggleDetail(rowEl, ev)`. If the next sibling of `rowEl` is a `.detail-row`, remove it and remove class `expanded` from `rowEl` (collapse). Otherwise, create a new `<tr class="detail-row">` with a single `<td colspan="6">`, containing a `<div class="detail-inner">` with `JSON.stringify(ev.data, null, 2)` as `textContent`. Insert it after `rowEl`. Add class `expanded` to `rowEl`. | | |
| TASK-028 | Define `async function loadStats(sessionId)`. Fetch `GET /log/stats/{sessionId}`. On success, render `#stats-strip` with `.stat-chip` elements: `EVENTS <span>{total_events}</span>`, `DURATION <span>{duration_s != null ? duration_s + 's' : 'live'}</span>`, `LLM CALLS <span>{llm_calls}</span>`, `TOOL DISPATCHES <span>{tool_dispatches}</span>`, `ERRORS <span style="color:${error_count>0?'#ff6677':'inherit'}">{error_count}</span>`, `TOOLS <span>{tools_used.join(', ') || 'none'}</span>`. On fetch error, show `#stats-strip` with text "Stats unavailable". | | |
| TASK-029 | Wire the export button: `document.getElementById('export-btn').addEventListener('click', () => { if (!_activeSessionId) return; const a = document.createElement('a'); a.href = '/log/sessions/' + _activeSessionId; a.download = _activeSessionId + '.jsonl'; a.click(); })`. | | |
| TASK-030 | Wire the auto-refresh toggle: `document.getElementById('refresh-toggle').addEventListener('click', () => { if (_refreshInterval) { clearInterval(_refreshInterval); _refreshInterval = null; document.getElementById('refresh-toggle').textContent = 'AUTO-REFRESH: OFF'; document.getElementById('refresh-toggle').classList.remove('live'); } else { if (_activeSessionId !== _liveSessionId) return; _refreshInterval = setInterval(async () => { await selectSession(_activeSessionId); document.getElementById('table-wrap').scrollTop = document.getElementById('table-wrap').scrollHeight; }, 5000); document.getElementById('refresh-toggle').textContent = 'AUTO-REFRESH: ON'; document.getElementById('refresh-toggle').classList.add('live'); } })`. | | |
| TASK-031 | Wire the search box: `document.getElementById('search-box').addEventListener('input', renderTable)`. | | |

### Implementation Phase 8 — Initialisation and Entry Point

- GOAL-008: Wire all initialisation calls so the dashboard is fully functional on page load.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-032 | At the bottom of the `<script>` block (after all function definitions), call `loadSessionList()` to bootstrap the dashboard on page load. | | |
| TASK-033 | Add a `<noscript>` fallback in the HTML body: `<noscript><p style="padding:20px;font-family:monospace;color:#c8c8c8">JavaScript is required to view the log dashboard.</p></noscript>`. | | |

## 3. Alternatives

- **ALT-001**: **Keep the existing inline HTML in `log_routes.py` and extend it** — add filter controls and expanded detail to the string literal in `log_viewer()`. Rejected because embedding a full dashboard (hundreds of lines of HTML/CSS/JS) inside a Python string is unmaintainable and breaks editor syntax highlighting and linting.
- **ALT-002**: **Use a JavaScript framework (Vue, React, Svelte)** — provides reactive state and a component model, reducing boilerplate. Rejected because it introduces a build step and npm dependency, inconsistent with the zero-dependency frontend approach used in the rest of the project.
- **ALT-003**: **Use Chart.js for an event-timeline visualisation** — a timeline bar showing event density over session duration. Rejected as premature for a first-pass dashboard; a well-structured sortable/filterable table is more useful for debugging than a chart.
- **ALT-004**: **Serve the dashboard from a separate port (e.g., port 8001)** — isolates the log viewer from the main API. Rejected because the main FastAPI app already serves static files and the localhost guard on the API endpoints provides sufficient access control without an additional server.
- **ALT-005**: **Paginate the event table** — load 50 events at a time with next/previous controls. Rejected because session logs are not expected to exceed a few thousand events. Full in-memory filtering is fast enough; pagination adds complexity with no practical benefit at current log volumes.
- **ALT-006**: **Server-side filtering via query parameters** — add `?event_type=user_speech&search=weather` to `GET /log/sessions/{id}` and filter on the backend. Rejected because the frontend already holds the full parsed event array in memory after the initial load; client-side filtering is instant and requires no additional round trips.

## 4. Dependencies

- **DEP-001**: `feature-session-activity-logging-1.md` — **hard dependency**. The dashboard reads data produced by this plan: `GET /log/sessions`, `GET /log/sessions/{session_id}`, and the JSONL format with fields `event`, `ts`, `source`, `data`. This plan cannot function without it.
- **DEP-002**: `backend/session_log.py` — provides `LOG_DIR` used by the new `GET /log/stats/{session_id}` handler to resolve log file paths.
- **DEP-003**: FastAPI `StaticFiles` mount in `backend/main.py` — already mounts `frontend/` at `/`, so `frontend/log-dashboard.html` is automatically served at `http://localhost:8000/log-dashboard.html` with no `main.py` changes needed.
- **DEP-004**: Google Fonts CDN — `Exo 2` and `Share Tech Mono` are loaded from `fonts.googleapis.com`, consistent with `frontend/index.html`. Requires internet access to render correctly; falls back to system monospace if offline.

## 5. Files

- **FILE-001**: `frontend/log-dashboard.html` — **new file**. The complete dashboard: HTML structure, all CSS, all JavaScript in a single self-contained file.
- **FILE-002**: `backend/log_routes.py` — **modified**. Add `GET /log/stats/{session_id}` endpoint (TASK-001 to TASK-003). Replace `GET /log/viewer` inline HTML with a redirect to `/log-dashboard.html` (TASK-004 to TASK-005).

## 6. Testing

- **TEST-001**: Navigate to `http://localhost:8000/log/viewer`. Verify it redirects (HTTP 302) to `http://localhost:8000/log-dashboard.html` and the dashboard loads correctly.
- **TEST-002**: Load the dashboard with at least two session files present. Verify the sidebar lists all sessions, newest first, each showing date/time and event count. Verify clicking a session loads its events into the table.
- **TEST-003**: Load a session with known event types. Verify each event type renders in its correct colour (cross-reference against the PAT-001 colour map). Verify the legend in the sidebar matches the colours.
- **TEST-004**: Click each event-type toggle button one at a time. Verify rows of that type are hidden when the button is inactive and shown when active. Verify `#event-count` updates to reflect the current visible row count.
- **TEST-005**: Type a search term into the search box that matches a known `tool` name (e.g., `weather`). Verify only rows where the event, source, or data JSON contains that term are shown. Clear the search and verify all rows (respecting type filters) reappear.
- **TEST-006**: Click any event row. Verify a detail section appears immediately below it showing prettified JSON of the event's `data` field. Click the same row again and verify the detail section collapses.
- **TEST-007**: Call `GET /log/stats/{session_id}` directly via `curl`. Verify the JSON response contains `event_counts`, `llm_calls`, `tool_dispatches`, `error_count`, `tools_used`, `total_events`, `duration_s`. Verify `duration_s` is `null` for a live (no `session_end` event) session.
- **TEST-008**: Verify the stats strip at the bottom of the dashboard displays values matching the response from `GET /log/stats/{session_id}`. Verify `error_count` renders in red (`#ff6677`) when > 0.
- **TEST-009**: Click the "EXPORT JSONL" button. Verify the browser downloads a file named `<session_id>.jsonl` whose contents match the raw JSONL from `GET /log/sessions/{session_id}`.
- **TEST-010**: Load the dashboard with the live session selected. Enable auto-refresh. Trigger a new system event (e.g., send a message in the main UI). Within 5 seconds, verify the new event appears at the bottom of the table and the table scrolls to it.
- **TEST-011**: Call `GET /log/stats/{session_id}` from a non-localhost address. Verify HTTP 403 is returned.
- **TEST-012**: Call `GET /log/stats/invalid-id` (malformed session ID). Verify HTTP 400 is returned. Call `GET /log/stats/session_9999-01-01_00-00-00` (valid format but non-existent). Verify HTTP 404 is returned.

## 7. Risks & Assumptions

- **RISK-001**: **Large session files causing slow table render** — a session with thousands of events will create thousands of DOM nodes synchronously. For the expected session scale (hundreds of events), this is fine. If performance becomes an issue, virtual scrolling (rendering only visible rows) can be added as a future enhancement without breaking any part of this plan.
- **RISK-002**: **JSONL lines with malformed JSON** — a crash in the backend or truncated write could leave a partial line in the JSONL file. The JS parser must wrap `JSON.parse(line)` in a try-catch and skip malformed lines, displaying a `"[malformed line]"` placeholder row to flag the issue without breaking the rest of the table.
- **RISK-003**: **`GET /log/stats` performance on large files** — the stats endpoint scans the full JSONL on every request. For files up to a few MB this is negligible. For very long sessions, the response may take 50–200 ms. No caching is needed at current scale.
- **RISK-004**: **Auto-refresh fires while the user is reading an expanded detail row** — the refresh re-renders the entire table, collapsing all expanded rows. Mitigation: before re-rendering, store the indices of currently expanded rows and re-expand them after render. This is a quality-of-life improvement that can be implemented within `selectSession()`.
- **RISK-005**: **`GET /health` unreachable causes live-session detection to fail** — the auto-refresh button would remain disabled. Wrap the health fetch in a try-catch and default `_liveSessionId` to `null` on failure. The rest of the dashboard remains functional.
- **ASSUMPTION-001**: `feature-session-activity-logging-1.md` is fully implemented and the JSONL records follow the documented format with fields `event`, `ts`, `source`, `data`.
- **ASSUMPTION-002**: The FastAPI `StaticFiles` mount in `main.py` serves the entire `frontend/` directory at `/`, making `frontend/log-dashboard.html` accessible at `/log-dashboard.html` without any changes to `main.py`.
- **ASSUMPTION-003**: Session log files are not expected to exceed ~10,000 events in normal use. No pagination or virtual scrolling is required for the initial implementation.

## 8. Related Specifications / Further Reading

- [feature-session-activity-logging-1.md](feature-session-activity-logging-1.md) — Hard dependency. Defines the session log file format, `GET /log/sessions`, `GET /log/sessions/{session_id}`, and `POST /log/event` endpoints that the dashboard consumes.
- [feature-dream-state-shutdown-pipeline-1.md](feature-dream-state-shutdown-pipeline-1.md) — Dream state output files (`thoughts.md`, `summary.md`, `facts.md`) could be linked from the dashboard in a future enhancement.
- [FastAPI StaticFiles documentation](https://fastapi.tiangolo.com/tutorial/static-files/)
- [MDN: Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
