@echo off
title Energy LLM — Battery Configurator

echo.
echo  =====================================================
echo   Energy LLM ^| Battery Pack Configurator
echo  =====================================================
echo.

echo [1/3] 检查 Python...
python --version
if errorlevel 1 (
    echo X 未找到 Python，请先安装 Python 3
    echo   https://www.python.org/downloads/
    pause
    exit /b 1
)

echo [2/3] 安装 Python 依赖...
pip install -r backend\requirements.txt -q

echo [3/3] 启动后端服务...
echo.
echo   浏览器访问: http://127.0.0.1:5000
echo   按 Ctrl+C 停止服务
echo  =====================================================
echo.

:: 延迟 2 秒后自动打开浏览器
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:5000"

python backend\app.py
pause
