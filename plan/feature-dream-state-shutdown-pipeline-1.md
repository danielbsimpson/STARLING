---
goal: Dream State — Shutdown LLM Processing Pipeline for Session Analysis
version: '1.0'
date_created: 2026-05-19
last_updated: 2026-05-19
owner: simps
status: 'Planned'
tags: [feature, llm, memory, rag, reflection, session, shutdown, dream-state]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

When S.T.A.R.L.I.N.G. is told to shut down, rather than terminating immediately it enters a "dream state" — a sequential pipeline of three LLM analysis passes over the session's conversation transcript. Pass 1 produces a structured session summary. Pass 2 extracts discrete user and world facts and writes them to the RAG input folder so they are available to future sessions. Pass 3 synthesises the summary and facts into a first-person reflective journal entry stored in `thoughts.md`. The dream state runs synchronously during shutdown, completes within a configurable timeout, and degrades gracefully (partial output is saved) if the LLM is unavailable or times out.

## 1. Requirements & Constraints

- **REQ-001**: The dream state must be triggered automatically every time the system shuts down cleanly (via `Ctrl+C`, `make down`, or a graceful SIGTERM).
- **REQ-002**: The dream state must reconstruct a chronological conversation transcript from the current session's JSONL log file (written by `backend/session_log.py` per the logging plan).
- **REQ-003**: Pass 1 (Summarizer) must produce a Markdown summary saved to `backend/memory/dream/<session_id>_summary.md` containing: session date/time, main topics, tools used, actions taken, and notable outcomes.
- **REQ-004**: Pass 2 (Fact Extractor) must identify discrete factual claims about the user (preferences, personal details, stated goals) and about the world (events, data, news referenced) and write them as a Markdown bullet list to `backend/memory/input/facts_<session_id>.md`. This file path places it directly in the RAG ingestion input folder (`RAG_INPUT_FOLDER`, default `memory/input`) so it is picked up by `make rag-ingest` on next startup.
- **REQ-005**: Pass 3 (Reflection) must consume the Pass 1 summary and Pass 2 facts, then generate a first-person introspective journal entry and **append** it (with a dated heading) to `backend/memory/dream/thoughts.md`. The file accumulates all past sessions' reflections.
- **REQ-006**: Each LLM pass must use a configurable timeout (default: 90 seconds per pass). If a pass times out or the LLM returns an error, that pass's output file must contain a timestamped error notice and processing must continue to the next pass rather than aborting entirely.
- **REQ-007**: The dream state must support both LLM backends (`LLM_BACKEND=ollama` and `LLM_BACKEND=llama`), routing to the correct API endpoint using the same `LLM_BACKEND` env var already present in `main.py`.
- **REQ-008**: All three LLM calls must be non-streaming (single complete response) since they run during shutdown outside of the async event loop. Use `httpx.Client` (synchronous).
- **REQ-009**: The total maximum wall-clock time for the full dream state pipeline must be bounded by `DREAM_TIMEOUT_S` (default: `300` seconds = 5 minutes). If the pipeline exceeds this, remaining passes are skipped and a timeout notice is appended to `thoughts.md`.
- **REQ-010**: A `POST /dream/run` endpoint must allow the dream state to be triggered manually (for testing and ad-hoc analysis) without shutting down the system.
- **DRM-001**: A `GET /dream/status` endpoint must return the result of the most recently completed dream state run: `{session_id, completed_passes, summary_path, facts_path, thoughts_path, duration_s, error}`.
- **SEC-001**: The `POST /dream/run` endpoint must only be accessible from `localhost` (same localhost guard as the log endpoints from the logging plan). Return HTTP 403 for external callers.
- **CON-001**: The dream state module must not import from `asyncio` or use async/await. It runs in a synchronous context during FastAPI shutdown, where the event loop state is undefined.
- **CON-002**: Must not require any new Python packages. Uses only: `httpx` (already in `requirements.txt`), `json`, `pathlib`, `datetime`, `time`, `os`, `threading`.
- **CON-003**: The `memory/input/` folder (RAG INPUT_FOLDER) must not be auto-ingested by the dream state itself. The dream state only writes fact files there; RAG ingestion remains a separate manual step (`make rag-ingest`) or a future automatic post-startup hook.
- **CON-004**: Conversation reconstruction must be derived solely from the session's JSONL log. The dream state must not re-read browser panel HTML, news article body text, or other large payload blobs.
- **GUD-001**: All three LLM system prompts are stored as string constants in `backend/dream.py` and are clearly labelled with their pass number and purpose.
- **GUD-002**: Output files are written atomically: write to a `.tmp` file first, then rename, consistent with the pattern in `ideas_routes.py` (`_save()`).
- **GUD-003**: Each output file must begin with a YAML-like header block containing `session_id`, `generated_at` (ISO 8601 UTC), `pass`, and `model` fields, so they are self-describing when read out of context.
- **PAT-001**: Follow the existing module-level env-var config pattern: all constants at the top of the file using `os.getenv()` with explicit defaults.
- **PAT-002**: Follow the existing atomic write pattern from `ideas_routes.py`: `tmp = path.with_suffix(".tmp"); tmp.write_text(...); tmp.replace(path)`.

## 2. Implementation Steps

### Implementation Phase 1 — Core Dream State Module

- GOAL-001: Create `backend/dream.py` — the self-contained pipeline module responsible for transcript reconstruction, LLM prompt definitions, calling the LLM synchronously, and writing all output files.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `backend/dream.py`. Define top-of-file constants: `DREAM_DIR = Path(os.getenv("DREAM_OUTPUT_DIR", "memory/dream"))`, `RAG_INPUT_DIR = Path(os.getenv("RAG_INPUT_FOLDER", "memory/input"))`, `DREAM_TIMEOUT_S = int(os.getenv("DREAM_TIMEOUT_S", "300"))`, `PASS_TIMEOUT_S = int(os.getenv("DREAM_PASS_TIMEOUT_S", "90"))`, `DREAM_MODEL = os.getenv("DREAM_MODEL", "")` (empty = use same model as chat), `LLM_BACKEND = os.getenv("LLM_BACKEND", "ollama")`. Call `DREAM_DIR.mkdir(parents=True, exist_ok=True)` and `RAG_INPUT_DIR.mkdir(parents=True, exist_ok=True)` at module load time. | | |
| TASK-002 | In `dream.py`, define `OLLAMA_BASE = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")`, `OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2:3b")`, `LLAMA_BASE = os.getenv("LLAMA_SERVER_URL", "http://localhost:8080")`, `LLAMA_MODEL = os.getenv("LLAMA_MODEL", "llama3.1-8b")`. Define helper `_effective_model() -> str` that returns `DREAM_MODEL` if non-empty, else `OLLAMA_MODEL` if `LLM_BACKEND == "ollama"`, else `LLAMA_MODEL`. | | |
| TASK-003 | In `dream.py`, define the three system prompt constants as multi-line string literals: `SUMMARIZER_PROMPT` (instructs the LLM to produce a structured Markdown summary with sections: Session Overview, Topics Discussed, Tools Invoked, Notable Outcomes), `FACT_EXTRACTOR_PROMPT` (instructs the LLM to extract only discrete verifiable facts as a Markdown bullet list — one fact per line — categorised under `## About the User` and `## About the World`; return empty sections if no facts found), `REFLECTION_PROMPT` (instructs the LLM to write as S.T.A.R.L.I.N.G. in first person, reflecting on the session using the provided summary and facts; include: what was interesting, what was learned about the user, patterns noticed, anything it would do differently; format as a Markdown journal entry with a date heading). | | |
| TASK-004 | In `dream.py`, implement `def _call_llm(system_prompt: str, user_content: str, timeout: int) -> str`. Function must: (1) select endpoint based on `LLM_BACKEND`: for `"ollama"` call `POST {OLLAMA_BASE}/api/chat` with `{"model": model, "messages": [{"role":"system","content": system_prompt},{"role":"user","content": user_content}], "stream": false}`; for `"llama"` call `POST {LLAMA_BASE}/v1/chat/completions` with `{"model": model, "messages": [...], "stream": false, "temperature": 0.7}`; (2) use `httpx.Client(timeout=timeout)` as context manager; (3) extract response text from `response.json()["message"]["content"]` (Ollama) or `response.json()["choices"][0]["message"]["content"]` (llama); (4) on any exception, re-raise as `DreamError(pass_name, original_exception)`. | | |
| TASK-005 | In `dream.py`, define `class DreamError(Exception)` with fields `pass_name: str` and `cause: Exception`. Used to wrap LLM call failures with context about which pass failed. | | |

### Implementation Phase 2 — Transcript Reconstruction

- GOAL-002: Implement `build_transcript(session_log_path: Path) -> str` in `dream.py` — reads the JSONL session log and produces a clean, human-readable conversation transcript string suitable for use as an LLM prompt input.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | In `dream.py`, implement `def build_transcript(log_path: Path) -> str`. Read `log_path` line by line. For each line, parse the JSON record and apply the following mapping to build transcript lines: `user_speech` → `"[{ts}] User (voice): {data.transcript}"`; `user_text` → `"[{ts}] User (text): {data.text}"`; `tool_dispatch` → `"[{ts}] → Tool dispatched: {data.tool} (triggered by: \"{data.trigger_phrase}\")"` ; `tool_result` → `"[{ts}] ← Tool result: {data.endpoint} — {data.result_summary}"`; `llm_response` → `"[{ts}] Assistant: {data.full_text}"`; `error` → `"[{ts}] ⚠ Error ({data.source}): {data.message}"`. Skip `session_start`, `session_end`, `tool_call`, `llm_request`, `user_speech_frontend` events. Join all lines with `"\n"` and return. | | |
| TASK-007 | In `build_transcript()`, enforce a maximum transcript length of 12,000 words. If the assembled transcript exceeds this limit, truncate to the last 12,000 words and prepend the string `"[TRANSCRIPT TRUNCATED — showing final 12,000 words of session]\n\n"`. This prevents oversized prompts for very long sessions. | | |

### Implementation Phase 3 — Three-Pass Pipeline

- GOAL-003: Implement the three sequential LLM analysis passes as individual functions, then compose them in `run_dream_state(session_id: str) -> DreamResult` which is the single public entry point.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | In `dream.py`, define `class DreamResult` as a dataclass with fields: `session_id: str`, `completed_passes: list[str]`, `summary_path: Optional[Path]`, `facts_path: Optional[Path]`, `thoughts_path: Optional[Path]`, `duration_s: float`, `errors: list[str]`. | | |
| TASK-009 | In `dream.py`, implement `def _run_pass1_summary(transcript: str, session_id: str, model: str) -> Path`. Calls `_call_llm(SUMMARIZER_PROMPT, transcript, PASS_TIMEOUT_S)`. Writes result to `DREAM_DIR / f"{session_id}_summary.md"` with a header block: `<!-- session: {session_id} | pass: 1-summary | model: {model} | generated: {iso_ts} -->`. Returns the written path. Uses atomic write (PAT-002). | | |
| TASK-010 | In `dream.py`, implement `def _run_pass2_facts(transcript: str, session_id: str, model: str) -> Path`. Calls `_call_llm(FACT_EXTRACTOR_PROMPT, transcript, PASS_TIMEOUT_S)`. Writes result to `RAG_INPUT_DIR / f"facts_{session_id}.md"` with a header block: `<!-- session: {session_id} | pass: 2-facts | model: {model} | generated: {iso_ts} -->`. Returns the written path. Uses atomic write (PAT-002). | | |
| TASK-011 | In `dream.py`, implement `def _run_pass3_reflection(summary_text: str, facts_text: str, session_id: str, model: str) -> Path`. Compose `user_content` as: `f"## Session Summary\n\n{summary_text}\n\n## Extracted Facts\n\n{facts_text}"`. Call `_call_llm(REFLECTION_PROMPT, user_content, PASS_TIMEOUT_S)`. Append to `DREAM_DIR / "thoughts.md"` using the format: `\n\n---\n\n## {date_heading} — Session {session_id}\n\n{reflection_text}\n`. Do NOT use atomic write for append; open with `"a"` mode. Return the `thoughts.md` path. | | |
| TASK-012 | In `dream.py`, implement `def run_dream_state(session_id: str) -> DreamResult`. This is the public entry point. Steps: (1) record `t_start = time.monotonic()`; (2) resolve log path from `session_log.LOG_DIR / f"{session_id}.jsonl"`; (3) if log does not exist, return `DreamResult` with error `"Session log not found"`; (4) call `build_transcript(log_path)` — if transcript is empty (no user interactions), skip all passes and return early with `completed_passes=[]`; (5) call each pass in sequence, catching `DreamError` per pass, appending error message to `result.errors` and continuing; (6) enforce `DREAM_TIMEOUT_S` by checking `time.monotonic() - t_start` before each pass, aborting with a timeout notice if exceeded; (7) set `result.duration_s = time.monotonic() - t_start`; (8) return `DreamResult`. | | |
| TASK-013 | In `dream.py`, implement `def _write_error_notice(path: Path, pass_name: str, error: str) -> None`. Called when a pass fails. Writes a Markdown file at `path` with content: `"<!-- ERROR: Pass {pass_name} failed — {error} | {iso_ts} -->\n\n> Dream state pass '{pass_name}' did not complete: {error}"`. Uses atomic write. This ensures output files always exist (even on failure) so downstream passes that read prior pass output have something to work with. | | |

### Implementation Phase 4 — Dream State API Endpoints

- GOAL-004: Create `backend/dream_routes.py` exposing `POST /dream/run` (manual trigger) and `GET /dream/status` (last run result), and integrate the router into `main.py`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-014 | Create `backend/dream_routes.py`. Define `router = APIRouter(prefix="/dream", tags=["dream"])`. Import `dream`, `session_log`, `Request`. Define module global `_last_result: Optional[dream.DreamResult] = None`. | | |
| TASK-015 | In `dream_routes.py`, implement `POST /dream/run`. Apply localhost guard (check `request.client.host in ("127.0.0.1", "::1", "localhost")`, return HTTP 403 otherwise). Accept optional JSON body `{"session_id": str}` — if omitted, use `session_log.get_session_id()`. Call `dream.run_dream_state(session_id)` in a `threading.Thread` with `daemon=True` so it does not block the HTTP response. Return `{"status": "started", "session_id": session_id}` immediately. Store result in `_last_result` when the thread completes. | | |
| TASK-016 | In `dream_routes.py`, implement `GET /dream/status`. Return `_last_result` serialised as JSON. If `_last_result` is None, return `{"status": "no_dream_run_yet"}`. Convert `Path` fields to strings. | | |
| TASK-017 | In `dream_routes.py`, implement `GET /dream/thoughts` — read and return the full contents of `DREAM_DIR / "thoughts.md"` as `text/plain`. Return 404 if file does not exist. Apply localhost guard. | | |
| TASK-018 | In `backend/main.py`, import `dream_routes` and call `app.include_router(dream_routes.router)`. In the existing `@app.on_event("shutdown")` handler (after `session_log.log_session_end()`), call `dream.run_dream_state(session_log.get_session_id())` synchronously. This blocks the shutdown sequence until the dream state completes or times out. | | |

### Implementation Phase 5 — Shutdown Sequencing Integration

- GOAL-005: Ensure the dream state runs correctly within the `make down` / `Ctrl+C` shutdown sequence defined in the launcher plan, and that the launcher respects the dream state timeout before force-killing the backend process.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-019 | In `scripts/launch.py` (defined in the launcher plan), change the `shutdown_handler` for the backend process to: (1) send `SIGTERM` to the backend process; (2) wait up to `DREAM_TIMEOUT_S + 30` seconds (default: 330 s) for the backend to exit, rather than the default 5-second hard kill. This gives the FastAPI shutdown event handler time to complete the dream state pipeline before the process is killed. Print "Waiting for dream state to complete..." to stdout while waiting. | | |
| TASK-020 | In `scripts/stop.py` (defined in the launcher plan), apply the same extended wait: after sending `SIGTERM` / `taskkill` to the backend PID, wait up to `DREAM_TIMEOUT_S + 30` seconds before escalating to force-kill. Read `DREAM_TIMEOUT_S` from `.env` if present, default to `300`. | | |

### Implementation Phase 6 — Configuration and Documentation

- GOAL-006: Document all new environment variables in `.env.example` and update `README.md` to describe the dream state feature and its outputs.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-021 | Add the following entries to `.env.example` (create file if it does not exist, otherwise append): `DREAM_OUTPUT_DIR=memory/dream`, `DREAM_TIMEOUT_S=300`, `DREAM_PASS_TIMEOUT_S=90`, `DREAM_MODEL=` (empty = use same model as chat). Include inline comments explaining each variable. | | |
| TASK-022 | Add a `## Dream State` section to `README.md` explaining: what happens on shutdown, the three LLM passes and their output files, how to inspect outputs (`GET /dream/thoughts`, `GET /dream/status`), how to trigger manually (`POST /dream/run`), and that fact files in `memory/input/` are ingested on next `make rag-ingest`. | | |

## 3. Alternatives

- **ALT-001**: **Async LLM calls using `asyncio.run()`** — could reuse the existing `_stream_ollama` / `_stream_as_ndjson` async generators by wrapping in `asyncio.run()`. Rejected because `asyncio.run()` creates a new event loop, which conflicts with the running uvicorn event loop during the FastAPI shutdown hook. Synchronous `httpx.Client` with `stream=false` is the clean solution.
- **ALT-002**: **Run the dream state in a subprocess** — spawn a new Python process at shutdown that performs the three LLM calls independently of the main FastAPI process lifecycle. Rejected because the subprocess would need to import and reconfigure the entire backend to get model credentials, and it would complicate PID tracking in the launcher.
- **ALT-003**: **Trigger dream state from `scripts/stop.py` rather than the FastAPI shutdown hook** — run the pipeline from the launcher process rather than within FastAPI. Rejected because the session log path and LLM configuration are most naturally accessible from within the backend process that wrote the log.
- **ALT-004**: **Parallel LLM passes** — run all three passes concurrently using `threading.Thread` to reduce total wall-clock time. Rejected because Pass 3 (Reflection) requires the text output of Passes 1 and 2 as input, creating a strict sequential dependency.
- **ALT-005**: **Store reflections in a vector database** — embed `thoughts.md` entries and store them in ChromaDB for semantic search. Rejected as premature optimisation; flat Markdown is sufficient for the current use case and can be added to RAG ingestion trivially in a future enhancement.
- **ALT-006**: **Use a dedicated smaller/faster model for dream state** — configure a separate DREAM_MODEL (e.g., a smaller quantised model) for faster shutdown processing. This is partially supported via the `DREAM_MODEL` env var (TASK-002) but the default is to reuse the same model already loaded in memory by the LLM backend.

## 4. Dependencies

- **DEP-001**: `backend/session_log.py` — provides `LOG_DIR`, `get_session_id()`, and the JSONL log file that `build_transcript()` reads. This plan depends on the Session Activity Logging plan (`feature-session-activity-logging-1.md`) being implemented first.
- **DEP-002**: `httpx` — already in `requirements.txt`. Used by `_call_llm()` for synchronous (non-streaming) LLM requests.
- **DEP-003**: `LLM_BACKEND` env var — already defined and loaded in `main.py`. Dream state reads the same env var to route to the correct LLM endpoint.
- **DEP-004**: `OLLAMA_BASE_URL` / `LLAMA_SERVER_URL` — already defined in `.env`. Reused by dream state without modification.
- **DEP-005**: `memory/input/` directory — the RAG input folder (`RAG_INPUT_FOLDER` from `rag.py`). Fact files from Pass 2 are written here for subsequent `make rag-ingest`.
- **DEP-006**: `scripts/launch.py` and `scripts/stop.py` — from the launcher plan (`feature-simple-on-off-launcher-1.md`). TASK-019 and TASK-020 modify these files to extend the backend shutdown wait time.

## 5. Files

- **FILE-001**: `backend/dream.py` — **new file**. Core dream state pipeline: transcript reconstruction, system prompts, `_call_llm()`, three pass functions, `run_dream_state()`.
- **FILE-002**: `backend/dream_routes.py` — **new file**. FastAPI router for `POST /dream/run`, `GET /dream/status`, `GET /dream/thoughts`.
- **FILE-003**: `backend/main.py` — **modified**. Import `dream_routes` and register router; call `dream.run_dream_state()` in the shutdown event handler.
- **FILE-004**: `scripts/launch.py` — **modified** (depends on launcher plan). Extend backend SIGTERM wait from 5s to `DREAM_TIMEOUT_S + 30` seconds.
- **FILE-005**: `scripts/stop.py` — **modified** (depends on launcher plan). Same extended wait as `launch.py`.
- **FILE-006**: `.env.example` — **modified**. Add `DREAM_OUTPUT_DIR`, `DREAM_TIMEOUT_S`, `DREAM_PASS_TIMEOUT_S`, `DREAM_MODEL` entries with comments.
- **FILE-007**: `README.md` — **modified**. Add `## Dream State` section.
- **FILE-008**: `backend/memory/dream/` — **runtime directory** (not tracked in git). Contains `<session_id>_summary.md` per session and the persistent `thoughts.md`.
- **FILE-009**: `backend/memory/input/facts_<session_id>.md` — **runtime artifact** (not tracked in git). Fact file written by Pass 2, consumed by `make rag-ingest`.

## 6. Testing

- **TEST-001**: Complete a session with at least 3 voice queries (including a tool call and an LLM fallback). Initiate shutdown via `make down`. Verify that all three output files exist within `DREAM_TIMEOUT_S` seconds: `memory/dream/<session_id>_summary.md`, `memory/input/facts_<session_id>.md`, `memory/dream/thoughts.md`.
- **TEST-002**: Open `memory/dream/<session_id>_summary.md` and verify it contains the Markdown sections: a header block comment, "Session Overview", "Topics Discussed", "Tools Invoked", "Notable Outcomes". Verify the file is valid Markdown.
- **TEST-003**: Open `memory/input/facts_<session_id>.md` and verify it contains `## About the User` and `## About the World` sections, each with at least one bullet point (or an explicit "No facts identified" statement) and the header block comment.
- **TEST-004**: Open `memory/dream/thoughts.md` and verify the new entry has the `---` separator, a dated heading `## YYYY-MM-DD — Session <session_id>`, and a non-empty reflection body. Run two sessions and verify the file contains two dated entries (i.e., append mode works correctly).
- **TEST-005**: Start the system with `LLM_BACKEND=ollama` and `LLM_BACKEND=llama` in separate runs. Verify the dream state completes successfully for both backends.
- **TEST-006**: Simulate LLM unavailability by stopping `llama-server` before shutdown. Verify that Pass 1 writes an error notice file, Pass 2 writes an error notice file, Pass 3 writes an error notice file (or appends an error notice to `thoughts.md`), and the process exits cleanly without hanging.
- **TEST-007**: Call `POST /dream/run` from `localhost` via `curl -X POST http://localhost:8000/dream/run`. Verify HTTP 200 is returned immediately and `GET /dream/status` eventually returns a completed `DreamResult` with `completed_passes` containing `["summary", "facts", "reflection"]`.
- **TEST-008**: Call `POST /dream/run` from a non-localhost address. Verify HTTP 403 is returned.
- **TEST-009**: Complete a session with no user interactions (only startup events). Verify dream state returns early with `completed_passes=[]` and no output files are written (empty transcript short-circuit, TASK-012 step 4).
- **TEST-010**: Set `DREAM_PASS_TIMEOUT_S=1` and `DREAM_MODEL` to a model that does not exist. Verify each pass times out within ~2 seconds, writes an error notice, and the full pipeline completes (all three error notices written) within `DREAM_TIMEOUT_S`.

## 7. Risks & Assumptions

- **RISK-001**: **FastAPI shutdown hook blocking** — calling `run_dream_state()` synchronously in `@app.on_event("shutdown")` blocks uvicorn's shutdown sequence until it returns. If `DREAM_TIMEOUT_S` is set too high and the LLM is slow, this will delay the terminal returning control to the user. The configurable timeout mitigates this; users can set `DREAM_TIMEOUT_S=0` to disable the dream state entirely.
- **RISK-002**: **LLM context window overflow** — a long session with many turns could produce a transcript exceeding the LLM's context window. The 12,000-word truncation cap in `build_transcript()` (TASK-007) mitigates this but does not guarantee it fits within every model's context. Users with small context models should set `DREAM_PASS_TIMEOUT_S` high enough to handle re-prompting.
- **RISK-003**: **Pass 3 quality degrades when Pass 1 or Pass 2 fails** — if Pass 1 returns an error notice, Pass 3 receives error-notice text rather than a real summary. The reflection output will still be generated but will be low quality. This is acceptable; the error notice text is clearly formatted so the LLM can recognise it.
- **RISK-004**: **`thoughts.md` grows unbounded** — every session appends a new entry. Over months of daily use this file could become very large and exceed the context window for future RAG retrieval. A future maintenance task should implement a rolling archive (e.g., move entries older than 30 days to `thoughts_archive_YYYY-MM.md`).
- **RISK-005**: **Fact file naming collision** — `facts_<session_id>.md` uses the session start timestamp, which has per-second resolution. Two sessions started within the same second (impossible in practice but theoretically possible) would overwrite each other. Acceptable given the session lifecycle.
- **ASSUMPTION-001**: The `feature-session-activity-logging-1.md` plan has been fully implemented and the session JSONL log exists at `session_log.LOG_DIR / f"{session_id}.jsonl"` before the dream state runs.
- **ASSUMPTION-002**: The LLM backend (`llama-server` or Ollama) is still running and reachable at the time the dream state executes. The launcher plan ensures `llama-server` is only terminated *after* the backend process exits, so the LLM should be available for the full dream state duration.
- **ASSUMPTION-003**: `memory/input/` is the canonical RAG input folder consistent with the `RAG_INPUT_FOLDER` env var defined in `rag.py`. Writing facts here is safe because the RAG ingest is not triggered automatically.

## 8. Related Specifications / Further Reading

- [plan/feature-session-activity-logging-1.md](feature-session-activity-logging-1.md) — prerequisite; provides the JSONL session log that the dream state reads
- [plan/feature-simple-on-off-launcher-1.md](feature-simple-on-off-launcher-1.md) — defines `scripts/launch.py` and `scripts/stop.py` modified in Phase 5
- [backend/rag.py](../backend/rag.py) — defines `RAG_INPUT_FOLDER` (`memory/input`) where Pass 2 fact files are written
- [backend/ollama.py](../backend/ollama.py) — Ollama API format reference for `_call_llm()` non-streaming payload
- [backend/llama_server.py](../backend/llama_server.py) — llama-server OpenAI-compatible format reference for `_call_llm()` non-streaming payload
- [Ollama non-streaming API](https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion) — `stream: false` returns a single JSON object
- [httpx synchronous client](https://www.python-httpx.org/quickstart/) — used for blocking LLM calls during async shutdown
