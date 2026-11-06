"""SQLite 存储层 CRUD 与统计的单元测试（全部落在临时库）。"""

from __future__ import annotations


def test_vitals_insert_and_recent(isolated_storage) -> None:
    frame = {
        "device_id": "D1",
        "hr": 80,
        "sbp": 120,
        "dbp": 70,
        "spo2": 98,
        "event_time": 1_700_000_000_000,
    }
    assert isolated_storage.insert_vitals(frame) is True
    rows = isolated_storage.recent_vitals("D1")
    assert len(rows) == 1
    assert rows[0]["hr"] == 80
    assert rows[0]["device_id"] == "D1"


def test_alert_insert_and_recent(isolated_storage) -> None:
    alert = {
        "id": "AL202601010001",
        "deviceId": "D1",
        "elderId": "E01",
        "type": "hr",
        "level": "normal",
        "metric": "110 bpm",
        "event_time": 1_700_000_000_000,
        "status": "pending",
    }
    assert isolated_storage.insert_alert(alert) is True
    rows = isolated_storage.recent_alerts()
    assert len(rows) == 1
    assert rows[0]["id"] == alert["id"]
    assert rows[0]["type"] == "hr"


def test_audit_insert_filter_and_detail_restore(isolated_storage) -> None:
    assert isolated_storage.insert_audit(
        {"action": "login", "actor_id": "U001", "detail": {"k": 1}}
    ) is True
    assert isolated_storage.insert_audit(
        {"action": "logout", "actor_id": "U001"}
    ) is True

    all_logs = isolated_storage.recent_audits()
    assert len(all_logs) == 2

    login_only = isolated_storage.recent_audits(action="login")
    assert len(login_only) == 1
    assert login_only[0]["action"] == "login"
    # dict 型 detail 落库为 JSON，读取时还原为对象
    assert login_only[0]["detail"] == {"k": 1}


def test_stats_counts(isolated_storage) -> None:
    isolated_storage.insert_vitals(
        {"device_id": "D1", "hr": 80, "event_time": 1_700_000_000_000}
    )
    isolated_storage.insert_alert(
        {"id": "AL-X", "type": "hr", "event_time": 1_700_000_000_000}
    )
    snapshot = isolated_storage.stats()
    assert snapshot["vitals_count"] == 1
    assert snapshot["alerts_count"] == 1
    assert snapshot["pending_alerts_count"] == 1


def test_recent_returns_empty_on_fresh_db(isolated_storage) -> None:
    assert isolated_storage.recent_vitals("D1") == []
    assert isolated_storage.recent_alerts() == []
    assert isolated_storage.recent_audits() == []
