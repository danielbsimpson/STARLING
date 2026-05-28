"""Syntax-level smoke check for frontend ES modules.

Runs `node --check` on every `frontend/*.js` to catch typos and
broken imports during refactors. Skipped automatically if Node.js is
not installed on the test host.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


def _frontend_modules() -> list[Path]:
    return sorted(p for p in _FRONTEND_DIR.glob("*.js") if p.is_file())


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
@pytest.mark.parametrize("module_path", _frontend_modules(),
                         ids=lambda p: p.name)
def test_frontend_module_parses(module_path: Path):
    result = subprocess.run(
        ["node", "--check", str(module_path)],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, (
        f"Syntax error in {module_path.name}:\n{result.stderr}"
    )
