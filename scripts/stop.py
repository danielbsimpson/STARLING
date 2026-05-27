"""scripts/stop.py — Stop running S.T.A.R.L.I.N.G. processes.

Reads backend/memory/.starling.pid (written by launch.py) and terminates
the recorded processes.

Usage:
    python scripts/stop.py
    make down
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT  = Path(__file__).resolve().parent.parent
PID_FILE   = REPO_ROOT / "backend" / "memory" / ".starling.pid"
IS_WINDOWS = os.name == "nt"


def _read_env() -> dict:
    """Load key=value pairs from the repo .env file (no external dependencies)."""
    env: dict = {}
    dotenv_path = REPO_ROOT / ".env"
    if not dotenv_path.exists():
        return env
    try:
        with open(dotenv_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    return env


_ENV            = _read_env()
_BACKEND_PORT   = int(_ENV.get("BACKEND_PORT",  "8000"))
_DREAM_TIMEOUT_S = int(_ENV.get("DREAM_TIMEOUT_S", "300"))


def _kill(pid: int, name: str, timeout: float = 5.0) -> None:
    """Terminate a process by PID, platform-appropriately."""
    print(f"  Stopping {name} (pid {pid})…")
    try:
        if IS_WINDOWS:
            result = subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],  # /T kills the full process tree
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                print(f"  ✓ {name} stopped.")
            else:
                # Non-zero usually means the process is already gone
                msg = result.stderr.strip() or result.stdout.strip() or "already stopped"
                print(f"  - {name}: {msg}")
        else:
            import signal as _sig

            os.kill(pid, _sig.SIGTERM)
            # Wait for graceful exit up to timeout seconds
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                time.sleep(0.5)
                try:
                    os.kill(pid, 0)  # probe — raises if gone
                except ProcessLookupError:
                    break
            else:
                # Force kill if still alive
                try:
                    os.kill(pid, _sig.SIGKILL)
                except ProcessLookupError:
                    pass
            print(f"  ✓ {name} stopped.")
    except ProcessLookupError:
        print(f"  - {name}: already stopped")
    except Exception as exc:
        print(f"  ! {name}: {exc}")


def _kill_by_name_windows(proc_name: str) -> None:
    """Fallback: kill all processes matching a name via taskkill."""
    result = subprocess.run(
        ["taskkill", "/F", "/IM", proc_name],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        print(f"  ✓ {proc_name} stopped (by name).")
    else:
        msg = result.stderr.strip() or result.stdout.strip()
        if "not found" in msg.lower():
            print(f"  - {proc_name}: not running.")
        else:
            print(f"  - {proc_name}: {msg}")

def _kill_backend_graceful_windows(pid: int) -> None:
    """On Windows: call the HTTP shutdown endpoint (which triggers the dream state
    thread inside the backend) then wait for the process to self-terminate."""
    import urllib.request as _urlreq
    print(f"  Requesting graceful backend shutdown — dream state will run (pid {pid})…")
    try:
        _urlreq.urlopen(
            f"http://localhost:{_BACKEND_PORT}/system/shutdown",
            data=b"{}",
            timeout=5,
        )
    except Exception:
        pass  # Backend starts dream thread; connection may close before a response

    total_wait = _DREAM_TIMEOUT_S + 30
    print(f"  Waiting up to {total_wait}s for dream state…", end="", flush=True)
    deadline = time.monotonic() + total_wait
    while time.monotonic() < deadline:
        time.sleep(2)
        print(".", end="", flush=True)
        check = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True,
        )
        if str(pid) not in check.stdout:
            print(f"\n  \u2713 backend stopped (dream state complete).")
            return
    print(f"\n  ! Dream state timed out — force-killing backend…")
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)
    print(f"  \u2713 backend force-stopped.")

def main() -> None:
    pid_file_missing = not PID_FILE.exists()
    data: dict = {}

    if not pid_file_missing:
        try:
            data = json.loads(PID_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            print(f"Could not read PID file: {exc}")
            PID_FILE.unlink(missing_ok=True)
            data = {}

    print("Stopping S.T.A.R.L.I.N.G.…")

    # Stop backend first so no new requests arrive while LLM shuts down
    backend_pid = data.get("backend")
    llama_pid   = data.get("llama")

    if backend_pid:
        if IS_WINDOWS:
            _kill_backend_graceful_windows(int(backend_pid))
        else:
            # Non-Windows: SIGTERM triggers uvicorn's shutdown hook which runs dream state.
            # Extended wait gives dream state time to complete before force-kill.
            _kill(int(backend_pid), "backend", timeout=float(_DREAM_TIMEOUT_S + 30))
    if llama_pid:
        _kill(int(llama_pid), "llama-server")

    # Fallback: kill by process name to catch stale-PID or --reload child cases
    if IS_WINDOWS:
        _kill_by_name_windows("llama-server.exe")
        # Only wipe uvicorn workers if we had a PID file (avoid killing unrelated pythons)
        if not pid_file_missing or not data:
            _kill_by_name_windows("uvicorn.exe")

    try:
        PID_FILE.unlink(missing_ok=True)
    except Exception:
        pass

    print("Done.")


if __name__ == "__main__":
    main()
