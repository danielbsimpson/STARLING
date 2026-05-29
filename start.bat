@echo off
title S.T.A.R.L.I.N.G.
setlocal

set "VENV_PY=%~dp0.venv\Scripts\python.exe"

if not exist "%VENV_PY%" (
    echo [start.bat] ERROR: %VENV_PY% not found.
    echo [start.bat] Create the virtual environment first:
    echo [start.bat]     python -m venv .venv
    echo [start.bat]     .venv\Scripts\activate
    echo [start.bat]     pip install -r requirements.txt
    echo [start.bat]     python scripts\download_models.py
    echo [start.bat] Or, in Git Bash / WSL:  make install
    exit /b 1
)

REM Activate so child tools (uvicorn, etc.) inherit the venv's PATH.
call "%~dp0.venv\Scripts\activate.bat"

REM Windows Store Python adds the user-site (LocalCache\local-packages) to
REM sys.path even inside a venv, which can shadow venv packages with stale
REM globally-installed ones (e.g. uvicorn without faster_whisper). Disable it.
set PYTHONNOUSERSITE=1

REM Invoke the venv python by absolute path — relying on PATH alone is unsafe
REM because Windows App Execution Aliases for python.exe can override venv\Scripts.
"%VENV_PY%" "%~dp0scripts\launch.py"

endlocal
