"""pytest 全局夹具与路径引导。

设计要点：
1. 把 ``backend/`` 目录加入 ``sys.path``，保证无论从哪个工作目录执行
   ``python -m pytest`` 都能导入 ``app`` 包；
2. :func:`isolated_storage` 把存储层的库路径替换为临时 SQLite，
   测试结束后随 ``tmp_path`` 自动清理，**绝不污染** 默认的 ``data/iot.db``；
3. 自动夹具 :func:`_reset_auth_state` 在每个用例前后清空登录失败计数与
   进程内随机密钥，避免用例之间互相串状态。
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

# backend/ 目录（tests/conftest.py 的上一级），加入模块搜索路径
BACKEND_DIR: Path = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app import auth  # noqa: E402  (需在 sys.path 引导之后导入)
from app.iot import storage  # noqa: E402


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    """每个用例独占的临时 SQLite 文件路径。"""
    return tmp_path / "test_iot.db"


@pytest.fixture
def isolated_storage(monkeypatch: pytest.MonkeyPatch, db_path: Path):
    """把存储层模块级 ``settings.iotdb_path`` 指向临时库并完成建表。

    ``storage._connect()`` 直接读取模块级 ``settings``，因此这里替换
    ``storage.settings`` 即可让所有读写都落到临时库，返回存储模块本身。
    """
    monkeypatch.setattr(
        storage,
        "settings",
        types.SimpleNamespace(iotdb_path=db_path, iotda_elder_name="张桂芳"),
    )
    assert storage.init_db() is True
    return storage


@pytest.fixture(autouse=True)
def _reset_auth_state() -> None:
    """每个用例前后重置认证内存状态（失败计数 + 随机密钥）。"""
    auth._failures.clear()
    auth._RANDOM_SECRET = ""
    yield
    auth._failures.clear()
    auth._RANDOM_SECRET = ""
