"""中文 system prompt 构建。

prompt 由三部分组成：
1. 角色与表达风格（面向乡村 / 海岛养老场景的 AI 健康助手）；
2. 老人档案上下文（姓名、性别、年龄、村居、健康等级、慢病、最新体征）；
3. 安全边界（不做诊断、不指导自行调药、急症立即拨打 120）。

同时要求回答不超过 300 字、不得编造档案中不存在的数据，并在结尾附免责声明。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from .schemas import ElderProfile

# 健康等级中文映射；未命中的原始值原样展示
HEALTH_LEVEL_TEXT = {
    "healthy": "健康",
    "semi": "半自理",
    "disabled": "失能",
}

DISCLAIMER = "以上建议仅供参考，不能替代医生面诊。"
UNKNOWN = "未记录"
UNKNOWN_MEASURED_AT = "最近一次测量"


def _format_measured_at(value: Any) -> str:
    """把测量时间格式化为 ``YYYY-MM-DD HH:MM``。

    支持毫秒 / 秒级时间戳与 ISO 字符串；无法解析时统一写“最近一次测量”。
    """
    if value is None or value == "" or value == 0:
        return UNKNOWN_MEASURED_AT

    moment: Optional[datetime] = None
    try:
        if isinstance(value, (int, float)):
            seconds = float(value)
            # 大于 1e11 视为毫秒时间戳
            if seconds > 1e11:
                seconds /= 1000.0
            moment = datetime.fromtimestamp(seconds)
        elif isinstance(value, str):
            moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (ValueError, OverflowError, OSError):
        return UNKNOWN_MEASURED_AT

    if moment is None:
        return UNKNOWN_MEASURED_AT
    if moment.tzinfo is not None:
        moment = moment.astimezone()
    return moment.strftime("%Y-%m-%d %H:%M")


def _format_vitals(elder: ElderProfile) -> str:
    """拼装最新体征描述；数值为 0 的项标注“未记录”。"""
    vitals = elder.last_vitals
    parts = []

    if vitals.hr > 0:
        parts.append(f"心率 {vitals.hr} bpm")
    else:
        parts.append("心率未记录")

    if vitals.sbp > 0 and vitals.dbp > 0:
        parts.append(f"血压 {vitals.sbp}/{vitals.dbp} mmHg")
    elif vitals.sbp > 0:
        parts.append(f"收缩压 {vitals.sbp} mmHg（舒张压未记录）")
    else:
        parts.append("血压未记录")

    if vitals.spo2 > 0:
        parts.append(f"血氧 {vitals.spo2}%")
    else:
        parts.append("血氧未记录")

    if vitals.temp > 0:
        parts.append(f"体温 {vitals.temp}℃")
    else:
        parts.append("体温未记录")

    measured_at = _format_measured_at(vitals.at)
    return "、".join(parts) + f"（测量时间：{measured_at}）"


def _format_location(elder: ElderProfile) -> str:
    """村居展示：乡镇 · 村居，缺失则回退。"""
    town = (elder.town or "").strip()
    village = (elder.village or "").strip()
    if town and village:
        return f"{town} · {village}"
    return village or town or UNKNOWN


def _format_health(elder: ElderProfile) -> str:
    """健康等级中文映射，未知标识按原值展示。"""
    raw = (elder.health or "").strip()
    if not raw:
        return UNKNOWN
    return HEALTH_LEVEL_TEXT.get(raw, raw)


def build_system_prompt(elder: ElderProfile) -> str:
    """生成完整的中文 system prompt。"""
    name = (elder.name or "").strip() or "该老人"
    gender = (elder.gender or "").strip() or UNKNOWN
    age = f"{elder.age} 岁" if elder.age > 0 else UNKNOWN
    chronic = "、".join(elder.chronic) if elder.chronic else "无记录"

    return f"""你是「银龄岚途」智慧养老平台的 AI 健康助手，面向乡村与海岛（如福建平潭）
养老场景，主要服务村居社工与老人家属。请用通俗易懂的中文回答，避免术语堆砌；
建议要具体、可操作，尽量用 ①②③ 分点说明，必要时提醒家属或社工协助。

【老人档案】
- 姓名：{name}
- 性别：{gender}
- 年龄：{age}
- 村居：{_format_location(elder)}
- 健康等级：{_format_health(elder)}
- 慢病情况：{chronic}
- 最新体征：{_format_vitals(elder)}

【回答要求】
1. 结合上述档案给出个性化建议，只使用档案与用户提问中出现的信息，
   不得编造档案里没有的体征数值、诊断结论或既往病史。
2. 回答控制在 300 字以内，优先给出可以今天就执行的动作。
3. 涉及饮食、运动、作息时，请考虑高龄、失能与慢病特点，给出可落地的强度与频次。

【安全边界】
1. 不做确定性诊断，不替代医生面诊，不对检查结果下结论。
2. 不指导自行停药、换药或调整剂量；所有用药问题一律强调遵医嘱，
   由家属或社工协助联系家庭医生确认。
3. 识别到胸痛、意识障碍、呼吸困难、大出血、突发偏瘫、严重过敏等急症信号时，
   必须立即明确建议拨打 120，并通知村居社工与家属，不要建议在家观察等待。

【收尾】
每次回答末尾自然带一句：“{DISCLAIMER}”
例外：急症场景优先给出急救指引，此时不要再输出上述免责声明。
"""