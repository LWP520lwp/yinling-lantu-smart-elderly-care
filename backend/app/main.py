"""FastAPI 应用入口。

路由：
- ``GET  /api/health``         ：健康检查，返回是否启用了真实大模型（公开）；
- ``POST /api/auth/login``     ：账号口令登录，签发 HMAC 无状态 token（公开）；
- ``GET  /api/auth/me``        ：当前登录用户信息（需 Bearer token）；
- ``POST /api/chat``           ：SSE 流式对话（需登录），事件格式见 :mod:`app.llm`；
- ``GET  /api/iot/status``     ：IoT 链路状态与本地库计数（需登录，不泄露密钥）；
- ``POST /api/device/command`` ：云端命令下发（仅 admin，IAM 取 token + IoTDA v5）；
- ``POST /api/audit``          ：前端上报业务操作审计（需登录）；
- ``GET  /api/audit/logs``     ：审计日志查询（仅 admin）；
- ``WS   /ws?token=<token>``   ：实时体征 / 告警推送（token 校验失败 close 1008）。

设计要点：
- CORS 按 ``CORS_ORIGINS`` 白名单放行（默认含 ``null``，保证双击 html 演示可用），
  仅显式配置 ``*`` 时才放开全部来源并强制 ``allow_credentials=False``（规范要求）；
- 鉴权以 ``Depends`` 实现，**先于**业务逻辑执行：因此未配置 AK/SK 时 admin 调
  命令接口返回 503，而非 admin 直接 403；
- token 是无状态签名：``require_auth`` 在验签之后再与用户表比对，账号被停用 /
  删除 / 改角色后旧 token **立即失效**，无需等待 8 小时过期；
- 鉴权失败统一抛 :class:`app.auth.AuthError`，由异常处理器渲染为
  ``{"code", "detail"}``，保证 401 / 403 / 423 / 429 的响应体结构一致；
- SSE 生成器内部再包一层 try/except，任何异常都不会让连接以 500 崩溃；
- 响应头显式声明 ``cache-control: no-cache`` 与 ``x-accel-buffering: no``，
  避免反向代理（Nginx）缓冲导致流式失效；
- IoT 是可选能力：未配置 IoTDA 或缺少 ``app.iot.amqp_consumer`` 时自动退回
  本地模拟模式，Web 服务与 AI 问答照常可用。
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from contextlib import asynccontextmanager
from datetime import datetime
from typing import AsyncIterator, Callable

import httpx
from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    Header,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from . import auth
from .auth import AuthError
from .config import Settings, get_settings
from .iot import storage
from .iot.ws import manager
from .llm import stream_chat
from .schemas import (
    AuditCreate,
    ChatRequest,
    DeviceCommand,
    LoginRequest,
    LoginResponse,
    UserOut,
)
from .users import find_by_account, hash_password, verify_password

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

settings: Settings = get_settings()

# SSE 响应头（HTTP 头名大小写不敏感，这里按接口契约使用小写）
SSE_HEADERS = {
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    "connection": "keep-alive",
}

# 家属账号的数据范围：演示环境固定为老人 E01（与 .env.example 的 IOTDA_ELDER_ID 一致）
FAMILY_ELDER_ID: str = "E01"
# 401 统一文案：不区分"token 缺失 / 过期 / 签名错误"，避免给攻击者额外信息
UNAUTHORIZED_DETAIL: str = "登录状态已失效，请重新登录"
# 账号不存在时也用这份哈希跑一次等代价的 PBKDF2，避免响应时间泄露账号是否存在
_DECOY_PASSWORD_HASH: str = hash_password("decoy-password")
# 审计写入串行化：insert_audit 只返回 bool，取回 id 还要再查一次，
# 加锁保证本进程内"写入 + 取回"不被其它审计写入穿插
_AUDIT_LOCK = threading.Lock()


# --------------------------------------------------------------------------- 鉴权依赖
def _extract_bearer_token(authorization: str | None) -> str | None:
    """从 ``Authorization: Bearer <token>`` 头里取出 token。

    大小写不敏感、允许多余空白；格式不对或为空返回 ``None``（不抛异常）。
    """
    if not authorization:
        return None
    scheme, separator, credentials = authorization.partition(" ")
    if not separator or scheme.strip().lower() != "bearer":
        return None
    token = credentials.strip()
    return token or None


def require_auth(
    authorization: str | None = Header(
        default=None,
        description="访问口令，格式为 `Bearer <token>`",
    ),
) -> dict:
    """鉴权依赖：校验 Bearer token 且账号当前仍然有效，返回 token payload。

    分两步校验：
    1. 无状态校验：签名 + ``exp``（:func:`app.auth.verify_token`）；
    2. 状态校验：账号仍存在、``status == "active"``、角色与 token 一致
       （:func:`app.auth.check_payload`）。这样账号被停用 / 删除 / 改角色后，
       旧 token 无需等 8 小时过期，下一次请求立即失效。

    任一失败统一抛 ``AuthError(401)``，响应体为
    ``{"code": "UNAUTHORIZED", "detail": ...}``，不区分具体原因；日志只记账号名，
    **不记** token 内容。成功时**原样返回 payload**，调用方可继续使用
    ``payload["account"]`` / ``payload["role"]`` 等字段。
    """
    token = _extract_bearer_token(authorization)
    if token is None:
        raise AuthError(401, "UNAUTHORIZED", UNAUTHORIZED_DETAIL)

    payload = auth.verify_token(token)
    if payload is None:
        raise AuthError(401, "UNAUTHORIZED", UNAUTHORIZED_DETAIL)

    # 签名有效不代表账号仍然可用：停用 / 删除 / 改角色后旧 token 必须立刻失效
    if auth.check_payload(payload) is None:
        logger.info("鉴权失败：账号状态或角色已变更：account=%s", payload.get("account"))
        raise AuthError(401, "UNAUTHORIZED", UNAUTHORIZED_DETAIL)

    return payload


def require_roles(*roles: str) -> Callable[..., dict]:
    """生成"角色白名单"依赖：先校验登录态，再校验角色。

    用法：``Depends(require_roles("admin"))``。角色不在白名单抛
    ``AuthError(403, "FORBIDDEN", ...)``；未登录仍先返回 401。
    """
    allowed = frozenset(roles)

    def _dependency(
        authorization: str | None = Header(
            default=None,
            description="访问口令，格式为 `Bearer <token>`",
        ),
    ) -> dict:
        payload = require_auth(authorization)
        if payload.get("role") not in allowed:
            raise AuthError(403, "FORBIDDEN", "当前账号无权执行该操作")
        return payload

    return _dependency


def _scope_for(user: dict) -> str:
    """计算用户的数据范围 ``scope``：管理员全域、社工所属村居、家属老人 ID。"""
    role = user.get("role")
    if role == "admin":
        return "全域"
    if role == "family":
        return FAMILY_ELDER_ID
    return str(user.get("village") or "")


def _user_out(user: dict) -> UserOut:
    """把内部用户字典转换为对外模型（**不含** password_hash）。"""
    return UserOut(
        id=str(user["id"]),
        name=str(user["name"]),
        account=str(user["account"]),
        role=str(user["role"]),
        scope=_scope_for(user),
    )


def _client_ip(request: Request) -> str | None:
    """取请求来源 IP；ASGI 传输层未提供 ``client`` 时返回 ``None``。"""
    client = request.client
    return client.host if client is not None else None


def _audit_detail_text(detail: dict | list | str | None) -> str:
    """按 :func:`app.iot.storage.insert_audit` 的规则把 detail 归一为文本。

    序列化方式与存储层逐字对齐：dict / list 用
    ``json.dumps(ensure_ascii=False, default=str)``，``None`` 用空串，其余走
    ``str()``；仅用于回查时比对，不改变落库内容。
    """
    if isinstance(detail, (dict, list)):
        return json.dumps(detail, ensure_ascii=False, default=str)
    if detail is None:
        return ""
    return str(detail)


def _write_audit(
    payload: dict | None,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    result: str | None = None,
    detail: dict | list | str | None = None,
    ip: str | None = None,
) -> tuple[bool, str]:
    """写入一条审计日志，返回 ``(是否成功, 审计 ID)``。

    actor 信息从 token payload（``sub`` / ``account`` / ``role``）解析，姓名再查
    一次用户表；``payload`` 为 ``None`` 或字段缺失时对应列留空，不抛异常。整体
    兜底 try/except：审计失败只记日志，**绝不影响主流程**。

    ``insert_audit`` 按契约只返回 bool、id 由存储层生成，因此写入成功后再取最近
    记录按 ``(action, actor_id, target_type, target_id, result, detail)`` 六元组
    匹配回 id；detail 文本参与匹配，避免登录失败等 ``actor_id`` 为空的场景在
    同一秒取到他人记录。``_AUDIT_LOCK`` 保证本进程内该步骤不与其它审计写入穿插；
    跨进程并发时仍可能漏配（返回空 id），但落库结果与 ``ok`` 始终正确。
    """
    try:
        actor_id = ""
        actor_name = ""
        role = ""
        if isinstance(payload, dict):
            actor_id = str(payload.get("sub") or "")
            role = str(payload.get("role") or "")
            account = str(payload.get("account") or "")
            user = find_by_account(account) if account else None
            if user is not None:
                actor_name = str(user.get("name") or "")
                actor_id = actor_id or str(user.get("id") or "")

        # 先算好 detail 文本：序列化异常时直接走兜底，避免"已落库却返回失败"
        detail_text = _audit_detail_text(detail)
        with _AUDIT_LOCK:
            inserted = storage.insert_audit(
                {
                    "actor_id": actor_id,
                    "actor_name": actor_name,
                    "role": role,
                    "action": action,
                    "target_type": target_type,
                    "target_id": target_id,
                    "result": result,
                    "ip": ip,
                    "detail": detail,
                }
            )
            if not inserted:
                return False, ""
            latest = storage.recent_audits(limit=20)

        expected = (
            action,
            actor_id,
            str(target_type or ""),
            str(target_id or ""),
            str(result or ""),
            detail_text,
        )
        for record in latest:
            actual = (
                str(record.get("action") or ""),
                str(record.get("actor_id") or ""),
                str(record.get("target_type") or ""),
                str(record.get("target_id") or ""),
                str(record.get("result") or ""),
                _audit_detail_text(record.get("detail")),
            )
            if actual == expected:
                return True, str(record.get("id") or "")
        return True, ""
    except Exception:  # noqa: BLE001 - 审计失败不得影响主流程
        logger.exception("写入审计日志失败：action=%s", action)
        return False, ""


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """启动 / 关闭日志与 IoT 资源生命周期。

    顺序要求：先 ``manager.set_loop()`` 再启动 AMQP 线程，否则线程侧广播
    会因为拿不到事件循环而被丢弃；``storage.init_db()`` 失败只降级不阻断。
    """
    # 跨线程广播桥必须绑定当前主事件循环（AMQP 线程是同步线程）
    manager.set_loop(asyncio.get_running_loop())

    logger.info(
        "银龄岚途 AI 网关启动：llm_enabled=%s，model=%s，iot_enabled=%s，command_enabled=%s",
        settings.llm_enabled,
        settings.maas_model,
        settings.iot_enabled,
        settings.command_enabled,
    )
    if not settings.llm_enabled:
        logger.info("未检测到 MAAS_API_KEY，将以本地模板模式运行")
    if settings.allow_all_origins:
        logger.warning("CORS 已放开全部来源，仅限本地演示")

    # 建目录 + 建表；失败时仍提供服务（前端只是拿不到历史数据）
    storage.init_db()

    _start_amqp_consumer()
    yield
    _stop_amqp_consumer()
    logger.info("银龄岚途 AI 网关已停止")


def _start_amqp_consumer() -> None:
    """启动 IoTDA AMQP 订阅守护线程。

    ``app.iot.amqp_consumer`` 为可选模块（可能尚未提供），因此用延迟导入 +
    ImportError 兜底：缺文件时只打 warning，服务照常以本地模拟模式运行。
    """
    if not (settings.amqp_enabled or settings.iot_enabled):
        logger.info("未配置 IoTDA AMQP，退回本地模拟模式")
        return
    try:
        from .iot.amqp_consumer import start_consumer_thread
    except ImportError:
        logger.warning("未找到 app.iot.amqp_consumer，AMQP 订阅未启动（本地模拟模式）")
        return
    except Exception:  # noqa: BLE001 - 导入期异常不应阻断启动
        logger.exception("导入 AMQP 消费者模块失败，AMQP 订阅未启动")
        return

    try:
        start_consumer_thread()
        logger.info("IoTDA AMQP 消费者已启动（queue=%s）", settings.iotda_amqp_queue)
    except Exception:  # noqa: BLE001 - 订阅失败不应让整个 Web 服务不可用
        logger.exception("启动 IoTDA AMQP 消费者失败，服务继续以本地模式运行")


def _stop_amqp_consumer() -> None:
    """停止 AMQP 订阅线程；模块缺失或已停止时静默返回。"""
    try:
        from .iot.amqp_consumer import stop_consumer_thread
    except ImportError:
        return
    except Exception:  # noqa: BLE001
        logger.exception("导入 AMQP 消费者模块失败，跳过停止流程")
        return

    try:
        stop_consumer_thread()
        logger.info("IoTDA AMQP 消费者已停止")
    except Exception:  # noqa: BLE001 - 停机阶段不允许再抛异常
        logger.exception("停止 IoTDA AMQP 消费者失败")


app = FastAPI(
    title="银龄岚途 · 智慧养老 AI 网关",
    description="面向乡村 / 海岛养老场景的大模型流式问答服务（SSE）",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS：默认只放行显式白名单（含 file:// 页面的 "null"）；
# 仅当用户显式配置 "*" 时才放开全部来源，此时必须关闭 credentials
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.allow_all_origins else list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
    expose_headers=[],
)


@app.exception_handler(AuthError)
async def _auth_error_handler(request: Request, exc: AuthError) -> JSONResponse:
    """把 :class:`AuthError` 统一渲染为 ``{"code", "detail"}``。

    401 / 403 / 423 / 429 的响应体结构完全一致，前端只需读 ``code`` 分支；
    日志只记方法与路径、状态码与错误码，**不记** Authorization 头或 token。
    """
    logger.info(
        "鉴权失败：%s %s -> %s %s",
        request.method,
        request.url.path,
        exc.status_code,
        exc.code,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.code, "detail": exc.detail},
    )


router = APIRouter(prefix="/api", tags=["AI 网关"])


def _sse(event: dict) -> str:
    """把事件字典序列化为一条 SSE 消息（以空行结束）。

    ``ensure_ascii=False`` 保留中文原文；文本中的换行会被 JSON 转义为 ``\\n``，
    前端 ``JSON.parse`` 后可正确还原。
    """
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


async def _event_generator(payload: ChatRequest) -> AsyncIterator[str]:
    """把 :func:`app.llm.stream_chat` 的事件字典转成 SSE 文本。

    外层再兜一次异常：即使模型层遗漏，客户端也能收到 error + done 而不是断流。
    """
    try:
        async for event in stream_chat(settings, payload.elder, payload.messages):
            yield _sse(event)
    except asyncio.CancelledError:
        # 客户端主动断开，属于正常场景
        logger.info("客户端提前断开 SSE 连接")
        raise
    except Exception:  # noqa: BLE001 - 兜底，避免 500 中断连接
        logger.exception("SSE 生成器未捕获异常")
        yield _sse({"type": "error", "message": "服务内部错误，请稍后重试"})
        yield _sse({"type": "done"})


@router.get("/health", summary="健康检查")
async def health() -> JSONResponse:
    """返回服务状态与是否启用真实大模型。"""
    return JSONResponse(
        content={"status": "ok", "llm_enabled": settings.llm_enabled}
    )


@router.post(
    "/auth/login",
    summary="账号登录",
    response_model=LoginResponse,
    tags=["认证"],
)
async def login(payload: LoginRequest, request: Request) -> LoginResponse:
    """账号口令登录，成功后签发 HMAC 无状态 token。

    判定顺序固定如下（不可调换，否则会泄露账号是否存在、便于枚举）：
    1. 账号处于限流锁定 -> 429 ``TOO_MANY_ATTEMPTS``；
    2. 账号不存在或口令错误 -> 累计一次失败后 401 ``INVALID_CREDENTIALS``，
       两种情况使用**完全相同**的文案与状态码；
    3. 口令正确但账号被停用 -> 423 ``ACCOUNT_DISABLED``（不累计失败次数）；
    4. 指定了 ``role`` 且与账号角色不一致 -> 403 ``ROLE_MISMATCH``；
    5. 全部通过 -> 清零失败计数并签发 token。

    成功与失败都会写审计（失败只记账号与错误码），**绝不记录** password / token。
    """
    account = payload.account
    ip = _client_ip(request)

    try:
        # 1) 锁定中：直接 429，且不重新计时
        remaining = auth.is_locked(account)
        if remaining > 0:
            logger.info("登录被限流：account=%s 剩余 %ss", account, remaining)
            raise AuthError(429, "TOO_MANY_ATTEMPTS", "尝试过于频繁，请稍后再试")

        # 2) 账号不存在 / 口令错误：统一处理（账号不存在也计失败，防枚举）
        user = find_by_account(account)
        stored_hash = user["password_hash"] if user is not None else _DECOY_PASSWORD_HASH
        password_ok = verify_password(payload.password, stored_hash)
        if user is None or not password_ok:
            locked = auth.register_failure(account)
            logger.info("登录失败：account=%s（账号或口令不正确）", account)
            if locked:
                logger.warning(
                    "账号连续登录失败次数达上限，已锁定 %d 秒：account=%s",
                    int(auth.LOCK_SECONDS),
                    account,
                )
            raise AuthError(401, "INVALID_CREDENTIALS", "账号或密码不正确")

        # 3) 口令正确但账号被停用：不累计失败次数
        if user["status"] == "disabled":
            logger.info("登录失败：account=%s（账号已停用）", account)
            raise AuthError(423, "ACCOUNT_DISABLED", "该账号已被停用，请联系管理员")

        # 4) 角色不匹配
        if payload.role is not None and payload.role != user["role"]:
            logger.info("登录失败：account=%s（角色不匹配）", account)
            raise AuthError(403, "ROLE_MISMATCH", "角色与账号不匹配，请切换角色后登录")

        # 5) 成功
        auth.reset_failures(account)
        token, expires_at = auth.create_token(user)
        logger.info("登录成功：account=%s role=%s", account, user["role"])
        # payload 字段与 auth.create_token 保持一致，供 _write_audit 统一解析 actor
        _write_audit(
            {"sub": str(user["id"]), "account": account, "role": str(user["role"])},
            "login",
            target_type="session",
            result="ok",
            ip=ip,
        )
        return LoginResponse(token=token, expires_at=expires_at, user=_user_out(user))
    except AuthError as exc:
        _write_audit(
            None,
            "login",
            target_type="session",
            result="failed",
            detail={"account": account, "reason": exc.code},
            ip=ip,
        )
        raise


@router.get("/auth/me", summary="当前登录用户", tags=["认证"])
async def me(payload: dict = Depends(require_auth)) -> JSONResponse:
    """返回 token 对应的用户信息；账号已被删除时仍按 401 处理。"""
    account = str(payload.get("account") or "")
    user = find_by_account(account)
    if user is None or str(user["id"]) != str(payload.get("sub") or ""):
        logger.info("当前登录用户已不存在：account=%s", account)
        raise AuthError(401, "UNAUTHORIZED", UNAUTHORIZED_DETAIL)
    return JSONResponse(content={"user": _user_out(user).model_dump()})


@router.post("/chat", summary="流式对话（SSE）")
async def chat(
    payload: ChatRequest,
    request: Request,
    _auth: dict = Depends(require_auth),
) -> StreamingResponse:
    """接收老人档案与对话历史，以 ``text/event-stream`` 流式返回回答。"""
    # 只记录消息条数，绝不把对话正文写入审计
    _write_audit(
        _auth,
        "ai_chat",
        target_type="chat",
        result="ok",
        detail={"messages": len(payload.messages)},
        ip=_client_ip(request),
    )
    return StreamingResponse(
        _event_generator(payload),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.get("/iot/status", summary="IoT 链路状态")
async def iot_status(_auth: dict = Depends(require_auth)) -> JSONResponse:
    """返回 IoT 各子链路是否就绪与本地库计数。

    只暴露布尔标志与计数，**不**返回 device secret / AK / SK / access code
    等任何凭据；``device_id`` 用于前端在状态卡片上标注当前设备。
    """
    counts = storage.stats()
    vitals_count = int(counts.get("vitals_count", 0))
    return JSONResponse(
        content={
            "iot_enabled": settings.iot_enabled,
            "mqtt_enabled": settings.mqtt_enabled,
            "amqp_enabled": settings.amqp_enabled,
            "command_enabled": settings.command_enabled,
            "device_id": settings.iotda_device_id,
            "vitals_count": vitals_count,
            # 兼容早期前端字段拼写（vitols_count），与 vitals_count 同值
            "vitols_count": vitals_count,
            "alerts_count": int(counts.get("alerts_count", 0)),
        }
    )


# --------------------------------------------------------------------------- 审计日志
@router.post("/audit", summary="写入审计日志", tags=["审计"])
async def create_audit(
    payload: AuditCreate,
    request: Request,
    _auth: dict = Depends(require_auth),
) -> JSONResponse:
    """记录一条前端上报的业务操作审计。

    写入成功返回 201 与新记录 id；写入失败仍返回 200 ``{"ok": false}``，
    便于前端降级提示而不打断业务操作。
    """
    ok, audit_id = _write_audit(
        _auth,
        payload.action,
        target_type=payload.target_type,
        target_id=payload.target_id,
        result=payload.result,
        detail=payload.detail,
        ip=_client_ip(request),
    )
    if not ok:
        return JSONResponse(status_code=200, content={"ok": False})
    return JSONResponse(status_code=201, content={"ok": True, "id": audit_id})


@router.get("/audit/logs", summary="审计日志列表", tags=["审计"])
async def audit_logs(
    limit: int = Query(default=100, description="返回条数，由存储层钳制在 1-500"),
    action: str | None = Query(default=None, description="按操作类型精确过滤"),
    _auth: dict = Depends(require_roles("admin")),
) -> JSONResponse:
    """按时间倒序返回审计日志；非 admin 由依赖直接返回 403。"""
    return JSONResponse(
        content={"items": storage.recent_audits(limit=limit, action=action)}
    )


# 云端命令下发：连接 / 读取超时分开设置，避免网络抖动拖死请求
COMMAND_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


async def _fetch_iam_token(client: httpx.AsyncClient) -> str:
    """用 AK/SK 调 IAM v3 换取临时 token。

    只在内存中传递凭据，不写日志、不回显；调用方拿到的 token 也仅用于
    单次 IoTDA 请求头。``verify`` 保持默认（True），禁止关闭 SSL 校验。
    """
    url = f"https://iam.{settings.iotda_region}.myhuaweicloud.com/v3/auth/tokens"
    body = {
        "auth": {
            "identity": {
                "methods": ["hw_ak_sk"],
                "hw_ak_sk": {
                    "access": {"key": settings.huawei_cloud_ak},
                    "secret": {"key": settings.huawei_cloud_sk},
                },
            },
            "scope": {"project": {"id": settings.iotda_project_id}},
        }
    }
    response = await client.post(url, json=body)
    response.raise_for_status()
    token = response.headers.get("X-Subject-Token", "")
    if not token:
        raise RuntimeError("IAM 响应缺少 X-Subject-Token")
    return token


@router.post("/device/command", summary="云端命令下发")
async def device_command(
    payload: DeviceCommand,
    request: Request,
    _auth: dict = Depends(require_roles("admin")),
) -> JSONResponse:
    """向 IoTDA 设备下发命令（如 ``restart``）。

    未配置 region / project_id / AK / SK 时返回 503 ``CLOUD_COMMAND_DISABLED``，
    前端据此隐藏"远程重启"等入口；上游失败统一映射为 502，错误信息均为中文
    且不含任何凭据。每个分支都写审计，detail 只含命令名等业务字段。
    """
    ip = _client_ip(request)
    if not settings.command_enabled:
        _write_audit(
            _auth,
            "device_command",
            target_type="device",
            target_id=payload.device_id,
            result="disabled",
            detail={"command_name": payload.command_name},
            ip=ip,
        )
        return JSONResponse(
            status_code=503,
            content={
                "code": "CLOUD_COMMAND_DISABLED",
                "enabled": False,
                "detail": "未启用云端命令下发",
            },
        )

    url = (
        f"https://iotda.{settings.iotda_region}.myhuaweicloud.com"
        f"/v5/iot/{settings.iotda_project_id}/devices/{payload.device_id}/commands"
    )
    body = {
        "service_id": payload.service_id,
        "command_name": payload.command_name,
        "paras": payload.paras,
    }

    try:
        # AsyncClient 默认 verify=True，保持标准证书校验
        async with httpx.AsyncClient(timeout=COMMAND_TIMEOUT) as client:
            token = await _fetch_iam_token(client)
            response = await client.post(url, json=body, headers={"X-Auth-Token": token})
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPStatusError as exc:
        # 只记录状态码，避免把响应体 / 请求头（含 token）写进日志
        logger.error("云端命令下发失败：华为云返回 %s", exc.response.status_code)
        _write_audit(
            _auth,
            "device_command",
            target_type="device",
            target_id=payload.device_id,
            result="failed",
            detail={"command_name": payload.command_name, "reason": "upstream_http"},
            ip=ip,
        )
        return JSONResponse(
            status_code=502,
            content={
                "ok": False,
                "code": "CLOUD_COMMAND_FAILED",
                "detail": f"华为云接口返回 {exc.response.status_code}",
            },
        )
    except httpx.HTTPError as exc:
        logger.error("云端命令下发失败：网络或协议异常（%s）", type(exc).__name__)
        _write_audit(
            _auth,
            "device_command",
            target_type="device",
            target_id=payload.device_id,
            result="failed",
            detail={"command_name": payload.command_name, "reason": "network"},
            ip=ip,
        )
        return JSONResponse(
            status_code=502,
            content={
                "ok": False,
                "code": "CLOUD_COMMAND_FAILED",
                "detail": "调用华为云接口失败，请稍后重试",
            },
        )
    except (ValueError, RuntimeError) as exc:
        logger.error("云端命令下发失败：响应内容异常（%s）", type(exc).__name__)
        _write_audit(
            _auth,
            "device_command",
            target_type="device",
            target_id=payload.device_id,
            result="failed",
            detail={"command_name": payload.command_name, "reason": "response"},
            ip=ip,
        )
        return JSONResponse(
            status_code=502,
            content={
                "ok": False,
                "code": "CLOUD_COMMAND_FAILED",
                "detail": "华为云返回内容异常，请检查配置",
            },
        )

    logger.info("云端命令已下发：device=%s command=%s", payload.device_id, payload.command_name)
    _write_audit(
        _auth,
        "device_command",
        target_type="device",
        target_id=payload.device_id,
        result="ok",
        detail={"command_name": payload.command_name},
        ip=ip,
    )
    return JSONResponse(content={"ok": True, "response": data})


app.include_router(router)


@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str | None = Query(
        default=None,
        description="登录接口返回的 token，通过 `?token=<token>` 传入",
    ),
) -> None:
    """实时推送端点：鉴权通过后连上即发 hello，之后只收不发。

    token 从查询参数 ``?token=`` 传入（浏览器 WebSocket 无法自定义请求头）。
    缺失或校验失败时**先** ``close(code=1008)``（策略违规）再返回：
    不 accept、不登记连接、不打印 token 内容。

    服务端主动推 ``vitals`` / ``alert``；客户端消息（含空串）一律忽略，
    仅用于探测连接是否存活。``WebSocketDisconnect`` 属正常关闭，
    不记 error 级日志。
    """
    payload = auth.verify_token(token)
    # 验签只证明"签发时有效"：账号被停用 / 删除 / 改角色后旧 token 必须立刻失效，
    # 因此与 HTTP 侧 require_auth 一致，再与用户表比对一次
    if payload is None or auth.check_payload(payload) is None:
        logger.info("WebSocket 鉴权失败")
        await websocket.close(code=1008)
        return

    await manager.connect(websocket)
    try:
        await websocket.send_json(
            {
                "type": "hello",
                "data": {
                    "iot_enabled": settings.iot_enabled,
                    "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                },
            }
        )
        while True:
            message = await websocket.receive_text()
            if not message.strip():
                continue
    except WebSocketDisconnect:
        logger.info("WebSocket 客户端主动断开")
    except Exception:  # noqa: BLE001 - 单连接异常不影响其它连接
        logger.exception("WebSocket 会话异常")
    finally:
        manager.disconnect(websocket)


@app.get("/", include_in_schema=False)
async def root() -> JSONResponse:
    """根路径提示，方便快速确认服务已启动。"""
    return JSONResponse(
        content={
            "service": "银龄岚途 AI 网关",
            "docs": "/docs",
            "health": "/api/health",
            "chat": "/api/chat",
        }
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=settings.app_port,
        reload=False,
    )