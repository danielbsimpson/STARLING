"""backend/stt.py — Local Speech-to-Text via faster-whisper."""

import os
import tempfile
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException
from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/transcribe", tags=["stt"])

_WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "base")
_DEVICE = os.getenv("WHISPER_DEVICE", "cuda")

# Holds the active model; may be replaced at runtime if CUDA fails during inference.
_model: WhisperModel | None = None
_active_device: str = _DEVICE


def _build_model(device: str) -> WhisperModel:
    compute_type = "float16" if device == "cuda" else "int8"
    logger.info("Loading Whisper '%s' on %s (%s)...", _WHISPER_MODEL_SIZE, device, compute_type)
    return WhisperModel(_WHISPER_MODEL_SIZE, device=device, compute_type=compute_type)


def _get_model() -> WhisperModel:
    global _model, _active_device
    if _model is None:
        _model = _build_model(_active_device)
        logger.info("Whisper model ready on %s.", _active_device)
    return _model


def _run_transcribe(model: WhisperModel, path: str):
    """Eagerly consume the lazy generator so any CUDA errors surface here."""
    segments, info = model.transcribe(
        path,
        language="en",
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    # Materialise the generator — this is where GPU encode actually happens.
    transcript = " ".join(seg.text for seg in segments).strip()
    return transcript, info


_ALLOWED_MIME_PREFIXES = ("audio/webm", "audio/wav", "audio/ogg", "audio/mp4", "video/webm")


@router.post("/")
async def transcribe(audio: UploadFile = File(...)):
    global _model, _active_device

    content_type = (audio.content_type or "").split(";")[0].strip()
    if not any(content_type.startswith(p) for p in _ALLOWED_MIME_PREFIXES):
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported audio type: {content_type}. Expected webm, wav, ogg, or mp4.",
        )

    suffix = ".webm" if "webm" in content_type else ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name

    try:
        try:
            transcript, info = _run_transcribe(_get_model(), tmp_path)
        except RuntimeError as exc:
            if _active_device == "cpu":
                raise
            # CUDA libs (e.g. cublas64_12.dll) unavailable at encode time — fall back to CPU.
            logger.warning("CUDA inference failed (%s). Switching Whisper to CPU/int8 permanently.", exc)
            _model = _build_model("cpu")
            _active_device = "cpu"
            transcript, info = _run_transcribe(_model, tmp_path)

        logger.info("Transcribed %.1fs: %s", info.duration, transcript[:80])
    finally:
        os.remove(tmp_path)

    return {"transcript": transcript, "language": info.language, "duration": round(info.duration, 2)}
