"""账号表与口令哈希的单元测试（纯标准库逻辑）。"""

from __future__ import annotations

from app import users


def test_hash_password_format_and_random_salt() -> None:
    """哈希为 salt_hex$hash_hex；随机盐使同一口令两次结果不同。"""
    first = users.hash_password("123456")
    second = users.hash_password("123456")
    assert first != second

    salt_hex, separator, hash_hex = first.partition("$")
    assert separator == "$"
    assert len(salt_hex) == users.SALT_BYTES * 2  # 16 字节 → 32 位十六进制
    assert len(hash_hex) == 64


def test_verify_password_roundtrip() -> None:
    """正确口令通过、错误口令拒绝。"""
    stored = users.hash_password("S3cret!")
    assert users.verify_password("S3cret!", stored) is True
    assert users.verify_password("wrong-password", stored) is False


def test_demo_account_password_matches() -> None:
    """演示账号口令统一为 123456，哈希可正确校验。"""
    admin = users.find_by_account("admin")
    assert users.verify_password("123456", admin["password_hash"]) is True


def test_verify_password_malformed_hash() -> None:
    """脏哈希一律返回 False，不抛异常。"""
    assert users.verify_password("x", "no-delimiter") is False
    assert users.verify_password("x", "abc$xyz") is False  # 非十六进制
    assert users.verify_password("x", "$") is False
    assert users.verify_password("x", "") is False


def test_find_by_account_normalization() -> None:
    """账号大小写不敏感、去首尾空白；不存在或为空返回 None。"""
    assert users.find_by_account("  ADMIN ")["id"] == "U001"
    assert users.find_by_account("shegong01")["account"] == "shegong01"
    assert users.find_by_account("not-exist") is None
    assert users.find_by_account("") is None
    assert users.find_by_account(None) is None
