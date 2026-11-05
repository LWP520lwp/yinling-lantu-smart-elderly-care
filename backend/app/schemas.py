"""Pydantic v2 数据模型：请求体校验与字段约束。

约束一览：
- ``messages`` 至少 1 条、最多 30 条；
- 单条 ``content`` 长度上限 4000（去除首尾空白后不能为空）；
- ``role`` 仅允许 user / assistant / system；
- ``age`` 取值 0 - 130；
- 登录模型：``account`` 去首尾空白且 ≤64，``password`` 原样保留且 1-128；
- 审计上报：``action`` 限定在白名单内，``detail`` 序列化后 ≤512 字符且不得
  含口令 / 令牌等敏感词，``actor`` / ``ip`` / ``ts`` 由服务端补齐；
- 其余未知字段一律忽略，保证前端传入 ``id`` / ``member`` 等扩展字段不会 422。

校验失败时由 FastAPI 自动返回 422 与详细错误信息。
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

# 与前端输入框限制保持一致
MAX_CONTENT_LENGTH: int = 4000
MAX_MESSAGES: int = 30
MAX_CHRONIC_ITEMS: int = 20
# 登录字段上限：账号 64、口令 128（只限长度，不对口令做任何清洗）
MAX_ACCOUNT_LENGTH: int = 64
MAX_PASSWORD_LENGTH: int = 128

# 审计动作白名单：只允许真实业务会产生的事件，白名单外的 action 直接 422
AUDIT_ACTIONS: frozenset[str] = frozenset(
    {
        "login",
        "logout",
        "ai_chat",
        "elder_view",
        "elder_export",
        "report_export",
        "alert_handle",
        "alert_false_alarm",
        "device_command",
    }
)
# 审计 detail 序列化后的长度上限；超长说明误传了正文 / 批量明细，直接拒绝
MAX_AUDIT_DETAIL_LENGTH: int = 512
# 审计敏感词（大小写不敏感）：命中说明误传了口令 / 令牌，直接拒绝落库
AUDIT_SENSITIVE_WORDS: tuple[str, ...] = (
    "password",
    "passwd",
    "pwd",
    "token",
    "secret",
    "credential",
    "access_key",
    "secret_key",
    "ak_sk",
)


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


class LoginRequest(BaseModel):
    """``POST /api/auth/login`` 请求体。

    - ``account``：去首尾空白、大小写不敏感，最长 64 字符；
    - ``password``：**原样保留**（不 strip 内部或首尾空格），仅限制 1-128 字符，
      避免把用户真实口令里的空格清掉导致校验失败；
    - ``role``：前端选择的角色，可选；传了就必须与账号实际角色一致。
    """

    model_config = ConfigDict(extra="ignore")

    account: str = Field(
        ...,
        max_length=MAX_ACCOUNT_LENGTH,
        description=f"登录账号，最长 {MAX_ACCOUNT_LENGTH} 个字符",
    )
    password: str = Field(
        ...,
        min_length=1,
        max_length=MAX_PASSWORD_LENGTH,
        description=f"登录口令，1-{MAX_PASSWORD_LENGTH} 个字符，原样参与校验",
    )
    role: Optional[str] = Field(
        default=None,
        max_length=16,
        description="期望登录的角色（admin / social / family），缺省表示不校验",
    )

    @field_validator("account", mode="before")
    @classmethod
    def _normalize_account(cls, value: Any) -> Any:
        """去除首尾空白；纯空白直接判为非法。"""
        if isinstance(value, str):
            text = value.strip()
            if not text:
                raise ValueError("account 不能为空或仅包含空白字符")
            return text
        return value

    @field_validator("role", mode="before")
    @classmethod
    def _normalize_role(cls, value: Any) -> Any:
        """兼容前端可能传入的空串 / 大小写 / 前后空格。"""
        if value is None:
            return None
        if isinstance(value, str):
            text = value.strip().lower()
            return text or None
        return value


class AuditCreate(BaseModel):
    """``POST /api/audit`` 请求体：前端上报的业务操作审计。

    ``action`` 仅允许 :data:`AUDIT_ACTIONS` 白名单内的动作；``actor_id`` /
    ``actor_name`` / ``role`` / ``ip`` / ``ts`` 由服务端依据 token 与请求补齐，
    请求体中即使出现也会被 ``extra="ignore"`` 丢弃。``detail`` 为 dict / list 时
    原样交给存储层序列化为 JSON，序列化后 ≤512 字符且不得含口令 / 令牌等敏感词。
    """

    model_config = ConfigDict(extra="ignore")

    action: str = Field(
        ...,
        min_length=1,
        max_length=64,
        description="操作标识，必须在白名单内，如 login / elder_view",
    )
    target_type: Optional[str] = Field(
        default=None,
        max_length=32,
        description="操作对象类型，如 elder / report / device",
    )
    target_id: Optional[str] = Field(
        default=None,
        max_length=64,
        description="操作对象 ID",
    )
    result: Optional[str] = Field(
        default=None,
        max_length=16,
        description="结果标识，如 ok / failed / disabled",
    )
    detail: Optional[Union[Dict[str, Any], List[Any], str]] = Field(
        default=None,
        description=f"补充业务字段；序列化后不得超过 {MAX_AUDIT_DETAIL_LENGTH} 个字符",
    )

    @field_validator("action", mode="before")
    @classmethod
    def _strip_action(cls, value: Any) -> Any:
        """去除首尾空白；纯空白由 ``min_length`` 判定为非法。"""
        if isinstance(value, str):
            return value.strip()
        return value

    @field_validator("action")
    @classmethod
    def _validate_action(cls, value: str) -> str:
        """白名单校验：只接受真实业务产生的操作，避免伪造审计记录。"""
        if value not in AUDIT_ACTIONS:
            raise ValueError(f"不支持的审计动作：{value}")
        return value

    @field_validator("detail")
    @classmethod
    def _validate_detail(cls, value: Any) -> Any:
        """序列化后限制长度并拦截敏感词，避免把口令 / 令牌写进审计。"""
        if value is None:
            return None
        if isinstance(value, (dict, list)):
            text = json.dumps(value, ensure_ascii=False, default=str)
        else:
            text = str(value)
        if len(text) > MAX_AUDIT_DETAIL_LENGTH:
            raise ValueError(
                f"detail 序列化后不能超过 {MAX_AUDIT_DETAIL_LENGTH} 个字符"
            )
        lowered = text.lower()
        for word in AUDIT_SENSITIVE_WORDS:
            if word in lowered:
                raise ValueError(f"detail 不能包含敏感字段：{word}")
        return value


class UserOut(BaseModel):
    """对外暴露的用户信息。

    ``scope`` 为数据范围：管理员为"全域"，社工为其所属村居，家属为老人 ID。
    **不包含**密码哈希等敏感字段。
    """

    model_config = ConfigDict(extra="ignore")

    id: str = Field(..., description="用户 ID，例如 U001")
    name: str = Field(..., description="姓名")
    account: str = Field(..., description="登录账号")
    role: str = Field(..., description="角色：admin / social / family")
    scope: str = Field(..., description="数据范围：全域 / 村居名 / 老人 ID")


class LoginResponse(BaseModel):
    """``POST /api/auth/login`` 成功响应。"""

    model_config = ConfigDict(extra="ignore")

    token: str = Field(..., description="访问口令，后续请求放在 Authorization: Bearer <token>")
    expires_at: int = Field(..., description="token 过期时间，秒级 UTC 时间戳")
    user: UserOut = Field(..., description="登录用户信息")