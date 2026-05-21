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

REPO_ROOT = Path(__file__).resolve().parent.parent
PID_FILE  = REPO_ROOT / "backend" / "memory" / ".starling.pid"
IS_WINDOWS = os.name == "nt"


def _kill(pid: int, name: str) -> None:
    """Terminate a process by PID, platform-appropriately."""
    print(f"  Stopping {name} (pid {pid})…")
    try:
        if IS_WINDOWS:
            result = subprocess.run(
                ["taskkill", "/F", "/PID", str(pid)],
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
            # Wait up to 5 s for graceful exit
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                time.sleep(0.1)
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
        _kill(int(backend_pid), "backend")
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
