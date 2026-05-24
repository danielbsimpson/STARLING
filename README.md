# S.T.A.R.L.I.N.G. — Speech‑Triggered Autonomous Reasoning & Local Intelligence Node Generator

A voice-driven AI interface powered entirely by a local LLM running on your GPU. No cloud APIs. No subscriptions. No Ollama wrapper. Just your hardware.

```
Microphone → Speech-to-Text → llama-server (LLM on GPU) → Text-to-Speech → Browser UI
```

![S.T.A.R.L.I.N.G. UI](assets/images/Starling_UI_example.png)

---

## Features

- 🎙 **Voice input** via browser MediaRecorder API → local faster-whisper (Whisper)
- 🧠 **Local LLM inference** directly via llama-server (llama.cpp) — no Ollama wrapper; Ollama kept as a switchable fallback
- ⚡ **Sub-3-second end-to-end latency** — typical voice → LLM → first TTS audio in under 3 s; all three pipelines (Whisper, Kokoro, llama-server) run on GPU
- 🔊 **Text-to-speech** via Kokoro TTS (local, GPU-accelerated) or browser SpeechSynthesis
- 📡 **Sentence-chunked streaming** — each sentence is synthesised and played as it arrives
- 💬 **Multi-turn conversation** with persistent context
- 🌑 **Living black sphere** — Three.js scene with 7 orbiting light orbs; reacts to audio input and shifts colour/speed per state (idle / listening / thinking / speaking)
- ⚡ **Model warm-up on load** — Kokoro and Whisper CUDA sessions are pre-heated at startup; UI shows `INITIALISING…` and GPU badges populate before the user speaks
- 📊 **LLM metrics bar** — live prompt tokens, generation speed (t/s), total time, and context window fill percentage after every response
- 🔒 **Fully local** — no data leaves your machine
- 🗄️ **RAG memory system** — ChromaDB + BM25/vector fusion retrieval; drop `.md` or `.txt` files into `memory/input/` and run `make rag-ingest` to index them
- 🖼️ **Dynamic dossier / presentation mode** — say `"pull up the dossier on [name]"` to trigger a full UI reconfiguration with image panel, structured subject profile, and automatic LLM spoken briefing
- 🕒 **Time & date queries** — instant voice responses ("what time is it?", "what day is it?") with a live clock panel; zero backend, sub-200 ms
- ⏱️ **Voice-activated timers** — set, cancel, and list multiple named timers entirely in-browser; Web Audio API chime on completion
- 🌤️ **Weather panel** — 7-day forecast from Open-Meteo (free, no API key); named-location queries via Nominatim geocoding; disk-cached with 1-hour TTL; LLM spoken summary
- 📰 **News briefing panel** — RSS headlines with background LLM synthesis; category filtering (tech, sports, world, finance, etc.)
- 📈 **Stocks & crypto panel** — live market data via Yahoo Finance; equities, crypto, and indices; filter tabs; OPEN/CLOSED market badge; LLM spoken briefing
- 🌐 **In-UI browser panel** — say `"look up [topic] on Wikipedia"`, `"open browser [url]"`, or `"browser search for [query]"` to open an embedded iframe; page text is extracted server-side and injected as LLM context for on-page Q&A and summarisation; JS-rendered SPAs are detected and reported; Wikipedia sections can be summarised on demand with `"summarize section [name]"`
- 💡 **Ideas vault** — say `"store idea in the vault"` to enter single-press capture mode; ideas are LLM-tagged and saved locally; retrieve with `"open ideas vault"`, search with `"search the vault for [topic]"`, or discard the last with `"discard the last idea from the vault"`
- 📓 **Voice journal** — say `"start journal entry"` to begin multi-segment dictation or `"interviewer mode"` for a guided Q&A session; on submit the LLM silently generates a summary and tags; confirm or re-record before saving; read back entries and search by keyword or date
- 📺 **YouTube feed panel** — say `"open YouTube feed"` to open a tile-grid panel of recent videos from configured channels via public RSS; filter by video type (All / Long / Shorts) and channel; in-panel modal for immediate playback; LLM spoken briefing; no API key required
- 🟠 **Reddit social feed panel** — say `"open Reddit social"` to open a post feed from configured subreddits via the public JSON API; per-subreddit filter tabs; LLM spoken briefing; no login required
- 🧰 **Toolkit menu** — say `"show tools"` or `"open toolkit"` to browse every active Starling tool by name and description; click any tool for a spoken LLM briefing, then confirm by voice or click to activate it directly

> Tool panel screenshots and full trigger phrase reference: [`toolkit/README.md`](./toolkit/README.md)

---

## Voice Tool Kit

A suite of voice-activated tools built as self-contained dispatch intercepts — none modify
the core chat pipeline.

| # | Tool | Backend | Status |
|---|---|---|---|---|
| 1 | Time & Date | None | ✅ Done |
| 2 | Timers | None | ✅ Done |
| 3 | Weather | Open-Meteo (free, no key) | ✅ Done |
| 4 | News Briefing | RSS / feedparser (free) | ✅ Done |
| 5 | Stocks & Crypto | yfinance (unofficial) | ✅ Done |
| 6 | Wake Word & Interrupt | None | 🔲 Planned |
| 7 | In-UI Browser Panel | None | ✅ Done |
| 8 | Ideas Tracker | Local JSON file | ✅ Done |
| 9 | Voice Journal | Local JSON files | ✅ Done |
| 10 | Wikipedia RAG | ChromaDB + fastembed | ✅ Done |
| 11 | Reddit Social Feed | Reddit JSON API (no auth) | ✅ Done |
| 12 | YouTube Feed | YouTube Atom RSS (no key) | ✅ Done |
| 13 | Toolkit Menu | None (frontend only) | ✅ Done |
| 14 | Google Calendar | Google Calendar API (OAuth2) | 🔲 Planned |
| 15 | Gmail | Gmail API (OAuth2) | 🔲 Planned |

See [`toolkit/README.md`](./toolkit/README.md) for screenshots, trigger phrase reference,
and per-tool documentation. Implementation plans for upcoming features are in [`plan/`](./plan/).

---

## Requirements

- **OS:** Linux, macOS, or Windows
- **GPU:** NVIDIA GPU with 6 GB+ VRAM (CUDA 12+), or DirectX 12-capable GPU (DirectML)
- **Python:** 3.11+
- **Node.js:** 18+ (only if using the React/Vite frontend)
- **Browser:** Chrome or Edge (required for MediaRecorder / Web Speech API fallback)

### Recommended GPU / model pairings

Model files are read directly from the GGUF format. The easiest source is your existing Ollama blob cache (`%USERPROFILE%\.ollama\models\blobs\`) — no re-download needed.

| GPU VRAM | Recommended model | GGUF quant |
|---|---|---|
| 4–6 GB | Gemma 3 4B, Phi-4 Mini, Llama 3.2 3B | Q4_K_M |
| 6–8 GB | Llama 3.1 8B, Mistral 7B, Qwen 2.5 7B | Q4_K_M |
| 10–16 GB | Llama 3.1 13B, Mistral 12B | Q4_K_M |
| 40 GB+ | Llama 3.1 70B | Q4_K_M |

### Currently installed models

| Model | Size | Notes |
|---|---|---|
| `llama3.1:8b` | 4.9 GB | Strong general purpose |
| `mistral:7b` | 4.4 GB | Fast, good instruction following |
| `qwen2.5:7b` | 4.7 GB | Strong coding and reasoning |
| `gemma3:4b` | 3.3 GB | Lightweight, good for low VRAM |
| `llama3.2:3b` | 2.0 GB | **Default** — fastest response times |
| `phi4-mini` | 2.5 GB | Microsoft, strong reasoning for its size |
| `nomic-embed-text` | 274 MB | Embedding model — no longer required; RAG uses fastembed in-process |

These are available as Ollama blobs at `%USERPROFILE%\.ollama\models\blobs\`. Point `start_llama_server.bat` at the relevant blob path or copy and rename to a `models/` directory.

---

## Project Structure

```
llm-speech-UI/
├── frontend/               # UI — HTML/CSS/JS + Three.js
│   ├── index.html
│   ├── style.css
│   ├── config.js           # Shared config (BACKEND_BASE)
│   ├── app.js              # Main application logic and voice dispatch router
│   ├── browser-panel.js    # Tool: in-UI browser panel
│   ├── ideas-panel.js      # Tool: ideas vault
│   ├── interrupt-phrases.js  # Interrupt / barge-in phrase list
│   ├── journal-panel.js    # Tool: voice journal
│   ├── log-dashboard.html  # Session activity log dashboard
│   ├── news-panel.js       # Tool: news briefing panel
│   ├── reddit-panel.js     # Tool: Reddit social feed panel
│   ├── stocks-panel.js     # Tool: stocks & crypto panel
│   ├── timer-panel.js      # Tool: voice-activated timers
│   ├── toolkit-panel.js    # Tool: toolkit browsing & activation menu
│   ├── weather-panel.js    # Tool: weather forecast panel
│   ├── wiki-panel.js       # Tool: Wikipedia RAG Q&A
│   └── youtube-panel.js    # Tool: YouTube feed panel
├── backend/                # FastAPI server
│   ├── main.py             # App entry point, router registration, system-status
│   ├── stt.py              # Speech-to-text via faster-whisper
│   ├── tts.py              # Text-to-speech via Kokoro ONNX
│   ├── llama_server.py     # llama-server streaming relay (DEFAULT, LLM_BACKEND=llama)
│   ├── ollama.py           # Ollama streaming relay (fallback, LLM_BACKEND=ollama)
│   ├── rag.py              # RAG module — ingest, retrieve, format, status
│   ├── browser.py          # Browser page-text extraction endpoint
│   ├── ideas_routes.py     # Ideas vault endpoints
│   ├── journal_routes.py   # Voice journal endpoints
│   ├── log_routes.py       # Session activity log endpoints
│   ├── news.py             # News briefing endpoint (RSS / feedparser)
│   ├── reddit.py           # Reddit social feed endpoint (public JSON API)
│   ├── session_log.py      # Session event recording
│   ├── stocks.py           # Stocks & crypto market data endpoint (yfinance)
│   ├── weather.py          # Weather forecast endpoint (Open-Meteo)
│   ├── wikipedia_rag.py    # Wikipedia RAG — session, retrieval, prompt builder
│   ├── youtube.py          # YouTube feed endpoint (Atom RSS)
│   └── memory/             # Runtime data — caches, JSON stores, and ChromaDB
│       ├── chroma_db/      # Vector store (auto-created on first ingest)
│       ├── journal/        # Journal entry files (JSON, one per entry)
│       ├── ideas.json      # Ideas vault store
│       ├── watchlist.json  # Stocks watchlist
│       └── weather_cache.json  # Weather API response cache
├── assets/
│   ├── images/
│   │   └── manifest.json           # Subject → image / dossier mapping for presentation mode
│   ├── dossier_images/             # Subject portrait images
│   ├── dossier_descriptions/       # Structured subject profiles (.md files)
│   ├── wikipedia/                  # Cached Wikipedia article data
│   ├── ui_mockup.html              # UI design mockup reference
│   └── archived/                   # Completed and archived implementation guides (git-ignored)
│       └── complete/               # Guides for fully implemented features
├── plan/                   # Implementation plans for upcoming features
│   ├── CALENDAR.md                         # Tool: Google Calendar integration
│   ├── GMAIL.md                            # Tool: Gmail inbox & summarisation
│   ├── TOOL_AWARENESS.md                   # Fuzzy tool detection & recovery
│   ├── WAKE_WORD.md                        # Tool: wake word + interrupt
│   ├── feature-boot-shutdown-animation-1.md
│   ├── feature-cross-platform-auto-detect-1.md
│   ├── feature-dream-state-shutdown-pipeline-1.md
│   ├── feature-electron-packaging-1.md
│   ├── feature-mac-m4-compatibility-1.md
│   ├── feature-prompt-registry-1.md
│   ├── feature-rag-memory-manager-1.md
│   ├── feature-reddit-account-discovery-1.md
│   ├── feature-sleep-mode-1.md
│   ├── feature-starling-soul-personality-1.md
│   ├── feature-toolkit-menu-1.md           # ✅ Implemented
│   └── feature-youtube-channel-discovery-1.md
├── toolkit/                # Voice trigger reference and tool documentation
│   ├── README.md           # Per-tool screenshots, trigger phrases, and implementation notes
│   └── TRIGGER_PHRASES.md  # Full voice command reference with dispatch priority order
├── models/                 # Local model files (e.g., kokoro-v1.0.onnx)
├── scripts/
│   ├── setup.sh                # One-shot install script
│   ├── download_models.py      # Download Kokoro model files
│   ├── ingest_wikipedia.py     # Ingest Wikipedia articles into vector store
│   ├── launch.py               # Cross-platform process launcher
│   ├── start_llama_server.bat  # Launch llama-server on Windows (CUDA)
│   ├── stop.py                 # Stop all running processes
│   └── test_integration.py     # End-to-end integration test
├── start.bat               # Windows one-click launcher (llama-server + backend)
├── stop.bat                # Windows one-click shutdown
├── Makefile                # make up / down / backend / frontend / rag-ingest / lint
├── .env.example            # Environment variable template
├── requirements.txt        # Python dependencies
└── README.md
```

---

## Quickstart

### 1. Download llama-server and a model

```powershell
# Download llama-server (Windows CUDA 12) from:
# https://github.com/ggml-org/llama.cpp/releases/latest
# Extract to C:\llama.cpp\ and add to PATH

# Model files can be reused from your Ollama blob cache:
# %USERPROFILE%\.ollama\models\blobs\sha256-<hash>
# Point start_llama_server.bat at the relevant blob and run it.
```

### 2. Clone the repo

```bash
git clone https://github.com/danielbsimpson/llm-speech-UI.git
cd llm-speech-UI
```

### 3a. Frontend only (easiest — no Python needed)

Open `frontend/index.html` directly in Chrome. The UI talks to Ollama at `http://localhost:11434` via `fetch()`. Uses browser-native STT and TTS.

```bash
# Optional: use a local dev server for cleaner DX
npx live-server frontend/
```

### 3b. Full stack (Whisper STT + Kokoro TTS)

```bash
# Create a virtual environment
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt

# Download Kokoro model files (~330 MB)
python scripts/download_models.py

# Copy and configure environment variables
cp .env.example .env
# Edit .env — set LLM_BACKEND=llama and configure LLAMA_SERVER_URL / LLAMA_MODEL
```

**Start everything with one command:**

```bash
make up        # starts llama-server + FastAPI backend, streams combined output
```

```bat
start.bat      # Windows double-click alternative (same as make up)
```

To stop:

```bash
make down      # sends termination signals to both processes, removes PID file
```

```bat
stop.bat       # Windows double-click alternative (same as make down)
```

> `make up` reads config from `.env` (falling back to the same defaults as
> `start_llama_server.bat`). Press **Ctrl+C** in the terminal to stop both
> processes at once.

---

**Manual start (two terminals — for iterating on the backend):**

```bat
# Terminal 1 — LLM
.\scripts\start_llama_server.bat

# In a second terminal: start the FastAPI backend (must run from backend/ directory)
cd backend
uvicorn main:app --reload --port 8000

# Open the frontend
start http://localhost:8000
```

### Adding a Phase 11 tool

Each tool in the planned toolkit follows the same pattern. To add, say, Weather:

1. Install the required Python package: `pip install httpx`
2. Create `backend/weather.py` and register its router in `backend/main.py`
3. Create `frontend/weather-panel.js` and add the intercept block to `app.js`
4. Add the panel HTML and CSS to `index.html` / `style.css`

See [`markdown/complete/WEATHER.md`](./markdown/complete/WEATHER.md) for the full step-by-step guide.
Every other tool has its own equivalent guide in `markdown/`.

---

## Running the Project (Windows — PowerShell)

> These are the exact commands to get everything running from scratch each session.

### Prerequisites
- Virtual environment already created and dependencies installed (see **Quickstart → 3b** above)
- `llama-server.exe` path configured in `.env` or `scripts\start_llama_server.bat`

---

### One-command start (recommended)

```powershell
make up
# or: .\start.bat   (double-click in Explorer)
```

Both processes start in a single terminal. Combined output is streamed with
`[llama]` / `[backend]` prefixes. Press **Ctrl+C** to shut down cleanly.

To stop from a different terminal (or script):

```powershell
make down
# or: .\stop.bat
```

---

### Manual start (two terminals — useful when iterating on backend code)

#### Terminal 1 — LLM

```powershell
.\scripts\start_llama_server.bat
```

Wait until you see:

```
main: server is listening on http://127.0.0.1:8080
```

Leave this terminal running.

#### Terminal 2 — Backend

```powershell
make backend
# or manually:
.venv\Scripts\activate
cd backend
uvicorn main:app --reload --port 8000
```

Wait until you see:

```
Application startup complete.
```

Leave this terminal running.

---

### Step 2b — Activate RAG (optional, first time only)

If you have set `RAG_ENABLED=true` in `.env`, index your documents after the backend is running:

```powershell
make rag-ingest
# or: curl -X POST http://localhost:8000/rag/ingest
```

On first run, fastembed will download the embedding model (~33 MB) from HuggingFace and cache it locally. No Ollama or extra server required.

Verify indexing:

```powershell
make rag-status
```

You should see `chunk_count > 0`. Add `.md` or `.txt` files to `memory/input/` and re-run `rag-ingest` to expand the knowledge base.

---

### Step 3 — Open the UI

Open **Chrome** or **Edge** and navigate to:

```
http://localhost:8000
```

The UI will display `INITIALISING…` while Kokoro and Whisper warm up on the GPU. Once the GPU badges appear, you are ready to speak.

---

### Stopping the project

- Press `Ctrl + C` in Terminal 2 to stop the FastAPI backend.
- Press `Ctrl + C` in Terminal 1 to stop llama-server.

---

## Configuration

Copy `.env.example` to `.env` and edit as needed:

```env
# LLM backend selector
LLM_BACKEND=llama          # "llama" = llama-server (default) | "ollama" = Ollama fallback

# llama-server (LLM_BACKEND=llama)
LLAMA_SERVER_URL=http://localhost:8080
LLAMA_MODEL=llama3.2-3b    # must match --alias passed to llama-server
LLAMA_TEMPERATURE=0.7

# Ollama fallback (LLM_BACKEND=ollama)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_TEMPERATURE=0.7

# Backend
BACKEND_PORT=8000

# STT — faster-whisper
WHISPER_MODEL_SIZE=base   # tiny | base | small | medium | large-v3
WHISPER_DEVICE=cuda       # set to cpu if CUDA unavailable

# TTS — Kokoro ONNX
ONNX_PROVIDER=CUDAExecutionProvider   # or DmlExecutionProvider / CPUExecutionProvider

# RAG / memory system
RAG_ENABLED=false              # set to true to activate retrieval-augmented generation
RAG_INPUT_FOLDER=memory/input  # drop .md/.txt docs here for ingestion
RAG_CHROMA_PATH=memory/chroma_db
RAG_EMBED_MODEL=BAAI/bge-small-en-v1.5
RAG_CHUNK_SIZE=200
RAG_TOP_K=4
RAG_MAX_CONTEXT_TOKENS=400

# ── Phase 11 tools (add as each tool is implemented) ──────────────────────────
# Weather (Tool 3)
WEATHER_LOCATION=Framingham,Massachusetts
WEATHER_UNITS=fahrenheit

# Path to on-disk JSON cache file (relative to backend working dir)
WEATHER_CACHE_FILE=memory/weather_cache.json

# Max hourly snapshots retained per location (~1 week at hourly cadence)
WEATHER_HISTORY_MAX=168

# Panel label shown for the default home location
WEATHER_DEFAULT_LABEL=Framingham

# News (Tool 4)
NEWS_FEEDS=https://feeds.bbci.co.uk/news/rss.xml,https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml
NEWS_MAX_ITEMS=10
NEWS_CACHE_SECONDS=120

# Stocks (Tool 5)
STOCKS_WATCHLIST=NVDA,AAPL,MSFT,SPY,QQQ
CRYPTO_WATCHLIST=BTC-USD,ETH-USD
STOCKS_CACHE_SECONDS=300
STOCKS_CURRENCY_SYMBOL=$

# Ideas Tracker (Tool 8)
# IDEAS_FILE=memory/ideas.json
# IDEAS_MAX_RETURN=100

# Journal (Tool 9)
# JOURNAL_DIR=memory/journal
# JOURNAL_MAX_ENTRIES=500

# Gmail (Tool 12)
# GMAIL_CREDENTIALS_FILE=credentials/google_gmail_credentials.json
# GMAIL_TOKEN_FILE=credentials/google_gmail_token.json
# GMAIL_MAX_UNREAD=20
# GMAIL_CACHE_SECONDS=120

# Calendar (Tool 11)
# CALENDAR_BACKEND=google
# GOOGLE_CREDENTIALS_FILE=credentials/google_calendar_credentials.json
# GOOGLE_TOKEN_FILE=credentials/google_token.json
# CALENDAR_TIMEZONE=America/New_York
```

---

## STT Options

| Engine | Setup | Accuracy | Latency | Privacy |
|---|---|---|---|---|
| Web Speech API | Zero | Good | Fast | ⚠️ Sent to Google |
| faster-whisper | `pip install faster-whisper` | Excellent | Medium | ✅ Fully local |

To use Whisper, set `STT_ENGINE=whisper` in `.env` and ensure the FastAPI backend is running. The frontend will POST audio blobs to `/transcribe`.

---

## TTS Options

| Engine | Setup | Quality | Latency |
|---|---|---|---|
| SpeechSynthesis | Zero (browser built-in) | OK | Instant |
| Kokoro TTS | `pip install kokoro-onnx` | Excellent | Low |
| Piper TTS | Download binary + voice model | Good | Very low |

---

## API Reference (FastAPI backend)

| Endpoint | Method | Description |
|---|---|---|
| `/chat` | POST | Send a message, stream LLM response (NDJSON) |
| `/chat/context-limit` | GET | Return the model's `n_ctx` from llama-server `/props` |
| `/transcribe` | POST | Upload audio blob, returns transcript |
| `/synthesize` | POST | Send text, returns WAV audio |
| `/synthesize/voices` | GET | List available Kokoro voices |
| `/health` | GET | Check backend status |
| `/system-status` | GET | Per-model device report (GPU/CPU/IDLE/OFFLINE) + active backend info |
| `/rag/ingest` | POST | Index documents in `memory/input/` (runs as a background task) |
| `/rag/status` | GET | Returns `{enabled, chunk_count, collection, embed_model}` |
| `/rag/manifest` | GET | Returns the subject manifest from `assets/images/manifest.json` |
| `/dossier/{key}` | GET | Parses `assets/dossier_descriptions/{key}.md` → `{title, body, meta}` |

**Phase 11 endpoints** (added as each tool is implemented):

| Endpoint | Method | Tool |
|---|---|---|
| `/weather` | GET | Weather forecast + current conditions (Open-Meteo); optional `location` and `force` params |
| `/weather/history` | GET | Cached historical weather snapshots; optional `location` filter |
| `/news` | GET | News headlines (RSS) |
| `/stocks` | GET | Live price data for configured watchlist (equities + crypto); 5-min cache |
| `/stocks/cache` | DELETE | Bust the stocks cache for an immediate re-fetch |
| `/api/browser/page-text` | POST | Extract plain text from a URL for LLM context injection |
| `/api/browser/wiki-section` | GET | Fetch a named Wikipedia section as plain text |
| `/ideas/add` | POST | Save a new idea |
| `/ideas` | GET / DELETE | List or clear all ideas |
| `/ideas/{id}` | DELETE | Delete one idea by id |
| `/ideas/search` | GET | Full-text search across ideas |
| `/journal/entry` | POST | Save a journal entry (summary + raw transcript + tags) |
| `/journal/entries` | GET | List journal entries (newest first) |
| `/journal/search` | GET | Search journal entries by keyword |
| `/journal/entry/{id}` | DELETE | Delete a journal entry |
| `/wiki/start` | POST | Wikipedia RAG — start a local article Q&A session |
| `/wiki/status` | GET | Wikipedia RAG — active session and index status |
| `/wiki/clear` | POST | Wikipedia RAG — end the active session |
| `/wiki/chat` | POST | Wikipedia RAG — guardrailed article Q&A (streams NDJSON) |
| `/calendar/today` | GET | Today's Google Calendar events |
| `/calendar/week` | GET | 7-day Google Calendar events |
| `/gmail/unread` | GET | List unread Gmail messages |
| `/gmail/message/{id}` | GET | Full plain-text body of one message |
| `/gmail/trash/{id}` | POST | Move a message to Trash |

### Example: stream a chat response

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the speed of light?", "history": []}'
```

---

## Troubleshooting

**llama-server not found**
Make sure `llama-server.exe` is either on your PATH or the full path is set in `scripts/start_llama_server.bat`. Download from the [llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases/latest) — use the `win-cuda-12.x` build.

**Switching back to Ollama**
Set `LLM_BACKEND=ollama` in `.env` and restart the FastAPI backend. Both Ollama (`:11434`) and llama-server (`:8080`) can run simultaneously — the switch is instant.

**LLM not using my GPU**
Run `nvidia-smi` while the model is loaded. If VRAM usage is 0, check that `--n-gpu-layers` is set to a high value (999 offloads all layers) in `start_llama_server.bat`.

**Web Speech API not working**
Chrome and Edge only — Firefox does not support `webkitSpeechRecognition`. Also requires HTTPS or `localhost`.

**Model responses are slow**
Try a smaller model or increase `--n-gpu-layers`. The metrics bar shows live t/s so you can confirm GPU acceleration is active.

**Audio not playing after TTS**
Browsers enforce an autoplay policy that blocks `audio.play()` until the user has made a gesture on the page. TTS playback is triggered by the user's mic press or send button, which satisfies the policy.

---

## Roadmap

See [`TODO.md`](./TODO.md) for the full list of planned enhancements with links to implementation plans.

High-level milestones:
- [x] Project scaffolding and documentation
- [x] Ollama integration with streaming responses
- [x] **llama.cpp migration** — replaced Ollama relay with direct llama-server (OpenAI-compatible); noticeable speed gains confirmed; Ollama kept as a one-line fallback
- [x] Push-to-talk voice input (MediaRecorder → Whisper STT on GPU)
- [x] Kokoro TTS with 16 curated voices, sentence-chunked playback, and mode toggle
- [x] Living black sphere (Three.js) — 7 orbiting light orbs, audio-driven deformation, 4-state machine
- [x] Per-model GPU/CPU device reporting in footer (`/system-status`)
- [x] Model warm-up on page load — Kokoro + Whisper pre-heated, GPU badges populated before first mic press
- [x] LLM metrics bar — prompt tokens, generation speed, time, and context window fill percentage
- [x] **Voice-triggered dossier / presentation mode** — voice trigger intercept, neon border animation, four-zone layout reconfiguration, manifest-driven image + structured text loading, LLM auto-briefing via sentence-chunked TTS
- [x] **RAG memory system** — ChromaDB + BM25/vector fusion; `make rag-ingest` indexes any `.md`/`.txt` files dropped into `memory/input/`
- [x] **Voice tool kit (Tools 1–5, 7–10)** — Time & date, timers, weather (Open-Meteo), news briefing (RSS + LLM synthesis), stocks & crypto (Yahoo Finance / yfinance), in-UI browser panel, ideas vault, voice journal, Wikipedia RAG
- [ ] **Wake word & interrupt** — "Hey Starling" always-on listener + mid-speech interrupt; see [`plan/WAKE_WORD.md`](./plan/WAKE_WORD.md)
- [ ] **Google Calendar & Gmail** — OAuth2 integrations; see [`plan/CALENDAR.md`](./plan/CALENDAR.md) and [`plan/GMAIL.md`](./plan/GMAIL.md)
- [ ] **Electron desktop app** — standalone installer for Windows/macOS/Linux; see [`plan/feature-electron-packaging-1.md`](./plan/feature-electron-packaging-1.md)
- [ ] **Dream state / soul / sleep mode** — session-end LLM reflection, persistent personality file, inactivity retreat; see [`plan/`](./plan/)
- [ ] **Cross-platform & macOS Apple Silicon** — hardware auto-detect, CPU fallback, M4 Mac Mini support; see [`plan/`](./plan/)

---

## Contributing

Pull requests welcome. Please open an issue first to discuss major changes. Keep PRs focused — one feature or fix per PR.

```bash
# Run the backend in dev mode (must run from backend/ directory)
cd backend && uvicorn main:app --reload --port 8000

# Lint Python
pip install ruff && ruff check backend/
```

---

## License

MIT — do whatever you want, no warranty implied.

---

> *"At your service."*