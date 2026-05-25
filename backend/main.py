import asyncio
import json
import os
import re
import signal
from pathlib import Path

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from dotenv import load_dotenv

load_dotenv()

# ── Path constants ────────────────────────────────────────────────────────────
_FRONTEND = Path(__file__).parent.parent / "frontend"
_ASSETS = Path(__file__).parent.parent / "assets"

# ── LLM backend selection ─────────────────────────────────────────────────────
# Set LLM_BACKEND=llama in .env to route /chat/ to llama-server instead of Ollama.
# Both backends expose the same NDJSON format so the frontend is unchanged.
# Default is "ollama" for backward compatibility.
LLM_BACKEND = os.getenv("LLM_BACKEND", "ollama").lower()

app = FastAPI(title="S.T.A.R.L.I.N.G. Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

import stt as _stt
import tts as _tts
from stt import router as stt_router
from tts import router as tts_router

if LLM_BACKEND == "llama":
    from llama_server import router as llm_router
    from llama_server import LLAMA_BASE as _LLM_BASE
    from llama_server import DEFAULT_MODEL as _WIKI_DEFAULT_MODEL
    from llama_server import _stream_as_ndjson as _wiki_stream
    _WIKI_TEMPERATURE: float = float(os.getenv("LLAMA_TEMPERATURE", "0.7"))
else:
    from ollama import router as llm_router
    from ollama import OLLAMA_BASE as _LLM_BASE
    from ollama import DEFAULT_MODEL as _WIKI_DEFAULT_MODEL
    from ollama import _stream_ollama as _wiki_stream
    _WIKI_TEMPERATURE: float = float(os.getenv("OLLAMA_TEMPERATURE", "0.7"))

from weather import router as weather_router
from news import router as news_router
from stocks import router as stocks_router
from browser import router as browser_router
from ideas_routes import router as ideas_router
from journal_routes import router as journal_router
from log_routes import router as log_router
from reddit import router as reddit_router
from youtube import router as youtube_router
from calendar_routes import router as calendar_router
import session_log
from rag import ingest as _rag_ingest, get_status as _rag_get_status, INPUT_FOLDER as _RAG_INPUT_FOLDER
from wikipedia_rag import (
    load_index        as _wiki_load_index,
    get_embed_model   as _wiki_get_embed_model,
    start_wikipedia_session,
    get_session       as _wiki_get_session,
    clear_session     as _wiki_clear_session,
    retrieve_chunks   as _wiki_retrieve_chunks,
    build_wiki_system_prompt,
    get_wiki_status,
)

app.include_router(stt_router)
app.include_router(llm_router)
app.include_router(tts_router)
app.include_router(weather_router)
app.include_router(news_router)
app.include_router(stocks_router)
app.include_router(browser_router, prefix='/api')
app.include_router(ideas_router)
app.include_router(journal_router)
app.include_router(log_router)
app.include_router(reddit_router)
app.include_router(youtube_router)
app.include_router(calendar_router)


# ── Startup warm-up ───────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    """Pre-load the Wikipedia index and embedding model so the first request is fast."""
    import logging
    _log = logging.getLogger(__name__)
    session_log.log_session_start(llm_backend=LLM_BACKEND, pid=os.getpid())
    try:
        # Run blocking model load in a thread so it doesn't block the event loop.
        # The 30-second timeout ensures the server always finishes starting even if
        # ChromaDB has a stale lock or any other blocking condition occurs.
        loop = asyncio.get_running_loop()
        await asyncio.wait_for(
            loop.run_in_executor(None, _wiki_load_index),
            timeout=30.0,
        )
        _log.info("Wikipedia: startup warm-up complete")
    except asyncio.TimeoutError:
        _log.warning("Wikipedia: startup warm-up timed out (30s) — server starting without warm index")
    except Exception as exc:
        _log.warning(f"Wikipedia: startup warm-up failed (non-fatal) — {exc}")


@app.on_event("shutdown")
async def shutdown_event():
    session_log.log_session_end()


@app.get("/health")
def health():
    return {
        "status":          "ok",
        "log_viewer":      "/log/viewer",
        "current_session": session_log.get_session_id(),
    }


from session_log import LOCALHOST_HOSTS as _LOCALHOST_HOSTS
_PID_FILE = Path(__file__).parent / "memory" / ".starling.pid"


def _kill_pid(pid: int) -> None:
    """Kill a process and its entire child tree by PID, platform-appropriately."""
    try:
        if os.name == "nt":
            import subprocess as _sp
            # /T kills the full process tree so uvicorn --reload workers and
            # any llama-server child processes are also terminated.
            _sp.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)
        else:
            os.kill(pid, signal.SIGTERM)
    except Exception:
        pass


@app.post("/system/shutdown")
async def system_shutdown(request: Request):
    """Gracefully shut down the S.T.A.R.L.I.N.G. backend. Localhost only."""
    if request.client is None or request.client.host not in _LOCALHOST_HOSTS:
        raise HTTPException(status_code=403, detail="Forbidden")
    session_log.log_session_end()
    # TODO: trigger dream state here (feature-dream-state-shutdown-pipeline-1)

    # Read the PID file to find the reload manager and llama-server PIDs.
    # Killing only os.getpid() (the uvicorn worker) is not enough — the reload
    # manager parent process will immediately restart the worker.
    pids_to_kill: list[int] = []
    try:
        data = json.loads(_PID_FILE.read_text(encoding="utf-8"))
        # Kill llama first so the GPU is freed before the backend (this process)
        # is terminated — the backend kill uses /T which will kill the current
        # uvicorn worker, so anything after it in the list would never execute.
        for key in ("llama", "backend"):
            if data.get(key):
                pids_to_kill.append(int(data[key]))
    except Exception:
        pass

    # Fallback: at minimum kill the current process if PID file was unavailable
    if not pids_to_kill:
        pids_to_kill = [os.getpid()]

    def _do_kill() -> None:
        for pid in pids_to_kill:
            _kill_pid(pid)
        # Also clean up the PID file
        try:
            _PID_FILE.unlink(missing_ok=True)
        except Exception:
            pass

    loop = asyncio.get_running_loop()
    loop.call_later(0.5, _do_kill)
    return {"ok": True, "message": "Shutting down"}


# ── RAG endpoints ─────────────────────────────────────────────────────────────

@app.post("/rag/ingest")
async def rag_ingest(background_tasks: BackgroundTasks):
    """Trigger async document ingestion from memory/input/. Returns immediately."""
    background_tasks.add_task(_rag_ingest)
    return {"status": "ingesting", "folder": _RAG_INPUT_FOLDER}


@app.get("/rag/status")
async def rag_status():
    """Return RAG system status: enabled flag, chunk count, collection name."""
    return _rag_get_status()


@app.get("/rag/manifest")
def rag_manifest():
    """
    Serve assets/images/manifest.json as JSON.
    Falls back to an empty list if the file does not exist.
    """
    manifest_path = _ASSETS / "images" / "manifest.json"
    if not manifest_path.exists():
        return []
    try:
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return []


# ── Wikipedia RAG endpoints ───────────────────────────────────────────────────

class WikiSearchRequest(BaseModel):
    query: str

class WikiChatRequest(BaseModel):
    message: str
    history: list[dict]   # list of {"role": str, "content": str}

@app.post("/wiki/start")
async def wiki_start(req: WikiSearchRequest):
    """Find the best-matching Wikipedia article and start a Q&A session."""
    try:
        session = start_wikipedia_session(req.query)
        return session.to_status()
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Wiki session error: {exc}")


@app.get("/wiki/status")
async def wiki_status():
    """Return the Wikipedia index and current session status."""
    return get_wiki_status()


@app.post("/wiki/clear")
async def wiki_clear():
    """End the current Wikipedia session."""
    _wiki_clear_session()
    return {"cleared": True}


@app.post("/wiki/chat")
async def wiki_chat(req: WikiChatRequest):
    """
    Stream an article-scoped LLM response for the active Wikipedia session.
    Retrieves relevant article chunks, injects them into the system prompt,
    and forwards to the configured LLM backend (llama-server or Ollama).
    """
    session = _wiki_get_session()
    if session is None:
        raise HTTPException(
            status_code=400,
            detail="No active Wikipedia session. POST /wiki/start first.",
        )

    # Retrieve relevant article chunks for the current query
    excerpts    = _wiki_retrieve_chunks(req.message, top_k=4)
    system_prompt = build_wiki_system_prompt(excerpts)

    # Build message list: wiki system → conversation history → current user turn
    history_msgs = [
        {"role": h.get("role", "user"), "content": h["content"]}
        for h in req.history
        if h.get("role") in ("user", "assistant") and h.get("content")
    ]
    messages = [
        {"role": "system", "content": system_prompt},
        *history_msgs,
        {"role": "user", "content": req.message},
    ]

    if LLM_BACKEND == "llama":
        payload = {
            "model":       _WIKI_DEFAULT_MODEL,
            "messages":    messages,
            "temperature": _WIKI_TEMPERATURE,
            "stream":      True,
        }
    else:
        payload = {
            "model":    _WIKI_DEFAULT_MODEL,
            "messages": messages,
            "options":  {"temperature": _WIKI_TEMPERATURE},
            "stream":   True,
        }
    return StreamingResponse(_wiki_stream(payload), media_type="application/x-ndjson")




def _provider_is_gpu(providers: list) -> bool:
    """Return True if any of the active ONNX providers is GPU-accelerated."""
    return any(
        kw in p for p in providers
        for kw in ("CUDA", "TensorRT", "Dml", "ROCm")
    )


@app.get("/system-status")
async def system_status():
    # Whisper — device is resolved once at startup
    whisper_device = "GPU" if _stt._active_device == "cuda" else "CPU"

    # Kokoro — check actual ONNX session providers if model is loaded,
    # otherwise predict from what onnxruntime reports as available
    if _tts._kokoro is not None:
        active_providers = _tts._kokoro.sess.get_providers()
    else:
        active_providers = _tts._available

    kokoro_device = "GPU" if _provider_is_gpu(active_providers) else "CPU"

    # LLM backend status — behaviour differs by LLM_BACKEND selection
    llm_device = "UNKNOWN"
    llm_url = _LLM_BASE.removeprefix("http://").removeprefix("https://")
    if LLM_BACKEND == "llama":
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(f"{_LLM_BASE}/health")
                if resp.status_code == 200 and resp.json().get("status") == "ok":
                    llm_device = "GPU"
                else:
                    llm_device = "CPU"
        except Exception:
            llm_device = "OFFLINE"
    else:
        # Ollama — /api/ps returns running models; size_vram > 0 means GPU
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(f"{_LLM_BASE}/api/ps")
                if resp.status_code == 200:
                    models = resp.json().get("models", [])
                    if models:
                        size_vram = sum(m.get("size_vram", 0) for m in models)
                        llm_device = "GPU" if size_vram > 0 else "CPU"
                    else:
                        llm_device = "IDLE"
        except Exception:
            llm_device = "OFFLINE"

    return {
        "whisper":     whisper_device,
        "kokoro":      kokoro_device,
        "llm":         llm_device,
        "llm_backend": LLM_BACKEND,
        "llm_url":     llm_url,
    }


# ── Dossier endpoint ─────────────────────────────────────────────────────────

@app.get("/dossier/{key}")
def get_dossier(key: str):
    """Parse a dossier markdown file and return structured JSON."""
    # Sanitize key — only lowercase alphanumeric, underscores, hyphens allowed
    if not re.fullmatch(r'[a-z0-9_\-]+', key):
        raise HTTPException(status_code=400, detail="Invalid dossier key")
    path = _ASSETS / "dossier_descriptions" / f"{key}.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Dossier not found")

    lines = path.read_text(encoding="utf-8").splitlines()
    meta: dict = {}
    body = ""
    for i, line in enumerate(lines):
        if line.startswith("Description of target:"):
            body = "\n".join(lines[i + 1:]).strip()
            break
        m = re.match(r'^([^:]+):\s*(.+)$', line)
        if m:
            meta[m.group(1).strip()] = m.group(2).strip()

    title = meta.pop("Name", key.replace("_", " ").title())
    return {"title": title, "body": body, "meta": meta}


# ── Serve frontend ────────────────────────────────────────────────────────────

@app.get("/")
def serve_index():
    return FileResponse(
        _FRONTEND / "index.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )

app.mount("/assets", StaticFiles(directory=_ASSETS), name="assets")
app.mount("/", StaticFiles(directory=_FRONTEND), name="frontend")
