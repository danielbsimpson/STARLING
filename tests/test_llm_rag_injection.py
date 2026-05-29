"""Regression tests for backend.llm_rag_injection.

Verifies the RAG + memory context injection mutates `messages` in the
expected order and silently no-ops when the `rag` module is missing or
raises. The real `rag` module is replaced via `sys.modules` so these
tests run without ChromaDB / fastembed installed.
"""

from __future__ import annotations

import sys
import types
from typing import Any

import pytest

import llm_rag_injection


@pytest.fixture(autouse=True)
def _reset_system_state_snapshot():
    """system_state holds module-level boot snapshot. Other test files may
    populate it; reset to None so render_static_prompt_block() returns ''
    and existing assertions still hold."""
    try:
        import system_state
        system_state._BOOT_SNAPSHOT = None
        system_state._STATIC_PROMPT_BLOCK = None
    except Exception:
        pass
    yield


def _install_fake_rag(monkeypatch, *, rag_enabled: bool, mem_enabled: bool,
                     ctx_block: str = "", mem_block: str = "",
                     raise_in: str | None = None) -> None:
    """Install a fake `rag` module in sys.modules for this test."""
    fake = types.ModuleType("rag")
    fake.RAG_ENABLED = rag_enabled
    fake.MEMORY_RAG_ENABLED = mem_enabled

    def get_embedding(text: str):
        if raise_in == "get_embedding":
            raise RuntimeError("boom")
        return [0.0]

    def retrieve(text, *, k=2, embedding=None):
        return [{"text": "doc"}] if ctx_block else []

    def retrieve_memory(text, *, embedding=None):
        return [{"text": "mem"}] if mem_block else []

    def format_context_for_llm(results, *, max_tokens=400):
        return ctx_block

    def format_memory_for_llm(results):
        return mem_block

    fake.get_embedding = get_embedding
    fake.retrieve = retrieve
    fake.retrieve_memory = retrieve_memory
    fake.format_context_for_llm = format_context_for_llm
    fake.format_memory_for_llm = format_memory_for_llm
    monkeypatch.setitem(sys.modules, "rag", fake)


def _base_messages() -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": "soul"},
        {"role": "user", "content": "hello"},
    ]


def test_no_user_message_is_noop(monkeypatch):
    _install_fake_rag(monkeypatch, rag_enabled=True, mem_enabled=True,
                      ctx_block="ctx", mem_block="mem")
    msgs = [{"role": "system", "content": "soul"}]
    llm_rag_injection.inject_rag_and_memory(msgs)
    assert msgs == [{"role": "system", "content": "soul"}]


def test_rag_only_inserts_at_index_1(monkeypatch):
    _install_fake_rag(monkeypatch, rag_enabled=True, mem_enabled=False,
                      ctx_block="DOC CONTEXT")
    msgs = _base_messages()
    llm_rag_injection.inject_rag_and_memory(msgs)
    assert msgs[1] == {"role": "system", "content": "DOC CONTEXT"}
    assert msgs[2]["role"] == "user"


def test_memory_only_inserts_at_index_1(monkeypatch):
    _install_fake_rag(monkeypatch, rag_enabled=False, mem_enabled=True,
                      mem_block="MEM CONTEXT")
    msgs = _base_messages()
    llm_rag_injection.inject_rag_and_memory(msgs)
    assert msgs[1] == {"role": "system", "content": "MEM CONTEXT"}


def test_both_rag_and_memory_ordered(monkeypatch):
    _install_fake_rag(monkeypatch, rag_enabled=True, mem_enabled=True,
                      ctx_block="DOC", mem_block="MEM")
    msgs = _base_messages()
    llm_rag_injection.inject_rag_and_memory(msgs)
    # Expected: [soul, DOC, MEM, user]
    assert [m["content"] for m in msgs] == ["soul", "DOC", "MEM", "hello"]


def test_empty_context_blocks_skipped(monkeypatch):
    _install_fake_rag(monkeypatch, rag_enabled=True, mem_enabled=True,
                      ctx_block="", mem_block="")
    msgs = _base_messages()
    llm_rag_injection.inject_rag_and_memory(msgs)
    assert msgs == _base_messages()


def test_exception_swallowed(monkeypatch):
    _install_fake_rag(monkeypatch, rag_enabled=True, mem_enabled=False,
                      ctx_block="DOC", raise_in="get_embedding")
    msgs = _base_messages()
    llm_rag_injection.inject_rag_and_memory(msgs)  # must not raise
    assert msgs == _base_messages()


def test_missing_rag_module_is_noop(monkeypatch):
    # Ensure no `rag` is importable
    monkeypatch.setitem(sys.modules, "rag", None)
    msgs = _base_messages()
    llm_rag_injection.inject_rag_and_memory(msgs)
    assert msgs == _base_messages()


def test_inject_system_state_inserts_before_rag(monkeypatch):
    """When system_state.render_static_prompt_block returns content, it must
    be inserted at index 1, before RAG/memory blocks."""
    import importlib
    import system_state as ss
    importlib.reload(ss)
    ss.build_boot_snapshot()
    ss.build_tool_inventory()
    _install_fake_rag(monkeypatch, rag_enabled=True, mem_enabled=False,
                      ctx_block='DOC CONTEXT')
    msgs = _base_messages()
    llm_rag_injection.inject_rag_and_memory(msgs)
    # Expect: [soul, system_state, DOC CONTEXT, user]
    assert msgs[1]['content'].startswith('[SYSTEM STATE]')
    assert any(m.get('content') == 'DOC CONTEXT' for m in msgs)
