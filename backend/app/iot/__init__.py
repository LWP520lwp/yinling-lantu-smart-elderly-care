"""IoT 实时链路子包：设备上报 → 阈值判定 → 落库 → WebSocket 推前端。

模块导航：

- :mod:`app.iot.storage`   ：数据访问层（SQLite 实现，可真机替换为 GaussDB）；
- :mod:`app.iot.processor` ：体征帧处理、告警生成与冷却去重；
- :mod:`app.iot.ws`        ：WebSocket 连接管理与跨线程广播桥；
- :mod:`app.iot.amqp_consumer` ：IoTDA AMQP 订阅线程（可选依赖，缺失时
  服务自动退回本地模拟模式）。
"""

from __future__ import annotations

__all__ = ["storage", "processor", "ws"]