---
goal: Simple On/Off Launcher for S.T.A.R.L.I.N.G.
version: '1.0'
date_created: 2026-05-19
last_updated: 2026-05-19
owner: simps
status: 'Planned'
tags: [feature, infrastructure, dx, launcher, process-management]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Currently starting S.T.A.R.L.I.N.G. requires two independent terminals with specific commands: one for `llama-server` (via `scripts/start_llama_server.bat` or `make llama`) and one for the FastAPI backend (via `make backend`). This plan introduces a single-command launcher and stopper that abstracts all of this away — `make up` to start everything, `Ctrl+C` or `make down` to stop everything cleanly.

## 1. Requirements & Constraints

- **REQ-001**: A single command must start both `llama-server` and the FastAPI backend together.
- **REQ-002**: A single command (or `Ctrl+C`) must gracefully stop all running services.
- **REQ-003**: The launcher must work on Windows (primary target) using the existing `.venv` Python environment.
- **REQ-004**: The launcher must re-use existing configuration from `scripts/start_llama_server.bat` and the Makefile (ports, paths, model alias).
- **REQ-005**: The launcher must write PID information to a lock file (`backend/memory/.starling.pid`) so a separate stop command can terminate processes without needing `Ctrl+C`.
- **REQ-006**: The launcher must stream stdout/stderr from both child processes to the terminal so the user can see logs.
- **REQ-007**: If `llama-server` exits unexpectedly, the launcher must log the failure and shut down the backend too, rather than leaving a zombie process.
- **CON-001**: Must not require any new Python packages beyond what is already in `requirements.txt`. Only stdlib modules (`subprocess`, `signal`, `threading`, `pathlib`, `os`) are permitted.
- **CON-002**: Must not break existing `make backend`, `make llama`, or `make frontend` targets.
- **CON-003**: Launcher configuration (llama exe path, model path, ports) must be sourced from environment variables / `.env` file, consistent with the existing pattern.
- **GUD-001**: The Makefile targets `up` and `down` are the canonical entry points; the underlying Python script is an implementation detail.
- **GUD-002**: Windows-native `.bat` wrappers are provided for users who cannot run `make`.
- **PAT-001**: Follow the existing Makefile OS-detection pattern (`ifeq ($(OS),Windows_NT)`) for cross-platform target variants.

## 2. Implementation Steps

### Implementation Phase 1 — Core Python Launcher Script

- GOAL-001: Create `scripts/launch.py` — a self-contained Python process manager that starts `llama-server` and the FastAPI backend as supervised subprocesses, forwards their output, writes a PID file, and shuts both down cleanly on `Ctrl+C` or SIGTERM.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `scripts/launch.py`. Read `LLAMA_EXE`, `LLAMA_MODEL_PATH`, `LLAMA_ALIAS`, `LLAMA_PORT`, `LLAMA_HOST`, `LLAMA_GPU_LAYERS`, `LLAMA_CTX_SIZE` from `.env` (via `python-dotenv` or manual parse). Fall back to the same defaults as `start_llama_server.bat`. | | |
| TASK-002 | In `launch.py`, define `start_llama()` — spawn `llama-server` using `subprocess.Popen` with merged stdout/stderr, non-blocking. Log the command to console before spawning. | | |
| TASK-003 | In `launch.py`, define `start_backend()` — spawn `python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload --reload-dir .` from the `backend/` directory using the `.venv` Python executable. | | |
| TASK-004 | In `launch.py`, define `stream_output(proc, prefix)` — run in a `threading.Thread`, reads `proc.stdout` line-by-line and prints `[prefix] <line>` to stdout. One thread per process. | | |
| TASK-005 | In `launch.py`, write a PID file at `backend/memory/.starling.pid` containing `{"llama": <pid>, "backend": <pid>}` as JSON after both processes are launched. | | |
| TASK-006 | In `launch.py`, register a `signal.signal(signal.SIGINT, shutdown_handler)` and `signal.signal(signal.SIGTERM, shutdown_handler)` handler. `shutdown_handler` must: (1) call `proc.terminate()` on both processes, (2) wait up to 5 seconds for each with `proc.wait(timeout=5)`, (3) call `proc.kill()` if not exited, (4) delete the PID file, (5) exit 0. | | |
| TASK-007 | In `launch.py`, add a watchdog loop after startup: check `proc.poll()` every 2 seconds. If either process exits unexpectedly, log the exit code, call `shutdown_handler`, and exit 1. | | |

### Implementation Phase 2 — Stop Script

- GOAL-002: Create `scripts/stop.py` — reads the PID file and terminates running processes, enabling `make down` without requiring `Ctrl+C`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | Create `scripts/stop.py`. Read `backend/memory/.starling.pid`. If file does not exist, print "S.T.A.R.L.I.N.G. is not running." and exit 0. | | |
| TASK-009 | In `stop.py`, for each PID in the file: send `SIGTERM` on POSIX or call `taskkill /F /PID <pid>` on Windows. Wait up to 5 seconds. Print confirmation for each process terminated. | | |
| TASK-010 | In `stop.py`, delete `backend/memory/.starling.pid` after all processes are stopped. | | |

### Implementation Phase 3 — Makefile Targets

- GOAL-003: Add `make up` and `make down` as first-class targets in the existing `Makefile`, making them the canonical interface.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-011 | Add `.PHONY: up down` to the `Makefile` `.PHONY` declaration line. | | |
| TASK-012 | Add `up` target to `Makefile`: runs `$(PYTHON) scripts/launch.py`. Add a description line in the `help` target: `make up      Start llama-server + backend together (Ctrl+C to stop)`. | | |
| TASK-013 | Add `down` target to `Makefile`: runs `$(PYTHON) scripts/stop.py`. Add description to `help`: `make down    Stop all S.T.A.R.L.I.N.G. processes via PID file`. | | |

### Implementation Phase 4 — Windows Convenience Wrappers

- GOAL-004: Provide `start.bat` and `stop.bat` in the project root so users without `make` can double-click to start/stop the system.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-014 | Create `start.bat` in the project root. Contents: `@echo off` + activate `.venv\Scripts\activate.bat` + `python scripts\launch.py`. Title the window "S.T.A.R.L.I.N.G.". | | |
| TASK-015 | Create `stop.bat` in the project root. Contents: `@echo off` + activate `.venv\Scripts\activate.bat` + `python scripts\stop.py`. | | |

### Implementation Phase 5 — Documentation Update

- GOAL-005: Update `README.md` with a "Quick Start" section documenting the new `make up` / `make down` workflow.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-016 | Add a "## Quick Start" section to `README.md` (at the top, after the title) explaining: (1) prerequisites, (2) `make install`, (3) `make up` to start, (4) `Ctrl+C` or `make down` to stop. | | |
| TASK-017 | Update `SIMPLE_ON_OFF.md` (in `markdown/`) to reference the final implementation with example commands and expected output. | | |

## 3. Alternatives

- **ALT-001**: **PowerShell script (`start.ps1` / `stop.ps1`)** — PowerShell has native job management (`Start-Job`, `Stop-Job`) and is available on all modern Windows systems. Rejected because the project already uses Python for all scripting, and a Python launcher is cross-platform without requiring PowerShell 7+.
- **ALT-002**: **`tmux` / `screen` session** — splits panes automatically on Linux/Mac. Rejected because the primary development platform is Windows and `tmux` is not universally available there.
- **ALT-003**: **`docker-compose`** — would containerize both services and provide `up`/`down` semantics natively. Rejected as over-engineering: it introduces Docker as a hard dependency and complicates GPU pass-through for llama-server.
- **ALT-004**: **`concurrently` (Node.js npm package)** — a popular tool for running multiple processes in one terminal. Rejected because it requires Node.js as a runtime dependency and the project is otherwise Python-only.
- **ALT-005**: **`supervisord`** — production-grade process manager. Rejected as too heavy for a local dev-only workflow; also requires a separate install.
- **ALT-006**: **Extend `start_llama_server.bat`** — simply chain the backend start at the end of the existing `.bat` file. Rejected because `.bat` files cannot cleanly supervise two independent processes or forward their output simultaneously.

## 4. Dependencies

- **DEP-001**: `python-dotenv` — already in `requirements.txt`; used by `launch.py` to load `.env` configuration. If not available, `launch.py` falls back to `os.environ` with hardcoded defaults matching `start_llama_server.bat`.
- **DEP-002**: `llama-server.exe` — must be installed and its path set in `.env` as `LLAMA_EXE` (or matching the default `C:\llama.cpp\llama-server.exe` from `start_llama_server.bat`).
- **DEP-003**: `.venv` Python virtual environment — created by `make install` / `scripts/setup.sh`. Must exist before running `make up`.
- **DEP-004**: A GGUF model file at the path specified by `LLAMA_MODEL_PATH` in `.env`.

## 5. Files

- **FILE-001**: `scripts/launch.py` — **new file**. Core process manager. Starts `llama-server` and the FastAPI backend as subprocesses.
- **FILE-002**: `scripts/stop.py` — **new file**. Reads PID file and terminates running services.
- **FILE-003**: `Makefile` — **modified**. Add `up`, `down` targets and update `help` text.
- **FILE-004**: `start.bat` — **new file**. Windows double-click launcher in project root.
- **FILE-005**: `stop.bat` — **new file**. Windows double-click stopper in project root.
- **FILE-006**: `README.md` — **modified**. Add "Quick Start" section.
- **FILE-007**: `markdown/SIMPLE_ON_OFF.md` — **modified**. Document the final implementation.
- **FILE-008**: `backend/memory/.starling.pid` — **runtime artifact** (not tracked in git). Created by `launch.py`, deleted by `stop.py` or shutdown handler. Add to `.gitignore`.

## 6. Testing

- **TEST-001**: Run `make up` and verify both `llama-server` (port 8080) and the FastAPI backend (port 8000) are reachable within 10 seconds. Use `curl http://localhost:8000/health` and `curl http://localhost:8080/health`.
- **TEST-002**: Verify `backend/memory/.starling.pid` is created after `make up` and contains valid integer PIDs for both processes.
- **TEST-003**: Press `Ctrl+C` during a running `make up` session. Verify both processes exit within 6 seconds and `.starling.pid` is deleted.
- **TEST-004**: Run `make up`, then in a separate terminal run `make down`. Verify both processes are terminated and `.starling.pid` is deleted.
- **TEST-005**: Manually kill the `llama-server` process. Verify the watchdog in `launch.py` detects this within 4 seconds, logs the exit code, terminates the backend, and exits with code 1.
- **TEST-006**: Run `make down` when no services are running. Verify the script prints "S.T.A.R.L.I.N.G. is not running." and exits 0 without errors.
- **TEST-007**: Run `start.bat` from a double-click (Windows Explorer). Verify it activates the venv and launches both services in the same terminal window.

## 7. Risks & Assumptions

- **RISK-001**: On Windows, `signal.SIGTERM` is not fully supported — `proc.terminate()` on a `subprocess.Popen` object maps to `TerminateProcess()` Win32 call, which is abrupt. The stop script uses `taskkill /F` as a fallback to ensure termination.
- **RISK-002**: If `llama-server` takes longer than expected to load the model (large GGUF files can take 30–60 seconds), the backend may start and be healthy before the LLM is ready. The launcher does not gate backend startup on llama-server readiness; this is acceptable for a dev launcher.
- **RISK-003**: Port conflicts — if port 8080 or 8000 is already in use, processes will fail to bind. `launch.py` detects this via the watchdog (process exits immediately) and surfaces the exit code/stderr.
- **ASSUMPTION-001**: The `.venv` virtual environment is already set up via `make install` before `make up` is first run.
- **ASSUMPTION-002**: `llama-server.exe` path and model path are correctly configured in `.env` before running `make up`.
- **ASSUMPTION-003**: The user's terminal supports ANSI colour codes (used for `[llama]` / `[backend]` prefixed log lines).

## 8. Related Specifications / Further Reading

- [Makefile](../Makefile) — existing make targets for `backend`, `llama`, `frontend`
- [scripts/start_llama_server.bat](../scripts/start_llama_server.bat) — existing llama-server launcher with configuration reference
- [scripts/setup.sh](../scripts/setup.sh) — project install script
- [backend/main.py](../backend/main.py) — FastAPI entrypoint; `LLM_BACKEND` env var controls llama vs ollama routing
- [Python subprocess docs](https://docs.python.org/3/library/subprocess.html)
- [Python signal docs](https://docs.python.org/3/library/signal.html)
