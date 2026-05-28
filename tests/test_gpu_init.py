"""Regression tests for backend.gpu_init.

These tests only verify the function is safe to call (no exceptions) on
the current host. On non-Windows they must be a strict no-op.
"""

import os

from gpu_init import register_nvidia_dll_dirs


def test_register_nvidia_dll_dirs_is_idempotent_and_safe():
    register_nvidia_dll_dirs()
    register_nvidia_dll_dirs()  # second call must not raise


def test_register_nvidia_dll_dirs_noop_on_non_windows():
    if os.name == "nt":
        return  # skip on Windows — covered by the smoke test above
    # On POSIX the function must do nothing and never raise.
    register_nvidia_dll_dirs()
