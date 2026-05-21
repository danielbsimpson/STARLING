---
goal: RAG Memory Manager — Voice-Triggered Panel for File Upload, Source Management, and Chunk Preview
version: '1.0'
date_created: 2026-05-20
last_updated: 2026-05-20
owner: simps
status: 'Planned'
tags: [feature, rag, frontend, backend, chromadb, file-upload, panel, toolkit]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Adds a voice-triggered RAG Memory Manager panel to the S.T.A.R.L.I.N.G. UI. The panel lets the
user upload `.txt` or `.md` files directly from the browser, view the full list of ingested source
documents, inspect per-document chunk previews, and delete any source from the ChromaDB collection
— all without touching the file system or running a terminal command. The panel follows the
exact structural pattern of the existing toolkit panels (ideas vault, wiki, weather) and
integrates into the same voice dispatch chain in `app.js`.

Voice trigger example: `"open RAG memory"`, `"access memory vault"`, `"manage memory files"`.

---

## 1. Requirements & Constraints

- **REQ-001**: The panel must expose file upload (drag-and-drop + click-to-browse) for `.txt` and `.md` files only. All other MIME types must be rejected client-side before the upload request is made.
- **REQ-002**: File upload must use multipart/form-data via `POST /rag/upload`. Multiple files may be selected and uploaded in a single request. Each file is saved to `memory/input/` on the backend and ingestion runs immediately as a background task.
- **REQ-003**: The source list view must enumerate all unique source files currently indexed in the `starling_docs` ChromaDB collection, showing: filename, chunk count, and ISO ingestion timestamp. Data comes from `GET /rag/sources`.
- **REQ-004**: Each source row must include a delete button that calls `DELETE /rag/source?title=<title>`, removes all chunks for that document from ChromaDB, and removes the corresponding file from `memory/input/` if it still exists on disk.
- **REQ-005**: A chunk preview must be accessible per source — clicking a source row expands an inline accordion showing up to 10 chunks (truncated to 120 characters each) fetched from `GET /rag/chunks?title=<title>`.
- **REQ-006**: The RAG status badge (total chunk count, enabled/disabled state) must be visible in the panel header and refreshed after every upload or delete operation.
- **REQ-007**: Voice trigger detection must not interfere with existing exclusive modes (`ideasMode`, `wikiMode`, `journalMode`). The RAG trigger block must be inserted at the same dispatch priority level as other non-exclusive panels (weather, stocks, news).
- **REQ-008**: The trigger phrase must require the word "memory" or "RAG" to prevent accidental activation. Minimum transcript length for trigger evaluation: 3 words.
- **REQ-009**: `RAG_ENABLED` does not gate the manager panel. The panel must open and display status even when `RAG_ENABLED=false`, showing a disabled state banner so the user knows RAG retrieval is off.
- **CON-001**: No new Python dependencies. `chromadb`, `fastembed`, and `pathlib` are already present. FastAPI's built-in `UploadFile` handles file uploads with zero new packages.
- **CON-002**: Uploaded files are saved to `memory/input/` (the same directory the existing `make rag-ingest` command scans). No new storage location is introduced.
- **CON-003**: The chunk preview is read-only. Editing chunk text via the UI is out of scope for v1.
- **CON-004**: The panel is non-exclusive — the voice dispatch chain returns to normal after the trigger fires. The user does not need to say a close phrase; a close button is provided.
- **GUD-001**: Follow the existing ES module pattern. All functions exported from `rag-panel.js`; imported by `app.js` with named imports.
- **GUD-002**: All fetch calls must use `BACKEND_BASE` from `config.js`, not hardcoded `localhost` strings.
- **PAT-001**: Panel open/close pattern must match `openWeatherPanel` / `closeWeatherPanel` — show/hide via CSS class, no routing or page reload.

---

## 2. Implementation Steps

### Implementation Phase 1 — Backend: New RAG Endpoints

- GOAL-001: Extend `backend/rag.py` with three new functions (`ingest_file`, `list_sources`, `delete_source`, `get_chunks_for_source`) and expose them via four new routes registered in `backend/main.py`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add `ingest_file(filepath: Path) -> dict` to `backend/rag.py`. Reads the file, runs `semantic_chunk`, embeds with `get_embedding`, and upserts into `starling_docs` via ChromaDB. Returns `{"ingested": N, "title": str}`. Reuses all existing helpers — no new logic beyond scoping to a single file instead of a folder. | | |
| TASK-002 | Add `list_sources() -> list[dict]` to `backend/rag.py`. Calls `col.get(include=["metadatas"])`, groups metadata by `title`, and returns `[{"title": str, "chunk_count": int, "ingested_at": float, "source": str}]` sorted by `ingested_at` descending. | | |
| TASK-003 | Add `delete_source(title: str) -> dict` to `backend/rag.py`. Calls `col.get(where={"title": title}, include=["metadatas"])` to collect IDs, then `col.delete(ids=[...])`. Also deletes the corresponding file from `memory/input/` if it exists (match by `filepath.stem == title`). Returns `{"deleted_chunks": int, "title": str}`. | | |
| TASK-004 | Add `get_chunks_for_source(title: str, limit: int = 10) -> list[str]` to `backend/rag.py`. Calls `col.get(where={"title": title}, include=["documents"])` and returns up to `limit` raw chunk strings. | | |
| TASK-005 | Add `POST /rag/upload` to `backend/main.py`. Accepts `files: list[UploadFile] = File(...)`. For each file: validates extension is `.txt` or `.md` (raise HTTP 422 otherwise), writes bytes to `_RAG_INPUT_FOLDER / file.filename` (overwrite if exists), then calls `background_tasks.add_task(ingest_file, path)`. Returns `{"uploaded": [filename, ...], "status": "ingesting"}`. Import `File, UploadFile` from `fastapi`. | | |
| TASK-006 | Add `GET /rag/sources` to `backend/main.py`. Calls `list_sources()` from `rag.py` and returns the result directly. Returns `[]` when RAG is disabled or the collection is empty. | | |
| TASK-007 | Add `DELETE /rag/source` to `backend/main.py`. Accepts query param `title: str`. Calls `delete_source(title)` and returns the result dict. Raises HTTP 404 if `deleted_chunks == 0`. | | |
| TASK-008 | Add `GET /rag/chunks` to `backend/main.py`. Accepts query params `title: str` and optional `limit: int = 10`. Calls `get_chunks_for_source(title, limit)` and returns `{"title": str, "chunks": list[str]}`. | | |

### Implementation Phase 2 — Frontend: `rag-panel.js` Module

- GOAL-002: Create `frontend/rag-panel.js` as a self-contained ES module following the same structure as `ideas-panel.js` and `wiki-panel.js`. Exports trigger detection functions, panel open/close, and all internal UI logic.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-009 | Add `export function detectRagTrigger(transcript)` to `rag-panel.js`. Returns `true` if the transcript contains (`memory` or `rag`) AND (`open`, `access`, `manage`, `show`, `view`, or `pull up`). Minimum word count check: return `null` if `transcript.trim().split(/\s+/).length < 3`. | | |
| TASK-010 | Add `export function detectRagExitTrigger(transcript)` to `rag-panel.js`. Returns `true` on patterns: `close memory`, `exit memory`, `close RAG`, `hide memory panel`, `back to chat`. | | |
| TASK-011 | Add `export function openRagPanel()` to `rag-panel.js`. Shows the panel element, calls `_loadStatus()` and `_loadSources()` to populate the header badge and source list on open. | | |
| TASK-012 | Add `export function closeRagPanel()` to `rag-panel.js`. Hides the panel, clears any expanded chunk previews. | | |
| TASK-013 | Implement `_loadStatus()` (private). Fetches `GET /rag/status`, updates the chunk count badge in the panel header. Sets a `data-disabled` attribute on the panel root when `enabled === false` to trigger the disabled-state CSS banner. | | |
| TASK-014 | Implement `_loadSources()` (private). Fetches `GET /rag/sources`, clears and re-renders the source list. Each row: filename, chunk count badge, ingestion date (formatted as `YYYY-MM-DD HH:mm`), expand-chunks button (▶), and delete button (🗑). | | |
| TASK-015 | Implement chunk preview accordion. Clicking the expand button (▶) on a source row fetches `GET /rag/chunks?title=<title>&limit=10`, toggles an inline `<ul>` of truncated chunk strings (120 chars + ellipsis) below the row. Clicking again collapses it. Only one source is expanded at a time. | | |
| TASK-016 | Implement delete flow. Clicking 🗑 on a source row calls `DELETE /rag/source?title=<title>`. On success: remove the row from the DOM, refresh `_loadStatus()` to update chunk count. On failure: show an inline error label on the row for 3 seconds. | | |
| TASK-017 | Implement drag-and-drop upload zone. The upload area listens for `dragover` and `drop` events. On drop: filter for `.txt`/`.md` files (reject others silently with a brief UI message), build a `FormData` with all accepted files, POST to `/rag/upload`, show a per-file spinner, then call `_loadSources()` and `_loadStatus()` once the background task has had 2 seconds to begin (optimistic refresh). | | |
| TASK-018 | Implement click-to-browse upload. A visually hidden `<input type="file" multiple accept=".txt,.md">` is triggered by clicking the drop zone. On `change` event: same FormData POST pipeline as TASK-017. | | |
| TASK-019 | Add `export function initRagPanel({ enqueueSpeak })` to `rag-panel.js`. Stores the `enqueueSpeak` reference for TTS feedback. Called once from `app.js` at startup (same pattern as `initWeatherPanel`). | | |

### Implementation Phase 3 — HTML & CSS

- GOAL-003: Add the RAG panel DOM structure to `frontend/index.html` and style it in `frontend/style.css` using the existing panel design language.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | Add `<div id="rag-panel" class="tool-panel rag-panel hidden">` to `frontend/index.html` inside the `.chat-panel` flex column (same location as `#ideas-panel`, `#weather-panel`). Internal structure: header row with title `RAG MEMORY` + chunk count badge + close button; disabled-state banner div (hidden by default); upload drop zone div with icon and label; source list `<ul id="rag-source-list">`; empty-state message div. | | |
| TASK-021 | Add CSS for `.rag-panel` to `frontend/style.css`. Panel uses the same `.tool-panel` base styles as other panels. Upload drop zone: dashed border, subtle glow on `dragover`. Source list rows: flex layout with filename, chunk badge (monospaced, pill style), date, and action buttons right-aligned. Chunk preview `<ul>`: indented, smaller font, muted colour, `max-height: 200px; overflow-y: auto`. Disabled-state banner: amber background, spans full panel width. | | |

### Implementation Phase 4 — App.js Wiring

- GOAL-004: Import `rag-panel.js` exports into `app.js` and insert the RAG trigger block into the `_routeInput()` dispatch chain.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-022 | Add import statement to `frontend/app.js`: `import { detectRagTrigger, detectRagExitTrigger, openRagPanel, closeRagPanel, initRagPanel } from './rag-panel.js';` | | |
| TASK-023 | Call `initRagPanel({ enqueueSpeak })` in the `app.js` startup block alongside the other panel init calls (e.g., after `initWeatherPanel`). | | |
| TASK-024 | In `_routeInput()` (called from both `mediaRecorder.onstop` and `handleSend()`), add the RAG trigger block after the weather/stocks/news blocks and before the dossier exit check. Pattern: `const _ragTrigger = detectRagTrigger(text); if (_ragTrigger) { openRagPanel(); appendMessage('starling', 'Opening RAG Memory Manager.'); enqueueSpeak('Opening RAG Memory Manager.'); return; }` | | |
| TASK-025 | Add RAG exit trigger check in the existing general exit / close block in `_routeInput()`: `if (detectRagExitTrigger(text)) { closeRagPanel(); return; }` Insert before the LLM fallback path. | | |
| TASK-026 | Call `closeRagPanel()` in the `clearAllPanels()` / panel-reset helper (if one exists), or at the top of `_routeInput()` when opening any other exclusive panel, so the RAG panel dismisses correctly when a different tool is triggered. | | |

---

## 3. Alternatives

- **ALT-001**: Separate full-page route for the RAG manager (e.g., `/memory-manager`). Rejected — the project has no client-side router; all tools are single-page inline panels. A separate route would require adding a router or a second HTML file, which is out of scope.
- **ALT-002**: Use the existing `make rag-ingest` CLI command rather than adding an upload endpoint. Rejected — the CLI requires terminal access and manual file placement; the goal is a zero-terminal browser-based workflow.
- **ALT-003**: Implement chunk editing in v1. Rejected — editing an embedded chunk would require re-embedding it and upserting, which is non-trivial and out of scope. Marked as a v2 enhancement.
- **ALT-004**: Use a WebSocket for live ingestion progress (streaming chunk count). Considered for v2. For v1, an optimistic refresh after 2 seconds is sufficient given typical file sizes.
- **ALT-005**: Store uploaded files outside `memory/input/` in a separate `memory/uploads/` subfolder. Rejected — `memory/input/` is already the canonical ingest directory scanned by the existing `make rag-ingest` Makefile target; using a separate directory would require changing that target or maintaining two scan paths.

---

## 4. Dependencies

- **DEP-001**: `chromadb` — already installed; used in `rag.py` for all collection operations.
- **DEP-002**: `fastembed` — already installed; used by `get_embedding()` in `rag.py`.
- **DEP-003**: `fastapi.UploadFile`, `fastapi.File` — built into FastAPI; no new package required.
- **DEP-004**: `pathlib.Path` — stdlib; already used throughout `rag.py`.

---

## 5. Files

- **FILE-001**: `backend/rag.py` — add `ingest_file`, `list_sources`, `delete_source`, `get_chunks_for_source` functions.
- **FILE-002**: `backend/main.py` — register four new RAG routes: `POST /rag/upload`, `GET /rag/sources`, `DELETE /rag/source`, `GET /rag/chunks`.
- **FILE-003**: `frontend/rag-panel.js` — new file; full ES module with trigger detection, panel open/close, upload, source list, chunk preview, delete.
- **FILE-004**: `frontend/index.html` — add `#rag-panel` div inside `.chat-panel` flex column.
- **FILE-005**: `frontend/style.css` — add `.rag-panel`, `.rag-upload-zone`, `.rag-source-row`, `.rag-chunk-list`, `.rag-disabled-banner` styles.
- **FILE-006**: `frontend/app.js` — add import, `initRagPanel` call, trigger block in `_routeInput()`, exit trigger check, and `closeRagPanel()` in panel-reset path.
- **FILE-007**: `toolkit/TRIGGER_PHRASES.md` — add RAG Memory Manager trigger phrases and dispatch priority to the reference document.

---

## 6. Testing

- **TEST-001**: Upload a `.txt` file via drag-and-drop → verify `POST /rag/upload` returns 200, file appears in `memory/input/`, `GET /rag/sources` includes the new title within 3 seconds.
- **TEST-002**: Upload a `.pdf` file → verify the file is rejected client-side before any network request is made; an error message appears in the upload zone.
- **TEST-003**: Upload a file that already exists (same filename) → verify upsert is idempotent; chunk count for that source does not double after re-upload.
- **TEST-004**: Click the expand button on a source row → verify `GET /rag/chunks?title=<title>` is called, up to 10 chunks are rendered, each truncated to ≤120 characters.
- **TEST-005**: Delete a source → verify `DELETE /rag/source?title=<title>` returns 200, the row is removed from the DOM, the total chunk count badge decreases by the expected amount.
- **TEST-006**: Delete a source whose file has already been manually removed from `memory/input/` → verify the backend handles the missing file gracefully (no 500 error), chunks are still deleted from ChromaDB.
- **TEST-007**: Say `"open RAG memory"` → verify `detectRagTrigger` returns `true`, panel opens, `_loadSources()` is called.
- **TEST-008**: Say `"close memory panel"` while the RAG panel is open → verify `detectRagExitTrigger` returns `true`, panel hides.
- **TEST-009**: Open RAG panel, then say `"what's the weather"` → verify the weather panel opens and the RAG panel closes (panel-reset path clears all other panels).
- **TEST-010**: Open panel when `RAG_ENABLED=false` in `.env` → verify the disabled-state amber banner is visible and the source list shows zero sources without throwing an error.

---

## 7. Risks & Assumptions

- **RISK-001**: Large file uploads may cause the FastAPI background task queue to back up if multiple large files are uploaded simultaneously. Mitigation: limit accepted file size to 5 MB client-side (HTML `<input>` + JS size check) for v1.
- **RISK-002**: The `col.get(where={"title": title})` ChromaDB filter requires that every upserted document includes `title` in its metadata. Current `ingest()` in `rag.py` already sets `"title": doc_title` in all upserted metadata — this assumption must be validated before TASK-002 and TASK-003.
- **RISK-003**: The optimistic 2-second refresh after upload (TASK-017) may show stale data if the background embedding task takes longer (e.g., large file + cold fastembed model). Mitigation: the user can manually trigger a re-open of the panel to force a fresh `_loadSources()` call. A v2 improvement (WebSocket / SSE progress) is noted in ALT-004.
- **RISK-004**: Deleting a source removes its file from `memory/input/`. If the user had placed the same file there via the CLI for another purpose (e.g., shared reference doc), the file will be permanently deleted. The delete button should include a tooltip warning: "This will delete the file from disk and remove all associated chunks."
- **ASSUMPTION-001**: `RAG_ENABLED` in `.env` does not need to be `true` for the upload and management endpoints to function. The `ingest_file` function reads `RAG_ENABLED` only in `retrieve()` — the ingest path is unconditional. This assumption is consistent with the existing `POST /rag/ingest` endpoint, which also runs regardless of `RAG_ENABLED`.
- **ASSUMPTION-002**: The `starling_docs` ChromaDB collection is the only collection managed by this panel. The `wikipedia_articles` collection (used by `wikipedia_rag.py`) is a separate namespace and is out of scope for this panel.
- **ASSUMPTION-003**: All files currently in `memory/input/` have already been ingested (i.e., there is no orphaned-file state to reconcile). The source list is derived from ChromaDB metadata only, not from scanning the input directory.

---

## 8. Related Specifications / Further Reading

- [`assets/archived/complete/RAG_IMPLEMENTATION.md`](../assets/archived/complete/RAG_IMPLEMENTATION.md) — original RAG system implementation guide
- [`backend/rag.py`](../backend/rag.py) — current RAG ingest, retrieve, and status functions
- [`backend/main.py`](../backend/main.py) — existing `/rag/ingest`, `/rag/status`, `/rag/manifest` endpoints
- [`frontend/ideas-panel.js`](../frontend/ideas-panel.js) — reference for ES module panel pattern
- [`frontend/wiki-panel.js`](../frontend/wiki-panel.js) — reference for mode-aware panel with trigger detection
- [FastAPI File Uploads documentation](https://fastapi.tiangolo.com/tutorial/request-files/) — `UploadFile` and `File` usage
- [ChromaDB Python client — filtering and deletion](https://docs.trychroma.com/reference/py-client) — `col.get(where=...)` and `col.delete(ids=[...])`
