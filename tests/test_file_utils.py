"""Regression tests for backend.file_utils."""

import json
from pathlib import Path

import pytest

from file_utils import atomic_write_json, atomic_write_text


def test_atomic_write_text_creates_file(tmp_text_file: Path):
    atomic_write_text(tmp_text_file, "hello world")
    assert tmp_text_file.read_text(encoding="utf-8") == "hello world"


def test_atomic_write_text_overwrites(tmp_text_file: Path):
    tmp_text_file.write_text("old")
    atomic_write_text(tmp_text_file, "new")
    assert tmp_text_file.read_text(encoding="utf-8") == "new"


def test_atomic_write_text_creates_parent_dirs(tmp_path: Path):
    nested = tmp_path / "a" / "b" / "c.txt"
    atomic_write_text(nested, "x")
    assert nested.read_text(encoding="utf-8") == "x"


def test_atomic_write_text_leaves_no_tmp(tmp_text_file: Path):
    atomic_write_text(tmp_text_file, "x")
    siblings = list(tmp_text_file.parent.iterdir())
    assert all(not s.name.endswith(".tmp") for s in siblings)


def test_atomic_write_json_roundtrip(tmp_json_file: Path):
    data = {"a": 1, "b": [1, 2, 3], "c": {"nested": True}}
    atomic_write_json(tmp_json_file, data)
    assert json.loads(tmp_json_file.read_text(encoding="utf-8")) == data


def test_atomic_write_json_preserves_unicode(tmp_json_file: Path):
    data = {"city": "São Paulo", "emoji": "🌟"}
    atomic_write_json(tmp_json_file, data)
    raw = tmp_json_file.read_text(encoding="utf-8")
    assert "São Paulo" in raw  # ensure_ascii=False
    assert "🌟" in raw
