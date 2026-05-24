---
goal: YouTube Channel Discovery & Account Import — Handle/URL resolution, Google OAuth subscription sync, and keyword channel search for the Starling YouTube Settings view
version: 1.0
date_created: 2026-05-24
last_updated: 2026-05-24
owner: Daniel Simpson
status: 'Planned'
tags: [feature, frontend, backend, youtube, discovery, oauth, settings, persistence]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Extends the existing YouTube Settings view (add channel by raw ID / remove channel) with
three discovery and import improvements that remove the friction of finding and entering
opaque `UCxxxxxxxxxxxxxxxxxxxxxxxxx` channel IDs:

1. **Handle/URL Resolution** — the settings input is enhanced to accept any of:
   YouTube channel URLs (`https://www.youtube.com/@MKBHD`), bare handles (`@MKBHD`),
   or full `/channel/UCxxxx` URLs. The backend resolves these to a channel ID — without
   an API key via lightweight page parsing, or with higher fidelity via the YouTube Data
   API v3 when `YOUTUBE_API_KEY` is set.
2. **Google OAuth2 Subscription Import** — a single-click flow that authenticates the user
   with their Google account (OAuth2, `youtube.readonly` scope) using the Starling browser
   panel as the consent screen, then fetches and imports all subscribed channels from their
   YouTube account into `backend/memory/youtube_channels.json`.
3. **Channel Keyword Search** — a search input inside the Settings view that queries the
   YouTube Data API v3 for channels matching a keyword (requires `YOUTUBE_API_KEY`), and
   lets the user subscribe with one click.

All methods write exclusively to `backend/memory/youtube_channels.json` (already
implemented), so every imported channel survives Starling shutdowns and reboots.
A 50-channel cap is enforced to keep RSS feed fetches fast and within reasonable limits.

---

## 1. Requirements & Constraints

- **REQ-001**: A `POST /youtube/channels/resolve` endpoint must accept `{"input": str}`, parse the input as a raw channel ID, a `/channel/UCxxxx` URL, a `/@handle` URL, or a bare `@handle` (with or without the `@` prefix), resolve it to a `UCxxxxxxxxxxxxxxxxxxxxxxxxx` channel ID, and return `{"channel_id": str, "display_name": str | null, "resolved_from": str}`. If resolution fails, return HTTP 422 with a plain-text explanation.
- **REQ-002**: Handle resolution must work in two modes: (a) **No API key** — use `httpx` to fetch `https://www.youtube.com/@{handle}`, then regex-extract the channel ID from the embedded `"channelId":"UCxxxx"` JSON field in the page source; (b) **API key configured** — use the existing `_resolve_handle_to_channel_id()` function which calls the YouTube Data API v3 `channels?forHandle=` endpoint. Mode (b) takes priority when `_API_CONFIGURED` is true.
- **REQ-003**: `GET /youtube/auth` must construct and return the Google OAuth2 consent URL. Parameters: `client_id=YOUTUBE_CLIENT_ID`, `redirect_uri=http://localhost:8000/youtube/callback`, `response_type=code`, `scope=https://www.googleapis.com/auth/youtube.readonly`, `access_type=offline`, `prompt=consent`, `state={random 16-byte hex token stored in a module-level dict for CSRF validation}`. Return `{"auth_url": str}`. Requires `_OAUTH_CONFIGURED` (i.e. both `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` are set).
- **REQ-004**: `GET /youtube/callback` must accept `code` and `state` query parameters, validate `state` against the stored CSRF token, exchange `code` for tokens via `POST https://oauth2.googleapis.com/token`, save `{access_token, refresh_token, expires_at}` to `backend/memory/youtube_token.json`, and return an HTML response `<html><body><script>window.close()</script><p>Authentication complete. You may close this tab.</p></body></html>` so the browser panel self-closes.
- **REQ-005**: `POST /youtube/subscriptions/import` must: (1) require `_OAUTH_CONFIGURED` and a valid token file — return HTTP 400 if either is missing; (2) call `_refresh_token_if_needed()` to ensure a fresh access token; (3) paginate through `GET https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=50&pageToken={...}` using the access token until all pages are fetched; (4) extract channel IDs from `item.snippet.resourceId.channelId`; (5) deduplicate against `_load_channels()`; (6) cap total channels at 50 (count existing + new ≤ 50, truncate remainder); (7) `_save_channels()`, `_raw_cache.clear()`, `_synth_cache.clear()`; (8) return `{"imported": int, "skipped": int, "cap_reached": bool, "total": int}`.
- **REQ-006**: `GET /youtube/search` must accept `q: str` query param (1–100 chars), call `GET https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q={q}&maxResults=15&key={YOUTUBE_API_KEY}`, map each result to `{"channel_id": item.id.channelId, "name": item.snippet.title, "description": item.snippet.description[:200], "thumbnail_url": item.snippet.thumbnails.default.url}`, and return the list. Return HTTP 400 if query is empty or exceeds 100 chars. Return HTTP 503 if `_API_CONFIGURED` is false. Only call the endpoint when explicitly triggered — never polled or debounced.
- **REQ-007**: The frontend settings view must gain three new sections built below the existing channel list and add-row:
  - **RESOLVE & ADD** — the existing channel ID input is replaced with a smart resolver input + FIND button; after resolution succeeds, a preview row shows the channel name + channel ID with "ADD" and "CANCEL" buttons; on ADD, the resolved `channel_id` is sent to the existing `POST /youtube/channels` endpoint.
  - **IMPORT FROM GOOGLE** — shows auth status; "CONNECT ACCOUNT" button when not authenticated; "IMPORT SUBSCRIPTIONS" button when authenticated; inline result after import.
  - **SEARCH CHANNELS** — visible only when `api_key_configured: true` (read from `GET /youtube/auth-status` response); search input + SEARCH button; results rendered as rows with `+ ADD`.
- **REQ-008**: The 50-channel cap must be enforced in both the backend `POST /youtube/channels` endpoint (already raises HTTP 400 at cap) and the `POST /youtube/subscriptions/import` endpoint. The cap constant must be extracted into a single module-level `_CHANNEL_CAP = 50` constant in `youtube.py` rather than hardcoded in each handler.
- **REQ-009**: All changes persist to `backend/memory/youtube_channels.json` via the existing `_save_channels()` function. No new persistence files are needed beyond `backend/memory/youtube_token.json` (for the OAuth token).
- **REQ-010**: The existing channel add-by-raw-ID input in the settings HTML (`#yt-settings-input`) must be preserved as the fallback, but the RESOLVE & ADD section replaces it as the primary UX. Specifically: the input's placeholder text updates to `@handle, channel URL, or UCxxxx ID` and the submit path routes through `POST /youtube/channels/resolve` before adding.

- **SEC-001**: The CSRF state token in `GET /youtube/auth` must be generated with `secrets.token_hex(16)` (stdlib), stored in a module-level dict keyed by the token value, and validated exactly once in `GET /youtube/callback` — it must be popped (consumed) on successful validation to prevent replay.
- **SEC-002**: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_API_KEY` must remain exclusively in `.env`. None of these values may appear in any API response body or server log at INFO level. Token values from `youtube_token.json` must never be forwarded to the frontend.
- **SEC-003**: `backend/memory/youtube_token.json` must never be committed to version control. Verify it is excluded by `.gitignore` (the existing `backend/memory/*.json` or `backend/memory/` pattern should already cover it).
- **SEC-004**: The `state` parameter validation in `GET /youtube/callback` must occur before any token exchange call. If `state` is absent or does not match a pending entry, return HTTP 400 immediately.
- **SEC-005**: The `GET /youtube/callback` endpoint must NOT redirect the user to any URL derived from query parameters. The redirect URI is hardcoded to `http://localhost:8000/youtube/callback` in the auth URL construction — no open redirect is possible.
- **SEC-006**: The handle resolution scraper (`_resolve_handle_no_api`) must only request URLs matching `https://www.youtube.com/@[A-Za-z0-9._-]+` — handles must be validated against `^[A-Za-z0-9._-]{1,100}$` before being interpolated into the URL, to prevent SSRF to arbitrary hosts.
- **SEC-007**: All channel IDs received from the OAuth subscriptions API and the search API must be validated through `_CHANNEL_ID_RE` (`^UC[A-Za-z0-9_\-]{22}$`) before any storage or use. External API results are untrusted.

- **CON-001**: The OAuth2 redirect URI is hardcoded to `http://localhost:8000/youtube/callback`. The user must register this exact URI in their Google Cloud Console OAuth2 credentials configuration. This is a one-time setup step.
- **CON-002**: The YouTube Data API v3 `search?type=channel` endpoint costs 100 units per call from the 10,000-unit daily free quota. With user-initiated searches only (never polled), 100 searches per day is a realistic ceiling — well within quota.
- **CON-003**: The `subscriptions.list` API endpoint costs 1 unit per page (50 results per page). A user following 500 channels requires 10 API calls = 10 units. Well within quota.
- **CON-004**: No new Python package dependencies are permitted. OAuth2 token exchange and API calls use the existing `httpx` library. No `google-auth-oauthlib` or `google-api-python-client` is added.
- **CON-005**: Handle resolution via page scraping (`_resolve_handle_no_api`) relies on YouTube embedding `"channelId":"UCxxxx"` in page source. YouTube may change this without notice; the endpoint must return a clear error (HTTP 422, `"Handle could not be resolved. Try pasting the full channel URL or a UCxxxx ID."`) rather than silently returning a wrong result.
- **CON-006**: The three new frontend sections must be appended inside the existing `#yt-settings-view` div in `frontend/youtube-panel.js` via `_showSettingsView()`. No new panels, modals, or routes are added.
- **CON-007**: The channel cap is raised from the current implicit unlimited to `_CHANNEL_CAP = 50`. Import and search add paths must check this cap. The single-add path (`POST /youtube/channels`) must also check it.

- **GUD-001**: All new DOM elements in `youtube-panel.js` must be built with `document.createElement` + `textContent` assignment — never `innerHTML` with user-sourced strings.
- **GUD-002**: All new CSS classes must use the `yt-settings-` prefix to match existing conventions in `frontend/style.css`.
- **GUD-003**: The SEARCH CHANNELS section must only be injected into the DOM when `api_key_configured === true` in the `GET /youtube/auth-status` response. Do not render it with a "disabled" state — simply omit it entirely if no API key is configured.
- **GUD-004**: All error messages must be surfaced via the existing `_showSettingsError()` function and rendered in `#yt-settings-error`. No `alert()` or console-only error reporting.

- **PAT-001**: OAuth consent page setup: user navigates to `https://console.cloud.google.com/apis/credentials`, creates an OAuth 2.0 Client ID (Web application type), adds `http://localhost:8000/youtube/callback` as an Authorized Redirect URI, copies `Client ID` and `Client Secret` to `.env` as `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`. Also enables the YouTube Data API v3 in the project and creates an API key for `YOUTUBE_API_KEY` (optional but enables both channel search and OAuth-based subscription fetch enrichment).
- **PAT-002**: Token refresh strategy: access tokens expire in 3600 seconds. `_refresh_token_if_needed()` reads `youtube_token.json`, checks `expires_at` vs `time.time() + 60` (60s buffer), and if expired calls `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token` to get a new `access_token`, updates `expires_at = time.time() + expires_in`, and saves back to `youtube_token.json`.

---

## 2. Implementation Steps

### Implementation Phase 1 — Backend: Channel Cap Constant & Handle/URL Resolver

- GOAL-001: Extract the channel cap into a single constant, implement `_resolve_input_to_channel_id()` and `_resolve_handle_no_api()` helpers, add the `POST /youtube/channels/resolve` endpoint, and enforce the cap in `POST /youtube/channels`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In `backend/youtube.py`, immediately after `_CHANNEL_ID_RE`, add `_CHANNEL_CAP = 50` as a module-level constant. In `post_youtube_channel()` (the `POST /youtube/channels` handler), find the line `channels.append(body.channel_id)` and insert a cap check immediately before it: `if len(channels) >= _CHANNEL_CAP: raise HTTPException(status_code=400, detail=f"Maximum of {_CHANNEL_CAP} channels allowed.")`. Update any existing hardcoded `20` cap values in the same file to reference `_CHANNEL_CAP`. | | |
| TASK-002 | Add `async def _resolve_handle_no_api(handle: str) -> str | None` in `backend/youtube.py`, in the Phase 2 helpers section below `_resolve_handle_to_channel_id`. Logic: (1) `clean = re.sub(r'^@', '', handle.strip())`; (2) validate `clean` against `^[A-Za-z0-9._-]{1,100}$` — return `None` immediately if invalid (SEC-006); (3) `url = f"https://www.youtube.com/@{clean}"`; (4) `async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client: resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (compatible; STARLING/1.0)"})`; (5) look for `"channelId":"(UC[A-Za-z0-9_\-]{22})"` in `resp.text` using `re.search`; (6) if found and `_CHANNEL_ID_RE.match(m.group(1))`, return `m.group(1)`; (7) fallback: look for `<link rel="canonical" href="https://www.youtube.com/channel/(UC[A-Za-z0-9_\-]{22})"` in `resp.text`; (8) return match group or `None`; (9) wrap all in `try/except Exception` logging a warning and returning `None`. | | |
| TASK-003 | Add `async def _resolve_input_to_channel_id(raw: str) -> tuple[str | None, str]` in `backend/youtube.py`. The function returns `(channel_id_or_None, resolved_from_label)`. Logic: (1) `s = raw.strip()`; (2) `# Direct channel ID?` — if `_CHANNEL_ID_RE.match(s)`: return `(s, "channel_id")`; (3) `# /channel/ URL?` — `m = re.search(r'/channel/(UC[A-Za-z0-9_\-]{22})', s)` — if match: return `(m.group(1), "url_channel")`; (4) `# Handle or /@handle URL?` — `m = re.search(r'(?:youtube\.com/)?@([A-Za-z0-9._-]{1,100})', s)` — if match, extract `handle = m.group(1)`; else if `s` starts with `@` or contains no `/`, treat `s.lstrip('@')` as a bare handle; (5) if API key configured, try `await _resolve_handle_to_channel_id(handle)` first — return `(result, "api_handle")` if not None; (6) else fall back to `await _resolve_handle_no_api(handle)` — return `(result, "scraped_handle")` if not None; (7) return `(None, "unresolved")` as the last fallback. | | |
| TASK-004 | Add a Pydantic model `class ChannelResolveRequest(BaseModel): input: str` in `backend/youtube.py`, alongside the existing `ChannelAddRequest` model. Add `POST /youtube/channels/resolve` endpoint. Handler: (1) `raw = body.input.strip()`; (2) if `not raw or len(raw) > 300`, raise `HTTPException(400, "Input must be 1–300 characters.")`; (3) `channel_id, resolved_from = await _resolve_input_to_channel_id(raw)`; (4) if `channel_id is None`, raise `HTTPException(422, "Could not resolve to a YouTube channel ID. Try pasting the full channel URL or a UCxxxx ID.")`; (5) `display_name = _channel_name_map.get(channel_id)`; (6) if display name is None and `_API_CONFIGURED`: attempt a lightweight `GET https://www.googleapis.com/youtube/v3/channels?part=snippet&id={channel_id}&key={YOUTUBE_API_KEY}` to populate `_channel_name_map[channel_id]` with `items[0].snippet.title`; (7) return `{"channel_id": channel_id, "display_name": _channel_name_map.get(channel_id), "resolved_from": resolved_from}`. | | |

---

### Implementation Phase 2 — Backend: Google OAuth2 Flow

- GOAL-002: Implement the Google OAuth2 consent URL generator, the callback handler with CSRF validation and token exchange, the token helpers, and the `POST /youtube/subscriptions/import` endpoint.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Add `import secrets, urllib.parse` to the import block at the top of `backend/youtube.py` (both are stdlib — no new packages). Add a module-level `_oauth_states: dict[str, float] = {}` for CSRF state token storage (maps `state_token → created_at timestamp`). | | |
| TASK-006 | Add `GET /youtube/auth` endpoint in `backend/youtube.py`. Handler: (1) if not `_OAUTH_CONFIGURED`, raise `HTTPException(400, "OAuth not configured. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to .env.")`; (2) `state = secrets.token_hex(16)`; (3) prune `_oauth_states` of entries older than 600 seconds; (4) `_oauth_states[state] = time.time()`; (5) build `params = {"client_id": YOUTUBE_CLIENT_ID, "redirect_uri": "http://localhost:8000/youtube/callback", "response_type": "code", "scope": "https://www.googleapis.com/auth/youtube.readonly", "access_type": "offline", "prompt": "consent", "state": state}`; (6) `auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)`; (7) return `{"auth_url": auth_url}`. | | |
| TASK-007 | Add `def _load_token() -> dict | None` and `def _save_token(token: dict) -> None` helpers in `backend/youtube.py`. `_load_token` reads `_TOKEN_PATH` (already defined as `Path(__file__).parent / "memory" / "youtube_token.json"`), parses JSON, returns dict or `None` on any failure. `_save_token` writes `json.dumps(token, indent=2)` to `_TOKEN_PATH` (ensure parent dir exists). Neither function logs the token value itself — only success/failure at INFO/ERROR level. | | |
| TASK-008 | Add `async def _refresh_token_if_needed() -> str | None` in `backend/youtube.py`. Logic: (1) `token = _load_token()` — return `None` if `None`; (2) if `token.get("expires_at", 0) > time.time() + 60`: return `token["access_token"]` (still valid); (3) `refresh_token = token.get("refresh_token")` — return `None` if missing; (4) `async with httpx.AsyncClient(timeout=10.0) as client: resp = await client.post("https://oauth2.googleapis.com/token", data={"client_id": YOUTUBE_CLIENT_ID, "client_secret": YOUTUBE_CLIENT_SECRET, "refresh_token": refresh_token, "grant_type": "refresh_token"})`; (5) if `resp.status_code != 200`, log error and return `None`; (6) `new_data = resp.json()`; (7) `token["access_token"] = new_data["access_token"]`; (8) `token["expires_at"] = time.time() + new_data.get("expires_in", 3600)`; (9) `_save_token(token)`; (10) return `token["access_token"]`. | | |
| TASK-009 | Add `GET /youtube/callback` endpoint in `backend/youtube.py`. Use `from fastapi.responses import HTMLResponse`. Signature: `async def youtube_oauth_callback(code: str = Query(None), state: str = Query(None), error: str = Query(None))`. Handler: (1) `_close_html = "<html><body><script>window.close()</script><p>Authentication complete. You may close this tab.</p></body></html>"`; (2) if `error` is not None, log it and return `HTMLResponse("<html><body><p>Authentication failed: {error}. You may close this tab.</p></body></html>", status_code=400)`; (3) if not `state` or `state` not in `_oauth_states`, return `HTMLResponse("<html><body><p>Invalid state. You may close this tab.</p></body></html>", status_code=400)`; (4) `_oauth_states.pop(state)`; (5) if not `code`, return error HTML; (6) `async with httpx.AsyncClient(timeout=10.0) as client: resp = await client.post("https://oauth2.googleapis.com/token", data={"code": code, "client_id": YOUTUBE_CLIENT_ID, "client_secret": YOUTUBE_CLIENT_SECRET, "redirect_uri": "http://localhost:8000/youtube/callback", "grant_type": "authorization_code"})`; (7) if `resp.status_code != 200`, return error HTML; (8) `d = resp.json()`; (9) `token = {"access_token": d["access_token"], "refresh_token": d.get("refresh_token"), "expires_at": time.time() + d.get("expires_in", 3600)}`; (10) `_save_token(token)`; (11) return `HTMLResponse(_close_html)`. | | |
| TASK-010 | Add `POST /youtube/subscriptions/import` endpoint in `backend/youtube.py`. Handler: (1) if not `_OAUTH_CONFIGURED`, raise `HTTPException(400, "OAuth not configured.")`; (2) `access_token = await _refresh_token_if_needed()` — if `None`, raise `HTTPException(401, "Not authenticated. Connect your Google account first.")`; (3) fetch all subscription pages: initialise `all_channel_ids = []`, `page_token = None`; loop — `params = {"part": "snippet", "mine": "true", "maxResults": "50", "access_token": access_token}`; if `page_token`: `params["pageToken"] = page_token`; `GET https://www.googleapis.com/youtube/v3/subscriptions` with those params; on non-200, break; extract `item.snippet.resourceId.channelId` for each item, validate through `_CHANNEL_ID_RE`; get next `pageToken` from response; stop when `nextPageToken` is absent (max 20 pages to prevent infinite loop); (4) deduplicate: `current = _load_channels(); existing_lower = {c.lower() for c in current}; to_add = [ch for ch in all_channel_ids if ch not in existing_lower]`; (5) `cap_remaining = _CHANNEL_CAP - len(current)`; `actually_added = to_add[:cap_remaining]`; `skipped = len(to_add) - len(actually_added)`; (6) `_save_channels(current + actually_added); _raw_cache.clear(); _synth_cache.clear()`; (7) return `{"imported": len(actually_added), "skipped": skipped, "cap_reached": cap_remaining <= 0, "total": len(current) + len(actually_added)}`. | | |
| TASK-011 | Update `_fetch_subscribed_channels()` in `backend/youtube.py` to actually use the OAuth token when `_OAUTH_CONFIGURED` is true and a valid token file exists. Replace the Phase 3 stub body with: (1) `if not _OAUTH_CONFIGURED: return _load_channels(), "file"`; (2) `access_token = await _refresh_token_if_needed()` — if `None`, fall back to `_load_channels(), "file"`; (3) check `_subs_cache.get("subs")` — if fresh (< 3600s), return cached `channels, "oauth"`; (4) fetch one page (`maxResults=50`) from `subscriptions.list?mine=true&part=snippet&access_token={access_token}` — extract channel IDs; (5) store in `_subs_cache["subs"] = {"ts": time.time(), "channels": channels}`; (6) return `channels, "oauth"`. Note: this is a quick single-page fetch for the live feed (not a full import); full import is done via `POST /youtube/subscriptions/import`. | | |
| TASK-012 | Update `GET /youtube/auth-status` endpoint in `backend/youtube.py` to enrich the response: add `"token_exists": _TOKEN_PATH.exists()` (already present as `authenticated`), `"token_valid": bool(await _refresh_token_if_needed() is not None)` if `_OAUTH_CONFIGURED`, else `False`. This lets the frontend determine the precise state (configured+authenticated, configured+expired, configured+no_token, not_configured). | | |

---

### Implementation Phase 3 — Backend: Channel Keyword Search

- GOAL-003: Add `GET /youtube/search` to enable keyword-based channel discovery using the YouTube Data API v3.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-013 | Add `GET /youtube/search` endpoint in `backend/youtube.py` after the `POST /youtube/subscriptions/import` handler. Signature: `async def search_youtube_channels(q: str = Query(...))`. Handler: (1) `q = q.strip()`; (2) if `not q or len(q) > 100`, raise `HTTPException(400, "Search query must be 1–100 characters.")`; (3) if not `_API_CONFIGURED`, raise `HTTPException(503, "Channel search requires YOUTUBE_API_KEY to be configured in .env.")`; (4) `url = f"https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q={urllib.parse.quote(q)}&maxResults=15&key={YOUTUBE_API_KEY}"`; (5) `async with httpx.AsyncClient(timeout=10.0) as client: resp = await client.get(url)`; (6) if `resp.status_code != 200`, raise `HTTPException(502, "YouTube search API unavailable.")`; (7) parse `resp.json()["items"]` — for each item, validate `item["id"]["channelId"]` through `_CHANNEL_ID_RE`; build result `{"channel_id": item["id"]["channelId"], "name": item["snippet"]["title"][:100], "description": (item["snippet"].get("description") or "")[:200], "thumbnail_url": item["snippet"].get("thumbnails", {}).get("default", {}).get("url", "")}`; (8) return the filtered list. | | |

---

### Implementation Phase 4 — Frontend: Enhanced Resolve & Add Input

- GOAL-004: Replace the raw-channel-ID-only input in the YouTube settings view with a smart resolver that accepts handles, URLs, or channel IDs, shows a preview card, and requires explicit confirmation before adding.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-014 | In `frontend/youtube-panel.js`, update the placeholder text and title of `ytSettingsInput` by changing the initial value assignment after the element is wired in `initYouTubePanel`: `if (ytSettingsInput) { ytSettingsInput.placeholder = "@handle, channel URL, or UCxxxx ID"; ytSettingsInput.maxLength = 300; }`. The `id="yt-settings-input"` and the element itself remain unchanged — only the placeholder and maxlength change. | | |
| TASK-015 | In `frontend/youtube-panel.js`, replace the `_addChannel(rawValue)` function body with a two-step resolver. Step 1 — Resolve: (1) `const s = (rawValue || '').trim()`; (2) if empty, `_showSettingsError('Enter a channel handle, URL, or ID.')` and return; (3) `ytSettingsAddBtn.disabled = true; ytSettingsAddBtn.textContent = 'FINDING…'`; (4) `const res = await fetch('/youtube/channels/resolve', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ input: s }) })`; (5) if `!res.ok`: parse error detail, call `_showSettingsError(detail)`, reset button, return; (6) `const { channel_id, display_name } = await res.json()`; (7) call `_showChannelPreview(channel_id, display_name)` (new function, TASK-016); (8) reset `ytSettingsAddBtn.textContent = '+ ADD'`. | | |
| TASK-016 | Add `_showChannelPreview(channelId, displayName)` in `youtube-panel.js`. Builds a `<div class="yt-settings-preview-card" id="yt-settings-preview">` containing: `<div class="yt-settings-preview-name">{displayName || channelId}</div>`, `<div class="yt-settings-preview-id">{channelId}</div>`, `<div class="yt-settings-preview-actions">` with `<button class="yt-settings-add-btn" id="yt-preview-confirm">CONFIRM ADD</button>` and `<button class="yt-settings-back-btn" id="yt-preview-cancel">CANCEL</button>`. Removes any existing preview card first. Appends the card after the `yt-settings-add-row`. CONFIRM ADD click: (1) disable both buttons; (2) call the raw-add path: `POST /youtube/channels` with `{channel_id: channelId}`; (3) on success: remove preview card, clear input, call `_fetchAndRenderChannelList()`, call `_hardRefresh()`; (4) on error: show `_showSettingsError(detail)`. CANCEL click: remove the preview card. | | |

---

### Implementation Phase 5 — Frontend: Import From Google Account Section

- GOAL-005: Add an "IMPORT FROM YOUTUBE ACCOUNT" section to the YouTube Settings view that shows Google OAuth status, provides CONNECT and IMPORT buttons, and displays an inline import result.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-017 | In `frontend/youtube-panel.js`, add `_buildOAuthSection()` helper that returns a `<div class="yt-settings-section" id="yt-oauth-section">` containing: a `<div class="yt-settings-section-label">IMPORT FROM YOUTUBE ACCOUNT</div>`, a `<div class="yt-settings-oauth-status" id="yt-oauth-status">CHECKING…</div>`, a `<button class="yt-settings-import-btn" id="yt-oauth-connect-btn" disabled>CONNECT GOOGLE ACCOUNT</button>`, a `<button class="yt-settings-import-btn hidden" id="yt-oauth-import-btn">IMPORT SUBSCRIPTIONS</button>`, and a `<div class="yt-settings-import-result hidden" id="yt-oauth-result"></div>`. | | |
| TASK-018 | Inside `_buildOAuthSection()`, fire an async IIFE to call `GET /youtube/auth-status` after building the DOM. Logic: (1) `const st = await fetch('/youtube/auth-status').then(r => r.json())`; (2) if `!st.oauth_configured`: status text = `'OAUTH NOT CONFIGURED — add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to .env'`, both buttons remain disabled/hidden; (3) if `st.oauth_configured && !st.token_valid`: status text = `'CONNECTED — not yet authenticated'`, show `connectBtn`, hide `importBtn`; (4) if `st.oauth_configured && st.token_valid`: status text = `'CONNECTED & AUTHENTICATED ✓'`, hide `connectBtn`, show `importBtn`. Wire `connectBtn` click: `const res = await fetch('/youtube/auth').then(r => r.json()); if (res.auth_url) { openBrowserPanel(res.auth_url); }` — call `window._openBrowserPanel?.(res.auth_url)` as a safe global call since `openBrowserPanel` lives in `browser-panel.js`. Wire `importBtn` click: calls `_doOAuthImport()` (TASK-019). | | |
| TASK-019 | Add `async function _doOAuthImport()` in `youtube-panel.js`. Steps: (1) disable `importBtn`, set text to `'IMPORTING…'`; (2) `const res = await fetch('/youtube/subscriptions/import', { method: 'POST' })`; (3) if `!res.ok`: `_showSettingsError(body.detail ?? 'Import failed.')`, reset button text, re-enable; (4) if ok: `const body = await res.json(); oauthResult.textContent = \`${body.imported} channels imported, ${body.skipped} skipped${body.cap_reached ? ' (cap reached)' : ''}.\`; oauthResult.classList.remove('hidden')`; (5) `await _fetchAndRenderChannelList(); _hardRefresh()`; (6) reset button to `'IMPORT SUBSCRIPTIONS'`, re-enable. | | |
| TASK-020 | In `_showSettingsView()` in `youtube-panel.js`, after the existing `_fetchAndRenderChannelList()` call, append discovery sections to `ytSettingsView`. Use a guard pattern to avoid duplicate sections: call `ytSettingsView.querySelector('#yt-oauth-section')?.remove()` before calling `ytSettingsView.appendChild(_buildOAuthSection())`. Similarly for the search section (TASK-021). This ensures each section re-initialises its status check every time the settings view opens. | | |

---

### Implementation Phase 6 — Frontend: Channel Search Section

- GOAL-006: Add a channel keyword search section to the YouTube Settings view, shown only when the YouTube Data API key is configured, allowing the user to find channels by name and subscribe with one click.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-021 | In `frontend/youtube-panel.js`, add `_buildSearchSection()` helper returning a `<div class="yt-settings-section" id="yt-search-section">` containing: a `<div class="yt-settings-section-label">SEARCH CHANNELS</div>`, a `<div class="yt-settings-add-row">` with `<input class="yt-settings-input" id="yt-search-input" type="text" placeholder="search by channel name…" maxlength="100" spellcheck="false" autocomplete="off">` and `<button class="yt-settings-add-btn" id="yt-search-btn">SEARCH</button>`, and a `<div class="yt-settings-search-results hidden" id="yt-search-results"></div>`. | | |
| TASK-022 | Wire search logic inside `_buildSearchSection()`: (1) `const q = searchInput.value.trim()`; (2) if empty, `_showSettingsError('Enter a search term.')` and return; (3) `searchBtn.disabled = true; searchBtn.textContent = '…'`; (4) call `fetch(\`/youtube/search?q=\${encodeURIComponent(q)}\`)`; (5) on `!res.ok`: `_showSettingsError(body.detail ?? 'Search failed.')`, reset button; (6) on success: clear `searchResults.innerHTML`, remove `hidden`, render each result with `_createSearchResultRow(result)`; (7) reset button to `'SEARCH'` in `finally`. Wire to both `searchBtn.addEventListener('click', handler)` and `searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') handler(); })`. | | |
| TASK-023 | Implement `_createSearchResultRow(result)` in `youtube-panel.js`. Returns a `<div class="yt-settings-channel-row">` containing: `<div class="yt-settings-channel-name">{result.name}<span class="yt-settings-channel-meta">{result.channel_id}</span></div>` and `<button class="yt-settings-add-btn yt-search-add-btn">+ ADD</button>`. The `+ ADD` click handler: (1) `addBtn.disabled = true`; (2) call `fetch('/youtube/channels', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ channel_id: result.channel_id }) })`; (3) if `!res.ok`: `_showSettingsError(detail)`, `addBtn.disabled = false`; (4) if ok: `addBtn.textContent = '✓'`; call `_fetchAndRenderChannelList(); _hardRefresh()`. | | |
| TASK-024 | In `_showSettingsView()`, after appending the OAuth section (TASK-020), call `GET /youtube/auth-status` to check if `api_key_configured` is true. If true: `ytSettingsView.querySelector('#yt-search-section')?.remove(); ytSettingsView.appendChild(_buildSearchSection())`. If false: do not append the search section. Use `fetch('/youtube/auth-status').then(r => r.json()).then(st => { if (st.api_key_configured) { ... } }).catch(() => {})` — fire-and-forget so it does not block settings view opening. | | |

---

### Implementation Phase 7 — CSS: YouTube Settings Discovery Styles

- GOAL-007: Add CSS for the new discovery sections, preview card, and OAuth/search sub-elements to `frontend/style.css`, consistent with the `yt-settings-` class conventions.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-025 | In `frontend/style.css`, locate the `/* ── YouTube Settings View */` block added by the `feature-youtube-channel-settings-1.md` plan. After the last rule in that block, add: `.yt-settings-section` (`border-top: 1px solid rgba(200,200,200,0.07); padding-top: 14px; margin-top: 14px; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;`), `.yt-settings-section-label` (`font-family: 'Share Tech Mono', monospace; font-size: 8px; letter-spacing: 3px; color: rgba(200,200,200,0.28); text-transform: uppercase;`). | | |
| TASK-026 | Add: `.yt-settings-oauth-status` (`font-size: 10px; color: rgba(200,200,200,0.45); letter-spacing: 0.5px; font-family: 'Share Tech Mono', monospace;`), `.yt-settings-import-btn` (same base as `.yt-settings-add-btn` but `width: 100%; justify-content: center;`), `.yt-settings-import-result` (`font-size: 10px; color: rgba(200,200,200,0.6); letter-spacing: 0.5px; font-family: 'Share Tech Mono', monospace;`), `.yt-settings-channel-meta` (`font-size: 9px; color: rgba(200,200,200,0.3); margin-left: 8px; font-family: 'Share Tech Mono', monospace;`). | | |
| TASK-027 | Add: `.yt-settings-preview-card` (`border: 1px solid rgba(200,200,200,0.2); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; background: rgba(200,200,200,0.04); border-radius: 2px; flex-shrink: 0;`), `.yt-settings-preview-name` (`font-family: 'Share Tech Mono', monospace; font-size: 11px; color: var(--c); letter-spacing: 1px;`), `.yt-settings-preview-id` (`font-family: 'Share Tech Mono', monospace; font-size: 9px; color: rgba(200,200,200,0.35); word-break: break-all;`), `.yt-settings-preview-actions` (`display: flex; gap: 8px; margin-top: 4px;`), `.yt-settings-search-results` (`display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; flex-shrink: 0;`). | | |

---

## 3. Alternatives

- **ALT-001**: **`google-auth-oauthlib` library** — Use the official Google OAuth library instead of manually constructing OAuth2 requests with `httpx`. Rejected because it requires adding a new pip dependency (`google-auth-oauthlib`, `google-auth`, `google-api-python-client`), and the manual OAuth2 flow using `httpx` is straightforward for a personal tool that only needs access token + refresh token management. No new packages added (CON-004).
- **ALT-002**: **YouTube export via Google Takeout** — User exports their YouTube data from `myaccount.google.com/data-and-privacy/data-from-apps-and-services/connected-apps` and Starling parses the resulting JSON/HTML file. Rejected because the Takeout export format changes without notice, includes many irrelevant fields, and requires the user to manually download and import a file rather than using a one-click flow.
- **ALT-003**: **Scraping `youtube.com/feed/subscriptions`** — Fetch the authenticated YouTube subscriptions HTML page using stored cookies. Rejected because YouTube's cookie-based authentication is hostile to programmatic access and would violate YouTube's Terms of Service in the same way as credential scraping.
- **ALT-004**: **Channel search without API key** — Scrape `https://www.youtube.com/results?search_query={q}&sp=EgIQAg%3D%3D` (the channel search URL) for channel IDs. Rejected because parsing YouTube's dynamic HTML is fragile, rate-limited at 10+ req/min, and extracts less metadata than the API. The API key for Data API v3 is free and sufficient for this use case.
- **ALT-005**: **Handle resolution without a scraper** — Require users to always provide raw `UCxxxx` channel IDs (the current behaviour). Rejected because finding a YouTube channel ID from a channel name requires navigating to the channel's "About" page, a step that most non-technical users find confusing. The handle resolver makes channel addition substantially more user-friendly.
- **ALT-006**: **Raising the cap above 50** — Remove or greatly increase the channel cap. Rejected because YouTube's RSS feed is fetched in parallel via `asyncio.gather` with `run_in_executor` — each fetch takes 1–3 seconds, and the gather adds minimal overhead. However, with 100+ channels, total feed load time becomes user-perceptible, and the synthesised briefing becomes too long for a voice tool. 50 channels provides a practical balance between breadth and performance.

---

## 4. Dependencies

- **DEP-001**: `httpx` — already in `requirements.txt`; used for handle scraping, OAuth token exchange, subscriptions API calls, and channel search calls. No version change required.
- **DEP-002**: `secrets` (stdlib) — already available in Python 3.6+; used for CSRF state token generation in `GET /youtube/auth`.
- **DEP-003**: `urllib.parse` (stdlib) — already available; used for `urllib.parse.urlencode` in `GET /youtube/auth` and `urllib.parse.quote` in `GET /youtube/search`.
- **DEP-004**: `fastapi.responses.HTMLResponse` — already available via FastAPI; used for `GET /youtube/callback` response.
- **DEP-005**: Google Cloud Project with YouTube Data API v3 enabled — **required only for Phase 3 (channel search)** and Phase 2 enrichment (resolving display names after handle resolve). Free tier: 10,000 units/day. User must create an API key at `https://console.cloud.google.com/apis/credentials`.
- **DEP-006**: Google Cloud OAuth2 Credentials (Web Application type) — **required only for Phase 2 (subscription import)**. User must create a Web App OAuth client at `https://console.cloud.google.com/apis/credentials`, add `http://localhost:8000/youtube/callback` as an Authorized Redirect URI, and copy Client ID + Secret to `.env`.
- **DEP-007**: `backend/memory/youtube_token.json` — created at runtime by `GET /youtube/callback`. Must not be committed to version control. Must be excluded in `.gitignore` if not already covered by the `backend/memory/` glob pattern.

---

## 5. Files

- **FILE-001**: `backend/youtube.py` — Add `_CHANNEL_CAP`, `_resolve_handle_no_api()`, `_resolve_input_to_channel_id()`, `ChannelResolveRequest`, `_oauth_states`, `_load_token()`, `_save_token()`, `_refresh_token_if_needed()`. Add `POST /youtube/channels/resolve`, `GET /youtube/auth`, `GET /youtube/callback`, `POST /youtube/subscriptions/import`, `GET /youtube/search` endpoints. Update `_fetch_subscribed_channels()` to use real OAuth tokens. Update `GET /youtube/auth-status` to return `token_valid`. Update `POST /youtube/channels` to enforce `_CHANNEL_CAP`. Add `import secrets, urllib.parse` to imports. Add `from fastapi.responses import HTMLResponse` to imports.
- **FILE-002**: `frontend/youtube-panel.js` — Update `_addChannel()` to two-step resolve+confirm flow. Add `_showChannelPreview()`, `_buildOAuthSection()`, `_doOAuthImport()`, `_buildSearchSection()`, `_createSearchResultRow()`. Update `_showSettingsView()` to append discovery sections on open. Update `ytSettingsInput` placeholder in `initYouTubePanel`.
- **FILE-003**: `frontend/style.css` — Add `.yt-settings-section`, `.yt-settings-section-label`, `.yt-settings-oauth-status`, `.yt-settings-import-btn`, `.yt-settings-import-result`, `.yt-settings-channel-meta`, `.yt-settings-preview-card`, `.yt-settings-preview-name`, `.yt-settings-preview-id`, `.yt-settings-preview-actions`, `.yt-settings-search-results`.
- **FILE-004**: `backend/memory/youtube_token.json` — Created at runtime by `GET /youtube/callback`. Listed for awareness; no code change, but must be excluded from version control.

---

## 6. Testing

- **TEST-001**: Open YouTube settings, paste `https://www.youtube.com/@veritasium` into the input, click FIND. Verify the preview card shows the channel name (e.g. "Veritasium") and a valid `UCxxxx` channel ID, with CONFIRM ADD and CANCEL buttons.
- **TEST-002**: Click CONFIRM ADD on a resolved channel. Verify `POST /youtube/channels` is called with the resolved channel ID, the channel appears in the list, and the feed refreshes in the background.
- **TEST-003**: Paste a raw `UCxxxxxxxxxxxxxxxxxxxxxxxxx` ID directly into the input and click FIND. Verify it bypasses resolution and immediately shows the preview card with the channel ID (display name may be null if not yet in `_channel_name_map`).
- **TEST-004**: Paste an invalid string (`notachannel`) and click FIND. Verify the backend returns HTTP 422 and the inline error `"Could not resolve to a YouTube channel ID…"` appears without a network call to `POST /youtube/channels`.
- **TEST-005**: Open settings when `YOUTUBE_CLIENT_ID`/`YOUTUBE_CLIENT_SECRET` are absent from `.env`. Verify the IMPORT FROM YOUTUBE ACCOUNT section shows "OAUTH NOT CONFIGURED" and both buttons are disabled/hidden.
- **TEST-006**: With OAuth credentials configured and no token file present, open settings. Verify "CONNECT GOOGLE ACCOUNT" button is shown. Click it — verify `GET /youtube/auth` is called, `auth_url` is returned, and `openBrowserPanel` is invoked with the Google consent URL.
- **TEST-007**: Complete the Google OAuth consent flow in the browser panel. Verify: (a) the backend `GET /youtube/callback` receives `code` and `state`, validates state, exchanges code for token, saves `youtube_token.json`; (b) the browser panel shows the "authentication complete" HTML; (c) on next settings open, the status line updates to "CONNECTED & AUTHENTICATED ✓" and the IMPORT SUBSCRIPTIONS button appears.
- **TEST-008**: Click IMPORT SUBSCRIPTIONS with a valid token. Verify `POST /youtube/subscriptions/import` paginates through all subscription pages, adds new channels to `youtube_channels.json`, and returns `{imported, skipped, cap_reached}`. Verify the inline result shows correct counts.
- **TEST-009**: Import when already at the 50-channel cap. Verify `cap_reached: true` in the response and the result line shows "(cap reached)".
- **TEST-010**: Shutdown and restart Starling after importing channels via OAuth. Open the YouTube panel. Verify the persisted `youtube_channels.json` channels are loaded (not the `.env` fallback list).
- **TEST-011**: (Requires `YOUTUBE_API_KEY`) Open settings. Verify the SEARCH CHANNELS section is visible. Type "science" and click SEARCH. Verify `GET /youtube/search?q=science` is called and results render as rows with `+ ADD` buttons.
- **TEST-012**: Click `+ ADD` on a search result. Verify `POST /youtube/channels` is called with the correct `channel_id` and the channel appears in the list.
- **TEST-013**: (No `YOUTUBE_API_KEY` set) Open settings. Verify the SEARCH CHANNELS section is NOT rendered (entirely absent from the DOM).
- **TEST-014**: Attempt to add a 51st channel via any method. Verify HTTP 400 with `"Maximum of 50 channels allowed."` is returned and surfaced inline.
- **TEST-015**: `GET /youtube/auth-status` — Verify the response now includes `token_valid: bool` in addition to the existing `authenticated`, `oauth_configured`, and `api_key_configured` fields.

---

## 7. Risks & Assumptions

- **RISK-001**: YouTube may change its page structure, removing the `"channelId":"UCxxxx"` JSON field from embedded page data. The `_resolve_handle_no_api()` scraper will return `None` when this happens. Mitigation: the endpoint returns HTTP 422 with a clear error message guiding the user to paste the full channel URL or raw UC ID. The API-key path (`_resolve_handle_to_channel_id`) remains the primary resolver when `YOUTUBE_API_KEY` is set.
- **RISK-002**: The Google OAuth consent screen may block the callback if the GCP project is in "testing" mode and the authenticated user's email is not on the test user list. Mitigation: documented in the setup note (PAT-001). The error is surfaced via the `error` query parameter in `GET /youtube/callback`.
- **RISK-003**: YouTube Data API v3 quota exhaustion (10,000 units/day). Subscription import uses at most ~20 units (1 per page × 10 pages for 500 subs). Channel search uses 100 units per query. A user performing 100 searches in a day would exhaust the quota. Mitigation: search is user-initiated only; there is no background polling. Quota resets at midnight Pacific Time.
- **RISK-004**: `youtube_token.json` refresh tokens may be revoked by Google if the OAuth app has been inactive for 6+ months or if the user explicitly revokes access at `myaccount.google.com/permissions`. Mitigation: `_refresh_token_if_needed()` returns `None` on refresh failure, causing `POST /youtube/subscriptions/import` to return HTTP 401 with a prompt to reconnect via the CONNECT button.
- **RISK-005**: The Starling browser panel may not properly receive the self-closing `window.close()` HTML from `GET /youtube/callback`, leaving the tab open. Mitigation: the page also shows "You may close this tab." as plain text, so the user can close it manually. This is cosmetic only.
- **RISK-006**: YouTube rate-limits the RSS feed fetcher (`_parse_channel_feed`) independently of the Data API v3 quota. With 50 channels and the existing `_CACHE_SECONDS = 1800` (30-minute cache), the maximum fetch rate is 50 RSS requests per 30 minutes = 1.67 req/min — well within YouTube's undocumented but generous RSS rate limit.
- **ASSUMPTION-001**: `window._openBrowserPanel` or equivalent function is accessible from `youtube-panel.js` as a global or module export. Review `browser-panel.js` during implementation to confirm the exact call signature and adjust TASK-018 accordingly.
- **ASSUMPTION-002**: The existing `_OAUTH_CONFIGURED` boolean (line 110 of `youtube.py`) requires `YOUTUBE_API_KEY` in addition to the two OAuth credentials. This means Phase 2 (OAuth import) implicitly requires Phase 2 (Data API key). This is acceptable since the subscriptions API call also uses the API key for quota attribution. If this requirement is too strict, `_OAUTH_CONFIGURED` can be split into `_OAUTH_CONFIGURED = bool(YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET)` and `_FULL_OAUTH_CONFIGURED = bool(_OAUTH_CONFIGURED and YOUTUBE_API_KEY)`.
- **ASSUMPTION-003**: `backend/memory/` is writable by the FastAPI process — confirmed by the presence of `watchlist.json`, `ideas.json`, `weather_cache.json`, and `youtube_channels.json` in that directory.
- **ASSUMPTION-004**: `feedparser` is already in `requirements.txt` and handles YouTube's Atom feed format. This plan does not change the feed fetching mechanism.

---

## 8. Related Specifications / Further Reading

- [assets/archived/feature-youtube-channel-settings-1.md](../assets/archived/feature-youtube-channel-settings-1.md) — The preceding plan (fully implemented) that added the base Settings view (add/remove by channel ID). This plan builds directly on top of it.
- [assets/archived/feature-youtube-feed-1.md](../assets/archived/feature-youtube-feed-1.md) — The original YouTube feed panel plan (Phase 1 and 2 complete). Describes the Phase 3 OAuth stub that this plan now implements.
- [plan/feature-reddit-account-discovery-1.md](feature-reddit-account-discovery-1.md) — The parallel Reddit subreddit discovery plan, which follows the same structural pattern (PRAW import, keyword search, bulk paste).
- [YouTube Data API v3 — subscriptions.list](https://developers.google.com/youtube/v3/docs/subscriptions/list) — Reference for the subscription fetch used in `POST /youtube/subscriptions/import`.
- [YouTube Data API v3 — search.list (type=channel)](https://developers.google.com/youtube/v3/docs/search/list) — Reference for `GET /youtube/search`. Note: search costs 100 quota units per call.
- [YouTube Data API v3 — channels.list (forHandle)](https://developers.google.com/youtube/v3/docs/channels/list) — Reference for the handle-to-channel-ID resolution used by `_resolve_handle_to_channel_id()`.
- [Google OAuth2 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server) — Reference for the authorization code flow implemented in `GET /youtube/auth` and `GET /youtube/callback`.
