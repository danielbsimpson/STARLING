"""backend/gpu_init.py — One-time GPU runtime initialisation.

On Windows the nvidia-*-cu12 pip wheels install CUDA runtime DLLs (cuDNN,
cuBLAS, cuFFT, nvJitLink, cuda_runtime, cuda_nvcc) under
``site-packages/nvidia/*/bin/``. Those directories are not on the system
PATH, so onnxruntime's CUDA EP and ctranslate2 silently fall back to CPU.

`register_nvidia_dll_dirs()` registers every present nvidia/*/bin directory
via ``os.add_dll_directory``. Must be called before importing onnxruntime
or ctranslate2. No-op on non-Windows platforms.
"""

from __future__ import annotations

import os
import site
from pathlib import Path


def register_nvidia_dll_dirs() -> None:
    """Register nvidia wheel DLL directories on Windows. No-op elsewhere."""
    if os.name != "nt":
        return
    for pkg_root in site.getsitepackages():
        nvidia_root = Path(pkg_root) / "nvidia"
        if not nvidia_root.is_dir():
            continue
        for sub in nvidia_root.iterdir():
            bin_dir = sub / "bin"
            if bin_dir.is_dir():
                try:
                    os.add_dll_directory(str(bin_dir))
                except OSError:
                    pass
