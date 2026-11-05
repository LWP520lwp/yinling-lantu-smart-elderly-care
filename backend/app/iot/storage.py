"""IoT 数据访问层（SQLite 标准库实现）。

**本文件是唯一的持久化入口**：上层 :mod:`app.iot.processor` 与
:mod:`app.main` 只调用本模块的 ``insert_vitals`` / ``insert_alert`` /
``recent_vitals`` / ``recent_alerts`` / ``stats``，不直接接触 SQL。
云端切换 GaussDB（for Influx / MySQL）时，只需用同名函数替换本文件实现，
上层 processor / main 无需任何改动。

线程模型：
- AMQP 消费线程与 FastAPI 主线程会并发写入，因此**不使用**模块级共享连接；
- 每次操作 ``sqlite3.connect(path, timeout=10)``，``with conn:`` 自动提交，
  用完立即 ``close()``，由 SQLite 自身的文件锁串行化写入；
- 所有 ``sqlite3.Error`` 只记录日志并返回 ``False`` / 空列表，
  绝不让异常穿透到 WebSocket 广播链路（落库失败不应导致前端断流）。
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from ..config import get_settings

logger = logging.getLogger(__name__)

settings = get_settings()

# 建表语句：vitals 记录每一次上报，alerts 记录每条告警
_SCHEMA: str = """
CREATE TABLE IF NOT EXISTS vitals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    hr INT,
    sbp INT,
    dbp INT,
    spo2 INT,
    steps INT,
    battery INT,
    fall INT,
    sos INT,
    event_time INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vitals_event_time ON vitals(event_time);
CREATE INDEX IF NOT EXISTS idx_vitals_device_time ON vitals(device_id, event_time);

CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    device_id TEXT,
    elder_id TEXT,
    type TEXT,
    level TEXT,
    metric TEXT,
    event_time INTEGER,
    status TEXT,
    payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_event_time ON alerts(event_time);
"""

# 与 vitals 表列顺序一一对应，避免手写 SQL 时漏列
VITAL_COLUMNS: tuple = (
    "device_id",
    "hr",
    "sbp",
    "dbp",
    "spo2",
    "steps",
    "battery",
    "fall",
    "sos",
    "event_time",
)


# --------------------------------------------------------------------- 基础设施
def _connect() -> sqlite3.Connection:
    """建立一次短连接（调用方负责关闭）；``timeout=10`` 缓解并发写锁竞争。"""
    return sqlite3.connect(settings.iotdb_path, timeout=10)


def _to_int(value: Any, default: int = 0) -> int:
    """把设备上报的任意值安全转成 int（兼容 ``None`` / 空串 / ``"88"`` / 浮点）。"""
    if value is None or value == "":
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _format_time(event_time_ms: int) -> str:
    """毫秒时间戳 → ``YYYY-MM-DD HH:MM:SS``（本地时区）；非法值回退当前时间。"""
    try:
        moment = datetime.fromtimestamp(event_time_ms / 1000)
    except (OverflowError, OSError, ValueError):
        moment = datetime.now()
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def init_db() -> bool:
    """创建数据库目录与表结构；失败只记日志并返回 False。"""
    try:
        settings.iotdb_path.parent.mkdir(parents=True, exist_ok=True)
        with _connect() as conn:
            conn.executescript(_SCHEMA)
        logger.info("IoT 本地库就绪：%s", settings.iotdb_path)
        return True
    except (sqlite3.Error, OSError) as exc:
        logger.error("初始化 IoT 本地库失败：%s", exc)
        return False


# --------------------------------------------------------------------- 写入
def insert_vitals(frame: Dict[str, Any]) -> bool:
    """写入一条体征记录；``frame`` 缺字段时按 0 处理，``event_time`` 缺省取当前时间。"""
    event_time = _to_int(frame.get("event_time"), 0) or int(time.time() * 1000)
    values = (
        str(frame.get("device_id") or ""),
        _to_int(frame.get("hr")),
        _to_int(frame.get("sbp")),
        _to_int(frame.get("dbp")),
        _to_int(frame.get("spo2")),
        _to_int(frame.get("steps")),
        _to_int(frame.get("battery")),
        _to_int(frame.get("fall")),
        _to_int(frame.get("sos")),
        event_time,
    )
    placeholders = ", ".join("?" for _ in VITAL_COLUMNS)
    sql = (
        f"INSERT INTO vitals ({', '.join(VITAL_COLUMNS)}) "  # noqa: S608 - 列名固定
        f"VALUES ({placeholders})"
    )
    try:
        with _connect() as conn:
            conn.execute(sql, values)
        return True
    except sqlite3.Error as exc:
        logger.error("写入体征失败（device=%s）：%s", values[0], exc)
        return False


def insert_alert(alert: Dict[str, Any]) -> bool:
    """写入一条告警；``id`` 为主键，重试同一告警时覆盖而不是报错。

    ``payload`` 保存完整告警 JSON（含 ``elderName`` / ``handler`` / ``source``
    等展示字段），读取时原样还原，保证前端渲染所需结构不丢失。
    """
    alert_id = str(alert.get("id") or "")
    if not alert_id:
        logger.error("写入告警失败：缺少 id")
        return False
    event_time = _to_int(alert.get("event_time"), 0) or int(time.time() * 1000)
    try:
        payload = json.dumps(alert, ensure_ascii=False, default=str)
    except (TypeError, ValueError) as exc:
        logger.error("告警 %s 序列化失败：%s", alert_id, exc)
        return False

    values = (
        alert_id,
        str(alert.get("deviceId") or alert.get("device_id") or ""),
        str(alert.get("elderId") or alert.get("elder_id") or ""),
        str(alert.get("type") or ""),
        str(alert.get("level") or "normal"),
        str(alert.get("metric") or ""),
        event_time,
        str(alert.get("status") or "pending"),
        payload,
    )
    sql = (
        "INSERT OR REPLACE INTO alerts "
        "(id, device_id, elder_id, type, level, metric, event_time, status, payload) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    try:
        with _connect() as conn:
            conn.execute(sql, values)
        return True
    except sqlite3.Error as exc:
        logger.error("写入告警失败（id=%s）：%s", alert_id, exc)
        return False


# --------------------------------------------------------------------- 查询
def recent_vitals(device_id: str, limit: int = 20) -> List[Dict[str, Any]]:
    """按时间倒序返回某设备最近的体征记录（最多 ``limit`` 条）。

    ``device_id`` 为空串时返回全部设备的数据；返回字段与上报帧一致
    （``device_id`` / ``hr`` / ... / ``event_time``），便于前端直接复用渲染逻辑。
    """
    safe_limit = max(1, min(int(limit or 20), 1000))
    sql = (
        f"SELECT {', '.join(VITAL_COLUMNS)} FROM vitals"  # noqa: S608 - 列名固定
        " WHERE (? = '' OR device_id = ?)"
        " ORDER BY event_time DESC, id DESC LIMIT ?"
    )
    try:
        with _connect() as conn:
            cursor = conn.execute(sql, (device_id or "", device_id or "", safe_limit))
            rows = cursor.fetchall()
        return [dict(zip(VITAL_COLUMNS, row)) for row in rows]
    except sqlite3.Error as exc:
        logger.error("查询体征失败（device=%s）：%s", device_id, exc)
        return []


def recent_alerts(limit: int = 20) -> List[Dict[str, Any]]:
    """按时间倒序返回最近告警，结构与前端弹窗使用的告警对象完全一致。

    列字段优先，``payload`` 中的展示字段（``elderName`` / ``handler`` /
    ``source`` / ``time``）用于补齐；``payload`` 损坏时降级为列字段。
    """
    safe_limit = max(1, min(int(limit or 20), 1000))
    sql = (
        "SELECT id, device_id, elder_id, type, level, metric, event_time, status, payload "
        "FROM alerts ORDER BY event_time DESC, id DESC LIMIT ?"
    )
    try:
        with _connect() as conn:
            cursor = conn.execute(sql, (safe_limit,))
            rows = cursor.fetchall()
    except sqlite3.Error as exc:
        logger.error("查询告警失败：%s", exc)
        return []

    alerts: List[Dict[str, Any]] = []
    for row in rows:
        alert_id, device_id, elder_id, type_, level, metric, event_time, status, payload = row
        item: Dict[str, Any] = {}
        if payload:
            try:
                loaded = json.loads(payload)
                if isinstance(loaded, dict):
                    item.update(loaded)
            except (TypeError, ValueError):
                logger.debug("告警 %s 的 payload 解析失败，使用列字段", alert_id)
        item.update(
            {
                "id": alert_id,
                "time": item.get("time") or _format_time(_to_int(event_time)),
                "event_time": _to_int(event_time),
                "deviceId": device_id,
                "elderId": elder_id,
                "type": type_,
                "level": level,
                "metric": metric,
                "status": status,
            }
        )
        item.setdefault("elderName", settings.iotda_elder_name)
        item.setdefault("handler", "")
        item.setdefault("source", "iotda")
        alerts.append(item)
    return alerts


def stats() -> Dict[str, Any]:
    """返回计数快照，供 ``GET /api/iot/status`` 展示（不暴露任何密钥）。"""
    result: Dict[str, Any] = {
        "vitals_count": 0,
        "alerts_count": 0,
        "pending_alerts_count": 0,
    }
    try:
        with _connect() as conn:
            result["vitals_count"] = int(conn.execute("SELECT COUNT(*) FROM vitals").fetchone()[0])
            result["alerts_count"] = int(conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0])
            result["pending_alerts_count"] = int(
                conn.execute(
                    "SELECT COUNT(*) FROM alerts WHERE status = 'pending'"
                ).fetchone()[0]
            )
    except sqlite3.Error as exc:
        logger.error("统计 IoT 数据失败：%s", exc)
    return result


__all__ = [
    "init_db",
    "insert_vitals",
    "insert_alert",
    "recent_vitals",
    "recent_alerts",
    "stats",
]