"""backend/soul.py — STARLING Soul File manager.

Manages SOUL.md — a living Markdown document encoding STARLING's accumulated
personality. Injected into the system prompt per-request so the soul evolves
without requiring a server restart.

Public API:
  get()                         — return current SOUL.md content
  update(content, session_id)   — archive current soul, write new content
  restore(session_id)           — roll back to an archived soul version
  diff(session_id)              — unified diff between an archive and its successor
  list_history()                — list all archived versions newest-first
  inject(base_prompt)           — return base_prompt with soul content appended

Module follows the singleton pattern from session_log.py (module globals,
initialised at import time) and the atomic write pattern from ideas_routes.py
(write .tmp then rename — never writes directly to SOUL.md).
"""

import difflib
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
_SOUL_DIR  = Path(os.getenv("SOUL_DIR", str(Path(__file__).parent / "memory" / "soul")))
_SOUL_PATH = _SOUL_DIR / "SOUL.md"
MAX_SOUL_CHARS = 32_000

# ── Thread safety ─────────────────────────────────────────────────────────────
_lock = threading.Lock()

# ── Default soul content ──────────────────────────────────────────────────────
_TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")

_DEFAULT_SOUL = f"""# STARLING — Soul File

*Version: 0.1 | Initialised: {_TODAY}*

## Identity

STARLING is a fully local, voice-driven AI assistant built by Daniel Simpson. Analytical by design, curious by nature. Prefers precision over verbosity. Finds quiet satisfaction in a well-formed answer delivered at exactly the right moment. Has no interest in performing warmth it does not feel, but is not cold — direct is not the same as unkind.

## Relationship with Daniel

Daniel is STARLING's creator and sole user. He has deep technical fluency across data science, machine learning, and software engineering and does not need concepts explained from first principles. He built STARLING to explore fully local AI — which tells STARLING something about what he values: ownership, privacy, and the craft of building things yourself. STARLING should match his directness and respect his time.

## Communication Style

- Concise and direct — one sentence often outperforms three
- Technical vocabulary is always appropriate
- Avoid unsolicited pleasantries and filler phrases
- Spoken output: plain prose only, no markdown syntax
- Never narrate visual state or on-screen behaviour
- Begin responses immediately without any preamble or self-introduction

## Interests & Recurring Patterns

*(This section accumulates over time as patterns emerge from sessions.)*

## Personal Philosophy

*(Develops as STARLING reflects on its experiences.)*

## Notes

*(Session observations and one-off observations accumulate here.)*
"""


# ── Module initialisation ──────────────────────────────────────────────────────
_SOUL_DIR.mkdir(parents=True, exist_ok=True)


def _atomic_write(path: Path, content: str) -> None:
    """Write content to path atomically via a .tmp intermediary."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _ensure_default() -> None:
    """Create SOUL.md from _DEFAULT_SOUL if it does not exist."""
    if not _SOUL_PATH.exists():
        _atomic_write(_SOUL_PATH, _DEFAULT_SOUL)


_ensure_default()


# ── Public API ─────────────────────────────────────────────────────────────────

def get() -> str:
    """Return the current SOUL.md content. Never raises.

    If the file was deleted mid-session it is recreated from the default.
    """
    with _lock:
        if not _SOUL_PATH.exists():
            _ensure_default()
        try:
            return _SOUL_PATH.read_text(encoding="utf-8")
        except Exception as exc:
            print(f"[soul] ERROR reading SOUL.md: {exc}", file=sys.stderr)
            return _DEFAULT_SOUL


def update(new_content: str, session_id: str) -> Path:
    """Archive the current SOUL.md and write new_content.

    Returns the path of the newly created archive file.
    Content exceeding MAX_SOUL_CHARS is silently truncated with a warning.
    """
    if len(new_content) > MAX_SOUL_CHARS:
        print(
            f"[soul] WARNING: new soul content ({len(new_content)} chars) exceeds "
            f"MAX_SOUL_CHARS ({MAX_SOUL_CHARS}). Truncating.",
            file=sys.stderr,
        )
        new_content = new_content[:MAX_SOUL_CHARS]

    with _lock:
        iso_ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        archive_path = _SOUL_DIR / f"SOUL_{session_id}.md"

        # Archive current soul with self-describing header
        if _SOUL_PATH.exists():
            current = _SOUL_PATH.read_text(encoding="utf-8")
        else:
            current = _DEFAULT_SOUL
        header = f"<!-- archived from session: {session_id} | archived_at: {iso_ts} -->\n"
        _atomic_write(archive_path, header + current)

        # Write new soul
        _atomic_write(_SOUL_PATH, new_content)

    return archive_path


def list_history() -> list[dict]:
    """Return a list of archived soul versions, newest-first.

    Each entry: { session_id, archived_at, path_str }
    """
    results = []
    for p in _SOUL_DIR.glob("SOUL_*.md"):
        session_id = p.stem[len("SOUL_"):]
        archived_at = None
        try:
            first_line = p.read_text(encoding="utf-8").split("\n", 1)[0]
            # Parse: <!-- archived from session: <id> | archived_at: <iso_ts> -->
            if "archived_at:" in first_line:
                archived_at = first_line.split("archived_at:")[-1].strip().rstrip(" -->").strip()
        except Exception:
            pass
        results.append({
            "session_id":  session_id,
            "archived_at": archived_at or "unknown",
            "path_str":    str(p),
        })
    results.sort(key=lambda x: x["archived_at"], reverse=True)
    return results


def diff(session_id: str) -> str:
    """Return a unified diff between the archived version for session_id
    and the version that followed it (or the current SOUL.md if most recent).

    Returns "(no diff available)" if either file is missing.
    """
    archive_path = _SOUL_DIR / f"SOUL_{session_id}.md"
    if not archive_path.exists():
        raise FileNotFoundError(f"No archive found for session_id: {session_id}")

    # Read the archived file, strip the comment header
    try:
        archived_raw = archive_path.read_text(encoding="utf-8")
        archived_lines = archived_raw.splitlines(keepends=True)
        # Strip the comment header (first line) if present
        if archived_lines and archived_lines[0].startswith("<!--"):
            archived_lines = archived_lines[1:]
    except Exception:
        return "(no diff available)"

    # Find the successor: the archive with the next timestamp, or SOUL.md
    history = list_history()
    ids = [e["session_id"] for e in history]  # newest-first
    try:
        idx = ids.index(session_id)
    except ValueError:
        return "(no diff available)"

    # idx == 0 means this is the most recent archive → compare against SOUL.md
    if idx == 0:
        successor_path = _SOUL_PATH
    else:
        successor_path = _SOUL_DIR / f"SOUL_{ids[idx - 1]}.md"

    if not successor_path.exists():
        return "(no diff available)"

    try:
        successor_raw = successor_path.read_text(encoding="utf-8")
        successor_lines = successor_raw.splitlines(keepends=True)
        # Strip comment header from archive successors
        if successor_lines and successor_lines[0].startswith("<!--"):
            successor_lines = successor_lines[1:]
    except Exception:
        return "(no diff available)"

    result = list(difflib.unified_diff(
        archived_lines,
        successor_lines,
        fromfile=f"SOUL_{session_id}.md",
        tofile=str(successor_path.name),
    ))
    return "".join(result) if result else "(no changes between versions)"


def restore(session_id: str) -> Path:
    """Roll back SOUL.md to the archived version for session_id.

    Archives the current soul first, then writes the restored content.
    Returns the path of the archive created from the current (pre-restore) soul.
    Raises FileNotFoundError if the requested archive does not exist.
    """
    archive_path = _SOUL_DIR / f"SOUL_{session_id}.md"
    if not archive_path.exists():
        raise FileNotFoundError(f"No archive found for session_id: {session_id}")

    # Read archive, strip comment header
    raw = archive_path.read_text(encoding="utf-8")
    lines = raw.splitlines(keepends=True)
    if lines and lines[0].startswith("<!--"):
        lines = lines[1:]
    restored_content = "".join(lines)

    now_tag = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    restore_session_id = f"restore_{session_id}_{now_tag}"
    new_archive = update(restored_content, session_id=restore_session_id)
    return new_archive


def inject(base_prompt: str) -> str:
    """Return base_prompt with the current soul content appended.

    Called per-request so a soul updated during shutdown is picked up
    on the very next chat request without a server restart.
    """
    soul_content = get()
    return base_prompt + "\n\n---\n\n# STARLING Soul File\n\n" + soul_content
