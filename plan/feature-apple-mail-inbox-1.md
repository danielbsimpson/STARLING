---
goal: Apple Mail Inbox Panel — IMAP-based unread email briefing with LLM summary, toolkit integration, and dream state injection
version: 1.0
date_created: 2026-05-27
last_updated: 2026-05-27
owner: Daniel Simpson
status: 'Planned'
tags: [feature, mail, imap, apple, toolkit, dream, prompt-library]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Adds a voice-triggered Apple Mail inbox panel that connects via IMAP to the user's iCloud Mail account using the **same Apple ID and App Password already stored in `backend/memory/calendar_credentials.json`** for CalDAV. The panel fetches the N most recent unread messages (subject line + sender only), renders them as a card list, injects a structured `llm_context` block into the LLM, and delivers a spoken briefing ("You have 5 unread emails from Sarah, GitHub, and Amazon"). The feature is fully registered in the toolkit menu, the prompt library, and the dream state pipeline. No new pip dependencies are required — the backend uses Python's stdlib `imaplib`, `email`, and `ssl` modules only.

---

## 1. Requirements & Constraints

- **REQ-001**: The backend IMAP fetch must use only Python stdlib modules (`imaplib`, `email`, `ssl`) — no new pip packages.
- **REQ-002**: Credential source at startup: read `backend/memory/calendar_credentials.json` (fields: `username`, `password`). The `username` field is the Apple ID email address; `password` is the App Password. These are the same credentials used by CalDAV.
- **REQ-003**: Apple iCloud IMAP server defaults: host `imap.mail.me.com`, port `993`, SSL/TLS. These defaults are overridable via env vars.
- **REQ-004**: Env var overrides for non-Apple accounts: `IMAP_HOST`, `IMAP_PORT`, `IMAP_USERNAME`, `IMAP_PASSWORD`. If any override is set, it takes precedence over `calendar_credentials.json`.
- **REQ-005**: Credential save/load must also support a dedicated `backend/memory/mail_credentials.json` file (same schema as `calendar_credentials.json`: `{ "username": "...", "password": "..." }`). If this file exists it takes priority over `calendar_credentials.json`, allowing separate credentials if desired in future.
- **REQ-006**: The IMAP fetch must return only `from_address`, `subject`, and `date` per message — no body text. This limits data exposure and keeps the LLM context payload small.
- **REQ-007**: Configurable max unread message count via env var `MAIL_MAX_UNREAD` (default `20`).
- **REQ-008**: In-memory server-side cache keyed by `(host, username)` with TTL controlled by env var `MAIL_CACHE_SECONDS` (default `300` — 5 minutes).
- **REQ-009**: Backend must expose endpoints: `GET /mail/unread`, `DELETE /mail/cache`, `GET /mail/credentials`, `POST /mail/credentials`, `DELETE /mail/credentials`.
- **REQ-010**: `GET /mail/unread` response must include a top-level `llm_context` string field formatted as `[MAIL DATA — N unread messages]\n- From: X | Subject: Y\n...` suitable for direct injection into the LLM system prompt context.
- **REQ-011**: The frontend panel must display each unread message as a card row showing sender name/address and subject line. Count badge must be shown in the panel header.
- **REQ-012**: Voice trigger detection must handle phrases like "check my email", "view inbox", "any new emails", "check mail", "do I have any messages", etc. Full regex set defined in TASK-010.
- **REQ-013**: On panel open, the frontend must log a session event of type `"mail_inbox_snapshot"` with the `llm_context` payload via `POST /log/event`. This causes the inbox state to be naturally included in dream state transcripts without modifying `dream.py`.
- **REQ-014**: `MAIL_INBOX_SUMMARY` prompt key must be added to `backend/prompts.py` with a default template that instructs the LLM to give a concise spoken briefing of the inbox, listing top senders and subjects.
- **REQ-015**: The mail tool must be registered as an entry in the toolkit panel registry in `frontend/app.js` with the same shape as existing entries (`{ id, name, description, phrases, openFn }`).
- **REQ-016**: The dispatch chain in `frontend/app.js` must check the mail trigger after calendar (priority 26, before browser-open at priority 25 — insert at priority 25.5, effectively between reddit-close and news).
- **REQ-017**: `toolkit/TRIGGER_PHRASES.md` must be updated with a Mail section documenting trigger phrase examples and dispatch priority.
- **SEC-001**: Credentials stored in `backend/memory/mail_credentials.json` must be excluded from version control. Verify `.gitignore` already covers `backend/memory/` or add an explicit entry.
- **SEC-002**: The `POST /mail/credentials` endpoint must only accept connections from localhost (mirror the pattern used by `dream_routes.py` — check `request.client.host` against `session_log.LOCALHOST_HOSTS`).
- **SEC-003**: The IMAP connection must use `imaplib.IMAP4_SSL` with `ssl.create_default_context()` — no plain-text fallback, no `check_hostname=False`.
- **SEC-004**: Credentials must never be returned in full by `GET /mail/credentials` — return only `{ "configured": true/false, "username": "user@icloud.com" }` (password masked).
- **CON-001**: No new pip packages. All IMAP communication uses stdlib `imaplib`, `email`, `ssl`.
- **CON-002**: IMAP connection is opened and closed within the scope of each `GET /mail/unread` request (no persistent idle connection). This avoids stale socket state across the async FastAPI server.
- **CON-003**: No email body is fetched or stored at any point. Only envelope headers (`BODY[HEADER.FIELDS (FROM SUBJECT DATE)]`) are retrieved via IMAP `FETCH`.
- **CON-004**: The panel is read-only — no delete, reply, or compose actions in v1.
- **GUD-001**: Follow the same credential loading pattern as `backend/calendar_routes.py`: env vars → dedicated JSON file → fallback to shared calendar credentials.
- **GUD-002**: Follow the same LLM context format as `calendar_routes.py`: a bracketed header line followed by a bulleted list, returned as the `llm_context` field in the JSON response.
- **GUD-003**: Follow the same panel JS module shape as `frontend/calendar-panel.js`: named exports `detectMailTrigger()`, `openMailPanel()`, `closeMailPanel()`.
- **PAT-001**: Register the FastAPI router in `backend/main.py` using `app.include_router(mail_router)` — same pattern as all other route modules.

---

## 2. Implementation Steps

### Implementation Phase 1 — Backend: `backend/mail_routes.py`

- GOAL-001: Create the IMAP mail fetching backend with credential reuse, cache, LLM context builder, and REST endpoints.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `backend/mail_routes.py`. Add module docstring declaring endpoints: `GET /mail/unread`, `DELETE /mail/cache`, `GET /mail/credentials`, `POST /mail/credentials`, `DELETE /mail/credentials`. | | |
| TASK-002 | In `mail_routes.py`, add config block: `_IMAP_HOST = os.getenv("IMAP_HOST", "imap.mail.me.com")`, `_IMAP_PORT = int(os.getenv("IMAP_PORT", "993"))`, `_IMAP_USER = os.getenv("IMAP_USERNAME", "")`, `_IMAP_PASS = os.getenv("IMAP_PASSWORD", "")`, `_MAX_UNREAD = int(os.getenv("MAIL_MAX_UNREAD", "20"))`, `_CACHE_SECS = int(os.getenv("MAIL_CACHE_SECONDS", "300"))`. Path constants: `_BASE_DIR = Path(__file__).parent`, `_MAIL_CRED_FILE = _BASE_DIR / "memory" / "mail_credentials.json"`, `_CAL_CRED_FILE = _BASE_DIR / "memory" / "calendar_credentials.json"`. | | |
| TASK-003 | Implement `_load_credentials() -> dict` in `mail_routes.py`: (1) Start with env var values as base. (2) If `_MAIL_CRED_FILE` exists, load and apply `username`/`password` fields. (3) Else if `_CAL_CRED_FILE` exists, load and apply same fields (credential reuse). Return merged dict `{"host": ..., "port": ..., "username": ..., "password": ...}`. Call at module import to populate module-level globals. | | |
| TASK-004 | Implement `_fetch_unread(host, port, username, password, max_count) -> list[dict]` in `mail_routes.py`. Open `imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context())`. Login with `username`/`password`. Select `INBOX`. Search `(UNSEEN)`. Sort UIDs descending, take first `max_count`. Fetch `BODY[HEADER.FIELDS (FROM SUBJECT DATE)]` for each UID. Parse each header block with `email.message_from_bytes()`. Extract: `from_address = msg["From"]`, `subject = str(email.header.make_header(email.header.decode_header(msg["Subject"] or "")))`, `date = msg["Date"]`. Return list of `{"from_address": ..., "subject": ..., "date": ...}` dicts. Always call `mail.logout()` in a `finally` block. | | |
| TASK-005 | Implement `_build_llm_context(messages: list[dict], unread_count: int) -> str` in `mail_routes.py`. Format: `"[MAIL DATA — {unread_count} unread message(s)]\n"` followed by one line per message: `"- From: {from_address} | Subject: {subject}"`. If `unread_count == 0`, return `"[MAIL DATA — Inbox is empty. No unread messages.]"`. | | |
| TASK-006 | Implement in-memory cache in `mail_routes.py`: `_cache: dict = {"ts": 0.0, "data": None}`. Add `_invalidate_cache()` function that sets `_cache["ts"] = 0.0`. In `GET /mail/unread` handler, check `time.time() - _cache["ts"] < _CACHE_SECS` — return cached data if valid, else call `_fetch_unread()`, update cache, and return fresh data. | | |
| TASK-007 | Implement `GET /mail/unread` endpoint in `mail_routes.py`. Load credentials via `_load_credentials()`. If `username` or `password` is empty, raise `HTTPException(status_code=503, detail="Mail credentials not configured.")`. Call `_fetch_unread()` (or return cache hit). Return JSON: `{"unread_count": N, "messages": [...], "llm_context": "..."}`. Wrap IMAP errors in `HTTPException(status_code=502, detail=str(exc))`. | | |
| TASK-008 | Implement `DELETE /mail/cache` endpoint in `mail_routes.py`. Calls `_invalidate_cache()` and returns `{"status": "cleared"}`. | | |
| TASK-009 | Implement `GET /mail/credentials`, `POST /mail/credentials`, `DELETE /mail/credentials` endpoints in `mail_routes.py`. `GET`: return `{"configured": bool, "username": username_or_empty_string}` — never return password. `POST`: accept Pydantic model `_MailCredentials(username: str, password: str)`, validate both non-empty, write `_MAIL_CRED_FILE` as JSON `{"username": ..., "password": ...}`, reload module globals, invalidate cache, return `{"status": "saved"}`. `POST` and `DELETE` must check `request.client.host in session_log.LOCALHOST_HOSTS` — raise `HTTPException(403)` otherwise. `DELETE`: remove `_MAIL_CRED_FILE` if exists, clear globals, invalidate cache. | | |

### Implementation Phase 2 — Backend Integration

- GOAL-002: Register the mail router in `main.py` and add the `MAIL_INBOX_SUMMARY` prompt to `prompts.py`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | In `backend/main.py`, add `from mail_routes import router as mail_router` after the existing router imports (line ~73 after `from calendar_routes import router as calendar_router`). Add `app.include_router(mail_router)` after `app.include_router(calendar_router)`. | | |
| TASK-011 | In `backend/prompts.py`, add a new registry entry to `_REGISTRY` list after the last calendar-related entry. Key: `"MAIL_INBOX_SUMMARY"`. Category: `"mail"`. Default value: `"You have received a briefing of the user's Apple Mail inbox. Summarise the unread messages in a natural spoken sentence. List the top senders by name if recognisable. Keep the response under 3 sentences. Do not read every subject line verbatim — give a thematic overview. Example: 'You have 8 unread emails. Most are from GitHub and Amazon. There is also a message from Sarah about the weekend plans.'"`. `template_vars: []`. `risk_level: "safe"`. `pipeline_note: "Injected as system prompt addendum when the mail panel opens and the inbox context is passed to the LLM."`. | | |

### Implementation Phase 3 — Frontend: `frontend/mail-panel.js`

- GOAL-003: Create the mail panel JavaScript module with trigger detection, fetch, render, and LLM context export following the `calendar-panel.js` pattern.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-012 | Create `frontend/mail-panel.js`. Add module docstring. Import `BACKEND_BASE` from `./config.js`. Declare DOM ref constants: `const mailPanel = document.getElementById('mail-panel')`, `const mailCountBadge = document.getElementById('mail-count-badge')`, `const mailList = document.getElementById('mail-list')`, `const mailCloseBtn = document.getElementById('mail-close-btn')`. Wire `mailCloseBtn?.addEventListener('click', closeMailPanel)`. | | |
| TASK-013 | Implement `export function detectMailTrigger(transcript)` in `mail-panel.js`. The function accepts a lowercase-trimmed transcript string and returns `true` if matched, else `null`. Regex patterns to match (apply `.test(t)` on each): (1) `/\b(?:check|view|show|open|read|pull up)\b.{0,20}\b(?:mail|email|emails?|inbox|messages?)\b/`, (2) `/\b(?:any|got any|do i have)\s+(?:new\s+)?(?:emails?|mail|messages?|unread)\b/`, (3) `/\b(?:what(?:'s| is) in my)\s+(?:inbox|mail|email)\b/`, (4) `/\b(?:new\s+)?(?:emails?|mail|messages?)\s+(?:today|this morning|right now)\b/`, (5) `/\b(?:unread|unopened)\s+(?:emails?|messages?|mail)\b/`. Return `patterns.some(p => p.test(t)) ? true : null`. | | |
| TASK-014 | Implement `_renderPanel(data)` private function in `mail-panel.js`. Set `mailCountBadge.textContent = data.unread_count`. Clear `mailList.innerHTML = ''`. For each message in `data.messages`, create a `<div class="mail-card">` containing: `<div class="mail-from">{from_address}</div>` and `<div class="mail-subject">{subject}</div>`. Append to `mailList`. If `data.messages.length === 0`, append `<div class="mail-empty">Inbox is empty.</div>`. | | |
| TASK-015 | Implement `export async function openMailPanel(forceRefresh = false)` in `mail-panel.js`. If `forceRefresh`, call `await fetch(\`${BACKEND_BASE}/mail/cache\`, { method: 'DELETE' })` wrapped in try/catch. Fetch `GET ${BACKEND_BASE}/mail/unread`. On error, `console.error` and return `null`. Call `_renderPanel(data)`. Remove class `hidden` from `mailPanel`. Scroll `mailPanel` into view. Return `data.llm_context ?? null`. | | |
| TASK-016 | Implement `export function closeMailPanel()` in `mail-panel.js`. Add class `hidden` to `mailPanel`. | | |
| TASK-017 | Implement `export function isMailPanelOpen()` in `mail-panel.js`. Return `mailPanel && !mailPanel.classList.contains('hidden')`. | | |

### Implementation Phase 4 — Frontend: HTML and CSS

- GOAL-004: Add mail panel markup to `frontend/index.html` and panel styles to `frontend/style.css`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-018 | In `frontend/index.html`, add the mail panel `<div>` immediately after the calendar panel `<div id="cal-panel" ...>` closing tag. Markup: `<div id="mail-panel" class="mail-panel hidden"> <div class="mail-panel-header"> <div class="mail-panel-title">INBOX <span class="mail-count-badge" id="mail-count-badge">0</span></div> <button class="mail-close-btn" id="mail-close-btn">&#x2715;</button> </div> <div class="mail-list" id="mail-list"></div> </div>`. Place within the same two-column body section as other panels. | | |
| TASK-019 | In `frontend/style.css`, add `.mail-panel` styles modelled after `.cal-panel` (same dark-glass aesthetic, border, padding). Add `.mail-panel-header` (flex row, title + close button). Add `.mail-count-badge` (small pill badge, accent colour). Add `.mail-card` (row with two lines: from + subject, monospace font, border-bottom separator). Add `.mail-from` (dim/secondary colour, font-size smaller). Add `.mail-subject` (primary colour, full width). Add `.mail-empty` (italic, centred, dim). | | |

### Implementation Phase 5 — Frontend: `app.js` Dispatch and Toolkit Integration

- GOAL-005: Import and wire the mail panel into the main dispatch chain, toolkit registry, and session event logger.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | In `frontend/app.js`, add import statement: `import { detectMailTrigger, openMailPanel, closeMailPanel, isMailPanelOpen } from './mail-panel.js';` — place after the `calendar-panel.js` import on the existing import block (around line 10). | | |
| TASK-021 | In `frontend/app.js`, locate the main `handleTranscript(transcript)` dispatch function (or equivalent). Add mail trigger check after the calendar trigger check and before the browser-open trigger check. Code: `const mailMatch = detectMailTrigger(t); if (mailMatch) { const ctx = await openMailPanel(); logEvent('mail_inbox_opened', { transcript: t }); if (ctx) { await sendToOllama(getPrompt('MAIL_INBOX_SUMMARY') + '\n\n' + ctx); } return; }` — adapt to the exact pattern used by the calendar block already present. | | |
| TASK-022 | In `frontend/app.js`, add mail close trigger check inside the "panel close" detection block (alongside the existing close checks for weather, youtube, reddit). Pattern: `if (isMailPanelOpen() && /\b(?:close|hide|dismiss|exit)\b.{0,15}\b(?:mail|email|inbox)\b/i.test(t)) { closeMailPanel(); return; }`. | | |
| TASK-023 | In `frontend/app.js`, add a mail entry to the toolkit registry array passed to `initToolkitPanel()`. Entry: `{ id: 'mail', name: 'Mail', description: 'Check Apple Mail inbox — view unread emails and get a spoken summary.', phrases: ['check my email', 'view inbox', 'any new emails', 'check mail', 'unread messages'], openFn: async () => { const ctx = await openMailPanel(true); if (ctx) await sendToOllama(getPrompt('MAIL_INBOX_SUMMARY') + '\n\n' + ctx); } }`. Place after the calendar entry in the registry array. | | |
| TASK-024 | In `frontend/app.js`, add a `logEvent('mail_inbox_snapshot', { llm_context: ctx })` call inside `openMailPanel()` after a successful fetch — OR wire it in the dispatch handler in TASK-021 so the snapshot is logged whenever the panel opens (from either voice or toolkit). Confirm the event type `"mail_inbox_snapshot"` is distinct so dream state transcript parsing can identify it. | | |

### Implementation Phase 6 — Toolkit Trigger Phrases Documentation

- GOAL-006: Update `toolkit/TRIGGER_PHRASES.md` with the mail tool's trigger phrase section and updated dispatch priority table.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-025 | In `toolkit/TRIGGER_PHRASES.md`, update the **Dispatch Priority Order** table: insert a new row for Mail between existing row 24 (News) and row 25 (Browser — open). Assign priority `24.5` or renumber subsequent rows as 25→26, 26→27, 27→28. New row: `24.5 \| Mail inbox \| Checked before Browser — specific domain vocabulary`. | | |
| TASK-026 | In `toolkit/TRIGGER_PHRASES.md`, add a new section `## N · Mail (Apple Mail Inbox)` after the News section. Document: trigger phrases (open, check, view, any new), example table showing phrase → result (e.g., `check my email` → opens mail panel with spoken summary), close phrases (`close mail`, `dismiss inbox`). | | |

### Implementation Phase 7 — Security: `.gitignore` Verification

- GOAL-007: Ensure `backend/memory/mail_credentials.json` is excluded from version control.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-027 | Open `.gitignore` at workspace root. Verify that `backend/memory/` or `backend/memory/*.json` is already listed. If not, add `backend/memory/mail_credentials.json` explicitly (or `backend/memory/` as a directory rule) and commit the `.gitignore` change. | | |

---

## 3. Alternatives

- **ALT-001**: **Use Google Gmail API with OAuth2** (as described in `plan/GMAIL.md`). Not chosen for this plan because the user's primary mail is Apple Mail / iCloud. However, the GMAIL.md plan remains valid as a parallel feature for a Gmail account. The two plans are independent and non-conflicting.
- **ALT-002**: **Use `imaplib` with a persistent idle connection and server-push events**. Rejected for v1 because FastAPI's async model does not pair cleanly with a blocking IMAP IDLE loop without a dedicated background thread. A per-request open/close is simpler and reliable. Persistent IDLE connection could be added in v2.
- **ALT-003**: **Use the `imapclient` pip package instead of stdlib `imaplib`**. Rejected because CON-001 forbids new pip packages. `imaplib` is sufficient for `UNSEEN` search and `FETCH` of envelope headers.
- **ALT-004**: **Reuse the CalDAV `caldav` package to proxy credentials via a separate iCloud keychain integration**. Not applicable — CalDAV credentials are for calendar only; email access requires IMAP, which is a different protocol. The credentials (Apple ID + App Password) are the same, but the access method differs.
- **ALT-005**: **Store credentials in `.env` only**. Rejected in favour of `memory/mail_credentials.json` because the toolkit's credential management UI (used by calendar) writes to a JSON file, not to `.env`. Consistency with the calendar pattern is preferred.

---

## 4. Dependencies

- **DEP-001**: `imaplib` — Python stdlib (no install required). Used for IMAP4_SSL connection, login, SEARCH, FETCH.
- **DEP-002**: `email` — Python stdlib. Used for `email.message_from_bytes()` and `email.header.decode_header()` / `make_header()`.
- **DEP-003**: `ssl` — Python stdlib. Used for `ssl.create_default_context()` to enforce TLS certificate validation.
- **DEP-004**: `backend/memory/calendar_credentials.json` — Must exist and contain `username` (Apple ID email) and `password` (App Password) fields. This file is created when the user configures the calendar integration. If absent, the mail panel will show a 503 error until credentials are configured via `POST /mail/credentials`.
- **DEP-005**: `backend/session_log.py` — `LOCALHOST_HOSTS` constant used to gate credential write/delete endpoints. Already present in the project.
- **DEP-006**: `backend/prompts.py` — Must be updated with `MAIL_INBOX_SUMMARY` key before Phase 5 frontend work runs (TASK-021 calls `getPrompt('MAIL_INBOX_SUMMARY')`).
- **DEP-007**: iCloud IMAP access enabled — The user must have IMAP access enabled in their iCloud settings (Settings → [Apple ID] → iCloud → Mail must be toggled on). The App Password must have been generated at appleid.apple.com.

---

## 5. Files

- **FILE-001**: `backend/mail_routes.py` — **New file.** FastAPI router. IMAP fetch logic, credential loading, LLM context builder, in-memory cache, REST endpoints.
- **FILE-002**: `backend/main.py` — **Modified.** Add `from mail_routes import router as mail_router` and `app.include_router(mail_router)`.
- **FILE-003**: `backend/prompts.py` — **Modified.** Add `MAIL_INBOX_SUMMARY` entry to `_REGISTRY` list.
- **FILE-004**: `backend/memory/mail_credentials.json` — **Runtime-generated file** (not committed). Created by `POST /mail/credentials` or manually. Schema: `{"username": "user@icloud.com", "password": "xxxx-xxxx-xxxx-xxxx"}`.
- **FILE-005**: `frontend/mail-panel.js` — **New file.** Panel JS module: trigger detection, fetch, render, open/close exports.
- **FILE-006**: `frontend/index.html` — **Modified.** Add `<div id="mail-panel" ...>` markup after the `#cal-panel` div.
- **FILE-007**: `frontend/style.css` — **Modified.** Add `.mail-panel`, `.mail-panel-header`, `.mail-count-badge`, `.mail-card`, `.mail-from`, `.mail-subject`, `.mail-empty` style rules.
- **FILE-008**: `frontend/app.js` — **Modified.** Add import of `mail-panel.js`, mail trigger check in dispatch chain, mail close check, mail entry in toolkit registry, session event log call.
- **FILE-009**: `toolkit/TRIGGER_PHRASES.md` — **Modified.** Update dispatch priority table; add Mail section with example phrases.
- **FILE-010**: `.gitignore` — **Conditionally modified.** Ensure `backend/memory/mail_credentials.json` is excluded.

---

## 6. Testing

- **TEST-001**: `GET /mail/unread` returns `200` with `unread_count`, `messages` array, and `llm_context` string when valid credentials are present in `backend/memory/calendar_credentials.json`.
- **TEST-002**: `GET /mail/unread` returns `503` with detail `"Mail credentials not configured."` when both `calendar_credentials.json` and `mail_credentials.json` are absent and no env var overrides are set.
- **TEST-003**: `DELETE /mail/cache` returns `{"status": "cleared"}` and the next `GET /mail/unread` call makes a fresh IMAP connection (verify via log timestamp or cache `ts` reset to `0.0`).
- **TEST-004**: `GET /mail/credentials` returns `{"configured": true, "username": "user@icloud.com"}` — password field must be absent from the response.
- **TEST-005**: `POST /mail/credentials` from localhost with `{"username": "test@icloud.com", "password": "test-pass"}` writes `backend/memory/mail_credentials.json` and returns `{"status": "saved"}`.
- **TEST-006**: `POST /mail/credentials` from a non-localhost IP (simulate by patching `request.client.host`) returns `403 Forbidden`.
- **TEST-007**: Voice phrase `"check my email"` triggers `detectMailTrigger()` to return `true`.
- **TEST-008**: Voice phrase `"check my calendar"` does NOT trigger `detectMailTrigger()` (returns `null`) — verify no cross-trigger with calendar patterns.
- **TEST-009**: Mail panel opens in the browser, renders message cards with `from_address` and `subject`, and displays the correct unread count in the badge.
- **TEST-010**: `logEvent('mail_inbox_snapshot', {...})` is called with the `llm_context` string when the panel opens. Verify via `GET /log/session` that the event appears in the session log.
- **TEST-011**: After a dream state run (`POST /dream/run`), verify the dream summary includes reference to the inbox state (sourced from the `mail_inbox_snapshot` session log event).
- **TEST-012**: Toolkit menu (`openToolkitPanel()`) shows a "Mail" entry. Clicking/selecting it opens the mail panel and triggers the LLM briefing.
- **TEST-013**: Second `GET /mail/unread` call within `MAIL_CACHE_SECONDS` returns same data without opening a new IMAP connection (verify `_cache["ts"]` is unchanged).
- **TEST-014**: IMAP fetch with an incorrect App Password returns `502` with an IMAP authentication error detail string, not a 500 stack trace.

---

## 7. Risks & Assumptions

- **RISK-001**: Apple may throttle or block IMAP connections from non-macOS clients if the App Password was not generated with IMAP scope. Mitigation: the user must generate the App Password at `appleid.apple.com` under "App-Specific Passwords" with the scope set to Mail.
- **RISK-002**: iCloud IMAP occasionally returns non-standard or malformed `From`/`Subject` headers for system-generated messages (e.g., automated receipts with RFC2047 encoded-word subjects). Mitigation: TASK-004 uses `email.header.make_header(email.header.decode_header(...))` which handles RFC2047 encoded words gracefully.
- **RISK-003**: Very large inboxes (thousands of unread messages) could make the IMAP `SEARCH UNSEEN` command slow. Mitigation: `_MAX_UNREAD` caps the UID slice at 20 messages by default; only the first N UIDs are FETCHed.
- **RISK-004**: The App Password used for CalDAV calendar may not grant IMAP access if the user scoped it to CalDAV only. Mitigation: documented in TASK-009's credential save flow — if the shared calendar credentials fail IMAP auth (502 response), the user is guided to supply a separate App Password via `POST /mail/credentials`.
- **RISK-005**: `imaplib.IMAP4_SSL` is synchronous/blocking. Running it inside a FastAPI `async` endpoint will block the event loop. Mitigation: wrap the `_fetch_unread()` call in `await asyncio.get_event_loop().run_in_executor(None, _fetch_unread, ...)` or use `fastapi.BackgroundTasks`-style executor. Add this pattern in TASK-004 and TASK-007.
- **ASSUMPTION-001**: The user's Apple iCloud Mail inbox is reachable at `imap.mail.me.com:993` (standard iCloud IMAP endpoint). This is Apple's documented IMAP server for iCloud Mail accounts.
- **ASSUMPTION-002**: The `backend/memory/calendar_credentials.json` file exists and contains valid `username` and `password` fields because the calendar feature has already been configured.
- **ASSUMPTION-003**: The frontend `getPrompt('MAIL_INBOX_SUMMARY')` function call in `app.js` follows the same pattern as existing prompt retrieval (e.g., `getPrompt('STARLING_PERSONA')`), which is already implemented in `frontend/prompts.js`.
- **ASSUMPTION-004**: Dream state transcript parsing treats `"mail_inbox_snapshot"` session log events the same as any other logged event — the `llm_context` string is included in the transcript body for Pass 1 (summarizer). No changes to `dream.py` are required.

---

## 8. Related Specifications / Further Reading

- [plan/GMAIL.md](GMAIL.md) — Parallel Gmail integration guide using Google OAuth2. Independent of this plan; can coexist.
- [backend/calendar_routes.py](../backend/calendar_routes.py) — CalDAV calendar integration. Credential loading pattern (`_load_stored_credentials`, `_apply_credentials`) is the direct template for `mail_routes.py`.
- [frontend/calendar-panel.js](../frontend/calendar-panel.js) — Calendar panel JS module. Module shape (`detectCalendarTrigger`, `openCalendarPanel`, `closeCalendarPanel`) is the direct template for `mail-panel.js`.
- [backend/prompts.py](../backend/prompts.py) — Prompt registry. `MAIL_INBOX_SUMMARY` must be added here (TASK-011).
- [backend/dream.py](../backend/dream.py) — Dream state pipeline. Inbox context is injected passively via session log (TASK-024) without modifying this file.
- [toolkit/TRIGGER_PHRASES.md](../toolkit/TRIGGER_PHRASES.md) — Dispatch priority reference. Must be updated in TASK-025 and TASK-026.
- [Apple iCloud IMAP documentation](https://support.apple.com/en-us/102525) — Official Apple iCloud Mail server settings (`imap.mail.me.com`, port 993).
- [Python imaplib documentation](https://docs.python.org/3/library/imaplib.html) — stdlib IMAP4 client.
