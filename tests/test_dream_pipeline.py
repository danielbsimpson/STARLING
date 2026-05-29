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
    assert r.skipped is False
    assert r.skip_reason is None


def _write_log(tmp_path: Path, events: list[dict]) -> Path:
    """Write a minimal JSONL session log and return its path."""
    import json
    p = tmp_path / "session.jsonl"
    with p.open("w", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev) + "\n")
    return p


def test_count_session_signals_tallies_by_event_type(tmp_path: Path):
    log = _write_log(tmp_path, [
        {"ts": "2026-05-29T10:00:00", "event": "session_start", "data": {}},
        {"ts": "2026-05-29T10:00:01", "event": "user_text",    "data": {"text": "hi"}},
        {"ts": "2026-05-29T10:00:02", "event": "llm_response", "data": {"full_text": "hello"}},
        {"ts": "2026-05-29T10:00:03", "event": "user_speech",  "data": {"transcript": "weather"}},
        {"ts": "2026-05-29T10:00:04", "event": "tool_dispatch","data": {"tool": "weather"}},
        {"ts": "2026-05-29T10:00:05", "event": "tool_result",  "data": {}},
    ])
    s = dream.count_session_signals(log)
    assert s["user_turns"] == 2
    assert s["assistant_turns"] == 1
    assert s["tool_dispatches"] == 1
    assert s["exchanges"] == 4


def test_count_session_signals_respects_from_ts(tmp_path: Path):
    log = _write_log(tmp_path, [
        {"ts": "2026-05-29T09:00:00", "event": "user_text",    "data": {"text": "old"}},
        {"ts": "2026-05-29T11:00:00", "event": "user_text",    "data": {"text": "new"}},
        {"ts": "2026-05-29T11:00:01", "event": "llm_response", "data": {"full_text": "ok"}},
    ])
    s = dream.count_session_signals(log, from_ts="2026-05-29T10:00:00")
    assert s["user_turns"] == 1
    assert s["exchanges"] == 2


def test_count_session_signals_missing_file_returns_zeros(tmp_path: Path):
    s = dream.count_session_signals(tmp_path / "nope.jsonl")
    assert s == {
        "user_turns": 0, "assistant_turns": 0,
        "tool_dispatches": 0, "exchanges": 0,
    }


def test_is_session_substantial_rejects_trivial_session(monkeypatch):
    monkeypatch.setattr(dream, "DREAM_MIN_USER_TURNS", 3)
    monkeypatch.setattr(dream, "DREAM_MIN_EXCHANGES", 6)
    # Boot → single tool → shutdown: one user turn, two exchanges.
    trivial = {"user_turns": 1, "assistant_turns": 0, "tool_dispatches": 1, "exchanges": 2}
    assert dream.is_session_substantial(trivial) is False
    # No interaction at all.
    assert dream.is_session_substantial(
        {"user_turns": 0, "assistant_turns": 0, "tool_dispatches": 0, "exchanges": 0}
    ) is False


def test_is_session_substantial_accepts_robust_session(monkeypatch):
    monkeypatch.setattr(dream, "DREAM_MIN_USER_TURNS", 3)
    monkeypatch.setattr(dream, "DREAM_MIN_EXCHANGES", 6)
    robust = {"user_turns": 4, "assistant_turns": 4, "tool_dispatches": 2, "exchanges": 10}
    assert dream.is_session_substantial(robust) is True


def test_is_session_substantial_requires_both_thresholds(monkeypatch):
    monkeypatch.setattr(dream, "DREAM_MIN_USER_TURNS", 3)
    monkeypatch.setattr(dream, "DREAM_MIN_EXCHANGES", 6)
    # Enough exchanges but too few distinct user turns (e.g. one long tool chain).
    assert dream.is_session_substantial(
        {"user_turns": 2, "assistant_turns": 3, "tool_dispatches": 3, "exchanges": 8}
    ) is False
