"""업로드·폴더 생성·이름 변경 직후 즉시 색인 — 기존에는 주기 색인(15분) 전까지 검색에 노출되지 않았다."""

import os
import sys
import types

if os.name == "nt" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

import pytest  # noqa: E402
from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

from app.db.models import Base, FileIndex  # noqa: E402
from app.files import indexer  # noqa: E402


@pytest.fixture()
async def db(tmp_path, monkeypatch):
    monkeypatch.setattr(indexer, "STORAGE_ROOT", tmp_path)
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[FileIndex.__table__]))
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        yield s
    await engine.dispose()


async def _rels(db):
    return sorted((await db.execute(select(FileIndex.scope, FileIndex.rel_path, FileIndex.stamp))).all())


async def test_quick_index_add_rename_forget(db, tmp_path):
    home = tmp_path / "users" / "u1"
    (home / "docs").mkdir(parents=True)
    f = home / "docs" / "보고서.txt"
    f.write_text("x")
    await indexer.quick_index(db, add=[f])
    assert await _rels(db) == [("u1", "docs/보고서.txt", "")]     # stamp 비움 → 다음 주기에 본문까지 색인
    # 폴더 이름 변경: 새 경로(하위 포함) 추가, 이전 경로(하위 포함) 제거
    new = home / "papers"
    (home / "docs").rename(new)
    await indexer.quick_index(db, add=[new], forget=[home / "docs"])
    assert [r[1] for r in await _rels(db)] == ["papers", "papers/보고서.txt"]
    # 공유 폴더 · 숨김(.trash) 은 색인 제외
    sh = tmp_path / "shared" / "team"
    sh.mkdir(parents=True)
    await indexer.quick_index(db, add=[sh, home / ".trash"])
    assert ("shared", "team", "") in await _rels(db)
    assert all(not r[1].startswith(".") for r in await _rels(db))


def test_scope_of(tmp_path, monkeypatch):
    monkeypatch.setattr(indexer, "STORAGE_ROOT", tmp_path)
    assert indexer.scope_of(tmp_path / "users" / "u1" / "a")[0] == "u1"
    assert indexer.scope_of(tmp_path / "shared" / "a")[0] == "shared"
    assert indexer.scope_of(tmp_path / "other" / "a") is None
