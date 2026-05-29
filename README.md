<div align="center">

# S.T.A.R.L.I.N.G.

*Speech-Triggered Autonomous Reasoning & Local Intelligence Node Generator*

A fully local, voice-driven AI assistant powered by your own GPU — no cloud APIs, no subscriptions, no telemetry.

![Python](https://img.shields.io/badge/Python-3.11+-3776ab?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688?style=flat-square&logo=fastapi&logoColor=white)
![llama.cpp](https://img.shields.io/badge/llama.cpp-local%20LLM-ff6600?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

[Overview](#overview) • [Features](#features) • [Quickstart](#quickstart) • [Configuration](#configuration) • [Voice Tools](#voice-tools) • [API](#api-reference)

![S.T.A.R.L.I.N.G. UI](assets/images/Starling_UI_example.png)

</div>

## Overview

S.T.A.R.L.I.N.G. is a self-hosted voice assistant that runs the entire speech pipeline on your own machine:

```
Microphone → Speech-to-Text → llama-server (LLM on GPU) → Text-to-Speech → Browser UI
```

Speech is transcribed with faster-whisper, reasoned over by a local LLM via llama-server (llama.cpp), and spoken back with Kokoro TTS — all GPU-accelerated, typically under three seconds end to end. The browser UI renders a living black sphere that reacts to your voice, alongside a suite of voice-activated tools for weather, news, markets, calendar, mail, and more.

> [!NOTE]
> Nothing leaves your machine. No external API keys are required for core functionality. Cloud-backed tools like Calendar and Mail use your own credentials, stored locally.

## Features

- **Voice in, voice out** — browser MediaRecorder → faster-whisper STT; Kokoro TTS (or browser SpeechSynthesis) with sentence-chunked streaming playback.
- **Local LLM** — direct llama-server (llama.cpp) inference on GPU; Ollama kept as a switchable fallback.
- **Low latency** — voice → LLM → first audio in under ~3 seconds with all pipelines on GPU.
- **Living sphere UI** — Three.js scene with orbiting light orbs that react to audio and shift colour/speed per state (idle / listening / thinking / speaking), plus cinematic boot, shutdown, sleep, and wake animations.
- **RAG memory** — ChromaDB with BM25/vector fusion retrieval; drop `.md`/`.txt` files into `memory/input/` and ingest.
- **Persistent soul** — an evolving personality file updated by a session-end "dream state" reflection pipeline.
- **Self-awareness** — boot snapshot, tool inventory, live GPU/process telemetry, and a static system-prompt block so the assistant can describe its own state.
- **Voice tool kit** — 15 self-contained voice tools (see [Voice Tools](#voice-tools)).

## Requirements

- **OS:** Windows, Linux, or macOS
- **GPU:** NVIDIA 6 GB+ VRAM (CUDA 12+) or a DirectX 12 GPU (DirectML); CPU fallback supported
- **Python:** 3.11+
- **Browser:** Chrome or Edge (required for MediaRecorder / Web Speech API)
- **llama-server** from [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases/latest)

### Recommended model by VRAM

| GPU VRAM | Model | Quant |
|---|---|---|
| 4–6 GB | Gemma 3 4B, Phi-4 Mini, Llama 3.2 3B | Q4_K_M |
| 6–8 GB | Llama 3.1 8B, Mistral 7B, Qwen 2.5 7B | Q4_K_M |
| 10–16 GB | Llama 3.1 13B, Mistral 12B | Q4_K_M |
| 40 GB+ | Llama 3.1 70B | Q4_K_M |

> [!TIP]
> GGUF model files can be reused directly from your existing Ollama blob cache (`%USERPROFILE%\.ollama\models\blobs\`) — no re-download needed. Point `scripts/start_llama_server.bat` at the relevant blob.

## Quickstart

```bash
git clone https://github.com/danielbsimpson/llm-speech-UI.git
cd llm-speech-UI

# 1. Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\Activate.ps1

# 2. Install dependencies and download the Kokoro TTS model (~330 MB)
pip install -r requirements.txt
python scripts/download_models.py

# 3. Configure environment
cp .env.example .env             # then set LLM_BACKEND, LLAMA_SERVER_URL, LLAMA_MODEL
```

Start everything (llama-server + FastAPI backend) with one command:

```bash
make up          # or, on Windows: start.bat
```

Then open **http://localhost:8000** in Chrome or Edge. The UI shows `INITIALISING…` while Kokoro and Whisper warm up; once the GPU badges appear, you can speak.

To stop:

```bash
make down        # or, on Windows: stop.bat
```

> [!TIP]
> Press **Ctrl+C** in the `make up` terminal to shut down both processes at once.

### Manual start (for iterating on the backend)

```powershell
# Terminal 1 — LLM
.\scripts\start_llama_server.bat        # wait for "server is listening on http://127.0.0.1:8080"

# Terminal 2 — backend
make backend                            # or: cd backend && uvicorn main:app --reload --port 8000
```

### Activate RAG (optional)

Set `RAG_ENABLED=true` in `.env`, then after the backend is running:

```bash
make rag-ingest      # indexes .md/.txt files in memory/input/
make rag-status      # verify chunk_count > 0
```

On first run, fastembed downloads its embedding model (~33 MB) from HuggingFace and caches it locally.

## Configuration

Copy `.env.example` to `.env` and edit. Key settings:

| Variable | Default | Description |
|---|---|---|
| `LLM_BACKEND` | `llama` | `llama` (llama-server) or `ollama` (fallback) |
| `LLAMA_SERVER_URL` | `http://localhost:8080` | llama-server endpoint |
| `LLAMA_MODEL` | `llama3.2-3b` | Must match the `--alias` passed to llama-server |
| `BACKEND_PORT` | `8000` | FastAPI port |
| `WHISPER_MODEL_SIZE` | `base` | `tiny` / `base` / `small` / `medium` / `large-v3` |
| `WHISPER_DEVICE` | `cuda` | Set to `cpu` if CUDA is unavailable |
| `ONNX_PROVIDER` | `CUDAExecutionProvider` | Or `DmlExecutionProvider` / `CPUExecutionProvider` |
| `RAG_ENABLED` | `false` | Enable retrieval-augmented generation |

> [!NOTE]
> Tool-specific settings (Weather, News, Stocks, Calendar, Mail, etc.) are also configured in `.env`. Calendar and Mail credentials can instead be entered through the in-app toolkit login panel. See `.env.example` for the full list.

Switching back to Ollama is instant: set `LLM_BACKEND=ollama` and restart the backend. Both servers can run simultaneously.

## Voice Tools

Each tool is a self-contained dispatch intercept — none modify the core chat pipeline. Say the trigger phrase to activate.

| # | Tool | Backend | Status |
|---|---|---|---|
| 1 | Time & Date | None | ✅ |
| 2 | Timers | None | ✅ |
| 3 | Weather | Open-Meteo (free, no key) | ✅ |
| 4 | News Briefing | RSS / feedparser | ✅ |
| 5 | Stocks & Crypto | yfinance | ✅ |
| 6 | In-UI Browser Panel | None | ✅ |
| 7 | Ideas Vault | Local JSON | ✅ |
| 8 | Voice Journal | Local JSON | ✅ |
| 9 | Wikipedia RAG | ChromaDB + fastembed | ✅ |
| 10 | Reddit Social Feed | Reddit JSON API | ✅ |
| 11 | YouTube Feed | YouTube Atom RSS | ✅ |
| 12 | Toolkit Menu | None (frontend) | ✅ |
| 13 | iCloud Calendar | CalDAV (Apple ID) | ✅ |
| 14 | Apple Mail Inbox | IMAP (Apple ID) | ✅ |
| 15 | System Awareness | Local introspection | ✅ |
| — | Wake Word & Interrupt | None | 🔲 Planned |

See [`toolkit/README.md`](./toolkit/README.md) for screenshots and the full [trigger phrase reference](./toolkit/TRIGGER_PHRASES.md).

## STARLING Soul

STARLING maintains a persistent personality file at `backend/memory/soul/SOUL.md` that evolves session to session.

- **Session injection** — `SOUL.md` is read per request and appended to the system prompt for all LLM calls, so soul updates take effect without a restart.
- **Dream state** — on shutdown, a four-pass reflection pipeline processes the session transcript; Pass 4 (Soul Reviewer) decides whether to rewrite `SOUL.md`, archiving the prior version. Routine sessions produce `NO_CHANGE`.
- **Editing** — `SOUL.md` is plain Markdown, editable directly or via the in-app **Soul Panel** (`VIEW / EDIT SOUL` in the toolkit). Preserve the five core section headers so the reviewer can update them.

| Endpoint | Method | Description |
|---|---|---|
| `/soul` | GET | Current `SOUL.md` as plain text |
| `/soul/history` | GET | List archived soul versions |
| `/soul/diff/{session_id}` | GET | Unified diff against the following version |
| `/soul/restore/{session_id}` | POST | Roll back to an archived version (localhost only) |

## Project Structure

```
frontend/        UI — HTML/CSS/JS + Three.js sphere and tool panels
backend/         FastAPI server — STT, TTS, LLM relays, RAG, tool routes, soul
  memory/        Runtime data — caches, JSON stores, ChromaDB, soul files
assets/          Images, dossier data, cached Wikipedia, archived guides
plan/            Implementation plans for upcoming features
toolkit/         Voice trigger reference and per-tool documentation
scripts/         Setup, model download, launch/stop, integration test
tests/           pytest suite
models/          Local model files (e.g. kokoro-v1.0.onnx)
```

## API Reference

Core endpoints (FastAPI backend):

| Endpoint | Method | Description |
|---|---|---|
| `/chat` | POST | Send a message, stream LLM response (NDJSON) |
| `/transcribe` | POST | Upload audio blob → transcript |
| `/synthesize` | POST | Send text → WAV audio |
| `/synthesize/voices` | GET | List available Kokoro voices |
| `/health` | GET | Backend status |
| `/system/status` | GET | Boot snapshot, tool inventory, live telemetry (localhost only) |
| `/rag/ingest` | POST | Index documents in `memory/input/` (background task) |
| `/rag/status` | GET | RAG status `{enabled, chunk_count, collection, embed_model}` |

Tool endpoints (weather, news, stocks, journal, ideas, wiki, calendar, mail, reddit, youtube, soul) are documented in [`toolkit/README.md`](./toolkit/README.md).

```bash
# Example: stream a chat response
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the speed of light?", "history": []}'
```

## Troubleshooting

> [!WARNING]
> **llama-server not found** — ensure `llama-server.exe` is on PATH or its full path is set in `scripts/start_llama_server.bat`. Use the `win-cuda-12.x` build.

- **LLM not using GPU** — run `nvidia-smi` while loaded; if VRAM usage is 0, raise `--n-gpu-layers` (999 offloads all layers) in `start_llama_server.bat`.
- **Web Speech API not working** — Chrome/Edge only; requires `localhost` or HTTPS.
- **Slow responses** — try a smaller model or increase `--n-gpu-layers`; the metrics bar shows live tokens/sec.
- **No audio after TTS** — browsers block autoplay until a user gesture; the mic/send action satisfies this.

## Roadmap

See [`TODO.md`](./TODO.md) for the full enhancement list with links to implementation plans. Upcoming highlights:

- **Wake word & interrupt** — "Hey Starling" always-on listener + mid-speech barge-in
- **RAG memory manager** — in-UI upload, preview, and delete of ingested sources
- **Electron desktop app** — standalone installers for Windows/macOS/Linux
- **Cross-platform auto-detect** — CUDA/DirectML/Metal/CPU selection at launch; Apple Silicon (M4) support

---

<div align="center">

*"At your service."*

</div>
