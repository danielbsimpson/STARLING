"""backend/file_utils.py — Shared atomic file I/O helpers.

Replaces ad-hoc `_atomic_write` duplicates that previously lived in
dream.py, soul.py, stocks.py, and weather.py.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any


def atomic_write_text(path: Path, content: str) -> None:
    """Write text to `path` atomically via a unique temp file.

    A fixed `<name>.tmp` file is not safe under concurrent writers and can
    cause Windows `PermissionError` / partial-write races.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
        text=True,
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())

        # Transient file locks are common on Windows if another thread/process
        # has just opened the destination file. Retry briefly before failing.
        for attempt in range(6):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.03 * (attempt + 1))
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def atomic_write_json(path: Path, data: Any, *, indent: int = 2) -> None:
    """Serialise `data` as JSON and write atomically to `path`."""
    atomic_write_text(
        path,
        json.dumps(data, ensure_ascii=False, indent=indent),
    )


def load_json_cache(path: Path) -> dict:
    """Load a JSON object from `path`, returning {} on any read/parse error."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
