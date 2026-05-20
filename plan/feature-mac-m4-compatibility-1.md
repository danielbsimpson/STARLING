---
goal: Make S.T.A.R.L.I.N.G. compatible with macOS Apple Silicon (M4 Mac Mini) while preserving Windows/NVIDIA CUDA support
version: 1.0
date_created: 2026-05-20
last_updated: 2026-05-20
owner: Daniel Simpson
status: 'Planned'
tags: [feature, infrastructure, cross-platform, apple-silicon, macos]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan makes S.T.A.R.L.I.N.G. runnable on a Mac Mini with an Apple M4 chip (Apple Silicon / ARM64) alongside the existing Windows + NVIDIA CUDA path. A user on either platform should be able to clone the repo and run a single setup command to get a working system with no manual dependency surgery.

**This iteration assumes one of two hardware configurations:**
- **Windows + NVIDIA GPU** (8 GB VRAM minimum, CUDA 12+) — existing path, preserved as-is
- **macOS + Apple Silicon** (M1 / M2 / M3 / M4 Unified Memory) — new path added by this plan

Auto-detection of arbitrary hardware is a future-iteration goal (documented under Alternatives).

---

## 1. Requirements & Constraints

- **REQ-001**: All Python backend behaviour (STT, TTS, LLM relay, tools) must work identically on both platforms — no frontend changes required.
- **REQ-002**: `requirements.txt` must not install NVIDIA-specific binary packages (`nvidia-cublas-cu12`, `nvidia-cuda-runtime-cu12`, etc.) on macOS; those packages do not exist for the `arm64` wheel platform.
- **REQ-003**: `onnxruntime-gpu` must not be installed on macOS. The standard `onnxruntime` package (which bundles `CoreMLExecutionProvider` on Apple platforms) must be used instead.
- **REQ-004**: `kokoro-onnx[gpu]` must not be installed on macOS; the `[gpu]` extra pulls in `onnxruntime-gpu`. Use `kokoro-onnx` (no extras) on Mac.
- **REQ-005**: `faster-whisper` / `ctranslate2` does not support Apple Metal (MPS) as of the plan date. The STT pipeline must fall back to `cpu` + `int8` compute automatically on macOS and still produce accurate transcriptions.
- **REQ-006**: `llama.cpp` / `llama-server` must be launched with Metal GPU layers (`-ngl 99`) on macOS. A new `scripts/start_llama_server.sh` must be provided, mirroring `scripts/start_llama_server.bat`.
- **REQ-007**: `scripts/launch.py` must locate and launch the correct `llama-server` binary for the detected OS without manual configuration changes.
- **REQ-008**: `scripts/setup.sh` must detect the OS, select the correct requirements file, and install the Kokoro model if not already present — identical UX on both platforms.
- **REQ-009**: A `start.sh` script (Mac/Linux equivalent of `start.bat`) must be provided so non-technical users can double-click or run a single command.
- **REQ-010**: The existing Windows workflow (`start.bat`, `Makefile`, `scripts/start_llama_server.bat`, `requirements.txt`) must continue to work unchanged.
- **SEC-001**: No credentials, API keys, or secrets may be hardcoded in any new script. Paths are read from `.env` with safe defaults.
- **CON-001**: `fastembed` and `sentence-transformers` install order constraints (documented in current `requirements.txt`) must be preserved for both platform variants.
- **CON-002**: `onnxruntime` version on macOS must be pinned to `>=1.18.0` (first release with `CoreMLExecutionProvider` in the standard package for Apple Silicon).
- **GUD-001**: All new scripts must include usage comments at the top in the same style as the existing `.bat` and `.sh` files.
- **GUD-002**: The `.env.example` must document every new variable with a comment block; existing variable blocks must not be reordered or removed.
- **PAT-001**: Platform detection must use `sys.platform == "darwin"` (Python) and `uname -s` (bash) — the same patterns already used in `stt.py` (`sys.platform == "win32"`).

---

## 2. Implementation Steps

### Implementation Phase 1 — Split Python requirements by platform

- GOAL-001: Replace the single monolithic `requirements.txt` with a base file plus two platform overlay files so `pip install` never attempts to fetch non-existent NVIDIA wheels on macOS.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `requirements-base.txt` containing all platform-agnostic packages currently in `requirements.txt`: `fastapi`, `uvicorn`, `httpx`, `python-dotenv`, `pydantic`, `python-multipart`, `faster-whisper`, `soundfile`, `kokoro-onnx` (no extras), `chromadb`, `rank-bm25`, `fastembed`, `feedparser`, `yfinance`, `tzdata`, `geopy`, `sentence-transformers`, `einops`, `mwxml`, `mwparserfromhell`, `tqdm`. Pin version constraints identically to the existing file. | | |
| TASK-002 | Create `requirements-windows.txt` containing only the Windows/CUDA-specific additions: `onnxruntime-gpu>=1.20.0`, `nvidia-cublas-cu12`, `nvidia-cuda-runtime-cu12`, `nvidia-cufft-cu12`, `nvidia-cudnn-cu12`, `kokoro-onnx[gpu]>=0.5.0`. First line must be `-r requirements-base.txt` so pip resolves the full set. Add the install-order comment for `onnxruntime-gpu → fastembed → sentence-transformers`. | | |
| TASK-003 | Create `requirements-mac.txt` containing macOS Apple Silicon additions: `onnxruntime>=1.18.0`. First line must be `-r requirements-base.txt`. Add a comment: `# onnxruntime bundles CoreMLExecutionProvider on Apple Silicon — no GPU package needed`. No NVIDIA packages. | | |
| TASK-004 | Update the top-level `requirements.txt` to contain a header comment and a single line: `-r requirements-windows.txt`. This preserves exact backward compatibility for all existing Windows users and CI pipelines that `pip install -r requirements.txt`. | | |

---

### Implementation Phase 2 — Update `scripts/setup.sh` for platform-aware install

- GOAL-002: `bash scripts/setup.sh` (and `make install`) must detect macOS vs. Windows/Linux and install the correct requirements file without user intervention.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | In `scripts/setup.sh`, replace the single `pip install -r requirements.txt` call with a platform-detection block. Use `UNAME=$(uname -s)` and check for `Darwin`. If Darwin: `pip install -r requirements-mac.txt`. Otherwise: `pip install -r requirements-windows.txt`. Print a `[setup] Detected macOS — installing Mac requirements` / `[setup] Detected Windows/Linux — installing CUDA requirements` info line before the install. | | |
| TASK-006 | In `scripts/setup.sh`, after the pip install, add a macOS-only block: check if `brew` is installed (`command -v brew`). If not, print a `[setup] WARNING: Homebrew not found` message with the Homebrew install URL (`https://brew.sh`). If brew is found, check if `llama-server` is on PATH (`command -v llama-server`). If not, print: `[setup] llama-server not found — install with: brew install llama.cpp`. Do not auto-install Homebrew or llama.cpp; this is advisory only. | | |
| TASK-007 | Update the "Next steps" printout at the bottom of `setup.sh` to be platform-aware: on macOS, show `scripts/start_llama_server.sh` instead of `start_llama_server.bat`, and `./start.sh` instead of `start.bat`. On Windows/Linux, keep the existing output unchanged. | | |

---

### Implementation Phase 3 — `backend/stt.py`: Apple Silicon device resolution

- GOAL-003: `stt.py` must automatically select `cpu` + `int8` compute on macOS (ctranslate2 does not support Metal), while still using CUDA on Windows when available. No `.env` change required; the default `WHISPER_DEVICE=cuda` degrades gracefully.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | In `backend/stt.py`, update `_resolve_device()` to add a macOS branch **before** the CUDA check. Add at the top of the function: `if sys.platform == "darwin": return "cpu"`. This short-circuits CUDA detection entirely on macOS and avoids ctranslate2 emitting spurious CUDA warnings. | | |
| TASK-009 | In `backend/stt.py`, update `_build_model()` to ensure `compute_type` is set to `"int8"` whenever `device == "cpu"` (already the case). Add an `elif sys.platform == "darwin"` branch comment: `# Apple Silicon: ctranslate2 uses Accelerate/BLAS via CPU, int8 quantisation`. No logic change needed — the comment documents intent. | | |

---

### Implementation Phase 4 — `backend/tts.py`: CoreML ONNX provider on macOS

- GOAL-004: `tts.py` must prefer `CoreMLExecutionProvider` on macOS Apple Silicon, giving hardware-accelerated TTS via the Neural Engine. Falls back to `CPUExecutionProvider` if CoreML is unavailable.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | In `backend/tts.py`, update the `_GPU_PROVIDERS` tuple to add `"CoreMLExecutionProvider"` **before** `"DmlExecutionProvider"` and **after** `"ROCMExecutionProvider"`. New tuple: `("CUDAExecutionProvider", "TensorrtExecutionProvider", "ROCMExecutionProvider", "CoreMLExecutionProvider", "DmlExecutionProvider")`. The existing `next(...)` call selects the first available provider, so CoreML will be preferred on Mac automatically. | | |
| TASK-011 | Update the `ONNX_PROVIDER` comment block in `.env.example` to document the new option: add a line `# CoreMLExecutionProvider — Apple Neural Engine (macOS Apple Silicon only)` with `#                              Requires: onnxruntime>=1.18.0 (standard package)` below the existing `DmlExecutionProvider` entry. Add a macOS example line: `# macOS Apple Silicon: ONNX_PROVIDER=CoreMLExecutionProvider`. | | |

---

### Implementation Phase 5 — `scripts/launch.py`: cross-platform llama-server path

- GOAL-005: `launch.py` (and `make up`) must resolve the `llama-server` binary path correctly on macOS (no `.exe`, different default install path) without requiring manual `.env` edits for standard Homebrew installs.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-012 | In `scripts/launch.py`, update the `LLAMA_EXE` default resolution. After computing `_cfg("LLAMA_EXE", ...)`, add a platform fallback: if `sys.platform == "darwin"` and the resolved path ends with `.exe`, replace it with the result of `shutil.which("llama-server") or "/opt/homebrew/bin/llama-server"`. This ensures Homebrew installs (`brew install llama.cpp`) are found without any `.env` edit. Import `shutil` at the top of the file. | | |
| TASK-013 | In `scripts/launch.py`, update the default value of `LLAMA_EXE` passed to `_cfg()` to be conditionally `"llama-server"` on Darwin and `r"C:\llama.cpp\llama-server.exe"` on Windows. Use `sys.platform` to select: `_LLAMA_EXE_DEFAULT = "llama-server" if sys.platform == "darwin" else r"C:\llama.cpp\llama-server.exe"` and pass `_LLAMA_EXE_DEFAULT` as the default argument. | | |
| TASK-014 | In `scripts/launch.py`, update the `LLAMA_MODEL_PATH` default to be platform-aware: on Darwin, default to `os.path.expanduser("~/.ollama/models/blobs/sha256-dde5aa3fc5ffc17176b5e8bdc82f587b24b2678c6c66101bf7da77af9f7ccdff")` (Ollama on macOS stores blobs at the same relative path); on Windows, keep the existing `%USERPROFILE%` path. | | |

---

### Implementation Phase 6 — New script: `scripts/start_llama_server.sh`

- GOAL-006: Provide a Mac/Linux equivalent of `scripts/start_llama_server.bat` that a non-technical user can run with a single command or double-click in Terminal.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-015 | Create `scripts/start_llama_server.sh`. Header comment block must describe prerequisites: (1) Install llama.cpp via `brew install llama.cpp`, (2) Place GGUF model at `LLAMA_MODEL_PATH`, (3) Set `LLM_BACKEND=llama` in `.env`. Configuration variables match `start_llama_server.bat`: `LLAMA_EXE`, `LLAMA_MODEL_PATH`, `LLAMA_ALIAS`, `LLAMA_PORT`, `LLAMA_HOST`, `LLAMA_GPU_LAYERS` (default `99` — Metal layer count), `LLAMA_CTX_SIZE`. | | |
| TASK-016 | In `scripts/start_llama_server.sh`, add a `LLAMA_EXE` resolution block: if `LLAMA_EXE` is not set, try `command -v llama-server`; if found, use it; else try `/opt/homebrew/bin/llama-server`; else print an error and exit 1. | | |
| TASK-017 | In `scripts/start_llama_server.sh`, the `llama-server` invocation must use `--n-gpu-layers $LLAMA_GPU_LAYERS` (Metal layers on macOS), `--ctx-size $LLAMA_CTX_SIZE`, `--port $LLAMA_PORT`, `--host $LLAMA_HOST`, `--model "$LLAMA_MODEL_PATH"`, `--alias "$LLAMA_ALIAS"`. Note: on Apple Silicon, `--n-gpu-layers 99` offloads all layers to the Metal GPU; there is no CUDA flag. | | |
| TASK-018 | Add a `chmod +x scripts/start_llama_server.sh` note to `setup.sh` on Darwin, or set the executable bit at creation time using `install -m 755`. | | |

---

### Implementation Phase 7 — New script: `start.sh` (Mac launcher)

- GOAL-007: Provide a single-file Mac equivalent of `start.bat` so a Mac user can run `./start.sh` (or double-click in Terminal) to launch the full stack.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-019 | Create `start.sh` at repo root. Content: shebang `#!/usr/bin/env bash`, activate `.venv` (check for `.venv/bin/activate`; error if missing with "Run: bash scripts/setup.sh first"), then exec `python scripts/launch.py`. Style: match `start.bat` with a brief header comment. | | |
| TASK-020 | Create `stop.sh` at repo root mirroring `stop.bat`: activate `.venv`, exec `python scripts/stop.py`. | | |
| TASK-021 | In `scripts/setup.sh`, at the end of the macOS branch, run `chmod +x start.sh stop.sh scripts/start_llama_server.sh` so they are immediately executable after setup. | | |

---

### Implementation Phase 8 — Makefile and `.env.example` updates

- GOAL-008: Update developer-facing tooling to reflect Mac support.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-022 | In `Makefile`, update the `llama` target's macOS/Linux branch from the existing placeholder echo to actually call `scripts/start_llama_server.sh`: `bash scripts/start_llama_server.sh`. | | |
| TASK-023 | In `Makefile`, add a `setup-mac` target as an alias for `install` with an info header: `@echo "Running macOS setup..."`. This is a convenience target — not a separate flow. | | |
| TASK-024 | In `.env.example`, update the `WHISPER_DEVICE` block to document `cpu` as the macOS value: add comment `# macOS Apple Silicon: set to cpu (ctranslate2 does not support Metal; still fast via Accelerate)`. | | |
| TASK-025 | In `.env.example`, add a new section `# ── Platform-specific defaults (set by setup.sh automatically) ──` before the STT block documenting `LLAMA_EXE` (with Windows and macOS example values), `LLAMA_MODEL_PATH` (with both platform example paths), and `LLAMA_GPU_LAYERS` (note: `999` on CUDA, `99` on Metal). | | |

---

### Implementation Phase 9 — `README.md` Mac quickstart section

- GOAL-009: Document the Mac setup path clearly in README so a first-time macOS user can follow it without reading this plan.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-026 | In `README.md`, add a **Mac Mini M4 Quickstart** subsection inside the existing "Quickstart" section (after step 3b). Include: (1) install Homebrew, (2) `brew install llama.cpp`, (3) clone repo, (4) `bash scripts/setup.sh`, (5) edit `.env` — set `LLM_BACKEND=llama`, `LLAMA_MODEL_PATH`, `ONNX_PROVIDER=CoreMLExecutionProvider`, `WHISPER_DEVICE=cpu`, (6) `./start.sh`. | | |
| TASK-027 | In `README.md`, update the **Requirements** GPU table to add a macOS Apple Silicon row: `Apple M1/M2/M3/M4 | Unified Memory 16 GB+ recommended | Metal (built into llama.cpp) | CoreMLExecutionProvider`. | | |

---

## 3. Alternatives

- **ALT-001**: **Single `requirements.txt` with platform markers** (`onnxruntime-gpu; sys_platform == "win32"`) — rejected because `onnxruntime-gpu` is not available as an `arm64` wheel at all; pip would error rather than skip.
- **ALT-002**: **Auto-detect hardware at runtime and install packages on-demand** — the future-iteration goal. Deferred because it requires a bootstrapper that can install into the active venv, adding complexity not justified by a two-platform requirement.
- **ALT-003**: **Use Ollama as the LLM backend on macOS** (Ollama has native Apple Silicon support, eliminating the need for a separate `llama-server` install) — valid shortcut for users who already have Ollama. Documented in README as an easier alternative (`LLM_BACKEND=ollama`). Not made the default because llama-server with Metal gives lower latency and is already the primary backend.
- **ALT-004**: **Use `whisper.cpp` via Python bindings for STT on Mac** (full Metal acceleration) — deferred. `faster-whisper` on CPU is adequate for `base` model latency on M4; this is an optimization pass for a future iteration.
- **ALT-005**: **Docker multi-arch image** — rejected for this iteration; Docker on macOS adds overhead and conflicts with the low-latency, local-GPU design goal.

---

## 4. Dependencies

- **DEP-001**: `onnxruntime>=1.18.0` — standard package (not `-gpu`); available on PyPI for `arm64` macOS. Bundles `CoreMLExecutionProvider`.
- **DEP-002**: `kokoro-onnx>=0.5.0` (no `[gpu]` extra) — `pip install kokoro-onnx` on macOS.
- **DEP-003**: `faster-whisper>=1.0.0` — already in `requirements-base.txt`; ctranslate2 wheels available for Apple Silicon.
- **DEP-004**: `llama.cpp` (Homebrew formula: `llama.cpp`) — installs `llama-server` at `/opt/homebrew/bin/llama-server` with Metal support compiled in. No additional flags needed.
- **DEP-005**: **GGUF model file** — user-supplied; same format as Windows. Can be sourced from Ollama blob cache at `~/.ollama/models/blobs/` (identical path on macOS and Windows).
- **DEP-006**: `Homebrew` — macOS-only prerequisite for llama.cpp install. Advisory in `setup.sh`; not auto-installed.

---

## 5. Files

- **FILE-001**: `requirements.txt` — updated to `-r requirements-windows.txt` (backward-compatible redirect)
- **FILE-002**: `requirements-base.txt` — new file; platform-agnostic packages
- **FILE-003**: `requirements-windows.txt` — new file; CUDA + NVIDIA stack overlay
- **FILE-004**: `requirements-mac.txt` — new file; macOS Apple Silicon overlay
- **FILE-005**: `scripts/setup.sh` — updated with platform detection and macOS install path
- **FILE-006**: `scripts/start_llama_server.sh` — new file; macOS Metal llama-server launcher
- **FILE-007**: `scripts/launch.py` — updated with cross-platform binary resolution
- **FILE-008**: `backend/stt.py` — updated `_resolve_device()` with macOS early-exit
- **FILE-009**: `backend/tts.py` — updated `_GPU_PROVIDERS` with `CoreMLExecutionProvider`
- **FILE-010**: `start.sh` — new file; Mac equivalent of `start.bat`
- **FILE-011**: `stop.sh` — new file; Mac equivalent of `stop.bat`
- **FILE-012**: `Makefile` — updated `llama` target + new `setup-mac` alias
- **FILE-013**: `.env.example` — updated with Mac-specific variable documentation
- **FILE-014**: `README.md` — updated with Mac quickstart section and requirements table

---

## 6. Testing

- **TEST-001**: On macOS Apple Silicon, run `bash scripts/setup.sh` in a clean directory. Verify: `.venv` created, `requirements-mac.txt` installed (no NVIDIA packages in `pip list`), Kokoro models downloaded, `.env` created.
- **TEST-002**: On macOS, verify `python -c "import onnxruntime; print(onnxruntime.get_available_providers())"` lists `CoreMLExecutionProvider`.
- **TEST-003**: On macOS, start the backend (`make backend`) and call `GET /system-status`. Verify `stt_device` returns `cpu` and `tts_provider` returns `CoreMLExecutionProvider` or `CPUExecutionProvider`.
- **TEST-004**: On macOS, call `POST /transcribe` with a test WAV file. Verify a non-empty transcript is returned within 5 seconds.
- **TEST-005**: On macOS, call `POST /synthesize` with `{"text": "hello world", "voice": "af_heart"}`. Verify a valid WAV response is returned.
- **TEST-006**: On macOS, run `./start.sh`. Verify both llama-server and FastAPI start without errors and `GET /health` returns 200.
- **TEST-007**: On Windows with NVIDIA GPU, run `make install` and verify `pip list` still shows `onnxruntime-gpu` (not `onnxruntime`) and all NVIDIA packages are present.
- **TEST-008**: On Windows, run `start.bat` and verify the existing workflow is completely unchanged.
- **TEST-009**: On macOS, run `scripts/test_integration.py` against the running backend and verify all existing tests pass.
- **TEST-010**: On macOS, verify `make llama` calls `scripts/start_llama_server.sh` (not the `.bat`) and llama-server starts with Metal layers.

---

## 7. Risks & Assumptions

- **RISK-001**: `CoreMLExecutionProvider` may not be available in all `onnxruntime` builds (e.g. older versions or non-standard PyPI distributions). Mitigation: the existing `next(..., None)` provider fallback in `tts.py` already gracefully falls through to `CPUExecutionProvider`.
- **RISK-002**: ctranslate2 may release MPS (Metal) support after this plan is written, making `TASK-008` a performance pessimization. Mitigation: `_resolve_device()` is a single-function change; a future iteration can add `mps` support by checking ctranslate2 version and available devices.
- **RISK-003**: Homebrew `llama.cpp` formula version may lag behind the latest llama.cpp release, potentially missing features used by the frontend. Mitigation: `scripts/start_llama_server.sh` documents the Homebrew install as the easy path, but also notes the manual binary download from `github.com/ggml-org/llama.cpp/releases` as an alternative.
- **RISK-004**: `fastembed` ARM64 wheels may not be available for all versions. Mitigation: `requirements-base.txt` pins `fastembed>=0.3.0`; test on macOS before finalising the pin.
- **RISK-005**: Users with an M1/M2/M3 Mac (not M4) should also work — the plan is not M4-specific; the chip identifier in the goal refers to the target machine, not a constraint.
- **ASSUMPTION-001**: The user has Python 3.11+ installed on macOS (via Homebrew, pyenv, or the official installer). `setup.sh` already validates this.
- **ASSUMPTION-002**: The user's GGUF model file is already present locally (e.g. from an existing Ollama install). The model download path is out of scope for this iteration.
- **ASSUMPTION-003**: On macOS, `llama-server` installed via `brew install llama.cpp` is compiled with Metal support (`-DGGML_METAL=ON`). This is the default for the official Homebrew formula.
- **ASSUMPTION-004**: TTS latency on Mac using `CoreMLExecutionProvider` will be within acceptable bounds (< 2 s for a typical sentence). If CoreML is slower than expected, `CPUExecutionProvider` remains the fallback with no code change needed.

---

## 8. Related Specifications / Further Reading

- [llama.cpp releases — macOS Metal builds](https://github.com/ggml-org/llama.cpp/releases)
- [Homebrew llama.cpp formula](https://formulae.brew.sh/formula/llama.cpp)
- [onnxruntime CoreML execution provider docs](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
- [ctranslate2 supported compute types](https://opennmt.net/CTranslate2/quantization.html)
- [faster-whisper — device/compute_type reference](https://github.com/SYSTRAN/faster-whisper#model-loading)
- [kokoro-onnx — GPU/CPU provider selection](https://github.com/thewh1teagle/kokoro-onnx)
- [plan/feature-boot-shutdown-animation-1.md](feature-boot-shutdown-animation-1.md) — related: startup sequence unchanged by this plan
- [plan/feature-starling-soul-personality-1.md](feature-starling-soul-personality-1.md) — related: system prompt configuration unchanged by this plan
