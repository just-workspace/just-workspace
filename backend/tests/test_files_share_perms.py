"""파일 공유 권한 4단계("보기 · 댓글 · 편집 · 공동 소유") + 파일 댓글.

라우터 함수를 직접 부른다. 저장소 루트는 임시 폴더, DB 는 SQLite.
alice 가 my/docs(a.txt, sub/b.txt)의 원 소유자이고 bob=보기, carol=댓글, dave=편집, erin=공동 소유, frank=권한 없음.
"""

import io
import os
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

if os.name == "nt" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

from app.db.models import Base, Channel, ChannelMember, FileActivity, FileComment, FileShare, User  # noqa: E402
from app.files import access as acc  # noqa: E402
from app.files import activity as act  # noqa: E402
from app.files import comments as fc  # noqa: E402
from app.files import router as fr  # noqa: E402
from app.files import service as fs  # noqa: E402
from app.files.schemas import MkdirRequest, MoveRequest, RenameRequest, TrashRestoreRequest  # noqa: E402

ROLE_OF = {"bob": "view", "carol": "comment", "dave": "edit", "erin": "owner"}
USERS = ("alice", "bob", "carol", "dave", "erin", "frank")


class Req:
    def __init__(self, headers=None):
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}


@pytest.fixture()
async def env(tmp_path: Path, monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _session():
        return factory()

    monkeypatch.setattr(act, "_session", _session)
    monkeypatch.setattr(fr.settings, "storage_root", str(tmp_path))
    monkeypatch.setattr(fs, "STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(fs, "VERSIONS_ROOT", tmp_path / ".versions")
    fs._dir_cache.clear()

    # 알림은 실제 전송 대신 기록만
    from app.notifications import service as notif
    notes: list[tuple[str, str]] = []

    async def create_notification(db, user_id, type, title, body=None, link=None, **kw):
        notes.append((user_id, link))
        return {"id": str(len(notes))}

    monkeypatch.setattr(notif, "create_notification", create_notification)

    async with factory() as db:
        for uid in USERS:
            db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.title()))
        await db.commit()
        home = tmp_path / "users" / "alice"
        (home / "docs" / "sub").mkdir(parents=True)
        (home / "docs" / "a.txt").write_text("hello")
        (home / "docs" / "sub" / "b.txt").write_text("world")
        for u in USERS[1:]:
            (tmp_path / "users" / u).mkdir(parents=True)
        users = {u: await db.get(User, u) for u in USERS}
        sids = {}
        for who, role in ROLE_OF.items():
            await fr.share_with_users(body=fr.ShareUserCreate(path="my/docs", user_ids=[who], role=role),
                                      user=users["alice"], db=db)
        for row in (await db.execute(select(FileShare))).scalars().all():
            sids[row.shared_with_user_id] = row.id
        yield SimpleNamespace(db=db, u=users, sid=sids, root=tmp_path, home=home, notes=notes)
    await engine.dispose()


def sp(env, who: str, sub: str = "") -> str:
    """who 가 보는 공유 경로."""
    return f"shared-with-me/{env.sid[who]}" + (f"/{sub}" if sub else "")


def upload(name: str, data: bytes = b"new") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(data))


# ─── 권한별 허용·거부 매트릭스 ───


@pytest.mark.asyncio
@pytest.mark.parametrize("who", ["bob", "carol", "dave", "erin"])
async def test_every_role_can_read(env, who):
    u = env.u[who]
    resp = await fr.download_file(request=Req(), path=sp(env, who, "a.txt"), user=u, db=env.db)
    assert Path(resp.path).read_text() == "hello"
    pv = await fr.preview_file(request=Req(), path=sp(env, who, "sub/b.txt"), user=u, db=env.db)
    assert pv["content"].startswith("world")
    listing = await fr.list_files(path=sp(env, who, "sub"), user=u, db=env.db)
    assert [i.name for i in listing.items] == ["b.txt"]
    shared = await fr.list_shared_folder(share_id=env.sid[who], path="", user=u, db=env.db)
    assert shared["role"] == ROLE_OF[who]
    assert shared["can_write"] == (ROLE_OF[who] in ("edit", "owner"))
    items = (await fr.shared_with_me(user=u, db=env.db))["items"]
    assert items[0]["role"] == ROLE_OF[who]
    cm = await fc.list_comments(path=sp(env, who, "a.txt"), user=u, db=env.db)
    assert cm["can_comment"] == (ROLE_OF[who] != "view")


@pytest.mark.asyncio
async def test_stranger_cannot_open_anything(env):
    frank = env.u["frank"]
    for call in (
        lambda: fr.download_file(request=Req(), path=sp(env, "bob", "a.txt"), user=frank, db=env.db),
        lambda: fc.list_comments(path=sp(env, "bob", "a.txt"), user=frank, db=env.db),
        lambda: fr.upload_file(upload("x.txt"), path=sp(env, "dave"), upload_id=None, size=0, mtime=None,
                               x_file_mtime=None, user=frank, db=env.db),
    ):
        with pytest.raises(HTTPException) as e:
            await call()
        assert e.value.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("who,ok", [("bob", False), ("carol", False), ("dave", True), ("erin", True)])
async def test_write_needs_edit(env, who, ok):
    u = env.u[who]
    calls = [
        lambda: fr.upload_file(upload(f"{who}.txt"), path=sp(env, who, "sub"), upload_id=None, size=0, mtime=None,
                               x_file_mtime=None, user=u, db=env.db),
        lambda: fr.upload_file(upload("a.txt", b"overwrite"), path=sp(env, who), upload_id=None, size=0, mtime=None,
                               x_file_mtime=None, user=u, db=env.db),
        lambda: fr.mkdir(body=MkdirRequest(path=sp(env, who, f"new-{who}")), user=u, db=env.db),
    ]
    for call in calls:
        if ok:
            await call()
        else:
            with pytest.raises(HTTPException) as e:
                await call()
            assert e.value.status_code == 403
    if ok:
        # 파일은 원 소유자 영역에 놓이고, 덮어쓴 이전본은 소유자 버전으로 남는다
        assert (env.home / "docs" / "sub" / f"{who}.txt").read_bytes() == b"new"
        assert (env.home / "docs" / "a.txt").read_bytes() == b"overwrite"
        assert (env.home / "docs" / f"new-{who}").is_dir()
        assert fs.version_count("alice", "docs/a.txt") >= 1
        keys = (await env.db.execute(select(FileActivity.path_key, FileActivity.user_id)
                                     .where(FileActivity.action == "upload"))).all()
        assert ("users/alice/docs/sub/" + f"{who}.txt", who) in keys
    else:
        assert (env.home / "docs" / "a.txt").read_text() == "hello"


@pytest.mark.asyncio
@pytest.mark.parametrize("who,ok", [("bob", False), ("carol", False), ("dave", False), ("erin", True)])
async def test_rename_move_delete_need_owner(env, who, ok):
    u = env.u[who]
    calls = [
        lambda: fr.rename_file(body=RenameRequest(path=sp(env, who, "sub/b.txt"), new_name="c.txt"), user=u, db=env.db),
        lambda: fr.move_file(body=MoveRequest(src=sp(env, who, "a.txt"), dst=sp(env, who, "sub")), user=u, db=env.db),
    ]
    for call in calls:
        if ok:
            await call()
        else:
            with pytest.raises(HTTPException) as e:
                await call()
            assert e.value.status_code == 403
    target = "sub/a.txt" if ok else "a.txt"
    if ok:
        r = await fr.delete_file(path=sp(env, who, target), permanent=False, user=u, db=env.db)
        # 원 소유자 휴지통으로, 지운 사람이 남는다
        meta = fr._load_trash_meta("alice")
        assert meta[r["trash_name"]]["original_path"] == "my/docs/sub/a.txt"
        assert meta[r["trash_name"]]["deleted_by"] == who
        assert (env.root / "users" / "alice" / ".trash" / r["trash_name"]).exists()
        assert not (env.root / "users" / who / ".trash" / r["trash_name"]).exists()
        rows = (await env.db.execute(select(FileActivity).where(FileActivity.action == "delete"))).scalars().all()
        assert rows and rows[-1].user_id == who and rows[-1].path_key == "users/alice/docs/sub/a.txt"
        assert (env.home / "docs" / "sub" / "c.txt").exists()
    else:
        with pytest.raises(HTTPException) as e:
            await fr.delete_file(path=sp(env, who, target), permanent=False, user=u, db=env.db)
        assert e.value.status_code == 403
        assert (env.home / "docs" / "a.txt").exists()


@pytest.mark.asyncio
async def test_coowner_cannot_move_out_of_owner_area(env):
    with pytest.raises(HTTPException) as e:
        await fr.move_file(body=MoveRequest(src=sp(env, "erin", "a.txt"), dst="my"), user=env.u["erin"], db=env.db)
    assert e.value.status_code == 400
    # 복사는 보기 권한이면 내 파일로 가져올 수 있다(내려받아 올리는 것과 같다)
    r = await fr.move_file(body=MoveRequest(src=sp(env, "bob", "a.txt"), dst="my", copy=True), user=env.u["bob"], db=env.db)
    assert r["path"] == "my/a.txt" and (env.root / "users" / "bob" / "a.txt").read_text() == "hello"
    # 보기 권한으로 공유 폴더 안에 복사해 넣기는 안 된다
    with pytest.raises(HTTPException) as e:
        await fr.move_file(body=MoveRequest(src="my/a.txt", dst=sp(env, "bob"), copy=True), user=env.u["bob"], db=env.db)
    assert e.value.status_code == 403


@pytest.mark.asyncio
async def test_legacy_rows_keep_meaning(env):
    # 예전 행(role 없음): can_write 로 읽는다
    row = await env.db.get(FileShare, env.sid["dave"])
    row.role = None
    row.can_write = True
    bob_row = await env.db.get(FileShare, env.sid["bob"])
    bob_row.role = None
    bob_row.can_write = False
    await env.db.commit()
    assert acc.share_role(row) == "edit" and acc.share_role(bob_row) == "view"
    await fr.mkdir(body=MkdirRequest(path=sp(env, "dave", "legacy")), user=env.u["dave"], db=env.db)
    with pytest.raises(HTTPException):
        await fr.mkdir(body=MkdirRequest(path=sp(env, "bob", "legacy2")), user=env.u["bob"], db=env.db)
    # 예전 클라이언트(can_write 만 보냄)도 그대로
    await fr.share_with_users(body=fr.ShareUserCreate(path="my/docs", user_ids=["frank"], can_write=True),
                              user=env.u["alice"], db=env.db)
    lst = (await fr.list_user_shares(path="my/docs", user=env.u["alice"], db=env.db))["shares"]
    assert next(s for s in lst if s["user_id"] == "frank")["role"] == "edit"


@pytest.mark.asyncio
async def test_channel_and_direct_take_highest(env):
    env.db.add(Channel(id="dev", name="개발", type="public", created_by="alice"))
    await env.db.commit()
    for uid in ("alice", "bob"):
        env.db.add(ChannelMember(channel_id="dev", user_id=uid))
    await env.db.commit()
    await fr.share_with_users(body=fr.ShareUserCreate(path="my/docs", channel_ids=["dev"], role="edit"),
                              user=env.u["alice"], db=env.db)
    # bob 은 직접(보기) + 채널(편집) → 편집
    await fr.mkdir(body=MkdirRequest(path=sp(env, "bob", "via-channel")), user=env.u["bob"], db=env.db)
    assert (await fr.shared_with_me(user=env.u["bob"], db=env.db))["items"][0]["role"] == "edit"


# ─── 공동 소유 ───


@pytest.mark.asyncio
async def test_coowner_reshare_and_owner_protection(env):
    erin, alice = env.u["erin"], env.u["alice"]
    # 재공유: 원 소유자 영역에 행이 생기고 만든 사람이 남는다
    await fr.share_with_users(body=fr.ShareUserCreate(path=sp(env, "erin"), user_ids=["frank"], role="comment"),
                              user=erin, db=env.db)
    row = (await env.db.execute(select(FileShare).where(FileShare.shared_with_user_id == "frank"))).scalar_one()
    assert row.owner_id == "alice" and row.file_path == "my/docs" and row.created_by == "erin"
    assert acc.share_role(row) == "comment" and row.can_write is False

    lst = await fr.list_user_shares(path=sp(env, "erin"), user=erin, db=env.db)
    assert lst["owner"]["id"] == "alice" and lst["my_role"] == "owner"
    manage = {s["user_id"]: s["can_manage"] for s in lst["shares"]}
    assert manage == {"bob": False, "carol": False, "dave": False, "erin": False, "frank": True}

    # 공동 소유 지정은 원 소유자만
    with pytest.raises(HTTPException) as e:
        await fr.share_with_users(body=fr.ShareUserCreate(path=sp(env, "erin"), user_ids=["frank"], role="owner"),
                                  user=erin, db=env.db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await fr.update_user_share(share_id=row.id, body=fr.ShareUserUpdate(role="owner"), user=erin, db=env.db)
    assert e.value.status_code == 403

    # 원 소유자의 공유는 해제·변경·덮어쓰기 불가
    with pytest.raises(HTTPException) as e:
        await fr.delete_user_share(share_id=env.sid["bob"], user=erin, db=env.db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await fr.update_user_share(share_id=env.sid["bob"], body=fr.ShareUserUpdate(role="edit"), user=erin, db=env.db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await fr.share_with_users(body=fr.ShareUserCreate(path=sp(env, "erin"), user_ids=["bob"], role="edit"),
                                  user=erin, db=env.db)
    assert e.value.status_code == 403
    assert acc.share_role(await env.db.get(FileShare, env.sid["bob"])) == "view"
    # 공동 소유자끼리도 서로의 공동 소유는 못 푼다
    with pytest.raises(HTTPException) as e:
        await fr.delete_user_share(share_id=env.sid["erin"], user=erin, db=env.db)
    assert e.value.status_code == 403

    # 자기가 만든 공유는 바꾸고 해제할 수 있다
    r = await fr.update_user_share(share_id=row.id, body=fr.ShareUserUpdate(role="edit"), user=erin, db=env.db)
    assert r["role"] == "edit" and r["can_write"] is True
    assert (await fr.delete_user_share(share_id=row.id, user=erin, db=env.db))["ok"]

    # 원 소유자는 무엇이든 — 공동 소유 해제 포함
    await fr.update_user_share(share_id=env.sid["erin"], body=fr.ShareUserUpdate(role="view"), user=alice, db=env.db)
    with pytest.raises(HTTPException):
        await fr.rename_file(body=RenameRequest(path=sp(env, "erin", "a.txt"), new_name="z.txt"), user=erin, db=env.db)


@pytest.mark.asyncio
async def test_non_coowner_cannot_manage_shares(env):
    for who in ("bob", "carol", "dave"):
        with pytest.raises(HTTPException) as e:
            await fr.list_user_shares(path=sp(env, who), user=env.u[who], db=env.db)
        assert e.value.status_code == 403
        with pytest.raises(HTTPException) as e:
            await fr.share_with_users(body=fr.ShareUserCreate(path=sp(env, who), user_ids=["frank"]),
                                      user=env.u[who], db=env.db)
        assert e.value.status_code == 403
        with pytest.raises(HTTPException) as e:
            await fr.delete_user_share(share_id=env.sid["bob"], user=env.u[who], db=env.db)
        assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        await fr.share_with_users(body=fr.ShareUserCreate(path="my/docs", user_ids=["bob"], role="admin"),
                                  user=env.u["alice"], db=env.db)
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_rename_by_coowner_keeps_shares_and_comments(env):
    erin = env.u["erin"]
    await fc.create_comment(body=fc.CommentCreate(path=sp(env, "carol", "a.txt"), content="확인 부탁"),
                            user=env.u["carol"], db=env.db)
    # 공유 루트 자체 이름 바꾸기 — 모든 공유·댓글이 따라간다
    r = await fr.rename_file(body=RenameRequest(path=sp(env, "erin"), new_name="문서"), user=erin, db=env.db)
    assert r["path"] == sp(env, "erin")
    paths = {s.file_path for s in (await env.db.execute(select(FileShare))).scalars().all()}
    assert paths == {"my/문서"}
    listing = await fr.list_shared_folder(share_id=env.sid["bob"], path="", user=env.u["bob"], db=env.db)
    assert {i.name for i in listing["items"]} == {"a.txt", "sub"}
    cm = await fc.list_comments(path="my/문서/a.txt", user=env.u["alice"], db=env.db)
    assert [c["content"] for c in cm["items"]] == ["확인 부탁"]
    # 원 소유자의 이동도 따라간다
    (env.home / "box").mkdir()
    await fr.move_file(body=MoveRequest(src="my/문서", dst="my/box"), user=env.u["alice"], db=env.db)
    assert {s.file_path for s in (await env.db.execute(select(FileShare))).scalars().all()} == {"my/box/문서"}
    cm = await fc.list_comments(path=sp(env, "bob", "a.txt"), user=env.u["bob"], db=env.db)
    assert len(cm["items"]) == 1


@pytest.mark.asyncio
async def test_trash_parks_comments_and_restore_brings_back(env):
    alice = env.u["alice"]
    await fc.create_comment(body=fc.CommentCreate(path="my/docs/a.txt", content="원본 메모"), user=alice, db=env.db)
    r = await fr.delete_file(path="my/docs/a.txt", permanent=False, user=alice, db=env.db)
    left = (await env.db.execute(select(FileComment))).scalars().all()
    assert [c.file_path for c in left] == [acc.trash_key(r["trash_name"])]
    # 같은 이름으로 새 파일을 올려도 옛 댓글이 붙지 않는다
    await fr.upload_file(upload("a.txt"), path="my/docs", upload_id=None, size=0, mtime=None, x_file_mtime=None,
                         user=alice, db=env.db)
    assert (await fc.list_comments(path="my/docs/a.txt", user=alice, db=env.db))["items"] == []
    res = await fr.restore_from_trash(body=TrashRestoreRequest(trash_name=r["trash_name"]), user=alice, db=env.db)
    assert res["ok"]
    restored = [c.file_path for c in (await env.db.execute(select(FileComment))).scalars().all()]
    assert restored == ["my/docs/a (1).txt"]
    # 공유 폴더 통째 휴지통 → 받은 사람 목록에서 사라지고, 휴지통 비우면 공유·댓글도 정리
    await fr.delete_file(path="my/docs", permanent=False, user=alice, db=env.db)
    assert (await fr.shared_with_me(user=env.u["bob"], db=env.db))["items"] == []
    await fr.empty_trash(user=alice, db=env.db)
    assert (await env.db.execute(select(FileShare))).scalars().all() == []
    assert (await env.db.execute(select(FileComment))).scalars().all() == []


# ─── 댓글 ───


@pytest.mark.asyncio
async def test_comment_permissions_and_mentions(env):
    # 보기 권한은 읽기만
    with pytest.raises(HTTPException) as e:
        await fc.create_comment(body=fc.CommentCreate(path=sp(env, "bob", "a.txt"), content="안녕"),
                                user=env.u["bob"], db=env.db)
    assert e.value.status_code == 403
    # 댓글 권한: 쓰기 + 멘션(파일을 볼 수 있는 bob 에게만 알림 — frank 는 권한 없음)
    c = await fc.create_comment(body=fc.CommentCreate(path=sp(env, "carol", "a.txt"), content="@bob @frank @alice 봐 주세요"),
                                user=env.u["carol"], db=env.db)
    assert {m["id"] for m in c["mentions"]} == {"bob", "frank", "alice"}
    assert c["notified"] == 2
    assert dict(env.notes) == {"bob": "/files?view=shared-with-me", "alice": "/files?path=my/docs"}
    # 소유자 경로·공유 경로 어디서 봐도 같은 댓글
    for who, path in (("alice", "my/docs/a.txt"), ("bob", sp(env, "bob", "a.txt")), ("erin", sp(env, "erin", "a.txt"))):
        items = (await fc.list_comments(path=path, user=env.u[who], db=env.db))["items"]
        assert [i["id"] for i in items] == [c["id"]]
        assert items[0]["is_mine"] is False
    # 편집·공동 소유·소유자도 쓸 수 있다
    for who, path in (("dave", sp(env, "dave", "a.txt")), ("erin", sp(env, "erin", "a.txt")), ("alice", "my/docs/a.txt")):
        await fc.create_comment(body=fc.CommentCreate(path=path, content=f"{who} 의견"), user=env.u[who], db=env.db)
    # 수정·삭제는 쓴 사람만(원 소유자도 남의 댓글은 못 고친다)
    for who in ("alice", "erin", "bob"):
        with pytest.raises(HTTPException) as e:
            await fc.update_comment(comment_id=c["id"], body=fc.CommentUpdate(content="x"), user=env.u[who], db=env.db)
        assert e.value.status_code == 403
        with pytest.raises(HTTPException):
            await fc.delete_comment(comment_id=c["id"], user=env.u[who], db=env.db)
    with pytest.raises(HTTPException) as e:
        await fc.update_comment(comment_id=c["id"], body=fc.CommentUpdate(content="x"), user=env.u["frank"], db=env.db)
    assert e.value.status_code == 404
    u = await fc.update_comment(comment_id=c["id"], body=fc.CommentUpdate(content="고침"), user=env.u["carol"], db=env.db)
    assert u["content"] == "고침" and u["is_edited"] is True
    # 보기로 내려가면 자기 댓글도 못 고친다
    await fr.update_user_share(share_id=env.sid["carol"], body=fr.ShareUserUpdate(role="view"),
                               user=env.u["alice"], db=env.db)
    with pytest.raises(HTTPException) as e:
        await fc.delete_comment(comment_id=c["id"], user=env.u["carol"], db=env.db)
    assert e.value.status_code == 403
    await fr.update_user_share(share_id=env.sid["carol"], body=fr.ShareUserUpdate(role="comment"),
                               user=env.u["alice"], db=env.db)
    assert (await fc.delete_comment(comment_id=c["id"], user=env.u["carol"], db=env.db))["ok"]


@pytest.mark.asyncio
async def test_comments_reject_team_folder(env):
    with pytest.raises(HTTPException) as e:
        await fc.list_comments(path="shared/x.txt", user=env.u["alice"], db=env.db)
    assert e.value.status_code == 400


# ─── 오피스(WOPI) ───


@pytest.mark.asyncio
@pytest.mark.parametrize("who,perm", [("bob", "view"), ("carol", "view"), ("dave", "edit"), ("erin", "edit")])
async def test_office_open_follows_role(env, monkeypatch, who, perm):
    from app.wopi import router as wr
    from app.wopi.schemas import EditorOpenRequest
    from app.wopi.tokens import validate_wopi_token
    (env.home / "docs" / "r.docx").write_bytes(b"PK")

    async def _avail(editor):
        return True

    async def _url(editor, src, token, filename):
        return f"http://office/?src={src}"

    monkeypatch.setattr(wr, "_check_editor_available", _avail)
    monkeypatch.setattr(wr, "_build_editor_url", _url)
    monkeypatch.setattr(wr, "_select_editor", lambda name, pref: "onlyoffice")
    r = await wr.open_editor(req=EditorOpenRequest(path=sp(env, who, "r.docx")), user=env.u[who], db=env.db)
    data = validate_wopi_token(r.token)
    assert data["permissions"] == perm
    assert data["file_path"] == "my/docs/r.docx" and data["owner_id"] == "alice" and data["user_id"] == who


@pytest.mark.asyncio
async def test_office_save_rechecks_share(env):
    from app.wopi import router as wr
    tok = {"user_id": "dave", "owner_id": "alice", "permissions": "edit", "file_path": "my/docs/a.txt"}
    await wr._recheck_share_edit(tok, "my/docs/a.txt", env.db)          # 편집 권한 — 통과
    await fr.update_user_share(share_id=env.sid["dave"], body=fr.ShareUserUpdate(role="comment"),
                               user=env.u["alice"], db=env.db)
    with pytest.raises(HTTPException) as e:                               # 내려간 뒤 저장 거부
        await wr._recheck_share_edit(tok, "my/docs/a.txt", env.db)
    assert e.value.status_code == 403
    # 소유자 본인·공유 링크 손님 토큰은 해당 없음
    await wr._recheck_share_edit({"user_id": "alice", "owner_id": "alice"}, "my/docs/a.txt", env.db)
    await wr._recheck_share_edit({"user_id": "guest-1", "owner_id": "alice"}, "my/docs/a.txt", env.db)


@pytest.mark.asyncio
async def test_upload_onto_file_target_is_400(env):
    with pytest.raises(HTTPException) as e:
        await fr.upload_file(upload("x.txt"), path=sp(env, "dave", "a.txt"), upload_id=None, size=0, mtime=None,
                             x_file_mtime=None, user=env.u["dave"], db=env.db)
    assert e.value.status_code == 400


# ─── 답글 · 위치 조각 · 해결 · 멘션 후보 · 권한 요청 ───


@pytest.mark.asyncio
async def test_comment_reply_anchor_resolve(env):
    carol, dave, bob = env.u["carol"], env.u["dave"], env.u["bob"]
    top = await fc.create_comment(body=fc.CommentCreate(path=sp(env, "carol", "a.txt"), content="합계 확인", anchor=" 시트 3 · D14 "),
                                  user=carol, db=env.db)
    assert top["anchor"] == "시트 3 · D14" and top["parent_id"] is None and top["resolved"] is False
    r1 = await fc.create_comment(body=fc.CommentCreate(path=sp(env, "dave", "a.txt"), content="고쳤어요", parent_id=top["id"]),
                                 user=dave, db=env.db)
    # 답글의 답글은 최상위에 붙는다
    r2 = await fc.create_comment(body=fc.CommentCreate(path="my/docs/a.txt", content="고마워요", parent_id=r1["id"]),
                                 user=env.u["alice"], db=env.db)
    assert r1["parent_id"] == top["id"] and r2["parent_id"] == top["id"]
    # 다른 파일의 댓글에는 답글을 못 단다
    other = await fc.create_comment(body=fc.CommentCreate(path=sp(env, "carol", "sub/b.txt"), content="다른 파일"), user=carol, db=env.db)
    with pytest.raises(HTTPException) as e:
        await fc.create_comment(body=fc.CommentCreate(path=sp(env, "carol", "a.txt"), content="x", parent_id=other["id"]),
                                user=carol, db=env.db)
    assert e.value.status_code == 404

    # 해결: 댓글 권한 이상 누구나(쓴 사람이 아니어도) · 보기 권한은 403 · 답글은 400
    with pytest.raises(HTTPException) as e:
        await fc.resolve_comment(comment_id=top["id"], body=fc.CommentResolve(resolved=True), user=bob, db=env.db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await fc.resolve_comment(comment_id=r1["id"], body=fc.CommentResolve(resolved=True), user=dave, db=env.db)
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        await fc.resolve_comment(comment_id=top["id"], body=fc.CommentResolve(resolved=True), user=env.u["frank"], db=env.db)
    assert e.value.status_code == 404
    res = await fc.resolve_comment(comment_id=top["id"], body=fc.CommentResolve(resolved=True), user=dave, db=env.db)
    assert res["resolved"] is True and res["resolved_by"]["id"] == "dave"
    listed = await fc.list_comments(path=sp(env, "bob", "a.txt"), user=bob, db=env.db)
    by = {i["id"]: i for i in listed["items"]}
    assert by[top["id"]]["resolved"] and by[top["id"]]["resolved_by"]["display_name"] == "Dave"
    assert listed["owner"] == {"id": "alice", "display_name": "Alice"} and listed["is_original_owner"] is False
    res = await fc.resolve_comment(comment_id=top["id"], body=fc.CommentResolve(resolved=False), user=carol, db=env.db)
    assert res["resolved"] is False and res["resolved_by"] is None

    # 최상위를 지우면 답글도 지운다
    await fc.delete_comment(comment_id=top["id"], user=carol, db=env.db)
    left = (await fc.list_comments(path="my/docs/a.txt", user=env.u["alice"], db=env.db))["items"]
    assert left == []


@pytest.mark.asyncio
async def test_mentionable_marks_who_can_view(env):
    res = await fc.mentionable_people(path=sp(env, "carol", "a.txt"), q="", limit=20, user=env.u["carol"], db=env.db)
    by = {i["id"]: i["role"] for i in res["items"]}
    assert "carol" not in by                       # 나 제외
    assert by["alice"] == "owner" and by["bob"] == "view" and by["frank"] is None
    assert res["items"][-1]["id"] == "frank"       # 볼 수 없는 사람은 뒤로
    res = await fc.mentionable_people(path=sp(env, "carol", "a.txt"), q="@da", limit=8, user=env.u["carol"], db=env.db)
    assert [i["id"] for i in res["items"]] == ["dave"]
    # 보기 권한은 댓글을 못 쓰니 후보도 못 받는다
    with pytest.raises(HTTPException) as e:
        await fc.mentionable_people(path=sp(env, "bob", "a.txt"), q="", limit=8, user=env.u["bob"], db=env.db)
    assert e.value.status_code == 403


@pytest.mark.asyncio
async def test_access_request_notifies_original_owner(env):
    env.notes.clear()
    r = await fc.request_access(body=fc.AccessRequest(path=sp(env, "bob", "a.txt"), role="comment", message="3번 시트 의견"),
                                user=env.u["bob"], db=env.db)
    assert r == {"ok": True, "notified": 1}
    assert env.notes == [("alice", "/files?path=my/docs")]
    # 이미 그 권한이 있으면 400, 내 파일은 400, 모르는 권한 400, 권한 없는 사람은 404
    for body, who, code in (
        (fc.AccessRequest(path=sp(env, "carol", "a.txt"), role="comment"), "carol", 400),
        (fc.AccessRequest(path="my/docs/a.txt", role="edit"), "alice", 400),
        (fc.AccessRequest(path=sp(env, "bob", "a.txt"), role="owner"), "bob", 400),
        (fc.AccessRequest(path=sp(env, "bob", "a.txt"), role="edit"), "frank", 404),
    ):
        with pytest.raises(HTTPException) as e:
            await fc.request_access(body=body, user=env.u[who], db=env.db)
        assert e.value.status_code == code
    # 공유는 바뀌지 않는다
    assert (await fc.list_comments(path=sp(env, "bob", "a.txt"), user=env.u["bob"], db=env.db))["can_comment"] is False


@pytest.mark.asyncio
async def test_shared_with_me_has_received_date(env):
    items = (await fr.shared_with_me(user=env.u["carol"], db=env.db))["items"]
    assert items and items[0]["shared_at"] and items[0]["shared_at"].endswith("+00:00")
