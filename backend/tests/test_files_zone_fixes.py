"""파일·공유·오피스 구역 전수조사 수정 고정.

- 이름 검증 한곳(새 폴더·이름 바꾸기·업로드): 숨김(. 시작)·NAS 시스템 이름(@Recycle 등) 거부, 이름 중간의 `..` 는 허용
  ("@프로젝트" 같은 일반 @ 이름은 2026-11-14 부터 허용 — filesdec_names_test.py)
- 휴지통 표시 이름(밑줄이 든 이름이 잘리지 않는다)
- 덮어쓰기 업로드가 실패해도 원본이 남는다(.part → os.replace), 대상이 폴더면 409
- 보안: 할당 우회(세션 size=0·복사), 공유 링크가 경로가 아니라 항목을 따라감, 링크 비밀번호 시도 제한,
        WOPI 로 횟수·내려받기 막음 우회, 회수한 편집 링크의 손님 토큰, shared/ 문서 편집 세션 키
"""

import io

import pytest
from fastapi import HTTPException, UploadFile

from app.db.models import ShareLink
from app.files import quota as file_quota
from app.files import router as fr
from app.files import service as fs
from app.files import upload_sessions as us
from app.files.schemas import (
    MkdirRequest, MoveRequest, RenameRequest, ShareLinkCreate, ShareUnlockRequest, TrashRestoreRequest,
)
from tests.test_files_p4 import Req, env  # noqa: F401 (픽스처 재사용)


def _up(name: str, data: bytes = b"new") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(data))


async def _upload(env, name, data=b"new", path="my/docs", user=None):
    return await fr.upload_file(_up(name, data), path=path, upload_id=None, size=len(data), mtime=None,
                                x_file_mtime=None, user=user or env.alice, db=env.db)


async def _status(coro) -> int:
    with pytest.raises(HTTPException) as e:
        await coro
    return e.value.status_code


# ─── 이름 검증 ───


@pytest.mark.parametrize("ok", ["v1..2.txt", "결과...최종.pdf", "a b.txt", "보고서_최종.docx", "x@y.txt", "@프로젝트"])
def test_validate_name_accepts(ok):
    assert fs.validate_name(f"  {ok} ") == ok


@pytest.mark.parametrize("bad", ["", "  ", ".", "..", ".env", "@Recycle", "a/b", "a\\b", "a\x00b", "a\nb", "가" * 100])
def test_validate_name_rejects(bad):
    with pytest.raises(fs.InvalidNameError):
        fs.validate_name(bad)


@pytest.mark.asyncio
async def test_mkdir_and_rename_refuse_hidden_names(env):
    for name in ("@Recycle", ".숨김"):
        assert await _status(fr.mkdir(body=MkdirRequest(path=f"my/docs/{name}"), user=env.alice, db=env.db)) == 400
        assert not (env.home / "docs" / name).exists()
        assert await _status(fr.rename_file(body=RenameRequest(path="my/docs/a.txt", new_name=name),
                                            user=env.alice, db=env.db)) == 400
    assert (env.home / "docs" / "a.txt").is_file()        # 그대로
    r = await fr.rename_file(body=RenameRequest(path="my/docs/a.txt", new_name="a..b.txt"), user=env.alice, db=env.db)
    assert r["new_name"] == "a..b.txt"


@pytest.mark.asyncio
async def test_upload_name_rules(env):
    r = await _upload(env, "v1..2.txt")
    assert r["name"] == "v1..2.txt" and (env.home / "docs" / "v1..2.txt").read_bytes() == b"new"
    with pytest.raises(HTTPException) as e:
        await _upload(env, ".env")
    assert e.value.status_code == 400 and "올릴 수 없는 파일 이름" in e.value.detail
    assert await _status(_upload(env, "..")) == 400
    # 경로가 붙어 와도 끝 조각만 쓴다(탈출 없음)
    r = await _upload(env, "../../evil.txt")
    assert r["path"] == "my/docs/evil.txt"


# ─── 휴지통 이름 ───


@pytest.mark.asyncio
async def test_trash_shows_full_name_with_underscores(env):
    (env.home / "docs" / "보고서_최종_v2.docx").write_bytes(b"x")
    await fr.delete_file(path="my/docs/보고서_최종_v2.docx", permanent=False, user=env.alice, db=env.db)
    items = (await fr.list_trash(user=env.alice, db=env.db)).items
    assert [i.name for i in items] == ["보고서_최종_v2.docx"]
    # 메타가 없을 때도 "<시각>_" 만 뗀다
    assert fr._trash_display_name("20261114093000_a_b.txt", {}) == "a_b.txt"
    assert fr._trash_display_name("이름만", {}) == "이름만"


# ─── 덮어쓰기 업로드 ───


@pytest.mark.asyncio
async def test_failed_overwrite_keeps_original(env, monkeypatch):
    async def _tiny(db):
        return 0, 3            # 상한 3바이트

    monkeypatch.setattr(fr, "_upload_max_bytes", _tiny)
    assert await _status(_upload(env, "a.txt", b"too long")) == 413
    assert (env.home / "docs" / "a.txt").read_text() == "hello"
    assert not [p.name for p in (env.home / "docs").iterdir() if p.name.endswith(".part")]


@pytest.mark.asyncio
async def test_overwrite_succeeds_and_snapshots(env):
    await _upload(env, "a.txt", b"second")
    assert (env.home / "docs" / "a.txt").read_bytes() == b"second"
    assert fs.version_count("alice", "docs/a.txt") == 1
    assert not [p.name for p in (env.home / "docs").iterdir() if p.name.endswith(".part")]


@pytest.mark.asyncio
async def test_upload_onto_folder_is_409(env):
    assert await _status(_upload(env, "sub")) == 409
    assert (env.home / "docs" / "sub" / "b.txt").is_file()


# ─── 할당 우회 ───


@pytest.mark.asyncio
async def test_session_with_zero_size_cannot_bypass_quota(env, monkeypatch):
    async def _room(db, user, vpath):
        return 3

    monkeypatch.setattr(file_quota, "room_left", _room)
    s = await fr.create_upload_session(body=fr.UploadSessionCreate(path="my/docs", name="big.bin", size=0),
                                       user=env.alice, db=env.db)
    d, _meta = us.read_meta(fr._sessions_root(), s["id"])
    us.chunk_path(d, 1).write_bytes(b"0123456789")
    assert await _status(fr.commit_upload_session(session_id=s["id"], user=env.alice, db=env.db)) == 413
    assert not (env.home / "docs" / "big.bin").exists()


@pytest.mark.asyncio
async def test_copy_checks_quota(env, monkeypatch):
    async def _room(db, user, vpath):
        return 3

    monkeypatch.setattr(file_quota, "room_left", _room)
    assert await _status(fr.move_file(body=MoveRequest(src="my/docs/a.txt", dst="my/docs", copy=True),
                                      user=env.alice, db=env.db)) == 413
    assert not (env.home / "docs" / "a (사본).txt").exists()
    # 이동은 할당과 무관
    await fr.move_file(body=MoveRequest(src="my/docs/a.txt", dst="my", copy=False), user=env.alice, db=env.db)
    assert (env.home / "a.txt").is_file()


# ─── 공유 링크가 항목을 따라간다 ───


async def _get(env, token):
    return await fr.download_shared(token=token, request=Req(), access=None, inline=False, sub=None, db=env.db)


async def _row(env, link_id):
    from sqlalchemy import select
    return (await env.db.execute(
        select(ShareLink).where(ShareLink.id == link_id).execution_options(populate_existing=True)
    )).scalar_one_or_none()


@pytest.mark.asyncio
async def test_link_follows_rename_and_move(env):
    link = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt"), user=env.alice, db=env.db)
    await fr.rename_file(body=RenameRequest(path="my/docs/a.txt", new_name="c.txt"), user=env.alice, db=env.db)
    row = await _row(env, link.id)
    assert row.file_path == "my/docs/c.txt" and row.display_name == "c.txt"
    assert (await _get(env, link.token)).path.endswith("c.txt")
    await fr.move_file(body=MoveRequest(src="my/docs/c.txt", dst="my/docs/sub"), user=env.alice, db=env.db)
    assert (await _row(env, link.id)).file_path == "my/docs/sub/c.txt"
    # 폴더 이름을 바꾸면 그 아래 링크도
    await fr.rename_file(body=RenameRequest(path="my/docs", new_name="문서"), user=env.alice, db=env.db)
    assert (await _row(env, link.id)).file_path == "my/문서/sub/c.txt"
    assert (await _get(env, link.token)).path.endswith("c.txt")


@pytest.mark.asyncio
async def test_old_link_never_opens_new_file_at_same_path(env):
    link = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt"), user=env.alice, db=env.db)
    r = await fr.delete_file(path="my/docs/a.txt", permanent=False, user=env.alice, db=env.db)
    assert await _status(_get(env, link.token)) == 404
    await _upload(env, "a.txt", b"SECRET NEW FILE")          # 같은 자리에 새 파일
    assert await _status(_get(env, link.token)) == 404       # 옛 링크로는 안 열린다
    # 복원하면(자리가 차 있어 "a (1).txt") 링크가 그 파일로 돌아온다
    await fr.restore_from_trash(body=TrashRestoreRequest(trash_name=r["trash_name"]), user=env.alice, db=env.db)
    row = await _row(env, link.id)
    assert row.file_path == "my/docs/a (1).txt"
    resp = await _get(env, link.token)
    assert open(resp.path, "rb").read() == b"hello"


@pytest.mark.asyncio
async def test_permanent_delete_and_trash_purge_drop_links(env):
    l1 = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt"), user=env.alice, db=env.db)
    l2 = await fr.create_share_link(body=ShareLinkCreate(path="my/img.png"), user=env.alice, db=env.db)
    multi = await fr.create_share_link(body=ShareLinkCreate(paths=["my/docs/a.txt", "my/img.png"]),
                                       user=env.alice, db=env.db)
    await fr.delete_file(path="my/docs/a.txt", permanent=True, user=env.alice, db=env.db)
    assert await _row(env, l1.id) is None
    m = await _row(env, multi.id)                         # 묶음은 그 항목만 빠진다
    assert fr._link_paths(m) == ["my/img.png"] and m.file_path == "my/img.png"
    r = await fr.delete_file(path="my/img.png", permanent=False, user=env.alice, db=env.db)
    assert (await _row(env, l2.id)).file_path.startswith("trash/alice/")
    await fr.delete_trash_item(trash_name=r["trash_name"], user=env.alice, db=env.db)
    assert await _row(env, l2.id) is None and await _row(env, multi.id) is None


@pytest.mark.asyncio
async def test_stale_link_at_destination_is_dropped_on_rename(env):
    """수정 전에 지워진 파일의 링크가 남아 있어도, 다른 파일이 그 이름이 되는 순간 정리된다."""
    stale = ShareLink(token="stale-token", file_path="my/docs/old.txt", display_name="old.txt", created_by="alice")
    env.db.add(stale)
    await env.db.commit()
    await fr.rename_file(body=RenameRequest(path="my/docs/a.txt", new_name="old.txt"), user=env.alice, db=env.db)
    assert await _row(env, stale.id) is None


@pytest.mark.asyncio
async def test_team_folder_link_follows_and_others_my_links_untouched(env):
    (env.root / "shared").mkdir()
    (env.root / "shared" / "t.txt").write_text("team")
    (env.root / "users" / "bob" / "docs").mkdir()
    (env.root / "users" / "bob" / "docs" / "a.txt").write_text("bob")
    team = await fr.create_share_link(body=ShareLinkCreate(path="shared/t.txt"), user=env.bob, db=env.db)
    bobs = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt"), user=env.bob, db=env.db)
    await fr.rename_file(body=RenameRequest(path="shared/t.txt", new_name="t2.txt"), user=env.alice, db=env.db)
    assert (await _row(env, team.id)).file_path == "shared/t2.txt"
    # alice 가 자기 my/docs/a.txt 를 바꿔도 bob 의 같은 경로 링크는 그대로
    await fr.rename_file(body=RenameRequest(path="my/docs/a.txt", new_name="z.txt"), user=env.alice, db=env.db)
    assert (await _row(env, bobs.id)).file_path == "my/docs/a.txt"
    # 팀 폴더 → 내 파일로 옮기면 남이 만든 링크는 정리된다(my/ 는 만든 사람 영역으로 풀리므로)
    await fr.move_file(body=MoveRequest(src="shared/t2.txt", dst="my"), user=env.alice, db=env.db)
    assert await _row(env, team.id) is None


# ─── 링크 비밀번호 시도 제한 ───


class _FakeRedis:
    def __init__(self):
        self.kv: dict[str, int] = {}
        self.ttl: dict[str, int] = {}

    async def get(self, k):
        return self.kv.get(k)

    async def incr(self, k):
        self.kv[k] = int(self.kv.get(k, 0)) + 1
        return self.kv[k]

    async def expire(self, k, s):
        self.ttl[k] = s

    async def delete(self, *ks):
        for k in ks:
            self.kv.pop(k, None)


@pytest.fixture()
def redis(monkeypatch):
    r = _FakeRedis()

    async def _get():
        return r

    monkeypatch.setattr(fr, "_unlock_redis", _get)
    # 해시 계산을 빼 테스트를 가볍게(대조 규칙만 본다)
    import app.auth.password as pw
    monkeypatch.setattr(pw, "hash_password", lambda p: "H:" + p)
    monkeypatch.setattr(pw, "verify_password", lambda p, h: h == "H:" + p)
    return r


@pytest.mark.asyncio
async def test_unlock_is_rate_limited(env, redis):
    link = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt", password="pw1234"),
                                      user=env.alice, db=env.db)
    for _ in range(fr.UNLOCK_MAX_FAILS):
        assert await _status(fr.unlock_shared(token=link.token, body=ShareUnlockRequest(password="bad"),
                                              request=Req(), db=env.db)) == 401
    assert list(redis.ttl.values()) == [fr.UNLOCK_WINDOW_S]
    # 한도를 넘으면 맞는 비밀번호도 429(대입 차단)
    assert await _status(fr.unlock_shared(token=link.token, body=ShareUnlockRequest(password="pw1234"),
                                          request=Req(), db=env.db)) == 429
    # 헤더로 보내는 길, 편집기 여는 길도 같은 집계
    assert await _status(fr.download_shared(token=link.token, request=Req({"X-Share-Password": "pw1234"}),
                                            access=None, inline=False, sub=None, db=env.db)) == 429
    from app.wopi import share as wshare
    assert await _status(wshare.open_shared(token=link.token, body=wshare.SharedOpenRequest(password="pw1234"),
                                            request=Req(), db=env.db)) == 429


@pytest.mark.asyncio
async def test_unlock_success_resets_counter_and_ip_is_separate(env, redis):
    link = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt", password="pw1234"),
                                      user=env.alice, db=env.db)
    for _ in range(3):
        await _status(fr.unlock_shared(token=link.token, body=ShareUnlockRequest(password="bad"),
                                       request=Req(), db=env.db))
    r = await fr.unlock_shared(token=link.token, body=ShareUnlockRequest(password="pw1234"), request=Req(), db=env.db)
    assert r["access"] and redis.kv == {}
    # 다른 주소·다른 링크는 따로 센다
    assert fr._unlock_key("t1", None) != fr._unlock_key("t2", None)

    class _R(Req):
        def __init__(self, ip):
            super().__init__()
            self.client = type("C", (), {"host": ip})()

    assert fr._unlock_key("t1", _R("1.1.1.1")) != fr._unlock_key("t1", _R("2.2.2.2"))


@pytest.mark.asyncio
async def test_unlock_without_redis_still_works(env, monkeypatch):
    async def _none():
        return None

    monkeypatch.setattr(fr, "_unlock_redis", _none)
    import app.auth.password as pw
    monkeypatch.setattr(pw, "hash_password", lambda p: "H:" + p)
    monkeypatch.setattr(pw, "verify_password", lambda p, h: h == "H:" + p)
    link = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt", password="pw"), user=env.alice, db=env.db)
    assert await _status(fr.unlock_shared(token=link.token, body=ShareUnlockRequest(password="x"), db=env.db)) == 401
    assert (await fr.unlock_shared(token=link.token, body=ShareUnlockRequest(password="pw"), db=env.db))["access"]


# ─── WOPI ───


@pytest.fixture()
def office(env, monkeypatch):
    from app.wopi import router as wr
    from app.wopi import share as wshare
    (env.home / "docs" / "r.docx").write_bytes(b"PK")

    async def _avail(editor):
        return True

    async def _url(editor, src, token, filename):
        return f"http://office/?src={src}"

    for mod in (wr, wshare):
        monkeypatch.setattr(mod, "_check_editor_available", _avail)
        monkeypatch.setattr(mod, "_build_editor_url", _url)
    monkeypatch.setattr(wr, "_select_editor", lambda name, pref: "onlyoffice")
    return wr, wshare


@pytest.mark.asyncio
async def test_wopi_open_respects_download_limits(env, office):
    _wr, wshare = office
    body = wshare.SharedOpenRequest(name="손님")
    once = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/r.docx", one_time=True), user=env.alice, db=env.db)
    assert (await wshare.open_shared(token=once.token, body=body, db=env.db)).can_edit is False   # 쓰기 전엔 열린다
    await _get(env, once.token)                                                                # 1회 사용
    assert await _status(wshare.open_shared(token=once.token, body=body, db=env.db)) == 410
    # 미리보기 안 되는 형식에 "내려받기 막음"은 이제 만들 때 400 — 예전에 만들어진 링크(직접 갱신)로 확인한다
    nodl = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/r.docx"), user=env.alice, db=env.db)
    (await env.db.get(ShareLink, nodl.id)).allow_download = False
    await env.db.commit()
    assert await _status(wshare.open_shared(token=nodl.token, body=body, db=env.db)) == 403
    # 같이 편집 링크는 그대로 열린다
    edit = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/r.docx", can_edit=True), user=env.alice, db=env.db)
    assert (await wshare.open_shared(token=edit.token, body=body, db=env.db)).can_edit is True


@pytest.mark.asyncio
async def test_revoked_edit_link_guest_cannot_save(env, office):
    from app.wopi.tokens import validate_wopi_token
    wr, wshare = office
    link = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/r.docx", can_edit=True), user=env.alice, db=env.db)
    tok = validate_wopi_token((await wshare.open_shared(token=link.token, body=wshare.SharedOpenRequest(), db=env.db)).token)
    assert tok["link_id"] == link.id and tok["user_id"].startswith("guest-")
    await wr._recheck_share_edit(tok, "my/docs/r.docx", env.db)            # 살아 있는 링크 — 통과
    # 같이 편집을 끄면(직접 갱신) 거부
    row = await env.db.get(ShareLink, link.id)
    row.can_edit = False
    await env.db.commit()
    assert await _status(wr._recheck_share_edit(tok, "my/docs/r.docx", env.db)) == 403
    row.can_edit = True
    await env.db.commit()
    await wr._recheck_share_edit(tok, "my/docs/r.docx", env.db)
    # 회수(삭제)하면 거부
    await fr.delete_share_link(link_id=link.id, user=env.alice, db=env.db)
    assert await _status(wr._recheck_share_edit(tok, "my/docs/r.docx", env.db)) == 403
    # link_id 없는 옛 손님 토큰(배포 전 발급)은 그대로 통과 — 호환
    await wr._recheck_share_edit({"user_id": "guest-1", "owner_id": "alice"}, "my/docs/r.docx", env.db)


@pytest.mark.asyncio
async def test_team_folder_document_shares_one_session(env, office):
    from app.wopi import locks
    from app.wopi.schemas import EditorOpenRequest
    from app.wopi.tokens import create_wopi_token, validate_wopi_token
    wr, _ = office
    (env.root / "shared").mkdir()
    (env.root / "shared" / "회의록.docx").write_bytes(b"PK")
    ra = await wr.open_editor(req=EditorOpenRequest(path="shared/회의록.docx"), user=env.alice, db=env.db)
    rb = await wr.open_editor(req=EditorOpenRequest(path="/shared/회의록.docx"), user=env.bob, db=env.db)
    assert ra.wopi_src == rb.wopi_src                                   # 같은 편집 세션
    ta, tb = validate_wopi_token(ra.token), validate_wopi_token(rb.token)
    fid = ra.wopi_src.rsplit("/", 1)[-1]
    assert wr._check_token_file(ta, fid) == wr._check_token_file(tb, fid) == "shared/회의록.docx"
    assert wr._lock_subject(ta, "shared/회의록.docx") == wr._lock_subject(tb, "shared/회의록.docx") \
        == locks.subject("shared", "shared/회의록.docx")
    # 경로를 풀 사용자는 여전히 각자(shared/ 는 누구로 풀어도 같은 파일)
    assert ta["owner_id"] == "alice" and tb["owner_id"] == "bob"
    # 내 파일은 예전처럼 사용자마다 따로
    m = await wr.open_editor(req=EditorOpenRequest(path="my/docs/r.docx"), user=env.alice, db=env.db)
    assert m.wopi_src.rsplit("/", 1)[-1] == wr._encode_file_id("my/docs/r.docx", "alice")
    # 호환: 배포 전에 받은 토큰(scope 없음)은 옛 file_id·옛 잠금 키로 계속 통과한다
    old = validate_wopi_token(create_wopi_token(user_id="alice", user_name="A", virtual_path="shared/회의록.docx"))
    old_fid = wr._encode_file_id("shared/회의록.docx", "alice")
    assert wr._check_token_file(old, old_fid) == "shared/회의록.docx"
    assert wr._lock_subject(old, "shared/회의록.docx") == locks.subject("alice", "shared/회의록.docx")
    # 새 토큰으로 옛 file_id 를 쓰거나 그 반대는 거부(세션이 섞이지 않는다)
    assert await _status(_call(wr._check_token_file, ta, old_fid)) == 403
    assert await _status(_call(wr._check_token_file, old, fid)) == 403


async def _call(fn, *a):
    return fn(*a)


@pytest.mark.asyncio
async def test_admin_view_of_user_document_joins_owner_session(env, office):
    from app.wopi.schemas import EditorOpenRequest
    from app.wopi.tokens import validate_wopi_token
    wr, _ = office
    env.bob.is_admin = True
    r = await wr.open_editor(req=EditorOpenRequest(path="users/alice/docs/r.docx"), user=env.bob, db=env.db)
    tok = validate_wopi_token(r.token)
    assert tok["file_path"] == "my/docs/r.docx" and tok["owner_id"] == "alice" and tok["user_id"] == "bob"
    assert r.wopi_src.rsplit("/", 1)[-1] == wr._encode_file_id("my/docs/r.docx", "alice")
