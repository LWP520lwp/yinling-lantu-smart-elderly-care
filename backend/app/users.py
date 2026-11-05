"""演示账号表与口令校验（纯标准库实现）。

设计要点：
1. 账号与前端 ``assets/js/data/mock.js`` 的 ``ACCOUNTS`` 一一对应（U001-U006），
   ``account`` / ``name`` / ``role`` / ``village`` / ``status`` 完全一致，
   方便演示时前端登录页与后端登录接口的结果互相对得上；
2. 口令不存明文：只保存 ``"salt_hex$hash_hex"`` 形式的哈希常量，算法为
   ``pbkdf2_hmac("sha256", password.encode(), salt_bytes, 120000)``；
3. 每个演示账号使用 16 字节固定 salt（预生成后硬编码），保证进程重启、
   多实例部署时哈希一致，也避免每次启动重复计算；
4. 本模块只依赖 ``hashlib`` / ``hmac`` / ``secrets``，不依赖 FastAPI 或
   pydantic，因此可以用纯标准库脚本直接单测。

安全提示：演示账号仅用于比赛演示，请勿用于生产环境；生产环境应改为
数据库存储 + 更严格的口令策略（长度 / 复杂度 / 定期更换）并配合登录限流。
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

# PBKDF2 迭代次数：与 OWASP 2023 对 PBKDF2-HMAC-SHA256 的建议下限一致
PBKDF2_ITERATIONS: int = 120000
# 每个账号独立 salt 的字节长度
SALT_BYTES: int = 16

# 演示口令统一在 backend/README.md 中说明（源码内不出现明文口令，只保存哈希）
_HASH_ADMIN: str = (
    "417ad35c198b32d8f645bbbabc582c96"
    "$e0009a1f7cc799f82a0990a5b9d4074c5acbb9356b477d26cea6f01f567066c9"
)
_HASH_SHEGONG01: str = (
    "8bc51388eed36c6280b2feef0cea54ef"
    "$351efc82d6f2bb503edf5dfd515cae40c72b079663ca7afa873fb93d41d1dcff"
)
_HASH_FAMILY01: str = (
    "eefe03e2957a61634f2f870edd7235fe"
    "$9123340e0457819a429b88e426225c16b32774cc677e4bbe4a4b263541ccd7e0"
)
_HASH_SHEGONG02: str = (
    "e64c3feac0b20149bf9049a2f0dccc00"
    "$266b87c4e671cdb88cc049891a9ebf36e076c2628a56b2f04aaaef489551b45d"
)
_HASH_SHEGONG03: str = (
    "6950d11e04f2142e894130239476452c"
    "$08dce8d9643813f63a403c890c7afdc54bf3290e4f2798663be0c3386fce76c8"
)
_HASH_SHEGONG04: str = (
    "9a9fea9fef9e22bd5f4dd04a40b99a04"
    "$c4bfd20c74c92734ffc41e94c6b2a309258446f37336ba716be5370d32f60083"
)

# 演示账号表：字段与前端 ACCOUNTS 对齐，另加 password_hash（不参与序列化）
USERS: list[dict] = [
    {
        "id": "U001",
        "name": "林晓岚",
        "account": "admin",
        "role": "admin",
        "village": "全域",
        "status": "active",
        "password_hash": _HASH_ADMIN,
    },
    {
        "id": "U002",
        "name": "蔡文静",
        "account": "shegong01",
        "role": "social",
        "village": "流水镇 · 北港村",
        "status": "active",
        "password_hash": _HASH_SHEGONG01,
    },
    {
        "id": "U003",
        "name": "林小雅",
        "account": "family01",
        "role": "family",
        "village": "流水镇 · 流水村",
        "status": "active",
        "password_hash": _HASH_FAMILY01,
    },
    {
        "id": "U004",
        "name": "念晓东",
        "account": "shegong02",
        "role": "social",
        "village": "北厝镇 · 北厝村",
        "status": "active",
        "password_hash": _HASH_SHEGONG02,
    },
    {
        "id": "U005",
        "name": "施小燕",
        "account": "shegong03",
        "role": "social",
        "village": "澳前镇 · 澳前村",
        "status": "active",
        "password_hash": _HASH_SHEGONG03,
    },
    {
        "id": "U006",
        "name": "魏丽云",
        "account": "shegong04",
        "role": "social",
        "village": "苏澳镇 · 苏澳村",
        "status": "disabled",
        "password_hash": _HASH_SHEGONG04,
    },
]


def hash_password(password: str, salt: bytes | None = None) -> str:
    """生成 ``"salt_hex$hash_hex"`` 格式的口令哈希。

    参数：
        password: 明文口令，按 UTF-8 编码后参与计算。
        salt: 16 字节随机盐；为空时现场随机生成（用于新增账号 / 改密场景）。
              演示账号使用的是上面硬编码的固定 salt。

    返回：
        形如 ``"<salt 的 32 位十六进制>$<哈希的 64 位十六进制>"`` 的字符串。
    """
    if not isinstance(password, str):
        raise TypeError("password 必须是字符串")
    if salt is None:
        salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
    )
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """校验明文口令与 ``"salt_hex$hash_hex"`` 哈希是否匹配。

    任何格式异常（缺分隔符、非十六进制、空盐 / 空哈希、类型不对）一律返回
    ``False``，不抛异常、不记录口令内容，避免脏数据把登录接口变成 500。
    比较使用 :func:`hmac.compare_digest`，耗时与内容无关。
    """
    if not isinstance(password, str) or not isinstance(stored, str):
        return False

    salt_hex, separator, hash_hex = stored.partition("$")
    if not separator or not salt_hex or not hash_hex:
        return False

    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except ValueError:
        return False
    if not salt or not expected:
        return False

    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
    )
    return hmac.compare_digest(digest, expected)


def find_by_account(account: str) -> dict | None:
    """按账号查找用户；找不到返回 ``None``。

    ``account`` 会去除首尾空白并统一小写（演示账号均为小写），
    因此前端传 ``Admin`` 或 `` admin `` 也能命中，但不能命中不存在的账号。
    返回的是 ``USERS`` 中的原始字典，调用方只读，禁止修改。
    """
    if not isinstance(account, str):
        return None
    key = account.strip().lower()
    if not key:
        return None
    for user in USERS:
        if user["account"] == key:
            return user
    return None