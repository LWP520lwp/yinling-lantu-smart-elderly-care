"""Pydantic v2 数据模型：请求体校验与字段约束。

约束一览：
- ``messages`` 至少 1 条、最多 30 条；
- 单条 ``content`` 长度上限 4000（去除首尾空白后不能为空）；
- ``role`` 仅允许 user / assistant / system；
- ``age`` 取值 0 - 130；
- 其余未知字段一律忽略，保证前端传入 ``id`` / ``member`` 等扩展字段不会 422。

校验失败时由 FastAPI 自动返回 422 与详细错误信息。
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

# 与前端输入框限制保持一致
MAX_CONTENT_LENGTH: int = 4000
MAX_MESSAGES: int = 30
MAX_CHRONIC_ITEMS: int = 20


class ChatMessage(BaseModel):
    """单条对话消息。"""

    model_config = ConfigDict(extra="ignore")

    role: Literal["user", "assistant", "system"] = Field(
        ...,
        description="消息角色，仅允许 user / assistant / system",
    )
    content: str = Field(
        ...,
        description=f"消息内容，最长 {MAX_CONTENT_LENGTH} 个字符",
    )

    @field_validator("role", mode="before")
    @classmethod
    def _normalize_role(cls, value: Any) -> Any:
        """兼容前端可能出现的大小写与前后空格。"""
        if isinstance(value, str):
            return value.strip().lower()
        return value

    @field_validator("content")
    @classmethod
    def _validate_content(cls, value: str) -> str:
        """去除首尾空白；空内容直接判为非法（避免把空提问发给模型）。"""
        text = value.strip()
        if not text:
            raise ValueError("content 不能为空或仅包含空白字符")
        if len(text) > MAX_CONTENT_LENGTH:
            raise ValueError(f"content 长度不能超过 {MAX_CONTENT_LENGTH} 个字符")
        return text


class Vitals(BaseModel):
    """最新一次体征数据；数值为 0 视为“无记录”。"""

    model_config = ConfigDict(extra="ignore")

    hr: int = Field(default=0, ge=0, le=300, description="心率 bpm")
    sbp: int = Field(default=0, ge=0, le=300, description="收缩压 mmHg")
    dbp: int = Field(default=0, ge=0, le=200, description="舒张压 mmHg")
    spo2: int = Field(default=0, ge=0, le=100, description="血氧饱和度 %")
    temp: float = Field(default=0, ge=0, le=50, description="体温 ℃")
    at: Optional[Union[int, float, str]] = Field(
        default=None,
        description="测量时间：毫秒/秒级时间戳或 ISO 字符串，缺省表示未知",
    )


class ElderProfile(BaseModel):
    """老人档案。字段缺失时使用中性默认值，避免因档案不全导致 422。"""

    # populate_by_name=True：同时接受 lastVitals（前端）与 last_vitals（Python 风格）
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    name: str = Field(default="", max_length=40, description="姓名")
    gender: str = Field(default="", max_length=10, description="性别")
    age: int = Field(default=0, ge=0, le=130, description="年龄，0-130")
    village: str = Field(default="", max_length=40, description="村居")
    town: Optional[str] = Field(default=None, max_length=40, description="乡镇（可选）")
    health: str = Field(default="", max_length=20, description="健康等级标识")
    chronic: List[str] = Field(
        default_factory=list,
        max_length=MAX_CHRONIC_ITEMS,
        description="慢病列表",
    )
    last_vitals: Vitals = Field(
        default_factory=Vitals,
        alias="lastVitals",
        description="最新体征",
    )

    @field_validator("name", "gender", "village", "health")
    @classmethod
    def _strip_text(cls, value: str) -> str:
        """统一去除首尾空白，避免 prompt 中出现多余空格。"""
        return value.strip()

    @field_validator("town")
    @classmethod
    def _strip_optional_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        text = value.strip()
        return text or None

    @field_validator("chronic")
    @classmethod
    def _clean_chronic(cls, value: List[str]) -> List[str]:
        """清洗慢病列表：去空白、去空项、去重并保持原顺序。"""
        cleaned: List[str] = []
        for item in value:
            text = str(item).strip()
            if not text or text in cleaned:
                continue
            cleaned.append(text[:40])
        return cleaned


class ChatRequest(BaseModel):
    """``POST /api/chat`` 请求体。"""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    elder: ElderProfile = Field(
        default_factory=ElderProfile,
        description="老人档案；缺省时按空档案处理",
    )
    messages: List[ChatMessage] = Field(
        ...,
        min_length=1,
        max_length=MAX_MESSAGES,
        description=f"对话历史，1-{MAX_MESSAGES} 条",
    )
    stream: bool = Field(
        default=True,
        description="是否流式返回；当前实现始终以 SSE 流式响应",
    )


class DeviceCommand(BaseModel):
    """``POST /api/device/command`` 请求体：向 IoTDA 设备下发云端命令。

    ``paras`` 为命令参数对象，缺省空字典；``service_id`` / ``command_name``
    对应 IoTDA 产品模型中的服务与命令定义。
    """

    model_config = ConfigDict(extra="ignore")

    device_id: str = Field(
        ...,
        min_length=1,
        max_length=64,
        description="目标设备 ID（IoTDA 设备唯一标识）",
    )
    command_name: str = Field(
        default="restart",
        min_length=1,
        max_length=64,
        description="命令名称，缺省 restart",
    )
    service_id: str = Field(
        default="DefaultService",
        min_length=1,
        max_length=64,
        description="命令所属服务 ID，缺省 DefaultService",
    )
    paras: Dict[str, Any] = Field(
        default_factory=dict,
        description="命令参数（JSON 对象），缺省空对象",
    )

    @field_validator("device_id", "command_name", "service_id")
    @classmethod
    def _strip_required(cls, value: str) -> str:
        """去除首尾空白；纯空白视为非法，避免下发到空设备 ID。"""
        text = value.strip()
        if not text:
            raise ValueError("字段不能为空或仅包含空白字符")
        return text