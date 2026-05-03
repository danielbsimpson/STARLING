"""backend/stt.py — Local Speech-to-Text via faster-whisper (CUDA)."""

import os
import tempfile
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException
from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/transcribe", tags=["stt"])

_WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "base")
_DEVICE = "cuda"
_COMPUTE_TYPE = "float16"

logger.info("Loading Whisper model '%s' on %s (%s)...", _WHISPER_MODEL_SIZE, _DEVICE, _COMPUTE_TYPE)
_model = WhisperModel(_WHISPER_MODEL_SIZE, device=_DEVICE, compute_type=_COMPUTE_TYPE)
logger.info("Whisper model ready.")

_ALLOWED_MIME_PREFIXES = ("audio/webm", "audio/wav", "audio/ogg", "audio/mp4", "video/webm")


@router.post("/")
async def transcribe(audio: UploadFile = File(...)):
    content_type = (audio.content_type or "").split(";")[0].strip()
    if not any(content_type.startswith(p) for p in _ALLOWED_MIME_PREFIXES):
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported audio type: {content_type}. Expected webm, wav, ogg, or mp4.",
        )

    # Persist to a temp file so faster-whisper (ffmpeg) can decode it
    suffix = ".webm" if "webm" in content_type else ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name

    try:
        segments, info = _model.transcribe(
            tmp_path,
            language="en",
            vad_filter=True,          # skip silent segments
            vad_parameters={"min_silence_duration_ms": 500},
        )
        transcript = " ".join(seg.text for seg in segments).strip()
        logger.info("Transcribed %.1fs of audio: %s", info.duration, transcript[:80])
    finally:
        os.remove(tmp_path)

    return {"transcript": transcript, "language": info.language, "duration": round(info.duration, 2)}
