@echo off
title Energy LLM — Battery Configurator

echo.
echo  =====================================================
echo   Energy LLM ^| Battery Pack Configurator
echo  =====================================================
echo.

echo [1/3] Checking Python...
python --version
if errorlevel 1 (
    echo X  Python not found. Please install Python 3:
    echo    https://www.python.org/downloads/
    pause
    exit /b 1
)

echo.
set /p REPLY=[2/3] Install / update Python dependencies from requirements.txt? [Y/n]:
if /i "%REPLY%"=="" set REPLY=Y
if /i "%REPLY%"=="n" goto skip_install

echo.
pip install -r backend\requirements.txt
if errorlevel 1 (
    echo.
    echo X  Dependency installation failed.
    echo    Check the error above, then re-run this script.
    pause
    exit /b 1
)
echo.
echo    Dependencies installed successfully.
goto after_install

:skip_install
echo    Skipping installation -- using existing packages.

:after_install
echo.
echo [3/3] Starting backend server...
echo.
echo   Open in browser: http://127.0.0.1:8080
echo   Press Ctrl+C to stop
echo  =====================================================
echo.

start /b cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:8080"

python backend\app.py
pause
