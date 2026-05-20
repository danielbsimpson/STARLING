---
goal: Package S.T.A.R.L.I.N.G. as a standalone Electron desktop application installable on Windows, macOS, and Linux with no Python, Node, or CUDA toolkit pre-installed
version: 1.0
date_created: 2026-05-20
last_updated: 2026-05-20
owner: Daniel Simpson
status: 'Planned'
tags: [feature, infrastructure, electron, packaging, cross-platform, desktop-app]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan packages S.T.A.R.L.I.N.G. as a native desktop application using Electron and electron-builder. The user downloads a single installer (`.exe` NSIS on Windows, `.dmg` on macOS, `.AppImage` on Linux) and the full stack — Python FastAPI backend, llama-server, Kokoro TTS, Whisper STT, and the frontend — starts automatically inside a single native window. No terminal, no virtual environment, no manual server launch is required.

The Electron main process acts as a process supervisor: it spawns the PyInstaller-frozen Python backend and the platform-appropriate llama-server binary, polls until both are ready, then opens a `BrowserWindow` pointed at `http://localhost:8000`. If the GGUF model file has not yet been downloaded, a first-run download modal is presented before the main window opens.

This plan depends on `plan/feature-cross-platform-auto-detect-1.md` being implemented first. The hardware detection module (`scripts/detect_hardware.py` → `backend/memory/.hardware_profile.json`) is read by the Electron main process to select GPU layers and the correct ONNX provider before spawning child processes.

**Target installer outputs:**

| Platform | Format | Installer tool | Min requirements |
|---|---|---|---|
| Windows x64 | NSIS `.exe` installer | electron-builder | Windows 10+, NVIDIA driver (optional) |
| macOS arm64 | `.dmg` drag-to-Applications | electron-builder | macOS 13+ (Ventura), Apple Silicon |
| macOS x64 | `.dmg` drag-to-Applications | electron-builder | macOS 12+ (Monterey), Intel |
| Linux x64 | `.AppImage` (portable) | electron-builder | glibc 2.31+ (Ubuntu 20.04+) |

---

## 1. Requirements & Constraints

- **REQ-001**: The final installer must be fully self-contained. The end user must not need to install Python, Node.js, CUDA toolkit, Homebrew, or any system-level dependency to run S.T.A.R.L.I.N.G.
- **REQ-002**: The Python backend must be frozen with PyInstaller into a folder-mode bundle (`onefile=False`) so ONNX runtime DLLs, ctranslate2 native modules, and the `frontend/` static asset tree are all co-located and resolvable at runtime without modifying any backend Python code.
- **REQ-003**: The llama-server binary (platform-specific) and the Kokoro ONNX model files must be bundled into the Electron `resources/` directory at build time and resolved via `process.resourcesPath` at runtime.
- **REQ-004**: If the GGUF model file is larger than the installer size limit (configurable, default 3 GB), it must NOT be bundled; instead a first-run download modal must stream it from HuggingFace into `app.getPath('userData')/models/` with a progress bar before the main window opens.
- **REQ-005**: The Electron main process must write a resolved `.env` file to `app.getPath('userData')/.env` before spawning the backend binary, substituting all relative paths (journal dir, chroma db, model paths) with absolute paths under `userData`.
- **REQ-006**: Auto-update must be implemented via `electron-updater` pointing to a GitHub Releases feed. Updates must be checked silently on startup and presented to the user as a dismissible prompt before downloading.
- **REQ-007**: The application must include a system tray icon on all three platforms with a right-click menu: "Open S.T.A.R.L.I.N.G.", "Restart backend", "Quit".
- **REQ-008**: The `BrowserWindow` must only be shown (`.show()`) after `did-finish-load` fires to prevent a white flash. A splash window must be shown while child processes are starting.
- **REQ-009**: Both child processes (backend, llama-server) must be cleanly terminated on `app.before-quit` and `window-all-closed`. On abnormal exit of either child process, an error dialog must be shown and `app.quit()` must be called.
- **REQ-010**: `nodeIntegration` must be `false` and `contextIsolation` must be `true` in all `BrowserWindow` `webPreferences`. All Node API exposure must go through `electron/preload.js` and `contextBridge`.
- **REQ-011**: The existing developer workflow (`make up`, `start.bat`, `start.sh`) must continue to function unchanged for iterative development. Electron is an optional packaging layer, not a replacement.
- **REQ-012**: The `make electron-dev` target must launch Electron in dev mode: no PyInstaller, assumes `make up` or `make backend` is already running; Electron simply opens a window at `http://localhost:8000`.
- **SEC-001**: `webSecurity` must remain `true` (default). Do not set `webSecurity: false` in any `BrowserWindow`.
- **SEC-002**: IPC handlers in `ipcMain` must validate all arguments before acting. File path arguments must be resolved with `path.resolve()` and verified to be within permitted directories before being passed to `shell.openPath()`.
- **SEC-003**: The backend binary must not be run with elevated privileges. Electron's `child_process.spawn` must not use `shell: true`.
- **CON-001**: PyInstaller `onefile=False` (folder bundle) is required — `onefile=True` adds 3–10 s cold-start extraction overhead, which conflicts with the splash screen UX.
- **CON-002**: The PyInstaller spec must include all `faster_whisper`, `kokoro_onnx`, `chromadb`, `fastembed`, and `onnxruntime` data files and native binaries as `datas` and `binaries` entries, not just hidden imports.
- **CON-003**: On macOS, the app bundle must be code-signed for Gatekeeper to allow launch. If no signing identity is available, `hardened-runtime` and notarization can be skipped and the user must right-click → Open on first launch. Document this in the README.
- **CON-004**: electron-builder `extraResources` copying happens at package time. Files in `resources/` at build time must be generated by prior Makefile targets (`make build-backend`, `make bundle-llama-server`). The `make dist` target must enforce this order.
- **CON-005**: The `node_modules/` directory generated by `npm install` at repo root must be excluded from all Python-aware tools (ruff, pyinstaller) and must be added to `.gitignore`.
- **GUD-001**: All Electron JS files must use `'use strict'` and ES module-compatible syntax (CommonJS `require()` is acceptable for Electron main process).
- **GUD-002**: Log files for both child processes must be written to `app.getPath('logs')/llama-server.log` and `app.getPath('logs')/backend.log`. The tray "Open Logs Folder" item must call `shell.openPath(app.getPath('logs'))`.
- **GUD-003**: All hardcoded port numbers (`8000`, `8080`) must be defined as constants at the top of `electron/main.js` and in `electron/constants.js` — not duplicated inline.
- **PAT-001**: Follow the Electron security checklist: no `nodeIntegration`, `contextIsolation: true`, `sandbox: true` where possible, explicit CSP header via `session.defaultSession.webRequest.onHeadersReceived`.
- **PAT-002**: The `electron/main.js` must be structured in distinct sections with the same comment-block style as `scripts/launch.py`: Paths, Config, Window, Tray, Spawn, Polling, IPC, Shutdown.

---

## 2. Implementation Steps

### Implementation Phase 1 — Root package.json and Electron scaffold

- GOAL-001: Create the Electron project structure at repo root so `npm install` installs Electron and electron-builder as dev dependencies, and `npx electron .` launches the app in dev mode.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create root `package.json`. Fields: `"name": "starling-local"`, `"version": "1.0.0"`, `"description": "S.T.A.R.L.I.N.G. — local AI voice assistant"`, `"main": "electron/main.js"`, `"scripts": { "start": "electron .", "build": "electron-builder", "dev": "ELECTRON_DEV=true electron ." }`. `"devDependencies"`: `"electron": "^30.0.0"`, `"electron-builder": "^24.0.0"`, `"electron-updater": "^6.0.0"`. Set `"private": true`. | | |
| TASK-002 | Create `electron/` directory. Create `electron/constants.js`: export `BACKEND_PORT = 8000`, `LLAMA_PORT = 8080`, `BACKEND_HEALTH_URL = "http://127.0.0.1:8000/health"`, `LLAMA_HEALTH_URL = "http://127.0.0.1:8080/health"`, `POLL_INTERVAL_MS = 500`, `POLL_TIMEOUT_MS = 60000`, `STARTUP_LOG_DIR_NAME = "logs"`. | | |
| TASK-003 | Create `electron/main.js` skeleton with section headers: `// ── Imports`, `// ── Constants`, `// ── State`, `// ── Paths`, `// ── Config`, `// ── Logging`, `// ── Splash`, `// ── Main Window`, `// ── Tray`, `// ── Child Processes`, `// ── Readiness Polling`, `// ── IPC`, `// ── Shutdown`, `// ── Entry`. Wire `app.whenReady()` to call `bootstrap()` (stub). Wire `app.on('before-quit', shutdown)`. Wire `app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); })`. | | |
| TASK-004 | Create `electron/preload.js` with `contextBridge.exposeInMainWorld('starling', { getAppVersion: () => ipcRenderer.invoke('get-app-version'), openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'), openUserDataFolder: () => ipcRenderer.invoke('open-userdata-folder') })`. Import `{ contextBridge, ipcRenderer }` from `'electron'`. | | |
| TASK-005 | Run `npm install` to generate `node_modules/` and `package-lock.json`. Verify `node_modules/electron/` and `node_modules/electron-builder/` are present. | | |
| TASK-006 | Update `.gitignore`: add `node_modules/`, `package-lock.json`, `electron/dist/`, `dist/electron/`, `resources/backend_dist/`, `resources/llama/`, `resources/models/`. | | |

---

### Implementation Phase 2 — Electron main process: window creation and lifecycle

- GOAL-002: Implement `electron/main.js` fully — splash window, main window, tray, readiness polling, and child process supervisor — so `npm start` opens the full application in dev mode (connecting to a manually-running backend).

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | In `electron/main.js`, implement `createSplashWindow()`: create a non-resizable `BrowserWindow` (400×260, no frame, transparent background, no taskbar entry). Load `electron/splash.html`. Store in `_splashWin`. Show immediately. | | |
| TASK-008 | In `electron/main.js`, implement `createMainWindow()`: create `BrowserWindow` (1280×800, min 900×600). `webPreferences`: `preload: path.join(__dirname, 'preload.js')`, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Load `http://127.0.0.1:${BACKEND_PORT}`. Call `win.show()` only inside `win.webContents.on('did-finish-load', ...)`. Attach `win.on('closed', ...)` to set `_mainWin = null`. Return the window. Store in `_mainWin`. | | |
| TASK-009 | In `electron/main.js`, implement `createTray(iconPath)`: create `Tray` from `iconPath`. Set tooltip `'S.T.A.R.L.I.N.G.'`. Build context menu with four items: `'Open S.T.A.R.L.I.N.G.'` (calls `_mainWin?.show()`), `'Restart Backend'` (calls `restartBackend()`), separator, `'Quit'` (calls `app.quit()`). Register double-click on tray to show/focus main window. | | |
| TASK-010 | In `electron/main.js`, implement `getIconPath()`: returns `path.join(__dirname, '..', 'assets', 'images', 'tray-icon-16.png')` on Windows/Linux, `path.join(__dirname, '..', 'assets', 'images', 'tray-icon.icns')` on macOS. | | |
| TASK-011 | Create `electron/splash.html`: a self-contained HTML file (no external references) showing the S.T.A.R.L.I.N.G. name in white text on a black background with a pulsing CSS animation. Include a status line `<p id="status">Starting…</p>` that `main.js` can update via `_splashWin.webContents.send('splash-status', message)`. No backend connection required — all styles are inline. | | |
| TASK-012 | In `electron/main.js`, implement `restartBackend()`: call `_terminate(_backendProc, 'backend')`, set `_backendProc = null`, call `spawnBackend()`, update tray tooltip to `'S.T.A.R.L.I.N.G. — restarting…'`. | | |
| TASK-013 | In `electron/main.js`, add a `session.defaultSession.webRequest.onHeadersReceived` handler in `createMainWindow()` that injects a `Content-Security-Policy` header: `default-src 'self' http://127.0.0.1:8000; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src http://127.0.0.1:8000 http://127.0.0.1:8080; img-src 'self' data: https:;`. This must be set before the main window loads. | | |

---

### Implementation Phase 3 — Child process spawning and readiness polling

- GOAL-003: Implement the subprocess supervisor in `electron/main.js` that starts the backend and llama-server, streams their output to log files, and resolves when both health endpoints return 200.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-014 | In `electron/main.js`, implement `resolveBackendBinary()`: in packaged mode (`app.isPackaged`), return `path.join(process.resourcesPath, 'backend_dist', 'main', IS_WIN ? 'main.exe' : 'main')`. In dev mode, return `null` (backend launched manually). | | |
| TASK-015 | In `electron/main.js`, implement `resolveLlamaBinary()`: in packaged mode, return `path.join(process.resourcesPath, 'llama', IS_WIN ? 'llama-server.exe' : 'llama-server')`. In dev mode, resolve via `which` equivalent: check `PATH` for `llama-server`, then check `tools/llama/llama-server[.exe]` relative to repo root, then on macOS check `/opt/homebrew/bin/llama-server`. | | |
| TASK-016 | In `electron/main.js`, implement `resolveModelPath()`: in packaged mode, check `path.join(process.resourcesPath, 'models', 'llama', MODEL_FILENAME)` first. Then check `path.join(app.getPath('userData'), 'models', MODEL_FILENAME)`. Return whichever exists, or `null` if neither. | | |
| TASK-017 | In `electron/main.js`, implement `buildEnv(resolvedPaths)`: create an env object from `process.env` and add/override: `LLAMA_MODEL_PATH`, `LLAMA_EXE`, `LLAMA_GPU_LAYERS` (from hardware profile), `ONNX_PROVIDER` (from hardware profile), `WHISPER_DEVICE` (from hardware profile), `BACKEND_PORT`, `LLAMA_PORT`, `JOURNAL_DIR` → `userData/memory/journal`, `CHROMA_DB_PATH` → `userData/memory/chroma_db`, `IDEAS_FILE` → `userData/memory/ideas.json`, `WEATHER_CACHE_FILE` → `userData/memory/weather_cache.json`. Write the merged env to `userData/.env` using `fs.writeFileSync` before spawning processes. | | |
| TASK-018 | In `electron/main.js`, implement `loadHardwareProfile()`: read `path.join(app.getPath('userData'), 'memory', '.hardware_profile.json')`. If the file does not exist (first run, packaged), run `detect_hardware.py` via the frozen backend binary's embedded Python, or use safe defaults: `{recommended_llama_layers: "99", recommended_onnx_provider: "CPUExecutionProvider", memory_ok: true, memory_warning: false}`. Cache the result in `_hwProfile`. | | |
| TASK-019 | In `electron/main.js`, implement `spawnBackend()`: if dev mode, log `[main] Dev mode — backend must be started manually` and return. Otherwise call `resolveBackendBinary()`. Spawn with `child_process.spawn(binary, [], { env: buildEnv(...), cwd: userData, stdio: ['ignore', 'pipe', 'pipe'] })`. Pipe both stdout and stderr to `backend.log` via the log stream (see TASK-020). Wire `proc.on('exit', ...)` to call `onChildExit('backend', code)`. Store in `_backendProc`. | | |
| TASK-020 | In `electron/main.js`, implement `openLogStream(name)`: create `fs.createWriteStream(path.join(app.getPath('logs'), name + '.log'), { flags: 'a' })`. Return the stream. Use this in `spawnBackend()` and `spawnLlamaServer()` to pipe `proc.stdout.pipe(stream)` and `proc.stderr.pipe(stream)`. | | |
| TASK-021 | In `electron/main.js`, implement `spawnLlamaServer()`: if dev mode, log and return. Resolve binary via `resolveLlamaBinary()`. Resolve model via `resolveModelPath()`. If model is `null`, do not spawn — the first-run download flow (Phase 6) handles this before spawning. Spawn with `child_process.spawn(binary, ['--model', modelPath, '--alias', LLAMA_ALIAS, '--port', String(LLAMA_PORT), '--host', '127.0.0.1', '--n-gpu-layers', _hwProfile.recommended_llama_layers, '--ctx-size', '4096'], { stdio: ['ignore', 'pipe', 'pipe'] })`. | | |
| TASK-022 | In `electron/main.js`, implement `pollUntilReady(urls, timeoutMs)`: returns a `Promise<void>`. Every `POLL_INTERVAL_MS`, use `net.request` to HEAD each URL. Resolve when all respond with status 200. Reject with timeout error after `timeoutMs`. On each poll tick, call `_splashWin?.webContents.send('splash-status', 'Connecting to services…')`. | | |
| TASK-023 | In `electron/main.js`, implement `onChildExit(name, code)`: if `_shuttingDown` is `true`, do nothing. Otherwise show `dialog.showErrorBox('S.T.A.R.L.I.N.G. — process crashed', \`${name} exited with code ${code}. Check logs at ${app.getPath('logs')}.\`)`. Call `app.quit()`. | | |
| TASK-024 | In `electron/main.js`, implement `bootstrap()`: (1) call `loadHardwareProfile()`; (2) call `createSplashWindow()`; (3) if model is missing, call `runFirstRunDownload()` (Phase 6), await completion; (4) call `spawnLlamaServer()`; (5) call `spawnBackend()`; (6) call `await pollUntilReady([BACKEND_HEALTH_URL, LLAMA_HEALTH_URL], POLL_TIMEOUT_MS)`; (7) close splash, call `createMainWindow()`, call `createTray(getIconPath())`; (8) if `app.isPackaged`, call `autoUpdater.checkForUpdatesAndNotify()`. On polling timeout/error, show `dialog.showErrorBox(...)` and `app.quit()`. | | |

---

### Implementation Phase 4 — splash.html and tray icon assets

- GOAL-004: Create the splash screen HTML and the tray icon image assets required by `electron/main.js` before the build step can succeed.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-025 | Create `electron/splash.html`. Requirements: no external URLs, all CSS inline or in a `<style>` block. Background: `#000000`. Centred content: S.T.A.R.L.I.N.G. title in white `font-size: 20px` bold, subtitle `"LOCAL AI ASSISTANT"` in `#888` `font-size: 11px` letter-spaced, a pulsing dot (`animation: pulse 1.2s ease-in-out infinite`) as a loading indicator, and a `<p id="status" style="color:#888;font-size:11px;margin-top:16px">Starting…</p>`. Add `ipcRenderer.on('splash-status', (_, msg) => { document.getElementById('status').textContent = msg; })` in an inline script. Import `ipcRenderer` from `require('electron')` — this script runs in the splash window's renderer which has access to Node via a dedicated preload if needed; alternatively use a dedicated `splash-preload.js`. | | |
| TASK-026 | Create `assets/images/tray-icon-16.png` and `assets/images/tray-icon-32.png`: 16×16 and 32×32 pixel PNG icons using the S.T.A.R.L.I.N.G. brand colours (black background, white/teal star glyph). For the initial build, a placeholder solid-colour PNG is acceptable; replace with final artwork before the first public release. | | |
| TASK-027 | Create `assets/images/tray-icon.icns`: macOS icon set file. For the initial build, generate from the 32×32 PNG using `iconutil` (macOS) or `png2icns`. For cross-platform builds on Windows/Linux CI, a placeholder `.icns` file is acceptable — electron-builder accepts `.png` as a fallback for macOS tray icons. | | |
| TASK-028 | Create `assets/images/icon.icns` (macOS app icon, 512×512 base), `assets/images/icon.ico` (Windows app icon, multi-size ICO), and `assets/images/icon.png` (Linux app icon, 512×512 PNG). These are the installer icons referenced in the electron-builder `build` config. Placeholder images are acceptable for initial packaging; replace with final artwork before release. | | |

---

### Implementation Phase 5 — PyInstaller backend freeze

- GOAL-005: Create a PyInstaller spec file and `make build-backend` Makefile target that freezes the FastAPI backend into a self-contained directory bundle (`dist/backend/main/`) containing all Python modules, native extensions, ONNX models, and the entire `frontend/` static asset tree.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-029 | Create `scripts/build_backend.spec`. Set `pathex = ['backend']`. Set `name = 'main'`. Set `onefile = False`. Set `console = True` (so log output is visible in log files). `hiddenimports` list: `['faster_whisper', 'kokoro_onnx', 'onnxruntime', 'onnxruntime.capi', 'uvicorn', 'uvicorn.logging', 'uvicorn.protocols', 'uvicorn.protocols.http', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.http.h11_impl', 'uvicorn.protocols.websockets', 'uvicorn.lifespan', 'uvicorn.lifespan.on', 'fastapi', 'anyio', 'anyio._backends._asyncio', 'starlette', 'multipart', 'chromadb', 'fastembed', 'rank_bm25', 'feedparser', 'yfinance', 'geopy', 'sentence_transformers', 'einops', 'soundfile', 'httpx', 'pydantic', 'dotenv']`. | | |
| TASK-030 | In `scripts/build_backend.spec`, populate `datas` list with: `('backend/*.py', '.')` (all backend modules), `('../frontend', 'frontend')` (complete frontend tree so FastAPI's `StaticFiles` mount works), `('../models/kokoro-v1.0.onnx', 'models')`, `('../models/voices-v1.0.bin', 'models')`, `('../assets/images/manifest.json', 'assets/images')`. Add a comment noting that GGUF model files are NOT included in `datas` — they are resolved at runtime from `resourcesPath` or `userData`. | | |
| TASK-031 | In `scripts/build_backend.spec`, add a platform-conditional `binaries` list. On Windows (`sys.platform == 'win32'`): collect CUDA DLL paths from `nvidia-*` pip packages using `site.getsitepackages()` scanning for `nvidia/*/bin/*.dll` and add each as `(dll_path, 'nvidia_dlls')`. On macOS: add CoreML framework paths if present. On Linux: no extra binaries required (CUDA libraries are expected to be on the system `LD_LIBRARY_PATH`). | | |
| TASK-032 | In `scripts/build_backend.spec`, add a `runtime_hooks` entry: `['scripts/pyinstaller_hook_onnx.py']`. Create `scripts/pyinstaller_hook_onnx.py`: this hook sets `os.environ['ORT_DYLIB_PATH']` to the `onnxruntime/capi/` directory inside the frozen bundle so onnxruntime can find its shared library at startup. | | |
| TASK-033 | In `scripts/build_backend.spec`, the `Analysis` `script` argument must be `'backend/main.py'` resolved as an absolute path: `str(Path('backend/main.py').resolve())`. The `distpath` must be `'dist/backend'`. The `workpath` must be `'build/backend'`. | | |
| TASK-034 | Add `make build-backend` Makefile target: `$(PYTHON) -m PyInstaller scripts/build_backend.spec --distpath dist/backend --workpath build/backend --noconfirm`. Add `pyinstaller>=6.0.0` to `requirements-nvidia.txt`, `requirements-mac.txt`, `requirements-cpu.txt`, and `requirements-amd-linux.txt` (it is a dev tool, but must be in the venv for the Makefile target to work). | | |
| TASK-035 | Update `backend/main.py` to handle PyInstaller's frozen execution context: wrap the `StaticFiles` mount and `FileResponse` root route in a path resolution block that checks for `sys._MEIPASS` (PyInstaller freeze marker) and resolves `_FRONTEND` and `_ASSETS` relative to `sys._MEIPASS` when frozen, falling back to the current `Path(__file__).parent.parent` logic when running unfrozen. | | |
| TASK-036 | Update `backend/tts.py` to handle frozen model paths: `_MODEL_DIR` must check for `sys._MEIPASS` and, if frozen, resolve `models/` relative to `sys._MEIPASS`. When running normally (dev mode), keep the existing `Path(__file__).parent.parent / "models"` path. | | |

---

### Implementation Phase 6 — First-run model download modal

- GOAL-006: Implement the first-run GGUF model download flow in `electron/main.js` that shows a native dialog, streams the download with progress, and writes the model to `app.getPath('userData')/models/` before the backend is spawned.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-037 | In `electron/main.js`, define constants: `MODEL_FILENAME = 'Llama-3.2-3B-Instruct-Q4_K_M.gguf'`, `MODEL_URL = 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf'`, `MODEL_SIZE_GB = 2.0`. | | |
| TASK-038 | In `electron/main.js`, implement `runFirstRunDownload()`: returns a `Promise<void>`. Create a secondary `BrowserWindow` (500×320, modal, no frame) loading `electron/download.html`. Send the model name and size to the renderer via `win.webContents.send('download-start', { name: MODEL_FILENAME, sizeGb: MODEL_SIZE_GB })`. Use `net.request` to stream the model file to `path.join(app.getPath('userData'), 'models', MODEL_FILENAME)`, sending progress events to the download window via `win.webContents.send('download-progress', pct)`. On completion, send `download-complete` and close the window. | | |
| TASK-039 | Create `electron/download.html`: self-contained HTML (no external URLs) showing the model filename, a progress bar (`<progress id="bar">`), a percentage label, and a status line. Wire `ipcRenderer.on('download-start', ...)`, `ipcRenderer.on('download-progress', ...)`, `ipcRenderer.on('download-complete', ...)` handlers to update the UI. All styles inline. | | |
| TASK-040 | Create `electron/download-preload.js`: expose `ipcRenderer.on` wrapped calls via `contextBridge` for the `download-start`, `download-progress`, and `download-complete` channels. The download window `BrowserWindow` must use this preload file in `webPreferences`. | | |

---

### Implementation Phase 7 — IPC handlers and preload bridge

- GOAL-007: Register all `ipcMain` handlers in `electron/main.js` that correspond to the `contextBridge` API exposed in `electron/preload.js`, keeping all Node/Electron API access server-side.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-041 | In `electron/main.js`, register `ipcMain.handle('get-app-version', () => app.getVersion())`. | | |
| TASK-042 | In `electron/main.js`, register `ipcMain.handle('open-logs-folder', () => { shell.openPath(app.getPath('logs')); })`. | | |
| TASK-043 | In `electron/main.js`, register `ipcMain.handle('open-userdata-folder', () => { shell.openPath(app.getPath('userData')); })`. | | |
| TASK-044 | In `electron/main.js`, register `ipcMain.handle('restart-backend', () => restartBackend())`. This allows the frontend settings panel to trigger a backend restart via `window.starling.restartBackend()` in a future UI pass. | | |
| TASK-045 | Update `electron/preload.js`: add `restartBackend: () => ipcRenderer.invoke('restart-backend')` to the `contextBridge` exposure. Verify all exposed methods are non-destructive and that no file system access is exposed directly to the renderer. | | |

---

### Implementation Phase 8 — electron-builder configuration and packaging

- GOAL-008: Configure the `build` section of `package.json` with all electron-builder settings for Windows NSIS, macOS DMG, and Linux AppImage, and wire `make dist` to execute the full build chain: backend freeze → binary staging → electron-builder packaging.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-046 | Add `build` section to root `package.json`. Top-level fields: `"appId": "com.starling.local"`, `"productName": "S.T.A.R.L.I.N.G."`, `"copyright": "Copyright © 2026 Daniel Simpson"`, `"artifactName": "STARLING-${version}-${os}-${arch}.${ext}"`. | | |
| TASK-047 | In `package.json` `build`, add `"extraResources"`: `[{ "from": "dist/backend/main", "to": "backend_dist/main", "filter": ["**/*"] }, { "from": "tools/llama", "to": "llama", "filter": ["llama-server*"] }, { "from": "models", "to": "models", "filter": ["*.onnx", "*.bin"] }]`. The GGUF model is intentionally excluded from `extraResources` (handled by first-run download); add a comment documenting this. | | |
| TASK-048 | In `package.json` `build`, add `"files"`: `["electron/**/*", "assets/images/icon*", "assets/images/tray-icon*", "!node_modules", "!.venv", "!backend", "!frontend", "!scripts", "!models/*.gguf"]`. | | |
| TASK-049 | In `package.json` `build`, add `"win"` target: `{ "target": [{ "target": "nsis", "arch": ["x64"] }], "icon": "assets/images/icon.ico" }`. Add `"nsis"` config: `{ "oneClick": false, "allowDirChange": true, "createDesktopShortcut": true, "createStartMenuShortcut": true, "shortcutName": "S.T.A.R.L.I.N.G." }`. | | |
| TASK-050 | In `package.json` `build`, add `"mac"` target: `{ "target": [{ "target": "dmg", "arch": ["arm64", "x64"] }], "icon": "assets/images/icon.icns", "category": "public.app-category.utilities" }`. Add `"dmg"` config: `{ "title": "S.T.A.R.L.I.N.G. ${version}", "window": { "width": 540, "height": 380 } }`. | | |
| TASK-051 | In `package.json` `build`, add `"linux"` target: `{ "target": [{ "target": "AppImage", "arch": ["x64"] }], "icon": "assets/images/icon.png", "category": "Utility" }`. | | |
| TASK-052 | In `package.json` `build`, add `"publish"` config: `[{ "provider": "github", "owner": "danielbsimpson", "repo": "llm-speech-UI" }]`. This is used by `electron-updater` for the auto-update feed. | | |
| TASK-053 | In `Makefile`, add `bundle-llama-server` target: on Windows, copy `tools\llama\llama-server.exe` to `resources/llama/`; on Linux/macOS, copy `tools/llama/llama-server` to `resources/llama/` and `chmod +x resources/llama/llama-server`. Add `resources/llama/` directory creation. | | |
| TASK-054 | In `Makefile`, add `dist` target that runs the full chain in order: `make build-backend`, `make bundle-llama-server`, `npx electron-builder --$(PLATFORM_FLAG)`. Define `PLATFORM_FLAG` as `win --x64` on Windows, `mac` on Darwin, `linux` on Linux. Document in `make help` output. | | |
| TASK-055 | In `Makefile`, add `electron-dev` target: `ELECTRON_DEV=true npx electron .` (or the Windows equivalent). Document in `make help` that the backend must be started separately with `make backend` first. | | |

---

### Implementation Phase 9 — Auto-update via electron-updater

- GOAL-009: Implement silent auto-update checking on startup using `electron-updater`, presenting available updates as a dismissible notification rather than forcing an immediate download.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-056 | In `electron/main.js`, `require` the `autoUpdater` from `'electron-updater'` (not `'electron'` — electron-builder's updater is a separate package). Set `autoUpdater.logger = log` (where `log` is a file logger writing to `app.getPath('logs')/updater.log`). Set `autoUpdater.autoDownload = false` so updates are not downloaded without user consent. | | |
| TASK-057 | In `electron/main.js`, register `autoUpdater.on('update-available', (info) => { dialog.showMessageBox(_mainWin, { type: 'info', title: 'Update Available', message: \`S.T.A.R.L.I.N.G. v${info.version} is available.\`, buttons: ['Download and install', 'Later'] }).then(({ response }) => { if (response === 0) autoUpdater.downloadUpdate(); }); })`. | | |
| TASK-058 | In `electron/main.js`, register `autoUpdater.on('update-downloaded', () => { dialog.showMessageBox(_mainWin, { type: 'info', title: 'Update Ready', message: 'Restart now to apply the update.', buttons: ['Restart', 'Later'] }).then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(); }); })`. | | |
| TASK-059 | In `electron/main.js`, in the `bootstrap()` function, call `autoUpdater.checkForUpdatesAndNotify()` only when `app.isPackaged` is `true` (prevents update checks during development). Wrap in try/catch to avoid crashing if GitHub is unreachable. | | |

---

### Implementation Phase 10 — Shutdown and crash recovery

- GOAL-010: Implement clean shutdown of all child processes on quit, and crash recovery logic that restarts the backend once before giving up with an error dialog.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-060 | In `electron/main.js`, implement `terminate(proc, name, timeoutMs = 5000)`: call `proc.kill('SIGTERM')`. Wait up to `timeoutMs` for `proc.exitCode !== null`; if still running, call `proc.kill('SIGKILL')`. Log both actions to the log file. | | |
| TASK-061 | In `electron/main.js`, implement `shutdown()`: set `_shuttingDown = true`. Call `terminate(_backendProc, 'backend')` and `terminate(_llamaProc, 'llama-server')` in parallel using `Promise.allSettled([...])`. | | |
| TASK-062 | In `electron/main.js`, implement crash recovery for the backend: in `onChildExit('backend', code)`, if `_backendRestartCount < 1`, increment the counter, log a warning, and call `setTimeout(() => spawnBackend(), 2000)`. On the second crash, show `dialog.showErrorBox(...)` and `app.quit()`. For llama-server, no restart — show the error dialog immediately (llama-server crashes are typically unrecoverable without user action). | | |
| TASK-063 | Wire `app.on('before-quit', (event) => { event.preventDefault(); shutdown().then(() => app.exit(0)); })`. This ensures child processes are always cleaned up even when the user closes the window on macOS (which does not quit the app by default). | | |

---

### Implementation Phase 11 — Makefile `make help`, `.gitignore`, and `README.md` updates

- GOAL-011: Ensure all new Makefile targets are documented, all build artefacts are gitignored, and the README has an Electron/installer quickstart section.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-064 | Update `Makefile` `help` target: add entries for `electron-dev`, `build-backend`, `bundle-llama-server`, and `dist` with one-line descriptions. | | |
| TASK-065 | Update `.gitignore`: add `dist/backend/`, `build/backend/`, `resources/backend_dist/`, `resources/llama/`, `resources/models/`, `dist/electron/`, `*.AppImage`, `*.dmg`, `*.exe` (installer output only — add a comment so `start.bat` / `stop.bat` are not accidentally excluded; use `dist/*.exe` not `*.exe`). | | |
| TASK-066 | In `README.md`, add a **Desktop App** section after the Quickstart. Explain: (1) install via the platform installer (link to GitHub Releases), (2) first-run model download (~2 GB, one-time), (3) the app auto-starts both the LLM and backend. For developers: `make electron-dev` for a dev window; `make dist` for a packaged build. | | |

---

## 3. Alternatives

- **ALT-001**: **Tauri (Rust + WebView)** instead of Electron — evaluated; rejected because Tauri cannot spawn and supervise a Python subprocess that also serves the frontend. Tauri's `sidecar` feature is for single binaries; the three-process architecture (Electron + backend + llama-server) maps cleanly onto Electron's `child_process` model. Tauri also produces smaller bundles but the savings are irrelevant relative to the multi-GB model files.
- **ALT-002**: **NW.js** instead of Electron — older ecosystem, less active maintenance, no `electron-updater` equivalent. Rejected.
- **ALT-003**: **PyInstaller `onefile=True`** — produces a single `.exe` / binary but unpacks to a temp directory on every launch (3–10 s overhead). Rejected in favour of `onefile=False` folder bundle which starts instantly once Electron has resolved paths.
- **ALT-004**: **Bundle the GGUF model file inside the installer** — produces a 4+ GB installer that most users would refuse to download, and saturates GitHub Releases storage. Rejected; first-run download is the correct UX for large models. A future iteration could support user-provided model selection from a file picker.
- **ALT-005**: **Use Electron's built-in `protocol.handle('app://', ...)` to serve the frontend** instead of the FastAPI `StaticFiles` mount — would remove the need to include `frontend/` in the PyInstaller bundle. Rejected because it would require significant changes to the frontend's `BACKEND_BASE` URL logic and the existing server-side asset pipeline. The current approach (FastAPI serves frontend, Electron loads `http://localhost:8000`) requires zero frontend changes.
- **ALT-006**: **Nx or Vite monorepo build** to replace the Makefile — adds significant tooling complexity with no benefit for a project that already has a working Makefile. Rejected.
- **ALT-007**: **ASAR packing of the Electron app files** — electron-builder enables this by default for `files`. Keep the default; no action needed. The PyInstaller bundle in `extraResources` is explicitly excluded from ASAR (electron-builder automatically excludes `extraResources` from the ASAR).

---

## 4. Dependencies

- **DEP-001**: `electron@^30.0.0` — Chromium-based desktop shell; dev dependency.
- **DEP-002**: `electron-builder@^24.0.0` — cross-platform packager for NSIS/DMG/AppImage; dev dependency.
- **DEP-003**: `electron-updater@^6.0.0` — auto-update client for GitHub Releases; runtime dependency (bundled in the Electron app).
- **DEP-004**: `pyinstaller>=6.0.0` — Python backend freezer; installed into the Python venv; used only at build time, not at runtime.
- **DEP-005**: `Node.js 20+ LTS` — required at build time for `npm install` and `npx electron-builder`. Not required on end-user machines.
- **DEP-006**: Platform-specific installer prerequisites: NSIS 3.x (Windows, bundled by electron-builder); `Xcode Command Line Tools` (macOS, for code signing); no extra prerequisites on Linux.
- **DEP-007**: `plan/feature-cross-platform-auto-detect-1.md` — hardware detection pipeline (`detect_hardware.py`, `backend/hardware.py`) must be implemented before `electron/main.js` can call `loadHardwareProfile()`. This plan depends on that plan being complete.
- **DEP-008**: `plan/feature-mac-m4-compatibility-1.md` — macOS-specific requirements overlay and `stt.py` / `tts.py` provider selection must be in place for the macOS packaged build to function.

---

## 5. Files

- **FILE-001**: `package.json` — new (root); Electron project manifest + electron-builder `build` config
- **FILE-002**: `package-lock.json` — generated by `npm install`; gitignored
- **FILE-003**: `electron/main.js` — new; Electron main process (process supervisor, window manager, tray, IPC)
- **FILE-004**: `electron/preload.js` — new; contextBridge exposure for main window
- **FILE-005**: `electron/download-preload.js` — new; contextBridge for download modal window
- **FILE-006**: `electron/constants.js` — new; shared constants (ports, URLs, timeouts)
- **FILE-007**: `electron/splash.html` — new; splash screen HTML (self-contained)
- **FILE-008**: `electron/download.html` — new; first-run model download modal HTML
- **FILE-009**: `scripts/build_backend.spec` — new; PyInstaller spec for backend freeze
- **FILE-010**: `scripts/pyinstaller_hook_onnx.py` — new; PyInstaller runtime hook for onnxruntime DLL path
- **FILE-011**: `backend/main.py` — updated; frozen-path-aware `_FRONTEND`/`_ASSETS` resolution via `sys._MEIPASS`
- **FILE-012**: `backend/tts.py` — updated; frozen-path-aware `_MODEL_DIR` resolution via `sys._MEIPASS`
- **FILE-013**: `assets/images/tray-icon-16.png` — new; 16×16 tray icon
- **FILE-014**: `assets/images/tray-icon-32.png` — new; 32×32 tray icon
- **FILE-015**: `assets/images/tray-icon.icns` — new; macOS tray icon
- **FILE-016**: `assets/images/icon.ico` — new; Windows app/installer icon
- **FILE-017**: `assets/images/icon.icns` — new; macOS app icon
- **FILE-018**: `assets/images/icon.png` — new; Linux app icon (512×512)
- **FILE-019**: `Makefile` — updated; `electron-dev`, `build-backend`, `bundle-llama-server`, `dist` targets
- **FILE-020**: `.gitignore` — updated; build artefact paths
- **FILE-021**: `README.md` — updated; Desktop App section

---

## 6. Testing

- **TEST-001**: On Windows, run `make build-backend`. Verify `dist/backend/main/main.exe` exists, is executable, and `dist/backend/main/frontend/index.html` is present (confirming the static asset bundle succeeded).
- **TEST-002**: On Windows, run the frozen backend binary directly: `dist\backend\main\main.exe`. Verify `GET http://localhost:8000/health` returns 200 and `GET http://localhost:8000` returns the frontend HTML — with no Python venv active.
- **TEST-003**: On macOS, run `make build-backend`. Verify `dist/backend/main/main` exists and is executable, and that `onnxruntime`'s dylib is co-located in the bundle.
- **TEST-004**: On Windows, run `npx electron .` (dev mode, backend running via `make backend`). Verify the app window opens at `http://localhost:8000` and the S.T.A.R.L.I.N.G. UI loads without console errors.
- **TEST-005**: On Windows, run `make dist`. Verify `dist/electron/STARLING-1.0.0-win-x64.exe` is produced. Install it on a clean Windows 10/11 VM with no Python or Node installed. Verify the app launches, the first-run model download completes, and the full voice pipeline works.
- **TEST-006**: On macOS arm64, run `make dist`. Verify `dist/electron/STARLING-1.0.0-mac-arm64.dmg` is produced. Mount the DMG on a clean macOS 13+ machine. Verify drag-to-Applications, launch, splash screen, and full pipeline work.
- **TEST-007**: On Linux (Ubuntu 22.04), run `make dist`. Verify `dist/electron/STARLING-1.0.0-linux-x64.AppImage` is produced. Mark executable (`chmod +x`) and run on a clean machine. Verify launch and pipeline.
- **TEST-008**: With `memory_warning=true` in the hardware profile, verify the `#hw-warning-banner` appears in the packaged app (not just dev mode).
- **TEST-009**: Kill the backend process while the Electron app is running. Verify `onChildExit` fires, a recovery restart attempt is made once, and on the second crash the error dialog appears with the correct log path.
- **TEST-010**: Close the main window on macOS (which hides but does not quit the app). Verify the tray icon is still visible and the "Open S.T.A.R.L.I.N.G." menu item re-shows the window.
- **TEST-011**: Click "Quit" from the tray context menu. Verify both child processes (backend, llama-server) are terminated (not orphaned) within 5 seconds.
- **TEST-012**: On a machine with no internet connection, launch the packaged app (model already present). Verify the auto-update check fails silently (no crash, no error dialog) and the app continues to operate normally.
- **TEST-013**: Simulate a model file not present at `userData/models/`. Verify the download modal appears, displays the correct filename and size, and after downloading the app proceeds to spawn backend and llama-server.
- **TEST-014**: Verify `nativeContextMenu` and DevTools are not accessible in the packaged build (`app.isPackaged == true`). Run `electron-builder` with `--publish=never` and confirm `devTools: false` is enforced in the packaged BrowserWindow.

---

## 7. Risks & Assumptions

- **RISK-001**: PyInstaller may fail to collect all dynamic imports from `chromadb` or `fastembed` (both use plugin-style dynamic loading). Mitigation: add explicit `hiddenimports` for each submodule discovered during a test build; use `--collect-all chromadb` and `--collect-all fastembed` flags in the spec if necessary.
- **RISK-002**: NVIDIA CUDA DLLs (`cublas64_12.dll`, `cudart64_12.dll`) must be discoverable at runtime inside the frozen bundle. The existing `stt.py` DLL registration logic (`os.add_dll_directory`) runs at module import time; PyInstaller bundles the DLLs next to the executable but does not register them in the DLL search path automatically. Mitigation: the `pyinstaller_hook_onnx.py` runtime hook must also call `os.add_dll_directory` for the `nvidia_dlls/` subdirectory inside `sys._MEIPASS`.
- **RISK-003**: macOS code signing and notarization are required for Gatekeeper to allow the app without a user bypass on macOS 13+. Without a paid Apple Developer account, only the right-click → Open workaround is available. Mitigation: document this clearly in the README; do not block the release on notarization for the initial version.
- **RISK-004**: The PyInstaller frozen bundle size for this project will be large (estimated 3–5 GB including ONNX models, CUDA DLLs, and ChromaDB). The AppImage on Linux may exceed 4 GB, hitting the FAT32 file system limit if the user's download partition is FAT32 formatted. Mitigation: document minimum disk space requirement (10 GB free) in README.
- **RISK-005**: electron-updater requires a valid code signature on Windows for auto-update to function; unsigned builds will prompt Windows SmartScreen warnings on install. Mitigation: for the initial release, document the SmartScreen bypass ("More info → Run anyway"). A future iteration can add a code-signing certificate.
- **RISK-006**: `pollUntilReady` uses Electron's `net.request` which is not available until `app.whenReady()` resolves. If `net.request` is called too early, it throws. Mitigation: all polling calls are inside `bootstrap()` which is only called from the `app.whenReady()` callback.
- **RISK-007**: The `frontend/` directory is included in the PyInstaller bundle via `datas`; if `frontend/` files reference relative asset paths that resolve differently when served from the frozen bundle, there may be 404s. Mitigation: all asset references in `frontend/` already use root-relative paths (`/assets/...`, `/frontend/...`) since FastAPI serves them from the repo root — no changes needed.
- **ASSUMPTION-001**: `Node.js 20+ LTS` is available on the developer's build machine. It is not required on end-user machines.
- **ASSUMPTION-002**: The `dist/backend/main/` directory is produced by `make build-backend` before `make dist` is called. The `dist` Makefile target enforces this order.
- **ASSUMPTION-003**: The llama-server binary in `tools/llama/` has already been downloaded (by `scripts/download_llama_server.py` from `plan/feature-cross-platform-auto-detect-1.md`) before `make bundle-llama-server` is called. The `dist` target must document this prerequisite.
- **ASSUMPTION-004**: The Kokoro model files (`models/kokoro-v1.0.onnx`, `models/voices-v1.0.bin`) are present before `make build-backend` is called. They are included in the PyInstaller `datas` via the spec file.
- **ASSUMPTION-005**: `app.getPath('userData')` is writable on all platforms without elevated privileges. This is guaranteed by the OS for all platforms Electron supports.

---

## 8. Related Specifications / Further Reading

- [plan/feature-mac-m4-compatibility-1.md](feature-mac-m4-compatibility-1.md) — Phase 1 cross-platform work; macOS backend changes are a prerequisite
- [plan/feature-cross-platform-auto-detect-1.md](feature-cross-platform-auto-detect-1.md) — hardware detection pipeline; `loadHardwareProfile()` in `electron/main.js` depends on this plan
- [Electron documentation — app.getPath](https://www.electronjs.org/docs/latest/api/app#appgetpathname)
- [Electron documentation — child_process in main process](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [PyInstaller spec file documentation](https://pyinstaller.org/en/stable/spec-files.html)
- [electron-builder extraResources](https://www.electron.build/configuration/configuration#extraresources)
- [electron-updater — GitHub provider](https://www.electron.build/auto-update#github-provider)
- [llama.cpp GitHub Releases — platform binaries](https://github.com/ggml-org/llama.cpp/releases/latest)
- [HuggingFace bartowski/Llama-3.2-3B-Instruct-GGUF](https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF)
