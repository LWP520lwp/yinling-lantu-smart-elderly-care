"""IoTDA 规则引擎 AMQP 订阅消费者（数据转发 → 体征帧 → processor）。

数据流::

    华为云 IoTDA 规则引擎「数据转发」
        └─ AMQP 队列（amqps://<host>:5671，SASL 接入凭证）
            └─ :class:`IotdaAmqpHandler.on_message`
                ├─ _extract_frame()      防御性解析 notify_data / 扁平结构
                └─ processor.handle_frame(frame)   落库 → 判阈 → 告警 → WS 广播

只负责「收 + 解析 + 转交」，阈值判定、冷却去重、落库与广播全部由
:mod:`app.iot.processor` 完成，本模块不写 SQL、不直接操作 WebSocket。

配置项（``backend/.env``，与 :mod:`app.config` 一致）::

    IOTDA_AMQP_HOST         AMQP 接入域名（IoTDA 控制台 → 总览 → 接入信息）
    IOTDA_AMQP_PORT         端口，默认 5671（TLS）
    IOTDA_AMQP_ACCESS_KEY   接入凭证 Key
    IOTDA_AMQP_ACCESS_CODE  接入凭证 Password（密钥）
    IOTDA_AMQP_QUEUE        转发目标队列名，默认 DefaultQueue
    IOTDA_INSTANCE_ID       企业版实例 ID；标准版可留空（用户名仍会拼接该字段）
    IOTDA_DEVICE_ID         消息里缺 device_id 时的兜底设备

用法::

    from app.iot import amqp_consumer

    if amqp_consumer.start_consumer_thread():   # 未装依赖 / 未配置时返回 False
        ...
    amqp_consumer.is_running()                  # 线程存活且未停止
    amqp_consumer.stop_consumer_thread()        # 幂等，最长等待 5 秒

排障提示：

1. **未收到任何消息**：先确认 IoTDA 控制台「规则 → 数据转发」的转发目标
   （AMQP 队列）已命中，且设备上报的属性名与规则 SQL 的 ``SELECT`` 一致；
   规则未命中时队列不会有消息，客户端侧看起来就是"连上了但一直安静"。
2. **连上了立刻断开**：多为 ``timestamp`` 过期（接入凭证有效期内才能建连）
   或 AK/CODE 填错。本模块每次重连都会重新生成毫秒时间戳，因此长时间断线
   后恢复也无需人工重启。
3. **握手失败 / SSL 报错**：本模块按华为云官方示例使用
   ``SSLDomain.ANONYMOUS_PEER``（不校验对端证书），身份认证依赖 SASL
   用户名 + 密码；若企业网络强制代理，需先放行 5671 出站。
4. **依赖缺失**：``pip install python-qpid-proton``。缺少该依赖时本模块仍可
   被导入（``PROTON_AVAILABLE=False``），只是一个线程都不会启动，
   不影响 Web 服务与本地模拟模式。
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..config import get_settings
from . import processor

logger = logging.getLogger(__name__)

# --------------------------------------------------------------- 依赖（防御式导入）
# main.py 会无条件 import 本模块，因此导入期绝不能因为缺少 proton 而抛异常。
PROTON_AVAILABLE = True
_PROTON_IMPORT_ERROR: Optional[BaseException] = None

try:
    # python-qpid-proton 的公开入口；Message 供调用方复用（本模块不直接构造）
    from proton import Message  # noqa: F401 - 对外暴露的消息类型
    from proton.handlers import MessagingHandler
    from proton.reactor import Container
    from proton.utils import SSLDomain
except ImportError as exc:  # pragma: no cover - 取决于部署环境是否安装依赖
    PROTON_AVAILABLE = False
    _PROTON_IMPORT_ERROR = exc
    Message = None  # type: ignore[assignment]

    class MessagingHandler:  # type: ignore[no-redef]
        """占位基类：未安装 proton 时保证本模块可被导入。"""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

    class Container:  # type: ignore[no-redef]
        """占位容器：未安装 proton 时任何实例化都会给出明确的中文错误。"""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            raise RuntimeError("python-qpid-proton 未安装，AMQP 消费者不可用")

        def connect(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("python-qpid-proton 未安装，AMQP 消费者不可用")

        def run(self) -> None:
            raise RuntimeError("python-qpid-proton 未安装，AMQP 消费者不可用")

        def stop(self) -> None:
            """占位：未安装依赖时无需停止任何东西。"""

    class SSLDomain:  # type: ignore[no-redef]
        """占位 SSL 域常量，避免模块级常量构造失败。"""

        MODE_CLIENT = 1
        ANONYMOUS_PEER = 0

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        def set_peer_authentication(self, *args: Any, **kwargs: Any) -> None:
            pass


# --------------------------------------------------------------- 常量
DEFAULT_AMQP_PORT = 5671
RAW_LOG_LIMIT = 2000  # 原始 body 日志最大字符数，避免大报文刷爆日志
JOIN_TIMEOUT_SECONDS = 5
# 自实现重连退避：1 → 2 → 4 → 8 → 15（封顶 15 秒，不无限增长）
BACKOFF_SECONDS: Tuple[int, ...] = (1, 2, 4, 8, 15)

DEVICE_ID_ALIASES: Tuple[str, ...] = ("device_id", "deviceId", "deviceID")
EVENT_TIME_ALIASES: Tuple[str, ...] = ("event_time", "eventTime", "timestamp")

# 体征字段 → 设备侧可能的键名（比较时统一去掉下划线并转小写）
_FIELD_ALIASES: Dict[str, Tuple[str, ...]] = {
    "hr": ("hr", "heart_rate", "heartRate"),
    "sbp": ("sbp", "systolic", "systolic_pressure"),
    "dbp": ("dbp", "diastolic", "diastolic_pressure"),
    "spo2": ("spo2", "oxygen", "blood_oxygen", "oxygen_saturation"),
    "steps": ("steps", "step_count"),
    "battery": ("battery", "battery_level"),
    "fall": ("fall", "fall_detected"),
    "sos": ("sos",),
}

# --------------------------------------------------------------- 全局单例状态
_lock = threading.Lock()
_container: Any = None  # 当前 Container，供 stop_consumer_thread() 中断
_thread: Optional[threading.Thread] = None
_stop_event = threading.Event()
_connected = False


def _set_connected(value: bool) -> None:
    """更新连接标志（线程安全，供 is_connected() / 状态接口读取）。"""
    global _connected
    with _lock:
        _connected = value


def _notify(message: str) -> None:
    """同时写日志与标准输出：部署期问题需要运维直接看到。"""
    logger.warning(message)
    print(f"[AMQP] {message}")


# --------------------------------------------------------------- 通用工具
def _preview(value: Any, limit: int = RAW_LOG_LIMIT) -> str:
    """把任意消息体转成限长字符串，用于日志（超长截断并标注原始长度）。"""
    if value is None:
        return "<空>"
    if isinstance(value, (bytes, bytearray)):
        try:
            text = value.decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - 日志工具绝不能抛异常
            text = repr(value)
    elif isinstance(value, str):
        text = value
    else:
        text = repr(value)
    if len(text) <= limit:
        return text
    return f"{text[:limit]}...<截断，原始长度 {len(text)} 字符>"


def _normalise_key(key: Any) -> str:
    """键名归一化：去掉下划线 / 连字符等分隔符并转小写（``device_id`` → ``deviceid``）。"""
    return re.sub(r"[^0-9a-z]", "", str(key).lower())


def _as_dict(value: Any) -> Optional[Dict[str, Any]]:
    """仅当值是非空 dict 时返回，否则 None（防止对 list / str 做 .get）。"""
    return value if isinstance(value, dict) else None


def _to_int(value: Any, default: int = 0) -> int:
    """设备值 → int；``None`` / 空串 / 非法值回退默认值（0 表示"无记录"）。"""
    if value is None or value == "":
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _get_any(mapping: Any, names: Sequence[str]) -> Any:
    """按别名从一层 dict 中取第一个非空值；键名忽略大小写与分隔符。"""
    if not isinstance(mapping, dict):
        return None
    wanted = {_normalise_key(name) for name in names}
    for key, value in mapping.items():
        if _normalise_key(key) not in wanted:
            continue
        if value is None or value == "":
            continue
        return value
    return None


def _get_from_sources(sources: Sequence[Dict[str, Any]], names: Sequence[str]) -> Any:
    """按来源优先级依次查找字段（前一个来源命中即返回）。"""
    for source in sources:
        value = _get_any(source, names)
        if value is not None:
            return value
    return None


def _parse_iso_ms(text: str) -> Optional[int]:
    """ISO8601 字符串 → 毫秒时间戳；无法解析返回 None。

    兼容 ``2024-01-01T12:00:00Z``（IoTDA ``event_time`` 常见格式）与
    ``20240101T120000Z`` 紧凑格式。
    """
    candidate = text.strip()
    if not candidate:
        return None
    try:
        moment = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        return int(moment.timestamp() * 1000)
    except ValueError:
        pass
    try:
        moment = datetime.strptime(candidate, "%Y%m%dT%H%M%SZ")
        return int(moment.timestamp() * 1000)
    except ValueError:
        return None


def _to_event_ms(value: Any) -> int:
    """事件时间 → 毫秒时间戳。

    - 秒级（``< 1e11``，覆盖 1973 ~ 5138 年）自动 *1000；
    - ISO8601 字符串先解析；
    - 缺失 / 非法值回退当前时间，保证 processor 侧总能落库。
    """
    now_ms = int(time.time() * 1000)
    if value is None or value == "":
        return now_ms

    if isinstance(value, str):
        text = value.strip()
        if not text:
            return now_ms
        # 纯数字串按时间戳处理，其余尝试 ISO8601
        if not text.lstrip("-").isdigit():
            parsed = _parse_iso_ms(text)
            return parsed if parsed is not None else now_ms

    ts = _to_int(value, 0)
    if ts <= 0:
        return now_ms
    if ts < 10**11:  # 秒级时间戳 → 毫秒
        ts *= 1000
    return ts


def _service_list(container: Any) -> List[Dict[str, Any]]:
    """取出 ``services`` 列表；兼容 dict 单条、缺字段、脏元素。"""
    services = _get_any(container, ("services", "service"))
    if isinstance(services, dict):
        services = [services]
    if not isinstance(services, list):
        return []
    return [item for item in services if isinstance(item, dict)]


# --------------------------------------------------------------- 消息解析
def _coerce_mapping(payload: Any) -> Optional[Dict[str, Any]]:
    """把 AMQP body 转成顶层 dict；坏 JSON / 非对象结构返回 None（不抛异常）。"""
    if isinstance(payload, dict):
        return payload

    if isinstance(payload, (bytes, bytearray)):
        try:
            text = payload.decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - 解码失败按坏消息处理
            logger.warning("AMQP 消息体字节流无法解码：%s", _preview(payload))
            return None
    elif isinstance(payload, str):
        text = payload
    else:
        logger.warning("AMQP 消息体类型不支持（%s），按坏消息丢弃", type(payload).__name__)
        return None

    text = text.strip()
    if not text:
        logger.warning("AMQP 消息体为空，按坏消息丢弃")
        return None

    try:
        decoded = json.loads(text)
    except (TypeError, ValueError) as exc:
        logger.warning("AMQP 消息体不是合法 JSON（%s）：%s", exc, _preview(text))
        return None

    if not isinstance(decoded, dict):
        logger.warning("AMQP 消息体 JSON 顶层不是对象（%s），按坏消息丢弃", type(decoded).__name__)
        return None
    return decoded


def _extract_frame(payload: Any) -> Optional[Dict[str, Any]]:
    """原始消息体 → ``processor.handle_frame`` 需要的体征帧。

    兼容两种结构::

        # 1) 规则引擎标准结构
        {"resource": "device.property",
         "notify_data": {"header": {"device_id": "D1", ...},
                         "body": {"device_id": "D1",
                                  "services": [{"service_id": "health",
                                                "properties": {"hr": 78, ...},
                                                "event_time": "2024-01-01T12:00:00Z"}]}}}

        # 2) 扁平结构（模拟器 / 自建网关）
        {"device_id": "D1", "hr": 78, "spo2": 97, "event_time": 1700000000000}

    字段缺失一律补 0（processor 中 0 = "该项无记录"，不会误触发告警）；
    ``event_time`` 统一为毫秒。返回 ``None`` 表示不是可用消息（坏 JSON /
    顶层非对象），调用方应 accept 丢弃以免队列堆积。
    """
    data = _coerce_mapping(payload)
    if data is None:
        return None

    try:
        notify = _as_dict(_get_any(data, ("notify_data", "notifyData")))
        header = _as_dict(notify.get("header")) if notify is not None else None
        body = _as_dict(notify.get("body")) if notify is not None else None

        # notify_data.body 是标准结构；没有 notify_data 时退回顶层
        scope = body if body is not None else data

        services = _service_list(scope)
        if not services and scope is not data:
            services = _service_list(data)

        # 字段来源优先级：services[].properties → service 本身 → body/顶层 → 根对象
        sources: List[Dict[str, Any]] = []
        for service in services:
            properties = _as_dict(service.get("properties"))
            if properties is not None:
                sources.append(properties)
            sources.append(service)
        if scope is not data:
            sources.append(scope)
        sources.append(data)

        # device_id：body → header → services → 顶层（processor 还有最后一层兜底）
        device_id = (
            _get_any(body, DEVICE_ID_ALIASES)
            or _get_any(header, DEVICE_ID_ALIASES)
            or _get_from_sources(sources, DEVICE_ID_ALIASES)
        )
        device_id = str(device_id).strip() if device_id not in (None, "") else ""

        # event_time：services[].event_time 优先，其次 body / header / 顶层
        event_time_raw = _get_from_sources(sources, EVENT_TIME_ALIASES)

        frame: Dict[str, Any] = {"device_id": device_id}
        for field, aliases in _FIELD_ALIASES.items():
            frame[field] = _to_int(_get_from_sources(sources, aliases), 0)
        frame["event_time"] = _to_event_ms(event_time_raw)

        if not device_id:
            logger.warning("AMQP 消息缺少 device_id，将回退到 IOTDA_DEVICE_ID 配置项")
        return frame
    except Exception:  # noqa: BLE001 - 解析层兜底：任何异常都按坏消息处理，绝不打断消费
        logger.exception("解析 AMQP 消息体时出现未预期异常，按坏消息丢弃")
        return None


# --------------------------------------------------------------- 连接参数
def _build_ssl_domain() -> Any:
    """构造客户端 SSL 域；未安装 proton 时返回 None。

    为何用 ``ANONYMOUS_PEER``：华为云 IoTDA AMQP 接入使用平台侧证书链，
    proton 默认 CA 库不含其签发者，``FULL_PEER`` 校验会在握手阶段失败；
    华为云官方示例同样关闭对端证书校验，身份认证由 SASL 用户名 / 密码
    （接入凭证）完成，因此这里不降低实际安全性。
    """
    if not PROTON_AVAILABLE:
        return None
    domain = SSLDomain(SSLDomain.MODE_CLIENT)
    domain.set_peer_authentication(SSLDomain.ANONYMOUS_PEER)
    return domain


SSL_DOMAIN = _build_ssl_domain()


def _build_username(access_key: str, instance_id: str, now_ms: Optional[int] = None) -> str:
    """拼接 SASL 用户名：``accessKey=..|timestamp=..|instanceId=..``。

    ``timestamp`` 为 13 位毫秒时间戳，且**每次建连都要重新生成**：华为云
    接入凭证只在有效期内可建连，复用旧时间戳会在长时间断线后被拒绝。
    """
    timestamp = int(time.time() * 1000) if now_ms is None else int(now_ms)
    return f"accessKey={access_key}|timestamp={timestamp}|instanceId={instance_id}"


def _build_container(handler: "IotdaAmqpHandler") -> Any:
    """为一次连接构造 Container（含 SASL + TLS + 心跳配置）。

    每次调用都会重新生成 timestamp，因此重连时拿到的永远是新鲜的接入凭证。
    凭据本身不写日志（access key / code 均视为敏感信息）。
    """
    cfg = get_settings()
    host = cfg.iotda_amqp_host.strip()
    port = cfg.iotda_amqp_port or DEFAULT_AMQP_PORT
    url = f"amqps://{host}:{port}"
    username = _build_username(cfg.iotda_amqp_access_key.strip(), cfg.iotda_instance_id.strip())
    password = cfg.iotda_amqp_access_code

    logger.info("正在连接 IoTDA AMQP：%s（queue=%s）", url, handler.queue)

    container = Container(handler)
    connection = container.connect(
        url,
        ssl_domain=SSL_DOMAIN,
        sasl_enabled=True,
        user=username,
        password=password,
        heartbeat=60,  # 60 秒心跳，避免 NAT / 负载均衡静默断链
        reconnect=False,  # 由 _run_loop 自实现退避重连，proton 内建重连不便于控制间隔
    )
    handler.bind_connection(connection)
    return container


# --------------------------------------------------------------- 消息处理器
class IotdaAmqpHandler(MessagingHandler):
    """单次连接的 AMQP 处理器：建 receiver → 收消息 → 解析 → 交给 processor。

    proton 的 handler 与 Container 生命周期绑定，因此每次重连都会新建实例，
    实例上不保存任何需要跨连接复用的状态；``stop_event`` 只用于感知停机。
    """

    def __init__(
        self,
        queue: Optional[str] = None,
        stop_event: Optional[threading.Event] = None,
    ) -> None:
        try:
            super().__init__()
        except TypeError:
            # 个别 proton 版本的 MessagingHandler.__init__ 签名不同，
            # 这里容错，避免因版本差异导致消费者无法启动。
            pass
        queue_name = (queue or "").strip()
        if not queue_name:
            queue_name = get_settings().iotda_amqp_queue
        self.queue: str = queue_name or "DefaultQueue"
        self.stop_event: threading.Event = stop_event or threading.Event()
        self._container: Any = None
        self._connection: Any = None
        self._receiver: Any = None

    def bind_connection(self, connection: Any) -> None:
        """在 ``Container.connect()`` 之后注入连接对象（供 on_start 建 receiver）。"""
        self._connection = connection

    # ------------------------------------------------------------- 生命周期
    def on_start(self, event: Any) -> None:
        """连接就绪：创建 receiver 开始消费。"""
        container = getattr(event, "container", None)
        self._container = container
        connection = getattr(container, "connection", None) or self._connection

        if container is None or connection is None:
            logger.error("AMQP on_start 缺少 container / connection，无法创建 receiver")
            _set_connected(False)
            return

        try:
            # source 即规则引擎配置的转发目标队列名（默认 DefaultQueue）
            self._receiver = container.create_receiver(connection, source=self.queue)
        except Exception:  # noqa: BLE001 - 建 receiver 失败交给外层退避重连
            logger.exception("创建 AMQP receiver 失败（queue=%s），将重连", self.queue)
            _set_connected(False)
            try:
                container.stop()
            except Exception:  # noqa: BLE001
                logger.debug("停止 Container 失败（可忽略）", exc_info=True)
            return

        _set_connected(True)
        logger.info("AMQP 已连接，开始消费队列 %s", self.queue)

    def on_disconnected(self, event: Any) -> None:
        """连接断开：标记需要重连，具体的退避由 ``_run_loop`` 完成。"""
        _set_connected(False)
        logger.warning("AMQP 连接已断开（queue=%s），将按退避策略重连", self.queue)

    def on_transport_error(self, event: Any) -> None:
        """传输层错误（TLS / TCP / SASL）：打印原因并标记重连。"""
        _set_connected(False)
        logger.error("AMQP 传输层错误（queue=%s）：%s；稍后重连", self.queue, self._describe_error(event))

    @staticmethod
    def _describe_error(event: Any) -> str:
        """尽量从 event.transport.condition 中取出可读错误，取不到则返回占位文本。"""
        try:
            transport = getattr(event, "transport", None)
            condition = getattr(transport, "condition", None) if transport is not None else None
            if condition is None:
                return "未知错误（未携带 condition）"
            name = getattr(condition, "name", "") or ""
            description = getattr(condition, "description", "") or ""
            detail = f"{name} {description}".strip()
            return detail or "未知错误"
        except Exception:  # noqa: BLE001 - 日志描述失败不应影响主流程
            return "无法读取错误详情"

    # ------------------------------------------------------------- 收消息
    def on_message(self, event: Any) -> None:
        """收到一条转发消息：先记原始 body，再解析并转交 processor。"""
        message = getattr(event, "message", None)
        body = getattr(message, "body", None)

        # 1) 原始报文入日志（限长 2000 字符），便于核对规则 SQL 的字段命名
        logger.info("AMQP 收到消息（queue=%s）：%s", self.queue, _preview(body))

        # 2) 防御性解析：失败也 accept，避免坏消息在队列中反复投递
        frame = _extract_frame(body)
        if frame is None:
            logger.warning("AMQP 消息无法解析，已 accept 丢弃（避免队列堆积）")
            self._accept(message)
            return

        # 3) 交给 processor：单条消息失败只记日志，绝不中断消费线程
        try:
            processor.handle_frame(frame)
        except Exception:  # noqa: BLE001 - 业务异常不能拖垮订阅链路
            logger.exception("体征帧处理失败（device=%s），已跳过该消息", frame.get("device_id"))

        # 4) 显式确认，队列才会移除该消息
        self._accept(message)

    @staticmethod
    def _accept(message: Any) -> None:
        """安全 accept：连接已断开时 accept 会抛异常，这里只记日志。"""
        if message is None:
            return
        try:
            message.accept()
        except Exception:  # noqa: BLE001
            logger.warning("AMQP 消息 accept 失败（连接可能已断开），忽略", exc_info=True)


# --------------------------------------------------------------- 自实现重连循环
def _run_loop(stop_event: threading.Event) -> None:
    """消费线程主循环：建连 → 运行 → 断开后按 1/2/4/8/15 秒退避重连。

    ``container.run()`` 返回意味着连接结束（正常关闭 / 错误 / 被 ``stop()``
    中断）。未被主动停止时按退避等待后重建 Container，每次建连都会重新
    生成接入凭证的 timestamp。
    """
    global _container
    attempt = 0  # 累计失败次数（只用于选取退避间隔，间隔本身封顶 15 秒）

    while not stop_event.is_set():
        handler = IotdaAmqpHandler(stop_event=stop_event)
        container: Any = None
        try:
            container = _build_container(handler)
            with _lock:
                _container = container
            # 阻塞运行，直到连接结束或 stop_consumer_thread() 调用 stop()
            container.run()
        except KeyboardInterrupt:
            logger.info("AMQP 消费线程收到 KeyboardInterrupt，退出")
            break
        except Exception:  # noqa: BLE001 - 任何异常都只记录并进入重连
            logger.exception("AMQP 消费循环异常退出（queue=%s）", handler.queue)
        finally:
            _set_connected(False)
            with _lock:
                if _container is container:
                    _container = None

        if stop_event.is_set():
            break

        delay = BACKOFF_SECONDS[min(attempt, len(BACKOFF_SECONDS) - 1)]
        attempt += 1
        logger.warning("AMQP 连接已结束，%s 秒后重连（累计第 %s 次）", delay, attempt)
        # 用 Event.wait 代替裸 sleep：停机时能立刻醒来
        if stop_event.wait(delay):
            break

    _set_connected(False)
    logger.info("AMQP 消费线程已退出")


# --------------------------------------------------------------- 对外接口
def start_consumer_thread() -> bool:
    """启动 AMQP 消费守护线程；返回是否处于运行状态。

    - 未安装 ``python-qpid-proton``：打印中文提示并返回 ``False``；
    - 配置不完整（``settings.amqp_enabled`` 为假）：同上；
    - 重复调用幂等：线程存活时直接返回 ``True``。
    """
    global _thread, _stop_event

    if not PROTON_AVAILABLE:
        _notify(
            "未安装 python-qpid-proton，AMQP 订阅未启动；"
            "安装命令：pip install python-qpid-proton"
        )
        return False

    cfg = get_settings()
    if not cfg.amqp_enabled:
        _notify(
            "IoTDA AMQP 配置不完整（需 IOTDA_AMQP_HOST / IOTDA_AMQP_ACCESS_KEY / "
            "IOTDA_AMQP_ACCESS_CODE），AMQP 订阅未启动，继续以本地模拟模式运行"
        )
        return False

    with _lock:
        if _thread is not None and _thread.is_alive():
            logger.info("AMQP 消费线程已在运行（queue=%s），忽略重复启动", cfg.iotda_amqp_queue)
            return True

        stop_event = threading.Event()
        thread = threading.Thread(
            target=_run_loop,
            args=(stop_event,),
            daemon=True,
            name="iotda-amqp",
        )
        _stop_event = stop_event
        _thread = thread
        thread.start()

    logger.info(
        "IoTDA AMQP 消费线程已启动（queue=%s，host=%s）",
        cfg.iotda_amqp_queue,
        cfg.iotda_amqp_host,
    )
    return True


def stop_consumer_thread() -> None:
    """停止消费线程（幂等）：置停止事件 → 中断 Container → join(5s)。

    即使容器/线程已经不存在也安全返回；join 超时只打 warning，
    线程是 daemon，不会阻塞进程退出。
    """
    global _thread, _container, _connected

    with _lock:
        thread = _thread
        stop_event = _stop_event
        container = _container

    stop_event.set()

    # proton 的 Container.stop() 用于从其他线程打断 reactor 循环
    if container is not None:
        try:
            container.stop()
        except Exception:  # noqa: BLE001 - 停机阶段不允许抛异常
            logger.debug("停止 AMQP Container 时出现异常（可忽略）", exc_info=True)

    if thread is not None and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=JOIN_TIMEOUT_SECONDS)
        if thread.is_alive():
            logger.warning(
                "AMQP 消费线程未能在 %s 秒内退出（守护线程，进程结束时由系统回收）",
                JOIN_TIMEOUT_SECONDS,
            )

    with _lock:
        if _thread is thread:
            _thread = None
        _container = None
        _connected = False

    logger.info("AMQP 消费线程已停止")


def is_running() -> bool:
    """消费线程是否存活且未被要求停止（供 /api/iot/status 等状态接口使用）。"""
    with _lock:
        thread = _thread
        stop_event = _stop_event
    return bool(thread is not None and thread.is_alive() and not stop_event.is_set())


def is_connected() -> bool:
    """当前是否已成功建立 AMQP 连接并创建 receiver（断线重连期间为 False）。"""
    with _lock:
        return _connected


__all__ = [
    "start_consumer_thread",
    "stop_consumer_thread",
    "is_running",
    "is_connected",
    "PROTON_AVAILABLE",
]