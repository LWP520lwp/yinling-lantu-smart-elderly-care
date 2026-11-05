"""认证核心逻辑：无状态 token 签发 / 校验 + 登录限流（纯标准库）。

设计要点：
1. token 采用 ``base64url(payload_json).base64url(HMAC-SHA256)`` 两段式，
   不引入 JWT / passlib / bcrypt 等第三方库：
   - payload 为 JSON（``sort_keys=True`` + 紧凑分隔符），保证同一输入签名字节一致；
   - 两段均去掉 base64 的 ``=`` 填充，避免放进 URL / 环境变量时被截断；
   - 校验使用 :func:`hmac.compare_digest`，避免时序侧信道。
2. 密钥来自 ``AUTH_SECRET``；未配置时**进程内只随机生成一次**并缓存到
   模块级 ``_RANDOM_SECRET``，只在首次生成时打一条 warning（绝不输出密钥）。
   随机密钥重启即变，因此旧 token 会全部失效，属于可接受的安全默认值。
3. 登录限流为进程内内存字典：同一账号连续失败 5 次锁 60 秒；锁定期内
   :func:`is_locked` 返回剩余秒数，调用方据此直接返回 429，不重新计时；
   到期后自动清零放行。
4. 本模块**不导入 fastapi**（依赖注入函数放在 :mod:`app.main`），因此可以用
   纯标准库脚本直接单测 token / 限流逻辑。
5. token 是无状态的：签名 + ``exp`` 只能证明"签发时有效"，无法表达"之后被
   停用 / 删除 / 改角色"。因此 :func:`check_payload` 在验签通过后再与用户表
   比对账号状态，实现权限变更后的**即时撤销**（见 ``main.require_auth``）。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import math
import secrets
import threading
import time

from .config import get_settings
from .users import find_by_account

logger = logging.getLogger(__name__)

# token 有效期兜底范围（秒）：配置层已做校验，这里再夹一次，防御性编程
MIN_TOKEN_TTL: int = 300
MAX_TOKEN_TTL: int = 604800
DEFAULT_TOKEN_TTL: int = 28800

# 登录限流参数
MAX_FAILURES: int = 5
LOCK_SECONDS: float = 60.0
# token 最大长度：超长直接判失败，避免异常输入带来无谓的 HMAC 计算
MAX_TOKEN_LENGTH: int = 4096

# 未配置 AUTH_SECRET 时进程内随机生成的密钥（只在内存中，不落盘、不记日志）
_RANDOM_SECRET: str = ""
_RANDOM_SECRET_LOCK = threading.Lock()

# 登录失败计数：{account: {"count": int, "locked_until": float 时间戳}}
_failures: dict[str, dict] = {}
_failures_lock = threading.Lock()


class AuthError(Exception):
    """鉴权 / 登录失败异常，由 ``main.py`` 的异常处理器渲染为统一错误体。

    属性：
        status_code: HTTP 状态码（401 / 403 / 423 / 429）。
        code: 机器可读错误码，供前端分支判断。
        detail: 面向用户的中文提示，不含任何凭据信息。
    """

    def __init__(self, status_code: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.detail = detail


# --------------------------------------------------------------------------- 密钥
def auth_secret() -> str:
    """返回 token 签名密钥。

    优先使用 ``settings.auth_secret``；为空时取模块级随机密钥，首次生成时
    打一条中文 warning 提示"重启后旧 token 全部失效"。日志中只有提示语，
    不包含密钥本身。
    """
    configured = get_settings().auth_secret.strip()
    if configured:
        return configured

    global _RANDOM_SECRET
    if _RANDOM_SECRET:
        return _RANDOM_SECRET

    with _RANDOM_SECRET_LOCK:
        # 双重检查：并发首次调用时只生成一次
        if not _RANDOM_SECRET:
            _RANDOM_SECRET = secrets.token_hex(32)
            logger.warning("未配置 AUTH_SECRET，已随机生成，重启后旧 token 全部失效")
        return _RANDOM_SECRET


def token_ttl() -> int:
    """返回 token 有效期（秒），并夹在 ``[300, 604800]`` 区间内。"""
    try:
        ttl = int(get_settings().auth_ttl_seconds)
    except (TypeError, ValueError):
        return DEFAULT_TOKEN_TTL
    return max(MIN_TOKEN_TTL, min(MAX_TOKEN_TTL, ttl))


# --------------------------------------------------------------------------- 编码
def _b64encode(raw: bytes) -> str:
    """base64url 编码并去掉 ``=`` 填充符号。"""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(text: str) -> bytes:
    """还原 base64url 编码；非法字符 / 非法长度抛 ``ValueError``。

    调用方是 :func:`verify_token`，所有异常都会在该函数内被吞掉。
    """
    if not text:
        raise ValueError("空字符串无法解码")
    padding = "=" * (-len(text) % 4)
    return base64.b64decode(
        (text + padding).encode("ascii"),
        altchars=b"-_",
        validate=True,
    )


def _sign(payload_bytes: bytes) -> bytes:
    """对 payload 原始字节做 HMAC-SHA256。"""
    return hmac.new(
        auth_secret().encode("utf-8"),
        payload_bytes,
        hashlib.sha256,
    ).digest()


# --------------------------------------------------------------------------- 签发
def create_token(user: dict) -> tuple[str, int]:
    """为登录成功的用户签发 token。

    参数：
        user: :mod:`app.users` 中的用户字典，至少包含 ``id`` / ``account`` / ``role``。

    返回：
        ``(token, expires_at)``，``expires_at`` 为秒级 UTC 时间戳整数。
    """
    now = int(time.time())
    expires_at = now + token_ttl()
    payload = {
        "sub": str(user["id"]),
        "account": str(user["account"]),
        "role": str(user["role"]),
        "iat": now,
        "exp": expires_at,
    }
    payload_bytes = json.dumps(
        payload,
        separators=(",", ":"),
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")
    token = f"{_b64encode(payload_bytes)}.{_b64encode(_sign(payload_bytes))}"
    return token, expires_at


# --------------------------------------------------------------------------- 校验
def verify_token(token: str | None) -> dict | None:
    """校验 token 并返回 payload；任一环节失败返回 ``None``。

    校验顺序：类型 / 长度 → 分段数 → base64 解码 → 签名比对 → JSON 解析
    → 必备字段与 ``exp`` 过期。**不抛异常、不记录 token 内容**，避免把
    不可信输入写进日志。
    """
    if not isinstance(token, str) or not token or len(token) > MAX_TOKEN_LENGTH:
        return None

    parts = token.split(".")
    if len(parts) != 2:
        return None
    payload_part, signature_part = parts
    if not payload_part or not signature_part:
        return None

    try:
        payload_bytes = _b64decode(payload_part)
        signature = _b64decode(signature_part)
    except (ValueError, UnicodeError):
        return None

    if not hmac.compare_digest(signature, _sign(payload_bytes)):
        return None

    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None

    subject = payload.get("sub")
    expires_at = payload.get("exp")
    if not isinstance(subject, str) or not subject:
        return None
    # bool 是 int 的子类，必须单独排除
    if not isinstance(expires_at, int) or isinstance(expires_at, bool):
        return None
    if expires_at <= int(time.time()):
        return None
    return payload


def check_payload(payload: dict | None) -> dict | None:
    """校验 token payload 对应的账号"此刻"仍然有效。

    无状态 token 只能证明签发时的身份，账号在有效期内被停用、删除或改角色时，
    旧 token 仍能通过签名 / ``exp`` 校验。这里再查一次用户表做联合校验：

    - ``payload`` 为 ``None`` / 非字典 -> ``None``；
    - 账号不存在（被删除）-> ``None``；
    - ``status != "active"``（即 ``disabled`` 等）-> ``None``；
    - token 中 ``role`` 与用户表不一致（角色被调整 / 伪造场景）-> ``None``；
    - 其余情况返回用户表中的用户字典。

    只做纯内存比较，不修改任何状态，也不记录 token 内容。
    """
    if not isinstance(payload, dict):
        return None

    account = payload.get("account")
    if not isinstance(account, str) or not account:
        return None

    user = find_by_account(account)
    if user is None:
        return None
    if user.get("status") != "active":
        return None
    if user.get("role") != payload.get("role"):
        return None
    return user


# --------------------------------------------------------------------------- 限流
def _failure_key(account: str) -> str:
    """限流字典的 key：去空白 + 小写，防止用大小写绕过计数。"""
    return account.strip().lower() if isinstance(account, str) else ""


def register_failure(account: str) -> bool:
    """记录一次登录失败，返回是否因此触发锁定。

    同一账号累计失败达到 :data:`MAX_FAILURES`（5）次即锁定
    :data:`LOCK_SECONDS`（60）秒；若上次锁定已到期，计数先清零再累计。
    """
    key = _failure_key(account)
    now = time.time()
    with _failures_lock:
        entry = _failures.get(key) or {"count": 0, "locked_until": 0.0}
        if entry["locked_until"] and now >= float(entry["locked_until"]):
            entry = {"count": 0, "locked_until": 0.0}

        entry["count"] = int(entry["count"]) + 1
        if entry["count"] >= MAX_FAILURES:
            entry["locked_until"] = now + LOCK_SECONDS
            _failures[key] = entry
            return True

        _failures[key] = entry
        return False


def is_locked(account: str) -> int:
    """返回账号剩余锁定秒数；未锁定或有可用次数时返回 0。

    锁定期内重复调用不会顺延锁定期（不重新计时）；到期后自动清零放行。
    """
    key = _failure_key(account)
    now = time.time()
    with _failures_lock:
        entry = _failures.get(key)
        if not entry:
            return 0

        locked_until = float(entry.get("locked_until") or 0.0)
        if locked_until <= now:
            if locked_until:
                entry["count"] = 0
                entry["locked_until"] = 0.0
            return 0

        return max(1, int(math.ceil(locked_until - now)))


def reset_failures(account: str) -> None:
    """登录成功后清空该账号的失败计数与锁定期。"""
    key = _failure_key(account)
    with _failures_lock:
        _failures.pop(key, None)