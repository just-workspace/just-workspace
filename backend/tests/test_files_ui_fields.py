"""파일 UI(시안 06-1)가 쓰는 응답 필드 — 공유 링크 목록의 can_edit, 휴지통의 retention_days.

라우터 함수를 직접 부른다(SQLite, 필요한 테이블만). 휴지통은 저장소 루트를 임시 폴더로 돌린다.
"""

import os
import sys
import types
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

if os.name == "nt" and "resource" not in sys.modules:
    # 라우터 → indexer 가 유닉스 전용 `resource` 를 import 한다(test_file_transfer_headers 와 같은 처리).
    sys.modules["resource"] = types.ModuleType("resource")

from app.db.models import Base, ShareLink, ShareLinkEmail, SystemSetting, User  # noqa: E402
from app.files import retention  # noqa: E402
from app.files import router as files_router  # noqa: E402

TABLES = [t.__table__ for t in (User, ShareLink, ShareLinkEmail, SystemSetting)]


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        session.add(User(id="alice", username="alice", email="alice@x", password_hash="x"))
        await session.commit()
        yield session
    await engine.dispose()


async def _alice(db) -> User:
    return await db.get(User, "alice")


@pytest.mark.asyncio
async def test_share_list_reports_can_edit(db):
    db.add(ShareLink(token="t-view", file_path="my/a.pdf", display_name="a.pdf", created_by="alice"))
    db.add(ShareLink(token="t-edit", file_path="my/b.docx", display_name="b.docx", created_by="alice",
                     can_edit=True))
    await db.commit()

    rows = await files_router.list_share_links(user=await _alice(db), db=db)
    by_token = {r.token: r for r in rows}
    assert by_token["t-view"].can_edit is False
    assert by_token["t-edit"].can_edit is True
    # 기존 필드는 그대로
    assert by_token["t-edit"].display_name == "b.docx" and by_token["t-edit"].download_count == 0


@pytest.mark.asyncio
async def test_trash_reports_retention_days(db, tmp_path: Path, monkeypatch):
    monkeypatch.setattr(files_router.settings, "storage_root", str(tmp_path))
    user = await _alice(db)

    # 설정 없음 → 기본값
    res = await files_router.list_trash(user=user, db=db)
    assert res.retention_days == retention.DEFAULT_TRASH_DAYS
    assert res.items == []

    # 관리자가 바꾼 값
    db.add(SystemSetting(key=retention.KEY_TRASH_DAYS, value="7"))
    await db.commit()
    res = await files_router.list_trash(user=user, db=db)
    assert res.retention_days == 7

    # 0 = 자동 삭제 안 함, 잘못된 값 → 기본값
    s = await db.get(SystemSetting, retention.KEY_TRASH_DAYS)
    s.value = "0"
    await db.commit()
    assert (await files_router.list_trash(user=user, db=db)).retention_days == 0
    s.value = "abc"
    await db.commit()
    assert (await files_router.list_trash(user=user, db=db)).retention_days == retention.DEFAULT_TRASH_DAYS


@pytest.mark.asyncio
async def test_trash_items_unchanged(db, tmp_path: Path, monkeypatch):
    """필드 추가가 기존 항목 응답(이름·원래 경로)을 바꾸지 않는다."""
    import json
    monkeypatch.setattr(files_router.settings, "storage_root", str(tmp_path))
    trash = tmp_path / "users" / "alice" / ".trash"
    trash.mkdir(parents=True)
    (trash / "20261015000000_memo.txt").write_text("hi", encoding="utf-8")
    (tmp_path / "users" / "alice" / ".trash_meta.json").write_text(json.dumps({
        "20261015000000_memo.txt": {"original_path": "my/docs/memo.txt", "trashed_at": "2026-10-15T00:00:00+00:00"},
    }), encoding="utf-8")

    res = await files_router.list_trash(user=await _alice(db), db=db)
    assert len(res.items) == 1
    it = res.items[0]
    assert it.name == "memo.txt" and it.original_path == "my/docs/memo.txt" and it.size == 2
