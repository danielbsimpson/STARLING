"""backend/file_utils.py — Shared atomic file I/O helpers.

Replaces ad-hoc `_atomic_write` duplicates that previously lived in
dream.py, soul.py, stocks.py, and weather.py.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def atomic_write_text(path: Path, content: str) -> None:
    """Write text to `path` atomically via a `.tmp` intermediary."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp") if path.suffix else path.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


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
