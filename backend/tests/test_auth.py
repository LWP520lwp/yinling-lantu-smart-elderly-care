"""HMAC 无状态 token 与登录限流的单元测试。"""

from __future__ import annotations

import json
import time
import types

import pytest

from app import auth
from app.users import USERS


def _fixed_settings(secret: str = "unit-secret", ttl: int = 28800) -> types.SimpleNamespace:
    """构造固定密钥 / TTL 的配置，保证签名结果可复现。"""
    return types.SimpleNamespace(auth_secret=secret, auth_ttl_seconds=ttl)


# --------------------------------------------------------------------------- token
def test_create_and_verify_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """签发后可验签，payload 字段与用户一致，exp 与返回值相等。"""
    monkeypatch.setattr(auth, "get_settings", lambda: _fixed_settings())
    user = USERS[0]
    token, expires_at = auth.create_token(user)

    payload = auth.verify_token(token)
    assert payload is not None
    assert payload["sub"] == user["id"]
    assert payload["account"] == user["account"]
    assert payload["role"] == user["role"]
    assert payload["exp"] == expires_at


def test_verify_rejects_tampered_signature(monkeypatch: pytest.MonkeyPatch) -> None:
    """签名段被改动后验签失败。"""
    monkeypatch.setattr(auth, "get_settings", lambda: _fixed_settings())
    token, _ = auth.create_token(USERS[0])
    head, _, signature = token.rpartition(".")
    # 解码签名、翻转首字节后重新编码，保证 HMAC 必然不匹配
    signature_bytes = auth._b64decode(signature)
    broken = auth._b64encode(bytes([signature_bytes[0] ^ 0xFF]) + signature_bytes[1:])
    assert auth.verify_token(f"{head}.{broken}") is None


def test_verify_rejects_wrong_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """用不同密钥签发的 token 无法通过验签。"""
    monkeypatch.setattr(auth, "get_settings", lambda: _fixed_settings(secret="secret-a"))
    token, _ = auth.create_token(USERS[0])
    monkeypatch.setattr(auth, "get_settings", lambda: _fixed_settings(secret="secret-b"))
    assert auth.verify_token(token) is None


def test_verify_rejects_expired_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """手工构造 exp 已过期的 token，验签返回 None。"""
    monkeypatch.setattr(auth, "get_settings", lambda: _fixed_settings())
    now = int(time.time())
    payload = {
        "sub": "U001",
        "account": "admin",
        "role": "admin",
        "iat": now - 1000,
        "exp": now - 1,
    }
    payload_bytes = json.dumps(
        payload, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    expired = (
        f"{auth._b64encode(payload_bytes)}."
        f"{auth._b64encode(auth._sign(payload_bytes))}"
    )
    assert auth.verify_token(expired) is None


@pytest.mark.parametrize("bad_token", ["", "no-dot", "a.b.c", "!!!.###"])
def test_verify_rejects_malformed_token(
    monkeypatch: pytest.MonkeyPatch, bad_token: str
) -> None:
    """空串、分段数错误、非法 base64 一律返回 None。"""
    monkeypatch.setattr(auth, "get_settings", lambda: _fixed_settings())
    assert auth.verify_token(bad_token) is None


# --------------------------------------------------------------------------- check_payload
def test_check_payload_valid(monkeypatch: pytest.MonkeyPatch) -> None:
    """有效账号的 payload 通过联合校验，返回用户字典。"""
    monkeypatch.setattr(auth, "get_settings", lambda: _fixed_settings())
    token, _ = auth.create_token(USERS[0])
    payload = auth.verify_token(token)
    assert auth.check_payload(payload)["id"] == "U001"


def test_check_payload_disabled_account(monkeypatch: pytest.MonkeyPatch) -> None:
    """停用账号即便 token 未过期，也被联合校验拦截。"""
    monkeypatch.setattr(auth, "get_settings", lambda: _fixed_settings())
    disabled = next(user for user in USERS if user["status"] == "disabled")
    token, _ = auth.create_token(disabled)
    payload = auth.verify_token(token)
    assert auth.check_payload(payload) is None


def test_check_payload_role_mismatch() -> None:
    """token 角色与用户表不一致时返回 None。"""
    assert auth.check_payload({"account": "admin", "role": "family"}) is None


def test_check_payload_invalid_input() -> None:
    """非字典 / 缺账号字段返回 None。"""
    assert auth.check_payload(None) is None
    assert auth.check_payload({}) is None


# --------------------------------------------------------------------------- 限流
def test_register_failure_locks_after_max_failures() -> None:
    """第 5 次失败触发锁定，锁定后 is_locked 返回正秒数。"""
    account = "lock-me"
    for _ in range(auth.MAX_FAILURES - 1):
        assert auth.register_failure(account) is False
        assert auth.is_locked(account) == 0
    assert auth.register_failure(account) is True
    assert auth.is_locked(account) > 0


def test_lock_expires_after_window() -> None:
    """锁到期时间挪到过去后，is_locked 自动归零放行。"""
    account = "expire-me"
    for _ in range(auth.MAX_FAILURES):
        auth.register_failure(account)
    assert auth.is_locked(account) > 0
    auth._failures[account]["locked_until"] = 0.0
    assert auth.is_locked(account) == 0


def test_reset_failures_clears_state() -> None:
    """reset_failures 清空计数与锁定。"""
    account = "reset-me"
    auth.register_failure(account)
    auth.reset_failures(account)
    assert account not in auth._failures
    assert auth.is_locked(account) == 0


def test_failure_key_is_case_insensitive() -> None:
    """同一账号的大小写 / 空白形式共用一个计数键。"""
    auth.register_failure("  UserX ")
    assert "userx" in auth._failures
