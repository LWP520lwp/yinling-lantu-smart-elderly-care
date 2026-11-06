#!/usr/bin/env bash
# ============================================================
# 银龄岚途 FastAPI 后端一键启动脚本（Linux / macOS）
# 用法：
#   ./run.sh        启动 Web 服务（自动建虚拟环境、装依赖）
#   ./run.sh test   运行 pytest 后端测试
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

# 首次运行创建虚拟环境
if [ ! -d ".venv" ]; then
  echo "[1/4] 创建虚拟环境 .venv ..."
  "$PYTHON" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

if [ "${1:-}" = "test" ]; then
  echo "[test] 安装测试依赖并运行 pytest ..."
  pip install -r requirements-dev.txt
  python -m pytest
  exit 0
fi

echo "[2/4] 安装核心运行依赖 ..."
pip install -r requirements.txt
echo "[3/4] 尝试安装可选 IoT 依赖（失败可跳过） ..."
if ! pip install -r requirements-iot.txt; then
  echo "[提示] 可选 IoT 依赖未安装，服务将以本地模拟模式运行。"
fi
echo "[4/4] 启动服务 http://127.0.0.1:8000 ..."
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
