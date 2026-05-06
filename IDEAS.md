# S.T.A.R.L.I.N.G. — Improvement Ideas

A running log of planned enhancements, each with enough detail to roll out independently.

---

## IDEA-001 — Sentence-Chunked TTS (Reduce Audio Lag)

**Status**: Ready to implement  
**Effort**: Small (frontend-only)  
**Impact**: First audio plays ~1–3 s after response starts instead of after it fully completes

### Problem

TTS is triggered only after the entire LLM response has streamed in:

```
stream all tokens → accumulate full string → POST /synthesize → wait for WAV → play
```

On a 5-sentence response, the user waits the full generation time **plus** synthesis time before hearing anything.

### Solution

Split the stream into sentences as tokens arrive, synthesise and play each sentence as soon as its terminal punctuation is detected, and queue subsequent sentences so they play in order without overlap.

```
token stream → sentence buffer → boundary hit → enqueue sentence → synthesise + play
                                                                   ↑ while next sentence buffers
```

---

### Implementation Plan

#### Step 1 — Add a sentence splitter

In `sendToOllama()` in `frontend/app.js`, replace the direct `full += token; txt.textContent = full` block with a buffered version:

```js
let sentBuf = '';

// inside the token loop:
sentBuf += token;
full    += token;
txt.textContent = full;

// flush complete sentences
const sentenceRe = /[^.?!]*[.?!](?:\s|$)/g;
let match;
while ((match = sentenceRe.exec(sentBuf)) !== null) {
  const sentence = match[0].trim();
  if (sentence) enqueueSpeak(sentence);
}
sentBuf = sentBuf.slice(sentenceRe.lastIndex);
```

After the stream ends, flush any remaining buffer:

```js
// after while(true) loop exits:
if (sentBuf.trim()) enqueueSpeak(sentBuf.trim());
```

**Edge cases to handle:**
- Ellipsis (`...`) — require a whitespace or end-of-string after the punctuation before treating it as a boundary
- Abbreviations (`Dr.`, `e.g.`, `vs.`) — the whitespace requirement above already skips most; extend with a small blocklist if needed
- Decimal numbers (`3.14`) — digit-before-dot check: skip boundary if the character before `.` is a digit

---

#### Step 2 — Add an audio queue

Add these helpers above `sendToOllama()`:

```js
let _audioChain = Promise.resolve();  // serial playback queue
let _activeAudio = null;              // already exists — keep as-is

function enqueueSpeak(text) {
  if (ttsMode === 'off') return;
  _audioChain = _audioChain.then(() => speak(text));
}

function clearAudioQueue() {
  // Replace the chain with a resolved promise so pending .then()s are abandoned
  _audioChain = Promise.resolve();
  if (_activeAudio) {
    _activeAudio.pause();
    _activeAudio = null;
  }
}
```

Remove the `await speak(response)` call in `handleSend()` — sentences are now spoken as they arrive. `fetchSystemStatus()` should still fire after the stream ends, not after all audio finishes.

---

#### Step 3 — Handle the state machine overlap

During chunked playback the model is still streaming while audio is playing. Two options:

- **Simple**: keep `state-thinking` for the entire stream duration, transition to `state-speaking` only once the stream ends and the queue begins draining. Feels slightly inaccurate but avoids complexity.
- **Better**: introduce a `thinking-speaking` composite: once the first sentence is enqueued, switch to `state-speaking` but keep the ring spinning (combine both CSS classes). Revert to `idle` when `_audioChain` resolves and the stream is done.

Start with the simple option; upgrade if the UX feels odd.

---

#### Step 4 — Wire interruption handling

When the user presses the mic button or sends a new message while audio is playing:

```js
// at the top of handleMicPress() and handleSend():
clearAudioQueue();
setState('idle');
```

This stops current audio and drops queued sentences so the new response can start cleanly.

---

#### Step 5 — Browser TTS fallback

`_speakBrowser()` uses the native `SpeechSynthesis` queue which handles multiple `speak()` calls natively — no change needed. The `enqueueSpeak()` helper works transparently for both modes.

---

### Files Changed

| File | Change |
|---|---|
| `frontend/app.js` | Sentence splitter in token loop; `enqueueSpeak` / `clearAudioQueue` helpers; remove post-stream `await speak(response)` |
| `backend/tts.py` | **None** — `/synthesize` already accepts any text string |
| `backend/ollama.py` | **None** |
| `backend/main.py` | **None** |

---

### Expected Result

| Metric | Before | After |
|---|---|---|
| Time to first audio | Full generation + synthesis (~5–10 s) | First sentence synthesis only (~0.5–1.5 s after it completes in stream) |
| Backend calls per response | 1 | N (one per sentence, ~3–6 for a typical response) |
| Perceived responsiveness | Response appears, long silence, then audio | Text and audio advance together |

---

## IDEA-002 — llama.cpp Migration (Remove Ollama Wrapper)

**Status**: Ready to implement  
**Effort**: Small–Medium (backend relay rewrite + one frontend line + install step)  
**Impact**: Eliminates one relay hop (FastAPI → Ollama → llama.cpp becomes FastAPI → llama.cpp), reducing time-to-first-token and removing Ollama process overhead

### Problem

Ollama is itself a wrapper around llama.cpp. The current request path is:

```
frontend → FastAPI /chat → Ollama /api/chat → llama.cpp engine
```

This means every streaming token passes through an extra process boundary. Ollama also uses its own NDJSON format that differs from the OpenAI standard, requiring custom parsing. Running llama-server directly eliminates the middle layer entirely.

### What changes, what doesn't

| Component | Change required |
|---|---|
| `backend/ollama.py` | Yes — URL, payload format, streaming format |
| `backend/main.py` | Small — `/system-status` GPU check |
| `frontend/app.js` | One line — token extraction path |
| `backend/stt.py` | **None** |
| `backend/tts.py` | **None** |
| `frontend/` HTML/CSS | **None** |
| Conversation history format | **None** — `messages[]` array is identical |
| System prompt injection | **None** — same mechanism |

---

### Pre-requisites

#### Install llama-server on Windows (CUDA)

1. Go to the [llama.cpp GitHub releases](https://github.com/ggml-org/llama.cpp/releases) page
2. Download the latest `llama-*-win-cuda-cu12.x.x-x64.zip` (match your CUDA 12.x version)
3. Extract to a permanent location, e.g. `C:\llama.cpp\`
4. Confirm the binary works: `llama-server.exe --version`

#### Locate existing model files

Ollama stores its GGUF files in `%LOCALAPPDATA%\Ollama\models\blobs\`. They are valid GGUF files with hashed names. Either:
- Copy and rename them to a `models/` directory (e.g. `llama3.1-8b-Q4_K_M.gguf`), or
- Download fresh GGUF files from Hugging Face (llama-server can do this directly via `--hf-repo`)

---

### Implementation Plan

#### Step 1 — Rewrite `backend/ollama.py`

Replace the Ollama-specific relay with an OpenAI-compatible one targeting llama-server.

**Key differences:**
- URL: `http://localhost:11434/api/chat` → `http://localhost:8080/v1/chat/completions`
- Payload: Ollama uses `{"options": {"temperature": N}}` → OpenAI uses top-level `"temperature": N`
- Streaming format: Ollama NDJSON `{"message":{"content":"token"}}` → OpenAI SSE `data: {"choices":[{"delta":{"content":"token"}}]}`
- Media type: `application/x-ndjson` → `text/event-stream`

New `ollama.py` (rename to `llama_server.py` or keep name for minimal diff):

```python
"""backend/ollama.py — Streaming chat relay to llama-server (OpenAI-compatible)."""

import os
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/chat", tags=["llama"])

LLAMA_BASE    = os.getenv("LLAMA_SERVER_URL", "http://localhost:8080")
DEFAULT_MODEL = os.getenv("LLAMA_MODEL", "llama3.1-8b")
SYSTEM_PROMPT = os.getenv(
    "LLAMA_SYSTEM_PROMPT",
    "You are S.T.A.R.L.I.N.G. ...",
)


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[Message]
    model: str = DEFAULT_MODEL
    temperature: float = float(os.getenv("LLAMA_TEMPERATURE", "0.7"))


async def _stream_llama(payload: dict):
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", f"{LLAMA_BASE}/v1/chat/completions", json=payload
        ) as resp:
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="llama-server error")
            async for chunk in resp.aiter_bytes():
                yield chunk


@router.post("/")
async def chat(req: ChatRequest):
    messages = [m.model_dump() for m in req.messages]
    if not messages or messages[0].get("role") != "system":
        messages.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
    payload = {
        "model":       req.model,
        "messages":    messages,
        "temperature": req.temperature,
        "stream":      True,
    }
    return StreamingResponse(_stream_llama(payload), media_type="text/event-stream")
```

---

#### Step 2 — Update token parsing in `frontend/app.js`

Find the single line in `sendToOllama()` that extracts the token from each streamed line:

```js
// BEFORE (Ollama NDJSON):
const token = JSON.parse(line)?.message?.content ?? '';

// AFTER (OpenAI SSE):
const token = JSON.parse(line.replace(/^data:\s*/, ''))?.choices?.[0]?.delta?.content ?? '';
```

Also update the stream-end detection — Ollama sends `{"done":true}`, OpenAI SSE sends `data: [DONE]`. Add a guard:

```js
if (line.trim() === 'data: [DONE]') break;  // add before the JSON.parse
```

Remove the `OLLAMA_BASE` constant at the top of `app.js` — it is unused once the direct Ollama reference is gone.

---

#### Step 3 — Update `/system-status` in `backend/main.py`

The current GPU check calls `OLLAMA_BASE/api/ps` (Ollama-specific). Replace with a call to llama-server's `/slots` endpoint:

```python
# BEFORE — Ollama /api/ps
resp = await client.get(f"{OLLAMA_BASE}/api/ps")
models = resp.json().get("models", [])
size_vram = sum(m.get("size_vram", 0) for m in models)
ollama_device = "GPU" if size_vram > 0 else "CPU"

# AFTER — llama-server /slots
resp = await client.get(f"{LLAMA_BASE}/slots")
slots = resp.json()  # list of slot objects
# A loaded slot with is_processing or n_ctx > 0 means model is active
llama_device = "GPU"   # llama-server on CUDA always runs on GPU when loaded
# For a more precise check, query /props for build_info or /metrics
```

> Note: llama-server doesn't expose a VRAM-usage field the way Ollama does. The simplest approach is to treat a successful `/health` response as `GPU` when the server was started with `--n-gpu-layers all`. For a more precise check, parse the `timings` field from a test completion or read `GET /metrics`.

Update the import and env var references: `OLLAMA_BASE` → `LLAMA_BASE`, imported from `llama_server` (or wherever you renamed the module).

---

#### Step 4 — Update `.env` and `.env.example`

```ini
# BEFORE
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
OLLAMA_TEMPERATURE=0.7
OLLAMA_SYSTEM_PROMPT=...

# AFTER
LLAMA_SERVER_URL=http://localhost:8080
LLAMA_MODEL=llama3.1-8b         # matches the --alias you give llama-server
LLAMA_TEMPERATURE=0.7
LLAMA_SYSTEM_PROMPT=...
```

---

#### Step 5 — Launch llama-server

**Single model:**
```bat
llama-server.exe -m C:\models\llama3.1-8b-Q4_K_M.gguf --alias llama3.1-8b --n-gpu-layers all --port 8080 --host 127.0.0.1
```

**Multiple models (router mode):**
```bat
llama-server.exe --models-dir C:\models\ --n-gpu-layers all --port 8080 --host 127.0.0.1
```
In router mode, each `.gguf` in the directory is available by filename (without extension) as the `"model"` field. The `--alias` set per model in a preset `.ini` can make names cleaner.

Add a `scripts/start_llama_server.bat` helper for convenience.

---

### Multiple model support

llama-server's router mode handles this natively — no code changes required. Routing is done by the `"model"` field in the request body, exactly as Ollama does today. Per-model GPU layers, context size, and chat template can be configured via a `--models-preset models.ini` file.

---

### Files Changed

| File | Change |
|---|---|
| `backend/ollama.py` | Full rewrite — OpenAI-compatible payload and SSE streaming |
| `backend/main.py` | `/system-status` GPU check: swap Ollama `/api/ps` for llama-server `/slots` or `/health` |
| `frontend/app.js` | Token extraction path (1 line); add `data: [DONE]` guard; remove `OLLAMA_BASE` constant |
| `.env` / `.env.example` | Rename env vars (`OLLAMA_*` → `LLAMA_*`) |
| `scripts/` | Add optional `start_llama_server.bat` launch helper |
| `backend/stt.py` | **None** |
| `backend/tts.py` | **None** |
| `frontend/` HTML/CSS | **None** |

---

### Rollback plan

Both Ollama (port 11434) and llama-server (port 8080) can run simultaneously. Keep the old `ollama.py` as `ollama_legacy.py` during the transition and swap `main.py`'s router import to revert instantly.

---

### Expected Result

| Metric | Before | After |
|---|---|---|
| Relay hops | 3 (frontend → FastAPI → Ollama → llama.cpp) | 2 (frontend → FastAPI → llama.cpp) |
| Time to first token | Ollama relay adds ~20–80 ms per request | Eliminated |
| API format | Custom Ollama NDJSON | Standard OpenAI SSE (compatible with more tooling) |
| Model management | `ollama pull` + Ollama daemon | Raw GGUF files, no daemon required |
| Multiple models | Ollama handles transparently | llama-server router mode handles transparently |

---
