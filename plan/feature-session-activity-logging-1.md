---
goal: Full Session Activity Logging for Interactions and Toolkit Calls
version: '1.0'
date_created: 2026-05-19
last_updated: 2026-05-19
owner: simps
status: 'Complete'
tags: [feature, logging, debugging, observability, session, toolkit]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Every user utterance, STT transcription, tool dispatch decision, toolkit call, LLM request, LLM response, and system event that occurs while S.T.A.R.L.I.N.G. is running must be recorded to a structured, timestamped log file. One JSONL file is written per active session (bounded by `make up` / `make down`). Logs are stored in `backend/memory/logs/` and are queryable via new read-only API endpoints. The goal is to enable complete post-session debugging and to serve as a ground-truth corpus for future system enhancements.

## 1. Requirements & Constraints

- **REQ-001**: Every event must carry an ISO 8601 UTC timestamp (`ts`) accurate to the millisecond.
- **REQ-002**: Every event must carry a `session_id` string matching the log file it was written to (format: `session_YYYY-MM-DD_HH-MM-SS`).
- **REQ-003**: Events must be written in JSONL format (one JSON object per line) to `backend/memory/logs/<session_id>.jsonl`.
- **REQ-004**: The following event types must be captured with their associated payload fields:
  - `session_start` — `{version, llm_backend, pid}`
  - `session_end` — `{duration_s, total_events}`
  - `user_speech` — `{transcript, duration_ms, whisper_model, device}` (from `/transcribe`)
  - `user_text` — `{text}` (text typed directly in the frontend)
  - `tool_dispatch` — `{tool, trigger_phrase, input_text}` (frontend dispatch decision)
  - `tool_call` — `{endpoint, method, params_summary}` (backend route entry)
  - `tool_result` — `{endpoint, status_code, duration_ms, result_summary}` (backend route exit)
  - `llm_request` — `{model, message_count, system_prompt_hash, temperature}`
  - `llm_response` — `{model, full_text, token_count_estimate, duration_ms}`
  - `error` — `{source, message, traceback_summary}`
- **REQ-005**: The log file for the current session must be flushed to disk immediately after each event (no buffering) so data is not lost on crash.
- **REQ-006**: A `GET /log/sessions` endpoint must list all session log files (id, start time, size, event count).
- **REQ-007**: A `GET /log/sessions/{session_id}` endpoint must return the full JSONL content of the requested session.
- **REQ-008**: A `POST /log/event` endpoint must accept frontend-originated events (`tool_dispatch`, `user_text`) and write them to the current session log.
- **SEC-001**: Log files must never contain raw audio bytes or full binary payloads — only text transcripts, endpoint names, and summarised payloads.
- **SEC-002**: The `/log/` endpoints must only be accessible from `localhost` (bind check via request host header). They must never be exposed to external networks.
- **CON-001**: Must not require any new Python packages. Uses only stdlib: `json`, `pathlib`, `datetime`, `threading`, `hashlib`, `os`, `traceback`.
- **CON-002**: Must not add measurable latency to the hot path (STT → dispatch → LLM → TTS). All log writes are synchronous but use a `threading.Lock` to prevent interleaving; file I/O for a single JSONL line is sub-millisecond.
- **CON-003**: Must not modify the streaming LLM response path (`_stream_ollama`, `_stream_as_ndjson`). LLM response logging is done by accumulating the full assembled text in a post-stream callback, not by intercepting the stream.
- **GUD-001**: The session logger is implemented as a module-level singleton (`backend/session_log.py`) imported by all route modules. This avoids FastAPI dependency injection complexity for a write-only logging concern.
- **GUD-002**: `result_summary` for tool results must be a truncated string (max 500 chars) of the serialised response body to avoid bloating the log with e.g. full news article HTML.
- **PAT-001**: Follow the existing pattern of module-level constants loaded from `os.getenv()` with sensible defaults, as seen in `weather.py`, `ollama.py`, and `llama_server.py`.

## 2. Implementation Steps

### Implementation Phase 1 — Core Session Logger Module

- GOAL-001: Create `backend/session_log.py` — a thread-safe, module-level singleton that manages the current session's JSONL log file. All other modules import from this file to write events.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `backend/session_log.py`. Define `LOG_DIR = Path(os.getenv("SESSION_LOG_DIR", "memory/logs"))`. Call `LOG_DIR.mkdir(parents=True, exist_ok=True)` at module load time. | | |
| TASK-002 | In `session_log.py`, define `_session_id: str` and `_log_path: Path` as module globals. Generate `_session_id` as `"session_" + datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")` at module import time. Set `_log_path = LOG_DIR / f"{_session_id}.jsonl"`. | | |
| TASK-003 | In `session_log.py`, define `_lock = threading.Lock()` and `_event_count: int = 0` as module globals. | | |
| TASK-004 | In `session_log.py`, implement `def log(event_type: str, data: dict, source: str = "backend") -> None`. Function must: (1) build record `{"ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), "session": _session_id, "source": source, "event": event_type, "data": data}`, (2) acquire `_lock`, (3) append `json.dumps(record) + "\n"` to `_log_path` with `open(_log_path, "a", encoding="utf-8")`, (4) increment `_event_count`, (5) release lock. Never raise — wrap body in `try/except Exception` and print to stderr on failure. | | |
| TASK-005 | In `session_log.py`, implement `def log_session_start(llm_backend: str, pid: int) -> None` that calls `log("session_start", {"version": "1.0", "llm_backend": llm_backend, "pid": pid})`. | | |
| TASK-006 | In `session_log.py`, implement `def log_session_end() -> None` that calls `log("session_end", {"total_events": _event_count})`. Note: `duration_s` is not tracked here because session end is called during shutdown where start time is not accessible; omit or compute if start timestamp is stored as a module global `_session_start: float = time.monotonic()`. | | |
| TASK-007 | In `session_log.py`, expose `get_session_id() -> str` and `get_log_path() -> Path` as public accessors. | | |

### Implementation Phase 2 — Backend Route Instrumentation

- GOAL-002: Instrument all existing backend route modules to emit `tool_call`, `tool_result`, `user_speech`, `llm_request`, and `llm_response` events using the singleton logger.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | In `backend/stt.py`: import `session_log`. In the `POST /transcribe/` handler, after a successful transcription, call `session_log.log("user_speech", {"transcript": transcript, "whisper_model": _WHISPER_MODEL_SIZE, "device": _active_device})`. | | |
| TASK-009 | In `backend/ollama.py`: import `session_log` and `hashlib`. At the top of the `chat()` handler (before streaming), call `session_log.log("llm_request", {"model": req.model, "message_count": len(req.messages), "system_prompt_hash": hashlib.md5(SYSTEM_PROMPT.encode()).hexdigest()[:8], "temperature": req.temperature})`. | | |
| TASK-010 | In `backend/ollama.py`: wrap `_stream_ollama` to accumulate the full response text. After the stream completes (in a post-stream wrapper around `StreamingResponse`), call `session_log.log("llm_response", {"model": req.model, "full_text": assembled_text, "token_count_estimate": len(assembled_text.split()), "duration_ms": elapsed_ms})`. Implementation: use a generator wrapper that accumulates NDJSON chunks, extracts `message.content` from each, and calls `log` after the last `done: true` line. | | |
| TASK-011 | In `backend/llama_server.py`: mirror TASK-009 and TASK-010 for the llama backend. Call `session_log.log("llm_request", ...)` at `chat()` entry and log `llm_response` after the stream's `done` sentinel is emitted by `_stream_as_ndjson`. | | |
| TASK-012 | In `backend/weather.py`: import `session_log`. At the entry point of the `GET /weather` handler, call `session_log.log("tool_call", {"endpoint": "/weather", "method": "GET", "params_summary": f"location={location}"})`. After response is built, call `session_log.log("tool_result", {"endpoint": "/weather", "status_code": 200, "duration_ms": elapsed_ms, "result_summary": f"condition={condition}, temp={temp}"})`. | | |
| TASK-013 | In `backend/news.py`: import `session_log`. Log `tool_call` on handler entry and `tool_result` on exit with `result_summary` = first headline truncated to 100 chars + total article count. | | |
| TASK-014 | In `backend/stocks.py`: import `session_log`. Log `tool_call` on handler entry and `tool_result` on exit with `result_summary` = list of ticker symbols returned. | | |
| TASK-015 | In `backend/browser.py`: import `session_log`. Log `tool_call` on handler entry for all browser endpoints (`/api/browser/open`, `/api/browser/close`, `/api/browser/navigate`). Include `url` in `params_summary`. Log `tool_result` on exit. | | |
| TASK-016 | In `backend/ideas_routes.py`: import `session_log`. Log `tool_call` / `tool_result` for POST (capture idea) and GET (read ideas) endpoints. `params_summary` for POST = first 80 chars of idea text. | | |
| TASK-017 | In `backend/journal_routes.py`: import `session_log`. Log `tool_call` / `tool_result` for all journal endpoints. `params_summary` = journal action type (start/submit/read/search). | | |
| TASK-018 | In `backend/main.py`: in `startup_event()`, call `session_log.log_session_start(llm_backend=LLM_BACKEND, pid=os.getpid())`. Register a FastAPI `shutdown` event handler (`@app.on_event("shutdown")`) that calls `session_log.log_session_end()`. | | |

### Implementation Phase 3 — Log API Endpoints

- GOAL-003: Expose read-only API endpoints so the session log can be inspected without leaving the browser, and so the frontend can push its own events.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-019 | Create `backend/log_routes.py`. Define `router = APIRouter(prefix="/log", tags=["log"])`. Import `session_log`, `Path`, `json`. | | |
| TASK-020 | In `log_routes.py`, implement `GET /log/sessions` — scans `session_log.LOG_DIR` for `*.jsonl` files, returns a JSON array of `{"session_id", "start_time", "size_bytes", "event_count"}` objects sorted newest-first. `event_count` = number of lines in file. | | |
| TASK-021 | In `log_routes.py`, implement `GET /log/sessions/{session_id}` — validates that `session_id` matches the pattern `^session_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$` (reject path traversal). Returns the raw JSONL file content as `text/plain`. Returns 404 if not found. | | |
| TASK-022 | In `log_routes.py`, define a `FrontendEvent` Pydantic model: `{event_type: str, data: dict, source: str = "frontend"}`. Implement `POST /log/event` — validates `event_type` is one of `{"tool_dispatch", "user_text", "error"}` (allowlist), then calls `session_log.log(event_type, data, source="frontend")`. Returns `{"ok": true, "session": session_id}`. | | |
| TASK-023 | In `log_routes.py`, add a localhost guard to `GET /log/sessions` and `GET /log/sessions/{session_id}`: check `request.client.host in ("127.0.0.1", "::1", "localhost")`. Return HTTP 403 if the request originates from outside localhost. | | |
| TASK-024 | In `backend/main.py`, import `log_routes` and call `app.include_router(log_routes.router)`. | | |

### Implementation Phase 4 — Frontend Event Emission

- GOAL-004: Instrument `frontend/app.js` to push `tool_dispatch` and `user_text` events to `POST /log/event` whenever the dispatch chain resolves a tool or sends text to the LLM.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-025 | In `frontend/app.js`, define a helper function `logEvent(eventType, data)` that calls `fetch(\`${BACKEND_BASE}/log/event\`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({event_type: eventType, data, source: "frontend"})})`. Fire-and-forget (no `await`, no error propagation into the main dispatch path). | | |
| TASK-026 | In `frontend/app.js`, in the STT result handler (where `transcript` is received from `/transcribe`), call `logEvent("user_speech_frontend", {transcript})` immediately after the transcript is available. This serves as a frontend-side cross-reference to the backend STT log entry. | | |
| TASK-027 | In `frontend/app.js`, at each point in the dispatch chain where a specific tool is resolved (weather trigger, news trigger, market trigger, timer trigger, wiki trigger, journal trigger, ideas trigger, dossier trigger, LLM fallback), call `logEvent("tool_dispatch", {tool: "<tool_name>", trigger_phrase: transcript})`. The `tool` value must be one of: `"weather"`, `"news"`, `"stocks"`, `"timer"`, `"date"`, `"time"`, `"wiki"`, `"journal"`, `"ideas"`, `"dossier"`, `"browser"`, `"llm_fallback"`. | | |
| TASK-028 | In `frontend/app.js`, if the user submits text input directly (non-voice), call `logEvent("user_text", {text: inputValue})` before dispatching. | | |

### Implementation Phase 5 — Log Viewer Page

- GOAL-005: Add a minimal `GET /log/viewer` HTML page served by FastAPI that lists sessions and renders the selected session's JSONL log in a human-readable table, for use during debugging.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-029 | In `log_routes.py`, add `GET /log/viewer` that returns an inline HTML page (Python f-string or `HTMLResponse`). The page fetches `/log/sessions` via `fetch()`, lists sessions in a `<select>` dropdown, and on selection fetches `/log/sessions/{id}` and renders each JSONL line as a table row with columns: `ts`, `source`, `event`, `data` (JSON-formatted). Style with minimal inline CSS — dark background, monospace font, colour-coded rows by event type. | | |
| TASK-030 | Add a link to the log viewer in the `GET /health` response: `{"status": "ok", "log_viewer": "/log/viewer", "current_session": session_id}`. | | |

### Implementation Phase 6 — .gitignore Update

- GOAL-006: Ensure log files are never accidentally committed to the repository.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-031 | Add the following lines to `.gitignore` (create file if it does not exist): `backend/memory/logs/` and `backend/memory/.starling.pid`. | | |

## 3. Alternatives

- **ALT-001**: **Python `logging` module with `FileHandler`** — the stdlib logging framework supports file output, log levels, and formatters out of the box. Rejected because it writes human-readable lines by default (not machine-parseable JSONL), requires configuring a custom JSON formatter, and the `logging` module's thread-safety model (global lock on `StreamHandler`) can serialize unrelated modules. A purpose-built JSONL appender is simpler and produces cleaner output.
- **ALT-002**: **FastAPI middleware (`BaseHTTPMiddleware`)** for automatic request/response logging — would capture all requests and responses without modifying individual route files. Rejected because: (a) `BaseHTTPMiddleware` does not support streaming responses cleanly (body consumption breaks `StreamingResponse`), and (b) it would require reconstructing LLM response text from raw bytes, which is more fragile than logging in the route handler where the data is already structured.
- **ALT-003**: **SQLite database for log storage** — structured queries, easy to search, well-supported. Rejected because the project already uses ChromaDB for RAG and a SQLite log store would be a second SQLite file. JSONL files are simpler, human-readable without tooling, easy to `grep`, and trivially imported into pandas for analysis.
- **ALT-004**: **Loguru** (third-party library) — excellent structured logging with JSON serialisation built in. Rejected per CON-001 (no new packages). Could be revisited if `requirements.txt` constraints are relaxed.
- **ALT-005**: **OpenTelemetry tracing** — industry-standard distributed tracing with spans and traces. Rejected as significant over-engineering for a single-process local application.

## 4. Dependencies

- **DEP-001**: `json` (stdlib) — JSONL serialisation.
- **DEP-002**: `pathlib.Path` (stdlib) — log directory and file management.
- **DEP-003**: `threading.Lock` (stdlib) — thread-safe concurrent writes from async FastAPI handlers running in threads.
- **DEP-004**: `datetime` / `timezone` (stdlib) — ISO 8601 UTC timestamps.
- **DEP-005**: `hashlib` (stdlib) — system prompt fingerprinting for `llm_request` events (MD5 used only for a short non-security-sensitive identifier).
- **DEP-006**: `time.monotonic()` (stdlib) — elapsed time measurement for `duration_ms` fields.

## 5. Files

- **FILE-001**: `backend/session_log.py` — **new file**. Thread-safe JSONL logger singleton.
- **FILE-002**: `backend/log_routes.py` — **new file**. FastAPI router for `/log/sessions`, `/log/sessions/{id}`, `/log/event`, `/log/viewer`.
- **FILE-003**: `backend/main.py` — **modified**. Import and register `log_routes.router`; call `log_session_start()` in startup event and `log_session_end()` in shutdown event.
- **FILE-004**: `backend/stt.py` — **modified**. Emit `user_speech` log event after successful transcription.
- **FILE-005**: `backend/ollama.py` — **modified**. Emit `llm_request` and `llm_response` log events.
- **FILE-006**: `backend/llama_server.py` — **modified**. Emit `llm_request` and `llm_response` log events.
- **FILE-007**: `backend/weather.py` — **modified**. Emit `tool_call` and `tool_result` log events.
- **FILE-008**: `backend/news.py` — **modified**. Emit `tool_call` and `tool_result` log events.
- **FILE-009**: `backend/stocks.py` — **modified**. Emit `tool_call` and `tool_result` log events.
- **FILE-010**: `backend/browser.py` — **modified**. Emit `tool_call` and `tool_result` log events.
- **FILE-011**: `backend/ideas_routes.py` — **modified**. Emit `tool_call` and `tool_result` log events.
- **FILE-012**: `backend/journal_routes.py` — **modified**. Emit `tool_call` and `tool_result` log events.
- **FILE-013**: `frontend/app.js` — **modified**. Add `logEvent()` helper; emit `tool_dispatch`, `user_text`, `user_speech_frontend` events at dispatch chain decision points.
- **FILE-014**: `.gitignore` — **modified**. Add `backend/memory/logs/` and `backend/memory/.starling.pid`.
- **FILE-015**: `backend/memory/logs/` — **runtime directory** (not tracked in git). Contains one `session_YYYY-MM-DD_HH-MM-SS.jsonl` file per session.

## 6. Testing

- **TEST-001**: Start the system with `make up`. Verify `backend/memory/logs/` contains a new `session_*.jsonl` file and its first line is a `session_start` event with a valid `ts`, `llm_backend`, and `pid`.
- **TEST-002**: Speak a weather query ("what's the weather today"). Verify the log file contains, in order: a `user_speech` event with a non-empty `transcript`, a `tool_dispatch` event with `tool: "weather"`, a `tool_call` event for `/weather`, and a `tool_result` event with `status_code: 200`.
- **TEST-003**: Speak an LLM fallback query. Verify the log contains `tool_dispatch` with `tool: "llm_fallback"`, followed by `llm_request` and `llm_response` events. Verify `llm_response.full_text` is non-empty and `llm_response.duration_ms > 0`.
- **TEST-004**: Call `GET /log/sessions` from a browser on `localhost`. Verify it returns a JSON array with at least one entry containing `session_id`, `start_time`, `size_bytes`, `event_count`.
- **TEST-005**: Call `GET /log/sessions/{session_id}` with the current session ID. Verify the response is valid JSONL (every line parses as JSON, every record has `ts`, `session`, `source`, `event`, `data` fields).
- **TEST-006**: Call `GET /log/sessions` from a non-localhost IP. Verify HTTP 403 is returned.
- **TEST-007**: Call `POST /log/event` with `{"event_type": "tool_dispatch", "data": {"tool": "test"}, "source": "frontend"}`. Verify HTTP 200 is returned and the event appears in the JSONL file.
- **TEST-008**: Call `POST /log/event` with `{"event_type": "malicious_event", "data": {}}`. Verify HTTP 422 or HTTP 400 is returned and the event is not written to the log.
- **TEST-009**: Stop the system with `Ctrl+C` or `make down`. Verify the last line of the JSONL file is a `session_end` event with `total_events > 0`.
- **TEST-010**: Open `GET /log/viewer` in a browser. Verify the session dropdown populates, a session can be selected, and the event table renders with correct columns and colour-coding.

## 7. Risks & Assumptions

- **RISK-001**: **LLM response accumulation changes streaming behaviour** — the `llm_response` log event requires the full assembled response text, which means the stream generator must accumulate tokens. Care must be taken to yield each token chunk to the `StreamingResponse` _and_ accumulate to a buffer simultaneously, without blocking the stream. This is safe with a generator wrapper but must be tested to ensure no token loss.
- **RISK-002**: **Log file growth** — a heavily used session could produce large JSONL files (especially if full LLM responses are stored). The `result_summary` truncation to 500 chars mitigates this for tool results but `llm_response.full_text` can still be long. A max `full_text` length cap of 4000 characters should be enforced in TASK-010/011.
- **RISK-003**: **Concurrent writes** — FastAPI runs handlers in an async event loop but some handlers use `run_in_executor` for blocking calls (e.g. Whisper). `threading.Lock` in `session_log.py` handles this correctly.
- **RISK-004**: **`frontend/app.js` dispatch chain complexity** — the dispatch chain has 18 priority levels (per `toolkit/TRIGGER_PHRASES.md`). Inserting `logEvent()` calls at each branch must not accidentally alter control flow (no side effects from `logEvent` affecting conditional branches). Since `logEvent` is fire-and-forget with no return value used in conditionals, this risk is low.
- **ASSUMPTION-001**: The backend is always started via the FastAPI `uvicorn` entry point, so `@app.on_event("startup")` and `@app.on_event("shutdown")` are reliably called for session start/end bookkeeping.
- **ASSUMPTION-002**: Log files do not need to be human-editable during a session. The JSONL format is write-only during a session; reads occur only via the API endpoints or post-session.
- **ASSUMPTION-003**: One session = one `make up` / `make down` cycle. The `session_id` is determined at module import time, which aligns with process startup.

## 8. Related Specifications / Further Reading

- [plan/feature-simple-on-off-launcher-1.md](feature-simple-on-off-launcher-1.md) — defines the `make up` / `make down` session lifecycle that bounds each log file
- [toolkit/TRIGGER_PHRASES.md](../toolkit/TRIGGER_PHRASES.md) — full dispatch priority order; all 18 tool names must appear in `tool_dispatch` events
- [backend/main.py](../backend/main.py) — FastAPI app entrypoint; startup/shutdown hooks and router registration
- [backend/ollama.py](../backend/ollama.py) — LLM streaming relay; TASK-009/010 modification target
- [backend/llama_server.py](../backend/llama_server.py) — llama-server streaming relay; TASK-011 modification target
- [Python JSONL reference](https://jsonlines.org/) — one JSON object per line, UTF-8, newline-delimited
- [FastAPI Background Tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/) — alternative async log-write mechanism if synchronous writes prove to be a bottleneck
