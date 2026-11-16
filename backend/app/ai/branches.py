"""답변 버전(가지) — 질문을 수정하면 해당 턴의 새 버전이 생성되고, 후속 메시지는 기존 가지에 남는다.

구조: 메시지마다 parent_id(동일 가지의 직전 메시지, 대화 첫 메시지는 대화 id). 동일 부모를 가진 사용자
메시지들이 "같은 질문의 버전들"(◀ 2/3 ▶)이다. 형제 중 inactive 가 아닌 쪽을 따라 내려가면 현재 가지가 된다.
버전을 전환해도 각 메시지의 inactive 는 유지되므로 기존 가지로 복귀하면 이후 대화가 그대로 복원된다.

가지 도입 이전 행(parent_id NULL)은 조회 시 created_at 순서로 단일 가지를 구성한다(backfill — 1회만, 저장).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.models import AIMessage

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _key(m: AIMessage):
    at = m.created_at or _EPOCH
    if at.tzinfo is None:  # SQLite 는 시간대 정보를 보존하지 않는다
        at = at.replace(tzinfo=timezone.utc)
    return (at, m.id)


async def load_rows(db: AsyncSession, conv_id: str) -> list[AIMessage]:
    """대화의 모든 메시지(모든 가지). 가지 도입 이전 행이 있으면 단일 가지로 구성하여 저장한다."""
    rows = list((await db.execute(
        select(AIMessage).where(AIMessage.conversation_id == conv_id).order_by(AIMessage.created_at.asc())
    )).scalars().all())
    rows.sort(key=_key)
    if any(m.parent_id is None for m in rows):
        prev = conv_id
        for m in rows:
            if m.parent_id is None:
                m.parent_id = prev
                prev = m.id
            elif not m.inactive:
                prev = m.id
        await db.commit()
    return rows


def active_path(rows: list[AIMessage], conv_id: str) -> list[AIMessage]:
    """현재 가지 — 대화 루트부터 형제 중 표시 상태(inactive 아님)인 가장 최근 메시지를 따라 내려간다."""
    children: dict[str, list[AIMessage]] = defaultdict(list)
    for m in rows:
        children[m.parent_id or conv_id].append(m)
    path: list[AIMessage] = []
    seen: set[str] = set()
    cur = conv_id
    while True:
        kids = children.get(cur) or []
        if not kids:
            break
        live = [k for k in kids if not k.inactive] or kids
        nxt = max(live, key=_key)
        if nxt.id in seen:  # 순환 방어
            break
        path.append(nxt)
        seen.add(nxt.id)
        cur = nxt.id
    return path


def siblings(rows: list[AIMessage], msg: AIMessage) -> list[AIMessage]:
    """같은 질문의 버전들(동일 부모·동일 역할), 생성 순서."""
    out = [m for m in rows if m.parent_id == msg.parent_id and m.role == msg.role]
    out.sort(key=_key)
    return out


def versions_info(rows: list[AIMessage], msg: AIMessage) -> tuple[list[dict], int]:
    sibs = siblings(rows, msg)
    versions = [{"id": s.id, "created_at": s.created_at.isoformat() if s.created_at else None} for s in sibs]
    idx = next((i for i, s in enumerate(sibs) if s.id == msg.id), 0)
    return versions, idx + 1


def activate(rows: list[AIMessage], chosen: AIMessage) -> None:
    """chosen 을 표시 버전으로 지정 — 형제는 숨김 처리한다(삭제하지 않는다)."""
    for s in siblings(rows, chosen):
        s.inactive = None if s.id == chosen.id else True
