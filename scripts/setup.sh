#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup.sh — One-shot install for S.T.A.R.L.I.N.G.
#
# Usage:
#   bash scripts/setup.sh
#
# What it does:
#   1. Creates a Python 3.11+ virtual environment at .venv/
#   2. Installs all Python dependencies from requirements.txt
#   3. Downloads Kokoro model files (~330 MB) to models/
#   4. Copies .env.example → .env (if .env does not yet exist)
#
# Prerequisites:
#   - Python 3.11 or later on PATH
#   - llama-server installed separately (see scripts/start_llama_server.bat)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $*"; }
error() { echo -e "${RED}[setup]${NC} $*" >&2; exit 1; }

# ── 1. Python version check ───────────────────────────────────────────────────
info "Checking Python version..."
PYTHON_BIN="${PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" &>/dev/null; then PYTHON_BIN="python"; fi
if ! command -v "$PYTHON_BIN" &>/dev/null; then
    error "Python not found. Install Python 3.11+ and ensure it is on PATH."
fi

PYTHON_VERSION=$("$PYTHON_BIN" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)

if [[ "$PYTHON_MAJOR" -lt 3 || ("$PYTHON_MAJOR" -eq 3 && "$PYTHON_MINOR" -lt 11) ]]; then
    error "Python 3.11+ required; found $PYTHON_VERSION."
fi
info "Python $PYTHON_VERSION OK."

# ── 2. Virtual environment ────────────────────────────────────────────────────
VENV_DIR="$REPO_ROOT/.venv"
if [[ -d "$VENV_DIR" ]]; then
    warn ".venv already exists — skipping creation."
else
    info "Creating virtual environment at .venv/ ..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

# Activate (Git Bash on Windows uses Scripts/, Linux/Mac uses bin/)
if [[ -f "$VENV_DIR/Scripts/activate" ]]; then
    source "$VENV_DIR/Scripts/activate"
else
    source "$VENV_DIR/bin/activate"
fi
info "Virtual environment activated."

# ── 3. Pip upgrade + install dependencies ─────────────────────────────────────
info "Upgrading pip..."
pip install --quiet --upgrade pip

info "Installing dependencies from requirements.txt ..."
pip install --quiet -r requirements.txt
info "Dependencies installed."

# ── 4. Download Kokoro model files ────────────────────────────────────────────
MODEL_ONNX="$REPO_ROOT/models/kokoro-v1.0.onnx"
MODEL_VOICES="$REPO_ROOT/models/voices-v1.0.bin"

if [[ -f "$MODEL_ONNX" && -f "$MODEL_VOICES" ]]; then
    warn "Kokoro model files already present — skipping download."
else
    info "Downloading Kokoro model files (~330 MB) ..."
    "$PYTHON_BIN" scripts/download_models.py
    info "Kokoro models ready."
fi

# ── 5. Copy .env.example → .env ───────────────────────────────────────────────
if [[ -f "$REPO_ROOT/.env" ]]; then
    warn ".env already exists — not overwriting. Edit it manually if needed."
else
    cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
    info ".env created from .env.example. Open it and configure LLM_BACKEND + model paths."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}──────────────────────────────────────────────────────────${NC}"
echo -e "${GREEN} S.T.A.R.L.I.N.G. setup complete!${NC}"
echo -e "${GREEN}──────────────────────────────────────────────────────────${NC}"
echo ""
echo "  Next steps:"
echo "  1. Edit .env — set LLM_BACKEND=llama and check LLAMA_MODEL_PATH"
echo "  2. Start llama-server:  scripts/start_llama_server.bat  (Windows)"
echo "                          or: make llama                   (Git Bash)"
echo "  3. Start the backend:   make backend"
echo "  4. Open the UI:         http://localhost:8000"
echo ""

echo ""
echo "Setup complete!"
echo "  Activate venv:      source .venv/bin/activate"
echo "  Start backend:      uvicorn backend.main:app --reload --port 8000"
echo "  Open frontend:      open frontend/index.html  (or use live-server)"
