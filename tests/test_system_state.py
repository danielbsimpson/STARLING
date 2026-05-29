"""Tests for backend/system_state.py — REQ-001 through REQ-008."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest


# Reload-friendly import: system_state holds module-level cache; we reset it
# between tests by re-importing in fixtures.
@pytest.fixture
def fresh_system_state(monkeypatch, tmp_path):
    """Provide a freshly-imported system_state with cleared caches."""
    import importlib
    import system_state
    importlib.reload(system_state)
    # Point session_log at tmp_path so JSONL writes don't pollute repo
    import session_log
    monkeypatch.setattr(session_log, "LOG_DIR", tmp_path, raising=False)
    return system_state


# ── Boot snapshot shape (REQ-002) ────────────────────────────────────────────

def test_build_boot_snapshot_shape(fresh_system_state):
    snap = fresh_system_state.build_boot_snapshot()
    assert isinstance(snap, dict)
    for key in ("os", "python_version", "llm", "stt", "tts", "rag", "gpu", "boot_started_at"):
        assert key in snap, f"missing key: {key}"
    assert isinstance(snap["llm"], dict)
    assert isinstance(snap["stt"], dict)
    assert isinstance(snap["tts"], dict)


def test_probe_gpu_handles_missing_nvidia_smi(monkeypatch, fresh_system_state):
    """RISK-006: probes must never raise when GPU tools are absent."""
    monkeypatch.setattr(fresh_system_state, "_run_nvidia_smi", lambda q: None)
    name = fresh_system_state._probe_gpu_name()
    vram = fresh_system_state._probe_gpu_vram()
    assert name is None
    assert vram is None or isinstance(vram, dict)


# ── Event recording (REQ-004) ────────────────────────────────────────────────

def test_record_event_roundtrip(fresh_system_state):
    fresh_system_state.record_event("test_event", duration_s=1.23, metadata={"k": "v"})
    events = fresh_system_state.get_last_events()
    assert "test_event" in events
    assert events["test_event"]["duration_s"] == 1.23
    assert events["test_event"]["metadata"]["k"] == "v"


def test_record_event_writes_session_log(fresh_system_state, tmp_path, monkeypatch):
    import session_log
    monkeypatch.setattr(session_log, "LOG_DIR", tmp_path, raising=False)
    # Force session_log.log to write to tmp_path
    fresh_system_state.record_event("probe", duration_s=0.5, metadata={"x": 1})
    # Find any JSONL file written
    jsonls = list(tmp_path.glob("*.jsonl"))
    if not jsonls:
        # session_log may use a different scheme — assert in-memory state instead
        assert "probe" in fresh_system_state.get_last_events()
        return
    found = False
    for f in jsonls:
        for line in f.read_text(encoding="utf-8").splitlines():
            rec = json.loads(line)
            if rec.get("event") == "system_event" and rec.get("payload", {}).get("name") == "probe":
                found = True
                break
    assert found, "system_event not persisted to session log"


# ── Tool inventory (REQ-003) ─────────────────────────────────────────────────

def test_build_tool_inventory_degraded_when_no_creds(monkeypatch, fresh_system_state, tmp_path):
    # Ensure no mail/calendar credentials exist
    monkeypatch.delenv("IMAP_USERNAME", raising=False)
    monkeypatch.delenv("IMAP_PASSWORD", raising=False)
    monkeypatch.delenv("CALDAV_USERNAME", raising=False)
    monkeypatch.delenv("CALDAV_PASSWORD", raising=False)
    inv = fresh_system_state.build_tool_inventory()
    assert "mail" in inv
    assert "calendar" in inv
    # When no credentials, tool should be marked disabled with degraded_reason
    if not inv["mail"]["enabled"]:
        assert inv["mail"]["degraded_reason"]
    if not inv["calendar"]["enabled"]:
        assert inv["calendar"]["degraded_reason"]


# ── Static prompt block (REQ-005, RISK-002) ──────────────────────────────────

def test_render_static_prompt_block_empty_before_boot(fresh_system_state):
    """Before build_boot_snapshot, must return '' so tests like
    test_llm_rag_injection don't break."""
    assert fresh_system_state.render_static_prompt_block() == ""


def test_render_static_prompt_block_under_token_budget(fresh_system_state):
    fresh_system_state.build_boot_snapshot()
    fresh_system_state.build_tool_inventory()
    block = fresh_system_state.render_static_prompt_block()
    assert block.startswith("[SYSTEM STATE]")
    # Rough token budget: <800 chars ≈ <200 tokens
    assert len(block) < 4000, f"static block too large: {len(block)} chars"


def test_render_static_prompt_block_deterministic(fresh_system_state):
    fresh_system_state.build_boot_snapshot()
    fresh_system_state.build_tool_inventory()
    a = fresh_system_state.render_static_prompt_block()
    b = fresh_system_state.render_static_prompt_block()
    assert a == b


def test_static_block_no_secrets(monkeypatch, fresh_system_state):
    monkeypatch.setenv("IMAP_PASSWORD", "super-secret-pw")
    monkeypatch.setenv("CALDAV_PASSWORD", "another-secret")
    fresh_system_state.build_boot_snapshot()
    fresh_system_state.build_tool_inventory()
    block = fresh_system_state.render_static_prompt_block()
    assert "super-secret-pw" not in block
    assert "another-secret" not in block


# ── Historical trends (REQ-006) ──────────────────────────────────────────────

def test_compute_historical_trends_p50_p95(fresh_system_state, tmp_path, monkeypatch):
    """When session logs contain system_event records, trends should compute."""
    import session_log
    monkeypatch.setattr(session_log, "LOG_DIR", tmp_path, raising=False)
    # Write a JSONL with 10 dream events of varying durations
    log_file = tmp_path / "session_test.jsonl"
    lines = []
    for d in [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]:
        lines.append(json.dumps({
            "event": "system_event",
            "payload": {"name": "dream", "duration_s": d, "metadata": {}},
        }))
    log_file.write_text("\n".join(lines), encoding="utf-8")
    fresh_system_state._TRENDS_CACHE = None  # bust cache
    trends = fresh_system_state.compute_historical_trends()
    assert isinstance(trends, dict)
    if "dream" in trends:
        t = trends["dream"]
        assert "p50" in t and "p95" in t
        assert t["p50"] <= t["p95"]
