"""Pytest fixtures and path setup for the Starling test suite.

Adds `backend/` to sys.path so backend modules can be imported without
needing to install the project as a package.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent
_BACKEND   = _REPO_ROOT / "backend"

if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


@pytest.fixture
def tmp_text_file(tmp_path: Path) -> Path:
    """Provide a writable, non-existent path for atomic-write tests."""
    return tmp_path / "sample.txt"


@pytest.fixture
def tmp_json_file(tmp_path: Path) -> Path:
    return tmp_path / "sample.json"


@pytest.fixture(autouse=True)
def _isolate_cwd(monkeypatch, tmp_path):
    """Each test runs with cwd inside a fresh tmp dir to keep cache files
    from polluting the repo when modules write relative paths on import."""
    monkeypatch.chdir(tmp_path)
