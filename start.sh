#!/bin/bash
# Energy LLM — Battery Pack Configurator
# macOS / Linux one-click launcher

echo ""
echo " ====================================================="
echo "  Energy LLM | Battery Pack Configurator"
echo " ====================================================="
echo ""

# Check for Python
if command -v python3 &>/dev/null; then
    PYTHON=python3
elif command -v python &>/dev/null; then
    PYTHON=python
else
    echo "X  Python not found. Please install Python 3:"
    echo "   macOS: brew install python"
    echo "   or visit https://www.python.org/downloads/"
    exit 1
fi

echo "[1/3] Python: $($PYTHON --version)"

# Create virtual environment if it doesn't exist
VENV_DIR="$(dirname "$0")/.venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "[2/3] Creating virtual environment..."
    $PYTHON -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

# Ask user before installing dependencies
echo ""
read -r -p "[2/3] Install / update Python dependencies from requirements.txt? [Y/n] " REPLY
echo ""
REPLY="${REPLY:-Y}"
if [[ "$REPLY" =~ ^[Yy] ]]; then
    pip install -r backend/requirements.txt
    if [ $? -ne 0 ]; then
        echo ""
        echo "X  Dependency installation failed."
        echo "   Check the error above, then re-run this script."
        exit 1
    fi
    echo ""
    echo "   Dependencies installed successfully."
else
    echo "   Skipping installation — using existing packages."
fi

# Start backend
echo ""
echo "[3/3] Starting backend server..."
echo ""
echo "  Open in browser: http://127.0.0.1:8080"
echo "  Press Ctrl+C to stop"
echo " ====================================================="
echo ""

# Open browser after Flask starts (macOS: open, Linux: xdg-open)
(sleep 2 && \
    if [[ "$OSTYPE" == "darwin"* ]]; then
        open http://127.0.0.1:8080
    elif command -v xdg-open &>/dev/null; then
        xdg-open http://127.0.0.1:8080
    fi
) &

$PYTHON backend/app.py
