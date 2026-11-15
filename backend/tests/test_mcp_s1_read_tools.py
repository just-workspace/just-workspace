"""MCP S1 — 문서 구조 해석·페이지 넘김·새 읽기 도구."""

import contextlib
import io
import struct
import zipfile
from types import SimpleNamespace

import pytest

from app.mcp import docread
from app.mcp.tools import _common, context_tool, files_tool, mail_tool, notes_tool


# ── 공통 페이지 정보 ──────────────────────────────────────────
def test_page_meta_has_more_and_cursor():
    m = _common.page_meta(24, 0, 16)
    assert m == {"total": 24, "returned": 16, "has_more": True, "next_cursor": "16"}
    m2 = _common.page_meta(24, 16, 8)
    assert m2["has_more"] is False and m2["next_cursor"] is None


@pytest.mark.parametrize("raw,expect", [("", 0), (None, 0), ("16", 16), ("-3", 0), ("x", 0)])
def test_parse_cursor(raw, expect):
    assert _common.parse_cursor(raw) == expect


# ── 문서 해석 ────────────────────────────────────────────────
def _docx_bytes() -> bytes:
    import docx

    d = docx.Document()
    d.add_heading("작업 계획", level=1)
    d.add_paragraph("방화벽 교체 절차")
    t = d.add_table(rows=2, cols=2)
    t.cell(0, 0).text, t.cell(0, 1).text = "장비", "IP"
    t.cell(1, 0).text, t.cell(1, 1).text = "FW-01", "10.0.0.1"
    d.add_paragraph("끝")
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def test_docx_keeps_heading_table_and_order():
    md, meta = docread.read_docx(_docx_bytes())
    assert md.startswith("# 작업 계획")
    assert "| 장비 | IP |" in md and "| FW-01 | 10.0.0.1 |" in md
    # 표가 문단 사이 제 자리에 온다
    assert md.index("방화벽 교체 절차") < md.index("| 장비") < md.index("끝")
    assert meta["tables"] == 1


def test_xlsx_one_table_per_sheet():
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "장비"
    ws.append(["이름", "IP"])
    ws.append(["FW-01", "10.0.0.1"])
    ws2 = wb.create_sheet("일정")
    ws2.append(["날짜", "작업"])
    buf = io.BytesIO()
    wb.save(buf)
    md, meta = docread.read_xlsx(buf.getvalue())
    assert "## 시트: 장비" in md and "## 시트: 일정" in md
    assert "| FW-01 | 10.0.0.1 |" in md
    assert [s["name"] for s in meta["sheets"]] == ["장비", "일정"]


def test_hwpx_paragraphs_and_table():
    ns = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
    section = f"""<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" {ns}>
  <hp:p><hp:run><hp:t>첫 문단</hp:t></hp:run></hp:p>
  <hp:p><hp:run><hp:tbl>
    <hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>가</hp:t></hp:run></hp:p></hp:subList></hp:tc>
           <hp:tc><hp:subList><hp:p><hp:run><hp:t>나</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr>
  </hp:tbl></hp:run></hp:p>
  <hp:p><hp:run><hp:t>둘째 문단</hp:t></hp:run></hp:p>
</hs:sec>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/hwp+zip")
        z.writestr("Contents/section0.xml", section)
    md, meta = docread.read_hwpx(buf.getvalue())
    assert md.split("\n\n")[0] == "첫 문단"
    assert "| 가 | 나 |" in md
    assert "둘째 문단" in md
    # 표 칸 글자가 본문 문단으로 또 나오지 않는다
    assert md.count("가") == 1
    assert meta["tables"] == 1


def _hwp_record(tag: int, payload: bytes) -> bytes:
    return struct.pack("<I", tag | (len(payload) << 20)) + payload


def test_hwp_para_text_skips_controls():
    # "안" + 확장 제어(code 11, 8 WCHAR) + "녕" + 문단 끝(13)
    txt = "안".encode("utf-16-le") + struct.pack("<H", 11) + b"\x00" * 14 + "녕".encode("utf-16-le") + struct.pack("<H", 13)
    assert docread._hwp_para_text(txt) == "안녕"


def test_hwp_records_parse():
    body = _hwp_record(66, b"\x00" * 4) + _hwp_record(docread._HWPTAG_PARA_TEXT, "본문".encode("utf-16-le"))
    recs = list(docread._hwp_records(body))
    assert recs[1] == (67, "본문".encode("utf-16-le"))


def test_hwp_rejects_non_ole():
    with pytest.raises(docread.DocReadError):
        docread.read_hwp(b"not an ole file")


def test_scanned_pdf_note():
    from pypdf import PdfWriter

    w = PdfWriter()
    w.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    w.write(buf)
    md, meta = docread.read_pdf(buf.getvalue())
    assert meta["pages"] == 1 and "note" in meta


# ── files_read / files_stat ───────────────────────────────────
@pytest.fixture()
def storage(tmp_path, monkeypatch):
    def resolve(vp, user):
        return tmp_path / vp.split("/", 1)[-1]

    monkeypatch.setattr(files_tool.fs, "resolve_path", resolve)
    return tmp_path


USER = SimpleNamespace(id="u1", username="alice", is_admin=False, display_name="앨리스",
                       email="a@x", timezone="Asia/Seoul")


async def test_files_read_docx_structured_with_hash(storage):
    data = _docx_bytes()
    (storage / "plan.docx").write_bytes(data)
    r = await files_tool.files_read(USER, "my/plan.docx")
    assert r["content"].startswith("# 작업 계획")
    assert r["document"]["format"] == "docx"
    import hashlib
    assert r["sha256"] == hashlib.sha256(data).hexdigest()


async def test_files_read_window_and_next_offset(storage):
    (storage / "a.txt").write_text("x" * 100, encoding="utf-8")
    r = await files_tool.files_read(USER, "my/a.txt", max_bytes=40)
    assert r["truncated"] is True and r["next_offset"] == 40
    r2 = await files_tool.files_read(USER, "my/a.txt", max_bytes=40, offset=80)
    assert r2["returned_chars"] == 20 and r2["next_offset"] is None


async def test_files_read_binary_unsupported(storage):
    (storage / "b.bin").write_bytes(bytes(range(256)) * 20)
    r = await files_tool.files_read(USER, "my/b.bin")
    assert r["error_code"] == "unsupported"


async def test_files_read_missing(storage):
    r = await files_tool.files_read(USER, "my/nope.txt")
    assert r["error_code"] == "not_found"


async def test_files_stat_identical_groups(storage):
    (storage / "a.txt").write_text("same", encoding="utf-8")
    (storage / "b.txt").write_text("same", encoding="utf-8")
    (storage / "c.txt").write_text("diff", encoding="utf-8")
    r = await files_tool.files_stat(USER, paths=["my/a.txt", "my/b.txt", "my/c.txt"])
    assert r["identical_groups"] == [["my/a.txt", "my/b.txt"]]


# ── notes_read 권한 ──────────────────────────────────────────
@contextlib.asynccontextmanager
async def _fake_session():
    yield None


async def test_notes_read_hides_page_without_role(monkeypatch):
    from app.wiki import service as ws

    async def get_page(db, pid):
        return {"id": pid, "space_id": "s1", "title": "비밀", "content": "본문", "author": {}}

    async def no_role(db, sid, uid):
        return None

    monkeypatch.setattr(notes_tool, "async_session", _fake_session)
    monkeypatch.setattr(ws, "get_page", get_page)
    monkeypatch.setattr(ws, "get_user_role", no_role)
    r = await notes_tool.notes_read(USER, "p1")
    assert r["error_code"] == "not_found"        # 존재 여부도 흘리지 않는다


async def test_notes_read_returns_body(monkeypatch):
    from app.wiki import service as ws

    async def get_page(db, pid):
        return {"id": pid, "space_id": "s1", "title": "공개", "content": "가" * 300,
                "author": {"display_name": "밥"}, "updated_at": "2026-11-05"}

    async def reader(db, sid, uid):
        return "reader"

    monkeypatch.setattr(notes_tool, "async_session", _fake_session)
    monkeypatch.setattr(ws, "get_page", get_page)
    monkeypatch.setattr(ws, "get_user_role", reader)
    r = await notes_tool.notes_read(USER, "p1", max_chars=200)
    assert r["author"] == "밥" and r["truncated"] is True and r["next_offset"] == 200


# ── workspace_context · mail ─────────────────────────────────
async def test_workspace_context_has_date_and_user(monkeypatch):
    @contextlib.asynccontextmanager
    async def broken():
        raise RuntimeError("no db")
        yield

    monkeypatch.setattr(context_tool, "async_session", broken)
    r = await context_tool.workspace_context(USER)
    assert r["timezone"] == "Asia/Seoul" and r["utc_offset"] == "+0900"
    assert r["user"]["display_name"] == "앨리스" and r["user"]["groups"] == []
    assert len(r["date"]) == 10 and r["weekday"] in "월화수목금토일"


async def test_mail_attachment_id_must_belong_to_message():
    r = await mail_tool.mail_read_attachment(USER, message_id="10", attachment_id="11:2")
    assert r["error_code"] == "invalid_argument"


def test_new_tools_classified():
    from app.mcp import access
    assert not access.is_data_tool("workspace_context")
    for name in ("files_stat", "notes_read", "mail_read_attachment"):
        assert access.is_data_tool(name)
        assert name in access.TOOL_MODULE
