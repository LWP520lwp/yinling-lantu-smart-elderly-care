"""大模型流式调用与本地模板降级。

对外只暴露 :func:`stream_chat`，它产出如下字典事件（由 ``main.py`` 序列化为 SSE）：

- ``{"type": "token", "content": "增量文本"}``
- ``{"type": "done"}``
- ``{"type": "error", "message": "错误简述"}``

策略：
1. 配置了 ``MAAS_API_KEY`` → 走华为云 MaaS 的 OpenAI 兼容流式接口；
2. 未配置 Key → 直接使用本地模板（模拟流式输出）；
3. 上游报错 / 超时 / 网络异常，且**尚未输出任何 token** → 记录日志后降级本地模板；
4. 已经输出过 token 再失败 → 只发 error 事件，避免“半截回答接模板”的错乱。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, AsyncIterator, Dict, List, Sequence

import httpx

from .config import Settings
from .prompts import DISCLAIMER, build_system_prompt
from .schemas import ChatMessage, ElderProfile

logger = logging.getLogger(__name__)

# 事件类型别名，便于阅读
StreamEvent = Dict[str, Any]

# 本地模板模拟流式的切块大小（2-6 个字符）与间隔（0.02~0.03 秒）
_CHUNK_SIZES = (3, 5, 2, 6, 4)
_CHUNK_DELAY: float = 0.025

# 急症关键词：命中后优先给出 120 急救指引，不再输出普通科普内容
_EMERGENCY_PATTERN = re.compile(
    r"胸痛|呼吸困难|喘不上气|意识|昏迷|叫不醒|偏瘫|半身不遂|大出血|出血不止|"
    # 单独“过敏”过于宽泛（过敏体质咨询也会误触发 120），仅保留明确的严重表述
    r"严重过敏|全身皮疹|喉咙肿|抽搐|口角歪斜|说话不清|中风"
)

# 健康等级 → 本地模板用语
_LEVEL_DISABLED = "disabled"


def _latest_user_content(messages: Sequence[ChatMessage]) -> str:
    """取最后一条 user 消息作为提问；退化时取最后一条消息。"""
    for message in reversed(messages):
        if message.role == "user":
            return message.content
    if messages:
        return messages[-1].content
    return ""


def _location(elder: ElderProfile) -> str:
    """村居描述：乡镇 · 村居。"""
    town = (elder.town or "").strip()
    village = (elder.village or "").strip()
    if town and village:
        return f"{town} · {village}"
    return village or town or "所在村居"


def _fall_risk_text(elder: ElderProfile) -> str:
    """跌倒风险分级（前端打分逻辑的简化移植，仅用于本地模板措辞）。"""
    if elder.health == _LEVEL_DISABLED or elder.age >= 80:
        return "高风险"
    if elder.age >= 75 or any(item in elder.chronic for item in ("高血压", "2 型糖尿病")):
        return "中风险"
    return "低风险"


def _finalize(text: str) -> str:
    """非急症回答统一在末尾补免责声明（避免重复追加）。"""
    if DISCLAIMER in text:
        return text
    return f"{text}\n\n{DISCLAIMER}"


# ---------------------------------------------------------------------------
# 本地模板：移植 assets/js/pages/ai.js 中 answerFor(q, elder) / adviceFor(elder)
# ---------------------------------------------------------------------------


def _emergency_answer(elder: ElderProfile) -> str:
    """急症统一指引：先拨 120，再联系社工与家属。"""
    return (
        "这可能是急症信号，请立即处理："
        "① 马上拨打 120，说明老人姓名、年龄、地址（"
        f"{_location(elder)}）和主要症状；"
        "② 让老人平卧或半卧，保持呼吸道通畅，不要随意搬动或喂食喂水；"
        "③ 立即通知家属与村居社工，安排人员到路口引导救护车；"
        "④ 准备好老人正在服用的药物清单和医保卡，交给急救人员。"
        "请不要在家观察等待，也不要自行加服药物。"
    )


def _chest_answer() -> str:
    """胸闷：先排除心脏急症，再给就医建议。"""
    return (
        "胸闷可能来自心脏、肺部或胃部，需要重视。建议："
        "① 立即停止活动，坐下休息，开窗通风；"
        "② 若同时出现胸痛、出汗、恶心、呼吸困难或疼痛向左肩放射，请立即拨打 120；"
        "③ 记录发作时间、持续时长与诱因，尽快到心内科做心电图、心肌酶检查；"
        "④ 不要自行服用他人的硝酸甘油等急救药物。"
    )


def _bp_answer(elder: ElderProfile) -> str:
    """血压 / 高血压（对应 ai.js 的 /血压/ 分支）。"""
    name = elder.name or "老人"
    if elder.last_vitals.sbp > 0:
        bp_text = f"收缩压均值约 {elder.last_vitals.sbp} mmHg，波动幅度需重点关注"
    else:
        bp_text = "血压暂无记录，需要先补测"
    return (
        f"结合{name}近 30 天数据，{bp_text}。建议："
        "① 每日固定时间测量并记录，测量前静坐 5 分钟；"
        "② 严格控盐，每日不超过 5g，少食咸鱼、腌菜；"
        "③ 降压药需按时服用，不可自行停药或加量；"
        "④ 若出现头晕、胸闷或血压持续高于 160/100 mmHg，"
        "请尽快到就近医院心内科就诊。"
    )


def _heart_answer(elder: ElderProfile) -> str:
    """心率 / 心脏（新增规则，风格与 answerFor 一致）。"""
    if elder.last_vitals.hr > 0:
        hr_text = f"最新心率为 {elder.last_vitals.hr} bpm"
    else:
        hr_text = "心率暂无记录"
    return (
        f"{hr_text}。建议："
        "① 每天早晨起床前静坐测量 1 次并记录；"
        "② 若静息心率持续高于 100 次/分或低于 50 次/分，"
        "或伴心悸、乏力、晕厥，请及时到心内科做心电图；"
        "③ 少饮浓茶咖啡，避免情绪激动与突然用力；"
        "④ 医生开具的控制心率药物需遵医嘱服用，不要自行调整剂量。"
    )


def _sleep_answer() -> str:
    """睡眠 / 失眠（对应 ai.js 的 /睡|失眠/ 分支）。"""
    return (
        "高龄老人睡眠浅较为常见。建议："
        "① 固定作息，午睡不超过 30 分钟；"
        "② 睡前 1 小时避免饮茶与使用手机；"
        "③ 卧室保持安静、温度 24℃ 左右，夜间留一盏小夜灯防跌倒；"
        "④ 若持续两周以上入睡困难或伴随情绪低落，"
        "建议由家属陪同至老年科评估，不建议自行服用安眠药。"
    )


def _diet_answer(elder: ElderProfile) -> str:
    """饮食（对应 ai.js 的 /饮食|吃/ 分支）。"""
    name = elder.name or "老人"
    chronic = "、".join(elder.chronic) if elder.chronic else "一般老年营养需求"
    return (
        f"针对{name}的情况（{chronic}），建议："
        "① 每日食盐 <5g，烹调油 <25g；"
        "② 早餐保证 1 个鸡蛋或一杯牛奶，午餐晚餐各一两鱼禽瘦肉；"
        "③ 主食粗细搭配，多吃深色蔬菜与豆制品；"
        "④ 少量多餐，食物切碎煮软，方便咀嚼吞咽。"
    )


def _fall_answer(elder: ElderProfile) -> str:
    """跌倒（对应 ai.js 的 /跌倒|摔|走路/ 分支）。"""
    return (
        f"跌倒风险评估为{_fall_risk_text(elder)}。建议："
        "① 居室去除门槛与杂物，卫生间加装扶手、防滑垫；"
        "② 起身遵循「躺 30 秒、坐 30 秒、站 30 秒」；"
        "③ 每日做 2 组平衡训练，家属在旁保护；"
        "④ 确保手环电量充足并佩戴，跌倒后 30 秒未取消将自动通知家属与村居社工。"
    )


def _sugar_answer() -> str:
    """血糖 / 糖尿病（对应 ai.js 的 /血糖|糖尿/ 分支）。"""
    return (
        "建议每周监测 2 - 3 次空腹血糖，控制在 7.0 mmol/L 左右"
        "（高龄老人可适当放宽）。主食定量、粗细搭配，"
        "避免稀饭、含糖饮料与糕点；餐后散步 20 分钟有助于控制血糖。"
        "若出现明显口渴、多尿、体重下降，请及时到内分泌科就诊。"
    )


def _exercise_answer(elder: ElderProfile) -> str:
    """运动 / 锻炼（移植 adviceFor 中的活动与平衡训练建议）。"""
    if elder.health == _LEVEL_DISABLED:
        return (
            "以床上或座椅上的关节活动为主，家属协助每日 2 次、每次 10 分钟被动活动。建议："
            "① 动作缓慢，出现疼痛立即停止；"
            "② 每坐 1 小时起身或变换体位；"
            "③ 活动时家属在旁看护，避免坠床；"
            "④ 天气好时推轮椅到户外晒太阳 20 分钟。"
        )
    age = elder.age if elder.age > 0 else 70
    max_hr = max(90, 170 - age)
    return (
        "建议："
        "① 每日清晨或傍晚快走 20 - 30 分钟，配合八段锦，"
        f"心率控制在 {max_hr} 次/分以内；"
        "② 运动前热身 5 分钟，运动后慢走放松；"
        "③ 每周 2 次平衡训练（单脚站立、脚跟脚尖行走），家属在旁保护；"
        "④ 出现胸闷、头晕、气促时立即停下休息，不要硬撑。"
    )


def _medication_answer() -> str:
    """用药 / 吃药（移植 adviceFor 中的规律服药建议）。"""
    return (
        "用药安全提醒："
        "① 按医嘱规律服药，家属可使用手环用药提醒功能，避免漏服、重复服药；"
        "② 不自行停药、换药或调整剂量，有疑问先联系家庭医生；"
        "③ 药物按周分装到分药盒，放在固定、避光、儿童拿不到的位置；"
        "④ 出现皮疹、黑便、明显头晕等不适，及时停药并就医。"
    )


def _mood_answer() -> str:
    """情绪 / 孤独（新增规则）。"""
    return (
        "高龄独居老人情绪低落较为常见，需要家人与社工共同关注。建议："
        "① 每天与家人、邻居聊天 10 分钟以上，可用手环视频通话；"
        "② 参加村居幸福院的集体活动，保持与同龄人的来往；"
        "③ 白天户外光照 30 分钟，作息规律，减少长时间卧床；"
        "④ 若持续两周情绪低落、兴趣减退或出现消极念头，"
        "请家属陪同至老年科或心理门诊评估，并同步告知村居社工。"
    )


def _infection_answer() -> str:
    """咳嗽 / 发热 / 食欲（对应 ai.js 的 /咳嗽|发热|食欲/ 分支）。"""
    return (
        "高龄老人出现咳嗽、食欲下降需警惕肺部感染。建议："
        "① 每日测量体温 2 次并记录；"
        "② 保证饮水量，饮食清淡易消化；"
        "③ 观察是否出现气促、精神萎靡；"
        "④ 若体温超过 38℃ 或症状持续 2 天未缓解，请立即就医，"
        "并同步告知村居社工安排陪诊。"
    )


def _default_answer(elder: ElderProfile) -> str:
    """通用兜底（对应 ai.js 中 answerFor 的默认返回）。"""
    name = elder.name or "老人"
    return (
        f"根据{name}的体征数据与慢病情况，建议先做好三件事："
        "规律测量血压心率并记录、按医嘱服药、保持清淡饮食与适度活动。"
        "若症状持续或加重，请及时联系家庭医生或到就近卫生院就诊，"
        "也可由村居社工协助预约陪诊服务。"
    )


def local_answer(question: str, elder: ElderProfile) -> str:
    """本地关键词问答模板：ai.js ``answerFor`` 的 Python 等价实现。

    优先级：急症 → 胸闷 → 血压 → 心率 → 血糖 → 睡眠 → 饮食 → 跌倒
    → 运动 → 用药 → 情绪 → 咳嗽发热 → 通用兜底。
    """
    q = (question or "").strip()

    # 急症优先：只给急救指引，不追加免责声明
    if _EMERGENCY_PATTERN.search(q):
        return _emergency_answer(elder)

    if re.search(r"胸闷", q):
        return _finalize(_chest_answer())
    if re.search(r"血压", q):
        return _finalize(_bp_answer(elder))
    if re.search(r"心率|心跳|心脏|心慌|心悸", q):
        return _finalize(_heart_answer(elder))
    # 血糖紧随心率：如「血糖高吃什么」同时含 /吃/，必须先于睡眠、饮食判定
    if re.search(r"血糖|糖尿", q):
        return _finalize(_sugar_answer())
    if re.search(r"睡|失眠", q):
        return _finalize(_sleep_answer())
    if re.search(r"饮食|吃|营养", q):
        return _finalize(_diet_answer(elder))
    if re.search(r"跌倒|摔|走路", q):
        return _finalize(_fall_answer(elder))
    if re.search(r"运动|锻炼|活动|散步", q):
        return _finalize(_exercise_answer(elder))
    if re.search(r"用药|吃药|服药|药", q):
        return _finalize(_medication_answer())
    if re.search(r"情绪|孤独|寂寞|心情|抑郁|不开心", q):
        return _finalize(_mood_answer())
    if re.search(r"咳嗽|发热|发烧|食欲|感冒", q):
        return _finalize(_infection_answer())

    return _finalize(_default_answer(elder))


async def _stream_local(question: str, elder: ElderProfile) -> AsyncIterator[StreamEvent]:
    """把本地模板回答切成 2-6 个字符的小块，模拟流式输出。"""
    text = local_answer(question, elder)
    index = 0
    cursor = 0
    while index < len(text):
        size = _CHUNK_SIZES[cursor % len(_CHUNK_SIZES)]
        yield {"type": "token", "content": text[index:index + size]}
        index += size
        cursor += 1
        await asyncio.sleep(_CHUNK_DELAY)
    yield {"type": "done"}


# ---------------------------------------------------------------------------
# 真实模型调用
# ---------------------------------------------------------------------------


def _extract_delta(chunk: Any) -> str:
    """从 OpenAI 兼容分片中取出增量文本，结构异常时返回空串。"""
    if not isinstance(chunk, dict):
        return ""
    choices = chunk.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if not isinstance(delta, dict):
        return ""
    content = delta.get("content")
    return content if isinstance(content, str) else ""


def _build_payload(
    elder: ElderProfile,
    messages: Sequence[ChatMessage],
    model: str,
) -> Dict[str, Any]:
    """组装 OpenAI 兼容请求体：system prompt + 对话历史。"""
    history: List[Dict[str, str]] = [
        {"role": message.role, "content": message.content} for message in messages
    ]
    return {
        "model": model,
        "messages": [{"role": "system", "content": build_system_prompt(elder)}]
        + history,
        "stream": True,
        "temperature": 0.7,
    }


async def _stream_remote(
    settings: Settings,
    elder: ElderProfile,
    messages: Sequence[ChatMessage],
) -> AsyncIterator[StreamEvent]:
    """调用华为云 MaaS 流式接口，逐条产出 token / done 事件。

    异常一律向上抛出，由 :func:`stream_chat` 决定降级还是报错。
    注意：保持默认 SSL 校验，禁止 ``verify=False``。
    """
    payload = _build_payload(elder, messages, settings.maas_model)

    headers = {
        "Authorization": f"Bearer {settings.maas_api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    # connect 超时 10s，整体读写超时 60s，避免长连接把服务挂死
    timeout = httpx.Timeout(60.0, connect=10.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST",
            settings.maas_base_url,
            headers=headers,
            json=payload,
        ) as response:
            if response.status_code >= 400:
                # 读取错误响应体便于排查（截断，避免日志过大）
                body = (await response.aread()).decode("utf-8", errors="replace")
                logger.error(
                    "MaaS 接口返回 %s：%s", response.status_code, body[:300]
                )
                raise httpx.HTTPStatusError(
                    f"上游返回 HTTP {response.status_code}",
                    request=response.request,
                    response=response,
                )

            async for raw_line in response.aiter_lines():
                line = raw_line.strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if not data:
                    continue
                if data == "[DONE]":
                    yield {"type": "done"}
                    return
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    # 心跳或非 JSON 行直接忽略
                    continue
                text = _extract_delta(chunk)
                if text:
                    yield {"type": "token", "content": text}

    # 上游关闭连接但未发送 [DONE]，同样视为正常结束
    yield {"type": "done"}


async def stream_chat(
    settings: Settings,
    elder: ElderProfile,
    messages: Sequence[ChatMessage],
) -> AsyncIterator[StreamEvent]:
    """统一入口：真实模型优先，失败时按是否已输出 token 决定降级策略。"""
    question = _latest_user_content(messages)

    if not settings.llm_enabled:
        logger.info("未配置 MAAS_API_KEY，使用本地模板降级回答")
        async for event in _stream_local(question, elder):
            yield event
        return

    emitted = False
    fallback_needed = False
    try:
        async for event in _stream_remote(settings, elder, messages):
            event_type = event.get("type")
            if event_type == "token":
                emitted = True
                yield event
            elif event_type == "done":
                if emitted:
                    yield {"type": "done"}
                    return
                # 上游没有任何内容：降级，避免前端空白
                logger.warning("上游返回空内容，改用本地模板")
                fallback_needed = True
                break
            elif event_type == "error":
                if emitted:
                    yield event
                    return
                logger.warning("上游错误且未输出内容：%s", event.get("message"))
                fallback_needed = True
                break
    except asyncio.CancelledError:
        # 客户端主动断开，不写 error 事件，交由上层关闭连接
        raise
    except Exception as exc:  # noqa: BLE001 - 需要兜住 httpx 与解析等一切异常
        if emitted:
            logger.exception("流式输出中断，已输出部分内容：%s", exc)
            yield {"type": "error", "message": "模型输出中断，请稍后重试"}
            return
        logger.warning("调用大模型失败，降级本地模板：%s", exc)
        fallback_needed = True

    if fallback_needed or not emitted:
        async for event in _stream_local(question, elder):
            yield event