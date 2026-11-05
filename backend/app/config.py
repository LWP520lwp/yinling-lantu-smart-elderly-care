"""配置模块：从 ``backend/.env`` 读取环境变量并提供全局单例配置。

设计要点：
1. 不依赖 ``pydantic-settings``，仅使用 ``os.getenv`` + ``python-dotenv``；
2. ``.env`` 的路径由本文件的绝对位置推导（``backend/app/config.py`` 的上一级），
   因此无论从哪个工作目录启动 uvicorn，都能读到同一个 ``backend/.env``；
3. :class:`Settings` 为不可变快照，避免运行期被意外修改；
4. IoT（IoTDA MQTT / AMQP、SQLite 落库、云端命令下发）配置同样只做读取，
   是否启用由 ``mqtt_enabled`` / ``amqp_enabled`` / ``iot_enabled`` /
   ``command_enabled`` 四个派生属性判断，缺省全空 = 本地模拟模式。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Tuple

from dotenv import load_dotenv

# backend/ 目录（app/config.py 的上一级目录），保证路径与启动目录无关
BASE_DIR: Path = Path(__file__).resolve().parent.parent
ENV_PATH: Path = BASE_DIR / ".env"

# override=False：真实环境变量的优先级高于 .env，方便容器 / CI 注入
load_dotenv(dotenv_path=ENV_PATH, override=False)

# 默认值集中定义，便于 README 与 .env.example 保持一致
DEFAULT_MODEL: str = "deepseek-v4-flash"
DEFAULT_BASE_URL: str = "https://api.modelarts-maas.com/v2/chat/completions"
DEFAULT_PORT: int = 8000
# CORS 显式白名单：默认只放行本机静态服务器常用的 8080 / 5500 端口。
# 最后一项 "null" 是浏览器从 file:// 页面发起请求时携带的 Origin 字面量，
# 必须保留，否则双击 index.html 的演示请求会全部被浏览器 CORS 拦截；
# 换端口启动静态服务器时请自行追加对应来源，生产环境禁止填 "*"。
DEFAULT_CORS_ORIGINS: Tuple[str, ...] = (
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "null",
)

# --- 认证相关默认值 ---
# token 有效期缺省 8 小时；合法区间 5 分钟 - 7 天
DEFAULT_AUTH_TTL_SECONDS: int = 28800
MIN_AUTH_TTL_SECONDS: int = 300
MAX_AUTH_TTL_SECONDS: int = 604800

# --- IoT 相关默认值（与 .env.example 中的注释保持一致） ---
DEFAULT_MQTT_PORT: int = 8883
DEFAULT_AMQP_PORT: int = 5671
DEFAULT_AMQP_QUEUE: str = "DefaultQueue"
DEFAULT_IOTDB_PATH: Path = BASE_DIR / "data" / "iot.db"
DEFAULT_ELDER_ID: str = "E01"
DEFAULT_ELDER_NAME: str = "张桂芳"


def _get_str(name: str, default: str) -> str:
    """读取字符串环境变量；空字符串视为未配置，回退默认值。"""
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip()
    return value or default


def _get_int(name: str, default: int) -> int:
    """读取整型环境变量；非法值或越界端口回退默认值，避免启动即崩溃。"""
    raw = _get_str(name, "")
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    if not 1 <= value <= 65535:
        return default
    return value


def _get_bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """读取带区间的整型环境变量。

    空值 / 非整数 / 越界一律回退 ``default``（缺省值本身必须落在区间内），
    避免一个手误的 ``AUTH_TTL_SECONDS`` 让 token 立刻过期或永不过期。
    """
    raw = _get_str(name, "")
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    if not minimum <= value <= maximum:
        return default
    return value


def _get_csv(name: str, default: Tuple[str, ...]) -> Tuple[str, ...]:
    """读取逗号分隔的列表配置，例如 ``CORS_ORIGINS=http://a,http://b``。"""
    raw = _get_str(name, "")
    if not raw:
        return default
    items = tuple(item.strip() for item in raw.split(",") if item.strip())
    return items or default


def _get_path(name: str, default: Path) -> Path:
    """读取路径配置；相对路径一律按 ``BASE_DIR`` 解析，保证与启动目录无关。"""
    raw = _get_str(name, "")
    if not raw:
        return default
    candidate = Path(raw).expanduser()
    if candidate.is_absolute():
        return candidate
    return (BASE_DIR / candidate).resolve()


@dataclass(frozen=True, slots=True)
class Settings:
    """运行期配置快照（不可变）。"""

    maas_api_key: str
    maas_model: str
    maas_base_url: str
    app_port: int
    cors_origins: Tuple[str, ...]

    # --- 认证：HMAC-SHA256 无状态 token ---
    # AUTH_SECRET 留空时由 app.auth 在进程内随机生成（重启后旧 token 失效）
    auth_secret: str = ""
    # 合法区间 300 - 604800 秒，越界 / 非法回退 28800
    auth_ttl_seconds: int = DEFAULT_AUTH_TTL_SECONDS

    # --- IoTDA 设备侧 MQTT（8883，TLS）---
    iotda_mqtt_host: str = ""
    iotda_mqtt_port: int = DEFAULT_MQTT_PORT
    iotda_device_id: str = ""
    iotda_device_secret: str = ""

    # --- IoTDA 平台侧 AMQP 订阅（5671，TLS）---
    iotda_amqp_host: str = ""
    iotda_amqp_port: int = DEFAULT_AMQP_PORT
    iotda_amqp_access_key: str = ""
    iotda_amqp_access_code: str = ""
    iotda_amqp_queue: str = DEFAULT_AMQP_QUEUE
    iotda_instance_id: str = ""

    # --- 本地数据落库（SQLite，切 GaussDB 只需替换 app/iot/storage.py）---
    iotdb_path: Path = DEFAULT_IOTDB_PATH

    # --- 设备 → 老人映射，供告警对象展示告警对象使用 ---
    iotda_elder_id: str = DEFAULT_ELDER_ID
    iotda_elder_name: str = DEFAULT_ELDER_NAME

    # --- 云端命令下发（IAM 取 token + IoTDA v5 命令 API）---
    iotda_region: str = ""
    iotda_project_id: str = ""
    huawei_cloud_ak: str = ""
    huawei_cloud_sk: str = ""

    @property
    def llm_enabled(self) -> bool:
        """是否启用真实大模型：配置了非空 API Key 才为 True。"""
        return bool(self.maas_api_key.strip())

    @property
    def allow_all_origins(self) -> bool:
        """CORS 是否放开全部来源（此时不能开启 credentials）。"""
        return "*" in self.cors_origins

    @property
    def mqtt_enabled(self) -> bool:
        """设备侧 MQTT 直连是否可用：host / device_id / secret 三者齐备。"""
        return all(
            (
                self.iotda_mqtt_host.strip(),
                self.iotda_device_id.strip(),
                self.iotda_device_secret.strip(),
            )
        )

    @property
    def amqp_enabled(self) -> bool:
        """平台侧 AMQP 订阅是否可用：host / access_key / access_code 三者齐备。"""
        return all(
            (
                self.iotda_amqp_host.strip(),
                self.iotda_amqp_access_key.strip(),
                self.iotda_amqp_access_code.strip(),
            )
        )

    @property
    def iot_enabled(self) -> bool:
        """完整 IoT 链路是否可用（设备上报 + 平台订阅同时就绪）。"""
        return self.mqtt_enabled and self.amqp_enabled

    @property
    def command_enabled(self) -> bool:
        """云端命令下发是否可用：region / project_id / AK / SK 四者齐备。"""
        return all(
            (
                self.iotda_region.strip(),
                self.iotda_project_id.strip(),
                self.huawei_cloud_ak.strip(),
                self.huawei_cloud_sk.strip(),
            )
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """返回全局唯一的配置实例（进程内缓存）。

    测试中若需重新读取环境变量，可调用 ``get_settings.cache_clear()``。
    """
    return Settings(
        maas_api_key=_get_str("MAAS_API_KEY", ""),
        maas_model=_get_str("MAAS_MODEL", DEFAULT_MODEL),
        maas_base_url=_get_str("MAAS_BASE_URL", DEFAULT_BASE_URL),
        app_port=_get_int("APP_PORT", DEFAULT_PORT),
        cors_origins=_get_csv("CORS_ORIGINS", DEFAULT_CORS_ORIGINS),
        # 认证（token 有效期非法 / 越界回退 28800）
        auth_secret=_get_str("AUTH_SECRET", ""),
        auth_ttl_seconds=_get_bounded_int(
            "AUTH_TTL_SECONDS",
            DEFAULT_AUTH_TTL_SECONDS,
            MIN_AUTH_TTL_SECONDS,
            MAX_AUTH_TTL_SECONDS,
        ),
        # IoTDA 设备侧 MQTT
        iotda_mqtt_host=_get_str("IOTDA_MQTT_HOST", ""),
        iotda_mqtt_port=_get_int("IOTDA_MQTT_PORT", DEFAULT_MQTT_PORT),
        iotda_device_id=_get_str("IOTDA_DEVICE_ID", ""),
        iotda_device_secret=_get_str("IOTDA_DEVICE_SECRET", ""),
        # IoTDA 平台侧 AMQP
        iotda_amqp_host=_get_str("IOTDA_AMQP_HOST", ""),
        iotda_amqp_port=_get_int("IOTDA_AMQP_PORT", DEFAULT_AMQP_PORT),
        iotda_amqp_access_key=_get_str("IOTDA_AMQP_ACCESS_KEY", ""),
        iotda_amqp_access_code=_get_str("IOTDA_AMQP_ACCESS_CODE", ""),
        iotda_amqp_queue=_get_str("IOTDA_AMQP_QUEUE", DEFAULT_AMQP_QUEUE),
        iotda_instance_id=_get_str("IOTDA_INSTANCE_ID", ""),
        # 本地 SQLite（相对路径按 BASE_DIR 解析）
        iotdb_path=_get_path("IOTDB_PATH", DEFAULT_IOTDB_PATH),
        # 设备 → 老人映射
        iotda_elder_id=_get_str("IOTDA_ELDER_ID", DEFAULT_ELDER_ID),
        iotda_elder_name=_get_str("IOTDA_ELDER_NAME", DEFAULT_ELDER_NAME),
        # 云端命令下发
        iotda_region=_get_str("IOTDA_REGION", ""),
        iotda_project_id=_get_str("IOTDA_PROJECT_ID", ""),
        huawei_cloud_ak=_get_str("HUAWEI_CLOUD_AK", ""),
        huawei_cloud_sk=_get_str("HUAWEI_CLOUD_SK", ""),
    )