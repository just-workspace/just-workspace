"""AI 파일 도구 — 웹 읽기(SSRF 방어)·PDF·Office 편집·변환·분석 샌드박스(클라이언트 모킹)·결과 저장 규칙.

저장소 루트는 임시 폴더, DB 는 SQLite(tests.test_settings_security_p8 의 db 픽스처).
변환(ws-docconv)·샌드박스(ws-sandbox) 컨테이너는 여기서 띄우지 않고 클라이언트를 바꿔 끼운다.
"""

import base64
import io
import json
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest

from app.db.models import McpWriteRequest, SystemSetting, User
from app.mcp import access, writes
from app.mcp import server as reg
from app.mcp.filetools import containers, convert_ops, html_text, office_ops, pdf_ops, safe_fetch, store
from app.mcp.server import execute_tool
from app.mcp.tools import code_run_tool, convert_tool, web_fetch_tool
from tests.test_settings_security_p8 import db  # noqa: F401 (픽스처 재사용)

SCOPES = frozenset({"mcp:read", "mcp:write"})

READ_TOOLS = {"web_fetch", "pdf_inspect"}
WRITE_TOOLS = {"pdf_merge", "pdf_split", "pdf_extract_pages", "pdf_rotate", "pdf_delete_pages", "pdf_fill_form",
               "pdf_watermark", "docx_edit", "xlsx_edit", "pptx_edit", "files_convert", "code_run"}


# ══ 픽스처 ════════════════════════════════════════════════════
class _Ctx:
    def __init__(self, db):
        self.db = db

    async def __aenter__(self):
        return self.db

    async def __aexit__(self, *a):
        return False


@pytest.fixture()
async def env(db, tmp_path: Path, monkeypatch):
    @asynccontextmanager
    async def _session():
        yield db

    from app.mcp.tools import files_write_tool

    monkeypatch.setattr(store, "session", _session)
    monkeypatch.setattr(writes, "session", _session)
    monkeypatch.setattr(files_write_tool, "async_session", _session)     # 되돌리기(files_undo_create)

    async def none(*a, **k):
        return None
    monkeypatch.setattr(writes, "recent_untrusted", none)
    monkeypatch.setattr(writes, "emit_count", none)
    monkeypatch.setattr(writes, "_notify_pending", none)
    monkeypatch.setattr(writes, "mark_untrusted_read", none)

    from app.files import activity as act
    from app.files import indexer
    from app.files import router as fr
    from app.files import service as fs

    async def _act_session():
        return _Ctx(db)
    monkeypatch.setattr(act, "_session", _act_session)
    monkeypatch.setattr(fr.settings, "storage_root", str(tmp_path))
    monkeypatch.setattr(fs, "STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(fs, "VERSIONS_ROOT", tmp_path / ".versions")
    monkeypatch.setattr(indexer, "schedule_quick_index", lambda *a, **k: None)
    fs._dir_cache.clear()
    for u in ("alice", "bob"):
        (tmp_path / "users" / u / "docs").mkdir(parents=True)
    (tmp_path / "users" / "bob" / "secret.pdf").write_bytes(blank_pdf(2))
    alice = await db.get(User, "alice")
    bob = await db.get(User, "bob")
    return {"db": db, "root": tmp_path, "alice": alice, "bob": bob,
            "my": tmp_path / "users" / "alice"}


def _mcp():
    return writes.call_context.set(writes.CallContext(source="mcp", client_name="Claude",
                                                      client_kind="claude_app", client_key="k1"))


async def call(name: str, args: dict, user: User) -> dict:
    t = _mcp()
    try:
        return await execute_tool(name, args, user, scopes=SCOPES)
    finally:
        writes.call_context.reset(t)


async def run_ok(env, name, args, user=None) -> dict:
    r = await call(name, args, user or env["alice"])
    assert r["ok"], r
    res = r["result"]
    if name in WRITE_TOOLS:
        assert res["status"] == "executed", res
        return res["result"]
    return res


async def run_fail(env, name, args, user=None) -> dict:
    r = await call(name, args, user or env["alice"])
    if r.get("ok"):
        assert r["result"].get("status") == "failed", r
        return {"error": r["result"]["error"]}
    return r


# ══ 문서 만들기 도우미 ═════════════════════════════════════════
def blank_pdf(n: int, w0: int = 100) -> bytes:
    """쪽마다 폭이 다른(100, 101, …) 빈 PDF — 순서 확인용."""
    from pypdf import PdfWriter

    w = PdfWriter()
    for i in range(n):
        w.add_blank_page(width=w0 + i, height=200)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def widths(data: bytes) -> list[int]:
    from pypdf import PdfReader

    return [int(float(p.mediabox.width)) for p in PdfReader(io.BytesIO(data)).pages]


def text_pdf(text: str) -> bytes:
    content = f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out = bytearray(b"%PDF-1.4\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offs:
        out += b"%010d 00000 n \n" % o
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def form_pdf() -> bytes:
    from pypdf import PdfWriter
    from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject

    w = PdfWriter()
    page = w.add_blank_page(width=300, height=300)
    font = w._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                                           NameObject("/Subtype"): NameObject("/Type1"),
                                           NameObject("/BaseFont"): NameObject("/Helvetica")}))
    refs = []
    for i, name in enumerate(("name", "dept")):
        d = DictionaryObject({
            NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/FT"): NameObject("/Tx"), NameObject("/T"): TextStringObject(name),
            NameObject("/V"): TextStringObject(""), NameObject("/F"): NumberObject(4),
            NameObject("/DA"): TextStringObject("/Helv 10 Tf 0 g"),
            NameObject("/Rect"): ArrayObject([FloatObject(10), FloatObject(10 + 40 * i), FloatObject(200),
                                              FloatObject(30 + 40 * i)]),
            NameObject("/P"): page.indirect_reference,
        })
        refs.append(w._add_object(d))
    page[NameObject("/Annots")] = ArrayObject(refs)
    w._root_object[NameObject("/AcroForm")] = DictionaryObject({
        NameObject("/Fields"): ArrayObject(refs), NameObject("/DA"): TextStringObject("/Helv 0 Tf 0 g"),
        NameObject("/DR"): DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/Helv"): font})}),
    })
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def make_docx() -> bytes:
    import docx

    d = docx.Document()
    d.add_heading("개요", 1)
    p = d.add_paragraph()
    p.add_run("2025년 ")
    p.add_run("매출").bold = True
    p.add_run(" 보고")
    d.add_heading("세부", 2)
    d.add_paragraph("세부 내용")
    d.add_heading("결론", 1)
    d.add_paragraph("끝")
    t = d.add_table(rows=1, cols=1)
    t.cell(0, 0).text = "표 안 2025년"
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def make_xlsx() -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "매출"
    ws.append(["월", "금액"])
    for m, v in (("1월", 10), ("2월", 20), ("3월", 30)):
        ws.append([m, v])
    ws2 = wb.create_sheet("비용")
    ws2.append(["코드", "값"])
    ws2.append(["0012", 5])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def png(color=(255, 0, 0), size=(40, 30)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def put(env, rel: str, data: bytes) -> str:
    p = env["my"] / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return f"my/{rel}"


def read_vp(env, vp: str) -> bytes:
    assert vp.startswith("my/")
    return (env["my"] / vp[3:]).read_bytes()


# ══ 등록·거버넌스 ═════════════════════════════════════════════
def test_tools_registered_with_scope_module_and_policy():
    for name in READ_TOOLS:
        assert reg.WORKSPACE_TOOLS[name].scope == "mcp:read", name
    for name in WRITE_TOOLS:
        t = reg.WORKSPACE_TOOLS[name]
        assert t.scope == "mcp:write" and t.risk == "low", name
    for name in READ_TOOLS | WRITE_TOOLS:
        assert name in access.TOOL_MODULE, name
    assert access.TOOL_MODULE["web_fetch"] is None
    assert not access.is_data_tool("web_fetch")             # web_search 와 같은 정책(개인 데이터 아님)
    assert access.is_data_tool("code_run") and access.is_data_tool("pdf_merge")
    assert reg._UNTRUSTED_SOURCE["web_fetch"] == "external_web"
    assert reg.WORKSPACE_TOOLS["web_fetch"].untrusted_output


def test_web_fetch_follows_web_pref_switch():
    from app.ai import config as ai_config

    assert ai_config.tool_group("web_fetch") == "web"
    assert ai_config.tool_group("web_search") == "web"
    assert not ai_config.tool_enabled_by_prefs("web_fetch", {"web": False})
    assert ai_config.tool_group("pdf_merge") == "files" and ai_config.tool_group("docx_edit") == "files"


def test_overwrite_option_raises_risk():
    t = reg.WORKSPACE_TOOLS["docx_edit"]
    assert writes.tool_risk(t, {"path": "my/a.docx", "operations": []}) == "low"
    assert writes.tool_risk(t, {"path": "my/a.docx", "overwrite": True}) == "high"
    assert writes.tool_risk(t, {"overwrite": "true"}) == "high"
    assert writes.tool_risk(reg.WORKSPACE_TOOLS["pdf_merge"], {"overwrite": True}) == "low"


async def test_code_run_switch_and_mcp_opt_in(env):
    db = env["db"]
    assert await access.tool_accessible(db, env["alice"], "code_run")      # 기본 켬(내장 AI)
    assert not await access.mcp_exposed(db, "code_run")                    # MCP 노출 기본 끔
    assert await access.mcp_exposed(db, "pdf_merge")
    db.add(SystemSetting(key="ai.gov.code_run_mcp", value="true"))
    db.add(SystemSetting(key="ai.gov.code_run_enabled", value="false"))
    await db.commit()
    assert await access.mcp_exposed(db, "code_run")
    assert not await access.tool_accessible(db, env["alice"], "code_run")  # 꺼지면 어디에도 없음


async def test_mcp_listing_hides_code_run_by_default(env, monkeypatch):
    from app.mcp import http_server

    @asynccontextmanager
    async def _session():
        yield env["db"]
    monkeypatch.setattr(http_server, "async_session", _session)

    async def _ok(*a, **k):
        return True
    monkeypatch.setattr(http_server, "tool_accessible", _ok)
    ctx = http_server.McpContext(user=env["alice"], scopes=SCOPES, resource="r", endpoint_scope="mcp:write")
    names = await http_server.allowed_tool_names(ctx)
    assert "pdf_merge" in names and "web_fetch" in names
    assert "code_run" not in names


async def test_governance_settings_round_trip(env):
    from app.ai import config as ai_config

    g = (await ai_config.get_ai_config(env["db"]))["governance"]
    assert g["code_run_enabled"] is True and g["code_run_mcp"] is False
    await ai_config.set_governance(env["db"], code_run_enabled=False, code_run_mcp=True)
    g = (await ai_config.get_ai_config(env["db"]))["governance"]
    assert g["code_run_enabled"] is False and g["code_run_mcp"] is True


# ══ SSRF ═════════════════════════════════════════════════════
@pytest.mark.parametrize("ip", [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.10.50", "169.254.169.254", "100.64.0.1", "100.100.100.200",
    "0.0.0.0", "224.0.0.1", "198.18.0.1", "::1", "fc00::1", "fd00:ec2::254", "fe80::1", "::ffff:127.0.0.1",
    "::ffff:10.0.0.1", "2002:7f00:1::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "::",
])
def test_blocked_addresses(ip):
    assert safe_fetch.blocked_reason(ip), ip


@pytest.mark.parametrize("ip", ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"])
def test_public_addresses_allowed(ip):
    assert safe_fetch.blocked_reason(ip) is None


@pytest.mark.parametrize("url,code", [
    ("ftp://example.com/x", "forbidden"), ("file:///etc/passwd", "forbidden"), ("gopher://example.com", "forbidden"),
    ("http://user:pw@example.com/", "forbidden"), ("http://example.com:22/", "forbidden"),
    ("http://backend:8000/api", "forbidden"), ("http://localhost/", "forbidden"),
    ("http://metadata.google.internal/", "forbidden"), ("http://printer.local/", "forbidden"),
    ("", "invalid_argument"), ("http:///nohost", "invalid_argument"),
])
def test_check_url_rejects(url, code):
    with pytest.raises(safe_fetch.FetchError) as e:
        safe_fetch.check_url(url)
    assert e.value.code == code


DNS = {"public.example": ["93.184.216.34"], "evil.example": ["10.0.0.5"],
       "mixed.example": ["93.184.216.35", "192.168.1.1"], "v6.example": ["2606:4700::1"]}


@pytest.fixture()
def net(monkeypatch):
    """가짜 DNS + 가짜 웹. routes[(ip, path)] = (status, headers, body)."""
    routes: dict = {}
    seen: list = []

    async def lookup(host, port):
        if host not in DNS:
            raise OSError("nx")
        return DNS[host]
    monkeypatch.setattr(safe_fetch, "_lookup", lookup)

    def handler(request: httpx.Request):
        seen.append(request)
        key = (request.url.host, request.url.path)
        if key not in routes:
            return httpx.Response(404, text="nope")
        st, hd, body = routes[key]
        return httpx.Response(st, headers=hd, content=body)
    monkeypatch.setattr(safe_fetch, "_transport", lambda: httpx.MockTransport(handler))
    return {"routes": routes, "seen": seen}


async def test_fetch_pins_ip_keeps_host_and_sni(net):
    net["routes"][("93.184.216.34", "/a")] = (200, {"content-type": "text/plain"}, b"hello")
    r = await safe_fetch.fetch("https://public.example/a", max_bytes=1000)
    assert r.body == b"hello"
    req = net["seen"][0]
    assert req.url.host == "93.184.216.34"                 # 검사한 주소로 직접(재바인딩 차단)
    assert req.headers["host"] == "public.example"
    assert req.extensions.get("sni_hostname") == "public.example"


async def test_fetch_blocks_private_dns_and_mixed_answers(net):
    for url in ("http://evil.example/", "http://mixed.example/"):
        with pytest.raises(safe_fetch.FetchError) as e:
            await safe_fetch.fetch(url, max_bytes=1000)
        assert e.value.code == "forbidden"
    assert net["seen"] == []                               # 요청이 나가지도 않았다


async def test_fetch_rechecks_every_redirect(net):
    net["routes"][("93.184.216.34", "/r1")] = (302, {"location": "http://evil.example/admin"}, b"")
    net["routes"][("93.184.216.34", "/r2")] = (301, {"location": "http://169.254.169.254/latest/meta-data/"}, b"")
    net["routes"][("93.184.216.34", "/r3")] = (307, {"location": "file:///etc/passwd"}, b"")
    for path in ("/r1", "/r2", "/r3"):
        with pytest.raises(safe_fetch.FetchError) as e:
            await safe_fetch.fetch(f"http://public.example{path}", max_bytes=1000)
        assert e.value.code == "forbidden", path
    assert all(s.url.host == "93.184.216.34" for s in net["seen"])


async def test_fetch_redirect_limit_and_relative(net):
    net["routes"][("93.184.216.34", "/loop")] = (302, {"location": "/loop"}, b"")
    with pytest.raises(safe_fetch.FetchError) as e:
        await safe_fetch.fetch("http://public.example/loop", max_bytes=1000)
    assert e.value.code == "unavailable"
    net["routes"][("93.184.216.34", "/old")] = (301, {"location": "/new"}, b"")
    net["routes"][("93.184.216.34", "/new")] = (200, {"content-type": "text/plain"}, b"ok")
    r = await safe_fetch.fetch("http://public.example/old", max_bytes=1000)
    assert r.final_url == "http://public.example/new" and r.body == b"ok"


async def test_fetch_size_caps(net):
    net["routes"][("93.184.216.34", "/big.html")] = (200, {"content-type": "text/html"}, b"<p>" + b"a" * 5000)
    net["routes"][("93.184.216.34", "/big.pdf")] = (200, {"content-type": "application/pdf"}, b"%PDF-" + b"0" * 5000)
    r = await safe_fetch.fetch("http://public.example/big.html", max_bytes=1000)
    assert r.body_truncated and len(r.body) == 1000       # 텍스트류는 잘라서
    with pytest.raises(safe_fetch.FetchError) as e:
        await safe_fetch.fetch("http://public.example/big.pdf", max_bytes=1000)
    assert e.value.code == "too_large"                     # PDF 는 잘린 걸 쓰지 않는다


# ══ web_fetch 도구 ════════════════════════════════════════════
PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>뉴스 제목</title>
<meta name="description" content="요약"><script>alert(1)</script><style>p{}</style></head>
<body><nav><a href="/menu">메뉴</a> 전체 메뉴</nav>
<header>사이트 머리</header>
<article><h1>본문 제목</h1><p>첫 문단 <b>강조</b> 내용입니다. """ + "긴 본문 " * 40 + """</p>
<ul><li>항목 하나</li><li>항목 둘</li></ul>
<table><tr><th>이름</th><th>값</th></tr><tr><td>가</td><td>1</td></tr></table>
<pre>code  block</pre><a href="/page/2">다음 페이지</a></article>
<footer>저작권</footer></body></html>"""


async def test_web_fetch_html_to_text_untrusted(env, net):
    net["routes"][("93.184.216.34", "/news")] = (200, {"content-type": "text/html; charset=utf-8"}, PAGE.encode())
    r = await call("web_fetch", {"url": "https://public.example/news", "include_links": True}, env["alice"])
    assert r["ok"], r
    assert r["result"]["untrusted"] is True and r["result"]["source"] == "external_web"
    d = r["result"]["data"]
    assert d["title"] == "뉴스 제목" and d["kind"] == "html" and d["description"] == "요약"
    c = d["content"]
    assert "# 본문 제목" in c and "- 항목 하나" in c and "| 이름 | 값 |" in c and "```" in c
    assert "alert(1)" not in c and "전체 메뉴" not in c and "저작권" not in c and "사이트 머리" not in c
    assert {"text": "다음 페이지", "url": "https://public.example/page/2"} in d["links"]


async def test_web_fetch_windowing_and_pdf(env, net):
    net["routes"][("93.184.216.34", "/t.txt")] = (200, {"content-type": "text/plain"}, ("가" * 3000).encode())
    r = await call("web_fetch", {"url": "http://public.example/t.txt", "max_chars": 1000}, env["alice"])
    d = r["result"]["data"]
    assert d["returned_chars"] == 1000 and d["truncated"] and d["next_offset"] == 1000
    r = await call("web_fetch", {"url": "http://public.example/t.txt", "max_chars": 1000, "offset": 2500}, env["alice"])
    assert r["result"]["data"]["returned_chars"] == 500 and r["result"]["data"]["next_offset"] is None
    net["routes"][("93.184.216.34", "/doc.pdf")] = (200, {"content-type": "application/pdf"}, text_pdf("Hello PDF"))
    r = await call("web_fetch", {"url": "http://public.example/doc.pdf"}, env["alice"])
    d = r["result"]["data"]
    assert d["kind"] == "pdf" and "Hello PDF" in d["content"]


async def test_web_fetch_errors(env, net):
    r = await call("web_fetch", {"url": "http://evil.example/"}, env["alice"])
    assert r["ok"] is False and r["error_code"] == "forbidden"
    r = await call("web_fetch", {"url": "http://public.example/missing"}, env["alice"])
    assert r["ok"] is False and r["error_code"] == "not_found"
    net["routes"][("93.184.216.34", "/img")] = (200, {"content-type": "image/png"}, png())
    r = await call("web_fetch", {"url": "http://public.example/img"}, env["alice"])
    assert r["ok"] is False and r["error_code"] == "unsupported"


def test_html_decode_cp949_and_meta_charset():
    body = '<html><head><meta charset="euc-kr"><title>한글</title></head><body><p>안녕</p></body></html>'.encode("cp949")
    assert "안녕" in html_text.decode_body(body, None)
    assert html_text.html_to_text(html_text.decode_body(body, None))["title"] == "한글"


# ══ 저장 규칙 ═════════════════════════════════════════════════
async def test_result_saved_to_ai_results_folder_with_file_info(env):
    src = put(env, "docs/a.pdf", blank_pdf(3))
    res = await run_ok(env, "pdf_extract_pages", {"path": src, "pages": "3,1"})
    assert res["path"].startswith("my/AI 결과물/") and "새 대화/" in res["path"]
    assert res["name"] == "a (3,1쪽).pdf" and res["mime"] == "application/pdf"
    assert res["size"] == len(read_vp(env, res["path"]))
    assert widths(read_vp(env, res["path"])) == [102, 100]
    assert res["files"] == [{k: res[k] for k in ("path", "name", "size", "mime")}]
    assert read_vp(env, src) == blank_pdf(3)                 # 원본 보존
    again = await run_ok(env, "pdf_extract_pages", {"path": src, "pages": "3,1"})
    assert again["name"] == "a (3,1쪽) (2).pdf"               # 덮어쓰지 않음


async def test_ai_card_execution_uses_conversation_title(env):
    from app.ai.models import AIConversation

    db = env["db"]
    conv = AIConversation(user_id="alice", title="분기 보고/정리")
    db.add(conv)
    await db.commit()
    src = put(env, "docs/b.pdf", blank_pdf(2))
    tok = writes.call_context.set(writes.CallContext(source="ai", client_name="내장 AI", client_kind="builtin_web",
                                                     client_key=conv.id, conversation_id=conv.id))
    try:
        r = await execute_tool("pdf_rotate", {"path": src, "angle": 90}, env["alice"], scopes=SCOPES)
    finally:
        writes.call_context.reset(tok)
    assert r["result"]["status"] == "pending_confirmation"        # 내장 AI low = 카드 [실행] 대기
    req = await writes.approve(db, env["alice"], r["result"]["request_id"])   # 다른 요청(맥락 없음)에서 승인
    assert req.status == "executed", req.error
    path = json.loads(req.result)["path"]
    assert path.endswith(" 분기 보고 정리/b (회전).pdf")                          # 대화 제목(경로 문자 정리)으로 폴더
    assert req.undo                                             # 되돌리기 가능


async def test_undo_removes_created_result(env):
    src = put(env, "docs/c.pdf", blank_pdf(2))
    r = await call("pdf_rotate", {"path": src, "angle": 180}, env["alice"])
    rid = r["result"]["request_id"]
    path = r["result"]["result"]["path"]
    assert (env["my"] / path[3:]).exists()
    await writes.undo(env["db"], env["alice"], rid)
    assert not (env["my"] / path[3:]).exists()


async def test_dst_folder_and_permissions(env):
    src = put(env, "docs/d.pdf", blank_pdf(2))
    res = await run_ok(env, "pdf_delete_pages", {"path": src, "pages": "1", "dst_folder": "my/out",
                                                 "output_name": "결과"})
    assert res["path"] == "my/out/결과.pdf" and widths(read_vp(env, res["path"])) == [101]
    r = await run_fail(env, "pdf_inspect", {"path": "users/bob/secret.pdf"})     # 남의 파일
    assert r["ok"] is False
    r = await run_fail(env, "pdf_rotate", {"path": src, "dst_folder": "users/bob"})
    assert "error" in r


# ══ PDF ══════════════════════════════════════════════════════
def test_parse_pages_boundaries():
    assert pdf_ops.parse_pages("1-3,5", 6) == [0, 1, 2, 4]
    assert pdf_ops.parse_pages("5-", 6) == [4, 5]
    assert pdf_ops.parse_pages("-2", 6) == [0, 1]
    assert pdf_ops.parse_pages("", 3) == [0, 1, 2]
    assert pdf_ops.parse_pages("last", 3) == [2]
    for bad in ("0", "7", "3-2", "a", "1-9", ","):
        with pytest.raises(pdf_ops.PdfError):
            pdf_ops.parse_pages(bad, 6)


async def test_pdf_merge_split_inspect(env):
    a = put(env, "docs/m1.pdf", blank_pdf(2, 100))
    b = put(env, "docs/m2.pdf", blank_pdf(1, 300))
    res = await run_ok(env, "pdf_merge", {"paths": [b, a]})
    assert widths(read_vp(env, res["path"])) == [300, 100, 101] and res["pages"] == 3
    info = await run_ok(env, "pdf_inspect", {"path": res["path"]})
    assert info["pages"] == 3 and info["page_info"][0]["width_pt"] == 300 and info["form_fields"] == []
    sp = await run_ok(env, "pdf_split", {"path": res["path"], "ranges": ["1", "2-"]})
    assert sp["parts"] == 2 and len(sp["files"]) == 2
    assert sp["folder"].endswith("나누기")                      # 여러 결과는 묶음 폴더(되돌리기 단위)
    assert [widths(read_vp(env, f["path"])) for f in sp["files"]] == [[300], [100, 101]]
    every = await run_ok(env, "pdf_split", {"path": res["path"], "every": 1})
    assert every["parts"] == 3


async def test_pdf_bad_inputs(env):
    one = put(env, "docs/one.pdf", blank_pdf(1))
    r = await run_fail(env, "pdf_merge", {"paths": [one]})
    assert r["ok"] is False and "두 개 이상" in r["error"]
    junk = put(env, "docs/junk.pdf", b"not a pdf at all")
    r = await run_fail(env, "pdf_inspect", {"path": junk})
    assert r["error_code"] == "unsupported"
    txt = put(env, "docs/x.txt", b"hello")
    r = await run_fail(env, "pdf_inspect", {"path": txt})
    assert r["error_code"] == "unsupported"
    r = await run_fail(env, "pdf_delete_pages", {"path": one, "pages": "1"})
    assert "모든 쪽" in r["error"]
    r = await run_fail(env, "pdf_rotate", {"path": one, "angle": 45})
    assert "angle" in r["error"]
    r = await run_fail(env, "pdf_split", {"path": one})
    assert "나눌 수 없습니다" in r["error"]


def test_pdf_encrypted_refused():
    from pypdf import PdfWriter

    w = PdfWriter()
    w.add_blank_page(width=100, height=100)
    w.encrypt(user_password="pw", owner_password="own")
    buf = io.BytesIO()
    w.write(buf)
    with pytest.raises(pdf_ops.PdfError) as e:
        pdf_ops.inspect(buf.getvalue())
    assert "암호" in e.value.message


def test_pdf_split_part_cap(monkeypatch):
    monkeypatch.setattr(pdf_ops, "MAX_SPLIT_PARTS", 3)
    with pytest.raises(pdf_ops.PdfError) as e:
        pdf_ops.split(blank_pdf(5), every=1)
    assert e.value.code == "too_large"


async def test_pdf_form_fill(env):
    src = put(env, "docs/form.pdf", form_pdf())
    info = await run_ok(env, "pdf_inspect", {"path": src})
    assert {f["name"] for f in info["form_fields"]} == {"name", "dept"}
    res = await run_ok(env, "pdf_fill_form", {"path": src, "values": {"name": "홍길동", "nope": "x"}})
    assert res["filled"] == ["name"] and res["unknown_fields"] == ["nope"]
    fields = {f["name"]: f for f in pdf_ops.form_fields(read_vp(env, res["path"]))}
    assert fields["name"]["value"] == "홍길동"
    flat = await run_ok(env, "pdf_fill_form", {"path": src, "values": {"name": "A"}, "flatten": True})
    assert pdf_ops.form_fields(read_vp(env, flat["path"])) == []      # 굳힌 뒤엔 칸이 없다
    r = await run_fail(env, "pdf_fill_form", {"path": src, "values": {"zzz": "1"}})
    assert "폼 칸" in r["error"]


async def test_pdf_watermark_text_and_image(env):
    pytest.importorskip("reportlab")
    src = put(env, "docs/w.pdf", blank_pdf(2))
    res = await run_ok(env, "pdf_watermark", {"path": src, "text": "대외비\nCONFIDENTIAL", "pages": "1"})
    from pypdf import PdfReader

    r = PdfReader(io.BytesIO(read_vp(env, res["path"])))
    assert len(r.pages) == 2
    assert r.pages[0].get_contents() is not None and r.pages[1].get_contents() is None
    logo = put(env, "docs/logo.png", png())
    res = await run_ok(env, "pdf_watermark", {"path": src, "image_path": logo, "position": "bottom-right"})
    assert "/XObject" in str(PdfReader(io.BytesIO(read_vp(env, res["path"]))).pages[0]["/Resources"])
    r2 = await run_fail(env, "pdf_watermark", {"path": src})
    assert "text" in r2["error"]


# ══ Office ═══════════════════════════════════════════════════
async def test_docx_edit_replace_across_runs_and_structure(env):
    import docx

    src = put(env, "docs/r.docx", make_docx())
    res = await run_ok(env, "docx_edit", {"path": src, "operations": [
        {"op": "replace", "find": "2025년 매출", "replace": "2026년 영업이익"},
        {"op": "replace", "find": "2025년", "replace": "2026년"},
        {"op": "append_paragraph", "text": "개요 끝에 붙임", "after_heading": "개요"},
        {"op": "append_table", "rows": [["항목", "값"], ["가", "1"]], "after_heading": "결론"},
        {"op": "add_heading", "text": "부록", "level": 1},
    ]})
    assert res["name"] == "r (수정).docx"
    assert res["operations"][0]["replaced"] == 1 and res["operations"][1]["replaced"] == 1   # 표 안도
    assert [h["text"] for h in res["outline"]] == ["개요", "세부", "결론", "부록"]
    d = docx.Document(io.BytesIO(read_vp(env, res["path"])))
    texts = [p.text for p in d.paragraphs]
    assert "2026년 영업이익 보고" in texts
    assert texts.index("개요 끝에 붙임") < texts.index("결론")      # "개요" 절(세부 포함) 끝, 결론 앞
    assert texts.index("개요 끝에 붙임") > texts.index("세부 내용")
    run = next(p for p in d.paragraphs if p.text.startswith("2026년 영업이익")).runs
    assert run[0].text == "2026년 영업이익" and not run[0].bold   # 첫 런 서식 유지
    assert d.tables[0].cell(0, 0).text == "표 안 2026년"
    assert (env["my"] / "docs/r.docx").read_bytes() != read_vp(env, res["path"])   # 원본은 그대로


async def test_docx_edit_errors_change_nothing(env):
    src = put(env, "docs/e.docx", make_docx())
    before = sorted(p.name for p in env["my"].rglob("*"))
    r = await run_fail(env, "docx_edit", {"path": src, "operations": [
        {"op": "replace", "find": "개요", "replace": "x"}, {"op": "explode"}]})
    assert "모르는 op" in r["error"]
    r = await run_fail(env, "docx_edit", {"path": src, "operations": [
        {"op": "append_paragraph", "text": "x", "after_heading": "없는 제목"}]})
    assert "제목을 찾지 못했습니다" in r["error"]
    assert sorted(p.name for p in env["my"].rglob("*")) == before   # 실패하면 아무것도 저장 안 함
    ole = put(env, "docs/old.docx", bytes.fromhex("d0cf11e0a1b11ae1") + b"\0" * 100)
    r = await run_fail(env, "docx_edit", {"path": ole, "operations": [{"op": "replace", "find": "a", "replace": "b"}]})
    assert "암호" in r["error"] or "옛 형식" in r["error"]
    notzip = put(env, "docs/bad.docx", b"PK-not-really")
    r = await run_fail(env, "docx_edit", {"path": notzip, "operations": [{"op": "replace", "find": "a", "replace": "b"}]})
    assert r.get("error")


async def test_docx_overwrite_needs_approval_and_keeps_version(env):
    src = put(env, "docs/o.docx", make_docx())
    orig = read_vp(env, src)
    r = await call("docx_edit", {"path": src, "overwrite": True,
                                 "operations": [{"op": "replace", "find": "끝", "replace": "END"}]}, env["alice"])
    assert r["ok"] and r["result"]["status"] == "pending_approval" and r["result"]["risk"] == "high"
    assert read_vp(env, src) == orig                                 # 승인 전엔 그대로
    req = await writes.approve(env["db"], env["alice"], r["result"]["approval_id"])
    assert req.status == "executed", req.error
    assert read_vp(env, src) != orig
    from app.files import service as fs

    assert fs.list_versions("alice", "docs/o.docx")                  # 이전본은 버전 기록


async def test_edit_card_cannot_escalate_to_overwrite(env):
    src = put(env, "docs/s.docx", make_docx())
    tok = writes.call_context.set(writes.CallContext(source="ai", client_key="c", conversation_id=None))
    try:
        r = await execute_tool("docx_edit", {"path": src, "operations": [{"op": "replace", "find": "끝", "replace": "x"}]},
                               env["alice"], scopes=SCOPES)
    finally:
        writes.call_context.reset(tok)
    rid = r["result"]["request_id"]
    with pytest.raises(writes.WriteError):
        await writes.update_args(env["db"], env["alice"], rid,
                                 {"path": src, "overwrite": True, "operations": [{"op": "replace", "find": "끝", "replace": "x"}]})


async def test_xlsx_edit_cells_formula_sheet_chart(env):
    from openpyxl import load_workbook

    src = put(env, "docs/s.xlsx", make_xlsx())
    res = await run_ok(env, "xlsx_edit", {"path": src, "operations": [
        {"op": "set_cells", "sheet": "매출", "cells": {"B5": "=SUM(B2:B4)", "A5": "합계"}},
        {"op": "set_range", "sheet": "매출", "start": "D1", "rows": [["메모"], ["좋음"]]},
        {"op": "add_sheet", "name": "요약", "rows": [["총합", "='매출'!B5"]]},
        {"op": "chart", "sheet": "매출", "type": "col", "data": "B1:B4", "categories": "A2:A4", "title": "월별"},
    ]})
    assert res["sheets"] == ["매출", "비용", "요약"]
    wb = load_workbook(io.BytesIO(read_vp(env, res["path"])))
    assert wb["매출"]["B5"].value == "=SUM(B2:B4)" and wb["매출"]["D2"].value == "좋음"
    assert wb["요약"]["B1"].value == "='매출'!B5"
    assert any(n.startswith("xl/charts/") for n in zipfile.ZipFile(io.BytesIO(read_vp(env, res["path"]))).namelist())
    for bad in ("=WEBSERVICE(\"http://x\")", "=[other.xlsx]Sheet1!A1", "=HYPERLINK(\"http://x\")&IMPORTXML(1)"):
        r = await run_fail(env, "xlsx_edit", {"path": src, "operations": [{"op": "set_cells", "cells": {"A1": bad}}]})
        assert "외부" in r["error"], bad
    r = await run_fail(env, "xlsx_edit", {"path": src, "operations": [{"op": "set_cells", "sheet": "없음", "cells": {"A1": 1}}]})
    assert "없는 시트" in r["error"]
    # 차트가 있던 통합 문서를 다시 고치면 보존 경고
    res2 = await run_ok(env, "xlsx_edit", {"path": res["path"], "operations": [{"op": "set_cells", "cells": {"A1": "x"}}]})
    assert res2.get("warnings")


async def test_pptx_edit(env):
    pptx = pytest.importorskip("pptx")
    prs = pptx.Presentation()
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = "2025 계획"
    s.placeholders[1].text = "목표 2025"
    buf = io.BytesIO()
    prs.save(buf)
    src = put(env, "docs/p.pptx", buf.getvalue())
    res = await run_ok(env, "pptx_edit", {"path": src, "operations": [
        {"op": "replace", "find": "2025", "replace": "2026"},
        {"op": "add_slide", "title": "새 장", "bullets": ["하나", {"text": "둘", "level": 1}], "notes": "메모",
         "position": 1},
        {"op": "set_text", "slide": 2, "shape": "body", "text": "바뀐 본문\n둘째 줄"},
    ]})
    assert [x["title"] for x in res["slides"]] == ["새 장", "2026 계획"]
    assert res["operations"][0]["replaced"] == 2
    p2 = pptx.Presentation(io.BytesIO(read_vp(env, res["path"])))
    first = p2.slides[0]
    assert first.notes_slide.notes_text_frame.text == "메모"
    body = [sh for sh in p2.slides[1].placeholders if sh.placeholder_format.idx == 1][0]
    assert body.text_frame.text == "바뀐 본문\n둘째 줄"


# ══ 변환 ═════════════════════════════════════════════════════
async def test_convert_xlsx_csv_roundtrip(env):
    src = put(env, "docs/t.xlsx", make_xlsx())
    one = await run_ok(env, "files_convert", {"path": src, "to": "csv", "sheet": "비용"})
    raw = read_vp(env, one["path"])
    assert raw.startswith("﻿".encode()) and "0012" in raw.decode("utf-8-sig")
    both = await run_ok(env, "files_convert", {"path": src, "to": "csv", "all_sheets": True})
    assert len(both["files"]) == 2 and both["folder"].endswith("변환")
    csv_path = put(env, "docs/in.csv", "코드,값,식\n0012,3.5,=1+1\n".encode("utf-8"))
    x = await run_ok(env, "files_convert", {"path": csv_path, "to": "xlsx"})
    from openpyxl import load_workbook

    ws = load_workbook(io.BytesIO(read_vp(env, x["path"]))).active
    assert ws["A2"].value == "0012" and ws["B2"].value == 3.5
    assert ws["C2"].value == "'=1+1"                                   # CSV 수식은 실행하지 않음


async def test_convert_csv_cp949(env):
    src = put(env, "docs/k.csv", "이름;나이\n철수;30\n".encode("cp949"))
    x = await run_ok(env, "files_convert", {"path": src, "to": "xlsx"})
    from openpyxl import load_workbook

    ws = load_workbook(io.BytesIO(read_vp(env, x["path"]))).active
    assert ws["A2"].value == "철수" and ws["B2"].value == 30


async def test_convert_md_docx_pdf_and_images(env):
    import shutil

    md = put(env, "docs/note.md", "# 제목\n\n- 하나\n- **둘**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n".encode())
    if shutil.which("pandoc"):
        d = await run_ok(env, "files_convert", {"path": md, "to": "docx"})
        import docx

        assert any(p.text == "제목" for p in docx.Document(io.BytesIO(read_vp(env, d["path"]))).paragraphs)
        # 그림·원시 HTML 로 서버 파일·URL 을 끌어오지 못한다
        evil = put(env, "docs/evil.md", (
            b"![pw](/etc/passwd)\n\n![r](http://169.254.169.254/x.png)\n\n<img src='/etc/hostname'>\n"))
        d = await run_ok(env, "files_convert", {"path": evil, "to": "docx"})
        names = zipfile.ZipFile(io.BytesIO(read_vp(env, d["path"]))).namelist()
        assert not any(n.startswith("word/media/") for n in names)
    try:
        import reportlab  # noqa: F401
        has_rl = True
    except ImportError:
        has_rl = False
    if has_rl:
        p = await run_ok(env, "files_convert", {"path": md, "to": "pdf"})
        from pypdf import PdfReader

        assert len(PdfReader(io.BytesIO(read_vp(env, p["path"]))).pages) >= 1 and p["engine"] == "library"
        t = put(env, "docs/plain.txt", "첫 줄\n\n둘째 문단".encode())
        p = await run_ok(env, "files_convert", {"path": t, "to": "pdf"})
        assert read_vp(env, p["path"]).startswith(b"%PDF")
    i1 = put(env, "docs/1.png", png((255, 0, 0)))
    i2 = put(env, "docs/2.png", png((0, 255, 0), (30, 60)))
    p = await run_ok(env, "files_convert", {"paths": [i1, i2], "to": "pdf"})
    from pypdf import PdfReader

    assert len(PdfReader(io.BytesIO(read_vp(env, p["path"]))).pages) == 2 and p["images"] == 2


async def test_convert_routes_office_and_hwp_to_docconv(env, monkeypatch):
    calls = []

    async def fake(data, ext, target, timeout=200.0):
        calls.append((ext, target, data))
        return b"%PDF-converted"
    monkeypatch.setattr(containers, "docconv_convert", fake)
    hwp = put(env, "docs/공문.hwp", b"HWP-BYTES")
    res = await run_ok(env, "files_convert", {"path": hwp, "to": "pdf"})
    assert calls == [(".hwp", "pdf", b"HWP-BYTES")] and res["engine"] == "docconv"
    assert res["name"] == "공문.pdf" and read_vp(env, res["path"]) == b"%PDF-converted"
    dx = put(env, "docs/a.docx", make_docx())
    await run_ok(env, "files_convert", {"path": dx, "to": "odt"})
    assert calls[-1][:2] == (".docx", "odt")
    r = await run_fail(env, "files_convert", {"path": put(env, "docs/z.zip", b"PK"), "to": "pdf"})
    assert r["ok"] is False and "지원하지 않습니다" in r["error"]
    r = await run_fail(env, "files_convert", {"path": hwp, "to": "xlsx"})
    assert "지원하지 않습니다" in r["error"]


async def test_docconv_client_errors(monkeypatch):
    def client_for(handler):
        return lambda url, timeout: (httpx.AsyncClient(transport=httpx.MockTransport(handler)), "http://d")

    seen = {}

    def ok(req):
        seen["q"] = dict(req.url.params)
        seen["tok"] = req.headers.get("x-docconv-token")
        return httpx.Response(200, content=b"%PDF")
    monkeypatch.setenv("DOCCONV_TOKEN", "t0k")
    monkeypatch.setattr(containers, "_client", client_for(ok))
    assert await containers.docconv_convert(b"x", ".hwpx", "pdf") == b"%PDF"
    assert seen == {"q": {"from": "hwpx", "to": "pdf"}, "tok": "t0k"}
    for status, code in ((413, "too_large"), (422, "unsupported"), (429, "rate_limited"), (504, "timeout"),
                         (500, "internal")):
        monkeypatch.setattr(containers, "_client", client_for(lambda r, s=status: httpx.Response(s, json={"message": "m"})))
        with pytest.raises(containers.ContainerError) as e:
            await containers.docconv_convert(b"x", ".docx", "pdf")
        assert e.value.code == code

    def down(req):
        raise httpx.ConnectError("refused")
    monkeypatch.setattr(containers, "_client", client_for(down))
    with pytest.raises(containers.ContainerError) as e:
        await containers.docconv_convert(b"x", ".docx", "pdf")
    assert e.value.code == "unavailable"
    with pytest.raises(containers.ContainerError) as e:
        await containers.docconv_convert(b"x", ".exe", "pdf")
    assert e.value.code == "unsupported"


# ══ 분석 샌드박스(code_run) ═══════════════════════════════════
async def test_code_run_passes_inputs_and_saves_outputs(env, monkeypatch):
    seen = {}

    async def fake(code, files, timeout_sec):
        seen.update(code=code, files=files, timeout=timeout_sec)
        return {"exit_code": 0, "timed_out": False, "stdout": "합계 60\n", "stderr": "", "duration_ms": 12,
                "files": [{"name": "chart.png", "data": png(), "size": len(png())},
                          {"name": "sub/요약.csv", "data": b"a,b\n", "size": 4}], "files_skipped": []}
    monkeypatch.setattr(containers, "sandbox_run", fake)
    sheet = make_xlsx()          # 한 번만 만든다 — 압축 파일에는 만든 시각이 들어가 두 번 만들면 초가 넘어갈 때 달라진다
    x = put(env, "docs/s.xlsx", sheet)
    res = await run_ok(env, "code_run", {"code": "print('hi')", "input_paths": [x], "timeout_sec": 999})
    assert seen["files"][0][0] == "s.xlsx" and seen["files"][0][1] == sheet and seen["timeout"] == 120
    assert res["stdout"] == "합계 60\n" and res["exit_code"] == 0
    assert res["inputs"] == [{"path": x, "as": "input/s.xlsx"}]
    names = sorted(f["name"] for f in res["files"])
    assert names == ["chart.png", "sub - 요약.csv"]
    assert all(f["path"].startswith("my/AI 결과물/") and "코드 실행 결과" in f["path"] for f in res["files"])
    assert {f["mime"] for f in res["files"]} == {"image/png", "text/csv"}


async def test_code_run_reads_inputs_with_user_permission(env, monkeypatch):
    async def fake(*a, **k):
        raise AssertionError("샌드박스까지 가면 안 됨")
    monkeypatch.setattr(containers, "sandbox_run", fake)
    r = await run_fail(env, "code_run", {"code": "print(1)", "input_paths": ["users/bob/secret.pdf"]})
    assert r.get("error")


async def test_code_run_clips_output_and_reports_limits(env, monkeypatch):
    async def fake(code, files, timeout_sec):
        return {"exit_code": -9, "timed_out": True, "killed_reason": "timeout", "stdout": "x" * 50_000,
                "stderr": "", "files": [], "duration_ms": 5000}
    monkeypatch.setattr(containers, "sandbox_run", fake)
    res = await run_ok(env, "code_run", {"code": "while True: pass"})
    assert res["timed_out"] and res["killed_reason"] == "timeout" and res["stdout_truncated"]
    assert len(res["stdout"]) < 21_000 and "생략" in res["stdout"]


async def test_code_run_without_sandbox_is_unavailable(env, monkeypatch):
    monkeypatch.delenv("SANDBOX_TOKEN", raising=False)
    r = await run_fail(env, "code_run", {"code": "print(1)"})
    assert "SANDBOX_TOKEN" in r["error"]


async def test_sandbox_client_protocol(monkeypatch):
    seen = {}

    def handler(req):
        seen["auth"] = req.headers.get("authorization")
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"exit_code": 0, "stdout": "ok", "stderr": "", "timed_out": False,
                                         "files": [{"name": "o.txt", "data": base64.b64encode(b"hey").decode()},
                                                   {"name": "bad", "data": "!!!"}]})
    monkeypatch.setenv("SANDBOX_TOKEN", "s3cret")
    monkeypatch.setattr(containers, "_client",
                        lambda url, timeout: (httpx.AsyncClient(transport=httpx.MockTransport(handler)), "http://s"))
    out = await containers.sandbox_run("print(1)", [("a.csv", b"1,2")], 30)
    assert seen["auth"] == "Bearer s3cret"
    assert seen["body"]["files"] == [{"name": "a.csv", "data": base64.b64encode(b"1,2").decode()}]
    assert out["files"] == [{"name": "o.txt", "data": b"hey", "size": 3}]     # 깨진 base64 는 버림
    monkeypatch.setattr(containers, "_client",
                        lambda url, timeout: (httpx.AsyncClient(transport=httpx.MockTransport(
                            lambda r: httpx.Response(401, json={}))), "http://s"))
    with pytest.raises(containers.ContainerError) as e:
        await containers.sandbox_run("print(1)", [], 30)
    assert "공유 비밀" in e.value.message


# ══ 순수 처리부 경계 ═══════════════════════════════════════════
def test_office_ops_limits():
    with pytest.raises(office_ops.OfficeError):
        office_ops.edit_docx(make_docx(), [])
    with pytest.raises(office_ops.OfficeError):
        office_ops.edit_docx(make_docx(), [{"op": "replace"}] * (office_ops.MAX_OPS + 1))
    with pytest.raises(office_ops.OfficeError) as e:
        office_ops.edit_xlsx(make_xlsx(), [{"op": "set_range", "start": "A1", "rows": [[1] * 1000] * 101}])
    assert e.value.code == "too_large"


def test_replace_in_runs_multiple_and_case():
    class R:
        def __init__(self, t):
            self.text = t
    runs = [R("ab"), R("cA"), R("Bc")]
    assert office_ops.replace_in_runs(runs, "abc", "X") == 1
    assert [r.text for r in runs] == ["X", "A", "Bc"]
    runs = [R("aB"), R("ab")]
    assert office_ops.replace_in_runs(runs, "ab", "_", match_case=False) == 2
    assert "".join(r.text for r in runs) == "__"


def test_images_to_pdf_rejects_garbage():
    with pytest.raises(convert_ops.ConvertError):
        convert_ops.images_to_pdf([b"not an image"])
    with pytest.raises(convert_ops.ConvertError):
        convert_ops.images_to_pdf([])


def test_store_folder_name_cleans_title():
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    f = store.folder_name(datetime(2026, 11, 5, 16, 0, tzinfo=timezone.utc), 'a/b:c*"d', ZoneInfo("Asia/Seoul"))
    assert f == "my/AI 결과물/2026-11-06 a b c d"
    assert store.folder_name(datetime(2026, 1, 1, tzinfo=timezone.utc), "", ZoneInfo("UTC")).endswith("새 대화")
    assert store.clean_name("..a..b..pdf") == "a.b.pdf"


def test_tool_module_objects_present():
    # 모듈을 import 만 해도 등록된다(직접 참조로 린트 경고 방지)
    assert convert_tool.files_convert and web_fetch_tool.web_fetch and code_run_tool.code_run
    assert McpWriteRequest
