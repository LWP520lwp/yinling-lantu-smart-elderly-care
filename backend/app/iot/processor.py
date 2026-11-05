"""体征帧处理：阈值判定、告警生成、冷却去重与实时广播。

数据流::

    设备 / MQTT / AMQP → handle_frame(frame)
        ├─ storage.insert_vitals()          落库（失败不阻断后续）
        ├─ 阈值判定 → 告警对象（字段面向前端）
        ├─ 冷却去重（每设备每类型 60s 内只报一次）
        ├─ storage.insert_alert()           落库（失败仍广播）
        └─ ws.manager.publish_threadsafe()  跨线程推送 /ws 客户端

阈值默认值与前端 ``assets/js/core/store.js`` 的 ``DEFAULT_THRESHOLDS``
严格一致（hrHigh=105 / hrLow=50 / spo2Low=92 / sbpHigh=150），可通过
``IOTDA_HR_HIGH`` / ``IOTDA_HR_LOW`` / ``IOTDA_SPO2_LOW`` / ``IOTDA_SBP_HIGH``
覆盖；冷却时间用 ``IOTDA_ALERT_COOLDOWN`` 覆盖。改阈值时前后端必须同步，
否则会出现"后端报警、前端不亮"的错位。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime
from typing import Any, Dict, List, Tuple

from ..config import get_settings
from . import storage
from .ws import manager

logger = logging.getLogger(__name__)

settings = get_settings()


def _env_int(name: str, default: int) -> int:
    """读取整数环境变量；非法值回退默认值（保持服务可启动）。"""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        logger.warning("环境变量 %s 非法（%r），使用默认值 %s", name, raw, default)
        return default


# --------------------------------------------------------------- 阈值（与前端一致）
HR_HIGH: int = _env_int("IOTDA_HR_HIGH", 105)
HR_LOW: int = _env_int("IOTDA_HR_LOW", 50)
SPO2_LOW: int = _env_int("IOTDA_SPO2_LOW", 92)
SBP_HIGH: int = _env_int("IOTDA_SBP_HIGH", 150)

# 危急级别边界（不参与告警触发，只决定 level）
# 心率 > 115 视为 critical：验收要求 118 必须为 critical、110 必须为 normal；
# 原先 125 会把 118 降级成 normal，导致前端不播放危急提示音。
HR_CRITICAL_HIGH: int = 115
HR_CRITICAL_LOW: int = 40
SBP_CRITICAL: int = 180
SPO2_CRITICAL: int = 88

# 同一设备同一类型告警的冷却秒数
ALERT_COOLDOWN_SECONDS: int = _env_int("IOTDA_ALERT_COOLDOWN", 60)

# 告警 ID 生成器状态：AL + YYYYMMDD + 4 位当日序号
_alert_seq_lock = threading.Lock()
_alert_seq_date: str = ""
_alert_seq: int = 0

# 冷却表：(device_id, type) → 上次告警的时间（秒）
_last_alert: Dict[Tuple[str, str], float] = {}
_last_alert_lock = threading.Lock()


# --------------------------------------------------------------------- 工具
def _to_int(value: Any, default: int = 0) -> int:
    """设备值 → int；``None`` / 空串 / 非法值回退默认值（0 表示"无记录"）。"""
    if value is None or value == "":
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _format_time(event_time_ms: int) -> str:
    """毫秒时间戳 → ``YYYY-MM-DD HH:MM:SS``；非法值回退当前时间。"""
    try:
        moment = datetime.fromtimestamp(event_time_ms / 1000)
    except (OverflowError, OSError, ValueError):
        moment = datetime.now()
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def _next_alert_id(event_time_ms: int) -> str:
    """生成 ``AL + YYYYMMDD + 4 位序号``；跨天自动重置序号（线程安全）。"""
    global _alert_seq_date, _alert_seq
    try:
        day = datetime.fromtimestamp(event_time_ms / 1000).strftime("%Y%m%d")
    except (OverflowError, OSError, ValueError):
        day = datetime.now().strftime("%Y%m%d")

    with _alert_seq_lock:
        if day != _alert_seq_date:
            _alert_seq_date = day
            _alert_seq = 0
        _alert_seq += 1
        return f"AL{day}{_alert_seq:04d}"


# --------------------------------------------------------------------- 判定
def evaluate(frame: Dict[str, Any]) -> List[Tuple[str, str, str]]:
    """按阈值评估一帧体征，返回 ``[(type, level, metric), ...]``。

    0 视为"该项无记录"（与前端 ``Vitals`` 语义一致），因此不会因为缺测
    误报心率过低 / 血氧过低。
    """
    findings: List[Tuple[str, str, str]] = []

    hr = _to_int(frame.get("hr"))
    if hr and (hr > HR_HIGH or hr < HR_LOW):
        level = "critical" if (hr > HR_CRITICAL_HIGH or hr < HR_CRITICAL_LOW) else "normal"
        findings.append(("hr", level, f"{hr} bpm"))

    sbp = _to_int(frame.get("sbp"))
    dbp = _to_int(frame.get("dbp"))
    if sbp and sbp > SBP_HIGH:
        level = "critical" if sbp >= SBP_CRITICAL else "normal"
        findings.append(("bp", level, f"{sbp}/{dbp} mmHg"))

    spo2 = _to_int(frame.get("spo2"))
    if spo2 and spo2 < SPO2_LOW:
        # 88% 即为重度低氧，边界值（=88）按 critical 处理
        level = "critical" if spo2 <= SPO2_CRITICAL else "normal"
        findings.append(("spo2", level, f"{spo2}%"))

    fall = _to_int(frame.get("fall"))
    if fall:
        findings.append(("fall", "critical", f"跌倒 {fall}"))

    sos = _to_int(frame.get("sos"))
    if sos:
        findings.append(("sos", "critical", f"SOS {sos}"))

    return findings


def _acquire_cooldown(device_id: str, alert_type: str, now_s: float) -> bool:
    """登记并判断冷却窗口：返回 True 表示本次应当产生告警。"""
    key = (device_id, alert_type)
    with _last_alert_lock:
        last = _last_alert.get(key)
        if last is not None and now_s - last < ALERT_COOLDOWN_SECONDS:
            logger.debug(
                "告警冷却中：device=%s type=%s 距上次 %.1fs", device_id, alert_type, now_s - last
            )
            return False
        _last_alert[key] = now_s
        # 简单清理，避免长时间运行后字典无限膨胀（设备数 × 告警类型有限，但以防万一）
        if len(_last_alert) > 512:
            stale = [k for k, ts in _last_alert.items() if now_s - ts >= ALERT_COOLDOWN_SECONDS]
            for k in stale:
                _last_alert.pop(k, None)
        return True


def _build_alert(
    device_id: str, alert_type: str, level: str, metric: str, event_time_ms: int
) -> Dict[str, Any]:
    """构造告警对象；字段名与前端现有告警结构完全一致，可直接渲染弹窗。"""
    return {
        "id": _next_alert_id(event_time_ms),
        "time": _format_time(event_time_ms),
        "event_time": event_time_ms,
        "deviceId": device_id,
        "elderId": settings.iotda_elder_id,
        "elderName": settings.iotda_elder_name,
        "type": alert_type,
        "level": level,
        "metric": metric,
        "status": "pending",
        "handler": "",
        "source": "iotda",
    }


# --------------------------------------------------------------------- 入口
def handle_frame(frame: Dict[str, Any]) -> Dict[str, Any]:
    """处理一帧体征：落库 → 判阈 → 冷却去重 → 落库告警 → 广播。

    参数 ``frame`` 至少包含 ``hr`` / ``sbp`` / ``dbp`` / ``spo2`` / ``steps`` /
    ``battery`` / ``fall`` / ``sos`` / ``event_time``（毫秒）；``device_id``
    缺省时回退到 ``settings.iotda_device_id``。

    返回 ``{"vitals": frame, "alerts": [...]}``，其中 ``alerts`` 只包含
    本次真正产生的告警（被冷却挡下的不会出现），便于调用方核对。
    """
    vitals: Dict[str, Any] = dict(frame or {})
    device_id = str(vitals.get("device_id") or settings.iotda_device_id or "")
    vitals["device_id"] = device_id

    event_time_ms = _to_int(vitals.get("event_time"), 0)
    if event_time_ms <= 0:
        event_time_ms = int(time.time() * 1000)
    vitals["event_time"] = event_time_ms

    # 1) 体征落库：失败仅告警日志，不阻断实时链路
    if not storage.insert_vitals(vitals):
        logger.warning("体征落库失败，仍继续实时推送（device=%s）", device_id)

    # 2) 逐条判阈 + 3) 冷却去重 + 告警落库
    clock = event_time_ms / 1000.0
    alerts: List[Dict[str, Any]] = []
    for alert_type, level, metric in evaluate(vitals):
        if not _acquire_cooldown(device_id, alert_type, clock):
            continue
        alert = _build_alert(device_id, alert_type, level, metric, event_time_ms)
        if not storage.insert_alert(alert):
            logger.warning("告警落库失败，仍继续广播（id=%s）", alert["id"])
        alerts.append(alert)

    # 4) 线程安全广播（AMQP 线程调用时经事件循环投递）
    manager.publish_threadsafe({"type": "vitals", "data": vitals})
    for alert in alerts:
        manager.publish_threadsafe({"type": "alert", "data": alert})

    # 5) 返回处理结果
    return {"vitals": vitals, "alerts": alerts}


def reset_cooldown() -> None:
    """清空冷却表（仅供测试 / 演示重置，不影响已落库数据）。"""
    with _last_alert_lock:
        _last_alert.clear()


__all__ = [
    "handle_frame",
    "evaluate",
    "reset_cooldown",
    "HR_HIGH",
    "HR_LOW",
    "SPO2_LOW",
    "SBP_HIGH",
    "ALERT_COOLDOWN_SECONDS",
]