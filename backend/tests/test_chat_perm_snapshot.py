"""채팅 권한 — 현재 동작 스냅샷(안전 전환의 1단계).

역할·권한 엔진 도입 전에 "누가 무엇을 할 수 있나"를 채널 종류(공개·비공개·보관·음성·DM) ×
행위자(owner·admin·member·비멤버·전역 관리자) × 동작 전체에 대해 고정한다. 엔진이 그림자/강제 모드로
도입된 이후에도 이 표가 그대로 통과해야 한다(기본 역할 세트 = 현재 동작).

기대값은 tests/chat_perm_matrix.py 의 EXPECTED 표(수기 작성).
"""

import pytest

from tests import chat_perm_matrix as M


@pytest.fixture()
def world(monkeypatch, tmp_path):
    M.silence_side_effects(monkeypatch, str(tmp_path))
    return str(tmp_path)


@pytest.mark.parametrize("action,ch,actor", M.all_cases())
async def test_current_behavior(world, action, ch, actor):
    got = await M.run_case(action, ch, actor, world)
    assert got == M.expected(action, ch, actor), f"{action} @ {ch} by {actor}"


async def test_group_mention_reaches_all_members(world):
    """@everyone(그룹 멘션)은 권한 없이 누구나 사용 가능 — 발신자를 제외한 채널 멤버 전원에게 그룹 멘션 행이 생성된다."""
    from sqlalchemy import select
    from app.chat import router as r
    from app.chat.schemas import MessageCreate
    from app.db.models import ChatMention

    eng, db = await M.open_world(world)
    try:
        msg = await r.send_message("pub", MessageCreate(content="@everyone 공지"), user=M.user_ns("mem"), db=db)
        rows = (await db.execute(
            select(ChatMention.user_id, ChatMention.is_group).where(ChatMention.message_id == msg["id"])
        )).all()
        assert sorted(rows) == [("adm", True), ("gam", True), ("own", True)]
    finally:
        await db.close()
        await eng.dispose()
