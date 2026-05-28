"""backend/dream.py — Dream state pipeline: session analysis at shutdown / sleep.

Runs four sequential LLM passes over the session transcript:
  Pass 1 — Summarizer:       structured session summary → memory/dream/{id}_summary.md
  Pass 2 — Fact Extractor:   user & world facts         → memory/input/facts_{id}.md (RAG input)
  Pass 3 — Reflection:       first-person journal entry → memory/dream/thoughts.md (append)
  Pass 4 — Soul Evolution:   updated SOUL.md            → via soul.update()

Public API:
  run_dream_state(session_id, from_ts=None) -> DreamResult
  build_transcript(log_path, from_ts=None)  -> str
  read_checkpoint()                          -> Optional[str]
  DREAM_DIR, DREAM_TIMEOUT_S                 — constants for other modules

Constraints:
  - No asyncio / async — runs synchronously during shutdown
  - No new third-party packages — uses httpx (already in requirements.txt)
  - Thread-safe: _lock prevents concurrent dream runs
  - Atomic writes: tmp → rename pattern throughout

Sleep mode compatibility:
  - build_transcript() accepts from_ts to skip already-processed events
  - run_dream_state() accepts from_ts and writes a checkpoint after success
  - read_checkpoint() returns the last checkpoint for the current session
"""

import json
import os
import time
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

# ── Config ────────────────────────────────────────────────────────────────────
_BASE            = Path(__file__).parent
DREAM_DIR        = Path(os.getenv("DREAM_OUTPUT_DIR",  str(_BASE / "memory" / "dream")))
_RAG_INPUT_DIR   = Path(os.getenv("RAG_INPUT_FOLDER",  str(_BASE / "memory" / "input")))
DREAM_TIMEOUT_S  = int(os.getenv("DREAM_TIMEOUT_S",    "300"))
PASS_TIMEOUT_S   = int(os.getenv("DREAM_PASS_TIMEOUT_S", "90"))
DREAM_MODEL      = os.getenv("DREAM_MODEL", "")
LLM_BACKEND      = os.getenv("LLM_BACKEND", "ollama").lower()
OLLAMA_BASE      = os.getenv("OLLAMA_BASE_URL",    "http://localhost:11434")
OLLAMA_MODEL     = os.getenv("OLLAMA_MODEL",       "llama3.2:3b")
LLAMA_BASE       = os.getenv("LLAMA_SERVER_URL",   "http://localhost:8080")
LLAMA_MODEL      = os.getenv("LLAMA_MODEL",        "llama3.1-8b")

# Computed soul path — mirrors soul.py so no cross-import needed
_SOUL_PATH = Path(os.getenv("SOUL_DIR", str(_BASE / "memory" / "soul"))) / "SOUL.md"

CHECKPOINT_PATH = DREAM_DIR / "checkpoint.json"

# Ensure runtime directories exist
DREAM_DIR.mkdir(parents=True, exist_ok=True)
_RAG_INPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Thread safety ─────────────────────────────────────────────────────────────
_lock    = threading.Lock()
_running = False


# ── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class DreamResult:
    session_id:       str
    completed_passes: list[str]       = field(default_factory=list)
    summary_path:     Optional[Path]  = None
    facts_path:       Optional[Path]  = None
    thoughts_path:    Optional[Path]  = None
    soul_path:        Optional[Path]  = None
    duration_s:       float           = 0.0
    errors:           list[str]       = field(default_factory=list)
    memory_ingested:  int             = 0


# ── Helpers ───────────────────────────────────────────────────────────────────

def _effective_model() -> str:
    if DREAM_MODEL:
        return DREAM_MODEL
    return OLLAMA_MODEL if LLM_BACKEND == "ollama" else LLAMA_MODEL


def _iso_ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


from file_utils import atomic_write_text as _atomic_write_text


def _atomic_write(path: Path, content: str) -> None:
    _atomic_write_text(path, content)


# ── LLM call ─────────────────────────────────────────────────────────────────

def _call_llm(system_prompt: str, user_content: str, timeout: int) -> str:
    """Synchronous (non-streaming) LLM call. Raises RuntimeError on failure."""
    model = _effective_model()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user",   "content": user_content},
    ]
    try:
        with httpx.Client(timeout=timeout) as client:
            if LLM_BACKEND == "ollama":
                resp = client.post(
                    f"{OLLAMA_BASE}/api/chat",
                    json={"model": model, "messages": messages, "stream": False},
                )
                resp.raise_for_status()
                return resp.json()["message"]["content"]
            else:
                resp = client.post(
                    f"{LLAMA_BASE}/v1/chat/completions",
                    json={"model": model, "messages": messages, "stream": False, "temperature": 0.7},
                )
                resp.raise_for_status()
                return resp.json()["choices"][0]["message"]["content"]
    except Exception as exc:
        raise RuntimeError(f"LLM call failed: {exc}") from exc


# ── Transcript reconstruction ─────────────────────────────────────────────────

def build_transcript(log_path: Path, from_ts: Optional[str] = None) -> str:
    """Build a human-readable transcript from a JSONL session log.

    from_ts: optional ISO 8601 UTC string; events with ts < from_ts are skipped.
    This supports the sleep-mode checkpoint pattern (feature-sleep-mode-1.md).

    Returns an empty string if the file does not exist or has no eligible events.
    """
    lines: list[str] = []
    try:
        with open(log_path, encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    record = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                ts    = record.get("ts", "")
                event = record.get("event", "")
                data  = record.get("data", {})

                # Sleep-mode checkpoint filter
                if from_ts and ts < from_ts:
                    continue

                short_ts = ts[:19] if len(ts) >= 19 else ts

                if event == "user_speech":
                    lines.append(f"[{short_ts}] User (voice): {data.get('transcript', '')}")
                elif event == "user_text":
                    lines.append(f"[{short_ts}] User (text): {data.get('text', '')}")
                elif event == "tool_dispatch":
                    lines.append(
                        f"[{short_ts}] → Tool dispatched: {data.get('tool', '')} "
                        f"(triggered by: \"{data.get('trigger_phrase', '')}\")"
                    )
                elif event == "tool_result":
                    lines.append(
                        f"[{short_ts}] ← Tool result: {data.get('endpoint', '')} "
                        f"— {data.get('result_summary', '')}"
                    )
                elif event == "llm_response":
                    lines.append(f"[{short_ts}] Assistant: {data.get('full_text', '')}")
                elif event == "error":
                    lines.append(
                        f"[{short_ts}] ⚠ Error ({data.get('source', '')}): "
                        f"{data.get('message', '')}"
                    )
                # Skipped: session_start, session_end, tool_call, llm_request, user_speech_frontend

    except FileNotFoundError:
        return ""

    if not lines:
        return ""

    transcript = "\n".join(lines)

    # Truncate to last 12,000 words to stay within LLM context windows
    words = transcript.split()
    if len(words) > 12_000:
        transcript = (
            "[TRANSCRIPT TRUNCATED — showing final 12,000 words of session]\n\n"
            + " ".join(words[-12_000:])
        )

    return transcript


# ── Error / timeout notice writers ───────────────────────────────────────────

def _write_error_notice(path: Path, pass_name: str, error: str) -> None:
    iso = _iso_ts()
    content = (
        f"<!-- ERROR: Pass {pass_name} failed — {error} | {iso} -->\n\n"
        f"> Dream state pass '{pass_name}' did not complete: {error}"
    )
    _atomic_write(path, content)


def _append_timeout_notice(session_id: str) -> None:
    iso = _iso_ts()
    date_heading = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    path = DREAM_DIR / "thoughts.md"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(
            f"\n\n---\n\n## {date_heading} — Session {session_id} [TIMEOUT]\n\n"
            f"> Dream state timed out at {iso}. Not all passes completed.\n"
        )


def _timed_out(t_start: float, pass_name: str, result: "DreamResult") -> bool:
    """Record a timeout error on `result` and return True if the budget is spent."""
    if time.monotonic() - t_start > DREAM_TIMEOUT_S:
        result.errors.append(f"Timed out before {pass_name}")
        return True
    return False


# ── Pass 1: Session Summary ───────────────────────────────────────────────────

def _run_pass1_summary(transcript: str, session_id: str, model: str) -> Path:
    import prompts as _prompts
    result_text = _call_llm(_prompts.get("DREAM_SUMMARIZER"), transcript, PASS_TIMEOUT_S)
    header = (
        f"<!-- session: {session_id} | pass: 1-summary | model: {model} "
        f"| generated: {_iso_ts()} -->\n\n"
    )
    path = DREAM_DIR / f"{session_id}_summary.md"
    _atomic_write(path, header + result_text)
    return path


# ── Pass 2: Fact Extraction ───────────────────────────────────────────────────

def _run_pass2_facts(transcript: str, session_id: str, model: str) -> Path:
    import prompts as _prompts
    result_text = _call_llm(_prompts.get("DREAM_FACT_EXTRACTOR"), transcript, PASS_TIMEOUT_S)
    header = (
        f"<!-- session: {session_id} | pass: 2-facts | model: {model} "
        f"| generated: {_iso_ts()} -->\n\n"
    )
    path = _RAG_INPUT_DIR / f"facts_{session_id}.md"
    _atomic_write(path, header + result_text)
    return path


# ── Pass 3: Reflection ────────────────────────────────────────────────────────

def _run_pass3_reflection(
    summary_text: str, facts_text: str, session_id: str, model: str
) -> tuple[Path, str]:
    """Returns (thoughts_path, raw reflection text) for use by Pass 4."""
    import prompts as _prompts
    import soul as _soul
    system_prompt = _soul.inject(_prompts.get("DREAM_REFLECTION"))
    user_content  = f"## Session Summary\n\n{summary_text}\n\n## Extracted Facts\n\n{facts_text}"
    reflection_text = _call_llm(system_prompt, user_content, PASS_TIMEOUT_S)
    date_heading  = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    path = DREAM_DIR / "thoughts.md"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"\n\n---\n\n## {date_heading} — Session {session_id}\n\n{reflection_text}\n")
    return path, reflection_text


# ── Pass 4: Soul Evolution ────────────────────────────────────────────────────

def _run_pass4_soul_evolution(
    reflection_text: str, facts_text: str, session_id: str, model: str
) -> Path:
    """Generate an updated SOUL.md and write it via soul.update()."""
    import prompts as _prompts
    import soul as _soul
    current_soul  = _soul.get()
    system_prompt = _prompts.get("DREAM_SOUL_EVOLUTION")
    user_content  = (
        f"## Current SOUL.md\n\n{current_soul}\n\n"
        f"## Session Reflection\n\n"
        f"{reflection_text if reflection_text else '(No reflection available)'}\n\n"
        f"## Extracted Facts\n\n"
        f"{facts_text if facts_text else '(No facts available)'}"
    )
    new_soul = _call_llm(system_prompt, user_content, PASS_TIMEOUT_S)
    stripped = new_soul.strip()

    # Validate — must be substantive and contain section headers
    if len(stripped) < 200 or "##" not in stripped:
        raise RuntimeError(
            f"Soul evolution output appears invalid "
            f"(len={len(stripped)}, missing ## headers) — soul not updated"
        )

    _soul.update(stripped, session_id)
    return _SOUL_PATH


# ── Checkpoint ────────────────────────────────────────────────────────────────

def _write_checkpoint(session_id: str) -> None:
    content = json.dumps({
        "session_id":    session_id,
        "last_dream_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
    })
    _atomic_write(CHECKPOINT_PATH, content)


def read_checkpoint() -> Optional[str]:
    """Return last_dream_at for the current session, or None if unavailable.

    Returns None if the checkpoint belongs to a different session (i.e. a prior
    session's dream ran and the current session has no checkpoint yet).
    """
    import session_log as _session_log
    try:
        data = json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8"))
        if data.get("session_id") == _session_log.get_session_id():
            return data.get("last_dream_at")
    except Exception:
        pass  # best-effort: missing checkpoint or wrong session → return None
    return None


# ── Main pipeline ─────────────────────────────────────────────────────────────

def run_dream_state(session_id: str, from_ts: Optional[str] = None) -> DreamResult:
    """Run the full four-pass dream state pipeline. Synchronous. Thread-safe.

    from_ts: optional ISO 8601 UTC timestamp — only session events at or after
    this time are included in the transcript (sleep-mode checkpoint support).
    """
    global _running
    with _lock:
        if _running:
            result = DreamResult(session_id=session_id)
            result.errors.append("Dream state is already running")
            return result
        _running = True

    try:
        return _run_pipeline(session_id, from_ts)
    finally:
        with _lock:
            _running = False


def _run_pipeline(session_id: str, from_ts: Optional[str] = None) -> DreamResult:
    import session_log as _session_log

    result  = DreamResult(session_id=session_id)
    t_start = time.monotonic()
    model   = _effective_model()

    # Locate session log
    log_path = _session_log.LOG_DIR / f"{session_id}.jsonl"
    if not log_path.exists():
        result.errors.append(f"Session log not found: {log_path}")
        return result

    # Build transcript — empty means nothing to process
    transcript = build_transcript(log_path, from_ts)
    if not transcript:
        return result

    # ── Pass 1: Summary ───────────────────────────────────────────────────────
    if _timed_out(t_start, "Pass 1", result):
        return result

    summary_text = ""
    try:
        result.summary_path = _run_pass1_summary(transcript, session_id, model)
        summary_text = result.summary_path.read_text(encoding="utf-8")
        result.completed_passes.append("summary")
    except Exception as exc:
        err_msg = str(exc)
        result.errors.append(f"Pass 1 (summary) failed: {err_msg}")
        err_path = DREAM_DIR / f"{session_id}_summary.md"
        _write_error_notice(err_path, "summary", err_msg)
        result.summary_path = err_path
        summary_text = err_path.read_text(encoding="utf-8")

    # ── Pass 2: Facts ─────────────────────────────────────────────────────────
    if _timed_out(t_start, "Pass 2", result):
        _append_timeout_notice(session_id)
        return result

    facts_text = ""
    try:
        result.facts_path = _run_pass2_facts(transcript, session_id, model)
        facts_text = result.facts_path.read_text(encoding="utf-8")
        result.completed_passes.append("facts")
        try:
            from rag import ingest_facts as _ingest_facts
            result.memory_ingested = _ingest_facts(result.facts_path, session_id)
        except Exception as _exc:
            result.errors.append(f"Memory ingest failed: {_exc}")
    except Exception as exc:
        err_msg = str(exc)
        result.errors.append(f"Pass 2 (facts) failed: {err_msg}")
        err_path = _RAG_INPUT_DIR / f"facts_{session_id}.md"
        _write_error_notice(err_path, "facts", err_msg)
        result.facts_path = err_path
        facts_text = err_path.read_text(encoding="utf-8")

    # ── Pass 3: Reflection ────────────────────────────────────────────────────
    if _timed_out(t_start, "Pass 3", result):
        _append_timeout_notice(session_id)
        return result

    reflection_text = ""
    try:
        result.thoughts_path, reflection_text = _run_pass3_reflection(
            summary_text, facts_text, session_id, model
        )
        result.completed_passes.append("reflection")
    except Exception as exc:
        err_msg = str(exc)
        result.errors.append(f"Pass 3 (reflection) failed: {err_msg}")
        reflection_text = ""

    # ── Pass 4: Soul Evolution ────────────────────────────────────────────────
    if _timed_out(t_start, "Pass 4", result):
        return result

    try:
        result.soul_path = _run_pass4_soul_evolution(
            reflection_text, facts_text, session_id, model
        )
        result.completed_passes.append("soul_evolution")
    except Exception as exc:
        result.errors.append(f"Pass 4 (soul evolution) failed: {exc}")

    # ── Checkpoint ────────────────────────────────────────────────────────────
    # Only write checkpoint if at least one pass produced useful output
    if result.completed_passes:
        try:
            _write_checkpoint(session_id)
        except Exception as exc:
            result.errors.append(f"Checkpoint write failed: {exc}")

    result.duration_s = round(time.monotonic() - t_start, 2)
    return result
