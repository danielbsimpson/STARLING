"""backend/llm_rag_injection.py — Shared RAG + memory context injection.

Both ``backend/ollama.py`` and ``backend/llama_server.py`` previously
contained an identical ~28-line block that:
  - looked up the most recent user message in the conversation,
  - computed its embedding once,
  - retrieved document and memory RAG hits,
  - inserted formatted system messages immediately after the prompt.

This module centralises that logic. Failures are intentionally swallowed:
RAG must never block the main chat path.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def inject_system_state(messages: list[dict[str, Any]]) -> None:
    """Insert the static system-state block at index 1 (after the soul prompt)."""
    try:
        import system_state
        if not system_state.is_inject_enabled():
            return
        block = system_state.render_static_prompt_block()
        if not block:
            return
        messages.insert(1, {"role": "system", "content": block})
    except Exception:  # noqa: BLE001 \u2014 must never break the chat path
        logger.exception("system_state injection failed; continuing without it.")


def inject_rag_and_memory(messages: list[dict[str, Any]]) -> None:
    """Mutate ``messages`` in place, inserting RAG + memory system blocks.

    Insertion order (when all three fire):
      [system prompt, system_state, doc RAG block, memory RAG block, ...rest]
    """
    inject_system_state(messages)
    try:
        from rag import (
            MEMORY_RAG_ENABLED,
            RAG_ENABLED,
            format_context_for_llm,
            format_memory_for_llm,
            get_embedding,
            retrieve,
            retrieve_memory,
        )
    except Exception:  # noqa: BLE001 — RAG deps may be optional
        logger.debug("RAG module unavailable; skipping injection.")
        return

    try:
        last_user = next(
            (m["content"] for m in reversed(messages) if m["role"] == "user"),
            None,
        )
        if not last_user:
            return

        query_vec = get_embedding(last_user)

        # Insert after the contiguous leading system block so order becomes:
        # [soul, system_state, doc, memory, ...rest]
        base_idx = 1
        while base_idx < len(messages) and messages[base_idx].get("role") == "system":
            base_idx += 1

        if RAG_ENABLED:
            rag_k    = int(os.getenv("RAG_VOICE_TOP_K", "2"))
            max_toks = int(os.getenv("RAG_MAX_CONTEXT_TOKENS", "400"))
            results  = retrieve(last_user, k=rag_k, embedding=query_vec)
            ctx_block = format_context_for_llm(results, max_tokens=max_toks)
            if ctx_block:
                messages.insert(base_idx, {"role": "system", "content": ctx_block})
                base_idx += 1

        if MEMORY_RAG_ENABLED:
            mem_results = retrieve_memory(last_user, embedding=query_vec)
            mem_block   = format_memory_for_llm(mem_results)
            if mem_block:
                messages.insert(base_idx, {"role": "system", "content": mem_block})
    except Exception:  # noqa: BLE001 — must never break the chat path
        logger.exception("RAG/memory injection failed; continuing without context.")
