"""Regression tests for dream pipeline helpers."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

import dream


def test_iso_ts_is_iso_8601():
    ts = dream._iso_ts()
    # YYYY-MM-DDTHH:MM:SS+00:00
    assert "T" in ts
    assert ts.endswith("+00:00")


def test_timed_out_returns_false_when_under_budget(monkeypatch):
    monkeypatch.setattr(dream, "DREAM_TIMEOUT_S", 60)
    r = dream.DreamResult(session_id="s")
    assert dream._timed_out(time.monotonic(), "Pass 1", r) is False
    assert r.errors == []


def test_timed_out_returns_true_and_records(monkeypatch):
    monkeypatch.setattr(dream, "DREAM_TIMEOUT_S", 0)
    r = dream.DreamResult(session_id="s")
    # t_start in the past so elapsed > 0 > DREAM_TIMEOUT_S
    assert dream._timed_out(time.monotonic() - 1.0, "Pass 2", r) is True
    assert r.errors == ["Timed out before Pass 2"]


def test_write_error_notice_creates_file(tmp_path: Path):
    p = tmp_path / "err.md"
    dream._write_error_notice(p, "summary", "boom")
    text = p.read_text(encoding="utf-8")
    assert "ERROR" in text
    assert "boom" in text


def test_dream_result_defaults():
    r = dream.DreamResult(session_id="abc")
    assert r.session_id == "abc"
    assert r.errors == []
    assert r.completed_passes == []
    assert r.summary_path is None
