---
goal: Reddit Subreddit Settings — Persistent In-Panel Subreddit Management (Add / Remove)
version: 1.0
date_created: 2026-05-23
last_updated: 2026-05-23
owner: Daniel Simpson
status: 'Planned'
tags: [feature, frontend, backend, reddit, settings, persistence]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Adds a SETTINGS view inside the Reddit panel that lets the user manage the list of
subreddits pulled into the feed — without editing `.env` or restarting the server.
A gear button in the panel header toggles the settings view, which displays each
currently followed subreddit with a remove button. A text input and ADD button let
the user append new subreddits by name (with or without the `r/` prefix — the prefix
is stripped automatically). All changes are persisted to
`backend/memory/reddit_subreddits.json`, take precedence over the `.env` fallback,
immediately invalidate the feed cache, and trigger a background re-fetch so the panel
reflects the new subscription list.

---

## 1. Requirements & Constraints

- **REQ-001**: The settings view must be accessible from within the existing `#reddit-panel` via a SETTINGS button added to the `<div class="reddit-header">` row. It must not require a separate page, route, or overlay outside the panel.
- **REQ-002**: The settings view must list every currently active subreddit name as a row, each with a ✕ remove button. No additional metadata is required — the subreddit name is the display name.
- **REQ-003**: Each remove button must call `DELETE /reddit/subreddits/{name}`, then invalidate the feed cache (`DELETE /reddit/cache`) and re-fetch the feed in the background.
- **REQ-004**: The settings view must include a single-line text input and an ADD button. The input accepts subreddit names with or without a leading `r/` prefix — the prefix must be stripped before validation and sending. Client-side validation must enforce `/^[A-Za-z0-9_]{1,50}$/` on the stripped name. Invalid input must display an inline error without making a network call.
- **REQ-005**: Channel additions must call `POST /reddit/subreddits` with body `{ "subreddit": "name" }`. On a 400 response the backend error detail must be surfaced inline in the settings view.
- **REQ-006**: After any add or remove, the subreddit list must be re-fetched from `GET /reddit/subreddits` and re-rendered in place, with no full page reload.
- **REQ-007**: Subreddit data must be persisted to `backend/memory/reddit_subreddits.json` as a JSON array of plain name strings (no `r/` prefix). This file takes priority over the `REDDIT_SUBREDDITS` env var. The env var remains the bootstrap seed if the file does not exist.
- **REQ-008**: Minimum subreddit count must be enforced at 1: the backend must reject a `DELETE` that would result in zero subreddits, returning HTTP 400 with detail `"Cannot remove the last subreddit."`. The frontend must surface this inline.
- **REQ-009**: Maximum subreddit count must be capped at 20. The backend must reject a `POST` when the current list already contains 20 entries, returning HTTP 400 with detail `"Maximum of 20 subreddits allowed."`. The frontend must surface this inline.
- **REQ-010**: `GET /reddit/subreddits` must return a JSON array of objects `{ name: string }`, one per active subreddit, in the order stored in the JSON file.
- **SEC-001**: The `POST /reddit/subreddits` endpoint must re-validate the subreddit name server-side against `_SUB_NAME_RE` (already defined: `/^[A-Za-z0-9_]{1,50}$/`). Client-side validation is UX-only; the backend must never trust it alone.
- **SEC-002**: The `backend/memory/reddit_subreddits.json` path must be resolved relative to `__file__` — never constructed from user input — to prevent path traversal.
- **CON-001**: The settings view must live inside the existing `#reddit-panel` div as a sibling to the feed elements, toggled with the `hidden` class. No new top-level panel or overlay is permitted.
- **CON-002**: No new Python package dependencies. File I/O uses stdlib `pathlib` and `json`, which are already imported in `reddit.py`.
- **CON-003**: The `_DEFAULT_SUBS` list and the `REDDIT_SUBREDDITS` env var must remain unchanged as bootstrap seeds. They are only used when `reddit_subreddits.json` does not exist.
- **GUD-001**: Follow the existing pattern in `reddit-panel.js`: DOM refs declared at module top-level, service injection via `initRedditPanel`, internal `_render*` functions for view updates, `textContent` (never `innerHTML`) for user-derived strings.
- **GUD-002**: The settings view's visual style must use `reddit-` prefixed CSS classes consistent with the existing panel styles: `Share Tech Mono` for labels, `var(--c)` accents, `var(--bg)` background.
- **PAT-001**: The existing inline refresh logic inside the `redditRefreshBtn` click handler must be extracted into a named `_hardRefresh()` helper in `reddit-panel.js` and reused by both the refresh button and all settings change actions.

---

## 2. Implementation Steps

### Implementation Phase 1 — Backend: Persistence File & Subreddit Management Endpoints

- GOAL-001: Add JSON-backed subreddit list persistence to `backend/reddit.py` and expose three new REST endpoints for reading, adding, and removing subreddits at runtime.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In `backend/reddit.py`, immediately after the `_SUB_NAME_RE` definition (around line 32), declare the storage path constant: `_SUBREDDITS_FILE = Path(__file__).parent / "memory" / "reddit_subreddits.json"`. Add `from pathlib import Path` to the imports if not already present — confirm by checking the existing import block at the top of the file. | | |
| TASK-002 | Write `_load_subreddits() -> list[str]` in `reddit.py`. Logic: (1) if `_SUBREDDITS_FILE` exists, `json.load` it, filter each entry through `_SUB_NAME_RE.match`, return the valid list; (2) if the file does not exist or is malformed, return `_DEFAULT_SUBS`; (3) wrap the entire function body in `try/except Exception` that logs a warning at `logger.warning` and falls back to `_DEFAULT_SUBS`. | | |
| TASK-003 | Write `_save_subreddits(subreddits: list[str]) -> None` in `reddit.py`. Logic: (1) `_SUBREDDITS_FILE.parent.mkdir(parents=True, exist_ok=True)`; (2) `_SUBREDDITS_FILE.write_text(json.dumps(subreddits, indent=2), encoding="utf-8")`; (3) wrap in `try/except Exception` that logs an error at `logger.error`. The function must never raise — a failed save must not break the request that called it. | | |
| TASK-004 | Modify `_fetch_user_subscriptions()` in `reddit.py`. In the non-PRAW branch (currently `return _DEFAULT_SUBS`), replace the return with `return _load_subreddits()`. The PRAW branch (Phase 2) is unchanged. This ensures all `GET /reddit` requests draw from the JSON file when PRAW is not configured. | | |
| TASK-005 | Add a Pydantic request body model immediately before the endpoints section of `reddit.py`: `class SubredditAddRequest(BaseModel): subreddit: str`. Add `from pydantic import BaseModel` to the imports if not already present — verify by checking the existing import block. | | |
| TASK-006 | Add `GET /reddit/subreddits` endpoint in `reddit.py`. Handler: (1) `subs = _load_subreddits()`; (2) return `[{"name": s} for s in subs]`. No authentication required — local-only server. | | |
| TASK-007 | Add `POST /reddit/subreddits` endpoint in `reddit.py`. Accept `SubredditAddRequest` as the request body. Handler: (1) `name = request.subreddit.strip().lstrip("/")` to normalise any stray leading slash; (2) validate `name` against `_SUB_NAME_RE` — return `HTTPException(400, "Invalid subreddit name. Only alphanumeric and underscore allowed (max 50 chars).")` if invalid; (3) `subs = _load_subreddits()`; (4) if `name` in `subs` (case-insensitive: compare `name.lower()` to `[s.lower() for s in subs]`), return `HTTPException(400, "Subreddit already in list.")`; (5) if `len(subs) >= 20`, return `HTTPException(400, "Maximum of 20 subreddits allowed.")`; (6) `subs.append(name)`; (7) `_save_subreddits(subs)`; (8) `_raw_cache.clear()` and `_synth_cache.clear()`; (9) return `{"status": "added", "subreddit": name}`. | | |
| TASK-008 | Add `DELETE /reddit/subreddits/{subreddit}` endpoint in `reddit.py`. Path param: `subreddit: str`. Handler: (1) validate `subreddit` against `_SUB_NAME_RE` — return `HTTPException(400, "Invalid subreddit name.")` if invalid; (2) `subs = _load_subreddits()`; (3) find the matching entry case-insensitively: `match = next((s for s in subs if s.lower() == subreddit.lower()), None)` — if `match is None`, return `HTTPException(404, "Subreddit not in list.")`; (4) if `len(subs) <= 1`, return `HTTPException(400, "Cannot remove the last subreddit.")`; (5) `subs.remove(match)`; (6) `_save_subreddits(subs)`; (7) `_raw_cache.clear()` and `_synth_cache.clear()`; (8) return `{"status": "removed", "subreddit": match}`. | | |

---

### Implementation Phase 2 — Frontend HTML: Settings Sub-View in `#reddit-panel`

- GOAL-002: Add the settings sub-view markup inside the existing `#reddit-panel` div in `frontend/index.html`, and add the SETTINGS button to the panel header.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-009 | In `frontend/index.html`, locate the `<div class="reddit-header">` block (line 379). Add a SETTINGS button immediately before the existing `<button class="reddit-close-btn"`: `<button class="reddit-settings-btn" id="reddit-settings-btn" title="Manage subreddits">⚙ SUBREDDITS</button>` | | |
| TASK-010 | Immediately before the closing `</div><!-- /reddit-panel -->` tag (line 392), insert the settings sub-view div: `<div class="reddit-settings-view hidden" id="reddit-settings-view"><div class="reddit-settings-header"><div class="reddit-settings-title">MANAGE SUBREDDITS</div><button class="reddit-settings-back-btn" id="reddit-settings-back-btn">← BACK</button></div><div class="reddit-settings-sub-list" id="reddit-settings-sub-list"></div><div class="reddit-settings-add-row"><input class="reddit-settings-input" id="reddit-settings-input" type="text" placeholder="subreddit or r/subreddit" maxlength="53" spellcheck="false" autocomplete="off" /><button class="reddit-settings-add-btn" id="reddit-settings-add-btn">+ ADD</button></div><div class="reddit-settings-error hidden" id="reddit-settings-error"></div></div>` | | |

---

### Implementation Phase 3 — Frontend Styles: `frontend/style.css`

- GOAL-003: Add CSS rules for all new Reddit settings view elements, consistent with the existing panel design language.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-011 | Append a `/* ── Reddit Settings View ──────────────────────────────────────── */` section to `frontend/style.css`. Add `.reddit-settings-btn`: mirror the existing `.reddit-refresh-btn` rule exactly — same font family, font size, colour, border, letter-spacing, padding, and `:hover` state — so it sits natively in the header row without layout shift. | | |
| TASK-012 | Add `.reddit-settings-view`: `display: flex; flex-direction: column; gap: 14px; padding: 12px 0; height: 100%; overflow: hidden;`. Add `.reddit-settings-header`: `display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(200,200,200,0.12); padding-bottom: 10px;`. Add `.reddit-settings-title`: `font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: 3px; color: rgba(200,200,200,0.5); text-transform: uppercase;`. Add `.reddit-settings-back-btn`: no background, no border, `font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: 2px; color: rgba(200,200,200,0.45); cursor: pointer;`. `:hover { color: rgba(200,200,200,0.9); }`. | | |
| TASK-013 | Add `.reddit-settings-sub-list`: `flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;`. Add `.reddit-settings-sub-row`: `display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border: 1px solid rgba(200,200,200,0.1); border-radius: 2px;`. Add `.reddit-settings-sub-name`: `font-family: 'Share Tech Mono', monospace; font-size: 11px; color: var(--c); letter-spacing: 1px;` with `::before { content: "r/"; color: rgba(200,200,200,0.35); }`. Add `.reddit-settings-remove-btn`: `background: none; border: none; color: rgba(200,200,200,0.3); font-size: 14px; cursor: pointer; flex-shrink: 0;`. `:hover { color: rgba(200,200,200,0.9); }`. | | |
| TASK-014 | Add `.reddit-settings-add-row`: `display: flex; gap: 8px; align-items: center; flex-shrink: 0;`. Add `.reddit-settings-input`: `flex: 1; background: rgba(200,200,200,0.05); border: 1px solid rgba(200,200,200,0.18); color: var(--c); font-family: 'Share Tech Mono', monospace; font-size: 11px; padding: 6px 10px; border-radius: 2px; outline: none;`. `:focus { border-color: rgba(200,200,200,0.45); }`. `::placeholder { color: rgba(200,200,200,0.25); }`. Add `.reddit-settings-add-btn`: same base as `.reddit-refresh-btn`, `flex-shrink: 0`. Add `.reddit-settings-error`: `font-family: 'Share Tech Mono', monospace; font-size: 10px; color: rgba(255,120,80,0.8); letter-spacing: 1px; min-height: 16px;`. | | |

---

### Implementation Phase 4 — Frontend Logic: `frontend/reddit-panel.js`

- GOAL-004: Add settings DOM refs, the `_hardRefresh()` helper, and the full settings open/close/render/add/remove logic to `reddit-panel.js`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-015 | In `frontend/reddit-panel.js`, add the following DOM refs in the existing DOM refs block (after `redditRefreshBtn`): `const redditSettingsBtn = document.getElementById('reddit-settings-btn');`, `const redditSettingsView = document.getElementById('reddit-settings-view');`, `const redditSettingsBackBtn = document.getElementById('reddit-settings-back-btn');`, `const redditSettingsSubList = document.getElementById('reddit-settings-sub-list');`, `const redditSettingsInput = document.getElementById('reddit-settings-input');`, `const redditSettingsAddBtn = document.getElementById('reddit-settings-add-btn');`, `const redditSettingsError = document.getElementById('reddit-settings-error');`. | | |
| TASK-016 | Extract a named `_hardRefresh()` async function from the existing `redditRefreshBtn` click handler body in `initRedditPanel`. The function body: `try { await fetch(\`${BACKEND_BASE_REDDIT}/reddit/cache\`, { method: 'DELETE' }); } catch (_) {}` then `await openRedditPanel({ silent: true });`. Update the `redditRefreshBtn` click handler to call `_hardRefresh()` directly (keeping any loading-state UI management around the call). | | |
| TASK-017 | Write `_showRedditSettingsView()` in `reddit-panel.js`. It must: (1) hide the feed elements by adding `hidden` to `redditFilterBar`, `redditPostList`, `redditFetched`, `redditRefreshBtn`, `redditSettingsBtn`, and `redditSynthIndicator`; (2) remove `hidden` from `redditSettingsView`; (3) call `_fetchAndRenderSubList()`. | | |
| TASK-018 | Write `_hideRedditSettingsView()` in `reddit-panel.js`. It must: (1) add `hidden` to `redditSettingsView`; (2) remove `hidden` from `redditFilterBar`, `redditPostList`, `redditFetched`, `redditRefreshBtn`, `redditSettingsBtn`; (3) call `_hideRedditSettingsError()`; (4) set `redditSettingsInput.value = ''`. Note: `redditSynthIndicator` must NOT be unconditionally shown — it starts hidden and is managed solely by the synthesis polling lifecycle. | | |
| TASK-019 | Write `async _fetchAndRenderSubList()` in `reddit-panel.js`. Steps: (1) `redditSettingsSubList.innerHTML = ''`; set a loading placeholder `<div>` with `textContent = 'LOADING…'` and class `reddit-settings-loading`; (2) `const res = await fetch(\`${BACKEND_BASE_REDDIT}/reddit/subreddits\`)`; (3) if `!res.ok`, clear the list and set a single error row with `textContent = 'Failed to load subreddits.'`; return; (4) `const subs = await res.json()`; (5) `redditSettingsSubList.innerHTML = ''`; (6) for each `{ name }` in subs, call `_createSubRow(name)` and append to `redditSettingsSubList`. | | |
| TASK-020 | Write `_createSubRow(name)` in `reddit-panel.js`. Returns a `<div class="reddit-settings-sub-row">` containing: a `<div class="reddit-settings-sub-name">` with `textContent = name` (the `r/` prefix is added via CSS `::before`); a `<button class="reddit-settings-remove-btn" title="Remove subreddit">✕</button>`. The remove button click handler must: (1) disable itself; (2) call `await _removeSubreddit(name)`; (3) if it fails, re-enable itself. | | |
| TASK-021 | Write `async _removeSubreddit(name)` in `reddit-panel.js`. Steps: (1) `const res = await fetch(\`${BACKEND_BASE_REDDIT}/reddit/subreddits/${encodeURIComponent(name)}\`, { method: 'DELETE' })`; (2) if `!res.ok`, parse the JSON `detail` field and call `_showRedditSettingsError(detail)`, then return; (3) on success, call `await _fetchAndRenderSubList()` to re-render in place; (4) call `_hardRefresh()` without awaiting — let the feed refresh in the background while settings UI remains usable. | | |
| TASK-022 | Write `async _addSubreddit(rawInput)` in `reddit-panel.js`. Steps: (1) `const name = rawInput.trim().replace(/^r\//i, '')` — strip leading `r/` prefix; (2) client-side validate: if `!/^[A-Za-z0-9_]{1,50}$/.test(name)`, call `_showRedditSettingsError('Invalid name. Use letters, numbers, and underscores only (max 50 chars).')` and return; (3) `redditSettingsAddBtn.disabled = true`; (4) `const res = await fetch(\`${BACKEND_BASE_REDDIT}/reddit/subreddits\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subreddit: name }) })`; (5) if `!res.ok`, parse `detail` and call `_showRedditSettingsError(detail)`, re-enable button, return; (6) `redditSettingsInput.value = ''`; (7) `_hideRedditSettingsError()`; (8) `redditSettingsAddBtn.disabled = false`; (9) `await _fetchAndRenderSubList()`; (10) call `_hardRefresh()` without awaiting. | | |
| TASK-023 | Write `_showRedditSettingsError(msg)` and `_hideRedditSettingsError()` helpers. `_showRedditSettingsError`: `redditSettingsError.textContent = msg` (safe — `textContent`, not `innerHTML`), remove `hidden`. `_hideRedditSettingsError`: `redditSettingsError.textContent = ''`, add `hidden`. | | |
| TASK-024 | Wire all settings event listeners inside `initRedditPanel`. Add: (1) `redditSettingsBtn?.addEventListener('click', _showRedditSettingsView)`; (2) `redditSettingsBackBtn?.addEventListener('click', _hideRedditSettingsView)`; (3) `redditSettingsAddBtn?.addEventListener('click', () => _addSubreddit(redditSettingsInput.value))`; (4) `redditSettingsInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') _addSubreddit(redditSettingsInput.value); })`; (5) `redditSettingsInput?.addEventListener('input', _hideRedditSettingsError)`. | | |
| TASK-025 | Update `closeRedditPanel()` to call `_hideRedditSettingsView()` before `redditPanel.classList.add('hidden')` — ensures the panel always resets to feed view on next open, not settings view. | | |

---

## 3. Alternatives

- **ALT-001**: Store subreddits in `.env` and reload the server on each change. Rejected — requires file write access to `.env`, disrupts the running session, and is inconsistent with the established in-memory/JSON persistence pattern used by stocks (`watchlist.json`) and ideas (`ideas.json`).
- **ALT-002**: Use a single `PUT /reddit/subreddits` endpoint that accepts the full replacement list. Rejected — atomic add/delete endpoints are safer (no accidental bulk overwrite), more idiomatic REST, and easier to test individually.
- **ALT-003**: Place the settings view in a separate modal overlay above the panel. Rejected — all existing Starling tool panels use in-panel sub-views (journal review view, ideas list view). Consistency with the established UX pattern takes precedence.
- **ALT-004**: Validate subreddit existence against the Reddit API before adding. Rejected for this phase — it adds a synchronous external API call to the add flow, increasing latency. A non-existent subreddit will simply return zero posts when the feed refreshes, which is a sufficient user-facing signal.

---

## 4. Dependencies

- **DEP-001**: `backend/memory/` directory — must exist (confirmed by presence of `watchlist.json`, `ideas.json`, `weather_cache.json`).
- **DEP-002**: `pathlib.Path` — must be imported in `backend/reddit.py`. Verify the existing import block; add `from pathlib import Path` if absent.
- **DEP-003**: `pydantic.BaseModel` — must be available in `backend/reddit.py`. FastAPI projects include Pydantic as a dependency; verify it is importable. Add `from pydantic import BaseModel` if absent.
- **DEP-004**: `_hardRefresh()` in Phase 4 depends on the `_hardRefresh()` extraction in TASK-016 being completed first. All other Phase 4 tasks are independent of each other.

---

## 5. Files

- **FILE-001**: `backend/reddit.py` — add `_SUBREDDITS_FILE` constant, `_load_subreddits()`, `_save_subreddits()`, `SubredditAddRequest` model, modify `_fetch_user_subscriptions()`, add `GET /reddit/subreddits`, `POST /reddit/subreddits`, `DELETE /reddit/subreddits/{subreddit}` endpoints.
- **FILE-002**: `frontend/reddit-panel.js` — add settings DOM refs, `_hardRefresh()`, `_showRedditSettingsView()`, `_hideRedditSettingsView()`, `_fetchAndRenderSubList()`, `_createSubRow()`, `_removeSubreddit()`, `_addSubreddit()`, `_showRedditSettingsError()`, `_hideRedditSettingsError()`; wire listeners in `initRedditPanel`; update `closeRedditPanel`.
- **FILE-003**: `frontend/index.html` — add SETTINGS button to `#reddit-header`; add `#reddit-settings-view` sub-div inside `#reddit-panel`.
- **FILE-004**: `frontend/style.css` — add Reddit settings view styles under a new `/* ── Reddit Settings View */` section.
- **FILE-005**: `backend/memory/reddit_subreddits.json` — created at runtime on first save; not committed to version control (exclude under the `backend/memory/` gitignore pattern).

---

## 6. Testing

- **TEST-001**: Open Reddit feed, click ⚙ SUBREDDITS button — verify settings view appears and feed elements (filter bar, post list, fetched timestamp, refresh button, synth indicator) are hidden.
- **TEST-002**: Settings subreddit list — verify all currently active subreddit names are listed, each prefixed visually with `r/` (via CSS `::before`), each with a ✕ remove button.
- **TEST-003**: Add valid subreddit — type `"datascience"` and click ADD; verify it appears in the list and the feed refreshes in the background showing posts from `r/datascience`.
- **TEST-004**: Add with `r/` prefix — type `"r/python"` and click ADD; verify the `r/` is stripped to `"python"` before sending, and the subreddit is added without error.
- **TEST-005**: Add duplicate — type an already-present subreddit name and click ADD; verify the inline error `"Subreddit already in list."` appears without adding a duplicate row.
- **TEST-006**: Add invalid format — type `"bad name!"` and click ADD; verify client-side validation fires and the error `"Invalid name…"` appears without a network request.
- **TEST-007**: Remove subreddit — click ✕ on a row; verify the row disappears, `reddit_subreddits.json` no longer contains the name, and the feed refreshes.
- **TEST-008**: Remove last subreddit — with one subreddit remaining, click ✕; verify the backend returns HTTP 400 `"Cannot remove the last subreddit."` and the error is shown inline.
- **TEST-009**: Enforce max 20 — when 20 subreddits are listed, attempt to add a 21st; verify the backend returns `"Maximum of 20 subreddits allowed."` and the error is shown inline.
- **TEST-010**: Enter key — type a valid name in the input and press Enter; verify it behaves identically to clicking ADD.
- **TEST-011**: Error clears on input — after an error is shown, begin typing in the input field; verify the error message disappears immediately.
- **TEST-012**: BACK button — click ← BACK; verify feed elements are restored, settings view is hidden, input is cleared, and error is hidden.
- **TEST-013**: Close and reopen — open settings view, click the ✕ close button on the panel, then reopen the panel; verify it opens in feed view (not settings view).
- **TEST-014**: Persistence across restart — add `r/MachineLearning` via the UI, restart the FastAPI backend, open the Reddit feed; verify the subreddit is still present.
- **TEST-015**: Case-insensitive duplicate guard — type `"WorldNews"` when `"worldnews"` is already present; verify the backend returns `"Subreddit already in list."`.

---

## 7. Risks & Assumptions

- **RISK-001**: A valid-format subreddit name that does not correspond to a real subreddit (e.g., a typo) will produce zero posts silently. Mitigation: document this as expected — the feed simply shows no posts for that entry. Out-of-scope to verify existence without an external API call.
- **RISK-002**: `_raw_cache.clear()` on add/delete invalidates all cached data. If the user has multiple browser tabs open, the other tab's in-memory `_redditData` will be stale until it refreshes. Mitigation: accepted trade-off; single-user local application.
- **RISK-003**: The `r/` CSS `::before` pseudo-element approach (TASK-013) means the displayed prefix is not selectable/copyable as text, which is acceptable for a read-only display label. If the design is changed to show the prefix in the DOM (e.g., for accessibility), the `_createSubRow` function must be updated to prepend `"r/"` to `textContent` instead.
- **ASSUMPTION-001**: The `backend/memory/` directory is writable by the FastAPI process — confirmed by the existence of `watchlist.json`, `ideas.json`, and `weather_cache.json` in that directory.
- **ASSUMPTION-002**: Pydantic `BaseModel` is available in the Python environment — FastAPI mandates Pydantic as a direct dependency; it is already in use implicitly via FastAPI's request validation.
- **ASSUMPTION-003**: The `hidden` CSS class applies `display: none !important` — consistent with all other panel show/hide mechanisms in the codebase.
- **ASSUMPTION-004**: `pathlib` is available in the Python environment — it is part of the standard library (Python 3.4+) and already used elsewhere in the backend (`wikipedia_rag.py`, `rag.py`).

---

## 8. Related Specifications / Further Reading

- [assets/archived/feature-reddit-social-1.md](../assets/archived/feature-reddit-social-1.md) — Original Reddit social feed feature spec; provides full implementation context for `reddit.py` and `reddit-panel.js`.
- [backend/reddit.py](../backend/reddit.py) — Primary backend file; subreddit fetching, caching, synthesis, and all Reddit endpoints.
- [frontend/reddit-panel.js](../frontend/reddit-panel.js) — Primary frontend module; panel rendering, filter bar, post list, and synthesis polling.
- [frontend/index.html](../frontend/index.html) — `#reddit-panel` markup starting at line 378.
- [plan/feature-youtube-channel-settings-1.md](./feature-youtube-channel-settings-1.md) — Parallel feature for YouTube channel management; identical architecture used as the direct implementation reference.
- [backend/memory/watchlist.json](../backend/memory/watchlist.json) — Reference for the established JSON persistence pattern used throughout the backend memory layer.
