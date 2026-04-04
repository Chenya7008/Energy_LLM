@echo off
title Energy LLM — Battery Configurator

echo.
echo  =====================================================
echo   Energy LLM ^| Battery Pack Configurator
echo  =====================================================
echo.

:: Install dependencies
echo [1/2] Installing Python dependencies...
pip install -r backend\requirements.txt -q

echo.
echo [2/2] Starting Flask backend...
echo       打开浏览器访问: http://127.0.0.1:5000
echo.
echo  Press Ctrl+C to stop.
echo  =====================================================
echo.

python backend\app.py
pause
