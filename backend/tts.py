# backend/tts.py — Text-to-Speech via Kokoro TTS (kokoro-onnx v0.5)
# Model files (~300 MB total) are downloaded once by: python scripts/download_models.py
from __future__ import annotations

import asyncio
import io
import logging
import os
import re as _re
import site
from pathlib import Path

from gpu_init import register_nvidia_dll_dirs

# Register nvidia wheel DLL dirs before onnxruntime is imported so the CUDA EP
# can find cuDNN / cuBLAS / etc.; without this it silently falls back to CPU.
register_nvidia_dll_dirs()

import numpy as _np
import onnxruntime as _ort
import soundfile as sf
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, Response
from kokoro_onnx import Kokoro
from pydantic import BaseModel

import session_log

log = logging.getLogger(__name__)
router = APIRouter(prefix="/synthesize", tags=["tts"])

# ── Log active ONNX provider at import time so it shows in server startup output ─
_available = _ort.get_available_providers()
# Default to DmlExecutionProvider (DirectML/GPU) if available and env not overridden.
# kokoro-onnx only activates GPU automatically for onnxruntime-gpu; with
# onnxruntime-directml the ONNX_PROVIDER env var must be set explicitly.
_GPU_PROVIDERS = ("CUDAExecutionProvider", "TensorrtExecutionProvider",
                  "ROCMExecutionProvider", "DmlExecutionProvider")
_default_provider = next((p for p in _GPU_PROVIDERS if p in _available), None)
_onnx_provider = os.getenv("ONNX_PROVIDER", _default_provider)
if _onnx_provider:
    log.info("Kokoro ONNX provider: %s", _onnx_provider)
else:
    log.warning(
        "\u26a0  No GPU ONNX provider detected — Kokoro will run on CPU (slow). "
        "Available providers: %s. "
        "Fix: pip install --force-reinstall --no-deps onnxruntime-gpu",
        _available,
    )

# ── Model file paths ───────────────────────────────────────────────────────────
_MODEL_DIR   = Path(__file__).parent.parent / "models"
_ONNX_PATH   = _MODEL_DIR / "kokoro-v1.0.onnx"
_VOICES_PATH = _MODEL_DIR / "voices-v1.0.bin"

# ── Lazy singleton — loaded on first request ───────────────────────────────────
_kokoro: Kokoro | None = None


def _build_kokoro(provider: str | None) -> Kokoro:
    """Instantiate Kokoro, overriding ONNX_PROVIDER if needed."""
    if provider is not None:
        os.environ["ONNX_PROVIDER"] = provider
    elif "ONNX_PROVIDER" in os.environ:
        del os.environ["ONNX_PROVIDER"]
    k = Kokoro(str(_ONNX_PATH), str(_VOICES_PATH))
    log.info("Kokoro TTS ready — session providers: %s", k.sess.get_providers())
    return k


def _get_kokoro() -> Kokoro:
    global _kokoro
    if _kokoro is None:
        if not _ONNX_PATH.exists() or not _VOICES_PATH.exists():
            raise RuntimeError(
                "Kokoro model files not found in models/. "
                "Run: python scripts/download_models.py"
            )
        log.info("Loading Kokoro TTS model (first request)\u2026")
        _kokoro = _build_kokoro(_onnx_provider)
    return _kokoro


# ── Curated voice list (A/B grade English voices) ─────────────────────────────
VOICES = [
    # American English — Female
    {"id": "af_heart",    "label": "Heart (US ♀)",    "lang": "en-us"},
    {"id": "af_bella",    "label": "Bella (US ♀)",    "lang": "en-us"},
    {"id": "af_nicole",   "label": "Nicole (US ♀)",   "lang": "en-us"},
    {"id": "af_sarah",    "label": "Sarah (US ♀)",    "lang": "en-us"},
    {"id": "af_nova",     "label": "Nova (US ♀)",     "lang": "en-us"},
    {"id": "af_aoede",    "label": "Aoede (US ♀)",    "lang": "en-us"},
    # American English — Male
    {"id": "am_fenrir",   "label": "Fenrir (US ♂)",   "lang": "en-us"},
    {"id": "am_michael",  "label": "Michael (US ♂)",  "lang": "en-us"},
    {"id": "am_puck",     "label": "Puck (US ♂)",     "lang": "en-us"},
    {"id": "am_echo",     "label": "Echo (US ♂)",     "lang": "en-us"},
    # British English — Female
    {"id": "bf_emma",     "label": "Emma (GB ♀)",     "lang": "en-gb"},
    {"id": "bf_isabella", "label": "Isabella (GB ♀)", "lang": "en-gb"},
    {"id": "bf_alice",    "label": "Alice (GB ♀)",    "lang": "en-gb"},
    # British English — Male
    {"id": "bm_george",   "label": "George (GB ♂)",   "lang": "en-gb"},
    {"id": "bm_fable",    "label": "Fable (GB ♂)",    "lang": "en-gb"},
    {"id": "bm_daniel",   "label": "Daniel (GB ♂)",   "lang": "en-gb"},
]

_VOICE_MAP = {v["id"]: v for v in VOICES}


# ── Chunking helpers (Kokoro hard-caps at 510 phonemes per call) ──────────────
# English averages ~0.5 phonemes/char, so 500 chars ≈ 250 phonemes — safely under
# the limit even for phoneme-dense text.
_MAX_CHUNK_CHARS = 500


def _split_chunks(text: str) -> list[str]:
    """Split text at sentence boundaries so each chunk stays under Kokoro's limit."""
    sentences = _re.split(r'(?<=[.!?])\s+', text.strip())
    chunks: list[str] = []
    current = ''
    for sentence in sentences:
        if not sentence:
            continue
        candidate = f'{current} {sentence}'.strip() if current else sentence
        if len(candidate) <= _MAX_CHUNK_CHARS:
            current = candidate
        else:
            if current:
                chunks.append(current)
            if len(sentence) > _MAX_CHUNK_CHARS:
                # Single sentence still too long — split on clause punctuation then hard-cut
                parts = _re.split(r'(?<=[,;:])\s+', sentence)
                sub = ''
                for part in parts:
                    candidate2 = f'{sub} {part}'.strip() if sub else part
                    if len(candidate2) <= _MAX_CHUNK_CHARS:
                        sub = candidate2
                    else:
                        if sub:
                            chunks.append(sub)
                        # Hard cut as last resort
                        sub = part[:_MAX_CHUNK_CHARS]
                if sub:
                    chunks.append(sub)
                current = ''
            else:
                current = sentence
    if current:
        chunks.append(current)
    return chunks or [text[:_MAX_CHUNK_CHARS]]


def _synthesize_chunked(kk: Kokoro, text: str, voice: str, speed: float, lang: str):
    """Synthesize text with automatic chunking; returns (samples_array, sample_rate)."""
    chunks = _split_chunks(text)
    results = [kk.create(c, voice=voice, speed=speed, lang=lang) for c in chunks]
    if len(results) == 1:
        return results[0]
    return _np.concatenate([r[0] for r in results]), results[0][1]




@router.get("/voices")
def list_voices():
    """Return the list of available Kokoro voices."""
    return JSONResponse(content=VOICES)


class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0


@router.post("/")
async def synthesize(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be empty")
    if req.voice not in _VOICE_MAP:
        raise HTTPException(status_code=400, detail=f"Unknown voice '{req.voice}'")
    if not (0.25 <= req.speed <= 4.0):
        raise HTTPException(status_code=400, detail="speed must be 0.25–4.0")

    try:
        kokoro = _get_kokoro()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    try:
        lang = _VOICE_MAP[req.voice]["lang"]
        loop = asyncio.get_running_loop()
        chunks = _split_chunks(req.text)
        device = "cpu" if (_onnx_provider == "CPUExecutionProvider" or not _onnx_provider) else "gpu"
        _t0 = asyncio.get_running_loop().time()

        def _run_synthesis():
            return _synthesize_chunked(kokoro, req.text, req.voice, req.speed, lang)

        try:
            samples, sample_rate = await loop.run_in_executor(None, _run_synthesis)
        except Exception as gpu_exc:
            log.warning(
                "Kokoro GPU inference failed (%s) — using CPU for this request; "
                "GPU will be retried on the next request.",
                gpu_exc,
            )
            global _kokoro
            _kokoro = None  # reset so next request rebuilds with GPU
            _cpu_kokoro = _build_kokoro("CPUExecutionProvider")
            device = "cpu"

            def _run_synthesis_cpu():
                return _synthesize_chunked(_cpu_kokoro, req.text, req.voice, req.speed, lang)

            samples, sample_rate = await loop.run_in_executor(None, _run_synthesis_cpu)
        buf = io.BytesIO()
        sf.write(buf, samples, sample_rate, format="WAV")
        try:
            duration_ms = round((asyncio.get_running_loop().time() - _t0) * 1000)
            audio_s = round(len(samples) / sample_rate, 2) if sample_rate else None
            session_log.log("tts_synthesis", {
                "voice":       req.voice,
                "speed":       req.speed,
                "lang":        lang,
                "chunk_count": len(chunks),
                "char_count":  len(req.text),
                "audio_s":     audio_s,
                "duration_ms": duration_ms,
                "device":      device,
            })
        except Exception:
            pass  # best-effort: logging must never break synthesis
        return Response(content=buf.getvalue(), media_type="audio/wav")
    except Exception as exc:
        log.exception("TTS synthesis failed")
        raise HTTPException(status_code=500, detail=f"Synthesis error: {exc}")
