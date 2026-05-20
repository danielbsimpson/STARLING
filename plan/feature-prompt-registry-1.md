---
goal: Centralised Prompt Registry with Live UI Editor
version: '1.0'
date_created: 2026-05-19
last_updated: 2026-05-19
owner: simps
status: 'Planned'
tags: [feature, prompts, dx, architecture, ui, refactor]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Prompts and LLM instruction strings are currently scattered across eight files in the project (`ollama.py`, `llama_server.py`, `wikipedia_rag.py`, `dream.py`, `app.js`, `ideas-panel.js`, `journal-panel.js`, and several inline strings in `app.js`). This plan centralises every prompt into a single registry: a `backend/prompts.py` module with hardcoded defaults backed by a user-editable `memory/prompts.json` override file. A REST API exposes the full catalog for reading and writing. A `frontend/prompts.js` client fetches the catalog on startup, enabling the frontend to consume live values rather than compiled-in strings. Phase 6 (long-term) adds an in-UI prompt editor panel so the user can explore and edit all prompts without touching any source files.

## 1. Requirements & Constraints

- **REQ-001**: Every LLM instruction string in the project must be registered in `backend/prompts.py` with a unique string key, a human-readable description, a category tag, and a default value. No prompt may exist only in a source file without a registry entry.
- **REQ-002**: User overrides must be persisted to `backend/memory/prompts.json` (a flat `{key: value}` JSON object). On startup, the backend reads this file and merges overrides over defaults. Overrides survive restarts.
- **REQ-003**: `GET /prompts` must return the full catalog as a JSON array of objects: `{key, description, category, default_value, current_value, is_overridden, source_file, template_vars}`.
- **REQ-004**: `PUT /prompts/{key}` must accept `{"value": str}` and write the override to `memory/prompts.json`. Returns the updated entry.
- **REQ-005**: `DELETE /prompts/{key}` must remove the override for the given key (restoring the default). Returns the restored entry.
- **REQ-006**: Template prompts (those containing `{variable}` placeholders) must be stored as Python format strings. `prompts.get(key, **kwargs)` must call `.format(**kwargs)` when kwargs are supplied, returning the interpolated string.
- **REQ-007**: `frontend/prompts.js` must fetch `/prompts` on page load (once), cache all `current_value` strings in memory, and export `getPrompt(key, substitutions = {})` — returns the cached value with any substitution keys replaced, or the hardcoded fallback if the fetch fails.
- **REQ-008**: All frontend JS files (`app.js`, `ideas-panel.js`, `journal-panel.js`) must consume prompts via `getPrompt()` from `prompts.js` rather than hardcoded string literals.
- **REQ-009**: All backend Python modules (`ollama.py`, `llama_server.py`, `wikipedia_rag.py`, `dream.py`) must read prompt values via `prompts.get(key)` rather than hardcoded string literals or env-var defaults.
- **REQ-010**: Phase 6 — a `#prompts-panel` in `frontend/index.html` must list all registered prompts grouped by category, display each with a textarea for editing, and provide Save and Reset buttons that call the API.
- **SEC-001**: `PUT /prompts/{key}` and `DELETE /prompts/{key}` must validate that the key exists in the registry (allowlist). Reject unknown keys with HTTP 422 to prevent arbitrary file writes.
- **SEC-002**: Prompt values accepted via `PUT /prompts/{key}` must be limited to 16,000 characters. Reject larger values with HTTP 413.
- **SEC-003**: The `PUT` and `DELETE` endpoints must be accessible only from localhost (same guard used by `/log/` and `/dream/` endpoints).
- **CON-001**: Must not require new Python packages. Uses only stdlib (`json`, `pathlib`, `copy`, `threading`) plus `fastapi` and `pydantic` already in `requirements.txt`.
- **CON-002**: The `prompts.py` module must be importable at module load time with zero side effects (no network calls, no file writes). File reads occur only when `load_overrides()` is explicitly called from `main.py` startup.
- **CON-003**: Template variables used in `{variable}` format strings must not be removed from any prompt default without updating every call site that passes them via `prompts.get(key, **kwargs)`.
- **CON-004**: Phase 6 (UI Editor) is explicitly marked as a separate deliverable. Phases 1–5 deliver the backend registry and client-side consumption. Phase 6 may be deferred without affecting Phase 1–5 functionality.
- **GUD-001**: Prompt keys must use SCREAMING_SNAKE_CASE and be grouped by category prefix: `STARLING_*` (core persona), `WIKI_*` (Wikipedia mode), `JOURNAL_*` (journal feature), `IDEAS_*` (ideas feature), `BROWSER_*` (browser panel), `DOSSIER_*` (dossier/presentation mode), `TOOL_*` (tool error/status messages), `DREAM_*` (dream state pipeline).
- **GUD-002**: Each prompt entry's `source_file` field documents the original file where the string was hardcoded before this refactor, providing a migration trail.
- **GUD-003**: The `frontend/prompts.js` module must include hardcoded fallback strings for every prompt key it uses, so the frontend degrades gracefully if the backend is unreachable at page load.
- **PAT-001**: Follow the existing atomic-write pattern from `ideas_routes.py` when persisting `prompts.json`: write to `.tmp` then rename.
- **PAT-002**: Follow the existing module-level singleton pattern (as in `session_log.py` from the logging plan) — `prompts.py` holds a `_registry` dict and an `_overrides` dict as module globals protected by a `threading.Lock`.

## 2. Implementation Steps

### Implementation Phase 1 — Backend Prompts Registry Module

- GOAL-001: Create `backend/prompts.py` — the authoritative registry of all LLM prompt strings. Defines defaults, loads user overrides from disk, and exposes `get()` / `set()` / `reset()` as the public API.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `backend/prompts.py`. Define `OVERRIDES_FILE = Path(os.getenv("PROMPTS_FILE", "memory/prompts.json"))` and `MAX_PROMPT_CHARS = 16_000`. Define `_lock = threading.Lock()` and `_overrides: dict[str, str] = {}` as module globals. | | |
| TASK-002 | In `prompts.py`, define `_REGISTRY: list[dict]` — a list of entry dicts. Each entry has exactly these keys: `key` (str), `description` (str), `category` (str), `default` (str), `source_file` (str), `template_vars` (list[str]). Populate with all 20 prompt entries defined in the Full Prompt Catalog table below (TASK-003 through TASK-022). | | |
| TASK-003 | Register `STARLING_CORE` — category `"starling"`, description `"Minimal backend identity prompt sent with every Ollama/llama-server chat request"`, default = `"You are S.T.A.R.L.I.N.G. (Speech‑Triggered Autonomous Reasoning & Local Intelligence Node Generator), a highly capable local AI assistant. Be concise, precise, and direct. Avoid unnecessary pleasantries."`, source_file `"backend/ollama.py, backend/llama_server.py"`, template_vars `[]`. | | |
| TASK-004 | Register `STARLING_PERSONA` — category `"starling"`, description `"Full frontend persona: identity, pipeline description, visual form, speech rules. Assembled into SYSTEM_PROMPT in app.js."`, default = the full multi-line string currently assembled in `frontend/app.js` lines 297–319 (the non-dynamic portion, excluding `_buildBootContext()`), template_vars `[]`. | | |
| TASK-005 | Register `WIKI_ARTICLE_MODE` — category `"wiki"`, description `"System prompt for Wikipedia Article Mode. Injected with article title and excerpts when a wiki session begins."`, default = the full `_WIKI_SYSTEM_PROMPT_TEMPLATE` string from `backend/wikipedia_rag.py` lines 236–268, template_vars `["title", "excerpts"]`. | | |
| TASK-006 | Register `JOURNAL_SUMMARIZE` — category `"journal"`, description `"User-turn prompt template for summarising a dictated journal entry. Injected with date, time, and raw transcript."`, default = the prompt string assembled in `frontend/journal-panel.js` lines 267–277 (excluding the dynamic dateLine/timeLine/rawTranscript values), template_vars `["date_line", "time_line", "raw_transcript"]`. | | |
| TASK-007 | Register `JOURNAL_INTERVIEWER` — category `"journal"`, description `"System prompt for the journal interview conductor. Defines domain order, rules, and question limits."`, default = the full `interviewSystemPrompt` string from `frontend/journal-panel.js` lines 451–484 (excluding dynamic `_interviewQACount` / `MAX_INTERVIEW_QUESTIONS` interpolation), template_vars `["question_number", "max_questions", "min_questions_reached_instruction"]`. | | |
| TASK-008 | Register `IDEAS_TITLE_TAGS` — category `"ideas"`, description `"User-turn prompt template for generating a title and tags for a captured idea."`, default = the prompt assembled in `frontend/ideas-panel.js` lines 133–137, template_vars `["raw_text"]`. | | |
| TASK-009 | Register `BROWSER_OPENED` — category `"browser"`, description `"Spoken confirmation when the browser panel opens a page. Template receives the page label."`, default = `"The user has opened {page_label} in the browser panel. In two or three natural spoken sentences: confirm the page is open and that you are reading its content, then let the user know they can ask you to summarize it, answer questions about it, or explain anything on the page."`, template_vars `["page_label"]`. | | |
| TASK-010 | Register `BROWSER_CONTEXT_LOADED` — category `"browser"`, description `"Injected as extraContext when the browser panel has readable page text."`, default = `"The user is currently viewing a webpage in the browser panel. The full text content of that page is provided below. When the user asks you to summarize, explain, analyse, or answer questions, use this page content as your primary source — do not rely on prior knowledge unless the page content is insufficient.\n\nPAGE CONTENT:\n{page_text}"`, template_vars `["page_text"]`. | | |
| TASK-011 | Register `BROWSER_CONTEXT_SPA` — category `"browser"`, description `"Injected when the browser panel shows a JS-rendered SPA whose content cannot be extracted."`, default = `"The user has a browser panel open showing: {url}. This page is a JavaScript single-page application (SPA). The backend fetched its HTML but received no readable text content because the page renders entirely in the browser via JS. You cannot read, summarize, or describe its actual content. Explicitly tell the user that this page uses client-side JavaScript rendering and its content cannot be extracted. Do NOT guess or fabricate what the page might contain."`, template_vars `["url"]`. | | |
| TASK-012 | Register `BROWSER_CONTEXT_FAIL` — category `"browser"`, description `"Injected when the browser panel page text could not be retrieved."`, default = `"The user has a browser panel open showing: {url}. The page content could not be read (the backend fetch failed or returned no text). Tell the user you were unable to read the page — do NOT guess or fabricate its contents."`, template_vars `["url"]`. | | |
| TASK-013 | Register `DOSSIER_NO_SUBJECT` — category `"dossier"`, description `"Spoken when dossier is triggered but no subject name was captured."`, default = `"Inform the user that no subject was specified and you were unable to retrieve a dossier. Keep it to one sentence."`, template_vars `[]`. | | |
| TASK-014 | Register `DOSSIER_NOT_FOUND` — category `"dossier"`, description `"Spoken when dossier is triggered but no matching dossier file could be located."`, default = `"Inform the user that no dossier was found for this subject and the records could not be located. Keep it to one sentence."`, template_vars `[]`. | | |
| TASK-015 | Register `WIKI_SECTION_NOT_FOUND` — category `"wiki"`, description `"Spoken when a requested Wikipedia section does not exist in the open article."`, default = `"Inform the user that the section \"{section_name}\" was not found in the current Wikipedia article.{available_sections_hint} Keep it to two sentences."`, template_vars `["section_name", "available_sections_hint"]`. | | |
| TASK-016 | Register `WIKI_SECTION_NETWORK_ERROR` — category `"wiki"`, description `"Spoken when the Wikipedia section fetch fails due to a network error."`, default = `"Inform the user that you were unable to retrieve the requested Wikipedia section due to a network error. One sentence."`, template_vars `[]`. | | |
| TASK-017 | Register `TOOL_WEATHER_UNAVAILABLE` — category `"tool"`, description `"Spoken when weather data could not be retrieved."`, default = `"Inform the user that weather data could not be retrieved right now. One sentence."`, template_vars `[]`. | | |
| TASK-018 | Register `TOOL_MARKET_UNAVAILABLE` — category `"tool"`, description `"Spoken when market/stock data could not be retrieved."`, default = `"Inform the user that market data could not be retrieved right now. One sentence."`, template_vars `[]`. | | |
| TASK-019 | Register `TOOL_NEWS_UNAVAILABLE` — category `"tool"`, description `"Spoken when news feeds could not be reached."`, default = `"Inform the user that the news feeds could not be reached right now. One sentence."`, template_vars `[]`. | | |
| TASK-020 | Register `DREAM_SUMMARIZER` — category `"dream"`, description `"System prompt for dream state Pass 1 — session summarizer."`, default = the `SUMMARIZER_PROMPT` constant defined in `backend/dream.py` (from the dream state plan, Phase 1 TASK-003), template_vars `[]`. | | |
| TASK-021 | Register `DREAM_FACT_EXTRACTOR` — category `"dream"`, description `"System prompt for dream state Pass 2 — user and world fact extractor."`, default = the `FACT_EXTRACTOR_PROMPT` constant defined in `backend/dream.py`, template_vars `[]`. | | |
| TASK-022 | Register `DREAM_REFLECTION` — category `"dream"`, description `"System prompt for dream state Pass 3 — first-person session reflection writer."`, default = the `REFLECTION_PROMPT` constant defined in `backend/dream.py`, template_vars `[]`. | | |
| TASK-023 | In `prompts.py`, build `_INDEX: dict[str, dict]` = `{entry["key"]: entry for entry in _REGISTRY}` at module load time, for O(1) key lookup. | | |
| TASK-024 | In `prompts.py`, implement `def load_overrides() -> None`. Reads `OVERRIDES_FILE` (returns silently if file does not exist). Parses JSON. For each key in the parsed dict: validates key is in `_INDEX`, validates value length ≤ `MAX_PROMPT_CHARS`. Valid entries are stored in `_overrides` under `_lock`. Invalid keys are logged to stderr and skipped. | | |
| TASK-025 | In `prompts.py`, implement `def get(key: str, **kwargs) -> str`. Acquires `_lock`. Returns `_overrides.get(key, _INDEX[key]["default"])`. Raises `KeyError` if key not in `_INDEX`. If `kwargs` provided, calls `.format(**kwargs)` on the result before returning. | | |
| TASK-026 | In `prompts.py`, implement `def set(key: str, value: str) -> None`. Validates key in `_INDEX`. Validates `len(value) <= MAX_PROMPT_CHARS`. Acquires `_lock`, updates `_overrides[key]`. Calls `_persist()`. | | |
| TASK-027 | In `prompts.py`, implement `def reset(key: str) -> None`. Validates key in `_INDEX`. Acquires `_lock`, removes key from `_overrides` if present. Calls `_persist()`. | | |
| TASK-028 | In `prompts.py`, implement `def _persist() -> None` (private). Serialises `_overrides` to JSON. Writes atomically to `OVERRIDES_FILE` using the `.tmp` → rename pattern. Creates parent directories if needed. | | |
| TASK-029 | In `prompts.py`, implement `def catalog() -> list[dict]`. Returns a list of dicts for every entry in `_REGISTRY`, each augmented with `current_value` (override if present, else default) and `is_overridden` (bool). | | |

### Implementation Phase 2 — Prompts API Endpoints

- GOAL-002: Create `backend/prompt_routes.py` — a FastAPI router exposing `GET /prompts`, `PUT /prompts/{key}`, `DELETE /prompts/{key}`, and `POST /prompts/reload` to allow runtime inspection and editing of the prompt registry.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-030 | Create `backend/prompt_routes.py`. Define `router = APIRouter(prefix="/prompts", tags=["prompts"])`. Import `prompts`. | | |
| TASK-031 | In `prompt_routes.py`, implement `GET /prompts` — calls `prompts.catalog()` and returns the list as JSON. No localhost restriction (read-only, non-sensitive). Optionally accepts `?category=<name>` query param to filter by category. | | |
| TASK-032 | In `prompt_routes.py`, define Pydantic model `PromptUpdate(BaseModel): value: str`. Implement `PUT /prompts/{key}` — applies localhost guard; validates `key` exists in `prompts._INDEX` (HTTP 422 if not); validates `len(value) <= 16000` (HTTP 413 if exceeded); calls `prompts.set(key, value)`; returns the updated catalog entry for `key`. | | |
| TASK-033 | In `prompt_routes.py`, implement `DELETE /prompts/{key}` — applies localhost guard; validates key exists (HTTP 422 if not); calls `prompts.reset(key)`; returns the reset catalog entry for `key` with `is_overridden: false`. | | |
| TASK-034 | In `prompt_routes.py`, implement `POST /prompts/reload` — applies localhost guard; calls `prompts.load_overrides()`; returns `{"ok": true, "overrides_loaded": count}`. Allows hot-reloading `prompts.json` if the user edited it manually. | | |
| TASK-035 | In `backend/main.py`, import `prompt_routes` and call `app.include_router(prompt_routes.router)`. In `startup_event()`, call `prompts.load_overrides()` so user overrides are active before the first request is served. | | |

### Implementation Phase 3 — Backend Module Refactoring

- GOAL-003: Replace all hardcoded prompt strings in backend Python modules with `prompts.get(key)` calls. No prompt text may remain hardcoded in any module other than `prompts.py`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-036 | In `backend/ollama.py`: remove the `SYSTEM_PROMPT = os.getenv(...)` constant (lines 13–16). Add `import prompts` at the top. Replace every reference to `SYSTEM_PROMPT` with `prompts.get("STARLING_CORE")`. Remove the `OLLAMA_SYSTEM_PROMPT` env-var dependency (it is superseded by the overrides file). | | |
| TASK-037 | In `backend/llama_server.py`: perform the same substitution as TASK-036, replacing `SYSTEM_PROMPT` with `prompts.get("STARLING_CORE")`. Remove the `LLAMA_SYSTEM_PROMPT` env-var dependency. | | |
| TASK-038 | In `backend/wikipedia_rag.py`: remove `_WIKI_SYSTEM_PROMPT_TEMPLATE` (lines 236–268). Add `import prompts`. In `build_wiki_system_prompt()`, replace `_WIKI_SYSTEM_PROMPT_TEMPLATE.format(title=..., excerpts=...)` with `prompts.get("WIKI_ARTICLE_MODE", title=session.article_title, excerpts=excerpts_text)`. | | |
| TASK-039 | In `backend/dream.py` (from the dream state plan): replace the three prompt constant definitions (`SUMMARIZER_PROMPT`, `FACT_EXTRACTOR_PROMPT`, `REFLECTION_PROMPT`) with `import prompts` and replace all references with `prompts.get("DREAM_SUMMARIZER")`, `prompts.get("DREAM_FACT_EXTRACTOR")`, `prompts.get("DREAM_REFLECTION")`. | | |

### Implementation Phase 4 — Frontend Prompts Client Module

- GOAL-004: Create `frontend/prompts.js` — a module that fetches the prompt catalog from `/prompts` at page load, caches all current values, and exports `getPrompt(key, substitutions)` with hardcoded fallbacks for every key used by the frontend.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-040 | Create `frontend/prompts.js`. Import `BACKEND_BASE` from `'./config.js'`. Define `_cache: Map<string, string>` as module-level variable (empty at load). | | |
| TASK-041 | In `prompts.js`, define `_FALLBACKS: Record<string, string>` — a plain object containing hardcoded fallback strings for every key consumed by the frontend: `STARLING_PERSONA`, `JOURNAL_SUMMARIZE`, `JOURNAL_INTERVIEWER`, `IDEAS_TITLE_TAGS`, `BROWSER_OPENED`, `BROWSER_CONTEXT_LOADED`, `BROWSER_CONTEXT_SPA`, `BROWSER_CONTEXT_FAIL`, `DOSSIER_NO_SUBJECT`, `DOSSIER_NOT_FOUND`, `WIKI_SECTION_NOT_FOUND`, `WIKI_SECTION_NETWORK_ERROR`, `TOOL_WEATHER_UNAVAILABLE`, `TOOL_MARKET_UNAVAILABLE`, `TOOL_NEWS_UNAVAILABLE`. Each fallback value must be identical to the corresponding `default` in `prompts.py`. | | |
| TASK-042 | In `prompts.js`, implement `export async function loadPrompts(): Promise<void>`. Calls `fetch(\`${BACKEND_BASE}/prompts\`)`. On success, iterates the JSON array and populates `_cache` with `entry.key → entry.current_value`. On network error, logs a warning and continues (fallbacks will be used). | | |
| TASK-043 | In `prompts.js`, implement `export function getPrompt(key: string, substitutions: Record<string, string> = {}): string`. Returns `_cache.get(key) ?? _FALLBACKS[key] ?? ""`. Then applies each key in `substitutions` by replacing `"{key}"` occurrences in the result string. | | |
| TASK-044 | In `prompts.js`, implement `export async function setPrompt(key: string, value: string): Promise<void>`. Calls `PUT /prompts/{key}` with `{"value": value}`. On success, updates `_cache.set(key, value)`. | | |
| TASK-045 | In `prompts.js`, implement `export async function resetPrompt(key: string): Promise<void>`. Calls `DELETE /prompts/{key}`. On success, removes key from `_cache` (fallback will be used until next `loadPrompts()`). | | |
| TASK-046 | In `frontend/app.js`, import `loadPrompts, getPrompt` from `'./prompts.js'`. Add `await loadPrompts()` as the first operation inside the existing `DOMContentLoaded` / page-init function, before `SYSTEM_PROMPT` is referenced. | | |

### Implementation Phase 5 — Frontend Module Refactoring

- GOAL-005: Replace every hardcoded LLM instruction string in `app.js`, `ideas-panel.js`, and `journal-panel.js` with `getPrompt()` calls. After this phase, no LLM instruction string may be hardcoded in any frontend file other than as a fallback in `prompts.js`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-047 | In `frontend/app.js`: change `const SYSTEM_PROMPT = _buildBootContext() + ' ' + '<hardcoded_string>'` (lines 288–320) to `const SYSTEM_PROMPT = _buildBootContext() + ' ' + getPrompt('STARLING_PERSONA')`. The `_buildBootContext()` function remains unchanged (it generates runtime-dynamic date/time/model context and is not a prompt that needs user editing). | | |
| TASK-048 | In `frontend/app.js` `enterPresMode()`: replace the inline string `'Inform the user that no subject was specified and you were unable to retrieve a dossier. Keep it to one sentence.'` (line 195) with `getPrompt('DOSSIER_NO_SUBJECT')`. | | |
| TASK-049 | In `frontend/app.js` `enterPresMode()`: replace the inline string `'Inform the user that no dossier was found for this subject and the records could not be located. Keep it to one sentence.'` (line 232) with `getPrompt('DOSSIER_NOT_FOUND')`. | | |
| TASK-050 | In `frontend/app.js` browser-opened handler (line 1792–1794): replace the inline template string with `getPrompt('BROWSER_OPENED', { page_label: _browserTrigger.label })`. | | |
| TASK-051 | In `frontend/app.js` browser context injection block (lines 1848–1873): replace the three inline context strings with `getPrompt('BROWSER_CONTEXT_LOADED', { page_text: _pageCtx })`, `getPrompt('BROWSER_CONTEXT_SPA', { url: getBrowserPageUrl() })`, and `getPrompt('BROWSER_CONTEXT_FAIL', { url: getBrowserPageUrl() })` respectively. | | |
| TASK-052 | In `frontend/app.js` wiki-section handler (lines 1830, 1837): replace the two inline strings with `getPrompt('WIKI_SECTION_NOT_FOUND', { section_name: _wikiSection, available_sections_hint: _available })` and `getPrompt('WIKI_SECTION_NETWORK_ERROR')`. | | |
| TASK-053 | In `frontend/app.js` tool-error handlers (lines 1717, 1750, 1778): replace the three inline one-sentence error strings with `getPrompt('TOOL_WEATHER_UNAVAILABLE')`, `getPrompt('TOOL_MARKET_UNAVAILABLE')`, `getPrompt('TOOL_NEWS_UNAVAILABLE')`. | | |
| TASK-054 | In `frontend/ideas-panel.js`: add `import { getPrompt } from './prompts.js'` at the top. In `processIdea()`, replace the multi-line `const prompt = \`Generate a concise...\`` (lines 132–137) with `const prompt = getPrompt('IDEAS_TITLE_TAGS', { raw_text: rawText })`. Remove the `systemPrompt` parameter from the function signature (it is now read from the registry). Update the call site in `app.js` line 1522 accordingly. | | |
| TASK-055 | In `frontend/journal-panel.js`: add `import { getPrompt } from './prompts.js'` at the top. In `submitJournalEntry()`, replace the `const prompt = ...` multi-line journal summarize string with `const prompt = getPrompt('JOURNAL_SUMMARIZE', { date_line: dateLine, time_line: timeLine, raw_transcript: rawTranscript })`. | | |
| TASK-056 | In `frontend/journal-panel.js` `_generateNextQuestion()`: replace the `interviewSystemPrompt` multi-line string (lines 450–484) with `getPrompt('JOURNAL_INTERVIEWER', { question_number: String(_interviewQACount + 1), max_questions: String(MAX_INTERVIEW_QUESTIONS), min_questions_reached_instruction: (_interviewQACount >= MIN_INTERVIEW_QUESTIONS ? "If you have gathered at least one substantive answer across three or more different domains, respond with exactly the single word DONE. Otherwise ask one question on the most important uncovered domain.\n" : "") })`. | | |

### Implementation Phase 6 — In-UI Prompt Editor Panel (Long-term)

- GOAL-006: Add a `#prompts-panel` to `frontend/index.html` that lists all registered prompts grouped by category, allows inline editing via textarea elements, and saves/resets prompts via the API — giving the user full control over all LLM instructions from within the UI.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-057 | In `frontend/index.html`, add a `<section id="prompts-panel" class="side-panel hidden">` block after the existing side panels. Include: a header with title "PROMPT REGISTRY" and a close button; a `<div id="prompts-list">` container for dynamically rendered prompt cards; a global "Reload Defaults" button that calls `POST /prompts/reload`. | | |
| TASK-058 | In `frontend/style.css`, add styles for `#prompts-panel`, `.prompt-card`, `.prompt-card-key`, `.prompt-card-description`, `.prompt-card-textarea`, `.prompt-card-actions`. Cards must be visually distinct when `is_overridden: true` (e.g., left border accent colour). Textarea must resize vertically. | | |
| TASK-059 | Create `frontend/prompts-panel.js`. Export `openPromptsPanel()` and `closePromptsPanel()`. On open: fetch `/prompts`, render one `.prompt-card` per entry grouped under category headings. Each card contains: key (read-only label), description (small text), a `<textarea>` pre-filled with `current_value`, a Save button (calls `setPrompt(key, value)` and re-renders the card), and a Reset button (calls `resetPrompt(key)` and re-renders). | | |
| TASK-060 | In `frontend/app.js`, add a voice trigger for the prompt editor: if the transcript matches `/\b(?:open|show|edit)\b.{0,20}\bprompt(?:s)?\b.*\b(?:editor|registry|panel|settings)\b/i`, call `openPromptsPanel()`. | | |
| TASK-061 | In `toolkit/TRIGGER_PHRASES.md`, add a new section `## 19 · Prompt Editor` documenting the trigger phrase, example utterances, and the action (opens `#prompts-panel`). Update the dispatch priority table to include Priority 19. | | |

## 3. Alternatives

- **ALT-001**: **Environment variables for all prompts** — each prompt becomes an env var in `.env`. Rejected because `.env` is not designed for multi-line strings, does not support structured metadata (description, category, template_vars), and requires a restart to change. The `prompts.json` override file allows live edits via API without restart.
- **ALT-002**: **One Markdown file per prompt** (e.g., `prompts/STARLING_PERSONA.md`) — human-readable, git-diffable, easy to edit in any text editor. Rejected because the frontend cannot `fetch()` individual files in the same way (no directory listing without a server endpoint), and the API catalog approach provides metadata alongside values in a single request.
- **ALT-003**: **YAML file for the registry** — YAML supports multi-line strings cleanly and is commonly used for config. Rejected because the project has no existing YAML dependency, and Python dicts in `prompts.py` are self-documenting and type-checkable without a parser.
- **ALT-004**: **Store all prompts frontend-only in `localStorage`** — would allow the UI editor without a backend API. Rejected because backend prompts (`STARLING_CORE`, `WIKI_ARTICLE_MODE`, dream state prompts) must be readable from Python processes; localStorage is inaccessible from the backend.
- **ALT-005**: **Dedicated SQLite table for prompts** — supports queries, history, versioning. Rejected as over-engineering for a small flat registry; a JSON file is sufficient and human-readable.

## 4. Dependencies

- **DEP-001**: `backend/dream.py` — from the dream state plan (`feature-dream-state-shutdown-pipeline-1.md`). TASK-039 modifies `dream.py` to consume prompts from the registry. `dream.py` must exist before TASK-039 is executed.
- **DEP-002**: `backend/session_log.py` — from the logging plan. `prompts.load_overrides()` is called in `startup_event()` alongside `session_log.log_session_start()`.
- **DEP-003**: `fastapi` and `pydantic` — already in `requirements.txt`. Used by `prompt_routes.py`.
- **DEP-004**: `frontend/config.js` — already exists. Provides `BACKEND_BASE` imported by `prompts.js`.
- **DEP-005**: `threading` (stdlib) — used by `prompts.py` for the `_lock` protecting `_overrides`.

## 5. Files

- **FILE-001**: `backend/prompts.py` — **new file**. Central prompt registry with defaults, override loading, `get()`, `set()`, `reset()`, `catalog()`.
- **FILE-002**: `backend/prompt_routes.py` — **new file**. FastAPI router for `/prompts` CRUD endpoints.
- **FILE-003**: `backend/main.py` — **modified**. Import `prompt_routes`, register router, call `prompts.load_overrides()` in startup.
- **FILE-004**: `backend/ollama.py` — **modified**. Replace `SYSTEM_PROMPT` constant with `prompts.get("STARLING_CORE")`.
- **FILE-005**: `backend/llama_server.py` — **modified**. Replace `SYSTEM_PROMPT` constant with `prompts.get("STARLING_CORE")`.
- **FILE-006**: `backend/wikipedia_rag.py` — **modified**. Replace `_WIKI_SYSTEM_PROMPT_TEMPLATE` and `build_wiki_system_prompt()` with `prompts.get("WIKI_ARTICLE_MODE", ...)`.
- **FILE-007**: `backend/dream.py` — **modified**. Replace three prompt constants with `prompts.get()` calls.
- **FILE-008**: `frontend/prompts.js` — **new file**. Prompt cache client with `loadPrompts()`, `getPrompt()`, `setPrompt()`, `resetPrompt()`, and fallback strings.
- **FILE-009**: `frontend/app.js` — **modified**. Import `loadPrompts`, `getPrompt`; replace `SYSTEM_PROMPT` build and all inline prompt strings.
- **FILE-010**: `frontend/ideas-panel.js` — **modified**. Replace inline `prompt` string with `getPrompt('IDEAS_TITLE_TAGS', ...)`.
- **FILE-011**: `frontend/journal-panel.js` — **modified**. Replace `JOURNAL_SUMMARIZE` and `JOURNAL_INTERVIEWER` inline strings.
- **FILE-012**: `frontend/index.html` — **modified (Phase 6)**. Add `#prompts-panel` section.
- **FILE-013**: `frontend/style.css` — **modified (Phase 6)**. Add prompt panel and card styles.
- **FILE-014**: `frontend/prompts-panel.js` — **new file (Phase 6)**. Prompt editor panel renderer.
- **FILE-015**: `toolkit/TRIGGER_PHRASES.md` — **modified (Phase 6)**. Add Priority 19 prompt editor trigger.
- **FILE-016**: `backend/memory/prompts.json` — **runtime artifact** (not tracked in git). Created by `_persist()` on first `PUT /prompts/{key}` call. Add to `.gitignore`.

## 6. Testing

- **TEST-001**: Start the backend. Call `GET /prompts`. Verify the response is a JSON array with exactly 20 entries (one per registered key in TASK-003 through TASK-022). Verify each entry has `key`, `description`, `category`, `default_value`, `current_value`, `is_overridden`, `source_file`, `template_vars` fields.
- **TEST-002**: Call `PUT /prompts/STARLING_CORE` with `{"value": "You are a test assistant."}`. Verify HTTP 200 and `is_overridden: true`. Restart the backend. Verify `GET /prompts` still returns `current_value: "You are a test assistant."` (override persisted to `prompts.json`).
- **TEST-003**: Send a chat message after the TASK-002 override. Verify the backend uses the overridden `STARLING_CORE` value by observing the session log's `llm_request` event (from the logging plan).
- **TEST-004**: Call `DELETE /prompts/STARLING_CORE`. Verify HTTP 200 and `is_overridden: false` and `current_value` equals the original default string.
- **TEST-005**: Call `PUT /prompts/NONEXISTENT_KEY` with any value. Verify HTTP 422 is returned and `prompts.json` is unchanged.
- **TEST-006**: Call `PUT /prompts/STARLING_CORE` with a value of 16,001 characters. Verify HTTP 413 is returned.
- **TEST-007**: Call `PUT /prompts/STARLING_CORE` from a non-localhost address. Verify HTTP 403 is returned.
- **TEST-008**: Load the frontend. Open browser devtools network tab and verify a `GET /prompts` request is made on page load. Verify `SYSTEM_PROMPT` in `app.js` (logged to console or inspected via devtools) contains the content from `STARLING_PERSONA` registry entry.
- **TEST-009**: Override `TOOL_WEATHER_UNAVAILABLE` to `"Weather is broken, sorry."`. Trigger a weather error in the frontend. Verify the LLM is sent the overridden string rather than the default.
- **TEST-010**: Open the prompts panel (Phase 6) via voice trigger "open prompt editor". Verify all 20 prompt cards render, overridden prompts have the accent border, and editing a card's textarea and clicking Save updates the `_cache` and calls the API.

## 7. Risks & Assumptions

- **RISK-001**: **Template variable mismatch** — if a user edits a template prompt (e.g., `WIKI_ARTICLE_MODE`) and removes a `{variable}` placeholder that is still expected by the call site in `build_wiki_system_prompt()`, Python's `.format()` call will raise `KeyError`. Mitigation: `prompts.get()` should catch `KeyError` during `.format(**kwargs)` and fall back to returning the unformatted template string, logging a warning.
- **RISK-002**: **`prompts.json` manual edits with invalid JSON** — if the user edits `prompts.json` directly (not via API) and introduces a syntax error, `load_overrides()` will fail silently and fall back to all defaults. This is safe but may be confusing. Mitigation: `load_overrides()` should print a clear error message to stderr when JSON parsing fails.
- **RISK-003**: **Frontend `loadPrompts()` blocking render** — if the backend is slow to respond, `await loadPrompts()` at the start of init could delay the page becoming interactive. Mitigation: add a 3-second `AbortController` timeout to the fetch; on timeout, fall back to `_FALLBACKS` immediately and continue init.
- **RISK-004**: **Backend/frontend prompt divergence** — if a developer edits a hardcoded fallback in `prompts.js` but forgets to update the corresponding default in `prompts.py`, the backend and frontend will have different defaults. Mitigation: enforce in code review that every change to a `_FALLBACKS` entry in `prompts.js` has a corresponding change in `prompts.py`.
- **ASSUMPTION-001**: The `dream.py` module from the dream state plan exists before Phase 3 TASK-039 is executed. If `dream.py` does not yet exist, TASK-039 can be deferred until that plan is implemented.
- **ASSUMPTION-002**: The `systemPrompt` parameter currently passed to `processIdea()` and several journal functions (which thread `SYSTEM_PROMPT` from `app.js`) will be removed after Phase 5 refactoring, as these functions will read from the registry directly. All call sites in `app.js` must be updated accordingly.
- **ASSUMPTION-003**: Adding `await loadPrompts()` to the `app.js` init sequence is safe because the backend is expected to be running (started by `make up`) before the frontend is accessed.

## 8. Related Specifications / Further Reading

- [plan/feature-session-activity-logging-1.md](feature-session-activity-logging-1.md) — `main.py` startup hook is also modified in this plan; changes must be coordinated
- [plan/feature-dream-state-shutdown-pipeline-1.md](feature-dream-state-shutdown-pipeline-1.md) — `dream.py` is modified in Phase 3 TASK-039; must be implemented first
- [backend/ollama.py](../backend/ollama.py) — current home of `STARLING_CORE` default (lines 13–16)
- [backend/llama_server.py](../backend/llama_server.py) — duplicate of `STARLING_CORE` (lines 20–23)
- [backend/wikipedia_rag.py](../backend/wikipedia_rag.py) — current home of `WIKI_ARTICLE_MODE` (lines 236–281)
- [frontend/app.js](../frontend/app.js) — current home of `STARLING_PERSONA` (lines 288–319) and all inline tool prompt strings
- [frontend/journal-panel.js](../frontend/journal-panel.js) — current home of `JOURNAL_SUMMARIZE` (line 267) and `JOURNAL_INTERVIEWER` (line 450)
- [frontend/ideas-panel.js](../frontend/ideas-panel.js) — current home of `IDEAS_TITLE_TAGS` (lines 132–137)
- [FastAPI APIRouter docs](https://fastapi.tiangolo.com/tutorial/bigger-applications/)
