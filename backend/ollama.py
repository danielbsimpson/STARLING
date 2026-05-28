"""backend/ollama.py — Streaming chat relay to the local Ollama API."""

import json
import os
import time
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import session_log
import prompts
import soul

router = APIRouter(prefix="/chat", tags=["ollama"])

OLLAMA_BASE = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2:3b")


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[Message]
    model: str = DEFAULT_MODEL
    temperature: float = float(os.getenv("OLLAMA_TEMPERATURE", "0.7"))


async def _stream_ollama(payload: dict):
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", f"{OLLAMA_BASE}/api/chat", json=payload
        ) as resp:
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="Ollama error")
            async for chunk in resp.aiter_bytes():
                yield chunk


@router.post("/")
async def chat(req: ChatRequest):
    messages = [m.model_dump() for m in req.messages]
    # Prepend system prompt if the first message isn't already a system message
    if not messages or messages[0].get("role") != "system":
        messages.insert(0, {"role": "system", "content": soul.inject(prompts.get("STARLING_CORE"))})
    from llm_rag_injection import inject_rag_and_memory
    inject_rag_and_memory(messages)

    payload = {
        "model": req.model,
        "messages": messages,
        "options": {"temperature": req.temperature},
        "stream": True,
    }

    session_log.log("llm_request", {
        "model":               req.model,
        "message_count":       len(messages),
        "system_prompt_hash":  session_log.system_prompt_hash(prompts.get("STARLING_CORE")),
        "temperature":         req.temperature,
    })

    async def _logging_stream():
        t0 = time.monotonic()
        assembled: list[str] = []
        async for chunk in _stream_ollama(payload):
            yield chunk
            # Accumulate message content for the post-stream log entry
            try:
                for line in chunk.decode("utf-8", errors="replace").split("\n"):
                    line = line.strip()
                    if not line:
                        continue
                    obj = json.loads(line)
                    content = obj.get("message", {}).get("content", "")
                    if content:
                        assembled.append(content)
                    if obj.get("done"):
                        full_text = "".join(assembled)[:4000]
                        elapsed_ms = round((time.monotonic() - t0) * 1000)
                        session_log.log("llm_response", {
                            "model":               req.model,
                            "full_text":           full_text,
                            "token_count_estimate": len(full_text.split()),
                            "duration_ms":         elapsed_ms,
                        })
            except Exception:
                pass  # best-effort: per-chunk parse errors should never break the stream

    return StreamingResponse(_logging_stream(), media_type="application/x-ndjson")
