#!/usr/bin/env python3
"""scripts/test_integration.py — End-to-end integration tests for S.T.A.R.L.I.N.G.

Runs a suite of HTTP checks against a live backend (default: http://localhost:8000).
Requires the FastAPI backend to be running before execution.

Usage:
    python scripts/test_integration.py
    python scripts/test_integration.py --base http://localhost:8000

Exit codes:
    0 — all tests passed
    1 — one or more tests failed
"""

import argparse
import asyncio
import json
import sys
import wave
from io import BytesIO

import httpx

# ── Config ────────────────────────────────────────────────────────────────────
DEFAULT_BASE = "http://localhost:8000"
TIMEOUT = 30.0  # seconds — generous to allow for cold model load

# ── Helpers ───────────────────────────────────────────────────────────────────

_PASS = "\033[32mPASS\033[0m"
_FAIL = "\033[31mFAIL\033[0m"
_SKIP = "\033[33mSKIP\033[0m"

results: list[tuple[str, bool, str]] = []


def record(name: str, passed: bool, detail: str = "") -> None:
    results.append((name, passed, detail))
    status = _PASS if passed else _FAIL
    detail_str = f"  {detail}" if detail else ""
    print(f"  [{status}] {name}{detail_str}")


def _make_silent_wav(duration_s: float = 0.5, sample_rate: int = 16000) -> bytes:
    """Generate a minimal silent WAV blob for Whisper warm-up / smoke test."""
    num_samples = int(sample_rate * duration_s)
    buf = BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * num_samples)
    return buf.getvalue()


# ── Tests ─────────────────────────────────────────────────────────────────────

async def test_health(client: httpx.AsyncClient) -> None:
    name = "GET /health"
    try:
        r = await client.get("/health")
        passed = r.status_code == 200 and r.json().get("status") == "ok"
        record(name, passed, "" if passed else f"status={r.status_code} body={r.text[:80]}")
    except Exception as exc:
        record(name, False, str(exc))


async def test_system_status(client: httpx.AsyncClient) -> None:
    name = "GET /system-status"
    try:
        r = await client.get("/system-status")
        passed = r.status_code == 200
        if passed:
            data = r.json()
            keys = {"whisper", "kokoro", "llm"}
            missing = keys - data.keys()
            passed = not missing
            record(name, passed, "" if passed else f"missing keys: {missing}")
        else:
            record(name, False, f"status={r.status_code}")
    except Exception as exc:
        record(name, False, str(exc))


async def test_voices(client: httpx.AsyncClient) -> None:
    name = "GET /synthesize/voices"
    try:
        r = await client.get("/synthesize/voices")
        passed = r.status_code == 200
        if passed:
            data = r.json()
            passed = isinstance(data, list) and len(data) > 0
            record(name, passed, f"{len(data)} voices" if passed else "empty list")
        else:
            record(name, False, f"status={r.status_code}")
    except Exception as exc:
        record(name, False, str(exc))


async def test_synthesize(client: httpx.AsyncClient) -> None:
    name = "POST /synthesize (TTS smoke test)"
    try:
        r = await client.post(
            "/synthesize",
            json={"text": "Integration test.", "voice": "af_heart", "speed": 1.0},
            timeout=TIMEOUT,
        )
        passed = r.status_code == 200 and r.headers.get("content-type", "").startswith("audio/")
        detail = f"content-type={r.headers.get('content-type')} size={len(r.content)} B"
        record(name, passed, detail if not passed else "")
    except Exception as exc:
        record(name, False, str(exc))


async def test_transcribe(client: httpx.AsyncClient) -> None:
    name = "POST /transcribe (STT smoke test — silent WAV)"
    try:
        wav_bytes = _make_silent_wav()
        r = await client.post(
            "/transcribe",
            files={"file": ("audio.wav", wav_bytes, "audio/wav")},
            timeout=TIMEOUT,
        )
        # Silent audio → empty or near-empty transcript; we just verify the endpoint responds
        passed = r.status_code == 200 and "transcript" in r.json()
        record(name, passed, "" if passed else f"status={r.status_code} body={r.text[:80]}")
    except Exception as exc:
        record(name, False, str(exc))


async def test_chat_stream(client: httpx.AsyncClient) -> None:
    name = "POST /chat/ (LLM streaming — end-to-end)"
    try:
        payload = {
            "messages": [{"role": "user", "content": "Reply with the single word: ONLINE"}],
        }
        tokens: list[str] = []
        metrics_received = False

        async with client.stream(
            "POST", "/chat/", json=payload, timeout=TIMEOUT
        ) as resp:
            if resp.status_code != 200:
                record(name, False, f"status={resp.status_code}")
                return
            async for raw_line in resp.aiter_lines():
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if parsed.get("metrics"):
                    metrics_received = True
                    continue
                if parsed.get("done"):
                    continue
                token = parsed.get("message", {}).get("content", "")
                tokens.append(token)

        full_text = "".join(tokens).strip()
        passed = bool(full_text)
        detail = f"response={full_text[:60]!r} metrics={metrics_received}"
        record(name, passed, detail)
    except Exception as exc:
        record(name, False, str(exc))


async def test_context_limit(client: httpx.AsyncClient) -> None:
    name = "GET /chat/context-limit"
    try:
        r = await client.get("/chat/context-limit", timeout=10.0)
        if r.status_code == 404:
            # Ollama backend doesn't expose this endpoint — skip gracefully
            record(name, True, "SKIP — not available with Ollama backend")
            return
        passed = r.status_code == 200 and isinstance(r.json().get("n_ctx"), int)
        record(name, passed, f"n_ctx={r.json().get('n_ctx')}" if passed else r.text[:80])
    except Exception as exc:
        record(name, False, str(exc))


# ── Runner ────────────────────────────────────────────────────────────────────

async def run_all(base_url: str) -> int:
    print(f"\n  S.T.A.R.L.I.N.G. integration tests → {base_url}\n")

    async with httpx.AsyncClient(base_url=base_url, timeout=TIMEOUT) as client:
        # Run connectivity check first; bail early if backend is unreachable
        try:
            await client.get("/health", timeout=5.0)
        except (httpx.ConnectError, httpx.TimeoutException):
            print(f"  [{_FAIL}] Cannot reach backend at {base_url}")
            print("         Make sure the FastAPI backend is running before running tests.\n")
            return 1

        await test_health(client)
        await test_system_status(client)
        await test_voices(client)
        await test_synthesize(client)
        await test_transcribe(client)
        await test_context_limit(client)
        await test_chat_stream(client)   # run last — slowest

    passed = sum(1 for _, ok, _ in results if ok)
    total  = len(results)
    colour = "\033[32m" if passed == total else "\033[31m"
    print(f"\n  {colour}{passed}/{total} tests passed\033[0m\n")
    return 0 if passed == total else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="S.T.A.R.L.I.N.G. integration tests")
    parser.add_argument("--base", default=DEFAULT_BASE, help="Backend base URL")
    args = parser.parse_args()
    sys.exit(asyncio.run(run_all(args.base)))


if __name__ == "__main__":
    main()
