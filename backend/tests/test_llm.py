"""本地关键词问答模板与流式切块的单元测试。"""

from __future__ import annotations

import asyncio
import types

import pytest

from app import llm
from app.prompts import DISCLAIMER
from app.schemas import ChatMessage, ElderProfile, Vitals


@pytest.fixture
def elder() -> ElderProfile:
    return ElderProfile(
        name="张桂芳",
        age=78,
        town="流水镇",
        village="北港村",
        chronic=["高血压"],
        lastVitals=Vitals(hr=72, sbp=135),
    )


def test_emergency_answer_skips_disclaimer(elder: ElderProfile) -> None:
    """急症优先给 120 指引，且不追加免责声明。"""
    answer = llm.local_answer("老人突然胸痛、喘不上气", elder)
    assert "120" in answer
    assert DISCLAIMER not in answer


def test_bp_branch(elder: ElderProfile) -> None:
    assert "血压" in llm.local_answer("血压有点高怎么办", elder)


def test_heart_branch(elder: ElderProfile) -> None:
    assert "心率" in llm.local_answer("心率偏快正常吗", elder)


def test_sugar_branch_priority(elder: ElderProfile) -> None:
    """「血糖高吃什么」同时含吃字，应先命中血糖分支。"""
    assert "血糖" in llm.local_answer("血糖高吃什么", elder)


def test_non_emergency_branches_have_disclaimer(elder: ElderProfile) -> None:
    """血压、睡眠等非急症回答末尾带免责声明。"""
    assert DISCLAIMER in llm.local_answer("血压高", elder)
    assert DISCLAIMER in llm.local_answer("晚上睡不好", elder)


def test_default_answer_has_disclaimer(elder: ElderProfile) -> None:
    """兜底回答同样带免责声明。"""
    assert DISCLAIMER in llm.local_answer("随便问问情况", elder)


def test_stream_local_reassembles_full_text(elder: ElderProfile) -> None:
    """无 API Key 时流式切块拼接结果与 local_answer 完全一致，且以 done 收尾。"""
    messages = [ChatMessage(role="user", content="血压高怎么办")]
    fake_settings = types.SimpleNamespace(llm_enabled=False)

    async def collect() -> list[dict]:
        return [event async for event in llm.stream_chat(fake_settings, elder, messages)]

    events = asyncio.run(collect())
    assert events[-1]["type"] == "done"
    joined = "".join(event["content"] for event in events if event["type"] == "token")
    assert joined == llm.local_answer("血压高怎么办", elder)
