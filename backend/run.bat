@echo off
rem ============================================================
rem 银龄岚途 FastAPI 后端一键启动脚本（Windows）
rem 用法：
rem   run.bat        启动 Web 服务（自动建虚拟环境、装依赖）
rem   run.bat test   运行 pytest 后端测试
rem ============================================================
setlocal
cd /d "%~dp0"

rem 选择 Python 解释器：优先 py 启动器，其次 PATH 中的 python
set "PY=py -3"
%PY% --version >nul 2>&1
if errorlevel 1 (
    set "PY=python"
)

rem 首次运行创建虚拟环境
if not exist ".venv\Scripts\python.exe" (
    echo [1/4] 正在创建虚拟环境 .venv ...
    %PY% -m venv .venv
)
set "VENV_PY=.venv\Scripts\python.exe"

if /i "%~1"=="test" (
    echo [test] 安装测试依赖并运行 pytest ...
    "%VENV_PY%" -m pip install -r requirements-dev.txt
    "%VENV_PY%" -m pytest
    goto :end
)

echo [2/4] 安装核心运行依赖 ...
"%VENV_PY%" -m pip install -r requirements.txt
echo [3/4] 尝试安装可选 IoT 依赖（失败可跳过） ...
"%VENV_PY%" -m pip install -r requirements-iot.txt
if errorlevel 1 (
    echo [提示] 可选 IoT 依赖未安装，服务将以本地模拟模式运行。
)
echo [4/4] 启动服务 http://127.0.0.1:8000 ...
"%VENV_PY%" -m uvicorn app.main:app --host 127.0.0.1 --port 8000

:end
endlocal
