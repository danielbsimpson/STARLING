# S.T.A.R.L.I.N.G. — Speech‑Triggered Autonomous Reasoning & Local Intelligence Node Generator

A voice-driven, S.T.A.R.L.I.N.G.-style web interface powered by a local LLM via Ollama.

---

## Current Issues

| # | Component | Description | Status |
|---|---|---|---|
| 1 | TTS (Kokoro) | Speech playback is lagged ~3–4 s behind text appearing in the UI — full response completes before audio begins | ✅ Resolved — all pipelines migrated to GPU; delay reduced from 2–8 s to ~3–4 s. Sentence-chunked TTS (Phase 7) remains as a further improvement |
| 2 | TTS / STT GPU utilisation | CPU usage spiked during synthesis and transcription; neither pipeline was dispatching to the GPU | ✅ Resolved — Kokoro and Whisper now run on GPU; `onnxruntime-gpu` and CUDA libraries confirmed working |
| 3 | STT (listening mode) | Recording stops too early — silence detection cuts off the user mid-sentence before they have finished speaking | 🔴 Open |

**Potential fixes to investigate:**
- **TTS lag**: implement sentence-chunked TTS — split the streamed response on `.`, `?`, `!` boundaries and synthesise + play each sentence as it completes rather than waiting for the full response (see Phase 7)
- **STT early cutoff** — several approaches ranked by effort:
  - **Extend silence timeout**: increase the silence/inactivity threshold in the MediaRecorder stop logic (e.g. from ~500 ms to 1 500–2 000 ms) — lowest effort, try first
  - **Energy-based VAD in the browser**: use the Web Audio API `AnalyserNode` to compute the RMS of the mic signal in real time; only trigger stop when the energy stays below a threshold for a sustained window (avoids cutting off on short inter-word pauses)
  - **Silero VAD (backend)**: run the lightweight Silero VAD model server-side on each incoming audio chunk; it is specifically trained to distinguish speech from silence and is far more accurate than a fixed timeout
  - **`faster-whisper` VAD filter tuning**: `faster-whisper` exposes `vad_filter=True` with tunable `vad_parameters` (min silence duration, speech pad, etc.) — tighten the post-recording filter so short pauses within a sentence are not treated as end-of-speech
  - **Streaming chunked STT**: stream audio to the backend in small chunks via WebSocket; transcribe each chunk with Whisper and only finalise when a real pause is detected rather than relying on the frontend to decide when to stop recording
  - **Push-to-talk only mode**: remove automatic stop entirely — user holds spacebar/button for the full utterance; eliminates all VAD false-positives at the cost of requiring deliberate release
  - **Configurable silence timeout in settings panel**: expose the silence threshold (ms) as a slider in the settings panel so users can tune it for their microphone / speaking style without a code change

**Monitoring**: The `/system-status` endpoint and footer device badges surface GPU vs CPU state for all three pipelines in real time after each exchange.

---

## Phase 1 — Repo Setup

- [x] Initialize repository: `git init llm-speech-ui`
- [x] Create folder structure (see below)
- [x] Add `.gitignore` (node_modules, __pycache__, .env, models/)
- [x] Add `README.md` with project overview and setup instructions
- [x] Pin Python version with `.python-version` (set to 3.11)
- [x] Add `LICENSE` file (MIT)

```
starling-local/
├── frontend/           # HTML/CSS/JS or React app
│   ├── index.html
│   ├── style.css
│   └── app.js
├── backend/            # FastAPI server (optional glue layer)
│   ├── main.py
│   ├── stt.py          # Speech-to-text (Whisper)
│   ├── tts.py          # Text-to-speech (Kokoro / Piper)
│   └── ollama.py       # Ollama API client
├── scripts/
│   └── setup.sh        # One-shot install script
├── .env.example
├── requirements.txt
├── TODO.md
└── README.md
```

---

## Phase 2 — LLM Backend (Ollama)

- [x] Install Ollama: already installed from other local builds
- [x] Pull a base model: several models already downloaded and available
- [x] Verify GPU is being used: GPU-accelerated inference confirmed working
- [x] Test the REST API manually: confirmed working (`llama3.1:8b` responds correctly)
- [x] Document recommended models + VRAM requirements in README
- [x] Add model config to `.env` (model name, API base URL, temperature, system prompt)
- [x] Optionally write a system prompt to give the AI a "S.T.A.R.L.I.N.G." persona

---

## Phase 3 — Speech-to-Text (STT)

### Option A — Browser Web Speech API ~~(easiest)~~
- [x] ~~Implement `webkitSpeechRecognition`~~ — skipped, sends audio to Google (not local)
- [x] ~~Handle `onresult`, `onerror`, and `onend` events~~ — replaced by MediaRecorder approach
- [x] Push-to-talk button with visual feedback (hold to record, release to send)

### Option B — Local Whisper (higher accuracy) ✅ CHOSEN
- [x] Install faster-whisper: installed into `.venv` (v1.2.1)
- [x] Write `backend/stt.py` with a `/transcribe` POST endpoint
- [x] Accept audio blob from frontend (MediaRecorder API)
- [x] Return transcript as JSON
- [x] Model size: `base` (configurable via `WHISPER_MODEL_SIZE` in `.env`)
- [x] Confirm GPU acceleration is working for Whisper (CUDA device count: 1 ✅)

---

## Phase 4 — Text-to-Speech (TTS)

### Option A — Browser SpeechSynthesis (easiest)
- [ ] Implement `SpeechSynthesisUtterance` in `app.js`
- [ ] Let user pick voice from available system voices
- [ ] Tune `rate`, `pitch`, and `volume` for a robotic S.T.A.R.L.I.N.G. feel

### Option B — Kokoro TTS (best local quality) ✅ CHOSEN
- [x] Install Kokoro: `pip install "kokoro-onnx[gpu]"` (v0.5.0, GPU-accelerated)
- [x] Write `backend/tts.py` with `/synthesize` POST endpoint and `/synthesize/voices` GET endpoint
- [x] Return audio as WAV, play via `<Audio>` element in frontend
- [x] 16 curated English voices (US/GB, male/female) selectable from UI dropdown
- [x] TTS mode toggle: Kokoro → Browser → Off (persisted in localStorage)
- [x] Auto-fallback to browser SpeechSynthesis if Kokoro backend unavailable
- [x] Model download script: `python scripts/download_models.py` (~330 MB)
- [ ] Download models: run `python scripts/download_models.py`

### Option C — Piper TTS (fastest, lower quality)
- [ ] Download Piper binary from GitHub releases
- [ ] Download a voice model (e.g. `en_US-ryan-high`)
- [ ] Wrap in a `/synthesize` endpoint in FastAPI

---

## Phase 5 — Frontend UI

- [x] Build base HTML layout with the HUD aesthetic (dark bg, cyan tones)
- [x] Add animated waveform bars (CSS + JS animation, real AudioAnalyser during recording)
- [x] Add arc reactor / ring SVG animation (idle drift + fast spin when thinking, glow when listening)
- [x] Display live streamed LLM response text (token by token with blinking cursor)
- [x] Show STT transcript in real time as user speaks (transcript appended on stop)
- [x] Add status indicators (GPU, model name, STT/TTS engine in footer; status in header)
- [x] Wire mic button: start recording → STT → send to LLM → TTS
- [x] Add text input fallback for when mic is unavailable
- [x] Make UI responsive for different screen sizes (clamp-based sizing)
- [x] Add keyboard shortcut (spacebar push-to-talk)

---

## Phase 6 — FastAPI Backend (glue layer)

- [x] Install FastAPI: `pip install fastapi uvicorn python-dotenv`
- [x] Create `backend/main.py` with route structure
- [x] Add `/chat` endpoint that accepts text and streams Ollama response
- [x] Add `/transcribe` endpoint (Whisper STT)
- [x] Add `/synthesize` endpoint (Kokoro TTS) + `/synthesize/voices` GET
- [x] Add `/health` endpoint
- [x] Add `/system-status` endpoint — reports GPU vs CPU for Whisper, Kokoro, and Ollama; polled by the frontend after each exchange and shown as colour-coded badges in the footer
- [x] Enable CORS for local frontend
- [x] Load config from `.env` (model name, API URL, temperature, system prompt, WHISPER_DEVICE, ONNX_PROVIDER)
- [x] Add basic error handling and logging (CUDA fallback in stt.py and tts.py)

---

## Phase 7 — Streaming & Integration

- [x] Implement streaming response from Ollama in frontend (`ReadableStream`)
- [x] Render tokens as they arrive (typewriter effect with blinking cursor)
- [x] Maintain conversation history array for multi-turn context
- [x] Pass full conversation history in each Ollama request
- [x] Add a “clear conversation” button
- [ ] Start TTS only after full response is received — **done**; sentence-chunked TTS still pending (see Issue #1)

---

## Phase 8 — Polish & UX

- [x] Add loading/thinking animation while LLM is processing (ring spin + state machine)
- [x] Show error messages in UI (model not found, Ollama offline, STT/TTS errors)
- [x] Add auto-scroll to bottom of chat on new messages
- [x] Per-model GPU/CPU device indicators in footer (Whisper / Kokoro / Ollama badges, updated after each exchange)
- [x] Add settings panel: change voice
- [ ] Add settings panel: switch models, adjust temperature
- [ ] Optional: wake word detection ("Hey STARLING") using Web Audio API
- [ ] Optional: sound effects on mic activate / response start

### Design improvements
- [x] Full-width layout — remove side margins/borders so the interface fills the entire browser window
- [x] Borderless chat bubbles — remove visible borders from STARLING and user message containers for a cleaner look
- [x] Chat bubble alignment — user messages aligned to the right, STARLING messages aligned to the left
- [x] Monochrome theme — rework colour palette to blacks, greys, and whites; replace cyan accent tones with light-grey/white highlights

#### Listening state indicator — replace ear emoji
The 👂 emoji clashes with the HUD aesthetic. The indicator should still clearly communicate that STARLING is actively listening. Ideas to explore:
- **Animated ring pulse**: repurpose the existing arc-reactor ring with a slow, steady radial pulse (CSS `scale` keyframe) in a distinct colour (e.g. a dim amber or cool white) to signal the listening state — reuses existing infrastructure with zero new assets
- **Waveform border glow**: animate a soft glow on the waveform bars that is always visible during recording, using a CSS `box-shadow` / `filter: drop-shadow` cycle — ties the "listening" visual directly to the audio input element
- **Scanning line / sweep animation**: a horizontal scan-line that sweeps across the mic button area at a steady cadence, evoking a radar or sonar sweep
- **Dot-matrix text label**: replace the emoji with a monospaced, letter-spaced `LISTENING…` label in a small caps style that blinks or fades in/out — purely typographic, fits the HUD font language
- **Corner bracket blink**: flash the four corner-bracket elements (if present in the layout) in sync with the recording state — subtle, structural, no icons required
- **Mic button state transform**: morph the mic button icon into a minimalist animated waveform SVG (three vertical bars of varying height) only while recording, returning to the static icon when idle
- **Living black sphere** ⭐: replace the flat ring entirely with a 3-D sphere rendered on a `<canvas>` or via a WebGL/Three.js scene. The sphere sits in the same central position and has the following layered behaviours:
  - *Base appearance*: a near-perfect matte black sphere with a very subtle specular highlight — appears almost featureless until the light source moves
  - *Ambient light drift*: a single diffuse point light orbits the sphere on a slow, randomised path (e.g. a Lissajous or Perlin-noise-driven trajectory) — as it moves, it grazes the sphere's limb and casts a soft gradient that shifts around the silhouette, giving the impression the sphere is alive without being animated in an obvious way
  - *Idle state*: light drift only; sphere surface is perfectly smooth and still
  - *Thinking state*: light orbit speed increases slightly; a faint internal glow pulses from the centre outward (emissive bloom)
  - *Listening state*: the sphere surface deforms in real time using microphone input — audio amplitude values from the `AnalyserNode` are mapped to vertex displacement on the sphere mesh, so the surface ripples and bulges as the user speaks, as if the sound waves are physically striking it; deformation snaps back to smooth when audio energy drops
  - *Implementation options*: Three.js `SphereGeometry` with per-vertex displacement driven by `getByteFrequencyData`; alternatively a GLSL fragment shader using a normal-map perturbation + rim-lighting trick for a lower-overhead approach that still reads convincingly as a 3-D sphere without true geometry deformation

#### Conversation window — bubbleless layout
Remove background/border styling from message containers so text floats freely. Ideas to differentiate STARLING vs USER without bubbles:
- **Typeface contrast**: STARLING uses a monospaced font (e.g. `JetBrains Mono`, `IBM Plex Mono`) to suggest machine output; USER uses a proportional sans-serif — immediately distinguishable at a glance
- **Colour split**: STARLING text in a light-grey/off-white (`#e0e0e0`); USER text in a dimmer mid-grey (`#888`) — or reverse with USER slightly brighter to feel more "present"
- **Speaker label style**: replace bold `STARLING` / `YOU` headers with small-caps, letter-spaced labels (`S T A R L I N G`, `U S E R`) in a muted tone, sitting above the message text at reduced font size; rename `YOU` → `USER` throughout
- **Left-edge rule for STARLING**: a 2 px vertical rule (`border-left`) in a neutral grey on STARLING messages only — provides visual anchor without a full bubble
- **Indent differentiation**: USER messages indented further right with a larger `padding-left`/`margin-left`, creating natural white-space separation without any background
- **Opacity layering**: STARLING messages at full opacity; USER messages at ~70 % opacity — visually recedes the user text relative to the AI response, emphasising the output
- **Font weight**: STARLING in `font-weight: 300` (light); USER in `font-weight: 400` (regular) — subtle but readable contrast
- [ ] Rename speaker label `YOU` → `USER` in frontend (`app.js` / `index.html`)
- [ ] Remove bubble background/border styles from message containers in `style.css`
- [ ] Implement chosen typographic differentiation scheme (typeface, colour, or weight contrast)

---

## Phase 9 — DevEx & Tooling

- [ ] Write `scripts/setup.sh` to automate full install
- [ ] Add `Makefile` with targets: `make start`, `make backend`, `make frontend`
- [ ] Add hot-reload for frontend (e.g. Vite or live-server)
- [ ] Add hot-reload for backend (`uvicorn --reload`)
- [ ] Write basic integration test: send text → verify Ollama responds
- [ ] Document all `.env` variables in `.env.example`

---

## Stretch Goals

- [ ] Add tool use / function calling (weather, web search, calendar)
- [X] Visualize GPU/CPU load live in the HUD
- [ ] Add multiple AI "modes" (assistant, coder, analyst) with different system prompts
- [ ] Package as an Electron desktop app for no-browser-needed launch
- [ ] Add local RAG (retrieval-augmented generation) with a document folder
- [ ] Support multiple simultaneous models / model switching on the fly

---

### Stretch Goal — GraphRAG Knowledge Graph Memory

Replace flat vector RAG with [Microsoft GraphRAG](https://github.com/microsoft/graphrag): a structured, hierarchical RAG system that builds a knowledge graph from your documents. Unlike baseline RAG (top-k vector similarity), GraphRAG extracts entities and relationships, clusters them into communities using the Leiden algorithm, and generates multi-level summaries — enabling the AI to answer holistic "what is this corpus about?" questions as well as specific entity-level lookups.

#### Step 1 — Install & configure GraphRAG
- [ ] `pip install graphrag` into `.venv`
- [ ] Create a `memory/` folder as the GraphRAG data root (add `memory/output/` to `.gitignore`)
- [ ] Run `graphrag init --root memory/` to scaffold `settings.yaml` and prompt templates
- [ ] Configure `settings.yaml` to use Ollama as the LLM via the LiteLLM `openai`-compatible proxy:
  - Set `api_base: http://localhost:11434/v1` and `model: ollama/<model_name>` in both `completion_models` and `embedding_models`
  - Use `nomic-embed-text` (already pulled) for embeddings; use `llama3.1:8b` or `qwen2.5:7b` for completion
  - Set `indexing_method: fast` initially to avoid heavy LLM usage during graph extraction — switch to `standard` (LLM-extracted entities) once it's working
- [ ] Run `graphrag prompt-tune --root memory/` to auto-tune extraction prompts for the local model

#### Step 2 — Build the document corpus
- [ ] Create `memory/input/` as the watched document folder
- [ ] Write a `scripts/export_conversations.py` script that appends each completed conversation turn to a dated `.txt` file in `memory/input/` (one file per session)
- [ ] Decide on additional document sources to ingest: notes, project docs, README, etc.

#### Step 3 — Index the corpus into a knowledge graph
- [ ] Run the indexing pipeline: `graphrag index --root memory/`
  - This extracts entities, relationships, and claims from all `.txt`/`.md` files in `memory/input/`
  - Performs Leiden community detection to group related entities
  - Generates hierarchical community summaries (bottom-up, multiple granularity levels)
  - Outputs Parquet tables to `memory/output/` and embeddings to a local vector store
- [ ] Add a `POST /memory/index` endpoint in `backend/main.py` that triggers re-indexing as a background task (using `asyncio.create_subprocess_exec` calling the graphrag CLI)

#### Step 4 — Wire query into the chat pipeline
- [ ] Add a `POST /memory/query` endpoint in `backend/main.py` that wraps the GraphRAG Python query API:
  - **Local search**: for entity-specific questions — fans out from named entities to neighbors and associated claims
  - **Global search**: for holistic/thematic questions — uses community summaries to synthesise a corpus-wide answer
  - Accept a `mode: "local" | "global" | "drift"` parameter; default to `local`
- [ ] In `backend/ollama.py`, before streaming the Ollama response, call `/memory/query` with the user's message
- [ ] Prepend the returned graph context as a `system`-role message block in the conversation history sent to Ollama (keep it under ~2 000 tokens to stay within context window)

#### Step 5 — Auto-index new conversations
- [ ] After each complete assistant turn, append the exchange (user + assistant) to the current session file in `memory/input/`
- [ ] Trigger an incremental re-index in the background (debounced — at most once every N minutes, configurable via `.env`)
- [ ] Add a `GET /memory/status` endpoint returning the last index timestamp and entity/community counts from the Parquet output

#### Step 6 — Surface memory in the HUD
- [ ] Add a `MEMORY` stat chip to the header stats row (shows entity count or `OFF` when no index exists)
- [ ] Show a subtle "memory active" indicator on the ring when graph context was injected into a response
- [ ] Add a `MEMORY` button to the controls row that opens a simple panel listing: last indexed time, document count, top entities, and a manual "Re-index now" trigger
- [ ] Display the active search mode (`LOCAL` / `GLOBAL`) in the footer alongside the TTS/STT labels

---

## Stack Summary

| Layer | Tool | Notes |
|---|---|---|
| LLM runtime | Ollama | GPU-accelerated local inference |
| LLM model | Llama 3 / Mistral / Gemma 2 | Pull via `ollama pull` |
| STT | Web Speech API or faster-whisper | Browser = easy, Whisper = accurate |
| TTS | SpeechSynthesis or Kokoro TTS | Browser = easy, Kokoro = quality |
| Backend | FastAPI + uvicorn | Optional glue, needed for Whisper/Kokoro |
| Frontend | Vanilla HTML/JS or React + Vite | Single file works fine to start |