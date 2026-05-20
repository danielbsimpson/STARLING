---
goal: Full cross-platform hardware auto-detection, dependency auto-install, and GPU-first inference with CPU fallback across Windows, Linux, and macOS
version: 1.0
date_created: 2026-05-20
last_updated: 2026-05-20
owner: Daniel Simpson
status: 'Planned'
tags: [feature, infrastructure, cross-platform, hardware-detection, auto-install, gpu, cpu-fallback]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan expands S.T.A.R.L.I.N.G. from a two-platform (Windows/Mac) system into a fully portable, self-provisioning application that runs on any modern desktop OS — **Windows**, **Linux**, and **macOS** — with zero manual dependency configuration. On first run, a hardware detection script probes the machine, selects the correct GPU backend (NVIDIA CUDA, AMD ROCm, Apple Metal, or CPU fallback), installs only the packages that apply to that hardware, downloads the llama-server binary and a default GGUF model, and writes a `.env` pre-populated with validated settings. If the detected GPU memory or Unified Memory is below the **8 GB minimum threshold**, the system continues on CPU and surfaces a persistent warning banner in the UI rather than failing silently.

This plan builds on top of `plan/feature-mac-m4-compatibility-1.md` (Phase 1 of cross-platform work) and supersedes its requirements file split approach with a fully general hardware-profile-driven install pipeline.

**Supported hardware matrix for this iteration:**

| OS | GPU Backend | ONNX Provider | ctranslate2 Device | llama-server Build |
|---|---|---|---|---|
| Windows | NVIDIA CUDA 12+ | `CUDAExecutionProvider` | `cuda` | CUDA cu12 zip |
| Windows | No / low-VRAM GPU | `CPUExecutionProvider` | `cpu` | AVX2 zip |
| Linux | NVIDIA CUDA 12+ | `CUDAExecutionProvider` | `cuda` | CUDA cu12 zip |
| Linux | AMD ROCm 6.1+ | `ROCMExecutionProvider` | `cpu`* | ROCm zip |
| Linux | No / low-VRAM GPU | `CPUExecutionProvider` | `cpu` | generic x64 zip |
| macOS | Apple Silicon M-series | `CoreMLExecutionProvider` | `cpu`* | Homebrew Metal |
| macOS | Intel (x86_64) | `CPUExecutionProvider` | `cpu` | Homebrew CPU |

> \* ctranslate2 does not support Metal or ROCm as of plan date; CPU + int8 is used for STT on those platforms.

---

## 1. Requirements & Constraints

- **REQ-001**: A single entry point — `bash scripts/setup.sh` on Mac/Linux or `scripts\setup.ps1` on Windows — must detect hardware, install dependencies, download all required binaries and models, and write `.env` without any other user action.
- **REQ-002**: Hardware detection must cover: NVIDIA GPU (VRAM via `pynvml`), AMD GPU (VRAM via `rocm-smi` subprocess), Apple Silicon Unified Memory (via `system_profiler` subprocess), and CPU-only fallback (system RAM via `psutil`).
- **REQ-003**: The 8 GB memory threshold applies to GPU VRAM or Apple Unified Memory. If neither meets the threshold, the system must fall back to CPU mode and print a `[WARNING]` banner at startup in both the terminal and the frontend UI.
- **REQ-004**: The `llama-server` binary must be auto-downloaded from the official llama.cpp GitHub Releases page into `tools/llama/llama-server[.exe]` if not already present and not found on `PATH`. No manual binary download steps.
- **REQ-005**: A default GGUF model (`Llama-3.2-3B-Instruct-Q4_K_M.gguf`, ~2.0 GB) must be auto-downloaded into `models/llama/` from HuggingFace Hub if no model is configured in `.env` and no file is present at the default path. The download must show a progress bar.
- **REQ-006**: Kokoro TTS model files (`kokoro-v1.0.onnx`, `voices-v1.0.bin`) must still be auto-downloaded by `scripts/download_models.py` (existing behaviour preserved).
- **REQ-007**: The hardware detection result must be persisted as a JSON file at `backend/memory/.hardware_profile.json` so the backend can read it at startup without re-running detection.
- **REQ-008**: A new `GET /hardware` endpoint in `backend/main.py` must return the hardware profile JSON so the frontend can display a low-memory warning banner.
- **REQ-009**: The `requirements.txt` split from `plan/feature-mac-m4-compatibility-1.md` must be extended to four requirement overlay files: `requirements-nvidia.txt`, `requirements-amd-linux.txt`, `requirements-mac.txt`, `requirements-cpu.txt`.
- **REQ-010**: All existing Windows `start.bat` / `stop.bat` / `Makefile` workflows must continue to function without change.
- **REQ-011**: `setup.ps1` must be a full Windows PowerShell equivalent of `setup.sh` — same steps, same outcome, no Git Bash required.
- **SEC-001**: Downloaded binaries must be verified against a SHA-256 checksum sourced from the same GitHub release manifest before being written to disk. If verification fails, the file is deleted and setup exits with an error.
- **SEC-002**: The HuggingFace model download URL must be a direct, non-redirect HTTPS URL. No API tokens may be embedded in scripts.
- **CON-001**: `pynvml` must be installed in a pre-detection bootstrap step using the base venv before the hardware profile is written, since NVIDIA detection depends on it.
- **CON-002**: `psutil` must also be installed in the bootstrap step for system RAM fallback.
- **CON-003**: The `fastembed` → `sentence-transformers` install order constraint documented in `requirements-base.txt` must be preserved across all overlay files.
- **CON-004**: AMD ROCm `onnxruntime-rocm` wheels are only available for Linux and require ROCm 6.x runtime to be pre-installed by the user (not auto-installable via pip). Setup must check for `rocm-smi` on PATH before selecting the ROCm requirements overlay; if absent, fall back to CPU.
- **CON-005**: macOS Intel (x86_64) is supported at CPU-only quality. `CoreMLExecutionProvider` is only meaningful on `arm64`. The hardware profile must include the machine `arch` field and select CPU provider on Intel Mac.
- **GUD-001**: All detection logic must be non-destructive and idempotent — re-running setup on a provisioned machine must produce no changes and exit cleanly.
- **GUD-002**: Every terminal print during setup must use colour-coded prefixes: `[setup]` (green), `[warn]` (yellow), `[error]` (red), `[detect]` (cyan), `[download]` (blue).
- **GUD-003**: The low-memory CPU fallback warning must be shown at three points: during setup, at backend startup (logged via Python `logging.warning`), and in the frontend UI as a persistent dismissible banner.
- **PAT-001**: Hardware detection logic must live entirely in `scripts/detect_hardware.py` and write to `backend/memory/.hardware_profile.json`. No detection logic belongs in `stt.py`, `tts.py`, or `main.py` — they only read the profile.
- **PAT-002**: All new scripts must follow the header comment convention established in existing scripts (`setup.sh`, `download_models.py`).

---

## 2. Implementation Steps

### Implementation Phase 1 — Bootstrap package install and hardware detection script

- GOAL-001: Create `scripts/detect_hardware.py` — the single source of truth for machine capabilities — and ensure it runs early in `setup.sh` / `setup.ps1` after only minimal bootstrap packages are installed.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `scripts/detect_hardware.py`. At the top, define `PROFILE_PATH = Path(__file__).parent.parent / "backend" / "memory" / ".hardware_profile.json"`. The script must be runnable standalone (`python scripts/detect_hardware.py`) and print a summary to stdout, then write the profile JSON. | | |
| TASK-002 | In `detect_hardware.py`, implement `detect_os() -> dict` returning `{"platform": "windows"\|"linux"\|"darwin", "arch": "x86_64"\|"arm64"}` using `sys.platform` and `platform.machine().lower()`. Normalise `AMD64` → `x86_64`, `aarch64` → `arm64`. | | |
| TASK-003 | In `detect_hardware.py`, implement `detect_nvidia() -> dict \| None`. Import `pynvml` inside a try/except. Call `nvmlInit()`, `nvmlDeviceGetHandleByIndex(0)`, `nvmlDeviceGetMemoryInfo(handle)` to get `total` VRAM bytes. Also call `nvmlDeviceGetName(handle)` for the GPU name. Return `{"vendor": "nvidia", "name": str, "vram_mb": int}` or `None` if pynvml is unavailable or no device found. Always call `nvmlShutdown()` in a finally block. | | |
| TASK-004 | In `detect_hardware.py`, implement `detect_amd() -> dict \| None`. Call `subprocess.run(["rocm-smi", "--showmeminfo", "vram", "--json"], capture_output=True, timeout=5)`. Parse the JSON output: the VRAM total is at `result["card0"]["VRAM Total Memory (B)"]`. Divide by 1048576 for MB. Return `{"vendor": "amd", "name": "AMD GPU", "vram_mb": int}` or `None` if `rocm-smi` is not on PATH or the call fails. | | |
| TASK-005 | In `detect_hardware.py`, implement `detect_apple_silicon() -> dict \| None`. Only runs when `sys.platform == "darwin"` and `platform.machine() == "arm64"`. Call `subprocess.run(["system_profiler", "SPHardwareDataType", "-json"], capture_output=True, timeout=10)`. Parse JSON: `result["SPHardwareDataType"][0]["physical_memory"]` returns a string like `"16 GB"`. Convert to MB. Return `{"vendor": "apple", "name": "Apple Silicon", "unified_memory_mb": int}` or `None` on failure. | | |
| TASK-006 | In `detect_hardware.py`, implement `detect_system_ram() -> int`. Use `import psutil; return psutil.virtual_memory().total // 1048576`. This is always available as a fallback. | | |
| TASK-007 | In `detect_hardware.py`, implement `build_profile() -> dict`. Call detection functions in order: `detect_nvidia()`, `detect_amd()`, `detect_apple_silicon()`. Use the first non-None result as `gpu`. Compute `available_memory_mb`: if `gpu` is not None use `gpu.get("vram_mb") or gpu.get("unified_memory_mb")`; else use `detect_system_ram()`. Set `memory_ok = available_memory_mb >= 8192`. Set `memory_warning = not memory_ok`. Determine `recommended_device`: `"cuda"` if NVIDIA and `memory_ok`, `"cpu"` otherwise. Determine `recommended_onnx_provider`: see TASK-008. Determine `recommended_llama_layers`: `"999"` if NVIDIA/Apple and `memory_ok`, `"0"` if CPU fallback. Determine `requirements_overlay`: see TASK-009. Return a complete profile dict. | | |
| TASK-008 | In `detect_hardware.py`, implement `_pick_onnx_provider(gpu, os_info, memory_ok) -> str`. Logic: if NVIDIA and memory_ok → `"CUDAExecutionProvider"`; elif AMD and memory_ok → `"ROCMExecutionProvider"`; elif Apple arm64 and memory_ok → `"CoreMLExecutionProvider"`; else → `"CPUExecutionProvider"`. | | |
| TASK-009 | In `detect_hardware.py`, implement `_pick_requirements_overlay(gpu, os_info, memory_ok) -> str`. Logic: if NVIDIA and memory_ok → `"requirements-nvidia.txt"`; elif AMD and memory_ok and Linux → `"requirements-amd-linux.txt"`; elif Apple arm64 → `"requirements-mac.txt"`; else → `"requirements-cpu.txt"`. | | |
| TASK-010 | In `detect_hardware.py`, implement `main()`: call `build_profile()`, ensure `PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)`, write JSON with `indent=2` to `PROFILE_PATH`, then print a colour-coded summary table to stdout. If `memory_warning` is True, print a `[warn]` block explaining the 8 GB threshold and that CPU mode is active. | | |
| TASK-011 | In `setup.sh`, add a bootstrap pip install step immediately after venv activation (before the main requirements install): `pip install --quiet pynvml psutil`. These two packages are small and have no conflicting dependencies. They are needed before `detect_hardware.py` can run. | | |
| TASK-012 | In `setup.sh`, after the bootstrap install, call `python scripts/detect_hardware.py` and capture the exit code. On non-zero exit, print `[error] Hardware detection failed` and exit 1. On success, read `REQUIREMENTS_OVERLAY` from the profile JSON: `OVERLAY=$(python -c "import json; d=json.load(open('backend/memory/.hardware_profile.json')); print(d['requirements_overlay'])")` and use it for the main pip install. | | |

---

### Implementation Phase 2 — Requirements file matrix

- GOAL-002: Establish four platform-specific requirements overlay files that `detect_hardware.py` selects between, replacing the two-file split from `plan/feature-mac-m4-compatibility-1.md`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-013 | Create `requirements-base.txt`. Contents: all platform-agnostic packages from the current `requirements.txt`: `fastapi>=0.111.0`, `uvicorn[standard]>=0.29.0`, `httpx>=0.27.0`, `python-dotenv>=1.0.0`, `pydantic>=2.0.0`, `python-multipart>=0.0.9`, `faster-whisper>=1.0.0`, `soundfile>=0.13.0`, `chromadb>=0.5.0`, `rank-bm25>=0.2.2`, `feedparser>=6.0.11`, `yfinance>=0.2.54`, `tzdata>=2024.1`, `geopy>=2.4.0`, `einops>=0.7.0`, `mwxml>=0.3.3`, `mwparserfromhell>=0.6.6`, `tqdm>=4.66.4`. Do NOT include `onnxruntime*`, `nvidia-*`, `kokoro-onnx*`, `fastembed`, `sentence-transformers` in this file — those are in overlays. | | |
| TASK-014 | Create `requirements-nvidia.txt`. First line: `-r requirements-base.txt`. Then add: `onnxruntime-gpu>=1.20.0`, `nvidia-cublas-cu12`, `nvidia-cuda-runtime-cu12`, `nvidia-cufft-cu12`, `nvidia-cudnn-cu12`, `kokoro-onnx[gpu]>=0.5.0`. Then add, in order: `fastembed>=0.3.0`, `sentence-transformers>=2.7.0`. Include install-order comment: `# Install order enforced: onnxruntime-gpu BEFORE fastembed BEFORE sentence-transformers`. | | |
| TASK-015 | Create `requirements-amd-linux.txt`. First line: `-r requirements-base.txt`. Then add: `onnxruntime>=1.18.0` (standard package — ROCm provider is loaded at runtime when ROCm libraries are present, not via a separate pip package for ORT 1.18+), `kokoro-onnx>=0.5.0`. Then add: `fastembed>=0.3.0`, `sentence-transformers>=2.7.0`. Add comment: `# AMD ROCm: requires ROCm 6.x runtime installed at OS level (apt/dnf). onnxruntime loads ROCMExecutionProvider dynamically if librocblas.so is on LD_LIBRARY_PATH.` | | |
| TASK-016 | Create `requirements-mac.txt`. First line: `-r requirements-base.txt`. Then add: `onnxruntime>=1.18.0`, `kokoro-onnx>=0.5.0`. Then add: `fastembed>=0.3.0`, `sentence-transformers>=2.7.0`. Add comment: `# macOS: onnxruntime bundles CoreMLExecutionProvider on arm64. No NVIDIA packages.` | | |
| TASK-017 | Create `requirements-cpu.txt`. First line: `-r requirements-base.txt`. Then add: `onnxruntime>=1.18.0`, `kokoro-onnx>=0.5.0`. Then add: `fastembed>=0.3.0`, `sentence-transformers>=2.7.0`. Add comment: `# CPU fallback: no GPU acceleration. Used when no qualifying GPU is detected or VRAM < 8 GB.` | | |
| TASK-018 | Update `requirements.txt` (root, Windows default): replace all contents with `-r requirements-nvidia.txt` and a header comment: `# Default requirements for Windows + NVIDIA CUDA. Run scripts/setup.sh or setup.ps1 for auto-detection.` This preserves backward compatibility for existing Windows users who run bare `pip install -r requirements.txt`. | | |

---

### Implementation Phase 3 — llama-server binary auto-downloader

- GOAL-003: Create `scripts/download_llama_server.py` so the setup flow can provision the correct llama-server binary without any manual download step.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-019 | Create `scripts/download_llama_server.py`. Define `TOOLS_DIR = Path(__file__).parent.parent / "tools" / "llama"`. Define `RELEASES_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"`. Define `BINARY_NAME = "llama-server.exe"` on Windows, `"llama-server"` on Linux/macOS. | | |
| TASK-020 | In `download_llama_server.py`, implement `_already_available() -> str \| None`: first check if `TOOLS_DIR / BINARY_NAME` exists; if yes return that path. Then check `shutil.which("llama-server")`; if found return that path. Return `None` if neither found. | | |
| TASK-021 | In `download_llama_server.py`, implement `_pick_asset_pattern(profile: dict) -> str` — returns a substring to match against GitHub release asset names. Matrix: Windows + NVIDIA/memory_ok → `"win-cuda-cu12"` + `"x64"`; Windows CPU → `"win-avx2-x64"`; Linux + NVIDIA/memory_ok → `"linux-cuda-cu12"` + `"x64"`; Linux + AMD/memory_ok → `"ubuntu-rocm"` + `"x64"`; Linux CPU → `"ubuntu-x64"` (non-CUDA generic build); macOS → `None` (Homebrew only; print advisory message and return). | | |
| TASK-022 | In `download_llama_server.py`, implement `_get_release_asset(pattern: str) -> tuple[str, str]`: fetch `RELEASES_API` with `urllib.request.urlopen` (10 s timeout, `User-Agent: starling-setup/1.0`), parse JSON, find the first asset whose `name` matches `pattern` (case-insensitive substring). Return `(download_url, sha256_checksum)` — checksum is taken from a corresponding `.sha256` asset if present, else `None`. Raise `RuntimeError` if no matching asset found. | | |
| TASK-023 | In `download_llama_server.py`, implement `_download_and_verify(url: str, dest_zip: Path, expected_sha256: str \| None)`: download with progress bar (same `_progress` hook pattern as `download_models.py`), compute `hashlib.sha256` of the downloaded file. If `expected_sha256` is not None and hash does not match, delete the file and raise `RuntimeError("SHA-256 mismatch")`. | | |
| TASK-024 | In `download_llama_server.py`, implement `_extract_binary(zip_path: Path, dest_dir: Path)`: use `zipfile.ZipFile` to extract only `llama-server[.exe]` from the archive into `dest_dir`. On Linux/macOS, call `os.chmod(dest, 0o755)` on the extracted binary. | | |
| TASK-025 | In `download_llama_server.py`, implement `main(profile_path: str \| None = None)`: load the hardware profile from `PROFILE_PATH` (or `profile_path` arg). If macOS, print advisory: `[download] On macOS install llama.cpp via: brew install llama.cpp` and exit 0. Call `_already_available()`; if found, print `[download] llama-server already at {path}` and exit 0. Otherwise call full download pipeline, set `TOOLS_DIR` in the written `.env` fragment. | | |

---

### Implementation Phase 4 — GGUF model auto-downloader

- GOAL-004: Create `scripts/download_model.py` so the setup flow can provision a default GGUF model from HuggingFace Hub without any manual download step.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-026 | Create `scripts/download_model.py`. Define constants: `MODEL_DIR = Path(__file__).parent.parent / "models" / "llama"`, `MODEL_FILENAME = "Llama-3.2-3B-Instruct-Q4_K_M.gguf"`, `MODEL_URL = "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf"`, `MODEL_SIZE_APPROX_GB = 2.0`. | | |
| TASK-027 | In `download_model.py`, implement `_already_configured() -> str \| None`: load `PROFILE_PATH`, read `LLAMA_MODEL_PATH` from `.env` if it exists, check if that path points to an existing file. Also check `MODEL_DIR / MODEL_FILENAME`. Return the path string if found, else `None`. | | |
| TASK-028 | In `download_model.py`, implement `main()`: call `_already_configured()`; if found, print skip message and return. Print an info message: `[download] Downloading default model (~{MODEL_SIZE_APPROX_GB} GB). This is a one-time download.`. Create `MODEL_DIR`. Download `MODEL_URL` to `MODEL_DIR / MODEL_FILENAME` with the progress bar hook. On success, print the final path so `setup.sh` can write it to `.env`. | | |

---

### Implementation Phase 5 — `setup.sh` full rewrite and `setup.ps1` creation

- GOAL-005: Replace the current linear `setup.sh` with a hardware-aware orchestrator, and create an equivalent `setup.ps1` for Windows PowerShell users who do not have Git Bash.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-029 | Rewrite `scripts/setup.sh`. Preserve existing steps 1–2 (Python version check, venv creation) and 4–5 (Kokoro models, `.env` copy). Insert new steps in order: (2a) bootstrap install of `pynvml psutil`; (2b) run `detect_hardware.py`; (2c) read `OVERLAY` from profile JSON; (3) install `$OVERLAY`; (3a) run `download_llama_server.py`; (3b) run `download_model.py` and capture model path; (5a) if `.env` was just created, call `scripts/write_env.py` to patch `LLAMA_MODEL_PATH`, `LLAMA_EXE`, `LLAMA_GPU_LAYERS`, `ONNX_PROVIDER`, `WHISPER_DEVICE` from the hardware profile. | | |
| TASK-030 | Create `scripts/write_env.py`. Reads `backend/memory/.hardware_profile.json` and the current `.env` file. For each of the five auto-configured keys (`LLAMA_MODEL_PATH`, `LLAMA_EXE`, `LLAMA_GPU_LAYERS`, `ONNX_PROVIDER`, `WHISPER_DEVICE`): if the key is already set to a non-placeholder value in `.env`, leave it unchanged. If it is the default placeholder value, overwrite it with the hardware-profile-derived value. Write the updated `.env` in-place. Print a one-line summary of every key changed. | | |
| TASK-031 | Create `scripts/setup.ps1`. PowerShell 5.1+ compatible. Steps mirror `setup.sh` exactly: Python check, venv creation (`.venv\Scripts\Activate.ps1`), bootstrap pip install, call `detect_hardware.py`, read overlay from JSON, install overlay requirements, call `download_llama_server.py`, call `download_model.py`, call Kokoro model download, call `write_env.py`. Output uses `Write-Host` with `-ForegroundColor` for colour parity. | | |
| TASK-032 | In `scripts/setup.ps1`, add a `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` check at the top: if execution policy is `Restricted`, print a warning message instructing the user to run `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` and exit. Do not auto-change the policy. | | |
| TASK-033 | Update `Makefile` `install` target: change from `bash scripts/setup.sh` to a platform-dispatching block. On Windows (`$(OS)` == `Windows_NT`): `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1`. On all others: `bash scripts/setup.sh`. | | |

---

### Implementation Phase 6 — Backend hardware profile reader

- GOAL-006: Load the hardware profile at backend startup and expose it via a new `/hardware` endpoint, enabling the frontend to display an accurate low-memory warning and the backend components to configure themselves from the profile rather than raw `.env` defaults.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-034 | Create `backend/hardware.py`. Define `PROFILE_PATH = Path(__file__).parent / "memory" / ".hardware_profile.json"`. Implement `load_profile() -> dict`: reads and parses the JSON file; if not found, returns a minimal stub `{"memory_ok": True, "memory_warning": False, "recommended_device": "cpu", "recommended_onnx_provider": "CPUExecutionProvider", "recommended_llama_layers": "0"}` with a logged warning. Cache the result in a module-level `_PROFILE` variable so subsequent calls are free. | | |
| TASK-035 | In `backend/main.py`, import `hardware` and add a `GET /hardware` route returning `hardware.load_profile()` as a JSON response. Mount it before any other router so it is always reachable even if tool routers fail to load. Register the route with `tags=["system"]`. | | |
| TASK-036 | In `backend/main.py`, update the `startup_event` handler to call `hardware.load_profile()` and, if `profile["memory_warning"]` is True, emit a `logging.warning("LOW MEMORY MODE: GPU VRAM / Unified Memory < 8 GB. Running on CPU — responses will be slower.")` line that appears prominently in the server startup output. | | |

---

### Implementation Phase 7 — STT and TTS profile-aware device selection

- GOAL-007: `stt.py` and `tts.py` read the hardware profile instead of relying solely on `.env` values, so that hardware-appropriate settings are always active even if the user did not manually edit `.env`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-037 | In `backend/stt.py`, import `hardware` at the top. In `_resolve_device(requested: str)`, before the existing CUDA probe: call `profile = hardware.load_profile()`. If `profile.get("recommended_device") == "cpu"`, short-circuit and return `"cpu"` (covers macOS, AMD, and low-memory cases). If `profile.get("recommended_device") == "cuda"` and `requested == "cuda"`, proceed with the existing ctranslate2 CUDA device count check as the final validation. The `WHISPER_DEVICE` env var still overrides if explicitly set to a non-default value. | | |
| TASK-038 | In `backend/tts.py`, import `hardware` at the top. After `_available = _ort.get_available_providers()`, add: `_profile = hardware.load_profile()`. Change `_default_provider`: if `_profile.get("recommended_onnx_provider")` is set and that provider is in `_available`, use it; else fall through to the existing `next(...)` selection over `_GPU_PROVIDERS`. This means the profile-recommended provider is always tried first, but `ONNX_PROVIDER` env var still takes final precedence. | | |

---

### Implementation Phase 8 — `launch.py` cross-platform binary resolution

- GOAL-008: `scripts/launch.py` must resolve the llama-server binary from (1) the hardware profile / `.env` override, (2) the bundled `tools/llama/` path, (3) `PATH`, in that priority order — covering all three OSes without hardcoded Windows paths.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-039 | In `scripts/launch.py`, add `import shutil` and `import platform` at the top. Define `_BINARY = "llama-server.exe" if sys.platform == "win32" else "llama-server"`. | | |
| TASK-040 | In `scripts/launch.py`, replace the hardcoded `LLAMA_EXE` default with a `_resolve_llama_exe()` function: (1) check `.env`/env var `LLAMA_EXE`; if set and the path exists, return it. (2) Check `REPO_ROOT / "tools" / "llama" / _BINARY`; if exists, return it. (3) Call `shutil.which("llama-server")`; if found, return it. (4) On macOS, also try `"/opt/homebrew/bin/llama-server"`. (5) Return `None` and let the caller emit an error. | | |
| TASK-041 | In `scripts/launch.py`, if `_resolve_llama_exe()` returns `None`, print a `[launcher][error]` message explaining that llama-server was not found, then print the platform-appropriate install instruction (Windows: download from GitHub releases; macOS: `brew install llama.cpp`; Linux: run `bash scripts/setup.sh`) and exit 1. | | |
| TASK-042 | In `scripts/launch.py`, update `LLAMA_GPU_LAYERS` default: read `profile["recommended_llama_layers"]` from `hardware.load_profile()` as the fallback value if neither `.env` nor env var `LLAMA_GPU_LAYERS` is set. This ensures Metal/CUDA/CPU mode is always correct even before `.env` is manually edited. | | |
| TASK-043 | In `scripts/launch.py`, update `LLAMA_MODEL_PATH` default: (1) check `.env`; (2) check `REPO_ROOT / "models" / "llama" / "Llama-3.2-3B-Instruct-Q4_K_M.gguf"`; (3) scan `~/.ollama/models/blobs/` for any file matching `sha256-*` and return the first one found. Emit a `[warn]` if using the Ollama blob heuristic so the user knows to set `LLAMA_MODEL_PATH` explicitly. | | |

---

### Implementation Phase 9 — Frontend low-memory warning banner

- GOAL-009: Surface the hardware profile's `memory_warning` flag in the frontend as a persistent, dismissible banner that informs the user that CPU mode is active before they speak for the first time.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-044 | In `frontend/app.js`, add a `fetchHardwareProfile()` async function: call `GET ${BACKEND_BASE}/hardware`, parse the JSON response, return the profile object. Call `fetchHardwareProfile()` inside the existing `warmupModels()` flow (or immediately after `fetchSystemStatus()`), store the result in a module-level `_hwProfile` variable. | | |
| TASK-045 | In `frontend/app.js`, after `_hwProfile` is set, check `_hwProfile.memory_warning === true`. If so, call `showLowMemoryBanner(profile)` — a new function defined in the same file. | | |
| TASK-046 | Implement `showLowMemoryBanner(profile)` in `frontend/app.js`. Create a `<div id="hw-warning-banner">` element and inject it into the DOM immediately after `<body>`. Inner HTML: `⚠ LOW MEMORY — Running on CPU (detected ${profile.available_memory_mb} MB, need 8192 MB). Inference will be slow.` Include a dismiss `×` button that calls `document.getElementById('hw-warning-banner').remove()`. | | |
| TASK-047 | In `frontend/style.css`, add styles for `#hw-warning-banner`: `position: fixed; top: 0; left: 0; right: 0; z-index: 9999; background: #7a3800; color: #ffd580; padding: 8px 16px; font-size: 13px; display: flex; justify-content: space-between; align-items: center;`. Dismiss button: `background: none; border: none; color: inherit; cursor: pointer; font-size: 16px;`. | | |

---

### Implementation Phase 10 — `GET /system-status` hardware field additions

- GOAL-010: Extend the existing `/system-status` endpoint to include hardware-profile-derived fields so the existing HUD can show GPU vendor, VRAM, and memory warning without a separate API call.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-048 | In `backend/main.py`, find the `GET /system-status` handler. Import and call `hardware.load_profile()` within the handler. Add the following fields to the response dict: `"gpu_vendor"` (`profile.get("gpu", {}).get("vendor", "none")`), `"gpu_name"` (`profile.get("gpu", {}).get("name", "CPU")`), `"available_memory_mb"` (`profile.get("available_memory_mb", 0)`), `"memory_ok"` (`profile.get("memory_ok", True)`), `"memory_warning"` (`profile.get("memory_warning", False)`). | | |
| TASK-049 | In `frontend/app.js`, update `fetchSystemStatus()` to read the three new fields from the response and store them in `_hwProfile` (merge into existing variable). This avoids two separate fetch calls for the same data. After this task, `fetchHardwareProfile()` from TASK-044 can be simplified to read from the already-fetched status rather than making a dedicated `/hardware` call. | | |

---

### Implementation Phase 11 — Documentation and README updates

- GOAL-011: Update all user-facing documentation to reflect the new one-command setup across all three OSes, remove references to manual binary download steps, and document the memory threshold behaviour.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-050 | In `README.md`, replace the entire "Quickstart" section with a new three-path quickstart: (A) Windows (run `scripts\setup.ps1` in PowerShell), (B) macOS (run `bash scripts/setup.sh`), (C) Linux (run `bash scripts/setup.sh`). Each path is one step: clone → run setup script → open browser. The manual llama-server download step must no longer appear. | | |
| TASK-051 | In `README.md`, add a **Hardware Requirements** section explaining the 8 GB threshold, what happens in CPU fallback mode (the warning banner, slower inference), and the recommended GPU per platform. | | |
| TASK-052 | In `.env.example`, add a comment block at the top: `# Most values below are auto-configured by scripts/setup.sh (or setup.ps1) on first run.` and add comments to `LLAMA_EXE`, `LLAMA_MODEL_PATH`, `LLAMA_GPU_LAYERS`, `ONNX_PROVIDER`, `WHISPER_DEVICE` noting that these are written automatically from the hardware profile. | | |

---

## 3. Alternatives

- **ALT-001**: **Use `torch` device detection** (`torch.cuda.is_available()`, `torch.backends.mps.is_available()`) instead of `pynvml`/`rocm-smi`/`system_profiler` — rejected because importing PyTorch solely for device detection adds ~2 GB of downloads and several seconds of startup time to the setup flow. The project does not otherwise use PyTorch.
- **ALT-002**: **Single `requirements.txt` with PEP 508 environment markers** (`onnxruntime-gpu; sys_platform == "win32"`) — rejected because `onnxruntime-gpu` is not available as an `arm64` wheel and pip would error rather than skip; also, Linux AMD ROCm cannot be expressed via standard platform markers.
- **ALT-003**: **Use Conda environments** to handle multi-GPU dependency conflicts — rejected because Conda significantly increases the bootstrap complexity and conflicts with the existing venv-based workflow. The overlay requirements file approach achieves the same isolation.
- **ALT-004**: **Auto-install ROCm runtime via apt/dnf** — rejected for security and scope reasons. ROCm is an OS-level driver stack, not a pip package. Setup only detects ROCm; installing it is the user's responsibility (advisory message only).
- **ALT-005**: **Use `huggingface_hub` Python library for model download** — deferred. The library is not in the bootstrap set and adds a dependency just for one download. Direct `urllib.request` with a progress bar (same pattern as `download_models.py`) is sufficient and keeps the bootstrap minimal.
- **ALT-006**: **Docker multi-arch image** — rejected. Docker on macOS introduces overhead and defeats the Metal/CoreML acceleration goal. Docker on Windows requires Hyper-V or WSL2, adding friction for non-technical users.
- **ALT-007**: **Single mega-script (`setup_all.py`) replacing both `setup.sh` and `setup.ps1`** — considered but rejected. A Python setup script cannot activate a venv for the calling shell (a fundamental limitation of subprocess environments). Bash/PS1 wrappers are necessary for the venv activation step. Python handles everything inside the activated venv.

---

## 4. Dependencies

- **DEP-001**: `pynvml>=11.0.0` — NVIDIA GPU detection; bootstrap-installed before main requirements. Wraps the NVML C library that ships with NVIDIA drivers.
- **DEP-002**: `psutil>=5.9.0` — system RAM fallback; bootstrap-installed. Cross-platform, no native dependencies.
- **DEP-003**: `onnxruntime>=1.18.0` — CPU / CoreML / ROCm path. Standard PyPI package, available for `arm64` macOS.
- **DEP-004**: `onnxruntime-gpu>=1.20.0` — NVIDIA CUDA path (Windows/Linux). Requires CUDA 12 runtime.
- **DEP-005**: `kokoro-onnx>=0.5.0` (no extras) — TTS; CPU / CoreML / ROCm path.
- **DEP-006**: `kokoro-onnx[gpu]>=0.5.0` — TTS; NVIDIA path; pulls in `onnxruntime-gpu`.
- **DEP-007**: `faster-whisper>=1.0.0` — STT; uses ctranslate2 which supports CUDA and CPU. ARM64/macOS wheels available.
- **DEP-008**: `llama-server` binary — downloaded from `https://github.com/ggml-org/llama.cpp/releases/latest`. Not a pip package.
- **DEP-009**: Default GGUF model (`Llama-3.2-3B-Instruct-Q4_K_M.gguf`) — downloaded from `https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF`.
- **DEP-010**: ROCm 6.x runtime (Linux AMD) — must be installed at OS level by the user; `onnxruntime` dynamically loads `ROCMExecutionProvider` when ROCm libraries are present on `LD_LIBRARY_PATH`.
- **DEP-011**: Homebrew + `llama.cpp` formula (macOS) — advisory only; not auto-installed.

---

## 5. Files

- **FILE-001**: `scripts/detect_hardware.py` — new; hardware detection and profile writer
- **FILE-002**: `scripts/download_llama_server.py` — new; llama-server binary auto-downloader
- **FILE-003**: `scripts/download_model.py` — new; default GGUF model auto-downloader
- **FILE-004**: `scripts/write_env.py` — new; hardware-profile-to-`.env` patcher
- **FILE-005**: `scripts/setup.sh` — rewritten; hardware-aware orchestrator
- **FILE-006**: `scripts/setup.ps1` — new; Windows PowerShell equivalent of `setup.sh`
- **FILE-007**: `scripts/launch.py` — updated; cross-platform binary resolution
- **FILE-008**: `requirements-base.txt` — new; platform-agnostic packages
- **FILE-009**: `requirements-nvidia.txt` — new; NVIDIA CUDA overlay
- **FILE-010**: `requirements-amd-linux.txt` — new; AMD ROCm Linux overlay
- **FILE-011**: `requirements-mac.txt` — new; macOS Apple Silicon overlay
- **FILE-012**: `requirements-cpu.txt` — new; CPU fallback overlay
- **FILE-013**: `requirements.txt` — updated; redirects to `requirements-nvidia.txt`
- **FILE-014**: `backend/hardware.py` — new; profile reader / cache module
- **FILE-015**: `backend/main.py` — updated; new `/hardware` endpoint, startup memory warning, `/system-status` additions
- **FILE-016**: `backend/stt.py` — updated; profile-aware `_resolve_device()`
- **FILE-017**: `backend/tts.py` — updated; profile-aware default ONNX provider
- **FILE-018**: `backend/memory/.hardware_profile.json` — runtime artefact (gitignored); written by `detect_hardware.py`
- **FILE-019**: `tools/llama/llama-server[.exe]` — runtime artefact (gitignored); written by `download_llama_server.py`
- **FILE-020**: `models/llama/Llama-3.2-3B-Instruct-Q4_K_M.gguf` — runtime artefact (gitignored); written by `download_model.py`
- **FILE-021**: `frontend/app.js` — updated; `fetchHardwareProfile()`, `showLowMemoryBanner()`
- **FILE-022**: `frontend/style.css` — updated; `#hw-warning-banner` styles
- **FILE-023**: `Makefile` — updated; `install` target dispatches to PS1 on Windows
- **FILE-024**: `.env.example` — updated; auto-configuration comments
- **FILE-025**: `README.md` — updated; three-OS quickstart, hardware requirements section
- **FILE-026**: `.gitignore` — updated; add `backend/memory/.hardware_profile.json`, `tools/`, `models/llama/`

---

## 6. Testing

- **TEST-001**: On Windows + NVIDIA (≥8 GB VRAM): run `scripts\setup.ps1`. Verify: `.hardware_profile.json` written with `gpu.vendor=nvidia`, `memory_ok=true`, `requirements_overlay=requirements-nvidia.txt`. Verify `pip list` shows `onnxruntime-gpu`, all `nvidia-*` packages. Verify `tools/llama/llama-server.exe` exists and is executable.
- **TEST-002**: On Windows + NVIDIA (<8 GB VRAM): manually set GPU VRAM stub to 4096 MB in the profile. Verify `memory_ok=false`, `requirements_overlay=requirements-cpu.txt`, `LLAMA_GPU_LAYERS=0` written to `.env`.
- **TEST-003**: On Linux + NVIDIA (≥8 GB VRAM): run `bash scripts/setup.sh`. Verify same as TEST-001 but binary is `llama-server` (no `.exe`) and CUDA Linux build is downloaded.
- **TEST-004**: On Linux + AMD (ROCm installed, ≥8 GB VRAM): verify `detect_hardware.py` reads `rocm-smi` output, sets `gpu.vendor=amd`, `requirements_overlay=requirements-amd-linux.txt`, `recommended_onnx_provider=ROCMExecutionProvider`.
- **TEST-005**: On Linux + AMD (ROCm NOT installed): verify `detect_amd()` returns `None`, system falls back to CPU profile with warning.
- **TEST-006**: On macOS Apple Silicon (≥16 GB Unified Memory): run `bash scripts/setup.sh`. Verify `gpu.vendor=apple`, `memory_ok=true`, `requirements_overlay=requirements-mac.txt`, no `onnxruntime-gpu` in `pip list`, advisory message printed for Homebrew llama.cpp.
- **TEST-007**: On any platform with <8 GB memory: verify terminal prints `[warn] LOW MEMORY` block, `.env` has `LLAMA_GPU_LAYERS=0`, `WHISPER_DEVICE=cpu`, `ONNX_PROVIDER=CPUExecutionProvider`.
- **TEST-008**: On any platform, start backend after setup. Call `GET /hardware`. Verify JSON response matches `backend/memory/.hardware_profile.json` contents.
- **TEST-009**: On any platform, start backend after setup with `memory_warning=true`. Verify `[WARNING] LOW MEMORY MODE` appears in server startup log output.
- **TEST-010**: On any platform, open `http://localhost:8000` with `memory_warning=true` in profile. Verify `#hw-warning-banner` element is present in DOM, contains the VRAM figure, and disappears on dismiss button click.
- **TEST-011**: Re-run `bash scripts/setup.sh` on an already-provisioned machine. Verify the script prints skip messages for each already-present artefact (profile, binary, model, Kokoro files) and exits without reinstalling anything.
- **TEST-012**: On Windows, run `pip install -r requirements.txt` (bare, no setup script). Verify it still installs the full NVIDIA stack (backward compatibility for existing users).
- **TEST-013**: Simulate a corrupt SHA-256 on the llama-server zip download by providing a bad checksum. Verify `download_llama_server.py` deletes the partial file and exits with a non-zero exit code and a `[error]` message.
- **TEST-014**: Run `scripts/test_integration.py` on all three platforms after full setup. Verify all existing endpoint tests pass.

---

## 7. Risks & Assumptions

- **RISK-001**: GitHub Releases API is rate-limited at 60 unauthenticated requests/hour per IP. A CI environment running setup many times could hit this. Mitigation: cache the release metadata in `backend/memory/.release_manifest.json` with a 24-hour TTL; skip the API call if the cache is fresh.
- **RISK-002**: The `rocm-smi --json` output schema may differ between ROCm 5.x and 6.x. Mitigation: wrap the parse in a broad try/except; any parse failure returns `None` from `detect_amd()` and falls back to CPU.
- **RISK-003**: `system_profiler -json` on macOS may return different key names across OS versions (e.g., "memory" vs "physical_memory"). Mitigation: try multiple key names in the parser; log the raw dict at debug level if none match.
- **RISK-004**: `Llama-3.2-3B-Instruct-Q4_K_M.gguf` (~2 GB) download on a slow connection may time out. Mitigation: use `urllib.request.urlretrieve` without a fixed timeout; allow the download to run as long as needed. Partial files are detected by comparing file size to the `Content-Length` header.
- **RISK-005**: `pynvml` version mismatches between the bootstrap install and the `requirements-nvidia.txt` pin could cause re-installation conflicts. Mitigation: do not pin `pynvml` in `requirements-nvidia.txt`; let pip resolve it freely.
- **RISK-006**: On some Linux distributions, `python3` may resolve to Python 3.10 while Python 3.11 is installed as `python3.11`. Mitigation: the existing `setup.sh` Python version check already handles this; no change needed.
- **RISK-007**: AMD ROCm `ROCMExecutionProvider` in the standard `onnxruntime` package requires matching ROCm library versions. A mismatch silently falls back to CPU at runtime. Mitigation: the backend logs the active ONNX providers at startup (existing `tts.py` behaviour); no user-visible error, just CPU instead of GPU.
- **ASSUMPTION-001**: The user's machine has an internet connection for the first-run downloads. Offline first-run is out of scope.
- **ASSUMPTION-002**: On macOS, Homebrew is the expected llama.cpp installation path. Users who build llama.cpp from source can set `LLAMA_EXE` manually in `.env`.
- **ASSUMPTION-003**: The default GGUF model (`Llama-3.2-3B-Instruct-Q4_K_M.gguf`) is suitable for all platforms, including CPU-only mode. It is ~2 GB and fits within 8 GB RAM with room for the backend processes.
- **ASSUMPTION-004**: The user has a valid NVIDIA driver installed (not just the CUDA toolkit) for `pynvml` to detect the GPU. The driver must be version 525+ for NVML to return accurate VRAM figures.
- **ASSUMPTION-005**: Linux users with AMD GPUs have already installed ROCm 6.x at the OS level before running setup. Setup detects and uses it but does not install it.

---

## 8. Related Specifications / Further Reading

- [plan/feature-mac-m4-compatibility-1.md](feature-mac-m4-compatibility-1.md) — Iteration 1 (two-platform); this plan supersedes its requirements file split but the Mac-specific backend changes (TASK-008 through TASK-011 of that plan) are prerequisites.
- [llama.cpp GitHub Releases — binary downloads](https://github.com/ggml-org/llama.cpp/releases/latest)
- [pynvml documentation](https://pypi.org/project/pynvml/)
- [onnxruntime execution providers overview](https://onnxruntime.ai/docs/execution-providers/)
- [ROCm installation guide (Linux)](https://rocm.docs.amd.com/projects/install-on-linux/en/latest/)
- [faster-whisper supported devices and compute types](https://github.com/SYSTRAN/faster-whisper#readme)
- [HuggingFace bartowski/Llama-3.2-3B-Instruct-GGUF](https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF)
- [plan/feature-starling-soul-personality-1.md](feature-starling-soul-personality-1.md) — unaffected by this plan; system prompt configuration is independent of hardware backend
