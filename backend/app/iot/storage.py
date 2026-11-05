"""IoT 数据访问层（SQLite 标准库实现）。

**本文件是唯一的持久化入口**：上层 :mod:`app.iot.processor` 与
:mod:`app.main` 只调用本模块的 ``insert_vitals`` / ``insert_alert`` /
``recent_vitals`` / ``recent_alerts`` / ``insert_audit`` / ``recent_audits`` /
``stats``，不直接接触 SQL。
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

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    actor_id TEXT,
    actor_name TEXT,
    role TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    result TEXT,
    ip TEXT,
    detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_ts ON audit_logs(ts);
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

# 与 audit_logs 表列顺序一一对应
AUDIT_COLUMNS: tuple = (
    "id",
    "ts",
    "actor_id",
    "actor_name",
    "role",
    "action",
    "target_type",
    "target_id",
    "result",
    "ip",
    "detail",
)

# 审计 ID 主键冲突时的重试次数（并发写入或历史记录被删导致序号重号）
_AUDIT_ID_RETRY: int = 5


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


def _count_audit_today(conn: sqlite3.Connection, day: str) -> int:
    """统计当日已有审计记录数，作为 ``AU + YYYYMMDD + 4 位序号`` 的基数。"""
    row = conn.execute(
        "SELECT COUNT(*) FROM audit_logs WHERE id LIKE ?", (f"AU{day}%",)
    ).fetchone()
    return int(row[0]) if row else 0


def insert_audit(record: Dict[str, Any]) -> bool:
    """写入一条审计日志；``id`` 由本层生成，风格同告警：``AU + YYYYMMDD + 4 位序号``。

    ``ts`` 缺省取当前秒级时间戳；``detail`` 为 ``dict`` / ``list`` 时序列化为
    JSON 文本存储，``None`` 直接存 ``None``。并发写入或历史记录被删导致序号
    重号时递增序号重试，重试耗尽才返回 ``False``。
    """
    if not isinstance(record, dict):
        logger.error("写入审计失败：record 必须是 dict，实际为 %s", type(record).__name__)
        return False

    action = str(record.get("action") or "")
    if not action:
        logger.error("写入审计失败：缺少 action")
        return False

    try:
        ts = _to_int(record.get("ts"), 0) or int(time.time())
        detail = record.get("detail")
        if isinstance(detail, (dict, list)):
            detail = json.dumps(detail, ensure_ascii=False, default=str)
        elif detail is not None:
            detail = str(detail)
    except Exception as exc:  # noqa: BLE001 - 含 RecursionError，序列化失败只降级
        logger.error("审计记录预处理失败（action=%s）：%s", action, exc)
        return False

    try:
        day = datetime.fromtimestamp(ts).strftime("%Y%m%d")
    except (OverflowError, OSError, ValueError):
        day = datetime.now().strftime("%Y%m%d")

    sql = (
        "INSERT INTO audit_logs "
        "(id, ts, actor_id, actor_name, role, action, target_type, target_id, result, ip, detail) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    try:
        # 参数元组也放在 try 内：字段的 str() / 真值判断同样可能抛异常（如递归结构）
        values = (
            ts,
            str(record.get("actor_id") or ""),
            str(record.get("actor_name") or ""),
            str(record.get("role") or ""),
            action,
            str(record.get("target_type") or ""),
            str(record.get("target_id") or ""),
            str(record.get("result") or ""),
            str(record.get("ip") or ""),
            detail,
        )
        with _connect() as conn:
            seq = _count_audit_today(conn, day) + 1
            for attempt in range(_AUDIT_ID_RETRY):
                audit_id = f"AU{day}{seq + attempt:04d}"
                try:
                    conn.execute(sql, (audit_id,) + values)
                    return True
                except sqlite3.IntegrityError:
                    logger.warning("审计日志主键冲突，序号递增重试：%s", audit_id)
            logger.error("写入审计失败：连续 %d 次主键冲突（day=%s）", _AUDIT_ID_RETRY, day)
            return False
    except Exception as exc:  # noqa: BLE001 - 已含 sqlite3.Error，任何异常只记日志不外抛
        logger.error("写入审计失败（action=%s）：%s", action, exc)
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


def recent_audits(
    limit: int = 100,
    actor: Optional[str] = None,
    action: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """按 ``ts`` 倒序返回审计日志，``limit`` 限制在 1~500 之间。

    ``actor`` 非空时按 ``actor_id`` 精确过滤，``action`` 非空时按 ``action``
    精确过滤；``detail`` 能解析为 JSON 时还原为对象，否则原样返回字符串，
    便于前端直接渲染。
    """
    try:
        safe_limit = 100 if limit is None else int(limit)
    except (TypeError, ValueError):
        safe_limit = 100
    safe_limit = max(1, min(safe_limit, 500))

    sql = (
        "SELECT id, ts, actor_id, actor_name, role, action, target_type, "
        "target_id, result, ip, detail FROM audit_logs"
        " WHERE (? = '' OR actor_id = ?)"
        " AND (? = '' OR action = ?)"
        " ORDER BY ts DESC, id DESC LIMIT ?"
    )
    params = (actor or "", actor or "", action or "", action or "", safe_limit)
    try:
        with _connect() as conn:
            rows = conn.execute(sql, params).fetchall()
    except sqlite3.Error as exc:
        logger.error("查询审计日志失败：%s", exc)
        return []

    records: List[Dict[str, Any]] = []
    for row in rows:
        item = dict(zip(AUDIT_COLUMNS, row))
        detail = item.get("detail")
        if isinstance(detail, str) and detail:
            try:
                item["detail"] = json.loads(detail)
            except (TypeError, ValueError):
                logger.debug("审计 %s 的 detail 解析失败，保留原始字符串", item.get("id"))
        records.append(item)
    return records


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
    "insert_audit",
    "recent_vitals",
    "recent_alerts",
    "recent_audits",
    "stats",
]