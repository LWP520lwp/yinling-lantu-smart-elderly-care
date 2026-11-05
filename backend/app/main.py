"""FastAPI 应用入口。

路由：
- ``GET  /api/health``         ：健康检查，返回是否启用了真实大模型；
- ``POST /api/chat``           ：SSE 流式对话，事件格式见 :mod:`app.llm`；
- ``GET  /api/iot/status``     ：IoT 链路状态与本地库计数（不泄露任何密钥）；
- ``POST /api/device/command`` ：云端命令下发（IAM 取 token + IoTDA v5 命令 API）；
- ``WS   /ws``                 ：实时体征 / 告警推送（vitals / alert / hello）。

设计要点：
- CORS 从 ``CORS_ORIGINS`` 解析，``*`` 时强制 ``allow_credentials=False``（规范要求）；
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
from contextlib import asynccontextmanager
from datetime import datetime
from typing import AsyncIterator

import httpx
from fastapi import APIRouter, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from .config import Settings, get_settings
from .iot import storage
from .iot.ws import manager
from .llm import stream_chat
from .schemas import ChatRequest, DeviceCommand

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

# CORS：允许 "*" 时必须关闭 credentials，否则浏览器会拒绝响应
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.allow_all_origins else list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
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


@router.post("/chat", summary="流式对话（SSE）")
async def chat(payload: ChatRequest) -> StreamingResponse:
    """接收老人档案与对话历史，以 ``text/event-stream`` 流式返回回答。"""
    return StreamingResponse(
        _event_generator(payload),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.get("/iot/status", summary="IoT 链路状态")
async def iot_status() -> JSONResponse:
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
async def device_command(payload: DeviceCommand) -> JSONResponse:
    """向 IoTDA 设备下发命令（如 ``restart``）。

    未配置 region / project_id / AK / SK 时返回 503 ``CLOUD_COMMAND_DISABLED``，
    前端据此隐藏"远程重启"等入口；上游失败统一映射为 502，错误信息均为中文
    且不含任何凭据。
    """
    if not settings.command_enabled:
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
        return JSONResponse(
            status_code=502,
            content={
                "ok": False,
                "code": "CLOUD_COMMAND_FAILED",
                "detail": "华为云返回内容异常，请检查配置",
            },
        )

    logger.info("云端命令已下发：device=%s command=%s", payload.device_id, payload.command_name)
    return JSONResponse(content={"ok": True, "response": data})


app.include_router(router)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """实时推送端点：连上即发 hello，之后只收不发（客户端心跳可任意发送）。

    服务端主动推 ``vitals`` / ``alert``；客户端消息（含空串）一律忽略，
    仅用于探测连接是否存活。``WebSocketDisconnect`` 属正常关闭，
    不记 error 级日志。
    """
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