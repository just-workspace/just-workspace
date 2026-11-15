"""오피스 문서 글자 미리보기("미리보기로 열기").

로그인 사용자 /api/files/preview 는 docx·xlsx·pptx 를 {"type": "office", content} 로 준다.
손님 공유 링크 미리보기(can_preview)는 그대로 — 오피스는 여전히 미리보기 대상이 아니다.
"""

import os
import sys
import types
from pathlib import Path

import pytest

if os.name == "nt" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

from app.db.models import User  # noqa: E402
from app.files import ooxml  # noqa: E402
from app.files import preview as pv  # noqa: E402
from app.files import router as fr  # noqa: E402
from app.files import service as fs  # noqa: E402


class Req:
    headers: dict = {}


@pytest.fixture()
def home(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(fr.settings, "storage_root", str(tmp_path))
    monkeypatch.setattr(fs, "STORAGE_ROOT", tmp_path)
    fs._dir_cache.clear()
    h = tmp_path / "users" / "alice"
    h.mkdir(parents=True)
    return h


def _user():
    return User(id="alice", username="alice", email="a@x", password_hash="x", display_name="Alice")


@pytest.mark.asyncio
async def test_xlsx_preview_returns_text(home):
    (home / "예산안.xlsx").write_bytes(ooxml.rows_to_xlsx([["항목", "금액"], ["서버", "120"]]))
    r = await fr.preview_file(request=Req(), path="my/예산안.xlsx", user=_user())
    assert r["type"] == "office" and r["name"] == "예산안.xlsx"
    assert "서버" in r["content"] and "120" in r["content"]


@pytest.mark.asyncio
async def test_docx_preview_keeps_lines(home):
    import docx

    d = docx.Document()
    d.add_paragraph("첫 줄")
    d.add_paragraph("둘째 줄")
    d.save(str(home / "메모.docx"))
    r = await fr.preview_file(request=Req(), path="my/메모.docx", user=_user())
    assert r["type"] == "office"
    assert r["content"].splitlines()[:2] == ["첫 줄", "둘째 줄"]


def test_guest_preview_types_unchanged(tmp_path: Path):
    p = tmp_path / "a.docx"
    p.write_bytes(b"x")
    assert pv.can_preview(p) is None


def test_broken_office_file_gives_empty_text(tmp_path: Path):
    p = tmp_path / "broken.pptx"
    p.write_bytes(b"not a zip")
    assert pv.get_office_text(p) == ""
