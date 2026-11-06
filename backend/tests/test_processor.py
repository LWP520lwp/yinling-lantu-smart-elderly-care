"""体征帧阈值判定、告警冷却与 handle_frame 链路的单元测试。"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from app.iot import processor

# 固定毫秒时间基准，配合 event_time 精确控制冷却窗口，无需真实 sleep
BASE_TS: int = 1_700_000_000_000


def make_frame(**overrides: Any) -> Dict[str, Any]:
    """构造一帧体征，默认全部正常，可通过关键字参数覆盖任意字段。"""
    frame = {
        "device_id": "D-TEST",
        "hr": 78,
        "sbp": 122,
        "dbp": 78,
        "spo2": 97,
        "steps": 100,
        "battery": 90,
        "fall": 0,
        "sos": 0,
        "event_time": BASE_TS,
    }
    frame.update(overrides)
    return frame


# --------------------------------------------------------------------------- evaluate
def test_normal_frame_has_no_finding() -> None:
    assert processor.evaluate(make_frame()) == []


def test_hr_high_normal_level() -> None:
    assert processor.evaluate(make_frame(hr=110)) == [("hr", "normal", "110 bpm")]


def test_hr_critical_high() -> None:
    assert processor.evaluate(make_frame(hr=120))[0][0:2] == ("hr", "critical")


def test_hr_low_and_critical_low() -> None:
    assert processor.evaluate(make_frame(hr=45))[0][0:2] == ("hr", "normal")
    assert processor.evaluate(make_frame(hr=35))[0][0:2] == ("hr", "critical")


def test_spo2_thresholds_and_boundary() -> None:
    assert processor.evaluate(make_frame(spo2=90))[0][0:2] == ("spo2", "normal")
    assert processor.evaluate(make_frame(spo2=88))[0][1] == "critical"  # 边界 88
    assert processor.evaluate(make_frame(spo2=85))[0][1] == "critical"


def test_bp_thresholds() -> None:
    assert processor.evaluate(make_frame(sbp=160))[0][0:2] == ("bp", "normal")
    assert processor.evaluate(make_frame(sbp=190))[0][1] == "critical"


def test_fall_and_sos_are_critical() -> None:
    assert processor.evaluate(make_frame(fall=1))[0][0:2] == ("fall", "critical")
    assert processor.evaluate(make_frame(sos=1))[0][0:2] == ("sos", "critical")


def test_missing_values_do_not_alert() -> None:
    """数值为 0 表示无记录，不会误报过低。"""
    assert processor.evaluate(make_frame(hr=0, sbp=0, spo2=0)) == []


# --------------------------------------------------------------------------- handle_frame
def test_handle_frame_persists_and_alerts(isolated_storage) -> None:
    """首次异常产生告警并落库；冷却窗口内第二次只落体征、不重复告警。"""
    processor.reset_cooldown()
    first = processor.handle_frame(make_frame(hr=110))
    assert len(first["alerts"]) == 1

    second = processor.handle_frame(make_frame(hr=110, event_time=BASE_TS + 10_000))
    assert second["alerts"] == []

    # 两帧体征均已落库，告警只有一条
    assert len(isolated_storage.recent_vitals("D-TEST", limit=10)) == 2
    assert len(isolated_storage.recent_alerts(limit=10)) == 1


def test_cooldown_reset_allows_new_alert(isolated_storage) -> None:
    """reset_cooldown 后，冷却窗口内也能再次产生告警。"""
    processor.reset_cooldown()
    processor.handle_frame(make_frame(hr=110))
    processor.handle_frame(make_frame(hr=110, event_time=BASE_TS + 10_000))
    processor.reset_cooldown()
    third = processor.handle_frame(make_frame(hr=110, event_time=BASE_TS + 20_000))
    assert len(third["alerts"]) == 1


def test_alert_after_cooldown_window_passes(isolated_storage) -> None:
    """事件时间超过 60 秒冷却窗口，再次产生告警。"""
    processor.reset_cooldown()
    processor.handle_frame(make_frame(hr=110))
    later = processor.handle_frame(make_frame(hr=110, event_time=BASE_TS + 61_000))
    assert len(later["alerts"]) == 1


def test_fall_is_also_subject_to_cooldown(isolated_storage) -> None:
    """跌倒与其他类型一样受冷却约束（不存在旁路）。"""
    processor.reset_cooldown()
    first = processor.handle_frame(make_frame(fall=1))
    assert len(first["alerts"]) == 1
    second = processor.handle_frame(make_frame(fall=1, event_time=BASE_TS + 10_000))
    assert second["alerts"] == []


def test_alert_object_structure(isolated_storage) -> None:
    """告警字段与前端结构对齐，默认待处理、来源为 iotda。"""
    processor.reset_cooldown()
    alert = processor.handle_frame(make_frame(hr=110))["alerts"][0]
    assert alert["id"].startswith("AL")
    assert alert["type"] == "hr"
    assert alert["level"] == "normal"
    assert alert["status"] == "pending"
    assert alert["source"] == "iotda"
    assert alert["deviceId"] == "D-TEST"
    assert alert["elderId"] == "E01"
    assert alert["elderName"] == "张桂芳"
