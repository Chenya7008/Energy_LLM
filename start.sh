#!/bin/bash
# Energy LLM — Battery Pack Configurator
# macOS / Linux 一键启动脚本

echo ""
echo " ====================================================="
echo "  Energy LLM | Battery Pack Configurator"
echo " ====================================================="
echo ""

# 检查 Python
if command -v python3 &>/dev/null; then
    PYTHON=python3
    PIP=pip3
elif command -v python &>/dev/null; then
    PYTHON=python
    PIP=pip
else
    echo "❌ 未找到 Python，请先安装 Python 3："
    echo "   macOS: brew install python"
    echo "   或访问 https://www.python.org/downloads/"
    exit 1
fi

echo "[1/3] Python: $($PYTHON --version)"

# 安装依赖
echo "[2/3] 安装 Python 依赖..."
$PIP install -r backend/requirements.txt -q

# 自动打开浏览器（后台延迟打开，等 Flask 启动）
echo "[3/3] 启动后端服务..."
echo ""
echo "  浏览器访问: http://127.0.0.1:5000"
echo "  按 Ctrl+C 停止服务"
echo " ====================================================="
echo ""

# macOS 用 open，Linux 用 xdg-open
(sleep 2 && \
    if [[ "$OSTYPE" == "darwin"* ]]; then
        open http://127.0.0.1:5000
    elif command -v xdg-open &>/dev/null; then
        xdg-open http://127.0.0.1:5000
    fi
) &

$PYTHON backend/app.py
