---
goal: Reddit Subreddit Discovery & Account Import — PRAW account sync, keyword search, and bulk paste import for the Starling Reddit Settings view
version: 1.0
date_created: 2026-05-24
last_updated: 2026-05-24
owner: Daniel Simpson
status: 'Planned'
tags: [feature, frontend, backend, reddit, discovery, praw, settings, persistence]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Extends the existing Reddit Settings view (add/remove subreddits one-at-a-time) with three
discovery methods that make it easy to populate a meaningful, personalised subreddit list
without manually typing names:

1. **PRAW Account Import** — a single-click import that reads all subreddits the user follows
   on Reddit (via PRAW + `.env` credentials) and merges them into `backend/memory/reddit_subreddits.json`.
2. **Subreddit Keyword Search** — a live search input that queries Reddit's public
   `/subreddits/search.json` API and returns matching communities with subscriber counts,
   so the user can browse and one-click subscribe to any result directly inside Starling.
3. **Bulk Paste Import** — a textarea that accepts a comma- or newline-delimited list of
   subreddit names (e.g. copied from `reddit.com/subreddits/mine`) and adds them all at once.

All methods write exclusively to `backend/memory/reddit_subreddits.json` (the persistence
file already in place), so every imported subreddit survives Starling shutdowns and reboots.
The subreddit cap is raised from 20 → 50 to accommodate real account subscription lists.

---

## 1. Requirements & Constraints

- **REQ-001**: A `POST /reddit/subscriptions/import` endpoint must fetch the full PRAW subscription list (via the existing `_fetch_user_subscriptions()` function), deduplicate against the current file, append only new entries (up to the cap), save to `reddit_subreddits.json`, clear caches, and return `{ "imported": int, "skipped": int, "total": int, "subreddits": list[str] }`.
- **REQ-002**: A `GET /reddit/search` endpoint must accept a `q: str` query parameter (1–50 chars), call `https://www.reddit.com/subreddits/search.json?q={q}&limit=20&include_over_18=0` via `httpx`, and return an array of `{ name, title, subscribers, description }` objects. Names must be validated through `_SUB_NAME_RE` before inclusion in the response.
- **REQ-003**: The subreddit cap must be raised from `20` to `50` in both `POST /reddit/subreddits` (manual add) and `POST /reddit/subscriptions/import`. The import endpoint must silently truncate imported subs if the cap would be exceeded, including the count in the `skipped` field.
- **REQ-004**: The frontend Settings view must gain three new sections below the existing subreddit list:
  - **IMPORT FROM ACCOUNT** — a button that calls `POST /reddit/subscriptions/import`; visible with a status line showing whether PRAW is configured; shows "X subreddits imported, Y already present" inline after execution.
  - **SEARCH SUBREDDITS** — a text input + SEARCH button; results render below as clickable rows showing name + subscriber count; clicking a row calls the existing `POST /reddit/subreddits` and re-renders the list.
  - **BULK IMPORT** — a `<textarea>` for pasting comma/newline-separated names + an IMPORT button; client parses the input, deduplicates, and calls `POST /reddit/subreddits` for each valid name sequentially; shows a summary ("X added, Y skipped") when done.
- **REQ-005**: The IMPORT FROM ACCOUNT button must be disabled and show "PRAW NOT CONFIGURED — see .env" when `_PRAW_CONFIGURED` is false. When true, the button must show "IMPORT FROM ACCOUNT" and be enabled. The praw-configured state is returned by the existing `GET /reddit/subscriptions` endpoint (`source` field: `"praw"` or `"env"`).
- **REQ-006**: Subreddit search results must only display after the user explicitly clicks SEARCH or presses Enter. No debounce / auto-fire on keystrokes — Reddit's public API has rate limits and we are not authenticated.
- **REQ-007**: All three discovery methods must call `_fetchAndRenderSubList()` and `_hardRefresh()` (already implemented) after any successful add/import to update both the settings sub-list and the live feed simultaneously.
- **REQ-008**: All changes persist to `backend/memory/reddit_subreddits.json` via the existing `_save_subreddits()` function. No new persistence mechanism is required.

- **SEC-001**: The `GET /reddit/search` endpoint must validate the `q` parameter server-side: reject empty strings and strings longer than 50 chars with `HTTP 400`. The query is never interpolated into file paths — only into a URL passed to `httpx`.
- **SEC-002**: Search results from the Reddit API must be mapped through a strict allowlist of fields (`name`, `title`, `subscribers`, `public_description`). Raw Reddit JSON must never be forwarded to the frontend.
- **SEC-003**: PRAW credentials (`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`) must remain in `.env` exclusively. The `/reddit/subscriptions/import` response must never include credential values. The `source` field returns only `"praw"` or `"env"`.
- **SEC-004**: All subreddit names from search results and bulk paste input must be validated through `_SUB_NAME_RE` (`^[A-Za-z0-9_]{1,50}$`) before any `POST /reddit/subreddits` call, both client-side (UX) and server-side (enforced — already implemented).
- **SEC-005**: The `POST /reddit/subscriptions/import` endpoint must use the same `_fetch_user_subscriptions()` path already guarded by `_PRAW_CONFIGURED`. If PRAW is not configured, return `HTTP 400` with `detail: "PRAW credentials not configured. Add REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD to .env."`.

- **CON-001**: No new Python package dependencies beyond what is already in `requirements.txt`. PRAW is already an optional dependency; `httpx` is already present for the search endpoint.
- **CON-002**: The search endpoint calls the Reddit public JSON API without authentication. Reddit enforces ~60 requests/minute for unauthenticated clients. The Starling use pattern (search on demand, never auto-polling) is well within this limit.
- **CON-003**: The three new frontend sections must be added within the existing `#reddit-settings-view` div in `frontend/reddit-panel.js`. No new top-level panels, overlays, or routes.
- **CON-004**: The existing settings view structure — subreddit list at top, add-one input row below — must remain unchanged and functional. The three discovery sections are addended below the add-row, separated by labelled dividers.
- **CON-005**: The bulk paste import must process names sequentially (not in parallel) to avoid a burst of simultaneous `POST /reddit/subreddits` calls that could race against each other on the backend file.

- **GUD-001**: All new DOM elements in `reddit-panel.js` must be built with `document.createElement` + `textContent` assignment — never `innerHTML` with user-sourced strings.
- **GUD-002**: All new CSS classes must use the `reddit-settings-` prefix to match existing conventions. Use `Share Tech Mono` for labels, `var(--c)` for accent colour, consistent with the existing settings view.
- **GUD-003**: The `GET /reddit/search` result rendering must reuse `.reddit-settings-sub-row` layout (name + action button) so search results look visually identical to the existing sub-list rows, except the action button says `+ ADD` instead of `✕`.
- **GUD-004**: All error messages (search failure, import failure, cap exceeded) must render in the existing `#reddit-settings-error` element via the `_showRedditSettingsError()` function already implemented.

- **PAT-001**: PRAW setup guide: user navigates to `https://www.reddit.com/prefs/apps` → creates a "script" type app → copies `client_id` (under the app name) and `client_secret` → adds four vars to `.env`: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME` (Reddit username), `REDDIT_PASSWORD` (Reddit password) → restarts Starling. The import button then becomes active.
- **PAT-002**: The `POST /reddit/subscriptions/import` endpoint caps the import at 50 total subreddits (existing + new ≤ 50). Subs beyond the cap are counted in `skipped` but not added.

---

## 2. Implementation Steps

### Implementation Phase 1 — Backend: Import & Search Endpoints

- GOAL-001: Add two new REST endpoints to `backend/reddit.py`: `POST /reddit/subscriptions/import` for PRAW account sync and `GET /reddit/search` for keyword-based subreddit discovery. Raise the subreddit cap from 20 to 50.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In `backend/reddit.py`, locate the two occurrences of `>= 20` (in `add_reddit_subreddit` at `POST /reddit/subreddits` and in any related check) and change the cap value from `20` to `50`. Also update the error detail string to read `"Maximum of 50 subreddits allowed."`. Verify with a text search for `"20 subreddits"` to ensure no other occurrences remain. | | |
| TASK-002 | Add `POST /reddit/subscriptions/import` endpoint to `backend/reddit.py` immediately after the existing `GET /reddit/subscriptions` endpoint (around line 472). Handler logic: (1) if not `_PRAW_CONFIGURED`, raise `HTTPException(400, "PRAW credentials not configured. Add REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD to .env.")`; (2) `account_subs = await _fetch_user_subscriptions()`; (3) `current = _load_subreddits()`; (4) `current_lower = {s.lower() for s in current}`; (5) `to_add = [s for s in account_subs if s.lower() not in current_lower and _SUB_NAME_RE.match(s)]`; (6) `cap_remaining = 50 - len(current)`; (7) `actually_added = to_add[:cap_remaining]`; (8) `skipped = len(to_add) - len(actually_added)`; (9) `_save_subreddits(current + actually_added)`; (10) `_raw_cache.clear(); _synth_cache.clear()`; (11) return `{"imported": len(actually_added), "skipped": skipped, "total": len(current) + len(actually_added), "subreddits": actually_added}`. | | |
| TASK-003 | Add `GET /reddit/search` endpoint to `backend/reddit.py` immediately after `POST /reddit/subscriptions/import`. Signature: `async def search_reddit_subreddits(q: str = Query(...))`. Handler: (1) `q = q.strip()`; (2) if not `q` or `len(q) > 50`, raise `HTTPException(400, "Search query must be 1–50 characters.")`; (3) `url = f"https://www.reddit.com/subreddits/search.json?q={q}&limit=20&include_over_18=0&raw_json=1"`; (4) `headers = {"User-Agent": "STARLING/1.0 (personal assistant; read-only; contact: local)"}`; (5) call with `httpx.AsyncClient(timeout=8.0)`; (6) if non-200 or exception, raise `HTTPException(502, "Reddit search unavailable.")`; (7) parse `resp.json()["data"]["children"]`; (8) for each child `c["data"]`, extract `name = c["data"].get("display_name", "")` — skip if `not _SUB_NAME_RE.match(name)`; build result dict `{"name": name, "title": c["data"].get("title", "")[:80], "subscribers": int(c["data"].get("subscribers") or 0), "description": (c["data"].get("public_description") or "")[:200]}`; (9) return the filtered list. | | |

---

### Implementation Phase 2 — Frontend: IMPORT FROM ACCOUNT Section

- GOAL-002: Add an "IMPORT FROM ACCOUNT" section to the Reddit Settings view in `frontend/reddit-panel.js`. The section checks whether PRAW is configured via `GET /reddit/subscriptions` and enables or disables the import button accordingly, then calls `POST /reddit/subscriptions/import` and shows an inline result.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | In `frontend/reddit-panel.js`, add a new module-level DOM-building helper `_buildImportSection()` that returns a `<div class="reddit-settings-section">` element containing: a `<div class="reddit-settings-section-label">IMPORT FROM ACCOUNT</div>`, a `<div class="reddit-settings-import-status" id="reddit-import-status">CHECKING…</div>` (shows PRAW status), a `<button class="reddit-settings-import-btn" id="reddit-import-btn" disabled>IMPORT FROM ACCOUNT</button>`, and a `<div class="reddit-settings-import-result hidden" id="reddit-import-result"></div>` (inline result text). Store refs to `importBtn` and `importResult` as closure variables for use in the button click handler. | | |
| TASK-005 | Inside `_buildImportSection()`, wire an async `click` handler on `importBtn`: (1) `importBtn.disabled = true; importBtn.textContent = 'IMPORTING…'`; (2) `const res = await fetch('/reddit/subscriptions/import', { method: 'POST' })`; (3) if `!res.ok`: show `_showRedditSettingsError(body.detail ?? 'Import failed.')`, reset button; (4) if ok: parse body, show `importResult.textContent = \`${body.imported} subreddits imported, ${body.skipped} skipped.\``, remove `hidden` from `importResult`; (5) call `await _fetchAndRenderSubList(); _hardRefresh()`; (6) `importBtn.textContent = 'IMPORT FROM ACCOUNT'; importBtn.disabled = false`. | | |
| TASK-006 | Inside `_buildImportSection()`, after building the DOM, fire an async IIFE to check PRAW status: `fetch('/reddit/subscriptions').then(r => r.json()).then(body => { if (body.source === 'praw') { importStatus.textContent = 'PRAW CONFIGURED — account: ' + (body.subreddits[0] ? 'active' : 'empty'); importBtn.disabled = false; } else { importStatus.textContent = 'PRAW NOT CONFIGURED — add credentials to .env'; importBtn.disabled = true; importBtn.title = 'Add REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD to .env'; } }).catch(() => { importStatus.textContent = 'Could not check PRAW status.'; })`. | | |
| TASK-007 | In `_showRedditSettingsView()` in `reddit-panel.js`, after appending the add-row to the settings view, call `redditSettingsView.appendChild(_buildImportSection())` to attach the import section. Ensure `_buildImportSection()` is called fresh each time the settings view opens (so the PRAW status check re-runs). To prevent duplication, query `redditSettingsView.querySelector('.reddit-settings-section')` before appending and remove any existing `.reddit-settings-section` elements first, or use a fixed `id="reddit-import-section"` and skip append if already present. | | |

---

### Implementation Phase 3 — Frontend: SEARCH SUBREDDITS Section

- GOAL-003: Add a live keyword search section to the settings view that calls `GET /reddit/search`, renders clickable result rows, and lets the user subscribe with one click.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | In `frontend/reddit-panel.js`, add a `_buildSearchSection()` helper that returns a `<div class="reddit-settings-section">` containing: a `<div class="reddit-settings-section-label">SEARCH SUBREDDITS</div>`, a `<div class="reddit-settings-search-row">` with `<input class="reddit-settings-input" id="reddit-search-input" type="text" placeholder="search by keyword…" maxlength="50" spellcheck="false" autocomplete="off">` and `<button class="reddit-settings-add-btn" id="reddit-search-btn">SEARCH</button>`, and a `<div class="reddit-settings-search-results hidden" id="reddit-search-results"></div>`. | | |
| TASK-009 | Wire the search logic inside `_buildSearchSection()`: (1) extract the `q` value from `searchInput.value.trim()`; (2) if empty or `q.length > 50`, call `_showRedditSettingsError('Enter a search term (max 50 chars).')` and return; (3) `searchBtn.disabled = true; searchBtn.textContent = '…'`; (4) call `fetch(\`/reddit/search?q=\${encodeURIComponent(q)}\`)`; (5) on error or `!res.ok`, call `_showRedditSettingsError('Search failed — try again.')`, reset button; (6) on success, clear `searchResults.innerHTML`, remove `hidden` from `searchResults`, and render each result with `_createSearchResultRow(result, searchResults)`. Wire this logic to both `searchBtn.addEventListener('click', handler)` and `searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') handler(); })`. Reset button text to `'SEARCH'` and re-enable in `finally`. | | |
| TASK-010 | Implement `_createSearchResultRow(result, container)` in `reddit-panel.js`. Builds a `<div class="reddit-settings-sub-row">` containing: `<div class="reddit-settings-sub-name">r/{result.name} <span class="reddit-settings-sub-meta">{subscribers} members</span></div>` and `<button class="reddit-settings-add-btn reddit-search-add-btn">+ ADD</button>`. The `+ ADD` click handler: (1) `addBtn.disabled = true`; (2) call `_addSubreddit(result.name)` (already implemented, handles POST + re-render + error display); (3) `addBtn.textContent = '✓'` on success (detect by absence of error element update). Since `_addSubreddit` does not return a status, wire it by checking `_showRedditSettingsError` — simpler alternative: `addBtn.textContent = '✓'; addBtn.disabled = true` immediately without waiting, since the sub-list re-render will confirm it was added. | | |
| TASK-011 | In `_showRedditSettingsView()`, call `redditSettingsView.appendChild(_buildSearchSection())` after the import section. Apply the same deduplication guard as TASK-007 (check for existing element by `id` before appending). | | |

---

### Implementation Phase 4 — Frontend: BULK IMPORT Section

- GOAL-004: Add a bulk paste import textarea to the settings view so users can paste a comma- or newline-separated list of subreddit names and import all valid entries at once.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-012 | In `frontend/reddit-panel.js`, add a `_buildBulkSection()` helper returning a `<div class="reddit-settings-section">` containing: a `<div class="reddit-settings-section-label">BULK IMPORT</div>`, a `<div class="reddit-settings-bulk-hint">Paste subreddit names separated by commas or newlines.</div>`, a `<textarea class="reddit-settings-bulk-input" id="reddit-bulk-input" rows="4" placeholder="worldnews, technology&#10;programming&#10;r/MachineLearning" spellcheck="false" autocomplete="off"></textarea>`, a `<button class="reddit-settings-add-btn" id="reddit-bulk-btn">IMPORT LIST</button>`, and a `<div class="reddit-settings-import-result hidden" id="reddit-bulk-result"></div>`. | | |
| TASK-013 | Wire the bulk import handler inside `_buildBulkSection()`: (1) parse `bulkInput.value` by splitting on `/[\s,;\n]+/` and filtering each token through `s => s.trim().replace(/^r\//i, '')`; (2) apply `_SUB_NAME_RE` client-side to build `validNames: string[]` and `invalidCount = total - valid.length`; (3) if `validNames.length === 0`, call `_showRedditSettingsError('No valid subreddit names found.')` and return; (4) disable `bulkBtn`, set `bulkBtn.textContent = 'IMPORTING…'`; (5) iterate `validNames` **sequentially** (not in parallel) with `for…of` + `await _addSubredditSilent(name)` — a new internal function that calls `POST /reddit/subreddits` and returns `{ ok: boolean, detail: string }`; (6) count `added` (HTTP 200) and `skipped` (HTTP 400 "already in list" or cap exceeded); (7) show `bulkResult.textContent = \`${added} added, ${skipped} skipped.\`` remove `hidden`; (8) call `await _fetchAndRenderSubList(); _hardRefresh()`; (9) reset button. | | |
| TASK-014 | Implement `async function _addSubredditSilent(name)` in `reddit-panel.js`. Same logic as `_addSubreddit()` but: (a) does NOT update `redditSettingsInput`, (b) does NOT call `_fetchAndRenderSubList()` or `_hardRefresh()` (the bulk handler calls these once at the end), (c) returns `{ ok: boolean, detail: string }` instead of void. Used exclusively by the bulk import handler to avoid redundant re-renders on every iteration. | | |
| TASK-015 | In `_showRedditSettingsView()`, call `redditSettingsView.appendChild(_buildBulkSection())` after the search section. Apply the same deduplication guard. | | |

---

### Implementation Phase 5 — CSS: Settings Section Styles

- GOAL-005: Add CSS for the three new discovery sections and their sub-elements to `frontend/style.css`, consistent with the existing `reddit-settings-` class conventions.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-016 | In `frontend/style.css`, locate the existing `.reddit-settings-*` rules block. After the last rule in that block, add styles for: `.reddit-settings-section` (top-border divider: `border-top: 1px solid rgba(200,200,200,0.07); padding-top: 14px; margin-top: 14px; display: flex; flex-direction: column; gap: 8px;`), `.reddit-settings-section-label` (same as `.reddit-settings-title` but `font-size: 8px; letter-spacing: 3px; color: rgba(200,200,200,0.28); margin-bottom: 4px;`). | | |
| TASK-017 | Add styles for: `.reddit-settings-import-status` (`font-size: 10px; color: rgba(200,200,200,0.45); letter-spacing: 0.5px;`), `.reddit-settings-import-btn` (same appearance as `.reddit-settings-add-btn` but full-width: `width: 100%`), `.reddit-settings-import-result` (`font-size: 10px; color: rgba(200,200,200,0.6); letter-spacing: 0.5px;`), `.reddit-settings-search-row` (`display: flex; gap: 6px;` with input `flex: 1`), `.reddit-settings-sub-meta` (`font-size: 9px; color: rgba(200,200,200,0.35); margin-left: 6px;`). | | |
| TASK-018 | Add styles for: `.reddit-settings-bulk-hint` (`font-size: 10px; color: rgba(200,200,200,0.35); letter-spacing: 0.5px;`), `.reddit-settings-bulk-input` (same font/color as `.reddit-settings-input` but `min-height: 72px; resize: vertical; padding: 6px 8px; line-height: 1.5;`), `.reddit-settings-search-results` (`display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow-y: auto;` — reuses existing `.reddit-settings-sub-row` for individual rows). | | |

---

## 3. Alternatives

- **ALT-001**: **OAuth 2.0 Web App flow** — A full Reddit OAuth flow using the `web` app type, opening a Reddit authorisation URL in the Starling browser panel, then exchanging the code for access/refresh tokens stored locally. Rejected because it requires a redirect URI (non-trivial for a local app with no public URL), token refresh management, and significantly more backend complexity, for no practical gain over the Script-type PRAW flow for a personal assistant.
- **ALT-002**: **Scraping `reddit.com/subreddits/mine`** — Having the user log into Reddit in the Starling browser panel, then scraping the page DOM for subreddit names. Rejected because scraping HTML pages is fragile (Reddit's HTML structure changes) and violates Reddit's Terms of Service.
- **ALT-003**: **Reddit OPML / export file import** — Reddit does not offer a native subreddit export in a machine-readable format. Rejected due to no available export mechanism.
- **ALT-004**: **Showing popular/default subreddits as suggestions** — Fetching `/subreddits/default.json` or `/subreddits/popular.json` and displaying them as clickable presets. Considered as a complementary feature but deferred — it provides less personalisation value than keyword search and would clutter the settings view.
- **ALT-005**: **Parallel bulk import** — Processing all bulk-paste subreddits concurrently with `Promise.all`. Rejected because parallel writes to the same JSON file on the backend could cause race conditions between backend reads and writes in the current single-file persistence model.

---

## 4. Dependencies

- **DEP-001**: `praw >= 7.7.0` — already an optional dependency in `requirements.txt`. Required only for PRAW Account Import (Phase 2). Subreddit Search and Bulk Import function without it.
- **DEP-002**: `httpx` — already in `requirements.txt` and used throughout `reddit.py`. Required for the `GET /reddit/search` endpoint.
- **DEP-003**: Reddit Script App credentials — user must register a "script" type application at `https://www.reddit.com/prefs/apps` and add `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` to `.env`. Required only for PRAW Account Import.
- **DEP-004**: Reddit public JSON API — used by `GET /reddit/search` without authentication. No credentials required. Subject to Reddit's unauthenticated rate limit (~60 req/min), which the on-demand search pattern does not approach.
- **DEP-005**: `backend/memory/reddit_subreddits.json` — the persistence file already written by `_save_subreddits()`. All three import methods write to this file. The file is created automatically on first save if it does not exist.

---

## 5. Files

- **FILE-001**: `backend/reddit.py` — Add `POST /reddit/subscriptions/import`, `GET /reddit/search`. Raise cap from 20 → 50 in `add_reddit_subreddit`. No other files in the backend layer require changes.
- **FILE-002**: `frontend/reddit-panel.js` — Add `_buildImportSection()`, `_buildSearchSection()`, `_buildBulkSection()`, `_addSubredditSilent()`, `_createSearchResultRow()`. Modify `_showRedditSettingsView()` to attach the three sections.
- **FILE-003**: `frontend/style.css` — Add CSS for `.reddit-settings-section`, `.reddit-settings-section-label`, `.reddit-settings-import-status`, `.reddit-settings-import-btn`, `.reddit-settings-import-result`, `.reddit-settings-search-row`, `.reddit-settings-search-results`, `.reddit-settings-sub-meta`, `.reddit-settings-bulk-hint`, `.reddit-settings-bulk-input`.
- **FILE-004**: `backend/memory/reddit_subreddits.json` — Modified at runtime by import/add operations. No code changes; listed for awareness.

---

## 6. Testing

- **TEST-001**: Start Starling without PRAW credentials in `.env`. Open the Reddit settings view. Verify the IMPORT FROM ACCOUNT button is disabled and the status line reads "PRAW NOT CONFIGURED".
- **TEST-002**: Add four valid PRAW credential env vars to `.env` and restart. Open Reddit settings. Verify the import button is enabled and the status line reflects "PRAW CONFIGURED".
- **TEST-003**: Click IMPORT FROM ACCOUNT. Verify `POST /reddit/subscriptions/import` is called, `reddit_subreddits.json` is updated with the fetched subs, and the settings sub-list re-renders with the new entries.
- **TEST-004**: Manually add 50 subreddits until the cap is hit. Attempt to import more via any method. Verify HTTP 400 is returned and the inline error "Maximum of 50 subreddits allowed." appears.
- **TEST-005**: Type "programming" in the search box and click SEARCH. Verify `GET /reddit/search?q=programming` is called, results are rendered with name + subscriber count, and clicking `+ ADD` on a result adds it to the active list and re-renders the sub-list.
- **TEST-006**: Search for an invalid/non-existent subreddit. Verify a graceful empty state or error is shown with no crash.
- **TEST-007**: Paste "worldnews, technology\nscience\nr/gaming" into the bulk textarea and click IMPORT LIST. Verify all four names are parsed correctly (with `r/` stripped), added via sequential `POST` calls, and the final result shows "4 added, 0 skipped" (or correct counts if some already existed).
- **TEST-008**: Paste a list containing 10 already-subscribed subreddits. Verify the result shows "0 added, 10 skipped" and no error is thrown.
- **TEST-009**: Shut down Starling after importing subreddits via any method. Verify `backend/memory/reddit_subreddits.json` contains the imported list. Reboot Starling. Open the Reddit panel. Verify the feed loads the persisted subreddits, not the `.env` default list.
- **TEST-010**: Paste a mixed list with valid names, names containing special characters, and names exceeding 50 chars. Verify only valid names (matching `^[A-Za-z0-9_]{1,50}$`) are submitted; invalid ones are counted in `skipped`.

---

## 7. Risks & Assumptions

- **RISK-001**: Reddit may rate-limit or block the unauthenticated `GET /reddit/search` endpoint if the user searches frequently. Mitigation: search is user-initiated (not auto-polled), and Starling's usage pattern is far below 60 req/min. If blocked, the endpoint returns HTTP 502 and the UI displays "Search failed — try again."
- **RISK-002**: PRAW authentication may fail if the user's Reddit account uses two-factor authentication. PRAW Script-type apps do not support 2FA accounts. Mitigation: the import button will surface the PRAW error inline; the user can fall back to Bulk Import or manual search.
- **RISK-003**: Reddit's public `/subreddits/search.json` JSON API structure may change without notice. Mitigation: the backend maps results through a strict field allowlist (`name`, `title`, `subscribers`, `public_description`) — missing fields are silently omitted rather than crashing.
- **RISK-004**: Large PRAW subscription lists (200+ subreddits) will exceed the 50-subreddit cap and many subs will be skipped. The import result clearly communicates the count. Users who want more than 50 subs should raise the cap constant manually (documented in `.env.example`).
- **ASSUMPTION-001**: The user has a Reddit account with at least some public subscriptions when using PRAW import.
- **ASSUMPTION-002**: `praw` is already listed in `requirements.txt` (noted in the Phase 2 section of `feature-reddit-social-1.md`). If not, `pip install praw>=7.7.0` must be added before Phase 2 of this plan is tested.
- **ASSUMPTION-003**: The existing `_showRedditSettingsView()` and `_hideRedditSettingsView()` functions in `reddit-panel.js` toggle the correct elements. The new sections are appended inside `#reddit-settings-view` and will be shown/hidden automatically.

---

## 8. Related Specifications / Further Reading

- [plan/feature-reddit-subreddit-settings-1.md](feature-reddit-subreddit-settings-1.md) — The preceding plan that implemented the base Settings view (add/remove one at a time) and the persistence file. This plan builds directly on top of it.
- [assets/archived/feature-reddit-social-1.md](../assets/archived/feature-reddit-social-1.md) — The original Reddit panel implementation plan (Phase 1 complete, Phase 2 PRAW auth partially implemented).
- [Reddit API documentation — Script Apps](https://www.reddit.com/dev/api/) — Reference for PRAW Script-type app registration and credential setup.
- [PRAW documentation — user.subreddits()](https://praw.readthedocs.io/en/stable/code_overview/models/user.html) — Reference for the `reddit.user.subreddits(limit=100)` call used in `_fetch_user_subscriptions()`.
- [Reddit public JSON API — subreddits/search](https://www.reddit.com/dev/api/#GET_subreddits_search) — Reference for the unauthenticated search endpoint used in `GET /reddit/search`.
