"""AI 상태 — 모델 피커용 workspace_model · 도구 목록(tools) 필드."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.ai import config as ai_config
from app.ai.router import ai_status
from app.db.models import Base, SystemSetting, User

TOOLS = {"mail_search": object(), "files_read": object(), "web_search": object(), "tasks_list": object()}


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[User.__table__, SystemSetting.__table__]))
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        s.add(User(id="alice", username="alice", email="alice@x", password_hash="x"))
        await s.commit()
        yield s
    await engine.dispose()


def test_tools_for_user_filters(monkeypatch):
    monkeypatch.setattr(ai_config, "WORKSPACE_TOOLS", TOOLS)
    gov = {"allowed_tools": [], "external_allow_data": False}
    # 내부 제공자: 전체
    assert ai_config.tools_for_user(gov, external=False) == sorted(TOOLS)
    # 외부 + 데이터 접근 차단: 개인데이터 도구 제외. tasks_list(개인 할일)도 개인데이터다 —
    # 예전 고정 목록이 빠뜨려 외부로 새던 것을 fail-closed 판정으로 막았다(S0).
    assert ai_config.tools_for_user(gov, external=True) == ["web_search"]
    # 외부 + 데이터 허용: 동의 대기여도 목록엔 남는다
    assert ai_config.tools_for_user({**gov, "external_allow_data": True}, external=True) == sorted(TOOLS)
    # 허용목록
    assert ai_config.tools_for_user({**gov, "allowed_tools": ["web_search", "nope"]}, external=False) == ["web_search"]


@pytest.mark.asyncio
async def test_status_has_workspace_model_and_tools(db, monkeypatch):
    monkeypatch.setattr(ai_config, "WORKSPACE_TOOLS", TOOLS)
    await ai_config.set_ai_config(db, kind="compatible", base_url="http://127.0.0.1:9", model="model-a")
    user = await db.get(User, "alice")
    res = await ai_status(user=user, db=db)
    assert res["configured"] is True
    assert res["workspace_model"] == "model-a"
    assert res["model"] == "model-a"
    assert res["tools"] == sorted(TOOLS)


@pytest.mark.asyncio
async def test_status_unconfigured(db, monkeypatch):
    monkeypatch.setattr(ai_config, "WORKSPACE_TOOLS", TOOLS)
    res = await ai_status(user=await db.get(User, "alice"), db=db)
    assert res["configured"] is False
    assert res["workspace_model"] == ""
    assert isinstance(res["tools"], list)


@pytest.mark.asyncio
async def test_conversation_previews_last_message():
    from datetime import datetime, timedelta, timezone

    from app.ai.models import AIConversation, AIMessage
    from app.ai.router import PREVIEW_LEN, _conv_previews

    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(
            c, tables=[AIConversation.__table__, AIMessage.__table__]))
    t0 = datetime(2026, 10, 1, tzinfo=timezone.utc)
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        s.add_all([
            AIConversation(id="c1", user_id="alice", title="a"),
            AIConversation(id="c2", user_id="alice", title="b"),
            AIConversation(id="c3", user_id="bob", title="c"),
        ])
        s.add_all([
            AIMessage(conversation_id="c1", user_id="alice", role="user", content="질문", created_at=t0),
            AIMessage(conversation_id="c1", user_id="alice", role="assistant",
                      content="답변\n둘째 줄  " + "가" * 200, created_at=t0 + timedelta(seconds=5)),
            AIMessage(conversation_id="c3", user_id="bob", role="user", content="남의 대화", created_at=t0),
        ])
        await s.commit()
        res = await _conv_previews(s, "alice")
    await engine.dispose()
    assert set(res) == {"c1"}                       # 메시지 없는 c2·남의 c3 는 없음
    assert res["c1"].startswith("답변 둘째 줄 가")    # 마지막 메시지 · 줄바꿈 접기
    assert len(res["c1"]) == PREVIEW_LEN
