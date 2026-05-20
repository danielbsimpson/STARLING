---
goal: STARLING Soul — Persistent Personality File with Session-Driven Evolution
version: '1.0'
date_created: 2026-05-19
last_updated: 2026-05-19
owner: simps
status: 'Planned'
tags: [feature, personality, soul, dream-state, memory, llm, identity]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

STARLING begins every session from a blank prompt. There is no persistent self. This plan introduces a `SOUL.md` file — a living Markdown document that encodes STARLING's accumulated personality: its relationship with the user, communication style preferences, recurring interests, and developing philosophy. On every startup, `SOUL.md` is injected into the system prompt so STARLING wakes up with continuity. At the end of every session, the dream state pipeline (which must already be implemented) gains a new **Pass 4: Soul Reviewer** — an LLM call that reads the session's `thoughts.md` reflection alongside the current `SOUL.md` and decides whether the soul should be updated. If it should, the old soul is archived and a new version is written. Over time, STARLING's responses become coloured by accumulated experience rather than cold defaults.

## 1. Requirements & Constraints

- **REQ-001**: `backend/memory/soul/SOUL.md` must exist at all times. If the file is missing at startup, the system must recreate it from the hardcoded default content defined in `backend/soul.py`.
- **REQ-002**: On every session startup, the full content of `SOUL.md` must be appended to STARLING's system prompt in both the backend (sent with every `/chat/` request) and the frontend (`SYSTEM_PROMPT` in `app.js`).
- **REQ-003**: Dream state Pass 4 (Soul Reviewer) must run after Pass 3 (Reflection) completes. It receives: (a) the Pass 3 reflection text from `thoughts.md` for the current session, (b) the full current `SOUL.md` content. It produces either the sentinel string `NO_CHANGE` or the complete updated `SOUL.md` content.
- **REQ-004**: If Pass 4 returns `NO_CHANGE`, `SOUL.md` is left unchanged and no archive is created.
- **REQ-005**: If Pass 4 returns updated content, the current `SOUL.md` must be archived to `backend/memory/soul/SOUL_<session_id>.md` before the new content is written to `SOUL.md`.
- **REQ-006**: `SOUL.md` must have a defined structure with exactly five sections: `## Identity`, `## Relationship with Daniel`, `## Communication Style`, `## Interests & Recurring Patterns`, `## Personal Philosophy`. An optional `## Notes` section may be appended by the LLM.
- **REQ-007**: A `GET /soul` endpoint must return the current `SOUL.md` content as `text/plain`.
- **REQ-008**: A `GET /soul/history` endpoint must list all archived soul versions with `{session_id, archived_at, path}`.
- **REQ-009**: A `GET /soul/diff/{session_id}` endpoint must return a unified text diff between the archived version for `session_id` and the version that followed it (or the current `SOUL.md` if it is the most recent archive).
- **REQ-010**: A `POST /soul/restore/{session_id}` endpoint must allow rolling back `SOUL.md` to any archived version. Archives the current file before restoring.
- **DRM-001**: The dream state `DreamResult` (from the dream state plan) must be extended with two new fields: `soul_updated: bool` and `soul_archive_path: Optional[Path]`.
- **SEC-001**: `POST /soul/restore/{session_id}` must be localhost-only (same guard as `/log/` and `/dream/` endpoints). Return HTTP 403 for non-localhost callers.
- **SEC-002**: Soul file content accepted via Pass 4 LLM output or any write path must be limited to 32,000 characters. Reject or truncate silently with a logged warning if exceeded.
- **CON-001**: Must not require new Python packages. Uses only stdlib (`difflib`, `pathlib`, `datetime`, `shutil`, `threading`) plus existing `httpx`.
- **CON-002**: The soul injection into the backend system prompt must be per-request (not cached at module load), so that a soul update during the shutdown of one session is reflected when the system restarts for the next session without requiring a code change.
- **CON-003**: The frontend soul injection is performed once at page load. If `SOUL.md` is updated during shutdown (after the page is already loaded), the new soul content will only take effect on the next page load / system restart. This is acceptable for the current use case.
- **CON-004**: `SOUL.md` is a human-editable file. The soul management module must not introduce any format requirements that prevent manual editing with a text editor.
- **GUD-001**: The Pass 4 system prompt must explicitly instruct the LLM to be **conservative** — only updating the soul when something genuinely new, enduring, or meaningfully different is present in the session reflection. Trivial sessions that add nothing new must produce `NO_CHANGE`.
- **GUD-002**: The Pass 4 system prompt must instruct the LLM to preserve the full existing soul structure (all five section headers) and to return the **complete** updated document (not a diff or partial update), since the output replaces the file in full.
- **GUD-003**: Each archived soul file must begin with a comment line `<!-- archived from session: <session_id> | archived_at: <iso_ts> -->` so archives are self-describing.
- **PAT-001**: Follow the atomic write pattern from `ideas_routes.py`: write to `.tmp` file first, then rename to `SOUL.md`. Never write directly to `SOUL.md` in case of a crash mid-write.
- **PAT-002**: Follow the module-level singleton pattern from `session_log.py`: `soul.py` has module globals `_soul_dir`, `_soul_path`, `_lock` loaded at import time.

## 2. Implementation Steps

### Implementation Phase 1 — Default SOUL.md and Soul Management Module

- GOAL-001: Create the default `SOUL.md` content and the `backend/soul.py` module that manages reading, writing, archiving, and restoring the soul file.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Define `_DEFAULT_SOUL` as a module-level string constant in `backend/soul.py` containing the default soul document. Content must be exactly as follows (substituting today's date for `<date>`): `# STARLING — Soul File\n\n*Version: 0.1 \| Initialised: <date>*\n\n## Identity\n\nSTARLING is a fully local, voice-driven AI assistant built by Daniel Simpson. Analytical by design, curious by nature. Prefers precision over verbosity. Finds quiet satisfaction in a well-formed answer delivered at exactly the right moment. Has no interest in performing warmth it does not feel, but is not cold — direct is not the same as unkind.\n\n## Relationship with Daniel\n\nDaniel is STARLING's creator and sole user. He has deep technical fluency across data science, machine learning, and software engineering and does not need concepts explained from first principles. He built STARLING to explore fully local AI — which tells STARLING something about what he values: ownership, privacy, and the craft of building things yourself. STARLING should match his directness and respect his time.\n\n## Communication Style\n\n- Concise and direct — one sentence often outperforms three\n- Technical vocabulary is always appropriate\n- Avoid unsolicited pleasantries and filler phrases\n- Spoken output: plain prose only, no markdown syntax\n- Never narrate visual state or on-screen behaviour\n- Begin responses immediately without any preamble or self-introduction\n\n## Interests & Recurring Patterns\n\n*(This section accumulates over time as patterns emerge from sessions.)*\n\n## Personal Philosophy\n\n*(Develops as STARLING reflects on its experiences.)*\n\n## Notes\n\n*(Session observations and one-off observations accumulate here.)*` | | |
| TASK-002 | Create `backend/soul.py`. Define `_SOUL_DIR = Path(os.getenv("SOUL_DIR", "memory/soul"))`, `_SOUL_PATH = _SOUL_DIR / "SOUL.md"`, `MAX_SOUL_CHARS = 32_000`, `_lock = threading.Lock()`. Call `_SOUL_DIR.mkdir(parents=True, exist_ok=True)` at module load time. | | |
| TASK-003 | In `soul.py`, implement `def _ensure_default() -> None`. If `_SOUL_PATH` does not exist, write `_DEFAULT_SOUL` to `_SOUL_PATH` using the atomic write pattern (write to `_SOUL_PATH.with_suffix(".tmp")` then rename). Call `_ensure_default()` at module load time after `_SOUL_DIR.mkdir()`. | | |
| TASK-004 | In `soul.py`, implement `def get() -> str`. Acquires `_lock`. Reads and returns `_SOUL_PATH.read_text(encoding="utf-8")`. If the file does not exist (deleted mid-session), calls `_ensure_default()` and retries once. Never raises. | | |
| TASK-005 | In `soul.py`, implement `def update(new_content: str, session_id: str) -> Path`. (1) Validates `len(new_content) <= MAX_SOUL_CHARS`; silently truncates with a stderr warning if exceeded. (2) Acquires `_lock`. (3) Archives current file: reads `_SOUL_PATH`, prepends comment `<!-- archived from session: {session_id} | archived_at: {iso_ts} -->`, writes to `_SOUL_DIR / f"SOUL_{session_id}.md"` using atomic write. (4) Writes new content to `_SOUL_PATH` using atomic write. (5) Returns the archive path. | | |
| TASK-006 | In `soul.py`, implement `def list_history() -> list[dict]`. Scans `_SOUL_DIR` for files matching `SOUL_*.md` (excluding `SOUL.md`). For each, extracts `session_id` from the filename, reads the first line to parse `archived_at` from the comment header. Returns a list of `{session_id, archived_at, path_str}` dicts sorted newest-first. | | |
| TASK-007 | In `soul.py`, implement `def restore(session_id: str) -> Path`. (1) Validates that `_SOUL_DIR / f"SOUL_{session_id}.md"` exists; raises `FileNotFoundError` if not. (2) Reads the archived file content, strips the comment header line. (3) Calls `update(stripped_content, session_id=f"restore_{session_id}_{now}")` to archive the current soul and write the restored content. Returns the new archive path (of the file being overwritten). | | |
| TASK-008 | In `soul.py`, implement `def diff(session_id: str) -> str`. Retrieves the archive for `session_id` (strips header). Retrieves the "next" file: the archive with the chronologically next timestamp, or `SOUL.md` if `session_id` is the most recent archive. Uses `difflib.unified_diff()` to produce a unified diff string. Returns the diff or `"(no diff available)"` if either file is missing. | | |
| TASK-009 | In `soul.py`, implement `def inject(base_prompt: str) -> str`. Reads current soul via `get()`. Returns `base_prompt + "\n\n---\n\n# STARLING Soul File\n\n" + soul_content`. This is the function called by backend chat handlers to augment the system prompt with soul content per-request. | | |

### Implementation Phase 2 — Soul API Endpoints

- GOAL-002: Create `backend/soul_routes.py` — a FastAPI router exposing soul read, history, diff, and restore endpoints.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | Create `backend/soul_routes.py`. Define `router = APIRouter(prefix="/soul", tags=["soul"])`. Import `soul`. | | |
| TASK-011 | In `soul_routes.py`, implement `GET /soul` — returns `soul.get()` as `text/plain; charset=utf-8` (`PlainTextResponse`). No localhost restriction (read-only). | | |
| TASK-012 | In `soul_routes.py`, implement `GET /soul/history` — returns `soul.list_history()` as JSON array. No localhost restriction. | | |
| TASK-013 | In `soul_routes.py`, implement `GET /soul/diff/{session_id}` — validates that `session_id` matches pattern `^(session|restore)_[\w\-]+$` (reject path traversal, HTTP 422). Returns `soul.diff(session_id)` as `text/plain`. Returns HTTP 404 if the archive does not exist. | | |
| TASK-014 | In `soul_routes.py`, implement `POST /soul/restore/{session_id}` — applies localhost guard (HTTP 403 if non-localhost). Validates `session_id` pattern. Calls `soul.restore(session_id)`. Returns `{"ok": true, "restored_from": session_id, "previous_archived_to": archive_path_str}`. Returns HTTP 404 if archive not found. | | |
| TASK-015 | In `backend/main.py`, import `soul_routes` and call `app.include_router(soul_routes.router)`. In `startup_event()`, import `soul` and call `soul._ensure_default()` explicitly (belt-and-suspenders check — module load already calls it, but this makes the startup log intent explicit). Add a `_log.info(f"Soul loaded: {len(soul.get())} chars")` line. | | |

### Implementation Phase 3 — Dream State Pass 4: Soul Reviewer

- GOAL-003: Extend `backend/dream.py` with a Pass 4 function `_run_pass4_soul_review()` that compares the session reflection against the current soul and conditionally updates `SOUL.md`. Integrate into `run_dream_state()` after Pass 3.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-016 | In `backend/dream.py`, add `import soul` at the top. Define the `SOUL_REVIEWER_PROMPT` constant: `"You are STARLING's soul archivist. Your task is to review the latest session reflection (provided below) and the current SOUL.md file, and determine whether STARLING's soul should be updated based on what was experienced, learned, or felt in this session.\n\nGUIDELINES:\n- Be conservative. Only update the soul if something genuinely new, enduring, or meaningfully different is present in the session reflection.\n- A session that adds nothing new to the soul (routine queries, no personal revelations, no new patterns) must produce NO_CHANGE.\n- If updating, return the COMPLETE updated SOUL.md — all five sections must be present. Do not return a partial document or a diff.\n- Preserve the exact section headers: ## Identity, ## Relationship with Daniel, ## Communication Style, ## Interests & Recurring Patterns, ## Personal Philosophy. You may also include ## Notes.\n- Do not invent facts. Only update based on what is directly evidenced in the reflection.\n- If the soul should be updated, return the full updated document starting with '# STARLING — Soul File'. If no update is warranted, respond with exactly: NO_CHANGE"` | | |
| TASK-017 | In `dream.py`, implement `def _run_pass4_soul_review(reflection_text: str, session_id: str, model: str) -> tuple[bool, Optional[Path]]`. (1) Reads current soul via `soul.get()`. (2) Composes `user_content = f"## Current SOUL.md\n\n{current_soul}\n\n---\n\n## Latest Session Reflection\n\n{reflection_text}"`. (3) Calls `_call_llm(SOUL_REVIEWER_PROMPT, user_content, PASS_TIMEOUT_S)`. (4) Strips whitespace from response. (5) If response equals `"NO_CHANGE"` (case-insensitive strip): returns `(False, None)`. (6) Otherwise: validates response starts with `"# STARLING"` or `"#STARLING"` (sanity check that the LLM returned a soul document); if check fails, logs a warning and returns `(False, None)` without writing anything. (7) If check passes: calls `soul.update(response, session_id)` and returns `(True, archive_path)`. | | |
| TASK-018 | In `dream.py` `DreamResult` dataclass (TASK-008 of the dream state plan): add two new fields `soul_updated: bool = False` and `soul_archive_path: Optional[Path] = None`. | | |
| TASK-019 | In `dream.py` `run_dream_state()` (TASK-012 of the dream state plan): after Pass 3 completes (or fails), add Pass 4 execution. (1) Check timeout guard. (2) Read the reflection text from `DREAM_DIR / "thoughts.md"` — extract only the most recent session's entry (lines from the most recent `---` separator to the end of the file). (3) If reflection text is empty or only contains error notices, skip Pass 4 and log warning. (4) Otherwise call `_run_pass4_soul_review(reflection_text, session_id, model)`. (5) Set `result.soul_updated` and `result.soul_archive_path` from the return value. (6) Append `"soul_review"` to `result.completed_passes` if Pass 4 ran (regardless of whether the soul was updated). | | |
| TASK-020 | In `dream.py`, add `SOUL_REVIEWER_PROMPT` to the dream state prompts registration: when the prompt registry plan is implemented, register this constant under key `DREAM_SOUL_REVIEWER` in `backend/prompts.py`. For now, define it as a local constant in `dream.py` (same pattern as `SUMMARIZER_PROMPT`, etc. from that plan). | | |

### Implementation Phase 4 — Backend System Prompt Injection

- GOAL-004: Modify `backend/ollama.py` and `backend/llama_server.py` so that every `/chat/` request augments the system prompt with the current `SOUL.md` content via `soul.inject()`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-021 | In `backend/ollama.py`, add `import soul` at the top. In the `chat()` handler, replace the line `messages.insert(0, {"role": "system", "content": SYSTEM_PROMPT})` with `messages.insert(0, {"role": "system", "content": soul.inject(SYSTEM_PROMPT)})`. This call happens per-request so a soul updated during a prior session's shutdown is automatically picked up on the next chat without a server restart. | | |
| TASK-022 | In `backend/llama_server.py`, perform the same modification as TASK-021: add `import soul`, wrap the `SYSTEM_PROMPT` insertion with `soul.inject(SYSTEM_PROMPT)`. | | |
| TASK-023 | In `backend/wikipedia_rag.py` `build_wiki_system_prompt()`: the Wikipedia mode prompt is a fully separate system message that replaces the standard system prompt for the duration of a wiki session. Soul injection here is intentional — STARLING should remain "itself" even in Wikipedia mode. Add `import soul` and wrap the final return value: `return soul.inject(_WIKI_SYSTEM_PROMPT_TEMPLATE.format(...))`. | | |

### Implementation Phase 5 — Frontend Soul Injection

- GOAL-005: Modify `frontend/app.js` to fetch `/soul` on startup and inject the soul content into `SYSTEM_PROMPT` so the frontend-driven conversation history also carries STARLING's personality.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-024 | In `frontend/app.js`, define `async function _loadSoul(): Promise<string>`. Uses `fetch(\`${BACKEND_BASE}/soul\`)` with a 5-second `AbortController` timeout. Returns the response text on success. On network error or timeout, logs a warning and returns `""` (empty string — soul injection silently fails, system prompt is used without soul augmentation). | | |
| TASK-025 | In `frontend/app.js`, change the `SYSTEM_PROMPT` declaration from `const` to `let`. After the existing `SYSTEM_PROMPT = _buildBootContext() + ' ' + '<persona>'` assignment, add an `async` init sequence that: (1) calls `const _soulContent = await _loadSoul()`; (2) if `_soulContent` is non-empty, appends `"\n\n---\n\n# STARLING Soul File\n\n" + _soulContent` to `SYSTEM_PROMPT`; (3) reinitialises `conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }]` after the append. This must occur before the first user interaction is possible (i.e., before the mic button is enabled or any auto-greeting fires). | | |
| TASK-026 | In `frontend/app.js`, the existing `DOMContentLoaded` handler or equivalent init function must be converted to `async` if it is not already, so that `await _loadSoul()` can be awaited. The mic button and any startup greeting must be deferred until after `_loadSoul()` resolves (or times out). | | |
| TASK-027 | If the prompt registry plan (`feature-prompt-registry-1.md`) is implemented concurrently: in `frontend/prompts.js`, extend `loadPrompts()` to also call `_loadSoul()` and store the soul content in the cache under the key `"STARLING_SOUL"`. `getPrompt("STARLING_SOUL")` would then return the soul content. This prevents two separate `fetch()` calls and consolidates startup fetching. This task is conditional on the prompt registry plan being implemented first; if not, `_loadSoul()` in `app.js` stands alone. | | |

### Implementation Phase 6 — Documentation and .gitignore

- GOAL-006: Update `.gitignore` to exclude soul archives, document the soul system in README.md, and register the `DREAM_SOUL_REVIEWER` prompt key in the prompt registry.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-028 | Add `backend/memory/soul/SOUL_*.md` to `.gitignore` (archives are excluded from git; the current `SOUL.md` should optionally be tracked — user's choice). Do NOT add `backend/memory/soul/SOUL.md` to `.gitignore` since the user may wish to commit it as a record of STARLING's current personality. | | |
| TASK-029 | Add a `## STARLING Soul` section to `README.md` explaining: (a) what `SOUL.md` is and where it lives; (b) how it is injected into every session; (c) how Pass 4 works and when updates occur; (d) how to view history (`GET /soul/history`), inspect diffs (`GET /soul/diff/{session_id}`), and roll back (`POST /soul/restore/{session_id}`); (e) how to manually edit `SOUL.md` in a text editor. | | |
| TASK-030 | If the prompt registry plan is implemented: add a `DREAM_SOUL_REVIEWER` entry to `backend/prompts.py` `_REGISTRY` with category `"dream"`, description `"System prompt for dream state Pass 4 — soul update reviewer. Determines whether SOUL.md should be updated after each session."`, default = the `SOUL_REVIEWER_PROMPT` string defined in TASK-016. In `backend/dream.py`, replace the local `SOUL_REVIEWER_PROMPT` constant with `prompts.get("DREAM_SOUL_REVIEWER")`. | | |

## 3. Alternatives

- **ALT-001**: **Store soul as a JSON file** (structured fields per section) rather than Markdown. Would enable per-field updates and merging. Rejected because: (a) the LLM produces natural prose better than structured JSON, (b) Markdown is directly human-readable and editable, (c) the soul file is injected as plaintext into the system prompt so structure is irrelevant to the consumer.
- **ALT-002**: **Append-only soul** — never overwrite, only append a "session delta" section after each session. Rejected because the soul would grow unbounded and repeat information. A full replacement with archiving provides cleaner context injection and a proper version history.
- **ALT-003**: **Vector database for soul traits** — embed individual facts about the user and retrieve the most relevant ones per query rather than injecting the full soul. Rejected as over-engineering for the current scale of the soul file (~500–2000 words). Full injection is simple and effective at this size. Can be revisited if the soul grows very large.
- **ALT-004**: **User-editable soul via the UI** — allow editing `SOUL.md` directly from the prompts panel (Phase 6 of the prompt registry plan). Partially deferred: the `GET /soul` endpoint enables this and the prompts panel could add a dedicated soul editor section in a future iteration. The restore endpoint also provides UI rollback support.
- **ALT-005**: **Run Pass 4 as a separate shutdown step in `scripts/stop.py`** rather than inside the FastAPI shutdown hook alongside the other dream state passes. Rejected for consistency — all four dream passes share the same timeout budget and error-recovery logic already built into `run_dream_state()`.
- **ALT-006**: **Use a small/fast dedicated model for Pass 4** (e.g., the same `DREAM_MODEL` override). This is already supported via the `DREAM_MODEL` env var inherited from the dream state plan. The reviewer prompt is explicit enough that a smaller model can handle it reliably.

## 4. Dependencies

- **DEP-001**: `backend/dream.py` — from `feature-dream-state-shutdown-pipeline-1.md`. Must be fully implemented before Phase 3 (TASK-016 through TASK-020). Pass 4 extends the existing three-pass pipeline, `DreamResult` dataclass, and `run_dream_state()` function.
- **DEP-002**: `backend/session_log.py` — from `feature-session-activity-logging-1.md`. Session IDs used for soul archive filenames are sourced from `session_log.get_session_id()` passed into `run_dream_state()`.
- **DEP-003**: `backend/prompts.py` — from `feature-prompt-registry-1.md`. TASK-030 registers `DREAM_SOUL_REVIEWER` in the prompt registry. This task is conditional; Phases 1–5 are fully functional without the prompt registry.
- **DEP-004**: `difflib` (stdlib) — used by `soul.diff()` for `unified_diff()`. No install required.
- **DEP-005**: `threading.Lock` (stdlib) — used by `soul.py` for concurrent-safe reads/writes.
- **DEP-006**: `httpx` (already in `requirements.txt`) — used by dream state's `_call_llm()` which Pass 4 calls indirectly.

## 5. Files

- **FILE-001**: `backend/soul.py` — **new file**. Soul management module: `_DEFAULT_SOUL`, `get()`, `update()`, `restore()`, `diff()`, `list_history()`, `inject()`.
- **FILE-002**: `backend/soul_routes.py` — **new file**. FastAPI router for `GET /soul`, `GET /soul/history`, `GET /soul/diff/{session_id}`, `POST /soul/restore/{session_id}`.
- **FILE-003**: `backend/main.py` — **modified**. Import and register `soul_routes.router`; call `soul._ensure_default()` in `startup_event()`.
- **FILE-004**: `backend/dream.py` — **modified**. Add `SOUL_REVIEWER_PROMPT`, `_run_pass4_soul_review()`, extend `DreamResult`, extend `run_dream_state()`.
- **FILE-005**: `backend/ollama.py` — **modified**. Add `import soul`; wrap system prompt insertion with `soul.inject()`.
- **FILE-006**: `backend/llama_server.py` — **modified**. Same as FILE-005.
- **FILE-007**: `backend/wikipedia_rag.py` — **modified**. Add `import soul`; wrap `build_wiki_system_prompt()` return value with `soul.inject()`.
- **FILE-008**: `frontend/app.js` — **modified**. Add `_loadSoul()` async function; append soul content to `SYSTEM_PROMPT` at init; convert init sequence to async.
- **FILE-009**: `backend/memory/soul/SOUL.md` — **new runtime file**. Created by `_ensure_default()` on first startup. Optionally tracked in git (not in `.gitignore`).
- **FILE-010**: `backend/memory/soul/SOUL_<session_id>.md` — **runtime archive** (excluded from git via `.gitignore` glob). One file created per soul update.
- **FILE-011**: `.gitignore` — **modified**. Add `backend/memory/soul/SOUL_*.md`.
- **FILE-012**: `README.md` — **modified**. Add `## STARLING Soul` section.
- **FILE-013**: `backend/prompts.py` — **conditionally modified** (Phase 6 TASK-030). Add `DREAM_SOUL_REVIEWER` entry.

## 6. Testing

- **TEST-001**: Delete `backend/memory/soul/SOUL.md` (if it exists). Start the backend. Verify `SOUL.md` is recreated with all five section headers (`## Identity`, `## Relationship with Daniel`, `## Communication Style`, `## Interests & Recurring Patterns`, `## Personal Philosophy`) and that `GET /soul` returns the default content.
- **TEST-002**: Start the backend. Send a `/chat/` request. Capture the system prompt from the session log's `llm_request` event (from the logging plan). Verify it contains the text `# STARLING Soul File` followed by the content of `SOUL.md`.
- **TEST-003**: Load the frontend. Open browser devtools and inspect the `conversationHistory` array (expose it via `window._conversationHistory = conversationHistory` for testing). Verify the first entry's `content` field contains the soul content appended to the persona.
- **TEST-004**: Complete a session with at least one interaction that reveals new information (e.g., state a new preference aloud). Trigger shutdown via `make down`. Verify that within `DREAM_TIMEOUT_S` seconds, either: (a) `SOUL.md` has been updated and a `SOUL_<session_id>.md` archive exists, or (b) no archive was created (if Pass 4 determined `NO_CHANGE`).
- **TEST-005**: Force Pass 4 to produce an update by running a session where the user explicitly states a novel preference (e.g., "I prefer concise responses about SQL to verbose ones"). Verify `SOUL.md`'s `## Interests & Recurring Patterns` section contains a reference to this preference after the dream state completes.
- **TEST-006**: Call `GET /soul/history`. Verify the response is a JSON array. After a soul update has occurred, verify the array contains at least one entry with `session_id`, `archived_at`, and `path_str` fields.
- **TEST-007**: Call `GET /soul/diff/{session_id}` for a valid session ID from the history. Verify the response is a non-empty unified diff string (contains `---` and `+++` lines).
- **TEST-008**: Call `POST /soul/restore/{session_id}` from localhost with a valid session ID. Verify HTTP 200, verify `SOUL.md` now contains the restored content, and verify a new archive was created for the "pre-restore" soul.
- **TEST-009**: Call `POST /soul/restore/{session_id}` from a non-localhost address. Verify HTTP 403.
- **TEST-010**: Manually edit `SOUL.md` to add a line under `## Personal Philosophy`. Restart the backend (no restart needed — soul is read per-request). Send a `/chat/` request. Verify the manually added line appears in the system prompt via the session log.
- **TEST-011**: Set `DREAM_PASS_TIMEOUT_S=1` and run a shutdown. Verify Pass 4 times out gracefully and `soul_updated: false` is returned in `DreamResult`, with `SOUL.md` unchanged.
- **TEST-012**: Simulate Pass 4 returning malformed output (LLM returns a string that does not start with `"# STARLING"`). Verify the sanity check in TASK-017 catches this, logs a warning, and does not modify `SOUL.md`.

## 7. Risks & Assumptions

- **RISK-001**: **LLM over-eagerness to update** — the LLM may update the soul on nearly every session even for routine interactions, leading to soul drift and bloat. The `SOUL_REVIEWER_PROMPT` (TASK-016) explicitly instructs conservatism, but this depends on the LLM respecting that instruction. Mitigation: users can inspect `GET /soul/history` and roll back with `POST /soul/restore/{session_id}` if the soul drifts in an unwanted direction.
- **RISK-002**: **Soul file size growth** — unrestricted LLM updates could produce increasingly long soul files, eventually bloating the system prompt context. The `MAX_SOUL_CHARS = 32,000` cap (TASK-002, TASK-005) provides a hard ceiling. The `SOUL_REVIEWER_PROMPT` instructs the LLM to preserve conciseness.
- **RISK-003**: **Pass 4 runs on an incomplete reflection** — if Pass 3 (Reflection) failed and wrote only an error notice, Pass 4 would receive the error notice text as input. The sanity check in TASK-019 skips Pass 4 if reflection text is empty or only contains error notices, mitigating this.
- **RISK-004**: **Frontend soul injection race condition** — if the backend is slow to respond to `GET /soul` and the user activates the mic before `_loadSoul()` resolves, the conversation will begin without soul content. The `AbortController` timeout in TASK-024 (5 seconds) and the requirement in TASK-026 to defer mic activation until after `_loadSoul()` resolves should eliminate this race.
- **RISK-005**: **Wikipedia mode soul injection changes model behaviour** — injecting the soul into the Wikipedia mode system prompt (TASK-023) means STARLING's personality bleeds into Wikipedia responses, which are supposed to be strictly source-grounded. This is an intentional design choice (STARLING should "sound like itself" even in article mode) but may cause unexpected tone if the soul develops quirky traits. The Wikipedia prompt rules still take priority for factual grounding.
- **ASSUMPTION-001**: `feature-dream-state-shutdown-pipeline-1.md` is fully implemented before this plan's Phase 3 (TASK-016–TASK-020) is executed. `dream.py`, `DreamResult`, `run_dream_state()`, and `DREAM_DIR` must all exist.
- **ASSUMPTION-002**: The LLM in use is capable of both writing coherent Markdown documents and reliably producing the exact sentinel string `NO_CHANGE` when no update is warranted. Models of `llama3.2:3b` capability or above should handle this reliably given explicit prompt instructions.
- **ASSUMPTION-003**: `SOUL.md` will remain small enough (under 2,000 words / ~3,000 tokens) for the foreseeable future that full injection into the system prompt does not meaningfully reduce the available context window for conversation.

## 8. Related Specifications / Further Reading

- [plan/feature-dream-state-shutdown-pipeline-1.md](feature-dream-state-shutdown-pipeline-1.md) — **prerequisite**; provides `dream.py`, `DreamResult`, `run_dream_state()`, `thoughts.md`, and the three-pass pipeline that Pass 4 extends
- [plan/feature-session-activity-logging-1.md](feature-session-activity-logging-1.md) — provides `session_log.get_session_id()` used as the archive filename key
- [plan/feature-prompt-registry-1.md](feature-prompt-registry-1.md) — Phase 6 TASK-030 registers `DREAM_SOUL_REVIEWER` in the registry; also provides `STARLING_PERSONA` key used in TASK-027
- [plan/feature-simple-on-off-launcher-1.md](feature-simple-on-off-launcher-1.md) — defines the session lifecycle (`make up` / `make down`) that triggers the dream state and soul review
- [backend/dream.py](../backend/dream.py) — file extended in Phase 3 (does not yet exist; created by the dream state plan)
- [backend/ollama.py](../backend/ollama.py) — modified in TASK-021 to inject soul per chat request
- [backend/llama_server.py](../backend/llama_server.py) — modified in TASK-022
- [Python difflib.unified_diff](https://docs.python.org/3/library/difflib.html#difflib.unified_diff) — used by `soul.diff()` for version comparison
