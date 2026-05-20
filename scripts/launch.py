"""scripts/launch.py — S.T.A.R.L.I.N.G. process manager.

Starts llama-server and the FastAPI backend as supervised subprocesses,
streams their output to stdout with coloured prefixes, writes a PID file,
and shuts both down cleanly on Ctrl+C or SIGTERM.

Usage:
    python scripts/launch.py          # normal start
    make up                           # canonical entry point
"""

import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
PID_FILE  = REPO_ROOT / "backend" / "memory" / ".starling.pid"

# ── Config (reads .env, falls back to start_llama_server.bat defaults) ────────

def _load_dotenv() -> dict:
    """Load .env from repo root. Uses python-dotenv if available, else parses manually."""
    env: dict[str, str] = {}
    dotenv_path = REPO_ROOT / ".env"
    if not dotenv_path.exists():
        return env
    try:
        from dotenv import dotenv_values
        return dict(dotenv_values(dotenv_path))
    except ImportError:
        pass
    # Manual parse fallback (no extra packages required)
    with open(dotenv_path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


_ENV = _load_dotenv()


def _cfg(key: str, default: str) -> str:
    """Return env var, .env value, or hardcoded default — in that priority order."""
    return os.environ.get(key) or _ENV.get(key) or default


LLAMA_EXE        = _cfg("LLAMA_EXE",        r"C:\llama.cpp\llama-server.exe")
LLAMA_MODEL_PATH = _cfg(
    "LLAMA_MODEL_PATH",
    r"%USERPROFILE%\.ollama\models\blobs\sha256-dde5aa3fc5ffc17176b5e8bdc82f587b24b2678c6c66101bf7da77af9f7ccdff",
)
LLAMA_ALIAS      = _cfg("LLAMA_ALIAS",      "llama3.2-3b")
LLAMA_PORT       = _cfg("LLAMA_PORT",       "8080")
LLAMA_HOST       = _cfg("LLAMA_HOST",       "127.0.0.1")
LLAMA_GPU_LAYERS = _cfg("LLAMA_GPU_LAYERS", "999")
LLAMA_CTX_SIZE   = _cfg("LLAMA_CTX_SIZE",   "4096")
BACKEND_PORT     = _cfg("BACKEND_PORT",     "8000")

# ── Terminal colours (ANSI) ───────────────────────────────────────────────────

_R    = "\033[0m"       # reset
_CYAN = "\033[96m"      # llama prefix
_GRN  = "\033[92m"      # backend prefix
_YEL  = "\033[93m"      # launcher info
_RED  = "\033[91m"      # launcher error / warning


def _info(msg: str) -> None:
    print(f"{_YEL}[launcher]{_R} {msg}", flush=True)


def _err(msg: str) -> None:
    print(f"{_RED}[launcher]{_R} {msg}", flush=True)


# ── Process handles ───────────────────────────────────────────────────────────

_llama_proc:   "subprocess.Popen[bytes] | None" = None
_backend_proc: "subprocess.Popen[bytes] | None" = None
_shutting_down = False

# ── Output streaming ──────────────────────────────────────────────────────────

def _stream_output(proc: "subprocess.Popen[bytes]", prefix: str, colour: str) -> None:
    """Read proc stdout+stderr line-by-line and echo with a coloured prefix."""
    try:
        for raw in iter(proc.stdout.readline, b""):  # type: ignore[union-attr]
            try:
                line = raw.decode("utf-8", errors="replace").rstrip()
            except Exception:
                continue
            print(f"{colour}[{prefix}]{_R} {line}", flush=True)
    except Exception:
        pass


# ── PID file ──────────────────────────────────────────────────────────────────

def _write_pid_file() -> None:
    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "llama":   _llama_proc.pid   if _llama_proc   else None,
        "backend": _backend_proc.pid if _backend_proc else None,
    }
    PID_FILE.write_text(json.dumps(payload), encoding="utf-8")


def _delete_pid_file() -> None:
    try:
        PID_FILE.unlink(missing_ok=True)
    except Exception:
        pass


# ── Shutdown ──────────────────────────────────────────────────────────────────

def _terminate(proc: "subprocess.Popen[bytes] | None", name: str, timeout: int = 5) -> None:
    if proc is None or proc.poll() is not None:
        return
    _info(f"Stopping {name} (pid {proc.pid})…")
    try:
        proc.terminate()
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _err(f"{name} did not stop within {timeout}s — sending kill")
        try:
            proc.kill()
        except Exception:
            pass


def shutdown_handler(signum=None, frame=None, *, exit_code: int = 0) -> None:
    global _shutting_down
    if _shutting_down:
        return
    _shutting_down = True
    print(flush=True)  # newline after ^C
    _info("Shutting down…")
    _terminate(_backend_proc, "backend")
    _terminate(_llama_proc,   "llama-server")
    _delete_pid_file()
    _info("All processes stopped.")
    sys.exit(exit_code)


# ── Process starters ──────────────────────────────────────────────────────────

def start_llama() -> "subprocess.Popen[bytes]":
    exe   = os.path.expandvars(LLAMA_EXE)
    model = os.path.expandvars(LLAMA_MODEL_PATH)
    cmd = [
        exe,
        "--model",        model,
        "--alias",        LLAMA_ALIAS,
        "--port",         LLAMA_PORT,
        "--host",         LLAMA_HOST,
        "--n-gpu-layers", LLAMA_GPU_LAYERS,
        "--ctx-size",     LLAMA_CTX_SIZE,
    ]
    _info(f"Starting llama-server on {LLAMA_HOST}:{LLAMA_PORT}")
    _info(f"  model : {model}")
    _info(f"  alias : {LLAMA_ALIAS}")
    return subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=str(REPO_ROOT),
    )


def start_backend() -> "subprocess.Popen[bytes]":
    python = sys.executable  # same venv that ran this script
    backend_dir = REPO_ROOT / "backend"
    cmd = [
        python, "-m", "uvicorn", "main:app",
        "--host", "0.0.0.0",
        "--port", BACKEND_PORT,
        "--reload",
        "--reload-dir", str(backend_dir),
    ]
    _info(f"Starting FastAPI backend on port {BACKEND_PORT}")
    return subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=str(backend_dir),
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    global _llama_proc, _backend_proc

    # Register signal handlers
    signal.signal(signal.SIGINT, shutdown_handler)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, shutdown_handler)

    _llama_proc   = start_llama()
    _backend_proc = start_backend()

    _write_pid_file()
    _info(f"Both processes started.  PID file: {PID_FILE}")
    _info("Press Ctrl+C to stop everything.\n")

    # Start output-forwarding threads (daemon so they don't block exit)
    threading.Thread(
        target=_stream_output,
        args=(_llama_proc,   "llama",   _CYAN),
        daemon=True,
    ).start()
    threading.Thread(
        target=_stream_output,
        args=(_backend_proc, "backend", _GRN),
        daemon=True,
    ).start()

    # Watchdog loop — detect unexpected exits
    while True:
        time.sleep(2)
        llama_rc   = _llama_proc.poll()
        backend_rc = _backend_proc.poll()
        if llama_rc is not None:
            _err(f"llama-server exited unexpectedly (rc={llama_rc}) — shutting down")
            shutdown_handler(exit_code=1)
        if backend_rc is not None:
            _err(f"FastAPI backend exited unexpectedly (rc={backend_rc}) — shutting down")
            shutdown_handler(exit_code=1)


if __name__ == "__main__":
    main()
