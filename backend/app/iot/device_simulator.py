"""华为云 IoTDA MQTT 设备模拟器（银龄守护手环）。

作用：在没有真实手环的情况下，用一台 PC 模拟设备直连华为云 IoTDA（MQTT 8883 / TLS），
周期性上报体征（心率 / 血压 / 血氧 / 步数 / 电量 / 跌倒 / SOS），并可注入异常事件、
接收云端下发的命令并回 ACK，用于打通「设备上报 → 平台订阅 → 前端告警」整条链路。

鉴权方式（华为云 IoTDA 设备侧规范）：

    时间戳 ts = 毫秒级 Unix 时间字符串
    password  = base64(HMAC-SHA256(key=设备密钥, msg=ts))
    client_id = username = 设备 ID（device_id）

因此 **密码是一次性的**：每次 TCP 连接（含断线重连）都必须用新的时间戳重新生成，
本模块每次连接都重走 :func:`build_credentials`，不会缓存旧密码。

用法示例（PowerShell，先 ``cd backend``）：

    # 0) 前置：backend/.env 里配置 IOTDA_MQTT_HOST / IOTDA_DEVICE_ID / IOTDA_DEVICE_SECRET
    #    并安装依赖：pip install paho-mqtt

    # 1) 正常上报：默认每 5 秒一帧，Ctrl+C 停止
    & 'F:\\Apps\\Python\\python.exe' -m app.iot.device_simulator

    # 2) 启动 10 秒后注入一次心率异常（--event-after 可改触发时刻，只影响一帧）
    & 'F:\\Apps\\Python\\python.exe' -m app.iot.device_simulator --event hr --event-after 10

    # 3) 立即上报一帧跌倒异常后退出，便于单次联调
    & 'F:\\Apps\\Python\\python.exe' -m app.iot.device_simulator --event fall --once

    # 4) 用环境变量注入异常 + 改成 2 秒一帧（脚本 / 自动化演示更省事）
    $env:SIMULATE_EVENT = 'spo2'; $env:SIMULATE_INTERVAL = '2'
    & 'F:\\Apps\\Python\\python.exe' -m app.iot.device_simulator

环境变量一览：

    IOTDA_MQTT_HOST / IOTDA_MQTT_PORT / IOTDA_DEVICE_ID / IOTDA_DEVICE_SECRET
        连接参数（host、8883、设备 ID、设备密钥），见 ``app/config.py``。
    IOTDA_SERVICE_ID    产品模型中的服务 ID，默认 ``DefaultService``。
    SIMULATE_INTERVAL   上报间隔秒数，默认 5。
    SIMULATE_EVENT      hr | spo2 | bp | fall | sos，注入一次异常（等价于 --event）。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import random
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from ..config import Settings, get_settings

# paho-mqtt 是可选依赖：缺失时本模块仍可被 import（便于离线跑单测 / 编译检查），
# 只有真正要联网时才报中文提示并退出。
try:  # pragma: no cover - 取决于运行环境是否安装 paho
    import paho.mqtt.client as mqtt
except ImportError:  # pragma: no cover
    mqtt = None  # type: ignore[assignment]

try:  # paho 2.x 提供显式的回调 API 版本枚举；1.x 没有，降级即可
    from paho.mqtt.enums import CallbackAPIVersion
except ImportError:  # pragma: no cover
    CallbackAPIVersion = None  # type: ignore[assignment]


# ---------------------------------------------------------------- 常量与主题

#: 上报 topic 模板：设备属性上报
TOPIC_REPORT_TMPL: str = "$oc/devices/{device_id}/sys/properties/report"

#: 命令下行 topic 通配符：平台下发的命令都落在该前缀下
TOPIC_COMMAND_TMPL: str = "$oc/devices/{device_id}/sys/commands/#"

#: 命令应答 topic 模板：request_id 必须与下行命令一致
TOPIC_RESPONSE_TMPL: str = (
    "$oc/devices/{device_id}/sys/commands/response/request_id={request_id}"
)

#: 属性上报报文的服务 ID。
#: 注意：**以 IoTDA 控制台「产品模型」中定义的服务 ID 为准**，
#: 产品模型里服务 ID 若叫 ``HealthMonitor``，这里就必须改成 ``HealthMonitor``，
#: 否则平台会以「服务不存在」丢弃整帧数据。可用 IOTDA_SERVICE_ID 覆盖。
DEFAULT_SERVICE_ID: str = "DefaultService"

#: 支持的异常事件类型
EVENT_TYPES: Tuple[str, ...] = ("hr", "spo2", "bp", "fall", "sos")

#: 异常事件的中文名（仅用于日志）
EVENT_LABELS: Dict[str, str] = {
    "hr": "心率异常（心动过速）",
    "spo2": "血氧过低",
    "bp": "血压过高",
    "fall": "跌倒",
    "sos": "一键 SOS 求助",
}

#: 默认上报间隔（秒）
DEFAULT_INTERVAL: float = 5.0

#: 默认异常注入时刻（启动后第 N 秒）
DEFAULT_EVENT_AFTER: float = 10.0

#: MQTT keepalive（秒）
KEEPALIVE_SECONDS: int = 120

#: 上报 / 应答统一用 QoS1，保证平台收到 PUBACK，避免演示时丢帧
PUBLISH_QOS: int = 1

#: 单帧发布等待 PUBACK 的超时（秒），仅 --once 模式会阻塞等待
PUBLISH_TIMEOUT: float = 5.0

#: --once 模式等待连接建立的最长时间（秒）
ONCE_CONNECT_TIMEOUT: float = 10.0

#: 断线重连退避序列（秒）：1 → 2 → 4 → 8 → 16，之后固定 16 秒
RECONNECT_BACKOFF: Tuple[float, ...] = (1.0, 2.0, 4.0, 8.0, 16.0)

#: 断线后最多持续重试的时长（秒）：15 分钟
RECONNECT_WINDOW_SECONDS: float = 15 * 60.0

#: 命令应答报文体（华为云 IoTDA 命令响应格式）
COMMAND_RESPONSE: Dict[str, Any] = {
    "result_code": 0,
    "response_name": "COMMAND_RESPONSE",
    "paras": {"result": "success"},
}


# ---------------------------------------------------------------- 鉴权工具


def build_password(secret: str, ts: str) -> str:
    """按华为云 IoTDA 规范生成密码：``base64(HMAC-SHA256(secret, ts))``。

    :param secret: 设备密钥（IOTDA_DEVICE_SECRET）
    :param ts: 毫秒级时间戳字符串（13 位）
    :return: Base64 编码后的 44 位密码串
    :raises ValueError: 密钥为空时无法签名
    """
    if not secret:
        raise ValueError("设备密钥为空，无法生成 IoTDA 鉴权签名")
    digest = hmac.new(
        secret.encode("utf-8"),
        ts.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(digest).decode("ascii")


def build_credentials(
    device_id: str, secret: str, ts: Optional[str] = None
) -> Tuple[str, str, str, str]:
    """生成一组"当前时刻"可用的连接参数。

    IoTDA 的密码与时间戳绑定，连接时生成、断线重连必须重新生成，
    因此这里把 client_id / username / password / ts 一起返回便于日志核对。

    :return: ``(client_id, username, password, ts)``
    """
    timestamp = ts if ts is not None else str(int(time.time() * 1000))
    password = build_password(secret, timestamp)
    # 华为云规范：client_id 与 username 都填设备 ID
    return device_id, device_id, password, timestamp


def report_topic(device_id: str) -> str:
    """属性上报 topic。"""
    return TOPIC_REPORT_TMPL.format(device_id=device_id)


def command_topic(device_id: str) -> str:
    """命令订阅 topic（通配 ``#``，一个订阅覆盖所有命令）。"""
    return TOPIC_COMMAND_TMPL.format(device_id=device_id)


def response_topic(device_id: str, request_id: str) -> str:
    """命令应答 topic。"""
    return TOPIC_RESPONSE_TMPL.format(device_id=device_id, request_id=request_id)


def build_report_payload(service_id: str, properties: Dict[str, Any]) -> str:
    """拼装属性上报报文：``{"services":[{service_id, properties}]}``。"""
    body = {"services": [{"service_id": service_id, "properties": properties}]}
    return json.dumps(body, ensure_ascii=False)


def extract_request_id(topic: str, payload_text: str) -> Optional[str]:
    """从下行命令中解析 ``request_id``。

    两种来源都兼容：

    1. topic 末段形如 ``.../sys/commands/request_id=abc123``；
    2. payload 里的 ``request_id`` 字段。
    """
    tail = topic.rsplit("/", 1)[-1]
    if tail.startswith("request_id="):
        candidate = tail[len("request_id=") :].strip()
        if candidate:
            return candidate
    try:
        data = json.loads(payload_text)
    except (TypeError, ValueError):
        return None
    if isinstance(data, dict):
        value = data.get("request_id")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _reason_code(rc: Any) -> int:
    """把 paho 的返回码归一化成 int（兼容 2.x 的 ``ReasonCode`` 与 1.x 的 int）。"""
    value = getattr(rc, "value", rc)
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1


#: CONNACK 返回码 → 中文排查建议（0 为成功）
CONNECT_HINTS: Dict[int, str] = {
    0: "连接成功",
    1: "协议版本不被接受：请使用 MQTT 3.1.1（IoTDA 不支持 3.1）",
    2: "clientId 被拒绝：请检查 IOTDA_DEVICE_ID 是否为控制台上的设备 ID",
    3: "服务端不可用：请检查实例域名 IOTDA_MQTT_HOST 与 8883 端口是否可达",
    4: "用户名或密码错误：请核对 IOTDA_DEVICE_SECRET（密码需按时间戳动态生成）",
    5: "未授权：设备可能已被冻结或删除，请到 IoTDA 控制台确认设备状态",
}


def _login_hint(code: int) -> str:
    """返回某返回码对应的中文提示；未知码附加统一排查建议。"""
    return CONNECT_HINTS.get(
        code,
        "鉴权失败：请检查设备 ID / 设备密钥 / 实例域名三项是否与 IoTDA 控制台一致",
    )


# ---------------------------------------------------------------- 上报数据模型


class VitalsGenerator:
    """体征数据生成器（线程安全）。

    数值规律参考前端 ``assets/js/data/mock.js``：

    - 心率 60–100，随机游走并缓慢回归基线；
    - 血氧 95–99；
    - 收缩压 110–140，舒张压按收缩压的 0.62 倍联动并夹到 70–90；
    - 步数单调递增；
    - 电量缓慢下降，低于 20% 时进入"充电"状态并回升到满电。
    """

    #: 正常态基线
    _HR_CENTER: float = 72.0
    _SPO2_CENTER: float = 97.0
    _SBP_CENTER: float = 124.0

    def __init__(self, rng: Optional[random.Random] = None) -> None:
        self._lock = threading.Lock()
        self._rng = rng or random.Random()

        # 初始状态：与前端 mock 的中位值接近，避免第一帧就"异常"
        self._hr: float = 72.0
        self._spo2: float = 97.0
        self._sbp: float = 124.0
        self._dbp: int = 77
        self._steps: int = 1200
        self._battery: float = 86.0
        self._charging: bool = False

        # 待注入的异常事件（只有一帧生效，取走后立刻清空）
        self._pending_event: Optional[str] = None

    # ---------------------------------------------------------- 异常注入
    def queue_event(self, event: Optional[str]) -> None:
        """登记一个"只影响下一帧"的异常事件。"""
        with self._lock:
            self._pending_event = event

    @property
    def pending_event(self) -> Optional[str]:
        """当前排队中的异常事件（调试 / 自检用）。"""
        with self._lock:
            return self._pending_event

    # ---------------------------------------------------------- 帧生成
    def next_frame(self) -> Dict[str, Any]:
        """生成一帧属性字典；若排队了异常事件，则仅本帧被改写。"""
        with self._lock:
            event = self._pending_event
            self._pending_event = None  # 只影响一帧，随后恢复正常
            properties = self._evolve()
            if event:
                self._apply_event(properties, event)
            return properties

    def _evolve(self) -> Dict[str, Any]:
        """按随机游走推进一次内部状态，返回常规属性（调用方需持锁）。"""
        rng = self._rng

        # 心率：随机游走 + 向基线回归，限制在 60–100
        self._hr += rng.uniform(-2.4, 2.4) + (self._HR_CENTER - self._hr) * 0.18
        self._hr = min(100.0, max(60.0, self._hr))

        # 血氧：围绕 97% 小幅波动，限制在 95–99
        self._spo2 += rng.uniform(-0.45, 0.45) + (self._SPO2_CENTER - self._spo2) * 0.25
        self._spo2 = min(99.0, max(95.0, self._spo2))

        # 收缩压：随机游走 + 回归，限制在 110–140
        self._sbp += rng.uniform(-2.5, 2.5) + (self._SBP_CENTER - self._sbp) * 0.16
        self._sbp = min(140.0, max(110.0, self._sbp))

        # 舒张压：与收缩压联动（约 0.62 倍），再夹到 70–90
        dbp = self._sbp * 0.62 + rng.uniform(-2.0, 2.0)
        self._dbp = int(min(90, max(70, round(dbp))))

        # 步数：单调递增（每帧走一小段）
        self._steps += rng.randint(3, 22)

        # 电量：缓慢下降；低于 20% 视为插上充电，快速回升到 100% 后继续下降
        if self._charging:
            self._battery = min(100.0, self._battery + rng.uniform(0.8, 1.6))
            if self._battery >= 99.5:
                self._charging = False
        else:
            self._battery -= rng.uniform(0.02, 0.08)
            if self._battery < 20.0:
                self._battery = max(0.0, self._battery)
                self._charging = True

        return {
            "hr": int(round(self._hr)),
            "sbp": int(round(self._sbp)),
            "dbp": self._dbp,
            "spo2": int(round(self._spo2)),
            "steps": self._steps,
            "battery": int(round(self._battery)),
            "fall": 0,
            "sos": 0,
        }

    @staticmethod
    def _apply_event(properties: Dict[str, Any], event: str) -> None:
        """把异常事件写入一帧属性（数值均越过前端默认阈值，可直接触发告警）。"""
        if event == "hr":
            # 118 起跳，在 118–130 区间抖动（高于阈值 105 bpm，且越过 critical 边界 115）
            properties["hr"] = 118 + random.randint(0, 12)
        elif event == "spo2":
            properties["spo2"] = 88  # 低于阈值 92%
        elif event == "bp":
            properties["sbp"] = 158  # 高于阈值 150 mmHg
            properties["dbp"] = 96
        elif event == "fall":
            properties["fall"] = 1
        elif event == "sos":
            properties["sos"] = 1
        # 未知事件由上层校验拦截，这里直接忽略，不影响正常帧


# ---------------------------------------------------------------- 模拟器主体


class DeviceSimulator:
    """IoTDA MQTT 设备模拟器。

    - 用 :meth:`connect` 建立 TLS 连接（每次连接都重新生成时间戳与密码）；
    - 用 ``threading.Timer`` 驱动定时上报（网络收发由 paho ``loop_start`` 负责）；
    - 断线后按 1→2→4→8→16 秒退避重连，最长持续 15 分钟；
    - 订阅命令 topic 并回 ACK。
    """

    def __init__(
        self,
        settings: Settings,
        event: Optional[str] = None,
        interval: float = DEFAULT_INTERVAL,
        once: bool = False,
        event_after: float = DEFAULT_EVENT_AFTER,
        service_id: str = DEFAULT_SERVICE_ID,
    ) -> None:
        self.settings = settings
        self.event = event
        self.interval = interval
        self.once = once
        self.event_after = event_after
        self.service_id = service_id

        self.device_id = settings.iotda_device_id.strip()
        self.host = settings.iotda_mqtt_host.strip()
        self.port = settings.iotda_mqtt_port

        # 主题只在构造时拼一次，避免每帧重复格式化
        self._report_topic = report_topic(self.device_id)
        self._command_topic = command_topic(self.device_id)

        self.generator = VitalsGenerator()

        # --- 连接与线程状态 ---
        self._client: Optional["mqtt.Client"] = None
        self._client_lock = threading.Lock()
        self._shutdown_lock = threading.Lock()
        self._shutdown_done = False
        self._stop_event = threading.Event()
        self._connected_event = threading.Event()

        self._report_timer: Optional[threading.Timer] = None
        self._timer_lock = threading.Lock()
        self._event_timer: Optional[threading.Timer] = None
        self._reconnect_timer: Optional[threading.Timer] = None

        self._connect_count = 0
        self._reconnect_attempt = 0
        self._reconnecting = False
        self._disconnected_since: Optional[float] = None

        self._report_count = 0
        self._report_lock = threading.Lock()

    # ---------------------------------------------------------- 日志
    @staticmethod
    def _log(message: str) -> None:
        """带时间前缀的中文日志（模拟器面向人工观察，直接 print 更直观）。"""
        print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)

    def _banner(self) -> None:
        """打印启动参数概览（绝不打印设备密钥）。"""
        print("=" * 66)
        print(" 华为云 IoTDA 设备模拟器 · 银龄守护手环")
        print(f"  实例地址 : {self.host}:{self.port}（TLS）")
        print(f"  设备 ID  : {self.device_id}")
        print(f"  服务 ID  : {self.service_id}（以控制台产品模型中的服务 ID 为准）")
        print(f"  上报间隔 : {self.interval:g} 秒")
        if self.event:
            if self.once:
                print(f"  异常注入 : {EVENT_LABELS.get(self.event, self.event)}（单帧后退出）")
            else:
                print(
                    f"  异常注入 : {EVENT_LABELS.get(self.event, self.event)}"
                    f"（启动 {self.event_after:g} 秒后，仅一帧）"
                )
        print("=" * 66)

    # ---------------------------------------------------------- 连接
    def _build_client(self) -> "mqtt.Client":
        """构造 paho 客户端：MQTT 3.1.1 + TLS（系统 CA，不关闭证书校验）。"""
        if mqtt is None:  # 理论上前置检查已拦截，这里兜底
            raise RuntimeError("paho-mqtt 未安装")

        options: Dict[str, Any] = {
            "client_id": self.device_id,
            "protocol": mqtt.MQTTv311,
        }
        if CallbackAPIVersion is not None:
            # paho 2.x 必须显式声明回调版本；用 VERSION1 以保持 1.x/2.x 行为一致
            client = mqtt.Client(
                callback_api_version=CallbackAPIVersion.VERSION1, **options
            )
        else:  # paho 1.x
            client = mqtt.Client(**options)

        client.on_connect = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_message = self._on_message

        # tls_set() 不传参 = 使用系统 / certifi 默认 CA 证书；再显式关闭"跳过校验"
        client.tls_set()
        client.tls_insecure_set(False)
        return client

    def connect(self) -> bool:
        """建立一次连接；每次调用都重新生成时间戳与密码（重连同样生效）。"""
        with self._client_lock:
            old_client, self._client = self._client, None
        if old_client is not None:
            # 先释放上一个客户端，避免同一设备 ID 出现两条连接
            self._safe_teardown(old_client)

        try:
            client = self._build_client()
        except Exception as exc:  # pragma: no cover - 构造失败属环境问题
            self._log(f"[连接失败] 初始化 MQTT 客户端出错：{exc}")
            return False

        # 密码必须在 connect 之前生成，且每次连接都用新的毫秒时间戳
        client_id, username, password, ts = build_credentials(
            self.device_id, self.settings.iotda_device_secret.strip()
        )
        client.username_pw_set(username, password)

        with self._client_lock:
            self._client = client

        self._log(
            f"[连接] 正在连接 {self.host}:{self.port} "
            f"(client_id={client_id}, ts={ts}, 密码按 HMAC-SHA256 现算)"
        )
        try:
            client.connect(self.host, self.port, keepalive=KEEPALIVE_SECONDS)
            # loop_start 起后台网络线程，后续 publish/subscribe 无需手动 loop()
            client.loop_start()
        except Exception as exc:
            self._log(f"[连接失败] {exc}（域名/网络/端口请自查）")
            self._safe_teardown(client)
            with self._client_lock:
                if self._client is client:
                    self._client = None
            return False
        return True

    def _safe_teardown(self, client: "mqtt.Client") -> None:
        """静默关闭一个客户端（停止网络线程 + 断开连接），异常不外抛。"""
        try:
            client.loop_stop()
        except Exception:  # pragma: no cover - 关闭阶段的异常不影响主流程
            pass
        try:
            client.disconnect()
        except Exception:  # pragma: no cover
            pass

    # ---------------------------------------------------------- 回调
    def _on_connect(
        self,
        client: "mqtt.Client",
        userdata: Any,
        flags: Dict[str, Any],
        rc: Any,
        properties: Any = None,
    ) -> None:
        """CONNACK 回调：成功则订阅命令 topic；失败则给出中文排查建议。"""
        code = _reason_code(rc)
        if code == 0:
            self._reconnect_attempt = 0
            self._reconnecting = False
            self._disconnected_since = None
            self._connected_event.set()
            self._connect_count += 1
            # 重连场景（第 2 次及以后）同样在这里重新订阅，保证命令通道恢复
            suffix = "（重连成功，重新订阅命令 topic）" if self._connect_count > 1 else ""
            self._log(f"[连接] CONNACK rc=0 鉴权通过，连接成功{suffix}")
            try:
                result, mid = client.subscribe(self._command_topic, qos=PUBLISH_QOS)
                if result == mqtt.MQTT_ERR_SUCCESS:
                    self._log(
                        f"[订阅] 已订阅命令 topic：{self._command_topic} (mid={mid})"
                    )
                else:
                    self._log(f"[订阅] 订阅失败 rc={result}，请检查设备权限")
            except Exception as exc:  # pragma: no cover
                self._log(f"[订阅] 订阅命令 topic 异常：{exc}")
            # 首次连接成功后启动上报循环（0.5 秒后先发一帧，便于立即在控制台看到数据）
            self._start_report_loop()
        else:
            self._log(f"[连接失败] CONNACK rc={code} —— {_login_hint(code)}")
            self._log("           排查顺序：设备 ID → 设备密钥 → 实例域名/端口 → 设备状态")
            # 平台拒绝鉴权后通常会断开 TCP，但为避免"半死连接"卡住，这里主动
            # 安排一次退避重连（重连会新建客户端并重新生成时间戳与密码）。
            self._schedule_reconnect()

    def _on_disconnect(
        self,
        client: "mqtt.Client",
        userdata: Any,
        rc: Any,
        properties: Any = None,
    ) -> None:
        """断开回调：非主动退出时按退避策略重建连接。"""
        code = _reason_code(rc)
        self._connected_event.clear()
        if self._stop_event.is_set():
            return
        if rc == 0 or code == 0:
            self._log("[断开] 与 IoTDA 的连接已正常关闭。")
        else:
            self._log(f"[断开] 与 IoTDA 的连接意外断开（rc={code}），准备重连…")
        if self.once:
            return
        self._schedule_reconnect()

    def _on_message(
        self, client: "mqtt.Client", userdata: Any, message: "mqtt.MQTTMessage"
    ) -> None:
        """命令下行回调：打印命令内容，解析 request_id 并回 ACK。"""
        topic = message.topic
        try:
            text = message.payload.decode("utf-8", errors="replace")
        except Exception:  # pragma: no cover - 极端编码问题
            text = repr(message.payload)

        print()  # 与周期上报日志分段，便于肉眼辨认
        self._log(f"[收到命令] topic={topic}")
        self._log(f"[收到命令] payload={text}")

        request_id = extract_request_id(topic, text)
        if not request_id:
            self._log("[收到命令] 未能解析 request_id，跳过 ACK（平台会判定命令超时）")
            return

        body = json.dumps(COMMAND_RESPONSE, ensure_ascii=False)
        ack_topic = response_topic(self.device_id, request_id)
        try:
            info = client.publish(ack_topic, body, qos=PUBLISH_QOS)
        except Exception as exc:  # pragma: no cover
            self._log(f"[命令应答] 发布失败：{exc}")
            return
        self._log(f"[命令应答] request_id={request_id} rc={info.rc}")
        self._log(f"[命令应答] topic={ack_topic}")
        self._log(f"[命令应答] payload={body}")

    # ---------------------------------------------------------- 上报
    def _start_report_loop(self) -> None:
        """首次连接成功后启动上报定时器（只启动一次）。"""
        if self._report_timer is not None or self._stop_event.is_set():
            return
        self._schedule_next_report(0.5)

    def _schedule_next_report(self, delay: float) -> None:
        """安排下一次上报；``threading.Timer`` 到点后自行续排，形成周期循环。"""
        if self._stop_event.is_set():
            return
        timer = threading.Timer(max(0.0, delay), self._report_tick)
        timer.daemon = True  # 主进程退出时不被上报线程拖住
        with self._timer_lock:
            if self._report_timer is not None:
                self._report_timer.cancel()
            self._report_timer = timer
        timer.start()

    def _report_tick(self) -> None:
        """一次上报：取一帧数据 → 发布 → 续排下一次。"""
        if self._stop_event.is_set():
            return
        try:
            self.publish_frame()
        except Exception as exc:  # pragma: no cover - 单帧失败不能中断循环
            self._log(f"[上报异常] {exc}")
        finally:
            if not self._stop_event.is_set():
                self._schedule_next_report(self.interval)

    def publish_frame(
        self,
        properties: Optional[Dict[str, Any]] = None,
        wait: bool = False,
    ) -> bool:
        """发布一帧属性；返回是否成功投递（``wait=True`` 时会等 PUBACK）。

        :param properties: 指定属性字典；``None`` 表示让生成器产出一帧
        :param wait: True 时阻塞等待发布完成（``--once`` 模式使用）
        """
        frame = properties if properties is not None else self.generator.next_frame()

        with self._client_lock:
            client = self._client
        if client is None or not client.is_connected():
            self._log("[上报跳过] 当前未连接 IoTDA，等重连成功后自动继续。")
            return False

        payload = build_report_payload(self.service_id, frame)
        try:
            info = client.publish(self._report_topic, payload, qos=PUBLISH_QOS)
        except Exception as exc:  # pragma: no cover
            self._log(f"[上报失败] publish 异常：{exc}")
            return False

        with self._report_lock:
            self._report_count += 1
            index = self._report_count

        self._log(
            f"[上报 #{index}] hr={frame['hr']} sbp={frame['sbp']} dbp={frame['dbp']} "
            f"spo2={frame['spo2']} steps={frame['steps']} battery={frame['battery']} "
            f"fall={frame['fall']} sos={frame['sos']} (mid={info.mid})"
        )

        if not wait:
            return info.rc == mqtt.MQTT_ERR_SUCCESS

        try:
            info.wait_for_publish(timeout=PUBLISH_TIMEOUT)
        except (RuntimeError, ValueError) as exc:
            self._log(f"[上报失败] 等待 PUBACK 超时：{exc}")
            return False
        if info.is_published():
            self._log("[上报] 已收到平台 QoS1 PUBACK，数据送达 IoTDA。")
            return True
        self._log(f"[上报失败] 未收到 PUBACK（rc={info.rc}），请检查网络或设备权限。")
        return False

    # ---------------------------------------------------------- 异常注入
    def _trigger_event(self) -> None:
        """定时器回调：把异常事件排进队列，由下一帧消费。"""
        if self._stop_event.is_set() or not self.event:
            return
        self.generator.queue_event(self.event)
        name = EVENT_LABELS.get(self.event, self.event)
        self._log(f"[异常注入] 准备就绪：{name}，将在下一帧上报后自动恢复正常。")

    # ---------------------------------------------------------- 重连
    def _schedule_reconnect(self) -> None:
        """按 1→2→4→8→16 秒退避安排重连；最长持续 15 分钟后放弃。"""
        if self._stop_event.is_set() or self.once:
            return
        # 已经重新连上（或正在连接）时，忽略重复的断线通知，避免多枚定时器互相踩踏
        if self._connected_event.is_set():
            return
        with self._client_lock:
            if self._reconnecting:
                return
            self._reconnecting = True
            if self._disconnected_since is None:
                self._disconnected_since = time.monotonic()
            attempt = self._reconnect_attempt
            self._reconnect_attempt += 1

        elapsed = time.monotonic() - (self._disconnected_since or time.monotonic())
        if elapsed >= RECONNECT_WINDOW_SECONDS:
            self._log(
                "[重连] 已持续重试 15 分钟仍未成功，停止上报。"
                "请检查网络、实例域名与设备凭证后重新启动。"
            )
            self.shutdown()
            return

        delay = RECONNECT_BACKOFF[min(attempt, len(RECONNECT_BACKOFF) - 1)]
        self._log(
            f"[重连] {delay:g} 秒后进行第 {attempt + 1} 次重连"
            f"（已断开 {elapsed:.0f} 秒，最长重试 15 分钟）"
        )
        timer = threading.Timer(delay, self._reconnect_tick)
        timer.daemon = True
        with self._timer_lock:
            if self._reconnect_timer is not None:
                self._reconnect_timer.cancel()
            self._reconnect_timer = timer
        timer.start()

    def _reconnect_tick(self) -> None:
        """重连定时器回调：重建客户端（新时间戳 + 新密码）并重新连接。"""
        if self._stop_event.is_set() or self._connected_event.is_set():
            return
        self._log("[重连] 重新生成时间戳与密钥后发起连接…")
        # 连接过程中保持 _reconnecting=True，这样 connect() 内部拆掉旧客户端
        # 触发的 on_disconnect 不会再排一枚多余的重连定时器。
        connected = self.connect()
        with self._client_lock:
            self._reconnecting = False
        if not connected:
            # connect 内部已释放半开客户端，这里继续退避
            self._schedule_reconnect()

    # ---------------------------------------------------------- 生命周期
    def run(self) -> None:
        """常驻运行：连接 → 周期上报 →（事件注入）→ Ctrl+C 退出。"""
        self._banner()
        if not self.connect():
            # 首次连接就失败：同样进入退避重试，而不是直接退出
            self._disconnected_since = time.monotonic()
            self._log("[运行] 首次连接失败，按退避策略自动重试…")
            self._schedule_reconnect()

        # --event 且非 --once：启动 N 秒后注入一次（默认 10 秒）
        if self.event and not self.once:
            timer = threading.Timer(max(0.0, self.event_after), self._trigger_event)
            timer.daemon = True
            self._event_timer = timer
            timer.start()

        self._log("[运行] 模拟器已启动，按 Ctrl+C 停止。")
        try:
            while not self._stop_event.wait(0.5):
                pass
        except KeyboardInterrupt:
            print()
            self._log("[退出] 收到 Ctrl+C，正在断开连接…")
        finally:
            self.shutdown()

    def run_once(self) -> int:
        """一次性模式：连接成功后立即上报一帧异常数据并退出。"""
        self._banner()
        self._log("[单次] 一次性上报模式：连接成功后立即发送一帧并退出。")
        if self.event:
            self.generator.queue_event(self.event)
        else:
            self._log("[单次] 未指定 --event，将上报一帧正常数据。")

        if not self.connect():
            self._log("[单次] 无法建立连接，退出（本模式不做重试）。")
            self.shutdown()
            return 1

        if not self._connected_event.wait(ONCE_CONNECT_TIMEOUT):
            self._log(
                f"[单次] {ONCE_CONNECT_TIMEOUT:g} 秒内未收到 CONNACK，"
                "请检查设备 ID / 密钥 / 实例域名。"
            )
            self.shutdown()
            return 1

        ok = self.publish_frame(wait=True)
        self.shutdown()
        return 0 if ok else 1

    def shutdown(self) -> None:
        """优雅退出：停定时器 → loop_stop → disconnect → 打印停止提示（幂等）。"""
        with self._shutdown_lock:
            if self._shutdown_done:
                return
            self._shutdown_done = True

        self._stop_event.set()
        for timer in (self._report_timer, self._event_timer, self._reconnect_timer):
            if timer is not None:
                try:
                    timer.cancel()
                except Exception:  # pragma: no cover
                    pass

        with self._client_lock:
            client, self._client = self._client, None
        if client is not None:
            try:
                client.loop_stop()
            except Exception:  # pragma: no cover
                pass
            try:
                client.disconnect()
            except Exception:  # pragma: no cover
                pass

        self._log("[退出] 已停止上报。")


# ---------------------------------------------------------------- 环境 / 参数


def _env_float(name: str, default: float, minimum: float = 0.5) -> float:
    """读取浮点环境变量；非法值或小于下限时回退默认值（保持可启动）。"""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw.strip())
    except ValueError:
        print(f"[配置] 环境变量 {name}={raw!r} 非法，使用默认值 {default:g}。")
        return default
    if value < minimum:
        print(f"[配置] 环境变量 {name}={value:g} 过小，使用默认值 {default:g}。")
        return default
    return value


def resolve_event(cli_event: Optional[str]) -> Optional[str]:
    """确定本次运行的异常事件：命令行优先，其次环境变量 SIMULATE_EVENT。"""
    if cli_event:
        return cli_event.strip().lower()
    raw = (os.getenv("SIMULATE_EVENT") or "").strip().lower()
    return raw or None


def resolve_service_id() -> str:
    """读取服务 ID；空值回退 ``DefaultService``（以产品模型为准）。"""
    raw = (os.getenv("IOTDA_SERVICE_ID") or "").strip()
    return raw or DEFAULT_SERVICE_ID


def build_arg_parser() -> argparse.ArgumentParser:
    """构造命令行解析器（独立成函数，便于离线单测 --once 等参数）。"""
    parser = argparse.ArgumentParser(
        prog="python -m app.iot.device_simulator",
        description="华为云 IoTDA MQTT 设备模拟器：上报银龄守护手环体征并接收云端命令。",
    )
    parser.add_argument(
        "--event",
        choices=list(EVENT_TYPES),
        default=None,
        help="注入一次异常事件：hr / spo2 / bp / fall / sos（等价于 SIMULATE_EVENT）",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="只上报一帧（配合 --event 即单帧异常）后退出，便于单次验证",
    )
    parser.add_argument(
        "--event-after",
        dest="event_after",
        type=float,
        default=DEFAULT_EVENT_AFTER,
        metavar="SECONDS",
        help=f"启动后第 N 秒注入异常，默认 {DEFAULT_EVENT_AFTER:g} 秒",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=None,
        metavar="SECONDS",
        help="上报间隔秒数，默认读取 SIMULATE_INTERVAL 或 5",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    """入口：参数解析 → 前置检查 → 运行模拟器。"""
    args = build_arg_parser().parse_args(argv)

    # --- 前置检查 1：依赖缺失时给出中文提示并干净退出（不抛异常栈）---
    if mqtt is None:
        print("[依赖缺失] 未安装 paho-mqtt。")
        print("           请执行：pip install paho-mqtt 后重试。")
        sys.exit(0)

    # --- 前置检查 2：MQTT 三项配置未齐备 → 提示后以 0 退出 ---
    settings = get_settings()
    if not settings.mqtt_enabled:
        print("[配置缺失] 未启用 IoTDA 设备侧 MQTT 直连，模拟器无法启动。")
        print("           请在 backend/.env 中配置以下三项后重试：")
        print("             IOTDA_MQTT_HOST=xxxxxxxx.st1.iotda-device.cn-north-4.myhuaweicloud.com")
        print("             IOTDA_DEVICE_ID=你的设备ID")
        print("             IOTDA_DEVICE_SECRET=你的设备密钥")
        sys.exit(0)

    # --- 参数 / 环境变量归并 ---
    event = resolve_event(args.event)
    if event is not None and event not in EVENT_TYPES:
        print(f"[参数错误] 不支持的事件 {event!r}，可选：{', '.join(EVENT_TYPES)}")
        sys.exit(2)

    if args.interval is not None:
        if args.interval <= 0:
            print(f"[参数错误] --interval 必须大于 0，当前为 {args.interval:g}。")
            sys.exit(2)
        interval = float(args.interval)
    else:
        interval = _env_float("SIMULATE_INTERVAL", DEFAULT_INTERVAL)

    if args.event_after < 0:
        print(f"[参数错误] --event-after 不能为负数，当前为 {args.event_after:g}。")
        sys.exit(2)

    simulator = DeviceSimulator(
        settings=settings,
        event=event,
        interval=interval,
        once=bool(args.once),
        event_after=float(args.event_after),
        service_id=resolve_service_id(),
    )

    if simulator.once:
        return simulator.run_once()
    simulator.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())