"""S4 결과물 — 문서 생성·묶음 작업(부분 실패)·만료 링크·내 파일 저장·파일 압축·zip 풀기 (S4)."""

import io
import json
import zipfile
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.ai import artifacts as arts
from app.ai import artifacts_router as ar
from app.ai import docgen
from app.ai.artifact_models import AIArtifact, AIArtifactJob
from app.ai.models import AIConversation
from app.db.models import McpWriteRequest, SystemSetting, User
from app.mcp import access, writes
from app.mcp.server import WORKSPACE_TOOLS, execute_tool
from app.mcp.tools import archive_tool, files_write_tool
from tests.test_settings_security_p8 import db  # noqa: F401 (픽스처 재사용)

SCOPES = frozenset({"mcp:read", "mcp:write"})


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

    monkeypatch.setattr(arts, "session", _session)
    monkeypatch.setattr(writes, "session", _session)
    for mod in (files_write_tool, archive_tool):
        monkeypatch.setattr(mod, "async_session", _session)
    monkeypatch.setattr(arts, "ARTIFACT_DIR", str(tmp_path / "art"))
    marks: dict = {}

    async def recent(uid, key):
        return marks.get((uid, key))

    async def none(*a, **k):
        return None
    monkeypatch.setattr(writes, "recent_untrusted", recent)
    monkeypatch.setattr(writes, "emit_count", none)
    monkeypatch.setattr(writes, "_notify_pending", none)
    events: list = []

    async def emit(db_, job, finished=False):
        events.append((job.id, job.status, finished))
    monkeypatch.setattr(arts, "_emit", emit)
    notes: list = []

    async def notify(db_, job):
        notes.append(job.id)
    monkeypatch.setattr(arts, "_notify_done", notify)
    spawned: list = []
    monkeypatch.setattr(arts, "_spawn", lambda coro: spawned.append(coro))

    from app.files import activity as act
    from app.files import indexer
    from app.files import router as fr
    from app.files import service as fs

    async def _act_session():
        return _Ctx(db)
    monkeypatch.setattr(act, "_session", _act_session)
    root = tmp_path / "storage"
    monkeypatch.setattr(fr.settings, "storage_root", str(root))
    monkeypatch.setattr(fs, "STORAGE_ROOT", root)
    monkeypatch.setattr(fs, "VERSIONS_ROOT", root / ".versions")
    monkeypatch.setattr(indexer, "schedule_quick_index", lambda *a, **k: None)
    fs._dir_cache.clear()
    for u in ("alice", "bob"):
        (root / "users" / u).mkdir(parents=True)
    conv = AIConversation(user_id="alice", title="VPN 장애/보고서 초안", tools_enabled=True)
    db.add(conv)
    await db.commit()
    alice = await db.get(User, "alice")
    bob = await db.get(User, "bob")
    return SimpleNamespace(db=db, root=root, alice=alice, bob=bob, conv=conv.id, marks=marks, events=events,
                           notes=notes, spawned=spawned)


def _ctx(source, conv=None):
    return writes.call_context.set(writes.CallContext(source=source, client_name="Claude", client_kind="claude_app",
                                                      client_key=conv or "k1", conversation_id=conv))


async def _run_spawned(env):
    while env.spawned:
        await env.spawned.pop(0)


DOCX = {"format": "docx", "title": "VPN 장애 보고서", "blocks": [
    {"type": "heading", "text": "개요"}, {"type": "paragraph", "text": "원인은 IKE 재협상"},
    {"type": "table", "header": ["항목", "값"], "rows": [["주기", "8시간"]]}]}


# ── 생성기 ────────────────────────────────────────────────────
def test_docgen_docx_xlsx_and_formula_injection():
    s = docgen.normalize("docx", {**DOCX, "blocks": DOCX["blocks"] + ["제어\x01문자"]})
    assert s["filename"] == "VPN 장애 보고서.docx"
    from docx import Document

    d = Document(io.BytesIO(docgen.build(s).data))
    text = "\n".join(p.text for p in d.paragraphs)
    assert "원인은 IKE 재협상" in text and "제어문자" in text and d.core_properties.keywords == "AI 생성"
    s = docgen.normalize("xlsx", {"sheets": [{"name": "일지/1", "header": ["날짜", "건수"], "rows": [
        ["11-03", 3], ["합계", {"formula": "=SUM(B2:B2)"}], ["=HYPERLINK(\"http://x\",\"y\")", 1]]}]})
    import openpyxl

    ws = openpyxl.load_workbook(io.BytesIO(docgen.build(s).data)).active
    assert ws.title == "일지 1" and ws["B3"].value == "=SUM(B2:B2)"
    assert ws["A4"].data_type == "s"                       # 글자 그대로(수식 아님)
    with pytest.raises(docgen.SpecError):
        docgen.normalize("xlsx", {"sheets": [{"rows": [[{"formula": "=WEBSERVICE(\"http://x\")"}]]}]})
    with pytest.raises(docgen.SpecError):
        docgen.normalize("xlsx", {"sheets": [{"rows": [[{"formula": "=[1]Sheet!A1"}]]}]})
    with pytest.raises(docgen.SpecError) as e:
        docgen.normalize("hwp", {"title": "x"})
    assert e.value.code == "unsupported"
    assert docgen.safe_filename("../a/b:c", "pdf") == "a b c.pdf"


def test_docgen_pptx_pdf():
    pytest.importorskip("pptx")
    pytest.importorskip("reportlab")
    b = docgen.build(docgen.normalize("pptx", {"title": "보고", "subtitle": "11월", "slides": [
        {"title": "원인", "bullets": ["IKE", {"text": "재협상", "level": 1}], "notes": "메모"},
        {"title": "표", "table": {"header": ["a", "b"], "rows": [["1", "2"]]}}]}))
    assert b.info == {"slides": 3} and b.data[:2] == b"PK"
    b = docgen.build(docgen.normalize("pdf", {**DOCX, "format": "pdf"}))
    import pypdf

    r = pypdf.PdfReader(io.BytesIO(b.data))
    assert len(r.pages) == b.info["pages"] == 1 and "VPN" in r.pages[0].extract_text()


def test_tools_registered_with_access_and_risk():
    for n in ("docs_create", "docs_create_bundle", "files_zip", "artifacts_save_to_files", "files_unzip"):
        t = WORKSPACE_TOOLS[n]
        assert t.scope == "mcp:write" and t.risk == "low" and n in access.TOOL_MODULE
    for n in ("docs_job_status", "files_archive_list"):
        assert WORKSPACE_TOOLS[n].scope == "mcp:read" and n in access.TOOL_MODULE
    assert WORKSPACE_TOOLS["docs_create"].auto_run and not WORKSPACE_TOOLS["files_zip"].auto_run
    assert WORKSPACE_TOOLS["files_job_status"].scope == "mcp:read" and access.TOOL_MODULE["files_job_status"] == "files"
    assert not WORKSPACE_TOOLS["files_unzip"].auto_run and not WORKSPACE_TOOLS["artifacts_save_to_files"].auto_run
    assert access.TOOL_MODULE["files_zip"] == "files" and access.TOOL_MODULE["docs_create"] is None
    assert not access.is_data_tool("docs_create") and access.is_data_tool("files_zip")


# ── 문서 하나: 쓰기 체계 + 링크 ───────────────────────────────
async def test_docs_create_runs_immediately_everywhere_and_link_is_signed(env):
    env.marks[("alice", "k1")] = {"kind": "mail"}            # 직전 외부 읽기여도 생성은 바로(auto_run)
    t = _ctx("mcp")
    try:
        r = await execute_tool("docs_create", DOCX, env.alice, scopes=SCOPES)
    finally:
        writes.call_context.reset(t)
    assert r["ok"] and r["result"]["status"] == "executed", r
    out = r["result"]["result"]
    assert out["download_url"].startswith("http://localhost:8000/api/ai/artifacts/")
    art = out["artifact"]
    assert art["status"] == "ready" and art["name"] == "VPN 장애 보고서.docx" and art["pages"] >= 1
    req = (await env.db.execute(select(McpWriteRequest))).scalars().one()
    assert req.tool == "docs_create" and req.status == "executed"      # 쓰기 기록·감사 경로

    # 내장 AI 에서도 카드 없이 실행 + 결과물 카드 SSE
    t = _ctx("ai", env.conv)
    try:
        r2 = await execute_tool("docs_create", DOCX, env.alice, scopes=SCOPES)
    finally:
        writes.call_context.reset(t)
    assert r2["result"]["status"] == "executed"
    [p] = arts.sse_payloads("docs_create", r2)
    assert p["type"] == "file" and p["artifact"]["conversation_id"] == env.conv
    assert p["artifact"]["download_url"].startswith("/api/ai/artifacts/")

    a = await env.db.get(AIArtifact, art["id"])
    url = arts.download_url(a)
    q = dict(x.split("=") for x in url.split("?")[1].split("&"))
    req_ = SimpleNamespace(headers={})
    with pytest.raises(HTTPException) as e:                   # 남의 것
        await ar.download_artifact(a.id, req_, q["exp"], q["sig"], user=env.bob, db=env.db)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:                   # 서명 틀림
        await ar.download_artifact(a.id, req_, q["exp"], "0" * 40, user=env.alice, db=env.db)
    assert e.value.status_code == 410
    assert arts.check_sig(a, "alice", q["exp"], q["sig"]) and not arts.check_sig(a, "bob", q["exp"], q["sig"])

    # 만료 → 링크 만료 + 다시 만들기
    a.expires_at = arts._now() - timedelta(minutes=1)
    await env.db.commit()
    got = await ar.get_artifact(a.id, user=env.alice, db=env.db)
    assert got["status"] == "expired" and got["download_url"] is None and got["can_rebuild"]
    again = await ar.rebuild_artifact(a.id, user=env.alice, db=env.db)
    assert again["status"] == "ready" and again["id"] == a.id and again["download_url"]
    pv = await ar.preview_artifact(a.id, user=env.alice, db=env.db)
    assert pv["preview"]["blocks"][0]["text"] == "개요"


async def test_docs_create_invalid_input_is_model_fixable(env):
    t = _ctx("mcp")
    try:
        r = await execute_tool("docs_create", {"format": "xlsx", "sheets": []}, env.alice, scopes=SCOPES)
    finally:
        writes.call_context.reset(t)
    assert not r["ok"]


# ── 묶음: 부분 실패 · 이것만 다시 · 저장 ──────────────────────
async def test_bundle_partial_failure_retry_and_save(env, monkeypatch):
    real_build = docgen.build

    def flaky(spec):
        if spec["format"] == "xlsx":
            raise RuntimeError("변환 실패")
        return real_build(spec)
    monkeypatch.setattr(docgen, "build", flaky)
    files = [DOCX, {"format": "xlsx", "title": "장애 일지", "sheets": [{"rows": [[1]]}]},
             {**DOCX, "title": "VPN 장애 보고서"}]
    t = _ctx("ai", env.conv)
    try:
        r = await execute_tool("docs_create_bundle", {"files": files, "zip_name": "장애 묶음"}, env.alice, scopes=SCOPES)
    finally:
        writes.call_context.reset(t)
    job = r["result"]["result"]["job"]
    assert job["status"] == "running" and job["total"] == 3
    assert arts.sse_payloads("docs_create_bundle", r)[0]["type"] == "bundle"
    await _run_spawned(env)
    j = await ar.get_job(job["id"], user=env.alice, db=env.db)
    assert j["status"] == "partial" and j["ok"] == 2 and j["failed"] == 1
    assert [i["status"] for i in j["items"]] == ["ready", "failed", "ready"]
    assert j["items"][1]["error"] == "변환 실패" and env.notes == [job["id"]]
    zpath = arts.file_path(j["zip"]["id"])
    names = zipfile.ZipFile(zpath).namelist()
    assert names == ["VPN 장애 보고서.docx", "VPN 장애 보고서 (2).docx"]   # 만든 것만, 이름 겹침 구분

    monkeypatch.setattr(docgen, "build", real_build)
    j = await ar.retry_job_item(job["id"], 1, user=env.alice, db=env.db)
    assert j["status"] == "done" and len(zipfile.ZipFile(arts.file_path(j["zip"]["id"])).namelist()) == 3

    with pytest.raises(HTTPException):
        await ar.get_job(job["id"], user=env.bob, db=env.db)

    saved = await ar.save_job(job["id"], user=env.alice, db=env.db)
    today = arts._now().astimezone(__import__("zoneinfo").ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d")
    assert saved["folder"] == f"my/AI 결과물/{today} VPN 장애 보고서 초안"
    folder = env.root / "users" / "alice" / "AI 결과물" / f"{today} VPN 장애 보고서 초안"
    assert sorted(p.name for p in folder.iterdir()) == ["VPN 장애 보고서 (2).docx", "VPN 장애 보고서.docx", "장애 일지.xlsx"]
    assert saved["job"]["saved_label"].startswith("내 파일 › AI 결과물")
    # 다시 저장해도 덮지 않는다
    one = j["items"][0]["artifact_id"]
    s2 = await ar.save_artifact(one, user=env.alice, db=env.db)
    assert s2["files"][0]["name"] == "VPN 장애 보고서 (3).docx" and s2["artifact"]["saved_path"].endswith("(3).docx")


async def test_save_quota_and_stale_job(env, monkeypatch):
    t = _ctx("ai", env.conv)
    try:
        r = await execute_tool("docs_create", DOCX, env.alice, scopes=SCOPES)
    finally:
        writes.call_context.reset(t)
    aid = r["result"]["result"]["artifact"]["id"]

    async def tiny(db_, user):
        return 10
    monkeypatch.setattr(arts, "quota_room", tiny)
    with pytest.raises(HTTPException) as e:
        await ar.save_artifact(aid, user=env.alice, db=env.db)
    assert e.value.status_code == 413 and e.value.detail["code"] == "quota" and e.value.detail["room_bytes"] == 10

    job = AIArtifactJob(id="j1", user_id="alice", name="x.zip", kind="docs", status="running", total=1,
                        items=json.dumps([{"index": 0, "name": "a.docx", "format": "docx", "status": "running"}]),
                        specs="[]", updated_at=arts._now() - timedelta(hours=1))
    env.db.add(job)
    await env.db.commit()
    j = await ar.get_job("j1", user=env.alice, db=env.db)
    assert j["status"] == "failed" and "다시 시작" in j["items"][0]["error"]


# ── 파일 압축(files_zip) ──────────────────────────────────────
async def _zip(env, args, source="mcp"):
    t = _ctx(source, env.conv if source == "ai" else None)
    try:
        return await execute_tool("files_zip", args, env.alice, scopes=SCOPES)
    finally:
        writes.call_context.reset(t)


def _seed_22(env):
    me = env.root / "users" / "alice"
    (me / "자료").mkdir()
    for i in range(20):
        (me / "자료" / f"보고서 {i:02d}.txt").write_text(f"내용 {i}", encoding="utf-8")
    (me / "보고서").mkdir()
    (me / "보고서" / "회의록.txt").write_text("a", encoding="utf-8")
    (me / "보고서" / "sub").mkdir()
    (me / "보고서" / "sub" / "회의록.txt").write_text("b", encoding="utf-8")
    (me / "메모.txt").write_text("same", encoding="utf-8")
    (me / "x").mkdir()
    (me / "x" / "메모.txt").write_text("same", encoding="utf-8")       # 같은 이름·같은 내용
    (env.root / "users" / "bob" / "secret.txt").write_text("bob", encoding="utf-8")
    return me


async def test_files_zip_22_files_and_folder_sync_result(env):
    me = _seed_22(env)
    r = await _zip(env, {"paths": ["my/자료/" + f"보고서 {i:02d}.txt" for i in range(20)]
                         + ["my/메모.txt", "my/x/메모.txt", "my/보고서", "users/bob/secret.txt"], "zip_name": "묶음"})
    assert r["ok"] and r["result"]["status"] == "executed", r
    out = r["result"]["result"]
    keys = list(out)
    assert keys[:4] == ["status", "job_id", "path", "size"]                 # 요약이 맨 앞
    today = arts._now().astimezone(__import__("zoneinfo").ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d")
    assert out["path"] == f"my/AI 결과물/{today} 새 대화/묶음.zip" and out["files"] == 24
    assert out["skipped"] == [{"path": "users/bob/secret.txt", "reason": "권한 없음"}] and out["deduped"] == []
    assert out["size"].endswith("B") and out["undo"]["tool"] == "files_undo_create" and out["download_url"]
    assert r["result"]["can_undo"] and "job" not in out                       # MCP 응답엔 카드용 job 없음
    zpath = me / "AI 결과물" / f"{today} 새 대화" / "묶음.zip"
    zf = zipfile.ZipFile(zpath)
    names = zf.namelist()
    assert "보고서/회의록.txt" in names and "보고서/sub/회의록.txt" in names     # 폴더 구조 유지
    assert "메모.txt" in names and "x/메모.txt" in names                       # 같은 이름 = 상대 경로로 둘 다
    # 한글 이름 = UTF-8 EFS 플래그(bit 11) — Windows 10+·macOS 모두 정상
    for i in zf.infolist():
        if not i.filename.isascii():
            assert i.flag_bits & 0x800
    assert "users/bob/secret.txt — 권한 없음" in zf.read(arts.MANIFEST_NAME).decode("utf-8")
    # 되돌리기(기존 서명 체계)
    u = await execute_tool("files_undo_create", {"path": out["undo"]["path"], "token": out["undo"]["token"]},
                           env.alice, scopes=SCOPES)
    assert u["ok"] and not zpath.exists()


async def test_files_zip_names_conflict_modes_dedupe_and_cp949(env):
    me = _seed_22(env)
    both = {"paths": ["my/메모.txt", "my/x/메모.txt"]}
    r = await _zip(env, {**both, "zip_name": "a"})
    names = zipfile.ZipFile(me / "AI 결과물" / r["result"]["result"]["path"].split("AI 결과물/")[1]).namelist()
    assert {"메모.txt", "x/메모.txt"} <= set(names)                            # 둘 다 들어감(dedupe off)
    r = await _zip(env, {**both, "zip_name": "b", "conflict": "suffix"})
    p = env.root / "users" / "alice" / r["result"]["result"]["path"][3:]
    assert {"메모.txt", "메모 (2).txt"} <= set(zipfile.ZipFile(p).namelist())
    r = await _zip(env, {**both, "zip_name": "c", "dedupe": True})
    out = r["result"]["result"]
    assert out["files"] == 1 and out["deduped"] == [{"path": "my/x/메모.txt", "same_as": "my/메모.txt"}]
    # cp949 — 표시 끄고 cp949 바이트, cp949 로 못 쓰는 이름(이모지)은 UTF-8+경고
    (me / "웃음😀.txt").write_text("e", encoding="utf-8")
    r = await _zip(env, {"paths": ["my/메모.txt", "my/웃음😀.txt"], "zip_name": "d", "encoding": "cp949"})
    out = r["result"]["result"]
    raw = zipfile.ZipFile(env.root / "users" / "alice" / out["path"][3:])
    infos = {i.filename: i for i in raw.infolist()}
    memo = [i for n, i in infos.items() if not (i.flag_bits & 0x800) and n != arts.MANIFEST_NAME][0]
    assert memo.filename.encode("cp437").decode("cp949") == "메모.txt"
    assert "웃음😀.txt" in infos and infos["웃음😀.txt"].flag_bits & 0x800
    assert out["warnings"] and "cp949" in out["warnings"][0]
    bad = await _zip(env, {**both, "encoding": "euc-jp"})
    assert bad["ok"] is False and bad["error_code"] == "invalid_argument"


async def test_files_zip_dst_path_limits_and_async_job(env, monkeypatch):
    me = _seed_22(env)
    r = await _zip(env, {"paths": ["my/보고서"], "dst_path": "my/보관/회의.zip"})
    assert r["result"]["result"]["path"] == "my/보관/회의.zip" and (me / "보관" / "회의.zip").is_file()
    r = await _zip(env, {"paths": ["my/보고서"], "dst_path": "my/보관/회의.zip"})   # 덮어쓰기 금지
    assert r["ok"] is False and r["error_code"] == "conflict" and r.get("hint")
    r = await _zip(env, {"paths": ["my/보고서"], "dst_path": "shared/x.zip"})
    assert r["ok"] is False and r["error_code"] == "invalid_argument"
    # 상한 초과 = 형식 맞는 오류
    env.db.add(SystemSetting(key=arts.ZIP_MAX_BYTES_KEY, value="3"))
    await env.db.commit()
    r = await _zip(env, {"paths": ["my/보고서", "my/메모.txt"]})
    assert r["ok"] is False and r["error_code"] == "too_large" and r["hint"]
    await env.db.execute(SystemSetting.__table__.delete())
    await env.db.commit()
    # 큰 묶음 = job_id + files_job_status
    monkeypatch.setattr(arts, "SYNC_MAX_FILES", 1)
    r = await _zip(env, {"folder": "my/자료"})
    out = r["result"]["result"]
    assert out["status"] == "running" and out["job_id"] and "files_job_status" in out["message"]
    await _run_spawned(env)
    t = _ctx("mcp")
    try:
        st = await execute_tool("files_job_status", {"job_id": out["job_id"]}, env.alice, scopes=SCOPES)
    finally:
        writes.call_context.reset(t)
    assert st["ok"] and st["result"]["status"] == "done" and st["result"]["files"] == 20
    assert st["result"]["progress"] == "20/20" and st["result"]["download_url"].startswith("http")
    # 파일 수 상한(설정)
    env.db.add(SystemSetting(key=arts.ZIP_MAX_FILES_KEY, value="2"))
    await env.db.commit()
    job2, _done = await arts.start_files_zip(env.db, env.alice, name="z", conversation_id=None, folder="my/보고서",
                                             force_async=True)
    assert job2.total == 2
    await _run_spawned(env)


async def test_files_zip_builtin_ai_uses_card_and_shows_bundle(env):
    _seed_22(env)
    r = await _zip(env, {"paths": ["my/보고서"]}, source="ai")
    assert r["result"]["status"] == "pending_confirmation"            # 내장 AI = low 카드
    req = await env.db.get(McpWriteRequest, r["result"]["request_id"])
    await writes.approve(env.db, env.alice, req.id)
    res = json.loads(req.result)
    assert res["job"]["kind"] == "files_zip" and res["path"].startswith("my/AI 결과물/")


async def test_zip_can_be_shared_and_attached(env, monkeypatch):
    _seed_22(env)
    r = await _zip(env, {"paths": ["my/보고서"], "dst_path": "my/전달.zip"})
    zp = r["result"]["result"]["path"]
    from app.mcp.tools import collab_write_tool, files_write_tool as fwt, mail_write_tool

    for mod in (fwt, mail_write_tool, collab_write_tool):
        monkeypatch.setattr(mod, "async_session", _sess(env.db))
    from app.files import router as fr

    monkeypatch.setattr(fr, "_share_url", lambda *a, **k: "http://x/s/t", raising=False)
    s1 = await fwt.files_share_external(env.alice, zp)
    assert s1.get("url") and s1["name"] == "전달.zip", s1
    s2 = await fwt.files_share_external(env.alice, "my/보고서")                 # 폴더 = 묶음 링크(zip)
    assert s2.get("url") and s2["name"] == "보고서.zip", s2
    # 메일 초안 첨부(경로) → 작성 창이 열 때 임시 첨부로
    from app.mail import router as mr

    async def fake_store(data, name, ctype, uid):
        return {"blobId": "b1", "name": name, "type": ctype, "size": len(data)}
    monkeypatch.setattr(mr, "_store_temp_attachment", fake_store)
    d = await mail_write_tool.mail_save_draft(env.alice, subject="자료", body="첨부합니다", to=["kim@example.com"],
                                              attachments=[zp])
    assert d["attachments"][0]["name"] == "전달.zip", d
    got = await mr.get_draft.__wrapped__(d["draft_id"], user=env.alice, db=env.db)
    assert got.attachments[0]["blobId"] == "b1" and got.attachments[0]["name"] == "전달.zip"
    bad = await mail_write_tool.mail_save_draft(env.alice, subject="x", attachments=["users/bob/secret.txt"])
    assert bad.get("error_code") in ("forbidden", "not_found")
    bad = await mail_write_tool.mail_save_draft(env.alice, subject="x", attachments=["my/보고서"])
    assert bad.get("error_code") == "invalid_argument"
    # 채팅 첨부 — 보내기 전에 전부 검사(폴더·남의 파일은 거절)
    c = await collab_write_tool.chat_send_message(env.alice, "ch1", attachments=["my/보고서"])
    assert c.get("error_code") == "invalid_argument"
    c = await collab_write_tool.chat_send_message(env.alice, "ch1", attachments=["users/bob/secret.txt"])
    assert c.get("error_code") == "forbidden"
    c = await collab_write_tool.chat_send_message(env.alice, "ch1")
    assert c.get("error_code") == "invalid_argument"


def _sess(db):
    @asynccontextmanager
    async def s():
        yield db
    return s


async def test_files_screen_zip_endpoint(env):
    (env.root / "users" / "alice" / "a.txt").write_text("a", encoding="utf-8")
    job = await ar.start_zip(ar.ZipBody(paths=["my/a.txt"]), user=env.alice, db=env.db)
    assert job["kind"] == "files_zip" and job["status"] == "done" and job["zip"]["download_url"]
    a = await env.db.get(AIArtifact, job["zip"]["id"])
    q = dict(x.split("=") for x in job["zip"]["download_url"].split("?")[1].split("&"))
    resp = await ar.download_artifact(a.id, SimpleNamespace(headers={}), q["exp"], q["sig"], user=env.alice, db=env.db)
    assert resp.status_code == 200
    with pytest.raises(HTTPException):
        await ar.start_zip(ar.ZipBody(), user=env.alice, db=env.db)


# ── zip 보기 · 풀기 ───────────────────────────────────────────
def _zip_bytes(entries: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


async def test_archive_list_and_unzip_defenses(env):
    me = env.root / "users" / "alice"
    (me / "in.zip").write_bytes(_zip_bytes({"문서/a.txt": "A", "../evil.txt": "x", "/abs.txt": "y",
                                            "b.txt": "B", "__MACOSX/._b.txt": "m"}))
    t = _ctx("mcp")
    try:
        lst = await execute_tool("files_archive_list", {"path": "my/in.zip"}, env.alice, scopes=SCOPES)
        assert lst["ok"] and lst["result"]["untrusted"] is True
        ents = {e["name"]: e for e in lst["result"]["data"]["entries"]}
        assert ents["../evil.txt"].get("unsafe") and not ents["b.txt"].get("unsafe")
        (me / "in").mkdir()      # 같은 이름 폴더가 있으면 새 폴더는 " (2)"
        r = await execute_tool("files_unzip", {"path": "my/in.zip"}, env.alice, scopes=SCOPES)
    finally:
        writes.call_context.reset(t)
    assert r["ok"] and r["result"]["status"] == "executed", r
    out = r["result"]["result"]
    assert out["folder"] == "my/in (2)" and out["files"] == 2 and r["result"]["can_undo"]
    assert (me / "in (2)" / "문서" / "a.txt").read_text() == "A"
    assert not (env.root / "users" / "evil.txt").exists() and not (me / "evil.txt").exists()
    assert len(out["skipped"]) == 2 and not (me / "in (2)" / "__MACOSX").exists()

    # 내장 AI 에서는 승인 카드(low, auto_run 아님)
    t = _ctx("ai", env.conv)
    try:
        r = await execute_tool("files_unzip", {"path": "my/in.zip"}, env.alice, scopes=SCOPES)
    finally:
        writes.call_context.reset(t)
    assert r["result"]["status"] == "pending_confirmation"

    # 덮어쓰지 않기(새 폴더 없이 풀 때)
    t = _ctx("mcp")
    try:
        (me / "b.txt").write_text("old", encoding="utf-8")
        r = await execute_tool("files_unzip", {"path": "my/in.zip", "into_new_folder": False}, env.alice, scopes=SCOPES)
        assert r["result"]["status"] == "executed"
        assert (me / "b.txt").read_text() == "old" and (me / "b (2).txt").read_text() == "B"
        # zip bomb(압축률)
        (me / "bomb.zip").write_bytes(_zip_bytes({"z.bin": b"\0" * (5 * 1024 * 1024)}))
        r = await execute_tool("files_unzip", {"path": "my/bomb.zip"}, env.alice, scopes=SCOPES)
        assert r["ok"] is False or r["result"]["status"] == "failed"
    finally:
        writes.call_context.reset(t)


def test_cp949_entry_name_and_safe_parts():
    info = zipfile.ZipInfo("보고서.txt".encode("cp949").decode("cp437"))
    info.flag_bits = 0
    assert archive_tool.entry_name(info) == "보고서.txt"
    assert archive_tool.safe_parts("../x") is None and archive_tool.safe_parts("C:/x") is None
    assert archive_tool.safe_parts("a\\b.txt") == ["a", "b.txt"]


# ── 채팅 SSE · 복원 ───────────────────────────────────────────
async def test_chat_stream_emits_artifact_and_restores(env, monkeypatch):
    from app.ai import config as ai_config
    from app.ai import router as ai_router
    from tests.test_ai_s6a_chat_basics import _events

    @asynccontextmanager
    async def _session():
        yield env.db
    monkeypatch.setattr(ai_router, "async_session", _session)
    seen: list = []

    async def fake_stream(cfg, msgs, system=None, tools=None):
        seen.append(1)
        if len(seen) == 1:
            yield {"type": "tool_call", "name": "docs_create", "args": json.dumps(DOCX)}
        else:
            yield {"type": "text", "text": "만들었습니다."}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)

    async def fake_exec(db_, name, args, user, **kw):
        t = _ctx("ai", env.conv)
        try:
            return await execute_tool(name, args, user, scopes=SCOPES)
        finally:
            writes.call_context.reset(t)
    monkeypatch.setattr(ai_config, "ai_execute_tool", fake_exec)
    cfg = SimpleNamespace(model="m", kind="ollama", base="", extra={})
    chunks = []
    async for c in ai_router._chat_event_stream(env.conv, env.alice, cfg, False, None,
                                                 [{"function": {"name": "docs_create"}}], True,
                                                 [{"role": "user", "content": "보고서 만들어 줘"}]):
        chunks.append(c)
    evs = _events(chunks)
    arts_ev = [d for e, d in evs if e == "artifact"]
    assert len(arts_ev) == 1 and arts_ev[0]["artifact"]["format"] == "docx"
    out = await ai_router.get_messages.__wrapped__(env.conv, user=env.alice, db=env.db)
    [m] = [x for x in out["messages"] if x["role"] == "assistant"]
    assert m["artifacts"][0]["artifact"]["id"] == arts_ev[0]["artifact"]["id"]
