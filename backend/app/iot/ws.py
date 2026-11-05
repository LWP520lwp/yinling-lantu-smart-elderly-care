"""WebSocket 连接管理与跨线程广播桥。

前端（``assets/js``）连接 ``/ws`` 后接收三类消息：

- ``{"type": "hello", "data": {...}}``  握手包，标识 IoT 是否启用；
- ``{"type": "vitals", "data": frame}`` 每次设备体征上报；
- ``{"type": "alert", "data": alert}``  每条新告警。

线程模型：
- 连接登记 / 广播在 FastAPI 主事件循环中执行（``async``）；
- 体征可能来自 AMQP 消费线程（同步线程），无法直接 ``await``，
  因此 :meth:`ConnectionManager.publish_threadsafe` 通过
  ``asyncio.run_coroutine_threadsafe`` 把协程投递回主循环。
  循环未就绪或已关闭时只记 debug 日志，绝不向上抛异常打断上报线程。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """维护所有活跃 WebSocket 连接，并支持跨线程广播。"""

    def __init__(self) -> None:
        self.active: List[WebSocket] = []
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    # ------------------------------------------------------------------ 生命周期
    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """保存主事件循环（在 lifespan 中调用），供工作线程投递广播。"""
        self._loop = loop
        logger.debug("WebSocket 管理器已绑定事件循环：%s", loop)

    async def connect(self, websocket: WebSocket) -> None:
        """接受握手并登记连接；重复登记同一对象时自动去重。"""
        await websocket.accept()
        if websocket not in self.active:
            self.active.append(websocket)
        logger.info("WebSocket 连接建立，当前在线 %d 个", len(self.active))

    def disconnect(self, websocket: WebSocket) -> None:
        """移除连接（幂等，重复调用不会报错）。"""
        if websocket in self.active:
            self.active.remove(websocket)
            logger.info("WebSocket 连接关闭，当前在线 %d 个", len(self.active))

    # ------------------------------------------------------------------ 广播
    async def broadcast_json(self, payload: Dict[str, Any]) -> None:
        """向所有连接推送同一 JSON；单条连接失败即剔除，不影响其它连接。"""
        if not self.active:
            return
        dead: List[WebSocket] = []
        for websocket in list(self.active):
            try:
                await websocket.send_json(payload)
            except Exception:  # noqa: BLE001 - 坏连接不应影响其余客户端
                logger.debug("WebSocket 发送失败，移除该连接", exc_info=True)
                dead.append(websocket)
        for websocket in dead:
            self.disconnect(websocket)

    def publish_threadsafe(self, payload: Dict[str, Any]) -> None:
        """从任意线程（如 AMQP 消费线程）安全广播，不阻塞调用方。

        事件循环尚未就绪（启动初期）或已关闭（停机阶段）时静默丢弃，
        仅记录 debug 日志；这类消息对端已不可见，无重试价值。
        """
        loop = self._loop
        if loop is None or loop.is_closed():
            logger.debug("事件循环未就绪，丢弃广播：type=%s", payload.get("type"))
            return
        if not self.active:
            # 无人订阅时直接返回，避免创建永远不会被 await 的协程
            return

        coro = self.broadcast_json(payload)
        try:
            asyncio.run_coroutine_threadsafe(coro, loop)
        except RuntimeError:
            # 循环恰在关闭过程中，关闭协程防止 "never awaited" 告警
            coro.close()
            logger.debug("事件循环已关闭，丢弃广播：type=%s", payload.get("type"))


# 模块级单例：main.py 与 processor.py 共用同一份连接列表
manager = ConnectionManager()